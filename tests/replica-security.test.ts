import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CREATE_REPLICA_SCHEMA_SQL, REPLICA_TABLE_NAMES, validateReplicaDatabaseSchemaAndContents, exportReplicaBundle, ReplicaError } from "../src/replica/index.js";
import { exportSyntheticBundle, receiverStorage } from "./replica-support.js";
import { createFixture, IDS, SYNTHETIC_TOKEN } from "./fixture/create.mjs";
import { fixtureTempRoot, trashFixture } from "./fixture/lifecycle.mjs";
import { FlightyDatabase } from "../src/services/database.js";
const keys = generateKeyPairSync("ed25519");
const roots: string[] = [];
function fixture() { const root = mkdtempSync(join(fixtureTempRoot(), "replica-security-")); roots.push(root); return { root, ...createFixture(root) }; }
function options(f: ReturnType<typeof fixture>, extra = {}) { return { sourceDbPath: f.mainPath, outputBundleDir: join(f.root, "exports", "bundle"), requiredMountPath: f.root, signingPrivateKey: keys.privateKey, producerId: "producer", accountId: "synthetic", ownerUserId: IDS.owner, epoch: 1, sequence: 1, ...extra }; }
function mutate(f: ReturnType<typeof fixture>, fn: (db: DatabaseSync) => void) { const db = new DatabaseSync(f.mainPath); try { fn(db); } finally { db.close(); } }
afterEach(() => { for (const root of roots.splice(0)) trashFixture(root); });

