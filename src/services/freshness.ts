import { existsSync } from "node:fs";
import { DatabaseSync as Database } from "node:sqlite";
import { MAIN_DB_PATH } from "../constants.js";

export type FreshnessStatus = "known" | "unknown" | "not_applicable";

export type FreshnessScope =
  | "database_sync"
  | "static_or_reference_data"
  | "error_or_validation";

export type FreshnessUnknownReasonCode =
  | "unverified_numeric_sync_format"
  | "future_sync_timestamp"
  | "invalid_or_ambiguous_sync_timestamp"
  | "missing_database"
  | "missing_sync_table"
  | "missing_last_sync_column"
  | "missing_sync_row"
  | "empty_last_sync_marker"
  | "database_read_error"
  | "not_applicable_static_or_reference_tool"
  | "error_response_sync_not_queried";

export interface FreshnessMetadata {
  /**
   * UTC ISO-8601 timestamp when this MCP server handled the tool invocation
   * (or constructed an early error response), not an exact SQLite snapshot timestamp
   * and not when Flighty synced with remote servers.
   */
  queried_at: string;
  /**
   * Clarifies that queried_at is the local MCP invocation/error handling time,
   * not an exact SQLite snapshot read time and not a remote sync timestamp.
   */
  queried_at_meaning: string;
  /**
   * UTC ISO-8601 timestamp from SyncInfo.lastSync when it is a verified, unambiguous
   * ISO-8601 timestamp with an explicit timezone and not in the future; otherwise null.
   */
  last_synced_at: string | null;
  /**
   * Age in whole seconds between last_synced_at and queried_at when last_synced_at is known;
   * null when last_synced_at is unknown, future, or not applicable.
   */
  sync_age_seconds: number | null;
  /**
   * Age in minutes (rounded to 2 decimal places) between last_synced_at and queried_at
   * when last_synced_at is known; null when last_synced_at is unknown, future, or not applicable.
   */
  sync_age_minutes: number | null;
  /**
   * Whether database sync timestamp is "known", "unknown", or "not_applicable".
   */
  status: FreshnessStatus;
  /**
   * Data source used for freshness metadata ("SyncInfo.lastSync" or "none").
   */
  source: "SyncInfo.lastSync" | "none";
  /**
   * Scope of the sync marker: database-level marker, never an identified account or per-flight confirmation.
   */
  scope: FreshnessScope;
  /**
   * Explicit statement that SyncInfo.lastSync is a database-level marker that does not select
   * an account identifier and does not confirm that any individual flight record was refreshed.
   */
  scope_note: string;
  /**
   * Machine-readable reason code when last_synced_at is null; null when status is "known".
   */
  unknown_reason_code: FreshnessUnknownReasonCode | null;
  /**
   * Human-readable explanation when last_synced_at is null; null when status is "known".
   * Static text only — never includes raw marker values, filesystem paths, URLs, or credentials.
   */
  unknown_reason: string | null;
  /**
   * True only when SyncInfo.lastSync contained a valid ISO-8601 timestamp that lies in the future
   * relative to queried_at (clock skew or invalid future marker).
   */
  is_future_marker: boolean;
  /**
   * Constant reminder that MCP reads query the local SQLite cache on disk and do not trigger
   * a live network sync with Flighty servers.
   */
  cache_note: string;
}

export const QUERIED_AT_MEANING =
  "UTC timestamp when this MCP server handled the tool invocation (or constructed an early error response), not an exact SQLite snapshot timestamp and not when Flighty last synced with remote servers.";

export const FRESHNESS_DATABASE_SCOPE_NOTE =
  "Database-level sync marker from SyncInfo.lastSync only (does not select or verify an account identifier, and does not confirm that any individual flight record was recently refreshed).";

export const FRESHNESS_ACCOUNT_SCOPE_NOTE = FRESHNESS_DATABASE_SCOPE_NOTE;

export const FRESHNESS_STATIC_SCOPE_NOTE =
  "Static server metadata and bundled airport/airline reference lookups do not depend on SyncInfo.lastSync or per-flight sync state.";

export const FRESHNESS_ERROR_SCOPE_NOTE =
  "Tool execution returned an error or failed input validation; database sync state was not queried.";

