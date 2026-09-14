import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveTabLastActiveAt,
  isTabEligibleForLru,
  LruTracker,
  getLeastRecentlyUsedTabs,
  selectLruSuspensionCandidates,
  DEFAULT_MAX_ACTIVE_TABS,
  getActiveTabThreshold,
  setActiveTabThreshold,
  resetActiveTabThreshold,
  evaluateActiveTabThreshold,
  isTabSuspended,
  DEFAULT_MAX_UNSUSPENDED_TABS,
  getUnsuspendedTabThreshold,
  setUnsuspendedTabThreshold,
  resetUnsuspendedTabThreshold,
  evaluateUnsuspendedTabThreshold,
  UNGROUPED_GROUP_ID,
  getTabGroupStats,
  selectGroupAwareLruCandidates,
  getWindowStats,
  selectWindowAwareLruCandidates,
  LruExclusionManager,
  defaultLruExclusionManager
} from "../lib/lru.js";
import { TabProtectionReason } from "../lib/scoring.js";

test("resolveTabLastActiveAt resolves timestamp with correct precedence", () => {
  // 1. tab.lastActiveAt takes highest precedence
  assert.equal(
    resolveTabLastActiveAt({ lastActiveAt: 5000, lastAccessed: 4000 }, { lastActiveAt: 3000 }),
    5000
  );

  // 2. metadata.lastActiveAt takes next precedence
  assert.equal(
    resolveTabLastActiveAt({ lastAccessed: 4000 }, { lastActiveAt: 3000 }),
    3000
  );

  // 3. tab.lastAccessed takes next precedence
  assert.equal(
    resolveTabLastActiveAt({ lastAccessed: 4000 }, {}),
    4000
  );

  // 4. metadata.createdAt / tab.createdAt fallback
  assert.equal(
    resolveTabLastActiveAt({}, { createdAt: 2000 }),
    2000
  );
  assert.equal(
    resolveTabLastActiveAt({ createdAt: 1500 }, {}),
    1500
  );

  // 5. Default fallback
  assert.equal(resolveTabLastActiveAt({}, {}, 999), 999);
});

test("isTabEligibleForLru correctly evaluates protection, activity, idle threshold, and exclusions", () => {
  const now = 1000000;

  // Active tab is not eligible
  assert.deepEqual(isTabEligibleForLru({ id: 1, url: "https://example.com/active", active: true }, {}), {
    eligible: false,
    reason: TabProtectionReason.ACTIVE
  });

  // Pinned tab is not eligible
  assert.deepEqual(isTabEligibleForLru({ id: 2, url: "https://example.com/pinned", pinned: true }, {}), {
    eligible: false,
    reason: TabProtectionReason.PINNED
  });

  // Audible tab is not eligible
  assert.deepEqual(isTabEligibleForLru({ id: 3, url: "https://example.com/audible", audible: true }, {}), {
    eligible: false,
    reason: TabProtectionReason.AUDIBLE
  });

  // Tab with unsaved forms is not eligible
  assert.deepEqual(isTabEligibleForLru({ id: 4, url: "https://example.com/form", hasFormInput: true }, {}), {
    eligible: false,
    reason: TabProtectionReason.FORM_INPUT
  });

  // Excluded by tab ID
  assert.deepEqual(
    isTabEligibleForLru({ id: 42, url: "https://example.com/item", active: false }, {}, { exclusions: [42] }),
    { eligible: false, reason: "lru_excluded_tab_id" }
  );

  // Excluded by URL substring
  assert.deepEqual(
    isTabEligibleForLru({ id: 50, url: "https://critical-dashboard.com/live" }, {}, { exclusions: ["critical-dashboard"] }),
    { eligible: false, reason: "lru_excluded_url" }
  );

  // Below minIdleMinutes threshold
  assert.deepEqual(
    isTabEligibleForLru(
      { id: 60, url: "https://example.com/recent", lastActiveAt: now - 3 * 60000 },
      {},
      { now, minIdleMinutes: 10 }
    ),
    { eligible: false, reason: "idle_duration_below_threshold" }
  );

  // Eligible tab meeting all criteria
  assert.deepEqual(
    isTabEligibleForLru(
      { id: 70, url: "https://example.com/docs", active: false, pinned: false, lastActiveAt: now - 15 * 60000 },
      {},
      { now, minIdleMinutes: 10 }
    ),
    { eligible: true, reason: null }
  );
});

