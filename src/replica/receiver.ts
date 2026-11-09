import { randomUUID } from "node:crypto";
import {
  chmodSync,
   copyFileSync,
  existsSync,
   closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveNowMs, type NowInput } from "../services/freshness.js";
import { isValidUuid } from "../services/validation.js";
import {
  assertNoDatabaseSidecars,
  assertNoSymlinkChain,
  assertRegularFileNoSymlink,
  assertSafeAbsolutePath,
  createReplicaError,
  retirePath,
} from "./cleanup.js";
import {
  buildReplicaFreshnessMetadata,
  buildReplicaOwnerIdentity,
  runWithReplicaLeaseContext,
} from "./context.js";
import {
  REPLICA_DB_FILENAME,
  REPLICA_MANIFEST_FILENAME,
  computeFileSha256,
  computeManifestSha256,
  computePublicKeyId,
  normalizeEd25519PublicKey,
  parseReplicaManifestJson,
  verifyExactHexDigest,
  verifyManifestSignatureAndClaims,
} from "./manifest.js";
import {
  DEFAULT_MAX_DB_BYTES,
  REPLICA_SCHEMA_HASH,
  REPLICA_SCHEMA_VERSION,
  validateReplicaDatabaseSchemaAndContents,
} from "./schema.js";
import {
  ReplicaError,
  type AcceptReplicaBundleResult,
  type AcceptedGenerationRecord,
  type PersistedReceiverState,
  type ReplicaLease,
  type ReplicaReceiverConfig,
  type VerifiedReplicaBundle,
  type VerifyReplicaBundleOptions,
} from "./types.js";

const MAX_MANIFEST_BYTES = 256 * 1024;
const STATE_FILENAME = "state.json";
const STATE_FORMAT_VERSION = "flighty-replica-state-v1";

function fsyncFileAndParentDir(filePath: string, dirPath: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    fsyncSync(fd);
  } catch {
    // Some filesystems do not support fsync on read descriptors; ignore best-effort.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close error.
      }
    }
  }

  let dirFd: number | undefined;
  try {
    dirFd = openSync(dirPath, "r");
    fsyncSync(dirFd);
  } catch {
    // Directory fsync is best-effort across OSes.
  } finally {
    if (dirFd !== undefined) {
      try {
        closeSync(dirFd);
      } catch {
        // Ignore close error.
      }
    }
  }
}

/**
 * Verifies a replica bundle directory on disk:
 * - Path safety, symlink absence, and absence of SQLite WAL/SHM/journal sidecars
 * - Ed25519 manifest signature against pinned public key (no TOFU)
 * - Pinned producerId, accountId, ownerUserId, operatorOwnerOverride, epoch, schemaVersion, schemaHash
 * - Bounded capture interval (not inverted, bounded duration, not in the future)
 * - Exact DB byte size and SHA-256 digest before opening SQLite
 * - SQLite quick_check, exact 10-table allowlist schema, zero views/triggers/extra indexes,
 *   exact row counts, value types, no soft-deleted rows, and no unrelated friend-followed rows.
 */
