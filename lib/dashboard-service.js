/**
 * TabVault — Dashboard Service
 * Business logic for tab discovery, grouping, status aggregation,
 * and memory metrics for the TabVault Dashboard.
 */

import { estimateTabMemoryMb } from "./memory-budget.js";
import {
  calculateTabSuspensionScore,
  evaluateTabProtection,
  determinePriorityLevel,
  getPriorityLevelLabel,
  getPriorityLevelColor,
  isInternalOrUnsupportedUrl
} from "./scoring.js";

/**
 * Standard pattern for suspended tab URLs.
 */
export const SUSPENDED_URL_PATTERN = /suspended\/suspended\.html/i;

/**
 * Checks if a tab is currently suspended.
 * @param {object} tab Chrome tab object
 * @param {string} [suspendedPrefix] Optional prefix for suspended page
 * @returns {boolean}
 */
export function isSuspendedTab(tab, suspendedPrefix = "") {
  if (!tab) return false;
  const url = tab.url || tab.pendingUrl || "";
  if (suspendedPrefix && url.startsWith(suspendedPrefix)) return true;
  if (SUSPENDED_URL_PATTERN.test(url)) return true;
  if (tab.discarded && !url) return true;
  return false;
}

/**
 * Determines whether a tab can be suspended by a user or by the engine.
 * @param {object} tab Chrome tab object
 * @returns {{ canSuspend: boolean, reason?: string }}
 */
export function canSuspendTab(tab = {}) {
  if (!tab || typeof tab !== "object") {
    return { canSuspend: false, reason: "invalid_tab" };
  }
  if (isSuspendedTab(tab)) {
    return { canSuspend: false, reason: "already_suspended" };
  }
  const url = tab.url || tab.pendingUrl || "";
  if (!url) {
    return { canSuspend: false, reason: "no_url" };
  }
  if (isInternalOrUnsupportedUrl(url)) {
    return { canSuspend: false, reason: "internal_url" };
  }
  return { canSuspend: true };
}

/**
 * Determines whether a tab can be restored by the engine or user.
 * @param {object} tab Chrome tab object
 * @param {string} [suspendedPrefix] Optional prefix for suspended page
 * @returns {{ canRestore: boolean, reason?: string }}
 */
export function canRestoreTab(tab = {}, suspendedPrefix = "") {
  if (!tab || typeof tab !== "object") {
    return { canRestore: false, reason: "invalid_tab" };
  }
  if (!isSuspendedTab(tab, suspendedPrefix)) {
    return { canRestore: false, reason: "not_suspended" };
  }
  return { canRestore: true };
}

/**
 * Formats relative time from a timestamp.
 * @param {number} timestamp Epoch timestamp in milliseconds
 * @param {number} [now=Date.now()] Reference timestamp
 * @returns {string}
 */
export function formatRelativeTime(timestamp, now = Date.now()) {
  if (!timestamp || isNaN(timestamp)) return "unknown";
  const diffSec = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (diffSec < 45) return "just now";
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

/**
 * Formats an elapsed duration in milliseconds into a concise idle string.
 * @param {number} ms
 * @returns {string}
 */
export function formatIdleDuration(ms) {
  const n = Number(ms);
  if (isNaN(n) || n < 1000) return "Active now";
  const diffSec = Math.floor(n / 1000);
  if (diffSec < 60) return `${diffSec}s idle`;
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}m idle`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h idle`;
  const days = Math.floor(hr / 24);
  return `${days}d idle`;
}

/**
 * Formats an epoch timestamp into a readable date-time string.
 * @param {number} timestamp
 * @returns {string}
 */
export function formatTimestamp(timestamp) {
  const n = Number(timestamp);
  if (!n || isNaN(n)) return "unknown";
  try {
    const d = new Date(n);
    if (isNaN(d.getTime())) return "unknown";
    return d.toLocaleString();
  } catch (_) {
    return "unknown";
  }
}


/**
 * Formats megabytes into human-readable memory string.
 * @param {number} mb Megabytes
 * @returns {string}
 */
export function formatMemoryMb(mb) {
  const n = Number(mb) || 0;
  if (n >= 1024) {
    return `${(n / 1024).toFixed(1)} GB`;
  }
  return `${Math.round(n)} MB`;
}

/**
 * Safely extracts hostname or domain from a URL.
 * @param {string} url
 * @returns {string}
 */
export function extractDomain(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "chrome-extension:") {
      if (SUSPENDED_URL_PATTERN.test(url)) {
        let raw = parsed.searchParams.get("url") || parsed.searchParams.get("u");
        if (!raw && parsed.hash) {
          try {
            const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ""));
            raw = hashParams.get("u") || hashParams.get("url");
          } catch (_) {}
        }
        if (raw) return extractDomain(raw);
        return "TabVault Suspended";
      }
      return "Extension Page";
    }
    if (parsed.protocol === "chrome:") return `chrome://${parsed.hostname || ""}`;
    return parsed.hostname.replace(/^www\./i, "");
  } catch (_) {
    return url.split("/")[0] || url;
  }
}

export const CHROME_GROUP_COLORS = {
  grey: "#5f6368",
  blue: "#1a73e8",
  red: "#d93025",
  yellow: "#f29900",
  green: "#1e8e3e",
  pink: "#e52592",
  purple: "#9334e6",
  cyan: "#007b83",
  orange: "#e8710a"
};

/**
 * Returns hex color code for Chrome tab group color name.
 * @param {string} colorName
 * @returns {string} Hex color
 */
export function getTabGroupColorCode(colorName) {
  if (!colorName) return CHROME_GROUP_COLORS.grey;
  return CHROME_GROUP_COLORS[String(colorName).toLowerCase()] || CHROME_GROUP_COLORS.grey;
}

/**
 * Extracts and maps tab group lookup map.
 * @param {Array<object>} tabGroups
 * @returns {Map<number, object>}
 */
export function createTabGroupMap(tabGroups = []) {
  const map = new Map();
  if (Array.isArray(tabGroups)) {
    for (const group of tabGroups) {
      if (group && typeof group.id === "number" && group.id > -1) {
        map.set(group.id, {
          id: group.id,
          title: group.title || "",
          color: group.color || "grey",
          colorCode: getTabGroupColorCode(group.color),
          collapsed: !!group.collapsed,
          windowId: group.windowId
        });
      }
    }
  }
  return map;
}

/**
 * Aggregates statistics, active vs suspended tab counts, and estimated RAM savings for all tab groups.
 *
 * @param {Array<object>} tabGroups
 * @param {Array<object>} tabs
 * @param {object} [context={}]
 * @returns {Array<object>}
 */
export function getTabGroupsSummary(tabGroups = [], tabs = [], context = {}) {
  if (!Array.isArray(tabGroups)) return [];
  const suspendedPrefix = context.suspendedPrefix || "";
  const groupStats = new Map();

  for (const g of tabGroups) {
    if (!g || typeof g.id !== "number" || g.id < 0) continue;
    groupStats.set(g.id, {
      id: g.id,
      title: (g.title || "Untitled Group").trim(),
      color: g.color || "grey",
      colorCode: getTabGroupColorCode(g.color),
      collapsed: !!g.collapsed,
      windowId: g.windowId,
      totalTabs: 0,
      activeCount: 0,
      suspendedCount: 0,
      activeMemoryMb: 0,
      savedMemoryMb: 0,
      tabIds: []
    });
  }

  if (Array.isArray(tabs)) {
    for (const tab of tabs) {
      if (!tab || typeof tab.groupId !== "number" || tab.groupId < 0) continue;
      const entry = groupStats.get(tab.groupId);
      if (!entry) continue;

      entry.totalTabs += 1;
      entry.tabIds.push(tab.id);

      const isSusp = isSuspendedTab(tab, suspendedPrefix);
      const parsed = isSusp ? parseSuspendedTabInfo(tab) : null;
      const url = parsed?.url || tab.url || "";
      const mem = estimateTabMemoryMb({ url, title: parsed?.title || tab.title });

      if (isSusp) {
        entry.suspendedCount += 1;
        entry.savedMemoryMb += mem;
      } else {
        entry.activeCount += 1;
        entry.activeMemoryMb += mem;
      }
    }
  }

  return Array.from(groupStats.values()).map(g => ({
    ...g,
    activeMemoryFormatted: formatMemoryMb(g.activeMemoryMb),
    savedMemoryFormatted: formatMemoryMb(g.savedMemoryMb)
  }));
}

/**
 * Resolves snapshot availability and record for a tab across store, map, or metadata.
 * @param {object} tab
 * @param {Map<number, object>|object|null} [snapshotStoreOrMap=null]
 * @param {object|null} [metadataStore=null]
 * @returns {{ hasSnapshot: boolean, snapshot: object|null, snapshotId: string|null }}
 */
