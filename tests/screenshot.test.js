import test from "node:test";
import assert from "node:assert/strict";
import {
  RESTRICTED_URL_SCHEMES,
  DEFAULT_SCREENSHOT_OPTIONS,
  isCapturableUrl,
  canCaptureTabScreenshot,
  captureTabScreenshot,
  calculateDataUrlByteSize,
  extractDataUrlMimeType,
  storeScreenshotMetadata,
  validateScreenshotMetadata,
  formatScreenshotSummary,
  DEFAULT_COMPRESSION_OPTIONS,
  calculateScaledDimensions,
  compressScreenshot,
  MAX_SCREENSHOT_BYTE_SIZE,
  MAX_SCREENSHOT_DATA_LENGTH,
  enforceScreenshotSizeLimit
} from "../lib/screenshot.js";

test("isCapturableUrl accepts standard URLs and rejects restricted browser schemes", () => {
  // Valid URLs
  assert.equal(isCapturableUrl("https://github.com"), true);
  assert.equal(isCapturableUrl("http://localhost:8080/dashboard"), true);
  assert.equal(isCapturableUrl("https://en.wikipedia.org/wiki/Main_Page"), true);

  // Restricted schemes
  assert.equal(isCapturableUrl("chrome://settings"), false);
  assert.equal(isCapturableUrl("chrome-extension://abcdef/popup.html"), false);
  assert.equal(isCapturableUrl("edge://extensions"), false);
  assert.equal(isCapturableUrl("about:blank"), false);
  assert.equal(isCapturableUrl("devtools://devtools/bundled/inspector.html"), false);
  assert.equal(isCapturableUrl("data:text/html,<h1>Hello</h1>"), false);
  assert.equal(isCapturableUrl("view-source:https://example.com"), false);
  assert.equal(isCapturableUrl(""), false);
  assert.equal(isCapturableUrl(null), false);
});

test("canCaptureTabScreenshot validates API availability, tab active status, and URLs", () => {
  const mockApi = {
    tabs: {
      captureVisibleTab: () => {}
    }
  };

  // Missing API
  assert.deepEqual(canCaptureTabScreenshot({ active: true, url: "https://example.com" }, null), {
    canCapture: false,
    reason: "API_UNAVAILABLE"
  });

  // Invalid Tab
  assert.deepEqual(canCaptureTabScreenshot(null, mockApi), {
    canCapture: false,
    reason: "INVALID_TAB"
  });

  // Restricted URL
  assert.deepEqual(canCaptureTabScreenshot({ active: true, url: "chrome://history" }, mockApi), {
    canCapture: false,
    reason: "RESTRICTED_URL"
  });

  // Inactive Tab
  assert.deepEqual(canCaptureTabScreenshot({ active: false, url: "https://example.com" }, mockApi), {
    canCapture: false,
    reason: "TAB_NOT_ACTIVE"
  });

  // Loading Tab (can capture with note)
  assert.deepEqual(canCaptureTabScreenshot({ active: true, status: "loading", url: "https://example.com" }, mockApi), {
    canCapture: true,
    reason: "TAB_LOADING"
  });

  // Fully Capturable Tab
  assert.deepEqual(canCaptureTabScreenshot({ active: true, status: "complete", url: "https://example.com" }, mockApi), {
    canCapture: true,
    reason: null
  });
});

test("captureTabScreenshot invokes captureVisibleTab and returns data URL", async () => {
  const fakeDataUrl = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD";
  let capturedWindowId = null;
  let capturedOptions = null;

  const mockApi = {
    runtime: {},
    tabs: {
      captureVisibleTab(windowId, opts, cb) {
        capturedWindowId = windowId;
        capturedOptions = opts;
        cb(fakeDataUrl);
      }
    }
  };

  const tab = {
    id: 123,
    windowId: 77,
    active: true,
    url: "https://example.com/article"
  };

  const result = await captureTabScreenshot(tab, { format: "jpeg", quality: 75 }, mockApi);

  assert.equal(result, fakeDataUrl);
  assert.equal(capturedWindowId, 77);
  assert.equal(capturedOptions.format, "jpeg");
  assert.equal(capturedOptions.quality, 75);
});

