import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { capturedApiFactory } from "../src/remote/executor.js";
import { RemoteClient, registerRemoteWriteTools } from "../src/remote/client.js";
import { Mailbox, localTransport, pollMailbox } from "../src/remote/mailbox.js";
import { boundedJson, digest, ProtocolError, seal } from "../src/remote/protocol.js";
import { sshTransport } from "../src/remote/transport.js";
import { fixture, FLIGHT, AIRLINE, type Fixture } from "./remote-fixture.js";
const fixtures: Fixture[] = [];
const setup = () => { const f = fixture(); fixtures.push(f); return f; };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const f of fixtures.splice(0)) f.close(); });
const add = { kind: "add", flight_code: "UA194", date: "2027-01-01" } as const;
const tick = async () => { for (let n = 0; n < 80; n++) await Promise.resolve(); };
function box(f: Fixture) {
  const mailbox = new Mailbox({ store: f.storeAt("mailbox"), callers: f.callers, macReceiptKey: f.mac.publicKey, now: () => f.now });
  return { mailbox, mac: localTransport(mailbox, { role: "mac" }), caller: localTransport(mailbox, { role: "caller", caller: "linux" }) };
}

describe("actual cancellation and durable account fencing", () => {
  it("the executor deadline aborts the actual captured fetch and blocks a queued mutation before the API's own timer", async () => {
    const f = setup();
    const timers: Array<{ callback: () => void; active: boolean; unref: () => void }> = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      const timer = { callback, active: true, unref() {} }; timers.push(timer); return timer;
    }) as any);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(((timer: typeof timers[number]) => { if (timer) timer.active = false; }) as any);
    let activeFetch = false, mutationSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/search")) return new Response(FLIGHT);
      activeFetch = true; mutationSignal = init!.signal as AbortSignal;
      return new Promise<Response>(() => {}); // Deliberately ignores cancellation/never settles.
    });
    f.deps.createApi = capturedApiFactory({ policy: f.deps.policy, fetchImpl });
    const firstRequest = f.request(add), first = f.executor.submit(firstRequest);
    await tick(); expect(fetchImpl).toHaveBeenCalledTimes(2); expect(activeFetch).toBe(true);
    const second = f.executor.submit(f.request(add)); await tick(); expect(fetchImpl).toHaveBeenCalledTimes(2);
    const activeTimers = timers.filter(timer => timer.active); expect(activeTimers).toHaveLength(2);
    activeTimers[0].active = false; activeTimers[0].callback(); // Executor only; API deadline still pending.
    await tick();
    expect(mutationSignal!.aborted).toBe(true); expect(activeTimers[1].active).toBe(true);
    expect((await first).body.state).toBe("unknown"); expect((await second).body.state).toBe("failed");
    expect(fetchImpl).toHaveBeenCalledTimes(2); expect(f.store.get("fence", "synthetic-account")).toBeDefined();
    activeTimers[1].callback(); await tick();
    f.restart(); expect((await f.executor.submit(f.request(add))).body.state).toBe("failed");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((await f.executor.submit(firstRequest)).body.state).toBe("unknown");
  });
  it("even an injected provider ignoring abort cannot release dispatch authority after timeout", async () => {
    const f = setup(); vi.useFakeTimers();
    f.api.subscribeFlight.mockImplementationOnce(() => new Promise(() => {}));
    const first = f.executor.submit(f.request(add)), second = f.executor.submit(f.request(add));
    await vi.advanceTimersByTimeAsync(15_001);
    expect((await first).body.state).toBe("unknown"); expect((await second).body.state).toBe("failed");
    expect(f.api.subscribeFlight).toHaveBeenCalledTimes(1); expect(f.api.searchFlight).toHaveBeenCalledTimes(1);
  });
  it("a search timeout cannot let a second request overlap an unresolved HTTP step", async () => {
    const f = setup(); vi.useFakeTimers(); let settle!: () => void;
    f.api.searchFlight.mockImplementationOnce(() => new Promise(resolve => { settle = () => resolve(null); }));
    const first = f.executor.submit(f.request(add)), second = f.executor.submit(f.request(add));
    await vi.advanceTimersByTimeAsync(15_001);
    expect((await first).body.state).toBe("failed"); expect((await second).body.state).toBe("failed");
    expect(f.api.searchFlight).toHaveBeenCalledTimes(1); expect(f.api.subscribeFlight).not.toHaveBeenCalled();
    settle(); await tick();
  });
  it("failure to persist an unresolved fence quarantines the store instead of enabling the next mutation", async () => {
    const f = setup(), put = f.store.put.bind(f.store); vi.useFakeTimers();
    f.api.subscribeFlight.mockImplementationOnce(() => new Promise(() => {}));
    vi.spyOn(f.store, "put").mockImplementation((kind, id, value) => { if (kind === "fence") throw new Error("synthetic disk full"); return put(kind, id, value); });
    const first = f.executor.submit(f.request(add)), second = f.executor.submit(f.request(add));
    const result = Promise.allSettled([first, second]); await vi.advanceTimersByTimeAsync(15_001);
    expect((await result).every(value => value.status === "rejected")).toBe(true); expect(f.api.subscribeFlight).toHaveBeenCalledTimes(1);
    expect(() => f.executor.maintenance()).toThrow(/operator recovery/);
  });
});

