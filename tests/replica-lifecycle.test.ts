import { exportSyntheticBundle as exportReplicaBundle, receiverStorage } from "./replica-support.js";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  ReplicaReceiver,
  getActiveReplicaContext,
  getActiveReplicaDbPath,
  getActiveReplicaFreshness,
  getActiveReplicaOwnerIdentity,
  withReplicaLease,
} from "../src/replica/index.js";
import { FlightyDatabase } from "../src/services/database.js";
import { IDS, createFixture } from "./fixture/create.mjs";
import { fixtureTempRoot, trashFixture } from "./fixture/lifecycle.mjs";

const { publicKey: PUB_KEY, privateKey: PRIV_KEY } =
  generateKeyPairSync("ed25519");

describe("replica core: publication boundaries, replay/resend, crash/ENOSPC recovery, stale recovery, account transition, and concurrent leases", () => {
  const tempDirs: string[] = [];

  function makeTempDir(prefix = "replica-lifecycle-test-"): string {
    const dir = mkdtempSync(join(fixtureTempRoot(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      trashFixture(tempDirs.pop()!);
    }
  });

  async function createBundleForSeq(params: {
    root: string;
    sequence: number;
    epoch?: number;
    accountId?: string;
    ownerUserId?: string;
    captureStartedAt: string;
    captureCompletedAt: string;
    extraFlightId?: string;
    lastSyncMarker?: string | number | null;
    label?: string;
  }) {
    const fixture = createFixture(params.root);
    const db = new DatabaseSync(fixture.mainPath);
    try {
      const ownerId = params.ownerUserId ?? IDS.owner;
      if (ownerId !== IDS.owner) {
        db.prepare("UPDATE UserFlight SET userId = ? WHERE userId = ?").run(
          ownerId,
          IDS.owner
        );
        db.prepare(
          "UPDATE UserManualFlight SET userId = ? WHERE userId = ?"
        ).run(ownerId, IDS.owner);
        db.prepare("UPDATE Ticket SET userId = ? WHERE userId = ?").run(
          ownerId,
          IDS.owner
        );
      }
      if (params.extraFlightId) {
        const now = Math.floor(Date.now() / 1000);
        db.prepare(
          `INSERT INTO Flight (id, number, airlineId, departureAirportId, scheduledArrivalAirportId,
             departureScheduleGateOriginal, arrivalScheduleGateOriginal, departureGate, arrivalGate, distance, isCancelled)
           VALUES (?, '555', ?, 'airport-a', 'airport-c', ?, ?, 'G1', 'H2', 1200, 0)`
        ).run(params.extraFlightId, IDS.airline, now + 3600, now + 7200);
        db.prepare(
          "INSERT INTO UserFlight VALUES (?, ?, 'synthetic-extra', NULL, 1)"
        ).run(ownerId, params.extraFlightId);
      }
      if (params.lastSyncMarker !== undefined) {
        db.prepare("UPDATE SyncInfo SET lastSync = ?").run(
          params.lastSyncMarker
        );
      }
    } finally {
      db.close();
    }

    const bundleDir = join(
      params.root,
      "exports",
      `bundle-${params.label ?? `e${params.epoch ?? 1}-s${params.sequence}`}-${Date.now()}`
    );
    return exportReplicaBundle({
      sourceDbPath: fixture.mainPath,
      outputBundleDir: bundleDir,
      requiredMountPath: params.root,
      producerId: "imac-exporter",
      accountId: params.accountId ?? "acct-1",
      ownerUserId: params.ownerUserId ?? IDS.owner,
      epoch: params.epoch ?? 1,
      sequence: params.sequence,
      signingPrivateKey: PRIV_KEY,
      captureStartedAt: params.captureStartedAt,
      captureCompletedAt: params.captureCompletedAt,
    });
  }

  it("preserves original receive and capture timestamps on idempotent resend, rejects conflicting sequence reuse, and rejects stale replays across restart", async () => {
    const root = makeTempDir();
    const stateRootDir = join(root, "receiver-state");

    let currentClockMs = Date.parse("2026-11-08T21:00:10.000Z");

    const receiver1 = new ReplicaReceiver({
      stateRootDir,
      storage: receiverStorage(stateRootDir),
      publicKey: PUB_KEY,
      producerId: "imac-exporter",
      accountId: "acct-1",
      ownerUserId: IDS.owner,
      epoch: 1,
      now: () => currentClockMs,
    });

    const bundle1 = await createBundleForSeq({
      root,
      sequence: 1,
      captureStartedAt: "2026-11-08T21:00:00.000Z",
      captureCompletedAt: "2026-11-08T21:00:02.000Z",
      label: "seq1-orig",
    });

    const accepted1 = receiver1.acceptBundle(bundle1.bundleDir);
    expect(accepted1.status).toBe("accepted");
    expect(accepted1.receivedAt).toBe("2026-11-08T21:00:10.000Z");
    expect(accepted1.receivedAtMs).toBe(Date.parse("2026-11-08T21:00:10.000Z"));

    // Advance receiver clock by 5 minutes and resend the EXACT same bundle1.
    currentClockMs = Date.parse("2026-11-08T21:05:10.000Z");
    const resend1 = receiver1.acceptBundle(bundle1.bundleDir);
    expect(resend1.status).toBe("duplicate_acknowledged");
    // Original receive timestamp MUST be preserved (never reset to 21:05:10)!
    expect(resend1.receivedAt).toBe("2026-11-08T21:00:10.000Z");
    expect(resend1.receivedAtMs).toBe(accepted1.receivedAtMs);
    expect(resend1.captureStartedAt).toBe("2026-11-08T21:00:00.000Z");
    expect(resend1.captureCompletedAt).toBe("2026-11-08T21:00:02.000Z");

    // Verify freshness at 21:05:10 reflects 300s receive age (from 21:00:10, not 0s from 21:05:10)
    // and 310s conservative snapshot age (from captureStartedAt 21:00:00).
    await receiver1.withLease((lease) => {
      const freshness = lease.computeFreshness({ now: currentClockMs });
      expect(freshness.replica_received_at).toBe("2026-11-08T21:00:10.000Z");
      expect(freshness.replica_receive_age_seconds).toBe(300);
      expect(freshness.snapshot_age_seconds).toBe(310);
      expect(freshness.capture_completion_age_seconds).toBe(308);
    });

    // Restart receiver and resend bundle1 again at 21:10:10: still duplicate_acknowledged with original timestamps.
    currentClockMs = Date.parse("2026-11-08T21:10:10.000Z");
    const receiverRestarted = new ReplicaReceiver({
      stateRootDir,
      storage: receiverStorage(stateRootDir),
      publicKey: PUB_KEY,
      producerId: "imac-exporter",
      accountId: "acct-1",
      ownerUserId: IDS.owner,
      epoch: 1,
      now: () => currentClockMs,
    });
    const resendAfterRestart = receiverRestarted.acceptBundle(bundle1.bundleDir);
    expect(resendAfterRestart.status).toBe("duplicate_acknowledged");
    expect(resendAfterRestart.receivedAt).toBe("2026-11-08T21:00:10.000Z");

    // Conflicting sequence reuse: same sequence=1 but different DB content / capture timestamps -> CONFLICTING_SEQUENCE
    const conflictingSeq1 = await createBundleForSeq({
      root,
      sequence: 1,
      captureStartedAt: "2026-11-08T21:01:00.000Z",
      captureCompletedAt: "2026-11-08T21:01:02.000Z",
      extraFlightId: "12121212-1212-4212-8212-121212121212",
      label: "seq1-conflict",
    });
    expect(() =>
      receiverRestarted.acceptBundle(conflictingSeq1.bundleDir)
    ).toThrowError(expect.objectContaining({ code: "CONFLICTING_SEQUENCE" }));

    // Accept sequence=2
    const bundle2 = await createBundleForSeq({
      root,
      sequence: 2,
      captureStartedAt: "2026-11-08T21:09:00.000Z",
      captureCompletedAt: "2026-11-08T21:09:02.000Z",
      extraFlightId: "23232323-2323-4323-8323-232323232323",
      label: "seq2-valid",
    });
    const accepted2 = receiverRestarted.acceptBundle(bundle2.bundleDir);
    expect(accepted2.status).toBe("accepted");
    expect(accepted2.sequence).toBe(2);
    expect(accepted2.highwaterSequence).toBe(2);

    // Replaying superseded sequence=1 (same content) must now be rejected with REPLAY_REJECTED!
    expect(() =>
      receiverRestarted.acceptBundle(bundle1.bundleDir)
    ).toThrowError(expect.objectContaining({ code: "REPLAY_REJECTED" }));

    // Replaying sequence=1 after another restart must ALSO be rejected with REPLAY_REJECTED!
    const receiverRestarted2 = new ReplicaReceiver({
      stateRootDir,
      storage: receiverStorage(stateRootDir),
      publicKey: PUB_KEY,
      producerId: "imac-exporter",
      accountId: "acct-1",
      ownerUserId: IDS.owner,
      epoch: 1,
      now: () => currentClockMs,
    });
    expect(() =>
      receiverRestarted2.acceptBundle(bundle1.bundleDir)
    ).toThrowError(expect.objectContaining({ code: "REPLAY_REJECTED" }));
    expect(() =>
      receiverRestarted2.acceptBundle(conflictingSeq1.bundleDir)
    ).toThrowError(expect.objectContaining({ code: "CONFLICTING_SEQUENCE" }));
  });

  it("recovers cleanly from crashes at every publication boundary and ENOSPC disk-full faults without corrupting accepted state", async () => {
    const root = makeTempDir();
    const stateRootDir = join(root, "crash-state");
    const nowMs = Date.parse("2026-11-08T21:30:00.000Z");

    const baseConfig = {
      stateRootDir,
      storage: receiverStorage(stateRootDir),
      publicKey: PUB_KEY,
      producerId: "imac-exporter",
      accountId: "acct-1",
      ownerUserId: IDS.owner,
      epoch: 1,
      now: () => nowMs,
    };

    const receiver = new ReplicaReceiver(baseConfig);
    const bundle1 = await createBundleForSeq({
      root,
      sequence: 1,
      captureStartedAt: "2026-11-08T21:20:00.000Z",
      captureCompletedAt: "2026-11-08T21:20:01.000Z",
      label: "crash-seq1",
    });
    receiver.acceptBundle(bundle1.bundleDir);

    const bundle2 = await createBundleForSeq({
      root,
      sequence: 2,
      captureStartedAt: "2026-11-08T21:25:00.000Z",
      captureCompletedAt: "2026-11-08T21:25:01.000Z",
      extraFlightId: "34343434-3434-4434-8434-343434343434",
      label: "crash-seq2",
    });

    // 1. Disk-full ENOSPC during staging (onStageWrite)
    const receiverStageEnospc = new ReplicaReceiver({
      ...baseConfig,
      faultHooks: {
        onStageWrite: () => {
          const err = new Error("ENOSPC: no space left on device");
          (err as NodeJS.ErrnoException).code = "ENOSPC";
          throw err;
        },
      },
    });
    expect(() =>
      receiverStageEnospc.acceptBundle(bundle2.bundleDir)
    ).toThrowError(expect.objectContaining({ code: "STORAGE_WRITE_FAILED" }));
    expect(receiverStageEnospc.getStateSnapshot().highwaterSequence).toBe(1);
    expect(readdirSync(join(stateRootDir, "staging"))).toHaveLength(0);

    // 2. Crash after verification in staging, before moving bundle to generations/ (beforePublishBundle)
    const receiverBeforePublishCrash = new ReplicaReceiver({
      ...baseConfig,
      faultHooks: {
        beforePublishBundle: () => {
          throw new Error("Simulated crash beforePublishBundle");
        },
      },
    });
    expect(() =>
      receiverBeforePublishCrash.acceptBundle(bundle2.bundleDir)
    ).toThrowError(expect.objectContaining({ code: "STORAGE_WRITE_FAILED" }));
    expect(
      receiverBeforePublishCrash.getStateSnapshot().highwaterSequence
    ).toBe(1);

    // 3. Abrupt crash AFTER moving bundle into generations/, BEFORE state.json is committed
    const receiverOrphanCrash = new ReplicaReceiver({
      ...baseConfig,
      faultHooks: {
        afterPublishBundleBeforeStateCommit: () => {
          throw new Error("Simulated SIGKILL afterPublishBundleBeforeStateCommit");
        },
      },
    });
    expect(() =>
      receiverOrphanCrash.acceptBundle(bundle2.bundleDir)
    ).toThrowError(expect.objectContaining({ code: "STORAGE_WRITE_FAILED" }));

    // Verify that the uncommitted orphan directory is sitting in generations/ prior to restart:
    expect(
      readdirSync(join(stateRootDir, "generations")).length
    ).toBeGreaterThan(1);

    // 4. Restart receiver: startup recovery must retire the uncommitted orphan and keep sequence=1 active!
    const receiverRecovered = new ReplicaReceiver(baseConfig);
    expect(receiverRecovered.getStateSnapshot().highwaterSequence).toBe(1);
    expect(readdirSync(join(stateRootDir, "generations"))).toHaveLength(1);
    expect(readdirSync(join(stateRootDir, "staging"))).toHaveLength(0);

    // 5. Disk-full ENOSPC during state.json commit (beforeCommitStateFile)
    const receiverStateEnospc = new ReplicaReceiver({
      ...baseConfig,
      faultHooks: {
        beforeCommitStateFile: () => {
          const err = new Error("ENOSPC: no space left on device writing state.json");
          (err as NodeJS.ErrnoException).code = "ENOSPC";
          throw err;
        },
      },
    });
    expect(() =>
      receiverStateEnospc.acceptBundle(bundle2.bundleDir)
    ).toThrowError(expect.objectContaining({ code: "STORAGE_WRITE_FAILED" }));
    expect(receiverStateEnospc.getStateSnapshot().highwaterSequence).toBe(1);
    expect(readdirSync(join(stateRootDir, "generations"))).toHaveLength(1);

    // 6. Now accept bundle2 normally: succeeds cleanly!
    const accepted2 = receiverRecovered.acceptBundle(bundle2.bundleDir);
    expect(accepted2.status).toBe("accepted");
    expect(accepted2.sequence).toBe(2);
    expect(receiverRecovered.getStateSnapshot().highwaterSequence).toBe(2);
  });

  it("serves previously verified same-account lastGood as explicit stale recovery when active DB is damaged without resetting highwater, and blocks cross-account lastGood leakage", async () => {
    const root = makeTempDir();
    const stateRootDir = join(root, "recovery-state");
    let nowMs = Date.parse("2026-11-08T21:40:00.000Z");

    const receiver = new ReplicaReceiver({
      stateRootDir,
      storage: receiverStorage(stateRootDir),
      publicKey: PUB_KEY,
      producerId: "imac-exporter",
      accountId: "acct-1",
      ownerUserId: IDS.owner,
      epoch: 1,
      now: () => nowMs,
    });

    const bundle1 = await createBundleForSeq({
      root,
      sequence: 1,
      captureStartedAt: "2026-11-08T21:30:00.000Z",
      captureCompletedAt: "2026-11-08T21:30:01.000Z",
      label: "rec-seq1",
    });
    const res1 = receiver.acceptBundle(bundle1.bundleDir);

    nowMs = Date.parse("2026-11-08T21:45:00.000Z");
    const bundle2 = await createBundleForSeq({
      root,
      sequence: 2,
      captureStartedAt: "2026-11-08T21:44:00.000Z",
      captureCompletedAt: "2026-11-08T21:44:01.000Z",
      extraFlightId: "45454545-4545-4545-8545-454545454545",
      label: "rec-seq2",
    });
    const res2 = receiver.acceptBundle(bundle2.bundleDir);

    // Corrupt active generation 2's replica.db on disk.
    chmodSync(res2.dbPath, 0o600);
    writeFileSync(res2.dbPath, "corrupted-sqlite-bytes");

    // Acquire lease: should fall back to verified lastGood (sequence 1) with explicit stale recovery label,
    // without resetting highwaterSequence (still 2) or sequence 1's original receivedAt!
    nowMs = Date.parse("2026-11-08T21:50:00.000Z");
    await receiver.withLease((lease) => {
      expect(lease.sequence).toBe(1);
      expect(lease.generationId).toBe(res1.generationId);
      expect(lease.isStaleRecovery).toBe(true);
      expect(lease.recoveryReason).toBe(
        "active_generation_damaged_serving_last_good"
      );
      expect(lease.receivedAt).toBe("2026-11-08T21:40:00.000Z");

      const freshness = lease.computeFreshness({ now: nowMs });
      expect(freshness.is_stale_recovery).toBe(true);
      expect(freshness.recovery_reason).toBe(
        "active_generation_damaged_serving_last_good"
      );
      expect(freshness.replica_received_at).toBe("2026-11-08T21:40:00.000Z");
      expect(freshness.replica_receive_age_seconds).toBe(600);
      expect(freshness.snapshot_age_seconds).toBe(1200);
    });

    // Highwater sequence MUST still be 2 (never rolled back to 1)
    expect(receiver.getStateSnapshot().highwaterSequence).toBe(2);

    // Account transition without explicit opt-in must fail closed (ACCOUNT_TRANSITION_REQUIRED)
    const secondOwnerId = "78787878-7878-4878-8878-787878787878";
    expect(
      () =>
        new ReplicaReceiver({
          stateRootDir,
          storage: receiverStorage(stateRootDir),
          publicKey: PUB_KEY,
          producerId: "imac-exporter",
          accountId: "acct-2",
          ownerUserId: secondOwnerId,
          epoch: 1,
          now: () => nowMs,
        })
    ).toThrowError(
      expect.objectContaining({ code: "ACCOUNT_TRANSITION_REQUIRED" })
    );

    // Explicit account transition retires old account's generations and clears active + lastGood
    const transitionedReceiver = new ReplicaReceiver({
      stateRootDir,
      storage: receiverStorage(stateRootDir),
      publicKey: PUB_KEY,
      producerId: "imac-exporter",
      accountId: "acct-2",
      ownerUserId: secondOwnerId,
      epoch: 1,
      allowAccountTransition: true,
      now: () => nowMs,
    });
    expect(transitionedReceiver.getStateSnapshot().activeGenerationId).toBeNull();
    expect(
      transitionedReceiver.getStateSnapshot().lastGoodGenerationId
    ).toBeNull();
    expect(transitionedReceiver.getStateSnapshot().highwaterSequence).toBe(0);
    expect(readdirSync(join(stateRootDir, "generations"))).toHaveLength(0);

    // Attempting to acquire a lease before new account data arrives MUST throw NO_ACTIVE_GENERATION
    // (never leaking acct-1's lastGood!).
    expect(() => transitionedReceiver.acquireLease()).toThrowError(
      expect.objectContaining({ code: "NO_ACTIVE_GENERATION" })
    );
  });

  it("pins generation, dbPath, ownerIdentity, manifest, and freshness across async pointer swaps and retains leased generations until release", async () => {
    const root = makeTempDir();
    const stateRootDir = join(root, "lease-state");
    let nowMs = Date.parse("2026-11-08T22:00:00.000Z");

    const receiver = new ReplicaReceiver({
      stateRootDir,
      storage: receiverStorage(stateRootDir),
      publicKey: PUB_KEY,
      producerId: "imac-exporter",
      accountId: "acct-1",
      ownerUserId: IDS.owner,
      epoch: 1,
      maxRetainedGenerations: 2,
      now: () => nowMs,
    });

    // Seq 1: 2 owner passenger flights, numeric SyncInfo.lastSync = 1
    const bundle1 = await createBundleForSeq({
      root,
      sequence: 1,
      captureStartedAt: "2026-11-08T21:59:00.000Z",
      captureCompletedAt: "2026-11-08T21:59:01.000Z",
      lastSyncMarker: 1,
      label: "lease-seq1",
    });
    const res1 = receiver.acceptBundle(bundle1.bundleDir);

    let pauseReader1Resolve!: () => void;
    const pauseReader1 = new Promise<void>((resolve) => {
      pauseReader1Resolve = resolve;
    });
    let reader1StartedResolve!: () => void;
    const reader1Started = new Promise<void>((resolve) => {
      reader1StartedResolve = resolve;
    });

    // Start Reader 1 inside `withReplicaLease` on generation 1
    const reader1Promise = withReplicaLease(receiver, async (lease1) => {
      const preSwapCtx = getActiveReplicaContext();
      expect(preSwapCtx?.sequence).toBe(1);
      expect(getActiveReplicaDbPath()).toBe(res1.dbPath);

      const preSwapFlights = new FlightyDatabase(
        getActiveReplicaDbPath()!,
        join(root, "none.sqlite")
      ).listFlights();
      expect(preSwapFlights).toHaveLength(2);

      reader1StartedResolve();
      await pauseReader1;

      // After generation 2 and generation 3 have been accepted on the receiver,
      // Reader 1's AsyncLocalStorage context and lease MUST still point to generation 1!
      const postSwapCtx = getActiveReplicaContext();
      expect(postSwapCtx?.generationId).toBe(res1.generationId);
      expect(postSwapCtx?.sequence).toBe(1);
      expect(getActiveReplicaDbPath()).toBe(res1.dbPath);
      expect(getActiveReplicaOwnerIdentity()?.userId).toBe(IDS.owner);
      expect(getActiveReplicaOwnerIdentity()?.sequence).toBe(1);

      const postSwapFlights = new FlightyDatabase(
        getActiveReplicaDbPath()!,
        join(root, "none.sqlite")
      ).listFlights();
      expect(postSwapFlights).toHaveLength(2);

      const postSwapFreshness = getActiveReplicaFreshness({
        now: Date.parse("2026-11-08T22:02:00.000Z"),
      });
      expect(postSwapFreshness?.sequence).toBe(1);
      expect(postSwapFreshness?.capture_started_at).toBe(
        "2026-11-08T21:59:00.000Z"
      );
      expect(postSwapFreshness?.snapshot_age_seconds).toBe(180);
      expect(postSwapFreshness?.replica_receive_age_seconds).toBe(120);
      // Numeric lastSync on seq 1 remains unverified
      expect(postSwapFreshness?.app_sync.status).toBe("unknown");
      expect(postSwapFreshness?.app_sync.unknown_reason_code).toBe(
        "unverified_numeric_sync_format"
      );

      return {
        leaseSeq: lease1.sequence,
        flightCount: postSwapFlights.length,
      };
    });

    await reader1Started;

    // While Reader 1 is paused mid-invocation, accept sequence 2 and sequence 3.
    nowMs = Date.parse("2026-11-08T22:00:30.000Z");
    const bundle2 = await createBundleForSeq({
      root,
      sequence: 2,
      captureStartedAt: "2026-11-08T22:00:20.000Z",
      captureCompletedAt: "2026-11-08T22:00:21.000Z",
      extraFlightId: "56565656-5656-4656-8656-565656565656",
      lastSyncMarker: "2026-11-08T21:30:00Z",
      label: "lease-seq2",
    });
    const res2 = receiver.acceptBundle(bundle2.bundleDir);

    nowMs = Date.parse("2026-11-08T22:01:00.000Z");
    const bundle3 = await createBundleForSeq({
      root,
      sequence: 3,
      captureStartedAt: "2026-11-08T22:00:50.000Z",
      captureCompletedAt: "2026-11-08T22:00:51.000Z",
      extraFlightId: "67676767-6767-4767-8767-676767676767",
      lastSyncMarker: "2026-11-08T21:45:00Z",
      label: "lease-seq3",
    });
    const res3 = receiver.acceptBundle(bundle3.bundleDir);

    // Because Reader 1 still holds a lease on seq 1, seq 1's DB file MUST still exist on disk
    // alongside seq 2 (lastGood) and seq 3 (active)!
    expect(existsSync(res1.dbPath)).toBe(true);
    expect(existsSync(res2.dbPath)).toBe(true);
    expect(existsSync(res3.dbPath)).toBe(true);
    expect(receiver.getActiveLeaseCount(res1.generationId)).toBe(1);

    // Concurrent Reader 2 acquiring a lease now gets seq 3 and sees ISO SyncInfo.lastSync separate from capture age
    await withReplicaLease(receiver, async (lease2) => {
      expect(lease2.sequence).toBe(3);
      const flights2 = new FlightyDatabase(
        lease2.dbPath,
        join(root, "none.sqlite")
      ).listFlights();
      expect(flights2).toHaveLength(3);

      const f3 = lease2.computeFreshness({
        now: Date.parse("2026-11-08T22:02:00.000Z"),
      });
      expect(f3.sequence).toBe(3);
      expect(f3.snapshot_age_seconds).toBe(70); // 22:02:00 - 22:00:50
      expect(f3.replica_receive_age_seconds).toBe(60); // 22:02:00 - 22:01:00
      expect(f3.app_sync.status).toBe("known");
      expect(f3.app_sync.last_synced_at).toBe("2026-11-08T21:45:00.000Z");
      expect(f3.app_sync.sync_age_seconds).toBe(1020); // 17 minutes app sync age vs 70s snapshot age!
    });

    // Now resume Reader 1 and let it finish and release its lease on seq 1.
    pauseReader1Resolve();
    const reader1Result = await reader1Promise;
    expect(reader1Result).toEqual({ leaseSeq: 1, flightCount: 2 });

    // As soon as Reader 1 releases its lease, lease-aware cleanup retires seq 1
    // while keeping seq 3 (active) and seq 2 (lastGood)!
    expect(receiver.getActiveLeaseCount(res1.generationId)).toBe(0);
    expect(existsSync(res1.dbPath)).toBe(false);
    expect(existsSync(res2.dbPath)).toBe(true);
    expect(existsSync(res3.dbPath)).toBe(true);

    // Verify lease release idempotency and post-release openDatabase guard:
    const leaseA = receiver.acquireLease();
    const leaseB = receiver.acquireLease();
    expect(receiver.getActiveLeaseCount(res3.generationId)).toBe(2);
    leaseA.release();
    // Calling release() a second time on leaseA must not decrement leaseB's count!
    leaseA.release();
    expect(receiver.getActiveLeaseCount(res3.generationId)).toBe(1);
    expect(() => leaseA.openDatabase()).toThrowError(
      expect.objectContaining({ code: "INVALID_CONFIG" })
    );
    leaseB.release();
    expect(receiver.getActiveLeaseCount(res3.generationId)).toBe(0);
  });
});
