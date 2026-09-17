/**
 * TabVault Smart Restoration Engine
 * Orchestrates multi-stage restoration pipeline:
 * Load original URL -> Wait for page readiness -> Restore scroll position ->
 * Restore safe form state -> Apply site-specific adapter -> Mark tab as restored.
 *
 * Includes timeout handling, retry mechanism, failure isolation, cancellation,
 * duplicate prevention, and concurrency queue.
 */

import { TabState, getLifecycleTracker } from "./lifecycle.js";
import { getTabMetadataStore } from "./metadata.js";
import { createRestorationPlan } from "./snapshot.js";
import { getSnapshotStore } from "./snapshot-store.js";
import { isFormSavingEnabled } from "./form.js";
import { executeAdapterRestore } from "./adapters/restore.js";
import {
  RestorePriority,
  normalizeRestorePriority,
  getPriorityName,
  isUserRequestedRestore,
  DEFAULT_MAX_CONCURRENT_RESTORES,
  MIN_CONCURRENT_RESTORES,
  MAX_CONCURRENT_RESTORES,
  STORAGE_KEY_MAX_CONCURRENT_RESTORES,
  normalizeMaxConcurrentRestores,
  loadMaxConcurrentRestores,
  saveMaxConcurrentRestores,
  RestoreQueue
} from "./restore-queue.js";

export {
  RestorePriority,
  normalizeRestorePriority,
  getPriorityName,
  isUserRequestedRestore,
  DEFAULT_MAX_CONCURRENT_RESTORES,
  MIN_CONCURRENT_RESTORES,
  MAX_CONCURRENT_RESTORES,
  STORAGE_KEY_MAX_CONCURRENT_RESTORES,
  normalizeMaxConcurrentRestores,
  loadMaxConcurrentRestores,
  saveMaxConcurrentRestores,
  RestoreQueue
};

/**
 * Stages of the restoration pipeline.
 */
export const RestorationStage = Object.freeze({
  IDLE: "idle",
  DEFERRED: "deferred",
  QUEUED: "queued",
  INIT: "init",
  LOAD_URL: "load_url",
  WAIT_READINESS: "wait_readiness",
  RESTORE_SCROLL: "restore_scroll",
  RESTORE_FORMS: "restore_forms",
  APPLY_ADAPTER: "apply_adapter",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled"
});

/**
 * Standard progress percentage mapped to each pipeline stage.
 */
export const STAGE_PROGRESS_MAP = Object.freeze({
  [RestorationStage.IDLE]: 0,
  [RestorationStage.DEFERRED]: 0,
  [RestorationStage.QUEUED]: 5,
  [RestorationStage.INIT]: 10,
  [RestorationStage.LOAD_URL]: 25,
  [RestorationStage.WAIT_READINESS]: 50,
  [RestorationStage.RESTORE_SCROLL]: 70,
  [RestorationStage.RESTORE_FORMS]: 85,
  [RestorationStage.APPLY_ADAPTER]: 95,
  [RestorationStage.COMPLETED]: 100,
  [RestorationStage.FAILED]: 100,
  [RestorationStage.CANCELLED]: 100
});

/**
 * Returns user-facing label for a restoration stage.
 * @param {string} stage
 * @returns {string}
 */
export function getStageLabel(stage) {
  switch (stage) {
    case RestorationStage.DEFERRED:
      return "Deferred";
    case RestorationStage.QUEUED:
      return "Queued";
    case RestorationStage.INIT:
      return "Preparing";
    case RestorationStage.LOAD_URL:
      return "Loading URL";
    case RestorationStage.WAIT_READINESS:
      return "Waiting Readiness";
    case RestorationStage.RESTORE_SCROLL:
      return "Restoring Scroll";
    case RestorationStage.RESTORE_FORMS:
      return "Restoring Forms";
    case RestorationStage.APPLY_ADAPTER:
      return "Applying State";
    case RestorationStage.COMPLETED:
      return "Restored";
    case RestorationStage.FAILED:
      return "Restore Failed";
    case RestorationStage.CANCELLED:
      return "Cancelled";
    case RestorationStage.IDLE:
    default:
      return "Suspended";
  }
}

/**
 * Returns detailed description for a restoration stage.
 * @param {string} stage
 * @returns {string}
 */
export function getStageDescription(stage) {
  switch (stage) {
    case RestorationStage.DEFERRED:
      return "Restoration deferred until tab is focused to avoid unnecessary background resource consumption.";
    case RestorationStage.QUEUED:
      return "Waiting in restoration queue for an available concurrency slot...";
    case RestorationStage.INIT:
      return "Preparing tab restoration plan and context...";
    case RestorationStage.LOAD_URL:
      return "Loading target web page...";
    case RestorationStage.WAIT_READINESS:
      return "Waiting for document layout and readiness...";
    case RestorationStage.RESTORE_SCROLL:
      return "Restoring vertical and horizontal scroll position...";
    case RestorationStage.RESTORE_FORMS:
      return "Restoring safe user form inputs...";
    case RestorationStage.APPLY_ADAPTER:
      return "Applying site-specific state and playback positions...";
    case RestorationStage.COMPLETED:
      return "Tab successfully restored.";
    case RestorationStage.FAILED:
      return "Restoration encountered an error.";
    case RestorationStage.CANCELLED:
      return "Restoration was cancelled.";
    case RestorationStage.IDLE:
    default:
      return "Tab is suspended to save memory.";
  }
}

/**
 * Default restoration engine configuration options.
 */
export const DEFAULT_RESTORATION_OPTIONS = Object.freeze({
  timeoutMs: 15000,
  readinessTimeoutMs: 10000,
  adapterTimeoutMs: 3000,
  maxRetries: 2,
  retryBackoffMs: 500,
  maxConcurrentRestorations: DEFAULT_MAX_CONCURRENT_RESTORES,
  restoreScroll: true,
  restoreForms: true,
  applyAdapters: true,
  autoFocus: false,
  preemptLowPriorityOnUserRestore: false,
  lazyRestoreBackgroundTabs: false
});

/**
 * Storage key and default setting for avoiding unnecessary background restorations.
 */
export const STORAGE_KEY_LAZY_RESTORE_BACKGROUND = "tabvault_lazy_restore_background";
export const DEFAULT_LAZY_RESTORE_BACKGROUND = true;

/**
 * Checks if a tab object represents a background (inactive) tab.
 * @param {object} tab
 * @returns {boolean}
 */
export function isTabBackground(tab) {
  if (!tab || typeof tab !== "object") return false;
  return tab.active === false;
}

/**
 * Evaluates whether a tab restoration should be deferred rather than eagerly executed
 * in the background.
 *
 * @param {object|number} tabOrTabId - Tab object or tab ID
 * @param {object} [options={}] - Restoration options
 * @param {object} [context={}] - Environment context including engine options
 * @returns {boolean} True if restoration should be deferred
 */
export function shouldDeferBackgroundRestoration(tabOrTabId, options = {}, context = {}) {
  // 1. Force or explicit allowBackground or explicitly non-lazy disables deferral
  if (options.force || options.allowBackground || options.lazy === false) {
    return false;
  }

  // 2. Check if lazy background restoration policy is active
  const lazyEnabled = Boolean(
    options.lazy ||
    options.lazyRestoreBackgroundTabs ||
    context.options?.lazyRestoreBackgroundTabs
  );
  if (!lazyEnabled) {
    return false;
  }

  // 3. User-requested restores on active tab should not be deferred
  if (isUserRequestedRestore(options) && !options.isBackground) {
    return false;
  }

  // 4. Check if tab is in the background
  if (options.isBackground !== undefined) {
    return Boolean(options.isBackground);
  }

  if (tabOrTabId && typeof tabOrTabId === "object" && tabOrTabId.active !== undefined) {
    return !tabOrTabId.active;
  }

  return false;
}

