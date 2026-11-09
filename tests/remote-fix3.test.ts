import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { capturedApiFactory } from "../src/remote/executor.js";
import { Mailbox, localTransport, pollMailbox } from "../src/remote/mailbox.js";
import { boundedJson, verifyReceipt } from "../src/remote/protocol.js";
import { redactResultSecrets, sanitizeReceiptError } from "../src/remote/redaction.js";
import { fixture, FLIGHT, type Fixture } from "./remote-fixture.js";
const fixtures: Fixture[] = [], children: ChildProcess[] = [];
const setup = () => { const f = fixture(); fixtures.push(f); return f; };
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => child.once("exit", () => resolve()));
  }
  for (const f of fixtures.splice(0)) f.close();
});
const add = { kind: "add", flight_code: "UA194", date: "2027-01-01" } as const;
const privateSession = "SYNTHETIC-PRIVATE-SESSION-6D94A2FB", privateBuild = "SYNTHETIC-PRIVATE-BUILD-8B2E4D10";

describe("Z1 classify private context before source-field exemptions", () => {
  it.each(["session", "build"] as const)("removes private %s from all typed/source fields before signing or either store/transport", async kind => {
    const f = setup(), secret = kind === "session" ? privateSession : privateBuild;
    f.context = { ...f.context!, session: privateSession, buildToken: privateBuild };
    const local = f.local();
    for (const key of ["booking_reference", "tail_number", "seat_number", "seat_position", "cabin_class", "tracking_source", "passenger_name_source", "airline_name", "friend_name"]) (local.flight as any)[key] = secret;
    (local.identity as any).source = secret; (local.identity as any).label = secret; local.identity.warning = secret;
    f.record = local;
    const mailbox = new Mailbox({ store: f.storeAt("mailbox"), callers: f.callers, macReceiptKey: f.mac.publicKey, now: () => f.now });
    const caller = localTransport(mailbox, { role: "caller", caller: "linux" }), mac = localTransport(mailbox, { role: "mac" });
    const request = f.request({ kind: "remove-preview", flight_id: FLIGHT });
    await caller(boundedJson({ verb: "submit", request })); expect(await pollMailbox(mac, f.executor)).toBe(1);
    const receipt = f.executor.status(request)!;
    expect(verifyReceipt(receipt, f.mac.publicKey, request.body).state).toBe("succeeded");
    const result = receipt.body.result as any;
    expect(result.flight_id).toBe(FLIGHT); expect(result.flight.id).toBe(FLIGHT); expect(result.confirm_code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(JSON.stringify(receipt)).not.toContain(secret);
    expect(await caller(boundedJson({ verb: "status", request }))).not.toContain(secret);
    for (const name of ["mac", "mailbox"]) expect(readFileSync(f.storeOptions(name).path).toString()).not.toContain(secret);
    expect(result.flight.booking_reference).toBe("[redacted-secret]"); expect(result.flight.tail_number).toBe("[redacted-secret]");
    expect(result.flight.owner_identity.source).toBe("[redacted-secret]"); expect(result.local_identity).toBe("[redacted-secret]");
  });
  it("only exempts a UUID proven equal to the generated protocol target", () => {
    const secret = "66666666-6666-4666-8666-666666666666";
    const result = redactResultSecrets({ flight_id: FLIGHT, flight: { id: secret } }, [secret], [secret]) as any;
    expect(result.flight_id).toBe(FLIGHT); expect(result.flight.id).toBe("[redacted-secret]");
  });
  it("does not classify ordinary public build/booking/short-label or unrelated UUID controls as secrets", async () => {
    const f = setup(); f.context = { ...f.context!, session: "r", buildToken: "4759" };
    const local = f.local(); local.flight.id = "bbbb4759-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; local.flight.booking_reference = "4759-r-A";
    local.flight.tail_number = "N4759R"; local.flight.seat_number = "4A"; f.record = local;
    const request = f.request({ kind: "remove-preview", flight_id: local.flight.id }), receipt = await f.executor.submit(request);
    expect(receipt.body.state).toBe("succeeded"); const result = receipt.body.result as any;
    expect(result.flight_id).toBe(local.flight.id); expect(result.flight.id).toBe(local.flight.id);
    expect(result.flight.booking_reference).toBe("4759-r-A"); expect(result.flight.tail_number).toBe("N4759R");
    expect(result.flight.seat_number).toBe("4A"); expect(result.local_identity).toBe("signed_in_owner");
    expect((await f.executor.submit(f.request({ kind: "remove-confirm", flight_id: local.flight.id, confirm_code: result.confirm_code }))).body.state).toBe("succeeded");
    const uuid = "77777777-7777-4777-8777-777777777777";
    const scrubbed = redactResultSecrets({ flight_id: FLIGHT, flight: { id: FLIGHT, booking_reference: uuid, tail_number: privateSession } }, [privateSession], [privateSession]) as any;
    expect(scrubbed.flight.booking_reference).toBe(uuid); expect(scrubbed.flight.tail_number).toBe("[redacted-secret]");
    expect(sanitizeReceiptError("r abc", ["r", "abc"])).toBe("[redacted-secret] [redacted-secret]");
  });
});

async function operationFor(f: Fixture, kind: "add" | "follow" | "remove-confirm") {
  if (kind !== "remove-confirm") return { ...add, kind };
  f.record = f.local(); const preview = await f.executor.submit(f.request({ kind: "remove-preview", flight_id: FLIGHT }));
  return { kind, flight_id: FLIGHT, confirm_code: (preview.body.result as any).confirm_code };
}
function installCapturedFactory(f: Fixture, kind: string, prepare: () => void) {
  let searched = kind === "remove-confirm";
  const mutations: Array<{ authorization: string; url: string }> = [];
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/search")) { searched = true; return new Response(FLIGHT); }
    mutations.push({ authorization: (init!.headers as Record<string, string>).Authorization, url: String(url) });
    return new Response(null, { status: 200 });
  });
  const base = capturedApiFactory({ policy: f.deps.policy, fetchImpl });
  f.deps.createApi = (context, signal, activity) => {
    const api = base(context, signal, activity);
    if (searched) prepare();
    return api;
  };
  return mutations;
}