export function resolveSnapshotForTab(tab, snapshotStoreOrMap = null, metadataStore = null) {
  if (!tab || typeof tab !== "object") {
    return { hasSnapshot: false, snapshot: null, snapshotId: null };
  }

  const parsed = isSuspendedTab(tab) ? parseSuspendedTabInfo(tab) : null;
  const meta = metadataStore?.get ? metadataStore.get(tab.id) : (tab.meta || null);
  let snapshotId = parsed?.snapshotId || meta?.snapshotId || tab.snapshotId || null;
  let snapshot = null;
  let hasSnapshot = Boolean(snapshotId);

  if (snapshotStoreOrMap) {
    if (snapshotStoreOrMap instanceof Map) {
      if (typeof tab.id === "number" && snapshotStoreOrMap.has(tab.id)) {
        hasSnapshot = true;
        snapshot = snapshotStoreOrMap.get(tab.id);
      } else if (snapshotId && snapshotStoreOrMap.has(snapshotId)) {
        hasSnapshot = true;
        snapshot = snapshotStoreOrMap.get(snapshotId);
      }
    } else if (typeof snapshotStoreOrMap.getLatestSnapshot === "function") {
      try {
        const found = snapshotStoreOrMap.getLatestSnapshot(tab.id);
        if (found) {
          hasSnapshot = true;
          snapshot = found;
        }
      } catch (_) {}
    } else if (typeof snapshotStoreOrMap.hasSnapshot === "function") {
      try {
        if (snapshotStoreOrMap.hasSnapshot(tab.id)) {
          hasSnapshot = true;
        }
      } catch (_) {}
    } else if (typeof snapshotStoreOrMap.has === "function") {
      try {
        if (snapshotStoreOrMap.has(tab.id)) {
          hasSnapshot = true;
        }
      } catch (_) {}
    } else if (typeof snapshotStoreOrMap === "object") {
      if (typeof tab.id === "number" && tab.id in snapshotStoreOrMap) {
        hasSnapshot = true;
        snapshot = snapshotStoreOrMap[tab.id];
      } else if (snapshotId && snapshotId in snapshotStoreOrMap) {
        hasSnapshot = true;
        snapshot = snapshotStoreOrMap[snapshotId];
      }
    }
  }

  if (!snapshotId && snapshot?.id) {
    snapshotId = snapshot.id;
  }

  return { hasSnapshot, snapshot, snapshotId };
}

/**
 * Returns list of active (non-suspended) tabs enriched with metrics and status.
 *
 * @param {Array<object>} tabs Raw tabs from chrome.tabs.query
 * @param {Array<object>} tabGroups Raw groups from chrome.tabGroups.query
 * @param {object} [context={}] Additional context: tabState, metadataStore, options
 * @returns {Array<object>} Enriched active tabs
 */
export function getActiveTabs(tabs = [], tabGroups = [], context = {}) {
  const groupMap = createTabGroupMap(tabGroups);
  const tabState = context.tabState || new Map();
  const metadataStore = context.metadataStore || null;
  const now = context.now || Date.now();
  const suspendedPrefix = context.suspendedPrefix || "";
  const searchQuery = (context.searchQuery || "").trim().toLowerCase();
  const filterWindowId = context.windowId != null ? Number(context.windowId) : null;
  const filterGroupId = context.groupId != null ? Number(context.groupId) : null;

  const result = [];

  for (const tab of tabs) {
    if (!tab || typeof tab.id !== "number") continue;
    if (isSuspendedTab(tab, suspendedPrefix)) continue;

    // Apply window and group filters if specified
    if (filterWindowId != null && tab.windowId !== filterWindowId) continue;
    if (filterGroupId != null && tab.groupId !== filterGroupId) continue;

    const state = tabState instanceof Map ? tabState.get(tab.id) : tabState[tab.id];
    const meta = metadataStore?.get ? metadataStore.get(tab.id) : null;

    const domain = extractDomain(tab.url);
    const title = (tab.title || domain || "Untitled Tab").trim();

    // Search query matching
    if (searchQuery) {
      const matchTitle = title.toLowerCase().includes(searchQuery);
      const matchDomain = domain.toLowerCase().includes(searchQuery);
      const matchUrl = (tab.url || "").toLowerCase().includes(searchQuery);
      if (!matchTitle && !matchDomain && !matchUrl) continue;
    }

    const lastActiveAt = state?.lastActiveAt || meta?.lastVisitedAt || tab.lastAccessed || now;
    const estimatedMemoryMb = estimateTabMemoryMb(tab, meta);

    const isManuallyProtected = isTabManuallyProtected(tab.id, context.protectedTabIds) || !!tab.isManuallyProtected || !!state?.isManuallyProtected;

    const tabWithState = {
      ...tab,
      isManuallyProtected,
      hasFormInput: !!state?.hasFormInput,
      audible: !!(tab.audible || state?.audible)
    };

    // Evaluate protection and suspension scoring
    const protection = evaluateTabProtection(tabWithState, meta, {
      neverSuspend: context.settings?.neverSuspend,
      whitelist: context.settings?.whitelist,
      protectedTabIds: context.protectedTabIds,
      settings: context.settings,
      tabState: state,
      now
    });

    const scoreResult = calculateTabSuspensionScore(tabWithState, meta, {
      settings: context.settings,
      scoreWeights: context.scoreWeights,
      currentMemoryPressure: context.memoryPressure || 0,
      now
    });

    const group = tab.groupId > -1 ? groupMap.get(tab.groupId) || null : null;

    const protectionReasons = [];
    if (protection.reason) protectionReasons.push(protection.reason);
    if (Array.isArray(protection.reasons)) {
      for (const r of protection.reasons) {
        if (!protectionReasons.includes(r)) protectionReasons.push(r);
      }
    }

    // Snapshot availability detection
    const snapStoreOrMap = context.snapshotMap || context.snapshotStore || null;
    const snapInfo = resolveSnapshotForTab(tab, snapStoreOrMap, metadataStore);
    const hasSnapshot = snapInfo.hasSnapshot;
    const snapshotId = snapInfo.snapshotId || null;
    const snapshotTimestamp = snapInfo.snapshot?.timestamp || null;
    const snapshotAgeFormatted = snapshotTimestamp ? formatRelativeTime(snapshotTimestamp, now) : null;

    // Filter by snapshot availability if requested
    const filterSnapshot = (context.filterSnapshot || "").trim().toLowerCase();
    if (filterSnapshot === "with" || filterSnapshot === "has_snapshot") {
      if (!hasSnapshot) continue;
    } else if (filterSnapshot === "without" || filterSnapshot === "no_snapshot") {
      if (hasSnapshot) continue;
    }

    result.push({
      id: tab.id,
      windowId: tab.windowId,
      groupId: tab.groupId,
      group,
      title,
      url: tab.url || "",
      domain,
      favIconUrl: tab.favIconUrl || "",
      active: !!tab.active,
      pinned: !!tab.pinned,
      audible: !!(tab.audible || state?.audible),
      muted: !!tab.mutedInfo?.muted,
      discarded: !!tab.discarded,
      hasFormInput: !!state?.hasFormInput,
      lastActiveAt,
      lastActiveRelative: formatRelativeTime(lastActiveAt, now),
      lastActiveFormatted: formatTimestamp(lastActiveAt),
      idleDurationMs: tab.active ? 0 : Math.max(0, now - lastActiveAt),
      idleDurationFormatted: tab.active ? "Active now" : formatIdleDuration(now - lastActiveAt),
      estimatedMemoryMb,
      estimatedMemoryFormatted: formatMemoryMb(estimatedMemoryMb),
      suspensionScore: scoreResult.score,
      isEligible: scoreResult.isEligible && !protection.isProtected,
      priorityLevel: scoreResult.priorityLevel,
      priorityLabel: getPriorityLevelLabel(scoreResult.priorityLevel),
      priorityColor: getPriorityLevelColor(scoreResult.priorityLevel),
      isProtected: protection.isProtected,
      isManuallyProtected,
      protectionReasons,
      hasSnapshot,
      snapshotId,
      snapshotTimestamp,
      snapshotAgeFormatted,
      canSuspend: canSuspendTab(tab).canSuspend,
      isDomainExcluded: isDomainExcluded(domain, context.settings?.whitelist)
    });
  }

  // Sort: active tabs first, then by lastActiveAt descending (most recently active first)
  const sortBy = context.sortBy || "recency";
  if (sortBy === "recency") {
    result.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || (b.lastActiveAt - a.lastActiveAt));
  } else if (sortBy === "idle") {
    // Longest idle first (active tabs last, then oldest lastActiveAt first)
    result.sort((a, b) => (a.active ? 1 : 0) - (b.active ? 1 : 0) || (a.lastActiveAt - b.lastActiveAt));
  } else if (sortBy === "memory") {
    result.sort((a, b) => b.estimatedMemoryMb - a.estimatedMemoryMb);
  } else if (sortBy === "score") {
    result.sort((a, b) => b.suspensionScore - a.suspensionScore);
  } else if (sortBy === "title") {
    result.sort((a, b) => a.title.localeCompare(b.title));
  }

  return result;
}

/**
 * Resolves all tabs that are currently eligible for automatic or batch suspension.
 *
 * @param {Array<object>} tabs Raw tabs array
 * @param {Array<object>} [tabGroups=[]] Tab groups array
 * @param {object} [context={}] Context containing settings, tabState, metadataStore, etc.
 * @returns {Array<object>} Filtered list of tabs that are eligible to suspend
 */
export function getEligibleTabsToSuspend(tabs = [], tabGroups = [], context = {}) {
  if (!Array.isArray(tabs)) return [];
  const activeTabs = getActiveTabs(tabs, tabGroups, context);
  return activeTabs.filter(tab => tab.isEligible && tab.canSuspend && !tab.isProtected);
}

/**
 * Counts how many tabs are currently eligible to be suspended.
 *
 * @param {Array<object>} tabs Raw tabs array
 * @param {Array<object>} [tabGroups=[]] Tab groups array
 * @param {object} [context={}]
 * @returns {number}
 */
