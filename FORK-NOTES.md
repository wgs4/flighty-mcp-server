# Flighty fork notes

This is a public true fork at [wgs4/flighty-mcp-server](https://github.com/wgs4/flighty-mcp-server), release branch `god-mode-guardrails`. Upstream base: CPLX/flighty-mcp-server **v1.10.1**, commit `fe00e8fc4e68d69df97b3cea64e749b7ae43c287`, under MIT. Retain the complete [LICENSE](LICENSE) and dependency notices when redistributing.

## Local wishlist extension: draft, not approved or installed

The wishlist source base is `42100cc`. This draft describes two packets under revision, not an approved combined release. Final source-contract reconciliation, integrated synthetic build/tests/stdio and independent dual documentation review are still required. No new installed version is identified here.

With both cache-only reads integrated, inventory becomes **17 default / 14 read-only**, including `flighty_get_tracking_status` (exact UUID) and `flighty_check_connection` (two explicit distinct UUIDs). The baseline remains 15/12. God mode stays the default; read-only removes exactly add, follow and remove. Existing guards and full local booking-data access remain intentional.

Tracking returns all eligible owner passenger/followed and cached shared non-owner passenger associations, with `cached_shared_passenger` provenance and friendship unverified. A `Profile` name is attribution, not proof of friendship or travel. Multiple associations remain ambiguous; manually followed passengers retain unknown names and `friend_name: null`. Landing uses runway ETA or labelled runway schedule, gate arrival stays separate, passed unconfirmed ETAs become overdue/null, and taxi phases reflect cached actual milestones only. Cancellation and invalid chronology suppress unsupported countdowns.

The explicit connection pair checks membership on both legs, gate-time bases, airport continuity, cached exact-pair/context MCT and null-safe tail comparison. It neither selects a common traveler nor guarantees boarding or a safe connection. Unknown MCT, tail, cutoff and other airport procedures stay unknown. The automatic owner-passenger connection list remains separate. See [README tool contracts](README.md#flighty_get_tracking_status-draft-extension) for synthetic UUID examples and fields.

Every result gains local `queried_at` and freshness metadata. Query/calculation time is not sync time. `SyncInfo.lastSync` is only a database-level marker, never a per-flight guarantee; numeric epoch/units remain unverified and yield null sync time/age. Mixed unknown markers and scan overflow must remain unknown; marker aggregation and the final database-scope literal are pending reconciliation with the revision. Errors/reference/about do not acquire a sync/credential dependency.

There is no forced refresh, new API call or verified aircraft telemetry source. Rereading cache does not sync it. Background helpers may update cache without a visible window, but Mac cadence is not guaranteed. UI-open is not a real-time guarantee; static cruising speed and airport coordinates are not live aircraft data.

Reported pre-fix verification: tracking builder and both reviewers passed `npm test` (219 tests/16 files) and full stdio (5 checks, 17/14, zero read-network attempts); freshness builder reported 172 tests/15 files using `--no-isolate`, and reviewers passed 172 tests plus full stdio on its standalone 15/12 inventory. Freshness Codex's final standard `npm test` also passed after an earlier transient packaging failure; its independent probes reproduced two MEDIUM freshness defects. Tracking reviews also found MEDIUM defects. Passing those suites does not resolve the findings or verify the revised combined tree. No real API/account/database/schema or Mac lifecycle testing is established. Existing audit findings and residual risks remain in [DEFERRED.md](docs/DEFERRED.md).

## Capability and guards

Writes are enabled by default. Baseline inventory is **15 tools: 12 reads (including about), plus add, follow and remove**; the combined wishlist draft adds two reads for **17/14**. Add/follow remain one-step. Remove first returns a preview and `confirm_code`; call `flighty_remove_flight` again with the same `flight_id` and code within five minutes. The random eight-character code is one-use, process-local and bound to the exact ID, preview and available owner identity. Restart invalidates pending codes. Changed details/identity require a fresh preview. Codes are consumed before the deletion request, even if it fails. There is no automatic retry after failure; inspect the result/account state before requesting a new preview because a failed response need not prove no remote change occurred.

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

The reviewed frozen source candidate is `85dc3110c85f1aa922bc3aefd41033fc47981c22`. Both independent integrated round-1 reviews passed with no HIGH/MEDIUM findings. **This source-review SHA is distinct from the later final installed commit.** Documentation review and installed-SHA/configuration acceptance records are maintained separately in the PM's private final result, together with the actual installation path and exact installed SHA. This source review record does not establish documentation acceptance or installation. Existing clients must restart their server process and start a new session to load an updated build, tool inventory or policy. No real API/account verification was performed; successful synthetic removal is a mocked guard/request check.

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