describe("Z2 current authority after bounded API preparation", () => {
  it.each(["add", "follow", "remove-confirm"] as const)("normal prepared %s invokes once using the same freshly validated captured credential", async kind => {
    const f = setup(), operation = await operationFor(f, kind); let prepared = 0;
    const mutations = installCapturedFactory(f, kind, () => { prepared++; });
    const receipt = await f.executor.submit(f.request(operation)); expect(receipt.body.state).toBe("succeeded");
    expect(prepared).toBe(1); expect(mutations).toHaveLength(1); expect(mutations[0].authorization).toBe(`Bearer ${f.context!.authToken}`);
  });
  it.each(["token", "session", "account", "caller", "capability", "record"])("rejects known %s change during preparation with zero invocation and no fence", async change => {
    const f = setup(), operation = await operationFor(f, "remove-confirm"); const local = f.local();
    const mutations = installCapturedFactory(f, "remove-confirm", () => {
      if (change === "token") f.context = { ...f.context!, authToken: "SYNTHETIC-ROTATED-LOGIN" };
      if (change === "session") f.context = { ...f.context!, session: "SYNTHETIC-ROTATED-SESSION" };
      if (change === "account") f.context = { ...f.context!, account: "other-synthetic-account" };
      if (change === "caller") (f.callers as any).linux = undefined;
      if (change === "capability") (f.callers.linux as any).capabilities = ["add"];
      if (change === "record") f.record = { ...local, flight: { ...local.flight, seat_number: "2B" } };
    });
    const request = f.request(operation), receipt = await f.executor.submit(request);
    expect(receipt.body.state).toBe("failed"); expect(receipt.body.error).toContain("Nothing dispatched"); expect(mutations).toHaveLength(0);
    expect(f.store.get("fence", "synthetic-account")).toBeUndefined();
    expect(f.store.get<any>("preview", (operation as any).confirm_code).consumed).toBe(true);
  });
  it("rechecks the original preview deadline after awaited post-preparation validation", async () => {
    const f = setup(), operation = await operationFor(f, "remove-confirm"); const previewExpiry = f.now + 300_000;
    f.now += 299_900; const request = f.request(operation); let preparing = false;
    const capture = f.deps.captureContext;
    f.deps.captureContext = async signal => { const current = await capture(signal); if (preparing) f.now = previewExpiry + 1; return current; };
    const mutations = installCapturedFactory(f, "remove-confirm", () => { preparing = true; });
    expect((await f.executor.submit(request)).body.state).toBe("failed"); expect(f.now).toBeLessThan(request.body.expiresAt);
    expect(mutations).toHaveLength(0); expect(f.store.get("fence", "synthetic-account")).toBeUndefined();
    expect(f.store.get<any>("preview", (operation as any).confirm_code).consumed).toBe(true);
  });
  it("bounded preparation cannot consume the remaining step budget and then invoke on a delayed event loop", async () => {
    const f = setup(), request = f.request(add, { expiresAt: f.now + 100 });
    const mutations = installCapturedFactory(f, "add", () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 160); });
    expect((await f.executor.submit(request)).body.state).toBe("failed");
    expect(mutations).toHaveLength(0); expect(f.store.get("fence", "synthetic-account")).toBeUndefined();
  });
});

