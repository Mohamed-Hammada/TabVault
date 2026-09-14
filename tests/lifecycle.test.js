import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TabState, ALLOWED_TRANSITIONS, isValidTransition, assertValidTransition, LifecycleTracker } from '../lib/lifecycle.js';

test('TabState defines all 8 required lifecycle states', () => {
  const expectedStates = [
    'ACTIVE',
    'IDLE',
    'SNAPSHOTTING',
    'DISCARDED',
    'RESTORING',
    'RESTORED',
    'RESTORE_FAILED',
    'CLOSED'
  ];

  for (const state of expectedStates) {
    assert.equal(TabState[state], state);
  }

  assert.equal(Object.keys(TabState).length, 8);
  assert.ok(Object.isFrozen(TabState));
});

test('Valid transitions follow expected lifecycle pipeline', () => {
  assert.ok(isValidTransition(TabState.ACTIVE, TabState.IDLE));
  assert.ok(isValidTransition(TabState.ACTIVE, TabState.SNAPSHOTTING));
  assert.ok(isValidTransition(TabState.ACTIVE, TabState.CLOSED));

  assert.ok(isValidTransition(TabState.IDLE, TabState.ACTIVE));
  assert.ok(isValidTransition(TabState.IDLE, TabState.SNAPSHOTTING));

  assert.ok(isValidTransition(TabState.SNAPSHOTTING, TabState.DISCARDED));

  assert.ok(isValidTransition(TabState.DISCARDED, TabState.RESTORING));

  assert.ok(isValidTransition(TabState.RESTORING, TabState.RESTORED));
  assert.ok(isValidTransition(TabState.RESTORING, TabState.RESTORE_FAILED));

  assert.ok(isValidTransition(TabState.RESTORED, TabState.ACTIVE));
  assert.ok(isValidTransition(TabState.RESTORED, TabState.IDLE));

  assert.ok(isValidTransition(TabState.ACTIVE, TabState.ACTIVE));
});

test('Invalid transitions are blocked and assert throws', () => {
  assert.equal(isValidTransition(TabState.DISCARDED, TabState.RESTORED), false);
  assert.throws(() => {
    assertValidTransition(TabState.DISCARDED, TabState.RESTORED);
  }, /Invalid state transition/);

  assert.equal(isValidTransition(TabState.CLOSED, TabState.ACTIVE), false);
  assert.throws(() => {
    assertValidTransition(TabState.CLOSED, TabState.ACTIVE);
  }, /Invalid state transition/);

  assert.equal(isValidTransition('UNKNOWN', TabState.ACTIVE), false);
  assert.equal(isValidTransition(TabState.ACTIVE, 'UNKNOWN'), false);
});

test('LifecycleTracker tracks transitions and maintains history', () => {
  const events = [];
  const tracker = new LifecycleTracker({
    maxHistory: 5,
    onTransition: (ev) => events.push(ev)
  });

  const tabId = 101;
  assert.equal(tracker.getState(tabId), TabState.ACTIVE);

  // Transition: ACTIVE -> IDLE
  const res1 = tracker.transition(tabId, TabState.IDLE, 'idle_timeout');
  assert.equal(res1.success, true);
  assert.equal(res1.fromState, TabState.ACTIVE);
  assert.equal(res1.toState, TabState.IDLE);
  assert.equal(tracker.getState(tabId), TabState.IDLE);

  // Idempotent transition
  const resNoop = tracker.transition(tabId, TabState.IDLE, 'duplicate');
  assert.equal(resNoop.noop, true);

  // Transition: IDLE -> SNAPSHOTTING -> DISCARDED
  tracker.transition(tabId, TabState.SNAPSHOTTING, 'prepare_suspend');
  tracker.transition(tabId, TabState.DISCARDED, 'page_replaced');
  assert.equal(tracker.getState(tabId), TabState.DISCARDED);

  // Transition: DISCARDED -> RESTORING -> RESTORED -> ACTIVE
  tracker.transition(tabId, TabState.RESTORING, 'user_click');
  tracker.transition(tabId, TabState.RESTORED, 'dom_ready');
  tracker.transition(tabId, TabState.ACTIVE, 'focus');
  assert.equal(tracker.getState(tabId), TabState.ACTIVE);

  const history = tracker.getHistory(tabId);
  assert.ok(history.length <= 5, 'History capped at maxHistory');
  assert.equal(history[history.length - 1].to, TabState.ACTIVE);

  assert.ok(events.length >= 6);

  // Remove tab
  tracker.remove(tabId, 'user_closed');
  assert.equal(tracker.getEntry(tabId), null);
});

test('LifecycleTracker serializes, persists, and rehydrates accurately', async () => {
  const store = {};
  const mockStorage = {
    async get(key) {
      return { [key]: store[key] };
    },
    async set(items) {
      Object.assign(store, items);
    }
  };

  const tracker1 = new LifecycleTracker({ debug: false });
  tracker1.setStorageAdapter(mockStorage);

  tracker1.transition(201, TabState.IDLE, 'idle_timer');
  tracker1.transition(202, TabState.SNAPSHOTTING, 'manual_suspend');
  tracker1.transition(202, TabState.DISCARDED, 'discarded');

  await tracker1.persist();
  assert.ok(store.tabvault_lifecycle);
  assert.equal(store.tabvault_lifecycle['201'].state, TabState.IDLE);
  assert.equal(store.tabvault_lifecycle['202'].state, TabState.DISCARDED);

  // Fresh tracker rehydrating from storage
  const tracker2 = new LifecycleTracker({ debug: false });
  tracker2.setStorageAdapter(mockStorage);
  const rehydrated = await tracker2.rehydrate();
  assert.equal(rehydrated, true);

  assert.equal(tracker2.getState(201), TabState.IDLE);
  assert.equal(tracker2.getState(202), TabState.DISCARDED);
  assert.equal(tracker2.getHistory(202).length, 2);
});

