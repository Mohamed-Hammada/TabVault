import test from "node:test";
import assert from "node:assert/strict";

import {
  SearchAdapter,
  parseSearchEngineUrl,
  formatSearchSummary,
  SEARCH_ENGINES
} from "../lib/adapters/search.js";
import {
  getAdapterRegistry,
  resetAdapterRegistry,
  registerBuiltInAdapters
} from "../lib/adapters/registry.js";
import { captureSiteAdapterState } from "../lib/adapters/capture.js";
import { restoreSiteAdapterState } from "../lib/adapters/restore.js";

test("Search URL parser: parseSearchEngineUrl across engines", () => {
  const google = parseSearchEngineUrl("https://www.google.com/search?q=manifest+v3+service+worker&start=20&tbm=isch");
  assert.equal(google.engine, "google");
  assert.equal(google.engineName, "Google");
  assert.equal(google.query, "manifest v3 service worker");
  assert.equal(google.pageNumber, 3);
  assert.equal(google.vertical, "images");

  const bing = parseSearchEngineUrl("https://www.bing.com/search?q=browser+performance&first=11");
  assert.equal(bing.engine, "bing");
  assert.equal(bing.engineName, "Bing");
  assert.equal(bing.query, "browser performance");
  assert.equal(bing.pageNumber, 2);
  assert.equal(bing.vertical, "web");

  const ddg = parseSearchEngineUrl("https://duckduckgo.com/?q=privacy+preserving+search&ia=news");
  assert.equal(ddg.engine, "duckduckgo");
  assert.equal(ddg.query, "privacy preserving search");
  assert.equal(ddg.vertical, "news");

  const yahoo = parseSearchEngineUrl("https://search.yahoo.com/search?p=javascript+frameworks&b=21");
  assert.equal(yahoo.engine, "yahoo");
  assert.equal(yahoo.query, "javascript frameworks");
  assert.equal(yahoo.pageNumber, 3);

  const baidu = parseSearchEngineUrl("https://www.baidu.com/s?wd=tabvault&pn=20");
  assert.equal(baidu.engine, "baidu");
  assert.equal(baidu.query, "tabvault");
  assert.equal(baidu.pageNumber, 3);

  const ecosia = parseSearchEngineUrl("https://www.ecosia.org/search?q=renewable+energy&p=2");
  assert.equal(ecosia.engine, "ecosia");
  assert.equal(ecosia.query, "renewable energy");
  assert.equal(ecosia.pageNumber, 2);

  // Non-search URLs
  assert.equal(parseSearchEngineUrl("https://www.google.com/"), null);
  assert.equal(parseSearchEngineUrl("https://github.com/search?q=tabvault"), null);
  assert.equal(parseSearchEngineUrl(""), null);
});

test("Search formatSearchSummary", () => {
  assert.equal(
    formatSearchSummary({
      engineName: "Google",
      query: "react router",
      vertical: "images",
      pageNumber: 2
    }),
    'Google [images]: "react router" (page 2)'
  );

  assert.equal(
    formatSearchSummary({
      engineName: "DuckDuckGo",
      query: "tab suspender",
      vertical: "web",
      pageNumber: 1
    }),
    'DuckDuckGo: "tab suspender"'
  );

  assert.equal(formatSearchSummary(null), "Search page");
});

test("SearchAdapter metadata and matching", () => {
  const adapter = new SearchAdapter();

  assert.equal(adapter.id, "search");
  assert.equal(adapter.name, "Search Query");
  assert.equal(adapter.priority, 120);

  assert.equal(adapter.matches("https://www.google.com/search?q=tabvault"), true);
  assert.equal(adapter.matches("https://duckduckgo.com/?q=tabvault"), true);
  assert.equal(adapter.matches("https://www.bing.com/search?q=tabvault"), true);
  assert.equal(adapter.matches("https://www.google.com/"), false);
  assert.equal(adapter.matches("https://example.com/"), false);
});

