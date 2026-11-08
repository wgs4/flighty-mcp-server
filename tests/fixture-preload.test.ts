import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFixture, SYNTHETIC_TOKEN, SYNC_URL } from "./fixture/create.mjs";
import { fixtureTempRoot, trashFixture } from "./fixture/lifecycle.mjs";
import { fixtureEnvironment } from "./verify-stdio.mjs";

const preload = fileURLToPath(new URL("./fixture/preload.cjs", import.meta.url));

it("refuses to preload a database outside the marked fixture", () => {
  const fixture = createFixture(fixtureTempRoot());
  try {
    const env = fixtureEnvironment(fixture, undefined);
    env.FLIGHTY_DB_PATH = join(fixture.directory, "not-the-marked-database.db");
    const result = spawnSync(process.execPath, ["--require", preload, "-e", "throw Error('should not run')"], { env, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("outside its marked synthetic fixture");
  } finally { trashFixture(fixture.directory); }
});

it("mocks a removal request and promisified plist reader without installed credentials", () => {
  const fixture = createFixture(fixtureTempRoot());
  try {
    const code = `
      const {promisify} = await import('node:util');
      const {execFile} = await import('node:child_process');
      const {stdout} = await promisify(execFile)('/usr/bin/plutil', ['-extract', 'FlightyBuildToken', 'raw', '/synthetic/only']);
      if (stdout !== 'synthetic-build-token') throw Error('Unexpected build token');
      const response = await fetch(${JSON.stringify(SYNC_URL)}, {
        method: 'POST', redirect: 'error', body: ${JSON.stringify(fixture.ids.flight)}, headers: {authorization: ${JSON.stringify(`Bearer ${SYNTHETIC_TOKEN}`)}}
      });
      if (response.status !== 200) throw Error('Unexpected mock response');
    `;
    const result = spawnSync(process.execPath, ["--require", preload, "--input-type=module", "-e", code], {
      env: fixtureEnvironment(fixture, undefined, "mock-remove"), encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(fixture.directory, "fetch-calls.json"), "utf8"))).toEqual({ calls: 1, blockedNetworkAttempts: 0 });
  } finally { trashFixture(fixture.directory); }
});

it("blocks fetch and direct sockets even when mock-removal mode is enabled", () => {
  const fixture = createFixture(fixtureTempRoot());
  try {
    const code = `
      let blocks = 0;
      try { await fetch('https://example.invalid/forbidden'); } catch { blocks++; }
      const net = await import('node:net');
      try { net.connect(443, 'example.invalid'); } catch { blocks++; }
      if (blocks !== 2) throw Error('Network guard failed');
    `;
    const result = spawnSync(process.execPath, ["--require", preload, "--input-type=module", "-e", code], {
      env: fixtureEnvironment(fixture, undefined, "mock-remove"), encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(fixture.directory, "fetch-calls.json"), "utf8"))).toEqual({ calls: 1, blockedNetworkAttempts: 2 });
  } finally { trashFixture(fixture.directory); }
});
