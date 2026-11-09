import { afterEach, expect, it } from "vitest";
import { runtimeFixture } from "./runtime-fixture.js";
import { openLinux, provisionLinux } from "../src/runtime/linux.js";
import { installToolSafety } from "../src/services/tool-safety.js";
import { withSqliteBudget } from "../src/replica/work.js";
import { trashFixture } from "./fixture/lifecycle.mjs";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) trashFixture(root); });
it.each(["mount", "uncertain"])("actual async safety wrapper returns an error and releases only its own lease on %s loss", async kind => {
  const f = runtimeFixture(); roots.push(f.root); provisionLinux(f.linux); const r = openLinux(f.linux); r.receiver.acceptBundle((await f.bundle()).bundleDir);
  const other = r.receiver.acquireLease(); let handler: any;
  const server = { registerTool(_n: string, _c: unknown, callback: unknown) { handler = callback; } };
  installToolSafety(server as any, r.db, { replicaReceiver: r.receiver });
  const inode = f.linux.storage.mountInode;
  server.registerTool("flighty_list_flights", {}, async () => { r.db.listFlights(); await Promise.resolve(); if(kind === "mount") f.linux.storage.mountInode++; else (r.receiver as any).uncertain = true;
    return { content: [{ type: "text", text: '{"private_success":"MUST-NOT-ESCAPE"}' }] }; });
  const result = await handler({}); expect(result.isError).toBe(true); expect(result.freshness.status).toBe("unknown");
  expect(JSON.stringify(result)).not.toContain("MUST-NOT-ESCAPE"); expect(JSON.stringify(result)).not.toContain(f.root);
  expect(r.receiver.getActiveLeaseCount()).toBe(1); expect(() => other.release()).not.toThrow(); expect(other.isReleased()).toBe(true);
  f.linux.storage.mountInode = inode; (r.receiver as any).uncertain = false; expect(() => r.receiver.cleanupOldGenerations()).not.toThrow(); r.close();
});
it.each(["state-temp-file", "state-root-dir"])("deadline after blocking %s preserves truthful commit boundary", async boundary => {
  const f = runtimeFixture(); roots.push(f.root); provisionLinux(f.linux); let r = openLinux(f.linux); const bundle = await f.bundle();
  let injected = 0; (r.receiver as any).config.faultHooks = { onFsync(name: string) { if(name === boundary && !injected++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2100); } };
  expect(() => withSqliteBudget(2000, 2000, () => r.receiver.acceptBundle(bundle.bundleDir))).toThrow();
  expect(r.receiver.getStateSnapshot().highwaterSequence).toBe(boundary === "state-temp-file" ? 0 : 1);
  r.close(); r = openLinux(f.linux); expect(r.receiver.getStateSnapshot().highwaterSequence).toBe(boundary === "state-temp-file" ? 0 : 1); r.close();
});
