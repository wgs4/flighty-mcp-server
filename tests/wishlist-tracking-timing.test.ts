import { describe, expect, it } from "vitest";
import { airportContinuity, deriveConnectionCheck, deriveTrackingTiming, trackingTimestamp } from "../src/services/tracking.js";
import type { CachedConnectionMinimum, FlightRecord, TrackedFlight } from "../src/types.js";

const NOW = Date.parse("2026-11-09T02:00:00.000Z");
const at = (minutes: number) => new Date(NOW + minutes * 60000).toISOString();
function flight(overrides: Partial<FlightRecord> = {}): FlightRecord {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    flight_number: "101", is_cancelled: 0,
    departure_airport_iata: "AAA", arrival_airport_iata: "BBB", tail_number: null,
    departureScheduleGateOriginal: at(-100), departureScheduleGateEstimated: null, departureScheduleGateActual: null,
    departureScheduleRunwayOriginal: null, departureScheduleRunwayEstimated: null, departureScheduleRunwayActual: null,
    arrivalScheduleGateOriginal: at(40), arrivalScheduleGateEstimated: null, arrivalScheduleGateActual: null,
    arrivalScheduleRunwayOriginal: at(20), arrivalScheduleRunwayEstimated: null, arrivalScheduleRunwayActual: null,
    ...overrides,
  } as FlightRecord;
}
function tracked(overrides: Partial<FlightRecord> = {}, metadata: Partial<TrackedFlight> = {}): TrackedFlight {
  return {
    flight: flight(overrides), associations: [], identity_ambiguous: false, attribution_notice: "synthetic",
    departure_airport_id: "a", arrival_airport_id: "b", departure_code_unambiguous: true,
    arrival_code_unambiguous: true, timestamp_issues: {}, ...metadata,
  };
}
const minimum: CachedConnectionMinimum = { minutes: 30, basis: "cached_exact_pair", reason: null };
const noMinimum: CachedConnectionMinimum = { minutes: null, basis: null, reason: "no_cached_connection_for_exact_pair" };
const check = (inbound: TrackedFlight, outbound: TrackedFlight, mct = minimum) => deriveConnectionCheck(inbound, outbound, mct, NOW);
const inbound = (overrides: Partial<FlightRecord> = {}) => tracked({ arrivalScheduleRunwayOriginal: at(0), arrivalScheduleGateEstimated: at(10), ...overrides });
const outbound = (overrides: Partial<FlightRecord> = {}, metadata: Partial<TrackedFlight> = {}) => tracked({
  id: "44444444-4444-4444-8444-444444444444", departure_airport_iata: "BBB", arrival_airport_iata: "CCC",
  departureScheduleGateOriginal: at(50), arrivalScheduleRunwayOriginal: at(90), arrivalScheduleGateOriginal: at(110), ...overrides,
}, { departure_airport_id: "b", arrival_airport_id: "c", ...metadata });

