import { getAdapterRegistry } from "./registry.js";
import { isSiteAdapter, AdapterTimeoutError, AdapterExecutionError } from "./base.js";
import { withAdapterTimeout } from "./timeout.js";
import { getAdapterFailureTracker } from "./isolation.js";

/**
 * Executes an adapter's restore hook with timeout and failure isolation.
 *
 * @param {object} adapter - Adapter conforming to SiteAdapterInterface
 * @param {number} tabId - Target tab ID
 * @param {object} [plan={}] - Restoration plan containing URL, scroll, forms, and adapter state
 * @param {object} [context={}] - Context containing chromeApi, signal, timeoutMs, session, etc.
 * @returns {Promise<{ ok: boolean, adapterId: string, matched?: boolean, restored: boolean, result?: any, error?: string, timedOut?: boolean }>}
 */
export async function executeAdapterRestore(adapter, tabId, plan = {}, context = {}) {
  if (!adapter || typeof adapter.restore !== "function") {
    return {
      ok: false,
      adapterId: adapter?.id || "unknown",
      restored: false,
      error: "Invalid adapter instance passed to restore hook: missing restore() method"
    };
  }

  const adapterId = adapter.id || adapter.domain || "adapter";
  const timeoutMs = typeof context.timeoutMs === "number" && context.timeoutMs > 0
    ? context.timeoutMs
    : (adapter.timeoutMs || 3000);

  try {
    const callContext = context?.chromeApi
      ? { ...context, tabs: context.chromeApi.tabs, scripting: context.chromeApi.scripting, runtime: context.chromeApi.runtime }
      : (context || {});

    const result = await withAdapterTimeout(
      () => adapter.restore(tabId, plan, callContext),
      {
        adapterId,
        stage: "restore",
        timeoutMs,
        signal: context?.signal
      }
    );

    const wasSuccessful = result !== false;

    if (!wasSuccessful) {
      const error = `Adapter '${adapterId}' restore returned false`;
      const tracker = context?.failureTracker || getAdapterFailureTracker();
      tracker.record({ adapterId, stage: "restore", error, tabId, url: context?.url || plan?.url });
      return {
        ok: false,
        adapterId,
        restored: false,
        result: result ?? null,
        error
      };
    }

    return {
      ok: true,
      adapterId,
      restored: true,
      result: result ?? null
    };
  } catch (err) {
    const isTimeout = err instanceof AdapterTimeoutError || err.name === "AdapterTimeoutError";
    const error = isTimeout ? `Adapter timed out after ${timeoutMs}ms` : (err?.message || String(err));
    const tracker = context?.failureTracker || getAdapterFailureTracker();
    tracker.record({ adapterId, stage: "restore", error: err, tabId, url: context?.url || plan?.url });

    return {
      ok: false,
      adapterId,
      restored: false,
      error,
      timedOut: isTimeout
    };
  }
}

/**
 * Finds matching adapter for a URL from registry and executes its restore hook.
 *
 * @param {string} url - Tab canonical target URL
 * @param {number} tabId - Target tab ID
 * @param {object} [plan={}] - Tab restoration plan
 * @param {object} [options={}] - Options { adapterRegistry, context, timeoutMs }
 * @returns {Promise<{ matched: boolean, ok: boolean, adapterId: string|null, restored: boolean, result?: any, error?: string, timedOut?: boolean }>}
 */
export async function restoreSiteAdapterState(url, tabId, plan = {}, options = {}) {
  const registry = options.adapterRegistry || getAdapterRegistry();
  const targetUrl = url || plan.url || "";
  const adapter = registry.findMatchingAdapter ? registry.findMatchingAdapter(targetUrl) : null;

  if (!adapter) {
    return {
      matched: false,
      ok: true,
      adapterId: null,
      restored: false
    };
  }

  const context = {
    url: targetUrl,
    tabId,
    ...(options.context || {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {})
  };

  const result = await executeAdapterRestore(adapter, tabId, plan, context);

  return {
    matched: true,
    ...result
  };
}
