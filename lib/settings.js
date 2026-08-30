// Persisted extension settings. `uid` and `pwdmd5` together form the RSS feed
// credentials; MyEpisodes exposes them on its own "RSS feeds" page.

const DEFAULTS = {
  uid: '',
  pwdmd5: ''
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

export async function saveSettings(patch) {
  await chrome.storage.sync.set(patch);
}

export function isConfigured(settings) {
  return Boolean(settings.uid && settings.pwdmd5);
}

export function openSettings() {
  chrome.runtime.openOptionsPage();
}