describe("runway and gate milestone timing", () => {
  it("uses runway ETA for landing and gate ETA only for gate countdown", () => {
    const result = deriveTrackingTiming(flight({ departureScheduleRunwayActual: at(-80), arrivalScheduleRunwayEstimated: at(12), arrivalScheduleGateEstimated: at(35) }), NOW);
    expect(result.phase).toBe("airborne");
    expect(result.minutes_to_landing).toBe(12);
    expect(result.landing_time_basis).toBe("arrivalScheduleRunwayEstimated");
    expect(result.gate_eta).toBe(at(35));
    expect(result.minutes_to_gate).toBe(35);
    expect(result.timestamp_basis).toBe("UTC");
    expect(result.calculated_at).toBe(at(0));
  });

  it("labels scheduled landing fallback before departure as a schedule countdown", () => {
    const result = deriveTrackingTiming(flight({ departureScheduleGateOriginal: at(10), arrivalScheduleRunwayOriginal: at(90) }), NOW);
    expect(result.phase).toBe("scheduled");
    expect(result.minutes_to_landing).toBe(90);
    expect(result.landing_countdown_state).toBe("scheduled");
    expect(result.landing_countdown_reason).toBe("time_until_scheduled_landing_not_predicted_flight_duration");
    expect(result.landing_time_basis).toBe("arrivalScheduleRunwayOriginal");
  });

  it("does not substitute gate arrival when runway estimates and schedule are absent", () => {
    const result = deriveTrackingTiming(flight({ arrivalScheduleRunwayOriginal: null, arrivalScheduleGateEstimated: at(35) }), NOW);
    expect(result.minutes_to_landing).toBeNull();
    expect(result.landing_time_basis).toBeNull();
    expect(result.landing_countdown_reason).toBe("no_valid_runway_arrival_time");
    expect(result.minutes_to_gate).toBe(35);
  });

  it.each([
    ["taxi_out", { departureScheduleGateActual: at(-90) }],
    ["airborne", { departureScheduleGateActual: at(-90), departureScheduleRunwayActual: at(-80) }],
    ["taxi_in", { arrivalScheduleRunwayActual: at(-8) }],
    ["at_gate", { arrivalScheduleRunwayActual: at(-8), arrivalScheduleGateActual: at(-2) }],
    ["at_gate", { arrivalScheduleGateActual: at(-2) }],
    ["cancelled", { is_cancelled: 1 }],
    ["unknown", {}],
  ] as Array<[string, Partial<FlightRecord>]>) ("derives phase %s from actual milestones", (phase, overrides) => {
    expect(deriveTrackingTiming(flight(overrides), NOW).phase).toBe(phase);
  });

  it("reports elapsed taxi-in separately from completed taxi-in", () => {
    const taxi = deriveTrackingTiming(flight({ arrivalScheduleRunwayActual: at(-8), arrivalScheduleGateEstimated: at(4) }), NOW);
    expect(taxi.wheels_down_at).toBe(at(-8));
    expect(taxi.minutes_to_landing).toBe(0);
    expect(taxi.landing_time_basis).toBe("arrivalScheduleRunwayActual");
    expect(taxi.taxi_in_elapsed_minutes).toBe(8);
    expect(taxi.taxi_in_completed_minutes).toBeNull();
    expect(taxi.minutes_to_gate).toBe(4);
    const completed = deriveTrackingTiming(flight({ arrivalScheduleRunwayActual: at(-8), arrivalScheduleGateActual: at(-2) }), NOW);
    expect(completed.taxi_in_elapsed_minutes).toBeNull();
    expect(completed.taxi_in_completed_minutes).toBe(6);
    expect(completed.minutes_to_gate).toBe(0);
  });

  it("labels expired runway/gate estimates without claiming touchdown", () => {
    const result = deriveTrackingTiming(flight({ departureScheduleRunwayActual: at(-80), arrivalScheduleRunwayEstimated: at(-5), arrivalScheduleGateEstimated: at(-1) }), NOW);
    expect(result.phase).toBe("airborne");
    expect(result.minutes_to_landing).toBeNull();
    expect(result.landing_countdown_state).toBe("overdue");
    expect(result.wheels_down_at).toBeNull();
    expect(result.minutes_to_gate).toBeNull();
    expect(result.gate_countdown_reason).toMatch(/passed_without_actual/);
  });

  it("treats ETA exactly at calculation time as overdue until touchdown is known", () => {
    const result = deriveTrackingTiming(flight({ arrivalScheduleRunwayEstimated: at(0) }), NOW);
    expect(result.minutes_to_landing).toBeNull();
    expect(result.landing_countdown_state).toBe("overdue");
  });

  it("does not turn conflicting future schedules into a valid landing or gate countdown", () => {
    const invalidLanding = deriveTrackingTiming(flight({ departureScheduleGateOriginal: at(30), arrivalScheduleRunwayOriginal: at(20) }), NOW);
    expect(invalidLanding.minutes_to_landing).toBeNull();
    expect(invalidLanding.landing_countdown_reason).toBe("runway_arrival_precedes_departure");
    const invalidGate = deriveTrackingTiming(flight({ arrivalScheduleGateEstimated: at(10), arrivalScheduleRunwayEstimated: at(20) }), NOW);
    expect(invalidGate.minutes_to_gate).toBeNull();
    expect(invalidGate.gate_countdown_reason).toBe("gate_arrival_precedes_runway_arrival");
  });

  it.each([
    { departureScheduleGateActual: at(2) },
    { arrivalScheduleRunwayActual: "not-a-time" },
    { departureScheduleGateActual: at(-10), departureScheduleRunwayActual: at(-20) },
    { departureScheduleRunwayActual: at(-10), arrivalScheduleRunwayActual: at(-20) },
    { arrivalScheduleRunwayActual: at(-5), arrivalScheduleGateActual: at(-10) },
    { arrivalScheduleGateActual: at(5) },
  ])("rejects invalid/future/out-of-order actual milestones: %j", (overrides) => {
    const result = deriveTrackingTiming(flight(overrides), NOW);
    expect(result.phase).toBe("unknown");
    expect(result.minutes_to_landing).toBeNull();
    expect(result.taxi_in_elapsed_minutes).toBeNull();
    expect(result.taxi_in_completed_minutes).toBeNull();
    expect(result.minutes_to_gate).toBeNull();
    expect(Object.keys(result.timestamp_issues).length).toBeGreaterThan(0);
  });

  it("returns unknown taxi duration when at gate but wheels-down time is missing", () => {
    const result = deriveTrackingTiming(flight({ arrivalScheduleGateActual: at(-2) }), NOW);
    expect(result.phase).toBe("at_gate");
    expect(result.minutes_to_landing).toBeNull();
    expect(result.taxi_in_completed_minutes).toBeNull();
    expect(result.taxi_in_reason).toBe("actual_runway_arrival_missing");
  });

  it("falls back from invalid runway ETA with a reason and preserves invalid SQLite evidence", () => {
    const result = deriveTrackingTiming(flight({ arrivalScheduleRunwayEstimated: "bad" }), NOW, { checkInScheduleOpen: "invalid_timestamp" });
    expect(result.minutes_to_landing).toBe(20);
    expect(result.timestamp_issues.arrivalScheduleRunwayEstimated).toBe("invalid_timestamp");
    expect(result.timestamp_issues.checkInScheduleOpen).toBe("invalid_timestamp");
  });

  it("does not report a gate countdown whose estimate precedes touchdown", () => {
    const result = deriveTrackingTiming(flight({ arrivalScheduleRunwayActual: at(-8), arrivalScheduleGateEstimated: at(-10) }), NOW);
    expect(result.minutes_to_gate).toBeNull();
    expect(result.gate_countdown_reason).toBe("gate_arrival_precedes_touchdown");
  });

  it.each([null, "", "bad", "2026-02-30T02:00:00.000Z", "2026-11-09T25:00:00.000Z", "2026-11-09T02:00:00", 123, "1970-01-01T00:00:00.000Z"])("rejects invalid UTC timestamp %j", (value) => {
    expect(trackingTimestamp(value)).toBeNull();
  });
});

