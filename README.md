# MyEpisodes Monitor

A Chrome extension (Manifest V3) that surfaces your [MyEpisodes](https://www.myepisodes.com/)
schedule in the toolbar. **Yesterday**, **Today**, and **Tomorrow** each list the
episodes from your watchlist airing that day; **All Today** lists everything airing
today across all shows, watchlist or not.

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Open the extension, hit the gear, and fill in your credentials.

## Settings

The extension reads the personal RSS feed:

```
https://www.myepisodes.com/rss.php?feed=<yesterday|today|tomorrow|all>&uid=<username>&pwdmd5=<token>
```

Both halves are configured on the settings page:

- **Username** — the `uid` parameter.
- **Feed token** — the `pwdmd5` parameter. Sign in at
  [myepisodes.com/rss.php](https://www.myepisodes.com/rss.php) and copy it from the
  end of any personal RSS link.

Settings live in `chrome.storage.sync`, so they follow your Chrome profile. The
token is only ever sent to `myepisodes.com`, which is the sole host the manifest
grants access to. **Test connection** checks both values against the feed and saves
them when they work, so a successful test is also a save.

### Treat the feed token as a password

`pwdmd5` is the MD5 of your MyEpisodes password. MyEpisodes hands the value out
itself and this extension never sees or hashes the plaintext — but MD5 is cheap to
crack offline, so anyone who reads the token can likely recover the password. It is
password-equivalent, and it is stored unencrypted in `chrome.storage.sync`, which
means Chrome replicates it through your Google account to every machine that profile
signs into. That is the normal cost of a sync'd setting rather than a flaw, but it is
worth knowing before you install this somewhere you do not control. Changing your
MyEpisodes password invalidates the token.

## Layout

```
manifest.json          MV3 manifest
background.js          Service worker — alarm-driven badge count
lib/myepisodes.js      Feed URL builder, fetch, and RSS parsing
lib/settings.js        chrome.storage wrapper for the credentials
lib/cache.js           Day-scoped cache of fetched feeds
lib/theme.css          Shared design tokens (light + dark)
popup/                 Toolbar popup — tab bar and the day panels
options/               Settings page
test/                  Node tests for the DOM-free helpers
icons/                 Toolbar icons
```

## Adding a tab

The popup's tab strip is markup-driven. A new tab is a `<button class="tab">` in
`popup/popup.html` plus a matching `<section class="panel">`, wired up by an
entry in the `TABS` array at the top of `popup/popup.js` (feed name, label, the
day offset that dates the heading, and the empty-state copy). `fetchFeed` passes
`feed` straight through to the `feed=` parameter, so any feed the site publishes
works. The acquired marks are a separate axis: `onlyunacquired: true` adds
`onlyunacquired=1` to the same feed, which is how the `tracksAcquired` tabs tell
the two apart.

## Badge

A service worker keeps today's episode count on the toolbar badge, so the number is
there before you open anything. It refreshes every 30 minutes, on browser start, and
whenever the credentials change; opening the popup and refreshing **Today** hands it a
newer number straight away. An MV3 service worker gets no `DOMParser`, so the worker
counts `<item>` elements in the raw feed rather than parsing it the way the popup
does — a count is all the badge needs.

## Tests

The helpers that do not touch the DOM run outside Chrome, on Node's own test runner:

```
npm test
```

There are no dependencies; `package.json` exists only to mark the folder as ES
modules and to hold that one script. The RSS parsing itself is built on `DOMParser`,
which Node has no equivalent for, so `parseFeed` and `descriptionAirTime` are not
covered here — the tests take the feed URL builder, the title and air-time parsers,
the item counter, and the cache.

## Notes

- Each list is cached in `chrome.storage.local` under its feed name and reused
  only within the same calendar day, so the popup paints instantly and then
  refreshes. Only Today loads on open; the other tabs fetch on first view. Saving
  on the settings page drops the cache, since it belongs to the old credentials.
- Each day is listed in broadcast order. Episodes the feed gives no air time for
  go last.
- If a refresh fails while a cached list is on screen, the list stays put and the
  status bar explains what went wrong.
- The toolbar icons come from MyEpisodes' own artwork: the 16px is the site's
  `favicon.ico`, and the larger sizes are cut from `/img/myepisodes_logo.jpg`
  with the background made transparent.
- `manifest.json` carries no `homepage_url`, since there is nowhere public to point
  it at yet. Once this lives somewhere, add `"homepage_url": "<url>",` beside
  `"author"`.
- `minimum_chrome_version` is `111`, which is where CSS `color-mix()` landed — the
  panel count pill and the acquired card border both use it.

## License

[MIT](LICENSE).
