// Thin client over the MyEpisodes RSS feeds.
//
// Feed URL shape:
//   https://www.myepisodes.com/rss.php?feed=today&uid=<user>&pwdmd5=<token>
// The token is the MD5 of the account password, which MyEpisodes itself hands
// out on its RSS page -- we never see or hash the plaintext password.

// Where a card falls back to when the feed sends a link that cannot be used.
export const HOME_URL = 'https://www.myepisodes.com/';

const BASE_URL = `${HOME_URL}rss.php`;

// Every feed the extension reads, and so the whole of what the cache has to
// drop when the credentials change. A tab pointed at a feed missing from here
// would keep the previous account's list, so tabs take their feed name from
// this object rather than spelling one out.
export const FEEDS = Object.freeze({
  yesterday: 'yesterday',
  today: 'today',
  tomorrow: 'tomorrow',
  all: 'all'
});

// `onlyunacquired` asks the day feeds to leave out episodes already marked as
// acquired on the site -- the feeds carry no per-episode flag, so this filter is
// the only way to tell the two apart.
export function feedUrl({ feed = 'today', uid, pwdmd5, onlyunacquired = false }) {
  const params = new URLSearchParams({ feed, uid, pwdmd5 });
  if (onlyunacquired) params.set('onlyunacquired', '1');
  return `${BASE_URL}?${params}`;
}

export class FeedError extends Error {
  constructor(message, { kind = 'unknown' } = {}) {
    super(message);
    this.name = 'FeedError';
    this.kind = kind; // 'network' | 'http' | 'parse' | 'auth' | 'unknown'
  }
}

export async function fetchFeed(options) {
  return parseFeed(await requestFeed(options));
}

// The toolbar badge only needs a number, and the MV3 service worker that sets
// it has no DOMParser to get a parsed feed with, so it counts instead.
export async function fetchFeedCount(options) {
  return countItems(await requestFeed(options));
}

async function requestFeed(options) {
  let response;
  try {
    response = await fetch(feedUrl(options), { cache: 'no-store' });
  } catch {
    throw new FeedError('Could not reach myepisodes.com.', { kind: 'network' });
  }

  if (!response.ok) {
    throw new FeedError(`MyEpisodes replied with ${response.status}.`, { kind: 'http' });
  }

  return response.text();
}

