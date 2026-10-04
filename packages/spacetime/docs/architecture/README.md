# PHOSPHOR Spacetime Architecture Documents

The seven-document pre-MVP theory/engineering series is closed. The runtime now implements M0 through M10.

```text
Observation
  ↓
Software Spacetime IR
  ↓
GovernanceSummary
  ├─→ Rule Governor ─┐
  └─→ AI Adapter ────┤ PolicyProposal
                     ↓
             deterministic validation
                     ↓
                 CommandIntent
                     ↓
                Authority Gate
                     ↓
                 Provider ABI
                     ↓
                measured reality
                     ↓
             Benchmark Harness
                     ↓
               Gate Runner
```

## Runtime checkpoints

M0 Contracts through M10 Gate Runner + Failure Injection are complete.

M10 feature merge: `8565113bbe2bed5f69a1c7a018326efcd5cedf35`.
M10 validation workflow: `32650633316`; Ubuntu `97221544817` and Windows `97221544903`, both `133 passed / 1 opposite-platform native skip`.

## Hard gate boundary

Gate 0–6 validate contracts, observation safety, authority/actuation semantics, native temporal semantics, causal governance, AI fallback, and end-to-end benchmark integrity. They do not treat B2>B1 or B3>B2 as hard requirements.

## Next

Run repeated formal experiments and publish the first evidence-based Benchmark Book. The canonical loop remains:

```text
Implement → Measure → Break → Revise
```
