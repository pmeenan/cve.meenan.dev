# Decision log

Newest first. Every entry: what was decided, why, and what would reopen it.
Existing entries are never edited into a different decision — reversing or
amending one gets a *new* entry that supersedes it (a status-line annotation on
the old entry is fine). When an entry hangs on a claim about current technology
state, check a current source or run a local experiment — training knowledge is
stale.

Entries are for choices that are expensive to reverse or that a future agent
might silently undo (D-062). Routine implementation and naming calls don't
belong here.

**Reading:** scan the D-NNN headings (or grep) and read only the entries your
task touches. Full read is for structural or cross-cutting work.

**Culling:** the log may be periodically pruned — superseded or moot entries
whose context no longer informs anything current are deleted outright; git
history is the archive. D-numbers are never reused.

Format:

```
## D-NNN: Title  (YYYY-MM-DD, status: accepted | proposed | superseded by D-MMM)
Decision / Context / Consequences / Reopen if
```

---

## D-062: Process rightsized to MVP scale — one pass, human gate, reviews on demand  (2026-08-04, status: accepted; replaces workflow.md's operating modes and raises the logging thresholds in AGENTS.md rules 1–3)

**Decision.** The default unit of work is one agent implementing the task,
running `pnpm check`, and handing off to the human commit gate. The mandatory
multi-mode review pipeline — tech-lead adversarial review before handoff,
multi-agent reviewer fan-out with an adversarial challenge subagent, fix-pass
and verify-pass modes with per-finding dispositions and verdicts — is removed.
Reviews happen when the human asks, as one agent making one pass hunting real
defects, fixing directly by default. Heavyweight review (multi-agent,
adversarial, fix/verify rounds) remains available but is opt-in by the human,
reserved for changes that can destroy a user's local database, corrupt the
published artifact chain, or open a security hole. Logging thresholds rise in
the same spirit: decision entries only for expensive-to-reverse or
silently-undoable choices, rough-edges entries only for quirks that cost real
debugging time, measurement only where a design decision hangs on the number.

