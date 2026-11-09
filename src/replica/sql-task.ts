import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { constructReplicaBundle } from "./exporter.js";
import { validateReplicaDatabaseSchemaAndContents } from "./schema.js";
import { publicReplicaError } from "./cleanup.js";
process.umask(0o077);
try {
  const task = JSON.parse(readFileSync(0, "utf8"));
  let value: unknown;
  if (task.kind === "export") {
    // Parent attests the caller-owned mount authority. All device/path checks repeat here.
    task.options.storage.validateMount = () => true;
    value = await constructReplicaBundle(task.options);
  } else if (task.kind === "validate") {
    const db = new DatabaseSync(task.dbPath, { readOnly: true, allowExtension: false, timeout: 100 });
    try { db.exec("PRAGMA trusted_schema = OFF"); validateReplicaDatabaseSchemaAndContents(db, task.manifest, task.limits); }
    finally { db.close(); }
    value = true;
  } else throw new Error("Unknown task");
  process.stdout.write(JSON.stringify({ value }));
} catch (error) {
  const safe = publicReplicaError(error);
  process.stdout.write(JSON.stringify({ error: { code: safe.code, message: safe.message } }));
}