/**
 * Loads lazy background restoration preference from extension storage.
 * @param {object} [storageApi]
 * @returns {Promise<boolean>}
 */
export async function loadLazyRestoreBackgroundSetting(storageApi) {
  const api = storageApi || (typeof chrome !== "undefined" && chrome?.storage?.local ? chrome.storage.local : null);
  if (!api?.get) return DEFAULT_LAZY_RESTORE_BACKGROUND;
  try {
    const res = await api.get(STORAGE_KEY_LAZY_RESTORE_BACKGROUND);
    if (res && res[STORAGE_KEY_LAZY_RESTORE_BACKGROUND] !== undefined) {
      return Boolean(res[STORAGE_KEY_LAZY_RESTORE_BACKGROUND]);
    }
  } catch (_) {}
  return DEFAULT_LAZY_RESTORE_BACKGROUND;
}

/**
 * Saves lazy background restoration preference to extension storage.
 * @param {boolean} enabled
 * @param {object} [storageApi]
 * @returns {Promise<boolean>}
 */
export async function saveLazyRestoreBackgroundSetting(enabled, storageApi) {
  const api = storageApi || (typeof chrome !== "undefined" && chrome?.storage?.local ? chrome.storage.local : null);
  const normalized = Boolean(enabled);
  if (!api?.set) return normalized;
  try {
    await api.set({ [STORAGE_KEY_LAZY_RESTORE_BACKGROUND]: normalized });
  } catch (_) {}
  return normalized;
}

/**
 * Extracts target original URL from suspended URL hash or snapshot.
 * @param {string} suspendedUrl
 * @returns {string|null}
 */
export function extractTargetUrlFromSuspendedUrl(suspendedUrl) {
  if (!suspendedUrl || typeof suspendedUrl !== "string") return null;
  const hashIdx = suspendedUrl.indexOf("#");
  if (hashIdx === -1) return null;
  try {
    const params = new URLSearchParams(suspendedUrl.slice(hashIdx + 1));
    return params.get("u") || null;
  } catch (_) {
    return null;
  }
}

/**
 * Restoration Session representing an in-flight restoration.
 */
export class RestorationSession {
  constructor(tabId, options = {}) {
    this.tabId = tabId;
    this.options = { ...DEFAULT_RESTORATION_OPTIONS, ...options };
    this.stage = RestorationStage.IDLE;
    this.progress = 0;
    this.startTime = Date.now();
    this.updatedTime = this.startTime;
    this.attempt = 1;
    this.error = null;
    this.plan = null;
    this.targetUrl = null;
    this.abortController = new AbortController();
    this.timeoutTimer = null;
    this.history = [];
    this.isComplete = false;
    this.isFailed = false;
    this.isCancelled = false;
    this.isTimedOut = false;
  }

  setStage(stage, detail = null) {
    this.stage = stage;
    this.progress = STAGE_PROGRESS_MAP[stage] ?? this.progress;
    this.updatedTime = Date.now();
    this.history.push({
      stage,
      progress: this.progress,
      timestamp: this.updatedTime,
      detail
    });
  }

  markTimedOut(reason = "Restoration timed out") {
    this.isTimedOut = true;
    this.cancel(reason, { timedOut: true });
  }

  cancel(reason = "Restoration cancelled", options = {}) {
    if (this.isComplete || this.isFailed || this.isCancelled) return;
    this.isCancelled = true;
    if (options.timedOut) {
      this.isTimedOut = true;
    }
    this.error = reason;
    this.abortController.abort(new Error(reason));
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    this.setStage(RestorationStage.CANCELLED, reason);
  }

  fail(error) {
    this.isFailed = true;
    this.error = error?.message || String(error);
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    this.setStage(RestorationStage.FAILED, this.error);
  }

  complete() {
    this.isComplete = true;
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    this.setStage(RestorationStage.COMPLETED);
  }

  getStatus() {
    return {
      tabId: this.tabId,
      stage: this.stage,
      progress: this.progress,
      startTime: this.startTime,
      updatedTime: this.updatedTime,
      durationMs: this.updatedTime - this.startTime,
      attempt: this.attempt,
      error: this.error,
      targetUrl: this.targetUrl,
      isComplete: this.isComplete,
      isFailed: this.isFailed,
      isCancelled: this.isCancelled,
      isTimedOut: this.isTimedOut,
      historyCount: this.history.length
    };
  }
}

/**
 * Core function executing the 7-step restoration pipeline.
 *
 * @param {RestorationSession} session
 * @param {object} context - Dependencies & adapters
 * @returns {Promise<object>} Result
 */
