// lib/cache.js talks to chrome.storage.local, so stand one up before importing
// it. The module is imported once and reset between tests via the shim.

import test from 'node:test';
import assert from 'node:assert/strict';

let store = {};

// Writes resolve a turn late, which is what lets a test start two of them and
// have the second read the store before the first has written it -- the shape
// of the race writeTvmazeShow has to survive.
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
        await null;
        Object.assign(store, entries);
      },
      async remove(keys) {
        for (const key of [].concat(keys)) delete store[key];
      }
    }
  }
};

const {
  LISTS,
  readCache,
  readCaches,
  writeCache,
  clearCache,
  writeTvmazeShow,
  readTvmazeShow,
  readTvmazeShows,
  showSummary,
  TVMAZE_MAX_AGE_MS,
  TVMAZE_MAX_SHOWS
} = await import('../lib/cache.js');

test.beforeEach(() => {
  store = {};
});

// A cached show, the shape writeTvmazeShow is handed, and the MyEpisodes show
// id it is filed under -- two different numbering systems for the same show,
// which is the whole reason the key and the summary's own id differ.
const SHOWID = 25262;

// Exactly what showSummary hands writeTvmazeShow, so every entry below is a
// value a lookup could really have stored. It used to carry the show's id, name
// and URL too -- and entries were told apart by `name` -- which stopped being a
// shape the cache can hold when showSummary was cut to these two fields. The
// entry's key is the argument to writeTvmazeShow, never anything in here.
function summary(patch = {}) {
  return { network: 'HBO', poster: '', ...patch };
}

test('a written list reads back', async () => {
  await writeCache('today', [{ show: 'A' }]);
  assert.deepEqual((await readCache('today')).items, [{ show: 'A' }]);
});

test('a list that was never written is a miss', async () => {
  assert.equal(await readCache('tomorrow'), null);
});

test('lists do not collide with each other', async () => {
  await writeCache('today', [{ show: 'A' }]);
  await writeCache('week', [{ show: 'B' }]);
  assert.deepEqual((await readCache('today')).items, [{ show: 'A' }]);
  assert.deepEqual((await readCache('week')).items, [{ show: 'B' }]);
});

test('an entry from another day is a miss', async () => {
  await writeCache('today', [{ show: 'A' }]);
  store['cache:today'].day = 'Mon Jan 01 2001';
  assert.equal(await readCache('today'), null);
});

// The upgrade day is what the version is for: a list cached as RSS items would
// otherwise be read back into an API-backed tab and painted as episodes with
// half their fields missing.
test('a list cached to an older item shape is a miss', async () => {
  await writeCache('today', [{ show: 'A' }]);
  store['cache:today'].version = 0;
  assert.equal(await readCache('today'), null);

  // Including the shape that carried no version at all.
  delete store['cache:today'].version;
  assert.equal(await readCache('today'), null);
});

test('an entry records when it was fetched', async () => {
  const before = Date.now();
  await writeCache('today', []);
  const { fetchedAt } = await readCache('today');
  assert.ok(fetchedAt >= before && fetchedAt <= Date.now());
});

// clearCache names the lists rather than reading the store back to find them,
// so a list added to LISTS and forgotten there would survive an account switch.
test('clearCache takes every list the extension reads', async () => {
  assert.ok(LISTS.length, 'LISTS should not be empty');

  for (const list of LISTS) await writeCache(list, [{ show: list }]);
  await clearCache();

  for (const list of LISTS) assert.equal(await readCache(list), null, list);
  assert.deepEqual(Object.keys(store), []);
});

test('clearCache leaves everything that is not a cache entry alone', async () => {
  await writeCache('today', [{ show: 'A' }]);
  store.apikey = 'myeps_token';
  store['unrelated:thing'] = 1;

  await clearCache();

  assert.deepEqual(Object.keys(store).sort(), ['apikey', 'unrelated:thing']);
});

test('clearCache on an empty store is a no-op', async () => {
  await clearCache();
  assert.deepEqual(Object.keys(store), []);
});

// The TVmaze entries describe shows rather than an account, so they are worth
// as much to the next set of credentials as they were to the last one.
test('clearCache leaves the TVmaze lookups in place', async () => {
  await writeCache('today', [{ show: 'A' }]);
  await writeTvmazeShow(SHOWID, summary());

  await clearCache();

  assert.equal(await readCache('today'), null);
  assert.equal((await readTvmazeShow(SHOWID)).show.network, 'HBO');
});

