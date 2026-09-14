import test from "node:test";
import assert from "node:assert/strict";

import {
  NotionAdapter,
  normalizeNotionId,
  parseNotionUrl,
  formatNotionSummary
} from "../lib/adapters/notion.js";
import {
  getAdapterRegistry,
  resetAdapterRegistry,
  registerBuiltInAdapters
} from "../lib/adapters/registry.js";
import { captureSiteAdapterState } from "../lib/adapters/capture.js";
import { restoreSiteAdapterState } from "../lib/adapters/restore.js";

test("Notion ID normalizer: normalizeNotionId", () => {
  assert.equal(
    normalizeNotionId("123456789abcdef0123456789abcdef0"),
    "123456789abcdef0123456789abcdef0"
  );
  assert.equal(
    normalizeNotionId("12345678-9abc-def0-1234-56789abcdef0"),
    "123456789abcdef0123456789abcdef0"
  );
  assert.equal(normalizeNotionId("invalid-short-id"), null);
  assert.equal(normalizeNotionId(""), null);
  assert.equal(normalizeNotionId(null), null);
});

test("Notion URL parser: parseNotionUrl", () => {
  const page = parseNotionUrl("https://www.notion.so/myworkspace/Engineering-Handbook-123456789abcdef0123456789abcdef0");
  assert.equal(page.workspace, "myworkspace");
  assert.equal(page.pageSlug, "Engineering-Handbook-123456789abcdef0123456789abcdef0");
  assert.equal(page.pageId, "123456789abcdef0123456789abcdef0");

  const databaseView = parseNotionUrl("https://www.notion.so/myworkspace/Tasks-abcdef0123456789abcdef0123456789?v=fedcba9876543210fedcba9876543210#112233445566778899aabbccddeeff00");
  assert.equal(databaseView.pageId, "abcdef0123456789abcdef0123456789");
  assert.equal(databaseView.viewId, "fedcba9876543210fedcba9876543210");
  assert.equal(databaseView.blockId, "112233445566778899aabbccddeeff00");

  const site = parseNotionUrl("https://docs.notion.site/API-Reference-00112233445566778899aabbccddeeff");
  assert.equal(site.pageId, "00112233445566778899aabbccddeeff");

  const queryP = parseNotionUrl("https://www.notion.so/myteam?p=aabbccddeeff00112233445566778899");
  assert.equal(queryP.pageId, "aabbccddeeff00112233445566778899");

  // Non-notion
  assert.equal(parseNotionUrl("https://google.com"), null);
  assert.equal(parseNotionUrl(""), null);
});

test("Notion formatNotionSummary", () => {
  assert.equal(
    formatNotionSummary({
      title: "Sprint Planning",
      pageId: "123456789abcdef0123456789abcdef0",
      viewId: "fedcba9876543210fedcba9876543210",
      blockId: "112233445566778899aabbccddeeff00"
    }),
    'Notion "Sprint Planning" [view: fedcba] (block: #112233)'
  );

  assert.equal(
    formatNotionSummary({
      pageId: "123456789abcdef0123456789abcdef0"
    }),
    "Notion Page 12345678..."
  );

  assert.equal(formatNotionSummary(null), "Notion page");
});

test("NotionAdapter metadata and matching", () => {
  const adapter = new NotionAdapter();

  assert.equal(adapter.id, "notion");
  assert.equal(adapter.name, "Notion");
  assert.equal(adapter.priority, 125);

  assert.equal(adapter.matches("https://www.notion.so/team/Page-123456789abcdef0123456789abcdef0"), true);
  assert.equal(adapter.matches("https://pub.notion.site/Guide-abcdef0123456789abcdef0123456789"), true);
  assert.equal(adapter.matches("https://www.notion.so/login"), false);
  assert.equal(adapter.matches("https://trello.com"), false);
});

test("NotionAdapter capture: via DOM inspection", async () => {
  const adapter = new NotionAdapter();

  const mockTitleEl = { textContent: "System Architecture Document" };
  const mockDoc = {
    querySelector(selector) {
      if (selector.includes("notion-page-block") || selector.includes("placeholder")) return mockTitleEl;
      return null;
    }
  };

  const captured = await adapter.capture(101, {
    url: "https://www.notion.so/team/System-Architecture-123456789abcdef0123456789abcdef0#112233445566778899aabbccddeeff00",
    document: mockDoc
  });

  assert.ok(captured);
  assert.equal(captured.workspace, "team");
  assert.equal(captured.pageId, "123456789abcdef0123456789abcdef0");
  assert.equal(captured.title, "System Architecture Document");
  assert.equal(captured.blockId, "112233445566778899aabbccddeeff00");
});

