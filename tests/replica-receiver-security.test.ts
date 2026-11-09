import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ReplicaReceiver, verifyReplicaBundle, computeFileSha256, computeManifestSha256, REPLICA_TABLE_NAMES, signReplicaManifest, type ReplicaManifest, type ReplicaReceiverConfig } from "../src/replica/index.js";
import { exportSyntheticBundle, receiverStorage } from "./replica-support.js";
import { createFixture, IDS } from "./fixture/create.mjs";
import { fixtureTempRoot, trashFixture } from "./fixture/lifecycle.mjs";
const keys = generateKeyPairSync("ed25519"), other = generateKeyPairSync("ed25519");
const roots: string[] = [];
function root() { const r = mkdtempSync(join(fixtureTempRoot(), "replica-receiver-security-")); roots.push(r); return r; }
function config(r: string, extra: Partial<ReplicaReceiverConfig> = {}): ReplicaReceiverConfig { return { stateRootDir: join(r, "state"), storage: receiverStorage(join(r, "state")), publicKey: keys.publicKey, expectedKeyId: "synthetic-key-label", producerId: "producer", accountId: "account", ownerUserId: IDS.owner, epoch: 1, now: Date.parse("2026-11-09T12:00:00Z"), ...extra }; }
async function bundle(r: string, sequence = 1) { const f = createFixture(r); return exportSyntheticBundle({ sourceDbPath: f.mainPath, outputBundleDir: join(r, "exports", `bundle-${sequence}`), requiredMountPath: r, signingPrivateKey: keys.privateKey, keyId: "synthetic-key-label", producerId: "producer", accountId: "account", ownerUserId: IDS.owner, epoch: 1, sequence, captureStartedAt: "2026-11-09T10:00:00Z", captureCompletedAt: "2026-11-09T10:00:01Z" }); }
function verify(path: string) { return verifyReplicaBundle({ bundleDir: path, trustedPublicKey: keys.publicKey, expectedKeyId: "synthetic-key-label", expectedProducerId: "producer", expectedAccountId: "account", expectedOwnerUserId: IDS.owner, expectedEpoch: 1, now: Date.parse("2026-11-09T12:00:00Z") }); }
function rewrite(original: Awaited<ReturnType<typeof bundle>>, target: string, mutate: (db: DatabaseSync) => void) {
  cpSync(original.bundleDir, target, { recursive: true }); chmodSync(target, 0o700); const dbpath = join(target, "replica.db"); chmodSync(dbpath, 0o600);
  const db = new DatabaseSync(dbpath); let counts;
  try { mutate(db); counts = Object.fromEntries(REPLICA_TABLE_NAMES.map(t => [t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get()!.n])); } finally { db.close(); }
  const digest = computeFileSha256(dbpath); const { signature, ...unsigned } = original.manifest;
  const m = signReplicaManifest({ ...unsigned, rowCounts: counts as never, dbBytes: digest.bytes, dbSha256: digest.sha256 }, keys.privateKey);
  writeFileSync(join(target, "manifest.json"), JSON.stringify(m), { mode: 0o600 }); return target;
}
afterEach(() => { for (const r of roots.splice(0)) trashFixture(r); });

