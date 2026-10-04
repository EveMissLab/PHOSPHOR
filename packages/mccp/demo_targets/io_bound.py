"""I/O/HTTP-heavy demo target for PHOSPHOR MCCP's first milestone demo.

Spins up its own tiny ``http.server`` on a background thread (bound to
``127.0.0.1`` on an OS-assigned port -- fully offline, no real internet
dependency, no external services), serving two JSON endpoints
(``/users`` and ``/users/<id>``), then makes 21 real HTTP round trips
against it with ``requests``: one ``GET /users`` to list everyone, then one
``GET /users/<id>`` *per user* in a loop -- deliberately mirroring the
whitepaper's own N+1-query example almost exactly, rather than a single
batch call. Each of those round trips is real socket I/O through the local
loopback interface, so both viztracer function events (this script's own
Python calls) and OpenTelemetry ``network_request`` spans (from the
requests instrumentation phosphor_collector's bootstrap installs when this
script is traced) are genuinely produced and need to appear together in one
graph.

Standalone: no CLI args, no real network. Finishes in well under a second
of wall-clock time.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests

USER_COUNT = 20
USERS = [
    {"id": i, "name": f"user-{i}", "email": f"user-{i}@example.test"}
    for i in range(1, USER_COUNT + 1)
]
_USERS_BY_ID = {u["id"]: u for u in USERS}


class _DemoHandler(BaseHTTPRequestHandler):
    """Minimal JSON handler for the two endpoints this demo needs."""

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/users":
            self._send_json(200, USERS)
            return
        if self.path.startswith("/users/"):
            raw_id = self.path[len("/users/") :]
            try:
                user_id = int(raw_id)
            except ValueError:
                self._send_json(400, {"error": "invalid id"})
                return
            user = _USERS_BY_ID.get(user_id)
            if user is None:
                self._send_json(404, {"error": "not found"})
                return
            self._send_json(200, user)
            return
        self._send_json(404, {"error": "not found"})

    def log_message(self, format, *args):  # noqa: A002 -- BaseHTTPRequestHandler's signature
        pass  # silence default stderr access logging, keep demo output clean


def start_server():
    """Bind a ThreadingHTTPServer on an OS-assigned loopback port and serve
    it on a daemon background thread. Returns (server, base_url)."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), _DemoHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{port}"


def fetch_user_list(base_url):
    response = requests.get(f"{base_url}/users", timeout=5)
    response.raise_for_status()
    return response.json()


def fetch_user(base_url, user_id):
    response = requests.get(f"{base_url}/users/{user_id}", timeout=5)
    response.raise_for_status()
    return response.json()


def main():
    server, base_url = start_server()
    try:
        users = fetch_user_list(base_url)
        print(f"listed {len(users)} users from {base_url}/users")

        # N+1-style loop: one real HTTP round trip per user rather than a
        # single batch call, so every iteration shows up as its own
        # OTel network_request span in a traced run.
        fetched = 0
        for user in users:
            detail = fetch_user(base_url, user["id"])
            assert detail["id"] == user["id"]
            fetched += 1
        print(f"fetched {fetched} individual users via {fetched} separate HTTP calls")
        print(f"total HTTP round trips = {1 + fetched} (1 list call + {fetched} per-user calls)")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
