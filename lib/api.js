// Thin client over the api.myepisodes.com v1 API, which is what every tab, the
// toolbar badge and every mark go through.
//
//   GET https://api.myepisodes.com/v1/me/episodes?from=2026-09-07&to=2026-09-07
//   Authorization: Bearer myeps_...
//
// The whole migration off the RSS feeds was worth it for one field: every row
// carries its own `acquired` and `watched`, so a day is one request rather than
// the two the feeds needed -- one for the day, one with `onlyunacquired` -- to
// work out which half of the list had already been marked. Dates, times, show
// ids and TVmaze ids arrive as fields too, instead of being parsed back out of
// a title whose shape the account's own format preference decides.
//
// The key is the same one lib/marks.js already writes with, sent the same way.
// Reads want the `read` scope, which `write` implies, so a key that can mark an
// episode can always list one.

export const API_BASE = 'https://api.myepisodes.com/v1';

// MyEpisodes spells a show's own page as a site-relative path, so a card needs
// the origin to put in front of it.
const HOME_URL = 'https://www.myepisodes.com';

// The site's front page, which is where a card with no usable link of its own
// goes -- see episodeUrl in lib/episodes.js, which took this from
// lib/myepisodes.js until that module went away.
//
// Two constants for what looks like one string, because they are used two ways:
// HOME_URL is an origin to join a path onto, and joining onto a value with a
// trailing slash is how a link ends up with two. This one is a page to navigate
// to, and a bare origin is not one -- dropping the slash here quietly changed
// the fallback every linkless card falls back to.
export const HOME_PAGE = `${HOME_URL}/`;

// Where the RSS feed used to point every item, and still the better page to
// open: TVmaze redirects a bare episode id to its own slug, so the id alone is
// a working link.
const TVMAZE_EPISODE_URL = 'https://www.tvmaze.com/episodes/';

export class ApiError extends Error {
  constructor(message, { kind = 'unknown' } = {}) {
    super(message);
    this.name = 'ApiError';
    // 'network' | 'auth' | 'scope' | 'rate-limit' | 'notfound' | 'invalid'
    //           | 'refused' | 'unavailable' | 'http' | 'parse'
    //
    // `kind` is the whole of what a caller branches on. This also used to carry
    // the API's own `error.code` and, for a 429, the seconds off `Retry-After`;
    // nothing ever read either, and nothing retries an API call. The message is
    // what the popup and the settings page show, and `code` is the field to
    // bring back first if a caller ever has to tell two failures of one kind
    // apart -- `credential_in_query` from `invalid_token`, say.
    this.kind = kind;
  }
}

// The day windows the popup's tabs already speak in: -1 yesterday, 0 today, 1
// tomorrow. Built out of the local calendar fields and not toISOString(), which
// prints the UTC date and so would hand anyone west of UTC yesterday's window
// for most of their evening -- the kind of bug that only shows up after dinner.
export function dayKey(offset = 0, now = new Date()) {
  // Day-of-month arithmetic through the Date constructor, so a window that
  // steps off the end of a month or a year lands where the calendar says.
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

// Which days "this week" covers, as offsets from today -- Monday through
// Sunday, the week today falls in.
//
// The one place the week's shape is decided, because two things have to agree
// about it: the window This Week asks the API for, and the date range its panel
// heading prints. Working it out twice is how those two come to disagree, and a
// heading that reads Mon-Sun over a list fetched Sun-Sat is the kind of wrong
// nobody notices for a month.
//
// getDay() counts from Sunday, so `+ 6) % 7` rotates it onto a week that starts
// on Monday: Monday reads 0 and Sunday reads 6.
export function weekOffsets(now = new Date()) {
  const sinceMonday = (now.getDay() + 6) % 7;
  // Both ends subtracted from a base rather than the first one negated: `-0` is
  // what `-sinceMonday` yields on a Monday, and while it counts as 0 in every
  // sum it is a different value to Object.is and to a strict deepEqual. `0 -
  // sinceMonday` is a plain zero, which is what this should hand out.
  return { first: 0 - sinceMonday, last: 6 - sinceMonday };
}

// The same week as the two dates the API wants. Built through dayKey so the
// local-calendar arithmetic -- and its refusal to go via toISOString() -- is
// shared rather than repeated.
export function weekRange(now = new Date()) {
  const { first, last } = weekOffsets(now);
  return { from: dayKey(first, now), to: dayKey(last, now) };
}

// One request, one parsed body. Single resources come back bare and lists come
// back in an envelope; both are the caller's to read, so this only gets as far
// as JSON.
export async function request(path, { apiKey, params = {}, method = 'GET', body } = {}) {
  // No key is the same answer as a rejected one, and it is an answer we already
  // have -- spending a request to be told 401 would only cost the popup a round
  // trip on the way to the same message.
  if (!apiKey) {
    throw new ApiError('Add a MyEpisodes API key in Settings.', { kind: 'auth' });
  }

  const init = {
    method,
    // The key goes in a header and never in the query string: the API refuses
    // `?apikey=` with `credential_in_query` even on public endpoints, so it
    // would break the request as well as leaving the key in logs, history and
    // referrers.
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    // A day's list is exactly the thing that must not come out of the HTTP
    // cache: the popup opens to check whether anything changed.
    cache: 'no-store'
  };

  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(`${API_BASE}${path}${query(params)}`, init);
  } catch {
    throw new ApiError('Could not reach api.myepisodes.com.', { kind: 'network' });
  }

  // Read the body either way: a failure carries the message worth showing, so
  // it is read before the status is judged.
  const payload = await readJson(response);

  if (!response.ok) throw httpError(response, payload);

  // An empty body is a real answer, not a broken one. A PUT that succeeded has
  // nothing to say and MyEpisodes says it with 204 and no bytes -- reading that
  // as a parse failure made every successful mark report itself as one.
  if (!payload.parsed) {
    if (payload.empty) return null;
    throw new ApiError('The MyEpisodes response was not valid JSON.', { kind: 'parse' });
  }

  return payload.value;
}

