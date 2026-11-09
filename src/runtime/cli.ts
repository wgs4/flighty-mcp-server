#!/usr/bin/env node
import { inspectStore, recoverStore, archiveResolvedClient, retireRecovery, maintain, retireArtifacts, storeRole } from "./maintenance.js";
import { readConfig, privateRead, publicKey } from "./config.js";
import { provisionLinux } from "./linux.js";
import { provisionMac, macContextCapture, macStoreOptions } from "./mac.js";
import { courierCycle } from "./courier.js";
import { forcedIpcClient } from "./ipc.js";
import { checkStorage } from "./config.js";
import { PrivateStore } from "../remote/store.js";
import { reconcileAccountFence } from "../remote/recovery.js";
import { loadRuntimePolicy } from "../services/policy.js";

async function main() {
  const args = process.argv.slice(2);
  // Exact fixed command grammar. No arbitrary argv from SSH_ORIGINAL_COMMAND.
  const [verb, ...rest] = args;
  if (verb === "retire-recovery" && rest.length === 8 && rest[0] === "--kind" && ["linux", "mac"].includes(rest[1]) && rest[2] === "--config" && rest[4] === "--role" && rest[6] === "--limit" && /^(?:[1-9]|1[0-6])$/.test(rest[7])) {
    const config = rest[1] === "linux" ? readConfig(rest[3], "linux") : readConfig(rest[3], "mac");
    console.error(JSON.stringify({ retired: retireRecovery(config, storeRole.parse(rest[5]), Number(rest[7])) })); return;
  }
  if (verb === "archive-resolved" && rest.length === 4 && rest[0] === "--config" && rest[2] === "--attestation") {
    archiveResolvedClient(readConfig(rest[1], "linux"), JSON.parse(privateRead(rest[3]).toString("utf8")));
    console.error("Resolved UNKNOWN evidence archived; original outcome unchanged."); return;
  }
  if (["inspect-store", "recover-store"].includes(verb) && (rest.length === 6 || rest.length === 8) && rest[0] === "--kind" && ["linux", "mac"].includes(rest[1]) && rest[2] === "--config" && rest[4] === "--role") {
    const config = rest[1] === "linux" ? readConfig(rest[3], "linux") : readConfig(rest[3], "mac"), role = storeRole.parse(rest[5]);
    if (verb === "inspect-store" && rest.length === 6) { process.stdout.write(JSON.stringify(inspectStore(config, role)) + "\n"); return; }
    if (verb === "recover-store" && rest.length === 8 && rest[6] === "--attestation") { recoverStore(config, role, JSON.parse(privateRead(rest[7], 16 * 1024).toString("utf8"))); console.error("Authorized continuity publication completed. No operation was dispatched or outcome rewritten."); return; }
  }
  if (["maintain", "retire-artifacts"].includes(verb) && (rest.length === 4 || rest.length === 8) && rest[0] === "--kind" && ["linux", "mac"].includes(rest[1]) && rest[2] === "--config") {
    const config = rest[1] === "linux" ? readConfig(rest[3], "linux") : readConfig(rest[3], "mac");
    if (verb === "maintain" && rest.length === 4) { maintain(config); console.error("Bounded history maintenance completed."); return; }
    if (verb === "retire-artifacts" && rest.length === 8 && rest[4] === "--category" && ["history", "quarantine", "copies"].includes(rest[5]) && rest[6] === "--limit" && /^(?:[1-9]|1[0-6])$/.test(rest[7])) {
      console.error(JSON.stringify({ retired: retireArtifacts(config, rest[5] as "history" | "quarantine" | "copies", Number(rest[7])) })); return;
    }
  }
  if (["init-linux", "init-mac"].includes(verb) && rest.length === 2 && rest[0] === "--config") {
    if (verb === "init-linux") provisionLinux(readConfig(rest[1], "linux"));
    else provisionMac(readConfig(rest[1], "mac"));
    console.error("Explicit provisioning completed. No service or courier was activated."); return;
  }
  if (verb === "courier-once" && (rest.length === 2 || rest.length === 3) && rest[0] === "--config" && (rest.length === 2 || rest[2] === "--snapshot")) {
    const result = await courierCycle(readConfig(rest[1], "mac"), { snapshot: rest[2] === "--snapshot", fetchImpl: fetch });
    console.error(JSON.stringify({ action: "copy_refresh", ...result })); return;
  }
  if (verb === "forced-command" && rest.length === 2 && rest[0] === "--config") {
    const config = readConfig(rest[1], "linux");
    const command = process.env.SSH_ORIGINAL_COMMAND;
    if (command !== "flighty-mailbox-v1" && command !== "flighty-upload-v1") throw new Error();
    await forcedIpcClient({ socketPath: config.socketPath, endpoint: command === "flighty-mailbox-v1" ? "mailbox" : "upload",
      input: process.stdin, output: process.stdout, maxDbBytes: config.budget.maxDbBytes,
      acceptanceMs: config.budget.acceptanceMs, transportMs: config.budget.transportMs, checkLocation: () => checkStorage(config) }); return;
  }
  if (verb === "reconcile-mac" && rest.length === 4 && rest[0] === "--config" && rest[2] === "--attestation") {
    const config = readConfig(rest[1], "mac");
    const context = await macContextCapture(config, loadRuntimePolicy())(AbortSignal.timeout(5000));
    if (!context) throw new Error();
    const store = new PrivateStore(macStoreOptions(config));
    try { reconcileAccountFence({ store, currentAccount: context.account, operatorKey: publicKey(config.operatorPublicKey),
      attestation: JSON.parse(privateRead(rest[3]).toString("utf8")) }); } finally { store.close(); }
    console.error("Bound operator attestation retained. Original operation remains UNKNOWN; no replay authorized."); return;
  }
  throw new Error();
}
main().catch(() => { console.error("Flighty offline adapter command unavailable or rejected. Check explicit private configuration, provisioning and continuity. No automatic reset or retry."); process.exitCode = 1; });
