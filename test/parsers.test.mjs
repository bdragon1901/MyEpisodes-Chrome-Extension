// Covers the parts of lib/myepisodes.js that need no DOM. The RSS parsing
// itself is built on DOMParser, which Node has no equivalent for, so parseFeed
// and descriptionAirTime are exercised in the browser rather than here.

import test from 'node:test';
import assert from 'node:assert/strict';

import { feedUrl, splitTitle, airTime, countItems } from '../lib/myepisodes.js';

test('feedUrl carries the credentials and defaults to today', () => {
  const url = new URL(feedUrl({ uid: 'someone', pwdmd5: 'abc123' }));
  assert.equal(url.origin + url.pathname, 'https://www.myepisodes.com/rss.php');
  assert.equal(url.searchParams.get('feed'), 'today');
  assert.equal(url.searchParams.get('uid'), 'someone');
  assert.equal(url.searchParams.get('pwdmd5'), 'abc123');
  assert.equal(url.searchParams.get('onlyunacquired'), null);
});

test('feedUrl adds the unacquired filter only when asked', () => {
  const plain = new URL(feedUrl({ feed: 'yesterday', uid: 'u', pwdmd5: 'p' }));
  assert.equal(plain.searchParams.get('onlyunacquired'), null);

  const filtered = new URL(feedUrl({ feed: 'yesterday', uid: 'u', pwdmd5: 'p', onlyunacquired: true }));
  assert.equal(filtered.searchParams.get('feed'), 'yesterday');
  assert.equal(filtered.searchParams.get('onlyunacquired'), '1');
});

test('feedUrl escapes values that would otherwise break the query', () => {
  const url = new URL(feedUrl({ uid: 'a b&c=d', pwdmd5: 'p/p' }));
  assert.equal(url.searchParams.get('uid'), 'a b&c=d');
  assert.equal(url.searchParams.get('pwdmd5'), 'p/p');
});

test('splitTitle reads the default bracketed format', () => {
  assert.deepEqual(splitTitle('[ Anna Pigeon ][ 01x04 ][ Hell Is Other People ][ 29-Aug-2026 ]'), {
    show: 'Anna Pigeon',
    code: 'S01E04',
    episode: 'Hell Is Other People',
    airDate: '29-Aug-2026',
    season: 1,
    number: 4
  });
});

test('splitTitle handles daily shows numbered by year and day', () => {
  const parsed = splitTitle('[ The Five ][ 2026x172 ][ Episode 172 ][ 29-Aug-2026 ]');
  assert.equal(parsed.code, 'S2026E172');
  assert.equal(parsed.season, 2026);
  assert.equal(parsed.number, 172);
});

test('splitTitle keeps a clock in the date field out of the episode name', () => {
  const parsed = splitTitle('[ Show ][ S01E04 ][ Title ][ 29-Aug-2026 20:00 ]');
  assert.equal(parsed.episode, 'Title');
  assert.equal(parsed.airDate, '29-Aug-2026 20:00');
});

test('splitTitle survives a stray bracket inside the episode name', () => {
  const parsed = splitTitle('[ Some Show ][ 01x04 ][ A Title With ] Bracket ][ 29-Aug-2026 ]');
  assert.equal(parsed.show, 'Some Show');
  assert.equal(parsed.episode, 'A Title With ] Bracket');
});

test('splitTitle copes with a missing date field', () => {
  const parsed = splitTitle('[ NoDate Show ][ 01x04 ][ Episode Name ]');
  assert.equal(parsed.episode, 'Episode Name');
  assert.equal(parsed.airDate, '');
});

test('splitTitle reads the dash and bracket variants', () => {
  for (const raw of [
    'The Wire - 01x04 - Old Cases',
    'The Wire - S01E04 - Old Cases',
    'The Wire (01x04) Old Cases',
    'The Wire [S01E04] Old Cases'
  ]) {
    const parsed = splitTitle(raw);
    assert.equal(parsed.show, 'The Wire', raw);
    assert.equal(parsed.code, 'S01E04', raw);
    assert.equal(parsed.episode, 'Old Cases', raw);
  }
});

test('splitTitle shows an unrecognised title whole rather than mangling it', () => {
  assert.deepEqual(splitTitle('Some Totally Unparsed Title'), {
    show: 'Some Totally Unparsed Title',
    code: '',
    episode: '',
    airDate: '',
    season: null,
    number: null
  });
});

test('airTime reads a clock out of any of the fields it is given', () => {
  assert.deepEqual(airTime('20:00'), { hours: 20, minutes: 0 });
  assert.deepEqual(airTime('9:05'), { hours: 9, minutes: 5 });
  assert.deepEqual(airTime('29-Aug-2026 21:30'), { hours: 21, minutes: 30 });
});

test('airTime treats midnight as "no time" unless the feed said so itself', () => {
  // A date field with no clock still reads as 00:00, which is not a broadcast
  // time -- only the feed's own Air Time row is trusted to mean midnight.
  assert.equal(airTime('00:00'), null);
  assert.deepEqual(airTime('00:00', { allowMidnight: true }), { hours: 0, minutes: 0 });
});

test('airTime rejects what is not a clock', () => {
  assert.equal(airTime('29-Aug-2026'), null);
  assert.equal(airTime('25:99'), null);
  assert.equal(airTime(''), null);
  assert.equal(airTime(null), null);
  assert.equal(airTime(undefined), null);
});

test('countItems counts feed entries without a parser', () => {
  const feed = `<rss><channel><title>today</title>
    <item><title>One</title></item>
    <item attr="x"><title>Two</title></item>
    <item>
      <title>Three</title>
    </item>
    <item/>
  </channel></rss>`;
  assert.equal(countItems(feed), 4);
});

test('countItems does not double-count closing tags', () => {
  assert.equal(countItems('<item></item>'), 1);
});

test('countItems reads an empty or non-RSS response as zero', () => {
  assert.equal(countItems('<rss><channel><title>today</title></channel></rss>'), 0);
  assert.equal(countItems('<html><body>Please login</body></html>'), 0);
  assert.equal(countItems(''), 0);
});

test('countItems is not fooled by elements that merely start with "item"', () => {
  assert.equal(countItems('<itemization>x</itemization><items>y</items>'), 0);
});
