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
    print(
        json.dumps(
            {
                "pub": published["pub"],
                "snapshot_rev": 1,
                "head_rev": 2,
                "delta": published["delta"],
                "counts": {
                    "upserts": published["summary"]["upserts"],
                    "deletes": published["summary"]["deletes"],
                },
                "hostile_text": fixtures.HOSTILE_TEXT,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
