# Deferred low-priority findings and limits

## P2-LOW-01 residual: malformed whitespace in arbitrary error URLs
The error sanitizer strips current API bodies and valid URL queries. In an arbitrary future error containing a malformed unencoded URL, literal whitespace can end the query match and leave later text. No current production producer of that form was found. Keep raw URLs and remote bodies out of errors at their source; add a regression before introducing such an error producer. The narrow API-prefix portion was fixed. The owner concurrency race and external marker suppression findings were fixed and passed both re-reviews.

## P3-C01 / P3-LOW-1: source map relocation
The clean build compiles in a temporary output directory before moving to build/. JavaScript and declaration source maps retain paths relative to the temporary directory. Runtime execution is unaffected; debugger source navigation may fail. Future fix: rewrite map source paths for final locations or use a stable source root, then verify root and nested module maps.

## P3-LOW-2: test fixture cache location
Unit fixture temporary directories live under node_modules/.cache/. Never run npm ci or bundling concurrently with tests: reinstalling dependencies removes active fixtures. Future cleanup can move them to the project .cache/ directory. Sequential verification is required for this delivery.

## Resolved in integration: P3-LOW-3 stdio deletion mock coverage
The test-only preload now permits exactly the marked passenger, followed, and uncached synthetic UUIDs, requiring exactly one UUID in the mocked deletion body. The full stdio verifier checks preview/confirm, wrong code, wrong ID and replay for all three. Network guards remain enabled. Never add test preload settings to real MCP registration.

## Resolved in integration: P1-GEMINI-01 empty cache / P1-CODEX-02 unavailable local enrichment
Empty owner caches and missing/unreadable local lookup data now yield exact-ID previews with details and identity explicitly unavailable. Actual SQLite and MCP tests cover empty-cache and missing-DB preview/confirmation using injected mock API readers. A previously identified preview cannot be confirmed after its local data or owner identity changes.

## Resolved in integration: P1-CODEX-04 unexpected write-tool error text
Write handlers return fixed text for unexpected exceptions, including non-home database paths, while preserving recognized validation, policy and request-safety messages. This does not change the standalone arbitrary-error sanitizer limitation above.

## Existing production dependency advisories
The retained upstream production lock has npm audit findings. Independent reviews found no demonstrated remote exploit through this stdio entry point; HTTP, OAuth and experimental task features are unused. This is not a clean audit result or a guarantee. SDK protocol schemas also parse collections, so a hostile local stdio client can still exhaust process resources. Reassess SDK/Zod and transitives before adding HTTP transports, OAuth, task stores, collection input schemas or exposure to untrusted clients. Do not run audit fix --force without reviewing the complete lock and runtime changes. See SECURITY_REVIEW.md for scope and advisory references.

## Runtime and package validation limits
Node 26 was tested. Native Linux Node 24 synthetic evidence is revision-specific; see [BUILD.md](BUILD.md). Source builds and extension staging are verified; optional binary MCPB packing requires a separately selected, version-matched packer and was not exercised. No real Flighty API or account behavior is tested by this fork's synthetic verification.

## Resolved before integration: P2-CODEX-02 marker suppression
External marker strings no longer suppress trust or owner notices. Wrapping uses private object identity, JSON metadata is server-assigned, and plain-text/error notices are unconditional. Actual MCP hostile-marker regressions passed both P2 fix reviews and integrated review. This LOW is resolved, not deferred.

## Retained input-range difference
P1/P2 review noted read dates/years accept 1970–2100 while write dates accept 1900–2200. Both validate real dates. This was recorded as a cross-packet consistency observation rather than a new security finding; integration intentionally retained the ranges. Any alignment needs a separate capability decision and review.

## Resolved baseline LOWs: L1–L4
L1 shell/eager plist handling is resolved by absolute `/usr/bin/plutil` argument arrays and lazy build-token access. L2 input/resource validation is addressed by calendar-date/UUID/year/string/selector checks, pagination and API deadlines/search-body caps; this does not promise a total output/process-memory cap. L3 clean locked-source packaging and L4 missing MIT notice are addressed by fresh compilation, locked script-disabled installs and LICENSE inclusion. Source maps remain the separate P3 LOW above; actual optional MCPB packing and production host behavior remain unverified.

