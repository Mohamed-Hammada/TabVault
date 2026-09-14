import test from "node:test";
import assert from "node:assert/strict";
import {
  RestorationStage,
  STAGE_PROGRESS_MAP,
  getStageLabel,
  getStageDescription,
  RestorationSession,
  extractTargetUrlFromSuspendedUrl,
  runRestorationPipeline,
  RestorationEngine,
  getRestorationEngine,
  resetRestorationEngine,
  RestorePriority,
  isTabBackground,
  shouldDeferBackgroundRestoration,
  STORAGE_KEY_LAZY_RESTORE_BACKGROUND,
  DEFAULT_LAZY_RESTORE_BACKGROUND,
  loadLazyRestoreBackgroundSetting,
  saveLazyRestoreBackgroundSetting
} from "../lib/restore-engine.js";
import { TabState, LifecycleTracker } from "../lib/lifecycle.js";
import { TabMetadataStore } from "../lib/metadata.js";

test("RestorationStage defines all required stages and valid progress mapping", () => {
  assert.equal(RestorationStage.IDLE, "idle");
  assert.equal(RestorationStage.INIT, "init");
  assert.equal(RestorationStage.LOAD_URL, "load_url");
  assert.equal(RestorationStage.WAIT_READINESS, "wait_readiness");
  assert.equal(RestorationStage.RESTORE_SCROLL, "restore_scroll");
  assert.equal(RestorationStage.RESTORE_FORMS, "restore_forms");
  assert.equal(RestorationStage.APPLY_ADAPTER, "apply_adapter");
  assert.equal(RestorationStage.COMPLETED, "completed");
  assert.equal(RestorationStage.FAILED, "failed");
  assert.equal(RestorationStage.CANCELLED, "cancelled");

  assert.equal(STAGE_PROGRESS_MAP[RestorationStage.INIT], 10);
  assert.equal(STAGE_PROGRESS_MAP[RestorationStage.LOAD_URL], 25);
  assert.equal(STAGE_PROGRESS_MAP[RestorationStage.WAIT_READINESS], 50);
  assert.equal(STAGE_PROGRESS_MAP[RestorationStage.RESTORE_SCROLL], 70);
  assert.equal(STAGE_PROGRESS_MAP[RestorationStage.RESTORE_FORMS], 85);
  assert.equal(STAGE_PROGRESS_MAP[RestorationStage.APPLY_ADAPTER], 95);
  assert.equal(STAGE_PROGRESS_MAP[RestorationStage.COMPLETED], 100);
});

test("extractTargetUrlFromSuspendedUrl correctly parses URL hash params", () => {
  assert.equal(
    extractTargetUrlFromSuspendedUrl("chrome-extension://abc/suspended/suspended.html#u=https%3A%2F%2Fgithub.com&t=GitHub"),
    "https://github.com"
  );
  assert.equal(
    extractTargetUrlFromSuspendedUrl("chrome-extension://abc/suspended/suspended.html#u=https://example.com"),
    "https://example.com"
  );
  assert.equal(extractTargetUrlFromSuspendedUrl("https://example.com"), null);
  assert.equal(extractTargetUrlFromSuspendedUrl(""), null);
  assert.equal(extractTargetUrlFromSuspendedUrl(null), null);
});

test("RestorationSession tracks lifecycle, history, cancellation, and failure", () => {
  const session = new RestorationSession(101);
  assert.equal(session.tabId, 101);
  assert.equal(session.stage, RestorationStage.IDLE);
  assert.equal(session.progress, 0);

  session.setStage(RestorationStage.INIT);
  assert.equal(session.stage, RestorationStage.INIT);
  assert.equal(session.progress, 10);
  assert.equal(session.history.length, 1);

  session.setStage(RestorationStage.LOAD_URL, { targetUrl: "https://example.com" });
  assert.equal(session.stage, RestorationStage.LOAD_URL);
  assert.equal(session.progress, 25);
  assert.equal(session.history.length, 2);

  const status = session.getStatus();
  assert.equal(status.tabId, 101);
  assert.equal(status.stage, RestorationStage.LOAD_URL);
  assert.equal(status.progress, 25);
  assert.equal(status.isComplete, false);

  session.cancel("User closed tab");
  assert.equal(session.isCancelled, true);
  assert.equal(session.stage, RestorationStage.CANCELLED);
  assert.equal(session.error, "User closed tab");
});

test("runRestorationPipeline executes complete multi-step pipeline successfully", async () => {
  const lifecycleTracker = new LifecycleTracker();
  lifecycleTracker.transition(101, TabState.SNAPSHOTTING);
  lifecycleTracker.transition(101, TabState.DISCARDED);

  const metadataStore = new TabMetadataStore();
  metadataStore.set(101, { url: "https://example.com/article" });

  const fakeChrome = {
    tabs: {
      get: async (id) => ({
        id,
        url: "chrome-extension://test/suspended/suspended.html#u=https%3A%2F%2Fexample.com%2Farticle&t=Article"
      }),
      update: async (id, props) => ({ id, ...props }),
      sendMessage: async () => ({ ok: true })
    },
    scripting: {
      executeScript: async () => [{ result: true }]
    }
  };

  const fakeSnapshotStore = {
    getLatestSnapshot: async () => ({
      id: "snap_101",
      tabId: 101,
      url: "https://example.com/article",
      title: "Article Title",
      scroll: { x: 0, y: 1200, percentX: 0, percentY: 45 },
      forms: {
        "input[name='comment']": { value: "Hello world", type: "text" }
      }
    })
  };

  let adapterCalled = false;
  const fakeAdapterRegistry = {
    findMatchingAdapter: (url) => ({
      domain: "example.com",
      restore: async (tabId, plan) => {
        adapterCalled = true;
      }
    })
  };

  const session = new RestorationSession(101);
  const result = await runRestorationPipeline(session, {
    chromeApi: fakeChrome,
    lifecycleTracker,
    metadataStore,
    snapshotStore: fakeSnapshotStore,
    adapterRegistry: fakeAdapterRegistry
  });

  assert.equal(result.ok, true);
  assert.equal(result.tabId, 101);
  assert.equal(session.stage, RestorationStage.COMPLETED);
  assert.equal(session.progress, 100);
  assert.equal(adapterCalled, true);

  // Verify tab transitioned to RESTORED
  assert.equal(lifecycleTracker.getState(101), TabState.RESTORED);

  // Verify metadata store updated
  const meta = metadataStore.get(101);
  assert.equal(meta.restorationStatus, "restored");
  assert.equal(meta.restorationCount, 1);
});

test("runRestorationPipeline isolates adapter errors without failing restoration", async () => {
  const lifecycleTracker = new LifecycleTracker();
  lifecycleTracker.transition(102, TabState.SNAPSHOTTING);
  lifecycleTracker.transition(102, TabState.DISCARDED);

  const fakeChrome = {
    tabs: {
      get: async (id) => ({ id, url: "https://example.com" }),
      update: async () => ({})
    }
  };

  const faultyAdapterRegistry = {
    findMatchingAdapter: () => ({
      restore: async () => {
        throw new Error("Adapter DOM query crashed");
      }
    })
  };

  const session = new RestorationSession(102, { targetUrl: "https://example.com" });
  const result = await runRestorationPipeline(session, {
    chromeApi: fakeChrome,
    lifecycleTracker,
    adapterRegistry: faultyAdapterRegistry
  });

  assert.equal(result.ok, true);
  assert.equal(session.stage, RestorationStage.COMPLETED);
  assert.equal(lifecycleTracker.getState(102), TabState.RESTORED);

  // Check that adapter error was recorded in session history
  const adapterHistory = session.history.find(h => typeof h.detail === "string" && h.detail.includes("Adapter error (isolated)"));
  assert.ok(adapterHistory, "Adapter error must be isolated in history");
});

