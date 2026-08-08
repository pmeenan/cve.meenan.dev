"""The CISA KEV catalog: fetch, validate, publish (D-010, D-076).

    python3 pipeline/kev.py run    <pub-dir> --cache <cache-dir>
    python3 pipeline/kev.py status <pub-dir> --cache <cache-dir>

**Its own cron, and deliberately its own failure domain.** It takes no pipeline
lock, reads no ingest state, and writes nothing the ingest writes — so a KEV
fetch that fails leaves the corpus plane untouched, and a corpus ingest that
aborts leaves the catalog serving. The two jobs share a `flock` *helper* and
nothing else; the lock file this one takes lives in the cache directory and is
named after this job (`state.lock`'s `name` argument exists for exactly this).

**Published verbatim, outside the manifest** (D-076 §2). `kev.json` is CISA's
own bytes: already self-describing (`catalogVersion`, `dateReleased`, `count`),
on a cadence the ingest has no say in, and short-cached rather than immutable.
The manifest never names it, so the two writers never touch one file. The
consequence is that it needs its own nginx location, and that location has to
exist **before** the first publish, because the first fetch through Cloudflare
pins whatever policy is in place — the block is in docs/architecture.md.

**Validation is fail-closed and happens before anything is published.** A
catalog that does not parse, is missing a required field, disagrees with its own
`count`, names a CVE twice or carries a malformed id is refused whole: the
previous catalog keeps serving, which is what "keep last good" means here. There
is no partial publish, because half a known-exploited list read as a whole one
is worse than yesterday's.

**And a roll-backwards guard**, which is M5's data-plane review applied in
advance rather than after the fact: a catalog older than the one already
published is refused. Under a mutable URL the failure it prevents is silent —
the file simply becomes an older list, with the freshness line still asserting
whatever it says.

Exit codes: **0** published, nothing to do, or the lock was held; **1** the run
failed and nothing was published.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import http.client
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request

from state import Busy, lock

EXIT_OK = 0
EXIT_FAIL = 1

# The official feed, then CISA's own mirror (D-076 §3). The feed answers a plain
# fetch today, but the same host's Akamai configuration 403s non-browser callers
# on sibling paths — the published JSON schema beside it is one, re-confirmed
# 2026-08-08 — so the cron's fetch path is one config change away from being
# refused. `cisagov/kev-data` is CISA's own repository, carries the identical
# CC0 LICENSE, updates the same day, and served byte-identical content when
# both were fetched 2026-08-08.
#
# Both are **constants**. Nothing a caller, a record or a catalog supplies ever
# reaches a URL here: D-006's rule is about request handlers, and the pipeline
# holds itself to it too (`ingest.fetch` says the same about git refs).
FEED_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"
MIRROR_URL = (
    "https://raw.githubusercontent.com/cisagov/kev-data/main/known_exploited_vulnerabilities.json"
)

# Identifies the fetcher rather than hiding it. If CISA ever decides to refuse
# us this is what they will refuse, which makes the refusal diagnosable instead
# of a mystery 403 attributed to "python".
USER_AGENT = "cve.meenan.dev-kev/1.0 (+https://cve.meenan.dev/)"

FETCH_TIMEOUT = 60.0

# The catalog is 1.58 MB and 1,662 entries (measured 2026-08-08). Both bounds
# are ~20x that: large enough that ordinary growth never trips them, small
# enough that a redirect to something else is refused before it is parsed.
MAX_BYTES = 32 * 1024 * 1024
MAX_ENTRIES = 100_000

PUBLISHED_NAME = "kev.json"
STATE_NAME = "kev-state.json"
LOCK_NAME = "kev.lock"
STATE_VERSION = 1

# Every entry carries all eleven of these, at 100% (measured against the live
# catalog, 2026-08-08). They are required rather than optional because a KEV
# row with no `requiredAction` or no `dateAdded` is not a row worth rendering,
# and discovering that in the browser would mean discovering it 1,662 times.
STRING_FIELDS = (
    "cveID",
    "vendorProject",
    "product",
    "vulnerabilityName",
    "dateAdded",
    "shortDescription",
    "requiredAction",
    "dueDate",
    "knownRansomwareCampaignUse",
    "notes",
)
LIST_FIELDS = ("cwes",)

CVE_ID_RE = re.compile(r"^CVE-\d{4}-\d{4,12}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
NUMERIC_VERSION_RE = re.compile(r"^\d+(\.\d+)*$")

# Bounds on individual values, so one pathological entry cannot become the
# largest thing the client stores. Generous: the longest `requiredAction` today
# is under 1 KB and the longest `notes` 724 bytes.
MAX_FIELD_CHARS = 20_000
MAX_CWES = 32

# The three top-level strings are bounded too, and it is not a formality: they
# are what the UI renders as provenance ("per CISA, as of <dateReleased>"), and
# `catalogVersion` additionally goes through `int()` — where CPython's 4,300
# digit conversion limit turns an unbounded digit run into a `ValueError` from
# inside the validator.
MAX_HEADER_CHARS = 200

# How far ahead of this machine's clock a `dateReleased` may be.
#
# **This is what stops the roll-backwards guard being poisonable.** Without a
# ceiling, one catalog claiming a far-future version — from a hostile upstream,
# a hijacked fetch, or a CISA fat-finger — is published once and then *defended*
# by the guard against every genuine catalog that follows, forever, with the
# stale list rendering as fresh because the attacker also chose `dateReleased`.
# Two days is slack for clock skew and for a release stamped ahead of when we
# see it; anything beyond that is not a catalog, it is a claim about the future.
MAX_FUTURE_SECONDS = 2 * 86_400

# The earliest plausible `catalogVersion` year. KEV began in November 2021; 1999
# is the CVE program's own epoch and is deliberately looser than needed, because
# the point of this bound is to reject 20260 and 99999999, not to police CISA.
MIN_VERSION_YEAR = 1999

# A hard wall-clock deadline for one fetch, distinct from the socket timeout
# below. `urlopen(timeout=)` bounds each individual socket operation, so a peer
# that sends one byte every 59 seconds holds the connection indefinitely while
# never timing out — and this job holds its lock across the fetch, so that is a
# permanent freeze that exits 0 four times a day. Measured against a
# deliberately dribbling local server: a 2 s socket timeout held for 12 s.
MAX_FETCH_SECONDS = 300.0

# How much is read per loop iteration, so the deadline is checked often enough
# to bound the transfer rather than only the gaps in it.
READ_CHUNK = 1 << 20


class Refuse(Exception):
    """The catalog was not published, and why. Nothing has been written."""


# --- validation -----------------------------------------------------------


def validate(blob: bytes) -> dict:
    """Parse and check a catalog, or refuse it. Returns the parsed object.

    Everything here is a *fail-closed* check on bytes that arrived over the
    network, and the order matters: size before parse, shape before contents,
    contents before anything is compared against what is already published.
    """
    if not isinstance(blob, (bytes, bytearray)):
        raise Refuse("catalog is not bytes")
    if len(blob) == 0:
        raise Refuse("catalog is empty")
    if len(blob) > MAX_BYTES:
        raise Refuse(f"catalog is {len(blob)} bytes, over the {MAX_BYTES} byte limit")

    try:
        # `parse_constant` is the one JSON difference that matters here, and it
        # is not cosmetic. Python accepts `Infinity`, `-Infinity` and `NaN`;
        # `JSON.parse` in every browser refuses them. Since these bytes are
        # published *verbatim*, one such value anywhere in the document — even
        # in a key nothing here reads — passes this validator and then takes the
        # KEV overlay down for every user, while the cron reports success.
        catalog = json.loads(blob.decode("utf-8"), parse_constant=_refuse_constant)
    # Python's decoder recurses, so deeply nested input raises `RecursionError`
    # rather than a decode error — not a `Refuse`, and it would otherwise escape
    # `run` as a traceback with the state left reading healthy.
    except RecursionError as error:
        raise Refuse("catalog is nested too deeply to parse safely") from error
    except (ValueError, UnicodeDecodeError) as error:
        raise Refuse(f"catalog is not UTF-8 JSON: {error}") from error
    if not isinstance(catalog, dict):
        raise Refuse("catalog is not a JSON object")

    for key in ("title", "catalogVersion", "dateReleased"):
        value = catalog.get(key)
        if not isinstance(value, str) or not value.strip():
            raise Refuse(f"catalog {key} is missing or not a non-empty string")
        if len(value) > MAX_HEADER_CHARS:
            raise Refuse(f"catalog {key} is {len(value)} characters, over {MAX_HEADER_CHARS}")
        _assert_storable(value, f"catalog {key}")

    # `dateReleased` is the provenance line the UI renders and the ordering
    # basis whenever `catalogVersion` is not a plausible dated version, so it
    # has to be a timestamp rather than merely a non-empty string. It was
    # previously checked for neither, which meant `"dateReleased": "banana"`
    # published clean and rendered as an age.
    released = _released_at(str(catalog["dateReleased"]))
    if released is None:
        raise Refuse(f"catalog dateReleased {catalog['dateReleased']!r} is not a timestamp")
    if released > time.time() + MAX_FUTURE_SECONDS:
        raise Refuse(
            f"catalog dateReleased {catalog['dateReleased']!r} is more than "
            f"{MAX_FUTURE_SECONDS // 86400} days in the future; refusing it rather than letting "
            "the roll-backwards guard defend it against every real catalog that follows"
        )

    entries = catalog.get("vulnerabilities")
    if not isinstance(entries, list):
        raise Refuse("catalog vulnerabilities is not a list")
    if len(entries) > MAX_ENTRIES:
        raise Refuse(f"catalog carries {len(entries)} entries, over the {MAX_ENTRIES} limit")
    if len(entries) == 0:
        # An empty known-exploited list is not a state CISA has ever published,
        # and rendering one would say "nothing is known to be exploited".
        raise Refuse("catalog carries no entries")

    count = catalog.get("count")
    if not isinstance(count, int) or isinstance(count, bool):
        raise Refuse("catalog count is missing or not an integer")
    # The one check that catches a truncated body which still happens to parse
    # — a JSON array closed early by a proxy, say. `count` is upstream's own
    # statement of how many entries it meant to send.
    if count != len(entries):
        raise Refuse(f"catalog count is {count} but it carries {len(entries)} entries")

    seen: set[str] = set()
    for at, entry in enumerate(entries):
        _validate_entry(entry, at, seen)
    return catalog


def _refuse_constant(name: str):
    raise Refuse(f"catalog carries the JSON constant {name}, which a browser's JSON.parse refuses")


def _assert_storable(value: str, where: str) -> None:
    """Refuse text that has no UTF-8 encoding — RE-015, for the second source.

    A lone surrogate is legal JSON (`"\\ud800"`) and Python will happily hold
    it, but it has no UTF-8 encoding, so it cannot be written to SQLite on
    either side. `build.py` closed this for corpus records on 2026-08-08; the
    KEV catalog reaches the same destination through a different door, and
    finding out in the browser means finding out 1,662 times.
    """
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise Refuse(f"{where} carries text with no UTF-8 encoding (RE-015): {error}") from error


def _validate_entry(entry: object, at: int, seen: set[str]) -> None:
    where = f"entry {at}"
    if not isinstance(entry, dict):
        raise Refuse(f"{where} is not an object")
    for field in STRING_FIELDS:
        value = entry.get(field)
        if not isinstance(value, str):
            raise Refuse(f"{where}: {field} is missing or not a string")
        if len(value) > MAX_FIELD_CHARS:
            raise Refuse(f"{where}: {field} is {len(value)} characters, over {MAX_FIELD_CHARS}")
        _assert_storable(value, f"{where}: {field}")

    cve_id = entry["cveID"]
    if not CVE_ID_RE.match(cve_id):
        raise Refuse(f"{where}: cveID {cve_id!r} is not a canonical CVE identifier")
    # One entry per CVE is what makes the client's join 1:1, and with it every
    # KEV count DISTINCT-safe without a DISTINCT. A duplicate would double a
    # record in exactly the aggregates this overlay exists to produce.
    if cve_id in seen:
        raise Refuse(f"{where}: {cve_id} appears twice in the catalog")
    seen.add(cve_id)

    for field in ("dateAdded", "dueDate"):
        # Shape *and* calendar: `2026-13-45` matches the pattern and is not a
        # day, and the client turns both of these into timestamps.
        if not DATE_RE.match(entry[field]):
            raise Refuse(f"{where}: {field} {entry[field]!r} is not YYYY-MM-DD")
        try:
            datetime.date.fromisoformat(entry[field])
        except ValueError as error:
            raise Refuse(f"{where}: {field} {entry[field]!r} is not a real date") from error

    for field in LIST_FIELDS:
        value = entry.get(field)
        if not isinstance(value, list):
            raise Refuse(f"{where}: {field} is missing or not a list")
        if len(value) > MAX_CWES:
            raise Refuse(f"{where}: {field} carries {len(value)} values, over {MAX_CWES}")
        for at_item, item in enumerate(value):
            if not isinstance(item, str):
                raise Refuse(f"{where}: {field}[{at_item}] is not a string")
            # Bounded like every other string here: `MAX_FIELD_CHARS` applied
            # only to the named fields, which left one list item as the one
            # unbounded value in an entry.
            if len(item) > MAX_FIELD_CHARS:
                raise Refuse(f"{where}: {field}[{at_item}] is over {MAX_FIELD_CHARS} characters")
            _assert_storable(item, f"{where}: {field}[{at_item}]")


def _numeric_version(value: str) -> tuple[int, ...] | None:
    """`2026.08.07` as a comparable tuple, or None if it is not a dated version.

    CISA has used `YYYY.MM.DD` throughout, and a same-day second release would
    plausibly become `YYYY.MM.DD.N` — which this handles, because comparing
    tuples of unequal length does the right thing (`(2026, 8, 7) <
    (2026, 8, 7, 1)`).

    **The leading component has to be a plausible year, and that bound is what
    makes the guard un-poisonable rather than merely tidy.** A version of
    `20260.08.09` — one fat-finger, or one hostile response — is otherwise
    published once and then defended by the roll-backwards guard against every
    genuine catalog forever. Refusing it outright would be the other wedge, so
    a version that fails this test is not refused: it simply stops being an
    ordering basis, and `dateReleased` — which `validate` bounds to the near
    present — orders it instead. The same fallback covers a benign upstream
    change of version scheme, which is the failure `_ransomware_counts` is
    deliberately built to avoid and this must avoid too.
    """
    text = value.strip()
    if not NUMERIC_VERSION_RE.match(text):
        return None
    # Bounded before `int()`: CPython refuses to convert a digit run longer than
    # 4,300 characters and raises `ValueError` from inside the validator. The
    # header-length bound above already stops that, and this is the second lock
    # on the same door.
    parts = text.split(".")
    if any(len(part) > 8 for part in parts):
        return None
    numbers = tuple(int(part) for part in parts)
    year = numbers[0]
    if year < MIN_VERSION_YEAR or year > datetime.date.today().year + 1:
        return None
    return numbers


def _released_at(value: str) -> float | None:
    """`dateReleased` as a timestamp, or None. The fallback ordering."""
    text = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    return parsed.timestamp()


def _order_key(catalog: dict) -> tuple[str, object] | None:
    """How this catalog is ordered against another, tagged with which basis.

    Two bases, never mixed: a version tuple is compared with a version tuple and
    a release timestamp with a release timestamp. Comparing across them would be
    comparing `(2026, 8, 7)` with a unix second, which is not an ordering — it
    is a coincidence that happens to be a number.

    A catalog that has been through `validate` always has at least the second
    basis, so `None` here only ever describes something *already published* —
    a file from an older build, or one a proxy overwrote — which the guard
    treats as "no floor" rather than as a reason to stop publishing.
    """
    version = _numeric_version(str(catalog.get("catalogVersion", "")))
    if version is not None:
        return ("version", version)
    released = _released_at(str(catalog.get("dateReleased", "")))
    if released is not None:
        return ("released", released)
    return None


def is_newer(incoming: dict, published: dict) -> bool | None:
    """Whether `incoming` is at or above `published`.

    `None` means the two cannot be ordered. After `validate` that can only
    happen when the *published* side is unorderable — see `_order_key` — and it
    is deliberately not a refusal: refusing would leave whatever is at the URL
    serving forever, which is the opposite of what the guard is for.

    Falls back to comparing release timestamps when the two disagree about
    basis, which is what keeps a change of version scheme from being a wedge:
    both sides went through `validate`, so both have a `dateReleased` that
    parses, and it is monotonic where the version string is not.
    """
    left, right = _order_key(incoming), _order_key(published)
    if left is None or right is None:
        return None
    if left[0] != right[0]:
        both = (_released_at(str(incoming.get("dateReleased", ""))),
                _released_at(str(published.get("dateReleased", ""))))
        if both[0] is None or both[1] is None:
            return None
        return both[0] >= both[1]
    return left[1] >= right[1]  # type: ignore[operator]


# --- what is published, and what this job remembers -------------------------


def published_path(pub_dir: str) -> str:
    return os.path.join(pub_dir, PUBLISHED_NAME)


def published_catalog(pub_dir: str) -> dict | None:
    """The catalog currently being served, or None if there is not one.

    Read back from the *published file* rather than from this job's own notes,
    because the file is what clients see, and a guard that trusted a private
    record would be defending a number nobody else can observe. A file that is
    there but unreadable returns None and is reported: it cannot bound anything,
    and refusing to publish over corruption would leave the corruption serving.
    """
    try:
        with open(published_path(pub_dir), "rb") as handle:
            blob = handle.read(MAX_BYTES + 1)
    except FileNotFoundError:
        return None
    try:
        catalog = json.loads(blob.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    return catalog if isinstance(catalog, dict) else None


def state_path(cache_dir: str) -> str:
    return os.path.join(cache_dir, STATE_NAME)


def load_state(cache_dir: str) -> dict:
    try:
        with open(state_path(cache_dir), encoding="utf-8") as handle:
            recorded = json.load(handle)
    except (FileNotFoundError, ValueError):
        return {}
    return recorded if isinstance(recorded, dict) else {}


def save_state(cache_dir: str, values: dict) -> None:
    """Atomic, like every other file this pipeline writes: `status` reads it
    without a lock, and a half-written state would read as a job that has never
    run."""
    os.makedirs(cache_dir, mode=0o755, exist_ok=True)
    target = state_path(cache_dir)
    scratch = f"{target}.{os.getpid()}.tmp"
    with open(scratch, "w", encoding="utf-8") as handle:
        json.dump(values, handle, indent=2, sort_keys=True)
    os.chmod(scratch, 0o644)
    os.replace(scratch, target)


def publish(pub_dir: str, blob: bytes) -> str:
    """Write the verbatim bytes into place by atomic rename; return their digest.

    Verbatim (D-076 §1): CC0 asks for nothing to travel with the data, and
    re-serialising would make our copy differ from CISA's for no reason anybody
    could audit. The client validates what it reads on every fetch regardless.

    pid-qualified scratch name, for the reason `manifest.save` uses one: a fixed
    name lets a second process delete the file this one is about to rename.
    """
    os.makedirs(pub_dir, mode=0o755, exist_ok=True)
    target = published_path(pub_dir)
    scratch = f"{target}.{os.getpid()}.tmp"
    try:
        with open(scratch, "wb") as handle:
            handle.write(blob)
            # The rename is what makes this atomic; the flush is what makes the
            # renamed file the whole catalog after a power loss rather than a
            # prefix of it.
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(scratch, 0o644)
        os.replace(scratch, target)
    except BaseException:
        # This directory is **web-reachable**, and `^~ /data/` would serve a
        # leftover `.tmp` as `immutable` for a year. A failed publish must not
        # leave one behind, and a retry must not accumulate them.
        try:
            os.unlink(scratch)
        except OSError:
            pass
        raise
    return hashlib.sha256(blob).hexdigest()


# --- fetching ---------------------------------------------------------------


def download(
    url: str, timeout: float = FETCH_TIMEOUT, deadline: float = MAX_FETCH_SECONDS
) -> bytes:
    """One URL, bounded in **bytes and in wall-clock**.

    `urlopen(timeout=)` bounds each individual socket operation, not the
    transfer: a peer that sends one byte just inside the timeout holds the
    connection for as long as it likes and never trips it. That matters more
    here than it would elsewhere, because this job holds its lock across the
    fetch — so an indefinite read is an indefinite freeze that exits 0 on every
    subsequent run. Reproduced against a dribbling local server: a 2 s socket
    timeout held the connection for 12 s and scaled linearly.

    So the body is read in chunks against a monotonic deadline. Reads one byte
    past the size limit too, so an oversized body is refused rather than
    silently truncated to it.
    """
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    stop_at = time.monotonic() + max(1.0, float(deadline))
    # `url` is one of this module's two constants; nothing reaches it from a
    # caller, a record or a catalog.
    with urllib.request.urlopen(request, timeout=timeout) as response:
        parts: list[bytes] = []
        received = 0
        while received <= MAX_BYTES:
            if time.monotonic() > stop_at:
                raise Refuse(f"{url}: still sending after {deadline:.0f}s; giving up")
            piece = response.read(min(READ_CHUNK, MAX_BYTES + 1 - received))
            if not piece:
                break
            parts.append(piece)
            received += len(piece)
    if received > MAX_BYTES:
        raise Refuse(f"{url}: response exceeds the {MAX_BYTES} byte limit")
    return b"".join(parts)


def fetch(sources: tuple[str, ...] = (FEED_URL, MIRROR_URL)) -> tuple[bytes, str]:
    """The first source that answers, and which one it was.

    The mirror is a fallback for a *transport* failure, not for a validation
    one: a catalog that fetched and then failed validation is a bad catalog, and
    asking a second host for the same bad catalog would just take longer to
    refuse it. So this returns bytes and lets the caller validate once.

    `http.client.HTTPException` is on the list deliberately — it is **not** an
    `OSError`, and it is what a truncated or malformed HTTP response raises, so
    without it the exact class of failure D-076 §3 added the mirror for would
    never reach the mirror. `Refuse` is on it for the same reason: an oversized
    body from the first source is a fact about that source, not about CISA's
    catalog.
    """
    problems: list[str] = []
    for url in sources:
        try:
            return download(url), url
        except (
            urllib.error.URLError,
            http.client.HTTPException,
            OSError,
            ValueError,
            Refuse,
        ) as error:
            problems.append(f"{url}: {error}")
    raise Refuse("; ".join(problems) or "no sources configured")


# --- the cron ---------------------------------------------------------------


def run(
    pub_dir: str,
    cache_dir: str,
    *,
    sources: tuple[str, ...] = (FEED_URL, MIRROR_URL),
    fetcher=None,
    from_file: str | None = None,
    force: bool = False,
    dry_run: bool = False,
) -> dict:
    """One KEV cycle: fetch, validate, guard, publish, record.

    `from_file` reads a catalog off local disk instead of the network. It is a
    development affordance — it is how `pipeline/pub` gets a catalog to serve
    the e2e suite — and it deliberately goes through *the same* validation and
    the same guard, so a locally-published catalog is provably one the real path
    would have accepted. It is a local path from the operator, not a URL and not
    anything a record or a caller supplies, so D-006's rule is untouched.

    `fetcher` replaces the transport, and exists so the suite can exercise the
    *failure* half of this job — a fetch that refuses, and what the published
    file looks like afterwards — which `from_file` cannot express because it
    always succeeds. It is never set outside tests; the CLI has no flag for it.
    """
    os.makedirs(cache_dir, mode=0o755, exist_ok=True)
    started = int(time.time())
    with lock(cache_dir, name=LOCK_NAME):
        recorded = load_state(cache_dir)
        try:
            report = _cycle(
                pub_dir,
                cache_dir,
                recorded,
                sources=sources,
                fetcher=fetcher,
                from_file=from_file,
                force=force,
                dry_run=dry_run,
                started=started,
            )
        except Exception as failure:
            # **Every** failure, not just `Refuse`. Nothing was published, so
            # the previous catalog is still being served — which is the whole
            # shape of this job's failure mode, and the reason the outcome has
            # to be *findable*. `plex` has no MTA and D-009 rules out telemetry,
            # so `kev.py status` is the alert (ingest.py made the same call for
            # the same reason, D-058), and a run that died on a full disk, a
            # permissions change, or a shape nobody anticipated is exactly the
            # one where a status reading "healthy" is worst: the catalog freezes
            # and every signal says it did not.
            if not dry_run:
                _record(
                    cache_dir,
                    recorded,
                    ok=False,
                    message=f"{type(failure).__name__}: {failure}",
                    started=started,
                )
            raise
        if not dry_run:
            _record(cache_dir, recorded, ok=True, message="", started=started, extra=report["state"])
        return report["report"]


def _cycle(
    pub_dir: str,
    cache_dir: str,
    recorded: dict,
    *,
    sources: tuple[str, ...],
    fetcher,
    from_file: str | None,
    force: bool,
    dry_run: bool,
    started: int,
) -> dict:
    if from_file is not None:
        with open(from_file, "rb") as handle:
            blob = handle.read(MAX_BYTES + 1)
        source = f"file:{from_file}"
    elif fetcher is not None:
        blob, source = fetcher()
    else:
        blob, source = fetch(sources)

    catalog = validate(blob)
    digest = hashlib.sha256(blob).hexdigest()

    current = published_catalog(pub_dir)
    action = "published"
    if current is not None:
        newer = is_newer(catalog, current)
        if newer is None:
            # The published file parses but carries nothing orderable — an older
            # build's output, or something a proxy wrote over it. It cannot be a
            # floor, and **refusing here would leave it serving forever**, which
            # is the opposite of what the guard is for. Publish over it and say
            # so, so an operator sees the anomaly rather than a wedged cron.
            action = "published-over-unorderable"
        elif newer is False and not force:
            raise Refuse(
                f"fetched catalog {catalog['catalogVersion']!r} is older than the published "
                f"{current.get('catalogVersion')!r}; refusing to roll the catalog backwards "
                "(--force overrides, for a rollback someone actually intends)"
            )
        if digest == recorded.get("published_sha256") and _same_bytes(pub_dir, digest):
            action = "unchanged"

    state_update = {
        "published_version": str(catalog["catalogVersion"]),
        "published_released": str(catalog["dateReleased"]),
        "published_entries": len(catalog["vulnerabilities"]),
        "published_bytes": len(blob),
        "published_sha256": digest,
        "published_at": started,
        "source": source,
    }
    if action == "unchanged":
        # Same bytes already in place: the fetch still succeeded, so `last_ok`
        # advances (that is what "is this job healthy?" asks), but the publish
        # timestamp keeps naming the run that actually changed the file.
        state_update["published_at"] = int(recorded.get("published_at") or started)
    elif not dry_run:
        publish(pub_dir, blob)

    # A dry run says what it *would* do — except for "unchanged", which is
    # already that: the bytes are in place either way.
    outcome = action if (not dry_run or action == "unchanged") else "would-publish"
    return {
        "report": {
            "action": "kev-run" if not dry_run else "kev-dry-run",
            "published": outcome,
            "catalogVersion": catalog["catalogVersion"],
            "dateReleased": catalog["dateReleased"],
            "entries": len(catalog["vulnerabilities"]),
            "bytes": len(blob),
            "sha256": digest,
            "source": source,
            "ransomware": _ransomware_counts(catalog),
        },
        "state": state_update,
    }


def _same_bytes(pub_dir: str, digest: str) -> bool:
    try:
        with open(published_path(pub_dir), "rb") as handle:
            return hashlib.sha256(handle.read(MAX_BYTES + 1)).hexdigest() == digest
    except FileNotFoundError:
        return False


def _ransomware_counts(catalog: dict) -> dict:
    """Reported rather than validated against an enum.

    `knownRansomwareCampaignUse` is `Known` or `Unknown` today (338 / 1,324,
    2026-08-08). Refusing a third value would wedge this cron on a benign
    upstream change, and quietly folding one into `Unknown` would invent a
    finding — so the run reports the distribution and an operator sees a new
    value the first time it appears. The client maps anything it does not
    recognise to its own visible "not stated" band, for the same reason.
    """
    counts: dict[str, int] = {}
    for entry in catalog["vulnerabilities"]:
        value = str(entry.get("knownRansomwareCampaignUse", ""))
        counts[value] = counts.get(value, 0) + 1
    return dict(sorted(counts.items()))


def _record(
    cache_dir: str,
    recorded: dict,
    *,
    ok: bool,
    message: str,
    started: int,
    extra: dict | None = None,
) -> None:
    values = dict(recorded)
    values.update(
        {
            "state": STATE_VERSION,
            "last_run": started,
            "last_ok": started if ok else recorded.get("last_ok"),
            "last_error": "" if ok else str(message)[:2000],
        }
    )
    if extra:
        values.update(extra)
    save_state(cache_dir, values)


def status(pub_dir: str, cache_dir: str) -> dict:
    """What is being served and when this job last managed to fetch it.

    Read-only and lock-free, for the reason `ingest.py status` is: it is the
    thing to run while wondering whether the job is stuck, and taking the lock
    to answer that would be one way to find out that it is not.
    """
    recorded = load_state(cache_dir)
    current = published_catalog(pub_dir)
    report: dict = {
        "action": "kev-status",
        "published": published_path(pub_dir),
        "state": state_path(cache_dir),
        "catalogVersion": None if current is None else current.get("catalogVersion"),
        "dateReleased": None if current is None else current.get("dateReleased"),
        "entries": None if current is None else len(current.get("vulnerabilities") or []),
        "last_run": recorded.get("last_run"),
        "last_ok": recorded.get("last_ok"),
        "last_error": recorded.get("last_error") or None,
        "source": recorded.get("source"),
    }
    try:
        report["bytes"] = os.path.getsize(published_path(pub_dir))
    except OSError:
        report["bytes"] = None
    return report


# --- development ------------------------------------------------------------


SAMPLE_UNMATCHED = ("CVE-1999-0001", "CVE-1999-0002")


def sample(artifact: str, out_path: str, limit: int = 120) -> dict:
    """Write a catalog in CISA's shape from CVE ids in a built artifact.

    **Development only.** It publishes nothing and never touches `pub_dir`; the
    file it writes is fed back through `run --from-file`, so the local data
    plane's catalog is one the real validator accepted.

    It exists because the real catalog is the wrong fixture for the development
    slice: the slice is 2026 records and KEV is mostly older CVEs, so joining
    the two matches almost nothing and every count in a test would be zero. A
    catalog drawn from the slice's own ids gives the joins something to join,
    and `SAMPLE_UNMATCHED` adds ids the corpus does not hold, because "an entry
    whose CVE the corpus lacks is kept and counted" (D-076) is a claim that
    needs one to be true.
    """
    db = sqlite3.connect(f"file:{artifact}?mode=ro", uri=True)
    try:
        rows = [
            str(row[0])
            for row in db.execute(
                "SELECT cve_id FROM cve WHERE state = 1 ORDER BY cve_id LIMIT ?", (int(limit),)
            )
        ]
    finally:
        db.close()
    ids = rows + list(SAMPLE_UNMATCHED)
    if not rows:
        raise Refuse(f"{artifact} holds no PUBLISHED records to draw a sample catalog from")

    entries = []
    for at, cve_id in enumerate(ids):
        entries.append(
            {
                "cveID": cve_id,
                "vendorProject": f"Sample Vendor {at % 7}",
                "product": f"Sample Product {at % 11}",
                "vulnerabilityName": f"{cve_id} Sample Vulnerability",
                "dateAdded": f"2026-0{1 + at % 8}-1{at % 9}",
                "shortDescription": f"A development fixture entry for {cve_id}.",
                "requiredAction": "Apply updates per vendor instructions.",
                "dueDate": f"2026-0{1 + (at + 2) % 8}-2{at % 8}",
                # Roughly the live 20/80 split, so a grouped count has both bands.
                "knownRansomwareCampaignUse": "Known" if at % 5 == 0 else "Unknown",
                "notes": f"https://example.invalid/{cve_id} ; see also javascript:alert(1)",
                "cwes": ["CWE-79"] if at % 3 == 0 else [],
            }
        )
    catalog = {
        "title": "Development sample of the CISA Catalog of Known Exploited Vulnerabilities",
        "catalogVersion": "2026.08.08",
        "dateReleased": "2026-08-08T00:00:00.0000Z",
        "count": len(entries),
        "vulnerabilities": entries,
    }
    blob = json.dumps(catalog, indent=1).encode("utf-8")
    # Through the same validator, so a fixture this function gets wrong fails
    # here rather than in a browser.
    validate(blob)
    with open(out_path, "wb") as handle:
        handle.write(blob)
    return {
        "action": "kev-sample",
        "out": out_path,
        "entries": len(entries),
        "matched": len(rows),
        "unmatched": len(SAMPLE_UNMATCHED),
        "bytes": len(blob),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    runner = sub.add_parser("run", help="Fetch, validate and publish the catalog.")
    runner.add_argument("pub_dir")
    runner.add_argument(
        "--cache",
        required=True,
        help="This job's own directory (cve.data/cache). Deliberately not the "
        "ingest's --state: the two must not share a failure domain (D-076).",
    )
    runner.add_argument(
        "--from-file",
        default=None,
        help="Read the catalog from a local file instead of fetching it. A "
        "development affordance; it runs the same validation and the same guard.",
    )
    runner.add_argument(
        "--force",
        action="store_true",
        help="Publish a catalog at or below the published version. For a "
        "rollback someone actually intends, not a way past the guard.",
    )
    runner.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch, validate and guard, then report without publishing or "
        "touching state.",
    )

    reporter = sub.add_parser("status", help="What is served, and when it was last fetched.")
    reporter.add_argument("pub_dir")
    reporter.add_argument("--cache", required=True)

    sampler = sub.add_parser("sample", help="Development fixture from a built artifact.")
    sampler.add_argument("artifact")
    sampler.add_argument("out")
    sampler.add_argument("--limit", type=int, default=120)

    args = parser.parse_args()
    try:
        if args.command == "run":
            report = run(
                args.pub_dir,
                args.cache,
                from_file=args.from_file,
                force=args.force,
                dry_run=args.dry_run,
            )
        elif args.command == "sample":
            report = sample(args.artifact, args.out, limit=args.limit)
        else:
            report = status(args.pub_dir, args.cache)
    except Busy as busy:
        # Another KEV run is in flight. Not a failure: CISA publishes about
        # daily and the next run is an hour away.
        print(f"skipped: {busy}", file=sys.stderr)
        return EXIT_OK
    except Refuse as refusal:
        print(f"error: {refusal}", file=sys.stderr)
        return EXIT_FAIL

    print(json.dumps(report, indent=2))
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
