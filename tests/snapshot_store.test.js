import test from "node:test";
import assert from "node:assert/strict";
import {
  SnapshotStore,
  MemorySnapshotBackend,
  IndexedDBSnapshotBackend,
  DB_NAME,
  DB_VERSION,
  STORE_NAME,
  DEFAULT_SNAPSHOT_EXPIRATION_MS,
  isSnapshotExpired,
  MAX_SNAPSHOT_SIZE_BYTES,
  MAX_STORE_SIZE_BYTES,
  estimateSnapshotSize,
  enforceSnapshotSizeLimit,
  SNAPSHOT_EXPORT_VERSION,
  serializeSnapshotsExport,
  parseAndValidateSnapshotsImport
} from "../lib/snapshot-store.js";
import { createTabSnapshot, migrateSnapshot, validateSnapshotSchema, isSnapshotCorrupted, repairCorruptedSnapshot } from "../lib/snapshot.js";

test("SnapshotStore initializes with memory backend and persists snapshots", async () => {
  const store = new SnapshotStore({ backend: new MemorySnapshotBackend() });
  await store.open();

  assert.equal(await store.count(), 0);

  const snap1 = createTabSnapshot({ id: 201, url: "https://example.com/page1", title: "Page 1" }, { timestamp: 1000 });
  const snap2 = createTabSnapshot({ id: 201, url: "https://example.com/page2", title: "Page 2" }, { timestamp: 2000 });
  const snap3 = createTabSnapshot({ id: 202, url: "https://example.org", title: "Other Tab" }, { timestamp: 1500 });

  await store.saveSnapshot(snap1);
  await store.saveSnapshot(snap2);
  await store.saveSnapshot(snap3);

  assert.equal(await store.count(), 3);

  // Retrieve single snapshot by ID
  const retrieved = await store.getSnapshot(snap1.id);
  assert.equal(retrieved.id, snap1.id);
  assert.equal(retrieved.url, "https://example.com/page1");

  // Retrieve latest snapshot for tab
  const latest = await store.getLatestSnapshotForTab(201);
  assert.equal(latest.id, snap2.id);
  assert.equal(latest.title, "Page 2");

  // Retrieve history for tab (newest first)
  const history = await store.getSnapshotsForTab(201);
  assert.equal(history.length, 2);
  assert.equal(history[0].id, snap2.id);
  assert.equal(history[1].id, snap1.id);

  // Limit query
  const limited = await store.getSnapshotsForTab(201, 1);
  assert.equal(limited.length, 1);
  assert.equal(limited[0].id, snap2.id);

  // Retrieve all snapshots
  const all = await store.getAllSnapshots();
  assert.equal(all.length, 3);

  // Delete single snapshot
  const deletedOne = await store.deleteSnapshot(snap3.id);
  assert.equal(deletedOne, true);
  assert.equal(await store.count(), 2);
  assert.equal(await store.getSnapshot(snap3.id), null);

  // Delete by tab ID
  const deletedCount = await store.deleteSnapshotsForTab(201);
  assert.equal(deletedCount, 2);
  assert.equal(await store.count(), 0);

  // Clear
  await store.saveSnapshot(snap1);
  assert.equal(await store.count(), 1);
  await store.clear();
  assert.equal(await store.count(), 0);
});

test("SnapshotStore validates schema before saving and rejects corrupted/invalid snapshots", async () => {
  const store = new SnapshotStore({ backend: new MemorySnapshotBackend() });
  await store.open();

  await assert.rejects(
    async () => {
      await store.saveSnapshot({ id: "invalid", tabId: "not-a-number" });
    },
    /Invalid snapshot schema/
  );
});

test("IndexedDBSnapshotBackend exposes expected database constants and schema definition", () => {
  assert.equal(DB_NAME, "tabvault-snapshots");
  assert.equal(DB_VERSION, 1);
  assert.equal(STORE_NAME, "snapshots");

  const backend = new IndexedDBSnapshotBackend();
  assert.equal(backend.dbName, DB_NAME);
  assert.equal(backend.version, DB_VERSION);
});

