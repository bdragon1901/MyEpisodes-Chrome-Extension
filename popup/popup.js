import { ApiError, dayKey, fetchEpisodes, weekOffsets, weekRange } from '../lib/api.js';
import { lookupShow, TvmazeError } from '../lib/tvmaze.js';
import { MarkError, nextMark, setMark } from '../lib/marks.js';
import { getSettings, isConfigured, openSettings } from '../lib/settings.js';
import { readCache, readCaches, readTvmazeShows, writeCache } from '../lib/cache.js';
import { createLookupQueue } from '../lib/lookup-queue.js';
import {
  byAirTime,
  describeNumbering,
  episodeKey,
  episodeTarget,
  episodeUrl,
  isPremiere,
  sameDay
} from '../lib/episodes.js';
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

const SVG_NS = 'http://www.w3.org/2000/svg';

// One entry per tab, in the order the strip shows them. All four are windows on
// the same endpoint now -- `/v1/me/episodes` with a `from` and a `to` -- so a
// tab is little more than the window it asks for and what to say when it comes
// back empty.
//
// `offset` is the day a tab covers relative to today, which both dates its
// heading and is the window it asks for. `span: 'week'` is the one exception:
// This Week covers Monday through Sunday rather than a single day, so it takes
// its window from weekRange() and dates its heading as a range. See tabWindow.
//
// `marksPremieres` puts a "New show" flag on a series premiere. It used to be
// All Today's alone, on the grounds that a show's first episode is only news
// where the list reaches past what is already followed. This Week earns it for
// a different reason: a week is long enough to hold a premiere of something on
// the watchlist that has not started yet, which is worth picking out of seven
// days of continuing runs. It costs no request either way -- the season and
// episode numbers are already on the item.
//
// `badges` marks the one tab whose count the toolbar badge mirrors. Every tab
// fills its cards in from TVmaze the same way; what keeps that affordable on a
// long list is that a card only asks once it is scrolled to -- see fillShow.
//
// Each tab's `id` doubles as the name of the cache it keeps -- see LISTS in
// lib/cache.js.
const TABS = [
  {
    id: 'yesterday',
    label: 'Yesterday',
    offset: -1,
    empty: {
      title: 'Nothing aired yesterday',
      detail: 'No episodes from your watchlist were scheduled.'
    }
  },
  {
    id: 'today',
    label: 'Today',
    offset: 0,
    badges: true,
    empty: {
      title: 'Nothing airing today',
      detail: 'No episodes from your watchlist are scheduled. Enjoy the night off.'
    }
  },
  {
    id: 'tomorrow',
    label: 'Tomorrow',
    offset: 1,
    empty: {
      title: 'Nothing airing tomorrow',
      detail: 'No episodes from your watchlist are scheduled yet.'
    }
  },
  {
    id: 'week',
    label: 'This Week',
    span: 'week',
    marksPremieres: true,
    empty: {
      title: 'Nothing airing this week',
      detail: 'No episodes from your watchlist are scheduled between Monday and Sunday.'
    }
  }
];

const DEFAULT_TAB = 'today';

