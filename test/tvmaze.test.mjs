// lib/tvmaze.js fetches and caches, so both globals it reaches for are stood
// up here: chrome.storage.local for the cache, and fetch for the API. The
// module is imported once and the two are reset between tests.

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

// Every request the test made, so a cache hit can be told from a second call.
let calls = [];
let respond = () => {
  throw new Error('no response queued');
};

globalThis.fetch = async (url) => {
  calls.push(url);
  return respond(url);
};

const {
  fetchEpisode,
  fetchShow,
  lookupShow,
  parseEpisode,
  parseShow,
  TvmazeError
} = await import('../lib/tvmaze.js');
const { readTvmazeShow, showSummary, TVMAZE_MAX_AGE_MS } = await import('../lib/cache.js');

// The three numbers this module is handed, from the live shapes: MyEpisodes
// files Lanterns under 25262, TVmaze under 44776, and its third episode under
// 3695361. Two of them are TVmaze ids for the same show at different depths,
// which is exactly what the two routes through lookupShow are about.
const SHOWID = 25262;
const TVMAZE_SHOW = 44776;
const TVMAZE_EPISODE = 3695361;

// Trimmed from the live GET /shows/44776.
const SHOW = {
  id: TVMAZE_SHOW,
  url: 'https://www.tvmaze.com/shows/44776/lanterns',
  name: 'Lanterns',
  language: 'English',
  genres: ['Drama', 'Science-Fiction'],
  status: 'Running',
  runtime: null,
  averageRuntime: 60,
  premiered: '2026-08-16',
  ended: null,
  officialSite: 'https://www.hbo.com/lanterns',
  rating: { average: 7.9 },
  network: { id: 8, name: 'HBO' },
  webChannel: null,
  image: {
    medium: 'https://static.tvmaze.com/m.jpg',
    original: 'https://static.tvmaze.com/o.jpg'
  },
  summary: '<p>Two <b>Green Lanterns</b> investigate a murder.</p>'
};

// And from GET /episodes/3695361?embed=show, which is the same show record one
// level down.
const EPISODE = {
  id: TVMAZE_EPISODE,
  url: 'https://www.tvmaze.com/episodes/3695361/lanterns-1x03-outkast',
  name: 'OutKast',
  season: 1,
  number: 3,
  airdate: '2026-08-30',
  airtime: '21:00',
  airstamp: '2026-08-31T01:00:00+00:00',
  runtime: 60,
  rating: { average: 9 },
  image: {
    medium: 'https://static.tvmaze.com/uploads/images/medium_landscape/639/1597896.jpg',
    original: 'https://static.tvmaze.com/uploads/images/original_untouched/639/1597896.jpg'
  },
  summary: '<p>John gets his chance to interview for the Guardians.</p>',
  _embedded: { show: SHOW },
  _links: {
    self: { href: 'https://api.tvmaze.com/episodes/3695361' },
    show: { href: 'https://api.tvmaze.com/shows/44776', name: 'Lanterns' }
  }
};

function episode(patch = {}) {
  return structuredClone({ ...EPISODE, ...patch });
}

function show(patch = {}) {
  return structuredClone({ ...SHOW, ...patch });
}

function ok(body) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    }
  };
}

function status(code) {
  return {
    ok: false,
    status: code,
    async json() {
      return {};
    }
  };
}

test.beforeEach(() => {
  store = {};
  calls = [];
  // Whichever endpoint the module reaches for, answered from the live shape.
  respond = (url) => ok(url.includes('/episodes/') ? episode() : show());
});


test('parseShow keeps the fields a card needs from a bare show payload', () => {
  const parsed = parseShow(show());

  // Three fields out of a payload carrying a dozen more: the id it was
  // validated on, and the two a card paints. Everything else in SHOW above is
  // there to be dropped.
  assert.deepEqual(parsed, {
    id: TVMAZE_SHOW,
    network: 'HBO',
    poster: 'https://static.tvmaze.com/m.jpg'
  });
});

// Both routes feed the same cache, so a card must not be able to tell which one
// filled it in.
test('parseShow and parseEpisode agree about the show', () => {
  assert.deepEqual(parseShow(show()), parseEpisode(episode()).show);
});

// The whole chain a card is painted through, walked end to end: showRecord
// names the fields, showSummary keeps them, and the popup reads them off the
// stored entry. Nothing here throws when a name stops matching -- a poster read
// under the wrong key is simply an empty avatar -- so both routes are followed
// all the way into the stored shape.
test('either route reaches the stored shape with the card still filled in', () => {
  for (const record of [parseShow(show()), parseEpisode(episode()).show]) {
    assert.deepEqual(showSummary(record), {
      network: 'HBO',
      poster: 'https://static.tvmaze.com/m.jpg'
    });
  }
});

test('parseShow rejects a payload that names no show', () => {
  for (const payload of [{}, null, { name: 'Lanterns' }]) {
    assert.throws(() => parseShow(payload), (error) => {
      assert.ok(error instanceof TvmazeError);
      assert.equal(error.kind, 'parse');
      return true;
    });
  }
});

