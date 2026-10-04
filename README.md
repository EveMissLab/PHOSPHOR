# PHOSPHOR

時空間版本不是作弊引擎。

Spacetime edition is not a cheat engine.

Software spacetime control, execution interfaces, and trace comprehension.

**Preview / experimental.** Three independently installable packages share one public source tree and the [PHOSPHOR website](https://emlphosphor.com/).

| Package | Version | Use |
| --- | --- | --- |
| [Spacetime](packages/spacetime/) | 0.1.0a9 + delivery fixes | Observe, authorize, actuate, and verify software domains; control a native logical-time runtime |
| [EAI](packages/eai/) | 0.8.0-beta | Step VM/WASM execution, inspect CTS, consume JSONL, and run the browser playground |
| [MCCP](packages/mccp/) | 0.0.1 | Trace local Python programs, inspect their computational graphs, and view evidence |

## Windows EXE

[Download PHOSPHOR-Spacetime.exe](https://github.com/EveMissLab/PHOSPHOR/releases/download/preview-2026.10.04/PHOSPHOR-Spacetime.exe). No Python installation required. Double-click for the console menu, or pass the documented `pss` commands to the EXE. The first binary distribution is the Spacetime edition; EAI and MCCP remain independently installable source packages. See [Windows packaging](packages/spacetime/packaging/README.md).

## Start with Spacetime

Python 3.12 or newer:

```sh
cd packages/spacetime
python -m venv .venv
# Windows PowerShell:
.venv/Scripts/python.exe -m pip install -e ".[dev]"
.venv/Scripts/pss.exe temporal-demo --rate 2.5 --quanta 20
.venv/Scripts/pss.exe matrix C_EVENT_SPARSE
.venv/Scripts/pss.exe gate --git-commit UNKNOWN
.venv/Scripts/python.exe -m pytest -q
```

On Linux/macOS, use `.venv/bin/python` and `.venv/bin/pss` instead.
The demo verifies a realized rate of 2.5, advances 20 quanta to logical tick 50, and compares tick execution with event-jump execution. Both must produce the same state hash. No API key is required.

Windows Job Objects expose CPU and memory budgets; Linux cgroup v2 exposes available resource controls. Exact logical-time control belongs to the synthetic runtime. OS CPU throttling does not change an arbitrary program's logical clock. Native providers accept only targets owned by the caller or explicitly allowlisted; authority is checked separately from capability.

## EAI and the website

Node.js 22 or newer:

```sh
cd packages/eai
npm ci
npm run typecheck
npm run verify:wasm
npm run phosphor -- run --program fibonacci --max 40
cd web
npm ci
npm run build
npm run dev
```

The website source stays beside the EAI engine so the playground uses the same implementation. The full verification list is in [EAI's guide](packages/eai/FOR-AGENTS.md).

## MCCP

```sh
cd packages/mccp
python -m venv .venv
.venv/Scripts/python.exe -m pip install -e ".[dev]"
.venv/Scripts/phosphor.exe run demo_targets/hello_trace.py --trace-id demo1
.venv/Scripts/python.exe -m uvicorn phosphor_api.app:app --host 127.0.0.1 --port 8000
```

Linux/macOS users use the corresponding `.venv/bin/` commands. Tracing and graph inspection work without an API key. AI explanations require a user-supplied `ANTHROPIC_API_KEY`; they send selected trace evidence to the configured model. The optional raw-timeline view uses Perfetto's external viewer. Keep local trace files out of public commits.

## What this Preview establishes

The three engines retain their own contracts and environments; their event formats are not silently treated as interchangeable. Spacetime's hard gates check correctness and control boundaries. They do not establish AI performance superiority, and most bundled benchmark workloads are synthetic. Broader OS control and a hosted actuation service are future work.

本公開預覽版提供三個獨立套件。Spacetime 是軟體時空控制入口；EAI 提供逐步執行與瀏覽器互動場；MCCP 提供真實 Python 執行追蹤。Spacetime 的邏輯時間控制作用於它自己的 runtime；CPU 配額與任意程式的邏輯時鐘是不同能力。安裝、示範及 gate 不需要 AI 金鑰。

Apache-2.0. Copyright 2026 EveMissLab / EVEMISS TECHNOLOGY CO., LTD. Author Neo.K (許筌崴). Existing content-learning terms remain in the EAI website's rights documents.
