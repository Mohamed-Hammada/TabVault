// TabVault content script — detects "dirty" form state so the suspender
// knows when to leave a tab alone. Lightweight and passive.
(() => {
  if (window.__tabvault_injected) return;
  window.__tabvault_injected = true;

  let dirty = false;
  let lastReported = null;

  function report(state) {
    if (state === lastReported) return;
    lastReported = state;
    try {
      chrome.runtime.sendMessage({ type: "report-form-input", hasFormInput: state });
    } catch (_) { /* extension might be reloading */ }
  }

  function isMeaningfulInput(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "INPUT") {
      const type = (el.type || "").toLowerCase();
      // Ignore search/checkboxes/radios — they don't represent unsaved data we'd lose
      if (["checkbox", "radio", "submit", "button", "reset", "hidden"].includes(type)) return false;
      return (el.value || "").length > 0;
    }
    if (tag === "TEXTAREA") return (el.value || "").length > 0;
    if (el.isContentEditable) return (el.innerText || "").trim().length > 0;
    return false;
  }

  function checkDirty() {
    const fields = document.querySelectorAll("input, textarea, [contenteditable=''], [contenteditable='true']");
    for (const f of fields) {
      if (isMeaningfulInput(f)) return true;
    }
    return false;
  }

  function onChange() {
    const next = checkDirty();
    if (next !== dirty) {
      dirty = next;
      report(dirty);
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

  document.addEventListener("input", schedule, true);
  document.addEventListener("change", schedule, true);

  // Submitting a form clears the dirty state.
  document.addEventListener("submit", () => {
    setTimeout(() => { dirty = false; report(false); }, 0);
  }, true);

  // Initial check after first paint
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
        return ret;
      };
    }
    if (window.history && typeof window.history.replaceState === "function") {
      const origReplace = window.history.replaceState;
      window.history.replaceState = function (data, unused, url) {
        const ret = origReplace.apply(this, arguments);
        currentSpaRoute = getRouteKey();
        return ret;
      };
    }
    window.addEventListener?.("popstate", () => {
      recordRouteScroll();
      currentSpaRoute = getRouteKey();
    });
    window.addEventListener?.("hashchange", () => {
      recordRouteScroll();
      currentSpaRoute = getRouteKey();
    });
  } catch (_) { /* safe in restricted contexts */ }

  // Handle queries from background for snapshot capture
  chrome.runtime?.onMessage?.addListener((message, sender, sendResponse) => {
    if (message && (message.type === "GET_TAB_STATE" || message.type === "CAPTURE_SNAPSHOT_STATE")) {
      recordRouteScroll();
      const scroll = captureCurrentScroll();

      sendResponse({
        scroll,
        spaRoute: currentSpaRoute,
        spaRoutes: spaRouteScrolls,
        hasFormInput: checkDirty()
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
