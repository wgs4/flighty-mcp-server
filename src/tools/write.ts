import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  assertConfirmCodeShape,
  assertFlightCode,
  assertIsoDate,
  assertUuid,
  InputBoundsError,
  isRealIsoDate,
  UUID_PATTERN,
} from "../services/bounds.js";
import type { FlightyDatabase } from "../services/database.js";
import {
  FlightyApi,
  parseFlightCode,
  RequestSafetyError,
} from "../services/flighty-api.js";
import {
  SyncUrlRejectedError,
  WritesDisabledError,
} from "../services/policy.js";
import {
  RemovalConfirmStore,
  type ConsumeReason,
  type RemovalPreview,
} from "../services/removal-confirm.js";
import type { FlightRecord } from "../types.js";

type Airline = { id: string; name: string; iata: string };

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export type WriteToolDeps = {
  removals?: RemovalConfirmStore;
  now?: () => number;
};

const flightCodeSchema = z
  .string()
  .trim()
  .min(3)
  .max(20)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    "Flight code must be 3 to 20 characters, like UA194."
  )
  .describe(
    'Flight code, e.g. "DL10", "UA194", "BA930". The 2-character airline prefix is parsed automatically.'
  );

const isoDateSchema = z
  .string()
  .refine(isRealIsoDate, "Date must be a real YYYY-MM-DD calendar date.")
  .describe('Departure date in YYYY-MM-DD format, e.g. "2026-04-15"');

const flightIdSchema = z
  .string()
  .regex(UUID_PATTERN, "Flight id must be a UUID.")
  .describe(
    "Flight UUID. Local passenger or followed details are included when that exact id is stored. Any other valid UUID can still be confirmed for deletion."
  );

async function findFlight(
  db: FlightyDatabase,
  api: FlightyApi,
  airlineIata: string,
  flightNumber: string,
  date: string
): Promise<{
  candidates: Airline[];
  match: { airline: Airline; serverUuid: string } | null;
}> {
  const candidates = db.lookupAirlines(airlineIata);
  for (const airline of candidates) {
    const serverUuid = await api.searchFlight(airline.id, flightNumber, date);
    if (serverUuid) return { candidates, match: { airline, serverUuid } };
  }
  return { candidates, match: null };
}

function notFoundMessage(
  flightCode: string,
  date: string,
  candidates: Airline[]
): string {
  const airlineNames = candidates.map((candidate) => candidate.name).join(", ");
  return `No flight found for ${flightCode} on ${date} (tried ${airlineNames}). Check the flight number and date.`;
}

function textResult(text: string, isError = false): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

function toolErrorText(error: unknown): string {
  if (
    error instanceof InputBoundsError ||
    error instanceof WritesDisabledError ||
    error instanceof SyncUrlRejectedError ||
    error instanceof RequestSafetyError
  ) {
    return error.message;
  }
  if (error instanceof Error) {
    if (/\/Users\/|Bearer |token=|https?:\/\//i.test(error.message)) {
      return "The request failed.";
    }
    return error.message;
  }
  return "The request failed.";
}

function flightPreview(flight: FlightRecord): RemovalPreview {
  return { ...flight };
}

function removalFailure(reason: ConsumeReason): string {
  switch (reason) {
    case "wrong-id":
      return "That confirm code does not match this flight. Nothing was removed.";
    case "expired":
      return "That confirm code has expired. Request a new preview. Nothing was removed.";
    case "preview-changed":
      return "The flight changed after the preview. Request a new preview. Nothing was removed.";
    case "replay":
      return "That confirm code was already used. Nothing was removed.";
    case "missing":
      return "That confirm code is not valid. Nothing was removed.";
  }
}

