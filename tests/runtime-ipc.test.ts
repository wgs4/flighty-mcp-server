import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { runtimeFixture } from "./runtime-fixture.js";
import { provisionLinux } from "../src/runtime/linux.js";
import { trashFixture } from "./fixture/lifecycle.mjs";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) trashFixture(root); });
async function scenario(name: string, bundle = true) {
  const f = runtimeFixture(); roots.push(f.root); f.linux.budget.transportMs = 300;
  provisionLinux(f.linux);
  const exported = bundle ? await f.bundle() : null;
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("./runtime-ipc-harness.mjs", import.meta.url)), f.configFile("linux"), exported?.bundleDir ?? "-", name], { encoding: "utf8", timeout: 12_000, maxBuffer: 128 * 1024 });
  expect(child.stderr).not.toContain("Unhandled"); expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout);
}
it("streams exact bundle files through the single owner and acknowledges identical resend", async () => {
  const result = await scenario("valid");
  expect(JSON.parse(result.first).accepted).toBe(true); expect(JSON.parse(result.duplicate).status).toBe("duplicate_acknowledged");
  expect(result.highwater).toBe(1);
});
it("the forced IPC client uploads without becoming another receiver or writer", async () => {
  const result = await scenario("bridge"); expect(JSON.parse(result.first).accepted).toBe(true); expect(result.highwater).toBe(1);
});
it.each(["digest", "truncated", "extra", "signature"])("rejects %s uploads without publishing partial state", async name => {
  const result = await scenario(name); expect(result.highwater).toBe(0); expect(JSON.parse(result.first).error).toBeTruthy(); expect(result.quarantine).toBe(1);
});
it("fixed Mac endpoint rejects role claims, submit, SQL and unknown endpoints", async () => {
  const results = await scenario("roles", false); for (const response of results) expect(response === "" || JSON.parse(response).error).toBeTruthy();
});
it("bounds total input, header, message sizes and trickle time", async () => {
  const result = await scenario("bounds", false); expect(result.slowMs).toBeGreaterThanOrEqual(200); expect(result.slowMs).toBeLessThan(2000);
  expect(result.highwater).toBe(0); for (const field of ["hugeHeader", "hugeBody"]) expect(result[field] === "" || JSON.parse(result[field]).error).toBeTruthy();
});
it("an existing socket is never unlinked or taken over", async () => {
  const result = await scenario("stale", false); expect(result.rejected).toBe(true); expect(JSON.parse(result.response).requests).toEqual([]);
});

it("admits only one upload and does not queue unbounded transport work", async () => {
  const result = await scenario("concurrency", false); expect(result.second).toBe(""); expect(result.highwater).toBe(0);
});