test("LruTracker records access, maintains recency order, and removes items", () => {
  const tracker = new LruTracker();

  tracker.touch(10, 100);
  tracker.touch(20, 200);
  tracker.touch(30, 150);

  assert.equal(tracker.size, 3);
  assert.equal(tracker.has(20), true);
  assert.equal(tracker.getLastAccess(20), 200);

  // Order should be ascending by timestamp: 10 (100), 30 (150), 20 (200)
  assert.deepEqual(tracker.getAccessOrder(), [10, 30, 20]);

  // Updating tab 10 to newest
  tracker.touch(10, 300);
  assert.deepEqual(tracker.getAccessOrder(), [30, 20, 10]);

  // Remove tab 20
  assert.equal(tracker.remove(20), true);
  assert.equal(tracker.has(20), false);
  assert.deepEqual(tracker.getAccessOrder(), [30, 10]);

  tracker.clear();
  assert.equal(tracker.size, 0);
  assert.deepEqual(tracker.getAccessOrder(), []);
});

test("getLeastRecentlyUsedTabs sorts tabs by least recently used and filters ineligible tabs", () => {
  const now = 5000000;
  const tabs = [
    { id: 1, title: "Tab 1", url: "https://siteA.com", lastActiveAt: now - 10 * 60000, active: false, pinned: false },
    { id: 2, title: "Tab 2", url: "https://siteB.com", lastActiveAt: now - 60 * 60000, active: false, pinned: false },
    { id: 3, title: "Tab 3", url: "https://siteC.com", lastActiveAt: now - 30 * 60000, active: false, pinned: false },
    { id: 4, title: "Active Tab", url: "https://siteD.com", lastActiveAt: now, active: true, pinned: false },
    { id: 5, title: "Pinned Tab", url: "https://siteE.com", lastActiveAt: now - 90 * 60000, active: false, pinned: true }
  ];

  const lruTabs = getLeastRecentlyUsedTabs(tabs, new Map(), { now });

  // Ineligible tabs (4 active, 5 pinned) should be omitted
  assert.equal(lruTabs.length, 3);

  // Least recently used first: Tab 2 (idle 60m), Tab 3 (idle 30m), Tab 1 (idle 10m)
  assert.equal(lruTabs[0].tabId, 2);
  assert.equal(lruTabs[0].idleMinutes, 60);

  assert.equal(lruTabs[1].tabId, 3);
  assert.equal(lruTabs[1].idleMinutes, 30);

  assert.equal(lruTabs[2].tabId, 1);
  assert.equal(lruTabs[2].idleMinutes, 10);
});

test("selectLruSuspensionCandidates returns requested count with full explanations", () => {
  const now = 10000000;
  const tabs = [
    { id: 101, title: "Oldest Tab", url: "https://archive.org", lastActiveAt: now - 120 * 60000, active: false },
    { id: 102, title: "Second Oldest Tab", url: "https://wikipedia.org", lastActiveAt: now - 80 * 60000, active: false },
    { id: 103, title: "Recent Tab", url: "https://github.com", lastActiveAt: now - 5 * 60000, active: false }
  ];

  const candidates = selectLruSuspensionCandidates(tabs, new Map(), { count: 2, now });

  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].tabId, 101);
  assert.equal(candidates[0].idleMinutes, 120);
  assert.ok(candidates[0].explanation);
  assert.equal(candidates[0].explanation.primaryReason, "lru_quota");
  assert.match(candidates[0].explanation.headline, /tab limit policy/);

  assert.equal(candidates[1].tabId, 102);
  assert.equal(candidates[1].idleMinutes, 80);
});

