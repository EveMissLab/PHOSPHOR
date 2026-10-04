# PHOSPHOR Spacetime Checkpoint — M0 through M10

- Version: `0.1.0a9`
- Date: 2026-08-23
- Repository: `EveMissLab/PHOSPHOR — packages/spacetime`
- M9 closure head: `25055f00145dc484bb1ef67d0d969c01a6b94c57`
- M10 feature merge: `8565113bbe2bed5f69a1c7a018326efcd5cedf35`

## Implemented through M10

M0–M9 remain intact: contracts, IR/registry, observation, authority-bound control, Windows/Linux providers, native logical-time synthetic runtime, deterministic Rule Governor, schema-bounded AI policy, and B0–B3 benchmark harness.

M10 adds:

- executable hard Gate 0–6 via `GateRunner`;
- machine-readable `ssm-gate-report-v0.1`;
- `pss gate`;
- per-gate evidence and explicit failures;
- gate failure isolation (later gates still execute);
- failure injection for observer, provider, authority/fencing, idempotency, receipt verification, and AI fallback;
- explicit separation of hard correctness/safety gates from performance hypotheses.

## M10 local evidence before closure

- M10 targeted tests: `15 passed`.
- Full local regression: `132 passed, 2 skipped`.
- `pss gate`: `7/7 PASS`.
- Gate report marks `performance_hypotheses_evaluated=false`.

## CI evidence

Workflow run `32650633316`:

- Ubuntu job `97221544817`: `133 passed, 1 skipped`; Linux cgroup v2 native path executed.
- Windows job `97221544903`: `133 passed, 1 skipped`; Windows Job Object native path executed.

## Empirical boundary

M10 proves the hard validation machinery can execute and fail closed; it does not prove adaptive or AI performance superiority. `B2 > B1` and `B3 > B2` remain falsifiable hypotheses.

## Next

First Formal Benchmark Book / repeated formal experiment campaign. No new pre-MVP theory is required before empirical evidence.
