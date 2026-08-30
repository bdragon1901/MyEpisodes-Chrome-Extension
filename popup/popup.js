import { fetchFeed, FeedError } from '../lib/myepisodes.js';
import { getSettings, isConfigured, openSettings } from '../lib/settings.js';
import { readCache, writeCache } from '../lib/cache.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// One entry per tab, in the order the strip shows them. `feed` is the
// MyEpisodes feed name; `offset` is the day that feed covers relative to today,
// which is what the panel heading dates. `tracksAcquired` costs a second
// request, so it is off for tomorrow -- nothing has aired yet to acquire -- and
// for All Today, which reaches past the watchlist the acquired marks come from.
// `badges` marks the one tab whose count the toolbar badge mirrors.
const TABS = [
  {
    id: 'yesterday',
    feed: 'yesterday',
    label: 'Yesterday',
    offset: -1,
    tracksAcquired: true,
    empty: {
      title: 'Nothing aired yesterday',
      detail: 'No episodes from your watchlist were scheduled.'
    }
  },
  {
    id: 'today',
    feed: 'today',
    label: 'Today',
    offset: 0,
    tracksAcquired: true,
    badges: true,
    empty: {
      title: 'Nothing airing today',
      detail: 'No episodes from your watchlist are scheduled. Enjoy the night off.'
    }
  },
  {
    id: 'tomorrow',
    feed: 'tomorrow',
    label: 'Tomorrow',
    offset: 1,
    empty: {
      title: 'Nothing airing tomorrow',
      detail: 'No episodes from your watchlist are scheduled yet.'
    }
  },
  {
    id: 'alltoday',
    feed: 'all',
    label: 'All Today',
    offset: 0,
    empty: {
      title: 'Nothing airing today',
      detail: 'No episodes are scheduled for today.'
    }
  }
];

const DEFAULT_TAB = 'today';

const HOME_URL = 'https://www.myepisodes.com/';

// Hues chosen to stay legible behind white text -- the yellow-green band is
// skipped because it goes muddy at the lightness the avatars use.
const AVATAR_HUES = [210, 250, 282, 320, 348, 12, 32, 168, 192, 140];

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

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
  setup: [
    ['path', { d: 'M4 7h10M18 7h2M4 17h2M10 17h10' }],
    ['circle', { cx: 16, cy: 7, r: 2.4 }],
    ['circle', { cx: 8, cy: 17, r: 2.4 }]
  ]
};

const els = {
  refresh: document.getElementById('refresh'),
  settings: document.getElementById('settings'),
  status: document.getElementById('status')
};

// Each tab owns its panel, its own status line, and whether it has been fetched
// yet -- panels load lazily, on first view.
const views = new Map(
  TABS.map((tab) => {
    const panel = document.querySelector(`[data-panel="${tab.id}"]`);
    return [
      tab.id,
      {
        tab,
        button: document.querySelector(`[data-tab="${tab.id}"]`),
        panel,
        date: panel.querySelector('[data-role="date"]'),
        count: panel.querySelector('[data-role="count"]'),
        body: panel.querySelector('[data-role="body"]'),
        status: '',
        loaded: false,
        loading: false
      }
    ];
  })
);

let activeId = DEFAULT_TAB;

for (const view of views.values()) {
  view.date.textContent = formatDate(dayFor(view.tab.offset));
  view.button.addEventListener('click', () => selectTab(view.tab.id));
}

document.querySelector('.tabs').addEventListener('keydown', onTabKeydown);
els.settings.addEventListener('click', openSettings);
els.refresh.addEventListener('click', () => load(activeId, { force: true }));

load(activeId);

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
  setStatus(view.status);
  syncRefresh();
  if (!view.loaded) load(id);
}

