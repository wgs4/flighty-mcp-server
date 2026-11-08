import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const output = fileURLToPath(new URL("../build", import.meta.url));
if (existsSync(output)) {
  const result = spawnSync("trash", [output], { stdio: "inherit" });
  if (result.error) throw new Error("A recoverable trash utility is required; build/ was preserved.");
  if (result.status !== 0) process.exit(result.status ?? 1);
}
