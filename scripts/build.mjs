import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cache = join(root, ".cache/flighty-build");
mkdirSync(cache, { recursive: true });
const stage = mkdtempSync(join(cache, "compile-"));
const output = join(stage, "build");
const compile = spawnSync(process.execPath, [
  join(root, "node_modules/typescript/bin/tsc"),
  "--project", join(root, "tsconfig.json"), "--outDir", output,
], { cwd: root, stdio: "inherit" });
if (compile.error) throw compile.error;
if (compile.status !== 0) process.exit(compile.status ?? 1);

// Compile completely before swapping directories. Keep the previous build recoverable.
const destination = join(root, "build");
const previous = join(stage, "previous-build");
const hadBuild = existsSync(destination);
if (hadBuild) renameSync(destination, previous);
try {
  renameSync(output, destination);
} catch (error) {
  if (hadBuild) renameSync(previous, destination);
  throw error;
}
console.log("Compiled source into build/ (previous output retained in .cache/flighty-build/).");