describe("replica source trust and work bounds", () => {
  it("rejects virtual external content before it can export a forbidden Account value", async () => {
    const f = fixture();
    mutate(f, db => db.exec(`DROP TABLE Profile; CREATE VIEW Hidden AS SELECT '${IDS.owner}' AS userId, authToken AS fullName, 'x' AS firstName FROM Account; CREATE VIRTUAL TABLE Profile USING fts5(userId,fullName,firstName,content='Hidden');`));
    await expect(exportSyntheticBundle(options(f))).rejects.toMatchObject({ code: "SOURCE_SCHEMA_INVALID" });
    expect(existsSync(join(f.root, "exports", "bundle"))).toBe(false);
  });
  it("rejects CHECK and generated expressions before quick_check evaluates them", () => {
    const f = fixture(); const db = new DatabaseSync(join(f.root, "constraint.db")); let calls = 0;
    db.function("tripwire", { deterministic: true }, () => { calls++; return 1; });
    db.exec(CREATE_REPLICA_SCHEMA_SQL.replace("CREATE TABLE Flight (", "CREATE TABLE Flight (sentinel INTEGER CHECK(tripwire() = 1), "));
    db.exec("INSERT INTO Flight(id) VALUES ('x')"); calls = 0;
    expect(() => validateReplicaDatabaseSchemaAndContents(db, { rowCounts: Object.fromEntries(REPLICA_TABLE_NAMES.map(t => [t, 0])) } as never)).toThrowError(expect.objectContaining({ code: "DB_SCHEMA_INVALID" }));
    expect(calls).toBe(0); db.close();
  });
  it("rejects generated source columns before content and refuses quarantine saturation", async () => {
    const f = fixture(); mutate(f, db => db.exec("ALTER TABLE Profile ADD COLUMN generatedName TEXT GENERATED ALWAYS AS (fullName) VIRTUAL"));
    await expect(exportSyntheticBundle(options(f))).rejects.toMatchObject({ code: "SOURCE_SCHEMA_INVALID" });
    const g = fixture();
    await expect(exportSyntheticBundle(options(g, { storageBudget: { maxBytes: 1, maxEntries: 1 } }))).rejects.toMatchObject({ code: "STORAGE_BUDGET_EXCEEDED" });
    expect(existsSync(join(g.root, "exports", "bundle"))).toBe(false);
  });
  it("propagates actual exporter file/directory fsync failures including post-rename uncertainty", async () => {
    const preload = new URL("./replica-fsync-preload.mjs", import.meta.url).pathname;
    for (let n = 1;n <= 5;n++) {
      const f = fixture();
      const oldOptions = process.env.NODE_OPTIONS, oldAt = process.env.SYNTHETIC_REPLICA_FSYNC_AT;
      process.env.NODE_OPTIONS = `--import=${preload}`;
      process.env.SYNTHETIC_REPLICA_FSYNC_AT = String(n);
      try { await expect(exportSyntheticBundle(options(f))).rejects.toMatchObject({ code: n <= 3 ? "STORAGE_WRITE_FAILED" : "COMMIT_UNCERTAIN" }); }
      finally { if (oldOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oldOptions; if (oldAt === undefined) delete process.env.SYNTHETIC_REPLICA_FSYNC_AT; else process.env.SYNTHETIC_REPLICA_FSYNC_AT = oldAt; }
      expect(existsSync(join(f.root, "exports", "bundle"))).toBe(n >= 4);
    }
  });
  it("preserves deleted reference joins, reference ambiguity, UUID case, nullable connections and selected bookings", async () => {
    const f = fixture();
    mutate(f, db => {
      db.exec("UPDATE Airline SET deleted=1; UPDATE Airport SET deleted=1 WHERE id='airport-b'; UPDATE Connection SET id=NULL;");
      const owner = "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF", flight = "ABCDEF01-ABCD-4ABC-8ABC-ABCDEF012345";
      db.prepare("UPDATE UserFlight SET userId=? WHERE userId=?").run(owner, IDS.owner);
      db.prepare("UPDATE UserManualFlight SET userId=? WHERE userId=?").run(owner.toLowerCase(), IDS.owner);
      db.prepare("UPDATE Ticket SET userId=? WHERE userId=?").run(owner.toLowerCase(), IDS.owner);
      db.prepare("UPDATE Flight SET id=? WHERE id=?").run(flight, IDS.flight);
      db.prepare("UPDATE UserFlight SET flightId=? WHERE flightId=?").run(flight.toLowerCase(), IDS.flight);
      db.prepare("UPDATE Ticket SET flightId=? WHERE flightId=?").run(flight, IDS.flight);
      db.prepare("UPDATE Connection SET arrivingFlightId=? WHERE arrivingFlightId=?").run(flight.toLowerCase(), IDS.flight);
      db.exec("INSERT INTO Airport SELECT 'other-deleted-airport',name,iata,icao,city,country,countryCode,timeZoneIdentifier,latitude,longitude,website,relevance,1 FROM Airport WHERE id='airport-a'");
    });
    const out = await exportSyntheticBundle(options(f, { ownerUserId: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF" }));
    expect(out.manifest.ownerUserId).toBe("abcdefab-cdef-4abc-8def-abcdefabcdef");
    const db = new FlightyDatabase(out.dbPath, join(f.root, "unused.db"));
    const previousOwner = process.env.FLIGHTY_OWNER_USER_ID; process.env.FLIGHTY_OWNER_USER_ID = out.manifest.ownerUserId;
    try { expect(db.listFlights()).toHaveLength(2); expect(db.getTrackingFlight("abcdef01-abcd-4abc-8abc-abcdef012345").tracked?.departure_code_unambiguous).toBe(false); } finally { if (previousOwner === undefined) delete process.env.FLIGHTY_OWNER_USER_ID; else process.env.FLIGHTY_OWNER_USER_ID = previousOwner; }
    const raw = new DatabaseSync(out.dbPath, { readOnly: true });
    expect(raw.prepare("SELECT COUNT(*) n FROM Connection WHERE id IS NULL").get()?.n).toBe(1);
    expect(raw.prepare("SELECT COUNT(*) n FROM Ticket").get()?.n).toBe(2); raw.close();
  });
  it("rejects ambiguous duplicate source identities and SyncInfo overflow", async () => {
    const f = fixture(); mutate(f, db => db.exec("INSERT INTO Flight SELECT * FROM Flight LIMIT 1"));
    await expect(exportSyntheticBundle(options(f))).rejects.toMatchObject({ code: "DB_CONTENT_INVALID" });
    const g = fixture(); mutate(g, db => { db.exec("DELETE FROM SyncInfo"); for (let i = 0;i < 33;i++)db.prepare("INSERT INTO SyncInfo(lastSync) VALUES (?)").run("2026-11-08T20:00:00Z"); });
    await expect(exportSyntheticBundle(options(g))).rejects.toMatchObject({ code: "EXPORT_BOUNDS_EXCEEDED" });
  });
  it("bounds source bytes, rows, cells and native total duration without publishing partial output", async () => {
    for (const limits of [{ maxSourceDbBytes: 1024 }, { maxRowsPerTable: 2 }, { maxCellBytes: 4 }, { maxOperationDurationMs: 1 }]) {
      const f = fixture();
      await expect(exportSyntheticBundle(options(f, { limits }))).rejects.toBeInstanceOf(ReplicaError);
      expect(existsSync(join(f.root, "exports", "bundle"))).toBe(false);
    }
  });
  it("enforces a real execution deadline while SQLite waits on an exclusive source lock", async () => {
    const f = fixture(), writer = new DatabaseSync(f.mainPath); writer.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE"); const start = performance.now();
    try { await expect(exportSyntheticBundle(options(f, { limits: { maxOperationDurationMs: 250 } }))).rejects.toMatchObject({ code: "OPERATION_TIMEOUT" }); expect(performance.now() - start).toBeLessThan(1500); expect(existsSync(join(f.root, "exports", "bundle"))).toBe(false); }
    finally { writer.exec("ROLLBACK"); writer.close(); }
  });
  it("requires mount identity and redacts filesystem setup errors", async () => {
    const f = fixture();
    await expect(exportReplicaBundle({ ...options(f), storage: undefined, quarantineDir: join(f.root, "q") } as never)).rejects.toMatchObject({ code: "MOUNT_UNAVAILABLE" });
    const authority = receiverStorage(join(f.root, "state"));
    await expect(exportReplicaBundle({ ...options(f), storage: { ...authority, validateMount: () => false }, quarantineDir: join(f.root, "q") })).rejects.toMatchObject({ code: "MOUNT_UNAVAILABLE" });
    mkdirSync(join(f.root, "outside"), { mode: 0o700 }); symlinkSync(join(f.root, "outside"), join(f.root, "exports"));
    await expect(exportReplicaBundle({ ...options(f), storage: authority, requiredMountPath: f.root, quarantineDir: join(f.root, "q") })).rejects.toMatchObject({ code: "INVALID_PATH" });
    expect(readdirSync(join(f.root, "outside"))).toHaveLength(0);
    const g = fixture(); mkdirSync(join(g.root, "exports"), { mode: 0o700 }); writeFileSync(join(g.root, "exports", "bundle"), "synthetic", { mode: 0o600 });
    try { await exportSyntheticBundle(options(g)); expect.unreachable(); } catch (error) { expect(error).toBeInstanceOf(ReplicaError); expect((error as Error).message).not.toContain(g.root); expect((error as Error).message).not.toContain("ENOTDIR"); }

  });
  it("preserves explicit unknowns when optional Ticket and Profile tables are absent", async () => {
    const f = fixture(); mutate(f, db => db.exec("DROP TABLE Ticket; DROP TABLE Profile"));
    const exported = await exportSyntheticBundle(options(f)); const db = new FlightyDatabase(exported.dbPath, join(f.root, "unused.db"));
    expect(db.listFlights()).toHaveLength(2); expect(db.getTrackingFlight(IDS.flight).tracked?.associations[0].booking_reference).toBeNull();
    expect(exported.manifest.rowCounts.Ticket).toBe(0); expect(exported.manifest.rowCounts.Profile).toBe(0);
  });
  it("allows a valid signed zero-flight account and keeps full raw snapshots outside the export parent", async () => {
    const f = fixture(); mutate(f, db => db.exec("DELETE FROM UserFlight; DELETE FROM UserManualFlight; DELETE FROM Ticket; DELETE FROM Profile; DELETE FROM Connection;"));
    const out = await exportSyntheticBundle(options(f)); expect(out.manifest.rowCounts.Flight).toBe(0);
    expect(readdirSync(out.bundleDir).sort()).toEqual(["manifest.json", "replica.db"]);
    expect(readdirSync(f.root).some(x => x.includes("trash") || x.includes("snapshot"))).toBe(false);
    const quarantine = join(f.root, "exports-private-quarantine");
    expect(statSync(quarantine).mode & 0o777).toBe(0o700);
    const rawDir = readdirSync(quarantine).find(name => name.startsWith("raw-backup-"))!;
    expect(readFileSync(join(quarantine, rawDir, "source-snapshot.db")).includes(Buffer.from(SYNTHETIC_TOKEN))).toBe(true);

  });
});
