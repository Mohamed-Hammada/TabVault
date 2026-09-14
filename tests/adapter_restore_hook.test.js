import test from "node:test";
import assert from "node:assert/strict";

import { BaseSiteAdapter } from "../lib/adapters/base.js";
import { AdapterRegistry } from "../lib/adapters/registry.js";
import {
  executeAdapterRestore,
  restoreSiteAdapterState
} from "../lib/adapters/restore.js";
import {
  RestorationSession,
  RestorationStage,
  runRestorationPipeline
} from "../lib/restore-engine.js";

test("executeAdapterRestore validates adapter contract and executes restore successfully", async () => {
  // 1. Invalid adapter
  const invalid = await executeAdapterRestore(null, 10);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.restored, false);
  assert.ok(invalid.error.includes("missing restore() method"));

  // 2. Standard adapter with successful restore
  let receivedTabId = null;
  let receivedPlan = null;
  let receivedContext = null;

  class MockYouTubeAdapter extends BaseSiteAdapter {
    constructor() {
      super({
        id: "youtube",
        name: "YouTube",
        domainPatterns: ["*://*.youtube.com/*"]
      });
    }

    async restore(tabId, plan, context) {
      receivedTabId = tabId;
      receivedPlan = plan;
      receivedContext = context;
      return { timestampRestored: 45.2 };
    }
  }

  const adapter = new MockYouTubeAdapter();
  const plan = {
    url: "https://www.youtube.com/watch?v=123",
    adapter: { state: { currentTime: 45.2 } }
  };
  const context = { chromeApi: { tabs: {} }, timeoutMs: 1500 };

  const res = await executeAdapterRestore(adapter, 101, plan, context);

  assert.equal(res.ok, true);
  assert.equal(res.restored, true);
  assert.equal(res.adapterId, "youtube");
  assert.equal(receivedTabId, 101);
  assert.equal(receivedPlan.url, "https://www.youtube.com/watch?v=123");
  assert.equal(res.result.timestampRestored, 45.2);
});

test("executeAdapterRestore handles failure, boolean false, and exceptions with failure isolation", async () => {
  // 1. Adapter returning false
  class FalseAdapter extends BaseSiteAdapter {
    constructor() {
      super({ id: "false-adapter", name: "False Adapter", domainPatterns: ["*://example.com/*"] });
    }
    async restore() {
      return false;
    }
  }

  const falseAdapter = new FalseAdapter();
  const falseRes = await executeAdapterRestore(falseAdapter, 102);
  assert.equal(falseRes.ok, false);
  assert.equal(falseRes.restored, false);
  assert.ok(falseRes.error.includes("returned false"));

  // 2. Adapter throwing an error
  class CrashingAdapter extends BaseSiteAdapter {
    constructor() {
      super({ id: "crasher", name: "Crasher", domainPatterns: ["*://crash.com/*"] });
    }
    async restore() {
      throw new Error("Target frame destroyed");
    }
  }

  const crashAdapter = new CrashingAdapter();
  const crashRes = await executeAdapterRestore(crashAdapter, 103);
  assert.equal(crashRes.ok, false);
  assert.equal(crashRes.restored, false);
  assert.ok(crashRes.error.includes("Target frame destroyed"));
});

test("executeAdapterRestore enforces timeout properly", async () => {
  class HangingAdapter extends BaseSiteAdapter {
    constructor() {
      super({
        id: "hanging",
        name: "Hanging Adapter",
        domainPatterns: ["*://hang.com/*"],
        timeoutMs: 40
      });
    }
    async restore() {
      await new Promise(resolve => setTimeout(resolve, 150));
      return true;
    }
  }

  const adapter = new HangingAdapter();
  const res = await executeAdapterRestore(adapter, 104);

  assert.equal(res.ok, false);
  assert.equal(res.timedOut, true);
  assert.ok(res.error.includes("Adapter timed out"));
});

test("restoreSiteAdapterState and AdapterRegistry.restoreForUrl match and execute restore", async () => {
  const registry = new AdapterRegistry();

  let called = false;
  class MockGitHubAdapter extends BaseSiteAdapter {
    constructor() {
      super({
        id: "github",
        name: "GitHub",
        domainPatterns: ["*://github.com/*"]
      });
    }
    async restore(tabId, plan, context) {
      called = true;
      return true;
    }
  }

  registry.register(new MockGitHubAdapter());

  // Non-matching URL
  const unmatched = await restoreSiteAdapterState("https://gitlab.com/repo", 201, {}, { adapterRegistry: registry });
  assert.equal(unmatched.matched, false);
  assert.equal(unmatched.ok, true);
  assert.equal(unmatched.restored, false);

  // Matching URL
  const matched = await restoreSiteAdapterState("https://github.com/torvalds/linux", 201, { url: "https://github.com/torvalds/linux" }, { adapterRegistry: registry });
  assert.equal(matched.matched, true);
  assert.equal(matched.ok, true);
  assert.equal(matched.restored, true);
  assert.equal(called, true);

  // Registry instance restoreForUrl method
  let methodCalled = false;
  class MockJiraAdapter extends BaseSiteAdapter {
    constructor() {
      super({
        id: "jira",
        name: "Jira",
        domainPatterns: ["*://*.atlassian.net/*"]
      });
    }
    async restore() {
      methodCalled = true;
      return true;
    }
  }

  registry.register(new MockJiraAdapter());
  const viaMethod = await registry.restoreForUrl("https://mycompany.atlassian.net/jira", 202);
  assert.equal(viaMethod.matched, true);
  assert.equal(viaMethod.ok, true);
  assert.equal(methodCalled, true);
});

test("runRestorationPipeline integrates restore hook and records history", async () => {
  const registry = new AdapterRegistry();
  let restoreApplied = false;

  class MockDocsAdapter extends BaseSiteAdapter {
    constructor() {
      super({
        id: "gdocs",
        name: "Google Docs",
        domainPatterns: ["*://docs.google.com/*"]
      });
    }
    async restore(tabId, plan) {
      restoreApplied = true;
      return true;
    }
  }

  registry.register(new MockDocsAdapter());

  const fakeChrome = {
    tabs: {
      get: async (id) => ({ id, url: "https://docs.google.com/document/d/123" }),
      update: async () => ({})
    }
  };

  const session = new RestorationSession(301, {
    targetUrl: "https://docs.google.com/document/d/123"
  });

  const res = await runRestorationPipeline(session, {
    chromeApi: fakeChrome,
    adapterRegistry: registry
  });

  assert.equal(res.ok, true);
  assert.equal(restoreApplied, true);
  assert.equal(session.stage, RestorationStage.COMPLETED);
});
