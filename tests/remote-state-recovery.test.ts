import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, readFileSync, renameSync, truncateSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { MacExecutor } from "../src/remote/executor.js";
import { PrivateStore } from "../src/remote/store.js";
import { ProtocolError, open, seal, verifyReceipt, verifyRequest } from "../src/remote/protocol.js";
import { fixture, FLIGHT, type Fixture } from "./remote-fixture.js";
const fixtures: Fixture[] = [];
const setup = () => { const f = fixture(); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0)) { try { f.close(); } catch { /* Corrupted stores are intentionally unavailable. */ } } });
const add = { kind: "add", flight_code: "UA194", date: "2027-01-01" } as const;
function mutate(f: Fixture, fn: (db: DatabaseSync) => void) {
  f.store.close(); const db = new DatabaseSync(f.storeOptions("mac").path);
  try { fn(db); } finally { db.close(); }
}

describe("explicit initialization and recovery continuity", () => {
  it("does not create authority on a missing uninitialized path", () => {
    const f = setup(), options = f.storeOptions("never-initialized");
    expect(() => new PrivateStore(options)).toThrow(ProtocolError);
    PrivateStore.initialize(options); const store = new PrivateStore(options); store.close();
    expect(() => PrivateStore.initialize(options)).toThrow(ProtocolError);
  });
  it.each(["missing", "zero", "replacement", "lost-anchor", "replaced-anchor"] as const)("fails closed after dispatch when state is %s", async change => {
    const f = setup(), request = f.request(add); await f.executor.submit(request); f.store.close();
    const options = f.storeOptions("mac");
    if (change === "missing") renameSync(options.path, options.path + ".moved-fixture");
    if (change === "zero") truncateSync(options.path, 0);
    if (change === "replacement") { renameSync(options.path, options.path + ".moved-fixture"); copyFileSync(options.path + ".moved-fixture", options.path); }
    if (change === "lost-anchor") renameSync(options.continuityPath, options.continuityPath + ".moved-fixture");
    if (change === "replaced-anchor") { const a = JSON.parse(readFileSync(options.continuityPath, "utf8")); a.revision = 0; writeFileSync(options.continuityPath, JSON.stringify(a)); }
    expect(() => new PrivateStore(options)).toThrow(/continuity|authentication|operator/);
    expect(() => PrivateStore.initialize(options)).toThrow(ProtocolError);
    expect(f.api.subscribeFlight).toHaveBeenCalledTimes(1);
  });
  it("rejects an older whole database at the same inode when the external revision is current", async () => {
    const f = setup(), options = f.storeOptions("mac");
    const before = readFileSync(options.path); await f.executor.submit(f.request(add)); f.store.close();
    writeFileSync(options.path, before);
    expect(() => new PrivateStore(options)).toThrow(ProtocolError); expect(f.api.subscribeFlight).toHaveBeenCalledTimes(1);
  });
  it("a DB-commit/anchor-publication gap becomes unavailable, never new replay authority", async () => {
    const f = setup(); vi.spyOn(f.store as any, "publishAnchor").mockImplementationOnce(() => { throw new Error("synthetic anchor disk failure"); });
    await expect(f.executor.submit(f.request(add))).rejects.toThrow("synthetic anchor disk failure");
    expect(f.api.subscribeFlight).not.toHaveBeenCalled(); f.store.close();
    expect(() => new PrivateStore(f.storeOptions("mac"))).toThrow(ProtocolError);
  });
});

