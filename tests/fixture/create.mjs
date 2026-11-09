#!/usr/bin/env node
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const IDS = Object.freeze({
  owner: "11111111-1111-4111-8111-111111111111",
  friend: "22222222-2222-4222-8222-222222222222",
  flight: "33333333-3333-4333-8333-333333333333",
  manual: "44444444-4444-4444-8444-444444444444",
  friendFlight: "55555555-5555-4555-8555-555555555555",
  airline: "66666666-6666-4666-8666-666666666666",
  uncached: "77777777-7777-4777-8777-777777777777",
  followed: "88888888-8888-4888-8888-888888888888",
});
export const SYNTHETIC_TOKEN = `fixture.${Buffer.from(JSON.stringify({ sub: IDS.owner })).toString("base64url")}.not-a-real-signature`;
export const SYNC_URL = "https://sync.flightyapp.com/synthetic-fixture";

// All columns needed by the local read queries, including the ManualFlight union.
const flightColumns = `
  id TEXT, number TEXT, airlineId TEXT, departureAirportId TEXT, scheduledArrivalAirportId TEXT,
  departureTerminal TEXT, departureGate TEXT,
  departureScheduleGateOriginal INTEGER, departureScheduleGateEstimated INTEGER, departureScheduleGateActual INTEGER,
  departureScheduleRunwayOriginal INTEGER, departureScheduleRunwayEstimated INTEGER, departureScheduleRunwayActual INTEGER,
  arrivalTerminal TEXT, arrivalGate TEXT, arrivalBaggageBelt TEXT,
  arrivalScheduleGateOriginal INTEGER, arrivalScheduleGateEstimated INTEGER, arrivalScheduleGateActual INTEGER,
  arrivalScheduleRunwayOriginal INTEGER, arrivalScheduleRunwayEstimated INTEGER, arrivalScheduleRunwayActual INTEGER,
  isCancelled INTEGER, distance REAL, equipmentTailNumber TEXT, equipmentModelName TEXT,
  equipmentManufacturer TEXT, equipmentPlaneName TEXT, equipmentCruisingSpeed REAL,
  arrivalWeatherConditionName TEXT, arrivalWeatherTemperature REAL,
  delayForecastDelayMean REAL, delayForecastObservations INTEGER, delayForecastEarlyCount INTEGER,
  delayForecastOntimeCount INTEGER, delayForecastLate15Count INTEGER, delayForecastLate30Count INTEGER,
  delayForecastLate45Count INTEGER, delayForecastCanceledCount INTEGER, delayForecastDivertedCount INTEGER,
  checkInScheduleOpen INTEGER, checkInScheduleClose INTEGER, deleted INTEGER`;

