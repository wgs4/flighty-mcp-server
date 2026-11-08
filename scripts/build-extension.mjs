import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const options = {};
while (args.length) {
  const key = args.shift();
  if (key === "--stage-only") options.stageOnly = true;
  else if (["--packer", "--packer-version", "--output"].includes(key) && args.length) {
    options[key.slice(2)] = args.shift();
  } else throw new Error(`Unknown or incomplete bundle option: ${key}`);
}
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}
if (!options.stageOnly) {
  if (!options.packer || !isAbsolute(options.packer) || !/^\d+\.\d+\.\d+$/.test(options["packer-version"] ?? "")) {
    throw new Error("Use --stage-only, or --packer /absolute/path/to/mcpb --packer-version X.Y.Z. No packer is downloaded.");
  }
  const version = spawnSync(options.packer, ["--version"], { encoding: "utf8" });
  const actual = version.stdout?.trim().match(/^(?:mcpb\s+)?(?:version\s+)?v?(\d+\.\d+\.\d+)$/)?.[1];
  if (version.error || version.status !== 0 || actual !== options["packer-version"]) {
    throw new Error("Installed packer version does not match the explicitly requested version.");
  }
}

run("npm", ["ci", "--ignore-scripts"]);
run(process.execPath, [join(root, "scripts/build.mjs")]);
const cache = join(root, ".cache/flighty-bundle");
mkdirSync(cache, { recursive: true });
const stage = mkdtempSync(join(cache, "stage-"));
for (const file of ["manifest.json", "package.json", "package-lock.json", "LICENSE"]) {
  cpSync(join(root, file), join(stage, file));
}
cpSync(join(root, "build"), join(stage, "server"), { recursive: true });
run("npm", ["ci", "--omit=dev", "--ignore-scripts"], stage);
if (!readFileSync(join(stage, "LICENSE"), "utf8").includes("MIT License")) {
  throw new Error("The staged package must include the MIT LICENSE.");
}
if (options.stageOnly) {
  console.log(`Extension stage: ${stage}`);
} else {
  const packed = join(cache, `bundle-${Date.now()}.mcpb`);
  run(options.packer, ["pack", stage, packed]);
  const output = resolve(root, options.output ?? "artifacts/flighty-mcp-server.mcpb");
  mkdirSync(resolve(output, ".."), { recursive: true });
  if (existsSync(output)) renameSync(output, join(cache, `previous-${Date.now()}.mcpb`));
  renameSync(packed, output);
  console.log(`Extension built: ${output}`);
}
