#!/usr/bin/env python3
"""Static checks for the toolkit.

Checks the things that would silently produce a broken run:
  * every file the pages and tools expect is present
  * every local href/src in the HTML resolves
  * afterglow/cache.appcache hashes still match the vendored files
  * the Afterglow 14.02 tables are present
  * src/strategy.js routes the expected user agents
  * every JavaScript file parses (Node is optional; skipped with --no-node)

Usage:
    py tools/check.py
    py tools/check.py --no-node
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

REQUIRED = [
    "index.html",
    "legacy.html",
    "primitive-test.html",
    "diag.html",
    "host.py",
    "src/strategy.js",
    "src/logger.js",
    "src/main.js",
    "src/misc.js",
    "src/userland.js",
    "src/kernel.js",
    "src/ps4/impl.js",
    "src/combined.js",
    "src/afterglow_host.js",
    "src/afterglow_bridge.js",
    "src/primitive_test.js",
    "src/diag.js",
    "afterglow/index.html",
    "afterglow/jb.html",
    "afterglow/combined.html",
    "afterglow/afterglow.js",
    "afterglow/ps4_offsets.js",
    "afterglow/patchset-1402.bin",
    "afterglow/goldhen.bin",
]

HTML_FILES = [
    "index.html",
    "legacy.html",
    "primitive-test.html",
    "diag.html",
    "afterglow/index.html",
    "afterglow/jb.html",
    "afterglow/combined.html",
]

CLASSIC_JS = [
    "src/logger.js",
    "src/strategy.js",
    "src/main.js",
    "src/misc.js",
    "src/userland.js",
    "src/kernel.js",
    "src/lapse.js",
    "src/thread.js",
    "src/worker.js",
    "src/ps4/impl.js",
    "src/ps5/impl.js",
    "src/ps5/relapse.js",
    "src/combined.js",
    "src/afterglow_host.js",
    "src/primitive_test.js",
    "src/diag.js",
]

MODULE_JS = [
    "src/afterglow_bridge.js",
    "afterglow/afterglow.js",
    "afterglow/int64.js",
    "afterglow/core.js",
    "afterglow/mem.js",
    "afterglow/ps4_offsets.js",
    "afterglow/jb.js",
    "afterglow/launch.js",
]


class Refs(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.values: list[str] = []

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if name in ("src", "href", "manifest") and value:
                self.values.append(value)


def ok(label: str) -> None:
    print(f"ok   {label}")


def fail(label: str, failures: list[str]) -> None:
    print(f"FAIL {label}")
    failures.append(label)


def check_required(failures: list[str]) -> None:
    missing = [name for name in REQUIRED if not (ROOT / name).is_file()]
    if missing:
        for name in missing:
            fail(f"missing file: {name}", failures)
    else:
        ok(f"required files ({len(REQUIRED)})")


def check_html_refs(failures: list[str]) -> None:
    bad = 0
    for name in HTML_FILES:
        path = ROOT / name
        parser = Refs()
        parser.feed(path.read_text(encoding="utf-8"))

        for value in parser.values:
            if value.startswith(("#", "?", "http://", "https://", "data:", "mailto:", "javascript:")):
                continue

            clean = value.split("#", 1)[0].split("?", 1)[0]
            if not clean:
                continue

            target = (path.parent / clean).resolve()
            if not target.exists():
                fail(f"{name}: missing local reference {value}", failures)
                bad += 1

    if bad == 0:
        ok(f"HTML references ({len(HTML_FILES)} pages)")


def check_manifest(failures: list[str]) -> None:
    result = subprocess.run(
        [sys.executable, str(ROOT / "tools" / "manifest.py"), "--check"],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        for line in (result.stdout + result.stderr).splitlines():
            if line.strip():
                print("     " + line.strip())
        fail("afterglow/cache.appcache", failures)
    else:
        ok("afterglow/cache.appcache")


def check_afterglow_tables(failures: list[str]) -> None:
    offsets = (ROOT / "afterglow" / "ps4_offsets.js").read_text(encoding="utf-8")
    afterglow = (ROOT / "afterglow" / "afterglow.js").read_text(encoding="utf-8")

    if 'PS4["14.02"]' not in offsets:
        fail("ps4_offsets.js has no 14.02 entry", failures)

    if not re.search(r'"14\.02"\s*:', afterglow) or "0x00e6c30" not in afterglow:
        fail("afterglow.js has no 14.02 kernel table", failures)

    patch = ROOT / "afterglow" / "patchset-1402.bin"
    if patch.is_file() and patch.stat().st_size != 641:
        fail(f"patchset-1402.bin is {patch.stat().st_size} bytes, expected 641", failures)

    if not failures:
        ok("Afterglow 14.02 tables")


def check_lock(failures: list[str]) -> None:
    path = ROOT / "tools" / "afterglow.lock.json"
    if not path.is_file():
        fail("tools/afterglow.lock.json is missing", failures)
        return

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as err:  # noqa: BLE001
        fail(f"tools/afterglow.lock.json is invalid: {err}", failures)
        return

    bad = 0
    for name, meta in data.get("files", {}).items():
        target = ROOT / "afterglow" / name
        if not target.is_file():
            fail(f"lock lists missing file: {name}", failures)
            bad += 1
            continue
        got = hashlib.sha256(target.read_bytes()).hexdigest()
        if got != meta.get("sha256"):
            fail(f"lock hash mismatch: {name}", failures)
            bad += 1

    if bad == 0:
        ok(f"Afterglow lock ({data.get('commit', '?')[:12]})")


def node_available() -> bool:
    return shutil.which("node") is not None


def check_js(failures: list[str]) -> None:
    node = shutil.which("node")
    if not node:
        print("skip JavaScript syntax (node not found)")
        return

    for name in CLASSIC_JS:
        result = subprocess.run([node, "--check", str(ROOT / name)], capture_output=True, text=True)
        if result.returncode != 0:
            fail(f"node --check {name}: {result.stderr.strip()}", failures)

    with tempfile.TemporaryDirectory() as tmp:
        for name in MODULE_JS:
            source = ROOT / name
            target = Path(tmp) / (source.stem + ".mjs")
            target.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")
            result = subprocess.run([node, "--check", str(target)], capture_output=True, text=True)
            if result.returncode != 0:
                fail(f"node --check {name}: {result.stderr.strip()}", failures)

    if not any(item.startswith("node --check") for item in failures):
        ok(f"JavaScript syntax ({len(CLASSIC_JS)} classic, {len(MODULE_JS)} modules)")


def check_routing(failures: list[str]) -> None:
    node = shutil.which("node")
    if not node:
        print("skip routing (node not found)")
        return

    script = """
