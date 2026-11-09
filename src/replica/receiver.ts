import { runSqliteTask, assertSqliteBudget } from "./work.js";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
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
  assertReplicaDatabaseHeader,
  assertNoSymlinkChain,
  assertRegularFileNoSymlink,
  assertSafeAbsolutePath,
  createReplicaError,
  retirePath,
  assertExactBundle, assertPrivatePath, validateStorage, measureStorage, flushPath, publicReplicaError,
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
  validateLimits,
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
function verifyReplicaBundleInternal(
  options: VerifyReplicaBundleOptions
): VerifiedReplicaBundle {
  const bundleDir = assertSafeAbsolutePath(
    options?.bundleDir,
    "bundleDir"
  );
  assertNoSymlinkChain(bundleDir, "bundleDir");
  assertPrivatePath(bundleDir, bundleDir);
  assertNoDatabaseSidecars(join(bundleDir, REPLICA_DB_FILENAME));
  assertExactBundle(bundleDir);
  validateLimits(options.limits ?? {});

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

  assertReplicaDatabaseHeader(dbPath);
  runSqliteTask({ kind: "validate", dbPath, manifest, limits: options.limits }, options.limits?.maxOperationDurationMs);

  const verified = {
    bundleDir,
    dbPath,
    manifestPath,
    manifest,
    manifestSha256: computeManifestSha256(manifest),
  };
  assertVerifiedBundleUnchanged(verified);
  return verified;
}

function assertVerifiedBundleUnchanged(verified: VerifiedReplicaBundle): void {
  assertNoDatabaseSidecars(verified.dbPath);
  assertExactBundle(verified.bundleDir);
  assertReplicaDatabaseHeader(verified.dbPath);
  const { size } = assertRegularFileNoSymlink(verified.manifestPath, "manifest");
  if (size <= 0 || size > MAX_MANIFEST_BYTES) throw createReplicaError("MANIFEST_INVALID", "Replica manifest changed after validation.");
  const manifest = parseReplicaManifestJson(readFileSync(verified.manifestPath, "utf8"));
  if (assertRegularFileNoSymlink(verified.dbPath, "replica database").size !== verified.manifest.dbBytes) throw createReplicaError("DB_DIGEST_MISMATCH", "Replica database size changed after validation.");
  const digest = computeFileSha256(verified.dbPath);
  if (computeManifestSha256(manifest) !== verified.manifestSha256 || digest.bytes !== verified.manifest.dbBytes || digest.sha256 !== verified.manifest.dbSha256) {
    throw createReplicaError("DB_DIGEST_MISMATCH", "Replica bundle changed after validation.");
  }
}

export function verifyReplicaBundle(options: VerifyReplicaBundleOptions): VerifiedReplicaBundle {
  try { return verifyReplicaBundleInternal(options); } catch (error) { throw publicReplicaError(error); }
}

export class ReplicaReceiver {
  private readonly stateRootDir: string;
  private readonly generationsDir: string;
  private readonly stagingDir: string;
  private readonly trashDir: string;
  private readonly stateFilePath: string;
  private readonly config: ReplicaReceiverConfig;
  private readonly pinnedKeyId: string;
  private readonly verificationKeyFingerprint: string;
  private uncertain = false;
  private readonly expectedSchemaVersion: string;
  private readonly expectedSchemaHash: string;
  private readonly maxRetainedGenerations: number;
  private state: PersistedReceiverState;
  private readonly leaseCounts = new Map<string, number>();

  constructor(config: ReplicaReceiverConfig) {
    try {
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
      this.verificationKeyFingerprint = createHash("sha256").update(pubKey.export({ type: "spki", format: "der" })).digest("hex");
      this.pinnedKeyId =
        config.expectedKeyId?.trim() || computePublicKeyId(pubKey);

      const producerId = (config.producerId ?? "").trim();
      if (!producerId || producerId.length > 256) {
        throw createReplicaError(
          "INVALID_CONFIG",
          "Pinned producerId is required in receiver configuration."
        );
      }

      const accountId = (config.accountId ?? "").trim();
      if (!accountId || accountId.length > 256) {
        throw createReplicaError(
          "INVALID_CONFIG",
          "Pinned accountId is required in receiver configuration."
        );
      }

      const ownerUserId = (config.ownerUserId ?? "").trim().toLowerCase();
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

      this.maxRetainedGenerations = config.maxRetainedGenerations ?? 2;
      if (!Number.isSafeInteger(this.maxRetainedGenerations) || this.maxRetainedGenerations < 2 || this.maxRetainedGenerations > 64) throw createReplicaError("INVALID_CONFIG", "Generation retention must be between 2 and 64.");
      validateLimits(config.limits ?? {});

      if (config.cleanupPath) throw createReplicaError("INVALID_CONFIG", "Receiver cleanup is bounded private quarantine; custom deletion callbacks are unsupported.");
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

      this.validateStore();
      this.state = this.recoverAndLoadState();
    } catch (error) { throw publicReplicaError(error); }
  }

