import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TabMetadataStore, createTabMetadata, METADATA_SCHEMA_VERSION, migrateTabMetadata } from '../lib/metadata.js';

test('createTabMetadata creates valid record with all required persistent fields', () => {
  const meta = createTabMetadata(10, {
    url: 'https://github.com',
    title: 'GitHub',
    windowId: 1,
    groupId: 5
  });

  assert.equal(meta.tabId, 10);
  assert.equal(meta.url, 'https://github.com');
  assert.equal(meta.title, 'GitHub');
  assert.equal(meta.windowId, 1);
  assert.equal(meta.groupId, 5);
  assert.equal(meta.visitCount, 1);
  assert.equal(meta.suspensionCount, 0);
  assert.equal(meta.restorationCount, 0);
  assert.equal(meta.suspensionReason, null);
  assert.equal(meta.restorationStatus, 'none');
  assert.equal(meta.lifecycleState, 'ACTIVE');
  assert.equal(meta.schemaVersion, METADATA_SCHEMA_VERSION);
  assert.ok(typeof meta.createdAt === 'number');
  assert.ok(typeof meta.lastActiveAt === 'number');
});

test('TabMetadataStore tracks visits, suspensions, and restorations accurately', () => {
  const store = new TabMetadataStore();

  // Record visit
  store.recordVisit(10, { url: 'https://news.ycombinator.com', title: 'Hacker News' });
  let meta = store.get(10);
  assert.equal(meta.visitCount, 1);
  assert.equal(meta.url, 'https://news.ycombinator.com');

  // Second visit
  store.recordVisit(10);
  meta = store.get(10);
  assert.equal(meta.visitCount, 2);

  // Record suspension
  store.recordSuspension(10, 'idle_timeout');
  meta = store.get(10);
  assert.equal(meta.suspensionCount, 1);
  assert.equal(meta.suspensionReason, 'idle_timeout');
  assert.equal(meta.lifecycleState, 'DISCARDED');
  assert.ok(meta.lastSuspendedAt > 0);

  // Record restoration
  store.recordRestoration(10, 'restored');
  meta = store.get(10);
  assert.equal(meta.restorationCount, 1);
  assert.equal(meta.restorationStatus, 'restored');
  assert.equal(meta.lifecycleState, 'RESTORED');
  assert.ok(meta.lastRestoredAt > 0);
});

test('TabMetadataStore persists to storage and rehydrates completely', async () => {
  const rawStorage = {};
  const mockStorage = {
    async get(key) {
      return { [key]: rawStorage[key] };
    },
    async set(items) {
      Object.assign(rawStorage, items);
    }
  };

  const store1 = new TabMetadataStore({ storageAdapter: mockStorage });
  store1.set(101, { url: 'https://alpha.com', title: 'Alpha', visitCount: 5 });
  store1.set(102, { url: 'https://beta.com', title: 'Beta', suspensionCount: 2 });
  await store1.persist();

  assert.ok(rawStorage.tabvault_tab_metadata);
  assert.equal(rawStorage.tabvault_tab_metadata['101'].title, 'Alpha');
  assert.equal(rawStorage.tabvault_tab_metadata['102'].suspensionCount, 2);

  // Fresh store instance rehydrating
  const store2 = new TabMetadataStore({ storageAdapter: mockStorage });
  const ok = await store2.rehydrate();
  assert.equal(ok, true);

  assert.equal(store2.get(101).title, 'Alpha');
  assert.equal(store2.get(101).visitCount, 5);
  assert.equal(store2.get(102).suspensionCount, 2);
});

test('remapTabIds successfully maps old IDs to newly assigned browser tab IDs', () => {
  const store = new TabMetadataStore({ debug: false });

  // Stored before restart
  store.set(101, {
    url: 'https://docs.github.com',
    title: 'GitHub Docs',
    windowId: 1,
    visitCount: 7
  });

  store.set(102, {
    url: 'https://news.ycombinator.com',
    title: 'Hacker News',
    windowId: 1,
    suspensionCount: 4
  });

  // Browser restarts and assigns new IDs: 901 and 902
  const liveTabs = [
    {
      id: 901,
      windowId: 1,
      url: 'https://docs.github.com',
      title: 'GitHub Docs'
    },
    {
      id: 902,
      windowId: 1,
      // Suspended URL format
      url: 'chrome-extension://tabvault/suspended/suspended.html#u=https%3A%2F%2Fnews.ycombinator.com&t=Hacker+News',
      title: 'Hacker News'
    }
  ];

  const res = store.remapTabIds(liveTabs);
  assert.equal(res.remappedCount, 2);

  // Old IDs are gone
  assert.equal(store.get(101), null);
  assert.equal(store.get(102), null);

  // New IDs have all historical metrics intact
  const meta901 = store.get(901);
  assert.ok(meta901);
  assert.equal(meta901.tabId, 901);
  assert.equal(meta901.visitCount, 7);

  const meta902 = store.get(902);
  assert.ok(meta902);
  assert.equal(meta902.tabId, 902);
  assert.equal(meta902.suspensionCount, 4);
});

