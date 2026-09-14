import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACTIVE_SESSION_SCHEMA_VERSION,
  STORAGE_KEY_ACTIVE_SESSION,
  extractOriginalTabUrl,
  isSuspendedUrl,
  serializeActiveTab,
  serializeActiveWindow,
  serializeActiveGroup,
  captureActiveSessionMetadata,
  validateActiveSessionMetadata,
  scoreTabMatch,
  remapSessionMetadataOnStartup,
  SessionPersistenceManager,
  getSessionPersistenceManager,
  resetSessionPersistenceManager,
  createPendingSnapshotRecord,
  detectInterruptedSnapshots,
  recoverInterruptedSnapshots,
  SnapshotOperationTracker,
  getSnapshotOperationTracker,
  resetSnapshotOperationTracker,
  createPendingRestorationRecord,
  detectInterruptedRestorations,
  recoverInterruptedRestorations,
  RestorationOperationTracker,
  getRestorationOperationTracker,
  resetRestorationOperationTracker,
  acquireRecoveryLock,
  releaseRecoveryLock,
  withRecoveryLock,
  STORAGE_KEY_CRASH_RECOVERY_LOCK,
  buildSessionCheckpoint,
  appendSessionCheckpoint,
  getLatestValidSessionCheckpoint,
  clearSessionCheckpoints,
  STORAGE_KEY_SESSION_CHECKPOINTS,
  MAX_SESSION_CHECKPOINTS,
  recordRecoverySummary,
  getRecoverySummary,
  clearRecoverySummary,
  STORAGE_KEY_LAST_RECOVERY_SUMMARY
} from "../lib/crash-recovery.js";

// Mock storage adapter for testing persistence
class MockStorageAdapter {
  constructor(initialData = {}) {
    this.data = { ...initialData };
    this.setCallCount = 0;
    this.getCallCount = 0;
  }

  async get(key) {
    this.getCallCount++;
    return { [key]: this.data[key] };
  }

  async set(items) {
    this.setCallCount++;
    Object.assign(this.data, items);
  }

  async remove(key) {
    delete this.data[key];
  }
}

test("extractOriginalTabUrl extracts original URLs and unwraps suspended placeholders", () => {
  assert.equal(extractOriginalTabUrl(""), "");
  assert.equal(extractOriginalTabUrl(null), "");
  assert.equal(extractOriginalTabUrl("https://github.com/torvalds/linux"), "https://github.com/torvalds/linux");

  // Hash-based suspended URL
  const hashUrl = "chrome-extension://xyz/suspended/suspended.html#u=https%3A%2F%2Fnews.ycombinator.com&t=HN";
  assert.equal(extractOriginalTabUrl(hashUrl), "https://news.ycombinator.com");

  // Query-based suspended URL
  const queryUrl = "chrome-extension://xyz/suspended/suspended.html?url=https%3A%2F%2Freact.dev";
  assert.equal(extractOriginalTabUrl(queryUrl), "https://react.dev");
});

test("isSuspendedUrl identifies extension suspended URLs", () => {
  assert.equal(isSuspendedUrl("https://example.com"), false);
  assert.equal(isSuspendedUrl("chrome-extension://abc/options/options.html"), false);
  assert.equal(isSuspendedUrl("chrome-extension://abc/suspended/suspended.html"), true);
  assert.equal(isSuspendedUrl("chrome-extension://abc/suspended/suspended.html#u=https%3A%2F%2Fvuejs.org"), true);
});

test("serializeActiveTab captures normalized tab metadata with context enrichment", () => {
  const tab = {
    id: 101,
    windowId: 1,
    index: 3,
    active: false,
    pinned: true,
    groupId: 12,
    url: "chrome-extension://xyz/suspended/suspended.html#u=https%3A%2F%2Fdeveloper.mozilla.org",
    title: "MDN Web Docs",
    favIconUrl: "https://developer.mozilla.org/favicon.ico"
  };

  const context = {
    groupTitle: "Docs",
    groupColor: "blue",
    lastActiveAt: 1700000000000,
    suspendedAt: 1700001000000,
    suspensionReason: "idle",
    isProtected: true,
    hasFormInput: false,
    snapshotId: "snap_101_abc"
  };

  const serialized = serializeActiveTab(tab, context);

  assert.equal(serialized.tabId, 101);
  assert.equal(serialized.windowId, 1);
  assert.equal(serialized.index, 3);
  assert.equal(serialized.active, false);
  assert.equal(serialized.pinned, true);
  assert.equal(serialized.groupId, 12);
  assert.equal(serialized.groupTitle, "Docs");
  assert.equal(serialized.groupColor, "blue");
  assert.equal(serialized.url, "https://developer.mozilla.org");
  assert.equal(serialized.isSuspended, true);
  assert.equal(serialized.suspendedAt, 1700001000000);
  assert.equal(serialized.suspensionReason, "idle");
  assert.equal(serialized.isProtected, true);
  assert.equal(serialized.snapshotId, "snap_101_abc");
  assert.equal(serialized.lifecycleState, "DISCARDED");
});

