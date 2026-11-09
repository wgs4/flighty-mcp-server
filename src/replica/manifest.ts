import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { resolveNowMs, type NowInput } from "../services/freshness.js";
import { isValidUuid } from "../services/validation.js";
import { createReplicaError } from "./cleanup.js";
import {
  DEFAULT_MAX_CAPTURE_DURATION_MS,
  DEFAULT_MAX_DB_BYTES,
  DEFAULT_MAX_FUTURE_SKEW_MS,
  REPLICA_SCHEMA_HASH,
  REPLICA_SCHEMA_VERSION,
  REPLICA_TABLE_NAMES,
} from "./schema.js";
import type {
  ReplicaManifest,
  ReplicaTableName,
  ReplicaValidationLimits,
} from "./types.js";

export const REPLICA_MANIFEST_FORMAT_VERSION = "flighty-replica-manifest-v1";
export const REPLICA_SIGNING_DOMAIN = "FLIGHTY_REPLICA_MANIFEST_V1";
export const REPLICA_DB_FILENAME = "replica.db";
export const REPLICA_MANIFEST_FILENAME = "manifest.json";

const STRICT_UTC_ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function computeBufferSha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function computeFileSha256(filePath: string): {
  sha256: string;
  bytes: number;
} {
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    const fd = openSync(filePath, "r");
    let bytes = 0;
    try { for (;;) { const count = readSync(fd, buffer, 0, buffer.length, null); if (!count) break; bytes += count; hash.update(buffer.subarray(0, count)); } }
    finally { closeSync(fd); }
    return { sha256: hash.digest("hex"), bytes };
  } catch { throw createReplicaError("STORAGE_WRITE_FAILED", "Could not hash replica file."); }
}

export function normalizeEd25519PrivateKey(
  input: string | KeyObject
): KeyObject {
  try {
    const keyObj =
      typeof input === "string" ? createPrivateKey(input) : input;
    if (
      !keyObj ||
      keyObj.type !== "private" ||
      keyObj.asymmetricKeyType !== "ed25519"
    ) {
      throw new Error("Expected an Ed25519 private key.");
    }
    return keyObj;
  } catch {
    throw createReplicaError(
      "INVALID_CONFIG",
      "Invalid signingPrivateKey: expected a valid Ed25519 private key."
    );
  }
}

export function normalizeEd25519PublicKey(
  input: string | KeyObject
): KeyObject {
  try {
    const keyObj =
      typeof input === "string" ? createPublicKey(input) : input;
    if (
      !keyObj ||
      keyObj.type !== "public" ||
      keyObj.asymmetricKeyType !== "ed25519"
    ) {
      throw new Error("Expected an Ed25519 public key.");
    }
    return keyObj;
  } catch {
    throw createReplicaError(
      "INVALID_CONFIG",
      "Invalid trusted public key: expected an explicit pinned Ed25519 public key (no TOFU)."
    );
  }
}

export function computePublicKeyId(publicKeyInput: string | KeyObject): string {
  const pubKey = normalizeEd25519PublicKey(publicKeyInput);
  const spkiDer = pubKey.export({ type: "spki", format: "der" });
  const digest = createHash("sha256")
    .update(spkiDer)
    .digest("hex")
    .slice(0, 32);
  return `ed25519-sha256:${digest}`;
}

export function deriveKeyIdFromPrivateKey(
  privateKeyInput: string | KeyObject
): string {
  const privKey = normalizeEd25519PrivateKey(privateKeyInput);
  const pubKey = createPublicKey(privKey);
  return computePublicKeyId(pubKey);
}

export function normalizeTimestampToUtcIso(
  value: Date | number | string,
  fieldLabel: string
): { iso: string; ms: number } {
  let ms: number;
  if (value instanceof Date) {
    ms = value.getTime();
  } else if (typeof value === "number") {
    ms = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!STRICT_UTC_ISO_PATTERN.test(trimmed)) {
      throw createReplicaError(
        "CAPTURE_INTERVAL_INVALID",
        `Invalid ${fieldLabel}: expected strict UTC ISO-8601 timestamp ending in Z.`
      );
    }
    ms = Date.parse(trimmed);
  } else {
    throw createReplicaError(
      "CAPTURE_INTERVAL_INVALID",
      `Invalid ${fieldLabel}: unsupported timestamp type.`
    );
  }

  if (!Number.isFinite(ms) || ms <= 0) {
    throw createReplicaError(
      "CAPTURE_INTERVAL_INVALID",
      `Invalid ${fieldLabel}: timestamp is not a valid positive epoch time.`
    );
  }

  const iso = new Date(ms).toISOString();
  return { iso, ms: Date.parse(iso) };
}

