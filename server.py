#!/usr/bin/env python3
"""Classic Bookshelf - local web server.

Serves the reader app, lists the ./Books folder, and proxies a small,
validated subset of the local Kokoro-FastAPI server so the browser only ever
talks to one origin (no CORS configuration needed on Kokoro).

Listens on the loopback interface only. Standard library only.
"""

from __future__ import annotations

import http.client
import json
import os
import re
import select
import socket
import sys
import threading
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("BOOKSHELF_PORT", "4173"))
KOKORO_HOST = "127.0.0.1"  # fixed upstream: never derived from the request (no SSRF)
KOKORO_PORT = int(os.environ.get("KOKORO_PORT", "8880"))

BOOKS_DIR = ROOT / "Books"
STATIC_DIRS = tuple(ROOT / d for d in ("styles", "js", "vendor", "assets", "samples"))
BOOK_EXTENSIONS = {".epub", ".pdf", ".txt"}
ALLOWED_HOSTS = {f"localhost:{PORT}", f"127.0.0.1:{PORT}"}
ALLOWED_ORIGINS = {f"http://{h}" for h in ALLOWED_HOSTS}

MAX_TTS_BODY = 16 * 1024
MAX_TTS_INPUT = 2000
VOICE_RE = re.compile(r"^[a-z]{2}_[a-z0-9_]{1,40}$")
SYNTH_LOCK = threading.Lock()

CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
])


