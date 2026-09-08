// Persisted extension settings, which are now one credential.
//
//   apiKey   api.myepisodes.com. Every tab reads through it, the toolbar badge
//            counts through it, and marking an episode acquired or watched
//            writes through it. Reads want the `read` scope, which `write`
//            implies, so one `write` key does everything.
//
// There used to be two more, `uid` and `pwdmd5`, for the personal RSS feed at
// www.myepisodes.com/rss.php. They survived the move to the API only because
// the All Today tab listed everything airing across every show and no endpoint
// answered that. This Week replaced that tab with a fourth API window, so the
// feed lost its last reader and the credentials went with it -- along with
// pwdmd5, which was the MD5 of the account password and password-equivalent to
// anyone who read it.

const DEFAULTS = {
  apiKey: ''
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

export async function saveSettings(patch) {
  await chrome.storage.sync.set(patch);
}

// Whether the extension can do its job at all, which is now one question for
// the whole popup rather than one per tab.
export function isConfigured(settings) {
  return Boolean(settings.apiKey);
}

export function openSettings() {
  chrome.runtime.openOptionsPage();
}

// What 2.x stored and 3.x does not read: the RSS feed's credentials, and the
// cached list belonging to the All Today tab that This Week replaced.
const RETIRED_SYNC = ['uid', 'pwdmd5'];
const RETIRED_LOCAL = ['cache:alltoday'];

// Take them out rather than leaving them to sit there unread.
//
// `pwdmd5` is why this is not merely tidiness. It is the MD5 of the account
// password -- MyEpisodes hands the value out itself, but MD5 is cheap enough to
// crack offline that reading the token is close to reading the password. It was
// stored because the feed needed it, the feed is gone, and chrome.storage.sync
// replicates whatever is in it through the user's Google account to every
// machine that profile signs into. Dropping the key from DEFAULTS stops this
// version reading it; only this stops it being kept.
//
// Called from the service worker's onInstalled, so it runs once per upgrade,
// and again harmlessly on a fresh install where there is nothing to remove --
// remove() ignores names that were never written, which is cheaper than reading
// the store back to find out whether they were.
export async function forgetRetiredSettings() {
  await Promise.all([
    chrome.storage.sync.remove(RETIRED_SYNC),
    chrome.storage.local.remove(RETIRED_LOCAL)
  ]);
}
