# Pipeline

Server-side ingest and publish. Python 3.12, standard library only (D-043).
Runs on `plex` from a checkout of this repo at `/home/pmeenan/src/meenan.dev/cve/`;
**never in the docroot** — `scripts/deploy.sh` mirrors `dist/`, and this has no
business being web-reachable. `scripts/deploy-pipeline.sh` updates it with
`git pull --ff-only` and prints the commit production is running, so that is a
fact rather than an assertion (D-059). Nothing is built: this is
standard-library Python, so the committed tree is the deployable artifact.
`PIPELINE_RSYNC=1` pushes the *working* tree instead, for the loop before a
commit — it leaves the checkout dirty on purpose, and
`git checkout -- pipeline` clears it.

    # build the artifact from a cvelistV5 clone, continuing the previous
    # build's ID space (--bootstrap only for the very first one, D-056)
    python3 pipeline/build.py /var/www/meenan.dev/cve.data/git/cvelistV5 out.sqlite \
        --seed yesterday.sqlite

    # bounded slice for development (M1). A slice always bootstraps: seeding one
    # would retire every value outside it from the ID space, permanently
    python3 pipeline/build.py <clone> slice.sqlite --year-min 2026 --bootstrap

    # the *previous* schema's slice, which `tests/e2e/bump.spec.ts` points an
    # old client at. Build it from a checkout at the older schema and publish it
    # to `pipeline/pub-schema1`; both directories are gitignored, and the spec
    # skips itself when the second one is absent

    # chunk, compress and publish, writing manifest.json
    python3 pipeline/publish.py slice.sqlite pipeline/pub

    # emit a delta from a changeset and register it in the manifest
    python3 pipeline/delta.py next.sqlite pipeline/pub changeset.json

    # or, in production, do all of that as one daily cycle (D-058)
    python3 pipeline/ingest.py run <clone> <pub-dir> --state <state-dir>

    # and once a month, rotate the generation onto the artifact that cycle
    # last built (D-060) — no rebuild, no fetch, no new revision
    python3 pipeline/snapshot.py <pub-dir> --state <state-dir>

    # the KEV catalog, on its own cron and its own failure domain (D-076)
    python3 pipeline/kev.py run <pub-dir> --cache <cache-dir>

| File | Role |
| --- | --- |
| `schema.sql` | The published schema. Single source of truth for both sides. |
| `normalize.py` | The stored projection — also the definition of "changed" (D-031). |
| `build.py` | Corpus → SQLite. Owns the interned ID space: seeded from the previous artifact or explicitly bootstrapped, never defaulted (D-056). Fails closed on malformed records (D-047); carries the canonical D-008 notice. |
| `publish.py` | SQLite → 32 MB chunks at brotli -q10 + manifest (D-041), plus D-042's retention. Published generations are immutable (D-047), and so is what an id means at a published revision *and what a revision's content is*; refuses an artifact from another ID space, grown from the wrong ancestor, carrying a revision JSON cannot hold, or landing at the published head without being the artifact that head's content came from (D-060). Re-cutting identical bytes resumes an interrupted run without `--force` (D-056). |
| `delta.py` | Changeset + artifact → one delta file at brotli -q5, on the D-055 wire contract. Fails closed on a missing record, an unshipped lookup row, a foreign or wrongly-continued ID space, floors that are not the source's seed, or a manifest that could not hold the entry (D-056). |
| `manifest.py` | The only writer of `manifest.json`: atomic, and the one place that decides what `rev` means. Refuses a manifest whose deltas do not tile the revision space. |
| `ledger.py` | Append-only record of everything ever published, with the SHA-256 served at each URL, the ID space it belongs to, and the digest of the artifact each revision's content came from (D-060). Kept *outside* the published directory (`cve.pub/published.json`); it is pipeline state, not part of the contract. |
| `ingest.py` | The daily cycle (D-042, D-058): fetch, hash, diff, tombstone guard, rebuild, one delta. The guard runs before the *build*, because seeding retires permanently. Subcommands `run`, `init`, `status`. |
| `snapshot.py` | The monthly rotation (D-042, D-060): publish the artifact the ingest state points at, at the published head, then retain and retire. It does not rebuild — the daily already did. |
| `kev.py` | The CISA KEV catalog (D-010, D-076): fetch, validate fail-closed, publish the verbatim bytes to `kev.json`. Its own cron and its own failure domain — no pipeline lock, no ingest state, nothing the ingest writes. Subcommands `run`, `status`, `sample`. |
| `state.py` | What the corpus looked like at the published head — a content hash per record, the revision each last changed at, the tombstone log, the seed pointer and the pending run. Plus the `flock` both corpus crons take and one outcome record per cron. Lives in `cve.data/`, never served. |
| `tests/` | unittest suite (CVSS priority, notice components, hostile shapes, the delta contract with a reference apply, the ID space's stability under rebuilds, the ingest's guards and re-run semantics, and the KEV validator and its roll-backwards guard) — part of `pnpm check` via `pnpm test:pipeline`. |

