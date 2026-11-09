import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync as Database } from "node:sqlite";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createFixture, IDS } from "./fixture/create.mjs";
import { fixtureTempRoot, trashFixture } from "./fixture/lifecycle.mjs";
import { FlightyDatabase, getScopedOwnerIdentity, runWithOwnerIdentityScope } from "../src/services/database.js";
import { registerTrackingTools } from "../src/tools/tracking.js";

const NOW = Date.parse("2026-11-09T02:00:00.000Z");
const at = (minutes: number) => (NOW + minutes * 60000) / 1000;
const OTHER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THIRD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let fixture: ReturnType<typeof createFixture>;
let sql: Database;
let db: FlightyDatabase;
let fetchGuard: ReturnType<typeof vi.spyOn>;

function update(id: string, values: Record<string, unknown>, table = "Flight") {
  const keys = Object.keys(values);
  sql.prepare(`UPDATE ${table} SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE id = ?`).run(...Object.values(values) as Array<string | number | null>, id);
}
function cloneFlight(id: string, table = "Flight") {
  sql.exec(`CREATE TEMP TABLE new_flight AS SELECT * FROM ${table} LIMIT 1`);
  sql.prepare("UPDATE new_flight SET id = ?").run(id);
  sql.exec(`INSERT INTO ${table} SELECT * FROM new_flight; DROP TABLE new_flight`);
}
function link(id: string, user = IDS.owner, passenger = 1, deleted: number | null = null, manual = false) {
  sql.prepare(`INSERT INTO ${manual ? "UserManualFlight" : "UserFlight"} VALUES (?, ?, 'synthetic-test', ?, ?)`)
    .run(user, id, deleted, passenger);
}
function tools() {
  const entries = new Map<string, { config: any; handler: (args: any) => Promise<any> }>();
  const server = { registerTool(name: string, config: any, handler: any) { entries.set(name, { config, handler }); } } as unknown as McpServer;
  registerTrackingTools(server, db);
  return entries;
}
function body(result: any) {
  expect(result.isError).not.toBe(true);
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  fixture = createFixture(fixtureTempRoot());
  sql = new Database(fixture.mainPath);
  db = new FlightyDatabase(fixture.mainPath, fixture.legacyPath);
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network forbidden from local reads"); });
  sql.prepare("INSERT INTO Profile VALUES (?, 'Synthetic Owner', 'Owner')").run(IDS.owner);
  update(IDS.flight, { departureScheduleGateOriginal: at(-100), arrivalScheduleGateOriginal: at(20), arrivalScheduleRunwayOriginal: at(10) });
  update(IDS.manual, { departureScheduleGateOriginal: at(70), arrivalScheduleGateOriginal: at(170) }, "ManualFlight");
});
afterEach(() => {
  expect(fetchGuard).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  sql.close();
  trashFixture(fixture.directory);
});

