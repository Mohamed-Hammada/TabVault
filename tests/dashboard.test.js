import test from "node:test";
import assert from "node:assert/strict";

import {
  isSuspendedTab,
  formatRelativeTime,
  formatIdleDuration,
  formatTimestamp,
  formatMemoryMb,
  extractDomain,
  createTabGroupMap,
  CHROME_GROUP_COLORS,
  getTabGroupColorCode,
  getTabGroupsSummary,
  getActiveTabs,
  getSuspendedTabs,
  getRecentlySuspended,
  recordRecentSuspension,
  getRecentlyRestored,
  recordRecentRestoration,
  getDashboardOverview,
  getMemorySavingsBreakdown,
  formatSuspensionReason,
  getSuspensionReasonColor,
  getSuspensionReasonsBreakdown,
  parseSuspendedTabInfo,
  DEFAULT_RECENT_LIMIT,
  SUSPENDED_URL_PATTERN,
  resolveSnapshotForTab,
  getSnapshotAvailability,
  getRestoreStageLabel,
  getRestoreFailures,
  recordRestoreFailure,
  canSuspendTab,
  canRestoreTab,
  getEligibleTabsToSuspend,
  countEligibleTabs,
  getSuspendedTabsToRestore,
  countSuspendedTabs,
  isDomainExcluded,
  excludeDomain,
  unexcludeDomain,
  toggleExcludeDomain,
  isTabManuallyProtected,
  formatSnapshotDetails,
  deleteSnapshotRecord,
  serializeSession,
  serializeAllSessions,
  parseAndValidateSession,
  sanitizeSessionTab,
  mergeSessions
} from "../lib/dashboard-service.js";

test("isSuspendedTab accurately identifies suspended tabs and normal tabs", () => {
  assert.equal(isSuspendedTab(null), false);
  assert.equal(isSuspendedTab({}), false);
  assert.equal(isSuspendedTab({ url: "https://example.com" }), false);
  assert.equal(isSuspendedTab({ url: "chrome-extension://xyz/suspended/suspended.html?url=https%3A%2F%2Fgoogle.com" }), true);
  assert.equal(isSuspendedTab({ url: "chrome-extension://xyz/suspended/suspended.html" }), true);
  assert.equal(isSuspendedTab({ pendingUrl: "chrome-extension://xyz/suspended/suspended.html" }), true);
  assert.equal(isSuspendedTab({ url: "custom-prefix://tab", pendingUrl: "" }, "custom-prefix://"), true);
  assert.equal(isSuspendedTab({ discarded: true, url: "" }), true);
  assert.equal(isSuspendedTab({ discarded: false, url: "https://news.ycombinator.com" }), false);
});

test("formatRelativeTime formats durations into human-readable relative time", () => {
  const now = 1700000000000;
  assert.equal(formatRelativeTime(null, now), "unknown");
  assert.equal(formatRelativeTime(NaN, now), "unknown");
  assert.equal(formatRelativeTime(now - 10000, now), "just now"); // 10s
  assert.equal(formatRelativeTime(now - 44000, now), "just now"); // 44s
  assert.equal(formatRelativeTime(now - 60000, now), "1m ago"); // 1m
  assert.equal(formatRelativeTime(now - 15 * 60000, now), "15m ago"); // 15m
  assert.equal(formatRelativeTime(now - 120 * 60000, now), "2h ago"); // 2h
  assert.equal(formatRelativeTime(now - 25 * 3600000, now), "1d ago"); // 25h = 1d
  assert.equal(formatRelativeTime(now - 72 * 3600000, now), "3d ago"); // 3d
});

test("formatMemoryMb formats MB and GB scales accurately", () => {
  assert.equal(formatMemoryMb(0), "0 MB");
  assert.equal(formatMemoryMb(45), "45 MB");
  assert.equal(formatMemoryMb(128.4), "128 MB");
  assert.equal(formatMemoryMb(1024), "1.0 GB");
  assert.equal(formatMemoryMb(2560), "2.5 GB");
  assert.equal(formatMemoryMb("invalid"), "0 MB");
});

test("extractDomain extracts clean domain names and unwraps suspended URLs", () => {
  assert.equal(extractDomain(""), "");
  assert.equal(extractDomain(null), "");
  assert.equal(extractDomain("https://www.github.com/features"), "github.com");
  assert.equal(extractDomain("https://docs.google.com/document/d/123"), "docs.google.com");
  assert.equal(extractDomain("chrome://settings/"), "chrome://settings");
  assert.equal(
    extractDomain("chrome-extension://xyz/suspended/suspended.html?url=https%3A%2F%2Freddit.com%2Fr%2Fprogramming"),
    "reddit.com"
  );
  assert.equal(
    extractDomain("chrome-extension://xyz/options/options.html"),
    "Extension Page"
  );
  assert.equal(extractDomain("not a valid url"), "not a valid url");
});

test("createTabGroupMap indexes tab groups into an efficient lookup map", () => {
  const groups = [
    { id: 10, title: "Dev Work", color: "blue", collapsed: false, windowId: 1 },
    { id: 20, title: "Reading", color: "green", collapsed: true, windowId: 1 },
    { id: -1, title: "Ungrouped", color: "grey" },
    null
  ];
  const map = createTabGroupMap(groups);
  assert.equal(map.size, 2);
  assert.equal(map.has(10), true);
  assert.equal(map.get(10).title, "Dev Work");
  assert.equal(map.get(10).color, "blue");
  assert.equal(map.get(20).collapsed, true);
  assert.equal(map.has(-1), false);
});

test("getActiveTabs filters suspended tabs and enriches active tabs with metadata, RAM, and priority", () => {
  const now = Date.now();
  const tabs = [
    {
      id: 1,
      windowId: 100,
      groupId: 10,
      title: "GitHub - Pull Request #42",
      url: "https://github.com/repo/pull/42",
      favIconUrl: "https://github.com/favicon.ico",
      active: true,
      pinned: false,
      audible: false
    },
    {
      id: 2,
      windowId: 100,
      groupId: -1,
      title: "Suspended YouTube Tab",
      url: "chrome-extension://xyz/suspended/suspended.html?url=https%3A%2F%2Fyoutube.com%2Fwatch%3Fv%3D123",
      active: false
    },
    {
      id: 3,
      windowId: 100,
      groupId: -1,
      title: "Wikipedia - Computer Science",
      url: "https://en.wikipedia.org/wiki/Computer_science",
      active: false,
      pinned: true
    }
  ];

  const tabGroups = [
    { id: 10, title: "Dev Work", color: "blue" }
  ];

  const tabState = new Map([
    [1, { lastActiveAt: now - 30000, audible: false, hasFormInput: true }],
    [3, { lastActiveAt: now - 3600000, audible: false, hasFormInput: false }]
  ]);

  const activeTabs = getActiveTabs(tabs, tabGroups, {
    tabState,
    now,
    settings: {
      neverSuspend: { pinned: true, audible: true, hasFormInput: true }
    }
  });

  // Tab 2 should be excluded because it is suspended
  assert.equal(activeTabs.length, 2);

  // Tab 1 checks
  const tab1 = activeTabs.find(t => t.id === 1);
  assert.ok(tab1);
  assert.equal(tab1.domain, "github.com");
  assert.equal(tab1.active, true);
  assert.equal(tab1.group?.title, "Dev Work");
  assert.equal(tab1.hasFormInput, true);
  assert.equal(tab1.lastActiveRelative, "just now");
  assert.ok(tab1.estimatedMemoryMb > 0);
  assert.ok(typeof tab1.suspensionScore === "number");
  assert.ok(tab1.isProtected); // Because active and hasFormInput
  assert.ok(tab1.protectionReasons.length > 0);

  // Tab 3 checks
  const tab3 = activeTabs.find(t => t.id === 3);
  assert.ok(tab3);
  assert.equal(tab3.domain, "en.wikipedia.org");
  assert.equal(tab3.pinned, true);
  assert.equal(tab3.lastActiveRelative, "1h ago");
  assert.ok(tab3.isProtected); // Because pinned
});

test("getActiveTabs supports search filtering and window/group scoping", () => {
  const tabs = [
    { id: 1, windowId: 1, groupId: 10, title: "Google Search", url: "https://google.com/search?q=tabvault" },
    { id: 2, windowId: 1, groupId: -1, title: "Hacker News", url: "https://news.ycombinator.com" },
    { id: 3, windowId: 2, groupId: -1, title: "Reddit Programming", url: "https://reddit.com/r/programming" }
  ];

  // Window filter
  const window1Tabs = getActiveTabs(tabs, [], { windowId: 1 });
  assert.equal(window1Tabs.length, 2);
  assert.deepEqual(window1Tabs.map(t => t.id), [1, 2]);

  // Group filter
  const group10Tabs = getActiveTabs(tabs, [], { groupId: 10 });
  assert.equal(group10Tabs.length, 1);
  assert.equal(group10Tabs[0].id, 1);

  // Search filter
  const searchResults = getActiveTabs(tabs, [], { searchQuery: "hacker" });
  assert.equal(searchResults.length, 1);
  assert.equal(searchResults[0].id, 2);

  const searchDomainResults = getActiveTabs(tabs, [], { searchQuery: "reddit.com" });
  assert.equal(searchDomainResults.length, 1);
  assert.equal(searchDomainResults[0].id, 3);
});

test("getActiveTabs sorts tabs by recency, memory, score, and title", () => {
  const now = 1700000000000;
  const tabs = [
    { id: 1, title: "Zebra Notes", url: "https://example.com/z", active: false },
    { id: 2, title: "Alpha Docs", url: "https://docs.google.com/document/d/1", active: false },
    { id: 3, title: "Active Current", url: "https://example.com/active", active: true }
  ];

  const tabState = new Map([
    [1, { lastActiveAt: now - 500000 }],
    [2, { lastActiveAt: now - 100000 }],
    [3, { lastActiveAt: now }]
  ]);

  // Sort: recency (active first, then newer lastActiveAt)
  const sortedRecency = getActiveTabs(tabs, [], { tabState, now, sortBy: "recency" });
  assert.deepEqual(sortedRecency.map(t => t.id), [3, 2, 1]);

  // Sort: title (alphabetical: "Active Current", "Alpha Docs", "Zebra Notes")
  const sortedTitle = getActiveTabs(tabs, [], { tabState, now, sortBy: "title" });
  assert.deepEqual(sortedTitle.map(t => t.id), [3, 2, 1]);

  // Sort: memory (Google Docs heuristic is higher ~140MB vs regular ~80MB)
  const sortedMemory = getActiveTabs(tabs, [], { tabState, now, sortBy: "memory" });
  assert.equal(sortedMemory[0].id, 2); // docs.google.com has higher estimated RAM
});

