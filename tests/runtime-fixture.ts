import { generateKeyPairSync } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { IDS, createFixture } from "./fixture/create.mjs";
import { REPLICA_SCHEMA_VERSION, REPLICA_SCHEMA_HASH } from "../src/replica/schema.js";
import { exportReplicaBundle } from "../src/replica/exporter.js";
import { storageAuthority, type LinuxConfig, type MacConfig } from "../src/runtime/config.js";

export function runtimeFixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "fr-")); chmodSync(root, 0o700);
  const fixture = createFixture(root);
  for (const path of [fixture.mainPath, fixture.legacyPath]) { chmodSync(path, 0o600); chmodSync(dirname(path), 0o700); }
  chmodSync(fixture.directory, 0o700);
  const producer = generateKeyPairSync("ed25519"), caller = generateKeyPairSync("ed25519"), mac = generateKeyPairSync("ed25519"), operator = generateKeyPairSync("ed25519");
  const pub = (k: typeof caller.publicKey) => k.export({ type: "spki", format: "pem" }).toString();
  const priv = (k: typeof caller.privateKey) => k.export({ type: "pkcs8", format: "pem" }).toString();
  const storage = { mountPath: root, privateRootDir: root, expectedDevice: lstatSync(root).dev, mountInode: lstatSync(root).ino, approvedPaths: [root] };
  const pins = { producerId: "synthetic-producer", accountId: IDS.owner, ownerUserId: IDS.owner, epoch: 1,
    schemaVersion: REPLICA_SCHEMA_VERSION, schemaHash: REPLICA_SCHEMA_HASH, publicKey: pub(producer.publicKey) };
  const budget = { maxBytes: 128 * 1024 * 1024, maxEntries: 1024, maxDbBytes: 8 * 1024 * 1024, transportMs: 1000, acceptanceMs: 20_000, sqliteTaskMs: 10_000 };
  const store = (name: string) => ({ path: join(root, name + ".sqlite"), continuityPath: join(root, name + ".anchor"), identity: name, authenticationKey: "09".repeat(32) });
  const callerConfig = { id: "linux", account: IDS.owner, publicKey: pub(caller.publicKey), capabilities: ["add", "follow", "remove-preview", "remove-confirm", "request-snapshot"] as const };
  const linux: LinuxConfig = { version: 1, kind: "linux", storage, pins, budget, receiverRoot: join(root, "receiver"), inbox: join(root, "inbox"),
    quarantine: join(root, "quarantine"), socketPath: join(root, "ipc.sock"), store: store("linux"), clientStore: store("client"), caller: { ...callerConfig, capabilities: [...callerConfig.capabilities], privateKey: priv(caller.privateKey) }, macReceiptKey: pub(mac.publicKey) };
  const info = join(root, "info.plist"), prefs = join(root, "prefs.plist"), session = join(root, "session"), sshKey = join(root, "ssh-key"), hosts = join(root, "hosts");
  for (const path of [info, prefs, session, sshKey, hosts]) writeFileSync(path, "SYNTHETIC-PRIVATE-FIXTURE", { mode: 0o600 });
  const macConfig: MacConfig = { version: 1, kind: "mac", storage, pins, budget, store: store("mac"), sequenceStore: store("sequence"),
    operatorPublicKey: pub(operator.publicKey), receiptPrivateKey: priv(mac.privateKey), bindingKey: "07".repeat(32), snapshotPrivateKey: priv(producer.privateKey),
    callers: [{ ...callerConfig, capabilities: [...callerConfig.capabilities] }], source: { dbPath: fixture.mainPath, authDbPath: fixture.legacyPath,
      prefsPlistPath: prefs, infoPlistPath: info, sessionPath: session, device: lstatSync(fixture.mainPath).dev, dbInode: lstatSync(fixture.mainPath).ino },
    transferParent: join(root, "transfer"), rawQuarantine: join(root, "raw-quarantine"),
    ssh: { enabled: true, host: "synthetic.invalid", port: 23500, user: "courier", identityFile: sshKey, knownHostsFile: hosts } };
  for (const path of [macConfig.transferParent, macConfig.rawQuarantine]) mkdirSync(path, { mode: 0o700 });
  return { root, fixture, linux, macConfig, producer, caller, mac, operator,
    configFile(kind: "linux" | "mac") { const file = join(root, kind + ".json"); writeFileSync(file, JSON.stringify(kind === "linux" ? linux : macConfig), { mode: 0o600 }); return file; },
    async bundle(sequence = 1, mutate?: (db: DatabaseSync) => void) {
      if (mutate) { const db = new DatabaseSync(fixture.mainPath); try { mutate(db); } finally { db.close(); } }
      return exportReplicaBundle({ sourceDbPath: fixture.mainPath, outputBundleDir: join(macConfig.transferParent, "bundle-" + sequence),
        quarantineDir: macConfig.rawQuarantine, storage: storageAuthority(macConfig), requiredMountPath: root,
        producerId: pins.producerId, accountId: pins.accountId, ownerUserId: pins.ownerUserId, epoch: pins.epoch, sequence, signingPrivateKey: producer.privateKey });
    },
  };
}
