import { exportSyntheticBundle as exportReplicaBundle, receiverStorage } from "./replica-support.js";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  REPLICA_DB_FILENAME,
  REPLICA_MANIFEST_FILENAME,
  computeFileSha256,
  signReplicaManifest,
  verifyReplicaBundle,
  type ReplicaManifest,
} from "../src/replica/index.js";
import { IDS, createFixture } from "./fixture/create.mjs";
import { fixtureTempRoot, trashFixture } from "./fixture/lifecycle.mjs";

const { publicKey: TRUSTED_PUB_KEY, privateKey: TRUSTED_PRIV_KEY } =
  generateKeyPairSync("ed25519");
const { publicKey: WRONG_PUB_KEY, privateKey: WRONG_PRIV_KEY } =
  generateKeyPairSync("ed25519");

describe("replica core: manifest signing, pinned key/owner/schema verification, and bounds", () => {
  const tempDirs: string[] = [];

  function makeTempDir(prefix = "replica-verify-test-"): string {
    const dir = mkdtempSync(join(fixtureTempRoot(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      trashFixture(tempDirs.pop()!);
    }
  });

  async function buildValidBundle(root: string, sequence = 1) {
    const fixture = createFixture(root);
    const bundleDir = join(root, "exports", `bundle-seq-${sequence}`);
    return exportReplicaBundle({
      sourceDbPath: fixture.mainPath,
      outputBundleDir: bundleDir,
      requiredMountPath: root,
      producerId: "imac-exporter",
      accountId: "acct-1",
      ownerUserId: IDS.owner,
      epoch: 1,
      sequence,
      signingPrivateKey: TRUSTED_PRIV_KEY,
      captureStartedAt: "2026-11-08T20:00:00.000Z",
      captureCompletedAt: "2026-11-08T20:00:02.000Z",
    });
  }

  function cloneAndMutateBundle(
    sourceBundleDir: string,
    targetBundleDir: string,
    mutator: (params: {
      dbPath: string;
      manifestPath: string;
      manifest: ReplicaManifest;
    }) => void
  ): string {
    cpSync(sourceBundleDir, targetBundleDir, { recursive: true });
    chmodSync(targetBundleDir, 0o700);
    const dbPath = join(targetBundleDir, REPLICA_DB_FILENAME);
    const manifestPath = join(targetBundleDir, REPLICA_MANIFEST_FILENAME);
    chmodSync(dbPath, 0o600);
    chmodSync(manifestPath, 0o600);
    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8")
    ) as ReplicaManifest;
    mutator({ dbPath, manifestPath, manifest });
    return targetBundleDir;
  }

  function resignMutatedDb(
    dbPath: string,
    manifestPath: string,
    manifest: ReplicaManifest
  ): void {
    const { sha256, bytes } = computeFileSha256(dbPath);
    const { signature: _sig, ...unsigned } = manifest;
    const resigned = signReplicaManifest(
      {
        ...unsigned,
        dbBytes: bytes,
        dbSha256: sha256,
      },
      TRUSTED_PRIV_KEY
    );
    writeFileSync(manifestPath, JSON.stringify(resigned, null, 2), "utf8");
  }

  it("verifies a valid signed bundle and rejects wrong signatures, wrong keys, tampered DB digests, and mismatched identity/epoch/schema claims", async () => {
    const root = makeTempDir();
    const exported = await buildValidBundle(root);
    const baseVerifyOpts = {
      bundleDir: exported.bundleDir,
      trustedPublicKey: TRUSTED_PUB_KEY,
      expectedProducerId: "imac-exporter",
      expectedAccountId: "acct-1",
      expectedOwnerUserId: IDS.owner,
      expectedEpoch: 1,
      now: Date.parse("2026-11-08T20:05:00.000Z"),
    };

    const verified = verifyReplicaBundle(baseVerifyOpts);
    expect(verified.manifest.sequence).toBe(1);
    expect(verified.manifest.ownerUserId).toBe(IDS.owner);

    // 1. Wrong pinned public key (no TOFU)
    expect(() =>
      verifyReplicaBundle({
        ...baseVerifyOpts,
        trustedPublicKey: WRONG_PUB_KEY,
      })
    ).toThrowError(expect.objectContaining({ code: "KEY_MISMATCH" }));

    // 2. Signed with wrong private key but claiming trusted keyId
    const wrongSigDir = cloneAndMutateBundle(
      exported.bundleDir,
      join(root, "wrong-sig"),
      ({ manifestPath, manifest }) => {
        const { signature: _s, ...unsigned } = manifest;
        const badSigned = signReplicaManifest(unsigned, WRONG_PRIV_KEY);
        writeFileSync(manifestPath, JSON.stringify(badSigned, null, 2), "utf8");
      }
    );
    expect(() =>
      verifyReplicaBundle({ ...baseVerifyOpts, bundleDir: wrongSigDir })
    ).toThrowError(expect.objectContaining({ code: "SIGNATURE_INVALID" }));

    // 3. Tampered DB bytes without updating signature/digest
    const tamperedDbDir = cloneAndMutateBundle(
      exported.bundleDir,
      join(root, "tampered-db"),
      ({ dbPath }) => {
        const buf = readFileSync(dbPath);
        buf[buf.length - 1] ^= 0xff;
        writeFileSync(dbPath, buf);
      }
    );
    expect(() =>
      verifyReplicaBundle({ ...baseVerifyOpts, bundleDir: tamperedDbDir })
    ).toThrowError(expect.objectContaining({ code: "DB_DIGEST_MISMATCH" }));

    // 4. Wrong producer, account, owner, operator override, epoch, and schema
    expect(() =>
      verifyReplicaBundle({
        ...baseVerifyOpts,
        expectedProducerId: "other-producer",
      })
    ).toThrowError(expect.objectContaining({ code: "PRODUCER_MISMATCH" }));

    expect(() =>
      verifyReplicaBundle({
        ...baseVerifyOpts,
        expectedAccountId: "other-account",
      })
    ).toThrowError(expect.objectContaining({ code: "ACCOUNT_MISMATCH" }));

    expect(() =>
      verifyReplicaBundle({
        ...baseVerifyOpts,
        expectedOwnerUserId: IDS.friend,
      })
    ).toThrowError(expect.objectContaining({ code: "OWNER_MISMATCH" }));

    expect(() =>
      verifyReplicaBundle({
        ...baseVerifyOpts,
        operatorOwnerOverride: IDS.friend,
      })
    ).toThrowError(expect.objectContaining({ code: "OWNER_MISMATCH" }));

    expect(() =>
      verifyReplicaBundle({
        ...baseVerifyOpts,
        expectedEpoch: 2,
      })
    ).toThrowError(expect.objectContaining({ code: "EPOCH_MISMATCH" }));

    expect(() =>
      verifyReplicaBundle({
        ...baseVerifyOpts,
        expectedSchemaVersion: "flighty-replica-schema-v0",
      })
    ).toThrowError(expect.objectContaining({ code: "SCHEMA_MISMATCH" }));
  });

  it("rejects future capture intervals, inverted intervals, excessive duration, and DB byte/row bounds", async () => {
    const root = makeTempDir();
    const exported = await buildValidBundle(root);
    const baseVerifyOpts = {
      bundleDir: exported.bundleDir,
      trustedPublicKey: TRUSTED_PUB_KEY,
      expectedProducerId: "imac-exporter",
      expectedAccountId: "acct-1",
      expectedOwnerUserId: IDS.owner,
      expectedEpoch: 1,
      now: Date.parse("2026-11-08T20:05:00.000Z"),
    };

    // 1. Future capture timestamp relative to receiver clock `now`
    expect(() =>
      verifyReplicaBundle({
        ...baseVerifyOpts,
        now: Date.parse("2026-11-08T19:59:59.000Z"),
      })
    ).toThrowError(
      expect.objectContaining({ code: "CAPTURE_INTERVAL_INVALID" })
    );

    // 2. Inverted capture interval (captureCompletedAt < captureStartedAt)
    const invertedDir = cloneAndMutateBundle(
      exported.bundleDir,
      join(root, "inverted-interval"),
      ({ manifestPath, manifest }) => {
        const { signature: _s, ...unsigned } = manifest;
        const bad = signReplicaManifest(
          {
            ...unsigned,
            captureStartedAt: "2026-11-08T20:00:05.000Z",
            captureCompletedAt: "2026-11-08T20:00:01.000Z",
          },
          TRUSTED_PRIV_KEY
        );
        writeFileSync(manifestPath, JSON.stringify(bad, null, 2), "utf8");
      }
    );
    expect(() =>
      verifyReplicaBundle({ ...baseVerifyOpts, bundleDir: invertedDir })
    ).toThrowError(
      expect.objectContaining({ code: "CAPTURE_INTERVAL_INVALID" })
    );

    // 3. DB byte limit exceeded
    expect(() =>
      verifyReplicaBundle({
        ...baseVerifyOpts,
        limits: { maxDbBytes: 1024 },
      })
    ).toThrowError(expect.objectContaining({ code: "DB_SIZE_EXCEEDED" }));

    // 4. Row count limit exceeded
    expect(() =>
      verifyReplicaBundle({
        ...baseVerifyOpts,
        limits: { maxRowsPerTable: 1 },
      })
    ).toThrowError(expect.objectContaining({ code: "DB_CONTENT_INVALID" }));
  });

  it("rejects SQLite views, triggers, unknown tables/columns, soft-deleted rows, unrelated friend-followed rows, WAL sidecars, and symlinks", async () => {
    const root = makeTempDir();
    const exported = await buildValidBundle(root);
    const baseVerifyOpts = {
      bundleDir: exported.bundleDir,
      trustedPublicKey: TRUSTED_PUB_KEY,
      expectedProducerId: "imac-exporter",
      expectedAccountId: "acct-1",
      expectedOwnerUserId: IDS.owner,
      expectedEpoch: 1,
      now: Date.parse("2026-11-08T20:05:00.000Z"),
    };

    // 1. Injected SQLite VIEW (even when re-signed with matching digest)
    const viewDir = cloneAndMutateBundle(
      exported.bundleDir,
      join(root, "injected-view"),
      ({ dbPath, manifestPath, manifest }) => {
        const db = new DatabaseSync(dbPath);
        db.exec("CREATE VIEW MaliciousView AS SELECT * FROM Flight;");
        db.close();
        resignMutatedDb(dbPath, manifestPath, manifest);
      }
    );
    expect(() =>
      verifyReplicaBundle({ ...baseVerifyOpts, bundleDir: viewDir })
    ).toThrowError(expect.objectContaining({ code: "DB_SCHEMA_INVALID" }));

    // 2. Injected SQLite TRIGGER
    const triggerDir = cloneAndMutateBundle(
      exported.bundleDir,
      join(root, "injected-trigger"),
      ({ dbPath, manifestPath, manifest }) => {
        const db = new DatabaseSync(dbPath);
        db.exec(
          "CREATE TRIGGER MaliciousTrigger AFTER INSERT ON Flight BEGIN SELECT 1; END;"
        );
        db.close();
        resignMutatedDb(dbPath, manifestPath, manifest);
      }
    );
    expect(() =>
      verifyReplicaBundle({ ...baseVerifyOpts, bundleDir: triggerDir })
    ).toThrowError(expect.objectContaining({ code: "DB_SCHEMA_INVALID" }));

    // 3. Injected Account table
    const accountTableDir = cloneAndMutateBundle(
      exported.bundleDir,
      join(root, "injected-account"),
      ({ dbPath, manifestPath, manifest }) => {
        const db = new DatabaseSync(dbPath);
        db.exec("CREATE TABLE Account (authToken TEXT);");
        db.close();
        resignMutatedDb(dbPath, manifestPath, manifest);
      }
    );
    expect(() =>
      verifyReplicaBundle({ ...baseVerifyOpts, bundleDir: accountTableDir })
    ).toThrowError(expect.objectContaining({ code: "DB_SCHEMA_INVALID" }));

    // 4. Injected unknown column on SyncInfo (nextURL)
    const nextUrlColDir = cloneAndMutateBundle(
      exported.bundleDir,
      join(root, "injected-nexturl"),
      ({ dbPath, manifestPath, manifest }) => {
        const db = new DatabaseSync(dbPath);
        db.exec("ALTER TABLE SyncInfo ADD COLUMN nextURL TEXT;");
        db.close();
        resignMutatedDb(dbPath, manifestPath, manifest);
      }
    );
    expect(() =>
      verifyReplicaBundle({ ...baseVerifyOpts, bundleDir: nextUrlColDir })
    ).toThrowError(expect.objectContaining({ code: "DB_SCHEMA_INVALID" }));

    // 5. Injected soft-deleted row (deleted = 1)
    const deletedRowDir = cloneAndMutateBundle(
      exported.bundleDir,
      join(root, "injected-deleted-row"),
      ({ dbPath, manifestPath, manifest }) => {
        const db = new DatabaseSync(dbPath);
        db.exec("UPDATE Flight SET deleted = 1 WHERE id = '" + IDS.flight + "';");
        db.close();
        resignMutatedDb(dbPath, manifestPath, manifest);
      }
    );
    expect(() =>
      verifyReplicaBundle({ ...baseVerifyOpts, bundleDir: deletedRowDir })
    ).toThrowError(expect.objectContaining({ code: "DB_CONTENT_INVALID" }));

    // 6. Injected unrelated friend-followed row (userId != owner && isMyFlight = 0)
    const friendFollowedDir = cloneAndMutateBundle(
      exported.bundleDir,
      join(root, "injected-friend-followed"),
      ({ dbPath, manifestPath, manifest }) => {
        const db = new DatabaseSync(dbPath);
        db.prepare("UPDATE UserFlight SET isMyFlight = 0 WHERE userId = ?").run(
          IDS.friend
        );
        db.close();
        resignMutatedDb(dbPath, manifestPath, manifest);
      }
    );
    expect(() =>
      verifyReplicaBundle({ ...baseVerifyOpts, bundleDir: friendFollowedDir })
    ).toThrowError(expect.objectContaining({ code: "DB_CONTENT_INVALID" }));

    // 7. Forbidden -wal sidecar file alongside replica.db
    const walSidecarDir = cloneAndMutateBundle(
      exported.bundleDir,
      join(root, "wal-sidecar"),
      ({ dbPath }) => {
        writeFileSync(`${dbPath}-wal`, "unverified-wal-frames");
      }
    );
    expect(() =>
      verifyReplicaBundle({ ...baseVerifyOpts, bundleDir: walSidecarDir })
    ).toThrowError(expect.objectContaining({ code: "DB_SIDECAR_FORBIDDEN" }));

    // 8. Symlink bundle directory rejection
    const symlinkBundleDir = join(root, "symlink-bundle");
    symlinkSync(exported.bundleDir, symlinkBundleDir);
    expect(() =>
      verifyReplicaBundle({ ...baseVerifyOpts, bundleDir: symlinkBundleDir })
    ).toThrowError(expect.objectContaining({ code: "INVALID_PATH" }));

    // 9. Path traversal and NUL byte rejection
    expect(() =>
      verifyReplicaBundle({
        ...baseVerifyOpts,
        bundleDir: `${root}/../traversal-bundle`,
      })
    ).toThrowError(expect.objectContaining({ code: "INVALID_PATH" }));

    expect(() =>
      verifyReplicaBundle({
        ...baseVerifyOpts,
        bundleDir: `${root}/nul\0bundle`,
      })
    ).toThrowError(expect.objectContaining({ code: "INVALID_PATH" }));

    // 10. Injected extra index, wrong runtime column type, unsafe SyncInfo.lastSync URL, and mismatched row count
    const extraIndexDir = cloneAndMutateBundle(
      exported.bundleDir,
      join(root, "injected-index"),
      ({ dbPath, manifestPath, manifest }) => {
        const db = new DatabaseSync(dbPath);
        db.exec("CREATE INDEX idx_flight_num ON Flight(number);");
        db.close();
        resignMutatedDb(dbPath, manifestPath, manifest);
      }
    );
    expect(() =>
      verifyReplicaBundle({ ...baseVerifyOpts, bundleDir: extraIndexDir })
    ).toThrowError(expect.objectContaining({ code: "DB_SCHEMA_INVALID" }));

    const wrongTypeDir = cloneAndMutateBundle(
      exported.bundleDir,
      join(root, "injected-wrong-type"),
      ({ dbPath, manifestPath, manifest }) => {
        const db = new DatabaseSync(dbPath);
        db.exec(
          `UPDATE Flight SET departureScheduleGateOriginal = 'not-an-integer' WHERE id = '${IDS.flight}';`
        );
        db.close();
        resignMutatedDb(dbPath, manifestPath, manifest);
      }
    );
    expect(() =>
      verifyReplicaBundle({ ...baseVerifyOpts, bundleDir: wrongTypeDir })
    ).toThrowError(expect.objectContaining({ code: "DB_CONTENT_INVALID" }));

    const unsafeSyncDir = cloneAndMutateBundle(
      exported.bundleDir,
      join(root, "injected-unsafe-sync"),
      ({ dbPath, manifestPath, manifest }) => {
        const db = new DatabaseSync(dbPath);
        db.exec(
          "UPDATE SyncInfo SET lastSync = 'https://sync.flightyapp.com/secret?token=123';"
        );
        db.close();
        resignMutatedDb(dbPath, manifestPath, manifest);
      }
    );
    expect(() =>
      verifyReplicaBundle({ ...baseVerifyOpts, bundleDir: unsafeSyncDir })
    ).toThrowError(expect.objectContaining({ code: "DB_CONTENT_INVALID" }));

    const rowCountMismatchDir = cloneAndMutateBundle(
      exported.bundleDir,
      join(root, "row-count-mismatch"),
      ({ dbPath, manifestPath, manifest }) => {
        const db = new DatabaseSync(dbPath);
        db.exec("DELETE FROM Ticket;");
        db.close();
        resignMutatedDb(dbPath, manifestPath, manifest);
      }
    );
    expect(() =>
      verifyReplicaBundle({
        ...baseVerifyOpts,
        bundleDir: rowCountMismatchDir,
      })
    ).toThrowError(expect.objectContaining({ code: "DB_CONTENT_INVALID" }));
  });
});