describe("original runway confirmation context", () => {
  it.each(["departureScheduleRunwayOriginal", "arrivalScheduleRunwayOriginal"] as const)("invalidates %s when gate dates are unavailable", async field => {
    const f = setup(), local = f.local();
    local.flight.departureScheduleGateOriginal = null; local.flight.arrivalScheduleGateOriginal = null;
    local.flight.departureScheduleRunwayOriginal = "2027-01-01T12:00:00Z"; local.flight.arrivalScheduleRunwayOriginal = "2027-01-01T14:00:00Z";
    f.record = local; const preview = await f.executor.submit(f.request({ kind: "remove-preview", flight_id: FLIGHT }));
    const code = (preview.body.result as any).confirm_code;
    f.record = { ...local, flight: { ...local.flight, [field]: "2027-01-02T12:00:00Z" } };
    expect((await f.executor.submit(f.request({ kind: "remove-confirm", flight_id: FLIGHT, confirm_code: code }))).body.state).toBe("failed");
    expect(f.api.deleteFlight).not.toHaveBeenCalled();
  });
});

describe("pre-transport Mac error redaction", () => {
  it("redacts exact captured secrets/private URLs before signing, persistence and mailbox publication", async () => {
    const f = setup(), { caller, mac } = box(f), context = f.context!;
    const name = `Authorization: Bearer ${context.authToken} ${context.buildToken} ${context.session} ${context.syncUrl}`;
    vi.mocked(f.db.lookupAirlines).mockReturnValue([{ id: AIRLINE, iata: "UA", name }]); f.api.searchFlight.mockResolvedValue(null);
    const req = f.request(add); await caller(boundedJson({ verb: "submit", request: req }));
    expect(await pollMailbox(mac, f.executor)).toBe(1);
    const result = await caller(boundedJson({ verb: "status", request: req }));
    const receipt = f.executor.status(req)!;
    for (const secret of [context.authToken, context.buildToken, context.session, context.syncUrl!]) {
      expect(JSON.stringify(receipt)).not.toContain(secret); expect(result).not.toContain(secret);
      expect(readFileSync(f.storeOptions("mac").path).toString()).not.toContain(secret);
    }
    expect(receipt.body.state).toBe("failed"); expect(receipt.body.error).toContain("No flight found");
  });
  it("preserves legitimate booking and normal preview fields while scrubbing exact secret injection", async () => {
    const f = setup(), local = f.local(); local.flight.booking_reference = "AB12CD"; local.flight.airline_name = "Bearer Airlines";
    f.record = local; const receipt = await f.executor.submit(f.request({ kind: "remove-preview", flight_id: FLIGHT }));
    const flight = (receipt.body.result as any).flight;
    expect(flight.booking_reference).toBe("AB12CD"); expect(flight.airline_name).toBe("Bearer Airlines");
  });
  it("independently redacts an authenticated malicious error on the client display path", async () => {
    const f = setup(), tools = new Map();
    const client = new RemoteClient({ caller: "linux", account: "synthetic-account", signingKey: f.caller.privateKey, macReceiptKey: f.mac.publicKey,
      now: () => f.now, transport: async () => boundedJson({ queue: "queued", receipt: null }) });
    registerRemoteWriteTools({ registerTool: (name: string, _schema: unknown, fn: unknown) => tools.set(name, fn) } as any,
      { client, policy: f.deps.policy, macReceiptKey: f.mac.publicKey, rememberRequest: async () => {},
        waitForReceipt: async req => seal("receipt", { version: 1, operationId: req.body.operationId, caller: req.body.caller, account: req.body.account,
          requestDigest: digest(req.body), state: "failed", updatedAt: f.now,
          error: "Authorization: Bearer SYNTHETIC-SECRET https://private.invalid/secret-token?auth=HIDDEN /Users/synthetic/private-db" }, f.mac.privateKey) });
    const result = await tools.get("flighty_add_flight")({ flight_code: "UA194", date: "2027-01-01" });
    expect(result.isError).toBe(true); expect(JSON.stringify(result)).not.toContain("SYNTHETIC-SECRET");
    expect(JSON.stringify(result)).not.toContain("private.invalid"); expect(JSON.stringify(result)).not.toContain("private-db");
  });
});

