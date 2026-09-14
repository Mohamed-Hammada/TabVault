/**
 * TabVault Scroll Position Capture & Restoration Engine
 * Accurate, resilient scroll state capture and multi-stage restoration
 * across standard documents, SPA navigation, and lazy-loaded layouts.
 */

/**
 * Standard retry intervals in milliseconds for progressive scroll restoration.
 * Sequence: immediate (DOM ready), 500ms (first paint/images), 1500ms (lazy content), 3000ms (dynamic feeds).
 */
export const DEFAULT_SCROLL_RETRY_INTERVALS = Object.freeze([0, 500, 1500, 3000]);

/**
 * Built-in named presets for scroll restoration retry intervals.
 */
export const SCROLL_RETRY_PRESETS = Object.freeze({
  standard: Object.freeze([0, 500, 1500, 3000]),
  aggressive: Object.freeze([0, 100, 300, 800, 1500]),
  gentle: Object.freeze([0, 1000, 2500, 5000]),
  immediate_only: Object.freeze([0])
});

let globalCustomIntervals = null;

/**
 * Normalizes, validates, deduplicates, and sorts retry interval configurations.
 * @param {number[]|string} intervals - Array of delays in ms, or preset name ("standard", "aggressive", etc.)
 * @returns {ReadonlyArray<number>}
 */
export function normalizeScrollRetryIntervals(intervals) {
  if (typeof intervals === "string" && SCROLL_RETRY_PRESETS[intervals]) {
    return SCROLL_RETRY_PRESETS[intervals];
  }
  if (!Array.isArray(intervals) || intervals.length === 0) {
    return globalCustomIntervals || DEFAULT_SCROLL_RETRY_INTERVALS;
  }
  const valid = [];
  for (const item of intervals) {
    const num = Number(item);
    if (!Number.isNaN(num) && num >= 0 && Number.isFinite(num)) {
      valid.push(Math.min(30000, Math.floor(num)));
    }
  }
  if (valid.length === 0) {
    return globalCustomIntervals || DEFAULT_SCROLL_RETRY_INTERVALS;
  }
  // Deduplicate and sort ascending
  const sorted = Array.from(new Set(valid)).sort((a, b) => a - b);
  // Cap to 10 intervals
  return Object.freeze(sorted.slice(0, 10));
}

/**
 * Sets the active global default retry intervals for scroll restoration.
 * @param {number[]|string|null} intervals
 * @returns {ReadonlyArray<number>}
 */
export function setScrollRetryIntervals(intervals) {
  if (intervals === null || intervals === undefined) {
    globalCustomIntervals = null;
    return DEFAULT_SCROLL_RETRY_INTERVALS;
  }
  globalCustomIntervals = normalizeScrollRetryIntervals(intervals);
  return globalCustomIntervals;
}

/**
 * Gets the current retry intervals, optionally overriding with explicit config.
 * @param {number[]|string} [explicitIntervals]
 * @returns {ReadonlyArray<number>}
 */
export function getScrollRetryIntervals(explicitIntervals) {
  if (explicitIntervals !== undefined && explicitIntervals !== null) {
    return normalizeScrollRetryIntervals(explicitIntervals);
  }
  return globalCustomIntervals || DEFAULT_SCROLL_RETRY_INTERVALS;
}

/**
 * Resets global retry intervals back to standard defaults.
 * @returns {ReadonlyArray<number>}
 */
export function resetScrollRetryIntervals() {
  globalCustomIntervals = null;
  return DEFAULT_SCROLL_RETRY_INTERVALS;
}

/**
 * Safely resolves the active Window and Document references.
 * @param {Window} [win]
 * @param {Document} [doc]
 * @returns {{ win: Window|null, doc: Document|null }}
 */
function resolveContext(win, doc) {
  const resolvedWin = win || (typeof window !== "undefined" ? window : null);
  const resolvedDoc = doc || (typeof document !== "undefined" ? document : (resolvedWin?.document || null));
  return { win: resolvedWin, doc: resolvedDoc };
}

/**
 * Captures vertical scroll position and metrics from a window/document context.
 * @param {Window} [win]
 * @param {Document} [doc]
 * @returns {{ y: number, percentY: number, maxScrollY: number, scrollHeight: number, clientHeight: number }}
 */
export function captureVerticalScroll(win, doc) {
  const { win: w, doc: d } = resolveContext(win, doc);
  if (!w && !d) {
    return { y: 0, percentY: 0, maxScrollY: 0, scrollHeight: 0, clientHeight: 0 };
  }

  const docEl = d?.documentElement;
  const body = d?.body;

  // Window scroll or documentElement/body scroll
  const rawY = w?.scrollY ?? w?.pageYOffset ?? docEl?.scrollTop ?? body?.scrollTop ?? 0;
  const y = typeof rawY === "number" && !Number.isNaN(rawY) ? Math.max(0, Math.floor(rawY)) : 0;

  const scrollHeight = Math.max(0, Math.floor(docEl?.scrollHeight ?? body?.scrollHeight ?? 0));
  const clientHeight = Math.max(0, Math.floor(w?.innerHeight ?? docEl?.clientHeight ?? body?.clientHeight ?? 0));
  const maxScrollY = Math.max(0, scrollHeight - clientHeight);

  let percentY = 0;
  if (maxScrollY > 0) {
    percentY = Math.min(100, Math.max(0, parseFloat(((y / maxScrollY) * 100).toFixed(2))));
  }

  return {
    y,
    percentY,
    maxScrollY,
    scrollHeight,
    clientHeight
  };
}

