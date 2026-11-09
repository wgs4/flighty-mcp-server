# Flighty MCP Server

> **Local wishlist extension.** Adds cached UUID tracking, proposed connection checks and honest freshness metadata to source base `42100cc`. See [verification evidence and limits](FORK-NOTES.md#wishlist-verification-evidence-and-limits) for the scope of reported checks; this reference does not identify a new installed release.

For this fork's source installation, guarded writes, existing-client updates and lifecycle commands, follow [FORK-NOTES.md](FORK-NOTES.md). The earlier hardening assessment and retained dependency advisories are in [SECURITY_REVIEW.md](SECURITY_REVIEW.md).

A zero-config [MCP](https://modelcontextprotocol.io/) server that connects AI assistants to the [Flighty](https://www.flightyapp.com/) flight tracking app. Ask about your flights, check statuses, look up delay forecasts, and add or remove flights — all through natural conversation.

Just install Flighty on your Mac and connect the server. It reads all credentials and configuration directly from the app — no API keys, no tokens, no setup.

## What it does

This server gives any MCP-compatible AI assistant (Claude, etc.) full read/write access to your Flighty data:

- **"What's my current flight?"** — shows in-progress, recently landed, and about-to-depart flights
- **"What's my next flight?"** — returns the soonest upcoming flight first
- **"How often is AA179 delayed?"** — historical on-time performance with percentage breakdowns
- **"Show my flight stats for 2025"** — total flights, miles, top airlines, top routes
- **"Add DL10 on April 20"** — adds the flight to your Flighty account, requests cross-device account sync
- **"Follow UA194 on December 25"** — track someone else's flight (e.g. to pick them up), syncs to all devices
- **"Remove that flight"** — previews deletion, then requires a one-use confirmation code
- **"Are any friends flying soon?"** — checks cached shared/followed upcoming flights
- **"What version of the Flighty tool is this?"** — server info, capabilities, and version

Read operations query Flighty's local SQLite database directly (fast, offline-capable). Write operations call Flighty's API so changes sync to your phone, watch, and widgets. Responses include contextual metadata (sort order, timestamp format) to help AI assistants interpret results correctly. Real API behavior and cross-device timing are not certified by synthetic tests.

## Requirements

- **macOS** — Flighty stores its database in the macOS app sandbox
- **Flighty macOS app** — installed and signed in
- **Flighty Pro** — required for the add/remove flight features
- **Node.js 24+** (only for manual install; the .mcpb bundle includes its own runtime)

## Installation

### Claude Desktop (.mcpb)

Do not install committed `dist/*.mcpb` bundles for this fork. Use the reviewed source-build procedure in [FORK-NOTES.md](FORK-NOTES.md); optional packing has not been verified.

### Claude Code

```bash
git clone https://github.com/wgs4/flighty-mcp-server.git
cd flighty-mcp-server
npm ci --ignore-scripts
npm run build
```

Add to your MCP config (`~/.claude/settings.local.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "flighty": {
      "command": "node",
      "args": ["/absolute/path/to/flighty-mcp-server/build/index.js"]
    }
  }
}
```

### Claude Desktop (manual)

Build from source as above, then add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "flighty": {
      "command": "node",
      "args": ["/absolute/path/to/flighty-mcp-server/build/index.js"]
    }
  }
}
```

Restart the client after adding the config.

## Read-Only Mode

The local wishlist extension exposes 17 tools by default (14 reads and 3 writes), including three that modify your Flighty account: `flighty_add_flight`, `flighty_follow_flight`, and `flighty_remove_flight`. If you only want Claude to read your flight data, you can disable the write tools so they don't appear in `tools/list` at all — the safest way to cap the blast radius.

**Claude Desktop (`.mcpb`):** during install, check the **Read-Only Mode** box. You can toggle it later from the extension's settings.

**Claude Code / manual install:** set the environment variable before launching the server. Add `env` to your MCP config:

```json
{
  "mcpServers": {
    "flighty": {
      "command": "node",
      "args": ["/absolute/path/to/flighty-mcp-server/build/index.js"],
      "env": { "FLIGHTY_READ_ONLY": "1" }
    }
  }
}
```

After trimming, case-insensitive `1/true/yes/on` enables read-only mode; `0/false/no/off`, empty or unset enables writes. Other values refuse startup. Read-only removes exactly `flighty_add_flight`, `flighty_follow_flight` and `flighty_remove_flight`, leaving 14 read tools; API methods also reject writes. Restart the server to change policy. `flighty_about` reports the mode. God mode (writes enabled) remains the default.

## Friend-Share Installs

If you use Flighty via someone else's account (shared through Flighty Friends), your locally signed-in Flighty account may own no flights itself — all the flights in the local database belong to the friend whose Flighty Pro account you're piggybacking on. In that setup, the server automatically falls back to picking the user with the most flights in the database. If your install has multiple people's flights and the server picks the wrong one, pin the correct user with an environment variable:

```json
{
  "mcpServers": {
    "flighty": {
      "command": "node",
      "args": ["/absolute/path/to/flighty-mcp-server/build/index.js"],
      "env": { "FLIGHTY_OWNER_USER_ID": "the-userId-you-want" }
    }
  }
}
```

You can find the right userId by querying `SELECT userId, COUNT(*) FROM UserFlight GROUP BY userId ORDER BY 2 DESC` against `~/Library/Containers/com.flightyapp.flighty/Data/Documents/MainFlightyDatabase.db`.

## Tools

Local wishlist extension: 17 tools (14 read, including about, plus 3 writes). Read-only hides exactly the three write tools. The earlier source baseline had 15 default / 12 read-only tools.

### Flight Management

| Tool | Description |
|------|-------------|
| `flighty_list_flights` | List your flights — upcoming (sorted soonest first), by year, or all (sorted most recent first) |
| `flighty_current_flights` | Active travel context: flights departing within ±24 hours of now |
| `flighty_get_flight` | Get details for a single flight by UUID or flight number (e.g., "AA179") |
| `flighty_search_flights` | Search your flight history by airline, airports, or date range |
| `flighty_add_flight` | Add a flight by code and date (e.g., "DL10" on "2026-04-20"). Syncs to all devices |
| `flighty_follow_flight` | Follow a flight without being a passenger (e.g., tracking someone's flight). Syncs to all devices |
| `flighty_remove_flight` | Remove a flight by UUID. Permanent deletion across all devices |

### Flight Intelligence

| Tool | Description |
|------|-------------|
| `flighty_get_flight_status` | Cached status, milestone phase, gate, delay and weather |
| `flighty_get_delay_forecast` | Historical on-time stats: % early, on-time, late, cancelled, diverted |
| `flighty_get_flight_stats` | Aggregate stats: total flights, miles, circumnavigations, top airlines and routes |
| `flighty_get_connections` | Legacy owner-passenger scheduled connection list |
| `flighty_get_tracking_status` | Exact eligible cached UUID: associations, runway landing and taxi milestones |
| `flighty_check_connection` | Proposed explicit UUID pair: cached gate layover, tail comparison and conditional risk |

### Social and Reference

| Tool | Description |
|------|-------------|
| `flighty_list_friend_flights` | Cached shared passenger and owner-followed rows; membership does not verify friendship |
| `flighty_search_airports` | Search airports by IATA/ICAO code, city, or name |
| `flighty_search_airlines` | Search airlines by IATA/ICAO code, name, or alliance |

### Server Info

| Tool | Description |
|------|-------------|
| `flighty_about` | Version, author, repository, capabilities, and requirements |

## Tool details

### flighty_list_flights

Lists your flights with smart sort order based on the filter:

- **`upcoming_only=true`**: sorted soonest first — the first result is your next flight
- **No filter or `year`**: sorted most recent departure first (natural browsing order)

**Parameters:**
- `upcoming_only` (boolean, default: false) — only flights with future departures, sorted soonest first
- `year` (integer, optional) — filter to a specific year
- `limit` (integer, 1-200, default: 50)
- `offset` (integer, default: 0)

For flights currently in progress or recently landed, use `flighty_current_flights` instead.

Includes both auto-detected commercial flights and manually-entered flights (private/charter operators not in Flighty's commercial database, or commercial flights the user added by hand). Same applies to `flighty_search_flights`, `flighty_get_flight`, `flighty_current_flights`, `flighty_get_flight_status`, `flighty_get_delay_forecast`, `flighty_get_flight_stats`, and `flighty_get_connections`.

---

### flighty_current_flights

Returns flights departing within 24 hours in either direction from now. Captures in-progress flights, recently landed flights (baggage claim, layovers), and flights about to depart.

**Parameters:** `limit` (1–200, default 50), `offset` (0–100000, default 0). Sorted by departure time ascending (earliest first).

---

### flighty_get_flight

Looks up a single flight by UUID or flight number.

**Parameters (provide one):**
- `flight_id` (string) — internal Flighty UUID
- `flight_number` (string) — e.g., "AA179", "DL10". If flown multiple times, returns the most recent instance

---

### flighty_search_flights

Searches your flight history with combinable AND filters. Sorted most recent departure first.

**Parameters (all optional):**
- `airline` — IATA code ("AA") or partial name ("American")
- `departure_airport` — IATA code ("JFK") or city ("New York")
- `arrival_airport` — IATA code ("SFO") or city ("San Francisco")
- `after` — flights departing on or after this date ("2025-01-01")
- `before` — flights departing on or before this date ("2025-12-31")
- `limit` (integer, 1-200, default: 50)

---

### flighty_get_flight_status

Returns the operational status of a flight that is already in the user's Flighty database. This only works for flights the user has added to Flighty — it cannot look up arbitrary flight numbers.

**Parameters:**
- `flight_number` (string) — a flight in the user's database, e.g., "UA194"

**Returns:** Existing gate-time/status fields plus `phase` and `phase_reason`. In the extension, `status` supports `scheduled`, `delayed`, `taxi_out`, `in_air`, `landed`, `cancelled`, `unknown`. `in_air` requires cached actual runway departure; `landed` includes actual touchdown. `phase` distinguishes `taxi_in` from `at_gate`. Gate departure alone means taxi-out, not airborne. Flight-number lookup remains owner-passenger scoped; use the exact UUID tracking tool for eligible shared/followed rows.

Status is cached and can be stale. A database-level sync marker does not establish per-flight freshness; this tool makes no live status API calls.

---

### flighty_get_delay_forecast

Historical on-time performance for a flight that is already in the user's Flighty database. Flighty attaches delay forecast data when a flight is added to the user's account — this tool reads that stored data. It cannot look up forecasts for arbitrary flight numbers that aren't in the database.

**Parameters:**
- `flight_number` (string) — a flight in the user's database, e.g., "AA179"

**Returns:** Number of observations (sample size), mean delay in minutes, and percentage breakdowns: early, on-time, late (15/30/45+ min), cancelled, diverted. Returns null if no forecast data is available.

---

### flighty_search_airports

Searches Flighty's airport database. Exact IATA/ICAO matches are prioritized over fuzzy name/city matches.

**Parameters:**
- `query` (string) — IATA code, ICAO code, city name, or airport name
- `limit` (integer, 1-50, default: 10)

---

### flighty_search_airlines

Searches Flighty's airline database.

**Parameters:**
- `query` (string) — IATA code, ICAO code, airline name, or alliance name
- `limit` (integer, 1-50, default: 10)

---

### flighty_get_flight_stats

Aggregate statistics across your flight history.

**Parameters:**
- `year` (integer, optional) — filter to a specific year; omit for all-time

**Returns:** Total flights, distance (km and miles), earth circumnavigations, unique departure/arrival airports, unique airlines, `countries_visited` (deduped across departure and arrival countries), cancelled flight count, top 5 airlines, top 5 routes.

Includes both auto-detected commercial flights and manually-entered flights (e.g., private/charter operators not in Flighty's commercial database).

---

### flighty_get_connections

Legacy owner-passenger scheduled connection list, sorted by first leg departure time descending. It uses original scheduled gate times, scopes the inbound passenger membership to the resolved owner, and does not validate outbound membership as the explicit-pair tool does. Missing times can yield a legacy zero layover; this is not an operational risk assessment. Use `flighty_check_connection` for a followed/shared pair or a check with validated time bases and membership on both legs.

**Parameters:** `limit` (1–200, default 50), `offset` (0–100000, default 0).

**Returns:** For each connection: inbound flight (first leg, e.g., "AA1449"), origin airport, connection airport, outbound flight (second leg, e.g., "AA1166"), destination airport, arrival/departure times, layover duration in minutes, and minimum connection time.

---

### flighty_list_friend_flights

Cached shared passenger and owner-followed flights. A local membership or `Profile` name does not verify friendship. Manually followed rows keep `friend_name: null`; a name filter cannot discover their passenger. Same sort behavior as `list_flights` — upcoming sorted soonest first, otherwise most recent first.

**Parameters:**
- `friend_name` (string, optional) — partial match on name
- `upcoming_only` (boolean, default: false) — future flights only, sorted soonest first
- `year` (integer, optional)
- `limit` (integer, 1-200, default: 50)
- `offset` (integer, default: 0)

---

### flighty_add_flight

Adds a flight to your Flighty account via the Flighty API. The request changes your remote account; cross-device propagation depends on Flighty and was not tested against a real account.

**Parameters:**
- `flight_code` (string) — e.g., "DL10", "UA194". The 2-character airline prefix is parsed automatically
- `date` (string) — departure date in YYYY-MM-DD format

**Returns:** The server-side flight UUID on success, or an error if the flight isn't found for that date.

---

### flighty_follow_flight

Follows a flight without marking yourself as a passenger — use this to track someone else's flight (e.g., a family member's arrival). The flight is registered with Flighty's server and syncs to all devices. It will appear in `flighty_list_friend_flights` results (with `friend_name` as `null`).

**Parameters:**
- `flight_code` (string) — e.g., "UA194", "DL10". The airline prefix is parsed automatically
- `date` (string) — departure date in YYYY-MM-DD format

**Returns:** The server-side flight UUID on success, or an error if the flight isn't found for that date.

---

### flighty_remove_flight

Permanently removes a flight from your Flighty account across all devices.

**Parameters:**
- `flight_id` (string) — the flight UUID (from `list_flights` or `add_flight` results)
- `confirm_code` (string, optional) — code returned by the first preview call

**Confirmation:** First call returns a preview and `confirm_code`. Repeat with the same `flight_id` and code within five minutes. The one-use code is process-local and bound to the preview and available owner identity. Restart or changed details invalidate it; it is consumed before the request, including failure. There is no automatic retry. Removal is permanent across devices; inspect account state before attempting another preview after a failed request.

---

### flighty_get_tracking_status

Required input: `flight_id`, one exact cached UUID. Entirely synthetic example:

```json
{"flight_id":"11111111-1111-4111-8111-111111111111"}
```

No flight-number fallback. Eligibility includes the resolved owner's passenger/followed memberships and cached non-owner passenger memberships in `Flight`/`ManualFlight`. Deleted/unlinked rows and other users' followed rows are excluded. No eligible record returns `result: null` with `reason: "no_eligible_cached_flight_for_uuid"`. Conflicting operational records for the same UUID are rejected rather than arbitrarily chosen.

`result` contains `flight`, `associations`, `identity_ambiguous`, `attribution_notice`, `departure_airport_id`, `arrival_airport_id`, `departure_code_unambiguous`, `arrival_code_unambiguous`, `timestamp_issues` and `timing`. Associations retain `user_id`, booking/seat fields, `tracking_source` (`owner_passenger`, `owner_followed`, `cached_shared_passenger`), `friendship_status: "unverified"`, `passenger_name`, `passenger_name_source` (`profile` or `unknown`) and `passenger_name_unknown_reason` (`followed_row_does_not_identify_passenger`, `profile_name_missing`, or null when known). Booking fields are `seat_number`, `seat_position`, `cabin_class`, `booking_reference`, `flight_reason` and `import_source`. Multiple associations do not select a traveler; common booking fields become null and remain per association. `Profile.fullName` is cached attribution, not verified friendship or proof of travel. Owner-followed rows never borrow the owner's name; `friend_name` remains null when the passenger is unknown.

`timing` includes `phase`, `phase_reason`, `phase_basis`, `calculated_at` and `timestamp_basis: "UTC"`:

| Phase | Cached actual evidence |
| --- | --- |
| `scheduled` | No actual milestone; compatible future schedule |
| `taxi_out` | Gate departure (pushback) |
| `airborne` | Runway departure |
| `taxi_in` | Runway arrival (touchdown) |
| `at_gate` | Gate arrival |
| `cancelled` | Cached cancellation |
| `unknown` | Missing, invalid, future or contradictory evidence prevents classification |

`minutes_to_landing` is a fractional number of minutes, without rounding; it uses `arrivalScheduleRunwayEstimated`, then explicitly labelled `arrivalScheduleRunwayOriginal`. Read `landing_at`, `landing_time_basis`, `landing_countdown_state` and `landing_countdown_reason` together. States are `estimated`, `scheduled`, `landed`, `overdue`, `unknown`, `cancelled`. A scheduled countdown is time until scheduled landing, not predicted flight duration. A passed ETA without actual touchdown is overdue with a null countdown, including ETA equal to calculation time. Cancellation or unusable timing also gives null; valid actual touchdown supplies zero. Gate ETA never substitutes for landing.

`wheels_down_at`, `taxi_in_elapsed_minutes` and `taxi_in_completed_minutes` describe cached touchdown and elapsed/completed taxi-in intervals, with `taxi_in_reason` for unavailable values. Separate `gate_eta`, `gate_arrival_at`, `gate_time_basis`, `minutes_to_gate` and `gate_countdown_reason` describe gate timing. An expired gate ETA does not prove arrival. Stale milestones cannot prove the aircraft is still taxiing; there is no taxi route, percentage or fresh prediction. `timestamp_issues` and `timestamp_conflicts` diagnose invalid chronology rather than manufacture progress.

---

### flighty_check_connection

Required distinct UUIDs, both checked for eligible cached membership using the tracking rules above. Entirely synthetic example:

```json
{"inbound_flight_id":"11111111-1111-4111-8111-111111111111","outbound_flight_id":"22222222-2222-4222-8222-222222222222"}
```

If either leg lacks eligible membership, the response has `result: null` and `reason: "one_or_both_flight_uuids_have_no_eligible_cached_membership"`. Equal UUIDs are rejected case-insensitively. Both legs and exact-pair cached minimum are read in one SQLite snapshot. This is `pair_kind: "proposed_explicit_pair"`, with `traveler_identity: "not_established_by_pair_check"`; each leg retains its associations and ambiguity. Membership on both flights does not prove the same person is traveling.

Airport continuity uses stable IDs, otherwise unambiguous IATA codes; missing identity stays unknown. `arrival_gate_at` and `departure_gate_at` select chronologically valid actual, estimated, then labelled scheduled gate times and expose `arrival_gate_time_basis` / `departure_gate_time_basis`. Contradictory current predictions must not silently fall back to a stale schedule. `layover_minutes` is outbound gate departure minus inbound gate arrival, not runway-to-runway; missing times are null and negative margins remain negative.

`min_connection_time_minutes`, `min_connection_time_basis` (`cached_exact_pair` or null) and `min_connection_time_reason` use only a valid unambiguous non-deleted exact ordered `Connection` pair with matching known transfer-airport context. Unknown, invalid or conflicting context/MCT remains null; there is no invented default. Supported MCT values are finite numbers from 0 to 1440 minutes, with all matching rows agreeing. Reasons are `no_cached_connection_for_exact_pair`, `unknown_cached_minimum_airport_context`, `conflicting_cached_minimum_airport_contexts`, `cached_minimum_airport_context_mismatch` or `invalid_or_conflicting_cached_minimum`; valid MCT has null reason. `same_tail` is null if either tail is absent/invalid; otherwise it compares normalized cached assignments. A match does not guarantee the aircraft assignment, boarding or a protected connection.

`risk` is `cancelled`, `airport_mismatch`, `unknown`, `missed`, `below_minimum` or `meets_cached_minimum`, with `risk_reason`. Invalid actual chronology yields unknown. A negative selected margin can be labelled missed on its cached bases, not as proof of a passenger's outcome. An already-departed outbound leaves boarding unknown. Meeting cached MCT is no safe-connection guarantee. Boarding cutoff, walking, security, immigration, traveler identity and current data freshness remain unknown. Calculation time is in `calculated_at` with `timestamp_basis: "UTC"`. `inbound` and `outbound` each expose `flight_id`, `flight_number`, `associations`, `identity_ambiguous`, `attribution_notice`, `phase` and `phase_reason`. Other diagnostic fields are `identity_notice`, `layover_reason`, `same_tail_reason`, `tail_notice`, `operational_notice`, `unknown_factors`, per-leg `timestamp_issues` / `timestamp_conflicts`, and `cached_data_notice`. Missing/invalid tail reason is `one_or_both_tail_numbers_missing_or_invalid`; missing gate timing gives `missing_or_invalid_gate_time`.

The legacy `flighty_get_connections` owner-passenger scheduled list remains separate. Prefer this explicit-pair tool for followed/shared connection risk checks; the legacy list does not gain this contract.

---

### Freshness on tool results

Server-authored `queried_at` is the local invocation handling timestamp (or early error construction time), not an exact SQLite snapshot time or remote sync time. JSON results carry `freshness`; plaintext/error text receives a freshness notice and empty content retains response metadata. Errors preserve `isError`. The metadata remains outside removal previews so a changing clock or sync marker alone cannot invalidate confirmation.

`freshness` includes `queried_at`, `queried_at_meaning`, `last_synced_at`, `sync_age_seconds`, `sync_age_minutes`, `status` (`known`, `unknown`, `not_applicable`), `source`, `scope`, `scope_note`, `unknown_reason_code`, `unknown_reason`, `is_future_marker` and `cache_note`. `SyncInfo.lastSync` is a database-level marker, not an identified account's or individual flight's refresh guarantee. Numeric values/strings have unverified epoch/units and return unknown (`unverified_numeric_sync_format`), null sync time and null ages. No Unix/Apple epoch is guessed. Only safely parsed explicit-timezone ISO markers can supply a time; future, invalid, missing or ambiguous markers remain unknown. File modification time and query time never replace sync time.

For database-dependent results, `source` is `"SyncInfo.lastSync"` and `scope` is `"database_sync"`. A complete scan of up to 32 rows selects the chronological maximum only when every nonempty marker is safely parseable. Empty markers are ignored unless all are empty. Any mixed unknown marker keeps sync time and ages null regardless of row order. A 33rd row triggers overflow/unknown instead of silently truncating. Mixed reason priority is future, then numeric, then invalid/ambiguous. Overflow is invalid/ambiguous and does not assert a future marker.

About and reference results use `status: "not_applicable"`, `source: "none"`, `scope: "static_or_reference_data"`. Error/validation results use `status: "unknown"`, `source: "none"`, `scope: "error_or_validation"`. These freshness paths do not query sync state or add owner/credential access; reference catalog reads retain their existing database dependency. Root results and `_meta` carry server-authored `queried_at` and `freshness`; JSON object text also carries them, while non-JSON text receives a freshness notice. Empty content retains root metadata. These fields overwrite externally supplied counterparts.

`sync_age_seconds` is whole seconds; `sync_age_minutes` is rounded to two decimal places. Both are null whenever `last_synced_at` is null. `unknown_reason_code` and its static explanation are null for known timestamps; otherwise the exact codes are:

| Code | Meaning |
| --- | --- |
| `unverified_numeric_sync_format` | Numeric value/string has unknown epoch or units |
| `future_sync_timestamp` | Valid ISO marker is ahead of invocation time; `is_future_marker: true` |
| `invalid_or_ambiguous_sync_timestamp` | Invalid/ambiguous marker or scan overflow |
| `missing_database` | Database unavailable |
| `missing_sync_table` | No SyncInfo table |
| `missing_last_sync_column` | No lastSync column |
| `missing_sync_row` | No rows |
| `empty_last_sync_marker` | All markers null/empty |
| `database_read_error` | Marker read failed |
| `not_applicable_static_or_reference_tool` | About/reference data; sync not queried |
| `error_response_sync_not_queried` | Error/validation path; sync not queried |

Freshness is read separately from flight data. Even a known ISO marker is neither an atomic flight snapshot timestamp nor evidence that an upstream refresh completed for a particular flight.

Re-querying reads the latest committed local cache and does not sync or reset `last_synced_at`. No true refresh action or new API use is included. Background helpers may update the cache without a visible app window; Mac update cadence and per-flight freshness are not guaranteed. Keeping the UI open does not guarantee real-time data.

No live aircraft telemetry source has been verified: `cruising_speed_kmh` is a static aircraft specification and airport coordinates are not aircraft position. Live altitude, ground speed, heading and aircraft coordinates remain deferred. Flighty's [business page](https://flighty.com/business) lists API inquiries, but no usable telemetry or forced-refresh contract has been verified for this extension. This does not establish that such APIs do not exist.

---

### flighty_about

Returns server version, author, repository link, tool inventory, and requirements.

**No parameters.**

## How it works

Flighty stores all flight data in a local SQLite database on macOS at:
```
~/Library/Containers/com.flightyapp.flighty/Data/Documents/MainFlightyDatabase.db
```

This server opens that database in read-only mode to answer queries. Queries `UNION` Flighty's `Flight` + `ManualFlight` and `UserFlight` + `UserManualFlight` tables so manually-entered flights surface alongside auto-detected commercial ones, and filter on `UserFlight.isMyFlight = 1` so followed/tracked flights (`isMyFlight = 0`) don't leak into "your flights" queries. Followed flights (`isMyFlight = 0`) are surfaced by `flighty_list_friend_flights` alongside cached shared passenger rows. It reads all necessary credentials directly from the installed Flighty app:

- **User identity** — JWT auth token from `Flighty.sqlite` (identifies the user to the API)
- **API access** — build token from the app's `Info.plist` (identifies the app version)
- **Sync token** — from the app's UserDefaults plist (for flight deletion)

For write operations (add/remove flights), the server makes the same API calls the Flighty app itself makes. Added flights get full enrichment from Flighty's servers — gate assignments, weather, delay forecasts, codeshare data — and sync to all devices. No manual configuration is needed.

All tool responses include a `note` field with contextual metadata (sort order, timestamp format) to help AI assistants interpret results correctly. Flight timestamps are UTC; unverified sync markers remain unknown rather than being assigned a timezone or epoch.

## Architecture

```
src/
  index.ts              # Entry point, tool registration, flighty_about
  constants.ts          # Database paths, API config, build token (read from app)
  types.ts              # TypeScript interfaces
  services/
    database.ts         # FlightyDatabase — all SQLite read queries
    flighty-api.ts      # FlightyApi — search, subscribe, delete via Flighty API
    tracking.ts         # Cached milestone timing and explicit-pair calculations
    freshness.ts        # Isolated SyncInfo marker metadata
  tools/
    flights.ts          # list, current, get, search flights
    flight-status.ts    # status, delay forecast
    friends.ts          # friend flights
    reference.ts        # airport/airline search
    stats.ts            # aggregate statistics
    connections.ts      # Legacy scheduled connection list
    tracking.ts         # Exact UUID status and proposed connection check
    write.ts            # add_flight, remove_flight (API-backed)
```

## Limitations

- **macOS only** — relies on the Flighty macOS app's sandboxed data
- **Flighty app must be installed and signed in** — the server reads its local databases for both flight data and authentication
- **Read data freshness** — cached status may be stale; a database sync marker does not guarantee any individual flight was updated
- **Write operations require network** — add/remove flights call the Flighty API
- **Existing write calls are undocumented** — this server's add/follow/remove protocol may change in future app updates; Flighty's business API inquiry listing does not establish a usable contract for this extension
- **Build token is read from the installed app** — updates automatically when the app updates, but if Flighty changes where it stores the token, the server will need updating

## License

MIT