export function validateCaptureInterval(params: {
  captureStartedAt: string;
  captureCompletedAt: string;
  now?: NowInput;
  limits?: ReplicaValidationLimits;
  checkFutureAgainstNow?: boolean;
}): { startMs: number; endMs: number; durationMs: number } {
  const start = normalizeTimestampToUtcIso(
    params.captureStartedAt,
    "captureStartedAt"
  );
  const end = normalizeTimestampToUtcIso(
    params.captureCompletedAt,
    "captureCompletedAt"
  );

  if (end.ms < start.ms) {
    throw createReplicaError(
      "CAPTURE_INTERVAL_INVALID",
      "Invalid capture interval: captureCompletedAt is earlier than captureStartedAt."
    );
  }

  const durationMs = end.ms - start.ms;
  const maxDurationMs =
    params.limits?.maxCaptureDurationMs ?? DEFAULT_MAX_CAPTURE_DURATION_MS;
  if (durationMs > maxDurationMs) {
    throw createReplicaError(
      "CAPTURE_INTERVAL_INVALID",
      `Invalid capture interval: duration (${durationMs}ms) exceeds maximum allowed (${maxDurationMs}ms).`
    );
  }

  if (params.checkFutureAgainstNow !== false) {
    const nowMs = resolveNowMs(params.now);
    const maxFutureSkewMs =
      params.limits?.maxFutureSkewMs ?? DEFAULT_MAX_FUTURE_SKEW_MS;
    if (
      start.ms > nowMs + maxFutureSkewMs ||
      end.ms > nowMs + maxFutureSkewMs
    ) {
      throw createReplicaError(
        "CAPTURE_INTERVAL_INVALID",
        "Capture interval lies in the future relative to receiver clock; rejecting future capture timestamp."
      );
    }
  }

  return {
    startMs: start.ms,
    endMs: end.ms,
    durationMs,
  };
}

export type UnsignedReplicaManifest = Omit<ReplicaManifest, "signature">;

/**
 * Produces a deterministic, canonical JSON string over all manifest fields except `signature`,
 * prefixed with the domain separator `FLIGHTY_REPLICA_MANIFEST_V1\n`.
 */
export function buildCanonicalSigningPayload(
  manifest: UnsignedReplicaManifest | ReplicaManifest
): string {
  const orderedRowCounts: Record<string, number> = {};
  for (const table of REPLICA_TABLE_NAMES) {
    orderedRowCounts[table] = manifest.rowCounts[table];
  }

  const canonicalObj = {
    formatVersion: manifest.formatVersion,
    schemaVersion: manifest.schemaVersion,
    schemaHash: manifest.schemaHash,
    producerId: manifest.producerId,
    accountId: manifest.accountId,
    ownerUserId: manifest.ownerUserId,
    ownerLabel: manifest.ownerLabel,
    includeSharedPassengers: manifest.includeSharedPassengers,
    epoch: manifest.epoch,
    sequence: manifest.sequence,
    captureStartedAt: manifest.captureStartedAt,
    captureCompletedAt: manifest.captureCompletedAt,
    dbFileName: manifest.dbFileName,
    dbBytes: manifest.dbBytes,
    dbSha256: manifest.dbSha256,
    rowCounts: orderedRowCounts,
    keyId: manifest.keyId,
    signatureAlgorithm: manifest.signatureAlgorithm,
  };

  return `${REPLICA_SIGNING_DOMAIN}\n${JSON.stringify(canonicalObj)}`;
}

