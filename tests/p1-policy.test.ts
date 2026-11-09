import { describe, expect, it } from "vitest";
import {
  EXTRA_SYNC_HOSTS_MESSAGE,
  PolicyConfigError,
  READ_ONLY_POLICY_MESSAGE,
  SyncUrlRejectedError,
  assertAllowedSyncUrl,
  formatPolicyStartupError,
  loadRuntimePolicy,
  parseExtraSyncHosts,
  parseReadOnlyMode,
  writesEnabled,
} from "../src/services/policy.js";

const SECRET = "SENTINEL_POLICY_VALUE_9f3a";

describe("FLIGHTY_READ_ONLY", () => {
  const readOnly = ["1", "true", "yes", "on", "TRUE", "Yes", "ON", " 1 ", "on ", "\ntrue", "\u00A0on\u00A0"];
  const writes = ["", "   ", "0", "false", "no", "off", "FALSE", "No", "  off  ", undefined];

  it.each(readOnly)("treats %j as read-only", (value) => {
    expect(parseReadOnlyMode(value)).toBe("read-only");
  });

  it.each(writes)("treats %j as writes enabled", (value) => {
    expect(parseReadOnlyMode(value)).toBe("read-write");
  });

  it.each(["maybe", "00", "truee", "2", "yes please", "1.0", "enabled", `${SECRET}`])(
    "rejects %j without echoing it",
    (value) => {
      expect(() => parseReadOnlyMode(value)).toThrow(PolicyConfigError);
      try {
        parseReadOnlyMode(value);
      } catch (error) {
        expect(error).toBeInstanceOf(PolicyConfigError);
        expect((error as Error).message).toBe(READ_ONLY_POLICY_MESSAGE);
        expect((error as Error).message).not.toContain(value.trim() || SECRET);
        expect((error as Error).message).not.toContain(SECRET);
      }
    }
  );

  it("keeps startup formatting free of arbitrary input", () => {
    expect(formatPolicyStartupError(new Error(`leak ${SECRET}`))).toBe(
      "Invalid Flighty policy configuration. Refusing to start."
    );
    expect(formatPolicyStartupError(new PolicyConfigError(READ_ONLY_POLICY_MESSAGE))).toBe(
      READ_ONLY_POLICY_MESSAGE
    );
  });
});

describe("runtime policy", () => {
  it("defaults to writes when both variables are unset", () => {
    const policy = loadRuntimePolicy({});
    expect(policy.mode).toBe("read-write");
    expect(policy.extraSyncHosts.size).toBe(0);
    expect(writesEnabled(policy)).toBe(true);
  });

  it("uses one object for mode and extra hosts", () => {
    const policy = loadRuntimePolicy({
      FLIGHTY_READ_ONLY: "on",
      FLIGHTY_EXTRA_SYNC_HOSTS: "Sync.Example.TEST",
    });
    expect(writesEnabled(policy)).toBe(false);
    expect(policy.extraSyncHosts).toEqual(new Set(["sync.example.test"]));
  });

  it("reports both invalid settings without echoing them", () => {
    const host = `https://user:pass@${SECRET}.example/path`;
    expect(() =>
      loadRuntimePolicy({
        FLIGHTY_READ_ONLY: SECRET,
        FLIGHTY_EXTRA_SYNC_HOSTS: host,
      })
    ).toThrow(PolicyConfigError);
    try {
      loadRuntimePolicy({
        FLIGHTY_READ_ONLY: SECRET,
        FLIGHTY_EXTRA_SYNC_HOSTS: host,
      });
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(READ_ONLY_POLICY_MESSAGE);
      expect(message).toContain(EXTRA_SYNC_HOSTS_MESSAGE);
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain("user:pass");
      expect(message).not.toContain("https://");
    }
  });
});

describe("FLIGHTY_EXTRA_SYNC_HOSTS", () => {
  it("treats unset and blank as no extra hosts", () => {
    expect(parseExtraSyncHosts(undefined).size).toBe(0);
    expect(parseExtraSyncHosts("").size).toBe(0);
    expect(parseExtraSyncHosts("   ").size).toBe(0);
  });

  it("accepts exact hostnames and ignores duplicates and case", () => {
    expect(parseExtraSyncHosts(" Sync.Example.TEST , sync.example.test ")).toEqual(
      new Set(["sync.example.test"])
    );
  });

  it.each([
    "https://evil.example",
    "*.example.com",
    "1.2.3.4",
    "999.1.1.1",
    "user:pass@host.example",
    "host.example:443",
    "host.example/path",
    "host.example?x=1",
    ".example.com",
    "example.com.",
    "bad_host.example",
    "a.example,,b.example",
    "-bad.example",
  ])("rejects configuration %j without echoing it", (value) => {
    expect(() => parseExtraSyncHosts(value)).toThrow(PolicyConfigError);
    try {
      parseExtraSyncHosts(value);
    } catch (error) {
      expect((error as Error).message).toBe(EXTRA_SYNC_HOSTS_MESSAGE);
      expect((error as Error).message).not.toContain(value.split(",")[0].slice(0, 12));
    }
  });

  it("rejects an oversized host list", () => {
    const value = Array.from({ length: 33 }, (_, index) => `h${index}.example`).join(",");
    expect(() => parseExtraSyncHosts(value)).toThrow(EXTRA_SYNC_HOSTS_MESSAGE);
  });
});

describe("sync URL allowlist", () => {
  const none = new Set<string>();
  const extra = new Set(["sync.example.test"]);

  function reason(raw: string, hosts: ReadonlySet<string> = none): string {
    try {
      assertAllowedSyncUrl(raw, hosts);
    } catch (error) {
      expect(error).toBeInstanceOf(SyncUrlRejectedError);
      expect((error as Error).message).not.toContain("token");
      expect((error as Error).message).not.toContain("secret");
      expect((error as Error).message).not.toContain("user");
      expect((error as Error).message).not.toContain("pass");
      expect((error as Error).message).not.toContain("https://");
      return (error as SyncUrlRejectedError).reason;
    }
    return "allowed";
  }

  it("allows flightyapp.com, subdomains, the default port, and an exact extra host", () => {
    expect(reason("https://flightyapp.com/v1")).toBe("allowed");
    expect(reason("https://api.flightyapp.com/v1/search")).toBe("allowed");
    expect(reason("https://a.b.flightyapp.com/path?fast=1")).toBe("allowed");
    expect(reason("https://API.FlightyApp.com:443/v1")).toBe("allowed");
    expect(reason("https://sync.example.test/v1?token=synthetic-query-secret", extra)).toBe(
      "allowed"
    );
  });

  it("rejects other destinations", () => {
    expect(reason("http://api.flightyapp.com/v1")).toBe("scheme");
    expect(reason("https://user:pass@api.flightyapp.com/v1?token=synthetic-query-secret")).toBe(
      "userinfo"
    );
    expect(reason("https://api.flightyapp.com:8443/v1")).toBe("port");
    expect(reason("https://notflightyapp.com/v1")).toBe("host");
    expect(reason("https://flightyapp.com.evil.example/v1")).toBe("host");
    expect(reason("https://api.flightyapp.com.")).toBe("host");
    expect(reason("https://sync.example.test.evil.example/v1", extra)).toBe("host");
    expect(reason("https://evil.example\\@api.flightyapp.com/v1")).toBe("parse");
    expect(reason("https://api.flightyapp.com/v1 path")).toBe("parse");
    expect(reason("")).toBe("parse");
    expect(reason(`https://api.flightyapp.com/${"a".repeat(5000)}`)).toBe("parse");
  });
});
