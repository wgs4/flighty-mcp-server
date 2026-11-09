import { afterEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeFixture } from "./runtime-fixture.js";
import { checkMacSource, defaultMacReaders, macContextCapture, macDatabase, openMac, provisionMac, sequenceStoreOptions } from "../src/runtime/mac.js";
import { PrivateStore } from "../src/remote/store.js";
import { makeRequest } from "../src/remote/protocol.js";
import { loadRuntimePolicy } from "../src/services/policy.js";
import { IDS, SYNTHETIC_TOKEN } from "./fixture/create.mjs";
import { trashFixture } from "./fixture/lifecycle.mjs";
const roots: string[] = [];
const opened: ReturnType<typeof openMac>[] = [];
afterEach(() => { for (const m of opened.splice(0)) m.close(); for (const root of roots.splice(0)) trashFixture(root); vi.restoreAllMocks(); });
function setup() { const f = runtimeFixture(); roots.push(f.root); return f; }
const readers = () => ({ ...defaultMacReaders(), build: () => "4759" });
const signal = () => new AbortController().signal;
function request(f: ReturnType<typeof runtimeFixture>, operation: any, id = "operation") {
  const now = Date.now(); return makeRequest({ caller: "linux", account: IDS.owner, issuedAt: now, expiresAt: now + 300_000, operationId: id, operation }, f.caller.privateKey);
}
it("constructing capture never discovers defaults and every capture reads fresh build, JWT, sync and session", async () => {
  const f = setup(), readers = defaultMacReaders(); let build = "4759";
  const buildReader = vi.fn(() => build), token = vi.fn(readers.token), sync = vi.fn(readers.sync), session = vi.fn(readers.session);
  const capture = macContextCapture(f.macConfig, loadRuntimePolicy({}), { ...readers, build: buildReader, token, sync, session });
  expect(buildReader).not.toHaveBeenCalled(); expect(token).not.toHaveBeenCalled();
  const first = await capture(signal()); build = "4760"; const second = await capture(signal());
  expect(first?.account).toBe(IDS.owner); expect(second?.buildToken).toBe("4760"); expect(buildReader).toHaveBeenCalledTimes(2);
  expect(token).toHaveBeenNthCalledWith(1, f.fixture.mainPath, f.fixture.legacyPath); expect(sync).toHaveBeenCalledTimes(2); expect(session).toHaveBeenCalledTimes(2);
});
it("mount/source/private path checks reject before credential or build readers", async () => {
  const f = setup(), readers = { token: vi.fn(), subject: vi.fn(), sync: vi.fn(), build: vi.fn(), session: vi.fn() };
  f.macConfig.storage.mountInode += 1;
  const capture = macContextCapture(f.macConfig, loadRuntimePolicy({}), readers);
  await expect(capture(signal())).rejects.toThrow(); for (const call of Object.values(readers)) expect(call).not.toHaveBeenCalled();
});
it("a source replacement rejects instead of discovering another database", () => {
  const f = setup(); renameSync(f.fixture.mainPath, join(f.root, "retained-source"));
  writeFileSync(f.fixture.mainPath, "replacement", { mode: 0o600 }); expect(() => checkMacSource(f.macConfig)).toThrow();
});
it("all-candidate adapter preserves ambiguity and binds independently captured account", async () => {
  const f = setup(), context = await macContextCapture(f.macConfig, loadRuntimePolicy({}), readers())(signal());
  const db = new DatabaseSync(f.fixture.mainPath); db.prepare("INSERT INTO UserFlight SELECT * FROM UserFlight WHERE flightId=?").run(IDS.flight); db.close();
  const source = macDatabase(f.macConfig, context!); expect(source.removalCandidates(IDS.flight)).toHaveLength(2);
  expect(() => macDatabase(f.macConfig, { ...context!, account: IDS.friend })).toThrow(); source.close();
});
it("cacheless removal uses authoritative current context and the captured API without token output", async () => {
  const f = setup(); provisionMac(f.macConfig);
  const http = vi.fn(async (_url: unknown, init?: RequestInit) => { expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${SYNTHETIC_TOKEN}`); return new Response(null, { status: 200 }); });
  const m = openMac(f.macConfig, { readers: readers(), fetchImpl: http, upload: vi.fn() }); opened.push(m);
  const preview = await m.executor.submit(request(f, { kind: "remove-preview", flight_id: IDS.uncached }, "preview"));
  const result = preview.body.result as any; expect(result.local_details).toBe("unavailable"); expect(result.confirm_code).toHaveLength(8);
  const removed = await m.executor.submit(request(f, { kind: "remove-confirm", flight_id: IDS.uncached, confirm_code: result.confirm_code }, "confirm"));
  expect(removed.body.state).toBe("succeeded"); expect(http).toHaveBeenCalledTimes(1);
  expect(JSON.stringify([preview, removed])).not.toContain(SYNTHETIC_TOKEN);
  const replay = await m.executor.submit(request(f, { kind: "remove-confirm", flight_id: IDS.uncached, confirm_code: result.confirm_code }, "replay"));
  expect(replay.body.state).toBe("failed"); expect(http).toHaveBeenCalledTimes(1);
});
it("original runway guard in the composed adapter invalidates confirmation without mutation", async () => {
  const f = setup(); provisionMac(f.macConfig); const http = vi.fn();
  const m = openMac(f.macConfig, { readers: readers(), fetchImpl: http, upload: vi.fn() }); opened.push(m);
  const preview = await m.executor.submit(request(f, { kind: "remove-preview", flight_id: IDS.flight }, "preview"));
  const db = new DatabaseSync(f.fixture.mainPath); db.prepare("UPDATE Flight SET departureScheduleRunwayOriginal=departureScheduleGateOriginal+1 WHERE id=?").run(IDS.flight); db.close();
  const result = await m.executor.submit(request(f, { kind: "remove-confirm", flight_id: IDS.flight, confirm_code: (preview.body.result as any).confirm_code }, "confirm"));
  expect(result.body.state).toBe("failed"); expect(http).not.toHaveBeenCalled();
});
it("session rotation invalidates prepared confirmations in the actual adapter", async () => {
  const f = setup(); provisionMac(f.macConfig); const http = vi.fn();
  const m = openMac(f.macConfig, { readers: readers(), fetchImpl: http, upload: vi.fn() }); opened.push(m);
  const preview = await m.executor.submit(request(f, { kind: "remove-preview", flight_id: IDS.flight }, "preview"));
  writeFileSync(f.macConfig.source.sessionPath, "ROTATED-SYNTHETIC-SESSION", { mode: 0o600 });
  const result = await m.executor.submit(request(f, { kind: "remove-confirm", flight_id: IDS.flight, confirm_code: (preview.body.result as any).confirm_code }, "confirm"));
  expect(result.body.state).toBe("failed"); expect(http).not.toHaveBeenCalled();
});
it("snapshot sequences burn before failure, reopen without reuse, and upload only immutable allowlist bundle", async () => {
  const f = setup(); provisionMac(f.macConfig); let uploaded: string | undefined;
  let m = openMac(f.macConfig, { readers: readers(), fetchImpl: vi.fn(), upload: async () => { throw new Error("synthetic disconnect"); } });
  const context = await m.captureContext(signal()); await expect(m.snapshot(context!, signal())).rejects.toThrow(); m.close();
  m = openMac(f.macConfig, { readers: readers(), fetchImpl: vi.fn(), upload: async path => { uploaded = path; } }); opened.push(m);
  const copied = await m.snapshot((await m.captureContext(signal()))!, signal()); expect(copied.snapshotId).toMatch(/^[a-f0-9]{64}$/);
  expect(uploaded).toContain("copy-e1-s2");
  const bytes = readFileSync(join(uploaded!, "replica.db")); expect(bytes.includes(Buffer.from(SYNTHETIC_TOKEN))).toBe(false);
  m.close(); opened.splice(opened.indexOf(m), 1);
  const sequence = new PrivateStore(sequenceStoreOptions(f.macConfig)); expect(sequence.get("sequence", "producer")).toEqual({ next: 3 }); sequence.close();
});
it("read-only still permits copy requests and denies ordinary mutation in Mac policy", async () => {
  const f = setup(); provisionMac(f.macConfig); const http = vi.fn(), upload = vi.fn(async () => {});
  const m = openMac(f.macConfig, { readers: readers(), fetchImpl: http, upload, policy: loadRuntimePolicy({ FLIGHTY_READ_ONLY: "1" }) }); opened.push(m);
  const copy = await m.executor.submit(request(f, { kind: "request-snapshot" }, "copy")); expect(copy.body.state).toBe("succeeded"); expect(upload).toHaveBeenCalledTimes(1);
  await expect(m.executor.submit(request(f, { kind: "follow", flight_code: "ZZ101", date: "2026-11-11" }, "follow"))).rejects.toThrow(); expect(http).not.toHaveBeenCalled();
});
it("whole-cycle cancellation preserves UNKNOWN after an actual invoked mutation", async () => {
  const f = setup(); provisionMac(f.macConfig); const controller = new AbortController(); let invoked!: () => void;
  const entered = new Promise<void>(resolve => invoked = resolve);
  const http = vi.fn(async (_url: unknown, init?: RequestInit) => {
    invoked(); return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("synthetic abort")), { once: true }));
  });
  const m = openMac(f.macConfig, { readers: readers(), fetchImpl: http, upload: vi.fn(), signal: controller.signal }); opened.push(m);
  const preview = await m.executor.submit(request(f, { kind: "remove-preview", flight_id: IDS.uncached }, "preview"));
  const pending = m.executor.submit(request(f, { kind: "remove-confirm", flight_id: IDS.uncached, confirm_code: (preview.body.result as any).confirm_code }, "cancelled"));
  await entered; controller.abort(); const result = await pending;
  expect(result.body.state).toBe("unknown"); expect(http).toHaveBeenCalledTimes(1);
});
