import { afterEach, expect, it, vi } from "vitest";
import { sign } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeFixture } from "./runtime-fixture.js";
import { openLinux, provisionLinux } from "../src/runtime/linux.js";
import { openMac, provisionMac, defaultMacReaders } from "../src/runtime/mac.js";
import { archiveResolvedClient, retireArtifacts } from "../src/runtime/maintenance.js";
import { makeRequest, seal, digest, canonical } from "../src/remote/protocol.js";
import { verifyAudit } from "../src/remote/recovery.js";
import { callersFor, publicKey } from "../src/runtime/config.js";
import { measureStorage } from "../src/replica/cleanup.js";
import { trashFixture } from "./fixture/lifecycle.mjs";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) trashFixture(root); });
it("aged UNKNOWN survives normal maintenance until independent bound resolution, with authenticated audit/UNKNOWN archive after reopen", async () => {
  const f = runtimeFixture(); roots.push(f.root); f.linux.operatorPublicKey = f.macConfig.operatorPublicKey; provisionLinux(f.linux); let r = openLinux(f.linux);
  const issuedAt = Date.now() - 3 * 86400000;
  const request = makeRequest({ caller: "linux", account: f.linux.pins.accountId, operationId: "old-unknown", issuedAt, expiresAt: issuedAt + 1000,
    operation: { kind: "remove-confirm", flight_id: "77777777-7777-4777-8777-777777777777", confirm_code: "ABCDEFGH" } }, f.caller.privateKey);
  const receipt = seal("receipt", { version: 1 as const, caller: "linux", account: request.body.account, operationId: request.body.operationId, requestDigest: digest(request.body), state: "unknown" as const, updatedAt: issuedAt + 500 }, f.mac.privateKey);
  r.clientStore.put("client", request.body.operationId, { request, status: { queue: "receipted", receipt } }); r.durable.maintenance(); expect(r.clientStore.get("client", request.body.operationId)).toBeTruthy(); r.close();
  const now = Date.now(), body = { version: 1, action: "clear-account-fence-after-external-check", account: request.body.account, operationId: request.body.operationId,
    requestDigest: digest(request.body), fenceDigest: digest({ request, state: "unresolved" }), auditId: "archive-audit", operator: "synthetic-operator", evidenceSha256: "a".repeat(64),
    checkedAt: now, issuedAt: now, expiresAt: now + 300000, statement: "External outcome checked; authorize future distinct operations; original outcome remains unknown; do not replay." };
  const attest = (key: typeof f.operator.privateKey) => ({ body, signature: sign(null, Buffer.from("flighty-operator-reconciliation-v1:" + canonical(body)), key).toString("base64") });
  expect(() => archiveResolvedClient(f.linux, attest(f.caller.privateKey))).toThrow(); archiveResolvedClient(f.linux, attest(f.operator.privateKey));
  expect(() => archiveResolvedClient(f.linux, attest(f.operator.privateKey))).toThrow();
  r = openLinux(f.linux); expect(r.clientStore.get("client", request.body.operationId)).toBeUndefined(); expect((await r.durable.status(request.body.operationId) as any).status).toBe("unknown");
  const audit = r.clientStore.archived("client-resolution", "archive-audit"); expect(() => verifyAudit(audit, "archive-audit", callersFor(f.linux), f.mac.publicKey, f.operator.publicKey)).not.toThrow(); r.close();
  let moved = 0; const retired = retireArtifacts(f.linux, "history", 2, path => renameSync(path, join(f.root, "recoverable-evidence-" + ++moved)));
  expect(retired).toBe(2); expect(moved).toBe(2);
});
it("post-export context rotation quarantines the signed copy; explicit bounded retirement frees full owned quarantine without touching source", async () => {
  const f = runtimeFixture(); roots.push(f.root); provisionMac(f.macConfig); let builds = 0; const upload = vi.fn();
  const m = openMac(f.macConfig, { readers: { ...defaultMacReaders(), build: () => ++builds >= 3 ? "4760" : "4759" }, fetchImpl: vi.fn(), upload });
  const signal = new AbortController().signal, context = await m.captureContext(signal);
  await expect(m.snapshot(context!, signal)).rejects.toThrow(); expect(upload).not.toHaveBeenCalled(); m.close();
  expect(readdirSync(f.macConfig.transferParent)).toEqual([]); expect(readdirSync(f.macConfig.rawQuarantine).some(n => n.startsWith("copy-e1-s1-"))).toBe(true);
  const source = readFileSync(f.fixture.mainPath), owned = join(f.macConfig.rawQuarantine, "raw-backup-11111111-1111-4111-8111-111111111111");
  mkdirSync(owned, { mode: 0o700 }); writeFileSync(join(owned, "source-snapshot.db"), "synthetic-private-raw", { mode: 0o600 }); const old = new Date(Date.now() - 3 * 86400000); utimesSync(owned, old, old);
  f.macConfig.budget.maxBytes = measureStorage(f.macConfig.rawQuarantine).bytes;
  const count = retireArtifacts(f.macConfig, "quarantine", 1, path => { expect(path).toBe(owned); renameSync(path, join(f.root, "recoverable-raw")); });
  expect(count).toBe(1); expect(readFileSync(f.fixture.mainPath)).toEqual(source); expect(readFileSync(join(f.root, "recoverable-raw", "source-snapshot.db"), "utf8")).toBe("synthetic-private-raw");
});
it("unreceipted expired original request archives only with independent bound evidence, without fabricating a Mac receipt", async () => {
  const { verifyClientResolution } = await import("../src/runtime/client-state.js");
  const f = runtimeFixture(); roots.push(f.root); f.linux.operatorPublicKey = f.macConfig.operatorPublicKey; provisionLinux(f.linux); let r = openLinux(f.linux);
  const issuedAt = Date.now() - 3 * 86400000, request = makeRequest({ caller: "linux", account: f.linux.pins.accountId, operationId: "unreceipted", issuedAt, expiresAt: issuedAt+1000, operation:{kind:"request-snapshot"} }, f.caller.privateKey);
  r.clientStore.put("client", "unreceipted", {request,status:null}); r.durable.maintenance(); expect(r.clientStore.get("client","unreceipted")).toBeTruthy(); r.close();
  const now = Date.now(), body={version:1,action:"clear-account-fence-after-external-check",account:request.body.account,operationId:"unreceipted",requestDigest:digest(request.body),fenceDigest:digest({request,state:"unresolved"}),auditId:"unreceipted-audit",operator:"synthetic-operator",evidenceSha256:"a".repeat(64),checkedAt:now,issuedAt:now,expiresAt:now+300000,statement:"External outcome checked; authorize future distinct operations; original outcome remains unknown; do not replay."};
  archiveResolvedClient(f.linux,{body,signature:sign(null,Buffer.from("flighty-operator-reconciliation-v1:"+canonical(body)),f.operator.privateKey).toString("base64")});
  r=openLinux(f.linux); const status=await r.durable.status("unreceipted") as any; expect(status.status).toBe("expired"); expect(status.receipt).toBeUndefined(); expect(r.clientStore.get("client", "unreceipted")).toBeUndefined();
  const proof=r.clientStore.archived<any>("client-resolution","unreceipted-audit"); expect(proof.unknownReceipt).toBeNull(); expect(()=>verifyClientResolution(proof,"unreceipted-audit",callersFor(f.linux),f.mac.publicKey,f.operator.publicKey)).not.toThrow(); r.close();
});
