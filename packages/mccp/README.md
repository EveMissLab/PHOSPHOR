# PHOSPHOR MCCP — Multiscale Computational Comprehension Platform

> See how a program's execution actually happens — grounded in trace evidence, not guesses.

PHOSPHOR MCCP traces a real running program (Python first), builds a computational
graph of what actually happened (functions, files, network calls, processes —
never per-call-instance nodes), and lets you click any part of it for an AI
explanation that cites the exact trace events behind every claim. Every claim
is tagged `observed` / `inferred` / `hypothesized` / `verified` — the platform
never asserts behavior it didn't actually see.

## Relationship to the other PHOSPHOR

This is a different system from [`eml-phosphor`](https://github.com/EveMissLab/PHOSPHOR/tree/main/packages/eai),
which includes EML-VM-16/64/BASIC and a real WebAssembly target. That
project's thesis — `Φ : M × CTS → V`, a VM's execution paired with a complete
correspondence table is simultaneously human-visualization and AI-parseable —
is the conceptual ancestor of this one, generalized from a toy VM to real
running programs on real operating systems. They share a name and a thesis
lineage, not a codebase.

## Architecture

```
phosphor_collector/   viztracer + OpenTelemetry wrapper + background memory
                       sampler (psutil), trace-budget cap
phosphor_trace/       normalizes both sources into one TraceEvent schema
phosphor_graph/       builds the computational graph — node/edge aggregation
phosphor_projector/   macro/meso/micro × beginner/intermediate/expert views,
                       plus Complexity Lens (cost-per-node/edge) and Bug Lens
                       (error findings + traffic-explosion hotspots)
phosphor_explain/     evidence-tagged AI explanations (Hallucination Control)
phosphor_api/         POST /api/traces, GET /api/graphs/{id}, POST /api/explain,
                       GET /api/projection?scale=, GET /api/complexity,
                       GET /api/bugs
phosphor_ui/          embedded Perfetto timeline + custom graph view
```

`phosphor_trace/schema.py` is the canonical data model every other module
imports — `TraceEvent` → `Node`/`Edge` → `Explanation`. Nothing downstream
invents its own event shape.

## Quickstart

```bash
python -m venv .venv
# Windows: .venv/Scripts/python.exe; Linux/macOS: .venv/bin/python
pip install -e ".[dev]"
pytest tests/ -v                                        # 106 tests, all real (no mocked pipeline)

phosphor run demo_targets/cpu_loop.py --trace-id demo1   # traces, builds the graph, writes traces/demo1/
uvicorn phosphor_api.app:app --port 8000                 # then open http://127.0.0.1:8000/
```

`ANTHROPIC_API_KEY` must be set for `POST /api/explain` to actually call the
model (it returns a clean 500 with a clear message if unset — nothing crashes,
but there's no explanation output without a real key).

## Status

**Phase 0 (MVP v0.1)** built and verified end-to-end against two real demo
scripts (a CPU/recursion-heavy one, an I/O/HTTP N+1-style one). The full
pipeline — trace, build a bounded computational graph with real "calls"/
"invokes" edges, macro/meso projection, evidence-grounded explanation — runs
and is tested. Graph explosion is proven prevented on real data: thousands of
raw call events fold into a small, static set of nodes and edges (e.g. a
500-call loop → one node, one edge with `count=500`).

**Phase 2** adds real SQLite database query tracing (`type="db_query"`
events + `database` graph nodes, same aggregation discipline as function/host
edges — an N+1 query loop folds into one edge with the real iteration count),
real error capture (`type="error"` events for both an uncaught exception that
kills the whole script and a query that fails partway through — each with
genuine exception type/message detail, never a generic "something failed"),
a **Complexity Lens** (per-node/edge cost breakdown, explicit top-K with the
omitted total always disclosed, never silently dropped), and a **Bug Lens**
(surfaces real error events linked to their calling function, plus
traffic-explosion hotspots via a per-relation statistical threshold — global
thresholds got swamped by Python's own import-machinery call counts, so this
is computed separately per edge relation). All of it runs against the same
two Phase 0 demo scripts with zero regressions, plus two new ones
(`db_bound.py`, `error_case.py`). 85/85 tests pass.

Along the way, fixing DB-edge attribution surfaced and fixed a real
pre-existing imprecision in Phase 0's own network edges: the nearest-caller
walk could resolve to OTel-SDK-internal bookkeeping frames (a span's own
internal `time.time_ns()` call, `Tracer.start_span`, etc.) instead of a real
calling frame, since those frames' intervals mechanically contain the
network/db event's timestamp. Fixed by skipping frames proven (not assumed)
to be pure instrumentation apparatus — `opentelemetry`-package frames,
builtins, this project's own OTel wrapper module — never skipping ordinary
application or third-party library frames. This is a real improvement, not a
complete fix: `invokes` edges still sometimes resolve to a `requests`-library
internal (e.g. `Session.request`) rather than the exact application function
that logically made the call — the walk finds the true nearest *non-noise*
frame on the real call stack, which isn't always the most semantically
interesting one.

Complexity Lens and Bug Lens are wired into both `phosphor_api`
(`GET /api/complexity`, `GET /api/bugs`) and `phosphor_ui` (a Complexity/Bugs
tab next to the graph view) — verified live in a real browser against real
traces, not mocked data.

**Memory profiling** adds a real background RSS/VMS sampler (`psutil`,
~20 samples/sec) running alongside the traced script, producing
`type="memory_sample"` events and real `peak_rss_mb`/`mean_rss_mb`
attributes on each process node (e.g. a real run of `io_bound.py`: process
node `{"pid": 9684, "peak_rss_mb": "95.67", "mean_rss_mb": "51.56"}`) —
plausible real CPython process memory, not a placeholder. The sampler
itself deliberately avoids `threading.Event`/`.wait()` inside its loop body
(a plain list-based stop flag + `time.sleep()` instead), because viztracer
traces *every* thread active during collection, and `Event`'s own
internal `RLock` machinery was empirically confirmed to pollute the
downstream graph with fixed sampler bookkeeping nodes/edges that have
nothing to do with the traced script — caught by this project's own
regression tests, not designed in from the start.

**Live `phosphor_explain` output verified against a real model** (2026-08-10,
a real `ANTHROPIC_API_KEY`, ~$0.06 total spend across two calls). This
surfaced and fixed a real, previously-undiscovered bug: `gather_evidence`
embedded the full JSON of *every* event referenced by a node's connected
edges, uncapped — asking for the `fibonacci` node from `cpu_loop.py` (whose
real self-recursion edge has `count=5166`) built a **1.14 million token
prompt** against Anthropic's 200K limit, a hard failure on the very first
real call. Both real calls (the `fibonacci` node, and the `database` node
aggregating 23 real queries from 4 calling functions across `db_bound.py`)
returned genuinely well-grounded output: correct real numbers, appropriate
`observed`/`inferred` tagging throughout, and in one case the model
correctly hedged a real N+1-shaped query pattern as "inferred... cannot be
confirmed from a single trace" rather than asserting a bug — exactly the
epistemic discipline Hallucination Control exists to produce, not just
request.

The first-pass fix was a flat cap (`_MAX_EVENTS_PER_EDGE = 15`, same list
order per edge). Same day, redesigned into a **five-gate adaptive evidence
pipeline** (`phosphor_explain/explain.py`) so a genuinely significant event
buried deep in a busy edge — a real error, a real latency outlier — can no
longer silently lose to routine events ahead of it in list order, and so
the design generalizes to resilience against much larger or adversarial
traces, not just this one known-large edge:
1. **Scope gate** — unchanged hard boundary (only the target node's
   directly connected edges/events).
2. **Significance gate** — scores every candidate event on real signals
   already in the data: `type="error"`, `duration_ms` as a statistical
   outlier against its own edge's real mean/stdev, first/most-recent
   occurrence.
3. **Budget gate** — `_EVENT_BUDGET_TOTAL = 60` individually-embedded
   events allocated by significance across *all* connected edges together,
   with every edge first guaranteed a `_MIN_EVENTS_PER_EDGE_FLOOR = 2`
   floor (round-robin across edges, so a node padded with many low-value
   edges can't push one specific edge's floor out entirely) — an
   anti-blind-spot measure so a crafted trace can't hide something bad by
   making it score as "boring."
4. **Degrade gate** — anything that doesn't win a full-detail slot is
   still summarized in a real, computed digest (count, real duration
   range/mean, real error count) attached to its edge, never a bare "N
   more" and never silently dropped.
5. **Ceiling gate** — an unconditional slice to `_EVENT_BUDGET_TOTAL`
   applied after gates 2–4 compute their full priority-ordered list, so no
   bug or adversarial input (e.g. an unusually large number of connected
   edges) can push the embedded-event count past it — this is what
   actually answers resilience against a much larger/adversarial future
   trace, not just the one 5166-call edge that surfaced the original bug.

Verified with both synthetic tests (errors and latency outliers buried
past where the old flat cap would have reached still win a slot; a
"boring" edge keeps its floor even next to an edge whose every event is a
real error; a 100-edge pathological graph stays bounded and every
zero-shown edge is honestly disclosed) and the same real `fibonacci`
self-recursion edge from `cpu_loop.py` that originally surfaced the
overflow bug, run through the real collect → normalize → build_graph
pipeline.
- Perfetto's embedded timeline view (`phosphor_ui/`) completes its
  PING/PONG handshake with `ui.perfetto.dev`, but the actual visual render
  was never confirmed with a screenshot in the environment this was built in.
- Async task tracing and dedicated Process/Thread graph nodes (the two
  remaining whitepaper Phase 2 items) are still deliberately deferred —
  thread nodes specifically need a real `EdgeRelation` schema decision
  (how to express "runs in process/thread") that hasn't been made yet, not
  just more implementation time.
- Not yet in scope at all: multi-file/multi-service tracing, non-Python
  targets, Intent Preservation Mode, auth/hosting, sandboxed execution of
  untrusted target scripts, micro-scale (source-line/AST/bytecode)
  projection (`project(..., scale="micro")` raises `NotImplementedError`
  on purpose rather than guessing).

## License

Apache-2.0. © EVEMISS TECHNOLOGY CO., LTD. (一言諾科技有限公司). Author: 許筌崴 (Neo.K).
