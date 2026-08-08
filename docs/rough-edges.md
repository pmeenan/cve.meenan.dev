# Rough edges — findings log

Browser, WASM, OPFS, SQLite, PHP/nginx, and upstream-data bugs, quirks,
surprising limits, performance cliffs, and missing capabilities encountered
while building cve.meenan.dev. Evidence-backed findings are a project output,
not a side effect.

**Before adding:** grep for the API/library involved to avoid duplicates.
**Before debugging weirdness:** check here first — it may be known.

Every entry needs: environment (versions, OS, hardware where relevant), a
minimal reproduction or measurement, and observed vs. expected behavior.

Format:

```
## RE-NNN: Title  (YYYY-MM-DD, status: open | fixed-upstream | worked-around | wontfix)
Environment / Repro or measurement / Observed / Expected / Impact / Links
```

Newest first. RE-numbers are never reused.

---

## RE-025: `sites-enabled/meenan.dev` had been replaced by a regular file, so nginx edits landed in a file nobody was reading  (2026-08-08, status: fixed)

**Environment.** nginx on `plex`, Ubuntu, 2026-08-08, during the M5 launch.

**Repro / measurement.** `nginx.conf` carries the stock
`include /etc/nginx/sites-enabled/*;`. The owner edits
`sites-available/meenan.dev`, which is normally symlinked from `sites-enabled/`
— every file in that directory is, by the owner's convention. It was not:

```
$ ls -la /etc/nginx/sites-enabled/meenan.dev
-rw-r--r-- 1 root root 6435 Aug  8 12:59 /etc/nginx/sites-enabled/meenan.dev
$ diff /etc/nginx/sites-{enabled,available}/meenan.dev   # the new block, only in available
```

**Observed.** A `location = /sw.js` block added to `sites-available` had no
effect: `curl -D-` still reported `cache-control: max-age=315360000` from the
general static rule, on both a plain request and one with a cache-busting query
(`cf-cache-status: MISS` both times, so the origin was answering — not a stale
edge copy). The two files had silently diverged.

**Expected.** A symlink, so that editing either path is the same act.

**Impact and workaround.** Restored with
`ln -sfn /etc/nginx/sites-available/meenan.dev /etc/nginx/sites-enabled/meenan.dev`
plus `nginx -t` and a reload; the header flipped to `no-cache` immediately.
Before overwriting, `diff` the two and confirm nothing lives **only** in the
enabled copy — certbot writes `listen 443 ssl` / `ssl_certificate` lines into
these files, and clobbering them takes TLS down. Here the only enabled-only
lines were the same directives without `always`, so nothing was lost.

**Likely cause, worth knowing because it recurs.** In-place editors replace a
symlink with a regular file rather than writing through it: `sed -i` always
does, and vim does under `backupcopy=no`. The enabled copy's mtime was 12:59
that day, hours after the symlink convention was established.

**Lesson.** A config change is not applied because it was written — it is
applied when a response header says so. Verify from the outside, which is the
same rule D-039's Cloudflare criterion already states.

**Links.** `docs/architecture.md` (nginx section), D-039, D-048, D-054.

## RE-024: `createSyncAccessHandle` is not exposed on the main thread in any engine, so a capability check written there skipped the entire data-path suite  (2026-08-08, status: fixed)

**Environment.** Chromium 151, Firefox 153 and WebKit 26.5 via Playwright 1.62
on Ubuntu 24.04, 2026-08-08. Also confirmed against the deployed origin.

**Repro.** From `page.evaluate` — which runs on the **main thread** — against
either `http://127.0.0.1:4747/` or `https://cve.meenan.dev/`:

```js
{ getDirectory: typeof navigator.storage?.getDirectory,          // 'function'
  sync: 'createSyncAccessHandle' in FileSystemFileHandle.prototype }  // false
```

The same expression evaluated inside a `Worker` created on that page returns
`true`. Chromium exposes OPFS broadly but `FileSystemSyncAccessHandle` is
`[Exposed=DedicatedWorker]`, and the method that returns one goes with it.

**Observed.** `tests/e2e/support.ts`'s `skipWithoutLocalStorage` tested
`'createSyncAccessHandle' in FileSystemFileHandle.prototype` on the main thread,
concluded "this browser has no OPFS", and called `test.skip` — on **every**
engine, not just the WebKit build it was written for. Nine spec files use that
guard (`import`, `query`, `report`, `sync`, `staged`, `tabs`, `offline`, `bump`,
`a11y`), so the entire data path stopped being exercised while `pnpm e2e` stayed
green. A three-engine run reported zero failures and had tested nothing.

**Expected.** A guard that skips only where the app genuinely cannot run. The
misreading is easy because the check *looks* like a feature test and the engine
it was written against (RE-022) really is missing OPFS — the false negative on
Chromium was invisible behind a correct-looking skip on WebKit.

**Impact and workaround.** This is the same class as RE-020 — a test that tested
nothing — and it hid for the same reason: skips are not failures, and a summary
line reporting "N passed" does not say how many of the N ran. Fixed by moving
the probe into a Worker and having it **call** `getSize()` on a real handle
rather than look for the method (which is the app's own gate design, D-016 —
Safari 16.3 exposes it and throws). The probe uses a per-call filename and
releases the handle in `finally` (RE-007), and resolves `false` on a 15 s
timeout or `onerror` so an engine that cannot construct the Worker cannot hang
the suite.

**Lesson worth keeping:** a green run is only evidence if the count of tests
that *ran* is part of what you read. Check skip counts after touching a guard.

**Links.** `tests/e2e/support.ts`, RE-020, RE-022, RE-007, D-016.

## RE-023: Firefox serves a `no-cache` response from its HTTP cache when offline, so a sync reported "already current"  (2026-08-08, status: worked-around)

**Environment.** Firefox 153 via Playwright 1.62 on Linux, 2026-08-08. Chromium
151 does not do this.

**Repro.** `tests/e2e/offline.spec.ts`: import the corpus, register the service
worker, `context.setOffline(true)`, reopen the app, press **Sync**. `/data/` is
deliberately outside the service worker's scope (D-048) and the test asserts the
shell cache holds no `/data/` entry, so the manifest request goes to the network.
The Worker fetched it with `cache: 'no-cache'`.

