# Replica Export Schema, Field Allowlist, and Privacy Specification

> **Approval Gate Notice:** This document specifies the proposed schema allowlist, row-filtering rules, and sensitive field classifications for the Flighty SQLite replica core (`src/replica/**`). **This specification is a proposal for operator review and consent, not permission to export or transfer real personal data.** All local development and automated tests use synthetic fixtures only.

---

## 1. Two-Step Export Architecture

To prevent credential leakage, schema injection, or SQLite free-page slack disclosure, replica generation never copies a raw `.db` file and never copies-then-deletes secret tables:

1. **Consistent WAL-Aware Source Capture:** The exporter opens the explicitly specified source database in read-only mode and invokes Node's built-in `node:sqlite` `backup()` API into an isolated temporary staging file (`0700` directory). This captures a cross-table consistent snapshot including committed Write-Ahead Log (WAL) frames while excluding uncommitted writer transactions.
2. **Brand-New Allowlist Construction:** The exporter opens the consistent backup inside a read transaction, validates that all required source tables and columns exist, and creates a **brand-new** SQLite file (`replica.db`) initialized from static DDL (`REPLICA_SCHEMA_VERSION = "flighty-replica-schema-v1"`). Only allowlisted columns and scope-filtered rows are inserted via parameterized statements, without copying or deleting source pages. Raw snapshots remain fully recoverable in explicit bounded private quarantine outside the transferable export parent. They contain the complete source, including credentials and deleted pages; moving them is not secure erasure. The core never spills them into system Trash or silently deletes history.

---

## 2. Exported Tables and Columns Allowlist

The replica schema (`flighty-replica-schema-v1`) contains **only** the following 10 tables and their fixed columns required by the cached MCP read tools (`flighty_list_flights`, `flighty_current_flights`, `flighty_get_flight`, `flighty_search_flights`, `flighty_get_flight_status`, `flighty_get_delay_forecast`, `flighty_get_flight_stats`, `flighty_get_connections`, `flighty_get_tracking_status`, `flighty_check_connection`, `flighty_list_friend_flights`, `flighty_search_airports`, `flighty_search_airlines`) and the local removal preview lookup (`getRemovalFlight`).

### 2.1 `Flight` (43 columns) and `ManualFlight` (37 columns)

