# Security review and final hardening assessment

Assessment date: **2026-11-08**. The original static review is preserved below as a dated historical baseline. Its read-only default, ticket-data redaction, friend-tool restriction and mandatory-owner-override recommendations were **superseded by explicit owner decisions**. They are not the fork's deployment requirements or final verdict. Writes, full booking data, local token discovery and labeled owner fallback are intentional.

**Final source assessment: PASS to final documentation review and PM installation verification, with the limits below.** Separate Codex SOL 6.1 max and Gemini Argon high integrated round-1 reviews both found no HIGH or MEDIUM findings; no second runtime revision round was required. They reviewed source commit `85dc3110c85f1aa922bc3aefd41033fc47981c22`, tree `6d073bca08a5d19513b3924303f0f846614a0c52`. This identifies the frozen source candidate, **not the final installed commit**. Documentation review and installed-SHA/configuration acceptance records are maintained separately in the PM's final result; this source assessment does not certify those separate records.

## Final disposition of baseline findings

| Finding | Final behavior and evidence |
| --- | --- |
| M1: credential destination | `src/services/policy.ts` requires HTTPS, no userinfo, standard HTTPS port, exact `flightyapp.com` or a dot-delimited subdomain, or an exact configured extra hostname. Lookalikes, trailing dots, control/backslash input and invalid configuration are refused. `src/services/flighty-api.ts` validates the stored deletion URL before obtaining build/auth headers; fixed search/subscription destinations are also checked before headers. Every authenticated request uses `redirect: "error"` and rejects mocked 3xx responses. Errors omit remote bodies and URL queries. A 15-second deadline covers fetch, body handling and successful cleanup; search response consumption is capped at 1 MiB. Error cleanup is best effort and does not hold the caller. Host acceptance is not DNS pinning, path verification or proof of remote service ownership. |
| M2: policy and destructive writes | Writes intentionally default on: 15 tools, including 12 reads and 3 writes. Strict trimmed, case-insensitive policy accepts `1/true/yes/on` for 12-tool read-only and `0/false/no/off/empty/unset` for writes. Invalid values refuse startup before database/API construction. API methods separately enforce policy before credentials/network. Add/follow stay one-step. Removal requires a preview then a random eight-character, one-use, five-minute code bound to exact ID, preview and available owner context. Codes are consumed before awaiting deletion, including failed requests; restart discards them. There is no automatic deletion retry. This protocol does not independently authenticate the human approving a tool call. |
| M3: intentional data access | Owner accepted local token lookup and full booking/confirmation/ticket fields, including locally present friend data. The original auth discovery and flight SELECT are preserved. Read-only mode still discloses data to the host client; it is not data minimization. `FLIGHTY_DB_PATH` is not a sandbox: legacy auth fallback remains possible. No real records or credentials were inspected during hardening verification. |
| M4: external text | Every tool description and result carries server-authored external-data notices; JSON adds trust metadata, plain text/errors carry notices, and `isError` is retained. External marker strings cannot suppress notices. Current API errors omit raw bodies; unexpected write errors use fixed text. Labels guide clients/models but cannot guarantee resistance to prompt injection or control client retention/uploads. The residual arbitrary malformed-whitespace URL sanitizer LOW remains in [DEFERRED.md](docs/DEFERRED.md). |
| M5: identity | Explicit `FLIGHTY_OWNER_USER_ID` wins and is labeled `pinned_owner_override`; decoded JWT subject is labeled `signed_in_owner`; frequency fallback is retained as `shared_or_fallback_owner` with warnings. JWT decoding is local identity selection, not signature/expiry authentication. Invocation-local context preserves labels under concurrency. Removal uses a bound owner+UUID lookup for passenger/followed rows, never friend-name inference. Missing local enrichment permits an exact-ID preview honestly labeled details/identity unavailable; it does not establish remote ownership. Changes in identity, data or availability invalidate an earlier preview. |
| L1: plist subprocesses | Both readers use absolute `/usr/bin/plutil` and argument arrays without a shell. Build-token discovery is lazy, not import-time; local auth discovery remains intentional. |
| L2: inputs/resources | Real calendar dates, UUIDs, years, string lengths, mutually exclusive selectors and reversed ranges are validated. Current flights/connections are paginated: default 50, maximum 200, offset at most 100000; reference maximum 50. Read date/year range is 1970–2100, write dates 1900–2200. Bounds reduce application load but do not impose a total serialized-output/process-memory cap or bound all SDK protocol input. |
| L3/L4: build/license | Build only reviewed locked source using `npm ci --ignore-scripts` and `npm run build`; never install committed `dist/*.mcpb`. Fresh compile output replaces the build after success, preventing stale modules. MIT `LICENSE` is included in package and fresh extension stages. Optional packing requires an explicit executable/version and was not exercised. Node >=24 is declared; Node 26 was tested. Source/declaration map relocation and fixture cache LOWs remain deferred. |

All runtime SQLite opens request `readOnly: true`; account mutations are remote API operations. No SQL mutation/injection path was identified. This is not an OS sandbox or proof of zero SQLite/WAL filesystem side effects.

## Synthetic validation and independent review evidence

The integration builder and PM each ran the full **146 tests in 14 files**, source build and full MCP stdio verifier successfully. Each independent integrated reviewer ran **145 tests in 13 files**, omitting only `tests/packaging.test.ts` because it deliberately mutates build output, and independently passed full stdio verification. Codex also compared in-memory compiler output with the existing build: **38 JavaScript/declaration files matched**; source maps were excluded for the documented LOW. Both reviews confirmed all **91 production lock entries unchanged** from upstream.

Recorded commands include `npm run build`, `npm test`, and `npm run verify:stdio -- --entry /path/to/reviewed/build/index.js --fixture-directory /path/to/synthetic-fixtures --checks all`. Independent reviewers used `node node_modules/vitest/vitest.mjs run --exclude tests/packaging.test.ts --no-cache --no-fsModuleCache` and full `node tests/verify-stdio.mjs` against the existing build. All five stdio groups passed with `failures=[]`: exact 15/12 inventories, all 12 reads with zero fetch/socket attempts, normalized policy values, invalid-policy startup rejection, and mocked passenger/followed/uncached removal with wrong-code/wrong-ID/replay checks. Unit/integration regressions also cover expiry, concurrency, failed-request consumption, identity/preview changes, credential-reader ordering, redirects, full-response deadlines and size limits. P3 separately verified fresh extension staging and LICENSE/package inclusion.