const ICONS = {
  chevron: [['path', { d: 'M9 18l6-6-6-6' }]],
  clock: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M12 7.2V12l3.1 1.9' }]
  ],
  empty: [
    ['rect', { x: 2.5, y: 4, width: 19, height: 13, rx: 2.2 }],
    ['path', { d: 'M8 21h8' }],
    ['path', { d: 'M12 17v4' }]
  ],
  error: [
    ['path', { d: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z' }],
    ['path', { d: 'M12 9v4.5' }],
    ['path', { d: 'M12 17.2h.01' }]
  ],
  // A four-pointed spark, so a premiere reads as its own mark rather than as
  // another star rating.
  sparkle: [
    ['path', { d: 'M12 3.2l1.9 5.4 5.4 1.9-5.4 1.9-1.9 5.4-1.9-5.4-5.4-1.9 5.4-1.9z' }],
    ['path', { d: 'M18.4 15.2l.75 2.15 2.15.75-2.15.75-.75 2.15-.75-2.15-2.15-.75 2.15-.75z' }]
  ],
  setup: [
    ['path', { d: 'M4 7h10M18 7h2M4 17h2M10 17h10' }],
    ['circle', { cx: 16, cy: 7, r: 2.4 }],
    ['circle', { cx: 8, cy: 17, r: 2.4 }]
  ],
  check: [['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]],
  eye: [
    ['path', { d: 'M2.3 12S6.4 5.3 12 5.3 21.7 12 21.7 12 17.6 18.7 12 18.7 2.3 12 2.3 12z' }],
    ['circle', { cx: 12, cy: 12, r: 2.8 }]
  ]
};

const els = {
  refresh: document.getElementById('refresh'),
  settings: document.getElementById('settings'),
  status: document.getElementById('status'),
  // The panels scroll inside this, so it is what "on screen" is measured
  // against -- see the lookup observer below.
  scroller: document.querySelector('main')
};

// How far past the fold a card counts as worth fetching for. A screenful of
// slack means the artwork is usually there before the row carrying it is.
const VIEWPORT_MARGIN = '400px';

// Each tab owns its panel, its own status line, and whether it has been fetched
// yet -- panels load lazily, on first view.
const views = new Map(
  TABS.map((tab) => {
    const panel = document.querySelector(`[data-panel="${tab.id}"]`);
    const button = document.querySelector(`[data-tab="${tab.id}"]`);
    return [
      tab.id,
      {
        tab,
        button,
        // The strip's own copy of the day's number, so a tab can say what is
        // waiting behind it before it has ever been opened.
        tabCount: button.querySelector('[data-role="tab-count"]'),
        panel,
        date: panel.querySelector('[data-role="date"]'),
        count: panel.querySelector('[data-role="count"]'),
        body: panel.querySelector('[data-role="body"]'),
        status: '',
        // When the list on screen was fetched, for a status line that says how
        // old it is -- and keeps saying so as it ages. Null while the line is
        // something else ("Loading…", "Not configured").
        freshAt: null,
        freshNote: '',
        loaded: false,
        loading: false,
        // Whether this panel has taken its share of the one cache read the
        // popup makes on open -- see cachedDay.
        tookSharedCache: false,
        // Counts this panel's renders. A queued lookup carries the count it
        // was queued under, which is how render() retires it.
        generation: 0,
        // Watches this panel's cards for the moment they are scrolled to. One
        // per view, so re-rendering a list drops what it was watching without
        // touching the cards sitting in another tab's panel.
        watcher: new IntersectionObserver(onVisible, {
          root: els.scroller,
          rootMargin: VIEWPORT_MARGIN
        })
      }
    ];
  })
);

// One storage read answers both the tab strip's counts and the first paint of
// every panel. Asking per panel on top of this made three reads on open where
// two will do.
const cachesReady = readCaches().catch(() => new Map());

// A list says what is airing; the artwork behind each card comes from TVmaze.
// Decoration only: a lookup that fails leaves the card exactly as it was drawn.
//
// **MyEpisodes show id** -> { network, poster }, which is the change that makes
// this cheap. It used to be keyed by TVmaze episode id, because an RSS item
// identified itself only by a link to a TVmaze episode page -- so a watchlist
// following one show closely paid for a fresh lookup per episode of it, three
// episodes across three tabs being three requests for one answer. Every item
// now carries a show id, and a poster is a property of the show, so one lookup
// answers for every episode of it. The queue is keyed the same way, so two
// cards for one show on one list collapse into a single job before a request is
// even spent.
//
// Every answer the extension already has is read out of storage once, when the
// popup opens, and lives here for as long as it is open. A card is painted
// complete that way -- going back to storage per card put a read between every
// row and the next, and left the answers to pop in one by one on a list that
// had been seen before. Empty strings are a remembered "this show has no
// network / no artwork", which is an answer like any other and stops the lookup
// being asked for again.
const shows = new Map();

const NOTHING_KNOWN = Object.freeze({ network: '', poster: '' });

const showsReady = readTvmazeShows()
  .then((cached) => {
    for (const [showid, { show }] of cached) {
      shows.set(showid, { network: show.network ?? '', poster: show.poster ?? '' });
    }
  })
  .catch(() => {});

// What is left over after that -- new shows, mostly -- goes through the queue,
// which spends TVmaze's allowance for the whole popup. Because the map above is
// the whole of what is stored, anything reaching the queue is already known to
// be a cache miss, and `cached: false` saves it a read confirming so.
const lookups = createLookupQueue({
  run: (job) =>
    lookupShow(job.showid, {
      tvmazeShowId: job.tvmazeShowId,
      tvmazeEpisodeId: job.tvmazeEpisodeId,
      cached: false
    }),
  // A 429 means the bucket guessed wrong. Standing down and trying the show
  // again beats writing off every lookup for as long as the popup stays open.
  isRetryable: (error) => error instanceof TvmazeError && error.kind === 'rate-limit'
});

// The two ways to reach a TVmaze record. `external.tvmaze` is a show id on a
// show object and an episode id on an episode one, and which of those an item
// carries depends on how much of it the API filled in -- so both are passed and
// lookupShow picks. This used to have a third route, reading the id out of an
// RSS item's link with episodeIdFromUrl; every item carries its ids as fields
// now, so there is no link left to parse.
function tvmazeHints(item) {
  return {
    tvmazeShowId: item.tvmazeShowId ?? null,
    tvmazeEpisodeId: item.tvmazeEpisodeId ?? null
  };
}

// `target` is the pair of nodes a lookup fills in: the network chip, and the
// avatar tile sitting behind the show's initials.
//
// Both still come from TVmaze. `/v1/me/episodes` names the show and its
// timezone but not its network, so the chip is painted from the item first only
// to cover the day that changes -- today it finds nothing there, leaves the chip
// hidden, and the lookup fills it in as it always did.
//
// A remembered answer is free and goes on straight away. Anything else costs a
// request, so the card is only watched here -- it asks for its lookup when it is
// scrolled to, in onVisible below.
//
// That is what lets every tab do this. Today is a dozen rows and would be
// fetched either way, but This Week runs to sixty while the popup shows eight at
// a time: asking per row spent the whole rate limit on rows nobody scrolled to,
// which is why a list that long used to sit the lookups out entirely.
function fillShow(target, item, view) {
  paintNetwork(target, item.network);

  const showid = episodeTarget(item)?.showid ?? null;
  if (showid === null) return;

  if (shows.has(showid)) {
    paintShow(target, shows.get(showid), item);
    return;
  }

  watching.set(target.card, { target, item, showid, view, generation: view.generation });
  view.watcher.observe(target.card);
}

// Card element -> the lookup it will ask for. Weak so that cards dropped by a
// re-render take their entries with them.
const watching = new WeakMap();

function onVisible(entries, watcher) {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;

    // Asked for once. From here the job is the queue's business.
    watcher.unobserve(entry.target);
    const card = watching.get(entry.target);
    watching.delete(entry.target);
    if (card) lookups.request(lookupJob(card));
  }
}

// Whether the list a job was queued for is still the list on screen. Every
// render the card survives re-queues it under the new count, so a job holding
// an older one belongs to a card that is gone.
//
// isConnected cannot answer this. A card queues its lookup while it is still
// being built, before the list it belongs to has been put in the document, so
// asking then reports every card as detached -- which quietly dropped every
// lookup before it was ever made.
function lookupJob({ target, item, showid, view, generation }) {
  return {
    key: showid,
    ...tvmazeHints(item),
    showid,
    stale: () => generation !== view.generation,
    // The same show can sit on two tabs at once, and an earlier pass may have
    // answered this one while it sat in the queue. Either way the answer is in
    // hand and the card only needs painting with it.
    answered: () => {
      if (!shows.has(showid)) return false;
      paintShow(target, shows.get(showid), item);
      return true;
    },
    settle: ({ show }) => {
      shows.set(showid, { network: show.network, poster: show.poster });
      paintShow(target, shows.get(showid), item);
    },
    // A show TVmaze has no record of, a blip, a window that would not clear --
    // remembered as "nothing to show" so a re-render does not ask again.
    fail: () => {
      shows.set(showid, NOTHING_KNOWN);
      paintShow(target, NOTHING_KNOWN, item);
    }
  };
}

// An item's own network would win, being from the same source as the rest of
// the card -- but the API sends none, so in practice this always falls through
// to TVmaze. It is written as a preference rather than hardcoded to TVmaze
// because the field is the sort a list endpoint grows, and the day it does the
// chip should stop costing a request without anyone having to notice.
function paintShow(target, show, item) {
  paintNetwork(target, item.network || show.network);
  if (show.poster) setPoster(target.avatar, show.poster);
}

function paintNetwork(target, network) {
  target.network.textContent = network ?? '';
  target.network.hidden = !network;
}

// The artwork is laid over the monogram rather than swapped in for it, so the
// tile keeps its colour and initials while the image is on its way -- and keeps
// them for good if it never arrives. Nothing moves either way: the image fills
// a tile that was already exactly its size.
//
// A poster only goes on a tile once the browser holds it decoded, so it arrives
// in a single paint with its pixels ready. Artwork decoded earlier in the
// session goes on in the same task the card is built in, which is what stops a
// list that has been seen before -- a tab reopened, a day rebuilt by a refresh
// -- from painting its coloured tiles first and dropping the posters in a frame
// later. That one-frame gap is the flicker; the rest of this is about closing
// it for the first paint too, see warmPosters.
function setPoster(avatar, src) {
  // Painting the same artwork onto the same tile twice can only flicker.
  if (avatar.dataset.poster === src) return;
  avatar.dataset.poster = src;

  if (decoded.has(src)) {
    avatar.append(posterImage(src));
    return;
  }

  decodePoster(src).then((ok) => {
    // A poster that will not load leaves the initials showing rather than a
    // broken-image icon over the top of them. Either way the tile may have been
    // given other artwork, or dropped by a re-render, while the image was on
    // its way -- so nothing is touched unless it is still the tile that asked.
    if (avatar.dataset.poster !== src) return;
    if (!ok) delete avatar.dataset.poster;
    else if (avatar.isConnected) avatar.append(posterImage(src));
  });
}

function posterImage(src) {
  const img = new Image();
  img.className = 'episode__poster';
  img.alt = '';
  // The bitmap is in hand by the time this runs, so the browser is asked to
  // paint it with the frame it is already preparing rather than the one after.
  img.decoding = 'sync';
  img.src = src;
  return img;
}

// Poster URLs the browser has decoded this session, and the decodes still in
// flight. Both are keyed by URL rather than by card, because a card is not what
// repeats: the same show can sit on two tabs at once, and a day rebuilt after a
// refresh asks again for every poster it was already showing.
const decoded = new Set();
const decoding = new Map();

// Resolves true once the artwork is decoded and ready to paint, false if it
// never will be. The failure is remembered as much as the success -- a URL that
// cannot be served should not be fetched again by the next render.
function decodePoster(src) {
  let pending = decoding.get(src);
  if (pending) return pending;

  pending = (async () => {
    const img = new Image();
    img.src = src;
    try {
      await img.decode();
    } catch {
      return false;
    }
    decoded.add(src);
    return true;
  })();

  decoding.set(src, pending);
  return pending;
}

// Acquired and watched. Both arrive on the item itself now -- which is the
// single biggest thing the migration bought, since the feed carried no
// per-episode flag at all: acquired took a second filtered request to work out
// by difference, and watched could not be shown at any price.
//
// This map is the optimistic value shown while a write is in flight, and the
// value kept if there is no API key to write with -- see applyMark. It is keyed
// the way episodeKey keys everything, on the show/season/episode triple, so a
// mark set on one tab is picked up by the same episode sitting on another.
// Undefined means "go by what the list said".
const marks = new Map();

function resolvedMark(item) {
  const override = marks.get(episodeKey(item));
  return {
    acquired: override?.acquired ?? Boolean(item.acquired),
    watched: override?.watched ?? Boolean(item.watched)
  };
}

// Flips a mark, paints it straight away, and only then tries to tell
// MyEpisodes -- a click should feel instant, not wait on a round trip. No API
// key or an unaddressable episode leaves the flip exactly where it landed: a
// local mark is still worth more than a pill that refuses to move. A request
// that goes out and fails is different: the card goes back to what the click
// found and the view's status line says why, the same way a failed refresh
// does.
//
// Which value the other pill takes is nextMark's business, not this function's
// -- the API couples the two flags, and it is defined where that coupling is
// documented.
async function applyMark(item, kind, view, paint) {
  const key = episodeKey(item);
  const before = resolvedMark(item);
  const after = nextMark(before, kind);

  marks.set(key, after);
  paint(after);

  const { apiKey } = await getSettings();
  const target = episodeTarget(item);
  if (!apiKey || !target) return;

  try {
    await setMark(target, kind, after[kind], apiKey);
  } catch (error) {
    // Restore the snapshot rather than flipping a second time. Flipping twice
    // used to land back where it started, but the flags are coupled now and it
    // no longer does: un-acquiring a watched episode clears both, so flipping
    // acquired back on would leave watched wrongly off. Only the value the
    // click found says where to return to.
    marks.set(key, before);
    paint(before);
    flagMarkError(view, error);
  }
}

// Mirrors how a failed refresh is shown: appended to the freshness line
// if there is one to append to, since that is what is already on screen for
// almost every panel a card can sit in; a plain status write otherwise.
function flagMarkError(view, error) {
  const message = error instanceof MarkError ? error.message : 'Could not save your mark.';
  if (view.freshAt !== null) setFreshness(view, view.freshAt, message);
  else setViewStatus(view, message);
}

// A small toggle pill, built with no opinion yet about whether it starts on
// or off -- the caller paints that in once, and again on every toggle.
function markButton({ icon, label, kind }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `episode__mark episode__mark--${kind}`;
  button.setAttribute('aria-pressed', 'false');
  button.title = label;
  button.append(svgIcon(icon, 'episode__mark-icon'), document.createTextNode(label));
  return button;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// How long a list waits for artwork it already has the URLs for before going up
// without it. A poster the browser has cached decodes in a millisecond or two,
// so on a reopen the whole list clears this comfortably and arrives complete;
// the cap is for the first open on a cold cache, where waiting on the network
// would hold up the episodes themselves for the sake of their pictures.
const POSTER_WAIT_MS = 100;

// Every card whose poster is already known paints it as the card is built, so
// those decodes may as well be started -- and briefly waited on -- before the
// list goes up rather than after. The same images are fetched either way; what
// changes is whether they land in the list's first paint or the one after it.
//
// There used to be a second half to this, seeding the lookup map from items
// that arrived already knowing their own show. Nothing does: the API sends
// neither artwork nor a network. Seeding a show from a partial answer would
// have been worse than useless -- an entry in the map counts as the whole
// answer, so it would have recorded "this show has no poster" and stopped the
// one lookup still worth making.
async function prepare(items) {
  const pending = [];

  for (const item of items) {
    const showid = episodeTarget(item)?.showid ?? null;
    if (showid === null) continue;
    const src = shows.get(showid)?.poster;
    if (src && !decoded.has(src)) pending.push(decodePoster(src));
  }

  if (!pending.length) return;
  await Promise.race([Promise.all(pending), sleep(POSTER_WAIT_MS)]);
}

// How a panel dates itself: one day for the three day tabs, and the week's two
// ends for This Week. Both sides of the range come from weekOffsets, the same
// function tabWindow asks, so the heading names the week that was fetched.
function panelDate(tab) {
  if (tab.span !== 'week') return formatDate(dayFor(tab.offset));
  const { first, last } = weekOffsets();
  return formatDateRange(dayFor(first), dayFor(last));
}

let activeId = DEFAULT_TAB;

for (const view of views.values()) {
  view.date.textContent = panelDate(view.tab);
  view.button.addEventListener('click', () => selectTab(view.tab.id));
}

document.querySelector('.tabs').addEventListener('keydown', onTabKeydown);

// A plain link handed to the browser takes the focus with it, and a popup that
// loses focus is closed -- so one click would cost the whole list. Opening the
// tab ourselves, unfocused, leaves the popup up to be clicked again. Clicks
// already asking for a tab of their own (ctrl/cmd/shift, or a middle click that
// arrives here as one) are left to the browser, which does the same thing.
document.addEventListener('click', (event) => {
  const card = event.target.closest?.('a.episode');
  if (!card || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
  event.preventDefault();
  chrome.tabs.create({ url: card.href, active: false });
});

els.settings.addEventListener('click', openSettings);
els.refresh.addEventListener('click', () => load(activeId, { force: true }));

// "Updated 4m ago" is only true for a minute. The popup can sit open far longer
// than that, so the line is rewritten as it ages rather than left to lie.
const FRESHNESS_TICK_MS = 30_000;
setInterval(() => {
  for (const view of views.values()) if (view.freshAt !== null) writeFreshness(view);
}, FRESHNESS_TICK_MS);

load(activeId);
primeTabCounts();

function selectTab(id) {
  if (id === activeId) return;
  activeId = id;

  for (const view of views.values()) {
    const selected = view.tab.id === id;
    view.button.setAttribute('aria-selected', String(selected));
    if (selected) view.button.removeAttribute('tabindex');
    else view.button.setAttribute('tabindex', '-1');
    view.panel.hidden = !selected;
  }

  const view = views.get(id);
  // The strip scrolls when its tabs outrun the popup's width, so the tab just
  // chosen is brought into view -- otherwise the arrow keys could land on one
  // sitting off the edge. 'nearest' leaves a tab that is already visible where
  // it is rather than centring it and sliding the whole strip under the reader.
  view.button.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  setStatus(view.status);
  syncRefresh();
  if (!view.loaded) load(id);
}

// Left/right walk the strip and Home/End jump to its ends, the way a tablist is
// expected to.
function onTabKeydown(event) {
  const index = TABS.findIndex((tab) => tab.id === activeId);
  const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
  const next = step
    ? TABS[(index + step + TABS.length) % TABS.length]
    : { Home: TABS[0], End: TABS.at(-1) }[event.key];
  if (!next) return;

  event.preventDefault();
  selectTab(next.id);
  views.get(next.id).button.focus();
}

// A view keeps at most one request in flight. Switching away from a loading
// tab and back leaves the refresh button live, and a click there must not open
// a second pass whose response could land out of order on top of the first.
async function load(id, { force = false } = {}) {
  const view = views.get(id);
  if (view.loading) return;
  view.loading = true;
  syncRefresh();

  try {
    const settings = await getSettings();

    const missing = missingCredential(settings);
    if (missing) {
      setCount(view, null);
      render(view, state({
        icon: 'setup',
        ...missing,
        actions: [{ label: 'Open settings', onClick: openSettings }]
      }));
      setViewStatus(view, 'Not configured');
      return;
    }

    // Paint whatever is cached before the network runs, a forced refresh
    // included -- tearing down the list the user is looking at to put
    // placeholders in its place is worse than leaving a few-minute-old list up
    // until the new one replaces it. Every list here is refetched either way,
    // so `force` only changes what the status bar says while that happens.
    // The TVmaze read is one storage round trip shared by every card and every
    // tab, and it only has to land before a list is painted -- so it overlaps
    // the list cache read rather than holding up the settings check above,
    // which draws no cards at all.
    const [cached] = await Promise.all([cachedDay(view), showsReady]);
    if (cached) {
      // Artwork this list already knows about is given its short moment to
      // decode first, so the cards go up with their posters on rather than
      // flashing their coloured tiles for a frame.
      await prepare(cached.items);
      renderEpisodes(view, cached.items);
      if (force) setViewStatus(view, 'Refreshing…');
      else setFreshness(view, cached.fetchedAt);
    } else {
      setCount(view, null);
      render(view, skeletons());
      setViewStatus(view, 'Loading…');
    }

    view.loaded = true;
    try {
      const items = await fetchDay(view.tab, settings);
      if (view.tab.badges) setBadgeCount(items.length);
      // Most refreshes bring back the day that is already on screen. Rendering
      // it again would throw away every card and build it back identical --
      // which costs the posters their tiles and the reader a flicker, for a
      // list that did not change.
      if (!cached || !sameDay(cached.items, items)) {
        await prepare(items);
        renderEpisodes(view, items);
      }
      setFreshness(view, Date.now());
      // The day is on screen by now, so a cache write that fails costs the next
      // open its instant paint and nothing else. It must not reach the catch
      // below, which would replace episodes that arrived perfectly well with an
      // error state.
      await writeCache(view.tab.id, items).catch(() => {});
    } catch (error) {
      if (cached) {
        // Keep the stale list on screen, and keep saying how old it is -- the
        // age is exactly what makes a failed refresh readable. Losing it to the
        // error message left no sign the list had ever been current.
        setFreshness(view, cached.fetchedAt, describe(error));
      } else {
        // Nothing on screen worth keeping, so let the next visit retry.
        view.loaded = false;
        renderError(view, error);
        setViewStatus(view, '');
      }
    }
  } finally {
    view.loading = false;
    syncRefresh();
  }
}

// What the popup cannot load without, as the panel it should show instead.
//
// One question again. While All Today read the RSS feed this was two -- the API
// key for three tabs and the uid/token pair for the fourth -- and it was asked
// per tab so that a missing feed token cost one panel rather than the whole
// window. Every tab reads through the key now, so there is one credential and
// one answer.
function missingCredential(settings) {
  if (isConfigured(settings)) return null;
  return {
    title: 'Connect your account',
    detail: 'Add your MyEpisodes API key to see your schedule.'
  };
}

// The cache behind one panel. The first ask takes the panel's share of the one
// read made on open; every ask after that -- a refresh, a second visit -- wants
// whatever is on disk now rather than a snapshot from when the popup opened.
async function cachedDay(view) {
  if (view.tookSharedCache) return readCache(view.tab.id).catch(() => null);
  view.tookSharedCache = true;
  return (await cachesReady).get(view.tab.id) ?? null;
}

// Every tab carries its day's count, but only the open one is loaded on sight.
// The rest take theirs from the same cache read, which costs no requests --
// enough for the strip to answer "anything tomorrow?" before the tab is opened.
//
// A tab the cache cannot answer for is fetched rather than left bare. The
// cached lists are day-scoped, so every one of them misses on the first open after
// the date rolls over -- which is the state the extension is in every time it
// is opened after a few days away, with three tabs out of four showing no
// number at all until each is clicked one by one. That is the one thing the
// strip exists to say, so it is worth the requests to say it on open.
//
// The fetch is the tab's own load, run against its still-hidden panel: same
// source, same marks, same cache write, so the number arrives with the day
// behind it already painted and stored. Opening that tab then shows the list
// instead of skeletons, and costs nothing further. A warm cache still fetches
// only the open tab, the way it always has.
function primeTabCounts() {
  cachesReady
    .then((caches) => {
      for (const view of views.values()) {
        // The tab may have been opened while the read was in flight, and its
        // own numbers are newer than anything sitting on disk.
        if (view.loading || view.loaded) continue;
        const cached = caches.get(view.tab.id);
        if (cached) setTabCount(view, cached.items.length);
        else load(view.tab.id);
      }
    })
    .catch(() => {});
}

// Refresh acts on the visible panel, so it follows that panel's load.
function syncRefresh() {
  els.refresh.disabled = views.get(activeId).loading;
}

// The window a tab covers. Three of them are a single day; This Week is Monday
// through Sunday, and takes the same shape from weekRange so that the panel
// heading and the request cannot come to disagree about which week it is.
function tabWindow(tab) {
  if (tab.span === 'week') return weekRange();
  const day = dayKey(tab.offset);
  return { from: day, to: day };
}

// One request per tab, which is the whole of it now.
//
// This used to fork on where a tab read from: three went to the API and All
// Today fetched rss.php, then made a second request for the watchlist's own
// today so it could mark which of its shows were followed. Every tab is a
// window on `/v1/me/episodes`, every row is a show the account follows, and the
// flags the popup used to work out by difference arrive on the row.
function fetchDay(tab, { apiKey }) {
  return fetchEpisodes({ apiKey, ...tabWindow(tab) });
}

function renderEpisodes(view, items) {
  setCount(view, items.length);

  if (!items.length) {
    render(view, state({ icon: 'empty', ...view.tab.empty }));
    return;
  }

  const list = document.createElement('ul');
  list.className = 'episodes';

  // The empty list goes in first, and the cards are built into it after. Order
  // matters both ways: render() retires the lookups the last contents were
  // waiting on, so building beforehand would strand every card it just made --
  // and a card appended to a list already on screen is watchable straight away,
  // rather than waiting for the swap to make it so.
  render(view, list);
  for (const item of byAirTime(items)) list.append(episodeCard(item, view));
}

function episodeCard(item, view) {
  const entry = document.createElement('li');

  // Read off the numbering the item already carries, so it costs no request and
  // every card can answer for itself.
  const premiere = Boolean(view.tab.marksPremieres) && isPremiere(item);

  const card = document.createElement('a');
  card.className = 'episode';
  card.href = episodeUrl(item.link);
  card.target = '_blank';
  card.rel = 'noreferrer';
  if (premiere) card.classList.add('episode--premiere');

  const avatar = document.createElement('div');
  avatar.className = 'episode__avatar';
  avatar.style.background = avatarGradient(item.show);
  avatar.setAttribute('aria-hidden', 'true');

  // The initials are their own node now, because a poster is laid over them
  // rather than replacing them -- see setPoster.
  const monogram = document.createElement('span');
  monogram.className = 'episode__monogram';
  monogram.textContent = initials(item.show);
  avatar.append(monogram);

  const text = document.createElement('div');
  text.className = 'episode__text';

  // Show name on the top line with the season/episode badge beside it, then
  // the episode title with the broadcast time -- the two right-hand items line
  // up into a rail that can be scanned down the column.
  const head = document.createElement('div');
  head.className = 'episode__head';

  const show = document.createElement('div');
  show.className = 'episode__show';
  show.textContent = item.show;
  head.append(show);

  const network = document.createElement('span');
  network.className = 'episode__network';
  network.hidden = true;
  head.append(network);
  // Fills both in place if the answer is already known, so a list that has been
  // opened before paints complete rather than in two stages.
  fillShow({ card, network, avatar }, item, view);

  const numbering = describeNumbering(item);
  if (numbering) {
    const code = document.createElement('span');
    code.className = 'episode__code';
    code.textContent = numbering;
    head.append(code);
  }
  text.append(head);

  // Always built now, rather than only for a card with something to put on
  // it -- the two mark buttons live here and every card carries those.
  const sub = document.createElement('div');
  sub.className = 'episode__sub';

  const name = document.createElement('span');
  name.className = 'episode__name';
  name.textContent = item.episode;
  sub.append(name);

  // On the rail rather than up beside the show name, where it used to sit:
  // the mark reads as part of the same stamp as the date it precedes -- a
  // show arriving, and the day it arrives on -- and the top line is left to
  // the show's own name, which is what a long one needed. The card carries
  // the mark as well -- see .episode--premiere, which is also where the one
  // card that can hold both decides which gets its edge.
  if (premiere) {
    const badge = document.createElement('span');
    badge.className = 'episode__premiere';
    badge.append(svgIcon('sparkle', 'episode__premiere-icon'), 'New show');
    sub.append(badge);
  }

  if (item.airTime) {
    const time = document.createElement('span');
    time.className = 'episode__time';
    time.append(svgIcon('clock', 'episode__clock'), formatTime(item.airTime));
    sub.append(time);
  }

  // The two marks a viewer can set from here, rather than only read.
  // Acquired doubles as the card's own tint -- the same green an
  // already-acquired episode arrives wearing -- so flipping it here reads
  // exactly like MyEpisodes having said so. Watched carries no such tint: a
  // card can already wear both acquired and premiere at once, and a third
  // colour competing for the same border was one too many, so watched only
  // ever speaks through its own pill.
  const acquiredMark = markButton({ icon: 'check', label: 'Acquired', kind: 'acquired' });
  const watchedMark = markButton({ icon: 'eye', label: 'Watched', kind: 'watched' });
  const markGroup = document.createElement('div');
  markGroup.className = 'episode__marks';
  markGroup.append(acquiredMark, watchedMark);
  sub.append(markGroup);

  text.append(sub);
  card.append(avatar, text, svgIcon('chevron', 'episode__chevron'));
  entry.append(card);

  // The one place this card's marks reach the page, whether that is the
  // first paint or a toggle -- so the card, its pills, and its tooltip can
  // never fall out of step with each other.
  const paint = (state) => {
    card.classList.toggle('episode--acquired', state.acquired);
    acquiredMark.classList.toggle('episode__mark--active', state.acquired);
    acquiredMark.setAttribute('aria-pressed', String(state.acquired));
    watchedMark.classList.toggle('episode__mark--active', state.watched);
    watchedMark.setAttribute('aria-pressed', String(state.watched));

    const notes = [item.rawTitle];
    if (state.acquired) notes.push('Already acquired');
    if (premiere) notes.push('Series premiere');
    if (state.watched) notes.push('Watched');
    card.title = notes.join('\n');
  };
  paint(resolvedMark(item));

  // Both stop the click before it reaches the anchor: without preventDefault
  // the browser still navigates the link the button sits inside, and without
  // stopPropagation the document-level handler that opens a background tab
  // for any click on `a.episode` (see below) would open one for this too.
  acquiredMark.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    applyMark(item, 'acquired', view, paint);
  });
  watchedMark.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    applyMark(item, 'watched', view, paint);
  });

  return entry;
}

