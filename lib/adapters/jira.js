// TabVault — Atlassian Jira Site State Adapter
// Captures and restores Jira boards, backlogs, JQL filters, selected issues, and quick filters.

import { BaseSiteAdapter } from "./base.js";

/**
 * Parses a Jira URL into structured components.
 *
 * @param {string} url
 * @returns {object|null}
 */
export function parseJiraUrl(url) {
  if (!url || typeof url !== "string") return null;

  try {
    const parsed = new URL(url.includes("://") ? url : `https://${url}`);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname;

    const isAtlassian = host.endsWith(".atlassian.net");
    const isJiraHost = host.startsWith("jira.") || host.includes("/jira");
    const isJiraPath = pathname.includes("/jira/") || pathname.startsWith("/browse/");

    if (!isAtlassian && !isJiraHost && !isJiraPath) {
      return null;
    }

    let viewType = "other";
    let projectKey = null;
    let boardId = null;
    let selectedIssue = parsed.searchParams.get("selectedIssue") || null;

    // Direct issue browse URL: /browse/KEY-123
    const browseMatch = pathname.match(/\/browse\/([A-Z0-9]+-\d+)/i);
    if (browseMatch) {
      viewType = "issue_detail";
      selectedIssue = browseMatch[1].toUpperCase();
      projectKey = selectedIssue.split("-")[0];
    } else if (pathname.includes("/boards/")) {
      // Board or Backlog URL: /jira/software/c/projects/KEY/boards/123[/backlog]
      const projMatch = pathname.match(/\/projects\/([A-Z0-9]+)/i);
      if (projMatch) projectKey = projMatch[1].toUpperCase();

      const boardMatch = pathname.match(/\/boards\/(\d+)/);
      if (boardMatch) boardId = parseInt(boardMatch[1], 10);

      if (pathname.includes("/backlog")) {
        viewType = "backlog";
      } else {
        viewType = "board";
      }
    } else if (pathname.includes("/issues")) {
      viewType = "issues_search";
    }

    // JQL query extraction
    const jqlQuery = parsed.searchParams.get("jql") || null;

    // Quick filters extraction
    const rawQuickFilters = parsed.searchParams.get("quickFilter");
    const quickFilters = rawQuickFilters ? rawQuickFilters.split(",").filter(Boolean) : [];

    // Board text search
    const boardSearchText = parsed.searchParams.get("text") || parsed.searchParams.get("search") || null;

    return {
      site: host,
      viewType,
      projectKey,
      boardId,
      selectedIssue,
      quickFilters,
      jqlQuery,
      boardSearchText,
      pathname
    };
  } catch (_) {
    return null;
  }
}

/**
 * Formats a human-readable summary for a Jira state.
 *
 * @param {object} state
 * @returns {string}
 */
export function formatJiraSummary(state) {
  if (!state || typeof state !== "object") return "Jira page";

  const prefix = state.projectKey ? `Jira [${state.projectKey}]` : "Jira";

  switch (state.viewType) {
    case "issue_detail":
      return `${prefix} Issue ${state.selectedIssue || ""}`;
    case "board": {
      const issue = state.selectedIssue ? ` (selected: ${state.selectedIssue})` : "";
      const filters = state.quickFilters?.length ? ` [${state.quickFilters.length} filters]` : "";
      return `${prefix} Board #${state.boardId || ""}${issue}${filters}`;
    }
    case "backlog": {
      const issue = state.selectedIssue ? ` (selected: ${state.selectedIssue})` : "";
      return `${prefix} Backlog #${state.boardId || ""}${issue}`;
    }
    case "issues_search":
      return `${prefix} Search${state.jqlQuery ? `: "${state.jqlQuery}"` : ""}`;
    default:
      return `${prefix} (${state.viewType || "page"})`;
  }
}

/**
 * Site adapter for Atlassian Jira tabs.
 */
export class JiraAdapter extends BaseSiteAdapter {
  constructor(options = {}) {
    super({
      id: "jira",
      name: "Jira",
      description: "Captures and restores Jira boards, backlogs, JQL filters, selected issues, and quick filters",
      domainPatterns: [
        "*://*.atlassian.net/*",
        "*://jira.*/*",
        "*://*/jira/*",
        "*://*/browse/*"
      ],
      priority: 135,
      timeoutMs: 3000,
      ...options
    });
  }

  /**
   * Matches Jira URLs.
   *
   * @param {string} url
   * @returns {boolean}
   */
  matches(url) {
    if (!super.matches(url)) return false;
    return Boolean(parseJiraUrl(url));
  }

