"""phosphor_explain.explain -- turn one ``ComputationalGraph`` node into a
human-readable ``Explanation``, grounded strictly in the real trace evidence
connected to that node (see ``phosphor_trace.schema`` for the canonical
``TraceEvent`` / ``Node`` / ``Edge`` / ``Explanation`` / ``ExplanationClaim``
/ ``EvidenceLevel`` model, imported here, never redefined).

This module exists to enforce **Hallucination Control** (PHOSPHOR whitepaper
Sec.24, see ``phosphor_trace/schema.py``'s module docstring): an LLM-written
claim about a node must never assert behavior beyond what its cited events
actually show. Three layers do this:

1. ``gather_evidence`` -- a hard scope boundary. It returns *only* the edges
   directly touching the target node and the real ``TraceEvent`` objects
   those edges' ``EdgeDynamics.event_refs`` point at. The LLM is never
   handed graph-wide context it could blend into an overclaim.
2. The prompt template -- states the rules explicitly (every claim must be
   tagged with an evidence level; "observed" is reserved for something
   literally present in the supplied evidence; no evidence means say so,
   don't invent one) and hands the model the real, un-summarized evidence
   values (concrete counts, latencies, timestamps, source locations) so it
   has no reason to guess.
3. Post-validation (``_post_validate``) -- code, not a prompt, is the last
   line of defense. Every claim the model marks ``OBSERVED`` is checked
   against the evidence actually gathered in step 1; a claim that cites an
   evidence_ref not present in that evidence is downgraded to
   ``HYPOTHESIZED`` and logged rather than silently returned as-is (see
   that function's docstring for why downgrade-and-log was chosen over
   raising).

Anthropic SDK call pattern
---------------------------
Uses ``client.messages.create`` (plain, non-beta -- available on the
``anthropic>=0.40`` pin in this repo's ``pyproject.toml``; confirmed against
the installed ``anthropic==0.116.0`` in this repo's venv) with a single
tool, ``record_explanation``, and ``tool_choice`` forced to that tool. A
forced tool call is used instead of asking for JSON in the system prompt
because it is validated server-side against ``input_schema`` before it ever
reaches this code -- the most reliable way to get parseable JSON out of the
Messages API. ``response.content`` is scanned for the ``tool_use`` block,
and its already-parsed ``.input`` dict is handed straight to
``Explanation.model_validate()``.
"""

from __future__ import annotations

import json
import logging
import os
import statistics
from dataclasses import dataclass
from typing import Any, Callable

