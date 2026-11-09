# Flighty fork notes

## Runtime operator reference

See [SPEC.md](docs/SPEC.md) for local versus replica mode, exact local CLI grammar, private configuration, copy semantics, durable status, recovery and retirement. Current inventories are local **17/14** and replica **19/16**; default add/follow/remove remain enabled. Keep direct Mac stdio until independently approved and verified cutover. No production transport or installed revision is certified here.

This is a public true fork at [wgs4/flighty-mcp-server](https://github.com/wgs4/flighty-mcp-server), release branch `god-mode-guardrails`. Upstream base: CPLX/flighty-mcp-server **v1.10.1**, commit `fe00e8fc4e68d69df97b3cea64e749b7ae43c287`, under MIT. Retain the complete [LICENSE](LICENSE) and dependency notices when redistributing.

## Local wishlist extension

The extension builds on source base `42100cc` and adds two cache-only reads: `flighty_get_tracking_status` (exact UUID) and `flighty_check_connection` (two distinct explicit UUIDs). Inventory is **17 default / 14 read-only**. God mode stays the default; read-only removes exactly `flighty_add_flight`, `flighty_follow_flight` and `flighty_remove_flight`. Existing guards and full local booking-data access remain intentional.

Tracking returns all eligible owner passenger/followed and cached shared non-owner passenger associations. `tracking_source` includes `cached_shared_passenger`; `friendship_status` is `unverified`. Profile names are attribution, not proof of friendship or travel. Multiple associations remain ambiguous; manually followed passengers retain unknown names and `friend_name: null`. Landing uses runway ETA or labelled runway schedule, separately from gate arrival. Passed unconfirmed ETAs become overdue/null; taxi phases use cached actual milestones. Cancellation and invalid chronology suppress unsupported countdowns.

The explicit pair validates membership on both legs, gate-time bases, airport continuity, exact-pair/context MCT and null-safe tail comparison. It neither selects a common traveler nor guarantees boarding. Unknown MCT, tail, cutoff and airport procedures stay unknown. Prefer it for followed/shared risk checks over the legacy `flighty_get_connections` owner-passenger scheduled list. See [README tool contracts](README.md#flighty_get_tracking_status) for synthetic UUID examples and exact fields.

Every result carries local `queried_at` and freshness metadata. `queried_at` is invocation/early-error handling time, not an exact SQLite snapshot time or sync time. `scope: "database_sync"` describes only the database-level `SyncInfo.lastSync` marker, without verifying an account or individual flight. Numeric epoch/units remain unverified and yield null sync time/ages. Complete scans use the chronological maximum only if every nonempty marker is valid; mixed unknown markers and overflow beyond 32 rows remain unknown. About/reference and error freshness paths do not add sync or credential access. The README lists all fields, statuses, scopes and unknown codes.

There is no true refresh action or new API use. Rereading cache does not sync it. Background helpers may update cache without a visible window, but Mac cadence and per-flight freshness are not guaranteed. Keeping the UI open does not guarantee real-time data. No live aircraft telemetry source has been verified for this extension: cruising speed is a static specification and airport coordinates are not aircraft position. Flighty's [business page](https://flighty.com/business) lists API inquiries; no usable telemetry/refresh contract has been verified here.

## Wishlist verification evidence and limits

This section records the historical local-only revision, not current replica validation.

The reviewed runtime is `9412c5ec95fe66d28724b7fa2a7c880eed03d3ef`, tree `49fc190b882836b086f8166ea0d9ea0558056f25`, integrating tracking `f9d0377` and freshness `50a55b5` on base `42100cc`. Both packets and the exact combined runtime passed independent Codex SOL and Gemini Argon review: **0 HIGH, 0 MEDIUM, 1 retained wishlist LOW**.

| Verification | Accepted source/synthetic evidence |
| --- | --- |
| PM and independent Codex full suite | Each passed **294 tests / 17 files**, including the normal source build and packaging check |
| PM and independent Codex full MCP stdio | Each passed **5/5 groups**, **17 default / 14 read-only**; all 14 read handlers returned expected fixtures with zero network calls; policy and mocked removal/confirmation/replay passed |
| Independent Codex additional SDK probes | **11/11 groups** passed: combined-tool membership, chronology, freshness, concurrent invocation isolation and removal invariance; zero network or app/external-process attempts |
| Independent Gemini targeted suite | **292 tests / 15 files** passed, excluding packaging and stdio files; its separate source-level cross-packet probe passed with zero socket/read-fetch attempts and one injected mocked write |

Full-suite commands were `npm test` and `node tests/verify-stdio.mjs --checks all`, run sequentially on the reviewed runtime. These are reported execution results; this documentation pass did not rerun them. Gemini's targeted suite is not a second full-suite or full-stdio run, and overlapping packet counts are not added.

Tracking chronology/departure-bound, provenance, exact-pair MCT context and legacy-status corrections passed dual review. Freshness mixed-marker/overflow corrections and all three freshness LOWs are resolved. The sole retained wishlist LOW is **Airport soft-deleted-row ambiguity**: joins/counts can conservatively prevent IATA fallback when stable IDs are unavailable, yielding unknown continuity rather than a favorable connection result. Earlier hardening residuals still apply. Reviewers confirmed preserved API/policy, credential/URL/redirect, removal, validation and dependency guards; the legacy connection list and raw removal records remain unchanged.

Tests use synthetic databases and mocked mutation transport. Real API/account behavior, real database/schema/cardinality, numeric sync semantics, app/helper lifecycle and individual-flight accuracy remain untested. All existing dependency advisories and residual risks remain in [DEFERRED.md](docs/DEFERRED.md); no clean audit is claimed. The earlier 146-test hardening record is historical, not wishlist verification.

This runtime PASS does not establish installation or production readiness. The exact documentation commit still requires separate dual review and source-equality verification, followed by PM acceptance before any installation update. No new installed SHA is asserted. This release retains the existing Mac stdio registration, client names, entry path, settings and default writes. That historical local release did not include the replica runtime. The current runtime contract is documented separately in [SPEC.md](docs/SPEC.md).

## Capability and guards

Writes are enabled by default. Current local inventory is **17 default / 14 read-only**; replica is **19/16**, adding status and cache-copy actions. Historical pre-wishlist inventory was 15/12. Add/follow each require one public tool request; replica mode may return pending/queued with the original operation ID until an authenticated Mac receipt establishes the result, not immediate cloud success. In local mode, remove first returns a preview and `confirm_code`; call `flighty_remove_flight` again with the same `flight_id` and code within five minutes. The random eight-character code is one-use, process-local and bound to the exact ID, preview and available owner identity. A local-mode restart invalidates pending codes. In replica mode, the Mac durable store preserves previews, consumed confirmations, fences and history across normal restart, subject to TTL, context and account guards; restart does not clear them. Changed details/identity require a fresh preview. Codes are consumed before the deletion request, even if it fails. There is no automatic retry after failure; inspect the result/account state before requesting a new preview because a failed response need not prove no remote change occurred.

Passenger, followed and valid uncached UUID removal remain available. When local details or identity cannot be resolved, the preview says so and identifies only the exact UUID; this does not prove remote ownership.

`FLIGHTY_READ_ONLY` is trimmed and case-insensitive:

| Value | Behavior |
| --- | --- |
| `1`, `true`, `yes`, `on` | Read-only: 14 local / 16 replica tools; API methods also reject writes. |
| `0`, `false`, `no`, `off`, empty or unset | Writes enabled: 17 local / 19 replica tools. |
| Anything else | Refuse startup with a policy error. |

Authenticated destinations require HTTPS, no embedded userinfo, standard port and the exact `flightyapp.com` host or a dot-delimited subdomain. Stored sync URLs are checked before obtaining credential headers; authenticated redirects are rejected. `FLIGHTY_EXTRA_SYNC_HOSTS` optionally accepts **comma-separated exact hostnames**, trimmed/case-insensitive, with no wildcard, URL scheme, path, port or trailing dot. It is a destination allowlist, never a place for tokens, credentials or secret-bearing URLs. Adding a host permits credential-bearing requests to that host; it does not prove who operates it.

Local token discovery and complete booking/confirmation/ticket fields are intentionally retained, including locally available shared records. Read-only does not redact them. In local mode, `FLIGHTY_OWNER_USER_ID` pins an owner and takes precedence; output labels distinguish pinned override, JWT-subject selection and frequency fallback. JWT decoding is not independent authentication. Replica mode uses explicit owner/account pins without Mac auth, legacy-token or frequency fallback. External text is labeled as untrusted data in every tool description/result. Labels cannot guarantee prompt-injection protection or govern what the host client sends to a model service.

Other hardening includes shell-free absolute plist calls, lazy build-token access, input/date/UUID/page bounds, bounded authenticated requests, safe errors and fresh source builds with LICENSE packaging. See [SECURITY_REVIEW.md](SECURITY_REVIEW.md) for the earlier hardening assessment, wishlist review status and original static baseline, and [docs/DEFERRED.md](docs/DEFERRED.md) for remaining limits.

## Source build and existing installations

Use **Node >=24**, including built-in `node:sqlite`; validation used Node **26.0.0**. Native Linux Node 24 synthetic evidence is revision-specific; see [source validation](docs/BUILD.md). From the exact reviewed checkout:

```sh
npm ci --ignore-scripts
npm run build
```

Never install the committed `dist/*.mcpb`. No global package or binary packer is required. Synthetic tests and explicit-entry stdio verification are documented in [docs/BUILD.md](docs/BUILD.md).

The installation was moved by the owner to a separate live checkout, shown here as `/path/to/flighty-live`. Preserve its existing entry `/path/to/flighty-live/build/index.js` and the registrations named **`flighty`** in **Claude Code CLI user scope, Codex and agy**. Preserve every other server and setting. The owner reports the app installed, signed in and its database present; there is no outstanding app-install blocker based on that report. This documentation does not inspect or certify those real resources.

The historical pre-wishlist reviewed source candidate was `85dc3110c85f1aa922bc3aefd41033fc47981c22`. Both independent integrated round-1 reviews passed with no HIGH/MEDIUM findings. **This source-review SHA is distinct from the later final installed commit.** Documentation review and installed-SHA/configuration acceptance records are maintained separately in the PM's private final result, together with the actual installation path and exact installed SHA. This source review record does not establish documentation acceptance or installation. Existing clients must restart their server process and start a new session to load an updated build, tool inventory or policy. No real API/account verification was performed; successful synthetic removal is a mocked guard/request check.

## Disable, unregister and restore

The PM verified these exact commands against CLI help. They remove only `flighty` from the corresponding client, preserving other MCP servers:

```sh
~/.claude/local/claude mcp remove flighty -s user
codex mcp remove flighty
agy mcp remove flighty
```

Claude CLI has no `mcp disable` command. Unregistering prevents future launches; it does not terminate an existing server. Stop existing Flighty MCP server processes and start new client sessions for removal to take effect. Do not wipe client configuration or remove other MCP servers.

To restore Claude Code's user-scope registration, substitute absolute paths for the Node executable and the built entry:

```sh
~/.claude/local/claude mcp add -s user flighty -- /absolute/path/to/node /path/to/flighty-live/build/index.js
```

No read-only environment flag is added; writes remain enabled by default. Start a new session after restoring. Preserve existing Codex/agy registrations during normal updates rather than recreating them unnecessarily.

Optional source removal, **only after all three registrations are removed and existing server processes are stopped**:

```sh
trash /path/to/flighty-live
```

That removes only the source installation to recoverable trash. It does not remove the Flighty app or its data. These commands are instructions, not actions performed by this documentation pass.

## Future upstream updates

1. Fetch upstream without changing the live installation. Compare upstream changes against the current reviewed source, lockfile and history; inspect binary artifacts as untrusted data. Do not execute or install upstream bundles.
2. Re-run the supplied security review brief with fresh independent review. Keep owner decisions explicit, including default writes, full local data and guarded removal. Review dependency/advisory reachability again.
3. Merge the selected changes in an isolated worktree. Resolve findings and run locked source build, the full synthetic suite and full stdio verifier. Review the resulting integrated source/lock and documentation independently.
4. Install only the new exact reviewed SHA at the preserved live entry path; verify that SHA, synthetic installed-entry behavior and unchanged client registrations/settings. Record the result and restart existing client/server sessions.

There is no automatic upstream PR, unreviewed pull/update or automatic live deployment.