test("RestorationEngine prevents duplicate restorations for the same tab", async () => {
  resetRestorationEngine();
  const engine = new RestorationEngine({
    maxConcurrentRestorations: 1,
    timeoutMs: 5000
  });

  const duplicateEvents = [];
  engine.on("duplicate_prevented", (evt) => {
    duplicateEvents.push(evt);
  });

  let executionCount = 0;
  // Mock pipeline runner
  engine._executeSession = async (sess) => {
    executionCount++;
    await new Promise(r => setTimeout(r, 60));
    return { ok: true, tabId: sess.tabId };
  };

  // Launch two restorations simultaneously on tab #201 (in-flight duplicate)
  const promise1 = engine.restoreTab(201);
  const promise2 = engine.restoreTab(201);

  assert.equal(engine.isRestoring(201), true);
  assert.equal(engine.isQueued(201), false);
  assert.equal(engine.isRestoringOrQueued(201), true);

  // Launch two restorations on tab #202 (queued duplicate)
  const promise3 = engine.restoreTab(202);
  const promise4 = engine.restoreTab(202);

  assert.equal(engine.isQueued(202), true);
  assert.equal(engine.isRestoring(202), false);
  assert.equal(engine.isRestoringOrQueued(202), true);
  assert.equal(engine.getQueueLength(), 1, "Queued tab should only appear once in queue");

  const [res1, res2, res3, res4] = await Promise.all([promise1, promise2, promise3, promise4]);
  assert.equal(res1.ok, true);
  assert.equal(res2.ok, true);
  assert.equal(res3.ok, true);
  assert.equal(res4.ok, true);
  assert.equal(executionCount, 2, "Only 2 executions should have run (one for 201, one for 202)");

  assert.equal(duplicateEvents.length, 2);
  assert.equal(duplicateEvents[0].tabId, 201);
  assert.equal(duplicateEvents[0].status, "in_flight");
  assert.equal(duplicateEvents[1].tabId, 202);
  assert.equal(duplicateEvents[1].status, "queued");
});

test("RestorationEngine enqueues requests when concurrency limit is reached and prevents exceeding limits", async () => {
  resetRestorationEngine();
  const engine = new RestorationEngine({
    maxConcurrentRestorations: 2,
    timeoutMs: 5000
  });

  assert.equal(engine.getMaxConcurrentRestorations(), 2);

  const concurrencyEvents = [];
  engine.on("concurrency_limit_changed", evt => concurrencyEvents.push(evt));

  // Invalid concurrency configurations throw
  assert.throws(() => engine.setMaxConcurrentRestorations(0), /must be a number >= 1/);
  assert.throws(() => engine.setMaxConcurrentRestorations("invalid"), /must be a number >= 1/);

  let runningCount = 0;
  let maxObservedRunning = 0;

  engine._executeSession = async (sess) => {
    runningCount++;
    if (runningCount > maxObservedRunning) {
      maxObservedRunning = runningCount;
    }
    await new Promise(r => setTimeout(r, 40));
    runningCount--;
    return { ok: true, tabId: sess.tabId };
  };

  // Trigger 4 restorations simultaneously
  const p1 = engine.restoreTab(301);
  const p2 = engine.restoreTab(302);
  const p3 = engine.restoreTab(303);
  const p4 = engine.restoreTab(304);

  assert.equal(engine.getQueueLength(), 2);
  assert.equal(engine.getActiveCount(), 2);

  // Dynamically expand concurrency limit from 2 to 3 — should immediately drain one item from queue!
  engine.setMaxConcurrentRestorations(3);
  assert.equal(concurrencyEvents.length, 1);
  assert.equal(concurrencyEvents[0].maxConcurrentRestorations, 3);
  assert.equal(engine.getQueueLength(), 1, "Queue should drain from 2 to 1 as concurrency expanded to 3");
  assert.equal(engine.getActiveCount(), 3, "Active count should increase from 2 to 3");

  const results = await Promise.all([p1, p2, p3, p4]);
  assert.equal(results.length, 4);
  assert.equal(maxObservedRunning, 3, "Max concurrent executions must match expanded limit 3");
  assert.equal(engine.getQueueLength(), 0);
  assert.equal(engine.getActiveCount(), 0);
});

test("RestorationEngine handles cancellation of queued and active tabs", async () => {
  resetRestorationEngine();
  const lifecycleTracker = new LifecycleTracker();
  lifecycleTracker.transition(401, TabState.SNAPSHOTTING);
  lifecycleTracker.transition(401, TabState.DISCARDED);

  const engine = new RestorationEngine({
    maxConcurrentRestorations: 1,
    timeoutMs: 5000
  }, { lifecycleTracker });

  const cancelledEvents = [];
  engine.on("cancelled", (evt) => {
    cancelledEvents.push(evt);
  });

  engine._executeSession = async (sess) => {
    sess.setStage(RestorationStage.LOAD_URL);
    await new Promise(r => setTimeout(r, 100));
    return { ok: true, tabId: sess.tabId };
  };

  const p1 = engine.restoreTab(401);
  const p2 = engine.restoreTab(402); // Queued

  assert.equal(engine.getQueueLength(), 1);

  // Cancel queued tab #402
  const cancelledQueued = engine.cancelRestoration(402, "User closed queued tab");
  assert.equal(cancelledQueued, true);
  assert.equal(engine.getQueueLength(), 0);

  const res2 = await p2;
  assert.equal(res2.cancelled, true);
  assert.equal(res2.stage, RestorationStage.CANCELLED);

  // Cancel active tab #401
  const session401 = engine.inFlightSessions.get(401);
  assert.ok(session401);
  const cancelledActive = engine.cancelRestoration(401, "User navigated away");
  assert.equal(cancelledActive, true);
  assert.equal(session401.isCancelled, true);

  // Cancelling non-existent tab returns false
  assert.equal(engine.cancelRestoration(9999), false);

  await p1;

  // Verify cancelled event emissions
  assert.equal(cancelledEvents.length, 2);
  assert.equal(cancelledEvents[0].tabId, 402);
  assert.equal(cancelledEvents[0].wasQueued, true);
  assert.equal(cancelledEvents[1].tabId, 401);
  assert.equal(cancelledEvents[1].wasQueued, false);

  // Verify pipeline abortion transitions lifecycle to DISCARDED
  const fakeSession403 = new RestorationSession(403, { targetUrl: "https://example.com" });
  lifecycleTracker.transition(403, TabState.SNAPSHOTTING);
  lifecycleTracker.transition(403, TabState.DISCARDED);
  lifecycleTracker.transition(403, TabState.RESTORING);

  fakeSession403.cancel("User cancelled");
  const pipelineRes = await runRestorationPipeline(fakeSession403, {
    chromeApi: { tabs: { get: async () => ({ id: 403 }), update: async () => ({}) } },
    lifecycleTracker
  });

  assert.equal(pipelineRes.cancelled, true);
  assert.equal(lifecycleTracker.getState(403), TabState.DISCARDED);
});