from phosphor_trace.schema import (
    ComputationalGraph,
    Edge,
    EvidenceLevel,
    Explanation,
    ExplanationClaim,
    Node,
    TraceEvent,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Model configuration
# ---------------------------------------------------------------------------

# claude-sonnet-4-5 is the deliberate default here, not claude-opus-4-8: this
# module sends a plain `temperature` sampling parameter (see `explain()`),
# which the 4.6+ model family (Opus 4.6/4.7/4.8, Sonnet 4.6) rejects with a
# 400 (sampling params removed -- see the claude-api skill's model-migration
# guide). claude-sonnet-4-5 is a pre-4.6 model that still accepts it, so the
# default model and the temperature parameter are consistent with each
# other. Override via PHOSPHOR_EXPLAIN_MODEL if a different model (and, if
# needed, a different sampling approach) is wanted.
_DEFAULT_MODEL = "claude-sonnet-4-5"
_MODEL_ENV_VAR = "PHOSPHOR_EXPLAIN_MODEL"
_TEMPERATURE = 0.2
_MAX_TOKENS = 2048

_TOOL_NAME = "record_explanation"

# ---------------------------------------------------------------------------
# Adaptive evidence gates (significance -> budget -> degrade -> hard ceiling)
# ---------------------------------------------------------------------------
#
# Replaces an earlier flat per-edge cap (a same-day first-pass fix: a real
# explain() call against demo_targets/cpu_loop.py's `fibonacci` node -- its
# real self-recursion edge has count=5166 -- built a >1.1M token prompt
# against Anthropic's 200K limit by embedding every one of those events'
# full JSON). A flat per-edge slice always takes whichever events happen to
# be first in list order, so a genuinely significant event further into a
# busy edge (a real error, a real latency outlier) could silently lose to
# routine ones ahead of it. This five-gate design replaces that with real
# significance ranking plus a hard ceiling -- informed by Neo's ACR/APR
# theory and the real, working adaptive-gating precedent in
# mssp-game-computer-runtime-mvp's ExperimentalInferenceBroker (see memory:
# project-acr-apr-theory for the full synthesis), not copied from either
# source since neither actually names a "gate" pattern for this exact
# problem -- this reuses the same mean+stdev statistical instinct already
# established in phosphor_projector.project's traffic-hotspot detection.
#
#   1. Scope gate        -- gather_evidence's existing hard boundary (only
#                            the target node's directly connected edges/
#                            events). Unchanged.
#   2. Significance gate -- _score_event: real signals already present in
#                            the data, no new tracing needed -- type=="error",
#                            duration_ms as a statistical outlier against its
#                            OWN edge's mean/stdev, first/most-recent
#                            occurrence.
#   3. Budget gate        -- _EVENT_BUDGET_TOTAL individually-embedded events
#                            allocated across ALL connected edges together
#                            (never per-edge in isolation -- one edge's
#                            genuinely interesting event must not lose to
#                            another edge's routine ones). Every edge is
#                            first guaranteed up to _MIN_EVENTS_PER_EDGE_FLOOR
#                            slots regardless of score, round-robin across
#                            edges rather than edge-exhaustive -- so a node
#                            padded with many decoy edges can't push one
#                            specific edge's floor out entirely. This is
#                            APR Paper01 Sec.12.4's own warning applied
#                            directly: a significance heuristic is itself an
#                            attack surface if a crafted trace can make
#                            something bad score as "boring" and vanish from
#                            evidence entirely. Remaining budget fills by
#                            global significance rank.
#   4. Degrade gate        -- _edge_digest: every event that does not win a
#                            full-detail slot is still accounted for in a
#                            real, computed plain-language summary (count,
#                            real duration range/mean, real error count) --
#                            never a bare "N more", never silently dropped.
#   5. Ceiling gate         -- an unconditional slice to _EVENT_BUDGET_TOTAL,
#                            applied AFTER gates 2-4 compute their full
#                            priority-ordered candidate list. This is what
#                            actually answers "packet attack"/data-shock
#                            resilience: no bug or adversarial input in
#                            gates 2-4 (e.g. an unusually large number of
#                            connected edges) can push the embedded-event
#                            count past this line. When the ceiling does cut
#                            into an edge's guaranteed floor, that edge's
#                            edge_sample_info/edge_digests still honestly
#                            report zero events shown -- bounded prompt size
#                            wins over per-edge fairness when they conflict,
#                            and this is disclosed, never silently absorbed.

_EVENT_BUDGET_TOTAL = 60
_MIN_EVENTS_PER_EDGE_FLOOR = 2
_ERROR_SIGNIFICANCE_SCORE = 100.0
_OUTLIER_Z_WEIGHT = 2.0
_OUTLIER_Z_CAP = 10.0
_EXTREMUM_BONUS = 5.0


@dataclass
class _ScoredCandidate:
    event: TraceEvent
    edge_id: str
    score: float
    is_extremum: bool  # first or most-recent occurrence on its edge


def _edge_duration_stats(edge_events: list[TraceEvent]) -> tuple[float, float]:
    """Real ``(mean, stdev)`` of ``duration_ms`` among ``edge_events`` -- the
    population is scoped to ONE edge's own real contributing events. Same
    mean+stdev shape as
    ``phosphor_projector.project._traffic_count_threshold``, applied to a
    different population (per-event latency, not edge-level call count), so
    reimplemented locally here rather than imported.
    """
    durations = [ev.duration_ms for ev in edge_events if ev.duration_ms is not None]
    if not durations:
        return 0.0, 0.0
    mean = statistics.fmean(durations)
    stdev = statistics.pstdev(durations) if len(durations) >= 2 else 0.0
    return mean, stdev


def _score_event(event: TraceEvent, mean: float, stdev: float, *, is_first: bool, is_last: bool) -> float:
    """Gate 2 -- higher score means more worth showing the model in full
    detail. Every signal here is real and already present on the event;
    nothing is guessed.
    """
    score = 0.0
    if event.type == "error":
        score += _ERROR_SIGNIFICANCE_SCORE
    if event.duration_ms is not None and stdev > 0:
        z = abs(event.duration_ms - mean) / stdev
        score += min(z, _OUTLIER_Z_CAP) * _OUTLIER_Z_WEIGHT
    if is_first or is_last:
        score += _EXTREMUM_BONUS
    return score


def _edge_digest(edge_events: list[TraceEvent], selected_ids: set[str]) -> str | None:
    """Gate 4 -- a real, computed plain-language summary of whatever on this
    edge did NOT win a full-detail slot. Returns ``None`` only if every one
    of the edge's real events won a slot (nothing left to summarize).
    """
    unshown = [ev for ev in edge_events if ev.event_id not in selected_ids]
    if not unshown:
        return None
    durations = [ev.duration_ms for ev in unshown if ev.duration_ms is not None]
    error_count = sum(1 for ev in unshown if ev.type == "error")
    parts = [f"{len(unshown)} more real contributing event(s) not individually shown"]
    if durations:
        parts.append(
            f"duration range {min(durations):.3f}-{max(durations):.3f}ms, "
            f"mean {statistics.fmean(durations):.3f}ms"
        )
    if error_count:
        parts.append(
            f'{error_count} of them type="error" (unexpected -- gate 2 always scores '
            f"errors to win a slot first; reported defensively in case the ceiling "
            f"gate cut in before reaching them)"
        )
    return "; ".join(parts)


# ---------------------------------------------------------------------------
# gather_evidence
# ---------------------------------------------------------------------------


def gather_evidence(
    graph: ComputationalGraph,
    events: list[TraceEvent],
    target_node_id: str,
) -> dict[str, Any]:
    """Collect *only* the evidence directly connected to ``target_node_id``,
    then adaptively select which of it is embedded in full detail (see the
    five-gate design in the module comment above ``_EVENT_BUDGET_TOTAL``).

    Scope boundary (gate 1, the whole point of this function): the returned
    dict contains the target node itself, every ``Edge`` in ``graph`` whose
    ``source`` or ``target`` equals ``target_node_id``, and the real
    ``TraceEvent`` objects referenced by those edges' ``EdgeDynamics.event_refs``
    (looked up in ``events`` -- a ref pointing at an event not present in
    ``events`` is silently skipped rather than fabricated). Nothing about
    any other node, edge, or event is included, ever -- there is no
    "nearby context" here for an LLM to blend into an overclaim.

    Gates 2-5 (significance scoring, budget allocation with a per-edge
    anti-blind-spot floor, graceful degradation, hard ceiling) together
    decide which of the (potentially huge) real event set actually gets
    embedded as full JSON: at most ``_EVENT_BUDGET_TOTAL`` events, total,
    prioritized by real significance (errors, latency outliers, first/
    most-recent occurrence) with a guaranteed minimum sample per edge.
    Every edge's own ``EdgeDynamics`` (in ``evidence["edges"]``) is always
    the real, complete aggregate regardless of this sampling.
    ``evidence["edge_sample_info"]`` reports, per edge_id, the real total
    ``event_refs`` count vs. how many actually won a full-detail slot.
    ``evidence["edge_digests"]`` reports, per edge_id, a real computed
    summary of whatever did not win a slot (gate 4 -- never a silent drop).
    ``valid_event_ids`` (used by Hallucination Control's OBSERVED-citation
    check) contains ONLY the ids of events actually gathered -- a model has
    no honest basis to cite a specific event_id it was never shown any
    content for, even though that id does genuinely belong to this node's
    evidence.

    Raises ``ValueError`` if ``target_node_id`` does not name a node in
    ``graph``.
    """
    target_node: Node | None = next((n for n in graph.nodes if n.node_id == target_node_id), None)
    if target_node is None:
        raise ValueError(f"target_node_id {target_node_id!r} not found in graph {graph.trace_id!r}")

    connected_edges: list[Edge] = [
        e for e in graph.edges if e.source == target_node_id or e.target == target_node_id
    ]

    events_by_id = {ev.event_id: ev for ev in events}

    # Gate 2: score every real candidate event, scoped per its own edge.
    candidates: list[_ScoredCandidate] = []
    edge_events: dict[str, list[TraceEvent]] = {}
    edge_total_refs: dict[str, int] = {}

    for e in connected_edges:
        refs = e.dynamic.event_refs
        edge_total_refs[e.edge_id] = len(refs)
        real_events: list[TraceEvent] = []
        for ref in refs:
            ev = events_by_id.get(ref)
            if ev is None:
                logger.warning(
                    "gather_evidence(target_node_id=%r): edge event_ref %r not found in the "
                    "supplied events list -- skipped, not fabricated",
                    target_node_id,
                    ref,
                )
                continue
            real_events.append(ev)
        edge_events[e.edge_id] = real_events
        if not real_events:
            continue
        mean, stdev = _edge_duration_stats(real_events)
        by_time = sorted(range(len(real_events)), key=lambda i: real_events[i].timestamp)
        first_idx, last_idx = by_time[0], by_time[-1]
        for i, ev in enumerate(real_events):
            is_first = i == first_idx
            is_last = i == last_idx
            candidates.append(
                _ScoredCandidate(
                    event=ev,
                    edge_id=e.edge_id,
                    score=_score_event(ev, mean, stdev, is_first=is_first, is_last=is_last),
                    is_extremum=is_first or is_last,
                )
            )

    # Gate 3: build one deterministic, priority-ordered candidate list --
    # floor first (round-robin across edges, deduped per edge), then the
    # significance-ranked remainder (stable sort: ties preserve encounter
    # order, never an arbitrary id sort).
    ordered: list[_ScoredCandidate] = []
    seen_ids: set[str] = set()

    floor_pools: dict[str, list[_ScoredCandidate]] = {}
    for e in connected_edges:
        pool: list[_ScoredCandidate] = []
        pool_seen: set[str] = set()
        for c in candidates:
            if c.edge_id != e.edge_id or not c.is_extremum:
                continue
            if c.event.event_id in pool_seen:
                continue
            pool_seen.add(c.event.event_id)
            pool.append(c)
            if len(pool) >= _MIN_EVENTS_PER_EDGE_FLOOR:
                break
        floor_pools[e.edge_id] = pool

    max_floor_len = max((len(p) for p in floor_pools.values()), default=0)
    for round_idx in range(max_floor_len):
        for e in connected_edges:
            pool = floor_pools[e.edge_id]
            if round_idx >= len(pool):
                continue
            c = pool[round_idx]
            if c.event.event_id in seen_ids:
                continue
            ordered.append(c)
            seen_ids.add(c.event.event_id)

    remainder = [c for c in candidates if c.event.event_id not in seen_ids]
    remainder.sort(key=lambda c: -c.score)
    for c in remainder:
        if c.event.event_id in seen_ids:
            continue
        ordered.append(c)
        seen_ids.add(c.event.event_id)

    # Gate 5: hard ceiling -- an unconditional slice, independent of how
    # gates 2-4 above computed `ordered`.
    selected = ordered[:_EVENT_BUDGET_TOTAL]
    gathered_events = sorted((c.event for c in selected), key=lambda ev: ev.timestamp)
    selected_ids = {ev.event_id for ev in gathered_events}

    # Gate 4 (disclosure half): per-edge sample counts + real digest of
    # whatever didn't win a slot -- computed after the ceiling, so an edge
    # the ceiling cut out entirely is still honestly reported as such.
    edge_sample_info: dict[str, dict[str, int]] = {}
    edge_digests: dict[str, str] = {}
    for e in connected_edges:
        real_events = edge_events[e.edge_id]
        shown_count = sum(1 for ev in real_events if ev.event_id in selected_ids)
        edge_sample_info[e.edge_id] = {
            "total_event_refs": edge_total_refs[e.edge_id],
            "sampled_event_refs": shown_count,
        }
        digest = _edge_digest(real_events, selected_ids)
        if digest:
            edge_digests[e.edge_id] = digest

    return {
        "target_node": target_node.model_dump(mode="json"),
        "edges": [e.model_dump(mode="json") for e in connected_edges],
        "events": [ev.model_dump(mode="json") for ev in gathered_events],
        "valid_event_ids": [ev.event_id for ev in gathered_events],
        "edge_sample_info": edge_sample_info,
        "edge_digests": edge_digests,
    }


# ---------------------------------------------------------------------------
# Prompt template
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """\
You are PHOSPHOR's trace-explanation agent. You explain what a single node \
in a program's real, captured execution graph actually did, using ONLY the \
concrete evidence supplied in the user message -- real counts, real \
latencies, real event timestamps and source locations pulled directly from \
an executed trace. You never see, and must never assume, anything about \
the rest of the graph beyond what is given to you.

Hallucination Control is the hard constraint of this task (PHOSPHOR \
whitepaper Sec.24): never assert behavior beyond what the supplied \
evidence actually shows. Rules, without exception:

(a) Every claim you produce MUST be tagged with exactly one evidence_level: \
"observed", "inferred", "hypothesized", or "verified".

(b) "observed" may ONLY be used for something directly present in the \
supplied evidence for THIS node -- a specific count, a specific latency \
figure, a specific call target that literally appears in the JSON you are \
given. Never use "observed" as a generalization beyond what was measured \
on this one run (e.g. do not claim "this function is always fast" from one \
latency figure -- that generalization was not observed, only the one \
figure was).

(c) If you have no evidence for a claim, say so plainly instead of \
inventing one: omit the optional claim field entirely (function_role / \
runtime_effect / risk), or write a claim whose text states the evidence is \
insufficient, tagged "hypothesized" with an empty evidence_refs list. \
Never fabricate a count, a latency, a call target, or a causal relationship \
that is not in the evidence you were given.

(d) Respond ONLY by calling the `record_explanation` tool. Its arguments \
must match this exact shape (these are the literal field names of the \
Explanation / ExplanationClaim pydantic model):
  - target_node_id: string
  - local: {"text": string, "evidence_level": one of the four values above, \
"evidence_refs": array of event_id strings}
  - function_role, runtime_effect, risk: each OPTIONAL, same shape as \
`local` -- omit any of them entirely if you have nothing evidenced to say

Every string inside evidence_refs must be an event_id that literally \
appears in the "events" evidence you are given below. Do not invent event \
ids, and do not cite an event_id from outside the evidence you were given.\
"""


def _evidence_disclosure_note(edge_sample_info: dict[str, dict[str, int]], edge_digests: dict[str, str]) -> str:
    """Plain-language disclosure of gates 3-4 (adaptive sampling + its
    digest of whatever wasn't shown) -- empty string only if every edge's
    real events were shown in full, never silently omitted otherwise.
    """
    truncated_edge_ids = [
        edge_id
        for edge_id, info in edge_sample_info.items()
        if info["sampled_event_refs"] < info["total_event_refs"]
    ]
    if not truncated_edge_ids:
        return ""
    lines = []
    for edge_id in truncated_edge_ids:
        info = edge_sample_info[edge_id]
        line = (
            f"  - edge {edge_id}: showing {info['sampled_event_refs']} of "
            f"{info['total_event_refs']} real contributing events (prioritized by real "
            f"significance -- errors, latency outliers, first/most-recent occurrence -- "
            f"plus a guaranteed minimum so no edge goes entirely unrepresented)"
        )
        digest = edge_digests.get(edge_id)
        if digest:
            line += f"\n    Of the rest: {digest}."
        lines.append(line)
    lines_str = "\n".join(lines)
    return f"""

NOTE on the evidence below: some edges contribute more events than are individually listed here (to keep this message a reasonable size). The events shown were NOT simply the first N -- they were prioritized by real significance (errors, unusually long/short latency, first/most-recent occurrence), with a guaranteed minimum sample from every edge so none is entirely unrepresented:
{lines_str}
This does NOT make an edge's aggregate data (count/total_duration_ms/avg_latency_ms in "Connected edges" above) any less real or exact -- those are always the complete, true aggregate, computed from ALL contributing events, not just the ones shown. You may make an "observed" claim about an edge's count/duration/frequency citing that edge's own aggregate data with an empty evidence_refs list -- you do not need an individual event_id for an aggregate-level claim. Only cite a specific event_id (in evidence_refs) for a claim tied to that one specific event's own detail, and only from the valid_event_ids list below."""


def _build_prompt(evidence: dict[str, Any]) -> str:
    """Build the user-turn prompt: target node identity + the real, gathered
    evidence (edges' real EdgeDynamics, events' real fields) -- concrete
    values, not paraphrased or summarized away from what they actually are.
    """
    target = evidence["target_node"]
    edges_json = json.dumps(evidence["edges"], indent=2, sort_keys=True)
    events_json = json.dumps(evidence["events"], indent=2, sort_keys=True)
    valid_ids = evidence["valid_event_ids"]
    disclosure_note = _evidence_disclosure_note(
        evidence.get("edge_sample_info", {}), evidence.get("edge_digests", {})
    )

    return f"""\
Explain the following node from a real, captured program-execution trace.

Target node:
  node_id: {target["node_id"]}
  node_type: {target["node_type"]}
  label: {target["label"]}
  attributes: {json.dumps(target["attributes"], sort_keys=True)}

Connected edges (real EdgeDynamics -- count/total_duration_ms/avg_latency_ms \
are measured from this trace, not estimated):
```json
{edges_json}
```

Trace events referenced by those edges (real TraceEvent records -- \
timestamp, source file/line, resource attributes, and evidence level are \
exactly as captured):
```json
{events_json}
```
{disclosure_note}

The complete set of event_ids you are permitted to cite in any \
evidence_refs list is:
{json.dumps(valid_ids)}

Using ONLY the evidence above, call `record_explanation` with your \
explanation of this node, following every rule in the system prompt.\
"""


# ---------------------------------------------------------------------------
# Tool schema (forced tool-use -> reliable structured JSON)
# ---------------------------------------------------------------------------

_EVIDENCE_LEVEL_VALUES = [level.value for level in EvidenceLevel]

_CLAIM_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "text": {"type": "string", "description": "The claim, in plain language."},
        "evidence_level": {
            "type": "string",
            "enum": _EVIDENCE_LEVEL_VALUES,
            "description": (
                "'observed' ONLY for something literally present in the supplied evidence. "
                "'inferred'/'hypothesized'/'verified' otherwise."
            ),
        },
        "evidence_refs": {
            "type": "array",
            "items": {"type": "string"},
            "description": "event_id strings from the supplied evidence that back this claim.",
        },
    },
    "required": ["text", "evidence_level"],
}