describe("explicit proposed connection logic", () => {
  it("uses estimated gate arrival, scheduled gate departure, and exact cached MCT", () => {
    const result = check(inbound(), outbound());
    expect(result.layover_minutes).toBe(40);
    expect(result.arrival_gate_time_basis).toBe("arrivalScheduleGateEstimated");
    expect(result.departure_gate_time_basis).toBe("departureScheduleGateOriginal");
    expect(result.risk).toBe("meets_cached_minimum");
    expect(result.risk_reason).toMatch(/boarding feasibility remains unknown/);
    expect(result.traveler_identity).toBe("not_established_by_pair_check");
    expect(result.same_tail).toBeNull();
  });

  it("prefers actual gate times to estimated and scheduled times", () => {
    const result = check(inbound({ arrivalScheduleGateActual: at(-60), arrivalScheduleRunwayActual: at(-65) }), outbound({ departureScheduleGateActual: at(-10), departureScheduleGateEstimated: at(10) }));
    expect(result.layover_minutes).toBe(50);
    expect(result.arrival_gate_time_basis).toBe("arrivalScheduleGateActual");
    expect(result.departure_gate_time_basis).toBe("departureScheduleGateActual");
    expect(result.inbound.phase).toBe("at_gate");
    expect(result.risk).toBe("unknown");
    expect(result.risk_reason).toMatch(/already left its gate/);
  });

  it("never invents an MCT threshold", () => {
    const result = check(inbound(), outbound(), noMinimum);
    expect(result.min_connection_time_minutes).toBeNull();
    expect(result.risk).toBe("unknown");
    expect(result.risk_reason).toMatch(/No valid unambiguous minimum/);
  });

  it("marks below-MCT risk and preserves a negative estimated layover", () => {
    expect(check(inbound({ arrivalScheduleGateEstimated: at(25) }), outbound()).risk).toBe("below_minimum");
    const negative = check(inbound({ arrivalScheduleGateEstimated: at(60) }), outbound(), noMinimum);
    expect(negative.layover_minutes).toBe(-10);
    expect(negative.risk).toBe("missed");
    expect(negative.risk_reason).toMatch(/selected cached time bases/);
  });

  it("does not silently zero missing times or use runway arrival as gate arrival", () => {
    const result = check(inbound({ arrivalScheduleGateOriginal: null, arrivalScheduleGateEstimated: null, arrivalScheduleRunwayEstimated: at(10) }), outbound());
    expect(result.layover_minutes).toBeNull();
    expect(result.arrival_gate_at).toBeNull();
    expect(result.layover_reason).toBe("missing_or_invalid_gate_time");
    expect(result.risk).toBe("unknown");
  });

  it("matches stable airport IDs, rejects mismatches even with matching code", () => {
    expect(check(inbound(), outbound()).airport_continuity.matches).toBe(true);
    const mismatch = check(inbound(), outbound({}, { departure_airport_id: "other-airport" }));
    expect(mismatch.airport_continuity.matches).toBe(false);
    expect(mismatch.risk).toBe("airport_mismatch");
  });

  it("requires unambiguous non-null codes when a stable ID is absent", () => {
    const codeOnly = outbound({ departure_airport_iata: " bbb " }, { departure_airport_id: null });
    expect(check(inbound(), codeOnly).airport_continuity).toMatchObject({ matches: true, basis: "unambiguous_iata_codes" });
    expect(check(inbound(), { ...codeOnly, departure_code_unambiguous: false }).risk).toBe("unknown");
    expect(airportContinuity(inbound(), outbound({ departure_airport_iata: null as unknown as string }, { departure_airport_id: null })).matches).toBeNull();
  });

  it.each([null, "", "   ", "???", "N-", "unknown tail"])("leaves missing/invalid tail %j unknown", (tail_number) => {
    expect(check(inbound({ tail_number }), outbound({ tail_number })).same_tail).toBeNull();
  });

  it("compares normalized tails without guaranteeing boarding", () => {
    const result = check(inbound({ tail_number: " n-123ab " }), outbound({ tail_number: "N123AB" }));
    expect(result.same_tail).toBe(true);
    expect(result.tail_notice).toMatch(/do not guarantee/);
    expect(check(inbound({ tail_number: "N123AB" }), outbound({ tail_number: "N987AB" })).same_tail).toBe(false);
  });

  it("retains association ambiguity and does not claim shared traveler identity", () => {
    const result = check({ ...inbound(), identity_ambiguous: true }, outbound());
    expect(result.inbound.identity_ambiguous).toBe(true);
    expect(result.pair_kind).toBe("proposed_explicit_pair");
    expect(result.identity_notice).toMatch(/does not establish/);
    expect(result.unknown_factors).toEqual(expect.arrayContaining(["boarding_cutoff", "security", "walking_time", "immigration"]));
    expect(result.cached_data_notice).toMatch(/No network refresh/);
  });

  it("labels cancellation, future actual data and departed outbound honestly", () => {
    expect(check(inbound({ is_cancelled: 1 }), outbound()).risk).toBe("cancelled");
    expect(check(inbound(), outbound({ is_cancelled: 1 })).risk).toBe("cancelled");
    const future = check(inbound(), outbound({ departureScheduleGateActual: at(20) }));
    expect(future.risk).toBe("unknown");
    expect(future.departure_gate_time_basis).toBe("departureScheduleGateOriginal");
    expect(future.timestamp_issues.outbound.departureScheduleGateActual).toBe("future_actual_timestamp");
  });
});

