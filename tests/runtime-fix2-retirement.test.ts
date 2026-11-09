import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, basename } from "node:path";
import { createHash, createHmac, sign } from "node:crypto";
import { runtimeFixture } from "./runtime-fixture.js";
import { provisionLinux, openLinux } from "../src/runtime/linux.js";
import { provisionMac, openMac, defaultMacReaders } from "../src/runtime/mac.js";
import { validateConfig } from "../src/runtime/config.js";
import { archiveResolvedClient, retireArtifacts, retireRecovery, inspectStore, RetirementError } from "../src/runtime/maintenance.js";
import { canonical, digest, makeRequest, seal } from "../src/remote/protocol.js";
import { trashFixture } from "./fixture/lifecycle.mjs";
vi.mock("node:fs", async original => { const actual = await original<typeof import("node:fs")>(); return { ...actual, lstatSync: vi.fn(actual.lstatSync) }; });
const realStat = (await vi.importActual<typeof import("node:fs")>("node:fs")).lstatSync;
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.mocked(fs.lstatSync).mockImplementation(realStat); for (const root of roots.splice(0)) trashFixture(root); });
const old = () => new Date(Date.now() - 4 * 86400000);
function fixture() { const f = runtimeFixture(); roots.push(f.root); return f; }
function archiveName(kind: string, id: string) { return createHash("sha256").update(kind + "\0" + id).digest("hex") + ".json"; }
function archived(state: "succeeded" | "unknown" = "succeeded", id = "resolved-unknown") {
  const f = fixture(); f.linux.operatorPublicKey = f.macConfig.operatorPublicKey; provisionLinux(f.linux);
  const r = openLinux(f.linux), issuedAt = +old();
  const request = makeRequest({caller:"linux",account:f.linux.pins.accountId,operationId:id,issuedAt,expiresAt:issuedAt+1000,operation:{kind:"request-snapshot"}},f.caller.privateKey);
  const receipt = seal("receipt",{version:1,caller:"linux",account:request.body.account,operationId:id,requestDigest:digest(request.body),state,updatedAt:issuedAt+500},f.mac.privateKey);
  r.clientStore.put("client",id,{request,status:{queue:"receipted",receipt}});
  if (state === "succeeded") { r.clientStore.archive("client",id); r.clientStore.delete("client",id); }
  r.close(); return { f, request, root:f.linux.clientStore.path+".archive" };
}
function resolveUnknown(f: ReturnType<typeof fixture>, request: ReturnType<typeof makeRequest>) {
  const now=Date.now(),body={version:1,action:"clear-account-fence-after-external-check",account:request.body.account,operationId:request.body.operationId,requestDigest:digest(request.body),fenceDigest:digest({request,state:"unresolved"}),auditId:"audit-0",operator:"independent-fixture",evidenceSha256:"a".repeat(64),checkedAt:now,issuedAt:now,expiresAt:now+300000,statement:"External outcome checked; authorize future distinct operations; original outcome remains unknown; do not replay."};
  archiveResolvedClient(f.linux,{body,signature:sign(null,Buffer.from("flighty-operator-reconciliation-v1:"+canonical(body)),f.operator.privateKey).toString("base64")});
}
function raw(f: ReturnType<typeof fixture>, fresh = false) {
  const path=join(f.macConfig.rawQuarantine,"raw-backup-11111111-1111-4111-8111-111111111111");
  fs.mkdirSync(path,{mode:0o700}); const child=join(path,"source-snapshot.db"); fs.writeFileSync(child,"synthetic-raw",{mode:0o600});
  if (!fresh) fs.utimesSync(child,old(),old()); fs.utimesSync(path,old(),old()); return path;
}
it.each(["wrong-name", "wrong-name-with-derived", "bad-mac", "bad-signature", "wrong-role"])("authenticates actual archive bytes before retirement: %s", mode => {
  const {f,root}=archived(); const correct=join(root,archiveName("client","resolved-unknown")); const doc=JSON.parse(fs.readFileSync(correct,"utf8"));
  let path=correct;
  if(mode.startsWith("wrong-name")) { path=join(root,"0".repeat(64)+".json");if(mode==="wrong-name")fs.renameSync(correct,path);doc.tag="0".repeat(64); }
  if(mode==="bad-mac") doc.tag="0".repeat(64);
  if(mode==="bad-signature") doc.value.status.receipt.signature="A".repeat(86)+"==";
  if(mode==="wrong-role") { doc.kind="sequence";doc.id="producer";fs.renameSync(path,path=join(root,archiveName(doc.kind,doc.id)));doc.value={next:1}; }
  if(["bad-signature","wrong-role"].includes(mode)) { const {tag,...body}=doc;doc.tag=createHmac("sha256",Buffer.from(f.linux.clientStore.authenticationKey,"hex")).update(`flighty-state-v2:${f.linux.clientStore.identity}:archive:`).update(canonical(body)).digest("hex"); }
  fs.writeFileSync(path,canonical(doc)); const helper=vi.fn(); expect(()=>retireArtifacts(f.linux,"history",1,helper)).toThrow();expect(helper).not.toHaveBeenCalled();expect(fs.existsSync(path)).toBe(true);
});
it.each(["identityFile","knownHostsFile","retirementCommand"])("rejects configured authority inside an enclosing generated artifact: %s", field => {
  const f=fixture(),path=raw(f),authority=join(path,field==="retirementCommand"?"trash":"authority");fs.writeFileSync(authority,"private-fixture",{mode:0o600});
  if(field==="retirementCommand") f.macConfig.retirementCommand=authority; else f.macConfig.ssh[field as "identityFile"|"knownHostsFile"]=authority;
  expect(()=>validateConfig(f.macConfig)).toThrow();expect(()=>provisionMac(f.macConfig)).toThrow();const helper=vi.fn();expect(()=>retireArtifacts(f.macConfig,"quarantine",1,helper)).toThrow();expect(helper).not.toHaveBeenCalled();
});
it("skips a complete recognized artifact if a descendant is fresh and rejects unrelated layout",()=>{
  const f=fixture();provisionMac(f.macConfig);const path=raw(f,true),helper=vi.fn();expect(retireArtifacts(f.macConfig,"quarantine",1,helper)).toBe(0);expect(helper).not.toHaveBeenCalled();
  fs.writeFileSync(join(path,"recent-user-document"),"retain",{mode:0o600});expect(()=>retireArtifacts(f.macConfig,"quarantine",1,helper)).toThrow();expect(helper).not.toHaveBeenCalled();
});
it.each(["mount","candidate-device","descendant-device"])("rejects changed storage authority during traversal before helper: %s",mode=>{
  const f=fixture();provisionMac(f.macConfig);const path=raw(f),stat=vi.mocked(fs.lstatSync).getMockImplementation()!,mount=f.macConfig.storage.mountInode;
  vi.spyOn(fs,"lstatSync").mockImplementation(((p:any,...args:any[])=>{const st=(stat as any)(p,...args);if(String(p)===(mode==="descendant-device"?join(path,"source-snapshot.db"):path)){if(mode==="mount")f.macConfig.storage.mountInode=mount+1;else st.dev+=typeof st.dev==="bigint"?1n:1;}return st;}) as any);
  const helper=vi.fn();try{expect(()=>retireArtifacts(f.macConfig,"quarantine",1,helper)).toThrow();expect(helper).not.toHaveBeenCalled();}finally{vi.restoreAllMocks();vi.mocked(fs.lstatSync).mockImplementation(realStat);f.macConfig.storage.mountInode=mount;}expect(fs.readFileSync(join(path,"source-snapshot.db"),"utf8")).toBe("synthetic-raw");
});
it("limit-one retirement preserves proof until its UNKNOWN dependent moves, across failure and restart",()=>{
  const {f,request,root}=archived("unknown");resolveUnknown(f,request);const proof=archiveName("client-resolution","audit-0"),client=archiveName("client",request.body.operationId);expect(proof<client).toBe(true);
  const moved:string[]=[];const helper=(p:string)=>{moved.push(basename(p));fs.renameSync(p,join(f.root,"recoverable-"+moved.length));};
  expect(retireArtifacts(f.linux,"history",1,helper)).toBe(1);expect(moved).toEqual([client]);expect(fs.existsSync(join(root,proof))).toBe(true);
  const r=openLinux(f.linux);expect(r.clientStore.archived("client-resolution","audit-0")).toBeTruthy();r.close();
  expect(()=>retireArtifacts(f.linux,"history",1,()=>{throw new Error("helper failed");})).toThrow();expect(fs.existsSync(join(root,proof))).toBe(true);
  expect(retireArtifacts(f.linux,"history",1,helper)).toBe(1);expect(moved).toEqual([client,proof]);
});
it("normal aged successful history and complete raw artifacts retire recoverably",()=>{
  const {f}=archived();expect(retireArtifacts(f.linux,"history",1,p=>fs.renameSync(p,join(f.root,"recoverable-history")))).toBe(1);
  provisionMac(f.macConfig);const path=raw(f);expect(retireArtifacts(f.macConfig,"quarantine",1,p=>fs.renameSync(p,join(f.root,"recoverable-raw")))).toBe(1);expect(fs.existsSync(path)).toBe(false);
});

