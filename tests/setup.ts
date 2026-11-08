import { afterAll, vi } from "vitest";
import { createFixture } from "./fixture/create.mjs";
import { fixtureTempRoot, trashFixture } from "./fixture/lifecycle.mjs";

const fixture = createFixture(fixtureTempRoot());
vi.stubEnv("HOME", fixture.home);
vi.stubEnv("FLIGHTY_DB_PATH", fixture.mainPath);
vi.stubEnv("FLIGHTY_READ_ONLY", "");
vi.stubEnv("FLIGHTY_OWNER_USER_ID", "");
vi.stubEnv("FLIGHTY_EXTRA_SYNC_HOSTS", "");
vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden: mock fetch explicitly in synthetic tests."); }));

// Prevent eager and lazy plist readers from touching the installed Flighty app.
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const execFile = vi.fn((_file, _args, options, callback) => {
    const cb = typeof options === "function" ? options : callback;
    queueMicrotask(() => cb(null, "synthetic-build-token", ""));
    return { pid: 0 };
  });
  Object.assign(execFile, {
    [Symbol.for("nodejs.util.promisify.custom")]: async () => ({ stdout: "synthetic-build-token", stderr: "" }),
  });
  return {
    ...actual,
    execSync: vi.fn(() => "synthetic-build-token"),
    execFileSync: vi.fn(() => "synthetic-build-token"),
    execFile,
  };
});
vi.mock("child_process", async () => import("node:child_process"));
vi.mock("node:net", async (original) => {
  const actual = await original<typeof import("node:net")>();
  const deny = () => { throw new Error("Network forbidden in tests."); };
  actual.Socket.prototype.connect = deny as typeof actual.Socket.prototype.connect;
  return { ...actual, connect: deny, createConnection: deny };
});

// Eagerly activate the socket guard before importing any runtime code.
await import("node:net");

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  trashFixture(fixture.directory);
});
