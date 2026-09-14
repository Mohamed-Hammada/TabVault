export const METADATA_SCHEMA_VERSION = 1;
export const MAX_URL_LENGTH = 2048;
export const MAX_TITLE_LENGTH = 256;
export const MAX_FAVICON_LENGTH = 8192;

export function sanitizeString(str, maxLen) {
  if (typeof str !== "string") return "";
  return str.length > maxLen ? str.slice(0, maxLen) : str;
}

/**
 * Creates a default metadata record for a tab conforming to TabVault schema.
 * @param {number} tabId
 * @param {object} [props]
 * @returns {object}
 */
export function createTabMetadata(tabId, props = {}) {
  const now = Date.now();
  return {
    schemaVersion: METADATA_SCHEMA_VERSION,
    tabId,
    windowId: props.windowId ?? null,
    groupId: props.groupId ?? null,
    url: sanitizeString(props.url, MAX_URL_LENGTH),
    title: sanitizeString(props.title, MAX_TITLE_LENGTH),
    favicon: sanitizeString(props.favicon || props.favIconUrl, MAX_FAVICON_LENGTH),
    createdAt: props.createdAt || now,
    lastActiveAt: props.lastActiveAt || now,
    lastSuspendedAt: props.lastSuspendedAt || null,
    lastRestoredAt: props.lastRestoredAt || null,
    visitCount: props.visitCount || 1,
    suspensionCount: props.suspensionCount || 0,
    restorationCount: props.restorationCount || 0,
    suspensionReason: props.suspensionReason || null,
    restorationStatus: props.restorationStatus || "none", // "none" | "pending" | "restored" | "failed"
    lifecycleState: props.lifecycleState || "ACTIVE"
  };
}

/**
 * Migrates a raw metadata record from an older schema version to the target schema version.
 * @param {number} tabId
 * @param {object} raw
 * @param {number} [targetVersion=METADATA_SCHEMA_VERSION]
 * @returns {object} Migrated record
 */
export function migrateTabMetadata(tabId, raw = {}, targetVersion = METADATA_SCHEMA_VERSION) {
  if (!raw || typeof raw !== "object") {
    return createTabMetadata(tabId);
  }

  const version = raw.schemaVersion || 0;
  let current = { ...raw };

  // Migration V0 -> V1
  if (version < 1) {
    current = {
      schemaVersion: 1,
      tabId,
      windowId: current.windowId ?? null,
      groupId: current.groupId ?? null,
      url: sanitizeString(current.url || "", MAX_URL_LENGTH),
      title: sanitizeString(current.title || "", MAX_TITLE_LENGTH),
      favicon: sanitizeString(current.favicon || current.favIconUrl || "", MAX_FAVICON_LENGTH),
      createdAt: current.createdAt || current.installedAt || Date.now(),
      lastActiveAt: current.lastActiveAt || Date.now(),
      lastSuspendedAt: current.lastSuspendedAt || null,
      lastRestoredAt: current.lastRestoredAt || null,
      visitCount: current.visitCount || current.visits || 1,
      suspensionCount: current.suspensionCount || current.suspensions || 0,
      restorationCount: current.restorationCount || current.restorations || 0,
      suspensionReason: current.suspensionReason || null,
      restorationStatus: current.restorationStatus || "none",
      lifecycleState: current.lifecycleState || current.state || "ACTIVE"
    };
  }

  return current;
}

/**
 * Manages persistent storage and querying of tab metadata.
 */
export class TabMetadataStore {
  constructor(options = {}) {
    this.storageKey = options.storageKey || "tabvault_tab_metadata";
    this.storageAdapter = options.storageAdapter || null;
    this.maxEntries = options.maxEntries || 500; // Bound storage growth
    this.logger = options.logger || console.log;
    this.debug = options.debug === true;
    this.records = new Map(); // Map<tabId, metadata>
  }

  setStorageAdapter(adapter) {
    this.storageAdapter = adapter;
  }

  log(msg, ...args) {
    if (this.debug && typeof this.logger === "function") {
      this.logger(`[TabVault Metadata] ${msg}`, ...args);
    }
  }

  get(tabId) {
    return this.records.get(tabId) || null;
  }

  getAll() {
    return Array.from(this.records.values());
  }

  getAllAsMap() {
    const obj = {};
    for (const [id, meta] of this.records.entries()) {
      obj[id] = meta;
    }
    return obj;
  }

