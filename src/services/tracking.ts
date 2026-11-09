import type { CachedConnectionMinimum, FlightPhase, FlightRecord, TrackedFlight } from "../types.js";

export const CACHED_TRACKING_NOTICE =
  "Calculated from the local Flighty cache. No network refresh or live telemetry is requested; calculation time does not establish data freshness.";

// Database timestamps arrive as UTC ISO strings. Reject invalid calendar dates,
// timezone-free values, and SQLite values that could not be converted safely.
export function trackingTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19) ? ms : null;
}

const ACTUAL_MILESTONES = [
  "departureScheduleGateActual",
  "departureScheduleRunwayActual",
  "arrivalScheduleRunwayActual",
  "arrivalScheduleGateActual",
] as const;

type TimeField = typeof ACTUAL_MILESTONES[number]
  | "arrivalScheduleRunwayEstimated" | "arrivalScheduleRunwayOriginal"
  | "arrivalScheduleGateEstimated" | "arrivalScheduleGateOriginal"
  | "departureScheduleGateEstimated" | "departureScheduleGateOriginal"
  | "departureScheduleRunwayEstimated" | "departureScheduleRunwayOriginal";

function timeReader(flight: FlightRecord, initialIssues: Record<string, string>) {
  const issues = { ...initialIssues };
  const read = (field: TimeField): number | null => {
    const raw = flight[field];
    const time = trackingTimestamp(raw);
    if (raw != null && time === null) issues[field] = "invalid_timestamp";
    return time;
  };
  return { issues, read };
}

type Candidate = { ms: number; basis: TimeField };

