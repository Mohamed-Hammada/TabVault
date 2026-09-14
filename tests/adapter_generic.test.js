import test from "node:test";
import assert from "node:assert/strict";

import {
  GenericUrlAdapter,
  parseGenericUrlState,
  formatGenericSummary
} from "../lib/adapters/generic.js";
import {
  getAdapterRegistry,
  resetAdapterRegistry,
  registerBuiltInAdapters
} from "../lib/adapters/registry.js";
import { captureSiteAdapterState } from "../lib/adapters/capture.js";
import { restoreSiteAdapterState } from "../lib/adapters/restore.js";

test("Generic URL parser: parseGenericUrlState", () => {
  const hashRoute = parseGenericUrlState("https://spa.myapp.com/#/admin/users?role=admin");
  assert.equal(hashRoute.hostname, "spa.myapp.com");
  assert.equal(hashRoute.routeType, "hash_route");
  assert.equal(hashRoute.hash, "#/admin/users?role=admin");

  const anchor = parseGenericUrlState("https://docs.dev.org/guide#getting-started");
  assert.equal(anchor.routeType, "anchor");
  assert.equal(anchor.hash, "#getting-started");

  const queryState = parseGenericUrlState("https://shop.example.com/items?cat=shoes&page=3");
  assert.equal(queryState.routeType, "query_state");
  assert.equal(queryState.searchParams.cat, "shoes");
  assert.equal(queryState.searchParams.page, "3");

  const standard = parseGenericUrlState("https://example.com/company/about");
  assert.equal(standard.routeType, "standard");
  assert.equal(standard.pathname, "/company/about");

  // Invalid URL
  assert.equal(parseGenericUrlState(""), null);
  assert.equal(parseGenericUrlState(null), null);
});

test("Generic formatGenericSummary", () => {
  assert.equal(
    formatGenericSummary({
      routeType: "hash_route",
      hash: "#/dashboard"
    }),
    "Hash route: #/dashboard"
  );

  assert.equal(
    formatGenericSummary({
      routeType: "anchor",
      hash: "#faq-section"
    }),
    "Anchor link: #faq-section"
  );

  assert.equal(
    formatGenericSummary({
      routeType: "query_state",
      searchParams: { a: "1", b: "2" }
    }),
    "Deep link (2 query params)"
  );

  assert.equal(formatGenericSummary(null), "Web page");
});

test("GenericUrlAdapter metadata and matching", () => {
  const adapter = new GenericUrlAdapter();

  assert.equal(adapter.id, "generic");
  assert.equal(adapter.name, "Generic URL / Hash / Query");
  assert.equal(adapter.priority, 10);

  assert.equal(adapter.matches("https://any-domain.com/path"), true);
  assert.equal(adapter.matches("http://localhost:3000/#/home"), true);
  assert.equal(adapter.matches("invalid-url"), false);
});

test("GenericUrlAdapter capture: via DOM inspection", async () => {
  const adapter = new GenericUrlAdapter();

  const mockDoc = {
    title: "SPA Dashboard"
  };

  const captured = await adapter.capture(101, {
    url: "https://my-app.io/#/dashboard/metrics",
    document: mockDoc
  });

  assert.ok(captured);
  assert.equal(captured.hostname, "my-app.io");
  assert.equal(captured.routeType, "hash_route");
  assert.equal(captured.hash, "#/dashboard/metrics");
  assert.equal(captured.title, "SPA Dashboard");
});

test("GenericUrlAdapter capture: via chromeApi scripting fallback", async () => {
  const adapter = new GenericUrlAdapter();

  const chromeApi = {
    scripting: {
      executeScript: async () => [
        {
          result: {
            title: "Injected SPA Page",
            hash: "#/profile/settings",
            search: "?mode=dark"
          }
        }
      ]
    }
  };

  const captured = await adapter.capture(102, {
    url: "https://my-app.io/",
    chromeApi
  });

  assert.ok(captured);
  assert.equal(captured.title, "Injected SPA Page");
  assert.equal(captured.hash, "#/profile/settings");
  assert.equal(captured.search, "?mode=dark");
});

test("GenericUrlAdapter restore: direct DOM restore", async () => {
  const adapter = new GenericUrlAdapter();

  let scrolled = false;
  const mockAnchor = {
    scrollIntoView() {
      scrolled = true;
    }
  };

  const mockDoc = {
    querySelector(sel) {
      if (sel === "#section-2") return mockAnchor;
      return null;
    }
  };

  const res = await adapter.restore(
    101,
    {
      url: "https://site.org/page",
      adapter: {
        id: "generic",
        state: {
          routeType: "anchor",
          hash: "#section-2"
        }
      }
    },
    { document: mockDoc }
  );

  assert.equal(res.ok, true);
  assert.equal(res.restored, true);
  assert.equal(scrolled, true);
});

test("GenericUrlAdapter restore: via chromeApi scripting", async () => {
  const adapter = new GenericUrlAdapter();

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
      url: "https://spa.com/",
      adapter: {
        id: "generic",
        state: {
          routeType: "hash_route",
          hash: "#/orders/123"
        }
      }
    },
    { chromeApi }
  );

  assert.equal(res.ok, true);
  assert.equal(scriptCalled, true);
  assert.deepEqual(passedArgs, ["#/orders/123"]);
});

test("GenericUrlAdapter prioritization and fallback in registry pipeline", async () => {
  resetAdapterRegistry();
  const registry = getAdapterRegistry();
  registerBuiltInAdapters(registry);

  // 1. YouTube matches YouTubeAdapter (priority 150), NOT generic (priority 10)
  const ytMatch = registry.findMatchingAdapter("https://www.youtube.com/watch?v=abc12345678");
  assert.equal(ytMatch.id, "youtube");

  // 2. GitHub matches GitHubAdapter (priority 140)
  const ghMatch = registry.findMatchingAdapter("https://github.com/facebook/react");
  assert.equal(ghMatch.id, "github");

  // 3. Custom SPA without specialized adapter matches GenericUrlAdapter (priority 10)
  const spaMatch = registry.findMatchingAdapter("https://custom-webapp.org/#/feed/popular");
  assert.ok(spaMatch);
  assert.equal(spaMatch.id, "generic");

  const captureRes = await captureSiteAdapterState(
    "https://custom-webapp.org/#/feed/popular?sort=top",
    701,
    { adapterRegistry: registry }
  );

  assert.ok(captureRes);
  assert.equal(captureRes.matched, true);
  assert.equal(captureRes.ok, true);
  assert.equal(captureRes.adapterId, "generic");
  assert.equal(captureRes.state.hash, "#/feed/popular?sort=top");
  assert.equal(captureRes.state.routeType, "hash_route");
  assert.ok(captureRes.summary.includes("#/feed/popular"));

  const restoreRes = await restoreSiteAdapterState(
    "https://custom-webapp.org/",
    701,
    {
      url: "https://custom-webapp.org/",
      adapter: captureRes
    },
    { adapterRegistry: registry }
  );

  assert.equal(restoreRes.matched, true);
  assert.equal(restoreRes.ok, true);
  assert.equal(restoreRes.adapterId, "generic");
});
