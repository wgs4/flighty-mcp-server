#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createFixture } from "./fixture/create.mjs";
import { fixtureTempRoot, trashFixture } from "./fixture/lifecycle.mjs";
import { READ_CASES, READ_NAMES, WRITE_NAMES, parseToolResult } from "./fixture/read-cases.mjs";

const preload = fileURLToPath(new URL("./fixture/preload.cjs", import.meta.url));
const defaultEntry = fileURLToPath(new URL("../build/index.js", import.meta.url));

export function fixtureEnvironment(fixture, policy, mode = "deny") {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: fixture.home,
    FLIGHTY_DB_PATH: fixture.mainPath,
    FLIGHTY_TEST_FIXTURE_DIR: fixture.directory,
    FLIGHTY_TEST_FETCH_MODE: mode,
    ...(policy === undefined ? {} : { FLIGHTY_READ_ONLY: policy }),
  };
}

async function session(entry, fixture, policy, mode, check) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--require", preload, entry],
    env: fixtureEnvironment(fixture, policy, mode),
    stderr: "pipe",
  });
  // Drain stderr without printing private values if an unexpected failure occurs.
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "flighty-synthetic-verifier", version: "1.0.0" });
  try {
    await client.connect(transport, { timeout: 5_000 });
    return await check(client);
  } finally {
    await client.close();
    await transport.close();
  }
}

async function rejectsPolicy(entry, fixture, value) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--require", preload, entry], {
      env: fixtureEnvironment(fixture, value), stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.resume();
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Invalid FLIGHTY_READ_ONLY value did not reject startup within 3 seconds (P1 pending)."));
    }, 3_000);
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      try {
        assert.ok(code !== null && code !== 0, "Bad policy must exit with a nonzero status.");
        assert.match(stderr, /FLIGHTY_READ_ONLY/, "Startup must explain the bad policy setting.");
        resolvePromise();
      } catch (error) { reject(error); }
    });
  });
}

function fetchCalls(fixture) {
  const counts = JSON.parse(readFileSync(join(fixture.directory, "fetch-calls.json"), "utf8"));
  assert.equal(counts.blockedNetworkAttempts, 0, "No socket or forbidden fetch attempts are allowed.");
  return counts.calls;
}