describe("authenticated recovery records and tombstones", () => {
  it("changing a signed successful receipt back to queued cannot replay", async () => {
    const f = setup(), request = f.request(add); await f.executor.submit(request);
    mutate(f, db => {
      const row = db.prepare("SELECT doc FROM state WHERE kind='operation'").get()!;
      const value = JSON.parse(String(row.doc)); value.receipt.body.state = "not-dispatched";
      db.prepare("UPDATE state SET doc=? WHERE kind='operation'").run(JSON.stringify(value));
    });
    expect(() => new PrivateStore(f.storeOptions("mac"))).toThrow(ProtocolError); expect(f.api.subscribeFlight).toHaveBeenCalledTimes(1);
  });
  it("changing a consumed preview flag cannot authorize another deletion", async () => {
    const f = setup(), preview = await f.executor.submit(f.request({ kind: "remove-preview", flight_id: FLIGHT }));
    const code = (preview.body.result as any).confirm_code;
    await f.executor.submit(f.request({ kind: "remove-confirm", flight_id: FLIGHT, confirm_code: code }));
    mutate(f, db => {
      const row = db.prepare("SELECT doc FROM state WHERE kind='preview' AND id=?").get(code)!;
      const value = JSON.parse(String(row.doc)); value.consumed = false;
      db.prepare("UPDATE state SET doc=? WHERE kind='preview' AND id=?").run(JSON.stringify(value), code);
    });
    expect(() => new PrivateStore(f.storeOptions("mac"))).toThrow(ProtocolError); expect(f.api.deleteFlight).toHaveBeenCalledTimes(1);
  });
  it("row deletion cannot silently remove dispatch history", async () => {
    const f = setup(); await f.executor.submit(f.request(add)); mutate(f, db => db.exec("DELETE FROM state"));
    expect(() => new PrivateStore(f.storeOptions("mac"))).toThrow(ProtocolError);
  });
  it("valid store authentication cannot substitute for a valid Mac receipt signature", async () => {
    const f = setup(), req = f.request(add); await f.executor.submit(req); f.store.close();
    const store = new PrivateStore({ ...f.storeOptions("mac"), validateState: () => {} }), op = store.get<any>("operation", req.body.operationId);
    op.receipt.body.state = "not-dispatched"; store.put("operation", req.body.operationId, op); store.close();
    expect(() => new PrivateStore(f.storeOptions("mac"))).toThrow(ProtocolError);
    expect(f.api.subscribeFlight).toHaveBeenCalledTimes(1);
  });
  it.each(["request-id", "receipt-binding", "unknown-field", "retention-override"])("strict role validation rejects authenticated invalid state: %s", async change => {
    const f = setup(), req = f.request(add); await f.executor.submit(req); f.store.close();
    const store = new PrivateStore({ ...f.storeOptions("mac"), validateState: () => {} }), op = store.get<any>("operation", req.body.operationId);
    if (change === "request-id") op.request = f.request(add);
    if (change === "receipt-binding") op.receipt = seal("receipt", { ...op.receipt.body, account: "other" }, f.mac.privateKey);
    if (change === "unknown-field") op.unexpected = true;
    if (change === "retention-override") op.retainUntil = 0;
    store.put("operation", req.body.operationId, op); store.close();
    expect(() => new PrivateStore(f.storeOptions("mac"))).toThrow(ProtocolError);
  });
  it("detects tampering while a store is already open before any pruning decision", async () => {
    const f = setup(), req = f.request(add); await f.executor.submit(req);
    const db = new DatabaseSync(f.storeOptions("mac").path); db.exec("DELETE FROM state"); db.close();
    expect(() => f.executor.maintenance()).toThrow(ProtocolError); expect(f.api.subscribeFlight).toHaveBeenCalledTimes(1);
  });
});

