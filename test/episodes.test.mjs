// The item logic the popup runs on. None of it touches the DOM, which is the
// reason it lives in lib/ rather than in popup.js.
//
// It used to be asserted mostly as one property -- that an item from either of
// two sources resolved to the same episode -- because Yesterday, Today and
// Tomorrow came from api.myepisodes.com while All Today came from rss.php.
// This Week replaced that tab with a fourth API window, so there is one item
// shape and that property is now trivially true.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  byAirTime,
  clockMinutes,
  describeNumbering,
  episodeKey,
  episodeTarget,
  episodeUrl,
  isPremiere,
  sameDay
} from '../lib/episodes.js';

// Every item comes from `/v1/me/episodes` now, so there is one shape to read.
// This used to be the interesting test in the file: All Today came from rss.php
// and packed the same triple into a <guid>, and the two spellings had to resolve
// to one identity or a mark set on Today would go unrecognised there.
test('episodeTarget reads the triple off an item', () => {
  assert.deepEqual(episodeTarget({ showid: 31519, season: 1, number: 5, show: 'Lanterns' }), {
    showid: 31519,
    season: 1,
    episode: 5
  });
});

// Season 0 is where specials live and episode 0 is a real number, so neither
// may read as an absence.
test('episodeTarget keeps a zero season or episode', () => {
  assert.deepEqual(episodeTarget({ showid: 31519, season: 0, number: 0 }), {
    showid: 31519,
    season: 0,
    episode: 0
  });
});

test('episodeTarget turns down an item that names no episode', () => {
  assert.equal(episodeTarget({ show: 'Lanterns', code: 'S01E03' }), null);
  assert.equal(episodeTarget({}), null);
  assert.equal(episodeTarget(null), null);
  assert.equal(episodeTarget(undefined), null);
});

// A code the parser could not take apart leaves season and number null
// together, and an API row can arrive that way with its showid intact. Two of
// the three numbers is not an address.
test('episodeTarget turns down a show id with no numbering beside it', () => {
  assert.equal(episodeTarget({ showid: 31519, season: null, number: null }), null);
  assert.equal(episodeTarget({ showid: 31519, season: 1, number: null }), null);
  assert.equal(episodeTarget({ showid: 31519, season: null, number: 5 }), null);
});

test('episodeKey names an episode by its triple', () => {
  assert.equal(episodeKey({ showid: 44776, season: 1, number: 3, show: 'Lanterns' }), '44776|1|3');
});

// Four tabs share one marks map, and This Week overlaps all three day tabs by
// construction -- so the same episode really does get keyed twice in one popup,
// and a mark set on Today has to be the mark This Week shows.
test('episodeKey falls back to the show and code together', () => {
  assert.equal(episodeKey({ show: 'Lanterns', code: 'S01E03' }), 'Lanterns|S01E03');
  // The same episode reached from two tabs is the same key either way, which is
  // what lets one marks map serve overlapping windows.
  assert.equal(
    episodeKey({ showid: 44776, season: 1, number: 3 }),
    episodeKey({ showid: 44776, season: 1, number: 3, show: 'Lanterns', code: 'S01E03' })
  );
});

test('episodeKey tells two episodes of one show apart', () => {
  const third = episodeKey({ show: 'Lanterns', code: 'S01E03' });
  const fourth = episodeKey({ show: 'Lanterns', code: 'S01E04' });
  assert.notEqual(third, fourth);
});


test('clockMinutes reads a time, and sorts an absent one last', () => {
  assert.equal(clockMinutes({ airTime: { hours: 21, minutes: 30 } }), 21 * 60 + 30);
  assert.equal(clockMinutes({ airTime: { hours: 0, minutes: 0 } }), 0);
  assert.equal(clockMinutes({}), Infinity);
});

test('byAirTime runs a day in broadcast order', () => {
  const items = [
    { show: 'C', airTime: { hours: 22, minutes: 0 } },
    { show: 'A', airTime: { hours: 9, minutes: 5 } },
    { show: 'B', airTime: { hours: 9, minutes: 30 } }
  ];
  assert.deepEqual(byAirTime(items).map((item) => item.show), ['A', 'B', 'C']);
});

// Infinity - Infinity is NaN, which would leave the sort with no answer at all
// and the untimed episodes in whatever order the engine happened to leave them.
test('byAirTime keeps untimed episodes last, in the order they arrived', () => {
  const items = [
    { show: 'no-time-1' },
    { show: 'timed', airTime: { hours: 20, minutes: 0 } },
    { show: 'no-time-2' },
    { show: 'no-time-3' }
  ];
  assert.deepEqual(byAirTime(items).map((item) => item.show), [
    'timed',
    'no-time-1',
    'no-time-2',
    'no-time-3'
  ]);
});

