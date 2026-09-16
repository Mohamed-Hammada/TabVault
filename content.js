// TabVault content script — detects "dirty" form state so the suspender
// knows when to leave a tab alone. Lightweight and passive.
(() => {
  if (window.__tabvault_injected) return;
  window.__tabvault_injected = true;

  let dirty = false;
  let lastReported = null;
  let lastReportedDetails = null;

  // Track elements that the user has actively typed into or modified
  const userModifiedElements = new WeakSet();

  // Excluded input types that do NOT represent unsaved user draft/form data:
  // - checkbox/radio/button/submit/reset: standard page controls or actions
  // - hidden: not user visible or editable
  // - range/color: sliders/color pickers in WebGL/configurators/SPAs (always have default values like 50, #000000)
  // - search: search bars/queries do not represent unsaved drafts that should prevent tab suspension
  // - file/image: file selectors/image buttons
  const EXCLUDED_INPUT_TYPES = new Set([
    "checkbox", "radio", "submit", "button", "reset", "hidden",
    "range", "color", "search", "image", "file"
  ]);

  function getElementSelector(el) {
    if (!el || typeof el !== "object") return "unknown";
    try {
      if (el.id) return `#${typeof CSS !== "undefined" && CSS.escape ? CSS.escape(el.id) : el.id}`;
      if (el.name) {
        const tag = (el.tagName || "").toLowerCase();
        return `${tag}[name="${typeof CSS !== "undefined" && CSS.escape ? CSS.escape(el.name) : el.name}"]`;
      }
      if (el.className && typeof el.className === "string") {
        const firstClass = el.className.trim().split(/\s+/)[0];
        if (firstClass) {
          const tag = (el.tagName || "").toLowerCase();
          return `${tag}.${typeof CSS !== "undefined" && CSS.escape ? CSS.escape(firstClass) : firstClass}`;
        }
      }
      const tag = (el.tagName || "element").toLowerCase();
      if (el.type) return `${tag}[type="${el.type}"]`;
      return tag;
    } catch (_) {
      return (el.tagName || "element").toLowerCase();
    }
  }

  function isUserEditable(el) {
    if (!el || el.isConnected === false) return false;
    if (el.disabled) return false;
    if (el.readOnly) return false;

    try {
      if (el.hidden) return false;
      if (typeof el.getAttribute === "function" && el.getAttribute("aria-hidden") === "true") return false;

      if (el.style) {
        if (el.style.display === "none" || el.style.visibility === "hidden" || el.style.opacity === "0") {
          return false;
        }
      }

      if (typeof window.getComputedStyle === "function") {
        const style = window.getComputedStyle(el);
        if (style) {
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
            return false;
          }
          if (el.offsetParent === null && style.position !== "fixed") {
            return false;
          }
        }
      } else if (el.offsetParent === null && el.style?.position !== "fixed") {
        return false;
      }
    } catch (_) { /* fallback */ }

    return true;
  }

  function evaluateElement(el) {
    if (!el) return null;
    const tag = (el.tagName || "").toUpperCase();
    const isContentEditable = Boolean(el.isContentEditable || el.contentEditable === true || el.contentEditable === "true");

    const userInteracted = userModifiedElements.has(el);

    if (tag === "INPUT") {
      const type = (el.type || "text").toLowerCase();
      if (EXCLUDED_INPUT_TYPES.has(type)) return null;
      if (!isUserEditable(el)) return null;

      const val = (el.value || "").trim();
      const hasValue = val.length > 0;
      const valueChanged = el.defaultValue !== undefined ? el.value !== el.defaultValue : userInteracted;

      const isDirty = hasValue && valueChanged && userInteracted;

      return {
        isDirty,
        elementType: "input",
        inputType: type,
        selector: getElementSelector(el),
        hasValue,
        valueChanged,
        isUserEditable: true,
        userInteracted
      };
    }

    if (tag === "TEXTAREA") {
      if (!isUserEditable(el)) return null;
      const val = (el.value || "").trim();
      const hasValue = val.length > 0;
      const valueChanged = el.defaultValue !== undefined ? el.value !== el.defaultValue : userInteracted;

      const isDirty = hasValue && valueChanged && userInteracted;

      return {
        isDirty,
        elementType: "textarea",
        inputType: null,
        selector: getElementSelector(el),
        hasValue,
        valueChanged,
        isUserEditable: true,
        userInteracted
      };
    }

    if (isContentEditable) {
      if (!isUserEditable(el)) return null;
      const val = (el.innerText || el.textContent || "").trim();
      const hasValue = val.length > 0;
      const isDirty = hasValue && userInteracted;

      return {
        isDirty,
        elementType: "contenteditable",
        inputType: null,
        selector: getElementSelector(el),
        hasValue,
        valueChanged: userInteracted,
        isUserEditable: true,
        userInteracted
      };
    }

    return null;
  }

  function checkDirty() {
    const fields = document.querySelectorAll("input, textarea, [contenteditable=''], [contenteditable='true']");
    for (const f of fields) {
      const evaluation = evaluateElement(f);
      if (evaluation && evaluation.isDirty) {
        return { isDirty: true, details: evaluation };
      }
    }
    return { isDirty: false, details: null };
  }

  function report(state, details = null) {
    if (state === lastReported && (!state || JSON.stringify(details) === JSON.stringify(lastReportedDetails))) return;
    lastReported = state;
    lastReportedDetails = details;

    if (state && details) {
      console.log(
        `[TabVault] form-input detected:\n` +
        `  elementType=${details.elementType}\n` +
        `  selector=${details.selector}\n` +
        `  hasValue=${details.hasValue}\n` +
        `  valueChanged=${details.valueChanged}\n` +
        `  isUserEditable=${details.isUserEditable}`
      );
    }

    try {
      chrome.runtime.sendMessage({
        type: "report-form-input",
        hasFormInput: state,
        details
      });
    } catch (_) { /* extension might be reloading */ }
  }

  function onChange() {
    const next = checkDirty();
    if (next.isDirty !== dirty) {
      dirty = next.isDirty;
      report(dirty, next.details);
    }
  }

  // Throttle: a single rAF chain is enough; input events fire often.
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      onChange();
    });
  }

  // Only genuine, browser-generated events (isTrusted === true) count as user
  // interaction. A page's own JavaScript routinely dispatches synthetic
  // input/change events (el.dispatchEvent(new Event("input"))) to sync its own
  // reactive state when it sets a field's value programmatically — SPA/WebGL
  // configurators like 3DTuning do this constantly on load and on every UI
  // interaction that isn't literal typing. Without this check, that synthetic
  // event alone marks the field "user-modified," and since the framework also
  // sets .value away from defaultValue, the field would look identical to a
  // real unsaved edit — permanently blocking suspension of a tab no one is
  // actually mid-edit on.
  document.addEventListener("input", (e) => {
    if (e.target && e.target.nodeType === 1 && e.isTrusted) {
      userModifiedElements.add(e.target);
    }
    schedule();
  }, true);

  document.addEventListener("change", (e) => {
    if (e.target && e.target.nodeType === 1 && e.isTrusted) {
      userModifiedElements.add(e.target);
    }
    schedule();
  }, true);

  // Submitting or resetting a form clears dirty state
  document.addEventListener("submit", () => {
    setTimeout(() => {
      dirty = false;
      report(false, null);
    }, 0);
  }, true);

  document.addEventListener("reset", () => {
    setTimeout(() => {
      onChange();
    }, 0);
  }, true);

  // Initial check after first paint — runs cleanly with no false positives
  if (document.readyState === "complete" || document.readyState === "interactive") {
    schedule();
  } else {
    window.addEventListener("DOMContentLoaded", schedule, { once: true });
  }

  // SPA route scroll tracking
  function getRouteKey(loc = window.location) {
    if (!loc) return "/";
    return (loc.pathname || "") + (loc.search || "") + (loc.hash || "");
  }

  let currentSpaRoute = getRouteKey();
  const spaRouteScrolls = {};

  function captureCurrentScroll() {
    const docEl = document.documentElement;
    const body = document.body;
    const x = Math.max(0, Math.floor(window.scrollX || window.pageXOffset || (docEl && docEl.scrollLeft) || (body && body.scrollLeft) || 0));
    const y = Math.max(0, Math.floor(window.scrollY || window.pageYOffset || (docEl && docEl.scrollTop) || (body && body.scrollTop) || 0));
    const maxScrollX = Math.max(0, (docEl ? docEl.scrollWidth : 0) - (window.innerWidth || 0));
    const maxScrollY = Math.max(0, (docEl ? docEl.scrollHeight : 0) - (window.innerHeight || 0));
    const percentX = maxScrollX > 0 ? Math.min(100, Math.max(0, parseFloat(((x / maxScrollX) * 100).toFixed(2)))) : 0;
    const percentY = maxScrollY > 0 ? Math.min(100, Math.max(0, parseFloat(((y / maxScrollY) * 100).toFixed(2)))) : 0;
    return { x, y, percentX, percentY };
  }

  function recordRouteScroll() {
    if (!currentSpaRoute) return;
    spaRouteScrolls[currentSpaRoute] = {
      ...captureCurrentScroll(),
      route: currentSpaRoute,
      timestamp: Date.now()
    };
  }

  // Intercept SPA navigation APIs
  try {
    if (window.history && typeof window.history.pushState === "function") {
      const origPush = window.history.pushState;
      window.history.pushState = function (data, unused, url) {
        recordRouteScroll();
        const ret = origPush.apply(this, arguments);
        currentSpaRoute = getRouteKey();
        scheduleCallStateReport();
        return ret;
      };
    }
    if (window.history && typeof window.history.replaceState === "function") {
      const origReplace = window.history.replaceState;
      window.history.replaceState = function (data, unused, url) {
        const ret = origReplace.apply(this, arguments);
        currentSpaRoute = getRouteKey();
        scheduleCallStateReport();
        return ret;
      };
    }
    window.addEventListener?.("popstate", () => {
      recordRouteScroll();
      currentSpaRoute = getRouteKey();
      scheduleCallStateReport();
    });
    window.addEventListener?.("hashchange", () => {
      recordRouteScroll();
      currentSpaRoute = getRouteKey();
      scheduleCallStateReport();
    });
  } catch (_) { /* safe in restricted contexts */ }

  // ─── Call detection ────────────────────────────────────────────────────
  // Protects meeting tabs from suspension. Signals are reported to
  // background.js, which derives the actual protection level (see
  // lib/call-detection.js) — this script only gathers raw signals.
  //
  // Two independent sources feed this, deliberately not just one:
  //
  // 1. A DOM scan for live <video>/<audio> elements. Media elements reflect
  //    *current* state regardless of when the underlying stream was
  //    created, which is what makes this work retroactively for calls that
  //    started before this script was injected (extension reload,
  //    content-script reconnect, a tab that was already mid-call) — no
  //    monkey-patched API call needs to have been observed.
  //
  // 2. content-mainworld.js, injected as a separate "world": "MAIN" content
  //    script. This script (content.js) runs in the isolated world, which
  //    has its own copies of `navigator`/`RTCPeerConnection` — wrapping
  //    those APIs *here* would not intercept the page's own calls to them.
  //    The main-world script does the actual wrapping in the page's real JS
  //    context and hands signals over via window.postMessage, since a
  //    MAIN-world script has no access to chrome.* APIs to report directly.
  //    If that script's wrapping is ever bypassed (raced, blocked, or a
  //    future Chrome restriction), the DOM scan above still independently
  //    confirms any call that renders local media, which is the common case.
  function countLiveMediaTracks() {
    let count = 0;
    for (const el of document.querySelectorAll("video, audio")) {
      const stream = el.srcObject;
      if (!stream || typeof stream.getTracks !== "function") continue;
      for (const track of stream.getTracks()) {
        if (track.readyState === "live") count++;
      }
    }
    return count;
  }

  let getUserMediaActive = false;
  let screenShareActive = false;
  let latestRtcConnectionState = null;

  const MAINWORLD_SOURCE = "tabvault-mainworld";
  window.addEventListener("message", (event) => {
    // Only trust messages from this same window (not an embedded iframe,
    // which gets its own content.js instance) carrying our marker. A hostile
    // page script sharing this same global could still forge these — the
    // DOM scan above doesn't depend on this channel being trustworthy.
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== MAINWORLD_SOURCE) return;

    if ("getUserMediaActive" in data) getUserMediaActive = !!data.getUserMediaActive;
    if ("screenShareActive" in data) screenShareActive = !!data.screenShareActive;
    if ("rtcConnectionState" in data) latestRtcConnectionState = data.rtcConnectionState;
    scheduleCallStateReport();
  });

  let callReportScheduled = false;
  function scheduleCallStateReport() {
    if (callReportScheduled) return;
    callReportScheduled = true;
    requestAnimationFrame(() => {
      callReportScheduled = false;
      reportCallState();
    });
  }

  function reportCallState() {
    try {
      chrome.runtime.sendMessage({
        type: "report-call-state",
        liveMediaTrackCount: countLiveMediaTracks(),
        getUserMediaActive,
        screenShareActive,
        rtcConnectionState: latestRtcConnectionState
      });
    } catch (_) { /* extension might be reloading */ }
  }

  chrome.runtime?.onMessage?.addListener((message) => {
    if (message?.type === "request-call-state") {
      reportCallState();
    }
  });

  // Periodic re-scan as defense in depth for missed track/connection events.
  setInterval(reportCallState, 5000);

  if (document.readyState === "complete" || document.readyState === "interactive") {
    reportCallState();
  } else {
    window.addEventListener("DOMContentLoaded", reportCallState, { once: true });
  }

  // Handle queries from background for snapshot capture
  chrome.runtime?.onMessage?.addListener((message, sender, sendResponse) => {
    if (message && (message.type === "GET_TAB_STATE" || message.type === "CAPTURE_SNAPSHOT_STATE")) {
      recordRouteScroll();
      const scroll = captureCurrentScroll();

      sendResponse({
        scroll,
        spaRoute: currentSpaRoute,
        spaRoutes: spaRouteScrolls,
        hasFormInput: checkDirty().isDirty
      });
      return true;
    }

    if (message && (message.type === "RESTORE_SCROLL" || message.type === "RESTORE_TAB_STATE")) {
      const executeRestore = () => {
        let scroll = message.scroll || {};
        const targetRoute = message.spaRoute || message.route;
        if (targetRoute && spaRouteScrolls[targetRoute]) {
          scroll = spaRouteScrolls[targetRoute];
        }

        let targetX = typeof scroll.x === "number" ? Math.max(0, Math.floor(scroll.x)) : 0;
        let targetY = typeof scroll.y === "number" ? Math.max(0, Math.floor(scroll.y)) : 0;

        const docEl = document.documentElement;
        const body = document.body;
        const maxScrollY = Math.max(0, (docEl ? docEl.scrollHeight : 0) - (window.innerHeight || 0));
        if (targetY > maxScrollY && typeof scroll.percentY === "number" && scroll.percentY > 0) {
          targetY = Math.floor((scroll.percentY / 100) * maxScrollY);
        }

        window.scrollTo({ left: targetX, top: targetY, behavior: "auto" });

        sendResponse({
          restored: true,
          route: targetRoute || currentSpaRoute,
          actual: {
            x: Math.floor(window.scrollX || window.pageXOffset || 0),
            y: Math.floor(window.scrollY || window.pageYOffset || 0)
          }
        });
      };

      // Avoid restoring before layout is ready: if document is still parsing, defer until DOMContentLoaded & rAF
      if (document.readyState === "loading") {
        document.addEventListener?.("DOMContentLoaded", () => {
          if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(executeRestore);
          } else {
            setTimeout(executeRestore, 16);
          }
        }, { once: true });
      } else {
        executeRestore();
      }
      return true;
    }

    if (message && message.type === "restore-form-state") {
      const executeFormRestore = () => {
        const fields = Array.isArray(message.forms) ? message.forms : [];
        let restoredCount = 0;
        for (const field of fields) {
          if (!field) continue;
          let el = null;
          if (field.selector) {
            try { el = document.querySelector(field.selector); } catch (_) { el = null; }
          }
          if (!el && field.id) el = document.getElementById(field.id);
          if (!el && field.name) el = document.querySelector(`[name="${CSS.escape(field.name)}"]`);
          if (!el) continue;

          try {
            if (field.type === "checkbox" || field.type === "radio") {
              el.checked = Boolean(field.checked);
            } else if (field.type === "select") {
              if (typeof field.value === "string") el.value = field.value;
              else if (typeof field.selectedIndex === "number") el.selectedIndex = field.selectedIndex;
            } else if (field.type === "contenteditable") {
              if (typeof field.text === "string") el.innerText = field.text;
            } else if (typeof field.value === "string") {
              el.value = field.value;
            }
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            restoredCount++;
          } catch (_) { /* skip fields that can't be safely restored */ }
        }
        sendResponse({ restored: true, restoredCount, total: fields.length });
      };

      if (document.readyState === "loading") {
        document.addEventListener?.("DOMContentLoaded", () => {
          if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(executeFormRestore);
          } else {
            setTimeout(executeFormRestore, 16);
          }
        }, { once: true });
      } else {
        executeFormRestore();
      }
      return true;
    }
  });
})();
