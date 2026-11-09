import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createReplicaError } from "./cleanup.js";
import type { ReplicaErrorCode } from "./types.js";

/** A separate killable process bounds native SQLite execution, including backup and checks. */
export function runSqliteTask<T>(task: unknown, durationMs = 30000): T {
  const local = new URL("./sql-task.js", import.meta.url);
  const script = existsSync(local) ? local : new URL("../../build/replica/sql-task.js", import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(script)], {
    input: JSON.stringify(task), encoding: "utf8", timeout: durationMs,
    killSignal: "SIGKILL", maxBuffer: 1024 * 1024, windowsHide: true,
  });
  if (result.error || result.signal) throw createReplicaError("OPERATION_TIMEOUT", "Bounded SQLite worker failed or exceeded its execution deadline.");
  let response;
  try { response = JSON.parse(result.stdout); } catch { throw createReplicaError("SOURCE_READ_ERROR", "Bounded SQLite worker did not complete."); }
  if (response.error) throw createReplicaError(response.error.code as ReplicaErrorCode, response.error.message);
  return response.value as T;
}
