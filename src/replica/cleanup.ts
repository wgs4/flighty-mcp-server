import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, join, normalize, resolve } from "node:path";
import { sanitizeToolErrorMessage } from "../services/tool-safety.js";
import {
  ReplicaError,
  type CleanupPathFn,
  type MountCheckFn,
  type ReplicaErrorCode,
} from "./types.js";

const PATH_TRAVERSAL_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

/**
 * Redacts filesystem paths, tokens, and arbitrary secrets from any replica error message.
 */
export function sanitizeReplicaErrorText(
  message: string,
  extraPathsToRedact: readonly string[] = []
): string {
  let text = message ?? "Replica operation failed.";
  for (const rawPath of extraPathsToRedact) {
    if (typeof rawPath === "string" && rawPath.trim().length > 0) {
      text = text.split(rawPath).join("[redacted-path]");
      const resolved = resolve(rawPath);
      if (resolved !== rawPath) {
        text = text.split(resolved).join("[redacted-path]");
      }
    }
  }
  return sanitizeToolErrorMessage(text);
}

export function createReplicaError(
  code: ReplicaErrorCode,
  message: string,
  extraPathsToRedact: readonly string[] = []
): ReplicaError {
  return new ReplicaError(
    code,
    sanitizeReplicaErrorText(message, extraPathsToRedact)
  );
}

/**
 * Validates that a path string is non-empty, absolute, free of NUL bytes and `..` segments.
 */
export function assertSafeAbsolutePath(
  inputPath: unknown,
  label: string
): string {
  if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
    throw createReplicaError(
      "INVALID_PATH",
      `Invalid ${label}: explicit absolute path is required.`
    );
  }
  if (inputPath.includes("\0")) {
    throw createReplicaError(
      "INVALID_PATH",
      `Invalid ${label}: null bytes are forbidden.`
    );
  }
  if (PATH_TRAVERSAL_SEGMENT.test(inputPath)) {
    throw createReplicaError(
      "INVALID_PATH",
      `Invalid ${label}: path traversal segments ('..') are forbidden.`
    );
  }
  if (!isAbsolute(inputPath)) {
    throw createReplicaError(
      "INVALID_PATH",
      `Invalid ${label}: path must be absolute.`
    );
  }
  const normalized = normalize(inputPath);
  if (PATH_TRAVERSAL_SEGMENT.test(normalized)) {
    throw createReplicaError(
      "INVALID_PATH",
      `Invalid ${label}: normalized path contains traversal segments.`
    );
  }
  return resolve(inputPath);
}

/**
 * Ensures every existing ancestor/target component is not a symbolic link.
 */
export function assertNoSymlinkChain(
  targetPath: string,
  label: string,
  stopAtAncestor?: string
): void {
  const resolvedStop = stopAtAncestor ? resolve(stopAtAncestor) : null;
  let current = resolve(targetPath);
  const visited = new Set<string>();

  while (!visited.has(current)) {
    visited.add(current);
    if (existsSync(current)) {
      const st = lstatSync(current);
      if (st.isSymbolicLink()) {
        throw createReplicaError(
          "INVALID_PATH",
          `Invalid ${label}: symbolic links are forbidden.`,
          [targetPath, current]
        );
      }
    }
    if (resolvedStop && current === resolvedStop) {
      break;
    }
    const parent = resolve(current, "..");
    if (parent === current) {
      break;
    }
    current = parent;
  }
}

/**
 * Verifies that `filePath` exists, is not a symlink, and is a regular file.
 */
export function assertRegularFileNoSymlink(
  filePath: string,
  label: string,
  notFoundCode: ReplicaErrorCode = "INVALID_PATH"
): { size: number } {
  const cleanPath = assertSafeAbsolutePath(filePath, label);
  let lstat;
  try {
    lstat = lstatSync(cleanPath);
  } catch {
    throw createReplicaError(
      notFoundCode,
      `Required ${label} does not exist or is inaccessible.`,
      [cleanPath]
    );
  }
  if (lstat.isSymbolicLink()) {
    throw createReplicaError(
      "INVALID_PATH",
      `Invalid ${label}: symbolic links are forbidden.`,
      [cleanPath]
    );
  }
  if (!lstat.isFile()) {
    throw createReplicaError(
      "INVALID_PATH",
      `Invalid ${label}: expected a regular file.`,
      [cleanPath]
    );
  }
  return { size: lstat.size };
}

/**
 * Verifies that no SQLite `-wal`, `-shm`, or `-journal` sidecars exist alongside a replica DB.
 */