describe("replica persisted trust, durable commits and retention", () => {
  it("requires explicit actual-key transitions even when the key label is unchanged, and preserves replay highwater", async () => {
    const r = root(), b = await bundle(r); const c = config(r); new ReplicaReceiver(c).acceptBundle(b.bundleDir);
    expect(() => new ReplicaReceiver({ ...c, publicKey: other.publicKey })).toThrowError(expect.objectContaining({ code: "ACCOUNT_TRANSITION_REQUIRED" }));
    const rotated = new ReplicaReceiver({ ...c, publicKey: other.publicKey, allowAccountTransition: true });
    expect(rotated.getStateSnapshot().highwaterSequence).toBe(1); expect(() => rotated.acquireLease()).toThrowError(expect.objectContaining({ code: "NO_ACTIVE_GENERATION" }));
    const restored = new ReplicaReceiver({ ...c, allowAccountTransition: true }); expect(restored.getStateSnapshot().highwaterSequence).toBe(1);
    expect(() => restored.acceptBundle(b.bundleDir)).toThrowError(expect.objectContaining({ code: "REPLAY_REJECTED" }));
  });
  it("revalidates actual on-disk manifest signatures and state record consistency after restart", async () => {
    const r = root(), a = await bundle(r), b = await bundle(r, 2); const c = config(r); const rx = new ReplicaReceiver(c); rx.acceptBundle(a.bundleDir); const active = rx.acceptBundle(b.bundleDir);
    writeFileSync(join(c.stateRootDir, "generations", active.generationId, "manifest.json"), "{}");
    const restarted = new ReplicaReceiver(c); const lease = restarted.acquireLease(); expect(lease.sequence).toBe(1); expect(lease.isStaleRecovery).toBe(true); lease.release(); expect(restarted.getStateSnapshot().highwaterSequence).toBe(2);
    const state = JSON.parse(readFileSync(join(c.stateRootDir, "state.json"), "utf8")); state.acceptedBySequence["1"].bundleDirName = "../../outside"; writeFileSync(join(c.stateRootDir, "state.json"), JSON.stringify(state));
    expect(() => new ReplicaReceiver(c)).toThrowError(expect.objectContaining({ code: "STORAGE_WRITE_FAILED" }));
  });
  it("propagates each bundle and state flush failure without acknowledging acceptance or dropping referenced generations", async () => {
    const r = root(), a = await bundle(r), b = await bundle(r, 2); let fail: string | null = null;
    const c = config(r, { faultHooks: { onFsync: boundary => { if (boundary === fail) throw Object.assign(new Error("synthetic EIO /private/secret"), { code: "EIO" }); } } });
    let rx = new ReplicaReceiver(c); rx.acceptBundle(a.bundleDir);
    for (const boundary of ["bundle-db", "bundle-manifest", "bundle-stage-dir", "bundle-generations-dir", "bundle-source-dir", "state-temp-file", "state-staging-dir"]) {
      fail = boundary; expect(() => rx.acceptBundle(b.bundleDir)).toThrowError(expect.objectContaining({ code: "STORAGE_WRITE_FAILED" })); expect(rx.getStateSnapshot().highwaterSequence).toBe(1);
      fail = null; rx = new ReplicaReceiver(c); expect(rx.acquireLease().sequence).toBe(1);
    }
    for (const boundary of ["state-root-dir", "state-source-dir"]) {
      const isolated = root(), one = await bundle(isolated), two = await bundle(isolated, 2); let fault = false;
      const cfg = config(isolated, { faultHooks: { onFsync: b => { if (fault && b === boundary) throw Error("synthetic ENOSPC"); } } });
      const owner = new ReplicaReceiver(cfg); owner.acceptBundle(one.bundleDir); fault = true;
      expect(() => owner.acceptBundle(two.bundleDir)).toThrowError(expect.objectContaining({ code: "COMMIT_UNCERTAIN" }));
      expect(owner.getStateSnapshot().highwaterSequence).toBe(2); expect(() => owner.acquireLease()).toThrowError(expect.objectContaining({ code: "COMMIT_UNCERTAIN" }));
      fault = false; const restarted = new ReplicaReceiver(cfg); const lease = restarted.acquireLease(); expect(lease.sequence).toBe(2); expect(existsSync(lease.dbPath)).toBe(true); lease.release();
    }
  });
  it("propagates actual EIO/ENOSPC from every fsync call rather than only fault hooks", async () => {
    const r = root(), one = await bundle(r), two = await bundle(r, 2);
    for (let nth = 1;nth <= 9;nth++) {
      const c = config(r, { stateRootDir: join(r, `flush-state-${nth}`) });
      const rx = new ReplicaReceiver(c); rx.acceptBundle(one.bundleDir);
      const original = fs.fsyncSync; let calls = 0;
      fs.fsyncSync = (fd) => { if (++calls === nth) throw Object.assign(new Error("synthetic fsync fault"), { code: nth % 2 ? "EIO" : "ENOSPC" }); return original(fd); };
      syncBuiltinESMExports();
      try { expect(() => rx.acceptBundle(two.bundleDir)).toThrowError(expect.objectContaining({ code: nth >= 8 ? "COMMIT_UNCERTAIN" : "STORAGE_WRITE_FAILED" })); }
      finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
      const restarted = new ReplicaReceiver(c); expect(restarted.getStateSnapshot().highwaterSequence).toBe(nth >= 8 ? 2 : 1); const lease = restarted.acquireLease(); expect(lease.sequence).toBe(nth >= 8 ? 2 : 1); lease.release();
    }
  });
  it("handles the exact post-rename fault as uncertain and requires revalidation", async () => {
    const r = root(), b = await bundle(r); let fault = false; const c = config(r, { faultHooks: { afterStateRename: () => { if (fault) throw Error("synthetic crash"); } } }); const rx = new ReplicaReceiver(c); fault = true;
    expect(() => rx.acceptBundle(b.bundleDir)).toThrowError(expect.objectContaining({ code: "COMMIT_UNCERTAIN" })); fault = false;
    const restarted = new ReplicaReceiver(c); expect(restarted.getStateSnapshot().highwaterSequence).toBe(1); const lease = restarted.acquireLease(); lease.release();
    expect(() => lease.computeFreshness()).toThrowError(expect.objectContaining({ code: "INVALID_CONFIG" }));
  });
  it("accepts an independently verified empty read model and refuses a missing replay state", async () => {
    const r = root(), fixture = createFixture(r);
    const db = new DatabaseSync(fixture.mainPath);
    db.exec("DELETE FROM UserFlight; DELETE FROM UserManualFlight; DELETE FROM Ticket; DELETE FROM Profile; DELETE FROM Connection;"); db.close();
    const exported = await exportSyntheticBundle({ sourceDbPath: fixture.mainPath, outputBundleDir: join(r, "exports", "empty"), requiredMountPath: r, signingPrivateKey: keys.privateKey, keyId: "synthetic-key-label", producerId: "producer", accountId: "account", ownerUserId: IDS.owner, epoch: 1, sequence: 1 });
    const c = config(r, { now: Date.now() }); const rx = new ReplicaReceiver(c);
    expect(rx.acceptBundle(exported.bundleDir).status).toBe("accepted");
    const lease = rx.acquireLease(), handle = lease.openDatabase(); expect(handle.prepare("SELECT COUNT(*) n FROM Flight").get()?.n).toBe(0); handle.close(); expect(lease.ownerIdentity.userId).toBe(IDS.owner); lease.release();
    renameSync(join(c.stateRootDir, "state.json"), join(r, "retained-state.json"));
    expect(() => new ReplicaReceiver(c)).toThrowError(expect.objectContaining({ code: "STORAGE_WRITE_FAILED" }));
  });
  it("rejects hardlinked manifests and state files, not just hardlinked database inputs", async () => {
    const r = root(), b = await bundle(r), c = config(r), rx = new ReplicaReceiver(c); rx.acceptBundle(b.bundleDir);
    linkSync(join(c.stateRootDir, "state.json"), join(r, "state-link.json"));
    expect(() => new ReplicaReceiver(c)).toThrowError(expect.objectContaining({ code: "INVALID_PATH" }));
    linkSync(join(b.bundleDir, "manifest.json"), join(r, "manifest-link.json"));
    expect(() => verify(b.bundleDir)).toThrowError(expect.objectContaining({ code: "INVALID_PATH" }));
  });
  it("does not allocate duplicate uploads, compacts history and refuses safely when recoverable trash is full", async () => {
    const r = root(), b = await bundle(r), c = config(r), rx = new ReplicaReceiver(c); const initial = rx.acceptBundle(b.bundleDir);
    for (let i = 0;i < 8;i++)expect(rx.acceptBundle(b.bundleDir).receivedAt).toBe(initial.receivedAt);
    expect(readdirSync(join(c.stateRootDir, ".trash"))).toHaveLength(0);
    for (let sequence = 2;sequence <= 8;sequence++) { const p = join(r, `resend-${sequence}`); cpSync(b.bundleDir, p, { recursive: true }); chmodSync(p, 0o700); const { signature, ...unsigned } = b.manifest; writeFileSync(join(p, "manifest.json"), JSON.stringify(signReplicaManifest({ ...unsigned, sequence }, keys.privateKey))); rx.acceptBundle(p); }
    expect(Object.keys(rx.getStateSnapshot().acceptedBySequence)).toHaveLength(2); expect(rx.getStateSnapshot().highwaterSequence).toBe(8);
    const before = readdirSync(join(c.stateRootDir, ".trash")).length;
    const limited = new ReplicaReceiver({ ...c, storageBudget: { maxEntries: 30, maxBytes: 8 * 1024 * 1024 } });
    const p = join(r, "resend-9"); cpSync(b.bundleDir, p, { recursive: true }); chmodSync(p, 0o700); const { signature, ...unsigned } = b.manifest; writeFileSync(join(p, "manifest.json"), JSON.stringify(signReplicaManifest({ ...unsigned, sequence: 9 }, keys.privateKey)));
    expect(() => limited.acceptBundle(p)).toThrowError(expect.objectContaining({ code: "STORAGE_BUDGET_EXCEEDED" })); expect(limited.getStateSnapshot().highwaterSequence).toBe(8); expect(readdirSync(join(c.stateRootDir, ".trash"))).toHaveLength(before);
  });
  it("rejects signed out-of-scope rows, ambiguous duplicates and empty keys independently of the producer", async () => {
    const r = root(), b = await bundle(r); let i = 0;
    for (const mutate of [
      (d: DatabaseSync) => d.prepare("INSERT INTO Ticket(flightId,userId,pnr) VALUES (?,?,'synthetic-rogue')").run(IDS.flight, "rogue"),
      (d: DatabaseSync) => d.prepare("INSERT INTO Profile VALUES (?, 'fake', 'fake')").run(IDS.owner), // followed owner only below
      (d: DatabaseSync) => d.exec("INSERT INTO Flight(id) VALUES ('unreferenced')"),
      (d: DatabaseSync) => d.exec("INSERT INTO Flight SELECT * FROM Flight LIMIT 1"),
      (d: DatabaseSync) => d.exec("UPDATE Airport SET id='' WHERE id='airport-a'"),
      (d: DatabaseSync) => d.exec("INSERT INTO UserFlight SELECT * FROM UserFlight LIMIT 1"),
      (d: DatabaseSync) => d.exec("INSERT INTO ManualFlight SELECT * FROM ManualFlight LIMIT 1; UPDATE ManualFlight SET id='unselected-manual' WHERE rowid=(SELECT MAX(rowid) FROM ManualFlight)"),
      (d: DatabaseSync) => d.exec("INSERT INTO Ticket SELECT * FROM Ticket LIMIT 1"),
      (d: DatabaseSync) => d.exec("INSERT INTO Profile SELECT * FROM Profile LIMIT 1"),
      (d: DatabaseSync) => d.exec("INSERT INTO Connection SELECT * FROM Connection LIMIT 1; UPDATE Connection SET id='different-id' WHERE rowid=(SELECT MAX(rowid) FROM Connection)"),
      (d: DatabaseSync) => {
        d.exec("INSERT INTO Flight SELECT * FROM Flight LIMIT 1; UPDATE Flight SET id='rogue-leg' WHERE rowid=(SELECT MAX(rowid) FROM Flight)");
        d.prepare("INSERT INTO Connection VALUES ('rogue-connection',?,'rogue-leg','airport-b',30,NULL)").run(IDS.friendFlight);
      },
    ]) {
      const path = rewrite(b, join(r, `bad-${i++}`), d => { mutate(d); if (i === 2) { d.prepare("UPDATE UserFlight SET isMyFlight=0 WHERE userId=?").run(IDS.owner); d.prepare("UPDATE UserManualFlight SET isMyFlight=0 WHERE userId=?").run(IDS.owner); } });
      expect(() => verify(path)).toThrowError(expect.objectContaining({ code: "DB_CONTENT_INVALID" }));
    }
  });
  it("rejects extra files, hardlinks and symlinked or public internal directories before publication", async () => {
    const r = root(), b = await bundle(r); writeFileSync(join(b.bundleDir, "extra"), "synthetic"); expect(() => verify(b.bundleDir)).toThrowError(expect.objectContaining({ code: "DB_CONTENT_INVALID" }));
    const g = root(), good = await bundle(g); linkSync(good.dbPath, join(g, "linked.db")); expect(() => verify(good.bundleDir)).toThrowError(expect.objectContaining({ code: "INVALID_PATH" }));
    for (const child of ["generations", "staging", ".trash"]) { const t = root(); mkdirSync(join(t, "state"), { mode: 0o700 }); mkdirSync(join(t, "outside"), { mode: 0o700 }); symlinkSync(join(t, "outside"), join(t, "state", child)); expect(() => new ReplicaReceiver(config(t))).toThrowError(expect.objectContaining({ code: "INVALID_PATH" })); expect(readdirSync(join(t, "outside"))).toHaveLength(0); }
    const t = root(); mkdirSync(join(t, "state"), { mode: 0o755 }); expect(() => new ReplicaReceiver(config(t))).toThrowError(expect.objectContaining({ code: "INVALID_PATH" }));
  });
});
