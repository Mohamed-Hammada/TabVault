// TabVault — Background service worker
// Manifest V3 module. Runs ephemerally; persists state in chrome.storage.

import { captureTabScreenshot, canCaptureTabScreenshot } from "./lib/screenshot.js";
import { getRestorationEngine, RestorePriority } from "./lib/restore-engine.js";
import {
  getActiveTabs,
  getSuspendedTabs,
  getRecentlySuspended,
  recordRecentSuspension,
  getRecentlyRestored,
  recordRecentRestoration,
  getDashboardOverview,
  getMemorySavingsBreakdown,
  getSuspensionReasonsBreakdown,
  getTabGroupsSummary,
  getSnapshotAvailability,
  getRestoreFailures,
  recordRestoreFailure,
  getEligibleTabsToSuspend,
  countEligibleTabs,
  isDomainExcluded,
  excludeDomain,
  unexcludeDomain,
  toggleExcludeDomain,
  formatSnapshotDetails,
  deleteSnapshotRecord,
  serializeSession,
  serializeAllSessions,
  parseAndValidateSession,
  mergeSessions,
  parseSuspendedTabInfo
} from "./lib/dashboard-service.js";
import {
  getSessionPersistenceManager,
  getSnapshotOperationTracker,
  getRestorationOperationTracker,
  STORAGE_KEY_ACTIVE_SESSION,
  detectInterruptedSnapshots,
  detectInterruptedRestorations,
  withRecoveryLock,
  recordRecoverySummary,
  getRecoverySummary,
  clearRecoverySummary
} from "./lib/crash-recovery.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const ALARM_TICK = "tabvault-tick";
const ALARM_TICK_PERIOD_MIN = 1; // run rules every minute

// Creates (or re-confirms) the periodic sweep alarm and logs the outcome so
// "the alarm was never created" and "the alarm fires but the callback doesn't
// run" are distinguishable from the console alone.
async function ensureTickAlarm() {
  chrome.alarms.create(ALARM_TICK, { periodInMinutes: ALARM_TICK_PERIOD_MIN });
  try {
    const alarm = await chrome.alarms.get(ALARM_TICK);
    tvLog(`alarm-created name=${ALARM_TICK} periodInMinutes=${ALARM_TICK_PERIOD_MIN} scheduledTime=${alarm ? new Date(alarm.scheduledTime).toISOString() : "MISSING"}`);
  } catch (err) {
    tvLog(`alarm-created name=${ALARM_TICK} verify-error=${err?.message || err}`);
  }
}
const SUSPENDED_PAGE = chrome.runtime.getURL("suspended/suspended.html");
const STORAGE_KEY_SETTINGS = "settings";
const STORAGE_KEY_STATS = "stats";
const STORAGE_KEY_USAGE = "usage"; // for smart-suspension learning
const STORAGE_KEY_SESSIONS = "sessions";
const STORAGE_KEY_RECENT_SUSPENDED = "recent_suspended";
const STORAGE_KEY_RECENT_RESTORED = "recent_restored";
const STORAGE_KEY_RESTORE_FAILURES = "restore_failures";
const STORAGE_KEY_MIGRATIONS = "migrations";
const STORAGE_KEY_PENDING_DISCARDS = "pending_discards"; // { [tabId]: { suspendedUrl, requestedAt, reason } }
const PENDING_DISCARD_STALE_MS = 10 * 60_000; // drop an entry that never resolved after 10 minutes

function tvLog(...args) {
  console.log("[TabVault]", ...args);
}

// Logs every time the service worker script runs — including MV3 wake-from-idle,
// not just extension install/reload. If this line is missing from the console,
// the console was opened on a stale/inactive worker instance, not that nothing ran.
tvLog("service-worker-loaded", new Date().toISOString());

// In-memory tab activity ledger. Rebuilt on service worker wake.
// Map<tabId, { lastActiveAt: epoch_ms, hasFormInput: boolean, audible: boolean, isManuallyProtected: boolean }>
const tabState = new Map();
const manuallyProtectedTabs = new Set();

// Tracks the currently-focused browser window so "active tab" protection only
// applies to the tab the user is actually looking at, not to one tab per
// open window. Rebuilt on service worker wake by refreshFocusedWindowId().
let focusedWindowId = chrome.windows.WINDOW_ID_NONE;

async function refreshFocusedWindowId() {
  try {
    const win = await chrome.windows.getLastFocused({});
    if (win && win.focused) focusedWindowId = win.id;
  } catch (_) { /* ignore */ }
}

// Serializes read-modify-write cycles against a single storage key so concurrent
// callers (e.g. Promise.all'd restoreTab calls in restoreAll) don't clobber each
// other's updates to the same list.
const storageKeyMutexes = new Map();
function withStorageKeyLock(key, fn) {
  const prev = storageKeyMutexes.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  storageKeyMutexes.set(key, next.catch(() => {}));
  return next;
}

function scheduleActiveSessionPersistence() {
  const manager = getSessionPersistenceManager();
  manager.schedulePersist(async () => {
    let windows = [];
    try {
      windows = await chrome.windows.getAll({ populate: true });
    } catch (_) {}
    let groups = [];
    try {
      if (chrome.tabGroups?.query) {
        groups = await chrome.tabGroups.query({});
      }
    } catch (_) {}
    return {
      windows,
      groups,
      tabState,
      manuallyProtectedTabs
    };
  });
}

async function persistActiveSessionNow() {
  const manager = getSessionPersistenceManager();
  return manager.flushPersist(async () => {
    let windows = [];
    try {
      windows = await chrome.windows.getAll({ populate: true });
    } catch (_) {}
    let groups = [];
    try {
      if (chrome.tabGroups?.query) {
        groups = await chrome.tabGroups.query({});
      }
    } catch (_) {}
    return {
      windows,
      groups,
      tabState,
      manuallyProtectedTabs
    };
  });
}

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  enabled: true,

  // Core timing
  suspendAfterMinutes: 30,
  strategy: "replace", // "replace" (full suspended page) | "discard" (Chrome's native)

  // Conditional never-suspend
  neverSuspend: {
    pinned: true,
    audible: true,
    inCall: true,
    hasFormInput: true,
    offline: true,
    onlyTabInWindow: false,
    activeInAnyWindow: true,
    onPowerSource: false, // skip suspension when plugged in
    inTabGroup: false
  },

  // URL filters — multiple match modes
  whitelist: [
    // { mode: "domain"|"contains"|"exact"|"regex"|"glob", value: "..." }
  ],
  blacklist: [], // force-suspend matches even if they'd normally be skipped

  // Meeting-domain safety floor — protects the whole domain by default,
  // independent of detected call state. Not proof a call is active; see
  // lib/call-detection.js for the actual detection logic.
  knownMeetingDomains: [
    "meet.google.com",
    "zoom.us",
    "teams.microsoft.com",
    "teams.live.com",
    "webex.com"
  ],
  meetingDomainExceptions: [],

  // Per-domain rule overrides
  perDomainRules: [
    // { pattern: "github.com", mode: "domain", suspendAfterMinutes: 60, neverSuspend: false, enabled: true }
  ],

  // Battery / power awareness
  power: {
    aggressiveOnBattery: false,
    batterySuspendAfterMinutes: 10
  },

  // Time-of-day schedule
  schedule: {
    enabled: false,
    days: [1, 2, 3, 4, 5], // Mon-Fri
    workStart: "09:00",
    workEnd: "17:00",
    workSuspendAfterMinutes: 15,
    offSuspendAfterMinutes: 90
  },

  // Memory pressure
  memoryPressure: {
    enabled: false,
    thresholdMB: 4096, // when free RAM drops below this, accelerate suspension
    aggressiveSuspendAfterMinutes: 5
  },

  // Smart usage learning
  smart: {
    enabled: true,
    frequentTabMultiplier: 2.0, // tabs visited often get 2x the base timer
    rareTabMultiplier: 0.6,     // rarely-revisited tabs suspend faster
    visitsThreshold: 5
  },

  // Suspended-page appearance
  appearance: {
    theme: "dark", // "dark" | "light" | "auto"
    accent: "#e8956b",
    showLastVisited: true,
    showRestoreHint: true,
    customMessage: "",
    autoRestoreOnFocus: true,
    confirmRestoreForLargePages: false
  },

  // Restoration engine concurrency and resilience
  restoration: {
    maxConcurrentRestorations: 3,
    timeoutMs: 15000,
    maxRetries: 2,
    lazyRestoreBackgroundTabs: true
  },

  // Site-specific state adapters
  adapters: {
    enabled: true,
    disabledAdapters: []
  },

  // Notifications
  notifications: {
    onSuspend: false,
    onMilestone: true // notify on RAM-saved milestones
  }
};

const DEFAULT_STATS = {
  installedAt: 0,
  totalSuspensions: 0,
  totalRestorations: 0,
  estimatedBytesSaved: 0,
  lastMilestoneGB: 0,
  byDomain: {} // { "github.com": { suspensions, lastSuspendedAt } }
};

// ─── Storage helpers ────────────────────────────────────────────────────────

async function getSettings() {
  const { [STORAGE_KEY_SETTINGS]: s } = await chrome.storage.local.get(STORAGE_KEY_SETTINGS);
  return mergeDeep(structuredClone(DEFAULT_SETTINGS), s || {});
}

async function setSettings(patch) {
  const current = await getSettings();
  const next = mergeDeep(current, patch);
  await chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: next });
  return next;
}

async function getStats() {
  const { [STORAGE_KEY_STATS]: s } = await chrome.storage.local.get(STORAGE_KEY_STATS);
  return Object.assign({}, DEFAULT_STATS, s || {});
}

async function setStats(patch) {
  const current = await getStats();
  const next = Object.assign({}, current, patch);
  await chrome.storage.local.set({ [STORAGE_KEY_STATS]: next });
  return next;
}

async function getUsage() {
  const { [STORAGE_KEY_USAGE]: u } = await chrome.storage.local.get(STORAGE_KEY_USAGE);
  return u || {}; // { "host/path-prefix": { visits, totalDwellMs, lastVisitAt } }
}

async function setUsage(map) {
  await chrome.storage.local.set({ [STORAGE_KEY_USAGE]: map });
}

// One-time migrations for existing installs whose settings were already
// persisted to storage before a DEFAULT_SETTINGS change — updating the
// constant alone never touches what's already saved. Each migration runs
// at most once (tracked in STORAGE_KEY_MIGRATIONS) so a user who explicitly
// reverts the setting afterward isn't overridden again next reload.
async function runOneTimeMigrations() {
  const { [STORAGE_KEY_MIGRATIONS]: migrations = {} } = await chrome.storage.local.get(STORAGE_KEY_MIGRATIONS);
  if (migrations.autoRestoreOnFocusDefaultV1) return;

  const { [STORAGE_KEY_SETTINGS]: existing } = await chrome.storage.local.get(STORAGE_KEY_SETTINGS);
  if (existing) {
    const merged = mergeDeep(existing, { appearance: { autoRestoreOnFocus: true } });
    await chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: merged });
  }
  migrations.autoRestoreOnFocusDefaultV1 = true;
  await chrome.storage.local.set({ [STORAGE_KEY_MIGRATIONS]: migrations });
}

