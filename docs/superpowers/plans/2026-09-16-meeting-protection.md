# Meeting Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop TabVault from suspending tabs that have an active call (camera, mic, or screen-share), even when the tab is muted, silent, backgrounded, or the call started before/after TabVault last checked.

**Architecture:** A new pure module (`lib/call-detection.js`) turns raw per-frame signals into a call-state level (`none`/`possible`/`probable`/`confirmed`/`unknown`) and decides whether a tab should be protected. `content.js` gathers the raw signals (live media tracks via DOM scan + wrapped `getUserMedia`/`RTCPeerConnection`, reusing its existing SPA-navigation hook) and reports them to `background.js`, which aggregates per tab, decays stale reports toward `unknown`, and consults the guard immediately before every suspend decision — both in the periodic scan and right before a suspend actually executes.

**Tech Stack:** Vanilla JS, Chrome Extension Manifest V3 (service worker background, content script), `node:test` for unit tests (no browser/DOM harness in this repo — all new pure logic lives in `lib/` so it stays testable; `content.js`/`background.js` stay glue-only, matching the existing codebase pattern where none of `background.js`/`content.js` is imported by any test file).

**Spec:** `docs/superpowers/specs/2026-09-16-close-to-vault-and-meeting-protection-design.md` (Part 2 — Meeting protection). Part 1 (Close-to-Vault) is a separate follow-up plan; this plan only touches suspend protection, not the close/vault mechanism itself.

## Global Constraints

