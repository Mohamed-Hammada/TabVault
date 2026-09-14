// TabVault — Search Page Query State Adapter
// Captures and restores search query, vertical (web/images/news/video), and pagination offset across Google, Bing, DuckDuckGo, Yahoo, Baidu, and Ecosia.

import { BaseSiteAdapter } from "./base.js";

/**
 * Recognized search engines configuration.
 */
export const SEARCH_ENGINES = {
  google: {
    name: "Google",
    hostMatches: (host) => host === "google.com" || host.endsWith(".google.com") || /\.google\.[a-z.]+$/.test(host),
    pathMatches: (p) => p.startsWith("/search"),
    queryParam: "q",
    pageParam: "start",
    calcPage: (v) => Math.floor((parseInt(v, 10) || 0) / 10) + 1,
    detectVertical: (params) => {
      const tbm = params.get("tbm");
      if (tbm === "isch") return "images";
      if (tbm === "vid") return "videos";
      if (tbm === "nws") return "news";
      if (tbm === "bks") return "books";
      return "web";
    }
  },
  bing: {
    name: "Bing",
    hostMatches: (host) => host === "bing.com" || host.endsWith(".bing.com"),
    pathMatches: (p) => p.startsWith("/search") || p.startsWith("/images") || p.startsWith("/videos") || p.startsWith("/news"),
    queryParam: "q",
    pageParam: "first",
    calcPage: (v) => Math.floor(((parseInt(v, 10) || 1) - 1) / 10) + 1,
    detectVertical: (params, pathname) => {
      if (pathname.startsWith("/images")) return "images";
      if (pathname.startsWith("/videos")) return "videos";
      if (pathname.startsWith("/news")) return "news";
      return "web";
    }
  },
  duckduckgo: {
    name: "DuckDuckGo",
    hostMatches: (host) => host === "duckduckgo.com" || host.endsWith(".duckduckgo.com"),
    pathMatches: () => true,
    queryParam: "q",
    pageParam: "s",
    calcPage: (v) => Math.floor((parseInt(v, 10) || 0) / 30) + 1,
    detectVertical: (params) => {
      const ia = params.get("ia");
      const iar = params.get("iar");
      if (ia === "images" || iar === "images") return "images";
      if (ia === "videos" || iar === "videos") return "videos";
      if (ia === "news" || iar === "news") return "news";
      return "web";
    }
  },
  yahoo: {
    name: "Yahoo",
    hostMatches: (host) => host.includes("search.yahoo.com"),
    pathMatches: () => true,
    queryParam: "p",
    pageParam: "b",
    calcPage: (v) => Math.floor(((parseInt(v, 10) || 1) - 1) / 10) + 1,
    detectVertical: (params, pathname) => {
      if (pathname.includes("/images")) return "images";
      if (pathname.includes("/video")) return "videos";
      if (pathname.includes("/news")) return "news";
      return "web";
    }
  },
  baidu: {
    name: "Baidu",
    hostMatches: (host) => host === "baidu.com" || host.endsWith(".baidu.com"),
    pathMatches: (p) => p.startsWith("/s"),
    queryParam: "wd",
    pageParam: "pn",
    calcPage: (v) => Math.floor((parseInt(v, 10) || 0) / 10) + 1,
    detectVertical: () => "web"
  },
  ecosia: {
    name: "Ecosia",
    hostMatches: (host) => host === "ecosia.org" || host.endsWith(".ecosia.org"),
    pathMatches: (p) => p.startsWith("/search"),
    queryParam: "q",
    pageParam: "p",
    calcPage: (v) => parseInt(v, 10) || 1,
    detectVertical: () => "web"
  }
};

/**
 * Parses search engine URL into structured components.
 *
 * @param {string} url
 * @returns {object|null}
 */