function skeletons() {
  const wrap = document.createElement('div');
  wrap.className = 'episodes';

  for (let i = 0; i < 3; i += 1) {
    const row = document.createElement('div');
    row.className = 'skeleton';
    row.style.opacity = String(1 - i * 0.22);

    const avatar = document.createElement('div');
    avatar.className = 'skeleton__avatar';

    const text = document.createElement('div');
    text.className = 'skeleton__text';
    const wide = document.createElement('div');
    wide.className = 'skeleton__line';
    const short = document.createElement('div');
    short.className = 'skeleton__line skeleton__line--short';
    text.append(wide, short);

    row.append(avatar, text);
    wrap.append(row);
  }
  return wrap;
}

// Anything the settings page could fix, and what to say about it. A network
// failure is deliberately not on this list: the credential is not what stopped
// the request leaving, and telling someone whose wifi is down to check their
// key sends them after the wrong thing.
//
// This used to read two clients' errors apart, so that a feed failure named the
// feed token and an API failure named the key -- naming the wrong one would
// send the reader to the wrong field. There is one client now, so `scope` is
// the only case still worth separating: that key is real and only too narrow,
// and asking for a new one would point its holder at the part that works.
function errorAdvice(error) {
  if (!(error instanceof ApiError)) return null;

  if (error.kind === 'auth') {
    return {
      title: 'Sign-in rejected',
      detail:
        'MyEpisodes did not accept your API key. Keys can be revoked or expire, ' +
        'so open settings and paste a fresh one.',
      settingsFirst: true
    };
  }

  if (error.kind === 'scope') {
    return {
      title: 'API key too narrow',
      detail:
        'This key is valid, but only a "write" key covers both the lists and ' +
        'the marks. Paste one of those in settings.',
      settingsFirst: true
    };
  }

  return null;
}