test('parseEpisode keeps the fields a card needs from both halves', () => {
  const parsed = parseEpisode(episode());

  // The embed one level down, read into the same record the bare show payload
  // produces. The episode's own fields are MyEpisodes' to send.
  assert.deepEqual(parsed.show, {
    id: TVMAZE_SHOW,
    network: 'HBO',
    poster: 'https://static.tvmaze.com/m.jpg'
  });
});

test('a streaming show takes its name from the web channel', () => {
  // Streaming shows carry a webChannel where broadcast ones carry a network,
  // and both routes have to read whichever one is there.
  const streaming = show({ network: null, webChannel: { id: 1, name: 'Netflix' } });
  assert.equal(parseShow(streaming).network, 'Netflix');
  assert.equal(parseEpisode(episode({ _embedded: { show: streaming } })).show.network, 'Netflix');
});

test('parseEpisode falls back to the show link when nothing is embedded', () => {
  const body = episode();
  delete body._embedded;

  const { show: parsed } = parseEpisode(body);
  // The link says which show it was, which is all the fallback is for: with no
  // embed there is nothing to paint, so the two card fields come back empty
  // rather than invented.
  assert.deepEqual(parsed, { id: TVMAZE_SHOW, network: '', poster: '' });
});

test('parseEpisode rejects an episode with no show anywhere in it', () => {
  const body = episode();
  delete body._embedded;
  delete body._links;

  assert.throws(() => parseEpisode(body), (error) => {
    assert.ok(error instanceof TvmazeError);
    assert.equal(error.kind, 'parse');
    return true;
  });
});

// One request for the thing actually wanted, with nothing embedded in it.
test('fetchShow asks for the show and nothing else', async () => {
  const parsed = await fetchShow(TVMAZE_SHOW);

  assert.deepEqual(calls, ['https://api.tvmaze.com/shows/44776']);
  assert.equal(parsed.id, TVMAZE_SHOW);
});

test('fetchEpisode asks for the show in the same request', async () => {
  await fetchEpisode(TVMAZE_EPISODE);

  assert.equal(calls.length, 1);
  const url = new URL(calls[0]);
  assert.equal(url.origin + url.pathname, 'https://api.tvmaze.com/episodes/3695361');
  assert.equal(url.searchParams.get('embed'), 'show');
});

// One status table behind both routes, so a caller's retry logic reads the same
// either way -- and 'rate-limit' is the one the popup retries on.
test('both routes name the failures worth telling apart', async () => {
  const kinds = { 404: 'notfound', 429: 'rate-limit', 500: 'http' };

  for (const fetcher of [fetchShow, fetchEpisode]) {
    for (const [code, kind] of Object.entries(kinds)) {
      respond = () => status(Number(code));
      await assert.rejects(fetcher(1), (error) => {
        assert.equal(error.kind, kind, `${fetcher.name} ${code}`);
        return true;
      });
    }

    respond = () => {
      throw new TypeError('Failed to fetch');
    };
    await assert.rejects(fetcher(1), (error) => {
      assert.equal(error.kind, 'network', fetcher.name);
      return true;
    });

    respond = () => ({
      ok: true,
      status: 200,
      async json() {
        throw new SyntaxError('nope');
      }
    });
    await assert.rejects(fetcher(1), (error) => {
      assert.equal(error.kind, 'parse', fetcher.name);
      return true;
    });
  }
});

// The show id is the shorter route: one request for the record the card is
// painted from.
test('lookupShow goes straight to the show when it has its TVmaze id', async () => {
  const { show: summary } = await lookupShow(SHOWID, { tvmazeShowId: TVMAZE_SHOW });

  assert.deepEqual(calls, ['https://api.tvmaze.com/shows/44776']);
  assert.deepEqual(summary, showSummary(parseShow(show())));
});

// An item the API only filled in as far as the episode carries an episode id
// instead, which answers with the show behind it in the same round trip.
test('lookupShow falls back to the episode when that is all it has', async () => {
  const { show: summary } = await lookupShow(SHOWID, { tvmazeEpisodeId: TVMAZE_EPISODE });

  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith('https://api.tvmaze.com/episodes/3695361?'));
  // The same summary either route, so a caller never has to know which it got.
  assert.deepEqual(summary, showSummary(parseShow(show())));
});

test('lookupShow prefers the show id when it is given both', async () => {
  await lookupShow(SHOWID, { tvmazeShowId: TVMAZE_SHOW, tvmazeEpisodeId: TVMAZE_EPISODE });
  assert.deepEqual(calls, ['https://api.tvmaze.com/shows/44776']);
});

test('lookupShow rejects a show with no route to TVmaze at all', async () => {
  await assert.rejects(lookupShow(SHOWID), (error) => {
    assert.ok(error instanceof TvmazeError);
    assert.equal(error.kind, 'link');
    return true;
  });
  await assert.rejects(lookupShow(SHOWID, { tvmazeShowId: null, tvmazeEpisodeId: null }));
  assert.equal(calls.length, 0);
});

