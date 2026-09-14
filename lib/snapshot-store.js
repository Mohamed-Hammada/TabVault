/**
 * TabVault Snapshot Storage Engine
 * Persistent, high-performance storage for tab snapshots backed by IndexedDB
 * with pluggable storage adapter support for headless testing.
 */

import { validateSnapshotSchema, migrateSnapshot, isSnapshotCorrupted, repairCorruptedSnapshot, generateSnapshotId, createManualTabSnapshot, createRestorationPlan, SNAPSHOT_SCHEMA_VERSION } from "./snapshot.js";

export const DB_NAME = "tabvault-snapshots";
export const DB_VERSION = 1;
export const STORE_NAME = "snapshots";
export const DEFAULT_SNAPSHOT_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const DEFAULT_MAX_SNAPSHOTS_PER_TAB = 5;
export const MAX_SNAPSHOT_SIZE_BYTES = 500 * 1024; // 500 KB per snapshot
export const MAX_STORE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB total store quota
export const SNAPSHOT_EXPORT_VERSION = 1;

/**
 * Serializes an array of snapshots into standard TabVault export payload or JSON string.
 * @param {Array<object>} snapshots
 * @param {object} [options]
 * @param {boolean} [options.stripScreenshots=false]
 * @param {boolean} [options.asJsonString=false]
 * @param {boolean} [options.pretty=true]
 * @returns {object|string}
 */
export function serializeSnapshotsExport(snapshots = [], options = {}) {
  const { stripScreenshots = false, asJsonString = false, pretty = true } = options;
  const now = Date.now();

  const processedSnapshots = (snapshots || []).map(s => {
    if (!stripScreenshots) return s;
    const copy = { ...s };
    if (copy.screenshot) {
      copy.screenshot = {
        isFallback: true,
        title: copy.title || "Untitled Tab",
        favicon: copy.favicon || "",
        domain: ""
      };
    }
    return copy;
  });

  const payload = {
    app: "TabVault",
    version: SNAPSHOT_EXPORT_VERSION,
    exportedAt: now,
    exportedAtIso: new Date(now).toISOString(),
    count: processedSnapshots.length,
    snapshots: processedSnapshots
  };

  if (asJsonString) {
    return pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
  }
  return payload;
}

/**
 * Parses and validates raw import input (JSON string or object payload).
 * @param {string|object} input
 * @returns {{ valid: boolean, snapshots: Array<object>, error?: string, metadata?: object }}
 */
export function parseAndValidateSnapshotsImport(input) {
  if (!input) {
    return { valid: false, snapshots: [], error: "Import data is empty or null" };
  }

  let parsed = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch (e) {
      return { valid: false, snapshots: [], error: `Failed to parse JSON: ${e.message}` };
    }
  }

  if (!parsed || typeof parsed !== "object") {
    return { valid: false, snapshots: [], error: "Import payload must be an object or array" };
  }

  let rawSnapshots = [];
  let metadata = {};

  if (Array.isArray(parsed)) {
    rawSnapshots = parsed;
    metadata = { source: "array", count: rawSnapshots.length };
  } else if (Array.isArray(parsed.snapshots)) {
    rawSnapshots = parsed.snapshots;
    metadata = {
      app: parsed.app || "TabVault",
      version: parsed.version || 1,
      exportedAt: parsed.exportedAt || null,
      count: rawSnapshots.length
    };
  } else {
    return { valid: false, snapshots: [], error: "Import payload missing 'snapshots' array" };
  }

  return {
    valid: true,
    snapshots: rawSnapshots,
    metadata
  };
}

/**
 * Estimates the byte size of a snapshot in storage.
 * @param {object} snapshot
 * @returns {number}
 */
export function estimateSnapshotSize(snapshot) {
  if (!snapshot) return 0;
  try {
    return new TextEncoder().encode(JSON.stringify(snapshot)).length;
  } catch {
    return JSON.stringify(snapshot).length;
  }
}

/**
 * Ensures a snapshot does not exceed the maximum allowed per-snapshot byte size,
 * degrading non-essential elements (heavy screenshot, then forms) if necessary.
 * @param {object} snapshot
 * @param {number} [maxSizeBytes=MAX_SNAPSHOT_SIZE_BYTES]
 * @returns {object} Sanitized snapshot within limits
 */
