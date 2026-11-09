import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { Mailbox, localTransport, pollMailbox } from "../src/remote/mailbox.js";
import { PrivateStore } from "../src/remote/store.js";
import { RemoteClient, registerRemoteWriteTools } from "../src/remote/client.js";
import { serveMailboxStdin, sshTransport } from "../src/remote/transport.js";
import { boundedJson, digest, makeRequest, MAX_WIRE_BYTES, parseWire, seal, verifyRequest, type SignedRequest } from "../src/remote/protocol.js";
import { registerWriteTools } from "../src/tools/write.js";
import { loadRuntimePolicy } from "../src/services/policy.js";
import { fixture, FLIGHT, type Fixture } from "./remote-fixture.js";
const fixtures: Fixture[] = [];
const setup = () => {
  const f = fixture(); fixtures.push(f); const store = f.storeAt("mailbox");
  const options = { store, callers: f.callers, macReceiptKey: f.mac.publicKey, now: () => f.now };
  const mailbox = new Mailbox(options);
  return { f, store, options, mailbox, caller: localTransport(mailbox, { role: "caller", caller: "linux" }), mac: localTransport(mailbox, { role: "mac" }) };
};
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
const add = { kind: "add", flight_code: "UA194", date: "2027-01-01" } as const;
const wire = (value: unknown) => boundedJson(value);

describe("fixed signed request protocol", () => {
  it("binds canonical exact payload digest and rejects signature tampering", () => {
    const { f } = setup(), req = f.request(add);
    expect(verifyRequest(req, f.callers, f.now)).toEqual(req.body);
    expect(digest({ a: 1, b: 2 })).toBe(digest({ b: 2, a: 1 }));
    expect(() => verifyRequest({ ...req, body: { ...req.body, operation: { ...add, date: "2027-02-01" } } }, f.callers, f.now)).toThrow();
    expect(() => verifyRequest(seal("request", { ...req.body, payloadDigest: digest({ ...add, date: "2027-02-01" }) }, f.caller.privateKey), f.callers, f.now)).toThrow();
    expect(() => verifyRequest(seal("request", req.body, f.other.privateKey), f.callers, f.now)).toThrow();
  });
  it.each([
    { kind: "shell", command: "echo secret" }, { kind: "request-snapshot", path: "/tmp/escape" },
    { kind: "add", flight_code: "UA194", date: "2027-02-30" }, { kind: "remove-preview", flight_id: "not-uuid" },
    { kind: "follow", flight_code: "UA194\u0000", date: "2027-01-01" }, { kind: "add", flight_code: "INVALID", date: "2027-01-01" },
  ])("rejects invalid/nonnarrow input: %j", operation => {
    const { f } = setup(); expect(() => f.request(operation as any)).toThrow();
  });
  it("rejects wrong account, unauthorized capability, long/future/expired envelopes and unknown fields", async () => {
    const { f } = setup(), req = f.request(add);
    for (const change of [{ account: "other" }, { issuedAt: f.now + 1 }, { expiresAt: f.now + 300_001 }, { expiresAt: f.now }, { path: "/tmp/x" }]) {
      const changed = seal("request", { ...req.body, ...change }, f.caller.privateKey);
      await expect(f.executor.submit(changed)).rejects.toThrow();
    }
    (f.callers.linux as { capabilities: string[] }).capabilities = ["remove-preview"];
    await expect(f.executor.submit(req)).rejects.toThrow(); expect(f.api.searchFlight).not.toHaveBeenCalled();
  });
  it("bounds bytes, nesting and unexpected values", () => {
    expect(() => parseWire(" ".repeat(MAX_WIRE_BYTES + 1))).toThrow();
    expect(() => boundedJson({ value: "x".repeat(MAX_WIRE_BYTES) })).toThrow();
    expect(() => digest({ bad: undefined })).toThrow();
    let deep: unknown = 1; for (let i = 0; i < 40; i++) deep = [deep]; expect(() => digest(deep)).toThrow();
  });
});