test("active-tab threshold configuration getters, setters, bounds, and reset", async () => {
  await resetActiveTabThreshold(false);
  assert.equal(getActiveTabThreshold(), DEFAULT_MAX_ACTIVE_TABS);

  // Set valid custom threshold
  await setActiveTabThreshold(25, false);
  assert.equal(getActiveTabThreshold(), 25);

  // Clamping lower bound
  await setActiveTabThreshold(0, false);
  assert.equal(getActiveTabThreshold(), Infinity); // 0 disables limit

  await setActiveTabThreshold(-5, false);
  assert.equal(getActiveTabThreshold(), DEFAULT_MAX_ACTIVE_TABS);

  // Clamping upper bound
  await setActiveTabThreshold(9999, false);
  assert.equal(getActiveTabThreshold(), 500);

  // Reset back to default
  await resetActiveTabThreshold(false);
  assert.equal(getActiveTabThreshold(), DEFAULT_MAX_ACTIVE_TABS);
});

test("evaluateActiveTabThreshold identifies excess active tabs and selects LRU candidates for suspension", () => {
  const now = 20000000;
  const tabs = [
    { id: 1, title: "Oldest Active Tab", url: "https://site1.com", lastActiveAt: now - 90 * 60000, active: false, discarded: false },
    { id: 2, title: "Second Oldest Active Tab", url: "https://site2.com", lastActiveAt: now - 60 * 60000, active: false, discarded: false },
    { id: 3, title: "Third Active Tab", url: "https://site3.com", lastActiveAt: now - 30 * 60000, active: false, discarded: false },
    { id: 4, title: "Fourth Active Tab", url: "https://site4.com", lastActiveAt: now - 10 * 60000, active: false, discarded: false },
    { id: 5, title: "Current Active Tab", url: "https://site5.com", lastActiveAt: now, active: true, discarded: false },
    { id: 6, title: "Already Suspended Tab", url: "chrome-extension://xyz/suspended/suspended.html#u=...", discarded: true }
  ];

  // Total active tabs = 5 (tab 6 is suspended)
  // With maxActiveTabs = 3: excess = 2 tabs
  const result = evaluateActiveTabThreshold(tabs, new Map(), {
    maxActiveTabs: 3,
    now
  });

  assert.equal(result.thresholdExceeded, true);
  assert.equal(result.currentActiveCount, 5);
  assert.equal(result.maxActiveTabs, 3);
  assert.equal(result.excessCount, 2);
  assert.equal(result.candidatesToSuspend.length, 2);

  // Oldest tabs selected: Tab 1 (90m idle) and Tab 2 (60m idle)
  assert.equal(result.candidatesToSuspend[0].tabId, 1);
  assert.equal(result.candidatesToSuspend[1].tabId, 2);

  // Retained active tabs: Tab 3, 4, 5
  assert.deepEqual(result.retainedTabs.map(t => t.id), [3, 4, 5]);
  assert.match(result.summary, /Active tab limit exceeded/);

  // Within threshold case
  const withinResult = evaluateActiveTabThreshold(tabs, new Map(), {
    maxActiveTabs: 10,
    now
  });
  assert.equal(withinResult.thresholdExceeded, false);
  assert.equal(withinResult.excessCount, 0);
  assert.equal(withinResult.candidatesToSuspend.length, 0);
  assert.equal(withinResult.retainedTabs.length, 5);
});

test("isTabSuspended correctly identifies suspended tabs across discarded flag, lifecycleState, and URL", () => {
  assert.equal(isTabSuspended({ discarded: true }), true);
  assert.equal(isTabSuspended({}, { lifecycleState: "DISCARDED" }), true);
  assert.equal(isTabSuspended({}, { lifecycleState: "SUSPENDED" }), true);
  assert.equal(isTabSuspended({ url: "chrome-extension://abc/suspended/suspended.html#u=https://example.com" }), true);
  assert.equal(isTabSuspended({ url: "https://example.com/blog", discarded: false }, { lifecycleState: "ACTIVE" }), false);
});

