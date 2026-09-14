import test from "node:test";
import assert from "node:assert/strict";
import {
  matchDomainPattern,
  extractHostname,
  isSubdomainOf,
  matchesAnyPattern,
  globToRegex
} from "../lib/adapters/domain.js";
import {
  AdapterRegistry,
  getAdapterRegistry,
  resetAdapterRegistry
} from "../lib/adapters/registry.js";
import { BaseSiteAdapter } from "../lib/adapters/base.js";

test("extractHostname handles full URLs, schemes, paths, and raw hostnames", () => {
  assert.equal(extractHostname("https://www.youtube.com/watch?v=123"), "www.youtube.com");
  assert.equal(extractHostname("http://github.com/repo"), "github.com");
  assert.equal(extractHostname("https://localhost:8080/dashboard"), "localhost");
  assert.equal(extractHostname("sub.domain.example.org:3000/path"), "sub.domain.example.org");
  assert.equal(extractHostname("EXAMPLE.COM"), "example.com");
  assert.equal(extractHostname(""), "");
  assert.equal(extractHostname(null), "");
});

test("isSubdomainOf handles root domains and nested subdomains", () => {
  assert.equal(isSubdomainOf("github.com", "github.com"), true);
  assert.equal(isSubdomainOf("api.github.com", "github.com"), true);
  assert.equal(isSubdomainOf("internal.api.github.com", "github.com"), true);
  assert.equal(isSubdomainOf("notgithub.com", "github.com"), false);
  assert.equal(isSubdomainOf("github.com.attacker.com", "github.com"), false);
  assert.equal(isSubdomainOf("github.com", "*.github.com"), true);
  assert.equal(isSubdomainOf("gist.github.com", ".github.com"), true);
});

test("matchDomainPattern matches exact domains, wildcards, globs, and regular expressions", () => {
  // 1. Exact domain pattern
  assert.equal(matchDomainPattern("https://example.com/page", "example.com"), true);
  assert.equal(matchDomainPattern("https://sub.example.com/page", "example.com"), true);
  assert.equal(matchDomainPattern("https://badexample.com/page", "example.com"), false);

  // 2. Wildcard pattern *.domain.com
  assert.equal(matchDomainPattern("https://sub.domain.com/path", "*.domain.com"), true);
  assert.equal(matchDomainPattern("https://domain.com/path", "*.domain.com"), true);
  assert.equal(matchDomainPattern("https://otherdomain.com/path", "*.domain.com"), false);

  // 3. Leading dot pattern .domain.com
  assert.equal(matchDomainPattern("https://sub.domain.com/path", ".domain.com"), true);
  assert.equal(matchDomainPattern("https://domain.com/path", ".domain.com"), true);

  // 4. URL glob pattern
  assert.equal(matchDomainPattern("https://youtube.com/watch?v=abc", "*://*.youtube.com/watch*"), true);
  assert.equal(matchDomainPattern("https://www.youtube.com/watch?v=abc", "*://*.youtube.com/watch*"), true);
  assert.equal(matchDomainPattern("https://youtube.com/channel/abc", "*://*.youtube.com/watch*"), false);

  // 5. RegExp pattern
  const re = /^https:\/\/(www\.)?github\.com\/[^\/]+\/[^\/]+/i;
  assert.equal(matchDomainPattern("https://github.com/facebook/react", re), true);
  assert.equal(matchDomainPattern("https://www.github.com/facebook/react/pulls", re), true);
  assert.equal(matchDomainPattern("https://github.com/", re), false);

  // 6. Case-insensitivity
  assert.equal(matchDomainPattern("HTTPS://DOCS.GOOGLE.COM/DOCUMENT/D/123", "docs.google.com"), true);

  // 7. Edge cases
  assert.equal(matchDomainPattern("", "example.com"), false);
  assert.equal(matchDomainPattern("https://example.com", ""), false);
  assert.equal(matchDomainPattern(null, "example.com"), false);
});

test("matchesAnyPattern evaluates arrays of patterns correctly", () => {
  const patterns = ["youtube.com", "*.youtube.com", "youtu.be"];

  assert.equal(matchesAnyPattern("https://www.youtube.com/watch?v=123", patterns), true);
  assert.equal(matchesAnyPattern("https://youtu.be/123", patterns), true);
  assert.equal(matchesAnyPattern("https://vimeo.com/123", patterns), false);
  assert.equal(matchesAnyPattern("https://youtube.com", []), false);
});

test("AdapterRegistry matches adapters based on domain, priority, and enabled state", () => {
  resetAdapterRegistry();
  const registry = new AdapterRegistry();

  class HighPriorityAdapter extends BaseSiteAdapter {
    constructor() {
      super({
        id: "high_priority",
        name: "High Priority Adapter",
        domainPatterns: ["github.com"],
        priority: 200
      });
    }
  }

  class NormalPriorityAdapter extends BaseSiteAdapter {
    constructor() {
      super({
        id: "normal_priority",
        name: "Normal Priority Adapter",
        domainPatterns: ["*.github.com"],
        priority: 100
      });
    }
  }

  class DisabledAdapter extends BaseSiteAdapter {
    constructor() {
      super({
        id: "disabled_adapter",
        name: "Disabled Adapter",
        domainPatterns: ["github.com"],
        priority: 300,
        enabled: false
      });
    }
  }

  const high = new HighPriorityAdapter();
  const normal = new NormalPriorityAdapter();
  const disabled = new DisabledAdapter();

  registry.register(normal);
  registry.register(high);
  registry.register(disabled);

  assert.equal(registry.size(), 3);
  assert.equal(registry.has("high_priority"), true);
  assert.equal(registry.has("normal_priority"), true);
  assert.equal(registry.has("disabled_adapter"), true);

  // findMatchingAdapter must return highest priority ENABLED adapter (high_priority, priority 200)
  const matched = registry.findMatchingAdapter("https://github.com/pulls");
  assert.ok(matched);
  assert.equal(matched.id, "high_priority");

  // findAllMatchingAdapters returns matching enabled adapters in priority order
  const allMatches = registry.findAllMatchingAdapters("https://github.com/pulls");
  assert.equal(allMatches.length, 2);
  assert.equal(allMatches[0].id, "high_priority");
  assert.equal(allMatches[1].id, "normal_priority");

  // Non-matching URL returns null
  assert.equal(registry.findMatchingAdapter("https://gitlab.com"), null);
  assert.deepEqual(registry.findAllMatchingAdapters("https://gitlab.com"), []);

  // Unregister adapter
  assert.equal(registry.unregister("high_priority"), true);
  assert.equal(registry.findMatchingAdapter("https://github.com/pulls").id, "normal_priority");

  // Clear registry
  registry.clear();
  assert.equal(registry.size(), 0);
  assert.equal(registry.findMatchingAdapter("https://github.com/pulls"), null);
});

test("getAdapterRegistry singleton provides stable instance across calls", () => {
  resetAdapterRegistry();
  const reg1 = getAdapterRegistry();
  const reg2 = getAdapterRegistry();
  assert.equal(reg1, reg2);

  const adapter = new BaseSiteAdapter({ id: "singleton_test", name: "Singleton Test" });
  reg1.register(adapter);
  assert.equal(reg2.has("singleton_test"), true);

  resetAdapterRegistry();
  const reg3 = getAdapterRegistry();
  assert.notEqual(reg1, reg3);
  assert.equal(reg3.has("singleton_test"), false);
});