describe("review regressions: shared chronology validation", () => {
  it("M1/Gemini M2 rejects gate ETA before touchdown in tracking and connection, retaining diagnostics", () => {
    const leg = inbound({ arrivalScheduleRunwayActual: at(-5), arrivalScheduleGateEstimated: at(-10), arrivalScheduleGateOriginal: at(40) });
    const timing = deriveTrackingTiming(leg.flight, NOW);
    const result = check(leg, outbound({ departureScheduleGateOriginal: at(60) }));
    expect(timing.phase).toBe("taxi_in");
    expect(timing.minutes_to_gate).toBeNull();
    expect(timing.gate_time_basis).toBeNull();
    expect(result.arrival_gate_at).toBeNull();
    expect(result.layover_minutes).toBeNull();
    expect(result.risk).toBe("unknown");
    expect(result.timestamp_issues.inbound.arrivalScheduleGateEstimated).toBe("gate_arrival_precedes_touchdown");
    expect(timing.timestamp_issues).toEqual(result.timestamp_issues.inbound);
    expect(timing.timestamp_conflicts.arrivalScheduleGateEstimated).toEqual(["arrivalScheduleRunwayActual"]);
  });

  it.each(["arrivalScheduleGateEstimated", "arrivalScheduleGateOriginal"] as const)("rejects reversed %s without a runway schedule, rather than selecting another unchecked field", (field) => {
    const leg = inbound({ departureScheduleGateOriginal: at(80), arrivalScheduleRunwayOriginal: null,
      arrivalScheduleGateEstimated: field.endsWith("Estimated") ? at(20) : null, arrivalScheduleGateOriginal: at(20) });
    const timing = deriveTrackingTiming(leg.flight, NOW);
    expect(timing.minutes_to_gate).toBeNull();
    expect(timing.gate_countdown_reason).toBe("gate_arrival_precedes_departure");
    const result = check(leg, outbound({ departureScheduleGateOriginal: at(60) }));
    expect(result.arrival_gate_time_basis).toBeNull();
    expect(result.timestamp_issues.inbound[field]).toBe("gate_arrival_precedes_departure");
    expect(result.risk).toBe("unknown");
  });

  it("validates every arrival fallback against runway arrival, not just the preferred ETA", () => {
    const result = check(inbound({ arrivalScheduleGateEstimated: "invalid", arrivalScheduleGateOriginal: at(10), arrivalScheduleRunwayEstimated: at(20) }), outbound());
    expect(result.arrival_gate_at).toBeNull();
    expect(result.timestamp_issues.inbound).toMatchObject({ arrivalScheduleGateEstimated: "invalid_timestamp", arrivalScheduleGateOriginal: "gate_arrival_precedes_runway_arrival" });
    expect(result.risk).toBe("unknown");
  });

  it("uses a labelled valid scheduled gate fallback for malformed ETA in both paths", () => {
    const leg = inbound({ arrivalScheduleGateEstimated: "invalid", arrivalScheduleGateOriginal: at(25) });
    const timing = deriveTrackingTiming(leg.flight, NOW);
    const result = check(leg, outbound());
    expect(timing.minutes_to_gate).toBe(25);
    expect(timing.gate_time_basis).toBe("arrivalScheduleGateOriginal");
    expect(result.arrival_gate_time_basis).toBe(timing.gate_time_basis);
    expect(result.layover_minutes).toBe(25);
    expect(result.risk).toBe("below_minimum");
    expect(result.timestamp_issues.inbound.arrivalScheduleGateEstimated).toBe("invalid_timestamp");
  });

  it.each(["departureScheduleGateEstimated", "departureScheduleGateOriginal"] as const)("validates outbound %s fallback against actual takeoff", (field) => {
    const result = check(inbound(), outbound({ departureScheduleRunwayActual: at(-10), departureScheduleGateEstimated: field.endsWith("Estimated") ? at(10) : "bad", departureScheduleGateOriginal: at(20) }));
    expect(result.departure_gate_at).toBeNull();
    expect(result.timestamp_issues.outbound[field]).toBe("gate_departure_follows_runway_or_arrival");
    expect(result.risk).toBe("unknown");
  });

  it.each(["departureScheduleGateEstimated", "departureScheduleRunwayEstimated"] as const)("M2 uses current %s rather than stale original departure as landing bound", (field) => {
    const timing = deriveTrackingTiming(flight({ departureScheduleGateOriginal: at(-100), [field]: at(40), arrivalScheduleRunwayEstimated: at(30), arrivalScheduleGateOriginal: at(35) }), NOW);
    expect(timing.minutes_to_landing).toBeNull();
    expect(timing.landing_countdown_state).toBe("unknown");
    expect(timing.timestamp_issues.arrivalScheduleRunwayEstimated).toBe("runway_arrival_precedes_departure");
    expect(timing.timestamp_conflicts.arrivalScheduleRunwayEstimated).toEqual([field]);
    expect(timing.minutes_to_gate).toBeNull();
  });

  it("does not treat gate ETA exactly now as actual arrival", () => {
    const timing = deriveTrackingTiming(flight({ arrivalScheduleRunwayOriginal: null, arrivalScheduleGateEstimated: at(0) }), NOW);
    expect(timing.minutes_to_gate).toBeNull();
    expect(timing.gate_countdown_reason).toBe("gate_arrival_time_passed_without_actual_gate_arrival");
    expect(timing.phase).toBe("unknown");
    expect(deriveTrackingTiming(flight({ arrivalScheduleGateActual: at(0) }), NOW).minutes_to_gate).toBe(0);
  });

  it("Gemini M1 keeps the maximum actual watermark and rejects both actual gate selections", () => {
    const leg = inbound({ departureScheduleGateActual: at(-10), departureScheduleRunwayActual: at(-50), arrivalScheduleRunwayActual: at(-40), arrivalScheduleGateActual: at(-30) });
    const timing = deriveTrackingTiming(leg.flight, NOW);
    expect(timing.timestamp_issues).toMatchObject({ departureScheduleGateActual: "inconsistent_actual_milestones", departureScheduleRunwayActual: "out_of_order_actual_milestones", arrivalScheduleRunwayActual: "out_of_order_actual_milestones", arrivalScheduleGateActual: "out_of_order_actual_milestones" });
    expect(timing.phase).toBe("unknown");
    expect(check(leg, outbound()).arrival_gate_time_basis).not.toBe("arrivalScheduleGateActual");
    const departing = outbound({ departureScheduleGateActual: at(-5), departureScheduleRunwayActual: at(-20) });
    const result = check(inbound(), departing);
    expect(result.departure_gate_time_basis).toBe("departureScheduleGateOriginal");
    expect(result.risk).toBe("unknown");
    expect(result.risk_reason).toMatch(/Invalid or inconsistent actual/);
  });

  it.each(["inbound", "outbound"])("invalid actuals on %s outrank a coherent negative fallback layover", (side) => {
    const arriving = inbound({ arrivalScheduleGateEstimated: at(60), ...(side === "inbound" ? { departureScheduleGateActual: "bad" } : {}) });
    const departing = outbound(side === "outbound" ? { departureScheduleGateActual: at(10) } : {});
    const result = check(arriving, departing);
    expect(result.layover_minutes).toBe(-10);
    expect(result.risk).toBe("unknown");
    expect(result.risk_reason).toMatch(/Invalid or inconsistent actual/);
  });
});

