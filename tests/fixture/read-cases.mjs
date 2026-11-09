import assert from "node:assert/strict";
import { IDS } from "./create.mjs";

export const READ_CASES = [
  ["flighty_about", {}, (body) => assert.equal(body.version, "1.10.1")],
  ["flighty_list_flights", {}, (body) => {
    assert.equal(body.count, 2);
    assert.deepEqual(new Set(body.results.map((flight) => flight.id)), new Set([IDS.flight, IDS.manual]));
  }],
  ["flighty_current_flights", {}, (body) => assert.equal(body.count, 2)],
  ["flighty_get_flight", { flight_id: IDS.flight }, (body) => {
    assert.equal(body.result.id, IDS.flight);
    assert.equal(body.result.booking_reference, "SYNTHETIC-PNR");
  }],
  ["flighty_search_flights", { airline: "ZZ", departure_airport: "AAA" }, (body) => assert.equal(body.count, 1)],
  ["flighty_get_flight_status", { flight_number: "ZZ101" }, (body) => assert.equal(body.result.departure_gate, "A1")],
  ["flighty_get_tracking_status", { flight_id: IDS.followed }, (body) => {
    assert.equal(body.result.flight.id, IDS.followed);
    assert.equal(body.result.associations[0].tracking_source, "owner_followed");
    assert.equal(body.result.associations[0].passenger_name, null);
  }],
  ["flighty_check_connection", { inbound_flight_id: IDS.flight, outbound_flight_id: IDS.manual }, (body) => {
    assert.equal(body.result.layover_minutes, 120);
    assert.equal(body.result.same_tail, null);
    assert.equal(body.result.min_connection_time_minutes, 30);
  }],
  ["flighty_get_delay_forecast", { flight_number: "ZZ101" }, (body) => assert.equal(body.observations, 100)],
  ["flighty_get_flight_stats", {}, (body) => assert.equal(body.total_flights, 2)],
  ["flighty_get_connections", {}, (body) => {
    assert.equal(body.count, 1);
    assert.equal(body.results[0].layover_minutes, 120);
  }],
  ["flighty_list_friend_flights", {}, (body) => {
    assert.equal(body.count, 2);
    assert.equal(body.results.find(row => row.id === IDS.friendFlight).friend_name, "Synthetic Friend");
    assert.equal(body.results.find(row => row.id === IDS.followed).friend_name, null);
  }],
  ["flighty_search_airports", { query: "AAA" }, (body) => assert.equal(body.results[0].iata, "AAA")],
  ["flighty_search_airlines", { query: "ZZ" }, (body) => assert.equal(body.results[0].name, "Synthetic Airline")],
];

export const WRITE_NAMES = ["flighty_add_flight", "flighty_follow_flight", "flighty_remove_flight"];
export const READ_NAMES = READ_CASES.map(([name]) => name).sort();

export function parseToolResult(result) {
  assert.notEqual(result.isError, true, "Tool must succeed against synthetic data.");
  const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  // Permit an external-data label before the existing JSON or a shared data envelope.
  const start = text.indexOf("{");
  assert.ok(start >= 0, "Expected structured JSON tool data.");
  const body = JSON.parse(text.slice(start));
  return body.data ?? body;
}
