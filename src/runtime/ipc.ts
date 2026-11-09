import { createServer, createConnection, type Socket } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, writeSync, chmodSync, unlinkSync, linkSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { boundedJson, parseWire, ProtocolError, MAX_WIRE_BYTES } from "../remote/protocol.js";
import type { Mailbox } from "../remote/mailbox.js";
import type { ReplicaReceiver } from "../replica/receiver.js";
import { measureStorageGroups, retirePath, flushPath, assertNoSymlinkChain, assertPrivatePath } from "../replica/cleanup.js";
import { withSqliteBudget } from "../replica/work.js";
import { checkStorage, type LinuxConfig } from "./config.js";

export const UPLOAD_HEADER_BYTES = 1024;
export const UPLOAD_MS = 30_000;
const headerSchema = z.object({ verb: z.literal("upload"), manifestBytes: z.number().int().min(1).max(16 * 1024),
  dbBytes: z.number().int().min(100), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/), dbSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type UploadHeader = z.infer<typeof headerSchema>;
export type IpcEndpoint = "mailbox" | "upload";
const rejected = () => new ProtocolError("Private courier IPC unavailable or request rejected.");

/** Endpoint role is fixed by the configured socket + forced command, never by JSON claims.
 * The socket belongs to the Node MCP; the forced client is never a state owner. */
export async function startIpcServer(config: LinuxConfig, receiver: ReplicaReceiver, mailbox: Mailbox) {
  const path = config.socketPath;
  checkStorage(config, [dirname(path), config.inbox, config.quarantine]);
  assertNoSymlinkChain(path, "socket");
  // Fail closed on ANY stale path; operator must investigate the exact socket. Never unlink another listener.
  if (existsSync(path)) throw new ProtocolError("IPC socket path exists. Inspect owner/process; explicit stale-socket recovery required.");
  const bindPath = join(dirname(path), ".flighty-" + randomUUID().slice(0, 12));
  if (Buffer.byteLength(path) > 100 || Buffer.byteLength(bindPath) > 100) throw rejected();
  const sockets = new Set<Socket>();
  let accepting = false, closing = false;
  const server = createServer({ allowHalfOpen: true }, socket => {
    if (closing || sockets.size >= 2) { socket.destroy(); return; }
    sockets.add(socket);
    socket.on("error", () => {});
    void handle(socket).finally(() => { sockets.delete(socket); socket.destroy(); });
  });
  async function handle(socket: Socket) {
    let staged: string | undefined, fd: number | undefined, ownsUpload = false;
    // Total upload/command input deadline, not an idle timeout reset by trickles.
    const timer = setTimeout(() => socket.destroy(rejected()), config.budget.transportMs);
    try {
      checkStorage(config, [config.inbox, config.quarantine]);
      let header: UploadHeader | undefined, prefix = Buffer.alloc(0), endpoint: IpcEndpoint | undefined;
      let manifestLeft = 0, dbLeft = 0;
      const manifestHash = createHash("sha256"), dbHash = createHash("sha256");
      let command: Buffer[] = [], commandBytes = 0;
      for await (const input of socket.iterator({ destroyOnReturn: false })) {
        let chunk = Buffer.isBuffer(input) ? input : Buffer.from(input);
        if (!endpoint) {
          const index = chunk.indexOf(10);
          prefix = Buffer.concat([prefix, index < 0 ? chunk : chunk.subarray(0, index)]);
          if (prefix.length > UPLOAD_HEADER_BYTES) throw rejected();
          if (index < 0) continue;
          const first = parseWire(prefix.toString("utf8")) as { endpoint?: unknown; header?: unknown };
          if (!first || Object.keys(first).some(k => !["endpoint", "header"].includes(k))) throw rejected();
          if (first.endpoint === "mailbox" && first.header === undefined) endpoint = "mailbox";
          else if (first.endpoint === "upload") {
            endpoint = "upload"; header = headerSchema.parse(first.header);
            if (header.dbBytes > config.budget.maxDbBytes || accepting) throw rejected();
            accepting = true; ownsUpload = true;
            measureStorageGroups([config.inbox, config.quarantine, config.receiverRoot], config.budget, 3 * (header.dbBytes + header.manifestBytes), 8);
            const stage = join(config.inbox, "incoming-" + randomUUID()); mkdirSync(stage, { mode: 0o700 }); staged = stage;
            manifestLeft = header.manifestBytes; dbLeft = header.dbBytes;
            fd = openSync(join(staged, "manifest.json"), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
          } else throw rejected();
          chunk = chunk.subarray(index + 1);
        }
        if (endpoint === "mailbox") {
          commandBytes += chunk.length;
          if (commandBytes > MAX_WIRE_BYTES) throw rejected();
          command.push(chunk);
          continue;
        }
        if (!header || !staged) throw rejected();
        if (manifestLeft) {
          const take = Math.min(manifestLeft, chunk.length), piece = chunk.subarray(0, take);
          writeAll(fd!, piece); manifestHash.update(piece); manifestLeft -= take; chunk = chunk.subarray(take);
          if (!manifestLeft) {
            fsyncSync(fd!); closeSync(fd!); fd = undefined;
            if (manifestHash.digest("hex") !== header.manifestSha256) throw rejected();
            fd = openSync(join(staged, "replica.db"), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
          }
        }
        if (chunk.length) {
          if (chunk.length > dbLeft || manifestLeft) throw rejected();
          writeAll(fd!, chunk); dbHash.update(chunk); dbLeft -= chunk.length;
        }
      }
      clearTimeout(timer);
      if (endpoint === "mailbox") {
        const response = mailbox.handle({ role: "mac" }, Buffer.concat(command).toString("utf8"));
        socket.end(response + "\n");
      } else {
        if (!header || !staged || manifestLeft || dbLeft || dbHash.digest("hex") !== header.dbSha256) throw rejected();
        fsyncSync(fd!); closeSync(fd!); fd = undefined; flushPath(staged);
        const started = performance.now();
        const result = withSqliteBudget(config.budget.acceptanceMs, config.budget.sqliteTaskMs, () => receiver.acceptBundle(staged!));
        socket.end(boundedJson({ accepted: true, generation_id: result.generationId, sequence: result.sequence,
          status: result.status, native_budget_ms: config.budget.acceptanceMs, elapsed_ms: Math.ceil(performance.now() - started) }) + "\n");
      }
      // Wait for buffered reply before destroying the accepted half-closed stream.
      await new Promise<void>(resolve => { if (socket.writableFinished) resolve(); else socket.once("finish", resolve); });
    } catch {
      if (!socket.destroyed) await new Promise<void>(resolve => socket.end('{"error":"Private courier IPC request rejected."}\n', resolve));
    }
    finally {
      clearTimeout(timer);
      if (ownsUpload) accepting = false;
      if (fd !== undefined) { try { closeSync(fd); } catch { /* Preserve admission/error result; staging remains private. */ } }
      if (staged) {
        try { retirePath(staged, config.quarantine); } catch { /* Retained bounded staging is recovered by the single owner on restart. */ }
      }
    }
  }
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(bindPath, resolve); });
  chmodSync(bindPath, 0o600);
  const own = lstatSync(bindPath);
  try { linkSync(bindPath, path); } catch (error) { await new Promise<void>(resolve => server.close(() => resolve())); throw error; }
  return { async close() {
    if (closing) return;
    closing = true; for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    // Node normally removes its own socket. No general stale-socket unlink is attempted.
    if (existsSync(path)) {
      const current = lstatSync(path);
      if (current.isSocket() && current.ino === own.ino && current.dev === own.dev) unlinkSync(path);
    }
  } };
}
function writeAll(fd: number, bytes: Buffer): void {
  for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at, bytes.length - at);
}

