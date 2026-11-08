import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function fixtureTempRoot() {
  const path = fileURLToPath(new URL("../../node_modules/.cache/flighty-tests/", import.meta.url));
  mkdirSync(path, { recursive: true });
  return path;
}

export function trashFixture(directory) {
  const result = spawnSync("trash", [directory], { stdio: "pipe" });
  // Missing trash must never turn synthetic cleanup into a destructive deletion.
  if (result.error || result.status !== 0) console.warn("Synthetic fixture retained: trash unavailable.");
}