export function enforceSnapshotSizeLimit(snapshot, maxSizeBytes = MAX_SNAPSHOT_SIZE_BYTES) {
  if (!snapshot || typeof snapshot !== "object") return snapshot;

  let size = estimateSnapshotSize(snapshot);
  if (size <= maxSizeBytes) return snapshot;

  const bounded = JSON.parse(JSON.stringify(snapshot));

  // 1. Degrade screenshot to fallback descriptor if large
  if (bounded.screenshot && !bounded.screenshot.isFallback) {
    bounded.screenshot = {
      isFallback: true,
      truncated: true,
      title: bounded.title || "Untitled Tab",
      favicon: bounded.favicon || "",
      domain: bounded.url ? (() => { try { return new URL(bounded.url).hostname; } catch { return ""; } })() : ""
    };
    size = estimateSnapshotSize(bounded);
    if (size <= maxSizeBytes) return bounded;
  }

  // 2. Drop form inputs if still exceeding
  if (bounded.forms) {
    bounded.forms = null;
    size = estimateSnapshotSize(bounded);
    if (size <= maxSizeBytes) return bounded;
  }

  // 3. Truncate long favicon if still exceeding
  if (bounded.favicon && bounded.favicon.length > 512) {
    bounded.favicon = bounded.favicon.slice(0, 512);
    size = estimateSnapshotSize(bounded);
    if (size <= maxSizeBytes) return bounded;
  }

  return bounded;
}

/**
 * Determines whether a snapshot has expired past the retention limit.
 * Pinned tabs and records with protectFromPurge are protected.
 * @param {object} snapshot
 * @param {number} [maxAgeMs=DEFAULT_SNAPSHOT_EXPIRATION_MS]
 * @param {number} [now=Date.now()]
 * @returns {boolean}
 */
export function isSnapshotExpired(snapshot, maxAgeMs = DEFAULT_SNAPSHOT_EXPIRATION_MS, now = Date.now()) {
  if (!snapshot || typeof snapshot.timestamp !== "number") return false;
  if (snapshot.protectFromPurge || snapshot.context?.pinned) return false;
  return (now - snapshot.timestamp) > maxAgeMs;
}

/**
 * In-memory backend for headless test environments or fallbacks.
 */
export class MemorySnapshotBackend {
  constructor() {
    this.records = new Map();
  }

  async open() {
    return true;
  }

  async put(snapshot) {
    this.records.set(snapshot.id, JSON.parse(JSON.stringify(snapshot)));
    return snapshot.id;
  }

  async get(id) {
    const rec = this.records.get(id);
    return rec ? JSON.parse(JSON.stringify(rec)) : null;
  }

  async getAll() {
    return Array.from(this.records.values()).map(r => JSON.parse(JSON.stringify(r)));
  }

  async getByTabId(tabId) {
    const results = [];
    for (const rec of this.records.values()) {
      if (rec.tabId === tabId) {
        results.push(JSON.parse(JSON.stringify(rec)));
      }
    }
    return results.sort((a, b) => b.timestamp - a.timestamp);
  }

  async delete(id) {
    return this.records.delete(id);
  }

  async deleteByTabId(tabId) {
    let deletedCount = 0;
    for (const [id, rec] of this.records.entries()) {
      if (rec.tabId === tabId) {
        this.records.delete(id);
        deletedCount++;
      }
    }
    return deletedCount;
  }

  async clear() {
    this.records.clear();
    return true;
  }

  async count() {
    return this.records.size;
  }
}

/**
 * Browser IndexedDB backend for persistent extension storage.
 */
export class IndexedDBSnapshotBackend {
  constructor(dbName = DB_NAME, version = DB_VERSION) {
    this.dbName = dbName;
    this.version = version;
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;
    const idb = globalThis.indexedDB;
    if (!idb) {
      throw new Error("IndexedDB is not available in the current environment");
    }

    return new Promise((resolve, reject) => {
      const request = idb.open(this.dbName, this.version);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
          store.createIndex("tabId", "tabId", { unique: false });
          store.createIndex("url", "url", { unique: false });
          store.createIndex("timestamp", "timestamp", { unique: false });
          store.createIndex("tabId_timestamp", ["tabId", "timestamp"], { unique: false });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve(this.db);
      };

      request.onerror = (event) => {
        reject(event.target.error);
      };
    });
  }

  async put(snapshot) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(snapshot);
      req.onsuccess = () => resolve(snapshot.id);
      req.onerror = () => reject(req.error);
    });
  }

  async get(id) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async getAll() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async getByTabId(tabId) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const index = store.index("tabId");
      const req = index.getAll(tabId);
      req.onsuccess = () => {
        const results = req.result || [];
        results.sort((a, b) => b.timestamp - a.timestamp);
        resolve(results);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async delete(id) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async deleteByTabId(tabId) {
    const items = await this.getByTabId(tabId);
    if (!items.length) return 0;
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      let count = 0;
      for (const item of items) {
        store.delete(item.id);
        count++;
      }
      tx.oncomplete = () => resolve(count);
      tx.onerror = () => reject(tx.error);
    });
  }

  async clear() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.clear();
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async count() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => reject(req.error);
    });
  }
}