const fs = require('fs');
const vm = require('vm');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(%s, 'utf8'), ctx);
const cases = %s;
for (const item of cases) {
  const ps = ctx.parsePlayStationUA(item.ua);
  const route = ps ? ctx.routeFor(ps.console, ps.major, ps.minor) : null;
  const got = route ? (route.supported ? route.engine : 'unsupported') : 'none';
  console.log(JSON.stringify({name: item.name, got, want: item.want}));
}
""" % (
        json.dumps(str(ROOT / "src" / "strategy.js")),
        json.dumps(
            [
                {"name": "ps4-14.02", "want": "combined", "ua": "Mozilla/5.0 (PlayStation 4 14.02) AppleWebKit/537.73"},
                {"name": "ps4-14.00", "want": "combined", "ua": "Mozilla/5.0 (PlayStation 4 14.00) AppleWebKit/537.73"},
                {"name": "ps4-13.52", "want": "afterglow", "ua": "Mozilla/5.0 (PlayStation 4 13.52) AppleWebKit/537.73"},
                {"name": "ps4-12.00", "want": "afterglow", "ua": "Mozilla/5.0 (PlayStation 4 12.00) AppleWebKit/537.73"},
                {"name": "ps4-11.52", "want": "wobkot", "ua": "Mozilla/5.0 (PlayStation 4 11.52) AppleWebKit/537.73"},
                {"name": "ps4-9.00", "want": "wobkot", "ua": "Mozilla/5.0 (PlayStation 4 9.00) AppleWebKit/537.73"},
                {"name": "ps4-8.55", "want": "unsupported", "ua": "Mozilla/5.0 (PlayStation 4 8.55) AppleWebKit/537.73"},
                {"name": "ps5-8.00", "want": "wobkot", "ua": "Mozilla/5.0 (PlayStation 5 8.00) AppleWebKit/537.73"},
                {"name": "desktop", "want": "none", "ua": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"},
            ]
        ),
    )

    result = subprocess.run([node, "-e", script], capture_output=True, text=True)
    if result.returncode != 0:
        fail(f"routing test failed to run: {result.stderr.strip()}", failures)
        return

    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        item = json.loads(line)
        if item["got"] != item["want"]:
            fail(f"routing {item['name']}: got {item['got']}, want {item['want']}", failures)

    if not any(item.startswith("routing ") for item in failures):
        ok("firmware routing (9 user agents)")


def main() -> int:
    parser = argparse.ArgumentParser(description="Check the PS4 WebKit toolkit.")
    parser.add_argument("--no-node", action="store_true", help="skip JavaScript checks")
    args = parser.parse_args()

    failures: list[str] = []

    check_required(failures)
    check_html_refs(failures)
    check_manifest(failures)
    check_lock(failures)
    check_afterglow_tables(failures)
    if not args.no_node:
        check_js(failures)
        check_routing(failures)

    print()
    if failures:
        print(f"{len(failures)} check(s) failed")
        return 1

    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
