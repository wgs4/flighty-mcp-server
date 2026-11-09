import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const failAt = Number(process.env.SYNTHETIC_REPLICA_FSYNC_AT);
const original = fs.fsyncSync;
let count = 0;
fs.fsyncSync = (...args) => {
  if (++count === failAt) throw Object.assign(new Error('synthetic ENOSPC /synthetic/private/path'), {code: 'ENOSPC'});
  return original(...args);
};
syncBuiltinESMExports();
