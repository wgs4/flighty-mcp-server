import { randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";

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
import { generateConfirmCode, RemovalConfirmStore } from "../src/services/removal-confirm.js";
import { registerWriteTools } from "../src/tools/write.js";
import type { FlightyDatabase } from "../src/services/database.js";
import type { FlightyApi } from "../src/services/flighty-api.js";

const FLIGHT_A = "11111111-1111-4111-8111-111111111111";
const FLIGHT_B = "22222222-2222-4222-8222-222222222222";
const identity = {
  userId: "synthetic-owner",
  source: "jwt_subject" as const,
  label: "signed_in_owner" as const,
  isFallback: false,
  isSharedOwner: false,
};
function local(row: ReturnType<typeof flight> | null, record = "passenger") {
  return row ? { flight: row, record, identity } : null;
}
const CODE_ALPHABET = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};
type ToolHandler = (params: Record<string, string>) => Promise<ToolResult>;

function flight(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    flight_number: "194",
    airline_name: "United Airlines",
    airline_iata: "UA",
    departure_airport_iata: "EWR",
    departure_airport_name: "Newark",
    arrival_airport_iata: "SFO",
    arrival_airport_name: "San Francisco",
    booking_reference: "ABC123",
    seat_number: "12A",
    cabin_class: "economy",
    departureScheduleGateOriginal: "2026-06-15T12:00:00.000Z",
    ...patch,
  };
}

function capture(
  db: Partial<FlightyDatabase>,
  api: Partial<FlightyApi>,
  deps?: { removals?: RemovalConfirmStore; now?: () => number }
) {
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool(_name: string, _schema: unknown, handler: ToolHandler) {
      tools.set(_name, handler);
    },
  } as unknown as McpServer;
  registerWriteTools(server, db as FlightyDatabase, api as FlightyApi, deps);
  return tools.get("flighty_remove_flight")!;
}

function body(result: ToolResult) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe("confirm codes", () => {
  it("maps cryptographic bytes to a short code", () => {
    expect(generateConfirmCode(Buffer.alloc(8, 0))).toBe("AAAAAAAA");
    expect(generateConfirmCode(randomBytes(8))).toMatch(CODE_ALPHABET);
  });

  it("expires at five minutes, binds the preview, and stays bounded", () => {
    let now = 1_000_000;
    const store = new RemovalConfirmStore({ now: () => now });
    const preview = flight(FLIGHT_A);
    const issued = store.issue(FLIGHT_A, preview);
    expect(issued.expiresInSeconds).toBe(300);
    now += 5 * 60 * 1000 - 1;
    expect(store.consume(issued.code, FLIGHT_A, preview)).toEqual({ ok: true });

    const second = store.issue(FLIGHT_A, preview);
    now += 5 * 60 * 1000;
    expect(store.consume(second.code, FLIGHT_A, preview)).toEqual({
      ok: false,
      reason: "expired",
    });

    const changed = { ...preview, booking_reference: "CHANGED" };
    now = 2_000_000;
    const third = store.issue(FLIGHT_A, preview);
    expect(store.consume(third.code, FLIGHT_B, preview)).toEqual({
      ok: false,
      reason: "wrong-id",
    });
    expect(store.consume(third.code, FLIGHT_A, changed)).toEqual({
      ok: false,
      reason: "preview-changed",
    });
    expect(store.consume(third.code, FLIGHT_A, preview)).toEqual({
      ok: false,
      reason: "replay",
    });

    const many = new RemovalConfirmStore();
    const ids: string[] = [];
    const codes: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      const id = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
      ids.push(id);
      codes.push(many.issue(id, flight(id)).code);
    }
    expect(many.size).toBe(32);
    expect(many.consume(codes[0], ids[0], flight(ids[0]))).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(many.consume(codes[39], ids[39], flight(ids[39])).ok).toBe(true);
  });
});