test("captureTabScreenshot handles inactive tabs, API errors, and timeouts gracefully", async () => {
  // Inactive tab returns null immediately
  const inactiveTab = { id: 1, active: false, url: "https://example.com" };
  const mockApi = { tabs: { captureVisibleTab: () => {} } };
  const resInactive = await captureTabScreenshot(inactiveTab, {}, mockApi);
  assert.equal(resInactive, null);

  // API error (lastError) returns null
  const errorApi = {
    runtime: { lastError: { message: "Failed to capture window" } },
    tabs: {
      captureVisibleTab(winId, opts, cb) {
        cb(null);
      }
    }
  };
  const activeTab = { id: 2, windowId: 1, active: true, url: "https://example.com" };
  const resError = await captureTabScreenshot(activeTab, {}, errorApi);
  assert.equal(resError, null);

  // Thrown error inside captureVisibleTab returns null
  const throwingApi = {
    tabs: {
      captureVisibleTab() {
        throw new Error("Window was closed");
      }
    }
  };
  const resThrown = await captureTabScreenshot(activeTab, {}, throwingApi);
  assert.equal(resThrown, null);

  // Timeout triggers and resolves null without hanging
  const hangingApi = {
    tabs: {
      captureVisibleTab() {
        // Callback never called
      }
    }
  };
  const resTimeout = await captureTabScreenshot(activeTab, { timeoutMs: 20 }, hangingApi);
  assert.equal(resTimeout, null);
});

test("calculateDataUrlByteSize and extractDataUrlMimeType accurately analyze data URLs", () => {
  const jpegUrl = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
  assert.equal(extractDataUrlMimeType(jpegUrl), "image/jpeg");
  assert.equal(calculateDataUrlByteSize(jpegUrl), 10);

  const pngUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  assert.equal(extractDataUrlMimeType(pngUrl), "image/png");
  assert.equal(calculateDataUrlByteSize(pngUrl) > 50, true);

  assert.equal(calculateDataUrlByteSize("invalid-url"), 0);
  assert.equal(extractDataUrlMimeType("invalid-url"), "image/jpeg");
});

test("storeScreenshotMetadata captures complete metadata for valid images and fallback cards", () => {
  const sampleDataUrl = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD";
  const context = {
    url: "https://example.com/docs/api",
    title: "API Documentation",
    favicon: "https://example.com/favicon.ico",
    scroll: { x: 0, y: 350 },
    viewportWidth: 1920,
    viewportHeight: 1080
  };

  const record = storeScreenshotMetadata(sampleDataUrl, context, {
    width: 1920,
    height: 1080,
    devicePixelRatio: 2,
    capturedAt: 1700000000000
  });

  assert.equal(record.isFallback, false);
  assert.equal(record.dataUrl, sampleDataUrl);
  assert.equal(record.format, "image/jpeg");
  assert.equal(record.width, 1920);
  assert.equal(record.height, 1080);
  assert.equal(record.aspectRatio, 1.78);
  assert.equal(record.devicePixelRatio, 2);
  assert.equal(record.capturedAt, 1700000000000);
  assert.equal(record.capturedAtIso, new Date(1700000000000).toISOString());
  assert.equal(record.viewport.scrollY, 350);
  assert.equal(record.domain, "example.com");
  assert.equal(record.title, "API Documentation");
  assert.equal(validateScreenshotMetadata(record), true);

  const summary = formatScreenshotSummary(record);
  assert.match(summary, /JPEG/);
  assert.match(summary, /1920×1080/);

  // Fallback card when screenshot is null
  const fallbackRecord = storeScreenshotMetadata(null, context, { reason: "TAB_NOT_ACTIVE" });
  assert.equal(fallbackRecord.isFallback, true);
  assert.equal(fallbackRecord.fallbackType, "card");
  assert.equal(fallbackRecord.reason, "TAB_NOT_ACTIVE");
  assert.equal(fallbackRecord.domain, "example.com");
  assert.equal(validateScreenshotMetadata(fallbackRecord), true);
  assert.equal(formatScreenshotSummary(fallbackRecord), "Fallback preview card");
});

