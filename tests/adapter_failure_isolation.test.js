import test from "node:test";
import assert from "node:assert/strict";

import { BaseSiteAdapter } from "../lib/adapters/base.js";
import { AdapterRegistry } from "../lib/adapters/registry.js";
import {
  AdapterFailureTracker,
  getAdapterFailureTracker,
  resetAdapterFailureTracker,
  isolateAdapterOperation
} from "../lib/adapters/isolation.js";
import { executeAdapterCapture, captureSiteAdapterState } from "../lib/adapters/capture.js";
import { executeAdapterRestore, restoreSiteAdapterState } from "../lib/adapters/restore.js";
import { createTabSnapshot, createRestorationPlan } from "../lib/snapshot.js";
import { RestorationSession, RestorationStage, runRestorationPipeline } from "../lib/restore-engine.js";

test("AdapterFailureTracker records, filters, caps, and resets failure diagnostics", () => {
  const tracker = new AdapterFailureTracker(3);

  // 1. Record different errors
  tracker.record({ adapterId: "youtube", stage: "capture", error: new Error("Video element missing"), tabId: 101, url: "https://youtube.com/watch?v=1" });
  tracker.record({ adapterId: "github", stage: "restore", error: "PR diff DOM failed", tabId: 102, url: "https://github.com/org/repo/pull/1" });
  tracker.record({ adapterId: "youtube", stage: "restore", error: new Error("Player iframe not responsive"), tabId: 101 });

  assert.equal(tracker.count(), 3);

  // 2. Filter by adapterId
  const ytFails = tracker.getFailuresByAdapter("youtube");
  assert.equal(ytFails.length, 2);
  assert.equal(ytFails[0].stage, "capture");
  assert.equal(ytFails[1].stage, "restore");

  // 3. Filter by stage and tabId
  const restoreFails = tracker.getFailures({ stage: "restore" });
  assert.equal(restoreFails.length, 2);

  const tab102Fails = tracker.getFailures({ tabId: 102 });
  assert.equal(tab102Fails.length, 1);
  assert.equal(tab102Fails[0].adapterId, "github");

  // 4. Capacity limit eviction
  tracker.record({ adapterId: "jira", stage: "matching", error: "Regex error" });
  assert.equal(tracker.count(), 3);
  // Oldest (first youtube capture) should be evicted
  assert.equal(tracker.getFailures()[0].adapterId, "github");
  assert.equal(tracker.getFailures()[2].adapterId, "jira");

  // 5. Clear
  tracker.clear();
  assert.equal(tracker.count(), 0);
});

test("isolateAdapterOperation safely executes or catches without throwing", async () => {
  resetAdapterFailureTracker();
  const tracker = getAdapterFailureTracker();

  // Successful call
  const good = await isolateAdapterOperation("test", "capture", async () => ({ value: 123 }));
  assert.equal(good.ok, true);
  assert.equal(good.value.value, 123);
  assert.equal(tracker.count(), 0);

  // Crashing call
  const bad = await isolateAdapterOperation("crasher", "restore", async () => {
    throw new TypeError("Null pointer in DOM traversal");
  }, { fallback: "safe" });

  assert.equal(bad.ok, false);
  assert.deepEqual(bad.value, { fallback: "safe" });
  assert.ok(bad.error.includes("Null pointer"));
  assert.equal(tracker.count(), 1);
  assert.equal(tracker.getFailuresByAdapter("crasher")[0].stage, "restore");
});

