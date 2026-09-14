import test from "node:test";
import assert from "node:assert/strict";
import { SnapshotStore, MemorySnapshotBackend } from "../lib/snapshot-store.js";
import { createTabSnapshot, createManualTabSnapshot, createRestorationPlan, formatSnapshotTimestamp, getSnapshotAge } from "../lib/snapshot.js";

test("SnapshotStore retrieves latest snapshot per tab and maps all tabs correctly", async () => {
  const store = new SnapshotStore({ backend: new MemorySnapshotBackend() });
  await store.open();

  assert.equal(await store.hasSnapshotForTab(101), false);
  assert.equal(await store.getLatestSnapshot(101), null);

  // Tab 101 has 3 snapshots over time
  const snap1 = createTabSnapshot({ id: 101, url: "https://tab101.com/v1" }, { timestamp: 1000 });
  const snap2 = createTabSnapshot({ id: 101, url: "https://tab101.com/v2" }, { timestamp: 2000 });
  const snap3 = createTabSnapshot({ id: 101, url: "https://tab101.com/v3" }, { timestamp: 3000 });

  // Tab 102 has 1 snapshot
  const snapTab102 = createTabSnapshot({ id: 102, url: "https://tab102.com" }, { timestamp: 1500 });

  await store.saveSnapshot(snap1);
  await store.saveSnapshot(snap2);
  await store.saveSnapshot(snap3);
  await store.saveSnapshot(snapTab102);

  assert.equal(await store.hasSnapshotForTab(101), true);
  assert.equal(await store.hasSnapshotForTab(102), true);
  assert.equal(await store.hasSnapshotForTab(999), false);

  // getLatestSnapshot returns the newest snapshot for tab 101
  const latest101 = await store.getLatestSnapshot(101);
  assert.ok(latest101);
  assert.equal(latest101.id, snap3.id);
  assert.equal(latest101.url, "https://tab101.com/v3");
  assert.equal(latest101.timestamp, 3000);

  // getAllLatestSnapshots returns map of all tabs
  const allLatest = await store.getAllLatestSnapshots();
  assert.equal(allLatest.size, 2);
  assert.equal(allLatest.get(101).id, snap3.id);
  assert.equal(allLatest.get(102).id, snapTab102.id);
});

test("SnapshotStore with keepLatestOnly automatically prunes older snapshots on save", async () => {
  const store = new SnapshotStore({
    backend: new MemorySnapshotBackend(),
    keepLatestOnly: true
  });
  await store.open();

  const snap1 = createTabSnapshot({ id: 201, url: "https://site.org/step1" }, { timestamp: 1000 });
  const snap2 = createTabSnapshot({ id: 201, url: "https://site.org/step2" }, { timestamp: 2000 });
  const snap3 = createTabSnapshot({ id: 201, url: "https://site.org/step3" }, { timestamp: 3000 });

  await store.saveSnapshot(snap1);
  assert.equal(await store.count(), 1);

  await store.saveSnapshot(snap2);
  assert.equal(await store.count(), 1); // snap1 was replaced

  await store.saveSnapshot(snap3);
  assert.equal(await store.count(), 1); // snap2 was replaced

  const current = await store.getLatestSnapshot(201);
  assert.equal(current.id, snap3.id);
  assert.equal(current.url, "https://site.org/step3");

  const history = await store.getSnapshotsForTab(201);
  assert.equal(history.length, 1);
  assert.equal(history[0].id, snap3.id);
});

