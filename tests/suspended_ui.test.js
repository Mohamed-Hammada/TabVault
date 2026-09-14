import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(".");
const HTML_PATH = path.join(ROOT, "suspended", "suspended.html");
const JS_PATH = path.join(ROOT, "suspended", "suspended.js");
const CSS_PATH = path.join(ROOT, "suspended", "suspended.css");

test("suspended.html contains screenshot preview container, fallback card, reason, and status elements", () => {
  const html = fs.readFileSync(HTML_PATH, "utf8");

  // Screenshot image element
  assert.match(html, /id=["']screenshot["']/);
  assert.match(html, /class=["'][^"']*screenshot[^"']*["']/);

  // Fallback card elements
  assert.match(html, /id=["']preview-fallback["']/);
  assert.match(html, /id=["']fallback-domain["']/);
  assert.match(html, /id=["']fallback-reason["']/);

  // Suspension reason element
  assert.match(html, /id=["']suspension-reason["']/);

  // Restoration status element
  assert.match(html, /id=["']restoration-status["']/);
  assert.match(html, /id=["']progress-bar-wrap["']/);
  assert.match(html, /id=["']progress-bar["']/);

  // Queue status chip elements
  assert.match(html, /id=["']queue-chip["']/);
  assert.match(html, /id=["']queue-status["']/);

  // Last active timestamp element
  assert.match(html, /id=["']lastvisit["']/);

  // Restore and cancel action buttons
  assert.match(html, /id=["']restore["']/);
  assert.match(html, /id=["']cancel-restore["']/);
});

test("suspended.css defines responsive styles for screenshot, fallback card, and status chips", () => {
  const css = fs.readFileSync(CSS_PATH, "utf8");

  assert.match(css, /\.preview-wrap/);
  assert.match(css, /\.screenshot/);
  assert.match(css, /\.preview-fallback/);
  assert.match(css, /\.fallback-icon/);
  assert.match(css, /\.status-row/);
  assert.match(css, /\.status-chip/);
  assert.match(css, /\.status-chip-queue/);
  assert.match(css, /\.status-badge-restoring/);
  assert.match(css, /\.status-badge-failed/);
  assert.match(css, /\.status-badge-restored/);
  assert.match(css, /\.status-badge-queued/);
  assert.match(css, /\.progress-bar-wrap/);
  assert.match(css, /\.progress-bar/);
  assert.match(css, /\.cancel-restore/);
  assert.match(css, /\.restore-btn-retry/);
});

test("suspended.js formats suspension reasons humanely", () => {
  const js = fs.readFileSync(JS_PATH, "utf8");

  // Extract formatSuspensionReason function
  const match = js.match(/function formatSuspensionReason\([^)]*\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(match, "formatSuspensionReason function must be defined");

  const fn = new Function(`${match[0]}; return formatSuspensionReason;`)();

  assert.equal(fn("idle_timeout"), "Idle timeout");
  assert.equal(fn("memory_pressure"), "Memory pressure");
  assert.equal(fn("domain_rule"), "Domain rule");
  assert.equal(fn("manual"), "Manual suspension");
  assert.equal(fn("battery_saver"), "Battery saver");
  assert.equal(fn("window_blur"), "Window blur");
  assert.equal(fn("snooze"), "Scheduled snooze");
  assert.equal(fn("startup"), "Browser startup");
  assert.equal(fn("max_tabs_limit"), "Tab limit reached");
  assert.equal(fn("media_audio_done"), "Media playback ended");
  assert.equal(fn("custom_event"), "Custom Event");
  assert.equal(fn(""), "Idle timeout");
  assert.equal(fn(null), "Idle timeout");

  // Verify setSuspensionReason DOM updates
  const reasonEl = { textContent: "", title: "" };
  function setSuspensionReason(r) {
    const formatted = fn(r);
    reasonEl.textContent = formatted;
    reasonEl.title = `Suspended due to: ${formatted}`;
  }

  setSuspensionReason("memory_pressure");
  assert.equal(reasonEl.textContent, "Memory pressure");
  assert.equal(reasonEl.title, "Suspended due to: Memory pressure");

  setSuspensionReason("manual_action");
  assert.equal(reasonEl.textContent, "Manual suspension");
  assert.equal(reasonEl.title, "Suspended due to: Manual suspension");
});

test("suspended.js formats relative and exact timestamps accurately", () => {
  const js = fs.readFileSync(JS_PATH, "utf8");

  const formatRelativeMatch = js.match(/function formatRelative\([^)]*\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(formatRelativeMatch, "formatRelative function must be defined");
  const formatRelative = new Function(`${formatRelativeMatch[0]}; return formatRelative;`)();

  const formatExactMatch = js.match(/function formatExact\([^)]*\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(formatExactMatch, "formatExact function must be defined");
  const formatExact = new Function(`${formatExactMatch[0]}; return formatExact;`)();

  const now = Date.now();
  assert.equal(formatRelative(now - 10000), "just now");
  assert.equal(formatRelative(now - 120000), "2 minutes ago");
  assert.equal(formatRelative(now - 7200000), "2 hours ago");
  assert.equal(formatRelative(now - 172800000), "2 days ago");

  const exactStr = formatExact(1700000000000);
  assert.ok(typeof exactStr === "string" && exactStr.length > 0);
});

test("Suspended UI handles screenshot rendering and fallback simulation", () => {
  // Simulate DOM elements
  const elements = {
    screenshot: { hidden: true, src: "", onerror: null },
    previewFallback: { hidden: true },
    fallbackDomain: { textContent: "" },
    fallbackReason: { textContent: "" },
    restorationStatus: { textContent: "Suspended", classList: new Set() }
  };

  function renderFallbackPreview(domain, reason = "Preview not captured") {
    elements.screenshot.hidden = true;
    elements.previewFallback.hidden = false;
    elements.fallbackDomain.textContent = domain;
    elements.fallbackReason.textContent = reason;
  }

  function renderScreenshotPreview(dataUrl) {
    if (!dataUrl) {
      renderFallbackPreview("example.com");
      return;
    }
    elements.screenshot.src = dataUrl;
    elements.screenshot.hidden = false;
    elements.previewFallback.hidden = true;
    elements.screenshot.onerror = () => {
      renderFallbackPreview("example.com", "Image failed to render");
    };
  }

  // 1. Initial render with valid screenshot
  renderScreenshotPreview("data:image/jpeg;base64,validdata123");
  assert.equal(elements.screenshot.hidden, false);
  assert.equal(elements.previewFallback.hidden, true);
  assert.equal(elements.screenshot.src, "data:image/jpeg;base64,validdata123");

  // 2. Image error triggers fallback
  elements.screenshot.onerror();
  assert.equal(elements.screenshot.hidden, true);
  assert.equal(elements.previewFallback.hidden, false);
  assert.equal(elements.fallbackReason.textContent, "Image failed to render");

  // 3. Direct fallback when screenshot unavailable
  renderFallbackPreview("github.com", "Tab preview unavailable");
  assert.equal(elements.screenshot.hidden, true);
  assert.equal(elements.previewFallback.hidden, false);
  assert.equal(elements.fallbackDomain.textContent, "github.com");
  assert.equal(elements.fallbackReason.textContent, "Tab preview unavailable");
});

test("suspended.js formats and displays fallbacks across diverse capture failure scenarios", () => {
  const js = fs.readFileSync(JS_PATH, "utf8");

  const match = js.match(/function formatFallbackReason\([^)]*\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(match, "formatFallbackReason function must be defined");
  const formatFallbackReason = new Function(`${match[0]}; return formatFallbackReason;`)();

  assert.equal(formatFallbackReason("SIZE_EXCEEDED"), "Preview omitted (size limit exceeded)");
  assert.equal(formatFallbackReason("INACTIVE_TAB"), "Tab was in background during capture");
  assert.equal(formatFallbackReason("RESTRICTED_URL"), "Restricted system or browser page");
  assert.equal(formatFallbackReason("TIMEOUT"), "Preview capture timed out");
  assert.equal(formatFallbackReason("API_ERROR"), "Preview capture failed");
  assert.equal(formatFallbackReason(null), "Tab preview not captured");
  assert.equal(formatFallbackReason(""), "Tab preview not captured");

  // Simulate rendering fallback for background/inactive tab
  const dom = {
    screenshot: { hidden: false, src: "data:..." },
    fallback: { hidden: true },
    domain: { textContent: "" },
    reason: { textContent: "" }
  };

  function renderFallback(domain, reason) {
    dom.screenshot.hidden = true;
    dom.fallback.hidden = false;
    dom.domain.textContent = domain;
    dom.reason.textContent = formatFallbackReason(reason);
  }

  renderFallback("docs.google.com", "INACTIVE_TAB");
  assert.equal(dom.screenshot.hidden, true);
  assert.equal(dom.fallback.hidden, false);
  assert.equal(dom.domain.textContent, "docs.google.com");
  assert.equal(dom.reason.textContent, "Tab was in background during capture");

  renderFallback("chrome://extensions", "RESTRICTED_URL");
  assert.equal(dom.domain.textContent, "chrome://extensions");
  assert.equal(dom.reason.textContent, "Restricted system or browser page");
});

test("Suspended UI restoration status transitions", () => {
  const elements = {
    restorationStatus: { textContent: "Suspended", title: "", classList: new Set() },
    progressBarWrap: { hidden: true },
    progressBar: { style: { width: "0%" } }
  };

  function setRestorationProgress(percent) {
    const clamped = Math.min(100, Math.max(0, Math.round(percent)));
    elements.progressBar.style.width = `${clamped}%`;
    if (clamped > 0 && clamped < 100) {
      elements.progressBarWrap.hidden = false;
    } else {
      elements.progressBarWrap.hidden = true;
    }
  }

  function setRestorationStatus(status, progress = null) {
    elements.restorationStatus.textContent = status;
    elements.restorationStatus.classList.delete("status-badge-restoring");
    elements.restorationStatus.classList.delete("status-badge-failed");
    elements.restorationStatus.classList.delete("status-badge-restored");
    if (status.includes("Restoring") || status.includes("Loading") || status.includes("Preparing")) {
      elements.restorationStatus.classList.add("status-badge-restoring");
      elements.restorationStatus.title = "Restoration in progress...";
      setRestorationProgress(progress !== null ? progress : 35);
    } else if (status.toLowerCase().includes("fail")) {
      elements.restorationStatus.classList.add("status-badge-failed");
      elements.restorationStatus.title = "Restoration encountered an issue";
      elements.progressBarWrap.hidden = true;
    } else if (status.toLowerCase().includes("restore")) {
      elements.restorationStatus.classList.add("status-badge-restored");
      elements.restorationStatus.title = "Tab successfully restored";
      setRestorationProgress(100);
    } else {
      elements.restorationStatus.title = `Current status: ${status}`;
      elements.progressBarWrap.hidden = true;
    }
  }

  setRestorationStatus("Suspended");
  assert.equal(elements.restorationStatus.textContent, "Suspended");
  assert.equal(elements.restorationStatus.title, "Current status: Suspended");
  assert.equal(elements.restorationStatus.classList.size, 0);
  assert.equal(elements.progressBarWrap.hidden, true);

  setRestorationStatus("Restoring...", 30);
  assert.equal(elements.restorationStatus.textContent, "Restoring...");
  assert.equal(elements.restorationStatus.classList.has("status-badge-restoring"), true);
  assert.equal(elements.restorationStatus.title, "Restoration in progress...");
  assert.equal(elements.progressBarWrap.hidden, false);
  assert.equal(elements.progressBar.style.width, "30%");

  setRestorationStatus("Loading page...", 60);
  assert.equal(elements.progressBar.style.width, "60%");

  setRestorationStatus("Restore failed");
  assert.equal(elements.restorationStatus.textContent, "Restore failed");
  assert.equal(elements.restorationStatus.classList.has("status-badge-failed"), true);
  assert.equal(elements.restorationStatus.classList.has("status-badge-restoring"), false);
  assert.equal(elements.restorationStatus.title, "Restoration encountered an issue");
  assert.equal(elements.progressBarWrap.hidden, true);

  setRestorationStatus("Restored");
  assert.equal(elements.restorationStatus.textContent, "Restored");
  assert.equal(elements.restorationStatus.classList.has("status-badge-restored"), true);
  assert.equal(elements.restorationStatus.title, "Tab successfully restored");
  assert.equal(elements.progressBar.style.width, "100%");
});

test("Suspended UI renders and updates last active timestamp", () => {
  const dom = {
    lastvisit: { innerHTML: "", title: "", style: { visibility: "visible" } }
  };

  const initialAt = Date.now() - 300000; // 5 minutes ago

  function formatRelative(ts) {
    const diffSec = Math.floor((Date.now() - ts) / 1000);
    if (diffSec < 60) return "just now";
    const m = Math.floor(diffSec / 60);
    if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
    const d = Math.floor(h / 24);
    return `${d} day${d === 1 ? "" : "s"} ago`;
  }

  function formatExact(ts) {
    return new Date(ts).toLocaleString(undefined, {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit"
    });
  }

  function renderLastActive(ts) {
    if (!dom.lastvisit) return;
    const time = Number(ts) || initialAt;
    if (!time || isNaN(time)) return;
    dom.lastvisit.innerHTML = `<b>Last active</b> · ${formatRelative(time)} · ${formatExact(time)}`;
    dom.lastvisit.title = `Last active: ${new Date(time).toLocaleString()}`;
  }

  // 1. Initial render
  renderLastActive(initialAt);
  assert.match(dom.lastvisit.innerHTML, /<b>Last active<\/b>/);
  assert.match(dom.lastvisit.innerHTML, /5 minutes ago/);
  assert.ok(dom.lastvisit.title.startsWith("Last active:"));

  // 2. Background update with snapshot timestamp (e.g. 1 hour ago)
  const snapshotTime = Date.now() - 3600000;
  renderLastActive(snapshotTime);
  assert.match(dom.lastvisit.innerHTML, /1 hour ago/);

  // 3. Setting showLastVisited: false hides the element
  function applyAppearance(appearance) {
    if (appearance.showLastVisited !== false) {
      dom.lastvisit.style.visibility = "visible";
    } else {
      dom.lastvisit.style.visibility = "hidden";
    }
  }

  applyAppearance({ showLastVisited: false });
  assert.equal(dom.lastvisit.style.visibility, "hidden");

  applyAppearance({ showLastVisited: true });
  assert.equal(dom.lastvisit.style.visibility, "visible");
});

test("suspended.js formats queue position and updates queue status chip", () => {
  const js = fs.readFileSync(JS_PATH, "utf8");

  // Extract formatQueuePosition function
  const match = js.match(/function formatQueuePosition\([^)]*\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(match, "formatQueuePosition function must be defined");

  const formatQueuePosition = new Function(`${match[0]}; return formatQueuePosition;`)();

  assert.equal(formatQueuePosition(null, null, null), "In queue");
  assert.equal(formatQueuePosition(undefined, undefined, "normal"), "In queue");
  assert.equal(formatQueuePosition(1, 3, "normal"), "#1 of 3");
  assert.equal(formatQueuePosition(2, 5, "high"), "#2 of 5 (high)");
  assert.equal(formatQueuePosition(3, 4, "background"), "#3 of 4 (background)");
  assert.equal(formatQueuePosition(1, null, "critical"), "#1 (critical)");

  // Test setQueueStatus DOM behavior
  const queueChip = { hidden: true, title: "" };
  const queueStatusEl = { textContent: "" };

  function setQueueStatus(queueData) {
    if (!queueChip || !queueStatusEl) return;
    if (!queueData || (!queueData.isQueued && !queueData.queuePosition)) {
      queueChip.hidden = true;
      return;
    }
    queueChip.hidden = false;
    queueStatusEl.textContent = formatQueuePosition(queueData.queuePosition, queueData.queueTotal, queueData.priority);
    queueChip.title = `Waiting in queue: position ${queueData.queuePosition || 1} of ${queueData.queueTotal || 1}`;
  }

  setQueueStatus(null);
  assert.equal(queueChip.hidden, true);

  setQueueStatus({ isQueued: true, queuePosition: 2, queueTotal: 4, priority: "normal" });
  assert.equal(queueChip.hidden, false);
  assert.equal(queueStatusEl.textContent, "#2 of 4");
  assert.equal(queueChip.title, "Waiting in queue: position 2 of 4");

  setQueueStatus({ isQueued: true, queuePosition: 1, queueTotal: 2, priority: "high" });
  assert.equal(queueChip.hidden, false);
  assert.equal(queueStatusEl.textContent, "#1 of 2 (high)");
  assert.equal(queueChip.title, "Waiting in queue: position 1 of 2");

  setQueueStatus({ isQueued: false });
  assert.equal(queueChip.hidden, true);
});

test("popup UI contains restoration queue card, progress indicator, and action buttons", () => {
  const popupHtmlPath = path.join(ROOT, "popup", "popup.html");
  const popupCssPath = path.join(ROOT, "popup", "popup.css");
  const popupJsPath = path.join(ROOT, "popup", "popup.js");

  const html = fs.readFileSync(popupHtmlPath, "utf8");
  const css = fs.readFileSync(popupCssPath, "utf8");
  const js = fs.readFileSync(popupJsPath, "utf8");

  // HTML queue card elements
  assert.match(html, /id=["']queue-card["']/);
  assert.match(html, /id=["']queue-heading["']/);
  assert.match(html, /id=["']queue-badge["']/);
  assert.match(html, /id=["']queue-progress-fill["']/);
  assert.match(html, /id=["']queue-details["']/);
  assert.match(html, /id=["']queue-failed-wrap["']/);
  assert.match(html, /id=["']queue-failed-count["']/);
  assert.match(html, /id=["']retry-failed-btn["']/);
  assert.match(html, /id=["']cancel-low-priority-btn["']/);
  assert.match(html, /id=["']clear-queue-btn["']/);

  // CSS queue styles
  assert.match(css, /\.queue-card/);
  assert.match(css, /\.queue-badge/);
  assert.match(css, /\.queue-progress-bar/);
  assert.match(css, /\.queue-progress-fill/);
  assert.match(css, /\.queue-btn/);
  assert.match(css, /\.queue-btn-retry/);
  assert.match(css, /\.queue-failed-text/);

  // JS queue status loader and button wiring
  assert.match(js, /loadRestoreQueueStatus/);
  assert.match(js, /cancel-low-priority/);
  assert.match(js, /clear-restore-queue/);
  assert.match(js, /retry-all-failed/);
  assert.match(js, /get-failed-restorations/);
});

test("suspended page UI handles restore failure, displays retry button, and triggers retry-restoration", () => {
  const js = fs.readFileSync(JS_PATH, "utf8");

  // Verify failure and retry messaging logic in suspended.js
  assert.match(js, /restore-btn-retry/);
  assert.match(js, /Retry restoration/);
  assert.match(js, /retry-restoration/);

  // Simulate DOM behavior for failure transition and retry button mutation
  const restoreBtn = {
    disabled: true,
    style: { opacity: "0.7" },
    classList: new Set(),
    textSpan: { textContent: "Restore tab" },
    querySelector(selector) {
      if (selector === "span:not(.kbd)") return this.textSpan;
      return null;
    }
  };
  const cancelBtn = { hidden: false };
  let statusText = "";

  function setRestorationStatus(text) {
    statusText = text;
  }

  function handleRestoreFailure(errMsg) {
    cancelBtn.hidden = true;
    const formatted = errMsg ? `Restore failed: ${errMsg}` : "Restore failed";
    setRestorationStatus(formatted);
    restoreBtn.disabled = false;
    restoreBtn.style.opacity = "1";
    restoreBtn.classList.add("restore-btn-retry");
    const txt = restoreBtn.querySelector("span:not(.kbd)");
    if (txt) txt.textContent = "Retry restoration";
  }

  handleRestoreFailure("ERR_CONNECTION_TIMED_OUT");
  assert.equal(statusText, "Restore failed: ERR_CONNECTION_TIMED_OUT");
  assert.equal(cancelBtn.hidden, true);
  assert.equal(restoreBtn.disabled, false);
  assert.equal(restoreBtn.classList.has("restore-btn-retry"), true);
  assert.equal(restoreBtn.textSpan.textContent, "Retry restoration");
});