// The documented maximum, and the reason a day usually costs one request.
const PAGE_LIMIT = 200;

// Every page of a list endpoint, concatenated. The envelope carries no total --
// only `limit`, `offset` and `has_more` -- so the walk is driven by the flag
// rather than by arithmetic over a count nobody sent.
export async function fetchList(path, { apiKey, params = {}, maxPages = 10 } = {}) {
  const rows = [];
  let offset = 0;

  // maxPages is 2000 rows at this limit, well past any window a tab asks for.
  // It is a stop for a server that keeps saying `has_more`, not a page budget.
  for (let page = 0; page < maxPages; page += 1) {
    const payload = await request(path, {
      apiKey,
      params: { ...params, limit: PAGE_LIMIT, offset }
    });

    const data = pageRows(payload);
    rows.push(...data);

    // A bare array, or an envelope with no meta, is the whole answer.
    if (!payload?.meta?.has_more) break;
    // A page that claims there is more and sends nothing would leave `offset`
    // where it was and ask for the same page until the tab was closed.
    if (!data.length) break;
    // Advance by the rows that actually arrived rather than by `limit`, so a
    // page the server trimmed does not carry the walk past what it left out.
    offset += data.length;
  }

  return rows;
}

// The one call a day tab makes: everything scheduled in the window, already
// flagged.
export async function fetchEpisodes({ apiKey, from, to, includePilots = false, includeIgnored = false }) {
  const rows = await fetchList('/me/episodes', {
    apiKey,
    params: {
      // `from`/`to` and the two include flags are all sent every time, even
      // when false. They override the window and filters saved on the account,
      // and omitting one would let a setting made on the website decide what a
      // tab shows -- pilots of shows the viewer does not follow, most visibly.
      from,
      to,
      include_pilots: includePilots,
      include_ignored: includeIgnored,
      // The tabs are the viewer's own yesterday/today/tomorrow, so the window
      // has to filter on the viewer's date and not the show's -- a 21:00
      // broadcast in New York is already tomorrow in Europe either way.
      date_basis: 'local',
      order: 'asc'
      // No `status`: the unfiltered list is the point. It carries `acquired`
      // and `watched` per row, which is what retires the second request the
      // feed client had to make with `onlyunacquired` to learn the same thing.
    }
  });

  return rows.map(toEpisode);
}

// What the Settings page's Test button proves a key with. A single resource, so
// it arrives bare rather than in the list envelope -- and it is the cheapest
// authenticated call there is, which is what makes it the one worth spending on
// a key that may well be wrong.
export async function fetchAccount({ apiKey }) {
  return request('/me', { apiKey });
}

