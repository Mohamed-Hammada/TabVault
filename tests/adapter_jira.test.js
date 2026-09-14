import test from "node:test";
import assert from "node:assert/strict";

import {
  JiraAdapter,
  parseJiraUrl,
  formatJiraSummary
} from "../lib/adapters/jira.js";
import {
  getAdapterRegistry,
  resetAdapterRegistry,
  registerBuiltInAdapters
} from "../lib/adapters/registry.js";
import { captureSiteAdapterState } from "../lib/adapters/capture.js";
import { restoreSiteAdapterState } from "../lib/adapters/restore.js";

test("Jira URL parser: parseJiraUrl", () => {
  const board = parseJiraUrl("https://acme.atlassian.net/jira/software/c/projects/ENG/boards/42?selectedIssue=ENG-123&quickFilter=10,20&text=backend");
  assert.equal(board.site, "acme.atlassian.net");
  assert.equal(board.projectKey, "ENG");
  assert.equal(board.boardId, 42);
  assert.equal(board.viewType, "board");
  assert.equal(board.selectedIssue, "ENG-123");
  assert.deepEqual(board.quickFilters, ["10", "20"]);
  assert.equal(board.boardSearchText, "backend");

  const backlog = parseJiraUrl("https://acme.atlassian.net/jira/software/c/projects/PROD/boards/88/backlog?selectedIssue=PROD-55");
  assert.equal(backlog.viewType, "backlog");
  assert.equal(backlog.projectKey, "PROD");
  assert.equal(backlog.boardId, 88);
  assert.equal(backlog.selectedIssue, "PROD-55");

  const search = parseJiraUrl("https://acme.atlassian.net/issues/?jql=project%20%3D%20ENG%20AND%20status%20%3D%20Open");
  assert.equal(search.viewType, "issues_search");
  assert.equal(search.jqlQuery, "project = ENG AND status = Open");

  const direct = parseJiraUrl("https://jira.mycorp.org/browse/SEC-777");
  assert.equal(direct.viewType, "issue_detail");
  assert.equal(direct.projectKey, "SEC");
  assert.equal(direct.selectedIssue, "SEC-777");

  // Non-Jira URLs
  assert.equal(parseJiraUrl("https://google.com/search?q=jira"), null);
  assert.equal(parseJiraUrl("https://github.com/atlassian/jira"), null);
  assert.equal(parseJiraUrl(""), null);
});

test("Jira formatJiraSummary", () => {
  assert.equal(
    formatJiraSummary({
      projectKey: "ENG",
      viewType: "issue_detail",
      selectedIssue: "ENG-123"
    }),
    "Jira [ENG] Issue ENG-123"
  );

  assert.equal(
    formatJiraSummary({
      projectKey: "ENG",
      viewType: "board",
      boardId: 42,
      selectedIssue: "ENG-123",
      quickFilters: ["1", "2"]
    }),
    "Jira [ENG] Board #42 (selected: ENG-123) [2 filters]"
  );

  assert.equal(
    formatJiraSummary({
      projectKey: "OPS",
      viewType: "backlog",
      boardId: 50,
      selectedIssue: "OPS-99"
    }),
    "Jira [OPS] Backlog #50 (selected: OPS-99)"
  );

  assert.equal(
    formatJiraSummary({
      projectKey: "CORE",
      viewType: "issues_search",
      jqlQuery: "assignee = currentUser()"
    }),
    'Jira [CORE] Search: "assignee = currentUser()"'
  );

  assert.equal(formatJiraSummary(null), "Jira page");
});

test("JiraAdapter metadata and matching", () => {
  const adapter = new JiraAdapter();

  assert.equal(adapter.id, "jira");
  assert.equal(adapter.name, "Jira");
  assert.equal(adapter.priority, 135);

  assert.equal(adapter.matches("https://acme.atlassian.net/jira/software/c/projects/ENG/boards/1"), true);
  assert.equal(adapter.matches("https://jira.corp.internal/browse/ENG-101"), true);
  assert.equal(adapter.matches("https://github.com/atlassian"), false);
});

test("JiraAdapter capture: via DOM inspection", async () => {
  const adapter = new JiraAdapter();

  const mockJqlInput = { value: "project = DEV ORDER BY created DESC" };
  const mockSelectedIssue = {
    getAttribute(attr) {
      if (attr === "data-issue-key") return "DEV-888";
      return null;
    }
  };
  const mockFilterButtons = [
    { getAttribute: (attr) => (attr === "data-filter-id" ? "qf-1" : null) },
    { getAttribute: (attr) => (attr === "data-filter-id" ? "qf-2" : null) }
  ];

  const mockDoc = {
    querySelector(selector) {
      if (selector.includes("advanced-search")) return mockJqlInput;
      if (selector.includes("issue-compact")) return mockSelectedIssue;
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes("quick-filter")) return mockFilterButtons;
      return [];
    }
  };

  const captured = await adapter.capture(101, {
    url: "https://acme.atlassian.net/jira/software/c/projects/DEV/boards/5",
    document: mockDoc
  });

  assert.ok(captured);
  assert.equal(captured.projectKey, "DEV");
  assert.equal(captured.selectedIssue, "DEV-888");
  assert.equal(captured.jqlQuery, "project = DEV ORDER BY created DESC");
  assert.deepEqual(captured.quickFilters, ["qf-1", "qf-2"]);
});

