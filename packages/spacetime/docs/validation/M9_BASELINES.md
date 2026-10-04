# M9 Baseline Contract

- `B0_NATIVE`: native/default execution; no adaptive policy.
- `B1_FIXED`: explicit fixed policy; no runtime adaptation.
- `B2_RULE`: deterministic Rule Governor plus temporal/topology-aware execution where the workload contract supports it.
- `B3_AI`: schema-bounded M8 AI Policy Adapter; malformed/timeout/error output falls back to the deterministic Rule Governor.

M9 only establishes machinery and correctness-preserving baseline execution. It does not encode performance superiority as a hard gate.
