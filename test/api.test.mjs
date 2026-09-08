// lib/api.js reaches for one global, so fetch is the only thing stood up here.
// Every call is recorded rather than just counted: half of what this module
// does is build a URL, and the query string is the only place to read it back
// from.
//
// The clock tests are written to hold in any timezone the suite happens to run
// in -- they assert the local calendar and, where the machine is off UTC, that
// the answer is not the one a UTC reading would have given.

import test from 'node:test';
import assert from 'node:assert/strict';

let calls = [];
let respond = () => ok(page([], false));

globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  return respond(url, init);
};

const {
  API_BASE,
  ApiError,
  dayKey,
  fetchAccount,
  fetchEpisodes,
  fetchList,
  HOME_PAGE,
  request,
  toEpisode,
  weekOffsets,
  weekRange
} = await import('../lib/api.js');

// Only the parts of a Response lib/api.js reads, which is text() and nothing
// else -- it reads the body as text and parses it itself, so that an empty body
// can be told apart from bytes that will not parse.
function ok(body) {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(body);
    }
  };
}

// A success with nothing in it, which is what a PUT that worked looks like.
function okEmpty(status = 204) {
  return {
    ok: true,
    status,
    async text() {
      return '';
    }
  };
}

// `body` left undefined stands for a body it cannot parse -- a proxy's HTML
// error page, say.
function fail(status, body) {
  return {
    ok: false,
    status,
    async text() {
      return body === undefined ? '<html>go away</html>' : JSON.stringify(body);
    }
  };
}

function page(data, hasMore) {
  return { data, meta: { limit: 200, offset: 0, has_more: hasMore } };
}

// The verified /v1/shows/{showid}/episodes shape: an episode with no show
// beside it.
const FLAT = {
  showid: 25262,
  season: 1,
  episode: 1,
  name: 'Pilot',
  airdate: '2026-08-16',
  airtime: '21:00:00',
  utc_airdate: '2026-08-17 03:00:00',
  runtime: 60,
  special: false,
  external: { tvmaze: 3606548 }
};

// What /v1/me/episodes is assumed to send: the same episode with the show
// nested beside it and the viewer's own flags on top.
const NESTED = {
  ...FLAT,
  show: {
    showid: 25262,
    showname: 'Lanterns',
    url: '/Lanterns',
    network: { id: 8, name: 'HBO' },
    runtime: 60,
    airtime: '21:00:00',
    timezone: 'America/New_York',
    external: { tvmaze: 44776, tvrage: null, thetvdb: 376098 }
  }
};

function query(index = 0) {
  return new URL(calls[index].url).searchParams;
}

test.beforeEach(() => {
  calls = [];
  respond = () => ok(page([], false));
});

test('dayKey speaks the offsets the tabs already use', () => {
  const noon = new Date(2026, 8, 7, 12, 0);
  assert.equal(dayKey(-1, noon), '2026-09-06');
  assert.equal(dayKey(0, noon), '2026-09-07');
  assert.equal(dayKey(1, noon), '2026-09-08');
});

test('dayKey steps across a month and a year', () => {
  assert.equal(dayKey(1, new Date(2026, 0, 31, 12, 0)), '2026-02-01');
  assert.equal(dayKey(-1, new Date(2026, 2, 1, 12, 0)), '2026-02-28');
  assert.equal(dayKey(1, new Date(2026, 11, 31, 12, 0)), '2027-01-01');
  assert.equal(dayKey(-1, new Date(2026, 0, 1, 12, 0)), '2025-12-31');
});

// The bug this guards is toISOString(): it prints the UTC date, which is a day
// off the viewer's own for part of every day everywhere but UTC itself.
test('dayKey reads the local calendar and not the UTC one', () => {
  const lateEvening = new Date(2026, 0, 31, 23, 59);
  const earlyMorning = new Date(2026, 0, 31, 0, 1);

  assert.equal(dayKey(0, lateEvening), '2026-01-31');
  assert.equal(dayKey(0, earlyMorning), '2026-01-31');
  assert.equal(dayKey(1, lateEvening), '2026-02-01');

  // West of UTC the late evening has already rolled over in UTC; east of it the
  // early morning has not arrived yet. Whichever way this machine sits, one of
  // the two moments proves the difference; on UTC there is nothing to prove.
  const offset = lateEvening.getTimezoneOffset();
  if (offset !== 0) {
    const drifting = offset > 0 ? lateEvening : earlyMorning;
    assert.notEqual(dayKey(0, drifting), drifting.toISOString().slice(0, 10));
  }
});

