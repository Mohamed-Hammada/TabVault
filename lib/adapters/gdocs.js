// TabVault — Google Docs/Sheets/Slides Site State Adapter
// Captures and restores doc IDs, heading anchors, sheet GIDs/ranges, and slide IDs.

import { BaseSiteAdapter } from "./base.js";

/**
 * Parses Google Docs/Sheets/Slides URL into structured components.
 *
 * @param {string} url
 * @returns {object|null}
 */
export function parseGoogleDocsUrl(url) {
  if (!url || typeof url !== "string") return null;

  try {
    const parsed = new URL(url.includes("://") ? url : `https://${url}`);
    const host = parsed.hostname.toLowerCase();
    if (!host.includes("docs.google.com")) return null;

    const pathname = parsed.pathname;
    let appType = "other";

    if (pathname.includes("/document/")) {
      appType = "document";
    } else if (pathname.includes("/spreadsheets/")) {
      appType = "spreadsheets";
    } else if (pathname.includes("/presentation/")) {
      appType = "presentation";
    } else if (pathname.includes("/forms/")) {
      appType = "forms";
    }

    // Extract doc ID: /d/([a-zA-Z0-9-_]+)
    const docIdMatch = pathname.match(/\/d\/([a-zA-Z0-9-_]+)/);
    const docId = docIdMatch ? docIdMatch[1] : null;

    // Extract mode (e.g. edit, view, preview)
    const modeMatch = pathname.match(/\/(edit|view|preview)/);
    const mode = modeMatch ? modeMatch[1] : "view";

    // Hash navigation params
    const hash = parsed.hash || "";
    let headingId = null;
    let bookmarkId = null;
    let gid = null;
    let range = null;
    let slideId = null;

    if (hash) {
      const cleanHash = hash.startsWith("#") ? hash.slice(1) : hash;
      const hashParams = new URLSearchParams(cleanHash);

      headingId = hashParams.get("heading") || null;
      bookmarkId = hashParams.get("bookmark") || null;
      gid = hashParams.get("gid") || parsed.searchParams.get("gid") || null;
      range = hashParams.get("range") || parsed.searchParams.get("range") || null;
      slideId = hashParams.get("slide") || null;
    } else {
      gid = parsed.searchParams.get("gid") || null;
      range = parsed.searchParams.get("range") || null;
    }

    return {
      appType,
      docId,
      mode,
      headingId,
      bookmarkId,
      gid,
      range,
      slideId,
      hash,
      pathname
    };
  } catch (_) {
    return null;
  }
}

/**
 * Formats a human-readable summary for Google Docs state.
 *
 * @param {object} state
 * @returns {string}
 */
export function formatGoogleDocsSummary(state) {
  if (!state || typeof state !== "object") return "Google Docs";

  const titlePrefix = state.title ? `"${state.title}"` : "";

  let result = "Google Docs";
  switch (state.appType) {
    case "document": {
      const nav = state.headingId ? `(heading: ${state.headingId})` : "";
      result = `Google Doc ${titlePrefix} ${nav}`;
      break;
    }
    case "spreadsheets": {
      const sheetInfo = state.gid !== null && state.gid !== undefined ? `[Sheet ${state.gid}]` : "";
      const rangeInfo = state.range ? `Range ${state.range}` : "";
      result = `Google Sheet ${titlePrefix} ${sheetInfo} ${rangeInfo}`;
      break;
    }
    case "presentation": {
      const slideInfo = state.slideId ? `[Slide ${state.slideId}]` : "";
      result = `Google Slides ${titlePrefix} ${slideInfo}`;
      break;
    }
    default:
      result = `Google Docs (${state.appType || "file"})`;
  }

  return result.replace(/\s+/g, " ").trim();
}

/**
 * Site adapter for Google Docs, Sheets, and Slides.
 */
