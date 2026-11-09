import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync as Database } from "node:sqlite";
import { existsSync } from "fs";
import {
  MAIN_DB_PATH,
  AUTH_DB_PATH,
  TIMESTAMP_COLUMNS,
  KM_TO_MILES,
  EARTH_CIRCUMFERENCE_KM,
} from "../constants.js";
import { readFlightyAuthToken, readJwtSubject } from "./auth-token.js";
import { airportContinuity, deriveConnectionCheck, deriveTrackingTiming } from "./tracking.js";
import {
  DEFAULT_PAGE_LIMIT,
  DEFAULT_REFERENCE_LIMIT,
  MAX_PAGE_LIMIT,
  MAX_REFERENCE_LIMIT,
  assertValidBoundedQuery,
  assertValidFlightNumber,
  assertValidIsoDate,
  assertValidLimit,
  assertValidOffset,
  assertValidYear,
  isValidUuid,
} from "./validation.js";
import type {
  FlightRecord,
  AirportRecord,
  AirlineRecord,
  FlightStatusRecord,
  DelayForecastRecord,
  ConnectionRecord,
  FlightStatsRecord,
  ListFlightsParams,
  ListFriendFlightsParams,
  GetFlightParams,
  SearchFlightsParams,
  TrackedFlight,
  TrackingAssociation,
  CachedConnectionMinimum,
} from "../types.js";

export type OwnerIdentitySource =
  | "env_override"
  | "jwt_subject"
  | "frequency_fallback"
  | "replica_producer";

export type OwnerIdentityLabel =
  | "signed_in_owner"
  | "pinned_owner_override"
  | "shared_or_fallback_owner"
  | "replica_export_scope";

export interface OwnerIdentity {
  userId: string;
  source: OwnerIdentitySource;
  label: OwnerIdentityLabel;
  isFallback: boolean;
  isSharedOwner: boolean;
  warning?: string;
}

export interface RemovalLocalRecord {
  flight: FlightRecord;
  record: "passenger" | "followed";
  identity: OwnerIdentity;
}

export interface TrackingLocalRecord {
  tracked: TrackedFlight;
  identity: OwnerIdentity;
}

export interface PaginationParams {
  limit?: number;
  offset?: number;
}

interface OwnerIdentityStore {
  identity: OwnerIdentity | null;
}

const ownerIdentityStorage = new AsyncLocalStorage<OwnerIdentityStore>();

export function runWithOwnerIdentityScope<T>(fn: () => T): T {
  return ownerIdentityStorage.run({ identity: null }, fn);
}

export function getScopedOwnerIdentity(): OwnerIdentity | null {
  return ownerIdentityStorage.getStore()?.identity ?? null;
}

function tsToIso(ts: number | null | undefined): string | null {
  if (ts == null || ts <= 0) return null;
  return new Date(ts * 1000).toISOString();
}