| Column | Affinity | In `Flight` | In `ManualFlight` | Classification | Purpose / Read Consumers |
|---|---|---|---|---|---|
| `id` | `TEXT` | Yes | Yes | `personal_itinerary` | Flight UUID (`FLIGHT_UNION_CTE`, exact UUID lookups, connections) |
| `number` | `TEXT` | Yes | Yes | `operational_flight` | Flight number (`FLIGHT_BASE_QUERY`, status, delay forecast) |
| `airlineId` | `TEXT` | Yes | Yes | `operational_flight` | Foreign key to `Airline.id` (`FLIGHT_BASE_QUERY`, `lookupAirlines`, stats) |
| `departureAirportId` | `TEXT` | Yes | Yes | `operational_flight` | Foreign key to `Airport.id` (`FLIGHT_BASE_QUERY`, tracking, connections, stats) |
| `scheduledArrivalAirportId` | `TEXT` | Yes | Yes | `operational_flight` | Foreign key to `Airport.id` (`FLIGHT_BASE_QUERY`, tracking, connections, stats) |
| `departureTerminal` | `TEXT` | Yes | Yes | `operational_flight` | Departure terminal (`FLIGHT_BASE_QUERY`) |
| `departureGate` | `TEXT` | Yes | Yes | `operational_flight` | Departure gate (`FLIGHT_BASE_QUERY`, `getFlightStatus`) |
| `departureScheduleGateOriginal` | `INTEGER` | Yes | Yes | `personal_itinerary` | Scheduled gate departure Unix timestamp (`FLIGHT_BASE_QUERY`, date filters, sorting) |
| `departureScheduleGateEstimated` | `INTEGER` | Yes | No (`NULL` in CTE) | `operational_flight` | Estimated gate departure timestamp (`FLIGHT_BASE_QUERY`, `getFlightStatus`, `tracking`) |
| `departureScheduleGateActual` | `INTEGER` | Yes | Yes | `operational_flight` | Actual gate departure timestamp (`FLIGHT_BASE_QUERY`, `getFlightStatus`, `tracking`) |
| `departureScheduleRunwayOriginal` | `INTEGER` | Yes | Yes | `operational_flight` | Scheduled runway takeoff timestamp (`FLIGHT_BASE_QUERY`, `tracking`) |
| `departureScheduleRunwayEstimated` | `INTEGER` | Yes | No (`NULL` in CTE) | `operational_flight` | Estimated runway takeoff timestamp (`FLIGHT_BASE_QUERY`, `tracking`) |
| `departureScheduleRunwayActual` | `INTEGER` | Yes | Yes | `operational_flight` | Actual runway takeoff timestamp (`FLIGHT_BASE_QUERY`, `tracking`) |
| `arrivalTerminal` | `TEXT` | Yes | Yes | `operational_flight` | Arrival terminal (`FLIGHT_BASE_QUERY`) |
| `arrivalGate` | `TEXT` | Yes | Yes | `operational_flight` | Arrival gate (`FLIGHT_BASE_QUERY`, `getFlightStatus`) |
| `arrivalBaggageBelt` | `TEXT` | Yes | Yes | `operational_flight` | Arrival baggage claim belt (`FLIGHT_BASE_QUERY`, `getFlightStatus`) |
| `arrivalScheduleGateOriginal` | `INTEGER` | Yes | Yes | `personal_itinerary` | Scheduled gate arrival timestamp (`FLIGHT_BASE_QUERY`, `getConnections`, `tracking`) |
| `arrivalScheduleGateEstimated` | `INTEGER` | Yes | No (`NULL` in CTE) | `operational_flight` | Estimated gate arrival timestamp (`FLIGHT_BASE_QUERY`, `getFlightStatus`, `tracking`) |
| `arrivalScheduleGateActual` | `INTEGER` | Yes | Yes | `operational_flight` | Actual gate arrival timestamp (`FLIGHT_BASE_QUERY`, `getFlightStatus`, `tracking`) |
| `arrivalScheduleRunwayOriginal` | `INTEGER` | Yes | Yes | `operational_flight` | Scheduled runway landing timestamp (`FLIGHT_BASE_QUERY`, `tracking`) |
| `arrivalScheduleRunwayEstimated` | `INTEGER` | Yes | No (`NULL` in CTE) | `operational_flight` | Estimated runway landing timestamp (`FLIGHT_BASE_QUERY`, `tracking`) |
| `arrivalScheduleRunwayActual` | `INTEGER` | Yes | Yes | `operational_flight` | Actual runway landing timestamp (`FLIGHT_BASE_QUERY`, `tracking`) |
| `isCancelled` | `INTEGER` | Yes | Yes | `operational_flight` | Cancellation flag (`FLIGHT_BASE_QUERY`, `getFlightStatus`, `getFlightStats`, `tracking`) |
| `distance` | `REAL` | Yes | Yes | `operational_flight` | Flight distance in km (`FLIGHT_BASE_QUERY`, `getFlightStats`) |
| `equipmentTailNumber` | `TEXT` | Yes | Yes | `operational_flight` | Aircraft tail registration (`FLIGHT_BASE_QUERY`, `getFlightStatus`, `checkConnection`) |
| `equipmentModelName` | `TEXT` | Yes | Yes | `operational_flight` | Aircraft model name (`FLIGHT_BASE_QUERY`, `getFlightStatus`) |
| `equipmentManufacturer` | `TEXT` | Yes | Yes | `operational_flight` | Aircraft manufacturer (`FLIGHT_BASE_QUERY`) |
| `equipmentPlaneName` | `TEXT` | Yes | Yes | `operational_flight` | Aircraft nickname (`FLIGHT_BASE_QUERY`) |
| `equipmentCruisingSpeed` | `REAL` | Yes | Yes | `operational_flight` | Static cruising speed km/h (`FLIGHT_BASE_QUERY`) |
| `arrivalWeatherConditionName` | `TEXT` | Yes | Yes | `operational_flight` | Arrival weather description (`FLIGHT_BASE_QUERY`, `getFlightStatus`) |
| `arrivalWeatherTemperature` | `REAL` | Yes | Yes | `operational_flight` | Arrival temperature °C (`FLIGHT_BASE_QUERY`, `getFlightStatus`) |
| `delayForecastDelayMean` | `REAL` | Yes | Yes | `operational_flight` | Mean delay forecast minutes (`FLIGHT_BASE_QUERY`, `getFlightStatus`, `getDelayForecast`) |
| `delayForecastObservations` | `INTEGER` | Yes | Yes | `operational_flight` | Historical observation count (`FLIGHT_BASE_QUERY`, `getDelayForecast`) |
| `delayForecastEarlyCount` | `INTEGER` | Yes | Yes | `operational_flight` | Early arrival count (`FLIGHT_BASE_QUERY`, `getDelayForecast`) |
| `delayForecastOntimeCount` | `INTEGER` | Yes | Yes | `operational_flight` | On-time arrival count (`FLIGHT_BASE_QUERY`, `getDelayForecast`) |
| `delayForecastLate15Count` | `INTEGER` | Yes | Yes | `operational_flight` | 15–30 min late count (`FLIGHT_BASE_QUERY`, `getDelayForecast`) |
| `delayForecastLate30Count` | `INTEGER` | Yes | Yes | `operational_flight` | 30–45 min late count (`FLIGHT_BASE_QUERY`, `getDelayForecast`) |
| `delayForecastLate45Count` | `INTEGER` | Yes | Yes | `operational_flight` | 45+ min late count (`FLIGHT_BASE_QUERY`, `getDelayForecast`) |
| `delayForecastCanceledCount` | `INTEGER` | Yes | Yes | `operational_flight` | Historical cancelled count (`FLIGHT_BASE_QUERY`, `getDelayForecast`) |
| `delayForecastDivertedCount` | `INTEGER` | Yes | Yes | `operational_flight` | Historical diverted count (`FLIGHT_BASE_QUERY`, `getDelayForecast`) |
| `checkInScheduleOpen` | `INTEGER` | Yes | No (`NULL` in CTE) | `operational_flight` | Check-in open timestamp (`FLIGHT_BASE_QUERY`, `tracking`) |
| `checkInScheduleClose` | `INTEGER` | Yes | No (`NULL` in CTE) | `operational_flight` | Check-in close timestamp (`FLIGHT_BASE_QUERY`, `tracking`) |
| `deleted` | `INTEGER` | Yes (`NULL`) | Yes (`NULL`) | `operational_flight` | Soft-delete marker; exported rows always have `deleted IS NULL` |

