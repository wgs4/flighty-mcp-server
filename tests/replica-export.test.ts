import { exportSyntheticBundle as exportReplicaBundle, receiverStorage } from "./replica-support.js";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  REPLICA_TABLE_NAMES,
  ReplicaError,
} from "../src/replica/index.js";
import { FlightyDatabase } from "../src/services/database.js";
import { readDatabaseFreshness } from "../src/services/freshness.js";
import { installToolSafety } from "../src/services/tool-safety.js";
import { registerConnectionTools } from "../src/tools/connections.js";
import { registerFlightStatusTools } from "../src/tools/flight-status.js";
import { registerFlightTools } from "../src/tools/flights.js";
import { registerFriendTools } from "../src/tools/friends.js";
import { registerReferenceTools } from "../src/tools/reference.js";
import { registerStatsTools } from "../src/tools/stats.js";
import { registerTrackingTools } from "../src/tools/tracking.js";
import {
  IDS,
  SYNC_URL,
  SYNTHETIC_TOKEN,
  createFixture,
} from "./fixture/create.mjs";
import { fixtureTempRoot, trashFixture } from "./fixture/lifecycle.mjs";
import { READ_CASES, parseToolResult } from "./fixture/read-cases.mjs";

const { privateKey: TEST_PRIV_KEY } = generateKeyPairSync("ed25519");

