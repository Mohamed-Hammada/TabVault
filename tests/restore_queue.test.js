import test from "node:test";
import assert from "node:assert/strict";

import {
  RestorePriority,
  normalizeRestorePriority,
  getPriorityName,
  isUserRequestedRestore,
  DEFAULT_MAX_CONCURRENT_RESTORES,
  MIN_CONCURRENT_RESTORES,
  MAX_CONCURRENT_RESTORES,
  STORAGE_KEY_MAX_CONCURRENT_RESTORES,
  normalizeMaxConcurrentRestores,
  loadMaxConcurrentRestores,
  saveMaxConcurrentRestores,
  RestoreQueue
} from "../lib/restore-queue.js";

test("RestorePriority and normalizeRestorePriority handles numeric and string levels", () => {
  assert.equal(RestorePriority.USER_REQUESTED, 100);
  assert.equal(RestorePriority.HIGH, 75);
  assert.equal(RestorePriority.NORMAL, 50);
  assert.equal(RestorePriority.LOW, 25);
  assert.equal(RestorePriority.BACKGROUND, 10);

  assert.equal(normalizeRestorePriority("user_requested"), 100);
  assert.equal(normalizeRestorePriority("user"), 100);
  assert.equal(normalizeRestorePriority("high"), 75);
  assert.equal(normalizeRestorePriority("urgent"), 75);
  assert.equal(normalizeRestorePriority("normal"), 50);
  assert.equal(normalizeRestorePriority("low"), 25);
  assert.equal(normalizeRestorePriority("background"), 10);
  assert.equal(normalizeRestorePriority("batch"), 10);
  assert.equal(normalizeRestorePriority(88), 88);
  assert.equal(normalizeRestorePriority(150), 100); // clamped
  assert.equal(normalizeRestorePriority(-10), 0);   // clamped

  assert.equal(getPriorityName(100), "user_requested");
  assert.equal(getPriorityName(75), "high");
  assert.equal(getPriorityName(50), "normal");
  assert.equal(getPriorityName(25), "low");
  assert.equal(getPriorityName(10), "background");
});

test("RestoreQueue enqueues and maintains priority order with FIFO within same priority", () => {
  const queue = new RestoreQueue();

  // Enqueue normal priority item
  const item1 = queue.enqueue({ tabId: 1, priority: RestorePriority.NORMAL, queuedAt: 1000 });
  assert.equal(item1.position, 1);
  assert.equal(queue.size(), 1);

  // Enqueue another normal priority item later
  const item2 = queue.enqueue({ tabId: 2, priority: RestorePriority.NORMAL, queuedAt: 1050 });
  assert.equal(item2.position, 2);

  // Enqueue high priority item: should jump ahead of normal items!
  const item3 = queue.enqueue({ tabId: 3, priority: RestorePriority.HIGH, queuedAt: 1100 });
  assert.equal(item3.position, 1);

  // Enqueue user-requested item: should jump to the very front!
  const item4 = queue.enqueue({ tabId: 4, priority: RestorePriority.USER_REQUESTED, queuedAt: 1200 });
  assert.equal(item4.position, 1);

  // Enqueue low priority item: should be at the end
  const item5 = queue.enqueue({ tabId: 5, priority: RestorePriority.LOW, queuedAt: 900 });
  assert.equal(item5.position, 5);

  // Positions:
  // 1: tab 4 (USER_REQUESTED, 100)
  // 2: tab 3 (HIGH, 75)
  // 3: tab 1 (NORMAL, 50, queuedAt 1000)
  // 4: tab 2 (NORMAL, 50, queuedAt 1050)
  // 5: tab 5 (LOW, 25)
  assert.equal(queue.getPosition(4), 1);
  assert.equal(queue.getPosition(3), 2);
  assert.equal(queue.getPosition(1), 3);
  assert.equal(queue.getPosition(2), 4);
  assert.equal(queue.getPosition(5), 5);
  assert.equal(queue.getPosition(999), -1);

  // Dequeue in order
  assert.equal(queue.dequeue().tabId, 4);
  assert.equal(queue.dequeue().tabId, 3);
  assert.equal(queue.dequeue().tabId, 1);
  assert.equal(queue.dequeue().tabId, 2);
  assert.equal(queue.dequeue().tabId, 5);
  assert.equal(queue.dequeue(), null);
  assert.equal(queue.size(), 0);
});

