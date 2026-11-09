import { randomUUID, type KeyObject } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWriteToolFacade, type WriteToolResult } from "../tools/write.js";
import { assertWritesEnabled, type RuntimePolicy } from "../services/policy.js";
import { boundedJson, makeRequest, parseWire, ProtocolError, verifyReceipt, type Operation, type Receipt, type Signed, type SignedRequest } from "./protocol.js";
import { sanitizeReceiptError } from "./redaction.js";
import type { MailboxStatus, MailboxTransport } from "./mailbox.js";

/** Retain the same signed request/operation ID through disconnects; never silently create a retry. */
export class RemoteClient {
  constructor(private readonly options: {
    caller: string; account: string; signingKey: KeyObject; macReceiptKey: KeyObject;
    transport: MailboxTransport; now?: () => number;
  }) {}
  prepare(operation: Operation, operationId = randomUUID()): SignedRequest {
    const now = this.options.now?.() ?? Date.now();
    return makeRequest({ caller: this.options.caller, account: this.options.account, operationId,
      issuedAt: now, expiresAt: now + 300_000, operation }, this.options.signingKey);
  }
  submit(request: SignedRequest): Promise<MailboxStatus> { return this.exchange("submit", request); }
  status(request: SignedRequest): Promise<MailboxStatus> { return this.exchange("status", request); }
  private async exchange(verb: "submit" | "status", request: SignedRequest): Promise<MailboxStatus> {
    const result = parseWire(await this.options.transport(boundedJson({ verb, request }))) as MailboxStatus;
    if (!result || typeof result !== "object" || !["queued", "leased", "expired", "receipted", "absent"].includes(result.queue) ||
        !(result.receipt === null || (typeof result.receipt === "object" && result.receipt))) throw new ProtocolError("Mailbox status rejected.");
    if (result.receipt) verifyReceipt(result.receipt, this.options.macReceiptKey, request.body);
    if ((result.queue === "receipted") !== !!result.receipt) throw new ProtocolError();
    return result;
  }
}

/** Exact existing public schemas/descriptions, with a typed remote handler instead of SDK interception. */
export function registerRemoteWriteTools(server: McpServer, options: {
  client: RemoteClient; policy: RuntimePolicy;
  /** Integration must durably remember this before submit, then wait boundedly or expose status. */
  rememberRequest: (request: SignedRequest) => Promise<void>;
  waitForReceipt?: (request: SignedRequest) => Promise<Signed<Receipt> | null>;
  macReceiptKey: KeyObject;
}): void {
  const call = async (operation: Operation): Promise<WriteToolResult> => {
    let request: SignedRequest | undefined;
    const text = (value: unknown, isError = false): WriteToolResult => ({ content: [{ type: "text", text: boundedJson(value) }], ...(isError ? { isError: true } : {}) });
    try {
      assertWritesEnabled(options.policy);
      request = options.client.prepare(operation);
      await options.rememberRequest(request);
      const submitted = await options.client.submit(request);
      const signed = submitted.receipt ?? await options.waitForReceipt?.(request);
      if (!signed) return text({ status: "pending", operation_id: request.body.operationId,
        message: "No terminal Mac receipt yet. Check this operation ID; do not repeat the mutation with a new ID." });
      const receipt = verifyReceipt(signed, options.macReceiptKey, request.body);
      if (["not-dispatched", "dispatched"].includes(receipt.state)) return text({ status: "pending", operation_id: receipt.operationId,
        message: "No terminal Mac receipt yet. Check this operation ID; do not repeat the mutation with a new ID." });
      if (receipt.state === "succeeded") return text(receipt.result);
      return text({ status: receipt.state, operation_id: receipt.operationId, message: sanitizeReceiptError(receipt.error ?? "Outcome has not been established.") }, true);
    } catch {
      return text({ status: "unavailable_or_unknown", ...(request ? { operation_id: request.body.operationId } : {}),
        message: "Remote helper unavailable or request rejected. Inspect the stored operation before any retry." }, true);
    }
  };
  registerWriteToolFacade(server, {
    add: params => call({ kind: "add", ...params }), follow: params => call({ kind: "follow", ...params }),
    remove: params => call(params.confirm_code?.trim() ? { kind: "remove-confirm", flight_id: params.flight_id, confirm_code: params.confirm_code.trim() } : { kind: "remove-preview", flight_id: params.flight_id }),
  });
}