function renderError(view, error) {
  setCount(view, null);

  const advice = errorAdvice(error) ?? {
    title: `Could not load ${view.tab.label.toLowerCase()}`,
    detail: describe(error)
  };

  const settings = { label: 'Open settings', onClick: openSettings };
  const retry = { label: 'Try again', onClick: () => load(view.tab.id, { force: true }) };

  render(view, state({
    icon: 'error',
    variant: 'error',
    title: advice.title,
    detail: advice.detail,
    // The action to take goes first. That is the settings page when the
    // credentials are what failed, and retrying when anything else did.
    actions: advice.settingsFirst ? [settings, retry] : [retry, settings]
  }));
}

function state({ icon, title, detail, actions = [], variant }) {
  const box = document.createElement('div');
  box.className = variant ? `state state--${variant}` : 'state';

  if (icon) box.append(svgIcon(icon, 'state__icon'));

  const heading = document.createElement('div');
  heading.className = 'state__title';
  heading.textContent = title;
  box.append(heading);

  if (detail) {
    const text = document.createElement('p');
    text.className = 'state__detail';
    text.textContent = detail;
    box.append(text);
  }

  if (actions.length) {
    const wrap = document.createElement('div');
    wrap.className = 'state__actions';
    // The first action is the one to take; any others sit beside it, quieter.
    for (const [index, action] of actions.entries()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = index === 0 ? 'button button--primary' : 'button';
      button.textContent = action.label;
      button.addEventListener('click', action.onClick);
      wrap.append(button);
    }
    box.append(wrap);
  }

  return box;
}