test('purgeClosedTabs cleans up metadata for permanently closed tabs', () => {
  const store = new TabMetadataStore({ debug: false });
  const now = Date.now();

  store.set(1, { url: 'https://site1.com', lastActiveAt: now });
  store.set(2, { url: 'https://site2.com', lastActiveAt: now });
  store.set(3, { url: 'https://site3.com', lastActiveAt: now - 100000 }); // old closed tab
  store.set(4, { url: 'https://site4.com', lastActiveAt: now - 5000 }); // recently closed tab

  // With 30-second retention: 3 is purged, 4 is marked CLOSED
  const res1 = store.purgeClosedTabs([1, 2], { retentionMs: 30000 });
  assert.equal(res1.purgedCount, 1);
  assert.equal(store.get(3), null);
  assert.equal(store.get(4).lifecycleState, 'CLOSED');
  assert.ok(store.get(1));
  assert.ok(store.get(2));

  // With immediate purge (0ms retention): 4 is also purged
  const res2 = store.purgeClosedTabs([1, 2], { retentionMs: 0 });
  assert.equal(res2.purgedCount, 1);
  assert.equal(store.get(4), null);
  assert.equal(store.records.size, 2);
});

test('enforceQuota and sanitization prevent unlimited storage growth', () => {
  // String length truncation
  const hugeUrl = 'https://example.com/' + 'a'.repeat(3000);
  const hugeTitle = 'Title ' + 'b'.repeat(500);
  const meta = createTabMetadata(99, { url: hugeUrl, title: hugeTitle });
  assert.equal(meta.url.length, 2048);
  assert.equal(meta.title.length, 256);

  // Storage quota limit
  const store = new TabMetadataStore({ maxEntries: 3, debug: false });
  store.set(1, { url: 'https://site1.com', lifecycleState: 'CLOSED', lastActiveAt: 1000 });
  store.set(2, { url: 'https://site2.com', lifecycleState: 'IDLE', lastActiveAt: 2000 });
  store.set(3, { url: 'https://site3.com', lifecycleState: 'ACTIVE', lastActiveAt: 3000 });
  assert.equal(store.records.size, 3);

  // Add 4th entry -> triggers quota enforcement
  store.set(4, { url: 'https://site4.com', lifecycleState: 'ACTIVE', lastActiveAt: 4000 });
  assert.equal(store.records.size, 3);

  // Tab 1 was CLOSED and oldest -> evicted!
  assert.equal(store.get(1), null);
  assert.ok(store.get(2));
  assert.ok(store.get(3));
  assert.ok(store.get(4));
});

test('migrateTabMetadata seamlessly upgrades legacy unversioned metadata to V1', () => {
  const legacyRecord = {
    url: 'https://legacy-site.org/dashboard',
    title: 'Legacy Dashboard',
    visits: 14,
    suspensions: 5,
    state: 'DISCARDED'
    // schemaVersion missing!
  };

  const migrated = migrateTabMetadata(88, legacyRecord);
  assert.equal(migrated.schemaVersion, 1);
  assert.equal(migrated.tabId, 88);
  assert.equal(migrated.url, 'https://legacy-site.org/dashboard');
  assert.equal(migrated.visitCount, 14);
  assert.equal(migrated.suspensionCount, 5);
  assert.equal(migrated.lifecycleState, 'DISCARDED');
  assert.equal(migrated.restorationStatus, 'none');

  // Test store deserializing legacy backup
  const store = new TabMetadataStore({ debug: false });
  store.deserialize({
    '77': { url: 'https://v0.org', visits: 2 }
  });

  const entry = store.get(77);
  assert.ok(entry);
  assert.equal(entry.schemaVersion, 1);
  assert.equal(entry.visitCount, 2);
  assert.equal(entry.lifecycleState, 'ACTIVE');
});