test('request bears the key in a header and never in the query string', async () => {
  await request('/me', { apiKey: 'myeps_secret' });

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, `${API_BASE}/me`);
  assert.equal(init.method, 'GET');
  assert.equal(init.cache, 'no-store');
  assert.equal(init.headers.Authorization, 'Bearer myeps_secret');
  // The API refuses a key sent as a parameter with `credential_in_query`, so
  // this is a broken request and not only a leaked one.
  assert.ok(!url.includes('myeps_secret'), url);
  assert.ok(!url.includes('?'), url);
});

test('request drops the params a caller left unset and spells booleans 1/0', async () => {
  await request('/me/episodes', {
    apiKey: 'k',
    params: {
      from: '2026-09-07',
      show: undefined,
      to: null,
      order: '',
      include_pilots: true,
      include_ignored: false,
      offset: 0
    }
  });

  // A caller passes the optional ones unconditionally; only what was set
  // arrives. `offset: 0` is set, and so does.
  assert.deepEqual(
    [...query()],
    [
      ['from', '2026-09-07'],
      ['include_pilots', '1'],
      ['include_ignored', '0'],
      ['offset', '0']
    ]
  );
});

test('request sends a body as JSON when it is given one', async () => {
  await request('/me/episodes/1/2/3', { apiKey: 'k', method: 'PUT', body: { watched: true } });

  const { init } = calls[0];
  assert.equal(init.method, 'PUT');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), { watched: true });
});

test('request names every failure the API tells apart', async () => {
  const kinds = {
    400: 'invalid',
    401: 'auth',
    403: 'scope',
    404: 'notfound',
    422: 'refused',
    429: 'rate-limit',
    503: 'unavailable',
    418: 'http',
    500: 'http'
  };

  for (const [status, kind] of Object.entries(kinds)) {
    respond = () => fail(Number(status), {});
    await assert.rejects(request('/me', { apiKey: 'k' }), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.kind, kind, status);
      return true;
    });
  }
});

// The one distinction the API documents as deliberate: a 401 is a key to
// replace, a 403 is a scope to widen. Sending a read-only-key holder off to
// re-authenticate would have them fix a key that works.
test('request keeps a rejected key and a missing scope apart', async () => {
  respond = () => fail(401, {});
  const rejected = await request('/me', { apiKey: 'k' }).catch((error) => error);

  respond = () => fail(403, {});
  const unscoped = await request('/me', { apiKey: 'k' }).catch((error) => error);

  assert.equal(rejected.kind, 'auth');
  assert.equal(unscoped.kind, 'scope');
  assert.notEqual(rejected.message, unscoped.message);
  assert.match(rejected.message, /401/);
  assert.match(rejected.message, /replace/i);
  assert.match(unscoped.message, /403/);
  assert.match(unscoped.message, /scope/i);
  // Whatever else it says, it must not send someone off to replace a key that
  // works.
  assert.doesNotMatch(unscoped.message, /replace/i);
});

test('request prefers the API\'s own message', async () => {
  respond = () =>
    fail(400, { error: { code: 'invalid_parameter', message: '`from` must be YYYY-MM-DD.' } });

  await assert.rejects(request('/me/episodes', { apiKey: 'k' }), (error) => {
    // The API's message names the parameter at fault, which nothing here could
    // have guessed.
    assert.equal(error.message, '`from` must be YYYY-MM-DD.');
    assert.equal(error.kind, 'invalid');
    return true;
  });
});

test('request falls back to its own message when the body will not parse', async () => {
  respond = () => fail(500, undefined);
  await assert.rejects(request('/me', { apiKey: 'k' }), (error) => {
    assert.equal(error.kind, 'http');
    // Nothing to quote, so the message at least names the status.
    assert.match(error.message, /500/);
    return true;
  });

  // A status with guidance of its own keeps it: "replied with 401" would tell
  // the viewer nothing they can act on.
  respond = () => fail(401, undefined);
  await assert.rejects(request('/me', { apiKey: 'k' }), (error) => {
    assert.equal(error.kind, 'auth');
    assert.match(error.message, /replace/i);
    return true;
  });
});

