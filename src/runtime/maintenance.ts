import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { z } from "zod";
import { PrivateStore, type StoreOptions } from "../remote/store.js";
import { verifyAttestation, verifyAudit } from "../remote/recovery.js";
import { callersFor, type LinuxConfig } from "./config.js";
import { verifyClientResolution, type ClientRow } from "./client-state.js";
import { digest, ProtocolError } from "../remote/protocol.js";
import { linuxStoreOptions, linuxClientStoreOptions, openLinux } from "./linux.js";
import { macStoreOptions, sequenceStoreOptions, openMac } from "./mac.js";
import { checkStorage, validateConfig, publicKey, type Config } from "./config.js";
import { assertNoSymlinkChain, assertPrivatePath, measureStorage } from "../replica/cleanup.js";

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
function retirementHelper(config: Config, trash?: (path: string) => void): (path: string) => void {
  return trash ?? ((path: string) => {
    const command = config.retirementCommand;
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
    execFileSync(command, [path], { timeout: 10_000, maxBuffer: 4096, stdio: "pipe" });
  });
}
export function retireRecovery(config: Config, role: StoreRole, limit: number, trash?: (path: string) => void): number {
  if (!config.operatorPublicKey) throw new ProtocolError("Independent operator verification key required.");
  return PrivateStore.retireRecoveryAudits(roleOptions(config, role), { key: publicKey(config.operatorPublicKey), role }, limit, retirementHelper(config, trash));
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
  const retire = retirementHelper(config, trash);
  const roles: StoreRole[] = config.kind === "linux" ? ["linux-mailbox", "linux-client"] : ["mac-executor", "mac-sequence"];
  const stores: PrivateStore[] = [];
  try {
    for (const role of roles) stores.push(new PrivateStore(roleOptions(config, role)));
    if (category === "history") return stores.reduce((n, store) => n + (n < limit ? store.retireArchive(limit - n, retire) : 0), 0);
    const roots = category === "copies" ? (config.kind === "mac" ? [config.transferParent] : []) :
      config.kind === "mac" ? [config.rawQuarantine] : [config.quarantine, join(config.receiverRoot, ".trash")];
    let retired = 0;
    for (const root of roots) {
      checkStorage(config, [root]); if (!existsSync(root)) continue;
      // Full private traversal/byte/entry bounds precede touching a candidate. Symlinks/links reject.
      measureStorage(root, config.budget);
      for (const name of readdirSync(root)) {
        if (retired >= limit) break;
        const allowed = category === "copies" ? /^copy-e[1-9][0-9]*-s[1-9][0-9]*$/.test(name) :
          generatedQuarantineName.test(name);
        if (!allowed) throw new ProtocolError("Unrecognized application artifact; operator inspection required.");
        const path = join(root, name); assertNoSymlinkChain(path, "retirement"); assertPrivatePath(path, root);
        // Never retire an active operation's in-process artifact: all stores are exclusively held above.
        if (Date.now() - lstatSync(path).mtimeMs < 86_400_000) continue;
        retire(path); retired++;
      }
    }
    return retired;
  } finally { for (const store of stores.reverse()) store.close(); }
}