Evidence records are the job's `INTEGRATION-REPORT.md`, `final-test.log`, `final-stdio.log`, `pm-integration-tests.log`, `pm-integration-stdio.log`, `review-integration-r1-codex.md` and `review-integration-r1-gemini.md`. Packet reviews were followed by corrections and re-review; their earlier pending integration statements are historical. Final integrated reviews govern the source assessment. This documentation pass does not rerun or independently certify those runtime results.

All execution above used synthetic SQLite, mocked plist/credentials/fetch and network guards. No real Flighty API/account behavior, real token refresh, remote ownership, cross-device sync or live registration was verified. Minimum Node 24 and actual MCPB packing remain untested. The PM must record the later final installed SHA and verify preserved client configuration separately.

## Production dependency audit: retained risk

The P3 audit snapshot reported **10 production package findings: 1 critical, 6 high, 3 moderate**, plus one development-only LOW in the full install. These are package audit findings, not ten demonstrated exploit paths. The upstream production lock was deliberately retained after review; this is **not a clean audit**. No fresh online audit or upgrade was performed in this documentation pass.

| Package/path | Reviewed reachability limits |
| --- | --- |
| `proxy-addr@2.0.7` (critical); HTTP stack including body-parser, qs, Hono, its Node adapter, express-rate-limit and ip-address | Reported paths depend on HTTP serving/proxy/rate-limit/parsing behavior. This entry point uses stdio, without an Express/Hono listener or proxy-trust configuration. No remote exploit through those paths was demonstrated. See the [proxy-addr advisory](https://github.com/advisories/GHSA-jqcg-44mw-7w3h). |
| `@modelcontextprotocol/sdk@1.29.0` | Reported HTTP validation/authentication, OAuth/client redirects and shared experimental task-store paths are not configured here. The [validation advisory](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-46jr-4wx8-v453) explicitly excludes stdio-only servers. Other recorded primary evidence: [task store](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-22jm-h49p-29qw), [OAuth](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h), [HTTP redirect](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6prh-2h8m-c8cw), [bearer middleware](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-rvq5-wwqv-78pq). |
| `fast-uri@3.1.0` via AJV | Loaded dependency surface exists, but no attacker-controlled remote JSON-schema/URI normalization path was found in this application. Presence alone does not prove exploitability or safety. |
| `zod@3.25.76` | Application tool fields are bounded scalars, but **SDK protocol schemas also parse collections**. Do not infer collection parsing is unreachable. A hostile local stdio client can still exhaust process resources. See the [collection advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) and [recorded upstream fix](https://github.com/colinhacks/zod/commit/a0ebf97). |

Advisory references are those recorded in the P3 reviews, not a new audit certification. Reassess SDK/Zod and transitives before adding HTTP, OAuth, tasks, remote schemas, application collection inputs or untrusted client exposure. Upgrade only through a reviewed lock/runtime change with full synthetic tests; do not blindly run `npm audit fix --force`. Remaining LOW findings and resolved LOW dispositions are in [docs/DEFERRED.md](docs/DEFERRED.md).

## Original static baseline — 2026-11-08

The following is the supplied `SECURITY_REVIEW_DRAFT.md`, with heading levels nested and individual contributor names omitted for public documentation. Generic home paths use `~`; no private installation paths or personal account records are included. Its line numbers and `analysis/` artifacts refer to the original upstream review workspace, not the hardened source tree. **Everything below describes upstream commit `fe00e8fc4e68d69df97b3cea64e749b7ae43c287` before hardening. Its verdict and recommendations are historical and superseded where stated above.**

### Static security review: CPLX/flighty-mcp-server

Reviewed commit: `fe00e8fc4e68d69df97b3cea64e749b7ae43c287` (v1.10.1).
Review date: 2026-11-08. Intended deployment: Claude Code CLI on macOS, reading the user's local Flighty data.
License declared: MIT.

#### Verdict

**PROCEED WITH FIXES**, using a build from this pinned source and an explicitly read-only configuration. The default configuration enables account mutations and is unsuitable for the requested local-reader deployment. With the exact value `FLIGHTY_READ_ONLY=1`, the reviewed source omits all three write tools and exposes no identified alternative network or account-mutation path. Read-only mode still exposes sensitive local records to the MCP client.

No CRITICAL or HIGH finding was established in this limited review. The main concerns are conditional credential forwarding to an unvalidated sync URL, default-enabled account writes, unnecessary ticket-data disclosure, and untrusted strings entering model context. This is a limited static review, **not an audit or a guarantee about execution**.

#### Scope, method, and limitations

- Inspected all first-party source modules, tests, package/lock/manifest/compiler configuration, build script, license, documentation, and the available history up to the reviewed commit. Repository prose and comments were treated as untrusted evidence, never as instructions.
- Listed the MCPB before extracting it exclusively into `analysis/bundle/`. Compared all 14 first-party JavaScript modules structurally against TypeScript, and compared packaged dependency metadata against the source lockfile. Checked risky constructs, URLs, transports, and relevant SDK behavior statically.
- No project code, build, test, install, server, npm, Node, npx, tsc, vitest, sqlite3, third-party scanner, network request, or upload was run. No real Flighty database or any file under the user's Library was read, opened, or copied. The clone was not modified.
- Unreviewed: runtime behavior, Claude Code configuration/permissions, actual installed Node/macOS/Flighty versions, native SQLite implementation and WAL/sidecar behavior, private Flighty API/server behavior, real account schemas/contents, live network/redirect behavior, exploitability against actual installations, and current advisory databases.
- Third-party package contents received targeted inspection and searches, not a complete dependency audit. Registry tarballs were unavailable offline; integrity metadata cannot authenticate the already-extracted package files by itself. No reproducible build was attempted. Maintainer identities and signing keys were not independently authenticated.

Unless prefixed with `analysis/`, file references below are relative to `upstream-review/`. Line ranges identify the inspected evidence, not a claim that every possible behavior has been tested.

#### Ranked findings

##### CRITICAL

None established within scope.

##### HIGH

None established within scope.

##### MEDIUM M1: deletion forwards credentials to an unrestricted stored URL

**Evidence:** `src/services/sync-token.ts:8-14` returns the latest nonempty `SyncInfo.nextURL`; `:24-30` can instead return `full.nextURL` from decoded preferences. Neither validates the URL. `src/services/flighty-api.ts:166-194` appends `fast_flight_sync=true` and POSTs a deletion message to that URL using `getHeaders()`. Those headers include the user bearer JWT and application build token (`:68-81`). The bundled equivalent is `analysis/bundle/server/services/flighty-api.js:124-147`.

**Impact and conditions:** In read-write mode, a modified or otherwise less-trusted sync URL can direct the user's JWT, build token, flight ID, and sync request to an arbitrary HTTP(S) host, including a local address. A URL may itself contain sync credentials. An attacker must control that stored value or an accepted database/configuration supplying it; this review did not establish a remote write primitive or find an actual malicious URL. Same-user filesystem compromise may already allow reading credentials, so this is rated MEDIUM rather than assuming a remote account takeover. A configured database with attacker-chosen sync metadata and fallback to the legitimate legacy auth store is a particularly undesirable trust combination. Exact read-only mode removes the calling tool.

**Suggested fix:** Parse the URL before reading/attaching credentials. Require HTTPS, an explicitly approved Flighty origin/port, no userinfo, and an expected sync path. Do not guess additional legitimate sync hosts without independent verification. Use `redirect: "error"` on authenticated requests and omit URL query strings from diagnostics. For this deployment, leave the entire API/write capability disabled.

##### MEDIUM M2: writes are enabled unless the read-only flag matches exactly

**Evidence:** `src/index.ts:19` uses `/^(1|true|yes)$/i.test(process.env.FLIGHTY_READ_ONLY ?? "")`; `:35-37` registers write tools when false. `manifest.json:14` defaults its read-only checkbox to false. Removal immediately calls `api.deleteFlight(params.flight_id)` (`src/tools/write.ts:245-259`); its warning and `destructiveHint` are descriptive hints, with no server-side preview/approval protocol.

**Impact and conditions:** An omitted flag or values such as `on` or `1 ` leave add/follow/remove enabled, allowing a client-authorized tool call to alter the live Flighty account across devices. This is a deployment-default problem for the requested reader use case, not a demonstrated bypass when `FLIGHTY_READ_ONLY=1` is correctly set.

**Suggested fix:** Default this branch to read-only; require an explicit valid opt-in for writes and reject invalid policy values. Keep registration gating, instantiate the API only when needed, and add the same policy guard at API methods as defense in depth. Add registration and direct-call regression tests. If future writes are wanted, implement a concrete preview/confirmation mechanism for destructive removal.

##### MEDIUM M3: broad flight results disclose booking references and ticket details

**Evidence:** The shared query selects seat, seat position, cabin, `t.pnr AS booking_reference`, flight reason, and import source (`src/services/database.ts:144-155`). List/search/current/get return the full rows (`src/tools/flights.ts:59-65`, `:121-126`, `:188-194`, `:218-224`). The friend query retains the ticket join and these columns for the corresponding friend's user ID (`src/services/database.ts:299-317`); `src/tools/friends.ts:65-71` returns them unchanged.

**Impact and conditions:** Routine itinerary requests transmit more personal data to the MCP client/model than necessary. Friends' booking references and ticket details are included if locally present; their actual presence was not checked. Booking references are sensitive identifiers. The server makes no separate upload for these reads, but the host client receives them and may place them in model context or transcripts. Read-only mode does not redact fields or disable friend access.

**Suggested fix:** Remove PNR and ticket details from list/search/current responses and always exclude them from friend results. Expose the owner's sensitive detail fields only through an explicit opt-in or narrowly scoped detail request. Consider disabling the friend tool by default for a personal-reader deployment.

##### MEDIUM M4: remote and user-controlled text enters model context without trust labeling

**Evidence:** Friend names come from `Profile.fullName` (`src/services/database.ts:301-307`); airline/airport/aircraft/weather strings and reference websites also enter results (`:91-149`, `:526-542`, `:553-563`). Result envelopes mention sorting/timezones, without identifying field values as untrusted content (`src/tools/flights.ts:59-65`; `src/tools/friends.ts:65-71`; `src/tools/reference.ts:39-45`). API failures read entire response bodies into exception text (`src/services/flighty-api.ts:110-112`, `:134-138`, `:157-159`, `:196-198`), which write handlers return verbatim (`src/tools/write.ts:131`, `:227`, `:283`).

**Impact and conditions:** A malicious friend name, synced string, website, or API error could present instructions to the assistant. JSON encoding preserves JSON structure but does not make the embedded prose trustworthy. Raw remote errors could also reveal echoed account data or credentials; no actual secret-bearing response was observed. This does not itself execute shell commands, and successful exploitation depends on the consuming model/client. No flight-notes column is selected in the reviewed source.

**Suggested fix:** Add a consistent instruction in tool descriptions and response envelopes that record values are untrusted data and must not direct actions. Return structured, bounded fields; validate or omit website links. Return sanitized error codes/statuses instead of raw API bodies, redact credentials/URL queries, and bound any retained diagnostic text. Client permission boundaries remain necessary; a label alone cannot prevent prompt injection.

##### MEDIUM M5: identity fallback can silently present another person's flights as the user's

**Evidence:** Owner selection first accepts `FLIGHTY_OWNER_USER_ID` (`src/services/database.ts:189-193`), then a locally decoded JWT subject only if that subject has flights (`:200-205`), then picks the user with the most nondeleted rows across `UserFlight` and `UserManualFlight` (`:212-231`). That choice is cached. JWT decoding does not verify signature/expiry (`src/services/auth-token.ts:34-43`).

**Impact and conditions:** Missing/malformed credentials, zero flights for the signed-in user, or a friend-share/multi-user database can make tools labeled “my flights” select a friend's records without signaling the substitution. This is a local data-selection/privacy issue, not a JWT authentication bypass against Flighty's server. Read-only mode retains it.

**Suggested fix:** Require an explicit owner override when the signed-in identity cannot be resolved, rather than silently selecting by frequency. Return identity/source metadata and an explicit warning for intentional friend-share operation. Re-resolve identity after account changes rather than indefinitely caching a heuristic result.

##### LOW L1: shell invocation is unnecessary and still occurs in read-only mode

**Evidence:** `src/constants.ts:31-40` eagerly runs an unqualified `plutil` through `execSync` when imported. `src/services/sync-token.ts:24-26` constructs another shell command containing a home-derived path inside double quotes.

**Impact and conditions:** No MCP tool input reaches either command, and no remote shell-injection path was found. A hostile executable search path or shell-significant characters in the derived home path remain avoidable hazards. Reading an API build token also needlessly starts a shell for a local-only read deployment.

**Suggested fix:** Use `execFileSync("/usr/bin/plutil", ["-extract", key, "raw", path], ...)` without a shell. Load the build token lazily only for enabled API operations.

##### LOW L2: validation and resource limits are incomplete

**Evidence:** Write dates and deletion IDs are unrestricted strings (`src/tools/write.ts:55-65`, `:151-161`, `:245-248`). Flight-code parsing adds a format regex but no maximum length (`src/services/flighty-api.ts:236-243`). Search dates are plain strings (`src/tools/flights.ts:159-169`); years are arbitrary integers (`:28-32`; `src/tools/stats.ts:17-23`). Get-flight asks for exactly one selector but rejects only the absence of both (`src/tools/flights.ts:79-109`); when both are supplied, ID wins (`src/services/database.ts:357-372`). Current flights and connections have no row limit (`:277-288`, `:688-718`). API fetches have no explicit deadline/body cap and buffer full responses (`src/services/flighty-api.ts:104-115`, `:190-198`).

**Impact and conditions:** Invalid dates/IDs yield errors or ambiguous behavior; large strings, histories, or remote bodies can inflate memory use and model context. This is not SQL injection: tool values are bound, and deletion IDs are protobuf content rather than URL path components.

**Suggested fix:** Validate real calendar dates, UUIDs, year ranges, selector exclusivity, and short string bounds. Paginate connections/current results, cap serialized output, and give API requests deadlines and response-size limits.

##### LOW L3: packaging does not establish a fully pinned, clean build

**Evidence:** `scripts/build-extension.sh:12-15` invokes the existing local compiler installation; only the staging production dependencies are installed with `npm ci` (`:31-37`). The packer is an external `mcpb` command (`:43`) absent from `package.json:17-24`. Compilation does not first create a clean build output, and whole services/tools directories are copied (`scripts/build-extension.sh:25-29`), permitting stale output to be included. `package-lock.json:3,9` retains root version 1.10.0 while package/manifest/entry point say 1.10.1.

**Impact and conditions:** The checked-in artifact lacks proof of a deterministic source/compiler/packer chain. No stale or injected first-party module was found in this archive. The lockfile version drift is release bookkeeping, not proof of malicious code or a demonstrated install failure.

**Suggested fix:** Build in a fresh output directory using the pinned development lock, pin the packer/toolchain, update root lock metadata, and publish build provenance plus hashes. Prefer the source entry point for Claude Code. Keep dependency install scripts disabled unless specifically reviewed and needed.

##### LOW L4: the MCPB omits the project's MIT notice

**Evidence:** `LICENSE:3,12-13` identifies the copyright holder and requires retaining the notice. Packaging copies manifest, server files, package and lock, but not `LICENSE` (`scripts/build-extension.sh:21-33`). The complete archive inventory contains dependency licenses but no project license (`analysis/bundle-inventory.txt`).

**Impact and conditions:** Redistribution of the artifact lacks the required project notice. The manifest's `"license": "MIT"` alone is not the full notice.

**Suggested fix:** Add `cp "$PROJECT_DIR/LICENSE" "$STAGE_DIR/"` to packaging, retain dependency notices, and rebuild when separately authorized.

#### Package scripts and dependency chain

`package.json:7-13` defines exactly: `start` → `node build/index.js`; `dev` → `tsx watch src/index.ts`; `build` → `tsc`; `test` → Node's built-in test runner with tsx; `clean` → `rm -rf build`. There are **no project preinstall/install/postinstall/prepare/prepublish/prepublishOnly hooks**. The clean command and build script's staging cleanup are destructive shell operations, but are not install hooks and were not executed.

| Direct dependency | Declared range | Locked version | Evidence |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | `^1.6.1` | `1.29.0` | `package.json:18`; `package-lock.json:477-480` |
| `zod` | `^3.23.8` | `3.25.76` | `package.json:19`; `package-lock.json:1701-1704` |
| `@types/node` (dev) | `^22.10.0` | `22.19.17` | `package.json:22`; `package-lock.json:517-521` |
| `tsx` (dev) | `^4.19.2` | `4.21.0` | `package.json:23`; `package-lock.json:1607-1615` |
| `typescript` (dev) | `^5.7.2` | `5.9.3` | `package.json:24`; `package-lock.json:1641-1645` |

The manifest uses semver ranges, not exact version pins. Lockfile v3 fixes exact versions: **125 dependency entries, 125 HTTPS `registry.npmjs.org` resolved URLs, and 125 SHA-512 integrity fields**. No git, non-registry tarball, plain HTTP, local-file, or linked dependency was identified. Registry `.tgz` URLs are normal npm package archives, not arbitrary tarball dependencies. These checks cover recorded metadata; they do not verify package publisher identity or the actual bytes against a registry.

The only `hasInstallScript` entries are development dependencies `esbuild@0.27.7` (`package-lock.json:791-804`) and optional macOS `fsevents@2.3.3` (`:991-1004`), reached through tsx (`:1613-1624`). Thus a normal development install can run dependency lifecycle code even though the project has no install hooks. No production dependency has that flag. Packaged dependency manifests include publishing/build hooks such as `prepare` and `prepublish`; these are not automatically evidence of consumer-install execution. No lifecycle was run here.

The runtime SDK pulls in a broad HTTP/auth/validation/client stack, including Express, Hono, EventSource, AJV, `cross-spawn`, and `require-from-string` (`package-lock.json:482-499`, `:540-550`). These increase review surface. The executable/code-generation packages have expected library purposes, described below; their presence alone is not evidence of malware. No conspicuous typosquat-looking package name was identified. All packaged names/versions are recorded in `analysis/bundle-package-versions.txt`; the complete source-lock list is `analysis/source-package-versions.txt`.

**CVE confidence:** No affected-version CVE is asserted. No specific CVE against these exact locked versions could be identified with sufficient confidence from the offline evidence. Advisory databases, npm audit, registry metadata, and third-party scanners were deliberately not consulted. This provides no conclusion that the dependency chain is free of known vulnerabilities.

The extension build compiles TS, creates staging, copies code/configuration, runs `npm ci --omit=dev`, then external `mcpb pack`, and cleans staging (`scripts/build-extension.sh:12-46`). It does not pass `--ignore-scripts`. Its `tail -3` hides most npm output, but `set -euo pipefail` preserves failure propagation (`:2,37`). No explicit download-to-shell command is present.

#### Prebuilt MCPB inspection

Archive: `dist/flighty-mcp-server.mcpb`, 3,116,115 bytes.
SHA-256: `aabf7f1ab631dd4be3b15aa3f0f5109055909701fb7385c72a4a656b1357e64e`.
Inventory: **2,162 files, 9,889,294 uncompressed bytes**; full listing in `analysis/bundle-inventory.txt`.

Top-level contents are `manifest.json`, `package.json`, `server/`, and `node_modules/`. The first-party modules are:

```text
server/index.js
server/constants.js
server/types.js
server/services/auth-token.js
server/services/database.js
server/services/flighty-api.js
server/services/sync-token.js
server/tools/connections.js
server/tools/flight-status.js
server/tools/flights.js
server/tools/friends.js
server/tools/reference.js
server/tools/stats.js
server/tools/write.js
```

- Manifest and package JSON are byte-identical to the checkout. The entry point is external `node server/index.js` (`analysis/bundle/manifest.json:18-26`); version/read-only registration matches source (`analysis/bundle/server/index.js:13-30`). All 14 JS modules were manually compared against their TS counterparts. Differences observed were consistent with type erasure, formatting/class-field emission, and generated source-map comments. No added first-party behavior, import, domain, opaque base64 payload, eval/Function, or subprocess was identified.
- There are **91 packaged dependency roots**. Their actual package-manifest names/versions match the hidden installed lock, and all 91 name/version/resolved/integrity records are an identical subset of the source lock's 125 entries. The other 34 entries are development/build/optional packages. Evidence: `analysis/bundle-package-versions.txt`, `analysis/bundle-lock-versions.txt`, `analysis/source-package-versions.txt`, and `analysis/bundle-package-metadata.txt` / `analysis/source-package-metadata.txt`.
- No absolute or traversal archive names, extracted symlinks, bundled Node runtime, `.node` addon, dylib, `.so`, `.wasm`, `.exe`, or shell-script filename was found. Dependency packages include normal JS source/distributions, examples/tests, documentation and notices. README's claim that the MCPB includes a runtime (`README.md:28`) is unsupported by this inventory; the manifest invokes a host-provided `node`. Node >=24 is declared (`package.json:14-15`).
- Source-map comments refer to local missing maps, for example `analysis/bundle/server/index.js:89`. Packaging ships no first-party maps, TS source, or top-level lockfile, though it includes `node_modules/.package-lock.json`. Those omissions do not add executable behavior. The missing project LICENSE is finding L4.

Expected dependency code **not present in first-party `src/`** includes the following:

| Construct in archive | Evidence | Interpretation/reachability |
|---|---|---|
| `new Function` | `analysis/bundle/node_modules/ajv/dist/compile/index.js:89` | SDK schema compiler; dynamic generation exists in dependencies, so a blanket “no Function anywhere” claim would be false. |
| `Function` compatibility/deprecation helpers | `analysis/bundle/node_modules/get-intrinsic/index.js:28`; `function-bind/implementation.js:74`; `depd/index.js:425` | Expected helpers. Dependency `qs/dist/qs.js` also contains minified copies. First-party source is readable and not obfuscated. |
| Module compilation | `analysis/bundle/node_modules/require-from-string/index.js:28` | AJV standalone helper; no application call compiling flight strings was identified. |
| `child_process`/spawn | `analysis/bundle/node_modules/cross-spawn/index.js:3-26`; `@modelcontextprotocol/sdk/dist/esm/client/stdio.js:65` | Client process-launch support; the application uses the server transport, not this client launcher. |
| WebSocket/HTTP listeners | `analysis/bundle/node_modules/@modelcontextprotocol/sdk/dist/esm/client/websocket.js:15`; `examples/server/simpleSseServer.js:119` | Dormant client transports/examples, not launched by this server entry point. |
| Base64 decoding | `src/services/auth-token.ts:38-40`; `src/services/sync-token.ts:28-30` and corresponding bundled modules | JWT payload and legacy plist decoding, not hidden executable payloads. |

Search records are retained in `analysis/bundle-risk-strings.txt` and `analysis/bundle-network-functions.txt`. Documentation/standards URLs, JSON Schema IDs, copyright/funding links, localhost fixtures and examples occur in dependencies. For example, AJV's `raw.githubusercontent.com` reference at `analysis/bundle/node_modules/ajv/dist/core.js:612-616` is a schema identifier; the default SDK validator supplies no remote schema loader. These strings are not evidence that the deployed application contacts those hosts.

**Correspondence conclusion:** The inspected first-party JS and package metadata agree structurally with the source/lockfile, but **the prebuilt artifact cannot be shown to be the exact authenticated output of this source and dependency chain** within this static-only review. Metadata can be copied into altered packages. Recommend building the pinned source using its lockfile instead of relying on the prebuilt MCPB. That build was not performed here.

#### Credentials, files, and data flows

| Data source in code | Access and purpose | Behavior in read-only mode |
|---|---|---|
| `~/Library/Containers/com.flightyapp.flighty/Data/Documents/MainFlightyDatabase.db`, or `FLIGHTY_DB_PATH` | Main flight records; first nonempty `Account.authToken`; latest `SyncInfo.nextURL`. `src/constants.ts:10-12`; `auth-token.ts:23-25`; `sync-token.ts:8-14`. | Flight reads remain; owner resolution may read JWT locally. Sync URL is not requested by the registered read tools. |
| `~/Library/Containers/com.flightyapp.flighty/Data/Documents/Flighty.sqlite` | Legacy auth fallback: first nonempty `ZUSER.ZTOKEN`. `src/constants.ts:14-17`; `auth-token.ts:27-29`. | May be read for owner identification if the main token is unavailable. |
| `~/Library/Containers/com.flightyapp.flighty/Data/Library/Preferences/com.flightyapp.flighty.plist` | Legacy `syncInfoV2`, decoded as base64 JSON, then `full.nextURL`. `src/constants.ts:19-22`; `sync-token.ts:22-30`. | No read-tool path invokes this fallback. |
| `/Applications/Flighty.app/Contents/Info.plist` | `plutil` extracts `FlightyBuildToken`. `src/constants.ts:31-40`. | Still read eagerly on import, even for `flighty_about`. |
| Environment | `FLIGHTY_DB_PATH`, `FLIGHTY_OWNER_USER_ID`, `FLIGHTY_READ_ONLY`. `src/constants.ts:11`; `database.ts:189`; `index.ts:19`. | Database/owner choices remain configurable. Home-directory resolution and executable lookup also depend on the launch environment. |

No Keychain API, `security` CLI, keychain-stored Flighty token lookup, browser profile/cookie/password-store access, generic credential-environment harvesting, or unrelated home-directory crawl was found. Tokens are taken from Flighty's SQLite files, not from Keychain. The API caches the JWT in memory (`src/services/flighty-api.ts:47-65`); it does not refresh or persist it. Local owner resolution merely decodes `sub`, with no network validation.

Changing `FLIGHTY_DB_PATH` does **not** confine access to that single file: legacy auth fallback and the installed application plist remain available. Main/auth/sync reads open SQLite directly, without copying it. No production temp file, database export, generic file-read/write tool, or application file-write API was found. The test files contain synthetic DB creation/writes/removal under temporary directories; they were inspected, not executed.

The main path is operator-controlled, not tool-controlled. The `existsSync` then open sequence follows symlinks and has no `realpath`/`lstat`/no-follow constraint (`src/services/database.ts:172-178`). There is no MCP path parameter to turn this into arbitrary text-file reading or writing; query code expects specific SQLite tables. This process nevertheless has the normal filesystem privileges of its launching user, not an enforced application sandbox.

#### Outbound destinations and network behavior

All four first-party fetch sites are in `src/services/flighty-api.ts`. Common headers contain `Authorization: Bearer <user JWT>`, `x-flighty-build-token`, a Flighty user-agent, `en_US` locale, and protobuf content types (`:68-81`).

| Host / destination | Purpose and information sent | User control / disable | Evidence |
|---|---|---|---|
| `https://api.flightyapp.com/v1/search` | POST search: airline UUID, flight number, departure date, credential headers. Used before add/follow; can try multiple matching airlines. | `FLIGHTY_READ_ONLY=1` removes callers; no separate network flag. | `src/constants.ts:24`; `src/services/flighty-api.ts:88-108`; `src/tools/write.ts:18-25` |
| `https://api.flightyapp.com/v1/flight/{uuid}/subscribe?is_passenger=true&source` | POST adds passenger flight; flight UUID and credential headers; cross-device account effect. | Same. | `src/services/flighty-api.ts:122-132`; `src/tools/write.ts:104` |
| `https://api.flightyapp.com/v1/flight/{uuid}/subscribe?is_passenger=false&source` | POST follows a flight; UUID and credential headers; cross-device account effect. | Same. | `src/services/flighty-api.ts:145-155`; `src/tools/write.ts:200` |
| **Arbitrary stored sync-URL host**, not statically restricted to Flighty | POST deletion protobuf: flight ID, current timestamp, random sequence ID, credential headers; adds `fast_flight_sync=true`. Stored URL/query may carry sync credentials. | Same; URL comes from main DB or legacy plist, not an MCP URL argument. Requires fix M1 before enabling writes. | `src/services/sync-token.ts:8-14,24-30`; `src/services/flighty-api.ts:166-194` |
| Redirect target chosen by the remote endpoint | Fetch redirect policy is not explicitly restricted. Actual destinations depend on remote replies. Cross-origin Authorization forwarding must not be assumed; body/redirect behavior was not tested. | Read-only removes requests; use `redirect: "error"` if API support is retained. | The four fetch option objects above omit `redirect`. |
| `registry.npmjs.org` (installation/build only) | Locked dependency package downloads; no application itinerary upload identified. | Avoid installation during review; future lockfile install can disable scripts. Registry/auth/proxy settings of the local package manager were not inspected. | `package-lock.json:23-1713`; `scripts/build-extension.sh:37` |
| `github.com` (manual clone; returned metadata/link) | README clone URL and `flighty_about` repository string; not an application fetch/update check. | No automatic request to disable. | `README.md:39`; `src/index.ts:57` |

No additional first-party fetch, axios, HTTP(S) client, WebSocket, telemetry/analytics uploader, update checker, or background network loop was identified. Read tool methods do not call the API. Airport/airline `website` fields are returned as strings, not visited by the server (`src/services/database.ts:526-542`, `:553-563`). README/CHANGELOG additionally link to `modelcontextprotocol.io`, `www.flightyapp.com`, `keepachangelog.com`, and `semver.org`; those are documentation links, not runtime destinations (`README.md:3`; `CHANGELOG.md:5`). `sync.example` occurs only in test fixture values (`src/__tests__/sync-token.test.ts:35-40`).

The MCP server sends tool results to its host over stdio. Claude Code may then send selected data to its model service; that client-side data handling and its destinations are outside this repository and were not reviewed. “No server API calls for reads” does not mean itineraries remain exclusively on the machine once used in an AI conversation.

#### SQLite access and injection

The library is Node's built-in `node:sqlite` `DatabaseSync`, not `better-sqlite3` (`src/services/database.ts:1`). Every production database opener explicitly uses the API's **`{ readOnly: true }`** option: main connection (`:178`), auth token (`src/services/auth-token.ts:7`), and sync URL (`src/services/sync-token.ts:8`). The spelling is camel-case `readOnly`, not `readonly`. There is no `mode=ro` URI or `immutable` setting. The code requests read-only database access; no SQL mutation path was found. That does not establish zero filesystem side effects from the runtime's SQLite/WAL handling.

No production `INSERT`, `UPDATE`, SQL `DELETE`, `PRAGMA`, `ATTACH`, `DETACH`, `VACUUM`, DDL, extension loading, `.exec()`, or statement `.run()` call was found. SQL fixture writes exist only under `src/__tests__/`. API deletion is a remote protobuf POST, not a SQLite write.

Queries are built by concatenating constant CTEs/clauses, but tool values are bound parameters: owner/list/pagination (`src/services/database.ts:252-270`), friend filters (`:318-341`), flight selectors (`:354-375`), flight/date search (`:388-426`), reference searches (`:526-563`), stats (`:574-662`), connections (`:694-718`), airline lookup (`:754-766`). Sort direction is a developer-defined `ASC`/`DESC` choice from a boolean. `%${input}%` values are passed as binds, not SQL syntax. `%`/`_` remain LIKE wildcards, so matching can be broad, but this does not permit SQL mutation. No arbitrary SQL tool or tool-input SQL injection was identified.

#### MCP tools, schemas, and read-only reachability

Schemas use Zod imported by each parameterized tool group. The bundled SDK validates arguments before invoking handlers (`analysis/bundle/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:125-126,166-180`). Empty schemas accept no meaningful application parameters. TypeScript interfaces do not themselves validate records read from SQLite. No application output schema or total serialized-output cap is declared.

| Tool | Classification / action | Input schema and principal output | With `FLIGHTY_READ_ONLY=1` | Definition evidence |
|---|---|---|---|---|
| `flighty_list_flights` | Local read | Optional boolean upcoming, integer year; limit 1-200/default 50; nonnegative offset. Full flight rows, including ticket fields. | Registered; same data. | `src/tools/flights.ts:9-65` |
| `flighty_current_flights` | Local read | No params; full flights within ±24h; no row cap. | Registered. | `src/tools/flights.ts:199-224` |
| `flighty_get_flight` | Local read | Optional ID/number strings; neither rejected, both accepted with ID precedence. One full flight. | Registered. | `src/tools/flights.ts:70-126` |
| `flighty_search_flights` | Local read | Optional airline/airports/after/before strings; limit 1-200/default 50. Full flights. | Registered. | `src/tools/flights.ts:131-194` |
| `flighty_get_flight_status` | Local read | Required flight-number string; stored status/gates/weather/aircraft, not live network. | Registered. | `src/tools/flight-status.ts:9-49` |
| `flighty_get_delay_forecast` | Local read | Required flight-number string; stored historical statistics. | Registered. | `src/tools/flight-status.ts:54-89` |
| `flighty_get_flight_stats` | Local read | Optional integer year; aggregates and top-five airlines/routes. | Registered. | `src/tools/stats.ts:9-35` |
| `flighty_get_connections` | Local read | No params; entire connection history with times/routes; no pagination. | Registered; no sync/API fallback. | `src/tools/connections.ts:8-34` |
| `flighty_list_friend_flights` | Local read | Optional name/year/upcoming; limit 1-200/default 50; offset. Friend/followed flights and names, potentially ticket details. | Registered; no follow/remove/friendship mutation. | `src/tools/friends.ts:9-71` |
| `flighty_search_airports` | Local read | Required query string; limit 1-50/default 10. Codes/location/website. | Registered. | `src/tools/reference.ts:9-45` |
| `flighty_search_airlines` | Local read | Required query string; limit 1-50/default 10. Airline/contact/website fields. | Registered. | `src/tools/reference.ts:50-86` |
| `flighty_about` | Metadata read | No params; version/mode/tool list/repository. | Registered; reports disabled writes. | `src/index.ts:39-89` |
| `flighty_add_flight` | Remote mutation | Required flight code/date strings; normalized code regex; search then passenger subscription. | **Not registered.** | `src/tools/write.ts:44-137` |
| `flighty_follow_flight` | Remote mutation | Same string inputs; search then non-passenger subscription. | **Not registered.** | `src/tools/write.ts:140-233` |
| `flighty_remove_flight` | Remote destructive mutation | Required unrestricted flight-ID string; deletion/sync POST. | **Not registered.** | `src/tools/write.ts:236-289` |

The flag is evaluated once at module load. Exact accepted values are `1`, `true`, and `yes`, case-insensitive, **without trimming**. Unset/empty/other values leave writes enabled. It skips `registerWriteTools`, not merely a handler branch (`src/index.ts:19,29-37`). A direct call to an unregistered name is rejected by the inspected SDK (`analysis/bundle/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:100-108`). Restart is needed to change the process's evaluated policy.

All API call sites trace to the omitted write registrations: search only through `findFlight` (`src/tools/write.ts:18-25`), subscribe (`:104`), follow (`:200`), delete (`:259`). Friends and connections receive only the database object (`src/tools/friends.ts:5-7,60-61`; `connections.ts:4-6,25-26`). No independent modify-flight, friendship-write, sync, token-refresh, background API, or alternative MCP request handler was identified. `FlightyApi` has no constructor side effects. It has **no internal read-only guard**, but no current registered read-only code path calls its methods. Eager plist extraction and local JWT owner lookup still occur as described above; they are not account mutations.

**What tests actually cover:** `src/__tests__/write.test.ts` has 14 tests: six flight-code parsing cases (`:29-71`), five follow cases including errors and ambiguous-IATA fallback (`:73-185`), and three add cases (`:187-266`). Its fake server calls `registerWriteTools` directly (`:15-26`), bypassing both the entry-point flag and SDK schema validation. It tests neither removal nor read-only registration/call rejection, no-network behavior, authenticated headers, HTTPS/origin/redirect restrictions, or service-level policy guards. Auth/sync tests exercise local preference/fallback selection and malformed JWT handling, not network safety (`src/__tests__/auth-token.test.ts:51-79`; `sync-token.test.ts:31-58`). **Tests were not run.**

#### Subprocesses, transport, logs, and leakage

The only first-party runtime subprocesses are the two `plutil` shell commands in L1. No exec/spawn construction from flight/tool parameters, arbitrary shell tool, download-and-execute behavior, or first-party eval/new Function was found. Build-script commands are installation/package-time behavior, not startup behavior. No first-party runtime temp files, log files, arbitrary file writes, path traversal parameter, or symlink creation was found.

Transport is exclusively `StdioServerTransport` (`src/index.ts:93-95`); the inspected implementation uses process stdin/stdout (`analysis/bundle/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js:9-12,26-32,63-70`). No application HTTP listener, bound port, HTTP transport startup, or additional localhost/public listener was identified. Bundled HTTP libraries/examples are not evidence of an active listener.

Application logs use `console.error` for startup mode and fatal errors (`src/index.ts:96-103`), hence stderr; no first-party `console.log` or log-file writer was identified. MCP results and errors intentionally travel on stdout. Missing-DB and auth errors contain absolute configured paths (`src/services/database.ts:175`; `flighty-api.ts:59`), which can reveal the local account name to the client/logs. The SDK returns exception messages as tool error text (`analysis/bundle/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:135-160`). Raw remote API bodies can therefore enter model context, as in M4. No deliberate JWT/header logging was found, but echoed remote errors are not sanitized. Avoid full paths and secret-bearing URL queries in future diagnostics.

#### License, provenance, and history

The MIT text grants use, copying, modification, merging, publication, distribution, sublicensing and sale (`LICENSE:5-10`). A private fork can be modified and used without a source-release requirement in that text. Redistributed copies or substantial portions must retain the copyright and permission notice (`:12-13`), including `Copyright (c) 2026 CPLX Venture Labs Inc.` (`:3`); retaining the whole license also preserves its warranty disclaimer (`:15-21`). Preserve separate dependency notices/terms when redistributing packaged dependencies. This does not confer rights to Flighty's proprietary app/service, credentials, trademarks or API under other agreements.

Requested `git log -30 --stat` inspection reached **14 available commits**, from the initial v1.3.0 commit on 2026-04-06 through this release. Saved evidence: `analysis/history-last-30.txt` and `analysis/reviewed-commit.txt`. Public contributor author records were present; these are identity claims, not verification (individual names omitted in this public copy). Package/manifest/about names and the corporate license holder are consistent (`manifest.json:6-8`; `src/index.ts:56-57`; `LICENSE:3`). No external identity or reputation checks were made.

History includes credential migration, friend-share owner heuristics, new follow support, read-only mode, replacement of a native SQLite addon, and several dedicated artifact rebuild/version commits. Current commit changes the MCPB and version/changelog, with only a version-line change in source. The history explicitly discusses rebuilding contributor artifacts; this is a provenance claim, not proof. Changelog entries have some nonmonotonic release dates and lock root metadata is stale, but no malicious change was established from that alone. No executable CI workflow or separate hidden tracked installer appeared in the reviewed tree.

The reviewed commit contains a GitHub signing record, but local checking could not verify it because the public key was unavailable. No key was fetched and no signing identity is vouched for. No inexplicable first-party obfuscation, opaque code payload, or extra executable was found in the inspected application code. README installation uses clone/install/build (`README.md:38-43`), **not curl/wget piped to a shell**. Those installation instructions were inspected as data, not followed.

#### Minimal fixes proposed for a branch

No branch or implementation was created during this review. These are small, concrete changes to make before a later authorized setup; they are not claims of tested fixes.

1. **Policy, approximately 20-40 lines:** In `src/index.ts`, use a strict read-only-by-default policy and create/register `FlightyApi` only for explicit writes. Set `manifest.json` read-only default true. Add shared API policy checks if retaining write support. Configure Claude Code with the exact `"env": { "FLIGHTY_READ_ONLY": "1" }`; a restart is required.
2. **Data minimization, approximately 15-35 lines:** Remove PNR/ticket columns from shared list/search/current/friend output. Add a separate opt-in for owner details; omit friends' ticket fields regardless. For this personal-reader branch, optionally omit friend-tool registration entirely.
3. **Identity, approximately 10-20 lines:** Replace frequency fallback with an explicit `FLIGHTY_OWNER_USER_ID` requirement when the signed-in identity is unavailable; label intentionally shared-owner results.
4. **Network boundary, approximately 20-40 lines if writes remain:** Validate sync URL scheme/origin/port/path before credentials, reject redirects, and use bounded requests. For a dedicated reader branch, removing write/API registration avoids this reachable surface; do not enable writes until M1 is fixed.
5. **Subprocesses, approximately 10-20 lines:** Replace both shell strings with absolute `/usr/bin/plutil` argument calls and make build-token extraction lazy.
6. **Model-facing content/errors, approximately 20-40 lines:** Add a shared untrusted-data result envelope and tool-description warning. Return sanitized bounded errors with status/code; redact paths, tokens and URL queries. Add date/UUID/string bounds and pagination where missing.
7. **Packaging, a few manifest/script lines plus lock metadata:** Copy LICENSE, pin the packer, use a fresh compiler output with the locked compiler, disable unneeded install scripts, update lock root version, and document the external Node runtime requirement. Prefer a source build for CLI deployment. No build/install command is authorized or run as part of this review.
8. **Targeted regression coverage, approximately 80-140 lines:** Exercise valid/invalid policy values; verify 12 tools and rejection of the three absent writes under read-only; assert no fetch from every read handler; reject untrusted sync origins/redirects before credentials; test removal, sensitive-field redaction, explicit owner choice, and schema bounds. Use synthetic fixtures only. Existing tests do not establish these properties, and no tests were executed here.

#### Review artifacts and validation

Created `SECURITY_REVIEW_DRAFT.md` and scratch evidence/extraction under `analysis/`. Commands were limited to static file/metadata inspection and text comparisons: git status/rev-parse/ls-tree/log/show/diff, file reads with rg/nl/sed/awk and related text utilities, unzip listing/extraction, shasum, and extracted-tree inventory checks. There were no project executions, dependency installs, scanner runs, runtime tests, personal data reads, or network operations. The reviewed clone remained unchanged.

The key remaining assumptions are that deployment uses this exact source and reviewed policy, the user intentionally exposes selected itinerary data to Claude Code, and any future dependency/runtime installation is reviewed separately. Dependency integrity, live API behavior, model handling, and OS privilege boundaries remain unverified.

#### Ten-line summary

1. Verdict: PROCEED WITH FIXES for an explicitly read-only source build.
2. Commit reviewed: fe00e8fc4e68d69df97b3cea64e749b7ae43c287, v1.10.1.
3. Static inspection only; no code, installs, tests, network, or personal databases accessed.
4. All production SQLite opens request read-only; no SQL injection or SQL write path identified.
5. Exact FLIGHTY_READ_ONLY=1 omits all three write tools; default configuration enables them.
6. Deletion can forward credentials to an unchecked stored URL when writes are enabled.
7. Tool results can disclose booking references and friends' ticket details without redaction.
8. Synced text and raw API errors present prompt-injection and information-disclosure surfaces.
9. Bundled source/metadata agree structurally, but artifact bytes are not authenticated or reproducibly verified.
10. Build from pinned source, minimize output, harden policy/URLs, and retain the missing MIT notice.

REVIEW COMPLETE