test("serializeActiveWindow and serializeActiveGroup normalize window and group structures", () => {
  const win = {
    id: 42,
    focused: true,
    incognito: false,
    type: "normal",
    state: "maximized",
    left: 0,
    top: 0,
    width: 1920,
    height: 1080,
    tabs: [{}, {}]
  };

  const serWin = serializeActiveWindow(win);
  assert.equal(serWin.id, 42);
  assert.equal(serWin.focused, true);
  assert.equal(serWin.incognito, false);
  assert.equal(serWin.state, "maximized");
  assert.equal(serWin.bounds.width, 1920);
  assert.equal(serWin.tabCount, 2);

  const group = {
    id: 7,
    windowId: 42,
    title: "Project Alpha",
    color: "red",
    collapsed: false
  };

  const serGroup = serializeActiveGroup(group);
  assert.equal(serGroup.id, 7);
  assert.equal(serGroup.windowId, 42);
  assert.equal(serGroup.title, "Project Alpha");
  assert.equal(serGroup.color, "red");
  assert.equal(serGroup.collapsed, false);
});

test("captureActiveSessionMetadata creates comprehensive structured session payload", () => {
  const windows = [
    {
      id: 1,
      focused: true,
      tabs: [
        {
          id: 10,
          windowId: 1,
          index: 0,
          active: true,
          pinned: false,
          groupId: -1,
          url: "https://wikipedia.org",
          title: "Wikipedia"
        },
        {
          id: 20,
          windowId: 1,
          index: 1,
          active: false,
          pinned: false,
          groupId: 5,
          url: "chrome-extension://xyz/suspended/suspended.html#u=https%3A%2F%2Fgithub.com",
          title: "GitHub"
        }
      ]
    }
  ];

  const groups = [
    { id: 5, windowId: 1, title: "Dev", color: "green", collapsed: false }
  ];

  const tabState = new Map([
    [10, { lastActiveAt: Date.now(), hasFormInput: true }],
    [20, { lastActiveAt: Date.now() - 600000, hasFormInput: false }]
  ]);

  const manuallyProtectedTabs = new Set([10]);

  const payload = captureActiveSessionMetadata({
    windows,
    groups,
    tabState,
    manuallyProtectedTabs
  });

  assert.equal(payload.schemaVersion, ACTIVE_SESSION_SCHEMA_VERSION);
  assert.ok(payload.sessionId.startsWith("session_"));
  assert.equal(payload.windowCount, 1);
  assert.equal(payload.tabCount, 2);
  assert.equal(payload.activeTabCount, 1);
  assert.equal(payload.suspendedTabCount, 1);
  assert.equal(payload.groups.length, 1);
  assert.equal(payload.groups[0].title, "Dev");

  // Tab 10
  const tab1 = payload.tabs.find(t => t.tabId === 10);
  assert.ok(tab1);
  assert.equal(tab1.url, "https://wikipedia.org");
  assert.equal(tab1.isSuspended, false);
  assert.equal(tab1.hasFormInput, true);
  assert.equal(tab1.isProtected, true);

  // Tab 20
  const tab2 = payload.tabs.find(t => t.tabId === 20);
  assert.ok(tab2);
  assert.equal(tab2.url, "https://github.com");
  assert.equal(tab2.isSuspended, true);
  assert.equal(tab2.groupTitle, "Dev");
  assert.equal(tab2.groupColor, "green");
});

test("validateActiveSessionMetadata validates schema and rejects malformed payloads", () => {
  assert.equal(validateActiveSessionMetadata(null).ok, false);
  assert.equal(validateActiveSessionMetadata("string").ok, false);
  assert.equal(validateActiveSessionMetadata({ schemaVersion: 99 }).ok, false);
  assert.equal(validateActiveSessionMetadata({ schemaVersion: 1, windows: [] }).ok, false);

  const validPayload = {
    schemaVersion: 1,
    sessionId: "sess_1",
    savedAt: Date.now(),
    windows: [{ id: 1 }],
    tabs: [
      { tabId: 1, url: "https://example.com", isSuspended: false },
      { tabId: 2, url: "https://foo.com", isSuspended: true }
    ]
  };

  const validation = validateActiveSessionMetadata(validPayload);
  assert.equal(validation.ok, true);
  assert.equal(validation.session.tabCount, 2);
  assert.equal(validation.session.activeTabCount, 1);
  assert.equal(validation.session.suspendedTabCount, 1);
});

