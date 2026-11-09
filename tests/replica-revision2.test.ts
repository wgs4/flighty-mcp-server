import { generateKeyPairSync } from "node:crypto";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplicaReceiver, computeFileSha256, exportReplicaBundle, signReplicaManifest, validateSourceDatabaseSchema, verifyReplicaBundle, type ReplicaReceiverConfig } from "../src/replica/index.js";
import * as work from "../src/replica/work.js";
import { readDatabaseFreshness } from "../src/services/freshness.js";
import { createFixture, IDS } from "./fixture/create.mjs";
import { fixtureTempRoot, trashFixture } from "./fixture/lifecycle.mjs";
import { exportSyntheticBundle, receiverStorage } from "./replica-support.js";

const keys = generateKeyPairSync("ed25519");
const roots: string[] = [];
const now = Date.parse("2026-11-09T12:00:00Z");
const iso = "2026-11-09T10:00:00Z";
function fixture() { const root = mkdtempSync(join(fixtureTempRoot(), "replica-fix2-")); roots.push(root); return { root, ...createFixture(root) }; }
function options(f: ReturnType<typeof fixture>, sequence = 1) { return { sourceDbPath: f.mainPath, outputBundleDir: join(f.root, "exports", `bundle-${sequence}`), requiredMountPath: f.root, signingPrivateKey: keys.privateKey, producerId: "producer", accountId: "account", ownerUserId: IDS.owner, epoch: 1, sequence, captureStartedAt: iso, captureCompletedAt: "2026-11-09T10:00:01Z" }; }
function config(root: string, extra: Partial<ReplicaReceiverConfig> = {}): ReplicaReceiverConfig { return { stateRootDir: join(root, "state"), storage: receiverStorage(join(root, "state")), publicKey: keys.publicKey, producerId: "producer", accountId: "account", ownerUserId: IDS.owner, epoch: 1, now, ...extra }; }
function verify(bundleDir: string) { return verifyReplicaBundle({ bundleDir, trustedPublicKey: keys.publicKey, expectedProducerId: "producer", expectedAccountId: "account", expectedOwnerUserId: IDS.owner, expectedEpoch: 1, now }); }
function change(f: ReturnType<typeof fixture>, fn: (db: DatabaseSync) => void) { const db = new DatabaseSync(f.mainPath); try { fn(db); } finally { db.close(); } }
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) trashFixture(root); });