describe("durable Linux mailbox", () => {
  it("transports one-step add with authenticated receipt, restart and duplicate receipts", async () => {
    const { f, options, mailbox, caller, mac, store } = setup(); const req = f.request(add);
    expect(parseWire(await caller(wire({ verb: "submit", request: req })))).toEqual({ queue: "queued", receipt: null });
    expect(await pollMailbox(mac, f.executor)).toBe(1);
    const status = parseWire(await caller(wire({ verb: "status", request: req }))) as any;
    expect(status.queue).toBe("receipted"); expect(status.receipt.body.state).toBe("succeeded");
    expect(parseWire(await mac(wire({ verb: "receipt", receipt: status.receipt })))).toEqual({ accepted: true });
    store.close(); const reopened = f.storeAt("mailbox"), restarted = new Mailbox({ ...options, store: reopened });
    expect(parseWire(restarted.handle({ role: "caller", caller: "linux" }, wire({ verb: "submit", request: req })))).toEqual(status);
    expect(f.api.subscribeFlight).toHaveBeenCalledTimes(1);
  });
  it("preserves submission and lease state at both restart boundaries", async () => {
    const { f, store, options, caller } = setup(), req = f.request(add);
    await caller(wire({ verb: "submit", request: req })); store.close();
    const afterSubmit = f.storeAt("mailbox"), box = new Mailbox({ ...options, store: afterSubmit });
    expect((parseWire(box.handle({ role: "mac" }, wire({ verb: "lease", limit: 1 }))) as any).requests).toEqual([req]);
    afterSubmit.close(); const afterLease = new Mailbox({ ...options, store: f.storeAt("mailbox") });
    expect(parseWire(afterLease.handle({ role: "mac" }, wire({ verb: "lease", limit: 1 })))).toEqual({ requests: [] });
    f.now += 30_001;
    expect((parseWire(afterLease.handle({ role: "mac" }, wire({ verb: "lease", limit: 1 }))) as any).requests).toEqual([req]);
  });
  it("requires authenticated principal to match signed caller; role cannot come from JSON", async () => {
    const { f, mailbox, caller } = setup(), req = f.request(add);
    expect(() => mailbox.handle({ role: "caller", caller: "other" }, wire({ verb: "submit", request: req }))).toThrow(/mismatch/);
    await expect(caller(wire({ verb: "lease", limit: 1 }))).rejects.toThrow(/role/);
    await expect(caller(wire({ verb: "submit", request: req, role: "mac" }))).rejects.toThrow();
    await expect(caller(wire({ verb: "submit", request: { ...req, caller: "other" } }))).rejects.toThrow();
  });
  it("rejects conflicting ID reuse and forged or cross-operation Mac receipts", async () => {
    const { f, caller, mac } = setup(), req = f.request(add), second = f.request(add);
    await caller(wire({ verb: "submit", request: req })); await caller(wire({ verb: "submit", request: second }));
    await expect(caller(wire({ verb: "submit", request: f.request({ ...add, date: "2027-01-02" }, { operationId: req.body.operationId }) }))).rejects.toThrow(/Conflicting/);
    const receipt = await f.executor.submit(req);
    await expect(mac(wire({ verb: "receipt", receipt: seal("receipt", receipt.body, f.caller.privateKey) }))).rejects.toThrow(/signature/);
    await expect(mac(wire({ verb: "receipt", receipt: seal("receipt", { ...receipt.body, operationId: second.body.operationId }, f.mac.privateKey) }))).rejects.toThrow(/binding/);
    await mac(wire({ verb: "receipt", receipt }));
    await expect(mac(wire({ verb: "receipt", receipt: seal("receipt", { ...receipt.body, state: "unknown" }, f.mac.privateKey) }))).rejects.toThrow(/Conflicting/);
  });
  it("dropped lease/receipt responses resend the same request without duplicate dispatch", async () => {
    const { f, caller, mac } = setup(), req = f.request(add);
    await caller(wire({ verb: "submit", request: req }));
    await mac(wire({ verb: "lease", limit: 1 })); // Lost lease response.
    expect(await pollMailbox(mac, f.executor)).toBe(0); f.now += 30_001;
    const dropReceiptReply = async (command: string) => { const result = await mac(command); if ((parseWire(command) as any).verb === "receipt") throw new Error("lost ack"); return result; };
    await expect(pollMailbox(dropReceiptReply, f.executor)).rejects.toThrow("lost ack");
    f.now += 30_001; expect(await pollMailbox(mac, f.executor)).toBe(0);
    expect(f.api.subscribeFlight).toHaveBeenCalledTimes(1);
    expect((parseWire(await caller(wire({ verb: "status", request: req }))) as any).receipt.body.state).toBe("succeeded");
  });
  it("lost Mac response after dispatch re-leases to stored unknown, never sends mutation again", async () => {
    const { f, caller, mac } = setup(), req = f.request(add);
    await caller(wire({ verb: "submit", request: req }));
    f.deps.boundary = name => { if (name === "response") throw new Error("disconnect"); };
    await expect(pollMailbox(mac, f.executor)).rejects.toThrow("disconnect");
    f.deps.boundary = undefined; f.restart(); f.now += 30_001;
    expect(await pollMailbox(mac, f.executor)).toBe(1);
    expect(f.api.subscribeFlight).toHaveBeenCalledTimes(1);
    expect((parseWire(await caller(wire({ verb: "status", request: req }))) as any).receipt.body.state).toBe("unknown");
  });
  it("does not lease expired queued requests after sleep/restart or revoked capabilities", async () => {
    const { f, options, store, caller } = setup(), req = f.request(add);
    await caller(wire({ verb: "submit", request: req })); f.now += 300_001;
    store.close(); const restarted = new Mailbox({ ...options, store: f.storeAt("mailbox") });
    expect(parseWire(restarted.handle({ role: "mac" }, wire({ verb: "lease", limit: 16 })))).toEqual({ requests: [] });
    expect((parseWire(restarted.handle({ role: "caller", caller: "linux" }, wire({ verb: "status", request: req }))) as any).queue).toBe("expired");
    expect(f.api.searchFlight).not.toHaveBeenCalled();
    await expect(localTransport(restarted, { role: "caller", caller: "linux" })(wire({ verb: "submit", request: f.request(add, { expiresAt: f.now }) }))).rejects.toThrow();
  });
  it("bounds queue capacity and retention without permitting replay after pruning", async () => {
    const { f } = setup(); const store = f.storeAt("small", 2), mailbox = new Mailbox({ store, callers: f.callers, macReceiptKey: f.mac.publicKey, now: () => f.now });
    const req = f.request(add); mailbox.handle({ role: "caller", caller: "linux" }, wire({ verb: "submit", request: req }));
    mailbox.handle({ role: "caller", caller: "linux" }, wire({ verb: "submit", request: f.request(add) }));
    expect(() => mailbox.handle({ role: "caller", caller: "linux" }, wire({ verb: "submit", request: f.request(add) }))).toThrow(/capacity/);
    f.now += 86_400_001 + 300_000;
    mailbox.handle({ role: "mac" }, wire({ verb: "lease", limit: 1 })); expect(store.list("mail")).toHaveLength(0);
    expect(() => mailbox.handle({ role: "caller", caller: "linux" }, wire({ verb: "submit", request: req }))).toThrow(/expiry/);
  });
});