describe("Z2 independent updater during pure factory preparation", () => {
  it.each(["context", "record"])("rejects independent %s drift during a pure blocking factory", async changed => {
    const f = setup(), kind = changed === "record" ? "remove-confirm" : "add";
    const root = resolve(".cache/remote-fix3-codex"); mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(root + "/probe-"); chmodSync(directory, 0o700);
    const contextPath = resolve(directory, "synthetic-context.json"), recordPath = resolve(directory, "synthetic-record.json");
    const ready = resolve(directory, "ready"), trigger = resolve(directory, "trigger"), done = resolve(directory, "done.json");
    writeFileSync(contextPath, JSON.stringify(f.context), { mode: 0o600 }); writeFileSync(recordPath, JSON.stringify(f.local()), { mode: 0o600 });
    f.deps.captureContext = async () => JSON.parse(readFileSync(contextPath, "utf8"));
    f.deps.openDatabase = () => ({ db: f.db, close: () => {}, removalCandidates: () => [JSON.parse(readFileSync(recordPath, "utf8"))] });
    const operation = await operationFor(f, kind), request = f.request(operation);
    const next = changed === "context" ? { ...f.context!, authToken: "SYNTHETIC-INDEPENDENT-ROTATION", session: "SYNTHETIC-INDEPENDENT-SESSION" } : { ...f.local(), flight: { ...f.local().flight, seat_number: "2B" } };
    const destination = changed === "context" ? contextPath : recordPath;
    const source = `import {existsSync,writeFileSync} from 'node:fs';
      const [ready,trigger,destination,payload,done] = process.argv.slice(1);
      writeFileSync(ready,'ready',{mode:0o600}); const start=Date.now(); const wait=new Int32Array(new SharedArrayBuffer(4));
      while(!existsSync(trigger)) {if(Date.now()-start>5000)process.exit(2); Atomics.wait(wait,0,0,5);}
      Atomics.wait(wait,0,0,80); writeFileSync(destination,payload,{mode:0o600});
      writeFileSync(done,JSON.stringify({updatedAt:Date.now()}),{mode:0o600});`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, ready, trigger, destination, JSON.stringify(next), done], { stdio: "ignore" }); children.push(child);
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
    f.deps.boundary = name => { if (name === "dispatch") writeFileSync(trigger, "go", { mode: 0o600 }); };
    let preparedStart = 0, preparedEnd = 0;
    const mutations = installCapturedFactory(f, kind, () => {
      // Only preparation and a bounded wait; authoritative files are changed solely by the other process.
      preparedStart = Date.now(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); preparedEnd = Date.now();
    });
    const receipt = await f.executor.submit(request);
    expect(preparedStart).toBeGreaterThan(0); expect(existsSync(done)).toBe(true);
    const updatedAt = JSON.parse(readFileSync(done, "utf8")).updatedAt;
    expect(updatedAt).toBeGreaterThanOrEqual(preparedStart); expect(updatedAt).toBeLessThanOrEqual(preparedEnd);
    expect(JSON.parse(readFileSync(destination, "utf8"))).toEqual(next);
    expect(receipt.body.state).toBe("failed"); expect(mutations).toHaveLength(0); expect(f.store.get("fence", "synthetic-account")).toBeUndefined();
    if (kind === "remove-confirm") expect(f.store.get<any>("preview", (operation as any).confirm_code).consumed).toBe(true);
    await vi.waitFor(() => expect(child.exitCode).toBe(0));
  });
});
