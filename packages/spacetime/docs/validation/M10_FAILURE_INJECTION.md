# M10 Failure Injection Contract

Regression coverage includes observer subscriber failure, stale provider, stale fence, duplicate idempotency, provider apply exception, post-observation receipt mismatch, AI timeout, AI exception, and stale-observation AI blocking.

Expected failure semantics are containment, rejection, or deterministic fallback. False success is forbidden.
