import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { z } from "zod";
import { PrivateStore, type RetirementMove, type StoreOptions } from "../remote/store.js";
import { verifyAttestation, verifyAudit } from "../remote/recovery.js";
import { callersFor, type LinuxConfig } from "./config.js";
import { verifyClientResolution, type ClientRow } from "./client-state.js";
import { canonical, digest, ProtocolError } from "../remote/protocol.js";
import { linuxStoreOptions, linuxClientStoreOptions, openLinux } from "./linux.js";
import { macStoreOptions, sequenceStoreOptions, openMac } from "./mac.js";
import { checkStorage, validateConfig, publicKey, type Config } from "./config.js";
import { assertNoSymlinkChain, assertPrivatePath } from "../replica/cleanup.js";

export const storeRole = z.enum(["linux-mailbox", "linux-client", "mac-executor", "mac-sequence"]);
export type StoreRole = z.infer<typeof storeRole>;
export function roleOptions(config: Config, role: StoreRole): StoreOptions {
  validateConfig(config);
  if (config.kind === "linux") {
    if (role === "linux-mailbox") return linuxStoreOptions(config);
    if (role === "linux-client") return linuxClientStoreOptions(config);
  } else {
    if (role === "mac-executor") return macStoreOptions(config);
    if (role === "mac-sequence") return sequenceStoreOptions(config);
  }
  throw new ProtocolError("Store role does not belong to this configuration.");
}
export function inspectStore(config: Config, role: StoreRole) {
  if (!config.operatorPublicKey) throw new ProtocolError("Explicit independent operator public key required.");
  return { role, configDigest: digest(config), observation: PrivateStore.inspectContinuity(roleOptions(config, role)) };
}
export function recoverStore(config: Config, role: StoreRole, attestation: unknown): void {
  if (!config.operatorPublicKey) throw new ProtocolError("Explicit independent operator public key required.");
  PrivateStore.recoverContinuity(roleOptions(config, role), attestation,
    { role, configDigest: digest(config), key: publicKey(config.operatorPublicKey) });
}
export function maintain(config: Config): void {
  if (config.kind === "linux") {
    const runtime = openLinux(config); try { runtime.durable.maintenance(); runtime.mailbox.maintenance(); } finally { runtime.close(); }
  } else {
    const runtime = openMac(config, { fetchImpl: async () => { throw new ProtocolError("Maintenance cannot invoke HTTP."); },
      upload: async () => { throw new ProtocolError("Maintenance cannot upload."); } });
    try { runtime.executor.maintenance(); } finally { runtime.close(); }
  }
}
/** Independent operator evidence permits archiving a resolved UNKNOWN; its outcome remains UNKNOWN. */
export function archiveResolvedClient(config: LinuxConfig, input: unknown): void {
  validateConfig(config);
  if (!config.operatorPublicKey) throw new ProtocolError("Independent operator verification required.");
  const key = publicKey(config.operatorPublicKey), signed = verifyAttestation(input, key);
  const store = new PrivateStore(linuxClientStoreOptions(config));
  try {
    store.transaction(() => {
      const row = store.get<ClientRow>("client", signed.body.operationId);
      if (!row || (row.status?.receipt && row.status.receipt.body.state !== "unknown") || row.request.body.expiresAt + 86_400_000 > Date.now()) throw new ProtocolError("Aged unresolved original request required; live work cannot be archived.");
      const audit = { attestation: signed, request: row.request, unknownReceipt: row.status?.receipt ?? null };
      verifyClientResolution(audit, signed.body.auditId, callersFor(config), publicKey(config.macReceiptKey), key);
      store.archive("client", signed.body.operationId); store.delete("client", signed.body.operationId);
      store.put("client-resolution", signed.body.auditId, audit); store.archive("client-resolution", signed.body.auditId); store.delete("client-resolution", signed.body.auditId);
    });
  } finally { store.close(); }
}
/** A failed batch reports completed moves without exposing configured paths. */
export class RetirementError extends ProtocolError {
  constructor(readonly retired: number) { super("Retirement helper or validation stopped the batch; completed moves remain recoverable. Inspect private evidence before retrying."); }
}
class CompletedMoveFailure extends Error {}
function treeSnapshot(config: Config, path: string) {
  let bytes = 0, entries = 0, newest = 0;
  const nodes: { relative: string; directory: boolean }[] = [];
  const identities: unknown[] = [];
  const visit = (target: string, relative: string) => {
    const st = lstatSync(target);
    if (st.isSymbolicLink() || (!st.isDirectory() && (!st.isFile() || st.nlink !== 1)) || st.dev !== config.storage.expectedDevice ||
      (st.mode & 0o077) || (process.getuid && st.uid !== process.getuid())) throw new ProtocolError("Unsafe artifact ownership, device or type.");
    bytes += st.isFile() ? st.size : 0; entries++;
    if (bytes > config.budget.maxBytes || entries > config.budget.maxEntries) throw new ProtocolError("Artifact storage budget exceeded.");
    newest = Math.max(newest, st.mtimeMs);
    nodes.push({ relative, directory: st.isDirectory() });
    identities.push({ relative, dev: st.dev, ino: st.ino, uid: st.uid, mode: st.mode, nlink: st.nlink, size: st.size, mtime: st.mtimeMs, ctime: st.ctimeMs });
    if (st.isDirectory()) for (const name of readdirSync(target).sort()) visit(join(target, name), relative ? relative + "/" + name : name);
  };
  visit(path, ""); return { identity: canonical(identities), nodes, newest };
}
function retirementHelper(config: Config, trash?: (path: string) => void): RetirementMove {
  return (path, validateSelection) => {
    const before = treeSnapshot(config, path);
    const command = config.retirementCommand;
    if (!trash) {
      if (!command || !command.endsWith("/trash")) throw new ProtocolError("Explicit approved recoverable trash helper required.");
      assertNoSymlinkChain(command, "retirement helper");
      for (let parent = dirname(command);; parent = dirname(parent)) {
        const entry = lstatSync(parent);
        if (!entry.isDirectory() || (entry.uid !== 0 && (!process.getuid || entry.uid !== process.getuid())) || ((entry.mode & 0o022) && !(entry.mode & 0o1000))) throw new ProtocolError("Retirement helper ancestors permit replacement.");
        if (dirname(parent) === parent) break;
      }
      const info = lstatSync(command);
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o022) || !(info.mode & 0o111) ||
        (process.getuid && info.uid !== process.getuid() && info.uid !== 0)) throw new ProtocolError("Retirement helper ownership/type rejected.");
    }
    assertNoSymlinkChain(path, "retirement");
    assertPrivatePath(path, config.storage.privateRootDir, config.storage.expectedDevice);
    if (treeSnapshot(config, path).identity !== before.identity) throw new ProtocolError("Artifact changed during retirement validation.");
    // A helper-created baseline cannot authorize a replacement of the caller's selection.
    // Rerun its original validator AFTER all blocking helper preparation, before any move.
    validateSelection();
    checkStorage(config, [dirname(path)]);
    try {
      if (trash) trash(path);
      else execFileSync(command!, [path], { timeout: 10_000, maxBuffer: 4096, stdio: "pipe" });
    } catch (error) {
      // Absence counts only after invoking the trusted move, never after preparation fails.
      if (!existsSync(path)) throw new CompletedMoveFailure();
      throw error;
    }
  };
}
function retirementBatch(config: Config, trash: ((path: string) => void) | undefined,
  work: (retire: RetirementMove) => void): number {
  let retired = 0;
  const helper = retirementHelper(config, trash);
  try {
    work((path, validateSelection) => {
      try { helper(path, validateSelection); }
      catch (error) { if (error instanceof CompletedMoveFailure) retired++; throw error; }
      if (existsSync(path)) throw new ProtocolError("Retirement helper did not move the artifact.");
      retired++;
    });
    return retired;
  } catch { throw new RetirementError(retired); }
}
export function retireRecovery(config: Config, role: StoreRole, limit: number, trash?: (path: string) => void): number {
  if (!config.operatorPublicKey) throw new ProtocolError("Independent operator verification key required.");
  return retirementBatch(config, trash, retire => { PrivateStore.retireRecoveryAudits(roleOptions(config, role),
    { key: publicKey(config.operatorPublicKey!), role }, limit, retire); });
}
const artifactUuid = "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const generatedQuarantineName = new RegExp(`^(?:incoming-${artifactUuid}-${artifactUuid}|gen-e[1-9][0-9]*-s[1-9][0-9]*-[a-f0-9]{12}-${artifactUuid}|(?:state\\.json\\.tmp\\.|stage-)[0-9]+-${artifactUuid}-${artifactUuid}|\\.flighty-replica-export-[A-Za-z0-9]{6}-${artifactUuid}|raw-backup-${artifactUuid}|copy-e[1-9][0-9]*-s[1-9][0-9]*-${artifactUuid})$`);
export type ArtifactCategory = "history" | "quarantine" | "copies";
/** Explicit local operator retirement only. No caller paths, shell, deletion or remote verb.
 * Recoverable OS trash must be separately provisioned/approved; absence fails honestly. */
