import test from "node:test";
import assert from "node:assert/strict";
import {
  captureVerticalScroll,
  captureHorizontalScroll,
  captureScrollState,
  restoreScrollPosition,
  isScrollSettled,
  isLayoutReady,
  DEFAULT_SCROLL_RETRY_INTERVALS,
  executeProgressiveScrollRestoration,
  normalizeRouteKey,
  SpaScrollTracker,
  createSpaScrollTracker,
  dispatchScrollEvent,
  observeLayoutChanges,
  restoreLazyScrollPosition,
  restoreInfiniteScrollPosition,
  isDocumentReady,
  waitUntilLayoutReady,
  SCROLL_RETRY_PRESETS,
  normalizeScrollRetryIntervals,
  setScrollRetryIntervals,
  getScrollRetryIntervals,
  resetScrollRetryIntervals,
  RestorationFailureLogger,
  defaultRestorationFailureLogger,
  logScrollRestorationFailure,
  getScrollRestorationFailures,
  getScrollRestorationFailureStats,
  clearScrollRestorationFailures
} from "../lib/scroll.js";

test("captureVerticalScroll extracts vertical scroll position and calculates percentage accurately", () => {
  // Standard document with window.scrollY
  const mockWindow = {
    scrollY: 1200,
    innerHeight: 800
  };
  const mockDoc = {
    documentElement: {
      scrollHeight: 4800,
      clientHeight: 800,
      scrollTop: 1200
    }
  };

  const vert = captureVerticalScroll(mockWindow, mockDoc);
  assert.equal(vert.y, 1200);
  assert.equal(vert.scrollHeight, 4800);
  assert.equal(vert.clientHeight, 800);
  assert.equal(vert.maxScrollY, 4000); // 4800 - 800
  assert.equal(vert.percentY, 30);     // (1200 / 4000) * 100 = 30%

  // Quirks mode fallback to document.body.scrollTop
  const quirksDoc = {
    documentElement: null,
    body: {
      scrollTop: 600,
      scrollHeight: 2600,
      clientHeight: 600
    }
  };
  const quirksVert = captureVerticalScroll(null, quirksDoc);
  assert.equal(quirksVert.y, 600);
  assert.equal(quirksVert.maxScrollY, 2000);
  assert.equal(quirksVert.percentY, 30);

  // Non-scrollable page (scrollHeight <= clientHeight)
  const shortDoc = {
    documentElement: {
      scrollHeight: 500,
      clientHeight: 800,
      scrollTop: 0
    }
  };
  const shortVert = captureVerticalScroll({ innerHeight: 800 }, shortDoc);
  assert.equal(shortVert.y, 0);
  assert.equal(shortVert.maxScrollY, 0);
  assert.equal(shortVert.percentY, 0);

  // Null/undefined context fallback
  const nullVert = captureVerticalScroll(null, null);
  assert.equal(nullVert.y, 0);
  assert.equal(nullVert.percentY, 0);
  assert.equal(nullVert.maxScrollY, 0);

  // Sanitization of negative and NaN values
  const invalidWindow = {
    scrollY: -250,
    innerHeight: 600
  };
  const invalidDoc = {
    documentElement: {
      scrollHeight: 1600,
      clientHeight: 600,
      scrollTop: NaN
    }
  };
  const sanitized = captureVerticalScroll(invalidWindow, invalidDoc);
  assert.equal(sanitized.y, 0);
});

