// TabVault — Tab Lifecycle State Model & Transition Machine

export const TabState = Object.freeze({
  ACTIVE: "ACTIVE",
  IDLE: "IDLE",
  SNAPSHOTTING: "SNAPSHOTTING",
  DISCARDED: "DISCARDED",
  RESTORING: "RESTORING",
  RESTORED: "RESTORED",
  RESTORE_FAILED: "RESTORE_FAILED",
  CLOSED: "CLOSED"
});

export const ALLOWED_TRANSITIONS = Object.freeze({
  [TabState.ACTIVE]: Object.freeze([
    TabState.IDLE,
    TabState.SNAPSHOTTING,
    TabState.CLOSED
  ]),
  [TabState.IDLE]: Object.freeze([
    TabState.ACTIVE,
    TabState.SNAPSHOTTING,
    TabState.CLOSED
  ]),
  [TabState.SNAPSHOTTING]: Object.freeze([
    TabState.DISCARDED,
    TabState.IDLE,
    TabState.ACTIVE,
    TabState.CLOSED
  ]),
  [TabState.DISCARDED]: Object.freeze([
    TabState.RESTORING,
    TabState.ACTIVE,
    TabState.CLOSED
  ]),
  [TabState.RESTORING]: Object.freeze([
    TabState.RESTORED,
    TabState.RESTORE_FAILED,
    TabState.DISCARDED,
    TabState.CLOSED
  ]),
  [TabState.RESTORED]: Object.freeze([
    TabState.ACTIVE,
    TabState.IDLE,
    TabState.CLOSED
  ]),
  [TabState.RESTORE_FAILED]: Object.freeze([
    TabState.RESTORING,
    TabState.ACTIVE,
    TabState.DISCARDED,
    TabState.CLOSED
  ]),
  [TabState.CLOSED]: Object.freeze([])
});

/**
 * Checks if a transition between two states is valid according to the lifecycle model.
 * @param {string} fromState Current state
 * @param {string} toState Target state
 * @returns {boolean}
 */
export function isValidTransition(fromState, toState) {
  if (!fromState || !toState) return false;
  if (!TabState[fromState] || !TabState[toState]) return false;
  if (fromState === toState) return true; // Idempotent no-op
  const allowed = ALLOWED_TRANSITIONS[fromState];
  return Array.isArray(allowed) && allowed.includes(toState);
}

/**
 * Validates a proposed state transition.
 * @param {string} fromState Current state
 * @param {string} toState Target state
 * @throws {Error} if the transition is invalid
 */
export function assertValidTransition(fromState, toState) {
  if (!isValidTransition(fromState, toState)) {
    throw new Error(`[TabVault Lifecycle] Invalid state transition from ${fromState} to ${toState}`);
  }
}

/**
 * Tracks tab lifecycle state transitions in-memory with validation, history, and hooks.
 */
export class LifecycleTracker {
  constructor(options = {}) {
    this.maxHistory = options.maxHistory || 10;
    this.onTransition = options.onTransition || null;
    this.debug = options.debug !== false; // enabled by default
    this.logger = options.logger || console.log;
    this.tabs = new Map(); // Map<tabId, { tabId, state, lastTransitionAt, history }>
  }

  setLogger(logger) {
    this.logger = logger;
  }

  setDebug(enabled) {
    this.debug = !!enabled;
  }

  log(msg, ...args) {
    if (this.debug && typeof this.logger === "function") {
      this.logger(`[TabVault Lifecycle] ${msg}`, ...args);
    }
  }

  getState(tabId) {
    const entry = this.tabs.get(tabId);
    return entry ? entry.state : TabState.ACTIVE;
  }

  getEntry(tabId) {
    return this.tabs.get(tabId) || null;
  }

  getHistory(tabId) {
    const entry = this.tabs.get(tabId);
    return entry ? [...entry.history] : [];
  }

  getAllStates() {
    const result = {};
    for (const [tabId, data] of this.tabs.entries()) {
      result[tabId] = data.state;
    }
    return result;
  }

