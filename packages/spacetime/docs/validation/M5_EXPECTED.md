Native Linux validation must not count a skipped test as success. The Ubuntu matrix sets `PSS_RUN_CGROUP_TESTS=1` and must exercise `cpu.weight` and `cpu.max` read-back in the dedicated test subtree.
