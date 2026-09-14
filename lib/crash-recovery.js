// TabVault — Crash Recovery & Session Persistence Module
// Provides active session metadata capture, schema validation, persistent storage,
// debounced scheduling, and crash-resilient rehydration.

import { isSuspendedTab } from "./dashboard-service.js";

export const ACTIVE_SESSION_SCHEMA_VERSION = 1;
export const STORAGE_KEY_ACTIVE_SESSION = "tabvault_active_session_state";
export const STORAGE_KEY_SESSION_CHECKPOINTS = "tabvault_session_checkpoints";
export const STORAGE_KEY_CRASH_RECOVERY_LOCK = "tabvault_recovery_lock";
export const STORAGE_KEY_PENDING_SNAPSHOTS = "tabvault_pending_snapshots";
export const STORAGE_KEY_PENDING_RESTORATIONS = "tabvault_pending_restorations";
export const DEFAULT_SNAPSHOT_TIMEOUT_MS = 10000;
export const DEFAULT_RESTORATION_TIMEOUT_MS = 20000;
export const DEFAULT_PERSISTENCE_DEBOUNCE_MS = 1000;
export const MAX_ACTIVE_SESSION_URL_LENGTH = 2048;
export const MAX_ACTIVE_SESSION_TITLE_LENGTH = 256;
export const DEFAULT_RECOVERY_LOCK_TTL_MS = 30000;
export const MAX_SESSION_CHECKPOINTS = 5;
export const STORAGE_KEY_LAST_RECOVERY_SUMMARY = "tabvault_last_recovery_summary";

/**
 * Extracts the original target URL from a tab URL (unwrapping suspended placeholder if present).
 *
 * @param {string} rawUrl
 * @returns {string}
 */
export function extractOriginalTabUrl(rawUrl) {
  if (typeof rawUrl !== "string") return "";
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";

  if (trimmed.includes("suspended/suspended.html#") || trimmed.includes("suspended/suspended.html?")) {
    try {
      const hashIdx = trimmed.indexOf("#");
      const qIdx = trimmed.indexOf("?");
      const paramStr = hashIdx !== -1 ? trimmed.slice(hashIdx + 1) : (qIdx !== -1 ? trimmed.slice(qIdx + 1) : "");
      const params = new URLSearchParams(paramStr);
      const extracted = params.get("u") || params.get("url");
      if (extracted) return extracted.slice(0, MAX_ACTIVE_SESSION_URL_LENGTH);
    } catch (_) {}
  }

  return trimmed.slice(0, MAX_ACTIVE_SESSION_URL_LENGTH);
}

/**
 * Checks if a given URL represents a TabVault suspended page.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isSuspendedUrl(url) {
  if (typeof url !== "string") return false;
  return url.includes("suspended/suspended.html");
}

/**
 * Serializes an individual tab's state for active session persistence.
 *
 * @param {object} tab
 * @param {object} [context={}]
 * @returns {object}
 */
export function serializeActiveTab(tab = {}, context = {}) {
  const tabId = typeof tab.id === "number" ? tab.id : (typeof tab.tabId === "number" ? tab.tabId : -1);
  const rawUrl = (typeof tab.url === "string" ? tab.url : "") || (typeof tab.pendingUrl === "string" ? tab.pendingUrl : "");
  const targetUrl = extractOriginalTabUrl(rawUrl);
  const isSuspended = isSuspendedTab(tab) || isSuspendedUrl(rawUrl);

  const title = (typeof tab.title === "string" ? tab.title.trim() : "").slice(0, MAX_ACTIVE_SESSION_TITLE_LENGTH) || "Untitled Tab";
  const favIconUrl = (typeof tab.favIconUrl === "string" ? tab.favIconUrl.trim() : "").slice(0, 4096);

  const windowId = typeof tab.windowId === "number" ? tab.windowId : (context.windowId ?? null);
  const index = typeof tab.index === "number" ? tab.index : 0;
  const active = Boolean(tab.active);
  const pinned = Boolean(tab.pinned);
  const groupId = typeof tab.groupId === "number" ? tab.groupId : (context.groupId ?? -1);

  // Group details
  const groupTitle = typeof context.groupTitle === "string" ? context.groupTitle : null;
  const groupColor = typeof context.groupColor === "string" ? context.groupColor : null;

  // Lifecycle & timing
  const now = Date.now();
  const lastActiveAt = typeof context.lastActiveAt === "number" && context.lastActiveAt > 0 ? context.lastActiveAt : now;
  const suspendedAt = isSuspended ? (typeof context.suspendedAt === "number" ? context.suspendedAt : now) : null;
  const suspensionReason = isSuspended ? (context.suspensionReason || "idle") : null;

  let lifecycleState = context.lifecycleState;
  if (!lifecycleState) {
    lifecycleState = isSuspended ? "DISCARDED" : (active ? "ACTIVE" : "IDLE");
  }

  const hasFormInput = Boolean(context.hasFormInput);
  const isProtected = Boolean(context.isProtected);
  const snapshotId = typeof context.snapshotId === "string" ? context.snapshotId : null;

  return {
    tabId,
    windowId,
    index,
    active,
    pinned,
    groupId,
    groupTitle,
    groupColor,
    url: targetUrl,
    displayUrl: rawUrl,
    title,
    favIconUrl,
    isSuspended,
    suspensionReason,
    suspendedAt,
    lastActiveAt,
    lifecycleState,
    hasFormInput,
    isProtected,
    snapshotId
  };
}

/**
 * Serializes window state for active session persistence.
 *
 * @param {object} win
 * @returns {object}
 */
export function serializeActiveWindow(win = {}) {
  const id = typeof win.id === "number" ? win.id : -1;
  const focused = Boolean(win.focused);
  const incognito = Boolean(win.incognito);
  const type = win.type || "normal";
  const state = win.state || "normal";
  const bounds = {
    left: typeof win.left === "number" ? win.left : null,
    top: typeof win.top === "number" ? win.top : null,
    width: typeof win.width === "number" ? win.width : null,
    height: typeof win.height === "number" ? win.height : null
  };
  const tabCount = Array.isArray(win.tabs) ? win.tabs.length : 0;

  return {
    id,
    focused,
    incognito,
    type,
    state,
    bounds,
    tabCount
  };
}

/**
 * Serializes tab group metadata for active session persistence.
 *
 * @param {object} group
 * @returns {object}
 */
export function serializeActiveGroup(group = {}) {
  const id = typeof group.id === "number" ? group.id : -1;
  const windowId = typeof group.windowId === "number" ? group.windowId : null;
  const title = (typeof group.title === "string" ? group.title.trim() : "").slice(0, 128);
  const color = typeof group.color === "string" ? group.color : "grey";
  const collapsed = Boolean(group.collapsed);

  return {
    id,
    windowId,
    title,
    color,
    collapsed
  };
}

/**
 * Captures comprehensive active session metadata from windows, tabs, groups, and activity ledgers.
 *
 * @param {object} params
 * @param {Array<object>} [params.windows=[]]
 * @param {Array<object>} [params.tabs=[]]
 * @param {Array<object>} [params.groups=[]]
 * @param {Map<number, object>} [params.tabState]
 * @param {Set<number>} [params.manuallyProtectedTabs]
 * @param {object} [params.metadataStore]
 * @param {object} [params.snapshotStore]
 * @param {object} [params.options={}]
 * @returns {object}
 */
