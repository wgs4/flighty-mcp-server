import { DatabaseSync } from "node:sqlite";
import { closeSync, constants, fchmodSync, fsyncSync, lstatSync, openSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { boundedJson, ProtocolError } from "./protocol.js";

export type StoreOptions = {
  path: string;
  /** Must verify approved mount/source placement. Never defaults to an app path. */
  checkLocation: () => void;
  maxRows?: number;
};

/** One local writer per database; FULL SQLite commits precede every external side effect. */
export class PrivateStore {
  private readonly db: DatabaseSync;
  private readonly instance = randomUUID();
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly maxRows: number;
  private readonly checkLocation: () => void;

  constructor(options: StoreOptions) {
    options.checkLocation();
    this.checkLocation = options.checkLocation;
    this.maxRows = options.maxRows ?? 512;
    if (!Number.isSafeInteger(this.maxRows) || this.maxRows < 1 || this.maxRows > 4096 || !isAbsolute(options.path)) throw new ProtocolError();
    const parent = dirname(options.path);
    const directory = lstatSync(parent);
    if (!directory.isDirectory() || realpathSync(parent) !== resolve(parent) || (directory.mode & 0o077) ||
        (process.getuid && directory.uid !== process.getuid())) throw new ProtocolError("State directory must be private and owned by this identity.");
    const fd = openSync(options.path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      const file = lstatSync(options.path);
      if (!file.isFile() || file.nlink !== 1 || (file.mode & 0o077) || (process.getuid && file.uid !== process.getuid())) throw new ProtocolError("State file must be private and owned by this identity.");
      fchmodSync(fd, 0o600);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    const directoryFd = openSync(parent, constants.O_RDONLY);
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    this.db = new DatabaseSync(options.path);
    try {
      this.db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA max_page_count=8192; PRAGMA busy_timeout=1000;");
      this.db.exec("CREATE TABLE IF NOT EXISTS state (kind TEXT NOT NULL, id TEXT NOT NULL, doc TEXT NOT NULL, PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS writer (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, instance TEXT NOT NULL);");
      this.db.exec("BEGIN IMMEDIATE");
      const owner = this.db.prepare("SELECT pid FROM writer WHERE id=1").get() as { pid: number } | undefined;
      if (owner) {
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
        if (alive) throw new ProtocolError("State already has a live writer; no automatic takeover.");
      }
      this.db.prepare("INSERT OR REPLACE INTO writer VALUES(1,?,?)").run(process.pid, this.instance);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* No active transaction. */ }
      this.db.close();
      throw error;
    }
  }
  get<T>(kind: string, id: string): T | undefined {
    this.ready();
    const row = this.db.prepare("SELECT doc FROM state WHERE kind=? AND id=?").get(kind, id) as { doc: string } | undefined;
    return row ? JSON.parse(row.doc) as T : undefined;
  }
  list<T>(kind: string): Array<{ id: string; value: T }> {
    this.ready();
    return (this.db.prepare("SELECT id,doc FROM state WHERE kind=? ORDER BY id").all(kind) as Array<{ id: string; doc: string }>).map(r => ({ id: r.id, value: JSON.parse(r.doc) as T }));
  }
  put(kind: string, id: string, value: unknown): void {
    this.ready();
    const doc = boundedJson(value);
    const existing = this.get(kind, id);
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM state").get() as { n: number };
    if (!existing && count.n >= this.maxRows) throw new ProtocolError("Durable queue capacity reached.");
    this.db.prepare("INSERT OR REPLACE INTO state VALUES(?,?,?)").run(kind, id, doc);
  }
  delete(kind: string, id: string): void { this.ready(); this.db.prepare("DELETE FROM state WHERE kind=? AND id=?").run(kind, id); }
  transaction<T>(fn: () => T): T {
    this.ready(); this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(() => { this.ready(); return fn(); });
    this.tail = next.catch(() => undefined);
    return next;
  }
  close(): void {
    if (this.closed) return;
    this.db.prepare("DELETE FROM writer WHERE instance=?").run(this.instance);
    this.db.close(); this.closed = true;
  }
  private ready(): void {
    if (this.closed) throw new ProtocolError("State is closed.");
    this.checkLocation();
  }
}