/**
 * High-level SnapshotStore manager with schema validation, lifecycle querying,
 * and backend abstraction.
 */
export class SnapshotStore {
  /**
   * @param {object} [options]
   * @param {object} [options.backend] - Custom backend (defaults to IndexedDB if available, else Memory)
   */
  constructor(options = {}) {
    if (options.backend) {
      this.backend = options.backend;
    } else if (typeof globalThis !== "undefined" && globalThis.indexedDB) {
      this.backend = new IndexedDBSnapshotBackend();
    } else {
      this.backend = new MemorySnapshotBackend();
    }
    this.enableHistory = options.enableHistory !== undefined
      ? Boolean(options.enableHistory)
      : (options.keepLatestOnly ? false : true);
    this.keepLatestOnly = !this.enableHistory;
    this.explicitMaxSnapshotsPerTab = typeof options.maxSnapshotsPerTab === "number" ? options.maxSnapshotsPerTab : null;
    this.maxSnapshotsPerTab = options.maxSnapshotsPerTab ?? DEFAULT_MAX_SNAPSHOTS_PER_TAB;
  }

  async open() {
    return this.backend.open();
  }

  /**
   * Configures the snapshot history policy dynamically.
   * @param {object} policy
   * @param {boolean} [policy.enableHistory]
   * @param {number} [policy.maxSnapshotsPerTab]
   * @param {boolean} [policy.pruneImmediately=false]
   * @returns {Promise<{ prunedCount: number }>}
   */
  async setHistoryPolicy(policy = {}) {
    if (policy.enableHistory !== undefined) {
      this.enableHistory = Boolean(policy.enableHistory);
      this.keepLatestOnly = !this.enableHistory;
    }
    if (typeof policy.maxSnapshotsPerTab === "number" && policy.maxSnapshotsPerTab > 0) {
      this.maxSnapshotsPerTab = policy.maxSnapshotsPerTab;
      this.explicitMaxSnapshotsPerTab = policy.maxSnapshotsPerTab;
    }

    let prunedCount = 0;
    if (policy.pruneImmediately) {
      const targetLimit = this.enableHistory ? this.maxSnapshotsPerTab : 1;
      const res = await this.cleanupExcessSnapshotsPerTab(targetLimit);
      prunedCount = typeof res === "number" ? res : (res?.deletedCount || 0);
    }

    return { prunedCount };
  }

  /**
   * Stores a validated snapshot, enforcing per-snapshot size limits.
   * If history is disabled or keepLatestOnly is configured, older snapshots for the tab are trimmed immediately.
   * @param {object} snapshot
   * @param {object} [options]
   * @param {boolean} [options.keepLatestOnly]
   * @param {boolean} [options.enableHistory]
   * @param {number} [options.maxSnapshotsPerTab]
   * @returns {Promise<string>} snapshot ID
   */
  async saveSnapshot(snapshot, options = {}) {
    const bounded = enforceSnapshotSizeLimit(snapshot);
    const check = validateSnapshotSchema(bounded);
    if (!check.valid) {
      throw new Error(`Invalid snapshot schema: ${check.errors.join(", ")}`);
    }
    const id = await this.backend.put(bounded);

    const enableHistory = options.enableHistory !== undefined
      ? Boolean(options.enableHistory)
      : (options.keepLatestOnly !== undefined ? !options.keepLatestOnly : this.enableHistory);

    if (typeof bounded.tabId === "number") {
      if (!enableHistory) {
        await this.pruneTabHistory(bounded.tabId, 1);
      } else if (typeof options.maxSnapshotsPerTab === "number" && options.maxSnapshotsPerTab > 0) {
        await this.pruneTabHistory(bounded.tabId, options.maxSnapshotsPerTab);
      } else if (this.explicitMaxSnapshotsPerTab !== null && this.explicitMaxSnapshotsPerTab > 0) {
        await this.pruneTabHistory(bounded.tabId, this.explicitMaxSnapshotsPerTab);
      }
    }

    return id;
  }

  /**
   * Prunes older snapshots for a specific tab, leaving only the newest keepCount snapshots.
   * @param {number} tabId
   * @param {number} [keepCount=1]
   * @returns {Promise<number>} number of snapshots pruned
   */
  async pruneTabHistory(tabId, keepCount = 1) {
    if (typeof tabId !== "number") return 0;
    const tabSnapshots = await this.backend.getByTabId(tabId);
    if (tabSnapshots.length <= keepCount) return 0;

    let deleted = 0;
    for (let i = keepCount; i < tabSnapshots.length; i++) {
      await this.backend.delete(tabSnapshots[i].id);
      deleted++;
    }
    return deleted;
  }

