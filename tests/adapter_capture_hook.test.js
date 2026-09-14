import test from "node:test";
import assert from "node:assert/strict";

import { BaseSiteAdapter } from "../lib/adapters/base.js";
import { AdapterRegistry } from "../lib/adapters/registry.js";
import {
  MAX_ADAPTER_STATE_SIZE,
  sanitizeAdapterState,
  executeAdapterCapture,
  captureSiteAdapterState
} from "../lib/adapters/capture.js";
import {
  createTabSnapshot,
  createRestorationPlan,
  validateSnapshotSchema,
  migrateSnapshot,
  repairCorruptedSnapshot
} from "../lib/snapshot.js";

test("sanitizeAdapterState handles null, primitives, truncation, and valid objects", () => {
  assert.equal(sanitizeAdapterState(null), null);
  assert.equal(sanitizeAdapterState(undefined), null);
  assert.equal(sanitizeAdapterState("invalid string"), null);
  assert.equal(sanitizeAdapterState(12345), null);
  assert.equal(sanitizeAdapterState([1, 2, 3]), null);

  // Valid object
  const valid = { currentTime: 142.5, videoId: "abc1234" };
  const sanitized = sanitizeAdapterState(valid);
  assert.deepEqual(sanitized, valid);

  // Truncation on size limit
  const hugePayload = {
    adapterId: "heavy-adapter",
    bloat: "x".repeat(MAX_ADAPTER_STATE_SIZE + 100)
  };
  const truncated = sanitizeAdapterState(hugePayload);
  assert.equal(truncated.truncated, true);
  assert.ok(truncated.error.includes("exceeded maximum size limit"));
});

test("executeAdapterCapture validates adapter contract and captures state successfully", async () => {
  // 1. Invalid adapter object
  const invalidResult = await executeAdapterCapture(null, 10);
  assert.equal(invalidResult.ok, false);
  assert.equal(invalidResult.state, null);
  assert.ok(invalidResult.error.includes("Invalid adapter"));

  // 2. Standard adapter with valid capture
  class MockYouTubeAdapter extends BaseSiteAdapter {
    constructor() {
      super({
        id: "youtube",
        name: "YouTube",
        domainPatterns: ["*://*.youtube.com/*"]
      });
    }

    async capture(tabId, context) {
      return {
        videoId: "dQw4w9WgXcQ",
        currentTime: 42.5,
        isPaused: false
      };
    }

    formatSummary(state) {
      return state ? `Playback at ${state.currentTime}s` : "No video";
    }
  }

  const adapter = new MockYouTubeAdapter();
  const res = await executeAdapterCapture(adapter, 101, { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });

  assert.equal(res.ok, true);
  assert.equal(res.adapterId, "youtube");
  assert.equal(res.state.videoId, "dQw4w9WgXcQ");
  assert.equal(res.state.currentTime, 42.5);
  assert.equal(res.summary, "Playback at 42.5s");
  assert.ok(typeof res.capturedAt === "number");
});

test("executeAdapterCapture handles null/empty capture gracefully", async () => {
  class EmptyAdapter extends BaseSiteAdapter {
    constructor() {
      super({ id: "empty", name: "Empty", domainPatterns: ["*://example.com/*"] });
    }
    async capture() {
      return null;
    }
  }

  const adapter = new EmptyAdapter();
  const res = await executeAdapterCapture(adapter, 102);
  assert.equal(res.ok, true);
  assert.equal(res.adapterId, "empty");
  assert.equal(res.state, null);
  assert.equal(res.summary, "No state captured");
});