function mergeDeep(target, source) {
  if (source === null || typeof source !== "object") return source;
  if (Array.isArray(source)) return source.slice();
  const out = Object.assign({}, target);
  for (const key of Object.keys(source)) {
    out[key] = (key in target && typeof target[key] === "object" && target[key] !== null && !Array.isArray(target[key]))
      ? mergeDeep(target[key], source[key])
      : (typeof source[key] === "object" && source[key] !== null && !Array.isArray(source[key]))
        ? mergeDeep({}, source[key])
        : source[key];
  }
  return out;
}

// ─── URL & rule matching ────────────────────────────────────────────────────

function parseUrl(url) {
  try { return new URL(url); } catch { return null; }
}

// A ctx represents what we know about a tab for matching purposes:
//   { url: string, groupTitle: string|null }
function matchRule(ctx, rule) {
  if (!rule || rule.enabled === false) return false;
  const value = (rule.value ?? rule.pattern ?? "").trim();
  if (!value) return false;
  const target = rule.target || "url";

  if (target === "group") {
    if (!ctx.groupTitle) return false;
    const title = ctx.groupTitle.toLowerCase();
    const v = value.toLowerCase();
    switch (rule.mode) {
      case "contains": return title.includes(v);
      case "exact":
      default:         return title === v;
    }
  }

  // target === "url"
  const url = ctx.url;
  const u = parseUrl(url);
  if (!u) return false;

  switch (rule.mode) {
    case "domain": {
      const host = u.hostname.toLowerCase();
      const t = value.toLowerCase().replace(/^\*\./, "");
      return host === t || host.endsWith("." + t);
    }
    case "exact":
      return url === value;
    case "contains":
      return url.includes(value);
    case "glob":
      return globToRegex(value).test(url);
    case "regex":
      try { return new RegExp(value).test(url); } catch { return false; }
    default:
      return false;
  }
}

function globToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&")
                      .replace(/\*/g, ".*")
                      .replace(/\?/g, ".");
  return new RegExp("^" + escaped + "$");
}

function findPerDomainRule(ctx, rules) {
  return rules.find(r => matchRule(ctx, r));
}

function isWhitelisted(ctx, settings) {
  return settings.whitelist.some(r => matchRule(ctx, r));
}

function isBlacklisted(ctx, settings) {
  return settings.blacklist.some(r => matchRule(ctx, r));
}

async function buildTabContext(tab) {
  let groupTitle = null;
  try {
    if (tab && tab.groupId !== undefined && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
      const g = await chrome.tabGroups.get(tab.groupId);
      groupTitle = g?.title ?? null;
    }
  } catch { /* group may have been removed mid-sweep — ignore */ }
  return { url: tab?.url || "", groupTitle };
}

function isInternalUrl(url) {
  if (!url) return true;
  return url.startsWith("chrome://") ||
         url.startsWith("chrome-extension://") ||
         url.startsWith("edge://") ||
         url.startsWith("about:") ||
         url.startsWith("file://") ||
         url.startsWith("devtools://") ||
         url === "" ||
         url.startsWith(SUSPENDED_PAGE);
}

function isAlreadySuspended(url) {
  return url && url.startsWith(SUSPENDED_PAGE);
}

// ─── Suspension decision logic ──────────────────────────────────────────────

async function getEffectiveTimeoutMs(ctx, settings) {
  // Per-domain (or per-group) rule wins
  const rule = findPerDomainRule(ctx, settings.perDomainRules);
  if (rule) {
    if (rule.neverSuspend) {
      tvLog(`effective-timeout url=${ctx.url} source=per-domain-rule result=neverSuspend`);
      return Infinity;
    }
    if (typeof rule.suspendAfterMinutes === "number") {
      tvLog(`effective-timeout url=${ctx.url} source=per-domain-rule minutes=${rule.suspendAfterMinutes}`);
      return rule.suspendAfterMinutes * 60_000;
    }
  }

  let minutes = settings.suspendAfterMinutes;
  tvLog(`effective-timeout url=${ctx.url} base=${minutes} (settings.suspendAfterMinutes, as loaded from storage)`);

  // Schedule (work hours)
  if (settings.schedule.enabled) {
    const now = new Date();
    const day = now.getDay(); // 0=Sun
    const inDays = settings.schedule.days.includes(day);
    const inHours = isInTimeRange(now, settings.schedule.workStart, settings.schedule.workEnd);
    minutes = (inDays && inHours)
      ? settings.schedule.workSuspendAfterMinutes
      : settings.schedule.offSuspendAfterMinutes;
    tvLog(`effective-timeout url=${ctx.url} schedule-applied inWorkHours=${inDays && inHours} minutes=${minutes}`);
  }

  // Battery aware
  if (settings.power.aggressiveOnBattery) {
    const onBattery = await isOnBattery();
    if (onBattery) {
      minutes = Math.min(minutes, settings.power.batterySuspendAfterMinutes);
      tvLog(`effective-timeout url=${ctx.url} battery-applied minutes=${minutes}`);
    }
  }

  // Memory pressure
  if (settings.memoryPressure.enabled) {
    const free = await getFreeMemoryMB();
    if (free !== null && free < settings.memoryPressure.thresholdMB) {
      minutes = Math.min(minutes, settings.memoryPressure.aggressiveSuspendAfterMinutes);
      tvLog(`effective-timeout url=${ctx.url} memory-pressure-applied freeMB=${free} thresholdMB=${settings.memoryPressure.thresholdMB} minutes=${minutes}`);
    } else {
      tvLog(`effective-timeout url=${ctx.url} memory-pressure-enabled freeMB=${free} thresholdMB=${settings.memoryPressure.thresholdMB} triggered=false`);
    }
  }

  // Smart learning
  if (settings.smart.enabled) {
    const usage = await getUsage();
    const key = usageKeyFor(ctx.url);
    const entry = usage[key];
    if (entry && entry.visits >= settings.smart.visitsThreshold) {
      // Frequent — be lazy about suspending
      minutes *= settings.smart.frequentTabMultiplier;
      tvLog(`effective-timeout url=${ctx.url} smart-frequent visits=${entry.visits} threshold=${settings.smart.visitsThreshold} multiplier=${settings.smart.frequentTabMultiplier} minutes=${minutes}`);
    } else if (entry && entry.visits === 1) {
      // Probably one-off — reclaim sooner
      minutes *= settings.smart.rareTabMultiplier;
      tvLog(`effective-timeout url=${ctx.url} smart-rare visits=1 multiplier=${settings.smart.rareTabMultiplier} minutes=${minutes}`);
    } else {
      tvLog(`effective-timeout url=${ctx.url} smart-no-multiplier visits=${entry?.visits ?? 0} minutes=${minutes}`);
    }
  }

  const finalMinutes = Math.max(1, minutes);
  const finalMs = finalMinutes * 60_000;
  tvLog(`effective-timeout url=${ctx.url} FINAL minutes=${finalMinutes} ms=${finalMs}`);
  return finalMs;
}

function isInTimeRange(date, startStr, endStr) {
  const [sh, sm] = startStr.split(":").map(Number);
  const [eh, em] = endStr.split(":").map(Number);
  const cur = date.getHours() * 60 + date.getMinutes();
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  return start <= end ? (cur >= start && cur < end) : (cur >= start || cur < end);
}

async function isOnBattery() {
  // Use the Battery Status API. Some Chrome builds expose it on service workers,
  // others don't (it's been deprecated for fingerprinting concerns). If it's
  // unavailable we fall back to assuming the device is plugged in, which means
  // battery-aware features simply don't trigger — a safe default.
  try {
    if (typeof navigator !== "undefined" && typeof navigator.getBattery === "function") {
      const battery = await navigator.getBattery();
      return battery.charging === false;
    }
  } catch (_) { /* ignore */ }
  return false;
}

async function getFreeMemoryMB() {
  try {
    const info = await chrome.system.memory.getInfo();
    return Math.round(info.availableCapacity / (1024 * 1024));
  } catch (_) { return null; }
}

function usageKeyFor(url) {
  const u = parseUrl(url);
  if (!u) return url;
  // Group by host + first path segment so different sections of a site count separately
  const seg = (u.pathname || "/").split("/").filter(Boolean)[0] || "";
  return `${u.hostname}/${seg}`;
}

async function shouldSuspend(tab, settings) {
  if (!settings.enabled) return { suspend: false, reason: "disabled" };
  if (!tab.url || isInternalUrl(tab.url)) return { suspend: false, reason: "internal-url" };
  if (isAlreadySuspended(tab.url)) return { suspend: false, reason: "already-suspended" };
  if (tab.discarded) return { suspend: false, reason: "already-discarded" };

  // Build a single context object used by every rule list below.
  const ctx = await buildTabContext(tab);

  // Force-suspend via blacklist bypasses some checks but not internal/active
  const forced = isBlacklisted(ctx, settings);

  if (!forced) {
    if (isWhitelisted(ctx, settings)) return { suspend: false, reason: "whitelisted" };

    const ns = settings.neverSuspend;
    if (ns.pinned && tab.pinned) return { suspend: false, reason: "pinned" };
    if (ns.audible && tab.audible) return { suspend: false, reason: "audible" };

    const state = tabState.get(tab.id);
    if (ns.hasFormInput && state?.hasFormInput) {
      return {
        suspend: false,
        reason: "form-input",
        formInputDetails: state?.formInputDetails || null
      };
    }

    if (ns.offline && !navigator.onLine) return { suspend: false, reason: "offline" };

    if (ns.onPowerSource) {
      const onBattery = await isOnBattery();
      if (!onBattery) return { suspend: false, reason: "on-power" };
    }

    if (ns.inTabGroup && tab.groupId !== undefined && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
      return { suspend: false, reason: "in-group" };
    }

    // Only protect the tab the user is actually looking at (active tab of the
    // focused window). If we haven't learned the focused window yet, fall back
    // to the old, broader behavior so we never wrongly suspend a visible tab.
    if (ns.activeInAnyWindow && tab.active) {
      if (focusedWindowId === chrome.windows.WINDOW_ID_NONE || tab.windowId === focusedWindowId) {
        return { suspend: false, reason: "active" };
      }
    }

    if (ns.onlyTabInWindow) {
      const tabsInWindow = await chrome.tabs.query({ windowId: tab.windowId });
      if (tabsInWindow.length === 1) return { suspend: false, reason: "only-tab" };
    }

    const perDomain = findPerDomainRule(ctx, settings.perDomainRules);
    if (perDomain && perDomain.neverSuspend) {
      return { suspend: false, reason: "per-domain-skip" };
    }
  }

  const last = tabState.get(tab.id)?.lastActiveAt ?? Date.now();
  const idleMs = Date.now() - last;
  const timeoutMs = await getEffectiveTimeoutMs(ctx, settings);
  if (idleMs < timeoutMs) {
    return { suspend: false, reason: "not-idle-enough", idleMs, timeoutMs };
  }
  return { suspend: true, idleMs, timeoutMs };
}

