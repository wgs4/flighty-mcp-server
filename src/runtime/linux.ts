import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PrivateStore, type StoreOptions } from "../remote/store.js";
import { mailboxStateValidator } from "../remote/state.js";
import { Mailbox, localTransport } from "../remote/mailbox.js";
import { RemoteClient } from "../remote/client.js";
import { ReplicaReceiver } from "../replica/receiver.js";
import { assertPrivatePath, measureStorageGroups, retirePath } from "../replica/cleanup.js";
import { withSqliteBudget } from "../replica/work.js";
import { FlightyDatabase } from "../services/database.js";
import { getActiveReplicaLease } from "../replica/context.js";
import { ProtocolError } from "../remote/protocol.js";
import { DurableClient, clientStateValidator } from "./client-state.js";
import { checkStorage, callersFor, privateKey, publicKey, storageAuthority, type LinuxConfig } from "./config.js";
import { startIpcServer } from "./ipc.js";

export function receiverOptions(config: LinuxConfig) {
  return { stateRootDir: config.receiverRoot, storage: storageAuthority(config),
    storageBudget: { maxBytes: config.budget.maxBytes, maxEntries: config.budget.maxEntries },
    publicKey: publicKey(config.pins.publicKey), producerId: config.pins.producerId, accountId: config.pins.accountId,
    ownerUserId: config.pins.ownerUserId, epoch: config.pins.epoch, schemaVersion: config.pins.schemaVersion,
    schemaHash: config.pins.schemaHash, operatorOwnerOverride: process.env.FLIGHTY_OWNER_USER_ID,
    limits: { maxDbBytes: config.budget.maxDbBytes } };
}
export function linuxStoreOptions(config: LinuxConfig): StoreOptions {
  return { ...config.store, authenticationKey: Buffer.from(config.store.authenticationKey, "hex"),
    checkLocation: () => checkStorage(config, [config.receiverRoot, config.inbox, config.quarantine]),
    validateState: mailboxStateValidator(callersFor(config), publicKey(config.macReceiptKey), Date.now) };
}
export function linuxClientStoreOptions(config: LinuxConfig): StoreOptions {
  return { ...config.clientStore, authenticationKey: Buffer.from(config.clientStore.authenticationKey, "hex"),
    checkLocation: () => checkStorage(config), validateState: clientStateValidator(callersFor(config), publicKey(config.macReceiptKey)) };
}
export function provisionLinux(config: LinuxConfig): void {
  // Explicit init only; a partial initialization requires investigation, never automatic reset.
  checkStorage(config, [config.receiverRoot, config.inbox, config.quarantine]);
  if (existsSync(config.store.path) || existsSync(config.store.continuityPath) || existsSync(config.receiverRoot) || existsSync(config.clientStore.path) || existsSync(config.clientStore.continuityPath)) throw new ProtocolError("Existing/partial state cannot be initialized.");
  PrivateStore.initialize(linuxStoreOptions(config));
  PrivateStore.initialize(linuxClientStoreOptions(config));
  new ReplicaReceiver(receiverOptions(config));
  for (const path of [config.inbox, config.quarantine]) if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
}
export function openLinux(config: LinuxConfig) {
  checkStorage(config, [config.receiverRoot, config.inbox, config.quarantine]);
  if (!existsSync(join(config.receiverRoot, "state.json")) || ![config.inbox, config.quarantine].every(p => lstatSync(p).isDirectory())) throw new ProtocolError("Provisioned replica continuity is missing. No automatic initialization.");
  // Acquire the durable single-writer owner BEFORE opening receiver/cleanup.
  const store = new PrivateStore(linuxStoreOptions(config));
  let clientStore: PrivateStore;
  try { clientStore = new PrivateStore(linuxClientStoreOptions(config)); } catch (error) { store.close(); throw error; }
  try {
    measureStorageGroups([config.inbox, config.quarantine, config.receiverRoot], config.budget);
    for (const name of readdirSync(config.inbox)) {
      if (!/^incoming-[a-f0-9-]{36}$/.test(name)) throw new ProtocolError("Unexpected incoming storage entry; operator inspection required.");
      const path = join(config.inbox, name); assertPrivatePath(path, config.inbox);
      if (!lstatSync(path).isDirectory()) throw new ProtocolError();
      retirePath(path, config.quarantine);
    }
    const receiver = withSqliteBudget(config.budget.acceptanceMs, config.budget.sqliteTaskMs, () => new ReplicaReceiver(receiverOptions(config)));
    const callers = callersFor(config), macReceiptKey = publicKey(config.macReceiptKey);
    const mailbox = new Mailbox({ store, callers, macReceiptKey });
    const client = new RemoteClient({ caller: config.caller.id, account: config.caller.account,
      signingKey: privateKey(config.caller.privateKey), macReceiptKey, transport: localTransport(mailbox, { role: "caller", caller: config.caller.id }) });
    const durable = new DurableClient(client, clientStore, config.caller.id, config.caller.account);
    const db = new FlightyDatabase("", "", () => {
      const lease = getActiveReplicaLease();
      if (!lease || lease.isReleased()) throw new ProtocolError("No invocation replica lease.");
      return lease;
    });
    return { config, store, clientStore, receiver, mailbox, client, durable, db, macReceiptKey,
      async listen() { return startIpcServer(config, receiver, mailbox); },
      close() { clientStore.close(); store.close(); } };
  } catch (error) { clientStore.close(); store.close(); throw error; }
}
export type LinuxRuntime = ReturnType<typeof openLinux>;