export function captureActiveSessionMetadata({
  windows = [],
  tabs = [],
  groups = [],
  tabState = new Map(),
  manuallyProtectedTabs = new Set(),
  metadataStore = null,
  snapshotStore = null,
  options = {}
} = {}) {
  const now = Date.now();
  const sessionId = options.sessionId || `session_${now}_${Math.random().toString(36).slice(2, 8)}`;

  // Build group lookup map: groupId -> group
  const groupMap = new Map();
  const serializedGroups = [];
  if (Array.isArray(groups)) {
    for (const g of groups) {
      if (g && typeof g.id === "number") {
        const ser = serializeActiveGroup(g);
        serializedGroups.push(ser);
        groupMap.set(g.id, ser);
      }
    }
  }

  // Build windows list
  const serializedWindows = [];
  let tabSource = Array.isArray(tabs) ? [...tabs] : [];

  if (Array.isArray(windows) && windows.length > 0) {
    for (const w of windows) {
      if (!w) continue;
      serializedWindows.push(serializeActiveWindow(w));
      if (Array.isArray(w.tabs) && tabSource.length === 0) {
        tabSource.push(...w.tabs);
      }
    }
  }

  // Serialize tabs
  const serializedTabs = [];
  let activeTabCount = 0;
  let suspendedTabCount = 0;

  for (const t of tabSource) {
    if (!t) continue;
    const tid = t.id ?? t.tabId;
    const inMemoryActivity = tid != null && tabState ? (tabState.get(tid) || {}) : {};
    const metaRecord = (tid != null && metadataStore && typeof metadataStore.get === "function")
      ? metadataStore.get(tid)
      : null;

    const group = t.groupId != null && groupMap.has(t.groupId) ? groupMap.get(t.groupId) : null;
    const isProtected = tid != null && manuallyProtectedTabs ? (manuallyProtectedTabs.has(tid) || Boolean(inMemoryActivity.isManuallyProtected)) : false;

    const context = {
      windowId: t.windowId,
      groupId: t.groupId,
      groupTitle: group?.title || null,
      groupColor: group?.color || null,
      lastActiveAt: inMemoryActivity.lastActiveAt || metaRecord?.lastActiveAt || (t.active ? now : (now - 300000)),
      suspendedAt: metaRecord?.lastSuspendedAt || inMemoryActivity.suspendedAt || null,
      suspensionReason: metaRecord?.suspensionReason || inMemoryActivity.suspensionReason || null,
      lifecycleState: metaRecord?.lifecycleState || inMemoryActivity.lifecycleState || null,
      hasFormInput: Boolean(inMemoryActivity.hasFormInput),
      isProtected,
      snapshotId: metaRecord?.snapshotId || null
    };

    const serTab = serializeActiveTab(t, context);
    if (serTab.isSuspended) {
      suspendedTabCount++;
    } else {
      activeTabCount++;
    }
    serializedTabs.push(serTab);
  }

  // If no windows array was passed but tabs had windowIds, synthesize windows
  if (serializedWindows.length === 0 && serializedTabs.length > 0) {
    const windowIds = [...new Set(serializedTabs.map(t => t.windowId).filter(id => id != null))];
    for (const wid of windowIds) {
      const winTabs = serializedTabs.filter(t => t.windowId === wid);
      serializedWindows.push(serializeActiveWindow({
        id: wid,
        focused: winTabs.some(t => t.active),
        tabs: winTabs
      }));
    }
  }

  return {
    schemaVersion: ACTIVE_SESSION_SCHEMA_VERSION,
    sessionId,
    savedAt: now,
    savedAtIso: new Date(now).toISOString(),
    windowCount: serializedWindows.length,
    tabCount: serializedTabs.length,
    activeTabCount,
    suspendedTabCount,
    windows: serializedWindows,
    groups: serializedGroups,
    tabs: serializedTabs,
    metadata: {
      tabStateCount: tabState instanceof Map ? tabState.size : 0,
      protectedTabCount: manuallyProtectedTabs instanceof Set ? manuallyProtectedTabs.size : 0,
      hasMetadataStore: Boolean(metadataStore),
      hasSnapshotStore: Boolean(snapshotStore),
      customNote: options.note || null
    }
  };
}

/**
 * Validates an active session payload schema.
 *
 * @param {any} payload
 * @returns {{ ok: boolean, session?: object, error?: string }}
 */
export function validateActiveSessionMetadata(payload) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Active session payload must be a non-null object" };
  }

  if (payload.schemaVersion !== ACTIVE_SESSION_SCHEMA_VERSION) {
    return { ok: false, error: `Unsupported schema version: ${payload.schemaVersion} (expected ${ACTIVE_SESSION_SCHEMA_VERSION})` };
  }

  if (!Array.isArray(payload.tabs)) {
    return { ok: false, error: "Active session payload must contain a tabs array" };
  }

  if (!Array.isArray(payload.windows)) {
    return { ok: false, error: "Active session payload must contain a windows array" };
  }

  const validTabs = [];
  for (let i = 0; i < payload.tabs.length; i++) {
    const t = payload.tabs[i];
    if (!t || typeof t !== "object") continue;
    if (typeof t.url !== "string" || !t.url.trim()) continue;
    validTabs.push(t);
  }

  const session = {
    ...payload,
    tabs: validTabs,
    tabCount: validTabs.length,
    activeTabCount: validTabs.filter(t => !t.isSuspended).length,
    suspendedTabCount: validTabs.filter(t => t.isSuspended).length
  };

  return { ok: true, session };
}

/**
 * Computes a match score between a live tab and a persisted tab candidate.
 *
 * @param {object} liveTab
 * @param {string} liveTargetUrl
 * @param {object} persistedTab
 * @returns {number} Higher score indicates stronger correlation
 */
export function scoreTabMatch(liveTab = {}, liveTargetUrl = "", persistedTab = {}) {
  if (!persistedTab || typeof persistedTab !== "object") return 0;
  const pUrl = (persistedTab.url || "").trim();
  const lUrl = (liveTargetUrl || "").trim();

  let score = 0;
  const urlExactMatch = Boolean(lUrl && pUrl && lUrl.toLowerCase() === pUrl.toLowerCase());

  if (urlExactMatch) {
    score += 10;
  } else if (lUrl && pUrl) {
    try {
      const lHost = new URL(lUrl).hostname.toLowerCase();
      const pHost = new URL(pUrl).hostname.toLowerCase();
      if (lHost === pHost) {
        score += 3;
      }
    } catch (_) {}
  }

  if (score === 0) return 0; // Must at least share hostname or exact URL

  // Relative index within window
  if (typeof liveTab.index === "number" && typeof persistedTab.index === "number") {
    if (liveTab.index === persistedTab.index) {
      score += 4;
    } else if (Math.abs(liveTab.index - persistedTab.index) <= 1) {
      score += 2;
    }
  }

  // Window correlation
  if (liveTab.windowId != null && persistedTab.windowId != null && liveTab.windowId === persistedTab.windowId) {
    score += 2;
  }

  // Title correlation
  const lTitle = (liveTab.title || "").trim().toLowerCase();
  const pTitle = (persistedTab.title || "").trim().toLowerCase();
  if (lTitle && pTitle && lTitle === pTitle) {
    score += 3;
  }

  // Pinned match
  if (Boolean(liveTab.pinned) === Boolean(persistedTab.pinned)) {
    score += 2;
  }

  // Suspended match
  const liveIsSuspended = isSuspendedTab(liveTab) || isSuspendedUrl(liveTab.url || liveTab.pendingUrl);
  if (liveIsSuspended === Boolean(persistedTab.isSuspended)) {
    score += 3;
  }

  // Group correlation
  if (typeof liveTab.groupId === "number" && typeof persistedTab.groupId === "number" && liveTab.groupId !== -1) {
    if (liveTab.groupId === persistedTab.groupId) {
      score += 2;
    }
  }

  return score;
}

