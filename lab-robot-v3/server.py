#!/usr/bin/env python3
"""Static file + EQL query server for the TraceBot showcase.

The robot viewer runs in the browser; the knowledge side is served from here:
EQL (krrood's Entity Query Language, part of the CRAM architecture) queries are
executed server-side against the demo episode KB in eql_kb.py.

    python3 server.py            # serves on http://localhost:8711
    python3 server.py 9000       # custom port

krrood lives in the cram-env virtualenv — if it is not importable, the server
re-execs itself under that interpreter automatically.
"""
import http.server
import json
import os
import socketserver
import sys
import threading
import traceback

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8711
CRAM_PYTHON = os.path.expanduser("~/.virtualenvs/cram-env/bin/python")

try:
    import krrood  # noqa: F401  (the EQL engine)
except ModuleNotFoundError:
    if os.path.exists(CRAM_PYTHON) and os.environ.get("EQL_REEXEC") != "1":
        os.environ["EQL_REEXEC"] = "1"
        os.execv(CRAM_PYTHON, [CRAM_PYTHON] + sys.argv)
    krrood = None

sys.path.insert(0, ROOT)
try:
    import eql_kb
except Exception:                      # krrood missing → static serving still works
    eql_kb = None
    traceback.print_exc()


_EQL_LOCK = threading.Lock()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # meshes / libs are static; let the browser cache within a session
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):  # keep the console quiet but useful
        sys.stderr.write("  %s\n" % (fmt % args))

    # ---- JSON API ----------------------------------------------------------
    def _json(self, payload, code=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        route = self.path.split("?")[0]
        if route == "/api/kb":
            if eql_kb is None:
                return self._json({"ok": False, "error": "krrood/EQL not available — run under cram-env"})
            try:
                return self._json(eql_kb.graph_payload())
            except Exception as ex:
                return self._json({"ok": False, "error": "%s: %s" % (type(ex).__name__, ex)})
        if route == "/api/kb/expand":
            if eql_kb is None:
                return self._json({"ok": False, "error": "krrood/EQL not available — run under cram-env"})
            try:
                from urllib.parse import urlparse, parse_qs
                node = (parse_qs(urlparse(self.path).query).get("node") or [""])[0]
                payload = eql_kb.expand_node(node)
                return self._json(payload if payload else {"ok": False, "error": "not drillable"})
            except Exception as ex:
                return self._json({"ok": False, "error": "%s: %s" % (type(ex).__name__, ex)})
        return super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0] != "/api/eql":
            return self._json({"ok": False, "error": "unknown endpoint"}, 404)
        if eql_kb is None:
            return self._json({"ok": False, "error": "krrood/EQL not available — run under cram-env"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(length) or b"{}")
            code = (req.get("code") or "").strip()
            if not code:
                return self._json({"ok": False, "error": "empty query"})
            with _EQL_LOCK:            # krrood's SymbolGraph singleton is not threadsafe
                return self._json(eql_kb.run_query(code))
        except SyntaxError as ex:
            return self._json({"ok": False, "error": "SyntaxError: %s" % ex})
        except Exception as ex:
            return self._json({"ok": False, "error": "%s: %s" % (type(ex).__name__, ex)})


def main():
    os.chdir(ROOT)
    if eql_kb is not None:             # build the KB once, before the first query
        eql_kb.get_kb()
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("", PORT), Handler) as httpd:
        url = "http://localhost:%d/" % PORT
        eql = "EQL ready (krrood)" if eql_kb is not None else "EQL UNAVAILABLE — static only"
        print("\n  TraceBot showcase running at  %s\n  %s\n  (Ctrl-C to stop)\n" % (url, eql))
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  stopped.")


if __name__ == "__main__":
    main()
