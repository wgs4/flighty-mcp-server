#!/usr/bin/env node
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