export function computeManifestSha256(manifest: ReplicaManifest): string {
  const payload = `${buildCanonicalSigningPayload(manifest)}\n${manifest.signature}`;
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export function signReplicaManifest(
  unsignedManifest: UnsignedReplicaManifest,
  privateKeyInput: string | KeyObject
): ReplicaManifest {
  const privKey = normalizeEd25519PrivateKey(privateKeyInput);
  const payload = buildCanonicalSigningPayload(unsignedManifest);
  const signatureBytes = cryptoSign(
    null,
    Buffer.from(payload, "utf8"),
    privKey
  );
  return Object.freeze({
    ...unsignedManifest,
    rowCounts: Object.freeze({ ...unsignedManifest.rowCounts }),
    signature: signatureBytes.toString("base64url"),
  });
}

export function parseReplicaManifestJson(rawJson: string): ReplicaManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw createReplicaError(
      "MANIFEST_INVALID",
      "Replica manifest is not valid JSON."
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw createReplicaError(
      "MANIFEST_INVALID",
      "Replica manifest must be a JSON object."
    );
  }

  const m = parsed as Record<string, unknown>;
  const fields = ["formatVersion", "schemaVersion", "schemaHash", "producerId", "accountId", "ownerUserId", "ownerLabel", "includeSharedPassengers", "epoch", "sequence", "captureStartedAt", "captureCompletedAt", "dbFileName", "dbBytes", "dbSha256", "rowCounts", "keyId", "signatureAlgorithm", "signature"];
  if (Object.keys(m).length !== fields.length || Object.keys(m).some(k => !fields.includes(k)) || [m.producerId, m.accountId, m.keyId, m.schemaVersion].some(v => typeof v !== "string" || v.length > 256)) throw createReplicaError("MANIFEST_INVALID", "Manifest fields or claim lengths are invalid.");

  if (m.formatVersion !== REPLICA_MANIFEST_FORMAT_VERSION) {
    throw createReplicaError(
      "MANIFEST_INVALID",
      `Unsupported replica manifest formatVersion.`
    );
  }
  if (typeof m.schemaVersion !== "string" || !m.schemaVersion.trim()) {
    throw createReplicaError(
      "MANIFEST_INVALID",
      "Manifest schemaVersion is missing or invalid."
    );
  }
  if (
    typeof m.schemaHash !== "string" ||
    !SHA256_HEX_PATTERN.test(m.schemaHash)
  ) {
    throw createReplicaError(
      "MANIFEST_INVALID",
      "Manifest schemaHash must be a 64-character lowercase hex SHA-256 digest."
    );
  }
  if (typeof m.producerId !== "string" || !m.producerId.trim()) {
    throw createReplicaError(
      "MANIFEST_INVALID",
      "Manifest producerId is missing or empty."
    );
  }
  if (typeof m.accountId !== "string" || !m.accountId.trim()) {
    throw createReplicaError(
      "MANIFEST_INVALID",
      "Manifest accountId is missing or empty."
    );
  }
  if (typeof m.ownerUserId !== "string" || !isValidUuid(m.ownerUserId) || m.ownerUserId !== m.ownerUserId.toLowerCase()) {
    throw createReplicaError(
      "MANIFEST_INVALID",
      "Manifest ownerUserId must be a valid UUID."
    );
  }
  if (m.ownerLabel !== "replica_producer_owner") {
    throw createReplicaError(
      "MANIFEST_INVALID",
      "Manifest ownerLabel must be 'replica_producer_owner'."
    );
  }
  if (typeof m.includeSharedPassengers !== "boolean") {
    throw createReplicaError(
      "MANIFEST_INVALID",
      "Manifest includeSharedPassengers must be a boolean."
    );
  }
  if (
    typeof m.epoch !== "number" ||
    !Number.isSafeInteger(m.epoch) ||
    m.epoch < 1
  ) {
    throw createReplicaError(
      "MANIFEST_INVALID",
      "Manifest epoch must be a positive safe integer (>= 1)."
    );
  }
  if (
    typeof m.sequence !== "number" ||
    !Number.isSafeInteger(m.sequence) ||
    m.sequence < 1
  ) {
    throw createReplicaError(
      "MANIFEST_INVALID",
      "Manifest sequence must be a positive safe integer (>= 1)."
    );
  }
  if (typeof m.captureStartedAt !== "string") {
    throw createReplicaError(
      "MANIFEST_INVALID",
      "Manifest captureStartedAt is missing."
    );
  }
  if (typeof m.captureCompletedAt !== "string") {
    throw createReplicaError(
      "MANIFEST_INVALID",
      "Manifest captureCompletedAt is missing."
    );
  }
  if (m.dbFileName !== REPLICA_DB_FILENAME) {
    throw createReplicaError(
      "MANIFEST_INVALID",
      `Manifest dbFileName must be '${REPLICA_DB_FILENAME}'.`
    );
  }
  if (
    typeof m.dbBytes !== "number" ||
    !Number.isSafeInteger(m.dbBytes) ||
    m.dbBytes <= 0
  ) {
    throw createReplicaError(
      "MANIFEST_INVALID",
      "Manifest dbBytes must be a positive safe integer."
    );
  }
  if (
    typeof m.dbSha256 !== "string" ||
    !SHA256_HEX_PATTERN.test(m.dbSha256)
  ) {
    throw createReplicaError(
      "MANIFEST_INVALID",
      "Manifest dbSha256 must be a 64-character lowercase hex SHA-256 digest."
    );
  }
  if (
    !m.rowCounts ||
    typeof m.rowCounts !== "object" ||
    Array.isArray(m.rowCounts)
  ) {
    throw createReplicaError(
      "MANIFEST_INVALID",
      "Manifest rowCounts must be an object."
    );
  }
  const rcObj = m.rowCounts as Record<string, unknown>;
  const rcKeys = Object.keys(rcObj);
  if (rcKeys.length !== REPLICA_TABLE_NAMES.length) {
    throw createReplicaError(
      "MANIFEST_INVALID",
      "Manifest rowCounts table set does not match allowlist."
    );
  }
  const rowCounts: Record<string, number> = {};
  for (const table of REPLICA_TABLE_NAMES) {
    const countVal = rcObj[table];
    if (
      typeof countVal !== "number" ||
      !Number.isSafeInteger(countVal) ||
      countVal < 0
    ) {
      throw createReplicaError(
        "MANIFEST_INVALID",
        `Manifest rowCounts['${table}'] must be a non-negative safe integer.`
      );
    }
    rowCounts[table] = countVal;
  }

  if (typeof m.keyId !== "string" || !m.keyId.trim()) {
    throw createReplicaError(
      "MANIFEST_INVALID",
      "Manifest keyId is missing or empty."
    );
  }
  if (m.signatureAlgorithm !== "ed25519") {
    throw createReplicaError(
      "MANIFEST_INVALID",
      "Manifest signatureAlgorithm must be 'ed25519'."
    );
  }
  if (typeof m.signature !== "string" || !m.signature.trim()) {
    throw createReplicaError(
      "MANIFEST_INVALID",
      "Manifest signature is missing or empty."
    );
  }

  return Object.freeze({
    formatVersion: REPLICA_MANIFEST_FORMAT_VERSION,
    schemaVersion: m.schemaVersion,
    schemaHash: m.schemaHash,
    producerId: m.producerId,
    accountId: m.accountId,
    ownerUserId: m.ownerUserId,
    ownerLabel: "replica_producer_owner",
    includeSharedPassengers: m.includeSharedPassengers,
    epoch: m.epoch,
    sequence: m.sequence,
    captureStartedAt: m.captureStartedAt,
    captureCompletedAt: m.captureCompletedAt,
    dbFileName: REPLICA_DB_FILENAME,
    dbBytes: m.dbBytes,
    dbSha256: m.dbSha256,
    rowCounts: Object.freeze(rowCounts) as Readonly<
      Record<ReplicaTableName, number>
    >,
    keyId: m.keyId,
    signatureAlgorithm: "ed25519",
    signature: m.signature,
  });
}