test('request tells a dead network from a body it cannot read', async () => {
  respond = () => {
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(request('/me', { apiKey: 'k' }), (error) => {
    assert.equal(error.kind, 'network');
    return true;
  });

  respond = () => ({
    ok: true,
    status: 200,
    async text() {
      return '<html>not json at all</html>';
    }
  });
  await assert.rejects(request('/me', { apiKey: 'k' }), (error) => {
    assert.equal(error.kind, 'parse');
    return true;
  });
});

// The answer is already known, so the request is not worth the round trip.
test('request refuses a missing key without spending a request', async () => {
  for (const apiKey of ['', null, undefined]) {
    await assert.rejects(request('/me', { apiKey }), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.kind, 'auth');
      return true;
    });
  }

  await assert.rejects(request('/me'), (error) => {
    assert.equal(error.kind, 'auth');
    return true;
  });

  assert.equal(calls.length, 0);
});

test('fetchList asks for the documented maximum and stops where the flag does', async () => {
  respond = () => ok(page([{ showid: 1 }], false));

  const rows = await fetchList('/me/episodes', { apiKey: 'k' });

  assert.equal(calls.length, 1);
  assert.equal(query().get('limit'), '200');
  assert.equal(query().get('offset'), '0');
  assert.deepEqual(rows, [{ showid: 1 }]);
});

test('fetchList walks the pages and advances by the rows it was sent', async () => {
  const pages = [page([{ showid: 1 }, { showid: 2 }], true), page([{ showid: 3 }], false)];
  respond = () => ok(pages.shift());

  const rows = await fetchList('/me/episodes', { apiKey: 'k' });

  assert.deepEqual(rows, [{ showid: 1 }, { showid: 2 }, { showid: 3 }]);
  assert.equal(calls.length, 2);
  // Two rows arrived, so the second page starts at two -- not at the limit,
  // which is what a page the server trimmed would skip rows over.
  assert.equal(query(1).get('offset'), '2');
});

test('fetchList stops at maxPages however long the list claims to be', async () => {
  respond = () => ok(page([{ showid: 1 }], true));

  const rows = await fetchList('/me/episodes', { apiKey: 'k', maxPages: 3 });

  assert.equal(calls.length, 3);
  assert.equal(rows.length, 3);
});

// has_more with nothing in it would leave the offset where it was and ask for
// the same page until the popup was closed.
test('fetchList does not loop on a page that promises more and sends none', async () => {
  respond = () => ok({ data: [], meta: { limit: 200, offset: 0, has_more: true } });

  const rows = await fetchList('/me/episodes', { apiKey: 'k' });

  assert.deepEqual(rows, []);
  assert.equal(calls.length, 1);
});

test('fetchList takes a bare array or a missing meta as the whole answer', async () => {
  respond = () => ok([{ showid: 1 }, { showid: 2 }]);
  assert.deepEqual(await fetchList('/shows', { apiKey: 'k' }), [{ showid: 1 }, { showid: 2 }]);
  assert.equal(calls.length, 1);

  respond = () => ok({ data: [{ showid: 3 }] });
  assert.deepEqual(await fetchList('/shows', { apiKey: 'k' }), [{ showid: 3 }]);
  assert.equal(calls.length, 2);

  respond = () => ok({ meta: { has_more: false } });
  assert.deepEqual(await fetchList('/shows', { apiKey: 'k' }), []);
});

test('toEpisode reads the flat episode shape', () => {
  const item = toEpisode(FLAT);

  assert.equal(item.showid, 25262);
  assert.equal(item.season, 1);
  assert.equal(item.number, 1);
  assert.equal(item.episode, 'Pilot');
  assert.equal(item.code, 'S01E01');
  assert.equal(item.special, false);
  assert.equal(item.tvmazeEpisodeId, 3606548);
  assert.equal(item.tvmazeShowId, null);
  assert.equal(item.link, 'https://www.tvmaze.com/episodes/3606548');
  // Nothing names the show in this shape, and the tooltip drops the gap rather
  // than showing the dashes with nothing between them.
  assert.equal(item.show, '');
  assert.equal(item.network, '');
  assert.equal(item.rawTitle, 'S01E01 — Pilot');
});