test("SnapshotStore supports configurable historical snapshot retention and policy toggling", async () => {
  const store = new SnapshotStore({
    backend: new MemorySnapshotBackend(),
    enableHistory: true,
    maxSnapshotsPerTab: 3
  });
  await store.open();

  // Save 4 snapshots for tab 501
  const s1 = createTabSnapshot({ id: 501, url: "https://example.com/1" }, { timestamp: 1000 });
  const s2 = createTabSnapshot({ id: 501, url: "https://example.com/2" }, { timestamp: 2000 });
  const s3 = createTabSnapshot({ id: 501, url: "https://example.com/3" }, { timestamp: 3000 });
  const s4 = createTabSnapshot({ id: 501, url: "https://example.com/4" }, { timestamp: 4000 });

  await store.saveSnapshot(s1);
  await store.saveSnapshot(s2);
  await store.saveSnapshot(s3);
  await store.saveSnapshot(s4);

  // Tab 501 history is capped at maxSnapshotsPerTab (3)
  const history501 = await store.getSnapshotsForTab(501);
  assert.equal(history501.length, 3);
  // Newest first
  assert.equal(history501[0].id, s4.id);
  assert.equal(history501[1].id, s3.id);
  assert.equal(history501[2].id, s2.id);

  // Stats
  const stats = await store.getSnapshotHistoryStats(501);
  assert.equal(stats.count, 3);
  assert.equal(stats.oldestTimestamp, 2000);
  assert.equal(stats.newestTimestamp, 4000);
  assert.ok(stats.totalEstimatedBytes > 0);

  // Manual pruneTabHistory down to 2
  const pruned = await store.pruneTabHistory(501, 2);
  assert.equal(pruned, 1);
  const remainingHistory = await store.getSnapshotsForTab(501);
  assert.equal(remainingHistory.length, 2);

  // Toggle history policy dynamically with pruneImmediately: true
  const policyRes = await store.setHistoryPolicy({ enableHistory: false, pruneImmediately: true });
  assert.equal(policyRes.prunedCount, 1); // 1 remaining older snapshot pruned

  const singleSnapshot = await store.getSnapshotsForTab(501);
  assert.equal(singleSnapshot.length, 1);
  assert.equal(singleSnapshot[0].id, s4.id);
});

test("snapshot timestamps support relative formatting, age metrics, and temporal range querying", async () => {
  const baseTime = 1700000000000; // Reference epoch

  // Formatting tests
  assert.equal(formatSnapshotTimestamp(baseTime, baseTime + 10 * 1000), "just now");
  assert.equal(formatSnapshotTimestamp(baseTime, baseTime + 5 * 60 * 1000), "5 minutes ago");
  assert.equal(formatSnapshotTimestamp(baseTime, baseTime + 2 * 60 * 60 * 1000), "2 hours ago");
  assert.equal(formatSnapshotTimestamp(baseTime, baseTime + 24 * 60 * 60 * 1000), "yesterday");
  assert.equal(formatSnapshotTimestamp(baseTime, baseTime + 3 * 24 * 60 * 60 * 1000), "3 days ago");
  assert.ok(formatSnapshotTimestamp(baseTime, baseTime + 30 * 24 * 60 * 60 * 1000).length > 0);
  assert.equal(formatSnapshotTimestamp(null), "Unknown");

  // Age calculation
  const snapRecent = createTabSnapshot({ id: 10, url: "https://site.org" }, { timestamp: baseTime });
  const ageRecent = getSnapshotAge(snapRecent, baseTime + 15 * 60 * 1000);
  assert.equal(ageRecent.ageMinutes, 15);
  assert.equal(ageRecent.isRecent, true);

  const ageOld = getSnapshotAge(snapRecent, baseTime + 5 * 60 * 60 * 1000);
  assert.equal(ageOld.ageHours, 5);
  assert.equal(ageOld.isRecent, false);

  // Temporal range queries in SnapshotStore
  const store = new SnapshotStore({ backend: new MemorySnapshotBackend() });
  await store.open();

  const t1 = createTabSnapshot({ id: 700, url: "https://range.com/1" }, { timestamp: 10000 });
  const t2 = createTabSnapshot({ id: 700, url: "https://range.com/2" }, { timestamp: 20000 });
  const t3 = createTabSnapshot({ id: 700, url: "https://range.com/3" }, { timestamp: 30000 });
  const t4 = createTabSnapshot({ id: 800, url: "https://other.com" }, { timestamp: 25000 });

  await store.saveSnapshot(t1);
  await store.saveSnapshot(t2);
  await store.saveSnapshot(t3);
  await store.saveSnapshot(t4);

  // Query within range [15000, 35000] for tab 700
  const rangeResults = await store.getSnapshotsByTimeRange({
    tabId: 700,
    since: 15000,
    until: 35000,
    order: "asc"
  });
  assert.equal(rangeResults.length, 2);
  assert.equal(rangeResults[0].id, t2.id); // 20000
  assert.equal(rangeResults[1].id, t3.id); // 30000

  // getSnapshotsSince 22000 across all tabs
  const sinceResults = await store.getSnapshotsSince(22000);
  assert.equal(sinceResults.length, 2); // t3 (30000) and t4 (25000)

  // getSnapshotsOlderThan 22000 for tab 700
  const olderResults = await store.getSnapshotsOlderThan(22000, 700);
  assert.equal(olderResults.length, 2); // t2 (20000) and t1 (10000)
});