test("capture hook isolates adapter exceptions and validation failures", async () => {
  resetAdapterFailureTracker();
  const tracker = getAdapterFailureTracker();

  class ExplodingCaptureAdapter extends BaseSiteAdapter {
    constructor() {
      super({
        id: "exploder",
        name: "Exploder",
        domainPatterns: ["*://boom.com/*"]
      });
    }
    async capture() {
      throw new Error("SecurityError: Blocked frame with origin from accessing a cross-origin frame");
    }
  }

  const adapter = new ExplodingCaptureAdapter();

  // Execute capture directly
  const res = await executeAdapterCapture(adapter, 201, { url: "https://boom.com/page" });
  assert.equal(res.ok, false);
  assert.equal(res.state, null);
  assert.ok(res.error.includes("SecurityError"));

  // Failure must be tracked in failure tracker
  const failures = tracker.getFailuresByAdapter("exploder");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].stage, "capture");
  assert.ok(failures[0].error.includes("SecurityError"));

  // Snapshot creation must still succeed with valid metadata even when adapter fails
  const snapshot = createTabSnapshot(
    { id: 201, url: "https://boom.com/page", title: "Boom Page" },
    { adapter: res.state } // null
  );
  assert.ok(snapshot);
  assert.equal(snapshot.url, "https://boom.com/page");
  assert.equal(snapshot.adapter, null);
});

test("matching isolates exceptions in adapter.matches and continues to other adapters", async () => {
  resetAdapterFailureTracker();
  const tracker = getAdapterFailureTracker();
  const registry = new AdapterRegistry();

  class BrokenMatchAdapter extends BaseSiteAdapter {
    constructor() {
      super({
        id: "broken-match",
        name: "Broken Match",
        priority: 200 // Higher priority, runs first
      });
    }
    matches() {
      throw new Error("Invalid regular expression flags in user pattern");
    }
  }

  class WorkingAdapter extends BaseSiteAdapter {
    constructor() {
      super({
        id: "working",
        name: "Working Adapter",
        domainPatterns: ["*://example.com/*"],
        priority: 100
      });
    }
  }

  registry.register(new BrokenMatchAdapter());
  registry.register(new WorkingAdapter());

  // Finding matching adapter should NOT crash, should log failure, and should match WorkingAdapter
  const matched = registry.findMatchingAdapter("https://example.com/test");
  assert.ok(matched);
  assert.equal(matched.id, "working");

  // Error must be logged in tracker
  const matchFails = tracker.getFailuresByAdapter("broken-match");
  assert.equal(matchFails.length, 1);
  assert.equal(matchFails[0].stage, "matching");
  assert.ok(matchFails[0].error.includes("Invalid regular expression"));
});

test("restoration pipeline isolates adapter crashes and completes tab restoration", async () => {
  resetAdapterFailureTracker();
  const tracker = getAdapterFailureTracker();
  const registry = new AdapterRegistry();

  class CatastrophicRestoreAdapter extends BaseSiteAdapter {
    constructor() {
      super({
        id: "catastrophic",
        name: "Catastrophic Adapter",
        domainPatterns: ["*://app.example.com/*"]
      });
    }
    async restore() {
      throw new Error("Critical DOM querySelector failure");
    }
  }

  registry.register(new CatastrophicRestoreAdapter());

  const fakeChrome = {
    tabs: {
      get: async (id) => ({ id, url: "https://app.example.com/item/42" }),
      update: async () => ({})
    }
  };

  const session = new RestorationSession(801, {
    targetUrl: "https://app.example.com/item/42"
  });

  const res = await runRestorationPipeline(session, {
    chromeApi: fakeChrome,
    adapterRegistry: registry
  });

  // Tab restoration MUST succeed despite the adapter crash
  assert.equal(res.ok, true);
  assert.equal(session.stage, RestorationStage.COMPLETED);
  assert.equal(session.isFailed, false);

  // Adapter error must be logged in history
  const historyEntry = session.history.find(h =>
    typeof h.detail === "string" && h.detail.includes("Critical DOM querySelector failure")
  );
  assert.ok(historyEntry, "Session history must record isolated adapter error");

  // Adapter error must be recorded in global failure tracker
  const trackerFailures = tracker.getFailuresByAdapter("catastrophic");
  assert.equal(trackerFailures.length, 1);
  assert.equal(trackerFailures[0].stage, "restore");
});