test('lookupShow fetches once and then serves the cache', async () => {
  const first = await lookupShow(SHOWID, { tvmazeShowId: TVMAZE_SHOW });
  assert.equal(calls.length, 1);

  const second = await lookupShow(SHOWID, { tvmazeShowId: TVMAZE_SHOW });
  assert.equal(calls.length, 1, 'the second lookup should not hit the network');
  assert.deepEqual(second.show, first.show);
  assert.equal(second.fetchedAt, first.fetchedAt, 'a hit reports when it was fetched');
});

// The point of keying the cache by MyEpisodes show id. A day can hold several
// episodes of one show, and the old episode-keyed cache paid for a fresh lookup
// for every one of them -- three episodes across three tabs, three requests for
// the same answer.
test('several episodes of one show cost one request between them', async () => {
  await lookupShow(SHOWID, { tvmazeEpisodeId: 3695361 });
  assert.equal(calls.length, 1);

  // Later episodes of the same show, each with a TVmaze episode id of its own.
  respond = (url) => ok(episode({ id: Number(new URL(url).pathname.split('/')[2]) }));
  await lookupShow(SHOWID, { tvmazeEpisodeId: 3695362 });
  await lookupShow(SHOWID, { tvmazeEpisodeId: 3695363 });
  // And the same show reached by the other route, which is still one show.
  await lookupShow(SHOWID, { tvmazeShowId: TVMAZE_SHOW });

  assert.equal(calls.length, 1, 'one show is one lookup, whatever episode named it');
  assert.deepEqual(Object.keys(store['cache:tvmaze'].shows), [String(SHOWID)]);
});

test('a different show is a different lookup', async () => {
  await lookupShow(SHOWID, { tvmazeShowId: TVMAZE_SHOW });
  await lookupShow(31519, { tvmazeShowId: 82 });

  assert.equal(calls.length, 2);
  assert.deepEqual(Object.keys(store['cache:tvmaze'].shows).sort(), ['25262', '31519']);
});

// The popup reads the whole cache when it opens, so anything reaching the
// lookup is already known to be a miss and the read would only confirm it.
test('lookupShow can be told not to bother reading the cache', async () => {
  await lookupShow(SHOWID, { tvmazeShowId: TVMAZE_SHOW });

  const reads = [];
  const get = chrome.storage.local.get;
  chrome.storage.local.get = async (keys) => {
    reads.push(keys);
    return get(keys);
  };

  respond = () => ok(show({ network: { id: 8, name: 'Max' } }));
  const fresh = await lookupShow(SHOWID, { tvmazeShowId: TVMAZE_SHOW, cached: false });
  chrome.storage.local.get = get;

  assert.equal(calls.length, 2, 'it should go straight to the network');
  assert.equal(fresh.show.network, 'Max');
  // The write still reads the cache to add to it; what is skipped is the read
  // that would have served the lookup instead of making it.
  assert.equal(reads.filter((keys) => keys === 'cache:tvmaze').length, 1);
  assert.equal((await readTvmazeShow(SHOWID)).show.network, 'Max');
  assert.equal(Object.keys(store['cache:tvmaze'].shows).length, 1);
});

test('a lookup that is too old goes back to the network', async () => {
  await lookupShow(SHOWID, { tvmazeShowId: TVMAZE_SHOW });

  store['cache:tvmaze'].shows[String(SHOWID)].fetchedAt = Date.now() - TVMAZE_MAX_AGE_MS - 1;
  assert.equal(await readTvmazeShow(SHOWID), null);

  await lookupShow(SHOWID, { tvmazeShowId: TVMAZE_SHOW });
  assert.equal(calls.length, 2);
});

// A cache that will not open is a slow lookup, not a failed one.
test('a lookup outlives a cache that will not read', async () => {
  const get = chrome.storage.local.get;
  chrome.storage.local.get = async () => {
    throw new Error('unavailable');
  };

  const { show: summary } = await lookupShow(SHOWID, { tvmazeShowId: TVMAZE_SHOW });
  chrome.storage.local.get = get;

  assert.equal(summary.network, 'HBO');
});

// The popup runs a tab's worth of these at once, and the answers arrive
// together -- which is the race the cache's write queue exists for.
test('lookups running side by side all reach the cache', async () => {
  const showids = [1, 2, 3, 4];
  respond = (url) => ok(show({ id: Number(new URL(url).pathname.split('/')[2]) }));

  await Promise.all(
    showids.map((id) => lookupShow(id, { tvmazeShowId: id, cached: false }))
  );

  assert.deepEqual(Object.keys(store['cache:tvmaze'].shows).sort(), ['1', '2', '3', '4']);
});

test('a write that fails costs the next lookup a request and nothing more', async () => {
  const set = chrome.storage.local.set;
  chrome.storage.local.set = async () => {
    throw new Error('quota');
  };

  const { show: summary } = await lookupShow(SHOWID, { tvmazeShowId: TVMAZE_SHOW });
  assert.equal(summary.network, 'HBO', 'the caller still gets its answer');

  chrome.storage.local.set = set;
  await lookupShow(SHOWID, { tvmazeShowId: TVMAZE_SHOW });
  assert.equal(calls.length, 2);
  assert.equal((await readTvmazeShow(SHOWID)).show.network, 'HBO');
});
