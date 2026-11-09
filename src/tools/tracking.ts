import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FlightyDatabase, OwnerIdentity } from "../services/database.js";
import { buildOwnerIdentityEnvelope, installToolSafety } from "../services/tool-safety.js";
import { CACHED_TRACKING_NOTICE, deriveTrackingTiming } from "../services/tracking.js";
import { uuidSchema } from "../services/validation.js";

function ownerMetadata(identity: OwnerIdentity) {
  return {
    owner_label: identity.label,
    owner_identity: buildOwnerIdentityEnvelope(identity),
    ...(identity.warning ? { owner_warning: identity.warning } : {}),
  };
}

export function registerTrackingTools(server: McpServer, db: FlightyDatabase): void {
  installToolSafety(server, db);
  server.registerTool(
    "flighty_get_tracking_status",
    {
      title: "Get Cached Flight Tracking Status",
      description: `Get local milestone tracking for one exact flight UUID. Eligible flights are the resolved owner's passenger/followed flights and cached connected-friend passenger flights. Returns all associations and known Profile names; a followed row does not identify its passenger. Multiple associations never select an arbitrary traveler. Booking fields remain per association.

Landing countdown uses runway estimated arrival, then labelled runway scheduled arrival, never gate ETA. Phases: scheduled, taxi_out (gate departure), airborne (runway departure), taxi_in (runway touchdown), at_gate (gate arrival), cancelled, unknown. Missing, invalid, future or conflicting actual milestones are labelled honestly. Expired ETAs do not establish touchdown. Scheduled landing countdown is time until scheduled landing, not predicted flight duration. Includes taxi-in elapsed/completed minutes and separate gate timing. All timestamps are UTC. Reads the local cache only; no refresh, aircraft telemetry, taxi route or taxi percentage.`,
      inputSchema: { flight_id: uuidSchema.describe("Exact eligible cached flight UUID") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ flight_id }) => {
      const record = db.getTrackingFlight(flight_id);
      if (!record) return { content: [{ type: "text", text: JSON.stringify({ result: null, reason: "no_eligible_cached_flight_for_uuid", note: CACHED_TRACKING_NOTICE }) }] };
      const result = {
        ...record.tracked,
        timing: deriveTrackingTiming(record.tracked.flight, Date.now(), record.tracked.timestamp_issues),
      };
      return { content: [{ type: "text", text: JSON.stringify({ note: CACHED_TRACKING_NOTICE, ...ownerMetadata(record.identity), result }, null, 2) }] };
    }
  );
  server.registerTool(
    "flighty_check_connection",
    {
      title: "Check Proposed Cached Flight Connection",
      description: `Check a proposed pair of two explicit distinct eligible cached flight UUIDs, including owner passenger/followed and cached connected-friend passenger rows. This does not establish the same traveler on both legs. Returns associations, identity ambiguity, airport continuity and time sources. Airport matching uses stable IDs or unambiguous non-null IATA codes. Gate times use actual, then estimated, then scheduled; negative layovers remain negative. Same-tail is null for absent/invalid tails and cannot guarantee boarding. MCT is used only for this exact cached Connection pair; missing/invalid/conflicting MCT yields unknown, with no default threshold. Negative gate layover is labelled missed on its selected time bases; below known MCT is risk; meeting MCT is never a guarantee. Cancellation and already-departed outbound milestones are labelled. Boarding cutoff, walking, security and immigration are unknown. All timestamps are UTC. Local cache only; no network refresh.`,
      inputSchema: {
        inbound_flight_id: uuidSchema.describe("Exact inbound flight UUID"),
        outbound_flight_id: uuidSchema.describe("Exact distinct outbound flight UUID"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ inbound_flight_id, outbound_flight_id }) => {
      const check = db.checkConnection(inbound_flight_id, outbound_flight_id);
      const body = check
        ? { note: CACHED_TRACKING_NOTICE, ...ownerMetadata(check.identity), result: check.result }
        : { note: CACHED_TRACKING_NOTICE, result: null, reason: "one_or_both_flight_uuids_have_no_eligible_cached_membership" };
      return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
    }
  );
}
