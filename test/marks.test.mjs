// lib/marks.js writes through lib/api.js now rather than calling fetch itself,
// so fetch is still the only global stood up here -- one layer further down.
//
// Two halves: nextMark, which is pure and says how a click on one pill moves
// the other, and setMark, which is the request and the sentence a failure
// leaves on the card.

import test from 'node:test';
import assert from 'node:assert/strict';

let calls = [];
let respond = () => okEmpty();

globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  return respond(url, init);
};

const { MarkError, nextMark, setMark } = await import('../lib/marks.js');

// lib/api.js reads a body with text() and parses it itself, so a stub that only
// answers json() is never consulted. These mirror test/api.test.mjs.
//
// A PUT that worked is 204 with no bytes, which is the realistic success here:
// reading that as a parse failure once made every saved mark report itself as
// broken.
function okEmpty(status = 204) {
  return {
    ok: true,
    status,
    async text() {
      return '';
    }
  };
}

// `body` left undefined stands for bytes that will not parse -- a proxy's error
// page, say -- which is when the message has only the status to go on.
function fail(status, body, headers = {}) {
  return {
    ok: false,
    status,
    headers: { get: (key) => headers[key] ?? null },
    async text() {
      return body === undefined ? '<html>go away</html>' : JSON.stringify(body);
    }
  };
}

const EPISODE = { showid: 31519, season: 1, episode: 5 };

test.beforeEach(() => {
  calls = [];
  respond = () => okEmpty();
});

test('marking watched acquires the episode too', () => {
  assert.deepEqual(nextMark({ acquired: false, watched: false }, 'watched'), {
    acquired: true,
    watched: true
  });
  assert.deepEqual(nextMark({ acquired: true, watched: false }, 'watched'), {
    acquired: true,
    watched: true
  });
});

// The file is still on disk, so the true state after un-watching is acquired
// and unwatched -- not unmarked.
test('un-watching leaves the episode acquired', () => {
  assert.deepEqual(nextMark({ acquired: true, watched: true }, 'watched'), {
    acquired: true,
    watched: false
  });
});

test('acquiring an episode leaves watched where it was', () => {
  assert.deepEqual(nextMark({ acquired: false, watched: false }, 'acquired'), {
    acquired: true,
    watched: false
  });
  // Watched implies acquired, so this pair cannot arrive from the API -- but a
  // click on acquired must not throw the watched flag away if it does.
  assert.deepEqual(nextMark({ acquired: false, watched: true }, 'acquired'), {
    acquired: true,
    watched: true
  });
});

// Clearing acquired deletes the episode's row outright, so watched goes with
// it. { acquired: false, watched: true } is a 422 rather than a state.
test('un-acquiring clears watched along with it', () => {
  assert.deepEqual(nextMark({ acquired: true, watched: true }, 'acquired'), {
    acquired: false,
    watched: false
  });
  assert.deepEqual(nextMark({ acquired: true, watched: false }, 'acquired'), {
    acquired: false,
    watched: false
  });
});

// The counter-intuitive one, and the reason popup.js restores a snapshot on a
// failed request instead of flipping a second time: because un-acquiring
// clears watched, flipping acquired twice does not land back where it started.
test('flipping a mark twice does not undo it', () => {
  const start = { acquired: true, watched: true };
  const once = nextMark(start, 'acquired');
  const twice = nextMark(once, 'acquired');

  assert.deepEqual(twice, { acquired: true, watched: false });
  assert.notDeepEqual(twice, start);

  // Watched is its own inverse from an acquired episode, which is what makes
  // acquired the asymmetric one rather than nextMark being sloppy.
  const watchedTwice = nextMark(nextMark({ acquired: true, watched: false }, 'watched'), 'watched');
  assert.deepEqual(watchedTwice, { acquired: true, watched: false });
});

test('nextMark leaves the state it was handed alone', () => {
  const current = { acquired: true, watched: true };
  nextMark(current, 'acquired');
  nextMark(current, 'watched');
  assert.deepEqual(current, { acquired: true, watched: true });
});

test('setMark PUTs the mark to the episode\'s own URL, bearing the API key', async () => {
  await setMark(EPISODE, 'watched', true, 'token123');

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.myepisodes.com/v1/me/episodes/31519/1/5');
  assert.equal(init.method, 'PUT');
  assert.equal(init.headers.Authorization, 'Bearer token123');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), { watched: true });
  // The key goes in the header and nowhere else.
  assert.ok(!url.includes('token123'), url);
});