// One API row flattened into the shape the popup's cards render, which was kept
// a superset of the feed client's while a day could still come from either.
//
// Only part of the /me/episodes item shape is documented -- the flags are
// confirmed, the rest is assumed to be the episode fields with a nested `show`
// beside them -- so every field is read through both nestings and nothing here
// throws on a row that turns out to be missing one.
export function toEpisode(raw) {
  const item = raw ?? {};
  const show = item.show ?? {};

  const season = numeric(item.season);
  // The API's `episode` is the number; the popup's `episode` is the title. The
  // collision is the API's, and this is the line where it stops.
  const number = numeric(item.episode ?? item.number);
  const tvmazeEpisodeId = numeric(item.external?.tvmaze);
  const showName = show.showname ?? item.showname ?? '';
  const episodeName = item.name ?? item.episodename ?? '';
  const code = episodeCode(season, number);

  return {
    showid: numeric(item.showid ?? show.showid),
    season,
    number,
    show: showName,
    episode: episodeName,
    code,
    airTime: airTime(item),
    special: Boolean(item.special),
    // Read hopefully rather than expectantly: /v1/me/episodes sends no network
    // of any spelling, so this is '' on every real row and the card's chip is
    // filled from TVmaze. Kept because /v1/shows does send one, so a list
    // endpoint that starts to would be picked up for free.
    network: name(show.network ?? item.network),
    tvmazeEpisodeId,
    // The show's TVmaze id and the episode's are both `external.tvmaze`, one
    // nesting apart, which is the whole reason they are read separately here
    // instead of by one lookup that would return whichever it found first.
    tvmazeShowId: numeric(show.external?.tvmaze),
    // `url` is "" and not absent when a show has no page, so the fallback is
    // picked with || rather than ?? -- an empty string has to fall through too.
    link: link(tvmazeEpisodeId, show.url || item.url),
    // The feed handed cards a title to hover; the API hands fields, so the
    // title is assembled back into the shape the tooltip has always shown.
    // Empty parts drop out rather than leaving the dashes with nothing between
    // them.
    rawTitle: [showName, code, episodeName].filter(Boolean).join(' — '),
    acquired: Boolean(item.acquired),
    watched: Boolean(item.watched)
  };
}

// Which of the three times an item carries ends up on the card.
//
// `local_airdate` wins, and it has to. The window is asked for with
// `date_basis=local`, so that is the field the day filter runs on -- an episode
// airing 21:00 on the 6th in New York comes back inside the window for the 7th
// because its local_airdate falls there. Showing the show's own `airtime`
// instead would put "21:00" on a card sitting under Today's heading next to
// yesterday's date, which is the one combination guaranteed to read as a bug.
//
// It is already in the account's own timezone, so it is read as a wall clock
// and never put through Date -- parsing it as an instant and then rendering it
// with local getters would convert a time that was already converted.
//
// `stored_utc_airdate` is the fallback and genuinely an instant, so it does go
// through Date. The show's `airtime` is the last resort: better a wall clock in
// the wrong zone than no time at all.
//
// 00:00 is a real broadcast time and is kept as one: an episode whose time the
// API does not know arrives with no airtime at all, so there is nothing here
// that has to be told apart from midnight. The feed's date fields read as
// midnight whenever their clock was unset, which is why the old client had to
// throw midnight away and lost every show that actually airs then.
function airTime(item) {
  return (
    localWallClock(item.local_airdate) ??
    utcAirTime(item.stored_utc_airdate ?? item.utc_airdate) ??
    wallClock(item.airtime)
  );
}

// The clock out of "2026-09-07 04:00:00.000000". The time half is taken by
// splitting rather than by pattern, so the reader cannot wander into the date
// and come back with a month and a day -- and the fractional seconds are cut,
// because wallClock's pattern is anchored and this field is the only one that
// arrives carrying six digits of microseconds nobody asked for.
function localWallClock(value) {
  if (typeof value !== 'string') return null;
  const [, time] = value.trim().split(/[\sT]+/, 2);
  return wallClock(time?.split('.')[0]);
}

// `utc_airdate` is "YYYY-MM-DD HH:MM:SS" in UTC and not ISO-8601, so the space
// has to become a T and the zone has to be said out loud. Left as it arrives,
// the string parses as local time in some engines and not at all in others.
function utcAirTime(value) {
  if (typeof value !== 'string' || !value.trim()) return null;

  const instant = new Date(`${value.trim().replace(' ', 'T')}Z`);
  if (Number.isNaN(instant.getTime())) return null;

  // Local getters on purpose: this is the point of preferring the instant.
  return { hours: instant.getHours(), minutes: instant.getMinutes() };
}

// "21:00:00" read straight off the string rather than through Date, so a wall
// clock the show's timezone means stays the one MyEpisodes printed instead of
// being shifted into the browser's.
const CLOCK_PATTERN = /^(\d{1,2}):(\d{2})(?::\d{2})?$/;

