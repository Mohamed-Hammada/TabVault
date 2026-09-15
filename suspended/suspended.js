// TabVault suspended page — reads tab info from the URL hash, renders the
// card, applies user theme, and restores the tab on any interaction.
(() => {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const url = params.get("u") || "about:blank";
  const titleParam = params.get("t") || "Untitled tab";
  const fav = params.get("f") || "";
  const at = Number(params.get("at")) || Date.now();
  const wakeAt = Number(params.get("w")) || 0;

  const reasonParam = params.get("r") || "idle_timeout";
  const explanationParam = params.get("exp") || "";
  const snapshotIdParam = params.get("sid") || "";

  document.title = titleParam;

  // Set favicon to original site's favicon
  const faviconLink = document.querySelector("link[rel='icon']");
  if (fav) {
    try {
      const newLink = document.createElement("link");
      newLink.rel = "icon";
      newLink.href = fav;
      newLink.type = "image/x-icon";
      faviconLink.replaceWith(newLink);
    } catch (_) { /* ignore */ }
  }

  // Format suspension reason
  function formatSuspensionReason(r) {
    if (!r) return "Idle timeout";
    const lower = r.toLowerCase();
    if (lower.includes("idle")) return "Idle timeout";
    if (lower.includes("memory")) return "Memory pressure";
    if (lower.includes("domain")) return "Domain rule";
    if (lower.includes("manual")) return "Manual suspension";
    if (lower.includes("battery")) return "Battery saver";
    if (lower.includes("window")) return "Window blur";
    if (lower.includes("snooze")) return "Scheduled snooze";
    if (lower.includes("startup")) return "Browser startup";
    if (lower.includes("limit") || lower.includes("max_tabs")) return "Tab limit reached";
    if (lower.includes("audio") || lower.includes("media")) return "Media playback ended";
    return r.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  }

  const reasonEl = document.getElementById("suspension-reason");
  function setSuspensionReason(r, exp) {
    if (!reasonEl) return;
    const formatted = formatSuspensionReason(r);
    reasonEl.textContent = formatted;
    if (exp) {
      reasonEl.title = exp;
    } else {
      reasonEl.title = `Suspended due to: ${formatted}`;
    }
  }
  setSuspensionReason(reasonParam, explanationParam);

  const statusEl = document.getElementById("restoration-status");
  const progressBarWrap = document.getElementById("progress-bar-wrap");
  const progressBar = document.getElementById("progress-bar");
  const queueChip = document.getElementById("queue-chip");
  const queueStatusEl = document.getElementById("queue-status");

  function setRestorationProgress(percent) {
    if (!progressBarWrap || !progressBar) return;
    const clamped = Math.min(100, Math.max(0, Math.round(percent)));
    progressBar.style.width = `${clamped}%`;
    if (clamped > 0 && clamped < 100) {
      progressBarWrap.hidden = false;
    } else if (clamped >= 100) {
      setTimeout(() => {
        if (progressBarWrap) progressBarWrap.hidden = true;
      }, 500);
    }
  }

  function formatQueuePosition(position, total, priorityName) {
    if (!position && !total) return "In queue";
    const posStr = position ? `#${position}` : "";
    const totStr = total ? ` of ${total}` : "";
    const prioStr = priorityName && priorityName !== "normal" ? ` (${priorityName})` : "";
    return `${posStr}${totStr}${prioStr}`.trim();
  }

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

  function setRestorationStatus(status, progress = null, queueData = null) {
    if (!statusEl) return;
    statusEl.textContent = status;
    statusEl.classList.remove("status-badge-restoring", "status-badge-failed", "status-badge-restored", "status-badge-queued");
    if (status.includes("Queued")) {
      statusEl.classList.add("status-badge-queued");
      statusEl.title = "Waiting in restoration queue...";
      setQueueStatus(queueData || { isQueued: true });
      if (progress !== null) {
        setRestorationProgress(progress);
      } else {
        setRestorationProgress(5);
      }
    } else if (status.includes("Restoring") || status.includes("Loading") || status.includes("Preparing")) {
      statusEl.classList.add("status-badge-restoring");
      statusEl.title = "Restoration in progress...";
      setQueueStatus(null);
      if (progress !== null) {
        setRestorationProgress(progress);
      } else {
        setRestorationProgress(35);
      }
    } else if (status.toLowerCase().includes("fail")) {
      statusEl.classList.add("status-badge-failed");
      statusEl.title = "Restoration encountered an issue";
      setQueueStatus(null);
      if (progressBarWrap) progressBarWrap.hidden = true;
    } else if (status.toLowerCase().includes("restore")) {
      statusEl.classList.add("status-badge-restored");
      statusEl.title = "Tab successfully restored";
      setQueueStatus(null);
      setRestorationProgress(100);
    } else {
      statusEl.title = `Current status: ${status}`;
      setQueueStatus(null);
      if (progressBarWrap) progressBarWrap.hidden = true;
    }
  }
  setRestorationStatus("Suspended", 0);

  // Screenshot and visual fallback handling
  const screenshotImg = document.getElementById("screenshot");
  const previewFallback = document.getElementById("preview-fallback");
  const fallbackDomain = document.getElementById("fallback-domain");
  const fallbackReason = document.getElementById("fallback-reason");

  function formatFallbackReason(reason) {
    if (!reason) return "Tab preview not captured";
    const r = String(reason).toUpperCase();
    if (r.includes("SIZE")) return "Preview omitted (size limit exceeded)";
    if (r.includes("INACTIVE")) return "Tab was in background during capture";
    if (r.includes("RESTRICTED") || r.includes("PERMISSION")) return "Restricted system or browser page";
    if (r.includes("TIMEOUT")) return "Preview capture timed out";
    if (r.includes("ERROR") || r.includes("FAILED")) return "Preview capture failed";
    return reason;
  }

  function renderFallbackPreview(domain, reason = "Preview not captured") {
    if (screenshotImg) screenshotImg.hidden = true;
    if (previewFallback) previewFallback.hidden = false;
    if (fallbackDomain) fallbackDomain.textContent = domain || prettifyUrl(url);
    if (fallbackReason) fallbackReason.textContent = formatFallbackReason(reason);
  }

  function renderScreenshotPreview(dataUrl) {
    if (!dataUrl || !screenshotImg) {
      renderFallbackPreview(prettifyUrl(url));
      return;
    }
    screenshotImg.src = dataUrl;
    screenshotImg.hidden = false;
    if (previewFallback) previewFallback.hidden = true;
    screenshotImg.onerror = () => {
      renderFallbackPreview(prettifyUrl(url), "Image rendering failed");
    };
  }

  // Last active timestamp rendering
  const lv = document.getElementById("lastvisit");
  function renderLastActive(ts) {
    if (!lv) return;
    const time = Number(ts) || at;
    if (!time || isNaN(time)) return;
    lv.innerHTML = `<b>Last active</b> · ${formatRelative(time)} · ${formatExact(time)}`;
    lv.title = `Last active: ${new Date(time).toLocaleString()}`;
  }
  renderLastActive(at);

  // Request screenshot and tab metadata from background
  try {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        type: "get-tab-preview",
        url,
        snapshotId: snapshotIdParam
      }, (res) => {
        if (res?.screenshot && !res.screenshot.isFallback && res.screenshot.dataUrl) {
          renderScreenshotPreview(res.screenshot.dataUrl);
        } else {
          renderFallbackPreview(
            res?.screenshot?.domain || prettifyUrl(url),
            res?.screenshot?.reason || "Tab preview not captured"
          );
        }
        if (res?.reason) {
          setSuspensionReason(res.reason);
        }
        if (res?.timestamp) {
          renderLastActive(res.timestamp);
        }
      });
    } else {
      renderFallbackPreview(prettifyUrl(url));
    }
  } catch (_) {
    renderFallbackPreview(prettifyUrl(url));
  }

  // Apply settings (theme, accent, custom message, hint preferences)
  chrome.runtime?.sendMessage?.({ type: "get-settings" }, (res) => {
    if (!res?.ok) return;
    const a = res.data.appearance || {};
    const root = document.documentElement;

    // Theme
    let theme = a.theme;
    if (theme === "auto") {
      theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }
    root.setAttribute("data-theme", theme || "dark");

    // Accent
    if (a.accent) root.style.setProperty("--accent", a.accent);

    // Toggle hint visibility
    if (a.showRestoreHint === false) {
      const h = document.getElementById("hint");
      if (h) h.style.display = "none";
    }

    // Last-visited line (displays last active timestamp)
    if (a.showLastVisited !== false) {
      if (lv) lv.style.visibility = "visible";
    } else {
      if (lv) lv.style.visibility = "hidden";
    }

    // Custom message
    if (a.customMessage) {
      const c = document.getElementById("custom");
      c.textContent = a.customMessage;
      c.hidden = false;
    }

    // Auto-restore on focus (when user switches to the tab)
    if (a.autoRestoreOnFocus) {
      if (document.visibilityState === "visible") {
        // A discarded suspended tab reloads this page fresh on activation, so
        // it can start already-visible with no hidden->visible transition to
        // catch. The background service worker's own onActivated listener
        // restores it independently either way; this just keeps the on-page
        // "Restoring..." UI in sync with that.
        restore();
      } else {
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") restore();
        }, { once: true });
      }
    }
  });

  // Render text content
  document.getElementById("title").textContent = titleParam;
  const urlEl = document.getElementById("url");
  urlEl.textContent = prettifyUrl(url);
  urlEl.href = url;
  urlEl.title = url;

  // Favicon image element
  const img = document.getElementById("favicon");
  if (fav) {
    img.src = fav;
    img.onerror = () => { img.style.display = "none"; };
  } else {
    img.style.display = "none";
  }

  // Snooze badge (only when this suspension has a scheduled wake time)
  if (wakeAt > Date.now()) {
    const badge = document.getElementById("snooze-badge");
    const txt = document.getElementById("snooze-text");
    if (badge && txt) {
      txt.textContent = `Wakes ${formatWake(wakeAt)}`;
      badge.title = `Auto-restoring at ${formatExact(wakeAt)}`;
      badge.hidden = false;
    }
  }

  let restoring = false;
  const cancelBtn = document.getElementById("cancel-restore");

  function restore() {
    if (restoring) return;
    restoring = true;
    setRestorationStatus("Restoring...");
    if (cancelBtn) cancelBtn.hidden = false;
    const restoreBtn = document.getElementById("restore");
    if (restoreBtn) {
      restoreBtn.disabled = true;
      restoreBtn.style.opacity = "0.7";
    }

    const handleRestoreFailure = (errMsg) => {
      restoring = false;
      if (cancelBtn) cancelBtn.hidden = true;
      const formatted = errMsg ? `Restore failed: ${errMsg}` : "Restore failed";
      setRestorationStatus(formatted);
      if (restoreBtn) {
        restoreBtn.disabled = false;
        restoreBtn.style.opacity = "1";
        restoreBtn.classList.add("restore-btn-retry");
        const txt = restoreBtn.querySelector("span:not(.kbd)");
        if (txt) txt.textContent = "Retry restoration";
      }
    };

    let statusPollTimer = null;
    function startStatusPolling(tabId) {
      if (statusPollTimer) clearInterval(statusPollTimer);
      statusPollTimer = setInterval(() => {
        if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
          clearInterval(statusPollTimer);
          return;
        }
        chrome.runtime.sendMessage({ type: "get-restoration-status", tabId }, (res) => {
          if (chrome.runtime.lastError || !res?.ok || !res?.data) return;
          const data = res.data;
          if (data.isQueued) {
            restoring = true;
            if (cancelBtn) cancelBtn.hidden = false;
            setRestorationStatus("Queued", data.progress || 5, data);
          } else if (data.stage === "completed") {
            clearInterval(statusPollTimer);
            restoring = false;
            if (cancelBtn) cancelBtn.hidden = true;
            setRestorationStatus("Restored", 100);
          } else if (data.stage === "failed" || data.stage === "cancelled") {
            clearInterval(statusPollTimer);
            restoring = false;
            if (cancelBtn) cancelBtn.hidden = true;
            if (data.stage === "failed") {
              handleRestoreFailure(data.error);
            } else {
              setRestorationStatus("Restoration cancelled");
            }
          } else if (data.stage && data.stage !== "idle" && data.stage !== "deferred") {
            restoring = true;
            if (cancelBtn) cancelBtn.hidden = false;
            const stageLabel = data.stage.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
            setRestorationStatus(stageLabel, data.progress);
          }
        });
      }, 800);
    }

    try {
      if (!url || url === "about:blank") {
        throw new Error("Invalid restoration URL");
      }

      if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage && chrome.tabs?.getCurrent) {
        chrome.tabs.getCurrent((currentTab) => {
          if (currentTab?.id) {
            startStatusPolling(currentTab.id);
            const isRetry = restoreBtn?.classList.contains("restore-btn-retry");
            if (isRetry) {
              setRestorationStatus("Retrying restoration...", 20);
              chrome.runtime.sendMessage({
                type: "retry-restoration",
                tabId: currentTab.id,
                options: { source: "user", userInitiated: true, priority: 100, force: true }
              }, (res) => {
                if (chrome.runtime.lastError || !res?.ok) {
                  handleRestoreFailure(res?.result?.error || res?.error || chrome.runtime.lastError?.message);
                }
              });
              return;
            }
            // If already queued, promote it immediately with user priority!
            chrome.runtime.sendMessage({ type: "promote-restore", tabId: currentTab.id, priority: 100 }, (promoteRes) => {
              if (promoteRes?.ok) {
                setRestorationStatus("Queued (Prioritized)", 15, { isQueued: true, queuePosition: 1, priority: "user_requested" });
                return;
              }
              setRestorationStatus("Loading page...", 25);
              chrome.runtime.sendMessage({ type: "restore-tab", tabId: currentTab.id, options: { source: "user", userInitiated: true, priority: 100 } }, (res) => {
                if (chrome.runtime.lastError || !res?.ok) {
                  handleRestoreFailure(res?.error || chrome.runtime.lastError?.message);
                }
              });
            });
          } else {
            setRestorationStatus("Loading page...", 50);
            window.location.replace(url);
          }
        });
      } else {
        setRestorationStatus("Loading page...", 50);
        window.location.replace(url);
      }
    } catch (err) {
      handleRestoreFailure(err?.message);
    }
  }

  if (cancelBtn) {
    cancelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!restoring) return;
      restoring = false;
      cancelBtn.hidden = true;
      setRestorationStatus("Restoration cancelled");
      const restoreBtn = document.getElementById("restore");
      if (restoreBtn) {
        restoreBtn.disabled = false;
        restoreBtn.style.opacity = "1";
      }
      const progressBarWrap = document.getElementById("progress-bar-wrap");
      if (progressBarWrap) progressBarWrap.hidden = true;

      if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage && chrome.tabs?.getCurrent) {
        chrome.tabs.getCurrent((currentTab) => {
          if (currentTab?.id) {
            chrome.runtime.sendMessage({
              type: "cancel-restoration",
              tabId: currentTab.id,
              reason: "User cancelled from suspended tab"
            });
          }
        });
      }
    });
  }

  // Interaction → restore
  document.getElementById("restore").addEventListener("click", (e) => {
    e.stopPropagation();
    restore();
  });

  document.getElementById("url").addEventListener("click", (e) => {
    // Let middle-click / new-tab modifiers behave normally; plain click → restore in place
    if (!(e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1)) {
      e.preventDefault();
      restore();
    }
  });

  document.body.addEventListener("click", (e) => {
    // Click anywhere except the URL/footer button (handled above)
    if (e.target.closest("a, button")) return;
    restore();
  });

  document.addEventListener("keydown", (e) => {
    // Don't hijack when user is using browser shortcuts
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Tab") return;
    restore();
  });

  function prettifyUrl(u) {
    try {
      const x = new URL(u);
      return x.host + (x.pathname === "/" ? "" : x.pathname) + (x.search || "");
    } catch { return u; }
  }

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
    try {
      return new Date(ts).toLocaleString(undefined, {
        weekday: "short", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit"
      });
    } catch { return ""; }
  }

  function formatWake(ts) {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = ts - Date.now();
    if (diffMs < 60 * 60_000) {
      const m = Math.max(1, Math.round(diffMs / 60_000));
      return `in ${m} min`;
    }
    if (diffMs < 12 * 60 * 60_000) {
      const h = Math.round(diffMs / 3_600_000);
      return `in ${h}h`;
    }
    const sameDay = d.toDateString() === now.toDateString();
    const tomorrow = new Date(now.getTime() + 24 * 3_600_000).toDateString() === d.toDateString();
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    if (sameDay)   return `today at ${time}`;
    if (tomorrow)  return `tomorrow at ${time}`;
    const day = d.toLocaleDateString(undefined, { weekday: "short" });
    return `${day} at ${time}`;
  }

  // Initial check for in-flight/queued restoration
  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage && chrome.tabs?.getCurrent) {
    chrome.tabs.getCurrent((currentTab) => {
      if (currentTab?.id) {
        chrome.runtime.sendMessage({ type: "get-restoration-status", tabId: currentTab.id }, (res) => {
          if (res?.ok && res?.data) {
            const data = res.data;
            if (data.isQueued) {
              restoring = true;
              if (cancelBtn) cancelBtn.hidden = false;
              setRestorationStatus("Queued", data.progress || 5, data);
            } else if (data.isDeferred) {
              setRestorationStatus("Deferred", 0);
            } else if (data.isFailed || data.stage === "failed") {
              handleRestoreFailure(data.error);
            }
          }
        });
      }
    });
  }
})();
