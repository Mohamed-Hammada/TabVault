# PROJECT_MAP.md — TabVault Architecture & State Sync

## [SYSTEM_FLOW]
```text
[Tab User Activity]
        │
        ▼ (tracks active/idle/audible/forms via content.js & tabs API)
[Tab Lifecycle & Metadata Ledger] ─── (ACTIVE / IDLE / SNAPSHOTTING)
        │
        ▼ (evaluates rules, schedule, battery, memory, scoring engine)
[Suspension Engine]
        │
        ├─► Capture Snapshot (IndexedDB: scroll, safe forms, screenshot, metadata)
        │
        ├─► Native Discard OR Replace Page (suspended/suspended.html)
        │
        ▼ (Tab enters DISCARDED state; memory freed)
[Restoration Request] (user activates tab or popup/command triggers)
        │
        ▼
[Restore Queue] (concurrency-limited, prioritized)
        │
        ▼ (load original URL, wait DOM ready, retry intervals)
[Smart Restoration Engine]
        │
        ├─► Restore scroll position (0ms, 500ms, 1500ms, 3000ms)
        ├─► Restore safe form inputs (text, textarea, select, check, radio)
        ├─► Apply site adapter (YouTube, GitHub, custom)
        │
        ▼
[Tab Restored] (RESTORED state, metadata counters updated)
```

---

## [ACTIVE_MODULES]
- `manifest.json`: Manifest V3 extension configuration.
- `background.js`: Service worker handling alarms, tabs events, rule matching, storage.
- `content.js`: Injected page script for form/scroll observation and route tracking.
- `lib/lifecycle.js`: State machine tracking 8 lifecycle states with history and recovery.
- `lib/metadata.js`: Tab metadata ledger tracking 17 fields, quotas, migrations, and remapping.
- `lib/snapshot.js`: Snapshot extraction, sanitization, schema validation, and recovery.
- `lib/snapshot-store.js`: IndexedDB & memory snapshot backend with retention policies and export/import.
- `lib/scroll.js`: Complete scroll capture & restoration engine supporting SPAs, lazy loading, infinite scroll, presets, and diagnostic failure logging.
- `lib/form.js`: Form state serialization & restoration engine with sensitive field detection, Luhn check, domain exclusions, and user toggles.
- `lib/screenshot.js`: Visual preview capture, compression, size limits, and fallback card generation.
- `lib/restore-queue.js`: Priority restoration queue managing priority levels (USER_REQUESTED, HIGH, NORMAL, LOW, BACKGROUND), FIFO tie-breaking, reordering, and queue queries.
- `lib/restore-engine.js`: Smart 7-stage restoration engine, priority queue manager, concurrency limiter, deferred background restore manager, failed restoration registry, exponential backoff retries, fallback navigation, and cancellation.
- `lib/adapters/`: Site-specific state adapter architecture (`base.js`, `domain.js`, `registry.js`, `capture.js`, `restore.js`, `timeout.js`, `isolation.js`, `settings.js`, `youtube.js`, `github.js`, `jira.js`, `gdocs.js`, `notion.js`, `search.js`, `generic.js`).
- `lib/scoring.js`: Intelligent tab suspension scoring engine evaluating idle duration, visit frequency, group priorities, domain priorities, memory pressure, and restoration costs with protection guards, ProtectedTabRuleManager, configurable score weights, presets, dry-run simulation mode, human-readable suspension explanations, and 5 priority levels (IMMUNE, LOW, MEDIUM, HIGH, URGENT).
- `lib/lru.js`: Least Recently Used (LRU) tab tracking and suspension candidate selection engine (LruTracker, eligibility evaluation, recency ordering, active-tab and unsuspended-tab threshold enforcement, group-aware and window-aware LRU, LruExclusionManager, and candidate selection).
- `lib/memory-budget.js`: Memory budget & pressure engine (configurable budget MB, warning and critical thresholds, heuristic per-tab RAM estimation, total usage aggregation, pressure evaluation, candidate eviction, MemoryPressureLogger event log ring buffer, and MemorySimulator testing mode).
- `lib/dashboard-service.js`: Dashboard aggregation service calculating active and suspended tab statistics, tab group mapping, heuristic RAM consumption, suspension scoring, protection status, snapshot availability resolution & coverage metrics, restoration failure analytics, search querying, and sorting.
- `lib/crash-recovery.js`: Active session persistence, schema validation, crash recovery and debounced storage engine.
- `popup/`: User triage interface for active & idle tabs.
- `options/`: Configuration panel for rules, whitelist, timers.
- `suspended/`: Calm placeholder UI for suspended tabs with preview, fallback, status chip, progress bar, and cancellation/retry controls.

---

## [ORPHANS & PENDING]
- [x] Phase 1.1: Rebrand TabZen -> TabVault across manifest, popup, options, suspended, background.
- [x] Phase 1.2: Architecture documentation (`docs/architecture.md`).
- [x] Phase 1.3: Development documentation (`docs/dev_setup.md`, `docs/contributing.md`, `docs/testing.md`, `docs/limitations.md`, `docs/roadmap.md`, `docs/task_completion_rules.md`).
- [x] Phase 2.1: Formal Tab Lifecycle State Machine (`lib/lifecycle.js`).
- [x] Phase 3.1: Complete Pre-Suspension Snapshot State Capture (`lib/snapshot.js`).
- [x] Phase 3.2 - 3.3: Snapshot Storage & IndexedDB Store (`lib/snapshot-store.js`).
- [x] Phase 4: Scroll Position Restoration engine (`lib/scroll.js`).
- [x] Phase 5: Form State Restoration engine & security sanitizer (`lib/form.js`).
- [x] Phase 6: Screenshot & Visual preview support (`lib/screenshot.js`).
- [x] Phase 7: Smart Restoration Pipeline & Concurrency Queue (`lib/restore-engine.js`).
- [x] Phase 8: Site-Specific State Adapters (`lib/adapters/`).
- [x] Phase 9: Intelligent Scoring & LRU Suspension Engine.
- [x] Phase 10: Restore Queue and Concurrency (`lib/restore-queue.js`, `lib/restore-engine.js`).
- [x] Phase 11: Dashboard and User Interface (`lib/dashboard-service.js`, `options/`, `popup/`).
- [-] Phase 12: Crash Recovery and Session Persistence (5/8 tasks complete per README.md's canonical list: metadata persistence, startup remapping, snapshot interruption recovery, restoration interruption recovery, session checkpointing. Also delivered as additional hardening: a recovery lock preventing concurrent/duplicate recovery runs, a recorded recovery summary, and a dashboard banner. Remaining: recover stale lifecycle states — `LifecycleTracker.reconcileWithLiveTabs()` in `lib/lifecycle.js` exists and is tested but is never wired into `background.js`; crash-safe writes (two-phase staging, checksums); workspace export/import).
- [ ] Phase 13: Optional Windows Native Agent.
- [ ] Phase 14: Settings and Customization.
- [ ] Phase 15: Edge Cases and Hardening.