test("getDashboardOverview aggregates tab counts and estimated memory metrics", () => {
  const tabs = [
    { id: 1, url: "https://github.com", active: true },
    { id: 2, url: "https://news.ycombinator.com", active: false },
    { id: 3, url: "chrome-extension://xyz/suspended/suspended.html?url=https%3A%2F%2Freddit.com", active: false },
    { id: 4, url: "chrome-extension://xyz/suspended/suspended.html?url=https%3A%2F%2Fyoutube.com", active: false }
  ];

  const tabGroups = [
    { id: 1, title: "Reading" }
  ];

  const overview = getDashboardOverview(tabs, tabGroups);
  assert.equal(overview.totalTabs, 4);
  assert.equal(overview.activeCount, 2);
  assert.equal(overview.suspendedCount, 2);
  assert.equal(overview.tabGroupCount, 1);
  assert.ok(overview.totalActiveMemoryMb > 0);
  assert.ok(overview.totalMemorySavedMb > 0);
  assert.ok(overview.totalActiveMemoryFormatted.includes("MB") || overview.totalActiveMemoryFormatted.includes("GB"));
  assert.ok(overview.totalMemorySavedFormatted.includes("MB") || overview.totalMemorySavedFormatted.includes("GB"));
});

test("formatSuspensionReason translates codes into human-friendly labels", () => {
  assert.equal(formatSuspensionReason("idle_timeout"), "Idle timeout");
  assert.equal(formatSuspensionReason("memory_pressure"), "Memory pressure");
  assert.equal(formatSuspensionReason("domain_rule"), "Domain rule");
  assert.equal(formatSuspensionReason("manual"), "Manual suspension");
  assert.equal(formatSuspensionReason("battery_saver"), "Battery saver");
  assert.equal(formatSuspensionReason("window_blur"), "Window blur");
  assert.equal(formatSuspensionReason("snooze"), "Scheduled snooze");
  assert.equal(formatSuspensionReason("startup"), "Browser startup");
  assert.equal(formatSuspensionReason("max_tabs"), "Tab limit reached");
  assert.equal(formatSuspensionReason("media"), "Media playback ended");
  assert.equal(formatSuspensionReason("native_discard"), "Native discard");
  assert.equal(formatSuspensionReason("custom_tag"), "Custom Tag");
  assert.equal(formatSuspensionReason(""), "Idle timeout");
});

test("parseSuspendedTabInfo decodes metadata from hash fragments and query strings", () => {
  // Hash fragment format
  const tabHash = {
    id: 10,
    url: "chrome-extension://xyz/suspended/suspended.html#u=https%3A%2F%2Fnews.ycombinator.com&t=Hacker%20News&f=https%3A%2F%2Fnews.ycombinator.com%2Ffavicon.ico&at=1700000000000&r=memory_pressure&sid=snap-123"
  };
  const parsedHash = parseSuspendedTabInfo(tabHash);
  assert.equal(parsedHash.url, "https://news.ycombinator.com");
  assert.equal(parsedHash.title, "Hacker News");
  assert.equal(parsedHash.favIconUrl, "https://news.ycombinator.com/favicon.ico");
  assert.equal(parsedHash.suspendedAt, 1700000000000);
  assert.equal(parsedHash.reason, "memory_pressure");
  assert.equal(parsedHash.snapshotId, "snap-123");

  // Query parameter format
  const tabQuery = {
    id: 11,
    url: "chrome-extension://xyz/suspended/suspended.html?url=https%3A%2F%2Fgithub.com&title=GitHub&reason=manual"
  };
  const parsedQuery = parseSuspendedTabInfo(tabQuery);
  assert.equal(parsedQuery.url, "https://github.com");
  assert.equal(parsedQuery.title, "GitHub");
  assert.equal(parsedQuery.reason, "manual");

  // Discarded native tab without URL
  const tabDiscarded = {
    id: 12,
    discarded: true,
    title: "Background Tab",
    url: ""
  };
  const parsedDiscarded = parseSuspendedTabInfo(tabDiscarded);
  assert.equal(parsedDiscarded.title, "Background Tab");
  assert.equal(parsedDiscarded.reason, "native_discard");
});

test("getSuspendedTabs filters and enriches suspended tabs with original metadata and saved memory", () => {
  const now = 1700000000000;
  const tabs = [
    {
      id: 1,
      windowId: 100,
      groupId: 10,
      url: "chrome-extension://xyz/suspended/suspended.html#u=https%3A%2F%2Fgithub.com%2Fproject&t=GitHub%20Repo&at=1699999000000&r=idle_timeout&sid=snap-42"
    },
    {
      id: 2,
      windowId: 100,
      groupId: -1,
      url: "chrome-extension://xyz/suspended/suspended.html#u=https%3A%2F%2Fdocs.google.com%2Fdocument%2Fd%2Fabc&t=Project%20Doc&at=1699999500000&r=memory_pressure"
    },
    {
      id: 3,
      windowId: 100,
      groupId: -1,
      title: "Active Web Tab",
      url: "https://example.com/active",
      active: true
    }
  ];

  const tabGroups = [
    { id: 10, title: "Work Projects", color: "blue" }
  ];

  const suspended = getSuspendedTabs(tabs, tabGroups, { now });
  // Tab 3 should be excluded because it is active
  assert.equal(suspended.length, 2);

  // Tab 1 checks
  const t1 = suspended.find(t => t.id === 1);
  assert.ok(t1);
  assert.equal(t1.title, "GitHub Repo");
  assert.equal(t1.domain, "github.com");
  assert.equal(t1.group?.title, "Work Projects");
  assert.equal(t1.reasonFormatted, "Idle timeout");
  assert.equal(t1.hasSnapshot, true);
  assert.equal(t1.snapshotId, "snap-42");
  assert.ok(t1.estimatedMemorySavedMb > 0);

  // Tab 2 checks
  const t2 = suspended.find(t => t.id === 2);
  assert.ok(t2);
  assert.equal(t2.title, "Project Doc");
  assert.equal(t2.domain, "docs.google.com");
  assert.equal(t2.reasonFormatted, "Memory pressure");
  assert.equal(t2.hasSnapshot, false);
});

test("getSuspendedTabs supports search filtering and sorting", () => {
  const tabs = [
    {
      id: 1,
      title: "Suspended A",
      url: "chrome-extension://xyz/suspended/suspended.html#u=https%3A%2F%2Falpha.com&t=Alpha&at=1000&r=idle_timeout"
    },
    {
      id: 2,
      title: "Suspended B",
      url: "chrome-extension://xyz/suspended/suspended.html#u=https%3A%2F%2Fbeta.org&t=Beta&at=3000&r=memory_pressure"
    },
    {
      id: 3,
      title: "Suspended Z",
      url: "chrome-extension://xyz/suspended/suspended.html#u=https%3A%2F%2Fdocs.google.com%2Fspreadsheets&t=Zebra%20Sheet&at=2000&r=manual"
    }
  ];

  // Search filter
  const searchBeta = getSuspendedTabs(tabs, [], { searchQuery: "beta" });
  assert.equal(searchBeta.length, 1);
  assert.equal(searchBeta[0].id, 2);

  const searchReason = getSuspendedTabs(tabs, [], { searchQuery: "manual" });
  assert.equal(searchReason.length, 1);
  assert.equal(searchReason[0].id, 3);

  // Sort: recency (newest suspendedAt first)
  const sortRecency = getSuspendedTabs(tabs, [], { sortBy: "recency" });
  assert.deepEqual(sortRecency.map(t => t.id), [2, 3, 1]); // 3000, 2000, 1000

  // Sort: title (alphabetical)
  const sortTitle = getSuspendedTabs(tabs, [], { sortBy: "title" });
  assert.deepEqual(sortTitle.map(t => t.id), [1, 2, 3]); // Alpha, Beta, Zebra Sheet

  // Sort: memory (docs.google.com has higher estimated RAM saved ~140MB vs ~80MB)
  const sortMemory = getSuspendedTabs(tabs, [], { sortBy: "memory" });
  assert.equal(sortMemory[0].id, 3);
});

test("recordRecentSuspension prepends history and evicts oldest entries past limit", () => {
  const initial = [];
  const after1 = recordRecentSuspension({
    tabId: 1,
    url: "https://example.com/first",
    title: "First Tab",
    timestamp: 1000,
    reason: "idle_timeout"
  }, initial, 3);
  assert.equal(after1.length, 1);
  assert.equal(after1[0].title, "First Tab");
  assert.equal(after1[0].estimatedMemorySavedMb, 80);

  const after2 = recordRecentSuspension({
    tabId: 2,
    url: "https://example.com/second",
    title: "Second Tab",
    timestamp: 2000
  }, after1, 3);
  assert.equal(after2.length, 2);
  assert.equal(after2[0].title, "Second Tab"); // newest first

  const after3 = recordRecentSuspension({
    tabId: 3,
    url: "https://example.com/third",
    title: "Third Tab",
    timestamp: 3000
  }, after2, 3);
  assert.equal(after3.length, 3);
  assert.equal(after3[0].title, "Third Tab");

  // Fourth entry should evict the oldest ("First Tab") since maxEntries is 3
  const after4 = recordRecentSuspension({
    tabId: 4,
    url: "https://example.com/fourth",
    title: "Fourth Tab",
    timestamp: 4000
  }, after3, 3);
  assert.equal(after4.length, 3);
  assert.equal(after4[0].title, "Fourth Tab");
  assert.equal(after4[1].title, "Third Tab");
  assert.equal(after4[2].title, "Second Tab");
  assert.equal(after4.some(e => e.title === "First Tab"), false);
});

