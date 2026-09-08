// Keeps today's episode count on the toolbar badge, so the number is there
// before the popup is ever opened.
//
// This used to count <item> occurrences straight off the raw RSS text, because
// an MV3 service worker has no DOM and therefore no DOMParser to parse a feed
// with. The API answers in JSON, which needs no DOM at all, so the worker now
// runs exactly the same request the Today tab does -- and the two can no longer
// disagree about what a day holds, which the old split parser could.

import { dayKey, fetchEpisodes } from './lib/api.js';
import { forgetRetiredSettings, getSettings, isConfigured } from './lib/settings.js';

const ALARM = 'refresh-badge';
const PERIOD_MINUTES = 30;
const BADGE_COLOR = '#1b7fc4';

// onInstalled fires on a fresh install and on every upgrade, which is exactly
// when the settings 3.0.0 stopped reading want taking out of storage -- see
// forgetRetiredSettings. It is best-effort: a sweep that fails must not cost the
// badge its refresh, and the next upgrade will try again.
chrome.runtime.onInstalled.addListener(() => {
  forgetRetiredSettings().catch(() => {});
  start();
});
chrome.runtime.onStartup.addListener(start);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) refreshBadge();
});

// A new key means a new count, and clearing it should clear the badge. It is
// the only setting stored, so the name is checked only to stop a later one from
// costing the badge a refresh it has no reason to make.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && 'apiKey' in changes) refreshBadge();
});

function start() {
  // create() replaces an alarm of the same name, so this stays a single timer
  // however often the worker is restarted.
  chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MINUTES });
  refreshBadge();
}

async function refreshBadge() {
  const { apiKey } = await getSettings();
  if (!isConfigured({ apiKey })) {
    setBadge(0);
    return;
  }

  try {
    // The same window the Today tab asks for, so the badge and the tab's own
    // number are the same number by construction rather than by coincidence.
    const today = dayKey(0);
    const items = await fetchEpisodes({ apiKey, from: today, to: today });
    setBadge(items.length);
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
