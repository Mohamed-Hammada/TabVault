import { getAdapterRegistry } from "./registry.js";
import { isSiteAdapter, AdapterTimeoutError, AdapterExecutionError } from "./base.js";
import { withAdapterTimeout } from "./timeout.js";
import { getAdapterFailureTracker } from "./isolation.js";

export const MAX_ADAPTER_STATE_SIZE = 65536; // 64 KB limit

/**
 * Sanitizes and validates an adapter state payload for storage in a tab snapshot.
 *
 * @param {any} input
 * @returns {object|null} Sanitized adapter state or null if empty/invalid
 */
export function sanitizeAdapterState(input) {
  if (input === null || input === undefined) {
    return null;
  }

  if (typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  try {
    const jsonStr = JSON.stringify(input);
    if (jsonStr.length > MAX_ADAPTER_STATE_SIZE) {
      return {
        adapterId: input.adapterId || "unknown",
        truncated: true,
        error: `Adapter state exceeded maximum size limit (${MAX_ADAPTER_STATE_SIZE} bytes)`
      };
    }
    return JSON.parse(jsonStr);
  } catch (_) {
    return null;
  }
}

/**
 * Executes an adapter's capture hook with timeout and failure isolation.
 *
 * @param {object} adapter - Adapter conforming to SiteAdapterInterface
 * @param {number} tabId - Target tab ID
 * @param {object} [context={}] - Context containing chromeApi, tab, window, timeoutMs, etc.
 * @returns {Promise<{ ok: boolean, adapterId: string, matched?: boolean, state: any, summary?: string, error?: string, timedOut?: boolean }>}
 */
export async function executeAdapterCapture(adapter, tabId, context = {}) {
  if (!isSiteAdapter(adapter)) {
    return {
      ok: false,
      adapterId: adapter?.id || "unknown",
      error: "Invalid adapter instance passed to capture hook",
      state: null
    };
  }

  const timeoutMs = typeof context.timeoutMs === "number" && context.timeoutMs > 0
    ? context.timeoutMs
    : (adapter.timeoutMs || 3000);

  try {
    const rawState = await withAdapterTimeout(
      () => adapter.capture(tabId, context),
      {
        adapterId: adapter.id,
        stage: "capture",
        timeoutMs,
        signal: context.signal
      }
    );

    if (rawState === null || rawState === undefined) {
      return {
        ok: true,
        adapterId: adapter.id,
        version: adapter.version ?? 1,
        capturedAt: Date.now(),
        state: null,
        summary: adapter.formatSummary ? adapter.formatSummary(null) : "No state captured"
      };
    }

    if (typeof adapter.validateState === "function" && !adapter.validateState(rawState)) {
      const error = `Adapter '${adapter.id}' state validation failed`;
      const tracker = context.failureTracker || getAdapterFailureTracker();
      tracker.record({ adapterId: adapter.id, stage: "validation", error, tabId, url: context.url });
      return {
        ok: false,
        adapterId: adapter.id,
        error,
        state: null
      };
    }

    const sanitized = sanitizeAdapterState(rawState);

    return {
      ok: true,
      adapterId: adapter.id,
      version: adapter.version ?? 1,
      capturedAt: Date.now(),
      state: sanitized,
      summary: adapter.formatSummary ? adapter.formatSummary(sanitized) : `State captured by ${adapter.name}`
    };
  } catch (err) {
    const isTimeout = err instanceof AdapterTimeoutError || err.name === "AdapterTimeoutError";
    const error = isTimeout ? `Adapter '${adapter.id}' capture timed out after ${timeoutMs}ms` : (err?.message || String(err));
    const tracker = context.failureTracker || getAdapterFailureTracker();
    tracker.record({ adapterId: adapter.id, stage: "capture", error: err, tabId, url: context.url });

    return {
      ok: false,
      adapterId: adapter.id,
      error,
      timedOut: isTimeout,
      state: null
    };
  }
}

/**
 * Finds matching adapter for a URL from registry and executes its capture hook.
 *
 * @param {string} url - Tab canonical URL
 * @param {number} tabId - Target tab ID
 * @param {object} [options={}] - Options { adapterRegistry, context, timeoutMs }
 * @returns {Promise<{ matched: boolean, ok: boolean, adapterId: string|null, state: any, summary?: string, error?: string, timedOut?: boolean }>}
 */
export async function captureSiteAdapterState(url, tabId, options = {}) {
  const registry = options.adapterRegistry || getAdapterRegistry();
  const adapter = registry.findMatchingAdapter(url);

  if (!adapter) {
    return {
      matched: false,
      ok: true,
      adapterId: null,
      state: null
    };
  }

  const context = {
    url,
    tabId,
    ...(options.context || {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {})
  };

  const result = await executeAdapterCapture(adapter, tabId, context);

  return {
    matched: true,
    ...result
  };
}
