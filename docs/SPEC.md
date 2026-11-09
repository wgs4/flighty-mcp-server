# Runtime and local operator contract

## Modes and ownership

`node build/index.js` defaults to `FLIGHTY_RUNTIME_MODE=local`. Local inventory is **17 default / 14 read-only**. `FLIGHTY_RUNTIME_MODE=replica` requires `FLIGHTY_RUNTIME_CONFIG` naming an explicit private Linux JSON configuration and already provisioned continuity. Invalid modes, configuration, storage or continuity fail closed without initialization or local fallback. Replica inventory is **19 default / 16 read-only**. Both modes retain the same three guarded account writes; strict `FLIGHTY_READ_ONLY` removes add/follow/remove. Replica-only `flighty_operation_status({operation_id})` and `flighty_request_copy({})` remain registered, including in read-only mode. Copy is a capability-controlled action, not an upstream account mutation or a read.

One supervised Linux Node process owns receiver acceptance, mailbox, client history and private Unix IPC. Do not run a second writer or maintenance concurrently. The SSH adapter accepts only the exact `SSH_ORIGINAL_COMMAND` values `flighty-mailbox-v1` and `flighty-upload-v1` and forwards to that owner. It provides no arbitrary command/path/SQL interface. The Mac courier initiates outbound SSH; there is no Mac listener or new mux. Strict host verification and bounded transport are required. Integration with an existing office mux needs independent approval of host, selected data, capabilities, accounts and jobs. Keep direct local stdio until verified cutover; this document does not authorize provisioning or activation.

## Configuration and authority

There is no usable default configuration. In the grammar below, `CONFIG` and `ATTESTATION` are inert placeholders, not valid private paths. Operators must supply approved absolute paths, private owned modes/UID, device and mount inode, disjoint storage roots, keys, account/owner/producer/schema/epoch pins and positive byte/entry/time budgets. Configuration reading creates nothing. JSON is strict version 1 with `kind: linux` or `kind: mac`; unknown fields reject. See `src/runtime/config.ts` for the exact schema rather than copying a fixture configuration.

Common fields include `storage`, `pins`, `budget`, `store` and optional `retirementCommand`. Linux adds `receiverRoot`, `inbox`, `quarantine`, `socketPath`, `clientStore`, `caller`, `macReceiptKey` and optional `operatorPublicKey`. Mac adds `sequenceStore`, required `operatorPublicKey`, `receiptPrivateKey`, `bindingKey`, `snapshotPrivateKey`, `callers`, explicit `source`, `transferParent`, `rawQuarantine` and `ssh` (enabled, pinned host/user/identity/known-hosts paths and fixed port 23500). Store specs require path, continuity path, identity and authentication key. Budgets cover aggregate bytes/entries, DB size and transport/acceptance/SQLite task time. No Linux Mac-app discovery, login-token, plist or session fallback is permitted.

Caller configuration includes account, current public key, capabilities and optional account-bound `historicalPublicKeys`; Linux also holds its caller private key. That private key is an account mutation capability. To revoke current rights, stop affected runtimes, update private capability/key configuration and restart. Historical keys authenticate retained evidence only; they do not restore dispatch rights. Preserve required evidence verification when rotating keys.

Operator verification uses strict public-only Ed25519 PEM. Its normalized public key must differ from all current and historical caller keys, receipt keys and producer keys. Keep independent operator private authority outside the app and Linux caller configuration. There is no operator signing service on Linux and no ordinary remote fence-clearance capability.

## Copy and time semantics

`flighty_request_copy` requests a signed copy of the **current Mac cache** (`copy_refresh`). It does not sync Flighty upstream, refresh the app or obtain aircraft position. A foreground window or background helper is not a reliable update guarantee.

Capture uses SQLite backup semantics, including committed WAL content, then constructs a **new allowlisted database**. Transfer exactly `manifest.json` and `replica.db`, never a parent directory, original DB/WAL, auth DB, plist or raw backup. The raw original backup may contain login credentials and secret URLs; keep it in private Mac quarantine outside the transfer parent under separately approved retention. The authoritative tables and row scope are in [REPLICA-FIELDS.md](REPLICA-FIELDS.md).

The replica intentionally includes selected PII: shared passenger names, booking references/PNRs and flight history where present. Login/build/session credentials stay on the Mac. Dedicated ownership and private modes do not isolate data from root, relevant sudo, rootful Docker, backups or other processes under the same UID. Approval must cover these readers and retained copies.

Keep query handling time, snapshot capture, Linux receipt, copy age, source-sync marker and observation/milestone time separate. A fresh copy can contain old source observations. Numeric `SyncInfo.lastSync` epoch/units remain unknown; query/copy/file timestamps must not replace them. Producer signatures establish provenance, not a verified Flighty login. Receiver leases pin one verified generation for the invocation; stale fallback must retain honest age labels and replay highwater.

## Operations, history and uncertainty

Retain the original operation ID across restart and status checks. Status returns authenticated receipts where retained, otherwise pending/expired or unavailable with explicit uncertainty. Expiry or no Mac receipt does **not** prove no execution; unavailable/retired history is not certified failure. Never automatically submit a mutation with a new ID after uncertainty. UNKNOWN remains UNKNOWN, including after independent reconciliation; account fencing prevents unsafe subsequent dispatch until the separately authorized resolution.