describe("private state and staged transport adapters", () => {
  it("enforces private directory/file permissions and one live process writer", () => {
    const { f } = setup(); expect(lstatSync(f.dir + "/mac.sqlite").mode & 0o777).toBe(0o600);
    expect(() => new PrivateStore({ path: f.dir + "/mac.sqlite", checkLocation: () => {} })).toThrow(/live writer/);
    const publicDir = f.dir + "/public"; mkdirSync(publicDir, { mode: 0o755 }); chmodSync(publicDir, 0o755);
    expect(() => new PrivateStore({ path: publicDir + "/state.sqlite", checkLocation: () => {} })).toThrow(/private/);
    symlinkSync(f.dir + "/mac.sqlite", f.dir + "/linked.sqlite");
    expect(() => new PrivateStore({ path: f.dir + "/linked.sqlite", checkLocation: () => {} })).toThrow();
    expect(() => new PrivateStore({ path: f.dir + "/unmounted.sqlite", checkLocation: () => { throw new Error("unmounted"); } })).toThrow("unmounted");
  });
  it("recovers a committed database after its writer process exits without releasing ownership", () => {
    const { f } = setup(), path = f.dir + "/crashed-writer.sqlite";
    const code = `import { PrivateStore } from './build/remote/store.js';
      const store = new PrivateStore({path:${JSON.stringify(path)},checkLocation:()=>{}});
      store.put('fixture','boundary',{state:'committed-before-process-exit'});
      process.exit(0);`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 5000 });
    expect(child.status).toBe(0);
    const reopened = f.storeAt("crashed-writer");
    expect(reopened.get("fixture", "boundary")).toEqual({ state: "committed-before-process-exit" });
  });
  it("serves exactly the fixed bounded stdin protocol with no raw error disclosure", async () => {
    const { f, mailbox } = setup(); let output = "";
    const sink = () => new Writable({ write(chunk, _encoding, callback) { output += chunk; callback(); } });
    await serveMailboxStdin(Readable.from([wire({ verb: "submit", request: f.request(add) })]), sink(), mailbox, { role: "caller", caller: "linux" });
    expect((parseWire(output) as any).queue).toBe("queued"); output = "";
    await serveMailboxStdin(Readable.from(["SYNTHETIC-LOGIN-SECRET"]), sink(), mailbox, { role: "mac" });
    expect(output).toBe('{"error":"Mailbox request rejected."}\n'); output = "";
    await serveMailboxStdin(Readable.from(["x".repeat(MAX_WIRE_BYTES + 1)]), sink(), mailbox, { role: "mac" });
    expect(output).toContain("request rejected");
    expect(f.api.subscribeFlight).not.toHaveBeenCalled();
  });
  it("uses shell-free SSH with a pinned host channel, dedicated key and fixed remote command", async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() });
    const spawn = vi.fn(() => {
      child.stdin.on("finish", () => { child.stdout.write('{"requests":[]}'); child.emit("close", 0); });
      return child;
    });
    const checkConfiguration = vi.fn();
    const transport = sshTransport({ enabled: true, host: "synthetic.invalid", port: 2222, user: "flighty_mail",
      identityFile: "/synthetic/service-key", knownHostsFile: "/synthetic/pinned-hosts", checkConfiguration }, spawn as any);
    expect(await transport(wire({ verb: "lease", limit: 1 }))).toBe('{"requests":[]}');
    const [file, args, options] = spawn.mock.calls[0] as any;
    expect(file).toBe("/usr/bin/ssh"); expect(options.shell).toBe(false);
    expect(args).toContain("StrictHostKeyChecking=yes"); expect(args).toContain("IdentityAgent=none");
    expect(args).toContain("UserKnownHostsFile=/synthetic/pinned-hosts"); expect(args).toContain("/synthetic/service-key");
    expect(args.slice(-2)).toEqual(["flighty_mail@synthetic.invalid", "flighty-mailbox-v1"]);
    expect(checkConfiguration).toHaveBeenCalledTimes(1);
  });
  it("bounds a stalled synthetic SSH process and redacts its error stream", async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() });
      const transport = sshTransport({ enabled: true, host: "synthetic.invalid", port: 2222, user: "flighty_mail", identityFile: "/synthetic/key", knownHostsFile: "/synthetic/hosts", checkConfiguration: () => {} }, (() => child) as any);
      const pending = transport(wire({ verb: "lease", limit: 1 }));
      const assertion = expect(pending).rejects.toThrow(/inspect operation status/);
      child.stderr.write("SYNTHETIC-LOGIN-SECRET"); await vi.advanceTimersByTimeAsync(20_001); await assertion;
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } finally { vi.useRealTimers(); }
  });
  it("rejects SSH config injection and requires explicit activation; construction spawns nothing", () => {
    const config = { enabled: true as const, host: "synthetic.invalid", port: 2222, user: "flighty_mail", identityFile: "/synthetic/id", knownHostsFile: "/synthetic/hosts", checkConfiguration: vi.fn() };
    expect(typeof sshTransport(config)).toBe("function"); expect(config.checkConfiguration).not.toHaveBeenCalled();
    for (const change of [{ enabled: false }, { host: "-oProxyCommand=bad" }, { user: "x;echo bad" }, { identityFile: "relative" }, { port: 0 }]) expect(() => sshTransport({ ...config, ...change } as any)).toThrow();
  });
});