export function retireArtifacts(config: Config, category: ArtifactCategory, limit: number,
  trash?: (path: string) => void): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 16) throw new ProtocolError();
  checkStorage(config); validateConfig(config);
  return retirementBatch(config, trash, retire => {
    const roles: StoreRole[] = config.kind === "linux" ? ["linux-mailbox", "linux-client"] : ["mac-executor", "mac-sequence"];
    const stores: PrivateStore[] = [];
    let failure: unknown;
    try {
      for (const role of roles) stores.push(new PrivateStore(roleOptions(config, role)));
      if (category === "history") {
        let count = 0;
        for (const store of stores) if (count < limit) count += store.retireArchive(limit - count, retire);
      } else {
        const roots = category === "copies" ? (config.kind === "mac" ? [config.transferParent] : []) :
          config.kind === "mac" ? [config.rawQuarantine] : [config.quarantine, join(config.receiverRoot, ".trash")];
        let retired = 0;
        for (const root of roots) {
          checkStorage(config, [root]); if (!existsSync(root)) continue;
          treeSnapshot(config, root); // Whole-root ownership/device and aggregate storage bounds.
          for (const name of readdirSync(root).sort()) {
            if (retired >= limit) break;
            const allowed = category === "copies" ? /^copy-e[1-9][0-9]*-s[1-9][0-9]*$/.test(name) : generatedQuarantineName.test(name);
            if (!allowed) throw new ProtocolError("Unrecognized application artifact; operator inspection required.");
            const path = join(root, name), snapshot = treeSnapshot(config, path);
            validateArtifactLayout(name, snapshot.nodes);
            // The complete artifact must be aged, including every descendant.
            if (Date.now() - snapshot.newest < 86_400_000) continue;
            const validateSelection = () => {
              const current = treeSnapshot(config, path);
              if (current.identity !== snapshot.identity) throw new ProtocolError("Artifact changed during selection.");
              validateArtifactLayout(name, current.nodes);
              if (Date.now() - current.newest < 86_400_000) throw new ProtocolError("Artifact is no longer aged.");
              checkStorage(config, [root]);
            };
            validateSelection(); retire(path, validateSelection); retired++;
          }
        }
      }
    } catch (error) { failure = error; }
    finally { for (const store of stores.reverse()) { try { store.close(); } catch (error) { failure ??= error; } } }
    if (failure) throw failure;
  });
}
function validateArtifactLayout(name: string, nodes: { relative: string; directory: boolean }[]): void {
  const raw = name.startsWith("raw-backup-"), work = name.startsWith(".flighty-replica-export-");
  const state = name.startsWith("state.json.tmp.");
  const rawFile = /^(?:source-snapshot\.db(?:-wal|-shm|-journal)?)$/;
  const bundleFile = /^(?:manifest\.json|replica\.db(?:-wal|-shm|-journal)?)$/;
  for (const node of nodes) {
    if (!node.relative) { if (node.directory === state) throw new ProtocolError("Artifact root type rejected."); continue; }
    let allowed = false;
    if (raw) allowed = !node.directory && rawFile.test(node.relative);
    else if (work) allowed = node.directory ? ["raw-backup", "bundle"].includes(node.relative) :
      (node.relative.startsWith("raw-backup/") && rawFile.test(node.relative.slice(11))) ||
      (node.relative.startsWith("bundle/") && bundleFile.test(node.relative.slice(7)));
    else if (!state) allowed = !node.directory && bundleFile.test(node.relative);
    if (!allowed) throw new ProtocolError("Artifact contains an unrecognized layout; operator inspection required.");
  }
}