describe("replica core: WAL-consistent backup and allowlist exporter", () => {
  const tempDirs: string[] = [];

  function makeTempDir(prefix = "replica-export-test-"): string {
    const dir = mkdtempSync(join(fixtureTempRoot(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      trashFixture(dir);
    }
  });

  it("captures committed WAL rows not yet checkpointed to main .db and excludes uncommitted WAL transactions", async () => {
    const root = makeTempDir();
    const fixture = createFixture(root);
    const committedWalFlightId = "99999999-1111-4111-8111-111111111111";
    const uncommittedWalFlightId = "99999999-2222-4222-8222-222222222222";
    const committedSentinelPnr = "COMMITTED_WAL_PNR_777";
    const uncommittedSentinelPnr = "UNCOMMITTED_SECRET_PNR_888";

    const writer = new DatabaseSync(fixture.mainPath);
    try {
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      const now = Math.floor(Date.now() / 1000);

      // 1. Committed transaction living only in the -wal file (not checkpointed to MainFlightyDatabase.db).
      writer
        .prepare(
          `INSERT INTO Flight (id, number, airlineId, departureAirportId, scheduledArrivalAirportId,
             departureScheduleGateOriginal, arrivalScheduleGateOriginal, departureGate, arrivalGate, distance, isCancelled)
           VALUES (?, '777', ?, 'airport-a', 'airport-b', ?, ?, 'C1', 'D2', 500, 0)`
        )
        .run(committedWalFlightId, IDS.airline, now + 3600, now + 7200);
      writer
        .prepare(
          "INSERT INTO UserFlight VALUES (?, ?, 'wal-committed', NULL, 1)"
        )
        .run(IDS.owner, committedWalFlightId);
      writer
        .prepare(
          "INSERT INTO Ticket VALUES (?, ?, '2A', 'window', 'economy', ?, 'business')"
        )
        .run(committedWalFlightId, IDS.owner, committedSentinelPnr);

      // Confirm that the raw main database file on disk does NOT contain the uncheckpointed WAL row.
      const mainFileBytes = readFileSync(fixture.mainPath);
      expect(
        mainFileBytes.includes(Buffer.from(committedWalFlightId, "utf8"))
      ).toBe(false);
      expect(
        mainFileBytes.includes(Buffer.from(committedSentinelPnr, "utf8"))
      ).toBe(false);

      // 2. Open an uncommitted transaction on the writer connection before exporting.
      writer.exec("BEGIN;");
      writer
        .prepare(
          `INSERT INTO Flight (id, number, airlineId, departureAirportId, scheduledArrivalAirportId,
             departureScheduleGateOriginal, arrivalScheduleGateOriginal, departureGate, arrivalGate, distance, isCancelled)
           VALUES (?, '888', ?, 'airport-a', 'airport-b', ?, ?, 'E1', 'F2', 600, 0)`
        )
        .run(uncommittedWalFlightId, IDS.airline, now + 5000, now + 9000);
      writer
        .prepare(
          "INSERT INTO UserFlight VALUES (?, ?, 'wal-uncommitted', NULL, 1)"
        )
        .run(IDS.owner, uncommittedWalFlightId);
      writer
        .prepare(
          "INSERT INTO Ticket VALUES (?, ?, '9F', 'middle', 'economy', ?, 'secret')"
        )
        .run(uncommittedWalFlightId, IDS.owner, uncommittedSentinelPnr);

      const outputBundleDir = join(root, "exported-bundle");
      const exported = await exportReplicaBundle({
        sourceDbPath: fixture.mainPath,
        outputBundleDir,
        requiredMountPath: root,
        producerId: "imac-test-exporter",
        accountId: "acct-synthetic-1",
        ownerUserId: IDS.owner,
        epoch: 1,
        sequence: 1,
        signingPrivateKey: TEST_PRIV_KEY,
        captureStartedAt: "2026-11-08T21:00:00.000Z",
        captureCompletedAt: "2026-11-08T21:00:01.000Z",
      });

      writer.exec("ROLLBACK;");

      expect(exported.backupPagesTransferred).toBeGreaterThan(0);

      // Verify committed WAL row is present and uncommitted WAL row is absent.
      const replicaDb = new DatabaseSync(exported.dbPath, { readOnly: true });
      try {
        const flightIds = (
          replicaDb.prepare("SELECT id FROM Flight").all() as Array<{
            id: string;
          }>
        ).map((r) => r.id);
        expect(flightIds).toContain(committedWalFlightId);
        expect(flightIds).not.toContain(uncommittedWalFlightId);

        const pnrs = (
          replicaDb.prepare("SELECT pnr FROM Ticket").all() as Array<{
            pnr: string;
          }>
        ).map((r) => r.pnr);
        expect(pnrs).toContain(committedSentinelPnr);
        expect(pnrs).not.toContain(uncommittedSentinelPnr);
      } finally {
        replicaDb.close();
      }

      const replicaBytes = readFileSync(exported.dbPath);
      expect(
        replicaBytes.includes(Buffer.from(committedSentinelPnr, "utf8"))
      ).toBe(true);
      expect(
        replicaBytes.includes(Buffer.from(uncommittedSentinelPnr, "utf8"))
      ).toBe(false);
      expect(
        replicaBytes.includes(Buffer.from(uncommittedWalFlightId, "utf8"))
      ).toBe(false);
    } finally {
      writer.close();
    }
  });

  it("excludes Account/authToken, SyncInfo.nextURL, unknown tables/columns, triggers/views, deleted/free-page slack, and unrelated friend-followed rows from destination bytes", async () => {
    const root = makeTempDir();
    const fixture = createFixture(root);

    const sentinels = {
      authToken: SYNTHETIC_TOKEN,
      extraToken: "eyJhbGciOiJIUzI1NiJ9.SENTINEL_EXTRA_TOKEN_PAYLOAD.sig",
      syncUrl: SYNC_URL,
      unknownTableSecret: "SENTINEL_SECRET_INTERNAL_TABLE_VALUE_42",
      unknownColSecret: "SENTINEL_UNKNOWN_FLIGHT_COLUMN_SECRET_99",
      triggerSecret: "SENTINEL_SOURCE_TRIGGER_SQL_SECRET",
      viewSecret: "SENTINEL_SOURCE_VIEW_SQL_SECRET",
      softDeletedFlight: "SENTINEL_SOFT_DELETED_FLIGHT_NUMBER",
      freePageSlack: "SENTINEL_FREE_PAGE_SLACK_DELETED_SECRET_STRING_123456",
      unrelatedFriendFollowedFlightId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      unrelatedFriendFollowedPnr: "SENTINEL_FRIEND_FOLLOWED_PNR_SECRET",
      unrelatedUserId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      unrelatedProfileName: "SENTINEL_UNRELATED_FRIEND_PROFILE_NAME",
      connectedExtraOutFlightId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      connectedExtraFriendPnr: "SENTINEL_CONNECTED_LEG_UNRELATED_PNR",
    };

    const src = new DatabaseSync(fixture.mainPath);
    try {
      src.exec("PRAGMA secure_delete = OFF;");
      src.prepare("INSERT INTO Account VALUES (?)").run(sentinels.extraToken);

      // Unknown table, unknown column, view, and trigger in source DB
      src.exec(`
        CREATE TABLE InternalSecrets (note TEXT);
        INSERT INTO InternalSecrets VALUES ('${sentinels.unknownTableSecret}');
        ALTER TABLE Flight ADD COLUMN secretInternalNotes TEXT;
        UPDATE Flight SET secretInternalNotes = '${sentinels.unknownColSecret}';
        CREATE VIEW SecretSourceView AS SELECT '${sentinels.viewSecret}' AS v;
        CREATE TRIGGER SecretSourceTrigger AFTER INSERT ON Flight BEGIN
          SELECT '${sentinels.triggerSecret}';
        END;
      `);

      const now = Math.floor(Date.now() / 1000);

      // Soft-deleted flight row
      src
        .prepare(
          `INSERT INTO Flight (id, number, airlineId, departureAirportId, scheduledArrivalAirportId,
             departureScheduleGateOriginal, arrivalScheduleGateOriginal, deleted)
           VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', ?, ?, 'airport-a', 'airport-b', ?, ?, 1)`
        )
        .run(sentinels.softDeletedFlight, IDS.airline, now, now + 3600);

      // Unrelated friend-followed flight (userId != owner && isMyFlight = 0)
      src
        .prepare(
          `INSERT INTO Flight (id, number, airlineId, departureAirportId, scheduledArrivalAirportId,
             departureScheduleGateOriginal, arrivalScheduleGateOriginal, deleted)
           VALUES (?, '909', ?, 'airport-a', 'airport-c', ?, ?, NULL)`
        )
        .run(
          sentinels.unrelatedFriendFollowedFlightId,
          IDS.airline,
          now + 3600,
          now + 7200
        );
      src
        .prepare("INSERT INTO UserFlight VALUES (?, ?, 'friend-follow', NULL, 0)")
        .run(sentinels.unrelatedUserId, sentinels.unrelatedFriendFollowedFlightId);
      src
        .prepare(
          "INSERT INTO Ticket VALUES (?, ?, '12C', 'aisle', 'economy', ?, 'vacation')"
        )
        .run(
          sentinels.unrelatedFriendFollowedFlightId,
          sentinels.unrelatedUserId,
          sentinels.unrelatedFriendFollowedPnr
        );
      src
        .prepare("INSERT INTO Profile VALUES (?, ?, 'Unrelated')")
        .run(sentinels.unrelatedUserId, sentinels.unrelatedProfileName);

      // Connected-leg flight: referenced as departingFlightId of an owner-passenger Connection,
      // and ALSO has an unrelated friend-followed UserFlight/Ticket that must NOT leak!
      src
        .prepare(
          `INSERT INTO Flight (id, number, airlineId, departureAirportId, scheduledArrivalAirportId,
             departureScheduleGateOriginal, arrivalScheduleGateOriginal, deleted)
           VALUES (?, '205', ?, 'airport-b', 'airport-c', ?, ?, NULL)`
        )
        .run(
          sentinels.connectedExtraOutFlightId,
          IDS.airline,
          now + 7200,
          now + 10800
        );
      src
        .prepare(
          "INSERT INTO Connection VALUES ('conn-extra-leg', ?, ?, 'airport-b', 45, NULL)"
        )
        .run(IDS.flight, sentinels.connectedExtraOutFlightId);
      src
        .prepare("INSERT INTO UserFlight VALUES (?, ?, 'friend-follow', NULL, 0)")
        .run(sentinels.unrelatedUserId, sentinels.connectedExtraOutFlightId);
      src
        .prepare(
          "INSERT INTO Ticket VALUES (?, ?, '14A', 'window', 'economy', ?, 'secret-trip')"
        )
        .run(
          sentinels.connectedExtraOutFlightId,
          sentinels.unrelatedUserId,
          sentinels.connectedExtraFriendPnr
        );

      // Hard-deleted row performed LAST with secure_delete=OFF so its bytes remain in source DB free-list slack space
      src
        .prepare(
          `INSERT INTO Flight (id, number, airlineId, departureAirportId, scheduledArrivalAirportId,
             departureScheduleGateOriginal, arrivalScheduleGateOriginal, deleted)
           VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', ?, ?, 'airport-a', 'airport-b', ?, ?, NULL)`
        )
        .run(sentinels.freePageSlack, IDS.airline, now, now + 3600);
      src
        .prepare(
          "DELETE FROM Flight WHERE id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'"
        )
        .run();
    } finally {
      src.close();
    }

    // Confirm free-page sentinel still exists in raw source DB bytes
    const srcBytes = readFileSync(fixture.mainPath);
    expect(srcBytes.includes(Buffer.from(sentinels.freePageSlack, "utf8"))).toBe(
      true
    );

    const outputBundleDir = join(root, "clean-bundle");
    const exported = await exportReplicaBundle({
      sourceDbPath: fixture.mainPath,
      outputBundleDir,
      requiredMountPath: root,
      producerId: "imac-test-exporter",
      accountId: "acct-synthetic-1",
      ownerUserId: IDS.owner,
      epoch: 1,
      sequence: 1,
      signingPrivateKey: TEST_PRIV_KEY,
      captureStartedAt: "2026-11-08T21:00:00.000Z",
      captureCompletedAt: "2026-11-08T21:00:01.000Z",
    });

    const destBytes = readFileSync(exported.dbPath);
    for (const [label, sentinel] of [
      ["authToken", sentinels.authToken],
      ["extraToken", sentinels.extraToken],
      ["syncUrl", sentinels.syncUrl],
      ["unknownTableSecret", sentinels.unknownTableSecret],
      ["unknownColSecret", sentinels.unknownColSecret],
      ["triggerSecret", sentinels.triggerSecret],
      ["viewSecret", sentinels.viewSecret],
      ["softDeletedFlight", sentinels.softDeletedFlight],
      ["freePageSlack", sentinels.freePageSlack],
      ["unrelatedFriendFollowedFlightId", sentinels.unrelatedFriendFollowedFlightId],
      ["unrelatedFriendFollowedPnr", sentinels.unrelatedFriendFollowedPnr],
      ["unrelatedUserId", sentinels.unrelatedUserId],
      ["unrelatedProfileName", sentinels.unrelatedProfileName],
      ["connectedExtraFriendPnr", sentinels.connectedExtraFriendPnr],
      ["nextURL column name", "nextURL"],
      ["authToken column name", "authToken"],
    ] as const) {
      expect(
        destBytes.includes(Buffer.from(sentinel, "utf8")),
        `Expected sentinel '${label}' to be absent from replica.db bytes`
      ).toBe(false);
    }

    // Sensitive owner & shared-passenger features MUST remain intact.
    expect(destBytes.includes(Buffer.from("SYNTHETIC-PNR", "utf8"))).toBe(true);
    expect(destBytes.includes(Buffer.from("SYNTHETIC-FOLLOW-PNR", "utf8"))).toBe(
      true
    );
    expect(destBytes.includes(Buffer.from("Synthetic Friend", "utf8"))).toBe(
      true
    );

    // Inspect exported schema and connected-leg behavior.
    const replicaDb = new DatabaseSync(exported.dbPath, { readOnly: true });
    try {
      const tables = (
        replicaDb
          .prepare("SELECT name, type FROM sqlite_master ORDER BY name ASC")
          .all() as Array<{ name: string; type: string }>
      ).map((r) => `${r.type}:${r.name}`);
      expect(tables).toEqual(REPLICA_TABLE_NAMES.map((n) => `table:${n}`));

      // Connected-leg operational Flight row was included so getConnections() preserves join semantics,
      // without including any unrelated UserFlight/Ticket/Profile row.
      const fdb = new FlightyDatabase(
        exported.dbPath,
        join(root, "missing-auth.sqlite")
      );
      const connections = fdb.getConnections();
      expect(connections.map((c) => c.id)).toEqual(
        expect.arrayContaining(["synthetic-connection", "conn-extra-leg"])
      );
    } finally {
      replicaDb.close();
    }
  });

  it("supports all cached MCP read queries and READ_CASES directly against exported replica.db", async () => {
    const root = makeTempDir();
    const fixture = createFixture(root);
    const outputBundleDir = join(root, "read-cases-bundle");

    const exported = await exportReplicaBundle({
      sourceDbPath: fixture.mainPath,
      outputBundleDir,
      requiredMountPath: root,
      producerId: "imac-test-exporter",
      accountId: "acct-synthetic-1",
      ownerUserId: IDS.owner,
      epoch: 1,
      sequence: 1,
      signingPrivateKey: TEST_PRIV_KEY,
      captureStartedAt: "2026-11-08T21:00:00.000Z",
      captureCompletedAt: "2026-11-08T21:00:01.000Z",
    });

    const fdb = new FlightyDatabase(
      exported.dbPath,
      join(root, "no-auth-db.sqlite")
    );

    const handlers = new Map<
      string,
      (args: Record<string, unknown>) => Promise<unknown>
    >();
    const server = {
      registerTool(
        name: string,
        _config: Record<string, unknown>,
        cb: (args: Record<string, unknown>) => Promise<unknown>
      ) {
        handlers.set(name, cb);
      },
    } as unknown as McpServer;

    installToolSafety(server, fdb, { dbPath: exported.dbPath });

    registerFlightTools(server, fdb);
    registerFlightStatusTools(server, fdb);
    registerFriendTools(server, fdb);
    registerReferenceTools(server, fdb);
    registerStatsTools(server, fdb);
    registerConnectionTools(server, fdb);
    registerTrackingTools(server, fdb);
    server.registerTool(
      "flighty_about",
      { title: "About", description: "About", inputSchema: {} },
      async () => ({
        content: [
          { type: "text", text: JSON.stringify({ version: "1.10.1" }) },
        ],
      })
    );

    for (const [toolName, args, verifyFn] of READ_CASES as Array<
      [string, Record<string, unknown>, (body: unknown) => void]
    >) {
      const handler = handlers.get(toolName);
      expect(handler, `Missing handler for ${toolName}`).toBeDefined();
      const rawResult = await handler!(args);
      const parsedBody = parseToolResult(rawResult);
      verifyFn(parsedBody);
    }

    // Also check getRemovalFlight and lookupAirlines and readDatabaseFreshness directly on replica.db.
    const removalPassenger = fdb.getRemovalFlight(IDS.flight);
    expect(removalPassenger?.record).toBe("passenger");
    expect(removalPassenger?.flight.booking_reference).toBe("SYNTHETIC-PNR");

    const removalFollowed = fdb.getRemovalFlight(IDS.followed);
    expect(removalFollowed?.record).toBe("followed");

    const airlines = fdb.lookupAirlines("ZZ");
    expect(airlines).toEqual([
      { id: IDS.airline, name: "Synthetic Airline", iata: "ZZ" },
    ]);

    const freshness = readDatabaseFreshness(exported.dbPath);
    expect(freshness.status).toBe("unknown");
    expect(freshness.unknown_reason_code).toBe(
      "unverified_numeric_sync_format"
    );
  });

  it("enforces mount check, rejects missing/unknown source schema columns, and redacts paths from error messages", async () => {
    const root = makeTempDir();
    const fixture = createFixture(root);

    // 1. Mount check failure (simulating unmounted PRO-G40) must fail without creating output.
    const unmountedOut = join(root, "unmounted-bundle");
    await expect(
      exportReplicaBundle({
        sourceDbPath: fixture.mainPath,
        outputBundleDir: unmountedOut,
        requiredMountPath: root,
        mountCheck: () => false,
        producerId: "imac-test-exporter",
        accountId: "acct-synthetic-1",
        ownerUserId: IDS.owner,
        epoch: 1,
        sequence: 1,
        signingPrivateKey: TEST_PRIV_KEY,
      })
    ).rejects.toMatchObject({
      code: "MOUNT_UNAVAILABLE",
    });

    // 2. Symlink source database rejection and path redaction check.
    const symlinkDb = join(root, "symlink-source.db");
    symlinkSync(fixture.mainPath, symlinkDb);
    try {
      await exportReplicaBundle({
        sourceDbPath: symlinkDb,
        outputBundleDir: join(root, "symlink-bundle"),
        requiredMountPath: root,
        producerId: "imac-test-exporter",
        accountId: "acct-synthetic-1",
        ownerUserId: IDS.owner,
        epoch: 1,
        sequence: 1,
        signingPrivateKey: TEST_PRIV_KEY,
      });
      expect.unreachable("Should have rejected symlink sourceDbPath");
    } catch (err) {
      expect(err).toBeInstanceOf(ReplicaError);
      expect((err as ReplicaError).code).toBe("INVALID_PATH");
      expect((err as Error).message).not.toContain(root);
      expect((err as Error).message).not.toContain("symlink-source.db");
    }

    // 3. Missing required column in source DB fails clearly with SOURCE_SCHEMA_INVALID and never echoes paths/values.
    const badDbPath = join(root, "bad-schema.db");
    const badDb = new DatabaseSync(badDbPath);
    badDb.exec(
      "CREATE TABLE Airline (id TEXT, name TEXT); INSERT INTO Airline VALUES ('secret-id', 'SECRET_AIRLINE_VALUE');"
    );
    badDb.close();

    try {
      await exportReplicaBundle({
        sourceDbPath: badDbPath,
        outputBundleDir: join(root, "bad-schema-bundle"),
        requiredMountPath: root,
        producerId: "imac-test-exporter",
        accountId: "acct-synthetic-1",
        ownerUserId: IDS.owner,
        epoch: 1,
        sequence: 1,
        signingPrivateKey: TEST_PRIV_KEY,
      });
      expect.unreachable("Should have rejected incomplete source schema");
    } catch (err) {
      expect(err).toBeInstanceOf(ReplicaError);
      expect((err as ReplicaError).code).toBe("SOURCE_SCHEMA_INVALID");
      expect((err as Error).message).toContain("missing required");
      expect((err as Error).message).not.toContain(root);
      expect((err as Error).message).not.toContain("SECRET_AIRLINE_VALUE");
    }

    // 4. Corrupt non-SQLite source file fails with BACKUP_FAILED and redacts path/content.
    const corruptPath = join(root, "corrupt.db");
    writeFileSync(
      corruptPath,
      "NOT_A_SQLITE_FILE_WITH_SECRET_TOKEN_eyJhbGciOiJIUzI1NiJ9.payload.sig"
    );
    try {
      await exportReplicaBundle({
        sourceDbPath: corruptPath,
        outputBundleDir: join(root, "corrupt-bundle"),
        requiredMountPath: root,
        producerId: "imac-test-exporter",
        accountId: "acct-synthetic-1",
        ownerUserId: IDS.owner,
        epoch: 1,
        sequence: 1,
        signingPrivateKey: TEST_PRIV_KEY,
      });
      expect.unreachable("Should have failed on corrupt source file");
    } catch (err) {
      expect(err).toBeInstanceOf(ReplicaError);
      expect((err as Error).message).not.toContain(root);
      expect((err as Error).message).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    }

    // 5. Real Flighty container path is blocked by default.
    const fakeContainerPath = join(
      root,
      "Library/Containers/com.flightyapp.flighty/Data/Documents/MainFlightyDatabase.db"
    );
    mkdirSync(join(fakeContainerPath, ".."), { recursive: true });
    await expect(
      exportReplicaBundle({
        sourceDbPath: fakeContainerPath,
        outputBundleDir: join(root, "container-bundle"),
        requiredMountPath: root,
        producerId: "imac-test-exporter",
        accountId: "acct-synthetic-1",
        ownerUserId: IDS.owner,
        epoch: 1,
        sequence: 1,
        signingPrivateKey: TEST_PRIV_KEY,
      })
    ).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });

    // 6. Refuses to overwrite an existing non-empty bundle directory.
    const existingBundleDir = join(root, "existing-non-empty");
    mkdirSync(existingBundleDir, { recursive: true });
    writeFileSync(join(existingBundleDir, "replica.db"), "do-not-overwrite");
    await expect(
      exportReplicaBundle({
        sourceDbPath: fixture.mainPath,
        outputBundleDir: existingBundleDir,
        requiredMountPath: root,
        producerId: "imac-test-exporter",
        accountId: "acct-synthetic-1",
        ownerUserId: IDS.owner,
        epoch: 1,
        sequence: 1,
        signingPrivateKey: TEST_PRIV_KEY,
      })
    ).rejects.toMatchObject({
      code: "OUTPUT_EXISTS",
    });
    expect(readFileSync(join(existingBundleDir, "replica.db"), "utf8")).toBe(
      "do-not-overwrite"
    );
  });

  it("supports owner-only export (includeSharedPassengers: false) and scrubs unsafe SyncInfo.lastSync values", async () => {
    const root = makeTempDir();
    const fixture = createFixture(root);

    const db = new DatabaseSync(fixture.mainPath);
    try {
      db.prepare("UPDATE SyncInfo SET lastSync = ?").run(
        "https://sync.flightyapp.com/private?secret=SHOULD_BE_SCRUBBED"
      );
    } finally {
      db.close();
    }

    const exported = await exportReplicaBundle({
      sourceDbPath: fixture.mainPath,
      outputBundleDir: join(root, "owner-only-bundle"),
      requiredMountPath: root,
      producerId: "imac-test-exporter",
      accountId: "acct-synthetic-1",
      ownerUserId: IDS.owner,
      includeSharedPassengers: false,
      epoch: 1,
      sequence: 1,
      signingPrivateKey: TEST_PRIV_KEY,
      captureStartedAt: "2026-11-08T21:00:00.000Z",
      captureCompletedAt: "2026-11-08T21:00:01.000Z",
    });

    expect(exported.manifest.includeSharedPassengers).toBe(false);
    expect(exported.manifest.rowCounts.Profile).toBe(0);

    const rawBytes = readFileSync(exported.dbPath);
    expect(rawBytes.includes(Buffer.from("Synthetic Friend", "utf8"))).toBe(
      false
    );
    expect(rawBytes.includes(Buffer.from("SHOULD_BE_SCRUBBED", "utf8"))).toBe(
      false
    );

    const fdb = new FlightyDatabase(
      exported.dbPath,
      join(root, "missing.sqlite")
    );
    // Owner passenger flights (2) and owner followed flight (1) remain; shared friend flight is excluded.
    expect(fdb.listFlights()).toHaveLength(2);
    const friendOrFollowed = fdb.listFriendFlights();
    expect(friendOrFollowed).toHaveLength(1);
    expect(friendOrFollowed[0].id).toBe(IDS.followed);
  });
});
