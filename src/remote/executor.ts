import type { RemovalLocalRecord } from "../services/database.js";
import { createHmac, createPublicKey, randomBytes, type KeyObject } from "node:crypto";
import { findFlight, notFoundMessage, removalTarget, resolveRemoval, type WriteApi, type WriteDatabase } from "../tools/write.js";
import { assertFlightCode, assertIsoDate, assertUuid } from "../services/bounds.js";
import { parseFlightCode, FlightyApi } from "../services/flighty-api.js";
import { assertWritesEnabled, type RuntimePolicy } from "../services/policy.js";
import { generateConfirmCode } from "../services/removal-confirm.js";
import { digest, canonical, ProtocolError, seal, verifyRequest, type Callers, type Request, type Receipt, type Signed, type SignedRequest } from "./protocol.js";
import { sanitizeReceiptError, redactResultSecrets } from "./redaction.js";
import { PrivateStore } from "./store.js";

/** Captured independently on Mac, never from a replica/request account. Never persist this object. */
export type CredentialContext = Readonly<{ account: string; session: string; authToken: string; buildToken: string; syncUrl: string | null }>;
export type ExecutorDeps = {
  store: PrivateStore; callers: Callers; receiptKey: KeyObject; bindingKey: Buffer;
  captureContext: (signal: AbortSignal) => Promise<CredentialContext | null>;
  createApi: (context: CredentialContext, signal: AbortSignal) => WriteApi;
  /** Reopen current local source per call. The adapter must bind owner to context.account. */
  openDatabase: (context: CredentialContext) => {
    db: WriteDatabase;
    /** All exact-UUID rows for captured account, without LIMIT 1 selection. Conflicts fail closed. */
    removalCandidates: (flightId: string) => readonly RemovalLocalRecord[];
    close: () => void;
  };
  checkSource: () => void;
  requestSnapshot: (context: CredentialContext, signal: AbortSignal) => Promise<{ snapshotId: string }>;
  policy: RuntimePolicy; now?: () => number;
  /** Fixture crash hook: throws outside recovery so persisted boundary can be restarted. */
  boundary?: (name: "queued" | "preview" | "dispatch" | "response" | "receipt") => void;
};
import { executorStateValidator, pinnedCallers, RETENTION_MS, type StoredOperation, type Preview, type AccountFence } from "./state.js";
const MAX_PREVIEWS = 32;

/** Bounded API instances use exactly the captured token; discovery stays in the injected capture. */
export function capturedApiFactory(options: { policy: RuntimePolicy; fetchImpl: typeof fetch }): (context: CredentialContext, signal: AbortSignal) => WriteApi {
  return (context, signal) => {
    const captured = { ...context };
    return new FlightyApi({ policy: options.policy,
      fetchImpl: (url, init) => {
        signal.throwIfAborted();
        const combined = init?.signal ? AbortSignal.any([signal, init.signal]) : signal;
        return options.fetchImpl(url, { ...init, signal: combined });
      },
      readAuthToken: () => captured.authToken, getBuildToken: () => captured.buildToken,
      readSyncUrl: () => captured.syncUrl });
  };
}

/** Substantive removal identity excludes telemetry, fetch/copy times and volatile enrichment. */
export function substantiveRemoval(target: ReturnType<typeof removalTarget>): unknown {
  const fields = ["id", "flight_number", "airline_iata", "departure_airport_iata", "arrival_airport_iata",
    "departureScheduleGateOriginal", "arrivalScheduleGateOriginal", "departureScheduleRunwayOriginal", "arrivalScheduleRunwayOriginal", "seat_number", "seat_position", "cabin_class",
    "booking_reference", "flight_reason", "friend_name", "tracking_source", "passenger_name_source", "is_cancelled"];
  const flight = Object.fromEntries(fields.filter(k => Object.hasOwn(target.preview, k)).map(k => [k, target.preview[k]]));
  return { flight, localDetails: target.localDetails, localRecord: target.localRecord,
    owner: target.preview.owner_identity ?? null };
}