// ─── Suspend & restore actions ──────────────────────────────────────────────

const WAKE_ALARM_PREFIX = "tabvault-wake-";
const STORAGE_KEY_SNOOZED = "snoozedTabs"; // { [tabId]: { wakeAt, originalUrl } }

async function getSnoozed() {
  return (await chrome.storage.local.get(STORAGE_KEY_SNOOZED))[STORAGE_KEY_SNOOZED] || {};
}
async function setSnoozed(map) {
  await chrome.storage.local.set({ [STORAGE_KEY_SNOOZED]: map });
}

function buildSuspendedUrl(tab, opts = {}) {
  const params = new URLSearchParams();
  params.set("u", tab.url);
  if (tab.title) params.set("t", tab.title);
  if (tab.favIconUrl) params.set("f", tab.favIconUrl);
  params.set("at", String(Date.now()));
  if (opts.reason) params.set("r", opts.reason);
  if (opts.wakeAt) params.set("w", String(opts.wakeAt));
  const lastActive = opts.lastActiveAt ?? (typeof tabState !== "undefined" ? tabState.get(tab.id)?.lastActiveAt : undefined) ?? tab.lastAccessed;
  if (lastActive != null) params.set("la", String(lastActive));
  return `${SUSPENDED_PAGE}#${params.toString()}`;
}

async function scheduleWake(tabId, wakeAt) {
  // chrome.alarms.create overwrites any alarm with the same name, so re-snoozing
  // the same tab safely replaces the previous schedule.
  chrome.alarms.create(WAKE_ALARM_PREFIX + tabId, { when: wakeAt });
  const map = await getSnoozed();
  map[tabId] = { wakeAt, scheduledAt: Date.now() };
  await setSnoozed(map);
}

async function clearWake(tabId) {
  try { await chrome.alarms.clear(WAKE_ALARM_PREFIX + tabId); } catch {}
  const map = await getSnoozed();
  if (map[tabId]) {
    delete map[tabId];
    await setSnoozed(map);
  }
}

// ─── Discard-after-replace (real memory reclamation) ───────────────────────
//
// After navigating a tab to suspended.html we don't yet know the navigation has
// actually committed — chrome.tabs.update() resolves on initiation, not on
// commit. Discarding too early risks Chrome remembering the tab's *previous*
// (pre-suspend) URL. Rather than block suspendTab() on an in-memory
// setTimeout/Promise (which is lost if the MV3 service worker is terminated
// mid-wait), we persist a pending-discard record and resolve it from two
// independent, restart-safe triggers: the persistent chrome.tabs.onUpdated
// listener (fast path, fires within the same wake cycle) and the once-a-minute
// sweep tick / onStartup reconciliation (recovery path, survives SW restarts
// and full browser restarts).

async function getPendingDiscards() {
  return (await chrome.storage.local.get(STORAGE_KEY_PENDING_DISCARDS))[STORAGE_KEY_PENDING_DISCARDS] || {};
}
async function setPendingDiscards(map) {
  await chrome.storage.local.set({ [STORAGE_KEY_PENDING_DISCARDS]: map });
}

async function schedulePendingDiscard(tabId, suspendedUrl, reason) {
  await withStorageKeyLock(STORAGE_KEY_PENDING_DISCARDS, async () => {
    const map = await getPendingDiscards();
    map[tabId] = { suspendedUrl, requestedAt: Date.now(), reason: reason || null };
    await setPendingDiscards(map);
  });
}

async function clearPendingDiscard(tabId) {
  await withStorageKeyLock(STORAGE_KEY_PENDING_DISCARDS, async () => {
    const map = await getPendingDiscards();
    if (map[tabId]) {
      delete map[tabId];
      await setPendingDiscards(map);
    }
  });
}

// Attempts to discard a tab whose suspended-page navigation has committed.
// Safe to call redundantly (from the onUpdated fast path AND the sweep-tick
// recovery path) — every branch either discards-and-clears or clears without
// discarding, so a duplicate call is always a no-op on the second pass.
async function discardIfEligible(tabId) {
  const map = await getPendingDiscards();
  const entry = map[tabId];
  if (!entry) return;

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_) {
    tvLog(`suspend:discard-abandoned tabId=${tabId} reason=tab-closed`);
    await clearPendingDiscard(tabId);
    return;
  }

  if (tab.discarded) {
    tvLog(`suspend:discard-abandoned tabId=${tabId} reason=already-discarded`);
    await clearPendingDiscard(tabId);
    return;
  }

  if (tab.url !== entry.suspendedUrl) {
    // User restored (or the tab navigated elsewhere) before we got to discard it.
    tvLog(`suspend:discard-abandoned tabId=${tabId} reason=url-changed`);
    await clearPendingDiscard(tabId);
    return;
  }

  if (tab.status !== "complete") {
    // Navigation hasn't committed yet; leave the pending entry for the next trigger.
    return;
  }

  if (tab.active) {
    // The user is looking at this tab right now — never discard what's on screen.
    tvLog(`suspend:discard-skipped tabId=${tabId} reason=tab-active`);
    await clearPendingDiscard(tabId);
    return;
  }

  if (Date.now() - entry.requestedAt > PENDING_DISCARD_STALE_MS) {
    tvLog(`suspend:discard-abandoned tabId=${tabId} reason=stale`);
    await clearPendingDiscard(tabId);
    return;
  }

  tvLog(`suspend:committed tabId=${tabId} url=${entry.suspendedUrl}`);
  tvLog(`suspend:discard-requested tabId=${tabId}`);
  try {
    await chrome.tabs.discard(tabId);
  } catch (err) {
    tvLog(`suspend:discard-result tabId=${tabId} discarded=false error=${err?.message || err}`);
    await clearPendingDiscard(tabId);
    return;
  }

  let after = null;
  try { after = await chrome.tabs.get(tabId); } catch (_) {}
  tvLog(`suspend:discard-result tabId=${tabId} discarded=${after?.discarded ?? "unknown"} url=${after?.url ?? "unknown"}`);
  await clearPendingDiscard(tabId);
}

// Recovery pass: catches any pending discard whose onUpdated event fired while
// the service worker was asleep (so the fast-path listener never ran), or that
// was already committed before schedulePendingDiscard's listener registration
// took effect. Cheap to run every tick — the map is normally empty.
async function reconcilePendingDiscards() {
  const map = await getPendingDiscards();
  const tabIds = Object.keys(map);
  for (const tabId of tabIds) {
    await discardIfEligible(Number(tabId));
  }
}

async function suspendTab(tabId, opts = {}) {
  const settings = await getSettings();
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return false; }
  if (!tab.url || isInternalUrl(tab.url) || isAlreadySuspended(tab.url)) return false;

  tvLog(`suspend:start tabId=${tabId} reason=${opts.reason || "idle_timeout"} url=${tab.url}`);

  const tracker = getSnapshotOperationTracker();
  await tracker.startSnapshot(tabId, { url: tab.url, stage: "suspending" });

  try {
    // Capture screenshot before suspension where API permissions allow
    let screenshot = opts.screenshot || null;
    if (!screenshot && tab.active) {
      try {
        screenshot = await captureTabScreenshot(tab, { format: "jpeg", quality: 60 });
      } catch (_) {}
    }

    const useDiscard = (opts.strategy ?? settings.strategy) === "discard";
    const wakeAt = (typeof opts.wakeAt === "number" && opts.wakeAt > Date.now()) ? opts.wakeAt : null;

    if (useDiscard) {
      try {
        await chrome.tabs.discard(tabId);
      } catch (e) { return false; }
    } else {
      const suspendedUrl = buildSuspendedUrl(tab, { wakeAt, reason: opts.reason });
      try {
        await chrome.tabs.update(tabId, { url: suspendedUrl });
      } catch (e) { return false; }
      tvLog(`suspend:navigated tabId=${tabId} url=${suspendedUrl}`);

      // Real memory reclamation: once this navigation commits, discard the
      // renderer entirely. Scheduled rather than awaited here — see the
      // "Discard-after-replace" section above for why.
      await schedulePendingDiscard(tabId, suspendedUrl, opts.reason || "idle_timeout");
    }

    // Schedule the wake alarm AFTER the suspend lands, so the right tab id is associated.
    if (wakeAt) await scheduleWake(tabId, wakeAt);

    // Record in recently suspended history
    try {
      const { [STORAGE_KEY_RECENT_SUSPENDED]: existingRecent = [] } = await chrome.storage.local.get(STORAGE_KEY_RECENT_SUSPENDED);
      const nextRecent = recordRecentSuspension({
        tabId: tab.id,
        url: tab.url,
        title: tab.title,
        favIconUrl: tab.favIconUrl,
        reason: opts.reason || "idle_timeout",
        timestamp: Date.now(),
        windowId: tab.windowId,
        groupId: tab.groupId
      }, existingRecent);
      await chrome.storage.local.set({ [STORAGE_KEY_RECENT_SUSPENDED]: nextRecent });
    } catch (_) {}

    // Stats
    const stats = await getStats();
    const host = parseUrl(tab.url)?.hostname || "unknown";
    const byDomain = stats.byDomain || {};
    byDomain[host] = byDomain[host] || { suspensions: 0, lastSuspendedAt: 0 };
    byDomain[host].suspensions++;
    byDomain[host].lastSuspendedAt = Date.now();

    // Heuristic: assume an average page costs ~80MB. Better than nothing.
    const estimatedSaved = stats.estimatedBytesSaved + 80 * 1024 * 1024;
    await setStats({
      totalSuspensions: stats.totalSuspensions + 1,
      estimatedBytesSaved: estimatedSaved,
      byDomain
    });

    if (settings.notifications.onMilestone) {
      const gbSaved = Math.floor(estimatedSaved / (1024 * 1024 * 1024));
      if (gbSaved > stats.lastMilestoneGB && gbSaved > 0) {
        await setStats({ lastMilestoneGB: gbSaved });
        try {
          chrome.notifications.create({
            type: "basic",
            iconUrl: chrome.runtime.getURL("icons/icon128.png"),
            title: "TabVault milestone",
            message: `You've reclaimed about ${gbSaved}GB of memory across ${stats.totalSuspensions + 1} suspensions.`,
            priority: 0
          });
        } catch (_) { /* ignore in some environments */ }
      }
    }
    return true;
  } finally {
    await tracker.finishSnapshot(tabId);
  }
}

