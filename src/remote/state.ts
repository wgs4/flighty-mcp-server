import { z } from "zod";
import type { KeyObject } from "node:crypto";
import { digest, idSchema, parseSchema, ProtocolError, timeSchema, verifyReceipt, verifyRequest, type Callers, type Receipt, type Signed, type SignedRequest } from "./protocol.js";
import type { StateRow } from "./store.js";

export const RETENTION_MS = 86_400_000;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const operationSchema = z.object({ request: z.unknown(), contextHash: hash, receipt: z.unknown(), phase: z.literal("snapshot-running").optional() }).strict();
const previewSchema = z.object({ requestId: idSchema, flightId: z.string().uuid(), caller: idSchema, account: idSchema,
  capability: z.literal("remove-confirm"), contextHash: hash, localHash: hash, expiresAt: timeSchema, consumed: z.boolean() }).strict();
const fenceSchema = z.object({ request: z.unknown(), state: z.literal("unresolved") }).strict();
const queuedSchema = z.object({ request: z.unknown(), leaseUntil: timeSchema, receipt: z.unknown().nullable() }).strict();
export type StoredOperation = { request: SignedRequest; contextHash: string; receipt: Signed<Receipt>; phase?: "snapshot-running" };
export type Preview = z.infer<typeof previewSchema>;
export type AccountFence = { request: SignedRequest; state: "unresolved" };
export type Queued = { request: SignedRequest; leaseUntil: number; receipt: Signed<Receipt> | null };

/** Preserve pinned verification keys for retained records; dispatch checks current authorization separately. */
export function pinnedCallers(callers: Callers): Callers {
  return Object.fromEntries(Object.entries(callers).map(([id, policy]) => [id, { ...policy, capabilities: [...policy.capabilities] }]));
}
/** Cache only exact cryptographic proofs with immutable pinned keys, never state/authorization decisions.
 * Every scan still authenticates the current DB/root and checks IDs, schemas, bindings and clock. */
function retainedProofs(callers: Callers, macKey: KeyObject, now: () => number) {
  const requests = new Set<string>(), receipts = new Set<string>();
  let trust = pinnedCallers(callers);
  const checkTrust = () => {
    const keys = Object.keys(callers);
    if (keys.length !== Object.keys(trust).length || keys.some(id => {
      const current = callers[id], previous = trust[id];
      return !current || !previous || current.publicKey !== previous.publicKey || current.account !== previous.account ||
        current.capabilities.length !== previous.capabilities.length || current.capabilities.some((capability, index) => capability !== previous.capabilities[index]);
    })) {
      requests.clear(); receipts.clear(); trust = pinnedCallers(callers);
    }
  };
  const remember = (set: Set<string>, proof: string) => {
    if (set.size >= 256) set.delete(set.values().next().value!);
    set.add(proof);
  };
  return {
    request(input: unknown) {
      checkTrust();
      const proof = digest(input);
      if (!requests.has(proof)) { const value = verifyRequest(input, callers, now(), true); remember(requests, proof); return value; }
      const value = (input as SignedRequest).body;
      if (value.issuedAt > now()) throw new ProtocolError("Retained request clock rejected.");
      return value;
    },
    receipt(input: unknown, request: SignedRequest["body"]) {
      checkTrust();
      const proof = digest(input) + digest(request);
      if (!receipts.has(proof)) { const value = verifyReceipt(input, macKey, request); remember(receipts, proof); return value; }
      return (input as Signed<Receipt>).body;
    },
  };
}
export function executorStateValidator(callers: Callers, macKey: KeyObject, now: () => number): (rows: readonly StateRow[]) => void {
  const proofs = retainedProofs(callers, macKey, now);
  return rows => {
    const operations = new Map<string, StoredOperation>();
    for (const row of rows) {
      if (row.kind === "preview") continue;
      if (row.kind === "fence") {
        const fence = parseSchema(fenceSchema, row.value), request = proofs.request(fence.request);
        if (row.id !== request.account) throw new ProtocolError("Durable unresolved account fence rejected.");
        continue;
      }
      if (row.kind !== "operation") throw new ProtocolError("Unexpected executor state kind.");
      const parsed = parseSchema(operationSchema, row.value);
      const request = proofs.request(parsed.request);
      proofs.receipt(parsed.receipt, request);
      if (parsed.phase && (request.operation.kind !== "request-snapshot" || (parsed.receipt as Signed<Receipt>).body.state !== "not-dispatched")) throw new ProtocolError("Snapshot phase binding rejected.");
      if (row.id !== request.operationId) throw new ProtocolError("Durable operation ID mismatch.");
      operations.set(row.id, parsed as StoredOperation);
    }
    for (const row of rows) {
      if (row.kind !== "preview") continue;
      const preview = parseSchema(previewSchema, row.value);
      const operation = operations.get(preview.requestId), request = operation?.request.body;
      const issued = operation?.receipt.body.result as { confirm_code?: string; flight_id?: string } | undefined;
      if (!/^[A-HJ-NP-Z2-9]{8}$/.test(row.id) || !operation || !request || request.operation.kind !== "remove-preview" ||
          request.operation.flight_id.toLowerCase() !== preview.flightId || request.caller !== preview.caller || request.account !== preview.account ||
          operation.contextHash !== preview.contextHash || preview.expiresAt !== request.expiresAt ||
          operation.receipt.body.state !== "succeeded" || !issued || issued.confirm_code !== row.id || issued.flight_id?.toLowerCase() !== preview.flightId) throw new ProtocolError("Durable preview binding rejected.");
    }
  };
}
export function mailboxStateValidator(callers: Callers, macKey: KeyObject, now: () => number): (rows: readonly StateRow[]) => void {
  const proofs = retainedProofs(callers, macKey, now);
  return rows => {
    for (const row of rows) {
      if (row.kind !== "mail") throw new ProtocolError("Unexpected mailbox state kind.");
      const value = parseSchema(queuedSchema, row.value), request = proofs.request(value.request);
      if (row.id !== request.operationId || (value.leaseUntil !== 0 && (value.leaseUntil < request.issuedAt || value.leaseUntil > request.expiresAt + RETENTION_MS + 30_000))) throw new ProtocolError("Durable mailbox binding rejected.");
      if (value.receipt !== null) {
        const receipt = proofs.receipt(value.receipt, request);
        if (!["succeeded", "failed", "unknown"].includes(receipt.state) || receipt.updatedAt < request.issuedAt) throw new ProtocolError("Durable terminal receipt rejected.");
      }
    }
  };
}
