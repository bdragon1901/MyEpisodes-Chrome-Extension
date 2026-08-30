// lib/cache.js talks to chrome.storage.local, so stand one up before importing
// it. The module is imported once and reset between tests via the shim.

import test from 'node:test';
import assert from 'node:assert/strict';

let store = {};

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        if (keys === null) return { ...store };
        const out = {};
        for (const key of [].concat(keys)) if (key in store) out[key] = store[key];
        return out;
      },
      async set(entries) {
        Object.assign(store, entries);
      },
      async remove(keys) {
        for (const key of [].concat(keys)) delete store[key];
      }
    }
  }
};

const { readCache, writeCache, clearCache } = await import('../lib/cache.js');

test.beforeEach(() => {
  store = {};
});

test('a written feed reads back', async () => {
  await writeCache('today', [{ show: 'A' }]);
  assert.deepEqual((await readCache('today')).items, [{ show: 'A' }]);
});

test('a feed that was never written is a miss', async () => {
  assert.equal(await readCache('tomorrow'), null);
});

test('feeds do not collide with each other', async () => {
  await writeCache('today', [{ show: 'A' }]);
  await writeCache('all', [{ show: 'B' }]);
  assert.deepEqual((await readCache('today')).items, [{ show: 'A' }]);
  assert.deepEqual((await readCache('all')).items, [{ show: 'B' }]);
});

test('an entry from another day is a miss', async () => {
  await writeCache('today', [{ show: 'A' }]);
  store['cache:today'].day = 'Mon Jan 01 2001';
  assert.equal(await readCache('today'), null);
});

test('an entry records when it was fetched', async () => {
  const before = Date.now();
  await writeCache('today', []);
  const { fetchedAt } = await readCache('today');
  assert.ok(fetchedAt >= before && fetchedAt <= Date.now());
});

test('clearCache takes every cached feed', async () => {
  await writeCache('today', [{ show: 'A' }]);
  await writeCache('yesterday', [{ show: 'C' }]);
  await clearCache();
  assert.equal(await readCache('today'), null);
  assert.equal(await readCache('yesterday'), null);
});

test('clearCache leaves everything that is not a cache entry alone', async () => {
  await writeCache('today', [{ show: 'A' }]);
  store.uid = 'someone';
  store.pwdmd5 = 'token';
  store['unrelated:thing'] = 1;

  await clearCache();

  assert.deepEqual(Object.keys(store).sort(), ['pwdmd5', 'uid', 'unrelated:thing']);
});

test('clearCache on an empty store is a no-op', async () => {
  await clearCache();
  assert.deepEqual(Object.keys(store), []);
});
