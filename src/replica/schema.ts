import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isValidUuid } from "../services/validation.js";
import { MAX_SYNC_INFO_ROWS } from "../services/freshness.js";
import { createReplicaError } from "./cleanup.js";
import type {
  ReplicaColumnAffinity,
  ReplicaColumnSpec,
  ReplicaManifest,
  ReplicaTableName,
  ReplicaTableSpec,
  ReplicaValidationLimits,
} from "./types.js";

export const REPLICA_SCHEMA_VERSION = "flighty-replica-schema-v1";

export const DEFAULT_MAX_DB_BYTES = 64 * 1024 * 1024; // 64 MiB
export const DEFAULT_MAX_ROWS_PER_TABLE = 100_000;
export const DEFAULT_MAX_TOTAL_ROWS = 250_000;
export const DEFAULT_MAX_STRING_LENGTH = 4_096;
export const DEFAULT_MAX_CAPTURE_DURATION_MS = 10 * 60 * 1000; // 10 minutes
export const DEFAULT_MAX_FUTURE_SKEW_MS = 0;

function col(
  name: string,
  affinity: ReplicaColumnAffinity
): ReplicaColumnSpec {
  return Object.freeze({
    name,
    affinity,
    declType: affinity === "ANY" ? "" : affinity,
  });
}

const FLIGHT_COMMON_PREFIX: readonly ReplicaColumnSpec[] = [
  col("id", "TEXT"),
  col("number", "TEXT"),
  col("airlineId", "TEXT"),
  col("departureAirportId", "TEXT"),
  col("scheduledArrivalAirportId", "TEXT"),
  col("departureTerminal", "TEXT"),
  col("departureGate", "TEXT"),
];

export const FLIGHT_COLUMNS: readonly ReplicaColumnSpec[] = Object.freeze([
  ...FLIGHT_COMMON_PREFIX,
  col("departureScheduleGateOriginal", "INTEGER"),
  col("departureScheduleGateEstimated", "INTEGER"),
  col("departureScheduleGateActual", "INTEGER"),
  col("departureScheduleRunwayOriginal", "INTEGER"),
  col("departureScheduleRunwayEstimated", "INTEGER"),
  col("departureScheduleRunwayActual", "INTEGER"),
  col("arrivalTerminal", "TEXT"),
  col("arrivalGate", "TEXT"),
  col("arrivalBaggageBelt", "TEXT"),
  col("arrivalScheduleGateOriginal", "INTEGER"),
  col("arrivalScheduleGateEstimated", "INTEGER"),
  col("arrivalScheduleGateActual", "INTEGER"),
  col("arrivalScheduleRunwayOriginal", "INTEGER"),
  col("arrivalScheduleRunwayEstimated", "INTEGER"),
  col("arrivalScheduleRunwayActual", "INTEGER"),
  col("isCancelled", "INTEGER"),
  col("distance", "REAL"),
  col("equipmentTailNumber", "TEXT"),
  col("equipmentModelName", "TEXT"),
  col("equipmentManufacturer", "TEXT"),
  col("equipmentPlaneName", "TEXT"),
  col("equipmentCruisingSpeed", "REAL"),
  col("arrivalWeatherConditionName", "TEXT"),
  col("arrivalWeatherTemperature", "REAL"),
  col("delayForecastDelayMean", "REAL"),
  col("delayForecastObservations", "INTEGER"),
  col("delayForecastEarlyCount", "INTEGER"),
  col("delayForecastOntimeCount", "INTEGER"),
  col("delayForecastLate15Count", "INTEGER"),
  col("delayForecastLate30Count", "INTEGER"),
  col("delayForecastLate45Count", "INTEGER"),
  col("delayForecastCanceledCount", "INTEGER"),
  col("delayForecastDivertedCount", "INTEGER"),
  col("checkInScheduleOpen", "INTEGER"),
  col("checkInScheduleClose", "INTEGER"),
  col("deleted", "INTEGER"),
]);

