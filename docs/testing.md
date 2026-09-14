# TabVault Testing Guide

This guide describes how to run, write, and maintain automated and manual tests for TabVault.

---

## 1. Test Runner & Philosophy

TabVault utilizes the built-in Node.js test runner (`node:test` and `node:assert/strict`).
- **Zero Third-Party Dependencies**: No massive external node_modules bloat.
- **Fast & Deterministic**: Full test suite runs in under 1 second.
- **Continuous Verification**: Every code change is verified with tests before completion.

---

## 2. Running Automated Tests

Run the complete test suite:
```bash
npm test
```

Run a specific test file:
```bash
node --test tests/rebrand.test.js
node --test tests/manifest_and_load.test.js
node --test tests/docs.test.js
```

Run with watch mode during active development:
```bash
node --test --watch tests/*.test.js
```

---

## 3. Test Suite Organization

| Test File | Focus Area |
| --- | --- |
| `tests/rebrand.test.js` | TabVault naming across manifest, configs, HTML files, and zero upstream leftovers. |
| `tests/manifest_and_load.test.js` | Manifest V3 schema verification, file paths resolution, and JS syntax compilation. |
| `tests/docs.test.js` | Verification of development, architecture, and limitation documentation. |
| `tests/lifecycle.test.js` | Tab state machine transitions (`ACTIVE` -> `IDLE` -> `SNAPSHOTTING` -> `DISCARDED`, etc.). |
| `tests/metadata.test.js` | Persistent tab metadata store, quotas, pruning of closed tabs, and restart re-mapping. |
| `tests/snapshot.test.js` | Snapshot schema, serialization, IndexedDB storage engine, and size boundaries. |
| `tests/restore.test.js` | Smart restoration pipeline, retry intervals, and restore queue concurrency limits. |

---

## 4. Writing Unit & Mock Tests

When testing browser extension components that interact with `chrome.*` APIs:
1. Use isolated in-memory mocks for `chrome.storage.local`, `chrome.tabs`, and `chrome.alarms`.
2. Ensure async state is cleanly reset between test cases using `beforeEach` / `afterEach` hooks.
3. Test edge cases: corrupted storage, missing URLs, closed tabs, simultaneous restore triggers.

---

## 5. Manual Browser Verification Protocol

In addition to automated tests:
1. Load unpacked extension in Chrome (`chrome://extensions`).
2. Open 5 test tabs with varying contents (static articles, dynamic forms, YouTube videos).
3. Test automatic idle suspension after setting a low timer (e.g., 1 minute).
4. Verify tab replacement page renders title, favicon, and last-active time.
5. Click anywhere to restore and verify scroll position and form text are preserved.
6. Verify no console errors in background service worker or content scripts.
