// TabVault — Restore Queue & Concurrency Engine
// Manages priority-based restoration queue, concurrency limits, user preemption,
// background tab deferral, and queue status reporting.

/**
 * Priority levels for tab restoration.
 * Higher values = higher scheduling precedence.
 */
export const RestorePriority = Object.freeze({
  USER_REQUESTED: 100, // Explicit user interaction (click in suspended tab or popup)
  HIGH: 75,            // Explicit high priority (e.g. pinned or audible tabs)
  NORMAL: 50,          // Standard restoration
  LOW: 25,             // Low priority background restoration
  BACKGROUND: 10       // Mass/batch restore all or session recovery
});

/**
 * Normalizes priority value or label to standard integer level.
 *
 * @param {string|number} priority
 * @returns {number}
 */
export function normalizeRestorePriority(priority) {
  if (typeof priority === "number" && Number.isFinite(priority)) {
    return Math.max(0, Math.min(100, Math.round(priority)));
  }
  if (typeof priority === "string") {
    const key = priority.trim().toUpperCase();
    if (key === "USER" || key === "USER_REQUESTED") return RestorePriority.USER_REQUESTED;
    if (key === "HIGH" || key === "URGENT") return RestorePriority.HIGH;
    if (key === "NORMAL" || key === "DEFAULT") return RestorePriority.NORMAL;
    if (key === "LOW") return RestorePriority.LOW;
    if (key === "BACKGROUND" || key === "BATCH") return RestorePriority.BACKGROUND;
  }
  return RestorePriority.NORMAL;
}

/**
 * Returns human-readable name for priority value.
 *
 * @param {number} priority
 * @returns {string}
 */
export function getPriorityName(priority) {
  if (priority >= RestorePriority.USER_REQUESTED) return "user_requested";
  if (priority >= RestorePriority.HIGH) return "high";
  if (priority >= RestorePriority.NORMAL) return "normal";
  if (priority >= RestorePriority.LOW) return "low";
  return "background";
}

/**
 * Checks if a restoration request option set indicates an explicit user request.
 *
 * @param {object} [options]
 * @returns {boolean}
 */
export function isUserRequestedRestore(options = {}) {
  if (!options) return false;
  if (options.source === "user") return true;
  if (options.userInitiated === true) return true;
  if (typeof options.priority === "number" && options.priority >= RestorePriority.USER_REQUESTED) return true;
  if (typeof options.priority === "string") {
    const key = options.priority.trim().toUpperCase();
    if (key === "USER" || key === "USER_REQUESTED") return true;
  }
  return false;
}

/**
 * Default concurrency configuration.
 */
export const DEFAULT_MAX_CONCURRENT_RESTORES = 3;
export const MIN_CONCURRENT_RESTORES = 1;
export const MAX_CONCURRENT_RESTORES = 10;
export const STORAGE_KEY_MAX_CONCURRENT_RESTORES = "tabvault_max_concurrent_restores";

/**
 * Normalizes and clamps the maximum concurrent restorations limit.
 *
 * @param {any} value
 * @param {number} [defaultValue=DEFAULT_MAX_CONCURRENT_RESTORES]
 * @returns {number}
 */
export function normalizeMaxConcurrentRestores(value, defaultValue = DEFAULT_MAX_CONCURRENT_RESTORES) {
  if (value === null || value === undefined || value === "") {
    return defaultValue;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return defaultValue;
  }
  return Math.max(MIN_CONCURRENT_RESTORES, Math.min(MAX_CONCURRENT_RESTORES, Math.round(num)));
}

/**
 * Loads configured max concurrent restorations from storage.
 *
 * @param {object} [storageApi]
 * @returns {Promise<number>}
 */
export async function loadMaxConcurrentRestores(storageApi = null) {
  const api = storageApi || (typeof chrome !== "undefined" && chrome?.storage ? chrome.storage : null);
  if (!api?.local?.get) {
    return DEFAULT_MAX_CONCURRENT_RESTORES;
  }
  try {
    const data = await api.local.get(STORAGE_KEY_MAX_CONCURRENT_RESTORES);
    if (data && data[STORAGE_KEY_MAX_CONCURRENT_RESTORES] !== undefined) {
      return normalizeMaxConcurrentRestores(data[STORAGE_KEY_MAX_CONCURRENT_RESTORES]);
    }
  } catch {
    // Fallback on storage read error
  }
  return DEFAULT_MAX_CONCURRENT_RESTORES;
}

/**
 * Saves configured max concurrent restorations to storage.
 *
 * @param {number} limit
 * @param {object} [storageApi]
 * @returns {Promise<number>}
 */
export async function saveMaxConcurrentRestores(limit, storageApi = null) {
  const normalized = normalizeMaxConcurrentRestores(limit);
  const api = storageApi || (typeof chrome !== "undefined" && chrome?.storage ? chrome.storage : null);
  if (api?.local?.set) {
    try {
      await api.local.set({ [STORAGE_KEY_MAX_CONCURRENT_RESTORES]: normalized });
    } catch {
      // Fallback on storage write error
    }
  }
  return normalized;
}

