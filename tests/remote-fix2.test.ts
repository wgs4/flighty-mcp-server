import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { executorStateValidator, RETENTION_MS } from "../src/remote/state.js";
import { ProtocolError, verifyReceipt, verifyRequest } from "../src/remote/protocol.js";
import { capturedApiFactory } from "../src/remote/executor.js";
import { sanitizeReceiptError } from "../src/remote/redaction.js";
import { fixture, FLIGHT, AIRLINE, type Fixture } from "./remote-fixture.js";
const fixtures: Fixture[] = [];
const setup = () => { const f = fixture(); fixtures.push(f); return f; };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const f of fixtures.splice(0)) f.close(); });
const add = { kind: "add", flight_code: "UA194", date: "2027-01-01" } as const;

describe("Q2 unresolved continuity before retention", () => {
  it.each(["restart", "maintenance"])("establishes a fence before aged interrupted dispatch cleanup: %s", async action => {
    const f = setup(), request = f.request(add);
    f.deps.boundary = name => { if (name === "response") throw new Error("interrupted accepted mutation"); };
    await expect(f.executor.submit(request)).rejects.toThrow("interrupted accepted mutation");
    f.deps.boundary = undefined; f.now = request.body.expiresAt + RETENTION_MS + 1;
    if (action === "restart") f.restart(); else f.executor.maintenance();
    expect(f.store.get<any>("fence", "synthetic-account").request.body.operationId).toBe(request.body.operationId);
    expect((await f.executor.submit(f.request(add))).body.state).toBe("failed");
    expect(f.api.subscribeFlight).toHaveBeenCalledTimes(1);
    await expect(f.executor.submit(request)).rejects.toThrow(/history.*retained|outcome unavailable/);
  });
  it("maintenance retains an active dispatch past retention while the exclusive execution still owns it", async () => {
    const f = setup(), request = f.request(add); let release!: () => void;
    f.api.subscribeFlight.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const first = f.executor.submit(request);
    await vi.waitFor(() => expect(f.api.subscribeFlight).toHaveBeenCalledTimes(1));
    f.now = request.body.expiresAt + RETENTION_MS + 1; f.executor.maintenance();
    expect(f.store.get<any>("operation", request.body.operationId).receipt.body.state).toBe("dispatched");
    const second = f.executor.submit(f.request(add));
    await new Promise(resolve => setTimeout(resolve, 5)); expect(f.api.searchFlight).toHaveBeenCalledTimes(1);
    release(); expect((await first).body.state).toBe("succeeded"); expect((await second).body.state).toBe("succeeded");
    expect(f.api.subscribeFlight).toHaveBeenCalledTimes(2);
  });
});

describe("Q3 aged history is unavailable, not certified non-dispatch", () => {
  it("does not replace a pruned successful receipt with a false signed failure", async () => {
    const f = setup(), request = f.request(add), original = await f.executor.submit(request);
    expect(verifyReceipt(original, f.mac.publicKey, request.body).state).toBe("succeeded");
    f.now = request.body.expiresAt + RETENTION_MS;
    await expect(f.executor.submit(request)).rejects.toThrow(/history.*retained|outcome unavailable/);
    expect(f.store.get("operation", request.body.operationId)).toBeUndefined();
    expect(f.api.subscribeFlight).toHaveBeenCalledTimes(1);
  });
  it("keeps signed recent terminal expiry for provably unexecuted work", async () => {
    const f = setup(), request = f.request(add); f.now = request.body.expiresAt + 1;
    const receipt = await f.executor.submit(request);
    expect(verifyReceipt(receipt, f.mac.publicKey, request.body).state).toBe("failed");
    expect(receipt.body.error).toContain("Nothing dispatched"); expect(f.api.searchFlight).not.toHaveBeenCalled();
  });
  it("rejects even an unseen authentic request beyond the available history window", async () => {
    const f = setup(), request = f.request(add); f.now = request.body.expiresAt + RETENTION_MS;
    await expect(f.executor.submit(request)).rejects.toThrow(ProtocolError); expect(f.api.searchFlight).not.toHaveBeenCalled();
  });
});