// One round trip instead of one per list, which is the whole point of it.
test('readCaches answers for every list in a single read', async () => {
  const reads = [];
  const get = chrome.storage.local.get;
  chrome.storage.local.get = async (keys) => {
    reads.push(keys);
    return get(keys);
  };

  await writeCache('today', [{ show: 'A' }]);
  await writeCache('tomorrow', [{ show: 'B' }, { show: 'C' }]);
  const caches = await readCaches();
  chrome.storage.local.get = get;

  assert.equal(reads.length, 1, 'every list should come back from one get()');
  assert.deepEqual([...caches.keys()], [...LISTS]);
  assert.equal(caches.get('today').items.length, 1);
  assert.equal(caches.get('tomorrow').items.length, 2);
  // A list never written reports the miss readCache would report.
  assert.equal(caches.get('yesterday'), null);
});

test('readCaches calls another day a miss, the way readCache does', async () => {
  await writeCache('today', [{ show: 'A' }]);
  store['cache:today'].day = 'Mon Jan 01 2001';
  assert.equal((await readCaches()).get('today'), null);
});

test('readCaches calls an older item shape a miss too', async () => {
  await writeCache('today', [{ show: 'A' }]);
  store['cache:today'].version = 0;
  assert.equal((await readCaches()).get('today'), null);
});

// The popup reads the whole TVmaze cache once when it opens rather than asking
// storage about every card it draws, so the batch read has to answer with the
// same entries readTvmazeShow would one at a time.
test('readTvmazeShows hands back every fresh entry, keyed by show id', async () => {
  await writeTvmazeShow(SHOWID, summary());
  await writeTvmazeShow(31519, summary({ network: 'Netflix' }));

  const all = await readTvmazeShows();
  // Keyed by number, since that is how a show id arrives on an item.
  assert.deepEqual([...all.keys()], [SHOWID, 31519]);
  assert.equal(all.get(SHOWID).show.network, 'HBO');
  assert.equal(all.get(31519).show.network, 'Netflix');
});

test('readTvmazeShows leaves out what readTvmazeShow would call a miss', async () => {
  await writeTvmazeShow(1, summary());
  await writeTvmazeShow(2, summary());

  store['cache:tvmaze'].shows['1'].fetchedAt = 0;
  delete store['cache:tvmaze'].shows['2'].show;

  assert.deepEqual([...(await readTvmazeShows()).keys()], []);
  assert.equal(await readTvmazeShow(1), null);
  assert.equal(await readTvmazeShow(2), null);
});

test('readTvmazeShows on an empty store is an empty map', async () => {
  assert.equal((await readTvmazeShows()).size, 0);
});

test('a stored entry read back is the one that was written', async () => {
  const show = summary();
  await writeTvmazeShow(SHOWID, show);

  const cached = await readTvmazeShow(SHOWID);
  assert.deepEqual(cached.show, show);
  assert.ok(cached.fetchedAt <= Date.now());
  assert.equal(await readTvmazeShow(999), null);
});

// The reason the key changed: a day can hold several episodes of one show, and
// every one of them is the same lookup. The store holds one entry for all of
// them, so the second episode never reaches storage for a second answer.
test('several episodes of one show are one entry', async () => {
  await writeTvmazeShow(SHOWID, summary());
  await writeTvmazeShow(SHOWID, summary());
  await writeTvmazeShow(SHOWID, summary());

  assert.deepEqual(Object.keys(store['cache:tvmaze'].shows), [String(SHOWID)]);
  assert.equal((await readTvmazeShows()).size, 1);
});

// chrome.storage has no read-modify-write, so this is the failure the write
// queue exists to prevent: several lookups landing together used to read the
// same store and write over one another, leaving one entry out of every four.
test('lookups written at the same time all survive', async () => {
  await Promise.all([1, 2, 3, 4].map((id) => writeTvmazeShow(id, summary())));

  const { shows } = store['cache:tvmaze'];
  assert.deepEqual(Object.keys(shows).sort(), ['1', '2', '3', '4']);
  assert.equal((await readTvmazeShows()).size, 4);
});

// Two is enough to lose one: the second reads the store before the first has
// written it, and without the queue the later write wins outright.
test('two overlapping writes both survive', async () => {
  const first = writeTvmazeShow(1, summary());
  const second = writeTvmazeShow(2, summary());
  await Promise.all([first, second]);

  assert.deepEqual(Object.keys(store['cache:tvmaze'].shows).sort(), ['1', '2']);
});