export function assertNoDatabaseSidecars(
  dbPath: string,
  label = "replica database"
): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = `${dbPath}${suffix}`;
    try {
      lstatSync(sidecar);
      throw createReplicaError(
        "DB_SIDECAR_FORBIDDEN",
        `Forbidden SQLite sidecar (${suffix}) present alongside ${label}.`,
        [dbPath, sidecar]
      );
    } catch (err) {
      if (err instanceof ReplicaError) {
        throw err;
      }
      // ENOENT is expected.
    }
  }
}

/**
 * Verifies that the required mount volume and source database exist and are accessible.
 * Never falls back to internal drive or allows blank export.
 */
export function verifyMountAndSource(params: {
  requiredMountPath: string;
  sourceDbPath: string;
  outputDir: string;
  mountCheck?: MountCheckFn;
}): void {
  const requiredMountPath = assertSafeAbsolutePath(
    params.requiredMountPath,
    "requiredMountPath"
  );
  const sourceDbPath = assertSafeAbsolutePath(
    params.sourceDbPath,
    "sourceDbPath"
  );
  const outputDir = assertSafeAbsolutePath(params.outputDir, "outputBundleDir");

  // Guard against exporting from the real Flighty container path by accident in unapproved runs.
  if (
    sourceDbPath.includes("Library/Containers/com.flightyapp.flighty")
  ) {
    throw createReplicaError(
      "INVALID_CONFIG",
      "Real Flighty app container path is gated; explicit synthetic or approved staging source path is required.",
      [sourceDbPath]
    );
  }

  if (
    sourceDbPath === outputDir ||
    sourceDbPath === join(outputDir, "replica.db") ||
    outputDir.startsWith(`${sourceDbPath}/`)
  ) {
    throw createReplicaError(
      "INVALID_PATH",
      "Output bundle directory must be distinct from source database path.",
      [sourceDbPath, outputDir]
    );
  }

  if (params.mountCheck) {
    let ok = false;
    try {
      ok = Boolean(
        params.mountCheck({ requiredMountPath, sourceDbPath, outputDir })
      );
    } catch {
      ok = false;
    }
    if (!ok) {
      throw createReplicaError(
        "MOUNT_UNAVAILABLE",
        "Required storage mount or source check failed; refusing export without fallback.",
        [requiredMountPath, sourceDbPath, outputDir]
      );
    }
  } else {
    try {
      const mountStat = statSync(requiredMountPath);
      if (!mountStat.isDirectory()) {
        throw new Error("Mount path is not a directory");
      }
    } catch {
      throw createReplicaError(
        "MOUNT_UNAVAILABLE",
        "Required storage mount is unavailable; refusing export without fallback.",
        [requiredMountPath]
      );
    }
  }

  assertNoSymlinkChain(sourceDbPath, "sourceDbPath");
  const { size } = assertRegularFileNoSymlink(
    sourceDbPath,
    "sourceDbPath",
    "SOURCE_NOT_FOUND"
  );
  if (size <= 0) {
    throw createReplicaError(
      "SOURCE_NOT_FOUND",
      "Source database file is empty; refusing blank export.",
      [sourceDbPath]
    );
  }
}

/**
 * Ensures write permissions are restored before retiring a directory/file that may have 0400 files.
 */
function makeWritableForRetire(targetPath: string): void {
  try {
    const st = lstatSync(targetPath);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      chmodSync(targetPath, 0o700);
      for (const entry of readdirSync(targetPath)) {
        makeWritableForRetire(join(targetPath, entry));
      }
    } else if (st.isFile()) {
      chmodSync(targetPath, 0o600);
    }
  } catch {
    // Best-effort permission adjustment before trash/quarantine move.
  }
}

/**
 * Safely retires a file or directory without ever calling `rm`, `rmSync`, `unlink`, or `rmdir`.
 * Uses `trash` CLI when available, and falls back to moving (`renameSync`) into an isolated `.trash`
 * directory when running in environments without the `trash` utility (such as minimal Linux containers).
 */
export function retirePath(
  targetPath: string,
  fallbackTrashDir: string,
  customCleanup?: CleanupPathFn
): void {
  if (!targetPath || !existsSync(targetPath)) {
    return;
  }

  makeWritableForRetire(targetPath);

  if (customCleanup) {
    customCleanup(targetPath);
    return;
  }

  try {
    const res = spawnSync("trash", [targetPath], { stdio: "pipe" });
    if (!res.error && res.status === 0 && !existsSync(targetPath)) {
      return;
    }
  } catch {
    // Fall through to quarantine rename.
  }

  if (existsSync(targetPath)) {
    mkdirSync(fallbackTrashDir, { recursive: true, mode: 0o700 });
    const retiredName = `${basename(targetPath)}-${Date.now()}-${randomUUID()}`;
    const destination = join(fallbackTrashDir, retiredName);
    renameSync(targetPath, destination);
  }
}