/**
 * Captures horizontal scroll position and metrics from a window/document context.
 * @param {Window} [win]
 * @param {Document} [doc]
 * @returns {{ x: number, percentX: number, maxScrollX: number, scrollWidth: number, clientWidth: number }}
 */
export function captureHorizontalScroll(win, doc) {
  const { win: w, doc: d } = resolveContext(win, doc);
  if (!w && !d) {
    return { x: 0, percentX: 0, maxScrollX: 0, scrollWidth: 0, clientWidth: 0 };
  }

  const docEl = d?.documentElement;
  const body = d?.body;

  const rawX = w?.scrollX ?? w?.pageXOffset ?? docEl?.scrollLeft ?? body?.scrollLeft ?? 0;
  const x = typeof rawX === "number" && !Number.isNaN(rawX) ? Math.max(0, Math.floor(rawX)) : 0;

  const scrollWidth = Math.max(0, Math.floor(docEl?.scrollWidth ?? body?.scrollWidth ?? 0));
  const clientWidth = Math.max(0, Math.floor(w?.innerWidth ?? docEl?.clientWidth ?? body?.clientWidth ?? 0));
  const maxScrollX = Math.max(0, scrollWidth - clientWidth);

  let percentX = 0;
  if (maxScrollX > 0) {
    percentX = Math.min(100, Math.max(0, parseFloat(((x / maxScrollX) * 100).toFixed(2))));
  }

  return {
    x,
    percentX,
    maxScrollX,
    scrollWidth,
    clientWidth
  };
}

/**
 * Captures comprehensive scroll state coordinates, percentages, and document dimensions.
 * @param {Window} [win]
 * @param {Document} [doc]
 * @returns {{
 *   x: number,
 *   y: number,
 *   percentX: number,
 *   percentY: number,
 *   maxScrollX: number,
 *   maxScrollY: number,
 *   scrollWidth: number,
 *   scrollHeight: number,
 *   clientWidth: number,
 *   clientHeight: number,
 *   timestamp: number
 * }}
 */
export function captureScrollState(win, doc) {
  const vert = captureVerticalScroll(win, doc);
  const horiz = captureHorizontalScroll(win, doc);

  return {
    x: horiz.x,
    y: vert.y,
    percentX: horiz.percentX,
    percentY: vert.percentY,
    maxScrollX: horiz.maxScrollX,
    maxScrollY: vert.maxScrollY,
    scrollWidth: horiz.scrollWidth,
    scrollHeight: vert.scrollHeight,
    clientWidth: horiz.clientWidth,
    clientHeight: vert.clientHeight,
    timestamp: Date.now()
  };
}

/**
 * Restores scroll position on the page based on snapshot coordinates or percentages.
 * @param {object} targetScroll - Snapshot scroll state { x, y, percentX, percentY }
 * @param {object} [options]
 * @param {Window} [options.win]
 * @param {Document} [options.doc]
 * @param {"auto"|"smooth"} [options.behavior="auto"]
 * @param {boolean} [options.usePercentageFallback=true]
 * @returns {{
 *   success: boolean,
 *   target: { x: number, y: number },
 *   actual: { x: number, y: number },
 *   appliedStrategy: "absolute"|"percentage"|"clamped"|"none",
 *   error: string|null
 * }}
 */
export function restoreScrollPosition(targetScroll = {}, options = {}) {
  const { win: w, doc: d } = resolveContext(options.win, options.doc);
  if (!w && !d) {
    return {
      success: false,
      target: { x: 0, y: 0 },
      actual: { x: 0, y: 0 },
      appliedStrategy: "none",
      error: "No window or document context available for scroll restoration"
    };
  }

  const behavior = options.behavior || "auto";
  const usePercentageFallback = options.usePercentageFallback !== false;

  // Guard against restoring before layout is ready if configured
  if (options.avoidBeforeLayoutReady && d?.readyState === "loading") {
    const currentVert = captureVerticalScroll(w, d);
    const currentHoriz = captureHorizontalScroll(w, d);
    return {
      success: false,
      target: { x: typeof targetScroll.x === "number" ? targetScroll.x : 0, y: typeof targetScroll.y === "number" ? targetScroll.y : 0 },
      actual: { x: currentHoriz.x, y: currentVert.y },
      appliedStrategy: "none",
      error: "Aborted scroll restoration: layout not ready (document is still loading)"
    };
  }

  const currentVert = captureVerticalScroll(w, d);
  const currentHoriz = captureHorizontalScroll(w, d);

  let targetX = typeof targetScroll.x === "number" && !Number.isNaN(targetScroll.x) ? Math.max(0, Math.floor(targetScroll.x)) : 0;
  let targetY = typeof targetScroll.y === "number" && !Number.isNaN(targetScroll.y) ? Math.max(0, Math.floor(targetScroll.y)) : 0;

  let appliedStrategy = "absolute";

  // Check if target coordinates exceed current document bounds
  if (usePercentageFallback) {
    if (targetY > currentVert.maxScrollY && typeof targetScroll.percentY === "number" && targetScroll.percentY > 0) {
      targetY = Math.floor((targetScroll.percentY / 100) * currentVert.maxScrollY);
      appliedStrategy = "percentage";
    }
    if (targetX > currentHoriz.maxScrollX && typeof targetScroll.percentX === "number" && targetScroll.percentX > 0) {
      targetX = Math.floor((targetScroll.percentX / 100) * currentHoriz.maxScrollX);
      appliedStrategy = "percentage";
    }
  }

  // Clamp within max scroll boundaries
  const clampedX = Math.min(targetX, currentHoriz.maxScrollX);
  const clampedY = Math.min(targetY, currentVert.maxScrollY);
  if (clampedX !== targetX || clampedY !== targetY) {
    if (appliedStrategy === "absolute") appliedStrategy = "clamped";
  }

  try {
    if (typeof w?.scrollTo === "function") {
      w.scrollTo({ left: clampedX, top: clampedY, behavior });
    } else {
      if (d?.documentElement) {
        d.documentElement.scrollTop = clampedY;
        d.documentElement.scrollLeft = clampedX;
      }
      if (d?.body) {
        d.body.scrollTop = clampedY;
        d.body.scrollLeft = clampedX;
      }
    }

    const afterVert = captureVerticalScroll(w, d);
    const afterHoriz = captureHorizontalScroll(w, d);

    return {
      success: true,
      target: { x: targetX, y: targetY },
      actual: { x: afterHoriz.x, y: afterVert.y },
      appliedStrategy,
      error: null
    };
  } catch (err) {
    return {
      success: false,
      target: { x: targetX, y: targetY },
      actual: { x: currentHoriz.x, y: currentVert.y },
      appliedStrategy: "none",
      error: err.message
    };
  }
}

