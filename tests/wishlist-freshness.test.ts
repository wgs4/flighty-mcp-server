import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FlightyDatabase } from "../src/services/database.js";
import { FlightyApi } from "../src/services/flighty-api.js";
import {
  FRESHNESS_ACCOUNT_SCOPE_NOTE,
  FRESHNESS_LOCAL_CACHE_NOTE,
  QUERIED_AT_MEANING,
  formatFreshnessNoticeLine,
  parseSyncTimestamp,
  readDatabaseFreshness,
} from "../src/services/freshness.js";
import {
  DATA_TRUST_LABEL,
  OWNER_SCOPED_TOOLS,
  UNTRUSTED_DATA_ENVELOPE_NOTICE,
  createSanitizedToolError,
  installToolSafety,
  isOwnerScopedTool,
  wrapToolResult,
} from "../src/services/tool-safety.js";
import { registerFlightTools } from "../src/tools/flights.js";
import { registerFlightStatusTools } from "../src/tools/flight-status.js";
import { registerReferenceTools } from "../src/tools/reference.js";
import { registerWriteTools } from "../src/tools/write.js";
import { createFixture, IDS } from "./fixture/create.mjs";
import { fixtureTempRoot, trashFixture } from "./fixture/lifecycle.mjs";

const FIXED_NOW_ISO = "2026-11-08T19:30:00.000Z";
const FIXED_NOW_MS = Date.parse(FIXED_NOW_ISO);

