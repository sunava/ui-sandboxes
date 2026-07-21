#!/usr/bin/env python3
"""Tiny static file server for the TraceBot showcase.

The whole app runs in the browser (Three.js robot + tau-prolog knowledge base);
this server only exists because URDF meshes are loaded over HTTP and browsers
block file:// XHR. No external dependencies.

    python3 server.py            # serves on http://localhost:8711
    python3 server.py 9000       # custom port
"""
import http.server
import os
import socketserver
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8711


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # meshes / libs are static; let the browser cache within a session
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):  # keep the console quiet but useful
        sys.stderr.write("  %s\n" % (fmt % args))


def main():
    os.chdir(ROOT)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("", PORT), Handler) as httpd:
        url = "http://localhost:%d/" % PORT
        print("\n  TraceBot showcase running at  %s\n  (Ctrl-C to stop)\n" % url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  stopped.")


if __name__ == "__main__":
    main()
