# Architecture

> **Status: skeleton.** The first full draft is an M0 exit criterion; what is
> written here now is the load-bearing shape already settled, so drafting can
> build on it rather than re-derive it.

## Fixed points (from decisions)

Each of these is backed by a decision entry and is not up for casual revision.

- **Two components, one direction of data flow.** A static browser application
  and a single same-origin PHP endpoint. Data flows server → browser only. The
  endpoint receives no analytical input and stores no user state. (D-006, D-007)
- **git runs server-side.** `plex` holds a clone of cvelistV5 and is the source
  of record for everything the endpoint serves. The browser bundle contains no
  git implementation. Full history is available server-side, which the client
  cannot otherwise obtain. (D-005)
- **The browser's store is SQLite/WASM on OPFS.** The database is owned by a
  Worker, because OPFS synchronous access handles are unavailable on the main
  thread. (D-004)
- **One origin.** Everything ships to `plex:/var/www/meenan.dev/cve/` and is
  served from `https://cve.meenan.dev/`; nginx routes `*.php`. There is no
  cross-origin fetch in the normal path, which is what makes same-origin
  enforcement at the endpoint meaningful. (D-003, D-006)
- **Record content is untrusted input.** CVE text is attacker-influenced and
  crosses a trust boundary at parse time, at SQL time, and at render time.
  (AGENTS.md rule 5)
- **Every copy of CVE data carries its notice.** MITRE's copyright designation
  and the CVE Terms of Use travel with served artifacts and with anything a user
  exports. A format that cannot carry the notice in-band needs a deliberate
  answer, not an omission. (D-008)

## Expected shape (to be validated in the M0 draft)

Where a bullet below leans on a `proposed` [features.md](features.md) row, it is
a design assumption to confirm during feature triage, not settled scope.

- **A four-stage pipeline:** git clone → server-derived artifact → transfer →
  local SQLite. The *seam between stages 2 and 4 is undecided* and is the
  highest-leverage open question. Three candidates are live — bulk import, a
  projection API, and a range-request VFS over a static database file — and they
  differ in transfer size, cold-start cost, schema ownership, sync complexity,
  and what the server learns. They are enumerated with their tradeoffs in
  [features.md](features.md) open question 1 and measured by the M0 bake-off.
  **Do not assume a full local copy of the corpus exists.** A demand-driven
  cache that grows with exploration is the direction the owner is leaning, so
  code and docs written before the bake-off should avoid baking in the
  assumption that every record is present locally.
- **Whatever the seam, two invariants hold.** *Correctness:* a query must never
  run against a partially populated cache and return a plausible undercount —
  either the missing data is fetched or the query fails loudly, because a wrong
  number in a security tool is worse than an error. *Privacy:* the server must
  not learn the user's predicates (D-007); field sets and partition ranges are
  negotiable, `vendor = X` is not.
- **A Worker-owned database, with the UI talking to it over messages.** This
  follows from OPFS's threading constraints rather than from taste, and it means
  every query is asynchronous from the UI's perspective regardless of framework.
- **A cache of derived artifacts on the server**, keyed by whatever identifies a
  sync position (open question 6). The endpoint should be serving precomputed
  bytes, not running git per request.
- **Client-side sync state**, recording the local watermark and schema version,
  so an update fetches a delta and a schema change triggers migration rather
  than a silent mismatch. Both depend on `proposed` rows.
- **A capability gate before the import path**, since an unsupported browser
  should be told on arrival rather than fail partway through a large import.
- **Storage sized in advance, not discovered.** The corpus is large enough that
  quota, eviction, and `navigator.storage.persist()` are part of the import
  design rather than error handling bolted on later.

## Deliberately absent

- **No client-side git.** Rejected with measurements in D-005; do not
  reintroduce isomorphic-git or a CORS proxy without reopening that decision.
- **No server-side query execution.** Rejected in D-007 — it would forfeit the
  project's central property.
- **No direct browser fetches to GitHub bulk endpoints.** Measured
  CORS-blocked on 2026-07-30 (release assets, codeload zipball/tarball, git
  smart-HTTP). `raw.githubusercontent.com` and `api.github.com` do send
  `access-control-allow-origin: *` and remain usable as a fallback or
  cross-check, but they are not the primary path.

## Open architecture questions

The full list, with the M0 task that answers each, lives in
[features.md](features.md) under "Open questions" — questions 1–6 and 9 are
architectural. Purely technical questions not tracked there:

- **Where the JSON→relational transform runs** has a corollary nobody has
  costed: whichever side owns it also owns schema migration. A server-owned
  schema makes migrations a server deploy plus a client re-import; a
  client-owned schema makes them a client-side migration against a large local
  database. Both are viable; they are not equally cheap.
- **What the endpoint's cache invalidation looks like** when `git fetch` brings
  in a rewritten or force-pushed history. Rare, but the failure mode is silently
  serving deltas that never converge.
- **Whether a rebuild of the server artifact destroys every client's cache.**
  Under a demand-driven design the client accumulates value over time, which
  makes that accumulation something the server can casually throw away: rebuild
  the database file and every cached page may be invalid. Immutable per-year
  partitions plus a small mutable recent partition is the obvious shape, since
  CVE records for closed years rarely change — but "rarely" is not "never," and
  republished old records are exactly the case that would break it.
- **Whether full-text search survives a demand-driven design.** Facet and count
  queries project down to a few narrow columns and partial-fetch beautifully.
  Free-text search over descriptions does not project — it wants the text. The
  likely answer is a hybrid where full-text is an opt-in bulk download, but that
  should be decided rather than discovered.
- **Whether the deploy's rsync semantics can coexist with server-side state.**
  D-003 notes the hazard: a mirroring rsync under the document root would delete
  the clone or artifact cache. The likely answer is keeping that state outside
  the document root, which needs deciding before the deploy script is written,
  not after it destroys something.
