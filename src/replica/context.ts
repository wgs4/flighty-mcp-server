import { AsyncLocalStorage } from "node:async_hooks";
import {
  readDatabaseFreshness,
  resolveNowMs,
  type NowInput,
} from "../services/freshness.js";
import type {
  ReplicaFreshnessMetadata,
  ReplicaLease,
  ReplicaManifest,
  ReplicaOwnerProvenance,
} from "./types.js";

export const REPLICA_ACTIVE_NOTE =
  "Reads come from a verified immutable SQLite replica generation on disk. Capture interval age (snapshot_age_seconds) is separate from Flighty app sync state (app_sync).";

export const REPLICA_STALE_RECOVERY_NOTE =
  "STALE RECOVERY: Active replica generation was unavailable or damaged; serving previously verified same-account last-good generation without resetting highwater sequence or receive age.";

export const REPLICA_OWNER_PROVENANCE_NOTE =
  "Owner identity is pinned from verified replica producer manifest provenance (producer-labelled export scope, not a live Mac auth token check).";

const replicaLeaseStorage = new AsyncLocalStorage<ReplicaLease>();

export function buildReplicaOwnerIdentity(
  manifest: ReplicaManifest,
  generationId: string
): ReplicaOwnerProvenance {
  return Object.freeze({
    userId: manifest.ownerUserId,
    source: "replica_producer",
    label: "replica_export_scope",
    isFallback: false,
    isSharedOwner: false,
    warning: REPLICA_OWNER_PROVENANCE_NOTE,
    producerId: manifest.producerId,
    accountId: manifest.accountId,
    epoch: manifest.epoch,
    sequence: manifest.sequence,
    generationId,
    keyId: manifest.keyId,
  });
}

export function buildReplicaFreshnessMetadata(params: {
  manifest: ReplicaManifest;
  generationId: string;
  dbPath: string;
  receivedAt: string;
  receivedAtMs: number;
  isStaleRecovery: boolean;
  recoveryReason: string | null;
  now?: NowInput;
  toolName?: string;
  isError?: boolean;
}): ReplicaFreshnessMetadata {
  const nowMs = resolveNowMs(params.now);
  const queriedAt = new Date(nowMs).toISOString();
  const { manifest } = params;

  const startMs = Date.parse(manifest.captureStartedAt);
  const endMs = Date.parse(manifest.captureCompletedAt);
  const captureDurationMs = Math.max(0, endMs - startMs);

  const isFutureCapture = startMs > nowMs || endMs > nowMs;
  const snapshotAgeSeconds = isFutureCapture
    ? null
    : Math.floor((nowMs - startMs) / 1000);
  const snapshotAgeMinutes = isFutureCapture
    ? null
    : Math.round(((nowMs - startMs) / 60000) * 100) / 100;
  const captureCompletionAgeSeconds = isFutureCapture
    ? null
    : Math.floor((nowMs - endMs) / 1000);

  const replicaReceiveAgeSeconds =
    params.receivedAtMs > nowMs
      ? null
      : Math.floor((nowMs - params.receivedAtMs) / 1000);

  const appSync = readDatabaseFreshness({
    dbPath: params.dbPath,
    now: nowMs,
    toolName: params.toolName,
    isError: params.isError,
  });

  return Object.freeze({
    queried_at: queriedAt,
    capture_started_at: manifest.captureStartedAt,
    capture_completed_at: manifest.captureCompletedAt,
    snapshot_created_at: manifest.captureCompletedAt,
    capture_duration_ms: captureDurationMs,
    replica_received_at: params.receivedAt,
    snapshot_age_seconds: snapshotAgeSeconds,
    snapshot_age_minutes: snapshotAgeMinutes,
    capture_completion_age_seconds: captureCompletionAgeSeconds,
    replica_receive_age_seconds: replicaReceiveAgeSeconds,
    is_future_capture: isFutureCapture,
    generation_id: params.generationId,
    epoch: manifest.epoch,
    sequence: manifest.sequence,
    producer_id: manifest.producerId,
    account_id: manifest.accountId,
    owner_user_id: manifest.ownerUserId,
    is_stale_recovery: params.isStaleRecovery,
    recovery_reason: params.recoveryReason,
    replica_note: params.isStaleRecovery
      ? REPLICA_STALE_RECOVERY_NOTE
      : REPLICA_ACTIVE_NOTE,
    app_sync: appSync,
  });
}

export function runWithReplicaLeaseContext<T>(
  lease: ReplicaLease,
  fn: () => T
): T {
  return replicaLeaseStorage.run(lease, fn);
}

export function getActiveReplicaLease(): ReplicaLease | null {
  return replicaLeaseStorage.getStore() ?? null;
}

export interface ActiveReplicaContextSnapshot {
  readonly lease: ReplicaLease;
  readonly generationId: string;
  readonly epoch: number;
  readonly sequence: number;
  readonly dbPath: string;
  readonly manifest: ReplicaManifest;
  readonly receivedAt: string;
  readonly receivedAtMs: number;
  readonly ownerIdentity: ReplicaOwnerProvenance;
  readonly isStaleRecovery: boolean;
  readonly recoveryReason: string | null;
  readonly computeFreshness: ReplicaLease["computeFreshness"];
}

export function getActiveReplicaContext(): ActiveReplicaContextSnapshot | null {
  const lease = replicaLeaseStorage.getStore();
  if (!lease) {
    return null;
  }
  return {
    lease,
    generationId: lease.generationId,
    epoch: lease.epoch,
    sequence: lease.sequence,
    dbPath: lease.dbPath,
    manifest: lease.manifest,
    receivedAt: lease.receivedAt,
    receivedAtMs: lease.receivedAtMs,
    ownerIdentity: lease.ownerIdentity,
    isStaleRecovery: lease.isStaleRecovery,
    recoveryReason: lease.recoveryReason,
    computeFreshness: lease.computeFreshness,
  };
}

export function getActiveReplicaDbPath(): string | null {
  return replicaLeaseStorage.getStore()?.dbPath ?? null;
}

export function getActiveReplicaOwnerIdentity(): ReplicaOwnerProvenance | null {
  return replicaLeaseStorage.getStore()?.ownerIdentity ?? null;
}

export function getActiveReplicaFreshness(options?: {
  now?: NowInput;
  toolName?: string;
  isError?: boolean;
}): ReplicaFreshnessMetadata | null {
  const lease = replicaLeaseStorage.getStore();
  if (!lease) {
    return null;
  }
  return lease.computeFreshness(options);
}