**Observed.** On Firefox the sync *succeeded*: the page read
`Local copy at revision 1 — already current at the last check`. Chromium fails
the fetch and reports a network error, which is the correct answer with no
network. `no-cache` means **revalidate**, not "do not store", and with nothing
to revalidate against Firefox serves the stored response.

**Expected.** Not that it errors *because* of a header — a browser is entitled
to that reading — but that the app does not tell a user its copy is current when
it could not ask. The freshness line still showed the true age (1 hour), so
nothing claimed the data was fresh; the *sync outcome* was the misleading part.

**Impact and workaround.** The manifest is the freshness signal (D-042), so
reading it from any cache defeats its purpose — this is the same confusion D-048
keeps the service worker away from `/data/` to prevent, arriving one layer
lower. Fixed by fetching it with `cache: 'no-store'`, which makes it a network
request or nothing. The file is a few kilobytes, so the cost is nothing and the
behaviour is now identical across engines. Delta files are untouched: they are
immutable at their URLs and the ordinary cache is right for them.

**Links.** `workers/db.worker.ts` (`fetchManifest`), D-042, D-048, D-054.

## RE-022: Playwright's Linux WebKit ships no OPFS, so the Safari half of the support floor cannot be tested there  (2026-08-08, status: open)

**Environment.** Playwright 1.62's bundled WebKit 26.5 on Ubuntu 24.04,
2026-08-08.

**Measurement.** Against the app's own origin, in that browser:

| | value |
| --- | --- |
| `crossOriginIsolated` | `true` |
| `SharedArrayBuffer` | `function` |
| `navigator.locks` | `object` |
| `navigator.serviceWorker` | `object` |
| **`navigator.storage.getDirectory`** | **`undefined`** |

(An earlier version of this table also listed
`FileSystemFileHandle.prototype.createSyncAccessHandle` as absent. That row was
worthless: it was measured on the main thread, where **no** engine exposes it —
see RE-024. `getDirectory` is the row that actually separates this build from
the others.)

**Observed.** Everything cross-origin isolation buys is present and the storage
layer is simply not there, so the app cannot run: the capability gate fires with
"the corpus is a 441 MB SQLite database stored in the browser's private file
system. Without it there is nowhere to put it." Which is *correct* — and is the
first time the gate has been exercised on a browser that genuinely fails rather
than one told to pretend (`?probe=`, RE-020).

**Expected.** D-016's floor is Safari 16.4, which has OPFS and synchronous
access handles; real Safari on macOS and iOS is not what this is about. The gap
is between Safari and the Linux WebKit build Playwright ships, and there is no
Playwright option that closes it.

**Impact.** **The Safari half of the D-016 floor is not verified by this suite
and cannot be.** It rests on the documented feature availability plus the gate,
which is weaker than the Chromium and Firefox claims and is recorded here rather
than left implied.

**Resolution (owner decision, 2026-08-08): WebKit was removed from
`playwright.config.ts`.** The first response was to keep the project and skip
the specs it could not run, which is how RE-024 hid — a project contributing
nothing but skips looks identical in a summary line to one that passed. Removing
it makes the coverage claim legible: two engines run everything, and the Safari
gap is a documented hole rather than a green tick over an empty run. What is
given up is real and worth naming: WebKit was the only engine where the
capability gate fired on a browser that genuinely fails, so `resilience.spec.ts`
now exercises it only through the `?probe=` knob (RE-020). Re-adding the project
is a one-line change if a WebKit build with OPFS appears.

**Links.** `playwright.config.ts`, `tests/e2e/support.ts`, `lib/capabilities.ts`,
RE-024, D-016.

## RE-021: A `Response` served from a `Cache` becomes the worker's `location`, dropping the fragment its bootstrap config was in  (2026-08-08, status: worked-around)

**Environment.** Chromium 151 via Playwright 1.62, Linux, 2026-08-08. Next.js
16 / Turbopack static export, hand-rolled service worker (D-048).

**Repro.** Turbopack compiles `new Worker(new URL('../workers/db.worker.ts',
import.meta.url), { type: 'module' })` into a request for a shared bootstrap
chunk with the worker's chunk list in the **URL fragment**:

```
/_next/static/chunks/turbopack-worker-<hash>.js#params=<urlencoded json>
```

The bootstrap reads it back with `new URL(location.href)` — `searchParams.get('params')`,
falling back to `location.hash.startsWith('#params=')` — and throws
`Missing worker bootstrap config` if neither is there.

With the service worker installed, kill the network and open the app in a new
tab. The SW's network-first fetch fails, it falls back to
`caches.match(request)`, and returns that `Response` directly.

**Observed.** The worker's `self.location.href` is the *cached response's* URL —
no fragment — so the bootstrap throws immediately. The database worker never
starts. The app's shell renders perfectly, and then sits at
`data-status="pending"` forever: the page had no `worker.onerror` handler, so
nothing appeared on screen at all. Two hundred lines of correct offline
plumbing, defeated silently.

**Expected.** A worker's `location` to be the URL it was constructed with. The
fragment is never sent to the network and is not part of any `Response`'s URL,
so there is nowhere for a cache to preserve it — which makes this unfixable
*inside* the cache and only fixable by not letting the cached response's URL
become the worker's.

**Impact and workaround.** Fixed by re-wrapping: `new Response(cached.body,
{ status, statusText, headers })` has no URL of its own, so the worker keeps the
URL it was constructed with, fragment included. Online this never bit, because
the network path returns `fetch`'s own response — it appears only when the cache
is the one answering, which is exactly the case the offline shell exists for.
Two other things came out of it: the page now handles `worker.onerror` (a Worker
that cannot load must not be silent, D-052), and the cache fallback tries an
exact match *before* `ignoreSearch`, because `ignoreSearch` alone answers one URL
with another's bytes — and this app really does request
`sqlite3-opfs-async-proxy.js?vfs=opfs` and `?vfs=opfs-wl`.

