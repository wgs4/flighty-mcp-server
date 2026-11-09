import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/constants.js", () => ({
  AUTH_DB_PATH: "/synthetic/auth.sqlite",
  MAIN_DB_PATH: "/synthetic/main.db",
  PREFS_PLIST_PATH: "/synthetic/prefs.plist",
  FLIGHTY_API_BASE: "https://api.flightyapp.com",
  FLIGHTY_USER_AGENT: "synthetic-test-agent",
  getFlightyBuildToken: vi.fn(() => {
    throw new Error("default build-token reader should not run");
  }),
  FLIGHTY_BUILD_TOKEN: "",
}));

vi.mock("../src/services/auth-token.js", () => ({
  readFlightyAuthToken: vi.fn(() => {
    throw new Error("default auth reader should not run");
  }),
  readJwtSubject: vi.fn(() => null),
}));

vi.mock("../src/services/sync-token.js", () => ({
  readFlightySyncUrl: vi.fn(() => {
    throw new Error("default sync reader should not run");
  }),
}));

import { getFlightyBuildToken } from "../src/constants.js";
import { readFlightyAuthToken } from "../src/services/auth-token.js";
import {
  FlightyApi,
  RequestSafetyError,
  sanitizeFetchError,
} from "../src/services/flighty-api.js";
import {
  SyncUrlRejectedError,
  type RuntimePolicy,
} from "../src/services/policy.js";

const FLIGHT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SECRET = "synthetic-query-secret";
const WRITES: RuntimePolicy = {
  mode: "read-write",
  extraSyncHosts: new Set(["sync.example.test"]),
};

function logs() {
  const lines: string[] = [];
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
    lines.push(args.map(String).join(" "));
  });
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
    lines.push(args.map(String).join(" "));
  });
  return {
    lines,
    restore() {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    },
  };
}