  canTransition(tabId, targetState) {
    if (!TabState[targetState]) return false;
    const fromState = this.getState(tabId);
    return isValidTransition(fromState, targetState);
  }

  safeTransition(tabId, targetState, reason = "") {
    if (!this.canTransition(tabId, targetState)) {
      const fromState = this.getState(tabId);
      const errMsg = `Blocked invalid transition for tab #${tabId} from ${fromState} to ${targetState} (reason: "${reason || 'none'}")`;
      this.log(`WARN: ${errMsg}`);
      return {
        success: false,
        tabId,
        fromState,
        toState: targetState,
        error: errMsg
      };
    }
    return this.transition(tabId, targetState, reason);
  }

  transition(tabId, targetState, reason = "") {
    if (!TabState[targetState]) {
      throw new Error(`[TabVault Lifecycle] Unknown target state: ${targetState}`);
    }

    let entry = this.tabs.get(tabId);
    const fromState = entry ? entry.state : TabState.ACTIVE;

    // Idempotent check
    if (entry && entry.state === targetState) {
      return {
        success: true,
        tabId,
        fromState,
        toState: targetState,
        timestamp: entry.lastTransitionAt,
        reason,
        noop: true
      };
    }

    assertValidTransition(fromState, targetState);

    const now = Date.now();
    this.log(`[Tab #${tabId}] ${fromState} -> ${targetState} (${reason || 'no reason'})`);
    const transitionRecord = {
      from: fromState,
      to: targetState,
      timestamp: now,
      reason
    };

    if (!entry) {
      entry = {
        tabId,
        state: targetState,
        lastTransitionAt: now,
        history: [transitionRecord]
      };
      this.tabs.set(tabId, entry);
    } else {
      entry.state = targetState;
      entry.lastTransitionAt = now;
      entry.history.push(transitionRecord);
      if (entry.history.length > this.maxHistory) {
        entry.history.shift();
      }
    }

    const event = {
      success: true,
      tabId,
      fromState,
      toState: targetState,
      timestamp: now,
      reason
    };

    if (typeof this.onTransition === "function") {
      try {
        this.onTransition(event);
      } catch (err) {
        console.error("[TabVault Lifecycle] onTransition error:", err);
      }
    }

    if (this.storageAdapter) {
      this.persist().catch(() => {});
    }

    return event;
  }

  remove(tabId, reason = "tab_removed") {
    if (this.tabs.has(tabId)) {
      const current = this.getState(tabId);
      if (current !== TabState.CLOSED) {
        this.transition(tabId, TabState.CLOSED, reason);
      }
      this.tabs.delete(tabId);
      if (this.storageAdapter) {
        this.persist().catch(() => {});
      }
    }
  }

  clear() {
    this.tabs.clear();
    if (this.storageAdapter) {
      this.persist().catch(() => {});
    }
  }

  setStorageAdapter(adapter) {
    this.storageAdapter = adapter;
  }

  serialize() {
    const raw = {};
    for (const [tabId, entry] of this.tabs.entries()) {
      raw[tabId] = {
        tabId: entry.tabId,
        state: entry.state,
        lastTransitionAt: entry.lastTransitionAt,
        history: entry.history
      };
    }
    return raw;
  }

  deserialize(data) {
    this.tabs.clear();
    if (!data || typeof data !== "object") return;
    for (const [key, entry] of Object.entries(data)) {
      const tabId = Number(key);
      if (Number.isFinite(tabId) && entry && TabState[entry.state]) {
        this.tabs.set(tabId, {
          tabId,
          state: entry.state,
          lastTransitionAt: entry.lastTransitionAt || Date.now(),
          history: Array.isArray(entry.history) ? entry.history.slice(-this.maxHistory) : []
        });
      }
    }
  }

  async persist() {
    if (!this.storageAdapter) return false;
    try {
      await this.storageAdapter.set({ tabvault_lifecycle: this.serialize() });
      return true;
    } catch (err) {
      console.error("[TabVault Lifecycle] Failed to persist lifecycle state:", err);
      return false;
    }
  }

