/**
 * TabVault Screenshot & Visual Preview Module
 * Captures, compresses, stores, and renders lightweight tab previews
 * before suspension where Chrome API permissions and visibility allow.
 */

export const RESTRICTED_URL_SCHEMES = Object.freeze([
  "chrome:",
  "chrome-extension:",
  "chrome-untrusted:",
  "devtools:",
  "edge:",
  "about:",
  "data:",
  "javascript:",
  "view-source:"
]);

export const DEFAULT_SCREENSHOT_OPTIONS = Object.freeze({
  format: "jpeg", // "jpeg" | "png"
  quality: 60,    // 0-100 (60 delivers strong compression with high legibility)
  timeoutMs: 3000 // abort slow captures to prevent hanging suspension
});

/**
 * Checks if a given URL can be captured via Chrome's tabs.captureVisibleTab API.
 * Chrome blocks capturing internal browser pages, webstore, and restricted schemes.
 * @param {string} url
 * @returns {boolean}
 */
export function isCapturableUrl(url) {
  if (!url || typeof url !== "string") return false;
  const lower = url.trim().toLowerCase();
  for (const scheme of RESTRICTED_URL_SCHEMES) {
    if (lower.startsWith(scheme)) return false;
  }
  return true;
}

/**
 * Validates whether a tab can currently be captured via captureVisibleTab.
 * In Manifest V3, captureVisibleTab can only capture the currently active tab
 * in a window and requires activeTab or host permissions.
 * @param {object} tab
 * @param {object} [chromeApi]
 * @returns {{ canCapture: boolean, reason: string|null }}
 */
export function canCaptureTabScreenshot(tab = {}, chromeApi = typeof chrome !== "undefined" ? chrome : null) {
  if (!chromeApi || !chromeApi.tabs || typeof chromeApi.tabs.captureVisibleTab !== "function") {
    return { canCapture: false, reason: "API_UNAVAILABLE" };
  }

  if (!tab || typeof tab !== "object") {
    return { canCapture: false, reason: "INVALID_TAB" };
  }

  if (tab.url && !isCapturableUrl(tab.url)) {
    return { canCapture: false, reason: "RESTRICTED_URL" };
  }

  // captureVisibleTab requires the target tab to be active in its window
  if (!tab.active) {
    return { canCapture: false, reason: "TAB_NOT_ACTIVE" };
  }

  if (tab.status === "loading") {
    // Note: tab can still be captured while loading if partial frame exists, but may be incomplete
    return { canCapture: true, reason: "TAB_LOADING" };
  }

  return { canCapture: true, reason: null };
}

/**
 * Captures a screenshot data URL of the specified tab if API permissions and visibility allow.
 * Supports both (tab, options, chromeApi) and (tab, chromeApi) signatures.
 * @param {object} tab - Chrome tab object
 * @param {object} [options={}] - Format and quality settings or chromeApi
 * @param {object} [chromeApi] - Injected chrome API (for testing)
 * @returns {Promise<string|null>} Data URL of captured screenshot or null
 */
export async function captureTabScreenshot(
  tab = {},
  options = {},
  chromeApi = typeof chrome !== "undefined" ? chrome : null
) {
  let resolvedOpts = options;
  let resolvedChrome = chromeApi;

  // Polymorphic support for (tab, mockChromeApi) signature
  if (options && (options.tabs || options.runtime)) {
    resolvedChrome = options;
    resolvedOpts = {};
  } else if (!resolvedChrome && typeof chrome !== "undefined") {
    resolvedChrome = chrome;
  }

  const check = canCaptureTabScreenshot(tab, resolvedChrome);
  if (!check.canCapture) {
    return null;
  }

  const opts = {
    ...DEFAULT_SCREENSHOT_OPTIONS,
    ...resolvedOpts
  };

  const captureDetails = {
    format: opts.format === "png" ? "png" : "jpeg"
  };

  if (captureDetails.format === "jpeg") {
    captureDetails.quality = typeof opts.quality === "number"
      ? Math.max(1, Math.min(100, Math.round(opts.quality)))
      : DEFAULT_SCREENSHOT_OPTIONS.quality;
  }

  return new Promise((resolve) => {
    let resolved = false;

    // Timeout guard to prevent hanging tab suspension
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    }, opts.timeoutMs || DEFAULT_SCREENSHOT_OPTIONS.timeoutMs);

    try {
      resolvedChrome.tabs.captureVisibleTab(tab.windowId, captureDetails, (dataUrl) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);

        if (resolvedChrome.runtime && resolvedChrome.runtime.lastError) {
          resolve(null);
        } else if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/")) {
          resolve(dataUrl);
        } else {
          resolve(null);
        }
      });
    } catch (_) {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(null);
      }
    }
  });
}