  set(tabId, patch = {}) {
    let entry = this.records.get(tabId);
    if (!entry) {
      entry = createTabMetadata(tabId, patch);
    } else {
      entry = { ...entry, ...patch };
      if (patch.url !== undefined) entry.url = sanitizeString(patch.url, MAX_URL_LENGTH);
      if (patch.title !== undefined) entry.title = sanitizeString(patch.title, MAX_TITLE_LENGTH);
      if (patch.favicon !== undefined || patch.favIconUrl !== undefined) {
        entry.favicon = sanitizeString(patch.favicon || patch.favIconUrl, MAX_FAVICON_LENGTH);
      }
    }
    this.records.set(tabId, entry);
    this.enforceQuota();
    if (this.storageAdapter) {
      this.persist().catch(() => {});
    }
    return entry;
  }

  enforceQuota() {
    if (this.records.size <= this.maxEntries) return 0;
    const overage = this.records.size - this.maxEntries;
    let evicted = 0;

    const entries = Array.from(this.records.entries()).map(([id, meta]) => ({ id, meta }));

    entries.sort((a, b) => {
      // CLOSED tabs evicted first
      const aClosed = a.meta.lifecycleState === "CLOSED" ? 0 : 1;
      const bClosed = b.meta.lifecycleState === "CLOSED" ? 0 : 1;
      if (aClosed !== bClosed) return aClosed - bClosed;

      // Active / Discarded tabs protected
      const aProtected = (a.meta.lifecycleState === "ACTIVE" || a.meta.lifecycleState === "DISCARDED") ? 1 : 0;
      const bProtected = (b.meta.lifecycleState === "ACTIVE" || b.meta.lifecycleState === "DISCARDED") ? 1 : 0;
      if (aProtected !== bProtected) return aProtected - bProtected;

      // Oldest lastActiveAt first
      return (a.meta.lastActiveAt || 0) - (b.meta.lastActiveAt || 0);
    });

    for (let i = 0; i < overage && i < entries.length; i++) {
      this.records.delete(entries[i].id);
      evicted++;
      this.log(`Evicted tab #${entries[i].id} to enforce storage quota (${this.maxEntries})`);
    }

    return evicted;
  }

  recordVisit(tabId, tabInfo = {}) {
    const existing = this.get(tabId);
    const now = Date.now();
    if (!existing) {
      return this.set(tabId, {
        ...tabInfo,
        visitCount: 1,
        lastActiveAt: now
      });
    }
    return this.set(tabId, {
      ...tabInfo,
      visitCount: (existing.visitCount || 0) + 1,
      lastActiveAt: now
    });
  }

  recordSuspension(tabId, reason = "") {
    const existing = this.get(tabId) || createTabMetadata(tabId);
    return this.set(tabId, {
      lastSuspendedAt: Date.now(),
      suspensionCount: (existing.suspensionCount || 0) + 1,
      suspensionReason: reason,
      lifecycleState: "DISCARDED"
    });
  }

  recordRestoration(tabId, status = "restored") {
    const existing = this.get(tabId) || createTabMetadata(tabId);
    const isSuccess = status === "restored";
    return this.set(tabId, {
      lastRestoredAt: Date.now(),
      restorationCount: (existing.restorationCount || 0) + (isSuccess ? 1 : 0),
      restorationStatus: status,
      lifecycleState: isSuccess ? "RESTORED" : "RESTORE_FAILED"
    });
  }

  remove(tabId) {
    const existed = this.records.delete(tabId);
    if (existed && this.storageAdapter) {
      this.persist().catch(() => {});
    }
    return existed;
  }

  clear() {
    this.records.clear();
    if (this.storageAdapter) {
      this.persist().catch(() => {});
    }
  }

  serialize() {
    const raw = {};
    for (const [tabId, data] of this.records.entries()) {
      raw[tabId] = data;
    }
    return raw;
  }

  deserialize(data) {
    this.records.clear();
    if (!data || typeof data !== "object") return;
    for (const [key, raw] of Object.entries(data)) {
      const tabId = Number(key);
      if (Number.isFinite(tabId) && raw && typeof raw === "object") {
        this.records.set(tabId, migrateTabMetadata(tabId, raw));
      }
    }
  }

  async persist() {
    if (!this.storageAdapter) return false;
    try {
      await this.storageAdapter.set({ [this.storageKey]: this.serialize() });
      return true;
    } catch (err) {
      console.error("[TabVault Metadata] Failed to persist metadata:", err);
      return false;
    }
  }

  async rehydrate() {
    if (!this.storageAdapter) return false;
    try {
      const res = await this.storageAdapter.get(this.storageKey);
      const data = res?.[this.storageKey];
      if (data) {
        this.deserialize(data);
        return true;
      }
      return false;
    } catch (err) {
      console.error("[TabVault Metadata] Failed to rehydrate metadata:", err);
      return false;
    }
  }

