// Synthetic compiled-CLI harness. Never invoke a real helper or network transport.
import fs from "node:fs";
import child from "node:child_process";
import net from "node:net";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
const root = process.env.FLIGHTY_TEST_RETIRE_ROOT;
if (!root || !fs.lstatSync(root).isDirectory()) throw new Error("Synthetic root required");
child.execFileSync = (command, args) => {
  if (command !== join(root, "trash") || args.length !== 1 || !args[0].startsWith(root + "/")) throw new Error("Unexpected synthetic helper invocation");
  fs.renameSync(args[0], join(root, "mock-recoverable")); return Buffer.alloc(0);
};
child.execSync = child.execFile = () => { throw new Error("No child execution in retirement fixture"); };
globalThis.fetch = net.connect = net.createConnection = () => { throw new Error("No network in retirement fixture"); };
syncBuiltinESMExports();