async function restoreTab(tabId, options = {}) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { await clearWake(tabId); await clearPendingDiscard(tabId); return false; }
  if (!tab?.url) return false;

  // A restore in progress must never be discarded out from under it.
  await clearPendingDiscard(tabId);

  // Prevent duplicate restoration if the tab is already active and not suspended or discarded
  if (!isAlreadySuspended(tab.url) && !tab.discarded && !options.force) {
    await clearWake(tabId);
    return true;
  }

  tvLog(`restore:start tabId=${tabId} source=${options.source || "unknown"} discarded=${Boolean(tab.discarded)}`);

  const restoreTracker = getRestorationOperationTracker();
  await restoreTracker.startRestoration(tabId, { url: tab.url, source: options.source, priority: options.priority });
  const restoreStartedAt = Date.now();

  try {
    const settings = await getSettings();
    const engine = getRestorationEngine();
    if (settings?.restoration?.maxConcurrentRestorations) {
      try {
        engine.setMaxConcurrentRestorations(settings.restoration.maxConcurrentRestorations);
      } catch (_) {}
    }

    const lazySetting = settings?.restoration?.lazyRestoreBackgroundTabs ?? true;
    const isBackground = !tab.active;

    const res = await engine.restoreTab(tabId, {
      isBackground,
      lazyRestoreBackgroundTabs: lazySetting,
      ...options
    });

    if (res?.deferred) {
      // Restoration deferred until tab is focused by user
      return true;
    }

    if (res?.ok) {
      await clearWake(tabId);
      tvLog(`restore:complete tabId=${tabId} durationMs=${Date.now() - restoreStartedAt}`);
      const stats = await getStats();
      await setStats({ totalRestorations: stats.totalRestorations + 1 });

      // Record in recently restored history
      try {
        let updatedTab = null;
        try { updatedTab = await chrome.tabs.get(tabId); } catch (_) {}
        await withStorageKeyLock(STORAGE_KEY_RECENT_RESTORED, async () => {
          const { [STORAGE_KEY_RECENT_RESTORED]: existingRecent = [] } = await chrome.storage.local.get(STORAGE_KEY_RECENT_RESTORED);
          const nextRecent = recordRecentRestoration({
            tabId,
            url: updatedTab?.url || res?.url || tab.url,
            title: updatedTab?.title || tab.title,
            favIconUrl: updatedTab?.favIconUrl || tab.favIconUrl,
            timestamp: Date.now(),
            durationMs: res?.durationMs || null,
            method: res?.fallback ? "fallback" : "smart",
            windowId: updatedTab?.windowId ?? tab.windowId,
            groupId: updatedTab?.groupId ?? tab.groupId
          }, existingRecent);
          await chrome.storage.local.set({ [STORAGE_KEY_RECENT_RESTORED]: nextRecent });
        });
      } catch (_) {}

      // Clear from stored failed restorations if previously failed
      try {
        const { [STORAGE_KEY_RESTORE_FAILURES]: storedFailures = [] } = await chrome.storage.local.get(STORAGE_KEY_RESTORE_FAILURES);
        const filtered = storedFailures.filter(f => f && f.tabId !== tabId);
        if (filtered.length !== storedFailures.length) {
          await chrome.storage.local.set({ [STORAGE_KEY_RESTORE_FAILURES]: filtered });
        }
      } catch (_) {}

      return true;
    }

    // Record restoration failure in storage for dashboard tracking
    try {
      const { [STORAGE_KEY_RESTORE_FAILURES]: storedFailures = [] } = await chrome.storage.local.get(STORAGE_KEY_RESTORE_FAILURES);
      const failureRecord = engine.getFailedRestoration(tabId) || {
        tabId,
        error: res?.error || "Restoration failed",
        failedAt: Date.now(),
        targetUrl: tab.url,
        title: tab.title,
        attempts: 1,
        retryCount: 1
      };
      const nextFailures = recordRestoreFailure(failureRecord, storedFailures);
      await chrome.storage.local.set({ [STORAGE_KEY_RESTORE_FAILURES]: nextFailures });
    } catch (_) {}

    await clearWake(tabId);
    return false;
  } finally {
    await restoreTracker.finishRestoration(tabId);
  }
}

async function suspendOtherWindows(currentWindowId) {
  // Suspends every suspendable tab that's NOT in the given window.
  const tabs = await chrome.tabs.query({});
  let count = 0;
  for (const tab of tabs) {
    if (tab.windowId === currentWindowId) continue;
    if (await suspendTab(tab.id)) count++;
  }
  return count;
}

async function suspendAllInWindow(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  let count = 0;
  for (const t of tabs) {
    if (!t.active) {
      const ok = await suspendTab(t.id);
      if (ok) count++;
    }
  }
  return count;
}

async function restoreAll(options = {}) {
  const query = options.windowId != null ? { windowId: options.windowId } : {};
  const tabs = await chrome.tabs.query(query);
  const candidateTabs = tabs.filter(t => t.url && (isAlreadySuspended(t.url) || t.discarded));
  if (candidateTabs.length === 0) return 0;

  const settings = await getSettings();
  const lazyEnabled = options.lazy !== undefined
    ? Boolean(options.lazy)
    : (settings?.restoration?.lazyRestoreBackgroundTabs ?? true);

  // Identify currently active tab in current focused window
  const activeTab = tabs.find(t => t.active);

  // Restore active tab immediately if it's among candidates; defer background tabs to avoid unnecessary loading
  const promises = candidateTabs.map(t => {
    const isCurrentActive = activeTab && t.id === activeTab.id;
    if (isCurrentActive) {
      return restoreTab(t.id, {
        source: "user",
        priority: RestorePriority.USER_REQUESTED,
        force: true,
        isBackground: false,
        ...options
      });
    }
    return restoreTab(t.id, {
      source: "batch",
      priority: RestorePriority.BACKGROUND,
      isBackground: true,
      lazy: lazyEnabled,
      ...options
    });
  });

  const results = await Promise.all(promises);
  return results.filter(Boolean).length;
}

// ─── Lifecycle: install, alarms, events ─────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  // Seed settings + stats if missing
  const cur = await chrome.storage.local.get([STORAGE_KEY_SETTINGS, STORAGE_KEY_STATS]);
  if (!cur[STORAGE_KEY_SETTINGS]) {
    await chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: DEFAULT_SETTINGS });
  }
  if (!cur[STORAGE_KEY_STATS]) {
    await chrome.storage.local.set({ [STORAGE_KEY_STATS]: { ...DEFAULT_STATS, installedAt: Date.now() } });
  }
  await runOneTimeMigrations();

  await ensureTickAlarm();
  buildContextMenus();
  refreshFocusedWindowId();

  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html?welcome=1") });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureTickAlarm();
  buildContextMenus();
  refreshFocusedWindowId();
  await runOneTimeMigrations();
  try { await reconcilePendingDiscards(); } catch (_) {}

  // Run the whole startup recovery pass under the crash-recovery lock so an
  // overlapping onInstalled/periodic-sweep recovery can't race on the same
  // pending-operation storage, then record a summary for the UI to surface.
  const lockOutcome = await withRecoveryLock(chrome.storage.local, async () => {
    let remapResult = null;
    try {
      const manager = getSessionPersistenceManager();
      const liveTabs = await chrome.tabs.query({});
      remapResult = await manager.restoreSessionOnStartup({
        liveTabs,
        tabState,
        manuallyProtectedTabs
      });
    } catch (err) {
      console.error("[TabVault] Error during onStartup session restoration:", err);
    }

    let snapshotRecovery = null;
    let restorationRecovery = null;
    try {
      snapshotRecovery = await getSnapshotOperationTracker().checkAndRecoverInterrupted({ tabState });
    } catch (_) {}
    try {
      restorationRecovery = await getRestorationOperationTracker().checkAndRecoverInterrupted({ tabState });
    } catch (_) {}

    return { remapResult, snapshotRecovery, restorationRecovery };
  }, { ttlMs: 60000 });

  if (!lockOutcome.skipped && lockOutcome.result) {
    const { remapResult, snapshotRecovery, restorationRecovery } = lockOutcome.result;
    const remappedCount = remapResult?.remappedCount || 0;
    const orphanCount = remapResult?.orphanCount || 0;
    const recoveredSnapshots = snapshotRecovery?.recoveredCount || 0;
    const recoveredRestorations = restorationRecovery?.recoveredCount || 0;

    // Only worth telling the user about if something was actually interrupted —
    // a normal, clean startup remaps tabs too but that's not a "crash" story.
    if (recoveredSnapshots > 0 || recoveredRestorations > 0 || orphanCount > 0) {
      try {
        await recordRecoverySummary(chrome.storage.local, {
          remappedCount,
          orphanCount,
          recoveredSnapshots,
          recoveredRestorations
        });
      } catch (_) {}
    }
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  tvLog(`alarm-fired name=${alarm.name}`);
  if (alarm.name === ALARM_TICK) {
    await runSweep();
    return;
  }
  if (alarm.name.startsWith(WAKE_ALARM_PREFIX)) {
    const tabId = Number(alarm.name.slice(WAKE_ALARM_PREFIX.length));
    if (Number.isFinite(tabId)) {
      // restoreTab clears the snoozed entry whether or not the restore succeeds
      // (e.g. tab closed while snoozed).
      await restoreTab(tabId);
    }
  }
});

async function runSweep() {
  tvLog("sweep-start");
  const settings = await getSettings();
  if (!settings.enabled) {
    tvLog("sweep-end reason=disabled candidates=0 suspended=0");
    return;
  }

  await refreshFocusedWindowId();

  // Guarded by the same recovery lock as onStartup: if a startup recovery pass is
  // still in flight, this tick's check is simply skipped rather than racing it.
  await withRecoveryLock(chrome.storage.local, async () => {
    try {
      await getSnapshotOperationTracker().checkAndRecoverInterrupted({ tabState });
    } catch (_) {}
    try {
      await getRestorationOperationTracker().checkAndRecoverInterrupted({ tabState });
    } catch (_) {}
  }, { ttlMs: 60000 });

  const tabs = await chrome.tabs.query({});
  let suspendedCount = 0;
  for (const tab of tabs) {
    // Diagnostic snapshot — read-only, computed independently of shouldSuspend()'s
    // own logic so this can't mask or alter the real decision. tabState is the
    // in-memory activity ledger keyed on our own onActivated/onUpdated events; it
    // is rebuilt from scratch on every service-worker wake and is NOT the same
    // as Chrome's own tab.lastAccessed, which is included below for comparison.
    const state = tabState.get(tab.id);
    const hasTabStateEntry = state?.lastActiveAt != null;
    const effectiveLastActiveAt = state?.lastActiveAt ?? Date.now();
    const idleMs = Date.now() - effectiveLastActiveAt;

    let effectiveTimeoutMs = null;
    try {
      const ctx = await buildTabContext(tab);
      effectiveTimeoutMs = await getEffectiveTimeoutMs(ctx, settings);
    } catch (_) {}

    tvLog(
      `sweep-tab tabId=${tab.id}`,
      `url=${tab.url}`,
      `title=${JSON.stringify(tab.title || "")}`,
      `active=${tab.active}`,
      `pinned=${tab.pinned}`,
      `audible=${tab.audible}`,
      `discarded=${tab.discarded}`,
      `chromeLastAccessed=${tab.lastAccessed ?? "n/a"}`,
      `tabStateLastActiveAt=${state?.lastActiveAt ?? "NONE"}`,
      `lastActiveSource=${hasTabStateEntry ? "tabState" : "FALLBACK-TO-NOW (no tabState entry — idle looks like 0)"}`,
      `idleSec=${Math.round(idleMs / 1000)}`,
      `configuredSuspendAfterMinutes=${settings.suspendAfterMinutes}`,
      `effectiveTimeoutSec=${effectiveTimeoutMs != null ? Math.round(effectiveTimeoutMs / 1000) : "n/a"}`
    );

    const decision = await shouldSuspend(tab, settings);

    if (decision.suspend) {
      tvLog(`sweep-tab tabId=${tab.id} idle=${Math.round((decision.idleMs ?? 0) / 1000)}s timeout=${Math.round((decision.timeoutMs ?? 0) / 1000)}s eligible=true`);
      const ok = await suspendTab(tab.id);
      if (ok) suspendedCount++;
    } else {
      const formInputDetails = decision.reason === "form-input" && state?.formInputDetails
        ? ` [form-input: elementType=${state.formInputDetails.elementType} selector=${state.formInputDetails.selector} hasValue=${state.formInputDetails.hasValue} valueChanged=${state.formInputDetails.valueChanged} isUserEditable=${state.formInputDetails.isUserEditable}]`
        : "";
      tvLog(`sweep-skip tabId=${tab.id} reason=${decision.reason}${formInputDetails} idle=${decision.idleMs != null ? Math.round(decision.idleMs / 1000) + "s" : "n/a"} timeout=${decision.timeoutMs != null ? Math.round(decision.timeoutMs / 1000) + "s" : "n/a"}`);
    }
  }

  // Recovery path for discard-after-replace: catches any pending discard whose
  // onUpdated fast-path trigger was missed (e.g. the service worker was asleep
  // when the suspended-page navigation committed).
  try {
    await reconcilePendingDiscards();
  } catch (_) {}

  scheduleActiveSessionPersistence();
  tvLog(`sweep-end candidates=${tabs.length} suspended=${suspendedCount}`);
}