  /**
   * Captures Jira board/search/issue state.
   *
   * @param {number} tabId
   * @param {object} [context={}]
   * @returns {Promise<object|null>}
   */
  async capture(tabId, context = {}) {
    const url = context.url || context.tab?.url || "";
    const parsed = parseJiraUrl(url);
    if (!parsed) return null;

    let selectedIssue = parsed.selectedIssue;
    let quickFilters = [...parsed.quickFilters];
    let jqlQuery = parsed.jqlQuery;
    let boardSearchText = parsed.boardSearchText;

    // 1. Direct DOM inspection
    const doc = context.document || (typeof document !== "undefined" ? document : null);
    if (doc) {
      // Check active JQL search box
      const jqlInput = doc.querySelector?.(
        "textarea#advanced-search, input#searcher-query, [data-test-id='searchfield']"
      );
      if (jqlInput && typeof jqlInput.value === "string" && jqlInput.value.trim().length > 0) {
        jqlQuery = jqlInput.value.trim();
      }

      // Check selected issue element
      const selectedEl = doc.querySelector?.(
        "[data-test-id*='issue-compact'][aria-selected='true'], [data-testid*='issue-card'][aria-selected='true']"
      );
      if (selectedEl) {
        const issueKey = selectedEl.getAttribute?.("data-issue-key") || selectedEl.dataset?.issueKey;
        if (issueKey) selectedIssue = issueKey;
      }

      // Active quick filters
      const activeFilterButtons = doc.querySelectorAll?.("button[data-testid*='quick-filter'][aria-pressed='true']");
      if (activeFilterButtons && activeFilterButtons.length > 0) {
        const ids = [];
        for (const btn of activeFilterButtons) {
          const fid = btn.getAttribute?.("data-filter-id") || btn.dataset?.filterId;
          if (fid && !ids.includes(fid)) ids.push(fid);
        }
        if (ids.length > 0) quickFilters = ids;
      }
    }

    // 2. Scripting fallback via chromeApi
    if (context.chromeApi?.scripting?.executeScript) {
      try {
        const results = await context.chromeApi.scripting.executeScript({
          target: { tabId },
          func: () => {
            const jqlEl = document.querySelector(
              "textarea#advanced-search, input#searcher-query, [data-test-id='searchfield']"
            );
            const selEl = document.querySelector(
              "[data-test-id*='issue-compact'][aria-selected='true'], [data-testid*='issue-card'][aria-selected='true']"
            );
            const filterBtns = document.querySelectorAll("button[data-testid*='quick-filter'][aria-pressed='true']");
            const filterIds = [];
            filterBtns.forEach(btn => {
              const id = btn.getAttribute("data-filter-id");
              if (id) filterIds.push(id);
            });

            return {
              jql: jqlEl ? jqlEl.value : null,
              selectedIssue: selEl ? (selEl.getAttribute("data-issue-key") || null) : null,
              filterIds
            };
          }
        });

        const data = results?.[0]?.result;
        if (data) {
          if (data.jql) jqlQuery = data.jql.trim();
          if (data.selectedIssue) selectedIssue = data.selectedIssue;
          if (data.filterIds?.length) quickFilters = data.filterIds;
        }
      } catch (_) {}
    }

    return {
      site: parsed.site,
      viewType: parsed.viewType,
      projectKey: parsed.projectKey,
      boardId: parsed.boardId,
      selectedIssue,
      quickFilters,
      jqlQuery,
      boardSearchText,
      url
    };
  }

  /**
   * Restores Jira tab state.
   *
   * @param {number} tabId
   * @param {object} [plan={}]
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async restore(tabId, plan = {}, context = {}) {
    const state = plan.adapter?.state || plan.adapter || {};
    const selectedIssue = state.selectedIssue || null;
    const jqlQuery = state.jqlQuery || null;

    // 1. Direct DOM restore
    const doc = context.document || (typeof document !== "undefined" ? document : null);
    if (doc) {
      if (jqlQuery) {
        const jqlInput = doc.querySelector?.(
          "textarea#advanced-search, input#searcher-query, [data-test-id='searchfield']"
        );
        if (jqlInput && jqlInput.value !== jqlQuery) {
          jqlInput.value = jqlQuery;
          const evt = typeof Event !== "undefined" ? new Event("input", { bubbles: true }) : { type: "input" };
          jqlInput.dispatchEvent?.(evt);
        }
      }

      if (selectedIssue) {
        const issueCard = doc.querySelector?.(
          `[data-issue-key='${selectedIssue}'], [data-test-id*='${selectedIssue}']`
        );
        if (issueCard && typeof issueCard.scrollIntoView === "function") {
          issueCard.scrollIntoView();
        }
      }
    }

    // 2. Scripting fallback via chromeApi
    if (context.chromeApi?.scripting?.executeScript && (jqlQuery || selectedIssue)) {
      try {
        await context.chromeApi.scripting.executeScript({
          target: { tabId },
          func: (jq, sel) => {
            if (jq) {
              const el = document.querySelector("textarea#advanced-search, input#searcher-query, [data-test-id='searchfield']");
              if (el && el.value !== jq) {
                el.value = jq;
                el.dispatchEvent(new Event("input", { bubbles: true }));
              }
            }
            if (sel) {
              const card = document.querySelector(`[data-issue-key='${sel}'], [data-test-id*='${sel}']`);
              if (card && typeof card.scrollIntoView === "function") {
                card.scrollIntoView();
              }
            }
          },
          args: [jqlQuery, selectedIssue]
        });
      } catch (_) {}
    }

    return {
      ok: true,
      restored: true,
      site: state.site,
      viewType: state.viewType,
      projectKey: state.projectKey,
      selectedIssue,
      jqlQuery
    };
  }

  /**
   * Validates that state is a valid Jira state object.
   *
   * @param {*} state
   * @returns {boolean}
   */
  validateState(state) {
    if (!state || typeof state !== "object") return false;
    return Boolean(state.site || state.projectKey || state.viewType);
  }

  /**
   * Human-readable summary for display in suspended UI card.
   *
   * @param {*} state
   * @returns {string}
   */
  formatSummary(state) {
    return formatJiraSummary(state);
  }
}