test("Restoration status indicator provides accurate stage labels and descriptions", async () => {
  const { getStageLabel, getStageDescription } = await import("../lib/restore-engine.js");

  assert.equal(getStageLabel(RestorationStage.QUEUED), "Queued");
  assert.equal(getStageLabel(RestorationStage.INIT), "Preparing");
  assert.equal(getStageLabel(RestorationStage.LOAD_URL), "Loading URL");
  assert.equal(getStageLabel(RestorationStage.WAIT_READINESS), "Waiting Readiness");
  assert.equal(getStageLabel(RestorationStage.RESTORE_SCROLL), "Restoring Scroll");
  assert.equal(getStageLabel(RestorationStage.RESTORE_FORMS), "Restoring Forms");
  assert.equal(getStageLabel(RestorationStage.APPLY_ADAPTER), "Applying State");
  assert.equal(getStageLabel(RestorationStage.COMPLETED), "Restored");
  assert.equal(getStageLabel(RestorationStage.FAILED), "Restore Failed");

  assert.ok(getStageDescription(RestorationStage.LOAD_URL).includes("Loading target web page"));
  assert.ok(getStageDescription(RestorationStage.RESTORE_SCROLL).includes("scroll position"));
  assert.ok(getStageDescription(RestorationStage.RESTORE_FORMS).includes("form inputs"));

  // Verify stage change event emissions during pipeline execution
  resetRestorationEngine();
  const engine = new RestorationEngine({ timeoutMs: 5000 });

  const recordedStages = [];
  engine.on("stageChange", (evt) => {
    recordedStages.push(evt.stage);
  });

  const session = new RestorationSession(501);
  session.setStage(RestorationStage.INIT);
  engine.emit("stageChange", { tabId: 501, stage: RestorationStage.INIT, progress: 10 });
  session.setStage(RestorationStage.LOAD_URL);
  engine.emit("stageChange", { tabId: 501, stage: RestorationStage.LOAD_URL, progress: 25 });
  session.setStage(RestorationStage.COMPLETED);
  engine.emit("stageChange", { tabId: 501, stage: RestorationStage.COMPLETED, progress: 100 });

  assert.deepEqual(recordedStages, [
    RestorationStage.INIT,
    RestorationStage.LOAD_URL,
    RestorationStage.COMPLETED
  ]);
});

test("RestorationEngine enforces overall timeout and isolates adapter timeouts", async () => {
  resetRestorationEngine();
  const engine = new RestorationEngine({
    timeoutMs: 60,
    adapterTimeoutMs: 30
  });

  let timeoutEventReceived = false;
  engine.on("timeout", (data) => {
    if (data.tabId === 601) timeoutEventReceived = true;
  });

  // Hanging mock session
  engine._executeSession = async (sess, mergedOptions) => {
    sess.timeoutTimer = setTimeout(() => {
      sess.markTimedOut(`Restoration timed out after ${mergedOptions.timeoutMs}ms`);
      engine.emit("timeout", { tabId: sess.tabId, timeoutMs: mergedOptions.timeoutMs });
    }, mergedOptions.timeoutMs);

    // Block longer than timeoutMs
    await new Promise(r => setTimeout(r, 120));
    return {
      ok: false,
      cancelled: true,
      timedOut: sess.isTimedOut,
      tabId: sess.tabId,
      error: sess.error
    };
  };

  const res = await engine.restoreTab(601);
  assert.equal(res.ok, false);
  assert.equal(res.cancelled, true);
  assert.equal(res.timedOut, true);
  assert.equal(timeoutEventReceived, true);

  // Test hanging adapter timeout isolation in runRestorationPipeline
  const hangingAdapterRegistry = {
    findMatchingAdapter: () => ({
      restore: async () => {
        // Hangs for 200ms, exceeding adapterTimeoutMs = 30ms
        await new Promise(r => setTimeout(r, 200));
      }
    })
  };

  const fakeChrome = {
    tabs: {
      get: async (id) => ({ id, url: "https://example.com" }),
      update: async () => ({})
    }
  };

  const session602 = new RestorationSession(602, {
    targetUrl: "https://example.com",
    adapterTimeoutMs: 30
  });

  const pipelineRes = await runRestorationPipeline(session602, {
    chromeApi: fakeChrome,
    adapterRegistry: hangingAdapterRegistry
  });

  assert.equal(pipelineRes.ok, true);
  assert.equal(session602.stage, RestorationStage.COMPLETED);

  const timeoutHistory = session602.history.find(h =>
    typeof h.detail === "string" && h.detail.includes("Adapter timed out")
  );
  assert.ok(timeoutHistory, "Adapter timeout must be isolated in history without failing restoration");
});

test("RestorationEngine performs automated retries with exponential backoff and supports manual retries", async () => {
  const { isRetryableRestorationError } = await import("../lib/restore-engine.js");

  assert.equal(isRetryableRestorationError(new Error("Network connection dropped")), true);
  assert.equal(isRetryableRestorationError(new Error("Tab 999 not found")), false);
  assert.equal(isRetryableRestorationError(new Error("User cancelled restoration")), false);

  resetRestorationEngine();
  const engine = new RestorationEngine({
    maxRetries: 2,
    retryBackoffMs: 20,
    timeoutMs: 5000
  });

  const retryEvents = [];
  engine.on("retry", (data) => {
    retryEvents.push(data);
  });

  let attemptsExecuted = 0;
  // Fails on attempt 1, succeeds on attempt 2
  engine._executeSession = async (sess, mergedOptions) => {
    let result = null;
    let attempt = 1;
    const maxAttempts = (mergedOptions.maxRetries || 0) + 1;

    while (attempt <= maxAttempts) {
      attemptsExecuted++;
      sess.attempt = attempt;

      if (attempt === 1) {
        result = { ok: false, error: "Temporary tab script timing error" };
      } else {
        sess.complete();
        result = { ok: true, tabId: sess.tabId, stage: RestorationStage.COMPLETED };
        break;
      }

      attempt++;
      sess.isFailed = false;
      sess.error = null;
      const delay = mergedOptions.retryBackoffMs * Math.pow(1.5, attempt - 2);
      engine.emit("retry", {
        tabId: sess.tabId,
        attempt,
        maxAttempts,
        delayMs: delay,
        error: result.error
      });

      await new Promise(r => setTimeout(r, delay));
    }

    return result;
  };

  const res = await engine.restoreTab(701);
  assert.equal(res.ok, true);
  assert.equal(attemptsExecuted, 2);
  assert.equal(retryEvents.length, 1);
  assert.equal(retryEvents[0].tabId, 701);
  assert.equal(retryEvents[0].attempt, 2);

  // Test manual retryRestoration
  let manualRetried = false;
  engine.restoreTab = async (tabId, options) => {
    if (options.force) manualRetried = true;
    return { ok: true, tabId, retried: true };
  };

  const manualRes = await engine.retryRestoration(701);
  assert.equal(manualRes.ok, true);
  assert.equal(manualRetried, true);
});