/**
 * Determines if actual scroll coordinates match target coordinates within allowed pixel tolerance.
 * @param {{ x?: number, y?: number }} target
 * @param {{ x?: number, y?: number }} actual
 * @param {number} [tolerance=5]
 * @returns {boolean}
 */
export function isScrollSettled(target, actual, tolerance = 5) {
  if (!target || !actual) return false;
  const targetX = target.x || 0;
  const targetY = target.y || 0;
  const actualX = actual.x || 0;
  const actualY = actual.y || 0;
  const dx = Math.abs(actualX - targetX);
  const dy = Math.abs(actualY - targetY);
  return dx <= tolerance && dy <= tolerance;
}

/**
 * Checks if the document has completed initial DOM loading (not "loading" state).
 * @param {Document} [doc]
 * @returns {boolean}
 */
export function isDocumentReady(doc) {
  const { doc: d } = resolveContext(null, doc);
  if (!d) return false;
  return d.readyState === "interactive" || d.readyState === "complete";
}

/**
 * Checks whether the page layout is sufficiently rendered to accommodate the target scroll position.
 * Verifies document readyState (if checkReadyState is true), non-zero dimensions, and max scroll bounds.
 * @param {object} targetScroll
 * @param {Window} [win]
 * @param {Document} [doc]
 * @param {object} [options]
 * @param {boolean} [options.checkReadyState=false]
 * @param {boolean} [options.requireTargetAccommodation=true]
 * @returns {boolean}
 */
export function isLayoutReady(targetScroll = {}, win, doc, options = {}) {
  const { win: w, doc: d } = resolveContext(win, doc);
  if (!w && !d) return false;

  if (options.checkReadyState && d?.readyState === "loading") {
    return false;
  }

  const vert = captureVerticalScroll(w, d);
  const targetY = typeof targetScroll.y === "number" ? Math.max(0, targetScroll.y) : 0;

  if (targetY === 0) return true;
  if (options.requireTargetAccommodation === false) return true;

  return vert.maxScrollY >= targetY;
}

/**
 * Waits until the document layout is ready before triggering scroll restoration.
 * Defers through document.readyState ("loading" -> DOMContentLoaded), requestAnimationFrame,
 * or layout size checks.
 * @param {object} targetScroll
 * @param {object} [options]
 * @param {number} [options.timeoutMs=2000]
 * @param {boolean} [options.requireTargetAccommodation=false]
 * @param {function} [options.setTimeoutFn]
 * @param {function} [options.clearTimeoutFn]
 * @param {function} [options.rAfFn]
 * @param {Window} [options.win]
 * @param {Document} [options.doc]
 * @returns {Promise<{ ready: boolean, readyState: string, durationMs: number }>}
 */
