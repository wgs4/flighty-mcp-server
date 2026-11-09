import { afterEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runtimeFixture } from "./runtime-fixture.js";
import { provisionLinux, openLinux } from "../src/runtime/linux.js";
import { runtimeMode, readConfig } from "../src/runtime/config.js";
import { installToolSafety, sanitizeToolErrorMessage } from "../src/services/tool-safety.js";
import { getActiveReplicaLease } from "../src/replica/context.js";
import { IDS } from "./fixture/create.mjs";
import { trashFixture } from "./fixture/lifecycle.mjs";
import * as auth from "../src/services/auth-token.js";

const roots: string[] = [];
const runtimes: ReturnType<typeof openLinux>[] = [];
afterEach(() => { for (const r of runtimes.splice(0)) r.close(); for (const root of roots.splice(0)) trashFixture(root); vi.restoreAllMocks(); });
function setup() { const f = runtimeFixture(); roots.push(f.root); provisionLinux(f.linux); const r = openLinux(f.linux); runtimes.push(r); return { f, r }; }
function tool(r: ReturnType<typeof openLinux>, cb: () => Promise<unknown>, name = "flighty_list_flights") {
  let handler: () => Promise<any> = async () => {};
  const server = { registerTool(_n: string, _c: unknown, h: typeof handler) { handler = h; } };
  installToolSafety(server as any, r.db, { replicaReceiver: r.receiver, replicaBudget: r.config.budget });
  server.registerTool(name, { inputSchema: {} }, cb as any);
  return () => handler();
}
it("strict runtime selection and explicit private configuration fail closed", () => {
  expect(runtimeMode({})).toBe("local"); expect(runtimeMode({ FLIGHTY_RUNTIME_MODE: "replica" })).toBe("replica");
  for (const value of ["", "LOCAL", " remote", "replica ", "auto"]) expect(() => runtimeMode({ FLIGHTY_RUNTIME_MODE: value })).toThrow();
  expect(() => readConfig(undefined, "linux")).toThrow();
});
it("redacts Linux configured and arbitrary filesystem paths", () => {
  vi.stubEnv("FLIGHTY_DB_PATH", "/srv/flighty-private/source.db");
  const message = sanitizeToolErrorMessage("SQLite open failed at /srv/flighty-private/source.db and /opt/internal/cache.db");
  expect(message).not.toContain("/srv"); expect(message).not.toContain("/opt"); expect(message).toContain("redacted-path");
});
it("missing active cache is unavailable and about/error paths never call auth discovery", async () => {
  const { r } = setup(), discovery = vi.spyOn(auth, "readFlightyAuthToken");
  const result = await tool(r, async () => ({ content: [{ type: "text", text: JSON.stringify(r.db.listFlights()) }] }))();
  expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain("Replica unavailable");
  const about = await tool(r, async () => ({ content: [{ type: "text", text: '{"runtime":"replica"}' }] }), "flighty_about")();
  expect(about.isError).not.toBe(true); expect(discovery).not.toHaveBeenCalled();
});
it("signed zero-flight account remains available without credential/frequency fallback", async () => {
  const { f, r } = setup();
  const bundle = await f.bundle(1, db => db.exec("DELETE FROM UserFlight; DELETE FROM UserManualFlight; DELETE FROM Ticket; DELETE FROM Connection; DELETE FROM Profile;"));
  r.receiver.acceptBundle(bundle.bundleDir);
  const discovery = vi.spyOn(auth, "readFlightyAuthToken");
  const result = await tool(r, async () => ({ content: [{ type: "text", text: JSON.stringify({ flights: r.db.listFlights() }) }] }))();
  const body = JSON.parse(result.content[0].text);
  expect(body.flights).toEqual([]); expect(body.owner_identity.source).toBe("replica_producer");
  expect(body.owner_identity.user_id).toBe(IDS.owner); expect(body.replica.sequence).toBe(1); expect(discovery).not.toHaveBeenCalled();
});
it("one async invocation keeps its body, owner and safety freshness on the old generation after a swap", async () => {
  const { f, r } = setup();
  const one = await f.bundle(1), two = await f.bundle(2, db => db.prepare("UPDATE Flight SET departureGate='NEW-GATE' WHERE id=?").run(IDS.flight));
  r.receiver.acceptBundle(one.bundleDir);
  let resume!: () => void, entered!: () => void;
  const begun = new Promise<void>(resolve => entered = resolve), paused = new Promise<void>(resolve => resume = resolve);
  const invoke = tool(r, async () => {
    const first = r.db.getFlight({ flight_id: IDS.flight }); entered(); await paused;
    return { content: [{ type: "text", text: JSON.stringify({ first, after: r.db.getFlight({ flight_id: IDS.flight }), sequence: getActiveReplicaLease()!.sequence }) }] };
  });
  const pending = invoke(); await begun; r.receiver.acceptBundle(two.bundleDir); resume();
  const body = JSON.parse((await pending).content[0].text);
  expect(body.sequence).toBe(1); expect(body.replica.sequence).toBe(1); expect(body.owner_identity.provenance.sequence).toBe(1);
  expect(body.first.departure_gate).toBe(body.after.departure_gate); expect(body.after.departure_gate).not.toBe("NEW-GATE");
  const fresh = JSON.parse((await invoke()).content[0].text); expect(fresh.replica.sequence).toBe(2); expect(fresh.after.departure_gate).toBe("NEW-GATE");
});
it("copy timestamps do not turn a numeric source marker into verified sync", async () => {
  const { f, r } = setup(); const bundle = await f.bundle(1, db => db.exec("UPDATE SyncInfo SET lastSync=1800000000")); r.receiver.acceptBundle(bundle.bundleDir);
  const result = await tool(r, async () => ({ content: [{ type: "text", text: JSON.stringify({ flights: r.db.listFlights() }) }] }))();
  const body = JSON.parse(result.content[0].text);
  expect(body.replica.snapshot_age_seconds).toBeTypeOf("number"); expect(body.freshness.status).toBe("unknown");
  expect(body.replica.app_sync).toEqual(body.freshness); expect(body.freshness.unknown_reason_code).toBe("unverified_numeric_sync_format");
});
it("whole acceptance budget rejects before publication rather than multiplying per-task limits", async () => {
  const { f, r } = setup(); const bundle = await f.bundle();
  const { withSqliteBudget } = await import("../src/replica/work.js");
  expect(() => withSqliteBudget(1, 1, () => r.receiver.acceptBundle(bundle.bundleDir))).toThrow();
  expect(r.receiver.getStateSnapshot().highwaterSequence).toBe(0);
});

it("leased body and freshness fail closed if mount identity changes during an async invocation", async () => {
  const { f, r } = setup(); const bundle = await f.bundle(); r.receiver.acceptBundle(bundle.bundleDir);
  const lease = r.receiver.acquireLease(), inode = f.linux.storage.mountInode;
  try {
    f.linux.storage.mountInode = inode + 1;
    expect(() => lease.openDatabase()).toThrow(); expect(() => lease.computeFreshness()).toThrow();
  } finally { f.linux.storage.mountInode = inode; lease.release(); }
});