test("SessionPersistenceManager persists, loads, and clears active session correctly", async () => {
  const adapter = new MockStorageAdapter();
  const manager = new SessionPersistenceManager({ storageAdapter: adapter });

  // Initially empty
  const emptyLoad = await manager.load();
  assert.equal(emptyLoad.ok, false);

  // Persist session
  const payload = captureActiveSessionMetadata({
    tabs: [
      { id: 1, windowId: 1, url: "https://site1.com", active: true },
      { id: 2, windowId: 1, url: "https://site2.com", active: false }
    ]
  });

  const persistResult = await manager.persist(payload);
  assert.equal(persistResult.ok, true);
  assert.equal(persistResult.tabCount, 2);
  // 2 storage writes: the primary active session record plus its rotating checkpoint.
  assert.equal(adapter.setCallCount, 2);

  // Load persisted session
  const loaded = await manager.load();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.session.tabCount, 2);
  assert.equal(loaded.session.tabs[0].url, "https://site1.com");
  assert.equal(loaded.session.tabs[1].url, "https://site2.com");

  // Clear session
  const clearResult = await manager.clear();
  assert.equal(clearResult.ok, true);

  const postClear = await manager.load();
  assert.equal(postClear.ok, false);
});

test("SessionPersistenceManager debounces scheduling and flushes properly", async () => {
  const adapter = new MockStorageAdapter();
  const manager = new SessionPersistenceManager({
    storageAdapter: adapter,
    debounceMs: 50 // short for test
  });

  let counter = 0;
  const captureFn = () => {
    counter++;
    return {
      tabs: [{ id: counter, windowId: 1, url: `https://site${counter}.com` }]
    };
  };

  // Schedule multiple rapid calls
  manager.schedulePersist(captureFn);
  manager.schedulePersist(captureFn);
  manager.schedulePersist(captureFn);

  // Flush immediately
  await manager.flushPersist();

  // Exactly 1 persist should have occurred (2 storage writes: the primary active
  // session record plus its rotating checkpoint).
  assert.equal(adapter.setCallCount, 2);
  assert.equal(counter, 1);

  const loaded = await manager.load();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.session.tabCount, 1);
});

test("SessionPersistenceManager singleton accessor and reset", () => {
  resetSessionPersistenceManager();
  const mgr1 = getSessionPersistenceManager();
  const mgr2 = getSessionPersistenceManager();
  assert.equal(mgr1, mgr2);

  resetSessionPersistenceManager();
  const mgr3 = getSessionPersistenceManager();
  assert.notEqual(mgr1, mgr3);
});

test("scoreTabMatch evaluates correlation between live and persisted tabs accurately", () => {
  const liveTab = {
    id: 99,
    index: 2,
    windowId: 1,
    title: "TypeScript Documentation",
    pinned: true,
    groupId: 5,
    url: "https://www.typescriptlang.org/docs/"
  };

  // Exact URL match + matching attributes
  const candidateExact = {
    tabId: 50,
    index: 2,
    windowId: 1,
    title: "TypeScript Documentation",
    pinned: true,
    groupId: 5,
    url: "https://www.typescriptlang.org/docs/",
    isSuspended: false
  };
  const scoreExact = scoreTabMatch(liveTab, "https://www.typescriptlang.org/docs/", candidateExact);
  assert.ok(scoreExact >= 20, `Expected score >= 20, got ${scoreExact}`);

  // Same hostname but different path
  const candidateHost = {
    tabId: 51,
    url: "https://www.typescriptlang.org/play",
    title: "Playground"
  };
  const scoreHost = scoreTabMatch(liveTab, "https://www.typescriptlang.org/docs/", candidateHost);
  assert.ok(scoreHost >= 3 && scoreHost < scoreExact);

  // Totally unrelated URL
  const candidateUnrelated = {
    tabId: 52,
    url: "https://reddit.com"
  };
  assert.equal(scoreTabMatch(liveTab, "https://www.typescriptlang.org/docs/", candidateUnrelated), 0);
});

