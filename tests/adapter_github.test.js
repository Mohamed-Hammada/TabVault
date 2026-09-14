import test from "node:test";
import assert from "node:assert/strict";

import {
  GitHubAdapter,
  parseGitHubUrl,
  formatGitHubSummary
} from "../lib/adapters/github.js";
import {
  getAdapterRegistry,
  resetAdapterRegistry,
  registerBuiltInAdapters
} from "../lib/adapters/registry.js";
import { captureSiteAdapterState } from "../lib/adapters/capture.js";
import { restoreSiteAdapterState } from "../lib/adapters/restore.js";

test("GitHub URL parser: parseGitHubUrl", () => {
  const root = parseGitHubUrl("https://github.com/facebook/react");
  assert.equal(root.owner, "facebook");
  assert.equal(root.repo, "react");
  assert.equal(root.pageType, "repo_root");

  const issues = parseGitHubUrl("https://github.com/facebook/react/issues?q=is%3Aissue+is%3Aopen+label%3Abug");
  assert.equal(issues.pageType, "issues_list");
  assert.equal(issues.searchQuery, "is:issue is:open label:bug");

  const issueDetail = parseGitHubUrl("https://github.com/facebook/react/issues/1234#issuecomment-5678");
  assert.equal(issueDetail.pageType, "issue_detail");
  assert.equal(issueDetail.issueOrPrNumber, 1234);
  assert.equal(issueDetail.hash, "#issuecomment-5678");

  const prFiles = parseGitHubUrl("https://github.com/facebook/react/pull/5678/files?diff=split&w=1#diff-abc");
  assert.equal(prFiles.pageType, "pull_detail");
  assert.equal(prFiles.issueOrPrNumber, 5678);
  assert.equal(prFiles.diffView, "split");
  assert.equal(prFiles.ignoreWhitespace, true);
  assert.equal(prFiles.hash, "#diff-abc");

  const blob = parseGitHubUrl("https://github.com/facebook/react/blob/main/src/index.js#L10-L20");
  assert.equal(blob.pageType, "blob");
  assert.equal(blob.ref, "main");
  assert.equal(blob.filePath, "src/index.js");
  assert.equal(blob.hash, "#L10-L20");

  const tree = parseGitHubUrl("https://github.com/facebook/react/tree/v18.2.0/packages");
  assert.equal(tree.pageType, "tree");
  assert.equal(tree.ref, "v18.2.0");
  assert.equal(tree.filePath, "packages");

  // Non-github URLs
  assert.equal(parseGitHubUrl("https://gitlab.com/owner/repo"), null);
  assert.equal(parseGitHubUrl("not a url"), null);
  assert.equal(parseGitHubUrl(""), null);
});

test("GitHub formatGitHubSummary", () => {
  assert.equal(
    formatGitHubSummary({
      owner: "facebook",
      repo: "react",
      pageType: "issue_detail",
      issueOrPrNumber: 101,
      hash: "#issuecomment-55"
    }),
    "facebook/react Issue #101 (#issuecomment-55)"
  );

  assert.equal(
    formatGitHubSummary({
      owner: "facebook",
      repo: "react",
      pageType: "pull_detail",
      issueOrPrNumber: 202,
      activeSubTab: "files",
      hash: "#diff-99"
    }),
    "facebook/react PR #202 [files] (#diff-99)"
  );

  assert.equal(
    formatGitHubSummary({
      owner: "facebook",
      repo: "react",
      pageType: "issues_list",
      filterQuery: "is:open label:bug"
    }),
    'facebook/react Issues: "is:open label:bug"'
  );

  assert.equal(
    formatGitHubSummary({
      owner: "facebook",
      repo: "react",
      pageType: "blob",
      filePath: "src/App.js",
      hash: "#L42"
    }),
    "facebook/react Code: src/App.js (#L42)"
  );

  assert.equal(formatGitHubSummary(null), "GitHub page");
});

test("GitHubAdapter metadata and matching", () => {
  const adapter = new GitHubAdapter();

  assert.equal(adapter.id, "github");
  assert.equal(adapter.name, "GitHub");
  assert.equal(adapter.priority, 140);

  assert.equal(adapter.matches("https://github.com/facebook/react"), true);
  assert.equal(adapter.matches("https://github.com/facebook/react/issues"), true);
  assert.equal(adapter.matches("https://github.com/facebook/react/pull/42"), true);
  assert.equal(adapter.matches("https://gitlab.com/facebook/react"), false);
  assert.equal(adapter.matches("https://google.com"), false);
});

