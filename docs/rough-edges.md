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

**Note for re-verification.** Behavior confirmed on 3.45.1 only. The browser
ships a different and newer SQLite via `@sqlite.org/sqlite-wasm`; re-run this in
M1 rather than assuming it carries over.

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