test("JiraAdapter capture: via chromeApi scripting fallback", async () => {
  const adapter = new JiraAdapter();

  const chromeApi = {
    scripting: {
      executeScript: async () => [
        {
          result: {
            jql: "resolution = Unresolved",
            selectedIssue: "DEV-321",
            filterIds: ["qf-99"]
          }
        }
      ]
    }
  };

  const captured = await adapter.capture(102, {
    url: "https://acme.atlassian.net/jira/software/c/projects/DEV/boards/5",
    chromeApi
  });

  assert.ok(captured);
  assert.equal(captured.selectedIssue, "DEV-321");
  assert.equal(captured.jqlQuery, "resolution = Unresolved");
  assert.deepEqual(captured.quickFilters, ["qf-99"]);
});

test("JiraAdapter capture: fallback from URL", async () => {
  const adapter = new JiraAdapter();

  const captured = await adapter.capture(103, {
    url: "https://acme.atlassian.net/jira/software/c/projects/ENG/boards/10?selectedIssue=ENG-404&quickFilter=55"
  });

  assert.ok(captured);
  assert.equal(captured.selectedIssue, "ENG-404");
  assert.deepEqual(captured.quickFilters, ["55"]);
});

test("JiraAdapter restore: direct DOM restore", async () => {
  const adapter = new JiraAdapter();

  let jqlVal = "";
  let eventDispatched = false;
  let cardScrolled = false;

  const mockInput = {
    get value() {
      return jqlVal;
    },
    set value(v) {
      jqlVal = v;
    },
    dispatchEvent() {
      eventDispatched = true;
    }
  };

  const mockCard = {
    scrollIntoView() {
      cardScrolled = true;
    }
  };

  const mockDoc = {
    querySelector(selector) {
      if (selector.includes("advanced-search")) return mockInput;
      if (selector.includes("ENG-999")) return mockCard;
      return null;
    }
  };

  const res = await adapter.restore(
    101,
    {
      url: "https://acme.atlassian.net/jira/software/c/projects/ENG/boards/10",
      adapter: {
        id: "jira",
        state: {
          projectKey: "ENG",
          selectedIssue: "ENG-999",
          jqlQuery: "status = 'In Progress'"
        }
      }
    },
    { document: mockDoc }
  );

  assert.equal(res.ok, true);
  assert.equal(res.restored, true);
  assert.equal(jqlVal, "status = 'In Progress'");
  assert.equal(eventDispatched, true);
  assert.equal(cardScrolled, true);
});

test("JiraAdapter restore: via chromeApi scripting", async () => {
  const adapter = new JiraAdapter();

  let scriptCalled = false;
  let passedArgs = [];
  const chromeApi = {
    scripting: {
      executeScript: async (options) => {
        scriptCalled = true;
        passedArgs = options.args;
        return [{ result: true }];
      }
    }
  };

  const res = await adapter.restore(
    101,
    {
      url: "https://acme.atlassian.net/browse/ENG-500",
      adapter: {
        id: "jira",
        state: {
          projectKey: "ENG",
          selectedIssue: "ENG-500",
          jqlQuery: "project = ENG"
        }
      }
    },
    { chromeApi }
  );

  assert.equal(res.ok, true);
  assert.equal(scriptCalled, true);
  assert.deepEqual(passedArgs, ["project = ENG", "ENG-500"]);
});

test("JiraAdapter validation and registry pipeline integration", async () => {
  resetAdapterRegistry();
  const registry = getAdapterRegistry();
  registerBuiltInAdapters(registry);

  const matched = registry.findMatchingAdapter("https://corp.atlassian.net/jira/software/c/projects/OPS/boards/20");
  assert.ok(matched);
  assert.equal(matched.id, "jira");

  const captureRes = await captureSiteAdapterState(
    "https://corp.atlassian.net/jira/software/c/projects/OPS/boards/20?selectedIssue=OPS-100&quickFilter=3",
    301,
    { adapterRegistry: registry }
  );

  assert.ok(captureRes);
  assert.equal(captureRes.matched, true);
  assert.equal(captureRes.ok, true);
  assert.equal(captureRes.adapterId, "jira");
  assert.equal(captureRes.state.selectedIssue, "OPS-100");
  assert.deepEqual(captureRes.state.quickFilters, ["3"]);
  assert.ok(captureRes.summary.includes("OPS"));

  const restoreRes = await restoreSiteAdapterState(
    "https://corp.atlassian.net/jira/software/c/projects/OPS/boards/20",
    301,
    {
      url: "https://corp.atlassian.net/jira/software/c/projects/OPS/boards/20",
      adapter: captureRes
    },
    { adapterRegistry: registry }
  );

  assert.equal(restoreRes.matched, true);
  assert.equal(restoreRes.ok, true);
  assert.equal(restoreRes.adapterId, "jira");
});
