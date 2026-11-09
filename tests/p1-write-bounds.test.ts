import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("../src/constants.js", () => ({
  AUTH_DB_PATH: "/synthetic/auth.sqlite",
  MAIN_DB_PATH: "/synthetic/main.db",
  PREFS_PLIST_PATH: "/synthetic/prefs.plist",
  FLIGHTY_API_BASE: "https://api.flightyapp.com",
  FLIGHTY_USER_AGENT: "synthetic-test-agent",
  getFlightyBuildToken: vi.fn(() => "synthetic-build"),
  FLIGHTY_BUILD_TOKEN: "",
}));

vi.mock("../src/services/auth-token.js", () => ({
  readFlightyAuthToken: vi.fn(() => "synthetic-jwt"),
  readJwtSubject: vi.fn(() => null),
}));

vi.mock("../src/services/sync-token.js", () => ({
  readFlightySyncUrl: vi.fn(() => "https://sync.flightyapp.com/v1"),
}));

import type { FlightyDatabase } from "../src/services/database.js";
import type { FlightyApi } from "../src/services/flighty-api.js";
import { registerWriteTools } from "../src/tools/write.js";

const AIRLINE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FLIGHT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};
type ToolHandler = (params: Record<string, unknown>) => Promise<ToolResult>;

function capture() {
  const tools = new Map<string, ToolHandler>();
  const schemas = new Map<string, z.ZodRawShape>();
  const lookupAirlines = vi.fn(() => [{ id: AIRLINE, name: "United Airlines", iata: "UA" }]);
  const searchFlight = vi.fn(async () => FLIGHT);
  const subscribeFlight = vi.fn(async () => undefined);
  const followFlight = vi.fn(async () => undefined);
  const server = {
    registerTool(name: string, config: { inputSchema: z.ZodRawShape }, handler: ToolHandler) {
      tools.set(name, handler);
      schemas.set(name, config.inputSchema);
    },
  } as unknown as McpServer;
  registerWriteTools(
    server,
    { lookupAirlines } as unknown as FlightyDatabase,
    { searchFlight, subscribeFlight, followFlight } as unknown as FlightyApi
  );
  return { tools, schemas, lookupAirlines, searchFlight, subscribeFlight, followFlight };
}

describe("write schemas", () => {
  it("rejects impossible dates, long codes, and non-UUIDs", () => {
    const { schemas } = capture();
    const add = z.object(schemas.get("flighty_add_flight")!);
    const remove = z.object(schemas.get("flighty_remove_flight")!);
    expect(add.safeParse({ flight_code: "UA194", date: "2026-04-15" }).success).toBe(true);
    expect(add.safeParse({ flight_code: "UA194", date: "2024-02-29" }).success).toBe(true);
    expect(add.safeParse({ flight_code: "UA194", date: "2026-02-29" }).success).toBe(false);
    expect(add.safeParse({ flight_code: "UA194", date: "2026-02-31" }).success).toBe(false);
    expect(add.safeParse({ flight_code: "UA194", date: "1899-12-31" }).success).toBe(false);
    expect(add.safeParse({ flight_code: "U".repeat(21), date: "2026-04-15" }).success).toBe(
      false
    );
    expect(remove.safeParse({ flight_id: FLIGHT }).success).toBe(true);
    expect(remove.safeParse({ flight_id: "not-a-uuid" }).success).toBe(false);
    const badId = remove.safeParse({ flight_id: "not-a-uuid" });
    if (!badId.success) {
      expect(JSON.stringify(badId.error.issues)).not.toContain("not-a-uuid");
    }
  });
});

describe("write handlers", () => {
  it("keeps the add result fields and stops bad input before lookup", async () => {
    const captured = capture();
    const added = await captured.tools.get("flighty_add_flight")!({
      flight_code: "UA194",
      date: "2026-06-15",
    });
    expect(added.isError).toBeUndefined();
    expect(JSON.parse(added.content[0].text)).toEqual({
      status: "added",
      flight_code: "UA194",
      date: "2026-06-15",
      airline: "United Airlines",
      server_flight_uuid: FLIGHT,
      message:
        "Flight added to your Flighty account. It will appear on all your devices within seconds.",
    });
    expect(captured.subscribeFlight).toHaveBeenCalledWith(FLIGHT);

    const badDate = await captured.tools.get("flighty_follow_flight")!({
      flight_code: "UA194",
      date: "2026-13-01",
    });
    expect(badDate.isError).toBe(true);
    expect(badDate.content[0].text).toContain("calendar date");
    expect(captured.lookupAirlines).toHaveBeenCalledTimes(1);

    const longCode = await captured.tools.get("flighty_add_flight")!({
      flight_code: "UA12345678901234567890",
      date: "2026-06-15",
    });
    expect(longCode.isError).toBe(true);
    expect(longCode.content[0].text).not.toContain("UA12345678901234567890");
    expect(captured.searchFlight).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-UUID remove id before lookup", async () => {
    const getFlight = vi.fn();
    const tools = new Map<string, ToolHandler>();
    const server = {
      registerTool(_name: string, _schema: unknown, handler: ToolHandler) {
        tools.set(_name, handler);
      },
    } as unknown as McpServer;
    registerWriteTools(
      server,
      { getFlight } as unknown as FlightyDatabase,
      { deleteFlight: vi.fn() } as unknown as FlightyApi
    );
    const result = await tools.get("flighty_remove_flight")!({ flight_id: "server-only" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Flight id must be a UUID");
    expect(result.content[0].text).not.toContain("server-only");
    expect(getFlight).not.toHaveBeenCalled();
  });
});