### 2.2 `UserFlight` (5 columns) and `UserManualFlight` (5 columns)

| Column | Affinity | Classification | Purpose / Read Consumers |
|---|---|---|---|
| `userId` | `TEXT` | `personal_itinerary` | User UUID associating a flight with the pinned owner or a cached shared passenger |
| `flightId` | `TEXT` | `personal_itinerary` | Referenced `Flight.id` or `ManualFlight.id` |
| `importSource` | `TEXT` | `personal_itinerary` | Import provenance label (`FLIGHT_BASE_QUERY`, `readTrackingFlight`) |
| `deleted` | `INTEGER` | `operational_flight` | Always `NULL` in exported replica (`deleted IS NOT NULL` rows are excluded) |
| `isMyFlight` | `INTEGER` | `personal_itinerary` | `1` for passenger flights, `0` for owner-followed flights |

### 2.3 `Ticket` (7 columns — Sensitive Personal Feature Data Retained)

> **Sensitive Feature Notice:** Booking references (`pnr`), seat assignments, cabin class, and flight reasons are intentionally preserved as first-class features required by the owner. They are never stripped by the exporter, and must be explicitly disclosed in any remote-host deployment approval request.

| Column | Affinity | Classification | Purpose / Read Consumers |
|---|---|---|---|
| `flightId` | `TEXT` | `personal_itinerary` | Joins to `flights_combined.id` (`FLIGHT_BASE_QUERY`) |
| `userId` | `TEXT` | `personal_itinerary` | Joins to `user_flights_combined.userId` (`FLIGHT_BASE_QUERY`) |
| `seatNumber` | `TEXT` | `sensitive_personal_feature` | Assigned seat number (`seat_number`) |
| `seatPosition` | `TEXT` | `sensitive_personal_feature` | Seat position such as window/aisle (`seat_position`) |
| `cabinClass` | `TEXT` | `sensitive_personal_feature` | Cabin class (`cabin_class`) |
| `pnr` | `TEXT` | `sensitive_personal_feature` | **Airline booking reference / confirmation code (`booking_reference`)** |
| `flightReason` | `TEXT` | `sensitive_personal_feature` | Personal trip reason (`flight_reason`) |

### 2.4 `Profile` (3 columns — Sensitive Personal Feature Data Retained)

