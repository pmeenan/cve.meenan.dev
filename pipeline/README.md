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

    # chunk, compress and publish, writing manifest.json
    python3 pipeline/publish.py slice.sqlite pipeline/pub

    # emit a delta from a changeset and register it in the manifest
    python3 pipeline/delta.py next.sqlite pipeline/pub changeset.json

    # or, in production, do all of that as one daily cycle (D-058)
    python3 pipeline/ingest.py run <clone> <pub-dir> --state <state-dir>

    # and once a month, rotate the generation onto the artifact that cycle
    # last built (D-060) — no rebuild, no fetch, no new revision
    python3 pipeline/snapshot.py <pub-dir> --state <state-dir>

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
| `state.py` | What the corpus looked like at the published head — a content hash per record, the revision each last changed at, the tombstone log, the seed pointer and the pending run. Plus the `flock` both crons take and one outcome record per cron. Lives in `cve.data/`, never served. |
| `tests/` | unittest suite (CVSS priority, notice components, hostile shapes, the delta contract with a reference apply, the ID space's stability under rebuilds, and the ingest's guards and re-run semantics) — part of `pnpm check` via `pnpm test:pipeline`. |

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

**Not installed yet.** The first rotation on the live origin is refused until
one daily run has *published a delta* — a snapshot landing at head must be the
artifact that head's content came from, and the ledger had no record of it
before D-060. Verified against the live ledger: the run stops with the message
that names the fix. A day is usually enough, but the run has to mint a revision
to record anything, so a quiet day does not clear it; `ingest.py status` shows
the head moving when it has.

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
