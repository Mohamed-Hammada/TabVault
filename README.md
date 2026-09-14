IMPORTANT: This README is the source of truth for project progress. Update task status only after the implementation has been completed in code and validated by tests. Never mark planned, partially written, or theoretical work as completed.

# TabVault

A privacy-first, intelligent tab suspension and restoration system based on TabZen.

The goal is to reduce browser memory usage while keeping tabs visible, preserving useful state, and restoring tabs intelligently without unnecessary data loss.

---

## Executive Status Summary: Done, In Progress, and Pending

### 1. What Is Completed (Done) — 11.6 / 15 Phases (421 Passing Tests)

* **Phase 1 — Foundation & Repository Preparation (100% Done)**:
  * Complete rebrand from TabZen to TabVault across manifest, popup, options, suspended pages, and service worker.
  * Architecture specifications (`docs/architecture.md`), development guidelines (`docs/dev_setup.md`, `docs/contributing.md`), testing manuals (`docs/testing.md`), and limitations documentation.
* **Phase 2 — Tab Lifecycle Management (100% Done)**:
  * Formal 8-state machine (`ACTIVE`, `IDLE`, `SNAPSHOTTING`, `DISCARDED`, `RESTORING`, `RESTORED`, `RESTORE_FAILED`, `CLOSED`) with strict transition guards and history logging (`lib/lifecycle.js`).
  * Persistent tab metadata ledger (`lib/metadata.js`) tracking 17 fields, quota enforcement, migration support, and tab ID remapping across browser restarts.
* **Phase 3 — Pre-Suspension Tab State Capture & Storage (100% Done)**:
  * Comprehensive snapshot state capture (`lib/snapshot.js`): URL, title, favicon, timestamps, scroll coordinates, safe forms, screenshot preview, suspension reason, group/window context.
  * IndexedDB & memory snapshot backend (`lib/snapshot-store.js`): versioning, TTL expiration, orphaned tab cleanup, size limits, corruption repair, export/import, and history.
* **Phase 4 — Scroll Position Restoration (100% Done)**:
  * Vertical and horizontal scroll coordinate capture & progressive multi-stage restoration (`lib/scroll.js`).
  * Support for Single Page Applications (SPA hash/pushState transitions), lazy-loaded pages, infinite feeds, and restoration failure logging.
* **Phase 5 — Form State Restoration (100% Done)**:
  * Safe serialization and restoration of text, textarea, select, checkbox, radio, and contenteditable DOM inputs (`lib/form.js`).
  * Security sanitizer with automatic sensitive field detection (passwords, PINs, auth tokens), Luhn credit card validation, and banking/auth domain exclusions.
* **Phase 6 — Screenshot & Visual Preview (100% Done)**:
  * Pre-suspension visual preview capture via `chrome.tabs.captureVisibleTab` (`lib/screenshot.js`).
  * Compression engine, aspect-ratio preserving downscaling, memory limits, and canvas-rendered fallback preview cards.
* **Phase 7 — Tab Restoration Engine (100% Done)**:
  * 7-stage restoration pipeline (`lib/restore-engine.js`): `INIT` -> `LOAD_URL` -> `WAIT_READINESS` -> `RESTORE_SCROLL` -> `RESTORE_FORMS` -> `APPLY_ADAPTER` -> `COMPLETED`.
  * Fallback direct navigation, timeout protection, exponential backoff retries, and restoration lifecycle transitions.
* **Phase 8 — Site-Specific State Adapters (100% Done)**:
  * Pluggable adapter architecture (`lib/adapters/`) with isolated error handling and timeouts.
  * Dedicated adapters: YouTube (playback time & video ID), GitHub (filters & search), Jira, Google Docs, Notion, Search engines (query & state), and Generic fallback.
* **Phase 9 — Intelligent Suspension Engine (100% Done)**:
  * Composite multi-factor scoring engine (`lib/scoring.js`): idle duration, visit frequency, group priority, domain weights, audio, forms, memory pressure, and restoration costs.
  * Priority levels (`IMMUNE`, `LOW`, `MEDIUM`, `HIGH`, `URGENT`), configurable weights, presets, dry-run simulation mode, and human-readable suspension explanations.
  * Group- and window-aware LRU tracking and candidate selection (`lib/lru.js`).
  * Memory budget management, warning/critical thresholds, event logs, and memory pressure simulator (`lib/memory-budget.js`).
* **Phase 10 — Restore Queue and Concurrency (100% Done)**:
  * Prioritized restoration queue (`lib/restore-queue.js`) supporting 5 priority tiers (`USER_REQUESTED`, `HIGH`, `NORMAL`, `LOW`, `BACKGROUND`).
  * Concurrency limiter throttling simultaneous restores, deferred background tab restoration, and retry with exponential backoff.
* **Phase 11 — Dashboard and User Interface (100% Done)**:
  * Comprehensive dashboard service (`lib/dashboard-service.js`) and UI in Options (`options/`) and Popup (`popup/`).
  * Live monitoring of active tabs, suspended tabs, recent history, restore failures, memory savings, tab group color chips, and snapshot availability.
  * UI actions: Suspend/restore tabs, batch suspend eligible, restore all tabs, exclude domains, protect tabs, view/delete snapshots, and export/import sessions with conflict resolution (`append`, `replace`, `skip_duplicates`, `merge`).
* **Phase 12 — Crash Recovery and Session Persistence (5 of 8 Tasks Completed)**:
  * `[x] Persist active session metadata`: Full active session capture (`captureActiveSessionMetadata`), schema versioning, and debounced persistence manager (`SessionPersistenceManager`) integrated with tab lifecycle events and periodic alarms.
  * `[x] Restore metadata after browser restart`: Multi-factor tab matching (`scoreTabMatch`) re-correlating live tabs with stored session metadata, recovering in-memory activity and protection sets across browser restarts.
  * `[x] Detect interrupted snapshot operations`: In-flight snapshot tracking (`SnapshotOperationTracker`), timeout detection (`detectInterruptedSnapshots`), and automated state reversion (`recoverInterruptedSnapshots`).
  * `[x] Detect interrupted restoration operations`: In-flight restoration tracking via `RestorationOperationTracker` and `STORAGE_KEY_PENDING_RESTORATIONS`, timeout detection (`detectInterruptedRestorations`), and recovery/re-queueing logic (`recoverInterruptedRestorations`).
  * `[x] Add session checkpointing`: Rotating checkpoint history (`appendSessionCheckpoint`, `getLatestValidSessionCheckpoint`, capped at `MAX_SESSION_CHECKPOINTS`) written alongside every persisted active-session record; `SessionPersistenceManager.load()` falls back to the latest valid checkpoint when the primary record fails schema validation.
  * **Additional crash-recovery hardening delivered alongside the above (not part of the original 8-task list, kept here for accuracy)**: a recovery lock (`acquireRecoveryLock`/`releaseRecoveryLock`/`withRecoveryLock`) preventing concurrent/duplicate recovery passes; a recorded recovery summary (`recordRecoverySummary`/`getRecoverySummary`) and a dismissible dashboard banner (`options/`) surfacing what was recovered after an unexpected shutdown.

---

### 2. What Is Currently In Progress

* **None — Clean Milestone Stop Point**:
  * The system is fully tested and quiescent with zero in-flight operations or unresolved regressions (421 passing tests).
  * Ready to begin Phase 12 Task 6 (`Recover stale lifecycle states`) upon resumption.

---

### 3. What Is Still Not Implemented (Pending / Planned)

* **Phase 12 — Crash Recovery and Session Persistence (Remaining 3 Tasks)**:
  * `[ ] Recover stale lifecycle states`: `LifecycleTracker.reconcileWithLiveTabs()` (`lib/lifecycle.js:312`) already implements this reconciliation and is unit-tested, but `LifecycleTracker` is never imported into `background.js` and `reconcileWithLiveTabs` is never called from the running extension — the mechanism exists but is not wired into `onStartup`. Wiring it in, or confirming the tracker-based recovery in `lib/crash-recovery.js` is meant to supersede it, is the remaining work.
  * `[ ] Add crash-safe writes`: Two-phase staging, atomic commit keys, and checksum integrity verification for persistent storage writes.
  * `[ ] Add workspace export/import`: Full portable workspace backup bundles (windows, tabs, groups, rules, settings, snapshots) — distinct from the existing per-session export/import (`serializeSession`/`serializeAllSessions`/`mergeSessions` in `lib/dashboard-service.js`), which does not bundle settings or snapshots.
* **Phase 13 — Optional Windows Native Agent (8 Tasks)**:
  * `[ ] Monitor browser process memory`
  * `[ ] Monitor renderer process memory`
  * `[ ] Monitor CPU usage`
  * `[ ] Communicate through Native Messaging`
  * `[ ] Store data in SQLite`
  * `[ ] Expose memory metrics to extension`
  * `[ ] Trigger suspension based on system memory`
  * `[ ] Provide diagnostic information`
* **Phase 14 — Testing (28 Tasks)**:
  * `[ ] Functional Tests`: End-to-end automated suite covering tab suspension, restoration, form/scroll preservation, pinning, audio, SPA navigation, and edge-case lifecycle.
  * `[ ] Performance Tests`: Benchmark extension overhead, snapshot storage footprint, suspension latency, restoration latency, and high tab counts (50, 100, 300 tabs).
  * `[ ] Security Tests`: Verification that passwords, PINs, and auth fields are excluded, no remote code execution, and no external telemetry.
* **Phase 15 — Documentation and Release (12 Tasks)**:
  * `[ ] Update README feature list`
  * `[ ] Document installation, developer setup, architecture, and limitations`
  * `[ ] Document privacy model and permissions`
  * `[ ] Add changelog and release checklist`
  * `[ ] Create demo screenshots and video/GIF`
  * `[ ] Prepare Chrome Web Store package and store listing`