export const MANUAL_FLIGHT_COLUMNS: readonly ReplicaColumnSpec[] = Object.freeze([
  ...FLIGHT_COMMON_PREFIX,
  col("departureScheduleGateOriginal", "INTEGER"),
  col("departureScheduleGateActual", "INTEGER"),
  col("departureScheduleRunwayOriginal", "INTEGER"),
  col("departureScheduleRunwayActual", "INTEGER"),
  col("arrivalTerminal", "TEXT"),
  col("arrivalGate", "TEXT"),
  col("arrivalBaggageBelt", "TEXT"),
  col("arrivalScheduleGateOriginal", "INTEGER"),
  col("arrivalScheduleGateActual", "INTEGER"),
  col("arrivalScheduleRunwayOriginal", "INTEGER"),
  col("arrivalScheduleRunwayActual", "INTEGER"),
  col("isCancelled", "INTEGER"),
  col("distance", "REAL"),
  col("equipmentTailNumber", "TEXT"),
  col("equipmentModelName", "TEXT"),
  col("equipmentManufacturer", "TEXT"),
  col("equipmentPlaneName", "TEXT"),
  col("equipmentCruisingSpeed", "REAL"),
  col("arrivalWeatherConditionName", "TEXT"),
  col("arrivalWeatherTemperature", "REAL"),
  col("delayForecastDelayMean", "REAL"),
  col("delayForecastObservations", "INTEGER"),
  col("delayForecastEarlyCount", "INTEGER"),
  col("delayForecastOntimeCount", "INTEGER"),
  col("delayForecastLate15Count", "INTEGER"),
  col("delayForecastLate30Count", "INTEGER"),
  col("delayForecastLate45Count", "INTEGER"),
  col("delayForecastCanceledCount", "INTEGER"),
  col("delayForecastDivertedCount", "INTEGER"),
  col("deleted", "INTEGER"),
]);

export const USER_FLIGHT_COLUMNS: readonly ReplicaColumnSpec[] = Object.freeze([
  col("userId", "TEXT"),
  col("flightId", "TEXT"),
  col("importSource", "TEXT"),
  col("deleted", "INTEGER"),
  col("isMyFlight", "INTEGER"),
]);

export const AIRPORT_COLUMNS: readonly ReplicaColumnSpec[] = Object.freeze([
  col("id", "TEXT"),
  col("name", "TEXT"),
  col("iata", "TEXT"),
  col("icao", "TEXT"),
  col("city", "TEXT"),
  col("country", "TEXT"),
  col("countryCode", "TEXT"),
  col("timeZoneIdentifier", "TEXT"),
  col("latitude", "REAL"),
  col("longitude", "REAL"),
  col("website", "TEXT"),
  col("relevance", "INTEGER"),
  col("deleted", "INTEGER"),
]);

export const AIRLINE_COLUMNS: readonly ReplicaColumnSpec[] = Object.freeze([
  col("id", "TEXT"),
  col("name", "TEXT"),
  col("iata", "TEXT"),
  col("icao", "TEXT"),
  col("alliance", "TEXT"),
  col("website", "TEXT"),
  col("callsign", "TEXT"),
  col("formattedPhone", "TEXT"),
  col("relevance", "INTEGER"),
  col("deleted", "INTEGER"),
]);

export const TICKET_COLUMNS: readonly ReplicaColumnSpec[] = Object.freeze([
  col("flightId", "TEXT"),
  col("userId", "TEXT"),
  col("seatNumber", "TEXT"),
  col("seatPosition", "TEXT"),
  col("cabinClass", "TEXT"),
  col("pnr", "TEXT"),
  col("flightReason", "TEXT"),
]);

export const PROFILE_COLUMNS: readonly ReplicaColumnSpec[] = Object.freeze([
  col("userId", "TEXT"),
  col("fullName", "TEXT"),
  col("firstName", "TEXT"),
]);