  /**
   * Gathers snapshot history statistics for a specific tab.
   * @param {number} tabId
   * @returns {Promise<{ count: number, oldestTimestamp: number|null, newestTimestamp: number|null, totalEstimatedBytes: number }>}
   */
  async getSnapshotHistoryStats(tabId) {
    if (typeof tabId !== "number") {
      return { count: 0, oldestTimestamp: null, newestTimestamp: null, totalEstimatedBytes: 0 };
    }
    const snapshots = await this.backend.getByTabId(tabId);
    if (snapshots.length === 0) {
      return { count: 0, oldestTimestamp: null, newestTimestamp: null, totalEstimatedBytes: 0 };
    }

    let totalBytes = 0;
    let oldest = Infinity;
    let newest = -Infinity;

    for (const s of snapshots) {
      totalBytes += estimateSnapshotSize(s);
      if (s.timestamp < oldest) oldest = s.timestamp;
      if (s.timestamp > newest) newest = s.timestamp;
    }

    return {
      count: snapshots.length,
      oldestTimestamp: oldest === Infinity ? null : oldest,
      newestTimestamp: newest === -Infinity ? null : newest,
      totalEstimatedBytes: totalBytes
    };
  }

  /**
   * Retrieves snapshot by unique ID, automatically migrating legacy records or repairing corrupted ones.
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async getSnapshot(id) {
    if (!id || typeof id !== "string") return null;
    const record = await this.backend.get(id);
    if (!record) return null;
    const migrated = migrateSnapshot(record);
    if (isSnapshotCorrupted(migrated)) {
      return repairCorruptedSnapshot(migrated);
    }
    return migrated;
  }

  /**
   * Retrieves the most recent snapshot for a specific tab ID, automatically migrating legacy records.
   * @param {number} tabId
   * @returns {Promise<object|null>}
   */
  async getLatestSnapshotForTab(tabId) {
    if (typeof tabId !== "number") return null;
    const list = await this.backend.getByTabId(tabId);
    if (list.length === 0) return null;
    const migrated = migrateSnapshot(list[0]);
    if (isSnapshotCorrupted(migrated)) {
      return repairCorruptedSnapshot(migrated);
    }
    return migrated;
  }

  /**
   * Alias for getLatestSnapshotForTab.
   * @param {number} tabId
   * @returns {Promise<object|null>}
   */
  async getLatestSnapshot(tabId) {
    return this.getLatestSnapshotForTab(tabId);
  }

  /**
   * Checks whether at least one snapshot exists for the given tab ID.
   * @param {number} tabId
   * @returns {Promise<boolean>}
   */
  async hasSnapshotForTab(tabId) {
    if (typeof tabId !== "number") return false;
    const list = await this.backend.getByTabId(tabId);
    return list.length > 0;
  }

  /**
   * Retrieves the latest snapshot for every known tab in storage.
   * @returns {Promise<Map<number, object>>} Map of tabId -> latest snapshot
   */
  async getAllLatestSnapshots() {
    const all = await this.backend.getAll();
    const map = new Map();
    // Sort ascending by timestamp so later ones overwrite earlier ones
    all.sort((a, b) => a.timestamp - b.timestamp);
    for (const snap of all) {
      if (typeof snap.tabId === "number") {
        const migrated = migrateSnapshot(snap);
        map.set(snap.tabId, isSnapshotCorrupted(migrated) ? repairCorruptedSnapshot(migrated) : migrated);
      }
    }
    return map;
  }

  /**
   * Retrieves all snapshots for a specific tab ID, newest first, automatically migrating legacy records.
   * @param {number} tabId
   * @param {number} [limit]
   * @returns {Promise<object[]>}
   */
  async getSnapshotsForTab(tabId, limit = Infinity) {
    if (typeof tabId !== "number") return [];
    const list = await this.backend.getByTabId(tabId);
    const result = [];
    for (const item of list) {
      const migrated = migrateSnapshot(item);
      result.push(isSnapshotCorrupted(migrated) ? repairCorruptedSnapshot(migrated) : migrated);
      if (result.length >= limit) break;
    }
    return result;
  }

  /**
   * Retrieves a historical snapshot for a tab by chronological index (0 = latest, 1 = previous, etc.).
   * @param {number} tabId
   * @param {number} [historyIndex=0]
   * @returns {Promise<object|null>}
   */
  async getHistoricalSnapshot(tabId, historyIndex = 0) {
    if (typeof tabId !== "number") return null;
    const history = await this.getSnapshotsForTab(tabId);
    if (historyIndex < 0 || historyIndex >= history.length) return null;
    return history[historyIndex];
  }

