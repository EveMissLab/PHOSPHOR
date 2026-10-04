from __future__ import annotations

import json
import statistics
from pathlib import Path
from typing import Any, Iterable


def _numeric_metrics(values: dict[str, Any]) -> dict[str, float]:
    result: dict[str, float] = {}
    for key, value in values.items():
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            result[key] = float(value)
    return result


def compare_run_dirs(run_dirs: Iterable[Path | str]) -> dict[str, Any]:
    runs: list[dict[str, Any]] = []
    for raw_dir in run_dirs:
        run_dir = Path(raw_dir)
        manifest = json.loads((run_dir / "manifest.json").read_text(encoding="utf-8"))
        metrics = json.loads((run_dir / "metrics.json").read_text(encoding="utf-8"))
        correctness = json.loads((run_dir / "correctness.json").read_text(encoding="utf-8"))
        runs.append({
            "run_dir": str(run_dir),
            "run_id": manifest["run_id"],
            "workload": manifest["workload"],
            "baseline": manifest["baseline"],
            "random_seed": manifest.get("random_seed"),
            "repeat_index": manifest.get("repeat_index"),
            "valid": bool(correctness.get("valid")),
            "metrics": _numeric_metrics(metrics.get("values", {})),
        })

    by_baseline: dict[str, Any] = {}
    for run in runs:
        baseline = run["baseline"]
        bucket = by_baseline.setdefault(
            baseline,
            {"run_count": 0, "valid_count": 0, "invalid_count": 0, "metrics": {}},
        )
        bucket["run_count"] += 1
        if run["valid"]:
            bucket["valid_count"] += 1
        else:
            bucket["invalid_count"] += 1

    for baseline, bucket in by_baseline.items():
        valid_runs = [run for run in runs if run["baseline"] == baseline and run["valid"]]
        metric_names = sorted({name for run in valid_runs for name in run["metrics"]})
        for name in metric_names:
            values = [run["metrics"][name] for run in valid_runs if name in run["metrics"]]
            if values:
                bucket["metrics"][name] = {
                    "count": len(values),
                    "mean": statistics.fmean(values),
                    "median": statistics.median(values),
                    "min": min(values),
                    "max": max(values),
                }

    warnings: list[str] = []
    workloads = {run["workload"] for run in runs}
    if len(workloads) > 1:
        warnings.append("MIXED_WORKLOADS")

    baseline_seed_sets: dict[str, set[int | None]] = {}
    for run in runs:
        baseline_seed_sets.setdefault(run["baseline"], set()).add(run["random_seed"])
    if len(baseline_seed_sets) > 1:
        seed_sets = list(baseline_seed_sets.values())
        first = seed_sets[0]
        if any(seed_set != first for seed_set in seed_sets[1:]):
            warnings.append("BASELINE_SEED_SETS_DIFFER")

    valid_count = sum(1 for run in runs if run["valid"])
    return {
        "schema_version": "mvp-comparison-v0.1",
        "run_count": len(runs),
        "valid_run_count": valid_count,
        "invalid_run_count": len(runs) - valid_count,
        "comparison_compatible": not warnings,
        "compatibility_warnings": warnings,
        "runs": runs,
        "by_baseline": by_baseline,
    }