// The queue must not jam on a write that fails, or the first storage blip would
// take every lookup after it down with it.
test('a failed write does not stop the next one', async () => {
  const set = chrome.storage.local.set;
  chrome.storage.local.set = async () => {
    throw new Error('quota');
  };
  await assert.rejects(writeTvmazeShow(1, summary()));
  chrome.storage.local.set = set;

  await writeTvmazeShow(2, summary());
  assert.equal((await readTvmazeShow(2)).show.network, 'HBO');
});

test('an expired entry is dropped on the next write', async () => {
  await writeTvmazeShow(1, summary());
  store['cache:tvmaze'].shows['1'].fetchedAt = Date.now() - TVMAZE_MAX_AGE_MS - 1;

  await writeTvmazeShow(2, summary({ network: 'Other' }));

  assert.deepEqual(Object.keys(store['cache:tvmaze'].shows), ['2']);
});

test('an entry stamped in the future counts as expired', async () => {
  await writeTvmazeShow(1, summary());
  // The clock moved backwards under the entry, which leaves no way to tell how
  // old it really is.
  store['cache:tvmaze'].shows['1'].fetchedAt = Date.now() + 60_000;

  assert.equal(await readTvmazeShow(1), null);
  assert.equal((await readTvmazeShows()).size, 0);

  await writeTvmazeShow(2, summary());
  assert.deepEqual(Object.keys(store['cache:tvmaze'].shows), ['2']);
});

test('a caller can ask for a shorter freshness than the default', async () => {
  await writeTvmazeShow(1, summary());
  store['cache:tvmaze'].shows['1'].fetchedAt = Date.now() - 60_000;

  assert.equal(await readTvmazeShow(1, { maxAge: 1000 }), null);
  assert.equal((await readTvmazeShows({ maxAge: 1000 })).size, 0);
  assert.ok(await readTvmazeShow(1, { maxAge: 120_000 }));
});

// Age alone bounds nothing: a week's expiry lets a watchlist that churns keep
// adding shows without ever dropping one, and enough of them fills the storage
// quota -- after which every write fails and the cache silently stops being
// one.
test('the cache is capped, and gives up its oldest entries first', async () => {
  // All comfortably inside the age limit, so it is the cap and not expiry doing
  // the work, but ordered so that id 1 is the oldest thing in the store.
  const base = Date.now() - 60_000;

  for (let id = 1; id <= TVMAZE_MAX_SHOWS; id += 1) {
    await writeTvmazeShow(id, summary());
    store['cache:tvmaze'].shows[String(id)].fetchedAt = base + id;
  }
  assert.equal(Object.keys(store['cache:tvmaze'].shows).length, TVMAZE_MAX_SHOWS);

  // The write that tips it over does the pruning, so trigger one more.
  await writeTvmazeShow(9999, summary());

  const kept = Object.keys(store['cache:tvmaze'].shows);
  assert.equal(kept.length, TVMAZE_MAX_SHOWS);
  assert.ok(!kept.includes('1'), 'the oldest entry should be the one dropped');
  assert.ok(kept.includes('2'), 'and only as many as the cap is over by');
  assert.ok(kept.includes('9999'), 'the entry just written can never be the one cut');
});

// Held out of the sort rather than trusted to be the newest in it: a caller
// that has just paid for a lookup has to be able to read it back, even when the
// entry it replaced was stamped ahead of the clock.
test('the entry just written survives a cap it looks oldest to', async () => {
  const base = Date.now() + 60_000;

  for (let id = 1; id <= TVMAZE_MAX_SHOWS; id += 1) {
    await writeTvmazeShow(id, summary());
    store['cache:tvmaze'].shows[String(id)].fetchedAt = base + id;
  }

  await writeTvmazeShow(9999, summary());

  assert.ok(Object.keys(store['cache:tvmaze'].shows).includes('9999'));
});

// The card paints its avatar out of the cache, so the poster URL has to be one
// of the fields showSummary keeps.
test('showSummary keeps what a card is painted from and drops the rest', () => {
  const show = showSummary({
    id: 44776,
    network: 'HBO',
    poster: 'https://static.tvmaze.com/m.jpg'
  });

  // TVmaze's own show id goes no further than the parse it was validated on:
  // the entry is filed under the MyEpisodes show id, so it is not even the key.
  assert.deepEqual(show, {
    network: 'HBO',
    poster: 'https://static.tvmaze.com/m.jpg'
  });
});

