import test from "node:test";
import assert from "node:assert/strict";

import { BaseSiteAdapter, AdapterTimeoutError } from "../lib/adapters/base.js";
import {
  DEFAULT_ADAPTER_TIMEOUT_MS,
  MIN_ADAPTER_TIMEOUT_MS,
  MAX_ADAPTER_TIMEOUT_MS,
  normalizeAdapterTimeout,
  withAdapterTimeout
} from "../lib/adapters/timeout.js";
import { executeAdapterCapture } from "../lib/adapters/capture.js";
import { executeAdapterRestore } from "../lib/adapters/restore.js";
import { RestorationSession, RestorationStage, runRestorationPipeline } from "../lib/restore-engine.js";

test("normalizeAdapterTimeout validates and clamps timeouts within bounds", () => {
  assert.equal(normalizeAdapterTimeout(null), DEFAULT_ADAPTER_TIMEOUT_MS);
  assert.equal(normalizeAdapterTimeout(undefined), DEFAULT_ADAPTER_TIMEOUT_MS);
  assert.equal(normalizeAdapterTimeout("3000"), DEFAULT_ADAPTER_TIMEOUT_MS);
  assert.equal(normalizeAdapterTimeout(0), DEFAULT_ADAPTER_TIMEOUT_MS);
  assert.equal(normalizeAdapterTimeout(-500), DEFAULT_ADAPTER_TIMEOUT_MS);
  assert.equal(normalizeAdapterTimeout(NaN), DEFAULT_ADAPTER_TIMEOUT_MS);

  // Clamping below min
  assert.equal(normalizeAdapterTimeout(10), MIN_ADAPTER_TIMEOUT_MS);
  assert.equal(normalizeAdapterTimeout(MIN_ADAPTER_TIMEOUT_MS), MIN_ADAPTER_TIMEOUT_MS);

  // Clamping above max
  assert.equal(normalizeAdapterTimeout(60000), MAX_ADAPTER_TIMEOUT_MS);
  assert.equal(normalizeAdapterTimeout(MAX_ADAPTER_TIMEOUT_MS), MAX_ADAPTER_TIMEOUT_MS);

  // Valid values
  assert.equal(normalizeAdapterTimeout(1500), 1500);
  assert.equal(normalizeAdapterTimeout(4999.8), 4999);
});

test("withAdapterTimeout resolves fast actions without timeout", async () => {
  const result = await withAdapterTimeout(async () => {
    return { success: true, count: 42 };
  }, { adapterId: "fast", timeoutMs: 500 });

  assert.deepEqual(result, { success: true, count: 42 });

  // Direct promise
  const directPromise = Promise.resolve("direct");
  const directResult = await withAdapterTimeout(directPromise, { timeoutMs: 500 });
  assert.equal(directResult, "direct");
});

test("withAdapterTimeout throws AdapterTimeoutError when action hangs", async () => {
  const hangingPromise = new Promise(resolve => setTimeout(resolve, 200));

  await assert.rejects(
    () => withAdapterTimeout(hangingPromise, {
      adapterId: "slow-adapter",
      stage: "capture",
      timeoutMs: 50
    }),
    (err) => {
      assert.ok(err instanceof AdapterTimeoutError);
      assert.equal(err.name, "AdapterTimeoutError");
      assert.equal(err.adapterId, "slow-adapter");
      assert.equal(err.stage, "capture");
      assert.equal(err.timeoutMs, 50);
      assert.ok(err.message.includes("Execution timed out after 50ms"));
      return true;
    }
  );
});

test("withAdapterTimeout respects AbortSignal cancellation", async () => {
  // Pre-aborted signal
  const preController = new AbortController();
  preController.abort(new Error("Pre-aborted"));

  await assert.rejects(
    () => withAdapterTimeout(async () => "ok", {
      adapterId: "abort-adapter",
      signal: preController.signal,
      timeoutMs: 500
    }),
    /Pre-aborted/
  );

  // In-flight abort
  const controller = new AbortController();
  const slowAction = new Promise(resolve => setTimeout(resolve, 500));

  setTimeout(() => {
    controller.abort(new Error("In-flight cancel"));
  }, 30);

  await assert.rejects(
    () => withAdapterTimeout(slowAction, {
      adapterId: "in-flight-adapter",
      signal: controller.signal,
      timeoutMs: 1000
    }),
    /In-flight cancel/
  );
});

test("capture and restore hooks apply custom adapter timeout overrides", async () => {
  class SlowCaptureAdapter extends BaseSiteAdapter {
    constructor() {
      super({
        id: "slow-cap",
        name: "Slow Capture",
        timeoutMs: 50
      });
    }
    async capture() {
      await new Promise(r => setTimeout(r, 150));
      return { data: 123 };
    }
  }

  const capAdapter = new SlowCaptureAdapter();

  // 1. Adapter's default 50ms timeout triggers
  const capRes1 = await executeAdapterCapture(capAdapter, 101);
  assert.equal(capRes1.ok, false);
  assert.equal(capRes1.timedOut, true);
  assert.ok(capRes1.error.includes("timed out after 50ms"));

  // 2. Override with larger timeout allows completion
  const capRes2 = await executeAdapterCapture(capAdapter, 101, { timeoutMs: 250 });
  assert.equal(capRes2.ok, true);
  assert.equal(capRes2.state.data, 123);

  // Restore hook timeout override
  class SlowRestoreAdapter extends BaseSiteAdapter {
    constructor() {
      super({
        id: "slow-res",
        name: "Slow Restore",
        timeoutMs: 50
      });
    }
    async restore() {
      await new Promise(r => setTimeout(r, 150));
      return true;
    }
  }

  const resAdapter = new SlowRestoreAdapter();

  // 1. Default timeout triggers
  const res1 = await executeAdapterRestore(resAdapter, 102);
  assert.equal(res1.ok, false);
  assert.equal(res1.timedOut, true);
  assert.ok(res1.error.includes("Adapter timed out after 50ms"));

  // 2. Override timeout allows completion
  const res2 = await executeAdapterRestore(resAdapter, 102, {}, { timeoutMs: 250 });
  assert.equal(res2.ok, true);
  assert.equal(res2.restored, true);
});

test("restoration pipeline isolates adapter timeouts without failing whole tab restore", async () => {
  class FreezingAdapter extends BaseSiteAdapter {
    constructor() {
      super({
        id: "freezer",
        name: "Freezer",
        domainPatterns: ["*://freeze.com/*"],
        timeoutMs: 50
      });
    }
    async restore() {
      await new Promise(r => setTimeout(r, 300));
      return true;
    }
  }

  const fakeRegistry = {
    findMatchingAdapter: () => new FreezingAdapter()
  };

  const fakeChrome = {
    tabs: {
      get: async (id) => ({ id, url: "https://freeze.com/dashboard" }),
      update: async () => ({})
    }
  };

  const session = new RestorationSession(701, {
    targetUrl: "https://freeze.com/dashboard",
    adapterTimeoutMs: 50
  });

  const res = await runRestorationPipeline(session, {
    chromeApi: fakeChrome,
    adapterRegistry: fakeRegistry
  });

  // Entire restoration must succeed
  assert.equal(res.ok, true);
  assert.equal(session.stage, RestorationStage.COMPLETED);

  // History must log the isolated adapter timeout
  const timeoutEntry = session.history.find(h =>
    typeof h.detail === "string" && h.detail.includes("Adapter timed out")
  );
  assert.ok(timeoutEntry, "History must contain isolated adapter timeout event");
});
