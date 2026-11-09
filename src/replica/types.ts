import type { KeyObject } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { OwnerIdentity } from "../services/database.js";
import type { FreshnessMetadata, NowInput } from "../services/freshness.js";

export type ReplicaTableName =
  | "Airline"
  | "Airport"
  | "Connection"
  | "Flight"
  | "ManualFlight"
  | "Profile"
  | "SyncInfo"
  | "Ticket"
  | "UserFlight"
  | "UserManualFlight";

export type ReplicaColumnAffinity = "TEXT" | "INTEGER" | "REAL" | "ANY";

export interface ReplicaColumnSpec {
  readonly name: string;
  readonly affinity: ReplicaColumnAffinity;
  /** SQLite declared type in CREATE TABLE DDL (empty string for untyped ANY column). */
  readonly declType: string;
}

export interface ReplicaTableSpec {
  readonly name: ReplicaTableName;
  readonly columns: readonly ReplicaColumnSpec[];
  readonly hasDeletedColumn: boolean;
}

export type ReplicaErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_PATH"
  | "MOUNT_UNAVAILABLE"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_SCHEMA_INVALID"
  | "SOURCE_READ_ERROR"
  | "BACKUP_FAILED"
  | "EXPORT_BOUNDS_EXCEEDED"
  | "OUTPUT_EXISTS"
  | "MANIFEST_INVALID"
  | "SIGNATURE_INVALID"
  | "KEY_MISMATCH"
  | "PRODUCER_MISMATCH"
  | "ACCOUNT_MISMATCH"
  | "OWNER_MISMATCH"
  | "EPOCH_MISMATCH"
  | "SCHEMA_MISMATCH"
  | "CAPTURE_INTERVAL_INVALID"
  | "DB_MISSING"
  | "DB_SIDECAR_FORBIDDEN"
  | "DB_SIZE_EXCEEDED"
  | "DB_DIGEST_MISMATCH"
  | "DB_INTEGRITY_FAILED"
  | "DB_SCHEMA_INVALID"
  | "DB_CONTENT_INVALID"
  | "CONFLICTING_SEQUENCE"
  | "REPLAY_REJECTED"
  | "ACCOUNT_TRANSITION_REQUIRED"
  | "NO_ACTIVE_GENERATION"
  | "ACTIVE_GENERATION_DAMAGED"
  | "STORAGE_WRITE_FAILED";

export class ReplicaError extends Error {
  readonly code: ReplicaErrorCode;

  constructor(code: ReplicaErrorCode, message: string) {
    super(message);
    this.name = "ReplicaError";
    this.code = code;
  }
}

export interface ReplicaManifest {
  readonly formatVersion: "flighty-replica-manifest-v1";
  readonly schemaVersion: string;
  readonly schemaHash: string;
  readonly producerId: string;
  readonly accountId: string;
  readonly ownerUserId: string;
  readonly ownerLabel: "replica_producer_owner";
  readonly includeSharedPassengers: boolean;
  readonly epoch: number;
  readonly sequence: number;
  readonly captureStartedAt: string;
  readonly captureCompletedAt: string;
  readonly dbFileName: "replica.db";
  readonly dbBytes: number;
  readonly dbSha256: string;
  readonly rowCounts: Readonly<Record<ReplicaTableName, number>>;
  readonly keyId: string;
  readonly signatureAlgorithm: "ed25519";
  readonly signature: string;
}

export interface ReplicaValidationLimits {
  readonly maxDbBytes?: number;
  readonly maxRowsPerTable?: number;
  readonly maxTotalRows?: number;
  readonly maxStringLength?: number;
  readonly maxCaptureDurationMs?: number;
  readonly maxFutureSkewMs?: number;
}

export type MountCheckFn = (params: {
  requiredMountPath: string;
  sourceDbPath: string;
  outputDir: string;
}) => boolean;

export type CleanupPathFn = (targetPath: string) => void;

