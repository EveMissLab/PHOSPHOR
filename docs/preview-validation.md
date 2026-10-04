# Preview validation — 2026-10-04

Observed locally on Windows with Python 3.13.13 and Node.js 24.16.0. These are local results; no new GitHub Actions run or production deployment is implied.

| Surface | Result |
| --- | --- |
| EAI | 272 checks across 11 harnesses; TypeScript check passed |
| Spacetime | 141 passed, 1 Linux-only native test skipped; Windows Job Object native test executed |
| Spacetime gates | Gate 0–6 passed from both the source installation and the wheel installation |
| Temporal demo | CONFIRMED rate 2.5, tick 50 after 20 quanta, equal tick/event-jump state hashes, 47 idle ticks skipped |
| Benchmark CLI | Installed-wheel matrix B0–B3 produced valid records and a comparison report |
| MCCP | 106 tests passed |
| MCCP installed wheel | A real local script was traced; API graph and packaged HTML/JS returned HTTP 200 |
| Browser | Eleven EAI tabs available; the safe WASM proposal executed, the buggy one was rejected even when approved |
| Website/UI | Both Vite builds passed; Spacetime's 390-pixel mobile page fit the viewport |
| Windows EXE | Help, double-click menu, temporal demo, B0–B3 matrix, and Gate 0–6 passed; demo also passed with system-only PATH |
| EXE privacy | Embedded archive, Python modules and code filenames inspected; no current workstation identifiers found |

Delivery repairs: installable Spacetime schemas, packaged MCCP UI assets, portable EAI CLI-test working directory, synthetic monitor fixture, explicit-time gate health checks, CPython-compatible division-error assertions, and bundled browser WASM/voice asset URLs.

Native Linux cgroup execution was not repeated on this Windows host. Paid model explanations and general AI performance superiority were not evaluated. Most bundled benchmark workloads are synthetic. Raw timeline rendering remains an existing open MCCP item.

The Windows EXE is an unsigned Preview distribution. Its asset hashes are recorded in `releases/windows-x64.json`.

Archive identities are in `packages/eai/web/public/download/manifest.json`. Rebuild source downloads with `python scripts/build_downloads.py`; then build the website from `packages/eai/web`.