export function countEligibleTabs(tabs = [], tabGroups = [], context = {}) {
  return getEligibleTabsToSuspend(tabs, tabGroups, context).length;
}

/**
 * Resolves all tabs that are currently suspended or discarded and eligible for restoration.
 *
 * @param {Array<object>} tabs Raw tabs array
 * @param {object} [context={}] Optional context with suspendedPrefix
 * @returns {Array<object>} List of suspended tabs
 */
export function getSuspendedTabsToRestore(tabs = [], context = {}) {
  if (!Array.isArray(tabs)) return [];
  const suspendedPrefix = context.suspendedPrefix || "";
  return tabs.filter(tab => isSuspendedTab(tab, suspendedPrefix));
}

/**
 * Counts how many tabs are currently suspended and can be restored.
 *
 * @param {Array<object>} tabs Raw tabs array
 * @param {object} [context={}]
 * @returns {number}
 */
export function countSuspendedTabs(tabs = [], context = {}) {
  return getSuspendedTabsToRestore(tabs, context).length;
}

/**
 * Checks if a domain or URL is currently excluded (whitelisted) from suspension.
 *
 * @param {string} domainOrUrl Domain name or full URL
 * @param {Array<object|string>} [whitelist=[]] Whitelist rules array from settings
 * @returns {boolean}
 */
export function isDomainExcluded(domainOrUrl, whitelist = []) {
  if (!domainOrUrl || typeof domainOrUrl !== "string") return false;
  if (!Array.isArray(whitelist) || whitelist.length === 0) return false;

  let host = domainOrUrl.trim().toLowerCase();
  if (!host) return false;

  // Don't treat internal browser schemes as excludable web domains
  if (host.includes("://") && isInternalOrUnsupportedUrl(host)) {
    return false;
  }

  // Extract hostname if a full URL was provided
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname.toLowerCase();
    } catch (_) {
      const parts = host.split("://")[1]?.split("/")[0]?.split(":")[0];
      host = (parts || "").toLowerCase();
    }
  } else {
    // Strip possible path, port, or wildcard prefix
    host = host.split("/")[0].split(":")[0].replace(/^\*\./, "").toLowerCase();
  }

  if (!host) return false;

  return whitelist.some(rule => {
    if (!rule) return false;
    if (rule.enabled === false) return false;

    // String rule
    if (typeof rule === "string") {
      const val = rule.trim().toLowerCase().replace(/^\*\./, "");
      return val && (host === val || host.endsWith("." + val));
    }

    const mode = rule.mode || "domain";
    const val = (rule.value || "").trim().toLowerCase();
    if (!val) return false;

    if (mode === "domain") {
      const cleanVal = val.replace(/^\*\./, "");
      return host === cleanVal || host.endsWith("." + cleanVal);
    }

    if (mode === "exact") {
      return host === val || domainOrUrl.toLowerCase() === val;
    }

    if (mode === "contains") {
      return host.includes(val) || domainOrUrl.toLowerCase().includes(val);
    }

    if (mode === "regex") {
      try {
        return new RegExp(val).test(host) || new RegExp(val).test(domainOrUrl);
      } catch (_) {
        return false;
      }
    }

    return false;
  });
}

/**
 * Adds a domain to the whitelist rules if not already present.
 *
 * @param {Array<object|string>} [whitelist=[]] Current whitelist
 * @param {string} domain Domain to exclude from suspension
 * @returns {Array<object>} New whitelist array
 */
export function excludeDomain(whitelist = [], domain = "") {
  const current = Array.isArray(whitelist) ? [...whitelist] : [];
  let host = (domain || "").trim().toLowerCase();
  if (!host) return current;

  if (host.includes("://") && isInternalOrUnsupportedUrl(host)) {
    return current;
  }

  if (host.includes("://")) {
    try {
      host = new URL(host).hostname.toLowerCase();
    } catch (_) {
      host = (host.split("://")[1]?.split("/")[0]?.split(":")[0] || "").toLowerCase();
    }
  } else {
    host = host.split("/")[0].split(":")[0].replace(/^\*\./, "").toLowerCase();
  }

  if (!host || host.startsWith("chrome-extension") || host.startsWith("chrome:") || host.startsWith("about:") || host.startsWith("file:")) {
    return current;
  }

  if (isDomainExcluded(host, current)) {
    return current;
  }

  current.push({
    target: "url",
    mode: "domain",
    value: host,
    enabled: true
  });
  return current;
}

/**
 * Removes a domain from the whitelist rules.
 *
 * @param {Array<object|string>} [whitelist=[]] Current whitelist
 * @param {string} domain Domain to remove from exclusion
 * @returns {Array<object>} New whitelist array
 */
export function unexcludeDomain(whitelist = [], domain = "") {
  if (!Array.isArray(whitelist)) return [];
  let host = (domain || "").trim().toLowerCase();
  if (!host) return [...whitelist];

  if (host.includes("://")) {
    try {
      host = new URL(host).hostname.toLowerCase();
    } catch (_) {
      host = (host.split("://")[1]?.split("/")[0]?.split(":")[0] || "").toLowerCase();
    }
  } else {
    host = host.split("/")[0].split(":")[0].replace(/^\*\./, "").toLowerCase();
  }

  if (!host) return [...whitelist];

  return whitelist.filter(rule => {
    if (!rule) return false;
    if (typeof rule === "string") {
      const val = rule.trim().toLowerCase().replace(/^\*\./, "");
      return val !== host;
    }
    const mode = rule.mode || "domain";
    if (mode === "domain") {
      const val = (rule.value || "").trim().toLowerCase().replace(/^\*\./, "");
      return val !== host;
    }
    return true;
  });
}

/**
 * Toggles exclusion state for a given domain.
 *
 * @param {Array<object|string>} [whitelist=[]]
 * @param {string} domain
 * @returns {{ whitelist: Array<object>, isExcluded: boolean, domain: string }}
 */
export function toggleExcludeDomain(whitelist = [], domain = "") {
  let host = (domain || "").trim().toLowerCase();
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname.toLowerCase();
    } catch (_) {
      host = (host.split("://")[1]?.split("/")[0]?.split(":")[0] || "").toLowerCase();
    }
  } else {
    host = host.split("/")[0].split(":")[0].replace(/^\*\./, "").toLowerCase();
  }

  const currentlyExcluded = isDomainExcluded(host, whitelist);
  if (currentlyExcluded) {
    const updated = unexcludeDomain(whitelist, host);
    return { whitelist: updated, isExcluded: false, domain: host };
  } else {
    const updated = excludeDomain(whitelist, host);
    return { whitelist: updated, isExcluded: true, domain: host };
  }
}

/**
 * Checks if a tab ID is in the manually protected set/array.
 *
 * @param {number} tabId
 * @param {Set<number>|Array<number>} [protectedTabIds]
 * @returns {boolean}
 */
export function isTabManuallyProtected(tabId, protectedTabIds = []) {
  if (typeof tabId !== "number") return false;
  if (!protectedTabIds) return false;
  if (protectedTabIds instanceof Set) return protectedTabIds.has(tabId);
  if (Array.isArray(protectedTabIds)) return protectedTabIds.includes(tabId);
  return false;
}

/**
 * Formats a snapshot record into structured details suitable for the UI modal/viewer.
 *
 * @param {object} snapshot
 * @param {number} [now=Date.now()]
 * @returns {object|null}
 */
