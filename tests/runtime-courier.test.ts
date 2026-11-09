import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runtimeFixture } from "./runtime-fixture.js";
import { bundleUploader, courierCycle } from "../src/runtime/courier.js";
import { defaultMacReaders, provisionMac } from "../src/runtime/mac.js";
import { makeRequest, verifyReceipt } from "../src/remote/protocol.js";
import { IDS } from "./fixture/create.mjs";
import { trashFixture } from "./fixture/lifecycle.mjs";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) trashFixture(root); });
function setup() { const f = runtimeFixture(); roots.push(f.root); return f; }
function mockChild(reply: (input: Buffer) => string) {
  const child = new EventEmitter() as any, chunks: Buffer[] = [];
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn(() => true);
  child.stdin = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); }, final(callback) {
    queueMicrotask(() => { try { child.stdout.end(reply(Buffer.concat(chunks))); child.emit("close", 0); } catch { child.emit("close", 1); } }); callback();
  } });
  return child;
}
it("streamed SSH copy has strict fixed command/options and transfers exactly the two selected files", async () => {
  const f = setup(), bundle = await f.bundle(); let transmitted = Buffer.alloc(0);
  const child = mockChild(input => { transmitted = input; return '{"accepted":true,"generation_id":"synthetic-generation"}'; });
  const spawn = vi.fn(() => child), checkConfiguration = vi.fn();
  const upload = bundleUploader({ ...f.macConfig.ssh, checkConfiguration }, f.macConfig.budget.maxDbBytes, 20_000, spawn as any);
  expect(spawn).not.toHaveBeenCalled(); await upload(bundle.bundleDir, new AbortController().signal);
  const [file, args, options] = spawn.mock.calls[0] as any;
  expect(file).toBe("/usr/bin/ssh"); expect(options.shell).toBe(false); expect(args.slice(-2)).toEqual(["courier@synthetic.invalid", "flighty-upload-v1"]);
  for (const option of ["StrictHostKeyChecking=yes", "IdentityAgent=none", "ForwardAgent=no", "ControlMaster=no", "ControlPath=none", "ControlPersist=no", "UpdateHostKeys=no"]) expect(args).toContain(option);
  expect(args).toContain("23500"); expect(args).toContain("/dev/null");
  const newline = transmitted.indexOf(10), header = JSON.parse(transmitted.subarray(0, newline).toString());
  const manifest = readFileSync(bundle.manifestPath), db = readFileSync(bundle.dbPath);
  expect(header.manifestBytes).toBe(manifest.length); expect(header.dbBytes).toBe(db.length);
  expect(transmitted.subarray(newline + 1)).toEqual(Buffer.concat([manifest, db])); expect(checkConfiguration).toHaveBeenCalledTimes(1);
});
it("one synthetic courier cycle polls, executes and publishes the same signed operation without real SSH/HTTP", async () => {
  const f = setup(); provisionMac(f.macConfig); const now = Date.now();
  const request = makeRequest({ caller: "linux", account: IDS.owner, operationId: "courier-operation", issuedAt: now, expiresAt: now + 300_000,
    operation: { kind: "remove-preview", flight_id: IDS.uncached } }, f.caller.privateKey);
  let published: any, calls = 0;
  const spawn = vi.fn(() => mockChild(bytes => {
    const command = JSON.parse(bytes.toString()); calls++;
    if (command.verb === "lease") return JSON.stringify({ requests: [request] });
    expect(command.verb).toBe("receipt"); published = command.receipt; return '{"accepted":true}';
  }));
  const http = vi.fn();
  const result = await courierCycle(f.macConfig, { snapshot: false, fetchImpl: http, spawnImpl: spawn as any,
    readers: { ...defaultMacReaders(), build: () => "4759" } });
  expect(result).toEqual({ receiptsPublished: 1, copy: null }); expect(calls).toBe(2); expect(http).not.toHaveBeenCalled();
  expect(verifyReceipt(published, f.mac.publicKey, request.body).operationId).toBe(request.body.operationId);
});
it("copy upload cancellation rejects before reporting receiver acceptance", async () => {
  const f = setup(), bundle = await f.bundle(), controller = new AbortController();
  const child = mockChild(() => '{"accepted":true,"generation_id":"synthetic"}');
  const spawn = vi.fn(() => { queueMicrotask(() => controller.abort()); return child; });
  const upload = bundleUploader({ ...f.macConfig.ssh, checkConfiguration() {} }, 8 * 1024 * 1024, 20_000, spawn as any);
  await expect(upload(bundle.bundleDir, controller.signal)).rejects.toThrow(); expect(child.kill).toHaveBeenCalled();
});
it("fresh bounded shell-free build reader does not cache across captures", () => {
  const exec = vi.fn(() => "4759"); const readers = defaultMacReaders(exec as any);
  expect(readers.build("/synthetic/info.plist")).toBe("4759"); readers.build("/synthetic/info.plist");
  expect(exec).toHaveBeenCalledTimes(2); const [file, args, options] = exec.mock.calls[0] as any;
  expect(file).toBe("/usr/bin/plutil"); expect(args).toEqual(["-extract", "FlightyBuildToken", "raw", "/synthetic/info.plist"]);
  expect(options.timeout).toBe(2000); expect(options.maxBuffer).toBe(16 * 1024);
});