export async function runRestorationPipeline(session, context = {}) {
  const {
    chromeApi = (typeof chrome !== "undefined" ? chrome : null),
    lifecycleTracker = getLifecycleTracker(),
    metadataStore = getTabMetadataStore(),
    snapshotStore = getSnapshotStore(),
    adapterRegistry = null
  } = context;

  const tabId = session.tabId;
  const signal = session.abortController.signal;

  // Check abort helper
  function checkAborted() {
    if (signal.aborted) {
      throw new Error(session.error || "Restoration aborted");
    }
  }

  try {
    // ── 1. STAGE_INIT ────────────────────────────────────────────────────────
    session.setStage(RestorationStage.INIT);
    checkAborted();

    // Verify tab existence
    let tab = null;
    if (chromeApi?.tabs?.get) {
      try {
        tab = await chromeApi.tabs.get(tabId);
      } catch (err) {
        throw new Error(`Tab ${tabId} not found in browser: ${err.message}`);
      }
    } else {
      tab = { id: tabId, url: "about:blank" };
    }

    // Determine target URL
    let targetUrl = session.options.targetUrl;
    if (!targetUrl && tab?.url) {
      targetUrl = extractTargetUrlFromSuspendedUrl(tab.url);
    }

    // Retrieve snapshot or create restoration plan
    let snapshot = null;
    if (session.options.snapshot) {
      snapshot = session.options.snapshot;
    } else if (snapshotStore) {
      if (session.options.snapshotId) {
        snapshot = await snapshotStore.getSnapshot(session.options.snapshotId);
      }
      if (!snapshot) {
        snapshot = await snapshotStore.getLatestSnapshot(tabId);
      }
    }

    if (snapshot) {
      session.plan = createRestorationPlan(snapshot, { targetTabId: tabId });
      if (!targetUrl && session.plan.url) {
        targetUrl = session.plan.url;
      }
    } else if (targetUrl) {
      session.plan = {
        snapshotId: null,
        targetTabId: tabId,
        url: targetUrl,
        title: tab?.title || "Restored tab",
        scroll: { x: 0, y: 0, percentX: 0, percentY: 0 },
        forms: {},
        plannedAt: Date.now()
      };
    } else {
      throw new Error(`Cannot determine restoration target URL for tab ${tabId}`);
    }

    session.targetUrl = targetUrl;

    // Transition tab lifecycle to RESTORING
    if (lifecycleTracker) {
      try {
        const currentState = lifecycleTracker.getState(tabId);
        if (currentState === TabState.DISCARDED || currentState === TabState.RESTORE_FAILED || currentState === TabState.ACTIVE || currentState === TabState.IDLE) {
          lifecycleTracker.transition(tabId, TabState.RESTORING, "pipeline_start");
        }
      } catch (_) {
        // Soft fallback if state transition check throws
      }
    }

    // Update persistent metadata
    if (metadataStore) {
      metadataStore.setRestorationStatus?.(tabId, "restoring");
    }

    checkAborted();

    // ── 2. STAGE_LOAD_URL ────────────────────────────────────────────────────
    session.setStage(RestorationStage.LOAD_URL, { targetUrl });
    checkAborted();

    if (chromeApi?.tabs?.update) {
      await chromeApi.tabs.update(tabId, {
        url: targetUrl,
        active: session.options.autoFocus ? true : undefined
      });
    } else if (chromeApi?.tabs?.reload && tab?.discarded) {
      await chromeApi.tabs.reload(tabId);
    }

    checkAborted();

    // ── 3. STAGE_WAIT_READINESS ──────────────────────────────────────────────
    session.setStage(RestorationStage.WAIT_READINESS);
    checkAborted();

    await waitForTabReadiness(tabId, session.options.readinessTimeoutMs, signal, chromeApi);
    checkAborted();

    // ── 4. STAGE_RESTORE_SCROLL ──────────────────────────────────────────────
    if (session.options.restoreScroll && session.plan?.scroll) {
      session.setStage(RestorationStage.RESTORE_SCROLL, session.plan.scroll);
      checkAborted();

      await executeScrollRestorationStep(tabId, session.plan.scroll, chromeApi);
    }
    checkAborted();

    // ── 5. STAGE_RESTORE_FORMS ───────────────────────────────────────────────
    const formSavingEnabled = isFormSavingEnabled();
    const hasForms = session.plan?.forms && Object.keys(session.plan.forms).length > 0;

    if (session.options.restoreForms && formSavingEnabled && hasForms) {
      session.setStage(RestorationStage.RESTORE_FORMS, { fieldCount: Object.keys(session.plan.forms).length });
      checkAborted();

      await executeFormRestorationStep(tabId, session.plan.forms, targetUrl, chromeApi);
    }
    checkAborted();

    // ── 6. STAGE_APPLY_ADAPTER ───────────────────────────────────────────────
    if (session.options.applyAdapters && adapterRegistry) {
      session.setStage(RestorationStage.APPLY_ADAPTER);
      checkAborted();

      const adapter = adapterRegistry.findMatchingAdapter?.(targetUrl);
      if (adapter && typeof adapter.restore === "function") {
        const adapterTimeoutMs = session.options.adapterTimeoutMs || 3000;
        const adapterRes = await executeAdapterRestore(adapter, tabId, session.plan, {
          chromeApi,
          signal,
          timeoutMs: adapterTimeoutMs,
          session
        });

        if (!adapterRes.ok) {
          // Adapter failures must be isolated and not crash the whole restoration
          session.history.push({
            stage: RestorationStage.APPLY_ADAPTER,
            detail: `Adapter error (isolated): ${adapterRes.error}`,
            timestamp: Date.now()
          });
        }
      }
    }
    checkAborted();

    // ── 7. STAGE_COMPLETED ───────────────────────────────────────────────────
    session.complete();

    // Transition tab lifecycle to RESTORED
    if (lifecycleTracker) {
      try {
        lifecycleTracker.transition(tabId, TabState.RESTORED, "pipeline_complete");
      } catch (_) {}
    }

    // Update persistent metadata
    if (metadataStore) {
      if (typeof metadataStore.recordRestoration === "function") {
        metadataStore.recordRestoration(tabId, "restored");
      } else if (typeof metadataStore.setRestorationStatus === "function") {
        metadataStore.setRestorationStatus(tabId, "restored");
      }
    }

    return {
      ok: true,
      tabId,
      stage: session.stage,
      plan: session.plan,
      durationMs: Date.now() - session.startTime
    };

  } catch (err) {
    if (signal.aborted || session.isCancelled) {
      if (lifecycleTracker) {
        try {
          lifecycleTracker.transition(tabId, TabState.DISCARDED, `restoration_cancelled: ${session.error || 'cancelled'}`);
        } catch (_) {}
      }
      return {
        ok: false,
        cancelled: true,
        timedOut: session.isTimedOut,
        tabId,
        stage: RestorationStage.CANCELLED,
        error: session.error || (session.isTimedOut ? "Restoration timed out" : "Restoration cancelled")
      };
    }

    session.fail(err);

    // Transition tab lifecycle to RESTORE_FAILED
    if (lifecycleTracker) {
      try {
        lifecycleTracker.transition(tabId, TabState.RESTORE_FAILED, err.message);
      } catch (_) {}
    }

    if (metadataStore) {
      if (typeof metadataStore.recordRestoration === "function") {
        metadataStore.recordRestoration(tabId, "failed");
      } else if (typeof metadataStore.setRestorationStatus === "function") {
        metadataStore.setRestorationStatus(tabId, "failed");
      }
    }

    return {
      ok: false,
      tabId,
      stage: RestorationStage.FAILED,
      error: err.message
    };
  }
}

/**
 * Waits for a tab to finish loading or reach interactive readiness.
 */
export async function waitForTabReadiness(tabId, timeoutMs = 10000, signal = null, chromeApi = null) {
  if (!chromeApi?.tabs?.onUpdated) {
    // If no browser tab event system (e.g. unit testing), simulate brief settling delay
    return new Promise((resolve) => setTimeout(resolve, 20));
  }

  return new Promise((resolve, reject) => {
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      try {
        chromeApi.tabs.onUpdated.removeListener(onUpdatedListener);
      } catch (_) {}
    };

    const onUpdatedListener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        cleanup();
        resolve(true);
      }
    };

    if (signal) {
      signal.addEventListener("abort", () => {
        cleanup();
        reject(new Error("Readiness wait aborted"));
      }, { once: true });
    }

    timer = setTimeout(() => {
      cleanup();
      // Gracefully resolve on readiness timeout rather than completely failing
      resolve(false);
    }, timeoutMs);

    chromeApi.tabs.onUpdated.addListener(onUpdatedListener);
  });
}

/**
 * Executes scroll restoration script injection or message in the target tab.
 */
export async function executeScrollRestorationStep(tabId, scrollData, chromeApi) {
  if (!scrollData || (!scrollData.y && !scrollData.x)) return;

  if (chromeApi?.scripting?.executeScript) {
    try {
      await chromeApi.scripting.executeScript({
        target: { tabId },
        func: (x, y) => {
          window.scrollTo({ left: x || 0, top: y || 0, behavior: "instant" });
        },
        args: [scrollData.x || 0, scrollData.y || 0]
      });
    } catch (_) {
      // Soft ignore script injection restriction
    }
  }
}

/**
 * Executes safe form restoration in the target tab.
 */
export async function executeFormRestorationStep(tabId, formsData, targetUrl, chromeApi) {
  if (!formsData || Object.keys(formsData).length === 0) return;

  if (chromeApi?.tabs?.sendMessage) {
    try {
      // Explicitly scoped to the top frame: form snapshots are captured
      // against the top-level document, and content_scripts now run in
      // every iframe too (all_frames: true, for call detection) — without
      // an explicit frameId, chrome.tabs.sendMessage broadcasts to every
      // frame, and a generically-named selector (e.g. "#email") could
      // match an unrelated element in an embedded iframe.
      await chromeApi.tabs.sendMessage(tabId, {
        type: "restore-form-state",
        url: targetUrl,
        forms: formsData
      }, { frameId: 0 });
    } catch (_) {
      // Soft ignore if content script not yet injected
    }
  }
}

/**
 * Calculates exponential backoff delay with optional ceiling.
 * @param {number} attempt Current retry attempt index (0-based or 1-based, clamped to >= 0)
 * @param {number} baseBackoffMs Base delay in milliseconds (default: 500)
 * @param {number} factor Exponential multiplier (default: 1.5)
 * @param {number} maxDelayMs Maximum delay ceiling (default: 10000)
 * @returns {number} Backoff delay in milliseconds
 */
export function calculateRetryBackoff(attempt = 0, baseBackoffMs = 500, factor = 1.5, maxDelayMs = 10000) {
  const safeAttempt = Math.max(0, Number(attempt) || 0);
  const safeBase = Math.max(0, Number(baseBackoffMs) || 500);
  const safeFactor = Math.max(1, Number(factor) || 1.5);
  const safeMax = Math.max(safeBase, Number(maxDelayMs) || 10000);
  const delay = safeBase * Math.pow(safeFactor, safeAttempt);
  return Math.min(safeMax, Math.round(delay));
}

