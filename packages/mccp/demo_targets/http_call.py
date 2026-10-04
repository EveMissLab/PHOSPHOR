"""Demo target that makes one real HTTP GET call, for exercising the OTel
requests-instrumentation path end to end.

Deliberately takes the target URL from an environment variable
(``PHOSPHOR_DEMO_URL``) rather than hardcoding a host: the calling test spins
up its own local ``http.server`` in a background thread and passes that
server's URL in, so this never touches the real network and stays fully
offline and deterministic.
"""

import os

import requests


def call_once(url: str) -> str:
    response = requests.get(url, timeout=10)
    return response.text


def main():
    url = os.environ["PHOSPHOR_DEMO_URL"]
    body = call_once(url)
    print(f"got {len(body)} bytes")


if __name__ == "__main__":
    main()