test('toEpisode reads the same fields through a nested show', () => {
  const item = toEpisode(NESTED);

  assert.equal(item.show, 'Lanterns');
  assert.equal(item.showid, 25262);
  assert.equal(item.network, 'HBO');
  // Both ids are external.tvmaze, one nesting apart: the show's is the show's
  // and the episode's is the episode's.
  assert.equal(item.tvmazeShowId, 44776);
  assert.equal(item.tvmazeEpisodeId, 3606548);
  assert.equal(item.rawTitle, 'Lanterns — S01E01 — Pilot');
});

test('toEpisode carries the flags that retired the second request', () => {
  const marked = toEpisode({ ...NESTED, acquired: true, watched: true });
  assert.equal(marked.acquired, true);
  assert.equal(marked.watched, true);

  const unmarked = toEpisode({ ...NESTED, acquired: false, watched: false });
  assert.equal(unmarked.acquired, false);
  assert.equal(unmarked.watched, false);

  // No flags at all reads as unmarked rather than as undefined, so a row the
  // API filled in no further than the episode is still one a card can paint.
  const bare = toEpisode(NESTED);
  assert.equal(bare.acquired, false);
  assert.equal(bare.watched, false);
});

// Only part of the item shape is documented, so a row missing any of it has to
// come back renderable rather than throwing on the way to a card.
test('toEpisode survives a row with nothing in it', () => {
  for (const raw of [{}, null, undefined, { show: {} }, { show: 'Lanterns' }]) {
    const item = toEpisode(raw);
    assert.equal(item.code, '');
    assert.equal(item.season, null);
    assert.equal(item.number, null);
    assert.equal(item.airTime, null);
    assert.equal(item.tvmazeEpisodeId, null);
    assert.equal(item.link, 'https://www.myepisodes.com/');
    assert.equal(item.rawTitle, '');
  }
});

// utc_airdate is an absolute instant, which is the whole reason it is preferred:
// it can be shown in the viewer's timezone. It is not ISO-8601 though, so it
// only means UTC if it is parsed as UTC.
test('toEpisode takes the air time from utc_airdate as an instant', () => {
  const instant = new Date(Date.UTC(2026, 7, 17, 3, 0, 0));
  const expected = { hours: instant.getHours(), minutes: instant.getMinutes() };

  assert.deepEqual(toEpisode({ utc_airdate: '2026-08-17 03:00:00' }).airTime, expected);
  // The show-local wall clock is only the fallback, so the instant wins here.
  assert.deepEqual(toEpisode(FLAT).airTime, expected);

  // Read as local, 03:00 would have stayed 03:00 -- which off UTC is the wrong
  // clock, and in New York the wrong day as well.
  if (instant.getTimezoneOffset() !== 0) {
    assert.notDeepEqual(expected, { hours: 3, minutes: 0 });
  }
});

test('toEpisode falls back to the show-local airtime', () => {
  assert.deepEqual(toEpisode({ airtime: '21:00:00' }).airTime, { hours: 21, minutes: 0 });
  assert.deepEqual(toEpisode({ airtime: '9:05' }).airTime, { hours: 9, minutes: 5 });
  // An unreadable instant is not a reason to lose the wall clock beside it.
  assert.deepEqual(toEpisode({ utc_airdate: 'soon', airtime: '21:00:00' }).airTime, {
    hours: 21,
    minutes: 0
  });
});

// The feed had to throw midnight away: its date fields read as 00:00 whenever
// the clock was unset. The API sends no airtime at all in that case, so
// midnight here is a broadcast time and is kept.
test('toEpisode keeps a midnight broadcast', () => {
  assert.deepEqual(toEpisode({ airtime: '00:00:00' }).airTime, { hours: 0, minutes: 0 });
  assert.deepEqual(toEpisode({ airtime: '00:00' }).airTime, { hours: 0, minutes: 0 });
});

test('toEpisode leaves an absent or impossible air time null', () => {
  for (const airtime of [undefined, null, '', 'unknown', '2026-08-17', '25:00:00', '21:60']) {
    assert.equal(toEpisode({ airtime }).airTime, null, String(airtime));
  }
  for (const utc of ['', 'not a date', '2026-13-45 99:99:99']) {
    assert.equal(toEpisode({ utc_airdate: utc }).airTime, null, utc);
  }
});