export interface ExportReplicaBundleOptions {
  /** Explicit absolute path to source SQLite database. Never defaults to real app path. */
  readonly sourceDbPath: string;
  /** Explicit absolute path to target bundle directory (must not exist or must be empty). */
  readonly outputBundleDir: string;
  /** Optional explicit staging root directory (defaults to parent of outputBundleDir). */
  readonly stagingRootDir?: string;
  /** Required mounted volume root (e.g. "/Volumes/PRO-G40"). Mandatory check before export. */
  readonly requiredMountPath: string;
  /** Injectable mount/source check for synthetic tests. */
  readonly mountCheck?: MountCheckFn;
  /** Explicit producer identifier (e.g. "imac-flighty-exporter"). */
  readonly producerId: string;
  /** Explicit account identifier. */
  readonly accountId: string;
  /** Explicit declared owner userId (UUID). Never discovered via tokens or frequency fallback. */
  readonly ownerUserId: string;
  /** Whether to include cached shared passenger rows (userId != ownerUserId && isMyFlight == 1). Default true. */
  readonly includeSharedPassengers?: boolean;
  /** Explicit positive integer epoch (>= 1). */
  readonly epoch: number;
  /** Explicit monotonic sequence number (>= 1). */
  readonly sequence: number;
  /** Ed25519 private key in PEM string or crypto KeyObject format. */
  readonly signingPrivateKey: string | KeyObject;
  /** Optional explicit keyId; if omitted, derived from the public key SPKI SHA-256 fingerprint. */
  readonly keyId?: string;
  /** Optional explicit capture start time (Date, ms, or ISO string) for deterministic tests. */
  readonly captureStartedAt?: Date | number | string;
  /** Optional explicit capture end time (Date, ms, or ISO string) for deterministic tests. */
  readonly captureCompletedAt?: Date | number | string;
  /** Optional validation/export size and row limits. */
  readonly limits?: ReplicaValidationLimits;
  /** Optional injectable safe cleanup handler (defaults to trash / quarantine). */
  readonly cleanupPath?: CleanupPathFn;
  /**
   * Optional test hook invoked after the SQLite backup completes and before reading from the backup.
   * Useful for deterministic concurrent writer tests.
   */
  readonly onAfterBackup?: (info: { totalPages: number }) => void | Promise<void>;
}

export interface ExportReplicaBundleResult {
  readonly bundleDir: string;
  readonly dbPath: string;
  readonly manifestPath: string;
  readonly manifest: ReplicaManifest;
  readonly backupPagesTransferred: number;
}

export interface VerifyReplicaBundleOptions {
  readonly bundleDir: string;
  readonly trustedPublicKey: string | KeyObject;
  readonly expectedKeyId?: string;
  readonly expectedProducerId: string;
  readonly expectedAccountId: string;
  readonly expectedOwnerUserId: string;
  readonly operatorOwnerOverride?: string | null;
  readonly expectedEpoch: number;
  readonly expectedSchemaVersion?: string;
  readonly expectedSchemaHash?: string;
  readonly limits?: ReplicaValidationLimits;
  readonly now?: NowInput;
}

export interface VerifiedReplicaBundle {
  readonly bundleDir: string;
  readonly dbPath: string;
  readonly manifestPath: string;
  readonly manifest: ReplicaManifest;
  readonly manifestSha256: string;
}

export interface ReplicaReceiverFaultHooks {
  /** Called while staging incoming bundle files (can throw ENOSPC or simulated crash). */
  readonly onStageWrite?: (stageDir: string) => void;
  /** Called after verification in staging, before moving bundle into generations/. */
  readonly beforePublishBundle?: (stageDir: string, generationId: string) => void;
  /** Called after moving bundle into generations/, before committing state.json. */
  readonly afterPublishBundleBeforeStateCommit?: (
    generationDir: string,
    generationId: string
  ) => void;
  /** Called right before renaming state.json.tmp to state.json (can throw ENOSPC). */
  readonly beforeCommitStateFile?: (tempStatePath: string) => void;
}

export interface ReplicaReceiverConfig {
  /** Explicit absolute directory where receiver stores generations/, staging/, state.json, .trash/. */
  readonly stateRootDir: string;
  /** Pinned Ed25519 public key (PEM or KeyObject). Required; no TOFU. */
  readonly publicKey: string | KeyObject;
  /** Optional pinned keyId; if omitted, derived from publicKey SPKI SHA-256. */
  readonly expectedKeyId?: string;
  /** Pinned producer identifier. */
  readonly producerId: string;
  /** Pinned account identifier. */
  readonly accountId: string;
  /** Pinned owner userId (UUID). */
  readonly ownerUserId: string;
  /** Optional operator owner override (e.g. FLIGHTY_OWNER_USER_ID); must match ownerUserId if set. */
  readonly operatorOwnerOverride?: string | null;
  /** Pinned positive integer epoch. */
  readonly epoch: number;
  /** Expected schema version (defaults to REPLICA_SCHEMA_VERSION). */
  readonly schemaVersion?: string;
  /** Expected schema hash (defaults to REPLICA_SCHEMA_HASH). */
  readonly schemaHash?: string;
  /** Explicit opt-in required when transitioning stateRootDir to a new account/owner/producer/epoch. */
  readonly allowAccountTransition?: boolean;
  /** Whether to allow explicit stale recovery from verified same-account lastGood if active DB is damaged. Default true. */
  readonly allowStaleRecovery?: boolean;
  /** Maximum retained generations on disk (minimum 2: active + lastGood, plus any leased). Default 2. */
  readonly maxRetainedGenerations?: number;
  /** Validation limits for bytes, rows, capture interval, etc. */
  readonly limits?: ReplicaValidationLimits;
  /** Injectable clock for deterministic testing. */
  readonly now?: NowInput;
  /** Injectable safe cleanup handler (defaults to trash / .trash quarantine). */
  readonly cleanupPath?: CleanupPathFn;
  /** Optional fault-injection hooks for crash/ENOSPC testing. */
  readonly faultHooks?: ReplicaReceiverFaultHooks;
}

