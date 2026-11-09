import { afterEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createFixture, IDS } from "./fixture/create.mjs";
import { fixtureTempRoot, trashFixture } from "./fixture/lifecycle.mjs";
import { FlightyDatabase, runWithOwnerIdentityScope, getScopedOwnerIdentity } from "../src/services/database.js";
import * as auth from "../src/services/auth-token.js";
import { sanitizeToolErrorMessage } from "../src/services/tool-safety.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) trashFixture(root); vi.restoreAllMocks(); });
it("injects a pinned zero-flight owner without token discovery or frequency fallback", () => {
  const f = createFixture(fixtureTempRoot()); roots.push(f.directory);
  const update = new DatabaseSync(f.mainPath); update.exec("DELETE FROM UserFlight; DELETE FROM UserManualFlight;"); update.close();
  const discovery = vi.spyOn(auth, "readFlightyAuthToken");
  const owner = { userId: IDS.owner, source: "replica_producer", label: "replica_export_scope", isFallback: false, isSharedOwner: false } as const;
  const db = new FlightyDatabase("", "", () => ({ dbPath: f.mainPath, ownerIdentity: owner, openDatabase: () => new DatabaseSync(f.mainPath, { readOnly: true }) }));
  runWithOwnerIdentityScope(() => { expect(db.listFlights()).toEqual([]); expect(getScopedOwnerIdentity()).toBe(owner); });
  expect(discovery).not.toHaveBeenCalled();
});
it("rejects a missing injected context rather than using the local reader", () => {
  const discovery = vi.spyOn(auth, "readFlightyAuthToken");
  const db = new FlightyDatabase("", "", () => { throw new Error("No lease"); });
  expect(() => db.listFlights()).toThrow("No lease"); expect(discovery).not.toHaveBeenCalled();
});
it("redacts Linux paths outside macOS or home prefixes", () => {
  const result = sanitizeToolErrorMessage("EACCES: cannot open '/srv/flighty/private/replica.db' and /mnt/cache/staging/file");
  expect(result).not.toContain("/srv"); expect(result).not.toContain("/mnt"); expect(result).toContain("redacted-path");
});