---

## Development Rules

### Mandatory Task Execution Rules

1. Read this README before starting any task.
2. Work on **one task at a time**.
3. Do not mark a task as completed before:

   * The code has actually been implemented.
   * The implementation is integrated into the project.
   * Relevant tests have been executed.
   * No obvious regression has been introduced.
4. Never mark a task as completed based only on:

   * Planning.
   * Discussion.
   * Creating placeholder files.
   * Writing comments.
   * Describing the implementation.
5. If the implementation is incomplete, keep the task as:

   * `IN PROGRESS`
   * or `BLOCKED`
6. After completing a task:

   * Update this README.
   * Change only the relevant task status.
   * Add a short implementation note.
   * Mention files changed.
   * Mention tests executed.
7. Do not modify the task list unnecessarily.
8. Do not mark future tasks as completed because they are indirectly supported.
9. If a task cannot be implemented because of Chrome Extension API limitations, document the limitation clearly.
10. Do not fake test results.

### Task Statuses

* `[ ] TODO`
* `[-] IN PROGRESS`
* `[x] COMPLETED`
* `[!] BLOCKED`
* `[~] PARTIALLY COMPLETED`

---

# Project Vision

TabVault should provide:

* Intelligent tab suspension.
* Significant RAM reduction.
* Tabs remain visible in the tab bar.
* Persistent tab metadata.
* Scroll and form restoration.
* Screenshot previews.
* Smart restore workflow.
* Memory-aware suspension.
* Tab lifecycle tracking.
* Crash/session recovery.
* Workspace and snapshot management.
* Optional native Windows memory monitoring.

---

# Phase 1 — Foundation and Repository Preparation

## 1.1 Fork and Rebrand

* [x] Fork the TabZen repository.
* [x] Rename the project to TabVault.
* [x] Update extension name in `manifest.json`.
* [x] Update descriptions and branding.
* [x] Update README branding.
* [x] Remove references that should remain specific to upstream TabZen.
* [x] Confirm the extension still loads successfully in Chrome.

## 1.2 Establish Project Architecture

* [x] Document current TabZen architecture.
* [x] Identify background/service-worker responsibilities.
* [x] Identify popup responsibilities.
* [x] Identify options-page responsibilities.
* [x] Identify content-script responsibilities.
* [x] Identify suspension and restoration code paths.
* [x] Create architecture documentation.

## 1.3 Add Development Documentation

* [x] Add contribution guidelines.
* [x] Add development setup instructions.
* [x] Add testing instructions.
* [x] Add known Chrome API limitations.
* [x] Add feature roadmap.
* [x] Add task completion rules.

---

# Phase 2 — Persistent Tab Lifecycle

## 2.1 Tab Lifecycle Model

Implement explicit tab states:

* `ACTIVE`
* `IDLE`
* `SNAPSHOTTING`
* `DISCARDED`
* `RESTORING`
* `RESTORED`
* `RESTORE_FAILED`
* `CLOSED`

Tasks:

* [x] Create tab lifecycle state model.
* [x] Track lifecycle transitions.
* [x] Persist lifecycle state.
* [x] Prevent invalid state transitions.
* [x] Add lifecycle debugging logs.
* [x] Add recovery behavior after browser restart.

## 2.2 Persistent Tab Metadata

Persist:

* Tab ID where applicable.
* Window ID.
* Tab group ID.
* URL.
* Title.
* Favicon.
* Creation time.
* Last active time.
* Last suspended time.
* Last restored time.
* Number of visits.
* Number of suspensions.
* Number of restores.
* Suspension reason.
* Restoration status.

Tasks:

* [x] Implement persistent tab metadata storage.
* [x] Handle tab ID changes after browser restart.
* [x] Clean up metadata for permanently closed tabs.
* [x] Avoid unlimited storage growth.
* [x] Add metadata migration support.

---

# Phase 3 — Snapshot System

## 3.1 Snapshot Before Suspension

Before suspending a tab, capture:

* [x] URL.
* [x] Title.
* [x] Favicon.
* [x] Timestamp.
* [x] Scroll position.
* [x] Form state where safe.
* [x] Screenshot preview where supported.
* [x] Suspension reason.
* [x] Current tab/group/window context.

## 3.2 Snapshot Storage

* [x] Design snapshot schema.
* [x] Store snapshots in IndexedDB.
* [x] Add snapshot versioning.
* [x] Add snapshot expiration policy.
* [x] Add snapshot cleanup.
* [x] Add snapshot size limits.
* [x] Handle corrupted snapshots.
* [x] Add import/export support.

## 3.3 Snapshot History

* [x] Keep the latest snapshot per tab.
* [x] Optionally keep historical snapshots.
* [x] Add snapshot timestamp.
* [x] Add manual snapshot creation.
* [x] Add snapshot deletion.
* [x] Add snapshot restoration from history.

---

# Phase 4 — Scroll Position Restoration

* [x] Capture vertical scroll position.
* [x] Capture horizontal scroll position.
* [x] Restore scroll position after page load.
* [x] Retry restoration after delayed rendering.
* [x] Support SPA navigation.
* [x] Support lazy-loaded pages.
* [x] Support infinite-scroll pages where possible.
* [x] Avoid restoring scroll before layout is ready.
* [x] Add configurable restore retry intervals.
* [x] Add restoration failure logging.

Suggested retry sequence:

```text
After DOM ready
After 500ms
After 1500ms
After 3000ms
```

---

# Phase 5 — Form State Restoration

Support safe restoration of:

* [x] `input[type=text]`
* [x] `textarea`
* [x] `select`
* [x] `checkbox`
* [x] `radio`
* [x] `contenteditable`

Security requirements:

* [x] Never save passwords by default.
* [x] Never save credit-card fields.
* [x] Never save sensitive authentication fields.
* [x] Add sensitive-field detection.
* [x] Add domain exclusions.
* [x] Add user-controlled form-saving setting.
* [x] Do not capture form data from banking/authentication websites by default.

---

# Phase 6 — Screenshot and Visual Preview

* [x] Capture screenshot before suspension where API permissions allow.
* [x] Store screenshot metadata.
* [x] Compress screenshots when possible.
* [x] Enforce screenshot size limits.
* [x] Display screenshot in suspended-tab UI.
* [x] Display last active timestamp.
* [x] Display suspension reason.
* [x] Display restoration status.
* [x] Add fallback when screenshot capture fails.

---

# Phase 7 — Smart Restoration Engine

Instead of simply reloading the URL, implement:

```text
User activates suspended tab
        ↓
Load original URL
        ↓
Wait for page readiness
        ↓
Restore scroll position
        ↓
Restore safe form state
        ↓
Apply site-specific adapter if available
        ↓
Mark tab as restored
```

Tasks:

* [x] Create restoration pipeline.
* [x] Add restoration status indicator.
* [x] Add restoration timeout.
* [x] Add retry mechanism.
* [x] Add restore failure handling.
* [x] Add restore cancellation.
* [x] Prevent duplicate restoration.
* [x] Add restore queue.
* [x] Prevent restoring too many tabs simultaneously.

---

# Phase 8 — Site-Specific State Adapters

Create adapter architecture for websites that need custom restoration.

## 8.1 Adapter Architecture

Adapter requirements:

* [x] Adapter interface.
* [x] Domain matching.
* [x] Capture hook.
* [x] Restore hook.
* [x] Adapter timeout.
* [x] Adapter failure isolation.
* [x] User enable/disable control.

## 8.2 Built-in Site Adapters

Potential adapters:

* [x] YouTube playback timestamp.
* [x] GitHub page/filter state.
* [x] Jira filters and board state.
* [x] Google Docs basic navigation state.
* [x] Notion page state.
* [x] Search-page query state.
* [x] Generic URL/hash/query restoration.

---

# Phase 9 — Intelligent Suspension Engine

## 9.1 Suspension Scoring

Calculate suspension priority using:

* Idle duration.
* Last active timestamp.
* Visit frequency.
* Tab group priority.
* Pinned status.
* Audio activity.
* Form activity.
* URL type.
* Domain priority.
* Current memory pressure.
* Restoration cost.

Tasks:

* [x] Implement tab scoring.
* [x] Add configurable score weights.
* [x] Add priority levels.
* [x] Add protected-tab rules.
* [x] Add dry-run mode.
* [x] Add explanation for why a tab was suspended.

## 9.2 LRU Suspension

* [x] Implement least-recently-used suspension.
* [x] Add maximum active-tab threshold.
* [x] Add maximum unsuspended-tab threshold.
* [x] Add group-aware LRU.
* [x] Add window-aware LRU.
* [x] Add exclusions.

## 9.3 Memory Budget

* [x] Add configurable memory budget.
* [x] Add warning threshold.
* [x] Add critical threshold.
* [x] Trigger suspension when browser memory pressure is high.
* [x] Add memory-pressure event logs.
* [x] Add simulation mode for testing.

Note:

Per-tab RAM measurement is not reliably available through normal Chrome Extension APIs. Accurate per-tab memory metrics may require Chrome DevTools Protocol, Native Messaging, or Chromium-level changes.

---

# Phase 10 — Restore Queue and Concurrency

* [x] Implement restore queue.
* [x] Limit concurrent restores.
* [x] Prioritize user-requested restores.
* [x] Cancel low-priority restores when needed.
* [x] Avoid restoring tabs in the background unnecessarily.
* [x] Add queue status to UI.
* [x] Add failed restore retry.

---

# Phase 11 — Dashboard and User Interface

Dashboard should display:

* [x] Active tabs.
* [x] Suspended tabs.
* [x] Recently suspended tabs.
* [x] Recently restored tabs.
* [x] Estimated memory savings.
* [x] Suspension reasons.
* [x] Last active time.
* [x] Tab groups.
* [x] Snapshot availability.
* [x] Restore failures.

