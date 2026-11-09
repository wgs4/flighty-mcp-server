// Synthetic fault at the reviewed compiled helper-entry boundary; never runs a real helper.
import fs from "node:fs";
import child from "node:child_process";
import net from "node:net";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
const root = process.env.FLIGHTY_TEST_RETIRE_ROOT;
const plan = JSON.parse(fs.readFileSync(join(root, "handoff-plan.json"), "utf8"));
const source = fs.readFileSync(new URL("../build/runtime/maintenance.js", import.meta.url), "utf8");
const line = source.split("\n").findIndex(s => s.includes("const before = treeSnapshot")) + 1;
if (!line || !plan.target.startsWith(root + "/")) throw new Error("Synthetic boundary required");
if (plan.now) Date.now = () => plan.now;
const original = fs.lstatSync;
let faulted = false, calls = 0;
fs.lstatSync = (path, ...args) => {
  if (!faulted && ["swap", "disappear"].includes(plan.fault) && String(path) === plan.target && new Error().stack.includes(`maintenance.js:${line}:`)) {
    faulted = true; fs.renameSync(plan.target, join(root, "preserved-selection"));
    if (plan.fault === "disappear") return original(path, ...args);
    if (plan.directory) { fs.mkdirSync(plan.target, { mode: 0o700 }); fs.writeFileSync(join(plan.target, "new-unrecognized-user-document.txt"), "FRESH-UNRECOGNIZED-CONTENT", { mode: 0o600 }); }
    else fs.writeFileSync(plan.target, "UNAUTHENTICATED-REPLACEMENT", { mode: 0o600 });
  }
  if (plan.fault === "mount" && String(path) === join(root, "trash")) faulted = true;
  const st = original(path, ...args);
  if (plan.fault === "mount" && faulted && String(path) === root) st.ino += typeof st.ino === "bigint" ? 1n : 1;
  return st;
};
child.execFileSync = (command, args) => {
  if (command !== join(root, "trash") || args.length !== 1 || !args[0].startsWith(root + "/")) throw new Error("Unexpected synthetic helper");
  fs.renameSync(args[0], join(root, "moved-" + ++calls));
  if (plan.fault === "move-throw") throw new Error("Synthetic post-move failure");
  return Buffer.alloc(0);
};
child.execSync = child.execFile = child.spawn = () => { throw new Error("No other child execution"); };
globalThis.fetch = net.connect = net.createConnection = () => { throw new Error("No network"); };
process.on("exit", () => fs.writeFileSync(join(root, "handoff-observed.json"), JSON.stringify({ faulted, calls }), { mode: 0o600 }));
syncBuiltinESMExports();
