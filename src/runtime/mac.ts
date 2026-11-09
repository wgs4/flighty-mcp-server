import { createHash, createHmac, createPublicKey } from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { lstatSync } from "node:fs";
import { join, dirname } from "node:path";
import { readFlightyAuthToken, readJwtSubject } from "../services/auth-token.js";
import { readFlightySyncUrl, readLegacySyncUrl } from "../services/sync-token.js";
import { FlightyDatabase, type OwnerIdentity } from "../services/database.js";
import { assertAllowedSyncUrl, loadRuntimePolicy, type RuntimePolicy } from "../services/policy.js";
import { capturedApiFactory, MacExecutor, type CredentialContext, type ExecutorDeps } from "../remote/executor.js";
import { PrivateStore, type StoreOptions, type StateRow } from "../remote/store.js";
import { executorStateValidator } from "../remote/state.js";
import { ProtocolError } from "../remote/protocol.js";
import { exportReplicaBundle } from "../replica/exporter.js";
import { withSqliteBudget } from "../replica/work.js";
import { assertNoSymlinkChain, assertPrivatePath, assertRegularFileNoSymlink, measureStorageGroups } from "../replica/cleanup.js";
import { checkStorage, callersFor, privateKey, privateRead, publicKey, storageAuthority, type MacConfig } from "./config.js";