test("remapSessionMetadataOnStartup correlates live tabs with persisted metadata and updates ledgers", () => {
  // Stored state before restart (had old tab IDs 101, 102, 103)
  const persistedSession = {
    schemaVersion: 1,
    sessionId: "sess_pre_restart",
    savedAt: 1700000000000,
    windows: [{ id: 10 }],
    tabs: [
      {
        tabId: 101,
        url: "https://news.ycombinator.com",
        title: "Hacker News",
        index: 0,
        windowId: 10,
        isSuspended: false,
        isProtected: true,
        hasFormInput: true,
        lastActiveAt: 1700000500000
      },
      {
        tabId: 102,
        url: "https://github.com",
        title: "GitHub",
        index: 1,
        windowId: 10,
        isSuspended: true,
        suspendedAt: 1700000200000,
        suspensionReason: "idle",
        isProtected: false
      },
      {
        tabId: 103,
        url: "https://cnn.com", // tab that user closed before restart
        title: "CNN",
        index: 2
      }
    ]
  };

  // Live tabs after restart (Chrome assigned new IDs 201, 202, and user opened a new tab 203)
  const liveTabs = [
    {
      id: 201,
      windowId: 1,
      index: 0,
      url: "https://news.ycombinator.com",
      title: "Hacker News",
      active: true
    },
    {
      id: 202,
      windowId: 1,
      index: 1,
      url: "chrome-extension://xyz/suspended/suspended.html#u=https%3A%2F%2Fgithub.com",
      title: "GitHub",
      active: false
    },
    {
      id: 203,
      windowId: 1,
      index: 2,
      url: "https://wikipedia.org", // new tab
      title: "Wikipedia",
      active: false
    }
  ];

  const tabState = new Map();
  const manuallyProtectedTabs = new Set();
  const mockMetadataStore = {
    records: new Map(),
    set(id, data) { this.records.set(id, data); },
    remove(id) { this.records.delete(id); }
  };

  const result = remapSessionMetadataOnStartup({
    liveTabs,
    persistedSession,
    metadataStore: mockMetadataStore,
    tabState,
    manuallyProtectedTabs,
    options: { purgeOrphaned: true }
  });

  assert.equal(result.ok, true);
  assert.equal(result.totalLiveTabs, 3);
  assert.equal(result.remappedCount, 2);
  assert.equal(result.orphanCount, 1);
  assert.equal(result.orphans[0].tabId, 103); // CNN was not reopened
  assert.equal(result.unmappedLiveTabs.length, 1);
  assert.equal(result.unmappedLiveTabs[0].tabId, 203); // Wikipedia is new

  // Check tab 201 (re-mapped from 101)
  const state201 = tabState.get(201);
  assert.ok(state201);
  assert.equal(state201.hasFormInput, true);
  assert.equal(state201.isManuallyProtected, true);
  assert.equal(manuallyProtectedTabs.has(201), true);

  // Check tab 202 (re-mapped from 102, was suspended)
  const state202 = tabState.get(202);
  assert.ok(state202);
  assert.equal(state202.lifecycleState, "DISCARDED");
  assert.equal(state202.suspensionReason, "idle");
  assert.equal(state202.suspendedAt, 1700000200000);

  // Check metadataStore
  assert.ok(mockMetadataStore.records.has(201));
  assert.ok(mockMetadataStore.records.has(202));
  assert.ok(mockMetadataStore.records.has(203)); // initialized
  assert.equal(mockMetadataStore.records.has(101), false); // old ID removed
});

test("SessionPersistenceManager restoreSessionOnStartup end-to-end integration", async () => {
  const adapter = new MockStorageAdapter();
  const manager = new SessionPersistenceManager({ storageAdapter: adapter });

  // 1. Without persisted session
  const resEmpty = await manager.restoreSessionOnStartup({ liveTabs: [{ id: 1, url: "https://a.com" }] });
  assert.equal(resEmpty.ok, true);
  assert.equal(resEmpty.restored, false);

  // 2. Persist an active session
  await manager.persist({
    schemaVersion: 1,
    sessionId: "sess_test",
    windows: [{ id: 1 }],
    tabs: [
      {
        tabId: 10,
        url: "https://golang.org",
        title: "Go",
        isSuspended: false,
        lastActiveAt: 1699999000000,
        isProtected: true
      }
    ]
  });

  // 3. Simulate browser restart with new tab ID 88 for golang.org
  const liveTabs = [
    { id: 88, windowId: 1, index: 0, url: "https://golang.org", title: "Go" }
  ];
  const tabState = new Map();
  const manuallyProtectedTabs = new Set();

  const res = await manager.restoreSessionOnStartup({
    liveTabs,
    tabState,
    manuallyProtectedTabs
  });

  assert.equal(res.ok, true);
  assert.equal(res.restored, true);
  assert.equal(res.remappedCount, 1);
  assert.equal(manuallyProtectedTabs.has(88), true);
  assert.equal(tabState.get(88).isManuallyProtected, true);

  // Confirms state was immediately re-persisted with live ID 88
  const reloaded = await manager.load();
  assert.equal(reloaded.ok, true);
  assert.equal(reloaded.session.tabs[0].tabId, 88);
});