test("GitHubAdapter capture: via DOM inspection", async () => {
  const adapter = new GitHubAdapter();

  const mockInput = {
    value: "is:pr is:open author:app-bot "
  };
  const mockTab = {
    textContent: "  Files changed (12)  "
  };

  const mockDoc = {
    querySelector(selector) {
      if (selector.includes("issues-search") || selector.includes("name='q'")) return mockInput;
      if (selector.includes("tabnav-tab.selected")) return mockTab;
      return null;
    }
  };

  const captured = await adapter.capture(101, {
    url: "https://github.com/owner/repo/pull/42",
    document: mockDoc
  });

  assert.ok(captured);
  assert.equal(captured.owner, "owner");
  assert.equal(captured.repo, "repo");
  assert.equal(captured.pageType, "pull_detail");
  assert.equal(captured.issueOrPrNumber, 42);
  assert.equal(captured.filterQuery, "is:pr is:open author:app-bot");
  assert.equal(captured.activeSubTab, "files");
});

test("GitHubAdapter capture: via chromeApi scripting fallback", async () => {
  const adapter = new GitHubAdapter();

  const chromeApi = {
    scripting: {
      executeScript: async () => [
        {
          result: {
            filterValue: "is:issue is:closed milestone:v2.0",
            activeTabLabel: "Conversation",
            currentHash: "#issuecomment-12345"
          }
        }
      ]
    }
  };

  const captured = await adapter.capture(102, {
    url: "https://github.com/owner/repo/issues/99",
    chromeApi
  });

  assert.ok(captured);
  assert.equal(captured.filterQuery, "is:issue is:closed milestone:v2.0");
  assert.equal(captured.hash, "#issuecomment-12345");
  assert.equal(captured.activeSubTab, "conversation");
});

test("GitHubAdapter capture: fallback from URL when DOM not present", async () => {
  const adapter = new GitHubAdapter();

  const captured = await adapter.capture(103, {
    url: "https://github.com/owner/repo/pull/77/files?w=1#diff-xyz"
  });

  assert.ok(captured);
  assert.equal(captured.activeSubTab, "files");
  assert.equal(captured.ignoreWhitespace, true);
  assert.equal(captured.hash, "#diff-xyz");
});

test("GitHubAdapter restore: direct DOM restore", async () => {
  const adapter = new GitHubAdapter();

  let inputValue = "";
  let eventDispatched = false;
  let scrolled = false;

  const mockInput = {
    get value() {
      return inputValue;
    },
    set value(v) {
      inputValue = v;
    },
    dispatchEvent() {
      eventDispatched = true;
    }
  };

  const mockTarget = {
    scrollIntoView() {
      scrolled = true;
    }
  };

  const mockDoc = {
    querySelector(selector) {
      if (selector.includes("issues-search") || selector.includes("name='q'")) return mockInput;
      if (selector === "#diff-test") return mockTarget;
      return null;
    }
  };

  const res = await adapter.restore(
    101,
    {
      url: "https://github.com/owner/repo/issues",
      adapter: {
        id: "github",
        state: {
          owner: "owner",
          repo: "repo",
          pageType: "issues_list",
          filterQuery: "is:open label:bug",
          hash: "#diff-test"
        }
      }
    },
    { document: mockDoc }
  );

  assert.equal(res.ok, true);
  assert.equal(res.restored, true);
  assert.equal(inputValue, "is:open label:bug");
  assert.equal(eventDispatched, true);
  assert.equal(scrolled, true);
});

test("GitHubAdapter restore: via chromeApi scripting", async () => {
  const adapter = new GitHubAdapter();

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
      url: "https://github.com/owner/repo/issues",
      adapter: {
        id: "github",
        state: {
          owner: "owner",
          repo: "repo",
          pageType: "issues_list",
          filterQuery: "is:open",
          hash: "#L25"
        }
      }
    },
    { chromeApi }
  );

  assert.equal(res.ok, true);
  assert.equal(scriptCalled, true);
  assert.deepEqual(passedArgs, ["is:open", "#L25"]);
});

test("GitHubAdapter validation and registry pipeline integration", async () => {
  resetAdapterRegistry();
  const registry = getAdapterRegistry();
  registerBuiltInAdapters(registry);

  const matched = registry.findMatchingAdapter("https://github.com/facebook/react/pull/123");
  assert.ok(matched);
  assert.equal(matched.id, "github");

  const captureRes = await captureSiteAdapterState(
    "https://github.com/facebook/react/issues?q=is%3Aopen+label%3Adocumentation",
    201,
    { adapterRegistry: registry }
  );

  assert.ok(captureRes);
  assert.equal(captureRes.matched, true);
  assert.equal(captureRes.ok, true);
  assert.equal(captureRes.adapterId, "github");
  assert.equal(captureRes.state.owner, "facebook");
  assert.equal(captureRes.state.repo, "react");
  assert.equal(captureRes.state.filterQuery, "is:open label:documentation");
  assert.ok(captureRes.summary.includes("documentation"));

  const restoreRes = await restoreSiteAdapterState(
    "https://github.com/facebook/react/issues",
    201,
    {
      url: "https://github.com/facebook/react/issues",
      adapter: captureRes
    },
    { adapterRegistry: registry }
  );

  assert.equal(restoreRes.matched, true);
  assert.equal(restoreRes.ok, true);
  assert.equal(restoreRes.adapterId, "github");
});