  /**
   * Prepares a restoration plan from a historical snapshot ID or tab history index.
   * @param {string|{ tabId: number, index?: number }} selector - Snapshot ID string or { tabId, index }
   * @param {object} [options]
   * @returns {Promise<object|null>} Structured RestorationPlan object or null
   */
  async prepareRestorationFromHistory(selector, options = {}) {
    let snapshot = null;
    let isHistorical = false;

    if (typeof selector === "string") {
      snapshot = await this.getSnapshot(selector);
      if (snapshot && typeof snapshot.tabId === "number") {
        const latest = await this.getLatestSnapshot(snapshot.tabId);
        isHistorical = Boolean(latest && latest.id !== snapshot.id);
      }
    } else if (selector && typeof selector.tabId === "number") {
      const index = selector.index || 0;
      snapshot = await this.getHistoricalSnapshot(selector.tabId, index);
      isHistorical = index > 0;
    }

    if (!snapshot) return null;

    return createRestorationPlan(snapshot, {
      ...options,
      isHistorical
    });
  }

  /**
   * Retrieves all stored snapshots across all tabs, automatically migrating legacy records.
   * @returns {Promise<object[]>}
   */
  async getAllSnapshots() {
    const list = await this.backend.getAll();
    return list.map(item => migrateSnapshot(item));
  }

  /**
   * Queries snapshots within a specific time range.
   * @param {object} [options]
   * @param {number} [options.tabId]
   * @param {number} [options.since=0] - Minimum timestamp inclusive
   * @param {number} [options.until=Infinity] - Maximum timestamp inclusive
   * @param {"asc"|"desc"} [options.order="desc"] - Chronological order
   * @param {number} [options.limit=Infinity]
   * @returns {Promise<object[]>}
   */
  async getSnapshotsByTimeRange(options = {}) {
    const {
      tabId,
      since = 0,
      until = Infinity,
      order = "desc",
      limit = Infinity
    } = options;

    let list = await this.backend.getAll();

    if (typeof tabId === "number") {
      list = list.filter(s => s.tabId === tabId);
    }
    if (since > 0) {
      list = list.filter(s => s.timestamp >= since);
    }
    if (until < Infinity) {
      list = list.filter(s => s.timestamp <= until);
    }

    if (order === "asc") {
      list.sort((a, b) => a.timestamp - b.timestamp);
    } else {
      list.sort((a, b) => b.timestamp - a.timestamp);
    }

    const migrated = list.map(item => {
      const mig = migrateSnapshot(item);
      return isSnapshotCorrupted(mig) ? repairCorruptedSnapshot(mig) : mig;
    });

    return limit < Infinity ? migrated.slice(0, limit) : migrated;
  }

  /**
   * Retrieves snapshots created since a given timestamp.
   * @param {number} sinceTimestamp
   * @param {number} [tabId]
   * @returns {Promise<object[]>}
   */
  async getSnapshotsSince(sinceTimestamp, tabId) {
    return this.getSnapshotsByTimeRange({ since: sinceTimestamp, tabId, order: "desc" });
  }

  /**
   * Retrieves snapshots created before a given timestamp.
   * @param {number} untilTimestamp
   * @param {number} [tabId]
   * @returns {Promise<object[]>}
   */
  async getSnapshotsOlderThan(untilTimestamp, tabId) {
    return this.getSnapshotsByTimeRange({ until: untilTimestamp, tabId, order: "desc" });
  }

  /**
   * Captures and stores a manual user-initiated checkpoint snapshot.
   * @param {object} tab
   * @param {object} [options]
   * @returns {Promise<object>} The stored snapshot record
   */
  async createAndSaveManualSnapshot(tab, options = {}) {
    const snap = createManualTabSnapshot(tab, options);
    await this.saveSnapshot(snap, options);
    return snap;
  }

  /**
   * Retrieves all manual snapshots in storage.
   * @param {number} [tabId] - Optional tab ID filter
   * @returns {Promise<object[]>}
   */
  async getManualSnapshots(tabId) {
    let list = await this.backend.getAll();
    list = list.filter(s => s.isManual === true || s.reason === "manual");
    if (typeof tabId === "number") {
      list = list.filter(s => s.tabId === tabId);
    }
    list.sort((a, b) => b.timestamp - a.timestamp);
    return list.map(s => migrateSnapshot(s));
  }

  /**
   * Deletes a single snapshot by ID.
   * @param {string} id
   * @param {object} [options]
   * @param {boolean} [options.respectProtection=false] - If true, refuses to delete protected snapshots
   * @returns {Promise<boolean>}
   */
  async deleteSnapshot(id, options = {}) {
    if (!id || typeof id !== "string") return false;
    if (options.respectProtection) {
      const existing = await this.backend.get(id);
      if (existing && (existing.protectFromPurge || existing.context?.pinned)) {
        return false;
      }
    }
    return this.backend.delete(id);
  }

