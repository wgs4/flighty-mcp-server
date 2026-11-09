import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { vi } from "vitest";
import { PrivateStore } from "../src/remote/store.js";
import { MacExecutor, type CredentialContext, type ExecutorDeps } from "../src/remote/executor.js";
import { makeRequest, type Callers, type Operation, type SignedRequest } from "../src/remote/protocol.js";
import { loadRuntimePolicy } from "../src/services/policy.js";
import type { RemovalLocalRecord } from "../src/services/database.js";
import type { WriteDatabase } from "../src/tools/write.js";

export const FLIGHT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const AIRLINE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const all = ["add", "follow", "remove-preview", "remove-confirm", "request-snapshot"] as const;
export function fixture() {
  const root = resolve(".cache/remote-tests"); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(root + "/case-"); chmodSync(dir, 0o700);
  const caller = generateKeyPairSync("ed25519"), mac = generateKeyPairSync("ed25519"), other = generateKeyPairSync("ed25519");
  const callers: Callers = { linux: { publicKey: caller.publicKey, account: "synthetic-account", capabilities: all },
    other: { publicKey: other.publicKey, account: "synthetic-account", capabilities: all } };
  let now = 1_800_000_000_000, sequence = 0;
  let context: CredentialContext | null = { account: "synthetic-account", session: "synthetic-session", authToken: "SYNTHETIC-LOGIN-SECRET",
    buildToken: "SYNTHETIC-BUILD-SECRET", syncUrl: "https://sync.flightyapp.com/synthetic?secret=SYNTHETIC-SYNC-SECRET" };
  let record: RemovalLocalRecord | null = null;
  const db: WriteDatabase = {
    lookupAirlines: vi.fn(() => [{ id: AIRLINE, iata: "UA", name: "Synthetic Air" }]),
    getRemovalFlight: vi.fn(() => record),
  };
  const api = { searchFlight: vi.fn(async () => FLIGHT as string | null), subscribeFlight: vi.fn(async (_id: string) => {}),
    followFlight: vi.fn(async (_id: string) => {}), deleteFlight: vi.fn(async (_id: string) => {}) };
  const stores: PrivateStore[] = [];
  const storeAt = (name: string, maxRows?: number) => { const store = new PrivateStore({ path: resolve(dir, name + ".sqlite"), checkLocation: () => {}, maxRows }); stores.push(store); return store; };
  let store = storeAt("mac");
  const deps: ExecutorDeps = { store, callers, receiptKey: mac.privateKey, bindingKey: Buffer.alloc(32, 7),
    captureContext: vi.fn(async () => context), createApi: vi.fn(() => api), openDatabase: vi.fn(() => ({ db, removalCandidates: () => record ? [record] : [], close: vi.fn() })),
    checkSource: vi.fn(), requestSnapshot: vi.fn(async () => ({ snapshotId: "synthetic-snapshot" })), policy: loadRuntimePolicy({}), now: () => now };
  let executor = new MacExecutor(deps);
  const request = (operation: Operation, overrides: Partial<SignedRequest["body"]> = {}) => makeRequest({ operationId: "op-" + ++sequence,
    caller: "linux", account: "synthetic-account", issuedAt: now, expiresAt: now + 300_000, operation, ...overrides }, caller.privateKey);
  return {
    dir, caller, mac, other, callers, db, api, deps, storeAt, request,
    get executor() { return executor; }, get store() { return store; }, get now() { return now; },
    set now(value: number) { now = value; }, get context() { return context; }, set context(value) { context = value; },
    set record(value: RemovalLocalRecord | null) { record = value; },
    restart() { store.close(); store = storeAt("mac"); deps.store = store; executor = new MacExecutor(deps); return executor; },
    close() { for (const s of stores) s.close(); },
    local() { return { flight: { id: FLIGHT, flight_number: "UA194", airline_iata: "UA", departure_airport_iata: "AAA", arrival_airport_iata: "BBB",
      departureScheduleGateOriginal: "2027-01-01T12:00:00Z", seat_number: "1A", booking_reference: "SYNTHETIC" }, record: "passenger",
      identity: { userId: "synthetic-account", source: "jwt_subject", label: "signed_in_owner", isFallback: false, isSharedOwner: false } } as RemovalLocalRecord; },
  };
}
export type Fixture = ReturnType<typeof fixture>;