test("captureHorizontalScroll and captureScrollState extract horizontal coordinates and full metrics", () => {
  const mockWindow = {
    scrollX: 450,
    scrollY: 900,
    innerWidth: 1000,
    innerHeight: 800
  };
  const mockDoc = {
    documentElement: {
      scrollWidth: 2500,
      scrollHeight: 4800,
      clientWidth: 1000,
      clientHeight: 800,
      scrollLeft: 450,
      scrollTop: 900
    }
  };

  const horiz = captureHorizontalScroll(mockWindow, mockDoc);
  assert.equal(horiz.x, 450);
  assert.equal(horiz.scrollWidth, 2500);
  assert.equal(horiz.clientWidth, 1000);
  assert.equal(horiz.maxScrollX, 1500); // 2500 - 1000
  assert.equal(horiz.percentX, 30);     // (450 / 1500) * 100 = 30%

  // Quirks mode fallback to body.scrollLeft
  const quirksDoc = {
    documentElement: null,
    body: {
      scrollLeft: 200,
      scrollWidth: 1200,
      clientWidth: 600
    }
  };
  const quirksHoriz = captureHorizontalScroll(null, quirksDoc);
  assert.equal(quirksHoriz.x, 200);
  assert.equal(quirksHoriz.maxScrollX, 600);
  assert.equal(quirksHoriz.percentX, 33.33);

  // Non-scrollable horizontal width
  const narrowDoc = {
    documentElement: {
      scrollWidth: 800,
      clientWidth: 1000,
      scrollLeft: 0
    }
  };
  const narrowHoriz = captureHorizontalScroll({ innerWidth: 1000 }, narrowDoc);
  assert.equal(narrowHoriz.x, 0);
  assert.equal(narrowHoriz.maxScrollX, 0);
  assert.equal(narrowHoriz.percentX, 0);

  // Null/undefined fallback
  const nullHoriz = captureHorizontalScroll(null, null);
  assert.equal(nullHoriz.x, 0);
  assert.equal(nullHoriz.percentX, 0);
  assert.equal(nullHoriz.maxScrollX, 0);

  // Full captureScrollState composite
  const state = captureScrollState(mockWindow, mockDoc);
  assert.equal(state.x, 450);
  assert.equal(state.y, 900);
  assert.equal(state.percentX, 30);
  assert.equal(state.percentY, 22.5); // (900 / 4000) * 100 = 22.5%
  assert.equal(state.scrollWidth, 2500);
  assert.equal(state.scrollHeight, 4800);
  assert.ok(state.timestamp > 0);
});

test("restoreScrollPosition restores coordinates with absolute, percentage, and clamping fallbacks", () => {
  let scrolledTo = { left: 0, top: 0 };
  const mockWindow = {
    scrollX: 0,
    scrollY: 0,
    innerWidth: 1000,
    innerHeight: 800,
    scrollTo({ left, top }) {
      scrolledTo = { left, top };
      this.scrollX = left;
      this.scrollY = top;
    }
  };
  const mockDoc = {
    documentElement: {
      scrollWidth: 3000,
      scrollHeight: 5000,
      clientWidth: 1000,
      clientHeight: 800,
      get scrollLeft() { return scrolledTo.left; },
      get scrollTop() { return scrolledTo.top; }
    }
  };

  // Case 1: Standard absolute restore within document bounds
  const res1 = restoreScrollPosition({ x: 250, y: 1500 }, { win: mockWindow, doc: mockDoc });
  assert.equal(res1.success, true);
  assert.equal(res1.appliedStrategy, "absolute");
  assert.equal(res1.actual.x, 250);
  assert.equal(res1.actual.y, 1500);
  assert.equal(scrolledTo.left, 250);
  assert.equal(scrolledTo.top, 1500);

  // Case 2: Percentage fallback when document size is shorter than target coordinate
  // Document height is 2000 (maxScrollY = 1200), but target y was 3000 with percentY = 50%
  const shorterDoc = {
    documentElement: {
      scrollWidth: 1000,
      scrollHeight: 2000,
      clientWidth: 1000,
      clientHeight: 800,
      get scrollLeft() { return scrolledTo.left; },
      get scrollTop() { return scrolledTo.top; }
    }
  };
  const res2 = restoreScrollPosition(
    { x: 0, y: 3000, percentY: 50 },
    { win: mockWindow, doc: shorterDoc, usePercentageFallback: true }
  );
  assert.equal(res2.success, true);
  assert.equal(res2.appliedStrategy, "percentage");
  assert.equal(res2.actual.y, 600); // 50% of 1200 maxScrollY = 600
  assert.equal(scrolledTo.top, 600);

  // Case 3: Clamping when exceeding bounds without percentage
  const res3 = restoreScrollPosition(
    { x: 5000, y: 8000 },
    { win: mockWindow, doc: shorterDoc, usePercentageFallback: false }
  );
  assert.equal(res3.success, true);
  assert.equal(res3.appliedStrategy, "clamped");
  assert.equal(res3.actual.x, 0);   // Max scroll width is 0 (1000 - 1000)
  assert.equal(res3.actual.y, 1200); // Clamped to maxScrollY 1200

  // Case 4: Missing context
  const res4 = restoreScrollPosition({ x: 100, y: 200 }, { win: null, doc: null });
  assert.equal(res4.success, false);
  assert.equal(res4.appliedStrategy, "none");
});

