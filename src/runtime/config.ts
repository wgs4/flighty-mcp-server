import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { z } from "zod";
import { ProtocolError, idSchema, type Callers } from "../remote/protocol.js";
import { validateStorage, assertNoSymlinkChain, assertPrivatePath } from "../replica/cleanup.js";
import { REPLICA_SCHEMA_HASH, REPLICA_SCHEMA_VERSION } from "../replica/schema.js";
import type { ReplicaStorageAuthority } from "../replica/types.js";

const path = z.string().min(1).max(1024).refine(p => isAbsolute(p) && resolve(p) === p && !/[\0\r\n]/.test(p));
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const pem = z.string().min(32).max(4096);
const store = z.object({ path, continuityPath: path, identity: idSchema, authenticationKey: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const storage = z.object({ mountPath: path, privateRootDir: path, expectedDevice: positive, mountInode: positive,
  approvedPaths: z.array(path).min(1).max(16) }).strict();
const pins = z.object({ producerId: idSchema, accountId: idSchema, ownerUserId: z.string().uuid(), epoch: positive,
  schemaVersion: z.literal(REPLICA_SCHEMA_VERSION), schemaHash: z.literal(REPLICA_SCHEMA_HASH), publicKey: pem }).strict();
const budget = z.object({ maxBytes: positive.max(2 * 1024 ** 3), maxEntries: positive.max(8192),
  maxDbBytes: positive.max(128 * 1024 ** 2), transportMs: positive.min(100).max(30_000), acceptanceMs: positive.max(90_000), sqliteTaskMs: positive.max(30_000) }).strict();
const caller = z.object({ id: idSchema, account: idSchema, publicKey: pem,
  historicalPublicKeys: z.array(pem).max(16).optional(),
  capabilities: z.array(z.enum(["add", "follow", "remove-preview", "remove-confirm", "request-snapshot"])).max(5) }).strict();
export const linuxConfigSchema = z.object({ version: z.literal(1), kind: z.literal("linux"), storage, pins, budget, retirementCommand: path.optional(),
  receiverRoot: path, inbox: path, quarantine: path, socketPath: path, store, clientStore: store,
  caller: caller.extend({ privateKey: pem }), macReceiptKey: pem, operatorPublicKey: pem.optional() }).strict();
export const macConfigSchema = z.object({ version: z.literal(1), kind: z.literal("mac"), storage, pins, budget, retirementCommand: path.optional(),
  store, sequenceStore: store, operatorPublicKey: pem, receiptPrivateKey: pem, bindingKey: z.string().regex(/^[a-f0-9]{64}$/),
  snapshotPrivateKey: pem, callers: z.array(caller).min(1).max(8),
  source: z.object({ dbPath: path, authDbPath: path, prefsPlistPath: path, infoPlistPath: path,
    device: positive, dbInode: positive, sessionPath: path }).strict(),
  transferParent: path, rawQuarantine: path,
  ssh: z.object({ enabled: z.literal(true), host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/), port: z.literal(23500),
    user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/), identityFile: path, knownHostsFile: path }).strict(),
}).strict();
export type LinuxConfig = z.infer<typeof linuxConfigSchema>;
export type MacConfig = z.infer<typeof macConfigSchema>;
export type Config = LinuxConfig | MacConfig;
export function runtimeMode(env: NodeJS.ProcessEnv = process.env): "local" | "replica" {
  const mode = env.FLIGHTY_RUNTIME_MODE ?? "local";
  if (mode !== "local" && mode !== "replica") throw new ProtocolError("FLIGHTY_RUNTIME_MODE must be local or replica.");
  return mode;
}
export function privateRead(path: string, max = 64 * 1024): Buffer {
  if (!isAbsolute(path) || resolve(path) !== path) throw new ProtocolError("Explicit absolute configuration path required.");
  assertNoSymlinkChain(path, "configuration");
  assertPrivatePath(path, dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > max) throw new ProtocolError("Private configuration size/type rejected.");
    const bytes = readFileSync(fd);
    if (bytes.length !== info.size || bytes.length > max) throw new ProtocolError();
    return bytes;
  } finally { closeSync(fd); }
}
export function readConfig(file: string | undefined, kind: "linux"): LinuxConfig;
export function readConfig(file: string | undefined, kind: "mac"): MacConfig;
export function readConfig(file: string | undefined, kind: "linux" | "mac"): Config {
  try {
    if (!file) throw new ProtocolError();
    const input = JSON.parse(privateRead(file).toString("utf8"));
    const config = kind === "linux" ? linuxConfigSchema.parse(input) : macConfigSchema.parse(input);
    validateConfig(config);
    if (artifactRoots(config).some(root => file === root || file.startsWith(root + "/"))) throw new ProtocolError("Configuration cannot be stored in retireable application artifacts.");
    return config;
  } catch { throw new ProtocolError("Runtime configuration unavailable or invalid. Explicit private approved configuration required."); }
}
export function publicKey(pem: string): KeyObject {
  if (!/^-----BEGIN PUBLIC KEY-----\r?\n/.test(pem)) throw new ProtocolError("Public verification fields must not contain private keys.");
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new ProtocolError();
  return key;
}
export function privateKey(pem: string): KeyObject {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new ProtocolError();
  return key;
}
export function sameKey(a: KeyObject, b: KeyObject): boolean {
  return a.export({ type: "spki", format: "der" }).equals(b.export({ type: "spki", format: "der" }));
}
export function storageAuthority(config: Config): ReplicaStorageAuthority {
  const s = config.storage;
  return { ...s, validateMount: p => {
    const st = lstatSync(p);
    return st.isDirectory() && st.dev === s.expectedDevice && st.ino === s.mountInode;
  } };
}
export function checkStorage(config: Config, paths: string[] = []): void {
  validateStorage(storageAuthority(config), paths, false);
}
export function callersFor(config: Config): Callers {
  const callers = config.kind === "linux" ? [config.caller] : config.callers;
  return Object.fromEntries(callers.map(c => [c.id, { account: c.account, capabilities: [...c.capabilities], historicalPublicKeys: (c.historicalPublicKeys ?? []).map(publicKey), publicKey: publicKey(c.publicKey) }]));
}
export function artifactRoots(config: Config): string[] {
  const specs = config.kind === "linux" ? [config.store, config.clientStore] : [config.store, config.sequenceStore];
  return [...(config.kind === "linux" ? [config.receiverRoot, config.inbox, config.quarantine] : [config.transferParent, config.rawQuarantine]),
    ...specs.flatMap(s => [s.path + ".archive", s.continuityPath + ".recovery"])];
}
export function validateConfig(config: Config): void {
  const paths = config.kind === "linux" ? [config.receiverRoot, config.inbox, config.quarantine, dirname(config.socketPath), dirname(config.store.path), dirname(config.store.continuityPath), dirname(config.clientStore.path), dirname(config.clientStore.continuityPath)] :
    [config.transferParent, config.rawQuarantine, dirname(config.store.path), dirname(config.store.continuityPath), dirname(config.sequenceStore.path), dirname(config.sequenceStore.continuityPath)];
  checkStorage(config, paths);
  publicKey(config.pins.publicKey);
  if (config.budget.sqliteTaskMs > config.budget.acceptanceMs) throw new ProtocolError();
  const dirs = config.kind === "linux" ? [config.receiverRoot, config.inbox, config.quarantine] : [config.transferParent, config.rawQuarantine];
  if (dirs.some((a, i) => dirs.some((b, j) => i !== j && (a === b || a.startsWith(b + "/"))))) throw new ProtocolError("Runtime storage roles must be disjoint.");
  const privateFiles = config.kind === "linux" ? [config.store.path, config.store.continuityPath, config.clientStore.path, config.clientStore.continuityPath, config.socketPath] : [config.store.path, config.store.continuityPath, config.sequenceStore.path, config.sequenceStore.continuityPath];
  if (new Set(privateFiles).size !== privateFiles.length || privateFiles.some(p => dirs.some(d => p === d || p.startsWith(d + "/")))) throw new ProtocolError();
  const artifacts = artifactRoots(config);
  if (artifacts.some((a, i) => artifacts.some((b, j) => i !== j && (a === b || a.startsWith(b + "/")))) || privateFiles.some(p => artifacts.some(root => p === root || p.startsWith(root + "/")))) throw new ProtocolError("Artifact and authority paths must be disjoint.");
  checkStorage(config, artifacts);
  if (config.kind === "mac" && Object.entries(config.source).some(([name, p]) => name.endsWith("Path") && typeof p === "string" && artifacts.some(root => p === root || p.startsWith(root + "/")))) throw new ProtocolError("Source files cannot live in retireable artifact storage.");
  const callers = config.kind === "linux" ? [config.caller] : config.callers;
  if (new Set(callers.map(c => c.id)).size !== callers.length || callers.some(c => c.account !== config.pins.accountId)) throw new ProtocolError();
  callersFor(config);
  if (config.operatorPublicKey) {
    const operator = publicKey(config.operatorPublicKey);
    const forbidden = [config.pins.publicKey, ...(config.kind === "linux" ? [config.macReceiptKey] : [createPublicKey(privateKey(config.receiptPrivateKey)).export({ type: "spki", format: "pem" }).toString()]),
      ...callers.flatMap(c => [c.publicKey, ...(c.historicalPublicKeys ?? [])])];
    if (forbidden.some(pem => sameKey(operator, publicKey(pem)))) throw new ProtocolError("Operator authority must be independent of application/caller keys.");
  }
  if (config.kind === "linux") {
    if (config.caller.account !== config.pins.accountId || !sameKey(createPublicKey(privateKey(config.caller.privateKey)), publicKey(config.caller.publicKey))) throw new ProtocolError();
    publicKey(config.macReceiptKey);
    if (Buffer.byteLength(config.socketPath) > 100) throw new ProtocolError("Socket path too long.");
    const override = process.env.FLIGHTY_OWNER_USER_ID;
    if (override && override.toLowerCase() !== config.pins.ownerUserId.toLowerCase()) throw new ProtocolError();
  } else {
    publicKey(config.operatorPublicKey); privateKey(config.receiptPrivateKey);
    if (!sameKey(createPublicKey(privateKey(config.snapshotPrivateKey)), publicKey(config.pins.publicKey))) throw new ProtocolError();
    if (config.rawQuarantine === config.transferParent || config.rawQuarantine.startsWith(config.transferParent + "/")) throw new ProtocolError();
    if ([config.store.path, config.store.continuityPath, config.sequenceStore.path, config.sequenceStore.continuityPath].some((p, i, all) => all.indexOf(p) !== i)) throw new ProtocolError();
  }
  // Configuration never creates directories, keys, state, or source handles.

}
