export type AccessMode = "read-only" | "read-write";

export type RuntimePolicy = {
  readonly mode: AccessMode;
  readonly extraSyncHosts: ReadonlySet<string>;
};

export class PolicyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyConfigError";
  }
}

export class WritesDisabledError extends Error {
  constructor() {
    super(
      "Writes are disabled because read-only mode is on. The request was not sent."
    );
    this.name = "WritesDisabledError";
  }
}

export type SyncUrlRejectReason =
  | "parse"
  | "userinfo"
  | "scheme"
  | "port"
  | "host";

const SYNC_URL_REJECTED_MESSAGE =
  "The stored sync URL was rejected before any credential was read. It must use HTTPS on flightyapp.com or an exact configured host, with no embedded login and the standard port.";

export class SyncUrlRejectedError extends Error {
  readonly reason: SyncUrlRejectReason;

  constructor(reason: SyncUrlRejectReason) {
    super(SYNC_URL_REJECTED_MESSAGE);
    this.name = "SyncUrlRejectedError";
    this.reason = reason;
  }
}

const READ_ONLY_VALUES = new Set(["1", "true", "yes", "on"]);
const WRITES_ENABLED_VALUES = new Set(["", "0", "false", "no", "off"]);

export const READ_ONLY_POLICY_MESSAGE =
  "Invalid FLIGHTY_READ_ONLY. Use 1, true, yes, or on for read-only, or 0, false, no, off, or leave it unset to allow writes. Refusing to start.";

export const EXTRA_SYNC_HOSTS_MESSAGE =
  "Invalid FLIGHTY_EXTRA_SYNC_HOSTS. Use a comma-separated list of exact hostnames, or leave it unset. Refusing to start.";

const GENERIC_STARTUP_MESSAGE =
  "Invalid Flighty policy configuration. Refusing to start.";

const FLIGHTY_SUFFIX = "flightyapp.com";
const MAX_SYNC_URL_LENGTH = 4096;
const MAX_EXTRA_HOSTS = 32;
const MAX_EXTRA_HOSTS_LENGTH = 4096;
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function parseReadOnlyMode(raw: string | undefined): AccessMode {
  const normalized = (raw ?? "").trim().toLowerCase();
  if (READ_ONLY_VALUES.has(normalized)) return "read-only";
  if (WRITES_ENABLED_VALUES.has(normalized)) return "read-write";
  throw new PolicyConfigError(READ_ONLY_POLICY_MESSAGE);
}

export function parseExtraSyncHosts(raw: string | undefined): ReadonlySet<string> {
  if (raw == null || raw.trim() === "") return new Set();
  if (raw.length > MAX_EXTRA_HOSTS_LENGTH) {
    throw new PolicyConfigError(EXTRA_SYNC_HOSTS_MESSAGE);
  }
  const parts = raw.split(",");
  if (parts.length > MAX_EXTRA_HOSTS) {
    throw new PolicyConfigError(EXTRA_SYNC_HOSTS_MESSAGE);
  }
  const hosts = new Set<string>();
  for (const part of parts) {
    const host = part.trim().toLowerCase();
    if (!isConfiguredHostname(host)) {
      throw new PolicyConfigError(EXTRA_SYNC_HOSTS_MESSAGE);
    }
    hosts.add(host);
  }
  return hosts;
}

export function loadRuntimePolicy(
  env: Record<string, string | undefined> = process.env
): RuntimePolicy {
  const problems: string[] = [];
  let mode: AccessMode = "read-write";
  let extraSyncHosts: ReadonlySet<string> = new Set();
  try {
    mode = parseReadOnlyMode(env.FLIGHTY_READ_ONLY);
  } catch (error) {
    problems.push(formatPolicyStartupError(error));
  }
  try {
    extraSyncHosts = parseExtraSyncHosts(env.FLIGHTY_EXTRA_SYNC_HOSTS);
  } catch (error) {
    problems.push(formatPolicyStartupError(error));
  }
  if (problems.length > 0) {
    throw new PolicyConfigError(problems.join(" "));
  }
  return { mode, extraSyncHosts };
}

export function formatPolicyStartupError(error: unknown): string {
  if (error instanceof PolicyConfigError) return error.message;
  return GENERIC_STARTUP_MESSAGE;
}

export function writesEnabled(policy: RuntimePolicy): boolean {
  return policy.mode === "read-write";
}

export function assertWritesEnabled(policy: RuntimePolicy): void {
  if (!writesEnabled(policy)) throw new WritesDisabledError();
}

export function assertAllowedSyncUrl(
  raw: string,
  extraHosts: ReadonlySet<string>
): void {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_SYNC_URL_LENGTH) {
    throw new SyncUrlRejectedError("parse");
  }
  if (/[\u0000-\u0020\u007f\\]/.test(raw)) {
    throw new SyncUrlRejectedError("parse");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SyncUrlRejectedError("parse");
  }
  if (url.username !== "" || url.password !== "") {
    throw new SyncUrlRejectedError("userinfo");
  }
  if (url.protocol !== "https:") {
    throw new SyncUrlRejectedError("scheme");
  }
  // Node reports the default HTTPS port as an empty string, including an
  // explicit :443. Any other port value is a nonstandard port.
  if (url.port !== "") {
    throw new SyncUrlRejectedError("port");
  }
  if (!isAllowedSyncHost(url.hostname, extraHosts)) {
    throw new SyncUrlRejectedError("host");
  }
}

function isAllowedSyncHost(
  hostname: string,
  extraHosts: ReadonlySet<string>
): boolean {
  const host = hostname.toLowerCase();
  if (!isDnsHostname(host) || host.endsWith(".")) return false;
  if (host === FLIGHTY_SUFFIX || host.endsWith(`.${FLIGHTY_SUFFIX}`)) return true;
  return extraHosts.has(host);
}

function isConfiguredHostname(host: string): boolean {
  if (!isDnsHostname(host)) return false;
  if (host.split(".").every((label) => /^\d+$/.test(label))) return false;
  return true;
}

function isDnsHostname(host: string): boolean {
  return HOSTNAME_PATTERN.test(host);
}