export const CONNECTION_COLUMNS: readonly ReplicaColumnSpec[] = Object.freeze([
  col("id", "TEXT"),
  col("arrivingFlightId", "TEXT"),
  col("departingFlightId", "TEXT"),
  col("waitingAirportId", "TEXT"),
  col("mctMinutes", "INTEGER"),
  col("deleted", "INTEGER"),
]);

export const SYNC_INFO_COLUMNS: readonly ReplicaColumnSpec[] = Object.freeze([
  col("lastSync", "ANY"),
]);

export const REPLICA_TABLE_NAMES: readonly ReplicaTableName[] = Object.freeze([
  "Airline",
  "Airport",
  "Connection",
  "Flight",
  "ManualFlight",
  "Profile",
  "SyncInfo",
  "Ticket",
  "UserFlight",
  "UserManualFlight",
]);

export const REPLICA_TABLES: Readonly<Record<ReplicaTableName, ReplicaTableSpec>> =
  Object.freeze({
    Airline: Object.freeze({
      name: "Airline",
      columns: AIRLINE_COLUMNS,
      hasDeletedColumn: true,
    }),
    Airport: Object.freeze({
      name: "Airport",
      columns: AIRPORT_COLUMNS,
      hasDeletedColumn: true,
    }),
    Connection: Object.freeze({
      name: "Connection",
      columns: CONNECTION_COLUMNS,
      hasDeletedColumn: true,
    }),
    Flight: Object.freeze({
      name: "Flight",
      columns: FLIGHT_COLUMNS,
      hasDeletedColumn: true,
    }),
    ManualFlight: Object.freeze({
      name: "ManualFlight",
      columns: MANUAL_FLIGHT_COLUMNS,
      hasDeletedColumn: true,
    }),
    Profile: Object.freeze({
      name: "Profile",
      columns: PROFILE_COLUMNS,
      hasDeletedColumn: false,
    }),
    SyncInfo: Object.freeze({
      name: "SyncInfo",
      columns: SYNC_INFO_COLUMNS,
      hasDeletedColumn: false,
    }),
    Ticket: Object.freeze({
      name: "Ticket",
      columns: TICKET_COLUMNS,
      hasDeletedColumn: false,
    }),
    UserFlight: Object.freeze({
      name: "UserFlight",
      columns: USER_FLIGHT_COLUMNS,
      hasDeletedColumn: true,
    }),
    UserManualFlight: Object.freeze({
      name: "UserManualFlight",
      columns: USER_FLIGHT_COLUMNS,
      hasDeletedColumn: true,
    }),
  });

export function buildCreateTableSql(spec: ReplicaTableSpec): string {
  const colsSql = spec.columns
    .map((c) => (c.declType ? `${c.name} ${c.declType}` : c.name))
    .join(", ");
  return `CREATE TABLE ${spec.name} (${colsSql})`;
}

export const CREATE_REPLICA_SCHEMA_SQL: string = REPLICA_TABLE_NAMES.map(
  (name) => `${buildCreateTableSql(REPLICA_TABLES[name])};`
).join("\n");

export const REPLICA_SCHEMA_HASH: string = createHash("sha256")
  .update(
    JSON.stringify({
      version: REPLICA_SCHEMA_VERSION,
      tables: REPLICA_TABLE_NAMES.map((name) => ({
        name,
        ddl: buildCreateTableSql(REPLICA_TABLES[name]),
        columns: REPLICA_TABLES[name].columns.map((c) => ({
          name: c.name,
          affinity: c.affinity,
          declType: c.declType,
        })),
      })),
    }),
    "utf8"
  )
  .digest("hex");

export const FORBIDDEN_SOURCE_TABLES = Object.freeze([
  "Account",
  "ZUSER",
]);

export const FORBIDDEN_SOURCE_COLUMNS = Object.freeze([
  "authToken",
  "ZTOKEN",
  "nextURL",
]);

const FORBIDDEN_LAST_SYNC_PATTERNS = [
  /https?:\/\//i,
  /\bBearer\b/i,
  /\beyJ[A-Za-z0-9_-]+\./,
  /\b(?:authToken|ZTOKEN|nextURL)\b/i,
  /[?&]/,
];