test("migrateSnapshot and SnapshotStore upgrade legacy unversioned snapshots to V1 seamlessly", async () => {
  const backend = new MemorySnapshotBackend();
  const store = new SnapshotStore({ backend });
  await store.open();

  // Simulate a legacy unversioned V0 snapshot in backend
  const legacyV0 = {
    id: "legacy_snap_301",
    tabId: 301,
    url: "https://old.example.com",
    title: "Old Site",
    timestamp: 1600000000000
    // Missing schemaVersion, scroll, forms, screenshot, reason, context
  };

  // Directly insert raw into backend (bypassing saveSnapshot schema validation)
  await backend.put(legacyV0);

  // Retrieve via SnapshotStore — automatic migration to V1 must occur
  const retrieved = await store.getSnapshot("legacy_snap_301");
  assert.equal(retrieved.schemaVersion, 1);
  assert.equal(retrieved.tabId, 301);
  assert.equal(retrieved.url, "https://old.example.com");
  assert.equal(retrieved.title, "Old Site");
  assert.deepEqual(retrieved.scroll, { x: 0, y: 0, percentX: 0, percentY: 0 });
  assert.equal(retrieved.forms, null);
  assert.equal(retrieved.screenshot.isFallback, true);
  assert.equal(retrieved.reason, "manual");
  assert.ok(retrieved.context && typeof retrieved.context === "object");

  // Verify migrated record passes validateSnapshotSchema
  const validation = validateSnapshotSchema(retrieved);
  assert.equal(validation.valid, true);

  // Also verify getAllSnapshots migrates properly
  const all = await store.getAllSnapshots();
  assert.equal(all.length, 1);
  assert.equal(all[0].schemaVersion, 1);
});

test("isSnapshotExpired and purgeExpiredSnapshots enforce expiration policy while protecting pinned tabs", async () => {
  const now = 1700000000000;
  const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
  const tenDaysMs = 10 * 24 * 60 * 60 * 1000;

  // Recent snapshot (2 days old)
  const fresh = createTabSnapshot({ id: 401, url: "https://fresh.example.com" }, { timestamp: now - twoDaysMs });
  // Expired snapshot (10 days old)
  const expired = createTabSnapshot({ id: 402, url: "https://expired.example.com" }, { timestamp: now - tenDaysMs });
  // Expired snapshot but pinned tab
  const expiredPinned = createTabSnapshot({ id: 403, url: "https://pinned.example.com", pinned: true }, { timestamp: now - tenDaysMs });
  // Expired snapshot but explicit protectFromPurge
  const expiredProtected = createTabSnapshot({ id: 404, url: "https://saved.example.com" }, { timestamp: now - tenDaysMs });
  expiredProtected.protectFromPurge = true;

  assert.equal(isSnapshotExpired(fresh, DEFAULT_SNAPSHOT_EXPIRATION_MS, now), false);
  assert.equal(isSnapshotExpired(expired, DEFAULT_SNAPSHOT_EXPIRATION_MS, now), true);
  assert.equal(isSnapshotExpired(expiredPinned, DEFAULT_SNAPSHOT_EXPIRATION_MS, now), false);
  assert.equal(isSnapshotExpired(expiredProtected, DEFAULT_SNAPSHOT_EXPIRATION_MS, now), false);

  const store = new SnapshotStore({ backend: new MemorySnapshotBackend() });
  await store.open();

  await store.saveSnapshot(fresh);
  await store.saveSnapshot(expired);
  await store.saveSnapshot(expiredPinned);
  await store.saveSnapshot(expiredProtected);

  assert.equal(await store.count(), 4);

  // Purge with default 7 day expiration
  const purgedCount = await store.purgeExpiredSnapshots(DEFAULT_SNAPSHOT_EXPIRATION_MS, now);
  assert.equal(purgedCount, 1);
  assert.equal(await store.count(), 3);

  // Expired was removed
  assert.equal(await store.getSnapshot(expired.id), null);

  // Fresh, pinned, and protected remain intact
  assert.ok(await store.getSnapshot(fresh.id));
  assert.ok(await store.getSnapshot(expiredPinned.id));
  assert.ok(await store.getSnapshot(expiredProtected.id));
});