export const MAX_SCREENSHOT_DATA_LENGTH = 150000;
export const MAX_SCREENSHOT_BYTE_SIZE = 120 * 1024; // 120 KB

/**
 * Validates and enforces maximum size limits on a screenshot.
 * If screenshot exceeds byte size or length thresholds, degrades to a lightweight preview card.
 * @param {string|object} screenshot - Data URL or screenshot object
 * @param {object} [context={}] - Tab context (title, favicon, url)
 * @param {object} [options={}] - Limit overrides (maxSizeBytes, maxDataLength)
 * @returns {object} Screenshot record within allowed limits or degraded fallback card
 */
export function enforceScreenshotSizeLimit(screenshot, context = {}, options = {}) {
  const maxBytes = options.maxSizeBytes || MAX_SCREENSHOT_BYTE_SIZE;
  const maxLength = options.maxDataLength || MAX_SCREENSHOT_DATA_LENGTH;

  const record = storeScreenshotMetadata(screenshot, context, options);
  if (record.isFallback) {
    return record;
  }

  const isLengthExceeded = record.dataLength > maxLength;
  const isBytesExceeded = record.sizeBytes > maxBytes;

  if (isLengthExceeded || isBytesExceeded) {
    return {
      isFallback: true,
      truncated: true,
      reason: "SIZE_EXCEEDED",
      originalSizeBytes: record.sizeBytes,
      originalDataLength: record.dataLength,
      title: context.title || record.title || "Untitled Tab",
      favicon: context.favicon || record.favicon || "",
      domain: record.domain || "",
      capturedAt: record.capturedAt,
      capturedAtIso: record.capturedAtIso
    };
  }

  return record;
}

/**
 * Calculates byte size of a base64-encoded data URL accurately.
 * @param {string} dataUrl
 * @returns {number}
 */
export function calculateDataUrlByteSize(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.includes(",")) return 0;
  const base64Str = dataUrl.split(",")[1] || "";
  let padding = 0;
  if (base64Str.endsWith("==")) padding = 2;
  else if (base64Str.endsWith("=")) padding = 1;
  return Math.max(0, Math.floor((base64Str.length * 3) / 4) - padding);
}

/**
 * Extracts MIME format from a data URL.
 * @param {string} dataUrl
 * @returns {string} e.g. "image/jpeg", "image/png"
 */
export function extractDataUrlMimeType(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return "image/jpeg";
  const match = dataUrl.match(/^data:([^;]+);/);
  return match ? match[1].toLowerCase() : "image/jpeg";
}

/**
 * Stores and structures complete screenshot metadata.
 * @param {string|object} screenshot - Data URL or raw screenshot descriptor
 * @param {object} [context={}] - Contextual tab info (title, favicon, url, scroll, viewport)
 * @param {object} [options={}] - Override parameters
 * @returns {object} Standardized screenshot record with metadata
 */