test("createPendingSnapshotRecord and detectInterruptedSnapshots identify timed-out snapshot operations", () => {
  const now = 1700000100000;

  // Active snapshot started 2 seconds ago (timeout 10s) -> Not interrupted
  const activeSnap = createPendingSnapshotRecord(10, {
    url: "https://site1.com",
    stage: "dom_capture",
    now: now - 2000,
    timeoutMs: 10000
  });

  // Stalled snapshot started 15 seconds ago (timeout 10s) -> Interrupted
  const stalledSnap = createPendingSnapshotRecord(20, {
    url: "https://site2.com",
    stage: "screenshot",
    now: now - 15000,
    timeoutMs: 10000
  });

  const pending = [activeSnap, stalledSnap];
  const detected = detectInterruptedSnapshots(pending, { now, timeoutMs: 10000 });

  assert.equal(detected.length, 1);
  assert.equal(detected[0].tabId, 20);
  assert.equal(detected[0].isInterrupted, true);
  assert.equal(detected[0].elapsedMs, 15000);
});

test("recoverInterruptedSnapshots reverts transient lifecycle states and clears pending locks", () => {
  const pendingMap = new Map([
    [20, { tabId: 20, url: "https://site2.com", stage: "screenshot", elapsedMs: 15000 }]
  ]);

  const tabState = new Map([
    [20, { lastActiveAt: 1700000000000, lifecycleState: "SNAPSHOTTING" }]
  ]);

  const mockMetaStore = {
    records: new Map([
      [20, { tabId: 20, lifecycleState: "SNAPSHOTTING" }]
    ]),
    get(id) { return this.records.get(id); },
    set(id, patch) { this.records.set(id, { ...this.records.get(id), ...patch }); }
  };

  const recovery = recoverInterruptedSnapshots({
    interruptedRecords: Array.from(pendingMap.values()),
    pendingSnapshotsMap: pendingMap,
    tabState,
    metadataStore: mockMetaStore,
    options: { fallbackState: "ACTIVE" }
  });

  assert.equal(recovery.recoveredCount, 1);
  assert.equal(recovery.recoveredRecords[0].tabId, 20);
  assert.equal(recovery.recoveredRecords[0].recoveredToState, "ACTIVE");

  // Lock cleared
  assert.equal(pendingMap.has(20), false);

  // TabState reverted
  assert.equal(tabState.get(20).lifecycleState, "ACTIVE");

  // MetadataStore reverted
  assert.equal(mockMetaStore.records.get(20).lifecycleState, "ACTIVE");
});

test("SnapshotOperationTracker tracks lifecycle, persists to storage, and detects interruptions", async () => {
  const adapter = new MockStorageAdapter();
  const tracker = new SnapshotOperationTracker({ storageAdapter: adapter, timeoutMs: 5000 });

  const now = 1700000000000;

  // 1. Start snapshot for tab 1
  await tracker.startSnapshot(1, { url: "https://alpha.com", stage: "init", now });
  assert.equal(tracker.getPendingSnapshots().length, 1);
  assert.equal(adapter.setCallCount, 1);

  // 2. Finish snapshot for tab 1
  await tracker.finishSnapshot(1);
  assert.equal(tracker.getPendingSnapshots().length, 0);

  // 3. Start snapshot for tab 2 (simulating an interruption where finishSnapshot is never called)
  await tracker.startSnapshot(2, { url: "https://beta.com", stage: "screenshot", now });

  // 4. Advance time by 8 seconds (> 5s timeout) and run recovery
  const tabState = new Map([
    [2, { lifecycleState: "SNAPSHOTTING" }]
  ]);

  const result = await tracker.checkAndRecoverInterrupted({
    now: now + 8000,
    tabState
  });

  assert.equal(result.detectedCount, 1);
  assert.equal(result.recoveredCount, 1);
  assert.equal(result.records[0].tabId, 2);
  assert.equal(tabState.get(2).lifecycleState, "ACTIVE");
  assert.equal(tracker.getPendingSnapshots().length, 0);
});

test("SnapshotOperationTracker singleton accessor and reset", () => {
  resetSnapshotOperationTracker();
  const t1 = getSnapshotOperationTracker();
  const t2 = getSnapshotOperationTracker();
  assert.equal(t1, t2);

  resetSnapshotOperationTracker();
  const t3 = getSnapshotOperationTracker();
  assert.notEqual(t1, t3);
});

