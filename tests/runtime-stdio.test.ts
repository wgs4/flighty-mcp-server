import { afterEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runtimeFixture } from "./runtime-fixture.js";
import { openLinux, provisionLinux } from "../src/runtime/linux.js";
import { trashFixture } from "./fixture/lifecycle.mjs";
import { READ_CASES, READ_NAMES, WRITE_NAMES, parseToolResult } from "./fixture/read-cases.mjs";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) trashFixture(root); });
async function setup(active: boolean) {
  const f = runtimeFixture(); roots.push(f.root); provisionLinux(f.linux);
  if (active) { const bundle = await f.bundle(); const r = openLinux(f.linux); r.receiver.acceptBundle(bundle.bundleDir); r.close(); }
  f.configFile("linux"); return f;
}
async function session(f: ReturnType<typeof runtimeFixture>, readOnly: string, check: (client: Client) => Promise<void>) {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ["--require", fileURLToPath(new URL("./runtime-replica-preload.cjs", import.meta.url)), fileURLToPath(new URL("../build/index.js", import.meta.url))],
    env: { PATH: process.env.PATH!, HOME: f.fixture.home, FLIGHTY_RUNTIME_MODE: "replica", FLIGHTY_RUNTIME_CONFIG: join(f.root, "linux.json"),
      FLIGHTY_READ_ONLY: readOnly, FLIGHTY_DB_PATH: "/must-never-open/MainFlightyDatabase.db", FLIGHTY_TEST_RUNTIME_ROOT: f.root }, stderr: "pipe" });
  let stderr = ""; transport.stderr?.on("data", chunk => { stderr += chunk.toString(); });
  const client = new Client({ name: "synthetic-replica-runtime-test", version: "1" });
  try { await client.connect(transport, { timeout: 5000 }); await check(client); } catch (error) { throw new Error(stderr + String(error)); }
  finally { await client.close(); await transport.close(); }
  expect(JSON.parse(readFileSync(join(f.root, "replica-guard.json"), "utf8")).forbidden).toBe(0);
}
it("actual replica stdio serves all original cached reads, preserves three write schemas and exposes status/copy", async () => {
  const f = await setup(true);
  await session(f, "", async client => {
    const listed = await client.listTools(); expect(listed.tools).toHaveLength(19);
    expect(listed.tools.map(t => t.name).sort()).toEqual([...READ_NAMES, ...WRITE_NAMES, "flighty_operation_status", "flighty_request_copy"].sort());
    for (const [name, args, check] of READ_CASES) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, name).not.toBe(true);
      const parsed = parseToolResult(result); check(parsed);
      if (name !== "flighty_about") expect(JSON.stringify(result)).toContain("replica");
    }
    const followed = await client.callTool({ name: "flighty_follow_flight", arguments: { flight_code: "ZZ101", date: "2026-11-11" } });
    const text = (followed.content as any[])[0].text; const id = JSON.parse(text).operation_id;
    expect(JSON.parse(text).status).toBe("pending"); expect(id).toBeTruthy();
    const status = await client.callTool({ name: "flighty_operation_status", arguments: { operation_id: id } }); expect(JSON.parse((status.content as any[])[0].text).status).toBe("pending");
  });
});
it("replica read-only retains honest copy/status actions and unavailable-cache about/error paths", async () => {
  const f = await setup(false);
  await session(f, "1", async client => {
    const listed = await client.listTools(); expect(listed.tools).toHaveLength(16);
    for (const name of WRITE_NAMES) expect(listed.tools.some(t => t.name === name)).toBe(false);
    const about = await client.callTool({ name: "flighty_about", arguments: {} }); expect(about.isError).not.toBe(true);
    const missing = await client.callTool({ name: "flighty_list_flights", arguments: {} }); expect(missing.isError).toBe(true);
    const copy = await client.callTool({ name: "flighty_request_copy", arguments: {} }); const body = JSON.parse((copy.content as any[])[0].text);
    expect(body.action).toBe("copy_refresh"); expect(body.status).toBe("pending"); expect(body.operation_id).toBeTruthy();
  });
});