test("SnapshotStore cleanupOrphanedSnapshots removes snapshots of closed tabs while protecting pinned/saved tabs", async () => {
  const store = new SnapshotStore({ backend: new MemorySnapshotBackend() });
  await store.open();

  const snapLive = createTabSnapshot({ id: 501, url: "https://live.example.com" });
  const snapClosed = createTabSnapshot({ id: 502, url: "https://closed.example.com" });
  const snapClosedPinned = createTabSnapshot({ id: 503, url: "https://closed-pinned.example.com", pinned: true });
  const snapClosedProtected = createTabSnapshot({ id: 504, url: "https://closed-protected.example.com" });
  snapClosedProtected.protectFromPurge = true;

  await store.saveSnapshot(snapLive);
  await store.saveSnapshot(snapClosed);
  await store.saveSnapshot(snapClosedPinned);
  await store.saveSnapshot(snapClosedProtected);

  assert.equal(await store.count(), 4);

  // Live tabs only contains tab 501
  const deleted = await store.cleanupOrphanedSnapshots([501]);
  assert.equal(deleted, 1);
  assert.equal(await store.count(), 3);

  // 502 was deleted
  assert.equal(await store.getSnapshot(snapClosed.id), null);

  // 501 (live), 503 (pinned), and 504 (protected) kept
  assert.ok(await store.getSnapshot(snapLive.id));
  assert.ok(await store.getSnapshot(snapClosedPinned.id));
  assert.ok(await store.getSnapshot(snapClosedProtected.id));
});

test("SnapshotStore cleanupExcessSnapshotsPerTab trims history to max limit keeping newest", async () => {
  const store = new SnapshotStore({ backend: new MemorySnapshotBackend() });
  await store.open();

  // Create 6 snapshots for tab 600
  for (let i = 1; i <= 6; i++) {
    const snap = createTabSnapshot({ id: 600, url: `https://example.com/step${i}` }, { timestamp: 1000 * i });
    await store.saveSnapshot(snap);
  }

  assert.equal(await store.count(), 6);

  // Enforce max 3 snapshots per tab
  const excessPurged = await store.cleanupExcessSnapshotsPerTab(3);
  assert.equal(excessPurged, 3);
  assert.equal(await store.count(), 3);

  // Remaining snapshots should be steps 6, 5, 4 (newest)
  const history = await store.getSnapshotsForTab(600);
  assert.equal(history.length, 3);
  assert.equal(history[0].url, "https://example.com/step6");
  assert.equal(history[1].url, "https://example.com/step5");
  assert.equal(history[2].url, "https://example.com/step4");
});

test("SnapshotStore runCleanupPipeline executes composite cleanup and returns breakdown", async () => {
  const now = 2000000000000;
  const store = new SnapshotStore({ backend: new MemorySnapshotBackend() });
  await store.open();

  // 1. Expired snapshot (> 10 days old)
  const expired = createTabSnapshot({ id: 701, url: "https://expired.org" }, { timestamp: now - 800000000 });
  await store.saveSnapshot(expired);

  // 2. Orphaned snapshot (not in liveTabIds)
  const orphan = createTabSnapshot({ id: 702, url: "https://orphan.org" }, { timestamp: now - 1000 });
  await store.saveSnapshot(orphan);

  // 3. Live tab with 4 snapshots
  for (let i = 1; i <= 4; i++) {
    const snap = createTabSnapshot({ id: 703, url: `https://live.org/v${i}` }, { timestamp: now - 100 * (5 - i) });
    await store.saveSnapshot(snap);
  }

  assert.equal(await store.count(), 6);

  const report = await store.runCleanupPipeline({
    now,
    maxAgeMs: 500000000, // expired will be purged
    liveTabIds: [703],   // 702 orphan will be purged
    maxPerTab: 2         // 703 will have 2 oldest purged (4 -> 2)
  });

  assert.equal(report.expiredPurged, 1);
  assert.equal(report.orphansPurged, 1);
  assert.equal(report.excessPurged, 2);
  assert.equal(report.totalPurged, 4);

  assert.equal(await store.count(), 2);
});

