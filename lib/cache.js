// The caches the extension keeps in chrome.storage.local.
//
// Day lists are day-scoped: every list is relative to today, so entries are
// only reused within the same calendar day and all go stale once the date rolls
// over. The popup reads and writes them; the settings page drops them when the
// credentials change.
//
// TVmaze lookups are age-scoped instead. Nothing about a show is tied to the
// account, and the data barely moves, so those entries outlive the day and
// survive a credential change -- see readTvmazeShow below.

const PREFIX = 'cache:';

// The cached day lists, by the tab that owns each one, which is what a read of
// all of them has to name.
export const LISTS = Object.freeze(['yesterday', 'today', 'tomorrow', 'week']);

// The shape of the items inside a cached list. A list is already day-scoped, so
// this is not what keeps one fresh -- it expires nightly on its own. It is for
// the upgrade day: a list cached in the old RSS item shape would otherwise have
// been read back into an API-backed tab and rendered as episodes missing half
// their fields. Checked alongside `day`, it makes that read a miss instead.
// Bump it whenever the item shape the popup paints from changes.
const LIST_VERSION = 3;

export async function readCache(list) {
  const key = PREFIX + list;
  const { [key]: cache } = await chrome.storage.local.get(key);
  return usable(cache, todayKey()) ? cache : null;
}

export async function writeCache(list, items) {
  await chrome.storage.local.set({
    [PREFIX + list]: { day: todayKey(), version: LIST_VERSION, fetchedAt: Date.now(), items }
  });
}

// Every list in one round trip. The popup opens wanting the active tab's list
// and a count for each of the other tabs, and asking four times costs four
// times the latency for the same bytes. Misses -- never written, written on
// another day, or written to an older shape -- come back as null, the way
// readCache reports one.
export async function readCaches() {
  const stored = await chrome.storage.local.get(LISTS.map((list) => PREFIX + list));
  const day = todayKey();

  return new Map(
    LISTS.map((list) => {
      const cache = stored[PREFIX + list];
      return [list, usable(cache, day) ? cache : null];
    })
  );
}

// Whatever is cached was fetched with the old credentials, so it goes out with
// them -- otherwise a failed first refresh would leave the previous account's
// episodes sitting on screen. The TVmaze entries stay: they describe shows, not
// an account, and are as good for the next one as they were for the last.
export async function clearCache() {
  // remove() ignores names that were never written, so naming every list costs
  // nothing and saves reading the store back to find out which ones are there.
  await chrome.storage.local.remove(LISTS.map((list) => PREFIX + list));
}

function usable(cache, day) {
  return Boolean(cache) && cache.day === day && cache.version === LIST_VERSION;
}

function todayKey() {
  return new Date().toDateString();
}

// Every TVmaze lookup the extension has made, under one key:
//
//   { version, shows: { <myepisodes showid>: { fetchedAt, show } } }
//
// Keyed by MyEpisodes show id, which is the one number every item carries as a
// field, so episodeTarget() reads it straight off. Everything stored here
// describes a show, so that is the key it belongs under: one entry per show and
// one lookup per show, however many of the show's episodes a day happens to
// hold. Keyed by TVmaze episode id, as the RSS-only version had to be, a
// watchlist that follows one show closely paid for a fresh lookup per episode
// of it -- three episodes across three tabs meant three requests for the same
// answer.
//
// Two tiers have been left behind on the way here: the full TVmaze record per
// episode, under its own cache:tvmaze:<id> key, which nothing ever read; and
// the episode index that used to point into the shows. sweepLegacyDetail takes
// out both.
const TVMAZE_KEY = 'cache:tvmaze';
const LEGACY_DETAIL_PREFIX = 'cache:tvmaze:';

// A show's status, artwork, or genres change over months, not hours, and a
// stale week costs nothing next to a request per show per popup.
export const TVMAZE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Age alone bounds nothing: an entry only expires a week after it was fetched,
// and a watchlist churned through inside that week could keep adding entries
// and walk the store into chrome.storage's quota, where every write fails
// silently and the cache quietly stops being one. One entry per show is a far
// smaller thing to bound than one per episode was -- a watchlist runs to a few
// hundred shows at most -- so 500 sits above what any real account produces
// while a few hundred bytes per summary keeps the whole store orders of
// magnitude below the 10MB the area allows.
export const TVMAZE_MAX_SHOWS = 500;

// The stored shape, stamped into what is written. The popup paints straight out
// of these fields, so changing one has to invalidate what is already stored --
// otherwise a card waits out the week's max age before it can show what was
// just added. Bump this whenever showSummary or the store's shape changes.
const TVMAZE_INDEX_VERSION = 5;

// What the cache keeps of a show, which is exactly what a card paints: the
// network chip and the poster on the avatar tile.
//
// It used to keep the show's TVmaze id, name and URL as well. Nothing read any
// of the three -- the card links to the episode page MyEpisodes named, and the
// entry is filed under the MyEpisodes show id, so TVmaze's own id was not even
// the key -- and they were written for every cached show. This is also the
// boundary that lets lib/tvmaze.js stop building the rest: it can only drop a
// field the stored shape does not ask for.
export function showSummary(show) {
  return {
    network: show.network ?? '',
    poster: show.poster ?? ''
  };
}