export function formatSnapshotDetails(snapshot, now = Date.now()) {
  if (!snapshot || typeof snapshot !== "object") return null;

  const timestamp = snapshot.timestamp || snapshot.createdAt || null;
  const ageFormatted = timestamp ? formatRelativeTime(timestamp, now) : "unknown";
  const timestampFormatted = timestamp ? formatTimestamp(timestamp) : "unknown";
  const url = snapshot.url || "";
  const domain = extractDomain(url);
  const title = (snapshot.title || domain || "Untitled Tab").trim();
  const favicon = snapshot.favicon || "";

  // Screenshot
  let hasScreenshot = Boolean(snapshot.screenshot);
  let screenshotData = null;
  let isFallbackCard = false;
  let fallbackCardInfo = null;
  let fallbackReason = "No screenshot preview available";

  if (typeof snapshot.screenshot === "string" && snapshot.screenshot.startsWith("data:image/")) {
    screenshotData = snapshot.screenshot;
    hasScreenshot = true;
  } else if (snapshot.screenshot && typeof snapshot.screenshot === "object") {
    if (snapshot.screenshot.dataUrl && typeof snapshot.screenshot.dataUrl === "string") {
      screenshotData = snapshot.screenshot.dataUrl;
      hasScreenshot = true;
    } else {
      hasScreenshot = false;
    }
    if (snapshot.screenshot.fallbackCard) {
      isFallbackCard = true;
      fallbackReason = snapshot.screenshot.fallbackCard.reason || "Visual fallback card";
    }
    isFallbackCard = isFallbackCard || Boolean(snapshot.screenshot.isFallback);
    fallbackCardInfo = snapshot.screenshot;
  } else {
    hasScreenshot = false;
  }

  // Scroll
  const scroll = snapshot.scroll || {};
  const scrollX = typeof scroll.x === "number" ? Math.round(scroll.x) : 0;
  const scrollY = typeof scroll.y === "number" ? Math.round(scroll.y) : 0;
  const scrollPercentY = typeof scroll.percentageY === "number"
    ? Math.round(scroll.percentageY)
    : (typeof scroll.percentY === "number" ? Math.round(scroll.percentY) : null);
  const hasScroll = scrollX > 0 || scrollY > 0;
  let scrollSummary = "Top of page";
  if (hasScroll) {
    if (scrollPercentY != null && scrollPercentY > 0) {
      scrollSummary = `X: ${scrollX}px, Y: ${scrollY}px (${scrollPercentY}%)`;
    } else {
      scrollSummary = `X: ${scrollX}px, Y: ${scrollY}px`;
    }
  }

  // Forms
  const forms = Array.isArray(snapshot.forms) ? snapshot.forms : [];
  const formCount = forms.length;
  const formSummary = forms.map(f => ({
    name: f.name || f.id || f.selector || "input",
    type: f.type || "text",
    hasValue: Boolean(f.value != null && f.value !== "")
  }));
  const formsFormatted = `${formCount} safe field${formCount === 1 ? "" : "s"}`;

  // Reason
  const rawReason = snapshot.reason || "manual";
  const reasonFormatted = formatSuspensionReason(rawReason);
  const reasonColor = getSuspensionReasonColor(rawReason);

  // Context
  const ctx = snapshot.context || {};
  const isPinned = Boolean(ctx.pinned ?? ctx.isPinned);
  const isAudible = Boolean(ctx.audible ?? ctx.isAudible);

  // Adapter
  const rawAdapter = snapshot.adapter || snapshot.adapterState || null;
  const hasAdapter = Boolean(rawAdapter && (rawAdapter.adapterId || rawAdapter.adapterName || rawAdapter.name || Object.keys(rawAdapter).length > 0));
  const adapterName = rawAdapter?.adapterId || rawAdapter?.adapterName || rawAdapter?.name || (hasAdapter ? "Custom adapter" : null);

  return {
    id: snapshot.id || null,
    tabId: snapshot.tabId || null,
    title,
    url,
    domain,
    favicon,
    timestamp,
    timestampFormatted,
    timeFormatted: timestampFormatted,
    ageFormatted,
    timeRelative: ageFormatted,
    hasScreenshot,
    screenshotData,
    isFallbackCard,
    fallbackCardInfo,
    screenshot: {
      hasScreenshot,
      dataUrl: screenshotData,
      fallbackReason
    },
    hasScroll,
    scrollX,
    scrollY,
    scrollPercentY,
    scrollSummary,
    scroll: {
      x: scrollX,
      y: scrollY,
      percentY: scrollPercentY,
      formatted: scrollSummary
    },
    formCount,
    formSummary,
    forms: {
      count: formCount,
      formatted: formsFormatted,
      fields: forms
    },
    reason: rawReason,
    reasonFormatted,
    reasonLabel: reasonFormatted,
    reasonColor,
    isPinned,
    isAudible,
    adapterName,
    adapterState: rawAdapter,
    adapter: {
      hasAdapter,
      label: adapterName || "None",
      state: rawAdapter
    },
    isManual: Boolean(snapshot.isManual),
    label: snapshot.label || null
  };
}




/**
 * Computes comprehensive memory savings metrics, including current RAM saved,
 * lifetime memory reclaimed, efficiency percentage, and domain breakdown.
 *
 * @param {Array<object>} tabs
 * @param {object} [stats={}]
 * @param {object} [context={}]
 * @returns {object}
 */
export function getMemorySavingsBreakdown(tabs = [], stats = {}, context = {}) {
  const suspendedPrefix = context.suspendedPrefix || "";
  let activeCount = 0;
  let suspendedCount = 0;
  let activeMemoryMb = 0;
  let currentSavedMb = 0;
  const domainMap = new Map();

  for (const tab of tabs) {
    if (!tab) continue;
    const isSusp = isSuspendedTab(tab, suspendedPrefix);
    const parsed = isSusp ? parseSuspendedTabInfo(tab) : null;
    const url = parsed?.url || tab.url || "";
    const domain = extractDomain(url) || "other";
    const mem = estimateTabMemoryMb({ url, title: parsed?.title || tab.title });

    if (isSusp) {
      suspendedCount++;
      currentSavedMb += mem;

      const curr = domainMap.get(domain) || { domain, memoryMb: 0, tabCount: 0 };
      curr.memoryMb += mem;
      curr.tabCount += 1;
      domainMap.set(domain, curr);
    } else {
      activeCount++;
      activeMemoryMb += mem;
    }
  }

  const lifetimeBytes = Number(stats?.estimatedBytesSaved) || 0;
  const lifetimeMb = Math.round(lifetimeBytes / (1024 * 1024));

  const totalTabMemoryMb = activeMemoryMb + currentSavedMb;
  const savingsPercentage = totalTabMemoryMb > 0
    ? Math.round((currentSavedMb / totalTabMemoryMb) * 100)
    : 0;

  const averageSavedPerTabMb = suspendedCount > 0
    ? Math.round(currentSavedMb / suspendedCount)
    : 0;

  const topDomainSavings = Array.from(domainMap.values())
    .map(d => ({
      domain: d.domain,
      memorySavedMb: Math.round(d.memoryMb),
      memorySavedFormatted: formatMemoryMb(d.memoryMb),
      tabCount: d.tabCount
    }))
    .sort((a, b) => b.memorySavedMb - a.memorySavedMb)
    .slice(0, 10);

  return {
    currentSavedMb: Math.round(currentSavedMb),
    currentSavedFormatted: formatMemoryMb(currentSavedMb),
    activeMemoryMb: Math.round(activeMemoryMb),
    activeMemoryFormatted: formatMemoryMb(activeMemoryMb),
    totalTabMemoryMb: Math.round(totalTabMemoryMb),
    totalTabMemoryFormatted: formatMemoryMb(totalTabMemoryMb),
    lifetimeMb,
    lifetimeFormatted: formatMemoryMb(lifetimeMb),
    savingsPercentage,
    averageSavedPerTabMb,
    averageSavedPerTabFormatted: formatMemoryMb(averageSavedPerTabMb),
    suspendedCount,
    activeCount,
    topDomainSavings
  };
}

/**
 * Computes snapshot availability metrics across active and suspended tabs.
 *
 * @param {Array<object>} tabs Raw tabs array
 * @param {Map<number, object>|object|null} [snapshotStoreOrMap=null] SnapshotStore instance or Map of tabId -> snapshot
 * @param {object} [context={}] Additional options like metadataStore, suspendedPrefix
 * @returns {object} Snapshot availability metrics
 */
export function getSnapshotAvailability(tabs = [], snapshotStoreOrMap = null, context = {}) {
  const suspendedPrefix = context.suspendedPrefix || "";
  const metadataStore = context.metadataStore || null;
  const list = Array.isArray(tabs) ? tabs : [];

  let activeTabsCount = 0;
  let suspendedTabsCount = 0;
  let tabsWithSnapshots = 0;
  let suspendedWithSnapshots = 0;
  let activeWithSnapshots = 0;

  for (const tab of list) {
    if (!tab || typeof tab.id !== "number") continue;
    const isSusp = isSuspendedTab(tab, suspendedPrefix);
    const resolved = resolveSnapshotForTab(tab, snapshotStoreOrMap, metadataStore);

    if (isSusp) {
      suspendedTabsCount++;
      if (resolved.hasSnapshot) {
        suspendedWithSnapshots++;
        tabsWithSnapshots++;
      }
    } else {
      activeTabsCount++;
      if (resolved.hasSnapshot) {
        activeWithSnapshots++;
        tabsWithSnapshots++;
      }
    }
  }

  const suspendedWithoutSnapshots = Math.max(0, suspendedTabsCount - suspendedWithSnapshots);
  const activeWithoutSnapshots = Math.max(0, activeTabsCount - activeWithSnapshots);

  const suspendedCoveragePercentage = suspendedTabsCount > 0
    ? Math.round((suspendedWithSnapshots / suspendedTabsCount) * 100)
    : 100;

  const totalCoveragePercentage = list.length > 0
    ? Math.round((tabsWithSnapshots / list.length) * 100)
    : 100;

  const activeCoveragePercentage = activeTabsCount > 0
    ? Math.round((activeWithSnapshots / activeTabsCount) * 100)
    : 0;

  let totalKnownSnapshots = 0;
  if (snapshotStoreOrMap instanceof Map) {
    totalKnownSnapshots = snapshotStoreOrMap.size;
  } else if (snapshotStoreOrMap && typeof snapshotStoreOrMap === "object") {
    totalKnownSnapshots = Object.keys(snapshotStoreOrMap).length;
  }

  return {
    totalTabs: list.length,
    activeTabsCount,
    suspendedTabsCount,
    tabsWithSnapshots,
    suspendedWithSnapshots,
    suspendedWithoutSnapshots,
    activeWithSnapshots,
    activeWithoutSnapshots,
    suspendedCoveragePercentage,
    totalCoveragePercentage,
    activeCoveragePercentage,
    hasAnySnapshots: tabsWithSnapshots > 0 || totalKnownSnapshots > 0,
    totalKnownSnapshots
  };
}

/**
 * Returns overall dashboard overview numbers.
 * @param {Array<object>} tabs
 * @param {Array<object>} tabGroups
 * @param {object} [context={}]
 * @returns {object} Overview metrics
 */
