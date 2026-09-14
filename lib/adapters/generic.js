// TabVault — Generic URL/Hash/Query State Adapter
// Fallback adapter that preserves and restores client-side hash routes, deep-link anchors, and query state across SPAs and standard web pages.

import { BaseSiteAdapter } from "./base.js";

/**
 * Parses generic URL routing and anchor details.
 *
 * @param {string} url
 * @returns {object|null}
 */
export function parseGenericUrlState(url) {
  if (!url || typeof url !== "string") return null;

  try {
    const parsed = new URL(url.includes("://") ? url : `https://${url}`);
    const hash = parsed.hash || "";
    const search = parsed.search || "";
    const searchParams = Object.fromEntries(parsed.searchParams.entries());

    let routeType = "standard";
    if (hash.startsWith("#/") || hash.startsWith("#!/")) {
      routeType = "hash_route";
    } else if (hash.length > 1) {
      routeType = "anchor";
    } else if (search.length > 1) {
      routeType = "query_state";
    }

    return {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      pathname: parsed.pathname,
      search,
      searchParams,
      hash,
      routeType,
      url: parsed.href
    };
  } catch (_) {
    return null;
  }
}

/**
 * Formats a human-readable summary for generic URL state.
 *
 * @param {object} state
 * @returns {string}
 */
export function formatGenericSummary(state) {
  if (!state || typeof state !== "object") return "Web page";

  if (state.routeType === "hash_route") {
    return `Hash route: ${state.hash}`;
  }
  if (state.routeType === "anchor") {
    return `Anchor link: ${state.hash}`;
  }
  if (state.searchParams && Object.keys(state.searchParams).length > 0) {
    const count = Object.keys(state.searchParams).length;
    return `Deep link (${count} query param${count > 1 ? "s" : ""})`;
  }
  return `Page state (${state.hostname || "url"})`;
}

/**
 * Universal fallback site adapter for generic URL, hash, and query preservation.
 */
export class GenericUrlAdapter extends BaseSiteAdapter {
  constructor(options = {}) {
    super({
      id: "generic",
      name: "Generic URL / Hash / Query",
      description: "Fallback adapter preserving client-side hash routes, anchors, and dynamic query parameters",
      domainPatterns: [
        "*://*/*"
      ],
      priority: 10, // Lowest priority among built-ins
      timeoutMs: 2000,
      ...options
    });
  }

  /**
   * Matches any valid HTTP/HTTPS URL.
   *
   * @param {string} url
   * @returns {boolean}
   */
  matches(url) {
    if (!super.matches(url)) return false;
    return Boolean(parseGenericUrlState(url));
  }

  /**
   * Captures URL state, hash, and query parameters.
   *
   * @param {number} tabId
   * @param {object} [context={}]
   * @returns {Promise<object|null>}
   */
  async capture(tabId, context = {}) {
    const rawUrl = context.url || context.tab?.url || "";
    const parsed = parseGenericUrlState(rawUrl);
    if (!parsed) return null;

    let currentHash = parsed.hash;
    let currentSearch = parsed.search;
    let title = null;

    // 1. Direct DOM inspection
    const doc = context.document || (typeof document !== "undefined" ? document : null);
    if (doc) {
      if (doc.title) title = doc.title.trim();
      if (typeof window !== "undefined" && window.location) {
        if (window.location.hash) currentHash = window.location.hash;
        if (window.location.search) currentSearch = window.location.search;
      }
    }

    // 2. Scripting fallback via chromeApi
    if (context.chromeApi?.scripting?.executeScript) {
      try {
        const results = await context.chromeApi.scripting.executeScript({
          target: { tabId },
          func: () => ({
            title: document.title || null,
            hash: window.location.hash || null,
            search: window.location.search || null
          })
        });

        const data = results?.[0]?.result;
        if (data) {
          if (data.title) title = data.title;
          if (data.hash) currentHash = data.hash;
          if (data.search) currentSearch = data.search;
        }
      } catch (_) {}
    }

    return {
      hostname: parsed.hostname,
      pathname: parsed.pathname,
      hash: currentHash,
      search: currentSearch,
      searchParams: parsed.searchParams,
      routeType: parsed.routeType,
      title,
      url: rawUrl
    };
  }

  /**
   * Restores hash route or anchor, dispatching navigation events if necessary.
   *
   * @param {number} tabId
   * @param {object} [plan={}]
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async restore(tabId, plan = {}, context = {}) {
    const state = plan.adapter?.state || plan.adapter || {};
    const targetHash = state.hash || null;

    // 1. Direct DOM restore
    const doc = context.document || (typeof document !== "undefined" ? document : null);
    if (doc && targetHash) {
      if (typeof window !== "undefined" && window.location) {
        if (window.location.hash !== targetHash) {
          window.location.hash = targetHash;
          const evt = typeof HashChangeEvent !== "undefined"
            ? new HashChangeEvent("hashchange")
            : (typeof Event !== "undefined" ? new Event("hashchange") : { type: "hashchange" });
          window.dispatchEvent?.(evt);
        }
      }

      const targetEl = doc.querySelector?.(targetHash);
      if (targetEl && typeof targetEl.scrollIntoView === "function") {
        targetEl.scrollIntoView();
      }
    }

    // 2. Scripting fallback via chromeApi
    if (context.chromeApi?.scripting?.executeScript && targetHash) {
      try {
        await context.chromeApi.scripting.executeScript({
          target: { tabId },
          func: (th) => {
            if (window.location.hash !== th) {
              window.location.hash = th;
              window.dispatchEvent(new Event("hashchange"));
            }
            const el = document.querySelector(th);
            if (el && typeof el.scrollIntoView === "function") {
              el.scrollIntoView();
            }
          },
          args: [targetHash]
        });
      } catch (_) {}
    }

    return {
      ok: true,
      restored: true,
      routeType: state.routeType,
      hash: targetHash
    };
  }

  /**
   * Validates that state is a valid object containing URL information.
   *
   * @param {*} state
   * @returns {boolean}
   */
  validateState(state) {
    if (!state || typeof state !== "object") return false;
    return typeof state.hostname === "string" || typeof state.url === "string";
  }

  /**
   * Human-readable summary for display in suspended UI card.
   *
   * @param {*} state
   * @returns {string}
   */
  formatSummary(state) {
    return formatGenericSummary(state);
  }
}