export function verifyReplicaBundle(
  options: VerifyReplicaBundleOptions
): VerifiedReplicaBundle {
  const bundleDir = assertSafeAbsolutePath(
    options?.bundleDir,
    "bundleDir"
  );
  assertNoSymlinkChain(bundleDir, "bundleDir");

  const manifestPath = join(bundleDir, REPLICA_MANIFEST_FILENAME);
  const dbPath = join(bundleDir, REPLICA_DB_FILENAME);
  const pathsToRedact = [bundleDir, manifestPath, dbPath];

  const { size: manifestBytes } = assertRegularFileNoSymlink(
    manifestPath,
    "manifest.json",
    "MANIFEST_INVALID"
  );
  if (manifestBytes <= 0 || manifestBytes > MAX_MANIFEST_BYTES) {
    throw createReplicaError(
      "MANIFEST_INVALID",
      "Replica manifest.json is empty or exceeds maximum allowed size.",
      pathsToRedact
    );
  }

  let rawManifestJson: string;
  try {
    rawManifestJson = readFileSync(manifestPath, "utf8");
  } catch {
    throw createReplicaError(
      "MANIFEST_INVALID",
      "Could not read replica manifest.json.",
      pathsToRedact
    );
  }

  const manifest = parseReplicaManifestJson(rawManifestJson);

  verifyManifestSignatureAndClaims({
    manifest,
    trustedPublicKey: options.trustedPublicKey,
    expectedKeyId: options.expectedKeyId,
    expectedProducerId: options.expectedProducerId,
    expectedAccountId: options.expectedAccountId,
    expectedOwnerUserId: options.expectedOwnerUserId,
    operatorOwnerOverride: options.operatorOwnerOverride,
    expectedEpoch: options.expectedEpoch,
    expectedSchemaVersion: options.expectedSchemaVersion,
    expectedSchemaHash: options.expectedSchemaHash,
    limits: options.limits,
    now: options.now,
    checkFutureAgainstNow: true,
  });

  assertNoDatabaseSidecars(dbPath, "candidate replica database");
  const { size: actualDbBytes } = assertRegularFileNoSymlink(
    dbPath,
    "replica.db",
    "DB_MISSING"
  );

  const maxDbBytes = options.limits?.maxDbBytes ?? DEFAULT_MAX_DB_BYTES;
  if (actualDbBytes <= 0 || actualDbBytes > maxDbBytes) {
    throw createReplicaError(
      "DB_SIZE_EXCEEDED",
      `Candidate replica.db size (${actualDbBytes} bytes) exceeds maximum allowed (${maxDbBytes} bytes).`,
      pathsToRedact
    );
  }

  if (actualDbBytes !== manifest.dbBytes) {
    throw createReplicaError(
      "DB_DIGEST_MISMATCH",
      `Candidate replica.db size (${actualDbBytes} bytes) does not match signed manifest (${manifest.dbBytes} bytes).`,
      pathsToRedact
    );
  }

  const { sha256: actualDbSha256 } = computeFileSha256(dbPath);
  if (!verifyExactHexDigest(actualDbSha256, manifest.dbSha256)) {
    throw createReplicaError(
      "DB_DIGEST_MISMATCH",
      "Candidate replica.db SHA-256 digest does not match signed manifest.",
      pathsToRedact
    );
  }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, {
      readOnly: true,
      allowExtension: false,
    });
    validateReplicaDatabaseSchemaAndContents(
      db,
      manifest,
      options.limits
    );
  } catch (err) {
    if (err instanceof ReplicaError) {
      throw err;
    }
    throw createReplicaError(
      "DB_INTEGRITY_FAILED",
      "Failed to open or validate candidate replica SQLite database.",
      pathsToRedact
    );
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close error.
    }
  }

  return {
    bundleDir,
    dbPath,
    manifestPath,
    manifest,
    manifestSha256: computeManifestSha256(manifest),
  };
}

export class ReplicaReceiver {
  private readonly stateRootDir: string;
  private readonly generationsDir: string;
  private readonly stagingDir: string;
  private readonly trashDir: string;
  private readonly stateFilePath: string;
  private readonly config: ReplicaReceiverConfig;
  private readonly pinnedKeyId: string;
  private readonly expectedSchemaVersion: string;
  private readonly expectedSchemaHash: string;
  private readonly maxRetainedGenerations: number;
  private state: PersistedReceiverState;
  private readonly leaseCounts = new Map<string, number>();