/**
 * Checks whether a value in `SyncInfo.lastSync` is safe to include in a replica.
 * Preserves null, finite numbers (for unverified numeric sync markers), and bounded non-secret strings.
 */
export function isSafeLastSyncValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value === "bigint") {
    return true;
  }
  if (typeof value !== "string") {
    return false;
  }
  if (value.length > 128) {
    return false;
  }
  for (const pat of FORBIDDEN_LAST_SYNC_PATTERNS) {
    if (pat.test(value)) {
      return false;
    }
  }
  return true;
}

/**
 * Sanitizes a source `SyncInfo.lastSync` value so URLs, tokens, or binary blobs
 * can never be exported through `SyncInfo.lastSync`.
 */
export function sanitizeLastSyncValue(
  value: unknown
): string | number | bigint | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    if (!isSafeLastSyncValue(trimmed)) {
      return null;
    }
    return trimmed;
  }
  return null;
}

export interface SourceSchemaInspection {
  readonly ticketHasDeletedColumn: boolean;
  readonly profileHasDeletedColumn: boolean;
}

/**
 * Validates that the source backup database contains every required table and allowlisted column.
 * Never echoes unallowlisted column/table names, paths, or cell contents.
 */
export function validateSourceDatabaseSchema(
  sourceDb: DatabaseSync
): SourceSchemaInspection {
  const existingTables = new Set<string>();
  let objects = 0;
  for (const row of sourceDb.prepare("PRAGMA table_list").iterate()) {
    if (++objects > 1024) throw createReplicaError("SOURCE_SCHEMA_INVALID", "Source schema object budget exceeded.");
    if ((REPLICA_TABLE_NAMES as readonly unknown[]).includes(row.name)) {
      if (row.type !== "table" || row.schema !== "main") throw createReplicaError("SOURCE_SCHEMA_INVALID", "Source allowlist requires ordinary main tables.");
      existingTables.add(row.name as string);
    }
  }
  for (const name of REPLICA_TABLE_NAMES) {
    const ddl = sourceDb.prepare("SELECT substr(sql, 1, 65537) AS sql FROM sqlite_master WHERE name = ? AND type = 'table'").get(name)?.sql;
    if (typeof ddl !== "string" || ddl.length > 65536 || !/^CREATE\s+TABLE\b/i.test(ddl) || /\b(?:CHECK|GENERATED|VIRTUAL|REFERENCES|COLLATE|DEFAULT|AS)\b|--|\/\*/i.test(ddl)) {
      throw createReplicaError("SOURCE_SCHEMA_INVALID", "Source missing required ordinary table or contains unsafe schema expressions.");
    }
  }

  let ticketHasDeletedColumn = false;
  let profileHasDeletedColumn = false;

  for (const tableName of REPLICA_TABLE_NAMES) {
    if (!existingTables.has(tableName)) {
      throw createReplicaError(
        "SOURCE_SCHEMA_INVALID",
        `Source database schema validation failed: missing required table '${tableName}'.`
      );
    }

    const spec = REPLICA_TABLES[tableName];
    let tableInfo: Array<{ name?: unknown; hidden?: unknown }>;
    try {
      tableInfo = sourceDb
        .prepare(`PRAGMA table_xinfo(${tableName})`)
        .all() as Array<{ name?: unknown }>;
    } catch {
      throw createReplicaError(
        "SOURCE_SCHEMA_INVALID",
        `Source database schema validation failed: could not inspect columns of '${tableName}'.`
      );
    }

    const colSet = new Set<string>();
    for (const colRow of tableInfo) {
      if (colRow.hidden !== 0) throw createReplicaError("SOURCE_SCHEMA_INVALID", "Generated or hidden source columns are forbidden.");
      if (typeof colRow.name === "string") {
        colSet.add(colRow.name);
      }
    }

    for (const requiredCol of spec.columns) {
      if (!colSet.has(requiredCol.name)) {
        throw createReplicaError(
          "SOURCE_SCHEMA_INVALID",
          `Source database schema validation failed: table '${tableName}' is missing required column '${requiredCol.name}'.`
        );
      }
    }

    if (tableName === "Ticket" && colSet.has("deleted")) {
      ticketHasDeletedColumn = true;
    }
    if (tableName === "Profile" && colSet.has("deleted")) {
      profileHasDeletedColumn = true;
    }
  }

  return {
    ticketHasDeletedColumn,
    profileHasDeletedColumn,
  };
}

