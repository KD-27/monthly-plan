"""
Monthly Plan — tiny local file server.

Serves index.html over http://127.0.0.1:8731 and gives the page a real file on
disk to live in.  The browser is now just a window; data/data.json beside this
script is the single source of truth.

  GET  /api/data   -> data.json (or {} on first run)
  POST /api/data   -> atomic overwrite of data.json, previous copy kept
  GET  /api/ping   -> heartbeat; the server stops once these stop arriving
  POST /api/quit   -> shut down now

It exits on its own when the app window is closed, so the launcher can fire it
off and get out of the way -- no console window left sitting on the taskbar.

Standard library only.  No install, no dependencies.
"""

import http.server
import json
import os
import shutil
import socket
import socketserver
import sys
import threading
import time

HOST = "127.0.0.1"
PORT = 8731
APPDIR = os.path.dirname(os.path.abspath(__file__))
DATADIR = os.path.join(APPDIR, "data")
DATA = os.path.join(DATADIR, "data.json")
BACKUP = os.path.join(DATADIR, "data.backup.json")

GRACE = 90        # seconds without a heartbeat before shutting down
FIRST_WAIT = 120  # longer leash before the first page ever loads

_write_lock = threading.Lock()
_last_seen = [time.time()]
_ever_seen = [False]


def touch():
    _last_seen[0] = time.time()
    _ever_seen[0] = True


class DiskBusy(Exception):
    """The file is there but couldn't be opened right now -- not the same as damaged."""


# OneDrive and antivirus open data.json for a moment after every change, and on
# Windows that makes open()/replace() fail with PermissionError. Wait it out.
RETRIES, RETRY_GAP = 25, 0.1   # up to ~2.5 s


def _patiently(fn):
    last = None
    for _ in range(RETRIES):
        try:
            return fn()
        except OSError as err:          # locked, or briefly missing mid-replace
            last = err
            time.sleep(RETRY_GAP)
    raise DiskBusy(str(last))


def _read_text():
    with open(DATA, "r", encoding="utf-8") as f:
        return f.read()


def read_data():
    """Return the saved log.

    A file that can't be *opened* is busy, not broken: retry, then report
    DiskBusy so the page knows the read failed -- never answer {} for it, because
    an empty answer would make the page start over from the browser's copy.
    Only content that isn't valid JSON is set aside as data.corrupt-*.json.
    """
    with _write_lock:                   # never read halfway through a save
        if not os.path.exists(DATA):
            return {}
        raw = _patiently(_read_text)
        try:
            parsed = json.loads(raw)
            if not isinstance(parsed, dict):
                raise ValueError("not an object")
            return parsed
        except ValueError as err:
            spoiled = os.path.join(DATADIR, "data.corrupt-%s.json" % time.strftime("%Y%m%d-%H%M%S"))
            try:
                shutil.copy2(DATA, spoiled)
                print("[monthly-plan] data.json is not valid JSON (%s) -- copy kept at %s" % (err, spoiled))
            except OSError:
                print("[monthly-plan] data.json is not valid JSON (%s)" % err)
            return {}


def write_data(payload):
    """Write via temp file + replace, so a crash mid-write can't shred the log."""
    with _write_lock:
        if os.path.exists(DATA):
            try:
                _patiently(lambda: shutil.copy2(DATA, BACKUP))
            except DiskBusy:
                pass                    # a missed backup refresh isn't worth failing the save
        tmp = DATA + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
            f.flush()
            os.fsync(f.fileno())
        _patiently(lambda: os.replace(tmp, DATA))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=APPDIR, **kw)

    def log_message(self, *a):
        pass  # keep the console quiet

    def end_headers(self):
        # never let Chrome cache the app, or edits to index.html go unseen
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _send(self, code, body=b"", ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        route = self.path.split("?")[0]
        if route == "/api/ping":
            touch()
            self._send(200, b'{"ok":true}')
            return
        touch()
        if route == "/api/data":
            try:
                body = json.dumps(read_data(), ensure_ascii=False).encode("utf-8")
            except DiskBusy as err:
                print("[monthly-plan] data.json busy, read refused:", err)
                self._send(503, json.dumps({"error": "busy"}).encode("utf-8"))
                return
            self._send(200, body)
            return
        super().do_GET()

    def do_POST(self):
        route = self.path.split("?")[0]
        touch()
        if route == "/api/quit":
            self._send(200, b'{"ok":true}')
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if route != "/api/data":
            self._send(404, b'{"error":"not found"}')
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("expected an object")
            write_data(payload)
            self._send(200, b'{"ok":true}')
        except DiskBusy as err:
            print("[monthly-plan] save failed, data.json busy:", err)
            self._send(503, json.dumps({"error": "busy"}).encode("utf-8"))
        except Exception as err:
            print("[monthly-plan] save failed:", err)
            self._send(400, json.dumps({"error": str(err)}).encode("utf-8"))


def adopt_legacy():
    """The log used to sit beside this script. A server from before the move to
    data/ can still write there until it restarts, so a leftover root data.json
    that is newer than data/data.json is the latest log: bring it in (the one it
    replaces becomes the backup). An older leftover is kept aside, never deleted."""
    os.makedirs(DATADIR, exist_ok=True)
    old = os.path.join(APPDIR, "data.json")
    if not os.path.exists(old):
        return
    if not os.path.exists(DATA) or os.path.getmtime(old) >= os.path.getmtime(DATA):
        if os.path.exists(DATA):
            _patiently(lambda: shutil.copy2(DATA, BACKUP))
        _patiently(lambda: os.replace(old, DATA))
        print("[monthly-plan] moved data.json into data/")
    else:
        aside = os.path.join(DATADIR, "data.old-root-%s.json" % time.strftime("%Y%m%d-%H%M%S"))
        _patiently(lambda: os.replace(old, aside))
        print("[monthly-plan] older root data.json kept as", aside)
    old_backup = os.path.join(APPDIR, "data.backup.json")
    if os.path.exists(old_backup):
        _patiently(lambda: os.replace(old_backup, os.path.join(DATADIR, "data.backup.old-root.json")))


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = False  # so a second launch detects the first, not steals it


def main():
    try:
        srv = Server((HOST, PORT), Handler)
    except OSError:
        print("[monthly-plan] already running on port %d" % PORT)
        return 0
    try:
        adopt_legacy()
    except Exception as err:            # never let housekeeping stop the app from opening
        print("[monthly-plan] could not tidy the old data location:", err)
    print("[monthly-plan] serving %s at http://%s:%d" % (APPDIR, HOST, PORT))

    def reaper():
        """Close up once the app window is gone, so nothing is left running."""
        while True:
            time.sleep(10)
            idle = time.time() - _last_seen[0]
            if idle > (GRACE if _ever_seen[0] else FIRST_WAIT):
                print("[monthly-plan] idle for %ds - shutting down" % int(idle))
                srv.shutdown()
                return

    threading.Thread(target=reaper, daemon=True).start()

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