test("createManualTabSnapshot and createAndSaveManualSnapshot capture checkpoint with custom label and protect flag", async () => {
  const store = new SnapshotStore({ backend: new MemorySnapshotBackend() });
  await store.open();

  // Create manual snapshot directly
  const manual1 = createManualTabSnapshot(
    { id: 901, url: "https://draft.blog.com/post/new", title: "Editing Blog Post" },
    { label: "Pre-submit Checkpoint", note: "Saved before submitting draft" }
  );

  assert.equal(manual1.tabId, 901);
  assert.equal(manual1.isManual, true);
  assert.equal(manual1.reason, "manual");
  assert.equal(manual1.label, "Pre-submit Checkpoint");
  assert.equal(manual1.note, "Saved before submitting draft");
  assert.equal(manual1.protectFromPurge, true);

  // Save via createAndSaveManualSnapshot
  const savedManual = await store.createAndSaveManualSnapshot(
    { id: 901, url: "https://draft.blog.com/post/new", title: "Editing Blog Post v2" },
    { label: "Midway Save" }
  );
  assert.ok(savedManual.id);
  assert.equal(savedManual.isManual, true);
  assert.equal(savedManual.label, "Midway Save");

  // Save standard auto-suspended snapshot on same tab
  const autoSnap = createTabSnapshot({ id: 901, url: "https://draft.blog.com/post/new" }, { reason: "idle_timeout" });
  await store.saveSnapshot(autoSnap);

  // Verify getManualSnapshots filters only manual ones
  const manuals = await store.getManualSnapshots(901);
  assert.equal(manuals.length, 1);
  assert.equal(manuals[0].id, savedManual.id);
  assert.equal(manuals[0].label, "Midway Save");

  // Total snapshots for tab is 2 (1 manual + 1 auto)
  const allTabSnaps = await store.getSnapshotsForTab(901);
  assert.equal(allTabSnaps.length, 2);
});

