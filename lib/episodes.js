// What the popup knows about an item beyond fetching it: how one list's episode
// is recognised in another, what order a day is read in, and whether a day that
// just arrived is the one already on screen.
//
// All of it is plain data in and plain data out, so it lives here rather than
// in popup.js, where a module that reaches for `document` on load put it out of
// reach of the tests.

import { HOME_PAGE } from './api.js';

// The three numbers that name an episode to MyEpisodes: show id, season,
// episode. The API takes exactly that triple in its path, which is what makes
// it the identity everything here is built on.
//
// This used to have a second half. While All Today came from rss.php, an item
// could arrive with its numbers packed into a <guid> as
// "<show id>-<season>-<episode>" instead of carried as fields, and parseGuid
// read them back out so a mark set on an API tab would be recognised as the
// same episode on the feed-backed one. This Week replaced that tab with a
// fourth API window, so every item now arrives the same way and there is one
// shape to read.
export function episodeTarget(item) {
  if (!Number.isInteger(item?.showid)) return null;
  if (!Number.isInteger(item.season) || !Number.isInteger(item.number)) return null;
  return { showid: item.showid, season: item.season, episode: item.number };
}

// The join key for one episode -- the triple when it can be read, and the show
// and code together when it cannot, which is specific enough to stand in.
export function episodeKey(item) {
  const target = episodeTarget(item);
  if (target) return `${target.showid}|${target.season}|${target.episode}`;
  return `${item?.show}|${item?.code}`;
}

// A day reads as a schedule, so run it in broadcast order. Episodes with no
// time sort to the end, keeping the order they arrived in.
export function byAirTime(items) {
  return [...items].sort((a, b) => {
    const left = clockMinutes(a);
    const right = clockMinutes(b);
    return left === right ? 0 : left - right;
  });
}

// Infinity for an episode with no time, so it sorts last -- and compared for
// equality first, since Infinity - Infinity is NaN and would leave the sort
// with no answer at all.
export function clockMinutes({ airTime }) {
  return airTime ? airTime.hours * 60 + airTime.minutes : Infinity;
}

// Whether a freshly fetched day is the one already rendered. The items are
// plain data on both sides -- one came back through storage, the other straight
// from the API, and both are built by the same code -- so comparing them
// serialised is enough, and cheaper than the render it saves.
export function sameDay(rendered, fetched) {
  return rendered.length === fetched.length && JSON.stringify(rendered) === JSON.stringify(fetched);
}

// The link comes from MyEpisodes, so only a web URL is let through to href.
// MV3's CSP already refuses a javascript: one -- this keeps anything else odd
// off the card too, and covers items that carry no link at all.
export function episodeUrl(link) {
  try {
    const { protocol, href } = new URL(link);
    return protocol === 'https:' || protocol === 'http:' ? href : HOME_PAGE;
  } catch {
    return HOME_PAGE;
  }
}

// A series premiere -- season 1, episode 1 -- which across a week of continuing
// runs is the one item worth pointing out: a watchlist show that has not
// started yet and can still be picked up from the beginning.
//
// Both numbers have to be read for this to be true, so a row that arrived
// without them (`season` and `number` are null together) is never a premiere.
// Daily shows number themselves by year rather than by season -- 2026x172 --
// which is why this asks for season 1 exactly rather than for the first episode
// of whatever the season field happens to hold.
//
// `special` is checked rather than assumed. Under the feed it did not have to
// be: a special's numbering never survived splitTitle as a clean 1x01, so
// ruling one out took no code. The API sends the flag outright, and an S01E01
// marked special is a shape that can actually arrive -- a pilot-numbered extra
// is not a series starting, and flagging it "New show" would point at nothing
// to pick up.
export function isPremiere({ season, number, special }) {
  return !special && season === 1 && number === 1;
}

// "S01E04" reads like a filename; spell it out instead.
//
// Falling back to `code` used to mean something: a feed title the parser could
// not take apart still carried the code as a string, so showing it beat showing
// nothing. It cannot any more -- episodeCode() in lib/api.js builds the code
// from the same two numbers this checks, so whenever the fallback fires `code`
// is '' and the popup's `if (numbering)` drops the badge. Kept as the honest
// answer for a row that names no numbering, not as a second chance at one.
export function describeNumbering({ season, number, code }) {
  if (season === null || number === null) return code;
  return `Season ${season} · Episode ${number}`;
}