test('toEpisode pads a code without truncating a daily show', () => {
  assert.equal(toEpisode({ season: 1, episode: 4 }).code, 'S01E04');
  assert.equal(toEpisode({ season: 1, episode: 172 }).code, 'S01E172');
  // Daily shows number by year, so the season runs to four digits.
  assert.equal(toEpisode({ season: 2026, episode: 172 }).code, 'S2026E172');
  // Season 0 is where specials live, and 0 is a number rather than an absence.
  assert.equal(toEpisode({ season: 0, episode: 0 }).code, 'S00E00');
  assert.equal(toEpisode({ season: 1 }).code, '');
  assert.equal(toEpisode({ episode: 4 }).code, '');
});

test('toEpisode links to TVmaze when it can and to MyEpisodes when it cannot', () => {
  assert.equal(
    toEpisode({ external: { tvmaze: 3606548 } }).link,
    'https://www.tvmaze.com/episodes/3606548'
  );

  // The API's show url is site-relative, and "" when the show has no page.
  assert.equal(
    toEpisode({ show: { url: '/Greys_Anatomy' } }).link,
    'https://www.myepisodes.com/Greys_Anatomy'
  );
  assert.equal(toEpisode({ show: { url: '' } }).link, 'https://www.myepisodes.com/');
  assert.equal(toEpisode({ show: { showname: 'Lanterns' } }).link, 'https://www.myepisodes.com/');

  // A TVmaze id on the episode beats the show's page, which is what the feed's
  // own links pointed at.
  assert.equal(toEpisode(NESTED).link, 'https://www.tvmaze.com/episodes/3606548');
});

test('fetchEpisodes asks for the window unfiltered, with no status', async () => {
  respond = () => ok(page([NESTED], false));

  const items = await fetchEpisodes({ apiKey: 'k', from: '2026-09-07', to: '2026-09-07' });

  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, `${API_BASE}/me/episodes`);
  assert.equal(url.searchParams.get('from'), '2026-09-07');
  assert.equal(url.searchParams.get('to'), '2026-09-07');
  assert.equal(url.searchParams.get('date_basis'), 'local');
  assert.equal(url.searchParams.get('order'), 'asc');
  assert.equal(url.searchParams.get('limit'), '200');
  // The point of the migration: the whole list, flagged, in one request. A
  // `status` here would filter out exactly the rows the second feed request
  // used to be needed to identify.
  assert.ok(!url.searchParams.has('status'));

  assert.equal(items.length, 1);
  assert.equal(items[0].show, 'Lanterns');
  assert.equal(items[0].code, 'S01E01');
});

test('fetchEpisodes sends both include flags either way', async () => {
  await fetchEpisodes({ apiKey: 'k', from: '2026-09-07', to: '2026-09-07' });
  assert.equal(query().get('include_pilots'), '0');
  assert.equal(query().get('include_ignored'), '0');

  // Sent even when false so a setting saved on the website cannot decide what
  // a tab shows.
  await fetchEpisodes({
    apiKey: 'k',
    from: '2026-09-07',
    to: '2026-09-07',
    includePilots: true,
    includeIgnored: true
  });
  assert.equal(query(1).get('include_pilots'), '1');
  assert.equal(query(1).get('include_ignored'), '1');
});

