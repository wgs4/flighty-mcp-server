import type { KeyObject } from "node:crypto";
import { z } from "zod";
import { boundedJson, digest, parseWire, ProtocolError, verifyReceipt, verifyRequest, type Callers, type Receipt, type Signed, type SignedRequest } from "./protocol.js";
import { PrivateStore } from "./store.js";

/** Supplied by the authenticated transport/forced command configuration, never the message body. */
export type MailboxPrincipal = { role: "caller"; caller: string } | { role: "mac" };
const commandSchema = z.discriminatedUnion("verb", [
  z.object({ verb: z.literal("submit"), request: z.unknown() }).strict(),
  z.object({ verb: z.literal("status"), request: z.unknown() }).strict(),
  z.object({ verb: z.literal("lease"), limit: z.number().int().min(1).max(16) }).strict(),
  z.object({ verb: z.literal("receipt"), receipt: z.unknown() }).strict(),
]);
import { mailboxStateValidator, pinnedCallers, RETENTION_MS, type Queued } from "./state.js";
export type MailboxStatus = { queue: "queued" | "leased" | "expired" | "receipted" | "absent"; receipt: Signed<Receipt> | null };
export type MailboxOptions = { store: PrivateStore; callers: Callers; macReceiptKey: KeyObject; now?: () => number };

/** Linux mailbox stores mutation-capability requests, but cannot sign Mac results. */
export class Mailbox {
  private readonly now: () => number;
  constructor(private readonly options: MailboxOptions) {
    this.now = options.now ?? Date.now;
    options.store.setValidator(mailboxStateValidator(pinnedCallers(options.callers), options.macReceiptKey, this.now));
  }
  handle(principal: MailboxPrincipal, wire: string): string {
    const cmd = commandSchema.parse(parseWire(wire));
    return this.options.store.transaction(() => {
      this.prune();
      if (cmd.verb === "submit" || cmd.verb === "status") {
        if (principal.role !== "caller") throw new ProtocolError("Mailbox role rejected.");
        const signed = cmd.request as SignedRequest;
        const req = verifyRequest(signed, this.options.callers, this.now(), true);
        if (req.caller !== principal.caller) throw new ProtocolError("Authenticated caller mismatch.");
        let row = this.options.store.get<Queued>("mail", req.operationId);
        if (row && digest(row.request.body) !== digest(req)) throw new ProtocolError("Conflicting operation ID.");
        if (!row && cmd.verb === "submit") {
          verifyRequest(signed, this.options.callers, this.now());
          row = { request: signed, leaseUntil: 0, receipt: null };
          this.options.store.put("mail", req.operationId, row);
        }
        const queue = !row ? "absent" : row.receipt ? "receipted" : req.expiresAt <= this.now() ? "expired" : row.leaseUntil > this.now() ? "leased" : "queued";
        return boundedJson({ queue, receipt: row?.receipt ?? null } satisfies MailboxStatus);
      }
      if (principal.role !== "mac") throw new ProtocolError("Mailbox role rejected.");
      if (cmd.verb === "lease") {
        const requests: SignedRequest[] = [];
        for (const { id, value } of this.options.store.list<Queued>("mail")) {
          if (requests.length >= cmd.limit) break;
          if (value.receipt || value.request.body.expiresAt <= this.now() || value.leaseUntil > this.now()) continue;
          // Revoked callers/capabilities cannot dispatch previously queued work.
          try { verifyRequest(value.request, this.options.callers, this.now()); } catch { continue; }
          const candidate = [...requests, value.request];
          try { boundedJson({ requests: candidate }); } catch { break; }
          requests.push(value.request); value.leaseUntil = Math.min(this.now() + 30_000, value.request.body.expiresAt);
          this.options.store.put("mail", id, value);
        }
        return boundedJson({ requests });
      }
      const signed = cmd.receipt as Signed<Receipt>;
      const row = this.options.store.get<Queued>("mail", signed?.body?.operationId);
      if (!row) throw new ProtocolError("Receipt has no queued request.");
      const receipt = verifyReceipt(signed, this.options.macReceiptKey, row.request.body);
      if (!["succeeded", "failed", "unknown"].includes(receipt.state)) throw new ProtocolError("Only terminal receipts are publishable.");
      if (receipt.updatedAt > this.now() + 30_000 || receipt.updatedAt < row.request.body.issuedAt) throw new ProtocolError("Receipt time rejected.");
      if (row.receipt && digest(row.receipt) !== digest(signed)) throw new ProtocolError("Conflicting terminal receipt.");
      row.receipt = signed; this.options.store.put("mail", receipt.operationId, row);
      return boundedJson({ accepted: true });
    });
  }
  /** Explicit retention sweep for an approved scheduler; no background work starts here. */
  maintenance(): void { this.options.store.transaction(() => this.prune()); }
  private prune(): void {
    for (const { id, value } of this.options.store.list<Queued>("mail")) if (value.request.body.expiresAt + RETENTION_MS <= this.now()) this.options.store.delete("mail", id);
  }
}

export type MailboxTransport = (command: string) => Promise<string>;
export function localTransport(mailbox: Mailbox, principal: MailboxPrincipal): MailboxTransport {
  return async command => mailbox.handle(principal, command);
}

/** One bounded outbound poll; the scheduler/backoff/SSH activation belongs to integration. */
export async function pollMailbox(transport: MailboxTransport, executor: {
  submit: (request: SignedRequest) => Promise<Signed<Receipt>>;
}, limit = 8): Promise<number> {
  const result = z.object({ requests: z.array(z.unknown()).max(16) }).strict().parse(parseWire(await transport(boundedJson({ verb: "lease", limit }))));
  let published = 0;
  for (const input of result.requests) {
    const receipt = await executor.submit(input as SignedRequest);
    if (["succeeded", "failed", "unknown"].includes(receipt.body.state)) {
      const ack = parseWire(await transport(boundedJson({ verb: "receipt", receipt })));
      z.object({ accepted: z.literal(true) }).strict().parse(ack);
      published++;
    }
  }
  return published;
}
