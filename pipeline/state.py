"""What the corpus looked like at the published head — the ingest's own state.

Lives in `cve.data/`, never under the served root (D-018, D-053): this is
pipeline state, not part of the published contract, and no client ever sees it.
Three things live here, and each answers a question the published artifacts
cannot:

  * **a content hash per record** (D-031), because "changed" is a diff against
    the previous run and nothing in the artifact records it;
  * **the revision each record last changed at**, which is what a delta
    spanning more than one revision would need. Nothing reads it back today:
    the monthly snapshot publishes the artifact the head was cut from rather
    than a fresh build, so it lands *at* head and needs no bridging delta
    (D-060). It is written because the only place the number exists is the run
    that produced it, and a rebuild that ever does change content is the one
    thing that would want it;
  * **the pending run**, which is what makes a crashed run re-runnable instead
    of a rewritten immutable URL (D-047, D-055).

Losing this file costs a scan rather than a lineage — but only while the clone
still sits at the commit the head artifact was built from, which `ingest.py init`
checks. A run fetches before its guards can abort, so an aborted run leaves the
clone ahead; recovering from there means getting the clone back to the commit
`ingest.py status` reports, and that has not been tested against a `--depth 1`
clone (D-058).

The lock lives here too, because both crons have to take it and both end up
opening this file: D-042 requires a monthly snapshot and a daily ingest never to
overlap, and the daily's `flock` is worth nothing if the monthly forgets it.
Both jobs take it now — `ingest.py run` and `snapshot.py` — and both record
their outcome here, separately, so a monthly failure is not hidden by a daily
success (D-060).
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import sqlite3
import time

# Bumped when the shape below changes. A state file this pipeline cannot read is
# not something to migrate in place — `init` rebuilds it from the clone in the
# time one scan takes, which is cheaper than any migration path we could test.
STATE_VERSION = 1

LOCK_NAME = "pipeline.lock"
STATE_NAME = "ingest.sqlite"

# How often a waiting job re-tries the lock. Only the monthly waits, and what
# it is waiting for is a ~55 s daily run, so this is coarse on purpose.
LOCK_POLL = 5.0

# One outcome record per scheduled job. The daily's keys keep their original
# names because a deployed state file already holds them, and renaming them
# would report a healthy ingest as one that has never run.
OUTCOME_KEYS = {
    "run": ("last_run", "last_ok", "last_error"),
    "snapshot": ("last_snapshot", "last_snapshot_ok", "last_snapshot_error"),
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v);
CREATE TABLE IF NOT EXISTS record(
    cve_id TEXT PRIMARY KEY,
    hash   TEXT NOT NULL,
    rev    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tombstone(
    cve_id TEXT PRIMARY KEY,
    rev    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS record_rev ON record(rev);
CREATE INDEX IF NOT EXISTS tombstone_rev ON tombstone(rev);
"""


class Busy(Exception):
    """Another pipeline job holds the lock."""


@contextlib.contextmanager
def lock(state_dir: str, wait: float = 0.0):
    """Hold the pipeline lock for the duration, or raise `Busy` (D-042).

    Non-blocking by default, and that default is the daily's. A daily run that
    finds the monthly snapshot in progress has nothing useful to wait for — the
    snapshot moves the head it would have built its delta from — so the honest
    outcome is to skip today and let tomorrow's run cover two days, which the
    changeset does by construction.

    **The monthly is the opposite case, which is what `wait` is for.** A daily
    finishing under it does not invalidate anything the rotation is about to do;
    it just moves the head the rotation will land on. Skipping instead costs a
    whole month — that is when the job next runs — and leaves no record, because
    a job that never got the lock cannot write its outcome. So the monthly waits
    a bounded while and turns a collision into a delay.

    Polling rather than a blocking `flock`: the wait has to be bounded (a cron
    job that blocks forever on a wedged process is worse than one that gives
    up), and `LOCK_NB` in a loop is the portable way to bound it.

    The lock is released by closing the descriptor, which the `finally` does on
    every exit path including a crash inside the body; a killed process releases
    it through the kernel, so a stale lockfile never wedges the next run.
    """
    os.makedirs(state_dir, mode=0o755, exist_ok=True)
    path = os.path.join(state_dir, LOCK_NAME)
    handle = os.open(path, os.O_CREAT | os.O_RDWR, 0o644)
    try:
        deadline = time.monotonic() + max(0.0, float(wait))
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as error:
                if time.monotonic() >= deadline:
                    raise Busy(f"another pipeline job holds {path}") from error
                time.sleep(min(LOCK_POLL, max(0.0, deadline - time.monotonic())))
        yield path
    finally:
        os.close(handle)