test("RestoreQueue inspection: peek, has, get, and getItems", () => {
  const queue = new RestoreQueue();
  queue.enqueue({ tabId: 10, priority: "normal", title: "Tab 10", url: "https://example.com/10" });
  queue.enqueue({ tabId: 20, priority: "high", title: "Tab 20", url: "https://example.com/20" });

  assert.equal(queue.has(10), true);
  assert.equal(queue.has(20), true);
  assert.equal(queue.has(30), false);

  assert.equal(queue.peek().tabId, 20); // High priority is at the front
  assert.equal(queue.get(10).title, "Tab 10");
  assert.equal(queue.get(99), null);

  const items = queue.getItems();
  assert.equal(items.length, 2);
  assert.equal(items[0].tabId, 20);
  assert.equal(items[0].position, 1);
  assert.equal(items[1].tabId, 10);
  assert.equal(items[1].position, 2);
});

test("RestoreQueue remove and clear resolve pending promises with cancelled status", async () => {
  const queue = new RestoreQueue();

  let resolvedItem1 = null;
  const promise1 = new Promise((resolve) => {
    queue.enqueue({
      tabId: 100,
      priority: "normal",
      resolve: (res) => {
        resolvedItem1 = res;
        resolve(res);
      }
    });
  });

  const removed = queue.remove(100, "Removed from queue");
  assert.equal(removed.tabId, 100);
  assert.equal(queue.has(100), false);
  const result1 = await promise1;
  assert.equal(result1.cancelled, true);
  assert.equal(result1.error, "Removed from queue");

  // Clear queue with multiple items
  const promises = [];
  for (let i = 1; i <= 3; i++) {
    promises.push(
      new Promise((resolve) => {
        queue.enqueue({
          tabId: i,
          priority: "normal",
          resolve
        });
      })
    );
  }
  assert.equal(queue.size(), 3);
  const clearedCount = queue.clear("Batch cancelled");
  assert.equal(clearedCount, 3);
  assert.equal(queue.size(), 0);

  const results = await Promise.all(promises);
  assert.equal(results.length, 3);
  assert.ok(results.every(r => r.cancelled && r.error === "Batch cancelled"));
});

test("RestoreQueue reorder updates priority and moves item to correct rank", () => {
  const queue = new RestoreQueue();
  queue.enqueue({ tabId: 1, priority: "normal", queuedAt: 1000 });
  queue.enqueue({ tabId: 2, priority: "normal", queuedAt: 1001 });
  queue.enqueue({ tabId: 3, priority: "normal", queuedAt: 1002 });

  // Currently: tab 1 (pos 1), tab 2 (pos 2), tab 3 (pos 3)
  assert.equal(queue.getPosition(3), 3);

  // Promote tab 3 to user_requested: moves to front!
  const newPos = queue.reorder(3, "user_requested");
  assert.equal(newPos, 1);
  assert.equal(queue.getPosition(3), 1);
  assert.equal(queue.getPosition(1), 2);
  assert.equal(queue.getPosition(2), 3);

  // Demote tab 3 to low: moves to back!
  const demotedPos = queue.reorder(3, "low");
  assert.equal(demotedPos, 3);
  assert.equal(queue.getPosition(1), 1);
  assert.equal(queue.getPosition(2), 2);
  assert.equal(queue.getPosition(3), 3);

  // Non-existent tab
  assert.equal(queue.reorder(999, "high"), -1);
});

