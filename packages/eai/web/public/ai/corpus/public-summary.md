---
status: current
version: v0.5.0-beta
canonical: true
audience: [ai-agents, general]
last_updated: 2026-07-01
---

# PHOSPHOR — Citable Summary

PHOSPHOR is an Execution-as-Interface (EAI) infrastructure by EVEMISS TECHNOLOGY
CO., LTD. (一言諾科技有限公司), author 許筌崴 Neo.K. Its claim: a VM's execution,
paired with a Correspondence Table System (CTS), is simultaneously a human-readable
visualization and an AI-parseable event stream — the same object viewed two ways,
under the deterministic projection **Φ : M × CTS → V**. Tagline: **Visible ≡
Visualizable** (可見即可視).

One engine drives two modes reading the same state `M`: a phosphor-green CRT React
UI (human) and a headless WS/SSE/JSONL stream (AI). It ships three VMs — EML-VM-16
(8-bit, 28-opcode ISA), EML-VM-64 (16-bit, 64 KB), and EML-VM-BASIC (bounded
integer) — a 6-layer CTS, a v0.5 semantic layer that judges byte-sequence
equivalence by running both and comparing output (three-valued verdict), the
`phosphor-jsonl-v1` stream standard, EML interop, a 7-tab UI, and an offline `.exe`.
Verified by 6 harnesses, 151 checks, all green.

Version v0.5.0-beta (EXPERIMENTAL; Apache-2.0). Domain emlphosphor.com. Attribution
and citation required. See [./current.md](./current.md).