describe("contradictory current departure estimates", () => {
  it("does not erase a rejected gate estimate and then validate an arrival before it", () => {
    const timing = deriveTrackingTiming(flight({ departureScheduleGateEstimated: at(40), departureScheduleRunwayEstimated: at(30), arrivalScheduleRunwayEstimated: at(35), arrivalScheduleGateEstimated: at(35) }), NOW);
    expect(timing.minutes_to_landing).toBeNull();
    expect(timing.minutes_to_gate).toBeNull();
    expect(timing.timestamp_issues.departureScheduleGateEstimated).toBe("gate_departure_follows_runway_or_arrival");
    expect(timing.timestamp_issues.arrivalScheduleRunwayEstimated).toBe("runway_arrival_precedes_departure");
    expect(timing.timestamp_issues.arrivalScheduleGateEstimated).toBe("gate_arrival_precedes_departure");
  });
});

describe("R2-M1: rejected predictions remain chronology constraints", () => {
  const contradictory = {
    departureScheduleGateOriginal: at(80), departureScheduleRunwayOriginal: at(30),
    arrivalScheduleRunwayOriginal: at(40), arrivalScheduleGateOriginal: at(50),
    arrivalScheduleGateEstimated: null,
  };

  it.each([null, "invalid", at(50)])("adding a contradictory original runway departure cannot validate arrivals (gate ETA %j)", (eta) => {
    for (const runway of [null, at(30)]) {
      const leg = inbound({ ...contradictory, departureScheduleRunwayOriginal: runway, arrivalScheduleGateEstimated: eta });
      const timing = deriveTrackingTiming(leg.flight, NOW);
      const result = check(leg, outbound({ departureScheduleGateOriginal: at(100) }));
      expect(timing.minutes_to_landing).toBeNull();
      expect(timing.landing_at).toBeNull();
      expect(timing.landing_time_basis).toBeNull();
      expect(timing.landing_countdown_state).toBe("unknown");
      expect(timing.minutes_to_gate).toBeNull();
      expect(timing.gate_arrival_at).toBeNull();
      expect(timing.gate_eta).toBeNull();
      expect(result.arrival_gate_at).toBeNull();
      expect(result.arrival_gate_time_basis).toBeNull();
      expect(result.layover_minutes).toBeNull();
      expect(result.risk).toBe("unknown");
      expect(timing.timestamp_issues.arrivalScheduleRunwayOriginal).toBe("runway_arrival_precedes_departure");
      expect(timing.timestamp_issues.arrivalScheduleGateOriginal).toBe("gate_arrival_precedes_departure");
      expect(timing.timestamp_conflicts.arrivalScheduleRunwayOriginal).toEqual(["departureScheduleGateOriginal"]);
      expect(timing.timestamp_conflicts.arrivalScheduleGateOriginal).toEqual(["departureScheduleGateOriginal"]);
      expect(result.timestamp_issues.inbound).toEqual(timing.timestamp_issues);
      expect(result.timestamp_conflicts.inbound).toEqual(timing.timestamp_conflicts);
      if (runway !== null) expect(timing.timestamp_conflicts.departureScheduleGateOriginal).toEqual(["departureScheduleRunwayOriginal"]);
      if (eta === "invalid") expect(timing.timestamp_issues.arrivalScheduleGateEstimated).toBe("invalid_timestamp");
    }
  });

  it.each(["Original", "Estimated"] as const)("retains rejected gate %s evidence against every arrival tier and unchecked fallback", (tier) => {
    for (const arrivalTier of ["Original", "Estimated"] as const) {
      const leg = inbound({ ...contradictory,
        [`departureScheduleGate${tier}`]: at(80), [`departureScheduleRunway${tier}`]: at(30),
        [`arrivalScheduleRunway${arrivalTier}`]: at(40), [`arrivalScheduleGate${arrivalTier}`]: at(50),
      });
      const timing = deriveTrackingTiming(leg.flight, NOW);
      expect(timing.minutes_to_landing).toBeNull();
      expect(timing.minutes_to_gate).toBeNull();
      expect(check(leg, outbound()).arrival_gate_at).toBeNull();
      expect(timing.timestamp_conflicts[`arrivalScheduleRunway${arrivalTier}`]).toEqual([`departureScheduleGate${tier}`]);
      expect(timing.timestamp_conflicts[`arrivalScheduleGate${arrivalTier}`]).toEqual([`departureScheduleGate${tier}`]);
    }
  });

  it.each([
    { departureScheduleGateOriginal: at(20) },
    { departureScheduleGateEstimated: at(20) },
    { departureScheduleGateEstimated: at(20), departureScheduleRunwayEstimated: at(30) },
    { departureScheduleGateActual: at(-20), departureScheduleRunwayActual: at(-10) },
  ])("keeps coherent or superseding departure evidence numeric: %j", (overrides) => {
    const leg = inbound({ ...contradictory, ...overrides });
    const timing = deriveTrackingTiming(leg.flight, NOW);
    const result = check(leg, outbound({ departureScheduleGateOriginal: at(100), arrivalScheduleRunwayOriginal: at(200), arrivalScheduleGateOriginal: at(210) }));
    expect(timing.minutes_to_landing).toBe(40);
    expect(timing.minutes_to_gate).toBe(50);
    expect(timing.landing_time_basis).toBe("arrivalScheduleRunwayOriginal");
    expect(timing.gate_time_basis).toBe("arrivalScheduleGateOriginal");
    expect(result.arrival_gate_at).toBe(at(50));
    expect(result.layover_minutes).toBe(50);
    expect(result.risk).toBe("meets_cached_minimum");
  });

  it("current arrival estimates supersede stale original arrivals without erasing departure constraints", () => {
    const timing = deriveTrackingTiming(flight({ ...contradictory, arrivalScheduleRunwayEstimated: at(90), arrivalScheduleGateEstimated: at(100) }), NOW);
    expect(timing.minutes_to_landing).toBe(90);
    expect(timing.minutes_to_gate).toBe(100);
    expect(timing.landing_time_basis).toBe("arrivalScheduleRunwayEstimated");
    expect(timing.gate_time_basis).toBe("arrivalScheduleGateEstimated");
    expect(timing.timestamp_issues.departureScheduleGateOriginal).toBe("gate_departure_follows_runway_or_arrival");
  });
});
