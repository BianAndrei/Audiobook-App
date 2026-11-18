#!/usr/bin/env python3
"""Start / stop Classic Bookshelf and its local Kokoro voice server.

    ./bookshelf start            start Kokoro (if needed) + the reader, open the browser
    ./bookshelf start --no-open  same, without opening a browser tab
    ./bookshelf stop             stop the reader and Kokoro (frees memory)
    ./bookshelf stop --keep-voice   stop only the reader
    ./bookshelf status           show what is running
    ./bookshelf restart

No shell is ever invoked with user input; only processes we started are signalled.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RUN = ROOT / ".run"
PID_FILE = RUN / "server.pid"
KOKORO_PID_FILE = RUN / "kokoro.pid"
LOG = RUN / "server.log"
KOKORO_LOG = RUN / "kokoro.log"
PORT = int(os.environ.get("BOOKSHELF_PORT", "4173"))
KOKORO_PORT = int(os.environ.get("KOKORO_PORT", "8880"))
KOKORO_DIR = Path(os.environ.get("KOKORO_DIR", Path.home() / "local-ai-book-reader" / "Kokoro-FastAPI"))
KOKORO_AGENT = "local.aibookreader.kokoro"
KOKORO_PLIST = Path.home() / "Library" / "LaunchAgents" / f"{KOKORO_AGENT}.plist"
DOMAIN = f"gui/{os.getuid()}"
URL = f"http://localhost:{PORT}/"


def http_ok(url: str, timeout: float = 2.0) -> bool:
    # Only ever probe our own loopback services (urllib would also accept file:// etc.).
    if not url.startswith(("http://localhost:", "http://127.0.0.1:")):
        raise ValueError("refusing non-loopback URL")
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:  # loopback only
            return resp.status == 200
    except OSError:
        return False


def reader_up() -> bool:
    return http_ok(f"http://localhost:{PORT}/api/health")


def kokoro_up() -> bool:
    return http_ok(f"http://127.0.0.1:{KOKORO_PORT}/v1/audio/voices", timeout=3)


def read_pid(path: Path) -> int | None:
    try:
        return int(path.read_text().strip())
    except (OSError, ValueError):
        return None


def pid_matches(pid: int, needle: str) -> bool:
    """Only signal a process whose command line is really ours."""
    try:
        out = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True, check=False)
    except OSError:
        return False
    return needle in out.stdout


def agent_loaded() -> bool:
    return subprocess.run(["launchctl", "print", f"{DOMAIN}/{KOKORO_AGENT}"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def wait_for(check, seconds: float, label: str) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline:
        if check():
            return True
        time.sleep(0.5)
    print(f"  {label} did not answer within {int(seconds)} s.")
    return False


def start_kokoro():
    if kokoro_up():
        print(f"✓ Kokoro voice server already running on port {KOKORO_PORT}")
        return True
    print("… starting the Kokoro voice server (first start can take ~30 s)")
    if KOKORO_PLIST.is_file():
        subprocess.run(["launchctl", "enable", f"{DOMAIN}/{KOKORO_AGENT}"], check=False)
        # launchd unloads asynchronously after a bootout, so retry for a few seconds.
        for attempt in range(8):
            if agent_loaded():
                subprocess.run(["launchctl", "kickstart", f"{DOMAIN}/{KOKORO_AGENT}"], check=False)
                break
            result = subprocess.run(["launchctl", "bootstrap", DOMAIN, str(KOKORO_PLIST)],
                                    capture_output=True, text=True, check=False)
            if result.returncode == 0:
                break
            if attempt == 7:
                print(f"  launchctl: {result.stderr.strip()}")
            time.sleep(1)
        time.sleep(2)
        if not agent_loaded():  # a racing unload swallowed the kickstart: load it again
            subprocess.run(["launchctl", "bootstrap", DOMAIN, str(KOKORO_PLIST)], check=False)
    elif (KOKORO_DIR / ".venv" / "bin" / "python").is_file():
        RUN.mkdir(exist_ok=True)
        log = open(KOKORO_LOG, "ab")
        proc = subprocess.Popen(["/bin/bash", str(ROOT / "scripts" / "start-kokoro.sh"), str(KOKORO_DIR)],
                                stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True)
        KOKORO_PID_FILE.write_text(str(proc.pid))
    else:
        print(f"✗ Kokoro is not installed at {KOKORO_DIR}. See README.md → 'Installing Kokoro'.")
        return False
    ok = wait_for(kokoro_up, 120, "Kokoro")
    print("✓ Kokoro voice server running" if ok else "✗ Kokoro failed to start; see logs in .run/ or ~/local-ai-book-reader/kokoro.log")
    return ok


def start_reader():
    if reader_up():
        print(f"✓ Reader already running at {URL}")
        return True
    RUN.mkdir(exist_ok=True)
    log = open(LOG, "ab")
    proc = subprocess.Popen([sys.executable, str(ROOT / "server.py")], cwd=str(ROOT),
                            stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True)
    PID_FILE.write_text(str(proc.pid))
    ok = wait_for(reader_up, 15, "Reader")
    print(f"✓ Reader running at {URL}" if ok else "✗ Reader failed to start; see .run/server.log")
    return ok


def stop_reader():
    pid = read_pid(PID_FILE)
    if pid and pid_matches(pid, "server.py"):
        os.kill(pid, signal.SIGTERM)
        for _ in range(20):
            if not pid_matches(pid, "server.py"):
                break
            time.sleep(0.1)
        print("✓ Reader stopped")
    elif reader_up():
        print("! The reader is running but was not started by this script; stop it in its own terminal.")
    else:
        print("· Reader was not running")
    PID_FILE.unlink(missing_ok=True)


def stop_kokoro():
    stopped = False
    if agent_loaded():
        subprocess.run(["launchctl", "bootout", f"{DOMAIN}/{KOKORO_AGENT}"], check=False)
        for _ in range(40):  # bootout is asynchronous: wait until the service is really gone
            if not agent_loaded():
                break
            time.sleep(0.25)
        stopped = True
    pid = read_pid(KOKORO_PID_FILE)
    if pid and pid_matches(pid, "start-kokoro.sh"):
        os.killpg(pid, signal.SIGTERM)
        stopped = True
    KOKORO_PID_FILE.unlink(missing_ok=True)
    print("✓ Kokoro voice server stopped" if stopped else "· Kokoro was not started by this app")


def open_app():
    """Open Bookshelf in its own window: the installed app if present, else a Chrome app window."""
    installed = [Path.home() / "Applications" / "Chrome Apps.localized" / "Bookshelf.app",
                 Path.home() / "Applications" / "Bookshelf.app"]
    for app in installed:
        if app.is_dir():
            subprocess.run(["open", "-a", str(app)], check=False)
            return
    if Path("/Applications/Google Chrome.app").is_dir():
        subprocess.run(["open", "-na", "Google Chrome", "--args", f"--app={URL}"], check=False)
    else:
        subprocess.run(["open", URL], check=False)


def status():
    print(f"Reader  ({URL}): {'running' if reader_up() else 'stopped'}")
    print(f"Kokoro  (port {KOKORO_PORT}): {'running' if kokoro_up() else 'stopped'}")
    if reader_up():
        try:
            with urllib.request.urlopen(f"http://localhost:{PORT:d}/api/books", timeout=2) as resp:  # nosemgrep: loopback, int port
                books = json.load(resp).get("books", [])
            print(f"Books folder: {len(books)} file(s) in {ROOT / 'Books'}")
        except OSError:
            pass


def main(argv: list[str]) -> int:
    if not argv or argv[0] not in {"start", "stop", "status", "restart"}:
        print(__doc__)
        return 1
    cmd, flags = argv[0], set(argv[1:])
    if cmd in ("stop", "restart"):
        stop_reader()
        if cmd == "stop" and "--keep-voice" not in flags:
            stop_kokoro()
    if cmd in ("start", "restart"):
        voice = start_kokoro()
        reader = start_reader()
        if reader and "--no-open" not in flags:
            open_app()
        if reader and not voice:
            print("  The library works without Kokoro, but narration needs it.")
        return 0 if reader else 1
    if cmd == "status":
        status()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
