"""Trivial demo target for phosphor_collector smoke tests.

Deliberately tiny: a couple of ordinary function calls plus a print, so it
produces a handful of viztracer "X" events without needing any network
access or external dependencies.
"""


def add(a, b):
    return a + b


def greet(name):
    message = f"hello, {name}"
    print(message)
    return message


def main():
    total = add(2, 3)
    greet(f"world (total={total})")


if __name__ == "__main__":
    main()