describe("Q6 authenticated reads and no-op publication", () => {
  it("validates an outside get/list once each, with no unchecked persistent read cache", () => {
    const f = setup(), validate = vi.spyOn(f.store as any, "validateSnapshot");
    expect(f.store.get("operation", "missing")).toBeUndefined(); expect(validate).toHaveBeenCalledTimes(1);
    expect(f.store.list("operation")).toEqual([]); expect(validate).toHaveBeenCalledTimes(2);
  });
  it("no-op maintenance/transactions do not advance revision or publish/fsync an anchor", () => {
    const f = setup(), path = f.storeOptions("mac").continuityPath, before = readFileSync(path, "utf8");
    const publish = vi.spyOn(f.store as any, "publishAnchor");
    f.executor.maintenance(); f.executor.maintenance(); f.store.transaction(() => {});
    expect(publish).not.toHaveBeenCalled(); expect(readFileSync(path, "utf8")).toBe(before);
  });
  it.each(["key", "account", "capability"])("does not reuse a warmed signature proof after retained trust %s changes", async change => {
    const f = setup(), req = f.request(add); await f.executor.submit(req);
    const validate = executorStateValidator(f.callers, f.mac.publicKey, () => f.now);
    const rows = f.store.list<any>("operation").map(row => ({ kind: "operation", ...row })); validate(rows);
    if (change === "key") (f.callers.linux as any).publicKey = f.other.publicKey;
    if (change === "account") (f.callers.linux as any).account = "different-account";
    if (change === "capability") (f.callers.linux as any).capabilities = ["follow"];
    if (change === "capability") { expect(() => validate(rows)).not.toThrow(); expect(() => verifyRequest(rows[0].value.request, f.callers, f.now)).toThrow(ProtocolError); }
    else expect(() => validate(rows)).toThrow(ProtocolError);
  });
  it("transaction views isolate mutable callers and exact no-op puts from authenticated state", async () => {
    const f = setup(), request = f.request(add); await f.executor.submit(request);
    const original = f.store.get<any>("operation", request.body.operationId), publish = vi.spyOn(f.store as any, "publishAnchor");
    f.store.put("operation", request.body.operationId, original); expect(publish).not.toHaveBeenCalled();
    f.store.transaction(() => {
      const copy = f.store.get<any>("operation", request.body.operationId); copy.receipt.body.state = "not-dispatched";
      expect(f.store.get<any>("operation", request.body.operationId).receipt.body.state).toBe("succeeded");
    });
    expect(f.executor.status(request)!.body.state).toBe("succeeded"); expect(publish).not.toHaveBeenCalled();
  });
});