test("SearchAdapter capture: via DOM inspection", async () => {
  const adapter = new SearchAdapter();

  const mockInput = { value: "modified search query in input" };
  const mockDoc = {
    querySelector(selector) {
      if (selector.includes("textarea") || selector.includes("name='q'")) return mockInput;
      return null;
    }
  };

  const captured = await adapter.capture(101, {
    url: "https://www.google.com/search?q=original+query&start=10",
    document: mockDoc
  });

  assert.ok(captured);
  assert.equal(captured.engine, "google");
  assert.equal(captured.query, "modified search query in input");
  assert.equal(captured.pageNumber, 2);
});

test("SearchAdapter capture: via chromeApi scripting fallback", async () => {
  const adapter = new SearchAdapter();

  const chromeApi = {
    scripting: {
      executeScript: async () => [
        {
          result: "injected query text"
        }
      ]
    }
  };

  const captured = await adapter.capture(102, {
    url: "https://duckduckgo.com/?q=fallback+query",
    chromeApi
  });

  assert.ok(captured);
  assert.equal(captured.engine, "duckduckgo");
  assert.equal(captured.query, "injected query text");
});

test("SearchAdapter restore: direct DOM restore", async () => {
  const adapter = new SearchAdapter();

  let inputVal = "";
  let eventDispatched = false;
  const mockInput = {
    get value() {
      return inputVal;
    },
    set value(v) {
      inputVal = v;
    },
    dispatchEvent() {
      eventDispatched = true;
    }
  };

  const mockDoc = {
    querySelector(selector) {
      if (selector.includes("textarea") || selector.includes("name='q'")) return mockInput;
      return null;
    }
  };

  const res = await adapter.restore(
    101,
    {
      url: "https://www.google.com/search?q=test",
      adapter: {
        id: "search",
        state: {
          engine: "google",
          query: "restored search keywords"
        }
      }
    },
    { document: mockDoc }
  );

  assert.equal(res.ok, true);
  assert.equal(res.restored, true);
  assert.equal(inputVal, "restored search keywords");
  assert.equal(eventDispatched, true);
});

test("SearchAdapter restore: via chromeApi scripting", async () => {
  const adapter = new SearchAdapter();

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
      url: "https://www.bing.com/search?q=test",
      adapter: {
        id: "search",
        state: {
          engine: "bing",
          query: "bing query restoration"
        }
      }
    },
    { chromeApi }
  );

  assert.equal(res.ok, true);
  assert.equal(scriptCalled, true);
  assert.deepEqual(passedArgs, ["bing query restoration"]);
});

test("SearchAdapter validation and registry pipeline integration", async () => {
  resetAdapterRegistry();
  const registry = getAdapterRegistry();
  registerBuiltInAdapters(registry);

  const matched = registry.findMatchingAdapter("https://www.google.com/search?q=tab+manager+extension");
  assert.ok(matched);
  assert.equal(matched.id, "search");

  const captureRes = await captureSiteAdapterState(
    "https://www.google.com/search?q=tab+manager+extension&tbm=isch",
    601,
    { adapterRegistry: registry }
  );

  assert.ok(captureRes);
  assert.equal(captureRes.matched, true);
  assert.equal(captureRes.ok, true);
  assert.equal(captureRes.adapterId, "search");
  assert.equal(captureRes.state.engine, "google");
  assert.equal(captureRes.state.query, "tab manager extension");
  assert.equal(captureRes.state.vertical, "images");
  assert.ok(captureRes.summary.includes("Google [images]"));

  const restoreRes = await restoreSiteAdapterState(
    "https://www.google.com/search?q=tab+manager+extension",
    601,
    {
      url: "https://www.google.com/search?q=tab+manager+extension",
      adapter: captureRes
    },
    { adapterRegistry: registry }
  );

  assert.equal(restoreRes.matched, true);
  assert.equal(restoreRes.ok, true);
  assert.equal(restoreRes.adapterId, "search");
});