test("unsuspended-tab threshold configuration getters, setters, bounds, and reset", async () => {
  await resetUnsuspendedTabThreshold(false);
  assert.equal(getUnsuspendedTabThreshold(), DEFAULT_MAX_UNSUSPENDED_TABS);

  // Custom valid threshold
  await setUnsuspendedTabThreshold(30, false);
  assert.equal(getUnsuspendedTabThreshold(), 30);

  // Disable threshold
  await setUnsuspendedTabThreshold(0, false);
  assert.equal(getUnsuspendedTabThreshold(), Infinity);

  // Clamping
  await setUnsuspendedTabThreshold(9999, false);
  assert.equal(getUnsuspendedTabThreshold(), 500);

  // Reset
  await resetUnsuspendedTabThreshold(false);
  assert.equal(getUnsuspendedTabThreshold(), DEFAULT_MAX_UNSUSPENDED_TABS);
});

test("evaluateUnsuspendedTabThreshold identifies excess unsuspended tabs and selects LRU candidates", () => {
  const now = 30000000;
  const tabs = [
    { id: 10, title: "Oldest Background Tab", url: "https://siteA.com", lastActiveAt: now - 100 * 60000, discarded: false },
    { id: 20, title: "Second Oldest Background Tab", url: "https://siteB.com", lastActiveAt: now - 80 * 60000, discarded: false },
    { id: 30, title: "Third Background Tab", url: "https://siteC.com", lastActiveAt: now - 40 * 60000, discarded: false },
    { id: 40, title: "Playing Audio Tab", url: "https://siteD.com", lastActiveAt: now - 90 * 60000, audible: true, discarded: false },
    { id: 50, title: "Current Active Tab", url: "https://siteE.com", lastActiveAt: now, active: true, discarded: false },
    { id: 60, title: "Discarded Tab 1", url: "chrome-extension://xyz/suspended/suspended.html", discarded: true },
    { id: 70, title: "Discarded Tab 2", url: "chrome-extension://xyz/suspended/suspended.html", discarded: true }
  ];

  // Total open tabs = 7.
  // Unsuspended tabs = 5 (tabs 10, 20, 30, 40, 50).
  // With maxUnsuspendedTabs = 3: excess = 2 tabs.
  const result = evaluateUnsuspendedTabThreshold(tabs, new Map(), {
    maxUnsuspendedTabs: 3,
    now
  });

  assert.equal(result.thresholdExceeded, true);
  assert.equal(result.currentUnsuspendedCount, 5);
  assert.equal(result.maxUnsuspendedTabs, 3);
  assert.equal(result.excessCount, 2);
  assert.equal(result.candidatesToSuspend.length, 2);

  // Candidates selected by LRU:
  // Tab 40 (audible) and Tab 50 (active) are protected.
  // Oldest eligible are Tab 10 (idle 100m) and Tab 20 (idle 80m).
  assert.equal(result.candidatesToSuspend[0].tabId, 10);
  assert.equal(result.candidatesToSuspend[1].tabId, 20);

  // Retained tabs: 30, 40, 50
  assert.deepEqual(result.retainedTabs.map(t => t.id), [30, 40, 50]);
  assert.match(result.summary, /Unsuspended tab threshold exceeded/);

  // Within threshold case
  const okResult = evaluateUnsuspendedTabThreshold(tabs, new Map(), {
    maxUnsuspendedTabs: 5,
    now
  });
  assert.equal(okResult.thresholdExceeded, false);
  assert.equal(okResult.excessCount, 0);
  assert.equal(okResult.candidatesToSuspend.length, 0);
  assert.equal(okResult.retainedTabs.length, 5);
});

