// TabVault — Least Recently Used (LRU) Suspension Engine
// Tracks tab access recency and selects oldest idle tabs for suspension while honoring protection rules.

import { evaluateTabProtection, TabProtectionReason, generateSuspensionExplanation } from "./scoring.js";
import { matchDomainPattern, globToRegex } from "./adapters/domain.js";

export const STORAGE_KEY_LRU_EXCLUSIONS = "tabvault_lru_exclusions";

/**
 * Manages exclusions specifically for the LRU suspension engine.
 * Allows users to exempt specific tabs, domains, URL patterns, titles, and groups.
 */
export class LruExclusionManager {
  /**
   * @param {Array<object>} [initialRules=[]]
   */
  constructor(initialRules = []) {
    /** @type {Map<string, object>} */
    this._rules = new Map();
    if (Array.isArray(initialRules)) {
      for (const rule of initialRules) {
        this.addRule(rule);
      }
    }
  }

  /**
   * Registers an exclusion rule.
   *
   * @param {object} rule
   * @param {string} [rule.id] - Unique rule identifier
   * @param {string} [rule.domain] - Domain to exclude (e.g. "*.github.com", "slack.com")
   * @param {string} [rule.urlPattern] - URL pattern or glob
   * @param {RegExp} [rule.urlRegex] - Compiled regex for URL
   * @param {number} [rule.tabId] - Specific tab ID to exclude
   * @param {string} [rule.titlePattern] - Title pattern/glob to exclude
   * @param {number} [rule.groupId] - Tab group ID to exclude
   * @param {Function} [rule.predicate] - Custom predicate (tab, metadata, context) => boolean
   * @param {string} [rule.reason] - Human-readable reason for exclusion
   * @param {boolean} [rule.enabled=true] - Whether rule is active
   * @returns {object} Registered rule
   */
  addRule(rule = {}) {
    const id = rule.id || `lru-ex-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const normalized = {
      id,
      domain: rule.domain ? String(rule.domain).trim().toLowerCase() : null,
      urlPattern: rule.urlPattern ? String(rule.urlPattern).trim() : null,
      urlRegex: rule.urlRegex instanceof RegExp ? rule.urlRegex : (rule.urlPattern ? globToRegex(rule.urlPattern) : null),
      tabId: typeof rule.tabId === "number" ? rule.tabId : null,
      titlePattern: rule.titlePattern ? String(rule.titlePattern).trim() : null,
      titleRegex: rule.titlePattern ? globToRegex(rule.titlePattern) : null,
      groupId: typeof rule.groupId === "number" ? rule.groupId : null,
      predicate: typeof rule.predicate === "function" ? rule.predicate : null,
      reason: rule.reason || "Excluded from LRU suspension",
      enabled: rule.enabled !== false,
      createdAt: rule.createdAt || Date.now()
    };

    this._rules.set(id, normalized);
    return normalized;
  }

  removeRule(id) {
    return this._rules.delete(id);
  }

  getRule(id) {
    return this._rules.get(id) || null;
  }

  getAllRules() {
    return Array.from(this._rules.values());
  }

  setRuleEnabled(id, enabled) {
    const rule = this._rules.get(id);
    if (rule) {
      rule.enabled = Boolean(enabled);
      return true;
    }
    return false;
  }

  clear() {
    this._rules.clear();
  }

  /**
   * Evaluates whether a tab matches any active exclusion rules.
   *
   * @param {object} tab - Chrome tab
   * @param {object} [metadata={}] - Tab metadata
   * @param {object} [context={}] - Contextual environment
   * @returns {{ isExcluded: boolean, reason: string|null, ruleId: string|null }}
   */
  evaluate(tab = {}, metadata = {}, context = {}) {
    const tabUrl = tab.url || metadata.url || "";
    const tabTitle = tab.title || metadata.title || "";
    const tabId = tab.id ?? metadata.tabId;
    const tabGroupId = tab.groupId ?? metadata.groupId;

    for (const rule of this._rules.values()) {
      if (!rule.enabled) continue;

      // 1. Match tab ID
      if (rule.tabId !== null && tabId !== undefined && rule.tabId === tabId) {
        return { isExcluded: true, reason: rule.reason, ruleId: rule.id };
      }

      // 2. Match tab group ID
      if (rule.groupId !== null && tabGroupId !== undefined && rule.groupId === tabGroupId) {
        return { isExcluded: true, reason: rule.reason, ruleId: rule.id };
      }

      // 3. Match domain
      if (rule.domain && tabUrl) {
        try {
          const parsedUrl = new URL(tabUrl);
          if (matchDomainPattern(parsedUrl.hostname, rule.domain)) {
            return { isExcluded: true, reason: rule.reason, ruleId: rule.id };
          }
        } catch (_) {
          if (tabUrl.toLowerCase().includes(rule.domain)) {
            return { isExcluded: true, reason: rule.reason, ruleId: rule.id };
          }
        }
      }

      // 4. Match URL pattern / regex
      if (rule.urlRegex && tabUrl && rule.urlRegex.test(tabUrl)) {
        return { isExcluded: true, reason: rule.reason, ruleId: rule.id };
      }

      // 5. Match Title pattern / regex
      if (rule.titleRegex && tabTitle && rule.titleRegex.test(tabTitle)) {
        return { isExcluded: true, reason: rule.reason, ruleId: rule.id };
      }

      // 6. Custom predicate
      if (rule.predicate) {
        try {
          if (rule.predicate(tab, metadata, context)) {
            return { isExcluded: true, reason: rule.reason, ruleId: rule.id };
          }
        } catch (_) {}
      }
    }

    return { isExcluded: false, reason: null, ruleId: null };
  }

  async loadFromStorage() {
    if (typeof chrome !== "undefined" && chrome?.storage?.sync) {
      try {
        const data = await chrome.storage.sync.get(STORAGE_KEY_LRU_EXCLUSIONS);
        if (data && Array.isArray(data[STORAGE_KEY_LRU_EXCLUSIONS])) {
          this.clear();
          for (const item of data[STORAGE_KEY_LRU_EXCLUSIONS]) {
            this.addRule(item);
          }
        }
      } catch (_) {}
    }
  }

  async saveToStorage() {
    if (typeof chrome !== "undefined" && chrome?.storage?.sync) {
      try {
        const serializable = this.getAllRules().map(r => ({
          id: r.id,
          domain: r.domain,
          urlPattern: r.urlPattern,
          tabId: r.tabId,
          titlePattern: r.titlePattern,
          groupId: r.groupId,
          reason: r.reason,
          enabled: r.enabled,
          createdAt: r.createdAt
        }));
        await chrome.storage.sync.set({ [STORAGE_KEY_LRU_EXCLUSIONS]: serializable });
      } catch (_) {}
    }
  }
}

export const defaultLruExclusionManager = new LruExclusionManager();

/**
 * Resolves the most accurate and recent timestamp of when a tab was actively used.
 *
 * @param {object} [tab={}] - Chrome tab object
 * @param {object} [metadata={}] - TabVault metadata record
 * @param {number} [fallbackTime=0] - Fallback timestamp if no records exist
 * @returns {number} Timestamp in milliseconds
 */
export function resolveTabLastActiveAt(tab = {}, metadata = {}, fallbackTime = 0) {
  if (typeof tab.lastActiveAt === "number" && !Number.isNaN(tab.lastActiveAt)) {
    return tab.lastActiveAt;
  }
  if (typeof metadata.lastActiveAt === "number" && !Number.isNaN(metadata.lastActiveAt)) {
    return metadata.lastActiveAt;
  }
  if (typeof tab.lastAccessed === "number" && !Number.isNaN(tab.lastAccessed)) {
    return tab.lastAccessed;
  }
  if (typeof metadata.createdAt === "number" && !Number.isNaN(metadata.createdAt)) {
    return metadata.createdAt;
  }
  if (typeof tab.createdAt === "number" && !Number.isNaN(tab.createdAt)) {
    return tab.createdAt;
  }
  return fallbackTime;
}

/**
 * Evaluates whether a tab is eligible for LRU suspension.
 *
 * @param {object} tab - Chrome tab object
 * @param {object} [metadata={}] - Tab metadata record
 * @param {object} [options={}] - Evaluation options
 * @param {number} [options.now] - Current timestamp
 * @param {number} [options.minIdleMinutes=0] - Minimum idle minutes required
 * @param {LruExclusionManager} [options.exclusionManager] - Exclusion manager instance
 * @param {Array<number|string|object>} [options.exclusions=[]] - Tab IDs, URLs, or rules excluded from LRU
 * @returns {{ eligible: boolean, reason: string|null }}
 */
export function isTabEligibleForLru(tab = {}, metadata = {}, options = {}) {
  // 1. Evaluate baseline protection (pinned, audible, active, internal, form inputs, etc.)
  const protection = evaluateTabProtection(tab, metadata, options);
  if (protection.isProtected) {
    return { eligible: false, reason: protection.reason };
  }

  // 2. Active tab check
  if (tab.active) {
    return { eligible: false, reason: TabProtectionReason.ACTIVE };
  }

  // 3. Evaluate exclusion manager if provided or default
  const manager = options.exclusionManager || (options.useDefaultExclusionManager ? defaultLruExclusionManager : null);
  if (manager && typeof manager.evaluate === "function") {
    const evalResult = manager.evaluate(tab, metadata, options);
    if (evalResult.isExcluded) {
      return { eligible: false, reason: evalResult.reason || "lru_excluded_rule" };
    }
  }

  // 4. Evaluate explicit exclusions array (tab IDs, URLs, globs, or rule objects)
  if (Array.isArray(options.exclusions) && options.exclusions.length > 0) {
    for (const ex of options.exclusions) {
      if (typeof ex === "number" && tab.id !== undefined && tab.id === ex) {
        return { eligible: false, reason: "lru_excluded_tab_id" };
      }
      if (typeof ex === "string") {
        const url = tab.url || metadata.url || "";
        if (url) {
          const lowerUrl = url.toLowerCase();
          const lowerEx = ex.toLowerCase();
          if (lowerUrl.includes(lowerEx) || globToRegex(ex).test(url)) {
            return { eligible: false, reason: "lru_excluded_url" };
          }
        }
      }
      if (ex && typeof ex === "object") {
        const inlineMgr = new LruExclusionManager([ex]);
        const r = inlineMgr.evaluate(tab, metadata, options);
        if (r.isExcluded) {
          return { eligible: false, reason: r.reason || "lru_excluded_rule" };
        }
      }
    }
  }

  // 5. Minimum idle duration check
  const minIdleMinutes = Number(options.minIdleMinutes) || 0;
  if (minIdleMinutes > 0) {
    const now = options.now || Date.now();
    const lastActive = resolveTabLastActiveAt(tab, metadata, now);
    const idleMs = Math.max(0, now - lastActive);
    const idleMinutes = idleMs / 60000;
    if (idleMinutes < minIdleMinutes) {
      return { eligible: false, reason: "idle_duration_below_threshold" };
    }
  }

  return { eligible: true, reason: null };
}

/**
 * Tracks tab access recency in memory with fast lookup and ordered eviction sequence.
 */
export class LruTracker {
  /**
   * @param {Map<number, number>|Iterable<[number, number]>} [initialEntries]
   */
  constructor(initialEntries = null) {
    /** @type {Map<number, number>} tabId -> timestamp */
    this._accessMap = new Map();
    if (initialEntries) {
      for (const [tabId, time] of initialEntries) {
        this.touch(tabId, time);
      }
    }
  }

  /**
   * Records or updates the last access timestamp for a tab.
   *
   * @param {number} tabId
   * @param {number} [timestamp=Date.now()]
   */
  touch(tabId, timestamp = Date.now()) {
    if (tabId === undefined || tabId === null) return;
    // Delete and re-set to preserve insertion order (Map preserves insertion order)
    this._accessMap.delete(tabId);
    this._accessMap.set(tabId, timestamp);
  }

  /**
   * Removes a tab from the tracker.
   *
   * @param {number} tabId
   * @returns {boolean} True if tab was tracked
   */
  remove(tabId) {
    return this._accessMap.delete(tabId);
  }

  /**
   * Retrieves the last access timestamp for a tab.
   *
   * @param {number} tabId
   * @returns {number|undefined}
   */
  getLastAccess(tabId) {
    return this._accessMap.get(tabId);
  }

  /**
   * Checks if a tab is tracked.
   *
   * @param {number} tabId
   * @returns {boolean}
   */
  has(tabId) {
    return this._accessMap.has(tabId);
  }

  /**
   * Number of tracked tabs.
   * @returns {number}
   */
  get size() {
    return this._accessMap.size;
  }

  /**
   * Returns an array of tracked tab IDs sorted by recency:
   * index 0 is least recently used (oldest timestamp), last index is most recently used.
   *
   * @returns {Array<number>}
   */
  getAccessOrder() {
    return Array.from(this._accessMap.entries())
      .sort((a, b) => a[1] - b[1])
      .map(([tabId]) => tabId);
  }

  /**
   * Clears all tracked tabs.
   */
  clear() {
    this._accessMap.clear();
  }
}

/**
 * Returns all open tabs that are eligible for suspension, sorted strictly by LRU order:
 * least recently used (oldest lastActiveAt) first.
 *
 * @param {Array<object>} tabs - Open Chrome tabs
 * @param {Map<number, object>|object} [metadataMap] - Tab metadata mapping
 * @param {object} [options={}] - Evaluation and sorting options
 * @returns {Array<object>} Eligible tabs ordered by LRU
 */
export function getLeastRecentlyUsedTabs(tabs = [], metadataMap = new Map(), options = {}) {
  if (!Array.isArray(tabs)) return [];

  const getMeta = (tabId) => {
    if (!metadataMap) return {};
    if (metadataMap instanceof Map) return metadataMap.get(tabId) || {};
    return metadataMap[tabId] || {};
  };

  const now = options.now || Date.now();

  const eligibleItems = [];
  for (const tab of tabs) {
    if (!tab || tab.id === undefined) continue;
    const meta = getMeta(tab.id);
    const eligibility = isTabEligibleForLru(tab, meta, { ...options, now });
    if (!eligibility.eligible) continue;

    const lastActiveAt = resolveTabLastActiveAt(tab, meta, now);
    const idleMs = Math.max(0, now - lastActiveAt);

    eligibleItems.push({
      tab,
      metadata: meta,
      tabId: tab.id,
      title: tab.title || meta.title || "Untitled",
      url: tab.url || meta.url || "",
      lastActiveAt,
      idleMs,
      idleMinutes: Math.floor(idleMs / 60000)
    });
  }

  // Sort ascending by lastActiveAt (oldest timestamp = least recently used first)
  return eligibleItems.sort((a, b) => {
    if (a.lastActiveAt !== b.lastActiveAt) {
      return a.lastActiveAt - b.lastActiveAt;
    }
    // Secondary tie-breaker if provided
    if (typeof options.tieBreaker === "function") {
      return options.tieBreaker(a, b);
    }
    // Fallback tie-breaker: lower visit count first, then lower tabId
    const aVisits = a.metadata.visitCount ?? a.tab.visitCount ?? 1;
    const bVisits = b.metadata.visitCount ?? b.tab.visitCount ?? 1;
    if (aVisits !== bVisits) {
      return aVisits - bVisits;
    }
    return a.tabId - b.tabId;
  });
}

/**
 * Selects up to `count` candidates for LRU suspension.
 *
 * @param {Array<object>} tabs - Open Chrome tabs
 * @param {Map<number, object>|object} [metadataMap] - Tab metadata mapping
 * @param {object} [options={}] - Options (count, minIdleMinutes, exclusions, now, etc.)
 * @param {number} [options.count=1] - Maximum candidates to select
 * @returns {Array<object>} Selected suspension candidates with detailed descriptors
 */
export function selectLruSuspensionCandidates(tabs = [], metadataMap = new Map(), options = {}) {
  const count = typeof options.count === "number" && options.count > 0 ? options.count : 1;
  const ranked = getLeastRecentlyUsedTabs(tabs, metadataMap, options);
  const selected = ranked.slice(0, count);

  const now = options.now || Date.now();

  return selected.map(item => {
    const explanation = generateSuspensionExplanation(
      {
        tabId: item.tabId,
        score: Math.min(60, item.idleMinutes),
        isEligible: true,
        factors: {
          idleMinutes: item.idleMinutes,
          idleScore: Math.min(60, item.idleMinutes)
        }
      },
      { trigger: "lru_quota", now }
    );

    return {
      tabId: item.tabId,
      tab: item.tab,
      metadata: item.metadata,
      title: item.title,
      url: item.url,
      lastActiveAt: item.lastActiveAt,
      idleMs: item.idleMs,
      idleMinutes: item.idleMinutes,
      explanation
    };
  });
}

export const DEFAULT_MAX_ACTIVE_TABS = 15;
export const STORAGE_KEY_MAX_ACTIVE_TABS = "tabvault_max_active_tabs";

let activeMaxActiveTabs = DEFAULT_MAX_ACTIVE_TABS;

/**
 * Gets the current maximum active-tab threshold.
 * @returns {number}
 */
export function getActiveTabThreshold() {
  return activeMaxActiveTabs;
}

/**
 * Sets the maximum active-tab threshold with validation and optional storage sync.
 * Minimum allowed is 1, maximum 500, or 0/null/Infinity to disable.
 *
 * @param {number} threshold
 * @param {boolean} [syncStorage=true]
 * @returns {Promise<number>}
 */
export async function setActiveTabThreshold(threshold, syncStorage = true) {
  let normalized;
  if (threshold === null || threshold === undefined || threshold === 0 || threshold === Infinity) {
    normalized = Infinity;
  } else {
    const parsed = Number(threshold);
    if (Number.isNaN(parsed) || parsed <= 0) {
      normalized = DEFAULT_MAX_ACTIVE_TABS;
    } else {
      normalized = Math.max(1, Math.min(500, Math.floor(parsed)));
    }
  }

  activeMaxActiveTabs = normalized;

  if (syncStorage && typeof chrome !== "undefined" && chrome?.storage?.sync) {
    try {
      await chrome.storage.sync.set({ [STORAGE_KEY_MAX_ACTIVE_TABS]: normalized });
    } catch (_) {
      // Fallback or ignore
    }
  }

  return activeMaxActiveTabs;
}

/**
 * Resets maximum active-tab threshold to default.
 * @param {boolean} [syncStorage=true]
 * @returns {Promise<number>}
 */
export async function resetActiveTabThreshold(syncStorage = true) {
  return setActiveTabThreshold(DEFAULT_MAX_ACTIVE_TABS, syncStorage);
}

/**
 * Evaluates whether the number of active tabs exceeds the maximum active-tab threshold.
 * If exceeded, determines the excess count and selects the least-recently-used eligible
 * candidates for suspension to bring active tab count within threshold.
 *
 * @param {Array<object>} tabs - Open Chrome tabs
 * @param {Map<number, object>|object} [metadataMap] - Tab metadata mapping
 * @param {object} [options={}] - Options (maxActiveTabs override, minIdleMinutes, exclusions, now)
 * @returns {object} Evaluation result
 */
export function evaluateActiveTabThreshold(tabs = [], metadataMap = new Map(), options = {}) {
  if (!Array.isArray(tabs)) {
    return {
      thresholdExceeded: false,
      maxActiveTabs: activeMaxActiveTabs,
      currentActiveCount: 0,
      excessCount: 0,
      candidatesToSuspend: [],
      retainedTabs: [],
      summary: "No tabs to evaluate."
    };
  }

  const threshold = options.maxActiveTabs !== undefined
    ? (options.maxActiveTabs === 0 || options.maxActiveTabs === null || options.maxActiveTabs === Infinity ? Infinity : Math.max(1, Math.floor(Number(options.maxActiveTabs))))
    : activeMaxActiveTabs;

  const getMeta = (tabId) => {
    if (!metadataMap) return {};
    if (metadataMap instanceof Map) return metadataMap.get(tabId) || {};
    return metadataMap[tabId] || {};
  };

  // Count active / unsuspended tabs
  // A tab is active if it is not discarded and not loading/displaying suspended.html
  const activeTabs = [];
  for (const tab of tabs) {
    if (!tab || tab.id === undefined) continue;
    const meta = getMeta(tab.id);
    const url = tab.url || meta.url || "";
    const isDiscarded = tab.discarded === true || meta.lifecycleState === "DISCARDED";
    const isSuspendedPage = url.includes("suspended/suspended.html") || url.startsWith("chrome-extension://");
    if (!isDiscarded && !isSuspendedPage) {
      activeTabs.push(tab);
    }
  }

  const currentActiveCount = activeTabs.length;
  const isExceeded = threshold !== Infinity && currentActiveCount > threshold;
  const excessCount = isExceeded ? currentActiveCount - threshold : 0;

  let candidatesToSuspend = [];
  if (excessCount > 0) {
    candidatesToSuspend = selectLruSuspensionCandidates(activeTabs, metadataMap, {
      ...options,
      count: excessCount
    });
  }

  const candidateIds = new Set(candidatesToSuspend.map(c => c.tabId));
  const retainedTabs = activeTabs.filter(t => !candidateIds.has(t.id));

  const summary = isExceeded
    ? `Active tab limit exceeded: ${currentActiveCount} active tabs (limit: ${threshold}). Selected ${candidatesToSuspend.length} LRU tab(s) for suspension.`
    : `Active tab count within threshold: ${currentActiveCount} active tab(s) (limit: ${threshold === Infinity ? "unlimited" : threshold}).`;

  return {
    thresholdExceeded: isExceeded,
    maxActiveTabs: threshold,
    currentActiveCount,
    excessCount,
    candidatesToSuspend,
    retainedTabs,
    summary
  };
}

/**
 * Checks if a tab is currently suspended or discarded.
 *
 * @param {object} [tab={}] - Chrome tab object
 * @param {object} [metadata={}] - TabVault metadata record
 * @returns {boolean}
 */
export function isTabSuspended(tab = {}, metadata = {}) {
  const safeTab = tab || {};
  const safeMeta = metadata || {};
  if (safeTab.discarded === true) return true;
  if (safeMeta.lifecycleState === "DISCARDED" || safeMeta.lifecycleState === "SUSPENDED") return true;
  const url = safeTab.url || safeMeta.url || "";
  if (url.includes("suspended/suspended.html") || (url.startsWith("chrome-extension://") && url.includes("suspended"))) {
    return true;
  }
  return false;
}

export const DEFAULT_MAX_UNSUSPENDED_TABS = 20;
export const STORAGE_KEY_MAX_UNSUSPENDED_TABS = "tabvault_max_unsuspended_tabs";

let activeMaxUnsuspendedTabs = DEFAULT_MAX_UNSUSPENDED_TABS;

/**
 * Gets the current maximum unsuspended-tab threshold.
 * @returns {number}
 */
export function getUnsuspendedTabThreshold() {
  return activeMaxUnsuspendedTabs;
}

/**
 * Sets the maximum unsuspended-tab threshold with validation and optional storage sync.
 * Minimum allowed is 1, maximum 500, or 0/null/Infinity to disable.
 *
 * @param {number} threshold
 * @param {boolean} [syncStorage=true]
 * @returns {Promise<number>}
 */
export async function setUnsuspendedTabThreshold(threshold, syncStorage = true) {
  let normalized;
  if (threshold === null || threshold === undefined || threshold === 0 || threshold === Infinity) {
    normalized = Infinity;
  } else {
    const parsed = Number(threshold);
    if (Number.isNaN(parsed) || parsed <= 0) {
      normalized = DEFAULT_MAX_UNSUSPENDED_TABS;
    } else {
      normalized = Math.max(1, Math.min(500, Math.floor(parsed)));
    }
  }

  activeMaxUnsuspendedTabs = normalized;

  if (syncStorage && typeof chrome !== "undefined" && chrome?.storage?.sync) {
    try {
      await chrome.storage.sync.set({ [STORAGE_KEY_MAX_UNSUSPENDED_TABS]: normalized });
    } catch (_) {
      // Fallback or ignore
    }
  }

  return activeMaxUnsuspendedTabs;
}

/**
 * Resets maximum unsuspended-tab threshold to default.
 * @param {boolean} [syncStorage=true]
 * @returns {Promise<number>}
 */
export async function resetUnsuspendedTabThreshold(syncStorage = true) {
  return setUnsuspendedTabThreshold(DEFAULT_MAX_UNSUSPENDED_TABS, syncStorage);
}

/**
 * Evaluates whether the number of unsuspended tabs exceeds the maximum unsuspended-tab threshold.
 * If exceeded, determines the excess count and selects the least-recently-used eligible
 * candidates for suspension to bring unsuspended tab count within threshold.
 *
 * @param {Array<object>} tabs - Open Chrome tabs
 * @param {Map<number, object>|object} [metadataMap] - Tab metadata mapping
 * @param {object} [options={}] - Options (maxUnsuspendedTabs override, minIdleMinutes, exclusions, now)
 * @returns {object} Evaluation result
 */
export function evaluateUnsuspendedTabThreshold(tabs = [], metadataMap = new Map(), options = {}) {
  if (!Array.isArray(tabs)) {
    return {
      thresholdExceeded: false,
      maxUnsuspendedTabs: activeMaxUnsuspendedTabs,
      currentUnsuspendedCount: 0,
      excessCount: 0,
      candidatesToSuspend: [],
      retainedTabs: [],
      summary: "No tabs to evaluate."
    };
  }

  const threshold = options.maxUnsuspendedTabs !== undefined
    ? (options.maxUnsuspendedTabs === 0 || options.maxUnsuspendedTabs === null || options.maxUnsuspendedTabs === Infinity ? Infinity : Math.max(1, Math.floor(Number(options.maxUnsuspendedTabs))))
    : activeMaxUnsuspendedTabs;

  const getMeta = (tabId) => {
    if (!metadataMap) return {};
    if (metadataMap instanceof Map) return metadataMap.get(tabId) || {};
    return metadataMap[tabId] || {};
  };

  const unsuspendedTabs = [];
  for (const tab of tabs) {
    if (!tab || tab.id === undefined) continue;
    const meta = getMeta(tab.id);
    if (!isTabSuspended(tab, meta)) {
      unsuspendedTabs.push(tab);
    }
  }

  const currentUnsuspendedCount = unsuspendedTabs.length;
  const isExceeded = threshold !== Infinity && currentUnsuspendedCount > threshold;
  const excessCount = isExceeded ? currentUnsuspendedCount - threshold : 0;

  let candidatesToSuspend = [];
  if (excessCount > 0) {
    candidatesToSuspend = selectLruSuspensionCandidates(unsuspendedTabs, metadataMap, {
      ...options,
      count: excessCount
    });
  }

  const candidateIds = new Set(candidatesToSuspend.map(c => c.tabId));
  const retainedTabs = unsuspendedTabs.filter(t => !candidateIds.has(t.id));

  const summary = isExceeded
    ? `Unsuspended tab threshold exceeded: ${currentUnsuspendedCount} unsuspended tabs (limit: ${threshold}). Selected ${candidatesToSuspend.length} LRU tab(s) for suspension.`
    : `Unsuspended tab count within threshold: ${currentUnsuspendedCount} unsuspended tab(s) (limit: ${threshold === Infinity ? "unlimited" : threshold}).`;

  return {
    thresholdExceeded: isExceeded,
    maxUnsuspendedTabs: threshold,
    currentUnsuspendedCount,
    excessCount,
    candidatesToSuspend,
    retainedTabs,
    summary
  };
}

export const UNGROUPED_GROUP_ID = -1;

/**
 * Computes aggregated statistics for tab groups across open tabs.
 *
 * @param {Array<object>} tabs - Open Chrome tabs
 * @param {Map<number, object>|object} [metadataMap] - Tab metadata mapping
 * @param {object} [options={}] - Options (tabGroupNames, protectedGroupIds, protectedGroupNames, groupPriorities)
 * @returns {Map<number, object>} Group ID to Group Statistics Map
 */
export function getTabGroupStats(tabs = [], metadataMap = new Map(), options = {}) {
  const getMeta = (tabId) => {
    if (!metadataMap) return {};
    if (metadataMap instanceof Map) return metadataMap.get(tabId) || {};
    return metadataMap[tabId] || {};
  };

  const groupNames = options.tabGroupNames || {};
  const protectedGroupIds = new Set(options.protectedGroupIds || []);
  const protectedGroupNames = new Set(
    (options.protectedGroupNames || []).map(n => String(n).toLowerCase())
  );
  const groupPriorities = options.groupPriorities || {};

  const statsMap = new Map();

  if (!Array.isArray(tabs)) return statsMap;

  for (const tab of tabs) {
    if (!tab || tab.id === undefined) continue;
    const meta = getMeta(tab.id);
    const rawGroupId = tab.groupId ?? meta.groupId;
    const groupId = (typeof rawGroupId === "number" && rawGroupId > 0) ? rawGroupId : UNGROUPED_GROUP_ID;

    if (!statsMap.has(groupId)) {
      let groupName = "Ungrouped";
      if (groupId !== UNGROUPED_GROUP_ID) {
        groupName = groupNames[groupId] || tab.groupName || meta.groupName || `Group ${groupId}`;
      }
      const isProtected = protectedGroupIds.has(groupId) || protectedGroupNames.has(groupName.toLowerCase());
      const priority = typeof groupPriorities[groupId] === "number" ? groupPriorities[groupId] : 0;

      statsMap.set(groupId, {
        groupId,
        groupName,
        totalTabs: 0,
        unsuspendedTabs: 0,
        suspendedTabs: 0,
        eligibleTabs: 0,
        isProtected,
        priority,
        oldestLastActiveAt: Infinity,
        newestLastActiveAt: 0,
        tabIds: []
      });
    }

    const groupStat = statsMap.get(groupId);
    groupStat.totalTabs++;
    groupStat.tabIds.push(tab.id);

    const suspended = isTabSuspended(tab, meta);
    if (suspended) {
      groupStat.suspendedTabs++;
    } else {
      groupStat.unsuspendedTabs++;
    }

    const lastActive = resolveTabLastActiveAt(tab, meta, 0);
    if (lastActive > 0) {
      groupStat.oldestLastActiveAt = Math.min(groupStat.oldestLastActiveAt, lastActive);
      groupStat.newestLastActiveAt = Math.max(groupStat.newestLastActiveAt, lastActive);
    }

    if (!suspended && !groupStat.isProtected) {
      const eligibility = isTabEligibleForLru(tab, meta, options);
      if (eligibility.eligible) {
        groupStat.eligibleTabs++;
      }
    }
  }

  // Sanitize Infinity if no active timestamps found
  for (const stat of statsMap.values()) {
    if (stat.oldestLastActiveAt === Infinity) {
      stat.oldestLastActiveAt = 0;
    }
  }

  return statsMap;
}

/**
 * Selects candidates for LRU suspension taking Chrome tab groups into account.
 * Supports per-group maximums, minimum group retention, group protection, and balanced eviction.
 *
 * @param {Array<object>} tabs - Open Chrome tabs
 * @param {Map<number, object>|object} [metadataMap] - Tab metadata mapping
 * @param {object} [options={}] - Group-aware options
 * @param {number} [options.count=1] - Maximum candidates to select
 * @param {number} [options.maxTabsPerGroup] - Maximum unsuspended tabs allowed per group
 * @param {number} [options.minRetainedPerGroup=0] - Minimum unsuspended tabs to preserve per group
 * @param {Array<number>} [options.protectedGroupIds] - Group IDs exempt from suspension
 * @param {Array<string>} [options.protectedGroupNames] - Group names exempt from suspension
 * @param {object} [options.groupPriorities] - Group priority map { [groupId]: priorityNumber }
 * @param {'lru'|'balanced'|'prioritized'|'per_group_limit'} [options.strategy='balanced'] - Eviction strategy
 * @param {number} [options.now] - Current timestamp
 * @returns {object} Group-aware selection report
 */
export function selectGroupAwareLruCandidates(tabs = [], metadataMap = new Map(), options = {}) {
  const getMeta = (tabId) => {
    if (!metadataMap) return {};
    if (metadataMap instanceof Map) return metadataMap.get(tabId) || {};
    return metadataMap[tabId] || {};
  };

  const now = options.now || Date.now();
  const requestedCount = typeof options.count === "number" && options.count > 0 ? options.count : 1;
  const minRetained = Math.max(0, Number(options.minRetainedPerGroup) || 0);
  const maxTabsPerGroup = typeof options.maxTabsPerGroup === "number" && options.maxTabsPerGroup > 0
    ? Math.floor(options.maxTabsPerGroup)
    : null;
  const strategy = options.strategy || (maxTabsPerGroup ? "per_group_limit" : "balanced");

  // Get initial group statistics
  const groupStats = getTabGroupStats(tabs, metadataMap, options);

  // Group eligible tabs by groupId
  const groupEligibleTabs = new Map();
  // Track remaining unsuspended tabs per group dynamically
  const remainingUnsuspendedCount = new Map();

  for (const stat of groupStats.values()) {
    groupEligibleTabs.set(stat.groupId, []);
    remainingUnsuspendedCount.set(stat.groupId, stat.unsuspendedTabs);
  }

  for (const tab of tabs) {
    if (!tab || tab.id === undefined) continue;
    const meta = getMeta(tab.id);
    const rawGroupId = tab.groupId ?? meta.groupId;
    const groupId = (typeof rawGroupId === "number" && rawGroupId > 0) ? rawGroupId : UNGROUPED_GROUP_ID;
    const groupStat = groupStats.get(groupId);

    if (groupStat && groupStat.isProtected) continue;
    if (isTabSuspended(tab, meta)) continue;

    const eligibility = isTabEligibleForLru(tab, meta, { ...options, now });
    if (!eligibility.eligible) continue;

    const lastActiveAt = resolveTabLastActiveAt(tab, meta, now);
    const idleMs = Math.max(0, now - lastActiveAt);

    groupEligibleTabs.get(groupId).push({
      tab,
      metadata: meta,
      tabId: tab.id,
      groupId,
      groupName: groupStat ? groupStat.groupName : "Ungrouped",
      title: tab.title || meta.title || "Untitled",
      url: tab.url || meta.url || "",
      lastActiveAt,
      idleMs,
      idleMinutes: Math.floor(idleMs / 60000)
    });
  }

  // Sort eligible tabs within each group by LRU (oldest lastActiveAt first)
  for (const tabList of groupEligibleTabs.values()) {
    tabList.sort((a, b) => a.lastActiveAt - b.lastActiveAt);
  }

  const selectedCandidates = [];

  // Strategy 1: Per-group limits
  if (strategy === "per_group_limit" || maxTabsPerGroup !== null) {
    for (const [groupId, tabList] of groupEligibleTabs.entries()) {
      let currentUnsuspended = remainingUnsuspendedCount.get(groupId) || 0;
      if (maxTabsPerGroup !== null && currentUnsuspended > maxTabsPerGroup) {
        const excessInGroup = currentUnsuspended - maxTabsPerGroup;
        let evictedFromGroup = 0;

        while (tabList.length > 0 && evictedFromGroup < excessInGroup && selectedCandidates.length < requestedCount) {
          if (currentUnsuspended <= minRetained) break;
          const candidate = tabList.shift();
          selectedCandidates.push(candidate);
          evictedFromGroup++;
          currentUnsuspended--;
          remainingUnsuspendedCount.set(groupId, currentUnsuspended);
        }
      }
    }
  }

  // Strategy 2: Prioritized (evict from lowest priority group first)
  if (strategy === "prioritized" && selectedCandidates.length < requestedCount) {
    const sortedGroups = Array.from(groupStats.values())
      .filter(s => !s.isProtected && (groupEligibleTabs.get(s.groupId)?.length || 0) > 0)
      .sort((a, b) => a.priority - b.priority);

    for (const group of sortedGroups) {
      const tabList = groupEligibleTabs.get(group.groupId) || [];
      let currentUnsuspended = remainingUnsuspendedCount.get(group.groupId) || 0;

      while (tabList.length > 0 && selectedCandidates.length < requestedCount) {
        if (currentUnsuspended <= minRetained) break;
        const candidate = tabList.shift();
        selectedCandidates.push(candidate);
        currentUnsuspended--;
        remainingUnsuspendedCount.set(group.groupId, currentUnsuspended);
      }
      if (selectedCandidates.length >= requestedCount) break;
    }
  }

  // Strategy 3: Balanced / Fair Round-Robin (evict from group with most unsuspended tabs)
  if ((strategy === "balanced" || selectedCandidates.length < requestedCount) && strategy !== "per_group_limit") {
    while (selectedCandidates.length < requestedCount) {
      // Find eligible group with the most remaining unsuspended tabs that can still evict
      let bestGroupId = null;
      let maxCount = -1;
      let oldestTimestamp = Infinity;

      for (const [groupId, tabList] of groupEligibleTabs.entries()) {
        if (tabList.length === 0) continue;
        const currentUnsuspended = remainingUnsuspendedCount.get(groupId) || 0;
        if (currentUnsuspended <= minRetained) continue;

        const candidateOldest = tabList[0].lastActiveAt;
        if (currentUnsuspended > maxCount || (currentUnsuspended === maxCount && candidateOldest < oldestTimestamp)) {
          maxCount = currentUnsuspended;
          oldestTimestamp = candidateOldest;
          bestGroupId = groupId;
        }
      }

      if (bestGroupId === null) {
        // No more candidates can be evicted without violating minRetained or exhausting eligible tabs
        break;
      }

      const tabList = groupEligibleTabs.get(bestGroupId);
      const candidate = tabList.shift();
      selectedCandidates.push(candidate);
      const updatedUnsuspended = (remainingUnsuspendedCount.get(bestGroupId) || 1) - 1;
      remainingUnsuspendedCount.set(bestGroupId, updatedUnsuspended);
    }
  }

  // Format candidate descriptors with explanation
  const candidates = selectedCandidates.map(item => {
    const explanation = generateSuspensionExplanation(
      {
        tabId: item.tabId,
        score: Math.min(60, item.idleMinutes),
        isEligible: true,
        factors: {
          idleMinutes: item.idleMinutes,
          idleScore: Math.min(60, item.idleMinutes)
        }
      },
      { trigger: "lru_quota", now }
    );

    return {
      tabId: item.tabId,
      groupId: item.groupId,
      groupName: item.groupName,
      tab: item.tab,
      metadata: item.metadata,
      title: item.title,
      url: item.url,
      lastActiveAt: item.lastActiveAt,
      idleMs: item.idleMs,
      idleMinutes: item.idleMinutes,
      explanation
    };
  });

  const summary = `Group-aware LRU selected ${candidates.length} tab(s) across ${groupStats.size} group(s) using '${strategy}' strategy.`;

  return {
    candidates,
    totalSelected: candidates.length,
    groupStats: Array.from(groupStats.values()),
    remainingUnsuspendedCount: Object.fromEntries(remainingUnsuspendedCount),
    summary
  };
}

/**
 * Computes aggregated statistics across browser windows for open tabs.
 *
 * @param {Array<object>} tabs - Open Chrome tabs
 * @param {Map<number, object>|object} [metadataMap] - Tab metadata mapping
 * @param {object} [options={}] - Options (currentWindowId, protectedWindowIds, protectCurrentWindow)
 * @returns {Map<number, object>} Window ID to Window Statistics Map
 */
export function getWindowStats(tabs = [], metadataMap = new Map(), options = {}) {
  const getMeta = (tabId) => {
    if (!metadataMap) return {};
    if (metadataMap instanceof Map) return metadataMap.get(tabId) || {};
    return metadataMap[tabId] || {};
  };

  const currentWindowId = options.currentWindowId ?? null;
  const protectedWindowIds = new Set(options.protectedWindowIds || []);
  const statsMap = new Map();

  if (!Array.isArray(tabs)) return statsMap;

  for (const tab of tabs) {
    if (!tab || tab.id === undefined) continue;
    const meta = getMeta(tab.id);
    const windowId = tab.windowId ?? meta.windowId ?? 1;

    if (!statsMap.has(windowId)) {
      const isCurrentWindow = currentWindowId !== null && windowId === currentWindowId;
      const isProtected = protectedWindowIds.has(windowId) || Boolean(options.protectCurrentWindow && isCurrentWindow);

      statsMap.set(windowId, {
        windowId,
        isCurrentWindow,
        isProtected,
        totalTabs: 0,
        unsuspendedTabs: 0,
        suspendedTabs: 0,
        eligibleTabs: 0,
        oldestLastActiveAt: Infinity,
        newestLastActiveAt: 0,
        tabIds: []
      });
    }

    const windowStat = statsMap.get(windowId);
    windowStat.totalTabs++;
    windowStat.tabIds.push(tab.id);

    const suspended = isTabSuspended(tab, meta);
    if (suspended) {
      windowStat.suspendedTabs++;
    } else {
      windowStat.unsuspendedTabs++;
    }

    const lastActive = resolveTabLastActiveAt(tab, meta, 0);
    if (lastActive > 0) {
      windowStat.oldestLastActiveAt = Math.min(windowStat.oldestLastActiveAt, lastActive);
      windowStat.newestLastActiveAt = Math.max(windowStat.newestLastActiveAt, lastActive);
    }

    if (!suspended && !windowStat.isProtected) {
      const eligibility = isTabEligibleForLru(tab, meta, options);
      if (eligibility.eligible) {
        windowStat.eligibleTabs++;
      }
    }
  }

  for (const stat of statsMap.values()) {
    if (stat.oldestLastActiveAt === Infinity) {
      stat.oldestLastActiveAt = 0;
    }
  }

  return statsMap;
}

/**
 * Selects candidates for LRU suspension taking browser windows into account.
 * Supports per-window maximums, minimum window retention, focused window protection, and background-first eviction.
 *
 * @param {Array<object>} tabs - Open Chrome tabs
 * @param {Map<number, object>|object} [metadataMap] - Tab metadata mapping
 * @param {object} [options={}] - Window-aware options
 * @param {number} [options.count=1] - Maximum candidates to select
 * @param {number} [options.currentWindowId] - Currently focused window ID
 * @param {boolean} [options.protectCurrentWindow=false] - If true, exempt tabs in current window
 * @param {number} [options.maxTabsPerWindow] - Maximum unsuspended tabs allowed per window
 * @param {number} [options.minRetainedPerWindow=1] - Minimum unsuspended tabs to preserve per window
 * @param {Array<number>} [options.protectedWindowIds] - Window IDs exempt from suspension
 * @param {'lru'|'balanced'|'background_first'|'per_window_limit'} [options.strategy='background_first'] - Eviction strategy
 * @param {number} [options.now] - Current timestamp
 * @returns {object} Window-aware selection report
 */
export function selectWindowAwareLruCandidates(tabs = [], metadataMap = new Map(), options = {}) {
  const getMeta = (tabId) => {
    if (!metadataMap) return {};
    if (metadataMap instanceof Map) return metadataMap.get(tabId) || {};
    return metadataMap[tabId] || {};
  };

  const now = options.now || Date.now();
  const requestedCount = typeof options.count === "number" && options.count > 0 ? options.count : 1;
  const minRetained = Math.max(0, options.minRetainedPerWindow !== undefined ? Number(options.minRetainedPerWindow) : 1);
  const maxTabsPerWindow = typeof options.maxTabsPerWindow === "number" && options.maxTabsPerWindow > 0
    ? Math.floor(options.maxTabsPerWindow)
    : null;
  const strategy = options.strategy || (maxTabsPerWindow ? "per_window_limit" : "background_first");

  const windowStats = getWindowStats(tabs, metadataMap, options);

  const windowEligibleTabs = new Map();
  const remainingUnsuspendedCount = new Map();

  for (const stat of windowStats.values()) {
    windowEligibleTabs.set(stat.windowId, []);
    remainingUnsuspendedCount.set(stat.windowId, stat.unsuspendedTabs);
  }

  for (const tab of tabs) {
    if (!tab || tab.id === undefined) continue;
    const meta = getMeta(tab.id);
    const windowId = tab.windowId ?? meta.windowId ?? 1;
    const winStat = windowStats.get(windowId);

    if (winStat && winStat.isProtected) continue;
    if (isTabSuspended(tab, meta)) continue;

    const eligibility = isTabEligibleForLru(tab, meta, { ...options, now });
    if (!eligibility.eligible) continue;

    const lastActiveAt = resolveTabLastActiveAt(tab, meta, now);
    const idleMs = Math.max(0, now - lastActiveAt);

    windowEligibleTabs.get(windowId).push({
      tab,
      metadata: meta,
      tabId: tab.id,
      windowId,
      isCurrentWindow: winStat ? winStat.isCurrentWindow : false,
      title: tab.title || meta.title || "Untitled",
      url: tab.url || meta.url || "",
      lastActiveAt,
      idleMs,
      idleMinutes: Math.floor(idleMs / 60000)
    });
  }

  // Sort eligible tabs within each window by LRU (oldest lastActiveAt first)
  for (const tabList of windowEligibleTabs.values()) {
    tabList.sort((a, b) => a.lastActiveAt - b.lastActiveAt);
  }

  const selectedCandidates = [];

  // Strategy 1: Per-window limits
  if (strategy === "per_window_limit" || maxTabsPerWindow !== null) {
    for (const [windowId, tabList] of windowEligibleTabs.entries()) {
      let currentUnsuspended = remainingUnsuspendedCount.get(windowId) || 0;
      if (maxTabsPerWindow !== null && currentUnsuspended > maxTabsPerWindow) {
        const excessInWindow = currentUnsuspended - maxTabsPerWindow;
        let evictedFromWindow = 0;

        while (tabList.length > 0 && evictedFromWindow < excessInWindow && selectedCandidates.length < requestedCount) {
          if (currentUnsuspended <= minRetained) break;
          const candidate = tabList.shift();
          selectedCandidates.push(candidate);
          evictedFromWindow++;
          currentUnsuspended--;
          remainingUnsuspendedCount.set(windowId, currentUnsuspended);
        }
      }
    }
  }

  // Strategy 2: Background first (evict all background windows before touching current window)
  if (strategy === "background_first" && selectedCandidates.length < requestedCount) {
    const bgWindows = Array.from(windowStats.values())
      .filter(w => !w.isCurrentWindow && !w.isProtected);
    
    bgWindows.sort((a, b) => (remainingUnsuspendedCount.get(b.windowId) || 0) - (remainingUnsuspendedCount.get(a.windowId) || 0));

    for (const bgWin of bgWindows) {
      const tabList = windowEligibleTabs.get(bgWin.windowId) || [];
      let currentUnsuspended = remainingUnsuspendedCount.get(bgWin.windowId) || 0;

      while (tabList.length > 0 && selectedCandidates.length < requestedCount) {
        if (currentUnsuspended <= minRetained) break;
        const candidate = tabList.shift();
        selectedCandidates.push(candidate);
        currentUnsuspended--;
        remainingUnsuspendedCount.set(bgWin.windowId, currentUnsuspended);
      }
      if (selectedCandidates.length >= requestedCount) break;
    }

    // If still need more candidates and current window is not protected, evict from current window
    if (selectedCandidates.length < requestedCount && options.currentWindowId != null && !options.protectCurrentWindow) {
      const currentWinList = windowEligibleTabs.get(options.currentWindowId) || [];
      let currentUnsuspended = remainingUnsuspendedCount.get(options.currentWindowId) || 0;

      while (currentWinList.length > 0 && selectedCandidates.length < requestedCount) {
        if (currentUnsuspended <= minRetained) break;
        const candidate = currentWinList.shift();
        selectedCandidates.push(candidate);
        currentUnsuspended--;
        remainingUnsuspendedCount.set(options.currentWindowId, currentUnsuspended);
      }
    }
  }

  // Strategy 3: Balanced across windows
  if ((strategy === "balanced" || selectedCandidates.length < requestedCount) && strategy !== "per_window_limit") {
    while (selectedCandidates.length < requestedCount) {
      let bestWindowId = null;
      let maxCount = -1;
      let oldestTimestamp = Infinity;

      for (const [windowId, tabList] of windowEligibleTabs.entries()) {
        if (tabList.length === 0) continue;
        const currentUnsuspended = remainingUnsuspendedCount.get(windowId) || 0;
        if (currentUnsuspended <= minRetained) continue;

        const candidateOldest = tabList[0].lastActiveAt;
        if (currentUnsuspended > maxCount || (currentUnsuspended === maxCount && candidateOldest < oldestTimestamp)) {
          maxCount = currentUnsuspended;
          oldestTimestamp = candidateOldest;
          bestWindowId = windowId;
        }
      }

      if (bestWindowId === null) break;

      const tabList = windowEligibleTabs.get(bestWindowId);
      const candidate = tabList.shift();
      selectedCandidates.push(candidate);
      const updated = (remainingUnsuspendedCount.get(bestWindowId) || 1) - 1;
      remainingUnsuspendedCount.set(bestWindowId, updated);
    }
  }

  const candidates = selectedCandidates.map(item => {
    const explanation = generateSuspensionExplanation(
      {
        tabId: item.tabId,
        score: Math.min(60, item.idleMinutes),
        isEligible: true,
        factors: {
          idleMinutes: item.idleMinutes,
          idleScore: Math.min(60, item.idleMinutes)
        }
      },
      { trigger: "lru_quota", now }
    );

    return {
      tabId: item.tabId,
      windowId: item.windowId,
      isCurrentWindow: item.isCurrentWindow,
      tab: item.tab,
      metadata: item.metadata,
      title: item.title,
      url: item.url,
      lastActiveAt: item.lastActiveAt,
      idleMs: item.idleMs,
      idleMinutes: item.idleMinutes,
      explanation
    };
  });

  const summary = `Window-aware LRU selected ${candidates.length} tab(s) across ${windowStats.size} window(s) using '${strategy}' strategy.`;

  return {
    candidates,
    totalSelected: candidates.length,
    windowStats: Array.from(windowStats.values()),
    remainingUnsuspendedCount: Object.fromEntries(remainingUnsuspendedCount),
    summary
  };
}