  /**
   * Deletes multiple snapshots by their IDs in batch.
   * @param {string[]} ids
   * @param {object} [options]
   * @param {boolean} [options.respectProtection=false]
   * @returns {Promise<{ deletedCount: number, skippedProtectedCount: number, failedIds: string[] }>}
   */
  async deleteSnapshots(ids = [], options = {}) {
    if (!Array.isArray(ids) || ids.length === 0) {
      return { deletedCount: 0, skippedProtectedCount: 0, failedIds: [] };
    }
    const { respectProtection = false } = options;
    let deletedCount = 0;
    let skippedProtectedCount = 0;
    const failedIds = [];

    for (const id of ids) {
      if (typeof id !== "string" || !id.trim()) {
        failedIds.push(id);
        continue;
      }
      if (respectProtection) {
        const existing = await this.backend.get(id);
        if (existing && (existing.protectFromPurge || existing.context?.pinned)) {
          skippedProtectedCount++;
          continue;
        }
      }
      const ok = await this.backend.delete(id);
      if (ok) {
        deletedCount++;
      } else {
        failedIds.push(id);
      }
    }

    return { deletedCount, skippedProtectedCount, failedIds };
  }

  /**
   * Deletes snapshots matching a predicate function.
   * @param {function} predicate - (snapshot) => boolean
   * @param {object} [options]
   * @param {boolean} [options.respectProtection=false]
   * @returns {Promise<{ deletedCount: number, skippedProtectedCount: number }>}
   */
  async deleteSnapshotsMatching(predicate, options = {}) {
    if (typeof predicate !== "function") {
      return { deletedCount: 0, skippedProtectedCount: 0 };
    }
    const { respectProtection = false } = options;
    const all = await this.backend.getAll();
    let deletedCount = 0;
    let skippedProtectedCount = 0;

    for (const snap of all) {
      if (predicate(snap)) {
        if (respectProtection && (snap.protectFromPurge || snap.context?.pinned)) {
          skippedProtectedCount++;
          continue;
        }
        const ok = await this.backend.delete(snap.id);
        if (ok) deletedCount++;
      }
    }

    return { deletedCount, skippedProtectedCount };
  }

  /**
   * Deletes all snapshots belonging to a given tab ID.
   * @param {number} tabId
   * @param {object} [options]
   * @param {boolean} [options.respectProtection=false]
   * @returns {Promise<number>} Number of deleted snapshots
   */
  async deleteSnapshotsForTab(tabId, options = {}) {
    if (typeof tabId !== "number") return 0;
    if (options.respectProtection) {
      const snaps = await this.backend.getByTabId(tabId);
      let deleted = 0;
      for (const s of snaps) {
        if (s.protectFromPurge || s.context?.pinned) continue;
        await this.backend.delete(s.id);
        deleted++;
      }
      return deleted;
    }
    return this.backend.deleteByTabId(tabId);
  }

  /**
   * Clears all snapshot data from store.
   * @returns {Promise<boolean>}
   */
  async clear() {
    return this.backend.clear();
  }

  /**
   * Purges all snapshots older than the specified max age.
   * Protects pinned tabs and records with protectFromPurge.
   * @param {number} [maxAgeMs=DEFAULT_SNAPSHOT_EXPIRATION_MS]
   * @param {number} [now=Date.now()]
   * @returns {Promise<number>} Number of purged expired snapshots
   */
  async purgeExpiredSnapshots(maxAgeMs = DEFAULT_SNAPSHOT_EXPIRATION_MS, now = Date.now()) {
    const all = await this.backend.getAll();
    let purgedCount = 0;
    for (const snap of all) {
      if (isSnapshotExpired(snap, maxAgeMs, now)) {
        await this.backend.delete(snap.id);
        purgedCount++;
      }
    }
    return purgedCount;
  }

  /**
   * Cleans up orphaned snapshots for tabs that are no longer live in the browser.
   * Protects pinned tabs and snapshots with protectFromPurge.
   * @param {number[]|Set<number>} liveTabIds - Array or Set of active browser tab IDs
   * @returns {Promise<number>} Number of orphaned snapshots deleted
   */
  async cleanupOrphanedSnapshots(liveTabIds = []) {
    const liveSet = new Set(liveTabIds);
    const all = await this.backend.getAll();
    let deletedCount = 0;

    for (const snap of all) {
      if (snap.protectFromPurge || snap.context?.pinned) continue;
      if (!liveSet.has(snap.tabId)) {
        await this.backend.delete(snap.id);
        deletedCount++;
      }
    }

    return deletedCount;
  }

