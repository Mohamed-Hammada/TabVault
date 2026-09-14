import test from "node:test";
import assert from "node:assert/strict";
import {
  BaseSiteAdapter,
  isSiteAdapter,
  assertValidAdapter,
  AdapterExecutionError,
  AdapterTimeoutError
} from "../lib/adapters/base.js";

test("BaseSiteAdapter enforces valid constructor arguments and assigns default properties", () => {
  // Invalid constructors throw
  assert.throws(() => new BaseSiteAdapter(), /requires a non-empty string 'id'/);
  assert.throws(() => new BaseSiteAdapter({ id: "" }), /requires a non-empty string 'id'/);
  assert.throws(() => new BaseSiteAdapter({ id: "test" }), /requires a non-empty string 'name'/);
  assert.throws(() => new BaseSiteAdapter({ id: "test", name: "" }), /requires a non-empty string 'name'/);

  // Valid instantiation with defaults
  const adapter = new BaseSiteAdapter({
    id: "CustomSite",
    name: "Custom Site Adapter"
  });

  assert.equal(adapter.id, "customsite");
  assert.equal(adapter.name, "Custom Site Adapter");
  assert.equal(adapter.description, "State adapter for Custom Site Adapter");
  assert.deepEqual(adapter.domainPatterns, []);
  assert.equal(adapter.priority, 100);
  assert.equal(adapter.timeoutMs, 3000);
  assert.equal(adapter.enabled, true);
  assert.equal(adapter.version, 1);
});

test("BaseSiteAdapter provides working default hook implementations", async () => {
  class SampleAdapter extends BaseSiteAdapter {
    constructor() {
      super({
        id: "sample",
        name: "Sample Adapter",
        domainPatterns: ["example.com"]
      });
    }
  }

  const adapter = new SampleAdapter();

  // matches URL
  assert.equal(adapter.matches("https://example.com/item"), true);
  assert.equal(adapter.matches("https://other.com"), false);

  // default capture returns null
  const captureResult = await adapter.capture(101);
  assert.equal(captureResult, null);

  // default restore returns true
  const restoreResult = await adapter.restore(101, {});
  assert.equal(restoreResult, true);

  // validateState
  assert.equal(adapter.validateState({ key: "val" }), true);
  assert.equal(adapter.validateState(null), true);
  assert.equal(adapter.validateState("not-an-object"), false);

  // formatSummary
  assert.equal(adapter.formatSummary(null), "No state captured");
  assert.equal(adapter.formatSummary({}), "Custom state for Sample Adapter");

  // enable / disable
  adapter.disable();
  assert.equal(adapter.enabled, false);
  assert.equal(adapter.matches("https://example.com/item"), false); // disabled adapter does not match

  adapter.enable();
  assert.equal(adapter.enabled, true);
  assert.equal(adapter.matches("https://example.com/item"), true);

  // toJSON serialization
  const json = adapter.toJSON();
  assert.equal(json.id, "sample");
  assert.equal(json.name, "Sample Adapter");
  assert.deepEqual(json.domainPatterns, ["example.com"]);
  assert.equal(json.enabled, true);
});

test("isSiteAdapter and assertValidAdapter validate interface compliance accurately", () => {
  assert.equal(isSiteAdapter(null), false);
  assert.equal(isSiteAdapter({}), false);
  assert.equal(isSiteAdapter({ id: "x", name: "X" }), false);

  const mockCompliant = {
    id: "mock",
    name: "Mock",
    matches: () => true,
    capture: async () => null,
    restore: async () => true
  };

  assert.equal(isSiteAdapter(mockCompliant), true);
  assert.doesNotThrow(() => assertValidAdapter(mockCompliant));

  const baseAdapter = new BaseSiteAdapter({ id: "base", name: "Base" });
  assert.equal(isSiteAdapter(baseAdapter), true);
  assert.doesNotThrow(() => assertValidAdapter(baseAdapter));

  // Incomplete candidates fail assertValidAdapter
  assert.throws(() => assertValidAdapter(null), /must be a non-null object/);
  assert.throws(() => assertValidAdapter({ name: "no-id" }), /must have a non-empty string 'id'/);
  assert.throws(() => assertValidAdapter({ id: "no-name" }), /must have a non-empty string 'name'/);
  assert.throws(
    () => assertValidAdapter({ id: "test", name: "test" }),
    /must implement 'matches\(url\)' method/
  );
  assert.throws(
    () => assertValidAdapter({ id: "test", name: "test", matches: () => true }),
    /must implement 'capture\(tabId, context\)' method/
  );
  assert.throws(
    () => assertValidAdapter({ id: "test", name: "test", matches: () => true, capture: () => null }),
    /must implement 'restore\(tabId, plan, context\)' method/
  );
});

test("AdapterExecutionError and AdapterTimeoutError contain expected diagnostic metadata", () => {
  const cause = new Error("DOM access denied");
  const execErr = new AdapterExecutionError("youtube", "capture", "Failed to query video element", cause);

  assert.equal(execErr.name, "AdapterExecutionError");
  assert.equal(execErr.adapterId, "youtube");
  assert.equal(execErr.stage, "capture");
  assert.equal(execErr.cause, cause);
  assert.match(execErr.message, /\[Adapter:youtube:capture\]/);

  const timeoutErr = new AdapterTimeoutError("github", "restore", 3000);
  assert.equal(timeoutErr.name, "AdapterTimeoutError");
  assert.equal(timeoutErr.adapterId, "github");
  assert.equal(timeoutErr.stage, "restore");
  assert.equal(timeoutErr.timeoutMs, 3000);
  assert.match(timeoutErr.message, /\[Adapter:github:restore\] Execution timed out after 3000ms/);
});
