# PHOSPHOR — machine-readable entry

Current Preview: Spacetime 0.1.0a9, EAI 0.8.0-beta, MCCP 0.0.1. Three independent packages; Apache-2.0.

1. [Manifest](manifest.json): packages, versions, downloads, rights.
2. [Current capabilities](corpus/current.md): what is executable and what remains open.
3. [Spacetime guide](corpus/spacetime.md): authority, logical time, benchmarks, gates.
4. [Spacetime installation](/spacetime/): a runnable no-key demonstration.
5. [MCCP installation](/mccp/): local Python tracing and graph views.
6. [EAI playground](/#playground): eleven tabs using the shipped engine.

[Unified source](/download/phosphor-preview-source.zip) contains all three packages. Read its root `README.md`. [Integrity manifest](/download/manifest.json) gives exact archive sizes and SHA-256.

Spacetime: Python >= 3.12; `python -m pip install -e ".[dev]"`; `pss temporal-demo --rate 2.5 --quanta 20`; `pss matrix C_EVENT_SPARSE`; `pss gate --git-commit UNKNOWN`. Native logical time belongs to the owned synthetic runtime. OS CPU throttling and logical-time control are different capabilities.

EAI: Node >= 22; `npm ci`; `npm run typecheck`; `npm run verify:wasm`; `npm run phosphor -- run --program fibonacci --max 40`. Read `packages/eai/FOR-AGENTS.md` for the full harness list.

MCCP: basic tracing needs no key. AI explanations send selected trace evidence to a configured model and require a user-supplied `ANTHROPIC_API_KEY`. Optional raw timelines use external Perfetto. Keep traces local.

The [batch corpus](corpus/full-corpus.jsonl) describes the current Preview. [Origin](corpus/origin.md), [design history](corpus/design-history.md), and the [v0.5 base spec](specs/eml-eai-2026-v0.5.md) preserve earlier EAI context. The [v0.8 retrofit document](specs/eai-retrofit.md) describes CTS roles and Tier 1 scope.

[Tools](tools/catalog.json) are a declaration surface; HTTP/MCP runtime endpoints are not hosted. Event contracts remain package-specific. Hard gates do not establish performance superiority.

Author Neo.K (許筌崴), EVEMISS TECHNOLOGY CO., LTD.（一言諾科技有限公司）. [Code license](governance/license.md), [content-learning rights](rights-spectrum.json), [learning policy](governance/ai-learning-policy.md).