export function getDashboardOverview(tabs = [], tabGroups = [], context = {}) {
  const suspendedPrefix = context.suspendedPrefix || "";
  const stats = context.stats || {};
  const breakdown = getMemorySavingsBreakdown(tabs, stats, { suspendedPrefix });
  const snapshotAvailability = getSnapshotAvailability(
    tabs,
    context.snapshotStore || context.snapshotMap,
    { suspendedPrefix, metadataStore: context.metadataStore }
  );

  return {
    totalTabs: tabs.length,
    activeCount: breakdown.activeCount,
    suspendedCount: breakdown.suspendedCount,
    eligibleCount: countEligibleTabs(tabs, tabGroups, context),
    tabGroupCount: Array.isArray(tabGroups) ? tabGroups.length : 0,
    totalActiveMemoryMb: breakdown.activeMemoryMb,
    totalActiveMemoryFormatted: breakdown.activeMemoryFormatted,
    totalMemorySavedMb: breakdown.currentSavedMb,
    totalMemorySavedFormatted: breakdown.currentSavedFormatted,
    lifetimeMemorySavedMb: breakdown.lifetimeMb,
    lifetimeMemorySavedFormatted: breakdown.lifetimeFormatted,
    savingsPercentage: breakdown.savingsPercentage,
    averageSavedPerTabMb: breakdown.averageSavedPerTabMb,
    averageSavedPerTabFormatted: breakdown.averageSavedPerTabFormatted,
    topDomainSavings: breakdown.topDomainSavings,
    reasonsBreakdown: getSuspensionReasonsBreakdown(
      getSuspendedTabs(tabs, tabGroups, {
        suspendedPrefix,
        snapshotStore: context.snapshotStore,
        snapshotMap: context.snapshotMap
      })
    ),
    groups: getTabGroupsSummary(tabGroups, tabs, { suspendedPrefix }),
    snapshotAvailability,
    restoreFailures: getRestoreFailures(context.restoreFailures || [], tabs, {
      now: context.now,
      limit: 10
    }),
    restoreFailuresCount: Array.isArray(context.restoreFailures) ? context.restoreFailures.length : 0
  };
}

/**
 * Formats machine-readable suspension reasons into user-friendly display labels.
 * @param {string} r
 * @returns {string}
 */
export function formatSuspensionReason(r) {
  if (!r) return "Idle timeout";
  const lower = String(r).toLowerCase();
  if (lower.includes("idle")) return "Idle timeout";
  if (lower.includes("memory")) return "Memory pressure";
  if (lower.includes("domain")) return "Domain rule";
  if (lower.includes("manual")) return "Manual suspension";
  if (lower.includes("battery")) return "Battery saver";
  if (lower.includes("window")) return "Window blur";
  if (lower.includes("snooze")) return "Scheduled snooze";
  if (lower.includes("startup")) return "Browser startup";
  if (lower.includes("limit") || lower.includes("max_tabs")) return "Tab limit reached";
  if (lower.includes("audio") || lower.includes("media")) return "Media playback ended";
  if (lower.includes("discard")) return "Native discard";
  return String(r).replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Returns distinct theme color associated with a suspension reason.
 * @param {string} r
 * @returns {string} Hex color
 */
export function getSuspensionReasonColor(r) {
  if (!r) return "#61afef";
  const lower = String(r).toLowerCase();
  if (lower.includes("idle")) return "#61afef";
  if (lower.includes("memory")) return "#e06c75";
  if (lower.includes("domain")) return "#c678dd";
  if (lower.includes("manual")) return "#98c379";
  if (lower.includes("battery")) return "#e5c07b";
  if (lower.includes("window")) return "#d19a66";
  if (lower.includes("snooze")) return "#56b6c2";
  if (lower.includes("startup")) return "#abb2bf";
  if (lower.includes("limit") || lower.includes("max_tabs")) return "#be5046";
  if (lower.includes("discard")) return "#828997";
  return "#abb2bf";
}

/**
 * Calculates a statistical breakdown of suspension reasons across suspended tabs.
 *
 * @param {Array<object>} suspendedTabs Currently suspended tabs or history records
 * @returns {object} Breakdown object with total count and categorized reasons
 */
export function getSuspensionReasonsBreakdown(suspendedTabs = []) {
  if (!Array.isArray(suspendedTabs)) {
    return { total: 0, reasons: [] };
  }
  const counts = new Map();
  let total = 0;

  for (const item of suspendedTabs) {
    if (!item) continue;
    const rawReason = item.reason || (item.url ? parseSuspendedTabInfo(item).reason : "idle_timeout");
    const label = formatSuspensionReason(rawReason);
    const color = getSuspensionReasonColor(rawReason);

    const existing = counts.get(label) || {
      key: rawReason,
      label,
      color,
      count: 0,
      percentage: 0
    };
    existing.count += 1;
    total += 1;
    counts.set(label, existing);
  }

  const reasons = Array.from(counts.values()).map(r => ({
    ...r,
    percentage: total > 0 ? Math.round((r.count / total) * 100) : 0
  })).sort((a, b) => b.count - a.count);

  return {
    total,
    reasons
  };
}

/**
 * Parses original tab metadata from suspended URL or tab object.
 * @param {object} tab
 * @returns {object}
 */
export function parseSuspendedTabInfo(tab) {
  if (!tab) return { url: "", title: "", favIconUrl: "", suspendedAt: null, lastActiveAt: null, reason: "unknown", snapshotId: null };
  const rawUrl = tab.url || tab.pendingUrl || "";
  let url = "";
  let title = tab.title || "";
  let favIconUrl = tab.favIconUrl || "";
  let suspendedAt = null;
  let lastActiveAt = null;
  let reason = tab.discarded ? "native_discard" : "idle_timeout";
  let snapshotId = null;

  if (rawUrl && SUSPENDED_URL_PATTERN.test(rawUrl)) {
    try {
      const parsed = new URL(rawUrl);
      let params = parsed.searchParams;
      if (parsed.hash && parsed.hash.length > 1) {
        const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ""));
        if (hashParams.has("u") || hashParams.has("url")) {
          params = hashParams;
        }
      }
      url = params.get("u") || params.get("url") || "";
      if (params.has("t")) title = params.get("t");
      else if (params.has("title")) title = params.get("title");
      if (params.has("f")) favIconUrl = params.get("f");
      else if (params.has("fav")) favIconUrl = params.get("fav");
      if (params.has("at")) suspendedAt = Number(params.get("at")) || null;
      else if (params.has("timestamp")) suspendedAt = Number(params.get("timestamp")) || null;
      if (params.has("la")) lastActiveAt = Number(params.get("la")) || null;
      else if (params.has("lastActive")) lastActiveAt = Number(params.get("lastActive")) || null;
      else if (params.has("lastActiveAt")) lastActiveAt = Number(params.get("lastActiveAt")) || null;
      if (params.has("r")) reason = params.get("r");
      else if (params.has("reason")) reason = params.get("reason");
      if (params.has("sid")) snapshotId = params.get("sid");
      else if (params.has("snapshotId")) snapshotId = params.get("snapshotId");
    } catch (_) {}
  } else if (tab.discarded) {
    url = rawUrl;
    reason = "native_discard";
    lastActiveAt = tab.lastAccessed || null;
  } else {
    url = rawUrl;
  }

  return { url, title, favIconUrl, suspendedAt, lastActiveAt, reason, snapshotId };
}

/**
 * Returns list of suspended tabs enriched with original metadata, saved memory,
 * reasons, and snapshot availability.
 *
 * @param {Array<object>} tabs Raw tabs from chrome.tabs.query
 * @param {Array<object>} tabGroups Raw groups from chrome.tabGroups.query
 * @param {object} [context={}] Additional context: metadataStore, snapshotStore, options
 * @returns {Array<object>} Enriched suspended tabs
 */
