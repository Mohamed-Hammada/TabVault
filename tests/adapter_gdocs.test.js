import test from "node:test";
import assert from "node:assert/strict";

import {
  GoogleDocsAdapter,
  parseGoogleDocsUrl,
  formatGoogleDocsSummary
} from "../lib/adapters/gdocs.js";
import {
  getAdapterRegistry,
  resetAdapterRegistry,
  registerBuiltInAdapters
} from "../lib/adapters/registry.js";
import { captureSiteAdapterState } from "../lib/adapters/capture.js";
import { restoreSiteAdapterState } from "../lib/adapters/restore.js";

test("Google Docs URL parser: parseGoogleDocsUrl", () => {
  const doc = parseGoogleDocsUrl("https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit#heading=h.abc123xyz");
  assert.equal(doc.appType, "document");
  assert.equal(doc.docId, "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms");
  assert.equal(doc.mode, "edit");
  assert.equal(doc.headingId, "h.abc123xyz");

  const sheet = parseGoogleDocsUrl("https://docs.google.com/spreadsheets/d/1qpyC0X95dtNPIFs1P_6_G2/edit#gid=987654321&range=B2:F20");
  assert.equal(sheet.appType, "spreadsheets");
  assert.equal(sheet.docId, "1qpyC0X95dtNPIFs1P_6_G2");
  assert.equal(sheet.gid, "987654321");
  assert.equal(sheet.range, "B2:F20");

  const slide = parseGoogleDocsUrl("https://docs.google.com/presentation/d/1H54bUvM/edit#slide=id.p12");
  assert.equal(slide.appType, "presentation");
  assert.equal(slide.docId, "1H54bUvM");
  assert.equal(slide.slideId, "id.p12");

  // Non-Docs URLs
  assert.equal(parseGoogleDocsUrl("https://google.com/search?q=docs"), null);
  assert.equal(parseGoogleDocsUrl("https://drive.google.com/drive/my-drive"), null);
  assert.equal(parseGoogleDocsUrl(""), null);
});

test("Google Docs formatGoogleDocsSummary", () => {
  assert.equal(
    formatGoogleDocsSummary({
      appType: "document",
      title: "Q3 Strategy",
      headingId: "h.intro"
    }),
    'Google Doc "Q3 Strategy" (heading: h.intro)'
  );

  assert.equal(
    formatGoogleDocsSummary({
      appType: "spreadsheets",
      title: "Budget 2026",
      gid: "0",
      range: "A1:C10"
    }),
    'Google Sheet "Budget 2026" [Sheet 0] Range A1:C10'
  );

  assert.equal(
    formatGoogleDocsSummary({
      appType: "presentation",
      slideId: "id.p5"
    }),
    "Google Slides [Slide id.p5]"
  );

  assert.equal(formatGoogleDocsSummary(null), "Google Docs");
});

test("GoogleDocsAdapter metadata and matching", () => {
  const adapter = new GoogleDocsAdapter();

  assert.equal(adapter.id, "google-docs");
  assert.equal(adapter.name, "Google Docs");
  assert.equal(adapter.priority, 130);

  assert.equal(adapter.matches("https://docs.google.com/document/d/12345/edit"), true);
  assert.equal(adapter.matches("https://docs.google.com/spreadsheets/d/67890/edit"), true);
  assert.equal(adapter.matches("https://docs.google.com/presentation/d/abcdef/edit"), true);
  assert.equal(adapter.matches("https://docs.google.com/"), false);
  assert.equal(adapter.matches("https://sheets.google.com/"), false);
});

test("GoogleDocsAdapter capture: via DOM inspection", async () => {
  const adapter = new GoogleDocsAdapter();

  const mockTitleInput = { value: "Engineering Roadmap 2026" };
  const mockDoc = {
    querySelector(selector) {
      if (selector.includes("docs-title-input")) return mockTitleInput;
      return null;
    }
  };

  const captured = await adapter.capture(101, {
    url: "https://docs.google.com/document/d/doc_xyz_123/edit#heading=h.exec_summary",
    document: mockDoc
  });

  assert.ok(captured);
  assert.equal(captured.appType, "document");
  assert.equal(captured.docId, "doc_xyz_123");
  assert.equal(captured.title, "Engineering Roadmap 2026");
  assert.equal(captured.headingId, "h.exec_summary");
});

test("GoogleDocsAdapter capture: via chromeApi scripting fallback", async () => {
  const adapter = new GoogleDocsAdapter();

  const chromeApi = {
    scripting: {
      executeScript: async () => [
        {
          result: {
            title: "Financial Model 2026",
            hash: "#gid=1234&range=D4"
          }
        }
      ]
    }
  };

  const captured = await adapter.capture(102, {
    url: "https://docs.google.com/spreadsheets/d/sheet_abc/edit",
    chromeApi
  });

  assert.ok(captured);
  assert.equal(captured.appType, "spreadsheets");
  assert.equal(captured.title, "Financial Model 2026");
  assert.equal(captured.gid, "1234");
  assert.equal(captured.range, "D4");
});

test("GoogleDocsAdapter restore: direct DOM restore", async () => {
  const adapter = new GoogleDocsAdapter();

  // Test restoration without window object in Node.js
  const res = await adapter.restore(
    101,
    {
      url: "https://docs.google.com/document/d/doc123/edit",
      adapter: {
        id: "google-docs",
        state: {
          appType: "document",
          docId: "doc123",
          hash: "#heading=h.xyz"
        }
      }
    },
    {}
  );

  assert.equal(res.ok, true);
  assert.equal(res.restored, true);
  assert.equal(res.hash, "#heading=h.xyz");
});

test("GoogleDocsAdapter restore: via chromeApi scripting", async () => {
  const adapter = new GoogleDocsAdapter();

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
      url: "https://docs.google.com/presentation/d/pres789/edit",
      adapter: {
        id: "google-docs",
        state: {
          appType: "presentation",
          docId: "pres789",
          hash: "#slide=id.p25"
        }
      }
    },
    { chromeApi }
  );

  assert.equal(res.ok, true);
  assert.equal(scriptCalled, true);
  assert.deepEqual(passedArgs, ["#slide=id.p25"]);
});

test("GoogleDocsAdapter validation and registry pipeline integration", async () => {
  resetAdapterRegistry();
  const registry = getAdapterRegistry();
  registerBuiltInAdapters(registry);

  const matched = registry.findMatchingAdapter("https://docs.google.com/document/d/1A2B3C/edit#heading=h.sec1");
  assert.ok(matched);
  assert.equal(matched.id, "google-docs");

  const captureRes = await captureSiteAdapterState(
    "https://docs.google.com/document/d/1A2B3C/edit#heading=h.sec1",
    401,
    { adapterRegistry: registry }
  );

  assert.ok(captureRes);
  assert.equal(captureRes.matched, true);
  assert.equal(captureRes.ok, true);
  assert.equal(captureRes.adapterId, "google-docs");
  assert.equal(captureRes.state.docId, "1A2B3C");
  assert.equal(captureRes.state.headingId, "h.sec1");
  assert.ok(captureRes.summary.includes("heading: h.sec1"));

  const restoreRes = await restoreSiteAdapterState(
    "https://docs.google.com/document/d/1A2B3C/edit",
    401,
    {
      url: "https://docs.google.com/document/d/1A2B3C/edit",
      adapter: captureRes
    },
    { adapterRegistry: registry }
  );

  assert.equal(restoreRes.matched, true);
  assert.equal(restoreRes.ok, true);
  assert.equal(restoreRes.adapterId, "google-docs");
});