describe("resubmission progress and truthful pending receipts", () => {
  it("a duplicate arriving during actual mutation execution awaits the same committed terminal receipt", async () => {
    const f = setup(); let release!: () => void;
    f.api.subscribeFlight.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const req = f.request(add), first = f.executor.submit(req);
    await vi.waitFor(() => expect(f.api.subscribeFlight).toHaveBeenCalledTimes(1));
    let done = false; const duplicate = f.executor.submit(req).then(value => { done = true; return value; });
    await tick(); expect(done).toBe(false); expect(f.executor.status(req)!.body.state).toBe("dispatched");
    release(); expect((await first).body.state).toBe("succeeded"); expect((await duplicate).body.state).toBe("succeeded");
    expect(f.api.subscribeFlight).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])("re-leased queued-boundary interruption completes without drain; expired=%s", async expired => {
    const f = setup(), { mac, caller } = box(f), req = f.request(add);
    await caller(boundedJson({ verb: "submit", request: req }));
    f.deps.boundary = name => { if (name === "queued") throw new Error("synthetic interruption"); };
    await expect(pollMailbox(mac, f.executor)).rejects.toThrow("synthetic interruption"); f.deps.boundary = undefined;
    f.now += expired ? 300_001 : 30_001;
    expect(await pollMailbox(mac, f.executor)).toBe(1);
    const status = JSON.parse(await caller(boundedJson({ verb: "status", request: req })));
    expect(status.receipt.body.state).toBe(expired ? "failed" : "succeeded");
    expect(f.api.subscribeFlight).toHaveBeenCalledTimes(expired ? 0 : 1);
    if (expired) expect(f.api.searchFlight).not.toHaveBeenCalled();
  });
  it("lost lease before Mac acceptance still produces a signed expiry without any source/API dispatch", async () => {
    const f = setup(), { mac, caller } = box(f), req = f.request(add);
    await caller(boundedJson({ verb: "submit", request: req })); await mac(boundedJson({ verb: "lease", limit: 1 }));
    f.now += 300_001;
    expect(await pollMailbox(mac, f.executor)).toBe(1); expect(f.executor.status(req)!.body.state).toBe("failed");
    expect(f.deps.captureContext).not.toHaveBeenCalled(); expect(f.api.searchFlight).not.toHaveBeenCalled();
  });
  it.each(["not-dispatched", "dispatched"] as const)("renders signed %s as pending, without a terminal error or a new ID", async state => {
    const f = setup(), tools = new Map(); let remembered = "";
    const client = new RemoteClient({ caller: "linux", account: "synthetic-account", signingKey: f.caller.privateKey, macReceiptKey: f.mac.publicKey,
      now: () => f.now, transport: async () => boundedJson({ queue: "queued", receipt: null }) });
    registerRemoteWriteTools({ registerTool: (name: string, _schema: unknown, fn: unknown) => tools.set(name, fn) } as any,
      { client, policy: f.deps.policy, macReceiptKey: f.mac.publicKey, rememberRequest: async req => { remembered = req.body.operationId; },
        waitForReceipt: async req => seal("receipt", { version: 1, operationId: req.body.operationId, caller: req.body.caller, account: req.body.account,
          requestDigest: digest(req.body), state, updatedAt: f.now }, f.mac.privateKey) });
    const result = await tools.get("flighty_add_flight")({ flight_code: "UA194", date: "2027-01-01" });
    expect(result.isError).toBeUndefined(); expect(JSON.parse(result.content[0].text)).toMatchObject({ status: "pending", operation_id: remembered });
  });
});

describe("bounded fixed protocol and SSH", () => {
  it.each([null, true, 4, "bad", {}])("rejects malformed receipt payload %j with ProtocolError", receipt => {
    const f = setup(), { mailbox } = box(f);
    expect(() => mailbox.handle({ role: "mac" }, boundedJson({ verb: "receipt", receipt }))).toThrow(ProtocolError);
  });
  it("bounds aggregate stderr and stdout even if stderr is followed by a valid response", async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() });
    const transport = sshTransport({ enabled: true, host: "synthetic.invalid", port: 2222, user: "synthetic",
      identityFile: "/synthetic/key", knownHostsFile: "/synthetic/hosts", checkConfiguration: () => {} }, (() => child) as any);
    const pending = transport(boundedJson({ verb: "lease", limit: 1 }));
    child.stderr.write(Buffer.alloc(128 * 1024, 65)); child.stdout.write('{"requests":[]}'); child.emit("close", 0);
    await expect(pending).rejects.toThrow(/output too large/); expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
  it.each(["/synthetic/with space", '/synthetic/with"quote', "/synthetic/with'tick", "/synthetic/with\ttab"])("rejects unsupported option path %j without spawning", path => {
    const spawn = vi.fn();
    expect(() => sshTransport({ enabled: true, host: "synthetic.invalid", port: 2222, user: "synthetic",
      identityFile: "/synthetic/key", knownHostsFile: path, checkConfiguration: () => {} }, spawn as any)).toThrow(/SSH paths/);
    expect(spawn).not.toHaveBeenCalled();
  });
});