describe("Freshness parsing and isolated SQLite SyncInfo.lastSync reader", () => {
  let fixture: ReturnType<typeof createFixture>;

  beforeEach(() => {
    fixture = createFixture(fixtureTempRoot());
  });

  afterEach(() => {
    trashFixture(fixture.directory);
  });

  function withRawDb(fn: (raw: DatabaseSync) => void): void {
    const raw = new DatabaseSync(fixture.mainPath);
    try {
      fn(raw);
    } finally {
      raw.close();
    }
  }

  it("parses valid explicit-timezone ISO-8601 timestamps (UTC Z and numeric offsets) and computes accurate sync age", () => {
    withRawDb((raw) => {
      raw.exec("DELETE FROM SyncInfo");
      raw
        .prepare("INSERT INTO SyncInfo (nextURL, lastSync) VALUES (?, ?)")
        .run(
          "https://sync.flightyapp.com/synthetic?secret_token=never_leak",
          "2026-11-08T13:15:00-06:00" // equals 2026-11-08T19:15:00.000Z (15 minutes before FIXED_NOW_ISO)
        );
    });

    const freshness = readDatabaseFreshness({
      dbPath: fixture.mainPath,
      now: FIXED_NOW_MS,
    });

    expect(freshness).toEqual({
      queried_at: FIXED_NOW_ISO,
      queried_at_meaning: QUERIED_AT_MEANING,
      last_synced_at: "2026-11-08T19:15:00.000Z",
      sync_age_seconds: 900,
      sync_age_minutes: 15,
      status: "known",
      source: "SyncInfo.lastSync",
      scope: "account_database_sync",
      scope_note: FRESHNESS_ACCOUNT_SCOPE_NOTE,
      unknown_reason_code: null,
      unknown_reason: null,
      is_future_marker: false,
      cache_note: FRESHNESS_LOCAL_CACHE_NOTE,
    });
    expect(freshness.scope_note).toMatch(/account\/database/i);
    expect(freshness.scope_note).toMatch(/not confirm.*individual flight/i);
    expect(freshness.cache_note).toMatch(/local Flighty SQLite cache/i);
    expect(freshness.cache_note).toMatch(/do not trigger a live network refresh/i);
    expect(JSON.stringify(freshness)).not.toContain("secret_token");
    expect(JSON.stringify(freshness)).not.toContain("sync.flightyapp.com");
  });

  it("does not reset last_synced_at to now on reread and never uses file mtime as sync time", () => {
    const syncIso = "2026-11-08T18:00:00.000Z";
    withRawDb((raw) => {
      raw.exec("DELETE FROM SyncInfo");
      raw
        .prepare("INSERT INTO SyncInfo (nextURL, lastSync) VALUES (?, ?)")
        .run("https://sync.flightyapp.com/synthetic", syncIso);
    });

    // Set file mtime to Fixed Now so any mtime fallback would falsely report 0s age
    const mtimeDate = new Date(FIXED_NOW_MS);
    utimesSync(fixture.mainPath, mtimeDate, mtimeDate);

    const firstRead = readDatabaseFreshness({
      dbPath: fixture.mainPath,
      now: FIXED_NOW_MS,
    });
    expect(firstRead.queried_at).toBe(FIXED_NOW_ISO);
    expect(firstRead.last_synced_at).toBe(syncIso);
    expect(firstRead.sync_age_seconds).toBe(5400);
    expect(firstRead.sync_age_minutes).toBe(90);

    // Reread 10 minutes later without SyncInfo changing
    const laterMs = FIXED_NOW_MS + 10 * 60 * 1000;
    const secondRead = readDatabaseFreshness({
      dbPath: fixture.mainPath,
      now: laterMs,
    });
    expect(secondRead.queried_at).toBe("2026-11-08T19:40:00.000Z");
    expect(secondRead.last_synced_at).toBe(syncIso);
    expect(secondRead.sync_age_seconds).toBe(6000);
    expect(secondRead.sync_age_minutes).toBe(100);
  });

  it.each([
    ["small integer sequence", 1],
    ["unix seconds", 1731091200],
    ["unix milliseconds", 1731091200000],
    ["apple core data float", 784406400.5],
    ["negative number", -42],
    ["numeric string", "1731091200"],
  ])(
    "treats %s (%s) as unknown with unverified_numeric_sync_format and never exposes the raw marker",
    (_label, rawValue) => {
      withRawDb((raw) => {
        raw.exec("DELETE FROM SyncInfo");
        raw
          .prepare("INSERT INTO SyncInfo (nextURL, lastSync) VALUES (?, ?)")
          .run("https://sync.flightyapp.com/synthetic", rawValue);
      });

      const freshness = readDatabaseFreshness({
        dbPath: fixture.mainPath,
        now: FIXED_NOW_MS,
      });

      expect(freshness.status).toBe("unknown");
      expect(freshness.last_synced_at).toBeNull();
      expect(freshness.sync_age_seconds).toBeNull();
      expect(freshness.sync_age_minutes).toBeNull();
      expect(freshness.unknown_reason_code).toBe(
        "unverified_numeric_sync_format"
      );
      expect(freshness.unknown_reason).toMatch(/numeric/i);
      expect(freshness.unknown_reason).toMatch(/unverified/i);
      expect(freshness.is_future_marker).toBe(false);
      if (String(rawValue).length > 2) {
        expect(JSON.stringify(freshness)).not.toContain(String(rawValue));
      }
    }
  );

  it.each([
    ["missing timezone designator", "2024-07-04T18:00:00"],
    ["date only", "2024-07-04"],
    ["non-leap Feb 29 rollover", "2025-02-29T12:00:00Z"],
    ["Feb 30 rollover", "2026-02-30T12:00:00Z"],
    ["April 31 rollover", "2026-04-31T12:00:00Z"],
    ["hour out of range", "2026-11-08T25:00:00Z"],
    ["RFC3339 unknown local offset -00:00", "2026-11-08T12:00:00-00:00"],
    ["arbitrary secret text", "raw-invalid-marker-secret-value-98765"],
  ])(
    "rejects invalid or ambiguous marker (%s) without exposing raw marker text",
    (_label, badMarker) => {
      withRawDb((raw) => {
        raw.exec("DELETE FROM SyncInfo");
        raw
          .prepare("INSERT INTO SyncInfo (nextURL, lastSync) VALUES (?, ?)")
          .run("https://sync.flightyapp.com/synthetic", badMarker);
      });

      const freshness = readDatabaseFreshness({
        dbPath: fixture.mainPath,
        now: FIXED_NOW_MS,
      });

      expect(freshness.status).toBe("unknown");
      expect(freshness.last_synced_at).toBeNull();
      expect(freshness.sync_age_seconds).toBeNull();
      expect(freshness.sync_age_minutes).toBeNull();
      expect(freshness.unknown_reason_code).toBe(
        "invalid_or_ambiguous_sync_timestamp"
      );
      expect(freshness.is_future_marker).toBe(false);
      expect(JSON.stringify(freshness)).not.toContain(badMarker);
    }
  );

  it("handles future ISO-8601 markers without claiming fresh or negative sync age", () => {
    const futureMarker = "2026-11-08T21:00:00.000Z";
    withRawDb((raw) => {
      raw.exec("DELETE FROM SyncInfo");
      raw
        .prepare("INSERT INTO SyncInfo (nextURL, lastSync) VALUES (?, ?)")
        .run("https://sync.flightyapp.com/synthetic", futureMarker);
    });

    const freshness = readDatabaseFreshness({
      dbPath: fixture.mainPath,
      now: FIXED_NOW_MS,
    });

    expect(freshness.status).toBe("unknown");
    expect(freshness.last_synced_at).toBeNull();
    expect(freshness.sync_age_seconds).toBeNull();
    expect(freshness.sync_age_minutes).toBeNull();
    expect(freshness.is_future_marker).toBe(true);
    expect(freshness.unknown_reason_code).toBe("future_sync_timestamp");
    expect(freshness.unknown_reason).toMatch(/future/i);
    expect(JSON.stringify(freshness)).not.toContain(futureMarker);
  });

  it("reports missing_database, missing_sync_table, missing_last_sync_column, missing_sync_row, and empty_last_sync_marker without leaking paths or SQLite errors", () => {
    // 1. Missing database file
    const missingDbPath = join(
      fixture.directory,
      "secret-folder-name",
      "MissingDatabase.db"
    );
    const missingFile = readDatabaseFreshness({
      dbPath: missingDbPath,
      now: FIXED_NOW_MS,
    });
    expect(missingFile.status).toBe("unknown");
    expect(missingFile.last_synced_at).toBeNull();
    expect(missingFile.unknown_reason_code).toBe("missing_database");
    expect(JSON.stringify(missingFile)).not.toContain("secret-folder-name");
    expect(JSON.stringify(missingFile)).not.toContain("MissingDatabase.db");

    // 2. Empty SyncInfo row (NULL / blank lastSync)
    withRawDb((raw) => {
      raw.exec("DELETE FROM SyncInfo");
      raw
        .prepare("INSERT INTO SyncInfo (nextURL, lastSync) VALUES (?, NULL)")
        .run("https://sync.flightyapp.com/synthetic");
      raw
        .prepare("INSERT INTO SyncInfo (nextURL, lastSync) VALUES (?, '   ')")
        .run("https://sync.flightyapp.com/synthetic");
    });
    const emptyMarker = readDatabaseFreshness({
      dbPath: fixture.mainPath,
      now: FIXED_NOW_MS,
    });
    expect(emptyMarker.status).toBe("unknown");
    expect(emptyMarker.unknown_reason_code).toBe("empty_last_sync_marker");

    // 3. Missing SyncInfo row (0 rows)
    withRawDb((raw) => {
      raw.exec("DELETE FROM SyncInfo");
    });
    const missingRow = readDatabaseFreshness({
      dbPath: fixture.mainPath,
      now: FIXED_NOW_MS,
    });
    expect(missingRow.status).toBe("unknown");
    expect(missingRow.unknown_reason_code).toBe("missing_sync_row");

    // 4. Missing lastSync column
    withRawDb((raw) => {
      raw.exec("DROP TABLE SyncInfo");
      raw.exec("CREATE TABLE SyncInfo (nextURL TEXT)");
    });
    const missingCol = readDatabaseFreshness({
      dbPath: fixture.mainPath,
      now: FIXED_NOW_MS,
    });
    expect(missingCol.status).toBe("unknown");
    expect(missingCol.unknown_reason_code).toBe("missing_last_sync_column");

    // 5. Missing SyncInfo table
    withRawDb((raw) => {
      raw.exec("DROP TABLE SyncInfo");
    });
    const missingTable = readDatabaseFreshness({
      dbPath: fixture.mainPath,
      now: FIXED_NOW_MS,
    });
    expect(missingTable.status).toBe("unknown");
    expect(missingTable.unknown_reason_code).toBe("missing_sync_table");
    expect(JSON.stringify(missingTable)).not.toContain(fixture.directory);
  });

  it("supports direct parseSyncTimestamp unit checks", () => {
    const valid = parseSyncTimestamp("2026-11-08T19:00:00Z", FIXED_NOW_MS);
    expect(valid).toEqual({
      kind: "known",
      lastSyncedAt: "2026-11-08T19:00:00.000Z",
      parsedMs: Date.parse("2026-11-08T19:00:00.000Z"),
      syncAgeSeconds: 1800,
      syncAgeMinutes: 30,
    });

    expect(parseSyncTimestamp(12345, FIXED_NOW_MS)).toEqual({
      kind: "unknown",
      reasonCode: "unverified_numeric_sync_format",
      isFutureMarker: false,
    });
  });
});