export async function waitUntilLayoutReady(targetScroll = {}, options = {}) {
  const { win: w, doc: d } = resolveContext(options.win, options.doc);
  const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 2000;
  const requireTarget = options.requireTargetAccommodation === true;
  const setTimeoutFn = options.setTimeoutFn || globalThis.setTimeout.bind(globalThis);
  const clearTimeoutFn = options.clearTimeoutFn || globalThis.clearTimeout.bind(globalThis);
  const rAf = options.rAfFn || (w?.requestAnimationFrame?.bind(w) || ((cb) => setTimeoutFn(cb, 16)));

  const startTime = Date.now();

  return new Promise((resolve) => {
    let resolved = false;
    let timer = null;
    let domListener = null;

    const cleanup = () => {
      if (timer) clearTimeoutFn(timer);
      if (domListener && (d || w)) {
        try {
          d?.removeEventListener?.("DOMContentLoaded", domListener);
          w?.removeEventListener?.("load", domListener);
        } catch (_) {}
      }
    };

    const done = (ready) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve({
        ready,
        readyState: d?.readyState || "unknown",
        durationMs: Date.now() - startTime
      });
    };

    // If document is already interactive or complete
    if (d && d.readyState !== "loading") {
      if (!requireTarget || isLayoutReady(targetScroll, w, d)) {
        rAf(() => done(true));
        return;
      }
    }

    // Timeout guard
    timer = setTimeoutFn(() => {
      done(isDocumentReady(d) || !requireTarget || isLayoutReady(targetScroll, w, d));
    }, timeoutMs);

    // Listen for DOMContentLoaded
    domListener = () => {
      rAf(() => {
        if (!requireTarget || isLayoutReady(targetScroll, w, d)) {
          done(true);
        }
      });
    };

    if (d?.addEventListener) {
      d.addEventListener("DOMContentLoaded", domListener, { once: true });
    }
    if (w?.addEventListener) {
      w.addEventListener("load", domListener, { once: true });
    }
  });
}


/**
 * Progressively restores scroll position across delayed rendering stages (e.g. 0ms, 500ms, 1500ms, 3000ms).
 * @param {object} targetScroll - Target scroll coordinates { x, y, percentX, percentY }
 * @param {object} [options]
 * @param {number[]} [options.intervals=DEFAULT_SCROLL_RETRY_INTERVALS]
 * @param {number} [options.tolerance=5]
 * @param {function} [options.onAttempt]
 * @param {function} [options.setTimeoutFn]
 * @param {Window} [options.win]
 * @param {Document} [options.doc]
 * @returns {Promise<{
 *   success: boolean,
 *   attempts: number,
 *   history: Array<object>,
 *   settledAtInterval: number|null,
 *   finalResult: object
 * }>}
 */
export async function executeProgressiveScrollRestoration(targetScroll = {}, options = {}) {
  const intervals = getScrollRetryIntervals(options.intervals);
  const tolerance = options.tolerance ?? 5;
  const setTimeoutFn = options.setTimeoutFn || globalThis.setTimeout.bind(globalThis);
  const onAttempt = typeof options.onAttempt === "function" ? options.onAttempt : null;

  const history = [];
  let finalResult = null;
  let settledAtInterval = null;

  const wait = (ms) => new Promise(resolve => setTimeoutFn(resolve, ms));

  let previousDelay = 0;
  for (let i = 0; i < intervals.length; i++) {
    const currentDelay = intervals[i];
    const delayFromPrev = Math.max(0, currentDelay - previousDelay);
    if (delayFromPrev > 0) {
      await wait(delayFromPrev);
    }
    previousDelay = currentDelay;

    const result = restoreScrollPosition(targetScroll, options);
    finalResult = result;

    const settled = isScrollSettled({ x: targetScroll.x, y: targetScroll.y }, result.actual, tolerance);
    const layoutReady = isLayoutReady(targetScroll, options.win, options.doc);

    history.push({
      attempt: i + 1,
      interval: currentDelay,
      result,
      settled,
      layoutReady
    });

    if (onAttempt) {
      onAttempt(result, i, i === intervals.length - 1);
    }

    if (settled && layoutReady) {
      settledAtInterval = currentDelay;
      break;
    }
  }

  const success = Boolean(settledAtInterval !== null || (finalResult && isScrollSettled({ x: targetScroll.x, y: targetScroll.y }, finalResult.actual, tolerance)));

  if (!success && options.logFailures !== false) {
    const logger = options.failureLogger || defaultRestorationFailureLogger;
    const currentVert = captureVerticalScroll(options.win, options.doc);
    logger.logFailure({
      tabId: options.tabId,
      url: options.url || options.win?.location?.href,
      route: options.route,
      reason: "progressive_restoration_timeout",
      target: { x: targetScroll.x, y: targetScroll.y },
      actual: finalResult?.actual,
      attempts: history.length,
      pageMetrics: {
        scrollHeight: currentVert.scrollHeight,
        clientHeight: currentVert.clientHeight,
        maxScrollY: currentVert.maxScrollY
      }
    });
  }

  return {
    success,
    attempts: history.length,
    history,
    settledAtInterval,
    finalResult
  };
}

/**
 * Normalizes a URL, Location object, or path string into a canonical SPA route key.
 * Preserves pathname, search query parameters, and hash anchors (e.g. "/feed?tab=latest#item-4").
 * @param {string|Location|URL} urlOrLocation
 * @returns {string}
 */
export function normalizeRouteKey(urlOrLocation) {
  if (!urlOrLocation) return "/";
  try {
    let str = typeof urlOrLocation === "string" ? urlOrLocation : (urlOrLocation.href || urlOrLocation.pathname || String(urlOrLocation));
    if (!str) return "/";
    if (str.startsWith("/") || str.startsWith("#") || str.startsWith("?")) {
      const parsed = new URL(str, "https://tabvault.local");
      return `${parsed.pathname}${parsed.search}${parsed.hash}` || "/";
    }
    const parsed = new URL(str);
    return `${parsed.pathname}${parsed.search}${parsed.hash}` || "/";
  } catch (_) {
    return typeof urlOrLocation === "string" ? urlOrLocation : "/";
  }
}

