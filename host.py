#!/usr/bin/env python3
"""Serve this toolkit to a PS4/PS5 browser.

Default is plain HTTP on port 8000, which is what the console browsers handle
most reliably. The server sends no-cache headers for code and payloads so a
corrected file is picked up immediately, and the MIME types the console needs
for ES modules and the HTML5 application cache.

Examples:
    py host.py
    py host.py --port 8080
    py host.py --https --cert localhost.pem
    py host.py --self-test
"""

from __future__ import annotations

import argparse
import json
import re
import socket
import ssl
import sys
import threading
import time
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent
DEFAULT_CERT = ROOT / "localhost.pem"

CACHEABLE_SUFFIXES = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico")


class Handler(SimpleHTTPRequestHandler):
    """Static handler with the headers the console browser needs."""

    protocol_version = "HTTP/1.1"

    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".bin": "application/octet-stream",
        ".wasm": "application/wasm",
        ".appcache": "text/cache-manifest",
    }

    quiet = False

    def end_headers(self) -> None:
        path = self.path.split("?", 1)[0].lower()

        if path.endswith(CACHEABLE_SUFFIXES):
            self.send_header("Cache-Control", "public, max-age=604800")
        else:
            # no-cache, not no-store: the file may be kept, but it has to be
            # revalidated before use. That is what makes a corrected module or
            # payload arrive while the console keeps its offline cache.
            self.send_header("Cache-Control", "no-cache, must-revalidate")

        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        if self.quiet:
            return
        stamp = time.strftime("%H:%M:%S")
        sys.stderr.write(f"[{stamp}] {self.address_string()} {fmt % args}\n")

    def console_redirect(self, query):
        """Go straight from / to the recommended engine for this console."""
        ua = self.headers.get("User-Agent", "")
        match = re.search(r"PlayStation\s+(\d+)[/ ](\d+)\.(\d+)", ua)
        if not match:
            return None

        console = int(match.group(1))
        major = int(match.group(2))
        minor = int(match.group(3), 16)
        debug = query.get("debug", ["0"])[0] == "1"

        if console == 4 and major == 14 and minor in (0, 2):
            suffix = "&debug=1" if debug else ""
            return f"/afterglow/combined.html?run=1{suffix}&v={int(time.time())}"

        if console == 4 and 12 <= major <= 13:
            return "/afterglow/index.html"

        if (console == 4 and 9 <= major <= 11) or console == 5:
            return "/legacy.html"

        return None

    def do_GET(self) -> None:
        parts = urlsplit(self.path)
        path = parts.path

        # A local monitor polls this every 30 s; answer it instead of a 404.
        if path == "/health":
            body = b"ok"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path in ("/", "/index.html"):
            query = parse_qs(parts.query)
            if query.get("menu", ["0"])[0] != "1":
                target = self.console_redirect(query)
                if target:
                    self.send_response(302)
                    self.send_header("Location", target)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return

        super().do_GET()

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]

        def read_body() -> str:
            try:
                length = int(self.headers.get("Content-Length", "0") or 0)
            except ValueError:
                length = 0
            return self.rfile.read(min(length, 65536)).decode("utf-8", "replace")

        # One line per completed run: the fast path posts this even when the
        # verbose /log stream is off. A static host will simply 404 it.
        if path == "/event":
            body = read_body()
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                data = {"raw": body}
            print(
                "[PS4] RUN "
                f"ok={data.get('ok')} "
                f"sec={data.get('sec')} "
                f"fw={data.get('fw')} "
                f"payload={data.get('payload')} "
                f"note={data.get('note', '')}",
                flush=True,
            )
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        # The fast-path page posts its on-screen log here so a failure on the
        # console can be read from the host terminal. Same origin only.
        if path == "/log":
            body = read_body()
            for line in body.splitlines():
                sys.stdout.write(f"[PS4] {line}\n")
            sys.stdout.flush()

            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        self.send_error(404)


def lan_ips() -> list[str]:
    ips: set[str] = set()

    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass

    # No packet is sent; this only asks the routing table which local address
    # would be used for an outbound connection.
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("8.8.8.8", 80))
        ips.add(probe.getsockname()[0])
        probe.close()
    except OSError:
        pass

    return sorted(ip for ip in ips if not ip.startswith("127."))