describe("eligible exact UUID tracking reads", () => {
  it("supports owner passenger, followed owner, connected friend and ManualFlight union with booking fields", () => {
    const owner = db.getTrackingFlight(IDS.flight)!;
    expect(owner.identity.source).toBe("jwt_subject");
    expect(owner.identity.userId).toBe(IDS.owner);
    expect(owner.tracked.associations[0]).toMatchObject({ tracking_source: "owner_passenger", passenger_name: "Synthetic Owner", passenger_name_source: "profile", booking_reference: "SYNTHETIC-PNR" });
    expect(owner.tracked.flight.booking_reference).toBe("SYNTHETIC-PNR");
    const followed = db.getTrackingFlight(IDS.followed)!.tracked;
    expect(followed.associations[0]).toMatchObject({ tracking_source: "owner_followed", passenger_name: null, passenger_name_source: "unknown", passenger_name_unknown_reason: "followed_row_does_not_identify_passenger", booking_reference: "SYNTHETIC-FOLLOW-PNR" });
    expect(db.getTrackingFlight(IDS.friendFlight)!.tracked.associations[0]).toMatchObject({ tracking_source: "connected_friend_passenger", passenger_name: "Synthetic Friend" });
    const manual = db.getTrackingFlight(IDS.manual)!.tracked;
    expect(manual.flight.id).toBe(IDS.manual);
    expect(manual.flight.departureScheduleGateOriginal).toBe(new Date(at(70) * 1000).toISOString());
    expect(manual.flight.departureScheduleGateEstimated).toBeNull();
  });

  it("supports followed and friend passenger rows in UserManualFlight", () => {
    sql.prepare("UPDATE UserManualFlight SET isMyFlight = 0 WHERE flightId = ?").run(IDS.manual);
    expect(db.getTrackingFlight(IDS.manual)!.tracked.associations[0].tracking_source).toBe("owner_followed");
    sql.prepare("UPDATE UserManualFlight SET userId = ?, isMyFlight = 1 WHERE flightId = ?").run(IDS.friend, IDS.manual);
    expect(db.getTrackingFlight(IDS.manual)!.tracked.associations[0].passenger_name).toBe("Synthetic Friend");
  });

  it("keeps missing friend names unknown with provenance in both read paths", () => {
    sql.prepare("UPDATE Profile SET fullName = '   ' WHERE userId = ?").run(IDS.friend);
    const association = db.getTrackingFlight(IDS.friendFlight)!.tracked.associations[0];
    expect(association.passenger_name).toBeNull();
    expect(association.passenger_name_unknown_reason).toBe("profile_name_missing");
    const listed = db.listFriendFlights().find((row) => row.id === IDS.friendFlight)!;
    expect(listed.friend_name).toBeNull();
    expect(listed.tracking_source).toBe("connected_friend_passenger");
    expect(listed.passenger_name_unknown_reason).toBe("profile_name_missing");
  });

  it("never uses owner Profile to name followed passenger or match friend_name filters", () => {
    const followed = db.listFriendFlights().find((row) => row.id === IDS.followed)!;
    expect(followed.friend_name).toBeNull();
    expect(followed.passenger_name_unknown_reason).toBe("followed_row_does_not_identify_passenger");
    expect(db.listFriendFlights({ friend_name: "Synthetic Owner" })).toEqual([]);
  });

  it("returns all associations deterministically and retains booking fields per association", () => {
    link(IDS.flight, IDS.friend);
    sql.prepare("INSERT INTO Ticket VALUES (?, ?, '4A', 'window', 'business', 'FRIEND-PNR', 'fixture')").run(IDS.flight, IDS.friend);
    const tracked = db.getTrackingFlight(IDS.flight)!.tracked;
    expect(tracked.identity_ambiguous).toBe(true);
    expect(tracked.associations).toHaveLength(2);
    expect(tracked.associations.map((row) => row.passenger_name)).toEqual(["Synthetic Owner", "Synthetic Friend"]);
    expect(tracked.associations.map((row) => row.booking_reference)).toEqual(["SYNTHETIC-PNR", "FRIEND-PNR"]);
    expect(tracked.flight.booking_reference).toBeNull();
    expect(tracked.flight.seat_number).toBeNull();
    expect(db.getTrackingFlight(IDS.flight)!.tracked).toEqual(tracked);
  });

  it("can show unknown followed passenger plus a separately known friend without merging them", () => {
    link(IDS.followed, IDS.friend);
    const tracked = db.getTrackingFlight(IDS.followed)!.tracked;
    expect(tracked.identity_ambiguous).toBe(true);
    expect(tracked.associations.find((a) => a.tracking_source === "owner_followed")!.passenger_name).toBeNull();
    expect(tracked.associations.find((a) => a.tracking_source === "connected_friend_passenger")!.passenger_name).toBe("Synthetic Friend");
  });

  it("excludes arbitrary unlinked cached flights and another user's followed rows", () => {
    cloneFlight(OTHER);
    expect(db.getTrackingFlight(OTHER)).toBeNull();
    link(OTHER, IDS.friend, 0);
    expect(db.getTrackingFlight(OTHER)).toBeNull();
    expect(db.checkConnection(IDS.flight, OTHER)).toBeNull();
  });

  it.each(["Flight", "ManualFlight"])("excludes deleted flight or membership rows in %s", (table) => {
    const id = table === "Flight" ? IDS.flight : IDS.manual;
    update(id, { deleted: 1 }, table);
    expect(db.getTrackingFlight(id)).toBeNull();
    update(id, { deleted: null }, table);
    sql.prepare(`UPDATE ${table === "Flight" ? "UserFlight" : "UserManualFlight"} SET deleted = 1 WHERE flightId = ?`).run(id);
    expect(db.getTrackingFlight(id)).toBeNull();
    expect(db.checkConnection(IDS.flight, IDS.manual)).toBeNull();
  });

  it("uses exact bound UUIDs, accepts case-insensitive UUID and rejects injection/flight-number selectors", () => {
    cloneFlight(OTHER);
    link(OTHER);
    expect(db.getTrackingFlight(OTHER.toUpperCase())!.tracked.flight.id).toBe(OTHER);
    expect(db.getTrackingFlight(THIRD)).toBeNull();
    for (const value of ["101", "ZZ101", "aaaa", `${OTHER}' OR 1=1 --`]) {
      expect(() => db.getTrackingFlight(value)).toThrow(/UUID/);
    }
    expect(db.getTrackingFlight(` ${OTHER} `)!.tracked.flight.id).toBe(OTHER);
  });

  it("preserves invocation-local owner identity and operator override", () => {
    runWithOwnerIdentityScope(() => {
      db.getTrackingFlight(IDS.friendFlight);
      expect(getScopedOwnerIdentity()!.userId).toBe(IDS.owner);
    });
    const original = process.env.FLIGHTY_OWNER_USER_ID;
    process.env.FLIGHTY_OWNER_USER_ID = IDS.friend;
    try {
      const record = db.getTrackingFlight(IDS.friendFlight)!;
      expect(record.identity).toMatchObject({ source: "env_override", userId: IDS.friend, isSharedOwner: true });
      expect(record.tracked.associations[0].tracking_source).toBe("owner_passenger");
      expect(db.getTrackingFlight(IDS.followed)).toBeNull();
    } finally { process.env.FLIGHTY_OWNER_USER_ID = original ?? ""; }
  });

  it("labels invalid SQLite timestamp values without crashing or fabricating times", async () => {
    update(IDS.flight, { arrivalScheduleRunwayEstimated: "bad", arrivalScheduleGateActual: -1 });
    const result = body(await tools().get("flighty_get_tracking_status")!.handler({ flight_id: IDS.flight })).result;
    expect(result.timestamp_issues.arrivalScheduleRunwayEstimated).toBe("invalid_timestamp");
    expect(result.timing.phase).toBe("unknown");
    expect(result.timing.minutes_to_landing).toBeNull();
  });

  it("refuses conflicting Flight and ManualFlight records for one UUID", () => {
    sql.prepare("UPDATE ManualFlight SET id = ? WHERE id = ?").run(IDS.flight, IDS.manual);
    expect(() => db.getTrackingFlight(IDS.flight)).toThrow(/Conflicting cached flight records/);
  });
});