export function registerWriteTools(
  server: McpServer,
  db: FlightyDatabase,
  api: FlightyApi,
  deps: WriteToolDeps = {}
): void {
  const removals =
    deps.removals ?? new RemovalConfirmStore(deps.now ? { now: deps.now } : undefined);

  server.registerTool(
    "flighty_add_flight",
    {
      title: "Add Flight",
      description: `Add a flight to the user's Flighty account by flight code and date. The flight is registered with Flighty's server and syncs to all devices (phone, watch, etc.) within seconds.

The airline is detected from the flight code prefix (e.g. "DL" from "DL10"). The Flighty API provides full enrichment: gate assignments, weather, equipment, delay forecast, codeshare partners.

This tool calls the Flighty API — it requires the Flighty app to be installed and signed in.

Returns the server-side flight UUID on success.`,
      inputSchema: {
        flight_code: flightCodeSchema,
        date: isoDateSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const flightCode = assertFlightCode(params.flight_code);
        const date = assertIsoDate(params.date);
        const { airlineIata, flightNumber } = parseFlightCode(flightCode);
        const { candidates, match } = await findFlight(
          db,
          api,
          airlineIata,
          flightNumber,
          date
        );
        if (!match) {
          return textResult(notFoundMessage(flightCode, date, candidates), true);
        }
        await api.subscribeFlight(match.serverUuid);
        return textResult(
          JSON.stringify(
            {
              status: "added",
              flight_code: flightCode,
              date,
              airline: match.airline.name,
              server_flight_uuid: match.serverUuid,
              message:
                "Flight added to your Flighty account. It will appear on all your devices within seconds.",
            },
            null,
            2
          )
        );
      } catch (error) {
        return textResult(`Error adding flight: ${toolErrorText(error)}`, true);
      }
    }
  );

  server.registerTool(
    "flighty_follow_flight",
    {
      title: "Follow Flight",
      description: `Follow a flight without being a passenger — use this to track someone else's flight (e.g., a family member or friend). The flight is registered with Flighty's server and syncs to all devices within seconds. It will appear in flighty_list_friend_flights results (with friend_name as null, since no Flighty friend connection is involved).

The airline is detected from the flight code prefix (e.g. "DL" from "DL10"). The Flighty API provides full enrichment: gate assignments, weather, equipment, delay forecast, codeshare partners.

This tool calls the Flighty API — it requires the Flighty app to be installed and signed in.

Returns the server-side flight UUID on success.`,
      inputSchema: {
        flight_code: flightCodeSchema,
        date: isoDateSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const flightCode = assertFlightCode(params.flight_code);
        const date = assertIsoDate(params.date);
        const { airlineIata, flightNumber } = parseFlightCode(flightCode);
        const { candidates, match } = await findFlight(
          db,
          api,
          airlineIata,
          flightNumber,
          date
        );
        if (!match) {
          return textResult(notFoundMessage(flightCode, date, candidates), true);
        }
        await api.followFlight(match.serverUuid);
        return textResult(
          JSON.stringify(
            {
              status: "followed",
              flight_code: flightCode,
              date,
              airline: match.airline.name,
              server_flight_uuid: match.serverUuid,
              message:
                "Flight added to your Flighty tracking list. It will appear on all your devices within seconds.",
            },
            null,
            2
          )
        );
      } catch (error) {
        return textResult(`Error following flight: ${toolErrorText(error)}`, true);
      }
    }
  );

  server.registerTool(
    "flighty_remove_flight",
    {
      title: "Remove Flight",
      description: `Remove a flight from the user's Flighty account.

The first call takes flight_id only. Nothing is deleted on that call. When the id matches a local passenger or followed flight, the response previews that row. When it does not, the response names the exact id and says local details and local identity are unavailable. Either response includes a one-time confirm_code.

Call again with the same flight_id and confirm_code within five minutes to delete that exact id. The code matches that id and preview, works once, and is rejected if the preview changed, the id is wrong, or the code is reused.

Deletion syncs to all devices.`,
      inputSchema: {
        flight_id: flightIdSchema,
        confirm_code: z
          .string()
          .trim()
          .min(1)
          .max(32)
          .optional()
          .describe(
            "One-time code from the preview response. Omit it on the first call."
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const requestedId = assertUuid(params.flight_id, "Flight id");
        const rawCode =
          typeof params.confirm_code === "string" ? params.confirm_code.trim() : "";
        if (!rawCode) return previewRemoval(db, removals, requestedId);
        return await confirmRemoval(
          db,
          api,
          removals,
          requestedId,
          assertConfirmCodeShape(rawCode)
        );
      } catch (error) {
        return textResult(`Error removing flight: ${toolErrorText(error)}`, true);
      }
    }
  );
}

const FOLLOWED_PAGE_SIZE = 200;
const FOLLOWED_MAX_PAGES = 25;

type LocalRecordKind = "passenger" | "followed";

type ResolvedRemoval =
  | { kind: "local"; flight: FlightRecord; record: LocalRecordKind }
  | { kind: "unavailable" };

function sameFlightId(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function localRow(
  flight: FlightRecord | null | undefined,
  requestedId: string
): FlightRecord | null {
  if (!flight || typeof flight.id !== "string" || !UUID_PATTERN.test(flight.id)) {
    return null;
  }
  if (!sameFlightId(flight.id, requestedId)) return null;
  return flight;
}

function findFollowedFlight(
  db: FlightyDatabase,
  requestedId: string
): FlightRecord | null {
  // database.ts has no followed-flight lookup by id. listFriendFlights is the
  // public query that includes the owner's isMyFlight = 0 rows. Named friend
  // rows are skipped. The page size matches the other packet's list cap.
  if (typeof db.listFriendFlights !== "function") return null;
  for (let page = 0; page < FOLLOWED_MAX_PAGES; page += 1) {
    const rows = db.listFriendFlights({
      limit: FOLLOWED_PAGE_SIZE,
      offset: page * FOLLOWED_PAGE_SIZE,
    });
    if (!Array.isArray(rows) || rows.length === 0) return null;
    for (const row of rows) {
      if (row.friend_name) continue;
      const match = localRow(row, requestedId);
      if (match) return match;
    }
    if (rows.length < FOLLOWED_PAGE_SIZE) return null;
  }
  return null;
}

function resolveRemoval(db: FlightyDatabase, requestedId: string): ResolvedRemoval {
  const passenger = localRow(db.getFlight({ flight_id: requestedId }), requestedId);
  if (passenger) return { kind: "local", flight: passenger, record: "passenger" };
  const followed = findFollowedFlight(db, requestedId);
  if (followed) return { kind: "local", flight: followed, record: "followed" };
  return { kind: "unavailable" };
}

function removalTarget(resolved: ResolvedRemoval, requestedId: string): {
  flightId: string;
  preview: RemovalPreview;
  localDetails: "available" | "unavailable";
  localRecord: LocalRecordKind | "none";
  localIdentity: "unlabeled_local_row" | "unavailable";
} {
  if (resolved.kind === "local") {
    return {
      flightId: resolved.flight.id,
      preview: flightPreview(resolved.flight),
      localDetails: "available",
      localRecord: resolved.record,
      localIdentity: "unlabeled_local_row",
    };
  }
  return {
    flightId: requestedId,
    preview: {
      id: requestedId,
      local_details: "unavailable",
      local_identity: "unavailable",
    },
    localDetails: "unavailable",
    localRecord: "none",
    localIdentity: "unavailable",
  };
}

function previewRemoval(
  db: FlightyDatabase,
  removals: RemovalConfirmStore,
  requestedId: string
): ToolResult {
  const target = removalTarget(resolveRemoval(db, requestedId), requestedId);
  const issued = removals.issue(target.flightId, target.preview);
  const message =
    target.localDetails === "available"
      ? "Flight was not removed. Call flighty_remove_flight again with this flight_id and confirm_code within five minutes. The code works once and only for this preview. This preview does not add a separate owner label."
      : "No local passenger or followed flight matches this id. Local details and local identity are unavailable. Nothing was removed. Call flighty_remove_flight again with this same flight_id and confirm_code within five minutes to delete this exact id.";
  return textResult(
    JSON.stringify(
      {
        status: "confirmation_required",
        flight_id: target.flightId,
        confirm_code: issued.code,
        expires_in_seconds: issued.expiresInSeconds,
        local_details: target.localDetails,
        local_record: target.localRecord,
        local_identity: target.localIdentity,
        message,
        flight: target.preview,
      },
      null,
      2
    )
  );
}

async function confirmRemoval(
  db: FlightyDatabase,
  api: FlightyApi,
  removals: RemovalConfirmStore,
  requestedId: string,
  confirmCode: string
): Promise<ToolResult> {
  const target = removalTarget(resolveRemoval(db, requestedId), requestedId);
  // Consume before the request so a concurrent call cannot reuse this code.
  const decision = removals.consume(confirmCode, target.flightId, target.preview);
  if (!decision.ok) return textResult(removalFailure(decision.reason), true);
  await api.deleteFlight(target.flightId);
  return textResult(
    JSON.stringify(
      {
        status: "removed",
        flight_id: target.flightId,
        message:
          "Flight removed from your Flighty account. Deletion will sync to all devices.",
      },
      null,
      2
    )
  );
}
