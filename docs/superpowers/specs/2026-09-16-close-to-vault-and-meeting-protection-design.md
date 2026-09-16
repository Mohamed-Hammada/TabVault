# Seamless Suspension and Meeting Protection

*(Originally titled "Close-to-Vault and Meeting Protection" — Part 1 was
renamed and re-scoped below after the user clarified their actual intent
was not the close-and-reopen design that name implied; the filename is
kept as-is for link/commit-history continuity.)*

Date: 2026-09-16
Status: Part 2 (Meeting Protection) implemented on `main` (merged from
`feature/meeting-protection`, revised twice after code review — see
"Post-review amendments" below). Part 1 was re-scoped from a
close-and-reopen design ("Close-to-Vault") to **Seamless Suspension with
Automatic Restoration**, and turns out to already be fully implemented and
tested — see "Part 1 (revised)" below. No new code is pending for either
part as of this revision.

## Post-review amendments (2026-09-16)

A review of the initial `feature/meeting-protection` implementation raised
four design gaps, fixed as follows. These amend the "Meeting protection"
section below rather than replacing it.

1. **Isolated-world wrapping doesn't see the page's own WebRTC calls.**
   `content.js` (an isolated-world content script) has its own copies of
   `navigator`/`RTCPeerConnection` — wrapping those from the isolated world
   never intercepts the page's own calls to them. Fixed by splitting the
   API-wrapping into a second content script, `content-mainworld.js`,
   declared with `"world": "MAIN"` in `manifest.json`, which does the actual
   wrapping in the page's real JS context and hands signals to `content.js`
   via `window.postMessage` (a MAIN-world script has no `chrome.*` access to
   report directly). The DOM media-element scan in `content.js` — already
   present for the "calls that predate injection" case — is the reliable
   fallback if this wrapping is ever bypassed, since it reads live platform
   objects directly rather than depending on having observed the API call.
2. **Only the most recent `RTCPeerConnection` was tracked.** A page can run
   several simultaneously. `content-mainworld.js` now tracks every
   connection in a `Set`, removes ones that close/fail, and reports the
   highest-ranked state across all of them (`connected` > `connecting`/`new`).
3. **Stale iframe call state could permanently protect a tab.** A frame that
   reported `confirmed` and then navigated away or was removed from the DOM
   never updated its entry, and `resolveEffectiveLevel`'s staleness decay
   only ever bottoms out at `unknown` — itself protective — so a genuinely
   gone frame could never lapse. Fixed with two active-removal mechanisms in
   `background.js`: `chrome.webNavigation.onBeforeNavigate` drops a frame's
   entry the moment it starts navigating away, and a per-tick reconciliation
   pass (`pruneStaleCallFrames`, via `chrome.webNavigation.getAllFrames`)
   drops entries for frames that no longer exist at all (DOM-removed
   iframes, which fire no navigation event). Requires the `webNavigation`
   permission.
4. **Guard composition wasn't independently testable.** The per-tab
   protection decision (call-state + domain floor + the `neverSuspend.inCall`
   toggle) is now one pure function, `resolveTabProtection()` in
   `lib/call-detection.js`, called by every destructive suspend path via
   `getEffectiveCallProtection()` in `background.js`. All suspend
   entrypoints (scheduled sweep, manual suspend, bulk suspend,
   memory-pressure-accelerated timeout) funnel through the single
   `suspendTab()` function, which calls this guard once via `shouldSuspend()`
   during eligibility scanning and again immediately before the destructive
   `chrome.tabs.discard`/`chrome.tabs.update` call — confirmed by auditing
   every call site of `suspendTab()` in `background.js`. `resolveTabProtection`
   is unit tested directly in `tests/call_detection.test.js` against
   confirmed/probable/unknown/none and domain-floor combinations, which is
   what actually proves every destructive path is blocked correctly, since
   `background.js` itself has no test harness (consistent with the rest of
   the codebase — `background.js`/`content.js` are intentionally untested
   glue; all logic worth testing lives in `lib/`).

