# TabVault Architecture Documentation

This document describes the baseline architectural model inherited from upstream TabZen, the component responsibilities, the suspension and restoration pipelines, and the evolution path towards the TabVault intelligent tab lifecycle and state preservation system.

---

## 1. Upstream TabZen Baseline Architecture

Upstream TabZen is structured as a Manifest V3 Chrome Extension operating under a local-only, zero-telemetry principle.

```text
┌─────────────────────────────────────────────────────────────┐
│                    Chrome Browser Runtime                   │
└──────┬───────────────────────┬───────────────────────┬──────┘
       │                       │                       │
┌──────▼──────────────┐ ┌──────▼──────────────┐ ┌──────▼──────────────┐
│  Service Worker     │ │    Popup UI         │ │  Options Page UI    │
│  (background.js)    │ │   (popup/popup.js)  │ │ (options/options.js)│
└──────┬──────────────┘ └─────────────────────┘ └─────────────────────┘
       │
       ├───────────────────────┬───────────────────────┐
       │                       │                       │
┌──────▼──────────────┐ ┌──────▼──────────────┐ ┌──────▼──────────────┐
│   Content Script    │ │   Suspended Page    │ │ chrome.storage.local│
│    (content.js)     │ │(suspended/suspended)│ │ (settings, stats,   │
│                     │ │                     │ │  usage, sessions)   │
└─────────────────────┘ └─────────────────────┘ └─────────────────────┘
```

### Core Architecture Components

1. **Manifest V3 Core (`manifest.json`)**:
   - Background service worker: `background.js` (ephemeral lifecycle).
   - Action popup: `popup/popup.html` (interactive toolbar triage UI).
   - Options UI: `options/options.html` (dedicated full tab for settings).
   - Content script: `content.js` (injected on `<all_urls>` at `document_idle`).
   - Web accessible resources: `suspended/suspended.html` (local lightweight placeholder page).
   - Permissions: `tabs`, `tabGroups`, `storage`, `alarms`, `contextMenus`, `notifications`, `system.memory`.

2. **Background Service Worker (`background.js`)**:
   - Manages recurring sweeps via `chrome.alarms` (`tabvault-tick`, 1-minute period).
   - In-memory `tabState` Map storing `lastActiveAt`, `hasFormInput`, `audible`.
   - Rule evaluator supporting multi-mode matching (`domain`, `contains`, `exact`, `glob`, `regex`) for URLs and Tab Groups.
   - Intelligent modifiers: Time-of-day schedule, battery awareness (`navigator.getBattery`), system memory pressure (`chrome.system.memory`), visit-frequency learning heuristics.
   - Two suspension strategies:
     - **Replace**: Rewrites tab URL to `chrome-extension://.../suspended/suspended.html#u=<url>&t=<title>&f=<favicon>&at=<time>&w=<wakeAt>`.
     - **Discard**: Calls Chrome's native `chrome.tabs.discard(tabId)`.

3. **Popup Interface (`popup/popup.html`, `popup.js`)**:
   - Displays active tab context and memory reclamation estimate (~80MB / tab).
   - Lists idle tabs in current window sorted oldest first with time-based heatmap badges (`warm` >= 15m, `hot` >= 1h).
   - Provides quick actions: suspend current tab, suspend others in window, suspend across other windows, whitelist current domain.

4. **Options Panel (`options/options.html`, `options.js`)**:
   - Master toggle and default idle delay.
   - Never-suspend conditions (pinned, audible, form input, offline, active in window, on AC power, in group).
   - Whitelist and blacklist rule manager.
   - Per-domain and per-group custom timers.
   - Backup/export and import JSON configurations.

5. **Content Script (`content.js`)**:
   - Listens to input and change events on `input`, `textarea`, `[contenteditable]`.
   - Throttled via `requestAnimationFrame`.
   - Sends `{ type: "report-form-input", hasFormInput: boolean }` to background service worker.

