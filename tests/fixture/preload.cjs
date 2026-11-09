// Loaded only by the synthetic stdio harness. Never delegates a fetch to the network.
const fs = require("node:fs");
const path = require("node:path");
const { syncBuiltinESMExports } = require("node:module");
const childProcess = require("node:child_process");
const net = require("node:net");
const dgram = require("node:dgram");

const directory = process.env.FLIGHTY_TEST_FIXTURE_DIR;
if (!directory) throw new Error("Synthetic fixture directory required for test preload.");
const marker = JSON.parse(fs.readFileSync(path.join(directory, ".flighty-synthetic-fixture.json"), "utf8"));
if (marker.kind !== "flighty-synthetic-v1" || marker.mainPath !== process.env.FLIGHTY_DB_PATH ||
    marker.home !== process.env.HOME || path.dirname(marker.mainPath) !== path.resolve(directory)) {
  throw new Error("Test preload refuses a database outside its marked synthetic fixture.");
}
const { DatabaseSync } = require("node:sqlite");
const fixtureDb = new DatabaseSync(marker.mainPath, { readOnly: true });
const token = fixtureDb.prepare("SELECT authToken FROM Account").get().authToken;
fixtureDb.close();
if (!token.startsWith("fixture.") || !token.endsWith(".not-a-real-signature")) {
  throw new Error("Test preload requires synthetic credentials.");
}
let blockedNetworkAttempts = 0;
const deny = () => {
  blockedNetworkAttempts += 1;
  record();
  throw new Error("Network access is forbidden in synthetic Flighty tests.");
};
net.Socket.prototype.connect = deny;
net.connect = deny;
net.createConnection = deny;
require("node:tls").connect = deny;
dgram.createSocket = deny;

let calls = 0;
function record() {
  fs.writeFileSync(path.join(directory, "fetch-calls.json"), JSON.stringify({ calls, blockedNetworkAttempts }));
}
record();
globalThis.fetch = async (input, options) => {
  calls += 1;
  record();
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (process.env.FLIGHTY_TEST_FETCH_MODE !== "mock-remove" ||
      url.origin !== "https://sync.flightyapp.com" || url.pathname !== "/synthetic-fixture" ||
      options?.method !== "POST") deny();
  const headers = new Headers(options.headers);
  if (headers.get("authorization") !== `Bearer ${token}`) throw new Error("Only fixture credentials are accepted.");
  const allowedIds = [marker.ids.flight, marker.ids.followed, marker.ids.uncached];
  const requestedIds = Buffer.from(options.body ?? []).toString("utf8").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
  if (options.redirect !== "error" || requestedIds.length !== 1 || !allowedIds.includes(requestedIds[0])) {
    throw new Error("Mock deletion requires redirect rejection and the exact previewed fixture UUID.");
  }
  return new Response(new Uint8Array(), { status: 200 });
};
// Support both the old eager reader and P2's lazy execFile reader without consulting the app.
childProcess.execSync = (command) => {
  if (typeof command === "string" && command.startsWith("plutil -extract FlightyBuildToken ")) return "synthetic-build-token";
  throw new Error("External commands are forbidden in synthetic Flighty tests.");
};
childProcess.execFileSync = (file, args) => {
  if (file === "/usr/bin/plutil" && args?.includes("FlightyBuildToken")) return "synthetic-build-token";
  throw new Error("External commands are forbidden in synthetic Flighty tests.");
};
childProcess.execFile = (file, args, options, callback) => {
  const cb = typeof options === "function" ? options : callback;
  const ok = file === "/usr/bin/plutil" && args?.includes("FlightyBuildToken");
  queueMicrotask(() => cb(ok ? null : new Error("External commands are forbidden in synthetic Flighty tests."), ok ? "synthetic-build-token" : "", ""));
  return { pid: 0 };
};
childProcess.execFile[require("node:util").promisify.custom] = async (file, args) => ({
  stdout: childProcess.execFileSync(file, args), stderr: "",
});
syncBuiltinESMExports();