test("executeProgressiveScrollRestoration retries across rendering delays and settles when layout is ready", async () => {
  let docHeight = 1200; // Initially short page (maxScrollY = 400 with viewport 800)
  let currentScroll = { left: 0, top: 0 };

  const mockWindow = {
    innerWidth: 1000,
    innerHeight: 800,
    get scrollX() { return currentScroll.left; },
    get scrollY() { return currentScroll.top; },
    scrollTo({ left, top }) {
      currentScroll = { left, top };
    }
  };

  const mockDoc = {
    documentElement: {
      scrollWidth: 1000,
      clientWidth: 1000,
      clientHeight: 800,
      get scrollHeight() { return docHeight; },
      get scrollLeft() { return currentScroll.left; },
      get scrollTop() { return currentScroll.top; }
    }
  };

  const targetScroll = { x: 0, y: 1500, percentY: 50 };
  let simulatedTime = 0;

  // Simulate synchronous fast execution of timers while tracking delayed DOM growth
  const customSetTimeout = (fn, delay) => {
    simulatedTime += delay;
    // When time passes 500ms, simulate delayed dynamic content rendering
    if (simulatedTime >= 500) {
      docHeight = 4000; // Layout now tall enough (maxScrollY = 3200)
    }
    fn();
  };

  const attemptLogs = [];
  const res = await executeProgressiveScrollRestoration(targetScroll, {
    win: mockWindow,
    doc: mockDoc,
    intervals: [0, 500, 1500, 3000],
    setTimeoutFn: customSetTimeout,
    onAttempt: (attemptResult, index) => {
      attemptLogs.push({ index, y: attemptResult.actual.y, strategy: attemptResult.appliedStrategy });
    }
  });

  assert.equal(res.success, true);
  // Settled at 500ms because attempt 1 (0ms) could only scroll to 400 (not settled),
  // and attempt 2 (500ms) had full height and scrolled to 1500!
  assert.equal(res.settledAtInterval, 500);
  assert.equal(res.attempts, 2); // Skipped 1500ms and 3000ms because it already settled!
  assert.equal(currentScroll.top, 1500);

  // Verify attempt log
  assert.equal(attemptLogs.length, 2);
  assert.equal(attemptLogs[0].y, 200); // 0ms: interim percentage fallback (50% of 400)
  assert.equal(attemptLogs[0].strategy, "percentage");
  assert.equal(attemptLogs[1].y, 1500); // 500ms: target achieved 1500
  assert.equal(attemptLogs[1].strategy, "absolute");
});

test("normalizeRouteKey canonicalizes relative paths, queries, hashes, and full URLs", () => {
  assert.equal(normalizeRouteKey(""), "/");
  assert.equal(normalizeRouteKey(null), "/");
  assert.equal(normalizeRouteKey("/dashboard"), "/dashboard");
  assert.equal(normalizeRouteKey("/dashboard?view=grid"), "/dashboard?view=grid");
  assert.equal(normalizeRouteKey("/dashboard?view=grid#section-3"), "/dashboard?view=grid#section-3");
  assert.equal(normalizeRouteKey("#header"), "/#header");
  assert.equal(normalizeRouteKey("?q=test"), "/?q=test");
  assert.equal(normalizeRouteKey("https://myapp.com/projects/42?mode=edit#notes"), "/projects/42?mode=edit#notes");

  // Location-like object
  const mockLoc = {
    pathname: "/inbox",
    search: "?filter=unread",
    hash: "#top",
    href: "https://mail.com/inbox?filter=unread#top"
  };
  assert.equal(normalizeRouteKey(mockLoc), "/inbox?filter=unread#top");
});