// Manual trigger for debugging from the service worker's own DevTools console
// (chrome://extensions -> TabVault -> "service worker" -> Console tab):
//   tabVaultRunSweep()
// Lets you distinguish "the alarm never fires" from "the alarm fires but the
// sweep exits early" from "the sweep runs but skips every tab" without waiting
// for the real timer.
if (typeof self !== "undefined") {
  self.tabVaultRunSweep = () => runSweep();
}

// Tab activity tracking
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const s = tabState.get(tabId) || {};
  s.lastActiveAt = Date.now();
  tabState.set(tabId, s);
  recordVisit(tabId).catch(() => {});
  scheduleActiveSessionPersistence();

  // The user is now looking at this tab — cancel any not-yet-executed discard
  // immediately, rather than waiting for discardIfEligible's own active-check.
  await clearPendingDiscard(tabId);

  const engine = getRestorationEngine();
  // If tab had its restoration deferred because it was in the background, restore it now that user focused it!
  if (engine.isDeferred(tabId)) {
    tvLog(`restore:start tabId=${tabId} source=user (deferred-trigger)`);
    const deferredStartedAt = Date.now();
    const res = await engine.triggerDeferred(tabId, { source: "user", priority: RestorePriority.USER_REQUESTED });
    if (res?.ok) {
      await clearWake(tabId);
      tvLog(`restore:complete tabId=${tabId} durationMs=${Date.now() - deferredStartedAt}`);
      const stats = await getStats();
      await setStats({ totalRestorations: stats.totalRestorations + 1 });
    }
    return;
  }

  // If user activated tab and autoRestoreOnFocus is enabled, restore with user priority
  try {
    const settings = await getSettings();
    if (settings?.appearance?.autoRestoreOnFocus) {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.url && (isAlreadySuspended(tab.url) || tab.discarded)) {
        await restoreTab(tabId, { source: "user", priority: RestorePriority.USER_REQUESTED });
      }
    }
  } catch (_) {}
});

chrome.tabs.onCreated.addListener((tab) => {
  scheduleActiveSessionPersistence();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const s = tabState.get(tabId) || {};
  if (changeInfo.audible !== undefined) s.audible = changeInfo.audible;
  if (changeInfo.status === "complete") s.lastActiveAt = s.lastActiveAt || Date.now();
  if (changeInfo.url) {
    s.hasFormInput = false;
    s.formInputDetails = null;
  }
  tabState.set(tabId, s);
  scheduleActiveSessionPersistence();

  // If user navigates a suspended tab away, that's a manual restore.
  if (changeInfo.url && !isAlreadySuspended(changeInfo.url)) {
    // nothing, already handled by restore action
  }

  // Fast path for discard-after-replace: fires as soon as the suspended-page
  // navigation commits, usually within the same wake cycle as suspendTab().
  if (changeInfo.status === "complete") {
    discardIfEligible(tabId).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
  manuallyProtectedTabs.delete(tabId);
  clearWake(tabId);
  clearPendingDiscard(tabId);
  scheduleActiveSessionPersistence();
  try {
    getRestorationEngine().cancelRestoration(tabId, "Tab closed");
    getRestorationEngine().cancelDeferred(tabId, "Tab closed");
    getRestorationEngine().clearFailedRestoration(tabId);
  } catch (_) {}
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  focusedWindowId = windowId;
  try {
    const [active] = await chrome.tabs.query({ active: true, windowId });
    if (active) {
      const s = tabState.get(active.id) || {};
      s.lastActiveAt = Date.now();
      tabState.set(active.id, s);
    }
  } catch (_) { /* ignore */ }
});

async function recordVisit(tabId) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  if (!tab.url || isInternalUrl(tab.url)) return;
  const usage = await getUsage();
  const key = usageKeyFor(tab.url);
  const e = usage[key] || { visits: 0, totalDwellMs: 0, lastVisitAt: 0 };
  e.visits++;
  e.lastVisitAt = Date.now();
  usage[key] = e;
  // Cap usage table size to ~1000 entries to bound storage
  const keys = Object.keys(usage);
  if (keys.length > 1000) {
    const sorted = keys.sort((a, b) => (usage[a].lastVisitAt || 0) - (usage[b].lastVisitAt || 0));
    for (const k of sorted.slice(0, keys.length - 1000)) delete usage[k];
  }
  await setUsage(usage);
}

// ─── Commands (keyboard shortcuts) ──────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  switch (command) {
    case "suspend-current-tab":
      if (active) await suspendTab(active.id);
      break;
    case "restore-current-tab":
      if (active) await restoreTab(active.id, { source: "user", priority: RestorePriority.USER_REQUESTED });
      break;
    case "suspend-all-tabs":
      if (active) await suspendAllInWindow(active.windowId);
      break;
    case "restore-all-tabs":
      await restoreAll();
      break;
    case "whitelist-current-domain":
      if (active?.url) {
        const host = parseUrl(active.url)?.hostname;
        if (host) {
          const settings = await getSettings();
          if (!settings.whitelist.some(r => r.mode === "domain" && r.value === host)) {
            settings.whitelist.push({ mode: "domain", value: host, enabled: true });
            await chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: settings });
          }
        }
      }
      break;
    case "open-options":
      chrome.runtime.openOptionsPage();
      break;
  }
});

// ─── Context menus ──────────────────────────────────────────────────────────

function buildContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "tabvault-suspend", title: "Suspend this tab", contexts: ["page", "action"] });
    chrome.contextMenus.create({ id: "tabvault-restore", title: "Restore this tab", contexts: ["page", "action"] });
    chrome.contextMenus.create({ id: "tabvault-protect", title: "Protect this tab from suspension", contexts: ["page", "action"] });
    chrome.contextMenus.create({ id: "tabvault-suspend-eligible", title: "Suspend all eligible tabs", contexts: ["page", "action"] });
    chrome.contextMenus.create({ id: "tabvault-suspend-others", title: "Suspend all other tabs", contexts: ["page", "action"] });
    chrome.contextMenus.create({ id: "tabvault-suspend-window", title: "Suspend all tabs in this window", contexts: ["page", "action"] });
    chrome.contextMenus.create({ id: "tabvault-restore-all", title: "Restore all suspended tabs", contexts: ["page", "action"] });
    chrome.contextMenus.create({ id: "tabvault-sep", type: "separator", contexts: ["page", "action"] });
    chrome.contextMenus.create({ id: "tabvault-whitelist-domain", title: "Never suspend this domain", contexts: ["page", "action"] });
    chrome.contextMenus.create({ id: "tabvault-whitelist-url", title: "Never suspend this exact URL", contexts: ["page", "action"] });
    chrome.contextMenus.create({ id: "tabvault-sep2", type: "separator", contexts: ["page", "action"] });
    chrome.contextMenus.create({ id: "tabvault-options", title: "TabVault settings…", contexts: ["page", "action"] });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab) return;
  switch (info.menuItemId) {
    case "tabvault-suspend":
      await suspendTab(tab.id, { reason: "manual" });
      break;
    case "tabvault-restore":
      await restoreTab(tab.id, { source: "user", userInitiated: true, priority: RestorePriority.USER_REQUESTED });
      break;
    case "tabvault-protect": {
      if (manuallyProtectedTabs.has(tab.id)) {
        manuallyProtectedTabs.delete(tab.id);
        const s = tabState.get(tab.id) || {};
        s.isManuallyProtected = false;
        tabState.set(tab.id, s);
      } else {
        manuallyProtectedTabs.add(tab.id);
        const s = tabState.get(tab.id) || {};
        s.isManuallyProtected = true;
        tabState.set(tab.id, s);
      }
      break;
    }
    case "tabvault-suspend-eligible": {
      const tabs = await chrome.tabs.query({});
      let tabGroups = [];
      if (chrome.tabGroups?.query) {
        try { tabGroups = await chrome.tabGroups.query({}); } catch (_) {}
      }
      const settings = await getSettings();
      const eligible = getEligibleTabsToSuspend(tabs, tabGroups, { settings, tabState, now: Date.now() });
      for (const t of eligible) {
        await suspendTab(t.id, { reason: "batch_eligible" });
      }
      break;
    }
    case "tabvault-suspend-others": {
      const tabs = await chrome.tabs.query({ windowId: tab.windowId });
      for (const t of tabs) if (t.id !== tab.id) await suspendTab(t.id, { reason: "manual" });
      break;
    }
    case "tabvault-suspend-window":
      await suspendAllInWindow(tab.windowId);
      break;
    case "tabvault-restore-all":
      await restoreAll();
      break;
    case "tabvault-whitelist-domain": {
      const host = parseUrl(tab.url)?.hostname;
      if (!host) break;
      const settings = await getSettings();
      if (!settings.whitelist.some(r => r.mode === "domain" && r.value === host)) {
        settings.whitelist.push({ mode: "domain", value: host, enabled: true });
        await chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: settings });
      }
      break;
    }
    case "tabvault-whitelist-url": {
      const settings = await getSettings();
      if (!settings.whitelist.some(r => r.mode === "exact" && r.value === tab.url)) {
        settings.whitelist.push({ mode: "exact", value: tab.url, enabled: true });
        await chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: settings });
      }
      break;
    }
    case "tabvault-options":
      chrome.runtime.openOptionsPage();
      break;
  }
});