test("createPendingRestorationRecord initializes structured restoration record", () => {
  const now = 1700000000000;
  const rec = createPendingRestorationRecord(42, {
    url: "https://example.com/dashboard",
    stage: "WAIT_READINESS",
    priority: "HIGH",
    now,
    timeoutMs: 15000,
    retryCount: 1,
    source: "alarm"
  });

  assert.equal(rec.tabId, 42);
  assert.equal(rec.url, "https://example.com/dashboard");
  assert.equal(rec.stage, "WAIT_READINESS");
  assert.equal(rec.priority, "HIGH");
  assert.equal(rec.startedAt, now);
  assert.equal(rec.timeoutMs, 15000);
  assert.equal(rec.retryCount, 1);
  assert.equal(rec.source, "alarm");
});

test("detectInterruptedRestorations identifies timed-out restorations", () => {
  const now = 1700000025000; // 25s later
  const records = [
    { tabId: 1, startedAt: now - 5000, timeoutMs: 20000 }, // active (5s < 20s)
    { tabId: 2, startedAt: now - 22000, timeoutMs: 20000 }, // timed out (22s >= 20s)
    { tabId: 3, startedAt: now - 35000, timeoutMs: 30000 } // timed out (35s >= 30s)
  ];

  const interrupted = detectInterruptedRestorations(records, { now });
  assert.equal(interrupted.length, 2);
  assert.equal(interrupted[0].tabId, 2);
  assert.equal(interrupted[0].isInterrupted, true);
  assert.equal(interrupted[0].elapsedMs, 22000);
  assert.equal(interrupted[1].tabId, 3);
  assert.equal(interrupted[1].elapsedMs, 35000);
});

test("recoverInterruptedRestorations resets interrupted restorations back to DISCARDED", async () => {
  const pendingMap = new Map([
    [5, { tabId: 5, startedAt: 1000, timeoutMs: 5000, url: "https://app.example.com" }]
  ]);

  const tabState = new Map([
    [5, { lifecycleState: "RESTORING" }]
  ]);

  const mockMetadataStore = {
    records: new Map([[5, { tabId: 5, lifecycleState: "RESTORING" }]]),
    get(id) { return this.records.get(id); },
    set(id, patch) { this.records.set(id, { ...this.records.get(id), ...patch }); }
  };

  const recovery = await recoverInterruptedRestorations({
    interruptedRecords: Array.from(pendingMap.values()),
    pendingRestorationsMap: pendingMap,
    tabState,
    metadataStore: mockMetadataStore,
    options: { action: "reset" }
  });

  assert.equal(recovery.recoveredCount, 1);
  assert.equal(recovery.recoveredRecords[0].tabId, 5);
  assert.equal(recovery.recoveredRecords[0].targetState, "DISCARDED");
  assert.equal(pendingMap.has(5), false);
  assert.equal(tabState.get(5).lifecycleState, "DISCARDED");
  assert.equal(mockMetadataStore.records.get(5).lifecycleState, "DISCARDED");
});

test("recoverInterruptedRestorations supports mark_failed and retry actions", async () => {
  // 1. mark_failed action
  const tabState1 = new Map([[10, { lifecycleState: "RESTORING" }]]);
  const metaStore1 = {
    records: new Map([[10, { tabId: 10, lifecycleState: "RESTORING" }]]),
    get(id) { return this.records.get(id); },
    set(id, patch) { this.records.set(id, { ...this.records.get(id), ...patch }); }
  };

  await recoverInterruptedRestorations({
    interruptedRecords: [{ tabId: 10, url: "https://test.com" }],
    tabState: tabState1,
    metadataStore: metaStore1,
    options: { action: "mark_failed" }
  });

  assert.equal(tabState1.get(10).lifecycleState, "RESTORE_FAILED");
  assert.equal(metaStore1.records.get(10).lifecycleState, "RESTORE_FAILED");
  assert.equal(metaStore1.records.get(10).restorationStatus, "failed");

  // 2. retry action
  const tabState2 = new Map([[11, { lifecycleState: "RESTORING" }]]);
  const retriedTabs = [];
  const mockRestoreEngine = {
    async restoreTab(id, opts) {
      retriedTabs.push({ id, opts });
      return { success: true };
    }
  };

  const retryRes = await recoverInterruptedRestorations({
    interruptedRecords: [{ tabId: 11, url: "https://retry.com", priority: "HIGH" }],
    tabState: tabState2,
    restoreEngine: mockRestoreEngine,
    options: { action: "retry" }
  });

  assert.equal(retryRes.recoveredCount, 1);
  assert.equal(retriedTabs.length, 1);
  assert.equal(retriedTabs[0].id, 11);
  assert.equal(retriedTabs[0].opts.source, "crash_recovery");
  assert.equal(retriedTabs[0].opts.priority, "HIGH");
  assert.equal(tabState2.get(11).lifecycleState, "RESTORING");
});

