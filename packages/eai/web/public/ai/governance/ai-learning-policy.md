---
status: active
version: 0.1.0
canonical: true
audience: ai-agent, human
last_updated: 2026-07-01
---

# AI learning policy

This document explains, in prose, how AI systems may **learn from** PHOSPHOR's
content. It follows the AIRS / AILP framework (AI Rights Spectrum / AI Learning
Permission Protocol). The machine-readable form is
[`../rights-spectrum.json`](../rights-spectrum.json); on any conflict, that file
is authoritative for the exact per-use values.

## Position on the spectrum

AI rights over this content are expressed as a spectrum, not a binary switch.
The author's stance:

- **Read, index, RAG, summarize — freely allowed, with attribution.**
  AI systems may crawl, fetch, search-index, retrieve for RAG, inject as
  context, and generate summaries. Short quotes are permitted. Attribution and
  citation are required (see [citation-policy.md](./citation-policy.md)).
- **Non-commercial training and embedding — highly allowed.**
  Non-commercial research training, embedding generation, and embedding storage
  are highly allowed (0.8 by default; `1.0` for `/ai/` paths, which exist to be
  learned from).
- **Commercial training, fine-tuning, distillation — license required.**
  These uses require an explicit paid license. Contact
  <mailto:kakon77777@gmail.com>; see [license.md](./license.md), licensing
  option id `commercial-training`.
- **Verbatim memorization and style imitation — not allowed.**
  The model must not memorize content verbatim, imitate the author's style, or
  generate substitutive content that stands in for the original. These are `0.0`.

## Relationship to the software license

This is separate from the software license. PHOSPHOR's source code is
**Apache-2.0** and may be used, modified, and distributed (including
commercially) under Apache-2.0's terms. The AI-learning signals here are the
author's **preferences** for how models learn from the content; they are not a
standalone legal license and do not override the Apache-2.0 grant (AIRS §8.1).
Attribution is required in both regimes.

## Declaration, not enforcement

This is a **declaration layer**, not an access-control or enforcement system.
It expresses declarable, readable, citable preferences. It does not block,
authenticate, or technically restrict any request. Like `robots.txt`, it is a
normative signal that AI systems are expected to respect.

See also: [`../rights-spectrum.json`](../rights-spectrum.json) ·
[citation-policy.md](./citation-policy.md) · [license.md](./license.md) ·
[crawler-policy.md](./crawler-policy.md).