test("calculateScaledDimensions scales within bounds preserving aspect ratio", () => {
  // 4K downscale to 1280x720
  const scaled4k = calculateScaledDimensions(3840, 2160, 1280, 720);
  assert.equal(scaled4k.width, 1280);
  assert.equal(scaled4k.height, 720);
  assert.equal(scaled4k.scaled, true);

  // Ultrawide scaling
  const scaledUltra = calculateScaledDimensions(3440, 1440, 1280, 720);
  assert.equal(scaledUltra.width, 1280);
  assert.equal(scaledUltra.height, 536);
  assert.equal(scaledUltra.scaled, true);

  // Already smaller than max bounds
  const unscaled = calculateScaledDimensions(800, 600, 1280, 720);
  assert.equal(unscaled.width, 800);
  assert.equal(unscaled.height, 600);
  assert.equal(unscaled.scaled, false);

  // Invalid dimensions fallback
  const invalid = calculateScaledDimensions(0, -10, 1280, 720);
  assert.equal(invalid.width, 1280);
  assert.equal(invalid.height, 720);
  assert.equal(invalid.scaled, false);
});

test("compressScreenshot applies compression engine, downscales, and updates metadata", async () => {
  const originalDataUrl = "data:image/jpeg;base64," + "A".repeat(2000);
  const originalSize = calculateDataUrlByteSize(originalDataUrl);

  const mockCanvasEngine = {
    async compress(dataUrl, opts) {
      // Return a simulated compressed version (50% size)
      return {
        dataUrl: "data:image/jpeg;base64," + "A".repeat(1000),
        width: 1280,
        height: 720,
        quality: opts.targetQuality
      };
    }
  };

  const result = await compressScreenshot(
    { dataUrl: originalDataUrl, width: 2560, height: 1440 },
    { targetQuality: 0.5, maxWidth: 1280, maxHeight: 720, forceCompress: true },
    mockCanvasEngine
  );

  assert.equal(result.compressed, true);
  assert.equal(result.width, 1280);
  assert.equal(result.height, 720);
  assert.equal(result.originalSizeBytes, originalSize);
  assert.equal(result.sizeBytes < originalSize, true);
  assert.equal(result.compressionRatio < 1.0, true);
  assert.equal(validateScreenshotMetadata(result), true);

  // When screenshot is already small and forceCompress is false
  const tinyUrl = "data:image/jpeg;base64," + "A".repeat(100);
  const tinyResult = await compressScreenshot(
    { dataUrl: tinyUrl, width: 640, height: 480 },
    { maxSizeBytes: 50000, maxWidth: 1280, maxHeight: 720 },
    mockCanvasEngine
  );
  assert.equal(tinyResult.compressed, false);
  assert.equal(tinyResult.compressionRatio, 1.0);
});

test("enforceScreenshotSizeLimit preserves valid-sized screenshots and degrades oversized ones", () => {
  const context = {
    url: "https://example.com/dashboard",
    title: "Dashboard Overview",
    favicon: "https://example.com/icon.png"
  };

  // 1. Normal sized screenshot passes through intact
  const normalUrl = "data:image/jpeg;base64," + "A".repeat(5000);
  const normalResult = enforceScreenshotSizeLimit(normalUrl, context);
  assert.equal(normalResult.isFallback, false);
  assert.equal(normalResult.dataUrl, normalUrl);
  assert.equal(normalResult.truncated, false);

  // 2. Exceeding MAX_SCREENSHOT_DATA_LENGTH degrades to fallback card
  const oversizedLengthUrl = "data:image/jpeg;base64," + "A".repeat(MAX_SCREENSHOT_DATA_LENGTH + 100);
  const degradedLength = enforceScreenshotSizeLimit(oversizedLengthUrl, context);
  assert.equal(degradedLength.isFallback, true);
  assert.equal(degradedLength.truncated, true);
  assert.equal(degradedLength.reason, "SIZE_EXCEEDED");
  assert.equal(degradedLength.title, "Dashboard Overview");
  assert.equal(degradedLength.domain, "example.com");

  // 3. Exceeding custom maxSizeBytes threshold degrades to fallback card
  const mediumUrl = "data:image/jpeg;base64," + "A".repeat(8000);
  const degradedBytes = enforceScreenshotSizeLimit(mediumUrl, context, { maxSizeBytes: 2000 });
  assert.equal(degradedBytes.isFallback, true);
  assert.equal(degradedBytes.truncated, true);
  assert.equal(degradedBytes.reason, "SIZE_EXCEEDED");
  assert.ok(degradedBytes.originalSizeBytes > 2000);
});