export function storeScreenshotMetadata(screenshot, context = {}, options = {}) {
  const now = options.capturedAt || Date.now();
  const getDomain = () => {
    try {
      return context.url ? new URL(context.url).hostname : "";
    } catch {
      return "";
    }
  };

  // Fallback card descriptor when no screenshot data exists
  if (!screenshot) {
    return {
      isFallback: true,
      fallbackType: options.fallbackType || "card",
      reason: options.reason || "NO_DATA",
      title: context.title || "Untitled Tab",
      favicon: context.favicon || "",
      domain: getDomain(),
      capturedAt: now,
      capturedAtIso: new Date(now).toISOString()
    };
  }

  let dataUrl = "";
  let width = options.width ?? null;
  let height = options.height ?? null;
  let devicePixelRatio = options.devicePixelRatio ?? 1;
  let format = options.format || "image/jpeg";
  let capturedAt = now;

  if (typeof screenshot === "string") {
    dataUrl = screenshot.trim();
  } else if (typeof screenshot === "object") {
    dataUrl = (screenshot.dataUrl || screenshot.url || "").trim();
    format = screenshot.format || format;
    width = screenshot.width ?? width;
    height = screenshot.height ?? height;
    devicePixelRatio = screenshot.devicePixelRatio ?? devicePixelRatio;
    capturedAt = screenshot.capturedAt || capturedAt;
  }

  if (!dataUrl.startsWith("data:image/")) {
    return {
      isFallback: true,
      fallbackType: "placeholder",
      reason: "INVALID_DATA_URL",
      title: context.title || "Untitled Tab",
      favicon: context.favicon || "",
      domain: getDomain(),
      capturedAt,
      capturedAtIso: new Date(capturedAt).toISOString()
    };
  }

  const detectedMime = extractDataUrlMimeType(dataUrl);
  const sizeBytes = calculateDataUrlByteSize(dataUrl);
  const dataLength = dataUrl.length;

  const aspectRatio = (typeof width === "number" && typeof height === "number" && height > 0)
    ? parseFloat((width / height).toFixed(2))
    : null;

  return {
    isFallback: false,
    truncated: false,
    dataUrl,
    format: detectedMime || format,
    width,
    height,
    aspectRatio,
    devicePixelRatio,
    sizeBytes,
    dataLength,
    capturedAt,
    capturedAtIso: new Date(capturedAt).toISOString(),
    viewport: {
      scrollX: context.scroll?.x ?? context.scrollX ?? 0,
      scrollY: context.scroll?.y ?? context.scrollY ?? 0,
      viewportWidth: context.viewportWidth ?? null,
      viewportHeight: context.viewportHeight ?? null
    },
    title: context.title || "",
    favicon: context.favicon || "",
    domain: getDomain()
  };
}

/**
 * Validates the schema and structure of a screenshot metadata record.
 * @param {object} record
 * @returns {boolean}
 */
export function validateScreenshotMetadata(record) {
  if (!record || typeof record !== "object") return false;
  if (typeof record.isFallback !== "boolean") return false;
  if (typeof record.capturedAt !== "number") return false;

  if (!record.isFallback) {
    if (typeof record.dataUrl !== "string" || !record.dataUrl.startsWith("data:image/")) return false;
    if (typeof record.format !== "string") return false;
    if (typeof record.sizeBytes !== "number" || record.sizeBytes < 0) return false;
  }
  return true;
}

/**
 * Returns a human-friendly summary string of screenshot metadata.
 * @param {object} record
 * @returns {string} e.g. "JPEG · 45 KB · 1280x720"
 */
export function formatScreenshotSummary(record) {
  if (!record || typeof record !== "object") return "No preview";
  if (record.isFallback) return "Fallback preview card";

  const parts = [];
  const fmt = (record.format || "image/jpeg").replace("image/", "").toUpperCase();
  parts.push(fmt);

  if (record.sizeBytes) {
    const kb = (record.sizeBytes / 1024).toFixed(1);
    parts.push(`${kb} KB`);
  }

  if (record.width && record.height) {
    parts.push(`${record.width}×${record.height}`);
  }

  return parts.join(" · ");
}

export const DEFAULT_COMPRESSION_OPTIONS = Object.freeze({
  maxWidth: 1280,
  maxHeight: 720,
  targetQuality: 0.6,
  format: "image/jpeg",
  maxSizeBytes: 100 * 1024 // 100KB
});

/**
 * Calculates scaled dimensions preserving aspect ratio within max bounds.
 * @param {number} width
 * @param {number} height
 * @param {number} [maxWidth=1280]
 * @param {number} [maxHeight=720]
 * @returns {{ width: number, height: number, scaled: boolean }}
 */
