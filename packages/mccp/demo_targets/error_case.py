"""Deliberate-failure demo target for PHOSPHOR MCCP's error-tracing milestone.

Two distinct, real failures happen here, in order:

1. A genuinely malformed SQL statement (a real ``sqlite3.OperationalError``,
   from selecting a column that does not exist) against a real temporary
   sqlite3 database -- caught locally so the script keeps running afterward.
   This exercises ``_otel_bootstrap.py``'s ``_instrument_sqlite3`` emitting a
   real ERROR-status ``db_query`` span (see that function's ``_traced_call``).
2. An uncaught, real ``ZeroDivisionError`` at the very end of the script --
   never caught anywhere, so it escapes ``runpy.run_path`` in
   ``_otel_bootstrap.py`` and terminates the script. This exercises that
   bootstrap's top-level exception handling, which emits a real
   ERROR-status ``"phosphor.uncaught_exception"`` span (see
   ``_emit_error_span``) before the subprocess exits non-zero.

Some ordinary, successful work happens both before AND after failure (1) --
proving a single real failure, once safely captured, does not corrupt or
truncate the rest of the trace. Failure (2) is the script's genuine last act
(matching what "uncaught exception" means), so nothing meaningful happens
after it.

No external dependencies, no network, no sleeps -- finishes in well under a
second of wall-clock time. Cleans up its temp database file in a ``finally``
block even though the script ultimately crashes.
"""

import os
import sqlite3
import tempfile


def setup_database(path):
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)")
    conn.execute("INSERT INTO items (id, name) VALUES (1, 'widget')")
    conn.commit()
    conn.close()


def run_bad_query(path):
    """Deliberately malformed SQL: 'price' is not a column of 'items'.

    Caught locally -- this is the recovered failure, exercising the
    db_query-specific ERROR-status span path without ending the script.
    """
    conn = sqlite3.connect(path)
    try:
        conn.execute("SELECT price FROM items")
    except sqlite3.OperationalError:
        pass
    finally:
        conn.close()


def compute_after_recovered_failure(a, b):
    """Ordinary work that must still show up in the trace after failure (1)."""
    return a + b


def crash(numerator, denominator):
    """The script's genuine, uncaught, terminal failure."""
    return numerator // denominator


def main():
    fd, db_path = tempfile.mkstemp(prefix="phosphor-error-case-", suffix=".sqlite3")
    os.close(fd)
    try:
        setup_database(db_path)
        run_bad_query(db_path)

        total = compute_after_recovered_failure(2, 3)
        print(f"still running after the recovered db_query failure: {total}")

        # Deliberate, real, uncaught failure -- terminates the script.
        crash(1, 0)
    finally:
        os.remove(db_path)


if __name__ == "__main__":
    main()
