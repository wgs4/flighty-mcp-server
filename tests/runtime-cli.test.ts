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
it("compiled inspect/recover CLI repairs an actual exited child's ahead-of-anchor failure without new request ID", async () => {
  const { sign } = await import("node:crypto"), { canonical } = await import("../src/remote/protocol.js"), { writeFileSync } = await import("node:fs"), { join } = await import("node:path");
  const f = runtimeFixture(); roots.push(f.root); f.linux.operatorPublicKey = f.macConfig.operatorPublicKey; const file = f.configFile("linux");
  expect(run(["init-linux", "--config", file]).status).toBe(0);
  const crashed = spawnSync(process.execPath, [fileURLToPath(new URL("./runtime-continuity-crash.mjs", import.meta.url)), file], { encoding: "utf8", timeout: 5000 }); expect(crashed.status, crashed.stderr).toBe(73);
  expect(() => openLinux(f.linux)).toThrow();
  const inspected = run(["inspect-store", "--kind", "linux", "--config", file, "--role", "linux-client"]); expect(inspected.status, inspected.stderr).toBe(0);
  const issuedAt = Date.now(), body = { version: 1, action: "recover-continuity", mode: "repair-ahead", ...JSON.parse(inspected.stdout), nonce: "compiled-repair", issuedAt, expiresAt: issuedAt+300000 };
  const proof = join(f.root,"operator-attestation.json"); writeFileSync(proof, JSON.stringify({body,signature:sign(null,Buffer.from("flighty-continuity-recovery-v1:"+canonical(body)),f.operator.privateKey).toString("base64")}),{mode:0o600});
  const repaired = run(["recover-store", "--kind", "linux", "--config", file, "--role", "linux-client", "--attestation", proof]); expect(repaired.status, repaired.stderr).toBe(0);
  expect(run(["recover-store", "--kind", "linux", "--config", file, "--role", "linux-client", "--attestation", proof]).status).toBe(1);
  const runtime = openLinux(f.linux); expect(runtime.clientStore.get<any>("client","compiled-request").request.body.operationId).toBe("compiled-request"); runtime.close();
});