/**
 * Priority queue for tab restoration requests.
 * Orders requests by priority (descending), then by queued timestamp (FIFO).
 */
export class RestoreQueue {
  constructor(options = {}) {
    /** @type {Array<object>} */
    this._items = [];
    this._maxConcurrent = normalizeMaxConcurrentRestores(options.maxConcurrent);
  }

  get maxConcurrent() {
    return this._maxConcurrent;
  }

  set maxConcurrent(value) {
    this._maxConcurrent = normalizeMaxConcurrentRestores(value);
  }

  /**
   * Returns remaining available concurrency slots based on active restoration count.
   *
   * @param {number} [activeCount=0]
   * @returns {number}
   */
  getAvailableSlots(activeCount = 0) {
    const active = Math.max(0, Number(activeCount) || 0);
    return Math.max(0, this._maxConcurrent - active);
  }

  /**
   * Checks whether the active restorations count has reached or exceeded max concurrency.
   *
   * @param {number} [activeCount=0]
   * @returns {boolean}
   */
  isAtCapacity(activeCount = 0) {
    const active = Math.max(0, Number(activeCount) || 0);
    return active >= this._maxConcurrent;
  }

  /**
   * Returns comprehensive concurrency and queue statistics.
   *
   * @param {number} [activeCount=0]
   * @returns {object}
   */
  getConcurrencyStats(activeCount = 0) {
    const active = Math.max(0, Number(activeCount) || 0);
    return {
      active,
      queued: this._items.length,
      maxConcurrent: this._maxConcurrent,
      availableSlots: Math.max(0, this._maxConcurrent - active),
      isAtCapacity: active >= this._maxConcurrent
    };
  }