test("getTabGroupStats aggregates counts, active recency, and group protection status", () => {
  const tabs = [
    { id: 1, groupId: 10, url: "https://work1.com", lastActiveAt: 1000 },
    { id: 2, groupId: 10, url: "https://work2.com", lastActiveAt: 3000 },
    { id: 3, groupId: 10, url: "chrome-extension://xyz/suspended/suspended.html", discarded: true },
    { id: 4, groupId: 20, url: "https://research1.com", lastActiveAt: 2000 },
    { id: 5, groupId: -1, url: "https://random.com", lastActiveAt: 1500 }
  ];

  const stats = getTabGroupStats(tabs, new Map(), {
    tabGroupNames: { 10: "Work Group", 20: "Research" },
    protectedGroupNames: ["Work Group"]
  });

  assert.equal(stats.size, 3);

  // Group 10
  const g10 = stats.get(10);
  assert.equal(g10.groupName, "Work Group");
  assert.equal(g10.totalTabs, 3);
  assert.equal(g10.unsuspendedTabs, 2);
  assert.equal(g10.suspendedTabs, 1);
  assert.equal(g10.isProtected, true);
  assert.equal(g10.eligibleTabs, 0); // Protected group has 0 eligible tabs

  // Group 20
  const g20 = stats.get(20);
  assert.equal(g20.groupName, "Research");
  assert.equal(g20.totalTabs, 1);
  assert.equal(g20.isProtected, false);
  assert.equal(g20.eligibleTabs, 1);

  // Ungrouped
  const gUngrouped = stats.get(UNGROUPED_GROUP_ID);
  assert.equal(gUngrouped.groupName, "Ungrouped");
  assert.equal(gUngrouped.totalTabs, 1);
  assert.equal(gUngrouped.isProtected, false);
});

test("selectGroupAwareLruCandidates enforces per_group_limit strategy", () => {
  const now = 1000000;
  const tabs = [
    // Group 1: 3 tabs, limit 1 -> 2 excess
    { id: 11, groupId: 1, url: "https://g1-old.com", lastActiveAt: now - 90 * 60000 },
    { id: 12, groupId: 1, url: "https://g1-mid.com", lastActiveAt: now - 60 * 60000 },
    { id: 13, groupId: 1, url: "https://g1-new.com", lastActiveAt: now - 10 * 60000 },
    // Group 2: 2 tabs, limit 1 -> 1 excess
    { id: 21, groupId: 2, url: "https://g2-old.com", lastActiveAt: now - 80 * 60000 },
    { id: 22, groupId: 2, url: "https://g2-new.com", lastActiveAt: now - 5 * 60000 }
  ];

  const report = selectGroupAwareLruCandidates(tabs, new Map(), {
    count: 3,
    maxTabsPerGroup: 1,
    strategy: "per_group_limit",
    now
  });

  assert.equal(report.totalSelected, 3);
  const selectedIds = report.candidates.map(c => c.tabId);
  // Group 1 oldest: 11, 12. Group 2 oldest: 21
  assert.ok(selectedIds.includes(11));
  assert.ok(selectedIds.includes(12));
  assert.ok(selectedIds.includes(21));

  assert.equal(report.remainingUnsuspendedCount[1], 1);
  assert.equal(report.remainingUnsuspendedCount[2], 1);
});

test("selectGroupAwareLruCandidates balances evictions across groups and respects minRetainedPerGroup", () => {
  const now = 2000000;
  const tabs = [
    // Group A has 4 tabs
    { id: 1, groupId: 100, url: "https://a1.com", lastActiveAt: now - 100 * 60000 },
    { id: 2, groupId: 100, url: "https://a2.com", lastActiveAt: now - 90 * 60000 },
    { id: 3, groupId: 100, url: "https://a3.com", lastActiveAt: now - 80 * 60000 },
    { id: 4, groupId: 100, url: "https://a4.com", lastActiveAt: now - 70 * 60000 },
    // Group B has 2 tabs
    { id: 5, groupId: 200, url: "https://b1.com", lastActiveAt: now - 60 * 60000 },
    { id: 6, groupId: 200, url: "https://b2.com", lastActiveAt: now - 50 * 60000 }
  ];

  // Request 3 evictions with balanced strategy and minRetainedPerGroup = 1
  const report = selectGroupAwareLruCandidates(tabs, new Map(), {
    count: 3,
    strategy: "balanced",
    minRetainedPerGroup: 1,
    now
  });

  assert.equal(report.totalSelected, 3);
  // Group A had 4 tabs; Group B had 2 tabs.
  // Balanced selects from Group A first (now 3), then Group A again (now 2), then from Group A (now 1) or Group B.
  // Group A should have at least 1 remaining, Group B should have at least 1 remaining.
  assert.ok(report.remainingUnsuspendedCount[100] >= 1);
  assert.ok(report.remainingUnsuspendedCount[200] >= 1);
});