export function getSuspendedTabs(tabs = [], tabGroups = [], context = {}) {
  const groupMap = createTabGroupMap(tabGroups);
  const metadataStore = context.metadataStore || null;
  const snapshotStore = context.snapshotStore || null;
  const now = context.now || Date.now();
  const suspendedPrefix = context.suspendedPrefix || "";
  const searchQuery = (context.searchQuery || "").trim().toLowerCase();
  const filterWindowId = context.windowId != null ? Number(context.windowId) : null;
  const filterGroupId = context.groupId != null ? Number(context.groupId) : null;
  const filterReason = (context.filterReason || "").trim().toLowerCase();

  const result = [];

  for (const tab of tabs) {
    if (!tab || typeof tab.id !== "number") continue;
    if (!isSuspendedTab(tab, suspendedPrefix)) continue;

    if (filterWindowId != null && tab.windowId !== filterWindowId) continue;
    if (filterGroupId != null && tab.groupId !== filterGroupId) continue;

    const parsed = parseSuspendedTabInfo(tab);
    const meta = metadataStore?.get ? metadataStore.get(tab.id) : null;

    const url = parsed.url || meta?.url || tab.url || "";
    const domain = extractDomain(url);
    const title = (parsed.title || meta?.title || tab.title || domain || "Suspended Tab").trim();
    const favIconUrl = parsed.favIconUrl || meta?.favIconUrl || tab.favIconUrl || "";
    const suspendedAt = parsed.suspendedAt || meta?.suspendedAt || meta?.lastSuspendedAt || tab.lastAccessed || now;
    const reason = parsed.reason || meta?.suspensionReason || "idle_timeout";
    const reasonFormatted = formatSuspensionReason(reason);

    if (filterReason && filterReason !== "all") {
      const matchReasonKey = reason.toLowerCase() === filterReason;
      const matchReasonLabel = reasonFormatted.toLowerCase() === filterReason;
      if (!matchReasonKey && !matchReasonLabel) continue;
    }

    // Search query matching
    if (searchQuery) {
      const matchTitle = title.toLowerCase().includes(searchQuery);
      const matchDomain = domain.toLowerCase().includes(searchQuery);
      const matchUrl = url.toLowerCase().includes(searchQuery);
      const matchReason = reasonFormatted.toLowerCase().includes(searchQuery);
      if (!matchTitle && !matchDomain && !matchUrl && !matchReason) continue;
    }

    const estimatedMemorySavedMb = estimateTabMemoryMb({ url, title }, meta);
    const group = tab.groupId > -1 ? groupMap.get(tab.groupId) || null : null;

    const snapStoreOrMap = context.snapshotMap || context.snapshotStore || snapshotStore || null;
    const snapInfo = resolveSnapshotForTab(tab, snapStoreOrMap, metadataStore);
    const hasSnapshot = snapInfo.hasSnapshot;
    const snapshotId = snapInfo.snapshotId || parsed.snapshotId || meta?.snapshotId || null;
    const snapshot = snapInfo.snapshot || null;
    const snapshotTimestamp = snapshot?.timestamp || parsed.suspendedAt || null;
    const snapshotAgeFormatted = snapshotTimestamp ? formatRelativeTime(snapshotTimestamp, now) : null;
    const hasScreenshot = Boolean(snapshot?.screenshot);
    const hasScroll = Boolean(snapshot?.scroll?.y || snapshot?.scroll?.x);
    const hasFormData = Array.isArray(snapshot?.forms) && snapshot.forms.length > 0;

    // Filter by snapshot availability if requested
    const filterSnapshot = (context.filterSnapshot || "").trim().toLowerCase();
    if (filterSnapshot === "with" || filterSnapshot === "has_snapshot") {
      if (!hasSnapshot) continue;
    } else if (filterSnapshot === "without" || filterSnapshot === "no_snapshot") {
      if (hasSnapshot) continue;
    }

    const lastActiveAt = parsed.lastActiveAt || meta?.lastActiveAt || null;
    const lastActiveRelative = lastActiveAt ? formatRelativeTime(lastActiveAt, now) : null;
    const lastActiveFormatted = lastActiveAt ? formatTimestamp(lastActiveAt) : null;

    result.push({
      id: tab.id,
      windowId: tab.windowId,
      groupId: tab.groupId,
      group,
      title,
      url,
      domain,
      favIconUrl,
      suspendedAt,
      suspendedRelative: formatRelativeTime(suspendedAt, now),
      lastActiveAt,
      lastActiveRelative,
      lastActiveFormatted,
      reason,
      reasonFormatted,
      estimatedMemorySavedMb,
      estimatedMemorySavedFormatted: formatMemoryMb(estimatedMemorySavedMb),
      hasSnapshot,
      snapshotId,
      snapshotTimestamp,
      snapshotAgeFormatted,
      hasScreenshot,
      hasScroll,
      hasFormData,
      discarded: !!tab.discarded,
      canRestore: canRestoreTab(tab, suspendedPrefix).canRestore,
      isDomainExcluded: isDomainExcluded(domain, context.settings?.whitelist)
    });
  }

  // Sort
  const sortBy = context.sortBy || "recency";
  if (sortBy === "recency") {
    result.sort((a, b) => b.suspendedAt - a.suspendedAt);
  } else if (sortBy === "lastActive") {
    result.sort((a, b) => (b.lastActiveAt || b.suspendedAt) - (a.lastActiveAt || a.suspendedAt));
  } else if (sortBy === "memory") {
    result.sort((a, b) => b.estimatedMemorySavedMb - a.estimatedMemorySavedMb);
  } else if (sortBy === "title") {
    result.sort((a, b) => a.title.localeCompare(b.title));
  } else if (sortBy === "reason") {
    result.sort((a, b) => a.reasonFormatted.localeCompare(b.reasonFormatted));
  }

  return result;
}

export const DEFAULT_RECENT_LIMIT = 50;

/**
 * Prepends a new suspension event to the recent suspensions history list.
 * Enforces maximum size bounds and validates record structure.
 *
 * @param {object} record
 * @param {Array<object>} [existingList=[]]
 * @param {number} [maxEntries=DEFAULT_RECENT_LIMIT]
 * @returns {Array<object>} New history array
 */
export function recordRecentSuspension(record = {}, existingList = [], maxEntries = DEFAULT_RECENT_LIMIT) {
  if (!record || typeof record !== "object") return Array.isArray(existingList) ? [...existingList] : [];
  const url = record.url || "";
  const title = record.title || extractDomain(url) || "Untitled Tab";
  const domain = record.domain || extractDomain(url);
  const timestamp = typeof record.timestamp === "number" && record.timestamp > 0 ? record.timestamp : Date.now();
  const reason = record.reason || "idle_timeout";
  const memorySavedMb = Number(record.estimatedMemorySavedMb || record.memorySavedMb) || 80;

  const item = {
    id: record.id || `suspend_${timestamp}_${Math.random().toString(36).slice(2, 7)}`,
    tabId: typeof record.tabId === "number" ? record.tabId : null,
    url,
    title,
    domain,
    favIconUrl: record.favIconUrl || "",
    timestamp,
    reason,
    estimatedMemorySavedMb: Math.round(memorySavedMb),
    windowId: record.windowId ?? null,
    groupId: record.groupId ?? null
  };

  const list = Array.isArray(existingList) ? [...existingList] : [];
  list.unshift(item);

  const limit = Math.max(1, Math.min(200, Number(maxEntries) || DEFAULT_RECENT_LIMIT));
  if (list.length > limit) {
    list.length = limit;
  }

  return list;
}

/**
 * Returns formatted and filtered recent suspensions.
 *
 * @param {Array<object>} historyList Persisted suspension history
 * @param {Array<object>} [openTabs=[]] Currently open tabs (for fallback or status)
 * @param {object} [context={}] Options: now, searchQuery, limit
 * @returns {Array<object>}
 */
export function getRecentlySuspended(historyList = [], openTabs = [], context = {}) {
  const now = context.now || Date.now();
  const limit = Math.max(1, Number(context.limit) || 20);
  const searchQuery = (context.searchQuery || "").trim().toLowerCase();

  let source = Array.isArray(historyList) && historyList.length > 0 ? [...historyList] : [];

  if (source.length === 0 && Array.isArray(openTabs) && openTabs.length > 0) {
    const suspendedOpen = getSuspendedTabs(openTabs, [], { now });
    source = suspendedOpen.map(t => ({
      id: `tab_${t.id}_${t.suspendedAt}`,
      tabId: t.id,
      url: t.url,
      title: t.title,
      domain: t.domain,
      favIconUrl: t.favIconUrl,
      timestamp: t.suspendedAt,
      reason: t.reason,
      estimatedMemorySavedMb: t.estimatedMemorySavedMb
    }));
  }

  const result = [];
  for (const item of source) {
    if (!item) continue;
    const domain = item.domain || extractDomain(item.url);
    const title = item.title || domain || "Untitled Tab";
    const reasonFormatted = formatSuspensionReason(item.reason);
    const memorySavedMb = Number(item.estimatedMemorySavedMb) || 80;

    if (searchQuery) {
      const matchTitle = title.toLowerCase().includes(searchQuery);
      const matchDomain = domain.toLowerCase().includes(searchQuery);
      const matchUrl = (item.url || "").toLowerCase().includes(searchQuery);
      const matchReason = reasonFormatted.toLowerCase().includes(searchQuery);
      if (!matchTitle && !matchDomain && !matchUrl && !matchReason) continue;
    }

    result.push({
      id: item.id,
      tabId: item.tabId,
      url: item.url,
      title,
      domain,
      favIconUrl: item.favIconUrl || "",
      timestamp: item.timestamp,
      relativeTime: formatRelativeTime(item.timestamp, now),
      reason: item.reason,
      reasonFormatted,
      estimatedMemorySavedMb: memorySavedMb,
      estimatedMemorySavedFormatted: formatMemoryMb(memorySavedMb)
    });

    if (result.length >= limit) break;
  }

  return result;
}

/**
 * Prepends a new restoration event to the recent restorations history list.
 * Enforces maximum size bounds and validates record structure.
 *
 * @param {object} record
 * @param {Array<object>} [existingList=[]]
 * @param {number} [maxEntries=DEFAULT_RECENT_LIMIT]
 * @returns {Array<object>} New history array
 */
export function recordRecentRestoration(record = {}, existingList = [], maxEntries = DEFAULT_RECENT_LIMIT) {
  if (!record || typeof record !== "object") return Array.isArray(existingList) ? [...existingList] : [];
  const url = record.url || "";
  const title = record.title || extractDomain(url) || "Restored Tab";
  const domain = record.domain || extractDomain(url);
  const timestamp = typeof record.timestamp === "number" && record.timestamp > 0 ? record.timestamp : Date.now();
  const method = record.method || "smart";

  const item = {
    id: record.id || `restore_${timestamp}_${Math.random().toString(36).slice(2, 7)}`,
    tabId: typeof record.tabId === "number" ? record.tabId : null,
    url,
    title,
    domain,
    favIconUrl: record.favIconUrl || "",
    timestamp,
    durationMs: typeof record.durationMs === "number" ? Math.round(record.durationMs) : null,
    method,
    windowId: record.windowId ?? null,
    groupId: record.groupId ?? null
  };

  const list = Array.isArray(existingList) ? [...existingList] : [];
  list.unshift(item);

  const limit = Math.max(1, Math.min(200, Number(maxEntries) || DEFAULT_RECENT_LIMIT));
  if (list.length > limit) {
    list.length = limit;
  }

  return list;
}