export class GoogleDocsAdapter extends BaseSiteAdapter {
  constructor(options = {}) {
    super({
      id: "google-docs",
      name: "Google Docs",
      description: "Captures and restores doc IDs, heading anchors, sheet GIDs/ranges, and slide IDs",
      domainPatterns: [
        "*://docs.google.com/document/*",
        "*://docs.google.com/spreadsheets/*",
        "*://docs.google.com/presentation/*",
        "*://docs.google.com/forms/*"
      ],
      priority: 130,
      timeoutMs: 3000,
      ...options
    });
  }

  /**
   * Matches Google Docs URLs.
   *
   * @param {string} url
   * @returns {boolean}
   */
  matches(url) {
    if (!super.matches(url)) return false;
    const parsed = parseGoogleDocsUrl(url);
    return Boolean(parsed && parsed.docId);
  }

  /**
   * Captures Google Docs navigation state.
   *
   * @param {number} tabId
   * @param {object} [context={}]
   * @returns {Promise<object|null>}
   */
  async capture(tabId, context = {}) {
    const url = context.url || context.tab?.url || "";
    const parsed = parseGoogleDocsUrl(url);
    if (!parsed || !parsed.docId) return null;

    let title = null;
    let headingId = parsed.headingId;
    let slideId = parsed.slideId;
    let gid = parsed.gid;
    let range = parsed.range;
    let hash = parsed.hash;

    // 1. Direct DOM inspection
    const doc = context.document || (typeof document !== "undefined" ? document : null);
    if (doc) {
      const titleEl = doc.querySelector?.(
        "input.docs-title-input, .docs-title-widget, #docs-title-inner"
      );
      if (titleEl) {
        title = titleEl.value || titleEl.textContent || null;
        if (title) title = title.trim();
      }

      if (typeof window !== "undefined" && window.location?.hash) {
        hash = window.location.hash;
        const hp = new URLSearchParams(hash.replace(/^#/, ""));
        if (hp.get("heading")) headingId = hp.get("heading");
        if (hp.get("slide")) slideId = hp.get("slide");
        if (hp.get("gid")) gid = hp.get("gid");
        if (hp.get("range")) range = hp.get("range");
      }
    }

    // 2. Scripting fallback via chromeApi
    if (context.chromeApi?.scripting?.executeScript) {
      try {
        const results = await context.chromeApi.scripting.executeScript({
          target: { tabId },
          func: () => {
            const titleEl = document.querySelector(
              "input.docs-title-input, .docs-title-widget, #docs-title-inner"
            );
            const title = titleEl ? (titleEl.value || titleEl.textContent || "").trim() : null;
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
            hash = data.hash;
            const hp = new URLSearchParams(hash.replace(/^#/, ""));
            if (hp.get("heading")) headingId = hp.get("heading");
            if (hp.get("slide")) slideId = hp.get("slide");
            if (hp.get("gid")) gid = hp.get("gid");
            if (hp.get("range")) range = hp.get("range");
          }
        }
      } catch (_) {}
    }

    return {
      appType: parsed.appType,
      docId: parsed.docId,
      mode: parsed.mode,
      title,
      headingId,
      slideId,
      gid,
      range,
      hash,
      url
    };
  }

  /**
   * Restores Google Docs navigation state.
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
    if (targetHash && typeof window !== "undefined") {
      if (window.location.hash !== targetHash) {
        window.location.hash = targetHash;
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
            }
          },
          args: [targetHash]
        });
      } catch (_) {}
    }

    return {
      ok: true,
      restored: true,
      appType: state.appType,
      docId: state.docId,
      hash: targetHash
    };
  }

  /**
   * Validates that state has a valid docId and appType.
   *
   * @param {*} state
   * @returns {boolean}
   */
  validateState(state) {
    if (!state || typeof state !== "object") return false;
    return typeof state.docId === "string" && state.docId.length > 0 && typeof state.appType === "string";
  }

  /**
   * Human-readable summary for display in suspended UI card.
   *
   * @param {*} state
   * @returns {string}
   */
  formatSummary(state) {
    return formatGoogleDocsSummary(state);
  }
}
