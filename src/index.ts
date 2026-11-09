#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FlightyDatabase } from "./services/database.js";
import { FlightyApi } from "./services/flighty-api.js";
import { registerFlightTools } from "./tools/flights.js";
import { registerFlightStatusTools } from "./tools/flight-status.js";
import { registerFriendTools } from "./tools/friends.js";
import { registerReferenceTools } from "./tools/reference.js";
import { registerStatsTools } from "./tools/stats.js";
import { registerConnectionTools } from "./tools/connections.js";
import { registerTrackingTools } from "./tools/tracking.js";
import { runtimeMode, readConfig } from "./runtime/config.js";
import { openLinux, type LinuxRuntime } from "./runtime/linux.js";
import { registerRemoteWriteTools } from "./remote/client.js";
import { registerWriteTools } from "./tools/write.js";
import { installToolSafety } from "./services/tool-safety.js";
import {
  formatPolicyStartupError,
  loadRuntimePolicy,
  writesEnabled,
  type RuntimePolicy,
} from "./services/policy.js";

const VERSION = "1.10.1";

function readStartupPolicy(): RuntimePolicy {
  try {
    return loadRuntimePolicy();
  } catch (error) {
    console.error(formatPolicyStartupError(error));
    process.exit(1);
  }
}

const policy = readStartupPolicy();
const readOnly = !writesEnabled(policy);

const server = new McpServer({
  name: "flighty-mcp-server",
  version: VERSION,
});

let runtime: LinuxRuntime | undefined;
try {
  if (runtimeMode() === "replica") runtime = openLinux(readConfig(process.env.FLIGHTY_RUNTIME_CONFIG, "linux"));
} catch {
  console.error("Flighty runtime unavailable: invalid configuration or durable continuity. No automatic initialization.");
  process.exit(1);
}
const db = runtime?.db ?? new FlightyDatabase();
installToolSafety(server, db, runtime ? { replicaReceiver: runtime.receiver, replicaBudget: runtime.config.budget } : undefined);
registerFlightTools(server, db);
registerFlightStatusTools(server, db);
registerFriendTools(server, db);
registerReferenceTools(server, db);
registerStatsTools(server, db);
registerConnectionTools(server, db);
registerTrackingTools(server, db);
if (!readOnly) {
  if (runtime) registerRemoteWriteTools(server, { client: runtime.client, policy, macReceiptKey: runtime.macReceiptKey,
    rememberRequest: request => runtime!.durable.remember(request) });
  else registerWriteTools(server, db, new FlightyApi({ policy }));
}

runtime?.durable.registerTools(server);

server.registerTool(
  "flighty_about",
  {
    title: "About Flighty MCP",
    description: "Returns version, author, and capability information about this Flighty MCP server.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const about = {
      name: "Flighty MCP Server",
      version: VERSION,
      author: "CPLX",
      repository: "https://github.com/CPLX/flighty-mcp-server",
      description: runtime ? "Verified cached replica reads and authenticated Mac mutation receipts. Copy refresh does not request upstream Flighty sync." :
        "MCP server for the Flighty flight tracking app. Reads flight data from Flighty's local database and syncs changes via Flighty's API.",
      mode: readOnly ? "read-only" : "read-write",
      tools: {
        read: [
          "flighty_list_flights — list your flights (upcoming, by year, or all)",
          "flighty_current_flights — active travel context (±24 hours from now)",
          "flighty_get_flight — look up a single flight by ID or flight number",
          "flighty_search_flights — search by airline, airport, or date range",
          runtime ? "flighty_get_flight_status — cached status, gate, delay, weather" : "flighty_get_flight_status — current status, gate, delay, weather",
          "flighty_get_delay_forecast — historical on-time performance",
          "flighty_get_flight_stats — aggregate stats (miles, airlines, routes)",
          "flighty_get_connections — layover and connection info",
          "flighty_get_tracking_status — exact UUID, cached runway/gate phases, countdowns and passenger provenance",
          "flighty_check_connection — check a proposed pair of eligible cached flight UUIDs without assuming traveler identity",
          "flighty_list_friend_flights — cached shared passenger/followed flights; friendship unverified",
          "flighty_search_airports — airport lookup by code, city, or name",
          "flighty_search_airlines — airline lookup by code, name, or alliance",
        ],
        write: readOnly
          ? [
              "(disabled — FLIGHTY_READ_ONLY is set. Unset it or uncheck the Read-Only Mode option in Claude Desktop to enable.)",
            ]
          : [
              "flighty_add_flight — add a flight (syncs to all devices)",
              "flighty_follow_flight — follow a flight without being a passenger (syncs to all devices)",
              "flighty_remove_flight — preview a flight, then confirm removal (syncs to all devices)",
            ],
      },
      runtime: runtime ? "replica" : "local",
      cache_note: runtime ? "Verified replica of a Mac cache; copy freshness is separate from unverified Flighty source sync. Producer provenance is not signed-in Mac identity." : "Local Flighty cache",
      replica_actions: runtime ? ["flighty_operation_status", "flighty_request_copy (copy_refresh only)"] : [],
      requirements: runtime ? "Explicit provisioned private storage, pinned producer and authenticated Mac courier; no upstream refresh claim" : "macOS with Flighty app installed and signed in",
    };
    return {
      content: [{ type: "text", text: JSON.stringify(about, null, 2) }],
    };
  }
);

async function main() {
  const ipc = await runtime?.listen();
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    try { await ipc?.close(); runtime?.close(); await server.close(); } finally { process.exit(0); }
  };
  process.once("SIGTERM", () => void stop()); process.once("SIGINT", () => void stop());
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const protocolClose = transport.onclose;
  transport.onclose = () => { protocolClose?.(); void stop(); };
  console.error(
    `Flighty MCP server running via stdio (${readOnly ? "read-only" : "read-write"} mode)`
  );
}

main().catch((error) => {
  console.error("Flighty server unavailable; inspect private configuration and continuity.");
  process.exit(1);
});