function trackingTsToIso(ts: unknown): string | null {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return null;
  const date = new Date(ts * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function buildFlightDict(row: Record<string, unknown>): FlightRecord {
  const d = { ...row };
  for (const key of TIMESTAMP_COLUMNS) {
    if (key in d && d[key] != null) {
      d[key] = tsToIso(d[key] as number);
    }
  }
  return d as unknown as FlightRecord;
}

// Unifies Flight + ManualFlight and UserFlight + UserManualFlight via CTEs.
// ManualFlight lacks "Estimated" schedule timestamps and check-in schedule
// columns, so those are mapped to NULL so both branches share a column shape.
// CTE aliases (flights_combined, user_flights_combined) are then aliased back
// to `f` / `uf` so all consumer queries keep their existing column references.
const FLIGHT_UNION_CTE = `
WITH flights_combined AS (
    SELECT
        id, number, airlineId, departureAirportId, scheduledArrivalAirportId,
        departureTerminal, departureGate,
        departureScheduleGateOriginal, departureScheduleGateEstimated, departureScheduleGateActual,
        departureScheduleRunwayOriginal, departureScheduleRunwayEstimated, departureScheduleRunwayActual,
        arrivalTerminal, arrivalGate, arrivalBaggageBelt,
        arrivalScheduleGateOriginal, arrivalScheduleGateEstimated, arrivalScheduleGateActual,
        arrivalScheduleRunwayOriginal, arrivalScheduleRunwayEstimated, arrivalScheduleRunwayActual,
        isCancelled, distance,
        equipmentTailNumber, equipmentModelName, equipmentManufacturer, equipmentPlaneName, equipmentCruisingSpeed,
        arrivalWeatherConditionName AS arrivalWeatherCondition, arrivalWeatherTemperature,
        delayForecastDelayMean, delayForecastObservations,
        delayForecastEarlyCount, delayForecastOntimeCount,
        delayForecastLate15Count, delayForecastLate30Count, delayForecastLate45Count,
        delayForecastCanceledCount, delayForecastDivertedCount,
        checkInScheduleOpen, checkInScheduleClose,
        deleted
    FROM Flight
    UNION ALL
    SELECT
        id, number, airlineId, departureAirportId, scheduledArrivalAirportId,
        departureTerminal, departureGate,
        departureScheduleGateOriginal, NULL AS departureScheduleGateEstimated, departureScheduleGateActual,
        departureScheduleRunwayOriginal, NULL AS departureScheduleRunwayEstimated, departureScheduleRunwayActual,
        arrivalTerminal, arrivalGate, arrivalBaggageBelt,
        arrivalScheduleGateOriginal, NULL AS arrivalScheduleGateEstimated, arrivalScheduleGateActual,
        arrivalScheduleRunwayOriginal, NULL AS arrivalScheduleRunwayEstimated, arrivalScheduleRunwayActual,
        isCancelled, distance,
        equipmentTailNumber, equipmentModelName, equipmentManufacturer, equipmentPlaneName, equipmentCruisingSpeed,
        arrivalWeatherConditionName AS arrivalWeatherCondition, arrivalWeatherTemperature,
        delayForecastDelayMean, delayForecastObservations,
        delayForecastEarlyCount, delayForecastOntimeCount,
        delayForecastLate15Count, delayForecastLate30Count, delayForecastLate45Count,
        delayForecastCanceledCount, delayForecastDivertedCount,
        NULL AS checkInScheduleOpen, NULL AS checkInScheduleClose,
        deleted
    FROM ManualFlight
),
user_flights_combined AS (
    SELECT userId, flightId, importSource, deleted, isMyFlight FROM UserFlight
    UNION ALL
    SELECT userId, flightId, importSource, deleted, isMyFlight FROM UserManualFlight
)`;

const FLIGHT_BASE_QUERY = `${FLIGHT_UNION_CTE}
SELECT
    f.id,
    f.number AS flight_number,
    al.name AS airline_name,
    al.iata AS airline_iata,
    dep.iata AS departure_airport_iata,
    dep.name AS departure_airport_name,
    dep.city AS departure_city,
    dep.country AS departure_country,
    dep.timeZoneIdentifier AS departure_timezone,
    f.departureTerminal AS departure_terminal,
    f.departureGate AS departure_gate,
    f.departureScheduleGateOriginal,
    f.departureScheduleGateEstimated,
    f.departureScheduleGateActual,
    f.departureScheduleRunwayOriginal,
    f.departureScheduleRunwayEstimated,
    f.departureScheduleRunwayActual,
    arr.iata AS arrival_airport_iata,
    arr.name AS arrival_airport_name,
    arr.city AS arrival_city,
    arr.country AS arrival_country,
    arr.timeZoneIdentifier AS arrival_timezone,
    f.arrivalTerminal AS arrival_terminal,
    f.arrivalGate AS arrival_gate,
    f.arrivalBaggageBelt AS arrival_baggage_belt,
    f.arrivalScheduleGateOriginal,
    f.arrivalScheduleGateEstimated,
    f.arrivalScheduleGateActual,
    f.arrivalScheduleRunwayOriginal,
    f.arrivalScheduleRunwayEstimated,
    f.arrivalScheduleRunwayActual,
    f.isCancelled AS is_cancelled,
    f.distance AS distance_km,
    f.equipmentTailNumber AS tail_number,
    f.equipmentModelName AS aircraft_model,
    f.equipmentManufacturer AS aircraft_manufacturer,
    f.equipmentPlaneName AS aircraft_name,
    f.equipmentCruisingSpeed AS cruising_speed_kmh,
    f.arrivalWeatherCondition AS arrival_weather,
    f.arrivalWeatherTemperature AS arrival_temp_c,
    f.delayForecastDelayMean AS delay_forecast_mean_min,
    f.delayForecastObservations AS delay_forecast_observations,
    f.delayForecastEarlyCount,
    f.delayForecastOntimeCount,
    f.delayForecastLate15Count,
    f.delayForecastLate30Count,
    f.delayForecastLate45Count,
    f.delayForecastCanceledCount,
    f.delayForecastDivertedCount,
    f.checkInScheduleOpen,
    f.checkInScheduleClose,
    t.seatNumber AS seat_number,
    t.seatPosition AS seat_position,
    t.cabinClass AS cabin_class,
    t.pnr AS booking_reference,
    t.flightReason AS flight_reason,
    uf.importSource AS import_source
FROM flights_combined f
JOIN Airport dep ON f.departureAirportId = dep.id
JOIN Airport arr ON f.scheduledArrivalAirportId = arr.id
JOIN Airline al ON f.airlineId = al.id
JOIN user_flights_combined uf ON f.id = uf.flightId
LEFT JOIN Ticket t ON f.id = t.flightId AND uf.userId = t.userId
WHERE uf.deleted IS NULL AND f.deleted IS NULL AND uf.isMyFlight = 1
`;

export interface DatabaseContext {
  dbPath: string;
  openDatabase(): Database;
  ownerIdentity: OwnerIdentity;
}

export class FlightyDatabase {
  private localDbPath: string;
  get dbPath(): string { return this.contextProvider ? this.contextProvider().dbPath : this.localDbPath; }
  private authDbPath: string;
  private cachedOwnerId: string | null = null;
  private cachedOwner: {
    envOwner: string;
    token: string | null;
    identity: OwnerIdentity;
  } | null = null;
  private lastOwnerIdentity: OwnerIdentity | null = null;

  constructor(
    dbPath: string = MAIN_DB_PATH,
    authDbPath: string = AUTH_DB_PATH,
    private readonly contextProvider?: () => DatabaseContext
  ) {
    this.localDbPath = dbPath;
    this.authDbPath = authDbPath;
  }

  private getDb(): Database {
    if (this.contextProvider) return this.contextProvider().openDatabase();
    if (!existsSync(this.dbPath)) {
      throw new Error(
        "Flighty database not found at configured path. Make sure the Flighty app is installed."
      );
    }
    return new Database(this.dbPath, { readOnly: true });
  }

  private recordResolvedIdentity(identity: OwnerIdentity): OwnerIdentity {
    this.cachedOwnerId = identity.userId;
    this.lastOwnerIdentity = identity;
    const store = ownerIdentityStorage.getStore();
    if (store) {
      store.identity = identity;
    }
    return identity;
  }

  private resolveOwnerIdentity(db: Database): OwnerIdentity {
    if (this.contextProvider) return this.recordResolvedIdentity(this.contextProvider().ownerIdentity);
    // Tier 0: FLIGHTY_OWNER_USER_ID env var — operator pin.
    const envOwner = (process.env.FLIGHTY_OWNER_USER_ID ?? "").trim();
    if (envOwner) {
      if (
        this.cachedOwner &&
        this.cachedOwner.envOwner === envOwner &&
        this.cachedOwner.identity.source === "env_override"
      ) {
        return this.recordResolvedIdentity(this.cachedOwner.identity);
      }

      const identity: OwnerIdentity = {
        userId: envOwner,
        source: "env_override",
        label: "pinned_owner_override",
        isFallback: false,
        isSharedOwner: true,
        warning:
          "Owner identity is pinned via FLIGHTY_OWNER_USER_ID (shared/override owner); records belong to the configured user ID rather than automatic signed-in account resolution.",
      };
      this.cachedOwner = { envOwner, token: null, identity };
      return this.recordResolvedIdentity(identity);
    }

    // Tier 1: JWT `sub` claim from Flighty's auth token.
    const token = readFlightyAuthToken(this.dbPath, this.authDbPath);
    const jwtSubject = readJwtSubject(token ?? "");
    if (
      this.cachedOwner &&
      this.cachedOwner.envOwner === "" &&
      this.cachedOwner.token === token &&
      this.cachedOwner.identity.source === "jwt_subject" &&
      this.cachedOwner.identity.userId === jwtSubject &&
      jwtSubject !== null &&
      this.userHasAnyFlights(db, jwtSubject)
    ) {
      return this.recordResolvedIdentity(this.cachedOwner.identity);
    }

    if (jwtSubject && this.userHasAnyFlights(db, jwtSubject)) {
      const identity: OwnerIdentity = {
        userId: jwtSubject,
        source: "jwt_subject",
        label: "signed_in_owner",
        isFallback: false,
        isSharedOwner: false,
      };
      this.cachedOwner = { envOwner: "", token, identity };
      return this.recordResolvedIdentity(identity);
    }

    // Tier 2: frequency fallback across UserFlight ∪ UserManualFlight.
    const fallback = db
      .prepare(
        `SELECT userId, COUNT(*) AS cnt FROM (
           SELECT userId FROM UserFlight WHERE deleted IS NULL
           UNION ALL
           SELECT userId FROM UserManualFlight WHERE deleted IS NULL
         ) GROUP BY userId ORDER BY cnt DESC LIMIT 1`
      )
      .get() as { userId: string; cnt: number } | undefined;

    if (!fallback) {
      throw new Error(
        "Could not determine Flighty user ID. If this is a friend-share install " +
          "or an install with multiple owners' flights, set the FLIGHTY_OWNER_USER_ID " +
          "environment variable to the userId whose flights you want surfaced."
      );
    }

    const identity: OwnerIdentity = {
      userId: fallback.userId,
      source: "frequency_fallback",
      label: "shared_or_fallback_owner",
      isFallback: true,
      isSharedOwner: true,
      warning:
        "Owner identity resolved via heuristic frequency fallback (shared/fallback owner), not the signed-in account. Records may belong to a shared/other user. Set FLIGHTY_OWNER_USER_ID to pin a specific user ID.",
    };
    this.cachedOwner = { envOwner: "", token, identity };
    return this.recordResolvedIdentity(identity);
  }

  private getOwnerUserId(db: Database): string {
    return this.resolveOwnerIdentity(db).userId;
  }

  getOwnerIdentity(existingDb?: Database): OwnerIdentity {
    if (existingDb) {
      return this.resolveOwnerIdentity(existingDb);
    }
    const db = this.getDb();
    try {
      return this.resolveOwnerIdentity(db);
    } finally {
      db.close();
    }
  }

  getLastOwnerIdentity(): OwnerIdentity | null {
    return this.lastOwnerIdentity;
  }

  clearLastOwnerIdentity(): void {
    this.lastOwnerIdentity = null;
  }

  /** True if the given userId has at least one non-deleted flight row across UserFlight ∪ UserManualFlight. */
  private userHasAnyFlights(db: Database, userId: string): boolean {
    const row = db
      .prepare(
        `SELECT 1 AS found FROM (
           SELECT userId FROM UserFlight WHERE deleted IS NULL AND userId = ?
           UNION ALL
           SELECT userId FROM UserManualFlight WHERE deleted IS NULL AND userId = ?
         ) LIMIT 1`
      )
      .get(userId, userId) as { found: number } | undefined;
    return row !== undefined;
  }

  listFlights(params: ListFlightsParams = {}): FlightRecord[] {
    assertValidYear(params.year);
    assertValidLimit(params.limit, MAX_PAGE_LIMIT);
    assertValidOffset(params.offset);

    const db = this.getDb();
    try {
      const ownerId = this.getOwnerUserId(db);
      let query = FLIGHT_BASE_QUERY + " AND uf.userId = ?";
      const binds: (string | number | null)[] = [ownerId];

      const now = Math.floor(Date.now() / 1000);
      if (params.upcoming_only) {
        query += " AND f.departureScheduleGateOriginal >= ?";
        binds.push(now);
      } else if (params.year) {
        const start = Math.floor(new Date(Date.UTC(params.year, 0, 1)).getTime() / 1000);
        const end = Math.floor(new Date(Date.UTC(params.year + 1, 0, 1)).getTime() / 1000);
        query += " AND f.departureScheduleGateOriginal >= ? AND f.departureScheduleGateOriginal < ?";
        binds.push(start, end);
      }

      const sortDir = params.upcoming_only ? "ASC" : "DESC";
      query += ` ORDER BY f.departureScheduleGateOriginal ${sortDir} LIMIT ? OFFSET ?`;
      binds.push(params.limit ?? DEFAULT_PAGE_LIMIT, params.offset ?? 0);

      const rows = db.prepare(query).all(...binds) as Record<string, unknown>[];
      return rows.map(buildFlightDict);
    } finally {
      db.close();
    }
  }

  currentFlights(params: PaginationParams = {}): FlightRecord[] {
    assertValidLimit(params.limit, MAX_PAGE_LIMIT);
    assertValidOffset(params.offset);

    const db = this.getDb();
    try {
      const ownerId = this.getOwnerUserId(db);
      const now = Math.floor(Date.now() / 1000);
      const windowSeconds = 24 * 60 * 60;
      const limit = params.limit ?? DEFAULT_PAGE_LIMIT;
      const offset = params.offset ?? 0;

      let query = FLIGHT_BASE_QUERY + " AND uf.userId = ?";
      query += " AND f.departureScheduleGateOriginal >= ? AND f.departureScheduleGateOriginal <= ?";
      query += " ORDER BY f.departureScheduleGateOriginal ASC LIMIT ? OFFSET ?";
      const binds = [
        ownerId,
        now - windowSeconds,
        now + windowSeconds,
        limit,
        offset,
      ];
      const rows = db.prepare(query).all(...binds) as Record<string, unknown>[];
      return rows.map(buildFlightDict);
    } finally {
      db.close();
    }
  }

  listFriendFlights(params: ListFriendFlightsParams = {}): FlightRecord[] {
    assertValidBoundedQuery(params.friend_name, "friend_name");
    assertValidYear(params.year);
    assertValidLimit(params.limit, MAX_PAGE_LIMIT);
    assertValidOffset(params.offset);

    const db = this.getDb();
    try {
      const ownerId = this.getOwnerUserId(db);

      let query = FLIGHT_BASE_QUERY.replace(
        "LEFT JOIN Ticket t ON f.id = t.flightId AND uf.userId = t.userId",
        "LEFT JOIN Ticket t ON f.id = t.flightId AND uf.userId = t.userId\nLEFT JOIN Profile p ON uf.userId = p.userId"
      );

      // Add friend_name to SELECT — null for owner's own tracked flights (isMyFlight=0)
      query = query.replace(
        "SELECT\n    f.id,",
        `SELECT
    CASE WHEN uf.isMyFlight = 1 AND NULLIF(TRIM(p.fullName), '') IS NOT NULL THEN p.fullName END AS friend_name,
    CASE WHEN uf.isMyFlight = 0 THEN 'owner_followed' ELSE 'cached_shared_passenger' END AS tracking_source,
    'unverified' AS friendship_status,
    CASE WHEN uf.isMyFlight = 1 AND NULLIF(TRIM(p.fullName), '') IS NOT NULL THEN 'profile' ELSE 'unknown' END AS passenger_name_source,
    CASE WHEN uf.isMyFlight = 0 THEN 'followed_row_does_not_identify_passenger'
         WHEN NULLIF(TRIM(p.fullName), '') IS NULL THEN 'profile_name_missing' END AS passenger_name_unknown_reason,
    f.id,`
      );

      // Include friend's passenger flights (isMyFlight=1, userId != owner) AND
      // owner's tracked non-passenger flights (isMyFlight=0, userId = owner).
      // Both conditions are necessary: the looser (userId != ? OR isMyFlight = 0)
      // would also admit a friend's own isMyFlight=0 rows, blanking their friend_name.
      query = query.replace(
        "AND uf.isMyFlight = 1",
        "AND ((uf.userId != ? AND uf.isMyFlight = 1) OR (uf.userId = ? AND uf.isMyFlight = 0))"
      );
      const binds: (string | number | null)[] = [ownerId, ownerId];

      if (params.friend_name) {
        const friendName = params.friend_name.trim();
        query +=
          " AND uf.isMyFlight = 1 AND (UPPER(p.fullName) LIKE UPPER(?) OR UPPER(p.firstName) LIKE UPPER(?))";
        binds.push(`%${friendName}%`, `%${friendName}%`);
      }

      const now = Math.floor(Date.now() / 1000);
      if (params.upcoming_only) {
        query += " AND f.departureScheduleGateOriginal >= ?";
        binds.push(now);
      } else if (params.year) {
        const start = Math.floor(new Date(Date.UTC(params.year, 0, 1)).getTime() / 1000);
        const end = Math.floor(new Date(Date.UTC(params.year + 1, 0, 1)).getTime() / 1000);
        query += " AND f.departureScheduleGateOriginal >= ? AND f.departureScheduleGateOriginal < ?";
        binds.push(start, end);
      }

      const sortDir = params.upcoming_only ? "ASC" : "DESC";
      query += ` ORDER BY f.departureScheduleGateOriginal ${sortDir} LIMIT ? OFFSET ?`;
      binds.push(params.limit ?? DEFAULT_PAGE_LIMIT, params.offset ?? 0);

      const rows = db.prepare(query).all(...binds) as Record<string, unknown>[];
      return rows.map(buildFlightDict);
    } finally {
      db.close();
    }
  }

  private readTrackingFlight(db: Database, ownerId: string, flightId: string): TrackedFlight | null {
    // Keep the existing owner/passenger and cached friend/followed membership
    // boundary. Exact UUID predicates and owner IDs are always bound values.
    const query = FLIGHT_BASE_QUERY
      .replace("SELECT\n    f.id,", `SELECT
    uf.userId AS association_user_id,
    uf.isMyFlight AS association_is_passenger,
    p.fullName AS association_name,
    f.departureAirportId AS departure_airport_id,
    f.scheduledArrivalAirportId AS arrival_airport_id,
    (SELECT COUNT(DISTINCT a.id) FROM Airport a WHERE UPPER(TRIM(a.iata)) = UPPER(TRIM(dep.iata))) = 1 AS departure_code_unambiguous,
    (SELECT COUNT(DISTINCT a.id) FROM Airport a WHERE UPPER(TRIM(a.iata)) = UPPER(TRIM(arr.iata))) = 1 AS arrival_code_unambiguous,
    f.id,`)
      .replace("JOIN Airport dep", "LEFT JOIN Airport dep")
      .replace("JOIN Airport arr", "LEFT JOIN Airport arr")
      .replace("JOIN Airline al", "LEFT JOIN Airline al")
      .replace("LEFT JOIN Ticket t ON f.id = t.flightId AND uf.userId = t.userId",
        "LEFT JOIN Ticket t ON f.id = t.flightId AND uf.userId = t.userId\nLEFT JOIN Profile p ON uf.userId = p.userId")
      .replace("AND uf.isMyFlight = 1",
        "AND ((uf.userId = ? AND uf.isMyFlight IN (0, 1)) OR (uf.userId != ? AND uf.isMyFlight = 1))") +
      " AND f.id = ? COLLATE NOCASE";
    const rows = db.prepare(query).all(ownerId, ownerId, flightId) as Record<string, unknown>[];
    if (rows.length === 0) return null;

    const associationKeys = ["seat_number", "seat_position", "cabin_class", "booking_reference", "flight_reason", "import_source"] as const;
    const associations = new Map<string, TrackingAssociation>();
    const operationalRows = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const isOwner = row.association_user_id === ownerId;
      const followed = isOwner && row.association_is_passenger === 0;
      const name = !followed && typeof row.association_name === "string" && row.association_name.trim() ? row.association_name : null;
      const association: TrackingAssociation = {
        user_id: row.association_user_id as string,
        tracking_source: followed ? "owner_followed" : isOwner ? "owner_passenger" : "cached_shared_passenger",
        friendship_status: "unverified",
        passenger_name: name,
        passenger_name_source: name === null ? "unknown" : "profile",
        passenger_name_unknown_reason: followed ? "followed_row_does_not_identify_passenger" : name === null ? "profile_name_missing" : null,
        seat_number: row.seat_number as string | null,
        seat_position: row.seat_position as string | null,
        cabin_class: row.cabin_class as string | null,
        booking_reference: row.booking_reference as string | null,
        flight_reason: row.flight_reason as string | null,
        import_source: row.import_source as string | null,
      };
      associations.set(JSON.stringify(association), association);
      const operational = { ...row };
      delete operational.association_user_id;
      delete operational.association_is_passenger;
      delete operational.association_name;
      for (const key of associationKeys) delete operational[key];
      operationalRows.set(JSON.stringify(operational), operational);
    }
    // A corrupt cache containing conflicting records for one UUID must not pick
    // an arbitrary Flight/ManualFlight row.
    if (operationalRows.size !== 1) throw new Error("Conflicting cached flight records for this UUID; tracking is ambiguous.");
    const row = [...operationalRows.values()][0];
    const ordered = [...associations.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value);
    const timestampIssues: Record<string, string> = {};
    for (const key of TIMESTAMP_COLUMNS) {
      if (row[key] != null && trackingTsToIso(row[key]) === null) timestampIssues[key] = "invalid_timestamp";
    }
    const { departure_airport_id, arrival_airport_id, departure_code_unambiguous, arrival_code_unambiguous, ...flightRow } = row;
    for (const key of associationKeys) flightRow[key] = ordered.length === 1 ? ordered[0][key] : null;
    for (const key of TIMESTAMP_COLUMNS) {
      if (key in flightRow) flightRow[key] = trackingTsToIso(flightRow[key]);
    }
    return {
      flight: flightRow as unknown as FlightRecord,
      associations: ordered,
      identity_ambiguous: ordered.length > 1,
      attribution_notice: "Each association identifies its own cached source only. Membership and Profile names do not verify friendship. A followed owner row does not identify its passenger. With multiple associations, booking fields are supplied per association rather than choosing one traveler.",
      departure_airport_id: departure_airport_id as string | null,
      arrival_airport_id: arrival_airport_id as string | null,
      departure_code_unambiguous: Boolean(departure_code_unambiguous),
      arrival_code_unambiguous: Boolean(arrival_code_unambiguous),
      timestamp_issues: timestampIssues,
    };
  }

  getTrackingFlight(flightId: string): TrackingLocalRecord | null {
    if (!isValidUuid(flightId)) throw new Error("Invalid flight_id: expected UUID format.");
    const db = this.getDb();
    try {
      const identity = this.resolveOwnerIdentity(db);
      const tracked = this.readTrackingFlight(db, identity.userId, flightId.trim());
      return tracked ? { tracked, identity } : null;
    } finally {
      db.close();
    }
  }

  private readConnectionMinimum(db: Database, inbound: TrackedFlight, outbound: TrackedFlight): CachedConnectionMinimum {
    const rows = db.prepare(`SELECT mctMinutes, waitingAirportId FROM Connection
      WHERE deleted IS NULL AND arrivingFlightId = ? COLLATE NOCASE AND departingFlightId = ? COLLATE NOCASE`)
      .all(inbound.flight.id, outbound.flight.id) as Array<{ mctMinutes: unknown; waitingAirportId: unknown }>;
    if (rows.length === 0) return { minutes: null, basis: null, reason: "no_cached_connection_for_exact_pair" };
    const normalizeId = (id: unknown) => typeof id === "string" && id.trim() ? id.trim().toLowerCase() : null;
    const continuity = airportContinuity(inbound, outbound);
    const transferId = normalizeId(inbound.arrival_airport_id) ?? normalizeId(outbound.departure_airport_id);
    const contexts = rows.map(({ waitingAirportId }) => normalizeId(waitingAirportId));
    if (continuity.matches !== true || transferId === null || contexts.some((id) => id === null)) {
      return { minutes: null, basis: null, reason: "unknown_cached_minimum_airport_context" };
    }
    if (new Set(contexts).size !== 1) return { minutes: null, basis: null, reason: "conflicting_cached_minimum_airport_contexts" };
    if (contexts[0] !== transferId) return { minutes: null, basis: null, reason: "cached_minimum_airport_context_mismatch" };
    // An MCT is a duration in minutes, not a date or a default threshold. A
    // value above a full day is outside this tool's supported cache semantics.
    const valid = rows.every(({ mctMinutes }) => typeof mctMinutes === "number" && Number.isFinite(mctMinutes) && mctMinutes >= 0 && mctMinutes <= 1440);
    const values = new Set(rows.map(({ mctMinutes }) => mctMinutes));
    if (!valid || values.size !== 1) return { minutes: null, basis: null, reason: "invalid_or_conflicting_cached_minimum" };
    return { minutes: rows[0].mctMinutes as number, basis: "cached_exact_pair", reason: null };
  }

  checkConnection(inboundId: string, outboundId: string) {
    if (!isValidUuid(inboundId) || !isValidUuid(outboundId)) throw new Error("Invalid flight IDs: expected UUID format.");
    inboundId = inboundId.trim();
    outboundId = outboundId.trim();
    if (inboundId.toLowerCase() === outboundId.toLowerCase()) throw new Error("Connection requires two distinct flight UUIDs.");
    const db = this.getDb();
    try {
      // Read both legs, their associations, and MCT in one SQLite snapshot.
      db.exec("BEGIN");
      const identity = this.resolveOwnerIdentity(db);
      const inbound = this.readTrackingFlight(db, identity.userId, inboundId);
      const outbound = this.readTrackingFlight(db, identity.userId, outboundId);
      if (!inbound || !outbound) return null;
      const minimum = this.readConnectionMinimum(db, inbound, outbound);
      return { result: deriveConnectionCheck(inbound, outbound, minimum), identity };
    } finally {
      db.close();
    }
  }

  getRemovalFlight(flightId: string): RemovalLocalRecord | null {
    if (!isValidUuid(flightId)) {
      throw new Error("Invalid flight_id: expected UUID format.");
    }
    const db = this.getDb();
    try {
      const identity = this.resolveOwnerIdentity(db);
      // Exact owner + UUID lookup; friend display names never establish ownership.
      const query = FLIGHT_BASE_QUERY
        .replace("SELECT\n    f.id,", "SELECT\n    uf.isMyFlight AS is_passenger,\n    f.id,")
        .replace("AND uf.isMyFlight = 1", "AND uf.isMyFlight IN (0, 1)") +
        " AND uf.userId = ? AND f.id = ? COLLATE NOCASE ORDER BY uf.isMyFlight DESC LIMIT 1";
      const row = db.prepare(query).get(identity.userId, flightId) as Record<string, unknown> | undefined;
      if (!row) return null;
      const { is_passenger, ...flight } = row;
      return {
        flight: buildFlightDict(flight),
        record: is_passenger === 1 ? "passenger" : "followed",
        identity,
      };
    } finally {
      db.close();
    }
  }

  /** All account-bound candidates, including conflicting duplicates. Mac executor rejects ambiguity. */
  getRemovalCandidates(flightId: string): RemovalLocalRecord[] {
    if (!isValidUuid(flightId)) throw new Error("Invalid flight_id: expected UUID format.");
    const db = this.getDb();
    try {
      const identity = this.resolveOwnerIdentity(db);
      const query = FLIGHT_BASE_QUERY
        .replace("SELECT\n    f.id,", "SELECT\n    uf.isMyFlight AS is_passenger,\n    f.id,")
        .replace("AND uf.isMyFlight = 1", "AND uf.isMyFlight IN (0, 1)") +
        " AND uf.userId = ? AND f.id = ? COLLATE NOCASE";
      const rows: Record<string, unknown>[] = [];
      // Any second candidate proves ambiguity. Stop accumulating before an adversarial join expands memory.
      for (const row of db.prepare(query).iterate(identity.userId, flightId)) {
        rows.push(row); if (rows.length === 2) break;
      }
      return rows.map(({ is_passenger, ...flight }) => ({ flight: buildFlightDict(flight),
        record: is_passenger === 1 ? "passenger" : "followed", identity }));
    } finally { db.close(); }
  }

  getFlight(params: GetFlightParams): FlightRecord | null {
    return this.readFlight(params)?.flight ?? null;
  }

  private readFlight(params: GetFlightParams, forTracking = false): { flight: FlightRecord; timestampIssues: Record<string, string> } | null {
    const hasId = params.flight_id !== undefined && params.flight_id !== "";
    const hasNumber =
      params.flight_number !== undefined && params.flight_number !== "";

    if (!hasId && !hasNumber) return null;
    if (hasId && hasNumber) {
      throw new Error(
        "Provide either flight_id or flight_number, not both (selectors are mutually exclusive)."
      );
    }
    if (hasId && !isValidUuid(params.flight_id!)) {
      throw new Error(
        "Invalid flight_id: expected 36-character 8-4-4-4-12 hexadecimal UUID format."
      );
    }
    if (hasNumber) {
      assertValidFlightNumber(params.flight_number!);
    }

    const db = this.getDb();
    try {
      const ownerId = this.getOwnerUserId(db);
      let query = FLIGHT_BASE_QUERY + " AND uf.userId = ?";
      const binds: (string | number | null)[] = [ownerId];

      if (hasId) {
        query += " AND f.id = ?";
        binds.push(params.flight_id!.trim());
      } else {
        // Users pass "AA179" or "179" — database stores just "179" with airline in a separate table.
        // Try matching as airline_iata + number first, fall back to number-only.
        const raw = params.flight_number!.trim().toUpperCase().replace(/[-\s]/g, "");
        const m = raw.match(/^([A-Z]{2}|\d[A-Z]|[A-Z]\d)(\d+)$/);
        if (m) {
          query += " AND UPPER(al.iata) = ? AND f.number = ?";
          binds.push(m[1], m[2]);
        } else {
          query += " AND f.number = ?";
          binds.push(raw);
        }
        query += " ORDER BY f.departureScheduleGateOriginal DESC LIMIT 1";
      }

      const row = db.prepare(query).get(...binds) as
        | Record<string, unknown>
        | undefined;
      if (!row) return null;
      const timestampIssues: Record<string, string> = {};
      if (!forTracking) return { flight: buildFlightDict(row), timestampIssues };
      const normalized = { ...row };
      for (const key of TIMESTAMP_COLUMNS) {
        if (row[key] != null && trackingTsToIso(row[key]) === null) timestampIssues[key] = "invalid_timestamp";
        if (key in normalized) normalized[key] = trackingTsToIso(row[key]);
      }
      return { flight: normalized as unknown as FlightRecord, timestampIssues };
    } finally {
      db.close();
    }
  }

  searchFlights(params: SearchFlightsParams = {}): FlightRecord[] {
    assertValidBoundedQuery(params.airline, "airline");
    assertValidBoundedQuery(params.departure_airport, "departure_airport");
    assertValidBoundedQuery(params.arrival_airport, "arrival_airport");
    assertValidIsoDate(params.after, "after");
    assertValidIsoDate(params.before, "before");
    assertValidLimit(params.limit, MAX_PAGE_LIMIT);

    const afterDate = params.after?.trim();
    const beforeDate = params.before?.trim();
    if (afterDate && beforeDate && afterDate > beforeDate) {
      throw new Error(
        "Invalid date range: 'after' date must not be later than 'before' date."
      );
    }

    const db = this.getDb();
    try {
      const ownerId = this.getOwnerUserId(db);
      let query = FLIGHT_BASE_QUERY + " AND uf.userId = ?";
      const binds: (string | number | null)[] = [ownerId];

      if (params.airline) {
        const airline = params.airline.trim();
        query +=
          " AND (UPPER(al.iata) = UPPER(?) OR UPPER(al.name) LIKE UPPER(?))";
        binds.push(airline, `%${airline}%`);
      }
      if (params.departure_airport) {
        const depAirport = params.departure_airport.trim();
        query +=
          " AND (UPPER(dep.iata) = UPPER(?) OR UPPER(dep.city) LIKE UPPER(?))";
        binds.push(depAirport, `%${depAirport}%`);
      }
      if (params.arrival_airport) {
        const arrAirport = params.arrival_airport.trim();
        query +=
          " AND (UPPER(arr.iata) = UPPER(?) OR UPPER(arr.city) LIKE UPPER(?))";
        binds.push(arrAirport, `%${arrAirport}%`);
      }
      if (afterDate) {
        const ts = Math.floor(new Date(afterDate).getTime() / 1000);
        query += " AND f.departureScheduleGateOriginal >= ?";
        binds.push(ts);
      }
      if (beforeDate) {
        // "on or before" means up to the end of the given date (next day midnight UTC)
        const nextDay = new Date(beforeDate);
        nextDay.setUTCDate(nextDay.getUTCDate() + 1);
        const ts = Math.floor(nextDay.getTime() / 1000);
        query += " AND f.departureScheduleGateOriginal < ?";
        binds.push(ts);
      }

      query += " ORDER BY f.departureScheduleGateOriginal DESC LIMIT ?";
      binds.push(params.limit ?? DEFAULT_PAGE_LIMIT);

      const rows = db.prepare(query).all(...binds) as Record<string, unknown>[];
      return rows.map(buildFlightDict);
    } finally {
      db.close();
    }
  }

  getFlightStatus(flightNumber: string): FlightStatusRecord | null {
    assertValidFlightNumber(flightNumber);
    const record = this.readFlight({ flight_number: flightNumber.trim() }, true);
    if (!record) return null;
    const { flight, timestampIssues } = record;

    let depDelayMin: number | null = null;
    let arrDelayMin: number | null = null;

    if (flight.departureScheduleGateOriginal && flight.departureScheduleGateEstimated) {
      const d1 = new Date(flight.departureScheduleGateOriginal).getTime();
      const d2 = new Date(flight.departureScheduleGateEstimated).getTime();
      if (!isNaN(d1) && !isNaN(d2)) {
        depDelayMin = Math.round((d2 - d1) / 60000);
      }
    }
    if (flight.arrivalScheduleGateOriginal && flight.arrivalScheduleGateEstimated) {
      const d1 = new Date(flight.arrivalScheduleGateOriginal).getTime();
      const d2 = new Date(flight.arrivalScheduleGateEstimated).getTime();
      if (!isNaN(d1) && !isNaN(d2)) {
        arrDelayMin = Math.round((d2 - d1) / 60000);
      }
    }

    const timing = deriveTrackingTiming(flight, Date.now(), timestampIssues);
    const status: FlightStatusRecord["status"] =
      timing.phase === "airborne" ? "in_air" :
      timing.phase === "taxi_in" || timing.phase === "at_gate" ? "landed" :
      timing.phase === "scheduled" && depDelayMin != null && depDelayMin > 15 ? "delayed" :
      timing.phase;

    return {
      flight_number: flight.flight_number,
      status,
      phase: timing.phase,
      phase_reason: timing.phase_reason,
      is_cancelled: Boolean(flight.is_cancelled),
      departure_airport: flight.departure_airport_iata,
      arrival_airport: flight.arrival_airport_iata,
      scheduled_departure: flight.departureScheduleGateOriginal,
      estimated_departure: flight.departureScheduleGateEstimated,
      actual_departure: flight.departureScheduleGateActual,
      scheduled_arrival: flight.arrivalScheduleGateOriginal,
      estimated_arrival: flight.arrivalScheduleGateEstimated,
      actual_arrival: flight.arrivalScheduleGateActual,
      departure_delay_minutes: depDelayMin,
      arrival_delay_minutes: arrDelayMin,
      departure_gate: flight.departure_gate,
      arrival_gate: flight.arrival_gate,
      arrival_baggage_belt: flight.arrival_baggage_belt,
      arrival_weather: flight.arrival_weather,
      arrival_temp_c: flight.arrival_temp_c,
      delay_forecast_mean_min: flight.delay_forecast_mean_min,
      aircraft: flight.aircraft_model,
      tail_number: flight.tail_number,
    };
  }

  getDelayForecast(flightNumber: string): DelayForecastRecord | null {
    assertValidFlightNumber(flightNumber);
    const flight = this.getFlight({ flight_number: flightNumber.trim() });
    if (!flight) return null;

    const obs = flight.delay_forecast_observations ?? 0;
    if (obs === 0) return null;

    const pct = (count: number | null) =>
      Math.round((1000 * (count ?? 0)) / obs) / 10;

    return {
      flight_number: flight.flight_number,
      route: `${flight.departure_airport_iata} -> ${flight.arrival_airport_iata}`,
      observations: obs,
      mean_delay_minutes: flight.delay_forecast_mean_min,
      early_pct: pct(flight.delayForecastEarlyCount),
      ontime_pct: pct(flight.delayForecastOntimeCount),
      late_15_pct: pct(flight.delayForecastLate15Count),
      late_30_pct: pct(flight.delayForecastLate30Count),
      late_45_pct: pct(flight.delayForecastLate45Count),
      cancelled_pct: pct(flight.delayForecastCanceledCount),
      diverted_pct: pct(flight.delayForecastDivertedCount),
    };
  }

  searchAirports(
    query: string,
    limit: number = DEFAULT_REFERENCE_LIMIT
  ): AirportRecord[] {
    assertValidBoundedQuery(query, "query");
    assertValidLimit(limit, MAX_REFERENCE_LIMIT);
    const q = query.trim();

    const db = this.getDb();
    try {
      return db
        .prepare(
          `SELECT id, name, iata, icao, city, country, countryCode, timeZoneIdentifier,
                  latitude, longitude, website
           FROM Airport
           WHERE deleted IS NULL
             AND (UPPER(iata) = UPPER(?)
                  OR UPPER(icao) = UPPER(?)
                  OR UPPER(name) LIKE UPPER(?)
                  OR UPPER(city) LIKE UPPER(?))
           ORDER BY
             CASE WHEN UPPER(iata) = UPPER(?) THEN 0
                  WHEN UPPER(icao) = UPPER(?) THEN 1
                  WHEN UPPER(city) = UPPER(?) THEN 2
                  ELSE 3 END,
             relevance DESC
           LIMIT ?`
        )
        .all(q, q, `%${q}%`, `%${q}%`, q, q, q, limit) as unknown as AirportRecord[];
    } finally {
      db.close();
    }
  }

  searchAirlines(
    query: string,
    limit: number = DEFAULT_REFERENCE_LIMIT
  ): AirlineRecord[] {
    assertValidBoundedQuery(query, "query");
    assertValidLimit(limit, MAX_REFERENCE_LIMIT);
    const q = query.trim();

    const db = this.getDb();
    try {
      return db
        .prepare(
          `SELECT id, name, iata, icao, alliance, website, callsign, formattedPhone
           FROM Airline
           WHERE deleted IS NULL
             AND (UPPER(iata) = UPPER(?)
                  OR UPPER(icao) = UPPER(?)
                  OR UPPER(name) LIKE UPPER(?)
                  OR UPPER(alliance) LIKE UPPER(?))
           ORDER BY relevance DESC
           LIMIT ?`
        )
        .all(q, q, `%${q}%`, `%${q}%`, limit) as unknown as AirlineRecord[];
    } finally {
      db.close();
    }
  }

  getFlightStats(year?: number): FlightStatsRecord {
    assertValidYear(year);

    const db = this.getDb();
    try {
      const ownerId = this.getOwnerUserId(db);
      let where =
        "WHERE uf.deleted IS NULL AND f.deleted IS NULL AND uf.isMyFlight = 1 AND uf.userId = ?";
      const binds: (string | number | null)[] = [ownerId];

      if (year) {
        const start = Math.floor(
          new Date(Date.UTC(year, 0, 1)).getTime() / 1000
        );
        const end = Math.floor(
          new Date(Date.UTC(year + 1, 0, 1)).getTime() / 1000
        );
        where +=
          " AND f.departureScheduleGateOriginal >= ? AND f.departureScheduleGateOriginal < ?";
        binds.push(start, end);
      }

      const totals = db
        .prepare(
          `${FLIGHT_UNION_CTE}
           SELECT
              COUNT(*) as total_flights,
              COALESCE(SUM(f.distance), 0) as total_distance_km,
              COUNT(DISTINCT dep.id) as unique_departure_airports,
              COUNT(DISTINCT arr.id) as unique_arrival_airports,
              COUNT(DISTINCT al.id) as unique_airlines,
              SUM(CASE WHEN f.isCancelled THEN 1 ELSE 0 END) as cancelled_flights,
              COALESCE(AVG(f.distance), 0) as avg_distance_km
           FROM flights_combined f
           JOIN Airport dep ON f.departureAirportId = dep.id
           JOIN Airport arr ON f.scheduledArrivalAirportId = arr.id
           JOIN Airline al ON f.airlineId = al.id
           JOIN user_flights_combined uf ON f.id = uf.flightId
           ${where}`
        )
        .get(...binds) as Record<string, number>;

      const topAirlines = db
        .prepare(
          `${FLIGHT_UNION_CTE}
           SELECT al.name, al.iata, COUNT(*) as flight_count
           FROM flights_combined f
           JOIN Airline al ON f.airlineId = al.id
           JOIN user_flights_combined uf ON f.id = uf.flightId
           ${where}
           GROUP BY al.id
           ORDER BY flight_count DESC
           LIMIT 5`
        )
        .all(...binds) as Array<{
        name: string;
        iata: string;
        flight_count: number;
      }>;

      const topRoutes = db
        .prepare(
          `${FLIGHT_UNION_CTE}
           SELECT dep.iata || ' -> ' || arr.iata as route, COUNT(*) as flight_count
           FROM flights_combined f
           JOIN Airport dep ON f.departureAirportId = dep.id
           JOIN Airport arr ON f.scheduledArrivalAirportId = arr.id
           JOIN user_flights_combined uf ON f.id = uf.flightId
           ${where}
           GROUP BY dep.id, arr.id
           ORDER BY flight_count DESC
           LIMIT 5`
        )
        .all(...binds) as Array<{ route: string; flight_count: number }>;

      // Countries visited = distinct set of departure and arrival countries.
      const countries = db
        .prepare(
          `${FLIGHT_UNION_CTE}
           SELECT COUNT(*) AS countries_visited FROM (
             SELECT dep.country AS country
             FROM flights_combined f
             JOIN Airport dep ON f.departureAirportId = dep.id
             JOIN user_flights_combined uf ON f.id = uf.flightId
             ${where}
             UNION
             SELECT arr.country AS country
             FROM flights_combined f
             JOIN Airport arr ON f.scheduledArrivalAirportId = arr.id
             JOIN user_flights_combined uf ON f.id = uf.flightId
             ${where}
           ) WHERE country IS NOT NULL`
        )
        .get(...binds, ...binds) as { countries_visited: number };

      const distKm = totals.total_distance_km ?? 0;
      const avgKm = totals.avg_distance_km ?? 0;

      return {
        year: year ?? "all_time",
        total_flights: totals.total_flights,
        total_distance_km: distKm,
        total_distance_miles: Math.round(distKm * KM_TO_MILES),
        avg_distance_km: Math.round(avgKm),
        avg_distance_miles: Math.round(avgKm * KM_TO_MILES),
        earth_circumnavigations: Math.round((distKm / EARTH_CIRCUMFERENCE_KM) * 100) / 100,
        unique_departure_airports: totals.unique_departure_airports,
        unique_arrival_airports: totals.unique_arrival_airports,
        unique_airlines: totals.unique_airlines,
        countries_visited: countries.countries_visited,
        cancelled_flights: totals.cancelled_flights,
        top_airlines: topAirlines,
        top_routes: topRoutes,
      };
    } finally {
      db.close();
    }
  }

  getConnections(params: PaginationParams = {}): ConnectionRecord[] {
    assertValidLimit(params.limit, MAX_PAGE_LIMIT);
    assertValidOffset(params.offset);

    const db = this.getDb();
    try {
      const ownerId = this.getOwnerUserId(db);
      const limit = params.limit ?? DEFAULT_PAGE_LIMIT;
      const offset = params.offset ?? 0;

      const rows = db
        .prepare(
          `${FLIGHT_UNION_CTE}
           SELECT
              c.id,
              al_in.iata || f_in.number AS inbound_flight,
              dep_in.iata AS from_airport,
              wait.iata AS connection_airport,
              wait.name AS connection_airport_name,
              al_out.iata || f_out.number AS outbound_flight,
              arr_out.iata AS to_airport,
              f_in.arrivalScheduleGateOriginal AS arrival_time,
              f_out.departureScheduleGateOriginal AS departure_time,
              c.mctMinutes AS min_connection_time_min
           FROM Connection c
           JOIN flights_combined f_in ON c.arrivingFlightId = f_in.id
           JOIN flights_combined f_out ON c.departingFlightId = f_out.id
           JOIN Airline al_in ON f_in.airlineId = al_in.id
           JOIN Airline al_out ON f_out.airlineId = al_out.id
           JOIN Airport dep_in ON f_in.departureAirportId = dep_in.id
           JOIN Airport arr_out ON f_out.scheduledArrivalAirportId = arr_out.id
           JOIN Airport wait ON c.waitingAirportId = wait.id
           JOIN user_flights_combined uf ON f_in.id = uf.flightId
           WHERE c.deleted IS NULL AND uf.deleted IS NULL AND uf.isMyFlight = 1 AND uf.userId = ?
           ORDER BY f_in.departureScheduleGateOriginal DESC
           LIMIT ? OFFSET ?`
        )
        .all(ownerId, limit, offset) as Array<Record<string, unknown>>;

      return rows.map((r) => {
        const arrTs = r.arrival_time as number | null;
        const depTs = r.departure_time as number | null;
        return {
          id: r.id as string,
          inbound_flight: r.inbound_flight as string,
          from_airport: r.from_airport as string,
          connection_airport: r.connection_airport as string,
          connection_airport_name: r.connection_airport_name as string,
          outbound_flight: r.outbound_flight as string,
          to_airport: r.to_airport as string,
          arrival_time: tsToIso(arrTs),
          departure_time: tsToIso(depTs),
          layover_minutes:
            arrTs != null && depTs != null
              ? Math.floor((depTs - arrTs) / 60)
              : 0,
          min_connection_time_min: r.min_connection_time_min as number | null,
        };
      });
    } finally {
      db.close();
    }
  }

  // IATA codes are not unique. Return every match, with airlines that appear
  // most often in the local flight database first.
  lookupAirlines(
    iata: string
  ): Array<{ id: string; name: string; iata: string }> {
    assertValidBoundedQuery(iata, "iata");
    const db = this.getDb();
    try {
      const rows = db
        .prepare(
          `SELECT a.id, a.name, a.iata,
                  (SELECT COUNT(*) FROM (
                     SELECT f.id FROM Flight f
                     WHERE f.airlineId = a.id AND f.deleted IS NULL
                     UNION ALL
                     SELECT mf.id FROM ManualFlight mf
                     WHERE mf.airlineId = a.id AND mf.deleted IS NULL
                   )) AS flightCount
           FROM Airline a
           WHERE UPPER(a.iata) = ? AND a.deleted IS NULL
           ORDER BY flightCount DESC, a.name`
        )
        .all(iata.trim().toUpperCase()) as Array<{
        id: string;
        name: string;
        iata: string;
      }>;
      if (rows.length === 0) {
        throw new Error(
          `Airline with IATA code '${iata.trim()}' not found in Flighty database.`
        );
      }
      return rows.map(({ id, name, iata }) => ({ id, name, iata }));
    } finally {
      db.close();
    }
  }
}