**Context.** Owner direction, 2026-08-04. This is an MVP/demonstration with
essentially one user, but the process was sized for production software:
two months of it produced 62 decision entries (~4,400 lines), 18 formal
findings, and multi-round review pipelines for every task. The rigor did
catch real defects (D-061's four reproduced failure modes), which is why
escalation survives as an option for the small dangerous class — but as the
default it cost far more than it caught.

**Consequences.** Faster iteration and less doc mass. Some defects will reach
the working tree that the old pipeline would have caught — accepted, because
deploys are a reversible rsync and the blast radius is the owner's own
browser. The load-bearing constraints (client-side data plane, no telemetry,
untrusted CVE input, humans commit) are unchanged; D-001's human commit gate
is untouched and remains the one checkpoint.

**Reopen if.** The project acquires real users or contributors, or a class of
regressions starts costing more time than the reviews would have.

## D-061: Staged replacement — two alternating slots, and the promotion is recorded in the database's own header  (2026-08-04, status: accepted, implements M2's Download task; builds on D-041 and D-051)

**Decision.** A download never writes into the live database. Chunks land
positionally in a *staging* file that is a different OPFS entry, and the live
copy is neither closed nor touched until the staged one has been verified.
Concretely:

- **Two slots, alternating.** The live database is `cve-a.sqlite` or
  `cve-b.sqlite`; a download always stages into the other. Bounded at two
  generations, and promotion costs no copying.
- **A third name is live-capable: `cve.sqlite`, the one M1 wrote.** It is
  *adopted* rather than discarded — D-013 would permit discarding it, but that
  charges every existing visitor a 63 MB re-download for a rename — and the
  first promotion retires it. This matters more than it looks: entries this
  build does not recognise are **swept**, so failing to adopt would not ignore
  an M1 copy, it would delete one.
- **Which slot is live is recorded *in* the database, not beside it.** A
  promoted database carries a non-zero `PRAGMA user_version`; the higher value
  is the newer promotion. Published artifacts arrive at 0, so a staging file
  cannot be mistaken for a live one. Checked 2026-08-04 by executing
  `pipeline/schema.sql` and reading the header back, and by grepping all of
  `pipeline/` for pragma writes — `page_size` in `schema.sql` and
  `journal_mode`/`synchronous` in `build.py` are the only ones, and none is
  persistent. Nothing *enforces* it upstream, so the gate below re-checks it on
  every import rather than trusting the survey.
- **The resume record is advisory.** `staging.json` holds the plan and the
  per-chunk completion bitmap, bound to the snapshot path, its length, every
  chunk's offset/length/SHA-256, **and the staging file itself** — exactly
  `raw_bytes` while the download is in progress, at least that once every chunk
  has landed, since the indexes are then built into the same file. Anything
  unparseable, unbound or absent starts a fresh download. It can cost a
  re-download; it can never cost the live copy.
- **Promotion gate:** the bitmap is complete (counted, not assumed), the
  staged file is `user_version` 0, the chunks cover the byte range exactly,
  schema matches, `meta.rev` is a revision that agrees with `snapshot.rev` when
  the manifest declares one and is not above head, the D-008 notice is present,
  and the record count is non-zero. Then the indexes are built — *then* it is
  promoted. The gate deliberately does **not** run `PRAGMA integrity_check`:
  the chunk hashes plus full coverage already establish the file is byte-for-byte
  the published artifact, and re-reading 377 MB on every import to learn that
  again would be the single most expensive thing in the client. That reasoning
  has two preconditions, and both were violated by earlier versions of this
  work. The bitmap must be bound to the file — otherwise a database with an
  18 MB hole passes all four content checks. And no stale journal may sit beside
  the slot when it is opened — otherwise SQLite replays it and the file stops
  being the artifact whose hashes were verified, *after* the verification
  (RE-017).
- **`opfs-sahpool` keeps M1's destroy-then-download behaviour**, and none of the
  above is claimed for it. D-051 already established the pool cannot express
  this; it survives only so `pnpm measure` can re-run Q-004.
- **Catch-up deltas are not part of this.** M2's task text puts them in the
  staging file too; applying one is the Sync task, and this lands the file they
  will be applied to. Until Sync ships, a fresh download leaves the client at
  `snapshot.rev` with the manifest's head ahead of it — three revisions ahead on
  the live origin as of 2026-08-04.

**Protocol changes it required** (`lib/protocol.ts`, the published contract):
a `verify` value on `Phase`; `chunksTotal`, `chunksFetched` and `verifyMs` on
`Timings` — `chunksFetched` is the only surface on which the resume claim is
observable, and `verifyMs` exists because verification, promotion and sweeping a
replaced generation otherwise land inside what the measurement sweep reports as
transport; `storage: 'ready' | 'empty' | 'unknown'` on the status message,
because `ready: false` cannot distinguish an empty origin from an unreadable
one; and `stopAfterChunks` on `ImportOptions`.

**Context.** M1's import truncated the live database and wrote chunks into it,
which meant any failure — a dropped connection, a closed laptop, a chunk that
failed its hash — cost the user the 63 MB they already had. M2 requires the
opposite, and D-051 chose the `opfs` VFS partly *because* positional writes into
a second file can express it.

Seven things were less obvious than the shape:

**Where the pointer lives.** The obvious design is a small state file naming the
live slot, and it has an obvious hole: a small-file write on OPFS is not atomic,
so a kill during it can leave the origin unable to say which of two 441 MB
databases is real. Making that safe means a checksummed double-buffer, which is
a crash-safe-write mechanism written by hand — for a fact SQLite is already
willing to store durably. `user_version` is a 32-bit header field, written under
SQLite's normal journalled write path; setting it *is* the promotion, atomic and
durable by the same guarantees the rest of the database has. What remains
outside the database is the resume bitmap, and losing that is a re-download
rather than a lost copy. Reproduced 2026-08-04 on the real schema: the field
defaults to 0, survives a reopen, lands at header bytes 60–63, and the artifact
is a rollback-journal database (header bytes 18/19 = 1), so there is no `-wal`
sidecar to reason about. Confirmed in the browser too — `PRAGMA user_version`
round-trips through the sqlite-wasm build's `selectValue`, which the promotion
gate now depends on.

**The manifest can describe a file it does not cover.** Each chunk carries its
own SHA-256, so corruption costs one refetch (D-041) — but a hash per chunk
proves nothing about the bytes *between* chunks. A manifest that omitted one, or
that named one chunk twice (every step downstream is keyed by name, so the
duplicate collapses and the loser's range is never fetched), would produce a
database of the right length with a zero-filled hole that every hash in the
manifest agreed with. `stagingPlan` therefore requires distinct names and exact
coverage of `[0, raw_bytes)` before anything is written, and the run counts the
completed bitmap before verifying. Upstream this is structurally impossible —
`publish.py` cuts chunks with `range(0, total, CHUNK_BYTES)` and names them from
an `enumerate` — so the check is not defence against our own publisher but
against a substituted or hostile origin, which is what rule 5 and D-032 ask for.
M1 checked none of it.

**A counter is not a credential.** Which slot is live is decided by
`user_version`, and three mistakes followed from treating that number as
self-evidently meaningful. One is below — the bytes may not be committed. The
other two are about what the counter *proves*: anything carrying a high number
won, including a file that merely opens, and then — once discovery re-applied
the gate — including a perfectly good **published** corpus that had simply never
been promoted here. That last one is the sharp case, because the promotion gate
cannot rule it out: the gate runs *before* `buildSearchIndexes`, so passing it
is not evidence a promotion finished. The client-built FTS tables are: nothing
else creates them, and they are written immediately before the counter. So
discovery requires the published schema **and** those three tables, and a
published artifact that ever arrived carrying a non-zero counter — publisher
drift, which nothing upstream forbids — is adopted out of a staging file no
longer, retiring the real copy and leaving a database that cannot be searched.

**Reads and refusals are different answers.** The classifier keeps them apart:
a read that *fails* says nothing about the file — a transient I/O or BUSY error
is not evidence that it is disposable — so it yields "unreadable" and blocks the
sweep, while only values successfully read and then judged unacceptable yield
"unusable". This is why table presence is counted out of `sqlite_schema`, which
exists in every database, instead of letting "no such table: meta" surface as an
exception indistinguishable from a disk error. The decision lives in
`classifyCandidate` in lib/staging.ts, away from the browser, because every one
of these branches is a deletion decision and none of them is reachable from an
e2e test on demand.

**The header is not the committed state.** `user_version` sits at header offset
60, and reading it directly costs a hundred bytes instead of an open — which is
what the first version of this did. It is wrong. SQLite's commit sequence writes
the dirty pages and *then* deletes the rollback journal
([sqlite.org/atomiccommit.html](https://sqlite.org/atomiccommit.html), read
2026-08-04), so a crash between those steps leaves a file advertising a
promotion that never committed and that the next open rolls straight back.
Reproduced 2026-08-04 by killing a process mid-commit: the raw header read **9**
while SQLite, after recovering the journal, reported **5** (RE-016). Believing
the header picks the wrong slot as live — and the sweep then deletes the one
that really is. So discovery opens each candidate, which also performs that
recovery, and judges a consistent file rather than an inconsistent one.

**A journal outlives the file it describes.** A crash during index building
leaves a rollback journal beside the staging slot. If the next download
overwrites only the main file, SQLite pairs the new bytes with the old journal
and replays it at open — which SQLite names as a corruption path
([howtocorrupt.html](https://sqlite.org/howtocorrupt.html#_mispairing_database_files_and_hot_journals),
read 2026-08-04). Reproduced 2026-08-04: a file byte-identical to a freshly
published artifact stopped being byte-identical the moment it was opened beside
a stale journal, and the rows it then held belonged to neither generation
(RE-017). So sidecars are removed before any raw byte is written into a slot,
and that removal throws rather than shrugging. It is *not* done when the bitmap
is already complete: there the journal belongs to the file, and replaying it is
how a half-built index gets rolled back.

**Discovery runs on every page load, so it is priced.** Opening each candidate
costs an open, not a scan — but the gate's own "does it hold records" check was
a `count(*)`, and at full scale that alone put **1.1 s** into every reload
(measured 2026-08-04: 1,353 ms to `ready` with the count, 242 ms with a
`LIMIT 1` probe). The gate never compares the number against anything but zero,
so discovery establishes existence and leaves counting to the import.

**Nothing is deleted while the picture is incomplete.** The sweep's keep list
comes from discovery, so any uncertainty there has to cancel the sweep rather
than shrink the list — an unreadable entry reported as "nothing here" is how a
routine status poll deleted a live database. An inconclusive look still reports
the copy it *did* find, though: a stray entry in the other slot should cost the
sweep, not the user's access to their corpus.

**Flush before you record.** The bitmap is written after the chunk's bytes are
flushed, never before. A record that claims a chunk the file does not hold is
worse than no record: the next run trusts it, skips the fetch, and hands
promotion a database with a hole in it.

**Bound to the snapshot *and* to the file, not to head.** A delta published while
a download was interrupted advances `manifest.rev` without changing one snapshot
byte, so the binding deliberately ignores the head revision — discarding staged
chunks over that would make resume useless on exactly the days it matters. It
does not ignore the staging file: matching the manifest proves the bitmap
describes this *download*, and only the file's length proves it describes these
*bytes*. A record that outlives its file (a sweep that could not remove a slot, a
clear that stopped partway) otherwise makes the next run fetch only the pending
chunks into a freshly zero-filled file — and, because that run completes the
bitmap on its way to failing, every retry then fails in seconds without fetching
anything, with no escape but destroying the good copy.

**Measured** (2026-08-04, Chromium/Linux). Both scales, against
`tests/e2e/staged.spec.ts`, which annotates the numbers it read so they can be
re-derived from a run rather than taken from here:

| | M1 slice | full corpus |
| --- | --- | --- |
| records | 39,196 | 372,322 |
| snapshot | 9.9 MB over 2 chunks | 62.7 MB over 12 |
| expanded | 52.0 MB | 376.7 MB |
| chunks refetched on resume | **1 of 2** | **11 of 12** |
| OPFS after promotion | 61.8 MB | 441.1 MB |

In both, the interrupted re-download leaves the previous copy answering the same
query with the same numbers, the retry skips what already landed, and the origin
ends holding one generation rather than two. Nine more properties are covered by
the same spec, each verified by removing the guard and watching it fail: a
half-finished download is what "Clear local copy" is tested against (clearing
after a clean promotion proves nothing, because the sweep has already run); an
M1-named copy is adopted, queried, and retired by the first promotion; a
discovery failure leaves the origin untouched; a resume record that outlived its
file is discarded rather than believed; a slot whose header claims a promotion
SQLite will not confirm does not become live; sidecars beside a staging slot are
cleared before its bytes are reused; a crash during index building resumes at
the index build, fetching **zero** chunks; a local copy that cannot be opened is
reported unknown rather than deleted; and a high counter on a database this
build would not serve does not win discovery.

Two of those needed care to make honest. A malformed `-journal` is deleted by
SQLite's own recovery, so planting one proves nothing — the test plants a
superjournal, which nothing in SQLite's open path touches — and it must plant a
resume record too, or `tidy` reclaims the slot before the download starts. The
header-versus-SQLite case cannot be staged in the browser (producing a genuine
half-committed journal needs a kill inside the commit), so the in-browser test
uses a slot SQLite cannot open at all, and the commit-window race itself is
reproduced outside the browser.

**Consequences.**

- **Peak OPFS footprint during a re-download is two generations**, at least
  ~882 MB at full scale against 441 MB steady-state — arithmetic from D-049's
  measured 441.1 MB rather than a reading, and a floor rather than a figure: it
  omits the rollback journal SQLite writes while the indexes are built. That is
  inherent to "never truncate the live copy" rather than a cost of this design —
  any staged replacement holds both — but it is the number M5's quota and
  eviction work has to plan against, and the two-slot bound is what keeps it
  from growing further.
- **A failed download leaves the previous copy intact and immediately
  queryable**, because it is never closed. The page reports "still ready" rather
  than offering a fresh Download. Note the narrower claim: a query *issued
  during* a download does not run concurrently with it — the Worker serializes
  requests on one queue, deliberately (a double-clicked Download would otherwise
  race itself), so it is queued behind the import.
- **An interrupted download leaves a staging file the size of the whole expanded
  database** — 376.7 MB at full scale — because the file is truncated to its
  final length before the first chunk lands. That is what makes resume a bitmap
  rather than a re-download, and `tidy` preserves it across sessions on purpose.
  For a *first* download there is no previous copy for the "costs you nothing"
  framing to be about: the honest statement is that the live copy, if any, is
  untouched, and that a partial download occupies real storage until it is
  resumed or cleared. Surfacing "N of M chunks staged" in the status line is
  unclaimed, and with D-009 in force the page is the only channel that could.
- **Indexes are built before promotion**, so a promoted database is one the user
  can search (D-035). A crash during indexing costs the index build on the next
  run and never the chunks — the bitmap is already complete, so the retry starts
  there.
- **"Clear local copy" enumerates rather than naming one file**: two slots, the
  legacy name, their SQLite sidecars, and the resume record. It removes the
  record first and continues past a failure before reporting one, because
  stopping at the first error left whether the record outlived its file to OPFS
  enumeration order — and that combination is the input to the worst failure
  this design has.
- **A best-effort sweep runs on the read path too.** A promotion that could not
  remove the old slot would otherwise hold 441 MB until someone cleared storage
  by hand. It is best-effort *because* it runs after success; "Clear
  local copy" still throws. Because it deletes, "I could not tell what is on
  disk" must never be reported as "there is nothing on disk" — conflating them
  made one unreadable entry enough for a routine status poll to delete the live
  database. The distinction reaches the UI too: the status message carries
  `storage: 'ready' | 'empty' | 'unknown'`, and on `unknown` the page keeps its
  panels and says so rather than clearing them and offering a download over a
  copy that may still be there.
- **`tidy` does not reclaim an abandoned staged download.** It has no manifest —
  `status` performs no network request, and giving it one would put a fetch on
  the reopen path M5's offline story depends on — so it cannot tell a resumable
  download from one aimed at a generation the origin has since rotated away, and
  keeps both. Not a permanent leak: the next download takes the same slot, finds
  the record does not bind, and overwrites it. Until then it costs the
  snapshot's expanded size.
- **Two tabs downloading at once is not handled.** Both compute the same live
  file and therefore the same staging slot, so the second `createSyncAccessHandle`
  fails or hangs (RE-007), and a promotion in one tab cannot sweep a slot the
  other holds open — leaving the second tab querying a retired generation and
  ~441 MB leaked until a later sweep. Not measured, and not fixed here: M5 owns
  multi-tab behaviour, and D-051 chose this VFS on the strength of concurrent
  *readers*, which is unaffected.
- **A test affordance ships in production code**: `ImportOptions.stopAfterChunks`
  (`?stop=1`). Neither resume nor "a failed download costs nothing" can be
  asserted without interrupting a download deterministically, and a 10 MB
  download over loopback finishes before a test can race it. It is also not the
  query knob to worry about: `?vfs=opfs-sahpool` selects the path that *cannot*
  stage, and so clears local storage before fetching a byte — one click on a
  crafted link costs a working local copy, which is inherent to keeping that
  path reachable for `pnpm measure`.
- **`writeMs` is no longer comparable with a pre-D-061 reading.** It now
  includes a `flush()` per chunk and a bitmap write after each, by design;
  measured at 4.7 s at full scale against the 3.2 s in features.md. The sweep
  also only ever measures first installs, since each case starts from a fresh
  browser context — the re-download path this decision adds is unmeasured by
  `pnpm measure` and covered by `staged.spec.ts` instead.

**Reopen if.** OPFS gains an atomic rename we are willing to require across the
D-016 floor — then a single canonical `cve.sqlite` plus `move()` is simpler than
two slots, though it buys nothing the counter does not already give. Or the
two-generation footprint turns out to breach quota on real devices during M5's
storage work, in which case the trade to examine is truncating the live copy on
an *explicit* user choice, not by default. Or M3's schema-version bump needs a
promotion to invalidate more than the file it lands in.

## D-060: The monthly snapshot publishes the artifact head was cut from — it rotates the generation without minting a revision  (2026-08-03, status: accepted, implements the monthly half of D-042; settles the "different content at head" question D-056 left open; relaxes D-055's tiling rule)

**Decision.** `pipeline/snapshot.py` is the monthly cron: take D-042's `flock`,
finish any crashed ingest, and publish **the artifact the ingest state points
at**, at the revision it is stamped with, which must be the published head.
Then retention: keep this generation and the one it replaces, keep every delta
back to the older of the two, delete what falls out the far end. No fetch, no
build, no new revision.

**1. The rebuild already happened.** D-042 describes this job as "rebuild the
database, chunk it, compress the chunks in parallel, publish, then retire the
previous generation", and that was written before the daily ingest existed. The
daily walks the whole corpus and writes a *complete* artifact every time it
runs (D-058) — the delta is only the wire file it emits afterwards — so a fresh
full rebuild is already sitting in `cve.data/state/artifacts/`. Building a
second one here would spend another 24.2 s (D-058's seeded-rebuild measurement)
producing a different file with the same content, and it is the *difference*
that is dangerous (§2). So this job is the
other four verbs, and D-042's word "rebuild" is satisfied by the build that
already ran rather than by a second one.

Not fetching is deliberate too. A monthly job that fetched could abort on the
tombstone guard, and a month would then pass with no rotation — a failure in
the freshness path taking out the rotation path with it. Its output is exactly
as fresh as head is, which is what the manifest already advertises.

**2. A snapshot at head must be the artifact head's content came from, and that
is now checked.** D-056 recorded the hole and left it: a snapshot published at
`rev == published_head` — the legal monthly landing — with *different* content
is invisible to everyone who has already synced, because `planSync` tells a
client at head it is current and it never fetches one byte of the new
generation. So the change would reach new arrivals only, silently and forever.

Publishing the ingest's own artifact cannot do that, but "cannot" was a
property of one caller rather than of the pipeline, so the ledger now records
the SHA-256 of the artifact behind each published revision — written in the
same ledger write as the delta's bytes and the revision's ID space, for the
same reason those are (a crash between two writes leaves a revision clients can
reach whose content nothing wrote down). `publish.py` refuses a snapshot at
head whose artifact digest is not the recorded one, and refuses one where
nothing was recorded at all: a gap reads as "nothing to check", which is
exactly what a wrong artifact needs (D-056's rule about gaps, applied again).

Nothing weaker would do, and that is testable rather than arguable: the
reproduction is a *sibling* build of the same corpus from the same ancestor. It
shares the lineage token, the `seed_rev`, the high-water marks and the ID-space
fingerprint — every existing guard passes it, and the digest is what does not.
It is stored beside the `space` record rather than inside it, because that
record is compared as a whole and adding a key to it would make every existing
entry mismatch every new candidate: a ledger migration in exchange for a check.

Four placement rules the first implementations got wrong, all found by review and
all reproduced:

- **The mismatch is refused before anything moves, and `--force` does not skip
  it.** `ledger._record_artifact` refuses a second artifact at one revision, but
  it runs *after* `os.rename(staging, final)` — so with `--force` the failure
  landed with the new chunks on disk and the old digests still in the manifest,
  a client-visible corruption produced by the flag documented as local
  iteration. The comparison is mirrored ahead of staging and ungated by
  `--force`, exactly as D-056 argues for the ID-space check. The cost is
  deliberate: `--force` can no longer replace what a recorded revision's content
  *is*. Publish at a new revision, or remove the ledger of a throwaway `pub`
  directory. The delta emitter carries the same mirror, because a bridging delta
  may now land on a revision a rebuilt snapshot already defines — two files on
  one `to`, from two artifacts.
- **The *absence* half is ungated too, and absence is a gap rather than a free
  revision.** Both were wrong in the first round. Leaving the missing-record
  refusal gated on `--force` meant a forced publish could put any content at all
  at head on a data plane whose record was missing — which is every data plane
  published before this entry. And `--force` cannot make that safe, because the
  hazard is not the bytes at a URL but that *nobody at head is told to
  re-fetch them*. On the delta side the same absence was read as permission: a
  bridge landing on an already-published revision with no artifact record was
  accepted, so fresh clients downloaded one content while bridged clients
  applied another, both calling it rev N. `ledger.space_at` is what tells a
  published revision from a new one, and a published one with no digest now
  fails closed. One shape stays uncovered and is left deliberately: a revision
  recorded in `snapshots` with *neither* a `space` record nor an artifact digest
  is indistinguishable here from a new landing. That is a pre-D-056 data plane,
  and there is none — the live origin was migrated onto a recorded ID space
  before this work started (D-058), so nothing in production can present it.
- **A digest names a path, and both publishers reopen that path afterwards.**
  Chunks are compressed from the file the digest was taken of, and `extract`
  re-reads it — so a file replaced in between would have the ledger record one
  artifact while the published bytes came from another, with every manifest
  digest agreeing so nothing downstream notices. Reproduced by swapping a
  sibling in mid-compression. Both paths re-read the source before any of it
  becomes visible, at 0.18 s each.
- **A resumed ingest records the digest too, pins it rather than recomputing
  it, and refuses to run against a file that no longer matches.** `ingest._publish_pending`'s reuse path finishes a
  publication from bytes already on disk, and registered everything about them
  except their content — after which the rotation refused to land at that head,
  for a month. It records it now, from a digest pinned into the pending run when
  the artifact was built: the pending record pins a *path*, and a recovery
  rebuild at that path would otherwise have the resume pin a digest that is not
  the revision's content, permanently, since the ledger will not correct it.
  Same reason `generated` and `quality` are pinned. And the reuse path asks
  before it writes, because `_record_artifact` raises `SystemExit` — which
  repeats identically on every later run and freezes the pending forever, the
  mode `resume`'s abandon path exists to prevent and which a pinned entry
  withdraws the proof for. It aborts with the diagnosis instead.

  The pinned digest is also *checked* against the file on both recovery
  branches, not merely read. `_pin` compares the compressed delta bytes, and a
  change **outside** the pinned upsert set reproduces those exactly while making
  the artifact a different one — so a republish recorded the replacement as the
  revision's content, and even the reuse branch left the state seeding from it.
  A mismatch stops the run and keeps the pending record; restoring the artifact
  is the whole recovery. The check runs before **every path that commits**, not
  only the ones that publish — the branch that finds its publication already
  complete republishes nothing and was missed on the first attempt, which left
  the pipeline committing a seed it could not build on. Everything downstream
  failed closed, which is the right direction and still stuck.

  That branch also backfills the artifact record before clearing the pending
  run, because it has no publication event left to attach one to: the reachable
  window is a crash between `ledger.record_delta` and the manifest write, and
  committing over it leaves a gap that only a later delta could fill — which a
  quiet corpus never cuts, blocking every rotation indefinitely. It backfills
  from the pinned digest alone. An *older* pending record, written before that
  field existed, carries nothing to backfill from and is left for a human;
  claiming this covered a pre-D-060 migration was wrong, and there is no such
  record in production to migrate.

The consequence for a *content-changing* rebuild — a normalization change, a
schema bump — is that it cannot land at head at all. It lands above, where
clients are told to re-download, which is honest: if the projection changed
then every record changed, and a delta carrying them is the corpus.

**3. The tiling rule is relaxed to "nothing this manifest names is a dead
end".** `assert_tiling` used to require every delta's `from` to be reachable
*forward from the snapshot's revision* as well. That is what refused the
bridging delta D-055 and D-056 both left to this task — and, more to the point,
it made retention express nothing: after a rotation every retained delta starts
**below** the new snapshot's revision, and nothing forward of a fresh snapshot
ever reaches them. The forward check was answering "could a client be sitting
at this revision?", which the manifest cannot know; `ledger.py` is what
remembers what was published. What the manifest can guarantee is that every
revision it names — the snapshot's, and both ends of every delta — has a chain
to the head it advertises, and that is what is checked now. The holes D-055
listed are all still refused: a missing delta strands the revisions below it, a
delta into a dead end strands its own `from`, and an advertised `rev` that is
not the reachable head is refused as before.

The bridging delta falls out of that relaxation and is now publishable — proven
by a test that carries a client from an old head to a rebuilt snapshot
published above it. **The monthly cron does not use one**, because landing at
head makes it the identity: there is nothing between the old head and the new
snapshot. It exists for the manual rebuild in §2.

**4. Retention is part of publishing a generation, never a separate job.** The
plan flagged the gap: a standalone pruner deletes files the live manifest still
lists, and `manifest.py` has no way to drop an entry outside a republish, so
the window between the two advertises 404s. Doing both in `publish.py` closes
it by construction — the manifest is rewritten first and the files go after, so
nothing is ever named and missing.

What is kept: this generation and the previous one (D-042), and every delta
starting at or above the previous one's revision that can still reach the new
head. What is deleted: older generation directories, and the deltas that only
served clients below the oldest generation just removed — one full rotation
*after* the manifest stopped listing them. That extra grace is the same
argument D-042 makes for keeping a spare generation, applied to deltas: a
client that read the previous manifest ten minutes ago is still fetching from
what it named. A day's delta is ~70–90 KB (D-042, D-058), so the grace costs a
couple of megabytes against the 63 MB generation it protects.

**The retention floor is what the previous manifest advertised**, and getting
that from anywhere else was wrong in two different ways, each reproduced:

- from the *directory listing*, a generation that was never advertised — a
  rotation or a manual rebuild killed between the rename and the manifest write
  leaves one — pushed the delta cut above the floor, and the sweep deleted delta
  files the manifest had just been rewritten to keep. The manifest then
  advertised 404s to exactly the clients retention exists to protect. Deleting
  only generations strictly *below* the floor makes the cut lower than every
  retained entry by construction, which is what the code had merely asserted.
  A directory *above* this revision is now reported rather than deleted: its
  bytes are the byte-identical resume evidence its own retry needs (D-047).
- from the *ledger*, the same never-advertised generation counts as the previous
  one, and the deltas that carry clients out of the generation they actually
  downloaded drop out of the manifest.

The remaining case is a republish of the generation already being served — a
resume, or a hand re-run at the same revision — where `snapshot.rev` *is* this
revision. Reading the floor from it collapsed retention to a single generation:
every retained delta dropped and the previous generation deleted in one
operation. The previous manifest's own delta list is where its floor is
recorded, so that is where it comes from in that case, and for a manifest
written before `snapshot.rev` existed.

The invariant is **nothing the previous manifest named is ever deleted**, and a
second review round found that stating it was not the same as enforcing it. The
delete set was right; the *cut* was still taken from the generations being
removed, so an unadvertised generation between the two floors moved it past the
previous manifest's own — one rotation later than the case above, which is
exactly where the first regression test stopped. The cut is bounded by the
previous manifest's delta floor now, and two smaller readings of the same
mistake went with it: `retire` never deletes the generation just published
(unreachable today, but the argument for it lived three modules away in
`assert_continues`), and a publish with **no** previous manifest retires nothing
at all, because retention is defined by evidence about what was advertised and
there is none — the old fallback deleted both generations and the whole
catch-up chain at the moment the pipeline knew least, which is a plausible
recovery step away.

Deleting a file does not un-publish it: the ledger keeps every URL ever served,
which is what stops a rotated-away range being re-cut with different bytes
(D-055 §7). Verified after a rotation by attempting the re-cut, not by reading
the record.

**4a. One revision has one `generated`.** The build stamps the artifact's
`meta.generated` and the ingest was stamping the delta from a second clock
reading taken after it — a gap of the build's own duration, ~25 s on the real
corpus, because the stamp goes in before `VACUUM`. Apply writes that value into
the client's `meta`, and the worker surfaces it as freshness, so a synced client
and a freshly downloaded one reported different staleness at the same revision.
The delta now carries the artifact's stamp. `generated` was already revision
content rather than decoration (D-055); this makes it one value rather than two.

**5. Each cron records its own outcome, and the monthly waits for the lock.**
`ingest.py status` now reports `last_run` and `last_snapshot` separately. A
monthly failure hidden under this morning's daily success is a month of no
rotation and no way to notice, and on this machine `status` is the only alerting
there is (D-058: no MTA, and D-009 forbids telemetry). `status` also reports
`snapshot_rev` and the delta count, so "the generation is a month old and head
has moved 30 revisions past it" is a subtraction rather than a log grep.

The lock is where the two jobs are genuinely asymmetric. D-042's `flock` is
non-blocking, which is right for the daily — a daily that finds the monthly
running has nothing to wait for, because the rotation moves the head it would
have built against, and tomorrow covers it. The monthly is the opposite: a daily
finishing under it invalidates nothing, it just moves the head the rotation will
land on, while skipping costs a *month* and is the one outcome this job cannot
record, because recording needs the lock. So `state.lock` takes a bounded
`wait`, defaulting to 0 (the daily is unchanged) and set to 15 minutes for the
rotation. Bounded, because a cron job that blocks forever on a wedged process is
worse than one that gives up — and a lock held that long is a problem the
*daily's* own outcome record already reports.

**Context.** Measured on `plex` against the real corpus, in a scratch copy of
the live data plane (the production origin was not touched, and the checkout
D-059 runs from stayed clean):

| | |
| --- | --- |
| Rotation, end to end | **85–101 s** wall over four runs (85.0 / 91.3 / 93.2 / 100.5), almost all of it compression across 24 cores. The spread is a shared machine's, not a code change — every run published the same 12 chunks and the same 62,894,840 bytes |
| Peak RSS | **391 MB** (the daily ingest's is 1.22 GB, D-058) |
| Published | 12 chunks, 377,294,848 raw → **62.9 MB** compressed, ratio 6.0 |
| Deltas retained | 3 — the whole 2→5 chain, every one of them starting below the snapshot's revision |
| Generations retired | `snapshot-1`, the pre-D-056 one; no delta files yet, since none end below rev 1 |
| Artifact digest, the new per-daily cost | **0.18 s** over 377 MB (one pass per daily delta; the rotation pays a second) |

That brackets D-041's 101 s for the same work, which is the point: the rotation
costs what compressing a generation costs and nothing else. Measured four times,
after each round of review fixes to this very path — the last is the code as it
stands, and every run published the same 12 chunks and 62,894,840 bytes,
retained the same three deltas and retired the same generation. The two extra
digest passes the last round added (0.18 s each) are inside that noise.

Two checks at full scale rather than at fixture scale, repeated on each run. The
12 published chunks were fetched, verified against their manifest digests,
decompressed and written at their own offsets exactly as the client does — and
the result is **byte-for-byte the artifact**, same SHA-256 over all 377 MB. And
re-running the job reports "snapshot already at head" and rewrites nothing,
which is what a quiet month looks like.

The fail-closed path in §2 was exercised against the live ledger first, twice
in a scratch copy and once for real: it has no artifact records, so the rotation
was refused with the message that names the fix. That is a **deployment
consequence** rather than a hypothetical — a rotation is refused until one daily
run *mints a revision*, since a quiet day records nothing. The scratch runs
never touched the live origin, and the checkout D-059 runs from stayed clean,
checked afterwards.

**Deployed and installed 2026-08-04.** `git pull` into the checkout the crons
run from (D-059), 242 tests green on the server, and the daily's cycle rehearsed
against the real corpus before anything was scheduled — 43.8 s, 1.22 GB peak
RSS, 686 upserts, 0 tombstones, nothing published. The monthly is `43 5 1 * *`,
86 minutes clear of the daily and taking the same lock; its own command line was
then run in production, which is where the refusal above was observed for real,
confirming the invocation, the log redirection and the guard in one go without
recording an outcome. First unattended firing is 2026-09-01, by which time a
month of dailies will have recorded digests — so the guard cannot trip on it.

Every new guard was checked by mutation, the method D-056 established — each one
removed, the suite re-run, and a *named* test required to fail. Restoring the
forward-orphan tiling check fails 16 (15 errors and a failure; the count is
sensitive to how the walk is put back). Removing the artifact-digest comparison
fails 3, including the sibling reproduction that nothing else catches; the
snapshot anchor in `assert_tiling`, the `_record_artifact` overwrite refusal, the
resumed ingest's digest, the rotation's own pre-flight check, the retained-delta
file-existence filter and the uninitialized-state guard fail 1 each; reverting
the retention floor fails 4, and deleting generations by a keep-set instead of by
the floor fails 2. **242 pipeline tests and 94 unit tests green** — 31 of those
pipeline tests written across three review rounds, because six of the guards
above had no failing test at all when a reviewer first deleted them, and each
later round found more: five fixes from an adversarial pass over the first
round's fixes, eight from a pass that reproduced recovery and migration
paths nothing had exercised, and one more from the verification of those — the
same check, missing from the one resume branch that commits without
publishing. Two of the tests written in the last round were
themselves vacuous on first try — one compared two timestamps that landed in the
same wall-clock second, the other never reached the branch it named — which is
the argument for checking a test by breaking the thing it covers rather than by
watching it pass.

The cross-language contract test now consumes a **twice-rotated** data plane as
well as a fresh one: `fixture_pub.py` publishes a plane, runs deltas through it,
rotates, runs another, and rotates again — the second rotation being the first
that retires anything. `tests/unit/contract.test.ts` validates the result with
the browser's own `planSync`: a client one generation behind finds the chain and
the generation it downloaded is still on disk, a fresh download is told it is
current, and **a client below the retention floor gets `null`** rather than half
a path. One rotation would not have shown the last of those, and the first draft
of this block asserted three things that passed against a plane that had never
rotated at all. Whether the client accepts the shape this job produces is not a
question the pipeline's own tests can answer.

**Consequences.** The monthly cron is one line, `snapshot.py`, and it is
idempotent: run it twice, run it after a crash, run it while a daily is running
(it waits), and the outcomes are "published", "already at head", "resumed then
published", or — only if the lock is held for a quarter of an hour — "skipped".
`state.py` grows a second outcome record, `record_outcome` takes the job's name,
and `lock` takes a bounded wait.

`delta.publish` costs one extra pass over the artifact (0.18 s) to record the
digest. `--force` loses one power it had: it can no longer republish different
content at a revision whose artifact is recorded, because that refusal now has
to land before the bytes move. `snapshot.rev` and head now genuinely diverge in
production — up to a month of deltas between them — which is the shape D-055
typed the manifest for and the client already handles.

What this does **not** do: emit a bridging delta from the cron (§3), rebuild
(§1), or advance the revision. And `state.record.rev` — the per-record
revision the bridging delta was going to need — is still written and still
unread; a content-changing rebuild is the one thing that would want it, and
that is a manual operation.

**Reopen if.** Upstream volume grows enough that a month of retained deltas
stops being a couple of megabytes; a rebuild that changes content but not the
ID space becomes routine rather than exceptional (in which case the thing to
build is the bridging delta path, not a weaker check at head); or the rotation
cadence changes, which would move the retention window with it.

## D-059: The pipeline runs from a git checkout on the server, so what production runs is checkable  (2026-08-03, status: accepted, owner decision; supersedes the deployment half of D-058)

**Decision.** `plex:/home/pmeenan/src/meenan.dev/cve/` is a clone of this
repository, and the crons run `pipeline/` out of it. Updating production is
`git pull --ff-only`; `scripts/deploy-pipeline.sh` does that and prints the
resulting commit. There is nothing to build — the pipeline is standard-library
Python (D-043) — so the committed tree *is* the deployable artifact, which is
what makes this cheaper than the docroot's build-and-rsync (D-003).

**Context.** D-058 recorded the opposite, and recorded it accurately at the
time: agents never commit (rule 7), so the first production ingest necessarily
ran from an rsynced working tree, and that entry was careful to say the server
was not git-managed rather than describing an intention as a state. Three review
rounds later the work was committed and pushed as `80b9ea3`, which removed the
reason.

The gain is not convenience, it is **provenance**. Under rsync, "production is
running the reviewed code" was an assertion — the bytes matched because I had
just pushed them, and nothing on the machine recorded which revision they came
from. Now `git -C <repo> rev-parse HEAD` answers it, and a dirty `git status`
is a standing signal that something unreviewed is in place.

The swap was made a behavioural no-op before it was made: the fresh clone's
`pipeline/` was diffed against the running directory and was identical, so
replacing one with the other could not change what the cron does. Verified
afterwards by running the suite on the server (191 tests), executing the cron's
command line verbatim (exit 0, correct log line), and confirming head, state and
`last_run.ok` unchanged. The cron line did not change at all — the checkout was
placed at the path it already named.

**Consequences.** `scripts/deploy-pipeline.sh` keeps its rsync mode behind
`PIPELINE_RSYNC=1`, because the loop it served has not gone away: an agent
iterating on the pipeline still cannot commit, and a production rehearsal before
the human gate still needs the working tree on the box. It now says so loudly
and leaves the checkout dirty on purpose — that dirt is the signal, and
`git checkout -- pipeline` clears it. Its destination guards (no `..`, and the
`/home/pmeenan/src/<project>/pipeline/` prefix) are unchanged, since
`rsync --delete` is still what they protect against.

Two things this does *not* change. The docroot deploy is still D-003's rsync of
`dist/`, and the pipeline is still never in the docroot (D-018, D-053) — a
checkout under `/home/pmeenan/src/` is not web-reachable by any path. And the
server pulls; nothing pushes to it, so a bad commit reaches production only when
someone runs the pull.

**Reopen if.** The pipeline ever grows a build step, in which case the
"committed tree is the artifact" premise goes with it; or the server needs to
run a revision that is not on `origin/main`, which today means rsync and a dirty
checkout rather than a detached HEAD.

## D-058: The daily ingest — the guard runs before the build, and a revision's bytes are pinned before any of it is published  (2026-08-03, status: accepted, implements D-042; settles the ID-space-on-the-wire question D-056 deferred to this task; its deployment half — rsync to a plain directory — is superseded by D-059 now that the work is committed)

**Decision.** `pipeline/ingest.py` is one cycle under `flock`: fetch, hash,
diff, guard, rebuild, publish one delta, advance state. Six things it decides
that D-042 left open.

**1. The guard runs before the *build*, not merely before publication.** D-042
only requires that nothing is published before the tombstone guard, and a build
publishes nothing — so building first and hashing out of the same walk looked
free. It is not, because seeding is destructive in one direction: a build
retires every value the tree no longer mentions, permanently (D-056). A
half-fetched corpus that got as far as `build` would retire several hundred
thousand ids, and the repair is a new ID space and a full re-download for every
client. The run therefore pays for a **second walk of the corpus** — 16.9 s and
93.8 MB peak RSS, measured below — to keep the guard upstream of anything
irreversible. That is the single most expensive decision here and it buys
exactly one property: a broken fetch cannot damage the ID space.

Two walks then have to be checked against each other, or they are two opinions
about which records exist. The build's own counts are compared against the hash
pass — records walked, records minted against records the diff calls new, and
records retired against tombstones — and any disagreement aborts before
publishing. That check earned itself immediately: `build.retired_records` was
computed from `len(seeded["cve_ids"])` *after* the walk, and the walk fills the
seed's own map rather than a copy, so every newly minted record was also counted
as a retirement. Nothing else read the number, so it had gone unnoticed; the
ingest reads it, and would have aborted every run on a day upstream added a
record — which is every day. Fixed here, with a regression test in
`test_interning.py`.

**2. The ingest keeps its own state**, `cve.data/state/ingest.sqlite`, never
under the served root (D-018): a content hash per record (D-031), the revision
each record last changed at, a tombstone log, the artifact the next build seeds
from, and the pending run. 28.8 MB at corpus scale.

It is rebuildable by `ingest.py init`, but only under a precondition worth
stating rather than implying: `init` re-derives the hashes from a working tree,
so it recovers the state *at the moment a run finishes*, not at an arbitrary
later one. Fetch past the head and it refuses — on the record set if one was
added or removed, and on the artifact's recorded commit otherwise, which is the
case that would otherwise be silent. Both the state and the artifact record the
commit their revision was computed from, and `ingest.py status` prints it, so
the shape of a recovery is "get the clone back to that commit, then `init`" —
not written up as a procedure because it has not been tested against a
`--depth 1` clone (rule 4). And the artifact at head is as load-bearing as the
state file itself: without it there is nothing to seed from, and the repair is a
bootstrap plus `--new-id-space`, which is a lineage rather than a scan. It
currently lives *inside* the state directory, so one `rm -rf` takes both.

The per-record revision has **no reader today**. It is written because the only
place that number exists is the run that produced it, and the monthly rebuild's
bridging delta (M2's next task) spans revisions rather than stepping one. Same
for the tombstone log. Recording them costs a column; reconstructing them later
is impossible.

Which is also why a record that comes back after a tombstone **keeps its
tombstone**. Both facts are true of a client that has not synced since — the row
it holds at the retired id is gone, and the record exists again at a new one
(D-056 never reissues an id) — and a bridging delta that spans both events needs
both. Clearing it, which the first version did, would leave that delta shipping
only the upsert, which every client below the deletion then refuses on apply,
after the bytes are at an immutable URL. Kept, the two facts collide in
`delta.extract`'s refusal to name one record in `upsert` and `delete` at once —
on the server, where D-047 says failures belong. Expressing "drop row 2, insert
row 3" is a gap in the wire format (`delete` is by CVE ID, D-055) and the
monthly rebuild inherits it; losing the evidence for it here would have been
ours. `initialize` still clears the log, and that is correct in the same terms:
after an `init` nothing here knows what happened before `rev`, so the only sound
delta from that state is a step from `rev` — a constraint the monthly task
inherits rather than a bug.

**3. Re-run semantics: a revision is minted once, and everything that decides
its bytes is written down before any of it is published.** The changeset, the
artifact path and `generated` land in the state file first and are cleared only
after the manifest names the delta. What the next run does with that record
turns on one question, asked of all three authorities — the ledger, the manifest
and the file on disk: **was anything ever published at this range?**

- **Nothing was.** The pending run is *abandoned* and the fresh cycle re-mints
  the revision against the tree as it now stands. Nothing can have reached a
  client, so this is the same rule that lets `delta.write` re-cut an unpublished
  range (D-047). Resuming unconditionally instead was the first design, and it
  was wrong in a way only a review caught: `begin_run` lands before
  `delta.publish`, which performs six validations that raise *before* writing
  anything and raise identically on every retry — a wrong seed, a floors
  mismatch, a manifest that cannot hold the entry. Any of them would have been
  replayed forever with the data plane frozen behind it, and the only escape was
  a method with no caller.
- **Something was.** The pinned changeset is republished byte for byte, or
  simply committed when the manifest already names it. Recomputing here would
  put *different* bytes at a URL that can never be corrected — which is exactly
  why `generated` is pinned rather than restamped, the constraint D-055 named:
  the client writes it to `meta.generated` on apply, so two payloads differing
  only there are different content.
- Either way the run then **continues into a fresh cycle**, so one invocation
  heals and catches up instead of costing another day of staleness.

The three crash windows — before the file, between the file and the ledger,
between the ledger and the manifest — each have a test that kills the run there,
and each moves the tree on *and* advances the clock a day before retrying.
Without both, "resumed the pinned changeset" and "recomputed a new one" produce
identical output and every assertion passes either way; that is how the first
version of these tests passed while a restamping `generated` survived.

The middle window is the one that makes the third authority load-bearing: the
file is renamed into place before the ledger records it, so between those two
the bytes are served and *nothing has written them down*. Treating "not
recorded" as "never published" there abandons a range a client can already have
fetched, and the re-minted payload is then refused by `delta.write` at a URL it
can neither reuse nor correct. That window had no test until a second review
round; the file check survived mutation until it got one.

One case stops for a human: a pending run whose artifact is gone *after* its
bytes were published. Those bytes cannot be reproduced, and discarding the
record would lose the only evidence of what is at that URL.

A missed day needs no handling at all: `from` is always the published head and
the changeset is the whole diff of the state against the tree, so a run that
never happened is absorbed by the next one as a larger delta. Consecutive
revisions still tile by construction (D-042).

**4. A run that changes nothing mints no revision and does not touch the
manifest.** The consequence is deliberate and worth naming: `generated` does not
advance, so the staleness the client shows keeps growing on a day the data plane
genuinely did not change. That is honest — the manifest describes what was
published — and in practice upstream changes every day, so a no-change run is
itself the signal that the fetch is not advancing.

**5. The state must describe the published head, and the run refuses when it
does not.** `state.rev` is compared against both the manifest and the ledger
before any changeset is computed — `published_head` also asserts those two agree
with each other, so one comparison covers all three. This is the seam the
monthly snapshot task needs: a rebuild advances the head without going through
the ingest, and it owns re-pointing the state at what it published. Failing
closed here is what keeps that from being a silent wrong-`from` delta.

One ordering exception, and it is deliberate: a *pending* run is resumed before
this check, because its `from` was fixed when the revision was minted and
re-deriving it is exactly what a resume must not do. A rebuild that moved the
head under a pending run is still caught, by whichever of two paths applies —
both verified by running them. If the pending range was published, the resume
republishes it and `manifest.assert_tiling` refuses the manifest that would
result (`deltas starting at [1] are unreachable from snapshot rev 3` — the
behaviour is unchanged but that message is not: D-060 replaced the orphan walk
that produced it, and the same shape is now refused as `a client at rev [1, 2]
has no chain to head 3`), leaving the pending intact. If it was not, the resume abandons it and the run then hits
this check with its own message. Neither publishes anything.

**6. The ID-space marker stays off the wire.** D-056 deferred this and named the
daily-ingest task as the last comfortable place to revisit it, since nothing is
deployed against the format until Sync ships. Having built the ingest, the
answer is still no, for a reason that is now checkable rather than asserted: the
failure it would catch — a delta from a foreign lineage — is refused by
`ledger.assert_idspace` before publication, and the one path that looked like it
could bypass the ledger *fails closed*. A lost `published.json` re-seeds from
the manifest, which carries no lineage, so `idspace()` is empty while
`anything_published()` is true, and that combination raises rather than adopting
whatever arrives; a delta may never adopt at all. Adding the field would move an
unfixable server mistake into an unfixable client symptom, and it is not free to
carry. `FORMAT_VERSION` stays 1. If a lineage break ever shows up that the
token, `seed_rev` and the fingerprint cannot see, the field is cheap to add
later *and the client already holds the value it would compare against* — the
snapshot carries `idspace` in `meta` — so only the delta side would be new.

**Context.** Rehearsed and measured end to end on `plex` against the real
corpus, in a scratch directory: a copy of the live clone (re-pointed at GitHub),
a copy of the live artifact, and a copy of the published generation — the live
data plane was read and never written. The window is the real one M1's
publication left behind: `d300c5fcc0` (committed 2026-07-31T23:12:13Z) →
`62a1030538` (2026-08-03T20:41:50Z), **69.5 hours**, Friday evening through
Monday afternoon. The rehearsal was run twice — once before the review pass and
once after; these are the second run's numbers, from the code as it stands.

| Step | Wall | Peak RSS |
| --- | --- | --- |
| Hash pass alone, 372,322 records | **16.9 s** | 93.8 MB |
| Rebuild seeded from the live artifact | 24.2 s | 1,157.5 MB |
| `init` (scan, then verify against the artifact) | 17.8 s | 147.8 MB |
| **One daily run** — fetch, hash, diff, guard, build, delta | **54.9 s** | **1,219.2 MB** |
| A run with nothing new (no fetch) | ~18 s | — |

The last row is from the rehearsal's step timestamps at one-second resolution
rather than from `time`, which is why it lands so close to the hash pass it
contains; the two are the same measurement inside that granularity, not evidence
that skipping the diff is free. The first rehearsal's run was 62.5 s with a cold
page cache on the copied clone, so treat the spread — not either number — as the
scale.

The delta itself: 446 records added, 397 updated, 0 removed — 925,846 bytes of
JSON, **208,540 bytes at brotli -q5**. It minted 1 CWE, 22 vendors, 153
products, 9 hosts and 1,164 urls, and **retired 15 products and 2 urls**, so
retirement is an ordinary daily event rather than a theoretical one.

The rate does *not* reproduce D-031's, and the honest reading is that neither
window is a rate. D-031 measured 665 records and 87 KB over 21.4 weekday hours
(31.1 records/h, 4.07 KB/h); this one is 843 records and 204 KB over 69.5 hours
spanning a weekend (12.1 records/h, 2.93 KB/h) — **~291 records and ~70 KB per
day**, well under D-042's ~665/day and 87 KB/day planning figures. Bytes per
changed record nearly doubled, 134 → 247, so the two windows differ in shape as
well as volume. The weekend is the obvious hypothesis and this measurement
cannot confirm it. What both windows agree on is the only thing D-042 needs: a
day's delta is one small file. The run is 54.9 s against D-042's "~40 s of
work" — the difference is the second walk this entry buys.

Two results are worth separating from the timings.

*The seeded rebuild of the live artifact minted zero ids and retired zero.* That
is what makes `--adopt-id-space` honest rather than hopeful: the artifact the
migration publishes is the live ID space, re-derived. The build also reported
all eight marks as `seed_inferred_floors`, confirming the live generation
predates D-056 exactly as that entry describes.

*The published delta was applied to the rev-2 artifact with the reference
applier and compared with the rebuild at full scale* — M2's exit criterion in
miniature. Apply took **0.25 s**. All six record tables are identical over
3,778,313 rows (`cve` 372,768, `cve_text` 354,963, `cve_cwe` 190,390,
`cve_prod` 524,356, `cve_ref` 1,217,771, `cve_ver` 1,118,065), and the synced
copy holds exactly the 15 products and 2 urls the rebuild retired and is missing
nothing — which is the difference between a synced and a downloaded client that
D-056 predicted, observed rather than argued.

**Consequences.** The cron line, once the migration below has been run — one
physical line, because `crontab(5)` has no backslash continuation and would run
the fragment before the break:

```cron
17 4 * * * cd /var/www/meenan.dev && python3 <repo>/pipeline/ingest.py run cve.data/git/cvelistV5 cve.pub/data --state cve.data/state >> cve.data/state/ingest.log 2>&1
```

Exit codes are 0 for published / nothing to do / lock held, 1 for an abort
(and for an unhandled exception, which a traceback in the log distinguishes),
and 3 for the tombstone guard specifically, so a wrapper can route the one that
means "the fetch broke" differently from the rest. `--tombstone-limit` exists
for a withdrawal confirmed upstream and for the fixture corpora; raising it to
get past a broken fetch is the mistake it is shaped to make obvious, and it is
range-checked to `(0, 1]` because the two ways of getting it wrong both disable
the guard *silently* — `nan` makes every comparison false, and `1`, the obvious
misreading of a help text that says 0.1%, makes the threshold the whole corpus.
`--dry-run` does everything through the build and reports the changeset without
publishing or touching state, which is what the first production run should be.

`init` is the other place a mistake is unrecoverable, so it refuses five things
rather than trusting the README: an artifact recording no ID space, one from
another lineage, one stamped at a revision that is not the head, one that is a
*sibling* of the artifact published there (same lineage, same revision,
different ids — separated only by the ledger's fingerprint, D-056), and a clone
whose record set differs from the artifact's. The fifth needed a sixth: id sets
can match while a record's *content* has moved, and recording that as the
artifact's content drops the edit from every future delta, silently. So
`build.py` now stamps the commit it read into the artifact's `meta` — provenance,
not identity, and not hashed into the fingerprint — and `init` compares it
against the clone. The README's one uncheckable instruction, "do not fetch
between steps 1 and 3", is now checked. A pending run blocks `init` outright,
`--force` included: `initialize` clears that record, and it is the only evidence
that a revision was minted.

RE-015 is worked around here as a side effect worth naming. A lone surrogate is
legal JSON with no UTF-8 encoding, and that finding asked for a projection-level
check whose cost was measured first. The hash pass *is* one, already paid for:
`content_hash` encodes the whole projection, so catching the `UnicodeEncodeError`
costs nothing beyond the walk the guard already requires, and the record is named
instead of the codec. A direct `build.py` run still gets the raw traceback.

Builds are ~377 MB each and cannot accumulate: `--keep` (default 3) prunes older
ones, never the artifact the state seeds from. The lock lives in `state.py`
because the monthly cron has to take the same one.

**Run in production 2026-08-03**, with the owner's explicit go-ahead — nothing
is live, published or in use yet, so the "every client re-downloads once" cost
the adoption carries was zero. The migration went exactly as rehearsed:

| Step | Result |
| --- | --- |
| Rebuild seeded from `cve.data/db/snapshot.sqlite`, stamped rev 2 | 24.2 s, 1,153.5 MB peak — **0 ids minted, 0 retired** |
| `publish.py --adopt-id-space` | 12 chunks, **62,732,082 bytes** (ratio 6.0) in 96.5 s |
| `ingest.py init` | 18.0 s, 372,322 records, ID space `a46cc2797a9aa338` |
| First daily run (fetch → delta) | 43.7 s, 1,223.0 MB peak |

The first published delta covers `d300c5fcc0` → `743b3b8534` (70.8 hours):
**881 upserts, 0 tombstones, 965,238 bytes of JSON → 218,140 compressed**,
shipping 1 CWE, 26 vendors, 160 products, 9 hosts and 1,249 urls. The data plane
is now `snapshot-2/` (rev 2) plus `deltas/2-3.json.br`, head rev 3, with
`snapshot-1/` retained per D-042 and still serving.

Verified from outside the machine, over HTTPS, because the local server
reproduces production headers but not nginx: `manifest.json` is `no-cache` and
the delta is `immutable`, both carry COOP/COEP/CORP, **neither carries
`Access-Control-Allow-Origin` even when an `Origin` is sent** (D-034's actual
same-origin control), and no `Content-Encoding` is added to the `.br` (D-040).
The delta's byte length and SHA-256 match the manifest exactly. `published.json`
is unreachable — raw, encoded, and via the parent — and `/data/deltas/` gives no
listing, repeating D-018's canary check against the first served delta. Then the
whole thing end to end: a real Chromium against `https://cve.meenan.dev/`
downloaded the new generation, built its indexes, ran a query and survived a
reload (`BASE_URL=https://cve.meenan.dev pnpm e2e import`, 1.4 minutes) — the
config now takes that override rather than needing an ad-hoc edit.

The cron is installed in `pmeenan`'s crontab on `plex` and its command line was
executed verbatim to prove it works (exit 0, correct log line, "nothing
changed"). It runs at 04:17 and appends to `cve.data/state/ingest.log`. Two
comment lines above it say how to remove it.

**Where the pipeline lives on the server.** `plex:/home/pmeenan/src/meenan.dev/cve/pipeline/`,
alongside the other projects on that machine — but as a plain directory, not a
git checkout. It is emphatically not in the docroot (D-018, D-053) and
`scripts/deploy.sh` does not touch it. `scripts/deploy-pipeline.sh` rsyncs it,
and that is the deployment model rather than a stopgap: agents never commit
(rule 7), so a pipeline change cannot reach the server through git until the
human gate closes, and the first production run necessarily happened with the
change still in the working tree. Making the destination a real checkout and
pulling into it is a possible future change, not something to describe as
current. That is worth knowing when reading the ledger: the generations now
serving were published by code that is not yet in git history.

The migration D-056 rehearsed is now the documented first run, in
`pipeline/README.md`: build seeded from the live artifact at a revision above
head, `publish.py --adopt-id-space`, `ingest.py init` against that artifact
*without fetching in between* — `init` verifies the tree and the artifact hold
the same record set, which catches a tree that moved but cannot catch an edit to
a record that kept its id. Every client re-downloads once, which is cheap today
and gets less so.

Every guard in this entry was checked by mutation rather than by inspection —
the guard removed, the suite re-run, a named test required to fail, and the
*right* test required to be the one that fails. That method is what the first
version of these tests failed: a review's 56-mutation sweep found 22 survivors,
including the headline decision (moving `_guard` after the build changed
nothing), the whole of `_check_build_agrees`, and the `generated` pinning —
whose assertion was correct but vacuous, because the crash and the retry both
landed inside one wall-clock second. A second review round found one more, the
file-on-disk authority in `_nothing_was_published`, and it is the one whose
absence would have wedged the data plane rather than merely gone unnoticed. The
suite now kills **26 of 26**, with the tree moved on and the clock a day ahead
in every re-run test, and a blocking `flock` *fails* it instead of hanging it.

**What a third review round changed**, all of it reproduced before it was
fixed:

- **The corpus is now the tree git says we fetched.** `reset --hard` restores
  tracked files and deletes nothing untracked, so a stray `CVE-*.json` — a
  half-finished operation, a hand edit — was walked, hashed and would have been
  published as though upstream had said it. `fetch` now ends with
  `git clean -fdq -- cves`, and `init` refuses a corpus with uncommitted
  changes, because the commit is only half the question: a modified record
  leaves `HEAD` alone while changing what `scan` hashes, and the id sets still
  match. The commit check also failed *open* when the artifact named a commit
  and the clone reported none; that asymmetry is the state in which the check
  cannot be made, so it now fails closed. **Every run** makes the same check,
  not just `init`: `--no-fetch` skips the clean, and a review reproduced a
  modified record publishing cleanly through it. After a fetch the check is a
  cheap assertion (0.17 s over the real tree); with `--no-fetch` it is the only
  thing there is.
- **Recovery no longer reproduces the bytes; it verifies them.** The first fix
  pinned the brotli quality into the pending record, which closed the reproduced
  case — publish at quality 1, crash, retry at 5 — but left recovery depending
  on the *compressor* being unchanged, so a brotli upgrade turned a resumable
  run into a stopped one. `delta.write` now takes an `on_written` hook and calls
  it between deciding the digest and renaming the file into place, so the
  pending record holds the entry (length, digest, and the ID space the ledger
  needs) before those bytes can be observed by anything. A retry with the file
  present registers *that file* and recompresses nothing, which is what makes
  "byte for byte" true rather than conditional. A file whose digest does not
  match the record stops for a human — those are not the bytes clients may have
  fetched — and only a run with neither the file nor its artifact is
  unrecoverable. A third round found the classification that undid half of
  this: with the entry pinned but the file since deleted, all three authorities
  read clear and the run was *abandoned*, re-minting the same range from a moved
  tree at a different digest. Reproduced. A pinned entry is now never abandoned,
  because the hook fires just before the rename and so cannot distinguish
  "crashed a microsecond early" from "served for a day, then deleted" — the
  run rebuilds and compares instead, and the same hook stops it if the
  compressor has moved. The deterministic-failure escape is untouched: every
  validation raises before `delta.write` pins anything. One consequence worth naming: finishing a publication no longer
  needs the artifact at all, so losing it now costs the *next* build rather than
  the current one.
- **`--tombstone-limit 1` is refused.** The first version of the range check
  named 1 as the dangerous percent-versus-fraction mistake and then accepted it:
  at `limit == 1` the threshold is the whole corpus and the comparison is
  `deleted > corpus`, which a corpus that vanished entirely cannot satisfy. The
  guard is not loosened by 1, it is switched off, so the interval is `[0, 1)`.
- **"Abort and alert" is amended rather than pretended.** There is no MTA on
  `plex`, so the cron line's redirect was not hiding an alert — there was none
  to hide. The run now records its outcome in the state and `status` reports it;
  see the architecture note above for why that is the channel and not mail.
- **`deploy-pipeline.sh` validates its destination.** It runs `rsync --delete`
  against a caller-supplied target, so a wrong one does not fail, it empties
  something and fills it with Python — and the docroot and `cve.pub/` are both
  a typo away. The destination must now match
  `/home/pmeenan/src/<project>/pipeline/`, checked before anything is created.
  A lexical prefix test is only sound on a path with no `..` in it —
  `/home/pmeenan/src/../../var/www/meenan.dev/cve/` matches the pattern and
  resolves to the docroot — and the destination is remote, so there is no local
  `realpath` to canonicalise with; the component is refused outright instead,
  which is stricter than resolving it. Its header also no longer describes
  production as git-managed: the destination is a plain directory, rsync is the
  model, and turning it into a checkout is a possible future change rather than
  something already true. The same claim was corrected in `AGENTS.md`,
  `architecture.md` and this entry.

**Reopen if.** The second walk stops being affordable (it is 31% of the run
today), upstream volume makes a day's delta stop being one small file, a run
needs to be safe to interrupt at a granularity smaller than one revision, or the
per-record revision column turns out not to be what the bridging delta needs —
in which case it should be removed rather than kept for a reader that never
arrived.

## D-057: The first AI tier is a model we host — Ollama behind a restricted same-origin endpoint  (2026-08-03, status: accepted, owner decision; re-orders D-045's ladder and narrows its "never proxied" to third-party traffic; adds the first dynamic endpoint, outside the data plane, under D-006's rules)

**Decision.** The first model tier to ship is self-hosted: an Ollama instance
on the project's private network at `http://llm:11434/`. The `llm` hostname is
configured in hosts on both the dev and production machines, so it can be named
in the repo without per-machine configuration; the box is not publicly
routable. Browsers reach it through a new **same-origin API endpoint** on
`cve.meenan.dev` that exposes only the operations the chat loop needs — chat
completion against a server-pinned model, streamed — and none of the rest of
Ollama's API: no model management, no pull, no embeddings, and no
caller-supplied model name, URL, host, or path. Which model is pinned is server
configuration, not client input; today it is `gemma4:e4b` (8.0B parameters,
Q4_K_M — verified 2026-08-03 by `GET http://llm:11434/api/tags` from the dev
machine, reporting the `tools` and `thinking` capabilities the D-044 chat loop
needs).

The rest of D-044 is untouched: tools still execute in the browser against
local SQLite, the model orchestrates through tool calls that round-trip through
the browser, and the tool surface stays read-only and render-only. The server
relays inference; it gains no query capability and holds no chat state. The
corpus data plane is exactly as static as D-032 left it.

The other tiers ship later, not never — D-045's ladder is re-ordered, not
replaced. In-browser local models and BYO-key hosted adapters (each still
browser-direct, keys client-side, never proxied) follow once the chat layer is
proven against this endpoint.

**Context.** Owner decision (2026-08-03). D-045 ordered the ladder local-first
and rejected server-side inference and proxying entirely; features.md carried
"server-side inference or model proxying — rejected." But building against
that ladder means every early chat-layer test rides either a multi-gigabyte
WebGPU download or a user-supplied key with per-provider CORS quirks (RE-010).
A model we host gives development and the D-046 benchmark one consistent,
always-available endpoint with minimal client requirements — no key, no
WebGPU, no weight download — and gives every visitor a working chat tier on
hardware we control.

The plan previously argued for proving the chat loop against strong hosted
models first, so tool-surface bugs are never mistaken for model-quality
problems. An 8B quant is not that, and the conflation risk is accepted
knowingly: the D-046 benchmark exists precisely to separate the two (scoring is
data comparison against ground truth, not impressions), and a BYO-key frontier
model can be exercised during development for disambiguation before its adapter
ships.

**Consequences.**

- **The privacy story changes shape and must be told honestly.** With this
  tier selected, the user's question and the tool results the model asks for
  transit our server and our LLM box — the first feature where
  analysis-related content reaches infrastructure we operate. It is bounded
  the same way D-045 bounded hosted keys: opt-in per tier, with a first-use
  disclosure that now names us; nothing is sent until the user asks a question
  with this tier chosen; the deterministic UI — and later the local tier —
  keep the full never-leaves-your-machine claim. This is user-initiated
  feature traffic, not telemetry, so D-009 is untouched — and the endpoint
  keeps nothing: no chat storage, no request-body logging; access logs record
  that the endpoint was hit, not what was asked. Vision criterion 4's
  network-panel check gains one more user-initiated request kind and stays
  checkable.
- **The first dynamic endpoint, under D-006's rules.** AGENTS.md's data-plane
  constraint said a dynamic endpoint must serve derived CVE data and nothing
  else; this one serves none, so that clause is amended by this entry — the
  deliberate change the constraint demands. What survives in full: no
  caller-supplied URL, path, or ref reaches the filesystem or network — the
  upstream target and model are fixed server-side; same-origin restricted in
  the D-034 style (no CORS headers); POST-only with a capped body; and
  rate-limited and concurrency-capped, because the GPU box serves one small
  model and an unauthenticated relay to free inference is an attractive
  target. Absence-of-CORS stops cross-site browsers, not `curl`, so nginx
  `limit_req`/`limit_conn` on this location are a ship requirement, not a
  nicety — and the origin is not behind Cloudflare until M5, which lands
  before this endpoint does.
- **Plan re-scope.** M7 becomes: chat surface, tool surface, this endpoint,
  and the D-046 benchmark against the pinned model. BYO-key adapters join the
  in-browser local tier in M8. The `gemma4:e4b` scorecard is what sets honest
  expectations for this tier and what tool-surface iteration is measured
  against.
- **Implementation shape lands in M7, not here.** PHP 8.4 is the stack's
  sanctioned dynamic path (D-003 routes `.php`), and streaming a response
  through php-fpm's output buffering is a known sharp edge to verify before
  committing to it. If PHP cannot stream cleanly, the alternative is a
  decision entry, not drift.
- **The box and its model are operational configuration.** Swapping the pinned
  model (say, after a D-046 result) or moving the box is not a new decision so
  long as the endpoint's restrictions hold and the hostname stays private.

**Reopen if.** Abuse of the public endpoint outruns the nginx limits (the
options, in order: Cloudflare rules in front, a lightweight same-origin token,
gating the tier); the D-046 scorecard shows the pinned model cannot drive the
tool surface (a stronger model on the same box is configuration; conceding the
tier is a decision); or operating the box stops being worth it once the local
and BYO-key tiers exist.

## D-056: Stable interned IDs — seeded builds, retirement, recorded high-water marks, and a named ID space  (2026-08-02, status: accepted, implements D-025 hazard 1; makes D-055's floors sound; **two things it leaves open are settled by D-060** — the "different content at `rev == published_head`" question it closes with, and the manifest half of the bridging-delta blocker below, which D-060 relaxes)

**Decision.** Every build continues the previous build's ID space or explicitly
starts a new one. There is no third option and no default: `pipeline/build.py`
now requires `--seed <prev.sqlite>` or `--bootstrap`, and `build()` raises
without one of them.

**1. Seeding covers `cve.id`, not only the seven lookups.** `cve.id` was a bare
walk counter, and the walk is sorted by file name, so one record added at the
front renumbered every record behind it — and the delta then carried each of
them at its neighbour's id. Since D-055 the client's applier refuses that in
both directions, so the symptom is not silent corruption but a wedged sync and a
63 MB re-download; for *lookup* ids there is no tripwire at all, which is why
seeding is the fix rather than the tripwire. `cve.id` is interned like
everything else now.

**2. A value the corpus stops using is retired, not carried forward.** Its row
leaves the artifact; its id is never issued again. The alternative — keep every
row ever interned so that "id ≤ floor" literally means "the client has it" — is
tidier to reason about and costs the largest table in the corpus: `url` only
ever grows, with no upper bound and no way to reclaim any of it.

Retirement is safe because an id can only be *referenced* by a build while its
value has been interned continuously since it was minted: seeding is what
preserves a key→id mapping, so a value that is dropped is absent from the next
seed and mints a **new** id if it comes back. Therefore any id an artifact still
references was in every artifact since it was minted — including whichever
snapshot each client downloaded — so "at or below the floor" still implies "the
client has it", which is exactly what `_check_closure` assumes.

A synced client keeps the rows a rebuild retired, and that is visible in one
place: the client builds FTS indexes over `vendor` and `product` themselves
(D-035), so its type-ahead can offer a name the corpus no longer contains, while
a freshly downloaded client at the same revision cannot. Accepted deliberately —
the alternative is unbounded growth in every download — but it is a real
difference between two clients at one watermark, and it is why M2's exit
criterion is a claim about the *downloaded* database. Aggregates are unaffected:
nothing joins to a row no record references.

**3. The high-water mark is recorded, never recomputed as `max(id)`.** With
retirement those two differ, and the difference is the sharpest bug in this
area: retire the *highest* row and a rebuild that trusted `max(id)` hands that
id to a different value, while clients hold the old meaning and no delta can
correct them — the id is below their floor, so nothing ships it. The artifact
therefore carries its own ID-space record in `meta`: `hwm` (a JSON object in
exactly the changeset's `floors` shape), `cve_hwm`, `idspace`, and — on a seeded
build — `seed_rev`, `seed_marks` and `seed_fingerprint`.
In `meta` rather than a sidecar file because the artifact *is* the seed for the
next build and the source of the next delta's floors, and a second file to keep
beside it is a second file to lose. The client reads `meta` by key and ignores
the rest.

`build.id_space()` reads it back, and is where `floors` now comes from. An
artifact built before this existed — the generation live on 2026-08-02 — has
none of the keys, and is recognised by having no `idspace`: its `max(id)` *is*
its high-water mark, because an unseeded build never retires anything, so
adopting it is exact rather than a guess, and the build reports what it inferred
(`cve` included). An artifact that records a lineage but not the rest of it is
**damaged, not old**, and is refused; so is one holding ids above its own
recorded marks. That last one is not fastidiousness: the same number is a *mint*
floor for the next build, where the safe repair is the higher value, and a
*delta* floor for the next changeset, where it is the lower one. One number
cannot be conservative in both directions, so it is an error rather than a
choice.

**4. The ID space has a name, and the checks are the publisher's.** A lineage
token is minted by `--bootstrap` and inherited by every seeded build — including
a build seeded from a pre-D-056 artifact, which *mints* one for the ids it
adopts, since the seed has none to pass on. `ledger.py` records the token the
data plane was published from, in the same write as the snapshot it came with,
and both publishers refuse a mismatch: `publish.py` on a snapshot,
`delta.publish` on a delta.

Four rules make that guarantee hold rather than merely exist:

- **An empty ledger means *unknown*, not *unconstrained*.** The manifest carries
  no lineage, so a ledger seeded from one — the state of the live origin — has
  no token, and adopting whatever arrives next would bless exactly the unseeded
  rebuild this entry exists to prevent. Adoption over a data plane that has
  already published anything is therefore an explicit act,
  `publish.py --adopt-id-space`, correct only for a build seeded from the live
  artifact. Over an empty directory there is nothing to contradict, so it is
  automatic. **A delta never adopts**: it cannot prove which ID space the
  snapshot its clients downloaded belongs to, and the asymmetry is the reason —
  a wrongly adopted *snapshot* is self-healing, because the clients it renumbers
  re-download and discard their old ids, while a wrongly adopted *delta* writes
  drifted ids into databases that keep them.

  That has a price, and it is the migration's: adopting requires publishing a
  snapshot, and a client at the old revision has no chain to it, so everyone
  re-downloads once. Rehearsed end to end against a simulated live origin —
  chunks published by the old code, an artifact recording none of this, no
  ledger file — and the sequence works: seed from the live artifact, publish
  with `--adopt-id-space`, then deltas from there. Cheap today (the site is a
  day old); if it ever is not, the thing to revisit is whether a delta may adopt
  under an explicit flag, not whether adoption should be silent.
- **What an id means at a published revision is immutable**, like the bytes at
  its URL and for the same reason: clients hold it. The ledger pins each
  revision's fingerprint on first publication and refuses to overwrite it, and
  `publish.py` refuses an artifact whose ID space differs from the one already
  recorded there — the *whole* record, marks and fingerprint together, built
  once and handed to the ledger unchanged. Comparing part of it while the ledger
  compared all of it was worse than not checking early at all: an artifact whose
  recorded extent differed but whose rows did not passed, was renamed into
  place, and was then rejected by the ledger, leaving the immutable URL occupied
  by bytes nothing had registered — which blocked the correct artifact from ever
  being published there. Deltas carry the same check for the revision they land
  on, since a chain can reach a revision another delta already published. Without that pin the
  `rev == published_head` exception below was a hole rather than a convenience:
  a sibling published at head *redefined* the revision's ids, and its own
  descendants were then accepted because the value the check compares against
  had moved with it.

- **Retiring *or adopting* an ID space needs a revision above the published
  head.** "Every
  client re-downloads" is only true if the manifest stops offering them a no-op,
  and `planSync` reports "already current" whenever the watermark equals head —
  so `--new-id-space` at head, which is the *legal* monthly-rebuild landing,
  left every synced client on the old ids and then applied the next delta to
  them. Above head, no chain reaches the new snapshot and the re-download is
  real. Adoption is bound by the same rule for a different reason: a legacy data
  plane has no recorded fingerprint to compare against — that is *why* it is
  adoption rather than a check — so landing above head is what makes being wrong
  survivable instead of silent. A bootstrap may never adopt at any revision:
  adoption asserts that these ids continue what was published, and a bootstrap
  continues nothing. That is also what retires the old deltas: no entry can start at or above
  a revision higher than every revision they reach.
- **The token cannot see a build seeded from the wrong ancestor**, because two
  children of one artifact inherit the same token while minting the same ids for
  different values. So the artifact also records `seed_rev`, the revision whose
  ID space it continued, and that is checkable: a snapshot must continue the
  published head, and a delta must continue exactly its own `from`. The second
  also closes `extra` (below): a payload spanning a revision its source was not
  built from would silently omit the content that moved in the revision it
  skipped. It settles the floors too — they describe the ID space at `from`, and
  the artifact records the extent it grew from, so `extract` can now refuse
  floors that are not that revision's instead of trusting its caller. A floor
  that is too high under-ships lookup rows, and `_check_closure` reads the gap
  as "the client already has it".

  `seed_rev` names a *revision*, though, and two builds can be stamped at one —
  a re-run after a failed attempt, a local iteration — sharing a token and a
  revision while disagreeing about what an id means. Neither their extent
  separates them (two siblings can mint the same number of rows), so the
  artifact records a **fingerprint** of the ID space it grew from: a SHA-256
  over every interned row and every `(id, cve_id)` pair, in id order. The ledger
  records the same fingerprint for the artifact it publishes at each revision,
  and the publishers compare. It costs one pass — 1.3 s over the full-cardinality
  synthetic artifact, and nothing during a build, because the seed's is folded
  into the pass that loads it. Hashing uses `surrogatepass`, because record text
  is attacker-influenced and need not be encodable UTF-8 (RE-015): a fingerprint
  that raised on a legal record would be worse than none.

  Provenance is **all-or-nothing**, and it is not the artifact's word alone.
  Each part of it feeds a different check, so a half-set silently disables one:
  `build.id_space` refuses an artifact carrying some of `seed_rev`,
  `seed_marks` and `seed_fingerprint` but not all. The floors are compared
  against **the ledger's** record of the revision they claim, not only against
  the artifact's copy — editing that copy upward otherwise raised the floor the
  emitter trusted, and the delta then referenced a lookup row it did not ship
  while `_check_closure` read the gap as "the client already has it". And the
  record has to exist: a missing one fails closed once this data plane records
  any, because a run that died between exposing a revision and recording its ID
  space left a gap that read as "nothing to check" — which is exactly the state
  a wrong sibling's descendant needs. Deltas therefore write their bytes and
  their ID space in one ledger write *before* the manifest exposes the new head,
  the same ordering snapshots use.

- **The exception both a retry and the monthly rebuild need.** A snapshot may
  also be published when it *is* the head rather than continuing it —
  `rev == published_head` — because the artifact the last delta was cut from is
  stamped at head and was seeded from head-1. Without that exception the rule
  refused the one artifact clients are synced to (D-055 calls that landing legal)
  and made every publish unrepeatable: `published_head` is read from the
  manifest, which a failed attempt has already advanced, so the retry was
  refused by a guard the failure created. The ledger is now written *before* the
  manifest for the same reason — the chunks are already served by then, so a
  crash between them leaves the ledger knowing about a revision the manifest has
  not yet advertised, rather than the reverse. The retry is an ordinary
  operation now, too: the generation directory lands before either write, so a
  crash leaves published bytes nothing has registered, and re-cutting *the same
  bytes* completes the run without `--force` — byte identity is checkable, and
  `--force` is documented as local iteration precisely because it can replace
  bytes that are not identical. Same rule a delta has had since D-055.

This is deliberately *not* on the wire. D-055 left an ID-space marker out of
`FORMAT_VERSION` 1 pending this task's shape, and having built it the value is
lower than it looked: every failure it would catch is caught here, before
publication, where it is still fixable — a client-side refusal would only turn
an unfixable server mistake into an unfixable client symptom. Deferring stays
safe only while nothing is deployed against the format, which is true until M2's
Sync ships; the daily-ingest task comes first, and is the last comfortable place
to revisit it.

**5. Two things the seeded artifact hands the ingest**, which owns the changeset
(M2's next task): `floors`, and `extra` — the ids whose *content* moved under an
id the client already holds. Only `cwe.descr` can do that. It is the one lookup
column that is neither part of its own interning key nor derived from it:
`url.host_id` is also a non-key column, but it is a function of the url text and
host ids are themselves seeded, so it cannot move while the url stays interned.
Any eighth lookup table has to be checked against that test, not against the
shorter claim that columns are keys.

The seeding discipline — **seed from the most recent build, not from the last
published snapshot** — is what `seed_rev` enforces. Ids minted by a daily delta
exist only in that day's artifact, and a monthly rebuild seeded from the older
snapshot would mint them again for different values.

**A schema bump breaks the ID space by construction**, and the chain is worth
stating once: seeding across one is refused (ids only mean something against the
shape that assigned them, and a bump makes every client re-download anyway,
D-025 hazard 4), so the rebuild must `--bootstrap`, which mints a new lineage,
which needs `publish.py --new-id-space` at a revision above head. Three
deliberate steps, none of them defaultable.

**Context.** Measured on a synthetic corpus built to the real corpus's *ID-space
cardinalities* rather than its text, so the interner is exercised at full scale
without 2.9 GB of JSON. As measured: 372,292 records, 24,421 vendors, 79,406
products, 756,522 urls, 18,987 hosts, 797 CWEs, 372 CNAs — against a real corpus
of 372,092 records, 24,420 vendors, 80,063 products, 18,986 hosts, 797 CWEs and
479 CNAs (D-024, D-033; the extra 200 records are the churn run below, which ran
between the two timing pairs). Records, vendors, hosts and CWEs are therefore at
real cardinality, products within 1%, CNAs at 78% of it — and the url count is a
*lower bound*, because the real corpus's distinct-URL count is not recorded
anywhere in these docs, only that 95.1% of records carry references (D-033). Run
on the dev VM (12 cores), not on `plex`, and with short descriptions, so the
absolute numbers are not comparable with a production run or with D-033's
artifact sizes; the comparison between the two rows is the result:

| Build | Time (two runs) | Peak RSS | Artifact |
| --- | --- | --- | --- |
| Bootstrap | 57.9 s, 59.0 s | 762.3 MB, 762.6 MB | 263.9 MB |
| Seeded, same corpus | 60.2 s, 58.5 s | 896.9 MB, 896.7 MB | 263.9 MB |

So seeding costs **+134 MB of peak RSS and no measurable time** — the two time
ranges overlap, and each build won one of the two pairs, so the honest statement
is "inside run-to-run noise on this machine", not a percentage. It costs nothing
in the published artifact either: the two files are the same size to the byte,
and the seeded rebuild minted zero ids. The memory is the seed maps and scales
with lookup rows, so the real corpus's URL count — not recorded, but above the
synthetic one — puts it higher. It is spent on the
server rather than in the browser, which is where this project's memory
constraints are (D-049); if it ever stops being affordable there,
`Interner._unused` can shrink to a used-bitmap plus full columns for `cwe`
alone, at the cost of specializing the code on which table's columns happen to
be its key.

Then a day's churn on top, in the arrangement that used to renumber everything:
200 records added *ahead* of every existing one in walk order, and 665 existing
records gaining a reference. The rebuild took 59.7 s, minted 200 record ids and
665 urls and retired nothing — and **1,252,797 pre-existing ids were compared
before and after, none of which moved**, with every new record id above the
previous high-water mark.

The fixture corpora went the other way. They had been arranged to *avoid*
renumbering — D-055 renamed a product to `zephyr` so it would sort after `gizmo`
— and that one is now a regression test: `gadget` is back, and `corpus_drift`
adds the second reproduction D-055 described but could not use (stripping the
*first* record's CWE and references). `test_interning.py` builds each of them
twice, unseeded and seeded, so the drift is reproduced rather than asserted
away.

Every guard here was checked by mutation rather than by inspection — the fix
removed, the suite re-run, the named test required to fail. Against the suite as
it stands (116 tests): recomputing the lookup high-water marks as `max(id)`
fails 4; a `SEED_KEY` that recovers the wrong key from a stored `product` row
fails 15; disabling seeding fails 74. Those counts move whenever a test is
added, so what matters is the method rather than the number — every guard listed
in this entry has at least one test that fails when it is removed, and that is
what was checked, one guard at a time.

`SEED_KEY` deserves the note, because getting one wrong does not raise — seeding
would store a row under one key while the build looks it up under another, and
the miss silently mints a duplicate id. What catches it is rebuilding an
unchanged corpus and requiring that *nothing* is minted, which covers every
table at once.

One bound that has nothing to do with ids and everything to do with the
contract: a revision is refused unless it fits in `0..2^53-1`, at build time and
at publication. `isRevision` in `lib/protocol.ts` caps it there and the client
refuses the *whole manifest* carrying a larger one, while SQLite stores an int64
without complaint — so `rev = 2^53` built and published cleanly into a data
plane no browser could read.

One more thing the second review round moved: `published_head` now comes from
every revision the ledger has *published*, deltas included, not from snapshot
revisions alone. A missing manifest used to lower it, which made
`--new-id-space` legal again at a revision clients were sitting at.

**Consequences.** `LOOKUP_COLUMNS` now has one definition, in `build.py`;
`delta.py` binds to it, because a column order two modules use positionally is
not a thing to write down twice. `fixtures.floors()` reads the artifact's record
instead of `max(id)`. `build()` takes the revision to stamp, so the ingest sets
it rather than editing the `meta` table that now holds the ID-space record. Four
hazards outside the ID space were found while hardening it and fixed here rather
than filed: a build could seed from the file it was writing (and lose the ID
space entirely if it then failed), a bounded `--year-min`/`--limit` build could
be seeded (retiring everything outside the slice, permanently), two files
claiming one CVE ID crashed the insert instead of failing closed through
`skipped`, and a failed build left a partial artifact a later run could seed
from or publish. `delta.publish` now asks whether the manifest could *hold* an
entry before writing the file: registration already refused a delta that would
strand a client, but by then the immutable URL was burned and the ledger had
recorded its bytes — which is exactly the shape of the bridging delta below.

The ID-space obstacle to that bridging delta is gone: an old head and a rebuilt
snapshot now share an ID space. The manifest still refuses one, because
`assert_tiling` requires every delta to start at or above the snapshot's
revision — so M2's monthly-rebuild task owns relaxing that walk as well as
emitting the file. *[D-060 did: the walk now requires only that nothing the
manifest names is a dead end, and a bridging delta publishes. The monthly cron
does not need one, because it lands at head.]*

**Reopen if.** Retirement turns out to churn enough rows to matter (it should
not: a value leaves only when no record in the corpus uses it), the server's
build memory becomes a constraint, the fingerprint pass stops being cheap at
corpus scale, or a lineage break shows up that none of the token, `seed_rev` and
the fingerprint can see — the last one is what would put the ID-space marker on
the wire, and the daily-ingest task is where that is still cheap.

One thing this entry does **not** settle, surfaced by the same review: a
snapshot published at `rev == published_head` with *different content* is
accepted, and every client already at that watermark is told it is current, so
it never sees the change. That is D-055's rule, not a new one, and it is the
monthly rebuild's problem — which is why the plan's monthly-snapshot task now
names it.

## D-055: The delta wire contract, finalized for the full schema  (2026-08-02, status: accepted, completes D-031 for the accepted schema D-033; its tiling rule is relaxed by D-060, which is what unblocks the bridging delta and retention)

**Decision.** D-031 settled the delta *protocol* against a schema that has since
grown, and left an illustrative example that omitted three lookup tables and two
row types. This is the contract as built, typed in `lib/protocol.ts`, validated
by `lib/delta.ts`, emitted by `pipeline/delta.py`, and tested across both
languages.

**1. The envelope**, JSON at brotli -q5, published as
`deltas/<from>-<to>.json.br`:

```json
{"format":1,"schema":1,"from":1,"to":2,"generated":1767225600,
 "notice":"CVE record content: Copyright © 1999-2026, The MITRE Corporation. …",
 "lookups":{"cna":[[2,"globex-cna"]],"cwe":[[2,"CWE-787","OOB write"]],
            "vendor":[[2,"globex"]],"product":[[4,2,"sprocket"]],
            "host":[[3,"newhost.example.org"]],
            "url":[[3,"https://newhost.example.org/x",3]],"vtype":[[2,"custom"]]},
 "upsert":[{"id":3,"cve":"CVE-2026-1003","y":2026,"st":1,"cna":2,
            "pub":1772323200,"upd":1772323200,"cvss":[4,9.1,4,"CVSS:4.0/AV:N"],
            "descr":"…","cwe":[1],"prod":[4],"ref":[3],
            "ver":[[4,1,"0",null,"4.2",2]]}],
 "delete":[]}
```

That is a real file, trimmed — `pipeline/tests/fixture_pub.py` publishes it.

- `from` is **exclusive**, `to` **inclusive**: the file applies to a database
  whose watermark is exactly `from` and leaves it at `to`.
- `generated` is **unix seconds**, matching the manifest. D-031's example used
  an ISO string; two time formats in one contract is one too many.
- Every lookup tuple is **the schema's column order**, so apply is a positional
  insert: `cna [id,name]`, `cwe [id,cwe,descr]`, `vendor [id,name]`,
  `product [id,vendor_id,name]`, `host [id,name]`, `url [id,url,host_id]`,
  `vtype [id,name]`. They are emitted in that order too, which puts `vendor`
  before `product` and `host` before `url` — the only ordering apply needs.
- A record carries `[id, cve]` — both, because both are columns of the `cve`
  row — plus `y`, `st`, and optional `cna`, `pub`, `upd`, `cvss`, `descr`,
  `cwe`, `prod`, `ref`, `ver`. `cvss` is `[ver, score, sev, vector]` in
  **stored codes** (D-047: 31 and 4 are labels, not magnitudes). `ver` is
  `[product_id, status, version, lt, lte, vtype_id]`.
- **Absent means absent**, never "unchanged": apply is a replacement, so an
  omitted `cwe` deletes the record's CWE rows. An empty `descr` is refused
  rather than treated as absent — a record with no English description has no
  `cve_text` row at all (D-023), and an empty string would insert one.
- `delete` carries canonical CVE IDs, not row ids: a tombstone should be
  readable in a published file and should not depend on ID-space agreement.

**2. The manifest** gains typed `deltas`, and `snapshot.rev`. Top-level `rev` is
now the **head** revision — the newest state the data plane can reach, which is
the last delta's `to` — while `snapshot.rev` is the snapshot's own. They are
equal only until the first delta lands, and a client that conflated them would
believe a fresh snapshot was current. A delta entry is
`{from, to, bytes, raw_bytes, sha256}` and **carries no file name**: the client
derives the URL from the two integers (`deltaUrl`), so no string out of the
manifest ever reaches a request path. `bytes`/`sha256` describe the compressed
file as they do for a chunk; `raw_bytes` is checked after decompression.

**3. Lookup rows are selected by floor, not by a revision column.** The ID space
is append-only and never renumbered (D-025 hazard 1), so "the lookup rows a
client at rev N does not have" is exactly "the rows above rev N's maximum id per
table" — seven integers per revision instead of a `rev` column on seven tables.
D-031's range query is unchanged in effect; only its implementation gets
cheaper. An explicit `extra` id list covers the one case a floor cannot see: a
row whose content changed under an existing id.

**4. Validation is strict, in both directions.** The client refuses an unknown
key, a tuple of the wrong arity, a non-integer id, a delta whose `from`/`to`
disagree with the manifest entry that named it, or a payload with no notice
(D-008 is a condition of the grant, not decoration). The consequence is
deliberate: **adding a field to the format is a `FORMAT_VERSION` bump**, because
an old client refuses rather than half-understands. The pipeline fails closed
too (D-047): an upsert naming a record the artifact does not contain, a
reference to a lookup row the client will never receive, or a dangling id all
abort the build rather than publish.

**5. The client's bounds are the server's bounds.** The client refuses the
*file*, not the record, so anything it will not accept has to be caught where it
can still be fixed — a published delta cannot be withdrawn. The emitter
therefore validates the whole payload the way the client will, field for field
and sign for sign: CVE IDs non-empty and at most 64 characters (tombstones
included); every integer — envelope, record scalars, nested id lists, version
tuples, CVSS tuples, lookup row ids — inside JavaScript's safe range; row ids at
1 or above, counts and codes non-negative, and only the two timestamps signed.
Size checks alone were not parity: a `generated` of -1, a CVSS version of 2^60
and a row id of 0 all passed the emitter and would each have been refused on
arrival, taking the whole file with them. `build.py` additionally requires a
well-formed CVE ID, using the official Record Format's own pattern
(`^CVE-[0-9]{4}-[0-9]{4,19}$`, read from CVEProject/cve-schema on 2026-08-02 —
a home-made narrower cap would mark valid records unusable and abort a whole
ingest), falling back to the record's file name and refusing the record if
neither is usable. Normalization drops a CVSS score that is not a finite float,
converting defensively first because `math.isfinite(10**1000)` raises rather
than answering.

Each of those was a real hole, found by review and reproduced: a 300-character
`cveId` and a 2^53+1 year both built and shipped cleanly; `"baseScore": 1e400`
serialized as a bare `Infinity` token that `JSON.parse` rejects outright; and an
empty tombstone was published that the client would refuse on arrival.

**5a. A delta carries the revision *and* the schema its artifact is stamped
with.** `extract` requires `meta.rev == to_rev`: without it an artifact at rev 2
emitted a 1→999 delta, so rev-2 rows would install while the client's watermark
jumped to 999, after which it asks for deltas that do not exist and never syncs
again. It equally requires `meta.schema` to be present and to equal the schema
this pipeline build produces — a schema bump cannot be bridged by a delta at all
(the client refuses one whose schema is not its own and re-downloads, D-025), so
emitting from an artifact built by a different pipeline version would ship rows
in the wrong shape inside a file nobody can apply. Defaulting a missing key to 1,
which the first version did, is a guess about the one thing that must not be
guessed. The
floors map is likewise all-or-nothing — every table, or an empty map from rev 0
to bootstrap — and an `extra` id the artifact does not hold is refused rather
than dropped, because dropping it leaves the client with stale content and no
way to notice.

**6. Delta files must tile the revision space, and the advertised head must be
the one they reach.** architecture.md has stated the tiling invariant since M0 —
a client at a watermark with no covering chain can never sync again — and
nothing enforced it. One ingest run that mints a revision without publishing its
delta would leave every client re-downloading the corpus, landing back where it
started, and doing it again the next day. `manifest.py` now refuses to write
such a manifest: reachability in both directions (every revision a client can
hold has a chain to head, and every delta starts from a revision a client can be
at), plus `rev` equal to the head those files actually reach — a manifest
claiming rev 999 over a 1→2 chain, or over no deltas at all, tells every client
to get somewhere nothing can take it.

**7. What has been published is recorded in a ledger, not inferred.** D-047's
immutability was enforced by `os.path.exists`, then by the manifest. Both are
too weak, and each weakness was found by reproducing it: the filesystem forgets
when retention deletes a file, and the manifest only ever describes the
*current* generation, so a rotated-away delta range looked unpublished and its
URL was freely re-cuttable with different bytes. A manifest predating
`snapshot.rev` could not even say which revision was live.

So `pipeline/ledger.py` keeps an append-only record of every published artifact
— snapshot revisions, and each delta range with the SHA-256 of the bytes served
at its URL. It lives **beside** the published directory (`cve.pub/published.json`,
a peer of `cve.pub/data/`), because it is pipeline state rather than part of the
contract and no nginx location reaches it (D-053). It seeds itself from the
current manifest, so an origin published before it existed is covered from its
next run rather than from a clean slate. The rules it enforces:

- A snapshot revision that was ever published, or that is below the highest one,
  is refused: a rotated-away generation was otherwise re-cuttable, rolling the
  manifest backwards under clients that had already synced past it. `rev == head`
  stays legal — that is the monthly rebuild landing where the deltas already are.
- A delta range may be rewritten only with **byte-identical** content. That
  includes `generated`: apply writes it to the client's `meta.generated`, so two
  payloads differing only there are genuinely different content at a URL caches
  hold for a year. Which makes one thing a requirement on the ingest rather than
  a nicety — **`generated` must be pinned per revision**, not stamped from the
  clock on each attempt, or no retry can ever reproduce its own bytes.
- With that, a run that died between writing and registering is recoverable by
  re-running the same changeset: the bytes match, the write is a no-op, and
  `--force` is not needed. `--force` stays what it says on the tin, local
  iteration, rather than a production recovery mechanism.

**Context.** The one thing worth measuring here was whether the format is
*sufficient* — a format can type cleanly and still lose a column. So the tests
build snapshot N, emit the delta, apply it with a reference applier
(`pipeline/tests/apply.py`), and compare against a freshly built snapshot N+1
table by table: 72 pipeline tests, 88 unit tests, all green. The applier is
test-only and the client's lands with Sync, but it is what proves the wire
carries enough — and it pins the apply semantics in executable form, including
the id/CVE-ID tripwire below.

Sufficiency has to be tested in the *removal* direction too, which the first
draft did not do. Every fixture change was additive, and an applier that clears
only the sections a delta happens to carry — precisely what "absent means
absent" forbids — passed the entire suite. It now fails: one fixture build
strips a record's description, CWE, reference, CVSS and version rows, and the
applied database must lose them. Assertions were checked the same way rather
than assumed, by mutating the code they cover: dropping `cvss`, `ref` and `ver`
from the emitter and shifting every row id used to pass the cross-language
contract test untouched, because all of those are legitimately optional.

Two findings came out of building it:

- **A rebuild renumbers, and it is easy to trip.** The fixture originally added
  a product named `gadget` to an existing record; because
  `normalize.projection` sorts each record's products, `gadget` interned ahead
  of the existing `gizmo`, which moved from id 2 to 3 — and delta apply then
  wrote the new record's rows against the wrong product. Renaming it `zephyr`
  fixed the fixture. It happened a second time while adding the removal-direction
  test: stripping the *first* record's sections moved CWE-79 behind CWE-787,
  because the next record to use a value inherits the id when the first one
  stops. Nothing catches either case — the id/CVE-ID tripwire covers `cve` rows
  only, and a drifted *lookup* id silently resolves to the wrong vendor or
  product. Seeding (M2's next task) is the fix, not a mitigation, and it must
  cover `cve.id` as well as the seven lookups: `cve.id` is a bare walk counter
  today, so adding one record renumbers every record after it.
- **`INSERT OR REPLACE` would hide that silently**, so apply must not use it for
  `cve` rows. If a delta says CVE-X is row 7 and the local database says row 4,
  the ID space has drifted and the only safe move is to stop and rebuild. The
  contract therefore *requires* apply to verify the id/CVE-ID pairing **in both
  directions** before writing. One direction is not enough, and review found the
  gap: checking only CVE→id let an upsert for a CVE the client had never seen,
  at a row id it had already given to a different record, delete that record
  with no error and no orphan to notice it by — a silent undercount, which is
  what vision criterion 7 exists to prevent.
- **A delta is a step from one revision, not a patch that fits anywhere.** Apply
  must refuse a file whose `from` is not the local watermark; without that,
  replaying an old delta rewinds `meta.rev` and writes rows against a state they
  were never computed from. Row-level idempotence (D-031) is about *retrying the
  same step*, which a rolled-back transaction leaves safe.

**Consequences.** `Manifest.deltas: unknown[]` is gone; `planSync` picks the
chain — `[]` when current, `null` when no chain exists and only a re-download is
honest, a throw when the manifest contradicts itself. The search is
breadth-first rather than greedy longest-first: greedy fails the very case that
motivated it (given 1→3, 1→2 and 2→4 with head 4 it takes the long hop,
dead-ends, and reports a 63 MB re-download while a two-file chain exists), so
the rollup claim below is only true because the search is complete.

`publish.py` now writes `snapshot.rev`, and keeps a previous generation's delta
entries only when they start **at or after** the new snapshot's revision.
Keeping every entry whose file existed — the first attempt — helped nobody: a
delta below the new snapshot belongs to the generation being replaced, no chain
reaches head through it, and in one configuration it left a *freshly downloaded*
client with no chain out of its own snapshot, re-downloading forever. Retention
across a rotation therefore needs a bridging delta from the old head to the new
snapshot's revision, which needs seeded interning; until then a client one
generation back re-downloads, and the manifest says so honestly.

`snapshot.rev` is typed optional, because the generation live today does not
have it: `assertUsable` deliberately does not require it, so a client can still
download from an origin that has not republished. Reading it goes through
`snapshotRev`, which names that as the problem instead of reporting an
undefined watermark. `chunkUrl` now validates the snapshot path and chunk name
against the shapes `publish.py` writes, so "no string out of the manifest
reaches a request path" is true of the whole data plane rather than of deltas
alone.

Nothing in the client fetches or applies a delta yet — that is M2's
Download/Sync work, which this contract exists to unblock.

One correction to an earlier entry: D-047 says a `--force` republish "swaps via
rename so there is still no window". There is a window — Linux has no portable
atomic directory swap — so a client fetching a chunk in that instant gets a 404
and retries. `--force` remains local-iteration only, and the comment in
`publish.py` now says what actually happens.

**Reopen if.** Deltas grow large enough that whole-record replacement stops
paying (D-031's reopen condition, unchanged), a schema addition needs a new row
type (that is a `FORMAT_VERSION` bump by construction), or rollup files become
worth publishing — `planSync` searches for a chain rather than assuming one, so
the format would not have to change, only the pipeline.

One addition is worth deciding *before* anything is deployed against
`FORMAT_VERSION` 1, because strict validation makes every later field a bump:
an **ID-space generation marker** in the envelope and in `DeltaEntry`. Today a
delta built against a renumbered ID space is caught deep inside apply, by the
tripwire, and only for `cve` rows; a generation marker would make "this delta is
not for your copy" a first-class refusal before a single row is written. It is
not added here because the value depends on how the ingest ends up recording
generations (M2's next two tasks), and guessing that shape now would be the
kind of speculative field this format is deliberately strict about.

## D-054: Cached assets revalidate — `no-cache` for the unversioned SQLite distribution, and the service worker is network-first  (2026-08-01, status: accepted, owner decision; refines D-048)

**Decision.** Two halves of one rule: **a cached copy never wins over a
reachable network**.

1. **HTTP.** `/sqlite/` is served with `Cache-Control: no-cache` — revalidate,
   not "do not store" — from a `^~ /sqlite/` location that outranks the
   `\.(js|css|…)$` regex block.
2. **Service worker (M5, D-048).** Network-first with cache fallback, never
   cache-first. The cache exists so the app *opens* with no network (vision
   criterion 5); it does not exist to serve yesterday's shell to someone online.
   Owner decision, 2026-08-01.

**Context.** The SQLite/WASM distribution is three files that resolve each other
by relative URL — `index.mjs`, `sqlite3.wasm`, and
`sqlite3-opfs-async-proxy.js` — copied verbatim to unversioned paths under
`/sqlite/`. As deployed they had three *different* cache policies, none chosen:

| File | Policy as deployed | Why |
| --- | --- | --- |
| `index.mjs` | none → heuristic freshness | no rule matched |
| `sqlite3.wasm` | none → heuristic freshness | no rule matched |
| `sqlite3-opfs-async-proxy.js` | `max-age=315360000` | matched the static-file regex |

Both failure modes showed up for real on deploy day. Heuristic freshness pinned
a *wrong* response in a browser: RE-012's `application/octet-stream` MIME type
survived in the owner's cache after the server was fixed, so the app kept
failing against a server that was already correct. And a ten-year `max-age` on
one of three files that must move together means the next dependency bump ships
a stale async proxy against a fresh `.wasm` — a mixed-version failure with no
error message pointing anywhere near the cause.

There is also no client-side remedy to fall back on: a hard reload does **not**
bypass the cache for a dedicated Worker's dynamic import, which is how the
SQLite distribution is loaded (RE-013, reproduced). A user holding a bad entry
cannot clear it by the one action everybody knows. That moves this from tidiness
to load-bearing — the server has to be right, because the client cannot recover.

`no-cache` is the right policy for an unversioned asset. The alternative —
content-versioned paths plus `immutable` — is strictly better caching and was
not chosen now because it costs build plumbing to keep three mutually-resolving
files consistent, and because the payload is ~1.6 MB behind a 304 that costs
nothing. If the revalidation round trips ever matter, versioning the directory
is the upgrade, not a longer `max-age`.

**Verified in production 2026-08-01**, after the owner applied the block: all
three files return `Cache-Control: no-cache` with correct types
(`text/javascript`, `application/wasm`, `text/javascript`) and all three
cross-origin headers, and the full-corpus import still completes against the
deployed origin. The `^~` prefix does outrank the static-file regex, which is
what the async proxy's ten-year `max-age` depended on.

**Consequences.** M5 implements the service worker network-first, which also
makes the SW cache incapable of reintroducing the staleness this entry exists to
prevent — the two halves reinforce rather than duplicate each other. D-048's
"cache the shell, Worker, WASM and brotli decoder" stands; only the strategy is
pinned. The `/data/` policy is unaffected and stays immutable, because published
generations genuinely are (D-041, D-047) and the manifest above them is
`no-cache` already.

**Reopen if.** Revalidation latency on the shell becomes measurable against the
M1 baseline (D-049), in which case version the paths and go immutable; or the
service worker's network-first path turns out to make offline *detection* slow
enough to hurt, which is a timeout question inside the SW rather than a reason
to prefer cache.

## D-053: Published artifacts live in `cve.pub/`, a peer of both the document root and `cve.data/`  (2026-08-01, status: accepted, amends the layout in D-018 and D-034; the "three subdirectories" below became four when D-058 added `cve.data/state/`)

**Decision.** The served data plane is
`/var/www/meenan.dev/cve.pub/data/`, a third peer directory alongside `cve/`
(the document root) and `cve.data/` (server-side state). nginx serves it with
`root /var/www/meenan.dev/cve.pub;` under `location ^~ /data/`.

This restores an invariant that can be stated without an asterisk: **nothing
under `cve.data/` is web-reachable.** Its three subdirectories — the 4.0 GB
clone, the 1.1 GB of working databases, and the KEV cache — have no path to the
web at all.

**Context.** D-018 established `cve.data/` as a peer of the document root and
verified with a canary file that nothing under it was reachable. That held
because a PHP handler read from `db/` and served the bytes. D-032 then removed
the handler and D-034 made the data plane static files, which have to be
reachable by URL — so D-034 added a fourth subdirectory, `cve.data/pub/`, and
aliased it into the web. Nobody reconciled D-018's table, and the project owner
read the docs during the first deploy and asked why a web-exposed directory was
inside the one described as not being served. That confusion is the argument:
a rule with an exception is a rule people get wrong.

The security case is blast radius rather than a present hole. The alias form was
safe — trailing slashes on both sides, and nginx normalizes `..` before matching
— but it put a served path one directory level away from 5 GB of clone and
working databases. Now a misconfigured `root` can only ever expose artifacts
that are already public.

**Two nginx specifics, both learned the expensive way during this deploy:**

- **`root`, not `alias`.** The `cve.meenan.dev` server block defines `try_files`
  at server level, which every location inherits, and `alias` + `try_files` is a
  long-standing nginx defect: `$uri` is appended to the alias, producing
  `<alias>/data/...` and a 404 for every artifact. Naming the directory `data`
  so the URL maps straight through under `root` avoids the whole class.
- **`add_header` does not merge.** A location that declares any `add_header`
  drops every inherited one, so COOP/COEP have to be repeated in each block or
  artifacts lose cross-origin isolation — which the `opfs` VFS requires (D-051).

**Consequences.** `pipeline/publish.py` targets `cve.pub/data/`; the M2 crons
(D-042) publish there. D-018's table is updated to three subdirectories, all
private. D-034's snippet is superseded by the block in
[architecture.md](architecture.md). The deploy story is unchanged — `rsync
--delete` still mirrors `dist/` into `cve/` and touches neither peer.

**Reopen if.** A second served surface appears (the KEV catalog is already
planned for the same tree, which this handles) and wants a different lifecycle;
or the host convention changes such that peer directories are no longer safe,
which D-018's canary check exists to re-verify.

## D-052: No duration ceilings anywhere; stalls are failures, and anything over a second reports itself  (2026-08-01, status: accepted, owner decision; replaces the ceilings in D-049)

**Decision.** Owner decision, 2026-08-01, generalizing the query-latency call:

1. **No operation has a pass/fail duration ceiling.** Not queries, not import,
   not sync. Work takes as long as the data and the hardware make it take. A
   measured number is a *baseline* — evidence for spotting regressions and
   choosing what to optimize — never a gate.
2. **A stall is a failure, and duration is not.** "Slow" and "stuck" are
   different conditions and get different treatment: the app must be able to
   tell that an operation has stopped making progress and say so. This is what
   replaces the timeouts a ceiling would have justified — the signal is *no
   forward progress*, not *elapsed time*.
3. **Anything over roughly a second reports what it is doing**, and reports
   real progress wherever the work is countable. Below a second, feedback is
   noise; above it, silence is indistinguishable from a hang — which is exactly
   the confusion rule 2 exists to prevent.
4. **Resource numbers — peak memory, OPFS footprint — are tracked, not
   gated**, on the same reasoning. They are still worth watching: a number that
   moves sharply is a regression worth understanding, and running out of memory
   or quota is a real failure. But it is the failure that fails, not the
   number crossing a line someone picked.

**Context.** D-049 originally attached ceilings to the M1 measurements — import
under 3 minutes, peak memory under 1 GB, footprint under 600 MB, queries under
1 s. Every one of them was a number chosen by an agent for having a comfortable
margin over one machine's measurement, which is not what a success criterion
should be made of. The owner removed the query ceiling first and then the rest.

What makes this safe rather than lax is that the ceilings were never doing the
work anyone imagined. A 3-minute import limit does not help a user on a slow
laptop; it just relabels their slow-but-working import as a failure. What
actually protects that user is the thing a ceiling was standing in for: knowing
whether anything is still happening.

**Consequences.**

- **M1's cold first query after a reopen (~9 s) and the reference-host scan
  (~850 ms) stop being violations** and become what they always were: known
  costs, worth attacking on their merits (M3).
- **The Worker reports activity for queries, not just imports.** Implemented
  here: `Phase` gains `query`, single queries report that they are running, and
  the benchmark reports `n / 10` as it goes — it is the one place in the
  current code where countable progress was available and unused.
- **M2 owns stall detection**, since it owns the download that can actually
  hang: no forward progress for long enough is an error state with a message,
  distinct from a slow link. The import path already has chunk-level progress
  to hang that off.
- **M3 owns query feedback and cancellation.** With no ceiling, a long query is
  legitimate, so the user needs to see it running and be able to stop it.
- **M5's diagnostics panel** is where a tracked-but-ungated resource number
  becomes visible (D-009 leaves no other channel).
- The e2e and measurement suites keep their timeouts. Those are stall detectors
  for an unattended process, not product ceilings, and `tests/e2e/measure.spec.ts`
  already says so.

**Reopen if.** Tracking-without-gating lets a real regression land unnoticed —
in which case the answer is a comparison against the recorded baseline that
*reports*, not a threshold that *blocks*; or a platform limit (a quota, a
browser's own watchdog) turns out to impose a ceiling whether we like it or
not, which is a fact to document rather than a decision to revisit.

## D-051: The `opfs` VFS, not `opfs-sahpool`  (2026-08-01, status: accepted, answers Q-004, constrains D-004)

**Decision.** The database is stored through SQLite's **`opfs`** VFS. The
`opfs-sahpool` path stays in the Worker behind an import option so the
comparison can be re-run, but nothing selects it by default.

**Context.** Q-004 was deferred to M1 by D-029 because it needs a running
browser. D-030 had already retired its server-configuration half — COOP/COEP is
served, so both VFSes were genuinely available — leaving performance and
multi-tab behaviour. Measured at full scale (`pnpm measure`, 2026-08-01,
Chromium/Linux):

| | `opfs` | `opfs-sahpool` |
| --- | --- | --- |
| Import, wall-clock | 73.3 s | **64.6 s** |
| of which index build | 66.1 s | **56.4 s** |
| Peak renderer RSS | **682.0 MB** | 713.2 MB |
| Query latency, 10 shapes | 6–954 ms | 2–868 ms |
| **Second tab** | **opens the database and queries it** | **stops responding** |

`opfs-sahpool` builds indexes faster — 56.4 s against 66.1 s — and queries
indistinguishably. That gap is at the edge of what this sweep can resolve: the
index stage varied 20% across runs that should have been identical (D-049), and
56.4 s is below every `opfs` index time recorded, so the direction is probably
real even if the size is not. It loses anyway, on two things that outrank
seconds:

- **A second tab.** SQLite's documentation for `installOpfsSAHPoolVfs`
  ([sqlite.org/wasm/doc/trunk/persistence.md](https://sqlite.org/wasm/doc/trunk/persistence.md),
  read 2026-08-01) says only one instance may use a pool directory at a time.
  What that means in practice, measured: the second tab stops
  responding entirely — no error, no verdict in 150 s, not even a page that can
  answer a query about its own storage. (The first tab is unharmed and keeps
  querying normally, so this is a hang, not corruption.) On `opfs` the second
  tab opens the same database and queries it. Multi-tab behaviour is a
  confirmed feature, and "one of my tabs is frozen" is the worst available
  answer to it.
- **It cannot express M2's download.** The pool's files are opaque; bytes get in
  only through `importDb`, which truncates the target and appends strictly
  sequentially. M2 requires a *staged* replacement with a per-chunk completion
  bitmap, resumable after a kill, that never destroys the live copy until the
  new one verifies. On `opfs` that is positional writes into a staging file. On
  the pool it would mean writing 377 MB to a raw OPFS file and then copying it
  through `importDb` — double the writes, and still not resumable.

Whatever the gap is, it is entirely index-build time — the stage D-050 shows is
dominated by page-cache behaviour rather than by the VFS — so it is also the
part of the import most likely to move for reasons that have nothing to do with
this choice.

**Consequences.** M2 builds staged replacement on positional writes. M5's
multi-tab work starts from "concurrent readers work" rather than from
"serialize the tabs". COOP/COEP become load-bearing rather than incidental —
without them the `opfs` VFS is unavailable and there is no fallback selected,
so the capability gate (M5) must check for it explicitly. The sahpool code path
is kept, and is the thing to reach for if COOP/COEP ever cannot be served.

**Reopen if.** Multi-tab turns out to need serialization anyway for correctness
(then the pool's exclusivity is a feature, not a cost); or a browser we intend
to support cannot use the `opfs` VFS; or `importDb` gains a resumable form.

## D-050: SQLite's page cache is set to 256 MiB  (2026-08-01, status: accepted)

**Decision.** Every connection opens with `PRAGMA cache_size=-262144`
(256 MiB) and `PRAGMA temp_store=MEMORY`.

**Context.** SQLite's stock page cache is 2 MiB. The corpus is 377 MB, so at
stock every aggregate re-reads most of the database through OPFS on every run.
This was found by measuring query latency at full scale for the first time and
getting numbers in *seconds*, which is not a tuning detail but a different
product. Measured across the ten query shapes in `lib/queries.ts` (warm,
`opfs`, full corpus, one run per row):

| Page cache | Index build | Queries over 1 s | Slowest query | Range over the other nine | WASM heap after querying | Peak RSS |
| --- | --- | --- | --- | --- | --- | --- |
| 2 MiB (stock) | 247.4 s | 8 of 10 | 91.9 s | 13 ms – 42.8 s | 75.8 MB | 591.0 MB |
| 64 MiB | 64.0 s | 4 of 10 | 20.7 s | 8 ms – 4.7 s | 157.4 MB | 558.0 MB |
| **256 MiB** | **68.9 s** | **0 of 10** | **680 ms** | **4–161 ms** | 391.9 MB | 715.1 MB |
| 512 MiB | 67.3 s | 0 of 10 | 784 ms | 5–171 ms | 470.3 MB | 746.2 MB |

("Queries over 1 s" is a way of counting how bad each setting is, not a
threshold anything has to clear — D-049 sets no latency ceiling.)

Three things this measurement settles:

- **It is not a linear knob.** 64 MiB is 32× the stock cache and still leaves
  four queries over a second, one of them at 20.7 s — 30× slower than the same
  query at 256 MiB. There is no useful middle setting.
- **256 MiB is where the curve flattens.** 512 MiB is not faster — the ten
  shapes come out within noise of each other, and the slowest is marginally
  *worse*. It is not free either: SQLite genuinely claims the larger cache
  (470 MB of WASM heap against 392 MB) and peak RSS rises 31 MB for it.
- **Memory is bought, not saved.** Peak RSS climbs from 558 MB at 64 MiB to
  715 MB at 256 MiB. The stock setting is not the cheap end of that trade — it
  costs 591 MB *and* is unusably slow, because pages it will not cache it
  re-reads through buffers that cost more than they save.

It also cuts index building nearly fourfold (247 s → 69 s), which is what keeps
D-035's "build the indexes on the client" defensible at all.

**How the heap number was arrived at**, because the first attempt got it wrong:
the WASM heap was originally sampled at the end of import, before any query ran,
which showed 272 MB at *both* 256 and 512 MiB and supported a confident claim
that the larger cache was never claimed at all. It is claimed — by the queries,
which is where a page cache does its work. The benchmark now takes its own
reading (`BenchResult`'s sibling `wasmHeapBytes`) and peak RSS is read after the
benchmark rather than after the import.

**Consequences.** Every number in D-049 is measured with this in place and none
of them reproduce without it. The memory ceiling must accommodate a resident
page cache — ~715 MB peak on a 377 MB corpus is the number to hold against, not
the 62.7 MB download. M3's index tuning starts from these latencies, not from
the stock-cache ones. If M5 needs a smaller footprint on constrained devices,
64 MiB is the measured fallback and it costs roughly two orders of magnitude on
the worst shapes — a tier, not a dial.

Note this decision does not depend on a latency ceiling, which D-049 declines
to set: the case for 256 MiB is a two-orders-of-magnitude difference against
the stock setting, which is decisive under any framing.

**Reopen if.** The mobile/low-memory story arrives (M5's quota and capability
work) and 256 MiB is too much to claim on a small device — in which case this
becomes a tier, measured per tier rather than lowered by guess; or the corpus
grows enough that the working set outruns 256 MiB, which the same sweep will
show as the slowest-query number climbing again; or M3's indexing makes the
reference-host scan cheap enough that a smaller cache performs comparably.

## D-049: The M1 browser baseline, measured at full scale  (2026-08-01, status: accepted, answers Q-003, settles the concurrency number D-041 deferred; its ceilings removed by D-052)

**Decision.** These are the numbers the whole client is measured against from
here. **None of them is a threshold** — D-052 removed the ceilings this entry
originally attached, so what follows is a baseline: evidence for spotting a
regression, for choosing what to optimize, and for telling a future agent what
"normal" looked like on real hardware in August 2026.

- **Cold import: 73.3 s** wall-clock, of which **66.1 s is building the search
  indexes** and 7.2 s is everything else — fetch, checksum, decompress and
  write, elapsed, over loopback. Throttled to 50 Mbps / 40 ms the non-index
  part is 13.5 s.
- **Peak memory: 682–715 MB** for the renderer process hosting the Worker,
  after importing *and* running the benchmark.
- **Local footprint: 441.1 MB** in OPFS — the 376.7 MB database plus 64.4 MB of
  client-built FTS index.
- **Query latency: 4–190 ms** for nine of the ten shapes in `lib/queries.ts`,
  and **680–954 ms** for the tenth (a full scan of the reference tables).
- **Reopening with a local copy: 287 ms** to report the corpus after a reload.
  The first query then takes **9.2 s**, because the page cache starts empty and
  the first aggregate re-reads from OPFS.

Two of those are worth attacking on their merits and neither is a failure: the
reference-host scan has no supporting index, and the ~9 s cold query is pure
page-cache warming. Both are M3's.

What replaces the ceilings is D-052: an operation over a second says what it is
doing, one that stops making progress is detectably broken, and how long the
work legitimately takes is not a verdict on it.

It also settles the number D-041 left open: **four chunks in flight** — on the
elapsed transport time, which is the only column concurrency can move.

| Chunks in flight | Transport (loopback) | Transport (50 Mbps / 40 ms) | Peak RSS |
| --- | --- | --- | --- |
| 1 | 7.2 s | 18.5 s | 568.2 MB |
| 2 | 7.5 s | — | 570.1 MB |
| **4** | 6.9 s | **13.5 s** | 630.4 MB |
| 8 | 6.6 s | 13.4 s | 696.0 MB |

On loopback the four settings are indistinguishable — 6.6 to 7.5 s, with no
ordering worth reading — which is why the throttled column exists: a decision
made on the loopback numbers would have been a decision about the test rig.
Throttled, concurrency does what it is for: 4 takes 5 s off an 18.5 s
transport, and 8 adds nothing measurable while costing 66 MB of peak memory.
Four was already the default; it is now the measured one. (CDP throttling was
checked to actually reach the Worker's fetches rather than assumed to — the
sweep compares elapsed transport against what 62.7 MB at 50 Mbps cannot beat,
and records a note if a row came out at loopback speed.)

**Context.** Q-003 was deferred to M1 by D-029 and measured on the slice first
(39,196 records) on 2026-08-01. At full scale the slice's headline holds and
its explanation does not: index building really is ~90% of import — 66.1 s of
73.3 s — but only because D-050 raised the page cache. At SQLite's stock 2 MiB
it is 247 s of 255 s, and the whole import is three and a half minutes. The
sweep lives in `tests/e2e/measure.spec.ts`, is re-runnable (`pnpm measure`),
and writes `measurements/measurement.md`; every number here is transcribed from
that file.

**How good these numbers are.** Every cell is a single run on one machine, and
the sweep is noisy: across nine runs that differ only in download settings —
which cannot affect index building — the index stage ranged 64.0 s to 79.8 s, a
spread of 20%. So differences below about a fifth are not results, and none of
the conclusions above rest on one: the concurrency call is made on transport
(a 27% gap), the page-cache call on two orders of magnitude, and the VFS call
(D-051) on a categorical multi-tab outcome.

Read every number as "one machine, one run" — a 12-core Linux desktop,
Chromium 151, server on loopback, hardware at the friendly end. Nothing here
needs the slack a threshold would have needed, because nothing here is a
threshold: a slower machine produces a slower baseline, not a failure.

**The benchmark set is part of the decision.** A baseline means nothing without
saying *what* was measured, so the ten shapes in `lib/queries.ts` are the
yardstick: a point lookup, four indexed aggregates, two joins through the link
tables, a full scan of the reference tables, and three FTS shapes. They
were chosen by access-path shape rather than by feature checklist, they are
literal single `SELECT`s with no parameters and no wall-clock dependence (a unit
test enforces all three), and M3 tunes against them. Adding or removing one
changes what the budget means and belongs here, not in a commit message.

**What was left open.** Behaviour on a low-memory or mobile device (M5, with
the capability gate); any browser other than Chromium (M5 again — Playwright
runs Chromium-only today, and rule 3 applies to support claims); and the first
query after a reopen, which is measured but not yet fast.

**Consequences.** M3's exit criterion becomes "no regression against the
recorded baseline, and slow queries behave well" rather than "queries are under
N ms". M2's progress display has a shape to honour — a 73 s import whose last
66 s is a single serial stage needs the index build to be its own visible
phase, not a spinner after the download bar fills, and it is also the natural
place to notice that nothing has advanced in a while (D-052).

**Reopen if.** A repeat sweep with several runs per cell contradicts an
ordering claimed here; the first real-network measurement disagrees with the
throttled transport numbers; or the corpus grows enough that these numbers stop
describing the product, in which case the sweep is re-run and this entry
superseded rather than argued with. Note what would *not* reopen it: any
individual measurement getting worse. That is a fact to explain, and possibly a
regression to fix, but the baseline is not a promise anyone made.

## D-048: An offline app shell ships via service worker, scoped to the shell and never the data plane  (2026-08-01, status: accepted; **fetch strategy pinned network-first by D-054**)

**Decision.** The app registers a service worker that caches the app shell —
the exported HTML/JS/CSS, the SQLite/WASM distribution under `/sqlite/`, and
the brotli decoder — so the app opens and works with the network disconnected,
not merely survives in an already-open tab. Owner-confirmed 2026-08-01 after
the external review flagged that vision criterion 5 ("works offline, fully")
had no implementation path: OPFS preserves the *data*, but nothing preserved
the app.

Two scope boundaries are load-bearing:

- **The service worker never caches the data plane.** `manifest.json` is the
  freshness signal (D-042) and the chunks/deltas are immutable and
  OPFS-resident once imported — an SW cache in front of `/data/` could serve a
  stale manifest and break the staleness indicator, the one guard vision
  criterion 7 has against confident-but-old counts. Fetches under `/data/`
  pass through untouched.
- **Model weights stay out of the SW cache** (M8): they live in OPFS under the
  app's own management (D-045), and multi-gigabyte cache entries are the wrong
  tool.

Update semantics: the SW cache is versioned per deploy and activates on next
load, so a deploy cannot leave a stale shell talking to a new-schema data
plane for longer than one session; the schema gate in `assertUsable` remains
the hard stop either way.

**Context.** The static export makes this cheap — every shell asset is a
static file — and no dependency is needed beyond a hand-rolled worker
(D-028/D-002 favor that over a PWA framework). COOP/COEP are already served
(D-030) and apply to SW-served responses identically; nginx needs no change.

**Consequences.** M5 carries the implementation and an offline *reopen* e2e
test (kill network, reopen the app, query the corpus). Criterion 5's claim
becomes fully testable. The diagnostics panel should surface the SW state,
since a broken SW is invisible by design (D-009 means users report it, not
telemetry).

**Reopen if.** The SW's cache-versioning interacts badly with the deploy model
(D-003 has no atomic promotion), or Safari/Firefox SW behavior under COOP/COEP
turns up a rough edge that outweighs the offline win on those browsers.

## D-047: The pipeline fails closed, generations are immutable, and the notice is canonical  (2026-08-01, status: accepted, extends D-008/D-041/D-042)

Three policies from the 2026-08-01 external review, each previously implicit
and each violated by the M1 code in a way tests now guard.

**Decision.**

1. **Fail closed on malformed records.** A record that cannot be parsed aborts
   the build (artifact deleted, nonzero exit) rather than being skipped with a
   warning. `--allow-skipped` exists for local debugging only and never runs
   in production. Rationale: a handful of silently dropped records sits far
   below the 0.1% tombstone guard and undercounts forever — the exact failure
   vision criterion 7 exists to prevent.
2. **Published generations are immutable.** `snapshot-<rev>/` chunks carry an
   immutable cache policy (D-034), so republishing a revision serves
   stale-vs-new mixes from caches, and the old delete-then-rename opened a 404
   window for clients mid-download. `publish.py` now refuses a same-rev
   republish; `--force` (local iteration only) swaps via rename with no
   window.
3. **One canonical notice string**, defined in `pipeline/build.py` and carried
   verbatim into the database `meta`, the manifest, deltas, the UI, and every
   export. D-008 requires MITRE's copyright designation and the license
   clause; the previous notice had neither — a trademark sentence and a
   paraphrase do not satisfy the terms. The canonical text reproduces, checked
   verbatim against cve.org's sources on 2026-08-01 (via the
   `CVEProject/cve-website` repo, RE-002's workaround): the footer's
   designation ("Copyright © 1999-<year>, The MITRE Corporation. CVE is a
   trademark and the CVE logo is a registered trademark of The MITRE
   Corporation.") and the Terms of Use "CVE Usage" clause in full, plus the
   AS-IS disclaimer.

**Consequences.** `pnpm check` now runs the Python pipeline tests
(`pipeline/tests/`), which regression-test the CVSS version-preference fix
(v3.1 had beaten v4.0 because stored version codes were compared numerically:
31 > 4) and assert the notice's required components; the e2e test asserts them
in the rendered UI. The license audit gained real SPDX `AND`/`OR` evaluation
(`MIT AND GPL-3.0` previously passed via any-term matching) and its exceptions
are bound to the exact license they were reviewed under. Changing the notice
text now requires touching D-008's requirements deliberately, with tests
failing until both move.

**Reopen if.** Upstream ships records that legitimately fail parsing at scale
(fail-closed then blocks all publishing and needs a quarantine-with-
reconciliation design), or the CVE Program changes its terms or designation —
which D-008 already flags for re-reading before launch.

## D-046: Tool-calling quality is measured in this repo and gates model selection  (2026-08-01, status: accepted)

**Decision.** The tool-calling benchmark lives in this repository, not in webai.
It is a fixed set of representative analyst questions, each with a hand-written
ground-truth result computed by SQL against the real corpus. The first two are
canonical here — other docs' paraphrases defer to this list: **item #1** is the
owner's founding question, a stacked count of CVEs by severity over time, all
products and per-product; **item #2** is the M4 exit-criterion variant, counts
by vendor, product, and severity over the last two years. A harness drives each candidate model through
the actual chat integration (our tool schemas, our system prompt, our SQLite
schema) in Playwright and scores by comparing the **data** the model's tool
calls produced — or the report definition it emitted — against ground truth.
No LLM judge. The scorecard (tool-call accuracy, turns needed, latency) is what
selects the local-model default and sets honest expectations per provider tier.

**Context.** webai (the sister project) proved in-browser model acquisition,
OPFS storage, multi-runtime inference, browser-managed Gemini Nano, and
structured-output testing — but its tool/function-calling harness was planned
(its M9+) and never built, and its own findings log notes tool-call token
coverage is unmeasured.
So nobody has measured whether a ~2–4B quantized model can reliably chain
"question → right tool → right arguments → grounded answer" over this schema —
and that is the make-or-break question for the local default (D-045). The owner
chose to measure it here (2026-08-01) because the results are specific to this
integration and are part of model selection, not a general runtime property.
D-044's report-definition design is what makes scoring cheap: outputs are
comparable data, not prose.

**Consequences.** Model selection becomes evidence (rule 3), not vibes: a model
enters the local shortlist by scoring, and if no local model scores acceptably,
the product ships with hosted-key and deterministic-UI paths while the local
tier waits for a model that passes. webai remains prior art for the
acquisition/runtime/OPFS plumbing — lifted as reference, not rebuilt blind.
The benchmark questions double as living documentation of what the chat layer
is supposed to handle.

**Reopen if.** webai lands a generic tool-calling harness that can host
external tool schemas and corpora, at which point running ours there might
avoid duplicate harness maintenance.

## D-045: Model providers — a local-first ladder with user-supplied keys, and no subscription OAuth  (2026-08-01, status: accepted, amends the consequences of D-009 and D-016; ladder re-ordered by D-057 — a site-hosted Ollama tier ships first, and "never proxied" now scopes to third-party traffic)

**Decision.** The chat layer (D-044) offers providers as an explicit ladder,
best-default first:

1. **Local model** — WASM/WebGPU inference in the browser, weights downloaded
   from Hugging Face into OPFS on explicit user action. Private and fully
   offline; the default.
2. **Chrome built-in Gemini Nano** via the Prompt API — no key, no multi-GB
   download, browser-managed; the zero-setup tier where available.
3. **Gemini API key** (Google AI Studio) — a free tier exists, and Google AI
   Pro/Ultra subscribers' quota attaches to their ordinary API key on Google's
   side, so "use your subscription" is just "paste your key".
4. **OpenRouter key** — one integration covering every hosted model.
5. **Direct Anthropic / OpenAI keys.**

Keys and provider choice are stored client-side only and never touch
`cve.meenan.dev`; all chat traffic flows browser → provider directly.
**Consumer-subscription OAuth passthrough is rejected permanently** for
providers that forbid it: Anthropic blocked Pro/Max subscription tokens in
third-party tools effective 2026-04-04 and made it a terms violation — building
around that risks our users' accounts, not just ours.

**Context.** Owner-stated (2026-08-01): default to a local in-browser model,
allow hosted models via user keys, and reuse existing consumer subscriptions
wherever genuinely permitted. Grounded per rule 4, checked 2026-08-01:

- **CORS from a browser origin, measured by preflight** (`OPTIONS` with
  `Origin: https://cve.meenan.dev`; methodology and its caveats in RE-010):
  OpenAI answered 200 echoing the origin in
  `access-control-allow-origin`; OpenRouter answered 204 with
  `allow-origin: *`. Anthropic documents browser use behind an explicit
  `anthropic-dangerous-direct-browser-access` opt-in header (our preflight got
  a 400 with partial CORS headers — re-verify in a real browser before
  building). Google's endpoint returned 403 with no CORS headers to a bare
  preflight, though its official JS SDK claims client-side support — verify
  before promising it.
- **Google subscription quota:** AI Studio is integrated into Google AI
  Pro/Ultra as of April 2026 — subscribers get paid models and higher limits on
  their account's API key, Ultra adds monthly Cloud credits
  (ai.google.dev/gemini-api/docs/google-ai-plans; 9to5google.com 2026-04-20;
  support.google.com/googleone/answer/16286513).
- **Anthropic subscription ban:** enforcement from January 2026, documentation
  2026-02-19, hard cutoff 2026-04-04; subscription OAuth is exclusively for
  Claude Code and Claude.ai (winbuzzer.com 2026-02-19; dev.to summary).
- OpenAI offers no subscription-to-API passthrough that we found; re-check when
  that adapter is built.
- **Gemini Nano:** integrated and verified in webai as its browser-managed
  acquisition path (webai README status, checked 2026-08-01). Availability is
  Chrome-gated and feature-detected, never UA-sniffed.

**Consequences.** The privacy claim gains one explicit, opt-in exception:
with a user-supplied key, the question and the tool results it triggers go to
that provider, by the user's own choice and account. The local default
preserves the full "never leaves your machine" claim — including offline —
and our server learns nothing in every tier (D-032 untouched; vision.md
amended accordingly). D-016's browser floor splits into tiers: the base app
keeps the D-016 floor, hosted-AI works anywhere modern with a key, and the
local tier is capability-gated on WebGPU and memory, not UA-sniffed.
Thread-using local runtimes (e.g. wllama) need COOP/COEP — already served on
`cve.meenan.dev` (D-030), and proven in production by webai on the same nginx;
the runtime itself is unchosen, an M8 outcome of the D-046 scorecard. Model
weights are downloaded by the user from Hugging Face, not redistributed by us,
so they are not dependencies under D-002 — but the shortlist's weight licenses
(e.g. Gemma's custom terms) get checked deliberately before a model is
recommended. In OPFS, weights are a rebuildable cache in the D-013 sense —
evictable and re-downloadable, never a user asset — and the M8 storage story
must guarantee a multi-gigabyte weight download can never evict the corpus.
Provider adapters are a thin abstraction: OpenRouter alone would cover
everything, so direct integrations exist only where they add something real
(Gemini's subscription quota, Anthropic/OpenAI first-party keys).

**Reopen if.** A provider changes CORS or subscription policy (this landscape
moved three times in the first half of 2026), a provider ships a *sanctioned*
OAuth flow for third-party browser apps, or WebGPU/WebNN availability shifts
enough to change the local tier's floor.

## D-044: An AI chat layer augments the deterministic UI, driving it through shared report definitions  (2026-08-01, status: accepted)

**Decision.** The product grows a free-form chat surface: an LLM translates
plain-language analyst questions into local queries and presents results. Four
commitments bound it:

- **Chat augments the deterministic UI; it never replaces it.** The filter,
  report, chart and SQL-console surfaces remain fully functional with no model
  configured, and are the fallback on any browser the AI tiers exclude.
- **One shared primitive.** The model's presentation tools emit the same
  serializable **report definition** the deterministic UI builds, renders, and
  shares (the vision-criterion-6 permalink object). The UI is the renderer and
  editor of report definitions; chat is a generator of them; sharing is
  serializing them. Every chart or list the chat produces is therefore
  inspectable, hand-editable, and reproducible without the model.
- **The model orchestrates; it never transcribes.** Aggregate results (small
  pivots) may enter the model's context so it can interpret trends; row-level
  result sets never do — they are returned as handles and rendered directly
  from SQLite by the fixed UI components. Every number a user sees came from a
  query, not from token sampling.
- **The tool surface is read-only and render-only, permanently.** Curated
  high-level tools (search, filter + aggregate, CVE detail, KEV lookup) with
  tight schemas for small models, plus a `SELECT`-only, row-capped, timed-out
  SQL tool for capable models — enforced structurally, by a read-only
  connection or SQLite authorizer, never by inspecting query text. No tool may
  fetch a URL, write data, or reach the network — CVE records are
  attacker-influenced text (rule 5) now flowing into a model's prompt, so
  injection is assumed and its blast radius is bounded to wrong-but-inspectable
  presentation. Report definitions carry structured data only: no
  model-authored HTML, markdown, or URLs; chat prose renders as plain text,
  and record URLs surface only through the fixed UI's existing
  never-auto-fetched treatment.

**Context.** Owner pivot, discussed and settled 2026-08-01. The motivating gap:
vision.md's audience includes "anyone with a CVE question that a keyword search
box cannot answer," but the answer path was SQL or a report builder. The
owner's own founding question — severity-over-time trends, per-product —
is exactly the shape an LLM translates well and a spreadsheet-less user cannot
write. The pivot strengthens rather than bends the constraint set: with the
local default (D-045) the model itself obeys "the data plane is client-side"
(D-007), and the chat path never touches our server, so D-014/D-032 hold
trivially.

**Consequences.** The report definition becomes an internal contract shared by
three features and must be designed as one (M4's shape work gains a consumer).
Vision criterion 7 survives the LLM: answers are auditable because the queries
behind them are exposed and re-runnable, and the model cannot show a number the
deterministic path could not reproduce. Benchmarking (D-046) gets cheap scoring
for free — compare emitted definitions or their result data against ground
truth. The AI layer is additive: every piece of it sits above the M1–M4 core,
which is unchanged.

**Reopen if.** Report definitions prove too rigid for what models usefully
emit (forcing a parallel presentation path), or measured tool-calling quality
(D-046) is unusable even for frontier hosted models — which would demote chat
from product pillar to experiment.

## D-043: The ingest pipeline is Python 3.12, standard library only  (2026-08-01, status: accepted, extends D-017)

**Decision.** Everything server-side — fetch, hash, normalize, chunk, publish —
is Python 3.12 using only the standard library, plus the `git` and `brotli`
binaries already installed. It lives in `pipeline/` in the repo and is *not*
part of the `dist/` rsync (D-003). The browser application stays TypeScript
(D-017, D-027).

**Context.** D-017 settled the app toolchain and D-027 revised it, but neither
covered the pipeline — it did not exist yet. It now does, in the form of the M0
spike scripts, and D-042 turns it into a cron job someone has to maintain.

Python wins on evidence rather than preference: every M0 measurement was
produced by these scripts, so the parse-and-normalize path is already proven
against the real corpus at 15–18 s for 372,092 records. `json`, `sqlite3`,
`hashlib` and `pathlib` cover the entire job with no dependencies to audit
(D-002) or update. Python 3.12.3 is present on `plex` and locally.

The counter-argument is one language across the repo, and it is real but weak
here: the pipeline shares no code with the browser, runs in a different place,
on a different schedule, against a different data model. TypeScript would mean
installing Node on the server purely to run cron.

**Consequences.** Two languages, and the boundary between them is the published
contract in `manifest.json` — which is also the boundary a test can hold. The
schema exists in both worlds, so the DDL needs a single source of truth: it
lives in `pipeline/schema.sql`, is executed by the builder, and is what the
client asserts against after import.

`sqlite3` in the standard library is dynamically linked against the system
SQLite, which on `plex` is 3.45.1 — older than the `@sqlite.org/sqlite-wasm`
build the browser will use. That asymmetry is fine for the file format, which is
stable, but it means FTS5 behavior must be verified on the browser's version and
not inferred from the server's (RE-005 already carries this warning).

`pipeline/` must be excluded from the deploy: D-003 mirrors `dist/` into the
docroot, and the pipeline has no business being web-reachable.

**Reopen if.** The pipeline grows a dependency that Python makes awkward, or the
schema starts drifting between the two languages despite the single DDL file.

## D-042: The pipeline is a daily cron ingest with a monthly snapshot  (2026-08-01, status: accepted, supersedes the cadence half of D-026; the daily job's timing and output size are re-measured in D-058 — 54.9 s per run, and ~291 records/~70 KB per day over a weekend window rather than the ~665/87 KB estimated here; the monthly job and its retention are implemented and measured in D-060, where "rebuild" turns out to be the build the daily already did)

**Decision.** Two scheduled jobs under `flock`, no daemon:

- **Daily** — `git fetch`, hash, diff, guard, rebuild, publish one delta file.
  ~40 s of work for ~87 KB of output.
- **Monthly** — rebuild the database, chunk it, compress the chunks in parallel,
  publish, then retire the previous generation.

Retention: the current snapshot's chunks, the **previous** snapshot's chunks,
and every delta back to the older of the two. A generation is not deleted the
moment its successor appears — a client that read the manifest ten minutes ago
and is mid-download must not start getting 404s. One extra generation costs
63 MB.

**Context.** Both cadences chosen by the project owner 2026-08-01: *"a cron job
of some kind that does the git sync periodically (daily is probably good enough),
builds the delta files and once a month re-generates the full download."* D-026
had assumed hourly ingest and weekly snapshots.

Daily is comfortable on the measurements. Upstream publishes about every 40
minutes, so a day accumulates ~665 distinct changed records — **87 KB
compressed**, one file. A month of catch-up is ~31 files and ~2.6 MB against a
62.6 MB snapshot, so a user arriving the day before a rebuild downloads about 4%
more than one arriving the day after.

**Consequences.** Daily ingest deletes the most fragile thing in the delivery
design. D-032 required delta files to *tile the revision space contiguously* and
introduced hourly-to-daily rollups to keep a week's catch-up from being 168
requests; that was the one correctness burden the static design added, and the
one thing flagged as needing a property test. **At one run per day there is
nothing to roll up.** Delta files are consecutive by construction — `<rev-1>` to
`<rev>`, one per day — so tiling is a property of the loop rather than an
invariant to defend.

What the jobs owe in return:

- **`flock` on a lockfile**, so a monthly snapshot cannot overlap the next
  daily ingest.
- **Publish only after the rebuild succeeds**, by atomic rename, so a failed run
  leaves the previous generation serving.
- **The tombstone guard runs before anything is published** (D-031). A run that
  would delete more than 0.1% of the corpus aborts, and aborting is the success
  case — it means the fetch broke, not that the CVE Program withdrew 400 records.
- **Staleness is reported through `manifest.json`'s `generated` field**, not
  through an operational status file. The client already surfaces it; the server
  does not need a second channel, and D-009 means it must not become one.

The cost of daily rather than hourly is up to 24 hours of staleness. That is the
owner's call and it is visible in the UI by design, so a user who needs today's
disclosures knows they do not have them.

**Reopen if.** Upstream volume grows enough that a day's delta stops being one
small file, or someone actually needs sub-day freshness — in which case hourly
ingest returns *and brings the rollup requirement back with it*, which is the
real cost of that change.

## D-041: The snapshot ships as independently-compressed 32 MB chunks  (2026-08-01, status: accepted, refines D-040; the concurrency it left open is settled by D-049)

**Decision.** The snapshot is split into **32 MB slices of the uncompressed
database**, each compressed separately at brotli -q10 into its own file of
roughly 5.3 MB. Twelve files today. The client fetches them, decompresses each
in WASM, and writes the result straight into the OPFS database file at that
chunk's byte offset — never holding the database in memory. Range requests are
not the resumption mechanism.

**Context.** The owner asked whether to chunk at ~5 MB or rely on range
requests, and separately settled the memory question: *"We should stream chunk
by chunk to OPFS. There's no reason to hold everything in memory."* Measured on
the 391.3 MB artifact, compressing chunks 24-way in parallel:

| Uncompressed chunk | Files | Total | Versus monolith | Wall clock |
| --- | --- | --- | --- | --- |
| monolith | 1 | 62.6 MB | — | 351 s (single-threaded) |
| 64 MB | 6 | 62.9 MB | +0.5% | 140 s |
| **32 MB** | **12** | **63.3 MB** | **+1.1%** | **101 s** |
| 16 MB | 24 | 65.6 MB | +4.8% | 66 s |
| 8 MB | 47 | 66.7 MB | +6.5% | 36 s |

Brotli's largest standard window is 16 MB (`lgwin` 24), so chunks above that
size cannot lose backward references the monolith would have used. The residual
cost is cold-start: each chunk begins with an empty context, and at 8 MB there
are 47 cold starts to pay for. 32 MB is where the curve flattens — 0.7 MB for
twelve independent pieces — and it happens to land at almost exactly the ~5 MB
compressed size the owner guessed at.

**The decisive argument is not size, though — it is that brotli is a stream
format.** A range-resumed monolith gives you compressed bytes from an arbitrary
offset, which a decoder cannot use without the state that produced them. Resume
would mean either re-decompressing from byte zero or persisting the compressed
stream alongside the database, doubling storage. Independently-compressed chunks
make resumption a bitmap: which chunks are written. Nothing else needs
remembering.

Four more things follow from it:

- **Positional writes.** Chunk *k* covers decompressed bytes
  `[k·32 MiB, (k+1)·32 MiB)`, so `FileSystemSyncAccessHandle.write(buf, {at})`
  places it directly and chunks may be fetched in parallel or out of order.
- **Integrity gets granular.** Each chunk carries its own SHA-256 in the
  manifest, so corruption costs one 5 MB refetch rather than the whole download.
- **No dependence on edge range behavior.** Cloudflare must cache a full object
  before it can slice ranges from it; twelve small immutable objects sidestep
  the question entirely.
- **Compression parallelizes.** 101 s across 24 cores against 351 s
  single-threaded — which matters for D-042's monthly rebuild.

**Consequences.** The import path is fetch → decompress → positional write, with
peak memory bounded by one chunk in flight rather than by the corpus. The
"resumable download" feature is now a property of the format instead of a
feature to implement.

Chunk size is a published constant, not an inference: the manifest states each
chunk's offset and length, so changing 32 MB later is a manifest change rather
than a protocol change. Deltas are unaffected — they are single files, small
enough that chunking would be noise.

**Reopen if.** Q-003 finds that twelve concurrent decompressions strain memory
on a modest device — in which case the fix is a concurrency limit, not a
different chunk size.

## D-040: Compressed artifacts are decompressed in the client, not by `Content-Encoding`  (2026-08-01, status: accepted, supersedes the transport half of D-026 and D-034)

**Decision.** Snapshots and deltas are published as opaque `.br` files with no
`Content-Encoding` header, and the client decompresses them with a WASM brotli
decoder. `brotli_static` is not used and the uncompressed twin is not published.

Dependency: **`brotli-dec-wasm` 2.3.2, MIT OR Apache-2.0** (verified from the
package's own npm metadata, 2026-08-01), ~200 KB, decode-only. Preferred over
`brotli-wasm` 3.0.1 (Apache-2.0, also acceptable under D-002) because we never
compress in the browser and the smaller decode-only build is the honest
dependency.

**Context.** Stated by the project owner 2026-08-01: *"It would probably be
worthwhile to do our own client-side brotli decompression … That way we are
fully in control (and we can easily do it in wasm)."*

The reasoning holds up on several axes at once, which is unusual:

- **Progress reporting becomes honest.** With transparent `Content-Encoding`,
  `Content-Length` is the compressed size while `fetch` hands you decompressed
  chunks, so a progress bar is measuring one thing against another. Opaque bytes
  make both sides compressed and the arithmetic exact — which matters more now
  that the same progress bar also covers index building (D-039).
- **Range resume becomes exact.** Byte offsets into an opaque file are stable
  and meaningful; offsets into a transparently-decoded stream are not.
- **No intermediary can re-encode.** A proxy or CDN cannot decide to
  re-compress, double-encode, or strip the encoding on a file that never claims
  one. This also removes the `Vary: Accept-Encoding` dimension from caching.
- **`DecompressionStream`'s gzip/deflate-only limitation stops mattering.** It
  was the reason brotli had to arrive via `Content-Encoding` at all.
- **Half the disk.** Publishing only `.br` drops the 391 MB uncompressed twin
  that `brotli_static` required.

**Consequences.** D-030's `brotli_static on;` is no longer needed for the data
plane — it may still be worth enabling for ordinary site assets, but it is not
load-bearing. The `.br` files are served as `application/octet-stream` with
`Cache-Control: public, immutable` and nothing else.

The client's import path gains a stage: fetch → decompress (WASM) → write to
OPFS → build indexes. That is three passes over ~390 MB rather than two, and
whether it should stream chunk-by-chunk into OPFS or materialize in memory first
is a real question with a memory ceiling attached — it belongs to Q-003 in M1.

`manifest.json` stays uncompressed: it is small, it must be readable without the
decoder loaded, and it is the file that tells the client what to fetch.

**Reopen if.** The WASM decoder turns out to be materially slower than the
browser's native brotli path, in which case the tradeoff is control versus speed
and wants a measurement, not an argument.

## D-039: Cloudflare honors origin cache headers; there is no origin rate limiting  (2026-08-01, status: accepted, supersedes the rate-limiting half of D-034 and D-037; **premise unverified in production** — as of the first deploy, 2026-08-01, `cve.meenan.dev` is not proxied through Cloudflare, so nothing is absorbing abuse and nothing is applying these rules. M5 owns closing that before launch.)

**Decision.** No `limit_conn`, no `limit_req`, and no `limit_rate` at the origin.
Cloudflare absorbs abuse if it ever materializes. Caching is driven entirely by
the `Cache-Control` headers nginx already sends, using Cache Rules configured to
respect them rather than Cloudflare's extension-based defaults.

Per the Cloudflare documentation (verified 2026-08-01), the settings are: **Edge
TTL** → *"Use cache-control header if present, use default Cloudflare caching
behavior if not"*, and **Browser TTL** → *"Respect origin"*, with the rule
marked eligible for cache so that `.sqlite`, `.br` and `.json` are cached
despite not being in the default extension list.

**Context.** Stated by the project owner 2026-08-01: *"There is no need to do
origin-level rate-limiting on clients. We can have cloudflare absorb that if it
becomes a problem. We just need the assets to be cacheable"* and *"cloudflare
has a cache mode to honor HTTP standards-based caching instead of their own
layer of extension logic so we are fully in control."*

This retires the most fragile part of D-034. Per-IP limits behind a proxy were
already a footgun (D-037 item 1) requiring `set_real_ip_from` and
`CF-Connecting-IP` to be correct at all; removing them removes the footgun
rather than defusing it. Origin cache headers as the single source of truth also
means the caching policy lives in the same place as everything else about the
artifacts, instead of being split between nginx and a dashboard.

**Consequences.** D-034 shrinks to: one `^~ /data/` location with a trailing-slash
`alias`, `autoindex off`, no CORS headers, correct `Cache-Control` per file kind,
and integrity hashes in the manifest. That is the whole of the hardening story.

One clarification worth recording, because the owner's phrasing — *"then it's
just the delta API calls"* — suggests a shape the design does not have: **there
are no delta API calls.** Under D-032 deltas are static files named by revision
range, so they cache exactly like the snapshot and there is nothing dynamic left
to protect. If a dynamic endpoint is ever introduced, D-006 and every question
D-034 declined to answer come back with it.

The 512 MB Cloudflare object ceiling (D-037) becomes comfortable rather than
close: D-040 publishes only the compressed artifact, 62.6 MB.

**Reopen if.** Abuse actually materializes and Cloudflare's controls prove
insufficient, or the site moves off Cloudflare — in which case origin limits
return, with the real-IP caveat.

## D-038: The full corpus ships; year partitioning is dropped  (2026-08-01, status: accepted, supersedes D-036)

**Decision.** No year partitions, no default window, no backfill. Every client
downloads the whole corpus, as D-025 established. The download is **62.6 MB at
brotli -q10** (391.3 MB uncompressed) — the full corpus with no shipped index,
per D-035.

**Context.** Decided by the project owner 2026-08-01: *"I don't think the
savings is enough to justify the complexity — full download holds."*

The measurements support it. D-036 would have saved 24.6 MB on a first download
(38.0 MB against 62.6 MB) in exchange for coverage becoming a thing the product
has to reason about everywhere. Most of the win the owner was originally after
came from D-035 instead — dropping the shipped index took 95.4 MB to 62.6 MB
with no correctness cost at all. Partitioning was the expensive third of a
saving that was mostly already banked.

**Consequences.** Everything D-036 introduced is withdrawn, and the withdrawal
is the point:

- **Vision criterion 7 is structural again.** The client either holds the whole
  corpus or has not downloaded it. No coverage window on aggregates, no
  boundary on charts, no "your query reaches past your data" path, no backfill
  flow, no earliest-year scalar to display and test.
- **D-031's lookup rule stands unamended.** D-036 required deltas to carry every
  lookup row their upserts referenced, because a partial client could have
  pruned an older one. With full coverage the client has every lookup row, so
  revision-selected lookups are sufficient again — and the estimated cost D-036
  left for M2 to measure evaporates rather than needing measuring.
- **The snapshot is one file again**, which keeps the delta-tiling invariant as
  the only correctness burden in the delivery path.

**Reopen if.** The corpus grows enough that a first download becomes a real
barrier — at current rates roughly 45,000 records a year, or ~7 MB compressed
annually, so this is a question for several years from now, not this one.

## D-037: Cloudflare fronts the data plane  (2026-08-01, status: accepted; rate-limiting half superseded by D-039)

**Decision.** Cloudflare caching is enabled in front of `cve.meenan.dev`, which
retires bandwidth as a design constraint. Two changes to D-034 follow, both
mandatory rather than optional.

1. **Remove the per-IP `limit_conn` from the `/data/` location**, or pair it with
   `set_real_ip_from` plus `CF-Connecting-IP`. Behind a proxy,
   `$binary_remote_addr` is *Cloudflare's* address, so a four-connection limit
   would bucket the entire internet into a handful of edge IPs and throttle
   legitimate traffic. This is the footgun, not the rate limit itself.
2. **Add explicit Cache Rules for `/data/*`.** Cloudflare caches by file
   extension and, per its documentation (verified 2026-08-01), *"does not cache
   HTML or JSON by default."* Neither `.json`, `.br`, nor `.sqlite` is in the
   default extension list — so simply proxying would cache none of our
   artifacts. Deltas and snapshots need a rule with a long edge TTL, and
   `manifest.json` needs one that bypasses.

**Context.** Offered by the project owner 2026-08-01: *"I can turn on cloudflare
caching so the bandwidth won't be a problem."*

**Consequences.** D-034's `limit_rate` and immutable cache headers still earn
their place — they apply to origin misses and to anyone hitting the origin
directly — but bandwidth stops being a reason to constrain the artifact's size.
Same-origin enforcement is unaffected: it is the absence of CORS headers, and
Cloudflare forwards that faithfully.

One ceiling to watch: **Free, Pro and Business plans cap a cacheable object at
512 MB** (Enterprise 5 GB), verified 2026-08-01. The uncompressed snapshot is
391 MB today. It is served precompressed in practice, but a schema addition that
pushes the plain file past 512 MB would silently stop being cached rather than
fail loudly — worth an assertion in the publish step.

**Reopen if.** The site moves off Cloudflare, or a plan change alters the object
ceiling.

## D-036: The download is partitioned by year, defaulting to the last five  (2026-08-01, status: **superseded by D-038**)

**Decision.** The snapshot is published as year partitions rather than one file.
The default download is **2022 onward**; older years are fetched on demand as
backfill. The client records the earliest year it holds, and that single number
is the coverage invariant.

**Context.** Proposed by the project owner 2026-08-01, who asked the right
prior question: has recent volume grown enough that newer years are the bulk
anyway? **No — measured, they are about half.**

| Window | Records | Share | Database | brotli -q5 |
| --- | --- | --- | --- | --- |
| 2022+ (5 years) | 182,182 | 48.9% | 225.3 MB | 46.9 MB |
| 2021+ (6 years) | 205,619 | 55.2% | 247.5 MB | 51.4 MB |
| 2017+ (10 years) | 279,217 | 75.0% | 308.4 MB | 62.7 MB |
| all years | 372,322 | 100% | 391.3 MB | 77.9 MB |
| backfill ≤2021 | 190,140 | 51.1% | 166.6 MB | 31.1 MB |

Recent records are individually *larger* — richer references, version ranges and
descriptions — so five years is 48.9% of records but 60% of the compressed
bytes. The window saves less than record counts suggest, and it still saves 40%.

Combined with D-035, the default download measures **38.0 MB at brotli -q10**,
against 95.4 MB for the whole corpus with a shipped index (D-033). The complete
backfilled corpus is 62.6 MB.

**Consequences.** This is the one place the project deliberately takes back
something D-025 bought: the client no longer necessarily holds everything, so
vision criterion 7 — results are never quietly wrong — stops being purely
structural. That is acceptable *only* because the coverage state is a single
scalar rather than the field-and-partition matrix D-025 rejected. It is
testable, explainable in one sentence, and cheap to display.

The obligations that follow are functional requirements, not polish:

- Every aggregate, chart and export states the window it covers.
- A query with an explicit date range reaching past the window says so and
  offers the backfill, rather than returning a confident short answer.
- Charts render the boundary, so a trend line does not appear to begin in 2022.

Two protocol consequences:

- **Deltas must carry every lookup row their upserts reference, not just rows
  created since the client's watermark.** This amends D-031's range-query rule.
  A 2026 record can newly cite a vendor first interned in 2015, which a
  five-year client pruned away; selecting lookups by revision would leave a
  dangling reference. Shipping referenced rows with `INSERT OR IGNORE` keeps the
  server parameterless (D-032) and correct for any window. The added cost is
  lookup rows only — the record's own text ships regardless — and is *estimated*
  in the low tens of KB per delta. Measure it in M2 rather than trusting this
  estimate.
- **The client filters delta upserts to its own window**, and after a backfill
  re-applies the retained deltas for the newly added years. Apply is idempotent
  (D-031), so re-application needs no bookkeeping.

**Reopen if.** The coverage window starts showing up as a source of confusing
results despite the display obligations above — in which case the honest fix is
to default to the whole corpus, which after D-035 costs 62.6 MB rather than the
95.4 MB that made partitioning attractive.

## D-035: Full-text indexes are built in the browser and cover descriptions, vendors and products  (2026-08-01, status: accepted, supersedes the FTS half of D-011 and D-033)

**Decision.** No FTS index is shipped. The client builds its indexes after
import, over **descriptions, vendor names and product names**. References are
not indexed in any form — neither URLs nor names — and D-033's host interning
remains the way to filter by reference source.

**Context.** Two owner decisions on 2026-08-01, measured the same day.

On coverage: *"We should only FTS over descriptions, vendors and products — the
references will pollute the results."* This confirms and extends D-033's
amendment of D-011. The pollution argument is the decisive one and is better
than the cost argument D-033 made: FTS5's default tokenizer shreds a URL into
path segments, so every reference URL injects host names, vendor slugs, ticket
IDs and file names into the same term space as the prose. A search for a product
name would match any advisory URL containing it.

On placement: shipping the index costs far more than building it.

| Artifact | Database | brotli -q5 |
| --- | --- | --- |
| All years, FTS over descriptions shipped (D-033) | 452.5 MB | 113.0 MB |
| All years, **no FTS shipped** | 391.3 MB | **77.9 MB** |
| All years, FTS over descriptions + vendor + product shipped | 455.4 MB | 114.2 MB |

**Dropping the index saves 35.1 MB compressed — 31%** — because an inverted
index is already entropy-dense and compresses at about 1.7× where the rest of
the database compresses at 5×. It is the single most expensive thing per byte
that we were shipping. Adding vendor and product to the index costs 1.2 MB
shipped and nothing at all when built locally.

**Consequences.** The client builds each index once after import and maintains
it incrementally thereafter, exactly as D-031's delta apply already does. The
initial build walks the content table's rowid space in batches inside one
transaction per index. That is equivalent to fts5's opaque `'rebuild'` command,
but exposes countable progress through the minute-long browser build (D-052) at
about 1% measured cost. Delta application is unchanged.

The cost moves from bandwidth to first-run CPU, and **that cost is unmeasured in
a browser**. Native SQLite rebuilt the description index in 3 s; WASM writing
~61 MB of index pages through OPFS could be far slower. This is now the most
important thing Q-003 measures in M1. If it turns out bad, the fallback is
narrow and known: ship the index for the default year window only, at 35.1 MB
compressed for all years and proportionally less for five.

Because the index is derived rather than delivered, it also stops being part of
the integrity contract — a corrupted index is rebuilt locally, not
re-downloaded. Verification still uses `integrity-check` at `rank = 1` (RE-005).

**Reopen if.** M1 measures the in-browser rebuild as slow enough to hurt first
run, or a confirmed feature needs full-text over something these three fields do
not cover.

## D-034: Data-plane hardening is nginx configuration, and same-origin means no CORS headers  (2026-07-31, status: accepted; rate limiting removed by D-039, brotli transport replaced by D-040)

**Decision.** With no request handler in the data path (D-032), every control is
server configuration. Six of them, plus one explicit refusal.

1. **One serving location, both paths ending in `/`.**

   ```nginx
   location ^~ /data/ {
       alias /var/www/meenan.dev/cve.data/pub/;
       autoindex off;
       brotli_static on;
       limit_conn cvedata 4;
       limit_rate_after 16m;
       limit_rate 25m;
   }
   ```

   `^~` matters: without it the existing `location ~* \.(js|css|…)$` regex block
   can win over a prefix match and apply the wrong cache policy.

2. **`pub/` contains only finished artifacts.** The clone, the working
   databases, and the ingest hash state stay in sibling directories under
   `cve.data/` (D-018) and are never reachable. Publication is an atomic rename
   into `pub/`, so a half-written artifact is never served.

3. **Same-origin enforcement is the absence of CORS headers.** No
   `Access-Control-Allow-Origin` on anything under `/data/`. That is what
   actually stops another origin's JavaScript from using this server as its
   backend, and it is the correct reading of the owner's requirement that the
   data "only works same-origin from the browser."

4. **Bandwidth is the only real exposure, so bandwidth is what is limited.**
   `limit_conn_zone $binary_remote_addr zone=cvedata:10m;` in `http`, four
   concurrent connections per address, and a rate cap that starts after the
   first 16 MB so small delta fetches are never throttled.

5. **Cache policy by kind.** Snapshots and deltas are immutable and get
   `expires max` with `Cache-Control: public, immutable`; `manifest.json` gets
   `no-cache`. This also closes the D-030 gap where `expires max` covered only
   `js|css|png|…` and would have missed the artifacts entirely.

6. **Integrity travels in the manifest.** Every file is listed with its byte
   length and SHA-256, and the client verifies after download. This is the
   confirmed "corpus integrity check" feature and the answer to a truncated
   transfer.

**Rejected: blocking on `Sec-Fetch-Site` or `Origin`.** It was the obvious
reading of "locked down to same-origin browser callers," and it is security
theater here. Any non-browser client omits the header or sets it to whatever it
likes, so it stops nobody who matters; meanwhile it breaks `curl`, breaks direct
download links, and would make the artifacts unverifiable by anyone auditing our
privacy claim. The requirement it was meant to satisfy is met properly by item 3.

**Context.** Read from `plex` 2026-07-31. There are no `limit_req`, `limit_conn`,
`limit_rate`, `map`, or `alias` directives anywhere in the current configuration,
so all of the above is additive. nginx workers run as `pmeenan` (as does
php-fpm, D-030), so the `alias` needs no permission work. Disk is not a
constraint: 1.1 TB free.

**Consequences.** The nginx changes M1 needs are now three: `brotli_static on;`,
`trailingSlash: true` in Next (D-030), and this location block with its
`limit_conn_zone`. `brotli_static` requires **both** the plain and `.br` file
present in `pub/` — it serves the `.br` only to clients that ask for it and
falls back otherwise. That costs disk (a 452 MB database beside its 95 MB
compressed form) and was chosen over publishing only `.br` with a hand-set
`Content-Encoding`, which is smaller but breaks any client that does not accept
brotli and forces per-file `Content-Type` overrides.

One trap is worth naming because it is the classic nginx `alias` vulnerability:
if the location is written `location /data` without the trailing slash while the
alias has one, `/data../` escapes the intended directory. Both must end in `/`,
and the location must not use a regex capture in the alias path.

The php-fpm privilege breadth D-030 flagged is not fixed here — it is dormant,
because no PHP runs in the data path. It becomes live again the moment a handler
is added, which is one more reason not to add one.

**Reopen if.** Bandwidth costs become real, in which case the answer is a CDN or
a signed-URL scheme, both of which change more than this entry; or a dynamic
endpoint is introduced, which restores every question this entry declined to
answer.

## D-033: Schema completeness — version ranges and references in, five sections out  (2026-07-31, status: accepted, answers Q-002, amends D-011)

**Decision.** Beyond the D-024 floor the published schema adds three things and
declines five.

**In:**

- **Affected version ranges** — `cve_ver(cve_id, product_id, status, version,
  lt, lte, vtype)`. Present on 95.0% of records.
- **References, as interned URLs** — `url(id, url, host_id)` and
  `cve_ref(cve_id, url_id)`. Present on 95.1% of records.
- **Reference hosts, interned** — `host(id, name)`, 18,986 distinct. This is
  what makes "which CVEs cite this advisory source" a real filter.

**Out:** FTS5 over reference URLs and names; reference display names; reference
tags; CPE applicability; solutions, workarounds, configurations and exploits;
credits; timeline.

Two schema rules fall out of the measurement and apply everywhere:

- **Build-only `UNIQUE` constraints are dropped from the published artifact.**
  Interning happens once, on the server. `url TEXT UNIQUE` cost **59.7 MB** — a
  second full copy of every URL — to support a lookup the client never performs.
  The same applies to `product`. `cve.cve_id` keeps its unique index, because
  the client genuinely looks records up by ID.
- **Link tables are `WITHOUT ROWID`** on their natural primary key. `cve_ref_tag`
  as an ordinary rowid table with two indexes cost 148 MB; the same data as a
  `WITHOUT ROWID` table cost 33 MB.

**Context.** Priced by building the whole candidate schema against the full
corpus and compressing each cumulative variant, because the only cost that
matters is download bytes. Prevalence came from a 20,000-record sample.

| Cumulative variant | Database | brotli -q5 |
| --- | --- | --- |
| Floor (D-024) | 271.4 MB | **75.6 MB** |
| + version ranges | 338.4 MB | 90.0 MB |
| + references (URLs + links) | 441.4 MB | 111.0 MB |
| **+ interned hosts — the decision** | **452.5 MB** | **113.0 MB** |
| *(alternative)* + FTS over URLs instead of hosts | 482.7 MB | 126.6 MB |
| + reference names | 474.6 MB | 119.2 MB |
| + FTS over reference names | 489.8 MB | 124.7 MB |
| + reference tags | 515.2 MB | 132.0 MB |
| + CPE, remedies, credits, timeline | 532.1 MB | 135.5 MB |

Prevalence, which is what decided the five exclusions:

| Section | Records carrying it |
| --- | --- |
| references | 95.1% |
| version ranges | 95.0% |
| credits | 20.1% |
| timeline | 7.1% |
| solutions | 4.5% |
| **CPE** | **2.2%** |
| exploits / workarounds / configurations | 1.3% / 1.2% / 0.3% |

**CPE is excluded on correctness, not size** — it costs almost nothing. A filter
that matches 2.2% of the corpus looks like a working filter and behaves like a
broken one: every query through it silently discards 97.8% of the data. That is
vision criterion 7's failure mode dressed as a feature. If CPE coverage improves
materially upstream, reopen.

Credits, timeline, solutions, workarounds and exploits are excluded on value per
byte: they are per-record prose that no aggregate or filter in confirmed scope
consumes, and at 1–20% prevalence they cannot support one.

**This amends D-011**, which confirmed "full FTS5 over descriptions *and*
references" during triage. Descriptions keep their index. References do not, for
two reasons. Cost: 13.6 MB compressed for URLs, 5.5 MB more for names, against
2.0 MB for interning hosts. And precision: FTS5's default tokenizer splits a URL
into path segments, so searching `github` matches any URL with `github`
anywhere, while the question people actually ask — "references from this source"
— is a host predicate that host interning answers exactly. The owner chose the
D-011 wording, so this is flagged as an amendment rather than an implementation
detail; reversing it costs the 13.6 MB above and is a one-line schema change.

**Consequences.** The published artifact is **95.4 MB at brotli -q10**, measured,
up from ~72 MB for the floor — **a 32% increase in what every user downloads**,
in exchange for the two axes with near-universal coverage. Compression took
416 s, consistent with D-026's sizing of a weekly rebuild.

Nothing here changes the delta protocol's character (D-031): references and
versions are ordinary dependent rows, deleted and reinserted with the record,
and both need an index on `cve_id` for that — `cve_ref`'s primary key provides
it, `cve_ver` needs `i13` explicitly, exactly as `cve_cwe` did.

**Reopen if.** CPE coverage rises materially upstream; a confirmed report needs
one of the excluded sections; or browser measurement (Q-003) shows 95 MB is over
budget, in which case the cheapest 23 MB to give back is references, and the
D-024 hybrid — structured first, text later — is the next lever after that.

## D-032: The whole data plane is static files — the sync path has no dynamic endpoint  (2026-07-31, status: accepted, amends D-006; D-057 later adds the first dynamic endpoint *outside* the data plane — the chat relay — while the sync path stays static)

**Decision.** Everything the browser fetches is a static file served by nginx: the
snapshot, the manifest, every delta, and the KEV catalog. The client sends no
parameters at all. D-031's fixed delta granularity is what makes this possible —
the delta a client needs is *named* by its revision range, so it can be
pre-built rather than computed per request.

Layout under `cve.data/pub/`, exposed read-only through one nginx `alias`:

```
manifest.json                       # small, no-cache; lists everything below
snapshot-<rev>.sqlite.br            # immutable, ~72 MB
deltas/<from>-<to>.json.br          # immutable, hourly files + daily rollups
kev.json                            # D-010, refreshed on its own cadence
```

The client reads `manifest.json`, compares `schema` and its local watermark,
then fetches a greedy longest-first chain of delta files — preferring a daily
rollup over the hourly files it covers. Retention follows D-026: files are kept
back to the current snapshot and no further.

**Context.** D-006 fixed "exactly one server endpoint," written when the design
still assumed a request handler that took caller-supplied fields and partitions.
D-025 removed the parameters, and D-031 removed the last one — a delta is
identified by a revision range that the server already knows, so nothing needs
computing at request time.

**Consequences.** This *strengthens* D-006 rather than relaxing it. D-006's
requirement is that the endpoint never accept a caller-supplied path or ref that
reaches the filesystem; the strongest possible compliance is having no request
handler in the data path at all. It also makes D-014 vacuous in the sync path:
the server cannot learn a predicate from a request that carries no fields.

Concretely bought:

- **No injection surface.** No parameter parsing, no path assembly, no PHP in
  the hot path. Q-005's hardening question shrinks to nginx configuration.
- **Resumable and cacheable for free.** Immutable files get `expires max` and
  ordinary HTTP range requests, which is most of what the resumable-download
  feature needs (D-026 already noted this for the snapshot; it now covers
  deltas too).
- **No server-side cache to invalidate.** Files are built once by the pipeline
  and never rewritten — new revisions mean new filenames.

Costs and obligations:

- **Complexity moves into the build pipeline**, which is ours and is not
  attacker-facing. That is the right direction, but the rollup logic must
  guarantee the delta files *tile the revision space contiguously*, or a client
  at some watermark finds no chain. This is the one correctness burden the
  design adds, and it belongs in M2's tests.
- **Three nginx changes now, not two.** D-030's `brotli_static on;` and
  `trailingSlash: true`, plus an `alias` exposing `cve.data/pub/` read-only.
  The alias is required regardless: D-003's rsync mirrors `dist/` into the
  docroot, so served data cannot live there.
- **Rate limiting becomes an nginx concern** (`limit_conn`, `limit_rate`) rather
  than application code. Bandwidth, not compute, is the exposure — the snapshot
  is 72 MB.

PHP is not banned by this; it is simply unused so far. Any future need for it
returns to D-006's rules in full.

**Reopen if.** A confirmed feature genuinely needs a computed response — at
which point the question is whether it can be pre-built into a named file
instead, and only then whether it needs a handler.

## D-031: The delta protocol — content-hash revisions, whole records, merged by range  (2026-07-31, status: accepted, answers Q-001; **the hash pass is no longer "effectively free"** — D-058 makes it a *second* walk, ahead of the build rather than inside it, measured at 16.9 s and about a third of a run)

**Decision.** Six parts, each measured against a real 21.4-hour upstream window
on 2026-07-31 (`a42a2eb6c2` → `d300c5fcc0`).

1. **The watermark is a server-assigned revision number.** A monotonic integer
   `rev`, incremented once per ingest run that produced any change. Not a
   publisher timestamp, not a git SHA. The client's watermark is the last `rev`
   it has fully applied.
2. **Change is detected by hashing the normalized projection**, not the file.
   Each ingest run walks the working tree, computes a hash over exactly the
   fields we store, and diffs against the previous run's hashes. Changed or new
   → upsert; present before and absent now → tombstone. The server keeps a
   `rev` alongside each record's hash.
3. **Deltas carry whole records, never field-level diffs.** Replacement
   semantics: delete the record's dependent rows, insert the new ones.
4. **Merging is a range query, not a delta-combining step.** A delta for
   `(from, head]` is every row whose `rev > from` — one query, always each
   record's final state, no intermediate revisions replayed. Interned lookup
   rows carry a `rev` too and are selected the same way, so a delta always ships
   the lookup rows its upserts reference.
5. **The wire format is JSON, brotli-q5**, with `lookups` ordered before
   `upsert`, a `delete` array of CVE IDs, `format` and `schema` versions, and
   the D-008 notice in-band.
6. **Apply is one SQLite transaction, and the watermark lives inside the
   database**, written in that same transaction. A crash mid-sync rolls back to
   the previous consistent state with a watermark that still matches it.

```json
{"format":1,"schema":1,"from":1204,"to":1236,
 "generated":"2026-07-31T23:12:13Z","notice":"CVE® is a trademark of …",
 "lookups":{"cna":[],"cwe":[[798,"CWE-1395","…"]],
            "vendor":[[24421,"acme"]],"product":[[80149,24421,"widget"]]},
 "upsert":[{"id":"CVE-2026-14537","y":2026,"st":1,"cna":12,
            "pub":"…","upd":"…","cvss":[31,7.5,"HIGH","CVSS:3.1/…"],
            "cwe":[412],"prod":[80149],"descr":"…"}],
 "delete":[]}
```

**Context.** Measured rather than argued. The clone was hashed at
`a42a2eb6c2`, fetched forward 21.4 hours to `d300c5fcc0`, and re-hashed:

| | |
| --- | --- |
| Records before → after | 372,092 → 372,322 |
| Added / updated / **removed** | 230 / 435 / **0** |
| New lookup rows | 17 vendors, 86 products, 1 CWE, 0 CNAs; **0 vanished** |
| Delta payload | 382 KB JSON → **95 KB gzip -9 → 87 KB brotli -q5** |
| Description text | 62% of the uncompressed payload |
| `git fetch --depth 1` | 1.8 s |
| Full-corpus hash pass | 15–18 s (the same pass that rebuilds the artifact) |
| Apply to the 272.8 MB database | **0.08 s**, FTS maintenance included |

Each decision above is answering something specific:

*Why a server-assigned rev rather than `dateUpdated`* (the Q-001 fork): the
timestamp is publisher-written, so it inherits publisher clock skew and
republication that does not advance it. The content-hash pass costs 15–18 s and
is the same walk that rebuilds the artifact, so the robust option is
effectively free. It also cross-validated: the hash diff found exactly 665
distinct changed records, matching the 665 distinct IDs in upstream's own
`deltaLog.json` over the same window.

*Why hash the normalized projection rather than the file*: the hypothesis was
that dropping `x_legacyV4Record` and `adp` (D-024) would filter out churn that
changes nothing we store. **It did not** — all 435 raw-byte changes also changed
the projection, because `dateUpdated` is stored and is bumped on every
republish. The projection hash is still the right thing to hash, since it is the
definition of "changed" the client cares about, but it buys no filtering. One
number worth knowing: **63% of updates change nothing but `dateUpdated`** (275 of
435). That is the ongoing cost of keeping last-modified (D-020), and at 87 KB a
day it is not worth reconsidering.

*Why whole records rather than field diffs*: 62% of the payload is description
text, which is the field most likely to actually change, so diffing saves
little; and replacement is idempotent, which turns out to matter more.

*Why merge by range query*: a client catching up a week would otherwise replay
every intermediate revision. Merging one day collapsed 832 upstream change
events into 665 rows — a 20% saving on payload, but the real win is one request
instead of 32. Because the server stores `rev` per record, "merged delta" needs
no merge logic at all; the range query returns final state by construction.

Three hazards were tested rather than reasoned about:

- **FTS5 external content (D-025 hazard 2) is maintainable and cheap.** Explicit
  `INSERT INTO fts(fts, rowid, descr) VALUES('delete', …)` with the *old* text,
  then re-insert. 665 records applied in 0.08 s against the 55 MB index. Eight
  repeated applies of the same delta grew the database 0.1 MB total, so no
  `'optimize'` is needed per sync — it is a maintenance action, not part of
  apply. **Verification must use `rank = 1`**; the default form passes on a
  drifted index (RE-005).
- **Apply is idempotent.** Eight applications of the same delta produced
  identical row counts and a stable file size. An interrupted sync is safe to
  retry with no reconciliation logic.
- **Deletions barely exist.** Zero records vanished in the window, and
  upstream's `deltaLog.json` — 923 entries covering a rolling 30 days — models
  only `new`, `updated`, and `error`. There is no deletion concept upstream;
  withdrawal is `state: REJECTED` (D-022). Tombstones ship anyway because *our*
  ingest can lose a record to a bad fetch, which is also why the pipeline aborts
  rather than publishes if a run would tombstone more than 0.1% of the corpus
  (~370 records).

**Consequences.** D-026's three sub-questions are answered. **Delta merging**:
by range query, above. **Watermark after download**: the snapshot embeds its own
`rev` in a `meta` table, so the client reads its watermark *out of the artifact*
and cannot end up holding the wrong one; it then fetches deltas from that rev.
**Snapshot cadence**: the measured rate is ~750 distinct records/day ≈ 87 KB
compressed, so a month of catch-up would cost a new user ~2.6 MB against a 72 MB
snapshot — under 4%. Weekly stays the default because it bounds the delta file
count, not because monthly would hurt.

One schema change falls out of this, and it is the kind a read-only benchmark
never surfaces. Replacement semantics delete a record's dependent rows by
`cve_id`; `cve_prod` has an index for that and **`cve_cwe` does not** — its only
index is `(cwe_id, cve_id)`. Adding `CREATE INDEX ON cve_cwe(cve_id)` took delta
apply from **1.53 s to 0.08 s, a 19× difference**, for 2.2 MB of index. The
production schema needs indexes chosen for writes as well as reads.

Two open architecture questions close. FTS delta cost: measured, negligible.
Cache invalidation on a rewritten upstream history: moot — the pipeline diffs
content hashes, never git history, so a force-push produces the same delta as
any other change (RE-006).

All timings are native SQLite on server hardware. The apply path runs in
SQLite/WASM in a browser, and 0.08 s has enough headroom that this is not
expected to be the problem — but it is Q-003's job to confirm it, not this
entry's to assume it.

**Reopen if.** Upstream begins deleting records in volume, publishes fast enough
that per-run deltas stop being small, or a schema addition (Q-002) makes
whole-record replacement expensive enough that field-level diffs start paying
for themselves.

## D-030: Server configuration baseline, and the two changes M1 needs  (2026-07-31, status: accepted)

**Decision.** Adopt the existing `cve.meenan.dev` nginx block as the baseline.
Two changes are required before M1 ships, both small:

1. Add `brotli_static on;` to the server block, so a precompressed `.br` snapshot
   (D-026) is served with `Content-Encoding: br`.
2. Set `trailingSlash: true` in `next.config.js` rather than editing `try_files`.
   Next then emits `/route/index.html`, which the existing
   `try_files $uri $uri/ =404;` already resolves — no nginx routing change.

**Context.** Read directly from `plex` on 2026-07-31, answering most of Q-005:

| Fact | Value |
| --- | --- |
| nginx | 1.30.2, `--with-http_gzip_static_module` |
| brotli modules | `ngx_http_brotli_filter_module.so` **and** `..._static_module.so`, both loaded at `nginx.conf:1-2` |
| brotli directives | **none anywhere** — modules loaded but not enabled |
| COOP/COEP on `cve.meenan.dev` | **already set**, at server level and in the HTML location |
| Routing | `try_files $uri $uri/ =404;` — no `$uri.html` |
| PHP | `include php.conf` → php-fpm 8.4 over a unix socket, running as **user `pmeenan`** |
| PHP path safety | `if (!-f $document_root$fastcgi_script_name) { return 404; }` |
| Cache headers | HTML `no-cache, must-revalidate`; `expires max` for `js|css|png|jpg|…` |

**Consequences.** The most significant finding removes a blocker rather than
adding one: **COOP/COEP are already served**, copied from the `webai` and
`keepawake` blocks where the owner uses the same pattern. So the `opfs` VFS is
available today, and D-027's warning that Next.js static export cannot emit
response headers is moot — nginx already emits them. Q-004 is now a pure
performance-and-concurrency question with no server-config obstacle on either
side.

php-fpm running as `pmeenan` means the endpoint can read
`/var/www/meenan.dev/cve.data/` (D-018) with no permission work. That
convenience is also a hazard worth recording: the endpoint runs as the user that
owns the clone, the artifacts, *and* the document root, so a flaw in it has
write access to all three. The endpoint only ever needs to read two
directories. Tightening that — a dedicated pool user, or read-only paths — is a
Q-005 hardening item, not a blocker.

Two smaller gaps: the `expires max` list covers `js|css|png|…` but not
`.sqlite`, `.br`, or `.wasm`, so the weekly snapshot would not get long-lived
cache headers it deserves; and `application/wasm` is in `gzip_types` but the
snapshot's type is not.

**Reopen if.** The host's nginx is rebuilt without the brotli modules, or the
PHP pool arrangement changes.

## D-029: M0 closes on planning questions; measurement spikes move to M1  (2026-07-31, status: accepted, amends the M0 exit criteria)

**Decision.** M0's exit criteria no longer require every open question answered.
Q-003 (browser-side budgets) and Q-004 (OPFS VFS selection) move into M1, where
they are measured against real scaffolding. M0 closes when the *planning*
questions are settled: the delta protocol, schema completeness, the architecture
draft, and the milestone ladder.

**Context.** Stated by the project owner 2026-07-31: *"we don't have to have all
of the answers up front, we can iterate as we go since we will discover more as
we build."* The trigger was a sequencing problem — Q-003 and Q-004 both require
running SQLite/WASM in a real browser under Playwright, and no application
scaffolding exists, so M0 as originally written could not close without either
building a throwaway harness or pulling M1 forward.

The original criteria were written deliberately airtight, so relaxing them
deserves a reason rather than just permission. The reason holds: M0's purpose
was to stop us building on unexamined assumptions, and the assumption with the
most rework attached — how data reaches the client — was settled with
measurements in D-024 through D-026. Q-003 and Q-004 are measurements *of an
implementation*, not inputs to a design; deferring them risks tuning, not
rework.

**Consequences.** M1 gains two spikes and stops being purely scaffolding, which
is honest — the "smallest change that exercises the riskiest substrate" was
always going to answer these. If Q-003's browser numbers come back bad, the
fallback is already identified in D-024 and D-025: ship the ~86 MB of structured
data first and defer text plus FTS. That is a real risk being carried
deliberately into M1 rather than retired in M0.

More broadly this sets the project's posture: milestones close on what they can
honestly settle, and open questions may cross milestone boundaries so long as
they stay recorded. Silent drift is still forbidden — a question moving between
milestones is a plan edit, not a quiet reprioritization.

**Reopen if.** Deferred questions start accumulating faster than they are
answered, which would mean the posture has become an excuse rather than a
sequencing choice.

## D-028: UI dependencies must be free and open-source  (2026-07-31, status: accepted)

**Decision.** Grid, charting, and editor components must be OSS under a
D-002-compatible license. AG Grid Enterprise and other commercially-licensed
component suites are rejected. AG Grid Community (MIT) and TanStack Table (MIT)
are both acceptable; the specific grid is chosen when the work starts.

**Context.** Chosen by the project owner 2026-07-31 when the licensing fork was
raised: AG Grid publishes Community under MIT (v36.0.2, verified same day) but
gates pivoting, row grouping, master-detail, and integrated charts behind a
commercial Enterprise license.

**Consequences.** The project stays fully open-source with no per-seat cost,
which matters for a public tool where any user could also be a contributor, and
D-002's policy needs no exception. The cost is concrete: pivoting and row
grouping are hand-built if wanted rather than configured. Verified 2026-07-31 as
MIT or Apache-2.0 and therefore available: `ag-grid-community` 36.0.2,
`@tanstack/react-table` 8.21.3, `recharts` 3.10.1, `@visx/visx` 4.0.0, `echarts`
6.1.0 (Apache-2.0), `uplot` 1.6.32, `@uiw/react-codemirror` 4.25.11.

**Reopen if.** A reporting feature turns out to need pivoting badly enough that
building it by hand costs more than a licence — an explicit owner call, not an
agent's.

## D-027: React 19 on Next.js 16 static export — supersedes the UI half of D-017  (2026-07-31, status: accepted, supersedes D-017 in part)

**Decision.** The UI is React 19 on Next.js 16 with `output: 'export'`, building
to fully static HTML/CSS/JS. Svelte 5 and Vite-as-app-bundler are dropped.
Everything else in D-017 stands: TypeScript strict, Vitest, Playwright, ESLint +
Prettier, pnpm, plain PHP 8.4.

**Context.** The owner delegated the stack at kickoff ("M0 picks"), D-017 chose
Svelte 5, and the owner revisited it on 2026-07-31 with priorities that
invalidated D-017's central argument. D-017 picked Svelte partly for a small
runtime beside a heavy WASM payload; the owner's direction is that **richness of
framework capability matters far more than bundle size**, given the data
download dwarfs any framework, and that SSG plus hydration is wanted for fast
first load.

That inverts the reasoning. D-017 had already recorded React's larger ecosystem
and greater training-data density as the counter-argument, noting it was a
genuine reliability factor in a project where agents write nearly all the code
(D-001) — with size deprioritized, that counter-argument simply wins. The
concrete gap is data grids: TanStack Table ships a Svelte adapter, but AG Grid
has no first-class Svelte wrapper, and Recharts and visx are React-only.

Verified against the Next.js 16.2.12 documentation, 2026-07-31:

- `output: 'export'` produces an HTML file per route with client-side navigation
  after hydration — SSG plus hydration, no Node server at runtime.
- Output lands in `out/` by default and `distDir` can redirect it, so it is
  configured to `dist/` to match D-003 rather than changing the deploy contract.

**Consequences.** Every React data library is available, and the static export
matches D-003's rsync deploy with no server-side build. Three consequences need
acting on rather than noting:

1. **nginx needs rewrite rules.** Static export emits `/route.html`; clean URLs
   require `try_files $uri $uri.html $uri/ =404;` per the Next documentation.
   This joins the brotli-module question (D-026) as server configuration to
   settle in the Q-005 spike.
2. **Next cannot set response headers in static export** — `headers` is on the
   documented unsupported list, along with rewrites, redirects, middleware, ISR,
   and Server Actions. This lands directly on **Q-004**: if the `opfs` VFS is
   chosen, its COOP/COEP headers must come from nginx, because the framework
   cannot supply them. `opfs-sahpool` needs no headers and is unaffected.
3. **The PHP endpoint must survive `rsync --delete`.** Since D-003 mirrors
   `dist/` into the docroot, the endpoint has to be part of the build output.
   Placing it in Next's `public/` directory should achieve this, as `public/` is
   copied to the export root — **confirm in M1 before relying on it**, since the
   static-export documentation does not state it explicitly.

Vitest is retained: it runs standalone and does not require Vite to be the
application bundler.

**Reopen if.** Next's static export gains constraints that conflict with a
confirmed feature, or the framework proves to be fighting the Worker/WASM/OPFS
boundary that D-004 forces.

## D-026: Download is snapshot + catch-up deltas; snapshots rebuild weekly  (2026-07-30, status: accepted; cadence superseded by D-042, transport by D-040/D-041)

**Decision.** The server publishes a **compressed full snapshot on a slow
cadence — weekly by default** — and a continuous stream of deltas keyed to it.
"Download data" fetches the cached snapshot *and* every delta since that
snapshot was taken, leaving the client current in one operation. "Sync" fetches
deltas since the client's own watermark. Both paths end in the same place, so
they share one apply implementation.

Retention rule: deltas are kept back to the current snapshot and no further. A
client whose watermark predates the current snapshot re-downloads rather than
being served an unbounded delta chain.

**Context.** Proposed by the project owner 2026-07-30. The problem it solves is
server cost: D-024's artifact rebuild is cheap (19 s) but *compression* is not —
brotli -q10 takes **239 s** to produce the 72.1 MB snapshot, confirmed by two
independent runs. Recompressing 272.8 MB on every hourly upstream fetch would be
almost entirely wasted work, since only ~1,300 records change per day (D-025).
The owner separately capped brotli quality at 10, q11 costing significantly more
time for little further gain.

The arithmetic strongly favors it. A week of deltas measured 1.50 MB gzipped
against a ~72 MB snapshot, so a brand-new user in the worst case — arriving
the moment before a rebuild — downloads about **2% more** than someone arriving
just after one. In exchange, full-artifact compression drops from roughly 168
times a week to once.

**Consequences.** The snapshot becomes a genuinely static file: built once,
compressed once, served many times, cacheable, and resumable via ordinary HTTP
range requests — which is most of what the "resumable download" feature needs.
Nothing in the hot path recompresses anything large; delta payloads are small
enough that compressing them is negligible.

It also collapses a distinction that was about to become two code paths. Under
D-025, Download and Sync were separate operations; here Download is just Sync
from a watermark of "whatever the snapshot contains." The client always ends by
applying deltas until current, and the four D-025 hazards need solving exactly
once.

Three things this introduces that need answers in Q-001:

- **Delta merging.** A client asking for a week of changes should receive each
  record's *final* state, not every intermediate revision. Serving the raw
  hourly sequence works but is wasteful and re-applies churn; a merged delta per
  watermark range is better and can be cached by range.
- **Watermark after download.** The client's watermark must end at the last
  delta applied, not at the snapshot's — otherwise the next sync silently
  re-fetches a week.
- **Snapshot cadence is a tuning knob, not a constant.** Weekly is a starting
  point chosen from the 1.50 MB/week measurement. At these rates even monthly
  would only accumulate ~6 MB, so the cadence can be relaxed if compression cost
  becomes the binding constraint.

One server-configuration dependency to verify in the Q-005 spike: serving a
precompressed snapshot with `Content-Encoding: br` requires either nginx's
brotli module or a location block that sets the header explicitly for a
prebuilt `.br` file. This has not been checked on `plex`.

**Reopen if.** Upstream change volume rises enough that a week of deltas becomes
a significant fraction of the snapshot, or compression stops being the reason
for the cadence.

## D-025: Bulk import with explicit Download and Sync — settles the data-delivery architecture  (2026-07-30, status: accepted, refined by D-026)

**Decision.** Candidate (a). The client downloads a complete prebuilt artifact on
an explicit **"Download data"** action, and applies incremental changes via a
custom delta format on an explicit **"Sync"** action. Both are user-initiated;
neither happens automatically. Candidate (b), the field-and-partition projection
API, is rejected.

**Context.** Decided by the project owner 2026-07-30, on two grounds. First,
storage is not a constraint: the owner runs other experiments storing tens of
gigabytes of WASM models in OPFS, so a few hundred megabytes is unremarkable.
Second, the D-024 normalization spike removed bulk import's only real weakness —
the full corpus is 98.7 MB gzipped, less than candidate (b)'s own two-year
motivating slice in raw form.

Delta economics were measured the same day against `cves/deltaLog.json` over a
31-day window and the spike database:

| | Changed records | Gzipped payload |
| --- | --- | --- |
| Median day | 1,312 | **0.17 MB** |
| Mean day | 1,749 | 0.24 MB |
| Busiest day observed | 6,147 | 0.78 MB |
| One week | ~12,000 | 1.50 MB |

A median day's delta is roughly **574× cheaper** than re-downloading, which is
exactly the owner's point about not re-fetching a full database daily for tiny
changes. At these rates a client would need to be stale for something on the
order of a year before a full re-download won on bytes — so in practice there is
no "delta too large, start over" threshold except a schema change.

**Consequences.** This discharges the debt D-015 took on. Coverage tracking is
no longer needed, and vision criterion 7 — results are never quietly wrong —
becomes structural again rather than machinery we maintain: the client either
has the whole corpus or has not downloaded it yet. Q-001 collapses from ragged
multi-version cache reconciliation to ordinary delta application, and Q-005
shrinks because the endpoint no longer takes caller-supplied field or partition
parameters — it serves a static artifact plus a delta by watermark. Offline
becomes complete rather than partial.

Making both actions explicit has a consequence that needs designing rather than
assuming: **the user is now responsible for freshness, so the UI must make
staleness visible.** A silently month-old corpus producing confident counts is
its own species of quietly-wrong. Sync should also be non-destructive — a failed
or interrupted delta must leave the previous consistent state intact rather than
a half-applied one.

The delta protocol is now the main design problem, and it carries four hazards
worth naming before anyone implements it:

1. **Interned IDs must be server-assigned and permanently stable.** D-024's
   lookup tables key CWE, CNA, vendor, and product by integer. If a client
   interns locally, a delta referring to vendor `24421` binds to a different
   vendor on every client. The server must own the ID space, never renumber it,
   and ship new lookup rows inside the delta that references them.
2. **FTS5 external-content indexes do not maintain themselves.** The spike uses
   `content='cve_text'`. Updating a row requires an explicit
   `INSERT INTO fts(fts, rowid, …) VALUES('delete', …)` before re-inserting, or
   the index silently drifts out of agreement with the table — producing wrong
   search results with no error. This is the single most likely way to violate
   vision criterion 7 under this architecture.
3. **Deletions need tombstones.** State transitions such as PUBLISHED → REJECTED
   are ordinary updates, but a record removed upstream will otherwise persist in
   every client forever.
4. **Schema changes cannot be deltaed.** When the artifact's schema version
   moves, the delta path cannot bridge it and the client must re-download.
   D-013 already establishes the local database as a rebuildable cache, so this
   is acceptable — but it must be explicit in the UI, not a surprise.

One encoding question is already settled by measurement: positional/compact row
encoding gzipped to about the same size as plain JSON objects, so the codec is
not worth building. Send readable JSON and let transport compression work.

**Reopen if.** Browser-side measurement in the bake-off shows the 98.7 MB import
cannot complete or persist acceptably — the fallback is the hybrid identified in
D-024, shipping the ~86 MB of structured data first and the 187 MB of text and
FTS on first search.

## D-024: Served artifacts are normalized and interned, never raw upstream JSON  (2026-07-30, status: accepted)

**Decision.** The server derives a normalized relational artifact from the
corpus. Repeated descriptive text is interned into lookup tables keyed by ID,
and upstream sections that carry no queryable value are dropped rather than
stored. This holds regardless of how the data-delivery question resolves — bulk import and
projection both ship normalized data.

Dropped outright:

- `cna.x_legacyV4Record` — a complete duplicate of each record in the retired
  CVE v4 format. **19.1% of compact corpus bytes.**
- `containers.adp` as a stored blob — **21.5% of bytes**. ADP enrichment is
  mined for CVSS and CWE values, which are merged into the normalized columns,
  and then discarded.
- `cna.providerMetadata` (3.0%) — org identity, interned to a `cna` row instead.
- JSON formatting whitespace — files average 7,886 bytes on disk but 3,658
  compact, so **~54% of the raw corpus is pretty-printing**.

**Context.** The owner observed that the raw JSON carries a lot the tool does
not need and a lot of structure that could be indexed — naming problem type and
severity specifically. Measured against the full corpus 2026-07-30 by building
the artifact rather than estimating it. The owner's instinct was right, and the
interning cardinalities show why:

| Lookup | Distinct values | Was repeated across |
| --- | --- | --- |
| CWE (`problemTypes`) | **797** | 189,690 associations |
| CNA (`assignerShortName`) | **479** | 372,092 records |
| Vendor | 24,420 | 523,446 associations |
| Product | 80,063 | 523,446 associations |

Each CWE's descriptive text — strings like *"Improper Neutralization of Input
During Web Page Generation ('Cross-site Scripting')"* — was being carried in
every record that referenced it. There are 797 of them.

Result: **2,934 MB of raw JSON becomes a 272.8 MB queryable database** — base
tables 182.8 MB, +33.1 MB indexes, +56.9 MB FTS5 — which is 98.7 MB gzipped.
Full parse and build took 19 s for all 372,092 records.

**Consequences.** A 16× reduction changes what is architecturally possible, and
it is the strongest evidence yet bearing on the data-delivery question — see the analysis in
[architecture.md](architecture.md), which the bake-off must now confirm in a
browser rather than on server hardware.

The composition matters as much as the total: `cve_text` (131.6 MB) and
`fts_data` (55.1 MB) are 68% of the database, while every structured column
anyone filters or aggregates on fits in roughly 86 MB. Text and search are the
expensive half, and they are separable — which is the natural seam if cold start
needs to be faster than a full download.

**These figures are a floor, not the final size.** The spike schema deliberately
omits references (10.6% of corpus bytes), affected version ranges, CPE
applicability, solutions, credits, and timeline. D-011 also requires FTS over
references, which this build does not include. A production schema will be
larger, and how much is exactly what Q-002 must settle.

**Reopen if.** A confirmed feature needs a section dropped here — in which case
add it to the schema deliberately and re-measure, rather than reinstating raw
JSON storage.

## D-023: Descriptions are stored English-only  (2026-07-30, status: accepted)

**Decision.** Only descriptions tagged as English are stored and indexed for
search. Other-language descriptions are discarded at ingest.

**Context.** Stated by the project owner 2026-07-30. Measured the same day over
a 12,000-record sample: the only language tags present are `en` (11,465
descriptions) and `de` (299). Non-English text is 3.1% of description bytes.

The check that mattered: **zero records have a non-English description without
an English one**, so English-only makes nothing unsearchable. Separately, 4.46%
of records carry no description at all — largely REJECTED records (D-022) —
which is why `cve_text` holds 354,376 rows against 372,092 records.

**Consequences.** Little is saved in bytes, so this is a simplification
decision rather than a size one: one language means one FTS5 tokenizer, no
per-language index selection, and no language column to filter on. Records
without English text simply have no FTS row and cannot match a search — the UI
must not present that as "no results found" when the truth is "this record has
no indexed text."

**Reopen if.** The CVE Program's language mix broadens materially — the current
99.5%/0.5% split is what makes this free — or non-English search is requested.

## D-022: REJECTED records are imported, excluded by default, and filterable  (2026-07-30, status: accepted)

**Decision.** Records with `cveMetadata.state == "REJECTED"` are imported and
carry `state` as a queryable column, but are excluded from counts, aggregates,
and reports unless the user explicitly opts in.

**Context.** Chosen by the project owner 2026-07-30. Measured the same day over
a 20,000-record random sample of the corpus: **4.9% are REJECTED** (989 of
20,000), the remainder PUBLISHED — roughly 18,000 records corpus-wide. Nothing
in the feature ledger had accounted for them.

**Consequences.** Every aggregate must carry a default `state = 'PUBLISHED'`
predicate. That is easy to write and easy to forget, so it belongs in a shared
query layer rather than in each report — a forgotten predicate silently inflates
counts by ~5%, which is exactly the quiet wrongness vision criterion 7 exists to
prevent. Any published record count should reconcile against official CVE
Program figures, and a mismatch of roughly this magnitude is the first thing to
check.

Importing rather than discarding keeps rejection-pattern analysis possible —
which CNAs reject most, and why — at negligible cost, since the records are
small. Users who opt in must be shown clearly that rejected records are
included, because a chart that silently changes denominator is worse than one
that refuses to.

**Reopen if.** REJECTED records prove analytically inert in practice, or the
corpus grows a third state that makes a boolean opt-in insufficient.

## D-021: Shallow clone — supersedes D-019  (2026-07-30, status: accepted, supersedes D-019)

**Decision.** The server clone is
`git clone --depth 1 --no-tags https://github.com/CVEProject/cvelistV5.git`.
No history is retained.

**Context.** D-020 dropped the revision count, which triggers the exact reopen
condition D-019 recorded for itself: *"Reopen if D-012 is dropped — at which
point shallow becomes strictly better and should be adopted."* With no consumer
of commit history, the ~295 MB of trees and commits measured in D-019 buys
nothing. `--no-tags` matters here specifically: cvelistV5 publishes hourly
tagged releases, so tags would otherwise dominate the refs for no benefit.

**Consequences.** Measured after re-provisioning 2026-07-30: the pack drops from
581 MiB to **280.55 MiB** and clone wall-clock from 169 s to **68 s**, at the
same HEAD (`a42a2eb6c2`) with an identical 372,092 records. The checked-out
worktree is unchanged at 3.7 GB on disk, since that is current content either
way.

More importantly it removes a data path rather than shrinking one: no history
walk after each fetch, and no derived column that must stay consistent across
incremental syncs.

The tradeoff is that history becomes unavailable without re-cloning, so any
future feature wanting per-record change data — the D-012 family — must reopen
this before it can be built. That is a deliberate one-way door, taken because
nothing in confirmed scope was on the other side of it. Ongoing `git fetch` into
a shallow clone re-negotiates the shallow boundary each time; if that proves
costly at hourly cadence, `git fetch --depth 1` behavior is the thing to measure
before assuming a problem.

**Reopen if.** A change-history feature is confirmed, or shallow fetch proves
expensive at the sync cadence chosen in Q-001.

## D-020: The revision count is dropped — supersedes D-012  (2026-07-30, status: accepted, supersedes D-012)

**Decision.** Per-record revision counts are out of scope. Last-modified and
published dates are kept, sourced from `cveMetadata.dateUpdated` and
`cveMetadata.datePublished` in the record JSON rather than from git.

**Context.** The project owner challenged whether the count justified retaining
full git history, observing that the tool cares about a record's current state
rather than its edit history. On review the justification did not hold up. The
RE-003 finding had been cited in D-012's favour, but that anomaly was discovered
with a one-off `git log` during provisioning — keeping the finding costs nothing,
whereas shipping the feature costs a permanent data path. Those were conflated.

A cheaper middle path was measured and rejected: deriving "has been revised" from
the JSON alone. Over a 20,000-record sample, `dateUpdated` is present on 100% of
records and `datePublished` on 98.4%, but **95.5% have `dateUpdated >
datePublished`** — nearly every record has been revised at least once, so the
boolean carries no discriminating signal. It was the count or nothing.

**Consequences.** What is lost is the ability to distinguish a record revised 3
times from one revised 19 times (p50 and p99 respectively, per RE-003). No
confirmed feature queries that; the confirmed filter axes are vendor, product,
severity, CWE, CNA, and date. What is kept is recency, which is the actionable
half and is free — `dateUpdated` needs no git history at all.

This triggers D-019's reopen condition and is superseded onward by D-021, which
switches the clone to shallow. RE-003 remains in the findings log as a valid
observation about the corpus; it simply no longer justifies a feature.

**Reopen if.** A record-quality or CNA-auditing use case makes revision churn
central rather than incidental — at which point D-021 must be reopened first,
since shallow clones cannot answer it.

## D-019: Blobless clone, full history — not shallow  (2026-07-30, status: superseded by D-021)

**Decision.** The server clone is
`git clone --filter=blob:none https://github.com/CVEProject/cvelistV5.git`.
Full commit history is retained. A shallow (`--depth 1`) clone is rejected while
D-012 stands.

**Context.** The owner asked whether a shallow clone made more sense, given that
all current JSON must be parsed anyway and the clone will be synced regularly.
Measured on the actual clone 2026-07-30 rather than estimated:

| Object type | Count | On-disk |
| --- | --- | --- |
| trees | 474,911 | 280.7 MB |
| blobs (current content) | 372,132 | 261.5 MB |
| commits | 74,083 | 14.6 MB |
| **pack total** | 921,127 | **581 MiB** |

So history costs ~295 MB, dominated by *trees* rather than commits, and a
shallow clone would land around 265 MB — roughly half. The full clone GitHub
reports as 2.36 GB; the blob filter avoids ~1.7 GB of historical blob versions
that nothing in scope needs, since D-012 rejected diffs. Clone wall-clock was
169 s.

**Consequences.** This is a scope decision wearing a git costume. Shallow would
lose only the revision *count*: `datePublished` and `dateUpdated` are fields
inside each record's JSON, so last-modified survives a shallow clone for free.
The count is what needs history — and RE-003 demonstrated its analytical value
immediately, surfacing a record with 6,074 revisions against a 99.9th percentile
of 34, which is invisible without it. Computing all 372,092 counts takes 10
seconds from this clone with no persistent state.

The rejected middle path — shallow plus incrementally maintained counters — was
considered and is *more* complexity, not less: a derived counter that can drift
from ground truth, versus a ten-second recomputation. That runs against D-015's
simplicity preference rather than with it.

For ongoing sync the blobless clone is also the better-behaved option: `git
fetch` retrieves new commits, trees, and blobs incrementally, whereas repeated
`--depth 1` fetches re-negotiate the shallow boundary each time.

**Reopen if.** D-012 is dropped — at which point shallow becomes strictly better
and should be adopted — or disk pressure on `plex` makes 316 MB matter, which at
1.1 TB free it does not.

## D-018: Server-side state lives in `cve.data/`, a peer of the document root  (2026-07-30, status: accepted; published artifacts moved out to `cve.pub/` by D-053, and a fourth subdirectory — `state/`, the ingest's hash state, lock and daily builds — was added by D-058)

**Decision.** All server-side state lives under
`/var/www/meenan.dev/cve.data/` on `plex` — a sibling of the `cve/` document
root, never inside it:

| Path | Contents |
| --- | --- |
| `cve.data/git/` | The cvelistV5 clone |
| `cve.data/db/` | Working databases the pipeline builds |
| `cve.data/cache/` | Fetched upstream data such as the KEV catalog (D-010) |

> **Amended by D-053 (2026-08-01).** The `db/` row read "derived artifacts and
> databases *served to clients*", which was true when a PHP handler read from
> it. D-032 removed the handler; published artifacts now live in a separate
> peer, `cve.pub/`, and **nothing under `cve.data/` is web-reachable.**

The deploy may therefore use `rsync --delete` safely.

**Context.** Chosen by the project owner 2026-07-30, matching the existing
convention on the host: `/var/www/meenan.dev/` is a container of per-subdomain
document roots (`cve/`, `webai/`, `www/`, `keepawake/`), not a document root
itself. A peer directory therefore sits beside the served content without being
served.

That was verified empirically rather than assumed, since the nginx config was
not readable without sudo. A canary file was placed in `cve.data/` and requested
four ways — `https://cve.meenan.dev/canary.txt`, a traversal attempt via
`cve.meenan.dev/../cve.data/`, `https://meenan.dev/cve.data/`, and
`https://www.meenan.dev/cve.data/`. All four returned 404. The host has 1.1 TB
free, so the ~2.4 GB corpus is not a constraint.

**Consequences.** This closes the open architecture question about whether the
deploy's rsync semantics can coexist with server-side state: they can, because
the state is not under the path being mirrored. The deploy stays the single dumb
command D-003 wanted, and `--delete` keeps the docroot an exact mirror of
`dist/` with no orphans surviving across deploys.

The endpoint reads from a path outside its own directory, which makes D-006's
rule sharper rather than softer: the base path must be a fixed constant in the
code, and any request parameter that selects a field or partition must be
validated against an allowlist and never concatenated into a filesystem path.
The separation into `git/`, `db/`, and `cache/` also means the endpoint only
ever needs read access to `db/` and `cache/` — it has no reason to touch the
clone, and should not be able to.

Because the directory is a peer rather than a child, this arrangement depends on
no nginx server block ever pointing at `/var/www/meenan.dev/` directly. That is
an assumption about host configuration, not something the application can
enforce, so it is worth re-running the canary check if the site's nginx
configuration is ever restructured.

**Reopen if.** The host layout changes, another server block is added that
serves the parent directory, or state needs to be web-readable directly rather
than through the endpoint.

## D-017: Toolchain — Vite, Svelte 5, TypeScript strict, Vitest + Playwright  (2026-07-30, status: superseded in part by D-027)

*The UI framework and app bundler below were replaced by D-027: React 19 on
Next.js 16 static export, after the owner deprioritized bundle size and asked
for SSG. The rest of this entry — TypeScript strict, Vitest, Playwright, ESLint
+ Prettier, pnpm, plain PHP 8.4 — still stands.*

**Decision.**

| Concern | Choice |
| --- | --- |
| Build | Vite 8 → static `dist/` |
| Language | TypeScript 7, strict |
| UI | Svelte 5 |
| Unit test | Vitest 4 |
| Browser test | Playwright 1.62 |
| Lint / format | ESLint 10 + Prettier 3 (`eslint-plugin-svelte`, `prettier-plugin-svelte`) |
| Packages | pnpm 11, with `pnpm licenses list` for the D-002 audit |
| Server | Plain PHP 8.4, `declare(strict_types=1)`, no framework |

**Context.** The owner left the stack open at kickoff for M0 to decide. Versions
and licenses verified against the npm registry 2026-07-30 — all MIT or
Apache-2.0, compatible with D-002. `plex` runs PHP 8.4.8, git 2.54.0, and
sqlite3 3.45.1 (verified same day).

**Consequences.** Vite emits a static `dist/` that matches D-003's deploy model
with no server build step, and has first-class Worker and WASM handling, which
D-004 makes unavoidable. Playwright is not optional here: OPFS, sync access
handles, and Worker behavior do not exist in Node, so "measure, don't assert"
(AGENTS.md rule 3) requires a real browser — Playwright is where the bake-off
numbers and every storage test must run. Vitest covers pure logic like schema
derivation and coverage-set arithmetic. pnpm was chosen partly because
`pnpm licenses list` makes the D-002 audit a built-in rather than another
dependency.

Svelte 5 is the choice most open to challenge, so the reasoning is explicit: its
runtime is small next to an already-heavy SQLite WASM payload, it compiles to
direct DOM updates (which matters for large result tables), and its mental model
is the simplest of the candidates — consistent with D-015's preference for
architectural simplicity. The counter-argument is real and was weighed: React
has a larger ecosystem and far more training data, which in a project where
agents write nearly all the code (D-001) is a genuine reliability factor, not an
abstract preference. Svelte won on fit; if agent friction shows up in practice,
that is evidence to reopen, and the cost of switching is lowest now, before M1
scaffolding lands. Charting and table libraries were deliberately not chosen
here — both should be picked framework-agnostically when the reporting work
starts.

**Reopen if.** Agents show repeated friction writing Svelte 5, a required
capability exists only in another ecosystem, or the bake-off reveals a data-layer
constraint the build system cannot accommodate.

## D-016: Browser support floor — Chrome 108, Firefox 111, Safari 16.4  (2026-07-30, status: accepted, consequences amended by D-045: the floor governs the base app; AI tiers gate separately)

**Decision.** Supported: Chrome/Edge 108+, Firefox 111+, Safari 16.4+, Chrome
Android 109+, Safari iOS 16.4+. Below the floor, the capability gate shows an
explicit unsupported message on arrival.

**Context.** Verified 2026-07-30 against MDN's `browser-compat-data` JSON
directly, rather than from recollection. The important subtlety: the base
`FileSystemSyncAccessHandle` interface shipped considerably earlier — Chrome
102, Safari 15.2 — but SQLite's OPFS VFS needs the **synchronous** forms of
`close`, `flush`, `getSize`, and `truncate`, which BCD tracks separately and
which landed in Chrome 108 and Safari 16.4. Firefox shipped both at 111. This
independently corroborates SQLite's own claim that `opfs-sahpool` works on
"all major browsers released since March 2023": Safari 16.4 and Firefox 111 both
shipped that month. `StorageManager.persist` is available far below this floor
(Chrome 55, Firefox 57, Safari 15.2), so quota persistence adds no constraint.

**Consequences.** The capability gate must probe for the *synchronous* method
forms specifically — a naive `'FileSystemSyncAccessHandle' in self` check passes
on Safari 15.2 through 16.3 and then fails deep inside the import, which is
precisely the failure the gate exists to prevent. Mobile browsers clear the
floor, but clearing it is not an endorsement: whether a multi-hundred-megabyte
import belongs on a phone is a product question the bake-off numbers should
inform. Because D-009 rules out telemetry, we will never observe real-world
gate hits, so the gate's message must be self-explanatory on first read.

**Reopen if.** The SQLite WASM build changes its VFS requirements, or a storage
layer that does not need synchronous access handles is adopted.

## D-015: The range-request VFS is rejected — keep the architecture simple  (2026-07-30, status: accepted, amends D-014)

**Decision.** Candidate (c) — a custom SQLite VFS fetching database pages over
HTTP range requests with an OPFS-persisted page cache — is out. Open question 1
is now a two-way choice: (a) bulk import versus (b) field-and-partition
projection.

**Context.** Stated by the project owner 2026-07-30: *"I want to keep the
architecture simple and the VFS sounds anything but."* The assessment holds up:
(c) required composing two VFS layers — range-request fetching and OPFS
persistence — and neither prior-art library (`sql.js-httpvfs`,
`sqlite-wasm-http`, both self-described experimental) persists its page cache,
so that layer would have been ours to write and maintain against a moving
SQLite WASM target. Novel infrastructure underneath the storage layer is
exactly where a project of this size can lose months.

**Consequences.** The significant one is a cost, and it should not be discovered
later: **(c) was the only candidate that made query correctness free.** SQLite
decided which pages it needed, so a query could not silently run against a
partial view. With (c) gone, cache coverage tracking becomes mandatory
engineering if (b) wins — vision criterion 7 is now something we build rather
than something we inherit.

It is tractable at this granularity, which is what makes the trade acceptable.
Because the contract is fields × partitions (D-014), coverage is a
set-membership check: what a query requires is computable from the columns it
references and the date range it spans, compared against a local manifest of
what has been synced. Fetch the difference, or say so. The awkward case is an
unbounded query — "every CVE for this vendor, ever" — which needs every
partition and so degenerates into a full sync; that deserves a deliberate answer
in the UI rather than a silent stall.

Two simplifications come with it: Q-004 reduces to picking `opfs` or
`opfs-sahpool` with no composition problem, and the M0 bake-off drops from three
implementations to two.

**Reopen if.** Both surviving candidates miss their budgets in the bake-off, or
a maintained, non-experimental range-request VFS with OPFS persistence appears.

## D-014: Field-and-partition projection is acceptable; predicate values are not  (2026-07-30, status: accepted, amended same day by D-015)

*Amended by D-015, which removes candidate (c). The correctness point below now
lands on us as work rather than arriving free.*

**Decision.** The client may ask the server for specific fields and specific
partitions — "these columns, these year ranges" — and the server may learn that.
The server must still never receive predicate *values* (`vendor = cisco`,
`severity >= 7`) or full-text search terms. Traffic-pattern analysis is
explicitly out of scope as a threat.

**Context.** Stated by the project owner 2026-07-30: *"I'm not worried about
pattern sniffing attacks on usage or anything insane like that so an explicit
field-based sync/delta of database records is perfectly acceptable."* On
follow-up the owner set the boundary at fields and partitions rather than full
predicate pushdown. This amends D-007, which had been written to forbid any
query content reaching the server.

**Consequences.** The practical effect is to restore candidate (b), the
projection API, as a peer in the data-delivery question — the bake-off is three-way again.
Under a field-and-partition contract (b) serves facet and count workloads
directly, and can serve full-text search by shipping the FTS index for the
requested partitions rather than the whole corpus, which is what makes it viable
now where D-011 had ruled it out. This weakens D-011's demotion of (b) but does
not touch D-011's own decision.

Two things this does *not* change, and they matter:

- **The correctness hazard stands.** Candidate (b) still requires cache coverage
  tracking, because a partially populated cache can answer a query with a
  plausible undercount; candidate (c) gets that guarantee free from SQLite. That
  argument is about correctness, not privacy, and is untouched here — it remains
  the strongest case for (c).
- **The server still does no query execution.** Projecting requested columns for
  requested partitions is data selection, not analysis. If a design starts
  having the server filter, rank, or aggregate, that is D-007's substance and a
  separate decision.

Documentation must now be accurate about this: claims that the endpoint "never
receives a query" or that sync requests carry "no query content" were true under
the original D-007 and are false under this decision. What a user can verify is
narrower and specific — that predicate values and search terms never appear in
requests. Vision criterion 4, the README, and AGENTS.md were corrected in the
same change as this entry.

**Reopen if.** The tool acquires users whose threat model includes the operator,
or someone else deploys it where the operator is not trusted — at which point
the field/partition leak becomes worth closing, and with (c) rejected by D-015
candidate (a) is the remaining answer.

## D-013: The local database is a cache, not a user asset  (2026-07-30, status: accepted)

**Decision.** The OPFS database is treated as rebuildable cache. Import/export
of the whole local database is rejected. Users export *results* (D-011's
sibling row in features.md), not the store.

**Context.** Decided in the 2026-07-30 feature triage. The framing follows from
where the data-delivery question is heading: under a demand-driven design the local
database is a materialized subset of a server artifact, not a curated corpus a
user built. Treating it as precious would be a category error that constrains
eviction, migration, and invalidation for no real gain.

**Consequences.** Schema migrations may discard and rebuild rather than
transform in place, which is dramatically simpler. Eviction and quota pressure
become recoverable events rather than data loss. The cost is real if candidate
(a) wins: a user who spent a long cold start has no way to move or back up that
work, and would re-import from scratch on a new machine.

**Reopen if.** Candidate (a) wins the data-delivery question *and* the measured cold start
is expensive enough that re-importing is a genuine burden — in which case
whole-database export becomes a proportionate answer.

## D-012: Change history is revision metadata, not diffs  (2026-07-30, status: superseded by D-020)

**Decision.** Surface how many times a record has been revised and when it last
changed. Full per-revision diff views are rejected.

**Context.** Decided in the 2026-07-30 feature triage. The server holds full git
history (D-005), so both were available; the narrow form carries most of the
analytical signal — "this record is churning" or "this was quietly rewritten
after publication" — for a fraction of the data path.

**Consequences.** Revision count and last-modified become columns derived at
artifact-build time from git history, so they cost the client nothing extra and
need no second fetch path. Answering *what specifically changed* remains out of
reach, which is a real loss for anyone auditing CNA behavior. Because the git
history stays on the server, adding diffs later is additive rather than a
rework.

**Reopen if.** Users ask for the specific-changes question often enough to
justify the second data path, or a record-quality analysis use case makes diffs
central rather than incidental.

## D-011: Full-text search over descriptions is in scope, in full  (2026-07-30, status: accepted, consequences amended same day by D-014 and D-015)

*The decision below stands. Its reasoning about candidates (b) and (c) is
superseded: D-014 permits field-and-partition requests, so (b) can ship the FTS
index per partition and is no longer demoted, and D-015 removed (c) entirely.
The durable point is that FTS keeps search terms on the client and makes the
index a major transfer cost.*

**Decision.** SQLite FTS5 over CVE descriptions and references, not a scoped
index over short fields.

**Context.** Chosen by the project owner in the 2026-07-30 feature triage from
four options (full, scoped to titles/products, metadata-only, defer). "Searching
CVEs" is in the project's own description, and a search tool that cannot search
narrative text undersells that.

**Consequences.** This decision reaches past its own feature and constrains
the data-delivery question, which is why it is logged rather than left as a ledger row.
Free-text search requires the search term and the indexed text to meet
somewhere. Under a projection API — candidate (b) — that means either shipping
all description text to the client (which defeats projection and collapses (b)
toward (a)) or sending search terms to the server, which is predicate pushdown
and forbidden by D-007. Under candidate (c) the FTS5 index lives in the same
database file and its B-tree pages are range-fetched like any other, so search
works lazily and terms never leave the client. Candidate (b) is therefore
demoted to a hybrid fallback and the bake-off is effectively (a) versus (c).
Description text also dominates corpus size, so the FTS index is a major
contributor to whatever budget Q-003 establishes.

**Reopen if.** The bake-off shows the FTS index is what makes the working-set
budget unachievable — the fallback ladder is scoped FTS over short fields, then
metadata-only search.

## D-010: Enrichment is limited to CISA KEV  (2026-07-30, status: accepted)

**Decision.** CISA's Known Exploited Vulnerabilities catalog is the only
enrichment overlay in scope. EPSS and NVD enrichment are rejected.

**Context.** Chosen by the project owner in the 2026-07-30 feature triage.
Verified the same day: the KEV JSON feed carries 1,656 entries in ~1.5 MB
(catalogVersion 2026.07.29) and returns **no** `access-control-allow-origin`
header, so the browser cannot fetch it directly. FIRST's EPSS per-CVE API does
return `access-control-allow-origin: *`, but per-CVE lookups cannot cover ~300k
records, so full EPSS coverage would mean mirroring a daily bulk file.

**Consequences.** KEV joins the corpus as a second server-fetched source: the
server pulls it, caches it, and serves it same-origin, inheriting the D-006
hardening requirements. At 1.5 MB it can ship whole, so it adds no partial-fetch
complexity regardless of how the data-delivery question resolves. The rejections keep the
tool's dependency surface at two sources instead of four — EPSS in particular
would have meant daily-changing scores across the whole corpus, a recurring sync
problem for a secondary signal. Users wanting exploit-prediction context will
not find it here.

**Reopen if.** KEV proves valuable enough that exploit-prediction context is the
obvious next ask, or EPSS begins publishing in a form that composes with the
chosen delivery architecture instead of fighting it.

## D-009: No telemetry, of any kind  (2026-07-30, status: accepted, consequences amended by D-045: user-keyed chat requests carry the user's question browser → provider — by opt-in, and never to us)

**Decision.** The application collects and transmits no usage data, error
reports, or analytics. Not aggregate counters, not opt-in diagnostics.

**Context.** Chosen by the project owner in the 2026-07-30 feature triage from
three options (none, opt-in diagnostics, aggregate counters). The tool's pitch
is that queries stay local; a telemetry channel — even a benign one — makes that
claim something users must take on trust rather than verify by opening the
network panel.

**Consequences.** Vision criterion 4 becomes checkable rather than promised:
the only requests the app ever makes are data fetches, so any request a user
sees in the network panel is the client asking for corpus data — never a report
about the user. (Under D-014 a search or filter may trigger such a fetch when
the local cache lacks coverage; what it must never carry is the predicate or
the search term.) In exchange we are blind in production. A failing
import on some browser/hardware combination produces no signal — we learn about
it from a bug report or not at all. This makes the diagnostics panel
(`confirmed`) more than a nicety: it is the only mechanism by which a user can
tell us what went wrong, so it must surface enough state to reconstruct a
failure from a screenshot. Server-side request logs still exist as an operational
fact of running a web server; they are not a telemetry channel and must not be
repurposed into one.

**Reopen if.** Never, for passive collection — this is a standing property. An
explicitly user-initiated "copy diagnostics to clipboard" affordance is not
telemetry and does not require reopening this.

## D-008: CVE content is freely reusable, subject to a notice obligation  (2026-07-30, status: accepted; notice text canonicalized by D-047)

**Decision.** We may reproduce, transform, and redistribute CVE List content —
including as derived artifacts such as a prebuilt database — provided every copy
we produce carries MITRE's copyright designation and the CVE Terms of Use
license text. That obligation is treated as a functional requirement of any
feature that emits CVE data, not as a footer detail.

**Context.** The project owner raised the licensing question and flagged a
possible carry-forward clause. Confirmed 2026-07-30 by reading the terms source
at `CVEProject/cve-website` (`src/views/Legal/TermsOfUse.vue`), which renders
[cve.org/legal/termsofuse](https://www.cve.org/legal/termsofuse) — the published
page is client-rendered and returns no readable text to a plain fetch. The
operative clause, verbatim:

> **CVE Usage:** MITRE hereby grants you a perpetual, worldwide, non-exclusive,
> no-charge, royalty-free, irrevocable copyright license to reproduce, prepare
> derivative works of, publicly display, publicly perform, sublicense, and
> distribute Common Vulnerabilities and Exposures (CVE™). Any copy you make for
> such purposes is authorized provided that you reproduce MITRE's copyright
> designation and this license in any such copy.

The grant is unusually permissive — derivative works and sublicensing are named
explicitly, and it is irrevocable — so the owner's read is correct: there is no
restriction on what we build. The single condition is the notice carried by each
copy. The terms also disclaim all warranties, which is worth surfacing given
this tool will be used for security decisions.

**Consequences.** The notice obligation attaches to more surfaces than a
license page:

- Any server-derived artifact the endpoint serves is a copy and must carry the
  notice, in-band where the format allows it.
- Exported result sets (CSV/JSON, both `proposed`) are copies a user
  redistributes; export should embed the notice rather than rely on the user
  knowing about it.
- The local OPFS database is a copy made on the user's machine; shipping the
  notice with the application covers this in practice.

This is a notice condition, not copyleft: it constrains attribution, not what we
may build or how we license our own code (D-002). Note also that these are
MITRE's terms for the CVE List; individual CNA-supplied reference URLs point to
third-party content governed by nobody's terms but their own.

**Reopen if.** The CVE Program republishes its terms under different conditions
— the text above is a 2026-07-30 snapshot and should be re-read before launch —
or we begin redistributing a data source other than the CVE List, which will
carry its own terms.

## D-007: The data plane stays in the browser  (2026-07-30, status: accepted, amended same day by D-014)

*Read D-014 with this entry. The core holds — analysis runs on the client and
the server executes no queries — but the clause below saying the server "never
sees a user's query, filter, or report" was relaxed: the client may ask for
specific fields and partitions. Predicate values and search terms are still
forbidden.*

**Decision.** All parsing, storage, indexing, querying, aggregation, charting,
and export happen client-side. The server stores no user state and receives no
query, filter, or report. The single server endpoint (D-006) ships corpus data
only.

**Context.** Stated by the project owner at kickoff as a "100% client-side tool."
The owner subsequently accepted a small server-side ingest component (D-006), so
the constraint is scoped precisely here: it is the *analysis* that is
client-side, not every byte of the system. Recording it explicitly prevents
future agents from reading D-006 as license to move work server-side.

**Consequences.** Users get privacy by construction — a researcher can query the
corpus without disclosing what they are looking for. It also forces the hard
problems into the browser: a ~300k-record corpus must import, persist, and query
within browser memory and storage limits, which is exactly what M0's spikes must
measure. Server-side query execution is unavailable as an escape hatch if
client-side performance disappoints; the answer would be a better schema, better
indexing, or a smaller derived corpus, not a server.

**Reopen if.** M0 measurement shows client-side query latency is unacceptable
for the core reporting use cases even after schema and indexing work — in which
case the tradeoff against the privacy property is an explicit owner decision,
not an agent's.

## D-006: Ingest is one hardened same-origin PHP endpoint  (2026-07-30, status: accepted)

**Decision.** Corpus data reaches the browser through a same-origin PHP endpoint
served from `https://cve.meenan.dev/`. It must be locked down so it serves
same-origin browser callers and does not become a general-purpose open endpoint.
It must never accept a caller-supplied URL, filesystem path, or git ref that is
passed through to the network, the filesystem, or a shell.

**Context.** Chosen by the project owner over a Cloudflare Worker, a
user-supplied ZIP upload, and a published prebuilt artifact. The owner has PHP
enabled for this origin, with nginx routing any URL ending in `.php` (query
parameters ignored for routing purposes). This choice was forced by verified
CORS behavior — see D-005 for the measurements.

**Consequences.** First-run ingest is fully automatic with no manual download
step, and the wire format is ours to design rather than GitHub's to dictate
(the format itself is an open question for M0). The cost is an internet-facing
endpoint that must be defended: parameter validation, bounded response sizes,
rate limiting, and same-origin enforcement are functional requirements, not
polish. The specific enforcement mechanism is an M0 open question —
`Sec-Fetch-Site` and `Origin` header checks are candidates, but both must be
validated against the actual nginx/PHP configuration and against browsers in
scope before being relied on. Note that same-origin enforcement via request
headers constrains *browsers*, not `curl`; rate limiting and cheap responses are
what bound abuse from non-browser callers.

**Reopen if.** The endpoint proves impractical to secure or operate on this
host, or PHP availability changes — the fallback ladder is a published prebuilt
artifact, then user-supplied ZIP upload.

## D-005: The cvelistV5 clone lives on the server, not the browser  (2026-07-30, status: accepted)

**Decision.** The server maintains a real git clone of
`https://github.com/CVEProject/cvelistV5` and derives baselines and deltas from
it. In-browser git (e.g. isomorphic-git into OPFS) is rejected.

**Context.** The owner's initial preference was to clone with git directly into
browser storage. Measurements taken 2026-07-30 against live endpoints show that
path is not viable:

- The repository reports 2,477,151 KB (~2.36 GB) via the GitHub API — far beyond
  a reasonable browser download and OPFS footprint.
- Release assets on `release-assets.githubusercontent.com` (the ~562 MB
  `all_CVEs_at_midnight.zip` baseline and ~4 MB hourly deltas) return **no**
  `access-control-allow-origin` header — browser-blocked.
- `codeload.github.com` zipball/tarball returns
  `access-control-allow-origin: https://render.githubusercontent.com` —
  browser-blocked for our origin.
- GitHub's git smart-HTTP endpoints send no CORS headers; isomorphic-git
  documents a CORS proxy as a hard requirement for browser clones, which would
  add a third-party dependency *and* still not solve the 2.36 GB problem.

By contrast, `raw.githubusercontent.com` and `api.github.com` both return
`access-control-allow-origin: *`, and `cves/delta.json` (a change manifest with
direct raw links) plus a 15.6 MB `cves/deltaLog.json` are readable from a
browser — so a browser-only *incremental* path exists even though the bulk path
does not. Moving the clone server-side makes both paths uniform and gives us
full git history, which is otherwise unavailable to the client.

**Consequences.** The hardest part of the owner's original design disappears:
git runs in its native environment. The server gains a periodic `git fetch` job
and — as provisioned under D-021 — a 280 MiB pack plus a 3.7 GB worktree. The
client never needs a git implementation, so no git library appears in the
browser bundle.

*Amended by D-021: this entry originally noted that server-side history made
per-record change history feasible. D-020 dropped that feature and D-021 made
the clone shallow, so history is no longer retained. The rest of this decision
stands unchanged — the clone belongs on the server regardless of its depth.*

**Reopen if.** GitHub adds CORS headers to bulk-download paths, or the corpus
shrinks by an order of magnitude, or an official CORS-enabled bulk mirror
appears. Re-verify the CORS measurements above before acting on this — they are
a snapshot of 2026-07-30, not a standing guarantee.

## D-004: SQLite compiled to WASM, persisted to OPFS, is the local store  (2026-07-30, status: accepted)

**Decision.** The browser-side store is SQLite built to WebAssembly, with the
database persisted in the Origin Private File System. Relational queries against
persisted SQLite are the substrate the analytics and reporting features build
on.

**Context.** Stated by the project owner at kickoff ("using wasm as needed,
local opfs storage, sqlite and analytics/reporting tools on top of it").
Verified 2026-07-30: `@sqlite.org/sqlite-wasm` publishes version 3.53.0-build1
under Apache-2.0, compatible with this project's license (D-002).

**Consequences.** Query power comes free — arbitrary SQL, joins, aggregates, and
FTS are available without building a query engine. In exchange we inherit OPFS's
constraints, which are real and shape the architecture:

- SQLite's OPFS VFS variants differ materially. Per SQLite's own documentation,
  the `opfs` VFS requires COOP/COEP response headers, while `opfs-sahpool` does
  not but **does not support multiple simultaneous connections**. Which VFS we
  use is an M0 decision with direct consequences for multi-tab behavior, and it
  interacts with what nginx can be configured to send.
- Synchronous access handles require a Worker; the main thread cannot own the
  database.
- Browser storage quota and eviction apply, so quota handling and
  `navigator.storage.persist()` are functional concerns, not polish.

**Reopen if.** M0 spikes show the corpus cannot be imported or queried within
acceptable time and storage budgets in-browser, or a VFS limitation proves
incompatible with required multi-tab behavior.

## D-003: Deploy by rsync of `dist/` to the live directory  (2026-07-30, status: accepted)

**Decision.** The build produces a `dist/` directory that is rsynced directly to
`plex:/var/www/meenan.dev/cve/`, served by nginx at `https://cve.meenan.dev/`.
No staged rollouts, no backup step, no build tooling on the server.

**Context.** Stated by the project owner at kickoff. nginx routes any URL ending
in `.php` on this origin (query parameters ignored for routing). Verified
2026-07-30: `cve.meenan.dev` resolves and nginx responds over HTTPS with a valid
certificate, currently returning 403 for an empty document root — consistent
with a configured, pre-code deployment target.

**Consequences.** Deployment is one command and trivially scriptable, but it is
also a live overwrite with no rollback: a bad build is served immediately, and
recovery means rebuilding from a known-good commit. Since the PHP endpoint
(D-006) is deployed by the same mechanism, `dist/` contains both the static app
and the endpoint, and the build must keep server-side and client-side artifacts
distinguishable. rsync deletion semantics need deciding in M0 — a plain mirror
would delete server-side cache or clone state if it lives under the document
root, which is a good reason to keep it outside.

**Reopen if.** The project acquires a staging need, multiple deploy targets, or
state under the document root that a mirroring rsync would destroy.

## D-002: Apache-2.0, with dependency licenses verified at source  (2026-07-30, status: accepted)

**Decision.** The project is licensed Apache-2.0. Every dependency's license
must be compatible and must be verified from the package's own published
metadata before it lands — never assumed from memory.

**Context.** The Apache-2.0 `LICENSE` file predates this scaffold and the public
repository at `https://github.com/pmeenan/cve.meenan.dev` reports `Apache-2.0`.
The verify-at-source rule exists because license facts drift and training
knowledge is unreliable; two dependencies were checked against the npm registry
on 2026-07-30 while writing this scaffold (`@sqlite.org/sqlite-wasm` 3.53.0-build1
Apache-2.0, `isomorphic-git` 1.40.0 MIT).

**Consequences.** Copyleft dependencies are excluded from the shipped bundle.
A license audit belongs in the M0 toolchain decisions and should be automated so
it runs on every dependency change rather than by memory. Note separately that
CVE record *content* carries the CVE Program's own terms, which are distinct
from this project's code license and need checking before the corpus is
redistributed in a derived form.

**Reopen if.** A required capability exists only under an incompatible license,
or the owner changes the project license.

## D-001: AI-developed, human-gated workflow  (2026-07-30, status: accepted; the operating modes its context references were replaced by D-062's lean loop)

**Decision.** Agents implement and review; the human directs, decides, and is
the sole committer. Agents never run `git commit`, `git push`, or history
rewrites — work is left in the working tree for human review. The project
documentation in `docs/` is the durable memory that agents work from.

**Context.** Stated by the project owner by adopting this scaffold. The
collaboration loop, tech-lead mode, reviewer mode, fix-pass mode, and
verify-pass mode are specified in [workflow.md](workflow.md).

**Consequences.** Documentation quality is load-bearing rather than incidental —
a stale doc misleads every future agent, so doc updates ship inside the same
change as the code. Only one stream of work can be in flight at a time, since
the uncommitted working tree is the shared unit of review. The human commit gate
is the only checkpoint that cannot be automated away.

**Reopen if.** The owner wants agents to commit directly, or the single-stream
constraint becomes the binding limit on throughput.
