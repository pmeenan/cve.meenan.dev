"""Publish the fixture data plane into a directory, for the contract test.

    python3 pipeline/tests/fixture_pub.py <outdir>

Prints a JSON summary. This exists so `tests/unit/contract.test.ts` validates a
delta the *pipeline* produced rather than one a TypeScript fixture wrote to
match the TypeScript types — which would only ever prove that the types agree
with themselves.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fixtures  # noqa: E402


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    root = sys.argv[1]
    os.makedirs(root, exist_ok=True)
    published = fixtures.publish_fixture(root)
    # And the same data plane after a monthly rotation, published beside it
    # rather than over it: the rotated manifest is a different shape (deltas
    # starting below the snapshot's revision, D-060) and the contract test has
    # to see both.
    rotated = fixtures.publish_rotated_fixture(root)
    print(
        json.dumps(
            {
                "pub": published["pub"],
                "snapshot_rev": 1,
                "head_rev": 2,
                # The artifact this data plane's *head* was built from. The
                # contract test reassembles the published snapshot from its
                # chunks, applies the published delta with the **client's**
                # applier, and checks the result against this — the same
                # sufficiency claim `pipeline/tests/apply.py` makes, made
                # against the code the browser actually runs.
                "next_db": published["next"],
                "delta": published["delta"],
                "counts": {
                    "upserts": published["summary"]["upserts"],
                    "deletes": published["summary"]["deletes"],
                },
                "hostile_text": fixtures.HOSTILE_TEXT,
                # Read out of the rotation's own report rather than written
                # down here: a hardcoded constant is a claim nothing checks, and
                # the point of a cross-language fixture is to tie what the
                # pipeline says to what the client parses.
                "rotated": {
                    "pub": rotated["pub"],
                    "snapshot_rev": rotated["rotation"]["rev"],
                    "deltas_kept": rotated["rotation"]["deltas_kept"],
                    "retired": rotated["retired"],
                    "previous_generation": f"snapshot-{rotated['first_rotation']['rev']}",
                },
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