test("SpaScrollTracker tracks route transitions, captures per-route scrolls, and restores them", () => {
  let currentScroll = { left: 0, top: 0 };
  const eventListeners = new Map();

  const mockWindow = {
    innerWidth: 1000,
    innerHeight: 800,
    location: {
      pathname: "/feed",
      search: "",
      hash: "",
      href: "https://myspa.com/feed"
    },
    history: {
      pushState(data, unused, url) {
        if (url) {
          const parsed = new URL(url, "https://myspa.com");
          mockWindow.location.pathname = parsed.pathname;
          mockWindow.location.search = parsed.search;
          mockWindow.location.hash = parsed.hash;
          mockWindow.location.href = url;
        }
      },
      replaceState(data, unused, url) {
        if (url) {
          const parsed = new URL(url, "https://myspa.com");
          mockWindow.location.pathname = parsed.pathname;
          mockWindow.location.search = parsed.search;
          mockWindow.location.hash = parsed.hash;
          mockWindow.location.href = url;
        }
      }
    },
    addEventListener(evt, fn) {
      if (!eventListeners.has(evt)) eventListeners.set(evt, []);
      eventListeners.get(evt).push(fn);
    },
    removeEventListener(evt, fn) {
      if (eventListeners.has(evt)) {
        eventListeners.set(evt, eventListeners.get(evt).filter(f => f !== fn));
      }
    },
    get scrollX() { return currentScroll.left; },
    get scrollY() { return currentScroll.top; },
    scrollTo({ left, top }) {
      currentScroll = { left, top };
    }
  };

  const mockDoc = {
    documentElement: {
      scrollWidth: 1000,
      scrollHeight: 5000,
      clientWidth: 1000,
      clientHeight: 800,
      get scrollLeft() { return currentScroll.left; },
      get scrollTop() { return currentScroll.top; }
    }
  };

  const tracker = createSpaScrollTracker({
    win: mockWindow,
    doc: mockDoc,
    maxRoutes: 3
  });

  assert.equal(tracker.currentRoute, "/feed");

  // User scrolls down to 800 on /feed
  currentScroll = { left: 0, top: 800 };

  // User navigates via pushState to /article/1
  mockWindow.history.pushState(null, "", "https://myspa.com/article/1");

  // Tracker should have automatically recorded /feed scroll position before navigating!
  assert.equal(tracker.hasRouteScroll("/feed"), true);
  const feedScroll = tracker.getRouteScroll("/feed");
  assert.equal(feedScroll.y, 800);
  assert.equal(tracker.currentRoute, "/article/1");

  // User scrolls on /article/1 to 1400
  currentScroll = { left: 0, top: 1400 };

  // User navigates via pushState to /article/2
  mockWindow.history.pushState(null, "", "https://myspa.com/article/2");
  assert.equal(tracker.getRouteScroll("/article/1").y, 1400);

  // User scrolls on /article/2 to 2200
  currentScroll = { left: 0, top: 2200 };

  // User navigates via pushState to /profile
  mockWindow.history.pushState(null, "", "https://myspa.com/profile");
  assert.equal(tracker.hasRouteScroll("/article/2"), true);

  // Now saving scroll for /profile makes 4 routes, triggering maxRoutes (3) eviction of oldest (/feed)
  tracker.saveCurrentRouteScroll();
  assert.equal(tracker.hasRouteScroll("/feed"), false);
  assert.equal(tracker.hasRouteScroll("/article/1"), true);
  assert.equal(tracker.hasRouteScroll("/article/2"), true);
  assert.equal(tracker.hasRouteScroll("/profile"), true);

  // User navigates back to /article/1 (simulating popstate)
  mockWindow.location.pathname = "/article/1";
  const popHandlers = eventListeners.get("popstate") || [];
  popHandlers.forEach(fn => fn());

  // Restore scroll for /article/1
  const restoreRes = tracker.restoreRouteScroll("/article/1");
  assert.equal(restoreRes.success, true);
  assert.equal(restoreRes.route, "/article/1");
  assert.equal(currentScroll.top, 1400);

  // Verify detach cleanly unbinds
  tracker.detach();
  assert.equal(tracker._attached, false);
});