test('canTransition and safeTransition prevent invalid state transitions gracefully', () => {
  const tracker = new LifecycleTracker({ debug: false });
  const tabId = 301; // initial state ACTIVE

  // Illegal: ACTIVE -> RESTORING
  assert.equal(tracker.canTransition(tabId, TabState.RESTORING), false);
  const failRes = tracker.safeTransition(tabId, TabState.RESTORING, 'illegal_attempt');
  assert.equal(failRes.success, false);
  assert.match(failRes.error, /invalid transition for tab #301 from ACTIVE to RESTORING/i);
  assert.equal(tracker.getState(tabId), TabState.ACTIVE); // State remained intact!

  // Illegal: ACTIVE -> DISCARDED (must go through SNAPSHOTTING)
  assert.equal(tracker.canTransition(tabId, TabState.DISCARDED), false);
  const failDiscard = tracker.safeTransition(tabId, TabState.DISCARDED, 'skip_snapshot');
  assert.equal(failDiscard.success, false);
  assert.equal(tracker.getState(tabId), TabState.ACTIVE);

  // Legal: ACTIVE -> SNAPSHOTTING -> DISCARDED
  assert.equal(tracker.canTransition(tabId, TabState.SNAPSHOTTING), true);
  const ok1 = tracker.safeTransition(tabId, TabState.SNAPSHOTTING, 'snapshotting');
  assert.equal(ok1.success, true);
  assert.equal(tracker.getState(tabId), TabState.SNAPSHOTTING);

  assert.equal(tracker.canTransition(tabId, TabState.DISCARDED), true);
  const ok2 = tracker.safeTransition(tabId, TabState.DISCARDED, 'discarded');
  assert.equal(ok2.success, true);
  assert.equal(tracker.getState(tabId), TabState.DISCARDED);

  // Illegal: DISCARDED -> RESTORED (must go through RESTORING)
  assert.equal(tracker.canTransition(tabId, TabState.RESTORED), false);
  const failRestored = tracker.safeTransition(tabId, TabState.RESTORED, 'instant_restore');
  assert.equal(failRestored.success, false);
  assert.equal(tracker.getState(tabId), TabState.DISCARDED);
});

test('LifecycleTracker outputs formatted debug logs for transitions and warnings', () => {
  const logs = [];
  const tracker = new LifecycleTracker({
    logger: (msg) => logs.push(msg),
    debug: true
  });

  tracker.transition(401, TabState.IDLE, 'idle_timer');
  assert.ok(logs.some(l => l.includes('[TabVault Lifecycle]') && l.includes('ACTIVE -> IDLE') && l.includes('idle_timer')));

  // Blocked transition produces warning log
  tracker.safeTransition(401, TabState.RESTORED, 'invalid_jump');
  assert.ok(logs.some(l => l.includes('WARN: Blocked invalid transition')));

  // Test setDebug(false) suppresses logs
  logs.length = 0;
  tracker.setDebug(false);
  tracker.transition(401, TabState.SNAPSHOTTING, 'testing_quiet');
  assert.equal(logs.length, 0);
});

test('reconcileWithLiveTabs recovers stale states and purges closed tabs on restart', () => {
  const tracker = new LifecycleTracker({ debug: false });

  // Pre-seed with hypothetical pre-restart tabs
  tracker.tabs.set(501, {
    tabId: 501,
    state: TabState.SNAPSHOTTING, // interrupted snapshot
    lastTransitionAt: Date.now() - 10000,
    history: []
  });
  tracker.tabs.set(502, {
    tabId: 502,
    state: TabState.RESTORING, // interrupted restoration
    lastTransitionAt: Date.now() - 10000,
    history: []
  });
  tracker.tabs.set(503, {
    tabId: 503,
    state: TabState.IDLE, // closed while browser was restarting
    lastTransitionAt: Date.now() - 10000,
    history: []
  });

  // Query results from browser on wake
  const liveTabs = [
    { id: 501, url: 'https://example.com/article', active: false, discarded: false },
    { id: 502, url: 'chrome-extension://tabvault/suspended/suspended.html#u=https://example.org', active: false, discarded: true },
    { id: 504, url: 'https://example.net', active: true, discarded: false } // newly opened
  ];

  const summary = tracker.reconcileWithLiveTabs(liveTabs);

  assert.equal(summary.totalLive, 3);
  assert.equal(summary.purgedClosed, 1); // 503 was purged
  assert.equal(summary.recoveredStale, 2); // 501 and 502 were recovered

  // Tab 501 was in SNAPSHOTTING, now recovered to IDLE
  assert.equal(tracker.getState(501), TabState.IDLE);

  // Tab 502 was in RESTORING, now recovered to DISCARDED
  assert.equal(tracker.getState(502), TabState.DISCARDED);

  // Tab 503 was closed and removed from ledger
  assert.equal(tracker.getEntry(503), null);

  // Tab 504 was discovered as new ACTIVE tab
  assert.equal(tracker.getState(504), TabState.ACTIVE);
});