_EXPLANATION_TOOL: dict[str, Any] = {
    "name": _TOOL_NAME,
    "description": (
        "Record a structured, evidence-grounded explanation of one execution-graph node. "
        "Every claim must be tagged with an evidence_level and must not overclaim beyond "
        "the evidence supplied in the prompt."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "target_node_id": {"type": "string"},
            "local": _CLAIM_SCHEMA,
            "function_role": _CLAIM_SCHEMA,
            "runtime_effect": _CLAIM_SCHEMA,
            "risk": _CLAIM_SCHEMA,
        },
        "required": ["target_node_id", "local"],
    },
}


# ---------------------------------------------------------------------------
# Client resolution -- injectable per the task spec
# ---------------------------------------------------------------------------


def _resolve_client(client: Any) -> Any:
    """Resolve the ``client`` argument to an object exposing ``.messages.create``.

    - ``None`` -> construct a real ``anthropic.Anthropic()`` (reads
      ``ANTHROPIC_API_KEY`` from the environment, per the SDK's own default
      resolution).
    - A callable that is not itself already a client (no ``.messages``
      attribute) -> called with no arguments to obtain the client. This
      lets tests pass a zero-arg factory instead of a live object.
    - Anything else -> used as-is (a pre-built real or fake/stub client).
    """
    if client is None:
        import anthropic  # local import: don't require the package at module import time

        return anthropic.Anthropic()
    if callable(client) and not hasattr(client, "messages"):
        return client()
    return client


