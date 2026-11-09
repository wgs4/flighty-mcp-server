import { createHash, randomBytes } from "node:crypto";

export const REMOVAL_TTL_MS = 5 * 60 * 1000;
export const MAX_PENDING_REMOVALS = 32;
export const CONFIRM_CODE_LENGTH = 8;

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

if (ALPHABET.length !== 32) {
  throw new Error("Confirm code alphabet must be 32 characters.");
}

export type RemovalPreview = Readonly<Record<string, unknown>>;

export type ConsumeReason =
  | "missing"
  | "expired"
  | "wrong-id"
  | "preview-changed"
  | "replay";

export type ConsumeResult = { ok: true } | { ok: false; reason: ConsumeReason };

type Entry = {
  code: string;
  flightId: string;
  previewHash: string;
  expiresAt: number;
};

export function previewHash(preview: RemovalPreview): string {
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(preview).sort()) {
    normalized[key] = preview[key];
  }
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function generateConfirmCode(bytes: Buffer): string {
  if (bytes.length < CONFIRM_CODE_LENGTH) {
    throw new Error("Could not allocate a confirm code.");
  }
  let code = "";
  for (let index = 0; index < CONFIRM_CODE_LENGTH; index += 1) {
    code += ALPHABET[bytes[index] & 31];
  }
  return code;
}

export class RemovalConfirmStore {
  private readonly byCode = new Map<string, Entry>();
  private readonly byFlight = new Map<string, string>();
  private readonly order: string[] = [];
  private readonly used = new Set<string>();
  private readonly usedOrder: string[] = [];
  private readonly now: () => number;
  private readonly nextBytes: (size: number) => Buffer;
  private readonly maxPending: number;
  private readonly ttlMs: number;

  constructor(options?: {
    now?: () => number;
    randomBytes?: (size: number) => Buffer;
    maxPending?: number;
    ttlMs?: number;
  }) {
    this.now = options?.now ?? Date.now;
    this.nextBytes = options?.randomBytes ?? randomBytes;
    this.maxPending = options?.maxPending ?? MAX_PENDING_REMOVALS;
    this.ttlMs = options?.ttlMs ?? REMOVAL_TTL_MS;
  }

  get size(): number {
    return this.byCode.size;
  }

  issue(
    flightId: string,
    preview: RemovalPreview
  ): { code: string; expiresInSeconds: number } {
    this.evictExpired(this.now());
    const previous = this.byFlight.get(flightId);
    if (previous) this.deleteCode(previous);
    while (this.byCode.size >= this.maxPending && this.order.length > 0) {
      this.deleteCode(this.order[0]);
    }
    const code = this.allocateCode();
    const entry: Entry = {
      code,
      flightId,
      previewHash: previewHash(preview),
      expiresAt: this.now() + this.ttlMs,
    };
    this.byCode.set(code, entry);
    this.byFlight.set(flightId, code);
    this.order.push(code);
    return { code, expiresInSeconds: Math.floor(this.ttlMs / 1000) };
  }

  consume(code: string, flightId: string, preview: RemovalPreview): ConsumeResult {
    const entry = this.byCode.get(code);
    if (!entry) {
      return { ok: false, reason: this.used.has(code) ? "replay" : "missing" };
    }
    if (entry.expiresAt <= this.now()) {
      this.deleteCode(code);
      this.rememberUsed(code);
      return { ok: false, reason: "expired" };
    }
    if (entry.flightId !== flightId) {
      return { ok: false, reason: "wrong-id" };
    }
    if (entry.previewHash !== previewHash(preview)) {
      this.deleteCode(code);
      this.rememberUsed(code);
      return { ok: false, reason: "preview-changed" };
    }
    this.deleteCode(code);
    this.rememberUsed(code);
    return { ok: true };
  }

  private allocateCode(): string {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generateConfirmCode(this.nextBytes(CONFIRM_CODE_LENGTH));
      if (!this.byCode.has(code) && !this.used.has(code)) return code;
    }
    throw new Error("Could not allocate a confirm code.");
  }

  private evictExpired(now: number): void {
    for (const code of [...this.order]) {
      const entry = this.byCode.get(code);
      if (!entry || entry.expiresAt <= now) this.deleteCode(code);
    }
  }

  private rememberUsed(code: string): void {
    if (this.used.has(code)) return;
    this.used.add(code);
    this.usedOrder.push(code);
    while (this.usedOrder.length > this.maxPending) {
      const oldest = this.usedOrder.shift();
      if (oldest) this.used.delete(oldest);
    }
  }

  private deleteCode(code: string): void {
    const entry = this.byCode.get(code);
    if (!entry) {
      const index = this.order.indexOf(code);
      if (index >= 0) this.order.splice(index, 1);
      return;
    }
    this.byCode.delete(code);
    if (this.byFlight.get(entry.flightId) === code) {
      this.byFlight.delete(entry.flightId);
    }
    const index = this.order.indexOf(code);
    if (index >= 0) this.order.splice(index, 1);
  }
}
