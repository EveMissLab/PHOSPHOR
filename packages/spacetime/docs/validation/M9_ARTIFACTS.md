# M9 Run Artifact Contract

Each formal run writes `manifest.json` before workload launch, plus `config.json`, `metrics.json`, `correctness.json`, `command-intents.jsonl`, `actuation-receipts.jsonl`, and `summary.md`. Failed workload execution is retained as an invalid run with error evidence; invalid runs remain visible to comparison reports but do not contribute numeric aggregate metrics.