// MyEpisodes never sends an empty feed. A day with nothing on it arrives as a
// single item titled "No Episodes", which would otherwise read as an episode --
// a card on the list, a 1 on the tab, a 1 on the badge -- so it is dropped here,
// where everything that reads the feed gets the same answer.
const PLACEHOLDER_TITLE = /^\s*\[?\s*no\s+episodes?\b/i;

export function isPlaceholder({ rawTitle, code }) {
  // An episode of a show actually called "No Episodes" would still carry its
  // season/episode code, so that is what tells a real item from the filler.
  return !code && PLACEHOLDER_TITLE.test(rawTitle ?? '');
}

// <item> is the only element an RSS feed spells that way, so counting needs no
// parser. A page served because the credentials were rejected carries none,
// which reads as zero and leaves the badge clear -- the right outcome either
// way, so the count does not try to tell the two apart.
export function countItems(xmlText) {
  return itemBlocks(xmlText).filter((block) => !isPlaceholder(blockEpisode(block))).length;
}

// Everything from one <item> to the next. The channel's own <title> sits ahead
// of the first item and so falls outside every block, which is what keeps a
// channel titled "No episodes today" from being counted as one.
function itemBlocks(xmlText) {
  return xmlText.split(/<item(?=[\s/>])/).slice(1);
}

const BLOCK_TITLE = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i;
const CDATA = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/;

// Enough of an item for isPlaceholder to judge it by the same rule the parsed
// feed uses -- the title, and the season/episode code read out of it. The badge
// and the popup disagreeing about a show actually called "No Episodes" is the
// bug this shares the rule to avoid.
function blockEpisode(block) {
  const raw = BLOCK_TITLE.exec(block)?.[1] ?? '';
  const rawTitle = (CDATA.exec(raw)?.[1] ?? raw).trim();
  return { rawTitle, code: splitTitle(rawTitle).code };
}

export function parseFeed(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');

  if (doc.querySelector('parsererror')) {
    // A wrong uid/token makes MyEpisodes serve an HTML page instead of RSS.
    if (/login|password|denied/i.test(xmlText)) {
      throw new FeedError('MyEpisodes rejected these credentials.', { kind: 'auth' });
    }
    throw new FeedError('The feed response was not valid RSS.', { kind: 'parse' });
  }

  const items = [...doc.querySelectorAll('item')].map(toEpisode).filter((item) => !isPlaceholder(item));

  // The feed stays valid but empty when the credentials are wrong, so use the
  // channel title as a second signal before reporting "nothing airing today".
  const channelTitle = text(doc.querySelector('channel > title'));
  if (!items.length && /error|login|invalid/i.test(channelTitle)) {
    throw new FeedError('MyEpisodes rejected these credentials.', { kind: 'auth' });
  }

  return { channelTitle, items };
}

function toEpisode(node) {
  const rawTitle = text(node.querySelector('title'));
  const pubDate = text(node.querySelector('pubDate'));
  const description = text(node.querySelector('description'));
  const parsed = splitTitle(rawTitle);
  return {
    ...parsed,
    rawTitle,
    // guid is "<show id>-<season>-<episode>", which is what pairs an item up
    // with the same episode in the unacquired feed.
    guid: text(node.querySelector('guid')),
    link: text(node.querySelector('link')),
    // The raw description and pubDate are only read on the way to a broadcast
    // time, so they stop here rather than riding along into the cache.
    airTime: descriptionAirTime(description) ?? airTime(parsed.airDate) ?? airTime(pubDate)
  };
}

// Where the broadcast time comes from. The feed carries no pubDate; each item
// describes itself with a small HTML table instead, whose last row is the one
// we want:
//   <tr><td><b>Air Time:</b></td><td>10:01</td></tr>
// The title's date field is the second source -- accounts whose date format
// includes a clock put it there -- and pubDate is a last resort for feeds that
// do send one. Only this row is trusted to mean midnight when it says 00:00;
// the other two carry a date whose clock defaults to midnight when unset.
export function descriptionAirTime(description) {
  if (!description || !/air\s*time/i.test(description)) return null;

  const doc = new DOMParser().parseFromString(description, 'text/html');
  for (const row of doc.querySelectorAll('tr')) {
    const cells = row.querySelectorAll('td');
    if (cells.length >= 2 && /air\s*time/i.test(cells[0].textContent)) {
      return airTime(cells[1].textContent, { allowMidnight: true });
    }
  }
  return null;
}

// Read the clock straight off the string instead of going through Date, so the
// broadcast time stays the one MyEpisodes printed for the account's timezone
// rather than being shifted into the browser's.
const CLOCK_PATTERN = /\b(\d{1,2}):(\d{2})(?::\d{2})?\b/;

export function airTime(value, { allowMidnight = false } = {}) {
  const match = CLOCK_PATTERN.exec(value ?? '');
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  // A date field that carries no clock still reads as midnight, so 00:00 only
  // counts as a real broadcast time from the feed's own Air Time row.
  if (hours === 0 && minutes === 0 && !allowMidnight) return null;

  return { hours, minutes };
}

// MyEpisodes titles arrive in a few shapes depending on the account's format
// preference. The default is bracket-delimited fields:
//   [ Anna Pigeon ][ 01x04 ][ Hell Is Other People ][ 29-Aug-2026 ]
// Others separate the same parts with dashes. Daily shows number themselves by
// year and day rather than by season, so the season field runs to four digits:
//   [ The Five ][ 2026x172 ][ Episode 172 ][ 29-Aug-2026 ]
// Recognise what we can, and fall back to showing the title whole rather than
// mangling it.

const CODE_PATTERN = /^(?:\d{1,4}x\d{1,3}|S\d{1,4}E\d{1,3})$/i;
// Accounts whose date format includes a clock put it in the same field, so
// keep it out of the episode title and let airTime() pick it up.
const DATE_PATTERN = /^\d{1,2}-[A-Za-z]{3}-\d{4}(?:[\sT]+\d{1,2}:\d{2}(?::\d{2})?)?$/;
// Fields butt up against each other by default, but a format that spaces them
// out is still the same shape -- allow the gap rather than failing the whole
// title over it.
const FIELD_SEPARATOR = /\]\s*\[/;

const DASH_PATTERNS = [
  /^(?<show>.+?)\s*[-–]\s*(?<code>\d{1,4}x\d{1,3})\s*[-–]\s*(?<episode>.+)$/i,
  /^(?<show>.+?)\s*[-–]\s*(?<code>S\d{1,4}E\d{1,3})\s*[-–]\s*(?<episode>.+)$/i,
  /^(?<show>.+?)\s*[[(](?<code>\d{1,4}x\d{1,3})[\])]\s*[-–]?\s*(?<episode>.+)$/i,
  /^(?<show>.+?)\s*[[(](?<code>S\d{1,4}E\d{1,3})[\])]\s*[-–]?\s*(?<episode>.+)$/i
];

export function splitTitle(rawTitle) {
  const parsed =
    parseBracketed(rawTitle) ??
    parseDashed(rawTitle) ?? { show: rawTitle, code: '', episode: '', airDate: '' };
  return { ...parsed, ...splitCode(parsed.code) };
}

// The popup spells the code out in words, so hand it the two numbers as well
// as the compact form.
function splitCode(code) {
  const match = code.match(/^S(\d{1,4})E(\d{1,3})$/);
  return match
    ? { season: Number(match[1]), number: Number(match[2]) }
    : { season: null, number: null };
}

function parseBracketed(rawTitle) {
  const trimmed = rawTitle.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;

  const fields = trimmed.slice(1, -1).split(FIELD_SEPARATOR).map((field) => field.trim());

  const [show, ...rest] = fields;
  // Nothing to name the card after, so let the caller fall through.
  if (!show) return null;

  // A format that leaves the season/episode field out still names the show and
  // the episode. Take those instead of giving up: the fallback would put the
  // brackets themselves on the card as the show name.
  const codeIndex = rest.findIndex((field) => CODE_PATTERN.test(field));
  const after = codeIndex === -1 ? rest : rest.slice(codeIndex + 1);
  const airDate = DATE_PATTERN.test(after.at(-1) ?? '') ? after.pop() : '';

  return {
    show,
    code: codeIndex === -1 ? '' : normaliseCode(rest[codeIndex]),
    episode: after.join(' ').trim(),
    airDate
  };
}

function parseDashed(rawTitle) {
  for (const pattern of DASH_PATTERNS) {
    const match = rawTitle.match(pattern);
    if (match) {
      return {
        show: match.groups.show.trim(),
        code: normaliseCode(match.groups.code),
        episode: match.groups.episode.trim(),
        airDate: ''
      };
    }
  }
  return null;
}

function normaliseCode(code) {
  const seasonEpisode = code.match(/^(\d{1,4})x(\d{1,3})$/i);
  if (seasonEpisode) {
    const [, season, episode] = seasonEpisode;
    return `S${season.padStart(2, '0')}E${episode.padStart(2, '0')}`;
  }
  return code.toUpperCase();
}

function text(node) {
  return node?.textContent?.trim() ?? '';
}
