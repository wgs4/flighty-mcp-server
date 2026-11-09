import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import { MAX_SYNC_INFO_ROWS } from "../services/freshness.js";
import { isValidUuid } from "../services/validation.js";
import {
  assertNoDatabaseSidecars,
  assertSafeAbsolutePath,
  createReplicaError,
  retirePath,
  verifyMountAndSource,
} from "./cleanup.js";
import {
  REPLICA_DB_FILENAME,
  REPLICA_MANIFEST_FILENAME,
  REPLICA_MANIFEST_FORMAT_VERSION,
  computeFileSha256,
  deriveKeyIdFromPrivateKey,
  normalizeEd25519PrivateKey,
  normalizeTimestampToUtcIso,
  signReplicaManifest,
  validateCaptureInterval,
} from "./manifest.js";
import {
  AIRLINE_COLUMNS,
  AIRPORT_COLUMNS,
  CONNECTION_COLUMNS,
  CREATE_REPLICA_SCHEMA_SQL,
  DEFAULT_MAX_DB_BYTES,
  DEFAULT_MAX_ROWS_PER_TABLE,
  DEFAULT_MAX_STRING_LENGTH,
  DEFAULT_MAX_TOTAL_ROWS,
  FLIGHT_COLUMNS,
  MANUAL_FLIGHT_COLUMNS,
  PROFILE_COLUMNS,
  REPLICA_SCHEMA_HASH,
  REPLICA_SCHEMA_VERSION,
  REPLICA_TABLE_NAMES,
  REPLICA_TABLES,
  TICKET_COLUMNS,
  USER_FLIGHT_COLUMNS,
  sanitizeLastSyncValue,
  validateReplicaDatabaseSchemaAndContents,
  validateSourceDatabaseSchema,
} from "./schema.js";
import {
  ReplicaError,
  type ExportReplicaBundleOptions,
  type ExportReplicaBundleResult,
  type ReplicaColumnSpec,
  type ReplicaTableName,
} from "./types.js";

function sanitizeColumnValue(
  value: unknown,
  colSpec: ReplicaColumnSpec,
  tableName: ReplicaTableName,
  maxStringLength: number
): string | number | bigint | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (colSpec.name === "deleted") {
    return null;
  }
  if (colSpec.affinity === "TEXT") {
    if (typeof value !== "string") {
      throw createReplicaError(
        "SOURCE_SCHEMA_INVALID",
        `Source database column '${tableName}.${colSpec.name}' contained a non-text value.`
      );
    }
    if (value.length > maxStringLength) {
      throw createReplicaError(
        "EXPORT_BOUNDS_EXCEEDED",
        `Source database column '${tableName}.${colSpec.name}' exceeded maximum string length (${maxStringLength}).`
      );
    }
    return value;
  }
  if (colSpec.affinity === "INTEGER") {
    if (typeof value === "bigint") {
      const asNum = Number(value);
      if (!Number.isSafeInteger(asNum)) {
        throw createReplicaError(
          "SOURCE_SCHEMA_INVALID",
          `Source database column '${tableName}.${colSpec.name}' contained an out-of-range integer.`
        );
      }
      return asNum;
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw createReplicaError(
        "SOURCE_SCHEMA_INVALID",
        `Source database column '${tableName}.${colSpec.name}' contained a non-integer value.`
      );
    }
    return value;
  }
  if (colSpec.affinity === "REAL") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw createReplicaError(
        "SOURCE_SCHEMA_INVALID",
        `Source database column '${tableName}.${colSpec.name}' contained a non-finite number.`
      );
    }
    return value;
  }
  return sanitizeLastSyncValue(value);
}

function insertRowsForSpec(
  destDb: DatabaseSync,
  tableName: ReplicaTableName,
  cols: readonly ReplicaColumnSpec[],
  rows: readonly Record<string, unknown>[],
  maxRowsPerTable: number,
  maxStringLength: number
): number {
  if (rows.length > maxRowsPerTable) {
    throw createReplicaError(
      "EXPORT_BOUNDS_EXCEEDED",
      `Table '${tableName}' row count (${rows.length}) exceeds maximum allowed (${maxRowsPerTable}).`
    );
  }
  if (rows.length === 0) {
    return 0;
  }

  const colNames = cols.map((c) => c.name).join(", ");
  const placeholders = cols.map(() => "?").join(", ");
  const stmt = destDb.prepare(
    `INSERT INTO ${tableName} (${colNames}) VALUES (${placeholders})`
  );

  for (const row of rows) {
    const values = cols.map((c) =>
      sanitizeColumnValue(row[c.name], c, tableName, maxStringLength)
    );
    stmt.run(...values);
  }

  return rows.length;
}