  async rehydrate() {
    if (!this.storageAdapter) return false;
    try {
      const res = await this.storageAdapter.get("tabvault_lifecycle");
      const data = res?.tabvault_lifecycle;
      if (data) {
        this.deserialize(data);
        return true;
      }
      return false;
    } catch (err) {
      console.error("[TabVault Lifecycle] Failed to rehydrate lifecycle state:", err);
      return false;
    }
  }

  /**
   * Reconciles tracked tabs with actual live tabs from browser query after restart or service worker wake.
   * Handles stale in-flight states (SNAPSHOTTING, RESTORING) and purges closed tabs.
   * @param {Array<object>} liveTabs - tabs returned from chrome.tabs.query
   * @param {Function} [isSuspendedUrlFn] - predicate determining if a URL is a suspended page
   * @returns {object} Summary of reconciliation
   */
  reconcileWithLiveTabs(liveTabs = [], isSuspendedUrlFn = null) {
    const liveIds = new Set();
    let reconciled = 0;
    let purgedClosed = 0;
    let recoveredStale = 0;

    for (const tab of liveTabs) {
      if (!tab || typeof tab.id !== "number") continue;
      liveIds.add(tab.id);

      const isSuspended = isSuspendedUrlFn
        ? isSuspendedUrlFn(tab.url)
        : (tab.url && tab.url.includes("suspended/suspended.html"));
      const isDiscarded = !!(tab.discarded || isSuspended);

      let targetState = TabState.IDLE;
      if (isDiscarded) {
        targetState = TabState.DISCARDED;
      } else if (tab.active) {
        targetState = TabState.ACTIVE;
      }

      const existing = this.tabs.get(tab.id);
      if (!existing) {
        this.tabs.set(tab.id, {
          tabId: tab.id,
          state: targetState,
          lastTransitionAt: Date.now(),
          history: [{
            from: targetState,
            to: targetState,
            timestamp: Date.now(),
            reason: "restart_discovered"
          }]
        });
        reconciled++;
      } else {
        // Check for stale intermediate states
        if (existing.state === TabState.SNAPSHOTTING || existing.state === TabState.RESTORING) {
          const priorState = existing.state;
          existing.state = targetState;
          existing.lastTransitionAt = Date.now();
          existing.history.push({
            from: priorState,
            to: targetState,
            timestamp: Date.now(),
            reason: "restart_recovered_stale"
          });
          if (existing.history.length > this.maxHistory) {
            existing.history.shift();
          }
          recoveredStale++;
          reconciled++;
        } else if (existing.state !== targetState && (isDiscarded || tab.active)) {
          const priorState = existing.state;
          existing.state = targetState;
          existing.lastTransitionAt = Date.now();
          existing.history.push({
            from: priorState,
            to: targetState,
            timestamp: Date.now(),
            reason: "restart_synced"
          });
          if (existing.history.length > this.maxHistory) {
            existing.history.shift();
          }
          reconciled++;
        }
      }
    }

    // Purge tabs that were closed while extension/browser was down
    for (const trackedId of Array.from(this.tabs.keys())) {
      if (!liveIds.has(trackedId)) {
        this.remove(trackedId, "restart_purged_closed");
        purgedClosed++;
      }
    }

    if (this.storageAdapter) {
      this.persist().catch(() => {});
    }

    const summary = {
      totalLive: liveTabs.length,
      reconciled,
      recoveredStale,
      purgedClosed
    };

    this.log(`Reconciliation complete: ${JSON.stringify(summary)}`);
    return summary;
  }
}

let globalLifecycleTracker = null;

/**
 * Returns singleton LifecycleTracker instance.
 * @param {object} options
 * @returns {LifecycleTracker}
 */
export function getLifecycleTracker(options = {}) {
  if (!globalLifecycleTracker) {
    globalLifecycleTracker = new LifecycleTracker(options);
  }
  return globalLifecycleTracker;
}

/**
 * Resets the singleton LifecycleTracker instance.
 */
export function resetLifecycleTracker() {
  globalLifecycleTracker = null;
}
