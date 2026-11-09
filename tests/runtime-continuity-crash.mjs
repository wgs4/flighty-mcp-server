// Synthetic-only child: produce a real DB-COMMIT/rename-EIO gap and exit before operator recovery.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { readConfig, privateKey } from '../build/runtime/config.js';
import { roleOptions } from '../build/runtime/maintenance.js';
import { PrivateStore } from '../build/remote/store.js';
import { makeRequest } from '../build/remote/protocol.js';
const config = readConfig(process.argv[2], 'linux'), options = roleOptions(config, 'linux-client');
const store = new PrivateStore(options), issuedAt = Date.now();
const request = makeRequest({ caller: config.caller.id, account: config.caller.account, operationId: 'compiled-request', issuedAt, expiresAt: issuedAt+300000, operation:{kind:'request-snapshot'} },privateKey(config.caller.privateKey));
const rename = fs.renameSync;
fs.renameSync = (from,to) => { if(String(to)===options.continuityPath) throw Object.assign(new Error('synthetic rename EIO'),{code:'EIO'}); rename(from,to); };
syncBuiltinESMExports();
try { store.put('client','compiled-request',{request,status:null}); process.exitCode=2; }
catch { store.close(); process.exitCode=73; }