describe("flighty_remove_flight", () => {
  it("previews the local flight and does not call the API or credential readers", async () => {
    const deleteFlight = vi.fn();
    const bytes = vi.fn((size: number) => Buffer.alloc(size, 3));
    const handler = capture(
      { getRemovalFlight: () => local(flight(FLIGHT_A)) },
      { deleteFlight, searchFlight: vi.fn(), subscribeFlight: vi.fn(), followFlight: vi.fn() },
      { removals: new RemovalConfirmStore({ randomBytes: bytes }) }
    );
    const result = await handler({ flight_id: FLIGHT_A });
    expect(result.isError).toBeUndefined();
    const preview = body(result);
    expect(preview.status).toBe("confirmation_required");
    expect(preview.flight_id).toBe(FLIGHT_A);
    expect(preview.confirm_code).toMatch(CODE_ALPHABET);
    expect(preview.expires_in_seconds).toBe(300);
    expect(preview.flight).toMatchObject({
      id: FLIGHT_A,
      booking_reference: "ABC123",
      seat_number: "12A",
      cabin_class: "economy",
      airline_name: "United Airlines",
    });
    expect(deleteFlight).not.toHaveBeenCalled();
    expect(bytes).toHaveBeenCalledWith(8);
    expect(readFlightyAuthToken).not.toHaveBeenCalled();
    expect(getFlightyBuildToken).not.toHaveBeenCalled();
  });

  it("previews an uncached UUID without calling the API or credential readers", async () => {
    const deleteFlight = vi.fn();
    const listFriendFlights = vi.fn(() => []);
    const bytes = vi.fn((size: number) => Buffer.alloc(size, 1));
    const handler = capture(
      { getRemovalFlight: () => null, listFriendFlights },
      { deleteFlight },
      { removals: new RemovalConfirmStore({ randomBytes: bytes }) }
    );
    const result = await handler({ flight_id: FLIGHT_A });
    expect(result.isError).toBeUndefined();
    const preview = body(result);
    expect(preview).toMatchObject({
      status: "confirmation_required",
      flight_id: FLIGHT_A,
      local_details: "unavailable",
      local_record: "none",
      local_identity: "unavailable",
      flight: {
        id: FLIGHT_A,
        local_details: "unavailable",
        local_identity: "unavailable",
      },
    });
    expect(String(preview.message)).toContain("Local details and local identity are unavailable");
    expect(String(preview.message)).toContain("Nothing was removed");
    expect(preview.confirm_code).toMatch(CODE_ALPHABET);
    expect(deleteFlight).not.toHaveBeenCalled();
    expect(bytes).toHaveBeenCalledWith(8);
    expect(readFlightyAuthToken).not.toHaveBeenCalled();
    expect(getFlightyBuildToken).not.toHaveBeenCalled();
    expect(listFriendFlights).not.toHaveBeenCalled();
  });

  it("deletes that exact uncached UUID after the matching code", async () => {
    const deleteFlight = vi.fn(async () => undefined);
    const handler = capture(
      { getRemovalFlight: () => null, listFriendFlights: () => [] },
      { deleteFlight }
    );
    const preview = body(await handler({ flight_id: FLIGHT_A }));
    const result = await handler({
      flight_id: FLIGHT_A,
      confirm_code: String(preview.confirm_code),
    });
    expect(body(result)).toMatchObject({ status: "removed", flight_id: FLIGHT_A });
    expect(deleteFlight).toHaveBeenCalledTimes(1);
    expect(deleteFlight).toHaveBeenCalledWith(FLIGHT_A);
    const replay = await handler({
      flight_id: FLIGHT_A,
      confirm_code: String(preview.confirm_code),
    });
    expect(replay.isError).toBe(true);
    expect(deleteFlight).toHaveBeenCalledTimes(1);
  });

  it("previews a followed flight when the passenger lookup misses", async () => {
    const followed = flight(FLIGHT_A, { booking_reference: "FOLLOW1", friend_name: null });
    const deleteFlight = vi.fn(async () => undefined);
    const listFriendFlights = vi.fn(() => [followed]);
    const handler = capture(
      { getRemovalFlight: () => local(followed, "followed"), listFriendFlights },
      { deleteFlight }
    );
    const preview = body(await handler({ flight_id: FLIGHT_A }));
    expect(preview).toMatchObject({
      local_details: "available",
      local_record: "followed",
      local_identity: "signed_in_owner",
      flight_id: FLIGHT_A,
    });
    expect(preview.flight).toMatchObject({
      id: FLIGHT_A,
      booking_reference: "FOLLOW1",
    });
    expect(deleteFlight).not.toHaveBeenCalled();
    const removed = await handler({
      flight_id: FLIGHT_A,
      confirm_code: String(preview.confirm_code),
    });
    expect(body(removed).status).toBe("removed");
    expect(deleteFlight).toHaveBeenCalledWith(FLIGHT_A);
    expect(listFriendFlights).not.toHaveBeenCalled();
  });

  it("does not use a named friend flight as local details", async () => {
    const friend = flight(FLIGHT_A, {
      booking_reference: "FRIEND9",
      friend_name: "Ada Lovelace",
    });
    const listFriendFlights = vi.fn(() => [friend]);
    const deleteFlight = vi.fn();
    const handler = capture(
      { getRemovalFlight: () => null, listFriendFlights },
      { deleteFlight }
    );
    const preview = body(await handler({ flight_id: FLIGHT_A }));
    expect(preview.local_details).toBe("unavailable");
    expect(JSON.stringify(preview)).not.toContain("FRIEND9");
    expect(JSON.stringify(preview)).not.toContain("Ada Lovelace");
    expect(deleteFlight).not.toHaveBeenCalled();
    expect(listFriendFlights).not.toHaveBeenCalled();
  });

  it("deletes only the canonical local id after the matching code", async () => {
    const requested = FLIGHT_A.toUpperCase();
    const stored = flight(FLIGHT_A);
    const deleteFlight = vi.fn(async () => undefined);
    const handler = capture(
      {
        getRemovalFlight: (id) => local(id === requested ? stored : null),
      },
      { deleteFlight }
    );
    const preview = body(await handler({ flight_id: requested }));
    const result = await handler({
      flight_id: requested,
      confirm_code: String(preview.confirm_code),
    });
    expect(result.isError).toBeUndefined();
    expect(body(result)).toMatchObject({ status: "removed", flight_id: FLIGHT_A });
    expect(deleteFlight).toHaveBeenCalledTimes(1);
    expect(deleteFlight).toHaveBeenCalledWith(FLIGHT_A);
  });

  it("rejects the wrong id, replay, expiry, and a changed preview", async () => {
    let now = 5_000;
    const row = flight(FLIGHT_A);
    const other = flight(FLIGHT_B);
    const deleteFlight = vi.fn(async () => undefined);
    const handler = capture(
      {
        getRemovalFlight: (id) => {
          if (id === FLIGHT_A) return local(row);
          if (id === FLIGHT_B) return local(other);
          return null;
        },
      },
      { deleteFlight },
      { removals: new RemovalConfirmStore({ now: () => now }) }
    );

    const preview = body(await handler({ flight_id: FLIGHT_A }));
    const code = String(preview.confirm_code);
    const wrong = await handler({ flight_id: FLIGHT_B, confirm_code: code });
    expect(wrong.isError).toBe(true);
    expect(wrong.content[0].text).toContain("does not match this flight");
    expect(deleteFlight).not.toHaveBeenCalled();

    row.booking_reference = "CHANGED";
    const changed = await handler({ flight_id: FLIGHT_A, confirm_code: code });
    expect(changed.isError).toBe(true);
    expect(changed.content[0].text).toContain("flight changed");
    expect(deleteFlight).not.toHaveBeenCalled();

    row.booking_reference = "ABC123";
    const fresh = body(await handler({ flight_id: FLIGHT_A }));
    now += 5 * 60 * 1000;
    const expired = await handler({
      flight_id: FLIGHT_A,
      confirm_code: String(fresh.confirm_code),
    });
    expect(expired.isError).toBe(true);
    expect(expired.content[0].text).toContain("expired");
    expect(deleteFlight).not.toHaveBeenCalled();

    now = 9_000;
    const again = body(await handler({ flight_id: FLIGHT_A }));
    const removed = await handler({
      flight_id: FLIGHT_A,
      confirm_code: String(again.confirm_code),
    });
    expect(removed.isError).toBeUndefined();
    const replay = await handler({
      flight_id: FLIGHT_A,
      confirm_code: String(again.confirm_code),
    });
    expect(replay.isError).toBe(true);
    expect(replay.content[0].text).toContain("already used");
    expect(deleteFlight).toHaveBeenCalledTimes(1);
  });

  it("consumes the code before the delete request returns", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const deleteFlight = vi.fn(async () => {
      calls += 1;
      await gate;
    });
    const handler = capture({ getRemovalFlight: () => local(flight(FLIGHT_A)) }, { deleteFlight });
    const preview = body(await handler({ flight_id: FLIGHT_A }));
    const params = { flight_id: FLIGHT_A, confirm_code: String(preview.confirm_code) };
    const first = handler(params);
    const second = await handler(params);
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain("already used");
    expect(calls).toBe(1);
    release();
    const done = await first;
    expect(done.isError).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("does not reuse a code when the delete fails", async () => {
    const deleteFlight = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("synthetic failure"))
      .mockResolvedValue(undefined);
    const handler = capture({ getRemovalFlight: () => local(flight(FLIGHT_A)) }, { deleteFlight });
    const preview = body(await handler({ flight_id: FLIGHT_A }));
    const params = { flight_id: FLIGHT_A, confirm_code: String(preview.confirm_code) };
    const failed = await handler(params);
    expect(failed.isError).toBe(true);
    const replay = await handler(params);
    expect(replay.isError).toBe(true);
    expect(replay.content[0].text).toContain("already used");
    expect(deleteFlight).toHaveBeenCalledTimes(1);
  });

  it("replaces the previous code for the same flight", async () => {
    const deleteFlight = vi.fn(async () => undefined);
    const handler = capture({ getRemovalFlight: () => local(flight(FLIGHT_A)) }, { deleteFlight });
    const first = body(await handler({ flight_id: FLIGHT_A }));
    const second = body(await handler({ flight_id: FLIGHT_A }));
    const stale = await handler({
      flight_id: FLIGHT_A,
      confirm_code: String(first.confirm_code),
    });
    expect(stale.isError).toBe(true);
    const removed = await handler({
      flight_id: FLIGHT_A,
      confirm_code: String(second.confirm_code),
    });
    expect(body(removed).status).toBe("removed");
    expect(deleteFlight).toHaveBeenCalledTimes(1);
  });
  it("does not expose arbitrary non-home-path exceptions from a deletion", async () => {
    const deleteFlight = vi.fn(async () => { throw new Error("/Volumes/SYNTHETIC/private.db confidential"); });
    const handler = capture({ getRemovalFlight: () => local(flight(FLIGHT_A)) }, { deleteFlight });
    const p = body(await handler({ flight_id: FLIGHT_A }));
    const failed = await handler({ flight_id: FLIGHT_A, confirm_code: String(p.confirm_code) });
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toBe("Error removing flight: The request failed.");
  });

});