test("dispatchScrollEvent safely triggers scroll event on window", () => {
  let dispatched = false;
  const mockWindow = {
    dispatchEvent(evt) {
      if (evt.type === "scroll") dispatched = true;
    }
  };
  dispatchScrollEvent(mockWindow);
  assert.equal(dispatched, true);

  // Does not throw with null/empty window
  assert.doesNotThrow(() => dispatchScrollEvent(null));
});

test("observeLayoutChanges detects DOM size changes and cleans up cleanly", () => {
  let callbacks = [];
  class MockResizeObserver {
    constructor(cb) {
      this.cb = cb;
      callbacks.push(this.cb);
    }
    observe() {}
    disconnect() {
      callbacks = callbacks.filter(c => c !== this.cb);
    }
  }

  let docHeight = 1000;
  const mockDoc = {
    documentElement: {
      get scrollHeight() { return docHeight; },
      scrollWidth: 1000
    }
  };

  const changes = [];
  const cleanup = observeLayoutChanges((metrics) => {
    changes.push(metrics);
  }, {
    doc: mockDoc,
    ResizeObserverClass: MockResizeObserver
  });

  assert.equal(callbacks.length, 1);

  // Trigger resize observer without height change -> ignored
  callbacks[0]();
  assert.equal(changes.length, 0);

  // Height changes to 2500 -> triggers callback
  docHeight = 2500;
  callbacks[0]();
  assert.equal(changes.length, 1);
  assert.equal(changes[0].scrollHeight, 2500);

  // Cleanup disconnects observer
  cleanup();
  assert.equal(callbacks.length, 0);
});

test("restoreLazyScrollPosition restores scroll dynamically as lazy content expands", async () => {
  let docHeight = 1000; // Initially short: maxScrollY = 200 (viewport = 800)
  let currentScroll = { left: 0, top: 0 };
  let scrollEventFired = false;
  let layoutChangeCallbacks = [];

  class MockResizeObserver {
    constructor(cb) {
      this.cb = cb;
      layoutChangeCallbacks.push(this.cb);
    }
    observe() {}
    disconnect() {
      layoutChangeCallbacks = layoutChangeCallbacks.filter(c => c !== this.cb);
    }
  }

  const mockWindow = {
    innerWidth: 1000,
    innerHeight: 800,
    get scrollX() { return currentScroll.left; },
    get scrollY() { return currentScroll.top; },
    scrollTo({ left, top }) {
      currentScroll = { left, top };
    },
    dispatchEvent(evt) {
      if (evt.type === "scroll") scrollEventFired = true;
    }
  };

  const mockDoc = {
    documentElement: {
      scrollWidth: 1000,
      clientWidth: 1000,
      clientHeight: 800,
      get scrollHeight() { return docHeight; },
      get scrollLeft() { return currentScroll.left; },
      get scrollTop() { return currentScroll.top; }
    }
  };

  const progressReports = [];
  const targetScroll = { x: 0, y: 2200 };

  const restorePromise = restoreLazyScrollPosition(targetScroll, {
    win: mockWindow,
    doc: mockDoc,
    timeoutMs: 1000,
    tolerance: 5,
    simulateScroll: true,
    ResizeObserverClass: MockResizeObserver,
    onProgress: (res, attempt) => {
      progressReports.push({ attempt, y: res.actual.y });
    }
  });

  // First attempt at t=0: docHeight=1000, maxScrollY=200, so scroll is clamped to 200
  assert.equal(currentScroll.top, 200);
  assert.equal(scrollEventFired, true);
  assert.equal(progressReports.length, 1);
  assert.equal(progressReports[0].y, 200);

  // Lazy images load: doc expands to 1800 (maxScrollY = 1000)
  docHeight = 1800;
  layoutChangeCallbacks.forEach(cb => cb());
  assert.equal(currentScroll.top, 1000);
  assert.equal(progressReports.length, 2);
  assert.equal(progressReports[1].y, 1000);

  // More lazy content loads: doc expands to 3500 (maxScrollY = 2700, target 2200 now reachable!)
  docHeight = 3500;
  layoutChangeCallbacks.forEach(cb => cb());

  const outcome = await restorePromise;
  assert.equal(outcome.success, true);
  assert.equal(outcome.reason, "settled");
  assert.equal(currentScroll.top, 2200);
  assert.equal(outcome.actual.y, 2200);
  assert.equal(outcome.attempts, 3);
  // Observers should be cleaned up automatically
  assert.equal(layoutChangeCallbacks.length, 0);
});