test("RestorationOperationTracker manages operation lifecycle and detects interruptions", async () => {
  const adapter = new MockStorageAdapter();
  const tracker = new RestorationOperationTracker({ storageAdapter: adapter, timeoutMs: 10000 });

  const now = 1700000000000;

  // 1. Start restoration for tab 100
  await tracker.startRestoration(100, { url: "https://test.com/1", stage: "INIT", now });
  assert.equal(tracker.getPendingRestorations().length, 1);
  assert.equal(adapter.setCallCount, 1);

  // 2. Update stage
  await tracker.updateStage(100, "WAIT_READINESS");
  assert.equal(tracker.getPendingRestorations()[0].stage, "WAIT_READINESS");

  // 3. Finish restoration for tab 100
  await tracker.finishRestoration(100);
  assert.equal(tracker.getPendingRestorations().length, 0);

  // 4. Start restoration for tab 200 (simulate crash before finishing)
  await tracker.startRestoration(200, { url: "https://test.com/2", stage: "RESTORE_SCROLL", now });

  // 5. Detect and recover after 15s (> 10s timeout)
  const tabState = new Map([[200, { lifecycleState: "RESTORING" }]]);
  const result = await tracker.checkAndRecoverInterrupted({
    now: now + 15000,
    tabState
  });

  assert.equal(result.detectedCount, 1);
  assert.equal(result.recoveredCount, 1);
  assert.equal(result.records[0].tabId, 200);
  assert.equal(tabState.get(200).lifecycleState, "DISCARDED");
  assert.equal(tracker.getPendingRestorations().length, 0);
});

test("RestorationOperationTracker singleton accessor and reset", () => {
  resetRestorationOperationTracker();
  const t1 = getRestorationOperationTracker();
  const t2 = getRestorationOperationTracker();
  assert.equal(t1, t2);

  resetRestorationOperationTracker();
  const t3 = getRestorationOperationTracker();
  assert.notEqual(t1, t3);
});

// ─── Crash recovery lock ─────────────────────────────────────────────────────

test("acquireRecoveryLock grants an uncontended lock and blocks a second concurrent acquire", async () => {
  const adapter = new MockStorageAdapter();

  const first = await acquireRecoveryLock(adapter);
  assert.equal(first.ok, true);
  assert.equal(first.acquired, true);
  assert.ok(first.lockId);

  const second = await acquireRecoveryLock(adapter);
  assert.equal(second.ok, true);
  assert.equal(second.acquired, false);
  assert.equal(second.holder, first.lockId);
});

test("acquireRecoveryLock allows stealing an expired (stale) lock", async () => {
  const adapter = new MockStorageAdapter();
  const staleAt = Date.now() - 100000;
  await adapter.set({ [STORAGE_KEY_CRASH_RECOVERY_LOCK]: { lockId: "stale-holder", acquiredAt: staleAt } });

  const res = await acquireRecoveryLock(adapter, { ttlMs: 30000, now: Date.now() });
  assert.equal(res.acquired, true);
  assert.notEqual(res.lockId, "stale-holder");
});

test("releaseRecoveryLock only clears the lock when the lockId still matches (no stolen-lock clobber)", async () => {
  const adapter = new MockStorageAdapter();
  const acquired = await acquireRecoveryLock(adapter);

  // A different holder's release call should not clear this lock.
  await releaseRecoveryLock(adapter, "someone-elses-lock-id");
  const stillHeld = await acquireRecoveryLock(adapter);
  assert.equal(stillHeld.acquired, false);

  // The actual holder's release clears it.
  await releaseRecoveryLock(adapter, acquired.lockId);
  const freed = await acquireRecoveryLock(adapter);
  assert.equal(freed.acquired, true);
});

test("withRecoveryLock runs fn while holding the lock and skips a concurrent overlapping call", async () => {
  const adapter = new MockStorageAdapter();
  let ran = 0;

  const outerPromise = withRecoveryLock(adapter, async () => {
    ran++;
    // While this "run" is in flight, a second call should see the lock held and skip.
    const overlapping = await withRecoveryLock(adapter, async () => { ran++; });
    assert.equal(overlapping.skipped, true);
    assert.equal(overlapping.reason, "lock_held");
    return "done";
  });

  const outer = await outerPromise;
  assert.equal(outer.skipped, false);
  assert.equal(outer.result, "done");
  assert.equal(ran, 1);

  // Lock is released after the outer run completes, so a later call succeeds.
  const after = await withRecoveryLock(adapter, async () => "again");
  assert.equal(after.skipped, false);
  assert.equal(after.result, "again");
});