export const FRESHNESS_LOCAL_CACHE_NOTE =
  "Reads come from the local Flighty SQLite cache on disk and do not trigger a live network refresh. Re-querying reads the latest committed local cache without resetting last_synced_at.";

export const MAX_SYNC_INFO_ROWS = 32;

const STATIC_UNKNOWN_REASONS: Readonly<Record<FreshnessUnknownReasonCode, string>> = {
  unverified_numeric_sync_format:
    "unverified_numeric_sync_format: SyncInfo.lastSync is stored in a numeric format whose epoch or unit definition (Unix seconds, Unix milliseconds, Apple Core Data 2001 reference time, or sequence counter) is unverified.",
  future_sync_timestamp:
    "future_sync_timestamp: SyncInfo.lastSync timestamp is in the future relative to queried_at; refusing to report a negative or fresh sync age.",
  invalid_or_ambiguous_sync_timestamp:
    "invalid_or_ambiguous_sync_timestamp: SyncInfo.lastSync is not an unambiguous ISO-8601 timestamp with an explicit timezone designator within the bounded SyncInfo scan.",
  missing_database:
    "missing_database: Local Flighty SQLite database file is unavailable at the configured path.",
  missing_sync_table:
    "missing_sync_table: SyncInfo table is not present in the local Flighty SQLite database.",
  missing_last_sync_column:
    "missing_last_sync_column: SyncInfo.lastSync column is not present in the local Flighty SQLite database.",
  missing_sync_row:
    "missing_sync_row: SyncInfo table contains no rows in the local Flighty SQLite database.",
  empty_last_sync_marker:
    "empty_last_sync_marker: SyncInfo.lastSync is null or empty in the local Flighty SQLite database.",
  database_read_error:
    "database_read_error: Could not read SyncInfo.lastSync from the local Flighty SQLite database.",
  not_applicable_static_or_reference_tool:
    "not_applicable_static_or_reference_tool: Static server info and reference catalog lookups do not depend on Flighty database sync state; SyncInfo.lastSync was not queried.",
  error_response_sync_not_queried:
    "error_response_sync_not_queried: Tool returned an error or failed input validation; database sync state was not queried.",
};

export const STATIC_OR_REFERENCE_TOOLS = new Set<string>([
  "flighty_about",
  "flighty_search_airports",
  "flighty_search_airlines",
]);

export function isStaticOrReferenceTool(toolName?: string): boolean {
  return Boolean(toolName && STATIC_OR_REFERENCE_TOOLS.has(toolName));
}

export type NowInput = Date | number | (() => Date | number);

export function resolveNowMs(now?: NowInput): number {
  const raw = typeof now === "function" ? now() : now;
  if (raw instanceof Date) {
    const ms = raw.getTime();
    return Number.isFinite(ms) ? ms : Date.now();
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  return Date.now();
}

const NUMERIC_TEXT_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

const EXPLICIT_ISO_8601_TZ_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([Zz]|([+-])(\d{2}):?(\d{2}))$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 1970 || year > 9999) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= daysInMonth[month - 1];
}

export type ParsedSyncMarker =
  | {
      kind: "known";
      lastSyncedAt: string;
      parsedMs: number;
      syncAgeSeconds: number;
      syncAgeMinutes: number;
    }
  | {
      kind: "unknown";
      reasonCode: FreshnessUnknownReasonCode;
      isFutureMarker: boolean;
    };

/**
 * Pure parser for a `SyncInfo.lastSync` marker value.
 * - Rejects numeric values and numeric strings with `unverified_numeric_sync_format`
 *   (never guesses Unix seconds, Unix ms, Apple Core Data epoch, or sequence numbers).
 * - Parses only valid ISO-8601 timestamps with an explicit timezone (`Z` or `±HH:MM` / `±HHMM`).
 * - Rejects calendar rollovers (e.g., 2026-02-30) and invalid time/offset components.
 * - Marks timestamps ahead of `nowMs` as `future_sync_timestamp` with null age/sync time.
 * - Never exposes the raw marker value in error reasons.
 */