  private validateStore(): void {
    const paths = [this.stateRootDir, this.generationsDir, this.stagingDir, this.trashDir];
    validateStorage(this.config.storage, paths, false);
    measureStorage(this.stateRootDir, this.config.storageBudget);
    validateStorage(this.config.storage, paths);
  }
  private assertReady(): void {
    if (this.uncertain) throw createReplicaError("COMMIT_UNCERTAIN", "Receiver commit durability is uncertain; restart and revalidate before further work.");
    this.validateStore();
  }
  private bindingId(state: { producerId: string; accountId: string; ownerUserId: string; epoch: number } = this.config): string {
    return createHash("sha256").update(JSON.stringify([state.producerId, state.accountId, state.ownerUserId.toLowerCase(), state.epoch])).digest("hex");
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
      verificationKeyFingerprint: this.verificationKeyFingerprint,
      keyId: this.pinnedKeyId,
      bindingHighwaters: {},
      highwaterSequence: 0,
      activeGenerationId: null,
      lastGoodGenerationId: null,
      acceptedBySequence: {},
    };
  }

  private recoverAndLoadState(): PersistedReceiverState {
    let state = this.createInitialState();
    if (!existsSync(this.stateFilePath)) {
      if (readdirSync(this.generationsDir).length || readdirSync(this.stagingDir).length || readdirSync(this.trashDir).length) throw createReplicaError("STORAGE_WRITE_FAILED", "Receiver state is missing while prior storage exists; replay history cannot be reconstructed safely.");
      this.writeStateFileAtomically(state);
    }
    if (existsSync(this.stateFilePath)) {
      const { size } = assertRegularFileNoSymlink(this.stateFilePath, "state");
      if (size > 2 * 1024 * 1024) throw createReplicaError("STORAGE_WRITE_FAILED", "Receiver state exceeds its byte budget.");
      let raw: any;
      try { raw = JSON.parse(readFileSync(this.stateFilePath, "utf8")); } catch { throw createReplicaError("STORAGE_WRITE_FAILED", "Receiver state is unreadable."); }
      const invalid = () => { throw createReplicaError("STORAGE_WRITE_FAILED", "Receiver state structure or signed record is invalid."); };
      const exactKeys = (value: object, keys: string[]) => Object.keys(value).length === keys.length && Object.keys(value).every(k => keys.includes(k));
      const stateKeys = ["formatVersion", "producerId", "accountId", "ownerUserId", "epoch", "schemaVersion", "schemaHash", "verificationKeyFingerprint", "keyId", "bindingHighwaters", "highwaterSequence", "activeGenerationId", "lastGoodGenerationId", "acceptedBySequence"];
      const recordKeys = ["generationId", "producerId", "accountId", "ownerUserId", "epoch", "sequence", "dbSha256", "manifestSha256", "bundleDirName", "receivedAt", "receivedAtMs", "manifest", "retainedOnDisk"];
      if (!raw || typeof raw !== "object" || !exactKeys(raw, stateKeys) || [raw.producerId, raw.accountId, raw.keyId, raw.schemaVersion].some(v => typeof v !== "string" || !v.trim() || v.length > 256) || typeof raw.ownerUserId !== "string" || raw.ownerUserId !== raw.ownerUserId.toLowerCase()) invalid();

      if (!raw || raw.formatVersion !== STATE_FORMAT_VERSION || typeof raw.producerId !== "string" || typeof raw.accountId !== "string" || typeof raw.ownerUserId !== "string" || !isValidUuid(raw.ownerUserId) || !Number.isSafeInteger(raw.epoch) || raw.epoch < 1 || !Number.isSafeInteger(raw.highwaterSequence) || raw.highwaterSequence < 0 || !/^[a-f0-9]{64}$/.test(raw.verificationKeyFingerprint ?? "") || typeof raw.keyId !== "string" || !raw.bindingHighwaters || typeof raw.bindingHighwaters !== "object" || Array.isArray(raw.bindingHighwaters) || Object.keys(raw.bindingHighwaters).length > 64) invalid();
      for (const [binding, highwater] of Object.entries(raw.bindingHighwaters)) if (!/^[a-f0-9]{64}$/.test(binding) || !Number.isSafeInteger(highwater) || (highwater as number) < 0) invalid();
      if ((raw.bindingHighwaters[this.bindingId(raw)] ?? 0) !== raw.highwaterSequence) invalid();
      const sameBinding = raw.producerId === this.config.producerId && raw.accountId === this.config.accountId && raw.ownerUserId === this.config.ownerUserId && raw.epoch === this.config.epoch && raw.verificationKeyFingerprint === this.verificationKeyFingerprint && raw.keyId === this.pinnedKeyId && raw.schemaVersion === this.expectedSchemaVersion && raw.schemaHash === this.expectedSchemaHash;
      if (!sameBinding) {
        if (!this.config.allowAccountTransition) throw createReplicaError("ACCOUNT_TRANSITION_REQUIRED", "Explicit key, account, owner, producer, schema or epoch transition is required.");
        if (Object.keys(raw.bindingHighwaters).length >= 64 && !(this.bindingId() in raw.bindingHighwaters)) throw createReplicaError("STORAGE_BUDGET_EXCEEDED", "Binding history is full; explicit storage migration is required.");
        state = { ...state, bindingHighwaters: raw.bindingHighwaters, highwaterSequence: raw.bindingHighwaters[this.bindingId()] ?? 0 };
        // Commit isolation first. A failure after rename never retires potentially referenced data.
        this.writeStateFileAtomically(state);
      } else {
        if (!raw.acceptedBySequence || typeof raw.acceptedBySequence !== "object" || Array.isArray(raw.acceptedBySequence) || Object.keys(raw.acceptedBySequence).length > 256) invalid();
        for (const [seq, rec] of Object.entries(raw.acceptedBySequence) as [string, any][]) {
          if (!rec || typeof rec !== "object" || !exactKeys(rec, recordKeys) || String(rec.sequence) !== seq || !Number.isSafeInteger(rec.sequence) || rec.sequence < 1 || rec.sequence > raw.highwaterSequence || rec.retainedOnDisk !== true || typeof rec.bundleDirName !== "string" || !/^gen-e[1-9][0-9]{0,15}-s[1-9][0-9]{0,15}-[a-f0-9]{12}$/.test(rec.bundleDirName) || rec.generationId !== rec.bundleDirName || !Number.isSafeInteger(rec.receivedAtMs) || rec.receivedAtMs < 0 || typeof rec.receivedAt !== "string" || new Date(rec.receivedAtMs).toISOString() !== rec.receivedAt) invalid();
          const manifest = parseReplicaManifestJson(JSON.stringify(rec.manifest));
          verifyManifestSignatureAndClaims({ ...this.verificationOptions(""), manifest, checkFutureAgainstNow: false });
          rec.manifest = manifest;
          Object.freeze(rec);
          if (manifest.sequence !== rec.sequence || manifest.epoch !== rec.epoch || manifest.producerId !== rec.producerId || manifest.accountId !== rec.accountId || manifest.ownerUserId !== rec.ownerUserId || rec.dbSha256 !== manifest.dbSha256 || rec.manifestSha256 !== computeManifestSha256(manifest) || rec.generationId !== this.generationId(manifest)) invalid();
        }
        for (const pointer of [raw.activeGenerationId, raw.lastGoodGenerationId]) if (pointer !== null && (typeof pointer !== "string" || !Object.values(raw.acceptedBySequence).some((r: any) => r.generationId === pointer))) invalid();
        if (raw.activeGenerationId !== null && !Object.values(raw.acceptedBySequence).some((r: any) => r.generationId === raw.activeGenerationId && r.sequence === raw.highwaterSequence)) invalid();
        state = raw;
      }
    }
    const committed = new Set(Object.values(state.acceptedBySequence).map(r => r.bundleDirName));
    for (const dir of [this.stagingDir, this.generationsDir]) for (const entry of readdirSync(dir)) {
      if (dir === this.generationsDir && committed.has(entry)) continue;
      retirePath(join(dir, entry), this.trashDir);
    }
    return state;
  }

  private generationId(manifest: import("./types.js").ReplicaManifest): string {
    return `gen-e${manifest.epoch}-s${manifest.sequence}-${manifest.dbSha256.slice(0, 12)}`;
  }
  private verificationOptions(bundleDir: string): VerifyReplicaBundleOptions {
    return { bundleDir, trustedPublicKey: this.config.publicKey, expectedKeyId: this.pinnedKeyId, expectedProducerId: this.config.producerId, expectedAccountId: this.config.accountId, expectedOwnerUserId: this.config.ownerUserId, operatorOwnerOverride: this.config.operatorOwnerOverride, expectedEpoch: this.config.epoch, expectedSchemaVersion: this.expectedSchemaVersion, expectedSchemaHash: this.expectedSchemaHash, limits: this.config.limits, now: this.config.now };
  }

  private writeStateFileAtomically(nextState: PersistedReceiverState): void {
    assertSqliteBudget();
    const tmpPath = join(
      this.stagingDir,
      `state.json.tmp.${Date.now()}-${randomUUID()}`
    );
    const pathsToRedact = [this.stateRootDir, this.stateFilePath, tmpPath];

    let renamed = false;
    try {
      this.validateStore();
      this.config.faultHooks?.beforeCommitStateFile?.(tmpPath);
      const serialized = `${JSON.stringify(nextState)}\n`;
      if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) throw createReplicaError("STORAGE_BUDGET_EXCEEDED", "Receiver state byte budget exceeded.");
      writeFileSync(tmpPath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
      flushPath(tmpPath, this.config.faultHooks?.onFsync, "state-temp-file");
      flushPath(this.stagingDir, this.config.faultHooks?.onFsync, "state-staging-dir");
      renameSync(tmpPath, this.stateFilePath);
      renamed = true;
      this.config.faultHooks?.afterStateRename?.();
      flushPath(this.stateRootDir, this.config.faultHooks?.onFsync, "state-root-dir");
      flushPath(this.stagingDir, this.config.faultHooks?.onFsync, "state-source-dir");
    } catch (error) {
      if (renamed) {
        this.state = nextState;
        this.uncertain = true;
        throw createReplicaError("COMMIT_UNCERTAIN", "Receiver state was renamed but durability could not be confirmed; restart required.");
      }
      retirePath(tmpPath, this.trashDir);
      throw createReplicaError("STORAGE_WRITE_FAILED", "Receiver state could not be durably committed.");
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

    try {
      const verified = verifyReplicaBundle(this.verificationOptions(join(this.generationsDir, rec.bundleDirName)));
      return rec.retainedOnDisk && verified.manifestSha256 === rec.manifestSha256 && verified.manifest.dbSha256 === rec.dbSha256 && verified.manifest.sequence === rec.sequence && this.generationId(verified.manifest) === rec.generationId;
    } catch { return false; }
  }

  /**
   * Accepts a candidate replica bundle into the receiver store.
   * - Stages and fully verifies the bundle before publication.
   * - Idempotently acknowledges an identical resend of the current generation without resetting receive/capture age.
   * - Rejects conflicting sequence numbers (`CONFLICTING_SEQUENCE`) and stale sequence replays (`REPLAY_REJECTED`).
   * - Leaves accepted state intact on disk-full, partial transfer, or crash before state commit.
   */
  acceptBundle(sourceBundleDir: string): AcceptReplicaBundleResult {
    try { this.assertReady(); return this.acceptBundleInternal(sourceBundleDir); } catch (error) { throw publicReplicaError(error); }
  }
  private acceptBundleInternal(sourceBundleDir: string): AcceptReplicaBundleResult {
    const cleanSourceDir = assertSafeAbsolutePath(
      sourceBundleDir,
      "sourceBundleDir"
    );
    assertNoSymlinkChain(cleanSourceDir, "sourceBundleDir");
    assertExactBundle(cleanSourceDir);

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

    // Verify before allocating staging: identical resends do not accumulate full copies.
    const incoming = verifyReplicaBundle(this.verificationOptions(cleanSourceDir));
    const prior = this.state.acceptedBySequence[String(incoming.manifest.sequence)];
    if (prior && incoming.manifest.sequence === this.state.highwaterSequence && prior.manifestSha256 === incoming.manifestSha256) {
      if (!this.isGenerationHealthyOnDisk(prior)) throw createReplicaError("ACTIVE_GENERATION_DAMAGED", "Duplicate generation is damaged on disk.");
      return { status: "duplicate_acknowledged", generationId: prior.generationId, epoch: prior.epoch, sequence: prior.sequence, receivedAt: prior.receivedAt, receivedAtMs: prior.receivedAtMs, captureStartedAt: prior.manifest.captureStartedAt, captureCompletedAt: prior.manifest.captureCompletedAt, dbPath: join(this.generationsDir, prior.bundleDirName, REPLICA_DB_FILENAME), manifest: prior.manifest, highwaterSequence: this.state.highwaterSequence };
    }
    if (prior && prior.manifestSha256 !== incoming.manifestSha256) throw createReplicaError("CONFLICTING_SEQUENCE", "Sequence was previously accepted with different content.");
    if (incoming.manifest.sequence <= this.state.highwaterSequence) throw createReplicaError("REPLAY_REJECTED", "Sequence is not greater than the accepted highwater.");
    if (Object.keys(this.state.acceptedBySequence).length >= 256) throw createReplicaError("STORAGE_BUDGET_EXCEEDED", "Leased generation history is full; release requests before accepting more data.");
    measureStorage(this.stateRootDir, this.config.storageBudget, srcDbBytes + srcManifestBytes + 4 * 1024 * 1024, 16);
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
      flushPath(stagedDbPath, this.config.faultHooks?.onFsync, "bundle-db");
      flushPath(stagedManifestPath, this.config.faultHooks?.onFsync, "bundle-manifest");
      flushPath(stageDir, this.config.faultHooks?.onFsync, "bundle-stage-dir");

      assertVerifiedBundleUnchanged(verified);
      try {
        renameSync(stageDir, generationDir);
        publishedGenDir = generationDir;
        flushPath(this.generationsDir, this.config.faultHooks?.onFsync, "bundle-generations-dir");
        flushPath(this.stagingDir, this.config.faultHooks?.onFsync, "bundle-source-dir");
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
        bindingHighwaters: { ...this.state.bindingHighwaters, [this.bindingId()]: manifest.sequence },
        activeGenerationId: generationId,
        lastGoodGenerationId: nextLastGoodId,
        acceptedBySequence: {
          ...this.state.acceptedBySequence,
          [seqKey]: newRecord,
        },
      };

      assertVerifiedBundleUnchanged({ ...verified, bundleDir: generationDir, dbPath: join(generationDir, REPLICA_DB_FILENAME), manifestPath: join(generationDir, REPLICA_MANIFEST_FILENAME) });
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
        !this.uncertain &&
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
    try { return this.acquireLeaseInternal(); } catch (error) { throw publicReplicaError(error); }
  }
  private acquireLeaseInternal(): ReplicaLease {
    this.assertReady();
    if (this.getActiveLeaseCount() >= 1024) throw createReplicaError("STORAGE_BUDGET_EXCEEDED", "Replica lease budget exceeded.");
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
        this.assertReady();
        try { return new DatabaseSync(dbPath, { readOnly: true, allowExtension: false }); }
        catch (error) { throw publicReplicaError(error); }
      },
      computeFreshness: (opts) => {
        if (released) throw createReplicaError("INVALID_CONFIG", "Cannot use a released replica lease.");
        this.assertReady();
        return buildReplicaFreshnessMetadata({
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
        });
      },
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

    try { assertSqliteBudget(); } catch (error) { lease.release(); throw error; }
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
    try { return this.cleanupOldGenerationsInternal(); } catch (error) { throw publicReplicaError(error); }
  }
  private cleanupOldGenerationsInternal(): string[] {
    this.assertReady();
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
      delete updatedMap[String(rec.sequence)];
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