/**
 * Validates that a candidate replica database matches the exact static allowlist schema,
 * has zero views/triggers/indexes/unknown tables/unknown columns, passes integrity check,
 * matches signed row counts, obeys size/row/type bounds, and contains no soft-deleted or
 * out-of-scope friend-followed rows.
 */
export function validateReplicaDatabaseSchemaAndContents(
  db: DatabaseSync,
  manifest: ReplicaManifest,
  limits: ReplicaValidationLimits = {}
): void {
  const maxRowsPerTable =
    limits.maxRowsPerTable ?? DEFAULT_MAX_ROWS_PER_TABLE;
  const maxTotalRows = limits.maxTotalRows ?? DEFAULT_MAX_TOTAL_ROWS;
  const maxStringLength =
    limits.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;

  // 2. Inspect sqlite_master: reject any views, triggers, indexes, virtual tables, or unknown tables.
  const schemaObjects = db
    .prepare("SELECT type, name, tbl_name, substr(sql, 1, 65537) AS sql FROM sqlite_master LIMIT 11")
    .all() as Array<{
    type?: unknown;
    name?: unknown;
    tbl_name?: unknown;
    sql?: unknown;
  }>;

  const foundTables = new Map<string, string>();
  for (const obj of schemaObjects) {
    const objType = typeof obj.type === "string" ? obj.type : "";
    const objName = typeof obj.name === "string" ? obj.name : "";
    const objSql = typeof obj.sql === "string" ? obj.sql.trim() : "";

    if (objType !== "table") {
      throw createReplicaError(
        "DB_SCHEMA_INVALID",
        `Replica database contains forbidden schema object type '${objType || "unknown"}' (views, triggers, and extra indexes are forbidden).`
      );
    }

    if (objName.startsWith("sqlite_")) {
      throw createReplicaError(
        "DB_SCHEMA_INVALID",
        "Replica database contains forbidden internal sqlite_ table."
      );
    }

    if (
      !(REPLICA_TABLE_NAMES as readonly string[]).includes(objName)
    ) {
      throw createReplicaError(
        "DB_SCHEMA_INVALID",
        "Replica database contains an unallowlisted table."
      );
    }

    if (foundTables.has(objName)) {
      throw createReplicaError(
        "DB_SCHEMA_INVALID",
        `Duplicate schema entry for table '${objName}'.`
      );
    }
    foundTables.set(objName, objSql);
  }

  if (foundTables.size !== REPLICA_TABLE_NAMES.length) {
    throw createReplicaError(
      "DB_SCHEMA_INVALID",
      `Replica database must contain exactly ${REPLICA_TABLE_NAMES.length} allowlisted tables; found ${foundTables.size}.`
    );
  }

  // 3. Verify exact CREATE TABLE DDL and PRAGMA table_info for every allowlisted table.
  for (const tableName of REPLICA_TABLE_NAMES) {
    const spec = REPLICA_TABLES[tableName];
    const expectedSql = buildCreateTableSql(spec);
    const actualSql = foundTables.get(tableName);
    if (actualSql !== expectedSql) {
      throw createReplicaError(
        "DB_SCHEMA_INVALID",
        `Replica table '${tableName}' DDL does not match static allowlist schema.`
      );
    }

    const cols = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
      cid?: unknown;
      name?: unknown;
      type?: unknown;
      notnull?: unknown;
      dflt_value?: unknown;
      pk?: unknown;
    }>;

    if (cols.length !== spec.columns.length) {
      throw createReplicaError(
        "DB_SCHEMA_INVALID",
        `Replica table '${tableName}' column count (${cols.length}) does not match allowlist (${spec.columns.length}).`
      );
    }

    for (let i = 0; i < spec.columns.length; i++) {
      const expectedCol = spec.columns[i];
      const actualCol = cols[i];
      if (
        actualCol.name !== expectedCol.name ||
        (actualCol.type ?? "") !== expectedCol.declType ||
        actualCol.notnull !== 0 ||
        actualCol.dflt_value !== null ||
        actualCol.pk !== 0
      ) {
        throw createReplicaError(
          "DB_SCHEMA_INVALID",
          `Replica table '${tableName}' column '${expectedCol.name}' definition does not match allowlist.`
        );
      }
    }
  }

  // 1. SQLite integrity check
  let integrityRow: { quick_check?: unknown } | undefined;
  try {
    integrityRow = db.prepare("PRAGMA quick_check(1)").get() as
      | { quick_check?: unknown }
      | undefined;
  } catch {
    throw createReplicaError(
      "DB_INTEGRITY_FAILED",
      "Replica SQLite database failed PRAGMA quick_check."
    );
  }
  if (!integrityRow || integrityRow.quick_check !== "ok") {
    throw createReplicaError(
      "DB_INTEGRITY_FAILED",
      "Replica SQLite database failed integrity verification."
    );
  }

  // 4. Verify row counts and row contents for each table.
  let totalRows = 0;

  const content = {} as Record<ReplicaTableName, Record<string, unknown>[]>;
  for (const tableName of REPLICA_TABLE_NAMES) {
    const spec = REPLICA_TABLES[tableName];
    const expectedCount = manifest.rowCounts[tableName];
    if (
      typeof expectedCount !== "number" ||
      !Number.isSafeInteger(expectedCount) ||
      expectedCount < 0
    ) {
      throw createReplicaError(
        "MANIFEST_INVALID",
        `Manifest row count for '${tableName}' is invalid.`
      );
    }

    if (expectedCount > maxRowsPerTable) {
      throw createReplicaError(
        "DB_CONTENT_INVALID",
        `Table '${tableName}' row count (${expectedCount}) exceeds maximum allowed (${maxRowsPerTable}).`
      );
    }

    if (tableName === "SyncInfo" && expectedCount > MAX_SYNC_INFO_ROWS) {
      throw createReplicaError(
        "DB_CONTENT_INVALID",
        `Table 'SyncInfo' row count (${expectedCount}) exceeds MAX_SYNC_INFO_ROWS (${MAX_SYNC_INFO_ROWS}).`
      );
    }

    const rows = readBoundedRows(db, tableName, spec.columns, "", limits);
    const actualCount = rows.length;
    content[tableName] = rows;
    if (actualCount !== expectedCount) throw createReplicaError("DB_CONTENT_INVALID", "Replica row count disagrees with signed manifest.");
    totalRows += actualCount;
    if (totalRows > maxTotalRows) throw createReplicaError("DB_CONTENT_INVALID", "Replica total row budget exceeded.");

    for (const row of rows) {
      for (const colSpec of spec.columns) {
        const val = row[colSpec.name];
        if (val === null || val === undefined) {
          continue;
        }

        if (colSpec.name === "deleted" && tableName !== "Airport" && tableName !== "Airline") {
          throw createReplicaError(
            "DB_CONTENT_INVALID",
            `Replica table '${tableName}' contains a soft-deleted row (deleted IS NOT NULL).`
          );
        }

        if (colSpec.affinity === "TEXT") {
          if (typeof val !== "string") {
            throw createReplicaError(
              "DB_CONTENT_INVALID",
              `Invalid non-string value in '${tableName}.${colSpec.name}'.`
            );
          }
          if (val.length > maxStringLength) {
            throw createReplicaError(
              "DB_CONTENT_INVALID",
              `String value in '${tableName}.${colSpec.name}' exceeds maximum length (${maxStringLength}).`
            );
          }
        } else if (colSpec.affinity === "INTEGER") {
          if (
            typeof val !== "number" ||
            !Number.isSafeInteger(val)
          ) {
            throw createReplicaError(
              "DB_CONTENT_INVALID",
              `Invalid non-integer value in '${tableName}.${colSpec.name}'.`
            );
          }
        } else if (colSpec.affinity === "REAL") {
          if (typeof val !== "number" || !Number.isFinite(val)) {
            throw createReplicaError(
              "DB_CONTENT_INVALID",
              `Invalid non-numeric value in '${tableName}.${colSpec.name}'.`
            );
          }
        } else if (colSpec.affinity === "ANY") {
          if (!isSafeLastSyncValue(val)) {
            throw createReplicaError(
              "DB_CONTENT_INVALID",
              `Unsafe or invalid value in '${tableName}.${colSpec.name}'.`
            );
          }
        }
      }

      if (tableName === "UserFlight" || tableName === "UserManualFlight") {
        const userId = row.userId;
        const flightId = row.flightId;
        const isMyFlight = row.isMyFlight;
        if (
          typeof userId !== "string" ||
          userId.trim().length === 0 ||
          typeof flightId !== "string" ||
          flightId.trim().length === 0
        ) {
          throw createReplicaError(
            "DB_CONTENT_INVALID",
            `Replica '${tableName}' row is missing userId or flightId.`
          );
        }

        const isOwnerRow =
          userId === manifest.ownerUserId &&
          (isMyFlight === 0 || isMyFlight === 1);
        const isSharedPassengerRow =
          manifest.includeSharedPassengers &&
          userId !== manifest.ownerUserId &&
          isMyFlight === 1;

        if (!isOwnerRow && !isSharedPassengerRow) {
          throw createReplicaError(
            "DB_CONTENT_INVALID",
            `Replica '${tableName}' contains an out-of-scope or unrelated friend-followed row.`
          );
        }
      }
    }
  }
  validateLogicalScope(content, manifest);
}

