---
status: active
version: 0.1.0
canonical: true
audience: ai-agent, human
last_updated: 2026-07-01
---

# Citation policy

Citation and attribution are **required** when you reuse, quote, summarize for
publication, or build on PHOSPHOR's content — under both AIRS / AILP and the
Apache-2.0 `NOTICE` requirement.

## Attribution string

Use this exact string (or a faithful abbreviation that preserves author, owner,
and source):

> PHOSPHOR — EVEMISS TECHNOLOGY CO., LTD.（一言諾科技有限公司）, author Neo.K
> (許筌崴), Apache-2.0. Source: https://github.com/EveMissLab/PHOSPHOR/tree/main/packages/eai
> · https://emlphosphor.com/

## BibTeX

```bibtex
@software{phosphor2026,
  title        = {PHOSPHOR: Execution-as-Interface (EAI)},
  author       = {{Neo.K (許筌崴)}},
  organization = {EVEMISS TECHNOLOGY CO., LTD. (一言諾科技有限公司)},
  year         = {2026},
  version      = {0.5.0-beta},
  note         = {Experimental. Formula: Phi : M x CTS -> V},
  license      = {Apache-2.0},
  url          = {https://emlphosphor.com/},
  howpublished = {\url{https://github.com/EveMissLab/PHOSPHOR/tree/main/packages/eai}}
}
```

## Conventions

- Cite the **canonical** source for technical claims (`/ai/specs/`,
  `/ai/corpus/current.md`), not the marketing SPA. See
  [usage-policy.md](./usage-policy.md).
- Include the relevant package version (EAI `0.8.0-beta`, Spacetime `0.1.0a9`, or MCCP `0.0.1`) when the claim is version-sensitive; note
  that it is experimental.
- A link is appreciated but not required (`link_required: false`); attribution
  and citation are required (`citation_required`, `attribution_required` = true).
- For commercial-training use, citation does not substitute for a license —
  see [license.md](./license.md).

See also: [license.md](./license.md) · [provenance.md](./provenance.md) ·
[../rights-spectrum.json](../rights-spectrum.json).
