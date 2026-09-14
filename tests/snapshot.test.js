import test from "node:test";
import assert from "node:assert/strict";
import {
  SNAPSHOT_SCHEMA_VERSION,
  MAX_SNAPSHOT_URL_LENGTH,
  MAX_SNAPSHOT_TITLE_LENGTH,
  MAX_SNAPSHOT_FAVICON_LENGTH,
  extractCanonicalUrl,
  extractTabTitle,
  extractTabFavicon,
  extractSnapshotTimestamp,
  extractScrollPosition,
  captureWindowScroll,
  isSensitiveField,
  isSensitiveUrl,
  sanitizeFormData,
  serializeSafeDomForms,
  MAX_SNAPSHOT_SCREENSHOT_LENGTH,
  sanitizeScreenshotData,
  captureTabScreenshot,
  VALID_SUSPENSION_REASONS,
  sanitizeSuspensionReason,
  extractTabContext,
  SNAPSHOT_SCHEMA_FIELDS,
  validateSnapshotSchema,
  generateSnapshotId,
  createTabSnapshot
} from "../lib/snapshot.js";

test("extractCanonicalUrl extracts clean URLs from strings and tabs", () => {
  // Plain URL strings
  assert.equal(extractCanonicalUrl("https://github.com/test"), "https://github.com/test");
  assert.equal(extractCanonicalUrl("  https://example.com/path  "), "https://example.com/path");

  // Tab objects
  assert.equal(extractCanonicalUrl({ url: "https://news.ycombinator.com" }), "https://news.ycombinator.com");
  assert.equal(extractCanonicalUrl({ pendingUrl: "https://pending.example.org" }), "https://pending.example.org");

  // Suspended URL with hash parameter #u=
  const suspendedHash = "chrome-extension://tabvault/suspended/suspended.html#u=https%3A%2F%2Fnews.ycombinator.com&t=HN";
  assert.equal(extractCanonicalUrl(suspendedHash), "https://news.ycombinator.com");

  // Suspended URL with query parameter ?url=
  const suspendedQuery = "chrome-extension://tabvault/suspended/suspended.html?url=https%3A%2F%2Fwikipedia.org";
  assert.equal(extractCanonicalUrl(suspendedQuery), "https://wikipedia.org");

  // Empty or invalid input
  assert.equal(extractCanonicalUrl(""), "");
  assert.equal(extractCanonicalUrl(null), "");
  assert.equal(extractCanonicalUrl(undefined), "");
  assert.equal(extractCanonicalUrl({}), "");

  // Length capping
  const longUrl = "https://example.com/" + "a".repeat(3000);
  const truncated = extractCanonicalUrl(longUrl);
  assert.equal(truncated.length, MAX_SNAPSHOT_URL_LENGTH);
});

test("createTabSnapshot captures URL accurately", () => {
  const tab = {
    id: 42,
    url: "https://example.com/docs",
    title: "Example Docs",
    favIconUrl: "https://example.com/favicon.ico",
    windowId: 1,
    groupId: -1,
    pinned: false,
    index: 3
  };

  const snap = createTabSnapshot(tab);
  assert.equal(snap.url, "https://example.com/docs");
  assert.equal(snap.tabId, 42);
  assert.equal(snap.schemaVersion, SNAPSHOT_SCHEMA_VERSION);

  // Tab with suspended URL unwraps canonical URL
  const suspendedTab = {
    id: 43,
    url: "chrome-extension://tabvault/suspended/suspended.html#u=https%3A%2F%2Fgithub.com%2Ftrending&t=Trending",
    title: "Trending",
    windowId: 1
  };
  const snapSuspended = createTabSnapshot(suspendedTab);
  assert.equal(snapSuspended.url, "https://github.com/trending");
});