test("getRecentlySuspended formats entries, supports search queries, and limits results", () => {
  const now = 1700000000000;
  const history = [
    {
      id: "s1",
      tabId: 1,
      url: "https://github.com/microsoft/vscode",
      title: "VS Code Repository",
      domain: "github.com",
      timestamp: now - 60000, // 1m ago
      reason: "memory_pressure",
      estimatedMemorySavedMb: 120
    },
    {
      id: "s2",
      tabId: 2,
      url: "https://youtube.com/watch?v=xyz",
      title: "Nature Documentary",
      domain: "youtube.com",
      timestamp: now - 3600000, // 1h ago
      reason: "idle_timeout",
      estimatedMemorySavedMb: 160
    },
    {
      id: "s3",
      tabId: 3,
      url: "https://news.ycombinator.com",
      title: "Hacker News",
      domain: "news.ycombinator.com",
      timestamp: now - 7200000, // 2h ago
      reason: "manual",
      estimatedMemorySavedMb: 60
    }
  ];

  // Basic formatting & retrieval
  const list = getRecentlySuspended(history, [], { now, limit: 10 });
  assert.equal(list.length, 3);
  assert.equal(list[0].title, "VS Code Repository");
  assert.equal(list[0].relativeTime, "1m ago");
  assert.equal(list[0].reasonFormatted, "Memory pressure");
  assert.equal(list[0].estimatedMemorySavedFormatted, "120 MB");

  // Search query filter
  const searchGithub = getRecentlySuspended(history, [], { now, searchQuery: "vscode" });
  assert.equal(searchGithub.length, 1);
  assert.equal(searchGithub[0].id, "s1");

  const searchReason = getRecentlySuspended(history, [], { now, searchQuery: "manual" });
  assert.equal(searchReason.length, 1);
  assert.equal(searchReason[0].id, "s3");

  // Limit check
  const limited = getRecentlySuspended(history, [], { now, limit: 2 });
  assert.equal(limited.length, 2);
  assert.deepEqual(limited.map(e => e.id), ["s1", "s2"]);
});

test("getRecentlySuspended falls back to open suspended tabs when history is empty", () => {
  const now = 1700000000000;
  const openTabs = [
    {
      id: 99,
      url: "chrome-extension://xyz/suspended/suspended.html#u=https%3A%2F%2Fexample.org&t=Example%20Fallback&at=1699999000000&r=battery_saver"
    }
  ];

  const derived = getRecentlySuspended([], openTabs, { now });
  assert.equal(derived.length, 1);
  assert.equal(derived[0].title, "Example Fallback");
  assert.equal(derived[0].domain, "example.org");
  assert.equal(derived[0].reasonFormatted, "Battery saver");
});

test("recordRecentRestoration prepends history and evicts oldest entries past limit", () => {
  const initial = [];
  const after1 = recordRecentRestoration({
    tabId: 10,
    url: "https://news.ycombinator.com",
    title: "Hacker News",
    timestamp: 1000,
    method: "smart",
    durationMs: 450
  }, initial, 3);
  assert.equal(after1.length, 1);
  assert.equal(after1[0].title, "Hacker News");
  assert.equal(after1[0].method, "smart");
  assert.equal(after1[0].durationMs, 450);

  const after2 = recordRecentRestoration({
    tabId: 20,
    url: "https://github.com",
    title: "GitHub",
    timestamp: 2000,
    method: "fallback"
  }, after1, 3);
  assert.equal(after2.length, 2);
  assert.equal(after2[0].title, "GitHub");

  const after3 = recordRecentRestoration({
    tabId: 30,
    url: "https://reddit.com",
    title: "Reddit",
    timestamp: 3000
  }, after2, 3);
  assert.equal(after3.length, 3);
  assert.equal(after3[0].title, "Reddit");

  // Fourth entry should evict the oldest ("Hacker News") since maxEntries is 3
  const after4 = recordRecentRestoration({
    tabId: 40,
    url: "https://twitter.com",
    title: "Twitter",
    timestamp: 4000
  }, after3, 3);
  assert.equal(after4.length, 3);
  assert.equal(after4[0].title, "Twitter");
  assert.equal(after4[1].title, "Reddit");
  assert.equal(after4[2].title, "GitHub");
  assert.equal(after4.some(e => e.title === "Hacker News"), false);
});

test("getRecentlyRestored formats entries, supports search queries, and limits results", () => {
  const now = 1700000000000;
  const history = [
    {
      id: "r1",
      tabId: 101,
      url: "https://github.com/microsoft/typescript",
      title: "TypeScript Repository",
      domain: "github.com",
      timestamp: now - 30000, // 30s ago
      durationMs: 250,
      method: "smart"
    },
    {
      id: "r2",
      tabId: 102,
      url: "https://docs.google.com/document/d/123",
      title: "Architecture Spec",
      domain: "docs.google.com",
      timestamp: now - 300000, // 5m ago
      durationMs: 780,
      method: "fallback"
    }
  ];

  // Basic formatting
  const list = getRecentlyRestored(history, [], { now });
  assert.equal(list.length, 2);
  assert.equal(list[0].title, "TypeScript Repository");
  assert.equal(list[0].relativeTime, "just now");
  assert.equal(list[0].durationMs, 250);
  assert.equal(list[0].methodLabel, "Smart Restore");

  assert.equal(list[1].title, "Architecture Spec");
  assert.equal(list[1].relativeTime, "5m ago");
  assert.equal(list[1].methodLabel, "Direct URL");

  // Search filter
  const searchTs = getRecentlyRestored(history, [], { now, searchQuery: "typescript" });
  assert.equal(searchTs.length, 1);
  assert.equal(searchTs[0].id, "r1");

  const searchFallback = getRecentlyRestored(history, [], { now, searchQuery: "fallback" });
  assert.equal(searchFallback.length, 1);
  assert.equal(searchFallback[0].id, "r2");

  // Fallback to active tabs
  const openTabs = [
    {
      id: 55,
      url: "https://wikipedia.org",
      title: "Wikipedia",
      active: true,
      lastAccessed: now - 120000
    }
  ];
  const derived = getRecentlyRestored([], openTabs, { now });
  assert.equal(derived.length, 1);
  assert.equal(derived[0].title, "Wikipedia");
  assert.equal(derived[0].domain, "wikipedia.org");
});

test("getMemorySavingsBreakdown calculates savings ratio, lifetime reclaimed, and domain rankings", () => {
  const tabs = [
    { id: 1, url: "https://example.com/page", active: true },
    {
      id: 2,
      url: "chrome-extension://xyz/suspended/suspended.html#u=https%3A%2F%2Fgithub.com%2Fproject1&t=GitHub%201",
      active: false
    },
    {
      id: 3,
      url: "chrome-extension://xyz/suspended/suspended.html#u=https%3A%2F%2Fgithub.com%2Fproject2&t=GitHub%202",
      active: false
    },
    {
      id: 4,
      url: "chrome-extension://xyz/suspended/suspended.html#u=https%3A%2F%2Fdocs.google.com%2Fdocument%2Fd%2F1&t=Doc%201",
      active: false
    }
  ];

  const stats = {
    estimatedBytesSaved: 1024 * 1024 * 1024 * 3 // 3 GB lifetime saved
  };

  const breakdown = getMemorySavingsBreakdown(tabs, stats);
  assert.equal(breakdown.activeCount, 1);
  assert.equal(breakdown.suspendedCount, 3);
  assert.ok(breakdown.currentSavedMb > 0);
  assert.ok(breakdown.activeMemoryMb > 0);
  assert.equal(breakdown.lifetimeMb, 3072);
  assert.equal(breakdown.lifetimeFormatted, "3.0 GB");
  assert.ok(breakdown.savingsPercentage > 0 && breakdown.savingsPercentage <= 100);
  assert.ok(breakdown.averageSavedPerTabMb > 0);

  // Check topDomainSavings
  assert.ok(breakdown.topDomainSavings.length >= 2);
  const githubEntry = breakdown.topDomainSavings.find(d => d.domain === "github.com");
  assert.ok(githubEntry);
  assert.equal(githubEntry.tabCount, 2);

  const docsEntry = breakdown.topDomainSavings.find(d => d.domain === "docs.google.com");
  assert.ok(docsEntry);
  assert.equal(docsEntry.tabCount, 1);

  // Overview integration
  const overview = getDashboardOverview(tabs, [], { stats });
  assert.equal(overview.lifetimeMemorySavedFormatted, "3.0 GB");
  assert.equal(overview.savingsPercentage, breakdown.savingsPercentage);
  assert.equal(overview.averageSavedPerTabMb, breakdown.averageSavedPerTabMb);
  assert.ok(overview.reasonsBreakdown);
  assert.equal(overview.reasonsBreakdown.total, 3);
});

test("formatSuspensionReason and getSuspensionReasonColor classify and style diverse suspension reasons", () => {
  assert.equal(formatSuspensionReason(null), "Idle timeout");
  assert.equal(formatSuspensionReason(""), "Idle timeout");
  assert.equal(formatSuspensionReason("idle_timeout"), "Idle timeout");
  assert.equal(formatSuspensionReason("memory_pressure"), "Memory pressure");
  assert.equal(formatSuspensionReason("domain_rule"), "Domain rule");
  assert.equal(formatSuspensionReason("manual_user"), "Manual suspension");
  assert.equal(formatSuspensionReason("battery_saver"), "Battery saver");
  assert.equal(formatSuspensionReason("window_blur"), "Window blur");
  assert.equal(formatSuspensionReason("scheduled_snooze"), "Scheduled snooze");
  assert.equal(formatSuspensionReason("browser_startup"), "Browser startup");
  assert.equal(formatSuspensionReason("max_tabs_limit"), "Tab limit reached");
  assert.equal(formatSuspensionReason("audio_ended"), "Media playback ended");
  assert.equal(formatSuspensionReason("native_discard"), "Native discard");
  assert.equal(formatSuspensionReason("custom_heuristic"), "Custom Heuristic");

  assert.equal(getSuspensionReasonColor(null), "#61afef");
  assert.equal(getSuspensionReasonColor("idle"), "#61afef");
  assert.equal(getSuspensionReasonColor("memory_pressure"), "#e06c75");
  assert.equal(getSuspensionReasonColor("manual"), "#98c379");
  assert.equal(getSuspensionReasonColor("domain"), "#c678dd");
  assert.equal(getSuspensionReasonColor("battery"), "#e5c07b");
  assert.equal(getSuspensionReasonColor("window"), "#d19a66");
  assert.equal(getSuspensionReasonColor("snooze"), "#56b6c2");
  assert.equal(getSuspensionReasonColor("max_tabs"), "#be5046");
  assert.equal(getSuspensionReasonColor("discard"), "#828997");
  assert.equal(getSuspensionReasonColor("unknown_other"), "#abb2bf");
});

