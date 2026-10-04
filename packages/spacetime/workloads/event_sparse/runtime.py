from __future__ import annotations

import json

from phosphor_spacetime.providers.synthetic_runtime import SyntheticRuntime


def build_reference_runtime(*, seed: int = 42) -> SyntheticRuntime:
    runtime = SyntheticRuntime(seed=seed)
    runtime.schedule_event(100, "add", key="counter", value=1)
    runtime.schedule_event(500, "random_add", key="counter", low=1, high=9)
    runtime.schedule_event(900, "set", key="phase", value="complete")
    return runtime


def compare_modes(*, target_tick: int = 1000, seed: int = 42) -> dict:
    tick = build_reference_runtime(seed=seed)
    jump = build_reference_runtime(seed=seed)

    tick.run_until(target_tick, mode="tick")
    jump.run_until(target_tick, mode="event_jump")

    return {
        "target_tick": target_tick,
        "seed": seed,
        "state_hash_equal": tick.state_hash() == jump.state_hash(),
        "tick": {
            "state_hash": tick.state_hash(),
            "state": tick.state,
            "tick_iterations": tick.metrics.tick_iterations,
            "events_executed": tick.metrics.events_executed,
        },
        "event_jump": {
            "state_hash": jump.state_hash(),
            "state": jump.state,
            "tick_iterations": jump.metrics.tick_iterations,
            "jump_count": jump.metrics.jump_count,
            "idle_ticks_skipped": jump.metrics.idle_ticks_skipped,
            "events_executed": jump.metrics.events_executed,
        },
    }


if __name__ == "__main__":
    print(json.dumps(compare_modes(), ensure_ascii=False, indent=2, sort_keys=True))
