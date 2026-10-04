"""SQLite-heavy demo target for PHOSPHOR MCCP's database-tracing milestone.

Creates its own temporary sqlite3 database file (via ``tempfile``, cleaned up
in a ``finally`` block), runs a handful of real INSERT/SELECT queries against
it through the stdlib ``sqlite3`` module -- no external dependencies, no
network, no mocking -- then, deliberately mirroring ``io_bound.py``'s HTTP
N+1 pattern almost exactly, does one ``SELECT ... WHERE id = ?`` round trip
*per user, in a loop* rather than a single batch query. Each iteration is a
real ``sqlite3.Cursor.execute()`` call, so both viztracer function events
(this script's own Python calls) and the OpenTelemetry ``db_query`` spans
that ``phosphor_collector``'s bootstrap emits when the traced subprocess's
``sqlite3`` module is instrumented (see ``_otel_bootstrap.py``'s
``_instrument_sqlite3``) are genuinely produced together, the same way
``io_bound.py`` exercises ``function_call``/``network_request`` events
together.

Standalone: no CLI args, no real network, no files left behind. Finishes in
well under a second of wall-clock time.
"""

import sqlite3
import tempfile
from pathlib import Path

USER_COUNT = 20
USERS = [(i, f"user-{i}", f"user-{i}@example.test") for i in range(1, USER_COUNT + 1)]


def create_schema(conn):
    conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)")


def insert_users(conn, users):
    # A single real bulk INSERT via executemany -- exercises the
    # executemany span path once, deliberately distinct from the per-row
    # N+1 SELECT loop below.
    conn.executemany("INSERT INTO users (id, name, email) VALUES (?, ?, ?)", users)
    conn.commit()


def fetch_user_count(conn):
    cur = conn.execute("SELECT COUNT(*) FROM users")
    return cur.fetchone()[0]


def fetch_user(conn, user_id):
    cur = conn.execute("SELECT id, name, email FROM users WHERE id = ?", (user_id,))
    return cur.fetchone()


def main():
    db_dir = tempfile.mkdtemp(prefix="phosphor-db-bound-")
    db_path = Path(db_dir) / "demo.sqlite3"
    conn = sqlite3.connect(str(db_path))
    try:
        create_schema(conn)
        insert_users(conn, USERS)

        total = fetch_user_count(conn)
        print(f"inserted {total} users into {db_path}")

        # N+1-style loop: one real SELECT round trip per user rather than a
        # single batch query, so every iteration shows up as its own
        # db_query span in a traced run -- mirrors io_bound.py's HTTP N+1
        # loop so aggregation/explosion-prevention gets exercised on DB
        # edges too, not just HTTP ones.
        fetched = 0
        for user_id, name, _email in USERS:
            row = fetch_user(conn, user_id)
            assert row is not None and row[1] == name
            fetched += 1
        print(f"fetched {fetched} individual users via {fetched} separate SELECT calls")
        print(f"total SQL round trips = 3 + {fetched} (create + bulk insert + count + {fetched} per-user selects)")
    finally:
        conn.close()
        db_path.unlink(missing_ok=True)
        Path(db_dir).rmdir()


if __name__ == "__main__":
    main()