test("getSuspensionReasonsBreakdown aggregates frequency counts, percentages, and colors", () => {
  assert.deepEqual(getSuspensionReasonsBreakdown([]), { total: 0, reasons: [] });
  assert.deepEqual(getSuspensionReasonsBreakdown(null), { total: 0, reasons: [] });

  const items = [
    { reason: "idle_timeout" },
    { reason: "idle_timeout" },
    { reason: "idle_timeout" },
    { reason: "memory_pressure" },
    { reason: "memory_pressure" },
    { reason: "manual" },
    null
  ];

  const breakdown = getSuspensionReasonsBreakdown(items);
  assert.equal(breakdown.total, 6);
  assert.equal(breakdown.reasons.length, 3);

  // Highest count first
  assert.equal(breakdown.reasons[0].label, "Idle timeout");
  assert.equal(breakdown.reasons[0].count, 3);
  assert.equal(breakdown.reasons[0].percentage, 50);
  assert.equal(breakdown.reasons[0].color, "#61afef");

  assert.equal(breakdown.reasons[1].label, "Memory pressure");
  assert.equal(breakdown.reasons[1].count, 2);
  assert.equal(breakdown.reasons[1].percentage, 33);
  assert.equal(breakdown.reasons[1].color, "#e06c75");

  assert.equal(breakdown.reasons[2].label, "Manual suspension");
  assert.equal(breakdown.reasons[2].count, 1);
  assert.equal(breakdown.reasons[2].percentage, 17);
  assert.equal(breakdown.reasons[2].color, "#98c379");
});

test("getSuspendedTabs filters tabs by filterReason correctly", () => {
  const tabs = [
    {
      id: 1,
      url: "chrome-extension://xyz/suspended/suspended.html#u=https%3A%2F%2Fsite1.com&r=idle_timeout",
      title: "Site 1"
    },
    {
      id: 2,
      url: "chrome-extension://xyz/suspended/suspended.html#u=https%3A%2F%2Fsite2.com&r=memory_pressure",
      title: "Site 2"
    },
    {
      id: 3,
      url: "chrome-extension://xyz/suspended/suspended.html#u=https%3A%2F%2Fsite3.com&r=manual",
      title: "Site 3"
    },
    {
      id: 4,
      url: "chrome-extension://xyz/suspended/suspended.html#u=https%3A%2F%2Fsite4.com&r=domain_rule",
      title: "Site 4"
    }
  ];

  // Filter "all" returns all 4
  const allTabs = getSuspendedTabs(tabs, [], { filterReason: "all" });
  assert.equal(allTabs.length, 4);

  // Filter by reason substring / key
  const memoryTabs = getSuspendedTabs(tabs, [], { filterReason: "memory_pressure" });
  assert.equal(memoryTabs.length, 1);
  assert.equal(memoryTabs[0].id, 2);

  // Filter by formatted label
  const manualTabs = getSuspendedTabs(tabs, [], { filterReason: "manual suspension" });
  assert.equal(manualTabs.length, 1);
  assert.equal(manualTabs[0].id, 3);

  // Filter with no match
  const noMatch = getSuspendedTabs(tabs, [], { filterReason: "battery" });
  assert.equal(noMatch.length, 0);
});

test("formatIdleDuration and formatTimestamp format durations and timestamps appropriately", () => {
  assert.equal(formatIdleDuration(null), "Active now");
  assert.equal(formatIdleDuration(0), "Active now");
  assert.equal(formatIdleDuration(500), "Active now");
  assert.equal(formatIdleDuration(15000), "15s idle");
  assert.equal(formatIdleDuration(4 * 60 * 1000), "4m idle");
  assert.equal(formatIdleDuration(3 * 3600 * 1000), "3h idle");
  assert.equal(formatIdleDuration(2 * 86400 * 1000), "2d idle");

  assert.equal(formatTimestamp(null), "unknown");
  assert.equal(formatTimestamp(NaN), "unknown");
  assert.notEqual(formatTimestamp(1700000000000), "unknown");
});

test("getActiveTabs tracks idle durations, last active relative/formatted times, and sorts by idle", () => {
  const now = 1700000000000;
  const tabs = [
    { id: 1, title: "Active tab", url: "https://example.com/1", active: true, lastAccessed: now },
    { id: 2, title: "Idle 5m tab", url: "https://example.com/2", active: false, lastAccessed: now - 5 * 60000 },
    { id: 3, title: "Idle 2h tab", url: "https://example.com/3", active: false, lastAccessed: now - 2 * 3600000 }
  ];

  const activeTabs = getActiveTabs(tabs, [], { now, sortBy: "idle" });
  assert.equal(activeTabs.length, 3);

  // Sorting by "idle" places longest idle tabs first (id 3: 2h idle, then id 2: 5m idle), and active tab last (id 1)
  assert.equal(activeTabs[0].id, 3);
  assert.equal(activeTabs[0].idleDurationFormatted, "2h idle");
  assert.equal(activeTabs[0].lastActiveRelative, "2h ago");
  assert.ok(activeTabs[0].lastActiveFormatted);

  assert.equal(activeTabs[1].id, 2);
  assert.equal(activeTabs[1].idleDurationFormatted, "5m idle");

  assert.equal(activeTabs[2].id, 1);
  assert.equal(activeTabs[2].idleDurationFormatted, "Active now");
  assert.equal(activeTabs[2].lastActiveRelative, "just now");
});

test("parseSuspendedTabInfo decodes lastActiveAt and getSuspendedTabs supports lastActive sorting", () => {
  const now = 1700000000000;
  const tabs = [
    {
      id: 10,
      url: `chrome-extension://xyz/suspended/suspended.html#u=https%3A%2F%2FsiteA.com&at=${now - 300000}&la=${now - 600000}`,
      title: "Site A"
    },
    {
      id: 20,
      url: `chrome-extension://xyz/suspended/suspended.html#u=https%3A%2F%2FsiteB.com&at=${now - 100000}&la=${now - 1200000}`,
      title: "Site B"
    }
  ];

  const parsed = parseSuspendedTabInfo(tabs[0]);
  assert.equal(parsed.lastActiveAt, now - 600000);

  const suspendedList = getSuspendedTabs(tabs, [], { now, sortBy: "lastActive" });
  assert.equal(suspendedList.length, 2);

  // Last active descending: Site A was active 10m ago (more recent) vs Site B active 20m ago
  assert.equal(suspendedList[0].id, 10);
  assert.equal(suspendedList[0].lastActiveRelative, "10m ago");
  assert.ok(suspendedList[0].lastActiveFormatted);

  assert.equal(suspendedList[1].id, 20);
  assert.equal(suspendedList[1].lastActiveRelative, "20m ago");
});

test("CHROME_GROUP_COLORS and getTabGroupColorCode map color names to hex codes with fallback", () => {
  assert.equal(CHROME_GROUP_COLORS.blue, "#1a73e8");
  assert.equal(CHROME_GROUP_COLORS.red, "#d93025");
  assert.equal(CHROME_GROUP_COLORS.green, "#1e8e3e");

  assert.equal(getTabGroupColorCode("blue"), "#1a73e8");
  assert.equal(getTabGroupColorCode("RED"), "#d93025");
  assert.equal(getTabGroupColorCode("Green"), "#1e8e3e");
  assert.equal(getTabGroupColorCode("yellow"), "#f29900");
  assert.equal(getTabGroupColorCode(null), "#5f6368");
  assert.equal(getTabGroupColorCode("nonexistent"), "#5f6368");
});

test("createTabGroupMap indexes groups and decorates with colorCode", () => {
  const groups = [
    { id: 101, title: "Work", color: "blue", collapsed: false, windowId: 1 },
    { id: 102, title: "Research", color: "purple", collapsed: true, windowId: 1 }
  ];

  const map = createTabGroupMap(groups);
  assert.equal(map.size, 2);
  assert.equal(map.get(101).colorCode, "#1a73e8");
  assert.equal(map.get(102).colorCode, "#9334e6");
});

test("getTabGroupsSummary aggregates active vs suspended tabs, RAM, and handles empty/null", () => {
  assert.deepEqual(getTabGroupsSummary(null), []);
  assert.deepEqual(getTabGroupsSummary([]), []);

  const tabGroups = [
    { id: 1, title: "Frontend", color: "blue", collapsed: false, windowId: 10 },
    { id: 2, title: "Backend", color: "green", collapsed: true, windowId: 10 }
  ];

  const tabs = [
    { id: 10, groupId: 1, url: "https://react.dev", title: "React", active: true },
    {
      id: 11,
      groupId: 1,
      url: "chrome-extension://xyz/suspended/suspended.html#u=https%3A%2F%2Fvuejs.org&t=Vue",
      active: false
    },
    { id: 12, groupId: 2, url: "https://nodejs.org", title: "Node.js", active: true },
    { id: 13, groupId: -1, url: "https://google.com", title: "Google", active: true } // Ungrouped
  ];

  const summary = getTabGroupsSummary(tabGroups, tabs);
  assert.equal(summary.length, 2);

  const g1 = summary.find(g => g.id === 1);
  assert.ok(g1);
  assert.equal(g1.title, "Frontend");
  assert.equal(g1.colorCode, "#1a73e8");
  assert.equal(g1.totalTabs, 2);
  assert.equal(g1.activeCount, 1);
  assert.equal(g1.suspendedCount, 1);
  assert.ok(g1.activeMemoryMb > 0);
  assert.ok(g1.savedMemoryMb > 0);
  assert.deepEqual(g1.tabIds, [10, 11]);

  const g2 = summary.find(g => g.id === 2);
  assert.ok(g2);
  assert.equal(g2.totalTabs, 1);
  assert.equal(g2.activeCount, 1);
  assert.equal(g2.suspendedCount, 0);
  assert.deepEqual(g2.tabIds, [12]);

  // Overview includes tab groups summary
  const overview = getDashboardOverview(tabs, tabGroups);
  assert.ok(overview.groups);
  assert.equal(overview.groups.length, 2);
});

