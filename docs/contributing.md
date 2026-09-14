# TabVault Contribution Guidelines

Thank you for contributing to TabVault! TabVault is an open-source, privacy-first, intelligent tab suspension and restoration system designed to dramatically reduce memory footprint while preserving essential user state.

---

## 1. Core Principles & Philosophy

1. **Strict Local-First & Zero Telemetry**:
   - TabVault runs 100% locally.
   - Absolutely no analytics, telemetry, remote pings, or cloud synchronizations are permitted.
   - All state, snapshots, and metrics remain on the user's machine within `chrome.storage.local` or IndexedDB.

2. **Security & Privacy by Design**:
   - Never capture passwords, CVVs, payment information, or session authorization tokens.
   - Sensitive input types (`password`, credit-card autocomplete fields, auth headers) must be filtered out at the content-script capture boundary.

3. **Simplicity and Reliability**:
   - Favor clear, maintainable implementations over speculative complexity.
   - Every feature must have automated test coverage and robust error isolation.

---

## 2. Development Workflow

1. **Fork and Clone**:
   ```bash
   git clone https://github.com/Mohamed-Hammada/TabVault.git
   cd TabVault
   ```
2. **Branching**:
   - Create feature or bugfix branches from `main`:
     ```bash
     git checkout -b feature/your-feature-name
     ```
3. **Commit Conventions**:
   - Write clear, imperative commit messages:
     - `feat: implement tab lifecycle state machine`
     - `fix: resolve scroll restoration race condition on lazy-load`
     - `test: add test coverage for restore concurrency queue`
     - `docs: update architecture overview`

---

## 3. Coding Standards

- **JavaScript**: Modern ES2022+ syntax, native async/await, clean error boundaries (`try/catch` with structured fallbacks).
- **No Placeholders**: Never submit code containing `// TODO` or empty placeholder stubs. All PRs must be complete, tested, and integrated.
- **Logging**: Use descriptive debug logging prefixed with `[TabVault]` for background operations and lifecycle state transitions.
- **Chrome MV3 Compatibility**: Keep the background service worker stateless-resilient. Never assume in-memory variables survive service worker sleep; persist essential lifecycle ledgers to storage.

---

## 4. Testing Requirements

- Every functional change must include automated tests in the `tests/` directory.
- Run all tests before submitting:
  ```bash
  npm test
  ```
- All tests must pass cleanly without timeouts or flaky behavior.

---

## 5. Pull Request Checklist

Before submitting a Pull Request:
- [ ] Code follows project standards and is free of dead code or placeholders.
- [ ] Automated tests have been executed and pass.
- [ ] Relevant documentation and `README.md` / `PROJECT_MAP.md` are updated.
- [ ] Extension loads cleanly in Chrome without manifest or console warnings.