/**
 * Consistently backs up a source Flighty SQLite database using Node's built-in `node:sqlite`
 * `backup()` API (including committed WAL state and excluding uncommitted transactions),
 * then constructs a brand-new SQLite replica database from a static allowlist schema,
 * filters private rows to the declared owner and eligible shared passenger scope,
 * and signs the bundle manifest with Ed25519.
 */
export async function exportReplicaBundle(
  options: ExportReplicaBundleOptions
): Promise<ExportReplicaBundleResult> {
  if (!options || typeof options !== "object") {
    throw createReplicaError(
      "INVALID_CONFIG",
      "Export options object is required."
    );
  }

  const sourceDbPath = assertSafeAbsolutePath(
    options.sourceDbPath,
    "sourceDbPath"
  );
  const outputBundleDir = assertSafeAbsolutePath(
    options.outputBundleDir,
    "outputBundleDir"
  );
  const requiredMountPath = assertSafeAbsolutePath(
    options.requiredMountPath,
    "requiredMountPath"
  );

  const pathsToRedact = [
    sourceDbPath,
    outputBundleDir,
    requiredMountPath,
    options.stagingRootDir ?? "",
  ];

  const producerId = (options.producerId ?? "").trim();
  if (!producerId) {
    throw createReplicaError(
      "INVALID_CONFIG",
      "Explicit non-empty producerId is required.",
      pathsToRedact
    );
  }

  const accountId = (options.accountId ?? "").trim();
  if (!accountId) {
    throw createReplicaError(
      "INVALID_CONFIG",
      "Explicit non-empty accountId is required.",
      pathsToRedact
    );
  }

  const ownerUserId = (options.ownerUserId ?? "").trim();
  if (!isValidUuid(ownerUserId)) {
    throw createReplicaError(
      "INVALID_CONFIG",
      "Explicit valid UUID ownerUserId is required (token discovery and frequency fallback are forbidden).",
      pathsToRedact
    );
  }

  if (
    typeof options.epoch !== "number" ||
    !Number.isSafeInteger(options.epoch) ||
    options.epoch < 1
  ) {
    throw createReplicaError(
      "INVALID_CONFIG",
      "Explicit positive integer epoch (>= 1) is required.",
      pathsToRedact
    );
  }

  if (
    typeof options.sequence !== "number" ||
    !Number.isSafeInteger(options.sequence) ||
    options.sequence < 1
  ) {
    throw createReplicaError(
      "INVALID_CONFIG",
      "Explicit positive integer sequence (>= 1) is required.",
      pathsToRedact
    );
  }

  const privKey = normalizeEd25519PrivateKey(options.signingPrivateKey);
  const keyId =
    options.keyId?.trim() || deriveKeyIdFromPrivateKey(privKey);
  const includeSharedPassengers =
    options.includeSharedPassengers !== undefined
      ? Boolean(options.includeSharedPassengers)
      : true;

  // Verify mount and source existence before creating any files.
  verifyMountAndSource({
    requiredMountPath,
    sourceDbPath,
    outputDir: outputBundleDir,
    mountCheck: options.mountCheck,
  });

  // Never overwrite an existing bundle directory or active database.
  if (existsSync(outputBundleDir)) {
    const existingEntries = readdirSync(outputBundleDir);
    if (existingEntries.length > 0) {
      throw createReplicaError(
        "OUTPUT_EXISTS",
        "Target outputBundleDir already exists and is non-empty; refusing in-place overwrite.",
        pathsToRedact
      );
    }
  }

  const limits = options.limits ?? {};
  const maxDbBytes = limits.maxDbBytes ?? DEFAULT_MAX_DB_BYTES;
  const maxRowsPerTable =
    limits.maxRowsPerTable ?? DEFAULT_MAX_ROWS_PER_TABLE;
  const maxTotalRows = limits.maxTotalRows ?? DEFAULT_MAX_TOTAL_ROWS;
  const maxStringLength =
    limits.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;

  const stagingParent = options.stagingRootDir
    ? assertSafeAbsolutePath(options.stagingRootDir, "stagingRootDir")
    : dirname(outputBundleDir);

  mkdirSync(stagingParent, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(outputBundleDir), { recursive: true, mode: 0o700 });

  const workDir = mkdtempSync(
    join(stagingParent, `.flighty-replica-export-${randomUUID().slice(0, 8)}-`)
  );
  chmodSync(workDir, 0o700);
  const fallbackTrashDir = join(stagingParent, ".replica-export-trash");
  const rawBackupDir = join(workDir, "raw-backup");
  const stagedBundleDir = join(workDir, "bundle");
  mkdirSync(rawBackupDir, { recursive: true, mode: 0o700 });
  mkdirSync(stagedBundleDir, { recursive: true, mode: 0o700 });

  const rawBackupPath = join(rawBackupDir, "source-snapshot.db");
  const stagedDbPath = join(stagedBundleDir, REPLICA_DB_FILENAME);
  const stagedManifestPath = join(
    stagedBundleDir,
    REPLICA_MANIFEST_FILENAME
  );

  let published = false;
  try {
    const started = normalizeTimestampToUtcIso(
      options.captureStartedAt ?? new Date(),
      "captureStartedAt"
    );

    // Step 1: Consistent SQLite backup via Node built-in `node:sqlite` backup API.
    let backupPagesTransferred = 0;
    let sourceDb: DatabaseSync | undefined;
    try {
      sourceDb = new DatabaseSync(sourceDbPath, {
        readOnly: true,
        timeout: 5000,
        allowExtension: false,
      });
      const pages = await sqliteBackup(sourceDb, rawBackupPath, {
        rate: 100,
        progress: ({ totalPages }) => {
          backupPagesTransferred = totalPages;
        },
      });
      if (typeof pages === "number" && pages > 0) {
        backupPagesTransferred = pages;
      }
    } catch (err) {
      if (err instanceof ReplicaError) {
        throw err;
      }
      throw createReplicaError(
        "BACKUP_FAILED",
        "Failed to capture consistent SQLite backup from source database.",
        pathsToRedact
      );
    } finally {
      try {
        sourceDb?.close();
      } catch {
        // Ignore close errors.
      }
    }

    if (options.onAfterBackup) {
      await options.onAfterBackup({ totalPages: backupPagesTransferred });
    }

    const completed = normalizeTimestampToUtcIso(
      options.captureCompletedAt ?? new Date(),
      "captureCompletedAt"
    );

    validateCaptureInterval({
      captureStartedAt: started.iso,
      captureCompletedAt: completed.iso,
      limits,
      checkFutureAgainstNow: false,
    });

    // Step 2: Inspect the consistent backup and populate a brand-new allowlist SQLite DB.
    let backupDb: DatabaseSync | undefined;
    let destDb: DatabaseSync | undefined;
    const rowCounts: Record<ReplicaTableName, number> = {
      Airline: 0,
      Airport: 0,
      Connection: 0,
      Flight: 0,
      ManualFlight: 0,
      Profile: 0,
      SyncInfo: 0,
      Ticket: 0,
      UserFlight: 0,
      UserManualFlight: 0,
    };

    try {
      backupDb = new DatabaseSync(rawBackupPath, {
        readOnly: true,
        allowExtension: false,
      });
      backupDb.exec("BEGIN");

      const schemaInfo = validateSourceDatabaseSchema(backupDb);

      destDb = new DatabaseSync(stagedDbPath, {
        allowExtension: false,
      });
      destDb.exec(
        "PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON; PRAGMA foreign_keys = OFF;"
      );
      destDb.exec(CREATE_REPLICA_SCHEMA_SQL);
      destDb.exec("BEGIN");

      const flightColList = FLIGHT_COLUMNS.map((c) => c.name).join(", ");
      const manualFlightColList = MANUAL_FLIGHT_COLUMNS.map(
        (c) => c.name
      ).join(", ");
      const ufColList = USER_FLIGHT_COLUMNS.map((c) => c.name).join(", ");
      const airportColList = AIRPORT_COLUMNS.map((c) => c.name).join(", ");
      const airlineColList = AIRLINE_COLUMNS.map((c) => c.name).join(", ");
      const ticketColList = TICKET_COLUMNS.map((c) => c.name).join(", ");
      const profileColList = PROFILE_COLUMNS.map((c) => c.name).join(", ");
      const connectionColList = CONNECTION_COLUMNS.map(
        (c) => c.name
      ).join(", ");

      // Read non-deleted Flight and ManualFlight rows from backup.
      const sourceFlights = backupDb
        .prepare(
          `SELECT ${flightColList} FROM Flight WHERE deleted IS NULL AND id IS NOT NULL`
        )
        .all() as Array<Record<string, unknown>>;

      const sourceManualFlights = backupDb
        .prepare(
          `SELECT ${manualFlightColList} FROM ManualFlight WHERE deleted IS NULL AND id IS NOT NULL`
        )
        .all() as Array<Record<string, unknown>>;

      const validFlightIds = new Set<string>();
      for (const row of sourceFlights) {
        if (typeof row.id === "string" && row.id.trim().length > 0) {
          validFlightIds.add(row.id);
        }
      }
      for (const row of sourceManualFlights) {
        if (typeof row.id === "string" && row.id.trim().length > 0) {
          validFlightIds.add(row.id);
        }
      }

      // Filter UserFlight and UserManualFlight to eligible owner passenger/followed
      // and (when enabled) cached shared passenger rows. Never export unrelated friend-followed rows.
      const isEligibleUserFlightRow = (
        row: Record<string, unknown>
      ): boolean => {
        const userId = row.userId;
        const flightId = row.flightId;
        const isMyFlight = row.isMyFlight;
        if (
          typeof userId !== "string" ||
          userId.trim().length === 0 ||
          typeof flightId !== "string" ||
          !validFlightIds.has(flightId)
        ) {
          return false;
        }
        if (userId === ownerUserId) {
          return isMyFlight === 1 || isMyFlight === 0;
        }
        if (includeSharedPassengers && userId !== ownerUserId) {
          return isMyFlight === 1;
        }
        return false;
      };

      const sourceUserFlights = (
        backupDb
          .prepare(`SELECT ${ufColList} FROM UserFlight WHERE deleted IS NULL`)
          .all() as Array<Record<string, unknown>>
      ).filter(isEligibleUserFlightRow);

      const sourceUserManualFlights = (
        backupDb
          .prepare(
            `SELECT ${ufColList} FROM UserManualFlight WHERE deleted IS NULL`
          )
          .all() as Array<Record<string, unknown>>
      ).filter(isEligibleUserFlightRow);

      const eligibleTrackedFlightIds = new Set<string>();
      const ownerPassengerFlightIds = new Set<string>();
      const eligibleFlightUserPairs = new Set<string>();
      const eligibleProfileUserIds = new Set<string>();

      for (const uf of [...sourceUserFlights, ...sourceUserManualFlights]) {
        const uid = uf.userId as string;
        const fid = uf.flightId as string;
        eligibleTrackedFlightIds.add(fid);
        eligibleFlightUserPairs.add(`${fid}\0${uid}`);
        if (uid === ownerUserId && uf.isMyFlight === 1) {
          ownerPassengerFlightIds.add(fid);
        }
        if (uid === ownerUserId || uf.isMyFlight === 1) {
          eligibleProfileUserIds.add(uid);
        }
      }

      // Filter Connection rows:
      // 1. Inbound is owner passenger flight and outbound is a valid non-deleted flight (needed by getConnections), OR
      // 2. Both inbound and outbound are in eligibleTrackedFlightIds (needed by checkConnection).
      const sourceConnections = (
        backupDb
          .prepare(
            `SELECT ${connectionColList} FROM Connection WHERE deleted IS NULL`
          )
          .all() as Array<Record<string, unknown>>
      ).filter((row) => {
        const id = row.id;
        const arrId = row.arrivingFlightId;
        const depId = row.departingFlightId;
        if (
          typeof id !== "string" ||
          id.trim().length === 0 ||
          typeof arrId !== "string" ||
          typeof depId !== "string" ||
          !validFlightIds.has(arrId) ||
          !validFlightIds.has(depId)
        ) {
          return false;
        }
        return (
          ownerPassengerFlightIds.has(arrId) ||
          (eligibleTrackedFlightIds.has(arrId) &&
            eligibleTrackedFlightIds.has(depId))
        );
      });

      const eligibleFlightIds = new Set<string>(eligibleTrackedFlightIds);
      for (const conn of sourceConnections) {
        eligibleFlightIds.add(conn.arrivingFlightId as string);
        eligibleFlightIds.add(conn.departingFlightId as string);
      }

      const filteredFlights = sourceFlights.filter(
        (row) => typeof row.id === "string" && eligibleFlightIds.has(row.id)
      );
      const filteredManualFlights = sourceManualFlights.filter(
        (row) => typeof row.id === "string" && eligibleFlightIds.has(row.id)
      );

      // Filter Ticket rows strictly to exported (flightId, userId) pairs.
      const ticketWhere = schemaInfo.ticketHasDeletedColumn
        ? "WHERE deleted IS NULL"
        : "";
      const sourceTickets = (
        backupDb
          .prepare(`SELECT ${ticketColList} FROM Ticket ${ticketWhere}`)
          .all() as Array<Record<string, unknown>>
      ).filter((row) => {
        const fid = row.flightId;
        const uid = row.userId;
        return (
          typeof fid === "string" &&
          typeof uid === "string" &&
          eligibleFlightUserPairs.has(`${fid}\0${uid}`)
        );
      });

      // Filter Profile rows strictly to exported eligible userIds.
      const profileWhere = schemaInfo.profileHasDeletedColumn
        ? "WHERE deleted IS NULL"
        : "";
      const sourceProfiles = (
        backupDb
          .prepare(`SELECT ${profileColList} FROM Profile ${profileWhere}`)
          .all() as Array<Record<string, unknown>>
      ).filter(
        (row) =>
          typeof row.userId === "string" &&
          eligibleProfileUserIds.has(row.userId)
      );

      // Reference tables: non-deleted Airport and Airline rows.
      const sourceAirports = backupDb
        .prepare(
          `SELECT ${airportColList} FROM Airport WHERE deleted IS NULL`
        )
        .all() as Array<Record<string, unknown>>;

      const sourceAirlines = backupDb
        .prepare(
          `SELECT ${airlineColList} FROM Airline WHERE deleted IS NULL`
        )
        .all() as Array<Record<string, unknown>>;

      // SyncInfo: select ONLY lastSync (never nextURL), bounded by MAX_SYNC_INFO_ROWS.
      const sourceSyncRows = backupDb
        .prepare(`SELECT lastSync FROM SyncInfo LIMIT ${MAX_SYNC_INFO_ROWS}`)
        .all() as Array<Record<string, unknown>>;

      // Insert into brand-new destination database.
      rowCounts.Airline = insertRowsForSpec(
        destDb,
        "Airline",
        AIRLINE_COLUMNS,
        sourceAirlines,
        maxRowsPerTable,
        maxStringLength
      );
      rowCounts.Airport = insertRowsForSpec(
        destDb,
        "Airport",
        AIRPORT_COLUMNS,
        sourceAirports,
        maxRowsPerTable,
        maxStringLength
      );
      rowCounts.Connection = insertRowsForSpec(
        destDb,
        "Connection",
        CONNECTION_COLUMNS,
        sourceConnections,
        maxRowsPerTable,
        maxStringLength
      );
      rowCounts.Flight = insertRowsForSpec(
        destDb,
        "Flight",
        FLIGHT_COLUMNS,
        filteredFlights,
        maxRowsPerTable,
        maxStringLength
      );
      rowCounts.ManualFlight = insertRowsForSpec(
        destDb,
        "ManualFlight",
        MANUAL_FLIGHT_COLUMNS,
        filteredManualFlights,
        maxRowsPerTable,
        maxStringLength
      );
      rowCounts.Profile = insertRowsForSpec(
        destDb,
        "Profile",
        PROFILE_COLUMNS,
        sourceProfiles,
        maxRowsPerTable,
        maxStringLength
      );
      rowCounts.SyncInfo = insertRowsForSpec(
        destDb,
        "SyncInfo",
        REPLICA_TABLES.SyncInfo.columns,
        sourceSyncRows,
        MAX_SYNC_INFO_ROWS,
        maxStringLength
      );
      rowCounts.Ticket = insertRowsForSpec(
        destDb,
        "Ticket",
        TICKET_COLUMNS,
        sourceTickets,
        maxRowsPerTable,
        maxStringLength
      );
      rowCounts.UserFlight = insertRowsForSpec(
        destDb,
        "UserFlight",
        USER_FLIGHT_COLUMNS,
        sourceUserFlights,
        maxRowsPerTable,
        maxStringLength
      );
      rowCounts.UserManualFlight = insertRowsForSpec(
        destDb,
        "UserManualFlight",
        USER_FLIGHT_COLUMNS,
        sourceUserManualFlights,
        maxRowsPerTable,
        maxStringLength
      );

      let totalExportedRows = 0;
      for (const table of REPLICA_TABLE_NAMES) {
        totalExportedRows += rowCounts[table];
      }
      if (totalExportedRows > maxTotalRows) {
        throw createReplicaError(
          "EXPORT_BOUNDS_EXCEEDED",
          `Total exported row count (${totalExportedRows}) exceeds maximum allowed (${maxTotalRows}).`,
          pathsToRedact
        );
      }

      destDb.exec("COMMIT;");
      destDb.exec("VACUUM;");
      backupDb.exec("COMMIT;");
    } catch (err) {
      if (err instanceof ReplicaError) {
        throw err;
      }
      throw createReplicaError(
        "SOURCE_READ_ERROR",
        "Failed to read source backup or construct allowlist replica database.",
        pathsToRedact
      );
    } finally {
      try {
        destDb?.close();
      } catch {
        // Ignore close errors.
      }
      try {
        backupDb?.close();
      } catch {
        // Ignore close errors.
      }
      // Always retire the raw backup immediately so unallowlisted source pages never linger.
      retirePath(rawBackupDir, fallbackTrashDir, options.cleanupPath);
    }

    assertNoDatabaseSidecars(stagedDbPath, "exported replica database");

    const { sha256: dbSha256, bytes: dbBytes } =
      computeFileSha256(stagedDbPath);
    if (dbBytes <= 0 || dbBytes > maxDbBytes) {
      throw createReplicaError(
        "EXPORT_BOUNDS_EXCEEDED",
        `Exported replica database size (${dbBytes} bytes) exceeds maximum allowed (${maxDbBytes} bytes).`,
        pathsToRedact
      );
    }

    const manifest = signReplicaManifest(
      {
        formatVersion: REPLICA_MANIFEST_FORMAT_VERSION,
        schemaVersion: REPLICA_SCHEMA_VERSION,
        schemaHash: REPLICA_SCHEMA_HASH,
        producerId,
        accountId,
        ownerUserId,
        ownerLabel: "replica_producer_owner",
        includeSharedPassengers,
        epoch: options.epoch,
        sequence: options.sequence,
        captureStartedAt: started.iso,
        captureCompletedAt: completed.iso,
        dbFileName: REPLICA_DB_FILENAME,
        dbBytes,
        dbSha256,
        rowCounts,
        keyId,
        signatureAlgorithm: "ed25519",
      },
      privKey
    );

    // Self-verify the constructed replica database against the signed manifest before publishing.
    let verifyDb: DatabaseSync | undefined;
    try {
      verifyDb = new DatabaseSync(stagedDbPath, {
        readOnly: true,
        allowExtension: false,
      });
      validateReplicaDatabaseSchemaAndContents(verifyDb, manifest, limits);
    } finally {
      try {
        verifyDb?.close();
      } catch {
        // Ignore close error.
      }
    }

    writeFileSync(
      stagedManifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    chmodSync(stagedDbPath, 0o400);
    chmodSync(stagedBundleDir, 0o700);

    if (existsSync(outputBundleDir)) {
      retirePath(outputBundleDir, fallbackTrashDir, options.cleanupPath);
    }
    renameSync(stagedBundleDir, outputBundleDir);
    published = true;

    return {
      bundleDir: resolve(outputBundleDir),
      dbPath: join(resolve(outputBundleDir), REPLICA_DB_FILENAME),
      manifestPath: join(resolve(outputBundleDir), REPLICA_MANIFEST_FILENAME),
      manifest,
      backupPagesTransferred,
    };
  } finally {
    retirePath(workDir, fallbackTrashDir, options.cleanupPath);
    if (!published && existsSync(outputBundleDir)) {
      // Do not touch if it wasn't created by us, since we checked non-empty before.
    }
  }
}
