import { afterEach, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runtimeFixture } from "./runtime-fixture.js";
import { openLinux, provisionLinux } from "../src/runtime/linux.js";
import { openMac, provisionMac, defaultMacReaders } from "../src/runtime/mac.js";
import { readConfig, validateConfig } from "../src/runtime/config.js";
import { makeRequest, seal, digest } from "../src/remote/protocol.js";
import { retireArtifacts } from "../src/runtime/maintenance.js";
import { IDS } from "./fixture/create.mjs";
import { trashFixture } from "./fixture/lifecycle.mjs";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) trashFixture(root); });
const readers = () => ({ ...defaultMacReaders(), build: () => "4759" });
function fixture() { const f = runtimeFixture(); roots.push(f.root); return f; }
function request(f: ReturnType<typeof fixture>, id: string, kind: "request-snapshot" | "remove-preview" = "remove-preview") {
  const issuedAt = Date.now(); return makeRequest({ caller: "linux", account: IDS.owner, operationId: id, issuedAt, expiresAt: issuedAt + 300_000,
    operation: kind === "request-snapshot" ? { kind } : { kind, flight_id: IDS.uncached } }, f.caller.privateKey);
}
it("actual private-config close/revoke/reopen authenticates old preview but denies revoked dispatch", async () => {
  const f = fixture(); provisionMac(f.macConfig); const file = f.configFile("mac"), upload = vi.fn(async () => {}), http = vi.fn(async (url: unknown) => new Response(String(url).endsWith("/search") ? IDS.flight : null, { status: 200 }));
  let m = openMac(readConfig(file, "mac"), { readers: readers(), fetchImpl: http, upload });
  const preview = request(f, "preview"); expect((await m.executor.submit(preview)).body.state).toBe("succeeded"); m.close();
  f.macConfig.callers[0].capabilities = f.macConfig.callers[0].capabilities.filter(c => c !== "remove-preview"); writeFileSync(file, JSON.stringify(f.macConfig));
  m = openMac(readConfig(file, "mac"), { readers: readers(), fetchImpl: http, upload });
  expect(m.executor.status(preview)?.body.state).toBe("succeeded"); await expect(m.executor.submit(request(f, "revoked"))).rejects.toThrow();
  expect((await m.executor.submit(request(f, "copy", "request-snapshot"))).body.state).toBe("succeeded"); expect(upload).toHaveBeenCalledTimes(1);
  for (const kind of ["add", "follow"] as const) { const issuedAt = Date.now(); const req = makeRequest({ caller: "linux", account: IDS.owner, operationId: "allowed-"+kind, issuedAt, expiresAt: issuedAt+300000, operation: {kind,flight_code:"ZZ101",date:"2026-11-11"} }, f.caller.privateKey); expect((await m.executor.submit(req)).body.state).toBe("succeeded"); }
  m.close();
});
it("actual Linux config key transition retains old evidence only through explicitly pinned historical key", async () => {
  const f = fixture(); provisionLinux(f.linux); let r = openLinux(f.linux); const old = r.client.prepare({ kind: "request-snapshot" });
  await r.durable.remember(old); await r.client.submit(old); r.close(); const oldPub = f.linux.caller.publicKey;
  const next = generateKeyPairSync("ed25519"); f.linux.caller.publicKey = next.publicKey.export({ type: "spki", format: "pem" }).toString();
  f.linux.caller.privateKey = next.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  expect(() => openLinux(f.linux)).toThrow(); f.linux.caller.historicalPublicKeys = [oldPub];
  r = openLinux(readConfig(f.configFile("linux"), "linux"));
  expect((await r.durable.status(old.body.operationId) as any).status).toBe("pending"); await expect(r.client.submit(old)).rejects.toThrow();
  const nextRequest = r.client.prepare({ kind: "request-snapshot" }); await r.durable.remember(nextRequest); expect((await r.client.submit(nextRequest)).queue).toBe("queued"); r.close();
});
it.each(["caller", "history", "receipt", "producer", "private"])("rejects operator reuse through normalized %s key before provisioning/open", value => {
  const f = fixture();
  if (value === "caller") f.macConfig.operatorPublicKey = f.macConfig.callers[0].publicKey.replace(/\n/g, "\r\n");
  if (value === "history") { f.macConfig.callers[0].historicalPublicKeys = [f.macConfig.operatorPublicKey]; }
  if (value === "receipt") f.macConfig.operatorPublicKey = f.mac.publicKey.export({ type: "spki", format: "pem" }).toString();
  if (value === "producer") f.macConfig.operatorPublicKey = f.macConfig.pins.publicKey;
  if (value === "private") f.macConfig.operatorPublicKey = f.operator.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  expect(() => validateConfig(f.macConfig)).toThrow(); expect(() => provisionMac(f.macConfig)).toThrow();
});
it("512 aged successful client records archive normally, retain authenticated lookup, and permit new request after restart", async () => {
  const f = fixture(); provisionLinux(f.linux); let r = openLinux(f.linux); const issuedAt = Date.now() - 3 * 86_400_000;
  r.clientStore.transaction(() => { for (let i = 0; i < 512; i++) {
    const req = makeRequest({ caller: "linux", account: IDS.owner, operationId: "aged-" + i, issuedAt, expiresAt: issuedAt + 1000, operation: { kind: "request-snapshot" } }, f.caller.privateKey);
    const receipt = seal("receipt", { version: 1 as const, caller: "linux", account: IDS.owner, operationId: req.body.operationId, requestDigest: digest(req.body), state: "succeeded" as const, updatedAt: issuedAt + 500, result: { status: "snapshot_requested" } }, f.mac.privateKey);
    r.clientStore.put("client", req.body.operationId, { request: req, status: { queue: "receipted", receipt } });
  } }); r.close(); r = openLinux(f.linux);
  await r.durable.remember(r.client.prepare({ kind: "request-snapshot" })); expect(r.clientStore.list("client")).toHaveLength(1);
  expect((await r.durable.status("aged-0") as any).status).toBe("succeeded"); r.close();
  expect(() => retireArtifacts(f.linux, "history", 1)).toThrow(/helper/);
  let retired = 0; const count = retireArtifacts(f.linux, "history", 1, path => { renameSync(path, join(f.root, "recoverable-" + ++retired)); });
  expect(count).toBe(1); expect(readdirSync(f.root).some(n => n.startsWith("recoverable-"))).toBe(true);
});
it("derived evidence/config/source artifact overlaps reject before ownership or retirement", () => {
  const f = fixture();
  expect(() => validateConfig({ ...f.linux, socketPath: f.linux.clientStore.path + ".archive" })).toThrow();
  expect(() => validateConfig({ ...f.macConfig, source: { ...f.macConfig.source, dbPath: join(f.macConfig.rawQuarantine, "raw-backup-id/source-snapshot.db") } })).toThrow();
  const path = join(f.macConfig.transferParent, "private-config.json"); writeFileSync(path, JSON.stringify(f.macConfig), { mode: 0o600 }); expect(() => readConfig(path, "mac")).toThrow();
});