const tick = async () => { for (let n = 0; n < 100; n++) await Promise.resolve(); };
describe("Q1 nonmutating failure versus active transport and mutation uncertainty", () => {
  it("settled captured search HTTP 503 does not durably fence normal writes across restart", async () => {
    const f = setup(); let searches = 0;
    const fetchImpl = vi.fn(async (url: unknown) => {
      if (String(url).endsWith("/search")) return ++searches === 1 ? new Response("temporary", { status: 503 }) : new Response(FLIGHT);
      return new Response(null, { status: 200 });
    });
    f.deps.createApi = capturedApiFactory({ policy: f.deps.policy, fetchImpl });
    expect((await f.executor.submit(f.request(add))).body.state).toBe("failed");
    await tick(); expect(f.store.get("fence", "synthetic-account")).toBeUndefined(); f.restart();
    expect((await f.executor.submit(f.request(add))).body.state).toBe("succeeded"); expect(searches).toBe(2);
  });
  it("settled snapshot failure is failed, and subsequent add works before and after restart", async () => {
    const f = setup(); vi.mocked(f.deps.requestSnapshot).mockRejectedValueOnce(new Error("temporary export read failure"));
    const failed = await f.executor.submit(f.request({ kind: "request-snapshot" }));
    expect(failed.body.state).toBe("failed"); expect(failed.body.error).not.toMatch(/outcome is unknown/);
    expect(f.store.get("fence", "synthetic-account")).toBeUndefined();
    expect((await f.executor.submit(f.request(add))).body.state).toBe("succeeded"); f.restart();
    expect((await f.executor.submit(f.request({ ...add, kind: "follow" }))).body.state).toBe("succeeded");
  });
  it.each(["dispatch", "response"] as const)("interrupted snapshot at %s recovers failed without a cloud fence or callback replay", async boundary => {
    const f = setup(), req = f.request({ kind: "request-snapshot" });
    f.deps.boundary = name => { if (name === boundary) throw new Error("snapshot interruption"); };
    await expect(f.executor.submit(req)).rejects.toThrow("snapshot interruption"); f.deps.boundary = undefined; f.restart();
    expect((await f.executor.submit(req)).body.state).toBe("failed"); expect(f.store.get("fence", "synthetic-account")).toBeUndefined();
    expect(f.deps.requestSnapshot).toHaveBeenCalledTimes(boundary === "dispatch" ? 0 : 1);
    expect((await f.executor.submit(f.request(add))).body.state).toBe("succeeded");
  });
  it("snapshot timeout holds the readonly resource only until actual callback settlement", async () => {
    const f = setup(); vi.useFakeTimers(); let settle!: () => void;
    vi.mocked(f.deps.requestSnapshot).mockImplementationOnce(() => new Promise(resolve => { settle = () => resolve({ snapshotId: "late-snapshot" }); }));
    const pending = f.executor.submit(f.request({ kind: "request-snapshot" })); await vi.advanceTimersByTimeAsync(15_001);
    expect((await pending).body.state).toBe("failed"); expect(f.store.get("fence", "synthetic-account")).toBeUndefined();
    expect(() => f.store.close()).toThrow(/active/);
    expect((await f.executor.submit(f.request(add))).body.state).toBe("failed"); expect(f.api.searchFlight).not.toHaveBeenCalled();
    settle(); await tick(); expect((await f.executor.submit(f.request(add))).body.state).toBe("succeeded");
  });
  it("an ignored-abort actual search stays fenced temporarily even after the inner API timeout settles", async () => {
    const f = setup(); vi.useFakeTimers(); let rejectFetch!: () => void, calls = 0;
    const fetchImpl = vi.fn((url: unknown) => {
      if (++calls === 1) return new Promise<Response>((_resolve, reject) => { rejectFetch = () => reject(new Error("actual fetch settled")); });
      return Promise.resolve(String(url).endsWith("/search") ? new Response(FLIGHT) : new Response(null, { status: 200 }));
    });
    f.deps.createApi = capturedApiFactory({ policy: f.deps.policy, fetchImpl });
    const first = f.executor.submit(f.request(add)); await vi.advanceTimersByTimeAsync(15_001);
    expect((await first).body.state).toBe("failed"); expect(() => f.store.close()).toThrow(/active/);
    expect((await f.executor.submit(f.request(add))).body.state).toBe("failed"); expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(f.store.get("fence", "synthetic-account")).toBeUndefined(); rejectFetch(); await tick();
    expect((await f.executor.submit(f.request(add))).body.state).toBe("succeeded"); expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it("does not release an aborted readonly response while actual body cancellation is unsettled", async () => {
    const f = setup(); vi.useFakeTimers(); let finishCancel!: () => void, calls = 0;
    const body = new ReadableStream<Uint8Array>({ cancel() { return new Promise<void>(resolve => { finishCancel = resolve; }); } });
    const fetchImpl = vi.fn(async (url: unknown) => {
      if (++calls === 1) return new Response(body);
      return String(url).endsWith("/search") ? new Response(FLIGHT) : new Response(null, { status: 200 });
    });
    f.deps.createApi = capturedApiFactory({ policy: f.deps.policy, fetchImpl });
    const first = f.executor.submit(f.request(add)); await vi.advanceTimersByTimeAsync(15_001);
    expect((await first).body.state).toBe("failed"); expect(typeof finishCancel).toBe("function");
    expect(() => f.store.close()).toThrow(/active/);
    expect((await f.executor.submit(f.request(add))).body.state).toBe("failed"); expect(fetchImpl).toHaveBeenCalledTimes(1);
    finishCancel(); await tick(); expect((await f.executor.submit(f.request(add))).body.state).toBe("succeeded");
    expect(f.store.get("fence", "synthetic-account")).toBeUndefined();
  });
  it("settled mutation rejection still retains unknown plus a durable fence", async () => {
    const f = setup(); f.api.subscribeFlight.mockRejectedValueOnce(new Error("HTTP outcome uncertain"));
    expect((await f.executor.submit(f.request(add))).body.state).toBe("unknown"); f.restart();
    expect((await f.executor.submit(f.request(add))).body.state).toBe("failed"); expect(f.api.subscribeFlight).toHaveBeenCalledTimes(1);
  });
});

describe("Q4 authorization at actual dispatch and remaining lifetime", () => {
  it.each(["add", "follow", "remove-confirm"] as const)("does not invoke expired %s after the dispatch boundary", async kind => {
    const f = setup(); let operation: any = { ...add, kind };
    if (kind === "remove-confirm") {
      const preview = await f.executor.submit(f.request({ kind: "remove-preview", flight_id: FLIGHT }));
      operation = { kind, flight_id: FLIGHT, confirm_code: (preview.body.result as any).confirm_code };
    }
    const req = f.request(operation);
    f.deps.boundary = name => { if (name === "dispatch") f.now = req.body.expiresAt + 1; };
    const result = await f.executor.submit(req);
    expect(result.body.state).toBe("failed"); expect(result.body.error).toContain("Nothing dispatched");
    expect(f.api.subscribeFlight).not.toHaveBeenCalled(); expect(f.api.followFlight).not.toHaveBeenCalled(); expect(f.api.deleteFlight).not.toHaveBeenCalled();
    expect(f.store.get("fence", "synthetic-account")).toBeUndefined();
    if (kind === "remove-confirm") expect(f.store.get<any>("preview", operation.confirm_code).consumed).toBe(true);
  });
  it.each(["add", "follow", "remove-confirm"] as const)("rechecks expiry after real anchor publication for %s, independently of the request/preview deadline", async kind => {
    const f = setup(); let operation: any = { ...add, kind }, expiry = f.now + 100;
    if (kind === "remove-confirm") {
      const previewReq = f.request({ kind: "remove-preview", flight_id: FLIGHT });
      const preview = await f.executor.submit(previewReq); expiry = previewReq.body.expiresAt; f.now = expiry - 100;
      operation = { kind, flight_id: FLIGHT, confirm_code: (preview.body.result as any).confirm_code };
    }
    const req = f.request(operation, kind === "remove-confirm" ? {} : { expiresAt: expiry });
    const original = (f.store as any).publishAnchor.bind(f.store);
    vi.spyOn(f.store as any, "publishAnchor").mockImplementation((...args: unknown[]) => {
      original(...args);
      if (f.store.get<any>("operation", req.body.operationId)?.receipt.body.state === "dispatched") f.now = expiry + 1;
    });
    const result = await f.executor.submit(req); expect(result.body.state).toBe("failed");
    if (kind === "remove-confirm") {
      expect(f.now).toBeLessThan(req.body.expiresAt); expect(f.store.get<any>("preview", operation.confirm_code).consumed).toBe(true);
    }
    expect(f.api.subscribeFlight).not.toHaveBeenCalled(); expect(f.api.followFlight).not.toHaveBeenCalled(); expect(f.api.deleteFlight).not.toHaveBeenCalled();
  });
  it("expiry during a slow synchronous API factory remains a truthful pre-invocation failure", async () => {
    const f = setup(), req = f.request(add);
    vi.mocked(f.deps.createApi).mockImplementation(() => { if (f.api.searchFlight.mock.calls.length) f.now = req.body.expiresAt + 1; return f.api; });
    const result = await f.executor.submit(req); expect(result.body.state).toBe("failed");
    expect(f.api.subscribeFlight).not.toHaveBeenCalled(); expect(f.store.get("fence", "synthetic-account")).toBeUndefined();
  });
  it.each(["credential", "record"])("revalidates current %s after publication before deletion", async change => {
    const f = setup(), local = f.local(); f.record = local;
    const preview = await f.executor.submit(f.request({ kind: "remove-preview", flight_id: FLIGHT }));
    const operation = { kind: "remove-confirm", flight_id: FLIGHT, confirm_code: (preview.body.result as any).confirm_code } as const;
    f.deps.boundary = name => {
      if (name === "dispatch") {
        if (change === "credential") f.context = { ...f.context!, authToken: "rotated-after-publication" };
        else f.record = { ...local, flight: { ...local.flight, seat_number: "changed-after-publication" } };
      }
    };
    expect((await f.executor.submit(f.request(operation))).body.state).toBe("failed");
    expect(f.api.deleteFlight).not.toHaveBeenCalled(); expect(f.store.get<any>("preview", operation.confirm_code).consumed).toBe(true);
  });
  it.each(["add", "follow", "remove-confirm"] as const)("caps %s's actual timer to the remaining authorization lifetime", async kind => {
    const f = setup(); vi.useFakeTimers(); let operation: any = { ...add, kind };
    if (kind === "remove-confirm") {
      const previewReq = f.request({ kind: "remove-preview", flight_id: FLIGHT });
      const preview = await f.executor.submit(previewReq); f.now = previewReq.body.expiresAt - 100;
      operation = { kind, flight_id: FLIGHT, confirm_code: (preview.body.result as any).confirm_code };
      f.api.deleteFlight.mockImplementationOnce(() => new Promise(() => {}));
    } else if (kind === "add") f.api.subscribeFlight.mockImplementationOnce(() => new Promise(() => {}));
    else f.api.followFlight.mockImplementationOnce(() => new Promise(() => {}));
    const req = f.request(operation, kind === "remove-confirm" ? {} : { expiresAt: f.now + 100 });
    const pending = f.executor.submit(req); await vi.advanceTimersByTimeAsync(101);
    expect((await pending).body.state).toBe("unknown"); expect(f.store.get("fence", "synthetic-account")).toBeDefined();
    expect(vi.mocked(f.deps.createApi).mock.calls.at(-1)![1].aborted).toBe(true);
  });
});

describe("Q5 collision-safe results and credential errors", () => {
  const collisionId = "bbbb4759-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  it.each(["4759", "r", "A"])("preserves protocol UUID/code/control fields and ordinary bookings with short session %s", async session => {
    const f = setup(); f.context = { ...f.context!, buildToken: "4759", session };
    const local = f.local(); local.flight.id = collisionId; local.flight.booking_reference = "4759-r-A"; f.record = local;
    const preview = await f.executor.submit(f.request({ kind: "remove-preview", flight_id: collisionId }));
    expect(preview.body.state).toBe("succeeded");
    const result = preview.body.result as any;
    expect(result.flight_id).toBe(collisionId); expect(result.flight.id).toBe(collisionId); expect(result.flight.booking_reference).toBe("4759-r-A");
    expect(result.confirm_code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/); expect(result.local_details).toBe("available");
    expect(f.store.get<any>("preview", result.confirm_code).consumed).toBe(false);
    expect((await f.executor.submit(f.request({ kind: "remove-confirm", flight_id: collisionId, confirm_code: result.confirm_code }))).body.state).toBe("succeeded");
    expect(f.api.deleteFlight).toHaveBeenCalledWith(collisionId);
  });
  it.each(["add", "follow"] as const)("preserves %s flight code/date/server UUID/public build digits", async kind => {
    const f = setup(); f.context = { ...f.context!, buildToken: "4759", session: "r" }; f.api.searchFlight.mockResolvedValue(collisionId);
    vi.mocked(f.db.lookupAirlines).mockReturnValue([{ id: AIRLINE, iata: "UA", name: "Synthetic Air 4759" }]);
    const result = (await f.executor.submit(f.request({ kind, flight_code: "UA4759", date: "2027-04-09" }))).body.result as any;
    expect(result.flight_code).toBe("UA4759"); expect(result.date).toBe("2027-04-09"); expect(result.server_flight_uuid).toBe(collisionId);
    expect(result.status).toBe(kind === "add" ? "added" : "followed"); expect(result.airline).toBe("Synthetic Air 4759");
  });
  it("still removes actual credentials injected into source text or a counterfeit booking value", async () => {
    const f = setup(), local = f.local(); local.flight.booking_reference = f.context!.authToken;
    local.flight.airline_name = f.context!.authToken; local.flight.arrival_weather = f.context!.syncUrl;
    f.record = local;
    const result = await f.executor.submit(f.request({ kind: "remove-preview", flight_id: FLIGHT }));
    expect(result.body.state).toBe("succeeded");
    expect(JSON.stringify(result)).not.toContain(f.context!.authToken); expect(JSON.stringify(result)).not.toContain(f.context!.syncUrl!);
  });
  it("redacts short actual session credentials in untrusted errors once without rewriting markers", async () => {
    expect(sanitizeReceiptError("secret r then abc", ["r", "abc"])).toBe("sec[redacted-secret]et [redacted-secret] then [redacted-secret]");
    const f = setup(); f.context = { ...f.context!, buildToken: "4759", session: "r" }; f.api.searchFlight.mockResolvedValue(null);
    vi.mocked(f.db.lookupAirlines).mockReturnValue([{ id: AIRLINE, iata: "UA", name: `session r ${f.context.authToken} ${f.context.syncUrl}` }]);
    const result = await f.executor.submit(f.request(add));
    expect(result.body.state).toBe("failed"); expect(result.body.error).toContain("[redacted-secret]");
    expect(result.body.error).not.toContain(f.context.authToken); expect(result.body.error).not.toContain(f.context.syncUrl!);
    expect(result.body.error).not.toContain("[redacted-sec[redacted-secret]et]");
  });
});