it("history mount loss after authenticated reads never reaches a helper",()=>{
  const {f,root}=archived(),path=join(root,archiveName("client","resolved-unknown")),stat=vi.mocked(fs.lstatSync).getMockImplementation()!,mount=f.linux.storage.mountInode;
  vi.spyOn(fs,"lstatSync").mockImplementation(((p:any,...args:any[])=>{const st=(stat as any)(p,...args);if(String(p)===path)f.linux.storage.mountInode=mount+1;return st;}) as any);
  const helper=vi.fn();try{expect(()=>retireArtifacts(f.linux,"history",1,helper)).toThrow();expect(helper).not.toHaveBeenCalled();}finally{vi.restoreAllMocks();vi.mocked(fs.lstatSync).mockImplementation(realStat);f.linux.storage.mountInode=mount;}expect(fs.existsSync(path)).toBe(true);
});
it("recovery audit traversal losing mount authority never reaches a helper",()=>{
  const f=fixture();f.linux.operatorPublicKey=f.macConfig.operatorPublicKey;provisionLinux(f.linux);const info=inspectStore(f.linux,"linux-client"),past=+old();
  const body={version:1,action:"recover-continuity",mode:"repair-ahead",...info,nonce:"aged-audit",issuedAt:past,expiresAt:past+300000};
  const root=f.linux.clientStore.continuityPath+".recovery",path=join(root,"aged-audit.json");fs.mkdirSync(root,{mode:0o700});fs.writeFileSync(path,JSON.stringify({body,signature:sign(null,Buffer.from("flighty-continuity-recovery-v1:"+canonical(body)),f.operator.privateKey).toString("base64")}),{mode:0o600});
  const stat=vi.mocked(fs.lstatSync).getMockImplementation()!,mount=f.linux.storage.mountInode;vi.spyOn(fs,"lstatSync").mockImplementation(((p:any,...args:any[])=>{const st=(stat as any)(p,...args);if(String(p)===path)f.linux.storage.mountInode=mount+1;return st;}) as any);
  const helper=vi.fn();try{expect(()=>retireRecovery(f.linux,"linux-client",1,helper)).toThrow();expect(helper).not.toHaveBeenCalled();}finally{vi.restoreAllMocks();vi.mocked(fs.lstatSync).mockImplementation(realStat);f.linux.storage.mountInode=mount;}expect(fs.existsSync(path)).toBe(true);
  expect(retireRecovery(f.linux,"linux-client",1,p=>fs.renameSync(p,join(f.root,"recoverable-audit")))).toBe(1);
});
it("a partial history batch reports its completed moves and preserves resumable proof",()=>{
  const {f,request,root}=archived("unknown");resolveUnknown(f,request);let calls=0;let failure:unknown;
  try{retireArtifacts(f.linux,"history",2,p=>{if(++calls===2)throw new Error("synthetic helper failure");fs.renameSync(p,join(f.root,"recoverable-first"));});}catch(error){failure=error;}
  expect(failure).toBeInstanceOf(RetirementError);expect((failure as RetirementError).retired).toBe(1);
  expect(fs.existsSync(join(root,archiveName("client-resolution","audit-0")))).toBe(true);
  const r=openLinux(f.linux);expect(r.clientStore.archived("client","resolved-unknown")).toBeUndefined();r.close();
  expect(retireArtifacts(f.linux,"history",1,p=>fs.renameSync(p,join(f.root,"recoverable-second")))).toBe(1);
});
it("a helper that does not move bytes cannot claim successful retirement",()=>{
  const f=fixture();provisionMac(f.macConfig);const path=raw(f);let failure:unknown;try{retireArtifacts(f.macConfig,"quarantine",1,()=>{});}catch(error){failure=error;}
  expect(failure).toBeInstanceOf(RetirementError);expect((failure as RetirementError).retired).toBe(0);expect(fs.existsSync(path)).toBe(true);
});
it("unresolved UNKNOWN remains ineligible without independent proof",()=>{
  const {f,request}=archived("unknown"),r=openLinux(f.linux);r.clientStore.archive("client",request.body.operationId);r.clientStore.delete("client",request.body.operationId);r.close();const helper=vi.fn();expect(retireArtifacts(f.linux,"history",1,helper)).toBe(0);expect(helper).not.toHaveBeenCalled();
});
it("compiled CLI rejects enclosing SSH authority and retires only an aged complete artifact with mocked helper execution",()=>{
  const previousTmp=process.env.TMPDIR;process.env.TMPDIR=fs.realpathSync("/tmp");
  let f:ReturnType<typeof fixture>;try{f=fixture();}finally{if(previousTmp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previousTmp;}
  const path=raw(f);f.macConfig.ssh.identityFile=join(path,"source-snapshot.db");let file=f.configFile("mac");
  const cli=fileURLToPath(new URL("../build/runtime/cli.js",import.meta.url));
  const run=(args:string[],mock=false)=>spawnSync(process.execPath,[...(mock?["--import",fileURLToPath(new URL("./runtime-retirement-preload.mjs",import.meta.url))]:[]),cli,...args],{env:{PATH:process.env.PATH,FLIGHTY_TEST_RETIRE_ROOT:f.root},encoding:"utf8",timeout:5000});
  expect(run(["init-mac","--config",file]).status).toBe(1);expect(fs.existsSync(f.macConfig.store.path)).toBe(false);
  f.macConfig.ssh.identityFile=join(f.root,"ssh-key");f.macConfig.retirementCommand=join(f.root,"trash");fs.writeFileSync(f.macConfig.retirementCommand,"synthetic-inactive-helper",{mode:0o700});file=f.configFile("mac");
  expect(run(["init-mac","--config",file]).status).toBe(0);
  const result=run(["retire-artifacts","--kind","mac","--config",file,"--category","quarantine","--limit","1"],true);
  expect(result.status,result.stderr).toBe(0);expect(result.stderr).toContain('"retired":1');expect(fs.readFileSync(join(f.root,"mock-recoverable","source-snapshot.db"),"utf8")).toBe("synthetic-raw");
});

it("candidate inode substitution after selection is rejected before helper",()=>{
  const f=fixture();provisionMac(f.macConfig);const path=raw(f);let hits=0;
  vi.mocked(fs.lstatSync).mockImplementation(((p:any,...args:any[])=>{const st=(realStat as any)(p,...args);if(String(p)===path&&++hits>=5)st.ino+=typeof st.ino==="bigint"?1n:1;return st;}) as any);
  const helper=vi.fn();expect(()=>retireArtifacts(f.macConfig,"quarantine",1,helper)).toThrow();expect(helper).not.toHaveBeenCalled();expect(hits).toBeGreaterThanOrEqual(5);
});

it("actual synthetic exporter backups, empty work quarantine and signed copies have supported aged layouts",async()=>{
  const f=fixture();provisionMac(f.macConfig);const upload=vi.fn(),m=openMac(f.macConfig,{readers:{...defaultMacReaders(),build:()=>"4759"},fetchImpl:vi.fn(),upload});
  const signal=new AbortController().signal,context=await m.captureContext(signal);expect(context).toBeTruthy();await m.snapshot(context!,signal);m.close();expect(upload).toHaveBeenCalledTimes(1);
  const ageTree=(p:string)=>{if(fs.lstatSync(p).isDirectory())for(const name of fs.readdirSync(p))ageTree(join(p,name));fs.utimesSync(p,old(),old());};
  for(const root of [f.macConfig.transferParent,f.macConfig.rawQuarantine])for(const name of fs.readdirSync(root))ageTree(join(root,name));
  let moved=0;const helper=(p:string)=>fs.renameSync(p,join(f.root,"recoverable-artifact-"+ ++moved));
  expect(retireArtifacts(f.macConfig,"copies",16,helper)).toBe(1);expect(retireArtifacts(f.macConfig,"quarantine",16,helper)).toBeGreaterThanOrEqual(2);
  expect(fs.readdirSync(f.macConfig.transferParent)).toEqual([]);expect(fs.readdirSync(f.macConfig.rawQuarantine)).toEqual([]);expect(fs.readFileSync(f.fixture.mainPath).length).toBeGreaterThan(0);
});
it.each(["dbPath","authDbPath","prefsPlistPath","infoPlistPath","sessionPath"] as const)("rejects every configured source authority nested in an artifact: %s",field=>{
  const f=fixture(),path=raw(f);f.macConfig.source[field]=join(path,"source-snapshot.db");expect(()=>validateConfig(f.macConfig)).toThrow();
});