def make_server(bind: str, port: int, https: bool, cert: Path, key: Path, quiet: bool):
    handler = partial(Handler, directory=str(ROOT))
    Handler.quiet = quiet

    httpd = ThreadingHTTPServer((bind, port), handler)
    httpd.daemon_threads = True

    if https:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(cert), str(key))
        httpd.socket = context.wrap_socket(httpd.socket, server_side=True)

    return httpd


def print_urls(bind: str, port: int, https: bool) -> None:
    scheme = "https" if https else "http"
    print(f"Serving {ROOT}")
    print(f"Listening on {bind}:{port}")

    if bind in ("0.0.0.0", ""):
        ips = lan_ips()
        if ips:
            print("Open one of these in the console browser:")
            for ip in ips:
                print(f"  {scheme}://{ip}:{port}/")
        else:
            print(f"Could not detect a LAN address; use {scheme}://<PC_IP>:{port}/")
    else:
        print(f"Open {scheme}://{bind}:{port}/ in the console browser")

    print("Ctrl-C to stop.")


def self_test() -> int:
    """Start a private server, fetch the critical files, and report."""
    server = make_server("127.0.0.1", 0, False, DEFAULT_CERT, DEFAULT_CERT, True)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    base = f"http://127.0.0.1:{port}/"
    checks = [
        ("/", "text/html", None),
        ("/legacy.html", "text/html", None),
        ("/afterglow/index.html", "text/html", None),
        ("/afterglow/combined.html", "text/html", None),
        ("/afterglow/cache.appcache", "cache-manifest", "no-cache"),
        ("/afterglow/ps4_offsets.js", "javascript", "no-cache"),
        ("/afterglow/afterglow.js", "javascript", "no-cache"),
        ("/afterglow/patchset-1402.bin", "octet-stream", "no-cache"),
        ("/afterglow/goldhen.bin", "octet-stream", "no-cache"),
        ("/src/strategy.js", "javascript", "no-cache"),
        ("/src/afterglow_host.js", "javascript", "no-cache"),
        ("/src/combined.js", "javascript", "no-cache"),
    ]

    failures = 0
    print(f"Self-test on {base}")

    for path, want_type, want_cache in checks:
        url = base + path.lstrip("/")
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                body = response.read(2048)
                status = response.status
                content_type = response.headers.get("Content-Type", "")
                cache = response.headers.get("Cache-Control", "")
        except urllib.error.HTTPError as err:
            print(f"FAIL {path}: HTTP {err.code}")
            failures += 1
            continue
        except Exception as err:  # noqa: BLE001 - report the real error
            print(f"FAIL {path}: {err}")
            failures += 1
            continue

        problems = []
        if status != 200:
            problems.append(f"status {status}")
        if want_type and want_type not in content_type:
            problems.append(f"type {content_type!r}")
        if want_cache and want_cache not in cache:
            problems.append(f"cache {cache!r}")
        if not body:
            problems.append("empty body")

        if problems:
            print(f"FAIL {path}: {', '.join(problems)}")
            failures += 1
        else:
            print(f"ok   {path}  {content_type.split(';')[0]}  {len(body)}+ bytes")

    server.shutdown()
    server.server_close()

    if failures:
        print(f"{failures} check(s) failed")
        return 1

    print("all checks passed")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Serve the PS4 WebKit toolkit.")
    parser.add_argument("--bind", default="0.0.0.0", help="address to bind (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8000, help="port to listen on (default: 8000)")
    parser.add_argument("--https", action="store_true", help="serve HTTPS instead of HTTP")
    parser.add_argument("--cert", type=Path, default=DEFAULT_CERT, help="TLS certificate (PEM)")
    parser.add_argument("--key", type=Path, default=None, help="TLS private key (PEM; defaults to the cert file)")
    parser.add_argument("--quiet", action="store_true", help="do not log every request")
    parser.add_argument("--self-test", action="store_true", help="serve privately, check files, exit")
    args = parser.parse_args()

    if args.self_test:
        return self_test()

    cert = args.cert
    key = args.key or args.cert

    if args.https and not cert.exists():
        print(f"Certificate not found: {cert}", file=sys.stderr)
        return 1

    try:
        server = make_server(args.bind, args.port, args.https, cert, key, args.quiet)
    except OSError as err:
        print(f"Could not listen on {args.bind}:{args.port}: {err}", file=sys.stderr)
        print("Is another copy of host.py already running? Try --port 8080.", file=sys.stderr)
        return 1

    print_urls(args.bind, args.port, args.https)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        server.server_close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