# ---------------------------------------------------------------------------
# Post-validation -- Hallucination Control enforced in code
# ---------------------------------------------------------------------------

_CLAIM_FIELD_NAMES = ("local", "function_role", "runtime_effect", "risk")


def _post_validate(explanation: Explanation, evidence: dict[str, Any]) -> Explanation:
    """Downgrade (never silently pass through) any claim that says "observed"
    but cites an evidence_ref not actually present in the gathered evidence.

    Design choice -- downgrade-and-log, not raise: this function is the code
    backstop for exactly the failure mode Hallucination Control exists to
    catch (the model claiming "observed" for something it wasn't actually
    given evidence for). Raising would discard the entire Explanation --
    including any other claims on the same node that ARE properly grounded
    -- over a single bad claim, and would turn a partially-useful result
    into a hard failure the caller must handle every time the model
    over-claims on any *one* of up to four claim fields. Downgrading the
    offending claim to HYPOTHESIZED preserves the rest of the explanation,
    is exactly as visible (logged as a warning, and reflected in the
    returned data itself via the changed evidence_level -- a caller
    inspecting evidence_level sees the truth), and still guarantees the
    hard invariant: no OBSERVED claim is ever returned with an
    unverifiable evidence_ref.
    """
    valid_ids = set(evidence["valid_event_ids"])
    updates: dict[str, ExplanationClaim] = {}

    for field_name in _CLAIM_FIELD_NAMES:
        claim: ExplanationClaim | None = getattr(explanation, field_name)
        if claim is None:
            continue
        if claim.evidence_level != EvidenceLevel.OBSERVED:
            continue
        bad_refs = [ref for ref in claim.evidence_refs if ref not in valid_ids]
        if bad_refs:
            logger.warning(
                "Hallucination Control: node %r claim %r was tagged OBSERVED but cites "
                "evidence_refs %r not present in the gathered evidence (valid ids: %r) -- "
                "downgrading to HYPOTHESIZED",
                explanation.target_node_id,
                field_name,
                bad_refs,
                sorted(valid_ids),
            )
            updates[field_name] = claim.model_copy(update={"evidence_level": EvidenceLevel.HYPOTHESIZED})

    if updates:
        explanation = explanation.model_copy(update=updates)
    return explanation


