import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { MacExecutor, capturedApiFactory } from "../src/remote/executor.js";
import { digest, makeRequest, seal, verifyReceipt } from "../src/remote/protocol.js";
import { loadRuntimePolicy } from "../src/services/policy.js";
import { fixture, FLIGHT, OTHER, AIRLINE, type Fixture } from "./remote-fixture.js";
const fixtures: Fixture[] = [];
const setup = () => { const f = fixture(); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
const add = { kind: "add", flight_code: "UA194", date: "2027-01-01" } as const;
const preview = async (f: Fixture) => {
  const r = await f.executor.submit(f.request({ kind: "remove-preview", flight_id: FLIGHT }));
  expect(r.body.state).toBe("succeeded");
  return r.body.result as { confirm_code: string; local_details: string; flight: unknown };
};

describe("authenticated Mac executor", () => {
  it("captures fresh providers for each search and mutation; concurrent identical IDs mutate once", async () => {
    const f = setup(), req = f.request(add);
    const receipts = await Promise.all(Array.from({ length: 12 }, () => f.executor.submit(req)));
    expect(f.api.subscribeFlight).toHaveBeenCalledTimes(1);
    expect(f.deps.createApi).toHaveBeenCalledTimes(2);
    expect(verifyReceipt(receipts.at(-1)!, f.mac.publicKey, req.body).state).toBe("succeeded");
    expect(f.store.list("operation")).toHaveLength(1);
    f.restart(); expect((await f.executor.submit(req)).body.state).toBe("succeeded");
    expect(f.api.subscribeFlight).toHaveBeenCalledTimes(1);
    const changed = f.request({ ...add, date: "2027-01-02" }, { operationId: req.body.operationId });
    await expect(f.executor.submit(changed)).rejects.toThrow(/conflict/);
  });
  it("keeps existing airline candidate search/disambiguation and follow behavior", async () => {
    const f = setup();
    vi.mocked(f.db.lookupAirlines).mockReturnValue([{ id: AIRLINE, iata: "UA", name: "First" }, { id: OTHER, iata: "UA", name: "Second" }]);
    f.api.searchFlight.mockResolvedValueOnce(null).mockResolvedValueOnce(FLIGHT);
    const result = await f.executor.submit(f.request({ ...add, kind: "follow" }));
    expect(result.body.state).toBe("succeeded");
    expect(f.api.searchFlight.mock.calls.map(c => c[0])).toEqual([AIRLINE, OTHER]);
    expect(f.api.followFlight).toHaveBeenCalledWith(FLIGHT);
    expect(f.deps.createApi).toHaveBeenCalledTimes(3);
  });
  it("serializes different mutations for an account", async () => {
    const f = setup(); let release!: () => void;
    f.api.subscribeFlight.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const first = f.executor.submit(f.request(add));
    await vi.waitFor(() => expect(f.api.subscribeFlight).toHaveBeenCalledTimes(1));
    const second = f.executor.submit(f.request(add));
    await new Promise(resolve => setTimeout(resolve, 5)); expect(f.api.searchFlight).toHaveBeenCalledTimes(1);
    release(); await Promise.all([first, second]); expect(f.api.subscribeFlight).toHaveBeenCalledTimes(2);
  });
  it.each([null, { account: "wrong" }, { session: "" }, { authToken: "" }])("rejects missing or changed credential authority before dispatch: %j", async change => {
    const f = setup(); f.context = change === null ? null : { ...f.context!, ...change };
    await expect(f.executor.submit(f.request(add))).rejects.toThrow(); expect(f.api.searchFlight).not.toHaveBeenCalled();
  });
  it.each(["authToken", "session", "account", "buildToken", "syncUrl"] as const)("rejects %s rotation between search and dispatch", async field => {
    const f = setup();
    f.api.searchFlight.mockImplementationOnce(async () => { f.context = { ...f.context!, [field]: "changed" }; return FLIGHT; });
    const result = await f.executor.submit(f.request(add));
    expect(result.body.state).toBe("failed"); expect(f.api.subscribeFlight).not.toHaveBeenCalled();
  });
  it("rejects token rotation between candidate searches", async () => {
    const f = setup(); vi.mocked(f.db.lookupAirlines).mockReturnValue([{ id: AIRLINE, iata: "UA", name: "First" }, { id: OTHER, iata: "UA", name: "Second" }]);
    f.api.searchFlight.mockImplementationOnce(async () => { f.context = { ...f.context!, authToken: "rotated" }; return null; });
    const r = await f.executor.submit(f.request(add)); expect(r.body.state).toBe("failed"); expect(f.api.searchFlight).toHaveBeenCalledTimes(1);
  });
  it("fails expired search before mutation, including wake", async () => {
    const f = setup(); f.api.searchFlight.mockImplementationOnce(async () => { f.now += 300_001; return FLIGHT; });
    expect((await f.executor.submit(f.request(add))).body.state).toBe("failed"); expect(f.api.subscribeFlight).not.toHaveBeenCalled();
  });
  it("revoking a caller during search blocks mutation", async () => {
    const f = setup(); f.api.searchFlight.mockImplementationOnce(async () => { (f.callers as Record<string, unknown>).linux = undefined; return FLIGHT; });
    expect((await f.executor.submit(f.request(add))).body.state).toBe("failed"); expect(f.api.subscribeFlight).not.toHaveBeenCalled();
  });
  it("supports honest unknown-details exact UUID removal through restart", async () => {
    const f = setup(), p = await preview(f); expect(p.local_details).toBe("unavailable");
    expect(p.flight).toEqual({ id: FLIGHT, local_details: "unavailable", local_identity: "unavailable" });
    f.restart(); const req = f.request({ kind: "remove-confirm", flight_id: FLIGHT, confirm_code: p.confirm_code });
    expect((await f.executor.submit(req)).body.state).toBe("succeeded");
    expect(f.api.deleteFlight).toHaveBeenCalledWith(FLIGHT);
    expect((await f.executor.submit(req)).body.state).toBe("succeeded");
    const replay = await f.executor.submit(f.request(req.body.operation)); expect(replay.body.state).toBe("failed");
    expect(f.api.deleteFlight).toHaveBeenCalledTimes(1);
  });
  it.each(["authToken", "session", "account", "buildToken", "syncUrl"] as const)("binds confirmation to private %s", async field => {
    const f = setup(), p = await preview(f); f.context = { ...f.context!, [field]: "rotated" };
    try { const r = await f.executor.submit(f.request({ kind: "remove-confirm", flight_id: FLIGHT, confirm_code: p.confirm_code })); expect(r.body.state).toBe("failed"); }
    catch { expect(field).toBe("account"); }
    expect(f.api.deleteFlight).not.toHaveBeenCalled();
  });
  it.each(["seat", "owner", "disappeared", "appeared"])("invalidates changed substantive local context: %s", async change => {
    const f = setup(), local = f.local(); if (change !== "appeared") f.record = local;
    const p = await preview(f);
    if (change === "seat") f.record = { ...local, flight: { ...local.flight, seat_number: "2B" } };
    if (change === "owner") f.record = { ...local, identity: { ...local.identity, userId: "other-account" } };
    if (change === "disappeared") f.record = null;
    if (change === "appeared") f.record = local;
    const r = await f.executor.submit(f.request({ kind: "remove-confirm", flight_id: FLIGHT, confirm_code: p.confirm_code }));
    expect(r.body.state).toBe("failed"); expect(f.api.deleteFlight).not.toHaveBeenCalled();
  });
  it("excludes volatile telemetry/copy times from removal binding", async () => {
    const f = setup(), local = f.local(); f.record = local; const p = await preview(f);
    f.record = { ...local, flight: { ...local.flight, arrival_weather: "updated weather", delay_forecast_mean_min: 3, queried_at: "new time" } as typeof local.flight };
    const r = await f.executor.submit(f.request({ kind: "remove-confirm", flight_id: FLIGHT, confirm_code: p.confirm_code }));
    expect(r.body.state).toBe("succeeded"); expect(f.api.deleteFlight).toHaveBeenCalledTimes(1);
  });
  it("rejects wrong caller/exact UUID and expired confirmation", async () => {
    const f = setup(), p = await preview(f);
    const wrongCaller = makeRequest({ operationId: "other-op", caller: "other", account: "synthetic-account", issuedAt: f.now, expiresAt: f.now + 300_000,
      operation: { kind: "remove-confirm", flight_id: FLIGHT, confirm_code: p.confirm_code } }, f.other.privateKey);
    expect((await f.executor.submit(wrongCaller)).body.state).toBe("failed");
    expect((await f.executor.submit(f.request({ kind: "remove-confirm", flight_id: OTHER, confirm_code: p.confirm_code }))).body.state).toBe("failed");
    f.now += 300_001;
    expect((await f.executor.submit(f.request({ kind: "remove-confirm", flight_id: FLIGHT, confirm_code: p.confirm_code }))).body.state).toBe("failed");
    expect(f.api.deleteFlight).not.toHaveBeenCalled();
  });
  it("rejects conflicting local rows instead of choosing an arbitrary passenger/followed record", async () => {
    const f = setup(), local = f.local();
    vi.mocked(f.deps.openDatabase).mockReturnValue({ db: f.db, close: () => {}, removalCandidates: () => [local, { ...local, record: "followed" }] });
    const r = await f.executor.submit(f.request({ kind: "remove-preview", flight_id: FLIGHT }));
    expect(r.body.state).toBe("failed"); expect(f.store.list("preview")).toHaveLength(0);
  });
  it("keeps unknown-details removal available when optional local lookup fails", async () => {
    const f = setup();
    vi.mocked(f.deps.openDatabase).mockReturnValue({ db: f.db, close: () => {}, removalCandidates: () => { throw new Error("synthetic unavailable details"); } });
    const p = await preview(f); expect(p.local_details).toBe("unavailable");
    expect((await f.executor.submit(f.request({ kind: "remove-confirm", flight_id: FLIGHT, confirm_code: p.confirm_code }))).body.state).toBe("succeeded");
  });
  it("observed token rotation permanently invalidates previews even if the old token returns", async () => {
    const f = setup(), original = f.context!, p = await preview(f);
    f.context = { ...original, authToken: "new-synthetic-token" };
    await f.executor.submit(f.request(add)); f.context = original;
    expect((await f.executor.submit(f.request({ kind: "remove-confirm", flight_id: FLIGHT, confirm_code: p.confirm_code }))).body.state).toBe("failed");
    expect(f.api.deleteFlight).not.toHaveBeenCalled();
  });
  it("caps optional removal previews and airline candidate scans", async () => {
    const f = setup();
    for (let i = 0; i < 32; i++) expect((await f.executor.submit(f.request({ kind: "remove-preview", flight_id: FLIGHT }))).body.state).toBe("succeeded");
    expect((await f.executor.submit(f.request({ kind: "remove-preview", flight_id: FLIGHT }))).body.state).toBe("failed");
    expect(f.store.list("preview")).toHaveLength(32);
    vi.mocked(f.db.lookupAirlines).mockReturnValue(Array.from({ length: 33 }, () => ({ id: AIRLINE, iata: "UA", name: "Synthetic" })));
    expect((await f.executor.submit(f.request(add))).body.state).toBe("failed"); expect(f.api.searchFlight).not.toHaveBeenCalled();
  });
  it("retains no raw credential or private fingerprint in public results", async () => {
    const f = setup(); await preview(f); await f.executor.submit(f.request(add));
    const bytes = readFileSync(f.dir + "/mac.sqlite").toString();
    expect(bytes).not.toContain("SYNTHETIC-LOGIN-SECRET"); expect(bytes).not.toContain("SYNTHETIC-BUILD-SECRET"); expect(bytes).not.toContain("SYNTHETIC-SYNC-SECRET");
    const rows = f.store.list<{ contextHash: string; receipt: unknown }>("operation");
    for (const { value } of rows) expect(JSON.stringify(value.receipt)).not.toContain(value.contextHash);
  });
  it("applies strict read-only policy before any source or API call", async () => {
    const f = setup(); f.deps.policy = loadRuntimePolicy({ FLIGHTY_READ_ONLY: "yes" });
    await expect(f.executor.submit(f.request(add))).rejects.toThrow(); expect(f.api.searchFlight).not.toHaveBeenCalled();
  });
  it("uses explicit source/mount checks and never substitutes another source", async () => {
    const f = setup(); vi.mocked(f.deps.checkSource).mockImplementation(() => { throw new Error("unmounted"); });
    await expect(f.executor.submit(f.request(add))).rejects.toThrow(); expect(f.deps.openDatabase).not.toHaveBeenCalled(); expect(f.api.searchFlight).not.toHaveBeenCalled();
  });
  it("snapshot callback receives current captured authority and returns only a snapshot ID", async () => {
    const f = setup(); const r = await f.executor.submit(f.request({ kind: "request-snapshot" }));
    expect(r.body.state).toBe("succeeded"); expect(r.body.result).toEqual({ status: "snapshot_requested", snapshot_id: "synthetic-snapshot" });
    expect(f.deps.requestSnapshot).toHaveBeenCalledWith(f.context); expect(f.api.subscribeFlight).not.toHaveBeenCalled();
  });
  it("fresh captured API never reads discovery and uses captured sync URL for deletion", async () => {
    const f = setup(); const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const factory = capturedApiFactory({ policy: loadRuntimePolicy({}), fetchImpl });
    await factory(f.context!).deleteFlight(FLIGHT);
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(fetchImpl.mock.calls[0][0]).toContain("SYNTHETIC-SYNC-SECRET");
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer SYNTHETIC-LOGIN-SECRET");
    const captured = f.context!; f.context = { ...captured, authToken: "new-synthetic-token" };
    await factory(f.context).subscribeFlight(FLIGHT); expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe("Bearer new-synthetic-token");
  });
});

describe("durable dispatch boundaries", () => {
  it.each(["queued", "dispatch", "response", "receipt"] as const)("restart at %s never blindly replays a mutation", async boundary => {
    const f = setup(), req = f.request(add);
    f.deps.boundary = name => { if (name === boundary) throw new Error("synthetic crash"); };
    await expect(f.executor.submit(req)).rejects.toThrow("synthetic crash");
    f.deps.boundary = undefined; f.restart(); await f.executor.drain();
    const r = f.executor.status(req)!;
    expect(r.body.state).toBe(boundary === "dispatch" || boundary === "response" ? "unknown" : "succeeded");
    expect(f.api.subscribeFlight).toHaveBeenCalledTimes(boundary === "dispatch" ? 0 : 1);
    await f.executor.submit(req); expect(f.api.subscribeFlight).toHaveBeenCalledTimes(boundary === "dispatch" ? 0 : 1);
  });
  it("queued work expiring during sleep never runs on wake", async () => {
    const f = setup(), req = f.request(add); f.deps.boundary = () => { throw new Error("sleep"); };
    await expect(f.executor.submit(req)).rejects.toThrow(); f.now += 300_001; f.deps.boundary = undefined;
    f.restart(); await f.executor.drain(); expect(f.executor.status(req)!.body.state).toBe("failed"); expect(f.api.searchFlight).not.toHaveBeenCalled();
  });
  it("crash after durable preview preserves the same one-use code", async () => {
    const f = setup(), req = f.request({ kind: "remove-preview", flight_id: FLIGHT });
    f.deps.boundary = name => { if (name === "preview") throw new Error("crash"); };
    await expect(f.executor.submit(req)).rejects.toThrow(); f.deps.boundary = undefined; f.restart();
    const p = (await f.executor.submit(req)).body.result as { confirm_code: string };
    expect((await f.executor.submit(f.request({ kind: "remove-confirm", flight_id: FLIGHT, confirm_code: p.confirm_code }))).body.state).toBe("succeeded");
  });
  it("consumes confirmation atomically with dispatch even when request never reaches API", async () => {
    const f = setup(), p = await preview(f);
    f.deps.boundary = name => { if (name === "dispatch") throw new Error("crash"); };
    const req = f.request({ kind: "remove-confirm", flight_id: FLIGHT, confirm_code: p.confirm_code });
    await expect(f.executor.submit(req)).rejects.toThrow(); f.deps.boundary = undefined; f.restart();
    expect(f.executor.status(req)!.body.state).toBe("unknown");
    expect((await f.executor.submit(f.request(req.body.operation))).body.state).toBe("failed"); expect(f.api.deleteFlight).not.toHaveBeenCalled();
  });
  it("lost API response stays unknown despite a missing cached row", async () => {
    const f = setup(); f.api.subscribeFlight.mockRejectedValueOnce(new Error("lost reply SYNTHETIC-LOGIN-SECRET"));
    const req = f.request(add), r = await f.executor.submit(req); expect(r.body.state).toBe("unknown"); expect(JSON.stringify(r)).not.toContain("SYNTHETIC-LOGIN-SECRET");
    f.restart(); await f.executor.drain(); await f.executor.submit(req); expect(f.api.subscribeFlight).toHaveBeenCalledTimes(1);
  });
  it("persistence failure before dispatch prevents API call", async () => {
    const f = setup(); const original = f.store.put.bind(f.store);
    vi.spyOn(f.store, "put").mockImplementation((kind, id, value: any) => { if (value?.receipt?.body?.state === "dispatched") throw new Error("disk full"); return original(kind, id, value); });
    expect((await f.executor.submit(f.request(add))).body.state).toBe("failed"); expect(f.api.subscribeFlight).not.toHaveBeenCalled();
  });
});