test("NotionAdapter capture: via chromeApi scripting fallback", async () => {
  const adapter = new NotionAdapter();

  const chromeApi = {
    scripting: {
      executeScript: async () => [
        {
          result: {
            title: "Roadmap 2027",
            hash: "#99887766554433221100aabbccddeeff"
          }
        }
      ]
    }
  };

  const captured = await adapter.capture(102, {
    url: "https://www.notion.so/team/Roadmap-abcdef0123456789abcdef0123456789",
    chromeApi
  });

  assert.ok(captured);
  assert.equal(captured.title, "Roadmap 2027");
  assert.equal(captured.blockId, "99887766554433221100aabbccddeeff");
});

test("NotionAdapter restore: direct DOM restore", async () => {
  const adapter = new NotionAdapter();

  let scrolled = false;
  const mockBlock = {
    scrollIntoView() {
      scrolled = true;
    }
  };

  const mockDoc = {
    querySelector(selector) {
      if (selector.includes("112233445566778899aabbccddeeff00")) return mockBlock;
      return null;
    }
  };

  const res = await adapter.restore(
    101,
    {
      url: "https://www.notion.so/team/Page-123456789abcdef0123456789abcdef0",
      adapter: {
        id: "notion",
        state: {
          pageId: "123456789abcdef0123456789abcdef0",
          blockId: "112233445566778899aabbccddeeff00"
        }
      }
    },
    { document: mockDoc }
  );

  assert.equal(res.ok, true);
  assert.equal(res.restored, true);
  assert.equal(scrolled, true);
});

test("NotionAdapter restore: via chromeApi scripting", async () => {
  const adapter = new NotionAdapter();

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
      url: "https://www.notion.so/team/Page-123456789abcdef0123456789abcdef0",
      adapter: {
        id: "notion",
        state: {
          pageId: "123456789abcdef0123456789abcdef0",
          blockId: "112233445566778899aabbccddeeff00"
        }
      }
    },
    { chromeApi }
  );

  assert.equal(res.ok, true);
  assert.equal(scriptCalled, true);
  assert.deepEqual(passedArgs, ["112233445566778899aabbccddeeff00"]);
});

test("NotionAdapter validation and registry pipeline integration", async () => {
  resetAdapterRegistry();
  const registry = getAdapterRegistry();
  registerBuiltInAdapters(registry);

  const matched = registry.findMatchingAdapter("https://www.notion.so/org/Doc-123456789abcdef0123456789abcdef0");
  assert.ok(matched);
  assert.equal(matched.id, "notion");

  const captureRes = await captureSiteAdapterState(
    "https://www.notion.so/org/Doc-123456789abcdef0123456789abcdef0?v=abcdef0123456789abcdef0123456789#112233445566778899aabbccddeeff00",
    501,
    { adapterRegistry: registry }
  );

  assert.ok(captureRes);
  assert.equal(captureRes.matched, true);
  assert.equal(captureRes.ok, true);
  assert.equal(captureRes.adapterId, "notion");
  assert.equal(captureRes.state.pageId, "123456789abcdef0123456789abcdef0");
  assert.equal(captureRes.state.viewId, "abcdef0123456789abcdef0123456789");
  assert.equal(captureRes.state.blockId, "112233445566778899aabbccddeeff00");
  assert.ok(captureRes.summary.includes("Notion"));

  const restoreRes = await restoreSiteAdapterState(
    "https://www.notion.so/org/Doc-123456789abcdef0123456789abcdef0",
    501,
    {
      url: "https://www.notion.so/org/Doc-123456789abcdef0123456789abcdef0",
      adapter: captureRes
    },
    { adapterRegistry: registry }
  );

  assert.equal(restoreRes.matched, true);
  assert.equal(restoreRes.ok, true);
  assert.equal(restoreRes.adapterId, "notion");
});