Local removal remains preview plus one-use, five-minute confirmation bound to exact ID, details and available owner context; restart invalidates local codes. In replica mode, the Mac durable store preserves previews, consumed confirmations, fences and history across normal restart, subject to TTL, context and account guards; restart does not clear them. Remote removal carries authenticated context and consumed confirmation state. Failed requests do not restore a consumed code. Add/follow each use one public tool request; replica responses may be pending/queued under the original operation ID until an authenticated Mac receipt establishes the result. Submission is not immediate cloud success. HTTPS host allowlisting, no userinfo/redirects, credential ordering, request deadlines, strict policy, booking fields, output trust notices and labeled local owner fallback remain as described in [FORK-NOTES.md](../FORK-NOTES.md). Replica ownership uses pinned producer labels rather than local heuristic discovery.

Mac terminal operation history and Linux succeeded/failed client history move into authenticated archives after request expiry plus 24 hours; mailbox queue entries may expire independently. unresolved UNKNOWN and unreceipted client evidence are retained until independent resolution. Archives are bounded (4,096 entries / 64 MiB per store); storage exhaustion causes backpressure, not silent deletion/reset. Status checks can read authenticated archived evidence while available. Archive retirement respects evidence dependencies and age; retention does not authorize replay.

## Exact local CLI grammar

All commands below use `node build/runtime/cli.js` followed by one line's arguments. Literal flag order is required; brackets denote an optional argument, and alternatives must be replaced by one value. These are operator references, not instructions to execute without approval.

```text
init-linux --config CONFIG
init-mac --config CONFIG
courier-once --config CONFIG [--snapshot]
forced-command --config CONFIG
inspect-store --kind linux|mac --config CONFIG --role ROLE
recover-store --kind linux|mac --config CONFIG --role ROLE --attestation ATTESTATION
reconcile-mac --config CONFIG --attestation ATTESTATION
maintain --kind linux|mac --config CONFIG
archive-resolved --config CONFIG --attestation ATTESTATION
retire-artifacts --kind linux|mac --config CONFIG --category history|quarantine|copies --limit N
retire-recovery --kind linux|mac --config CONFIG --role ROLE --limit N
```

`ROLE` is `linux-mailbox` or `linux-client` for Linux; `mac-executor` or `mac-sequence` for Mac. `N` is an integer 1–16. `archive-resolved` reads Linux configuration. `forced-command` is the fixed SSH adapter, not an interactive maintenance channel. Explicit init refuses existing/partial state and activates no service/courier. `courier-once --snapshot` exports cache; no scheduler is created.

Stop the writer before inspection, recovery, migration or retirement. `inspect-store` acquires exclusive SQLite ownership and outputs the role, config digest and authenticated exact continuity observation: identity/revision/root, DB device/inode/hash and anchor hash/revision/root/device/inode. It cannot inspect missing, corrupt or unauthenticated state as a recovery shortcut. Recovery requires independently signed `{body, signature}` with version 1, action `recover-continuity`, mode `repair-ahead` or `migrate`, exact role/config digest/observation, nonce and issued/expiry times. Signature domain is `flighty-continuity-recovery-v1:` plus canonical body. Validity is at most five minutes, not future-issued or expired; observation and paths are rechecked before publication. Nonce-named evidence is retained; conflicting reuse rejects.

`repair-ahead` repairs only an authenticated DB exactly one revision ahead of its same-file anchor. `migrate` binds an authenticated unchanged revision/root image to its new device/inode. Neither reconstructs rows, resets sequence, clears UNKNOWN, invents outcomes or repairs missing/corrupt/untrusted/total-loss rollback. Keep independently approved continuity evidence; do not delete state and reinitialize to bypass a refusal.

`reconcile-mac` needs independent external outcome checking and a signed account/operation/request/fence-bound attestation with unique audit ID, operator ID, evidence digest and checked/issued/expiry times (five-minute freshness). Its exact statement is: `External outcome checked; authorize future distinct operations; original outcome remains unknown; do not replay.` Action is `clear-account-fence-after-external-check`, domain `flighty-operator-reconciliation-v1:` plus canonical body. It clears only the matching current account fence, retaining original UNKNOWN and consumed confirmation. `archive-resolved` uses that bound evidence to archive an aged unresolved client request, including one without a receipt; it does not certify a cloud outcome or grant dispatch rights.

`maintain` performs bounded history maintenance, not arbitrary artifact deletion or network execution. Retirement recognizes only app-owned layouts under the same approved device and private roots, checks ages, aggregate budgets, ownership and links, authenticates relevant history/recovery evidence and revalidates the original selection before moving. Recovery audits must be applied and aged before retirement. An explicitly approved recoverable helper whose path ends in `/trash` is required; there is no deletion fallback. The internal validation callback is not a public API.

Retirement errors report sanitized `{"retired":N,"stopped":true}` and exit 1. A pre-execution validation failure counts zero; prior completed moves remain counted. If an invoked helper throws after its source is observed absent, that move is counted. These counts do not prove external trash durability or any cloud outcome. Investigate retained evidence before retrying. Archives, raw quarantine, OS trash readers, schedules and backup retention all need actual approval. No real cleanup is established by synthetic tests.

## Verification and limits

Build from locked source with separately installed Node >=24; see [BUILD.md](BUILD.md). `npm test`, `npm run build` and `npm run verify:stdio` are validation invocations, not claims that all future hosts pass. Synthetic fixtures and mocked transport do not prove real source schema, API behavior, app sync or end-to-end production transport. Exact source review, Linux evidence, documentation review and installed SHA belong to the private delivery record.

Native filesystem stalls cannot be preempted by JavaScript deadlines. Final validation and an external helper are not privileged atomic isolation from concurrent same-UID/root replacement. There is no cloud compare-and-swap or exactly-once guarantee. Retained Gregorian manifest-calendar and bridge per-file staging power-loss durability LOWs are recorded in [DEFERRED.md](DEFERRED.md).
