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
from urllib.parse import parse_qs, quote, unquote, urlsplit

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("BOOKSHELF_PORT", "4173"))
KOKORO_HOST = "127.0.0.1"  # fixed upstream: never derived from the request (no SSRF)
KOKORO_PORT = int(os.environ.get("KOKORO_PORT", "8880"))

BOOKS_DIR = Path(os.environ.get("BOOKSHELF_BOOKS", ROOT / "Books")).resolve()
STATIC_DIRS = tuple(ROOT / d for d in ("styles", "js", "vendor", "assets", "samples"))
BOOK_EXTENSIONS = {".epub", ".pdf", ".txt"}
ALLOWED_HOSTS = {f"localhost:{PORT}", f"127.0.0.1:{PORT}"}
ALLOWED_ORIGINS = {f"http://{h}" for h in ALLOWED_HOSTS}

MAX_TTS_BODY = 16 * 1024
MAX_STATE_BODY = 8 * 1024 * 1024        # reading positions, notes, stats, settings
MAX_UPLOAD_BODY = 300 * 1024 * 1024     # one book file
STATE_FILE = BOOKS_DIR / ".bookshelf-state.json"
STATE_LOCK = threading.Lock()
UPLOAD_LOCK = threading.Lock()
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
        if path == "api/state":
            return self.send_json(read_state())
        if path == "api/tts/voices":
            return self.proxy("GET", "/v1/audio/voices", None)
        target = self.static_target(path)
        if target is None:
            return self.send_error(HTTPStatus.NOT_FOUND)
        if not target.is_relative_to(ROOT):  # a Books folder kept elsewhere (BOOKSHELF_BOOKS)
            return self.send_file(target, head)
        # Hand the vetted absolute path to the stock implementation (handles 304s, ranges of headers).
        self.path = "/" + quote(str(target.relative_to(ROOT)))
        if head:
            super().do_HEAD()
        else:
            super().do_GET()

    def send_file(self, target: Path, head: bool):
        try:
            f = open(target, "rb")
        except OSError:
            return self.send_error(HTTPStatus.NOT_FOUND)
        with f:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", self.guess_type(str(target)))
            self.send_header("Content-Length", str(os.fstat(f.fileno()).st_size))
            self.end_headers()
            if not head:
                self.copyfile(f, self.wfile)

    def do_POST(self):
        if not self.host_ok():
            return
        origin = self.headers.get("Origin")
        if origin is not None and origin not in ALLOWED_ORIGINS:
            return self.send_error(HTTPStatus.FORBIDDEN, "Invalid origin")
        url = urlsplit(self.path)
        if url.path == "/api/tts/speech":
            return self.post_speech()
        # Endpoints that write files additionally require a same-origin browser request.
        if origin is None:
            return self.send_error(HTTPStatus.FORBIDDEN, "Missing origin")
        if url.path == "/api/state":
            return self.post_state()
        if url.path == "/api/books/upload":
            return self.post_upload(parse_qs(url.query).get("name", [""])[0])
        return self.send_error(HTTPStatus.NOT_FOUND)

    def body_length(self, limit: int) -> int | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(HTTPStatus.BAD_REQUEST)
            return None
        if length <= 0 or length > limit:
            self.send_error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            return None
        return length

    def post_speech(self):
        if not self.headers.get("Content-Type", "").startswith("application/json"):
            return self.send_error(HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
        length = self.body_length(MAX_TTS_BODY)
        if length is None:
            return
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

    def post_state(self):
        """Save the app's reading state (positions, notes, stats, settings) next to the books."""
        if not self.headers.get("Content-Type", "").startswith("application/json"):
            return self.send_error(HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
        length = self.body_length(MAX_STATE_BODY)
        if length is None:
            return
        try:
            data = json.loads(self.rfile.read(length))
        except ValueError:
            return self.send_json({"error": "Invalid JSON."}, HTTPStatus.BAD_REQUEST)
        if not isinstance(data, dict):
            return self.send_json({"error": "State must be an object."}, HTTPStatus.BAD_REQUEST)
        write_state(data)
        return self.send_json({"ok": True})

    def post_upload(self, raw_name: str):
        """Keep a copy of a book added in the app inside the Books folder."""
        name = safe_book_name(raw_name)
        if name is None:
            return self.send_json({"error": "Unsupported file name."}, HTTPStatus.BAD_REQUEST)
        length = self.body_length(MAX_UPLOAD_BODY)
        if length is None:
            return
        BOOKS_DIR.mkdir(exist_ok=True)
        tmp = BOOKS_DIR / f".upload-{threading.get_ident()}.part"
        try:
            with open(tmp, "wb") as out:
                remaining = length
                while remaining:
                    chunk = self.rfile.read(min(1 << 20, remaining))
                    if not chunk:
                        raise OSError("connection closed")
                    out.write(chunk)
                    remaining -= len(chunk)
            with UPLOAD_LOCK:
                target = unique_book_path(name, tmp)
                if target.exists():  # identical file already there
                    tmp.unlink()
                else:
                    os.replace(tmp, target)
        except OSError:
            tmp.unlink(missing_ok=True)
            return self.send_json({"error": "Could not save the file."}, HTTPStatus.INTERNAL_SERVER_ERROR)
        stat = target.stat()
        return self.send_json({"name": target.name, "size": stat.st_size, "mtime": int(stat.st_mtime)})

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


def read_state() -> dict:
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def write_state(data: dict) -> None:
    BOOKS_DIR.mkdir(exist_ok=True)
    with STATE_LOCK:  # write-then-rename so a crash never leaves half a file
        tmp = STATE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        os.replace(tmp, STATE_FILE)


def safe_book_name(raw: str) -> str | None:
    """A plain file name (no folders, no hidden files) with a book extension."""
    name = re.sub(r"[\x00-\x1f\x7f/\\:]", "", raw).strip()
    if not name or name.startswith(".") or len(name.encode("utf-8")) > 200:
        return None
    if Path(name).suffix.lower() not in BOOK_EXTENSIONS or Path(name).name != name:
        return None
    return name


def same_file(a: Path, b: Path) -> bool:
    if a.stat().st_size != b.stat().st_size:
        return False
    with open(a, "rb") as fa, open(b, "rb") as fb:
        while True:
            x, y = fa.read(1 << 20), fb.read(1 << 20)
            if x != y:
                return False
            if not x:
                return True


def unique_book_path(name: str, data: Path) -> Path:
    """Books/<name>, or Books/<name> (2) … when a different file already uses the name.
    Returns an existing path only when that file is identical to `data`."""
    stem, suffix = Path(name).stem, Path(name).suffix
    for n in range(1, 1000):
        candidate = BOOKS_DIR / (name if n == 1 else f"{stem} ({n}){suffix}")
        if not candidate.exists() or same_file(candidate, data):
            return candidate
    raise OSError("too many copies")


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