class State:
    """The hash state, opened for one run.

    Every mutation is one transaction, because the invariant that matters is
    "the state describes exactly the revision the manifest advertises" — a
    half-applied run would make the next diff produce a changeset that is
    neither the day's changes nor a superset of them.
    """

    def __init__(self, path: str) -> None:
        self.path = path
        os.makedirs(os.path.dirname(os.path.abspath(path)), mode=0o755, exist_ok=True)
        self._db = sqlite3.connect(path)
        self._db.executescript(SCHEMA)
        recorded = self._meta("state")
        if recorded is None:
            self._db.execute(
                "INSERT OR REPLACE INTO meta(k, v) VALUES('state', ?)", (STATE_VERSION,)
            )
            self._db.commit()
        elif int(recorded) != STATE_VERSION:
            raise ValueError(
                f"{path} is state version {recorded}, this pipeline writes {STATE_VERSION}; "
                "rebuild it with `ingest.py init` rather than migrating it in place"
            )

    def close(self) -> None:
        self._db.close()

    def __enter__(self) -> "State":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()

    def _meta(self, key: str):
        row = self._db.execute("SELECT v FROM meta WHERE k = ?", (key,)).fetchone()
        return None if row is None else row[0]

    # --- what the state knows -------------------------------------------------

    @property
    def initialized(self) -> bool:
        return self._meta("rev") is not None

    @property
    def rev(self) -> int:
        """The revision this state describes — which must be the published head.

        The ingest refuses to run when the two disagree rather than guessing
        which one moved: a delta cut from the wrong `from` either re-ships rows
        harmlessly or omits them silently, and nothing downstream can tell those
        apart.
        """
        value = self._meta("rev")
        if value is None:
            raise ValueError(f"{self.path} has no recorded revision; run `ingest.py init` first")
        return int(value)

    @property
    def artifact(self) -> str:
        """The artifact the next build seeds from — the *most recent* build, not
        the last published snapshot (D-056): ids minted by a daily delta exist
        only in the artifact that delta was cut from."""
        value = self._meta("artifact")
        if value is None:
            raise ValueError(f"{self.path} has no recorded artifact; run `ingest.py init` first")
        return str(value)

    @property
    def idspace(self) -> str:
        return str(self._meta("idspace") or "")

    @property
    def commit(self) -> str:
        return str(self._meta("commit") or "")

    @property
    def pending(self) -> dict | None:
        """The run that minted a revision but has not been confirmed published.

        Written before the delta is, and cleared after the manifest names it, so
        a crash anywhere in between leaves the exact changeset — and the exact
        `generated` — a retry needs to produce byte-identical bytes at a URL
        that can never be corrected (D-047).
        """
        raw = self._meta("pending")
        return None if raw in (None, "") else json.loads(raw)

    def count(self) -> int:
        return int(self._db.execute("SELECT count(*) FROM record").fetchone()[0])

    def tombstones(self) -> int:
        return int(self._db.execute("SELECT count(*) FROM tombstone").fetchone()[0])

    # --- what a run does to it ------------------------------------------------

    def initialize(
        self, *, rev: int, artifact: str, idspace: str, commit: str, hashes: dict
    ) -> None:
        """Adopt an existing data plane: these records, at this revision.

        Replaces whatever was here. There is no merge case — a state that
        disagrees with the artifact it points at is exactly what `init` exists to
        repair.

        It also **discards the history a bridging delta reads**: every surviving
        record is stamped at `rev` and the tombstone log is emptied, so nothing
        here can say what changed between an older revision and this one. A
        delta spanning an `init` would therefore over-ship records (harmless)
        and omit tombstones (not), which is a constraint the monthly rebuild
        inherits rather than a bug here — after an `init` the only sound delta
        is a step from `rev`.
        """
        with self._db:
            self._db.execute("DELETE FROM record")
            self._db.execute("DELETE FROM tombstone")
            self._db.executemany(
                "INSERT INTO record(cve_id, hash, rev) VALUES(?,?,?)",
                ((cve_id, digest, int(rev)) for cve_id, digest in hashes.items()),
            )
            self._write_meta(
                {
                    "rev": int(rev),
                    "artifact": os.path.abspath(artifact),
                    "idspace": str(idspace),
                    "commit": str(commit),
                    "pending": "",
                }
            )

    def _write_meta(self, values: dict) -> None:
        self._db.executemany(
            "INSERT INTO meta(k, v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            list(values.items()),
        )

    def diff(self, scanned: dict) -> dict:
        """The changeset, in SQLite rather than in two Python dicts.

        The scan already holds one hash per record in memory; loading the
        state's copy into a second dict would double that for no reason, so the
        comparison happens in a temp table. `added` is kept apart from `changed`
        because the build's own counts are checked against them — a walk that
        minted a different number of record ids than the diff says are new saw a
        different corpus, and that has to stop the run before anything is
        published.
        """
        db = self._db
        db.execute("DROP TABLE IF EXISTS temp.scan")
        db.execute("CREATE TEMP TABLE scan(cve_id TEXT PRIMARY KEY, hash TEXT NOT NULL)")
        try:
            db.executemany("INSERT INTO temp.scan(cve_id, hash) VALUES(?,?)", scanned.items())
            added = {
                row[0]: row[1]
                for row in db.execute(
                    "SELECT s.cve_id, s.hash FROM temp.scan s "
                    "LEFT JOIN record r ON r.cve_id = s.cve_id WHERE r.cve_id IS NULL"
                )
            }
            changed = {
                row[0]: row[1]
                for row in db.execute(
                    "SELECT s.cve_id, s.hash FROM temp.scan s "
                    "JOIN record r ON r.cve_id = s.cve_id WHERE r.hash <> s.hash"
                )
            }
            deleted = sorted(
                row[0]
                for row in db.execute(
                    "SELECT r.cve_id FROM record r "
                    "LEFT JOIN temp.scan s ON s.cve_id = r.cve_id WHERE s.cve_id IS NULL"
                )
            )
        finally:
            # Rollback first: the insert above opened an implicit transaction
            # that nothing else closes, and leaving it open would hold it across
            # the 30-second build that follows — and make this class's "every
            # mutation is one transaction" false for whatever ran next. The
            # drop is then plain autocommit DDL.
            db.rollback()
            db.execute("DROP TABLE IF EXISTS temp.scan")
        return {"added": added, "changed": changed, "delete": deleted}

    def record_outcome(self, ok: bool, message: str, kind: str = "run") -> None:
        """What the last run of one job did, so a failure is discoverable
        without reading a log file.

        D-042 asks the ingest to "abort and alert", and on this machine there is
        no channel to alert *through*: no MTA is installed, so cron's mail is a
        no-op and un-redirecting stderr would send failures nowhere. Telemetry
        is forbidden outright (D-009). What is left is making the state answer
        the question — `ingest.py status` reports this, so "is the ingest
        healthy?" is one command rather than a log grep, and a run that has been
        failing since Tuesday says so.

        The two jobs record separately, because a monthly job that has failed
        since May is invisible under a daily one that succeeded this morning —
        and a monthly failure is the more expensive of the two to miss, since
        the next attempt is a month away rather than a day (D-060).
        """
        keys = OUTCOME_KEYS[kind]
        with self._db:
            self._write_meta(
                {
                    keys[0]: int(time.time()),
                    keys[1]: 1 if ok else 0,
                    keys[2]: "" if ok else str(message)[:2000],
                }
            )

    def outcome(self, kind: str = "run") -> dict | None:
        keys = OUTCOME_KEYS[kind]
        when = self._meta(keys[0])
        if when is None:
            return None
        return {
            "at": int(when),
            "ok": bool(int(self._meta(keys[1]) or 0)),
            "error": str(self._meta(keys[2]) or "") or None,
        }

    @property
    def last_run(self) -> dict | None:
        return self.outcome("run")

    def begin_run(self, pending: dict) -> None:
        """Pin the run before anything of it is published.

        Including `generated`: the client writes it to `meta.generated` on apply,
        so two payloads differing only there are different content at a URL
        caches may hold for a year (D-055). Stamping the clock on each attempt is
        what would make a retry unpublishable.
        """
        with self._db:
            self._write_meta({"pending": json.dumps(pending, sort_keys=True)})

    def abandon_run(self) -> None:
        """Drop a pending run that published nothing. Only ever correct when the
        ledger and the manifest both agree its revision was never exposed."""
        with self._db:
            self._write_meta({"pending": ""})

    def commit_run(self, pending: dict) -> None:
        """Advance to the revision the manifest now advertises, in one write."""
        rev = int(pending["rev"])
        upserts = dict(pending["upsert"])
        deletes = list(pending["delete"])
        with self._db:
            self._db.executemany(
                "INSERT INTO record(cve_id, hash, rev) VALUES(?,?,?) "
                "ON CONFLICT(cve_id) DO UPDATE SET hash = excluded.hash, rev = excluded.rev",
                ((cve_id, digest, rev) for cve_id, digest in upserts.items()),
            )
            # A record that comes back after a tombstone keeps its tombstone.
            # Both facts are true of a client that has not synced since: the row
            # it holds at the retired id is gone, *and* the record exists again
            # at a new one (D-056 never reissues an id). Clearing the tombstone
            # would leave a bridging delta shipping only the upsert, which every
            # client below the deletion then refuses on apply — after the bytes
            # are at an immutable URL. Kept, a bridging delta that spans both
            # events names the record in `upsert` and `delete` at once and
            # `delta.extract` refuses it on the server, where D-047 says
            # failures belong. Expressing "drop row 2, insert row 3" is the wire
            # format's gap and the monthly rebuild's problem; losing the
            # evidence for it here would be ours.
            self._db.executemany(
                "DELETE FROM record WHERE cve_id = ?", ((cve_id,) for cve_id in deletes)
            )
            self._db.executemany(
                "INSERT INTO tombstone(cve_id, rev) VALUES(?,?) "
                "ON CONFLICT(cve_id) DO UPDATE SET rev = excluded.rev",
                ((cve_id, rev) for cve_id in deletes),
            )
            self._write_meta(
                {
                    "rev": rev,
                    "artifact": os.path.abspath(pending["artifact"]),
                    "commit": str(pending.get("commit") or ""),
                    "pending": "",
                }
            )
