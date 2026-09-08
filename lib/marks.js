// Writes a viewer's own acquired/watched state back to MyEpisodes.
//
//   PUT https://api.myepisodes.com/v1/me/episodes/<show id>/<season>/<episode>
//   { "acquired": true }   or   { "watched": true }
//
// The three path segments are the triple episodeTarget() reads off an item --
// see lib/episodes.js, which is also what lets a mark set on one tab land on
// the same episode sitting on another.
//
// This needs a `write`-scope key. A `read` key reaches the endpoint and is
// turned down with 403, which is a different problem from a key that is not
// valid at all -- see the kinds below.

import { ApiError, request } from './api.js';

export class MarkError extends Error {
  constructor(message, { kind = 'unknown' } = {}) {
    super(message);
    this.name = 'MarkError';
    // 'network' | 'auth' | 'scope' | 'refused' | 'notfound' | 'rate-limit' | 'http'
    this.kind = kind;
  }
}

// The API couples the two flags, and not symmetrically:
//
//   "watched" implies "acquired"            -- you cannot have seen an episode
//                                              you never got hold of.
//   clearing "acquired" clears the episode  -- the row is deleted outright, so
//                                              watched goes with it. Asking for
//                                              { acquired: false, watched: true }
//                                              is a 422 rather than a guess.
//
// So a click on one pill can move the other, and this is the pure function that
// says how. It mirrors what the server is about to do rather than deciding
// anything itself, which is what lets the popup paint the result instantly and
// still send a single field -- the implication happens at the far end either
// way, and sending both would be the request the API refuses.
export function nextMark(current, kind) {
  const value = !current[kind];

  if (kind === 'watched') {
    // Marking watched acquires it too; unwatching leaves it acquired, which is
    // the true state -- the file is still on disk.
    return { acquired: value || current.acquired, watched: value };
  }

  // Un-acquiring throws the episode's whole state away, watched included.
  return value ? { acquired: true, watched: current.watched } : { acquired: false, watched: false };
}

// One field at a time -- the caller already knows which pill it flipped, and
// sending only that key leaves the other exactly as MyEpisodes has it, letting
// the coupling above happen server-side where it is defined.
export async function setMark({ showid, season, episode }, kind, value, apiKey) {
  try {
    await request(`/me/episodes/${showid}/${season}/${episode}`, {
      apiKey,
      method: 'PUT',
      body: { [kind]: value }
    });
  } catch (error) {
    throw asMarkError(error);
  }
}

// The API's own message is written for a person and is usually the better one,
// so it is kept wherever it arrived. These override it only where the popup can
// say something more useful than a bare status -- above all for 403, where the
// key is real and only too narrow: sending its holder off to re-authenticate
// would point them at something that is not broken.
const MESSAGES = {
  auth: 'MyEpisodes rejected the API key.',
  scope: 'This API key cannot mark episodes -- it needs write scope.',
  refused: 'MyEpisodes would not accept that combination of marks.',
  network: 'Could not reach api.myepisodes.com.'
};

function asMarkError(error) {
  if (!(error instanceof ApiError)) return new MarkError('Could not save your mark.');
  return new MarkError(MESSAGES[error.kind] ?? error.message, { kind: error.kind });
}
