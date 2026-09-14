// TabVault — Site-Specific State Adapter Interface & Base Class

import { matchesAnyPattern } from "./domain.js";

/**
 * Custom error thrown when an adapter encounters an error during capture or restore.
 */
export class AdapterExecutionError extends Error {
  /**
   * @param {string} adapterId
   * @param {"capture"|"restore"|"matching"} stage
   * @param {string} message
   * @param {Error} [cause]
   */
  constructor(adapterId, stage, message, cause = null) {
    super(`[Adapter:${adapterId}:${stage}] ${message}`);
    this.name = "AdapterExecutionError";
    this.adapterId = adapterId;
    this.stage = stage;
    this.cause = cause;
  }
}

/**
 * Custom error thrown when an adapter exceeds its execution timeout.
 */
export class AdapterTimeoutError extends Error {
  /**
   * @param {string} adapterId
   * @param {"capture"|"restore"} stage
   * @param {number} timeoutMs
   */
  constructor(adapterId, stage, timeoutMs) {
    super(`[Adapter:${adapterId}:${stage}] Execution timed out after ${timeoutMs}ms`);
    this.name = "AdapterTimeoutError";
    this.adapterId = adapterId;
    this.stage = stage;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Base abstract class defining the site-specific state adapter interface.
 * All custom site adapters (YouTube, GitHub, Jira, etc.) inherit from BaseSiteAdapter.
 */
export class BaseSiteAdapter {
  /**
   * @param {object} options
   * @param {string} options.id - Unique identifier for the adapter (e.g. "youtube")
   * @param {string} options.name - Human-readable name
   * @param {string} [options.description] - Description of what state is restored
   * @param {Array<string|RegExp>} [options.domainPatterns] - Hostnames or patterns matching this adapter
   * @param {number} [options.priority=100] - Priority order for matching (higher runs first)
   * @param {number} [options.timeoutMs=3000] - Max allowed execution time in ms
   * @param {boolean} [options.enabled=true] - Whether this adapter is currently active
   * @param {number|string} [options.version=1] - Adapter version
   */
  constructor(options = {}) {
    if (!options.id || typeof options.id !== "string") {
      throw new Error("Adapter requires a non-empty string 'id'");
    }
    if (!options.name || typeof options.name !== "string") {
      throw new Error("Adapter requires a non-empty string 'name'");
    }

    this.id = options.id.trim().toLowerCase();
    this.name = options.name.trim();
    this.description = options.description || `State adapter for ${this.name}`;
    this.domainPatterns = Array.isArray(options.domainPatterns) ? [...options.domainPatterns] : [];
    this.priority = typeof options.priority === "number" ? options.priority : 100;
    this.timeoutMs = typeof options.timeoutMs === "number" && options.timeoutMs > 0 ? options.timeoutMs : 3000;
    this.enabled = options.enabled !== false;
    this.version = options.version ?? 1;
  }

  /**
   * Determines if this adapter applies to the given URL.
   * Derived classes can override for custom path or parameter checking.
   *
   * @param {string} url
   * @returns {boolean}
   */
  matches(url) {
    if (!url || typeof url !== "string") return false;
    if (!this.enabled) return false;
    if (this.domainPatterns.length === 0) return false;

    return matchesAnyPattern(url, this.domainPatterns);
  }

  /**
   * Captures site-specific state before a tab is suspended.
   *
   * @param {number} tabId
   * @param {object} context - Execution context { chromeApi, snapshot, window, document }
   * @returns {Promise<object|null>} Captured state payload, or null if no state to save
   */
  async capture(tabId, context = {}) {
    // Default implementation: no custom state captured
    return null;
  }

  /**
   * Restores site-specific state when a suspended tab is revived.
   *
   * @param {number} tabId
   * @param {object} plan - The restoration plan containing adapter state
   * @param {object} context - Execution context { chromeApi, signal }
   * @returns {Promise<boolean|object>} Result of the restoration hook
   */
  async restore(tabId, plan = {}, context = {}) {
    // Default implementation: no-op success
    return true;
  }

  /**
   * Validates that a captured state object conforms to expectations.
   *
   * @param {*} state
   * @returns {boolean}
   */
  validateState(state) {
    if (state === null || state === undefined) return true;
    return typeof state === "object";
  }

  /**
   * Formats a human-readable summary of the captured state for display in the UI.
   *
   * @param {*} state
   * @returns {string}
   */
  formatSummary(state) {
    if (!state) return "No state captured";
    return `Custom state for ${this.name}`;
  }

  /**
   * Enables this adapter.
   */
  enable() {
    this.enabled = true;
  }

  /**
   * Disables this adapter.
   */
  disable() {
    this.enabled = false;
  }

  /**
   * Serializes adapter configuration and metadata.
   *
   * @returns {object}
   */
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      domainPatterns: this.domainPatterns.map(p => (p instanceof RegExp ? p.source : String(p))),
      priority: this.priority,
      timeoutMs: this.timeoutMs,
      enabled: this.enabled,
      version: this.version
    };
  }
}

/**
 * Validates whether a candidate object satisfies the site adapter interface contract.
 *
 * @param {object} candidate
 * @returns {boolean}
 */
export function isSiteAdapter(candidate) {
  if (!candidate || typeof candidate !== "object") return false;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    typeof candidate.matches === "function" &&
    typeof candidate.capture === "function" &&
    typeof candidate.restore === "function"
  );
}

/**
 * Asserts that an object implements the SiteAdapterInterface contract.
 * Throws a descriptive TypeError if any required property or method is missing.
 *
 * @param {object} candidate
 * @throws {TypeError}
 */
export function assertValidAdapter(candidate) {
  if (!candidate || typeof candidate !== "object") {
    throw new TypeError("Adapter must be a non-null object");
  }
  if (!candidate.id || typeof candidate.id !== "string") {
    throw new TypeError("Adapter must have a non-empty string 'id'");
  }
  if (!candidate.name || typeof candidate.name !== "string") {
    throw new TypeError(`Adapter '${candidate.id}' must have a non-empty string 'name'`);
  }
  if (typeof candidate.matches !== "function") {
    throw new TypeError(`Adapter '${candidate.id}' must implement 'matches(url)' method`);
  }
  if (typeof candidate.capture !== "function") {
    throw new TypeError(`Adapter '${candidate.id}' must implement 'capture(tabId, context)' method`);
  }
  if (typeof candidate.restore !== "function") {
    throw new TypeError(`Adapter '${candidate.id}' must implement 'restore(tabId, plan, context)' method`);
  }
}
