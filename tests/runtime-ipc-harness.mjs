// Synthetic subprocess harness: no preload/network guard is bypassed in the MCP process.
// Only private AF_UNIX sockets below the supplied synthetic configuration are opened.
import { createConnection } from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readConfig } from '../build/runtime/config.js';
import { openLinux } from '../build/runtime/linux.js';
import { forcedIpcClient } from '../build/runtime/ipc.js';
import { Readable, Writable } from 'node:stream';
const [file, bundleDir, scenario] = process.argv.slice(2);
const config = readConfig(file, 'linux');
const runtime = openLinux(config);
const listener = await runtime.listen();
function raw(chunks, end = true) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({path: config.socketPath, allowHalfOpen: true}), output = [];
    socket.on('error', () => {}); socket.on('data', c => output.push(c));
    socket.on('connect', () => { for(const chunk of chunks) socket.write(chunk); if(end) socket.end(); });
    socket.on('end', () => socket.destroy()); socket.on('close', () => resolve(Buffer.concat(output).toString()));
  });
}
const manifest = bundleDir === '-' ? null : readFileSync(join(bundleDir, 'manifest.json'));
const db = bundleDir === '-' ? null : readFileSync(join(bundleDir, 'replica.db'));
const hash = b => createHash('sha256').update(b).digest('hex');
try {
  let result;
  if (scenario === 'valid' || scenario === 'digest' || scenario === 'truncated' || scenario === 'extra' || scenario === 'signature') {
    let sentManifest = manifest;
    if(scenario === 'signature') { const value = JSON.parse(manifest); value.producerId = 'forged'; sentManifest = Buffer.from(JSON.stringify(value)); }
    const header = {verb:'upload', manifestBytes:sentManifest.length, dbBytes:db.length, manifestSha256:hash(sentManifest), dbSha256:scenario === 'digest' ? '0'.repeat(64) : hash(db)};
    const bytes = [Buffer.from(JSON.stringify({endpoint:'upload', header}) + '\n'), sentManifest, scenario === 'truncated' ? db.subarray(0, -1) : db];
    if(scenario === 'extra') bytes.push(Buffer.from('X'));
    const first = await raw(bytes);
    let duplicate = null;
    if(scenario === 'valid') duplicate = await raw(bytes);
    result = { first, duplicate, highwater:runtime.receiver.getStateSnapshot().highwaterSequence, quarantine:readdirSync(config.quarantine).length };
  } else if(scenario === 'bridge') {
    const header = {verb:'upload',manifestBytes:manifest.length,dbBytes:db.length,manifestSha256:hash(manifest),dbSha256:hash(db)};
    let output = '';
    await forcedIpcClient({socketPath:config.socketPath,endpoint:'upload',input:Readable.from([JSON.stringify(header)+'\n',manifest,db]),
      output:new Writable({write(c,_e,cb){output+=c;cb();}}),maxDbBytes:config.budget.maxDbBytes, acceptanceMs:config.budget.acceptanceMs, checkLocation(){} });
    result = {first:output, highwater:runtime.receiver.getStateSnapshot().highwaterSequence};
  } else if(scenario === 'roles') {
    result = [];
    for (const [prefix, command] of [
      [{endpoint:'shell'},{}], [{endpoint:'mailbox'}, {verb:'lease',limit:1,role:'caller'}],
      [{endpoint:'mailbox'}, {verb:'submit', request:{}}], [{endpoint:'mailbox'}, {verb:'sql',query:'SELECT 1'}],
      [{endpoint:'mailbox',role:'mac'}, {verb:'lease',limit:1}]
    ]) result.push(await raw([JSON.stringify(prefix)+'\n', JSON.stringify(command)]));
  } else if(scenario === 'concurrency') {
    const header = {verb:'upload',manifestBytes:1,dbBytes:100,manifestSha256:'a'.repeat(64),dbSha256:'b'.repeat(64)};
    const first = raw([JSON.stringify({endpoint:'upload',header})+'\n'],false);
    await new Promise(resolve=>setTimeout(resolve,30));
    const second = await raw(['{"endpoint":"mailbox"}\n','{"verb":"lease","limit":1}']);
    await first; result = {second, highwater:runtime.receiver.getStateSnapshot().highwaterSequence};
  } else if(scenario === 'bounds') {
    const start = Date.now();
    const slow = await raw(['{"endpoint":'], false);
    const slowMs = Date.now() - start;
    const hugeHeader = await raw(['X'.repeat(1025)]);
    const hugeBody = await raw(['{"endpoint":"mailbox"}\n','X'.repeat(65537)]);
    result = {slow, slowMs, hugeHeader, hugeBody, highwater:runtime.receiver.getStateSnapshot().highwaterSequence};
  } else if(scenario === 'stale') {
    let rejected = false; try { await runtime.listen(); } catch { rejected = true; }
    const response = await raw(['{"endpoint":"mailbox"}\n','{"verb":"lease","limit":1}']);
    result = {rejected, response};
  } else throw new Error('Unknown synthetic scenario');
  process.stdout.write(JSON.stringify(result));
} finally { await listener.close(); runtime.close(); }