export interface AcceptedGenerationRecord {
  readonly generationId: string;
  readonly producerId: string;
  readonly accountId: string;
  readonly ownerUserId: string;
  readonly epoch: number;
  readonly sequence: number;
  readonly dbSha256: string;
  readonly manifestSha256: string;
  readonly bundleDirName: string;
  readonly receivedAt: string;
  readonly receivedAtMs: number;
  readonly manifest: ReplicaManifest;
  /** True if the bundle files are still retained under generations/<bundleDirName>. */
  readonly retainedOnDisk: boolean;
}

export interface PersistedReceiverState {
  readonly formatVersion: "flighty-replica-state-v1";
  readonly producerId: string;
  readonly accountId: string;
  readonly ownerUserId: string;
  readonly epoch: number;
  readonly schemaVersion: string;
  readonly schemaHash: string;
  readonly highwaterSequence: number;
  readonly activeGenerationId: string | null;
  readonly lastGoodGenerationId: string | null;
  readonly acceptedBySequence: Readonly<Record<string, AcceptedGenerationRecord>>;
}

export interface AcceptReplicaBundleResult {
  readonly status: "accepted" | "duplicate_acknowledged";
  readonly generationId: string;
  readonly epoch: number;
  readonly sequence: number;
  readonly receivedAt: string;
  readonly receivedAtMs: number;
  readonly captureStartedAt: string;
  readonly captureCompletedAt: string;
  readonly dbPath: string;
  readonly manifest: ReplicaManifest;
  readonly highwaterSequence: number;
}

export interface ReplicaOwnerProvenance extends OwnerIdentity {
  readonly producerId: string;
  readonly accountId: string;
  readonly epoch: number;
  readonly sequence: number;
  readonly generationId: string;
  readonly keyId: string;
}

export interface ReplicaFreshnessMetadata {
  readonly queried_at: string;
  readonly capture_started_at: string;
  readonly capture_completed_at: string;
  readonly snapshot_created_at: string;
  readonly capture_duration_ms: number;
  readonly replica_received_at: string;
  /** Conservative copy age in whole seconds measured from capture_started_at to queried_at (null if future skew). */
  readonly snapshot_age_seconds: number | null;
  /** Conservative copy age in minutes (rounded to 2 decimal places) measured from capture_started_at. */
  readonly snapshot_age_minutes: number | null;
  /** Age in whole seconds from capture_completed_at to queried_at (null if future skew). */
  readonly capture_completion_age_seconds: number | null;
  /** Age in whole seconds since this replica bundle was first accepted by the receiver (null if future skew). */
  readonly replica_receive_age_seconds: number | null;
  readonly is_future_capture: boolean;
  readonly generation_id: string;
  readonly epoch: number;
  readonly sequence: number;
  readonly producer_id: string;
  readonly account_id: string;
  readonly owner_user_id: string;
  readonly is_stale_recovery: boolean;
  readonly recovery_reason: string | null;
  readonly replica_note: string;
  /** Underlying Flighty database sync freshness (from SyncInfo.lastSync; numeric remains unverified). */
  readonly app_sync: FreshnessMetadata;
}

export interface ReplicaLease {
  readonly leaseId: string;
  readonly generationId: string;
  readonly epoch: number;
  readonly sequence: number;
  readonly dbPath: string;
  readonly bundleDir: string;
  readonly manifest: ReplicaManifest;
  readonly receivedAt: string;
  readonly receivedAtMs: number;
  readonly ownerIdentity: ReplicaOwnerProvenance;
  readonly isStaleRecovery: boolean;
  readonly recoveryReason: string | null;
  readonly isReleased: () => boolean;
  /** Opens a new read-only DatabaseSync handle against the pinned generation's replica.db. */
  readonly openDatabase: () => DatabaseSync;
  /** Computes combined replica capture/receive freshness + app SyncInfo.lastSync freshness for the pinned generation. */
  readonly computeFreshness: (options?: {
    now?: NowInput;
    toolName?: string;
    isError?: boolean;
  }) => ReplicaFreshnessMetadata;
  /** Idempotently releases this lease so old superseded generations can be retired. */
  readonly release: () => void;
}