test("getActiveTabs and getSuspendedTabs filter by groupId correctly", () => {
  const tabGroups = [
    { id: 5, title: "Design", color: "pink" },
    { id: 6, title: "Docs", color: "cyan" }
  ];

  const tabs = [
    { id: 1, groupId: 5, url: "https://figma.com", title: "Figma", active: true },
    { id: 2, groupId: 6, url: "https://notion.so", title: "Notion", active: false },
    {
      id: 3,
      groupId: 5,
      url: "chrome-extension://xyz/suspended/suspended.html#u=https%3A%2F%2Fdribbble.com&t=Dribbble",
      active: false
    },
    {
      id: 4,
      groupId: 6,
      url: "chrome-extension://xyz/suspended/suspended.html#u=https%3A%2F%2Fdeveloper.mozilla.org&t=MDN",
      active: false
    }
  ];

  const activeGroup5 = getActiveTabs(tabs, tabGroups, { groupId: 5 });
  assert.equal(activeGroup5.length, 1);
  assert.equal(activeGroup5[0].id, 1);
  assert.equal(activeGroup5[0].group?.title, "Design");
  assert.equal(activeGroup5[0].group?.colorCode, "#e52592");

  const suspendedGroup6 = getSuspendedTabs(tabs, tabGroups, { groupId: 6 });
  assert.equal(suspendedGroup6.length, 1);
  assert.equal(suspendedGroup6[0].id, 4);
  assert.equal(suspendedGroup6[0].group?.title, "Docs");
  assert.equal(suspendedGroup6[0].group?.colorCode, "#007b83");
});

test("resolveSnapshotForTab resolves snapshots from URL sid, metadata, Map, or SnapshotStore", () => {
  assert.deepEqual(resolveSnapshotForTab(null), { hasSnapshot: false, snapshot: null, snapshotId: null });
  assert.deepEqual(resolveSnapshotForTab({ id: 10, url: "https://example.com" }), { hasSnapshot: false, snapshot: null, snapshotId: null });

  // Tab with sid in URL hash
  const tabWithHashSid = {
    id: 11,
    url: "chrome-extension://xyz/suspended/suspended.html#u=https%3A%2F%2Fgithub.com&sid=snap_123"
  };
  const res1 = resolveSnapshotForTab(tabWithHashSid);
  assert.equal(res1.hasSnapshot, true);
  assert.equal(res1.snapshotId, "snap_123");

  // Tab with snapshot in Map
  const snapObj = { id: "snap_456", timestamp: 1700000000000, screenshot: "data:image/jpeg;base64,abc" };
  const snapshotMap = new Map([
    [12, snapObj]
  ]);
  const res2 = resolveSnapshotForTab({ id: 12, url: "https://reddit.com" }, snapshotMap);
  assert.equal(res2.hasSnapshot, true);
  assert.equal(res2.snapshotId, "snap_456");
  assert.equal(res2.snapshot, snapObj);

  // Tab with metadata store
  const metaStore = {
    get: (id) => (id === 13 ? { snapshotId: "snap_789" } : null)
  };
  const res3 = resolveSnapshotForTab({ id: 13, url: "https://developer.mozilla.org" }, null, metaStore);
  assert.equal(res3.hasSnapshot, true);
  assert.equal(res3.snapshotId, "snap_789");
});

test("getSnapshotAvailability computes accurate metrics, counts, and coverage percentages", () => {
  // Empty tabs array
  const emptyRes = getSnapshotAvailability([]);
  assert.equal(emptyRes.totalTabs, 0);
  assert.equal(emptyRes.suspendedCoveragePercentage, 100);
  assert.equal(emptyRes.totalCoveragePercentage, 100);
  assert.equal(emptyRes.hasAnySnapshots, false);

  const snapshotMap = new Map([
    [101, { id: "snap_101", timestamp: Date.now() - 60000 }],
    [201, { id: "snap_201", timestamp: Date.now() - 120000 }]
  ]);

  const tabs = [
    // 2 active tabs: 1 with snapshot, 1 without
    { id: 101, url: "https://google.com", title: "Google" },
    { id: 102, url: "https://wikipedia.org", title: "Wikipedia" },
    // 2 suspended tabs: 1 with snapshot, 1 without
    {
      id: 201,
      url: "chrome-extension://xyz/suspended/suspended.html#u=https%3A%2F%2Fnews.ycombinator.com&sid=snap_201"
    },
    {
      id: 202,
      url: "chrome-extension://xyz/suspended/suspended.html#u=https%3A%2F%2Flobste.rs"
    }
  ];

  const metrics = getSnapshotAvailability(tabs, snapshotMap);
  assert.equal(metrics.totalTabs, 4);
  assert.equal(metrics.activeTabsCount, 2);
  assert.equal(metrics.suspendedTabsCount, 2);
  assert.equal(metrics.tabsWithSnapshots, 2);
  assert.equal(metrics.activeWithSnapshots, 1);
  assert.equal(metrics.activeWithoutSnapshots, 1);
  assert.equal(metrics.suspendedWithSnapshots, 1);
  assert.equal(metrics.suspendedWithoutSnapshots, 1);
  assert.equal(metrics.suspendedCoveragePercentage, 50);
  assert.equal(metrics.activeCoveragePercentage, 50);
  assert.equal(metrics.totalCoveragePercentage, 50);
  assert.equal(metrics.hasAnySnapshots, true);
  assert.equal(metrics.totalKnownSnapshots, 2);
});

test("getActiveTabs and getSuspendedTabs support filterSnapshot ('with', 'without', 'all') and enrich snapshot fields", () => {
  const now = Date.now();
  const snapshotMap = new Map([
    [1, { id: "snap_1", timestamp: now - 30000 }],
    [3, {
      id: "snap_3",
      timestamp: now - 60000,
      screenshot: "data:image/jpeg;base64,...",
      scroll: { y: 350 },
      forms: [{ selector: "#input", value: "test" }]
    }]
  ]);

  const tabs = [
    { id: 1, url: "https://github.com", title: "GitHub", active: true },
    { id: 2, url: "https://gitlab.com", title: "GitLab", active: false },
    {
      id: 3,
      url: "chrome-extension://xyz/suspended/suspended.html#u=https%3A%2F%2Freact.dev&sid=snap_3"
    },
    {
      id: 4,
      url: "chrome-extension://xyz/suspended/suspended.html#u=https%3A%2F%2Fvuejs.org"
    }
  ];

  // Active tabs: filter with snapshot
  const activeWith = getActiveTabs(tabs, [], { snapshotMap, filterSnapshot: "with", now });
  assert.equal(activeWith.length, 1);
  assert.equal(activeWith[0].id, 1);
  assert.equal(activeWith[0].hasSnapshot, true);
  assert.equal(activeWith[0].snapshotId, "snap_1");
  assert.ok(activeWith[0].snapshotAgeFormatted);

  // Active tabs: filter without snapshot
  const activeWithout = getActiveTabs(tabs, [], { snapshotMap, filterSnapshot: "without", now });
  assert.equal(activeWithout.length, 1);
  assert.equal(activeWithout[0].id, 2);
  assert.equal(activeWithout[0].hasSnapshot, false);

  // Suspended tabs: filter with snapshot
  const suspendedWith = getSuspendedTabs(tabs, [], { snapshotMap, filterSnapshot: "with", now });
  assert.equal(suspendedWith.length, 1);
  assert.equal(suspendedWith[0].id, 3);
  assert.equal(suspendedWith[0].hasSnapshot, true);
  assert.equal(suspendedWith[0].snapshotId, "snap_3");
  assert.equal(suspendedWith[0].hasScreenshot, true);
  assert.equal(suspendedWith[0].hasScroll, true);
  assert.equal(suspendedWith[0].hasFormData, true);

  // Suspended tabs: filter without snapshot
  const suspendedWithout = getSuspendedTabs(tabs, [], { snapshotMap, filterSnapshot: "without", now });
  assert.equal(suspendedWithout.length, 1);
  assert.equal(suspendedWithout[0].id, 4);
  assert.equal(suspendedWithout[0].hasSnapshot, false);
});

test("getDashboardOverview includes snapshotAvailability summary metrics", () => {
  const snapshotMap = new Map([
    [10, { id: "snap_10", timestamp: Date.now() }]
  ]);

  const tabs = [
    { id: 10, url: "chrome-extension://xyz/suspended/suspended.html#u=https%3A%2F%2Ftypescriptlang.org&sid=snap_10" },
    { id: 20, url: "https://python.org", title: "Python", active: true }
  ];

  const overview = getDashboardOverview(tabs, [], { snapshotMap });
  assert.ok(overview.snapshotAvailability);
  assert.equal(overview.snapshotAvailability.totalTabs, 2);
  assert.equal(overview.snapshotAvailability.suspendedCoveragePercentage, 100);
  assert.equal(overview.snapshotAvailability.suspendedWithSnapshots, 1);
  assert.equal(overview.snapshotAvailability.activeWithSnapshots, 0);
  assert.equal(overview.snapshotAvailability.hasAnySnapshots, true);
});

test("getRestoreStageLabel translates pipeline stages to human-readable strings", () => {
  assert.equal(getRestoreStageLabel(null), "Restoration Pipeline");
  assert.equal(getRestoreStageLabel("queued"), "Queued");
  assert.equal(getRestoreStageLabel("deferred"), "Deferred");
  assert.equal(getRestoreStageLabel("navigating"), "Page Navigation");
  assert.equal(getRestoreStageLabel("dom_ready"), "Waiting for DOM");
  assert.equal(getRestoreStageLabel("scroll"), "Scroll Restoration");
  assert.equal(getRestoreStageLabel("forms"), "Form Restoration");
  assert.equal(getRestoreStageLabel("adapters"), "Site Adapter");
  assert.equal(getRestoreStageLabel("failed"), "Restoration Failed");
  assert.equal(getRestoreStageLabel("custom_failure_step"), "Custom Failure Step");
});