A second review pass on merged `main` (commit `939e1466...`) found two more
issues in `content-mainworld.js`, fixed as follows:

5. **A single track ending cleared protection even if a sibling track was
   still live.** `getUserMediaActive`/`screenShareActive` were booleans
   flipped to `false` on any one track's `"ended"` event — a page with two
   separate `getUserMedia` grants (e.g. audio and video captured
   independently) would lose protection the moment either one ended, even
   with the other still live. Fixed by tracking individual tracks in
   `activeCaptureTracks`/`activeScreenShareTracks` `Set`s and reporting
   `size > 0` instead of a shared boolean.
6. **`RTCPeerConnection` "disconnected" was treated as evidence the call
   ended.** "disconnected" is WebRTC's transient state for a network
   hiccup (ICE renegotiating, a Wi-Fi blip) and commonly self-heals within
   seconds — Chrome only moves to `"failed"`/`"closed"` once the underlying
   failure is actually confirmed. `content-mainworld.js`'s `aggregateRtcState`
   now ranks `"disconnected"` alongside `"connecting"`/`"new"` instead of
   excluding it, and `deriveFrameLevel` in `lib/call-detection.js` maps
   `"disconnected"` to `probable` (protected, not confirmed) rather than
   falling through toward `possible`/`none` — giving the connection a grace
   window to recover instead of dropping protection immediately. A live
   local media track still overrides this and reports `confirmed`
   regardless of the transport's momentary state.

## Problem

Two related gaps, as originally scoped:

1. ~~Suspend doesn't free the tab slot~~ — **superseded, see "Part 1
   revised" below.** The original wording of this problem asked for the
   original tab to be *closed* (`chrome.tabs.remove`) with a separate cache
   +restore surface. Follow-up conversation with the user (2026-09-16)
   clarified that this was never the actual intent: the desired behavior —
   same `tabId`/index/group/pinned-state preserved, a custom in-place
   suspended page showing title/favicon/URL/screenshot, automatic restore
   on tab activation with no click required, scroll position restored — is
   the **existing "replace" suspend strategy already in this codebase**,
   not a new close-and-reopen mechanism. No vault registry, no New Tab
   override, no `chrome.tabs.remove` — see below.
2. **Active meetings get suspended.** The only protections against
   suspension today are `tab.audible` (Chrome's "currently outputting sound"
   flag) and recent user interaction (`lastActiveAt`). A muted meeting tab,
   or one where the user is only listening, is neither audible nor
   interacted-with, so it silently crosses the 30-minute idle threshold and
   gets suspended mid-call. There is no signal today that says "this tab has
   a live call." — **Implemented, see "Meeting protection" below.**

Both features must not regress any existing suspend/restore/dashboard
behavior.

## Part 1 (revised) — Seamless Suspension with Automatic Restoration

**Status: already implemented and tested prior to this spec** — this
section documents and validates existing behavior rather than proposing new
work, since the originally-planned Close-to-Vault direction (above) turned
out not to be what was wanted.

The user's requirement, restated: suspending a tab must feel like the tab
never left — same `tabId`, same position/group/pinned state, a lightweight
in-place placeholder carrying the original title/favicon/URL/preview, and
returning to it (by activating the tab — no button click required) brings
back the exact original page, title, and scroll position, with the
placeholder simply gone. Explicitly *not* wanted: closing the original tab
and opening a replacement (`chrome.tabs.remove` + a new tab/window
surface), because that reshuffles tab order, group membership, pinned
state, and tab-to-tab relationships that a same-tab in-place swap avoids
entirely.

This maps directly onto the codebase's `strategy: "replace"` suspend mode
(the default, `DEFAULT_SETTINGS.strategy` in `background.js`), not
`chrome.tabs.discard()` (the alternate `"discard"` strategy, which is
Chrome's native discard and gives no control over title/preview — exactly
the limitation the user flagged). Verified component-by-component:

- **Same tab, no close/reopen**: `suspendTab()` in `background.js` calls
  `chrome.tabs.update(tabId, { url: suspendedUrl })` — the same `tabId`
  stays in the tab strip at the same index, group, and pinned state the
  whole time. `chrome.tabs.remove` is never called on the "replace" path.
