// Turning values into the strings and colours a card wears. Nothing here
// touches the DOM, so it is all reachable from the tests.

// Both clocks take an explicit "now" so a test can stand somewhere other than
// the moment it runs.

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'short',
  day: 'numeric'
});

// The item's wall clock, printed in the reader's locale but never shifted into
// their timezone -- the numbers are the ones MyEpisodes showed for the account.
export function formatTime({ hours, minutes }) {
  return TIME_FORMAT.format(new Date(2000, 0, 1, hours, minutes));
}

export function formatDate(date) {
  return DATE_FORMAT.format(date);
}

// A panel covering more than one day dates itself with a range. Intl collapses
// it the way the locale would -- "Sep 7 - 13" rather than the month twice --
// which is what keeps it inside a heading the width of a popup. The weekday is
// dropped for the same reason: two long weekday names would not fit, and the
// dates are what a week is read by.
const RANGE_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

export function formatDateRange(from, to) {
  return RANGE_FORMAT.formatRange(from, to);
}

// The day a tab's offset points at. setDate carries across month ends and
// daylight saving on its own.
export function dayFor(offset, from = new Date()) {
  const date = new Date(from);
  date.setDate(date.getDate() + offset);
  return date;
}

export function relativeTime(timestamp, now = Date.now()) {
  const minutes = Math.round((now - timestamp) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

export function episodeNoun(count) {
  return `episode${count === 1 ? '' : 's'}`;
}

// MyEpisodes sends no artwork, so stand in with a stable colour and initials --
// the same show always gets the same tile.
export function initials(show) {
  const words = show
    .replace(/^(the|a|an)\s+/i, '')
    .split(/[\s:_-]+/)
    .filter(Boolean);

  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// Hues chosen to stay legible behind white text -- the yellow-green band is
// skipped because it goes muddy at the lightness the avatars use.
const AVATAR_HUES = [210, 250, 282, 320, 348, 12, 32, 168, 192, 140];

export function avatarGradient(show) {
  const hue = AVATAR_HUES[hash(show) % AVATAR_HUES.length];
  return `linear-gradient(135deg, hsl(${hue} 54% 55%), hsl(${(hue + 20) % 360} 58% 44%))`;
}

function hash(value) {
  let total = 0;
  for (let i = 0; i < value.length; i += 1) total = (total * 31 + value.charCodeAt(i)) >>> 0;
  return total;
}