export class MacExecutor {
  private readonly now: () => number;
  private readonly unresolvedAccounts = new Set<string>();
  constructor(private readonly deps: ExecutorDeps) {
    if (deps.bindingKey.length < 32) throw new ProtocolError("Private binding key is too short.");
    this.now = deps.now ?? Date.now;
    deps.store.claimConsumer("mac-executor");
    deps.store.setValidator(executorStateValidator(pinnedCallers(deps.callers), createPublicKey(deps.receiptKey), this.now));
    // A previous process may have crossed the HTTP boundary. Never replay its operations.
    deps.store.transaction(() => {
      this.prune();
      for (const { id, value } of deps.store.list<StoredOperation>("operation")) {
        if (value.receipt.body.state === "dispatched") {
          this.fence(value.request);
          value.receipt = this.receipt(value.request.body, "unknown", undefined, "Dispatch outcome is unknown; account is fenced pending operator recovery. Do not automatically retry.");
          deps.store.put("operation", id, value);
        }
      }
    });
  }
  /** Durable submission; identical concurrent IDs return the last committed receipt. */
  async submit(input: SignedRequest): Promise<Signed<Receipt>> {
    const req = verifyRequest(input, this.deps.callers, this.now(), true);
    this.maintenance();
    const saved = this.deps.store.get<StoredOperation>("operation", req.operationId);
    if (saved) {
      if (digest(saved.request.body) !== digest(req)) throw new ProtocolError("Operation ID conflicts with its durable binding.");
      return ["not-dispatched", "dispatched"].includes(saved.receipt.body.state) ? this.run(req.operationId) : saved.receipt;
    }
    if (req.expiresAt <= this.now()) {
      const receipt = this.receipt(req, "failed", undefined, "Request expired. Nothing dispatched.");
      this.deps.store.put("operation", req.operationId, { request: input, contextHash: "0".repeat(64), receipt } satisfies StoredOperation);
      return receipt;
    }
    verifyRequest(input, this.deps.callers, this.now());
    // Capture before durable acceptance. Missing/unestablished sessions never enter dispatch.
    const context = await this.context(req);
    const contextHash = this.fingerprint(context);
    const op: StoredOperation = { request: input, contextHash,
      receipt: this.receipt(req, "not-dispatched") };
    this.deps.store.transaction(() => {
      const concurrent = this.deps.store.get<StoredOperation>("operation", req.operationId);
      if (concurrent) {
        if (digest(concurrent.request.body) !== digest(req)) throw new ProtocolError("Operation ID conflicts with its durable binding.");
        return;
      }
      this.prune(); this.deps.store.put("operation", req.operationId, op);
    });
    this.deps.boundary?.("queued");
    return this.run(req.operationId);
  }
  status(input: SignedRequest): Signed<Receipt> | null {
    const req = verifyRequest(input, this.deps.callers, this.now(), true);
    this.maintenance();
    const op = this.deps.store.get<StoredOperation>("operation", req.operationId);
    if (!op) return null;
    if (digest(req) !== digest(op.request.body)) throw new ProtocolError("Operation binding rejected.");
    return op.receipt;
  }
  /** Explicit wake: queued expired work is failed, never sent; dispatched work is never retried. */
  async drain(): Promise<void> {
    this.maintenance();
    for (const { id, value } of this.deps.store.list<StoredOperation>("operation")) {
      if (value.receipt.body.state === "not-dispatched") await this.run(id);
    }
  }
  /** Integration schedules this explicit sweep; this module starts no timers/services. */
  maintenance(): void { this.deps.store.transaction(() => this.prune()); }
  private async run(id: string): Promise<Signed<Receipt>> {
    return this.deps.store.exclusive(async () => {
      const stored = this.deps.store.get<StoredOperation>("operation", id);
      if (!stored) throw new ProtocolError("Operation receipt is no longer retained; absence is not proof of failure. No dispatch.");
      if (stored.receipt.body.state !== "not-dispatched") return stored.receipt;
      const req = stored.request.body;
      let redactionContext: CredentialContext | undefined;
      const finish = (state: Receipt["state"], result?: unknown, error?: string) => {
        stored.receipt = this.receipt(req, state, result, error, redactionContext);
        this.deps.store.put("operation", id, stored);
        return stored.receipt;
      };
      if (this.unresolvedAccounts.has(req.account) || this.deps.store.get<AccountFence>("fence", req.account)) {
        return finish("failed", undefined, "Account is fenced by an unresolved earlier step; operator recovery is required. Nothing dispatched.");
      }
      let ctx: CredentialContext;
      try { verifyRequest(stored.request, this.deps.callers, this.now()); ctx = await this.sameContext(req, stored.contextHash); redactionContext = ctx; }
      catch { return finish("failed", undefined, "Request expired or current Mac account/session/capability is unavailable or changed. Nothing dispatched."); }
      const op = req.operation;
      if (op.kind === "remove-preview") {
        try {
          const target = this.target(ctx, op.flight_id);
          if (!this.deps.callers[req.caller].capabilities.includes("remove-confirm")) throw new ProtocolError();
          let code = "";
          this.deps.store.transaction(() => {
            this.prune();
            for (const { id, value } of this.deps.store.list<Preview>("preview")) {
              if (!value.consumed && value.flightId === target.flightId.toLowerCase() && value.caller === req.caller) {
                this.deps.store.put("preview", id, { ...value, consumed: true });
              }
            }
            if (this.deps.store.list<Preview>("preview").filter(row => !row.value.consumed).length >= MAX_PREVIEWS) throw new ProtocolError();
            for (let n = 0; n < 8; n++) {
              const candidate = generateConfirmCode(randomBytes(8));
              if (!this.deps.store.get("preview", candidate)) { code = candidate; break; }
            }
            if (!code) throw new ProtocolError();
            this.deps.store.put("preview", code, { requestId: req.operationId, flightId: target.flightId.toLowerCase(), caller: req.caller,
              account: ctx.account, capability: "remove-confirm", contextHash: stored.contextHash,
              localHash: digest(substantiveRemoval(target)), expiresAt: Math.min(this.now() + 300_000, req.expiresAt), consumed: false } satisfies Preview);
            finish("succeeded", { status: "confirmation_required", flight_id: target.flightId, confirm_code: code,
              expires_in_seconds: Math.max(0, Math.floor((Math.min(this.now() + 300_000, req.expiresAt) - this.now()) / 1000)),
              local_details: target.localDetails, local_record: target.localRecord, local_identity: target.localIdentity,
              flight: target.preview,
              message: target.localDetails === "unavailable" ? "Local details and local identity are unavailable for this exact id. Nothing was removed. Confirm this exact UUID within five minutes." : "Nothing was removed. Confirm this exact UUID within five minutes." });
          });
        } catch { return finish("failed", undefined, "Removal preview unavailable. Nothing dispatched."); }
        this.deps.boundary?.("preview");
        return stored.receipt;
      }
      let serverUuid: string | undefined;
      let airlineName: string | undefined;
      if (op.kind === "add" || op.kind === "follow") {
        try {
          const flightCode = assertFlightCode(op.flight_code), date = assertIsoDate(op.date);
          const { airlineIata, flightNumber } = parseFlightCode(flightCode);
          const source = this.deps.openDatabase(ctx);
          try {
            const stepApi: WriteApi = {
              searchFlight: async (...args) => {
                const current = await this.sameContext(req, stored.contextHash);
                return this.step(signal => this.deps.createApi(current, signal).searchFlight(...args), stored.request);
              },
              subscribeFlight: async () => { throw new ProtocolError(); }, followFlight: async () => { throw new ProtocolError(); }, deleteFlight: async () => { throw new ProtocolError(); },
            };
            const boundedDb: WriteDatabase = {
              getRemovalFlight: id => source.db.getRemovalFlight(id),
              lookupAirlines: prefix => {
                const candidates = source.db.lookupAirlines(prefix);
                if (candidates.length > 32 || candidates.some(c => c.name.length > 512)) throw new ProtocolError();
                return candidates;
              },
            };
            const found = await findFlight(boundedDb, stepApi, airlineIata, flightNumber, date);
            if (!found.match) return finish("failed", undefined, notFoundMessage(flightCode, date, found.candidates));
            serverUuid = assertUuid(found.match.serverUuid); airlineName = found.match.airline.name;
          } finally { source.close(); }
        } catch { return finish("failed", undefined, "Flight search failed before mutation dispatch."); }
      }
      try {
        ctx = await this.sameContext(req, stored.contextHash);
        this.deps.store.transaction(() => {
          if (op.kind === "remove-confirm") {
            const preview = this.deps.store.get<Preview>("preview", op.confirm_code.trim());
            const target = this.target(ctx, op.flight_id);
            if (!preview || preview.consumed || preview.expiresAt <= this.now() || preview.flightId !== op.flight_id.toLowerCase() ||
                preview.caller !== req.caller || preview.account !== ctx.account || preview.capability !== op.kind ||
                preview.contextHash !== stored.contextHash || preview.localHash !== digest(substantiveRemoval(target))) throw new ProtocolError();
            // Code consumption and dispatch state commit together before HTTP, including on crashes.
            this.deps.store.put("preview", op.confirm_code.trim(), { ...preview, consumed: true });
          }
          verifyRequest(stored.request, this.deps.callers, this.now());
          finish("dispatched");
        });
      } catch {
        if (op.kind === "remove-confirm") {
          this.deps.store.transaction(() => {
            const preview = this.deps.store.get<Preview>("preview", op.confirm_code.trim());
            if (preview && preview.caller === req.caller && preview.flightId === op.flight_id.toLowerCase()) {
              this.deps.store.put("preview", op.confirm_code.trim(), { ...preview, consumed: true });
            }
          });
        }
        return finish("failed", undefined, "Current context or confirmation rejected. Nothing dispatched.");
      }
      this.deps.boundary?.("dispatch");
      let result: unknown;
      try {
        if (op.kind === "add" || op.kind === "follow") {
          if (op.kind === "add") await this.step(signal => this.deps.createApi(ctx, signal).subscribeFlight(serverUuid!), stored.request); else await this.step(signal => this.deps.createApi(ctx, signal).followFlight(serverUuid!), stored.request);
          result = { status: op.kind === "add" ? "added" : "followed", flight_code: assertFlightCode(op.flight_code), date: op.date,
            airline: airlineName!, server_flight_uuid: serverUuid!, message: "API accepted the request. Later app/replica reconciliation is not yet verified." };
        } else if (op.kind === "remove-confirm") {
          await this.step(signal => this.deps.createApi(ctx, signal).deleteFlight(op.flight_id), stored.request);
          result = { status: "removed", flight_id: op.flight_id, message: "API accepted removal. Later app/replica reconciliation is not yet verified." };
        } else {
          const response = await this.step(signal => this.deps.requestSnapshot(ctx, signal), stored.request);
          if (!/^[A-Za-z0-9_-]{1,80}$/.test(response.snapshotId)) throw new ProtocolError();
          result = { status: "snapshot_requested", snapshot_id: response.snapshotId };
        }
      } catch { return finish("unknown", undefined, "Dispatch outcome is unknown; do not automatically retry. A stale cache or missing row is not proof of failure."); }
      this.deps.boundary?.("response");
      const receipt = finish("succeeded", result);
      this.deps.boundary?.("receipt");
      return receipt;
    });
  }
  private async step<T>(fn: (signal: AbortSignal) => Promise<T>, request?: SignedRequest): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProtocolError("Executor step timed out."));
      }, 15_000);
      timer.unref?.();
    });
    try { return await Promise.race([fn(controller.signal), deadline]); }
    catch (error) {
      controller.abort();
      // Even a provider that ignores cancellation cannot release dispatch authority for this account.
      if (request) this.fence(request);
      throw error;
    }
    finally { clearTimeout(timer); }
  }
  private fence(request: SignedRequest): void {
    this.unresolvedAccounts.add(request.body.account);
    try {
      this.deps.store.put("fence", request.body.account, { request, state: "unresolved" } satisfies AccountFence);
    } catch (error) { this.deps.store.quarantine(); throw error; }
  }
  private async context(req: Request): Promise<CredentialContext> {
    this.deps.checkSource();
    assertWritesEnabled(this.deps.policy);
    const ctx = await this.step(signal => this.deps.captureContext(signal));
    if (!ctx || !ctx.account || !ctx.session || !ctx.authToken || !ctx.buildToken ||
        [ctx.account, ctx.session, ctx.authToken, ctx.buildToken].some(v => typeof v !== "string" || v.length > 16_384) ||
        !(ctx.syncUrl === null || (typeof ctx.syncUrl === "string" && ctx.syncUrl.length <= 4096))) {
      this.invalidatePreviews();
      throw new ProtocolError();
    }
    const hash = this.fingerprint(ctx);
    this.invalidatePreviews(hash);
    if (ctx.account !== req.account) throw new ProtocolError();
    // Copy to prevent caller-owned mutable objects rotating beneath the captured API.
    return Object.freeze({ account: ctx.account, session: ctx.session, authToken: ctx.authToken, buildToken: ctx.buildToken, syncUrl: ctx.syncUrl });
  }
  private async sameContext(req: Request, hash: string): Promise<CredentialContext> {
    verifyRequest({ body: req, signature: this.deps.store.get<StoredOperation>("operation", req.operationId)!.request.signature }, this.deps.callers, this.now());
    const current = await this.context(req);
    if (this.fingerprint(current) !== hash) throw new ProtocolError();
    this.deps.checkSource();
    verifyRequest(this.deps.store.get<StoredOperation>("operation", req.operationId)!.request, this.deps.callers, this.now());
    return current;
  }
  private fingerprint(ctx: CredentialContext): string { return createHmac("sha256", this.deps.bindingKey).update(canonical(ctx)).digest("hex"); }
  private target(ctx: CredentialContext, flightId: string): ReturnType<typeof removalTarget> {
    this.deps.checkSource();
    const source = this.deps.openDatabase(ctx);
    try {
      let rows: readonly RemovalLocalRecord[];
      try { rows = source.removalCandidates(flightId); } catch { rows = []; }
      if (rows.length > 1) throw new ProtocolError("Conflicting local removal records.");
      const resolved = resolveRemoval({ lookupAirlines: prefix => source.db.lookupAirlines(prefix),
        getRemovalFlight: () => rows[0] ?? null }, flightId);
      // Credential authority is independent of local enrichment/frequency fallback.
      if (resolved.kind === "local" && resolved.identity.userId !== ctx.account) throw new ProtocolError();
      return removalTarget(resolved, flightId);
    } finally { source.close(); }
  }
  private invalidatePreviews(currentHash?: string): void {
    this.deps.store.transaction(() => {
      for (const { id, value } of this.deps.store.list<Preview>("preview")) {
        if (!value.consumed && (!currentHash || value.contextHash !== currentHash)) this.deps.store.put("preview", id, { ...value, consumed: true });
      }
    });
  }
  private receipt(req: Request, state: Receipt["state"], result?: unknown, error?: string, context?: CredentialContext): Signed<Receipt> {
    const secrets = context ? [context.authToken, context.buildToken, context.session, context.syncUrl ?? ""] : [];
    if (context?.syncUrl) {
      try { new URL(context.syncUrl).searchParams.forEach((value, key) => { if (/token|secret|auth|key/i.test(key)) secrets.push(value); }); } catch { /* Exact URL redaction still applies. */ }
    }
    return seal("receipt", { version: 1, operationId: req.operationId, caller: req.caller, account: req.account,
      requestDigest: digest(req), state, updatedAt: this.now(), ...(result === undefined ? {} : { result: redactResultSecrets(result, secrets) }), ...(error ? { error: sanitizeReceiptError(error, secrets) } : {}) }, this.deps.receiptKey);
  }
  private prune(): void {
    const now = this.now();
    for (const { id, value } of this.deps.store.list<StoredOperation>("operation")) if (value.request.body.expiresAt + RETENTION_MS <= now) this.deps.store.delete("operation", id);
    for (const { id, value } of this.deps.store.list<Preview>("preview")) if (value.expiresAt <= now) this.deps.store.delete("preview", id);
  }
}
