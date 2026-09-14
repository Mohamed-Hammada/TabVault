// TabVault — Notion Site State Adapter
// Captures and restores Notion workspace, page IDs, view IDs, block anchors, and page titles.

import { BaseSiteAdapter } from "./base.js";

/**
 * Extracts 32-character hex Notion ID (clean without hyphens).
 *
 * @param {string} str
 * @returns {string|null}
 */
export function normalizeNotionId(str) {
  if (!str || typeof str !== "string") return null;

  // 1. UUID format with hyphens (8-4-4-4-12)
  const uuidMatch = str.match(/([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})/i);
  if (uuidMatch) {
    return uuidMatch.slice(1).join("").toLowerCase();
  }

  // 2. 32 hex chars preceded by boundary (-, _, /, #, ?, =, &)
  const segMatch = str.match(/(?:^|[-_/#?=&])([0-9a-f]{32})(?:$|[-_/#?=&])/i);
  if (segMatch) {
    return segMatch[1].toLowerCase();
  }

  // 3. Exact end of string 32 hex chars
  const endMatch = str.match(/([0-9a-f]{32})$/i);
  if (endMatch) {
    return endMatch[1].toLowerCase();
  }

  return null;
}

/**
 * Parses a Notion URL into structured components.
 *
 * @param {string} url
 * @returns {object|null}
 */
export function parseNotionUrl(url) {
  if (!url || typeof url !== "string") return null;

  try {
    const parsed = new URL(url.includes("://") ? url : `https://${url}`);
    const host = parsed.hostname.toLowerCase();
    if (!host.includes("notion.so") && !host.includes("notion.site")) {
      return null;
    }

    const pathname = parsed.pathname;
    const segments = pathname.split("/").filter(Boolean);

    let workspace = null;
    let pageSlug = null;
    let rawPageId = null;

    if (segments.length >= 2) {
      workspace = segments[0];
      pageSlug = segments[1];
    } else if (segments.length === 1) {
      pageSlug = segments[0];
    }

    // Check query param p= first
    if (parsed.searchParams.get("p")) {
      rawPageId = parsed.searchParams.get("p");
    } else if (pageSlug) {
      rawPageId = pageSlug;
    }

    const pageId = normalizeNotionId(rawPageId);
    const viewId = normalizeNotionId(parsed.searchParams.get("v"));
    const blockId = normalizeNotionId(parsed.hash);

    return {
      host,
      workspace,
      pageSlug,
      pageId,
      viewId,
      blockId,
      hash: parsed.hash || null,
      pathname
    };
  } catch (_) {
    return null;
  }
}

/**
 * Formats a human-readable summary for a Notion state.
 *
 * @param {object} state
 * @returns {string}
 */
export function formatNotionSummary(state) {
  if (!state || typeof state !== "object") return "Notion page";

  const titlePart = state.title ? `"${state.title}"` : (state.pageId ? `Page ${state.pageId.slice(0, 8)}...` : "page");
  const blockPart = state.blockId ? ` (block: #${state.blockId.slice(0, 6)})` : "";
  const viewPart = state.viewId ? ` [view: ${state.viewId.slice(0, 6)}]` : "";

  return `Notion ${titlePart}${viewPart}${blockPart}`.trim();
}

/**
 * Site adapter for Notion tabs.
 */
export class NotionAdapter extends BaseSiteAdapter {
  constructor(options = {}) {
    super({
      id: "notion",
      name: "Notion",
      description: "Captures and restores Notion workspace, page IDs, view IDs, block anchors, and page titles",
      domainPatterns: [
        "*://*.notion.so/*",
        "*://notion.so/*",
        "*://*.notion.site/*",
        "*://notion.site/*"
      ],
      priority: 125,
      timeoutMs: 3000,
      ...options
    });
  }

  /**
   * Matches Notion URLs.
   *
   * @param {string} url
   * @returns {boolean}
   */
  matches(url) {
    if (!super.matches(url)) return false;
    const parsed = parseNotionUrl(url);
    return Boolean(parsed && parsed.pageId);
  }

  /**
   * Captures Notion page and block state.
   *
   * @param {number} tabId
   * @param {object} [context={}]
   * @returns {Promise<object|null>}
   */
  async capture(tabId, context = {}) {
    const url = context.url || context.tab?.url || "";
    const parsed = parseNotionUrl(url);
    if (!parsed || !parsed.pageId) return null;

    let title = null;
    let blockId = parsed.blockId;
    let viewId = parsed.viewId;

    // 1. Direct DOM inspection
    const doc = context.document || (typeof document !== "undefined" ? document : null);
    if (doc) {
      const titleEl = doc.querySelector?.(
        ".notion-page-block h1, div[data-block-id] h1, [placeholder='Untitled'], .notion-topbar-title"
      );
      if (titleEl) {
        title = titleEl.textContent || titleEl.value || null;
        if (title) title = title.trim();
      }

      if (typeof window !== "undefined" && window.location?.hash) {
        const idFromHash = normalizeNotionId(window.location.hash);
        if (idFromHash) blockId = idFromHash;
      }
    }

    // 2. Scripting fallback via chromeApi
    if (context.chromeApi?.scripting?.executeScript) {
      try {
        const results = await context.chromeApi.scripting.executeScript({
          target: { tabId },
          func: () => {
            const titleEl = document.querySelector(
              ".notion-page-block h1, div[data-block-id] h1, [placeholder='Untitled'], .notion-topbar-title"
            );
            const title = titleEl ? (titleEl.textContent || titleEl.value || "").trim() : null;
            return {
              title,
              hash: window.location.hash || null
            };
          }
        });

        const data = results?.[0]?.result;
        if (data) {
          if (data.title) title = data.title;
          if (data.hash) {
            const idFromHash = normalizeNotionId(data.hash);
            if (idFromHash) blockId = idFromHash;
          }
        }
      } catch (_) {}
    }

    return {
      workspace: parsed.workspace,
      pageId: parsed.pageId,
      viewId,
      blockId,
      title,
      url
    };
  }

  /**
   * Restores Notion page state.
   *
   * @param {number} tabId
   * @param {object} [plan={}]
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async restore(tabId, plan = {}, context = {}) {
    const state = plan.adapter?.state || plan.adapter || {};
    const blockId = state.blockId || null;

    // 1. Direct DOM restore
    const doc = context.document || (typeof document !== "undefined" ? document : null);
    if (doc && blockId) {
      // Find block element with data-block-id
      const blockEl = doc.querySelector?.(
        `[data-block-id*='${blockId}'], #${blockId}`
      );
      if (blockEl && typeof blockEl.scrollIntoView === "function") {
        blockEl.scrollIntoView();
      }

      if (typeof window !== "undefined") {
        window.location.hash = `#${blockId}`;
      }
    }

    // 2. Scripting fallback via chromeApi
    if (context.chromeApi?.scripting?.executeScript && blockId) {
      try {
        await context.chromeApi.scripting.executeScript({
          target: { tabId },
          func: (bid) => {
            const el = document.querySelector(`[data-block-id*='${bid}'], #${bid}`);
            if (el && typeof el.scrollIntoView === "function") {
              el.scrollIntoView();
            }
            window.location.hash = `#${bid}`;
          },
          args: [blockId]
        });
      } catch (_) {}
    }

    return {
      ok: true,
      restored: true,
      pageId: state.pageId,
      blockId
    };
  }

  /**
   * Validates that state has a valid Notion pageId.
   *
   * @param {*} state
   * @returns {boolean}
   */
  validateState(state) {
    if (!state || typeof state !== "object") return false;
    return typeof state.pageId === "string" && state.pageId.length === 32;
  }

  /**
   * Human-readable summary for display in suspended UI card.
   *
   * @param {*} state
   * @returns {string}
   */
  formatSummary(state) {
    return formatNotionSummary(state);
  }
}