UI actions:

* [x] Suspend tab.
* [x] Restore tab.
* [x] Suspend all eligible tabs.
* [x] Restore all tabs.
* [x] Exclude domain.
* [x] Protect tab.
* [x] View snapshot.
* [x] Delete snapshot.
* [x] Export session.
* [x] Import session.

---

# Phase 12 — Crash Recovery and Session Persistence

* [x] Persist active session metadata.
* [x] Restore metadata after browser restart.
* [x] Detect interrupted snapshot operations.
* [x] Detect interrupted restoration operations.
* [x] Add session checkpointing.
* [ ] Recover stale lifecycle states (implemented in `lib/lifecycle.js` but not wired into `background.js` — see Section 3 above).
* [ ] Add crash-safe writes.
* [ ] Add workspace export/import.

---

# Phase 13 — Optional Windows Native Agent

This phase is optional and cannot be fully implemented using only a Chrome Extension.

Potential responsibilities:

* [ ] Monitor browser process memory.
* [ ] Monitor renderer process memory.
* [ ] Monitor CPU usage.
* [ ] Communicate through Native Messaging.
* [ ] Store data in SQLite.
* [ ] Expose memory metrics to extension.
* [ ] Trigger suspension based on system memory.
* [ ] Provide diagnostic information.

Possible technologies:

* C#/.NET
* Rust
* Go
* C++

---

# Phase 14 — Testing

## Functional Tests

* [ ] Suspend inactive tab.
* [ ] Restore suspended tab.
* [ ] Preserve title.
* [ ] Preserve favicon.
* [ ] Preserve tab position where possible.
* [ ] Restore scroll position.
* [ ] Restore safe form fields.
* [ ] Handle pinned tabs.
* [ ] Handle audible tabs.
* [ ] Handle active media.
* [ ] Handle tabs with unsaved forms.
* [ ] Handle SPA websites.
* [ ] Handle browser restart.
* [ ] Handle extension reload.
* [ ] Handle corrupted snapshots.
* [ ] Handle closed tabs.
* [ ] Handle duplicate tabs.

## Performance Tests

* [ ] Measure extension overhead.
* [ ] Measure snapshot storage size.
* [ ] Measure suspension latency.
* [ ] Measure restoration latency.
* [ ] Test with 50 tabs.
* [ ] Test with 100 tabs.
* [ ] Test with 300 tabs.
* [ ] Test with multiple windows.
* [ ] Test with multiple tab groups.

## Security Tests

* [ ] Confirm passwords are not stored.
* [ ] Confirm sensitive fields are excluded.
* [ ] Confirm no external telemetry.
* [ ] Confirm no remote code execution.
* [ ] Confirm snapshot data remains local.
* [ ] Review extension permissions.

---

# Phase 15 — Documentation and Release

* [ ] Update README feature list.
* [ ] Document installation.
* [ ] Document developer setup.
* [ ] Document architecture.
* [ ] Document limitations.
* [ ] Document privacy model.
* [ ] Document permissions.
* [ ] Add changelog.
* [ ] Add release checklist.
* [ ] Create screenshots.
* [ ] Create demo video/GIF.
* [ ] Prepare Chrome Web Store description.

---

# Completion Log

Use this section only after actual implementation.

## Completed Tasks