/**
 * Tracks and restores per-route scroll positions for Single Page Applications (SPAs).
 * Intercepts history.pushState, history.replaceState, and listens to popstate & hashchange.
 */
export class SpaScrollTracker {
  constructor(options = {}) {
    this.options = options;
    const { win, doc } = resolveContext(options.win, options.doc);
    this.win = win;
    this.doc = doc;
    this.routeScrolls = new Map();
    this.maxRoutes = typeof options.maxRoutes === "number" ? options.maxRoutes : 50;
    this.currentRoute = this.resolveCurrentRoute();
    this._attached = false;
    this._origPushState = null;
    this._origReplaceState = null;
    this._popstateHandler = null;
    this._hashchangeHandler = null;

    if (options.autoAttach !== false && this.win) {
      this.attach();
    }
  }

  resolveCurrentRoute() {
    if (this.win?.location) {
      return normalizeRouteKey(this.win.location);
    }
    return "/";
  }

  attach(win) {
    if (win) {
      this.win = win;
      this.doc = win.document || this.doc;
    }
    if (!this.win || this._attached) return;
    this._attached = true;
    this.currentRoute = this.resolveCurrentRoute();

    // Hook history.pushState
    if (this.win.history && typeof this.win.history.pushState === "function") {
      this._origPushState = this.win.history.pushState;
      const self = this;
      this.win.history.pushState = function (data, unused, url) {
        self.saveCurrentRouteScroll();
        const ret = self._origPushState.apply(this, arguments);
        if (url) {
          self.currentRoute = normalizeRouteKey(url);
        } else {
          self.currentRoute = self.resolveCurrentRoute();
        }
        return ret;
      };
    }

    // Hook history.replaceState
    if (this.win.history && typeof this.win.history.replaceState === "function") {
      this._origReplaceState = this.win.history.replaceState;
      const self = this;
      this.win.history.replaceState = function (data, unused, url) {
        const ret = self._origReplaceState.apply(this, arguments);
        if (url) {
          self.currentRoute = normalizeRouteKey(url);
        } else {
          self.currentRoute = self.resolveCurrentRoute();
        }
        return ret;
      };
    }

    // Hook popstate (back/forward navigation)
    this._popstateHandler = () => {
      this.saveCurrentRouteScroll();
      this.currentRoute = this.resolveCurrentRoute();
    };
    this.win.addEventListener?.("popstate", this._popstateHandler);

    // Hook hashchange
    this._hashchangeHandler = () => {
      this.saveCurrentRouteScroll();
      this.currentRoute = this.resolveCurrentRoute();
    };
    this.win.addEventListener?.("hashchange", this._hashchangeHandler);
  }

  detach() {
    if (!this._attached || !this.win) return;
    if (this._origPushState && this.win.history) {
      this.win.history.pushState = this._origPushState;
      this._origPushState = null;
    }
    if (this._origReplaceState && this.win.history) {
      this.win.history.replaceState = this._origReplaceState;
      this._origReplaceState = null;
    }
    if (this._popstateHandler) {
      this.win.removeEventListener?.("popstate", this._popstateHandler);
      this._popstateHandler = null;
    }
    if (this._hashchangeHandler) {
      this.win.removeEventListener?.("hashchange", this._hashchangeHandler);
      this._hashchangeHandler = null;
    }
    this._attached = false;
  }

  saveCurrentRouteScroll(routeKey = this.currentRoute) {
    const key = routeKey || this.resolveCurrentRoute();
    const scrollState = captureScrollState(this.win, this.doc);
    return this.saveRouteScroll(key, scrollState);
  }

  saveRouteScroll(routeKey, scrollState) {
    if (!routeKey) return null;
    const normalized = normalizeRouteKey(routeKey);
    // Capacity check: evict oldest route if at limit
    if (this.routeScrolls.size >= this.maxRoutes && !this.routeScrolls.has(normalized)) {
      const oldestKey = this.routeScrolls.keys().next().value;
      this.routeScrolls.delete(oldestKey);
    }
    const record = {
      ...scrollState,
      route: normalized,
      capturedAt: Date.now()
    };
    this.routeScrolls.set(normalized, record);
    return record;
  }

  getRouteScroll(routeKey) {
    if (!routeKey) return null;
    const normalized = normalizeRouteKey(routeKey);
    return this.routeScrolls.get(normalized) || null;
  }

  hasRouteScroll(routeKey) {
    if (!routeKey) return false;
    const normalized = normalizeRouteKey(routeKey);
    return this.routeScrolls.has(normalized);
  }

  deleteRouteScroll(routeKey) {
    if (!routeKey) return false;
    const normalized = normalizeRouteKey(routeKey);
    return this.routeScrolls.delete(normalized);
  }

  getAllRouteScrolls() {
    const result = {};
    for (const [key, value] of this.routeScrolls.entries()) {
      result[key] = { ...value };
    }
    return result;
  }

  clear() {
    this.routeScrolls.clear();
  }

  restoreRouteScroll(routeKey = this.currentRoute, options = {}) {
    const key = routeKey || this.resolveCurrentRoute();
    const saved = this.getRouteScroll(key);
    if (!saved) {
      return {
        success: false,
        route: key,
        appliedStrategy: "none",
        error: `No saved scroll state found for route: ${key}`
      };
    }
    const res = restoreScrollPosition(saved, {
      win: this.win,
      doc: this.doc,
      ...options
    });
    return {
      ...res,
      route: key
    };
  }
}

