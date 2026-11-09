import { createHash, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { assertConfirmCodeShape, assertFlightCode, assertIsoDate, assertUuid, UUID_PATTERN } from "../services/bounds.js";
import { parseFlightCode } from "../services/flighty-api.js";

export const MAX_WIRE_BYTES = 64 * 1024;
export const MAX_LIFETIME_MS = 5 * 60_000;
export const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const timeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const operationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add"), flight_code: z.string().max(20), date: z.string().max(10) }).strict(),
  z.object({ kind: z.literal("follow"), flight_code: z.string().max(20), date: z.string().max(10) }).strict(),
  z.object({ kind: z.literal("remove-preview"), flight_id: z.string().regex(UUID_PATTERN) }).strict(),
  z.object({ kind: z.literal("remove-confirm"), flight_id: z.string().regex(UUID_PATTERN), confirm_code: z.string().min(1).max(32) }).strict(),
  z.object({ kind: z.literal("request-snapshot") }).strict(),
]);
export type Operation = z.infer<typeof operationSchema>;
export type Capability = Operation["kind"];
export const requestSchema = z.object({
  version: z.literal(1), operationId: idSchema, caller: idSchema, account: idSchema,
  issuedAt: timeSchema, expiresAt: timeSchema, operation: operationSchema,
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type Request = z.infer<typeof requestSchema>;
export type Signed<T> = { body: T; signature: string };
export type SignedRequest = Signed<Request>;
export type CallerPolicy = { publicKey: KeyObject; historicalPublicKeys?: readonly KeyObject[]; account: string; capabilities: readonly Capability[] };
export type Callers = Readonly<Record<string, CallerPolicy>>;
export type OperationState = "not-dispatched" | "dispatched" | "succeeded" | "failed" | "unknown";
export const receiptSchema = z.object({
  version: z.literal(1), operationId: idSchema, caller: idSchema, account: idSchema,
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["not-dispatched", "dispatched", "succeeded", "failed", "unknown"]),
  updatedAt: timeSchema, result: z.unknown().optional(), error: z.string().max(4096).optional(),
}).strict();
export type Receipt = z.infer<typeof receiptSchema>;
export class ProtocolError extends Error {
  constructor(message = "Remote request rejected.") { super(message); this.name = "ProtocolError"; }
}

/** Canonical JSON only: sorted object keys, no undefined, non-finite values or prototypes. */
export function canonical(value: unknown, depth = 0): string {
  if (depth > 32) throw new ProtocolError();
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(v => canonical(v, depth + 1)).join(",")}]`;
  if (typeof value === "object" && value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k], depth + 1)}`).join(",")}}`;
  }
  throw new ProtocolError();
}
export function boundedJson(value: unknown): string {
  const json = canonical(value);
  if (Buffer.byteLength(json) > MAX_WIRE_BYTES) throw new ProtocolError("Remote message too large.");
  return json;
}
export function parseWire(json: string): unknown {
  if (typeof json !== "string") throw new ProtocolError();
  if (Buffer.byteLength(json) > MAX_WIRE_BYTES) throw new ProtocolError("Remote message too large.");
  try { return JSON.parse(json); } catch { throw new ProtocolError(); }
}
export function digest(value: unknown): string { return createHash("sha256").update(boundedJson(value)).digest("hex"); }
export function seal<T>(domain: "request" | "receipt", body: T, key: KeyObject): Signed<T> {
  if (key.asymmetricKeyType !== "ed25519" || key.type !== "private") throw new ProtocolError();
  return { body, signature: sign(null, Buffer.from(`flighty-remote-v1:${domain}:${boundedJson(body)}`), key).toString("base64") };
}
export function signedEnvelope(input: unknown): Signed<unknown> {
  boundedJson(input);
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).sort().join(",") !== "body,signature") throw new ProtocolError("Remote envelope rejected.");
  const signed = input as Signed<unknown>;
  if (typeof signed.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(signed.signature)) throw new ProtocolError("Remote signature rejected.");
  return signed;
}
export function open<T>(domain: "request" | "receipt", input: Signed<T> | unknown, key: KeyObject): T {
  const signed = signedEnvelope(input);
  if (key.asymmetricKeyType !== "ed25519" || !verify(null, Buffer.from(`flighty-remote-v1:${domain}:${boundedJson(signed.body)}`), key, Buffer.from(signed.signature, "base64"))) {
    throw new ProtocolError("Remote signature rejected.");
  }
  return signed.body as T;
}
export function parseSchema<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ProtocolError("Remote record schema rejected.");
  return result.data;
}
export function validateOperation(input: unknown): Operation {
  const op = parseSchema(operationSchema, input);
  if (op.kind === "add" || op.kind === "follow") {
    assertFlightCode(op.flight_code); assertIsoDate(op.date); parseFlightCode(op.flight_code);
  } else if (op.kind === "remove-preview" || op.kind === "remove-confirm") {
    assertUuid(op.flight_id);
    if (op.kind === "remove-confirm") assertConfirmCodeShape(op.confirm_code);
  }
  return op;
}
export function verifyRequest(input: unknown, callers: Callers, now: number, allowExpired = false): Request {
  const envelope = signedEnvelope(input);
  const req = parseSchema(requestSchema, envelope.body);
  const policy = Object.hasOwn(callers, req.caller) ? callers[req.caller] : undefined;
  if (!policy || policy.account !== req.account || !policy.capabilities.includes(req.operation.kind)) throw new ProtocolError("Caller capability rejected.");
  open("request", input, policy.publicKey);
  validateOperation(req.operation);
  if (req.payloadDigest !== digest(req.operation) || req.expiresAt <= req.issuedAt ||
      req.expiresAt - req.issuedAt > MAX_LIFETIME_MS || req.issuedAt > now || (!allowExpired && req.expiresAt <= now)) throw new ProtocolError("Request binding or expiry rejected.");
  return req;
}
/** Trusted account-bound historical keys authenticate evidence, never current dispatch authority. */
export function verifyRetainedRequest(input: unknown, callers: Callers, now: number): Request {
  const envelope = signedEnvelope(input), req = parseSchema(requestSchema, envelope.body);
  const policy = Object.hasOwn(callers, req.caller) ? callers[req.caller] : undefined;
  if (!policy || policy.account !== req.account) throw new ProtocolError("Historical caller/account rejected.");
  for (const key of [policy.publicKey, ...(policy.historicalPublicKeys ?? [])]) {
    try { return verifyRequest(input, { [req.caller]: { account: policy.account, publicKey: key, capabilities: [req.operation.kind] } }, now, true); }
    catch { /* Try only explicitly pinned historical keys. */ }
  }
  throw new ProtocolError("Historical signature or request binding rejected.");
}
export function makeRequest(input: Omit<Request, "version" | "payloadDigest">, key: KeyObject): SignedRequest {
  validateOperation(input.operation);
  return seal("request", { version: 1, ...input, payloadDigest: digest(input.operation) }, key);
}
export function verifyReceipt(signed: unknown, key: KeyObject, req: Request): Receipt {
  const receipt = parseSchema(receiptSchema, open<unknown>("receipt", signed, key));
  if (receipt.version !== 1 || receipt.operationId !== req.operationId || receipt.caller !== req.caller ||
      receipt.account !== req.account || receipt.requestDigest !== digest(req) || receipt.updatedAt < req.issuedAt) throw new ProtocolError("Receipt binding rejected.");
  return receipt;
}