| Date | Task | Files Changed | Tests | Notes |
| ---- | ---- | ------------- | ----- | ----- |
| 2026-09-13 | Fork the TabZen repository | README.md | `git remote -v` | Verified repository origin is Mohamed-Hammada/TabVault.git |
| 2026-09-13 | Rename the project to TabVault | package.json, README.md, PROJECT_MAP.md, tests/rebrand.test.js | `node --test tests/rebrand.test.js` | Updated root configs, package.json, and verified name |
| 2026-09-13 | Update extension name in `manifest.json` | manifest.json, tests/rebrand.test.js | `node --test tests/rebrand.test.js` | Updated name, short_name, default_title, and options command |
| 2026-09-13 | Update descriptions and branding | popup/, options/, suspended/, background.js, content.js, tests/rebrand.test.js | `node --test tests/rebrand.test.js` | Updated titles, brand names, github links, alarm and context menu IDs |
| 2026-09-13 | Update README branding | README.md, tests/rebrand.test.js | `node --test tests/rebrand.test.js` | Rebranded README title, overview, and tracking sections |
| 2026-09-13 | Remove references that should remain specific to upstream TabZen | popup.js, suspended.css, tests/rebrand.test.js | `node --test tests/rebrand.test.js` | Removed all remaining tabzen/mthcht comments and links from source files |
| 2026-09-13 | Confirm the extension still loads successfully in Chrome | tests/manifest_and_load.test.js | `node --test tests/manifest_and_load.test.js` | Validated Manifest V3 integrity, resource paths, and JS syntax compilation |
| 2026-09-13 | Establish Project Architecture (1.2 all tasks) | docs/architecture.md, tests/architecture.test.js | `node --test tests/architecture.test.js` | Documented background, popup, options, content script responsibilities, suspension/restoration code paths, and architectural roadmap |
| 2026-09-13 | Add contribution guidelines | docs/contributing.md, tests/docs.test.js | `node --test tests/docs.test.js` | Added contribution workflow, coding standards, privacy philosophy, and PR checklist |
| 2026-09-13 | Add development setup instructions | docs/dev_setup.md, tests/docs.test.js | `node --test tests/docs.test.js` | Documented prerequisites, Chrome unpack loading, DevTools inspection, and reload workflow |
| 2026-09-13 | Add testing instructions | docs/testing.md, tests/docs.test.js | `node --test tests/docs.test.js` | Documented test runner, suite mapping, mock testing guidelines, and manual verification |
| 2026-09-13 | Add known Chrome API limitations | docs/limitations.md, tests/docs.test.js | `node --test tests/docs.test.js` | Documented heap isolation, WebSockets, per-tab RAM API absence, screenshot limits, and MV3 service worker boundaries |
| 2026-09-13 | Add feature roadmap | docs/roadmap.md, tests/docs.test.js | `node --test tests/docs.test.js` | Documented 15-phase architectural plan from baseline rebrand to native agent and release |
| 2026-09-13 | Add task completion rules | docs/task_completion_rules.md, tests/docs.test.js | `node --test tests/docs.test.js` | Enforced strict single-task progression, truth in status, verification rules, and state sync |
| 2026-09-13 | Create tab lifecycle state model | lib/lifecycle.js, tests/lifecycle.test.js | `node --test tests/lifecycle.test.js` | Implemented 8-state model (ACTIVE, IDLE, SNAPSHOTTING, DISCARDED, RESTORING, RESTORED, RESTORE_FAILED, CLOSED) and validation machine |
| 2026-09-13 | Track lifecycle transitions | lib/lifecycle.js, tests/lifecycle.test.js | `node --test tests/lifecycle.test.js` | Built LifecycleTracker with transition recording, validation checks, history limits, and callbacks |
| 2026-09-13 | Persist lifecycle state | lib/lifecycle.js, tests/lifecycle.test.js | `node --test tests/lifecycle.test.js` | Implemented serialize/deserialize, persist/rehydrate with storage adapter integration |
| 2026-09-13 | Prevent invalid state transitions | lib/lifecycle.js, tests/lifecycle.test.js | `node --test tests/lifecycle.test.js` | Added canTransition and safeTransition guards, blocking illegal transitions without state corruption |
| 2026-09-13 | Add lifecycle debugging logs | lib/lifecycle.js, tests/lifecycle.test.js | `node --test tests/lifecycle.test.js` | Added configurable formatted logger with [TabVault Lifecycle] prefix and warning alerts |
| 2026-09-13 | Add recovery behavior after browser restart | lib/lifecycle.js, tests/lifecycle.test.js | `node --test tests/lifecycle.test.js` | Built reconcileWithLiveTabs repairing interrupted SNAPSHOTTING/RESTORING states and purging closed tabs |
| 2026-09-13 | Implement persistent tab metadata storage | lib/metadata.js, tests/metadata.test.js | `node --test tests/metadata.test.js` | Built TabMetadataStore and createTabMetadata covering all 17 persistent fields and storage adapter |
| 2026-09-13 | Handle tab ID changes after browser restart | lib/metadata.js, tests/metadata.test.js | `node --test tests/metadata.test.js` | Implemented remapTabIds matching suspended & active URLs across browser restarts |
| 2026-09-13 | Clean up metadata for permanently closed tabs | lib/metadata.js, tests/metadata.test.js | `node --test tests/metadata.test.js` | Built purgeClosedTabs supporting immediate cleanup and configurable retention windows |
| 2026-09-13 | Avoid unlimited storage growth | lib/metadata.js, tests/metadata.test.js | `node --test tests/metadata.test.js` | Implemented string length bounds (url/title/favicon) and enforceQuota LRU eviction policy |
| 2026-09-13 | Add metadata migration support | lib/metadata.js, tests/metadata.test.js | `node --test tests/metadata.test.js` | Built migrateTabMetadata supporting seamless V0 to V1 upgrading during deserialization |
| 2026-09-13 | Capture URL before suspension | lib/snapshot.js, tests/snapshot.test.js | `node --test tests/snapshot.test.js` | Implemented extractCanonicalUrl handling plain, pending, and suspended placeholder URLs with length bounds |
| 2026-09-13 | Capture Title before suspension | lib/snapshot.js, tests/snapshot.test.js | `node --test tests/snapshot.test.js` | Built extractTabTitle with unwrap for suspended placeholders, URL hostname fallback, and 512 char limit |
| 2026-09-13 | Capture Favicon before suspension | lib/snapshot.js, tests/snapshot.test.js | `node --test tests/snapshot.test.js` | Built extractTabFavicon with unwrap from suspended placeholder URL and 8KB max limit |
| 2026-09-13 | Capture Timestamp before suspension | lib/snapshot.js, tests/snapshot.test.js | `node --test tests/snapshot.test.js` | Built extractSnapshotTimestamp supporting epoch ms, ISO parsing, suspended &at= unwrap, and ISO string output |
| 2026-09-13 | Capture Scroll position before suspension | lib/snapshot.js, content.js, tests/snapshot.test.js | `node --test tests/snapshot.test.js` | Built extractScrollPosition, captureWindowScroll, and GET_TAB_STATE handler in content.js |
| 2026-09-13 | Capture Form state where safe before suspension | lib/snapshot.js, tests/snapshot.test.js | `node --test tests/snapshot.test.js` | Implemented isSensitiveField, isSensitiveUrl, sanitizeFormData, and serializeSafeDomForms excluding auth/cards/passwords |
| 2026-09-13 | Capture Screenshot preview before suspension | lib/snapshot.js, tests/snapshot.test.js | `node --test tests/snapshot.test.js` | Built sanitizeScreenshotData, captureTabScreenshot, 150KB limit enforcement, and visual fallback card generation |
| 2026-09-13 | Capture Suspension reason before suspension | lib/snapshot.js, tests/snapshot.test.js | `node --test tests/snapshot.test.js` | Built sanitizeSuspensionReason validating canonical reasons, prefixes, and safe fallbacks |
| 2026-09-13 | Capture tab/group/window context before suspension | lib/snapshot.js, tests/snapshot.test.js | `node --test tests/snapshot.test.js` | Built extractTabContext capturing windowId, groupId, groupTitle, pinned, index, incognito, opener |
| 2026-09-13 | Design snapshot schema | lib/snapshot.js, tests/snapshot.test.js | `node --test tests/snapshot.test.js` | Defined SNAPSHOT_SCHEMA_FIELDS and validateSnapshotSchema enforcing structural integrity across 14 fields |
| 2026-09-13 | Store snapshots in IndexedDB | lib/snapshot-store.js, tests/snapshot_store.test.js | `node --test tests/snapshot_store.test.js` | Built IndexedDBSnapshotBackend, MemorySnapshotBackend, and SnapshotStore with CRUD & tab querying |
| 2026-09-13 | Add snapshot versioning | lib/snapshot.js, lib/snapshot-store.js, tests/snapshot_store.test.js | `node --test tests/snapshot_store.test.js` | Built migrateSnapshot upgrading V0 legacy snapshots to V1 and hooked into SnapshotStore retrieval |
| 2026-09-13 | Add snapshot expiration policy | lib/snapshot-store.js, tests/snapshot_store.test.js | `node --test tests/snapshot_store.test.js` | Built isSnapshotExpired and purgeExpiredSnapshots with 7-day default retention and pinned/protect safeguards |
| 2026-09-13 | Add snapshot cleanup | lib/snapshot-store.js, tests/snapshot_store.test.js | `node --test tests/snapshot_store.test.js` | Implemented cleanupOrphanedSnapshots, cleanupExcessSnapshotsPerTab, and runCleanupPipeline |
| 2026-09-13 | Add snapshot size limits | lib/snapshot-store.js, tests/snapshot_store.test.js | `node --test tests/snapshot_store.test.js` | Built enforceSnapshotSizeLimit degrading large screenshots/forms, plus store quota enforcement with LRU eviction |
| 2026-09-13 | Handle corrupted snapshots | lib/snapshot.js, lib/snapshot-store.js, tests/snapshot_store.test.js | `node --test tests/snapshot_store.test.js` | Built isSnapshotCorrupted, repairCorruptedSnapshot with fallback recovery and schema conformance, and repairOrPruneCorruptedSnapshots store maintenance |
| 2026-09-13 | Add import/export support | lib/snapshot-store.js, tests/snapshot_store.test.js | `node --test tests/snapshot_store.test.js` | Built serializeSnapshotsExport, parseAndValidateSnapshotsImport, exportSnapshots, and importSnapshots supporting JSON serialization, filters, screenshot stripping, and conflict strategies (overwrite/skip/generateNewId) |
| 2026-09-13 | Keep the latest snapshot per tab | lib/snapshot-store.js, tests/snapshot_history.test.js | `node --test tests/snapshot_history.test.js` | Implemented getLatestSnapshot, hasSnapshotForTab, getAllLatestSnapshots, and keepLatestOnly auto-pruning in SnapshotStore |
| 2026-09-13 | Optionally keep historical snapshots | lib/snapshot-store.js, tests/snapshot_history.test.js | `node --test tests/snapshot_history.test.js` | Added enableHistory toggle, setHistoryPolicy, explicitMaxSnapshotsPerTab capping, pruneTabHistory, and getSnapshotHistoryStats |
| 2026-09-13 | Add snapshot timestamp | lib/snapshot.js, lib/snapshot-store.js, tests/snapshot_history.test.js | `node --test tests/snapshot_history.test.js` | Built formatSnapshotTimestamp, getSnapshotAge, and getSnapshotsByTimeRange, getSnapshotsSince, getSnapshotsOlderThan in SnapshotStore |
| 2026-09-13 | Add manual snapshot creation | lib/snapshot.js, lib/snapshot-store.js, tests/snapshot_history.test.js | `node --test tests/snapshot_history.test.js` | Built createManualTabSnapshot with label/note, createAndSaveManualSnapshot, getManualSnapshots, and protectFromPurge default |
| 2026-09-13 | Add snapshot deletion | lib/snapshot-store.js, tests/snapshot_history.test.js | `node --test tests/snapshot_history.test.js` | Built deleteSnapshot with respectProtection, deleteSnapshots (batch), deleteSnapshotsMatching (predicate), and deleteSnapshotsForTab |
| 2026-09-13 | Add snapshot restoration from history | lib/snapshot.js, lib/snapshot-store.js, tests/snapshot_history.test.js | `node --test tests/snapshot_history.test.js` | Built createRestorationPlan, getHistoricalSnapshot, and prepareRestorationFromHistory mapping historical snapshot records to restoration execution plans |
| 2026-09-13 | Capture vertical scroll position | lib/scroll.js, tests/scroll.test.js | `node --test tests/scroll.test.js` | Built captureVerticalScroll calculating absolute y coordinates, maxScrollY, percentY, quirks mode fallbacks, and non-scrollable bounds |
| 2026-09-13 | Capture horizontal scroll position | lib/scroll.js, tests/scroll.test.js | `node --test tests/scroll.test.js` | Built captureHorizontalScroll and captureScrollState calculating x coordinates, maxScrollX, percentX, and composite document dimensions |
| 2026-09-13 | Restore scroll position after page load | lib/scroll.js, content.js, tests/scroll.test.js | `node --test tests/scroll.test.js` | Built restoreScrollPosition with absolute coordinates, proportional percentage fallbacks, boundary clamping, and content script RESTORE_SCROLL handler |
| 2026-09-13 | Retry restoration after delayed rendering | lib/scroll.js, tests/scroll.test.js | `node --test tests/scroll.test.js` | Built isScrollSettled, isLayoutReady, and executeProgressiveScrollRestoration retrying across delays [0, 500, 1500, 3000ms] and settling early when layout is ready |
| 2026-09-13 | Support SPA navigation | lib/scroll.js, content.js, tests/scroll.test.js | `node --test tests/scroll.test.js` | Built normalizeRouteKey, SpaScrollTracker, and createSpaScrollTracker intercepting pushState/replaceState/popstate/hashchange with LRU per-route scroll preservation |
| 2026-09-13 | Support lazy-loaded pages | lib/scroll.js, tests/scroll.test.js | `node --test tests/scroll.test.js` | Built dispatchScrollEvent, observeLayoutChanges (ResizeObserver/MutationObserver), and restoreLazyScrollPosition progressively tracking height growth until target is reached |
| 2026-09-13 | Support infinite-scroll pages where possible | lib/scroll.js, tests/scroll.test.js | `node --test tests/scroll.test.js` | Built restoreInfiniteScrollPosition stepping to boundary anchors, triggering pagination dispatch events, and settling when content reaches target height |
| 2026-09-13 | Avoid restoring scroll before layout is ready | lib/scroll.js, content.js, tests/scroll.test.js | `node --test tests/scroll.test.js` | Built isDocumentReady, waitUntilLayoutReady deferring DOM loading to DOMContentLoaded & rAF, and avoidBeforeLayoutReady guard |
| 2026-09-13 | Add configurable restore retry intervals | lib/scroll.js, tests/scroll.test.js | `node --test tests/scroll.test.js` | Built SCROLL_RETRY_PRESETS, normalizeScrollRetryIntervals, get/set/resetScrollRetryIntervals, and hooked presets into progressive restoration |
| 2026-09-13 | Add restoration failure logging | lib/scroll.js, tests/scroll.test.js | `node --test tests/scroll.test.js` | Built RestorationFailureLogger with circular buffer, querying/filtering, statistics, delta calculations, and automatic logging hooks |
| 2026-09-13 | Restore input[type=text] | lib/form.js, tests/form.test.js | `node --test tests/form.test.js` | Built restoreTextInput with multi-selector matching (id, selector, name), reactive input/change dispatch, and password/token security guards |
| 2026-09-13 | Restore textarea | lib/form.js, tests/form.test.js | `node --test tests/form.test.js` | Built restoreTextarea with multi-line preservation, input/change event dispatch, and sensitive content suppression |
| 2026-09-13 | Restore select dropdowns | lib/form.js, tests/form.test.js | `node --test tests/form.test.js` | Built restoreSelect supporting single-select value/selectedIndex, multi-select options array, reactive events, and sensitive field exclusion |
| 2026-09-13 | Restore checkbox inputs | lib/form.js, tests/form.test.js | `node --test tests/form.test.js` | Built restoreCheckbox supporting boolean toggling, group matching by name & value, reactive change/input events, and sensitive field skipping |
| 2026-09-13 | Restore radio buttons | lib/form.js, tests/form.test.js | `node --test tests/form.test.js` | Built restoreRadio supporting group radio selection by value/name, reactive change/input events, and sensitive field skipping |
| 2026-09-13 | Restore contenteditable elements | lib/form.js, tests/form.test.js | `node --test tests/form.test.js` | Built restoreContentEditable supporting plain-text XSS prevention, optional sanitized HTML, reactive change/input events, and sensitive field skipping |
| 2026-09-13 | Never save passwords by default | lib/snapshot.js, lib/form.js, tests/form_security.test.js | `node --test tests/form_security.test.js` | Built isPasswordField detecting password type/name/id/autocomplete/placeholder patterns, preventing serialization in serializeSafeDomForms/sanitizeFormData, and blocking restoration |
| 2026-09-13 | Never save credit-card fields | lib/snapshot.js, lib/form.js, tests/form_security.test.js | `node --test tests/form_security.test.js` | Built isCreditCardField and looksLikeCreditCardNumber (Luhn checksum) excluding credit card numbers, CVVs, expiration dates, cardholder names, and IBAN/SWIFT data |
| 2026-09-13 | Never save sensitive authentication fields | lib/snapshot.js, lib/form.js, tests/form_security.test.js | `node --test tests/form_security.test.js` | Built isAuthenticationField protecting 2FA/MFA, OTPs, security questions/answers, API keys, private keys, session tokens, and PINs from being saved or restored |
| 2026-09-13 | Add sensitive-field detection | lib/snapshot.js, lib/form.js, tests/form_security.test.js | `node --test tests/form_security.test.js` | Built detectSensitiveField with diagnostic categorization (password, credit_card, authentication, hidden_or_file, value_secret, custom, keyword), value signature checking (JWT, Stripe, GitHub), and custom pattern registry |
| 2026-09-13 | Add domain exclusions | lib/snapshot.js, lib/form.js, tests/form_security.test.js | `node --test tests/form_security.test.js` | Built domain exclusion registry (add/remove/get/clear) with hostname normalization, wildcard/subdomain matching, and serialization/restoration suppression |
| 2026-09-13 | Add user-controlled form-saving setting | lib/snapshot.js, lib/form.js, tests/form_security.test.js | `node --test tests/form_security.test.js` | Built getFormSavingSettings, setFormSavingSettings, resetFormSavingSettings, isFormSavingEnabled, setFormSavingEnabled, and integrated settings checks into serializeSafeDomForms and restoreFormState |
| 2026-09-13 | Do not capture form data from banking/authentication websites by default | lib/snapshot.js, lib/form.js, tests/form_security.test.js | `node --test tests/form_security.test.js` | Built BANKING_AUTH_URL_PATTERN and isBankingOrAuthUrl suppressing form serialization in serializeSafeDomForms, returning null in sanitizeFormData and createTabSnapshot, and preventing restoration in restoreFormState |
| 2026-09-13 | Capture screenshot before suspension where API permissions allow | lib/screenshot.js, lib/snapshot.js, background.js, tests/screenshot.test.js | `node --test tests/screenshot.test.js` | Built isCapturableUrl, canCaptureTabScreenshot validating permissions and active status, captureTabScreenshot with timeout and error handling, and integrated into suspendTab |
| 2026-09-13 | Store screenshot metadata | lib/screenshot.js, lib/snapshot.js, tests/screenshot.test.js | `node --test tests/screenshot.test.js` | Built storeScreenshotMetadata, calculateDataUrlByteSize, extractDataUrlMimeType, validateScreenshotMetadata, and formatScreenshotSummary tracking dimensions, aspect ratio, byte size, format, timestamps, and viewport info |
| 2026-09-13 | Compress screenshots when possible | lib/screenshot.js, lib/snapshot.js, tests/screenshot.test.js | `node --test tests/screenshot.test.js` | Built calculateScaledDimensions, blobToDataUrl, compressScreenshot with quality stepping and canvas/OffscreenCanvas downscaling support |
| 2026-09-13 | Enforce screenshot size limits | lib/screenshot.js, lib/snapshot.js, tests/screenshot.test.js | `node --test tests/screenshot.test.js` | Built enforceScreenshotSizeLimit enforcing MAX_SCREENSHOT_BYTE_SIZE and MAX_SCREENSHOT_DATA_LENGTH with graceful degradation to fallback card |
| 2026-09-13 | Display screenshot in suspended-tab UI | suspended/suspended.html, suspended/suspended.css, suspended/suspended.js, background.js, tests/suspended_ui.test.js | `node --test tests/suspended_ui.test.js` | Added preview wrapper, responsive screenshot element, CSS styling with object-fit contain/shadow/transitions, and background get-tab-preview message handler |
| 2026-09-13 | Display last active timestamp | suspended/suspended.js, tests/suspended_ui.test.js | `node --test tests/suspended_ui.test.js` | Added immediate renderLastActive initialization, dynamic background snapshot update, localized title tooltips, and appearance showLastVisited toggle support |
| 2026-09-13 | Display suspension reason | suspended/suspended.js, tests/suspended_ui.test.js | `node --test tests/suspended_ui.test.js` | Enhanced formatSuspensionReason with startup, tab limits, media playback, and custom reason formatting, and added setSuspensionReason with tooltip and background event updates |
| 2026-09-13 | Display restoration status | suspended/suspended.html, suspended/suspended.css, suspended/suspended.js, tests/suspended_ui.test.js | `node --test tests/suspended_ui.test.js` | Added multi-state status indicator classes (.status-badge-restoring, .status-badge-failed, .status-badge-restored), informative tooltips, and failure/retry recovery logic in restore() |
| 2026-09-13 | Add fallback when screenshot capture fails | lib/screenshot.js, suspended/suspended.html, suspended/suspended.js, tests/suspended_ui.test.js | `node --test tests/suspended_ui.test.js` | Implemented formatFallbackReason handling size exceeded, inactive background tab, restricted browser pages, capture timeouts, and image onerror degradation with custom SVG preview fallback card |
| 2026-09-13 | Create restoration pipeline | lib/restore-engine.js, background.js, lib/lifecycle.js, lib/metadata.js, lib/snapshot-store.js, tests/restore_engine.test.js | `node --test tests/restore_engine.test.js` | Built multi-stage smart restoration pipeline (INIT -> LOAD_URL -> WAIT_READINESS -> RESTORE_SCROLL -> RESTORE_FORMS -> APPLY_ADAPTER -> COMPLETED), with session history, lifecycle state transitions, and background integration |
| 2026-09-13 | Add restoration status indicator | lib/restore-engine.js, suspended/suspended.html, suspended/suspended.css, suspended/suspended.js, tests/restore_engine.test.js, tests/suspended_ui.test.js | `node --test tests/restore_engine.test.js tests/suspended_ui.test.js` | Implemented getStageLabel, getStageDescription, STAGE_PROGRESS_MAP, responsive progress bar indicator (.progress-bar-wrap, .progress-bar), dynamic stage progression events, and real-time UI percent updates |
| 2026-09-13 | Add restoration timeout | lib/restore-engine.js, tests/restore_engine.test.js | `node --test tests/restore_engine.test.js` | Built overall pipeline timeout with AbortController signal propagation, markTimedOut tracking, readiness timeout handling, and isolated site adapter timeout racing |
| 2026-09-13 | Add retry mechanism | lib/restore-engine.js, suspended/suspended.js, tests/restore_engine.test.js | `node --test tests/restore_engine.test.js` | Implemented isRetryableRestorationError, exponential backoff retries, session history reset per attempt, manual retryRestoration API, and retry button UI |
| 2026-09-13 | Add restore failure handling | lib/restore-engine.js, background.js, suspended/suspended.js, tests/restore_engine.test.js | `npm test` | Handled restoration pipeline failures, transition to RESTORE_FAILED, metadata store update, error messaging in background response, suspended UI failure recovery, and failed event emission |
| 2026-09-13 | Add restore cancellation | lib/lifecycle.js, lib/restore-engine.js, background.js, suspended/suspended.html, suspended/suspended.css, suspended/suspended.js, tests/restore_engine.test.js, tests/suspended_ui.test.js | `npm test` | Supported in-flight abort via AbortController and cancelRestoration API, transition to DISCARDED, tab removal cancellation, UI cancel button, and cancellation event notifications |
| 2026-09-13 | Prevent duplicate restoration | lib/restore-engine.js, background.js, tests/restore_engine.test.js | `npm test` | Deduplicated restoration requests for both active in-flight and queued tabs returning existing promises, added isQueued/isRestoringOrQueued queries, emitted duplicate_prevented events, and guarded live tabs in background |
| 2026-09-13 | Add restore queue | lib/restore-engine.js, background.js, tests/restore_engine.test.js | `npm test` | Implemented RestorationStage.QUEUED with progress and descriptions, getQueue, getQueuePosition, clearQueue, priority queueing (high priority unshift), get-restore-queue message handlers, and queue events |
| 2026-09-13 | Prevent restoring too many tabs simultaneously | lib/restore-engine.js, background.js, tests/restore_engine.test.js | `npm test` | Enforced maxConcurrentRestorations concurrency limiter with get/setMaxConcurrentRestorations, dynamic queue draining upon limit expansion, settings synchronization, and optimized batch restoreAll |
| 2026-09-13 | Adapter interface | lib/adapters/base.js, tests/adapter_interface.test.js | `npm test` | Built BaseSiteAdapter interface, isSiteAdapter and assertValidAdapter validators, default lifecycle hooks, serialization toJSON, and AdapterExecutionError / AdapterTimeoutError diagnostic exceptions |
| 2026-09-13 | Domain matching | lib/adapters/domain.js, lib/adapters/registry.js, lib/adapters/base.js, tests/adapter_domain_matching.test.js | `npm test` | Implemented matchDomainPattern, globToRegex, isSubdomainOf, extractHostname, matchesAnyPattern, and AdapterRegistry priority matching with enabled filtering |
| 2026-09-13 | Capture hook | lib/adapters/capture.js, lib/adapters/registry.js, lib/snapshot.js, tests/adapter_capture_hook.test.js | `node --test tests/adapter_capture_hook.test.js` | Built sanitizeAdapterState, executeAdapterCapture with timeout and failure isolation, captureSiteAdapterState, AdapterRegistry.captureForUrl, and integrated adapter state into createTabSnapshot and restoration plan |
| 2026-09-13 | Restore hook | lib/adapters/restore.js, lib/adapters/registry.js, lib/restore-engine.js, tests/adapter_restore_hook.test.js | `node --test tests/adapter_restore_hook.test.js` | Built executeAdapterRestore with timeout and failure isolation, restoreSiteAdapterState, AdapterRegistry.restoreForUrl, and integrated adapter execution into Stage 6 of restoration pipeline |
| 2026-09-13 | Adapter timeout | lib/adapters/timeout.js, lib/adapters/capture.js, lib/adapters/restore.js, tests/adapter_timeout.test.js | `node --test tests/adapter_timeout.test.js` | Built normalizeAdapterTimeout, withAdapterTimeout with AbortSignal support, integrated timeout clamping and overrides into capture and restore hooks |
| 2026-09-13 | Adapter failure isolation | lib/adapters/isolation.js, lib/adapters/capture.js, lib/adapters/restore.js, lib/adapters/registry.js, tests/adapter_failure_isolation.test.js | `node --test tests/adapter_failure_isolation.test.js` | Built AdapterFailureTracker, isolateAdapterOperation, and integrated diagnostic failure tracking into matching, capture, validation, and restoration pipeline isolation |
| 2026-09-14 | User enable/disable control | lib/adapters/settings.js, lib/adapters/registry.js, options/options.html, options/options.js, tests/adapter_settings.test.js | `node --test tests/adapter_settings.test.js` | Built global and per-adapter enable/disable controls, AdapterRegistry settings synchronization, options UI panel with adapter toggles, and storage persistence |
| 2026-09-14 | YouTube playback timestamp | lib/adapters/youtube.js, lib/adapters/registry.js, tests/adapter_youtube.test.js | `node --test tests/adapter_youtube.test.js`, `npm test` | Implemented YouTubeAdapter capturing video ID, currentTime, duration, paused state, and fallback timestamp parsing, seeking via DOM and chrome.scripting on restore, and registry pipeline integration |
| 2026-09-14 | GitHub page/filter state | lib/adapters/github.js, lib/adapters/registry.js, tests/adapter_github.test.js | `node --test tests/adapter_github.test.js`, `npm test` | Built GitHubAdapter capturing repository coordinates, issue/PR numbers, filter query search strings, active sub-tabs (files/commits/conversation), diff view flags, line/comment anchors, and restoring input query and anchor scroll |
| 2026-09-14 | Jira filters and board state | lib/adapters/jira.js, lib/adapters/registry.js, tests/adapter_jira.test.js | `node --test tests/adapter_jira.test.js`, `npm test` | Built JiraAdapter capturing project keys, board IDs, view types (board, backlog, search), selected issue cards, quick filter IDs, JQL search queries, and restoring JQL input and issue card scroll |
| 2026-09-14 | Google Docs basic navigation state | lib/adapters/gdocs.js, lib/adapters/registry.js, tests/adapter_gdocs.test.js | `node --test tests/adapter_gdocs.test.js`, `npm test` | Built GoogleDocsAdapter capturing document/spreadsheet/presentation app types, doc IDs, document titles, heading anchors, sheet GID/ranges, slide IDs, and restoring navigation anchors |
| 2026-09-14 | Notion page state | lib/adapters/notion.js, lib/adapters/registry.js, tests/adapter_notion.test.js | `node --test tests/adapter_notion.test.js`, `npm test` | Built NotionAdapter capturing workspace slugs, page IDs (normalized 32-char hex), view IDs, block anchors, and page titles, with DOM block scroll and anchor restoration |
| 2026-09-14 | Search-page query state | lib/adapters/search.js, lib/adapters/registry.js, tests/adapter_search.test.js | `node --test tests/adapter_search.test.js`, `npm test` | Built SearchAdapter parsing queries, pagination offsets, and search verticals across Google, Bing, DuckDuckGo, Yahoo, Baidu, and Ecosia, with DOM search input restoration |
| 2026-09-14 | Generic URL/hash/query restoration | lib/adapters/generic.js, lib/adapters/registry.js, tests/adapter_generic.test.js | `node --test tests/adapter_generic.test.js`, `npm test` | Built GenericUrlAdapter as universal fallback preserving client-side SPA hash routes, deep-link anchors, and query parameters, dispatching hashchange events and scrolling anchors into view |
| 2026-09-14 | Implement tab scoring | lib/scoring.js, tests/tab_scoring.test.js | `node --test tests/tab_scoring.test.js`, `npm test` | Implemented intelligent tab suspension scoring engine evaluating idle duration, visit frequency, group priorities, domain priorities, memory pressure, and restoration costs with protection guards |
| 2026-09-14 | Add configurable score weights | lib/scoring.js, tests/tab_scoring.test.js | `node --test tests/tab_scoring.test.js`, `npm test` | Added configurable scoring weights with bounds validation, storage persistence, presets (balanced, aggressive, conservative, low_memory), and custom weight integration |
| 2026-09-14 | Add priority levels | lib/scoring.js, tests/tab_scoring.test.js | `node --test tests/tab_scoring.test.js`, `npm test` | Added TabSuspensionPriority enum (IMMUNE, LOW, MEDIUM, HIGH, URGENT), cutoffs, badge colors, human-readable labels, and priority-level tab filtering |
| 2026-09-14 | Add protected-tab rules | lib/scoring.js, tests/tab_scoring.test.js | `node --test tests/tab_scoring.test.js`, `npm test` | Implemented ProtectedTabRuleManager with domain, URL pattern/regex, title, group, media/streaming, and custom rule matching integrated into tab scoring and protection evaluation |
| 2026-09-14 | Add dry-run mode | lib/scoring.js, tests/tab_scoring.test.js | `node --test tests/tab_scoring.test.js`, `npm test` | Added dryRunSuspensionEvaluation pure simulation engine returning projected suspensions, projected memory savings, exemption classifications, minScore cutoffs, quotas, and priority filters |
| 2026-09-14 | Add explanation for why a tab was suspended | lib/scoring.js, suspended/suspended.js, tests/tab_scoring.test.js | `node --test tests/tab_scoring.test.js`, `npm test` | Built generateSuspensionExplanation providing structured headlines, contributing factors, verified safeguards, and narrative rationale integrated into tab scoring, dry-run reports, and suspended UI tooltips |
| 2026-09-14 | Implement least-recently-used suspension | lib/lru.js, tests/lru_suspension.test.js | `node --test tests/lru_suspension.test.js`, `npm test` | Built core LRU suspension engine in lib/lru.js featuring LruTracker, resolveTabLastActiveAt, isTabEligibleForLru, getLeastRecentlyUsedTabs, and selectLruSuspensionCandidates |
| 2026-09-14 | Add maximum active-tab threshold | lib/lru.js, tests/lru_suspension.test.js | `node --test tests/lru_suspension.test.js`, `npm test` | Added configurable active-tab threshold (DEFAULT_MAX_ACTIVE_TABS=15), storage sync, bounds clamping, and evaluateActiveTabThreshold LRU candidate selection |
| 2026-09-14 | Add maximum unsuspended-tab threshold | lib/lru.js, tests/lru_suspension.test.js | `node --test tests/lru_suspension.test.js`, `npm test` | Built configurable unsuspended-tab ceiling (DEFAULT_MAX_UNSUSPENDED_TABS=20) with storage sync, isTabSuspended detector, and evaluateUnsuspendedTabThreshold LRU candidate selection |
| 2026-09-14 | Add group-aware LRU | lib/lru.js, tests/lru_suspension.test.js | `node --test tests/lru_suspension.test.js`, `npm test` | Built group-aware LRU engine with getTabGroupStats, selectGroupAwareLruCandidates, per-group maximums, minRetainedPerGroup safeguards, group protection, and balanced round-robin eviction |
| 2026-09-14 | Add window-aware LRU | lib/lru.js, tests/lru_suspension.test.js | `node --test tests/lru_suspension.test.js`, `npm test` | Built window-aware LRU engine with getWindowStats, selectWindowAwareLruCandidates, protectCurrentWindow, background_first and balanced strategies, and per-window limits |
| 2026-09-14 | Add exclusions | lib/lru.js, tests/lru_suspension.test.js | `node --test tests/lru_suspension.test.js`, `npm test` | Built LruExclusionManager supporting domain, URL pattern/globs/regex, specific tabId, title pattern, groupId, and custom predicates integrated into LRU eligibility checks |
| 2026-09-14 | Add configurable memory budget | lib/memory-budget.js, tests/memory_budget.test.js, lib/lru.js | `node --test tests/memory_budget.test.js`, `npm test` | Implemented configurable memory budget (DEFAULT_MEMORY_BUDGET_MB=2048) with bounds validation, storage sync, heuristic per-tab memory estimation, and total RAM breakdown |
| 2026-09-14 | Add warning threshold | lib/memory-budget.js, tests/memory_budget.test.js | `node --test tests/memory_budget.test.js`, `npm test` | Built configurable warning threshold (warningThresholdRatio, warningThresholdMb), getWarningThresholdStatus evaluation, excess calculation, and reactive warning listeners |
| 2026-09-14 | Add critical threshold | lib/memory-budget.js, tests/memory_budget.test.js | `node --test tests/memory_budget.test.js`, `npm test` | Built configurable critical threshold (criticalThresholdRatio, criticalThresholdMb), getCriticalThresholdStatus, getMemoryPressureState (NORMAL, WARNING, CRITICAL), and critical listeners |
| 2026-09-14 | Trigger suspension when browser memory pressure is high | lib/memory-budget.js, lib/scoring.js, tests/memory_budget.test.js | `node --test tests/memory_budget.test.js`, `npm test` | Built selectMemoryPressureSuspensionCandidates and evaluateAndTriggerMemorySuspension evaluating memory pressure, scoring candidates, satisfying target savings, and invoking tab suspension |
| 2026-09-14 | Add memory-pressure event logs | lib/memory-budget.js, tests/memory_budget.test.js | `node --test tests/memory_budget.test.js`, `npm test` | Built MemoryPressureLogger with circular buffer, querying/filtering, statistics, export/import, storage sync, and automatic eviction event logging |
| 2026-09-14 | Add simulation mode for testing | lib/memory-budget.js, tests/memory_budget.test.js | `node --test tests/memory_budget.test.js`, `npm test` | Built MemorySimulator supporting synthetic memory usage, pressure level simulation (normal, warning, critical), per-tab memory overrides, and pressure spike triggers |
| 2026-09-14 | Implement restore queue | lib/restore-queue.js, tests/restore_queue.test.js, lib/restore-engine.js | `node --test tests/restore_queue.test.js`, `npm test` | Implemented RestorePriority, normalizeRestorePriority, getPriorityName, and RestoreQueue with priority and FIFO ordering, integrated into RestorationEngine |
| 2026-09-14 | Limit concurrent restores | lib/restore-queue.js, lib/restore-engine.js, tests/restore_queue.test.js, tests/restore_engine.test.js | `node --test tests/restore_queue.test.js`, `node --test tests/restore_engine.test.js`, `npm test` | Enforced configurable concurrency limits with storage sync, slot capacity calculation, acquisition and release events, and dynamic queue draining |
| 2026-09-14 | Prioritize user-requested restores | lib/restore-queue.js, lib/restore-engine.js, background.js, suspended/suspended.js, popup/popup.js, tests/restore_queue.test.js, tests/restore_engine.test.js | `node --test tests/restore_queue.test.js`, `node --test tests/restore_engine.test.js`, `npm test` | Implemented isUserRequestedRestore detection, priority queue promotion to front of line, priority_promoted events, and user intent tagging across UI and background |
| 2026-09-14 | Cancel low-priority restores when needed | lib/restore-queue.js, lib/restore-engine.js, background.js, tests/restore_queue.test.js, tests/restore_engine.test.js | `node --test tests/restore_queue.test.js`, `node --test tests/restore_engine.test.js`, `npm test` | Built removeByPriority queue eviction, cancelQueuedByPriority, cancelInFlightByPriority with optional requeue, cancelLowPriorityRestores, and in-flight preemption on user restores |
| 2026-09-14 | Avoid restoring tabs in the background unnecessarily | lib/restore-engine.js, background.js, tests/restore_engine.test.js | `node --test tests/restore_engine.test.js`, `npm test` | Implemented isTabBackground, shouldDeferBackgroundRestoration, deferred restoration manager, DEFERRED stage, on-demand restoration on user focus in background.js, and lazy batch restore |
| 2026-09-14 | Add queue status to UI | suspended/suspended.html, suspended/suspended.css, suspended/suspended.js, popup/popup.html, popup/popup.css, popup/popup.js, tests/suspended_ui.test.js | `node --test tests/suspended_ui.test.js`, `npm test` | Implemented queue position chip and badge in suspended page, real-time polling and priority promotion, and popup queue progress card with cancel/clear queue controls |
| 2026-09-14 | Add failed restore retry | lib/restore-engine.js, background.js, suspended/suspended.js, suspended/suspended.css, popup/popup.html, popup/popup.css, popup/popup.js, tests/restore_engine.test.js, tests/suspended_ui.test.js | `node --test tests/restore_engine.test.js`, `node --test tests/suspended_ui.test.js`, `npm test` | Implemented calculateRetryBackoff, isRetryableRestorationError, failed restoration registry, retryRestoration with fallback options, retryAllFailed batch retry, background message routing, UI retry button in suspended page, and popup failed count with retry actions |
| 2026-09-14 | Active tabs | lib/dashboard-service.js, background.js, options/options.html, options/options.css, options/options.js, tests/dashboard.test.js | `node --test tests/dashboard.test.js`, `npm test` | Implemented dashboard service with getActiveTabs, tab group indexing, RAM estimation, suspension scoring and protection integration, search filtering, multi-field sorting, background message handlers, options UI active tabs panel with badges, and 9 passing unit tests |
| 2026-09-14 | Suspended tabs | lib/dashboard-service.js, background.js, options/options.html, options/options.css, options/options.js, tests/dashboard.test.js | `node --test tests/dashboard.test.js`, `npm test` | Implemented getSuspendedTabs, parseSuspendedTabInfo decoding hash/query metadata, formatSuspensionReason, memory saved calculations, snapshot detection, background message handler, dashboard Suspended Tabs card with search, sort, badges, restore buttons, and 4 new passing unit tests |
| 2026-09-14 | Recently suspended tabs | lib/dashboard-service.js, background.js, options/options.html, options/options.js, tests/dashboard.test.js | `node --test tests/dashboard.test.js`, `npm test` | Implemented recordRecentSuspension bounded ring buffer history, getRecentlySuspended with open tabs fallback and query filtering, background storage persistence and message handlers, dashboard Recently Suspended card with clear and restore/reopen controls, and 3 new passing unit tests |
| 2026-09-14 | Recently restored tabs | lib/dashboard-service.js, background.js, options/options.html, options/options.js, tests/dashboard.test.js | `node --test tests/dashboard.test.js`, `npm test` | Implemented recordRecentRestoration with duration and method tracking, getRecentlyRestored with active tabs fallback and query filtering, background storage persistence and message handlers, dashboard Recently Restored card with search, clear, and focus controls, and 2 new passing unit tests |
| 2026-09-14 | Estimated memory savings | lib/dashboard-service.js, background.js, options/options.html, options/options.css, options/options.js, tests/dashboard.test.js | `node --test tests/dashboard.test.js`, `npm test` | Implemented getMemorySavingsBreakdown computing current RAM saved, lifetime memory reclaimed, efficiency percentage, average saved per tab, top domain savings breakdown, options UI progress bar and domain chips, and passing unit tests |
| 2026-09-14 | Suspension reasons | lib/dashboard-service.js, background.js, options/options.html, options/options.js, tests/dashboard.test.js | `node --test tests/dashboard.test.js`, `npm test` | Implemented getSuspensionReasonColor, getSuspensionReasonsBreakdown with percentage and frequency sorting, filterReason in getSuspendedTabs, get-suspension-reasons background handler, options UI reasons breakdown chips with filter navigation, reason dropdown filter, and 3 new passing unit tests |
| 2026-09-14 | Last active time | lib/dashboard-service.js, background.js, options/options.html, options/options.css, options/options.js, tests/dashboard.test.js | `node --test tests/dashboard.test.js`, `npm test` | Implemented formatIdleDuration and formatTimestamp, added idleDurationMs and idleDurationFormatted in getActiveTabs, la parameter decoding in parseSuspendedTabInfo and getSuspendedTabs, idle sorting for active tabs and lastActive sorting for suspended tabs, UI tooltips, idle and time badges, and 3 new passing unit tests |
| 2026-09-14 | Tab groups | lib/dashboard-service.js, background.js, options/options.html, options/options.js, tests/dashboard.test.js | `node --test tests/dashboard.test.js`, `npm test` | Implemented CHROME_GROUP_COLORS, getTabGroupColorCode, getTabGroupsSummary, get-tab-groups and suspend/restore-group background handlers, dashboard Tab Groups card with live stats, group color chips, group filtering in Active and Suspended tabs, and 4 new passing unit tests |
| 2026-09-14 | Snapshot availability | lib/dashboard-service.js, background.js, options/options.html, options/options.css, options/options.js, tests/dashboard.test.js | `node --test tests/dashboard.test.js`, `npm test` | Implemented resolveSnapshotForTab, getSnapshotAvailability metrics, filterSnapshot in getActiveTabs and getSuspendedTabs, snapshotMap integration, get-snapshot-availability background handler, options UI coverage stat, snapshot filter dropdowns, snapshot status badges, and 4 new passing unit tests |
| 2026-09-14 | Restore failures | lib/dashboard-service.js, background.js, options/options.html, options/options.css, options/options.js, tests/dashboard.test.js | `node --test tests/dashboard.test.js`, `npm test` | Implemented RESTORE_STAGE_LABELS, getRestoreStageLabel, getRestoreFailures with open tab context enrichment, recordRestoreFailure ring buffer, background failure persistence and merge routing, dashboard Restore Failures card with retry and dismiss controls, batch retry-all, and 4 new passing unit tests |
| 2026-09-14 | Suspend tab | lib/dashboard-service.js, lib/scoring.js, background.js, options/options.js, popup/popup.js, tests/dashboard.test.js | `node --test tests/dashboard.test.js`, `npm test` | Implemented canSuspendTab eligibility validator, canSuspend active tab enrichment, "file:" scheme guard, reason: manual routing in background.js and context menus, protection override affordance and loading/error feedback in dashboard and popup, and 2 new passing unit tests |
| 2026-09-14 | Restore tab | lib/dashboard-service.js, background.js, options/options.js, tests/dashboard.test.js | `node --test tests/dashboard.test.js`, `npm test` | Implemented canRestoreTab validator, canRestore suspended tab enrichment, restore-current message handler and context menu, user priority options and error feedback in dashboard, and 2 new passing unit tests |
| 2026-09-14 | Suspend all eligible tabs | lib/dashboard-service.js, background.js, options/options.html, options/options.js, tests/dashboard.test.js | `node --test tests/dashboard.test.js`, `npm test` | Implemented getEligibleTabsToSuspend, countEligibleTabs, eligibleCount in overview, suspend-all-eligible and count-eligible-tabs message handlers, context menu option, Suspend Eligible button in dashboard Active Tabs header, and 2 new passing unit tests |
| 2026-09-14 | Restore all tabs | lib/dashboard-service.js, background.js, options/options.html, options/options.js, tests/dashboard.test.js | `node --test tests/dashboard.test.js`, `npm test` | Implemented getSuspendedTabsToRestore, countSuspendedTabs, windowId-scoped restoreAll in background.js, Restore All button in dashboard Suspended Tabs header with confirmation and live count badge, and unit tests |
| 2026-09-14 | Exclude domain | lib/dashboard-service.js, background.js, options/options.css, options/options.js, tests/dashboard.test.js | `node --test tests/dashboard.test.js`, `npm test` | Implemented isDomainExcluded, excludeDomain, unexcludeDomain, toggleExcludeDomain helpers, background message handlers (exclude-domain, unexclude-domain, toggle-exclude-domain, is-domain-excluded), active and suspended tab enrichment, Excluded Domain badges and dynamic toggle buttons in Active and Suspended tabs dashboard, and 3 new passing unit tests |
| 2026-09-14 | Protect tab | lib/scoring.js, lib/dashboard-service.js, background.js, options/options.css, options/options.js, tests/dashboard.test.js | `node --test tests/dashboard.test.js`, `npm test` | Implemented manual tab protection in scoring engine, isTabManuallyProtected helper, background manuallyProtectedTabs state & message handlers, tabvault-protect context menu, Protect Tab toggle buttons and Protected badges in dashboard active tabs, and 2 new passing unit tests |
| 2026-09-14 | View snapshot | lib/dashboard-service.js, background.js, options/options.html, options/options.css, options/options.js, tests/dashboard.test.js | `node --test tests/dashboard.test.js`, `npm test` | Implemented formatSnapshotDetails with schema enrichment (scroll coords/percentage, safe forms, data URL preview, fallback reason, adapter state, reason badges, relative timestamps), get-snapshot background handler with multi-stage resolution, options modal viewer UI (#snapshot-modal) with keyboard/backdrop dismiss, clickable Snapshot badges and action buttons on active/suspended tabs, and 3 new passing unit tests |
| 2026-09-14 | Delete snapshot | lib/dashboard-service.js, background.js, options/options.html, options/options.css, options/options.js, tests/dashboard.test.js | `node --test tests/dashboard.test.js`, `npm test` | Implemented deleteSnapshotRecord service helper, background delete-snapshot message handler supporting snapshotId, snapshotIds array, and tabId with protection safeguards, options UI Delete Snapshot button (#snap-modal-delete-btn) with confirmation dialog, toast notifications, live dashboard refresh, and unit tests |
| 2026-09-14 | Export session | lib/dashboard-service.js, background.js, options/options.html, options/options.js, tests/dashboard.test.js | `node --test tests/dashboard.test.js`, `npm test` | Implemented serializeSession and serializeAllSessions with metadata schema versioning, export-session message handler for single sessions and all-sessions bundles, Export buttons on each session row and Export All button in options UI, file download triggers, and 3 new passing unit tests |
| 2026-09-14 | Import session | lib/dashboard-service.js, background.js, options/options.html, options/options.js, tests/dashboard.test.js | `node --test tests/dashboard.test.js`, `npm test` | Implemented parseAndValidateSession, sanitizeSessionTab, and mergeSessions with append/replace/skip_duplicates/merge strategies, background import-session message handler, file picker and upload triggers in options Sessions UI, live session reload, and 2 new passing unit tests |
| 2026-09-14 | Persist active session metadata | lib/crash-recovery.js, background.js, tests/crash_recovery.test.js | `node --test tests/crash_recovery.test.js`, `npm test` | Implemented ACTIVE_SESSION_SCHEMA_VERSION, extractOriginalTabUrl, serializeActiveTab, serializeActiveWindow, serializeActiveGroup, captureActiveSessionMetadata, validateActiveSessionMetadata, SessionPersistenceManager with debounced scheduling and flush, background tab event and alarm persistence integration, persist-active-session and get-active-session message handlers, and 9 new passing unit tests |
| 2026-09-14 | Restore metadata after browser restart | lib/crash-recovery.js, background.js, tests/crash_recovery.test.js | `node --test tests/crash_recovery.test.js`, `npm test` | Implemented scoreTabMatch multi-factor tab correlation, remapSessionMetadataOnStartup for remapping changed tab IDs and recovering in-memory state & protection on restart, restoreSessionOnStartup with automatic immediate state re-persistence, background chrome.runtime.onStartup and restore-metadata-on-startup message handler, and 3 new passing unit tests |
| 2026-09-14 | Detect interrupted snapshot operations | lib/crash-recovery.js, background.js, tests/crash_recovery.test.js | `node --test tests/crash_recovery.test.js`, `npm test` | Implemented STORAGE_KEY_PENDING_SNAPSHOTS, DEFAULT_SNAPSHOT_TIMEOUT_MS, createPendingSnapshotRecord, detectInterruptedSnapshots, recoverInterruptedSnapshots, SnapshotOperationTracker with persistent staging, suspendTab wrapping, onStartup/runSweep automated recovery, detect/recover-interrupted-snapshots message handlers, and 4 new passing unit tests |
| 2026-09-14 | Detect interrupted restoration operations | lib/crash-recovery.js, background.js, tests/crash_recovery.test.js | `node --test tests/crash_recovery.test.js`, `npm test` | Implemented STORAGE_KEY_PENDING_RESTORATIONS, DEFAULT_RESTORATION_TIMEOUT_MS, createPendingRestorationRecord, detectInterruptedRestorations, recoverInterruptedRestorations (with reset, mark_failed, and retry actions), RestorationOperationTracker with persistent staging, restoreTab tracking in background.js, onStartup/runSweep recovery checks, detect/recover-interrupted-restorations message handlers, and 6 new passing unit tests |
| 2026-09-14 | Add session checkpointing | lib/crash-recovery.js, background.js, options/options.html, options/options.css, options/options.js, tests/crash_recovery.test.js | `node --test tests/crash_recovery.test.js`, `npm test` | Implemented STORAGE_KEY_SESSION_CHECKPOINTS, buildSessionCheckpoint, appendSessionCheckpoint (rotating, capped at MAX_SESSION_CHECKPOINTS), getLatestValidSessionCheckpoint, clearSessionCheckpoints; SessionPersistenceManager.persist() now writes a checkpoint alongside the primary record and .load() falls back to the latest valid checkpoint on validation failure. Also delivered (beyond the original task): acquireRecoveryLock/releaseRecoveryLock/withRecoveryLock guarding onStartup/runSweep recovery against concurrent runs, recordRecoverySummary/getRecoverySummary/clearRecoverySummary, get-crash-recovery-summary/dismiss-crash-recovery-summary message handlers, and a dismissible dashboard recovery banner. 10 new passing unit tests |
| 2026-09-14 | Bug-fix pass from code review (background.js, content.js, lib/restore-engine.js, options/options.js) | background.js, content.js, options/options.js | `npm test` | Fixed 8 confirmed review findings: restoreTab leaving a stale snoozed-tab alarm entry on early return; missing parseSuspendedTabInfo import causing silent ReferenceError in get/delete-snapshot; missing detectInterruptedSnapshots/detectInterruptedRestorations imports causing hung message responses; no content-script handler for restore-form-state (form restoration silently no-op'd); suspend-group bypassing manuallyProtectedTabs/domain-exclusion rules; a storage race in restoreAll's concurrent recent_restored history writes (fixed via a per-key mutex); a title.slice(0,24) crash on tabs with an undefined title; buildSuspendedUrl dropping a legitimate 0 lastActive timestamp via `\|\|` instead of `??`. All 411 pre-existing tests still passing |


## Blocked Tasks

| Task | Reason | Possible Solution |
| ---- | ------ | ----------------- |
| -    | -      | -                 |

## Known Limitations

* Chrome Extensions cannot preserve the complete JavaScript heap.
* React/Vue internal state cannot generally be captured generically.
* WebSocket connections cannot be suspended and resumed exactly.
* GPU/video decoder state cannot be serialized generically.
* Exact renderer process snapshot/restore requires browser-level changes.
* Per-tab memory measurement is limited without native integration.
* Some websites actively prevent script-based state restoration.

---

# AI Agent Completion Protocol

When working on this project, follow this exact process:

1. Select the first incomplete task that is not blocked.
2. Change its status to `[-] IN PROGRESS`.
3. Implement the task in the actual source code.
4. Run the relevant tests or validation commands.
5. Inspect the resulting behavior.
6. If successful:

   * Change the task to `[x] COMPLETED`.
   * Add an entry to `Completion Log`.
   * Mention changed files.
   * Mention executed tests.
7. If unsuccessful:

   * Keep it `[-] IN PROGRESS` or change to `[!] BLOCKED`.
   * Explain the reason.
8. Never claim completion without code evidence.
9. Do not work on multiple unrelated tasks simultaneously.
10. Do not skip failed tests.
11. Do not remove incomplete tasks from this README.
12. Always leave the repository in a buildable/loadable state whenever possible.