export function normalizeLogicalId(value: unknown): unknown {
  return typeof value === "string" && isValidUuid(value) ? value.toLowerCase() : value;
}

/** Fixed ordinary-table scans bound JS allocations before any cell crosses the boundary. */
export function readBoundedRows(db: DatabaseSync, table: ReplicaTableName, columns: readonly ReplicaColumnSpec[], where = "", limits: ReplicaValidationLimits = {}, normalizeIds = false): Record<string, unknown>[] {
  const maxRows = table === "SyncInfo" ? Math.min(MAX_SYNC_INFO_ROWS, limits.maxRowsPerTable ?? DEFAULT_MAX_ROWS_PER_TABLE) : limits.maxRowsPerTable ?? DEFAULT_MAX_ROWS_PER_TABLE;
  const maxCell = limits.maxCellBytes ?? 16384;
  const maxBytes = limits.maxSourceDbBytes ?? limits.maxDbBytes ?? DEFAULT_MAX_DB_BYTES;
  const maxMs = limits.maxOperationDurationMs ?? 30000;
  const start = performance.now();
  const oversized = columns.map(c => `length(CAST(${c.name} AS BLOB)) > ${maxCell}`).join(" OR ");
  const selected = columns.map(c => `CASE WHEN length(CAST(${c.name} AS BLOB)) > ${maxCell} THEN NULL ELSE ${c.name} END AS ${c.name}`).join(", ");
  const rows: Record<string, unknown>[] = [];
  let bytes = 0;
  for (const row of db.prepare(`SELECT ${selected}, (${oversized}) AS __oversize FROM ${table} NOT INDEXED ${where} LIMIT ${maxRows + 1}`).iterate()) {
    if (row.__oversize || rows.length >= maxRows || performance.now() - start > maxMs) throw createReplicaError("EXPORT_BOUNDS_EXCEEDED", "SQLite row, cell, or work budget exceeded.");
    delete row.__oversize;
    for (const [key, value] of Object.entries(row)) {
      bytes += typeof value === "string" ? Buffer.byteLength(value) : 8;
      if (key === "id" || key.endsWith("Id")) {
        if (!normalizeIds && normalizeLogicalId(value) !== value) throw createReplicaError("DB_CONTENT_INVALID", "Replica identifiers must use canonical UUID case.");
        if (normalizeIds) row[key] = normalizeLogicalId(value) as never;
      }
    }
    if (bytes > maxBytes) throw createReplicaError("EXPORT_BOUNDS_EXCEEDED", "SQLite materialization byte budget exceeded.");
    rows.push(row);
  }
  return rows;
}