test('byAirTime leaves the list it was given alone', () => {
  const items = [{ show: 'B', airTime: { hours: 22, minutes: 0 } }, { show: 'A' }];
  const order = items.map((item) => item.show);
  byAirTime(items);
  assert.deepEqual(items.map((item) => item.show), order);
});

// A refresh that brings back the day already on screen must not re-render it:
// rebuilding an identical list costs every card its poster and the reader a
// flicker.
test('sameDay recognises the day already on screen', () => {
  const day = [{ show: 'A', code: 'S01E01' }, { show: 'B', code: 'S02E03' }];
  assert.ok(sameDay(day, structuredClone(day)));
});

test('sameDay notices anything that actually changed', () => {
  const day = [{ show: 'A', code: 'S01E01' }];
  assert.ok(!sameDay(day, [{ show: 'A', code: 'S01E02' }]));
  assert.ok(!sameDay(day, [...day, { show: 'B', code: 'S01E01' }]));
  assert.ok(!sameDay(day, []));
  // An episode marked acquired since the last fetch is a change worth redrawing.
  assert.ok(!sameDay(day, [{ show: 'A', code: 'S01E01', acquired: true }]));
});

test('sameDay calls two empty days the same', () => {
  assert.ok(sameDay([], []));
});

test('episodeUrl passes a web link straight through', () => {
  const link = 'https://www.tvmaze.com/episodes/3695361/lanterns-1x03-outkast';
  assert.equal(episodeUrl(link), link);
  assert.equal(episodeUrl('http://www.myepisodes.com/x'), 'http://www.myepisodes.com/x');
});

// The link arrives in the feed, so anything odd goes to the site's front page
// rather than onto the card.
test('episodeUrl turns down a scheme that is not the web', () => {
  const home = 'https://www.myepisodes.com/';
  assert.equal(episodeUrl('javascript:alert(1)'), home);
  assert.equal(episodeUrl('data:text/html,<script>alert(1)</script>'), home);
  assert.equal(episodeUrl('file:///etc/passwd'), home);
  assert.equal(episodeUrl('not a url'), home);
  assert.equal(episodeUrl(''), home);
  assert.equal(episodeUrl(undefined), home);
});

test('describeNumbering spells a code out in words', () => {
  assert.equal(describeNumbering({ season: 1, number: 4, code: 'S01E04' }), 'Season 1 · Episode 4');
  assert.equal(
    describeNumbering({ season: 2026, number: 172, code: 'S2026E172' }),
    'Season 2026 · Episode 172'
  );
});

// A code we could not take apart is shown as it arrived rather than dropped.
test('describeNumbering falls back to the raw code, or to nothing', () => {
  assert.equal(describeNumbering({ season: null, number: null, code: 'Special' }), 'Special');
  assert.equal(describeNumbering({ season: 1, number: null, code: 'S01' }), 'S01');
  assert.equal(describeNumbering({ season: null, number: null, code: '' }), '');
});

test('isPremiere marks the first episode of the first season', () => {
  assert.equal(isPremiere({ season: 1, number: 1, code: 'S01E01' }), true);
});

test('isPremiere passes over the rest of the run', () => {
  assert.equal(isPremiere({ season: 1, number: 2, code: 'S01E02' }), false);
  assert.equal(isPremiere({ season: 2, number: 1, code: 'S02E01' }), false);
  assert.equal(isPremiere({ season: 11, number: 11, code: 'S11E11' }), false);
});

// Daily shows number themselves by year rather than by season, so the first
// episode of one is not the first episode of anything.
test('isPremiere is not fooled by a daily show', () => {
  assert.equal(isPremiere({ season: 2026, number: 1, code: 'S2026E01' }), false);
});

// A code the parser could not take apart leaves both numbers null, which is no
// answer rather than a first episode.
// The API sends `special` and the feed does not, so both readings have to be
// right: a special numbered S01E01 is an extra, not a series starting, while a
// feed item that never carries the field must not be ruled out for missing it.
test('isPremiere passes over a special numbered like a premiere', () => {
  assert.equal(isPremiere({ season: 1, number: 1, code: 'S01E01', special: true }), false);
  assert.equal(isPremiere({ season: 1, number: 1, code: 'S01E01', special: false }), true);
  assert.equal(isPremiere({ season: 1, number: 1, code: 'S01E01' }), true);
});

test('isPremiere needs both numbers to say yes', () => {
  assert.equal(isPremiere({ season: null, number: null, code: 'Special' }), false);
  assert.equal(isPremiere({ season: 1, number: null, code: 'S01' }), false);
  assert.equal(isPremiere({ season: null, number: 1, code: '' }), false);
});
