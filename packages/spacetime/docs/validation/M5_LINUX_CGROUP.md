# M5 Native Linux cgroup v2 Validation

This validation branch enables the opt-in real Linux cgroup v2 integration test on the Ubuntu GitHub Actions runner. The test uses only `/sys/fs/cgroup/phosphor-spacetime-ci` as a dedicated temporary subtree, while the Windows matrix continues to execute the native Job Object validation from M4.