> **Sensitive Feature Notice:** Passenger and friend display names (`fullName`, `firstName`) are preserved so `flighty_list_friend_flights` and `flighty_get_tracking_status` retain passenger attribution and friend-name filtering.

| Column | Affinity | Classification | Purpose / Read Consumers |
|---|---|---|---|
| `userId` | `TEXT` | `personal_itinerary` | Joins to `user_flights_combined.userId` |
| `fullName` | `TEXT` | `sensitive_personal_feature` | Full display name (`listFriendFlights`, `readTrackingFlight`) |
| `firstName` | `TEXT` | `sensitive_personal_feature` | Given name used by `listFriendFlights` `friend_name` filter |

### 2.5 `Connection` (6 columns)

| Column | Affinity | Classification | Purpose / Read Consumers |
|---|---|---|---|
| `id` | `TEXT` | `personal_itinerary` | Connection UUID (`getConnections`) |
| `arrivingFlightId` | `TEXT` | `personal_itinerary` | Inbound flight UUID (`getConnections`, `checkConnection`) |
| `departingFlightId` | `TEXT` | `personal_itinerary` | Outbound flight UUID (`getConnections`, `checkConnection`) |
| `waitingAirportId` | `TEXT` | `operational_flight` | Layover airport ID (`getConnections`, `checkConnection`) |
| `mctMinutes` | `INTEGER` | `operational_flight` | Cached minimum connection time in minutes (`getConnections`, `checkConnection`) |
| `deleted` | `INTEGER` | `operational_flight` | Always `NULL` in exported replica |

### 2.6 `Airport` (13 columns) and `Airline` (10 columns)

Bounded reference catalogs retain deletion markers, including tombstones, because existing flight joins and IATA ambiguity checks see these rows:
- **`Airport`**: `id`, `name`, `iata`, `icao`, `city`, `country`, `countryCode`, `timeZoneIdentifier`, `latitude`, `longitude`, `website`, `relevance`, `deleted`.
- **`Airline`**: `id`, `name`, `iata`, `icao`, `alliance`, `website`, `callsign`, `formattedPhone`, `relevance`, `deleted`.

### 2.7 `SyncInfo` (1 column)

| Column | Affinity | Classification | Purpose / Read Consumers |
|---|---|---|---|
| `lastSync` | `ANY` (untyped) | `sync_metadata` | Database-level sync marker read by `readDatabaseFreshness`. Declared without `TEXT` affinity so numeric values remain numeric (`unverified_numeric_sync_format`) and valid ISO-8601 strings remain strings. Any URL, token, query string, or overlong string is scrubbed to `NULL` on export and rejected by receiver validation. |

---

## 3. Strictly Excluded Secrets and Structures

The following tables, columns, files, and SQLite structures are **never** read for replica content and **never** present in `replica.db`:

- **`Account` table and `Account.authToken`**: Flighty account bearer JWT.
- **Legacy `Flighty.sqlite` (`ZUSER` / `ZUSER.ZTOKEN`)**: Legacy CoreData auth token table.
- **`SyncInfo.nextURL`**: Credential-bearing or account-specific private sync URL.
- **`com.flightyapp.flighty.plist` (`syncInfoV2`)**: Legacy preferences plist containing sync URLs.
- **`/Applications/Flighty.app/Contents/Info.plist` (`FlightyBuildToken`)**: App build token used only for write RPCs.
- **Source schema SQL, views, triggers, virtual tables, and unknown tables/columns**: Source schema SQL is inspected only to reject unsafe substitutions and is never copied. The receiver inspects `sqlite_master` and `PRAGMA table_info` and rejects any database containing views, triggers, extra indexes, or unallowlisted tables/columns.
- **Soft-deleted itinerary/person records and source SQLite free-list pages**: Because `replica.db` is created afresh from static DDL and populated only with selected inserts, deleted itinerary/person rows and residual free pages from the source database never enter the output file. Airport/Airline reference tombstones are the deliberate exception.

---

## 4. Row-Scope Filtering and Connected-Leg Semantics