test("runRestorationPipeline and RestorationEngine handle restoration failure gracefully", async () => {
  const lifecycleTracker = new LifecycleTracker();
  lifecycleTracker.transition(801, TabState.SNAPSHOTTING);
  lifecycleTracker.transition(801, TabState.DISCARDED);

  const metadataStore = new TabMetadataStore();
  metadataStore.set(801, { url: "https://example.com/broken" });

  const fakeChrome = {
    tabs: {
      get: async (id) => ({ id, url: "chrome-extension://test/suspended/suspended.html" }),
      update: async () => {
        throw new Error("Tab navigation failed: ERR_NAME_NOT_RESOLVED");
      }
    }
  };

  const session = new RestorationSession(801, { targetUrl: "https://example.com/broken" });
  const result = await runRestorationPipeline(session, {
    chromeApi: fakeChrome,
    lifecycleTracker,
    metadataStore
  });

  assert.equal(result.ok, false);
  assert.equal(result.tabId, 801);
  assert.equal(result.stage, RestorationStage.FAILED);
  assert.match(result.error, /ERR_NAME_NOT_RESOLVED/);

  // Lifecycle transition to RESTORE_FAILED
  assert.equal(lifecycleTracker.getState(801), TabState.RESTORE_FAILED);

  // Metadata store updated to failed
  const meta = metadataStore.get(801);
  assert.equal(meta.restorationStatus, "failed");

  // Verify RestorationEngine failure event and status tracking
  resetRestorationEngine();
  const engine = new RestorationEngine({ timeoutMs: 5000 }, {
    chromeApi: fakeChrome,
    lifecycleTracker,
    metadataStore
  });

  let failedEvent = null;
  engine.on("failed", (evt) => {
    failedEvent = evt;
  });

  const engineRes = await engine.restoreTab(802, { targetUrl: "https://example.com/broken" });
  assert.equal(engineRes.ok, false);
  assert.equal(failedEvent?.tabId, 802);
  assert.match(failedEvent?.error, /ERR_NAME_NOT_RESOLVED/);

  const status = engine.getStatus(802);
  assert.equal(status?.isFailed, true);
  assert.equal(status?.stage, RestorationStage.FAILED);
  assert.match(status?.error, /ERR_NAME_NOT_RESOLVED/);
});

test("RestorationEngine restore queue tracks positions, priorities, clearQueue, and events", async () => {
  resetRestorationEngine();
  const engine = new RestorationEngine({
    maxConcurrentRestorations: 1,
    timeoutMs: 5000
  });

  const queueEvents = [];
  engine.on("queued", evt => queueEvents.push({ type: "queued", ...evt }));
  engine.on("dequeued", evt => queueEvents.push({ type: "dequeued", ...evt }));
  engine.on("queue_cleared", evt => queueEvents.push({ type: "queue_cleared", ...evt }));
  engine.on("queue_drained", evt => queueEvents.push({ type: "queue_drained", ...evt }));

  let resolveActive;
  engine._executeSession = async (sess) => {
    await new Promise(r => { resolveActive = r; });
    return { ok: true, tabId: sess.tabId };
  };

  // Start tab 901 (active)
  const p1 = engine.restoreTab(901);
  assert.equal(engine.getActiveCount(), 1);
  assert.equal(engine.getQueueLength(), 0);

  // Enqueue tab 902 (normal priority, goes to end)
  const p2 = engine.restoreTab(902, { priority: "normal" });
  assert.equal(engine.getQueueLength(), 1);
  assert.equal(engine.getQueuePosition(902), 1);

  // Enqueue tab 903 (high priority, jumps to front of queue)
  const p3 = engine.restoreTab(903, { priority: "high" });
  assert.equal(engine.getQueueLength(), 2);
  assert.equal(engine.getQueuePosition(903), 1, "High priority tab should jump to position 1");
  assert.equal(engine.getQueuePosition(902), 2, "Normal priority tab should shift to position 2");

  // Inspect getQueue snapshot
  const queueSnapshot = engine.getQueue();
  assert.equal(queueSnapshot.length, 2);
  assert.equal(queueSnapshot[0].tabId, 903);
  assert.equal(queueSnapshot[0].priority, "high");
  assert.equal(queueSnapshot[1].tabId, 902);

  // Check getStatus on queued tab
  const status903 = engine.getStatus(903);
  assert.equal(status903.isQueued, true);
  assert.equal(status903.stage, RestorationStage.QUEUED);
  assert.equal(status903.queuePosition, 1);
  assert.equal(status903.queueTotal, 2);

  // Check getAllStatuses
  const allStatuses = engine.getAllStatuses();
  assert.equal(allStatuses.length, 3); // 1 active + 2 queued

  // Test clearQueue
  const evictedCount = engine.clearQueue("Manual abort");
  assert.equal(evictedCount, 2);
  assert.equal(engine.getQueueLength(), 0);
  assert.equal(engine.getQueuePosition(902), -1);

  const res2 = await p2;
  const res3 = await p3;
  assert.equal(res2.cancelled, true);
  assert.equal(res3.cancelled, true);

  // Release active tab 901
  resolveActive();
  const res1 = await p1;
  assert.equal(res1.ok, true);

  // Verify queue cleared event was recorded
  const clearedEvt = queueEvents.find(e => e.type === "queue_cleared");
  assert.ok(clearedEvt);
  assert.equal(clearedEvt.count, 2);
});