  constructor(config: ReplicaReceiverConfig) {
    if (!config || typeof config !== "object") {
      throw createReplicaError(
        "INVALID_CONFIG",
        "ReplicaReceiver configuration object is required."
      );
    }

    this.stateRootDir = assertSafeAbsolutePath(
      config.stateRootDir,
      "stateRootDir"
    );
    assertNoSymlinkChain(this.stateRootDir, "stateRootDir");

    const pubKey = normalizeEd25519PublicKey(config.publicKey);
    this.pinnedKeyId =
      config.expectedKeyId?.trim() || computePublicKeyId(pubKey);

    const producerId = (config.producerId ?? "").trim();
    if (!producerId) {
      throw createReplicaError(
        "INVALID_CONFIG",
        "Pinned producerId is required in receiver configuration."
      );
    }

    const accountId = (config.accountId ?? "").trim();
    if (!accountId) {
      throw createReplicaError(
        "INVALID_CONFIG",
        "Pinned accountId is required in receiver configuration."
      );
    }

    const ownerUserId = (config.ownerUserId ?? "").trim();
    if (!isValidUuid(ownerUserId)) {
      throw createReplicaError(
        "INVALID_CONFIG",
        "Pinned ownerUserId must be a valid UUID in receiver configuration."
      );
    }

    const operatorOverride = (config.operatorOwnerOverride ?? "").trim();
    if (
      operatorOverride.length > 0 &&
      operatorOverride.toLowerCase() !== ownerUserId.toLowerCase()
    ) {
      throw createReplicaError(
        "OWNER_MISMATCH",
        "Configured operator owner override disagrees with the approved replica ownerUserId scope."
      );
    }

    if (
      typeof config.epoch !== "number" ||
      !Number.isSafeInteger(config.epoch) ||
      config.epoch < 1
    ) {
      throw createReplicaError(
        "INVALID_CONFIG",
        "Pinned epoch must be a positive safe integer (>= 1)."
      );
    }

    this.expectedSchemaVersion =
      config.schemaVersion ?? REPLICA_SCHEMA_VERSION;
    this.expectedSchemaHash = config.schemaHash ?? REPLICA_SCHEMA_HASH;
    if (
      this.expectedSchemaVersion !== REPLICA_SCHEMA_VERSION ||
      this.expectedSchemaHash !== REPLICA_SCHEMA_HASH
    ) {
      throw createReplicaError(
        "SCHEMA_MISMATCH",
        "Receiver schemaVersion/schemaHash configuration does not match static allowlist schema."
      );
    }

    this.maxRetainedGenerations = Math.max(
      2,
      config.maxRetainedGenerations ?? 2
    );

    this.config = {
      ...config,
      publicKey: pubKey,
      producerId,
      accountId,
      ownerUserId,
    };

    this.generationsDir = join(this.stateRootDir, "generations");
    this.stagingDir = join(this.stateRootDir, "staging");
    this.trashDir = join(this.stateRootDir, ".trash");
    this.stateFilePath = join(this.stateRootDir, STATE_FILENAME);

    mkdirSync(this.stateRootDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.generationsDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.stagingDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.trashDir, { recursive: true, mode: 0o700 });

    this.state = this.recoverAndLoadState();
  }

  private createInitialState(): PersistedReceiverState {
    return {
      formatVersion: STATE_FORMAT_VERSION,
      producerId: this.config.producerId,
      accountId: this.config.accountId,
      ownerUserId: this.config.ownerUserId,
      epoch: this.config.epoch,
      schemaVersion: this.expectedSchemaVersion,
      schemaHash: this.expectedSchemaHash,
      highwaterSequence: 0,
      activeGenerationId: null,
      lastGoodGenerationId: null,
      acceptedBySequence: {},
    };
  }

