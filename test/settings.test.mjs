// lib/settings.js had no test file while it was three fields and two
// predicates. It has one now because forgetRetiredSettings deletes things, and
// the one it deletes is a password-equivalent secret -- a sweep that quietly
// stopped naming `pwdmd5` would leave it replicating through the user's Google
// account with nothing to say so.

import test from 'node:test';
import assert from 'node:assert/strict';

const sync = {};
const local = {};
const removed = { sync: [], local: [] };

const area = (store, log) => ({
  get: async (defaults) =>
    Object.fromEntries(Object.keys(defaults).filter((k) => k in store).map((k) => [k, store[k]])),
  set: async (patch) => Object.assign(store, patch),
  remove: async (names) => {
    for (const name of [].concat(names)) {
      log.push(name);
      delete store[name];
    }
  }
});

globalThis.chrome = {
  storage: { sync: area(sync, removed.sync), local: area(local, removed.local) },
  runtime: { openOptionsPage() {} }
};

const { forgetRetiredSettings, getSettings, isConfigured, saveSettings } =
  await import('../lib/settings.js');

test.beforeEach(() => {
  for (const k of Object.keys(sync)) delete sync[k];
  for (const k of Object.keys(local)) delete local[k];
  removed.sync.length = 0;
  removed.local.length = 0;
});

test('getSettings answers with the API key, the lookback, and nothing else', async () => {
  sync.apiKey = 'myeps_k';
  // A 2.x install still has these sitting in sync until the sweep runs; they
  // must not come back out as settings.
  sync.uid = 'someone';
  sync.pwdmd5 = 'd41d8cd98f00b204e9800998ecf8427e';

  assert.deepEqual(await getSettings(), { apiKey: 'myeps_k', oldEpisodesDays: 14 });
});

test('getSettings falls back to an empty key and the default lookback', async () => {
  assert.deepEqual(await getSettings(), { apiKey: '', oldEpisodesDays: 14 });
  assert.equal(isConfigured(await getSettings()), false);
});

test('isConfigured asks only for the key', () => {
  assert.equal(isConfigured({ apiKey: 'myeps_k' }), true);
  assert.equal(isConfigured({ apiKey: '' }), false);
  assert.equal(isConfigured({}), false);
});

test('saveSettings merges rather than replacing', async () => {
  sync.apiKey = 'old';
  await saveSettings({ apiKey: 'new' });
  assert.equal(sync.apiKey, 'new');
});

// The reason this file exists.
test('the sweep takes the feed credentials out of sync storage', async () => {
  sync.apiKey = 'myeps_k';
  sync.uid = 'someone';
  sync.pwdmd5 = 'd41d8cd98f00b204e9800998ecf8427e';

  await forgetRetiredSettings();

  assert.ok(removed.sync.includes('uid'));
  assert.ok(removed.sync.includes('pwdmd5'), 'the password-equivalent one above all');
  assert.deepEqual(Object.keys(sync), ['apiKey'], 'and the key it still needs stays');
});

// All Today's cached list is no longer in LISTS, so clearCache never names it
// and nothing else would ever prune it.
test('the sweep takes the retired list cache with them', async () => {
  local['cache:alltoday'] = { day: 'x', items: [] };
  local['cache:today'] = { day: 'x', items: [] };

  await forgetRetiredSettings();

  assert.ok(removed.local.includes('cache:alltoday'));
  assert.deepEqual(Object.keys(local), ['cache:today']);
});

// It runs on every install, not only an upgrade, so the common case is that
// there is nothing there. remove() ignores names that were never written, which
// is why the sweep does not read the store first to find out.
test('the sweep is harmless on a fresh install', async () => {
  await forgetRetiredSettings();
  assert.deepEqual(Object.keys(sync), []);
  assert.deepEqual(Object.keys(local), []);
});
