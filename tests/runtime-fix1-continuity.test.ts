import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { sign } from "node:crypto";
import { runtimeFixture } from "./runtime-fixture.js";
import { provisionLinux, openLinux, linuxClientStoreOptions } from "../src/runtime/linux.js";
import { PrivateStore } from "../src/remote/store.js";
import { inspectStore, recoverStore } from "../src/runtime/maintenance.js";
import { canonical, makeRequest } from "../src/remote/protocol.js";
import { trashFixture } from "./fixture/lifecycle.mjs";
vi.mock("node:fs", async (original) => { const actual = await original<typeof import("node:fs")>(); return { ...actual, renameSync: vi.fn(actual.renameSync) }; });
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) trashFixture(root); });
function setup() {
  const f = runtimeFixture(); roots.push(f.root); f.linux.operatorPublicKey = f.macConfig.operatorPublicKey; provisionLinux(f.linux); return f;
}
function attestation(f: ReturnType<typeof setup>, mode: "repair-ahead" | "migrate" = "repair-ahead") {
  const info = inspectStore(f.linux, "linux-client"), issuedAt = Date.now();
  const body = { version: 1, action: "recover-continuity", mode, ...info, nonce: "synthetic-" + issuedAt, issuedAt, expiresAt: issuedAt + 300_000 };
  return { body, signature: sign(null, Buffer.from("flighty-continuity-recovery-v1:" + canonical(body)), f.operator.privateKey).toString("base64") };
}
it("actual rename EIO after client commit blocks reopen, then bound operator repair preserves original ID", async () => {
  const f = setup(), runtime = openLinux(f.linux), request = runtime.client.prepare({ kind: "request-snapshot" });
  // Injection at the real rename syscall; transaction has already COMMITted, no submit/HTTP occurs.
  const rename = vi.mocked(fs.renameSync).getMockImplementation()!;
  const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => { if (String(to) === f.linux.clientStore.continuityPath) throw Object.assign(new Error("synthetic rename EIO"), { code: "EIO" }); rename(from, to); });
  await expect(runtime.durable.remember(request)).rejects.toThrow(); spy.mockRestore(); runtime.close();
  expect(() => openLinux(f.linux)).toThrow();
  const signed = attestation(f);
  expect(() => recoverStore(f.linux, "linux-mailbox", signed)).toThrow();
  expect(() => recoverStore(f.linux, "linux-client", { ...signed, signature: "A".repeat(86) + "==" })).toThrow();
  const wrong = { ...signed.body, observation: { ...signed.body.observation, dbSha256: "0".repeat(64) } };
  expect(() => recoverStore(f.linux, "linux-client", { body: wrong, signature: sign(null, Buffer.from("flighty-continuity-recovery-v1:" + canonical(wrong)), f.operator.privateKey).toString("base64") })).toThrow();
  recoverStore(f.linux, "linux-client", signed); expect(() => recoverStore(f.linux, "linux-client", signed)).toThrow();
  const reopened = openLinux(f.linux); expect(reopened.clientStore.get<any>("client", request.body.operationId).request).toEqual(request);
  expect((await reopened.durable.status(request.body.operationId) as any).queue).toBe("absent"); reopened.close();
});
it("explicit migration reanchors only an exact authenticated anchored image and rejects active writer/rollback", () => {
  const f = setup(), options = linuxClientStoreOptions(f.linux), runtime = openLinux(f.linux);
  expect(() => inspectStore(f.linux, "linux-client")).toThrow(); runtime.close();
  const bytes = fs.readFileSync(options.path);
  fs.renameSync(options.path, options.path + ".retained"); fs.copyFileSync(options.path + ".retained", options.path); fs.chmodSync(options.path, 0o600);
  expect(() => new PrivateStore(options)).toThrow(); const signed = attestation(f, "migrate"); recoverStore(f.linux, "linux-client", signed);
  const store = new PrivateStore(options); store.close();
  fs.writeFileSync(options.path, bytes); expect(() => attestation(f)).not.toThrow();
  const rollback = attestation(f); expect(() => recoverStore(f.linux, "linux-client", rollback)).toThrow();
});
it("repair of interrupted Mac dispatch retains consumed confirmation and recovers UNKNOWN/fence without HTTP replay", async () => {
  const { openMac, provisionMac, defaultMacReaders, macStoreOptions } = await import("../src/runtime/mac.js");
  const { DatabaseSync } = await import("node:sqlite");
  const f = runtimeFixture(); roots.push(f.root); provisionMac(f.macConfig); const http = vi.fn();
  let m = openMac(f.macConfig, { readers: { ...defaultMacReaders(), build: () => "4759" }, fetchImpl: http, upload: vi.fn() });
  const req = (operation: any, id: string) => { const issuedAt = Date.now(); return makeRequest({ caller: "linux", account: f.macConfig.pins.accountId, issuedAt, expiresAt: issuedAt + 300000, operationId: id, operation }, f.caller.privateKey); };
  const target = "77777777-7777-4777-8777-777777777777";
  const preview = await m.executor.submit(req({ kind: "remove-preview", flight_id: target }, "preview")), code = (preview.body.result as any).confirm_code;
  const confirm = req({ kind: "remove-confirm", flight_id: target, confirm_code: code }, "confirm");
  const rename = vi.mocked(fs.renameSync).getMockImplementation()!;
  vi.mocked(fs.renameSync).mockImplementation((from, to) => {
    if (String(to) === f.macConfig.store.continuityPath) {
      const db = new DatabaseSync(f.macConfig.store.path, { readOnly: true });
      const row = db.prepare("SELECT doc FROM state WHERE kind='operation' AND id='confirm'").get(); db.close();
      if (row && JSON.parse(String(row.doc)).receipt.body.state === "dispatched") throw Object.assign(new Error("synthetic dispatch anchor EIO"), { code: "EIO" });
    }
    rename(from, to);
  });
  await expect(m.executor.submit(confirm)).rejects.toThrow(); vi.mocked(fs.renameSync).mockImplementation(rename); m.close(); expect(http).not.toHaveBeenCalled();
  const info = inspectStore(f.macConfig, "mac-executor"), issuedAt = Date.now();
  const body = { version: 1, action: "recover-continuity", mode: "repair-ahead", ...info, nonce: "dispatch-repair", issuedAt, expiresAt: issuedAt + 300000 };
  recoverStore(f.macConfig, "mac-executor", { body, signature: sign(null, Buffer.from("flighty-continuity-recovery-v1:" + canonical(body)), f.operator.privateKey).toString("base64") });
  m = openMac(f.macConfig, { readers: { ...defaultMacReaders(), build: () => "4759" }, fetchImpl: http, upload: vi.fn() });
  expect(m.executor.status(confirm)?.body.state).toBe("unknown"); expect((await m.executor.submit(confirm)).body.state).toBe("unknown"); expect(http).not.toHaveBeenCalled(); m.close();
  const store = new PrivateStore(macStoreOptions(f.macConfig)); expect(store.get<any>("preview", code).consumed).toBe(true); expect(store.get("fence", f.macConfig.pins.accountId)).toBeTruthy(); store.close();
});
it("sequence continuity repair preserves the reserved highwater rather than resetting or reusing", async () => {
  const { provisionMac, sequenceStoreOptions } = await import("../src/runtime/mac.js");
  const f = runtimeFixture(); roots.push(f.root); provisionMac(f.macConfig); const options = sequenceStoreOptions(f.macConfig), store = new PrivateStore(options);
  const rename = vi.mocked(fs.renameSync).getMockImplementation()!;
  vi.mocked(fs.renameSync).mockImplementation((from, to) => { if (String(to) === options.continuityPath) throw new Error("synthetic sequence EIO"); rename(from, to); });
  expect(() => store.put("sequence", "producer", { next: 38 })).toThrow(); vi.mocked(fs.renameSync).mockImplementation(rename); store.close();
  expect(() => new PrivateStore(options)).toThrow(); const info = inspectStore(f.macConfig, "mac-sequence"), issuedAt = Date.now();
  const body = { version: 1, action: "recover-continuity", mode: "repair-ahead", ...info, nonce: "sequence-repair", issuedAt, expiresAt: issuedAt + 300000 };
  recoverStore(f.macConfig, "mac-sequence", { body, signature: sign(null, Buffer.from("flighty-continuity-recovery-v1:" + canonical(body)), f.operator.privateKey).toString("base64") });
  const reopened = new PrivateStore(options); expect(reopened.get("sequence", "producer")).toEqual({ next: 38 }); reopened.close();
});
it("applied aged recovery audits have a bounded authenticated recoverable retirement path", () => {
  // Use a separate fully exercised ahead repair; the audit remains signed and is retained recoverably.
  const f = setup(), options = linuxClientStoreOptions(f.linux), store = new PrivateStore(options);
  const rename = vi.mocked(fs.renameSync).getMockImplementation()!;
  vi.mocked(fs.renameSync).mockImplementation((from,to)=>{if(String(to)===options.continuityPath)throw new Error("synthetic EIO");rename(from,to);});
  const issued=Date.now(), request=makeRequest({caller:"linux",account:f.linux.pins.accountId,operationId:"audit-retirement",issuedAt:issued,expiresAt:issued+300000,operation:{kind:"request-snapshot"}},f.caller.privateKey);
  expect(()=>store.put("client",request.body.operationId,{request,status:null})).toThrow();vi.mocked(fs.renameSync).mockImplementation(rename);store.close();
  const signed=attestation(f);recoverStore(f.linux,"linux-client",signed);
  const past=Date.now()-3*86400000, body={...signed.body,issuedAt:past,expiresAt:past+300000};
  const file=options.continuityPath+".recovery/"+body.nonce+".json";
  fs.writeFileSync(file,JSON.stringify({body,signature:sign(null,Buffer.from("flighty-continuity-recovery-v1:"+canonical(body)),f.operator.privateKey).toString("base64")}));
  const retired=PrivateStore.retireRecoveryAudits(options,{key:f.operator.publicKey,role:"linux-client"},1,path=>fs.renameSync(path,f.root+"/audit-recoverable.json"));
  expect(retired).toBe(1);expect(fs.existsSync(f.root+"/audit-recoverable.json")).toBe(true);
});