test("executeAdapterCapture isolates adapter errors and validates state", async () => {
  // Adapter that throws during capture
  class CrashingAdapter extends BaseSiteAdapter {
    constructor() {
      super({ id: "crasher", name: "Crasher", domainPatterns: ["*://crash.com/*"] });
    }
    async capture() {
      throw new Error("DOM access restricted in frame");
    }
  }

  const adapter = new CrashingAdapter();
  const res = await executeAdapterCapture(adapter, 103);
  assert.equal(res.ok, false);
  assert.equal(res.adapterId, "crasher");
  assert.equal(res.state, null);
  assert.ok(res.error.includes("DOM access restricted in frame"));

  // Adapter that returns invalid state failing validateState
  class StrictAdapter extends BaseSiteAdapter {
    constructor() {
      super({ id: "strict", name: "Strict", domainPatterns: ["*://strict.com/*"] });
    }
    async capture() {
      return { timestamp: "not-a-number" };
    }
    validateState(state) {
      return typeof state?.timestamp === "number";
    }
  }

  const strictAdapter = new StrictAdapter();
  const strictRes = await executeAdapterCapture(strictAdapter, 104);
  assert.equal(strictRes.ok, false);
  assert.equal(strictRes.state, null);
  assert.ok(strictRes.error.includes("validation failed"));
});

test("executeAdapterCapture enforces execution timeout", async () => {
  class HangingAdapter extends BaseSiteAdapter {
    constructor() {
      super({
        id: "hanging",
        name: "Hanging",
        domainPatterns: ["*://hang.com/*"],
        timeoutMs: 50 // Short timeout for test speed
      });
    }
    async capture() {
      await new Promise(resolve => setTimeout(resolve, 200));
      return { foo: "bar" };
    }
  }

  const adapter = new HangingAdapter();
  const res = await executeAdapterCapture(adapter, 105);

  assert.equal(res.ok, false);
  assert.equal(res.timedOut, true);
  assert.equal(res.adapterId, "hanging");
  assert.ok(res.error.includes("timed out"));
});

test("captureSiteAdapterState and AdapterRegistry.captureForUrl match and execute capture", async () => {
  const registry = new AdapterRegistry();

  class MockDocsAdapter extends BaseSiteAdapter {
    constructor() {
      super({
        id: "gdocs",
        name: "Google Docs",
        domainPatterns: ["*://docs.google.com/document/*"]
      });
    }
    async capture(tabId, context) {
      return { headingId: "heading.123", mode: "editing" };
    }
  }

  registry.register(new MockDocsAdapter());

  // Non-matching URL
  const unmatched = await captureSiteAdapterState("https://github.com/facebook/react", 201, { adapterRegistry: registry });
  assert.equal(unmatched.matched, false);
  assert.equal(unmatched.ok, true);
  assert.equal(unmatched.state, null);

  // Matching URL
  const matched = await captureSiteAdapterState("https://docs.google.com/document/d/abcdef/edit", 201, { adapterRegistry: registry });
  assert.equal(matched.matched, true);
  assert.equal(matched.ok, true);
  assert.equal(matched.adapterId, "gdocs");
  assert.equal(matched.state.headingId, "heading.123");

  // Registry instance captureForUrl method
  const viaMethod = await registry.captureForUrl("https://docs.google.com/document/d/abcdef/edit", 202);
  assert.equal(viaMethod.matched, true);
  assert.equal(viaMethod.ok, true);
  assert.equal(viaMethod.adapterId, "gdocs");
});

test("createTabSnapshot and createRestorationPlan integrate adapter state seamlessly", () => {
  const adapterPayload = {
    adapterId: "youtube",
    version: 1,
    capturedAt: 1700000000000,
    state: { currentTime: 180, videoId: "xyz" },
    summary: "Playback at 180s"
  };

  const snapshot = createTabSnapshot(
    { id: 301, url: "https://www.youtube.com/watch?v=xyz", title: "Video" },
    { adapter: adapterPayload }
  );

  assert.ok(snapshot.adapter);
  assert.equal(snapshot.adapter.adapterId, "youtube");
  assert.equal(snapshot.adapter.state.currentTime, 180);

  const schemaValidation = validateSnapshotSchema(snapshot);
  assert.equal(schemaValidation.valid, true);

  const plan = createRestorationPlan(snapshot);
  assert.ok(plan.adapter);
  assert.equal(plan.adapter.adapterId, "youtube");
  assert.equal(plan.adapter.state.currentTime, 180);

  // Migration and repair preservation
  const migrated = migrateSnapshot(snapshot);
  assert.equal(migrated.adapter.adapterId, "youtube");

  const repaired = repairCorruptedSnapshot(snapshot);
  assert.equal(repaired.adapter.adapterId, "youtube");
});