/**
 * Returns formatted and filtered recent restorations.
 *
 * @param {Array<object>} historyList Persisted restoration history
 * @param {Array<object>} [openTabs=[]] Currently open tabs (for fallback or active status)
 * @param {object} [context={}] Options: now, searchQuery, limit
 * @returns {Array<object>}
 */
export function getRecentlyRestored(historyList = [], openTabs = [], context = {}) {
  const now = context.now || Date.now();
  const limit = Math.max(1, Number(context.limit) || 20);
  const searchQuery = (context.searchQuery || "").trim().toLowerCase();

  let source = Array.isArray(historyList) && historyList.length > 0 ? [...historyList] : [];

  // Fallback: derive from open non-suspended tabs if history is empty
  if (source.length === 0 && Array.isArray(openTabs) && openTabs.length > 0) {
    const activeOpen = openTabs.filter(t => t && !isSuspendedTab(t, context.suspendedPrefix));
    source = activeOpen.map(t => ({
      id: `tab_${t.id}_${t.lastAccessed || now}`,
      tabId: t.id,
      url: t.url || "",
      title: t.title || "Restored Tab",
      domain: extractDomain(t.url),
      favIconUrl: t.favIconUrl || "",
      timestamp: t.lastAccessed || now,
      method: "standard"
    }));
  }

  const result = [];
  for (const item of source) {
    if (!item) continue;
    const domain = item.domain || extractDomain(item.url);
    const title = item.title || domain || "Restored Tab";
    const method = item.method || "smart";

    if (searchQuery) {
      const matchTitle = title.toLowerCase().includes(searchQuery);
      const matchDomain = domain.toLowerCase().includes(searchQuery);
      const matchUrl = (item.url || "").toLowerCase().includes(searchQuery);
      const matchMethod = method.toLowerCase().includes(searchQuery);
      if (!matchTitle && !matchDomain && !matchUrl && !matchMethod) continue;
    }

    result.push({
      id: item.id,
      tabId: item.tabId,
      url: item.url,
      title,
      domain,
      favIconUrl: item.favIconUrl || "",
      timestamp: item.timestamp,
      relativeTime: formatRelativeTime(item.timestamp, now),
      durationMs: item.durationMs || null,
      method,
      methodLabel: method === "smart" ? "Smart Restore" : (method === "fallback" ? "Direct URL" : "Restored")
    });

    if (result.length >= limit) break;
  }

  return result;
}

/**
 * User-friendly mapping of restoration pipeline stages.
 */
export const RESTORE_STAGE_LABELS = {
  queued: "Queued",
  deferred: "Deferred",
  navigating: "Page Navigation",
  dom_ready: "Waiting for DOM",
  scroll: "Scroll Restoration",
  forms: "Form Restoration",
  adapters: "Site Adapter",
  complete: "Complete",
  failed: "Restoration Failed",
  cancelled: "Cancelled"
};

/**
 * Returns user-friendly display label for a restoration stage.
 * @param {string} stage
 * @returns {string}
 */