/**
 * Factory helper for SpaScrollTracker instance.
 * @param {object} [options]
 * @returns {SpaScrollTracker}
 */
export function createSpaScrollTracker(options = {}) {
  return new SpaScrollTracker(options);
}

/**
 * Safely dispatches a scroll event on the window to awaken native and JS lazy-loaders.
 * @param {Window} [win]
 */
export function dispatchScrollEvent(win) {
  const { win: w } = resolveContext(win);
  if (!w || typeof w.dispatchEvent !== "function") return;
  try {
    const evt = typeof Event === "function" ? new Event("scroll", { bubbles: true }) : { type: "scroll" };
    w.dispatchEvent(evt);
  } catch (_) { /* ignore if event creation disallowed */ }
}

/**
 * Observes DOM mutations or element resize events that alter page height/width.
 * Returns an unobserve / cleanup function.
 * @param {function} onLayoutChange
 * @param {object} [options]
 * @param {Window} [options.win]
 * @param {Document} [options.doc]
 * @param {typeof ResizeObserver} [options.ResizeObserverClass]
 * @param {typeof MutationObserver} [options.MutationObserverClass]
 * @returns {() => void}
 */
export function observeLayoutChanges(onLayoutChange, options = {}) {
  const { win: w, doc: d } = resolveContext(options.win, options.doc);
  let cleanedUp = false;
  const cleanups = [];

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    for (const fn of cleanups) {
      try { fn(); } catch (_) {}
    }
    cleanups.length = 0;
  };

  if (!w && !d) return cleanup;

  const RO = options.ResizeObserverClass || (typeof w?.ResizeObserver === "function" ? w.ResizeObserver : (typeof ResizeObserver === "function" ? ResizeObserver : null));
  const MO = options.MutationObserverClass || (typeof w?.MutationObserver === "function" ? w.MutationObserver : (typeof MutationObserver === "function" ? MutationObserver : null));

  let lastHeight = d?.documentElement?.scrollHeight || 0;
  let lastWidth = d?.documentElement?.scrollWidth || 0;

  const checkDimensions = () => {
    if (cleanedUp) return;
    const currentHeight = d?.documentElement?.scrollHeight || 0;
    const currentWidth = d?.documentElement?.scrollWidth || 0;
    if (currentHeight !== lastHeight || currentWidth !== lastWidth) {
      lastHeight = currentHeight;
      lastWidth = currentWidth;
      try {
        onLayoutChange({ scrollHeight: currentHeight, scrollWidth: currentWidth });
      } catch (_) {}
    }
  };

  // Try ResizeObserver on documentElement / body
  if (RO) {
    try {
      const ro = new RO(() => {
        checkDimensions();
      });
      if (d?.documentElement) ro.observe(d.documentElement);
      if (d?.body && d.body !== d.documentElement) ro.observe(d.body);
      cleanups.push(() => ro.disconnect());
    } catch (_) {}
  }

  // Also attach MutationObserver as backup for child list / subtree changes
  if (MO && d?.documentElement) {
    try {
      const mo = new MO(() => {
        checkDimensions();
      });
      mo.observe(d.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "height"] });
      cleanups.push(() => mo.disconnect());
    } catch (_) {}
  }

  return cleanup;
}

/**
 * Restores scroll on lazy-loaded pages by observing layout growth, dispatching scroll kick events,
 * and re-adjusting scroll position until page reaches target height or timeout.
 * @param {object} targetScroll
 * @param {object} [options]
 * @param {number} [options.timeoutMs=3000]
 * @param {number} [options.tolerance=5]
 * @param {boolean} [options.simulateScroll=true]
 * @param {function} [options.setTimeoutFn]
 * @param {function} [options.clearTimeoutFn]
 * @param {function} [options.onProgress]
 * @returns {Promise<{
 *   success: boolean,
 *   attempts: number,
 *   target: { x: number, y: number },
 *   actual: { x: number, y: number },
 *   reason: "settled" | "timeout" | "max_attempts"
 * }>}
 */