1. **Explicit Producer-Labelled Owner (`ownerUserId`):** The exporter requires an explicit UUID `ownerUserId`, `accountId`, and `producerId`. It never discovers tokens from `Account.authToken` or `ZUSER.ZTOKEN` and never uses heuristic frequency fallback.
2. **Eligible Membership Scope (`UserFlight` / `UserManualFlight`):**
   - **Owner passenger (`userId = ownerUserId AND isMyFlight = 1`)**: Exported.
   - **Owner followed (`userId = ownerUserId AND isMyFlight = 0`)**: Exported.
   - **Cached shared passenger (`userId != ownerUserId AND isMyFlight = 1`)**: Exported when `includeSharedPassengers` is `true` (default) to support `flighty_list_friend_flights` and `flighty_get_tracking_status`.
   - **Unrelated friend-followed records (`userId != ownerUserId AND isMyFlight = 0` or `isMyFlight NOT IN (0, 1)`)**: **Strictly excluded** at export and rejected by receiver validation.
3. **Extra Connected-Leg Operational Data (`Connection` + `Flight`/`ManualFlight`):**
   - In `src/services/database.ts`, `getConnections()` joins `Connection c` to `f_in` (`arrivingFlightId`) and `f_out` (`departingFlightId`), filtering `user_flights_combined` on `f_in` for owner passenger (`uf.userId = ownerId AND uf.isMyFlight = 1`).
   - Meanwhile, `checkConnection(inboundId, outboundId)` looks up `Connection` rows where both `arrivingFlightId` and `departingFlightId` are eligible tracked flights.
   - To preserve both read queries without broken SQL joins, the exporter includes non-deleted `Connection` rows where `arrivingFlightId` is an owner-passenger flight (or where both legs are eligible tracked flights), together with the referenced non-deleted operational `Flight`/`ManualFlight` row for `departingFlightId` / `arrivingFlightId`.
   - **Privacy boundary on connected legs:** Exporting a referenced `departingFlightId` operational `Flight`/`ManualFlight` row for an owner-passenger connection **never** exports any unrelated friend-followed `UserFlight`, `UserManualFlight`, `Ticket`, or `Profile` row attached to that flight.
4. **`Ticket` and `Profile` Filtering:**
   - `Ticket` rows are exported **only** when `(flightId, userId)` matches an exported `UserFlight` or `UserManualFlight` row.
   - `Profile` rows are exported **only** for a user with an exported `isMyFlight = 1` passenger association; an owner-followed association alone does not justify a Profile.

---

## 5. Synthetic Fixtures and Verification

All replica unit and integration tests (`tests/replica-*.test.ts`) build synthetic SQLite databases under temporary directories (cleaned up via `trash` or quarantine move, never `rm`):

- **Committed WAL vs. Uncommitted Transaction Exclusion:** A writer connection in `PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0` commits a flight row into the `-wal` file and opens an uncommitted transaction inserting a secret sentinel row. `exportReplicaBundle` captures the committed WAL row via `node:sqlite` `backup()` and excludes the uncommitted row.
- **Byte-Level Secret and Deleted-Row Sentinel Absence:** Synthetic sources are seeded with `Account.authToken`, `SyncInfo.nextURL`, unknown columns, triggers/views, unrelated friend-followed rows, and hard-deleted/soft-deleted sentinel strings (`PRAGMA secure_delete = OFF`). Tests verify that the raw bytes of `replica.db` contain zero occurrences of any secret or deleted sentinel.
- **Cached Read Handler Compatibility:** All cached read queries (`READ_CASES` and `FlightyDatabase` methods) execute directly against the exported `replica.db` fixture path and return identical results.

## Storage and bounded native work contract

`ExportReplicaBundleOptions` now requires `storage: ReplicaStorageAuthority`, `quarantineDir`, and an optional `storageBudget`. The authority supplies `mountPath`, `privateRootDir`, `expectedDevice`, explicit `approvedPaths`, and `validateMount(mountPath)`. The caller must establish actual volume identity; checking an ordinary directory is insufficient. There is no default host discovery or internal disk fallback. Every write path must be private and owned, with no symlink ancestor, and be within the approved root/device/paths. The receiver requires the same authority for its own private filesystem. Mount validation is repeated on public mutations.

Raw quarantine must be outside the output parent, not merely outside the bundle. Transfer **exactly** `replica.db` and `manifest.json`; never copy a parent, staging, quarantine or source directory. Quarantine is recoverable full secret-bearing history. Default storage budgets are 512 MiB and 2,048 entries. When full, operations refuse until an operator retires data through an approved recoverable process. No background deletion or secure-erase claim exists. Custom cleanup callbacks are rejected by exporter and receiver; in-process backup callbacks are rejected by the bounded exporter. Output, staging and quarantine usage share an export budget, with conservative space reserved before capture.