test('fetchAccount reads the bare resource the Test button needs', async () => {
  respond = () => ok({ username: 'ziv', timezone: 'Asia/Jerusalem', shows: 42 });

  const account = await fetchAccount({ apiKey: 'k' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${API_BASE}/me`);
  // A single resource arrives with no envelope around it.
  assert.equal(account.username, 'ziv');
  assert.equal(account.shows, 42);
});

test('an empty body on a success is an answer, not a parse failure', async () => {
  // A PUT that worked has nothing to say and says it with 204 and no bytes.
  // Reading that as a broken response made every successful mark report itself
  // as one -- see lib/marks.js, which has no body to read either way.
  respond = () => okEmpty();
  assert.equal(await request('/me/episodes/1/1/1', { apiKey: 'k', method: 'PUT', body: { watched: true } }), null);

  // A 200 whose body is whitespace only counts the same way.
  respond = () => ({ ok: true, status: 200, async text() { return '   \n'; } });
  assert.equal(await request('/me', { apiKey: 'k' }), null);
});

test('a body that is present but unparseable is still a parse failure', async () => {
  respond = () => ({ ok: true, status: 200, async text() { return '{"data":'; } });
  await assert.rejects(request('/me', { apiKey: 'k' }), (error) => {
    assert.equal(error.kind, 'parse');
    return true;
  });
});

// A verbatim row from a live GET /v1/me/episodes, which is the shape that
// actually arrives -- flat, with no nested `show` object, no `network`, and its
// times under names the published docs never mention.
const LIVE_ROW = {
  showid: 25262,
  showname: 'Lanterns',
  url: '',
  season: 1,
  episode: 4,
  name: 'The Weenie',
  airdate: '2026-09-06',
  airtime: '21:00:00',
  show_timezone: 'America/New_York',
  local_airdate: '2026-09-07 04:00:00.000000',
  worldtime: false,
  stored_utc_airdate: '2026-09-07 04:00:00',
  airdate_disputed: true,
  following: true,
  ignored: false,
  acquired: false,
  watched: false,
  external: { tvmaze: 3695362 }
};

test('toEpisode reads the live /me/episodes row', () => {
  const item = toEpisode(LIVE_ROW);

  assert.equal(item.showid, 25262);
  assert.equal(item.show, 'Lanterns');
  assert.equal(item.episode, 'The Weenie');
  assert.equal(item.code, 'S01E04');
  assert.equal(item.season, 1);
  assert.equal(item.number, 4);
  assert.equal(item.tvmazeEpisodeId, 3695362);
  assert.equal(item.acquired, false);
  assert.equal(item.watched, false);
  // No network of any spelling arrives, so the chip is TVmaze's job.
  assert.equal(item.network, '');
  // `url` is "" here, so the link falls through to the TVmaze episode page.
  assert.equal(item.link, 'https://www.tvmaze.com/episodes/3695362');
});

// The row that proves the point: it airs on the 6th in New York but comes back
// inside the window asked for the 7th, because date_basis=local files it by
// local_airdate. The clock on the card has to be the one that agrees with the
// heading it sits under.
test('the card clock comes from local_airdate, not the show airtime', () => {
  const item = toEpisode(LIVE_ROW);

  // 04:00 off local_airdate, and not the 21:00 the show's own airtime says --
  // the row carries both, which is what makes it the row worth pinning.
  assert.deepEqual(item.airTime, { hours: 4, minutes: 0 });
});

// local_airdate is already in the account's timezone, so it must be read as a
// wall clock. Putting it through Date and then reading local getters would
// convert an already-converted time, and the error would be invisible on a
// machine set to UTC -- so this pins the value itself.
test('local_airdate is read as a wall clock and never reconverted', () => {
  assert.deepEqual(toEpisode({ local_airdate: '2026-09-07 04:00:00.000000' }).airTime, {
    hours: 4,
    minutes: 0
  });
  assert.deepEqual(toEpisode({ local_airdate: '2026-09-07T23:45:00' }).airTime, {
    hours: 23,
    minutes: 45
  });
  // The date half must not be mistaken for a clock.
  assert.deepEqual(toEpisode({ local_airdate: '2026-09-07' }).airTime, null);
});

test('the time falls back through stored_utc_airdate to the show airtime', () => {
  // An instant, so this one is converted into the viewer's zone.
  const utc = new Date('2026-09-07T04:00:00Z');
  assert.deepEqual(toEpisode({ stored_utc_airdate: '2026-09-07 04:00:00' }).airTime, {
    hours: utc.getHours(),
    minutes: utc.getMinutes()
  });

  // Last resort: the show's own wall clock, in the show's own zone.
  assert.deepEqual(toEpisode({ airtime: '21:00:00' }).airTime, { hours: 21, minutes: 0 });
  assert.equal(toEpisode({}).airTime, null);
});

// This Week covers Monday through Sunday of the week today falls in. getDay()
// counts from Sunday, so the rotation onto a Monday-first week is the whole of
// what these pin -- and every day of one week has to answer with that same week.
test('weekOffsets puts Monday at 0 and Sunday at 6', () => {
  // 7 Sep 2026 is a Monday, so this walks one full week day by day.
  const expected = [
    ['2026-09-07', 'Mon', 0, 6],
    ['2026-09-08', 'Tue', -1, 5],
    ['2026-09-09', 'Wed', -2, 4],
    ['2026-09-10', 'Thu', -3, 3],
    ['2026-09-11', 'Fri', -4, 2],
    ['2026-09-12', 'Sat', -5, 1],
    ['2026-09-13', 'Sun', -6, 0]
  ];

  for (const [date, label, first, last] of expected) {
    const [y, m, d] = date.split('-').map(Number);
    const now = new Date(y, m - 1, d, 12, 0);
    assert.deepEqual(weekOffsets(now), { first, last }, `${date} (${label})`);
  }
});

// The point of weekOffsets being one function: the window the tab fetches and
// the range its heading prints are the same seven days. Every day of the week
// has to produce an identical window, or "this week" would mean something
// different depending on when the popup was opened.
test('weekRange is the same Mon-Sun window from any day inside it', () => {
  const windows = new Set();
  for (let day = 7; day <= 13; day += 1) {
    const { from, to } = weekRange(new Date(2026, 8, day, 12, 0));
    windows.add(`${from}..${to}`);
  }
  assert.deepEqual([...windows], ['2026-09-07..2026-09-13']);
});

test('weekRange is exactly seven days wide', () => {
  const { from, to } = weekRange(new Date(2026, 8, 10, 12, 0));
  const span = (new Date(to) - new Date(from)) / 86_400_000;
  assert.equal(span, 6, 'inclusive of both ends, so six days apart');
});

// setDate-style arithmetic through the Date constructor, so a week that steps
// off the end of a month or a year lands where the calendar says rather than
// wrapping inside the month.
test('weekRange crosses month and year ends', () => {
  // Thu 31 Dec 2026 -> Mon 28 Dec through Sun 3 Jan.
  assert.deepEqual(weekRange(new Date(2026, 11, 31, 12, 0)), {
    from: '2026-12-28',
    to: '2027-01-03'
  });
  // Thu 1 Jan 2026 -> the week opens in the previous year.
  assert.deepEqual(weekRange(new Date(2026, 0, 1, 12, 0)), {
    from: '2025-12-29',
    to: '2026-01-04'
  });
  // Sun 1 Mar 2026 -> the week opens in February.
  assert.deepEqual(weekRange(new Date(2026, 2, 1, 12, 0)), {
    from: '2026-02-23',
    to: '2026-03-01'
  });
});

// A week is asked for exactly the way a day is, which is what let the popup's
// four tabs collapse onto one request shape.
test('fetchEpisodes takes a week window like any other', async () => {
  respond = () => ok(page([], false));
  const { from, to } = weekRange(new Date(2026, 8, 10, 12, 0));
  await fetchEpisodes({ apiKey: 'k', from, to });

  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('from'), '2026-09-07');
  assert.equal(url.searchParams.get('to'), '2026-09-13');
  assert.equal(url.searchParams.get('date_basis'), 'local');
  assert.equal(url.searchParams.get('status'), null);
});

// A week can hold more episodes than the API will put in one page, which a
// single day never could -- so this is the tab that makes the paging real.
test('a week longer than one page is fetched whole', async () => {
  const row = (n) => ({ showid: n, showname: `Show ${n}`, season: 1, episode: 1 });
  let sent = 0;
  respond = () => {
    sent += 1;
    return ok(page(Array.from({ length: sent === 1 ? 200 : 30 }, (_, i) => row(i)), sent === 1));
  };

  const { from, to } = weekRange(new Date(2026, 8, 10, 12, 0));
  const items = await fetchEpisodes({ apiKey: 'k', from, to });

  assert.equal(items.length, 230);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1].url).searchParams.get('offset'), '200');
});

// HOME_PAGE is a page to navigate to and the origin it is built from is a
// prefix to join paths onto. Collapsing the two once dropped the trailing slash
// off every linkless card's fallback, so the shape is pinned here.
test('HOME_PAGE is the site root, slash and all', () => {
  assert.equal(HOME_PAGE, 'https://www.myepisodes.com/');
  assert.equal(toEpisode({ showid: 1, season: 1, episode: 1 }).link, HOME_PAGE);
  // A relative show path joins on without doubling the slash.
  assert.equal(
    toEpisode({ showid: 1, season: 1, episode: 1, url: '/Lanterns' }).link,
    'https://www.myepisodes.com/Lanterns'
  );
});
