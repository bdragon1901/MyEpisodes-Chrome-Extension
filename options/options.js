import { fetchFeed, FeedError } from '../lib/myepisodes.js';
import { getSettings, saveSettings } from '../lib/settings.js';
import { clearCache } from '../lib/cache.js';

const TODAY_FEED = 'today';

const form = document.getElementById('settings-form');
const uid = document.getElementById('uid');
const pwdmd5 = document.getElementById('pwdmd5');
const toggle = document.getElementById('toggle-token');
const test = document.getElementById('test');
const status = document.getElementById('status');

const settings = await getSettings();
uid.value = settings.uid;
pwdmd5.value = settings.pwdmd5;

form.addEventListener('input', () => setStatus(''));

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  await persist(current());
  setStatus('Saved.', 'ok');
});

toggle.addEventListener('click', () => {
  const hidden = pwdmd5.type === 'password';
  pwdmd5.type = hidden ? 'text' : 'password';
  toggle.textContent = hidden ? 'Hide' : 'Show';
});

test.addEventListener('click', async () => {
  const values = current();
  if (!values.uid || !values.pwdmd5) {
    setStatus('Fill in both fields first.', 'error');
    return;
  }

  test.disabled = true;
  setStatus('Checking…');
  try {
    const { items } = await fetchFeed({ feed: TODAY_FEED, ...values });
    // Credentials the feed just accepted are the ones worth keeping -- testing
    // and then closing the page used to leave nothing saved.
    await persist(values);
    setStatus(
      items.length
        ? `Connected and saved — ${items.length} episode${items.length === 1 ? '' : 's'} today.`
        : 'Connected and saved — nothing airing today.',
      'ok'
    );
  } catch (error) {
    setStatus(
      error instanceof FeedError ? error.message : 'Could not reach the feed.',
      'error'
    );
  } finally {
    test.disabled = false;
  }
});

// The cached lists belong to whichever account fetched them, so they go out
// with every credential write.
async function persist(values) {
  await saveSettings(values);
  await clearCache();
}

function current() {
  return { uid: uid.value.trim(), pwdmd5: pwdmd5.value.trim() };
}

function setStatus(message, variant) {
  status.textContent = message;
  status.className = variant ? `status status--${variant}` : 'status';
}
