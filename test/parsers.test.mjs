// Covers the parts of lib/myepisodes.js that need no DOM. The RSS parsing
// itself is built on DOMParser, which Node has no equivalent for, so parseFeed
// and descriptionAirTime are exercised in the browser rather than here.

import test from 'node:test';
import assert from 'node:assert/strict';

import { feedUrl, splitTitle, airTime, countItems, isPlaceholder } from '../lib/myepisodes.js';

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

test('splitTitle reads fields whether or not they are spaced apart', () => {
  const spaced = splitTitle('[ Show ] [ 01x04 ] [ Title ] [ 29-Aug-2026 ]');
  assert.equal(spaced.show, 'Show');
  assert.equal(spaced.code, 'S01E04');
  assert.equal(spaced.episode, 'Title');
  assert.equal(spaced.airDate, '29-Aug-2026');

  const tight = splitTitle('[Show][01x04][Title][29-Aug-2026]');
  assert.deepEqual(tight, spaced);
});

test('splitTitle keeps the show and episode when there is no season/episode field', () => {
  // Without a code the whole title used to fall through unparsed, which put
  // the brackets themselves on the card as the show name.
  assert.deepEqual(splitTitle('[ Show ][ Title ][ 29-Aug-2026 ]'), {
    show: 'Show',
    code: '',
    episode: 'Title',
    airDate: '29-Aug-2026',
    season: null,
    number: null
  });

  assert.equal(splitTitle('[ Lone Show ]').show, 'Lone Show');
});

test('splitTitle falls through when the brackets hold nothing to name', () => {
  assert.equal(splitTitle('[]').show, '[]');
  assert.equal(splitTitle('[  ][ 01x04 ]').show, '[  ][ 01x04 ]');
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

// MyEpisodes fills an empty day with a single item titled "No Episodes" rather
// than sending no items, so that one has to be recognised and dropped.
function item(rawTitle) {
  return { rawTitle, ...splitTitle(rawTitle) };
}

test('isPlaceholder recognises the filler item an empty day arrives as', () => {
  assert.equal(isPlaceholder(item('No Episodes')), true);
  assert.equal(isPlaceholder(item('[ No Episodes ]')), true);
  assert.equal(isPlaceholder(item('no episodes today')), true);
  assert.equal(isPlaceholder(item('No Episode')), true);
});

test('isPlaceholder leaves real episodes alone', () => {
  assert.equal(isPlaceholder(item('[ Anna Pigeon ][ 01x04 ][ Hell Is Other People ][ 29-Aug-2026 ]')), false);
  assert.equal(isPlaceholder(item('Lanterns - 01x03 - OutKast')), false);
  // A season/episode code is what separates the filler from a show that merely
  // happens to be called this.
  assert.equal(isPlaceholder(item('[ No Episodes ][ 01x01 ][ Pilot ]')), false);
  assert.equal(isPlaceholder(item('Nothing but Trouble')), false);
  assert.equal(isPlaceholder(item('')), false);
});

test('countItems does not count the filler item towards the badge', () => {
  const empty = `<rss><channel><title>tomorrow</title>
    <item><title>No Episodes</title><link>https://www.myepisodes.com/</link></item>
  </channel></rss>`;
  assert.equal(countItems(empty), 0);

  const cdata = '<item><title><![CDATA[ No Episodes ]]></title></item>';
  assert.equal(countItems(cdata), 0);
});

// The badge and the popup have to agree about what an item is, or a day reads
// as one number on the toolbar and a different list inside it. countItems and
// parseFeed both defer to isPlaceholder for that reason.
test('countItems judges the filler by the same rule the popup does', () => {
  // A real show that happens to be called "No Episodes" still carries a code,
  // which is what isPlaceholder tells the two apart by.
  const real = '<rss><channel><title>today</title>' +
    '<item><title>[No Episodes][1x01][Pilot]</title></item></channel></rss>';
  assert.equal(countItems(real), 1);
  assert.equal(isPlaceholder({ rawTitle: '[No Episodes][1x01][Pilot]', code: '1x01' }), false);
});

// Only an item's own title can stand for an item. The channel's sits outside
// every item and used to be subtracted along with them.
test('countItems does not read the channel title as a filler item', () => {
  const feed = `<rss><channel><title>No episodes today</title>
    <item><title>[ Lanterns ][ 01x03 ][ OutKast ]</title></item>
  </channel></rss>`;
  assert.equal(countItems(feed), 1);
});

test('countItems reads a title tag that carries attributes', () => {
  assert.equal(countItems('<item><title xml:lang="en">No Episodes</title></item>'), 0);
});

test('countItems still counts a day that has episodes on it', () => {
  const feed = `<rss><channel><title>today</title>
    <item><title>[ Lanterns ][ 01x03 ][ OutKast ]</title></item>
    <item><title>[ Anna Pigeon ][ 01x04 ][ Hell Is Other People ]</title></item>
  </channel></rss>`;
  assert.equal(countItems(feed), 2);
});