Native SQLite export and receiver validation execute in a separate process with a hard execution deadline (default 30 seconds, killed on expiry). The source snapshot and source file/sidecar total are capped before backup (default follows the 64 MiB output cap unless `maxSourceDbBytes` is explicitly set); source rows are scanned incrementally with per-table and total limits before selection, and cells are capped in SQL before JavaScript materialization (default 16 KiB). Limits must be positive safe integers (future skew also permits zero). Source schemas permit only ordinary allowlisted tables with plain columns, rejecting virtual/shadow/generated/CHECK/default-expression/collation/foreign-reference substitutions before content reads. Unknown ordinary source columns/tables are not exported. Stricter schemas can refuse an unsupported future app schema rather than evaluate it. SyncInfo overflow refuses export instead of hiding ambiguous freshness. UUID identities are canonical lowercase; non-UUID reference keys retain exact case. Nullable Connection IDs are supported with unambiguous leg keys.

The receiver independently verifies logical keys, uniqueness, typed associations, selected tickets/passenger names, connection-leg closure and required references. A signature establishes pinned producer provenance, never proof of a Flighty login. A valid signed zero-flight account is supported; missing/empty/partial source files are errors.

## Recovery, durability and integration limits

Receiver state persists the full SHA-256 SPKI verification-key fingerprint as well as its key label. A changed key, account, owner, producer, schema or epoch requires `allowAccountTransition`; no previous binding's active/last-good bundle is served under the new binding. A bounded ledger preserves highwater for up to 64 account/producer/owner/epoch bindings, including when returning to a prior binding or changing its key. A full ledger refuses new bindings. State with the old unchecked layout is rejected; this core does not silently migrate/reset replay history.

Every retained state record has bounded fields and a strictly derived directory name. Recovery verifies each retained signed claim; a lease revalidates the actual stored manifest, signature, hash, schema, row contents and record agreement. A damaged active bundle may fall back to a fully revalidated same-binding last-good generation with explicit stale labels, while highwater remains unchanged. Unsigned local receipt timestamps are validated for structure and internal consistency; they rely on private local storage, not a producer signature or isolation from root/the same UID.

File and directory fsync failures propagate. A pre-state-rename failure leaves the previous accepted pointer/highwater intact. Failure after state rename reports `COMMIT_UNCERTAIN`, retains all potentially referenced generations and the new in-memory highwater, and blocks further acceptance/leases/cleanup until restart and disk revalidation. Export post-rename flush failure also reports uncertainty and leaves the complete bundle for operator inspection. Successful fsync calls and synthetic fault tests do not prove physical power-loss behavior on every filesystem.

Accepted record history compacts to retained generations; highwater survives compaction. Identical current-generation resends return the original receipt/capture times without staging another DB. Leased generations and last-good are protected. Retained records are capped at 256, concurrent leases at 1,024, configured normal retention at 2–64, and local state at 2 MiB. Rejected/crashed/retired files remain private recoverable quarantine and count against storage backpressure. Released leases reject both database and freshness access.

Use one supervised process and one receiver instance for acceptance, recovery and whole-invocation leases. There is no cross-process lease coordination. The API remains transport-neutral and synchronous for verification/acceptance; bounded SQLite subprocesses can block the calling event loop until completion. Each native validation task has its own deadline. The built `sql-task.js` companion must be deployed with the built replica modules. The mount callback is evaluated in the parent; its attested result and explicit storage/device paths cross into the trusted local export worker, which repeats path/device/privacy checks. No generic SQL/path/network protocol is exposed to a remote client.

Runtime integration, independent real account/session binding, transfer, Linux host checks and service activation remain separate work. No real Flighty source or production host was read for these fixtures. Mac Node 26 tests do not establish Linux Node 24 behavior. The separate baseline LINUX-M1 finding is unchanged.

The fresh destination uses only fixed DDL and selected inserts. It performs no VACUUM or sort into an implicit OS temporary directory; source capture and generated database/journal files stay under the approved quarantine. Output DB page allocation is capped before insertion.

Missing optional source Ticket/Profile tables produce empty fixed replica tables and explicit unknown booking/name values. Existing optional tables must still satisfy the same ordinary-schema and column checks; malformed/virtual replacements never become an unknown-data fallback.