export function getRestoreStageLabel(stage) {
  if (!stage) return "Restoration Pipeline";
  return RESTORE_STAGE_LABELS[stage] || String(stage).replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Formats and enriches recorded restoration failures for dashboard presentation.
 *
 * @param {Array<object>} failures Raw failed restoration records
 * @param {Array<object>} [openTabs=[]] Current open tabs for context enrichment
 * @param {object} [context={}] Options: now, searchQuery, sortBy, limit
 * @returns {Array<object>} Enriched failed restoration records
 */
export function getRestoreFailures(failures = [], openTabs = [], context = {}) {
  const now = context.now || Date.now();
  const searchQuery = (context.searchQuery || "").trim().toLowerCase();
  const limit = Math.max(1, Number(context.limit) || 50);
  const sortBy = context.sortBy || "recency";

  const tabsMap = new Map();
  if (Array.isArray(openTabs)) {
    for (const t of openTabs) {
      if (t && typeof t.id === "number") tabsMap.set(t.id, t);
    }
  }

  const list = Array.isArray(failures) ? failures : [];
  const result = [];

  for (const item of list) {
    if (!item) continue;
    const tabId = typeof item.tabId === "number" ? item.tabId : null;
    const tab = tabId ? tabsMap.get(tabId) : null;

    const targetUrl = item.targetUrl || tab?.url || "";
    const domain = item.domain || extractDomain(targetUrl);
    const title = (item.title || tab?.title || domain || `Tab #${tabId || "?"}`).trim();
    const favIconUrl = item.favIconUrl || tab?.favIconUrl || "";
    const error = item.error || "Unknown restoration error";
    const stage = item.stage || "failed";
    const stageLabel = getRestoreStageLabel(stage);
    const failedAt = typeof item.failedAt === "number" && item.failedAt > 0 ? item.failedAt : now;
    const attempts = Number(item.attempts) || 1;
    const maxAttempts = Number(item.maxAttempts) || 3;
    const retryCount = Number(item.retryCount) || 1;
    const isRetryable = item.isRetryable !== false;

    // Search query filter
    if (searchQuery) {
      const matchTitle = title.toLowerCase().includes(searchQuery);
      const matchDomain = domain.toLowerCase().includes(searchQuery);
      const matchUrl = targetUrl.toLowerCase().includes(searchQuery);
      const matchError = error.toLowerCase().includes(searchQuery);
      const matchStage = stageLabel.toLowerCase().includes(searchQuery);
      if (!matchTitle && !matchDomain && !matchUrl && !matchError && !matchStage) continue;
    }

    result.push({
      id: item.id || `fail_${tabId}_${failedAt}`,
      tabId,
      title,
      targetUrl,
      domain,
      favIconUrl,
      error,
      stage,
      stageLabel,
      failedAt,
      failedRelative: formatRelativeTime(failedAt, now),
      failedFormatted: formatTimestamp(failedAt),
      attempts,
      maxAttempts,
      retryCount,
      isRetryable,
      windowId: item.windowId ?? tab?.windowId ?? null,
      groupId: item.groupId ?? tab?.groupId ?? null
    });
  }

  // Sort
  if (sortBy === "recency") {
    result.sort((a, b) => b.failedAt - a.failedAt);
  } else if (sortBy === "attempts" || sortBy === "retries") {
    result.sort((a, b) => b.retryCount - a.retryCount || b.attempts - a.attempts);
  } else if (sortBy === "title") {
    result.sort((a, b) => a.title.localeCompare(b.title));
  } else if (sortBy === "error") {
    result.sort((a, b) => a.error.localeCompare(b.error));
  }

  if (result.length > limit) {
    result.length = limit;
  }

  return result;
}

/**
 * Records a restoration failure record into a history list enforcing bounds and deduplicating by tabId.
 *
 * @param {object} record
 * @param {Array<object>} [existingList=[]]
 * @param {number} [maxEntries=DEFAULT_RECENT_LIMIT]
 * @returns {Array<object>}
 */
export function recordRestoreFailure(record = {}, existingList = [], maxEntries = DEFAULT_RECENT_LIMIT) {
  if (!record || typeof record !== "object") return Array.isArray(existingList) ? [...existingList] : [];
  const list = Array.isArray(existingList) ? [...existingList] : [];
  const tabId = typeof record.tabId === "number" ? record.tabId : null;
  const targetUrl = record.targetUrl || "";
  const domain = record.domain || extractDomain(targetUrl);
  const title = record.title || domain || (tabId ? `Tab #${tabId}` : "Restoration Failure");
  const failedAt = typeof record.failedAt === "number" && record.failedAt > 0 ? record.failedAt : Date.now();

  const item = {
    id: record.id || `fail_${tabId || "unknown"}_${failedAt}`,
    tabId,
    targetUrl,
    title,
    domain,
    favIconUrl: record.favIconUrl || "",
    error: record.error || "Restoration failed",
    stage: record.stage || "failed",
    attempts: record.attempts || 1,
    maxAttempts: record.maxAttempts || 3,
    retryCount: record.retryCount || 1,
    isRetryable: record.isRetryable !== false,
    failedAt,
    windowId: record.windowId ?? null,
    groupId: record.groupId ?? null
  };

  // Replace existing failure for the same tabId if present, or unshift
  const existingIdx = tabId != null ? list.findIndex(r => r && r.tabId === tabId) : -1;
  if (existingIdx >= 0) {
    list.splice(existingIdx, 1);
  }
  list.unshift(item);

  const limit = Math.max(1, Math.min(200, Number(maxEntries) || DEFAULT_RECENT_LIMIT));
  if (list.length > limit) {
    list.length = limit;
  }

  return list;
}

/**
 * Deletes a snapshot from a store instance by snapshotId or tabId.
 *
 * @param {object} snapshotStore
 * @param {object} [options={}]
 * @param {string} [options.snapshotId]
 * @param {number} [options.tabId]
 * @param {boolean} [options.force=true]
 * @returns {Promise<{ ok: boolean, deleted: boolean, error?: string }>}
 */
export async function deleteSnapshotRecord(snapshotStore, options = {}) {
  if (!snapshotStore) return { ok: false, deleted: false, error: "No snapshot store provided" };
  const respectProtection = options.force !== true;
  let deleted = false;
  if (options.snapshotId) {
    deleted = await snapshotStore.deleteSnapshot(options.snapshotId, { respectProtection });
  } else if (typeof options.tabId === "number") {
    deleted = await snapshotStore.deleteSnapshotsForTab(options.tabId, { respectProtection });
  }
  return { ok: true, deleted: Boolean(deleted) };
}

export const SESSION_PAYLOAD_SCHEMA_VERSION = 1;

/**
 * Validates and normalizes an individual tab object within a session.
 * @param {object} tab
 * @returns {object|null}
 */
export function sanitizeSessionTab(tab) {
  if (!tab || typeof tab !== "object") return null;
  let url = (typeof tab.url === "string" ? tab.url : "").trim();
  if (!url) return null;

  // Unwrap suspended placeholder URL if present
  if (url.includes("suspended/suspended.html#") || url.includes("suspended/suspended.html?")) {
    try {
      const hashIdx = url.indexOf("#");
      const qIdx = url.indexOf("?");
      const paramStr = hashIdx !== -1 ? url.slice(hashIdx + 1) : (qIdx !== -1 ? url.slice(qIdx + 1) : "");
      const params = new URLSearchParams(paramStr);
      url = params.get("u") || params.get("url") || url;
    } catch (_) {}
  }

  const title = (typeof tab.title === "string" ? tab.title.trim() : "") || extractDomain(url) || "Untitled Tab";
  const favIconUrl = typeof tab.favIconUrl === "string" ? tab.favIconUrl.trim() : "";
  const pinned = Boolean(tab.pinned);
  const groupId = typeof tab.groupId === "number" ? tab.groupId : -1;
  const groupTitle = typeof tab.groupTitle === "string" ? tab.groupTitle : null;

  return {
    url,
    title,
    favIconUrl,
    pinned,
    groupId,
    groupTitle
  };
}

/**
 * Creates a standardized, portable export payload for a saved session.
 * @param {object} session
 * @param {object} [metadata={}]
 * @returns {object} JSON-serializable session payload
 */
export function serializeSession(session = {}, metadata = {}) {
  const name = (typeof session.name === "string" && session.name.trim())
    ? session.name.trim()
    : `Session ${new Date().toLocaleString()}`;
  const savedAt = typeof session.savedAt === "number" && session.savedAt > 0 ? session.savedAt : Date.now();
  const rawTabs = Array.isArray(session.tabs) ? session.tabs : [];
  const tabs = rawTabs.map(t => sanitizeSessionTab(t)).filter(Boolean);

  return {
    schemaVersion: SESSION_PAYLOAD_SCHEMA_VERSION,
    format: "tabvault-session",
    exportedAt: new Date().toISOString(),
    session: {
      id: session.id || `session_${savedAt}`,
      name,
      savedAt,
      savedAtIso: new Date(savedAt).toISOString(),
      tabCount: tabs.length,
      tabs
    },
    metadata: {
      extension: "TabVault",
      version: "1.0.0",
      ...metadata
    }
  };
}

/**
 * Serializes multiple sessions into an all-sessions export bundle.
 * @param {Array<object>} sessions
 * @param {object} [metadata={}]
 * @returns {object}
 */
export function serializeAllSessions(sessions = [], metadata = {}) {
  const validSessions = Array.isArray(sessions) ? sessions : [];
  const list = validSessions.map(s => {
    const serialized = serializeSession(s);
    return serialized.session;
  });

  return {
    schemaVersion: SESSION_PAYLOAD_SCHEMA_VERSION,
    format: "tabvault-all-sessions",
    exportedAt: new Date().toISOString(),
    totalSessions: list.length,
    totalTabs: list.reduce((sum, s) => sum + (s.tabCount || 0), 0),
    sessions: list,
    metadata: {
      extension: "TabVault",
      version: "1.0.0",
      ...metadata
    }
  };
}

/**
 * Parses and validates an imported session payload (single session, bundle, or raw session array/object).
 * @param {string|object} rawInput
 * @returns {{ ok: boolean, sessions: Array<object>, error?: string }}
 */
export function parseAndValidateSession(rawInput) {
  let parsed;
  if (!rawInput) {
    return { ok: false, sessions: [], error: "Payload cannot be empty" };
  }
  if (typeof rawInput === "string") {
    try {
      parsed = JSON.parse(rawInput);
    } catch (err) {
      return { ok: false, sessions: [], error: "Invalid JSON format: " + err.message };
    }
  } else if (typeof rawInput === "object") {
    parsed = rawInput;
  } else {
    return { ok: false, sessions: [], error: "Payload must be a JSON string or object" };
  }

  // Handle single session format
  if (parsed.format === "tabvault-session" && parsed.session) {
    const s = parsed.session;
    const tabs = Array.isArray(s.tabs) ? s.tabs.map(sanitizeSessionTab).filter(Boolean) : [];
    if (tabs.length === 0 && (!Array.isArray(s.tabs) || s.tabs.length > 0)) {
      return { ok: false, sessions: [], error: "Session contains no valid tabs with URLs" };
    }
    const sessionObj = {
      name: (s.name || "Imported Session").trim(),
      savedAt: typeof s.savedAt === "number" ? s.savedAt : Date.now(),
      tabs
    };
    return { ok: true, sessions: [sessionObj] };
  }

  // Handle all-sessions bundle format
  if (parsed.format === "tabvault-all-sessions" && Array.isArray(parsed.sessions)) {
    const result = [];
    for (const s of parsed.sessions) {
      const tabs = Array.isArray(s.tabs) ? s.tabs.map(sanitizeSessionTab).filter(Boolean) : [];
      if (tabs.length > 0) {
        result.push({
          name: (s.name || `Session ${result.length + 1}`).trim(),
          savedAt: typeof s.savedAt === "number" ? s.savedAt : Date.now(),
          tabs
        });
      }
    }
    if (result.length === 0) {
      return { ok: false, sessions: [], error: "No valid sessions found in bundle" };
    }
    return { ok: true, sessions: result };
  }

  // Handle raw array of sessions
  if (Array.isArray(parsed)) {
    const result = [];
    for (const item of parsed) {
      if (item && Array.isArray(item.tabs)) {
        const tabs = item.tabs.map(sanitizeSessionTab).filter(Boolean);
        if (tabs.length > 0) {
          result.push({
            name: (item.name || `Session ${result.length + 1}`).trim(),
            savedAt: typeof item.savedAt === "number" ? item.savedAt : Date.now(),
            tabs
          });
        }
      }
    }
    if (result.length > 0) {
      return { ok: true, sessions: result };
    }
  } else if (Array.isArray(parsed.tabs)) {
    // Direct session object { name, savedAt, tabs }
    const tabs = parsed.tabs.map(sanitizeSessionTab).filter(Boolean);
    if (tabs.length > 0) {
      return {
        ok: true,
        sessions: [{
          name: (parsed.name || "Imported Session").trim(),
          savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : Date.now(),
          tabs
        }]
      };
    }
  }

  return { ok: false, sessions: [], error: "Unrecognized session schema format" };
}

/**
 * Merges imported sessions into an existing list of sessions according to conflict strategy.
 *
 * @param {Array<object>} existingSessions
 * @param {Array<object>} importedSessions
 * @param {object} [options={}]
 * @param {"append"|"replace"|"skip_duplicates"|"merge"} [options.conflictStrategy="append"]
 * @returns {{ sessions: Array<object>, addedCount: number, replacedCount: number, skippedCount: number }}
 */
export function mergeSessions(existingSessions = [], importedSessions = [], options = {}) {
  const strategy = options.conflictStrategy || "append";
  const existing = Array.isArray(existingSessions) ? [...existingSessions] : [];
  const imported = Array.isArray(importedSessions) ? importedSessions : [];

  if (strategy === "replace") {
    return {
      sessions: [...imported],
      addedCount: imported.length,
      replacedCount: existing.length,
      skippedCount: 0
    };
  }

  let addedCount = 0;
  let replacedCount = 0;
  let skippedCount = 0;

  if (strategy === "skip_duplicates") {
    const existingNames = new Set(existing.map(s => (s.name || "").toLowerCase()));
    for (const s of imported) {
      const nameKey = (s.name || "").toLowerCase();
      if (existingNames.has(nameKey)) {
        skippedCount++;
      } else {
        existing.push(s);
        existingNames.add(nameKey);
        addedCount++;
      }
    }
    return { sessions: existing, addedCount, replacedCount, skippedCount };
  }

  if (strategy === "merge") {
    for (const s of imported) {
      const nameKey = (s.name || "").toLowerCase();
      const existingIdx = existing.findIndex(e => (e.name || "").toLowerCase() === nameKey);
      if (existingIdx >= 0) {
        existing[existingIdx] = s;
        replacedCount++;
      } else {
        existing.push(s);
        addedCount++;
      }
    }
    return { sessions: existing, addedCount, replacedCount, skippedCount };
  }

  // Default: "append"
  for (const s of imported) {
    existing.push(s);
    addedCount++;
  }
  return { sessions: existing, addedCount, replacedCount, skippedCount };
}