function svgIcon(name, className) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);

  for (const [tag, attrs] of ICONS[name]) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) shape.setAttribute(key, value);
    svg.append(shape);
  }
  return svg;
}

// The single place a panel's contents are swapped, and so the single place that
// has to retire whatever the last contents were still waiting on: cards that
// are gone are never scrolled to, and an observer holds on to what it watches.
// Jobs already in the queue are retired by the same count -- see lookupJob().
function render(view, node) {
  view.generation += 1;
  view.watcher.disconnect();
  view.body.replaceChildren(node);
}

// `count` is a number to show, or null while there is nothing to count yet
// (loading, unconfigured, failed). The panel's pill and the tab's own number
// say the same thing in two places, so they are written together.
function setCount(view, count) {
  setTabCount(view, count);

  const el = view.count;

  if (count === null) {
    el.hidden = true;
    el.replaceChildren();
    return;
  }

  const noun = episodeNoun(count);
  const dot = document.createElement('span');
  dot.className = 'panel__count-dot';
  const number = document.createElement('span');
  number.className = 'panel__count-num';
  number.textContent = String(count);
  const label = document.createElement('span');
  label.className = 'panel__count-label';
  label.textContent = noun;

  el.classList.toggle('panel__count--empty', count === 0);
  el.setAttribute('aria-label', `${count} ${noun}`);
  el.replaceChildren(dot, number, label);
  el.hidden = false;
}