export function verifyManifestSignatureAndClaims(params: {
  manifest: ReplicaManifest;
  trustedPublicKey: string | KeyObject;
  expectedKeyId?: string;
  expectedProducerId: string;
  expectedAccountId: string;
  expectedOwnerUserId: string;
  operatorOwnerOverride?: string | null;
  expectedEpoch: number;
  expectedSchemaVersion?: string;
  expectedSchemaHash?: string;
  limits?: ReplicaValidationLimits;
  now?: NowInput;
  checkFutureAgainstNow?: boolean;
}): void {
  const { manifest } = params;
  const pubKey = normalizeEd25519PublicKey(params.trustedPublicKey);
  const pinnedKeyId =
    params.expectedKeyId?.trim() || computePublicKeyId(pubKey);

  if (manifest.keyId !== pinnedKeyId) {
    throw createReplicaError(
      "KEY_MISMATCH",
      "Manifest keyId does not match receiver's pinned verification key."
    );
  }

  // Verify cryptographic signature first before trusting any manifest claims.
  let sigBytes: Buffer;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(manifest.signature)) {
      throw new Error("Invalid base64url characters");
    }
    sigBytes = Buffer.from(manifest.signature, "base64url");
  } catch {
    throw createReplicaError(
      "SIGNATURE_INVALID",
      "Manifest signature is not valid base64url."
    );
  }

  if (sigBytes.byteLength !== 64) {
    throw createReplicaError(
      "SIGNATURE_INVALID",
      "Manifest Ed25519 signature must be 64 bytes."
    );
  }

  const signingPayload = buildCanonicalSigningPayload(manifest);
  let sigValid = false;
  try {
    sigValid = cryptoVerify(
      null,
      Buffer.from(signingPayload, "utf8"),
      pubKey,
      sigBytes
    );
  } catch {
    sigValid = false;
  }

  if (!sigValid) {
    throw createReplicaError(
      "SIGNATURE_INVALID",
      "Manifest Ed25519 signature verification failed."
    );
  }

  // Verify pinned schema version and schema hash.
  const expectedSchemaVersion =
    params.expectedSchemaVersion ?? REPLICA_SCHEMA_VERSION;
  const expectedSchemaHash = params.expectedSchemaHash ?? REPLICA_SCHEMA_HASH;
  if (
    manifest.schemaVersion !== expectedSchemaVersion ||
    manifest.schemaHash !== expectedSchemaHash
  ) {
    throw createReplicaError(
      "SCHEMA_MISMATCH",
      "Manifest schemaVersion or schemaHash does not match receiver's pinned allowlist schema."
    );
  }

  // Verify pinned producer, account, owner, and operator override.
  if (manifest.producerId !== params.expectedProducerId) {
    throw createReplicaError(
      "PRODUCER_MISMATCH",
      "Manifest producerId does not match receiver's pinned producerId."
    );
  }
  if (manifest.accountId !== params.expectedAccountId) {
    throw createReplicaError(
      "ACCOUNT_MISMATCH",
      "Manifest accountId does not match receiver's pinned accountId."
    );
  }
  if (
    manifest.ownerUserId.toLowerCase() !==
    params.expectedOwnerUserId.toLowerCase()
  ) {
    throw createReplicaError(
      "OWNER_MISMATCH",
      "Manifest ownerUserId does not match receiver's pinned ownerUserId."
    );
  }

  const operatorOverride = (params.operatorOwnerOverride ?? "").trim();
  if (
    operatorOverride.length > 0 &&
    operatorOverride.toLowerCase() !==
    params.expectedOwnerUserId.toLowerCase()
  ) {
    throw createReplicaError(
      "OWNER_MISMATCH",
      "Configured operator owner override disagrees with the approved replica ownerUserId scope."
    );
  }

  if (manifest.epoch !== params.expectedEpoch) {
    throw createReplicaError(
      "EPOCH_MISMATCH",
      `Manifest epoch (${manifest.epoch}) does not match receiver's pinned epoch (${params.expectedEpoch}).`
    );
  }

  const maxDbBytes = params.limits?.maxDbBytes ?? DEFAULT_MAX_DB_BYTES;
  if (manifest.dbBytes <= 0 || manifest.dbBytes > maxDbBytes) {
    throw createReplicaError(
      "DB_SIZE_EXCEEDED",
      `Manifest dbBytes (${manifest.dbBytes}) exceeds maximum allowed (${maxDbBytes}).`
    );
  }

  validateCaptureInterval({
    captureStartedAt: manifest.captureStartedAt,
    captureCompletedAt: manifest.captureCompletedAt,
    now: params.now,
    limits: params.limits,
    checkFutureAgainstNow: params.checkFutureAgainstNow,
  });
}

export function verifyExactHexDigest(
  actualHex: string,
  expectedHex: string
): boolean {
  if (
    !SHA256_HEX_PATTERN.test(actualHex) ||
    !SHA256_HEX_PATTERN.test(expectedHex)
  ) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(actualHex, "hex"),
    Buffer.from(expectedHex, "hex")
  );
}