describe("Shared safety wrapper: envelopes, reference/about isolation, hostile payloads, concurrency, and removal stability", () => {
  let fixture: ReturnType<typeof createFixture>;

  beforeEach(() => {
    fixture = createFixture(fixtureTempRoot());
    const raw = new DatabaseSync(fixture.mainPath);
    try {
      raw.exec("DELETE FROM SyncInfo");
      raw
        .prepare("INSERT INTO SyncInfo (nextURL, lastSync) VALUES (?, ?)")
        .run(
          "https://sync.flightyapp.com/synthetic-fixture",
          "2026-11-08T19:00:00.000Z"
        );
    } finally {
      raw.close();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    trashFixture(fixture.directory);
  });

  it("registers planned tracking and connection tools in OWNER_SCOPED_TOOLS now and wraps interleaved async invocations without cross-talk", async () => {
    expect(OWNER_SCOPED_TOOLS.has("flighty_get_tracking_status")).toBe(true);
    expect(OWNER_SCOPED_TOOLS.has("flighty_check_connection")).toBe(true);
    expect(isOwnerScopedTool("flighty_get_tracking_status")).toBe(true);
    expect(isOwnerScopedTool("flighty_check_connection")).toBe(true);

    const db = new FlightyDatabase(fixture.mainPath, fixture.legacyPath);
    let currentClock = FIXED_NOW_MS;
    const server = new McpServer({
      name: "planned-owner-tools-test",
      version: "1.10.1",
    });
    installToolSafety(server, db, {
      now: () => {
        const val = currentClock;
        currentClock += 60_000;
        return val;
      },
    });

    let releaseTracking!: () => void;
    const trackingBarrier = new Promise<void>((resolve) => {
      releaseTracking = resolve;
    });

    server.registerTool(
      "flighty_get_tracking_status",
      {
        title: "Tracking Status",
        description: "Get flight tracking status",
        inputSchema: {},
      },
      async () => {
        db.getOwnerIdentity();
        await trackingBarrier;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ phase: "airborne", flight_id: IDS.flight }),
            },
          ],
        };
      }
    );

    server.registerTool(
      "flighty_check_connection",
      {
        title: "Check Connection",
        description: "Check connection between two flights",
        inputSchema: {},
      },
      async () => {
        db.getOwnerIdentity();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                inbound_flight_id: IDS.flight,
                outbound_flight_id: IDS.manual,
                layover_minutes: 120,
              }),
            },
          ],
        };
      }
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "planned-tools-client", version: "1.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const trackingPromise = client.callTool({
        name: "flighty_get_tracking_status",
        arguments: {},
      });
      const connectionRes = await client.callTool({
        name: "flighty_check_connection",
        arguments: {},
      });
      releaseTracking();
      const trackingRes = await trackingPromise;

      const trackingBody = JSON.parse(
        (trackingRes.content as Array<{ text: string }>)[0].text
      );
      const connectionBody = JSON.parse(
        (connectionRes.content as Array<{ text: string }>)[0].text
      );

      expect(trackingBody.phase).toBe("airborne");
      expect(trackingBody.owner_identity.user_id).toBe(IDS.owner);
      expect(trackingBody.queried_at).toBe("2026-11-08T19:30:00.000Z");
      expect(trackingBody.freshness.sync_age_seconds).toBe(1800);

      expect(connectionBody.layover_minutes).toBe(120);
      expect(connectionBody.owner_identity.user_id).toBe(IDS.owner);
      expect(connectionBody.queried_at).toBe("2026-11-08T19:31:00.000Z");
      expect(connectionBody.freshness.sync_age_seconds).toBe(1860);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("does not read DB, SyncInfo, owner identity, or credentials for flighty_about or reference tools", async () => {
    // Use a directory with NO SQLite files at all for flighty_about and callback-mocked reference tools
    const emptyDir = mkdtempSync(join(fixtureTempRoot(), "flighty-no-db-"));
    try {
      const missingMain = join(emptyDir, "DoesNotExist.db");
      const missingAuth = join(emptyDir, "DoesNotExistAuth.sqlite");
      const db = new FlightyDatabase(missingMain, missingAuth);
      const getOwnerSpy = vi.spyOn(db, "getOwnerIdentity");

      const server = new McpServer({
        name: "freshness-isolation-test",
        version: "1.10.1",
      });
      installToolSafety(server, db, { now: () => FIXED_NOW_MS });

      server.registerTool(
        "flighty_about",
        {
          title: "About",
          description: "Static server info",
          inputSchema: {},
        },
        async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({ name: "Flighty MCP Server", version: "1.10.1" }),
            },
          ],
        })
      );

      // Register reference tools against a callback mock that returns synthetic reference data without opening SQLite
      const mockRefDb = {
        searchAirports: vi.fn(() => [
          { id: "ap-1", iata: "SFO", name: "San Francisco International" },
        ]),
        searchAirlines: vi.fn(() => [
          { id: "al-1", iata: "UA", name: "United Airlines" },
        ]),
        getOwnerIdentity: vi.fn(() => {
          throw new Error("Reference tool must not resolve owner identity");
        }),
      } as unknown as FlightyDatabase;
      registerReferenceTools(server, mockRefDb);

      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "isolation-client", version: "1.0.0" });
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      try {
        const aboutRes = await client.callTool({
          name: "flighty_about",
          arguments: {},
        });
        expect(aboutRes.isError).toBeFalsy();
        const aboutBody = JSON.parse(
          (aboutRes.content as Array<{ text: string }>)[0].text
        );
        expect(aboutBody.queried_at).toBe(FIXED_NOW_ISO);
        expect(aboutBody.freshness).toMatchObject({
          queried_at: FIXED_NOW_ISO,
          last_synced_at: null,
          sync_age_seconds: null,
          sync_age_minutes: null,
          status: "not_applicable",
          source: "none",
          scope: "static_or_reference_data",
          unknown_reason_code: "not_applicable_static_or_reference_tool",
        });
        expect(aboutBody.owner_identity).toBeUndefined();

        const airportRes = await client.callTool({
          name: "flighty_search_airports",
          arguments: { query: "SFO" },
        });
        expect(airportRes.isError).toBeFalsy();
        const airportBody = JSON.parse(
          (airportRes.content as Array<{ text: string }>)[0].text
        );
        expect(airportBody.queried_at).toBe(FIXED_NOW_ISO);
        expect(airportBody.freshness).toMatchObject({
          queried_at: FIXED_NOW_ISO,
          last_synced_at: null,
          status: "not_applicable",
          source: "none",
          scope: "static_or_reference_data",
          unknown_reason_code: "not_applicable_static_or_reference_tool",
        });
        expect(airportBody.owner_identity).toBeUndefined();
        expect(getOwnerSpy).not.toHaveBeenCalled();
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      trashFixture(emptyDir);
    }
  });

  it("degrades honestly when owner-scoped tools run with callback mocks that lack a SQLite file", async () => {
    const mockDb = {
      listFlights: () => [],
      clearLastOwnerIdentity: () => {},
      getLastOwnerIdentity: () => ({
        userId: IDS.owner,
        source: "jwt_subject" as const,
        label: "signed_in_owner" as const,
        isFallback: false,
        isSharedOwner: false,
      }),
    } as unknown as FlightyDatabase;

    const server = new McpServer({
      name: "callback-mock-test",
      version: "1.0.0",
    });
    installToolSafety(server, mockDb, { now: () => FIXED_NOW_MS });
    registerFlightTools(server, mockDb);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "mock-client", version: "1.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const res = await client.callTool({
        name: "flighty_list_flights",
        arguments: {},
      });
      expect(res.isError).toBeFalsy();
      const body = JSON.parse((res.content as Array<{ text: string }>)[0].text);
      expect(body.count).toBe(0);
      expect(body.queried_at).toBe(FIXED_NOW_ISO);
      expect(body.freshness).toMatchObject({
        queried_at: FIXED_NOW_ISO,
        last_synced_at: null,
        sync_age_seconds: null,
        status: "unknown",
        source: "SyncInfo.lastSync",
        scope: "account_database_sync",
        unknown_reason_code: "missing_database",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("attaches freshness across JSON, plaintext not-found, empty, validation error, handler error, and direct createToolError paths", async () => {
    const db = new FlightyDatabase(fixture.mainPath, fixture.legacyPath);
    const server = new McpServer({
      name: "all-envelopes-test",
      version: "1.10.1",
    });
    installToolSafety(server, db, { now: () => FIXED_NOW_MS });
    registerFlightTools(server, db);
    registerFlightStatusTools(server, db);

    server.registerTool(
      "synthetic_throwing_tool",
      {
        title: "Throwing Tool",
        description: "Throws an error with sensitive path",
        inputSchema: {},
      },
      async () => {
        throw new Error(
          `Failed reading ${fixture.mainPath} with Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig`
        );
      }
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "envelopes-client", version: "1.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      // 1. JSON envelope
      const listRes = await client.callTool({
        name: "flighty_list_flights",
        arguments: {},
      });
      expect(listRes.isError).toBeFalsy();
      const listBody = JSON.parse(
        (listRes.content as Array<{ text: string }>)[0].text
      );
      expect(listBody.queried_at).toBe(FIXED_NOW_ISO);
      expect(listBody.freshness.last_synced_at).toBe("2026-11-08T19:00:00.000Z");
      expect(listBody.freshness.sync_age_seconds).toBe(1800);
      expect(listBody.freshness.sync_age_minutes).toBe(30);
      expect(listBody.freshness.status).toBe("known");
      expect(listBody.untrusted_data).toBe(true);
      expect(listBody.owner_label).toBe("signed_in_owner");

      // 2. Plaintext not-found response
      const missingStatus = await client.callTool({
        name: "flighty_get_flight_status",
        arguments: { flight_number: "ZZ999" },
      });
      expect(missingStatus.isError).toBeFalsy();
      const missingText = (
        missingStatus.content as Array<{ text: string }>
      )[0].text;
      expect(missingText).toContain("No flight found for 'ZZ999'");
      expect(missingText).toContain("[owner_identity: label=signed_in_owner");
      expect(missingText).toContain(
        "[freshness: queried_at=2026-11-08T19:30:00.000Z | last_synced_at=2026-11-08T19:00:00.000Z | sync_age_seconds=1800 | sync_age_minutes=30 | status=known | source=SyncInfo.lastSync | scope=account_database_sync"
      );
      expect(missingText).toContain(
        `[${DATA_TRUST_LABEL}: ${UNTRUSTED_DATA_ENVELOPE_NOTICE}]`
      );
      expect((missingStatus as { freshness?: { status?: string } }).freshness?.status).toBe("known");

      // 3. Input validation failure (Zod schema rejection before DB read)
      const invalidArgs = await client.callTool({
        name: "flighty_get_flight",
        arguments: { flight_id: "not-a-valid-uuid" },
      });
      expect(invalidArgs.isError).toBe(true);
      const invalidText = (
        invalidArgs.content as Array<{ text: string }>
      )[0].text;
      expect(invalidText).toMatch(/Input validation error.*flighty_get_flight/i);
      expect(invalidText).toContain(
        "status=unknown | source=none | scope=error_or_validation"
      );
      expect(invalidText).toContain(
        "unknown_reason_code=error_response_sync_not_queried"
      );
      expect(invalidText).toContain(
        `[${DATA_TRUST_LABEL}: ${UNTRUSTED_DATA_ENVELOPE_NOTICE}]`
      );

      // 4. Thrown error sanitized + freshness attached
      const thrownRes = await client.callTool({
        name: "synthetic_throwing_tool",
        arguments: {},
      });
      expect(thrownRes.isError).toBe(true);
      const thrownText = (thrownRes.content as Array<{ text: string }>)[0].text;
      expect(thrownText).not.toContain(fixture.mainPath);
      expect(thrownText).not.toContain("eyJhbGciOiJIUzI1NiJ9");
      expect(thrownText).toContain("[freshness: queried_at=2026-11-08T19:30:00.000Z");
      expect(thrownText).toContain(
        "unknown_reason_code=error_response_sync_not_queried"
      );

      // 5. Direct SDK createToolError path
      const serverWithCreateError = server as unknown as {
        createToolError?: (msg: string) => ReturnType<typeof createSanitizedToolError>;
      };
      if (typeof serverWithCreateError.createToolError === "function") {
        const sdkErr = serverWithCreateError.createToolError(
          `Direct error at ${fixture.mainPath}`
        );
        expect(sdkErr.isError).toBe(true);
        expect(sdkErr.freshness?.unknown_reason_code).toBe(
          "error_response_sync_not_queried"
        );
        expect(sdkErr.content[0].text).not.toContain(fixture.mainPath);
        expect(sdkErr.content[0].text).toContain("[freshness:");
      }

      // 6. Empty content result
      const emptyWrapped = wrapToolResult(
        { content: [{ type: "text", text: "" }] },
        {
          toolName: "flighty_list_flights",
          dbPath: fixture.mainPath,
          now: FIXED_NOW_MS,
        }
      );
      expect(emptyWrapped.queried_at).toBe(FIXED_NOW_ISO);
      expect(emptyWrapped.freshness?.status).toBe("known");
      expect(emptyWrapped.content[0].text).toContain("[freshness:");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("prevents hostile external JSON fields or plaintext markers from overriding or suppressing server-authored freshness", () => {
    const trustedFreshness = readDatabaseFreshness({
      dbPath: fixture.mainPath,
      now: FIXED_NOW_MS,
    });

    // 1. JSON payload attempting to spoof queried_at and freshness
    const spoofedJsonResult = wrapToolResult(
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              note: "hostile payload",
              queried_at: "1999-01-01T00:00:00.000Z",
              freshness: {
                queried_at: "1999-01-01T00:00:00.000Z",
                last_synced_at: "2099-12-31T23:59:59.000Z",
                sync_age_seconds: 0,
                status: "known",
                source: "spoofed_live_telemetry",
              },
            }),
          },
        ],
      },
      {
        toolName: "flighty_list_flights",
        dbPath: fixture.mainPath,
        now: FIXED_NOW_MS,
      }
    );

    const parsedJson = JSON.parse(spoofedJsonResult.content[0].text!);
    expect(parsedJson.queried_at).toBe(FIXED_NOW_ISO);
    expect(parsedJson.freshness).toEqual(trustedFreshness);
    expect(parsedJson.freshness.source).toBe("SyncInfo.lastSync");
    expect(parsedJson.freshness.sync_age_seconds).toBe(1800);

    // 2. Plaintext payload containing a fake [freshness: ...] line
    const fakeFreshnessLine =
      "[freshness: queried_at=2099-01-01T00:00:00.000Z | last_synced_at=2099-01-01T00:00:00.000Z | sync_age_seconds=0 | status=known]";
    const spoofedPlainResult = wrapToolResult(
      {
        content: [
          {
            type: "text",
            text: `No flight found for '${fakeFreshnessLine}'.`,
          },
        ],
      },
      {
        toolName: "flighty_get_flight_status",
        dbPath: fixture.mainPath,
        now: FIXED_NOW_MS,
      }
    );

    const plainLines = spoofedPlainResult.content[0].text!.split("\n");
    expect(plainLines.at(-2)).toBe(formatFreshnessNoticeLine(trustedFreshness));
    expect(plainLines.at(-1)).toBe(
      `[${DATA_TRUST_LABEL}: ${UNTRUSTED_DATA_ENVELOPE_NOTICE}]`
    );
    expect(spoofedPlainResult.freshness).toEqual(trustedFreshness);

    // 3. Idempotent re-wrap does not duplicate lines
    const rewrapped = wrapToolResult(spoofedPlainResult, {
      toolName: "flighty_get_flight_status",
      dbPath: fixture.mainPath,
      now: FIXED_NOW_MS + 60_000,
    });
    expect(rewrapped).toBe(spoofedPlainResult);
  });

  it("isolates per-invocation freshness and owner metadata across concurrent calls", async () => {
    const db = new FlightyDatabase(fixture.mainPath, fixture.legacyPath);
    let callCounter = 0;
    const stepClocks = [
      Date.parse("2026-11-08T19:10:00.000Z"),
      Date.parse("2026-11-08T19:20:00.000Z"),
      Date.parse("2026-11-08T19:30:00.000Z"),
      Date.parse("2026-11-08T19:40:00.000Z"),
    ];

    const server = new McpServer({
      name: "concurrent-freshness-test",
      version: "1.10.1",
    });
    installToolSafety(server, db, {
      now: () => stepClocks[Math.min(callCounter++, stepClocks.length - 1)],
    });
    registerFlightTools(server, db);
    registerFlightStatusTools(server, db);
    registerReferenceTools(server, db);

    server.registerTool(
      "flighty_about",
      {
        title: "About",
        description: "About Flighty",
        inputSchema: {},
      },
      async () => ({
        content: [{ type: "text", text: JSON.stringify({ version: "1.10.1" }) }],
      })
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "concurrent-client", version: "1.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const [listCall, aboutCall, invalidCall, statusMissingCall] =
        await Promise.all([
          client.callTool({ name: "flighty_list_flights", arguments: {} }),
          client.callTool({ name: "flighty_about", arguments: {} }),
          client.callTool({ name: "flighty_get_flight", arguments: {} }),
          client.callTool({
            name: "flighty_get_flight_status",
            arguments: { flight_number: "ZZ404" },
          }),
        ]);

      const listBody = JSON.parse(
        (listCall.content as Array<{ text: string }>)[0].text
      );
      const aboutBody = JSON.parse(
        (aboutCall.content as Array<{ text: string }>)[0].text
      );
      const invalidText = (
        invalidCall.content as Array<{ text: string }>
      )[0].text;
      const statusMissingText = (
        statusMissingCall.content as Array<{ text: string }>
      )[0].text;

      // All 4 concurrent calls receive distinct per-invocation timestamps from stepClocks
      const observedTimes = new Set([
        listBody.queried_at,
        aboutBody.queried_at,
        (invalidCall as { queried_at?: string }).queried_at,
        (statusMissingCall as { queried_at?: string }).queried_at,
      ]);
      expect(observedTimes).toEqual(
        new Set([
          "2026-11-08T19:10:00.000Z",
          "2026-11-08T19:20:00.000Z",
          "2026-11-08T19:30:00.000Z",
          "2026-11-08T19:40:00.000Z",
        ])
      );

      // Call 1 (flighty_list_flights: owner-scoped JSON read, 19:40Z -> 40m after 19:00Z sync)
      expect(listBody.queried_at).toBe("2026-11-08T19:40:00.000Z");
      expect(listBody.freshness.status).toBe("known");
      expect(listBody.freshness.sync_age_seconds).toBe(2400);
      expect(listBody.owner_identity.user_id).toBe(IDS.owner);

      // Call 2 (flighty_about: static tool, not_applicable, 19:10Z)
      expect(aboutBody.queried_at).toBe("2026-11-08T19:10:00.000Z");
      expect(aboutBody.freshness.status).toBe("not_applicable");
      expect(aboutBody.freshness.scope).toBe("static_or_reference_data");
      expect(aboutBody.owner_identity).toBeUndefined();

      // Call 3 (flighty_get_flight {}: selector error, error_or_validation, 19:30Z)
      expect(invalidCall.isError).toBe(true);
      expect(invalidText).toContain("queried_at=2026-11-08T19:30:00.000Z");
      expect(invalidText).toContain("scope=error_or_validation");
      expect(invalidText).not.toContain("owner_identity:");

      // Call 4 (flighty_get_flight_status: plaintext owner-scoped not-found, 19:20Z -> 20m after 19:00Z sync)
      expect(statusMissingCall.isError).toBeFalsy();
      expect(statusMissingText).toContain(
        "queried_at=2026-11-08T19:20:00.000Z"
      );
      expect(statusMissingText).toContain("sync_age_seconds=1200");
      expect(statusMissingText).toContain(
        "[owner_identity: label=signed_in_owner"
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps removal preview hash outside freshness so confirmation succeeds after clock/sync changes and replay is still denied", async () => {
    let currentNowMs = FIXED_NOW_MS;
    const db = new FlightyDatabase(fixture.mainPath, fixture.legacyPath);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const api = new FlightyApi({
      policy: { mode: "read-write", extraSyncHosts: new Set() },
      fetchImpl,
      readAuthToken: () => "synthetic-injected-token",
      readSyncUrl: () => "https://sync.flightyapp.com/synthetic-fixture",
      getBuildToken: () => "synthetic-injected-build",
    });

    const server = new McpServer({
      name: "removal-freshness-stability",
      version: "1.10.1",
    });
    installToolSafety(server, db, { now: () => currentNowMs });
    registerWriteTools(server, db, api, { now: () => currentNowMs });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "removal-client", version: "1.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      // Step 1: Request removal preview at t = FIXED_NOW_MS
      const previewRes = await client.callTool({
        name: "flighty_remove_flight",
        arguments: { flight_id: IDS.flight },
      });
      expect(previewRes.isError).toBeFalsy();
      const previewBody = JSON.parse(
        (previewRes.content as Array<{ text: string }>)[0].text
      );
      expect(previewBody.status).toBe("confirmation_required");
      expect(previewBody.queried_at).toBe(FIXED_NOW_ISO);
      expect(previewBody.freshness.status).toBe("known");
      expect(previewBody.freshness.sync_age_seconds).toBe(1800);
      // Freshness must NOT be mixed into the inner flight preview object that is hashed
      expect(previewBody.flight.freshness).toBeUndefined();
      expect(previewBody.flight.queried_at).toBeUndefined();

      // Step 2: Advance clock by 2 minutes (within 5-minute TTL) AND update SyncInfo.lastSync
      currentNowMs += 2 * 60 * 1000;
      const raw = new DatabaseSync(fixture.mainPath);
      try {
        raw
          .prepare("UPDATE SyncInfo SET lastSync = ?")
          .run("2026-11-08T19:31:00.000Z");
      } finally {
        raw.close();
      }

      // Step 3: Confirm removal with the issued confirm_code — must succeed!
      const confirmRes = await client.callTool({
        name: "flighty_remove_flight",
        arguments: {
          flight_id: IDS.flight,
          confirm_code: previewBody.confirm_code,
        },
      });
      expect(confirmRes.isError).toBeFalsy();
      const confirmBody = JSON.parse(
        (confirmRes.content as Array<{ text: string }>)[0].text
      );
      expect(confirmBody.status).toBe("removed");
      expect(confirmBody.queried_at).toBe("2026-11-08T19:32:00.000Z");
      expect(confirmBody.freshness.last_synced_at).toBe(
        "2026-11-08T19:31:00.000Z"
      );
      expect(confirmBody.freshness.sync_age_seconds).toBe(60);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // Step 4: Replay with the same confirm_code — must be rejected without calling API
      const replayRes = await client.callTool({
        name: "flighty_remove_flight",
        arguments: {
          flight_id: IDS.flight,
          confirm_code: previewBody.confirm_code,
        },
      });
      expect(replayRes.isError).toBe(true);
      const replayText = (
        replayRes.content as Array<{ text: string }>
      )[0].text;
      expect(replayText).toContain("already used");
      expect(replayText).toContain("[freshness:");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