// One validation pass supplies both countdowns and connection selection. Actual
// milestones outrank predictions; a contradictory current prediction cannot be
// rescued by silently reverting to an older schedule.
function validatedTimeline(flight: FlightRecord, now: number, timestampIssues: Record<string, string>) {
  const { issues, read } = timeReader(flight, timestampIssues);
  const conflicts: Record<string, string[]> = {};
  const fields: TimeField[] = [...ACTUAL_MILESTONES,
    "departureScheduleGateEstimated", "departureScheduleGateOriginal",
    "departureScheduleRunwayEstimated", "departureScheduleRunwayOriginal",
    "arrivalScheduleRunwayEstimated", "arrivalScheduleRunwayOriginal",
    "arrivalScheduleGateEstimated", "arrivalScheduleGateOriginal"];
  const times = new Map(fields.map((field) => [field, read(field)]));
  const actuals = ACTUAL_MILESTONES.map((field) => times.get(field)!);
  let watermark: number | null = null;
  for (let i = 0; i < actuals.length; i++) {
    const value = actuals[i];
    if (value === null) continue;
    const field = ACTUAL_MILESTONES[i];
    if (value > now) issues[field] = "future_actual_timestamp";
    if (watermark !== null && value < watermark) issues[field] = "out_of_order_actual_milestones";
    watermark = watermark === null ? value : Math.max(watermark, value);
  }
  const invalidMilestones = ACTUAL_MILESTONES.some((field) => issues[field] !== undefined);
  if (invalidMilestones) {
    for (const field of ACTUAL_MILESTONES) {
      if (times.get(field) !== null && !issues[field]) issues[field] = "inconsistent_actual_milestones";
    }
  }
  const candidate = (field: TimeField): Candidate | null => {
    const ms = times.get(field);
    return ms == null || issues[field] ? null : { ms, basis: field };
  };
  const reject = (field: TimeField, reason: string, bound: Candidate) => {
    issues[field] = reason;
    conflicts[field] = [bound.basis];
  };
  const choose = (candidates: readonly TimeField[]): Candidate | null => {
    for (const field of candidates) {
      const value = candidate(field);
      if (value) return value;
      // Invalid encodings and unverified actuals permit a labelled fallback.
      // Chronological contradictions require unknown rather than a stale time.
      if (conflicts[field]) return null;
    }
    return null;
  };
  const actual = ACTUAL_MILESTONES.map(candidate);
  const [pushback, takeoff, touchdown, atGate] = actual;
  const gateDepartureFields = ["departureScheduleGateActual", "departureScheduleGateEstimated", "departureScheduleGateOriginal"] as const;
  const runwayDepartureFields = ["departureScheduleRunwayActual", "departureScheduleRunwayEstimated", "departureScheduleRunwayOriginal"] as const;
  // A new gate departure estimate supersedes an old runway departure schedule.
  const currentGateDeparture = candidate("departureScheduleGateEstimated");
  const currentRunwayDeparture = candidate("departureScheduleRunwayEstimated");
  // Snapshot the active evidence before selection rejects contradictions. A
  // rejected prediction still constrains later milestones until superseded.
  const predictedDepartureBounds = [
    currentGateDeparture ?? candidate("departureScheduleGateOriginal"),
    currentRunwayDeparture ?? (currentGateDeparture ? null : candidate("departureScheduleRunwayOriginal")),
  ];
  const runwayDepartureBound = takeoff ?? candidate("departureScheduleRunwayEstimated") ??
    (candidate("departureScheduleGateEstimated") ? null : candidate("departureScheduleRunwayOriginal"));
  for (const field of gateDepartureFields.slice(1)) {
    const value = candidate(field);
    const upper = takeoff ?? touchdown ?? atGate ?? runwayDepartureBound;
    if (value && upper && value.ms > upper.ms) reject(field, "gate_departure_follows_runway_or_arrival", upper);
  }
  const departure = choose(gateDepartureFields);
  for (const field of runwayDepartureFields.slice(1)) {
    const value = candidate(field);
    if (value && departure && value.ms < departure.ms) reject(field, "runway_departure_precedes_gate_departure", departure);
  }
  const runwayDeparture = choose(runwayDepartureFields);
  const departureBounds = [takeoff ?? runwayDeparture, pushback ?? departure,
    ...(!pushback && !takeoff && !touchdown && !atGate ? predictedDepartureBounds : [])
  ].filter((v): v is Candidate => v !== null);
  const runwayArrivalFields = ["arrivalScheduleRunwayActual", "arrivalScheduleRunwayEstimated", "arrivalScheduleRunwayOriginal"] as const;
  const runwayArrivalBound = touchdown ?? candidate("arrivalScheduleRunwayEstimated") ?? candidate("arrivalScheduleRunwayOriginal");
  for (const field of runwayArrivalFields.slice(1)) {
    const value = candidate(field);
    // Once actual touchdown/at-gate is known, stale predictions are not bounds.
    const lower = departureBounds.find((bound) => value && value.ms < bound.ms);
    if (value && lower) reject(field, "runway_arrival_precedes_departure", lower);
  }
  const landing = choose(runwayArrivalFields);
  const gateArrivalFields = ["arrivalScheduleGateActual", "arrivalScheduleGateEstimated", "arrivalScheduleGateOriginal"] as const;
  for (const field of gateArrivalFields.slice(1)) {
    const value = candidate(field);
    if (!value) continue;
    const lowerDeparture = departureBounds.find((bound) => value.ms < bound.ms);
    if (touchdown && value.ms < touchdown.ms) reject(field, "gate_arrival_precedes_touchdown", touchdown);
    else if (lowerDeparture) reject(field, "gate_arrival_precedes_departure", lowerDeparture);
    else if (runwayArrivalBound && value.ms < runwayArrivalBound.ms) reject(field, "gate_arrival_precedes_runway_arrival", runwayArrivalBound);
  }
  const gate = choose(gateArrivalFields);
  // Check every departure fallback against the established arrival evidence too.
  for (const field of gateDepartureFields.slice(1)) {
    const value = candidate(field);
    const upper = takeoff ?? touchdown ?? atGate ?? runwayDepartureBound ?? landing ?? gate;
    if (value && upper && value.ms > upper.ms) reject(field, "gate_departure_follows_runway_or_arrival", upper);
  }
  const reason = (candidates: readonly TimeField[], missing: string) => {
    for (const field of candidates) if (issues[field]) return issues[field];
    return missing;
  };
  return { issues, conflicts, actuals, invalidMilestones, landing, gate,
    departure: choose(gateDepartureFields), gateEstimated: candidate("arrivalScheduleGateEstimated"),
    landingReason: reason(runwayArrivalFields, "no_valid_runway_arrival_time"),
    gateReason: reason(gateArrivalFields, "no_valid_gate_arrival_time") };
}