test("getWindowStats aggregates counts, current window status, and protection across windows", () => {
  const tabs = [
    { id: 1, windowId: 1, url: "https://win1-a.com", lastActiveAt: 1000 },
    { id: 2, windowId: 1, url: "https://win1-b.com", lastActiveAt: 2000 },
    { id: 3, windowId: 2, url: "https://win2-a.com", lastActiveAt: 3000 },
    { id: 4, windowId: 2, url: "chrome-extension://xyz/suspended/suspended.html", discarded: true }
  ];

  const stats = getWindowStats(tabs, new Map(), {
    currentWindowId: 1,
    protectCurrentWindow: true
  });

  assert.equal(stats.size, 2);

  const w1 = stats.get(1);
  assert.equal(w1.windowId, 1);
  assert.equal(w1.isCurrentWindow, true);
  assert.equal(w1.isProtected, true);
  assert.equal(w1.totalTabs, 2);
  assert.equal(w1.unsuspendedTabs, 2);

  const w2 = stats.get(2);
  assert.equal(w2.windowId, 2);
  assert.equal(w2.isCurrentWindow, false);
  assert.equal(w2.isProtected, false);
  assert.equal(w2.totalTabs, 2);
  assert.equal(w2.unsuspendedTabs, 1);
  assert.equal(w2.suspendedTabs, 1);
});

test("selectWindowAwareLruCandidates prioritizes background windows and respects protectCurrentWindow", () => {
  const now = 3000000;
  const tabs = [
    // Current window 10: 2 tabs
    { id: 101, windowId: 10, url: "https://curr1.com", lastActiveAt: now - 90 * 60000 },
    { id: 102, windowId: 10, url: "https://curr2.com", lastActiveAt: now - 10 * 60000 },
    // Background window 20: 2 tabs
    { id: 201, windowId: 20, url: "https://bg1.com", lastActiveAt: now - 80 * 60000 },
    { id: 202, windowId: 20, url: "https://bg2.com", lastActiveAt: now - 40 * 60000 }
  ];

  // Request 1 eviction with protectCurrentWindow = true
  const protectedReport = selectWindowAwareLruCandidates(tabs, new Map(), {
    count: 1,
    currentWindowId: 10,
    protectCurrentWindow: true,
    now
  });

  assert.equal(protectedReport.totalSelected, 1);
  assert.equal(protectedReport.candidates[0].tabId, 201); // Evicts from background window, not current window

  // Request 2 evictions with background_first strategy without strict protection:
  // Both background tabs should be evicted before touching current window
  const bgReport = selectWindowAwareLruCandidates(tabs, new Map(), {
    count: 2,
    currentWindowId: 10,
    strategy: "background_first",
    minRetainedPerWindow: 0,
    now
  });

  assert.equal(bgReport.totalSelected, 2);
  const bgCandidateIds = bgReport.candidates.map(c => c.tabId);
  assert.ok(bgCandidateIds.includes(201));
  assert.ok(bgCandidateIds.includes(202));
});

test("selectWindowAwareLruCandidates enforces per_window_limit and minRetainedPerWindow", () => {
  const now = 4000000;
  const tabs = [
    // Window 1: 3 tabs, limit 1 -> 2 excess
    { id: 1, windowId: 1, url: "https://w1-1.com", lastActiveAt: now - 90 * 60000 },
    { id: 2, windowId: 1, url: "https://w1-2.com", lastActiveAt: now - 60 * 60000 },
    { id: 3, windowId: 1, url: "https://w1-3.com", lastActiveAt: now - 10 * 60000 },
    // Window 2: 2 tabs, limit 1 -> 1 excess
    { id: 4, windowId: 2, url: "https://w2-1.com", lastActiveAt: now - 80 * 60000 },
    { id: 5, windowId: 2, url: "https://w2-2.com", lastActiveAt: now - 20 * 60000 }
  ];

  const report = selectWindowAwareLruCandidates(tabs, new Map(), {
    count: 3,
    maxTabsPerWindow: 1,
    strategy: "per_window_limit",
    minRetainedPerWindow: 1,
    now
  });

  assert.equal(report.totalSelected, 3);
  assert.equal(report.remainingUnsuspendedCount[1], 1);
  assert.equal(report.remainingUnsuspendedCount[2], 1);
});