test("enforceSnapshotSizeLimit degrades heavy screenshot and forms when size threshold exceeded", () => {
  const normalSnap = createTabSnapshot({ id: 801, url: "https://example.com" });
  assert.ok(estimateSnapshotSize(normalSnap) < 5000);

  // Snapshot with simulated unconstrained 600KB screenshot
  const oversizedSnap = createTabSnapshot({ id: 802, url: "https://example.com/big" });
  oversizedSnap.screenshot = {
    isFallback: false,
    dataUrl: "data:image/jpeg;base64," + "X".repeat(600 * 1024)
  };
  oversizedSnap.forms = [{ type: "text", name: "desc", value: "Lots of details" }];

  assert.ok(estimateSnapshotSize(oversizedSnap) > MAX_SNAPSHOT_SIZE_BYTES);

  // Enforce size limit
  const bounded = enforceSnapshotSizeLimit(oversizedSnap, MAX_SNAPSHOT_SIZE_BYTES);
  assert.ok(estimateSnapshotSize(bounded) <= MAX_SNAPSHOT_SIZE_BYTES);
  // Screenshot degraded to fallback
  assert.equal(bounded.screenshot.isFallback, true);
  assert.equal(bounded.screenshot.truncated, true);
});

test("SnapshotStore enforceStoreQuota evicts oldest unpinned snapshots under memory pressure", async () => {
  const store = new SnapshotStore({ backend: new MemorySnapshotBackend() });
  await store.open();

  // Create 5 snapshots with timestamps 1000, 2000, 3000, 4000, 5000
  const snap1 = createTabSnapshot({ id: 901, url: "https://example.com/1" }, { timestamp: 1000 });
  const snap2 = createTabSnapshot({ id: 902, url: "https://example.com/2", pinned: true }, { timestamp: 2000 }); // pinned!
  const snap3 = createTabSnapshot({ id: 903, url: "https://example.com/3" }, { timestamp: 3000 });
  const snap4 = createTabSnapshot({ id: 904, url: "https://example.com/4" }, { timestamp: 4000 });
  const snap5 = createTabSnapshot({ id: 905, url: "https://example.com/5" }, { timestamp: 5000 });

  await store.saveSnapshot(snap1);
  await store.saveSnapshot(snap2);
  await store.saveSnapshot(snap3);
  await store.saveSnapshot(snap4);
  await store.saveSnapshot(snap5);

  const totalBytes = await store.estimateTotalStoreSizeBytes();
  assert.ok(totalBytes > 0);

  // Set quota to 70% of totalBytes (evicts oldest unpinned to reach target 80% of quota)
  const quota = Math.floor(totalBytes * 0.7);
  const result = await store.enforceStoreQuota(quota);

  assert.ok(result.evictedCount >= 1);
  assert.ok(result.freedBytes > 0);
  assert.ok(result.remainingBytes <= quota);

  // snap1 (oldest unpinned) was evicted
  assert.equal(await store.getSnapshot(snap1.id), null);
  // snap2 was pinned, so it MUST NOT be evicted
  assert.ok(await store.getSnapshot(snap2.id));
  // snap5 (newest) remains
  assert.ok(await store.getSnapshot(snap5.id));
});