export function parseSyncTimestamp(
  rawMarker: unknown,
  nowMs: number = Date.now()
): ParsedSyncMarker {
  if (rawMarker === null || rawMarker === undefined) {
    return {
      kind: "unknown",
      reasonCode: "empty_last_sync_marker",
      isFutureMarker: false,
    };
  }

  if (typeof rawMarker === "number" || typeof rawMarker === "bigint") {
    return {
      kind: "unknown",
      reasonCode: "unverified_numeric_sync_format",
      isFutureMarker: false,
    };
  }

  if (typeof rawMarker !== "string") {
    return {
      kind: "unknown",
      reasonCode: "invalid_or_ambiguous_sync_timestamp",
      isFutureMarker: false,
    };
  }

  const trimmed = rawMarker.trim();
  if (trimmed.length === 0) {
    return {
      kind: "unknown",
      reasonCode: "empty_last_sync_marker",
      isFutureMarker: false,
    };
  }

  if (NUMERIC_TEXT_PATTERN.test(trimmed)) {
    return {
      kind: "unknown",
      reasonCode: "unverified_numeric_sync_format",
      isFutureMarker: false,
    };
  }

  const match = EXPLICIT_ISO_8601_TZ_PATTERN.exec(trimmed);
  if (!match) {
    return {
      kind: "unknown",
      reasonCode: "invalid_or_ambiguous_sync_timestamp",
      isFutureMarker: false,
    };
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const tzDesignator = match[8];
  const tzSign = match[9];
  const tzHour = match[10] !== undefined ? Number(match[10]) : 0;
  const tzMinute = match[11] !== undefined ? Number(match[11]) : 0;

  if (!isValidCalendarDate(year, month, day)) {
    return {
      kind: "unknown",
      reasonCode: "invalid_or_ambiguous_sync_timestamp",
      isFutureMarker: false,
    };
  }

  if (hour > 23 || minute > 59 || second > 59) {
    return {
      kind: "unknown",
      reasonCode: "invalid_or_ambiguous_sync_timestamp",
      isFutureMarker: false,
    };
  }

  if (tzDesignator.toUpperCase() !== "Z") {
    if (tzHour > 23 || tzMinute > 59) {
      return {
        kind: "unknown",
        reasonCode: "invalid_or_ambiguous_sync_timestamp",
        isFutureMarker: false,
      };
    }
    // RFC 3339 "-00:00" denotes an unknown local offset rather than explicit UTC.
    if (tzSign === "-" && tzHour === 0 && tzMinute === 0) {
      return {
        kind: "unknown",
        reasonCode: "invalid_or_ambiguous_sync_timestamp",
        isFutureMarker: false,
      };
    }
  }

  // Normalize fractional seconds to milliseconds (3 digits) for deterministic Date.parse
  const fraction = match[7] ? `.${match[7].slice(0, 3).padEnd(3, "0")}` : "";
  const normalizedTz =
    tzDesignator.toUpperCase() === "Z"
      ? "Z"
      : `${tzSign}${String(tzHour).padStart(2, "0")}:${String(tzMinute).padStart(2, "0")}`;
  const normalizedIso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${fraction}${normalizedTz}`;

  const parsedMs = Date.parse(normalizedIso);
  if (!Number.isFinite(parsedMs)) {
    return {
      kind: "unknown",
      reasonCode: "invalid_or_ambiguous_sync_timestamp",
      isFutureMarker: false,
    };
  }

  const effectiveNowMs = resolveNowMs(nowMs);
  if (parsedMs > effectiveNowMs) {
    return {
      kind: "unknown",
      reasonCode: "future_sync_timestamp",
      isFutureMarker: true,
    };
  }

  const diffMs = effectiveNowMs - parsedMs;
  const syncAgeSeconds = Math.floor(diffMs / 1000);
  const syncAgeMinutes = Math.round((diffMs / 60000) * 100) / 100;

  return {
    kind: "known",
    lastSyncedAt: new Date(parsedMs).toISOString(),
    parsedMs,
    syncAgeSeconds,
    syncAgeMinutes,
  };
}

function buildUnknownDatabaseFreshness(
  queriedAt: string,
  reasonCode: FreshnessUnknownReasonCode,
  isFutureMarker = false
): FreshnessMetadata {
  return {
    queried_at: queriedAt,
    queried_at_meaning: QUERIED_AT_MEANING,
    last_synced_at: null,
    sync_age_seconds: null,
    sync_age_minutes: null,
    status: "unknown",
    source: "SyncInfo.lastSync",
    scope: "database_sync",
    scope_note: FRESHNESS_DATABASE_SCOPE_NOTE,
    unknown_reason_code: reasonCode,
    unknown_reason: STATIC_UNKNOWN_REASONS[reasonCode],
    is_future_marker: isFutureMarker,
    cache_note: FRESHNESS_LOCAL_CACHE_NOTE,
  };
}

export function createNotApplicableFreshness(options?: {
  now?: NowInput;
}): FreshnessMetadata {
  const nowMs = resolveNowMs(options?.now);
  const queriedAt = new Date(nowMs).toISOString();
  return {
    queried_at: queriedAt,
    queried_at_meaning: QUERIED_AT_MEANING,
    last_synced_at: null,
    sync_age_seconds: null,
    sync_age_minutes: null,
    status: "not_applicable",
    source: "none",
    scope: "static_or_reference_data",
    scope_note: FRESHNESS_STATIC_SCOPE_NOTE,
    unknown_reason_code: "not_applicable_static_or_reference_tool",
    unknown_reason:
      STATIC_UNKNOWN_REASONS.not_applicable_static_or_reference_tool,
    is_future_marker: false,
    cache_note: FRESHNESS_LOCAL_CACHE_NOTE,
  };
}

export function createErrorFreshness(options?: {
  now?: NowInput;
}): FreshnessMetadata {
  const nowMs = resolveNowMs(options?.now);
  const queriedAt = new Date(nowMs).toISOString();
  return {
    queried_at: queriedAt,
    queried_at_meaning: QUERIED_AT_MEANING,
    last_synced_at: null,
    sync_age_seconds: null,
    sync_age_minutes: null,
    status: "unknown",
    source: "none",
    scope: "error_or_validation",
    scope_note: FRESHNESS_ERROR_SCOPE_NOTE,
    unknown_reason_code: "error_response_sync_not_queried",
    unknown_reason: STATIC_UNKNOWN_REASONS.error_response_sync_not_queried,
    is_future_marker: false,
    cache_note: FRESHNESS_LOCAL_CACHE_NOTE,
  };
}

export interface ReadFreshnessOptions {
  dbPath?: string | null;
  now?: NowInput;
  toolName?: string;
  isError?: boolean;
}

/**
 * Isolated read-only SQLite helper that inspects `SyncInfo.lastSync` from `MAIN_DB_PATH`
 * (or an injected `dbPath` for synthetic tests).
 * - Selects ONLY `lastSync` from `SyncInfo`; never queries `nextURL`, `Account`, or `ZUSER`.
 * - Makes no plist, build-token, or network calls.
 * - Never uses file `mtime` as a sync timestamp and never mutates the database.
 */
export function readDatabaseFreshness(
  optionsOrPath: ReadFreshnessOptions | string = {},
  nowArg?: NowInput
): FreshnessMetadata {
  const options: ReadFreshnessOptions =
    typeof optionsOrPath === "string"
      ? { dbPath: optionsOrPath, now: nowArg }
      : optionsOrPath ?? {};

  const nowMs = resolveNowMs(options.now ?? nowArg);
  const queriedAt = new Date(nowMs).toISOString();

  if (options.isError) {
    return createErrorFreshness({ now: nowMs });
  }

  if (isStaticOrReferenceTool(options.toolName)) {
    return createNotApplicableFreshness({ now: nowMs });
  }

  const dbPath =
    options.dbPath === undefined ? MAIN_DB_PATH : options.dbPath;

  if (!dbPath || typeof dbPath !== "string" || !existsSync(dbPath)) {
    return buildUnknownDatabaseFreshness(queriedAt, "missing_database");
  }

  let db: InstanceType<typeof Database> | undefined;
  try {
    db = new Database(dbPath, { readOnly: true });
    const rows = db
      .prepare(`SELECT lastSync FROM SyncInfo LIMIT ${MAX_SYNC_INFO_ROWS + 1}`)
      .all() as Array<{ lastSync?: unknown }>;

    if (rows.length === 0) {
      return buildUnknownDatabaseFreshness(queriedAt, "missing_sync_row");
    }

    if (rows.length > MAX_SYNC_INFO_ROWS) {
      return buildUnknownDatabaseFreshness(
        queriedAt,
        "invalid_or_ambiguous_sync_timestamp"
      );
    }

    const nonEmptyMarkers = rows
      .map((r) => r.lastSync)
      .filter(
        (val) =>
          val !== null &&
          val !== undefined &&
          !(typeof val === "string" && val.trim() === "")
      );

    if (nonEmptyMarkers.length === 0) {
      return buildUnknownDatabaseFreshness(
        queriedAt,
        "empty_last_sync_marker"
      );
    }

    const parsedList = nonEmptyMarkers.map((marker) =>
      parseSyncTimestamp(marker, nowMs)
    );

    const unknownMarkers = parsedList.filter(
      (p): p is Extract<ParsedSyncMarker, { kind: "unknown" }> =>
        p.kind === "unknown"
    );
    if (unknownMarkers.length > 0) {
      const hasFutureMarker = unknownMarkers.some((p) => p.isFutureMarker);
      const reasonCode: FreshnessUnknownReasonCode = unknownMarkers.some(
        (p) => p.reasonCode === "future_sync_timestamp"
      )
        ? "future_sync_timestamp"
        : unknownMarkers.some(
              (p) => p.reasonCode === "unverified_numeric_sync_format"
            )
          ? "unverified_numeric_sync_format"
          : "invalid_or_ambiguous_sync_timestamp";
      return buildUnknownDatabaseFreshness(
        queriedAt,
        reasonCode,
        hasFutureMarker
      );
    }

    const knownMarkers = parsedList.filter(
      (p): p is Extract<ParsedSyncMarker, { kind: "known" }> =>
        p.kind === "known"
    );
    const latest = knownMarkers.reduce((best, cur) =>
      cur.parsedMs > best.parsedMs ? cur : best
    );
    return {
      queried_at: queriedAt,
      queried_at_meaning: QUERIED_AT_MEANING,
      last_synced_at: latest.lastSyncedAt,
      sync_age_seconds: latest.syncAgeSeconds,
      sync_age_minutes: latest.syncAgeMinutes,
      status: "known",
      source: "SyncInfo.lastSync",
      scope: "database_sync",
      scope_note: FRESHNESS_DATABASE_SCOPE_NOTE,
      unknown_reason_code: null,
      unknown_reason: null,
      is_future_marker: false,
      cache_note: FRESHNESS_LOCAL_CACHE_NOTE,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (/no such table:\s*SyncInfo/i.test(message)) {
      return buildUnknownDatabaseFreshness(queriedAt, "missing_sync_table");
    }
    if (/no such column:\s*lastSync/i.test(message)) {
      return buildUnknownDatabaseFreshness(
        queriedAt,
        "missing_last_sync_column"
      );
    }
    return buildUnknownDatabaseFreshness(queriedAt, "database_read_error");
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors on already-failed handles.
    }
  }
}

export function formatFreshnessNoticeLine(
  freshness: FreshnessMetadata
): string {
  const parts = [
    `queried_at=${freshness.queried_at}`,
    `last_synced_at=${freshness.last_synced_at ?? "null"}`,
    `sync_age_seconds=${freshness.sync_age_seconds ?? "null"}`,
    `sync_age_minutes=${freshness.sync_age_minutes ?? "null"}`,
    `status=${freshness.status}`,
    `source=${freshness.source}`,
    `scope=${freshness.scope}`,
    `is_future_marker=${freshness.is_future_marker}`,
  ];
  if (freshness.unknown_reason_code) {
    parts.push(`unknown_reason_code=${freshness.unknown_reason_code}`);
  }
  if (freshness.unknown_reason) {
    parts.push(`unknown_reason=${freshness.unknown_reason}`);
  }
  parts.push(`scope_note=${freshness.scope_note}`);
  parts.push(`cache_note=${freshness.cache_note}`);
  return `[freshness: ${parts.join(" | ")}]`;
}
