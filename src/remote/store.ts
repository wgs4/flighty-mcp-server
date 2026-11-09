import { DatabaseSync } from "node:sqlite";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { boundedJson, canonical, MAX_WIRE_BYTES, ProtocolError } from "./protocol.js";

export type StoreOptions = {
  path: string;
  /** Separate, durable continuity anchor; provision and protect it with the pinned identity/key. */
  continuityPath: string;
  identity: string;
  authenticationKey: Buffer;
  checkLocation: () => void;
  maxRows?: number;
  /** Required pure role validator; runs before writer recovery and every committed-state decision. */
  validateState: (rows: readonly StateRow[]) => void;
};
export type StateRow = { kind: string; id: string; value: unknown };
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const schemas = {
  state: "CREATE TABLE state (kind TEXT NOT NULL, id TEXT NOT NULL, doc TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY(kind,id))",
  writer: "CREATE TABLE writer (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, instance TEXT NOT NULL)",
  metadata: "CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, identity TEXT NOT NULL, revision INTEGER NOT NULL, root TEXT NOT NULL)",
};
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const anchorSchema = z.object({ version: z.literal(2), identity: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), root: hex,
  device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/), tag: hex }).strict();
type Anchor = z.infer<typeof anchorSchema>;
type Meta = { version: number; identity: string; revision: number; root: string };
type RawRow = { kind: string; id: string; doc: string; tag: string };