// The number on the tab itself. Zero is shown rather than hidden -- "nothing
// tomorrow" is exactly the answer the strip is there to give without a click.
function setTabCount(view, count) {
  const el = view.tabCount;

  if (count === null) {
    el.hidden = true;
    el.textContent = '';
    view.button.removeAttribute('aria-label');
    return;
  }

  el.textContent = String(count);
  el.classList.toggle('tab__count--empty', count === 0);
  el.hidden = false;
  // The chip is aria-hidden, so the count reaches assistive tech through the
  // tab's own name instead, where it can be said in words rather than read as
  // a digit stuck onto the end of the label.
  view.button.setAttribute('aria-label', `${view.tab.label}, ${count} ${episodeNoun(count)}`);
}

// The status bar is shared, so every panel keeps its own line and only the
// visible one gets to write it.

// A line that ages: how old the list on screen is, and optionally what went
// wrong trying to replace it. Kept as the two parts rather than the finished
// string, so the ticker can rewrite it a minute later without losing either.
function setFreshness(view, fetchedAt, note = '') {
  view.freshAt = fetchedAt;
  view.freshNote = note;
  writeFreshness(view);
}

function writeFreshness(view) {
  const age = `Updated ${relativeTime(view.freshAt)}`;
  publishStatus(view, view.freshNote ? `${age} · ${view.freshNote}` : age);
}

// A line that says the same thing however long it sits there.
function setViewStatus(view, message) {
  view.freshAt = null;
  view.freshNote = '';
  publishStatus(view, message);
}

function publishStatus(view, message) {
  view.status = message;
  if (view.tab.id === activeId) setStatus(message);
}

function setStatus(message) {
  els.status.textContent = message;
}

// The service worker owns the badge, but a refresh here has a newer number than
// the next alarm will, so hand it straight over.
function setBadgeCount(count) {
  chrome.action.setBadgeText({ text: count ? String(count) : '' });
}

function describe(error) {
  // A lookup's failures come from TVmaze rather than from MyEpisodes, and its
  // messages already name which of them it was.
  if (error instanceof TvmazeError) return error.message;

  // The API sends a message written to be read and lib/api.js keeps it rather
  // than paraphrasing, which is why there is nothing left to translate here.
  if (error instanceof ApiError) return error.message;

  return 'Something went wrong loading your episodes.';
}