test("restoreInfiniteScrollPosition handles immediate settlement, progressive paging, and stagnant feeds", async () => {
  let docHeight = 1000;
  let currentScroll = { left: 0, top: 0 };
  let scrollDispatchedCount = 0;

  const mockWindow = {
    innerWidth: 1000,
    innerHeight: 800,
    get scrollX() { return currentScroll.left; },
    get scrollY() { return currentScroll.top; },
    scrollTo({ left, top }) {
      currentScroll = { left, top };
    },
    dispatchEvent(evt) {
      if (evt.type === "scroll") scrollDispatchedCount++;
    }
  };

  const mockDoc = {
    documentElement: {
      scrollWidth: 1000,
      clientWidth: 1000,
      clientHeight: 800,
      get scrollHeight() { return docHeight; },
      get scrollLeft() { return currentScroll.left; },
      get scrollTop() { return currentScroll.top; }
    }
  };

  // Case 1: Target is already reachable (targetY: 100 <= maxScrollY: 200)
  const res1 = await restoreInfiniteScrollPosition({ x: 0, y: 100 }, {
    win: mockWindow,
    doc: mockDoc
  });
  assert.equal(res1.success, true);
  assert.equal(res1.steps, 1);
  assert.equal(res1.actual.y, 100);
  assert.equal(res1.reason, "settled");

  // Case 2: Progressive infinite scrolling (target 1800, grows by 600 each paging step)
  docHeight = 1000; // maxScrollY = 200
  currentScroll = { left: 0, top: 0 };
  const customSetTimeout = (fn) => {
    // Simulate dynamic feed fetching new page of items after each step
    docHeight += 600;
    fn();
  };

  const stepHistory = [];
  const res2 = await restoreInfiniteScrollPosition({ x: 0, y: 1800 }, {
    win: mockWindow,
    doc: mockDoc,
    stepDelayMs: 10,
    setTimeoutFn: customSetTimeout,
    onStep: (info) => stepHistory.push(info)
  });

  assert.equal(res2.success, true);
  assert.equal(res2.reason, "settled");
  assert.equal(currentScroll.top, 1800);
  assert.equal(res2.actual.y, 1800);
  assert.ok(stepHistory.length > 1);

  // Case 3: Stagnant feed (page does not grow beyond height 1200, target is 5000)
  docHeight = 1200; // maxScrollY = 400
  const noGrowthSetTimeout = (fn) => fn();

  const res3 = await restoreInfiniteScrollPosition({ x: 0, y: 5000 }, {
    win: mockWindow,
    doc: mockDoc,
    stepDelayMs: 10,
    stagnantLimit: 2,
    setTimeoutFn: noGrowthSetTimeout
  });

  assert.equal(res3.success, false);
  assert.equal(res3.reason, "stagnant");
  assert.equal(res3.reachedEnd, true);
  assert.equal(currentScroll.top, 400); // clamped to maximum available content
});

test("isDocumentReady and isLayoutReady validate document parsing state and dimension accommodation", () => {
  assert.equal(isDocumentReady({ readyState: "loading" }), false);
  assert.equal(isDocumentReady({ readyState: "interactive" }), true);
  assert.equal(isDocumentReady({ readyState: "complete" }), true);
  assert.equal(isDocumentReady(null), false);

  const mockWindow = { innerHeight: 800, innerWidth: 1000 };
  const loadingDoc = {
    readyState: "loading",
    documentElement: { scrollHeight: 2000, clientHeight: 800 }
  };

  // With checkReadyState: true, loading document is not ready
  assert.equal(isLayoutReady({ x: 0, y: 500 }, mockWindow, loadingDoc, { checkReadyState: true }), false);

  // When interactive, layout accommodation checks pass if maxScrollY (1200) >= 500
  loadingDoc.readyState = "interactive";
  assert.equal(isLayoutReady({ x: 0, y: 500 }, mockWindow, loadingDoc, { checkReadyState: true }), true);
  // Target 1500 > maxScrollY 1200: not ready if target accommodation is required
  assert.equal(isLayoutReady({ x: 0, y: 1500 }, mockWindow, loadingDoc, { checkReadyState: true }), false);
});