// Left/right walk the strip, the way a tablist is expected to.
function onTabKeydown(event) {
  const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
  if (!step) return;

  event.preventDefault();
  const index = TABS.findIndex((tab) => tab.id === activeId);
  const next = TABS[(index + step + TABS.length) % TABS.length];
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

    if (!isConfigured(settings)) {
      setCount(view, null);
      render(view, state({
        icon: 'setup',
        title: 'Connect your account',
        detail: 'Add your MyEpisodes username and feed token to see your schedule.',
        actions: [{ label: 'Open settings', onClick: openSettings }]
      }));
      setViewStatus(view, 'Not configured');
      return;
    }

    const cached = force ? null : await readCache(view.tab.feed);
    if (cached) {
      renderEpisodes(view, cached.items);
      setViewStatus(view, `Updated ${relativeTime(cached.fetchedAt)}`);
    } else {
      setCount(view, null);
      render(view, skeletons());
      setViewStatus(view, 'Loading…');
    }

    view.loaded = true;
    try {
      const items = await fetchDay(view.tab, settings);
      await writeCache(view.tab.feed, items);
      if (view.tab.badges) setBadgeCount(items.length);
      renderEpisodes(view, items);
      setViewStatus(view, 'Updated just now');
    } catch (error) {
      if (cached) {
        // Keep the stale list on screen rather than blanking it out.
        setViewStatus(view, describe(error));
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

// Refresh acts on the visible panel, so it follows that panel's load.
function syncRefresh() {
  els.refresh.disabled = views.get(activeId).loading;
}

// The feed has no per-episode acquired flag, so ask twice: the whole day, and
// the same day filtered to what is still unacquired. Anything missing from the
// second list is already on disk. The filtered request is best-effort -- if it
// fails, the day still renders, just without the marks.
async function fetchDay(tab, settings) {
  const [all, pending] = await Promise.all([
    fetchFeed({ feed: tab.feed, ...settings }),
    tab.tracksAcquired
      ? fetchFeed({ feed: tab.feed, onlyunacquired: true, ...settings }).catch(() => null)
      : null
  ]);

  if (!pending) return all.items;

  const stillPending = new Set(pending.items.map(episodeKey));
  return all.items.map((item) => ({ ...item, acquired: !stillPending.has(episodeKey(item)) }));
}

// guid is the join key when the feed sends one; the show and code together are
// specific enough to stand in when it does not.
function episodeKey(item) {
  return item.guid || `${item.show}|${item.code}`;
}

function renderEpisodes(view, items) {
  setCount(view, items.length);

  if (!items.length) {
    render(view, state({ icon: 'empty', ...view.tab.empty }));
    return;
  }

  const list = document.createElement('ul');
  list.className = 'episodes';
  for (const item of byAirTime(items)) list.append(episodeCard(item));
  render(view, list);
}

// A day reads as a schedule, so run it in broadcast order. Episodes the feed
// gave no time for sort to the end, keeping the order they arrived in.
function byAirTime(items) {
  return [...items].sort((a, b) => {
    const left = clockMinutes(a);
    const right = clockMinutes(b);
    return left === right ? 0 : left - right;
  });
}

function clockMinutes({ airTime }) {
  return airTime ? airTime.hours * 60 + airTime.minutes : Infinity;
}

function episodeCard(item) {
  const entry = document.createElement('li');

  const card = document.createElement('a');
  card.className = 'episode';
  card.href = episodeUrl(item.link);
  card.target = '_blank';
  card.rel = 'noreferrer';
  card.title = item.acquired ? item.rawTitle + '\nAlready acquired' : item.rawTitle;
  if (item.acquired) card.classList.add('episode--acquired');

  const avatar = document.createElement('div');
  avatar.className = 'episode__avatar';
  avatar.style.background = avatarGradient(item.show);
  avatar.textContent = initials(item.show);
  avatar.setAttribute('aria-hidden', 'true');

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

  const numbering = describeNumbering(item);
  if (numbering) {
    const code = document.createElement('span');
    code.className = 'episode__code';
    code.textContent = numbering;
    head.append(code);
  }
  text.append(head);

  if (item.episode || item.airTime || item.acquired) {
    const sub = document.createElement('div');
    sub.className = 'episode__sub';

    const name = document.createElement('span');
    name.className = 'episode__name';
    name.textContent = item.episode;
    sub.append(name);

    // Said in words as well as in colour -- the stripe alone was too quiet.
    if (item.acquired) {
      const acquired = document.createElement('span');
      acquired.className = 'episode__acquired';
      acquired.textContent = 'Acquired';
      sub.append(acquired);
    }

    if (item.airTime) {
      const time = document.createElement('span');
      time.className = 'episode__time';
      time.append(svgIcon('clock', 'episode__clock'), formatTime(item.airTime));
      sub.append(time);
    }
    text.append(sub);
  }

  card.append(avatar, text, svgIcon('chevron', 'episode__chevron'));
  entry.append(card);
  return entry;
}

// The link arrives in the feed, so only a web URL is let through to href.
// MV3's CSP already refuses a javascript: one -- this keeps anything else odd
// off the card too, and covers items that carry no link at all.
function episodeUrl(link) {
  try {
    const { protocol, href } = new URL(link);
    return protocol === 'https:' || protocol === 'http:' ? href : HOME_URL;
  } catch {
    return HOME_URL;
  }
}

// "S01E04" reads like a filename; spell it out instead. Codes we could not
// take apart are shown as they arrived rather than dropped.
function describeNumbering({ season, number, code }) {
  if (season === null || number === null) return code;
  return `Season ${season} · Episode ${number}`;
}

function formatTime({ hours, minutes }) {
  return TIME_FORMAT.format(new Date(2000, 0, 1, hours, minutes));
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

// Any of these failures can come down to a wrong username or token -- a feed
// that will not parse is usually MyEpisodes serving an error page instead of
// RSS -- so both the wording and the settings button are offered whatever the
// kind. An outright rejection just leads with them.
function renderError(view, error) {
  setCount(view, null);
  const needsSettings = error instanceof FeedError && error.kind === 'auth';

  const settings = { label: 'Open settings', onClick: openSettings };
  const retry = { label: 'Try again', onClick: () => load(view.tab.id, { force: true }) };

  render(view, state({
    icon: 'error',
    variant: 'error',
    title: needsSettings ? 'Sign-in rejected' : `Could not load ${view.tab.label.toLowerCase()}`,
    detail: needsSettings
      ? 'MyEpisodes did not accept your username or feed token. Open settings to check both.'
      : `${describe(error)} Check your username and feed token on the settings page.`,
    actions: needsSettings ? [settings, retry] : [retry, settings]
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

// Shows have no artwork in the feed, so stand in with a stable colour and
// initials -- the same show always gets the same tile.
function initials(show) {
  const words = show
    .replace(/^(the|a|an)\s+/i, '')
    .split(/[\s:_-]+/)
    .filter(Boolean);

  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function avatarGradient(show) {
  const hue = AVATAR_HUES[hash(show) % AVATAR_HUES.length];
  return `linear-gradient(135deg, hsl(${hue} 54% 55%), hsl(${(hue + 20) % 360} 58% 44%))`;
}

function hash(value) {
  let total = 0;
  for (let i = 0; i < value.length; i += 1) total = (total * 31 + value.charCodeAt(i)) >>> 0;
  return total;
}

function render(view, node) {
  view.body.replaceChildren(node);
}

// `count` is a number to show, or null while there is nothing to count yet
// (loading, unconfigured, failed).
function setCount(view, count) {
  const el = view.count;

  if (count === null) {
    el.hidden = true;
    el.replaceChildren();
    return;
  }

  const noun = `episode${count === 1 ? '' : 's'}`;
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

// The status bar is shared, so every panel keeps its own line and only the
// visible one gets to write it.
function setViewStatus(view, message) {
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
  if (error instanceof FeedError) {
    return error.kind === 'auth'
      ? 'MyEpisodes did not accept your username or feed token.'
      : error.message;
  }
  return 'Something went wrong loading the feed.';
}

function dayFor(offset) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date;
}

function formatDate(date) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric'
  }).format(date);
}

function relativeTime(timestamp) {
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