export function checkMacSource(config: MacConfig): void {
  checkStorage(config, [config.transferParent, config.rawQuarantine]);
  const source = config.source;
  // These checks run before credentials/plutil/export. No guessed source paths or fallback mount.
  for (const path of [source.dbPath, source.authDbPath, source.prefsPlistPath, source.infoPlistPath, source.sessionPath]) {
    assertNoSymlinkChain(path, "configured Mac source"); assertRegularFileNoSymlink(path, "configured Mac source");
    if (path !== source.infoPlistPath) assertPrivatePath(path, dirname(path));
    const st = lstatSync(path);
    if (st.dev !== source.device || st.size > (path === source.dbPath ? config.budget.maxDbBytes : 1024 * 1024)) throw new ProtocolError("Configured Mac source identity/size unavailable.");
  }
  if (lstatSync(source.dbPath).ino !== source.dbInode) throw new ProtocolError("Mac source database identity changed; explicit revalidation required.");
  privateRead(source.sessionPath, 4096);
}
export type MacReaders = {
  token(main: string, legacy: string): string | null;
  subject(token: string): string | null;
  sync(main: string, prefs: string): string | null;
  build(info: string): string;
  session(path: string): Buffer;
};
export function defaultMacReaders(execFileImpl: typeof execFileSync = execFileSync): MacReaders {
  const boundedPlutil = (file: string, args: readonly string[], _options: { encoding: BufferEncoding }) => execFileImpl(file, args, { encoding: "utf8", timeout: 2000, maxBuffer: 16 * 1024, windowsHide: true });
  return { token: readFlightyAuthToken, subject: readJwtSubject,
    sync: (main, prefs) => readFlightySyncUrl(main, () => readLegacySyncUrl(prefs, boundedPlutil)),
    // Deliberately fresh and bounded, bypassing the local default's global build cache.
    build: info => boundedPlutil("/usr/bin/plutil", ["-extract", "FlightyBuildToken", "raw", info], { encoding: "utf8" }).trim(),
    session: path => privateRead(path, 4096) };
}
export function macContextCapture(config: MacConfig, policy: RuntimePolicy, readers: MacReaders = defaultMacReaders()) {
  return async (signal: AbortSignal): Promise<CredentialContext | null> => {
    signal.throwIfAborted(); checkMacSource(config);
    const source = config.source;
    const token = readers.token(source.dbPath, source.authDbPath);
    if (!token || token.length > 16 * 1024) return null;
    const account = readers.subject(token);
    if (!account || account !== config.pins.accountId || account.toLowerCase() !== config.pins.ownerUserId.toLowerCase()) return null;
    const buildToken = readers.build(source.infoPlistPath);
    if (!/^[A-Za-z0-9._-]{1,256}$/.test(buildToken)) return null;
    const syncUrl = readers.sync(source.dbPath, source.prefsPlistPath);
    if (!syncUrl || syncUrl.length > 8192) return null;
    assertAllowedSyncUrl(syncUrl, policy.extraSyncHosts);
    const session = createHmac("sha256", Buffer.from(config.bindingKey, "hex")).update(readers.session(source.sessionPath)).update(token).digest("hex");
    signal.throwIfAborted(); checkMacSource(config);
    return Object.freeze({ account, session, authToken: token, buildToken, syncUrl });
  };
}
export function macDatabase(config: MacConfig, context: CredentialContext) {
  checkMacSource(config);
  if (context.account !== config.pins.accountId) throw new ProtocolError();
  const identity: OwnerIdentity = { userId: context.account, source: "jwt_subject", label: "signed_in_owner", isFallback: false, isSharedOwner: false };
  const db = new FlightyDatabase("", "", () => ({ dbPath: config.source.dbPath, ownerIdentity: identity,
    openDatabase: () => { checkMacSource(config); return new DatabaseSync(config.source.dbPath, { readOnly: true, allowExtension: false }); } }));
  return { db, removalCandidates: (id: string) => db.getRemovalCandidates(id), close() {} };
}
export function sequenceValidator(rows: readonly StateRow[]): void {
  if (rows.length > 1 || rows.some(row => row.kind !== "sequence" || row.id !== "producer" || !row.value ||
    Object.keys(row.value as object).join(",") !== "next" || !Number.isSafeInteger((row.value as { next: number }).next) || (row.value as { next: number }).next < 1)) throw new ProtocolError("Snapshot sequence continuity rejected.");
}
export function macStoreOptions(config: MacConfig): StoreOptions {
  return { ...config.store, authenticationKey: Buffer.from(config.store.authenticationKey, "hex"), checkLocation: () => checkStorage(config),
    validateState: executorStateValidator(callersFor(config), createPublicKey(privateKey(config.receiptPrivateKey)), Date.now, publicKey(config.operatorPublicKey)) };
}
export function sequenceStoreOptions(config: MacConfig): StoreOptions {
  return { ...config.sequenceStore, authenticationKey: Buffer.from(config.sequenceStore.authenticationKey, "hex"),
    checkLocation: () => checkStorage(config), validateState: sequenceValidator };
}
export function provisionMac(config: MacConfig): void {
  checkStorage(config);
  PrivateStore.initialize(macStoreOptions(config));
  PrivateStore.initialize(sequenceStoreOptions(config));
  const sequences = new PrivateStore(sequenceStoreOptions(config));
  try { sequences.put("sequence", "producer", { next: 1 }); } finally { sequences.close(); }
}
/** Compose without reading the source or opening credentials. Explicit one-cycle caller owns lifetime. */
export function openMac(config: MacConfig, options: { fetchImpl: typeof fetch; readers?: MacReaders; policy?: RuntimePolicy;
  upload: (bundleDir: string, signal: AbortSignal) => Promise<void>; signal?: AbortSignal }) {
  const policy = options.policy ?? loadRuntimePolicy();
  checkStorage(config);
  const store = new PrivateStore(macStoreOptions(config));
  let sequence: PrivateStore;
  try { sequence = new PrivateStore(sequenceStoreOptions(config)); }
  catch (error) { store.close(); throw error; }
  const captureCurrent = macContextCapture(config, policy, options.readers);
  const captureContext = (signal: AbortSignal) => captureCurrent(options.signal ? AbortSignal.any([signal, options.signal]) : signal);
  const snapshot = async (context: CredentialContext, signal: AbortSignal) => {
    signal = options.signal ? AbortSignal.any([signal, options.signal]) : signal;
    const deadline = performance.now() + 14_000;
    checkMacSource(config); signal.throwIfAborted();
    const current = await captureContext(signal);
    if (!current || JSON.stringify(current) !== JSON.stringify(context)) throw new ProtocolError("Mac context changed before snapshot.");
    let next = 0;
    sequence.transaction(() => {
      const value = sequence.get<{ next: number }>("sequence", "producer");
      if (!value || !Number.isSafeInteger(value.next + 1)) throw new ProtocolError("Snapshot sequence unavailable. No reset.");
      next = value.next; sequence.put("sequence", "producer", { next: next + 1 });
    });
    // Burn sequence durably BEFORE export, including failures/crashes; gaps are safe, reuse is not.
    measureStorageGroups([config.transferParent, config.rawQuarantine], config.budget, config.budget.maxDbBytes * 3, 8);
    const bundle = await withSqliteBudget(Math.min(14_000, config.budget.acceptanceMs), Math.min(14_000, config.budget.sqliteTaskMs), () => exportReplicaBundle({
      sourceDbPath: config.source.dbPath, outputBundleDir: join(config.transferParent, `copy-e${config.pins.epoch}-s${next}`),
      quarantineDir: config.rawQuarantine, storage: storageAuthority(config), storageBudget: config.budget,
      requiredMountPath: config.storage.mountPath, producerId: config.pins.producerId,
      accountId: context.account, ownerUserId: context.account, epoch: config.pins.epoch, sequence: next,
      signingPrivateKey: privateKey(config.snapshotPrivateKey), approvedSourceDbPath: config.source.dbPath, limits: { maxDbBytes: config.budget.maxDbBytes, maxOperationDurationMs: config.budget.sqliteTaskMs } }));
    if (performance.now() >= deadline) throw new ProtocolError("Snapshot preparation budget exceeded. No upload.");
    const after = await captureContext(signal);
    if (!after || JSON.stringify(after) !== JSON.stringify(context)) throw new ProtocolError("Mac context changed during snapshot. No upload.");
    signal.throwIfAborted(); await options.upload(bundle.bundleDir, signal); signal.throwIfAborted();
    return { snapshotId: createHash("sha256").update(JSON.stringify([config.pins.producerId, config.pins.epoch, next, bundle.manifest.dbSha256])).digest("hex") };
  };
  const deps: ExecutorDeps = { store, callers: callersFor(config), receiptKey: privateKey(config.receiptPrivateKey),
    operatorKey: publicKey(config.operatorPublicKey), cancellation: options.signal, bindingKey: Buffer.from(config.bindingKey, "hex"), policy,
    captureContext, createApi: capturedApiFactory({ policy, fetchImpl: options.fetchImpl }),
    openDatabase: context => macDatabase(config, context), checkSource: () => checkMacSource(config), requestSnapshot: snapshot };
  let executor: MacExecutor;
  try { executor = new MacExecutor(deps); } catch (error) { sequence.close(); store.close(); throw error; }
  return { executor, captureContext, snapshot, close() { sequence.close(); store.close(); } };
}
