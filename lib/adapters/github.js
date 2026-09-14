// TabVault — GitHub Site State Adapter
// Captures and restores repo navigation, issue/PR filters, diff settings, and line/comment anchors.

import { BaseSiteAdapter } from "./base.js";

/**
 * Parses a GitHub URL into its structured components.
 *
 * @param {string} url
 * @returns {object|null}
 */
export function parseGitHubUrl(url) {
  if (!url || typeof url !== "string") return null;

  try {
    const parsed = new URL(url.includes("://") ? url : `https://${url}`);
    const host = parsed.hostname.toLowerCase();
    if (!host.includes("github.com")) return null;

    const segments = parsed.pathname.split("/").filter(Boolean);
    const owner = segments[0] || null;
    const repo = segments[1] || null;
    const section = segments[2] || null; // 'pull', 'issues', 'tree', 'blob', 'commit', etc.
    const rest = segments.slice(3);

    let pageType = "other";
    let issueOrPrNumber = null;
    let ref = null;
    let filePath = null;

    if (!owner) {
      pageType = "home";
    } else if (!repo) {
      pageType = "user_or_org";
    } else if (!section) {
      pageType = "repo_root";
    } else if (section === "issues") {
      if (rest.length > 0 && /^\d+$/.test(rest[0])) {
        pageType = "issue_detail";
        issueOrPrNumber = parseInt(rest[0], 10);
      } else {
        pageType = "issues_list";
      }
    } else if (section === "pull" || section === "pulls") {
      if (rest.length > 0 && /^\d+$/.test(rest[0])) {
        pageType = "pull_detail";
        issueOrPrNumber = parseInt(rest[0], 10);
      } else {
        pageType = "pulls_list";
      }
    } else if (section === "tree") {
      pageType = "tree";
      ref = rest[0] || null;
      filePath = rest.slice(1).join("/") || null;
    } else if (section === "blob") {
      pageType = "blob";
      ref = rest[0] || null;
      filePath = rest.slice(1).join("/") || null;
    } else if (section === "commit" || section === "commits") {
      pageType = "commit";
      ref = rest[0] || null;
    } else {
      pageType = section;
    }

    const searchQuery = parsed.searchParams.get("q") || null;
    const diffView = parsed.searchParams.get("diff") || null;
    const ignoreWhitespace = parsed.searchParams.get("w") === "1";
    const hash = parsed.hash || null;

    return {
      owner,
      repo,
      pageType,
      section,
      issueOrPrNumber,
      ref,
      filePath,
      searchQuery,
      diffView,
      ignoreWhitespace,
      hash,
      pathname: parsed.pathname
    };
  } catch (_) {
    return null;
  }
}

/**
 * Normalizes and formats a human-readable summary for a GitHub tab state.
 *
 * @param {object} state
 * @returns {string}
 */
export function formatGitHubSummary(state) {
  if (!state || typeof state !== "object") return "GitHub page";

  const repoTag = state.owner && state.repo ? `${state.owner}/${state.repo}` : "GitHub";

  switch (state.pageType) {
    case "issue_detail":
      return `${repoTag} Issue #${state.issueOrPrNumber}${state.hash ? ` (${state.hash})` : ""}`;
    case "pull_detail": {
      const sub = state.activeSubTab ? ` [${state.activeSubTab}]` : "";
      return `${repoTag} PR #${state.issueOrPrNumber}${sub}${state.hash ? ` (${state.hash})` : ""}`;
    }
    case "issues_list":
      return `${repoTag} Issues${state.filterQuery ? `: "${state.filterQuery}"` : ""}`;
    case "pulls_list":
      return `${repoTag} Pull Requests${state.filterQuery ? `: "${state.filterQuery}"` : ""}`;
    case "blob":
      return `${repoTag} Code: ${state.filePath || state.ref || ""}${state.hash ? ` (${state.hash})` : ""}`;
    case "tree":
      return `${repoTag} Tree (${state.ref || "default"})${state.filePath ? ` /${state.filePath}` : ""}`;
    default:
      return `${repoTag} (${state.pageType || "page"})`;
  }
}

