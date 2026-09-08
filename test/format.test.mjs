// The strings and colours a card wears. The two clocks take an explicit "now"
// so these can stand somewhere other than the moment they run.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  avatarGradient,
  dayFor,
  episodeNoun,
  formatDate,
  formatDateRange,
  formatTime,
  initials,
  relativeTime
} from '../lib/format.js';

test('relativeTime rounds a fresh timestamp down to "just now"', () => {
  const now = Date.now();
  assert.equal(relativeTime(now, now), 'just now');
  assert.equal(relativeTime(now - 20_000, now), 'just now');
});

test('relativeTime counts minutes, then hours', () => {
  const now = Date.now();
  assert.equal(relativeTime(now - 5 * 60_000, now), '5m ago');
  assert.equal(relativeTime(now - 59 * 60_000, now), '59m ago');
  assert.equal(relativeTime(now - 60 * 60_000, now), '1h ago');
  assert.equal(relativeTime(now - 200 * 60_000, now), '3h ago');
});

// A clock that moved backwards under a stored entry would otherwise read as a
// negative age. "just now" is the harmless answer.
test('relativeTime does not go negative', () => {
  const now = Date.now();
  assert.equal(relativeTime(now + 60_000, now), 'just now');
});

test('dayFor walks the offset a tab covers', () => {
  const from = new Date(2026, 7, 31);
  assert.equal(dayFor(0, from).getDate(), 31);
  assert.equal(dayFor(1, from).getDate(), 1);
  assert.equal(dayFor(1, from).getMonth(), 8);
  assert.equal(dayFor(-1, from).getDate(), 30);
});

test('dayFor carries across a year end', () => {
  const from = new Date(2026, 11, 31);
  const tomorrow = dayFor(1, from);
  assert.equal(tomorrow.getFullYear(), 2027);
  assert.equal(tomorrow.getMonth(), 0);
  assert.equal(tomorrow.getDate(), 1);
});

test('dayFor leaves the date it was given alone', () => {
  const from = new Date(2026, 7, 31);
  dayFor(1, from);
  assert.equal(from.getDate(), 31);
});

test('episodeNoun agrees with its number', () => {
  assert.equal(episodeNoun(0), 'episodes');
  assert.equal(episodeNoun(1), 'episode');
  assert.equal(episodeNoun(2), 'episodes');
});

// The clock is handed over as two numbers rather than as an instant to be
// shifted, so whatever the locale prints has to carry both of them.
test('formatTime prints the hour and minute it was given', () => {
  const evening = formatTime({ hours: 21, minutes: 5 });
  assert.match(evening, /\b(21|9)\b/);
  assert.match(evening, /05/);
  assert.match(formatTime({ hours: 0, minutes: 0 }), /\b(00|0|12)\b/);
});

test('formatDate names the weekday and the day', () => {
  const printed = formatDate(new Date(2026, 7, 31));
  assert.match(printed, /31/);
  assert.ok(printed.length > 5);
});

test('initials take the first letter of the first two words', () => {
  assert.equal(initials('Anna Pigeon'), 'AP');
  assert.equal(initials('Breaking Bad Habits'), 'BB');
});

// A leading article says nothing about which show this is, so it is skipped --
// otherwise half a watchlist would wear the same two letters.
test('initials skip a leading article', () => {
  assert.equal(initials('The Five'), 'FI');
  assert.equal(initials('The Anna Pigeon Show'), 'AP');
  assert.equal(initials('A Discovery of Witches'), 'DO');
  // Only as an article, not as the start of a word.
  assert.equal(initials('Theodore'), 'TH');
});

test('initials take two letters from a single word', () => {
  assert.equal(initials('Lanterns'), 'LA');
  assert.equal(initials('X'), 'X');
});

test('initials split on the punctuation a title uses', () => {
  assert.equal(initials('Law & Order: SVU'), 'L&');
  assert.equal(initials('Star-Crossed'), 'SC');
  assert.equal(initials('some_show'), 'SS');
});

test('initials never come back empty', () => {
  assert.equal(initials(''), '?');
  assert.equal(initials('   '), '?');
  assert.equal(initials('---'), '?');
});

// The same show has to get the same tile every time, or a list would reshuffle
// its colours on every render.
test('avatarGradient is stable, and a CSS gradient', () => {
  assert.equal(avatarGradient('Lanterns'), avatarGradient('Lanterns'));
  assert.match(avatarGradient('Lanterns'), /^linear-gradient\(135deg, hsl\(\d+ /);
  assert.notEqual(avatarGradient('Lanterns'), avatarGradient('Anna Pigeon'));
});

test('avatarGradient handles a show with no name', () => {
  assert.match(avatarGradient(''), /^linear-gradient\(/);
});

// This Week's heading is the only place a range is printed, and it is printed
// beside a window fetched by weekRange -- so the two have to describe the same
// seven days. The exact string is the locale's business; what is asserted here
// is that both ends actually reach it and that Intl collapses the pair rather
// than printing the month twice.
test('formatDateRange names both ends of a week', () => {
  const range = formatDateRange(new Date(2026, 8, 7), new Date(2026, 8, 13));

  assert.match(range, /7/, 'the Monday');
  assert.match(range, /13/, 'the Sunday');
  assert.equal(range.match(/Sep/g)?.length, 1, 'one month name, not two');
});

// A week that straddles a month end has to name both months -- collapsing that
// pair is exactly what Intl must not do.
test('formatDateRange keeps both months when a week straddles one', () => {
  const range = formatDateRange(new Date(2026, 7, 31), new Date(2026, 8, 6));

  assert.match(range, /Aug/);
  assert.match(range, /Sep/);
});

// A single day handed to it reads as one date rather than as a range of one.
test('formatDateRange collapses a range of one day', () => {
  const day = new Date(2026, 8, 7);
  assert.equal(formatDateRange(day, day), formatDate(day).replace(/^\w+,\s*/, ''));
});