- Detection must not depend on `tab.audible` or user interaction (`lastActiveAt`) — that's the exact gap being fixed.
- A muted track (`track.enabled === false`) still counts as an active call as long as `track.readyState === "live"`. Only `readyState === "ended"` means the call signal stopped.
- `confirmed`, `probable`, and `unknown` call states must all block suspension. Only `possible` and `none` are suspendable (subject to the existing per-domain floor).
- The known-meeting-domain list is a safety floor, evaluated independently of (OR'd with) detected call state — never used as proof a call is active.
- Every destructive suspend action must re-check the guard immediately before executing, not just during the periodic eligibility scan.
- No new test infra (no jsdom) — new logic must be unit-testable as plain functions on plain data.

---

### Task 1: Pure call-state logic (`lib/call-detection.js`)

**Files:**
- Create: `lib/call-detection.js`
- Test: `tests/call_detection.test.js`

**Interfaces:**
- Produces (consumed by Task 3's `background.js` integration):
  - `deriveFrameLevel(signals: { liveMediaTrackCount: number, screenShareActive: boolean, rtcConnectionState: string|null, isKnownMeetingDomain: boolean }): "none"|"possible"|"probable"|"confirmed"`
  - `aggregateFrameLevels(levels: string[]): "none"|"possible"|"probable"|"confirmed"`
  - `resolveEffectiveLevel({ lastLevel: string|null, lastReportedAt: number|null, now: number, staleAfterMs?: number, unknownAfterMs?: number }): "none"|"possible"|"probable"|"confirmed"|"unknown"`
  - `shouldProtectFromCallState(effectiveLevel: string): boolean`
  - `isKnownMeetingDomain(hostname: string, knownDomains: string[], exceptions: string[]): boolean`
  - `shouldProtectTab({ effectiveLevel, hostname, knownDomains, exceptions }): boolean`

- [ ] **Step 1: Write the failing tests**

```javascript
// tests/call_detection.test.js
import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveFrameLevel,
  aggregateFrameLevels,
  resolveEffectiveLevel,
  shouldProtectFromCallState,
  isKnownMeetingDomain,
  shouldProtectTab
} from "../lib/call-detection.js";

test("deriveFrameLevel: confirmed for a live media track regardless of mute state", () => {
  // Mute is not a signal here on purpose — the caller only passes live-track
  // counts (readyState === 'live'), so a muted track already counts as live.
  const level = deriveFrameLevel({
    liveMediaTrackCount: 1,
    screenShareActive: false,
    rtcConnectionState: null,
    isKnownMeetingDomain: false
  });
  assert.equal(level, "confirmed");
});

test("deriveFrameLevel: confirmed for camera-only call", () => {
  const level = deriveFrameLevel({
    liveMediaTrackCount: 1,
    screenShareActive: false,
    rtcConnectionState: "connected",
    isKnownMeetingDomain: true
  });
  assert.equal(level, "confirmed");
});

test("deriveFrameLevel: confirmed for microphone-only call", () => {
  const level = deriveFrameLevel({
    liveMediaTrackCount: 1,
    screenShareActive: false,
    rtcConnectionState: "connected",
    isKnownMeetingDomain: false
  });
  assert.equal(level, "confirmed");
});

test("deriveFrameLevel: confirmed for screen-share alone", () => {
  const level = deriveFrameLevel({
    liveMediaTrackCount: 0,
    screenShareActive: true,
    rtcConnectionState: null,
    isKnownMeetingDomain: false
  });
  assert.equal(level, "confirmed");
});

test("deriveFrameLevel: confirmed does not depend on audibility — no audible input exists", () => {
  // Signals intentionally omit anything audio-output related; a background,
  // silent call with a live track is still confirmed.
  const level = deriveFrameLevel({
    liveMediaTrackCount: 1,
    screenShareActive: false,
    rtcConnectionState: "connected",
    isKnownMeetingDomain: false
  });
  assert.equal(level, "confirmed");
});

test("deriveFrameLevel: probable for a connecting RTCPeerConnection with no live track yet", () => {
  const level = deriveFrameLevel({
    liveMediaTrackCount: 0,
    screenShareActive: false,
    rtcConnectionState: "connecting",
    isKnownMeetingDomain: false
  });
  assert.equal(level, "probable");
});

test("deriveFrameLevel: possible for a known meeting domain with no call signals", () => {
  const level = deriveFrameLevel({
    liveMediaTrackCount: 0,
    screenShareActive: false,
    rtcConnectionState: null,
    isKnownMeetingDomain: true
  });
  assert.equal(level, "possible");
});

test("deriveFrameLevel: none for an ordinary page", () => {
  const level = deriveFrameLevel({
    liveMediaTrackCount: 0,
    screenShareActive: false,
    rtcConnectionState: null,
    isKnownMeetingDomain: false
  });
  assert.equal(level, "none");
});

test("deriveFrameLevel: transitions from none to confirmed once a call starts after the tab was already scanned", () => {
  const before = deriveFrameLevel({ liveMediaTrackCount: 0, screenShareActive: false, rtcConnectionState: null, isKnownMeetingDomain: false });
  const after = deriveFrameLevel({ liveMediaTrackCount: 1, screenShareActive: false, rtcConnectionState: "connected", isKnownMeetingDomain: false });
  assert.equal(before, "none");
  assert.equal(after, "confirmed");
});

test("deriveFrameLevel + SPA route transition: lobby (possible) -> connecting (probable) -> in-call (confirmed)", () => {
  const lobby = deriveFrameLevel({ liveMediaTrackCount: 0, screenShareActive: false, rtcConnectionState: null, isKnownMeetingDomain: true });
  const connecting = deriveFrameLevel({ liveMediaTrackCount: 0, screenShareActive: false, rtcConnectionState: "connecting", isKnownMeetingDomain: true });
  const inCall = deriveFrameLevel({ liveMediaTrackCount: 1, screenShareActive: false, rtcConnectionState: "connected", isKnownMeetingDomain: true });
  assert.equal(lobby, "possible");
  assert.equal(connecting, "probable");
  assert.equal(inCall, "confirmed");
});

test("aggregateFrameLevels: tab level is the highest-ranked frame level (iframe call beats top-frame none)", () => {
  assert.equal(aggregateFrameLevels(["none", "confirmed", "possible"]), "confirmed");
  assert.equal(aggregateFrameLevels(["none", "probable"]), "probable");
  assert.equal(aggregateFrameLevels(["none", "possible"]), "possible");
  assert.equal(aggregateFrameLevels([]), "none");
});

test("resolveEffectiveLevel: unknown when there is no prior report at all (fresh service worker)", () => {
  const level = resolveEffectiveLevel({ lastLevel: null, lastReportedAt: null, now: Date.now() });
  assert.equal(level, "unknown");
});

test("resolveEffectiveLevel: unknown after a service-worker restart wipes in-memory state during an active call", () => {
  // Simulates: tab was confirmed before restart, but the restarted worker has
  // no lastReportedAt for it yet because its in-memory map was rebuilt empty.
  const level = resolveEffectiveLevel({ lastLevel: null, lastReportedAt: null, now: Date.now() });
  assert.equal(level, "unknown");
  assert.equal(shouldProtectFromCallState(level), true);
});

test("resolveEffectiveLevel: confirmed decays to probable once stale, before becoming unknown", () => {
  const now = 1_000_000;
  const level = resolveEffectiveLevel({ lastLevel: "confirmed", lastReportedAt: now - 25_000, now, staleAfterMs: 20_000, unknownAfterMs: 90_000 });
  assert.equal(level, "probable");
});

test("resolveEffectiveLevel: becomes unknown once far enough past the last report", () => {
  const now = 1_000_000;
  const level = resolveEffectiveLevel({ lastLevel: "confirmed", lastReportedAt: now - 100_000, now, staleAfterMs: 20_000, unknownAfterMs: 90_000 });
  assert.equal(level, "unknown");
});

test("resolveEffectiveLevel: fresh confirmed report stays confirmed", () => {
  const now = 1_000_000;
  const level = resolveEffectiveLevel({ lastLevel: "confirmed", lastReportedAt: now - 1_000, now });
  assert.equal(level, "confirmed");
});

test("shouldProtectFromCallState: confirmed, probable, and unknown block destruction; possible and none do not", () => {
  assert.equal(shouldProtectFromCallState("confirmed"), true);
  assert.equal(shouldProtectFromCallState("probable"), true);
  assert.equal(shouldProtectFromCallState("unknown"), true);
  assert.equal(shouldProtectFromCallState("possible"), false);
  assert.equal(shouldProtectFromCallState("none"), false);
});

test("isKnownMeetingDomain: matches known domains unless explicitly excepted by the user", () => {
  const known = ["meet.google.com", "zoom.us"];
  assert.equal(isKnownMeetingDomain("meet.google.com", known, []), true);
  assert.equal(isKnownMeetingDomain("meet.google.com", known, ["meet.google.com"]), false);
  assert.equal(isKnownMeetingDomain("example.com", known, []), false);
});

test("shouldProtectTab: known meeting domain protects even with no detected call (possible/none)", () => {
  const protectedTab = shouldProtectTab({
    effectiveLevel: "none",
    hostname: "meet.google.com",
    knownDomains: ["meet.google.com"],
    exceptions: []
  });
  assert.equal(protectedTab, true);
});

test("shouldProtectTab: an ordinary domain with a confirmed call is protected", () => {
  const protectedTab = shouldProtectTab({
    effectiveLevel: "confirmed",
    hostname: "example.com",
    knownDomains: ["meet.google.com"],
    exceptions: []
  });
  assert.equal(protectedTab, true);
});

test("shouldProtectTab: close-to-vault / suspend is rejected while a call is confirmed active", () => {
  const protectedTab = shouldProtectTab({
    effectiveLevel: "confirmed",
    hostname: "example.com",
    knownDomains: [],
    exceptions: []
  });
  assert.equal(protectedTab, true);
});

test("shouldProtectTab: an ordinary domain with no call and not a meeting domain is not protected", () => {
  const protectedTab = shouldProtectTab({
    effectiveLevel: "none",
    hostname: "example.com",
    knownDomains: ["meet.google.com"],
    exceptions: []
  });
  assert.equal(protectedTab, false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/call_detection.test.js`
Expected: FAIL — `Cannot find module '../lib/call-detection.js'`

- [ ] **Step 3: Implement `lib/call-detection.js`**

```javascript
// lib/call-detection.js
// Pure call-state logic for meeting protection. No browser APIs here —
// content.js gathers raw signals, background.js calls these functions.

const LEVEL_RANK = { none: 0, possible: 1, probable: 2, confirmed: 3 };

/**
 * Derives a single frame's instantaneous call level from raw signals.
 * Deliberately has no "muted" or "audible" input: a muted track is still a
 * live track (readyState === "live"), and callers must already have
 * filtered signals down to live tracks before calling this.
 *
 * @param {{ liveMediaTrackCount: number, screenShareActive: boolean, rtcConnectionState: string|null, isKnownMeetingDomain: boolean }} signals
 * @returns {"none"|"possible"|"probable"|"confirmed"}
 */
export function deriveFrameLevel(signals) {
  const {
    liveMediaTrackCount = 0,
    screenShareActive = false,
    rtcConnectionState = null,
    isKnownMeetingDomain = false
  } = signals || {};

  if (liveMediaTrackCount > 0 || screenShareActive || rtcConnectionState === "connected") {
    return "confirmed";
  }
  if (rtcConnectionState === "connecting" || rtcConnectionState === "new") {
    return "probable";
  }
  if (isKnownMeetingDomain) {
    return "possible";
  }
  return "none";
}

/**
 * Aggregates per-frame levels (top frame + any iframes) into one tab-level
 * value — the highest-ranked level wins, so a call happening inside an
 * iframe still protects the whole tab.
 *
 * @param {string[]} levels
 * @returns {"none"|"possible"|"probable"|"confirmed"}
 */
export function aggregateFrameLevels(levels) {
  if (!Array.isArray(levels) || levels.length === 0) return "none";
  return levels.reduce((best, level) => {
    const rank = LEVEL_RANK[level] ?? 0;
    return rank > LEVEL_RANK[best] ? level : best;
  }, "none");
}

/**
 * Resolves the level background.js should actually act on, factoring in how
 * long it's been since the tab last reported. A tab that goes quiet decays
 * one step (confirmed -> probable) while merely stale, then to "unknown"
 * once stale for long enough — including the case where there is no prior
 * report at all (e.g. right after a service-worker restart).
 *
 * @param {{ lastLevel: string|null, lastReportedAt: number|null, now: number, staleAfterMs?: number, unknownAfterMs?: number }} args
 * @returns {"none"|"possible"|"probable"|"confirmed"|"unknown"}
 */
export function resolveEffectiveLevel({
  lastLevel,
  lastReportedAt,
  now,
  staleAfterMs = 20_000,
  unknownAfterMs = 90_000
}) {
  if (lastLevel == null || lastReportedAt == null) return "unknown";

  const age = now - lastReportedAt;
  if (age >= unknownAfterMs) return "unknown";
  if (age >= staleAfterMs && lastLevel === "confirmed") return "probable";
  return lastLevel;
}

/**
 * Whether a call-state level alone is enough to block a destructive action
 * (suspend / close-to-vault). Unknown fails safe — treated the same as
 * probable.
 *
 * @param {string} effectiveLevel
 * @returns {boolean}
 */
export function shouldProtectFromCallState(effectiveLevel) {
  return effectiveLevel === "confirmed" || effectiveLevel === "probable" || effectiveLevel === "unknown";
}

/**
 * The known-meeting-domain safety floor. This is independent of detected
 * call state — it protects the whole domain by default, not just
 * meeting-path URLs, unless the user has explicitly excepted it.
 *
 * @param {string} hostname
 * @param {string[]} knownDomains
 * @param {string[]} exceptions
 * @returns {boolean}
 */
export function isKnownMeetingDomain(hostname, knownDomains, exceptions) {
  if (!hostname) return false;
  const list = Array.isArray(knownDomains) ? knownDomains : [];
  const excepted = Array.isArray(exceptions) ? exceptions : [];
  return list.includes(hostname) && !excepted.includes(hostname);
}

/**
 * Combined guard: protect if either the detected call state says so, or the
 * domain-level safety floor says so. This is the single function callers
 * (background.js) should use immediately before any destructive action.
 *
 * @param {{ effectiveLevel: string, hostname: string, knownDomains: string[], exceptions: string[] }} args
 * @returns {boolean}
 */
export function shouldProtectTab({ effectiveLevel, hostname, knownDomains, exceptions }) {
  return shouldProtectFromCallState(effectiveLevel) || isKnownMeetingDomain(hostname, knownDomains, exceptions);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/call_detection.test.js`
Expected: PASS (all cases)

- [ ] **Step 5: Commit**

```bash
git add lib/call-detection.js tests/call_detection.test.js
git commit -m "feat: add pure call-state detection logic for meeting protection"
```

---

### Task 2: Settings defaults + options UI toggle

**Files:**
- Modify: `background.js` (`DEFAULT_SETTINGS`, around the `neverSuspend` block)
- Modify: `options/options.html` (never-suspend panel)
- Modify: `options/options.js` (`nsMap` and initial checkbox population)
- Test: `tests/dashboard.test.js` is not touched here — settings defaults have no existing dedicated test file; verification is manual (see Step 4).

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `DEFAULT_SETTINGS.neverSuspend.inCall` (boolean), `DEFAULT_SETTINGS.knownMeetingDomains` (string[]), `DEFAULT_SETTINGS.meetingDomainExceptions` (string[]) — consumed by Task 3.

- [ ] **Step 1: Add the new settings fields**

In `background.js`, inside `DEFAULT_SETTINGS.neverSuspend`, add `inCall` next to the existing `audible` flag:

```javascript
  neverSuspend: {
    pinned: true,
    audible: true,
    inCall: true,
    hasFormInput: true,
    offline: true,
    onlyTabInWindow: false,
    activeInAnyWindow: true,
    onPowerSource: false, // skip suspension when plugged in
    inTabGroup: false
  },
```

Immediately after the `perDomainRules` block in `DEFAULT_SETTINGS`, add the meeting-domain safety floor:

```javascript
  // Meeting-domain safety floor — protects the whole domain by default,
  // independent of detected call state. Not proof a call is active; see
  // lib/call-detection.js for the actual detection logic.
  knownMeetingDomains: [
    "meet.google.com",
    "zoom.us",
    "teams.microsoft.com",
    "teams.live.com",
    "webex.com"
  ],
  meetingDomainExceptions: [],
```

Because `getSettings()` does `mergeDeep(structuredClone(DEFAULT_SETTINGS), s || {})`, existing installs automatically pick up these new defaults without a migration — stored settings only need to override what they explicitly set.

- [ ] **Step 2: Add the options UI toggle and domain fields**

In `options/options.html`, add a toggle card right after the existing `ns-audible` card (around line 360):

```html
          <label class="toggle-card">
            <input type="checkbox" id="ns-incall" />
            <div>
              <div class="tt">There's an active call (camera, mic, or screen share)</div>
              <div class="ts">Detected even while muted or backgrounded — won't be cut off mid-meeting.</div>
            </div>
          </label>
```

In `options/options.js`, extend the existing declarative map (around line 603) and initial population (around line 94):

```javascript
  $("ns-incall").checked = SETTINGS.neverSuspend.inCall;
```

```javascript
  const nsMap = {
    "ns-pinned": "pinned",
    "ns-audible": "audible",
    "ns-incall": "inCall",
    "ns-form": "hasFormInput",
    "ns-offline": "offline",
    "ns-active": "activeInAnyWindow",
    "ns-only": "onlyTabInWindow",
    "ns-power": "onPowerSource",
    "ns-group": "inTabGroup"
  };
```

No new UI is added for `knownMeetingDomains`/`meetingDomainExceptions` in this task — they're plain settings fields editable via `chrome.storage.local` / the existing settings JSON export-import already in `options.js`, consistent with YAGNI; a dedicated list-editor UI can be added later if requested.

- [ ] **Step 3: Verify manifest/load tests still pass**

Run: `node --test tests/manifest_and_load.test.js tests/dashboard.test.js`
Expected: PASS (these files don't assert on `DEFAULT_SETTINGS` shape, so this confirms nothing broke)

- [ ] **Step 4: Manual smoke check**

Load the unpacked extension, open the options page, confirm the new "There's an active call…" toggle appears under "Never suspend when…", is checked by default, and persists after toggling + reopening the page.

- [ ] **Step 5: Commit**

```bash
git add background.js options/options.html options/options.js
git commit -m "feat: add inCall never-suspend setting and known-meeting-domain floor"
```

---

### Task 3: `background.js` call-state tracking and guard wiring

**Files:**
- Modify: `background.js`

**Interfaces:**
- Consumes: `deriveFrameLevel`, `aggregateFrameLevels`, `resolveEffectiveLevel`, `shouldProtectTab` from `lib/call-detection.js` (Task 1); `extractDomain` already imported from `lib/dashboard-service.js`; `DEFAULT_SETTINGS.neverSuspend.inCall`, `.knownMeetingDomains`, `.meetingDomainExceptions` (Task 2).
- Produces: message type `"report-call-state"` (consumed by `content.js` in Task 4, which sends it) and `"request-call-state"` (sent by background, consumed by `content.js` in Task 4).

- [ ] **Step 1: Import the new module**

At the top of `background.js`, alongside the other `lib/*` imports:

```javascript
import {
  deriveFrameLevel,
  aggregateFrameLevels,
  resolveEffectiveLevel,
  shouldProtectTab
} from "./lib/call-detection.js";
```

- [ ] **Step 2: Add per-tab call-state tracking**

Near the existing `tabState`/`manuallyProtectedTabs` declarations (around line 87):

```javascript
// Per-tab aggregated call state.
// Map<tabId, { level: string, lastReportedAt: number, frames: Map<frameId, string> }>
const tabCallState = new Map();

function recordFrameCallState(tabId, frameId, level) {
  const entry = tabCallState.get(tabId) || { level: "none", lastReportedAt: null, frames: new Map() };
  entry.frames.set(frameId, level);
  entry.level = aggregateFrameLevels(Array.from(entry.frames.values()));
  entry.lastReportedAt = Date.now();
  tabCallState.set(tabId, entry);
}

async function getEffectiveCallProtection(tab) {
  const entry = tabCallState.get(tab.id);
  const effectiveLevel = resolveEffectiveLevel({
    lastLevel: entry?.level ?? null,
    lastReportedAt: entry?.lastReportedAt ?? null,
    now: Date.now()
  });
  const settings = await getSettings();
  const hostname = extractDomain(tab.url);
  return shouldProtectTab({
    effectiveLevel,
    hostname,
    knownDomains: settings.knownMeetingDomains || [],
    exceptions: settings.meetingDomainExceptions || []
  });
}
```

- [ ] **Step 3: Wire the guard into `shouldSuspend()`**

In `shouldSuspend()` (around line 553), add the check next to the existing `ns.audible` check:

```javascript
    if (ns.audible && tab.audible) return { suspend: false, reason: "audible" };
    if (ns.inCall && await getEffectiveCallProtection(tab)) return { suspend: false, reason: "in-call" };
```

- [ ] **Step 4: Re-check the guard immediately before the destructive action**

Find the suspend-execution function that performs `chrome.tabs.update(tabId, { url: suspendedUrl })` (the function containing the code from `background.js:792` identified during design). Immediately before that `chrome.tabs.update` call, add a final guard re-check so a call that started between the eligibility scan and actual execution still blocks it:

```javascript
    const settings = await getSettings();
    if (settings.neverSuspend.inCall && await getEffectiveCallProtection(tab)) {
      tvLog(`suspend-aborted tabId=${tabId} reason=in-call-recheck`);
      return false;
    }
    await chrome.tabs.update(tabId, { url: suspendedUrl });
```

(Match this to the exact surrounding function signature and return convention already in that function — the point is the guard call sits directly before the navigation call, using the same `settings`/`tab` variables already in scope there.)

- [ ] **Step 5: Handle message reporting from content scripts**

In the `chrome.runtime.onMessage` switch (around line 1450), add a case mirroring the existing `report-form-input` pattern:

```javascript
        case "report-call-state": {
          const tabId = sender.tab?.id;
          const frameId = sender.frameId ?? 0;
          if (tabId !== undefined) {
            const hostname = extractDomain(sender.tab?.url || "");
            const settings = await getSettings();
            const level = deriveFrameLevel({
              liveMediaTrackCount: msg.liveMediaTrackCount || 0,
              screenShareActive: !!msg.screenShareActive,
              rtcConnectionState: msg.rtcConnectionState || null,
              isKnownMeetingDomain: (settings.knownMeetingDomains || []).includes(hostname) &&
                !(settings.meetingDomainExceptions || []).includes(hostname)
            });
            recordFrameCallState(tabId, frameId, level);
          }
          sendResponse({ ok: true });
          break;
        }
```

- [ ] **Step 6: Revalidate on the periodic tick and clean up on tab removal**

In the `ALARM_TICK` handler (around line 1107), after the existing per-tick work, ask every tracked tab's content script to re-report so stale state can recover before it decays past `unknown`:

```javascript
  if (alarm.name === ALARM_TICK) {
    for (const tabId of tabCallState.keys()) {
      chrome.tabs.sendMessage(tabId, { type: "request-call-state" }).catch(() => {});
    }
    // ...existing tick body continues below...
```

In the existing `chrome.tabs.onRemoved` listener (around line 1278), add cleanup next to the existing `tabState.delete(tabId)`:

```javascript
chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
  manuallyProtectedTabs.delete(tabId);
  tabCallState.delete(tabId);
```

- [ ] **Step 7: Confirm in-memory state resets safely on service-worker restart**

No code change needed here beyond what Steps 2–6 already do: `tabCallState` is declared as a fresh, empty `Map` at module load, so after a service-worker restart `tabCallState.get(tab.id)` is `undefined` for every tab until a fresh `report-call-state` message arrives, and `resolveEffectiveLevel({ lastLevel: null, lastReportedAt: null, ... })` already returns `"unknown"` (proven in Task 1's tests) — which `shouldProtectFromCallState` already treats as protected. Add a one-line log so this is visible during manual verification:

```javascript
tvLog(`service-worker-loaded call-state-map-reset size=${tabCallState.size}`);
```

placed next to the existing `tvLog("service-worker-loaded", ...)` line near the top of `background.js`.

- [ ] **Step 8: Manual smoke check**

Load the unpacked extension. Open `chrome://extensions`, find TabVault, and force-restart the service worker (or just wait for MV3 idle-suspend) while a tab is mid-call (once Task 4 lands) — confirm via the console log that the tab isn't suspended before a fresh report arrives. Before Task 4 lands, at minimum confirm via `node --test` that nothing existing broke:

Run: `node --test tests/*.test.js`
Expected: PASS (all existing suites, since `shouldSuspend`/suspend-execution changes are additive checks that default to non-blocking until `tabCallState` has entries)

- [ ] **Step 9: Commit**

```bash
git add background.js
git commit -m "feat: track per-tab call state and gate suspend on active-call protection"
```

---

### Task 4: `content.js` signal collection + manifest changes

**Files:**
- Modify: `content.js`
- Modify: `manifest.json` (`content_scripts` entry)

**Interfaces:**
- Consumes: message types `"report-call-state"` (sends) and `"request-call-state"` (listens for) defined in Task 3.
- Produces: nothing consumed by later tasks — this is the last task in this plan.

- [ ] **Step 1: Update `manifest.json`**

Change the existing `content_scripts` entry from:

```json
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_idle",
      "all_frames": false
    }
  ],
```

to:

```json
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_start",
      "all_frames": true
    }
  ],
```

`run_at: document_start` lets the media-API wrapping (Step 3 below) install before page scripts run, so calls starting immediately on load are still caught. `all_frames: true` makes each iframe run its own instance of `content.js`, each independently reporting via `sender.frameId`, which is exactly what `aggregateFrameLevels` in Task 3 expects.

- [ ] **Step 2: Add the DOM media scan (catches calls that predate injection)**

In `content.js`, inside the existing top-level IIFE (guarded by the existing `window.__tabvault_injected` check near line 4), add:

```javascript
  // ─── Call detection ────────────────────────────────────────────────────
  // Media elements reflect *current* state regardless of when the underlying
  // stream was created, which is what makes this work retroactively for
  // calls that started before this script was injected (extension
  // reload, content-script reconnect, tab that was already mid-call).
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
```

- [ ] **Step 3: Wrap `getUserMedia`, `getDisplayMedia`, and `RTCPeerConnection`**

Still inside the IIFE, near the media scan:

```javascript
  let screenShareActive = false;
  let latestRtcConnectionState = null;

  try {
    if (navigator.mediaDevices?.getUserMedia) {
      const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = function (...args) {
        return originalGetUserMedia(...args).then((stream) => {
          scheduleCallStateReport();
          for (const track of stream.getTracks()) {
            track.addEventListener("ended", scheduleCallStateReport);
          }
          return stream;
        });
      };
    }

    if (navigator.mediaDevices?.getDisplayMedia) {
      const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getDisplayMedia = function (...args) {
        return originalGetDisplayMedia(...args).then((stream) => {
          screenShareActive = true;
          scheduleCallStateReport();
          for (const track of stream.getTracks()) {
            track.addEventListener("ended", () => {
              screenShareActive = false;
              scheduleCallStateReport();
            });
          }
          return stream;
        });
      };
    }

    if (typeof RTCPeerConnection === "function") {
      const OriginalRTCPeerConnection = RTCPeerConnection;
      window.RTCPeerConnection = function (...args) {
        const pc = new OriginalRTCPeerConnection(...args);
        pc.addEventListener("connectionstatechange", () => {
          latestRtcConnectionState = pc.connectionState;
          scheduleCallStateReport();
        });
        return pc;
      };
      window.RTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
    }
  } catch (_) { /* page CSP or a frozen navigator can block wrapping — DOM scan below still works */ }
```

- [ ] **Step 4: Report call state to background, reusing the existing SPA route hook**

Still inside the IIFE:

```javascript
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
        screenShareActive,
        rtcConnectionState: latestRtcConnectionState
      });
    } catch (_) { /* extension might be reloading */ }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "request-call-state") {
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
```

Then hook the existing SPA-navigation tracking already in `content.js` (the `history.pushState`/`replaceState`/`popstate`/`hashchange` patching near line 253's `getRouteKey`) to also call `scheduleCallStateReport()` on route change, so a lobby→in-call SPA transition (e.g. Google Meet) is re-scanned immediately instead of waiting for the 5-second interval. Locate the route-change handling block and add a call to `scheduleCallStateReport()` wherever it currently reacts to a route change.

- [ ] **Step 5: Manual smoke check**

Load the unpacked extension, open a real Google Meet call (or any page using `getUserMedia`), open the extension's service worker console, and confirm `report-call-state` messages arrive with `liveMediaTrackCount >= 1` while the call is active, and that muting the mic (not ending it) keeps `liveMediaTrackCount` unchanged. Confirm no suspension occurs on that tab while the call is active, even after leaving it idle past `suspendAfterMinutes`.

Run the full automated suite to confirm nothing regressed:

Run: `node --test tests/*.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add content.js manifest.json
git commit -m "feat: detect active calls in content script and report to background"
```

---

## Self-Review Notes

- **Spec coverage:** confirmed/probable/possible/none/unknown levels (Task 1), mute-doesn't-count-as-stopped (Task 1 signal contract + Task 4 `readyState` filter), pre-injection/reconnect/SW-restart calls (Task 4 DOM scan + Task 3 Step 7), SPA navigation (Task 4 Step 4), iframes (`all_frames: true`, Task 4 Step 1; aggregation, Task 1/3), centralized guard before every destructive action (Task 3 Steps 3–4), periodic revalidation (Task 3 Step 6, Task 4's `setInterval`), domain floor as independent OR'd layer (Task 1 `shouldProtectTab`, Task 2 settings) — all covered.
- **Placeholder scan:** none found — every step has literal code, not descriptions.
- **Type consistency:** `deriveFrameLevel`/`aggregateFrameLevels`/`resolveEffectiveLevel`/`shouldProtectFromCallState`/`isKnownMeetingDomain`/`shouldProtectTab` signatures are identical between Task 1's implementation and Task 3's usage.
- **Scope:** this plan is Part 2 of the spec only. Part 1 (Close-to-Vault) is intentionally out of scope here and should be its own plan once this one is merged, since the two are independently shippable and Part 1's close-to-vault path will call `shouldProtectTab`/`resolveTabProtection` from this same module once it exists. **Part 1 remains fully unimplemented as of this branch — no close-to-vault or New Tab restore code exists yet.**

## Post-review amendments (2026-09-16)

A code review after the initial implementation found four gaps, addressed as follows (see the spec's own "Post-review amendments" section for the full writeup):

1. Isolated-world API wrapping in `content.js` cannot see the page's own WebRTC calls — added `content-mainworld.js` as a `"world": "MAIN"` content script that does the real wrapping and bridges signals via `window.postMessage`.
2. `RTCPeerConnection` tracking now covers every live connection (a `Set` in `content-mainworld.js`), not just the most recent one.
3. Stale iframe call-state entries are now actively dropped via `chrome.webNavigation.onBeforeNavigate` (navigation-away) and a per-tick `pruneStaleCallFrames()` reconciliation against `chrome.webNavigation.getAllFrames` (DOM-removed iframes) — added the `webNavigation` permission.
4. Extracted `resolveTabProtection()` in `lib/call-detection.js` as the single pure guard every destructive path calls through `getEffectiveCallProtection()`, and added direct unit tests for it in `tests/call_detection.test.js` covering confirmed/probable/unknown/none against both an ordinary domain and the meeting-domain floor.