test("restoreScrollPosition respects avoidBeforeLayoutReady guard", () => {
  const loadingDoc = {
    readyState: "loading",
    documentElement: { scrollHeight: 2000, clientHeight: 800 }
  };
  const mockWindow = { innerHeight: 800, innerWidth: 1000, scrollTo() {} };

  const res = restoreScrollPosition({ x: 0, y: 500 }, {
    win: mockWindow,
    doc: loadingDoc,
    avoidBeforeLayoutReady: true
  });

  assert.equal(res.success, false);
  assert.equal(res.appliedStrategy, "none");
  assert.ok(res.error.includes("layout not ready"));
});

test("waitUntilLayoutReady defers execution until DOMContentLoaded and rAF trigger", async () => {
  const domListeners = [];
  const loadingDoc = {
    readyState: "loading",
    documentElement: { scrollHeight: 2000, clientHeight: 800 },
    addEventListener(evt, fn) {
      if (evt === "DOMContentLoaded") domListeners.push(fn);
    },
    removeEventListener() {}
  };

  let rAfCalled = false;
  const mockRaf = (fn) => {
    rAfCalled = true;
    fn();
  };

  const waitPromise = waitUntilLayoutReady({ x: 0, y: 500 }, {
    doc: loadingDoc,
    win: { innerHeight: 800, innerWidth: 1000 },
    rAfFn: mockRaf
  });

  // Not resolved yet because document is loading
  assert.equal(domListeners.length, 1);
  assert.equal(rAfCalled, false);

  // Transition document to interactive and fire DOMContentLoaded
  loadingDoc.readyState = "interactive";
  domListeners[0]();

  const outcome = await waitPromise;
  assert.equal(outcome.ready, true);
  assert.equal(outcome.readyState, "interactive");
  assert.equal(rAfCalled, true);
});

test("normalizeScrollRetryIntervals and presets sanitize, deduplicate, and sort intervals", () => {
  // Preset lookup
  assert.deepEqual(normalizeScrollRetryIntervals("aggressive"), SCROLL_RETRY_PRESETS.aggressive);
  assert.deepEqual(normalizeScrollRetryIntervals("gentle"), SCROLL_RETRY_PRESETS.gentle);
  assert.deepEqual(normalizeScrollRetryIntervals("immediate_only"), [0]);

  // Invalid fallback
  assert.deepEqual(normalizeScrollRetryIntervals(null), [0, 500, 1500, 3000]);
  assert.deepEqual(normalizeScrollRetryIntervals([]), [0, 500, 1500, 3000]);
  assert.deepEqual(normalizeScrollRetryIntervals(["bad", NaN, -50]), [0, 500, 1500, 3000]);

  // Sorting, deduplicating, floor, and clamping
  const sanitized = normalizeScrollRetryIntervals([1500, 0, 500, 500, 35000, -10, 250.7]);
  assert.deepEqual(sanitized, [0, 250, 500, 1500, 30000]);
});

test("setScrollRetryIntervals, getScrollRetryIntervals, and resetScrollRetryIntervals manage global configuration", () => {
  resetScrollRetryIntervals();
  assert.deepEqual(getScrollRetryIntervals(), [0, 500, 1500, 3000]);

  setScrollRetryIntervals([100, 300, 900]);
  assert.deepEqual(getScrollRetryIntervals(), [100, 300, 900]);

  // Explicit override takes precedence
  assert.deepEqual(getScrollRetryIntervals([50, 150]), [50, 150]);

  resetScrollRetryIntervals();
  assert.deepEqual(getScrollRetryIntervals(), [0, 500, 1500, 3000]);
});