## The daily ingest

`ingest.py run` is the whole cycle. It holds `<state-dir>/pipeline.lock` for the
duration — the monthly snapshot cron must take the same one — and publishes
nothing unless every guard passes:

    17 4 * * * cd /var/www/meenan.dev && python3 /home/pmeenan/src/meenan.dev/cve/pipeline/ingest.py run cve.data/git/cvelistV5 cve.pub/data --state cve.data/state >> cve.data/state/ingest.log 2>&1

**Installed in `pmeenan`'s crontab on `plex` since 2026-08-03**, with a comment
line above it saying how to remove it. It is one physical line: `crontab(5)` has
no backslash continuation, so a wrapped entry runs the fragment before the break
and then tries to parse the rest as more crontab lines.

Exit codes: **0** published, nothing to do, or the lock was held; **1** aborted;
**3** the tombstone guard tripped, which means the fetch broke rather than that
the CVE Program withdrew hundreds of records. `--dry-run` does everything
through the build and reports the changeset without publishing or touching
state. `--tombstone-limit` is for a withdrawal confirmed upstream, not for
getting past a broken fetch; it takes `[0, 1)`, where `0` is the strictest
setting and `1` is refused because it would disable the guard rather than loosen
it (at `1` the threshold is the whole corpus, which nothing can exceed).

`--keep` (default 3) bounds the ~377 MB daily builds under
`<state-dir>/artifacts`, never removing the one the state seeds from.

**A failed run does not mail anyone**: `plex` has no MTA, so cron's mail goes
nowhere, and D-009 rules out a telemetry channel. Every run records its outcome
in the state instead, and `ingest.py status` — which prints what the ingest and
the data plane each think, without taking the lock — reports it as `last_run`.
That is the health check, and it is worth a glance after any change here.

A record the hash pass cannot publish — unparseable, unnamed, duplicated, or
carrying text with no UTF-8 encoding (RE-015) — stops the run with the file named
on stderr, and there is deliberately **no override**: a silently skipped record
is an undercount that would sit below the tombstone guard forever (D-047). Until
upstream fixes it the data plane stays where it is rather than drifting, and
there is no flag that changes that. Editing the clone does not work either — the
next run's `git reset --hard` reverts it.

### The first production run (the D-056 migration) — done 2026-08-03

**Already run**, 2026-08-03. The origin serves snapshot rev 2 in ID space
`a46cc2797a9aa338`, and the cron below is installed and advancing the head with
a delta a day — `ingest.py status` reports where it actually is. This section is
kept because it is the procedure, not a to-do: it is what a schema bump or a
lineage reset would repeat.

The live origin had been published before ID spaces were recorded, and **a delta
never establishes a lineage** — so one snapshot had to adopt it first. The
seeded rebuild minted zero ids, which is what made the adoption honest rather
than hopeful:

All of it from `cd /var/www/meenan.dev`, with `<repo>` the checkout this
pipeline lives in — it is never deployed there (D-003), so the script paths and
the data paths have different roots:

    # 0. the state directory. `build.py` does not create its output's parent
    mkdir -p cve.data/state/artifacts

    # 1. rebuild seeded from the live artifact, at a revision above the head
    python3 <repo>/pipeline/build.py cve.data/git/cvelistV5 \
        cve.data/state/artifacts/rev-2.sqlite --seed cve.data/db/snapshot.sqlite --rev 2

    # 2. publish it as a new generation. Every client re-downloads once
    python3 <repo>/pipeline/publish.py cve.data/state/artifacts/rev-2.sqlite cve.pub/data \
        --adopt-id-space

    # 3. record the corpus behind that revision — without fetching in between
    python3 <repo>/pipeline/ingest.py init cve.data/git/cvelistV5 cve.pub/data \
        --state cve.data/state --artifact cve.data/state/artifacts/rev-2.sqlite

    # 4. from here the daily cron works. Rehearse it once by hand first
    python3 <repo>/pipeline/ingest.py run cve.data/git/cvelistV5 cve.pub/data \
        --state cve.data/state --dry-run