function fail(): never { throw new ProtocolError("Durable state continuity or authentication failed; operator recovery required. No dispatch is authorized."); }
function equal(a: string, b: string): boolean {
  return /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
function privateParent(path: string): void {
  const parent = dirname(path), info = lstatSync(parent);
  if (!info.isDirectory() || realpathSync(parent) !== resolve(parent) || (info.mode & 0o077) ||
      (process.getuid && info.uid !== process.getuid())) throw new ProtocolError("State directory must be private and owned by this identity.");
}
function privateFile(path: string, maxBytes: number, minBytes = 1): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) || info.size < minBytes || info.size > maxBytes ||
      (process.getuid && info.uid !== process.getuid())) fail();
}
function syncParent(path: string): void {
  const fd = openSync(dirname(path), constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Explicit initialization and authenticated, externally anchored recovery. Local filesystem only. */
export class PrivateStore {
  private readonly db: DatabaseSync;
  private readonly instance = randomUUID();
  private readonly options: StoreOptions;
  private readonly maxRows: number;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private faulted = false;
  private inTransaction = false;
  private pending = 0;
  private readonly consumers = new Set<string>();
  private validateState?: (rows: readonly StateRow[]) => void;

  /** Operator/provisioning action only. Neither missing file nor partial initialization is retried. */
  static initialize(options: StoreOptions): void {
    PrivateStore.checkOptions(options);
    if (existsSync(options.path) || existsSync(options.continuityPath)) fail();
    const fd = openSync(options.path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
    const db = new DatabaseSync(options.path);
    try {
      db.exec("PRAGMA page_size=4096; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA max_page_count=8192; PRAGMA user_version=2;");
      for (const sql of Object.values(schemas)) db.exec(sql);
      const meta = { version: 2, identity: options.identity, revision: 0, root: "" };
      meta.root = PrivateStore.root(options, db, [], meta.revision);
      db.prepare("INSERT INTO metadata VALUES(1,?,?,?,?)").run(meta.version, meta.identity, meta.revision, meta.root);
      const info = lstatSync(options.path, { bigint: true });
      const body = { ...meta, device: String(info.dev), inode: String(info.ino) };
      const anchor = { ...body, tag: PrivateStore.mac(options, "anchor", canonical(body)) };
      writeFileSync(options.continuityPath, canonical(anchor), { flag: "wx", mode: 0o600 });
      for (const path of [options.path, options.continuityPath]) {
        const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { fsyncSync(file); } finally { closeSync(file); }
        syncParent(path);
      }
    } finally { db.close(); }
  }

  constructor(input: StoreOptions) {
    PrivateStore.checkOptions(input);
    this.options = { ...input, authenticationKey: Buffer.from(input.authenticationKey) };
    this.maxRows = input.maxRows ?? 512;
    this.validateState = input.validateState;
    // No O_CREAT: loss/zeroing/replacement is uncertainty, never fresh dispatch authority.
    try {
      privateFile(input.path, MAX_FILE_BYTES, 4096);
      privateFile(input.continuityPath, 4096);
      for (const suffix of ["-wal", "-shm"]) if (existsSync(input.path + suffix)) fail();
      if (existsSync(input.path + "-journal")) privateFile(input.path + "-journal", MAX_FILE_BYTES + 1024 * 1024, 0);
    } catch { fail(); }
    this.db = new DatabaseSync(input.path);
    try {
      this.db.exec("PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000;");
      this.checkSchemaAndBounds();
      this.validateSnapshot();
      this.db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA max_page_count=8192;");
      this.transaction(() => {
        const owner = this.db.prepare("SELECT pid FROM writer WHERE id=1").get() as { pid: number } | undefined;
        if (owner) {
          let alive = true;
          try { process.kill(owner.pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
          if (alive) throw new ProtocolError("State already has a live writer; no automatic takeover.");
        }
        this.db.prepare("INSERT OR REPLACE INTO writer VALUES(1,?,?)").run(process.pid, this.instance);
      });
    } catch (error) { this.db.close(); throw error; }
  }
  private static checkOptions(options: StoreOptions): void {
    options.checkLocation();
    const maxRows = options.maxRows ?? 512;
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 4096 ||
        !isAbsolute(options.path) || !isAbsolute(options.continuityPath) || resolve(options.path) === resolve(options.continuityPath) ||
        !/^[A-Za-z0-9_-]{1,80}$/.test(options.identity) || !Buffer.isBuffer(options.authenticationKey) || options.authenticationKey.length < 32 || typeof options.validateState !== "function") throw new ProtocolError("State configuration rejected.");
    privateParent(options.path); privateParent(options.continuityPath);
  }
  private static mac(options: StoreOptions, domain: string, input: string): string {
    return createHmac("sha256", options.authenticationKey).update(`flighty-state-v2:${options.identity}:${domain}:`).update(input).digest("hex");
  }
  private static root(options: StoreOptions, db: DatabaseSync, rows: readonly RawRow[], revision: number): string {
    const writer = db.prepare("SELECT id,pid,instance FROM writer ORDER BY id LIMIT 2").all().map(row => ({ ...row }));
    if (writer.length > 1 || writer.some(r => r.id !== 1 || !Number.isSafeInteger(r.pid) || Number(r.pid) <= 0 || typeof r.instance !== "string" || !/^[a-f0-9-]{36}$/.test(r.instance))) fail();
    const hmac = createHmac("sha256", options.authenticationKey).update(`flighty-state-v2:${options.identity}:root:${revision}:`);
    hmac.update(canonical(writer));
    for (const row of rows) hmac.update(canonical(row));
    return hmac.digest("hex");
  }
  private checkSchemaAndBounds(): void {
    const pragma = (name: string) => Number(Object.values(this.db.prepare(`PRAGMA ${name}`).get()!)[0]);
    if (pragma("page_size") !== 4096 || pragma("page_count") > 8192 || pragma("user_version") !== 2) fail();
    if (this.db.prepare("SELECT 1 FROM sqlite_schema WHERE length(CAST(sql AS BLOB)) > 512 OR length(CAST(name AS BLOB)) > 80 LIMIT 1").get()) fail();
    const schema = this.db.prepare("SELECT name,type,sql FROM sqlite_schema ORDER BY name LIMIT 6").all();
    if (schema.length !== 4 || schema.some(r => r.name === "sqlite_autoindex_state_1" ? r.type !== "index" || r.sql !== null :
      r.type !== "table" || !Object.hasOwn(schemas, String(r.name)) || r.sql !== schemas[r.name as keyof typeof schemas])) fail();
    const counts = this.db.prepare("SELECT (SELECT COUNT(*) FROM state) AS n,(SELECT COUNT(*) FROM writer) AS w,(SELECT COUNT(*) FROM metadata) AS m").get()!;
    if (Number(counts.n) > this.maxRows || Number(counts.w) > 1 || counts.m !== 1) throw new ProtocolError("Existing durable state exceeds row/schema bounds.");
    if (this.db.prepare("SELECT 1 FROM writer WHERE id != 1 OR typeof(pid) != 'integer' OR pid < 1 OR pid > 2147483647 OR typeof(instance) != 'text' OR length(CAST(instance AS BLOB)) != 36 LIMIT 1").get() ||
        this.db.prepare("SELECT 1 FROM metadata WHERE id != 1 OR version != 2 OR typeof(identity) != 'text' OR length(CAST(identity AS BLOB)) > 80 OR typeof(revision) != 'integer' OR revision < 0 OR revision > 9007199254740991 OR typeof(root) != 'text' OR length(CAST(root AS BLOB)) != 64 LIMIT 1").get()) fail();
    const invalid = this.db.prepare("SELECT 1 FROM state WHERE typeof(doc) != 'text' OR length(CAST(doc AS BLOB)) > ? OR length(kind) > 40 OR length(id) > 80 OR typeof(tag) != 'text' OR length(tag) != 64 LIMIT 1").get(MAX_WIRE_BYTES);
    if (invalid) throw new ProtocolError("Existing durable state exceeds document bounds.");
  }
  private rows(): RawRow[] {
    this.checkSchemaAndBounds();
    const rows: RawRow[] = [];
    for (const item of this.db.prepare("SELECT kind,id,doc,tag FROM state ORDER BY kind,id LIMIT ?").iterate(this.maxRows + 1)) {
      const row = { ...item } as RawRow;
      if (!/^[a-z][a-z-]{0,39}$/.test(row.kind) || !/^[A-Za-z0-9_-]{1,80}$/.test(row.id) ||
          !equal(row.tag, PrivateStore.mac(this.options, "row", canonical({ kind: row.kind, id: row.id, doc: row.doc })))) fail();
      rows.push(row);
    }
    if (rows.length > this.maxRows) fail();
    return rows;
  }
  private parsed(rows: readonly RawRow[]): StateRow[] {
    return rows.map(row => {
      let value: unknown;
      try { value = JSON.parse(row.doc); if (boundedJson(value) !== row.doc) fail(); } catch { fail(); }
      return { kind: row.kind, id: row.id, value };
    });
  }
  private meta(): Meta {
    const meta = this.db.prepare("SELECT version,identity,revision,root FROM metadata WHERE id=1").get() as Meta | undefined;
    if (!meta || meta.version !== 2 || meta.identity !== this.options.identity || !Number.isSafeInteger(meta.revision) || meta.revision < 0 || !/^[a-f0-9]{64}$/.test(meta.root)) fail();
    return meta;
  }
  private validateSnapshot(): StateRow[] {
    privateFile(this.options.path, MAX_FILE_BYTES, 4096); privateFile(this.options.continuityPath, 4096);
    this.checkSchemaAndBounds();
    const anchorFd = openSync(this.options.continuityPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const bytes = Buffer.alloc(4097);
    let length: number;
    try { length = readSync(anchorFd, bytes, 0, bytes.length, 0); } finally { closeSync(anchorFd); }
    if (length < 1 || length > 4096) fail();
    let input: unknown;
    try { input = JSON.parse(bytes.subarray(0, length).toString("utf8")); } catch { fail(); }
    const anchorResult = anchorSchema.safeParse(input);
    if (!anchorResult.success) fail();
    const { tag, ...anchor } = anchorResult.data;
    const info = lstatSync(this.options.path, { bigint: true }), meta = this.meta(), rows = this.rows();
    if (anchor.identity !== this.options.identity || anchor.device !== String(info.dev) || anchor.inode !== String(info.ino) ||
        !equal(tag, PrivateStore.mac(this.options, "anchor", canonical(anchor))) || anchor.revision !== meta.revision ||
        !equal(anchor.root, meta.root) || !equal(meta.root, PrivateStore.root(this.options, this.db, rows, meta.revision))) fail();
    const parsed = this.parsed(rows);
    this.validateState?.(parsed);
    return parsed;
  }
  /** Pure role validator checks all records before any recovery, read, prune or dispatch decision. */
  setValidator(validate: (rows: readonly StateRow[]) => void): void {
    this.ready();
    const original = this.validateState;
    this.validateState = rows => { original?.(rows); validate(rows); };
    try { this.validateSnapshot(); } catch (error) { this.faulted = true; throw error; }
  }
  claimConsumer(name: string): void {
    this.ready(); if (this.consumers.has(name)) throw new ProtocolError("Store consumer is already active."); this.consumers.add(name);
  }
  get<T>(kind: string, id: string): T | undefined {
    this.ready();
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new ProtocolError();
    return this.readRows().find(r => r.kind === kind && r.id === id)?.value as T | undefined;
  }
  list<T>(kind: string): Array<{ id: string; value: T }> {
    this.ready(); return this.readRows().filter(r => r.kind === kind).map(r => ({ id: r.id, value: r.value as T }));
  }
  private readRows(): StateRow[] {
    if (!this.inTransaction) return this.validateSnapshot();
    // The outer transaction validated the committed snapshot; validate the complete new state at commit.
    return this.parsed(this.rows());
  }
  put(kind: string, id: string, value: unknown): void {
    if (!this.inTransaction) { this.transaction(() => this.put(kind, id, value)); return; }
    if (!/^[a-z][a-z-]{0,39}$/.test(kind) || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new ProtocolError();
    const doc = boundedJson(value), existing = this.db.prepare("SELECT 1 FROM state WHERE kind=? AND id=?").get(kind, id);
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM state").get()!;
    if (!existing && Number(count.n) >= this.maxRows) throw new ProtocolError("Durable queue capacity reached.");
    const tag = PrivateStore.mac(this.options, "row", canonical({ kind, id, doc }));
    this.db.prepare("INSERT OR REPLACE INTO state VALUES(?,?,?,?)").run(kind, id, doc, tag);
  }
  delete(kind: string, id: string): void {
    if (!this.inTransaction) { this.transaction(() => this.delete(kind, id)); return; }
    this.db.prepare("DELETE FROM state WHERE kind=? AND id=?").run(kind, id);
  }
  transaction<T>(fn: () => T): T {
    this.ready();
    if (this.inTransaction) throw new ProtocolError("Nested state transaction rejected.");
    this.db.exec("BEGIN IMMEDIATE"); this.inTransaction = true;
    let committed = false;
    try {
      const result = fn(), rows = this.rows();
      this.validateState?.(this.parsed(rows));
      const revision = this.meta().revision + 1;
      if (!Number.isSafeInteger(revision)) fail();
      const root = PrivateStore.root(this.options, this.db, rows, revision);
      this.db.prepare("UPDATE metadata SET revision=?,root=? WHERE id=1").run(revision, root);
      this.db.exec("COMMIT"); committed = true; this.inTransaction = false;
      // A crash between DB commit and anchor publication intentionally blocks normal recovery.
      this.publishAnchor(revision, root);
      return result;
    } catch (error) {
      if (!committed) { try { this.db.exec("ROLLBACK"); } catch { /* Preserve the original disk/transaction error. */ } }
      else this.faulted = true;
      throw error;
    } finally { this.inTransaction = false; }
  }
  private publishAnchor(revision: number, root: string): void {
    const info = lstatSync(this.options.path, { bigint: true });
    const body = { version: 2 as const, identity: this.options.identity, revision, root, device: String(info.dev), inode: String(info.ino) };
    const anchor: Anchor = { ...body, tag: PrivateStore.mac(this.options, "anchor", canonical(body)) };
    const stage = this.options.continuityPath + ".stage-" + randomUUID();
    const fd = openSync(stage, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, canonical(anchor)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(stage, this.options.continuityPath); syncParent(this.options.continuityPath);
  }
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.pending++;
    const next = this.tail.then(() => { this.ready(); return fn(); }).finally(() => { this.pending--; });
    this.tail = next.catch(() => undefined); return next;
  }
  close(): void {
    if (this.closed) return;
    if (this.pending) throw new ProtocolError("Cannot close state while execution is active.");
    try {
      if (!this.faulted) this.transaction(() => { this.db.prepare("DELETE FROM writer WHERE instance=?").run(this.instance); });
    } finally { this.db.close(); this.closed = true; }
  }
  private ready(): void {
    if (this.closed || this.faulted) throw new ProtocolError("Durable state unavailable; operator recovery required.");
    this.options.checkLocation();
    if (!this.inTransaction) {
      try { this.validateSnapshot(); } catch (error) { this.faulted = true; throw error; }
    }
  }
}