test("RestorationEngine concurrency limits, slot events, stats, and storage persistence", async () => {
  resetRestorationEngine();
  const store = {};
  const mockStorage = {
    local: {
      get: async (key) => ({ [key]: store[key] }),
      set: async (obj) => Object.assign(store, obj)
    }
  };

  const engine = new RestorationEngine({
    maxConcurrentRestorations: 2
  }, { storageApi: mockStorage });

  const slotAcquiredEvents = [];
  const slotReleasedEvents = [];
  engine.on("concurrency_slot_acquired", evt => slotAcquiredEvents.push(evt));
  engine.on("concurrency_slot_released", evt => slotReleasedEvents.push(evt));

  // Initial stats
  const initialStats = engine.getConcurrencyStats();
  assert.deepEqual(initialStats, {
    active: 0,
    queued: 0,
    maxConcurrent: 2,
    availableSlots: 2,
    isAtCapacity: false
  });

  // Test storage persistence
  await engine.saveConfiguredConcurrency(mockStorage);
  assert.equal(store["tabvault_max_concurrent_restores"], 2);

  store["tabvault_max_concurrent_restores"] = 4;
  const loaded = await engine.loadConfiguredConcurrency(mockStorage);
  assert.equal(loaded, 4);
  assert.equal(engine.getMaxConcurrentRestorations(), 4);

  // Set back to 2 for concurrency testing
  engine.setMaxConcurrentRestorations(2);

  let resolvers = {};
  engine._executeSession = (sess) => {
    return new Promise((resolve) => {
      resolvers[sess.tabId] = () => resolve({ ok: true, tabId: sess.tabId });
    });
  };

  // Launch tab 1: acquired slot 1
  const p1 = engine.restoreTab(1001);
  assert.equal(slotAcquiredEvents.length, 1);
  assert.equal(slotAcquiredEvents[0].tabId, 1001);
  assert.equal(slotAcquiredEvents[0].activeCount, 1);
  assert.equal(slotAcquiredEvents[0].availableSlots, 1);

  // Launch tab 2: acquired slot 2 (now at capacity)
  const p2 = engine.restoreTab(1002);
  assert.equal(slotAcquiredEvents.length, 2);
  assert.equal(slotAcquiredEvents[1].tabId, 1002);
  assert.equal(slotAcquiredEvents[1].activeCount, 2);
  assert.equal(slotAcquiredEvents[1].availableSlots, 0);

  // Capacity stats
  const capacityStats = engine.getConcurrencyStats();
  assert.equal(capacityStats.active, 2);
  assert.equal(capacityStats.availableSlots, 0);
  assert.equal(capacityStats.isAtCapacity, true);

  // Launch tab 3: should queue because at capacity
  const p3 = engine.restoreTab(1003);
  assert.equal(engine.getQueueLength(), 1);
  assert.equal(slotAcquiredEvents.length, 2, "Queued tab should not acquire slot yet");

  // Complete tab 1: releases slot, tab 3 automatically dequeues and acquires slot
  resolvers[1001]();
  await p1;

  assert.equal(slotReleasedEvents.length, 1);
  assert.equal(slotReleasedEvents[0].tabId, 1001);
  assert.equal(slotAcquiredEvents.length, 3, "Tab 3 should have acquired slot after tab 1 released");
  assert.equal(slotAcquiredEvents[2].tabId, 1003);

  // Complete tab 2 and tab 3
  resolvers[1002]();
  resolvers[1003]();
  await Promise.all([p2, p3]);

  assert.equal(slotReleasedEvents.length, 3);
  assert.equal(engine.getActiveCount(), 0);
  assert.equal(engine.getQueueLength(), 0);

  const finalStats = engine.getConcurrencyStats();
  assert.equal(finalStats.active, 0);
  assert.equal(finalStats.queued, 0);
  assert.equal(finalStats.availableSlots, 2);
  assert.equal(finalStats.isAtCapacity, false);
});

test("RestorationEngine prioritizes user-requested restores and promotes existing queued tabs", async () => {
  resetRestorationEngine();
  const engine = new RestorationEngine({
    maxConcurrentRestorations: 1
  });

  const priorityEvents = [];
  engine.on("priority_promoted", evt => priorityEvents.push(evt));

  const executionOrder = [];
  let finishActive;
  let activePromise = new Promise(resolve => { finishActive = resolve; });

  engine._executeSession = async (sess) => {
    executionOrder.push(sess.tabId);
    if (sess.tabId === 1) {
      await activePromise;
    }
    return { ok: true, tabId: sess.tabId };
  };

  // Tab 1 is currently restoring (active slot occupied)
  const p1 = engine.restoreTab(1);
  assert.equal(engine.getActiveCount(), 1);

  // Tab 2 arrives from background batch restore (queued at pos 1)
  const p2 = engine.restoreTab(2, { source: "batch", priority: RestorePriority.BACKGROUND });
  assert.equal(engine.getQueueLength(), 1);
  assert.equal(engine.getQueuePosition(2), 1);

  // Tab 3 arrives from background batch restore (queued at pos 2)
  const p3 = engine.restoreTab(3, { source: "batch", priority: RestorePriority.BACKGROUND });
  assert.equal(engine.getQueueLength(), 2);
  assert.equal(engine.getQueuePosition(3), 2);

  // Tab 4 arrives from direct USER interaction: should jump to the front of queue (pos 1)!
  const p4 = engine.restoreTab(4, { source: "user" });
  assert.equal(engine.getQueueLength(), 3);
  assert.equal(engine.getQueuePosition(4), 1, "User-requested tab 4 should jump ahead of background tabs");
  assert.equal(engine.getQueuePosition(2), 2);
  assert.equal(engine.getQueuePosition(3), 3);

  // User now clicks Tab 3 (which was at pos 3)!
  // Triggering restoreTab for Tab 3 with source: "user" should promote Tab 3 to pos 2 (behind Tab 4)!
  const p3Promoted = engine.restoreTab(3, { source: "user" });
  assert.equal(engine.getQueueLength(), 3, "Queue length should remain 3 without creating duplicate items");
  assert.equal(priorityEvents.length, 1);
  assert.equal(priorityEvents[0].tabId, 3);
  assert.equal(priorityEvents[0].oldPriority, RestorePriority.BACKGROUND);
  assert.equal(priorityEvents[0].newPriority, RestorePriority.USER_REQUESTED);

  // Order in queue is now:
  // Pos 1: Tab 4 (User requested earlier)
  // Pos 2: Tab 3 (User requested now, promoted to USER_REQUESTED)
  // Pos 3: Tab 2 (Background)
  assert.equal(engine.getQueuePosition(4), 1);
  assert.equal(engine.getQueuePosition(3), 2);
  assert.equal(engine.getQueuePosition(2), 3);

  // Test manual promoteQueuedRestore method on Tab 2
  const promotionRes = engine.promoteQueuedRestore(2, RestorePriority.HIGH);
  assert.equal(promotionRes.promoted, true);
  assert.equal(promotionRes.oldPriority, RestorePriority.BACKGROUND);
  assert.equal(promotionRes.newPriority, RestorePriority.HIGH);

  // Tab 2 has priority 75, so it remains behind Tab 4 and 3 (100)
  assert.equal(engine.getQueuePosition(2), 3);

  // Complete active Tab 1
  finishActive();
  await Promise.all([p1, p4, p3, p2]);

  // Execution order must be: Tab 1 (active first), Tab 4 (user first), Tab 3 (user second), Tab 2 (high third)
  assert.deepEqual(executionOrder, [1, 4, 3, 2]);
});