test("SnapshotStore snapshot deletion supports single, batch, predicate, and protected safeguards", async () => {
  const store = new SnapshotStore({ backend: new MemorySnapshotBackend() });
  await store.open();

  const snapA = createTabSnapshot({ id: 111, url: "https://a.com" }, { id: "snap_A" });
  const snapB = createTabSnapshot({ id: 111, url: "https://b.com" }, { id: "snap_B", protectFromPurge: true });
  const snapC = createTabSnapshot({ id: 222, url: "https://c.com" }, { id: "snap_C" });
  const snapD = createTabSnapshot({ id: 222, url: "https://d.com" }, { id: "snap_D", protectFromPurge: true });
  const snapE = createTabSnapshot({ id: 333, url: "https://e.com" }, { id: "snap_E" });

  await store.saveSnapshot(snapA);
  await store.saveSnapshot(snapB);
  await store.saveSnapshot(snapC);
  await store.saveSnapshot(snapD);
  await store.saveSnapshot(snapE);
  assert.equal(await store.count(), 5);

  // Single deletion of unprotected snapshot
  const delA = await store.deleteSnapshot("snap_A");
  assert.equal(delA, true);
  assert.equal(await store.getSnapshot("snap_A"), null);
  assert.equal(await store.count(), 4);

  // Single deletion with nonexistent ID
  assert.equal(await store.deleteSnapshot("non_existent_id"), false);

  // Deletion respecting protection
  const delBProtected = await store.deleteSnapshot("snap_B", { respectProtection: true });
  assert.equal(delBProtected, false);
  assert.ok(await store.getSnapshot("snap_B")); // still exists

  // Batch deletion of snap_C and snap_D with respectProtection
  const batchRes = await store.deleteSnapshots(["snap_C", "snap_D"], { respectProtection: true });
  assert.equal(batchRes.deletedCount, 1); // snap_C deleted
  assert.equal(batchRes.skippedProtectedCount, 1); // snap_D skipped
  assert.equal(await store.getSnapshot("snap_C"), null);
  assert.ok(await store.getSnapshot("snap_D"));

  // Predicate deletion (delete snap_E by URL match)
  const predRes = await store.deleteSnapshotsMatching(s => s.url === "https://e.com");
  assert.equal(predRes.deletedCount, 1);
  assert.equal(await store.getSnapshot("snap_E"), null);

  // Forced delete of remaining protected snap_B and snap_D
  assert.equal(await store.deleteSnapshot("snap_B"), true);
  assert.equal(await store.deleteSnapshot("snap_D"), true);
  assert.equal(await store.count(), 0);
});

test("createRestorationPlan and prepareRestorationFromHistory construct structured restoration plans", async () => {
  const store = new SnapshotStore({ backend: new MemorySnapshotBackend() });
  await store.open();

  const snapV1 = createTabSnapshot(
    { id: 300, url: "https://docs.app/v1", title: "Version 1" },
    { timestamp: 1000, scroll: { x: 0, y: 150 } }
  );
  const snapV2 = createTabSnapshot(
    { id: 300, url: "https://docs.app/v2", title: "Version 2" },
    { timestamp: 2000, scroll: { x: 0, y: 500 } }
  );
  const snapV3 = createTabSnapshot(
    { id: 300, url: "https://docs.app/v3", title: "Version 3" },
    { timestamp: 3000, scroll: { x: 0, y: 900 } }
  );

  await store.saveSnapshot(snapV1);
  await store.saveSnapshot(snapV2);
  await store.saveSnapshot(snapV3);

  // Direct createRestorationPlan
  const planDirect = createRestorationPlan(snapV2, { targetTabId: 999, openInNewTab: true });
  assert.equal(planDirect.snapshotId, snapV2.id);
  assert.equal(planDirect.targetTabId, 999);
  assert.equal(planDirect.openInNewTab, true);
  assert.equal(planDirect.url, "https://docs.app/v2");
  assert.equal(planDirect.scroll.y, 500);
  assert.ok(planDirect.plannedAt > 0);

  // Restore latest by index 0
  const planLatest = await store.prepareRestorationFromHistory({ tabId: 300, index: 0 });
  assert.ok(planLatest);
  assert.equal(planLatest.snapshotId, snapV3.id);
  assert.equal(planLatest.isHistorical, false); // Index 0 is latest
  assert.equal(planLatest.url, "https://docs.app/v3");

  // Restore previous (v2) by index 1
  const planV2 = await store.prepareRestorationFromHistory({ tabId: 300, index: 1 });
  assert.ok(planV2);
  assert.equal(planV2.snapshotId, snapV2.id);
  assert.equal(planV2.isHistorical, true); // Index 1 is historical
  assert.equal(planV2.scroll.y, 500);

  // Restore oldest (v1) by snapshotId
  const planV1 = await store.prepareRestorationFromHistory(snapV1.id);
  assert.ok(planV1);
  assert.equal(planV1.snapshotId, snapV1.id);
  assert.equal(planV1.isHistorical, true); // Older than latest (v3)
  assert.equal(planV1.scroll.y, 150);

  // Invalid inputs return null
  assert.equal(await store.prepareRestorationFromHistory("non_existent_snap"), null);
  assert.equal(await store.prepareRestorationFromHistory({ tabId: 300, index: 99 }), null);
});