test("LruExclusionManager manages rules across domain, url, title, tabId, and custom predicates", () => {
  const manager = new LruExclusionManager();

  manager.addRule({
    id: "domain-slack",
    domain: "*.slack.com",
    reason: "Slack Workspace"
  });

  manager.addRule({
    id: "url-pattern-meet",
    urlPattern: "https://meet.google.com/*",
    reason: "Google Meet Call"
  });

  manager.addRule({
    id: "tab-id-fixed",
    tabId: 999,
    reason: "Pinned monitoring tab ID"
  });

  manager.addRule({
    id: "title-pattern-dashboard",
    titlePattern: "*Live Dashboard*",
    reason: "Live Monitoring Dashboard"
  });

  manager.addRule({
    id: "custom-predicate",
    predicate: (tab) => tab.url && tab.url.includes("keep-alive=true"),
    reason: "Keep Alive URL Param"
  });

  // 1. Domain match
  const slackEval = manager.evaluate({ url: "https://company.slack.com/messages/general" });
  assert.equal(slackEval.isExcluded, true);
  assert.equal(slackEval.reason, "Slack Workspace");

  // 2. URL pattern match
  const meetEval = manager.evaluate({ url: "https://meet.google.com/abc-defg-hij" });
  assert.equal(meetEval.isExcluded, true);
  assert.equal(meetEval.reason, "Google Meet Call");

  // 3. Tab ID match
  const tabIdEval = manager.evaluate({ id: 999, url: "https://example.com" });
  assert.equal(tabIdEval.isExcluded, true);
  assert.equal(tabIdEval.reason, "Pinned monitoring tab ID");

  // 4. Title pattern match
  const titleEval = manager.evaluate({ url: "https://metrics.internal", title: "Global Live Dashboard V2" });
  assert.equal(titleEval.isExcluded, true);
  assert.equal(titleEval.reason, "Live Monitoring Dashboard");

  // 5. Custom predicate match
  const predEval = manager.evaluate({ url: "https://service.com/api?keep-alive=true" });
  assert.equal(predEval.isExcluded, true);
  assert.equal(predEval.reason, "Keep Alive URL Param");

  // 6. Unmatched tab
  const noMatch = manager.evaluate({ url: "https://news.ycombinator.com", title: "Hacker News" });
  assert.equal(noMatch.isExcluded, false);

  // 7. Disable rule
  manager.setRuleEnabled("domain-slack", false);
  const disabledEval = manager.evaluate({ url: "https://company.slack.com/messages/general" });
  assert.equal(disabledEval.isExcluded, false);

  // 8. Remove rule
  assert.equal(manager.removeRule("url-pattern-meet"), true);
  assert.equal(manager.getRule("url-pattern-meet"), null);
});

test("isTabEligibleForLru integrates cleanly with LruExclusionManager and exclusion options", () => {
  const manager = new LruExclusionManager([
    {
      id: "protect-dev-server",
      domain: "localhost",
      reason: "Localhost Dev Server"
    }
  ]);

  const tab1 = { id: 1, url: "http://localhost:3000/app", active: false };
  const eligible1 = isTabEligibleForLru(tab1, {}, { exclusionManager: manager });
  assert.equal(eligible1.eligible, false);
  assert.equal(eligible1.reason, "Localhost Dev Server");

  // Object rule in options.exclusions array
  const tab2 = { id: 2, url: "https://jenkins.internal/job/123", active: false };
  const eligible2 = isTabEligibleForLru(tab2, {}, {
    exclusions: [{ domain: "jenkins.internal", reason: "CI/CD Pipeline" }]
  });
  assert.equal(eligible2.eligible, false);
  assert.equal(eligible2.reason, "CI/CD Pipeline");
});