// One field, so the other stays exactly as MyEpisodes has it and the coupling
// nextMark mirrors happens server-side, where it is defined. Sending both is
// the request the API refuses.
test('setMark sends only the field it was asked to set', async () => {
  await setMark({ showid: 1, season: 2, episode: 3 }, 'acquired', false, 'k');
  assert.deepEqual(JSON.parse(calls[0].init.body), { acquired: false });

  await setMark({ showid: 1, season: 2, episode: 3 }, 'watched', false, 'k');
  assert.deepEqual(JSON.parse(calls[1].init.body), { watched: false });
});

// 204 with no body is what success looks like, and it has to read as one.
test('setMark takes an empty 204 as a saved mark', async () => {
  respond = () => okEmpty();
  assert.equal(await setMark(EPISODE, 'watched', true, 'k'), undefined);
  assert.equal(calls.length, 1);
});

test('setMark names every failure the API tells apart', async () => {
  const kinds = {
    401: 'auth',
    403: 'scope',
    422: 'refused',
    404: 'notfound',
    429: 'rate-limit',
    500: 'http',
    418: 'http'
  };

  for (const [status, kind] of Object.entries(kinds)) {
    respond = () => fail(Number(status), {});
    await assert.rejects(setMark(EPISODE, 'watched', true, 'k'), (error) => {
      assert.ok(error instanceof MarkError);
      assert.equal(error.kind, kind, status);
      return true;
    });
  }
});

test('setMark reports a dead network as one', async () => {
  respond = () => {
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(setMark(EPISODE, 'watched', true, 'k'), (error) => {
    assert.ok(error instanceof MarkError);
    assert.equal(error.kind, 'network');
    assert.match(error.message, /reach api\.myepisodes\.com/i);
    return true;
  });
});

// A 403 means the key is real and only too narrow. Sending its holder off to
// replace or re-authenticate it would point them at the part that works, so
// the message has to name the scope and nothing else.
test('setMark tells a rejected key from one that only lacks write scope', async () => {
  respond = () => fail(401, {});
  const rejected = await setMark(EPISODE, 'watched', true, 'k').catch((error) => error);

  respond = () => fail(403, {});
  const unscoped = await setMark(EPISODE, 'watched', true, 'k').catch((error) => error);

  assert.equal(rejected.kind, 'auth');
  assert.equal(unscoped.kind, 'scope');
  assert.notEqual(rejected.message, unscoped.message);
  assert.match(unscoped.message, /write scope/i);
  assert.doesNotMatch(unscoped.message, /replace|re-?authenticate|new key|sign in/i);
});

// 422 is the API refusing a combination rather than doubting the key, and it
// is the one the popup can explain better than a bare status can.
test('setMark says what a refused combination was', async () => {
  respond = () => fail(422, {});
  await assert.rejects(setMark(EPISODE, 'acquired', false, 'k'), (error) => {
    assert.equal(error.kind, 'refused');
    assert.match(error.message, /combination of marks/i);
    return true;
  });
});

// Wherever the popup has nothing better to say, the API's own message stands:
// it is written for a person and names what is actually wrong.
test('setMark keeps the API\'s own message where it has none of its own', async () => {
  respond = () => fail(429, { error: { code: 'rate_limited', message: 'Too many requests.' } });
  await assert.rejects(setMark(EPISODE, 'watched', true, 'k'), (error) => {
    assert.equal(error.kind, 'rate-limit');
    assert.equal(error.message, 'Too many requests.');
    return true;
  });

  // And a status with no readable body at least names itself.
  respond = () => fail(500, undefined);
  await assert.rejects(setMark(EPISODE, 'watched', true, 'k'), (error) => {
    assert.equal(error.kind, 'http');
    assert.match(error.message, /500/);
    return true;
  });
});

// No key is an answer already known, so it costs no request -- and it still
// arrives as a MarkError, which is the only kind the card knows how to show.
test('setMark reports a missing key without spending a request', async () => {
  await assert.rejects(setMark(EPISODE, 'watched', true, ''), (error) => {
    assert.ok(error instanceof MarkError);
    assert.equal(error.kind, 'auth');
    return true;
  });
  assert.equal(calls.length, 0);
});
