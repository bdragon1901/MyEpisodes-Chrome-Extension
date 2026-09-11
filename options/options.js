import { ApiError, fetchAccount } from '../lib/api.js';
import { DEFAULTS, getSettings, saveSettings } from '../lib/settings.js';
import { clearCache } from '../lib/cache.js';

const form = document.getElementById('api-form');
const apiKey = document.getElementById('api-key');
const toggleApiKey = document.getElementById('toggle-api-key');
const testApiKey = document.getElementById('test-api-key');
const removeApiKey = document.getElementById('remove-api-key');
const statusLine = document.getElementById('api-status');

const displayForm = document.getElementById('display-form');
const oldEpisodesDays = document.getElementById('old-episodes-days');
const displayStatus = document.getElementById('display-status');

const settings = await getSettings();
apiKey.value = settings.apiKey;
oldEpisodesDays.value = settings.oldEpisodesDays;

form.addEventListener('input', () => setStatus(''));

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  await persist(currentApiKey());
  setStatus('Saved.', 'ok');
});

// The button's label is the action, not the state, and the accessible name says
// which field it acts on -- "Show" alone says nothing to anything that is not
// looking at the field beside it.
toggleApiKey.addEventListener('click', () => {
  const hidden = apiKey.type === 'password';
  apiKey.type = hidden ? 'text' : 'password';
  toggleApiKey.textContent = hidden ? 'Hide' : 'Show';
  toggleApiKey.setAttribute('aria-label', `${hidden ? 'Hide' : 'Show'} the API key`);
});

testApiKey.addEventListener('click', async () => {
  const key = currentApiKey();
  if (!key) {
    setStatus('Paste your API key first.', 'error');
    return;
  }

  testApiKey.disabled = true;
  setStatus('Checking…');
  try {
    const account = await fetchAccount({ apiKey: key });
    // A key the API just accepted is the one worth keeping -- testing and then
    // closing the page used to leave nothing saved.
    await persist(key);
    setStatus(describeAccount(account), 'ok');
  } catch (error) {
    setStatus(describeApiError(error), 'error');
  } finally {
    testApiKey.disabled = false;
  }
});

// The way back out. Setting .value in code fires no input event, so the
// confirmation below survives.
removeApiKey.addEventListener('click', async () => {
  apiKey.value = '';

  // Writing the same empty value back changes nothing, so chrome.storage raises
  // no event, the badge is never told to clear, and "the key is gone" would be
  // a confirmation for an action that did not happen.
  const stored = await getSettings();
  if (!stored.apiKey) {
    setStatus('Nothing to remove — no API key is stored.');
    return;
  }

  await persist('');
  setStatus('Removed — the saved API key is gone.', 'ok');
});

displayForm.addEventListener('input', () => setDisplayStatus(''));

displayForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const days = clampDays(oldEpisodesDays.value);
  // Written back so a value the field never actually held -- blank, decimal,
  // out of range -- reads as what was really saved rather than what was typed.
  oldEpisodesDays.value = days;
  await saveSettings({ oldEpisodesDays: days });
  setDisplayStatus('Saved.', 'ok');
});

// Whatever the field holds, coerced into a value the Old Episodes window can
// use -- an integer of at least two days, since the window ends two days ago
// and anything shorter would leave it with nothing to ask for. Empty or
// non-numeric falls back to the same default getSettings() would have merged
// in, rather than saving a value nobody chose.
function clampDays(value) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return DEFAULTS.oldEpisodesDays;
  return Math.min(365, Math.max(2, parsed));
}

// GET /v1/me is documented as carrying the account's timezone, date formats and
// show counts, but not the names it carries them under -- so every field read
// here is a guess verified at runtime, and only a value that actually turned up
// reaches the message. With none of them found the confirmation says just what
// the request itself proved, rather than naming a field that may not exist.
function describeAccount(account) {
  const detail = accountName(account) ?? accountShows(account) ?? accountZone(account);
  return detail ? `Key accepted and saved — ${detail}.` : 'Key accepted and saved.';
}

function accountName(account) {
  const name = firstString(
    account?.username,
    account?.user?.username,
    account?.login,
    account?.name
  );
  return name && `signed in as ${name}`;
}

function accountShows(account) {
  const count = firstNumber(
    account?.shows?.following,
    account?.shows_following,
    account?.counts?.shows,
    account?.shows
  );
  return count === null ? null : `${count} show${count === 1 ? '' : 's'} on your watchlist`;
}

function accountZone(account) {
  const zone = firstString(account?.timezone?.name, account?.timezone, account?.time_zone);
  return zone && `account timezone ${zone}`;
}

// Candidate spellings of one field, of which none can be trusted to exist. A
// miss is a miss rather than an error, and a value of the wrong type counts as
// a miss too -- `shows` being an object where another account has a number is
// exactly the shape surprise this page must not throw on.
function firstString(...values) {
  const found = values.find((value) => typeof value === 'string' && value.trim());
  return found ? found.trim() : null;
}

function firstNumber(...values) {
  const found = values.find((value) => typeof value === 'number' && Number.isFinite(value));
  return found === undefined ? null : found;
}

// 401 and 403 are different answers, and the API separates them on purpose. An
// unknown, expired or revoked key has to be replaced; a key the API recognises
// but will not let through this endpoint is not broken, and its holder has
// nothing to re-authenticate. Telling a read-only key's holder to sign in again
// would send them to fix the one part that is working -- so `scope` says which
// scope is missing and never asks for a new key.
function describeApiError(error) {
  if (!(error instanceof ApiError)) return 'Could not reach api.myepisodes.com.';

  switch (error.kind) {
    case 'auth':
      return (
        `${error.message} MyEpisodes does not recognise this key — it is ` +
        'unknown, expired or revoked, so it has to be replaced with a new one.'
      );
    case 'scope':
      return (
        `${error.message} The key itself is fine, just too narrow: it needs ` +
        '“read” scope for the episode lists and “write” to mark episodes ' +
        'acquired or watched.'
      );
    default:
      // Every other kind arrives with the API's own wording, written for a
      // person, and this page has nothing to add to it.
      return error.message;
  }
}

function currentApiKey() {
  return apiKey.value.trim();
}

// The cached lists belong to whichever account fetched them, so they go out with
// every write of the key -- saved, tested or removed.
async function persist(key) {
  await saveSettings({ apiKey: key });
  await clearCache();
}

function setStatus(message, variant) {
  statusLine.textContent = message;
  statusLine.className = variant ? `status status--${variant}` : 'status';
}

function setDisplayStatus(message, variant) {
  displayStatus.textContent = message;
  displayStatus.className = variant ? `status status--${variant}` : 'status';
}
