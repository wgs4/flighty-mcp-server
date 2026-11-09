import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/constants.js", () => ({
  AUTH_DB_PATH: "/synthetic/auth.sqlite",
  MAIN_DB_PATH: "/synthetic/main.db",
  PREFS_PLIST_PATH: "/synthetic/prefs.plist",
  FLIGHTY_API_BASE: "https://api.flightyapp.com",
  FLIGHTY_USER_AGENT: "synthetic-test-agent",
  getFlightyBuildToken: vi.fn(() => {
    throw new Error("default build-token reader should not run");
  }),
  FLIGHTY_BUILD_TOKEN: "",
}));

vi.mock("../src/services/auth-token.js", () => ({
  readFlightyAuthToken: vi.fn(() => {
    throw new Error("default auth reader should not run");
  }),
  readJwtSubject: vi.fn(() => null),
}));

vi.mock("../src/services/sync-token.js", () => ({
  readFlightySyncUrl: vi.fn(() => {
    throw new Error("default sync reader should not run");
  }),
}));

import { readFlightyAuthToken } from "../src/services/auth-token.js";
import { getFlightyBuildToken } from "../src/constants.js";
import {
  FlightyApi,
  MAX_SEARCH_BODY_BYTES,
  REQUEST_TIMEOUT_MS,
  type FlightyApiOptions,
} from "../src/services/flighty-api.js";
import { WritesDisabledError, type RuntimePolicy } from "../src/services/policy.js";

const AIRLINE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FLIGHT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const READ_ONLY: RuntimePolicy = { mode: "read-only", extraSyncHosts: new Set() };
const WRITES: RuntimePolicy = { mode: "read-write", extraSyncHosts: new Set() };

function harness(overrides: FlightyApiOptions = {}) {
  const events: string[] = [];
  const fetchImpl = vi.fn(async () => {
    events.push("fetch");
    return new Response(null, { status: 204 });
  });
  const api = new FlightyApi({
    policy: WRITES,
    fetchImpl,
    readAuthToken: () => {
      events.push("auth");
      return "synthetic-jwt";
    },
    readSyncUrl: () => {
      events.push("sync");
      return "https://sync.flightyapp.com/v1/full?q=synthetic-query-secret";
    },
    getBuildToken: () => {
      events.push("build");
      return "synthetic-build";
    },
    ...overrides,
  });
  return { api, events, fetchImpl };
}

describe("API write defense", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(readFlightyAuthToken).mockClear();
    vi.mocked(getFlightyBuildToken).mockClear();
  });

  it("blocks every mutation in read-only mode before credentials or the network", async () => {
    const { api, events, fetchImpl } = harness({ policy: READ_ONLY });
    await expect(api.searchFlight(AIRLINE, "194", "2026-06-15")).rejects.toBeInstanceOf(
      WritesDisabledError
    );
    await expect(api.subscribeFlight(FLIGHT)).rejects.toBeInstanceOf(WritesDisabledError);
    await expect(api.followFlight(FLIGHT)).rejects.toBeInstanceOf(WritesDisabledError);
    await expect(api.deleteFlight(FLIGHT)).rejects.toBeInstanceOf(WritesDisabledError);
    expect(events).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readFlightyAuthToken).not.toHaveBeenCalled();
    expect(getFlightyBuildToken).not.toHaveBeenCalled();
  });

  it("rejects a bad flight id before reading the sync URL or credentials", async () => {
    const { api, events, fetchImpl } = harness();
    await expect(api.deleteFlight("not-a-uuid")).rejects.toThrow(/Flight id must be a UUID/);
    expect(events).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects search input before credentials", async () => {
    const { api, events, fetchImpl } = harness();
    await expect(api.searchFlight("not-a-uuid", "194", "2026-06-15")).rejects.toThrow(
      /Airline id must be a UUID/
    );
    await expect(api.searchFlight(AIRLINE, "194", "2026-02-31")).rejects.toThrow(
      /calendar date/
    );
    await expect(api.searchFlight(AIRLINE, "123456", "2026-06-15")).rejects.toThrow(
      /Flight number/
    );
    expect(events).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not echo a remote error body", async () => {
    const { api } = harness({
      fetchImpl: vi.fn(async () => new Response("SECRET_BODY_DO_NOT_LEAK", { status: 500 })),
    });
    await expect(api.subscribeFlight(FLIGHT)).rejects.toThrow(
      "Flighty subscribe failed (HTTP 500)."
    );
  });

  it("stops reading an oversized search body", async () => {
    const body = new Uint8Array(MAX_SEARCH_BODY_BYTES + 32);
    body.fill(0x41);
    const { api } = harness({
      fetchImpl: vi.fn(async () => new Response(body, { status: 200 })),
    });
    await expect(api.searchFlight(AIRLINE, "194", "2026-06-15")).rejects.toThrow(
      /size limit/
    );
  });

  it("uses the bounded request timeout", async () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    const { api } = harness();
    await api.followFlight(FLIGHT);
    expect(spy.mock.calls.some((call) => call[1] === REQUEST_TIMEOUT_MS)).toBe(true);
    spy.mockRestore();
  });
  it.each(["stalled", "trickling"])("times out a %s body after immediate headers", async (mode) => {
    vi.useFakeTimers();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { source = controller; },
      cancel,
    });
    let signal!: AbortSignal;
    const { api } = harness({ fetchImpl: vi.fn(async (_url, init) => {
      signal = init!.signal!;
      return new Response(stream);
    }) });
    const result = api.searchFlight(AIRLINE, "194", "2026-06-15");
    const rejection = expect(result).rejects.toThrow(/^Flighty request timed out\.$/);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(signal.aborted).toBe(false);
    if (mode === "trickling") {
      source.enqueue(new TextEncoder().encode("tiny synthetic chunk"));
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(signal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds fetch even if the mocked transport ignores abort", async () => {
    vi.useFakeTimers();
    const { api } = harness({ fetchImpl: vi.fn(() => new Promise<Response>(() => {})) });
    const rejection = expect(api.deleteFlight(FLIGHT)).rejects.toThrow(/^Flighty request timed out\.$/);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["subscribe", "follow", "delete"])("bounds pending successful %s body cancellation", async (action) => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const { api } = harness({ fetchImpl: vi.fn(async () => new Response(new ReadableStream({ cancel }))) });
    const request = action === "subscribe" ? api.subscribeFlight(FLIGHT) :
      action === "follow" ? api.followFlight(FLIGHT) : api.deleteFlight(FLIGHT);
    const rejection = expect(request).rejects.toThrow(/^Flighty request timed out\.$/);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await rejection;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([302, 500, 200])("never waits for cancellation when rejecting HTTP/size %s", async (status) => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const { api } = harness({ fetchImpl: vi.fn(async () => new Response(new ReadableStream({ cancel }), {
      status,
      headers: status === 200 ? { "content-length": String(MAX_SEARCH_BODY_BYTES + 1) } : {},
    })) });
    await expect(api.searchFlight(AIRLINE, "194", "2026-06-15")).rejects.toThrow(
      status === 302 ? "Flighty refused to follow a redirect." :
      status === 500 ? "Flighty search failed (HTTP 500)." : "Flighty response exceeded the size limit."
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects streamed oversize data even if reader cancellation never settles", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(MAX_SEARCH_BODY_BYTES + 1)); },
      cancel,
    });
    const { api } = harness({ fetchImpl: vi.fn(async () => new Response(stream)) });
    await expect(api.searchFlight(AIRLINE, "194", "2026-06-15")).rejects.toThrow("Flighty response exceeded the size limit.");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

});