export function calculateScaledDimensions(width, height, maxWidth = 1280, maxHeight = 720) {
  if (!width || !height || width <= 0 || height <= 0) {
    return { width: maxWidth, height: maxHeight, scaled: false };
  }

  let targetWidth = width;
  let targetHeight = height;

  if (targetWidth > maxWidth) {
    targetHeight = Math.round((targetHeight * maxWidth) / targetWidth);
    targetWidth = maxWidth;
  }

  if (targetHeight > maxHeight) {
    targetWidth = Math.round((targetWidth * maxHeight) / targetHeight);
    targetHeight = maxHeight;
  }

  const scaled = targetWidth !== width || targetHeight !== height;
  return { width: targetWidth, height: targetHeight, scaled };
}

/**
 * Converts a Blob to a data URL string across browser & worker environments.
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export async function blobToDataUrl(blob) {
  if (typeof FileReader !== "undefined") {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
  if (blob && typeof blob.arrayBuffer === "function") {
    const buf = await blob.arrayBuffer();
    const base64 = typeof Buffer !== "undefined"
      ? Buffer.from(buf).toString("base64")
      : "";
    return `data:${blob.type || "image/jpeg"};base64,${base64}`;
  }
  return "";
}

/**
 * Compresses a screenshot preview using downscaling and quality tuning where supported.
 * @param {string|object} screenshot - Data URL or screenshot object
 * @param {object} [options={}] - Compression options
 * @param {object} [canvasEngine] - Optional injected canvas adapter
 * @returns {Promise<object>} Compressed screenshot metadata record
 */
export async function compressScreenshot(screenshot, options = {}, canvasEngine = null) {
  const opts = {
    ...DEFAULT_COMPRESSION_OPTIONS,
    ...options
  };

  const record = storeScreenshotMetadata(screenshot, options.context || {}, options);
  if (record.isFallback || !record.dataUrl) {
    return record;
  }

  const originalSizeBytes = record.sizeBytes;

  // If already under size limit and dimensions are within bounds
  if (
    originalSizeBytes <= opts.maxSizeBytes &&
    (!record.width || record.width <= opts.maxWidth) &&
    (!record.height || record.height <= opts.maxHeight) &&
    !options.forceCompress
  ) {
    return {
      ...record,
      compressed: false,
      compressionRatio: 1.0,
      originalSizeBytes
    };
  }

  // If injected canvas engine provided (e.g. for testing)
  if (canvasEngine && typeof canvasEngine.compress === "function") {
    try {
      const result = await canvasEngine.compress(record.dataUrl, opts);
      if (result && result.dataUrl) {
        const compressedSize = calculateDataUrlByteSize(result.dataUrl);
        return {
          ...record,
          ...result,
          compressed: true,
          originalSizeBytes,
          sizeBytes: compressedSize,
          compressionRatio: originalSizeBytes > 0 ? parseFloat((compressedSize / originalSizeBytes).toFixed(2)) : 1.0
        };
      }
    } catch (_) {}
  }

  // OffscreenCanvas support in ServiceWorker / browser environment
  if (typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap === "function") {
    try {
      const res = await fetch(record.dataUrl);
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);

      const dims = calculateScaledDimensions(bitmap.width, bitmap.height, opts.maxWidth, opts.maxHeight);
      const canvas = new OffscreenCanvas(dims.width, dims.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0, dims.width, dims.height);

      const targetMime = opts.format === "png" ? "image/png" : "image/jpeg";
      const compressedBlob = await canvas.convertToBlob({
        type: targetMime,
        quality: opts.targetQuality
      });

      const compressedDataUrl = await blobToDataUrl(compressedBlob);
      const compressedSize = calculateDataUrlByteSize(compressedDataUrl);

      return {
        ...record,
        dataUrl: compressedDataUrl,
        format: targetMime,
        width: dims.width,
        height: dims.height,
        aspectRatio: parseFloat((dims.width / dims.height).toFixed(2)),
        sizeBytes: compressedSize,
        dataLength: compressedDataUrl.length,
        compressed: true,
        compressionRatio: originalSizeBytes > 0 ? parseFloat((compressedSize / originalSizeBytes).toFixed(2)) : 1.0,
        originalSizeBytes
      };
    } catch (_) {}
  }

  return {
    ...record,
    compressed: false,
    compressionRatio: 1.0,
    originalSizeBytes
  };
}

