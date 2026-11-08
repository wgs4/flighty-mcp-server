import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

it("replaces stale compile output and packages the MIT license without tests or committed bundles", () => {
  const stale = new URL("../build/p3-stale-file.js", import.meta.url);
  writeFileSync(stale, "throw new Error('stale output');\n");
  const build = spawnSync(process.execPath, ["scripts/build.mjs"], { cwd: root, encoding: "utf8" });
  expect(build.status, build.stderr).toBe(0);
  expect(existsSync(stale)).toBe(false);
  const packed = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { cwd: root, encoding: "utf8" });
  expect(packed.status, packed.stderr).toBe(0);
  const files = JSON.parse(packed.stdout)[0].files.map((file: { path: string }) => file.path);
  expect(files).toContain("LICENSE");
  expect(files).toContain("build/index.js");
  expect(files.some((path: string) => /^(?:src|tests|dist|\.cache)\//.test(path) || path.includes("stale-file"))).toBe(false);
  expect(readFileSync(new URL("../LICENSE", import.meta.url), "utf8")).toContain("MIT License");
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  expect(lock.version).toBe(manifest.version);
  expect(lock.packages[""].version).toBe(manifest.version);
}, 30_000);