test('showSummary leaves a show with nothing on it holding empty strings', () => {
  assert.deepEqual(showSummary({ id: 1 }), { network: '', poster: '' });
  assert.equal(showSummary({ id: 1, poster: null }).poster, '');
});

// The one field name both sides have to agree on, and the agreement is silent
// when it breaks: showRecord hands over a flat `poster` string where it used to
// hand over an { medium, original } image object, and a read under the old name
// would empty every avatar in the popup without anything raising.
test('showSummary reads the poster off the record it is handed', () => {
  const record = { id: 44776, network: 'HBO', poster: 'https://static.tvmaze.com/m.jpg' };
  assert.equal(showSummary(record).poster, 'https://static.tvmaze.com/m.jpg');
  // The shape it replaced says nothing to this function any more.
  assert.equal(showSummary({ image: { medium: 'https://static.tvmaze.com/m.jpg' } }).poster, '');
});

// Changing the stored shape has to invalidate what is there, or a card waits
// out the week's max age before it can show what was just added.
test('a cache written to an older shape reads as empty', async () => {
  await writeTvmazeShow(SHOWID, summary());

  store['cache:tvmaze'].version = 1;

  assert.equal((await readTvmazeShows()).size, 0, 'the old shape should not be trusted');
  assert.equal(await readTvmazeShow(SHOWID), null);
});

// The shape before this one was keyed by TVmaze episode id and pointed into a
// second tier of shows -- neither the keys nor the entries mean anything here.
test('the old two-tier index reads as empty', async () => {
  store['cache:tvmaze'] = {
    version: 3,
    episodes: { 3695361: { showId: 44776, fetchedAt: Date.now() } },
    shows: { 44776: { id: 44776, name: 'Lanterns', url: '', network: 'HBO', poster: '' } }
  };

  assert.equal((await readTvmazeShows()).size, 0);
  assert.equal(await readTvmazeShow(44776), null);
  assert.equal(await readTvmazeShow(3695361), null);
});

// Up to 0.15.0 every lookup also wrote a cache:tvmaze:<id> record that nothing
// read, and the version before this one kept an episodes tier inside the index.
// Neither has an owner now, so the upgrade has to take them out.
test('the first write after an upgrade sweeps what earlier versions left behind', async () => {
  store['cache:tvmaze'] = {
    version: 3,
    episodes: { 1: { showId: 10, fetchedAt: Date.now() } },
    // Spelled out rather than built from summary(): the point of this fixture is
    // that it is the shape version 3 wrote, which carried the show's id, name
    // and URL. Reusing the current helper would make it neither shape.
    shows: { 10: { id: 10, name: 'Lanterns', url: '', network: 'HBO', poster: '' } }
  };
  store['cache:tvmaze:1'] = { episode: {}, show: {} };
  store['cache:tvmaze:2'] = { episode: {}, show: {} };
  store.apikey = 'myeps_token';

  await writeTvmazeShow(3, summary());

  assert.ok(!('cache:tvmaze:1' in store), 'orphaned detail records should be gone');
  assert.ok(!('cache:tvmaze:2' in store));
  const stored = store['cache:tvmaze'];
  assert.deepEqual(Object.keys(stored.shows), ['3']);
  assert.ok(!('episodes' in stored), 'the episode tier should be gone with them');
  assert.equal(store.apikey, 'myeps_token', 'the sweep should touch nothing else');

  // And it happens once: a later write has nothing left to scan for.
  const reads = [];
  const get = chrome.storage.local.get;
  chrome.storage.local.get = async (keys) => {
    reads.push(keys);
    return get(keys);
  };
  await writeTvmazeShow(4, summary());
  chrome.storage.local.get = get;
  assert.ok(!reads.includes(null), 'the whole store should not be scanned again');
});

test('a fresh store is not mistaken for an outdated one', async () => {
  await writeTvmazeShow(1, summary());
  assert.equal((await readTvmazeShow(1)).show.network, 'HBO');
});

// The tab ids and the cache names are the same strings, so a tab renamed
// without renaming its list here would quietly read an empty cache for ever --
// the version stamp cannot catch that, because the old entry is still valid,
// just under a name nothing asks for. Pinned rather than derived so the rename
// has to be made twice on purpose.
test('LISTS names the four lists the popup keeps', () => {
  assert.deepEqual([...LISTS], ['yesterday', 'today', 'tomorrow', 'week']);
});