describe("remote client and public registration", () => {
  it("keeps request ID through transport failure and verifies the pinned Mac receipt", async () => {
    const { f, caller, mac } = setup();
    const client = new RemoteClient({ caller: "linux", account: "synthetic-account", signingKey: f.caller.privateKey, macReceiptKey: f.mac.publicKey, transport: caller, now: () => f.now });
    const req = client.prepare(add); expect((await client.submit(req)).queue).toBe("queued");
    await pollMailbox(mac, f.executor); const result = await client.status(req); expect(result.receipt!.body.state).toBe("succeeded");
    const forged = new RemoteClient({ caller: "linux", account: "synthetic-account", signingKey: f.caller.privateKey, macReceiptKey: f.other.publicKey, transport: caller, now: () => f.now });
    await expect(forged.status(req)).rejects.toThrow(/signature/);
  });
  it("preserves tool names/descriptions/schema/annotations exactly and uses no private SDK handlers", async () => {
    const { f, caller, mac } = setup(); const local = new Map(), remote = new Map();
    registerWriteTools({ registerTool: (name: string, config: unknown, fn: unknown) => local.set(name, { config, fn }) } as any, f.db, f.api);
    const client = new RemoteClient({ caller: "linux", account: "synthetic-account", signingKey: f.caller.privateKey, macReceiptKey: f.mac.publicKey, transport: caller, now: () => f.now });
    const rememberRequest = vi.fn(async (_req: SignedRequest) => {});
    registerRemoteWriteTools({ registerTool: (name: string, config: unknown, fn: unknown) => remote.set(name, { config, fn }) } as any,
      { client, rememberRequest, policy: loadRuntimePolicy({}), macReceiptKey: f.mac.publicKey,
        waitForReceipt: async req => { await pollMailbox(mac, f.executor); return (await client.status(req)).receipt; } });
    expect([...local.keys()]).toEqual([...remote.keys()]);
    for (const [name, item] of remote) {
      const expected = local.get(name).config;
      expect(item.config.description).toBe(expected.description);
      expect(item.config.title).toBe(expected.title);
      expect(item.config.annotations).toEqual(expected.annotations);
      expect(Object.keys(item.config.inputSchema)).toEqual(Object.keys(expected.inputSchema));
      for (const key of Object.keys(item.config.inputSchema)) {
        const actualSchema = item.config.inputSchema[key], expectedSchema = expected.inputSchema[key];
        expect(actualSchema.description).toBe(expectedSchema.description);
        for (const value of [undefined, "", "UA194", "2027-01-01", FLIGHT, "SYNTHETIC", "x".repeat(40)]) {
          expect(actualSchema.safeParse(value).success).toBe(expectedSchema.safeParse(value).success);
        }
      }
    }
    const added = await remote.get("flighty_add_flight").fn({ flight_code: "UA194", date: "2027-01-01" });
    expect(added.isError).toBeUndefined(); expect(JSON.parse(added.content[0].text).status).toBe("added"); expect(rememberRequest).toHaveBeenCalledTimes(1);
    const p = await remote.get("flighty_remove_flight").fn({ flight_id: FLIGHT }); const code = JSON.parse(p.content[0].text).confirm_code;
    const removed = await remote.get("flighty_remove_flight").fn({ flight_id: FLIGHT, confirm_code: code });
    expect(JSON.parse(removed.content[0].text).status).toBe("removed"); expect(f.api.deleteFlight).toHaveBeenCalledTimes(1);
  });
  it("does not invent success or auto retry when mailbox is unavailable", async () => {
    const { f } = setup(); const remote = new Map(); const transport = vi.fn(async () => { throw new Error("secret transport error"); });
    const client = new RemoteClient({ caller: "linux", account: "synthetic-account", signingKey: f.caller.privateKey, macReceiptKey: f.mac.publicKey, transport, now: () => f.now });
    const remembered: SignedRequest[] = [];
    registerRemoteWriteTools({ registerTool: (name: string, _config: unknown, fn: unknown) => remote.set(name, fn) } as any,
      { client, rememberRequest: async req => { remembered.push(req); }, policy: loadRuntimePolicy({}), macReceiptKey: f.mac.publicKey });
    const result = await remote.get("flighty_add_flight")({ flight_code: "UA194", date: "2027-01-01" });
    expect(result.isError).toBe(true); expect(JSON.stringify(result)).not.toContain("secret transport error");
    expect(JSON.parse(result.content[0].text).operation_id).toBe(remembered[0].body.operationId); expect(transport).toHaveBeenCalledTimes(1);
  });
});