/**
 * Determines if a restoration error is eligible for automated retry.
 * @param {Error|string} error
 * @returns {boolean}
 */
export function isRetryableRestorationError(error) {
  if (!error) return false;
  const msg = (error?.message || String(error)).toLowerCase();
  if (
    msg.includes("cancel") ||
    msg.includes("aborted") ||
    msg.includes("not found") ||
    msg.includes("closed") ||
    msg.includes("invalid") ||
    msg.includes("cannot access a chrome://") ||
    msg.includes("permission denied")
  ) {
    return false;
  }
  return true;
}

/**
 * Comprehensive Restoration Engine
 * Manages concurrency, queues, duplicate prevention, cancellation, and retry handling.
 */
export class RestorationEngine {
  constructor(options = {}, context = {}) {
    this.options = { ...DEFAULT_RESTORATION_OPTIONS, ...options };
    this.context = context;

    /**
     * Map of tabId -> Active RestorationSession
     * Prevents duplicate restoration for the same tab.
     * @type {Map<number, RestorationSession>}
     */
    this.inFlightSessions = new Map();

    /**
     * Map of tabId -> active Promise
     * @type {Map<number, Promise<object>>}
     */
    this.inFlightPromises = new Map();

    /**
     * Priority Restoration Queue for concurrency control.
     * @type {RestoreQueue}
     */
    this.restoreQueue = new RestoreQueue({ maxConcurrent: this.options.maxConcurrentRestorations });
    this.queue = this.restoreQueue._items;

    /**
     * Map of tabId -> Deferred Restoration record
     * Tabs whose restoration is deferred until user explicitly focuses/activates the tab.
     * @type {Map<number, object>}
     */
    this.deferredRestores = new Map();

    /**
     * Map of tabId -> Failed Restoration record
     * Tabs whose restoration failed, enabling automated and manual retry tracking.
     * @type {Map<number, object>}
     */
    this.failedRestorations = new Map();

    /**
     * Recent restoration status history for UI monitoring.
     * @type {Map<number, object>}
     */
    this.recentStatuses = new Map();

    /**
     * Event listeners.
     */
    this.listeners = new Map();
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    return () => this.listeners.get(event)?.delete(callback);
  }