// ─── Session checkpoints ─────────────────────────────────────────────────────

test("appendSessionCheckpoint stores rotating checkpoints capped at MAX_SESSION_CHECKPOINTS", async () => {
  const adapter = new MockStorageAdapter();

  for (let i = 0; i < MAX_SESSION_CHECKPOINTS + 3; i++) {
    const payload = captureActiveSessionMetadata({
      tabs: [{ id: i, windowId: 1, url: `https://site${i}.com` }]
    });
    await appendSessionCheckpoint(adapter, payload);
  }

  const raw = await adapter.get(STORAGE_KEY_SESSION_CHECKPOINTS);
  const list = raw[STORAGE_KEY_SESSION_CHECKPOINTS];
  assert.equal(list.length, MAX_SESSION_CHECKPOINTS);
  // Oldest checkpoints were trimmed; the most recent one survives.
  assert.equal(list[list.length - 1].session.tabs[0].url, `https://site${MAX_SESSION_CHECKPOINTS + 2}.com`);
});

test("getLatestValidSessionCheckpoint skips corrupted checkpoints and returns the newest valid one", async () => {
  const adapter = new MockStorageAdapter();
  const validPayload = captureActiveSessionMetadata({
    tabs: [{ id: 1, windowId: 1, url: "https://good.com" }]
  });
  const goodCheckpoint = buildSessionCheckpoint(validPayload);
  const corruptedCheckpoint = { checkpointId: "cp_bad", savedAt: Date.now(), session: { schemaVersion: 999, tabs: [] } };

  await adapter.set({ [STORAGE_KEY_SESSION_CHECKPOINTS]: [goodCheckpoint, corruptedCheckpoint] });

  const result = await getLatestValidSessionCheckpoint(adapter);
  assert.ok(result);
  assert.equal(result.session.tabs[0].url, "https://good.com");
});

test("clearSessionCheckpoints removes all stored checkpoints", async () => {
  const adapter = new MockStorageAdapter();
  const payload = captureActiveSessionMetadata({ tabs: [{ id: 1, windowId: 1, url: "https://a.com" }] });
  await appendSessionCheckpoint(adapter, payload);

  await clearSessionCheckpoints(adapter);
  const raw = await adapter.get(STORAGE_KEY_SESSION_CHECKPOINTS);
  assert.deepEqual(raw[STORAGE_KEY_SESSION_CHECKPOINTS], undefined);
});

test("SessionPersistenceManager.load falls back to the latest valid checkpoint when the primary record is corrupted", async () => {
  const adapter = new MockStorageAdapter();
  const manager = new SessionPersistenceManager({ storageAdapter: adapter });

  const payload = captureActiveSessionMetadata({
    tabs: [{ id: 1, windowId: 1, url: "https://checkpoint-recovered.com" }]
  });
  await manager.persist(payload);

  // Simulate the primary record being corrupted by a crash mid-write, while the
  // checkpoint written alongside it in persist() survives intact.
  await adapter.set({ [STORAGE_KEY_ACTIVE_SESSION]: { schemaVersion: 999, tabs: "not-an-array" } });

  const loaded = await manager.load();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.fromCheckpoint, true);
  assert.equal(loaded.session.tabs[0].url, "https://checkpoint-recovered.com");
});

// ─── Recovery summary ────────────────────────────────────────────────────────

test("recordRecoverySummary and getRecoverySummary round-trip a recovery summary", async () => {
  const adapter = new MockStorageAdapter();
  assert.equal(await getRecoverySummary(adapter), null);

  await recordRecoverySummary(adapter, { recoveredSnapshots: 2, recoveredRestorations: 1, orphanCount: 0 });
  const summary = await getRecoverySummary(adapter);
  assert.equal(summary.recoveredSnapshots, 2);
  assert.equal(summary.recoveredRestorations, 1);
  assert.ok(typeof summary.recordedAt === "number");
});

test("clearRecoverySummary removes the recorded summary", async () => {
  const adapter = new MockStorageAdapter();
  await recordRecoverySummary(adapter, { recoveredSnapshots: 1 });
  await clearRecoverySummary(adapter);
  assert.equal(await getRecoverySummary(adapter), null);
});



