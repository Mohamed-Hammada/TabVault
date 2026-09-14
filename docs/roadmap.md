# TabVault Feature Roadmap

This document outlines the multi-phase roadmap for evolving TabVault into a comprehensive tab suspension and restoration platform.

---

## Roadmap Overview

```text
Phase 1: Foundation & Architecture ──────────► [DONE]
Phase 2: Persistent Tab Lifecycle ───────────► [NEXT]
Phase 3: Snapshot Engine (IndexedDB) ────────► [PLANNED]
Phase 4: Scroll Position Restoration ───────► [PLANNED]
Phase 5: Safe Form State Restoration ────────► [PLANNED]
Phase 6: Screenshot & Visual Previews ───────► [PLANNED]
Phase 7: Smart Restoration Engine ───────────► [PLANNED]
Phase 8: Site-Specific State Adapters ───────► [PLANNED]
Phase 9: Intelligent Suspension & Scoring ───► [PLANNED]
Phase 10: Restore Queue & Concurrency ───────► [PLANNED]
Phase 11: Dashboard & UI Enhancements ───────► [PLANNED]
Phase 12: Crash Recovery & Persistence ──────► [PLANNED]
Phase 13: Optional Windows Native Agent ─────► [OPTIONAL]
Phase 14: Functional & Performance Testing ──► [CONTINUOUS]
Phase 15: Release & Store Documentation ─────► [FINAL]
```

---

## Phase Details

### Phase 1 — Foundation and Repository Preparation
- Rebrand codebase from TabZen to TabVault.
- Establish baseline architecture documentation.
- Establish developer guides (contributing, setup, testing, API limitations, roadmap, task rules).
- Automated manifest and code syntax verification suite.

### Phase 2 — Persistent Tab Lifecycle & Metadata
- Explicit tab lifecycle states: `ACTIVE`, `IDLE`, `SNAPSHOTTING`, `DISCARDED`, `RESTORING`, `RESTORED`, `RESTORE_FAILED`, `CLOSED`.
- Persistent tab metadata store rehydrating across service worker termination and browser restarts.
- Automatic metadata cleanup for closed tabs and bounded memory usage.

### Phase 3 — Snapshot Storage Subsystem
- IndexedDB storage engine (`tabvault-snapshots`) for rich tab payloads.
- Structured schema with migration versioning and automated storage eviction policies.
- Full snapshot lifecycle: capture, retrieve, delete, export.

### Phase 4 & 5 — State Restoration (Scroll & Safe Forms)
- Capture vertical and horizontal scroll positions with staggered retry intervals (0ms, 500ms, 1500ms, 3000ms).
- Safe capture of form fields (`input[type=text]`, `textarea`, `select`, `checkbox`, `radio`, `contenteditable`).
- Strict security guards: Zero storage of passwords, CVVs, credit cards, or authentication fields.

### Phase 6 & 7 — Visual Previews & Smart Restoration Engine
- Screenshot previews captured during tab deactivation with fallback metadata cards.
- Complete restoration pipeline: URL load -> page readiness -> scroll restore -> form restore -> adapter hook.
- Concurrency limiting, failure timeouts, duplicate suppression, and cancellation handling.

### Phase 8 — Site-Specific Adapters
- Custom domain state restoration adapters:
  - **YouTube**: Video playback timestamp and state.
  - **GitHub**: Filters, issue search, and scroll state.
  - **Generic**: URL query parameters, hash fragments, and search terms.

### Phase 9 & 10 — Intelligent Suspension Engine & Restore Queue
- Composite scoring engine incorporating idle time, visit frequency, group context, pinned/audible state, and system RAM pressure.
- Group- and window-aware LRU suspension algorithms.
- Restore queue throttling concurrent tab reloads to avoid network and CPU saturation.

### Phase 11 & 12 — UI, Dashboard & Session Recovery
- Enhanced popup and options dashboard with active/suspended counters, memory savings, and snapshot management.
- Session checkpointing and crash recovery for interrupted operations.

### Phase 13 — Optional Windows Native Agent
- Native Messaging host monitoring Chromium renderer PID memory usage and system CPU metrics.

### Phase 14 & 15 — Quality Assurance & Release
- Automated functional, performance, and security testing.
- Chrome Web Store release documentation and user guides.