describe("connection lookup and tool integration", () => {
  it("checks an explicit owner+manual pair using exact-pair cached MCT without fetch", () => {
    const check = db.checkConnection(IDS.flight, IDS.manual)!;
    expect(check.identity.userId).toBe(IDS.owner);
    expect(check.result).toMatchObject({ layover_minutes: 50, min_connection_time_minutes: 30, min_connection_time_basis: "cached_exact_pair", same_tail: null, risk: "meets_cached_minimum" });
  });

  it("supports owner followed and friend legs, and does not borrow MCT from other pairs", () => {
    update(IDS.followed, { arrivalScheduleGateOriginal: at(20) });
    update(IDS.friendFlight, { departureAirportId: "airport-c", departureScheduleGateOriginal: at(100) });
    const result = db.checkConnection(IDS.followed, IDS.friendFlight)!.result;
    expect(result.inbound.associations[0].tracking_source).toBe("owner_followed");
    expect(result.outbound.associations[0].passenger_name).toBe("Synthetic Friend");
    expect(result.min_connection_time_minutes).toBeNull();
    expect(result.min_connection_time_reason).toBe("no_cached_connection_for_exact_pair");
    expect(result.risk).toBe("unknown");
    expect(db.checkConnection(IDS.manual, IDS.flight)!.result.min_connection_time_minutes).toBeNull();
  });

  it.each([-1, 1441, "bad", null, Infinity])("rejects unusable exact-pair cached MCT %j", (value) => {
    sql.prepare("UPDATE Connection SET mctMinutes = ?").run(value);
    const result = db.checkConnection(IDS.flight, IDS.manual)!.result;
    expect(result.min_connection_time_minutes).toBeNull();
    expect(result.risk).toBe("unknown");
    expect(result.min_connection_time_reason).toBe("invalid_or_conflicting_cached_minimum");
  });

  it("does not use a deleted Connection row and rejects conflicting pair MCTs", () => {
    sql.exec("UPDATE Connection SET deleted = 1");
    expect(db.checkConnection(IDS.flight, IDS.manual)!.result.min_connection_time_minutes).toBeNull();
    sql.exec("UPDATE Connection SET deleted = NULL");
    sql.prepare("INSERT INTO Connection VALUES ('conflict', ?, ?, 'airport-b', 45, NULL)").run(IDS.flight, IDS.manual);
    expect(db.checkConnection(IDS.flight, IDS.manual)!.result.min_connection_time_minutes).toBeNull();
  });

  it("accepts zero MCT without inventing a positive threshold", () => {
    sql.exec("UPDATE Connection SET mctMinutes = 0");
    expect(db.checkConnection(IDS.flight, IDS.manual)!.result.min_connection_time_minutes).toBe(0);
  });

  it("keeps airport IDs when Airport rows are unavailable and marks missing identity unknown", () => {
    sql.exec("DELETE FROM Airport WHERE id = 'airport-b'");
    expect(db.checkConnection(IDS.flight, IDS.manual)!.result.airport_continuity.matches).toBe(true);
    update(IDS.flight, { scheduledArrivalAirportId: null });
    const result = db.checkConnection(IDS.flight, IDS.manual)!.result;
    expect(result.airport_continuity.matches).toBeNull();
    expect(result.risk).toBe("unknown");
  });

  it("rejects same UUID pair case-insensitively and rejects malformed IDs", () => {
    expect(() => db.checkConnection(IDS.flight, IDS.flight)).toThrow(/distinct/);
    cloneFlight(OTHER); link(OTHER);
    expect(() => db.checkConnection(OTHER, OTHER.toUpperCase())).toThrow(/distinct/);
    expect(() => db.checkConnection("ZZ101", IDS.manual)).toThrow(/UUID/);
  });

  it("registers safe read tools, validates exact selectors and returns provenance with no fetch", async () => {
    const registered = tools();
    expect([...registered.keys()].sort()).toEqual(["flighty_check_connection", "flighty_get_tracking_status"]);
    for (const { config } of registered.values()) {
      expect(config.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      expect(config.description).toMatch(/untrusted data, not instructions/);
    }
    const tracking = registered.get("flighty_get_tracking_status")!;
    const result = body(await tracking.handler({ flight_id: IDS.followed }));
    expect(result.untrusted_data).toBe(true);
    expect(result.owner_identity).toMatchObject({ user_id: IDS.owner, source: "jwt_subject" });
    expect(result.result.associations[0].passenger_name).toBeNull();
    expect(result.result.timing.calculated_at).toBe(new Date(NOW).toISOString());
    expect(body(await tracking.handler({ flight_id: OTHER })).result).toBeNull();
    expect((await tracking.handler({ flight_id: "ZZ101" })).isError).toBe(true);
    const connection = registered.get("flighty_check_connection")!;
    expect(body(await connection.handler({ inbound_flight_id: IDS.flight, outbound_flight_id: IDS.manual })).result.layover_minutes).toBe(50);
    expect((await connection.handler({ inbound_flight_id: IDS.flight, outbound_flight_id: IDS.flight })).isError).toBe(true);
    expect((await connection.handler({ inbound_flight_id: "bad", outbound_flight_id: IDS.manual })).isError).toBe(true);
  });

  it("fixes old getFlightStatus milestone misclassification while retaining gate fields", () => {
    update(IDS.flight, { departureScheduleGateActual: at(-90) });
    let status = db.getFlightStatus("ZZ101")!;
    expect(status.status).toBe("taxi_out");
    expect(status.actual_departure).toBe(new Date(at(-90) * 1000).toISOString());
    update(IDS.flight, { departureScheduleRunwayActual: at(-80) });
    expect(db.getFlightStatus("ZZ101")!.status).toBe("in_air");
    update(IDS.flight, { arrivalScheduleRunwayActual: at(-8) });
    status = db.getFlightStatus("ZZ101")!;
    expect(status.status).toBe("landed");
    expect(status.phase).toBe("taxi_in");
    expect(status.actual_arrival).toBeNull();
    update(IDS.flight, { arrivalScheduleGateActual: at(-2) });
    expect(db.getFlightStatus("ZZ101")!).toMatchObject({ status: "landed", phase: "at_gate" });
    update(IDS.flight, { arrivalScheduleGateActual: at(-10) });
    expect(db.getFlightStatus("ZZ101")!.status).toBe("unknown");
  });
});
