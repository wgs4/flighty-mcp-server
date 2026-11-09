import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { runtimeFixture } from "./runtime-fixture.js";
import { openLinux } from "../src/runtime/linux.js";
import { openMac, defaultMacReaders } from "../src/runtime/mac.js";
import { trashFixture } from "./fixture/lifecycle.mjs";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) trashFixture(root); });
function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [fileURLToPath(new URL("../build/runtime/cli.js", import.meta.url)), ...args],
    { env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 5000 });
}
it("actual explicit Linux/Mac init CLI provisions once and ordinary reopen preserves continuity", () => {
  const f = runtimeFixture(); roots.push(f.root);
  const linux = f.configFile("linux"), mac = f.configFile("mac");
  expect(run(["init-linux", "--config", linux]).status).toBe(0);
  const runtime = openLinux(f.linux); expect(runtime.receiver.getStateSnapshot().highwaterSequence).toBe(0); runtime.close();
  expect(run(["init-linux", "--config", linux]).status).toBe(1);
  expect(run(["init-mac", "--config", mac]).status).toBe(0);
  const helper = openMac(f.macConfig, { readers: { ...defaultMacReaders(), build: () => "4759" }, fetchImpl: (() => { throw new Error("network forbidden"); }) as any,
    upload: async () => { throw new Error("network forbidden"); } }); helper.close();
  expect(run(["init-mac", "--config", mac]).status).toBe(1);
});
it("CLI rejects missing configuration, extra argv and arbitrary forced commands before transport", () => {
  const f = runtimeFixture(); roots.push(f.root); const file = f.configFile("linux");
  for (const args of [[], ["courier-once"], ["init-linux", "--config", file, "--reset"], ["shell", "-c", "anything"]]) expect(run(args).status).toBe(1);
  expect(run(["forced-command", "--config", file], { SSH_ORIGINAL_COMMAND: "cat /etc/passwd" }).status).toBe(1);
});