## Audit snapshot bookkeeping
P3 recorded 10 production package findings (1 critical, 6 high, 3 moderate) and one additional development-only LOW in the full install. The lock was retained by explicit PM decision. No fresh audit or dependency remediation is claimed here. Advisory references and stdio reachability qualifications are in [SECURITY_REVIEW.md](../SECURITY_REVIEW.md).

## Local wishlist retained LOW: Airport soft-deleted ambiguity

Tracking Airport joins and IATA ambiguity counts include soft-deleted Airport rows. When stable IDs are unavailable, these rows can conservatively prevent an otherwise usable code fallback and yield unknown continuity. This is the only retained wishlist LOW; earlier hardening residuals above still apply.

## Local wishlist corrections and verification limits

The pinned tracking revision implements corrections for gate chronology/candidate reuse, departure prediction bounds (including the contradictory-original-departure variant), cached shared provenance, exact-pair MCT airport context, invalid raw legacy-status milestones and actual-milestone ordering/risk precedence. These corrections passed dual independent packet and combined runtime review at `9412c5ec95fe66d28724b7fa2a7c880eed03d3ef`; they are resolved, not deferred feature work. Freshness mixed-marker aggregation and overflow are resolved and passed dual independent revision review. All three freshness LOWs are resolved: nonfinite injected parser clock, request-local clock reuse in direct SDK errors, and invocation/early-error wording for `queried_at`. Do not treat them as open findings.

The combined runtime passed dual independent review with 0 HIGH, 0 MEDIUM and the one retained wishlist LOW above. PM and Codex each passed 294 tests / 17 files and full stdio 5/5 (17 default / 14 read-only, zero read-network calls). Codex passed 11/11 additional combined-tool probe groups; Gemini passed 292 targeted tests / 15 files and a source-level cross-packet probe. See [verification evidence](../FORK-NOTES.md#wishlist-verification-evidence-and-limits) for commands and scope. This docs-only pass did not rerun runtime checks. No real API/account/database/schema, numeric sync format/cardinality or app/helper lifecycle was tested. Final documentation dual review, source equality and PM acceptance remain required before installation. No new installed SHA, production readiness, dependency upgrade or clean audit is claimed.

The historical local release retained the Mac stdio registration. The replica runtime is now documented in [SPEC.md](SPEC.md); rollout remains a separate approval.

Deferred capabilities: true forced refresh with a verified completion contract; verified live aircraft altitude/ground speed/heading/position; detailed taxi route/percentage/prediction; discovery of absent passenger identity or explicit local aliases; per-flight update timestamps. Re-querying does not sync. Numeric `SyncInfo.lastSync` epoch/units remain unverified, so unknown stays unknown. Background helpers may update cache without a visible window, but no Mac cadence or per-flight guarantee is established. Static aircraft cruising speed and airport coordinates must not be used as telemetry. No usable API refresh/telemetry contract has been verified; this does not establish that such APIs do not exist.

The explicit-pair checker does not prove a shared traveler or safe boarding. Missing/conflicting MCT context, missing/invalid tail, boarding cutoff and walking/security/immigration remain unknown. Matching cached tails or meeting cached MCT is no guarantee. Profile names and cached non-owner passenger membership do not verify friendship; manually followed passenger names remain unknown.

## Replica and bridge retained LOWs

The replica manifest timestamp parser retains a Gregorian-calendar validation LOW: syntactically accepted date text is not a guarantee of a real calendar day. Do not imply that this was fixed by runtime retirement changes.

The separate office bridge stage uses atomic per-file rename, without fsync or a cross-file transaction; its power-loss durability LOW remains. Parser, scope and synthetic bridge tests do not prove functional production transport. Host integration still requires separate approval.

See [SPEC.md](SPEC.md) for native filesystem stall, concurrent replacement, total-loss continuity, raw-secret quarantine, selected PII/capability and UNKNOWN-history limits. Runtime recovery is restricted authenticated repair/migration, never a reset. No live aircraft feed, forced app refresh, unattended freshness guarantee or real cleanup is delivered by these procedures.