test("Concurrency limits normalization, defaults, and bounds clamping", () => {
  assert.equal(DEFAULT_MAX_CONCURRENT_RESTORES, 3);
  assert.equal(MIN_CONCURRENT_RESTORES, 1);
  assert.equal(MAX_CONCURRENT_RESTORES, 10);
  assert.equal(STORAGE_KEY_MAX_CONCURRENT_RESTORES, "tabvault_max_concurrent_restores");

  assert.equal(normalizeMaxConcurrentRestores(3), 3);
  assert.equal(normalizeMaxConcurrentRestores("5"), 5);
  assert.equal(normalizeMaxConcurrentRestores(0), 1, "Clamped to minimum 1");
  assert.equal(normalizeMaxConcurrentRestores(-5), 1, "Clamped to minimum 1");
  assert.equal(normalizeMaxConcurrentRestores(50), 10, "Clamped to maximum 10");
  assert.equal(normalizeMaxConcurrentRestores("invalid"), 3, "Defaults to 3");
  assert.equal(normalizeMaxConcurrentRestores(NaN, 4), 4, "Uses custom default");
  assert.equal(normalizeMaxConcurrentRestores(null), 3, "Defaults to 3");
  assert.equal(normalizeMaxConcurrentRestores(undefined), 3, "Defaults to 3");
});

test("loadMaxConcurrentRestores and saveMaxConcurrentRestores persist limit to storage", async () => {
  const store = {};
  const mockStorage = {
    local: {
      get: async (key) => ({ [key]: store[key] }),
      set: async (obj) => Object.assign(store, obj)
    }
  };

  // Initially unset
  const initial = await loadMaxConcurrentRestores(mockStorage);
  assert.equal(initial, 3);

  // Save new limit
  const saved = await saveMaxConcurrentRestores(5, mockStorage);
  assert.equal(saved, 5);
  assert.equal(store[STORAGE_KEY_MAX_CONCURRENT_RESTORES], 5);

  // Load saved limit
  const loaded = await loadMaxConcurrentRestores(mockStorage);
  assert.equal(loaded, 5);

  // Clamped bounds on save
  const clampedSaved = await saveMaxConcurrentRestores(99, mockStorage);
  assert.equal(clampedSaved, 10);
  assert.equal(store[STORAGE_KEY_MAX_CONCURRENT_RESTORES], 10);

  // Fallback when storage API missing
  assert.equal(await loadMaxConcurrentRestores(null), 3);
  assert.equal(await saveMaxConcurrentRestores(4, null), 4);
});

test("RestoreQueue concurrency capacity, available slots, and batch helpers", () => {
  const queue = new RestoreQueue({ maxConcurrent: 4 });
  assert.equal(queue.maxConcurrent, 4);

  // Check slots with 0 active
  assert.equal(queue.getAvailableSlots(0), 4);
  assert.equal(queue.isAtCapacity(0), false);

  // Check slots with 2 active
  assert.equal(queue.getAvailableSlots(2), 2);
  assert.equal(queue.isAtCapacity(2), false);

  // Check slots at capacity (4 active)
  assert.equal(queue.getAvailableSlots(4), 0);
  assert.equal(queue.isAtCapacity(4), true);

  // Check slots over capacity (5 active)
  assert.equal(queue.getAvailableSlots(5), 0);
  assert.equal(queue.isAtCapacity(5), true);

  // Enqueue 5 items
  for (let i = 1; i <= 5; i++) {
    queue.enqueue({ tabId: i, priority: "normal", queuedAt: 1000 + i });
  }
  assert.equal(queue.size(), 5);

  // getConcurrencyStats
  const stats = queue.getConcurrencyStats(2);
  assert.deepEqual(stats, {
    active: 2,
    queued: 5,
    maxConcurrent: 4,
    availableSlots: 2,
    isAtCapacity: false
  });

  // Dynamically update maxConcurrent
  queue.maxConcurrent = 2;
  assert.equal(queue.maxConcurrent, 2);
  assert.equal(queue.getAvailableSlots(2), 0);
  assert.equal(queue.isAtCapacity(2), true);

  // peekBatch
  const peeked = queue.peekBatch(2);
  assert.equal(peeked.length, 2);
  assert.equal(peeked[0].tabId, 1);
  assert.equal(peeked[1].tabId, 2);
  assert.equal(queue.size(), 5, "peekBatch should not remove items");

  // dequeueBatch
  const dequeued = queue.dequeueBatch(2);
  assert.equal(dequeued.length, 2);
  assert.equal(dequeued[0].tabId, 1);
  assert.equal(dequeued[1].tabId, 2);
  assert.equal(queue.size(), 3, "dequeueBatch removes items");
});

