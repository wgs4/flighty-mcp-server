import { verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { boundedJson, canonical, digest, idSchema, timeSchema, ProtocolError, verifyRequest, verifyRetainedRequest, verifyReceipt, type Callers, type SignedRequest, type Signed, type Receipt } from "./protocol.js";
import type { PrivateStore } from "./store.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const attestationSchema = z.object({ version: z.literal(1), action: z.literal("clear-account-fence-after-external-check"),
  account: idSchema, operationId: idSchema, requestDigest: hash, fenceDigest: hash, auditId: idSchema,
  operator: idSchema, evidenceSha256: hash, statement: z.literal("External outcome checked; authorize future distinct operations; original outcome remains unknown; do not replay."),
  checkedAt: timeSchema, issuedAt: timeSchema, expiresAt: timeSchema }).strict();
export type Attestation = z.infer<typeof attestationSchema>;
export type OperatorAttestation = { body: Attestation; signature: string };
export type ReconciliationAudit = { attestation: OperatorAttestation; request: SignedRequest; unknownReceipt: Signed<Receipt> };
export function verifyAttestation(input: unknown, key: KeyObject): OperatorAttestation {
  boundedJson(input);
  const shape = z.object({ body: attestationSchema, signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict().parse(input);
  if (key.asymmetricKeyType !== "ed25519" || !verify(null, Buffer.from("flighty-operator-reconciliation-v1:" + canonical(shape.body)), key, Buffer.from(shape.signature, "base64"))) throw new ProtocolError();
  if (shape.body.expiresAt <= shape.body.issuedAt || shape.body.expiresAt - shape.body.issuedAt > 300_000 || shape.body.checkedAt > shape.body.issuedAt) throw new ProtocolError();
  return shape;
}
export function verifyAudit(input: unknown, id: string, callers: Callers, receiptKey: KeyObject, operatorKey: KeyObject): void {
  const value = z.object({ attestation: z.unknown(), request: z.unknown(), unknownReceipt: z.unknown() }).strict().parse(input);
  const signed = verifyAttestation(value.attestation, operatorKey), req = verifyRetainedRequest(value.request, callers, Date.now());
  const receipt = verifyReceipt(value.unknownReceipt, receiptKey, req);
  const a = signed.body;
  if (id !== a.auditId || a.operationId !== req.operationId || a.account !== req.account || a.requestDigest !== digest(req) || receipt.state !== "unknown" ||
      a.fenceDigest !== digest({ request: value.request, state: "unresolved" })) throw new ProtocolError("Reconciliation audit binding rejected.");
}
/** Mac-local operator API only. Never exposed through a capability, MCP tool, mailbox or IPC.
 * A separate pinned operator signature attests an external check; this is not upstream atomic proof. */
export function reconcileAccountFence(options: { store: PrivateStore; attestation: unknown; operatorKey: KeyObject;
  currentAccount: string; now?: number }): void {
  const signed = verifyAttestation(options.attestation, options.operatorKey), a = signed.body, now = options.now ?? Date.now();
  if (a.account !== options.currentAccount || a.issuedAt > now || a.expiresAt <= now || now - a.checkedAt > 300_000) throw new ProtocolError();
  options.store.transaction(() => {
    const fence = options.store.get<{ request: SignedRequest; state: "unresolved" }>("fence", a.account);
    const op = options.store.get<{ request: SignedRequest; receipt: Signed<Receipt> }>("operation", a.operationId);
    if (!fence || !op || op.receipt.body.state !== "unknown" || fence.request.body.operationId !== a.operationId ||
        digest(op.request) !== digest(fence.request) || digest(fence) !== a.fenceDigest || digest(op.request.body) !== a.requestDigest ||
        options.store.get("reconciliation", a.auditId)) throw new ProtocolError("Reconciliation must bind the current unresolved operation.");
    const audit: ReconciliationAudit = { attestation: signed, request: op.request, unknownReceipt: op.receipt };
    options.store.put("reconciliation", a.auditId, audit);
    options.store.delete("fence", a.account);
    // Historical UNKNOWN and consumed removal confirmations are never rewritten/restored.
  });
}