// ─── Messaging ──────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "debug-run-sweep":
          await runSweep();
          sendResponse({ ok: true });
          break;
        case "get-settings":
          sendResponse({ ok: true, data: await getSettings() });
          break;
        case "set-settings":
          sendResponse({ ok: true, data: await setSettings(msg.patch || {}) });
          break;
        case "replace-settings":
          await chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: msg.settings });
          sendResponse({ ok: true });
          break;
        case "get-stats":
          sendResponse({ ok: true, data: await getStats() });
          break;
        case "reset-stats":
          await chrome.storage.local.set({ [STORAGE_KEY_STATS]: { ...DEFAULT_STATS, installedAt: Date.now() } });
          sendResponse({ ok: true });
          break;
        case "suspend-tab": {
          const ok = await suspendTab(msg.tabId, {
            strategy: msg.strategy,
            wakeAt: msg.wakeAt,
            reason: msg.reason || "manual",
            force: msg.force ?? true
          });
          sendResponse({
            ok: Boolean(ok),
            error: ok ? undefined : "Tab could not be suspended (may be internal, already suspended, or closed)"
          });
          break;
        }
        case "suspend-current": {
          const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
          const ok = t ? await suspendTab(t.id, { wakeAt: msg.wakeAt, reason: msg.reason || "manual", force: msg.force ?? true }) : false;
          sendResponse({
            ok: Boolean(ok),
            error: ok ? undefined : "Current tab cannot be suspended"
          });
          break;
        }
        case "suspend-all-eligible": {
          const query = msg.windowId != null ? { windowId: msg.windowId } : {};
          const tabs = await chrome.tabs.query(query);
          let tabGroups = [];
          if (chrome.tabGroups?.query) {
            try { tabGroups = await chrome.tabGroups.query({}); } catch (_) {}
          }
          const settings = await getSettings();
          const eligible = getEligibleTabsToSuspend(tabs, tabGroups, {
            settings,
            tabState,
            protectedTabIds: manuallyProtectedTabs,
            now: Date.now()
          });

          let count = 0;
          const errors = [];
          for (const t of eligible) {
            try {
              const ok = await suspendTab(t.id, {
                strategy: msg.strategy,
                reason: msg.reason || "batch_eligible",
                force: false
              });
              if (ok) count++;
            } catch (err) {
              errors.push({ tabId: t.id, error: err?.message || String(err) });
            }
          }

          sendResponse({
            ok: true,
            count,
            eligibleCount: eligible.length,
            skippedCount: eligible.length - count,
            errors
          });
          break;
        }
        case "count-eligible-tabs": {
          const query = msg.windowId != null ? { windowId: msg.windowId } : {};
          const tabs = await chrome.tabs.query(query);
          let tabGroups = [];
          if (chrome.tabGroups?.query) {
            try { tabGroups = await chrome.tabGroups.query({}); } catch (_) {}
          }
          const settings = await getSettings();
          const count = countEligibleTabs(tabs, tabGroups, {
            settings,
            tabState,
            protectedTabIds: manuallyProtectedTabs,
            now: Date.now()
          });
          sendResponse({ ok: true, count });
          break;
        }
        case "suspend-all-window":
          sendResponse({ ok: true, count: await suspendAllInWindow(msg.windowId) });
          break;
        case "suspend-other-windows":
          {
            // Suspend everything not in this window. Useful when focusing on one task.
            const count = await suspendOtherWindows(msg.windowId);
            sendResponse({ ok: true, count });
          }
          break;
        case "count-other-window-tabs":
          {
            // For UI: how many candidate tabs live in other windows, and across how many windows?
            const tabs = await chrome.tabs.query({});
            let tabCount = 0;
            const winIds = new Set();
            for (const t of tabs) {
              if (t.windowId === msg.windowId) continue;
              if (!t.url || isInternalUrl(t.url) || isAlreadySuspended(t.url) || t.discarded) continue;
              tabCount++;
              winIds.add(t.windowId);
            }
            sendResponse({ ok: true, count: tabCount, windowCount: winIds.size });
          }
          break;
        case "count-other-tabs-in-window":
          {
            // For UI: how many suspendable tabs in this window are NOT the active one?
            // Used by the "Suspend all other tabs in this window" affordance.
            const tabs = await chrome.tabs.query({ windowId: msg.windowId });
            let n = 0;
            for (const t of tabs) {
              if (t.active) continue;
              if (!t.url || isInternalUrl(t.url) || isAlreadySuspended(t.url) || t.discarded) continue;
              n++;
            }
            sendResponse({ ok: true, count: n });
          }
          break;
        case "get-snoozed":
          sendResponse({ ok: true, data: await getSnoozed() });
          break;
        case "get-tab-preview":
          {
            let snapshot = null;
            try {
              const { getSnapshotStore } = await import("./lib/snapshot-store.js");
              const store = getSnapshotStore();
              if (msg.snapshotId) {
                snapshot = await store.getSnapshot(msg.snapshotId);
              }
              if (!snapshot && msg.tabId) {
                snapshot = await store.getLatestSnapshot(msg.tabId);
              }
              if (!snapshot && msg.url) {
                const all = await store.getAllLatestSnapshots();
                snapshot = all.find(s => s.url === msg.url || (s.url && s.url.split("#")[0] === msg.url.split("#")[0])) || null;
              }
            } catch (_) {}
            sendResponse({
              ok: true,
              screenshot: snapshot?.screenshot || null,
              reason: snapshot?.reason || null,
              timestamp: snapshot?.timestamp || null
            });
          }
          break;
        case "restore-tab":
          {
            const options = { source: "user", priority: RestorePriority.USER_REQUESTED, ...(msg.options || {}) };
            const ok = await restoreTab(msg.tabId, options);
            const status = getRestorationEngine().getStatus(msg.tabId);
            sendResponse({
              ok,
              tabId: msg.tabId,
              error: ok ? null : (status?.error || "Restoration failed")
            });
          }
          break;
        case "restore-current":
          {
            const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!t) {
              sendResponse({ ok: false, error: "No active tab found" });
              break;
            }
            const options = { source: "user", priority: RestorePriority.USER_REQUESTED, ...(msg.options || {}) };
            const ok = await restoreTab(t.id, options);
            const status = getRestorationEngine().getStatus(t.id);
            sendResponse({
              ok,
              tabId: t.id,
              error: ok ? null : (status?.error || "Restoration failed")
            });
          }
          break;
        case "promote-restore":
          {
            const res = getRestorationEngine().promoteQueuedRestore(msg.tabId, msg.priority || RestorePriority.USER_REQUESTED);
            sendResponse({ ok: !!res?.promoted, data: res });
          }
          break;
        case "get-restoration-status":
          sendResponse({ ok: true, data: getRestorationEngine().getStatus(msg.tabId) });
          break;
        case "cancel-restoration":
          sendResponse({ ok: true, cancelled: getRestorationEngine().cancelRestoration(msg.tabId, msg.reason) });
          break;
        case "retry-restoration":
          {
            const res = await getRestorationEngine().retryRestoration(msg.tabId, msg.options || {});
            sendResponse({ ok: !!res?.ok, result: res });
          }
          break;
        case "retry-all-failed":
          {
            const res = await getRestorationEngine().retryAllFailed(msg.options || {});
            sendResponse({ ok: true, data: res });
          }
          break;
        case "get-restore-failures":
        case "get-failed-restorations":
          {
            const openTabs = await chrome.tabs.query({});
            const liveFailures = getRestorationEngine().getFailedRestorations();
            const { [STORAGE_KEY_RESTORE_FAILURES]: storedFailures = [] } = await chrome.storage.local.get(STORAGE_KEY_RESTORE_FAILURES);

            const mergedMap = new Map();
            for (const f of storedFailures) {
              if (f && f.tabId) mergedMap.set(f.tabId, f);
            }
            for (const f of liveFailures) {
              if (f && f.tabId) mergedMap.set(f.tabId, f);
            }

            const failures = getRestoreFailures(Array.from(mergedMap.values()), openTabs, {
              searchQuery: msg.searchQuery,
              sortBy: msg.sortBy,
              limit: msg.limit
            });
            sendResponse({ ok: true, data: failures, count: failures.length });
          }
          break;
        case "clear-restore-failures":
        case "clear-failed-restorations":
          {
            const count = getRestorationEngine().clearFailedRestorations();
            if (msg.tabId) {
              const { [STORAGE_KEY_RESTORE_FAILURES]: stored = [] } = await chrome.storage.local.get(STORAGE_KEY_RESTORE_FAILURES);
              const filtered = stored.filter(f => f && f.tabId !== msg.tabId);
              await chrome.storage.local.set({ [STORAGE_KEY_RESTORE_FAILURES]: filtered });
            } else {
              await chrome.storage.local.set({ [STORAGE_KEY_RESTORE_FAILURES]: [] });
            }
            sendResponse({ ok: true, count });
          }
          break;
        case "get-all-restoration-statuses":
          sendResponse({ ok: true, data: getRestorationEngine().getAllStatuses() });
          break;
        case "get-restore-queue":
          sendResponse({ ok: true, data: getRestorationEngine().getQueue() });
          break;
        case "clear-restore-queue":
          sendResponse({ ok: true, count: getRestorationEngine().clearQueue(msg.reason) });
          break;
        case "cancel-low-priority":
          {
            const res = getRestorationEngine().cancelLowPriorityRestores(
              msg.maxPriority ?? RestorePriority.LOW,
              msg.reason || "Low-priority restores cancelled",
              msg.options || {}
            );
            sendResponse({ ok: true, data: res });
          }
          break;
        case "get-deferred-restores":
          sendResponse({ ok: true, data: getRestorationEngine().getDeferredTabs() });
          break;
        case "trigger-deferred-restore":
          {
            const res = await getRestorationEngine().triggerDeferred(msg.tabId, msg.options || {});
            sendResponse({ ok: !!res?.ok, result: res });
          }
          break;
        case "cancel-deferred-restore":
          sendResponse({ ok: true, cancelled: getRestorationEngine().cancelDeferred(msg.tabId, msg.reason) });
          break;
        case "clear-deferred-restores":
          sendResponse({ ok: true, count: getRestorationEngine().clearDeferred(msg.reason) });
          break;
        case "get-max-concurrent-restorations":
          sendResponse({ ok: true, max: getRestorationEngine().getMaxConcurrentRestorations() });
          break;
        case "set-max-concurrent-restorations":
          {
            getRestorationEngine().setMaxConcurrentRestorations(msg.max);
            sendResponse({ ok: true, max: getRestorationEngine().getMaxConcurrentRestorations() });
          }
          break;
        case "restore-all":
          sendResponse({ ok: true, count: await restoreAll({ source: "batch", priority: RestorePriority.BACKGROUND, ...(msg.options || {}) }) });
          break;
        case "list-tabs":
          {
            const tabs = await chrome.tabs.query(msg.query || {});
            sendResponse({ ok: true, data: tabs.map(t => ({
              id: t.id, title: t.title, url: t.url, favIconUrl: t.favIconUrl,
              active: t.active, pinned: t.pinned, audible: t.audible,
              discarded: t.discarded, windowId: t.windowId, groupId: t.groupId,
              suspended: !!(t.url && isAlreadySuspended(t.url)),
              lastActiveAt: tabState.get(t.id)?.lastActiveAt || null
            })) });
          }
          break;
        case "get-active-tabs":
          {
            const tabs = await chrome.tabs.query(msg.query || {});
            let tabGroups = [];
            if (chrome.tabGroups?.query) {
              try { tabGroups = await chrome.tabGroups.query({}); } catch (_) {}
            }
            let snapshotMap = null;
            try {
              const { getSnapshotStore } = await import("./lib/snapshot-store.js");
              snapshotMap = await getSnapshotStore().getAllLatestSnapshots();
            } catch (_) {}
            const settings = await getSettings();
            const activeTabs = getActiveTabs(tabs, tabGroups, {
              tabState,
              settings,
              protectedTabIds: manuallyProtectedTabs,
              snapshotMap,
              suspendedPrefix: SUSPENDED_PAGE,
              searchQuery: msg.searchQuery,
              windowId: msg.windowId,
              groupId: msg.groupId,
              filterSnapshot: msg.filterSnapshot,
              sortBy: msg.sortBy
            });
            sendResponse({ ok: true, data: activeTabs, count: activeTabs.length });
          }
          break;
        case "get-suspended-tabs":
          {
            const tabs = await chrome.tabs.query(msg.query || {});
            let tabGroups = [];
            if (chrome.tabGroups?.query) {
              try { tabGroups = await chrome.tabGroups.query({}); } catch (_) {}
            }
            let snapshotMap = null;
            try {
              const { getSnapshotStore } = await import("./lib/snapshot-store.js");
              snapshotMap = await getSnapshotStore().getAllLatestSnapshots();
            } catch (_) {}
            const suspendedTabs = getSuspendedTabs(tabs, tabGroups, {
              suspendedPrefix: SUSPENDED_PAGE,
              snapshotMap,
              searchQuery: msg.searchQuery,
              filterReason: msg.filterReason,
              filterSnapshot: msg.filterSnapshot,
              windowId: msg.windowId,
              groupId: msg.groupId,
              sortBy: msg.sortBy
            });
            sendResponse({ ok: true, data: suspendedTabs, count: suspendedTabs.length });
          }
          break;
        case "get-suspension-reasons":
          {
            const tabs = await chrome.tabs.query({});
            const suspendedTabs = getSuspendedTabs(tabs, [], {
              suspendedPrefix: SUSPENDED_PAGE
            });
            const breakdown = getSuspensionReasonsBreakdown(suspendedTabs);
            sendResponse({ ok: true, data: breakdown });
          }
          break;
        case "get-tab-groups":
          {
            const tabs = await chrome.tabs.query({});
            let tabGroups = [];
            if (chrome.tabGroups?.query) {
              try { tabGroups = await chrome.tabGroups.query({}); } catch (_) {}
            }
            const summary = getTabGroupsSummary(tabGroups, tabs, { suspendedPrefix: SUSPENDED_PAGE });
            sendResponse({ ok: true, data: summary, count: summary.length });
          }
          break;
        case "suspend-group":
          {
            const tabs = await chrome.tabs.query({ groupId: Number(msg.groupId) });
            let tabGroups = [];
            if (chrome.tabGroups?.query) {
              try { tabGroups = await chrome.tabGroups.query({}); } catch (_) {}
            }
            const settings = await getSettings();
            const eligible = getEligibleTabsToSuspend(tabs, tabGroups, {
              settings,
              tabState,
              protectedTabIds: manuallyProtectedTabs,
              now: Date.now()
            });
            let suspendedCount = 0;
            for (const t of eligible) {
              const ok = await suspendTab(t.id, { reason: "group_manual" });
              if (ok) suspendedCount++;
            }
            sendResponse({ ok: true, count: suspendedCount });
          }
          break;
        case "restore-group":
          {
            const tabs = await chrome.tabs.query({ groupId: Number(msg.groupId) });
            let restoredCount = 0;
            for (const t of tabs) {
              if (t.url && isAlreadySuspended(t.url)) {
                const ok = await restoreTab(t.id, { source: "group_restore" });
                if (ok) restoredCount++;
              }
            }
            sendResponse({ ok: true, count: restoredCount });
          }
          break;
        case "get-recently-suspended":
          {
            const { [STORAGE_KEY_RECENT_SUSPENDED]: history = [] } = await chrome.storage.local.get(STORAGE_KEY_RECENT_SUSPENDED);
            const openTabs = await chrome.tabs.query({});
            const recent = getRecentlySuspended(history, openTabs, {
              searchQuery: msg.searchQuery,
              limit: msg.limit
            });
            sendResponse({ ok: true, data: recent, count: recent.length });
          }
          break;
        case "clear-recently-suspended":
          {
            await chrome.storage.local.set({ [STORAGE_KEY_RECENT_SUSPENDED]: [] });
            sendResponse({ ok: true });
          }
          break;
        case "get-recently-restored":
          {
            const { [STORAGE_KEY_RECENT_RESTORED]: history = [] } = await chrome.storage.local.get(STORAGE_KEY_RECENT_RESTORED);
            const openTabs = await chrome.tabs.query({});
            const recent = getRecentlyRestored(history, openTabs, {
              suspendedPrefix: SUSPENDED_PAGE,
              searchQuery: msg.searchQuery,
              limit: msg.limit
            });
            sendResponse({ ok: true, data: recent, count: recent.length });
          }
          break;
        case "clear-recently-restored":
          {
            await chrome.storage.local.set({ [STORAGE_KEY_RECENT_RESTORED]: [] });
            sendResponse({ ok: true });
          }
          break;
        case "get-dashboard-overview":
          {
            const tabs = await chrome.tabs.query({});
            let tabGroups = [];
            if (chrome.tabGroups?.query) {
              try { tabGroups = await chrome.tabGroups.query({}); } catch (_) {}
            }
            let snapshotMap = null;
            try {
              const { getSnapshotStore } = await import("./lib/snapshot-store.js");
              snapshotMap = await getSnapshotStore().getAllLatestSnapshots();
            } catch (_) {}
            const liveFailures = getRestorationEngine().getFailedRestorations();
            const { [STORAGE_KEY_RESTORE_FAILURES]: storedFailures = [] } = await chrome.storage.local.get(STORAGE_KEY_RESTORE_FAILURES);
            const mergedFailuresMap = new Map();
            for (const f of storedFailures) if (f && f.tabId) mergedFailuresMap.set(f.tabId, f);
            for (const f of liveFailures) if (f && f.tabId) mergedFailuresMap.set(f.tabId, f);
            const restoreFailures = Array.from(mergedFailuresMap.values());

            const stats = await getStats();
            const overview = getDashboardOverview(tabs, tabGroups, {
              suspendedPrefix: SUSPENDED_PAGE,
              snapshotMap,
              protectedTabIds: manuallyProtectedTabs,
              restoreFailures,
              stats
            });
            sendResponse({ ok: true, data: overview });
          }
          break;
        case "get-snapshot-availability":
          {
            const tabs = await chrome.tabs.query({});
            let snapshotMap = null;
            try {
              const { getSnapshotStore } = await import("./lib/snapshot-store.js");
              snapshotMap = await getSnapshotStore().getAllLatestSnapshots();
            } catch (_) {}
            const availability = getSnapshotAvailability(tabs, snapshotMap, {
              suspendedPrefix: SUSPENDED_PAGE
            });
            sendResponse({ ok: true, data: availability });
          }
          break;
        case "get-snapshot":
          {
            const { getSnapshotStore } = await import("./lib/snapshot-store.js");
            const store = getSnapshotStore();
            let snapshot = null;
            if (msg.snapshotId) {
              snapshot = await store.getSnapshot(msg.snapshotId);
            }
            if (!snapshot && msg.tabId) {
              snapshot = await store.getLatestSnapshot(Number(msg.tabId));
            }
            if (!snapshot && msg.tabId) {
              try {
                const tab = await chrome.tabs.get(Number(msg.tabId));
                const parsed = parseSuspendedTabInfo(tab);
                if (parsed.snapshotId) {
                  snapshot = await store.getSnapshot(parsed.snapshotId);
                }
              } catch (_) {}
            }
            if (!snapshot) {
              sendResponse({ ok: false, error: "Snapshot not found" });
              break;
            }
            const details = formatSnapshotDetails(snapshot, Date.now());
            sendResponse({ ok: true, data: snapshot, details });
          }
          break;
        case "delete-snapshot":
          {
            const { getSnapshotStore } = await import("./lib/snapshot-store.js");
            const store = getSnapshotStore();
            let deletedCount = 0;
            const respectProtection = msg.force !== true;

            if (msg.snapshotId) {
              const ok = await store.deleteSnapshot(msg.snapshotId, { respectProtection });
              if (ok) deletedCount++;
            } else if (Array.isArray(msg.snapshotIds) && msg.snapshotIds.length > 0) {
              const res = await store.deleteSnapshots(msg.snapshotIds, { respectProtection });
              deletedCount += res.deletedCount;
            } else if (msg.tabId) {
              const tabId = Number(msg.tabId);
              try {
                const tab = await chrome.tabs.get(tabId);
                const parsed = parseSuspendedTabInfo(tab);
                if (parsed.snapshotId) {
                  const ok = await store.deleteSnapshot(parsed.snapshotId, { respectProtection });
                  if (ok) deletedCount++;
                }
              } catch (_) {}
              const tabDeleted = await store.deleteSnapshotsForTab(tabId, { respectProtection });
              if (tabDeleted) deletedCount++;
            }

            sendResponse({
              ok: true,
              deleted: deletedCount > 0,
              deletedCount,
              snapshotId: msg.snapshotId || null,
              tabId: msg.tabId || null
            });
          }
          break;
        case "get-memory-savings-breakdown":
          {
            const tabs = await chrome.tabs.query({});
            const stats = await getStats();
            const breakdown = getMemorySavingsBreakdown(tabs, stats, {
              suspendedPrefix: SUSPENDED_PAGE
            });
            sendResponse({ ok: true, data: breakdown });
          }
          break;
        case "report-form-input":
          {
            const tabId = sender.tab?.id;
            if (tabId !== undefined) {
              const s = tabState.get(tabId) || {};
              const prevHasFormInput = s.hasFormInput;
              s.hasFormInput = !!msg.hasFormInput;
              s.formInputDetails = msg.details || null;
              tabState.set(tabId, s);

              if (msg.hasFormInput && msg.details) {
                tvLog(
                  `form-input detected tabId=${tabId}`,
                  `elementType=${msg.details.elementType}`,
                  `selector=${msg.details.selector}`,
                  `hasValue=${msg.details.hasValue}`,
                  `valueChanged=${msg.details.valueChanged}`,
                  `isUserEditable=${msg.details.isUserEditable}`
                );
              } else if (!msg.hasFormInput && prevHasFormInput) {
                tvLog(`form-input cleared tabId=${tabId}`);
              }
            }
            sendResponse({ ok: true });
          }
          break;
        case "save-session": {
          const { [STORAGE_KEY_SESSIONS]: existing = [] } = await chrome.storage.local.get(STORAGE_KEY_SESSIONS);
          existing.push({ name: msg.name || `Session ${new Date().toLocaleString()}`, savedAt: Date.now(), tabs: msg.tabs });
          await chrome.storage.local.set({ [STORAGE_KEY_SESSIONS]: existing });
          sendResponse({ ok: true });
          break;
        }
        case "list-sessions": {
          const { [STORAGE_KEY_SESSIONS]: existing = [] } = await chrome.storage.local.get(STORAGE_KEY_SESSIONS);
          sendResponse({ ok: true, data: existing });
          break;
        }
        case "delete-session": {
          const { [STORAGE_KEY_SESSIONS]: existing = [] } = await chrome.storage.local.get(STORAGE_KEY_SESSIONS);
          const next = existing.filter((_, i) => i !== msg.index);
          await chrome.storage.local.set({ [STORAGE_KEY_SESSIONS]: next });
          sendResponse({ ok: true });
          break;
        }
        case "export-session": {
          const { [STORAGE_KEY_SESSIONS]: existing = [] } = await chrome.storage.local.get(STORAGE_KEY_SESSIONS);
          if (msg.all) {
            const payload = serializeAllSessions(existing);
            sendResponse({
              ok: true,
              payload,
              json: JSON.stringify(payload, null, 2),
              filename: `tabvault-all-sessions-${new Date().toISOString().slice(0, 10)}.json`
            });
          } else {
            const index = Number(msg.index);
            const session = existing[index] || null;
            if (!session) {
              sendResponse({ ok: false, error: "Session not found" });
              break;
            }
            const payload = serializeSession(session);
            const safeName = (session.name || "session").replace(/[^a-z0-9_-]/gi, "_").toLowerCase().slice(0, 32);
            sendResponse({
              ok: true,
              payload,
              json: JSON.stringify(payload, null, 2),
              filename: `tabvault-session-${safeName}-${new Date().toISOString().slice(0, 10)}.json`
            });
          }
          break;
        }
        case "import-session": {
          const validation = parseAndValidateSession(msg.payload);
          if (!validation.ok || validation.sessions.length === 0) {
            sendResponse({ ok: false, error: validation.error || "No valid sessions in payload" });
            break;
          }
          const { [STORAGE_KEY_SESSIONS]: existing = [] } = await chrome.storage.local.get(STORAGE_KEY_SESSIONS);
          const mergeResult = mergeSessions(existing, validation.sessions, {
            conflictStrategy: msg.conflictStrategy || "append"
          });
          await chrome.storage.local.set({ [STORAGE_KEY_SESSIONS]: mergeResult.sessions });
          sendResponse({
            ok: true,
            importedCount: validation.sessions.length,
            addedCount: mergeResult.addedCount,
            replacedCount: mergeResult.replacedCount,
            skippedCount: mergeResult.skippedCount,
            totalCount: mergeResult.sessions.length
          });
          break;
        }
        case "exclude-domain": {
          let domain = (msg.domain || "").trim().toLowerCase();
          if (!domain && msg.tabId) {
            try {
              const tab = await chrome.tabs.get(msg.tabId);
              domain = tab?.url ? parseUrl(tab.url)?.hostname : "";
            } catch (_) {}
          } else if (!domain && msg.url) {
            domain = parseUrl(msg.url)?.hostname || "";
          }
          domain = (domain || "").trim().toLowerCase();
          if (!domain) {
            sendResponse({ ok: false, error: "Invalid domain" });
            break;
          }
          const settings = await getSettings();
          settings.whitelist = excludeDomain(settings.whitelist, domain);
          await chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: settings });
          sendResponse({ ok: true, domain, isExcluded: true });
          break;
        }
        case "unexclude-domain": {
          let domain = (msg.domain || "").trim().toLowerCase();
          if (!domain && msg.tabId) {
            try {
              const tab = await chrome.tabs.get(msg.tabId);
              domain = tab?.url ? parseUrl(tab.url)?.hostname : "";
            } catch (_) {}
          } else if (!domain && msg.url) {
            domain = parseUrl(msg.url)?.hostname || "";
          }
          domain = (domain || "").trim().toLowerCase();
          if (!domain) {
            sendResponse({ ok: false, error: "Invalid domain" });
            break;
          }
          const settings = await getSettings();
          settings.whitelist = unexcludeDomain(settings.whitelist, domain);
          await chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: settings });
          sendResponse({ ok: true, domain, isExcluded: false });
          break;
        }
        case "toggle-exclude-domain": {
          let domain = (msg.domain || "").trim().toLowerCase();
          if (!domain && msg.tabId) {
            try {
              const tab = await chrome.tabs.get(msg.tabId);
              domain = tab?.url ? parseUrl(tab.url)?.hostname : "";
            } catch (_) {}
          } else if (!domain && msg.url) {
            domain = parseUrl(msg.url)?.hostname || "";
          }
          domain = (domain || "").trim().toLowerCase();
          if (!domain) {
            sendResponse({ ok: false, error: "Invalid domain" });
            break;
          }
          const settings = await getSettings();
          const res = toggleExcludeDomain(settings.whitelist, domain);
          settings.whitelist = res.whitelist;
          await chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: settings });
          sendResponse({ ok: true, domain: res.domain, isExcluded: res.isExcluded });
          break;
        }
        case "is-domain-excluded": {
          let domain = (msg.domain || "").trim().toLowerCase();
          if (!domain && msg.url) {
            domain = parseUrl(msg.url)?.hostname || "";
          }
          domain = (domain || "").trim().toLowerCase();
          const settings = await getSettings();
          sendResponse({ ok: true, domain, isExcluded: isDomainExcluded(domain, settings.whitelist) });
          break;
        }
        case "protect-tab": {
          const tabId = Number(msg.tabId);
          if (!tabId) {
            sendResponse({ ok: false, error: "Invalid tabId" });
            break;
          }
          manuallyProtectedTabs.add(tabId);
          const s = tabState.get(tabId) || {};
          s.isManuallyProtected = true;
          tabState.set(tabId, s);
          if (msg.pinTab) {
            try { await chrome.tabs.update(tabId, { pinned: true }); } catch (_) {}
          }
          sendResponse({ ok: true, tabId, isProtected: true });
          break;
        }
        case "unprotect-tab": {
          const tabId = Number(msg.tabId);
          if (!tabId) {
            sendResponse({ ok: false, error: "Invalid tabId" });
            break;
          }
          manuallyProtectedTabs.delete(tabId);
          const s = tabState.get(tabId) || {};
          s.isManuallyProtected = false;
          tabState.set(tabId, s);
          if (msg.unpinTab) {
            try { await chrome.tabs.update(tabId, { pinned: false }); } catch (_) {}
          }
          sendResponse({ ok: true, tabId, isProtected: false });
          break;
        }
        case "toggle-protect-tab": {
          const tabId = Number(msg.tabId);
          if (!tabId) {
            sendResponse({ ok: false, error: "Invalid tabId" });
            break;
          }
          const isProtected = manuallyProtectedTabs.has(tabId);
          if (isProtected) {
            manuallyProtectedTabs.delete(tabId);
            const s = tabState.get(tabId) || {};
            s.isManuallyProtected = false;
            tabState.set(tabId, s);
            if (msg.unpinTab) {
              try { await chrome.tabs.update(tabId, { pinned: false }); } catch (_) {}
            }
            sendResponse({ ok: true, tabId, isProtected: false });
          } else {
            manuallyProtectedTabs.add(tabId);
            const s = tabState.get(tabId) || {};
            s.isManuallyProtected = true;
            tabState.set(tabId, s);
            if (msg.pinTab) {
              try { await chrome.tabs.update(tabId, { pinned: true }); } catch (_) {}
            }
            sendResponse({ ok: true, tabId, isProtected: true });
          }
          break;
        }
        case "is-tab-protected": {
          const tabId = Number(msg.tabId);
          const isProtected = manuallyProtectedTabs.has(tabId);
          sendResponse({ ok: true, tabId, isProtected });
          break;
        }
        case "persist-active-session": {
          const res = await persistActiveSessionNow();
          sendResponse(res);
          break;
        }
        case "get-active-session": {
          const res = await getSessionPersistenceManager().load();
          sendResponse(res);
          break;
        }
        case "restore-metadata-on-startup": {
          const liveTabs = await chrome.tabs.query({});
          const res = await getSessionPersistenceManager().restoreSessionOnStartup({
            liveTabs,
            tabState,
            manuallyProtectedTabs
          });
          sendResponse(res);
          break;
        }
        case "detect-interrupted-snapshots": {
          const tracker = getSnapshotOperationTracker();
          await tracker.loadFromStorage();
          const pending = tracker.getPendingSnapshots();
          const timeoutMs = typeof msg.timeoutMs === "number" ? msg.timeoutMs : undefined;
          const interrupted = detectInterruptedSnapshots(pending, { timeoutMs });
          sendResponse({ ok: true, detectedCount: interrupted.length, interrupted });
          break;
        }
        case "recover-interrupted-snapshots": {
          const tracker = getSnapshotOperationTracker();
          const res = await tracker.checkAndRecoverInterrupted({ tabState, options: { fallbackState: msg.fallbackState } });
          sendResponse({ ok: true, ...res });
          break;
        }
        case "detect-interrupted-restorations": {
          const tracker = getRestorationOperationTracker();
          await tracker.loadFromStorage();
          const pending = tracker.getPendingRestorations();
          const timeoutMs = typeof msg.timeoutMs === "number" ? msg.timeoutMs : undefined;
          const interrupted = detectInterruptedRestorations(pending, { timeoutMs });
          sendResponse({ ok: true, detectedCount: interrupted.length, interrupted });
          break;
        }
        case "recover-interrupted-restorations": {
          const tracker = getRestorationOperationTracker();
          const res = await tracker.checkAndRecoverInterrupted({
            tabState,
            options: { action: msg.action || "reset" }
          });
          sendResponse({ ok: true, ...res });
          break;
        }
        case "memory-info":
          sendResponse({ ok: true, freeMB: await getFreeMemoryMB(), onBattery: await isOnBattery() });
          break;
        case "get-crash-recovery-summary": {
          const summary = await getRecoverySummary(chrome.storage.local);
          sendResponse({ ok: true, summary });
          break;
        }
        case "dismiss-crash-recovery-summary": {
          await clearRecoverySummary(chrome.storage.local);
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: "unknown-message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // keep channel open for async sendResponse
});