// One lookup: when it was fetched, and the show it found.
export async function readTvmazeShow(showid, { maxAge = TVMAZE_MAX_AGE_MS } = {}) {
  const { shows } = await readTvmazeStore();

  const entry = shows[showid];
  if (!entry?.show || !fresh(entry.fetchedAt, maxAge)) return null;

  return { fetchedAt: entry.fetchedAt, show: entry.show };
}

// Every lookup at once, for a caller about to ask about a listful of episodes.
// The popup reads this when it opens and answers every card from memory after
// that, rather than going back to storage per card.
export async function readTvmazeShows({ maxAge = TVMAZE_MAX_AGE_MS } = {}) {
  const { shows } = await readTvmazeStore();

  const fetched = new Map();
  for (const [id, entry] of Object.entries(shows)) {
    if (!entry?.show || !fresh(entry.fetchedAt, maxAge)) continue;
    // Keyed by number, the way a show id arrives on an item.
    fetched.set(Number(id), { fetchedAt: entry.fetchedAt, show: entry.show });
  }
  return fetched;
}

// chrome.storage offers no read-modify-write, and this is one: the store is
// read, added to, and written back. Two writers overlapping each read the same
// store and each write their own entry over the other's, so the second to land
// wins and the first lookup is simply lost. That is not a corner -- the popup
// runs several lookups at once and their answers arrive together, which used to
// leave one entry in the store out of every four fetched. So writes queue
// behind one another, and each one reads what the last stored.
let writing = Promise.resolve();

export function writeTvmazeShow(showid, summary, options) {
  const done = writing.then(() => storeTvmazeShow(showid, summary, options));
  // The queue has to outlive a failed write -- the next writer is still owed
  // its turn -- so the chain swallows the error and the caller keeps it.
  writing = done.catch(() => {});
  return done;
}

async function storeTvmazeShow(showid, summary, { maxAge = TVMAZE_MAX_AGE_MS } = {}) {
  const stored = await readTvmazeStore();

  const shows = { ...stored.shows, [showid]: { fetchedAt: Date.now(), show: summary } };

  // Expire on write rather than on read: entries are only ever read by id, so
  // the ones nothing asks for again -- a show dropped from the watchlist, say
  // -- would otherwise sit in storage forever.
  for (const [id, entry] of Object.entries(shows)) {
    if (!fresh(entry.fetchedAt, maxAge)) delete shows[id];
  }

  // Then the cap, oldest first, so what survives is what was wanted most
  // recently. The entry just written is held out of the sort rather than
  // trusted to be the newest in it: a caller that has just paid for a lookup
  // has to be able to read it back, whatever the stored timestamps say.
  const over = Object.keys(shows).length - TVMAZE_MAX_SHOWS;
  if (over > 0) {
    const oldest = Object.entries(shows)
      .filter(([id]) => id !== String(showid))
      .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)
      .slice(0, over);
    for (const [id] of oldest) delete shows[id];
  }

  if (stored.legacy) await sweepLegacyDetail();
  await chrome.storage.local.set({
    [TVMAZE_KEY]: { version: TVMAZE_INDEX_VERSION, shows }
  });
}

async function readTvmazeStore() {
  const { [TVMAZE_KEY]: stored } = await chrome.storage.local.get(TVMAZE_KEY);

  // A store written to an older shape reads as empty rather than as entries
  // missing half their fields -- and the shape before this one was keyed by
  // TVmaze episode id, a number nothing here looks anything up by any more.
  // `legacy` tells a write that an earlier version wrote it, and so that there
  // may be an episode tier and detail records behind it.
  if (stored?.version !== TVMAZE_INDEX_VERSION) {
    return { shows: {}, legacy: Boolean(stored) };
  }

  return { shows: stored.shows ?? {}, legacy: false };
}

// What earlier versions left behind: the cache:tvmaze:<id> detail records that
// versions up to 0.15.0 wrote and nothing ever read, and the episodes tier that
// sat inside cache:tvmaze until it was keyed by show. Nothing names either any
// more, so they would hold storage until the profile was wiped. Both come out
// in the one whole-storage scan worth doing, which happens once, on the first
// write after the upgrade -- after it the store carries the current version and
// no read reports it as legacy again.
//
// The old index is removed here rather than left for the write that follows to
// overwrite, even though that write replaces the whole key: the episode tier
// could hold thousands of rows, and if the area is near quota that is precisely
// the space the write needs to succeed.
async function sweepLegacyDetail() {
  const stored = await chrome.storage.local.get(null);

  const stale = Object.keys(stored).filter((key) => key.startsWith(LEGACY_DETAIL_PREFIX));
  if (stored[TVMAZE_KEY]?.episodes) stale.push(TVMAZE_KEY);

  if (stale.length) await chrome.storage.local.remove(stale);
}

// A negative age means the clock moved backwards under a stored entry, which
// leaves no way to tell how old it really is -- treat it as expired.
function fresh(fetchedAt, maxAge) {
  const age = Date.now() - fetchedAt;
  return age >= 0 && age < maxAge;
}