export async function restoreLazyScrollPosition(targetScroll = {}, options = {}) {
  const { win: w, doc: d } = resolveContext(options.win, options.doc);
  const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 3000;
  const tolerance = options.tolerance ?? 5;
  const simulateScroll = options.simulateScroll !== false;
  const setTimeoutFn = options.setTimeoutFn || globalThis.setTimeout.bind(globalThis);
  const clearTimeoutFn = options.clearTimeoutFn || globalThis.clearTimeout.bind(globalThis);

  const targetX = typeof targetScroll.x === "number" ? Math.max(0, targetScroll.x) : 0;
  const targetY = typeof targetScroll.y === "number" ? Math.max(0, targetScroll.y) : 0;

  let attempts = 0;
  let settled = false;
  let timedOut = false;
  let latestResult = null;

  return new Promise((resolve) => {
    let unobserve = null;
    let timeoutTimer = null;

    const finish = (reason) => {
      if (settled || timedOut) return;
      if (reason === "timeout") {
        timedOut = true;
      } else {
        settled = true;
      }
      if (unobserve) unobserve();
      if (timeoutTimer) clearTimeoutFn(timeoutTimer);

      const actualX = latestResult?.actual?.x ?? (w?.scrollX || 0);
      const actualY = latestResult?.actual?.y ?? (w?.scrollY || 0);
      const success = isScrollSettled({ x: targetX, y: targetY }, { x: actualX, y: actualY }, tolerance);

      if (!success && options.logFailures !== false) {
        const logger = options.failureLogger || defaultRestorationFailureLogger;
        const currentVert = captureVerticalScroll(w, d);
        logger.logFailure({
          tabId: options.tabId,
          url: options.url || w?.location?.href,
          route: options.route,
          reason: `lazy_scroll_${timedOut ? "timeout" : reason}`,
          target: { x: targetX, y: targetY },
          actual: { x: actualX, y: actualY },
          attempts,
          pageMetrics: {
            scrollHeight: currentVert.scrollHeight,
            clientHeight: currentVert.clientHeight,
            maxScrollY: currentVert.maxScrollY
          }
        });
      }

      resolve({
        success,
        attempts,
        target: { x: targetX, y: targetY },
        actual: { x: actualX, y: actualY },
        reason: success ? "settled" : (timedOut ? "timeout" : reason)
      });
    };

    const performAttempt = () => {
      attempts++;
      latestResult = restoreScrollPosition(targetScroll, { win: w, doc: d, ...options });

      if (simulateScroll) {
        dispatchScrollEvent(w);
      }

      if (typeof options.onProgress === "function") {
        try { options.onProgress(latestResult, attempts); } catch (_) {}
      }

      if (isScrollSettled({ x: targetX, y: targetY }, latestResult.actual, tolerance)) {
        finish("settled");
      }
    };

    // Initial attempt
    performAttempt();

    if (settled) return;

    // Observe layout height expansion
    unobserve = observeLayoutChanges(() => {
      if (settled || timedOut) return;
      performAttempt();
    }, { ...options, win: w, doc: d });

    timeoutTimer = setTimeoutFn(() => {
      finish("timeout");
    }, timeoutMs);
  });
}

/**
 * Progressively triggers infinite-scroll pagination by scrolling to content boundaries,
 * dispatching scroll events to trigger data loading, and stepping until
 * target scroll is accommodated or pagination ceases to yield new content.
 * @param {object} targetScroll - Snapshot target coordinates { x, y }
 * @param {object} [options]
 * @param {number} [options.maxPagingSteps=15] - Maximum pagination cycles before stopping
 * @param {number} [options.stepDelayMs=200] - Delay between paging steps in milliseconds
 * @param {number} [options.tolerance=5]
 * @param {number} [options.stagnantLimit=3] - Stop if height does not grow after N attempts
 * @param {function} [options.setTimeoutFn]
 * @param {function} [options.onStep]
 * @param {Window} [options.win]
 * @param {Document} [options.doc]
 * @returns {Promise<{
 *   success: boolean,
 *   steps: number,
 *   target: { x: number, y: number },
 *   actual: { x: number, y: number },
 *   reachedEnd: boolean,
 *   reason: "settled" | "stagnant" | "max_steps"
 * }>}
 */
export async function restoreInfiniteScrollPosition(targetScroll = {}, options = {}) {
  const { win: w, doc: d } = resolveContext(options.win, options.doc);
  const maxPagingSteps = typeof options.maxPagingSteps === "number" ? options.maxPagingSteps : 15;
  const stepDelayMs = typeof options.stepDelayMs === "number" ? options.stepDelayMs : 200;
  const tolerance = options.tolerance ?? 5;
  const stagnantLimit = typeof options.stagnantLimit === "number" ? options.stagnantLimit : 3;
  const setTimeoutFn = options.setTimeoutFn || globalThis.setTimeout.bind(globalThis);
  const onStep = typeof options.onStep === "function" ? options.onStep : null;

  const targetX = typeof targetScroll.x === "number" ? Math.max(0, targetScroll.x) : 0;
  const targetY = typeof targetScroll.y === "number" ? Math.max(0, targetScroll.y) : 0;

  const wait = (ms) => new Promise(resolve => setTimeoutFn(resolve, ms));

  let steps = 0;
  let stagnantCount = 0;
  let lastHeight = captureVerticalScroll(w, d).scrollHeight;
  let finalReason = "max_steps";

  // Check if target is already reachable without paging
  const currentVert = captureVerticalScroll(w, d);
  if (currentVert.maxScrollY >= targetY) {
    const res = restoreScrollPosition({ x: targetX, y: targetY }, { win: w, doc: d, ...options });
    const success = isScrollSettled({ x: targetX, y: targetY }, res.actual, tolerance);
    return {
      success,
      steps: 1,
      target: { x: targetX, y: targetY },
      actual: res.actual,
      reachedEnd: false,
      reason: "settled"
    };
  }

  // Progressive paging loop
  while (steps < maxPagingSteps) {
    steps++;

    // Scroll to current bottom to trigger infinite scroll sentinel
    const currentMax = captureVerticalScroll(w, d).maxScrollY;
    restoreScrollPosition({ x: targetX, y: currentMax }, { win: w, doc: d, usePercentageFallback: false });
    dispatchScrollEvent(w);

    if (onStep) {
      try {
        onStep({ step: steps, currentMax, currentScroll: captureVerticalScroll(w, d).y });
      } catch (_) {}
    }

    // Wait for infinite scroll loader / network response
    if (stepDelayMs > 0) {
      await wait(stepDelayMs);
    }

    const updatedVert = captureVerticalScroll(w, d);

    // Check if target is now reachable
    if (updatedVert.maxScrollY >= targetY) {
      restoreScrollPosition({ x: targetX, y: targetY }, { win: w, doc: d, ...options });
      finalReason = "settled";
      break;
    }

    // Check if content stopped growing
    if (updatedVert.scrollHeight <= lastHeight) {
      stagnantCount++;
      if (stagnantCount >= stagnantLimit) {
        finalReason = "stagnant";
        break;
      }
    } else {
      stagnantCount = 0;
      lastHeight = updatedVert.scrollHeight;
    }
  }

  const finalVert = captureVerticalScroll(w, d);
  const finalHoriz = captureHorizontalScroll(w, d);
  const actual = { x: finalHoriz.x, y: finalVert.y };
  const success = isScrollSettled({ x: targetX, y: targetY }, actual, tolerance);

  if (!success && options.logFailures !== false) {
    const logger = options.failureLogger || defaultRestorationFailureLogger;
    logger.logFailure({
      tabId: options.tabId,
      url: options.url || w?.location?.href,
      route: options.route,
      reason: `infinite_scroll_${finalReason}`,
      target: { x: targetX, y: targetY },
      actual,
      attempts: steps,
      pageMetrics: {
        scrollHeight: finalVert.scrollHeight,
        clientHeight: finalVert.clientHeight,
        maxScrollY: finalVert.maxScrollY
      }
    });
  }

  return {
    success,
    steps,
    target: { x: targetX, y: targetY },
    actual,
    reachedEnd: finalReason === "stagnant",
    reason: success ? "settled" : finalReason
  };
}