test("RestorationEngine cancels queued and in-flight low-priority restores when needed", async () => {
  resetRestorationEngine();
  const engine = new RestorationEngine({
    maxConcurrentRestorations: 2
  });

  const lowPriorityEvents = [];
  engine.on("low_priority_cancelled", evt => lowPriorityEvents.push(evt));

  let inFlightResolvers = {};
  engine._executeSession = (sess) => {
    return new Promise((resolve) => {
      inFlightResolvers[sess.tabId] = resolve;
      sess.abortController.signal.addEventListener("abort", () => {
        resolve({ ok: false, cancelled: true, tabId: sess.tabId, error: sess.error });
      });
    });
  };

  // Launch 2 in-flight restorations: Tab 10 (NORMAL 50), Tab 20 (BACKGROUND 10)
  const p10 = engine.restoreTab(10, { priority: RestorePriority.NORMAL });
  const p20 = engine.restoreTab(20, { priority: RestorePriority.BACKGROUND });
  assert.equal(engine.getActiveCount(), 2);

  // Queue 3 restorations: Tab 30 (HIGH 75), Tab 40 (LOW 25), Tab 50 (BACKGROUND 10)
  const p30 = engine.restoreTab(30, { priority: RestorePriority.HIGH });
  const p40 = engine.restoreTab(40, { priority: RestorePriority.LOW });
  const p50 = engine.restoreTab(50, { priority: RestorePriority.BACKGROUND });
  assert.equal(engine.getQueueLength(), 3);

  // Cancel queued low-priority restores (<= LOW)
  const queuedCancelled = engine.cancelQueuedByPriority(RestorePriority.LOW, "Memory pressure mitigation");
  assert.equal(queuedCancelled.length, 2);
  assert.equal(engine.getQueueLength(), 1);
  assert.equal(engine.isQueued(30), true, "Tab 30 (HIGH) should remain queued");
  assert.equal(engine.isQueued(40), false);
  assert.equal(engine.isQueued(50), false);

  const res40 = await p40;
  const res50 = await p50;
  assert.equal(res40.cancelled, true);
  assert.equal(res50.cancelled, true);

  // Cancel in-flight low-priority restores (<= LOW)
  const inFlightCancelled = engine.cancelInFlightByPriority(RestorePriority.LOW, "Abort low priority in flight");
  assert.deepEqual(inFlightCancelled, [20]);

  const res20 = await p20;
  assert.equal(res20.cancelled, true);

  // Tab 10 (NORMAL) should still be active
  assert.equal(engine.isRestoring(10), true);

  // Complete Tab 10
  inFlightResolvers[10]({ ok: true, tabId: 10 });
  await p10;

  // Now Tab 30 should have drained from queue into active
  inFlightResolvers[30]({ ok: true, tabId: 30 });
  await p30;
  assert.equal(engine.getActiveCount(), 0);
  assert.equal(engine.getQueueLength(), 0);
});

test("RestorationEngine preempts low-priority in-flight restore when user requests restore", async () => {
  resetRestorationEngine();
  const engine = new RestorationEngine({
    maxConcurrentRestorations: 1,
    preemptLowPriorityOnUserRestore: true
  });

  const preemptedEvents = [];
  engine.on("preempted", evt => preemptedEvents.push(evt));

  let inFlightResolvers = {};
  engine._executeSession = (sess) => {
    return new Promise((resolve) => {
      inFlightResolvers[sess.tabId] = resolve;
      sess.abortController.signal.addEventListener("abort", () => {
        resolve({ ok: false, cancelled: true, tabId: sess.tabId, error: sess.error });
      });
    });
  };

  // Tab 1 is running as BACKGROUND restore (10)
  const p1 = engine.restoreTab(1, { priority: RestorePriority.BACKGROUND });
  assert.equal(engine.getActiveCount(), 1);

  // User explicitly restores Tab 2 with source: "user"
  const p2 = engine.restoreTab(2, { source: "user" });

  // Tab 1 should have been preempted!
  assert.equal(preemptedEvents.length, 1);
  assert.equal(preemptedEvents[0].preemptedTabId, 1);
  assert.equal(preemptedEvents[0].byTabId, 2);

  const res1 = await p1;
  assert.equal(res1.cancelled, true);

  // Complete Tab 2
  inFlightResolvers[2]({ ok: true, tabId: 2 });
  const res2 = await p2;
  assert.equal(res2.ok, true);
});

test("isTabBackground and shouldDeferBackgroundRestoration evaluate deferral conditions accurately", () => {
  assert.equal(isTabBackground({ active: false }), true);
  assert.equal(isTabBackground({ active: true }), false);
  assert.equal(isTabBackground(null), false);
  assert.equal(isTabBackground(undefined), false);
  assert.equal(isTabBackground({}), false);

  // Defaults: when lazy is not requested, do not defer
  assert.equal(shouldDeferBackgroundRestoration({ active: false }, {}), false);

  // When lazy is requested via options.lazy: true
  assert.equal(shouldDeferBackgroundRestoration({ active: false }, { lazy: true }), true);
  assert.equal(shouldDeferBackgroundRestoration({ active: true }, { lazy: true }), false);

  // When lazy is requested via options.lazyRestoreBackgroundTabs: true
  assert.equal(shouldDeferBackgroundRestoration({ active: false }, { lazyRestoreBackgroundTabs: true }), true);

  // When lazy is enabled in context options
  assert.equal(shouldDeferBackgroundRestoration({ active: false }, {}, { options: { lazyRestoreBackgroundTabs: true } }), true);

  // When tab is explicit background via isBackground option
  assert.equal(shouldDeferBackgroundRestoration(10, { isBackground: true, lazy: true }), true);
  assert.equal(shouldDeferBackgroundRestoration(10, { isBackground: false, lazy: true }), false);

  // Overrides: force, allowBackground, lazy: false
  assert.equal(shouldDeferBackgroundRestoration({ active: false }, { lazy: true, force: true }), false);
  assert.equal(shouldDeferBackgroundRestoration({ active: false }, { lazy: true, allowBackground: true }), false);
  assert.equal(shouldDeferBackgroundRestoration({ active: false }, { lazy: false }, { options: { lazyRestoreBackgroundTabs: true } }), false);

  // Active user requested restore on non-background tab should not defer
  assert.equal(shouldDeferBackgroundRestoration({ active: true }, { source: "user", lazy: true }), false);
});

test("lazy background restore settings and storage persistence", async () => {
  const mockStorage = {
    _data: {},
    get: async (key) => ({ [key]: mockStorage._data[key] }),
    set: async (obj) => Object.assign(mockStorage._data, obj)
  };

  assert.equal(await loadLazyRestoreBackgroundSetting(mockStorage), DEFAULT_LAZY_RESTORE_BACKGROUND);

  await saveLazyRestoreBackgroundSetting(false, mockStorage);
  assert.equal(mockStorage._data[STORAGE_KEY_LAZY_RESTORE_BACKGROUND], false);
  assert.equal(await loadLazyRestoreBackgroundSetting(mockStorage), false);

  const engine = new RestorationEngine();
  const settingEvents = [];
  engine.on("lazy_restore_setting_changed", evt => settingEvents.push(evt));

  engine.setLazyRestoreBackgroundTabs(true);
  assert.equal(engine.getLazyRestoreBackgroundTabs(), true);
  assert.equal(settingEvents.length, 1);
  assert.equal(settingEvents[0].lazyRestoreBackgroundTabs, true);

  await engine.saveConfiguredLazyRestore(mockStorage);
  assert.equal(mockStorage._data[STORAGE_KEY_LAZY_RESTORE_BACKGROUND], true);

  mockStorage._data[STORAGE_KEY_LAZY_RESTORE_BACKGROUND] = false;
  const loaded = await engine.loadConfiguredLazyRestore(mockStorage);
  assert.equal(loaded, false);
  assert.equal(engine.getLazyRestoreBackgroundTabs(), false);
});

