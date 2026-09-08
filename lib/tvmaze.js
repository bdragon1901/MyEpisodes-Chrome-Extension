// Thin client over the public TVmaze API, which is where a card gets the two
// things MyEpisodes does not carry -- its artwork and its network.
//
// There are two ways in, because there are two things an item can hand us. A
// show is asked for by id:
//   https://api.tvmaze.com/shows/44776
// and an episode brings its show along when asked to:
//   https://api.tvmaze.com/episodes/3695361?embed=show
// which is where the show id (44776 here) comes from when only an episode is
// named. Fetching the episode and then following its _links.show.href would
// spend a second round trip on the same data, so the embed is the only episode
// shape asked for.
//
// The API takes no key and throttles by IP (roughly 20 requests per 10s), which
// is the reason lookups go through the cache: the shows behind a day's episodes
// barely change from one week to the next.

import { readTvmazeShow, showSummary, writeTvmazeShow } from './cache.js';

const BASE_URL = 'https://api.tvmaze.com';


export class TvmazeError extends Error {
  constructor(message, { kind = 'unknown' } = {}) {
    super(message);
    this.name = 'TvmazeError';
    this.kind = kind; // 'link' | 'network' | 'http' | 'rate-limit' | 'notfound' | 'parse'
  }
}

// The one call the popup makes: a MyEpisodes show id in, the show behind it
// out, served from storage when it is already there. It is keyed and cached by
// that show id, so every episode of a show shares the one lookup.
//
// The two hints are the routes to an answer, tried in the order given, and both
// have to exist because which one an item can offer depends on how much of the
// item the API filled in: a show object carries external.tvmaze as a TVmaze
// *show* id, while an episode object carries it as an *episode* id. So
// tvmazeShowId is preferred -- that is one request for the thing actually
// wanted -- and tvmazeEpisodeId is the fallback, answering with the episode and
// its show in a single round trip.
//
// The answer is the cache's own summary of the show whichever route produced
// it, so a hit and either fetch hand back the same shape and a caller never has
// to know which it got, and that record is the two fields a card paints -- see
// showRecord, which is where the rest of what TVmaze sends stops.
//
// Pass `cached: false` when the caller has already established there is nothing
// stored -- the popup reads the whole index when it opens, so every lookup that
// reaches here is one it knows to be a miss, and the read would only be a
// storage round trip spent confirming it.
export async function lookupShow(showid, { tvmazeShowId, tvmazeEpisodeId, cached = true } = {}) {
  if (!tvmazeShowId && !tvmazeEpisodeId) {
    throw new TvmazeError(`Nothing on show ${showid} points at TVmaze.`, { kind: 'link' });
  }

  if (cached) {
    // A cache that will not open is a slow lookup, not a failed one.
    const stored = await readTvmazeShow(showid).catch(() => null);
    if (stored) return stored;
  }

  const show = tvmazeShowId
    ? await fetchShow(tvmazeShowId)
    : (await fetchEpisode(tvmazeEpisodeId)).show;

  const summary = showSummary(show);
  // The caller has its answer; a cache write that fails only costs the next
  // lookup a request.
  await writeTvmazeShow(showid, summary).catch(() => {});
  return { fetchedAt: Date.now(), show: summary };
}

export async function fetchShow(tvmazeShowId) {
  return parseShow(await request(`${BASE_URL}/shows/${tvmazeShowId}`, `show ${tvmazeShowId}`));
}

export async function fetchEpisode(tvmazeEpisodeId) {
  const url = `${BASE_URL}/episodes/${tvmazeEpisodeId}?embed=show`;
  return parseEpisode(await request(url, `episode ${tvmazeEpisodeId}`));
}

// One request, one status table, so the two routes above cannot come to differ
// on what a given failure means.
async function request(url, missing) {
  let response;
  try {
    response = await fetch(url);
  } catch {
    throw new TvmazeError('Could not reach tvmaze.com.', { kind: 'network' });
  }

  // Worth telling apart: a 404 is a record TVmaze does not have, which no
  // amount of retrying fixes, while a 429 is this browser having asked too
  // quickly and is over in seconds -- which is the one the popup retries on.
  if (response.status === 404) {
    throw new TvmazeError(`TVmaze has no ${missing}.`, { kind: 'notfound' });
  }
  if (response.status === 429) {
    throw new TvmazeError('TVmaze is rate-limiting this browser.', { kind: 'rate-limit' });
  }
  if (!response.ok) {
    throw new TvmazeError(`TVmaze replied with ${response.status}.`, { kind: 'http' });
  }

  try {
    return await response.json();
  } catch {
    throw new TvmazeError('The TVmaze response was not valid JSON.', { kind: 'parse' });
  }
}

// A bare /shows/{id} payload. Nothing else names the show in that response, so
// an id is the one field it cannot do without.
export function parseShow(payload) {
  if (!payload?.id) {
    throw new TvmazeError('The TVmaze response named no show.', { kind: 'parse' });
  }
  return showRecord(payload, payload.id);
}

// The episode route's answer, of which only the show is ever used -- the wrapper
// stays because that is what the response is, and `lookupShow` reads `.show`
// off it.
//
// This used to build the episode out too: name, season, number, airstamp,
// runtime, rating, artwork and a summary run through plainText. Nothing ever
// read one. MyEpisodes already sends every one of those fields for the episode
// itself, and better -- its dates are the account's, not TVmaze's guess -- so
// the record was assembled and dropped on the floor once per lookup.
export function parseEpisode(payload) {
  const show = payload?._embedded?.show ?? null;

  // Both shapes carry the show: ?embed=show puts the whole record under
  // _embedded, and every episode response also links to it. Reading the link as
  // a fallback means the response still counts as parsed when the embed went
  // missing, even though there is nothing to paint from it.
  const showId = show?.id ?? idFromHref(payload?._links?.show?.href);
  if (!showId) {
    throw new TvmazeError('The TVmaze episode named no show.', { kind: 'parse' });
  }

  return { show: showRecord(show, showId) };
}

// The show half, from a /shows/{id} payload or from an episode's embed. One
// function so both routes through lookupShow hand the cache the same record.
//
// Two fields, because two is what a card paints. The record used to carry
// fourteen -- status, premiered, ended, genres, language, runtime, rating,
// officialSite, both artwork sizes and an HTML-stripped summary -- and
// showSummary in lib/cache.js then kept five of them, of which the popup reads
// these two. Everything else was computed on every lookup for nobody, and the
// summary cost an HTML strip to be discarded.
//
// `id` is kept because it is what parseShow and parseEpisode validate on and so
// says which show was parsed; it is dropped again on the way into storage.
function showRecord(show, showId) {
  return {
    id: showId,
    // Streaming shows carry a webChannel where broadcast ones carry a network;
    // the card only wants whichever one is there.
    network: show?.network?.name ?? show?.webChannel?.name ?? '',
    // The medium size only. The tile it fills is 38px across, so `original`
    // would be a poster-sized URL kept for a card that never asks for one.
    poster: show?.image?.medium ?? ''
  };
}

function idFromHref(href) {
  const match = /\/shows\/(\d+)/.exec(href ?? '');
  return match ? Number(match[1]) : null;
}
