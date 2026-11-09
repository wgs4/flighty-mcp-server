import {
  FLIGHTY_API_BASE,
  FLIGHTY_USER_AGENT,
  getFlightyBuildToken,
} from "../constants.js";
import { readFlightyAuthToken } from "./auth-token.js";
import { readFlightySyncUrl } from "./sync-token.js";
import { assertFlightNumber, assertIsoDate, assertUuid } from "./bounds.js";
import {
  assertAllowedSyncUrl,
  assertWritesEnabled,
  loadRuntimePolicy,
  type RuntimePolicy,
} from "./policy.js";

export const REQUEST_TIMEOUT_MS = 15_000;
export const MAX_SEARCH_BODY_BYTES = 1024 * 1024;

export class RequestSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestSafetyError";
  }
}

export type FlightyApiOptions = {
  policy?: RuntimePolicy;
  fetchImpl?: typeof fetch;
  readAuthToken?: () => string | null;
  readSyncUrl?: () => string | null;
  getBuildToken?: () => string;
};

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  while (value > 0x7f) {
    bytes.push(0x80 | (value & 0x7f));
    value >>>= 7;
  }
  bytes.push(value & 0x7f);
  return Buffer.from(bytes);
}

function encodeStringField(fieldNum: number, value: string): Buffer {
  const tag = encodeVarint((fieldNum << 3) | 2);
  const data = Buffer.from(value, "utf-8");
  const len = encodeVarint(data.length);
  return Buffer.concat([tag, len, data]);
}

function encodeVarintField(fieldNum: number, value: number): Buffer {
  const tag = encodeVarint((fieldNum << 3) | 0);
  return Buffer.concat([tag, encodeVarint(value)]);
}

function encodeMessageField(fieldNum: number, data: Buffer): Buffer {
  const tag = encodeVarint((fieldNum << 3) | 2);
  const len = encodeVarint(data.length);
  return Buffer.concat([tag, len, data]);
}

export function sanitizeFetchError(error: unknown): Error {
  if (error instanceof RequestSafetyError) return error;
  if (isTimeoutError(error)) {
    return new RequestSafetyError("Flighty request timed out.");
  }
  return new RequestSafetyError(
    "Flighty request failed before a response was accepted."
  );
}

function timeoutReason(): Error {
  const error = new Error("The operation timed out.");
  error.name = "TimeoutError";
  return error;
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  if (name === "TimeoutError" || name === "AbortError") return true;
  return "cause" in error ? isTimeoutError(error.cause) : false;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup is best effort and must never delay an error or deadline.
  }
}