function validateLogicalScope(content: Record<ReplicaTableName, Record<string, unknown>[]>, manifest: ReplicaManifest): void {
  const fail = () => { throw createReplicaError("DB_CONTENT_INVALID", "Replica logical keys or selection closure are invalid."); };
  const key = (v: unknown): string => {
    if (typeof v !== "string" || !v.trim() || v.includes("\0") || normalizeLogicalId(v) !== v) fail();
    return v as string;
  };
  const pair = (a: unknown, b: unknown) => JSON.stringify([key(a), key(b)]);
  const unique = (rows: Record<string, unknown>[], get: (r: Record<string, unknown>) => string) => {
    const keys = new Set<string>();
    for (const row of rows) { const k = get(row); if (keys.has(k)) fail(); keys.add(k); }
    return keys;
  };
  const flights = unique([...content.Flight, ...content.ManualFlight], r => key(r.id));
  const airports = unique(content.Airport, r => key(r.id));
  const airlines = unique(content.Airline, r => key(r.id));
  const tracked = new Set<string>(), owners = new Set<string>(), passengers = new Set<string>();
  const associations = new Set<string>();
  for (const [table, flightTable] of [["UserFlight", "Flight"], ["UserManualFlight", "ManualFlight"]] as const) {
    const typed = new Set(content[flightTable].map(r => key(r.id)));
    unique(content[table], r => pair(r.flightId, r.userId));
    for (const row of content[table]) {
      const fid = key(row.flightId), uid = key(row.userId);
      if (!typed.has(fid)) fail();
      if (!(uid === manifest.ownerUserId && (row.isMyFlight === 0 || row.isMyFlight === 1)) && !(manifest.includeSharedPassengers && uid !== manifest.ownerUserId && row.isMyFlight === 1)) fail();
      tracked.add(fid); associations.add(pair(fid, uid));
      if (row.isMyFlight === 1) { passengers.add(uid); if (uid === manifest.ownerUserId) owners.add(fid); }
    }
  }
  const needed = new Set(tracked);
  unique(content.Connection, r => r.id === null ? JSON.stringify([key(r.arrivingFlightId), key(r.departingFlightId), r.waitingAirportId]) : key(r.id));
  for (const row of content.Connection) {
    const a = key(row.arrivingFlightId), b = key(row.departingFlightId);
    if (!flights.has(a) || !flights.has(b) || !(owners.has(a) || (tracked.has(a) && tracked.has(b)))) fail();
    if (row.waitingAirportId !== null && !airports.has(key(row.waitingAirportId))) fail();
    needed.add(a); needed.add(b);
  }
  for (const row of [...content.Flight, ...content.ManualFlight]) {
    if (!needed.has(key(row.id)) || !airlines.has(key(row.airlineId)) || !airports.has(key(row.departureAirportId)) || !airports.has(key(row.scheduledArrivalAirportId))) fail();
  }
  unique(content.Ticket, r => pair(r.flightId, r.userId));
  for (const row of content.Ticket) if (!associations.has(pair(row.flightId, row.userId))) fail();
  unique(content.Profile, r => key(r.userId));
  for (const row of content.Profile) if (!passengers.has(key(row.userId))) fail();
}

export function validateLimits(limits: ReplicaValidationLimits): void {
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1 || value > 1024 * 1024 * 1024) throw createReplicaError("INVALID_CONFIG", "Replica limits must be bounded positive safe integers.");
}
