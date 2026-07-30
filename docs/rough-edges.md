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