test("isUserRequestedRestore identifies explicit user actions across diverse option formats", () => {
  assert.equal(isUserRequestedRestore({ source: "user" }), true);
  assert.equal(isUserRequestedRestore({ userInitiated: true }), true);
  assert.equal(isUserRequestedRestore({ priority: 100 }), true);
  assert.equal(isUserRequestedRestore({ priority: "user" }), true);
  assert.equal(isUserRequestedRestore({ priority: "user_requested" }), true);
  assert.equal(isUserRequestedRestore({ priority: "USER_REQUESTED" }), true);

  assert.equal(isUserRequestedRestore({ source: "background" }), false);
  assert.equal(isUserRequestedRestore({ source: "batch" }), false);
  assert.equal(isUserRequestedRestore({ priority: 50 }), false);
  assert.equal(isUserRequestedRestore({ priority: "normal" }), false);
  assert.equal(isUserRequestedRestore({ priority: "low" }), false);
  assert.equal(isUserRequestedRestore({}), false);
  assert.equal(isUserRequestedRestore(null), false);
  assert.equal(isUserRequestedRestore(undefined), false);
});

test("RestoreQueue.promote promotes item priority and moves to front of line", () => {
  const queue = new RestoreQueue();

  // Enqueue 3 background tasks
  queue.enqueue({ tabId: 101, priority: RestorePriority.BACKGROUND, queuedAt: 1000 });
  queue.enqueue({ tabId: 102, priority: RestorePriority.BACKGROUND, queuedAt: 1001 });
  queue.enqueue({ tabId: 103, priority: RestorePriority.BACKGROUND, queuedAt: 1002 });

  assert.equal(queue.getPosition(101), 1);
  assert.equal(queue.getPosition(102), 2);
  assert.equal(queue.getPosition(103), 3);

  // User requests tab 103: promote from BACKGROUND (10) to USER_REQUESTED (100)
  const newPos = queue.promote(103, RestorePriority.USER_REQUESTED);
  assert.equal(newPos, 1);
  assert.equal(queue.getPosition(103), 1, "Promoted tab 103 should jump to position 1");
  assert.equal(queue.getPosition(101), 2);
  assert.equal(queue.getPosition(102), 3);
  assert.equal(queue.get(103).priority, 100);

  // Promoting tab with lower priority does not demote it
  const unchangedPos = queue.promote(103, RestorePriority.LOW);
  assert.equal(unchangedPos, 1);
  assert.equal(queue.get(103).priority, 100);

  // Non-existent tab
  assert.equal(queue.promote(999, 100), -1);
});

test("RestoreQueue.removeByPriority evicts only matching low-priority tasks and cancels them", async () => {
  const queue = new RestoreQueue();

  let resolvedCancelledItems = [];
  const makeItem = (tabId, priority) => ({
    tabId,
    priority,
    resolve: (res) => resolvedCancelledItems.push(res)
  });

  queue.enqueue(makeItem(1, RestorePriority.HIGH));       // 75
  queue.enqueue(makeItem(2, RestorePriority.NORMAL));     // 50
  queue.enqueue(makeItem(3, RestorePriority.LOW));        // 25
  queue.enqueue(makeItem(4, RestorePriority.BACKGROUND)); // 10

  assert.equal(queue.size(), 4);
  assert.equal(queue.findLowestPriorityItem().tabId, 4);

  // Evict items with priority <= RestorePriority.LOW (25)
  const evicted = queue.removeByPriority(RestorePriority.LOW, "Evicted due to memory pressure");
  assert.equal(evicted.length, 2);
  assert.equal(evicted[0].tabId, 3);
  assert.equal(evicted[1].tabId, 4);

  // Remaining queue should only have HIGH (1) and NORMAL (2)
  assert.equal(queue.size(), 2);
  assert.equal(queue.has(1), true);
  assert.equal(queue.has(2), true);
  assert.equal(queue.has(3), false);
  assert.equal(queue.has(4), false);
  assert.equal(queue.findLowestPriorityItem().tabId, 2);

  // Verify cancelled promises
  assert.equal(resolvedCancelledItems.length, 2);
  assert.ok(resolvedCancelledItems.every(r => r.cancelled && r.error === "Evicted due to memory pressure"));
});
