import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FlightyDatabase } from "../src/services/database.js";
import { FlightyApi } from "../src/services/flighty-api.js";
import { installToolSafety } from "../src/services/tool-safety.js";
import { registerFlightTools } from "../src/tools/flights.js";
import { registerWriteTools } from "../src/tools/write.js";
import { createFixture, IDS } from "./fixture/create.mjs";
import { fixtureTempRoot, trashFixture } from "./fixture/lifecycle.mjs";

const UNCACHED = "77777777-7777-4777-8777-777777777777";
let fixture: ReturnType<typeof createFixture>;
let client: Client;
let server: McpServer;
let fetchImpl: ReturnType<typeof vi.fn>;
let db: FlightyDatabase;

function mutate(fn: (raw: DatabaseSync) => void) {
  const raw = new DatabaseSync(fixture.mainPath);
  try { fn(raw); } finally { raw.close(); }
}

async function connect(path = fixture.mainPath) {
  db = new FlightyDatabase(path, fixture.legacyPath);
  fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
  const api = new FlightyApi({
    policy: { mode: "read-write", extraSyncHosts: new Set() },
    fetchImpl,
    readAuthToken: () => "synthetic-injected-token",
    readSyncUrl: () => "https://sync.flightyapp.com/synthetic-fixture",
    getBuildToken: () => "synthetic-injected-build",
  });
  server = new McpServer({ name: "integration-removal-synthetic", version: "1.0.0" });
  installToolSafety(server, db);
  registerFlightTools(server, db);
  registerWriteTools(server, db, api);
  client = new Client({ name: "integration-test", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
}

function remove(id: string, code?: string) {
  return client.callTool({ name: "flighty_remove_flight", arguments: {
    flight_id: id, ...(code ? { confirm_code: code } : {}),
  } });
}
function text(result: Awaited<ReturnType<typeof remove>>) {
  return (result.content as Array<{ text: string }>)[0].text;
}
function body(result: Awaited<ReturnType<typeof remove>>) {
  expect(result.isError).toBeFalsy();
  return JSON.parse(text(result));
}
async function preview(id: string) {
  const before = fetchImpl.mock.calls.length;
  const result = body(await remove(id));
  expect(result.status).toBe("confirmation_required");
  expect(result.confirm_code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  expect(result.data_trust_label).toBe("untrusted_external_data");
  expect(fetchImpl).toHaveBeenCalledTimes(before);
  return result;
}
async function confirmAndReplay(id: string, code: string) {
  const before = fetchImpl.mock.calls.length;
  expect(body(await remove(id, code)).status).toBe("removed");
  expect(fetchImpl).toHaveBeenCalledTimes(before + 1);
  const [url, options] = fetchImpl.mock.calls.at(-1)!;
  expect(url).toBe("https://sync.flightyapp.com/synthetic-fixture?fast_flight_sync=true");
  expect(options.redirect).toBe("error");
  expect(Buffer.from(options.body).includes(Buffer.from(id))).toBe(true);
  expect((await remove(id, code)).isError).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(before + 1);
}

beforeEach(() => { fixture = createFixture(fixtureTempRoot()); });
afterEach(async () => {
  await client?.close();
  await server?.close();
  vi.stubEnv("FLIGHTY_OWNER_USER_ID", "");
  trashFixture(fixture.directory);
});

describe("integrated SQLite and actual MCP removal", () => {
  it.each([["UserFlight", IDS.flight], ["UserManualFlight", IDS.manual]])(
    "looks up owner's followed row in %s and preserves read passenger semantics", async (table, id) => {
      mutate(raw => {
        raw.prepare(`UPDATE ${table} SET isMyFlight=0 WHERE flightId=? AND userId=?`).run(id, IDS.owner);
        raw.prepare(`INSERT INTO ${table} VALUES (?, ?, 'friend', NULL, 1)`).run(IDS.friend, id);
        raw.prepare("DELETE FROM Ticket WHERE flightId=? AND userId=?").run(id, IDS.owner);
        raw.prepare("INSERT INTO Ticket VALUES (?, ?, '2B', 'aisle', 'business', 'OWNER-FOLLOW-PNR', 'work')").run(id, IDS.owner);
        raw.prepare("INSERT INTO Ticket VALUES (?, ?, '9Z', 'middle', 'economy', 'FRIEND-SECRET', 'friend')").run(id, IDS.friend);
      });
      await connect();
      expect(db.getFlight({ flight_id: id })).toBeNull();
      const p = await preview(id);
      expect(p).toMatchObject({ local_record: "followed", local_identity: "signed_in_owner", owner_label: "signed_in_owner" });
      expect(p.flight.owner_identity.user_id).toBe(IDS.owner);
      expect(p.flight).toMatchObject({ booking_reference: "OWNER-FOLLOW-PNR", seat_number: "2B", cabin_class: "business" });
      expect(JSON.stringify(p)).not.toContain("FRIEND-SECRET");
      await confirmAndReplay(id, p.confirm_code);
    }
  );

  it.each([null, "", "missing-profile"])("does not infer ownership from friend name %s", async name => {
    mutate(raw => {
      raw.prepare("INSERT INTO Ticket VALUES (?, ?, '9Z', 'middle', 'economy', 'FRIEND-SECRET', 'friend')").run(IDS.friendFlight, IDS.friend);
      if (name === "missing-profile") raw.exec("DELETE FROM Profile");
      else raw.prepare("UPDATE Profile SET fullName=?").run(name);
    });
    await connect();
    const p = await preview(IDS.friendFlight);
    expect(p).toMatchObject({ local_details: "unavailable", local_identity: "unavailable", local_record: "none" });
    expect(p.owner_identity).toBeUndefined();
    expect(p.owner_label).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain("FRIEND-SECRET");
    await confirmAndReplay(IDS.friendFlight, p.confirm_code);
  });

  it("permits uncached preview and confirmation with an empty owner cache", async () => {
    mutate(raw => raw.exec("DELETE FROM UserFlight; DELETE FROM UserManualFlight"));
    await connect();
    const p = await preview(UNCACHED);
    expect(p.flight).toEqual({ id: UNCACHED, local_details: "unavailable", local_identity: "unavailable" });
    expect(p.owner_identity).toBeUndefined();
    await confirmAndReplay(UNCACHED, p.confirm_code);
  });

  it("permits exact-ID removal when local DB is missing using injected API readers", async () => {
    await connect(join(fixture.directory, "missing-synthetic.db"));
    const p = await preview(UNCACHED);
    expect(p.local_details).toBe("unavailable");
    expect(p.owner_identity).toBeUndefined();
    expect(p.message).not.toContain("matches");
    await confirmAndReplay(UNCACHED, p.confirm_code);
  });

  it.each(["fallback", "pinned"])("labels %s local preview with P2 owner metadata and full ticket fields", async mode => {
    if (mode === "fallback") mutate(raw => raw.exec("DELETE FROM Account"));
    else vi.stubEnv("FLIGHTY_OWNER_USER_ID", IDS.owner);
    await connect();
    const p = await preview(IDS.flight);
    const label = mode === "fallback" ? "shared_or_fallback_owner" : "pinned_owner_override";
    expect(p.owner_label).toBe(label);
    expect(p.local_identity).toBe(label);
    expect(p.owner_identity).toEqual(p.flight.owner_identity);
    expect(p.owner_identity.user_id).toBe(IDS.owner);
    expect(p.owner_warning).toBeTruthy();
    expect(p.note).toContain(label);
    expect(p.flight).toMatchObject({ booking_reference: "SYNTHETIC-PNR", seat_number: "1A", cabin_class: "economy" });
    await confirmAndReplay(IDS.flight, p.confirm_code);
  });

  it("requires a fresh preview when only displayed owner identity changes", async () => {
    await connect();
    const p = await preview(IDS.flight);
    vi.stubEnv("FLIGHTY_OWNER_USER_ID", IDS.owner);
    const changed = await remove(IDS.flight, p.confirm_code);
    expect(changed.isError).toBe(true);
    expect(text(changed)).toContain("flight changed");
    expect(fetchImpl).not.toHaveBeenCalled();
    const fresh = await preview(IDS.flight);
    expect(fresh.flight.id).toBe(p.flight.id);
    expect(fresh.owner_identity.source).toBe("env_override");
    await confirmAndReplay(IDS.flight, fresh.confirm_code);
  });

  it("requires a fresh preview when a previously identified local lookup fails", async () => {
    await connect();
    const p = await preview(IDS.flight);
    mutate(raw => raw.exec("DROP TABLE Flight"));
    expect((await remove(IDS.flight, p.confirm_code)).isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    const fresh = await preview(IDS.flight);
    expect(fresh.local_identity).toBe("unavailable");
    expect(fresh.owner_identity).toBeUndefined();
    await confirmAndReplay(IDS.flight, fresh.confirm_code);
  });

  it("keeps concurrent fallback labels and consumes a removal code before awaiting the API", async () => {
    mutate(raw => raw.exec("DELETE FROM Account"));
    await connect();
    const [p, invalid] = await Promise.all([
      preview(IDS.flight), client.callTool({ name: "flighty_get_flight", arguments: {} }),
    ]);
    expect(invalid.isError).toBe(true);
    expect(p.owner_label).toBe("shared_or_fallback_owner");
    let release!: () => void;
    fetchImpl.mockImplementationOnce(() => new Promise<Response>(resolve => {
      release = () => resolve(new Response(null, { status: 200 }));
    }));
    const first = remove(IDS.flight, p.confirm_code);
    const replay = await remove(IDS.flight, p.confirm_code);
    expect(replay.isError).toBe(true);
    expect(text(replay)).toContain("already used");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release();
    expect(body(await first).status).toBe("removed");
  });

  it("keeps failed deletion consumed and returns fixed text for unexpected non-home paths", async () => {
    await connect();
    const p = await preview(IDS.flight);
    fetchImpl.mockRejectedValueOnce(new Error("/Volumes/SYNTHETIC/private.db secret-response"));
    const failed = await remove(IDS.flight, p.confirm_code);
    expect(failed.isError).toBe(true);
    expect(text(failed)).not.toMatch(/Volumes|private.db|secret-response/);
    expect((await remove(IDS.flight, p.confirm_code)).isError).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