/**
 * Site adapter for GitHub.com tabs.
 */
export class GitHubAdapter extends BaseSiteAdapter {
  constructor(options = {}) {
    super({
      id: "github",
      name: "GitHub",
      description: "Captures and restores repo navigation, issue/PR filters, diff settings, and line/comment anchors",
      domainPatterns: [
        "*://*.github.com/*",
        "*://github.com/*"
      ],
      priority: 140,
      timeoutMs: 3000,
      ...options
    });
  }

  /**
   * Matches GitHub URLs.
   *
   * @param {string} url
   * @returns {boolean}
   */
  matches(url) {
    if (!super.matches(url)) return false;
    return Boolean(parseGitHubUrl(url));
  }

  /**
   * Captures GitHub tab state.
   *
   * @param {number} tabId
   * @param {object} [context={}]
   * @returns {Promise<object|null>}
   */
  async capture(tabId, context = {}) {
    const url = context.url || context.tab?.url || "";
    const parsed = parseGitHubUrl(url);
    if (!parsed) return null;

    let filterQuery = parsed.searchQuery;
    let activeSubTab = null;
    let lineAnchor = null;
    let hash = parsed.hash;

    // Detect PR sub-tab from path if present (e.g. /pull/1/commits, /pull/1/files)
    if (parsed.pageType === "pull_detail") {
      if (parsed.pathname.endsWith("/commits")) {
        activeSubTab = "commits";
      } else if (parsed.pathname.endsWith("/files")) {
        activeSubTab = "files";
      } else if (parsed.pathname.endsWith("/checks")) {
        activeSubTab = "checks";
      } else {
        activeSubTab = "conversation";
      }
    }

    // 1. Direct DOM inspection if document is present in context
    const doc = context.document || (typeof document !== "undefined" ? document : null);
    if (doc) {
      // Check search / filter input if on issue/pr lists
      const filterInput = doc.querySelector?.(
        "input#js-issues-search, input[name='q'], input[data-hotkey='s,/'], input[aria-label='Search all issues']"
      );
      if (filterInput && typeof filterInput.value === "string" && filterInput.value.trim().length > 0) {
        filterQuery = filterInput.value.trim();
      }

      // Check active tab element
      const selectedTab = doc.querySelector?.(".tabnav-tabs .tabnav-tab.selected, nav[aria-label='Pull request tabs'] [aria-current='page']");
      if (selectedTab && selectedTab.textContent) {
        const text = selectedTab.textContent.trim().toLowerCase();
        if (text.includes("file")) activeSubTab = "files";
        else if (text.includes("commit")) activeSubTab = "commits";
        else if (text.includes("check")) activeSubTab = "checks";
        else if (text.includes("conversation")) activeSubTab = "conversation";
      }

      // Extract hash or highlighted line
      if (typeof window !== "undefined" && window.location?.hash) {
        hash = window.location.hash;
      }
    }

    // 2. Scripting fallback if running in service worker context
    if (context.chromeApi?.scripting?.executeScript) {
      try {
        const results = await context.chromeApi.scripting.executeScript({
          target: { tabId },
          func: () => {
            const input = document.querySelector(
              "input#js-issues-search, input[name='q'], input[data-hotkey='s,/'], input[aria-label='Search all issues']"
            );
            const selectedTab = document.querySelector(
              ".tabnav-tabs .tabnav-tab.selected, nav[aria-label='Pull request tabs'] [aria-current='page']"
            );
            return {
              filterValue: input ? input.value : null,
              activeTabLabel: selectedTab ? selectedTab.textContent.trim() : null,
              currentHash: window.location.hash || null
            };
          }
        });

        const data = results?.[0]?.result;
        if (data) {
          if (data.filterValue) filterQuery = data.filterValue.trim();
          if (data.currentHash) hash = data.currentHash;
          if (data.activeTabLabel) {
            const l = data.activeTabLabel.toLowerCase();
            if (l.includes("file")) activeSubTab = "files";
            else if (l.includes("commit")) activeSubTab = "commits";
            else if (l.includes("check")) activeSubTab = "checks";
            else if (l.includes("conversation")) activeSubTab = "conversation";
          }
        }
      } catch (_) {}
    }

    if (hash && hash.startsWith("#L")) {
      lineAnchor = hash.slice(1);
    }

    return {
      owner: parsed.owner,
      repo: parsed.repo,
      pageType: parsed.pageType,
      issueOrPrNumber: parsed.issueOrPrNumber,
      ref: parsed.ref,
      filePath: parsed.filePath,
      filterQuery,
      activeSubTab,
      hash,
      lineAnchor,
      diffView: parsed.diffView,
      ignoreWhitespace: parsed.ignoreWhitespace,
      url
    };
  }