  /**
   * Peeks up to count items without removing them.
   *
   * @param {number} [count=1]
   * @returns {Array<object>}
   */
  peekBatch(count = 1) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    return this._items.slice(0, n);
  }

  /**
   * Dequeues up to count items from the front of the queue.
   *
   * @param {number} [count=1]
   * @returns {Array<object>}
   */
  dequeueBatch(count = 1) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    return this._items.splice(0, n);
  }

  /**
   * Enqueues a restoration request according to its priority and arrival time.
   *
   * @param {object} item
   * @param {number} item.tabId - Tab ID to restore
   * @param {number|string} [item.priority=RestorePriority.NORMAL] - Priority level or label
   * @param {object} [item.options={}] - Restoration options
   * @param {string} [item.source="unknown"] - Source of restore request
   * @param {string} [item.title] - Tab title for UI
   * @param {string} [item.url] - Original URL for UI
   * @param {Function} item.resolve - Promise resolution callback
   * @param {Function} item.reject - Promise rejection callback
   * @param {Promise} [item.promise] - Associated promise
   * @returns {object} The queued item with position
   */
  enqueue(item = {}) {
    if (!item || typeof item.tabId !== "number") {
      throw new Error("Invalid queue item: tabId must be a number");
    }

    const priority = normalizeRestorePriority(item.priority);
    const queuedAt = Number(item.queuedAt) || Date.now();

    const queueItem = {
      tabId: item.tabId,
      priority,
      priorityName: getPriorityName(priority),
      source: item.source || (priority >= RestorePriority.USER_REQUESTED ? "user" : "background"),
      title: item.title || "Untitled Tab",
      url: item.url || "",
      options: item.options || {},
      queuedAt,
      resolve: item.resolve || (() => {}),
      reject: item.reject || (() => {}),
      promise: item.promise || null,
      isCancelled: false
    };

    // Find insertion index: higher priority comes first; within same priority, FIFO (earlier queuedAt first)
    let insertIndex = this._items.length;
    for (let i = 0; i < this._items.length; i++) {
      const existing = this._items[i];
      if (queueItem.priority > existing.priority) {
        insertIndex = i;
        break;
      } else if (queueItem.priority === existing.priority && queueItem.queuedAt < existing.queuedAt) {
        insertIndex = i;
        break;
      }
    }

    this._items.splice(insertIndex, 0, queueItem);

    return {
      ...queueItem,
      position: insertIndex + 1,
      totalQueued: this._items.length
    };
  }

  /**
   * Retrieves and removes the next highest priority item in the queue.
   *
   * @returns {object|null}
   */
  dequeue() {
    if (this._items.length === 0) return null;
    return this._items.shift() || null;
  }

  /**
   * Peeks at the next highest priority item without removing it.
   *
   * @returns {object|null}
   */
  peek() {
    return this._items[0] || null;
  }

  /**
   * Checks if a tab is currently in the queue.
   *
   * @param {number} tabId
   * @returns {boolean}
   */
  has(tabId) {
    return this._items.some(item => item.tabId === tabId);
  }

  /**
   * Gets the 1-based position of a tab in the queue.
   *
   * @param {number} tabId
   * @returns {number} 1-based index or -1 if not found
   */
  getPosition(tabId) {
    const idx = this._items.findIndex(item => item.tabId === tabId);
    return idx === -1 ? -1 : idx + 1;
  }

  /**
   * Finds an item in the queue by tabId.
   *
   * @param {number} tabId
   * @returns {object|null}
   */
  get(tabId) {
    return this._items.find(item => item.tabId === tabId) || null;
  }

  /**
   * Removes an item from the queue by tabId.
   *
   * @param {number} tabId
   * @param {string} [reason="Cancelled"]
   * @returns {object|null} Removed item or null
   */
  remove(tabId, reason = "Cancelled") {
    const idx = this._items.findIndex(item => item.tabId === tabId);
    if (idx === -1) return null;

    const [removed] = this._items.splice(idx, 1);
    removed.isCancelled = true;
    try {
      removed.resolve({
        ok: false,
        cancelled: true,
        tabId,
        stage: "cancelled",
        error: reason
      });
    } catch {
      // Ignore
    }
    return removed;
  }

  /**
   * Updates the priority of an existing queued tab and re-sorts its position.
   *
   * @param {number} tabId
   * @param {number|string} newPriority
   * @returns {number} New 1-based position or -1 if tab not found
   */
  reorder(tabId, newPriority) {
    const idx = this._items.findIndex(item => item.tabId === tabId);
    if (idx === -1) return -1;

    const [item] = this._items.splice(idx, 1);
    item.priority = normalizeRestorePriority(newPriority);
    item.priorityName = getPriorityName(item.priority);

    // Re-insert at new position
    let insertIndex = this._items.length;
    for (let i = 0; i < this._items.length; i++) {
      const existing = this._items[i];
      if (item.priority > existing.priority) {
        insertIndex = i;
        break;
      } else if (item.priority === existing.priority && item.queuedAt < existing.queuedAt) {
        insertIndex = i;
        break;
      }
    }

    this._items.splice(insertIndex, 0, item);
    return insertIndex + 1;
  }

  /**
   * Promotes the priority of a queued tab if the new priority is higher than its current priority.
   *
   * @param {number} tabId
   * @param {number|string} [newPriority=RestorePriority.USER_REQUESTED]
   * @returns {number} New 1-based position or -1 if not found
   */
  promote(tabId, newPriority = RestorePriority.USER_REQUESTED) {
    const item = this.get(tabId);
    if (!item) return -1;
    const targetPriority = normalizeRestorePriority(newPriority);
    if (targetPriority <= item.priority) {
      return this.getPosition(tabId);
    }
    return this.reorder(tabId, targetPriority);
  }

  /**
   * Removes all queued restorations with priority at or below maxPriorityThreshold in-place.
   *
   * @param {number|string} [maxPriorityThreshold=RestorePriority.LOW]
   * @param {string} [reason="Low-priority restore cancelled"]
   * @returns {Array<object>} Array of removed queue items
   */
  removeByPriority(maxPriorityThreshold = RestorePriority.LOW, reason = "Low-priority restore cancelled") {
    const threshold = normalizeRestorePriority(maxPriorityThreshold);
    const removed = [];

    for (let i = this._items.length - 1; i >= 0; i--) {
      const item = this._items[i];
      if (item.priority <= threshold) {
        this._items.splice(i, 1);
        item.isCancelled = true;
        try {
          item.resolve({
            ok: false,
            cancelled: true,
            tabId: item.tabId,
            stage: "cancelled",
            error: reason
          });
        } catch {
          // Ignore
        }
        removed.unshift(item);
      }
    }

    return removed;
  }

  /**
   * Returns the item with the lowest priority in the queue, or null if empty.
   * Since queue is sorted descending by priority, this is the last element.
   *
   * @returns {object|null}
   */
  findLowestPriorityItem() {
    if (this._items.length === 0) return null;
    return this._items[this._items.length - 1];
  }

  /**
   * Clears all items from the queue.
   *
   * @param {string} [reason="Queue cleared"]
   * @returns {number} Number of cleared items
   */
  clear(reason = "Queue cleared") {
    const count = this._items.length;
    while (this._items.length > 0) {
      const item = this._items.shift();
      item.isCancelled = true;
      try {
        item.resolve({
          ok: false,
          cancelled: true,
          tabId: item.tabId,
          stage: "cancelled",
          error: reason
        });
      } catch {
        // Ignore
      }
    }
    return count;
  }

  /**
   * Number of items currently in queue.
   *
   * @returns {number}
   */
  size() {
    return this._items.length;
  }

  /**
   * Returns a snapshot array of all queued items with their position.
   *
   * @returns {Array<object>}
   */
  getItems() {
    return this._items.map((item, index) => ({
      tabId: item.tabId,
      position: index + 1,
      priority: item.priority,
      priorityName: item.priorityName,
      source: item.source,
      title: item.title,
      url: item.url,
      queuedAt: item.queuedAt
    }));
  }
}