  /**
   * Re-maps old stored tab IDs to new live tab IDs after browser restart.
   * Uses URL matching (decoding suspended URLs if necessary) and window context.
   * @param {Array<object>} liveTabs - list of live tabs from chrome.tabs.query
   * @returns {object} { remappedCount, remappedPairs }
   */
  remapTabIds(liveTabs = []) {
    const liveIds = new Set(liveTabs.map(t => t.id));
    const unmatchedOldIds = [];
    const matchedNewIds = new Set();
    const remappedPairs = [];

    // Find records whose tabId is not currently alive in Chrome
    for (const [id, record] of this.records.entries()) {
      if (!liveIds.has(id)) {
        unmatchedOldIds.push(id);
      } else {
        matchedNewIds.add(id);
      }
    }

    // Helper to extract real URL if tab is suspended
    const extractUrl = (rawUrl) => {
      if (!rawUrl) return "";
      if (rawUrl.includes("suspended/suspended.html#")) {
        try {
          const hash = rawUrl.split("#")[1] || "";
          const params = new URLSearchParams(hash);
          return params.get("u") || rawUrl;
        } catch { return rawUrl; }
      }
      return rawUrl;
    };

    // Try to match unmapped live tabs to unmatched records
    for (const liveTab of liveTabs) {
      if (matchedNewIds.has(liveTab.id)) continue;
      const targetUrl = extractUrl(liveTab.url);
      if (!targetUrl) continue;

      let bestOldIdIndex = -1;
      let bestScore = -1;

      for (let i = 0; i < unmatchedOldIds.length; i++) {
        const oldId = unmatchedOldIds[i];
        const rec = this.records.get(oldId);
        if (!rec) continue;

        if (rec.url === targetUrl) {
          let score = 10;
          if (rec.windowId !== null && rec.windowId === liveTab.windowId) score += 5;
          if (rec.title && liveTab.title && rec.title === liveTab.title) score += 2;
          if (score > bestScore) {
            bestScore = score;
            bestOldIdIndex = i;
          }
        }
      }

      if (bestOldIdIndex >= 0) {
        const [matchedOldId] = unmatchedOldIds.splice(bestOldIdIndex, 1);
        const record = this.records.get(matchedOldId);
        this.records.delete(matchedOldId);

        record.tabId = liveTab.id;
        record.windowId = liveTab.windowId ?? record.windowId;
        if (liveTab.title) record.title = liveTab.title;
        if (liveTab.favIconUrl) record.favicon = liveTab.favIconUrl;

        this.records.set(liveTab.id, record);
        matchedNewIds.add(liveTab.id);
        remappedPairs.push({ oldId: matchedOldId, newId: liveTab.id, url: targetUrl });
        this.log(`Remapped tab ID ${matchedOldId} -> ${liveTab.id} for ${targetUrl}`);
      }
    }

    if (remappedPairs.length > 0 && this.storageAdapter) {
      this.persist().catch(() => {});
    }

    return {
      remappedCount: remappedPairs.length,
      remappedPairs
    };
  }

  /**
   * Cleans up metadata for permanently closed tabs that are no longer in the browser.
   * Optionally retains recently active tabs within a retention window (e.g. for session undo).
   * @param {Set<number>|Array<number>} liveTabIds - active tab IDs from chrome.tabs
   * @param {object} [options]
   * @param {number} [options.retentionMs=0] - if > 0, keeps closed tabs active within retentionMs
   * @returns {object} { purgedCount, remainingCount }
   */
  purgeClosedTabs(liveTabIds, options = {}) {
    const liveSet = liveTabIds instanceof Set ? liveTabIds : new Set(liveTabIds || []);
    const retentionMs = options.retentionMs || 0;
    const now = Date.now();
    let purgedCount = 0;

    for (const [tabId, record] of Array.from(this.records.entries())) {
      if (!liveSet.has(tabId)) {
        const isRecent = retentionMs > 0 && (now - (record.lastActiveAt || 0) < retentionMs);
        if (!isRecent) {
          this.records.delete(tabId);
          purgedCount++;
          this.log(`Purged metadata for closed tab #${tabId} (${record.url})`);
        } else {
          record.lifecycleState = "CLOSED";
        }
      }
    }

    if (purgedCount > 0 && this.storageAdapter) {
      this.persist().catch(() => {});
    }

    return {
      purgedCount,
      remainingCount: this.records.size
    };
  }
}

let globalTabMetadataStore = null;

/**
 * Returns singleton TabMetadataStore instance.
 * @param {object} options
 * @returns {TabMetadataStore}
 */
export function getTabMetadataStore(options = {}) {
  if (!globalTabMetadataStore) {
    globalTabMetadataStore = new TabMetadataStore(options);
  }
  return globalTabMetadataStore;
}

/**
 * Resets the singleton TabMetadataStore instance.
 */
export function resetTabMetadataStore() {
  globalTabMetadataStore = null;
}
