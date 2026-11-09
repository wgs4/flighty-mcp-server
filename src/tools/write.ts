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
import type { FlightyDatabase, RemovalLocalRecord } from "../services/database.js";
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
import { buildOwnerIdentityEnvelope, wrapToolResult } from "../services/tool-safety.js";

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
  return "The request failed.";
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

type LocalRecordKind = RemovalLocalRecord["record"];

type ResolvedRemoval =
  | ({ kind: "local" } & RemovalLocalRecord)
  | { kind: "unavailable" };

function resolveRemoval(db: FlightyDatabase, requestedId: string): ResolvedRemoval {
  try {
    const local = db.getRemovalFlight(requestedId);
    if (
      local && UUID_PATTERN.test(local.flight.id) &&
      local.flight.id.toLowerCase() === requestedId.toLowerCase()
    ) {
      return { kind: "local", ...local };
    }
  } catch {
    // Local enrichment is optional. Never infer ownership when lookup fails.
  }
  return { kind: "unavailable" };
}

function removalTarget(resolved: ResolvedRemoval, requestedId: string): {
  flightId: string;
  preview: RemovalPreview;
  localDetails: "available" | "unavailable";
  localRecord: LocalRecordKind | "none";
  localIdentity: RemovalLocalRecord["identity"]["label"] | "unavailable";
} {
  if (resolved.kind === "local") {
    return {
      flightId: resolved.flight.id,
      preview: {
        ...resolved.flight,
        local_record: resolved.record,
        owner_identity: buildOwnerIdentityEnvelope(resolved.identity),
      },
      localDetails: "available",
      localRecord: resolved.record,
      localIdentity: resolved.identity.label,
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
  const resolved = resolveRemoval(db, requestedId);
  const target = removalTarget(resolved, requestedId);
  const issued = removals.issue(target.flightId, target.preview);
  const message =
    target.localDetails === "available"
      ? "Flight was not removed. Call flighty_remove_flight again with this flight_id and confirm_code within five minutes. The code works once and only for this preview."
      : "Local details and local identity are unavailable for this exact id. Nothing was removed. Call flighty_remove_flight again with this same flight_id and confirm_code within five minutes to delete this exact id.";
  return wrapToolResult(
    textResult(JSON.stringify(
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
    )),
    {
      isOwnerScoped: resolved.kind === "local",
      ownerIdentity: resolved.kind === "local" ? resolved.identity : null,
    }
  ) as ToolResult;
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
