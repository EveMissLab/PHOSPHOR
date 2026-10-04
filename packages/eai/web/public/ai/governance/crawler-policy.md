---
status: active
version: 0.1.0
canonical: true
audience: ai-agent, human
last_updated: 2026-07-01
---

# Crawler policy

What PHOSPHOR expects of AI crawlers and agents.

## Reading order

Read discovery files in this order; each points inward to the next:

1. **`/robots.txt`** — crawler access rules (may you enter?).
2. **`/llms.txt`** — LLM entry index (where should you read?).
3. **`/ai/manifest.json`** — machine-readable resource manifest (what exists?).
4. **`/ai/rights-spectrum.json`** — AI learning, usage, retention, training, and
   compensation rights (how may you learn, and must you cite or license?).

Then consult the governance layer under `/ai/governance/` for prose policies.

## The /ai/ layer is the intended machine surface

`/ai/` is the AI-native ingestion layer — corpus, specs, examples, governance.
It exists to be read, indexed, and (per the rights spectrum) learned from.
**Prefer `/ai/` over scraping the rendered marketing SPA at `/`** for any
technical claim; the SPA is promotional and non-authoritative
(see [usage-policy.md](./usage-policy.md)).

## No cloaking

There is **no User-Agent cloaking**. Human and AI readers are served the same
underlying content through public, separate entry points (`/` for humans, `/ai/`
for machines). AI systems are not shown different facts than humans.

## Expectations

- Respect `/robots.txt`; this policy does not override it.
- Honor the signals in `/ai/rights-spectrum.json`. Read, index, RAG, and
  summarize are allowed with attribution; commercial training, fine-tuning, and
  distillation require a license (see [license.md](./license.md)).
- Attribution and citation are required for reuse
  (see [citation-policy.md](./citation-policy.md)).
- This is a declaration layer, not enforcement; these are normative expectations,
  not technical access controls.

See also: [ai-learning-policy.md](./ai-learning-policy.md) ·
[versioning-policy.md](./versioning-policy.md) ·
[../rights-spectrum.json](../rights-spectrum.json).