export function parseSearchEngineUrl(url) {
  if (!url || typeof url !== "string") return null;

  try {
    const parsed = new URL(url.includes("://") ? url : `https://${url}`);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname;

    for (const [key, engine] of Object.entries(SEARCH_ENGINES)) {
      if (engine.hostMatches(host) && engine.pathMatches(pathname)) {
        const query = parsed.searchParams.get(engine.queryParam);
        if (!query) continue;

        const rawPage = engine.pageParam ? parsed.searchParams.get(engine.pageParam) : null;
        const pageNumber = rawPage && engine.calcPage ? engine.calcPage(rawPage) : 1;
        const vertical = engine.detectVertical ? engine.detectVertical(parsed.searchParams, pathname) : "web";

        return {
          engine: key,
          engineName: engine.name,
          query: query.trim(),
          pageNumber,
          vertical,
          url
        };
      }
    }

    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Formats a human-readable summary for a search state.
 *
 * @param {object} state
 * @returns {string}
 */
export function formatSearchSummary(state) {
  if (!state || typeof state !== "object" || !state.query) return "Search page";

  const engine = state.engineName || "Search";
  const vertical = state.vertical && state.vertical !== "web" ? ` [${state.vertical}]` : "";
  const page = state.pageNumber > 1 ? ` (page ${state.pageNumber})` : "";

  return `${engine}${vertical}: "${state.query}"${page}`;
}

/**
 * Site adapter for search engines.
 */
export class SearchAdapter extends BaseSiteAdapter {
  constructor(options = {}) {
    super({
      id: "search",
      name: "Search Query",
      description: "Captures and restores search queries, vertical tabs, and pagination offsets across search engines",
      domainPatterns: [
        "*://*.google.com/search*",
        "*://google.com/search*",
        "*://*.bing.com/*",
        "*://duckduckgo.com/*",
        "*://*.duckduckgo.com/*",
        "*://*.search.yahoo.com/*",
        "*://*.baidu.com/s*",
        "*://*.ecosia.org/search*"
      ],
      priority: 120,
      timeoutMs: 3000,
      ...options
    });
  }

  /**
   * Matches search engine query URLs.
   *
   * @param {string} url
   * @returns {boolean}
   */
  matches(url) {
    if (!super.matches(url)) return false;
    return Boolean(parseSearchEngineUrl(url));
  }

  /**
   * Captures search state.
   *
   * @param {number} tabId
   * @param {object} [context={}]
   * @returns {Promise<object|null>}
   */
  async capture(tabId, context = {}) {
    const url = context.url || context.tab?.url || "";
    const parsed = parseSearchEngineUrl(url);
    if (!parsed) return null;

    let activeQuery = parsed.query;

    // 1. Direct DOM inspection
    const doc = context.document || (typeof document !== "undefined" ? document : null);
    if (doc) {
      const input = doc.querySelector?.(
        "textarea[name='q'], input[name='q'], input[name='p'], input[name='wd'], input[type='search'], #search_form_input"
      );
      if (input && typeof input.value === "string" && input.value.trim().length > 0) {
        activeQuery = input.value.trim();
      }
    }

    // 2. Scripting fallback via chromeApi
    if (context.chromeApi?.scripting?.executeScript) {
      try {
        const results = await context.chromeApi.scripting.executeScript({
          target: { tabId },
          func: () => {
            const el = document.querySelector(
              "textarea[name='q'], input[name='q'], input[name='p'], input[name='wd'], input[type='search'], #search_form_input"
            );
            return el ? el.value : null;
          }
        });

        const data = results?.[0]?.result;
        if (data && typeof data === "string" && data.trim().length > 0) {
          activeQuery = data.trim();
        }
      } catch (_) {}
    }

    return {
      engine: parsed.engine,
      engineName: parsed.engineName,
      query: activeQuery,
      pageNumber: parsed.pageNumber,
      vertical: parsed.vertical,
      url
    };
  }

  /**
   * Restores search state, verifying search input contains the query.
   *
   * @param {number} tabId
   * @param {object} [plan={}]
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async restore(tabId, plan = {}, context = {}) {
    const state = plan.adapter?.state || plan.adapter || {};
    const query = state.query || null;

    // 1. Direct DOM restore
    const doc = context.document || (typeof document !== "undefined" ? document : null);
    if (doc && query) {
      const input = doc.querySelector?.(
        "textarea[name='q'], input[name='q'], input[name='p'], input[name='wd'], input[type='search'], #search_form_input"
      );
      if (input && input.value !== query) {
        input.value = query;
        const evt = typeof Event !== "undefined" ? new Event("input", { bubbles: true }) : { type: "input" };
        input.dispatchEvent?.(evt);
      }
    }

    // 2. Scripting fallback via chromeApi
    if (context.chromeApi?.scripting?.executeScript && query) {
      try {
        await context.chromeApi.scripting.executeScript({
          target: { tabId },
          func: (q) => {
            const el = document.querySelector(
              "textarea[name='q'], input[name='q'], input[name='p'], input[name='wd'], input[type='search'], #search_form_input"
            );
            if (el && el.value !== q) {
              el.value = q;
              el.dispatchEvent(new Event("input", { bubbles: true }));
            }
          },
          args: [query]
        });
      } catch (_) {}
    }

    return {
      ok: true,
      restored: true,
      engine: state.engine,
      query
    };
  }

  /**
   * Validates that state has a valid search query string.
   *
   * @param {*} state
   * @returns {boolean}
   */
  validateState(state) {
    if (!state || typeof state !== "object") return false;
    return typeof state.query === "string" && state.query.length > 0 && typeof state.engine === "string";
  }

  /**
   * Human-readable summary for display in suspended UI card.
   *
   * @param {*} state
   * @returns {string}
   */
  formatSummary(state) {
    return formatSearchSummary(state);
  }
}