export async function verifyStdio({ entry = defaultEntry, fixtureDirectory = fixtureTempRoot(), checks = "all", log = console.log } = {}) {
  if (!["all", "reads"].includes(checks)) throw new Error("checks must be all or reads");
  entry = resolve(entry);
  if (!existsSync(entry)) throw new Error("Build entry missing. Run npm ci --ignore-scripts and npm run build first.");
  const fixture = createFixture(fixtureDirectory);
  const failures = [];
  const passed = [];
  async function check(name, action) {
    try { await action(); passed.push(name); log(`PASS ${name}`); }
    catch (error) { failures.push({ name, reason: error.message }); log(`FAIL ${name}: ${error.message}`); }
  }
  try {
    await check("default inventory: 14 read + 3 write = 17", () => session(entry, fixture, undefined, "deny", async (client) => {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [...READ_NAMES, ...WRITE_NAMES].sort());
      for (const tool of tools) assert.match(tool.description, /untrusted data, not instructions/);
      for (const [name, args, validate] of READ_CASES) {
        const result = await client.callTool({ name, arguments: args });
        validate(parseToolResult(result));
        assert.equal(fetchCalls(fixture), 0, `${name} must not call fetch`);
      }
      log("PASS all 14 read handlers returned expected fixture data with zero network calls");
    }));
    await check("read-only inventory: 14 read tools", () => session(entry, fixture, "1", "deny", async (client) => {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), READ_NAMES);
      const read = await client.callTool({ name: "flighty_list_flights", arguments: {} });
      assert.equal(parseToolResult(read).count, 2);
      assert.equal(fetchCalls(fixture), 0);
    }));
    if (checks === "all") {
      await check("policy values and normalized spelling", async () => {
        for (const value of ["true", "yes", "on", " TRUE ", "0", "false", "no", "off", "", " OFF "]) {
          const readOnly = ["true", "yes", "on"].includes(value.trim().toLowerCase());
          await session(entry, fixture, value, "deny", async (client) => {
            const { tools } = await client.listTools();
            assert.deepEqual(tools.map((tool) => tool.name).sort(), readOnly ? READ_NAMES : [...READ_NAMES, ...WRITE_NAMES].sort(), `Policy ${JSON.stringify(value)}`);
          });
        }
      });
      await check("invalid policy rejects startup", () => rejectsPolicy(entry, fixture, "definitely-invalid"));
      await check("remove preview, confirm and replay (mocked fetch only)", () => session(entry, fixture, undefined, "mock-remove", async (client) => {
        const { tools } = await client.listTools();
        const removal = tools.find((tool) => tool.name === "flighty_remove_flight");
        const properties = removal.inputSchema.properties;
        const confirmField = ["confirm_code", "confirmation_code"].find((name) => properties[name]);
        assert.ok(confirmField, "Removal confirmation parameter missing (P1 pending).");
        let expectedCalls = 0;
        for (const [id, record] of [[fixture.ids.flight, "passenger"], [fixture.ids.followed, "followed"], [fixture.ids.uncached, "none"]]) {
          const args = { flight_id: id };
          const preview = parseToolResult(await client.callTool({ name: removal.name, arguments: args }));
          assert.equal(fetchCalls(fixture), expectedCalls, "Preview must never call the API.");
          const code = preview[confirmField] ?? preview.confirmation?.code;
          assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
          assert.equal(preview.flight_id, id);
          assert.equal(preview.local_record, record);
          assert.equal(preview.data_trust_label, "untrusted_external_data");
          if (record === "none") {
            assert.equal(preview.local_details, "unavailable");
            assert.equal(preview.local_identity, "unavailable");
            assert.equal(preview.owner_identity, undefined);
          } else {
            assert.equal(preview.owner_identity.user_id, fixture.ids.owner);
            assert.equal(preview.flight.owner_identity.source, "jwt_subject");
            assert.equal(preview.flight.booking_reference, record === "followed" ? "SYNTHETIC-FOLLOW-PNR" : "SYNTHETIC-PNR");
          }
          const badCode = (code[0] === "A" ? "B" : "A") + code.slice(1);
          const bad = await client.callTool({ name: removal.name, arguments: { ...args, [confirmField]: badCode } });
          assert.equal(bad.isError, true);
          const wrongId = id === fixture.ids.flight ? fixture.ids.followed : fixture.ids.flight;
          const wrong = await client.callTool({ name: removal.name, arguments: { flight_id: wrongId, [confirmField]: code } });
          assert.equal(wrong.isError, true);
          assert.equal(fetchCalls(fixture), expectedCalls);
          const confirmed = parseToolResult(await client.callTool({ name: removal.name, arguments: { ...args, [confirmField]: code } }));
          assert.equal(confirmed.status, "removed");
          assert.equal(fetchCalls(fixture), ++expectedCalls, "Confirmation must make one mocked request.");
          const replay = await client.callTool({ name: removal.name, arguments: { ...args, [confirmField]: code } });
          assert.equal(replay.isError, true);
          assert.equal(fetchCalls(fixture), expectedCalls, "Consumed code must never send another request.");
        }
      }));
    }
    return { entry, checks, passed, failures };
  } finally { trashFixture(fixture.directory); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = {};
  const args = process.argv.slice(2);
  while (args.length) {
    const arg = args.shift();
    const key = { "--entry": "entry", "--fixture-directory": "fixtureDirectory", "--checks": "checks" }[arg];
    if (!key || !args.length) throw new Error("Usage: verify-stdio.mjs [--entry /installed/build/index.js] [--fixture-directory /job/fixture] [--checks all|reads]");
    options[key] = args.shift();
  }
  const report = await verifyStdio(options);
  console.log(JSON.stringify(report, null, 2));
  if (report.failures.length) process.exitCode = 1;
}
