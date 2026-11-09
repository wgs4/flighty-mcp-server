import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readdirSync, readSync, renameSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { sanitizeToolErrorMessage } from "../services/tool-safety.js";
import { ReplicaError, type CleanupPathFn, type MountCheckFn, type ReplicaErrorCode, type ReplicaStorageAuthority, type ReplicaStorageBudget } from "./types.js";

export function sanitizeReplicaErrorText(message: string, paths: readonly string[] = []): string {
  let text = message;
  for (const path of paths) if (path) text = text.split(path).join("[redacted-path]");
  return sanitizeToolErrorMessage(text);
}
export function createReplicaError(code: ReplicaErrorCode, message: string, paths: readonly string[] = []): ReplicaError {
  return new ReplicaError(code, sanitizeReplicaErrorText(message, paths));
}
export function publicReplicaError(error: unknown): ReplicaError {
  return error instanceof ReplicaError ? error : createReplicaError("STORAGE_WRITE_FAILED", "Replica filesystem operation failed.");
}
export function assertSafeAbsolutePath(input: unknown, label: string): string {
  if (typeof input !== "string" || !input.trim() || input.includes("\0") || !isAbsolute(input) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(input)) {
    throw createReplicaError("INVALID_PATH", `Invalid ${label}: explicit absolute path without traversal is required.`);
  }
  return resolve(normalize(input));
}
function statIfPresent(path: string) {
  try { return lstatSync(path); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw createReplicaError("INVALID_PATH", "Replica path is inaccessible.");
  }
}
export function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}
export function assertNoSymlinkChain(path: string, _label: string, _stop?: string): void {
  for (let current = resolve(path);;current = dirname(current)) {
    if (statIfPresent(current)?.isSymbolicLink()) throw createReplicaError("INVALID_PATH", "Symbolic links are forbidden in replica paths.");
    if (dirname(current) === current) break;
  }
}
export function assertRegularFileNoSymlink(path: string, _label: string, code: ReplicaErrorCode = "INVALID_PATH"): { size: number } {
  assertSafeAbsolutePath(path, "file");
  assertNoSymlinkChain(path, "file");
  const st = statIfPresent(path);
  if (!st) throw createReplicaError(code, "Required replica file is missing.");
  if (!st.isFile() || st.nlink !== 1) throw createReplicaError("INVALID_PATH", "Replica file must be regular and have one link.");
  return { size: st.size };
}
export function assertNoDatabaseSidecars(path: string, _label?: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) if (statIfPresent(path + suffix)) {
    throw createReplicaError("DB_SIDECAR_FORBIDDEN", "Replica database sidecars are forbidden.");
  }
}
export function assertPrivatePath(path: string, root: string, device?: number): void {
  assertNoSymlinkChain(path, "storage");
  if (!isWithin(path, root)) throw createReplicaError("INVALID_PATH", "Replica storage escapes its private root.");
  for (let current = path;;current = dirname(current)) {
    const st = statIfPresent(current);
    if (st && ((st.mode & 0o077) !== 0 || (typeof process.getuid === "function" && st.uid !== process.getuid()) || (device !== undefined && st.dev !== device) || (!st.isDirectory() && (!st.isFile() || st.nlink !== 1)))) {
      throw createReplicaError("INVALID_PATH", "Replica storage must be private, owned, on the approved device, and unlinked.");
    }
    if (current === root) break;
  }
}
/** Protect the private root's directory entry from replacement through any mount ancestor. */
function assertTrustedStorageAncestors(root: string, mount: string, device: number): void {
  assertNoSymlinkChain(root, "storage ancestors");
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  for (let current = root;;current = dirname(current)) {
    const st = statIfPresent(current);
    if (st && (!st.isDirectory() || st.dev !== device || (uid !== undefined && st.uid !== uid && st.uid !== 0) || ((st.mode & 0o022) !== 0 && (st.mode & 0o1000) === 0))) {
      throw createReplicaError("INVALID_PATH", "Storage ancestors allow unauthorized directory replacement.");
    }
    if (current === mount) break;
  }
}