async function readBounded(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared) || Number(declared) > maxBytes) {
      void cancelBody(response);
      throw new RequestSafetyError("Flighty response exceeded the size limit.");
    }
  }
  if (!response.body) {
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > maxBytes) {
      throw new RequestSafetyError("Flighty response exceeded the size limit.");
    }
    return data;
  }
  const reader = response.body.getReader();
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancelReader, { once: true });
  if (signal.aborted) cancelReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new RequestSafetyError("Flighty response exceeded the size limit.");
      }
      chunks.push(value);
    }
  } catch (error) {
    cancelReader();
    if (error instanceof RequestSafetyError) throw error;
    throw sanitizeFetchError(error);
  } finally {
    signal.removeEventListener("abort", cancelReader);
    try {
      reader.releaseLock();
    } catch {
      // cancel may already have released the reader.
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

function safeStatus(status: number): number {
  if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  return 0;
}

function withFastFlightSync(syncUrl: string): string {
  const hashAt = syncUrl.indexOf("#");
  const beforeHash = hashAt === -1 ? syncUrl : syncUrl.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : syncUrl.slice(hashAt);
  const next = beforeHash.includes("?")
    ? `${beforeHash}&fast_flight_sync=true`
    : `${beforeHash}?fast_flight_sync=true`;
  return next + hash;
}

export class FlightyApi {
  private jwt: string | null = null;
  private readonly policy: RuntimePolicy;
  private readonly fetchImpl: typeof fetch;
  private readonly readAuthToken: () => string | null;
  private readonly readSyncUrl: () => string | null;
  private readonly getBuildToken: () => string;

  constructor(options: FlightyApiOptions = {}) {
    this.policy = options.policy ?? loadRuntimePolicy();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.readAuthToken = options.readAuthToken ?? readFlightyAuthToken;
    this.readSyncUrl = options.readSyncUrl ?? (() => readFlightySyncUrl());
    this.getBuildToken = options.getBuildToken ?? (() => getFlightyBuildToken());
  }

  private getJwt(): string {
    if (this.jwt) return this.jwt;
    const token = this.readAuthToken();
    if (!token) {
      throw new RequestSafetyError(
        "Could not read the Flighty auth token. Is the Flighty app installed and logged in? If you just signed in, give the app a moment to persist the session."
      );
    }
    this.jwt = token;
    return this.jwt;
  }

  private getHeaders(): Record<string, string> {
    const buildToken = this.getBuildToken();
    if (!buildToken) {
      throw new RequestSafetyError(
        "Could not read the Flighty build token. Is the Flighty app installed?"
      );
    }
    return {
      Authorization: `Bearer ${this.getJwt()}`,
      "x-flighty-build-token": buildToken,
      "Content-Type": "application/x-protobuf",
      Accept: "application/x-protobuf",
      "user-agent": FLIGHTY_USER_AGENT,
      "x-flighty-locale": "en_US",
    };
  }

  private async send<T>(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: Buffer },
    accept: (response: Response, signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new RequestSafetyError("Flighty request timed out."));
        controller.abort(timeoutReason());
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
    });
    const operation = async () => {
      const response = await this.fetchImpl(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        redirect: "error",
        signal: controller.signal,
      });
      // A mock or transport may ignore abort and deliver late headers.
      if (controller.signal.aborted) {
        void cancelBody(response);
        throw new RequestSafetyError("Flighty request timed out.");
      }
      const cancel = () => { void cancelBody(response); };
      controller.signal.addEventListener("abort", cancel, { once: true });
      try {
        const result = await accept(response, controller.signal);
        // Successful cleanup shares the same deadline; error cleanup never blocks.
        await cancelBody(response);
        return result;
      } finally {
        controller.signal.removeEventListener("abort", cancel);
        void cancelBody(response);
      }
    };
    try {
      return await Promise.race([operation(), deadline]);
    } catch (error) {
      throw sanitizeFetchError(error);
    } finally {
      clearTimeout(timer);
    }
  }

  private async rejectHttpError(
    response: Response,
    action: "search" | "subscribe" | "follow" | "delete"
  ): Promise<void> {
    if (response.status >= 300 && response.status < 400) {
      void cancelBody(response);
      throw new RequestSafetyError("Flighty refused to follow a redirect.");
    }
    if (!response.ok) {
      void cancelBody(response);
      throw new RequestSafetyError(
        `Flighty ${action} failed (HTTP ${safeStatus(response.status)}).`
      );
    }
  }

  async searchFlight(
    airlineUuid: string,
    flightNumber: string,
    date: string
  ): Promise<string | null> {
    assertWritesEnabled(this.policy);
    const airline = assertUuid(airlineUuid, "Airline id");
    const number = assertFlightNumber(flightNumber);
    const departure = assertIsoDate(date);
    const url = `${FLIGHTY_API_BASE}/v1/search`;
    assertAllowedSyncUrl(url, this.policy.extraSyncHosts);
    const innerMsg = Buffer.concat([
      encodeStringField(1, airline),
      encodeStringField(2, number),
    ]);
    const body = Buffer.concat([
      encodeMessageField(1, innerMsg),
      encodeStringField(3, departure),
      encodeStringField(4, "FLIGHT_NUMBER"),
    ]);
    return this.send(url, {
      method: "POST",
      headers: this.getHeaders(),
      body,
    }, async (response, signal) => {
      await this.rejectHttpError(response, "search");
      const data = await readBounded(response, MAX_SEARCH_BODY_BYTES, signal);
      return this.extractFlightUuid(data);
    });
  }

  async subscribeFlight(serverFlightUuid: string): Promise<void> {
    await this.postSubscription(serverFlightUuid, true);
  }

  async followFlight(serverFlightUuid: string): Promise<void> {
    await this.postSubscription(serverFlightUuid, false);
  }

  private async postSubscription(
    serverFlightUuid: string,
    isPassenger: boolean
  ): Promise<void> {
    assertWritesEnabled(this.policy);
    const flightId = assertUuid(serverFlightUuid, "Flight id");
    const flag = isPassenger ? "true" : "false";
    const url = `${FLIGHTY_API_BASE}/v1/flight/${flightId}/subscribe?is_passenger=${flag}&source`;
    assertAllowedSyncUrl(url, this.policy.extraSyncHosts);
    await this.send(url, {
      method: "POST",
      headers: {
        ...this.getHeaders(),
        "content-length": "0",
      },
    }, async (response) => {
      await this.rejectHttpError(response, isPassenger ? "subscribe" : "follow");
    });
  }

  async deleteFlight(flightUuid: string): Promise<void> {
    assertWritesEnabled(this.policy);
    const flightId = assertUuid(flightUuid, "Flight id");
    const syncUrl = this.readSyncUrl();
    if (!syncUrl) {
      throw new RequestSafetyError(
        "Could not read the Flighty sync token. Is the Flighty app installed?"
      );
    }
    assertAllowedSyncUrl(syncUrl, this.policy.extraSyncHosts);
    const tsMsg = Buffer.concat([
      encodeVarintField(1, Math.floor(Date.now() / 1000)),
      encodeVarintField(2, Math.floor(Math.random() * 1000000000)),
    ]);
    const delMsg = encodeStringField(1, flightId);
    const entryMsg = Buffer.concat([
      encodeMessageField(1, tsMsg),
      encodeMessageField(11, delMsg),
    ]);
    const body = encodeMessageField(1, entryMsg);
    await this.send(withFastFlightSync(syncUrl), {
      method: "POST",
      headers: this.getHeaders(),
      body,
    }, async (response) => {
      await this.rejectHttpError(response, "delete");
    });
  }

  private extractFlightUuid(data: Buffer): string | null {
    const str = data.toString("utf-8");
    const match = str.match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/
    );
    return match ? match[1] : null;
  }
}

export function parseFlightCode(flightCode: string): {
  airlineIata: string;
  flightNumber: string;
} {
  if (typeof flightCode !== "string" || flightCode.trim().length > 20) {
    throw new Error(
      "Invalid flight code. Expected format like 'UA194' or 'BA930'."
    );
  }
  const code = flightCode.trim().toUpperCase().replace(/[-\s]/g, "");
  const match = code.match(/^([A-Z]{2}|\d[A-Z]|[A-Z]\d)(\d+)$/);
  if (!match) {
    throw new Error(
      `Invalid flight code '${flightCode.trim()}'. Expected format like 'UA194' or 'BA930'.`
    );
  }
  return { airlineIata: match[1], flightNumber: match[2] };
}