`cve.data/db/snapshot.sqlite` is the artifact the live rev 1 was published from
— confirmed against the manifest, whose `raw_bytes` matches that file's size to
the byte.

Step 3 has to see the tree step 1 built from, so do not fetch in between — and
`init` checks rather than trusts that. It refuses an artifact that records no ID
space, one from another lineage, one stamped at a revision that is not the head,
one that is a *sibling* of the artifact actually published there (same lineage,
same revision, different ids — only the ledger's fingerprint separates them), a
clone whose record set differs from the artifact's, and a clone whose commit is
not the one the artifact recorded. The last is the one that catches an edit to a
record that kept its id, which the record-set comparison cannot see. It also
refuses outright while a pending run exists, `--force` included.

**Do not re-run step 1 after fetching.** `build.py` overwrites its output, and
after step 2 that file is the only artifact continuing published rev 2. Rebuilt
from a moved tree it no longer matches the fingerprint the ledger recorded, so
`init` refuses it *and* nothing else can seed from it — the exit is
`--new-id-space`, which is a full re-download for every client. Re-running step 1
against the same tree is safe: a seeded rebuild is deterministic, same
fingerprint and same marks.

### Landing a schema bump (D-070, D-075) — done 2026-08-08

**Already run**, 2026-08-08, for schema 1 → 2. The origin serves snapshot rev 11
in ID space `schema2-2026-08-08`; publishing it retired space
`a46cc2797a9aa338` and all eight deltas cut against it in the same operation
(`deltas_kept: 0`). Measured on the day, on the real corpus: build **32.6 s**
(374,269 records, 0 skipped, 398,487,552 raw bytes), publish **99.6 s** to 12
chunks and **65,708,012 compressed bytes** (ratio 6.06), `init --force`
**24.0 s**, and a full-corpus import from the deployed origin in a real browser
**1.8 min**. The daily cron was already commented out, so nothing raced it.
This section is kept because it is the procedure, not a to-do: the next bump
repeats it.

A schema change is the *other* thing that takes a data plane to a new
generation, and it takes a different route from the adoption above: seeding
across a schema change is refused by `build._seed_from`, deliberately. Ids are
only meaningful against the shape that assigned them, and every client
re-downloads at a bump anyway (D-013, D-068), so carrying id stability across
one preserves something nobody can use. **A bump therefore bootstraps**, which
mints a new lineage, which needs `--new-id-space`.

`--new-id-space` also has to land *above* the published head, and that is what
retires every pre-bump delta from the manifest in the same operation — so no
schema-1 delta is ever advertised beside a schema-2 snapshot.

Sequencing matters between the two halves, because a deployed client refuses a
manifest whose schema it does not speak (`assertUsable`) and says to reload the
page. **The artifact ships first and the app follows in the same window**: in
between, every visitor is told to reload, which is true and actionable; the
other order would have the new app announcing a bump against a data plane that
has not moved. All of it from `cd /var/www/meenan.dev`, with `HEAD` the current
published head from `ingest.py status`:

    # 0. the checkout production runs from must be at the commit that bumps the
    #    schema (D-059). Nothing below is safe from a half-updated pipeline.
    git -C ~/src/meenan.dev/cve pull

    # 1. bootstrap at a revision above the head. NOT --seed: see above.
    #    --idspace is what makes this step *repeatable*: without it every run
    #    mints a fresh lineage token, so a second run produces a different ID
    #    space from the one step 2 published and steps 3 and 4 both refuse it.
    #    Pick any token; write it down.
    python3 <repo>/pipeline/build.py cve.data/git/cvelistV5 \
        cve.data/state/artifacts/rev-<HEAD+1>.sqlite --bootstrap --rev <HEAD+1> \
        --idspace <token>

    # 2. publish it, retiring the old ID space and every delta cut against it
    python3 <repo>/pipeline/publish.py cve.data/state/artifacts/rev-<HEAD+1>.sqlite \
        cve.pub/data --new-id-space

    # 3. re-adopt: the state describes a corpus behind a revision that no longer
    #    exists, so `--force` is required and is what it is for
    python3 <repo>/pipeline/ingest.py init cve.data/git/cvelistV5 cve.pub/data \
        --state cve.data/state --artifact cve.data/state/artifacts/rev-<HEAD+1>.sqlite --force

    # 4. deploy the app that speaks the new schema, immediately after
    pnpm build && bash scripts/deploy.sh

Two operational hazards, neither of which the tools can catch for you:

- **Nothing here takes the ingest's `flock`.** `build.py` and `publish.py` are
  operator tools; only `ingest.py` and `snapshot.py` take it. So the daily cron
  can fire *during* steps 1–4, and its first act is a `git fetch` — which moves
  the clone out from under step 3's "this is the tree the artifact was built
  from" check, and can leave a pending run mid-sequence. **Comment the daily
  cron out for the window, or run this well clear of 04:17.** `ingest.py status`
  says whether a run is pending; finish or discard one before starting.
- **The clone must not be fetched between steps 1 and 3**, for the reason the
  adoption section gives. Re-running step 1 against the *same* clone is safe and
  reproduces the same artifact byte for byte, which is what `--idspace` buys.
  Re-running it after step 2 against a *moved* clone produces different ids under
  the same token; the ledger's fingerprint refuses it, and the exit is a new
  revision rather than a repair.

A changeset is what the daily ingest computes and `delta.py` serializes:

```json
{"from": 12, "to": 13,
 "upsert": ["CVE-2026-14537"], "delete": [],
 "floors": {"cna": 372, "cwe": 798, "vendor": 24420, "product": 80148,
            "host": 9145, "url": 1204882, "vtype": 6},
 "extra": {"cwe": [798]}}
```

`floors` is each lookup table's highest *issued* id at revision `from` — the ID
space is append-only, so everything above the floor is exactly what the client
lacks (D-055). All seven tables must appear: a missing one defaults to 0 and
ships the whole table, so both mistakes are refused rather than published.
`extra` covers a row whose content changed under an existing id.

Both come out of the build rather than being computed by hand:
`build.id_space(artifact)["floors"]` reads the marks the build recorded in
`meta` (not `max(id)` — a retired row can be the highest one, D-056), and the
build's `extra` field reports the ids whose content moved. Only `cwe.descr` can
do that: it is the one lookup column that is neither part of its own interning
key nor derived from it (`url.host_id` is also a non-key column, but it is a
function of the url text, and host ids are seeded too).

An ID space has a name, minted by `--bootstrap` and inherited by every seeded
build, and each artifact also records the revision it continued (`seed_rev`).
`ledger.py` records the name the data plane was published from, and both
publishers refuse an artifact from a different one — or one grown from the wrong
ancestor, which shares the name. Two deliberate overrides, neither defaultable:

    # the data plane predates all of this and has no recorded ID space; only
    # correct for a build seeded from the live artifact, and only above the
    # published head (nothing here can prove the ids continue, so clients
    # re-download rather than trusting it)
    python3 pipeline/publish.py rebuilt.sqlite <pub> --adopt-id-space

    # retire the ID space (a schema bump forces this, via --bootstrap). Needs a
    # revision above the published head; retires every delta; clients re-download
    python3 pipeline/publish.py fresh.sqlite <pub> --new-id-space

A schema bump chains all three: seeding across one is refused, so the rebuild
bootstraps, which mints a new lineage, which needs `--new-id-space`.

`pub/` is generated output and is not committed, and neither is the ledger that
sits beside it — `pipeline/published.json` locally,
`/var/www/meenan.dev/cve.pub/published.json` on `plex`, where no nginx location
reaches it. Deleting it is not free: it is what stops a rotated-away revision
being re-cut over its own immutable URLs, and it can only re-seed from whatever
the current manifest still describes. `tests/fixture_pub.py`
publishes a complete miniature data plane, which is what
`tests/unit/contract.test.ts` validates with the browser's own code.

## The monthly rotation

`snapshot.py` is the other cron, and it takes the same lock. It publishes the
artifact `ingest.py` last built — at the revision that artifact is stamped with,
which must be the published head — then keeps the previous generation and every
delta back to it and deletes what falls out the far end (D-060). It does not
fetch, does not build, and mints no revision: the daily already rebuilds the
whole database every run, so the rotation is chunk, compress, publish, retire.
85–101 s and 391 MB peak RSS on the real corpus, almost all of it compression.

One physical line, like the daily's, and for the same reason — `crontab(5)` has
no backslash continuation, so a wrapped entry runs the fragment before the break
and tries to parse the rest as more crontab lines. The day and hour are the
operator's call; an hour clear of the daily's 4:17 keeps the two from queueing
behind each other, and the shared lock is what makes a collision safe rather
than harmful:

    43 5 1 * * cd /var/www/meenan.dev && python3 /home/pmeenan/src/meenan.dev/cve/pipeline/snapshot.py cve.pub/data --state cve.data/state >> cve.data/state/snapshot.log 2>&1

**Installed in `pmeenan`'s crontab on `plex` since 2026-08-04**, with a comment
line above it saying how to remove it, and the previous crontab backed up beside
it. First unattended firing is 1 September.

Until a revision carries an artifact digest the rotation refuses: a snapshot
landing at head must *be* the artifact that head's content came from, and the
ledger recorded none before D-060. Confirmed on the live origin by running the
cron's own command line, which stopped with the message that names the fix. Only
a run that **mints a revision** clears it, so a quiet day does not — but the
first firing is a month of dailies away, so the cron cannot meet that state.

It waits up to 15 minutes for the lock rather than skipping, which is the
opposite of the daily's non-blocking take and deliberate: a daily finishing
underneath it only moves the head the rotation lands on, while skipping costs a
month and is the one outcome this job cannot record (recording needs the lock).
`--lock-wait` changes the bound.

Exit codes: **0** published, nothing to do, or the lock was still held after the
wait; **1** aborted. `--dry-run` reports what it would publish without touching
anything — including over a crashed daily, which it reports rather than
finishing. It answers the same questions the real run does, the artifact's
digest among them, so "the dry run was happy and the real one refused" is not a
state it can produce. Outcomes
land in the state as `last_snapshot`, separately from the daily's `last_run`,
because a monthly failure hidden under this morning's daily success costs a
month. `ingest.py status` reports both, along with the generation being served
(`snapshot_rev`), the head, and the delta count — how far head has moved past
the generation is the subtraction.

A rebuild that genuinely *changes* content — a normalization change, a schema
bump — is not this job. It cannot land at head, because a client already there
is told it is current and never fetches it, so it lands above head and every
client re-downloads. That is a hand-run `build.py` + `publish.py`, and if the
change is small enough to bridge, a delta from the old head to the new revision
is publishable now that the tiling rule allows one (D-060).

**Stop the daily first, or run it outside the cron window.** `publish.py` and
`delta.py` take no lock of their own — only `ingest.py` and `snapshot.py` do —
and both now write the manifest *and delete files* under retention. Racing the
4:17 daily loses one of the two manifest writes.

If such a run dies between the chunk rename and the manifest write it leaves a
`snapshot-<rev>/` directory nothing advertises. That is deliberate — those bytes
are what lets the retry resume without `--force`, so retention reports the
directory rather than deleting it — but it also means the *rotation* onto that
revision is refused while it is there (`generations are immutable`) unless the
bytes match. Finish the interrupted publish, or remove the directory once you
have established nothing was served from it; it stops mattering as soon as head
moves past that revision.

## The KEV catalog

`kev.py` is the third cron and the only one that is **not** part of the corpus
pipeline. It fetches CISA's Known Exploited Vulnerabilities catalog, validates
it fail-closed, and publishes the verbatim upstream bytes to
`cve.pub/data/kev.json` (D-010, D-076).

    mkdir -p /var/www/meenan.dev/cve.data/cache   # once: the redirect below cannot create it
    41 */6 * * * cd /var/www/meenan.dev && python3 /home/pmeenan/src/meenan.dev/cve/pipeline/kev.py run cve.pub/data --cache cve.data/cache >> cve.data/cache/kev.log 2>&1

One physical line, like the other two, for the same `crontab(5)` reason. Four
times a day rather than hourly: CISA publishes about business-daily, an
unchanged catalog costs 1.5 MB to confirm, and 00:41 / 06:41 / 12:41 / 18:41 is
clear of both the daily's 4:17 and the monthly's 5:43 — which matters less here
than it does between those two, because **this job shares nothing with them**.

**Its own failure domain, deliberately.** It takes no pipeline lock, reads no
ingest state, and writes no file the ingest writes; its own lock is
`cve.data/cache/kev.lock` and its own state `cve.data/cache/kev-state.json`. A
KEV fetch that fails leaves the corpus plane untouched and a corpus ingest that
aborts leaves the catalog serving. The two jobs share a `flock` helper and
nothing else — what makes two jobs mutually exclusive is naming the same file,
and they deliberately do not.

**Outside the manifest, and therefore needing its own nginx location** (D-076
§2). `kev.json` is already self-describing (`catalogVersion`, `dateReleased`,
`count`), its cadence is CISA's rather than the ingest's, and having two writers
rewrite `manifest.json` is a race. It is the data plane's *second* mutable file,
so it gets `location = /data/kev.json` at `no-cache` — the block is in
[architecture.md](../docs/architecture.md), and it had to land **before** the
first publish, because the first fetch through Cloudflare pins whatever policy
is in place.

**Every field this publishes is checked, and the bytes are published whole or
not at all.** The catalog must parse as a UTF-8 JSON object; carry a bounded
`title`, `catalogVersion` and `dateReleased`, the last of which must be a real
timestamp because it is what the UI renders as provenance; agree with its own
`count`; and hold at least one entry. Every entry must carry all eleven fields
with the right types, a canonical `cveID` that appears exactly once, and dates
that are real days rather than merely `YYYY-MM-DD`-shaped. Every string is
bounded and must have a UTF-8 encoding, which is RE-015 applied to the second
untrusted source — a lone surrogate is legal JSON and cannot be written to
SQLite on either side. `Infinity` and `NaN` are refused because Python parses
them and `JSON.parse` does not: these bytes ship verbatim, so one such value
anywhere in the document — even in a key nothing here reads — would take the
overlay down for every user while the cron reported success.

What is deliberately **not** checked is anything beyond that: unknown keys ride
along, because the bytes are CISA's. There is no partial publish either — half a
known-exploited list read as a whole one is worse than yesterday's — so a
refusal leaves the previous catalog serving unchanged. One entry per CVE is what
makes the client's join 1:1 and every KEV count DISTINCT-safe, which is why a
duplicate is a refusal rather than a dedup.

**And a roll-backwards guard**, M5's data-plane review applied in advance: a
catalog older than the published one is refused. Under a mutable URL that
failure is silent — the file simply becomes an older list, with the freshness
line still asserting whatever it says. Ordering comes from `catalogVersion` when
it reads as a dated version (so `2026.08.07.1` sorts after `2026.08.07`) and
from `dateReleased` otherwise.

**The guard's own failure mode is the one worth understanding**, because it is
sticky by construction: whatever is published defends itself against everything
that follows. So a version is only an ordering basis when its leading component
is a plausible year — `20260.08.09`, one fat-finger from real, would otherwise
outrank every genuine catalog until the year 20260 — and a `dateReleased` more
than two days ahead of the clock is refused outright, which is what stops a
single hostile or hijacked response from freezing the catalog permanently while
rendering as fresh. A version scheme this build does not read is *not* a
refusal; it falls back to `dateReleased`, because wedging on a benign upstream
change is the failure `knownRansomwareCampaignUse` is deliberately handled to
avoid, and it applies here too. `--force` is for a rollback someone actually
intends.

**A failure of any kind is recorded**, not just a validation refusal: a run that
died on a full disk or a permissions change is exactly the one where a `status`
reading "healthy" would be worst, because the catalog freezes and every signal
says it did not. The fetch is bounded in bytes *and* in wall-clock — a socket
timeout bounds each read, not the transfer, and this job holds its lock across
the fetch, so a peer dribbling one byte per timeout would be a permanent freeze
that exits 0 four times a day.

`knownRansomwareCampaignUse` is deliberately **not** held to an enum. A third
value would wedge the cron on a benign upstream change, and folding one into
`Unknown` would invent a finding — so the run reports the distribution
(`"ransomware": {"Known": 338, "Unknown": 1324}`) and the client gives anything
it does not recognise its own visible band.

Exit codes: **0** published, unchanged, or the lock was held; **1** the run
failed and nothing was published. `--dry-run` fetches, validates and guards
without publishing or touching state. Like the other two jobs, a failure mails
nobody — `kev.py status` is the alert, and reports what is being served
(`catalogVersion`, `dateReleased`, entry count, bytes) beside when this job last
ran and last succeeded.

### The development catalog

The real catalog is the wrong fixture for the development slice: the slice is
2026 records and KEV is mostly older CVEs, so joining the two matches almost
nothing and every count in a test is zero. `kev.py sample` writes a catalog in
CISA's shape from the slice's own CVE ids — plus two the corpus does not hold,
because "an entry whose CVE the corpus lacks is kept and counted" is a claim
that needs one to be true — and `run --from-file` publishes it through *the same*
validation and the same guard, so the local plane's catalog is provably one the
real path would have accepted:

    python3 pipeline/kev.py sample slice.sqlite /tmp/kev-sample.json
    python3 pipeline/kev.py run pipeline/pub --cache pipeline/kev-cache --from-file /tmp/kev-sample.json

`sample` publishes nothing and never touches a `pub_dir`.