test("extractTabTitle and createTabSnapshot capture title with sanitization and fallbacks", () => {
  // Direct title
  assert.equal(extractTabTitle("My Awesome Tab"), "My Awesome Tab");
  assert.equal(extractTabTitle({ title: "  Clean Title  " }), "Clean Title");

  // Suspended tab with encoded title
  const suspendedUrl = "chrome-extension://tabvault/suspended/suspended.html#u=https%3A%2F%2Fgithub.com&t=GitHub%20Home";
  assert.equal(extractTabTitle({ title: "Tab Suspended", url: suspendedUrl }), "GitHub Home");

  // Fallback to URL hostname when title missing
  assert.equal(extractTabTitle({ title: "", url: "https://news.ycombinator.com/item?id=123" }), "news.ycombinator.com");

  // Fallback to Untitled Tab when no title and no URL
  assert.equal(extractTabTitle({}), "Untitled Tab");

  // Length capping
  const longTitle = "T".repeat(1000);
  const capped = extractTabTitle(longTitle);
  assert.equal(capped.length, MAX_SNAPSHOT_TITLE_LENGTH);

  // Snapshot integration
  const snap = createTabSnapshot({ id: 50, url: "https://example.org", title: "Original Site" });
  assert.equal(snap.title, "Original Site");
});

test("extractTabFavicon and createTabSnapshot capture favicon with unwrapping and limits", () => {
  // Direct favicon
  assert.equal(extractTabFavicon("https://example.com/icon.png"), "https://example.com/icon.png");
  assert.equal(extractTabFavicon({ favIconUrl: "https://example.com/favicon.ico" }), "https://example.com/favicon.ico");

  // Suspended tab with encoded favicon
  const suspendedUrl = "chrome-extension://tabvault/suspended/suspended.html#u=https%3A%2F%2Fexample.com&f=https%3A%2F%2Fexample.com%2Ffavicon.ico";
  assert.equal(extractTabFavicon({ url: suspendedUrl }), "https://example.com/favicon.ico");

  // Missing favicon
  assert.equal(extractTabFavicon({}), "");

  // Length capping
  const hugeFavicon = "data:image/png;base64," + "iVBORw0KGgo".repeat(1000);
  const capped = extractTabFavicon(hugeFavicon);
  assert.equal(capped.length, MAX_SNAPSHOT_FAVICON_LENGTH);

  // Snapshot integration
  const snap = createTabSnapshot({
    id: 60,
    url: "https://example.org",
    favIconUrl: "https://example.org/fav.ico"
  });
  assert.equal(snap.favicon, "https://example.org/fav.ico");
});

test("extractSnapshotTimestamp and createTabSnapshot resolve accurate timestamps", () => {
  const customTs = 1715000000000;

  // Explicit timestamp option
  assert.equal(extractSnapshotTimestamp({ timestamp: customTs }), customTs);

  // ISO string option
  const isoStr = "2026-05-01T12:00:00.000Z";
  assert.equal(extractSnapshotTimestamp({ timestamp: isoStr }), Date.parse(isoStr));

  // Suspended tab with &at= query parameter
  const suspendedUrl = "chrome-extension://tabvault/suspended/suspended.html#u=https%3A%2F%2Fexample.com&at=1700000000000";
  assert.equal(extractSnapshotTimestamp({}, { url: suspendedUrl }), 1700000000000);

  // Fallback to current time when invalid or missing
  const before = Date.now();
  const fallback = extractSnapshotTimestamp({ timestamp: -1 });
  const after = Date.now();
  assert.ok(fallback >= before && fallback <= after);

  // Integration in createTabSnapshot
  const snap = createTabSnapshot({ id: 70, url: "https://example.com" }, { timestamp: customTs });
  assert.equal(snap.timestamp, customTs);
  assert.equal(snap.createdAt, customTs);
  assert.equal(snap.createdAtIso, new Date(customTs).toISOString());
});

