import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { isAbsolute } from "node:path";
import { boundedJson, MAX_WIRE_BYTES, parseWire, ProtocolError } from "./protocol.js";
import type { Mailbox, MailboxPrincipal, MailboxTransport } from "./mailbox.js";

/** Staged adapter only: constructing it launches nothing. Each explicit call spawns one bounded SSH. */
export type SshConfig = {
  enabled: true; host: string; port: number; user: string; identityFile: string; knownHostsFile: string;
  checkConfiguration: () => void;
  signal?: AbortSignal;
};
export function sshTransport(inputConfig: SshConfig, spawnImpl: typeof spawn = spawn): MailboxTransport {
  const config = Object.freeze({ ...inputConfig });
  if (![config.identityFile, config.knownHostsFile].every(path => typeof path === "string" && isAbsolute(path) && /^[A-Za-z0-9._/-]+$/.test(path))) {
    throw new ProtocolError("SSH paths must be absolute and use only letters, digits, '.', '_', '-' or '/'.");
  }
  if (config.enabled !== true || !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(config.host) ||
      !/^[a-z_][a-z0-9_-]{0,31}$/.test(config.user) || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 ||
      !isAbsolute(config.identityFile) || !isAbsolute(config.knownHostsFile) ||
      /[\r\n\0]/.test(config.identityFile + config.knownHostsFile)) throw new ProtocolError("SSH configuration rejected.");
  return async command => {
    boundedJson(parseWire(command)); config.signal?.throwIfAborted(); config.checkConfiguration();
    const args = sshArguments(config, "flighty-mailbox-v1");
    return new Promise<string>((resolve, reject) => {
      const child = spawnImpl("/usr/bin/ssh", args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      let total = 0, finished = false;
      const finish = (error?: Error) => {
        if (finished) return; finished = true; clearTimeout(timer); config.signal?.removeEventListener("abort", abort);
        if (error) { child.kill("SIGKILL"); reject(error); } else resolve(Buffer.concat(chunks).toString("utf8"));
      };
      const abort = () => finish(new ProtocolError("Mailbox transport cancelled; inspect original operation status."));
      const timer = setTimeout(() => finish(new ProtocolError("Mailbox transport unavailable; inspect operation status before retrying.")), 20_000);
      config.signal?.addEventListener("abort", abort, { once: true });
      if (config.signal?.aborted) { abort(); return; }
      child.stdout.on("data", (chunk: Buffer) => {
        if (finished) return;
        total += chunk.length;
        if (total > MAX_WIRE_BYTES) finish(new ProtocolError("Mailbox response too large."));
        else chunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (finished) return;
        total += chunk.length;
        if (total > MAX_WIRE_BYTES) finish(new ProtocolError("Mailbox transport output too large."));
      });
      child.on("error", () => finish(new ProtocolError("Mailbox transport unavailable.")));
      child.stdin.on("error", () => finish(new ProtocolError("Mailbox transport unavailable.")));
      child.on("close", code => finish(code === 0 ? undefined : new ProtocolError("Mailbox transport unavailable; dispatch may be unknown.")));
      child.stdin.end(command);
    });
  };
}

/** Forced-command entry adapter: one JSON document on stdin, EOF, one response. No listener. */
export async function serveMailboxStdin(input: Readable, output: Writable, mailbox: Mailbox, principal: MailboxPrincipal): Promise<void> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const timeout = setTimeout(() => input.destroy(new ProtocolError("Mailbox input timed out.")), 10_000);
  try {
    for await (const chunk of input) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_WIRE_BYTES) throw new ProtocolError("Mailbox input too large.");
      chunks.push(buffer);
    }
    const response = mailbox.handle(principal, Buffer.concat(chunks).toString("utf8"));
    output.write(response + "\n");
  } catch {
    output.write('{"error":"Mailbox request rejected."}\n');
  } finally { clearTimeout(timeout); }
}

export function sshArguments(config: SshConfig, command: "flighty-mailbox-v1" | "flighty-upload-v1"): string[] {
  return ["-F", "/dev/null", "-T", "-p", String(config.port),
      "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${config.knownHostsFile}`,
      "-o", "GlobalKnownHostsFile=/dev/null", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
      "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no",
      "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ControlPersist=no",
      "-o", "UpdateHostKeys=no", "-o", "ForwardX11=no", "-o", "RequestTTY=no",
      "-o", "ProxyCommand=none", "-o", "ProxyJump=none", "-o", "ConnectTimeout=10",
      "-i", config.identityFile, `${config.user}@${config.host}`, command];
}