/**
 * Diagnostic logger for tracking and inspecting scroll restoration failures and anomalies.
 */
export class RestorationFailureLogger {
  constructor(options = {}) {
    this.maxEntries = typeof options.maxEntries === "number" ? options.maxEntries : 100;
    this.silent = options.silent === true;
    this.entries = [];
  }

  logFailure(failureData = {}) {
    const targetX = failureData.target?.x ?? 0;
    const targetY = failureData.target?.y ?? 0;
    const actualX = failureData.actual?.x ?? 0;
    const actualY = failureData.actual?.y ?? 0;
    const dx = Math.abs(actualX - targetX);
    const dy = Math.abs(actualY - targetY);

    const record = {
      id: `fail_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      tabId: failureData.tabId ?? null,
      url: failureData.url ? String(failureData.url) : null,
      route: failureData.route ? String(failureData.route) : null,
      reason: failureData.reason || "unsettled_scroll",
      error: failureData.error || null,
      target: { x: targetX, y: targetY },
      actual: { x: actualX, y: actualY },
      delta: { dx, dy },
      attempts: failureData.attempts || 1,
      pageMetrics: failureData.pageMetrics ? { ...failureData.pageMetrics } : null
    };

    if (this.entries.length >= this.maxEntries) {
      this.entries.shift();
    }
    this.entries.push(record);

    if (!this.silent && typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn(
        `[TabVault Restoration Failure] ${record.reason} for tab ${record.tabId ?? "unknown"} at ${record.url || record.route || "page"}: ` +
        `Target (${targetX}, ${targetY}), Actual (${actualX}, ${actualY}), Delta: dy=${dy}px`
      );
    }

    return record;
  }

  getFailures(filters = {}) {
    let result = [...this.entries];
    if (filters.tabId !== undefined) {
      result = result.filter(e => e.tabId === filters.tabId);
    }
    if (filters.url) {
      result = result.filter(e => e.url && e.url.includes(filters.url));
    }
    if (filters.reason) {
      result = result.filter(e => e.reason === filters.reason);
    }
    if (filters.sinceTimestamp) {
      result = result.filter(e => e.timestamp >= filters.sinceTimestamp);
    }
    if (typeof filters.limit === "number" && filters.limit > 0) {
      result = result.slice(-filters.limit);
    }
    return result;
  }

  getFailureStats() {
    const countsByReason = {};
    const affectedTabs = new Set();
    for (const e of this.entries) {
      countsByReason[e.reason] = (countsByReason[e.reason] || 0) + 1;
      if (e.tabId !== null && e.tabId !== undefined) {
        affectedTabs.add(e.tabId);
      }
    }
    return {
      totalFailures: this.entries.length,
      affectedTabsCount: affectedTabs.size,
      countsByReason
    };
  }

  clear() {
    this.entries.length = 0;
  }

  exportLogs() {
    return JSON.stringify(this.entries, null, 2);
  }
}

export const defaultRestorationFailureLogger = new RestorationFailureLogger({ silent: true });

export function logScrollRestorationFailure(failureData, logger = defaultRestorationFailureLogger) {
  return logger.logFailure(failureData);
}

export function getScrollRestorationFailures(filters, logger = defaultRestorationFailureLogger) {
  return logger.getFailures(filters);
}

export function getScrollRestorationFailureStats(logger = defaultRestorationFailureLogger) {
  return logger.getFailureStats();
}

export function clearScrollRestorationFailures(logger = defaultRestorationFailureLogger) {
  logger.clear();
}



