// TabVault — Site-Specific Adapter Failure Isolation & Diagnostics

export const MAX_FAILURE_HISTORY = 100;

/**
 * Diagnostic record representing an isolated adapter failure.
 * @typedef {object} AdapterFailureRecord
 * @property {string} id
 * @property {string} adapterId
 * @property {"matching"|"capture"|"restore"|"validation"} stage
 * @property {string} error
 * @property {string} [stack]
 * @property {number} [tabId]
 * @property {string} [url]
 * @property {number} timestamp
 */

export class AdapterFailureTracker {
  constructor(maxHistory = MAX_FAILURE_HISTORY) {
    this.maxHistory = maxHistory;
    /** @type {AdapterFailureRecord[]} */
    this.records = [];
  }

  /**
   * Records an isolated adapter error.
   *
   * @param {object} info
   * @param {string} info.adapterId
   * @param {"matching"|"capture"|"restore"|"validation"|string} info.stage
   * @param {Error|string} info.error
   * @param {number} [info.tabId]
   * @param {string} [info.url]
   * @returns {AdapterFailureRecord}
   */
  record(info) {
    const errorMsg = info.error instanceof Error ? info.error.message : String(info.error || "Unknown error");
    const stack = info.error instanceof Error ? info.error.stack : undefined;

    const record = {
      id: `fail_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      adapterId: info.adapterId || "unknown",
      stage: info.stage || "execution",
      error: errorMsg,
      stack,
      tabId: typeof info.tabId === "number" ? info.tabId : undefined,
      url: typeof info.url === "string" ? info.url : undefined,
      timestamp: Date.now()
    };

    this.records.push(record);

    if (this.records.length > this.maxHistory) {
      this.records.shift();
    }

    return record;
  }

  /**
   * Retrieves all recorded failures, optionally filtered.
   *
   * @param {object} [filter={}]
   * @param {string} [filter.adapterId]
   * @param {string} [filter.stage]
   * @param {number} [filter.tabId]
   * @returns {AdapterFailureRecord[]}
   */
  getFailures(filter = {}) {
    return this.records.filter(rec => {
      if (filter.adapterId && rec.adapterId !== filter.adapterId) return false;
      if (filter.stage && rec.stage !== filter.stage) return false;
      if (filter.tabId !== undefined && rec.tabId !== filter.tabId) return false;
      return true;
    });
  }

  /**
   * Retrieves failures for a specific adapter.
   *
   * @param {string} adapterId
   * @returns {AdapterFailureRecord[]}
   */
  getFailuresByAdapter(adapterId) {
    return this.getFailures({ adapterId });
  }

  /**
   * Count of recorded failures.
   *
   * @returns {number}
   */
  count() {
    return this.records.length;
  }

  /**
   * Clears failure history.
   */
  clear() {
    this.records = [];
  }
}

let globalFailureTracker = null;

/**
 * Returns singleton AdapterFailureTracker.
 * @returns {AdapterFailureTracker}
 */
export function getAdapterFailureTracker() {
  if (!globalFailureTracker) {
    globalFailureTracker = new AdapterFailureTracker();
  }
  return globalFailureTracker;
}

/**
 * Resets singleton AdapterFailureTracker.
 */
export function resetAdapterFailureTracker() {
  if (globalFailureTracker) {
    globalFailureTracker.clear();
    globalFailureTracker = null;
  }
}

/**
 * Safely invokes an adapter method with guaranteed failure isolation and automatic tracking.
 *
 * @template T
 * @param {string} adapterId
 * @param {"matching"|"capture"|"restore"|"validation"|string} stage
 * @param {() => Promise<T>|T} fn
 * @param {T} [fallback=null]
 * @param {object} [context={}]
 * @returns {Promise<{ ok: boolean, value: T, error?: string }>}
 */
export async function isolateAdapterOperation(adapterId, stage, fn, fallback = null, context = {}) {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (err) {
    const tracker = context.failureTracker || getAdapterFailureTracker();
    tracker.record({
      adapterId,
      stage,
      error: err,
      tabId: context.tabId,
      url: context.url
    });

    return {
      ok: false,
      value: fallback,
      error: err?.message || String(err)
    };
  }
}
