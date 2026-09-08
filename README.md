# MyEpisodes Monitor

A Chrome extension (Manifest V3) that surfaces your [MyEpisodes](https://www.myepisodes.com/)
schedule in the toolbar. **Yesterday**, **Today**, and **Tomorrow** each list the
episodes from your watchlist airing that day, each card carrying the account's own
**Acquired** and **Watched** state; **This Week** is the same list over the whole
of Monday to Sunday, with anything starting its first episode flagged *New show*
and edged in amber.

All four tabs are windows on one endpoint at `api.myepisodes.com` — the same
request with a wider `from`/`to` for the week — so there is one credential, one
client, and one shape of item. The personal RSS feed the extension started life
on is gone, and the second credential with it.

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Open the extension, hit the gear, and fill in your API key.

## Settings

One credential, and the whole page is about it. The **API key** is what the
extension runs on. Each tab is one request:

```
GET https://api.myepisodes.com/v1/me/episodes?from=2026-09-07&to=2026-09-07&date_basis=local
Authorization: Bearer myeps_…
```

This Week asks the same question with a wider window: `from` the Monday and `to`
the Sunday of the week today falls in. The toolbar badge counts from the Today
request, and marking an episode acquired or watched writes back through the same
key. Create one on the
[MyEpisodes API keys page](https://www.myepisodes.com/api-keys/): it needs
`read` scope for the episode lists and `write` to mark episodes, and `write`
implies `read`, so a single `write` key does everything. The key is sent as a
bearer token in a header and never in the query string — the API refuses
`?apikey=` with `credential_in_query` even on its public endpoints, so putting it
there would break the request as well as leaving the key in logs and history.

**Test key** spends the cheapest authenticated request there is, `GET /v1/me`,
and saves the key when the API accepts it — so a successful test is also a save,
and the confirmation names whatever that response turned out to carry. **Remove
key** takes it back out of storage, which clears the badge, drops the cached
lists, and returns the popup to its "connect your account" state. Those three
buttons and the field they act on are the whole page: the second card is gone,
and so is the pill that ranked this one above it.

`lib/settings.js` is now `{ apiKey: '' }`, and "configured" is one question
again. `isConfigured()` wants the key, and its answer decides whether the popup
opens on a list or on "connect your account". There used to be a second
question, `hasFeedCredentials()`, and the popup asked per tab rather than once
for the whole window — an account with a key and no feed token got three working
tabs and a fourth that explained itself, rather than a whole popup refusing to
open over a credential three quarters of it never touched. Every tab reads
through the key now, so `missingCredential` asks once for the window.

Settings live in `chrome.storage.sync`, so they follow your Chrome profile, and
the key is only ever sent to the host it belongs to. Saving, testing or removing
it drops the cached lists, since they belong to whichever credential fetched
them. The manifest grants two hosts: `api.myepisodes.com`, and `api.tvmaze.com`,
asked about shows and never sent the key. `www.myepisodes.com` is not among them
any more — nothing fetches the site itself, and a domain that appears only as a
link target needs no permission.

### Treat the API key as a password

There is one secret now, and it is the better of the two. `pwdmd5` was the MD5
of your MyEpisodes password: MyEpisodes handed the value out itself and this
extension never saw or hashed the plaintext, but MD5 is cheap to crack offline,
so anyone who read the token could likely recover the password. It was
password-equivalent, and the only way to invalidate it was to change the
password it was made from. The extension no longer stores it.

The API key is not password-equivalent, but neither is it a read-only view of
the account. Its scope decides what it can do, and the extension asks for both
halves: `read` lists the account's episodes, `write` marks episodes acquired and
watched. So a leaked `write` key can change what the account claims to have
seen, not merely read it. What it has over the token it replaced is a way out —
a key can be revoked on the API keys page without touching the password, and a
fresh one pasted into settings. That is the whole of the difference worth
remembering: the two secrets never cost the same to leak, because only one of
them could be taken back in place. If only the lists matter to you, a `read` key
gives you all four tabs, a badge and the premiere flag; a mark attempted with one
comes back saying the key needs `write` scope rather than failing silently.

It is stored unencrypted in `chrome.storage.sync`, which means Chrome replicates
it through your Google account to every machine that profile signs into. That is
the normal cost of a sync'd setting rather than a flaw, but it is worth knowing
before you install this somewhere you do not control.

## Layout

```
manifest.json          MV3 manifest
background.js          Service worker — alarm-driven badge count
lib/api.js             api.myepisodes.com client: day and week windows, paging, error kinds
lib/settings.js        chrome.storage wrapper for the one credential
lib/tvmaze.js          TVmaze lookup: MyEpisodes show id to show data
lib/marks.js           Acquired/watched: how the flags couple, and the write
lib/cache.js           List cache and the per-show TVmaze cache
lib/lookup-queue.js    Rate-limited work queue and its token bucket
lib/episodes.js        Item logic: episode identity, ordering, comparing
lib/format.js          Times, dates, ranges, counts, initials, avatar colours
lib/theme.css          Shared design tokens (light + dark)
popup/                 Toolbar popup — tab bar and the four panels
options/               Settings page
test/                  Node tests for everything that is not the DOM
icons/                 Toolbar icons
```

`lib/api.js` is the only client there is. There used to be a second,
`lib/myepisodes.js` — a feed URL builder, `parseFeed`, a title parser that took
`[ Show ][ 01x04 ][ Title ][ date ]` apart in each of the formats the account
could have chosen, an air-time reader, and a filter for the "No Episodes"
placeholder the site sends for an empty day. It survived the API migration
because one tab needed it and no endpoint answered what that tab asked. Nothing
needs it now, so the module, its 248 lines, and the tests over the half of it
Node could reach are all deleted, and every item downstream arrives from the one
place in the one shape `toEpisode` builds.

`popup/popup.js` is the controller and nothing else: it owns the tab strip, the
panels, and the nodes a card is built from. Everything it runs *on* — how an
item names its episode, what order a day reads in, how a show becomes two
letters and a colour, how a queue spends a rate limit — lives in `lib/` beside
the modules that were already there. That split is what puts those parts under
test: a module that reaches for `document` when it loads cannot be imported by
Node, so anything left in the popup was untestable by construction.

## Adding a tab

The popup's tab strip is markup-driven. A new tab is a `<button class="tab">` in
`popup/popup.html` plus a matching `<section class="panel">` — copy an existing
pair rather than writing them out, since both carry `data-` hooks the popup reads,
the count chip among them. Wire it up with an entry in the `TABS` array at the top
of `popup/popup.js`: an `id`, a label, the window it covers, and the empty-state
copy.

The window is the only interesting field, and there are two ways to say it.
`offset` is a day relative to today — `-1`, `0`, `1` — which both dates the
panel's heading and is the window it fetches, so another day is another line and
nothing else. `span: 'week'` is the other, and This Week is the only tab that
sets it: `tabWindow` sends it to `weekRange()` for its `from`/`to`, and
`panelDate` sends it to `weekOffsets()` for the two dates its heading prints.
Those are the same arithmetic underneath, which is the point — see the note on
the week below. There is no `source` field any more, and no fork behind it: a
tab is `fetchEpisodes({ apiKey, ...tabWindow(tab) })` whatever window it asked
for.

A tab's `id` doubles as the name of the cache it keeps, so add it to `LISTS` in
`lib/cache.js` — that array is the list `clearCache` walks, and an id missing
from it would keep the previous account's episodes across a credential change.
`LISTS` is `['yesterday', 'today', 'tomorrow', 'week']`; it used to be read from
the feed module's `FEEDS`, which nothing has a name in any more.

There is no acquired axis to wire up, and no *Following* flag either. `acquired`
and `watched` arrive on every row of every window, so the `onlyunacquired`
companion request — whose entire job was to let the popup work `acquired` out by
difference — is gone, and so is the `tracksAcquired` flag that turned it on.
*Following* went the same way: every row of `/v1/me/episodes` is an episode of a
show the account follows, so a flag saying so said nothing, and the second
request that used to compute it — the watchlist's own today, joined on the show
id — is gone with it.

The *New show* flag is the one mark a tab can still opt into, and it is the cheap
one. `marksPremieres` reads season and episode straight off the numbering the
item already carries, so `isPremiere` in `lib/episodes.js` is the whole of it: it
costs no request and every card can answer for itself. Only **This Week** sets
it. It used to belong to All Today, on the grounds that a first episode is only
news where the list reaches past what is already followed; a week earns it
differently — seven days is long enough to hold the premiere of something on the
watchlist that has not started yet, which is worth picking out of a week of
continuing runs. Both numbers have to be read for it to be true, so an item whose
numbering could not be read is never a premiere, and neither is a daily show
numbering itself by year (`S2026E172`), nor a row the API marks `special` — a
pilot-numbered extra is not a series starting. It takes the whole card — amber
tint, amber edge, a filled pill on the rail — since a show starting this week is
the one thing on a seven-day list worth spotting without reading the rows. It can
share a card with acquired, and then only one of them can have the left edge:
`.episode--premiere` comes after `.episode--acquired` in the sheet and takes it,
being the rarer signal and the one that is gone next week.

## TVmaze

`/v1/me/episodes` names the show and its timezone and stops there, so the network
chip and the poster on every card's avatar tile are both things only TVmaze
knows. The card is painted from the item first anyway, and finds nothing there —
written as a preference rather than hardcoded to TVmaze, so that the day a list
endpoint starts sending a network the chip stops costing a request without anyone
having to notice.

There are two ways in, because there are two things an item can hand over. A show
is asked for by id:

```
https://api.tvmaze.com/shows/44776
```

and an episode brings its show along when asked to:

```
https://api.tvmaze.com/episodes/3695361?embed=show
```

Following an episode's `_links.show.href` instead would spend a second round trip
on the same data, so the embed is the only episode shape asked for. `parseShow`
and `parseEpisode` cut what comes back to the two fields a card paints — the
network and the medium-sized poster — and `parseEpisode` keeps only the show
half, discarding the episode entirely. MyEpisodes already sends every episode
field TVmaze would, and sends better dates, so the episode record was assembled
and dropped on the floor once per lookup. Two HTML-stripped summaries went with
it, and `plainText` with them.

`lookupShow(showid, { tvmazeShowId, tvmazeEpisodeId })` is the one call the popup
makes, and the first argument is the interesting one: **the key is the MyEpisodes
show id**, not either TVmaze number. The two TVmaze ids are hints — routes to an
answer, tried in the order given — because `external.tvmaze` means different
things in different places. On a show it is a TVmaze *show* id; on an episode it
is an *episode* id. An `/v1/me/episodes` row is flat and carries only the episode
one, so in practice every lookup takes the episode route; the show route is there
because `/v1/shows` does send a show id, and one request for the show wanted
beats one for an episode that happens to mention it. There used to be a third
route, `episodeIdFromUrl`, which read an id out of the path of an RSS item's link:

```
https://www.tvmaze.com/episodes/3695361/lanterns-1x03-outkast
                                ^^^^^^^ episode id (the slug is cosmetic)
```

Every item carries its ids as fields now, so there is no link left to parse and
the function is deleted. Whichever route answers, the reply is the cache's own
summary of the show, so a hit and either fetch hand back the same
`{ fetchedAt, show }` and a caller never has to know which it got.

Keying by show is the structural win. The store used to be a two-tier index keyed
by TVmaze episode id, because an RSS item identified itself only by a link to an
episode page — so a watchlist following one show closely paid a fresh lookup per
episode of it, three episodes across three tabs being three requests for one
answer. Everything the cache holds describes a *show*, and every item now resolves
to a MyEpisodes show id, so there is one entry and one lookup per show however
many of its episodes a window happens to hold — which is worth more to a week
than it ever was to a day. The episode tier and the orphan-reference counting
that kept it honest are both gone, and the lookup queue, keyed the same way,
collapses two cards for one show into a single job before a request is even spent.
`TVMAZE_MAX_SHOWS` is 500, which replaces a cap that had to bound thousands of
episode rows.

The popup reads the whole TVmaze cache once when it opens and keeps it in memory,
so a card is painted complete rather than having its artwork appear a moment
later. It also means anything that *does* reach `lookupShow` is already known to
be a miss, so the popup passes `cached: false` and skips a storage read whose only
possible answer is "nothing here". Everything else costs a request, and two things
keep that affordable.

A card only asks once it has been **scrolled to**. An `IntersectionObserver` per
tab watches the cards in its panel, reaching 400px past the fold so the artwork is
usually there before the row carrying it is. Today is a dozen rows and would be
fetched either way; **This Week** is seven days of them while the popup shows
about eight at a time, so this is the difference between a week's worth of
requests and the handful anyone actually looks at.

What is asked for goes through `lib/lookup-queue.js`, which spends from a bucket
of 20 requests refilling at one every 500ms. TVmaze asks for no more than about 20
calls per 10 seconds but does not mind them arriving together, so a screenful of
lookups goes out at once instead of trickling one fixed gap at a time. A 429 stands
the queue down for ten seconds and retries the show rather than writing off every
lookup for as long as the popup is open. Answers are remembered per show id for as
long as the popup is open, so the same show on two tabs is fetched once.

The queue knows nothing about TVmaze. A job is a key, a `stale()` and an
`answered()` the queue asks before spending a request, and a `settle`/`fail` pair
for the outcome — so the popup's notion of "this card is gone" stays in the popup,
and the bucket arithmetic can be tested against an injected clock rather than by
waiting out real seconds.

The API needs no key and rate-limits by IP, so lookups go through the cache below.
Failures are typed the way the API client's are: `notfound` for a show TVmaze has
no record of, `rate-limit` for a 429, plus `link` for an item that points at
nothing, `network`, `http`, and `parse`. All of them are decoration failing: the
card was drawn from the window's own list, and the poster is laid *over* the
initials tile rather than replacing it — so a show with no artwork, an image that
will not load, and the moment before one arrives all look like the card always
did, with nothing moving when it does. The image is decoded before it goes on
screen and appears in a single paint, rather than being faded in from transparent
over the initials it is covering.

## Badge

A service worker keeps today's episode count on the toolbar badge, so the number
is there before you open anything. It refreshes every 30 minutes, on install, on
browser start, and whenever the API key changes; opening the popup and refreshing
**Today** hands it a newer number straight away.

The interesting part is what is no longer here. An MV3 service worker gets no
`DOMParser`, so the old worker could not parse a feed at all and counted `<item>`
occurrences in the raw text instead — a second, cruder reader of the same bytes,
which could disagree with the popup about what a day held and needed its own
opinion about the "No Episodes" filler. JSON needs no DOM, so the worker now runs
exactly the request the Today tab runs, through the same `fetchEpisodes`, and
counts the rows it gets back. The badge and the tab are the same number by
construction rather than by two parsers agreeing.

The `chrome.storage.onChanged` listener watches `apiKey`, which is now the only
setting there is to watch — it used to have to ignore writes to the feed
credentials, whose tab the badge never mirrored. A failed refresh leaves the
number alone rather than blanking it — an hour-old count beats none — and the
next alarm corrects it.

## Marking acquired/watched

Every card carries two small pills, **Acquired** and **Watched**, next to the
episode name. Both arrive on the row itself, on every tab, which is the single
largest thing the migration bought: the feed carried no per-episode flag at all,
so `acquired` had to be worked out by difference against a second filtered
request, and `watched` could not be shown at any price. There is no longer a tab
whose cards start blank.

Acquired doubles as the card's own tint — the same green an already-acquired
episode arrives wearing — so toggling it here reads exactly like MyEpisodes having
said so; Watched has no such tint of its own. A card can already be tinted for
acquired or for a premiere, so a third colour competing for the same border was
one too many, and Watched speaks only through its own pill.

A click paints the new state immediately rather than waiting on a round trip,
then writes it to MyEpisodes:

```
PUT https://api.myepisodes.com/v1/me/episodes/<show id>/<season>/<episode>
{ "acquired": true }   or   { "watched": true }
```

authenticated with the API key from settings, as a bearer token, and needing a
`write`-scope key. One field per request, always the one whose pill was clicked:
sending only that key leaves the other exactly as MyEpisodes has it.

### The flags are coupled, and not symmetrically

`watched` implies `acquired` — you cannot have seen an episode you never got hold
of. And clearing `acquired` removes the episode's state outright, so `watched`
goes with it; `{ "acquired": false, "watched": true }` is refused with a 422
rather than guessed at. `nextMark` in `lib/marks.js` is the pure function that
says where a click on one pill leaves the other. It mirrors what the server is
about to do rather than deciding anything itself, which is what lets the popup
paint the result instantly and still send a single field — the implication happens
at the far end either way, and sending both would be the request the API refuses.

One consequence is worth stating outright: `nextMark` is **not its own inverse**.
Un-acquiring a watched episode clears both, so flipping `acquired` back on would
leave `watched` wrongly off. So a failed write restores a snapshot of what the
click found rather than flipping a second time, and the panel's status line says
why — the same way a failed refresh already does, appended to the freshness line
where there is one to append to.

A key and an addressable episode are conditions, not requirements: no key saved,
or an item that names no episode, leaves the toggle exactly where the click put it
— kept only in memory for the life of the popup, which is still worth more than a
pill that refuses to move. A request that does go out and fails is the case above,
and `lib/marks.js` keeps the API's own wording for it except where the popup can
say something more useful: `auth` for a key MyEpisodes does not recognise, `scope`
for one that is real and only too narrow, `refused` for a combination it will not
accept.

### One episode, one shape

`episodeTarget()` in `lib/episodes.js` reduces an item to the
`{ showid, season, episode }` triple, which is exactly what the API takes as its
three path segments. Every item carries the three as fields, so that is the whole
function. TVmaze's episode id is a different number and plays no part here.

This used to have a second half. While one tab came from `rss.php`, an item could
arrive with its numbers packed into a `<guid>` as `"<show id>-<season>-<episode>"`
instead of carried as fields, and `parseGuid` read them back out so that a mark
set on an API tab was recognised as the same episode on the feed-backed one. That
shared identity was the whole of what made the hybrid invisible; with one source
there is nothing to reconcile, and `parseGuid` and `showKeys` — the show-level
join the *Following* flag needed — are both deleted. What remains is `episodeKey`,
which keys the in-memory marks: the triple where it can be read, the show and code
together where it cannot, so a mark set on Today is still the same mark when This
Week renders that episode.

## Tests

Everything that does not touch the DOM runs outside Chrome, on Node's own test
runner:

```
npm test
npm run lint
```

179 tests across eight files: `api`, `cache`, `episodes`, `format`,
`lookup-queue`, `marks`, `settings`, and `tvmaze`. There was another, `parsers`,
over the feed URL builder, the title parser, the air-time reader and the
placeholder filter; it went with the module it covered. `settings.test.mjs`
replaced it, and exists for one reason: `forgetRetiredSettings()` deletes things,
and one of them is password-equivalent, so a version of that sweep which quietly
stopped naming `pwdmd5` would leave no sign. `api.test.mjs` is the largest of them,
and records every call rather than counting them, since half of what that module
does is build a URL and the query string is the only place to read the window, the
`date_basis` and the include flags back from. The week arithmetic is pinned there
too, and it is the sort of thing that is only ever wrong at the edges:
`weekOffsets` is asserted for each of the seven days of one week, and `weekRange`
for being exactly seven days wide, for answering with the same window from any day
inside it, and for landing where the calendar says across a month end, a year end
and a February — 28 Dec 2026 through 3 Jan 2027, 29 Dec 2025 through 4 Jan 2026,
23 Feb through 1 Mar. `episodes.test.mjs` used to assert one property in several
ways, that an item from either source resolves to the same episode; there is one
shape for it to read now.

The one gap that was there by construction went with the feed. RSS parsing is
built on `DOMParser`, which Node has no equivalent of, so `parseFeed` and
`descriptionAirTime` could not be reached at all. What is left is either plain
data or a stubbed edge: both caches, the item logic, the formatters, the mark
coupling and the mark request, the lookup queue, the API client and the TVmaze
client — the last four against a stubbed `fetch`, a stubbed
`chrome.storage.local`, and an injected clock. The clock tests are written to hold
in whatever timezone the suite runs in, and where the machine is off UTC they also
assert that the answer is *not* the one a UTC reading would have given. What is
still outside all of it is the DOM and the worker — the popup, the settings page
and `background.js` — plus `lib/settings.js`, which is a wrapper over
`chrome.storage.sync` with nothing of its own to assert.

Nothing here ships. `package.json` marks the folder as ES modules, holds those two
scripts, and pulls in the linter, which is the only dependency; the extension is
the folder, and Chrome ignores all of it.

## Migration from 2.x

Dropping a stored credential is a breaking storage change, which is what the
`3.0.0` in `manifest.json` is for. In practice almost nothing has to be done.

The API key is untouched. It is stored under the same name, it is still the one
credential every tab reads through, and there is nothing to re-enter. An install
that has one keeps working across the upgrade.

The two feed settings are removed, not merely ignored. `DEFAULTS` is now
`{ apiKey: '' }` and `getSettings()` only asks `chrome.storage.sync` for the keys
in it, so this version could not read a stored `uid` or `pwdmd5` even if it
wanted to — but not reading a value is not the same as not keeping one, and
`chrome.storage.sync` replicates whatever is in it through the user's Google
account to every machine that profile signs into. So `forgetRetiredSettings()` in
`lib/settings.js` takes them out, along with the orphaned `cache:alltoday` entry
that left `LISTS` with the tab it belonged to and which `clearCache` therefore no
longer names. It runs from the service worker's `onInstalled`, which fires once
per upgrade and again harmlessly on a fresh install where there is nothing to
remove — `remove()` ignores names that were never written, which is cheaper than
reading the store back to find out whether they were.

That matters most for `pwdmd5`, which is why it is done rather than left. It is
the MD5 of the account password: MyEpisodes hands the value out itself, but MD5
is cheap enough to crack offline that holding the token is close to holding the
password. It was stored because the feed needed it and the feed is gone. Changing
the MyEpisodes password is still the only thing that makes an already-leaked
value worthless — this only stops the extension being the thing that keeps it.

Cached lists invalidate by version rather than rendering wrong. A cached list is
only usable when both its `day` and its `version` match, and `LIST_VERSION` is now
3, so every list 2.x wrote reads as a miss and the tab fetches — rather than a
list in the old RSS item shape being painted as episodes missing half their
fields. The old **All Today** cache is a different case: `alltoday` is not in
`LISTS` any more, so nothing reads it and `clearCache` does not name it. Its one
key sits in `chrome.storage.local` until the extension's storage is cleared, which
is a few kilobytes of nothing rather than a correctness problem — the only thing
that could paint it is a tab with that id.

The TVmaze store is not part of any of this. It carries its own version, it is
keyed by MyEpisodes show id, and this change touches neither — a show is not tied
to an account, so those entries survive an upgrade the way they survive a
credential change. A store written to an older shape still reads as empty, and the
first write after that sweeps what earlier versions left behind: the
`cache:tvmaze:<episode id>` detail records that nothing ever read, and the episode
tier that used to sit inside `cache:tvmaze`. That is one whole-storage scan, run
once, and taking the old index out before writing the new one matters if the area
is near quota — the old tier is precisely the space the write needs.

## Notes

- **This Week is Monday through Sunday of the week today falls in, not a rolling
  seven days from today.** The rolling window is the better-behaved of the two: it
  never shows a day that has already passed, and it never runs out mid-week. It
  was rejected because "This Week" names a calendar week, and a tab whose meaning
  shifts every time it is opened is harder to trust than one that shrinks
  predictably — by Saturday the Monday–Sunday tab is nearly spent, which is a
  thing a reader can hold in their head, where "the next seven days" is a window
  whose two ends they would have to work out afresh each time. It deliberately
  overlaps Yesterday, Today and Tomorrow: those three are the schedule, and the
  week is the shape of it.
- **`weekOffsets` exists so that two things cannot disagree about which week it
  is.** The window This Week fetches and the date range its heading prints are the
  same seven days, and working them out twice is exactly how they come to differ —
  a heading reading Mon–Sun over a list fetched Sun–Sat is the kind of wrong
  nobody notices for a month. So the offsets are decided once, in `lib/api.js`
  (`getDay()` counts from Sunday, so `(getDay() + 6) % 7` rotates it onto a week
  where Monday reads 0), and `weekRange` turns them into the API's `from`/`to`
  through `dayKey`, which is where the local-calendar arithmetic already lives
  rather than being written out a second time.
- The week's heading is a range, and `formatDateRange` in `lib/format.js` prints
  it with `Intl.DateTimeFormat.prototype.formatRange`, so the locale collapses it
  the way it would itself — "Sep 7 – 13" rather than the month twice. The weekday
  is dropped from the range, unlike a single day's heading: two long weekday names
  will not fit across a popup, and the dates are what a week is read by anyway.
- Each list is cached in `chrome.storage.local` under the tab's own id and reused
  only within the same calendar day, so the popup paints instantly and then
  refreshes. That day-scoping is right for the week list too, and not by accident:
  the week the tab covers moves every Monday, and a cached list that outlived the
  date would be a window with the wrong ends. Today loads on open, and so does any
  tab the cache cannot answer for — see the tab-count note below. Saving the key
  drops the cache, since it belongs to the old credential.
- TVmaze lookups are cached separately, under one `cache:tvmaze` key:
  `{ version, shows }`, where `shows` is keyed by MyEpisodes show id and each
  entry is when it was fetched plus the two fields a card paints with —
  `showSummary` is `{ network, poster }` and nothing else. It used to keep the
  show's TVmaze id, name and URL as well; nothing read any of them, and the entry
  is filed under the MyEpisodes show id, so TVmaze's own id was not even the key.
  The key carries a `version` because the popup paints straight out of those
  fields: changing one bumps `TVMAZE_INDEX_VERSION` and drops what is stored,
  rather than leaving cards to wait out the week's max age before they can show
  it. Entries are kept for a week rather than a day — a show's status and artwork
  barely move — and are pruned on write, both by age and against
  `TVMAZE_MAX_SHOWS`, so the store cannot grow into the storage quota and quietly
  stop being a cache. One entry per show is a much smaller thing to bound than one
  per episode was. They survive a credential change, since a show is not tied to
  an account.
- Writes to that cache queue behind one another. It is a read-modify-write and
  `chrome.storage` offers no primitive for one, so two writers overlapping each
  read the same value and each write their own entry over the other's. That is
  not a corner: the popup runs four lookups at once and their answers arrive
  together, which used to keep one entry in four and re-fetch the rest on every
  open. The entry just written is also held out of the cap's sort rather than
  trusted to be the newest in it — a caller that has just paid for a lookup has to
  be able to read it back, whatever the stored timestamps say.
- Broadcast times come from `local_airdate`, and they have to. A row carries three
  times: the show's own `airtime` wall clock, an absolute `stored_utc_airdate`, and
  `local_airdate`, already converted to the account's timezone. The window is asked
  for with `date_basis=local`, so `local_airdate` is the field the day filter runs
  on — an episode airing 21:00 on the 6th in New York arrives inside the window for
  the 7th, because that is where its local date falls. Showing the show's `airtime`
  instead would print "21:00" on a card sitting under Today's heading beside
  yesterday's date, which is the one combination guaranteed to read as a bug.
  Because it is already converted, it is read as a wall clock and never put through
  `Date` — parsing it as an instant and then rendering it with local getters would
  convert a time that was converted once already, and on a machine set to UTC the
  error would be invisible. It is also the only field that arrives with six digits
  of microseconds, which are cut before reading. `stored_utc_airdate` is the
  fallback and genuinely an instant, in `'YYYY-MM-DD HH:MM:SS'` UTC and *not*
  ISO-8601, so it is parsed as `new Date(s.replace(' ', 'T') + 'Z')`; the show's
  `airtime` is the last resort, on the grounds that a wall clock in the wrong zone
  beats no time at all. 00:00 from the API is a real broadcast time and is kept —
  the API sends no time at all for an episode whose time it does not know, where
  the feed's date fields read as midnight whenever their clock was unset, so
  dropping midnight the way the feed parser had to would quietly lose every show
  that actually airs then. The window a tab asks for is the viewer's own calendar
  for the same reason, built from local date fields rather than `toISOString()` —
  which prints the UTC date and would hand anyone west of UTC yesterday's window
  for most of their evening — and `date_basis=local` says the same thing to the
  API.
- `from`, `to`, `include_pilots` and `include_ignored` are sent on every episode
  request, the last two even when false. They override the window and filters
  saved on the account, and omitting one would let a setting made on the website
  decide what a tab shows — pilots of shows the viewer does not follow, most
  visibly. `order=asc` goes with them, which keeps a window that has to be paged
  handing its rows back in a stable order; the popup sorts each list by air time
  itself either way.
- The list endpoints answer in an envelope with `limit`, `offset` and `has_more`
  and no total, so `fetchList` pages on the flag rather than on arithmetic over a
  count nobody sent, advancing by the rows that actually arrived. At the
  documented maximum of 200 a day is one request; the page ceiling is a stop for a
  server that keeps saying `has_more`, not a budget. **This is the one place This
  Week differs in kind from a day tab**: a busy watchlist can hold more than 200
  episodes across seven days, so the week is the window that actually pages. It
  needed no new code — the paging was already there for a day that could not need
  it.
- A success can carry an empty body: a `PUT` that worked answers 204 with no
  bytes. That is why the client reads the body as text and parses it itself rather
  than calling `response.json()` — which cannot tell an empty body from bytes that
  will not parse, and reading the difference wrong made every successful mark
  report itself as a parse failure.
- The API allows 600 requests per key per wall-clock hour, reported on
  `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`. A popup
  opening cold spends four — one per tab, since a tab the cache cannot answer for
  is loaded rather than left bare — plus a page for a week that runs past 200
  rows, against an allowance of 600. Nothing retries an API call, so `Retry-After`
  is not read; the popup leaves a stale list up and says how old it is instead.
- `ApiError.kind` is one of `network`, `auth`, `scope`, `rate-limit`, `notfound`,
  `invalid`, `refused`, `unavailable`, `http` and `parse`, and it is the whole of
  what a caller branches on. The API's own `error.code` is not kept: everything
  reading an `ApiError` today branches on `kind` and shows `message`, so `code`
  was a field written for nobody. It is the first thing to bring back if a caller
  ever has to tell two failures of one kind apart. The 401/403
  split is kept end to end on purpose: a 401 means the key is unknown, expired or
  revoked and has to be replaced, while a 403 means the key is real and only too
  narrow, so what has to change is the scope. Telling a `read`-key holder to
  re-authenticate would send them off to fix the part that works.
- A refresh that brings back the list already on screen does not re-render it.
  Rebuilding an identical list costs every card its poster tile and the reader a
  flicker, so the fetched items are compared against the rendered ones first.
- A card's lookup is retired when the list it belongs to is replaced. Each panel
  counts its renders, and a queued lookup carries the count it was queued under, so
  anything left on an older one belongs to a card that is gone. `isConnected` cannot
  stand in for this: a card registers its lookup while it is still being built, and
  asking then reports every card as detached.
- Each tab carries its window's episode count, so the strip answers "anything
  tomorrow?" without a click. The counts are read from the cache on open — one
  read for the whole strip, and the panels take their first paint from the same
  one, since asking again per panel made three reads on open where two will do. A
  refresh, or a second visit, goes back to storage for itself rather than reusing
  a snapshot from when the popup opened.
- A tab the cache cannot answer for is loaded on open rather than left bare. The
  caches are day-scoped, so every one of them misses the first time the popup is
  opened after the date rolls over — the state the extension is in after a few
  days away, which used to mean three tabs out of four showing no number until
  each was clicked. The fetch is that tab's own load against its still-hidden
  panel, so the number arrives with the list behind it painted and cached, and
  opening the tab shows the episodes instead of skeletons. A cache that is current
  still fetches only the open tab. Nothing is looked up on TVmaze for a hidden
  panel: a card asks when it is scrolled to, and a card in a panel that is not on
  screen never is.
- Each list is shown in broadcast order. Episodes that arrive with no air time go
  last.
- A list already on screen stays there while it reloads — refreshing swaps it out
  only once the new one has arrived, rather than dropping back to placeholders.
  If the refresh fails, the list stays put and the status bar says how old it is
  *and* what went wrong: `Updated 12m ago · Could not reach api.myepisodes.com.`
  The age is what makes a failed refresh readable, and replacing it with the error
  alone left no sign the list had ever been current. It keeps counting up while
  the popup is open, rather than insisting on the minute it was written.
- Only the failures a credential could explain point at the settings page: an
  `ApiError` earns that panel for `auth`, and for `scope`, which says which scope
  is missing and never asks for a new key. A network failure is deliberately on
  neither list — telling someone whose wifi is down to check their key sends them
  after the wrong thing. This used to read two clients' errors apart, so that a
  feed failure named the feed token and an API failure named the key; naming the
  wrong one would have sent the reader to a field the tab never touched. With one
  client there is one set of kinds to read.
- **This Week replaced All Today rather than sitting beside it.** All Today listed
  everything airing today across every show on MyEpisodes, watchlist or not, and
  no API endpoint answers that question — which is the sole reason the RSS layer
  survived the migration in the first place. Keeping the tab meant keeping an
  entire second client, a second parser for a title whose shape the account's own
  format preference decided, a second credential, and a stored
  password-equivalent secret, all for one tab out of four. Redefining it as
  `include_pilots=1` was the tempting way out and was rejected on its own terms:
  that flag adds S1E1 of any show, followed or not, so a version built on it would
  list premieres and nothing else — a different feature wearing the same tab's
  name. The honest options were keeping the feed or dropping the question, and a
  fourth window on the endpoint the other three already use answers a question
  worth asking with none of the machinery.
- **The *Following* flag went rather than being kept as a no-op.** It marked the
  cards on All Today whose show was on the watchlist, which was the whole point of
  a list that reached past it. Every row of `/v1/me/episodes` is an episode of a
  show the account follows, so on This Week the flag would be true on every card —
  and a mark that is always on is worse than no mark: it costs a colour, a word on
  every row, a tie-break rule against the premiere edge, and a second request to
  compute something the endpoint's own definition already guarantees.
  `.episode--followed`, `.episode__followed`, the star icon and the join that fed
  them are all gone, the *New show* flag inherited the tab, and the accent colour
  went back to being the tab strip's alone.
- **The API key became the required credential rather than the feed staying
  primary.** Leaving the feed in charge and treating the key as an upgrade would
  have kept every install working untouched — and kept the badge, three tabs and
  every flag on a card behind a title parser, with two ways to be configured and
  two shapes of item to render per tab for as long as that lasted. The key is what
  the extension runs on, so it is what "configured" means, and now it is the only
  thing there is to be.
- **The TVmaze cache is keyed by MyEpisodes show id rather than by TVmaze's own
  show id.** The natural key for a cache of TVmaze shows is TVmaze's number, and
  it was rejected because **no item carries one**: an `/v1/me/episodes` row is flat
  and its `external.tvmaze` is an *episode* id, and the feed items that used to
  make up the fourth tab carried no id as a field at all, only a link to an
  episode page. A TVmaze show id is a thing the extension learns *from* a lookup,
  which is too late to be what the lookup is filed under. The MyEpisodes show id is
  the one number every item already has. So it is the key, and the TVmaze ids stay
  what they are — hints, the routes into the API, never the thing an entry is filed
  under.
- **`status=` is never sent to `/v1/me/episodes`.** The enum would filter a window
  to `unwatched` or `todo` server-side, which sounds like less to download — most
  tempting on the week, which is the one window big enough to page. The unfiltered
  list is the point: it carries `acquired` and `watched` on every row, and that is
  what retired the `onlyunacquired` companion request and made `watched`
  displayable at all. A filtered list would say "these are the ones left" and leave
  both pills with nothing to read.
- The toolbar icons come from MyEpisodes' own artwork: the 16px is the site's
  `favicon.ico`, and the larger sizes are cut from `/img/myepisodes_logo.jpg`
  with the background made transparent.
- `manifest.json` carries no `homepage_url`, since there is nowhere public to point
  it at yet. Once this lives somewhere, add `"homepage_url": "<url>",` beside
  `"author"`.
- `minimum_chrome_version` is `111`, which is where CSS `color-mix()` landed — the
  panel count pill, the acquired and premiere card borders, and both mark pills in
  their active state all use it.
- Three marks can reach a card and two of them tint it, so each gets its own
  colour: `--success` for acquired, `--fresh` for a premiere, and `--watched` for
  watched. The premiere's amber has to be told apart from the green at a glance on
  a row that can carry both, and `--watched` is violet because it only ever
  colours its own pill — it never claims a card, so it only has to hold up against
  a background one of the other two may already have tinted.

## License

[MIT](LICENSE).