test("executeProgressiveScrollRestoration accepts named presets like 'aggressive'", async () => {
  const attempts = [];
  let currentTop = 0;
  const mockWindow = {
    innerWidth: 1000,
    innerHeight: 800,
    scrollTo({ top }) {
      if (typeof top === "number") currentTop = top;
    },
    get scrollX() { return 0; },
    get scrollY() { return currentTop; }
  };
  const mockDoc = {
    documentElement: {
      scrollHeight: 1000,
      clientHeight: 800,
      scrollLeft: 0,
      get scrollTop() { return currentTop; }
    }
  };

  const res = await executeProgressiveScrollRestoration({ x: 0, y: 100 }, {
    win: mockWindow,
    doc: mockDoc,
    intervals: "aggressive",
    setTimeoutFn: (fn) => fn(),
    onAttempt: (r, idx) => attempts.push(idx)
  });

  // Settles in attempt 0 because 100 is within maxScrollY 200
  assert.equal(res.success, true);
  assert.equal(attempts.length, 1);
  assert.equal(currentTop, 100);
});

test("RestorationFailureLogger records, filters, aggregates stats, and evicts at capacity", () => {
  const logger = new RestorationFailureLogger({ maxEntries: 3, silent: true });

  logger.logFailure({
    tabId: 101,
    url: "https://example.com/page1",
    reason: "unsettled_scroll",
    target: { x: 0, y: 1500 },
    actual: { x: 0, y: 400 },
    attempts: 4
  });

  logger.logFailure({
    tabId: 102,
    url: "https://example.com/page2",
    reason: "timeout",
    target: { x: 0, y: 2500 },
    actual: { x: 0, y: 1000 },
    attempts: 4
  });

  logger.logFailure({
    tabId: 101,
    url: "https://example.com/page1/detail",
    reason: "unsettled_scroll",
    target: { x: 0, y: 800 },
    actual: { x: 0, y: 500 },
    attempts: 2
  });

  // Verify failure counts and delta calculation
  const tab101Fails = logger.getFailures({ tabId: 101 });
  assert.equal(tab101Fails.length, 2);
  assert.equal(tab101Fails[0].delta.dy, 1100);
  assert.equal(tab101Fails[1].delta.dy, 300);

  // Filter by reason
  assert.equal(logger.getFailures({ reason: "timeout" }).length, 1);

  // Statistics
  const stats = logger.getFailureStats();
  assert.equal(stats.totalFailures, 3);
  assert.equal(stats.affectedTabsCount, 2);
  assert.equal(stats.countsByReason.unsettled_scroll, 2);
  assert.equal(stats.countsByReason.timeout, 1);

  // Capacity eviction: adding 4th entry evicts the 1st
  logger.logFailure({ tabId: 103, reason: "layout_stagnant", target: { x: 0, y: 100 }, actual: { x: 0, y: 0 } });
  assert.equal(logger.entries.length, 3);
  assert.equal(logger.getFailures({ tabId: 101 }).length, 1);

  // Export logs JSON
  const exported = logger.exportLogs();
  assert.ok(exported.includes("layout_stagnant"));

  // Clear
  logger.clear();
  assert.equal(logger.entries.length, 0);
});

test("executeProgressiveScrollRestoration logs failure automatically when target cannot be reached", async () => {
  const customLogger = new RestorationFailureLogger({ silent: true });
  const mockWindow = {
    innerWidth: 1000,
    innerHeight: 800,
    scrollTo() {},
    get scrollX() { return 0; },
    get scrollY() { return 0; }
  };
  const mockDoc = {
    documentElement: { scrollHeight: 800, clientHeight: 800, scrollLeft: 0, scrollTop: 0 }
  };

  const res = await executeProgressiveScrollRestoration({ x: 0, y: 2000 }, {
    win: mockWindow,
    doc: mockDoc,
    intervals: [0, 50],
    tabId: 99,
    url: "https://shortpage.org",
    failureLogger: customLogger,
    setTimeoutFn: (fn) => fn()
  });

  assert.equal(res.success, false);
  const logged = customLogger.getFailures({ tabId: 99 });
  assert.equal(logged.length, 1);
  assert.equal(logged[0].reason, "progressive_restoration_timeout");
  assert.equal(logged[0].target.y, 2000);
  assert.equal(logged[0].actual.y, 0);
  assert.equal(logged[0].delta.dy, 2000);
});






