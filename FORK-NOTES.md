# Flighty fork notes

This is a public true fork at [wgs4/flighty-mcp-server](https://github.com/wgs4/flighty-mcp-server), release branch `god-mode-guardrails`. Upstream base: CPLX/flighty-mcp-server **v1.10.1**, commit `fe00e8fc4e68d69df97b3cea64e749b7ae43c287`, under MIT. Retain the complete [LICENSE](LICENSE) and dependency notices when redistributing.

## Local wishlist extension

The extension builds on source base `42100cc` and adds two cache-only reads: `flighty_get_tracking_status` (exact UUID) and `flighty_check_connection` (two distinct explicit UUIDs). Inventory is **17 default / 14 read-only**. God mode stays the default; read-only removes exactly `flighty_add_flight`, `flighty_follow_flight` and `flighty_remove_flight`. Existing guards and full local booking-data access remain intentional.

Tracking returns all eligible owner passenger/followed and cached shared non-owner passenger associations. `tracking_source` includes `cached_shared_passenger`; `friendship_status` is `unverified`. Profile names are attribution, not proof of friendship or travel. Multiple associations remain ambiguous; manually followed passengers retain unknown names and `friend_name: null`. Landing uses runway ETA or labelled runway schedule, separately from gate arrival. Passed unconfirmed ETAs become overdue/null; taxi phases use cached actual milestones. Cancellation and invalid chronology suppress unsupported countdowns.

The explicit pair validates membership on both legs, gate-time bases, airport continuity, exact-pair/context MCT and null-safe tail comparison. It neither selects a common traveler nor guarantees boarding. Unknown MCT, tail, cutoff and airport procedures stay unknown. Prefer it for followed/shared risk checks over the legacy `flighty_get_connections` owner-passenger scheduled list. See [README tool contracts](README.md#flighty_get_tracking_status) for synthetic UUID examples and exact fields.

Every result carries local `queried_at` and freshness metadata. `queried_at` is invocation/early-error handling time, not an exact SQLite snapshot time or sync time. `scope: "database_sync"` describes only the database-level `SyncInfo.lastSync` marker, without verifying an account or individual flight. Numeric epoch/units remain unverified and yield null sync time/ages. Complete scans use the chronological maximum only if every nonempty marker is valid; mixed unknown markers and overflow beyond 32 rows remain unknown. About/reference and error freshness paths do not add sync or credential access. The README lists all fields, statuses, scopes and unknown codes.

There is no true refresh action or new API use. Rereading cache does not sync it. Background helpers may update cache without a visible window, but Mac cadence and per-flight freshness are not guaranteed. Keeping the UI open does not guarantee real-time data. No live aircraft telemetry source has been verified for this extension: cruising speed is a static specification and airport coordinates are not aircraft position. Flighty's [business page](https://flighty.com/business) lists API inquiries; no usable telemetry/refresh contract has been verified here.

## Wishlist verification evidence and limits

Reported standalone checks, not a combined-release result:

| Packet | Source pin | Reported synthetic checks |
| --- | --- | --- |
| Tracking revision 2 | `f9d0377` | 262 tests / 16 files; full stdio 5/5, 17 default / 14 read-only |
| Freshness revision | `50a55b5` | 178 tests / 15 files; full stdio 5/5, standalone 15 default / 12 read-only; original 13-check reproducer passed |

Freshness passed both independent revision reviews; its two MEDIUM findings and all three LOW findings are resolved. Tracking's prior chronology, estimated-departure, provenance, MCT context and legacy-status corrections are in the pinned source, including the revision-2 contradictory-original-departure correction. Final independent review of that tracking packet is still outstanding at this evidence snapshot. Its only retained LOW is Airport soft-deleted-row ambiguity. No combined test count or integrated PASS is claimed. No new installed SHA is identified by these records.

After combining runtime packets, verification commands are `npm test` and `node tests/verify-stdio.mjs --checks all`, run sequentially from the combined source checkout. The documentation pass did not run these commands. Standalone counts overlap and must not be added. Combined runtime and exact final documentation review remain required before publication/installation.

Tests use synthetic databases and mocked mutation transport; read handlers made zero network attempts in reported stdio checks. Real API/account behavior, real database/schema/cardinality, numeric sync semantics, app/helper lifecycle and individual-flight accuracy remain untested. All existing dependency advisories and residual risks remain in [DEFERRED.md](docs/DEFERRED.md). The earlier 146-test hardening result below is historical, not wishlist verification.

## Capability and guards

Writes are enabled by default. Baseline inventory is **15 tools: 12 reads (including about), plus add, follow and remove**; the local wishlist extension adds two reads for **17/14**. Add/follow remain one-step. Remove first returns a preview and `confirm_code`; call `flighty_remove_flight` again with the same `flight_id` and code within five minutes. The random eight-character code is one-use, process-local and bound to the exact ID, preview and available owner identity. Restart invalidates pending codes. Changed details/identity require a fresh preview. Codes are consumed before the deletion request, even if it fails. There is no automatic retry after failure; inspect the result/account state before requesting a new preview because a failed response need not prove no remote change occurred.

Passenger, followed and valid uncached UUID removal remain available. When local details or identity cannot be resolved, the preview says so and identifies only the exact UUID; this does not prove remote ownership.

`FLIGHTY_READ_ONLY` is trimmed and case-insensitive:

| Value | Behavior |
| --- | --- |
| `1`, `true`, `yes`, `on` | Read-only: 12 baseline / 14 combined tools; API methods also reject writes. |
| `0`, `false`, `no`, `off`, empty or unset | Writes enabled: 15 baseline / 17 combined tools. |
| Anything else | Refuse startup with a policy error. |

Authenticated destinations require HTTPS, no embedded userinfo, standard port and the exact `flightyapp.com` host or a dot-delimited subdomain. Stored sync URLs are checked before obtaining credential headers; authenticated redirects are rejected. `FLIGHTY_EXTRA_SYNC_HOSTS` optionally accepts **comma-separated exact hostnames**, trimmed/case-insensitive, with no wildcard, URL scheme, path, port or trailing dot. It is a destination allowlist, never a place for tokens, credentials or secret-bearing URLs. Adding a host permits credential-bearing requests to that host; it does not prove who operates it.

Local token discovery and complete booking/confirmation/ticket fields are intentionally retained, including locally available shared records. Read-only does not redact them. `FLIGHTY_OWNER_USER_ID` still pins an owner and takes precedence; output labels distinguish pinned override, JWT-subject selection and frequency fallback. JWT decoding is not independent authentication. External text is labeled as untrusted data in every tool description/result. Labels cannot guarantee prompt-injection protection or govern what the host client sends to a model service.

Other hardening includes shell-free absolute plist calls, lazy build-token access, input/date/UUID/page bounds, bounded authenticated requests, safe errors and fresh source builds with LICENSE packaging. See [SECURITY_REVIEW.md](SECURITY_REVIEW.md) for the earlier hardening assessment, wishlist review status and original static baseline, and [docs/DEFERRED.md](docs/DEFERRED.md) for remaining limits.

## Source build and existing installations

Use **Node >=24**, including built-in `node:sqlite`; validation used Node **26.0.0**. Node 24 was not separately tested. From the exact reviewed checkout:

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
