# Flighty fork: full capability with guards

Base: upstream CPLX/flighty-mcp-server v1.10.1, commit fe00e8fc4e68d69df97b3cea64e749b7ae43c287 (MIT).

Keep all existing tools and data fields. Writes remain enabled by default. Local token discovery stays intact. Add and follow remain one-step. Remove first returns a precise preview and a random, one-use confirmation code with a five-minute lifetime. Confirmation is bound to that flight and preview, cannot be replayed, and is consumed before the request.

Authenticated requests require HTTPS, no userinfo, an exact flightyapp.com host or subdomain, or an explicitly configured extra host. Reject redirects. Validate the stored sync destination before reading credentials. Never include URL queries, credentials or raw API response bodies in errors. Bound request time and body size.

Strict policy: FLIGHTY_READ_ONLY accepts 1/true/yes/on as read-only and 0/false/no/off/empty/unset as writes enabled, case-insensitively after trimming. Other values fail startup clearly. API mutation methods also enforce policy.

Label external text as untrusted data in every tool result and description while keeping fields. Honor explicit owner override, retain heuristic fallback, and identify fallback/shared-owner results. Replace shell plist calls with absolute execFile calls; read build token lazily. Validate date/UUID/year/string inputs, selector exclusivity, and bound page sizes.

Build from locked source dependencies with npm ci --ignore-scripts. Never install committed binary bundles. Package MIT LICENSE, use clean compile output, and document Node >=24 runtime. Tests live in tests/ and use vitest, synthetic SQLite fixtures and mocked fetch only. Cover policy, registration, removal, credential ordering, redirects, owner labels, and no network from every read handler.

Source has 15 tools by default: 12 read tools including about plus 3 writes. Read-only has 12 tools. Preserve this actual inventory.

Three isolated packets: P1 policy/network/removal; P2 output/process/input hygiene; P3 packaging/test infrastructure. Separate Codex SOL max and Gemini Argon high instances review every packet. Fix HIGH/MEDIUM; document LOW. After first full build run up to two revision rounds, stopping early if clean.

Acceptance: after separate final documentation review, PM commits and installs the exact final reviewed SHA in the existing live checkout (public placeholder `/path/to/flighty-live`), preserving its `build/index.js` entry and registrations named `flighty` in Claude Code CLI user scope, Codex and agy, default writes and every other setting/server. Record actual private path and installed SHA in the PM final result; the frozen source candidate is not the final installed SHA. Run installed-entry synthetic stdio checks and retain evidence. Existing server processes/client sessions need restart/new sessions. No real-account writes, real database content inspection, tokens or private records in logs. The owner reports app/sign-in/database present, so no app-install blocker remains based on that report. Synthetic verification does not certify real API/account behavior. Document unregister/restore and independently reviewed upstream updates.

Source review record dated 2026-11-08: integrated source `85dc3110c85f1aa922bc3aefd41033fc47981c22` passed both independent integrated round-1 reviews with no HIGH/MEDIUM findings, so no second runtime revision round was required. Builder and PM each passed all 146 tests and full stdio; each reviewer independently passed 145 tests (excluding the build-mutating packaging test) and full stdio. Documentation review and installed-SHA/configuration acceptance records are maintained separately in the PM's final result; this source review record does not establish documentation acceptance or installation.