**Links.** `scripts/sw.template.js`, `tests/e2e/offline.spec.ts`, D-048, D-054.

## RE-020: `page.addInitScript` does not reach a dedicated Worker's global scope  (2026-08-08, status: worked-around)

**Environment.** Playwright 1.62, Chromium 151, Linux, 2026-08-08.

**Repro.** M5's capability gate probes `FileSystemSyncAccessHandle.getSize()`
and reads whether it returned a number or a Promise (D-016) — the only way to
tell Safari 16.4 from 16.3, where the same interface exists and its methods are
async. To test the gate's message, the obvious move is to patch the prototype:

```ts
await page.addInitScript(() => {
  const original = FileSystemFileHandle.prototype.createSyncAccessHandle
  FileSystemFileHandle.prototype.createSyncAccessHandle = async function () { … }
})
await page.goto('/')
```

**Observed.** The patch applies to the page and its iframes. The probe runs
inside `workers/db.worker.ts` — a *dedicated Worker*, with its own global scope
and its own copy of every built-in — and sees the unpatched prototype. The gate
therefore passed and the test failed with no indication that the patch had
simply not arrived anywhere it mattered.

**Expected.** Nothing in the documentation promises worker coverage; the surprise
is only that a page-level init script is the reflex, and this app puts almost
everything worth faking inside a Worker. Playwright has no equivalent hook for
dedicated workers created by page script.

**Impact.** Any Worker-side condition this project wants to force in a test —
capabilities, storage, SQLite behaviour — has to be forced *through the
message protocol*, not by patching globals. M5 added `ImportOptions.probe`
alongside the existing `?schema=`, `?vfs=` and `?stall=` knobs for exactly this,
and constrained it so it can only make the gate stricter: a diagnostic that can
loosen a safety check is a different kind of thing from one that cannot.

**Links.** `lib/capabilities.ts`, `tests/e2e/resilience.spec.ts`, D-016.

## RE-019: An accessible name includes the value of the control its label wraps  (2026-08-05, status: worked-around)

**Environment.** Chromium 151 via Playwright 1.62 on Linux, 2026-08-05.
Accessible-name computation is the spec's (accname §4.3.2 step 2F), so this is
every engine, not a Chromium quirk.

**Repro.** Two labelled controls on the same page:

```html
<label><span>Group by</span><select>…</select></label>
<label><span>SQL</span><textarea>SELECT … GROUP BY w.id …</textarea></label>
```

`page.getByLabel('Group by')` matches **both**, and fails with a strict-mode
violation naming the textarea.

**Observed / expected.** Expected the textarea's name to be `SQL`. It is
`SQL SELECT … GROUP BY w.id …`: when a label wraps a control, the value of that
control is part of the label's text content, so a `<textarea>` names itself with
whatever the user has typed into it. Playwright's `getByLabel` is a substring
match by default, so any query the user pastes can start matching unrelated
fields.

**Impact.** A test that is *scoped to the right form* is unaffected; one that
searches the page is not, and the failure mode is a locator resolving to a
control on the other side of the page. Worse, it depends on the *contents* of a
text box, so it appears and disappears with the example SQL. The fix is to scope
locators to the form under test (`page.locator('form.filters').getByLabel(…)`),
which `tests/e2e/query.spec.ts` now does for every field.

**Links:** M3's query surfaces; `tests/e2e/query.spec.ts`.

## RE-018: The e2e suite serves `dist/`, so an unbuilt UI change is invisible to it  (2026-08-05, status: fixed)

**Environment.** This repository, Playwright 1.62, Next.js 16 static export.

**The trap.** `playwright.config.ts` starts `scripts/serve.mjs` over `dist/` —
the export, on purpose, because the export is what ships (D-027, and RE-012 is
what happens when the local server is more permissive than production). But
`pnpm e2e` did not build first, so an edited component that had not been through
`next build` was simply not on screen. The tests then pass or fail against the
*previous* version of the app.

**Observed.** An M3 assertion on a newly added `data-run` attribute failed with
"expected not null" for two full runs; the attribute was in the component and
not in `dist/`. The tests were green about code that was not running.

**Why it is worth an entry.** The failure looks like a bug in the code under
test, not like a stale artifact, and it gets *worse* as the suite grows: a
change that only adds behaviour produces a plausible-looking failure, while a
change that only removes behaviour produces a plausible-looking pass.

**Fix.** The `webServer` command is now `npx next build && node scripts/serve.mjs`,
so the served export is always the working tree. Turbopack builds this project
in a few seconds, which is cheaper than one wrong debugging session. `pnpm check`
is unaffected — it never serves anything.

**Links:** D-027 (static export), RE-012 (the local server matching production).

## RE-017: Overwriting a SQLite database while its rollback journal survives replays the old journal into the new file  (2026-08-04, status: worked-around)

**Environment.** SQLite 3.45.1 via Python 3.12.3 on Linux; the same commit
machinery the `@sqlite.org/sqlite-wasm` 3.53.0 build uses in the browser. Any
journal-mode database, which is what the pipeline publishes (header bytes 18/19
= 1).

**Repro.**