test("extractScrollPosition and captureWindowScroll sanitize and capture scroll coordinates", () => {
  // Normal coordinates
  const pos = extractScrollPosition({ x: 100, y: 550, percentX: 10, percentY: 45.5 });
  assert.deepEqual(pos, { x: 100, y: 550, percentX: 10, percentY: 45.5 });

  // Negative values and out-of-bounds percentages clamped
  const clamped = extractScrollPosition({ x: -50, y: -20, percentX: 150, percentY: -10 });
  assert.deepEqual(clamped, { x: 0, y: 0, percentX: 100, percentY: 0 });

  // Unwrapping scroll coordinates from suspended URL query params
  const suspendedUrl = "chrome-extension://tabvault/suspended/suspended.html#u=https%3A%2F%2Fexample.com&sx=320&sy=1200";
  const unwrapPos = extractScrollPosition({}, { url: suspendedUrl });
  assert.equal(unwrapPos.x, 320);
  assert.equal(unwrapPos.y, 1200);

  // captureWindowScroll with mock DOM
  const mockWin = { scrollX: 150, scrollY: 400, innerWidth: 1000, innerHeight: 800 };
  const mockDoc = { documentElement: { scrollWidth: 2000, scrollHeight: 4800, scrollLeft: 150, scrollTop: 400 } };
  const captured = captureWindowScroll(mockWin, mockDoc);
  assert.equal(captured.x, 150);
  assert.equal(captured.y, 400);
  assert.equal(captured.percentX, 15); // 150 / (2000 - 1000) * 100 = 15%
  assert.equal(captured.percentY, 10); // 400 / (4800 - 800) * 100 = 10%

  // Snapshot integration
  const snap = createTabSnapshot({ id: 80, url: "https://example.com" }, { scroll: { x: 200, y: 800, percentX: 20, percentY: 40 } });
  assert.deepEqual(snap.scroll, { x: 200, y: 800, percentX: 20, percentY: 40 });
});

test("isSensitiveField detects passwords, credit cards, PINs, and auth tokens", () => {
  // Passwords
  assert.equal(isSensitiveField({ type: "password", name: "user_password" }), true);
  assert.equal(isSensitiveField({ type: "text", name: "passwd" }), true);
  assert.equal(isSensitiveField({ type: "text", id: "current-password" }), true);

  // Hidden and file fields
  assert.equal(isSensitiveField({ type: "hidden" }), true);
  assert.equal(isSensitiveField({ type: "file" }), true);

  // Credit cards and CVV
  assert.equal(isSensitiveField({ type: "text", name: "creditCardNumber" }), true);
  assert.equal(isSensitiveField({ type: "text", name: "cvv" }), true);
  assert.equal(isSensitiveField({ type: "text", placeholder: "Card number" }), true);
  assert.equal(isSensitiveField({ type: "text", autocomplete: "cc-csc" }), true);

  // Auth tokens and OTP
  assert.equal(isSensitiveField({ type: "text", name: "otp_code" }), true);
  assert.equal(isSensitiveField({ type: "text", name: "twoFactorPin" }), true);
  assert.equal(isSensitiveField({ type: "text", ariaLabel: "Verification Code" }), true);

  // Safe fields
  assert.equal(isSensitiveField({ type: "text", name: "searchQuery" }), false);
  assert.equal(isSensitiveField({ type: "textarea", name: "commentBody" }), false);
  assert.equal(isSensitiveField({ type: "checkbox", name: "subscribeNewsletter" }), false);
});

test("isSensitiveUrl detects banking, login, and payment URLs", () => {
  assert.equal(isSensitiveUrl("https://bankofamerica.com/dashboard"), true);
  assert.equal(isSensitiveUrl("https://paypal.com/checkout"), true);
  assert.equal(isSensitiveUrl("https://github.com/login"), true);
  assert.equal(isSensitiveUrl("https://example.com/account/signin"), true);
  assert.equal(isSensitiveUrl("https://shop.example.com/checkout/payment"), true);

  // Non-sensitive URLs
  assert.equal(isSensitiveUrl("https://en.wikipedia.org/wiki/Computer_science"), false);
  assert.equal(isSensitiveUrl("https://github.com/trending"), false);

  // Custom exclusions
  assert.equal(isSensitiveUrl("https://myinternaltools.com/editor", ["myinternaltools.com"]), true);
});

