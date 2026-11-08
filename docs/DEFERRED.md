# Deferred low-priority findings and limits

## P3-C01 / P3-LOW-1: source map relocation
The clean build compiles in a temporary output directory before moving to build/. JavaScript and declaration source maps retain paths relative to the temporary directory. Runtime execution is unaffected; debugger source navigation may fail. Future fix: rewrite map source paths for final locations or use a stable source root, then verify root and nested module maps.

## P3-LOW-2: test fixture cache location
Unit fixture temporary directories live under node_modules/.cache/. Never run npm ci or bundling concurrently with tests: reinstalling dependencies removes active fixtures. Future cleanup can move them to the project .cache/ directory. Sequential verification is required for this delivery.

## P3-LOW-3: stdio deletion mock coverage
The preload mock initially permits only the primary synthetic fixture UUID. Unit tests must cover followed and uncached UUID removal. Extending those scenarios through stdio requires an explicit synthetic allowlist in the test-only mock. Never add test preload settings to real MCP registration.

## Existing production dependency advisories
The retained upstream production lock has npm audit findings. Independent reviews found no demonstrated remote exploit through this stdio entry point; HTTP, OAuth and experimental task features are unused. This is not a clean audit result or a guarantee. SDK protocol schemas also parse collections, so a hostile local stdio client can still exhaust process resources. Reassess SDK/Zod and transitives before adding HTTP transports, OAuth, task stores, collection input schemas or exposure to untrusted clients. Do not run audit fix --force without reviewing the complete lock and runtime changes. See SECURITY_REVIEW.md for scope and advisory references.

## Runtime and package validation limits
Node 26 was tested. The declared minimum Node 24 was not separately tested. Source builds and extension staging are verified; optional binary MCPB packing requires a separately selected, version-matched packer and was not exercised. No real Flighty API or account behavior is tested by this fork's synthetic verification.
