#!/usr/bin/env python3
"""Build src/afterglow_fast.js from the pristine Afterglow engine.

The only local change is the raw-payload copy in loadPayload(): instead of
walking the blob 8 bytes at a time through the ROP-backed p.write8/p.read8,
use the adapter's bulk writeBulk/readBulk when present. That turns roughly
37,000 + 37,000 reads/writes into two memcpy-style copies.

The vendored afterglow/ tree stays byte-for-byte upstream. The proven engine
continues to use it; only the combined fast path imports the generated file.

Usage:
    py tools/build_fast_engine.py --check
    py tools/build_fast_engine.py --write
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "afterglow" / "afterglow.js"
TARGET = ROOT / "src" / "afterglow_fast.js"

HEADER = (
    "// Generated from afterglow/afterglow.js by tools/build_fast_engine.py.\n"
    "// Local fast-path patch: bulk payload copy through the Wobkot adapter.\n"
    "// Do not edit by hand; edit the generator and run --write.\n\n"
)

IMPORT_OLD = 'import { int64 } from "./int64.js";'
IMPORT_NEW = 'import { int64 } from "../afterglow/int64.js";'

BLOCK_OLD = """  for (let o = 0; o < blob.length; o += 8) {
    let lo = 0, hi = 0;
    for (let k = 0; k < 4; k++) lo |= (blob[o + k] || 0) << (8 * k);
    for (let k = 0; k < 4; k++) hi |= (blob[o + 4 + k] || 0) << (8 * k);
    c.p.write8(plus(entry, o), v(lo >>> 0, hi >>> 0));
  }
  for (let o = 0; o < blob.length; o += 8) {
    let lo = 0, hi = 0;
    for (let k = 0; k < 4; k++) lo |= (blob[o + k] || 0) << (8 * k);
    for (let k = 0; k < 4; k++) hi |= (blob[o + 4 + k] || 0) << (8 * k);
    const q = c.p.read8(plus(entry, o));
    if ((q.low >>> 0) !== (lo >>> 0) || (q.hi >>> 0) !== (hi >>> 0)) {
      say("[p] copy mismatch at 0x" + o.toString(16)); return false;
    }
  }
"""

BLOCK_NEW = """  if (c.p.writeBulk && c.p.readBulk) {
    c.p.writeBulk(entry, blob);
    const got = c.p.readBulk(entry, blob.length);
    if (!sameBytes(got, blob)) {
      say("[p] bulk copy mismatch"); return false;
    }
  } else {
    for (let o = 0; o < blob.length; o += 8) {
      let lo = 0, hi = 0;
      for (let k = 0; k < 4; k++) lo |= (blob[o + k] || 0) << (8 * k);
      for (let k = 0; k < 4; k++) hi |= (blob[o + 4 + k] || 0) << (8 * k);
      c.p.write8(plus(entry, o), v(lo >>> 0, hi >>> 0));
    }
    for (let o = 0; o < blob.length; o += 8) {
      let lo = 0, hi = 0;
      for (let k = 0; k < 4; k++) lo |= (blob[o + k] || 0) << (8 * k);
      for (let k = 0; k < 4; k++) hi |= (blob[o + 4 + k] || 0) << (8 * k);
      const q = c.p.read8(plus(entry, o));
      if ((q.low >>> 0) !== (lo >>> 0) || (q.hi >>> 0) !== (hi >>> 0)) {
        say("[p] copy mismatch at 0x" + o.toString(16)); return false;
      }
    }
  }
"""


def build() -> str:
    text = SOURCE.read_text(encoding="utf-8")

    if IMPORT_OLD not in text:
        raise SystemExit(f"missing import line in {SOURCE}")
    text = text.replace(IMPORT_OLD, IMPORT_NEW, 1)

    if BLOCK_OLD not in text:
        raise SystemExit("the loadPayload copy block changed upstream; update build_fast_engine.py")
    text = text.replace(BLOCK_OLD, BLOCK_NEW, 1)

    return HEADER + text


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the fast Afterglow module.")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--check", action="store_true", help="verify the generated file (default)")
    group.add_argument("--write", action="store_true", help="write src/afterglow_fast.js")
    args = parser.parse_args()

    if args.write:
        TARGET.write_text(build(), encoding="utf-8", newline="\n")
        print(f"wrote {TARGET}")
        return 0

    if not TARGET.is_file():
        print(f"missing {TARGET}; run --write")
        return 1

    expected = build()
    actual = TARGET.read_text(encoding="utf-8")

    if actual != expected:
        print(f"{TARGET} is stale; run --write")
        return 1

    print(f"{TARGET} is current")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