test("sanitizeFormData and serializeSafeDomForms preserve safe fields and strip sensitive ones", () => {
  const rawFields = [
    { type: "text", name: "articleTitle", value: "Understanding TabVault" },
    { type: "password", name: "user_pass", value: "Secret123!" },
    { type: "text", name: "credit_card", value: "4111222233334444" },
    { type: "textarea", name: "articleBody", value: "Tabs are suspended gracefully." },
    { type: "checkbox", name: "publishNow", checked: true },
    { type: "select", name: "category", value: "tech", selectedIndex: 2 },
    { type: "contenteditable", id: "richEditor", text: "Editable text content" }
  ];

  const sanitized = sanitizeFormData(rawFields, "https://blog.example.com/new-post");
  assert.equal(sanitized.length, 5); // 7 minus password and credit card

  assert.deepEqual(sanitized[0], {
    type: "text",
    selector: null,
    name: "articleTitle",
    id: null,
    value: "Understanding TabVault"
  });

  assert.deepEqual(sanitized[2], {
    type: "checkbox",
    selector: null,
    name: "publishNow",
    id: null,
    checked: true
  });

  // Sensitive URL returns null (no forms saved on banking/login)
  assert.equal(sanitizeFormData(rawFields, "https://bankofamerica.com/transfer"), null);

  // saveFormsEnabled = false returns null
  assert.equal(sanitizeFormData(rawFields, "https://blog.example.com", { saveFormsEnabled: false }), null);

  // Snapshot integration
  const snap = createTabSnapshot(
    { id: 90, url: "https://notes.example.org" },
    { forms: rawFields }
  );
  assert.ok(Array.isArray(snap.forms));
  assert.equal(snap.forms.length, 5);
});

test("sanitizeScreenshotData and captureTabScreenshot handle valid images and fallback cards", async () => {
  const validDataUrl = "data:image/jpeg;base64," + "A".repeat(200);

  // Valid screenshot string
  const sanitized = sanitizeScreenshotData(validDataUrl);
  assert.equal(sanitized.isFallback, false);
  assert.equal(sanitized.dataUrl, validDataUrl);
  assert.equal(sanitized.format, "image/jpeg");
  assert.ok(sanitized.sizeBytes > 0);

  // Missing screenshot produces fallback card descriptor
  const fallback = sanitizeScreenshotData(null, { title: "My Tab", favicon: "ico", url: "https://news.ycombinator.com" });
  assert.equal(fallback.isFallback, true);
  assert.equal(fallback.title, "My Tab");
  assert.equal(fallback.domain, "news.ycombinator.com");

  // Disabled screenshots return null
  assert.equal(sanitizeScreenshotData(validDataUrl, { enableScreenshots: false }), null);

  // Oversized screenshot triggers fallback with truncated flag
  const oversized = "data:image/jpeg;base64," + "A".repeat(MAX_SNAPSHOT_SCREENSHOT_LENGTH + 50);
  const truncatedFallback = sanitizeScreenshotData(oversized, { title: "Big Page" });
  assert.equal(truncatedFallback.isFallback, true);
  assert.equal(truncatedFallback.truncated, true);

  // captureTabScreenshot on inactive tab returns null without throwing
  const inactiveResult = await captureTabScreenshot({ active: false, windowId: 1 });
  assert.equal(inactiveResult, null);

  // captureTabScreenshot with mock chrome API on active tab
  const mockChrome = {
    tabs: {
      captureVisibleTab(winId, opts, cb) {
        cb("data:image/jpeg;base64,12345");
      }
    },
    runtime: {}
  };
  const activeResult = await captureTabScreenshot({ active: true, windowId: 1 }, mockChrome);
  assert.equal(activeResult, "data:image/jpeg;base64,12345");
});