test("getRestoreFailures formats failure records, enriches with open tabs, and supports query filtering", () => {
  const now = 1700000000000;
  const openTabs = [
    { id: 101, title: "Google Docs - Meeting Notes", url: "https://docs.google.com/document/d/123", favIconUrl: "https://docs.google.com/favicon.ico" },
    { id: 102, title: "GitHub PR #99", url: "https://github.com/org/repo/pull/99" }
  ];

  const rawFailures = [
    {
      tabId: 101,
      error: "Timeout waiting for DOM ready",
      stage: "dom_ready",
      attempts: 3,
      retryCount: 2,
      failedAt: now - 30000,
      isRetryable: true
    },
    {
      tabId: 102,
      error: "Navigation aborted by user",
      stage: "navigating",
      attempts: 1,
      retryCount: 1,
      failedAt: now - 120000,
      isRetryable: false
    },
    {
      tabId: 103, // closed tab
      targetUrl: "https://stackoverflow.com/questions/456",
      title: "Stack Overflow Question",
      error: "Script injection disallowed on this page",
      stage: "forms",
      attempts: 2,
      retryCount: 1,
      failedAt: now - 300000,
      isRetryable: true
    }
  ];

  const enriched = getRestoreFailures(rawFailures, openTabs, { now });
  assert.equal(enriched.length, 3);

  // Tab 101 enriched with open tab details
  assert.equal(enriched[0].tabId, 101);
  assert.equal(enriched[0].title, "Google Docs - Meeting Notes");
  assert.equal(enriched[0].domain, "docs.google.com");
  assert.equal(enriched[0].favIconUrl, "https://docs.google.com/favicon.ico");
  assert.equal(enriched[0].stageLabel, "Waiting for DOM");
  assert.equal(enriched[0].failedRelative, "just now");
  assert.equal(enriched[0].attempts, 3);
  assert.equal(enriched[0].retryCount, 2);
  assert.equal(enriched[0].isRetryable, true);

  // Search filtering by error text
  const filteredByError = getRestoreFailures(rawFailures, openTabs, { now, searchQuery: "injection" });
  assert.equal(filteredByError.length, 1);
  assert.equal(filteredByError[0].tabId, 103);
  assert.equal(filteredByError[0].domain, "stackoverflow.com");

  // Search filtering by domain
  const filteredByDomain = getRestoreFailures(rawFailures, openTabs, { now, searchQuery: "github" });
  assert.equal(filteredByDomain.length, 1);
  assert.equal(filteredByDomain[0].tabId, 102);

  // Sorting by retries/attempts
  const sortedByRetries = getRestoreFailures(rawFailures, openTabs, { now, sortBy: "retries" });
  assert.equal(sortedByRetries[0].tabId, 101); // 2 retries, 3 attempts
});

test("recordRestoreFailure adds entries, updates existing records for same tab, and enforces bounds", () => {
  let list = [];
  list = recordRestoreFailure({
    tabId: 5,
    targetUrl: "https://example.com/page1",
    error: "Connection refused",
    attempts: 1,
    retryCount: 1,
    failedAt: 1000
  }, list, 3);

  assert.equal(list.length, 1);
  assert.equal(list[0].tabId, 5);
  assert.equal(list[0].domain, "example.com");

  // Record failure for tab 6 and tab 7
  list = recordRestoreFailure({ tabId: 6, targetUrl: "https://test.com", failedAt: 2000 }, list, 3);
  list = recordRestoreFailure({ tabId: 7, targetUrl: "https://beta.com", failedAt: 3000 }, list, 3);
  assert.equal(list.length, 3);

  // Update failure for tab 5 (should deduplicate / move to front)
  list = recordRestoreFailure({ tabId: 5, targetUrl: "https://example.com/page1", error: "Second failure", retryCount: 2, failedAt: 4000 }, list, 3);
  assert.equal(list.length, 3);
  assert.equal(list[0].tabId, 5);
  assert.equal(list[0].error, "Second failure");
  assert.equal(list[0].retryCount, 2);

  // Enforce max bounds
  list = recordRestoreFailure({ tabId: 8, targetUrl: "https://delta.com", failedAt: 5000 }, list, 3);
  assert.equal(list.length, 3);
  assert.equal(list[0].tabId, 8);
});

test("getDashboardOverview includes restoreFailures and restoreFailuresCount", () => {
  const tabs = [
    { id: 21, url: "https://example.com", title: "Example" }
  ];
  const restoreFailures = [
    { tabId: 21, targetUrl: "https://example.com", error: "Tab crashed", failedAt: Date.now() }
  ];

  const overview = getDashboardOverview(tabs, [], { restoreFailures });
  assert.equal(overview.restoreFailuresCount, 1);
  assert.ok(Array.isArray(overview.restoreFailures));
  assert.equal(overview.restoreFailures.length, 1);
  assert.equal(overview.restoreFailures[0].tabId, 21);
  assert.equal(overview.restoreFailures[0].error, "Tab crashed");
});

test("canSuspendTab validates tabs, internal URLs, discarded tabs, and active web pages", () => {
  assert.equal(canSuspendTab(null).canSuspend, false);
  assert.equal(canSuspendTab(null).reason, "invalid_tab");
  assert.equal(canSuspendTab({}).canSuspend, false);
  assert.equal(canSuspendTab({}).reason, "no_url");

  // Already suspended tab
  const suspTab = { url: "chrome-extension://xyz/suspended/suspended.html#u=https://example.com" };
  assert.equal(canSuspendTab(suspTab).canSuspend, false);
  assert.equal(canSuspendTab(suspTab).reason, "already_suspended");

  // Discarded tab without url
  assert.equal(canSuspendTab({ discarded: true }).canSuspend, false);
  assert.equal(canSuspendTab({ discarded: true }).reason, "already_suspended");

  // Internal and unsupported URLs
  assert.equal(canSuspendTab({ url: "chrome://extensions" }).canSuspend, false);
  assert.equal(canSuspendTab({ url: "chrome://extensions" }).reason, "internal_url");
  assert.equal(canSuspendTab({ url: "chrome-extension://foo/bar.html" }).canSuspend, false);
  assert.equal(canSuspendTab({ url: "edge://settings" }).canSuspend, false);
  assert.equal(canSuspendTab({ url: "about:blank" }).canSuspend, false);
  assert.equal(canSuspendTab({ url: "file:///C:/test.html" }).canSuspend, false);

  // Normal HTTP/HTTPS web pages
  const validWeb = canSuspendTab({ url: "https://developer.chrome.com/docs" });
  assert.equal(validWeb.canSuspend, true);
  assert.equal(validWeb.reason, undefined);

  const validHttp = canSuspendTab({ url: "http://example.org/articles" });
  assert.equal(validHttp.canSuspend, true);
});

test("getActiveTabs accurately exposes canSuspend for normal and internal tabs", () => {
  const tabs = [
    { id: 101, url: "https://github.com", title: "GitHub", active: false },
    { id: 102, url: "chrome://settings", title: "Settings", active: false },
    { id: 103, url: "https://news.ycombinator.com", title: "Hacker News", active: true }
  ];

  const activeTabs = getActiveTabs(tabs);
  assert.equal(activeTabs.length, 3);

  const ghTab = activeTabs.find(t => t.id === 101);
  assert.ok(ghTab);
  assert.equal(ghTab.canSuspend, true);

  const settingsTab = activeTabs.find(t => t.id === 102);
  assert.ok(settingsTab);
  assert.equal(settingsTab.canSuspend, false);

  const hnTab = activeTabs.find(t => t.id === 103);
  assert.ok(hnTab);
  assert.equal(hnTab.canSuspend, true);
});

test("canRestoreTab validates suspended tabs, discarded tabs, and non-suspended web pages", () => {
  assert.equal(canRestoreTab(null).canRestore, false);
  assert.equal(canRestoreTab(null).reason, "invalid_tab");
  assert.equal(canRestoreTab("string").canRestore, false);

  // Normal active web tabs cannot be restored
  assert.equal(canRestoreTab({ url: "https://example.com" }).canRestore, false);
  assert.equal(canRestoreTab({ url: "https://example.com" }).reason, "not_suspended");
  assert.equal(canRestoreTab({ url: "chrome://settings" }).canRestore, false);

  // Suspended tabs can be restored
  const susp1 = { url: "chrome-extension://xyz/suspended/suspended.html#u=https://example.com" };
  assert.equal(canRestoreTab(susp1).canRestore, true);
  assert.equal(canRestoreTab(susp1).reason, undefined);

  const suspPending = { pendingUrl: "chrome-extension://xyz/suspended/suspended.html#u=https://example.com" };
  assert.equal(canRestoreTab(suspPending).canRestore, true);

  // Discarded tabs without URL
  assert.equal(canRestoreTab({ discarded: true }).canRestore, true);

  // Custom prefix matching
  assert.equal(canRestoreTab({ url: "custom-prefix://tab" }, "custom-prefix://").canRestore, true);
});

test("getSuspendedTabs accurately sets canRestore on suspended tabs", () => {
  const tabs = [
    { id: 201, url: "chrome-extension://xyz/suspended/suspended.html#u=https://example.com", title: "Example" },
    { id: 202, discarded: true, title: "Discarded" },
    { id: 203, url: "https://normal.com", title: "Normal" }
  ];

  const suspended = getSuspendedTabs(tabs);
  assert.equal(suspended.length, 2);
  assert.equal(suspended[0].canRestore, true);
  assert.equal(suspended[1].canRestore, true);
});

test("getEligibleTabsToSuspend filters protected, active, internal, and suspended tabs", () => {
  const now = 1700000000000;
  const tabs = [
    { id: 1, url: "https://github.com", title: "GitHub", active: false, lastAccessed: now - 300000 },
    { id: 2, url: "https://example.com/pinned", title: "Pinned", active: false, pinned: true },
    { id: 3, url: "https://youtube.com/watch", title: "Music", active: false, audible: true },
    { id: 4, url: "chrome://extensions", title: "Extensions", active: false },
    { id: 5, url: "chrome-extension://xyz/suspended/suspended.html#u=https://example.com", title: "Suspended" },
    { id: 6, url: "https://news.ycombinator.com", title: "HN", active: true },
    { id: 7, url: "https://example.org/docs", title: "Docs", active: false, lastAccessed: now - 600000 }
  ];

  const settings = {
    neverSuspend: {
      pinned: true,
      audible: true,
      activeInAnyWindow: true
    }
  };

  const eligible = getEligibleTabsToSuspend(tabs, [], { settings, now });
  assert.equal(eligible.length, 2);
  assert.deepEqual(eligible.map(t => t.id).sort(), [1, 7]);

  const count = countEligibleTabs(tabs, [], { settings, now });
  assert.equal(count, 2);

  // Null/empty resilience
  assert.equal(getEligibleTabsToSuspend(null).length, 0);
  assert.equal(countEligibleTabs([]), 0);
});

test("getDashboardOverview exposes eligibleCount accurately", () => {
  const now = 1700000000000;
  const tabs = [
    { id: 11, url: "https://example.com/1", title: "Page 1", active: false, lastAccessed: now - 200000 },
    { id: 12, url: "https://example.com/2", title: "Page 2", active: true },
    { id: 13, url: "chrome-extension://xyz/suspended/suspended.html#u=https://example.com", title: "Suspended" }
  ];

  const settings = {
    neverSuspend: { activeInAnyWindow: true }
  };

  const overview = getDashboardOverview(tabs, [], { settings, now });
  assert.equal(overview.totalTabs, 3);
  assert.equal(overview.activeCount, 2);
  assert.equal(overview.suspendedCount, 1);
  assert.equal(overview.eligibleCount, 1);
});