test("RestorationEngine deferred restoration registry, status reporting, and lifecycle", async () => {
  resetRestorationEngine();
  const engine = new RestorationEngine({ maxConcurrentRestorations: 2 });

  const deferredEvents = [];
  const cancelledEvents = [];
  engine.on("deferred", evt => deferredEvents.push(evt));
  engine.on("deferred_cancelled", evt => cancelledEvents.push(evt));

  // Defer restoration for Tab 100
  const deferRes = engine.deferRestoration(100, {
    targetUrl: "https://example.com/lazy1",
    title: "Lazy Page 1",
    source: "batch_test"
  });

  assert.equal(deferRes.ok, true);
  assert.equal(deferRes.deferred, true);
  assert.equal(deferRes.tabId, 100);
  assert.equal(deferRes.stage, RestorationStage.DEFERRED);
  assert.equal(getStageLabel(RestorationStage.DEFERRED), "Deferred");
  assert.ok(getStageDescription(RestorationStage.DEFERRED).includes("deferred"));

  assert.equal(engine.isDeferred(100), true);
  assert.equal(engine.isDeferred(999), false);
  assert.equal(engine.getDeferredCount(), 1);

  const deferredTabs = engine.getDeferredTabs();
  assert.equal(deferredTabs.length, 1);
  assert.equal(deferredTabs[0].tabId, 100);
  assert.equal(deferredTabs[0].targetUrl, "https://example.com/lazy1");

  // Status check for deferred tab
  const status = engine.getStatus(100);
  assert.equal(status.tabId, 100);
  assert.equal(status.stage, RestorationStage.DEFERRED);
  assert.equal(status.isDeferred, true);
  assert.equal(status.isQueued, false);
  assert.equal(status.isComplete, false);

  const allStatuses = engine.getAllStatuses();
  assert.equal(allStatuses.some(s => s.tabId === 100 && s.isDeferred), true);

  // Concurrency stats with includeDeferred
  const stats = engine.getConcurrencyStats({ includeDeferred: true });
  assert.equal(stats.active, 0);
  assert.equal(stats.queued, 0);
  assert.equal(stats.deferred, 1);

  // Defer Tab 101, then cancel it
  engine.deferRestoration(101, { targetUrl: "https://example.com/lazy2" });
  assert.equal(engine.getDeferredCount(), 2);
  assert.equal(engine.cancelDeferred(101, "Tab closed"), true);
  assert.equal(engine.isDeferred(101), false);
  assert.equal(engine.getDeferredCount(), 1);
  assert.equal(cancelledEvents.length, 1);
  assert.equal(cancelledEvents[0].tabId, 101);

  // cancelRestoration also cancels deferred tab
  assert.equal(engine.cancelRestoration(100, "User dismissed"), true);
  assert.equal(engine.isDeferred(100), false);
  assert.equal(engine.getDeferredCount(), 0);

  // Clear all deferred
  engine.deferRestoration(102);
  engine.deferRestoration(103);
  assert.equal(engine.getDeferredCount(), 2);
  assert.equal(engine.clearDeferred("Reset all"), 2);
  assert.equal(engine.getDeferredCount(), 0);
});

test("restoreTab automatically defers background tabs avoiding unnecessary loading", async () => {
  resetRestorationEngine();
  const engine = new RestorationEngine({
    maxConcurrentRestorations: 2,
    lazyRestoreBackgroundTabs: true
  });

  let sessionExecutedCount = 0;
  engine._executeSession = async (sess) => {
    sessionExecutedCount++;
    return { ok: true, tabId: sess.tabId };
  };

  // 1. Attempt to restore background tab with lazy: true
  const res1 = await engine.restoreTab(501, {
    isBackground: true,
    targetUrl: "https://example.com/bg1"
  });

  assert.equal(res1.deferred, true);
  assert.equal(res1.stage, RestorationStage.DEFERRED);
  assert.equal(sessionExecutedCount, 0, "No background session should have executed");
  assert.equal(engine.getActiveCount(), 0);
  assert.equal(engine.getQueueLength(), 0);
  assert.equal(engine.isDeferred(501), true);

  // Duplicate restoreTab call on same deferred tab should not re-run
  const resDuplicate = await engine.restoreTab(501, { isBackground: true });
  assert.equal(resDuplicate.deferred, true);
  assert.equal(sessionExecutedCount, 0);

  // 2. Tab is now focused by user: triggerDeferred runs immediate restore
  const triggerRes = await engine.triggerDeferred(501);
  assert.equal(triggerRes.ok, true);
  assert.equal(sessionExecutedCount, 1, "Execution should run upon user focus");
  assert.equal(engine.isDeferred(501), false);

  // 3. Explicit active tab or force: true restores immediately without deferral
  const resActive = await engine.restoreTab(502, {
    isBackground: false,
    targetUrl: "https://example.com/active"
  });
  assert.equal(resActive.ok, true);
  assert.equal(sessionExecutedCount, 2);

  const resForced = await engine.restoreTab(503, {
    isBackground: true,
    force: true,
    targetUrl: "https://example.com/forced"
  });
  assert.equal(resForced.ok, true);
  assert.equal(sessionExecutedCount, 3);
});

test("batch tab restoration defers multiple background tabs while running active tab immediately", async () => {
  resetRestorationEngine();
  const engine = new RestorationEngine({
    maxConcurrentRestorations: 2
  });

  const executedTabs = [];
  engine._executeSession = async (sess) => {
    executedTabs.push(sess.tabId);
    return { ok: true, tabId: sess.tabId };
  };

  // Simulate 1 active tab and 4 background tabs in a window restore scenario
  const tabsToRestore = [
    { id: 1, active: true },
    { id: 2, active: false },
    { id: 3, active: false },
    { id: 4, active: false },
    { id: 5, active: false }
  ];

  const results = await Promise.all(
    tabsToRestore.map(t => {
      if (t.active) {
        return engine.restoreTab(t.id, {
          source: "user",
          priority: RestorePriority.USER_REQUESTED,
          isBackground: false,
          force: true
        });
      }
      return engine.restoreTab(t.id, {
        source: "batch",
        priority: RestorePriority.BACKGROUND,
        isBackground: true,
        lazy: true
      });
    })
  );

  // Only Tab 1 executed! Tabs 2, 3, 4, 5 were all deferred!
  assert.deepEqual(executedTabs, [1]);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].deferred, undefined);
  assert.equal(results[1].deferred, true);
  assert.equal(results[2].deferred, true);
  assert.equal(results[3].deferred, true);
  assert.equal(results[4].deferred, true);

  assert.equal(engine.getDeferredCount(), 4);
  assert.equal(engine.getActiveCount(), 0);
  assert.equal(engine.getQueueLength(), 0);

  // User later clicks on Tab 3 -> restore triggers on demand!
  const tab3Result = await engine.restoreTab(3, { source: "user" });
  assert.equal(tab3Result.ok, true);
  assert.deepEqual(executedTabs, [1, 3]);
  assert.equal(engine.isDeferred(3), false);
  assert.equal(engine.getDeferredCount(), 3);
});

test("calculateRetryBackoff computes exponential delays and honors maxDelayMs ceiling", async () => {
  const { calculateRetryBackoff } = await import("../lib/restore-engine.js");

  assert.equal(calculateRetryBackoff(0, 500, 1.5, 10000), 500);
  assert.equal(calculateRetryBackoff(1, 500, 1.5, 10000), 750);
  assert.equal(calculateRetryBackoff(2, 500, 1.5, 10000), 1125);
  assert.equal(calculateRetryBackoff(3, 500, 1.5, 10000), 1688);
  assert.equal(calculateRetryBackoff(10, 500, 1.5, 5000), 5000); // capped at ceiling
  assert.equal(calculateRetryBackoff(-1, 500), 500); // clamped
});