/**
 * Re-maps persisted session metadata to live tabs after a browser restart.
 *
 * @param {object} params
 * @param {Array<object>} [params.liveTabs=[]]
 * @param {object} [params.persistedSession]
 * @param {object} [params.metadataStore]
 * @param {Map<number, object>} [params.tabState]
 * @param {Set<number>} [params.manuallyProtectedTabs]
 * @param {object} [params.options={}]
 * @returns {{ ok: boolean, totalLiveTabs: number, totalPersistedTabs: number, remappedCount: number, recoveredTabs: Array<object>, unmappedLiveTabs: Array<object>, orphans: Array<object>, orphanCount: number }}
 */
export function remapSessionMetadataOnStartup({
  liveTabs = [],
  persistedSession = null,
  metadataStore = null,
  tabState = null,
  manuallyProtectedTabs = null,
  options = {}
} = {}) {
  const persistedTabs = Array.isArray(persistedSession?.tabs) ? [...persistedSession.tabs] : [];
  const availablePersisted = [...persistedTabs];
  const recoveredTabs = [];
  const unmappedLiveTabs = [];

  for (const liveTab of liveTabs) {
    if (!liveTab || liveTab.id == null) continue;
    const rawLiveUrl = liveTab.url || liveTab.pendingUrl || "";
    const targetUrl = extractOriginalTabUrl(rawLiveUrl);
    const liveIsSuspended = isSuspendedTab(liveTab) || isSuspendedUrl(rawLiveUrl);

    let bestScore = -1;
    let bestIndex = -1;

    for (let i = 0; i < availablePersisted.length; i++) {
      const pTab = availablePersisted[i];
      const score = scoreTabMatch(liveTab, targetUrl, pTab);
      if (score > bestScore && score >= 5) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (bestIndex >= 0) {
      const [matched] = availablePersisted.splice(bestIndex, 1);
      const oldTabId = matched.tabId;
      const newTabId = liveTab.id;

      // Update in-memory tabState
      if (tabState instanceof Map) {
        tabState.set(newTabId, {
          lastActiveAt: matched.lastActiveAt || Date.now(),
          hasFormInput: Boolean(matched.hasFormInput),
          audible: Boolean(liveTab.audible),
          isManuallyProtected: Boolean(matched.isProtected),
          suspendedAt: matched.suspendedAt || null,
          suspensionReason: matched.suspensionReason || null,
          lifecycleState: liveIsSuspended ? "DISCARDED" : (liveTab.active ? "ACTIVE" : "IDLE")
        });
      }

      // Update manually protected set
      if (matched.isProtected && manuallyProtectedTabs instanceof Set) {
        manuallyProtectedTabs.add(newTabId);
      }

      // Update metadataStore
      if (metadataStore && typeof metadataStore.set === "function") {
        if (oldTabId !== newTabId && typeof metadataStore.remove === "function") {
          metadataStore.remove(oldTabId);
        }
        metadataStore.set(newTabId, {
          ...matched,
          tabId: newTabId,
          windowId: liveTab.windowId ?? matched.windowId,
          url: targetUrl,
          title: liveTab.title || matched.title,
          isProtected: Boolean(matched.isProtected),
          lifecycleState: liveIsSuspended ? "DISCARDED" : (liveTab.active ? "ACTIVE" : "IDLE")
        });
      }

      recoveredTabs.push({
        newTabId,
        oldTabId,
        matchScore: bestScore,
        url: targetUrl,
        title: liveTab.title || matched.title,
        isSuspended: liveIsSuspended,
        isProtected: Boolean(matched.isProtected),
        lastActiveAt: matched.lastActiveAt
      });
    } else {
      // Live tab without a matching persisted record
      if (tabState instanceof Map) {
        tabState.set(liveTab.id, {
          lastActiveAt: Date.now(),
          hasFormInput: false,
          audible: Boolean(liveTab.audible),
          isManuallyProtected: false,
          lifecycleState: liveIsSuspended ? "DISCARDED" : (liveTab.active ? "ACTIVE" : "IDLE")
        });
      }

      if (metadataStore && typeof metadataStore.set === "function") {
        metadataStore.set(liveTab.id, {
          tabId: liveTab.id,
          windowId: liveTab.windowId,
          groupId: liveTab.groupId,
          url: targetUrl,
          title: liveTab.title || "Untitled Tab",
          lastActiveAt: Date.now(),
          lifecycleState: liveIsSuspended ? "DISCARDED" : (liveTab.active ? "ACTIVE" : "IDLE")
        });
      }

      unmappedLiveTabs.push({
        tabId: liveTab.id,
        url: targetUrl,
        title: liveTab.title
      });
    }
  }

  // Remaining unassigned persisted tabs are orphans
  const orphans = availablePersisted;
  if (options.purgeOrphaned && metadataStore && typeof metadataStore.remove === "function") {
    for (const orphan of orphans) {
      if (orphan.tabId != null) {
        metadataStore.remove(orphan.tabId);
      }
    }
  }

  return {
    ok: true,
    totalLiveTabs: liveTabs.length,
    totalPersistedTabs: persistedTabs.length,
    remappedCount: recoveredTabs.length,
    recoveredTabs,
    unmappedLiveTabs,
    orphans,
    orphanCount: orphans.length
  };
}

/**
 * Attempts to acquire the crash-recovery lock, preventing concurrent recovery runs
 * (e.g. `onStartup` and `onInstalled` firing close together, or an overlapping
 * periodic sweep) from racing on the same pending-operation storage. A lock older
 * than `ttlMs` is considered abandoned (its holder likely crashed mid-recovery)
 * and can be stolen, so a bad crash can never permanently wedge recovery.
 *
 * @param {object} storageAdapter
 * @param {object} [options={}]
 * @param {number} [options.ttlMs]
 * @param {number} [options.now]
 * @param {string} [options.lockId]
 * @returns {Promise<{ ok: boolean, acquired: boolean, lockId?: string, holder?: string, acquiredAt?: number, error?: string }>}
 */
export async function acquireRecoveryLock(storageAdapter, options = {}) {
  if (!storageAdapter) return { ok: true, acquired: true, lockId: null };
  const ttlMs = typeof options.ttlMs === "number" ? options.ttlMs : DEFAULT_RECOVERY_LOCK_TTL_MS;
  const now = typeof options.now === "number" ? options.now : Date.now();
  const lockId = options.lockId || `lock_${now}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    const res = await storageAdapter.get(STORAGE_KEY_CRASH_RECOVERY_LOCK);
    const existing = res?.[STORAGE_KEY_CRASH_RECOVERY_LOCK];
    if (existing && typeof existing.acquiredAt === "number" && (now - existing.acquiredAt) < ttlMs) {
      return { ok: true, acquired: false, holder: existing.lockId, acquiredAt: existing.acquiredAt };
    }
    await storageAdapter.set({ [STORAGE_KEY_CRASH_RECOVERY_LOCK]: { lockId, acquiredAt: now } });
    return { ok: true, acquired: true, lockId };
  } catch (err) {
    return { ok: false, acquired: false, error: err?.message || String(err) };
  }
}

/**
 * Releases the crash-recovery lock, but only if it is still held by `lockId`
 * (or no `lockId` is given) so a stolen/expired lock isn't accidentally cleared
 * out from under whoever stole it.
 *
 * @param {object} storageAdapter
 * @param {string} [lockId]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function releaseRecoveryLock(storageAdapter, lockId) {
  if (!storageAdapter) return { ok: true };
  try {
    const res = await storageAdapter.get(STORAGE_KEY_CRASH_RECOVERY_LOCK);
    const existing = res?.[STORAGE_KEY_CRASH_RECOVERY_LOCK];
    if (!existing || !lockId || existing.lockId === lockId) {
      if (typeof storageAdapter.remove === "function") {
        await storageAdapter.remove(STORAGE_KEY_CRASH_RECOVERY_LOCK);
      } else {
        await storageAdapter.set({ [STORAGE_KEY_CRASH_RECOVERY_LOCK]: null });
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Runs `fn` while holding the crash-recovery lock; skips it entirely (rather than
 * waiting) if another run already holds a live lock, since recovery is safe to
 * defer to whichever caller already has it in flight.
 *
 * @param {object} storageAdapter
 * @param {function} fn
 * @param {object} [options={}]
 * @returns {Promise<{ ok: boolean, skipped: boolean, reason?: string, holder?: string, result?: any }>}
 */
export async function withRecoveryLock(storageAdapter, fn, options = {}) {
  const lockRes = await acquireRecoveryLock(storageAdapter, options);
  if (!lockRes.ok) {
    return { ok: false, skipped: true, reason: "lock_error", error: lockRes.error };
  }
  if (!lockRes.acquired) {
    return { ok: true, skipped: true, reason: "lock_held", holder: lockRes.holder };
  }
  try {
    const result = await fn();
    return { ok: true, skipped: false, result };
  } finally {
    await releaseRecoveryLock(storageAdapter, lockRes.lockId);
  }
}

/**
 * Builds a rotating checkpoint record wrapping a validated active-session payload.
 *
 * @param {object} sessionPayload
 * @returns {object}
 */
export function buildSessionCheckpoint(sessionPayload) {
  return {
    checkpointId: `cp_${sessionPayload.savedAt}_${Math.random().toString(36).slice(2, 7)}`,
    savedAt: sessionPayload.savedAt,
    tabCount: sessionPayload.tabCount,
    windowCount: sessionPayload.windowCount,
    session: sessionPayload
  };
}

/**
 * Appends a session checkpoint to the rotating checkpoint history, trimming to the
 * most recent `maxCheckpoints`. Checkpoints are a secondary fallback distinct from
 * the single primary active-session record: if a crash corrupts or truncates that
 * one write, the most recent valid checkpoint is still recoverable.
 *
 * @param {object} storageAdapter
 * @param {object} sessionPayload
 * @param {object} [options={}]
 * @returns {Promise<{ ok: boolean, checkpointId?: string, count?: number, error?: string }>}
 */
export async function appendSessionCheckpoint(storageAdapter, sessionPayload, options = {}) {
  if (!storageAdapter) return { ok: false, error: "No storage adapter configured" };
  const maxCheckpoints = typeof options.maxCheckpoints === "number" ? options.maxCheckpoints : MAX_SESSION_CHECKPOINTS;
  try {
    const res = await storageAdapter.get(STORAGE_KEY_SESSION_CHECKPOINTS);
    const existing = Array.isArray(res?.[STORAGE_KEY_SESSION_CHECKPOINTS]) ? res[STORAGE_KEY_SESSION_CHECKPOINTS] : [];
    const checkpoint = buildSessionCheckpoint(sessionPayload);
    const next = [...existing, checkpoint].slice(-maxCheckpoints);
    await storageAdapter.set({ [STORAGE_KEY_SESSION_CHECKPOINTS]: next });
    return { ok: true, checkpointId: checkpoint.checkpointId, count: next.length };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Returns the most recent checkpoint whose wrapped session still validates, walking
 * backward through history so a corrupted latest checkpoint doesn't block recovery
 * entirely.
 *
 * @param {object} storageAdapter
 * @returns {Promise<{ checkpoint: object, session: object } | null>}
 */
export async function getLatestValidSessionCheckpoint(storageAdapter) {
  if (!storageAdapter) return null;
  try {
    const res = await storageAdapter.get(STORAGE_KEY_SESSION_CHECKPOINTS);
    const list = Array.isArray(res?.[STORAGE_KEY_SESSION_CHECKPOINTS]) ? res[STORAGE_KEY_SESSION_CHECKPOINTS] : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const cp = list[i];
      const validation = validateActiveSessionMetadata(cp?.session);
      if (validation.ok) return { checkpoint: cp, session: validation.session };
    }
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Clears all rotating session checkpoints.
 *
 * @param {object} storageAdapter
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function clearSessionCheckpoints(storageAdapter) {
  if (!storageAdapter) return { ok: false, error: "No storage adapter configured" };
  try {
    if (typeof storageAdapter.remove === "function") {
      await storageAdapter.remove(STORAGE_KEY_SESSION_CHECKPOINTS);
    } else {
      await storageAdapter.set({ [STORAGE_KEY_SESSION_CHECKPOINTS]: [] });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Records a summary of the most recent startup crash-recovery pass (remapped tabs,
 * recovered snapshot/restoration operations) so the UI can surface a one-time
 * "we recovered N things after an unexpected shutdown" notice instead of recovery
 * happening silently in the background.
 *
 * @param {object} storageAdapter
 * @param {object} summary
 * @returns {Promise<{ ok: boolean, record?: object, error?: string }>}
 */
export async function recordRecoverySummary(storageAdapter, summary) {
  if (!storageAdapter) return { ok: false, error: "No storage adapter configured" };
  try {
    const record = { ...summary, recordedAt: Date.now() };
    await storageAdapter.set({ [STORAGE_KEY_LAST_RECOVERY_SUMMARY]: record });
    return { ok: true, record };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Reads back the most recently recorded crash-recovery summary, or null if none
 * has been recorded (or it was already dismissed/cleared).
 *
 * @param {object} storageAdapter
 * @returns {Promise<object|null>}
 */
export async function getRecoverySummary(storageAdapter) {
  if (!storageAdapter) return null;
  try {
    const res = await storageAdapter.get(STORAGE_KEY_LAST_RECOVERY_SUMMARY);
    return res?.[STORAGE_KEY_LAST_RECOVERY_SUMMARY] || null;
  } catch (_) {
    return null;
  }
}

/**
 * Clears the recorded crash-recovery summary (e.g. once the user has dismissed
 * the notice in the UI).
 *
 * @param {object} storageAdapter
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function clearRecoverySummary(storageAdapter) {
  if (!storageAdapter) return { ok: false, error: "No storage adapter configured" };
  try {
    if (typeof storageAdapter.remove === "function") {
      await storageAdapter.remove(STORAGE_KEY_LAST_RECOVERY_SUMMARY);
    } else {
      await storageAdapter.set({ [STORAGE_KEY_LAST_RECOVERY_SUMMARY]: null });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Manages debounced active session persistence and crash recovery operations.
 */
export class SessionPersistenceManager {
  /**
   * @param {object} [options={}]
   * @param {object} [options.storageAdapter] - Object with get/set methods (defaults to chrome.storage.local if present)
   * @param {string} [options.storageKey]
   * @param {number} [options.debounceMs]
   * @param {function} [options.logger]
   */
  constructor(options = {}) {
    this.storageAdapter = options.storageAdapter || (typeof chrome !== "undefined" && chrome?.storage?.local ? chrome.storage.local : null);
    this.storageKey = options.storageKey || STORAGE_KEY_ACTIVE_SESSION;
    this.debounceMs = typeof options.debounceMs === "number" ? options.debounceMs : DEFAULT_PERSISTENCE_DEBOUNCE_MS;
    this.logger = options.logger || console.log;
    this.debug = options.debug === true;

    this.debounceTimer = null;
    this.pendingCaptureFn = null;
    this.isPersisting = false;
    this.lastPersistedAt = null;
    this.lastPersistedSession = null;
  }

  log(msg, ...args) {
    if (this.debug && typeof this.logger === "function") {
      this.logger(`[TabVault CrashRecovery] ${msg}`, ...args);
    }
  }

  /**
   * Sets or swaps the underlying storage adapter.
   * @param {object} adapter
   */
  setStorageAdapter(adapter) {
    this.storageAdapter = adapter;
  }

  /**
   * Persists a validated active session payload to storage.
   *
   * @param {object} sessionPayload
   * @returns {Promise<{ ok: boolean, savedAt?: number, tabCount?: number, windowCount?: number, error?: string }>}
   */
  async persist(sessionPayload) {
    const validation = validateActiveSessionMetadata(sessionPayload);
    if (!validation.ok) {
      this.log(`Validation failed: ${validation.error}`);
      return { ok: false, error: validation.error };
    }

    if (!this.storageAdapter) {
      return { ok: false, error: "No storage adapter configured" };
    }

    try {
      this.isPersisting = true;
      const dataToSave = validation.session;
      await this.storageAdapter.set({ [this.storageKey]: dataToSave });
      this.lastPersistedAt = dataToSave.savedAt;
      this.lastPersistedSession = dataToSave;
      this.log(`Successfully persisted active session with ${dataToSave.tabCount} tabs across ${dataToSave.windowCount} windows.`);

      // Best-effort rotating checkpoint: a secondary fallback in case the primary
      // record write above is itself interrupted or corrupted by a crash before
      // the next successful persist.
      try {
        await appendSessionCheckpoint(this.storageAdapter, dataToSave);
      } catch (_) {}

      return {
        ok: true,
        savedAt: dataToSave.savedAt,
        tabCount: dataToSave.tabCount,
        windowCount: dataToSave.windowCount
      };
    } catch (err) {
      const errMsg = err?.message || String(err);
      this.log(`Failed to persist active session: ${errMsg}`);
      return { ok: false, error: errMsg };
    } finally {
      this.isPersisting = false;
    }
  }

  /**
   * Loads and validates the persisted active session from storage.
   *
   * @returns {Promise<{ ok: boolean, session?: object, error?: string }>}
   */
  async load() {
    if (!this.storageAdapter) {
      return { ok: false, error: "No storage adapter configured" };
    }

    try {
      const result = await this.storageAdapter.get(this.storageKey);
      const raw = result?.[this.storageKey];
      if (raw) {
        const validation = validateActiveSessionMetadata(raw);
        if (validation.ok) {
          return { ok: true, session: validation.session };
        }
        this.log(`Primary active session record failed validation (${validation.error}); falling back to latest checkpoint.`);
      }

      // Primary record missing or corrupted (e.g. write interrupted mid-crash) —
      // fall back to the most recent valid rotating checkpoint, if any.
      const fallback = await getLatestValidSessionCheckpoint(this.storageAdapter);
      if (fallback) {
        this.log(`Recovered active session from checkpoint ${fallback.checkpoint.checkpointId}.`);
        return { ok: true, session: fallback.session, fromCheckpoint: true };
      }

      return { ok: false, error: raw ? "Persisted active session failed validation and no valid checkpoint exists" : "No persisted active session found" };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  /**
   * Clears the persisted active session from storage.
   *
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async clear() {
    if (!this.storageAdapter) {
      return { ok: false, error: "No storage adapter configured" };
    }

    try {
      if (typeof this.storageAdapter.remove === "function") {
        await this.storageAdapter.remove(this.storageKey);
      } else {
        await this.storageAdapter.set({ [this.storageKey]: null });
      }
      this.lastPersistedSession = null;
      this.lastPersistedAt = null;
      try {
        await clearSessionCheckpoints(this.storageAdapter);
      } catch (_) {}
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  /**
   * Captures live browser state and persists it.
   *
   * @param {object} params
   * @returns {Promise<{ ok: boolean, savedAt?: number, tabCount?: number, windowCount?: number, error?: string }>}
   */
  async captureAndPersist(params = {}) {
    let { windows, tabs, groups, tabState, manuallyProtectedTabs, metadataStore, snapshotStore, options, chromeApi } = params;

    // If chromeApi provided, query live state if windows or tabs not provided
    if (chromeApi && (!windows || windows.length === 0) && (!tabs || tabs.length === 0)) {
      try {
        if (chromeApi.windows?.getAll) {
          windows = await chromeApi.windows.getAll({ populate: true });
        } else if (chromeApi.tabs?.query) {
          tabs = await chromeApi.tabs.query({});
        }
        if (chromeApi.tabGroups?.query && (!groups || groups.length === 0)) {
          groups = await chromeApi.tabGroups.query({});
        }
      } catch (err) {
        this.log(`Error querying browser APIs: ${err?.message || err}`);
      }
    }

    const payload = captureActiveSessionMetadata({
      windows,
      tabs,
      groups,
      tabState,
      manuallyProtectedTabs,
      metadataStore,
      snapshotStore,
      options
    });

    return this.persist(payload);
  }

  /**
   * Schedules debounced persistence. Rapid successive calls collapse into a single write.
   *
   * @param {function} captureFn - Async or sync function returning capture parameters
   * @returns {Promise<void>}
   */
  schedulePersist(captureFn) {
    if (typeof captureFn === "function") {
      this.pendingCaptureFn = captureFn;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    return new Promise((resolve) => {
      this.debounceTimer = setTimeout(async () => {
        this.debounceTimer = null;
        if (this.pendingCaptureFn) {
          const fn = this.pendingCaptureFn;
          this.pendingCaptureFn = null;
          try {
            const params = await fn();
            await this.captureAndPersist(params || {});
          } catch (err) {
            this.log(`Scheduled persist error: ${err?.message || err}`);
          }
        }
        resolve();
      }, this.debounceMs);
    });
  }

  /**
   * Immediately flushes any pending debounced persistence.
   *
   * @param {function} [fallbackCaptureFn]
   * @returns {Promise<{ ok: boolean, savedAt?: number, tabCount?: number, windowCount?: number, error?: string }>}
   */
  async flushPersist(fallbackCaptureFn) {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    const fn = this.pendingCaptureFn || fallbackCaptureFn;
    this.pendingCaptureFn = null;

    if (typeof fn === "function") {
      try {
        const params = await fn();
        return this.captureAndPersist(params || {});
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    }

    return { ok: true, skipped: true };
  }

  /**
   * Restores and correlates active session metadata on browser restart.
   *
   * @param {object} params
   * @returns {Promise<{ ok: boolean, restored: boolean, remappedCount?: number, recoveredTabs?: Array<object>, orphanCount?: number, error?: string }>}
   */
  async restoreSessionOnStartup(params = {}) {
    const loadRes = await this.load();
    if (!loadRes.ok || !loadRes.session) {
      this.log("No persisted active session found during startup recovery.");
      return { ok: true, restored: false, reason: "no_persisted_session" };
    }

    let { liveTabs, liveWindows, liveGroups, metadataStore, tabState, manuallyProtectedTabs, options, chromeApi } = params;

    if (chromeApi && (!liveTabs || liveTabs.length === 0)) {
      try {
        if (chromeApi.tabs?.query) {
          liveTabs = await chromeApi.tabs.query({});
        }
      } catch (err) {
        this.log(`Failed to query live tabs for startup recovery: ${err?.message || err}`);
      }
    }

    const remapResult = remapSessionMetadataOnStartup({
      liveTabs: liveTabs || [],
      persistedSession: loadRes.session,
      metadataStore,
      tabState,
      manuallyProtectedTabs,
      options
    });

    this.log(`Startup recovery remapped ${remapResult.remappedCount} of ${remapResult.totalLiveTabs} live tabs.`);

    // Persist immediately with the new live IDs so state is current
    if (liveTabs && liveTabs.length > 0) {
      try {
        await this.captureAndPersist({
          tabs: liveTabs,
          windows: liveWindows,
          groups: liveGroups,
          tabState,
          manuallyProtectedTabs,
          metadataStore
        });
      } catch (persistErr) {
        this.log(`Warning: Failed to persist refreshed active session on startup: ${persistErr?.message || persistErr}`);
      }
    }

    return {
      ok: true,
      restored: true,
      ...remapResult
    };
  }
}

let globalSessionPersistenceManager = null;

/**
 * Returns singleton SessionPersistenceManager.
 * @param {object} [options={}]
 * @returns {SessionPersistenceManager}
 */
export function getSessionPersistenceManager(options = {}) {
  if (!globalSessionPersistenceManager) {
    globalSessionPersistenceManager = new SessionPersistenceManager(options);
  }
  return globalSessionPersistenceManager;
}

/**
 * Resets the singleton SessionPersistenceManager.
 */
export function resetSessionPersistenceManager() {
  if (globalSessionPersistenceManager?.debounceTimer) {
    clearTimeout(globalSessionPersistenceManager.debounceTimer);
  }
  globalSessionPersistenceManager = null;
}

/**
 * Creates a structured pending snapshot record.
 *
 * @param {number} tabId
 * @param {object} [details={}]
 * @returns {object}
 */
export function createPendingSnapshotRecord(tabId, details = {}) {
  const now = typeof details.now === "number" ? details.now : Date.now();
  const timeoutMs = typeof details.timeoutMs === "number" && details.timeoutMs > 0
    ? details.timeoutMs
    : DEFAULT_SNAPSHOT_TIMEOUT_MS;

  return {
    tabId,
    url: details.url || "",
    stage: details.stage || "init",
    startedAt: now,
    timeoutMs,
    context: details.context || null
  };
}

/**
 * Detects interrupted snapshot operations by inspecting pending snapshot records.
 *
 * @param {Array<object>} pendingSnapshots
 * @param {object} [options={}]
 * @param {number} [options.now]
 * @param {number} [options.timeoutMs]
 * @returns {Array<object>} List of detected interrupted snapshot records
 */
export function detectInterruptedSnapshots(pendingSnapshots = [], options = {}) {
  const list = Array.isArray(pendingSnapshots) ? pendingSnapshots : [];
  const now = typeof options.now === "number" ? options.now : Date.now();
  const defaultTimeout = typeof options.timeoutMs === "number" ? options.timeoutMs : DEFAULT_SNAPSHOT_TIMEOUT_MS;

  const interrupted = [];

  for (const record of list) {
    if (!record || typeof record !== "object" || record.tabId == null) continue;
    const startedAt = typeof record.startedAt === "number" ? record.startedAt : 0;
    const timeout = typeof record.timeoutMs === "number" && record.timeoutMs > 0 ? record.timeoutMs : defaultTimeout;
    const elapsed = now - startedAt;

    if (elapsed >= timeout) {
      interrupted.push({
        ...record,
        elapsedMs: elapsed,
        isInterrupted: true,
        detectedAt: now
      });
    }
  }

  return interrupted;
}

/**
 * Recovers interrupted snapshot operations, releasing locks and reverting transient states.
 *
 * @param {object} params
 * @param {Array<object>} params.interruptedRecords
 * @param {Map<number, object>} [params.pendingSnapshotsMap]
 * @param {Map<number, object>} [params.tabState]
 * @param {object} [params.metadataStore]
 * @param {object} [params.options={}]
 * @returns {{ recoveredCount: number, recoveredRecords: Array<object> }}
 */
export function recoverInterruptedSnapshots({
  interruptedRecords = [],
  pendingSnapshotsMap = null,
  tabState = null,
  metadataStore = null,
  options = {}
} = {}) {
  const records = Array.isArray(interruptedRecords) ? interruptedRecords : [];
  const recovered = [];
  const fallbackState = options.fallbackState || "ACTIVE";

  for (const item of records) {
    if (!item || item.tabId == null) continue;
    const tid = item.tabId;

    // Remove from in-memory pending map
    if (pendingSnapshotsMap instanceof Map) {
      pendingSnapshotsMap.delete(tid);
    }

    // Revert lifecycle state in tabState
    if (tabState instanceof Map) {
      const state = tabState.get(tid) || {};
      if (state.lifecycleState === "SNAPSHOTTING" || !state.lifecycleState) {
        state.lifecycleState = fallbackState;
        tabState.set(tid, state);
      }
    }

    // Revert in metadataStore
    if (metadataStore && typeof metadataStore.get === "function") {
      const meta = metadataStore.get(tid);
      if (meta && (meta.lifecycleState === "SNAPSHOTTING" || !meta.lifecycleState)) {
        metadataStore.set(tid, {
          lifecycleState: fallbackState,
          lastActiveAt: Date.now()
        });
      }
    }

    recovered.push({
      tabId: tid,
      url: item.url,
      stage: item.stage,
      elapsedMs: item.elapsedMs,
      recoveredToState: fallbackState
    });
  }

  return {
    recoveredCount: recovered.length,
    recoveredRecords: recovered
  };
}

/**
 * Tracks snapshot execution and persists in-flight operations for crash resilience.
 */
export class SnapshotOperationTracker {
  constructor(options = {}) {
    this.storageAdapter = options.storageAdapter || (typeof chrome !== "undefined" && chrome?.storage?.local ? chrome.storage.local : null);
    this.storageKey = options.storageKey || STORAGE_KEY_PENDING_SNAPSHOTS;
    this.timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : DEFAULT_SNAPSHOT_TIMEOUT_MS;
    this.logger = options.logger || console.log;
    this.debug = options.debug === true;
    this.pendingMap = new Map(); // Map<tabId, record>
  }

  log(msg, ...args) {
    if (this.debug && typeof this.logger === "function") {
      this.logger(`[TabVault SnapshotTracker] ${msg}`, ...args);
    }
  }

  setStorageAdapter(adapter) {
    this.storageAdapter = adapter;
  }

  async startSnapshot(tabId, details = {}) {
    const record = createPendingSnapshotRecord(tabId, {
      ...details,
      timeoutMs: details.timeoutMs || this.timeoutMs
    });
    this.pendingMap.set(tabId, record);

    if (this.storageAdapter) {
      try {
        await this.storageAdapter.set({ [this.storageKey]: Array.from(this.pendingMap.values()) });
      } catch (err) {
        this.log(`Failed to persist pending snapshot start: ${err?.message || err}`);
      }
    }
    return record;
  }

  async finishSnapshot(tabId) {
    const existed = this.pendingMap.delete(tabId);
    if (this.storageAdapter) {
      try {
        await this.storageAdapter.set({ [this.storageKey]: Array.from(this.pendingMap.values()) });
      } catch (err) {
        this.log(`Failed to update pending snapshots after finish: ${err?.message || err}`);
      }
    }
    return existed;
  }

  getPendingSnapshots() {
    return Array.from(this.pendingMap.values());
  }

  async loadFromStorage() {
    if (!this.storageAdapter) return [];
    try {
      const res = await this.storageAdapter.get(this.storageKey);
      const raw = res?.[this.storageKey];
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (item && item.tabId != null) {
            this.pendingMap.set(item.tabId, item);
          }
        }
      }
      return Array.from(this.pendingMap.values());
    } catch (err) {
      this.log(`Failed to load pending snapshots: ${err?.message || err}`);
      return [];
    }
  }

  async checkAndRecoverInterrupted(params = {}) {
    const now = typeof params.now === "number" ? params.now : Date.now();
    await this.loadFromStorage();
    const pendingList = Array.from(this.pendingMap.values());
    const interrupted = detectInterruptedSnapshots(pendingList, { now, timeoutMs: this.timeoutMs });

    if (interrupted.length === 0) {
      return { detectedCount: 0, recoveredCount: 0, records: [] };
    }

    this.log(`Detected ${interrupted.length} interrupted snapshot operations.`);
    const recovery = recoverInterruptedSnapshots({
      interruptedRecords: interrupted,
      pendingSnapshotsMap: this.pendingMap,
      tabState: params.tabState,
      metadataStore: params.metadataStore,
      options: params.options
    });

    if (this.storageAdapter) {
      try {
        await this.storageAdapter.set({ [this.storageKey]: Array.from(this.pendingMap.values()) });
      } catch (err) {
        this.log(`Failed to update persistent storage after recovery: ${err?.message || err}`);
      }
    }

    return {
      detectedCount: interrupted.length,
      recoveredCount: recovery.recoveredCount,
      records: recovery.recoveredRecords
    };
  }

  clear() {
    this.pendingMap.clear();
    if (this.storageAdapter) {
      this.storageAdapter.set({ [this.storageKey]: [] }).catch(() => {});
    }
  }
}

let globalSnapshotTracker = null;

/**
 * Returns singleton SnapshotOperationTracker.
 * @param {object} [options={}]
 * @returns {SnapshotOperationTracker}
 */
export function getSnapshotOperationTracker(options = {}) {
  if (!globalSnapshotTracker) {
    globalSnapshotTracker = new SnapshotOperationTracker(options);
  }
  return globalSnapshotTracker;
}

/**
 * Resets singleton SnapshotOperationTracker.
 */
export function resetSnapshotOperationTracker() {
  globalSnapshotTracker = null;
}

/**
 * Creates a structured pending restoration record.
 *
 * @param {number} tabId
 * @param {object} [details={}]
 * @returns {object}
 */
export function createPendingRestorationRecord(tabId, details = {}) {
  const now = typeof details.now === "number" ? details.now : Date.now();
  const timeoutMs = typeof details.timeoutMs === "number" && details.timeoutMs > 0
    ? details.timeoutMs
    : DEFAULT_RESTORATION_TIMEOUT_MS;

  return {
    tabId,
    url: details.url || "",
    stage: details.stage || "INIT",
    priority: details.priority || "NORMAL",
    startedAt: now,
    timeoutMs,
    retryCount: typeof details.retryCount === "number" ? details.retryCount : 0,
    source: details.source || "user"
  };
}

/**
 * Detects interrupted restoration operations by inspecting pending restoration records.
 *
 * @param {Array<object>} pendingRestorations
 * @param {object} [options={}]
 * @param {number} [options.now]
 * @param {number} [options.timeoutMs]
 * @returns {Array<object>} List of detected interrupted restoration records
 */
export function detectInterruptedRestorations(pendingRestorations = [], options = {}) {
  const list = Array.isArray(pendingRestorations) ? pendingRestorations : [];
  const now = typeof options.now === "number" ? options.now : Date.now();
  const defaultTimeout = typeof options.timeoutMs === "number" ? options.timeoutMs : DEFAULT_RESTORATION_TIMEOUT_MS;

  const interrupted = [];

  for (const record of list) {
    if (!record || typeof record !== "object" || record.tabId == null) continue;
    const startedAt = typeof record.startedAt === "number" ? record.startedAt : 0;
    const timeout = typeof record.timeoutMs === "number" && record.timeoutMs > 0 ? record.timeoutMs : defaultTimeout;
    const elapsed = now - startedAt;

    if (elapsed >= timeout) {
      interrupted.push({
        ...record,
        elapsedMs: elapsed,
        isInterrupted: true,
        detectedAt: now
      });
    }
  }

  return interrupted;
}

/**
 * Recovers interrupted restoration operations, reverting transient states or re-queuing retries.
 *
 * @param {object} params
 * @param {Array<object>} params.interruptedRecords
 * @param {Map<number, object>} [params.pendingRestorationsMap]
 * @param {Map<number, object>} [params.tabState]
 * @param {object} [params.metadataStore]
 * @param {object} [params.restoreEngine]
 * @param {object} [params.options={}]
 * @returns {Promise<{ recoveredCount: number, recoveredRecords: Array<object> }>}
 */
export async function recoverInterruptedRestorations({
  interruptedRecords = [],
  pendingRestorationsMap = null,
  tabState = null,
  metadataStore = null,
  restoreEngine = null,
  options = {}
} = {}) {
  const records = Array.isArray(interruptedRecords) ? interruptedRecords : [];
  const recovered = [];
  const action = options.action || "reset"; // "reset" | "retry" | "mark_failed"

  for (const item of records) {
    if (!item || item.tabId == null) continue;
    const tid = item.tabId;

    // Remove from in-memory pending map
    if (pendingRestorationsMap instanceof Map) {
      pendingRestorationsMap.delete(tid);
    }

    let targetState = "DISCARDED";
    let retried = false;

    if (action === "retry" && restoreEngine && typeof restoreEngine.restoreTab === "function") {
      try {
        await restoreEngine.restoreTab(tid, {
          source: "crash_recovery",
          priority: item.priority || "NORMAL",
          bypassConcurrency: false
        });
        targetState = "RESTORING";
        retried = true;
      } catch (_) {
        targetState = "RESTORE_FAILED";
      }
    } else if (action === "mark_failed") {
      targetState = "RESTORE_FAILED";
    } else {
      // Default: "reset" back to DISCARDED
      targetState = "DISCARDED";
    }

    // Update in-memory tabState
    if (tabState instanceof Map) {
      const state = tabState.get(tid) || {};
      state.lifecycleState = targetState;
      tabState.set(tid, state);
    }

    // Update metadataStore
    if (metadataStore && typeof metadataStore.get === "function") {
      const meta = metadataStore.get(tid);
      if (meta) {
        metadataStore.set(tid, {
          lifecycleState: targetState,
          restorationStatus: targetState === "RESTORE_FAILED" ? "failed" : "none"
        });
      }
    }

    recovered.push({
      tabId: tid,
      url: item.url,
      stage: item.stage,
      elapsedMs: item.elapsedMs,
      actionTaken: retried ? "retried" : "reset",
      targetState
    });
  }

  return {
    recoveredCount: recovered.length,
    recoveredRecords: recovered
  };
}

/**
 * Tracks restoration execution and persists in-flight operations for crash resilience.
 */
export class RestorationOperationTracker {
  constructor(options = {}) {
    this.storageAdapter = options.storageAdapter || (typeof chrome !== "undefined" && chrome?.storage?.local ? chrome.storage.local : null);
    this.storageKey = options.storageKey || STORAGE_KEY_PENDING_RESTORATIONS;
    this.timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : DEFAULT_RESTORATION_TIMEOUT_MS;
    this.logger = options.logger || console.log;
    this.debug = options.debug === true;
    this.pendingMap = new Map(); // Map<tabId, record>
  }

  log(msg, ...args) {
    if (this.debug && typeof this.logger === "function") {
      this.logger(`[TabVault RestorationTracker] ${msg}`, ...args);
    }
  }

  setStorageAdapter(adapter) {
    this.storageAdapter = adapter;
  }

  async startRestoration(tabId, details = {}) {
    const record = createPendingRestorationRecord(tabId, {
      ...details,
      timeoutMs: details.timeoutMs || this.timeoutMs
    });
    this.pendingMap.set(tabId, record);

    if (this.storageAdapter) {
      try {
        await this.storageAdapter.set({ [this.storageKey]: Array.from(this.pendingMap.values()) });
      } catch (err) {
        this.log(`Failed to persist pending restoration start: ${err?.message || err}`);
      }
    }
    return record;
  }

  async updateStage(tabId, stage) {
    const existing = this.pendingMap.get(tabId);
    if (!existing) return null;
    existing.stage = stage;
    this.pendingMap.set(tabId, existing);

    if (this.storageAdapter) {
      try {
        await this.storageAdapter.set({ [this.storageKey]: Array.from(this.pendingMap.values()) });
      } catch (err) {
        this.log(`Failed to update pending restoration stage: ${err?.message || err}`);
      }
    }
    return existing;
  }

  async finishRestoration(tabId) {
    const existed = this.pendingMap.delete(tabId);
    if (this.storageAdapter) {
      try {
        await this.storageAdapter.set({ [this.storageKey]: Array.from(this.pendingMap.values()) });
      } catch (err) {
        this.log(`Failed to update pending restorations after finish: ${err?.message || err}`);
      }
    }
    return existed;
  }

  getPendingRestorations() {
    return Array.from(this.pendingMap.values());
  }

  async loadFromStorage() {
    if (!this.storageAdapter) return [];
    try {
      const res = await this.storageAdapter.get(this.storageKey);
      const raw = res?.[this.storageKey];
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (item && item.tabId != null) {
            this.pendingMap.set(item.tabId, item);
          }
        }
      }
      return Array.from(this.pendingMap.values());
    } catch (err) {
      this.log(`Failed to load pending restorations: ${err?.message || err}`);
      return [];
    }
  }

  async checkAndRecoverInterrupted(params = {}) {
    const now = typeof params.now === "number" ? params.now : Date.now();
    await this.loadFromStorage();
    const pendingList = Array.from(this.pendingMap.values());
    const interrupted = detectInterruptedRestorations(pendingList, { now, timeoutMs: this.timeoutMs });

    if (interrupted.length === 0) {
      return { detectedCount: 0, recoveredCount: 0, records: [] };
    }

    this.log(`Detected ${interrupted.length} interrupted restoration operations.`);
    const recovery = await recoverInterruptedRestorations({
      interruptedRecords: interrupted,
      pendingRestorationsMap: this.pendingMap,
      tabState: params.tabState,
      metadataStore: params.metadataStore,
      restoreEngine: params.restoreEngine,
      options: params.options
    });

    if (this.storageAdapter) {
      try {
        await this.storageAdapter.set({ [this.storageKey]: Array.from(this.pendingMap.values()) });
      } catch (err) {
        this.log(`Failed to update persistent storage after recovery: ${err?.message || err}`);
      }
    }

    return {
      detectedCount: interrupted.length,
      recoveredCount: recovery.recoveredCount,
      records: recovery.recoveredRecords
    };
  }

  clear() {
    this.pendingMap.clear();
    if (this.storageAdapter) {
      this.storageAdapter.set({ [this.storageKey]: [] }).catch(() => {});
    }
  }
}

let globalRestorationTracker = null;

/**
 * Returns singleton RestorationOperationTracker.
 * @param {object} [options={}]
 * @returns {RestorationOperationTracker}
 */
export function getRestorationOperationTracker(options = {}) {
  if (!globalRestorationTracker) {
    globalRestorationTracker = new RestorationOperationTracker(options);
  }
  return globalRestorationTracker;
}

/**
 * Resets singleton RestorationOperationTracker.
 */
export function resetRestorationOperationTracker() {
  globalRestorationTracker = null;
}


