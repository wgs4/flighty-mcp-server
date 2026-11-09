import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { RETENTION_MS } from "../src/remote/state.js";
import { ProtocolError, verifyReceipt } from "../src/remote/protocol.js";
import { fixture, type Fixture } from "./remote-fixture.js";
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
