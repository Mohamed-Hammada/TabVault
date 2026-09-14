// TabVault — Site-Specific State Adapter Registry & Domain Matcher

import { assertValidAdapter } from "./base.js";
import {
  globToRegex,
  matchDomainPattern,
  extractHostname,
  isSubdomainOf,
  matchesAnyPattern
} from "./domain.js";
import {
  sanitizeAdapterState,
  executeAdapterCapture,
  captureSiteAdapterState
} from "./capture.js";
import {
  executeAdapterRestore,
  restoreSiteAdapterState
} from "./restore.js";
import {
  DEFAULT_ADAPTER_TIMEOUT_MS,
  MIN_ADAPTER_TIMEOUT_MS,
  MAX_ADAPTER_TIMEOUT_MS,
  normalizeAdapterTimeout,
  withAdapterTimeout
} from "./timeout.js";
import {
  AdapterFailureTracker,
  getAdapterFailureTracker,
  resetAdapterFailureTracker,
  isolateAdapterOperation
} from "./isolation.js";
import {
  DEFAULT_ADAPTER_SETTINGS,
  STORAGE_KEY_ADAPTER_SETTINGS,
  getAdapterSettings,
  setAdapterSettings,
  resetAdapterSettings,
  isAdaptersGloballyEnabled,
  setAdaptersGloballyEnabled,
  isAdapterEnabled,
  setAdapterEnabled,
  syncRegistryWithSettings
} from "./settings.js";
import {
  YouTubeAdapter,
  extractYouTubeVideoId,
  parseYouTubeUrlTimestamp,
  appendYouTubeTimestamp,
  formatYouTubeTimestamp
} from "./youtube.js";
import {
  GitHubAdapter,
  parseGitHubUrl,
  formatGitHubSummary
} from "./github.js";
import {
  JiraAdapter,
  parseJiraUrl,
  formatJiraSummary
} from "./jira.js";
import {
  GoogleDocsAdapter,
  parseGoogleDocsUrl,
  formatGoogleDocsSummary
} from "./gdocs.js";
import {
  NotionAdapter,
  normalizeNotionId,
  parseNotionUrl,
  formatNotionSummary
} from "./notion.js";
import {
  SearchAdapter,
  parseSearchEngineUrl,
  formatSearchSummary
} from "./search.js";
import {
  GenericUrlAdapter,
  parseGenericUrlState,
  formatGenericSummary
} from "./generic.js";

export {
  globToRegex,
  matchDomainPattern,
  extractHostname,
  isSubdomainOf,
  matchesAnyPattern,
  sanitizeAdapterState,
  executeAdapterCapture,
  captureSiteAdapterState,
  executeAdapterRestore,
  restoreSiteAdapterState,
  DEFAULT_ADAPTER_TIMEOUT_MS,
  MIN_ADAPTER_TIMEOUT_MS,
  MAX_ADAPTER_TIMEOUT_MS,
  normalizeAdapterTimeout,
  withAdapterTimeout,
  AdapterFailureTracker,
  getAdapterFailureTracker,
  resetAdapterFailureTracker,
  isolateAdapterOperation,
  DEFAULT_ADAPTER_SETTINGS,
  STORAGE_KEY_ADAPTER_SETTINGS,
  getAdapterSettings,
  setAdapterSettings,
  resetAdapterSettings,
  isAdaptersGloballyEnabled,
  setAdaptersGloballyEnabled,
  isAdapterEnabled,
  setAdapterEnabled,
  syncRegistryWithSettings,
  YouTubeAdapter,
  extractYouTubeVideoId,
  parseYouTubeUrlTimestamp,
  appendYouTubeTimestamp,
  formatYouTubeTimestamp,
  GitHubAdapter,
  parseGitHubUrl,
  formatGitHubSummary,
  JiraAdapter,
  parseJiraUrl,
  formatJiraSummary,
  GoogleDocsAdapter,
  parseGoogleDocsUrl,
  formatGoogleDocsSummary,
  NotionAdapter,
  normalizeNotionId,
  parseNotionUrl,
  formatNotionSummary,
  SearchAdapter,
  parseSearchEngineUrl,
  formatSearchSummary,
  GenericUrlAdapter,
  parseGenericUrlState,
  formatGenericSummary
};

/**
 * Registry managing site-specific state adapters, priority ordering, and URL lookup.
 */
export class AdapterRegistry {
  constructor() {
    /**
     * Map of registered adapters by adapter ID.
     * @type {Map<string, object>}
     */
    this.adapters = new Map();
  }

  /**
   * Registers a site adapter.
   *
   * @param {object} adapter - An adapter implementing the SiteAdapterInterface
   * @throws {TypeError} If adapter does not conform to the interface
   */
  register(adapter) {
    assertValidAdapter(adapter);
    this.adapters.set(adapter.id, adapter);
  }

  /**
   * Unregisters an adapter by ID.
   *
   * @param {string} adapterId
   * @returns {boolean} True if an adapter was removed
   */
  unregister(adapterId) {
    if (!adapterId || typeof adapterId !== "string") return false;
    return this.adapters.delete(adapterId.trim().toLowerCase());
  }

