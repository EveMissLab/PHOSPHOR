# PHOSPHOR Spacetime — software spacetime control

Version 0.1.0a9, M0–M10 reference runtime, with Preview delivery fixes and a `temporal-demo` CLI entry. Python >= 3.12. Source package: `/download/phosphor-spacetime-v0.1.0a9-source.zip`. In the unified source tree: `packages/spacetime`.

Observe -> Project -> Govern -> Authorize -> Actuate -> Verify -> Benchmark -> Gate.

Install from the extracted package folder: `python -m pip install -e ".[dev]"`.
Run `pss temporal-demo --rate 2.5 --quanta 20`: an invocation-owned synthetic runtime receives an authority-checked temporal-rate command; the provider's post-observation confirms 2.5. Twenty quanta advance to logical tick 50. Tick execution and event jumping preserve equal state hashes; event jumping skips 47 idle ticks. Rate zero freezes logical progress. This is logical-time control within the native runtime.

Windows Job Objects expose CPU hard caps and memory limits; process suspension verification is PARTIAL. Linux cgroup v2 resource controls depend on the delegated subtree and installed controllers. Neither OS provider implements an arbitrary process's logical-time-rate change. `CPUServiceRate != LogicalTimeRate`.

`pss matrix C_EVENT_SPARSE` produces B0–B3 benchmark artifacts. `pss compare` retains invalid-run counts and comparison compatibility. `pss gate` runs G0–G6 and records each gate's evidence and failure state independently. `performance_hypotheses_evaluated=false`; B2>B1 and B3>B2 remain empirical questions. Most built-in workloads are synthetic. B3's bundled fixture does not call a paid model.

The package ships its JSON schemas as installed resources. The demo, benchmarks, and gates need no API key. Native provider tests are explicitly enabled for the appropriate platform. The website is a static usage/download surface; it does not expose a hosted machine-control endpoint.

Apache-2.0. Spacetime, EAI, and MCCP are independently installable packages. Their event protocols remain distinct.