function wallClock(value) {
  const match = CLOCK_PATTERN.exec(typeof value === 'string' ? value.trim() : '');
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  // A clock the API should never send, but a "25:00" on a card would look like
  // ours rather than theirs.
  if (hours > 23 || minutes > 59) return null;

  return { hours, minutes };
}

// Daily shows number themselves by year rather than by season, so the season
// field runs to four digits and padding must never truncate: S2026E172 is a
// real code.
function episodeCode(season, number) {
  if (season === null || number === null) return '';
  return `S${pad(season)}E${pad(number)}`;
}

// A TVmaze episode page when there is an id for one, and the show's own
// MyEpisodes page otherwise. The API's show `url` is a site-relative path
// ("/Greys_Anatomy") and an empty string when it has none, so it is joined onto
// the origin here and the bare home page is what a card with neither falls back
// to -- a card whose title does nothing is worse than one that opens the site.
function link(tvmazeEpisodeId, url) {
  if (tvmazeEpisodeId !== null) return `${TVMAZE_EPISODE_URL}${tvmazeEpisodeId}`;

  const path = string(url);
  if (!path) return HOME_PAGE;
  return path.startsWith('/') ? `${HOME_URL}${path}` : `${HOME_URL}/${path}`;
}

// Params a caller can hand over unconditionally: anything unset drops out here
// rather than at each call site, where a `from` that happened to be undefined
// would otherwise reach the API as the string "undefined" and come back a 400.
function query(params) {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    // The API's `bool` type is 1/0. URLSearchParams would spell a boolean out
    // as "true", which is not one of the two values it accepts.
    search.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  }

  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

// Whether the body parsed, and -- when it did not -- whether that is because
// there was nothing there to parse. The two are different answers: a 204 with
// no body is a success, while bytes that will not parse are a broken response.
// The text is read first and parsed here rather than through response.json(),
// which cannot tell those apart.
async function readJson(response) {
  let text;
  try {
    text = await response.text();
  } catch {
    return { parsed: false, empty: true, value: null };
  }

  if (!text.trim()) return { parsed: false, empty: true, value: null };

  try {
    return { parsed: true, empty: false, value: JSON.parse(text) };
  } catch {
    return { parsed: false, empty: false, value: null };
  }
}

// The list envelope, or a bare array from an endpoint that skips it.
function pageRows(payload) {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.data) ? payload.data : [];
}

const STATUS_KINDS = {
  400: 'invalid',
  401: 'auth',
  403: 'scope',
  404: 'notfound',
  422: 'refused',
  429: 'rate-limit',
  503: 'unavailable'
};

// What to say when the API sent no message of its own. Each one names its
// status, since a body that would not parse is exactly the case where the
// status is all anyone has to go on.
//
// 401 and 403 are separate kinds, and separate sentences, because they ask the
// viewer for opposite things. A 401 means the key itself is unknown, expired or
// revoked -- all three arrive as the same 401 deliberately -- and the only fix
// is a new key. A 403 means the key is real and simply lacks the scope the
// endpoint wants, so what has to change is the scope; telling that viewer to
// re-authenticate sends them off to replace a key that works.
const STATUS_MESSAGES = {
  400: 'MyEpisodes turned the request down as malformed (400).',
  401: 'MyEpisodes did not accept this API key (401). It has to be replaced.',
  403: 'This API key is not allowed to read that (403). Its scope has to be widened.',
  404: 'MyEpisodes has no record of that (404).',
  422: 'MyEpisodes understood the request and refused it (422).',
  429: 'MyEpisodes is rate-limiting this key (429).',
  503: 'MyEpisodes cannot reach its database right now (503).'
};

function httpError(response, { parsed, value }) {
  const kind = STATUS_KINDS[response.status] ?? 'http';
  const error = parsed ? value?.error : null;

  return new ApiError(
    // The API's own message first: it is written for a person and names the
    // parameter or the scope at fault, which nothing here can guess at. Ours
    // only stands in for a body that would not parse -- a proxy's error page,
    // say.
    string(error?.message) ||
      STATUS_MESSAGES[response.status] ||
      `MyEpisodes replied with ${response.status}.`,
    { kind }
  );
}


// Number(null) and Number('') are both 0, so absence is checked before the
// conversion -- an episode with no runtime would otherwise arrive as a
// zero-minute one.
function numeric(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function string(value) {
  return typeof value === 'string' ? value : '';
}

// A network arrives as { id, name } on the show record. A plain string costs
// one comparison to tolerate and saves a card reading "[object Object]".
function name(value) {
  if (typeof value === 'string') return value;
  return string(value?.name);
}

function pad(value) {
  return String(value).padStart(2, '0');
}