- **Custom placeholder page**: `suspended/suspended.html` +
  `suspended.js` render the original title (`document.getElementById(
  "title").textContent`), favicon (`<link rel="icon">` swapped to the
  original site's), the original URL (displayed and used as the restore
  target), and a captured screenshot/preview (`lib/screenshot.js`
  captures it pre-suspend; `suspended.js`'s `renderScreenshotPreview`
  displays it, falling back to a domain/reason card when unavailable).
- **Click to restore**: `suspended.js`'s `restore()` function, wired to the
  restore button.
- **Automatic restore on tab activation, no click needed**: two
  independent, redundant mechanisms both restore without a click —
  `background.js`'s `chrome.tabs.onActivated` listener checks
  `settings.appearance.autoRestoreOnFocus` (default `true`) and calls
  `restoreTab()` the moment the tab is activated; `suspended.js` itself
  also restores on `visibilitychange`/immediate-visible as a redundant
  on-page fallback that keeps the in-page "Restoring…" UI in sync even if
  triggered from the background listener.
- **After restore**: `restoreTab()` delegates to
  `lib/restore-engine.js`'s pipeline — "Load original URL → wait for page
  readiness → restore scroll position" (`executeScrollRestorationStep`) —
  which navigates the same tab back to the original URL (the browser sets
  the tab title from the loaded page itself, no separate title-restore step
  needed) and reapplies the captured scroll position. `clearWake(tabId)`
  clears the tab's transient suspension bookkeeping (e.g. any scheduled
  wake alarm) on success; historical snapshot/screenshot records are
  intentionally retained for the dashboard's stats/history views rather
  than deleted, which is an existing, deliberate product choice, not a gap
  against this requirement.

No code changes were needed for this section — it exists and is covered by
`tests/restore_engine.test.js`, `tests/scroll.test.js`,
`tests/lifecycle.test.js`, and `tests/dashboard.test.js`.

Restoring: `chrome.tabs.create({ url, windowId, index, pinned })` in the
original position/group/pin state, then the existing restore-engine
reattachment logic (already used for suspended-tab restore) reapplies the
snapshot once the new tab finishes loading — same mechanism, just targeting
a freshly created tab instead of a re-navigated one.

## Part 2 — Meeting protection

### Call-state model

Per tab (aggregated across frames), one of:

- **`confirmed`** — at least one live (`readyState: "live"`) media track
  currently attached to either an `RTCPeerConnection` sender/receiver or a
  playing `<video>`/`<audio>` element, or an active screen-share
  (`getDisplayMedia`) track. Muted (`track.enabled === false`) still counts
  as confirmed as long as `readyState` is `"live"` — mute disables the
  track, it doesn't end it.
- **`probable`** — an `RTCPeerConnection` exists but hasn't reached a
  confirmed live-track state yet (e.g. `connectionState` is `"connecting"`),
  or a previously-`confirmed` tab's heartbeat has gone stale (see
  revalidation below) — decays through `probable` before ever reaching
  `none`, so one missed heartbeat doesn't instantly unprotect a live call.
- **`possible`** — a known meeting domain with no detected call signals
  (e.g. a lobby/landing page).
- **`none`** — not a meeting domain, no signals.
- **`unknown`** — no fresh report from the tab's content script yet
  (just-restarted service worker, not-yet-injected content script, tab
  still loading). Treated the same as `probable` for protection purposes —
  fail safe.

### Detection layers (why one mechanism isn't enough)

Wrapping `getUserMedia`/`RTCPeerConnection` at content-script injection time
only catches calls that *start after* the script runs. To cover the cases
called out explicitly:

- **Calls started before injection / content-script reconnect /
  service-worker restart**: rather than relying on having wrapped the
  original API call, the content script also does a **DOM media scan** —
  `document.querySelectorAll('video, audio')`, checking `srcObject` for a
  `MediaStream` with any track `readyState === "live"`. This reflects
  current media state regardless of when the stream was created, so it
  works retroactively.