test("isSnapshotCorrupted and repairCorruptedSnapshot restore broken records while discarding hopeless records", () => {
  // Completely empty or non-object is corrupted and unrecoverable
  assert.equal(isSnapshotCorrupted(null), true);
  assert.equal(isSnapshotCorrupted({}), true);
  assert.equal(repairCorruptedSnapshot(null), null);
  assert.equal(repairCorruptedSnapshot({}), null); // No URL

  // Partially corrupted record that has a valid URL and partial state
  const partiallyCorrupted = {
    id: "corrupted_123",
    url: "https://recoverable.org/article",
    title: "Article Title",
    tabId: "not-a-number", // invalid type
    timestamp: -50,         // invalid negative timestamp
    scroll: null            // missing scroll object
  };

  assert.equal(isSnapshotCorrupted(partiallyCorrupted), true);

  const repaired = repairCorruptedSnapshot(partiallyCorrupted, 999);
  assert.ok(repaired !== null);
  assert.equal(repaired.id, "corrupted_123");
  assert.equal(repaired.url, "https://recoverable.org/article");
  assert.equal(repaired.title, "Article Title");
  assert.equal(repaired.tabId, 999); // recovered from fallbackTabId
  assert.ok(repaired.timestamp > 0);
  assert.deepEqual(repaired.scroll, { x: 0, y: 0, percentX: 0, percentY: 0 });
  assert.equal(repaired.reason, "corrupted_recovery");
  assert.equal(repaired.wasRepaired, true);

  // Repaired record strictly satisfies the schema
  const check = validateSnapshotSchema(repaired);
  assert.equal(check.valid, true);
});

test("SnapshotStore repairOrPruneCorruptedSnapshots automatically fixes recoverable and purges hopeless records", async () => {
  const backend = new MemorySnapshotBackend();
  const store = new SnapshotStore({ backend });
  await store.open();

  // Good snapshot
  const goodSnap = createTabSnapshot({ id: 1001, url: "https://good.com" });
  await backend.put(goodSnap);

  // Recoverable corrupted snapshot (has URL, but corrupt metadata)
  const recoverable = {
    id: "rec_1002",
    tabId: 1002,
    url: "https://recoverable.com",
    timestamp: 0,
    scroll: "bad_scroll"
  };
  await backend.put(recoverable);

  // Hopeless corrupted snapshot (no URL, complete garbage)
  const hopeless = {
    id: "hopeless_1003",
    data: "broken"
  };
  await backend.put(hopeless);

  assert.equal(await store.count(), 3);

  // Run repairOrPrune in repair mode
  const res = await store.repairOrPruneCorruptedSnapshots("repair");
  assert.equal(res.inspectedCount, 3);
  assert.equal(res.repairedCount, 1);
  assert.equal(res.prunedCount, 1);

  // Count is now 2 (good + repaired; hopeless was deleted)
  assert.equal(await store.count(), 2);

  // Good snapshot intact
  const fetchedGood = await store.getSnapshot(goodSnap.id);
  assert.equal(fetchedGood.url, "https://good.com");

  // Recoverable was repaired and is retrievable
  const fetchedRepaired = await store.getSnapshot("rec_1002");
  assert.equal(fetchedRepaired.url, "https://recoverable.com");
  assert.equal(fetchedRepaired.wasRepaired, true);

  // Hopeless was pruned
  assert.equal(await store.getSnapshot("hopeless_1003"), null);
});

test("serializeSnapshotsExport and parseAndValidateSnapshotsImport format and validate backup payloads", () => {
  const snap1 = createTabSnapshot({ id: 101, url: "https://site-a.com", title: "Site A" });
  const snap2 = createTabSnapshot(
    { id: 102, url: "https://site-b.com", title: "Site B" },
    { screenshot: "data:image/jpeg;base64,1234567890abcdef" }
  );

  // Object serialization
  const objExport = serializeSnapshotsExport([snap1, snap2]);
  assert.equal(objExport.app, "TabVault");
  assert.equal(objExport.version, SNAPSHOT_EXPORT_VERSION);
  assert.equal(objExport.count, 2);
  assert.equal(objExport.snapshots.length, 2);
  assert.ok(typeof objExport.exportedAt === "number");
  assert.ok(typeof objExport.exportedAtIso === "string");

  // String serialization with stripped screenshots
  const jsonStr = serializeSnapshotsExport([snap1, snap2], { stripScreenshots: true, asJsonString: true });
  assert.ok(typeof jsonStr === "string");
  const parsedFromStr = JSON.parse(jsonStr);
  assert.equal(parsedFromStr.snapshots[1].screenshot.isFallback, true);

  // Parsing validations
  const emptyRes = parseAndValidateSnapshotsImport("");
  assert.equal(emptyRes.valid, false);

  const badJson = parseAndValidateSnapshotsImport("{ bad json }");
  assert.equal(badJson.valid, false);

  const missingSnapshots = parseAndValidateSnapshotsImport({ someKey: 123 });
  assert.equal(missingSnapshots.valid, false);

  // Array parsing
  const arrayRes = parseAndValidateSnapshotsImport([snap1]);
  assert.equal(arrayRes.valid, true);
  assert.equal(arrayRes.snapshots.length, 1);

  // Structured payload parsing
  const payloadRes = parseAndValidateSnapshotsImport(objExport);
  assert.equal(payloadRes.valid, true);
  assert.equal(payloadRes.snapshots.length, 2);
  assert.equal(payloadRes.metadata.app, "TabVault");
});

