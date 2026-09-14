# TabVault Task Completion & Verification Rules

This document specifies the strict protocol governing task lifecycle management, status reporting, and verification requirements for all contributors and autonomous agents working on TabVault.

---

## 1. Golden Rule of Task Integrity

> **The `README.md` and `PROJECT_MAP.md` are the authoritative sources of truth for project progress.**
> A task may ONLY be marked as `[x] COMPLETED` after the implementation has been written in production code, integrated into the repository, and verified by passing automated tests.

Never mark a task as completed based on:
- Planning or discussion.
- Creating empty or stub placeholder files.
- Writing comments or `// TODO` notices.
- Theoretical or unverified implementations.

---

## 2. Allowed Task Statuses

| Indicator | Status | Definition |
| :---: | :--- | :--- |
| `[ ]` | **TODO** | Task has not been started. |
| `[-]` | **IN PROGRESS** | Code is currently being written or tests are running. Exactly one task at a time. |
| `[x]` | **COMPLETED** | Fully implemented, integrated, covered by tests, and verified without regressions. |
| `[!]` | **BLOCKED** | Cannot proceed due to documented technical or platform constraints. |
| `[~]` | **PARTIALLY COMPLETED** | Discrete sub-component completed; remainder actively in progress. |

---

## 3. Step-by-Step Execution Protocol

When picking up work:
1. **Identify**: Select the first unblocked `[ ] TODO` task in sequence.
2. **Transition**: Update status in `README.md` to `[-] IN PROGRESS`.
3. **Implement**: Write the clean, complete, production-ready code. No placeholders or stub shortcuts.
4. **Test**: Execute or create corresponding automated tests in `tests/` (`npm test`).
5. **Verify**: Ensure all tests pass with zero warnings, errors, or side-effects.
6. **Log & Sync**:
   - Change task status in `README.md` to `[x] COMPLETED`.
   - Add an entry to the `Completion Log` table in `README.md` specifying: Date, Task Name, Files Changed, Tests Executed, and Implementation Notes.
   - Synchronize `PROJECT_MAP.md` updating `[ORPHANS & PENDING]` and `[ACTIVE_MODULES]`.

---

## 4. Handling Blockers & Chrome API Limitations

If an item cannot be implemented due to Chromium sandboxing or WebExtension API constraints:
1. Do not fake completion.
2. Mark the task as `[!] BLOCKED`.
3. Document the limitation in `README.md` (under Blocked Tasks) and in `docs/limitations.md`.
4. Outline possible alternative solutions (e.g. Native Messaging, offscreen documents, heuristic estimation).
