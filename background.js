// Keeps today's episode count on the toolbar badge, so the number is there
// before the popup is ever opened.
//
// An MV3 service worker has no DOM and therefore no DOMParser, which is what
// the popup's RSS parsing is built on. This side only needs a number, so it
// counts items straight off the raw feed instead -- see fetchFeedCount.

import { fetchFeedCount } from './lib/myepisodes.js';
import { getSettings, isConfigured } from './lib/settings.js';

const ALARM = 'refresh-badge';
const PERIOD_MINUTES = 30;
const BADGE_COLOR = '#1b7fc4';

chrome.runtime.onInstalled.addListener(start);
chrome.runtime.onStartup.addListener(start);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) refreshBadge();
});

// New credentials mean a new count, and clearing them should clear the badge.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && ('uid' in changes || 'pwdmd5' in changes)) refreshBadge();
});

function start() {
  // create() replaces an alarm of the same name, so this stays a single timer
  // however often the worker is restarted.
  chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MINUTES });
  refreshBadge();
}

async function refreshBadge() {
  const settings = await getSettings();
  if (!isConfigured(settings)) {
    setBadge(0);
    return;
  }

  try {
    setBadge(await fetchFeedCount({ feed: 'today', ...settings }));
  } catch {
    // A blip should not blank a number that was right an hour ago -- leave the
    // badge alone and let the next alarm correct it.
  }
}

function setBadge(count) {
  // An empty string is how chrome.action hides the badge entirely, which is
  // what a day with nothing on it should look like.
  chrome.action.setBadgeText({ text: count ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
}
