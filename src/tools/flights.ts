import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FlightyDatabase } from "../services/database.js";
import { installToolSafety } from "../services/tool-safety.js";
import {
  DEFAULT_PAGE_LIMIT,
  boundedQuerySchema,
  flightNumberSchema,
  isoDateSchema,
  pageLimitSchema,
  pageOffsetSchema,
  uuidSchema,
  validateGetFlightSelectors,
  yearSchema,
} from "../services/validation.js";

export function registerFlightTools(
  server: McpServer,
  db: FlightyDatabase
): void {
  installToolSafety(server, db);

  server.registerTool(
    "flighty_list_flights",
    {
      title: "List My Flights",
      description: `List the user's flights from Flighty. Does NOT include friends' flights (use flighty_list_friend_flights for that).

Filtering:
- No filter: returns ALL flights (upcoming + past), sorted by departure date descending (most recent first)
- upcoming_only=true: only flights with future departures, sorted soonest first — the first result is the user's next flight
- year=2025: only flights from that year, sorted descending (matches the app's past-by-year view)

NOTE: upcoming_only only returns flights that have not yet departed. For the user's current travel context (in-progress flights, recently landed, about to depart), use flighty_current_flights instead.

All timestamps are UTC.`,
      inputSchema: {
        upcoming_only: z
          .boolean()
          .default(false)
          .describe("Only return flights departing in the future (sorted soonest first)"),
        year: yearSchema
          .optional()
          .describe("Filter to a specific year (e.g. 2025). Shows past flights from that year, matching the Flighty app's year view."),
        limit: pageLimitSchema.describe("Maximum number of flights to return"),
        offset: pageOffsetSchema.describe("Number of flights to skip for pagination"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const flights = db.listFlights(params);
      const note = params.upcoming_only
        ? "Sorted soonest first. The first result is the next flight. All timestamps are UTC."
        : "Sorted most recent departure first. All timestamps are UTC.";
      const wrapped = {
        note,
        count: flights.length,
        results: flights,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }],
      };
    }
  );

  server.registerTool(
    "flighty_get_flight",
    {
      title: "Get Flight Details",
      description: `Get detailed information about a single specific flight. Look up by either internal flight ID (UUID) or by flight number (e.g. "UA194").

Provide Rich/exact selector: provide exactly one of flight_id or flight_number (mutually exclusive). If flight_number is provided and the user has flown that route multiple times, returns only the MOST RECENT instance. To see all instances, use flighty_search_flights with the airline filter instead.

All timestamps are UTC. Returns a single flight object, or null if not found.`,
      inputSchema: {
        flight_id: uuidSchema
          .optional()
          .describe("Internal Flighty flight UUID"),
        flight_number: flightNumberSchema
          .optional()
          .describe(
            'Flight number, e.g. "UA194". Spaces, hyphens, and case are normalized.'
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
      const selectorCheck = validateGetFlightSelectors(params);
      if (!selectorCheck.ok) {
        return {
          content: [
            {
              type: "text",
              text: selectorCheck.error,
            },
          ],
          isError: true,
        };
      }
      const flight = db.getFlight({
        flight_id: selectorCheck.flight_id,
        flight_number: selectorCheck.flight_number,
      });
      if (!flight) {
        return {
          content: [
            {
              type: "text",
              text: `No flight found. ${params.flight_number ? `Check the flight number format (e.g. 'UA194') or use flighty_search_flights to browse.` : "Check the flight ID."}`,
            },
          ],
        };
      }
      const wrapped = {
        note: "All timestamps are UTC.",
        result: flight,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }],
      };
    }
  );

  server.registerTool(
    "flighty_search_flights",
    {
      title: "Search Flights",
      description: `Search the user's flight history by airline, departure/arrival airports, or date range. All filters are optional and combine with AND logic.

Results sorted by departure date descending (most recent first). All timestamps are UTC.

Airport filters match by IATA code (exact, case-insensitive) OR by city name (partial, case-insensitive). Airline filter matches by IATA code (exact) OR airline name (partial).`,
      inputSchema: {
        airline: boundedQuerySchema
          .optional()
          .describe(
            'Airline IATA code (e.g. "UA") or partial name (e.g. "United")'
          ),
        departure_airport: boundedQuerySchema
          .optional()
          .describe(
            'Departure airport IATA code (e.g. "SFO") or city (e.g. "San Francisco")'
          ),
        arrival_airport: boundedQuerySchema
          .optional()
          .describe(
            'Arrival airport IATA code (e.g. "LHR") or city (e.g. "London")'
          ),
        after: isoDateSchema
          .optional()
          .describe(
            'Only flights departing on or after this date (e.g. "2025-01-01")'
          ),
        before: isoDateSchema
          .optional()
          .describe(
            'Only flights departing on or before this date (e.g. "2025-12-31")'
          ),
        limit: pageLimitSchema.describe("Maximum results"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      if (params.after && params.before && params.after > params.before) {
        return {
          content: [
            {
              type: "text",
              text: "Error: 'after' date must not be later than 'before' date.",
            },
          ],
          isError: true,
        };
      }
      const flights = db.searchFlights(params);
      const wrapped = {
        note: "Sorted most recent departure first. All timestamps are UTC.",
        count: flights.length,
        results: flights,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }],
      };
    }
  );

  server.registerTool(
    "flighty_current_flights",
    {
      title: "Current Flights",
      description: `Get the user's current travel context — flights departing within 24 hours in either direction from now. This captures in-progress flights, flights about to depart, and recently landed flights.

Use this when the user asks about their current flight, current trip, what gate they arrive at, baggage claim, layovers, or anything related to active travel. Use flighty_list_flights with upcoming_only=true for future travel planning instead.

Sorted by departure time ascending (earliest first). All timestamps are UTC.`,
      inputSchema: {
        limit: pageLimitSchema.describe("Maximum number of flights to return"),
        offset: pageOffsetSchema.describe("Number of flights to skip for pagination"),
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
      const flights = db.currentFlights({ limit, offset });
      const wrapped = {
        note: "Flights departing within ±24 hours of now, sorted earliest first. All timestamps are UTC.",
        count: flights.length,
        limit,
        offset,
        results: flights,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }],
      };
    }
  );
}
