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
Node 26 was tested. The declared minimum Node 24 was not separately tested. Source builds and extension staging are verified; optional binary MCPB packing requires a separately selected, version-matched packer and was not exercised. No real Flighty API or account behavior is tested by this fork's synthetic verification.