test("sanitizeSuspensionReason normalizes and validates reasons", () => {
  // Standard canonical reasons
  assert.equal(sanitizeSuspensionReason("manual"), "manual");
  assert.equal(sanitizeSuspensionReason("idle_timeout"), "idle_timeout");
  assert.equal(sanitizeSuspensionReason("memory_pressure"), "memory_pressure");
  assert.equal(sanitizeSuspensionReason("domain_rule"), "domain_rule");
  assert.equal(sanitizeSuspensionReason("window_blur"), "window_blur");
  assert.equal(sanitizeSuspensionReason("startup_restore"), "startup_restore");
  assert.equal(sanitizeSuspensionReason("battery_saver"), "battery_saver");

  // Prefixed reasons
  assert.equal(sanitizeSuspensionReason("idle_timeout:20m"), "idle_timeout");

  // Case normalization & whitespace
  assert.equal(sanitizeSuspensionReason("  MEMORY_PRESSURE  "), "memory_pressure");

  // Fallback on empty or invalid non-string
  assert.equal(sanitizeSuspensionReason(""), "manual");
  assert.equal(sanitizeSuspensionReason(null), "manual");
  assert.equal(sanitizeSuspensionReason(undefined), "manual");

  // Snapshot integration
  const snap = createTabSnapshot({ id: 95, url: "https://example.com" }, { reason: "idle_timeout" });
  assert.equal(snap.reason, "idle_timeout");
});

test("extractTabContext and createTabSnapshot capture tab, group, and window context accurately", () => {
  const tab = {
    id: 105,
    windowId: 3,
    groupId: 12,
    pinned: true,
    index: 7,
    incognito: false,
    openerTabId: 101
  };

  const ctx = extractTabContext(tab, { groupTitle: "Research", groupColor: "blue" });
  assert.deepEqual(ctx, {
    tabId: 105,
    windowId: 3,
    groupId: 12,
    groupTitle: "Research",
    groupColor: "blue",
    pinned: true,
    index: 7,
    incognito: false,
    openerTabId: 101
  });

  // Default fallbacks
  const emptyCtx = extractTabContext({});
  assert.equal(emptyCtx.tabId, 0);
  assert.equal(emptyCtx.windowId, null);
  assert.equal(emptyCtx.groupId, -1);
  assert.equal(emptyCtx.pinned, false);
  assert.equal(emptyCtx.index, null);
  assert.equal(emptyCtx.incognito, false);
  assert.equal(emptyCtx.openerTabId, null);

  // Snapshot integration
  const snap = createTabSnapshot(tab, { groupTitle: "Research" });
  assert.deepEqual(snap.context, {
    tabId: 105,
    windowId: 3,
    groupId: 12,
    groupTitle: "Research",
    groupColor: null,
    pinned: true,
    index: 7,
    incognito: false,
    openerTabId: 101
  });
});

test("validateSnapshotSchema validates complete snapshot schema and flags invalid records", () => {
  // Snapshot created by createTabSnapshot conforms perfectly
  const snap = createTabSnapshot({
    id: 110,
    url: "https://example.org/dashboard",
    title: "Dashboard",
    favIconUrl: "https://example.org/favicon.ico"
  });

  const res = validateSnapshotSchema(snap);
  assert.equal(res.valid, true);
  assert.equal(res.errors.length, 0);

  // Check all schema fields present in snapshot
  for (const field of SNAPSHOT_SCHEMA_FIELDS) {
    assert.ok(field in snap, `Snapshot missing field ${field}`);
  }

  // Invalid snapshot records
  assert.equal(validateSnapshotSchema(null).valid, false);
  assert.equal(validateSnapshotSchema("not an object").valid, false);

  const missingUrl = { ...snap, url: 123 };
  assert.equal(validateSnapshotSchema(missingUrl).valid, false);

  const missingScroll = { ...snap, scroll: null };
  assert.equal(validateSnapshotSchema(missingScroll).valid, false);

  const missingContext = { ...snap, context: null };
  assert.equal(validateSnapshotSchema(missingContext).valid, false);
});