test("getSuspendedTabsToRestore and countSuspendedTabs identify and count suspended tabs", () => {
  const tabs = [
    { id: 1, url: "https://example.com", title: "Active" },
    { id: 2, url: "chrome-extension://xyz/suspended/suspended.html#u=https://example.com/1", title: "Suspended 1" },
    { id: 3, discarded: true, url: "", title: "Discarded" },
    { id: 4, url: "chrome://settings", title: "Settings" },
    { id: 5, pendingUrl: "chrome-extension://xyz/suspended/suspended.html", title: "Pending Suspended" }
  ];

  const suspended = getSuspendedTabsToRestore(tabs);
  assert.equal(suspended.length, 3);
  assert.deepEqual(suspended.map(t => t.id).sort(), [2, 3, 5]);

  const count = countSuspendedTabs(tabs);
  assert.equal(count, 3);

  // Custom prefix context support
  const customTabs = [
    { id: 10, url: "custom-suspend://page" },
    { id: 20, url: "https://google.com" }
  ];
  assert.equal(getSuspendedTabsToRestore(customTabs, { suspendedPrefix: "custom-suspend://" }).length, 1);
  assert.equal(countSuspendedTabs(customTabs, { suspendedPrefix: "custom-suspend://" }), 1);

  // Empty and null handling
  assert.equal(getSuspendedTabsToRestore(null).length, 0);
  assert.equal(getSuspendedTabsToRestore([]).length, 0);
  assert.equal(countSuspendedTabs(null), 0);
  assert.equal(countSuspendedTabs([]), 0);
});

test("isDomainExcluded accurately matches domains, subdomains, and wildcard rules", () => {
  const whitelist = [
    { target: "url", mode: "domain", value: "github.com", enabled: true },
    { target: "url", mode: "domain", value: "reddit.com", enabled: false },
    { target: "url", mode: "exact", value: "https://news.ycombinator.com/item?id=1", enabled: true },
    "*.stackoverflow.com"
  ];

  // Exact domain matches
  assert.equal(isDomainExcluded("github.com", whitelist), true);
  assert.equal(isDomainExcluded("https://github.com/my-org/repo", whitelist), true);
  assert.equal(isDomainExcluded("gist.github.com", whitelist), true);
  assert.equal(isDomainExcluded("sub.gist.github.com", whitelist), true);

  // Wildcard and string format
  assert.equal(isDomainExcluded("stackoverflow.com", whitelist), true);
  assert.equal(isDomainExcluded("meta.stackoverflow.com", whitelist), true);

  // Exact mode
  assert.equal(isDomainExcluded("https://news.ycombinator.com/item?id=1", whitelist), true);
  assert.equal(isDomainExcluded("https://news.ycombinator.com/other", whitelist), false);

  // Disabled rule
  assert.equal(isDomainExcluded("reddit.com", whitelist), false);

  // Unrelated domains
  assert.equal(isDomainExcluded("gitlab.com", whitelist), false);
  assert.equal(isDomainExcluded("fakegithub.com", whitelist), false);

  // Internal schemes are not considered excluded web domains
  assert.equal(isDomainExcluded("chrome://extensions", whitelist), false);
  assert.equal(isDomainExcluded("about:blank", whitelist), false);

  // Edge cases
  assert.equal(isDomainExcluded("", whitelist), false);
  assert.equal(isDomainExcluded(null, whitelist), false);
  assert.equal(isDomainExcluded("github.com", null), false);
  assert.equal(isDomainExcluded("github.com", []), false);
});

test("excludeDomain, unexcludeDomain, and toggleExcludeDomain mutate rules safely", () => {
  const initial = [
    { target: "url", mode: "domain", value: "existing.com", enabled: true }
  ];

  // excludeDomain adds a domain
  const afterAdd = excludeDomain(initial, "github.com");
  assert.equal(afterAdd.length, 2);
  assert.equal(afterAdd[1].value, "github.com");
  assert.equal(afterAdd[1].mode, "domain");
  assert.equal(afterAdd[1].enabled, true);

  // excludeDomain deduplicates
  const afterDup = excludeDomain(afterAdd, "https://github.com/features");
  assert.equal(afterDup.length, 2);

  // unexcludeDomain removes domain
  const afterRemove = unexcludeDomain(afterAdd, "existing.com");
  assert.equal(afterRemove.length, 1);
  assert.equal(afterRemove[0].value, "github.com");

  // unexcludeDomain handles URL format
  const afterRemoveUrl = unexcludeDomain(afterRemove, "https://github.com/issues");
  assert.equal(afterRemoveUrl.length, 0);

  // toggleExcludeDomain adds when absent
  const res1 = toggleExcludeDomain([], "nytimes.com");
  assert.equal(res1.isExcluded, true);
  assert.equal(res1.domain, "nytimes.com");
  assert.equal(res1.whitelist.length, 1);

  // toggleExcludeDomain removes when present
  const res2 = toggleExcludeDomain(res1.whitelist, "nytimes.com");
  assert.equal(res2.isExcluded, false);
  assert.equal(res2.domain, "nytimes.com");
  assert.equal(res2.whitelist.length, 0);

  // Invalid / internal schemes ignored
  assert.deepEqual(excludeDomain([], "chrome://settings"), []);
  assert.deepEqual(excludeDomain([], ""), []);
});

test("getActiveTabs and getSuspendedTabs enrich isDomainExcluded flag", () => {
  const settings = {
    whitelist: [
      { target: "url", mode: "domain", value: "github.com", enabled: true }
    ],
    neverSuspend: {}
  };

  const activeTabs = [
    { id: 101, url: "https://github.com/trending", title: "GitHub Trending", active: false },
    { id: 102, url: "https://wikipedia.org", title: "Wikipedia", active: false }
  ];
  const activeRes = getActiveTabs(activeTabs, [], { settings });
  const ghTab = activeRes.find(t => t.id === 101);
  const wikiTab = activeRes.find(t => t.id === 102);
  assert.equal(ghTab.isDomainExcluded, true);
  assert.equal(wikiTab.isDomainExcluded, false);

  const suspendedTabs = [
    { id: 201, url: "chrome-extension://xyz/suspended/suspended.html?url=https%3A%2F%2Fgithub.com%2Ffeatures", title: "GitHub Features" },
    { id: 202, url: "chrome-extension://xyz/suspended/suspended.html?url=https%3A%2F%2Fexample.com", title: "Example" }
  ];
  const suspRes = getSuspendedTabs(suspendedTabs, [], { settings });
  const ghSusp = suspRes.find(t => t.id === 201);
  const exSusp = suspRes.find(t => t.id === 202);
  assert.equal(ghSusp.isDomainExcluded, true);
  assert.equal(exSusp.isDomainExcluded, false);
});

test("isTabManuallyProtected correctly checks Set, Array, and edge cases", () => {
  const set = new Set([10, 20, 30]);
  assert.equal(isTabManuallyProtected(10, set), true);
  assert.equal(isTabManuallyProtected(99, set), false);

  const arr = [101, 102];
  assert.equal(isTabManuallyProtected(101, arr), true);
  assert.equal(isTabManuallyProtected(999, arr), false);

  assert.equal(isTabManuallyProtected(10, null), false);
  assert.equal(isTabManuallyProtected(null, set), false);
  assert.equal(isTabManuallyProtected("10", set), false);
});

test("getActiveTabs and eligible tabs respect manual tab protection", () => {
  const tabs = [
    { id: 1, url: "https://example.com/1", title: "Tab 1", active: false },
    { id: 2, url: "https://example.com/2", title: "Tab 2", active: false },
    { id: 3, url: "https://example.com/3", title: "Tab 3", active: false, isManuallyProtected: true }
  ];

  const protectedTabIds = new Set([2]);
  const activeRes = getActiveTabs(tabs, [], { protectedTabIds });

  const tab1 = activeRes.find(t => t.id === 1);
  const tab2 = activeRes.find(t => t.id === 2);
  const tab3 = activeRes.find(t => t.id === 3);

  assert.equal(tab1.isProtected, false);
  assert.equal(tab1.isManuallyProtected, false);
  assert.equal(tab1.isEligible, true);

  assert.equal(tab2.isProtected, true);
  assert.equal(tab2.isManuallyProtected, true);
  assert.equal(tab2.isEligible, false);
  assert.ok(tab2.protectionReasons.includes("manual_pin"));

  assert.equal(tab3.isProtected, true);
  assert.equal(tab3.isManuallyProtected, true);
  assert.equal(tab3.isEligible, false);

  const eligible = getEligibleTabsToSuspend(tabs, [], { protectedTabIds });
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].id, 1);

  const eligibleCount = countEligibleTabs(tabs, [], { protectedTabIds });
  assert.equal(eligibleCount, 1);
});

test("formatSnapshotDetails validates null/invalid snapshots safely", () => {
  assert.equal(formatSnapshotDetails(null), null);
  assert.equal(formatSnapshotDetails(undefined), null);
  assert.equal(formatSnapshotDetails("not an object"), null);
  assert.equal(formatSnapshotDetails(42), null);
});