6. **Suspended Page (`suspended/suspended.html`, `suspended.js`)**:
   - Renders tab card displaying favicon, title, beautified URL, last-active timestamp, snooze badge.
   - Restores tab on any interaction: keypress, mouse click, or visibility change when autoRestoreOnFocus is enabled.
   - Restoration method: `window.location.replace(originalUrl)`.

---

## 2. Suspension and Restoration Pipelines

### Suspension Code Path
```text
Sweep Alarm / Shortcut / Context Menu / Popup Action
                     │
                     ▼
             shouldSuspend(tab)
  ┌──────────────────┴──────────────────┐
  │ Check bypasses:                     │
  │ - Internal URLs (chrome://, etc.)   │
  │ - Already suspended / discarded     │
  │ - Whitelist & Never-suspend filters │
  │ - Idle duration >= effectiveTimeout │
  └──────────────────┬──────────────────┘
                     │ (Eligible)
                     ▼
              suspendTab(tabId)
  ┌──────────────────┴──────────────────┐
  │ If strategy === "discard":          │
  │   chrome.tabs.discard(tabId)        │
  │ Else:                               │
  │   url = buildSuspendedUrl(tab)      │
  │   chrome.tabs.update(tabId, { url })│
  └──────────────────┬──────────────────┘
                     │
                     ▼
         Update stats in storage
```

### Restoration Code Path
```text
User activates suspended tab / Click on card / Popup "Restore tab"
                     │
                     ▼
              restoreTab(tabId)
  ┌──────────────────┴──────────────────┐
  │ If suspended page:                  │
  │   Extract "u" parameter from hash   │
  │   chrome.tabs.update(tabId, { url })│
  │ If native discard:                  │
  │   chrome.tabs.reload(tabId)         │
  └──────────────────┬──────────────────┘
                     │
                     ▼
      Increment totalRestorations stat
```

---

## 3. Structural Deficiencies in Upstream Architecture

1. **Ephemeral Tab Ledger**: `tabState` is an in-memory Map in the service worker. Whenever the service worker terminates (after ~30s of inactivity in Manifest V3) or the browser restarts, all idle tracking and form dirty flags are lost until new events occur.
2. **State Destructiveness**: Replacing the URL or discarding the tab permanently loses form inputs, dynamic DOM state, and scroll position.
3. **Restoration Simplicity**: Upstream merely calls `window.location.replace(url)` or `chrome.tabs.reload(tabId)`. Delayed rendering, SPAs, and complex web apps are not restored to where the user left them.
4. **Unbounded Concurrency**: Restoring all tabs triggers simultaneous network and CPU loads without throttling or queueing.
5. **Lack of Lifecycle State Machine**: No explicit states exist (`ACTIVE`, `IDLE`, `SNAPSHOTTING`, `DISCARDED`, `RESTORING`, `RESTORED`, `RESTORE_FAILED`, `CLOSED`), making race conditions and corrupted states undetectable.

---

## 4. TabVault Architecture Evolution

TabVault introduces four modular subsystems integrated into the service worker and content scripts:

1. **Tab Lifecycle & Persistent Metadata Ledger (`lib/lifecycle.js`, `lib/metadata.js`)**:
   - Formal transition validation.
   - Persistent storage backed by `chrome.storage.local` with bounded capacity and tab ID remapping across restarts.
2. **Snapshot Storage Subsystem (`lib/snapshot-store.js`)**:
   - IndexedDB database (`tabvault-snapshots`) for rich snapshots (scroll coordinates, sanitized form data, screenshot preview metadata).
3. **Content Script State Engine (`content.js`)**:
   - Deep scroll capturing (x, y coordinates).
   - Safe form serializer excluding passwords, credit cards, and sensitive tokens.
   - Staggered restoration retries on page load (0ms, 500ms, 1500ms, 3000ms).
4. **Smart Restoration Engine & Concurrency Queue (`lib/restore-engine.js`)**:
   - Concurrency limits (max 3 parallel restores).
   - Site-specific state adapters (YouTube playback position, GitHub filters).
   - Timeout and error fallback handling.
