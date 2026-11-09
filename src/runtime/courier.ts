import { spawn } from "node:child_process";
import { createReadStream, lstatSync } from "node:fs";
import { join } from "node:path";
import { assertExactBundle } from "../replica/cleanup.js";
import { computeFileSha256 } from "../replica/manifest.js";
import { boundedJson, parseWire, MAX_WIRE_BYTES, ProtocolError } from "../remote/protocol.js";
import { sshArguments, sshTransport, type SshConfig } from "../remote/transport.js";
import { pollMailbox } from "../remote/mailbox.js";
import { openMac } from "./mac.js";
import { checkStorage, privateRead, type MacConfig } from "./config.js";
import { UPLOAD_MS, type UploadHeader } from "./ipc.js";

/** Explicit call only. No timers, services, network or source discovery at construction. */
export function bundleUploader(config: SshConfig, maxDbBytes: number, acceptanceMs: number, spawnImpl: typeof spawn = spawn) {
  // Reuse reviewed transport validation; construction launches nothing.
  sshTransport(config, spawnImpl);
  return async (bundleDir: string, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted(); config.checkConfiguration(); assertExactBundle(bundleDir);
    const manifestPath = join(bundleDir, "manifest.json"), dbPath = join(bundleDir, "replica.db");
    const manifestBytes = lstatSync(manifestPath).size, dbBytes = lstatSync(dbPath).size;
    if (manifestBytes < 1 || manifestBytes > 16 * 1024 || dbBytes < 100 || dbBytes > maxDbBytes) throw new ProtocolError();
    const header: UploadHeader = { verb: "upload", manifestBytes, dbBytes,
      manifestSha256: computeFileSha256(manifestPath).sha256, dbSha256: computeFileSha256(dbPath).sha256 };
    const child = spawnImpl("/usr/bin/ssh", sshArguments(config, "flighty-upload-v1"), { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let outputBytes = 0, active: ReturnType<typeof createReadStream> | undefined;
    const chunks: Buffer[] = [];
    const stop = () => { active?.destroy(new ProtocolError("Courier cancelled or timed out.")); child.stdin.destroy(new ProtocolError("Courier cancelled or timed out.")); child.kill("SIGKILL"); };
    const timer = setTimeout(stop, UPLOAD_MS + acceptanceMs + 5000);
    signal.addEventListener("abort", stop, { once: true });
    child.stdin.on("error", () => {});
    const output = new Promise<string>((resolve, reject) => {
      const data = (chunk: Buffer, retain: boolean) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_WIRE_BYTES) { stop(); reject(new ProtocolError("Courier output exceeded bounds.")); }
        else if (retain) chunks.push(chunk);
      };
      child.stdout.on("data", chunk => data(chunk, true)); child.stderr.on("data", chunk => data(chunk, false));
      child.once("error", () => { stop(); reject(new ProtocolError("Courier unavailable.")); });
      child.once("close", code => { active?.destroy(); code === 0 ? resolve(Buffer.concat(chunks).toString("utf8")) : reject(new ProtocolError("Copy delivery unavailable; inspect generation status.")); });
    });
    // Attach rejection immediately while streaming so disconnect is never an unhandled rejection.
    void output.catch(() => {});
    try {
      child.stdin.write(boundedJson(header) + "\n");
      for (const [path, size] of [[manifestPath, manifestBytes], [dbPath, dbBytes]] as const) {
        let sent = 0; active = createReadStream(path, { highWaterMark: 64 * 1024 });
        for await (const chunk of active) {
          signal.throwIfAborted(); sent += chunk.length; if (sent > size) throw new ProtocolError();
          await new Promise<void>((resolve, reject) => child.stdin.write(chunk, error => error ? reject(error) : resolve()));
        }
        if (sent !== size) throw new ProtocolError("Bundle changed while streaming.");
      }
      child.stdin.end();
      const reply = parseWire(await output) as { accepted?: unknown; generation_id?: unknown };
      signal.throwIfAborted();
      if (reply.accepted !== true || typeof reply.generation_id !== "string") throw new ProtocolError("Receiver did not accept copy.");
    } finally { clearTimeout(timer); signal.removeEventListener("abort", stop); active?.destroy(); child.kill("SIGKILL"); }
  };
}
export function courierSsh(config: MacConfig): SshConfig {
  return { ...config.ssh, checkConfiguration() {
    checkStorage(config);
    privateRead(config.ssh.identityFile, 16 * 1024); privateRead(config.ssh.knownHostsFile, 64 * 1024);
  } };
}
/** One bounded mailbox cycle, no scheduler and no automatic new-ID retry. */
export async function courierCycle(config: MacConfig, options: { snapshot: boolean; fetchImpl: typeof fetch;
  spawnImpl?: typeof spawn; readers?: import("./mac.js").MacReaders }): Promise<{ receiptsPublished: number; copy: string | null }> {
  const cycleSignal = AbortSignal.timeout(120_000);
  const ssh = { ...courierSsh(config), signal: cycleSignal }, transport = sshTransport(ssh, options.spawnImpl);
  const mac = openMac(config, { signal: cycleSignal, readers: options.readers, fetchImpl: options.fetchImpl, upload: bundleUploader(ssh, config.budget.maxDbBytes, config.budget.acceptanceMs, options.spawnImpl) });
  try {
    // Limit 1 bounds the one-cycle envelope; executor phases enforce their own reviewed deadlines.
    const receiptsPublished = await pollMailbox(transport, mac.executor, 1);
    let copy: string | null = null;
    if (options.snapshot) {
      const signal = AbortSignal.timeout(UPLOAD_MS + config.budget.acceptanceMs + 10_000);
      const context = await mac.captureContext(signal);
      if (!context) throw new ProtocolError("Current independently captured Mac account unavailable.");
      copy = (await mac.snapshot(context, signal)).snapshotId;
    }
    return { receiptsPublished, copy };
  } finally { mac.close(); }
}