- **SPA navigation** (Meet/Teams/Zoom don't full-reload between lobby and
  in-call): patch `history.pushState`/`replaceState`, listen for
  `popstate`, and re-run the scan on route change.
- **Existing `RTCPeerConnection` instances**: wrap the constructor to track
  new instances and their `connectionState`/`track` events for the
  `confirmed`/`probable` distinction; for connections that predate
  injection, the DOM media scan is the source of truth instead (there is no
  API to enumerate already-existing JS objects).
- **Iframes**: `content_scripts` gets `all_frames: true` (currently
  `false`) and the manifest content-script match list stays `<all_urls>` so
  same-origin *and* cross-origin same-extension-injected frames each report
  their own state; background aggregates per tab as `max(frame levels)`.
- **Muted-but-active tracks**: handled by keying off `readyState`, not
  `enabled`, as above.
- **Background/non-audible tabs**: this whole mechanism is independent of
  `tab.audible` by design — that's the gap being fixed.

### Centralized guard, checked immediately before every destructive action

A single function, e.g. `getCallProtectionState(tab)`, is the only place
that answers "is this tab in a call." It's called:

- inside `shouldSuspend()` (`background.js`, alongside the existing
  `ns.audible`/`ns.pinned` checks) during the periodic eligibility scan, and
- again immediately before the actual destructive action executes (the
  snapshot→close step in Part 1, and any bulk "suspend all"/"close all"
  action), not only during the initial scan.

This matters because time can pass between "this tab was eligible" and "the
suspend actually runs" (queued operations), during which a call can start.
`confirmed` and `probable` both mean: never suspend, never close-to-vault,
never replace with a placeholder. `unknown` behaves like `probable`.

### Revalidation — recovering state after the fact

Background re-derives call state, rather than trusting a single point-in-time
read, on:

- content-script events (track `mute`/`unmute`/`ended`, new media element,
  SPA route change) pushed up immediately;
- a periodic in-content-script re-scan (defense in depth for missed events)
  reported on the existing 1-minute `ALARM_TICK`;
- content-script (re)connect — on load it immediately scans and reports,
  covering "tab was idle then joined a call" and "content script reloaded";
- service-worker restart — in-memory call state is not trusted after a
  restart; every tab is `unknown` until its content script reports fresh
  state, and `unknown` blocks destructive actions until then.

### Known-domain whitelist: safety layer, not proof of a call

`meet.google.com`, `zoom.us`, `teams.microsoft.com`, etc. ship as a
default-on **domain-level** protection (the whole domain, not just
meeting-path URLs — the safest default), independent of detected call
state. This is a floor, not the detection mechanism: a tab on a known
meeting domain is protected even at `possible`/`none` call state, unless the
user has explicitly configured an exception for that domain in settings
(extending the existing per-domain rules). Combined rule:

```
protect(tab) = callState in {confirmed, probable, unknown}
            OR (domain in knownMeetingDomains AND no user exception)
```

## Testing

New `tests/meeting_protection.test.js`, following the existing pattern of
testing pure functions against synthetic input (no real browser/WebRTC
needed — the state-reducer that turns "signals" into a call-state level is
a pure function):

- muted active call → `confirmed`
- camera-only call → `confirmed`
- microphone-only call → `confirmed`
- screen-share active → `confirmed`
- background (non-audible) tab with a live call → `confirmed`
- call started after the tab was already scanned → transitions `none`/`possible` → `confirmed` on next report
- SPA route transition, lobby → active call → `possible` → `confirmed`
- service-worker restart during an active call → `unknown` until fresh report, never destructive in the meantime
- close-to-vault attempted while `inCall` is `confirmed` → rejected by the centralized guard

Existing suites (`dashboard.test.js`, `lru_suspension.test.js`,
`restore_engine.test.js`) get extended fixtures covering vaulted (closed)
tabs mixed in with live tabs, to confirm the synthetic-entry merge doesn't
change existing suspended-tab behavior.
