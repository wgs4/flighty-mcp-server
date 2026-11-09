import { verifyAudit, verifyAttestation } from "../remote/recovery.js";
import type { KeyObject } from "node:crypto";
import { z } from "zod";
import { PrivateStore, type StateRow } from "../remote/store.js";
import { ProtocolError, digest, verifyRequest, verifyRetainedRequest, verifyReceipt, type Callers, type SignedRequest } from "../remote/protocol.js";
import { RemoteClient } from "../remote/client.js";
import type { MailboxStatus } from "../remote/mailbox.js";
import { mailboxStateValidator } from "../remote/state.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { idSchema } from "../remote/protocol.js";

export type ClientRow = { request: SignedRequest; status: MailboxStatus | null };
export function verifyClientResolution(input: unknown, id: string, callers: Callers, key: KeyObject, operatorKey: KeyObject): void {
  const value = z.object({ attestation: z.unknown(), request: z.unknown(), unknownReceipt: z.unknown().nullable() }).strict().parse(input);
  if (value.unknownReceipt !== null) { verifyAudit(value, id, callers, key, operatorKey); return; }
  const a = verifyAttestation(value.attestation, operatorKey).body, req = verifyRetainedRequest(value.request, callers, Date.now());
  if (a.auditId !== id || a.account !== req.account || a.operationId !== req.operationId || a.requestDigest !== digest(req) ||
    a.fenceDigest !== digest({ request: value.request, state: "unresolved" })) throw new ProtocolError("Unreceipted resolution binding rejected.");
}
export function clientStateValidator(callers: Callers, key: KeyObject, now = Date.now, operatorKey?: KeyObject) {
  return (rows: readonly StateRow[]) => {
    for (const row of rows) {
      if (row.kind === "client-resolution" && operatorKey) { verifyClientResolution(row.value, row.id, callers, key, operatorKey); continue; }
      if (row.kind !== "client") throw new ProtocolError();
      const v = z.object({ request: z.unknown(), status: z.unknown().nullable() }).strict().parse(row.value) as ClientRow;
      const request = verifyRetainedRequest(v.request, callers, now());
      if (row.id !== request.operationId) throw new ProtocolError();
      if (v.status) {
        z.object({ queue: z.enum(["queued", "leased", "expired", "receipted", "absent"]), receipt: z.unknown().nullable() }).strict().parse(v.status);
        if ((v.status.queue === "receipted") !== !!v.status.receipt) throw new ProtocolError();
        if (v.status.receipt) verifyReceipt(v.status.receipt, key, request);
      }
    }
  };
}
export function linuxStateValidator(callers: Callers, key: KeyObject, now = Date.now) {
  const mail = mailboxStateValidator(callers, key, now), client = clientStateValidator(callers, key, now);
  return (rows: readonly StateRow[]) => {
    if (rows.some(r => r.kind !== "mail" && r.kind !== "client")) throw new ProtocolError();
    mail(rows.filter(r => r.kind === "mail")); client(rows.filter(r => r.kind === "client"));
  };
}
export class DurableClient {
  constructor(readonly client: RemoteClient, private readonly store: PrivateStore,
    private readonly caller: string, private readonly account: string, private readonly now = Date.now) {}
  async remember(request: SignedRequest): Promise<void> {
    if (request.body.caller !== this.caller || request.body.account !== this.account) throw new ProtocolError();
    this.maintenance();
    this.store.transaction(() => {
      const old = this.store.get<ClientRow>("client", request.body.operationId);
      if (old && digest(old.request) !== digest(request)) throw new ProtocolError();
      if (!old) this.store.put("client", request.body.operationId, { request, status: null });
    });
  }
  async status(id: string): Promise<unknown> {
    idSchema.parse(id);
    const row = this.store.get<ClientRow>("client", id) ?? this.store.archived<ClientRow>("client", id);
    if (!row || row.request.body.caller !== this.caller || row.request.body.account !== this.account) {
      return { status: "unavailable", operation_id: id, message: "No retained operation for this configured caller/account. Absence does not prove failure." };
    }
    try {
      const status = await this.client.status(row.request);
      // Retain authenticated receipts even if the mailbox later expires its copy.
      if (!row.status?.receipt) { row.status = status; this.store.put("client", id, row); }
    } catch { /* The exact request and any authenticated result remain durable. */ }
    const receipt = row.status?.receipt?.body;
    return { operation_id: id, status: receipt?.state ?? (row.request.body.expiresAt <= this.now() ? "expired" : "pending"),
      queue: row.status?.queue ?? "unavailable", ...(receipt ? { receipt } : {}),
      message: "Inspect this original operation ID. Never automatically repeat a mutation with a new ID. Expiry without a Mac receipt does not prove no cloud dispatch." };
  }
  maintenance(): void {
    this.store.transaction(() => {
      for (const { id, value } of this.store.list<ClientRow>("client")) {
        if (value.request.body.expiresAt + 86_400_000 > this.now()) continue;
        const state = value.status?.receipt?.body.state;
        if (state !== "succeeded" && state !== "failed") continue;
        this.store.archive("client", id); this.store.delete("client", id);
      }
    });
  }
  registerTools(server: McpServer): void {
    server.registerTool("flighty_operation_status", { description: "Inspect the original remote operation ID for this configured caller/account. Retained authenticated receipts distinguish pending, expired, failed and unknown; cache absence proves no outcome.",
      inputSchema: { operation_id: idSchema }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    async ({ operation_id }) => ({ content: [{ type: "text", text: JSON.stringify(await this.status(operation_id)) }] }));
    server.registerTool("flighty_request_copy", { description: "Request a new signed copy of the Mac's existing Flighty cache. copy_refresh only: does not request Flighty upstream sync or make stale source data live. Check the original returned operation ID.",
      inputSchema: {}, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } }, async () => {
      const request = this.client.prepare({ kind: "request-snapshot" });
      await this.remember(request);
      try { const status = await this.client.submit(request); this.store.put("client", request.body.operationId, { request, status }); } catch { /* Durable pending request can expire. */ }
      return { content: [{ type: "text", text: JSON.stringify({ action: "copy_refresh", ...await this.status(request.body.operationId) as object }) }] };
    });
  }
}