/** Fixed forced-command bridge. It never opens SQLite or constructs a receiver. */
export async function forcedIpcClient(options: { socketPath: string; endpoint: IpcEndpoint; input: Readable; output: Writable;
  maxDbBytes: number; acceptanceMs: number; transportMs?: number; checkLocation: () => void }): Promise<void> {
  options.checkLocation();
  assertNoSymlinkChain(options.socketPath, "socket");
  assertPrivatePath(dirname(options.socketPath), dirname(options.socketPath));
  const st = lstatSync(options.socketPath);
  if (!st.isSocket() || (st.mode & 0o077) || (process.getuid && st.uid !== process.getuid())) throw rejected();
  const socket = createConnection({ path: options.socketPath, allowHalfOpen: true });
  let total = 0, responseBytes = 0;
  const maximum = options.endpoint === "mailbox" ? MAX_WIRE_BYTES : options.maxDbBytes + 16 * 1024 + UPLOAD_HEADER_BYTES;
  const timer = setTimeout(() => { socket.destroy(rejected()); options.input.destroy(rejected()); }, (options.transportMs ?? UPLOAD_MS) + options.acceptanceMs + 5000);
  socket.on("error", () => {});
  try {
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const response = (async () => { for await (const chunk of socket) {
      responseBytes += chunk.length; if (responseBytes > MAX_WIRE_BYTES) throw rejected();
      options.output.write(chunk);
    } })();
    void response.catch(() => { socket.destroy(); options.input.destroy(rejected()); });
    socket.write(options.endpoint === "mailbox" ? '{"endpoint":"mailbox"}\n' : '');
    // Upload input includes a bounded header line; wrap it with the fixed endpoint.
    let prefix = Buffer.alloc(0), sent = options.endpoint === "mailbox";
    for await (const chunk of options.input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); total += bytes.length;
      if (total > maximum) throw rejected();
      if (!sent) {
        const index = bytes.indexOf(10);
        prefix = Buffer.concat([prefix, index < 0 ? bytes : bytes.subarray(0, index)]);
        if (prefix.length > UPLOAD_HEADER_BYTES) throw rejected();
        if (index < 0) continue;
        const header = headerSchema.parse(parseWire(prefix.toString("utf8")));
        if (header.dbBytes > options.maxDbBytes) throw rejected();
        socket.write(boundedJson({ endpoint: "upload", header }) + "\n"); sent = true;
        await writeSocket(socket, bytes.subarray(index + 1));
      } else await writeSocket(socket, bytes);
    }
    if (!sent) throw rejected();
    socket.end(); await response;
  } finally { clearTimeout(timer); socket.destroy(); }
}
async function writeSocket(socket: Socket, bytes: Buffer) {
  if (!socket.write(bytes)) await new Promise<void>((resolve, reject) => { socket.once("drain", resolve); socket.once("error", reject); });
}