  /**
   * Restores GitHub tab state, re-applying filter inputs and anchoring elements.
   *
   * @param {number} tabId
   * @param {object} [plan={}]
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async restore(tabId, plan = {}, context = {}) {
    const state = plan.adapter?.state || plan.adapter || {};
    const targetHash = state.hash || null;
    const filterQuery = state.filterQuery || null;

    // 1. Direct DOM restore
    const doc = context.document || (typeof document !== "undefined" ? document : null);
    if (doc) {
      if (filterQuery) {
        const input = doc.querySelector?.(
          "input#js-issues-search, input[name='q'], input[data-hotkey='s,/'], input[aria-label='Search all issues']"
        );
        if (input && input.value !== filterQuery) {
          input.value = filterQuery;
          const evt = typeof Event !== "undefined" ? new Event("input", { bubbles: true }) : { type: "input" };
          input.dispatchEvent?.(evt);
        }
      }

      if (targetHash) {
        if (typeof window !== "undefined" && window.location && window.location.hash !== targetHash) {
          window.location.hash = targetHash;
        }
        const targetEl = doc.querySelector?.(targetHash);
        if (targetEl && typeof targetEl.scrollIntoView === "function") {
          targetEl.scrollIntoView();
        }
      }
    }

    // 2. Chrome scripting API restore
    if (context.chromeApi?.scripting?.executeScript && (filterQuery || targetHash)) {
      try {
        await context.chromeApi.scripting.executeScript({
          target: { tabId },
          func: (fq, th) => {
            if (fq) {
              const input = document.querySelector(
                "input#js-issues-search, input[name='q'], input[data-hotkey='s,/'], input[aria-label='Search all issues']"
              );
              if (input && input.value !== fq) {
                input.value = fq;
                input.dispatchEvent(new Event("input", { bubbles: true }));
              }
            }
            if (th) {
              if (window.location.hash !== th) {
                window.location.hash = th;
              }
              const targetEl = document.querySelector(th);
              if (targetEl && typeof targetEl.scrollIntoView === "function") {
                targetEl.scrollIntoView();
              }
            }
          },
          args: [filterQuery, targetHash]
        });
      } catch (_) {}
    }

    return {
      ok: true,
      restored: true,
      owner: state.owner,
      repo: state.repo,
      pageType: state.pageType,
      filterQuery,
      hash: targetHash
    };
  }

  /**
   * Validates that state has a valid owner and pageType.
   *
   * @param {*} state
   * @returns {boolean}
   */
  validateState(state) {
    if (!state || typeof state !== "object") return false;
    if (typeof state.pageType !== "string" || !state.pageType) return false;
    return typeof state.owner === "string" || state.pageType === "home";
  }

  /**
   * Human-readable summary for display in suspended UI card.
   *
   * @param {*} state
   * @returns {string}
   */
  formatSummary(state) {
    return formatGitHubSummary(state);
  }
}
