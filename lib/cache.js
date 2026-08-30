// Day-scoped cache of fetched feeds. The popup reads and writes it; the
// settings page drops it when the credentials change.
//
// Entries are only reused within the same calendar day -- every feed here is
// relative to today, so they all go stale once the date rolls over.

const PREFIX = 'cache:';

export async function readCache(feed) {
  const key = PREFIX + feed;
  const { [key]: cache } = await chrome.storage.local.get(key);
  if (!cache || cache.day !== todayKey()) return null;
  return cache;
}

export async function writeCache(feed, items) {
  await chrome.storage.local.set({
    [PREFIX + feed]: { day: todayKey(), fetchedAt: Date.now(), items }
  });
}

// Whatever is cached was fetched with the old credentials, so it goes out with
// them -- otherwise a failed first refresh would leave the previous account's
// episodes sitting on screen.
export async function clearCache() {
  const stored = await chrome.storage.local.get(null);
  const keys = Object.keys(stored).filter((key) => key.startsWith(PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
}

function todayKey() {
  return new Date().toDateString();
}