describe("bounds on preexisting state before parsing", () => {
  it.each(["rows", "document", "file", "extra-schema", "page-size"] as const)("rejects oversized/invalid existing %s", change => {
    const f = setup(); f.store.close(); const options = f.storeOptions("mac");
    if (change === "file") truncateSync(options.path, 33 * 1024 * 1024);
    else {
      const db = new DatabaseSync(options.path);
      try {
        if (change === "rows") {
          const insert = db.prepare("INSERT INTO state VALUES('fixture',?,?,?)"); db.exec("BEGIN");
          for (let n = 0; n < 513; n++) insert.run("row-" + n, "{}", "0".repeat(64)); db.exec("COMMIT");
        }
        if (change === "document") db.prepare("INSERT INTO state VALUES('fixture','huge',?,?)").run(JSON.stringify({ huge: "x".repeat(100_000) }), "0".repeat(64));
        if (change === "extra-schema") db.exec("CREATE TABLE unexpected (data TEXT)");
        if (change === "page-size") db.exec("PRAGMA page_size=8192; VACUUM");
      } finally { db.close(); }
    }
    expect(() => new PrivateStore(options)).toThrow(ProtocolError);
  });
  it("revalidates the authenticated snapshot after obtaining the write lock", async () => {
    const f = setup(), req = f.request(add); f.deps.boundary = name => { if (name === "queued") throw new Error("queued snapshot"); };
    await expect(f.executor.submit(req)).rejects.toThrow("queued snapshot"); f.deps.boundary = undefined;
    const read = new DatabaseSync(f.storeOptions("mac").path);
    const oldRows = read.prepare("SELECT kind,id,doc,tag FROM state").all();
    const oldMeta = read.prepare("SELECT revision,root FROM metadata").get()!; read.close();
    await f.executor.submit(req); expect(f.api.subscribeFlight).toHaveBeenCalledTimes(1);
    const db = (f.store as any).db as DatabaseSync, exec = db.exec.bind(db); let restored = false;
    const spy = vi.spyOn(db, "exec").mockImplementation(sql => {
      if (sql === "BEGIN IMMEDIATE" && !restored) {
        restored = true; const attacker = new DatabaseSync(f.storeOptions("mac").path); attacker.exec("BEGIN; DELETE FROM state");
        const insert = attacker.prepare("INSERT INTO state VALUES(?,?,?,?)");
        for (const row of oldRows) insert.run(row.kind, row.id, row.doc, row.tag);
        attacker.prepare("UPDATE metadata SET revision=?,root=?").run(oldMeta.revision, oldMeta.root); attacker.exec("COMMIT"); attacker.close();
      }
      return exec(sql);
    });
    try { await expect(f.executor.submit(f.request(add))).rejects.toThrow(ProtocolError); } finally { spy.mockRestore(); }
    expect(restored).toBe(true); expect(f.api.subscribeFlight).toHaveBeenCalledTimes(1);
  });
  it("preserves the original exception when SQLite rollback also fails", () => {
    const f = setup(), db = (f.store as any).db as DatabaseSync, exec = db.exec.bind(db);
    const spy = vi.spyOn(db, "exec").mockImplementation(sql => { if (sql === "ROLLBACK") { exec(sql); throw new Error("secondary rollback failure"); } return exec(sql); });
    const original = new Error("original disk full");
    try { expect(() => f.store.transaction(() => { throw original; })).toThrow(original); } finally { spy.mockRestore(); }
  });
});

describe("strict protocol failure types", () => {
  it.each([[null], [true], [1], ["text"], [[]], [{}]])("rejects primitive or malformed envelope %j safely", input => {
    const f = setup(), req = f.request(add);
    expect(() => open("request", input as any, f.caller.publicKey)).toThrow(ProtocolError);
    expect(() => verifyRequest(input as any, f.callers, f.now)).toThrow(ProtocolError);
    expect(() => verifyReceipt(input as any, f.mac.publicKey, req.body)).toThrow(ProtocolError);
  });
  it.each([{ updatedAt: -1 }, { error: 4 }, { extra: true }, { state: "invented" }])("rejects even signed invalid receipt fields: %j", change => {
    const f = setup(), req = f.request(add);
    const receipt = seal("receipt", { version: 1, operationId: req.body.operationId, caller: req.body.caller, account: req.body.account,
      requestDigest: "0".repeat(64), state: "succeeded", updatedAt: f.now, ...change }, f.mac.privateKey);
    expect(() => verifyReceipt(receipt, f.mac.publicKey, req.body)).toThrow(ProtocolError);
  });
});