/** Replica transport supports rollback-journal headers only; WAL may create files on read. */
export function assertReplicaDatabaseHeader(path: string): void {
  assertRegularFileNoSymlink(path, "replica database");
  const header = Buffer.alloc(100);
  const fd = openSync(path, "r");
  try {
    if (readSync(fd, header, 0, header.length, 0) !== header.length || !header.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")) || header[18] !== 1 || header[19] !== 1) {
      throw createReplicaError("DB_SCHEMA_INVALID", "Replica database requires a standalone rollback-journal header.");
    }
  } finally { closeSync(fd); }
}

export function validateStorage(authority: ReplicaStorageAuthority, paths: readonly string[], create = true): void {
  if (!authority || typeof authority.validateMount !== "function" || !Number.isSafeInteger(authority.expectedDevice) || !Array.isArray(authority.approvedPaths) || authority.approvedPaths.length === 0) {
    throw createReplicaError("MOUNT_UNAVAILABLE", "Explicit storage identity authority is required.");
  }
  const mount = assertSafeAbsolutePath(authority.mountPath, "mount");
  const root = assertSafeAbsolutePath(authority.privateRootDir, "private root");
  assertNoSymlinkChain(mount, "mount");
  let approved = false;
  try { approved = authority.validateMount(mount) === true; } catch { /* Fail closed. */ }
  if (!approved || !statIfPresent(mount)?.isDirectory() || (lstatSync(mount).mode & 0o022) !== 0 || lstatSync(mount).dev !== authority.expectedDevice || !isWithin(root, mount)) {
    throw createReplicaError("MOUNT_UNAVAILABLE", "Approved storage mount identity is unavailable.");
  }
  assertTrustedStorageAncestors(root, mount, authority.expectedDevice);
  assertPrivatePath(root, root, authority.expectedDevice);
  for (const input of paths) {
    const path = assertSafeAbsolutePath(input, "storage path");
    if (!authority.approvedPaths.some(p => isWithin(path, assertSafeAbsolutePath(p, "approved path")))) throw createReplicaError("INVALID_PATH", "Replica path is outside explicitly approved storage paths.");
    assertPrivatePath(path, root, authority.expectedDevice);
  }
  if (create) {
    for (const path of [root, ...paths]) {
      // Create each component privately, rather than allowing recursive mkdir's intermediate defaults.
      const missing: string[] = [];
      for (let current = path;!statIfPresent(current);current = dirname(current)) missing.unshift(current);
      for (const component of missing) mkdirSync(component, { mode: 0o700 });
      assertPrivatePath(path, root, authority.expectedDevice);
      if (!lstatSync(path).isDirectory()) throw createReplicaError("INVALID_PATH", "Replica storage path must be a directory.");
    }
  }
}
export function verifyMountAndSource(params: { requiredMountPath: string; sourceDbPath: string; approvedSourceDbPath?: string; outputDir: string; mountCheck?: MountCheckFn; storage?: ReplicaStorageAuthority }): void {
  const source = assertSafeAbsolutePath(params.sourceDbPath, "source");
  const output = assertSafeAbsolutePath(params.outputDir, "output");
  if (source.includes("Library/Containers/com.flightyapp.flighty") && params.approvedSourceDbPath !== source) throw createReplicaError("INVALID_CONFIG", "Real application source paths remain gated.");
  if (isWithin(source, output) || isWithin(output, source)) throw createReplicaError("INVALID_PATH", "Invalid source or output scope.");
  if (!params.storage || resolve(params.requiredMountPath) !== resolve(params.storage.mountPath)) throw createReplicaError("MOUNT_UNAVAILABLE", "Explicit matching storage mount authority is required.");
  validateStorage(params.storage, [dirname(output)], false);
  if (params.mountCheck && !params.mountCheck({ requiredMountPath: params.requiredMountPath, sourceDbPath: source, outputDir: output })) throw createReplicaError("MOUNT_UNAVAILABLE", "Required storage check failed.");
  const { size } = assertRegularFileNoSymlink(source, "source", "SOURCE_NOT_FOUND");
  if (size === 0) throw createReplicaError("SOURCE_NOT_FOUND", "Source database is empty.");
}
export function* directoryEntries(path: string): Generator<string> {
  const dir = opendirSync(path);
  try { for (;;) { const entry = dir.readSync(); if (!entry) break; yield entry.name; } }
  finally { dir.closeSync(); }
}
export function assertExactBundle(path: string): void {
  assertNoSymlinkChain(path, "bundle");
  const entries: string[] = [];
  for (const entry of directoryEntries(path)) { entries.push(entry); if (entries.length > 2) break; }
  entries.sort();
  if (entries.length !== 2 || entries[0] !== "manifest.json" || entries[1] !== "replica.db") throw createReplicaError("DB_CONTENT_INVALID", "Bundle must contain exactly replica.db and manifest.json.");
  for (const entry of entries) { assertRegularFileNoSymlink(join(path, entry), "bundle file"); assertPrivatePath(join(path, entry), path); }
}
export function measureStorage(path: string, budget: ReplicaStorageBudget = {}, reserveBytes = 0, reserveEntries = 0): { bytes: number; entries: number } {
  const maxBytes = budget.maxBytes ?? 512 * 1024 * 1024;
  const maxEntries = budget.maxEntries ?? 2048;
  if (![maxBytes, maxEntries].every(n => Number.isSafeInteger(n) && n > 0)) throw createReplicaError("INVALID_CONFIG", "Invalid replica storage budget.");
  let bytes = reserveBytes, entries = reserveEntries;
  const visit = (target: string) => {
    const st = statIfPresent(target);
    if (!st) return;
    if (st.isSymbolicLink() || (!st.isDirectory() && (!st.isFile() || st.nlink !== 1)) || (st.mode & 0o077) !== 0 || (typeof process.getuid === "function" && st.uid !== process.getuid())) throw createReplicaError("INVALID_PATH", "Unsafe entry in private replica storage.");
    entries++;
    bytes += st.isFile() ? st.size : 0;
    if (bytes > maxBytes || entries > maxEntries) throw createReplicaError("STORAGE_BUDGET_EXCEEDED", "Private replica storage budget is full; operator retirement is required.");
    if (st.isDirectory()) for (const name of directoryEntries(target)) visit(join(target, name));
  };
  visit(path);
  if (bytes > maxBytes || entries > maxEntries) throw createReplicaError("STORAGE_BUDGET_EXCEEDED", "Private replica storage budget is full; operator retirement is required.");
  return { bytes, entries };
}
export function measureStorageGroups(paths: readonly string[], budget: ReplicaStorageBudget = {}, reserveBytes = 0, reserveEntries = 0): void {
  const unique = [...new Set(paths)].filter(path => !paths.some(other => other !== path && isWithin(path, other)));
  let bytes = reserveBytes, entries = reserveEntries;
  for (const path of unique) { const usage = measureStorage(path, budget); bytes += usage.bytes; entries += usage.entries; }
  if (bytes > (budget.maxBytes ?? 512 * 1024 * 1024) || entries > (budget.maxEntries ?? 2048)) throw createReplicaError("STORAGE_BUDGET_EXCEEDED", "Private replica storage budget is full; operator retirement is required.");
}
/** Private recoverable quarantine only. Never deletes data or spills into system Trash. */
export function retirePath(target: string, quarantine: string, _custom?: CleanupPathFn): void {
  try {
    if (_custom) throw createReplicaError("INVALID_CONFIG", "Custom retirement callbacks are unsupported.");
    if (!statIfPresent(target)) return;
    assertNoSymlinkChain(target, "retirement");
    assertNoSymlinkChain(quarantine, "quarantine");
    if (!statIfPresent(quarantine)?.isDirectory()) throw createReplicaError("INVALID_PATH", "Explicit private quarantine must exist.");
    renameSync(target, join(quarantine, `${basename(target)}-${randomUUID()}`));
  } catch (error) { throw publicReplicaError(error); }
}
export function flushPath(path: string, hook?: (boundary: string) => void, boundary = "file"): void {
  let fd: number | undefined;
  try { hook?.(boundary); fd = openSync(path, "r"); fsyncSync(fd); }
  finally { if (fd !== undefined) closeSync(fd); }
}