test("formatSnapshotDetails transforms full snapshot record into modal presentation schema", () => {
  const now = 1700000000000;
  const snapshot = {
    id: "snap_101_1699999000000_abc",
    tabId: 101,
    url: "https://developer.mozilla.org/en-US/docs/Web/API",
    title: "Web APIs | MDN",
    favicon: "https://developer.mozilla.org/favicon.ico",
    timestamp: now - 60000,
    reason: "idle_timeout",
    scroll: {
      x: 0,
      y: 420,
      percentY: 35
    },
    forms: [
      { name: "search", value: "fetch api" },
      { id: "filter", value: "all" }
    ],
    screenshot: {
      dataUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBD...",
      width: 1280,
      height: 720
    },
    adapter: {
      adapterId: "mdn-docs",
      name: "MDN Documentation",
      activeSection: "fetch"
    }
  };

  const details = formatSnapshotDetails(snapshot, now);
  assert.ok(details);
  assert.equal(details.id, "snap_101_1699999000000_abc");
  assert.equal(details.tabId, 101);
  assert.equal(details.url, "https://developer.mozilla.org/en-US/docs/Web/API");
  assert.equal(details.domain, "developer.mozilla.org");
  assert.equal(details.title, "Web APIs | MDN");
  assert.equal(details.favicon, "https://developer.mozilla.org/favicon.ico");
  assert.equal(details.reason, "idle_timeout");
  assert.equal(details.reasonLabel, "Idle timeout");
  assert.equal(details.timeRelative, "1m ago");

  // Scroll
  assert.equal(details.scroll.x, 0);
  assert.equal(details.scroll.y, 420);
  assert.equal(details.scroll.percentY, 35);
  assert.equal(details.scroll.formatted, "X: 0px, Y: 420px (35%)");

  // Forms
  assert.equal(details.forms.count, 2);
  assert.equal(details.forms.formatted, "2 safe fields");
  assert.equal(details.forms.fields.length, 2);

  // Screenshot
  assert.equal(details.screenshot.hasScreenshot, true);
  assert.equal(details.screenshot.dataUrl, "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBD...");

  // Adapter
  assert.equal(details.adapter.hasAdapter, true);
  assert.equal(details.adapter.label, "mdn-docs");
});

test("formatSnapshotDetails handles top-of-page scroll, string screenshot dataUrl, and fallback cards", () => {
  const now = 1700000000000;
  const snapWithFallback = {
    id: "snap_top",
    tabId: 202,
    url: "https://example.com",
    title: "Example",
    timestamp: now,
    reason: "memory_pressure",
    scroll: { x: 0, y: 0 },
    forms: [],
    screenshot: {
      fallbackCard: {
        reason: "Page is internal or uncapturable"
      }
    }
  };

  const details = formatSnapshotDetails(snapWithFallback, now);
  assert.ok(details);
  assert.equal(details.scroll.formatted, "Top of page");
  assert.equal(details.forms.formatted, "0 safe fields");
  assert.equal(details.screenshot.hasScreenshot, false);
  assert.equal(details.screenshot.fallbackReason, "Page is internal or uncapturable");
  assert.equal(details.reasonLabel, "Memory pressure");
  assert.equal(details.adapter.hasAdapter, false);

  // Snapshot with direct data URL string
  const snapWithStringScreenshot = {
    id: "snap_str",
    tabId: 303,
    url: "https://example.org",
    screenshot: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
  };
  const stringDetails = formatSnapshotDetails(snapWithStringScreenshot, now);
  assert.equal(stringDetails.screenshot.hasScreenshot, true);
  assert.equal(stringDetails.screenshot.dataUrl, "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...");
});

test("deleteSnapshotRecord safely handles missing store and delegates to store methods", async () => {
  assert.deepEqual(await deleteSnapshotRecord(null), { ok: false, deleted: false, error: "No snapshot store provided" });

  // Mock store
  const deletedIds = [];
  const deletedTabIds = [];
  const mockStore = {
    async deleteSnapshot(id, options) {
      deletedIds.push({ id, options });
      return true;
    },
    async deleteSnapshotsForTab(tabId, options) {
      deletedTabIds.push({ tabId, options });
      return true;
    }
  };

  const res1 = await deleteSnapshotRecord(mockStore, { snapshotId: "snap_1", force: true });
  assert.equal(res1.ok, true);
  assert.equal(res1.deleted, true);
  assert.equal(deletedIds.length, 1);
  assert.equal(deletedIds[0].id, "snap_1");
  assert.equal(deletedIds[0].options.respectProtection, false);

  const res2 = await deleteSnapshotRecord(mockStore, { tabId: 101, force: false });
  assert.equal(res2.ok, true);
  assert.equal(res2.deleted, true);
  assert.equal(deletedTabIds.length, 1);
  assert.equal(deletedTabIds[0].tabId, 101);
  assert.equal(deletedTabIds[0].options.respectProtection, true);
});

test("sanitizeSessionTab unwraps suspended placeholder URLs and validates properties", () => {
  assert.equal(sanitizeSessionTab(null), null);
  assert.equal(sanitizeSessionTab({}), null);
  assert.equal(sanitizeSessionTab({ url: "   " }), null);

  const plain = sanitizeSessionTab({
    url: "https://developer.mozilla.org/en-US/",
    title: "MDN Web Docs",
    favIconUrl: "https://developer.mozilla.org/favicon.ico",
    pinned: true,
    groupId: 5,
    groupTitle: "Docs"
  });
  assert.equal(plain.url, "https://developer.mozilla.org/en-US/");
  assert.equal(plain.title, "MDN Web Docs");
  assert.equal(plain.pinned, true);
  assert.equal(plain.groupId, 5);
  assert.equal(plain.groupTitle, "Docs");

  const suspended = sanitizeSessionTab({
    url: "chrome-extension://xyz/suspended/suspended.html#u=https%3A%2F%2Fgithub.com%2Ftrending&t=Trending%20Repos",
    title: "Trending Repos",
    pinned: false
  });
  assert.equal(suspended.url, "https://github.com/trending");
  assert.equal(suspended.title, "Trending Repos");
});

test("serializeSession exports valid session payload with metadata", () => {
  const session = {
    name: "Research Session",
    savedAt: 1700000000000,
    tabs: [
      { url: "https://github.com", title: "GitHub" },
      { url: "https://news.ycombinator.com", title: "Hacker News" }
    ]
  };

  const payload = serializeSession(session, { customNote: "export test" });
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.format, "tabvault-session");
  assert.equal(payload.session.name, "Research Session");
  assert.equal(payload.session.savedAt, 1700000000000);
  assert.equal(payload.session.tabCount, 2);
  assert.equal(payload.session.tabs.length, 2);
  assert.equal(payload.session.tabs[0].url, "https://github.com");
  assert.equal(payload.metadata.extension, "TabVault");
  assert.equal(payload.metadata.customNote, "export test");
});

test("serializeAllSessions bundles multiple sessions into a combined export", () => {
  const sessions = [
    {
      name: "Session 1",
      savedAt: 1700000000000,
      tabs: [{ url: "https://example.com/1", title: "Tab 1" }]
    },
    {
      name: "Session 2",
      savedAt: 1700001000000,
      tabs: [
        { url: "https://example.com/2", title: "Tab 2" },
        { url: "https://example.com/3", title: "Tab 3" }
      ]
    }
  ];

  const bundle = serializeAllSessions(sessions);
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.format, "tabvault-all-sessions");
  assert.equal(bundle.totalSessions, 2);
  assert.equal(bundle.totalTabs, 3);
  assert.equal(bundle.sessions.length, 2);
  assert.equal(bundle.sessions[0].name, "Session 1");
  assert.equal(bundle.sessions[1].name, "Session 2");
});

test("parseAndValidateSession validates exported session payloads and rejects invalid inputs", () => {
  assert.equal(parseAndValidateSession(null).ok, false);
  assert.equal(parseAndValidateSession("").ok, false);
  assert.equal(parseAndValidateSession("{ bad json }").ok, false);

  // Single session payload
  const singlePayload = serializeSession({
    name: "Valid Session",
    savedAt: 1700000000000,
    tabs: [{ url: "https://wikipedia.org", title: "Wikipedia" }]
  });
  const resSingle = parseAndValidateSession(JSON.stringify(singlePayload));
  assert.equal(resSingle.ok, true);
  assert.equal(resSingle.sessions.length, 1);
  assert.equal(resSingle.sessions[0].name, "Valid Session");
  assert.equal(resSingle.sessions[0].tabs.length, 1);
  assert.equal(resSingle.sessions[0].tabs[0].url, "https://wikipedia.org");

  // Bundle payload
  const bundlePayload = serializeAllSessions([
    { name: "S1", tabs: [{ url: "https://site1.com" }] },
    { name: "S2", tabs: [{ url: "https://site2.com" }] }
  ]);
  const resBundle = parseAndValidateSession(bundlePayload);
  assert.equal(resBundle.ok, true);
  assert.equal(resBundle.sessions.length, 2);

  // Raw array format
  const rawArray = [
    { name: "Raw", tabs: [{ url: "https://raw.com", title: "Raw Tab" }] }
  ];
  const resRaw = parseAndValidateSession(rawArray);
  assert.equal(resRaw.ok, true);
  assert.equal(resRaw.sessions[0].name, "Raw");
});

test("mergeSessions merges sessions according to conflict strategies", () => {
  const existing = [
    { name: "Work", tabs: [{ url: "https://work.com" }] },
    { name: "Personal", tabs: [{ url: "https://personal.com" }] }
  ];

  const incoming = [
    { name: "Personal", tabs: [{ url: "https://personal-updated.com" }] },
    { name: "Research", tabs: [{ url: "https://research.com" }] }
  ];

  // Default / "append" strategy
  const appendRes = mergeSessions(existing, incoming);
  assert.equal(appendRes.sessions.length, 4);
  assert.equal(appendRes.addedCount, 2);
  assert.equal(appendRes.replacedCount, 0);
  assert.equal(appendRes.skippedCount, 0);

  // "skip_duplicates" strategy
  const skipRes = mergeSessions(existing, incoming, { conflictStrategy: "skip_duplicates" });
  assert.equal(skipRes.sessions.length, 3);
  assert.equal(skipRes.addedCount, 1);
  assert.equal(skipRes.skippedCount, 1);
  assert.equal(skipRes.replacedCount, 0);
  assert.equal(skipRes.sessions[1].tabs[0].url, "https://personal.com"); // untouched

  // "merge" strategy (overwrites existing matching by name)
  const mergeRes = mergeSessions(existing, incoming, { conflictStrategy: "merge" });
  assert.equal(mergeRes.sessions.length, 3);
  assert.equal(mergeRes.addedCount, 1);
  assert.equal(mergeRes.replacedCount, 1);
  assert.equal(mergeRes.skippedCount, 0);
  assert.equal(mergeRes.sessions[1].tabs[0].url, "https://personal-updated.com"); // replaced

  // "replace" strategy (overwrites entire list)
  const replaceRes = mergeSessions(existing, incoming, { conflictStrategy: "replace" });
  assert.equal(replaceRes.sessions.length, 2);
  assert.equal(replaceRes.addedCount, 2);
  assert.equal(replaceRes.replacedCount, 2);
  assert.equal(replaceRes.sessions[0].name, "Personal");
  assert.equal(replaceRes.sessions[1].name, "Research");
});