test("isRetryableRestorationError categorizes retryable vs non-retryable errors correctly", async () => {
  const { isRetryableRestorationError } = await import("../lib/restore-engine.js");

  // Retryable
  assert.equal(isRetryableRestorationError(new Error("Restoration timed out after 15000ms")), true);
  assert.equal(isRetryableRestorationError(new Error("net::ERR_CONNECTION_RESET")), true);
  assert.equal(isRetryableRestorationError("Script injection failed"), true);
  assert.equal(isRetryableRestorationError(new Error("Layout readiness check failed")), true);

  // Non-retryable
  assert.equal(isRetryableRestorationError(null), false);
  assert.equal(isRetryableRestorationError(undefined), false);
  assert.equal(isRetryableRestorationError(new Error("User cancelled restoration")), false);
  assert.equal(isRetryableRestorationError(new Error("Restoration aborted")), false);
  assert.equal(isRetryableRestorationError(new Error("Tab 404 not found")), false);
  assert.equal(isRetryableRestorationError(new Error("Tab closed")), false);
  assert.equal(isRetryableRestorationError(new Error("Invalid restoration URL")), false);
  assert.equal(isRetryableRestorationError(new Error("Cannot access a chrome:// URL")), false);
  assert.equal(isRetryableRestorationError(new Error("Permission denied to target page")), false);
});

test("RestorationEngine tracks failed restorations, allows queries and clearances", async () => {
  const { RestorationEngine, resetRestorationEngine } = await import("../lib/restore-engine.js");

  resetRestorationEngine();
  const engine = new RestorationEngine({ timeoutMs: 5000 });

  // Simulate failed execution for tab 901
  engine._executeSession = async (sess, mergedOptions) => {
    sess.fail(new Error("Network connection dropped"));
    return { ok: false, tabId: sess.tabId, error: "Network connection dropped" };
  };

  assert.equal(engine.getFailedCount(), 0);
  assert.deepEqual(engine.getFailedRestorations(), []);

  let failedEventReceived = null;
  engine.on("failed", (evt) => {
    failedEventReceived = evt;
  });

  const res = await engine.restoreTab(901, { targetUrl: "https://example.com/fail" });
  assert.equal(res.ok, false);
  assert.equal(engine.getFailedCount(), 1);

  const failedRec = engine.getFailedRestoration(901);
  assert.ok(failedRec);
  assert.equal(failedRec.tabId, 901);
  assert.equal(failedRec.error, "Network connection dropped");
  assert.equal(failedRec.isRetryable, true);
  assert.equal(failedRec.targetUrl, "https://example.com/fail");
  assert.equal(failedRec.retryCount, 1);

  assert.ok(failedEventReceived);
  assert.equal(failedEventReceived.tabId, 901);
  assert.equal(failedEventReceived.failureRecord?.tabId, 901);

  // Check getStatus includes retry flags
  const status = engine.getStatus(901);
  assert.ok(status);
  assert.equal(status.isFailed, true);
  assert.equal(status.canRetry, true);

  // Check getConcurrencyStats({ includeFailed: true })
  const stats = engine.getConcurrencyStats({ includeFailed: true });
  assert.equal(stats.failed, 1);

  // Clear single failed
  const clearedSingle = engine.clearFailedRestoration(901);
  assert.equal(clearedSingle, true);
  assert.equal(engine.getFailedCount(), 0);
  assert.equal(engine.getFailedRestoration(901), null);

  // Fail another tab 902 and test clearFailedRestorations
  await engine.restoreTab(902);
  assert.equal(engine.getFailedCount(), 1);
  const clearedAll = engine.clearFailedRestorations();
  assert.equal(clearedAll, 1);
  assert.equal(engine.getFailedCount(), 0);
});

test("RestorationEngine retryRestoration supports options, fallback navigation, and clears failure on success", async () => {
  const { RestorationEngine, resetRestorationEngine, RestorePriority } = await import("../lib/restore-engine.js");

  resetRestorationEngine();
  const engine = new RestorationEngine({ timeoutMs: 5000 });

  let attemptCount = 0;
  let receivedOptions = null;
  engine._executeSession = async (sess, mergedOptions) => {
    attemptCount++;
    receivedOptions = mergedOptions;
    if (attemptCount === 1) {
      sess.fail(new Error("Heavy script injection error"));
      return { ok: false, tabId: sess.tabId, error: "Heavy script injection error" };
    }
    sess.complete();
    return { ok: true, tabId: sess.tabId };
  };

  // Initial attempt fails
  await engine.restoreTab(910, { restoreScroll: true, restoreForms: true });
  assert.equal(engine.getFailedCount(), 1);

  // Retry with fallback (disables heavy scripts)
  let retryInitiatedEvent = null;
  engine.on("retry_initiated", (evt) => {
    retryInitiatedEvent = evt;
  });

  const retryRes = await engine.retryRestoration(910, { fallback: true });
  assert.equal(retryRes.ok, true);
  assert.equal(attemptCount, 2);

  // Verifying fallback options were applied
  assert.equal(receivedOptions.restoreScroll, false);
  assert.equal(receivedOptions.restoreForms, false);
  assert.equal(receivedOptions.applyAdapters, false);
  assert.equal(receivedOptions.force, true);
  assert.equal(receivedOptions.priority, RestorePriority.USER_REQUESTED);

  // Event received
  assert.ok(retryInitiatedEvent);
  assert.equal(retryInitiatedEvent.tabId, 910);

  // Failure record removed upon success
  assert.equal(engine.getFailedCount(), 0);
  assert.equal(engine.getFailedRestoration(910), null);
});

test("RestorationEngine retryAllFailed batch-retries multiple failed tabs", async () => {
  const { RestorationEngine, resetRestorationEngine } = await import("../lib/restore-engine.js");

  resetRestorationEngine();
  const engine = new RestorationEngine({ timeoutMs: 5000 });

  // Pre-populate 3 failed tabs
  engine.failedRestorations.set(921, { tabId: 921, error: "Err 1" });
  engine.failedRestorations.set(922, { tabId: 922, error: "Err 2" });
  engine.failedRestorations.set(923, { tabId: 923, error: "Err 3" });
  assert.equal(engine.getFailedCount(), 3);

  const retriedTabs = [];
  engine.retryRestoration = async (tabId, opts) => {
    retriedTabs.push(tabId);
    if (tabId === 923) {
      return { ok: false, error: "Persistent server 500" };
    }
    engine.failedRestorations.delete(tabId);
    return { ok: true, tabId };
  };

  const batchSummary = await engine.retryAllFailed({ fallback: true });
  assert.equal(batchSummary.total, 3);
  assert.equal(batchSummary.retried, 3);
  assert.deepEqual(retriedTabs, [921, 922, 923]);
  assert.equal(batchSummary.results[0].ok, true);
  assert.equal(batchSummary.results[1].ok, true);
  assert.equal(batchSummary.results[2].ok, false);

  // 923 remains in failedRestorations
  assert.equal(engine.getFailedCount(), 1);
  assert.ok(engine.getFailedRestoration(923));
});



