import { afterEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, realpathSync, utimesSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, sign } from "node:crypto";
import { runtimeFixture } from "./runtime-fixture.js";
import { provisionMac } from "../src/runtime/mac.js";
import { provisionLinux, openLinux } from "../src/runtime/linux.js";
import { inspectStore, recoverStore } from "../src/runtime/maintenance.js";
import { canonical, digest, makeRequest, seal } from "../src/remote/protocol.js";
import { trashFixture } from "./fixture/lifecycle.mjs";
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))trashFixture(root);});
function setup(role:"artifact"|"history"|"recovery") {
  const prior=process.env.TMPDIR;process.env.TMPDIR=realpathSync("/tmp");let f:ReturnType<typeof runtimeFixture>;
  try{f=runtimeFixture();}finally{if(prior===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=prior;}
  roots.push(f.root); const command=join(f.root,"trash");writeFileSync(command,"synthetic-inactive-helper",{mode:0o700});
  const past=Date.now()-4*86400000,old=new Date(past);let target:string,args:string[];
  if(role==="artifact") {
    f.macConfig.retirementCommand=command;provisionMac(f.macConfig);
    target=join(f.macConfig.rawQuarantine,"raw-backup-11111111-1111-4111-8111-111111111111");mkdirSync(target,{mode:0o700});
    writeFileSync(join(target,"source-snapshot.db"),"SELECTED-OLD",{mode:0o600});utimesSync(join(target,"source-snapshot.db"),old,old);utimesSync(target,old,old);
    args=["retire-artifacts","--kind","mac","--config",f.configFile("mac"),"--category","quarantine","--limit","1"];
  } else {
    f.linux.retirementCommand=command;f.linux.operatorPublicKey=f.macConfig.operatorPublicKey;provisionLinux(f.linux);
    if(role==="history") {
      const r=openLinux(f.linux),request=makeRequest({caller:"linux",account:f.linux.pins.accountId,operationId:"handoff-history",issuedAt:past,expiresAt:past+1000,operation:{kind:"request-snapshot"}},f.caller.privateKey);
      const receipt=seal("receipt",{version:1,caller:"linux",account:request.body.account,operationId:request.body.operationId,requestDigest:digest(request.body),state:"succeeded",updatedAt:past+500},f.mac.privateKey);
      r.clientStore.put("client",request.body.operationId,{request,status:{queue:"receipted",receipt}});r.clientStore.archive("client",request.body.operationId);r.clientStore.delete("client",request.body.operationId);r.close();
      target=join(f.linux.clientStore.path+".archive",createHash("sha256").update("client\0handoff-history").digest("hex")+".json");
      args=["retire-artifacts","--kind","linux","--config",f.configFile("linux"),"--category","history","--limit","1"];
    } else {
      const body={version:1,action:"recover-continuity",mode:"repair-ahead",...inspectStore(f.linux,"linux-client"),nonce:"handoff-audit",issuedAt:past,expiresAt:past+1000};
      const root=f.linux.clientStore.continuityPath+".recovery";mkdirSync(root,{mode:0o700});target=join(root,"handoff-audit.json");
      writeFileSync(target,canonical({body,signature:sign(null,Buffer.from("flighty-continuity-recovery-v1:"+canonical(body)),f.operator.privateKey).toString("base64")}),{mode:0o600});
      args=["retire-recovery","--kind","linux","--config",f.configFile("linux"),"--role","linux-client","--limit","1"];
    }
  }
  return {f,target,args};
}
function run(c:ReturnType<typeof setup>,fault:"swap"|"mount"|"none"|"disappear"|"move-throw", now?:number) {
  writeFileSync(join(c.f.root,"handoff-plan.json"),JSON.stringify({target:c.target,fault,now,directory:c.args.includes("quarantine")}),{mode:0o600});
  const result=spawnSync(process.execPath,["--import",fileURLToPath(new URL("./runtime-retirement-handoff-preload.mjs",import.meta.url)),fileURLToPath(new URL("../build/runtime/cli.js",import.meta.url)),...c.args],{encoding:"utf8",timeout:5000,env:{PATH:process.env.PATH,GIT_NO_LAZY_FETCH:"1",FLIGHTY_TEST_RETIRE_ROOT:c.f.root}});
  return {...result,observed:JSON.parse(readFileSync(join(c.f.root,"handoff-observed.json"),"utf8"))};
}
it.each(["artifact","history","recovery"] as const)("compiled %s retirement rejects a replacement at the exact helper initial scan",role=>{
  const c=setup(role),original=readFileSync(role==="artifact"?join(c.target,"source-snapshot.db"):c.target),result=run(c,"swap");
  expect(result.observed.faulted).toBe(true);expect(result.status,result.stderr).toBe(1);expect(result.observed.calls).toBe(0);expect(result.stderr).toContain('{"retired":0,"stopped":true}');
  expect(result.stderr).not.toContain(c.f.root);expect(existsSync(join(c.f.root,"moved-1"))).toBe(false);
  expect(readFileSync(role==="artifact"?join(c.f.root,"preserved-selection","source-snapshot.db"):join(c.f.root,"preserved-selection"))).toEqual(original);
  expect(readFileSync(role==="artifact"?join(c.target,"new-unrecognized-user-document.txt"):c.target,"utf8")).toContain(role==="artifact"?"FRESH-UNRECOGNIZED":"UNAUTHENTICATED-REPLACEMENT");
});
it.each(["artifact","history","recovery"] as const)("compiled %s retirement rejects mount loss during helper metadata checks",role=>{
  const c=setup(role),result=run(c,"mount");expect(result.observed.faulted).toBe(true);expect(result.status,result.stderr).toBe(1);expect(result.observed.calls).toBe(0);expect(result.stderr).toContain('{"retired":0,"stopped":true}');expect(existsSync(c.target)).toBe(true);
});
it.each(["artifact","history","recovery"] as const)("compiled %s legitimate selection still retires",role=>{
  const c=setup(role),result=run(c,"none");expect(result.status,result.stderr).toBe(0);expect(result.observed.calls).toBe(1);expect(result.stderr).toContain('{"retired":1}');expect(existsSync(c.target)).toBe(false);expect(existsSync(join(c.f.root,"moved-1"))).toBe(true);
});
it("compiled batch preserves an earlier completed move when a later selection is replaced",()=>{
  const c=setup("artifact"),second=c.target.replace("11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222"),old=new Date(Date.now()-4*86400000);
  mkdirSync(second,{mode:0o700});writeFileSync(join(second,"source-snapshot.db"),"SELECTED-SECOND",{mode:0o600});utimesSync(join(second,"source-snapshot.db"),old,old);utimesSync(second,old,old);c.target=second;c.args[c.args.length-1]="2";
  const result=run(c,"swap");expect(result.status,result.stderr).toBe(1);expect(result.observed.calls).toBe(1);expect(result.stderr).toContain('{"retired":1,"stopped":true}');expect(readFileSync(join(c.f.root,"moved-1","source-snapshot.db"),"utf8")).toBe("SELECTED-OLD");expect(existsSync(join(second,"new-unrecognized-user-document.txt"))).toBe(true);
});

it("compiled validation disappearance reports no retirement when no helper ran",()=>{
  const c=setup("artifact"),result=run(c,"disappear");expect(result.observed.faulted).toBe(true);expect(result.status).toBe(1);expect(result.observed.calls).toBe(0);expect(result.stderr).toContain('{"retired":0,"stopped":true}');expect(existsSync(join(c.f.root,"preserved-selection","source-snapshot.db"))).toBe(true);
});
it("compiled invoked helper moving then throwing retains the observed completed count",()=>{
  const c=setup("artifact"),result=run(c,"move-throw");expect(result.status).toBe(1);expect(result.observed.calls).toBe(1);expect(result.stderr).toContain('{"retired":1,"stopped":true}');expect(existsSync(join(c.f.root,"moved-1","source-snapshot.db"))).toBe(true);
});
it("genuinely applied ahead-of-anchor repair audit rejects unauthenticated replacement at compiled helper entry",()=>{
  const c=setup("history"),file=c.f.configFile("linux");
  const crashed=spawnSync(process.execPath,[fileURLToPath(new URL("./runtime-continuity-crash.mjs",import.meta.url)),file],{encoding:"utf8",timeout:5000,env:{PATH:process.env.PATH,GIT_NO_LAZY_FETCH:"1"}});expect(crashed.status,crashed.stderr).toBe(73);
  const now=Date.now(),body={version:1,action:"recover-continuity",mode:"repair-ahead",...inspectStore(c.f.linux,"linux-client"),nonce:"actual-handoff",issuedAt:now,expiresAt:now+300000};
  recoverStore(c.f.linux,"linux-client",{body,signature:sign(null,Buffer.from("flighty-continuity-recovery-v1:"+canonical(body)),c.f.operator.privateKey).toString("base64")});
  c.target=join(c.f.linux.clientStore.continuityPath+".recovery","actual-handoff.json");c.args=["retire-recovery","--kind","linux","--config",file,"--role","linux-client","--limit","1"];
  const original=readFileSync(c.target),result=run(c,"swap",now+4*86400000);expect(result.observed.faulted).toBe(true);expect(result.status,result.stderr).toBe(1);expect(result.observed.calls).toBe(0);expect(result.stderr).toContain('{"retired":0,"stopped":true}');expect(readFileSync(join(c.f.root,"preserved-selection"))).toEqual(original);expect(readFileSync(c.target,"utf8")).toBe("UNAUTHENTICATED-REPLACEMENT");
  const r=openLinux(c.f.linux);expect(r.clientStore.get<any>("client","compiled-request").request.body.operationId).toBe("compiled-request");r.close();
});