class Handler(SimpleHTTPRequestHandler):
    server_version = "ClassicBookshelf/1.0"
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
        ".epub": "application/epub+zip",
        ".pdf": "application/pdf",
        ".txt": "text/plain; charset=utf-8",
        ".webmanifest": "application/manifest+json",
        ".png": "image/png",
        ".bcmap": "application/octet-stream",
        ".pfb": "application/octet-stream",
        ".ttf": "font/ttf",
    }

    # ----- helpers -------------------------------------------------------
    def log_message(self, fmt, *args):  # keep logs quiet: only errors
        pass

    def log_error(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def host_ok(self) -> bool:
        # Blocks DNS-rebinding: a foreign site resolving to 127.0.0.1 still sends its own Host.
        if self.headers.get("Host", "") not in ALLOWED_HOSTS:
            self.send_error(HTTPStatus.FORBIDDEN, "Invalid host")
            return False
        return True

    def send_json(self, payload, status=HTTPStatus.OK):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def static_target(self, path: str) -> Path | None:
        if path in ("", "index.html"):
            return ROOT / "index.html"
        if path in ("sw.js", "manifest.webmanifest"):  # must live at the root for scope
            return ROOT / path
        if path.startswith("books/"):
            name = path[len("books/"):]
            if "/" in name or "\\" in name or name.startswith("."):
                return None
            target = (BOOKS_DIR / name).resolve()
            if target.parent == BOOKS_DIR.resolve() and target.suffix.lower() in BOOK_EXTENSIONS:
                return target if target.is_file() else None
            return None
        target = (ROOT / path).resolve()
        # Path traversal guard: the resolved file must live inside an allowed folder.
        if any(target.is_relative_to(d.resolve()) for d in STATIC_DIRS) and target.is_file():
            return target
        return None

    # ----- routes --------------------------------------------------------
    def do_GET(self):
        self.route(head=False)

    def do_HEAD(self):
        self.route(head=True)

    def route(self, head: bool):
        if not self.host_ok():
            return
        path = unquote(urlsplit(self.path).path).lstrip("/")
        if path == "api/health":
            return self.send_json({"ok": True, "kokoro": kokoro_alive()})
        if path == "api/books":
            return self.send_json({"books": list_books()})
        if path == "api/tts/voices":
            return self.proxy("GET", "/v1/audio/voices", None)
        target = self.static_target(path)
        if target is None:
            return self.send_error(HTTPStatus.NOT_FOUND)
        # Hand the vetted absolute path to the stock implementation (handles 304s, ranges of headers).
        self.path = "/" + quote(str(target.relative_to(ROOT)))
        if head:
            super().do_HEAD()
        else:
            super().do_GET()

    def do_POST(self):
        if not self.host_ok():
            return
        origin = self.headers.get("Origin")
        if origin is not None and origin not in ALLOWED_ORIGINS:
            return self.send_error(HTTPStatus.FORBIDDEN, "Invalid origin")
        if urlsplit(self.path).path != "/api/tts/speech":
            return self.send_error(HTTPStatus.NOT_FOUND)
        if not self.headers.get("Content-Type", "").startswith("application/json"):
            return self.send_error(HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.send_error(HTTPStatus.BAD_REQUEST)
        if length <= 0 or length > MAX_TTS_BODY:
            return self.send_error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
        try:
            data = json.loads(self.rfile.read(length))
            payload = validate_speech(data)
        except (ValueError, TypeError) as error:
            return self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        # PyTorch's Metal (MPS) backend crashes Kokoro when two syntheses run at once, so all
        # speech requests go through one at a time. Requests whose browser tab already gave up
        # (the reader skipped ahead and aborted them) are dropped instead of synthesised.
        with SYNTH_LOCK:
            if self.client_gone():
                self.close_connection = True
                return
            self.proxy("POST", "/v1/audio/speech", json.dumps(payload).encode("utf-8"))

    def client_gone(self) -> bool:
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            return bool(readable) and self.connection.recv(1, socket.MSG_PEEK) == b""
        except OSError:
            return True

    def proxy(self, method: str, upstream_path: str, body: bytes | None):
        conn = http.client.HTTPConnection(KOKORO_HOST, KOKORO_PORT, timeout=180)
        try:
            headers = {"Content-Type": "application/json"} if body else {}
            conn.request(method, upstream_path, body=body, headers=headers)
            resp = conn.getresponse()
            data = resp.read()
        except OSError:
            return self.send_json(
                {"error": "The Kokoro voice server is not running on port %d." % KOKORO_PORT},
                HTTPStatus.BAD_GATEWAY,
            )
        finally:
            conn.close()
        self.send_response(resp.status)
        self.send_header("Content-Type", resp.getheader("Content-Type", "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def validate_speech(data) -> dict:
    """Rebuild the Kokoro request from validated fields only (no passthrough)."""
    if not isinstance(data, dict):
        raise ValueError("Body must be a JSON object.")
    text = data.get("input")
    voice = data.get("voice")
    speed = data.get("speed", 1.0)
    fmt = data.get("response_format", "wav")
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TTS_INPUT:
        raise ValueError("input must be 1-%d characters." % MAX_TTS_INPUT)
    if not isinstance(voice, str) or not VOICE_RE.match(voice):
        raise ValueError("Invalid voice id.")
    if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not 0.5 <= speed <= 2.5:
        raise ValueError("speed must be between 0.5 and 2.5.")
    if fmt not in ("wav", "mp3"):
        raise ValueError("response_format must be wav or mp3.")
    return {"model": "kokoro", "input": text, "voice": voice, "speed": float(speed),
            "response_format": fmt, "stream": False}


def kokoro_alive() -> bool:
    conn = http.client.HTTPConnection(KOKORO_HOST, KOKORO_PORT, timeout=2)
    try:
        conn.request("GET", "/v1/audio/voices")
        return conn.getresponse().status == 200
    except OSError:
        return False
    finally:
        conn.close()


def list_books() -> list[dict]:
    if not BOOKS_DIR.is_dir():
        return []
    books = []
    for entry in sorted(BOOKS_DIR.iterdir()):
        if entry.is_file() and not entry.name.startswith(".") and entry.suffix.lower() in BOOK_EXTENSIONS:
            stat = entry.stat()
            books.append({"name": entry.name, "size": stat.st_size, "mtime": int(stat.st_mtime)})
    return books


def main():
    BOOKS_DIR.mkdir(exist_ok=True)
    ThreadingHTTPServer.allow_reuse_address = True
    handler = partial(Handler, directory=str(ROOT))
    with ThreadingHTTPServer(("127.0.0.1", PORT), handler) as server:
        print(f"Classic Bookshelf running at http://localhost:{PORT}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