  /**
   * Retrieves an adapter by ID.
   *
   * @param {string} adapterId
   * @returns {object|null}
   */
  get(adapterId) {
    if (!adapterId || typeof adapterId !== "string") return null;
    return this.adapters.get(adapterId.trim().toLowerCase()) || null;
  }

  /**
   * Checks if an adapter is registered.
   *
   * @param {string} adapterId
   * @returns {boolean}
   */
  has(adapterId) {
    if (!adapterId || typeof adapterId !== "string") return false;
    return this.adapters.has(adapterId.trim().toLowerCase());
  }

  /**
   * Returns all registered adapters.
   *
   * @returns {Array<object>}
   */
  getAll() {
    return Array.from(this.adapters.values());
  }

  /**
   * Returns all enabled adapters, sorted by priority descending.
   *
   * @returns {Array<object>}
   */
  getEnabled() {
    return this.getAll()
      .filter(adapter => adapter.enabled !== false)
      .sort((a, b) => (b.priority ?? 100) - (a.priority ?? 100));
  }

  /**
   * Finds the highest-priority enabled adapter matching the given URL.
   *
   * @param {string} url
   * @returns {object|null} Matching adapter, or null if no adapter matches
   */
  findMatchingAdapter(url) {
    if (!url || typeof url !== "string") return null;

    const enabledAdapters = this.getEnabled();
    for (const adapter of enabledAdapters) {
      try {
        if (adapter.matches(url)) {
          return adapter;
        }
      } catch (err) {
        getAdapterFailureTracker().record({
          adapterId: adapter.id || "unknown",
          stage: "matching",
          error: err,
          url
        });
      }
    }

    return null;
  }

  /**
   * Finds all enabled adapters that match the given URL, in descending priority order.
   *
   * @param {string} url
   * @returns {Array<object>}
   */
  findAllMatchingAdapters(url) {
    if (!url || typeof url !== "string") return [];

    const matches = [];
    const enabledAdapters = this.getEnabled();

    for (const adapter of enabledAdapters) {
      try {
        if (adapter.matches(url)) {
          matches.push(adapter);
        }
      } catch (err) {
        getAdapterFailureTracker().record({
          adapterId: adapter.id || "unknown",
          stage: "matching",
          error: err,
          url
        });
      }
    }

    return matches;
  }

  /**
   * Captures site-specific state for a URL by matching against registered adapters.
   *
   * @param {string} url
   * @param {number} tabId
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async captureForUrl(url, tabId, context = {}) {
    return captureSiteAdapterState(url, tabId, { adapterRegistry: this, context });
  }

  /**
   * Restores site-specific state for a URL by matching against registered adapters.
   *
   * @param {string} url
   * @param {number} tabId
   * @param {object} [plan={}]
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async restoreForUrl(url, tabId, plan = {}, context = {}) {
    return restoreSiteAdapterState(url, tabId, plan, { adapterRegistry: this, context });
  }

  /**
   * Applies user settings to all registered adapters.
   *
   * @param {object} settings
   */
  syncWithSettings(settings = getAdapterSettings()) {
    syncRegistryWithSettings(this, settings);
  }

  /**
   * Checks if an adapter is currently enabled.
   *
   * @param {string} adapterId
   * @returns {boolean}
   */
  isAdapterEnabled(adapterId) {
    const adapter = this.get(adapterId);
    return adapter ? adapter.enabled : false;
  }

  /**
   * Enables or disables a specific adapter in this registry and updates settings.
   *
   * @param {string} adapterId
   * @param {boolean} enabled
   * @returns {boolean}
   */
  setAdapterEnabled(adapterId, enabled) {
    return setAdapterEnabled(adapterId, enabled, { registry: this });
  }

  /**
   * Clears all registered adapters.
   */
  clear() {
    this.adapters.clear();
  }

  /**
   * Total number of registered adapters.
   * @returns {number}
   */
  size() {
    return this.adapters.size;
  }
}

let globalAdapterRegistry = null;

/**
 * Returns singleton AdapterRegistry instance.
 *
 * @returns {AdapterRegistry}
 */
export function getAdapterRegistry() {
  if (!globalAdapterRegistry) {
    globalAdapterRegistry = new AdapterRegistry();
  }
  return globalAdapterRegistry;
}

/**
 * Resets the singleton AdapterRegistry instance.
 */
export function resetAdapterRegistry() {
  if (globalAdapterRegistry) {
    globalAdapterRegistry.clear();
    globalAdapterRegistry = null;
  }
}

/**
 * Registers all available built-in site adapters into the given registry.
 *
 * @param {AdapterRegistry} [registry]
 */
export function registerBuiltInAdapters(registry = getAdapterRegistry()) {
  if (!registry.has("youtube")) {
    registry.register(new YouTubeAdapter());
  }
  if (!registry.has("github")) {
    registry.register(new GitHubAdapter());
  }
  if (!registry.has("jira")) {
    registry.register(new JiraAdapter());
  }
  if (!registry.has("google-docs")) {
    registry.register(new GoogleDocsAdapter());
  }
  if (!registry.has("notion")) {
    registry.register(new NotionAdapter());
  }
  if (!registry.has("search")) {
    registry.register(new SearchAdapter());
  }
  if (!registry.has("generic")) {
    registry.register(new GenericUrlAdapter());
  }
}
