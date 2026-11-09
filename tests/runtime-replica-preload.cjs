// Synthetic-only guard: replica mode must never consult auth/plist paths or networks.
const fs = require('node:fs'), sqlite = require('node:sqlite'), cp = require('node:child_process');
const {syncBuiltinESMExports} = require('node:module');
const root = process.env.FLIGHTY_TEST_RUNTIME_ROOT;
if (!root || !fs.existsSync(root + '/linux.json')) throw new Error('Marked synthetic runtime required');
const originalDb = sqlite.DatabaseSync;
let forbidden = 0;
const record = () => fs.writeFileSync(root + '/replica-guard.json', JSON.stringify({forbidden}));
const deny = () => { forbidden++; record(); throw new Error('Forbidden replica discovery/network'); };
sqlite.DatabaseSync = class extends originalDb {
  constructor(path, options) {
    if (typeof path !== 'string' || !path.startsWith(root + '/') || /Flighty\.sqlite|MainFlightyDatabase|\.plist/.test(path)) deny();
    super(path, options ?? {});
  }
};
cp.execFileSync = deny; cp.execFile = deny; cp.execSync = deny;
globalThis.fetch = deny;
const net = require('node:net'); net.Socket.prototype.connect = deny; net.connect = deny; net.createConnection = deny;
require('node:tls').connect = deny;
record(); syncBuiltinESMExports();