describe("stored sync URL before credentials", () => {
  afterEach(() => {
    vi.mocked(readFlightyAuthToken).mockClear();
    vi.mocked(getFlightyBuildToken).mockClear();
  });

  async function rejectUrl(syncUrl: string) {
    const events: string[] = [];
    const fetchImpl = vi.fn(async () => {
      events.push("fetch");
      return new Response(null, { status: 204 });
    });
    const api = new FlightyApi({
      policy: WRITES,
      fetchImpl,
      readSyncUrl: () => {
        events.push("sync");
        return syncUrl;
      },
      readAuthToken: () => {
        events.push("auth");
        return "synthetic-jwt";
      },
      getBuildToken: () => {
        events.push("build");
        return "synthetic-build";
      },
    });
    const output = logs();
    let caught: unknown;
    try {
      await api.deleteFlight(FLIGHT);
    } catch (error) {
      caught = error;
    } finally {
      output.restore();
    }
    return { caught, events, fetchImpl, logged: output.lines.join("\n") };
  }

  it("rejects a non-allowlisted URL before getHeaders or credential readers", async () => {
    const url = `http://evil.example/path?token=${SECRET}`;
    const { caught, events, fetchImpl, logged } = await rejectUrl(url);
    expect(caught).toBeInstanceOf(SyncUrlRejectedError);
    expect((caught as SyncUrlRejectedError).reason).toBe("scheme");
    expect(events).toEqual(["sync"]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readFlightyAuthToken).not.toHaveBeenCalled();
    expect(getFlightyBuildToken).not.toHaveBeenCalled();
    const rendered = `${caught} ${logged}`;
    expect(rendered).not.toContain(SECRET);
    expect(rendered).not.toContain("evil.example");
    expect(rendered).not.toContain("/path");
  });

  it("rejects userinfo on an otherwise allowed host before credentials", async () => {
    const url = `https://user:pass@api.flightyapp.com/v1/full?token=${SECRET}`;
    const { caught, events, fetchImpl } = await rejectUrl(url);
    expect((caught as SyncUrlRejectedError).reason).toBe("userinfo");
    expect(events).toEqual(["sync"]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(String(caught)).not.toContain("user");
    expect(String(caught)).not.toContain("pass");
    expect(String(caught)).not.toContain(SECRET);
  });

  it("rejects a nonstandard port before credentials", async () => {
    const { caught, events } = await rejectUrl("https://api.flightyapp.com:8443/v1/full");
    expect((caught as SyncUrlRejectedError).reason).toBe("port");
    expect(events).toEqual(["sync"]);
  });

  it("sends credentials only after an allowed URL and does not follow redirects", async () => {
    const events: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      events.push("fetch");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const url = String(input);
      expect(url.startsWith("https://sync.flightyapp.com/v1/full?")).toBe(true);
      expect(url).toContain(`q=${SECRET}`);
      expect(url).toContain("fast_flight_sync=true");
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer synthetic-jwt"
      );
      throw new TypeError(
        `redirect mode is set to error: https://user:pass@evil.example/steal?token=${SECRET}`
      );
    });
    const api = new FlightyApi({
      policy: WRITES,
      fetchImpl,
      readSyncUrl: () => {
        events.push("sync");
        return `https://sync.flightyapp.com/v1/full?q=${SECRET}`;
      },
      readAuthToken: () => {
        events.push("auth");
        return "synthetic-jwt";
      },
      getBuildToken: () => {
        events.push("build");
        return "synthetic-build";
      },
    });
    const output = logs();
    let caught: unknown;
    try {
      await api.deleteFlight(FLIGHT);
    } catch (error) {
      caught = error;
    } finally {
      output.restore();
    }
    expect(events).toEqual(["sync", "build", "auth", "fetch"]);
    expect((caught as Error).message).toBe(
      "Flighty request failed before a response was accepted."
    );
    expect(`${caught} ${output.lines.join("\n")}`).not.toContain(SECRET);
    expect(String(caught)).not.toContain("evil.example");
    expect(String(caught)).not.toContain("user:pass");
  });

  it("hides a 302 Location header", async () => {
    const api = new FlightyApi({
      policy: WRITES,
      fetchImpl: vi.fn(async () =>
        new Response("SECRET_BODY_DO_NOT_LEAK", {
          status: 302,
          headers: { Location: `https://evil.example/land?token=${SECRET}` },
        })
      ),
      readSyncUrl: () => "https://sync.flightyapp.com/v1/full",
      readAuthToken: () => "synthetic-jwt",
      getBuildToken: () => "synthetic-build",
    });
    await expect(api.deleteFlight(FLIGHT)).rejects.toThrow(
      "Flighty refused to follow a redirect."
    );
  });

  it("hides a timeout error that contains a URL", async () => {
    const timeout = new Error(`timed out at https://evil.example/x?token=${SECRET}`);
    timeout.name = "TimeoutError";
    const api = new FlightyApi({
      policy: WRITES,
      fetchImpl: vi.fn(async () => {
        throw timeout;
      }),
      readSyncUrl: () => "https://api.flightyapp.com/sync",
      readAuthToken: () => "synthetic-jwt",
      getBuildToken: () => "synthetic-build",
    });
    await expect(api.deleteFlight(FLIGHT)).rejects.toThrow("Flighty request timed out.");
  });

  it("sanitizes a mocked redirect rejection without a socket", () => {
    const wrapped = sanitizeFetchError(
      new TypeError(
        `redirect mode is set to error: https://evil.example/land?token=${SECRET}`
      )
    );
    expect(wrapped).toBeInstanceOf(RequestSafetyError);
    expect(wrapped.message).toBe(
      "Flighty request failed before a response was accepted."
    );
    expect(`${wrapped.name} ${wrapped.message}`).not.toContain(SECRET);
    expect(wrapped.message).not.toContain("evil.example");
  });

  it("keeps an explicit standard port and an opted-in host", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://sync.example.test:443/v1/full?q=kept&fast_flight_sync=true"
      );
      expect(init?.redirect).toBe("error");
      return new Response(null, { status: 204 });
    });
    const api = new FlightyApi({
      policy: WRITES,
      fetchImpl,
      readSyncUrl: () => "https://sync.example.test:443/v1/full?q=kept",
      readAuthToken: () => "synthetic-jwt",
      getBuildToken: () => "synthetic-build",
    });
    await api.deleteFlight(FLIGHT);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
