import { afterEach } from "vitest";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { exportReplicaBundle } from "../src/replica/exporter.js";
import type { ExportReplicaBundleOptions, ReplicaStorageAuthority } from "../src/replica/types.js";
import { trashFixture } from "./fixture/lifecycle.mjs";
const quarantines = new Set<string>();
export function receiverStorage(path: string): ReplicaStorageAuthority {
  const root = dirname(path);
  chmodSync(root, 0o700);
  return { mountPath: root, privateRootDir: root, expectedDevice: statSync(root).dev, approvedPaths: [root], validateMount: () => true };
}
export function exportSyntheticBundle(options: Omit<ExportReplicaBundleOptions, "storage" | "quarantineDir">) {
  const root = dirname(options.outputBundleDir);
  const parent = dirname(root);
  chmodSync(parent, 0o700);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const quarantineDir = join(parent, `${basename(root)}-private-quarantine`);
  quarantines.add(quarantineDir);
  return exportReplicaBundle({ ...options, requiredMountPath: parent, storage: receiverStorage(root), quarantineDir });
}
afterEach(() => { for (const path of quarantines) trashFixture(path); quarantines.clear(); });
