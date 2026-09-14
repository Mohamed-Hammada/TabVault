import test from "node:test";
import assert from "node:assert/strict";

import { BaseSiteAdapter } from "../lib/adapters/base.js";
import { AdapterRegistry } from "../lib/adapters/registry.js";
import {
  getAdapterSettings,
  setAdapterSettings,
  resetAdapterSettings,
  isAdaptersGloballyEnabled,
  setAdaptersGloballyEnabled,
  isAdapterEnabled,
  setAdapterEnabled,
  syncRegistryWithSettings
} from "../lib/adapters/settings.js";

test("adapter settings defaults to enabled with empty disabled list", () => {
  resetAdapterSettings();
  const settings = getAdapterSettings();
  assert.equal(settings.enabled, true);
  assert.deepEqual(settings.disabledAdapters, []);
  assert.equal(isAdaptersGloballyEnabled(), true);
  assert.equal(isAdapterEnabled("youtube"), true);
});

test("setAdaptersGloballyEnabled toggles all adapters globally", () => {
  resetAdapterSettings();

  // Disable globally
  setAdaptersGloballyEnabled(false);
  assert.equal(isAdaptersGloballyEnabled(), false);
  assert.equal(isAdapterEnabled("youtube"), false);
  assert.equal(isAdapterEnabled("github"), false);

  // Enable globally
  setAdaptersGloballyEnabled(true);
  assert.equal(isAdaptersGloballyEnabled(), true);
  assert.equal(isAdapterEnabled("youtube"), true);
  assert.equal(isAdapterEnabled("github"), true);
});

test("setAdapterEnabled toggles specific adapters individually", () => {
  resetAdapterSettings();

  // Disable YouTube
  setAdapterEnabled("youtube", false);
  assert.equal(isAdapterEnabled("youtube"), false);
  assert.equal(isAdapterEnabled("github"), true);

  const settings = getAdapterSettings();
  assert.ok(settings.disabledAdapters.includes("youtube"));
  assert.ok(!settings.disabledAdapters.includes("github"));

  // Re-enable YouTube
  setAdapterEnabled("youtube", true);
  assert.equal(isAdapterEnabled("youtube"), true);
  assert.deepEqual(getAdapterSettings().disabledAdapters, []);
});

test("syncRegistryWithSettings and AdapterRegistry settings integration", () => {
  resetAdapterSettings();
  const registry = new AdapterRegistry();

  class MockYouTubeAdapter extends BaseSiteAdapter {
    constructor() {
      super({ id: "youtube", name: "YouTube", domainPatterns: ["*://*.youtube.com/*"] });
    }
  }

  class MockGitHubAdapter extends BaseSiteAdapter {
    constructor() {
      super({ id: "github", name: "GitHub", domainPatterns: ["*://github.com/*"] });
    }
  }

  const yt = new MockYouTubeAdapter();
  const gh = new MockGitHubAdapter();
  registry.register(yt);
  registry.register(gh);

  // Initially both enabled
  assert.equal(registry.isAdapterEnabled("youtube"), true);
  assert.equal(registry.isAdapterEnabled("github"), true);
  assert.ok(registry.findMatchingAdapter("https://www.youtube.com/watch?v=123"));

  // Disable YouTube via registry method
  registry.setAdapterEnabled("youtube", false);
  assert.equal(registry.isAdapterEnabled("youtube"), false);
  assert.equal(yt.enabled, false);
  assert.equal(yt.matches("https://www.youtube.com/watch?v=123"), false);
  assert.equal(registry.findMatchingAdapter("https://www.youtube.com/watch?v=123"), null);

  // GitHub is still enabled
  assert.equal(registry.isAdapterEnabled("github"), true);
  assert.ok(registry.findMatchingAdapter("https://github.com/repo"));

  // Disable globally
  setAdaptersGloballyEnabled(false);
  registry.syncWithSettings();
  assert.equal(registry.isAdapterEnabled("github"), false);
  assert.equal(registry.getEnabled().length, 0);
  assert.equal(registry.findMatchingAdapter("https://github.com/repo"), null);

  // Re-enable globally, YouTube was previously disabled so only GitHub should be enabled
  setAdaptersGloballyEnabled(true);
  registry.syncWithSettings();
  assert.equal(registry.isAdapterEnabled("github"), true);
  assert.equal(registry.isAdapterEnabled("youtube"), false);

  // Reset restores all defaults
  resetAdapterSettings({ registry });
  assert.equal(registry.isAdapterEnabled("youtube"), true);
  assert.equal(registry.isAdapterEnabled("github"), true);
});
