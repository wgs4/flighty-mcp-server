import { createHash, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { assertConfirmCodeShape, assertFlightCode, assertIsoDate, assertUuid, UUID_PATTERN } from "../services/bounds.js";
import { parseFlightCode } from "../services/flighty-api.js";

export const MAX_WIRE_BYTES = 64 * 1024;
export const MAX_LIFETIME_MS = 5 * 60_000;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
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
  version: z.literal(1), operationId: id, caller: id, account: id,
  issuedAt: time, expiresAt: time, operation: operationSchema,
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type Request = z.infer<typeof requestSchema>;
export type Signed<T> = { body: T; signature: string };
export type SignedRequest = Signed<Request>;
export type CallerPolicy = { publicKey: KeyObject; account: string; capabilities: readonly Capability[] };
export type Callers = Readonly<Record<string, CallerPolicy>>;
export type OperationState = "not-dispatched" | "dispatched" | "succeeded" | "failed" | "unknown";
export type Receipt = {
  version: 1; operationId: string; caller: string; account: string; requestDigest: string;
  state: OperationState; updatedAt: number; result?: unknown; error?: string;
};
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
  if (Buffer.byteLength(json) > MAX_WIRE_BYTES) throw new ProtocolError("Remote message too large.");
  try { return JSON.parse(json); } catch { throw new ProtocolError(); }
}
export function digest(value: unknown): string { return createHash("sha256").update(boundedJson(value)).digest("hex"); }
export function seal<T>(domain: "request" | "receipt", body: T, key: KeyObject): Signed<T> {
  if (key.asymmetricKeyType !== "ed25519" || key.type !== "private") throw new ProtocolError();
  return { body, signature: sign(null, Buffer.from(`flighty-remote-v1:${domain}:${boundedJson(body)}`), key).toString("base64") };
}
export function open<T>(domain: "request" | "receipt", signed: Signed<T>, key: KeyObject): T {
  boundedJson(signed);
  if (Object.keys(signed).sort().join(",") !== "body,signature" ||
      typeof signed.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(signed.signature) ||
      key.asymmetricKeyType !== "ed25519" || !verify(null, Buffer.from(`flighty-remote-v1:${domain}:${boundedJson(signed.body)}`), key, Buffer.from(signed.signature, "base64"))) {
    throw new ProtocolError("Remote signature rejected.");
  }
  return signed.body;
}
export function validateOperation(input: unknown): Operation {
  const op = operationSchema.parse(input);
  if (op.kind === "add" || op.kind === "follow") {
    assertFlightCode(op.flight_code); assertIsoDate(op.date); parseFlightCode(op.flight_code);
  } else if (op.kind === "remove-preview" || op.kind === "remove-confirm") {
    assertUuid(op.flight_id);
    if (op.kind === "remove-confirm") assertConfirmCodeShape(op.confirm_code);
  }
  return op;
}
export function verifyRequest(input: SignedRequest, callers: Callers, now: number, allowExpired = false): Request {
  boundedJson(input);
  const req = requestSchema.parse(input.body);
  const policy = Object.hasOwn(callers, req.caller) ? callers[req.caller] : undefined;
  if (!policy || policy.account !== req.account || !policy.capabilities.includes(req.operation.kind)) throw new ProtocolError("Caller capability rejected.");
  open("request", input, policy.publicKey);
  validateOperation(req.operation);
  if (req.payloadDigest !== digest(req.operation) || req.expiresAt <= req.issuedAt ||
      req.expiresAt - req.issuedAt > MAX_LIFETIME_MS || req.issuedAt > now || (!allowExpired && req.expiresAt <= now)) throw new ProtocolError("Request binding or expiry rejected.");
  return req;
}
export function makeRequest(input: Omit<Request, "version" | "payloadDigest">, key: KeyObject): SignedRequest {
  validateOperation(input.operation);
  return seal("request", { version: 1, ...input, payloadDigest: digest(input.operation) }, key);
}
export function verifyReceipt(signed: Signed<Receipt>, key: KeyObject, req: Request): Receipt {
  const receipt = open("receipt", signed, key);
  if (receipt.version !== 1 || receipt.operationId !== req.operationId || receipt.caller !== req.caller ||
      receipt.account !== req.account || receipt.requestDigest !== digest(req) ||
      !["not-dispatched", "dispatched", "succeeded", "failed", "unknown"].includes(receipt.state) ||
      !Number.isSafeInteger(receipt.updatedAt)) throw new ProtocolError("Receipt binding rejected.");
  return receipt;
}
