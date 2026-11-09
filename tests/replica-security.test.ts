import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CREATE_REPLICA_SCHEMA_SQL, REPLICA_TABLE_NAMES, validateReplicaDatabaseSchemaAndContents, exportReplicaBundle, ReplicaError } from "../src/replica/index.js";
import { exportSyntheticBundle, receiverStorage } from "./replica-support.js";
import { createFixture, IDS } from "./fixture/create.mjs";
import { fixtureTempRoot, trashFixture } from "./fixture/lifecycle.mjs";
import { FlightyDatabase } from "../src/services/database.js";
const keys = generateKeyPairSync("ed25519");
const roots: string[] = [];
function fixture() { const root = mkdtempSync(join(fixtureTempRoot(), "replica-security-")); roots.push(root); return {root, ...createFixture(root)}; }
function options(f: ReturnType<typeof fixture>, extra = {}) { return {sourceDbPath:f.mainPath, outputBundleDir:join(f.root,"bundle"), requiredMountPath:f.root, signingPrivateKey:keys.privateKey, producerId:"producer", accountId:"synthetic", ownerUserId:IDS.owner, epoch:1, sequence:1, ...extra}; }
function mutate(f: ReturnType<typeof fixture>, fn: (db: DatabaseSync) => void) { const db = new DatabaseSync(f.mainPath); try {fn(db);} finally {db.close();} }
afterEach(() => {for (const root of roots.splice(0)) trashFixture(root);});

describe("replica source trust and work bounds", () => {
  it("rejects virtual external content before it can export a forbidden Account value", async () => {
    const f=fixture();
    mutate(f, db => db.exec(`DROP TABLE Profile; CREATE VIEW Hidden AS SELECT '${IDS.owner}' AS userId, authToken AS fullName, 'x' AS firstName FROM Account; CREATE VIRTUAL TABLE Profile USING fts5(userId,fullName,firstName,content='Hidden');`));
    await expect(exportSyntheticBundle(options(f))).rejects.toMatchObject({code:"SOURCE_SCHEMA_INVALID"});
    expect(existsSync(join(f.root,"bundle"))).toBe(false);
  });
  it("rejects CHECK and generated expressions before quick_check evaluates them", () => {
    const f=fixture(); const db = new DatabaseSync(join(f.root,"constraint.db")); let calls=0;
    db.function("tripwire",{deterministic:true},()=>{calls++;return 1;});
    db.exec(CREATE_REPLICA_SCHEMA_SQL.replace("CREATE TABLE Flight (", "CREATE TABLE Flight (sentinel INTEGER CHECK(tripwire() = 1), "));
    db.exec("INSERT INTO Flight(id) VALUES ('x')"); calls=0;
    expect(()=>validateReplicaDatabaseSchemaAndContents(db, {rowCounts:Object.fromEntries(REPLICA_TABLE_NAMES.map(t=>[t,0]))} as never)).toThrowError(expect.objectContaining({code:"DB_SCHEMA_INVALID"}));
    expect(calls).toBe(0); db.close();
  });
  it("preserves deleted reference joins, reference ambiguity, UUID case, nullable connections and selected bookings", async () => {
    const f=fixture();
    mutate(f,db=>{db.exec("UPDATE Airline SET deleted=1; UPDATE Airport SET deleted=1 WHERE id='airport-b'; UPDATE Connection SET id=NULL;"); db.prepare("UPDATE UserFlight SET userId=? WHERE userId=?").run(IDS.owner.toUpperCase(),IDS.owner);});
    const out=await exportSyntheticBundle(options(f,{ownerUserId:IDS.owner.toUpperCase()}));
    const db=new FlightyDatabase(out.dbPath,join(f.root,"unused.db"));
    expect(db.listFlights()).toHaveLength(2);
    const raw = new DatabaseSync(out.dbPath,{readOnly:true});
    expect(raw.prepare("SELECT COUNT(*) n FROM Connection WHERE id IS NULL").get()?.n).toBe(1);
    expect(raw.prepare("SELECT COUNT(*) n FROM Ticket").get()?.n).toBe(2);raw.close();
  });
  it("rejects ambiguous duplicate source identities and SyncInfo overflow", async () => {
    const f=fixture(); mutate(f,db=>db.exec("INSERT INTO Flight SELECT * FROM Flight LIMIT 1"));
    await expect(exportSyntheticBundle(options(f))).rejects.toMatchObject({code:"DB_CONTENT_INVALID"});
    const g=fixture();mutate(g,db=>{db.exec("DELETE FROM SyncInfo");for(let i=0;i<33;i++)db.prepare("INSERT INTO SyncInfo(lastSync) VALUES (?)").run("2026-11-08T20:00:00Z");});
    await expect(exportSyntheticBundle(options(g))).rejects.toMatchObject({code:"EXPORT_BOUNDS_EXCEEDED"});
  });
  it("bounds source bytes, rows, cells and native total duration without publishing partial output", async () => {
    for (const limits of [{maxSourceDbBytes:1024},{maxRowsPerTable:2},{maxCellBytes:4},{maxOperationDurationMs:1}]) {
      const f=fixture();
      await expect(exportSyntheticBundle(options(f,{limits}))).rejects.toBeInstanceOf(ReplicaError);
      expect(existsSync(join(f.root,"bundle"))).toBe(false);
    }
  });
  it("requires mount identity and redacts filesystem setup errors", async () => {
    const f=fixture();
    await expect(exportReplicaBundle({...options(f),storage:undefined,quarantineDir:join(f.root,"q")} as never)).rejects.toMatchObject({code:"MOUNT_UNAVAILABLE"});
    const authority=receiverStorage(join(f.root,"state"));
    await expect(exportReplicaBundle({...options(f),storage:{...authority,validateMount:()=>false},quarantineDir:join(f.root,"q")})).rejects.toMatchObject({code:"MOUNT_UNAVAILABLE"});
  });
  it("allows a valid signed zero-flight account and keeps full raw snapshots outside the export parent", async () => {
    const f=fixture();mutate(f,db=>db.exec("DELETE FROM UserFlight; DELETE FROM UserManualFlight; DELETE FROM Ticket; DELETE FROM Profile; DELETE FROM Connection;"));
    const out=await exportSyntheticBundle(options(f));expect(out.manifest.rowCounts.Flight).toBe(0);
    expect(readdirSync(out.bundleDir).sort()).toEqual(["manifest.json","replica.db"]);
    expect(readdirSync(f.root).some(x=>x.includes("trash")||x.includes("snapshot"))).toBe(false);
  });
});
