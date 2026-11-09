import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FlightyDatabase } from "../services/database.js";
import { installToolSafety } from "../services/tool-safety.js";
import {
  DEFAULT_PAGE_LIMIT,
  pageLimitSchema,
  pageOffsetSchema,
} from "../services/validation.js";

export function registerConnectionTools(
  server: McpServer,
  db: FlightyDatabase
): void {
  installToolSafety(server, db);

  server.registerTool(
    "flighty_get_connections",
    {
      title: "Get Flight Connections",
      description: `Get layover/connection information for the user's flights. Shows pairs of connecting flights, the connection airport, layover duration, and minimum connection time.

Results sorted by the first leg's departure time descending (most recent first). All timestamps are UTC.

Returns: id, inbound_flight (first leg, e.g. "AA1449"), from_airport, connection_airport, connection_airport_name, outbound_flight (second leg, e.g. "AA1166"), to_airport, arrival_time, departure_time, layover_minutes, min_connection_time_min.`,
      inputSchema: {
        limit: pageLimitSchema.describe(
          "Maximum number of connections to return"
        ),
        offset: pageOffsetSchema.describe(
          "Number of connections to skip for pagination"
        ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const limit = params?.limit ?? DEFAULT_PAGE_LIMIT;
      const offset = params?.offset ?? 0;
      const connections = db.getConnections({ limit, offset });
      const wrapped = {
        note: "Sorted by first leg departure, most recent first. All timestamps are UTC.",
        count: connections.length,
        limit,
        offset,
        results: connections,
      };
      return {
        content: [
          { type: "text", text: JSON.stringify(wrapped, null, 2) },
        ],
      };
    }
  );
}