# ---------------------------------------------------------------------------
# explain()
# ---------------------------------------------------------------------------


def explain(
    graph: ComputationalGraph,
    events: list[TraceEvent],
    target_node_id: str,
    client: Any | Callable[[], Any] | None = None,
) -> Explanation:
    """Explain ``target_node_id`` using only its directly-connected trace evidence.

    ``client`` is injectable (see ``_resolve_client``): pass ``None`` for a
    real ``anthropic.Anthropic()`` client (reads ``ANTHROPIC_API_KEY`` from
    the environment), a pre-built client (real or fake/stub, anything
    exposing ``.messages.create(...)``), or a zero-arg callable that
    returns one -- this keeps the function testable with no live network
    or API access.
    """
    evidence = gather_evidence(graph, events, target_node_id)
    prompt = _build_prompt(evidence)
    model = os.environ.get(_MODEL_ENV_VAR, _DEFAULT_MODEL)

    resolved_client = _resolve_client(client)

    response = resolved_client.messages.create(
        model=model,
        max_tokens=_MAX_TOKENS,
        temperature=_TEMPERATURE,
        system=_SYSTEM_PROMPT,
        tools=[_EXPLANATION_TOOL],
        tool_choice={"type": "tool", "name": _TOOL_NAME},
        messages=[{"role": "user", "content": prompt}],
    )

    tool_use_blocks = [b for b in response.content if getattr(b, "type", None) == "tool_use"]
    if not tool_use_blocks:
        raise ValueError(
            f"Anthropic response for node {target_node_id!r} contained no tool_use block "
            f"(stop_reason={getattr(response, 'stop_reason', None)!r}); cannot parse Explanation"
        )

    raw_input = tool_use_blocks[0].input
    explanation = Explanation.model_validate(raw_input)
    explanation = _post_validate(explanation, evidence)
    return explanation