test("SnapshotStore exportSnapshots and importSnapshots handle backups and conflict strategies", async () => {
  const backendSource = new MemorySnapshotBackend();
  const sourceStore = new SnapshotStore({ backend: backendSource });
  await sourceStore.open();

  const snap1 = createTabSnapshot({ id: 10, url: "https://domain-1.com", title: "Tab 10" }, { timestamp: 1000 });
  const snap2 = createTabSnapshot({ id: 10, url: "https://domain-1.com/page2", title: "Tab 10 Page 2" }, { timestamp: 2000 });
  const snap3 = createTabSnapshot({ id: 20, url: "https://domain-2.com", title: "Tab 20" }, { timestamp: 3000 });

  await sourceStore.saveSnapshot(snap1);
  await sourceStore.saveSnapshot(snap2);
  await sourceStore.saveSnapshot(snap3);

  // Filtered export (tabId = 10)
  const filteredExport = await sourceStore.exportSnapshots({ tabId: 10 });
  assert.equal(filteredExport.count, 2);
  assert.equal(filteredExport.snapshots[0].tabId, 10);
  assert.equal(filteredExport.snapshots[1].tabId, 10);

  // Full export as JSON string
  const fullJson = await sourceStore.exportSnapshots({ asJsonString: true });
  assert.ok(typeof fullJson === "string");

  // Import into a target store
  const backendTarget = new MemorySnapshotBackend();
  const targetStore = new SnapshotStore({ backend: backendTarget });
  await targetStore.open();

  // Fresh import
  const importRes = await targetStore.importSnapshots(fullJson);
  assert.equal(importRes.success, true);
  assert.equal(importRes.totalProcessed, 3);
  assert.equal(importRes.importedCount, 3);
  assert.equal(importRes.skippedCount, 0);
  assert.equal(importRes.errorCount, 0);
  assert.equal(await targetStore.count(), 3);

  // Test "skip" conflict strategy with existing IDs
  const skipRes = await targetStore.importSnapshots(fullJson, { conflictStrategy: "skip" });
  assert.equal(skipRes.importedCount, 0);
  assert.equal(skipRes.skippedCount, 3);
  assert.equal(await targetStore.count(), 3);

  // Test "generateNewId" conflict strategy
  const genIdRes = await targetStore.importSnapshots(fullJson, { conflictStrategy: "generateNewId" });
  assert.equal(genIdRes.importedCount, 3);
  assert.equal(await targetStore.count(), 6); // 3 original + 3 duplicates with new IDs

  // Test auto-repair on corrupted record import
  const corruptedList = [
    {
      id: "recoverable_import",
      tabId: 99,
      url: "https://salvaged.org",
      scroll: null // broken
    },
    {
      id: "hopeless_import",
      no_url: true // hopeless
    }
  ];

  const repairImportRes = await targetStore.importSnapshots(corruptedList, { autoRepair: true });
  assert.equal(repairImportRes.totalProcessed, 2);
  assert.equal(repairImportRes.importedCount, 1);
  assert.equal(repairImportRes.errorCount, 1);
  assert.equal(repairImportRes.errors[0].id, "hopeless_import");

  const salvaged = await targetStore.getSnapshot("recoverable_import");
  assert.ok(salvaged);
  assert.equal(salvaged.url, "https://salvaged.org");
  assert.equal(salvaged.wasRepaired, true);
});