  private recoverAndLoadState(): PersistedReceiverState {
    // 1. Retire all uncommitted staging directories/files left from prior crashes.
    for (const entry of readdirSync(this.stagingDir)) {
      retirePath(
        join(this.stagingDir, entry),
        this.trashDir,
        this.config.cleanupPath
      );
    }

    let loadedState: PersistedReceiverState | null = null;
    if (existsSync(this.stateFilePath)) {
      assertRegularFileNoSymlink(
        this.stateFilePath,
        "state.json",
        "STORAGE_WRITE_FAILED"
      );
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(this.stateFilePath, "utf8"));
      } catch {
        throw createReplicaError(
          "STORAGE_WRITE_FAILED",
          "Persisted receiver state.json is corrupted or unreadable.",
          [this.stateFilePath]
        );
      }

      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw createReplicaError(
          "STORAGE_WRITE_FAILED",
          "Persisted receiver state.json must be a JSON object.",
          [this.stateFilePath]
        );
      }

      const s = raw as Record<string, unknown>;
      if (
        s.formatVersion !== STATE_FORMAT_VERSION ||
        typeof s.producerId !== "string" ||
        typeof s.accountId !== "string" ||
        typeof s.ownerUserId !== "string" ||
        typeof s.epoch !== "number" ||
        typeof s.highwaterSequence !== "number" ||
        !Number.isSafeInteger(s.highwaterSequence) ||
        s.highwaterSequence < 0 ||
        !s.acceptedBySequence ||
        typeof s.acceptedBySequence !== "object" ||
        Array.isArray(s.acceptedBySequence)
      ) {
        throw createReplicaError(
          "STORAGE_WRITE_FAILED",
          "Persisted receiver state.json has invalid structure.",
          [this.stateFilePath]
        );
      }

      const sameBinding =
        s.producerId === this.config.producerId &&
        s.accountId === this.config.accountId &&
        s.ownerUserId.toLowerCase() ===
          this.config.ownerUserId.toLowerCase() &&
        s.epoch === this.config.epoch &&
        s.schemaVersion === this.expectedSchemaVersion &&
        s.schemaHash === this.expectedSchemaHash;

      if (!sameBinding) {
        if (!this.config.allowAccountTransition) {
          throw createReplicaError(
            "ACCOUNT_TRANSITION_REQUIRED",
            "Persisted receiver state belongs to a different account, owner, producer, or epoch; explicit transition is required before serving or accepting data.",
            [this.stateRootDir]
          );
        }

        // Explicit account/epoch transition: retire all prior account generations
        // so previous account's active or lastGood data can NEVER leak.
        for (const entry of readdirSync(this.generationsDir)) {
          retirePath(
            join(this.generationsDir, entry),
            this.trashDir,
            this.config.cleanupPath
          );
        }
        const transitioned = this.createInitialState();
        this.writeStateFileAtomically(transitioned);
        return transitioned;
      }

      loadedState = {
        formatVersion: STATE_FORMAT_VERSION,
        producerId: s.producerId,
        accountId: s.accountId,
        ownerUserId: s.ownerUserId,
        epoch: s.epoch,
        schemaVersion: String(s.schemaVersion),
        schemaHash: String(s.schemaHash),
        highwaterSequence: s.highwaterSequence,
        activeGenerationId:
          typeof s.activeGenerationId === "string"
            ? s.activeGenerationId
            : null,
        lastGoodGenerationId:
          typeof s.lastGoodGenerationId === "string"
            ? s.lastGoodGenerationId
            : null,
        acceptedBySequence: s.acceptedBySequence as Record<
          string,
          AcceptedGenerationRecord
        >,
      };
    }

    const effectiveState = loadedState ?? this.createInitialState();

    // 2. Retire any uncommitted orphan directories in generations/ that are not in state.json.
    const committedDirNames = new Set<string>();
    for (const rec of Object.values(effectiveState.acceptedBySequence)) {
      if (rec && typeof rec.bundleDirName === "string") {
        committedDirNames.add(rec.bundleDirName);
      }
    }

    for (const entry of readdirSync(this.generationsDir)) {
      if (!committedDirNames.has(entry)) {
        retirePath(
          join(this.generationsDir, entry),
          this.trashDir,
          this.config.cleanupPath
        );
      }
    }

    return effectiveState;
  }

  private writeStateFileAtomically(nextState: PersistedReceiverState): void {
    const tmpPath = join(
      this.stagingDir,
      `state.json.tmp.${Date.now()}-${randomUUID()}`
    );
    const pathsToRedact = [this.stateRootDir, this.stateFilePath, tmpPath];

    try {
      this.config.faultHooks?.beforeCommitStateFile?.(tmpPath);
      const serialized = `${JSON.stringify(nextState, null, 2)}\n`;
      writeFileSync(tmpPath, serialized, { encoding: "utf8", mode: 0o600 });
      fsyncFileAndParentDir(tmpPath, this.stagingDir);
      renameSync(tmpPath, this.stateFilePath);
      fsyncFileAndParentDir(this.stateFilePath, this.stateRootDir);
    } catch (err) {
      retirePath(tmpPath, this.trashDir, this.config.cleanupPath);
      if (err instanceof ReplicaError) {
        throw err;
      }
      throw createReplicaError(
        "STORAGE_WRITE_FAILED",
        "Failed to commit receiver state.json atomically.",
        pathsToRedact
      );
    }
  }

  private findRecordByGenerationId(
    generationId: string | null
  ): AcceptedGenerationRecord | null {
    if (!generationId) return null;
    for (const rec of Object.values(this.state.acceptedBySequence)) {
      if (rec.generationId === generationId) {
        return rec;
      }
    }
    return null;
  }

  /**
   * Verifies that an already-accepted generation on disk is still intact,
   * belongs to the current pinned account/owner/producer/epoch, has no sidecars,
   * and matches its signed SHA-256 DB digest.
   */
  private isGenerationHealthyOnDisk(
    rec: AcceptedGenerationRecord | null
  ): rec is AcceptedGenerationRecord {
    if (!rec) return false;
    if (
      rec.producerId !== this.config.producerId ||
      rec.accountId !== this.config.accountId ||
      rec.ownerUserId.toLowerCase() !==
        this.config.ownerUserId.toLowerCase() ||
      rec.epoch !== this.config.epoch
    ) {
      return false;
    }

    const bundleDir = join(this.generationsDir, rec.bundleDirName);
    const dbPath = join(bundleDir, REPLICA_DB_FILENAME);
    try {
      assertNoSymlinkChain(bundleDir, "generation bundleDir", this.stateRootDir);
      assertNoDatabaseSidecars(dbPath, "active replica database");
      const { size } = assertRegularFileNoSymlink(dbPath, "replica.db");
      if (size !== rec.manifest.dbBytes) {
        return false;
      }
      const { sha256 } = computeFileSha256(dbPath);
      return verifyExactHexDigest(sha256, rec.dbSha256);
    } catch {
      return false;
    }
  }

  /**
   * Accepts a candidate replica bundle into the receiver store.
   * - Stages and fully verifies the bundle before publication.
   * - Idempotently acknowledges an identical resend of the current generation without resetting receive/capture age.
   * - Rejects conflicting sequence numbers (`CONFLICTING_SEQUENCE`) and stale sequence replays (`REPLAY_REJECTED`).
   * - Leaves accepted state intact on disk-full, partial transfer, or crash before state commit.
   */
  acceptBundle(sourceBundleDir: string): AcceptReplicaBundleResult {
    const cleanSourceDir = assertSafeAbsolutePath(
      sourceBundleDir,
      "sourceBundleDir"
    );
    assertNoSymlinkChain(cleanSourceDir, "sourceBundleDir");

    const srcManifestPath = join(
      cleanSourceDir,
      REPLICA_MANIFEST_FILENAME
    );
    const srcDbPath = join(cleanSourceDir, REPLICA_DB_FILENAME);
    const pathsToRedact = [
      cleanSourceDir,
      srcManifestPath,
      srcDbPath,
      this.stateRootDir,
    ];

    assertNoDatabaseSidecars(srcDbPath, "incoming replica database");
    const { size: srcManifestBytes } = assertRegularFileNoSymlink(
      srcManifestPath,
      "manifest.json",
      "MANIFEST_INVALID"
    );
    if (srcManifestBytes <= 0 || srcManifestBytes > MAX_MANIFEST_BYTES) {
      throw createReplicaError(
        "MANIFEST_INVALID",
        "Incoming manifest.json is empty or exceeds maximum allowed size.",
        pathsToRedact
      );
    }

    const { size: srcDbBytes } = assertRegularFileNoSymlink(
      srcDbPath,
      "replica.db",
      "DB_MISSING"
    );
    const maxDbBytes =
      this.config.limits?.maxDbBytes ?? DEFAULT_MAX_DB_BYTES;
    if (srcDbBytes <= 0 || srcDbBytes > maxDbBytes) {
      throw createReplicaError(
        "DB_SIZE_EXCEEDED",
        `Incoming replica.db size (${srcDbBytes} bytes) exceeds maximum allowed (${maxDbBytes} bytes).`,
        pathsToRedact
      );
    }

    const stageDir = join(
      this.stagingDir,
      `stage-${Date.now()}-${randomUUID()}`
    );
    let publishedGenDir: string | null = null;
    let committed = false;
    let simulatingAbruptCrash = false;

    try {
      mkdirSync(stageDir, { recursive: true, mode: 0o700 });
      const stagedManifestPath = join(stageDir, REPLICA_MANIFEST_FILENAME);
      const stagedDbPath = join(stageDir, REPLICA_DB_FILENAME);

      try {
        this.config.faultHooks?.onStageWrite?.(stageDir);
        copyFileSync(srcManifestPath, stagedManifestPath);
        copyFileSync(srcDbPath, stagedDbPath);
        chmodSync(stagedManifestPath, 0o600);
        chmodSync(stagedDbPath, 0o600);
      } catch (err) {
        if (err instanceof ReplicaError) {
          throw err;
        }
        throw createReplicaError(
          "STORAGE_WRITE_FAILED",
          "Failed to stage incoming replica bundle (disk full or partial transfer); accepted state remains intact.",
          pathsToRedact
        );
      }

      // Verify manifest, signature, digest, schema, and contents inside the isolated staging dir.
      const verified = verifyReplicaBundle({
        bundleDir: stageDir,
        trustedPublicKey: this.config.publicKey,
        expectedKeyId: this.pinnedKeyId,
        expectedProducerId: this.config.producerId,
        expectedAccountId: this.config.accountId,
        expectedOwnerUserId: this.config.ownerUserId,
        operatorOwnerOverride: this.config.operatorOwnerOverride,
        expectedEpoch: this.config.epoch,
        expectedSchemaVersion: this.expectedSchemaVersion,
        expectedSchemaHash: this.expectedSchemaHash,
        limits: this.config.limits,
        now: this.config.now,
      });

      const { manifest, manifestSha256 } = verified;
      const seqKey = String(manifest.sequence);
      const existingForSeq = this.state.acceptedBySequence[seqKey];

      if (existingForSeq) {
        const sameContent =
          verifyExactHexDigest(existingForSeq.dbSha256, manifest.dbSha256) &&
          verifyExactHexDigest(
            existingForSeq.manifestSha256,
            manifestSha256
          );

        if (!sameContent) {
          throw createReplicaError(
            "CONFLICTING_SEQUENCE",
            `Sequence ${manifest.sequence} was already accepted with different content or manifest digest.`,
            pathsToRedact
          );
        }

        if (manifest.sequence === this.state.highwaterSequence) {
          // Idempotent resend of the active generation: return ORIGINAL receive & capture timestamps!
          const existingDbPath = join(
            this.generationsDir,
            existingForSeq.bundleDirName,
            REPLICA_DB_FILENAME
          );
          return {
            status: "duplicate_acknowledged",
            generationId: existingForSeq.generationId,
            epoch: existingForSeq.epoch,
            sequence: existingForSeq.sequence,
            receivedAt: existingForSeq.receivedAt,
            receivedAtMs: existingForSeq.receivedAtMs,
            captureStartedAt: existingForSeq.manifest.captureStartedAt,
            captureCompletedAt: existingForSeq.manifest.captureCompletedAt,
            dbPath: existingDbPath,
            manifest: existingForSeq.manifest,
            highwaterSequence: this.state.highwaterSequence,
          };
        }

        throw createReplicaError(
          "REPLAY_REJECTED",
          `Sequence ${manifest.sequence} is older than accepted highwater sequence (${this.state.highwaterSequence}); replay rejected.`,
          pathsToRedact
        );
      }

      if (manifest.sequence <= this.state.highwaterSequence) {
        throw createReplicaError(
          "REPLAY_REJECTED",
          `Sequence ${manifest.sequence} is not greater than accepted highwater sequence (${this.state.highwaterSequence}); replay rejected.`,
          pathsToRedact
        );
      }

      const generationId = `gen-e${manifest.epoch}-s${manifest.sequence}-${manifest.dbSha256.slice(0, 12)}`;
      const generationDir = join(this.generationsDir, generationId);

      this.config.faultHooks?.beforePublishBundle?.(stageDir, generationId);

      if (existsSync(generationDir)) {
        retirePath(
          generationDir,
          this.trashDir,
          this.config.cleanupPath
        );
      }

      // Seal replica.db read-only before publishing into generations/.
      chmodSync(stagedDbPath, 0o400);
      fsyncFileAndParentDir(stagedDbPath, stageDir);
      fsyncFileAndParentDir(stagedManifestPath, stageDir);

      try {
        renameSync(stageDir, generationDir);
        publishedGenDir = generationDir;
        fsyncFileAndParentDir(generationDir, this.generationsDir);
      } catch (err) {
        if (err instanceof ReplicaError) {
          throw err;
        }
        throw createReplicaError(
          "STORAGE_WRITE_FAILED",
          "Failed to publish verified bundle into generations directory.",
          pathsToRedact
        );
      }

      try {
        this.config.faultHooks?.afterPublishBundleBeforeStateCommit?.(
          generationDir,
          generationId
        );
      } catch (crashErr) {
        simulatingAbruptCrash = true;
        throw crashErr;
      }

      const receivedAtMs = resolveNowMs(this.config.now);
      const receivedAt = new Date(receivedAtMs).toISOString();

      const currentActive = this.findRecordByGenerationId(
        this.state.activeGenerationId
      );
      const nextLastGoodId = this.isGenerationHealthyOnDisk(currentActive)
        ? currentActive.generationId
        : this.state.lastGoodGenerationId;

      const newRecord: AcceptedGenerationRecord = {
        generationId,
        producerId: manifest.producerId,
        accountId: manifest.accountId,
        ownerUserId: manifest.ownerUserId,
        epoch: manifest.epoch,
        sequence: manifest.sequence,
        dbSha256: manifest.dbSha256,
        manifestSha256,
        bundleDirName: generationId,
        receivedAt,
        receivedAtMs,
        manifest,
        retainedOnDisk: true,
      };

      const nextState: PersistedReceiverState = {
        ...this.state,
        highwaterSequence: manifest.sequence,
        activeGenerationId: generationId,
        lastGoodGenerationId: nextLastGoodId,
        acceptedBySequence: {
          ...this.state.acceptedBySequence,
          [seqKey]: newRecord,
        },
      };

      this.writeStateFileAtomically(nextState);
      this.state = nextState;
      committed = true;

      this.cleanupOldGenerations();

      return {
        status: "accepted",
        generationId,
        epoch: manifest.epoch,
        sequence: manifest.sequence,
        receivedAt,
        receivedAtMs,
        captureStartedAt: manifest.captureStartedAt,
        captureCompletedAt: manifest.captureCompletedAt,
        dbPath: join(generationDir, REPLICA_DB_FILENAME),
        manifest,
        highwaterSequence: this.state.highwaterSequence,
      };
    } finally {
      if (!simulatingAbruptCrash) {
        retirePath(stageDir, this.trashDir, this.config.cleanupPath);
      }
      if (
        !committed &&
        !simulatingAbruptCrash &&
        publishedGenDir &&
        existsSync(publishedGenDir)
      ) {
        retirePath(
          publishedGenDir,
          this.trashDir,
          this.config.cleanupPath
        );
      }
    }
  }

  /**
   * Acquires a pinned request lease on the active generation (or explicitly labelled
   * same-account `lastGood` generation when the active generation is damaged and
   * `allowStaleRecovery` is enabled).
   */
  acquireLease(): ReplicaLease {
    const envOverride = (
      this.config.operatorOwnerOverride ??
      process.env.FLIGHTY_OWNER_USER_ID ??
      ""
    ).trim();
    if (
      envOverride.length > 0 &&
      envOverride.toLowerCase() !== this.config.ownerUserId.toLowerCase()
    ) {
      throw createReplicaError(
        "OWNER_MISMATCH",
        "Operator owner override disagrees with the approved replica ownerUserId scope."
      );
    }

    if (!this.state.activeGenerationId) {
      throw createReplicaError(
        "NO_ACTIVE_GENERATION",
        "No accepted replica generation is available for the current pinned account and epoch."
      );
    }

    const activeRec = this.findRecordByGenerationId(
      this.state.activeGenerationId
    );
    let selectedRec: AcceptedGenerationRecord | null = null;
    let isStaleRecovery = false;
    let recoveryReason: string | null = null;

    if (this.isGenerationHealthyOnDisk(activeRec)) {
      selectedRec = activeRec;
    } else if (this.config.allowStaleRecovery !== false) {
      const lastGoodRec = this.findRecordByGenerationId(
        this.state.lastGoodGenerationId
      );
      if (this.isGenerationHealthyOnDisk(lastGoodRec)) {
        selectedRec = lastGoodRec;
        isStaleRecovery = true;
        recoveryReason = "active_generation_damaged_serving_last_good";
      }
    }

    if (!selectedRec) {
      throw createReplicaError(
        "ACTIVE_GENERATION_DAMAGED",
        "Active replica generation is unavailable or damaged and no verified same-account recovery generation exists."
      );
    }

    const genId = selectedRec.generationId;
    this.leaseCounts.set(genId, (this.leaseCounts.get(genId) ?? 0) + 1);

    const bundleDir = join(this.generationsDir, selectedRec.bundleDirName);
    const dbPath = join(bundleDir, REPLICA_DB_FILENAME);
    const ownerIdentity = buildReplicaOwnerIdentity(
      selectedRec.manifest,
      genId
    );
    const leaseId = `lease-${randomUUID()}`;
    let released = false;

    const lease: ReplicaLease = {
      leaseId,
      generationId: genId,
      epoch: selectedRec.epoch,
      sequence: selectedRec.sequence,
      dbPath,
      bundleDir,
      manifest: selectedRec.manifest,
      receivedAt: selectedRec.receivedAt,
      receivedAtMs: selectedRec.receivedAtMs,
      ownerIdentity,
      isStaleRecovery,
      recoveryReason,
      isReleased: () => released,
      openDatabase: () => {
        if (released) {
          throw createReplicaError(
            "INVALID_CONFIG",
            "Cannot open database on a released replica lease."
          );
        }
        return new DatabaseSync(dbPath, {
          readOnly: true,
          allowExtension: false,
        });
      },
      computeFreshness: (opts) =>
        buildReplicaFreshnessMetadata({
          manifest: selectedRec.manifest,
          generationId: genId,
          dbPath,
          receivedAt: selectedRec.receivedAt,
          receivedAtMs: selectedRec.receivedAtMs,
          isStaleRecovery,
          recoveryReason,
          now: opts?.now ?? this.config.now,
          toolName: opts?.toolName,
          isError: opts?.isError,
        }),
      release: () => {
        if (released) return;
        released = true;
        const cur = this.leaseCounts.get(genId) ?? 0;
        if (cur <= 1) {
          this.leaseCounts.delete(genId);
        } else {
          this.leaseCounts.set(genId, cur - 1);
        }
        this.cleanupOldGenerations();
      },
    };

    return Object.freeze(lease);
  }

  /**
   * Runs a synchronous or asynchronous callback within a pinned `ReplicaLease` and
   * `AsyncLocalStorage` context, guaranteeing that `dbPath`, `ownerIdentity`, `manifest`,
   * `receivedAt`, and `computeFreshness` remain bound to the same generation until
   * async completion, and releasing the lease in `finally`.
   */
  async withLease<T>(
    fn: (lease: ReplicaLease) => T | Promise<T>
  ): Promise<T> {
    const lease = this.acquireLease();
    try {
      return await runWithReplicaLeaseContext(lease, () => fn(lease));
    } finally {
      lease.release();
    }
  }

  /**
   * Retires superseded generations beyond `maxRetainedGenerations`, while NEVER retiring:
   * - `activeGenerationId`
   * - `lastGoodGenerationId` (approved rollback / stale recovery generation)
   * - Any generation with an active request lease (`leaseCounts.get(genId) > 0`).
   */
  cleanupOldGenerations(): string[] {
    const protectedIds = new Set<string>();
    if (this.state.activeGenerationId) {
      protectedIds.add(this.state.activeGenerationId);
    }
    if (this.state.lastGoodGenerationId) {
      protectedIds.add(this.state.lastGoodGenerationId);
    }
    for (const [genId, count] of this.leaseCounts.entries()) {
      if (count > 0) {
        protectedIds.add(genId);
      }
    }

    const retainedRecords = Object.values(this.state.acceptedBySequence)
      .filter((r) => r.retainedOnDisk)
      .sort((a, b) => b.sequence - a.sequence);

    const keepIds = new Set<string>(protectedIds);
    for (const rec of retainedRecords) {
      if (keepIds.size >= this.maxRetainedGenerations) {
        break;
      }
      keepIds.add(rec.generationId);
    }

    const retiredIds: string[] = [];
    const updatedMap: Record<string, AcceptedGenerationRecord> = {
      ...this.state.acceptedBySequence,
    };

    for (const rec of retainedRecords) {
      if (keepIds.has(rec.generationId)) {
        continue;
      }
      const genDir = join(this.generationsDir, rec.bundleDirName);
      retirePath(genDir, this.trashDir, this.config.cleanupPath);
      updatedMap[String(rec.sequence)] = {
        ...rec,
        retainedOnDisk: false,
      };
      retiredIds.push(rec.generationId);
    }

    if (retiredIds.length > 0) {
      const nextState: PersistedReceiverState = {
        ...this.state,
        acceptedBySequence: updatedMap,
      };
      this.writeStateFileAtomically(nextState);
      this.state = nextState;
    }

    return retiredIds;
  }

  getStateSnapshot(): PersistedReceiverState {
    return JSON.parse(
      JSON.stringify(this.state)
    ) as PersistedReceiverState;
  }

  getActiveLeaseCount(generationId?: string): number {
    if (generationId) {
      return this.leaseCounts.get(generationId) ?? 0;
    }
    let total = 0;
    for (const count of this.leaseCounts.values()) {
      total += count;
    }
    return total;
  }
}

export function acceptReplicaBundle(
  receiver: ReplicaReceiver,
  sourceBundleDir: string
): AcceptReplicaBundleResult {
  return receiver.acceptBundle(sourceBundleDir);
}

export function acquireReplicaLease(receiver: ReplicaReceiver): ReplicaLease {
  return receiver.acquireLease();
}

export function releaseReplicaLease(lease: ReplicaLease): void {
  lease.release();
}

export async function withReplicaLease<T>(
  receiver: ReplicaReceiver,
  fn: (lease: ReplicaLease) => T | Promise<T>
): Promise<T> {
  return receiver.withLease(fn);
}