export function deriveTrackingTiming(
  flight: FlightRecord,
  now: number = Date.now(),
  timestampIssues: Record<string, string> = {}
) {
  if (!Number.isFinite(now)) throw new Error("Invalid calculation time.");
  const timeline = validatedTimeline(flight, now, timestampIssues);
  const { issues, actuals, invalidMilestones } = timeline;
  const [pushback, takeoff, touchdown, atGate] = actuals;
  let phase: FlightPhase;
  let phaseReason: string;
  if (flight.is_cancelled) {
    phase = "cancelled";
    phaseReason = "cached_cancellation_flag";
  } else if (invalidMilestones) {
    phase = "unknown";
    phaseReason = "invalid_future_or_out_of_order_actual_milestones";
  } else if (atGate !== null) {
    phase = "at_gate";
    phaseReason = "actual_gate_arrival";
  } else if (touchdown !== null) {
    phase = "taxi_in";
    phaseReason = "actual_runway_arrival_without_actual_gate_arrival";
  } else if (takeoff !== null) {
    phase = "airborne";
    phaseReason = "actual_runway_departure_without_actual_arrival";
  } else if (pushback !== null) {
    phase = "taxi_out";
    phaseReason = "actual_gate_departure_without_actual_runway_departure";
  } else {
    const scheduledDeparture = trackingTimestamp(flight.departureScheduleGateOriginal) ?? trackingTimestamp(flight.departureScheduleRunwayOriginal);
    phase = scheduledDeparture !== null && scheduledDeparture > now ? "scheduled" : "unknown";
    phaseReason = phase === "scheduled" ? "future_scheduled_departure_no_actual_milestones" : "no_actual_milestones_and_no_future_scheduled_departure";
  }

  let landingAt: number | null = null;
  let landingBasis: string | null = null;
  let landingState: "estimated" | "scheduled" | "landed" | "overdue" | "unknown" | "cancelled" = "unknown";
  let landingReason: string | null = null;
  let minutesToLanding: number | null = null;
  if (phase === "cancelled") {
    landingState = "cancelled";
    landingReason = "cancelled_flight";
  } else if (invalidMilestones) {
    landingReason = phaseReason;
  } else if (touchdown !== null) {
    landingAt = touchdown;
    landingBasis = "arrivalScheduleRunwayActual";
    landingState = "landed";
    minutesToLanding = 0;
  } else if (atGate !== null) {
    landingReason = "at_gate_but_runway_arrival_time_missing";
  } else {
    landingAt = timeline.landing?.ms ?? null;
    landingBasis = timeline.landing?.basis ?? null;
    if (landingAt === null) landingReason = timeline.landingReason;
    else if (landingAt <= now) {
      landingState = "overdue";
      landingReason = "runway_arrival_time_passed_without_actual_touchdown";
    } else {
      landingState = landingBasis === "arrivalScheduleRunwayEstimated" ? "estimated" : "scheduled";
      minutesToLanding = (landingAt - now) / 60000;
      if (landingState === "scheduled") landingReason = "time_until_scheduled_landing_not_predicted_flight_duration";
    }
  }

  const gateTime = timeline.gate?.ms ?? null;
  const gateBasis = timeline.gate?.basis ?? null;
  let gateReason: string | null = null;
  let minutesToGate: number | null = null;
  if (phase === "cancelled") gateReason = "cancelled_flight";
  else if (invalidMilestones) gateReason = phaseReason;
  else if (atGate !== null) minutesToGate = 0;
  else if (gateTime === null) gateReason = timeline.gateReason;
  else if (gateTime <= now) gateReason = "gate_arrival_time_passed_without_actual_gate_arrival";
  else minutesToGate = (gateTime - now) / 60000;

  let taxiElapsed: number | null = null;
  let taxiCompleted: number | null = null;
  let taxiReason: string | null = null;
  if (phase === "cancelled") taxiReason = "cancelled_flight";
  else if (invalidMilestones) taxiReason = phaseReason;
  else if (touchdown === null) taxiReason = "actual_runway_arrival_missing";
  else if (atGate !== null) taxiCompleted = (atGate - touchdown) / 60000;
  else taxiElapsed = (now - touchdown) / 60000;

  const iso = (value: number | null) => value === null ? null : new Date(value).toISOString();
  return {
    phase,
    phase_reason: phaseReason,
    phase_basis: ACTUAL_MILESTONES.filter((_field, i) => actuals[i] !== null),
    minutes_to_landing: minutesToLanding,
    landing_at: iso(landingAt),
    landing_time_basis: landingBasis,
    landing_countdown_state: landingState,
    landing_countdown_reason: landingReason,
    wheels_down_at: invalidMilestones ? null : iso(touchdown),
    taxi_in_elapsed_minutes: taxiElapsed,
    taxi_in_completed_minutes: taxiCompleted,
    taxi_in_reason: taxiReason,
    gate_eta: iso(timeline.gateEstimated?.ms ?? null),
    gate_arrival_at: iso(gateTime),
    gate_time_basis: gateBasis,
    minutes_to_gate: minutesToGate,
    gate_countdown_reason: gateReason,
    timestamp_issues: issues,
    timestamp_conflicts: timeline.conflicts,
    timestamp_basis: "UTC",
    calculated_at: new Date(now).toISOString(),
  };
}

function normalizeCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

function stableId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

export function airportContinuity(inbound: TrackedFlight, outbound: TrackedFlight) {
  const arrivalId = stableId(inbound.arrival_airport_id);
  const departureId = stableId(outbound.departure_airport_id);
  if (arrivalId && departureId) {
    return { matches: arrivalId === departureId, basis: "stable_airport_ids", reason: null };
  }
  const arrivalCode = normalizeCode(inbound.flight.arrival_airport_iata);
  const departureCode = normalizeCode(outbound.flight.departure_airport_iata);
  if (arrivalCode && departureCode && inbound.arrival_code_unambiguous && outbound.departure_code_unambiguous) {
    return { matches: arrivalCode === departureCode, basis: "unambiguous_iata_codes", reason: null };
  }
  return { matches: null, basis: null, reason: "missing_or_ambiguous_airport_identity" };
}

function normalizedTail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toUpperCase();
  if (!/^[A-Z0-9]+(?:-[A-Z0-9]+)?$/.test(raw) || /^(UNKNOWN|NONE|NULL|TBD|NA)$/.test(raw)) return null;
  const normalized = raw.replace(/-/g, "");
  return /^[A-Z0-9]{2,12}$/.test(normalized) ? normalized : null;
}

export function deriveConnectionCheck(
  inbound: TrackedFlight,
  outbound: TrackedFlight,
  minimum: CachedConnectionMinimum,
  now: number = Date.now()
) {
  const inboundTiming = deriveTrackingTiming(inbound.flight, now, inbound.timestamp_issues);
  const outboundTiming = deriveTrackingTiming(outbound.flight, now, outbound.timestamp_issues);
  const continuity = airportContinuity(inbound, outbound);
  const inboundTimeline = validatedTimeline(inbound.flight, now, inbound.timestamp_issues);
  const outboundTimeline = validatedTimeline(outbound.flight, now, outbound.timestamp_issues);
  const gateTime = (value: Candidate | null) => ({ ms: value?.ms ?? null,
    at: value ? new Date(value.ms).toISOString() : null, basis: value?.basis ?? null });
  const arrival = gateTime(inboundTimeline.gate);
  const departure = gateTime(outboundTimeline.departure);
  const layover = arrival.ms === null || departure.ms === null ? null : (departure.ms - arrival.ms) / 60000;
  const inboundTail = normalizedTail(inbound.flight.tail_number);
  const outboundTail = normalizedTail(outbound.flight.tail_number);
  const sameTail = inboundTail === null || outboundTail === null ? null : inboundTail === outboundTail;
  let risk: "cancelled" | "airport_mismatch" | "unknown" | "missed" | "below_minimum" | "meets_cached_minimum";
  let riskReason: string;
  if (inboundTiming.phase === "cancelled" || outboundTiming.phase === "cancelled") {
    risk = "cancelled";
    riskReason = "At least one flight is marked cancelled in the cache.";
  } else if (continuity.matches === false) {
    risk = "airport_mismatch";
    riskReason = "Inbound arrival and outbound departure airports differ.";
  } else if (continuity.matches === null) {
    risk = "unknown";
    riskReason = "Airport continuity cannot be established from the cached identities.";
  } else if (inboundTimeline.invalidMilestones || outboundTimeline.invalidMilestones) {
    risk = "unknown";
    riskReason = "Invalid or inconsistent actual milestones prevent a reliable operational assessment.";
  } else if (layover !== null && layover < 0) {
    risk = "missed";
    riskReason = "Selected outbound gate departure precedes inbound gate arrival; negative layover on the selected cached time bases, not proof of a traveler's outcome.";
  } else if (["taxi_out", "airborne", "taxi_in", "at_gate"].includes(outboundTiming.phase)) {
    risk = "unknown";
    riskReason = "Outbound has already left its gate in the cache; boarding availability and traveler outcome are unknown.";
  } else if (layover === null) {
    risk = "unknown";
    riskReason = "One or both gate times are missing or invalid.";
  } else if (minimum.minutes === null) {
    risk = "unknown";
    riskReason = "No valid unambiguous minimum connection time is cached for this exact pair.";
  } else if (layover < minimum.minutes) {
    risk = "below_minimum";
    riskReason = "Selected cached gate-to-gate layover is below this pair's cached minimum connection time.";
  } else {
    risk = "meets_cached_minimum";
    riskReason = "Selected cached gate-to-gate layover meets the cached minimum; boarding feasibility remains unknown.";
  }
  const summarize = (tracked: TrackedFlight, timing: ReturnType<typeof deriveTrackingTiming>) => ({
    flight_id: tracked.flight.id,
    flight_number: tracked.flight.flight_number,
    associations: tracked.associations,
    identity_ambiguous: tracked.identity_ambiguous,
    attribution_notice: tracked.attribution_notice,
    phase: timing.phase,
    phase_reason: timing.phase_reason,
  });
  return {
    inbound: summarize(inbound, inboundTiming),
    outbound: summarize(outbound, outboundTiming),
    pair_kind: "proposed_explicit_pair",
    traveler_identity: "not_established_by_pair_check",
    identity_notice: "Flight associations are provenance only. This proposed pair does not establish that either flight carries the same traveler.",
    airport_continuity: continuity,
    arrival_gate_at: arrival.at,
    arrival_gate_time_basis: arrival.basis,
    departure_gate_at: departure.at,
    departure_gate_time_basis: departure.basis,
    layover_minutes: layover,
    layover_reason: layover === null ? "missing_or_invalid_gate_time" : null,
    min_connection_time_minutes: minimum.minutes,
    min_connection_time_basis: minimum.basis,
    min_connection_time_reason: minimum.reason,
    same_tail: sameTail,
    same_tail_reason: sameTail === null ? "one_or_both_tail_numbers_missing_or_invalid" : null,
    tail_notice: "Matching cached tail numbers do not guarantee a connection or boarding.",
    risk,
    risk_reason: riskReason,
    operational_notice: `Inbound phase: ${inboundTiming.phase}; outbound phase: ${outboundTiming.phase}. These are cached milestones, not a boarding decision.`,
    unknown_factors: ["boarding_cutoff", "security", "walking_time", "immigration", "traveler_identity", "current_data_freshness"],
    timestamp_issues: { inbound: inboundTimeline.issues, outbound: outboundTimeline.issues },
    timestamp_conflicts: { inbound: inboundTimeline.conflicts, outbound: outboundTimeline.conflicts },
    timestamp_basis: "UTC",
    calculated_at: new Date(now).toISOString(),
    cached_data_notice: CACHED_TRACKING_NOTICE,
  };
}