export function createFixture(parentDirectory) {
  if (!parentDirectory) throw new Error("An explicit synthetic fixture parent directory is required.");
  const parent = resolve(parentDirectory);
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "flighty-fixture-"));
  const mainPath = join(directory, "MainFlightyDatabase.db");
  const home = join(directory, "home");
  const legacyDirectory = join(home, "Library/Containers/com.flightyapp.flighty/Data/Documents");
  mkdirSync(legacyDirectory, { recursive: true });
  const legacyPath = join(legacyDirectory, "Flighty.sqlite");
  const main = new DatabaseSync(mainPath);
  try {
    main.exec(`
      CREATE TABLE Account (authToken TEXT);
      CREATE TABLE SyncInfo (nextURL TEXT, lastSync INTEGER);
      CREATE TABLE Flight (${flightColumns});
      CREATE TABLE ManualFlight (${flightColumns});
      CREATE TABLE UserFlight (userId TEXT, flightId TEXT, importSource TEXT, deleted INTEGER, isMyFlight INTEGER);
      CREATE TABLE UserManualFlight (userId TEXT, flightId TEXT, importSource TEXT, deleted INTEGER, isMyFlight INTEGER);
      CREATE TABLE Airport (id TEXT, name TEXT, iata TEXT, icao TEXT, city TEXT, country TEXT, countryCode TEXT,
        timeZoneIdentifier TEXT, latitude REAL, longitude REAL, website TEXT, relevance INTEGER, deleted INTEGER);
      CREATE TABLE Airline (id TEXT, name TEXT, iata TEXT, icao TEXT, alliance TEXT, website TEXT,
        callsign TEXT, formattedPhone TEXT, relevance INTEGER, deleted INTEGER);
      CREATE TABLE Ticket (flightId TEXT, userId TEXT, seatNumber TEXT, seatPosition TEXT,
        cabinClass TEXT, pnr TEXT, flightReason TEXT);
      CREATE TABLE Profile (userId TEXT, fullName TEXT, firstName TEXT);
      CREATE TABLE Connection (id TEXT, arrivingFlightId TEXT, departingFlightId TEXT,
        waitingAirportId TEXT, mctMinutes INTEGER, deleted INTEGER);
    `);
    main.prepare("INSERT INTO Account VALUES (?)").run(SYNTHETIC_TOKEN);
    main.prepare("INSERT INTO SyncInfo VALUES (?, ?)").run(SYNC_URL, 1);
    for (const [id, iata, city] of [["airport-a", "AAA", "Fixture Origin"], ["airport-b", "BBB", "Fixture Connection"], ["airport-c", "CCC", "Fixture Destination"]]) {
      main.prepare("INSERT INTO Airport VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)").run(
        id, `${city} Airport`, iata, `K${iata}`, city, "Synthetic Country", "XX", "UTC", 0, 0, "https://example.invalid", 100,
      );
    }
    main.prepare("INSERT INTO Airline VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)").run(
      IDS.airline, "Synthetic Airline", "ZZ", "ZZZ", "Fixture Alliance", "https://example.invalid", "SYNTHETIC", "000", 100,
    );
    const now = Math.floor(Date.now() / 1000);
    for (const [table, id, number, departure, arrival, depTime, owner, passenger = 1] of [
      ["Flight", IDS.flight, "101", "airport-a", "airport-b", now - 3600, IDS.owner],
      ["ManualFlight", IDS.manual, "102", "airport-b", "airport-c", now + 10800, IDS.owner],
      ["Flight", IDS.friendFlight, "103", "airport-a", "airport-c", now + 7200, IDS.friend],
      ["Flight", IDS.followed, "104", "airport-a", "airport-c", now + 14400, IDS.owner, 0],
    ]) {
      main.prepare(`INSERT INTO ${table} (id, number, airlineId, departureAirportId, scheduledArrivalAirportId,
        departureScheduleGateOriginal, arrivalScheduleGateOriginal, departureGate, arrivalGate, distance, isCancelled,
        delayForecastObservations, delayForecastDelayMean, delayForecastEarlyCount, delayForecastOntimeCount,
        delayForecastLate15Count, delayForecastLate30Count, delayForecastLate45Count, delayForecastCanceledCount,
        delayForecastDivertedCount) VALUES (?, ?, ?, ?, ?, ?, ?, 'A1', 'B2', 1000, 0, 100, 5, 10, 70, 10, 5, 3, 1, 1)`)
        .run(id, number, IDS.airline, departure, arrival, depTime, depTime + 7200);
      main.prepare(`INSERT INTO ${table === "Flight" ? "UserFlight" : "UserManualFlight"} VALUES (?, ?, 'synthetic', NULL, ?)`).run(owner, id, passenger);
    }
    main.prepare("INSERT INTO Ticket VALUES (?, ?, '1A', 'window', 'economy', 'SYNTHETIC-PNR', 'fixture')").run(IDS.flight, IDS.owner);
    main.prepare("INSERT INTO Ticket VALUES (?, ?, '3B', 'aisle', 'business', 'SYNTHETIC-FOLLOW-PNR', 'fixture')").run(IDS.followed, IDS.owner);
    main.prepare("INSERT INTO Profile VALUES (?, 'Synthetic Friend', 'Synthetic')").run(IDS.friend);
    main.prepare("INSERT INTO Connection VALUES ('synthetic-connection', ?, ?, 'airport-b', 30, NULL)").run(IDS.flight, IDS.manual);
  } finally { main.close(); }
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec("CREATE TABLE ZUSER (ZTOKEN TEXT)");
  legacy.close();
  writeFileSync(join(directory, ".flighty-synthetic-fixture.json"), JSON.stringify({ kind: "flighty-synthetic-v1", mainPath, home, ids: IDS }));
  return { directory, mainPath, legacyPath, home, ids: IDS };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4 || process.argv[2] !== "--directory") {
    throw new Error("Usage: node tests/fixture/create.mjs --directory /explicit/job/fixture");
  }
  console.log(JSON.stringify(createFixture(process.argv[3]), null, 2));
}
