import { z } from "zod";
import type { KeyObject } from "node:crypto";
import { idSchema, parseSchema, ProtocolError, timeSchema, verifyReceipt, verifyRequest, type Callers, type Receipt, type Signed, type SignedRequest } from "./protocol.js";
import type { StateRow } from "./store.js";

export const RETENTION_MS = 86_400_000;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const operationSchema = z.object({ request: z.unknown(), contextHash: hash, receipt: z.unknown() }).strict();
const previewSchema = z.object({ requestId: idSchema, flightId: z.string().uuid(), caller: idSchema, account: idSchema,
  capability: z.literal("remove-confirm"), contextHash: hash, localHash: hash, expiresAt: timeSchema, consumed: z.boolean() }).strict();
const queuedSchema = z.object({ request: z.unknown(), leaseUntil: timeSchema, receipt: z.unknown().nullable() }).strict();
export type StoredOperation = { request: SignedRequest; contextHash: string; receipt: Signed<Receipt> };
export type Preview = z.infer<typeof previewSchema>;
export type Queued = { request: SignedRequest; leaseUntil: number; receipt: Signed<Receipt> | null };

/** Preserve pinned verification keys for retained records; dispatch checks current authorization separately. */
export function pinnedCallers(callers: Callers): Callers {
  return Object.fromEntries(Object.entries(callers).map(([id, policy]) => [id, { ...policy, capabilities: [...policy.capabilities] }]));
}
export function executorStateValidator(callers: Callers, macKey: KeyObject, now: () => number): (rows: readonly StateRow[]) => void {
  return rows => {
    const operations = new Map<string, StoredOperation>();
    for (const row of rows) {
      if (row.kind === "preview") continue;
      if (row.kind !== "operation") throw new ProtocolError("Unexpected executor state kind.");
      const parsed = parseSchema(operationSchema, row.value);
      const request = verifyRequest(parsed.request, callers, now(), true);
      verifyReceipt(parsed.receipt, macKey, request);
      if (row.id !== request.operationId) throw new ProtocolError("Durable operation ID mismatch.");
      operations.set(row.id, parsed as StoredOperation);
    }
    for (const row of rows) {
      if (row.kind !== "preview") continue;
      const preview = parseSchema(previewSchema, row.value);
      const operation = operations.get(preview.requestId), request = operation?.request.body;
      if (!/^[A-HJ-NP-Z2-9]{8}$/.test(row.id) || !operation || !request || request.operation.kind !== "remove-preview" ||
          request.operation.flight_id.toLowerCase() !== preview.flightId || request.caller !== preview.caller || request.account !== preview.account ||
          operation.contextHash !== preview.contextHash || preview.expiresAt !== request.expiresAt) throw new ProtocolError("Durable preview binding rejected.");
    }
  };
}
export function mailboxStateValidator(callers: Callers, macKey: KeyObject, now: () => number): (rows: readonly StateRow[]) => void {
  return rows => {
    for (const row of rows) {
      if (row.kind !== "mail") throw new ProtocolError("Unexpected mailbox state kind.");
      const value = parseSchema(queuedSchema, row.value), request = verifyRequest(value.request, callers, now(), true);
      if (row.id !== request.operationId || (value.leaseUntil !== 0 && (value.leaseUntil < request.issuedAt || value.leaseUntil > request.expiresAt + 30_000))) throw new ProtocolError("Durable mailbox binding rejected.");
      if (value.receipt !== null) {
        const receipt = verifyReceipt(value.receipt, macKey, request);
        if (!["succeeded", "failed", "unknown"].includes(receipt.state) || receipt.updatedAt < request.issuedAt) throw new ProtocolError("Durable terminal receipt rejected.");
      }
    }
  };
}
