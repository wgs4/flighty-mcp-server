import { afterEach, expect, it, vi } from "vitest";
import { sign } from "node:crypto";
import { readFileSync, renameSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runtimeFixture } from "./runtime-fixture.js";
import { openLinux, provisionLinux } from "../src/runtime/linux.js";
import { readConfig, validateConfig, privateKey, publicKey } from "../src/runtime/config.js";
import { openMac, provisionMac, macStoreOptions, defaultMacReaders } from "../src/runtime/mac.js";
import { PrivateStore } from "../src/remote/store.js";
import { Mailbox } from "../src/remote/mailbox.js";
import { boundedJson, canonical, digest, makeRequest, verifyReceipt, type Receipt, type Signed } from "../src/remote/protocol.js";
import { reconcileAccountFence, type Attestation } from "../src/remote/recovery.js";
import { loadRuntimePolicy } from "../src/services/policy.js";
import { IDS } from "./fixture/create.mjs";
import { trashFixture } from "./fixture/lifecycle.mjs";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) trashFixture(root); vi.restoreAllMocks(); });
function setup() { const f = runtimeFixture(); roots.push(f.root); return f; }
const readers = () => ({ ...defaultMacReaders(), build: () => "4759" });
it("durably remembers exact original requests, recovers status after restart, and separates caller/account records", async () => {
  const f = setup(); provisionLinux(f.linux); let r = openLinux(f.linux);
  const request = r.client.prepare({ kind: "follow", flight_code: "ZZ101", date: "2026-11-11" });
  await r.durable.remember(request); await r.client.submit(request);
  expect(r.clientStore.get<any>("client", request.body.operationId).request).toEqual(request);
  r.close(); r = openLinux(f.linux);
  expect((await r.durable.status(request.body.operationId) as any).status).toBe("pending");
  expect((await r.durable.status("unknown-id") as any).status).toBe("unavailable");
  expect(() => r.mailbox.handle({ role: "caller", caller: "another-caller" }, boundedJson({ verb: "status", request }))).toThrow();
  r.close();
});
it("retains authenticated receipt after a lost response and never issues a fresh operation ID", async () => {
  const f = setup(); provisionLinux(f.linux); provisionMac(f.macConfig);
  let r = openLinux(f.linux); const http = vi.fn(async () => new Response(null, { status: 200 }));
  const mac = openMac(f.macConfig, { readers: readers(), fetchImpl: http, upload: vi.fn() });
  const request = r.client.prepare({ kind: "remove-preview", flight_id: IDS.uncached }); await r.durable.remember(request); await r.client.submit(request);
  const receipt = await mac.executor.submit(request);
  r.mailbox.handle({ role: "mac" }, boundedJson({ verb: "receipt", receipt }));
  const status = await r.durable.status(request.body.operationId) as any;
  expect(status.status).toBe("succeeded"); expect(status.receipt.operationId).toBe(request.body.operationId);
  r.close(); r = openLinux(f.linux);
  expect((await r.durable.status(request.body.operationId) as any).receipt).toEqual(status.receipt);
  expect(http).not.toHaveBeenCalled(); r.close(); mac.close();
});
it("expired queued work receives an authenticated failure without opening source or dispatching", async () => {
  const f = setup(); provisionLinux(f.linux); provisionMac(f.macConfig); const r = openLinux(f.linux);
  const now = Date.now();
  const request = makeRequest({ caller: "linux", account: IDS.owner, operationId: "expired", issuedAt: now - 400_000, expiresAt: now - 100_000,
    operation: { kind: "follow", flight_code: "ZZ101", date: "2026-11-11" } }, f.caller.privateKey);
  const http = vi.fn(), token = vi.fn();
  const mac = openMac(f.macConfig, { readers: { ...readers(), token }, fetchImpl: http, upload: vi.fn() });
  const result = await mac.executor.submit(request); expect(verifyReceipt(result, f.mac.publicKey, request.body).state).toBe("failed"); expect(token).not.toHaveBeenCalled(); expect(http).not.toHaveBeenCalled();
  await r.durable.remember(request); expect((await r.durable.status("expired") as any).status).toBe("expired");
  r.close(); mac.close();
});
it("missing continuity never initializes during normal reopen", () => {
  const f = setup(); provisionLinux(f.linux); renameSync(f.linux.store.continuityPath, join(f.root, "retained-anchor"));
  expect(() => openLinux(f.linux)).toThrow(); expect(() => provisionLinux(f.linux)).toThrow();
});
it("malformed storage, overlapping paths, changed mount and account pins fail closed", () => {
  const f = setup(); expect(readConfig(f.configFile("linux"), "linux").kind).toBe("linux");
  for (const change of [ { inbox: f.linux.receiverRoot }, { pins: { ...f.linux.pins, accountId: IDS.friend } },
    { storage: { ...f.linux.storage, mountInode: f.linux.storage.mountInode + 1 } } ]) expect(() => validateConfig({ ...f.linux, ...change } as any)).toThrow();
  expect(() => readConfig(f.configFile("mac"), "linux")).toThrow();
});
it("Mac-local reconciliation requires bound independent operator attestation and keeps UNKNOWN historically", async () => {
  const f = setup(); provisionMac(f.macConfig); let calls = 0;
  let mac = openMac(f.macConfig, { readers: readers(), fetchImpl: vi.fn(async () => { calls++; throw new Error("synthetic lost HTTP response"); }), upload: vi.fn() });
  const request = (operation: any, operationId: string) => makeRequest({ caller: "linux", account: IDS.owner, issuedAt: Date.now(), expiresAt: Date.now() + 300_000, operationId, operation }, f.caller.privateKey);
  const preview = await mac.executor.submit(request({ kind: "remove-preview", flight_id: IDS.uncached }, "preview"));
  const original = request({ kind: "remove-confirm", flight_id: IDS.uncached, confirm_code: (preview.body.result as any).confirm_code }, "unknown");
  const receipt = await mac.executor.submit(original); expect(receipt.body.state).toBe("unknown"); mac.close();
  let store = new PrivateStore(macStoreOptions(f.macConfig));
  const fence = store.get<any>("fence", IDS.owner), now = Date.now();
  const body: Attestation = { version: 1, action: "clear-account-fence-after-external-check", account: IDS.owner,
    operationId: original.body.operationId, requestDigest: digest(original.body), fenceDigest: digest(fence), auditId: "audit-one", operator: "synthetic-operator",
    evidenceSha256: "a".repeat(64), statement: "External outcome checked; authorize future distinct operations; original outcome remains unknown; do not replay.", checkedAt: now, issuedAt: now, expiresAt: now + 300_000 };
  const attest = (value: Attestation, key = f.operator.privateKey) => ({ body: value, signature: sign(null, Buffer.from("flighty-operator-reconciliation-v1:" + canonical(value)), key).toString("base64") });
  const apply = (attestation: unknown) => reconcileAccountFence({ store, currentAccount: IDS.owner, operatorKey: f.operator.publicKey, attestation, now });
  expect(() => apply(attest(body, f.caller.privateKey))).toThrow();
  expect(() => apply(attest({ ...body, requestDigest: "b".repeat(64) }))).toThrow();
  expect(() => apply(attest({ ...body, expiresAt: now - 1 }))).toThrow();
  expect(store.get("fence", IDS.owner)).toEqual(fence);
  apply(attest(body)); expect(store.get("fence", IDS.owner)).toBeUndefined();
  expect(store.get<any>("operation", "unknown").receipt).toEqual(receipt); expect(() => apply(attest(body))).toThrow(); store.close();
  store = new PrivateStore(macStoreOptions(f.macConfig)); expect(store.get("reconciliation", "audit-one")).toBeTruthy(); store.close();
  mac = openMac(f.macConfig, { readers: readers(), fetchImpl: vi.fn(async () => { calls++; return new Response(null, { status: 200 }); }), upload: vi.fn() });
  expect(mac.executor.status(original)?.body.state).toBe("unknown"); expect((await mac.executor.submit(original)).body.state).toBe("unknown"); expect(calls).toBe(1);
  const later = await mac.executor.submit(request({ kind: "remove-preview", flight_id: IDS.flight }, "new-preview")); expect(later.body.state).toBe("succeeded");
  mac.close();
  const stateBytes = readFileSync(f.macConfig.store.path); expect(stateBytes.includes(Buffer.from("SYNTHETIC-PRIVATE-FIXTURE"))).toBe(false);
});

it("single owner quarantines interrupted incoming staging on restart without publication", () => {
  const f = setup(); provisionLinux(f.linux);
  const stage = join(f.linux.inbox, "incoming-11111111-1111-4111-8111-111111111111"); mkdirSync(stage, { mode: 0o700 });
  writeFileSync(join(stage, "manifest.json"), "partial", { mode: 0o600 });
  const r = openLinux(f.linux); expect(r.receiver.getStateSnapshot().highwaterSequence).toBe(0);
  expect(readdirSync(f.linux.inbox)).toEqual([]); expect(readdirSync(f.linux.quarantine)).toHaveLength(1); r.close();
});
it("a different configured account cannot reopen or serve the prior account's accepted cache", async () => {
  const f = setup(); provisionLinux(f.linux); const bundle = await f.bundle(); const r = openLinux(f.linux); r.receiver.acceptBundle(bundle.bundleDir); r.close();
  f.linux.pins = { ...f.linux.pins, accountId: IDS.friend, ownerUserId: IDS.friend }; f.linux.caller.account = IDS.friend;
  expect(() => openLinux(f.linux)).toThrow();
});
