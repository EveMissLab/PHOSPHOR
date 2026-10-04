# PHOSPHOR Spacetime

時空間版本不是作弊引擎。

Spacetime edition is not a cheat engine.

**AI-native Software Spacetime Manager reference runtime.**

PHOSPHOR Spacetime is a local-first, userspace-first reference runtime for observing, governing, actuating, verifying, and benchmarking software-spacetime domains.

## Install and run

Python >= 3.12. From this folder:

```sh
python -m venv .venv
# Windows PowerShell; Linux/macOS use .venv/bin/python and .venv/bin/pss
.venv/Scripts/python.exe -m pip install -e ".[dev]"
.venv/Scripts/pss.exe temporal-demo --rate 2.5 --quanta 20
.venv/Scripts/pss.exe matrix C_EVENT_SPARSE
.venv/Scripts/pss.exe gate --git-commit UNKNOWN
```

`temporal-demo` applies a real authority-checked rate command to its owned synthetic runtime, reads back the result, and compares tick/event-jump state hashes. No model key is required. JSON schemas are included in wheel installs. The Preview delivery fixes retain the M10 version and do not declare a new milestone.

## Status

`v0.1.0a9` — pre-alpha reference runtime.

Completed checkpoints: **M0–M10**.

```text
Observe → Project → Govern → Authorize → Actuate → Verify → Benchmark → Gate
```

Core executable surfaces:

```bash
pss run C_EVENT_SPARSE --baseline B0_NATIVE
pss matrix C_EVENT_SPARSE
pss compare runs/<run-a> runs/<run-b>
pss gate --git-commit <commit>
```

## M10 hard gates

`pss gate` executes Gate 0–6 and writes machine-readable evidence:

- G0 Contract / Schema Integrity
- G1 Observation / IR Safety
- G2 Safe Actuation / Authority
- G3 Temporal Semantics
- G4 Causal Governance
- G5 Hierarchical / AI Fallback
- G6 End-to-End Benchmark Contract

A failed gate is recorded without aborting later gates. `performance_hypotheses_evaluated=false`: B2>B1 and B3>B2 remain empirical questions, not hard pass criteria.

## Core invariants

- `Time != Compute`
- `CPUServiceRate != LogicalTimeRate`
- `Observation != Authority`
- `Capability != Authority`
- `PolicyProposal != CommandIntent != Actuation`
- `Desired != Requested != Realized != Observed`
- `AI Failure != Host Failure`
- Unsupported or ambiguous mutation fails closed.

## Validation

M10 PR workflow `32650633316`:

- Ubuntu job `97221544817`: **133 passed / 1 Windows-only skip**, native Linux cgroup v2 executed.
- Windows job `97221544903`: **133 passed / 1 Linux-only skip**, native Windows Job Object executed.

See `CHECKPOINT.md` and `docs/architecture/README.md` for the engineering history and current boundary.

## License

Apache-2.0.