1. Build a database whose rows are marked `GENERATION-A`, then kill a process
   mid-commit until a rollback journal survives (see RE-016's repro loop).
2. Build a second, entirely valid database marked `GENERATION-B`.
3. Copy B's bytes over the first database's *main file only*, leaving the
   journal in place — what a staged download does when it reuses a slot.
4. Open it.

**Observed.** The file stops being B. Before the open its bytes are identical to
B; after the open they are not, and the 4,000 rows it then holds match neither
marker — SQLite replayed A's pages into B's file. No error is raised.

**Expected.** Nothing to expect, really: SQLite documents this exact pattern as
a corruption path
(https://sqlite.org/howtocorrupt.html#_mispairing_database_files_and_hot_journals,
read 2026-08-04). The trap is that the pairing is by *file name*, so a journal
becomes a hazard to a file that never had anything to do with it.

**Impact here.** Staged replacement reuses two slots by name (D-061). A crash
during the client's index build leaves a journal beside the staging slot; the
next download writes a new generation's verified bytes into that same name. The
promotion gate then inspects a database that is no longer the artifact whose
chunk hashes were checked — and the gate reads `meta` and a row count, which a
replayed page can leave intact. Worked around by removing a slot's sidecars
before any raw byte is written into it, and *not* removing them when the bitmap
is already complete, where the journal legitimately belongs to the file and
rolling back a half-built index is the correct outcome. Regression test:
`tests/e2e/staged.spec.ts`, "sidecars beside a staging slot are cleared before
its bytes are reused" — which plants a superjournal rather than a `-journal`,
because SQLite's own recovery deletes a malformed `-journal` and the test would
otherwise pass against the bug.

**Links:** D-061, RE-016, RE-014 (the other silent way to get a
correctly-sized, wrong database).

## RE-016: A SQLite database header can advertise a change the rollback journal has yet to commit  (2026-08-04, status: worked-around)

**Environment.** SQLite 3.45.1 via Python 3.12.3 on Linux. Not engine-specific —
it follows from the documented commit sequence
(https://sqlite.org/atomiccommit.html, read 2026-08-04).

**Repro.** In a loop: create a database with `user_version=5`, start a child
that repeatedly commits a transaction setting `user_version=9` and then resets
it, `kill -9` the child after a random 200–700 ms, and stop when a
`-journal` file survives. Then compare the header field at byte offset 60 with
what SQLite reports after opening. Reproduced on the **first** attempt.

**Observed.** Raw header bytes 60–63 read `9`; `PRAGMA user_version` after the
open reads `5`, and the journal is gone. The bytes on disk described a change
that never committed.

**Expected.** Exactly this, once stated: commit writes the dirty pages *and
then* deletes the journal, so between those two steps the main file is ahead of
the committed state. The journal is the authority, not the page contents.

**Impact here.** Staged replacement records which of two database files is live
in `PRAGMA user_version` (D-061), and reading it from the header was tempting —
one 100-byte read instead of an open. It is unsound: a crash during a promotion
leaves a slot advertising a promotion that the next open rolls back, that slot
wins discovery, and the sweep then deletes the database that really was live.
Worked around by reading the counter through SQLite (which performs the recovery
as a side effect, so discovery judges a consistent file) and by deleting nothing
until the chosen database is open and answering.

**Not reproducible in the browser.** Producing a genuine half-committed journal
needs a kill inside the commit sequence, which a Playwright test cannot arrange;
the in-browser regression uses a slot SQLite cannot open at all, and this
reproduction covers the race itself.

**Links:** D-061, RE-017.

## RE-015: A lone surrogate in a CVE description is legal JSON that SQLite cannot store  (2026-08-02, status: worked-around for the daily ingest 2026-08-03; closed for `build.py` 2026-08-08)

**Environment.** Python 3.12.3 `sqlite3` (SQLite 3.45.1) on Linux; reachable
from any record in cvelistV5, which is attacker-influenced input (AGENTS.md
rule 5).

**Repro.**

```python
text = json.loads('"\\ud800"')          # legal JSON, parses to '\ud800'
sqlite3.connect(":memory:").execute("CREATE TABLE t(x TEXT)").execute(
    "INSERT INTO t VALUES(?)", (text,))
# UnicodeEncodeError: 'utf-8' codec can't encode character '\ud800'
# in position 0: surrogates not allowed
```

**Observed.** `json.loads` accepts an unpaired surrogate escape and produces a
`str` that has no UTF-8 encoding, so the failure surfaces at *insert* time — a
`UnicodeEncodeError` raised from inside `executemany`, naming a codec rather
than a record.

**Expected.** Not that it stores — the string genuinely is not encodable — but
that `pipeline/build.py` refuses the record through the `skipped` channel D-047
built for records that cannot be published, with the file name in the message.
Today it is a traceback with no idea which of 372,092 records caused it.

**Impact.** Fail-*stopped* rather than fail-closed: nothing wrong is published,
and D-056's cleanup means no partial artifact is left behind
(`test_a_failed_build_leaves_no_artifact_behind` uses this as its trigger). But
one hostile record halts the daily ingest with an undiagnosable error. The fix
is a projection-level check, whose cost has to be measured against the whole
corpus first — every string of every record, per build — which is why it is
recorded rather than guessed at.

**Worked around for the ingest (2026-08-03, D-058).** The cost question is
answered by not paying it twice: `normalize.content_hash` already encodes the
whole projection to UTF-8, and the daily ingest's hash pass runs it over every
record *before* the build (16.9 s for 372k records, measured — the same walk the
tombstone guard needs anyway). So `ingest.scan` catches the `UnicodeEncodeError`
and routes the record through the `skipped` channel, naming the file; the run
then aborts before building, as it does for any unpublishable record.

**Closed for `build.py` (2026-08-08, M5).** The cost estimate above was
pessimistic: it assumed the check needed a *hash*, and it does not — encoding
the projection's strings is C-speed and the strings are being read anyway.
`normalize.storable` walks the projection and encodes every string; the walk
routes a failure through D-047's `skipped` channel with the file name, which
`main` then fails closed on. Two things forced the issue rather than leaving it
recorded: the schema-bump runbook uses `build.py` directly on the full corpus,
and schema 2 added `title` and `reason` — two more attacker-influenced text
columns per record, so the surface grew at the same time as the exposure.

## RE-014: `FileSystemSyncAccessHandle.write()` may write fewer bytes than asked  (2026-08-01, status: worked-around)

**Environment.** The File System Standard, `write()` on
`FileSystemSyncAccessHandle`
(https://fs.spec.whatwg.org/#api-filesystemsyncaccesshandle-write, read
2026-08-01). Applies to every OPFS-writing browser, not one engine.

**The trap.** `write()` *returns the number of bytes written*, and the standard
requires callers to handle a short write rather than assume it took the whole
buffer. Nothing about the API's shape suggests that: it is synchronous, it takes
a buffer and an offset, and the return value is easy to discard — which is
exactly what this project did for its first two months.

**Why it is worse here than usual.** The import writes twelve 32 MiB chunks
positionally into a 377 MB database. A short write does not throw and does not
truncate the file — the file is pre-sized by `truncate()` — so the result is a
correctly-sized SQLite database with a hole in it. Nothing detects it at import
time: the chunk's SHA-256 was verified *before* the write, `count(*)` reads a
different page, and the damage surfaces later as a malformed page in whichever
query first touches that region. A user would report "some queries are broken",
which points nowhere near the cause.

**Fix.** `writeFully()` in `lib/opfs.ts` loops until the buffer is drained,
advancing the offset by bytes actually written, and throws if a call reports no
progress rather than spinning forever (a hang would violate D-052's requirement
that stalls be distinguishable from slowness). Regression-tested in
`tests/unit/opfs.test.ts` against a handle that deliberately writes 300 bytes at
a time.

**Not observed in the wild.** Chromium has not been seen writing short in this
project's runs — this is a standard-conformance fix, not a reproduction. That
is the point: it would be invisible until it was not.

**Links:** D-041 (chunked positional writes), D-052 (stalls versus slowness).

## RE-013: A hard reload does not bypass the cache for a dedicated Worker's dynamic import  (2026-08-01, status: open)

**Environment.** Chromium 151 (Playwright 1.62) on Linux 6.17, 2026-08-01.
Observed first by the project owner in desktop Chrome against the deployed
site, then reproduced.

**Why it matters here.** The Worker loads the SQLite distribution with a runtime
`import()` (`workers/db.worker.ts`, `SQLITE_ENTRY`). When RE-012 left a wrong
`Content-Type` in a browser's HTTP cache, **Ctrl+Shift+R did not clear it** —
only DevTools' "Disable cache" did. The standard remedy for a stale asset does
not reach this class of request, so a user in this state has no obvious way out.

**Measurement.** A page and a dedicated module Worker each `import()` the *same*
URL. The server sends `Last-Modified` and no `Cache-Control` (heuristic
freshness — what nginx sent for `/sqlite/`), and flips that file's
`Content-Type` from `application/octet-stream` to `text/javascript` **without
changing the file**, exactly as fixing `mime.types` does. `Page.reload` with
`ignoreCache: true` is Chrome's hard reload.

| Step | Document's import | Worker's import | Network responses seen |
| --- | --- | --- | --- |
| Broken MIME | fails | fails | 1 |
| Server fixed, then **hard reload** | **succeeds** | **still fails** | **1** |
| Server fixed, then cache disabled | succeeds | succeeds | 2 |

The single response on the middle row is the point: only the document re-fetched.
The Worker reused its cached entry and never hit the network.

A first attempt to reproduce this *failed to reproduce it* — because it changed
the file's contents, which moved `Last-Modified`, drove heuristic freshness to
about zero and forced the Worker to revalidate anyway. The bug only bites when
the cached entry is still heuristically fresh, which is the normal state for an
asset deployed any length of time ago. Worth knowing before concluding that a
cache problem "isn't reproducible".

**Observed vs. expected.** Expected a hard reload to mean "fetch everything this
page needs from the network". It means "…everything the *document* fetches";
a dedicated Worker's module imports are a separate fetch path and keep using the
HTTP cache.

**Impact.** The client-side remedy for a poisoned cache entry effectively does
not exist for anything the Worker loads, which makes the server-side cache
policy load-bearing rather than a tidiness matter — this is the direct
justification for D-054 serving `/sqlite/` as `no-cache`. It also means M5's
service worker must be network-first (D-054): a cache-first SW would reintroduce
exactly this trap one layer up, where a user cannot clear it at all.

**Not established.** Whether the same holds for the Worker's *own* script, for
`importScripts()` in a classic worker, or in Firefox/WebKit. Only the module
`import()` case above was measured.

## RE-012: nginx's stock `mime.types` has no `.mjs`, and the local dev server hid it  (2026-08-01, status: fixed-upstream-config)

**Environment.** nginx 1.30.2 on `plex`, Debian package defaults, 2026-08-01,
during the first deploy of `cve.meenan.dev`.

**Measurement.** The Worker loads the SQLite distribution at runtime from
`/sqlite/index.mjs` (a runtime URL, not a bundled import). In production that
request returned:

```
$ curl -sI https://cve.meenan.dev/sqlite/index.mjs
HTTP/2 200
content-type: application/octet-stream
```

`/etc/nginx/mime.types` shipped `application/javascript js;` with no `mjs`
entry, so `.mjs` fell through to `default_type`. Browsers apply strict MIME
checking to module scripts, so the import was refused and the page reported:

> Failed to fetch dynamically imported module:
> `https://cve.meenan.dev/sqlite/index.mjs`

The database never opened. `.wasm` was unaffected — `application/wasm wasm;` is
in the stock file.

**Observed vs. expected.** Expected a `.mjs` file to be served as JavaScript,
since it is the standard extension for an ES module and the file is part of an
unmodified upstream distribution. nginx has been slow to add the mapping and
Debian's package still lacked it here.

**Impact, and the part worth remembering.** `scripts/serve.mjs` exists to
reproduce production headers so that browser measurements mean something — and
its type table maps `.mjs` to `text/javascript`, which nginx did not. So the
one divergence between the two servers was on the exact file whose MIME type is
load-bearing, and it was invisible until the first deploy: `pnpm e2e` passed
locally against the same code that could not boot in production.

A local server that is *more* permissive than production does not fail safe. If
`serve.mjs` and nginx disagree about anything, prefer teaching `serve.mjs` to be
as strict as nginx rather than the reverse.

**Fix.** `text/javascript js mjs;` in `/etc/nginx/mime.types` (owner-applied).
Verified: `content-type: text/javascript`, and the full-corpus import now
completes against the deployed origin.

**Links:** D-030 (server configuration baseline), `scripts/serve.mjs`.

## RE-011: `performance.measureUserAgentSpecificMemory()` is unusable for measuring this app  (2026-08-01, status: worked-around)

**Environment.** Playwright 1.62's bundled Chromium (headless), Linux
6.17, 2026-08-01. Page served by `scripts/serve.mjs` with production's
COOP/COEP, `self.crossOriginIsolated === true` in both the document and the
dedicated Worker.

**Measurement.** Probed the API from a page and from a dedicated Worker.

| Context | `typeof performance.measureUserAgentSpecificMemory` | Call result |
| --- | --- | --- |
| Document | `function` | `SecurityError: … is not available.` |
| Dedicated Worker | `undefined` | `TypeError: … is not a function` |

Adding `--site-per-process` to the browser launch changed nothing. Also probed:
`performance.memory` is present on the document but **absent in the Worker**,
which is where all the memory that matters is allocated.

**Observed vs. expected.** The API is the standardized way to ask "how much
memory is this page using", is documented as available in dedicated workers,
and gates itself on cross-origin isolation — which is satisfied here. It threw
anyway, and is missing outright in the Worker. Cause not established; the
plausible candidates (headless shell process model, a Blink flag) were not
worth further pursuit once a better measurement existed.

**Impact.** Peak memory for Q-003 cannot be measured from inside the page. The
sweep reads `VmHWM` — the kernel's own high-water mark — from
`/proc/<pid>/status` for the renderer processes Playwright launched
(`tests/e2e/measure.spec.ts`, `rendererPeak()`), which is both exact and
immune to sampling gaps, at the cost of being Linux-only and unavailable to
the future diagnostics panel (D-009). The Worker additionally reports SQLite's
WASM linear memory, which it *can* see.

**Links:** [MDN: measureUserAgentSpecificMemory](https://developer.mozilla.org/en-US/docs/Web/API/Performance/measureUserAgentSpecificMemory),
Q-003 in [features.md](features.md).

## RE-010: Hosted-LLM CORS preflights from curl disagree with documented browser support  (2026-08-01, status: open)

**Environment.** curl 8.5.0 on Linux, 2026-08-01. `OPTIONS` requests with
`Origin: https://cve.meenan.dev`, `Access-Control-Request-Method: POST`, and
`Access-Control-Request-Headers: authorization,content-type,x-api-key,anthropic-version`
against the four hosted providers the D-045 ladder names.

**Measurement.**

| Endpoint | Preflight result |
| --- | --- |
| `api.openai.com/v1/chat/completions` | 200, `access-control-allow-origin` echoes the origin |
| `openrouter.ai/api/v1/chat/completions` | 204, `access-control-allow-origin: *` |
| `api.anthropic.com/v1/messages` | **400**, with `allow-methods`/`allow-headers` present but no `allow-origin` |
| `generativelanguage.googleapis.com/…:generateContent` | **403**, no CORS headers at all |

**Observed vs. expected.** OpenAI and OpenRouter are unambiguously
browser-callable. The other two *contradict their documentation*: Anthropic
documents browser use behind an `anthropic-dangerous-direct-browser-access`
opt-in header, and Google's official JS SDK claims client-side support — yet
both preflights failed. The likely cause is methodological: a hand-rolled curl
preflight may not reproduce what the browser actually sends (Anthropic's 400
may reflect the opt-in header missing from `Access-Control-Request-Headers`;
Google's 403 arrived on a keyless request and may mask CORS behavior behind
auth rejection).

**Impact.** curl preflights are a screening tool, not a verdict, for CORS
support. D-045's provider claims for Anthropic and Gemini are marked
needs-verification for exactly this reason; the M7 exit requires re-verifying
each adapter from a real browser before it ships. Re-measure from an actual
page on the deployed origin, with a real key, before concluding a provider is
browser-blocked.

**Links:** D-045 (provider ladder and the sources for each provider's
documented stance), RE-001 (the same lesson for GitHub's endpoints).

## RE-009: Latest-version toolchain outruns its own ecosystem  (2026-08-01, status: worked-around)

**Environment.** Scaffolding cve.meenan.dev on 2026-08-01: Node 24.16.0,
pnpm 11.14.0, Next.js 16.2.12.

**Measurement.** Three independent breakages from installing `@latest`, each
fatal to a different check:

| Installed | Breaks | Symptom |
| --- | --- | --- |
| typescript 7.0.2 | `next build` type check | *"TypeScript 7.0.2 does not provide the compiler API required by Next.js"* |
| typescript 7.0.2 | typescript-eslint 8.65.0 | *"typescript-eslint does not support TS 7.0"* ([issue 10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)) |
| eslint 10.8.0 | eslint-plugin-react 7.37.5 | `TypeError: contextOrFilename.getFilename is not a function` |

Two smaller ones in the same session: pnpm 11 ignores the `pnpm` field in
`package.json` with only a warning and expects `allowBuilds` in
`pnpm-workspace.yaml` instead — and until build policy is declared,
`pnpm install` exits non-zero, which makes `next build` fail before it starts.
And a `licenses` entry in `scripts` is shadowed by pnpm's built-in
`pnpm licenses`, so the script silently never runs.

**Observed vs. expected.** Naively, that the newest releases of a mainstream
toolchain work together. TypeScript 7 is the Go rewrite and ESLint 10 is a major
with API changes; both landed ahead of the plugins that depend on their internals.

**Impact.** Cost most of the scaffolding time in M1, and every failure was a
confusing error a long way from its cause. Resolved by pinning **TypeScript 6**
(which also removed the need for Next's `experimental.useTypeScriptCli`) and
**ESLint 9**. Both are deliberate downgrades recorded in `package.json`, not
accidents — revisit when typescript-eslint supports TS 7 and eslint-plugin-react
supports ESLint 10.

The general lesson for a project where agents write most of the code (D-001):
`@latest` is the wrong default for anything a *plugin ecosystem* attaches to.
Compilers and linters are exactly that.

## RE-008: A worker spawned from a COEP document must itself be served with COEP  (2026-08-01, status: worked-around)

**Environment.** Chromium via Playwright 1.62.1, cross-origin isolated page,
Next.js 16 static export, 2026-08-01.

**Repro.** Serve the document with `Cross-Origin-Embedder-Policy: require-corp`
but serve `.js` without it, then `new Worker(url, { type: 'module' })`.

**Observed.** The request fails with `net::ERR_BLOCKED_BY_RESPONSE`. There is
**no console message, no exception, and no error event** — the worker simply
never starts, so the application hangs in whatever state preceded it. The
failure is visible only in the network log.

**Expected.** At minimum a console diagnostic. `Cross-Origin-Resource-Policy:
same-origin` on the script is *not* sufficient: a dedicated worker inherits the
embedder policy and its own response must carry COEP.

**Impact.** Cost a debugging cycle on a symptom that looked like the import path
hanging. Production is unaffected — nginx sets COOP/COEP at *server* level
(D-030), which covers scripts as well as documents — but the local Playwright
server initially set them only on HTML, which is exactly the plausible-looking
mistake. `scripts/serve.mjs` now sets them on every response and says why.

Anything that reproduces production headers must reproduce them at the same
scope, or it tests a different application.

## RE-007: Closing an OPFS sync access handle is async, and opening the file again hangs  (2026-08-01, status: worked-around)

**Environment.** Chromium via Playwright 1.62.1, `@sqlite.org/sqlite-wasm`
3.53.0-build1, `opfs` VFS, cross-origin isolated, 2026-08-01.

**Repro.** In a Worker: write a database file through a
`FileSystemSyncAccessHandle`, call `close()` without awaiting it, then open the
same path with `new sqlite3.oo1.OpfsDb(...)`.

```js
const access = await handle.createSyncAccessHandle()
access.write(bytes, { at: 0 })
access.flush()
access.close()            // not awaited
db = new sqlite3.oo1.OpfsDb('/cve.sqlite', 'c')   // never returns
```

**Observed.** `OpfsDb` never returns and never throws. No exception, no console
output, no timeout — the import sits at "Opening database" indefinitely.
Diagnostics at that moment report everything as healthy: `crossOriginIsolated`
true, the `opfs` VFS registered, `OpfsDb` a function.

**Expected.** Either `close()` to be synchronous as the current spec declares,
or a lock error from the second opener.

**Impact.** High, because the failure mode is a silent hang in the one path
every user takes. The exclusive lock is not released until `close()` settles,
and Chromium has shipped promise-returning forms of these methods, so the
declared-synchronous signature cannot be relied on.

**Workaround.** `await access.close()`. Awaiting a non-promise is harmless, so
this is correct under either behavior — and worth doing for `flush()` on the
same reasoning.

## RE-006: A shallow clone reports every upstream advance as a forced update  (2026-07-31, status: worked-around)

**Environment.** git 2.54.0 on `plex`, against the `--depth 1 --no-tags` clone
of cvelistV5 (D-021).

**Repro.**

```bash
git fetch --depth 1 origin main
# + a42a2eb6c2...d300c5fcc0 main -> origin/main  (forced update)
```

**Observed.** The `+` and `(forced update)` markers appear on an ordinary
fast-forward. A shallow clone records its single commit as a graft root with no
parents, so the incoming commit is not a *known* descendant of the local ref;
git cannot prove fast-forward and reports the update as forced.

**Expected.** Naively, a normal fast-forward line, since upstream did nothing
unusual — 21 changes across 21.4 hours of routine publishing.

**Impact.** This is the answer to an open architecture question: **a shallow
clone cannot distinguish a normal advance from an upstream force-push or history
rewrite**, so `git fetch` output is worthless as a cache-invalidation signal.
Every fetch looks like a rewrite.

Worked around by not depending on it. The ingest pipeline diffs *content
hashes* between the previous and current working tree (D-031), never git
history, so a rewritten upstream history produces exactly the same delta as any
other change to the same files. The signal git cannot give us is one the design
does not consume.

## RE-005: FTS5 `integrity-check` does not check external content by default  (2026-07-31, status: open)

**Environment.** SQLite 3.45.1 (2024-01-30) on `plex`, native build, against the
272.8 MB spike database with `fts USING fts5(descr, content='cve_text',
content_rowid='cve_id')`.

**Repro.** Change the content table without telling the index, then ask all
three documented forms of the check:

```sql
UPDATE cve_text SET descr='quenelle placeholder' WHERE cve_id=1;   -- no fts 'delete'
INSERT INTO fts(fts) VALUES('integrity-check');            -- PASSED
INSERT INTO fts(fts, rank) VALUES('integrity-check', 0);   -- PASSED
INSERT INTO fts(fts, rank) VALUES('integrity-check', 1);   -- "database disk image is malformed"
```

**Observed.** Only the `rank = 1` form detects the drift. The bare form and the
explicit `0` both pass on a database whose index no longer agrees with its
content table — and searches confirm the damage is real: the row still matches
terms its text no longer contains.

**Expected.** Nothing better, on reflection — this is documented behavior, not a
bug. [The FTS5 documentation](https://www.sqlite.org/fts5.html) states: *"For an
external content table, the contents of the index are only compared to the
contents of the external content table if the value specified for the rank
column is 1."* Verified against the documentation 2026-07-31.

**Impact.** The trap is that the *obvious* invocation is the useless one. An
agent adding a post-sync integrity check would naturally write
`INSERT INTO fts(fts) VALUES('integrity-check')`, watch it pass, and conclude
the index is sound — while shipping exactly the silent search corruption D-025
hazard 2 exists to prevent. **Always pass `rank = 1`** against an
external-content table; the bare form only proves the index is not internally
corrupt.

Cost measured on the spike database: 0.8 s for the full 55 MB index, which is
affordable as an explicit verification action but not on every sync.

**Re-verified 2026-08-04 on SQLite 3.53.0** — `node:sqlite`, the same version
`@sqlite.org/sqlite-wasm` ships — against the published schema, and it carries
over unchanged: a `cve_text` row updated without the `'delete'` protocol still
passes the bare `integrity-check` and still fails at `rank = 1`, with the row
still matching a word its text no longer contains. That reproduction is a
standing test (`tests/unit/sync.test.ts`), so M2's delta apply cannot quietly
lose the protocol; it is the check every case in that file ends with. It is
deliberately *not* run after a sync at runtime — at full scale it re-tokenizes
122 MB of description text, about what building the index cost in the first
place (~58 s) — so it belongs in the tests and in M5's diagnostics panel as
something a user can ask for.

**Links.**
- [SQLite FTS5 — the 'integrity-check' command](https://www.sqlite.org/fts5.html)

## RE-004: `git log --format=<single-token>` is rejected as a named format  (2026-07-30, status: worked-around)

**Environment.** git 2.54.0 on `plex`.

**Repro.**

```bash
git log --format=C --name-only -n 1     # fatal: invalid --pretty format: C
git log --format=C%cI --name-only -n 1  # works
```

**Observed.** A format string consisting of a single bare token is parsed as a
*named* format (like `oneline`, `medium`, `raw`) and rejected when it does not
match one. Adding any placeholder makes it a literal format string.

**Expected.** `--format=C` to emit the literal `C` per commit, as `--format=C%cI`
does.

**Impact.** Low, but it fails in a way that wastes time: with stderr discarded —
common in a pipeline — git emits nothing, the downstream stage sees empty input,
and the result looks like "no commits matched" rather than a usage error. Cost
two debugging round trips here. Use an unambiguous format such as `%H` when
scripting.

## RE-003: One CVE record has 6,074 revisions — 178× the 99.9th percentile  (2026-07-30, status: open)

**Environment.** cvelistV5 at `a42a2eb6c2` (2026-07-31T01:48Z), 372,092 records,
74,082 commits.

**Measurement.** Revision counts per record, computed from git history:

| Statistic | Revisions |
| --- | --- |
| p50 | 3 |
| p90 | 5 |
| p99 | 19 |
| p99.9 | 34 |
| max | **6,074** |

Only 28 records exceed 50 revisions; exactly one exceeds 500. The outlier is
`cves/2025/7xxx/CVE-2025-7195.json` — assigner `redhat`, PUBLISHED, published
2025-08-07, last updated 2026-07-26, 88,587 bytes. Mean across all records is
4.10.

Separately, `cves/delta.json` and `cves/deltaLog.json` carry 63,208 revisions
each. Those are the publishing pipeline's own churn files, not CVE records, and
must be excluded from any corpus scan — they are the reason a naive
`find cves -name '*.json'` overcounts.

**Observed vs. expected.** A distribution where 99.9% of records sit at ≤34
revisions and one sits at 6,074. That is far outside editorial plausibility and
reads as an upstream publishing-pipeline artifact rather than 6,074 meaningful
edits.

**Impact.** Now a corpus observation rather than a feature constraint. It was
originally cited in support of D-012, but D-020 dropped revision counts from
scope and D-021 made the clone shallow, so nothing ships that surfaces this.
Retained because it says something durable about the data: revision counts in
cvelistV5 measure *publishing-pipeline* activity as much as editorial activity,
and any future feature tempted to present them as "how much this record was
revised" would be misreading them. Reproducing this measurement now requires an
unshallow fetch.

**Links.**
- [CVE-2025-7195](https://www.cve.org/CVERecord?id=CVE-2025-7195)

## RE-002: cve.org legal pages return no text without JavaScript  (2026-07-30, status: worked-around)

**Environment.** `curl` and any non-JS fetcher against `https://www.cve.org/`,
2026-07-30.

**Repro.**

```bash
curl -s https://www.cve.org/legal/termsofuse | wc -c   # 880 bytes
```

**Observed.** 880 bytes of shell HTML whose only visible text is *"We're sorry
but the CVE Website doesn't work properly without JavaScript enabled."* The
terms themselves never appear. The site is a client-rendered SPA and the legal
copy is compiled into a ~4.4 MB JS bundle.

**Expected.** A legal terms page — the document that governs reuse of the
corpus — to be readable by a plain HTTP client.

**Impact.** Any agent or script verifying the licensing terms will silently get
nothing useful, and a careless one may conclude the terms are unavailable or,
worse, answer from memory. This is the exact failure AGENTS.md rule 4 warns
about.

**Workaround.** Read the terms from their source in the website repository,
which is plain text and version-controlled:

```bash
curl -s https://raw.githubusercontent.com/CVEProject/cve-website/main/src/views/Legal/TermsOfUse.vue
```

The verbatim operative clause, as of this date, is quoted in D-008.

**Links.**
- [cve.org/legal/termsofuse](https://www.cve.org/legal/termsofuse)
- [CVEProject/cve-website](https://github.com/CVEProject/cve-website)

## RE-001: GitHub bulk-download paths send no usable CORS headers  (2026-07-30, status: open)

**Environment.** Measured from the command line with an explicit
`Origin: https://cve.meenan.dev` request header, 2026-07-30.

**Repro.**

```bash
curl -sIL -H "Origin: https://cve.meenan.dev" \
  "https://github.com/CVEProject/cvelistV5/releases/latest/download/release_notes.md"
curl -sI -H "Origin: https://cve.meenan.dev" \
  "https://codeload.github.com/CVEProject/cvelistV5/zip/refs/heads/main"
```

**Observed.**

| Endpoint | `access-control-allow-origin` |
| --- | --- |
| `release-assets.githubusercontent.com` (final hop for release assets) | *absent* |
| `codeload.github.com` (zipball/tarball) | `https://render.githubusercontent.com` |
| github.com git smart-HTTP | *absent* |
| `raw.githubusercontent.com` | `*` |
| `api.github.com` | `*` |

Release assets do support range requests (`accept-ranges: bytes`, verified with
a `Range: bytes=0-99` request returning `206`) — the blocker is purely CORS, not
partial-transfer support.

**Expected.** Naively, that a public download URL is fetchable from a browser.
It is not, for any bulk path.

**Impact.** Load-bearing. This is the measurement behind D-005 and D-006: it
rules out fetching the ~562 MB baseline or the hourly delta ZIPs directly from
the browser, and combined with the repository's ~2.36 GB size it rules out
in-browser git. Recorded here so a future agent finds the evidence before
re-proposing a browser-side download path.

**Note for re-verification.** This is a snapshot of GitHub's behavior on one
date, not a standing guarantee. Re-run the commands above before relying on it
in either direction.

**Links.**
- [cvelistV5](https://github.com/CVEProject/cvelistV5)
- [isomorphic-git CORS proxy requirement](https://isomorphic-git.org/docs/en/clone.html)