  /**
   * Enforces a ceiling on historical snapshots kept per tab, deleting older snapshots.
   * @param {number} [maxPerTab=DEFAULT_MAX_SNAPSHOTS_PER_TAB]
   * @returns {Promise<number>} Number of excess snapshots deleted
   */
  async cleanupExcessSnapshotsPerTab(maxPerTab = DEFAULT_MAX_SNAPSHOTS_PER_TAB) {
    if (maxPerTab <= 0) return 0;
    const all = await this.backend.getAll();

    // Group snapshots by tabId
    const tabMap = new Map();
    for (const snap of all) {
      const list = tabMap.get(snap.tabId) || [];
      list.push(snap);
      tabMap.set(snap.tabId, list);
    }

    let excessDeleted = 0;
    for (const [tabId, list] of tabMap.entries()) {
      if (list.length > maxPerTab) {
        // Sort newest first
        list.sort((a, b) => b.timestamp - a.timestamp);
        const toDelete = list.slice(maxPerTab);
        for (const item of toDelete) {
          if (!item.protectFromPurge) {
            await this.backend.delete(item.id);
            excessDeleted++;
          }
        }
      }
    }

    return excessDeleted;
  }

  /**
   * Runs the full cleanup pipeline: expiration purge, orphan cleanup, and excess trimming.
   * @param {object} [options]
   * @param {number} [options.maxAgeMs]
   * @param {number[]|Set<number>} [options.liveTabIds]
   * @param {number} [options.maxPerTab]
   * @param {number} [options.now]
   * @returns {Promise<{ expiredPurged: number, orphansPurged: number, excessPurged: number, totalPurged: number }>}
   */
  async runCleanupPipeline(options = {}) {
    const expiredPurged = await this.purgeExpiredSnapshots(options.maxAgeMs, options.now);
    let orphansPurged = 0;
    if (Array.isArray(options.liveTabIds) || options.liveTabIds instanceof Set) {
      orphansPurged = await this.cleanupOrphanedSnapshots(options.liveTabIds);
    }
    const excessPurged = await this.cleanupExcessSnapshotsPerTab(options.maxPerTab);

    return {
      expiredPurged,
      orphansPurged,
      excessPurged,
      totalPurged: expiredPurged + orphansPurged + excessPurged
    };
  }

  /**
   * Estimates total byte size of all stored snapshots.
   * @returns {Promise<number>} Total bytes
   */
  async estimateTotalStoreSizeBytes() {
    const all = await this.backend.getAll();
    let total = 0;
    for (const snap of all) {
      total += estimateSnapshotSize(snap);
    }
    return total;
  }

  /**
   * Enforces total store quota, evicting oldest unpinned/unprotected snapshots
   * when store size exceeds maxTotalBytes until size reaches 80% target threshold.
   * @param {number} [maxTotalBytes=MAX_STORE_SIZE_BYTES]
   * @returns {Promise<{ evictedCount: number, freedBytes: number, remainingBytes: number }>}
   */
  async enforceStoreQuota(maxTotalBytes = MAX_STORE_SIZE_BYTES) {
    const all = await this.backend.getAll();
    let currentTotal = 0;
    for (const snap of all) {
      currentTotal += estimateSnapshotSize(snap);
    }

    if (currentTotal <= maxTotalBytes) {
      return { evictedCount: 0, freedBytes: 0, remainingBytes: currentTotal };
    }

    const targetBytes = Math.floor(maxTotalBytes * 0.8);
    // Sort oldest first for eviction
    all.sort((a, b) => a.timestamp - b.timestamp);

    let evictedCount = 0;
    let freedBytes = 0;

    for (const snap of all) {
      if (currentTotal <= targetBytes) break;
      if (snap.protectFromPurge || snap.context?.pinned) continue;

      const snapBytes = estimateSnapshotSize(snap);
      await this.backend.delete(snap.id);
      freedBytes += snapBytes;
      currentTotal -= snapBytes;
      evictedCount++;
    }

    return {
      evictedCount,
      freedBytes,
      remainingBytes: currentTotal
    };
  }

  /**
   * Scans store for corrupted snapshots, repairing recoverable ones and pruning unrecoverable ones.
   * @param {"repair"|"prune"} [strategy="repair"]
   * @returns {Promise<{ inspectedCount: number, repairedCount: number, prunedCount: number }>}
   */
  async repairOrPruneCorruptedSnapshots(strategy = "repair") {
    const all = await this.backend.getAll();
    let repairedCount = 0;
    let prunedCount = 0;

    for (const raw of all) {
      if (isSnapshotCorrupted(raw)) {
        if (strategy === "repair") {
          const repaired = repairCorruptedSnapshot(raw);
          if (repaired) {
            await this.backend.put(repaired);
            repairedCount++;
          } else {
            await this.backend.delete(raw.id);
            prunedCount++;
          }
        } else {
          await this.backend.delete(raw.id);
          prunedCount++;
        }
      }
    }

    return {
      inspectedCount: all.length,
      repairedCount,
      prunedCount
    };
  }