describe("replica revision 2 boundaries", () => {
  it.each([
    ["private URL", "https://sync.example.invalid/private?token=SYNTHETIC_MIXED_SECRET"],
    ["invalid nonempty text", "SYNTHETIC_INVALID_PRIVATE_MARKER"],
    ["BLOB", Buffer.from("SYNTHETIC_BLOB_PRIVATE_MARKER")],
    ["overlong text", "SYNTHETIC_LONG_PRIVATE_MARKER".repeat(16)],
  ])("retains unknown freshness for ISO plus %s without exporting the marker", async (_label, marker) => {
    const f = fixture(); change(f, db => { db.exec("DELETE FROM SyncInfo"); db.prepare("INSERT INTO SyncInfo(lastSync) VALUES (?)").run(iso); db.prepare("INSERT INTO SyncInfo(lastSync) VALUES (?)").run(marker); });
    const source = readDatabaseFreshness({ dbPath: f.mainPath, now }); expect(source.status).toBe("unknown");
    const bundle = await exportSyntheticBundle(options(f)); verify(bundle.bundleDir);
    const copied = readDatabaseFreshness({ dbPath: bundle.dbPath, now }); expect(copied.status).toBe("unknown"); expect(copied.unknown_reason_code).toBe(source.unknown_reason_code);
    expect(readFileSync(bundle.dbPath).includes(Buffer.from(marker))).toBe(false);
  });
  it.each([[null, "known"], ["", "known"], ["   ", "known"], [1, "unknown"], ["123", "unknown"]])("preserves ISO plus %j semantics", async (marker, status) => {
    const f = fixture(); change(f, db => { db.exec("DELETE FROM SyncInfo"); for (const value of [iso, marker]) db.prepare("INSERT INTO SyncInfo(lastSync) VALUES (?)").run(value); });
    const out = await exportSyntheticBundle(options(f)), source = readDatabaseFreshness({ dbPath: f.mainPath, now }), copied = readDatabaseFreshness({ dbPath: out.dbPath, now }); expect(copied.status).toBe(status); expect(source.status).toBe(status);
    expect(copied.last_synced_at).toBe(source.last_synced_at); expect(copied.unknown_reason_code).toBe(source.unknown_reason_code);
  });
  it("rejects an initially exact two-file persistent WAL bundle without creating sidecars or advancing highwater", async () => {
    const f = fixture(), one = await exportSyntheticBundle(options(f)), c = config(f.root), rx = new ReplicaReceiver(c); rx.acceptBundle(one.bundleDir);
    const target = join(f.root, "wal-bundle"); cpSync(one.bundleDir, target, { recursive: true }); chmodSync(target, 0o700);
    const dbPath = join(target, "replica.db"); chmodSync(dbPath, 0o600); const db = new DatabaseSync(dbPath); db.exec("PRAGMA journal_mode=WAL"); db.close();
    const digest = computeFileSha256(dbPath), { signature, ...unsigned } = one.manifest;
    writeFileSync(join(target, "manifest.json"), JSON.stringify(signReplicaManifest({ ...unsigned, sequence: 2, dbSha256: digest.sha256, dbBytes: digest.bytes }, keys.privateKey)));
    expect(readFileSync(dbPath)[18]).toBe(2); expect(readdirSync(target).sort()).toEqual(["manifest.json", "replica.db"]);
    expect(() => verify(target)).toThrowError(expect.objectContaining({ code: "DB_SCHEMA_INVALID" })); expect(readdirSync(target).sort()).toEqual(["manifest.json", "replica.db"]);
    expect(() => rx.acceptBundle(target)).toThrowError(expect.objectContaining({ code: "DB_SCHEMA_INVALID" })); expect(rx.getStateSnapshot().highwaterSequence).toBe(1);
    const lease = rx.acquireLease(); expect(lease.sequence).toBe(1); lease.release(); expect(readdirSync(target).sort()).toEqual(["manifest.json", "replica.db"]);
  });
  it.each(["sidecar", "extra file", "DB bytes", "manifest"])("rejects %s changed by native validation before returning verified", async (kind) => {
    const f = fixture(), out = await exportSyntheticBundle(options(f)), original = work.runSqliteTask; let mutated = false;
    vi.spyOn(work, "runSqliteTask").mockImplementation((task: any, duration) => {
      const value = original(task, duration);
      if (task.kind === "validate") {
        mutated = true;
        if (kind === "sidecar") writeFileSync(task.dbPath + "-wal", "synthetic", { mode: 0o600 });
        if (kind === "extra file") writeFileSync(join(dirname(task.dbPath), "extra"), "synthetic", { mode: 0o600 });
        if (kind === "DB bytes") { chmodSync(task.dbPath, 0o600); appendFileSync(task.dbPath, "synthetic"); }
        if (kind === "manifest") { const path = join(dirname(task.dbPath), "manifest.json"), manifest = JSON.parse(readFileSync(path, "utf8")); manifest.sequence++; writeFileSync(path, JSON.stringify(manifest)); }
      }
      return value as any;
    });
    const code = kind === "sidecar" ? "DB_SIDECAR_FORBIDDEN" : kind === "extra file" ? "DB_CONTENT_INVALID" : "DB_DIGEST_MISMATCH";
    expect(() => verify(out.bundleDir)).toThrowError(expect.objectContaining({ code })); expect(mutated).toBe(true);
  });
  it.each(["before publication", "before state commit"])("rechecks signed bundle consistency %s", async (boundary) => {
    const f = fixture(), one = await exportSyntheticBundle(options(f)), two = await exportSyntheticBundle(options(f, 2)); let tamper = false;
    const mutate = (path: string) => { if (tamper) writeFileSync(join(path, "extra"), "synthetic", { mode: 0o600 }); };
    const c = config(f.root, { faultHooks: boundary === "before publication" ? { beforePublishBundle: mutate } : { afterPublishBundleBeforeStateCommit: mutate } }), rx = new ReplicaReceiver(c); rx.acceptBundle(one.bundleDir); tamper = true;
    expect(() => rx.acceptBundle(two.bundleDir)).toThrowError(expect.objectContaining({ code: "DB_CONTENT_INVALID" })); expect(rx.getStateSnapshot().highwaterSequence).toBe(1);
    const lease = rx.acquireLease(); expect(lease.sequence).toBe(1); lease.release();
  });
  it.each([0o777, 0o770, 0o775])("rejects replacement authority through ancestor mode %i before mutation", async (mode) => {
    const f = fixture(); chmodSync(f.root, 0o755); const parent = join(f.root, "namespace"), root = join(parent, "private"); mkdirSync(parent, { mode: 0o700 }); chmodSync(parent, mode); mkdirSync(root, { mode: 0o700 });
    const storage = { mountPath: f.root, privateRootDir: root, expectedDevice: statSync(f.root).dev, approvedPaths: [root], validateMount: () => true };
    await expect(exportReplicaBundle({ ...options(f), outputBundleDir: join(root, "exports", "bundle"), storage, quarantineDir: join(root, "quarantine") })).rejects.toMatchObject({ code: "INVALID_PATH" });
    expect(() => new ReplicaReceiver(config(f.root, { stateRootDir: join(root, "state"), storage }))).toThrowError(expect.objectContaining({ code: "INVALID_PATH" })); expect(readdirSync(root)).toEqual([]);
  });
  it.each([0o755, 0o1777])("permits nonprivate safe ancestor mode %i and an independent read source", async (mode) => {
    const f = fixture(); chmodSync(f.root, 0o755); const parent = join(f.root, "namespace"), root = join(parent, "private"); mkdirSync(parent, { mode: 0o700 }); chmodSync(parent, mode); mkdirSync(root, { mode: 0o700 });
    const storage = { mountPath: f.root, privateRootDir: root, expectedDevice: statSync(f.root).dev, approvedPaths: [root], validateMount: () => true };
    const out = await exportReplicaBundle({ ...options(f), outputBundleDir: join(root, "exports", "bundle"), storage, quarantineDir: join(root, "quarantine") });
    const rx = new ReplicaReceiver(config(f.root, { stateRootDir: join(root, "state"), storage })); expect(rx.acceptBundle(out.bundleDir).status).toBe("accepted");
    const lease = rx.acquireLease(); expect(lease.sequence).toBe(1); lease.release();
  });
  it("allows literal defaults in selected/extra columns and quoted keywords without evaluating schema expressions", async () => {
    const f = fixture(); change(f, db => {
      db.exec(`ALTER TABLE Flight ADD COLUMN extraFlag INTEGER DEFAULT 0;
        ALTER TABLE Flight ADD COLUMN "CHECK" TEXT DEFAULT 'AS CHECK DEFAULT /* -- literal';
        ALTER TABLE Flight ADD COLUMN extraNumber REAL DEFAULT -1.25e+2;
        ALTER TABLE Flight ADD COLUMN [AS] TEXT DEFAULT NULL;
        ALTER TABLE Flight ADD COLUMN \`GENERATED\` TEXT DEFAULT 'VIRTUAL';
        ALTER TABLE Profile RENAME TO OldProfile;
        CREATE TABLE Profile(userId TEXT, fullName TEXT DEFAULT NULL, firstName TEXT DEFAULT 'Unknown ''AS'' CHECK');
        INSERT INTO Profile(userId,fullName,firstName) SELECT userId,fullName,firstName FROM OldProfile;
        DROP TABLE OldProfile;`);
    });
    const out = await exportSyntheticBundle(options(f)); verify(out.bundleDir); const db = new DatabaseSync(out.dbPath, { readOnly: true });
    expect(db.prepare("SELECT fullName FROM Profile WHERE userId=?").get(IDS.friend)?.fullName).toBe("Synthetic Friend"); expect(db.prepare("PRAGMA table_info(Flight)").all().some(row => row.name === "extraFlag")).toBe(false); db.close();
  });
  it.each(["(0)", "(lower('x'))", "CURRENT_TIMESTAMP", "('quoted')"])("rejects unsupported expression default %s before content", async (defaultSql) => {
    const f = fixture(); change(f, db => db.exec(`DROP TABLE Profile; CREATE TABLE Profile(userId TEXT,fullName TEXT DEFAULT ${defaultSql},firstName TEXT)`));
    await expect(exportSyntheticBundle(options(f))).rejects.toMatchObject({ code: "SOURCE_SCHEMA_INVALID" }); expect(existsSync(options(f).outputBundleDir)).toBe(false);
  });
  it("does not evaluate a default function while inspecting source schema", () => {
    const f = fixture(), db = new DatabaseSync(f.mainPath); let calls = 0; db.function("tripwire", () => { calls++; return "synthetic"; });
    db.exec("DROP TABLE Profile; CREATE TABLE Profile(userId TEXT,fullName TEXT DEFAULT (tripwire()),firstName TEXT)");
    expect(() => validateSourceDatabaseSchema(db)).toThrowError(expect.objectContaining({ code: "SOURCE_SCHEMA_INVALID" })); expect(calls).toBe(0); db.close();
  });
});