  emit(event, data) {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(data);
      } catch (_) {}
    }
  }

  /**
   * Returns current restoration status for a tab.
   * @param {number} tabId
   * @returns {object|null}
   */
  getStatus(tabId) {
    const active = this.inFlightSessions.get(tabId);
    if (active) return active.getStatus();

    const deferred = this.deferredRestores.get(tabId);
    if (deferred) {
      return {
        tabId,
        stage: RestorationStage.DEFERRED,
        progress: STAGE_PROGRESS_MAP[RestorationStage.DEFERRED] ?? 0,
        startTime: deferred.deferredAt,
        updatedTime: Date.now(),
        durationMs: Date.now() - deferred.deferredAt,
        attempt: 0,
        error: null,
        targetUrl: deferred.targetUrl || deferred.options?.targetUrl || null,
        isComplete: false,
        isFailed: false,
        isCancelled: false,
        isTimedOut: false,
        isQueued: false,
        isDeferred: true,
        deferredReason: deferred.reason || "background_tab",
        priority: deferred.priorityName || "normal",
        historyCount: 0
      };
    }

    const queueIdx = this.queue.findIndex(item => item.tabId === tabId);
    if (queueIdx !== -1) {
      const item = this.queue[queueIdx];
      return {
        tabId,
        stage: RestorationStage.QUEUED,
        progress: STAGE_PROGRESS_MAP[RestorationStage.QUEUED] ?? 5,
        startTime: item.queuedAt,
        updatedTime: Date.now(),
        durationMs: Date.now() - item.queuedAt,
        attempt: 1,
        error: null,
        targetUrl: item.options?.targetUrl || null,
        isComplete: false,
        isFailed: false,
        isCancelled: false,
        isTimedOut: false,
        isQueued: true,
        queuePosition: queueIdx + 1,
        queueTotal: this.queue.length,
        priority: item.options?.priority || "normal",
        historyCount: 0
      };
    }

    const recent = this.recentStatuses.get(tabId);
    if (recent) {
      if (this.failedRestorations.has(tabId)) {
        recent.canRetry = true;
      }
      return recent;
    }

    const failed = this.failedRestorations.get(tabId);
    if (failed) {
      return {
        tabId,
        stage: failed.stage || RestorationStage.FAILED,
        progress: 0,
        startTime: failed.failedAt,
        updatedTime: failed.failedAt,
        durationMs: 0,
        attempt: failed.attempts || 1,
        error: failed.error,
        targetUrl: failed.targetUrl,
        isComplete: false,
        isFailed: true,
        isCancelled: false,
        isTimedOut: false,
        isQueued: false,
        isDeferred: false,
        canRetry: true,
        isRetryable: failed.isRetryable,
        retryCount: failed.retryCount || 1,
        historyCount: 0
      };
    }

    return null;
  }

  /**
   * Returns all active, queued, and deferred restoration statuses.
   */
  getAllStatuses() {
    const list = [];
    for (const session of this.inFlightSessions.values()) {
      list.push(session.getStatus());
    }
    for (const deferred of this.deferredRestores.values()) {
      list.push({
        tabId: deferred.tabId,
        stage: RestorationStage.DEFERRED,
        progress: STAGE_PROGRESS_MAP[RestorationStage.DEFERRED] ?? 0,
        startTime: deferred.deferredAt,
        updatedTime: Date.now(),
        durationMs: Date.now() - deferred.deferredAt,
        attempt: 0,
        error: null,
        targetUrl: deferred.targetUrl || deferred.options?.targetUrl || null,
        isComplete: false,
        isFailed: false,
        isCancelled: false,
        isTimedOut: false,
        isQueued: false,
        isDeferred: true,
        deferredReason: deferred.reason || "background_tab",
        priority: deferred.priorityName || "normal",
        historyCount: 0
      });
    }
    for (let i = 0; i < this.queue.length; i++) {
      const item = this.queue[i];
      list.push({
        tabId: item.tabId,
        stage: RestorationStage.QUEUED,
        progress: STAGE_PROGRESS_MAP[RestorationStage.QUEUED] ?? 5,
        startTime: item.queuedAt,
        updatedTime: Date.now(),
        durationMs: Date.now() - item.queuedAt,
        attempt: 1,
        error: null,
        targetUrl: item.options?.targetUrl || null,
        isComplete: false,
        isFailed: false,
        isCancelled: false,
        isTimedOut: false,
        isQueued: true,
        queuePosition: i + 1,
        queueTotal: this.queue.length,
        priority: item.options?.priority || "normal",
        historyCount: 0
      });
    }
    return list;
  }

  /**
   * Returns current snapshot of the restoration queue.
   * @returns {Array<object>}
   */
  getQueue() {
    return this.queue.map((item, idx) => ({
      tabId: item.tabId,
      position: idx + 1,
      queuedAt: item.queuedAt,
      priority: item.options?.priority || "normal"
    }));
  }

  /**
   * Returns the 1-based queue position for a given tab, or -1 if not queued.
   * @param {number} tabId
   * @returns {number}
   */
  getQueuePosition(tabId) {
    const idx = this.queue.findIndex(item => item.tabId === tabId);
    return idx !== -1 ? idx + 1 : -1;
  }

  /**
   * Clears all pending tabs from the restoration queue and resolves them as cancelled.
   * @param {string} reason
   * @returns {number} Number of tabs evicted from the queue
   */
  clearQueue(reason = "Restoration queue cleared") {
    const count = this.restoreQueue.clear(reason);
    if (count > 0) {
      this.emit("queue_cleared", { count, reason });
    }
    return count;
  }

  /**
   * Returns current queue size.
   */
  getQueueLength() {
    return this.restoreQueue.size();
  }

  /**
   * Returns number of active running restorations.
   */
  getActiveCount() {
    return this.inFlightSessions.size;
  }

  /**
   * Returns current maximum concurrent restorations limit.
   * @returns {number}
   */
  getMaxConcurrentRestorations() {
    return this.options.maxConcurrentRestorations;
  }

  /**
   * Returns current concurrency and queue capacity statistics.
   * @param {object} [options={}]
   * @param {boolean} [options.includeDeferred=false]
   * @returns {object}
   */
  getConcurrencyStats(options = {}) {
    let stats;
    if (this.restoreQueue) {
      stats = this.restoreQueue.getConcurrencyStats(this.inFlightSessions.size);
    } else {
      const active = this.inFlightSessions.size;
      const max = this.options.maxConcurrentRestorations;
      stats = {
        active,
        queued: this.queue.length,
        maxConcurrent: max,
        availableSlots: Math.max(0, max - active),
        isAtCapacity: active >= max
      };
    }
    if (options.includeDeferred) {
      stats.deferred = this.deferredRestores ? this.deferredRestores.size : 0;
    }
    if (options.includeFailed) {
      stats.failed = this.failedRestorations ? this.failedRestorations.size : 0;
    }
    return stats;
  }

  /**
   * Updates max concurrent restorations limit and drains waiting queue items if slots opened.
   * @param {number} max
   */
  setMaxConcurrentRestorations(max) {
    const num = Number(max);
    if (!Number.isFinite(num) || num < 1) {
      throw new Error("Invalid maxConcurrentRestorations: must be a number >= 1");
    }
    const normalized = Math.min(MAX_CONCURRENT_RESTORES, Math.round(num));
    this.options.maxConcurrentRestorations = normalized;
    if (this.restoreQueue) {
      this.restoreQueue.maxConcurrent = normalized;
    }
    this.emit("concurrency_limit_changed", { maxConcurrentRestorations: normalized });
    this._drainQueue();
  }

  /**
   * Loads and applies configured concurrency limit from storage.
   * @param {object} [storageApi]
   * @returns {Promise<number>}
   */
  async loadConfiguredConcurrency(storageApi = this.context?.storageApi || (typeof chrome !== "undefined" && chrome?.storage ? chrome.storage : null)) {
    const limit = await loadMaxConcurrentRestores(storageApi);
    this.setMaxConcurrentRestorations(limit);
    return limit;
  }

  /**
   * Saves current concurrency limit to storage.
   * @param {object} [storageApi]
   * @returns {Promise<number>}
   */
  async saveConfiguredConcurrency(storageApi = this.context?.storageApi || (typeof chrome !== "undefined" && chrome?.storage ? chrome.storage : null)) {
    return saveMaxConcurrentRestores(this.options.maxConcurrentRestorations, storageApi);
  }

  /**
   * Updates lazy background restore preference and emits event.
   * @param {boolean} enabled
   */
  setLazyRestoreBackgroundTabs(enabled) {
    const normalized = Boolean(enabled);
    this.options.lazyRestoreBackgroundTabs = normalized;
    this.emit("lazy_restore_setting_changed", { lazyRestoreBackgroundTabs: normalized });
  }

  /**
   * Returns whether lazy background restore is currently enabled on this engine.
   * @returns {boolean}
   */
  getLazyRestoreBackgroundTabs() {
    return Boolean(this.options.lazyRestoreBackgroundTabs);
  }

  /**
   * Loads lazy background restore preference from storage.
   * @param {object} [storageApi]
   * @returns {Promise<boolean>}
   */
  async loadConfiguredLazyRestore(storageApi = this.context?.storageApi || (typeof chrome !== "undefined" && chrome?.storage?.local ? chrome.storage.local : null)) {
    const val = await loadLazyRestoreBackgroundSetting(storageApi);
    this.setLazyRestoreBackgroundTabs(val);
    return val;
  }

  /**
   * Saves lazy background restore preference to storage.
   * @param {object} [storageApi]
   * @returns {Promise<boolean>}
   */
  async saveConfiguredLazyRestore(storageApi = this.context?.storageApi || (typeof chrome !== "undefined" && chrome?.storage?.local ? chrome.storage.local : null)) {
    return saveLazyRestoreBackgroundSetting(this.options.lazyRestoreBackgroundTabs, storageApi);
  }

  /**
   * Checks if a tab has its restoration deferred.
   * @param {number} tabId
   * @returns {boolean}
   */
  isDeferred(tabId) {
    return this.deferredRestores.has(tabId);
  }

  /**
   * Returns deferred restoration metadata for a tab, or null if not deferred.
   * @param {number} tabId
   * @returns {object|null}
   */
  getDeferred(tabId) {
    return this.deferredRestores.get(tabId) || null;
  }

  /**
   * Returns current count of deferred restorations.
   * @returns {number}
   */
  getDeferredCount() {
    return this.deferredRestores.size;
  }

  /**
   * Returns all pending deferred restorations.
   * @returns {Array<object>}
   */
  getDeferredTabs() {
    return Array.from(this.deferredRestores.values()).map(r => ({
      tabId: r.tabId,
      targetUrl: r.targetUrl,
      title: r.title,
      snapshotId: r.snapshotId,
      priority: r.priorityName,
      priorityLevel: r.priority,
      deferredAt: r.deferredAt,
      source: r.source,
      reason: r.reason
    }));
  }

  /**
   * Defers restoration for a tab until it is focused/activated by the user,
   * avoiding unnecessary background resource consumption.
   *
   * @param {number} tabId
   * @param {object} [options={}]
   * @returns {object} Deferral result
   */
  deferRestoration(tabId, options = {}) {
    if (typeof tabId !== "number") {
      throw new Error("Invalid tabId provided for deferral");
    }

    // If currently queued, remove from queue
    if (this.restoreQueue.has(tabId)) {
      this.restoreQueue.remove(tabId, "Deferred to save background memory");
    }

    const priority = options.priority !== undefined
      ? normalizeRestorePriority(options.priority)
      : RestorePriority.NORMAL;

    const deferredRecord = {
      tabId,
      options: { ...options },
      targetUrl: options.targetUrl || options.url || null,
      title: options.title || null,
      snapshotId: options.snapshotId || null,
      priority,
      priorityName: getPriorityName(priority),
      source: options.source || "deferred_background",
      reason: options.reason || "background_tab",
      deferredAt: Date.now()
    };

    this.deferredRestores.set(tabId, deferredRecord);

    this.emit("deferred", {
      tabId,
      targetUrl: deferredRecord.targetUrl,
      priority: deferredRecord.priorityName,
      priorityLevel: deferredRecord.priority,
      reason: deferredRecord.reason
    });

    return {
      ok: true,
      deferred: true,
      tabId,
      stage: RestorationStage.DEFERRED,
      message: "Restoration deferred until tab is focused"
    };
  }

  /**
   * Cancels a deferred restoration.
   * @param {number} tabId
   * @param {string} [reason="Deferred restore cancelled"]
   * @returns {boolean}
   */
  cancelDeferred(tabId, reason = "Deferred restore cancelled") {
    if (!this.deferredRestores.has(tabId)) return false;
    this.deferredRestores.delete(tabId);
    this.emit("deferred_cancelled", { tabId, reason });
    return true;
  }

  /**
   * Clears all deferred restorations.
   * @param {string} [reason="All deferred restores cleared"]
   * @returns {number}
   */
  clearDeferred(reason = "All deferred restores cleared") {
    const count = this.deferredRestores.size;
    this.deferredRestores.clear();
    if (count > 0) {
      this.emit("deferred_cleared", { count, reason });
    }
    return count;
  }

  /**
   * Triggers restoration of a deferred tab, executing it immediately with elevated priority.
   * @param {number} tabId
   * @param {object} [triggerOptions={}]
   * @returns {Promise<object>|null}
   */
  async triggerDeferred(tabId, triggerOptions = {}) {
    const record = this.deferredRestores.get(tabId);
    if (!record) return null;

    this.deferredRestores.delete(tabId);

    this.emit("deferred_triggered", {
      tabId,
      triggerOptions,
      originalOptions: record.options
    });

    const restoreOpts = {
      ...record.options,
      ...triggerOptions,
      lazy: false,
      force: true,
      priority: triggerOptions.priority !== undefined
        ? normalizeRestorePriority(triggerOptions.priority)
        : RestorePriority.USER_REQUESTED,
      source: triggerOptions.source || "user_focus"
    };

    return this.restoreTab(tabId, restoreOpts);
  }

  /**
   * Explicitly promotes a queued restoration to user_requested priority, moving it to front of line.
   *
   * @param {number} tabId
   * @param {number|string} [newPriority=RestorePriority.USER_REQUESTED]
   * @returns {object|null} Promotion result or null if tab is not queued
   */
  promoteQueuedRestore(tabId, newPriority = RestorePriority.USER_REQUESTED) {
    const queuedItem = this.restoreQueue.get(tabId);
    if (!queuedItem) return null;

    const oldPriority = queuedItem.priority;
    const oldPosition = this.restoreQueue.getPosition(tabId);
    const targetPriority = normalizeRestorePriority(newPriority);

    if (targetPriority <= oldPriority) {
      return { tabId, promoted: false, priority: oldPriority, position: oldPosition };
    }

    const newPosition = this.restoreQueue.promote(tabId, targetPriority);
    queuedItem.priority = targetPriority;
    queuedItem.priorityName = getPriorityName(targetPriority);
    this.emit("priority_promoted", {
      tabId,
      oldPriority,
      newPriority: targetPriority,
      oldPosition,
      newPosition,
      source: "manual"
    });
    return { tabId, promoted: true, oldPriority, newPriority: targetPriority, oldPosition, newPosition };
  }

  /**
   * Cancels all pending queued restorations with priority at or below threshold.
   *
   * @param {number|string} [maxPriorityThreshold=RestorePriority.LOW]
   * @param {string} [reason="Low-priority restore cancelled"]
   * @returns {Array<object>} Cancelled items
   */
  cancelQueuedByPriority(maxPriorityThreshold = RestorePriority.LOW, reason = "Low-priority restore cancelled") {
    const removed = this.restoreQueue.removeByPriority(maxPriorityThreshold, reason);
    if (removed.length > 0) {
      this.emit("low_priority_cancelled", {
        type: "queued",
        count: removed.length,
        tabIds: removed.map(i => i.tabId),
        reason,
        threshold: normalizeRestorePriority(maxPriorityThreshold)
      });
    }
    return removed;
  }

  /**
   * Cancels active in-flight restorations with priority at or below threshold.
   *
   * @param {number|string} [maxPriorityThreshold=RestorePriority.LOW]
   * @param {string} [reason="Low-priority restore cancelled"]
   * @param {object} [options={}]
   * @param {boolean} [options.requeue=false]
   * @returns {Array<number>} Cancelled tab IDs
   */
  cancelInFlightByPriority(maxPriorityThreshold = RestorePriority.LOW, reason = "Low-priority restore cancelled", { requeue = false } = {}) {
    const threshold = normalizeRestorePriority(maxPriorityThreshold);
    const cancelledTabIds = [];

    for (const [tabId, session] of this.inFlightSessions.entries()) {
      const sessionPriority = normalizeRestorePriority(session.options?.priority ?? RestorePriority.NORMAL);
      if (sessionPriority <= threshold) {
        session.cancel(reason);
        cancelledTabIds.push(tabId);
        this.emit("cancelled", { tabId, reason, wasQueued: false, priority: sessionPriority });

        if (requeue) {
          let itemResolve, itemReject;
          const promise = new Promise((resolve, reject) => {
            itemResolve = resolve;
            itemReject = reject;
          });
          this.restoreQueue.enqueue({
            tabId,
            options: session.options,
            priority: sessionPriority,
            source: session.options?.source || "background",
            title: session.plan?.title || "Requeued tab",
            url: session.targetUrl,
            queuedAt: Date.now(),
            resolve: itemResolve,
            reject: itemReject,
            promise
          });
        }
      }
    }

    if (cancelledTabIds.length > 0) {
      this.emit("low_priority_cancelled", {
        type: "in_flight",
        count: cancelledTabIds.length,
        tabIds: cancelledTabIds,
        reason,
        requeued: !!requeue,
        threshold
      });
    }

    return cancelledTabIds;
  }

  /**
   * Cancels both queued and optionally in-flight low-priority restorations.
   *
   * @param {number|string} [maxPriorityThreshold=RestorePriority.LOW]
   * @param {string} [reason="Low-priority restore cancelled"]
   * @param {object} [options={}]
   * @param {boolean} [options.cancelInFlight=false]
   * @param {boolean} [options.requeue=false]
   * @returns {object} Summary of cancelled restorations
   */
  cancelLowPriorityRestores(maxPriorityThreshold = RestorePriority.LOW, reason = "Low-priority restore cancelled", { cancelInFlight = false, requeue = false } = {}) {
    const queuedRemoved = this.cancelQueuedByPriority(maxPriorityThreshold, reason);
    let inFlightCancelled = [];
    if (cancelInFlight) {
      inFlightCancelled = this.cancelInFlightByPriority(maxPriorityThreshold, reason, { requeue });
    }
    return {
      queuedCancelled: queuedRemoved.length,
      inFlightCancelled: inFlightCancelled.length,
      tabIds: [...queuedRemoved.map(i => i.tabId), ...inFlightCancelled]
    };
  }

  /**
   * Checks if a tab is currently undergoing restoration.
   * @param {number} tabId
   * @returns {boolean}
   */
  isRestoring(tabId) {
    return this.inFlightSessions.has(tabId);
  }

  /**
   * Checks if a tab is currently waiting in the restoration queue.
   * @param {number} tabId
   * @returns {boolean}
   */
  isQueued(tabId) {
    return this.restoreQueue.has(tabId);
  }

  /**
   * Checks if a tab is either actively restoring or queued.
   * @param {number} tabId
   * @returns {boolean}
   */
  isRestoringOrQueued(tabId) {
    return this.isRestoring(tabId) || this.isQueued(tabId);
  }

  /**
   * Initiates restoration for a tab, respecting concurrency, priorities, and preventing duplicates.
   * Prioritizes user-requested restores by placing them ahead in the queue, or promoting
   * their priority if already queued at a lower priority.
   *
   * @param {number} tabId
   * @param {object} options
   * @returns {Promise<object>}
   */
  async restoreTab(tabId, options = {}) {
    if (typeof tabId !== "number") {
      throw new Error("Invalid tabId provided for restoration");
    }

    const isUser = isUserRequestedRestore(options);
    const priority = options.priority !== undefined
      ? normalizeRestorePriority(options.priority)
      : (isUser ? RestorePriority.USER_REQUESTED : RestorePriority.NORMAL);

    // 1. Prevent duplicate restoration: return existing in-flight promise if active
    if (this.inFlightPromises.has(tabId)) {
      this.emit("duplicate_prevented", { tabId, status: "in_flight" });
      return this.inFlightPromises.get(tabId);
    }

    // 2. Handle previously deferred restoration:
    // If user explicitly requests restore, or restore is forced, or lazy is explicitly disabled,
    // release from deferred state and continue immediately into active restoration pipeline.
    if (this.deferredRestores.has(tabId)) {
      if (isUser || options.force || options.lazy === false) {
        this.deferredRestores.delete(tabId);
        this.emit("deferred_triggered", { tabId, reason: "user_focus_or_force" });
      } else {
        this.emit("duplicate_prevented", { tabId, status: "deferred" });
        return {
          ok: true,
          deferred: true,
          tabId,
          stage: RestorationStage.DEFERRED,
          message: "Restoration deferred until tab is focused"
        };
      }
    }

    // 3. Avoid restoring tabs in the background unnecessarily:
    // Evaluate if this restore should be deferred until the user focuses the tab.
    let isBackground = options.isBackground;
    if (isBackground === undefined && (options.lazy || options.lazyRestoreBackgroundTabs || this.options.lazyRestoreBackgroundTabs)) {
      const chromeApi = this.context?.chromeApi || (typeof chrome !== "undefined" ? chrome : null);
      if (chromeApi?.tabs?.get) {
        try {
          const tabInfo = await chromeApi.tabs.get(tabId);
          if (tabInfo) {
            isBackground = !tabInfo.active;
          }
        } catch (_) {}
      }
    }

    const deferCheckOpts = { ...options, isBackground, priority };
    if (shouldDeferBackgroundRestoration(tabId, deferCheckOpts, { options: this.options, chromeApi: this.context?.chromeApi })) {
      return this.deferRestoration(tabId, deferCheckOpts);
    }

    // Prevent duplicate restoration: return existing queued promise if already queued,
    // but promote priority to the front if user explicitly requested it!
    const queuedItem = this.restoreQueue.get(tabId);
    if (queuedItem) {
      if (priority > queuedItem.priority) {
        const oldPriority = queuedItem.priority;
        const oldPosition = this.restoreQueue.getPosition(tabId);
        const newPosition = this.restoreQueue.promote(tabId, priority);
        queuedItem.priority = priority;
        queuedItem.priorityName = getPriorityName(priority);
        if (options.source) queuedItem.source = options.source;
        this.emit("priority_promoted", {
          tabId,
          oldPriority,
          newPriority: priority,
          oldPosition,
          newPosition,
          source: options.source || (isUser ? "user" : "unknown")
        });
      } else {
        this.emit("duplicate_prevented", { tabId, status: "queued" });
      }
      return queuedItem.promise;
    }

    // 2. Preempt low-priority in-flight restores if user requested and at capacity
    if (isUser && this.inFlightSessions.size >= this.options.maxConcurrentRestorations && (options.preemptLowPriority || this.options.preemptLowPriorityOnUserRestore)) {
      let lowestSession = null;
      let lowestPriority = Infinity;
      for (const sess of this.inFlightSessions.values()) {
        const sp = normalizeRestorePriority(sess.options?.priority ?? RestorePriority.NORMAL);
        if (sp < lowestPriority) {
          lowestPriority = sp;
          lowestSession = sess;
        }
      }

      if (lowestSession && lowestPriority <= RestorePriority.LOW) {
        this.emit("preempted", {
          preemptedTabId: lowestSession.tabId,
          preemptedPriority: lowestPriority,
          byTabId: tabId,
          byPriority: priority
        });
        this.cancelInFlightByPriority(lowestPriority, `Preempted by user-requested restore of tab ${tabId}`, { requeue: true });
      }
    }

    // 3. Concurrency control: if at max concurrent restorations, enqueue
    if (this.inFlightSessions.size >= this.options.maxConcurrentRestorations) {
      let itemResolve, itemReject;
      const promise = new Promise((resolve, reject) => {
        itemResolve = resolve;
        itemReject = reject;
      });
      const queuedItem = this.restoreQueue.enqueue({
        tabId,
        options,
        priority,
        source: options.source || (isUser ? "user" : "background"),
        title: options.title,
        url: options.targetUrl || options.url,
        queuedAt: Date.now(),
        resolve: itemResolve,
        reject: itemReject,
        promise
      });

      const position = queuedItem.position;
      this.emit("queued", {
        tabId,
        position,
        totalQueued: queuedItem.totalQueued,
        priority: queuedItem.priorityName,
        priorityLevel: queuedItem.priority
      });
      return promise;
    }

    // 3. Start restoration execution
    const mergedOptions = { ...this.options, ...options, priority };
    const session = new RestorationSession(tabId, mergedOptions);
    this.inFlightSessions.set(tabId, session);

    this.emit("concurrency_slot_acquired", {
      tabId,
      activeCount: this.inFlightSessions.size,
      maxConcurrentRestorations: this.options.maxConcurrentRestorations,
      availableSlots: Math.max(0, this.options.maxConcurrentRestorations - this.inFlightSessions.size)
    });

    const promise = this._executeSession(session, mergedOptions);
    this.inFlightPromises.set(tabId, promise);

    try {
      const result = await promise;
      if (result && !result.ok && !result.cancelled) {
        const failureRecord = this._recordFailure(tabId, session, result, mergedOptions);
        if (!session._failedEmitted) {
          session._failedEmitted = true;
          this.emit("failed", { tabId, error: result.error, session: session.getStatus(), failureRecord });
        }
      } else if (result && (result.ok || result.cancelled)) {
        this.failedRestorations.delete(tabId);
      }
      return result;
    } finally {
      this.inFlightSessions.delete(tabId);
      this.inFlightPromises.delete(tabId);
      this.emit("concurrency_slot_released", {
        tabId,
        activeCount: this.inFlightSessions.size,
        maxConcurrentRestorations: this.options.maxConcurrentRestorations,
        availableSlots: Math.max(0, this.options.maxConcurrentRestorations - this.inFlightSessions.size)
      });
      this._drainQueue();
    }
  }

  /**
   * Cancels an active or queued restoration.
   * @param {number} tabId
   * @param {string} reason
   * @returns {boolean}
   */
  cancelRestoration(tabId, reason = "User cancelled restoration") {
    // Check deferred
    if (this.deferredRestores.has(tabId)) {
      this.cancelDeferred(tabId, reason);
      this.emit("cancelled", { tabId, reason, wasDeferred: true });
      return true;
    }

    // Check queued
    if (this.restoreQueue.has(tabId)) {
      const removed = this.restoreQueue.remove(tabId, reason);
      if (removed) {
        this.emit("cancelled", { tabId, reason, wasQueued: true });
        return true;
      }
    }

    // Check active
    const session = this.inFlightSessions.get(tabId);
    if (session) {
      session.cancel(reason);
      this.emit("cancelled", { tabId, reason, wasQueued: false });
      return true;
    }

    // Check failed
    if (this.failedRestorations.has(tabId)) {
      this.failedRestorations.delete(tabId);
      this.emit("cancelled", { tabId, reason, wasFailed: true });
      return true;
    }

    return false;
  }

  /**
   * Retries restoration for a failed or specific tab.
   * @param {number} tabId
   * @param {object} options
   * @returns {Promise<object>}
   */
  async retryRestoration(tabId, options = {}) {
    this.cancelRestoration(tabId, "Retrying");
    const prev = this.failedRestorations.get(tabId);
    const retryOptions = {
      ...(prev?.options || {}),
      ...options,
      force: true,
      priority: options.priority ?? RestorePriority.USER_REQUESTED
    };

    if (options.fallback) {
      retryOptions.restoreScroll = false;
      retryOptions.restoreForms = false;
      retryOptions.applyAdapters = false;
    }

    this.emit("retry_initiated", { tabId, options: retryOptions, previousAttempts: prev?.attempts || 1 });
    return this.restoreTab(tabId, retryOptions);
  }

  /**
   * Retries restoration for all recorded failed tabs.
   * @param {object} options
   * @returns {Promise<{ total: number, retried: number, results: Array<{ tabId: number, ok: boolean, result?: object, error?: string }> }>}
   */
  async retryAllFailed(options = {}) {
    const failedIds = Array.from(this.failedRestorations.keys());
    const results = [];
    for (const tabId of failedIds) {
      try {
        const res = await this.retryRestoration(tabId, options);
        results.push({ tabId, ok: !!res?.ok, result: res });
      } catch (err) {
        results.push({ tabId, ok: false, error: err?.message || String(err) });
      }
    }
    return {
      total: failedIds.length,
      retried: results.length,
      results
    };
  }

  /**
   * Returns all recorded failed restorations.
   * @returns {Array<object>}
   */
  getFailedRestorations() {
    return Array.from(this.failedRestorations.values());
  }

  /**
   * Returns failed restoration record for a given tabId, or null if none.
   * @param {number} tabId
   * @returns {object|null}
   */
  getFailedRestoration(tabId) {
    return this.failedRestorations.get(tabId) || null;
  }

  /**
   * Returns count of recorded failed restorations.
   * @returns {number}
   */
  getFailedCount() {
    return this.failedRestorations.size;
  }

  /**
   * Clears a recorded failed restoration for a given tabId.
   * @param {number} tabId
   * @returns {boolean} True if a record was removed
   */
  clearFailedRestoration(tabId) {
    return this.failedRestorations.delete(tabId);
  }

  /**
   * Clears all recorded failed restorations.
   * @returns {number} Count of records cleared
   */
  clearFailedRestorations() {
    const count = this.failedRestorations.size;
    this.failedRestorations.clear();
    this.emit("failed_cleared", { count });
    return count;
  }

  /**
   * Records a failed restoration for retry tracking.
   */
  _recordFailure(tabId, session, result, mergedOptions = this.options) {
    const prev = this.failedRestorations.get(tabId);
    const failureRecord = {
      tabId,
      error: result.error,
      stage: session?.stage || RestorationStage.FAILED,
      attempts: session?.attempt || 1,
      maxAttempts: (mergedOptions.maxRetries || 0) + 1,
      retryCount: (prev?.retryCount || 0) + 1,
      failedAt: Date.now(),
      targetUrl: session?.targetUrl || session?.snapshot?.url || mergedOptions?.targetUrl || null,
      title: session?.snapshot?.title || null,
      isRetryable: isRetryableRestorationError(result.error),
      options: { ...mergedOptions }
    };
    this.failedRestorations.set(tabId, failureRecord);
    return failureRecord;
  }

  /**
   * Internal session executor with timeout, retries, and event emissions.
   */
  async _executeSession(session, mergedOptions = this.options) {
    const tabId = session.tabId;

    // Setup global session timeout
    session.timeoutTimer = setTimeout(() => {
      session.markTimedOut(`Restoration timed out after ${mergedOptions.timeoutMs}ms`);
      this.emit("timeout", { tabId, timeoutMs: mergedOptions.timeoutMs });
    }, mergedOptions.timeoutMs);

    // Forward stage updates to listeners
    const originalSetStage = session.setStage.bind(session);
    session.setStage = (stage, detail) => {
      originalSetStage(stage, detail);
      this.emit("stageChange", {
        tabId,
        stage,
        progress: session.progress,
        detail
      });
    };

    let result = null;
    let attempt = 1;
    const maxAttempts = (mergedOptions.maxRetries || 0) + 1;

    while (attempt <= maxAttempts) {
      session.attempt = attempt;
      result = await runRestorationPipeline(session, this.context);

      if (result.ok || result.cancelled || attempt >= maxAttempts || !isRetryableRestorationError(result.error)) {
        break;
      }

      // If failed and retries left, wait backoff and retry
      attempt++;
      session.isFailed = false;
      session.error = null;
      session.history.push({
        stage: RestorationStage.INIT,
        progress: 10,
        timestamp: Date.now(),
        detail: `Retrying (attempt ${attempt}/${maxAttempts}) after error: ${result.error}`
      });

      const delay = calculateRetryBackoff(attempt - 2, mergedOptions.retryBackoffMs, 1.5, mergedOptions.maxRetryDelayMs || 10000);
      this.emit("retry", {
        tabId,
        attempt,
        maxAttempts,
        delayMs: delay,
        error: result.error
      });

      await new Promise(r => setTimeout(r, delay));
    }

    const finalStatus = session.getStatus();
    if (!result.ok && !result.cancelled) {
      finalStatus.canRetry = true;
      finalStatus.isRetryable = isRetryableRestorationError(result.error);
      finalStatus.failedAttempts = session.attempt;
      finalStatus.maxAttempts = maxAttempts;
    }
    this.recentStatuses.set(tabId, finalStatus);

    // Prune recent statuses to prevent memory leak
    if (this.recentStatuses.size > 100) {
      const oldestKey = this.recentStatuses.keys().next().value;
      this.recentStatuses.delete(oldestKey);
    }

    if (result.ok) {
      this.failedRestorations.delete(tabId);
      this.emit("completed", { tabId, result });
    } else if (result.cancelled) {
      this.failedRestorations.delete(tabId);
      this.emit("cancelled", { tabId, result });
    } else {
      const failureRecord = this._recordFailure(tabId, session, result, mergedOptions);
      session._failedEmitted = true;
      this.emit("failed", { tabId, error: result.error, session: finalStatus, failureRecord });
    }

    return result;
  }

  /**
   * Drains the pending queue up to concurrency limit.
   */
  _drainQueue() {
    while (this.queue.length > 0 && this.inFlightSessions.size < this.options.maxConcurrentRestorations) {
      const item = this.queue.shift();
      if (!item) break;

      this.emit("dequeued", {
        tabId: item.tabId,
        remainingQueued: this.queue.length,
        priority: item.options?.priority || "normal"
      });

      const mergedOptions = { ...this.options, ...item.options };
      const session = new RestorationSession(item.tabId, mergedOptions);
      this.inFlightSessions.set(item.tabId, session);

      this.emit("concurrency_slot_acquired", {
        tabId: item.tabId,
        activeCount: this.inFlightSessions.size,
        maxConcurrentRestorations: this.options.maxConcurrentRestorations,
        availableSlots: Math.max(0, this.options.maxConcurrentRestorations - this.inFlightSessions.size)
      });

      const promise = this._executeSession(session, mergedOptions);
      this.inFlightPromises.set(item.tabId, promise);

      (async () => {
        let result, error;
        try {
          result = await promise;
        } catch (err) {
          error = err;
        } finally {
          this.inFlightSessions.delete(item.tabId);
          this.inFlightPromises.delete(item.tabId);
          this.emit("concurrency_slot_released", {
            tabId: item.tabId,
            activeCount: this.inFlightSessions.size,
            maxConcurrentRestorations: this.options.maxConcurrentRestorations,
            availableSlots: Math.max(0, this.options.maxConcurrentRestorations - this.inFlightSessions.size)
          });
          this._drainQueue();
        }
        if (error) {
          item.reject(error);
        } else {
          item.resolve(result);
        }
      })();
    }

    if (this.queue.length === 0 && this.inFlightSessions.size === 0) {
      this.emit("queue_drained");
    }
  }
}

let globalRestorationEngine = null;

/**
 * Returns singleton instance of RestorationEngine.
 * @param {object} options
 * @param {object} context
 * @returns {RestorationEngine}
 */
export function getRestorationEngine(options = {}, context = {}) {
  if (!globalRestorationEngine) {
    globalRestorationEngine = new RestorationEngine(options, context);
  }
  return globalRestorationEngine;
}

/**
 * Resets the singleton restoration engine.
 */
export function resetRestorationEngine() {
  if (globalRestorationEngine) {
    globalRestorationEngine.clearQueue("Engine reset");
    globalRestorationEngine.clearDeferred("Engine reset");
    for (const [tabId, session] of globalRestorationEngine.inFlightSessions.entries()) {
      session.cancel("Engine reset");
    }
    globalRestorationEngine = null;
  }
}
