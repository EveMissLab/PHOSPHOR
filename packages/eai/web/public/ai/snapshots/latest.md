# PHOSPHOR — Preview snapshot, 2026-10-04

Updated 2026-10-04. PHOSPHOR contains three independently installable packages sharing one public source tree. Their versions and event contracts remain independent.

| Package | Version | Executable surface |
| --- | --- | --- |
| Spacetime | 0.1.0a9 with Preview delivery fixes | `pss temporal-demo`, `run`, `matrix`, `compare`, `gate` |
| EAI | 0.8.0-beta | VM/WASM engine, CTS, JSONL, spreadsheet, eleven-tab browser UI |
| MCCP | 0.0.1 | Local Python trace collector, computational graph, lenses, API and UI |

## Spacetime

M0–M10 implement observation, IR/registry, authority-bound control, Windows Job Object and Linux cgroup v2 providers, a native logical-time synthetic runtime, Rule Governor, schema-bounded AI policy adapter, benchmarks, and hard Gate 0–6.

`pss temporal-demo --rate 2.5 --quanta 20` uses the actual authority gate and provider. Expected: CONFIRMED receipt, realized rate 2.5, logical tick 50, equal tick/event-jump state hashes, and 47 idle ticks skipped. No API key is required.

CPU service rate and logical-time rate are distinct. Exact temporal control is supported by the synthetic runtime; arbitrary OS program clock virtualization is not implemented. Windows resource budgets are supported; pause/resume verification is PARTIAL. Linux resource subcontrols depend on delegated privileges and available controllers. Most benchmark workloads are synthetic; B2>B1 and B3>B2 remain empirical questions.

## EAI

`Φ : M × CTS → V`: actual execution paired with Correspondence Table System roles gives human and machine-readable projections. EML-VM-16 has 28 opcodes. VM-64 and VM-BASIC retain their existing integer domains. The WASM target parses genuine binary modules and is checked against Node's native WebAssembly engine. The supported subset is i32/control/call/one memory page; imports, tables, indirect calls, i64, floating point, and multi-value remain unsupported.

Shipped additions since v0.5: spreadsheet projection/control, real WASM, a rustc-based optimization/equivalence flagship, six UI themes, eleven UI tabs, role-based CTS retrofit guidance, and an independent RPN example. The operational equivalence judge preserves its tested-input/exhaustive distinction. Retrofit v1 covers Tier 1 deterministic targets only. Soft spreadsheet approvals do not provide adversarial agent containment.

## MCCP

Real local Python tracing builds bounded function/file/network/database/process graphs, macro/meso projections, complexity and bug lenses, and evidence-grounded explanations. Basic tracing and graph inspection need no model key. Explanations require a user-supplied Anthropic key and transmit selected trace evidence. The optional Perfetto viewer is an external surface. Traces can contain real program data and paths; do not publish them as fixtures.

## Delivery

Download the unified source at `/download/phosphor-preview-source.zip`, or use the component archives listed in `/download/manifest.json`. The source tree contains `packages/spacetime`, `packages/eai`, and `packages/mccp`; start with its root README. The website is a static usage/download surface with an in-browser EAI playground. No hosted OS-control endpoint is provided.

Code: Apache-2.0. Existing content-learning rights remain at `/ai/rights-spectrum.json`. Author Neo.K (許筌崴), EVEMISS TECHNOLOGY CO., LTD.（一言諾科技有限公司）.
