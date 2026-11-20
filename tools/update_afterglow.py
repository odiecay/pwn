#!/usr/bin/env python3
"""Check or update the vendored Afterglow engine.

Afterglow is maintained separately. This tool compares afterglow/ with the
current upstream main branch, verifies the upstream cache manifest, and can
replace the vendored copy. It never deletes local extras such as
afterglow/combined.html.

Usage:
    py tools/update_afterglow.py            # check only
    py tools/update_afterglow.py --apply    # update if nothing local changed
    py tools/update_afterglow.py --apply --force
    py tools/update_afterglow.py --write-lock
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AFTERGLOW = ROOT / "afterglow"
LOCK = ROOT / "tools" / "afterglow.lock.json"

REPO = "well0nez/afterglow-web"
API = f"https://api.github.com/repos/{REPO}"
RAW = f"https://raw.githubusercontent.com/{REPO}"
SKIP = {".git", ".gitignore", ".github"}


def request(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "wobkot-afterglow-updater"})
    with urllib.request.urlopen(req, timeout=30) as response:
        return response.read()


def request_json(url: str):
    return json.loads(request(url).decode("utf-8"))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def upstream(commit: str | None = None) -> dict:
    if commit:
        meta = request_json(f"{API}/commits/{commit}")
    else:
        meta = request_json(f"{API}/commits/main")

    sha = meta["sha"]
    date = meta["commit"]["committer"]["date"]
    tree = request_json(f"{API}/git/trees/{sha}?recursive=1")

    files = [
        item
        for item in tree["tree"]
        if item["type"] == "blob" and not any(part in SKIP for part in Path(item["path"]).parts)
    ]

    return {"sha": sha, "date": date, "files": files}


def verify_manifest(directory: Path) -> list[str]:
    manifest = directory / "cache.appcache"
    if not manifest.is_file():
        return ["upstream has no cache.appcache"]

    problems = []
    for line in manifest.read_text(encoding="utf-8").splitlines():
        parts = line.strip().split()
        if len(parts) != 2 or not parts[1].startswith("#") or len(parts[1]) != 33:
            continue

        name, want = parts[0], parts[1][1:]
        path = directory / name
        if not path.is_file():
            problems.append(f"manifest lists missing {name}")
            continue

        got = hashlib.sha256(path.read_bytes()).hexdigest()[:32]
        if got != want:
            problems.append(f"manifest mismatch {name}: want {want}, got {got}")

    return problems


def compare(local: Path, remote: Path, files: list[dict]) -> tuple[list[str], list[str]]:
    changed = []
    missing = []

    for item in files:
        name = item["path"]
        local_path = local / name
        remote_path = remote / name

        if not local_path.is_file():
            missing.append(name)
            continue

        if local_path.read_bytes() != remote_path.read_bytes():
            changed.append(name)

    return changed, missing


def write_lock(info: dict) -> None:
    files = {}

    for item in info["files"]:
        path = AFTERGLOW / item["path"]
        if not path.is_file():
            continue
        files[item["path"]] = {
            "sha256": sha256(path),
            "size": path.stat().st_size,
        }

    payload = {
        "upstream": f"https://github.com/{REPO}",
        "commit": info["sha"],
        "date": info["date"],
        "vendored_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "files": dict(sorted(files.items())),
    }

    with LOCK.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(payload, indent=2) + "\n")
    print(f"wrote {LOCK}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Check or update the vendored Afterglow engine.")
    parser.add_argument("--check", action="store_true", help="compare only (default)")
    parser.add_argument("--apply", action="store_true", help="replace the vendored files")
    parser.add_argument("--force", action="store_true", help="overwrite local changes")
    parser.add_argument("--write-lock", action="store_true", help="write the lock from the vendored files")
    parser.add_argument("--commit", help="use a specific commit instead of main")
    args = parser.parse_args()

    try:
        info = upstream(args.commit)
    except urllib.error.HTTPError as err:
        print(f"GitHub API error: {err.code} {err.reason}", file=sys.stderr)
        print("Try again later, or pass --commit with a known SHA.", file=sys.stderr)
        return 1
    except Exception as err:  # noqa: BLE001
        print(f"could not reach GitHub: {err}", file=sys.stderr)
        return 1

    print(f"upstream {info['sha'][:12]}  {info['date']}  {len(info['files'])} files")

    if args.write_lock:
        write_lock(info)
        return 0

    with tempfile.TemporaryDirectory() as tmp:
        remote = Path(tmp)

        for item in info["files"]:
            path = remote / item["path"]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(request(f"{RAW}/{info['sha']}/{item['path']}"))

        problems = verify_manifest(remote)
        if problems:
            for problem in problems:
                print(f"upstream manifest: {problem}", file=sys.stderr)
            print("refusing to use a tree whose own manifest does not verify", file=sys.stderr)
            return 1

        changed, missing = compare(AFTERGLOW, remote, info["files"])

        if not changed and not missing:
            print("vendored Afterglow is up to date")
            return 0

        for name in missing:
            print(f"missing  {name}")
        for name in changed:
            print(f"changed  {name}")

        if not args.apply:
            print("run with --apply to update (or --check to keep checking)")
            return 1

        if (changed or missing) and not args.force:
            print("local files differ; refusing to overwrite without --force", file=sys.stderr)
            return 1

        for item in info["files"]:
            src = remote / item["path"]
            dst = AFTERGLOW / item["path"]
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)

        print(f"updated {AFTERGLOW}")
        write_lock(info)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