  /**
   * Counts total snapshots in storage.
   * @returns {Promise<number>}
   */
  async count() {
    return this.backend.count();
  }

  /**
   * Exports snapshots matching optional filters as structured payload or JSON string.
   * @param {object} [options]
   * @param {number} [options.tabId] - Filter by specific tabId
   * @param {function} [options.filter] - Custom predicate (snapshot) => boolean
   * @param {boolean} [options.stripScreenshots=false] - If true, strips heavy screenshot data to produce lightweight backup
   * @param {boolean} [options.asJsonString=false] - Return JSON string if true, Object payload if false
   * @param {boolean} [options.pretty=true] - Indent JSON if asJsonString is true
   * @returns {Promise<object|string>}
   */
  async exportSnapshots(options = {}) {
    let list = await this.backend.getAll();

    if (typeof options.tabId === "number") {
      list = list.filter(s => s.tabId === options.tabId);
    }
    if (typeof options.filter === "function") {
      list = list.filter(options.filter);
    }

    list.sort((a, b) => a.timestamp - b.timestamp);

    return serializeSnapshotsExport(list, options);
  }

  /**
   * Imports snapshots from JSON string, array, or export payload.
   * @param {string|object|Array} input
   * @param {object} [options]
   * @param {"overwrite"|"skip"|"generateNewId"} [options.conflictStrategy="overwrite"]
   * @param {boolean} [options.autoRepair=true] - Automatically migrate or repair malformed records
   * @param {boolean} [options.enforceLimits=true] - Enforce individual size bounds and store quota
   * @returns {Promise<{
   *   success: boolean,
   *   totalProcessed: number,
   *   importedCount: number,
   *   skippedCount: number,
   *   errorCount: number,
   *   errors: Array<{ id: string, error: string }>,
   *   importedIds: string[]
   * }>}
   */
  async importSnapshots(input, options = {}) {
    const {
      conflictStrategy = "overwrite",
      autoRepair = true,
      enforceLimits = true
    } = options;

    const parseResult = parseAndValidateSnapshotsImport(input);
    if (!parseResult.valid) {
      return {
        success: false,
        totalProcessed: 0,
        importedCount: 0,
        skippedCount: 0,
        errorCount: 1,
        errors: [{ id: "root", error: parseResult.error }],
        importedIds: []
      };
    }

    const { snapshots: rawList } = parseResult;
    let importedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    const errors = [];
    const importedIds = [];

    for (let i = 0; i < rawList.length; i++) {
      let record = rawList[i];
      if (!record || typeof record !== "object") {
        errorCount++;
        errors.push({ id: `index_${i}`, error: "Item is not an object" });
        continue;
      }

      if (isSnapshotCorrupted(record)) {
        if (autoRepair) {
          const repaired = repairCorruptedSnapshot(record);
          if (repaired) {
            record = repaired;
          } else {
            errorCount++;
            errors.push({ id: record.id || `index_${i}`, error: "Unrecoverable corrupted snapshot" });
            continue;
          }
        } else {
          errorCount++;
          errors.push({ id: record.id || `index_${i}`, error: "Corrupted snapshot record" });
          continue;
        }
      } else if (record.schemaVersion === undefined || record.schemaVersion < SNAPSHOT_SCHEMA_VERSION) {
        record = migrateSnapshot(record);
      }

      // Conflict handling
      const existing = await this.backend.get(record.id);
      if (existing) {
        if (conflictStrategy === "skip") {
          skippedCount++;
          continue;
        } else if (conflictStrategy === "generateNewId") {
          record.id = generateSnapshotId(record.tabId, record.timestamp);
        }
      }

      if (enforceLimits) {
        record = enforceSnapshotSizeLimit(record);
      }

      await this.backend.put(record);
      importedCount++;
      importedIds.push(record.id);
    }

    if (enforceLimits) {
      await this.enforceStoreQuota();
    }

    return {
      success: true,
      totalProcessed: rawList.length,
      importedCount,
      skippedCount,
      errorCount,
      errors,
      importedIds
    };
  }
}

let globalSnapshotStore = null;

/**
 * Returns singleton SnapshotStore instance.
 * @param {object} options
 * @returns {SnapshotStore}
 */
export function getSnapshotStore(options = {}) {
  if (!globalSnapshotStore) {
    globalSnapshotStore = new SnapshotStore(options);
  }
  return globalSnapshotStore;
}

/**
 * Resets the singleton SnapshotStore instance.
 */
export function resetSnapshotStore() {
  globalSnapshotStore = null;
}
