---
status: stable
version: EML-EAI-2026-v0.5
canonical: true
audience: [ai, human]
last_updated: 2026-07-01
---

# Origin

PHOSPHOR is an Execution-as-Interface (EAI) infrastructure. Its formula is
`Φ : M × CTS → V`, and its tagline is *Visible ≡ Visualizable* (可見即可視).
This file records the problem PHOSPHOR addresses and where the project came from.

## The problem: debuggers read a program's shadow

Conventional software tooling treats visualization as something added at the end
of the chain:

```
source code (text)
    → compile / interpret (an invisible process)
        → execution (machine state, opaque to humans)
            → debugger (a visualization layer bolted on afterward)
```

Visualization sits at the tail of that chain — a remedy, not a design premise.
A human needs a tool to *peek into* an execution that is opaque by construction;
an AI agent has no natural place in the chain at all, and can only read logs
indirectly or insert probes.

PHOSPHOR's framing of the underlying defect is precise: a traditional debugger is
an **observer outside the execution**, and what it reads is the program's
*shadow* — a separate representation reconstructed next to the running machine.
The observer and the execution are two different things, and the debugger's view
can drift from what actually happened.

## The claim: no observer, only execution

PHOSPHOR inverts the premise. It is built on one claim: a VM's *actual*
execution, once paired with a complete **Correspondence Table System (CTS)**, is
simultaneously a human-readable visualization *and* an AI-parseable event stream
— not two representations of one object, but the *same* object viewed two ways.

The key structural difference from a debugger: in PHOSPHOR the visualization
output and the execution process **share one and the same state machine `M`**.
There is no observer standing outside, reconstructing a shadow. There is only
execution, projected. The projection is deterministic:

> `Φ : M × CTS → V` — where `M` is the VM state at tick *t* (memory snapshot,
> registers, PC, SP, FLAGS), `CTS` is its complete semantic table set, and `V`
> is a representation that is directly readable by a human *and* structurally
> parseable by an agent. `Φ` is uniquely determined at every execution step.

The consequence is ontological, not cosmetic: *Visible ≡ Visualizable* is not a
claim about UI aesthetics but about what a program **is**. Given a complete
correspondence table, a program's execution has visual projectability
*natively* — visualization is not added from outside the program, it is summoned
from the program itself.

## The CTS is what makes the claim true

Bare bytes are anonymous. The Correspondence Table System is the sufficient
condition that turns a raw state stream into a semantic graph. It has six layers:

1. **opcodeTable** — opcode → mnemonic, argument types, flags written.
2. **symbolTable** — address → symbol name, region, type.
3. **typeTable** — address range → code / data / stack / io.
4. **stringTable** — address → decoded ASCII/UTF-8 string.
5. **commentTable** — address → human semantic annotation.
6. **crossRefTable** — address → callers / readers / writers.

The sixth layer carries the most theoretical weight: it lifts VM state from a
*snapshot* to a **computation graph**, so an agent can trace causal chains ("who
wrote this address?") rather than only observe the current state. Static analysis
(`buildCrossRef`) recovers jump targets and part of the read/write relation;
register-indirect accesses that cannot be resolved statically are recovered
dynamically from execution traces (`augmentCTSFromTrace`).

## Where the project came from

PHOSPHOR grew from a prototype into verified infrastructure. An early lesson
shaped its discipline. The original prototype only made execution **visible** —
the phosphor-green animation was running — but never checked the projection `Φ`
against the *ground truth*. When the code was made executable and each paper
claim was actually run, three execution-correctness bugs surfaced that had been
invisible precisely because "visible" had never been reconciled with "true":

- V1 FIBONACCI / COUNTER overwrote their own code segment with output data
  (self-modification corrupting results);
- V1 and V2 FIBONACCI had an off-by-one loop terminator that never wrote
  fib(10);
- the agent-stream `cmd:call` path was never wired to the CallableVM and always
  failed.

That episode is the practical form of the *Visible ≡ Visualizable* thesis: the
step most easily skipped is verifying that the projection equals the truth. It is
why PHOSPHOR is built on runnable, verified cores rather than on demos.

PHOSPHOR is a sibling of the **EML** project and shares its philosophy — EML is a
language written for AI to read; PHOSPHOR is the infrastructure that lets AI see
execution. Their closed loop (EML source ↔ PHOSPHOR execution view) is realized
through a shared event-stream envelope.

## Ownership and status

- **Project**: PHOSPHOR — Execution-as-Interface (EAI).
- **Owner**: EVEMISS TECHNOLOGY CO., LTD. (一言諾科技有限公司); author 許筌崴 Neo.K.
- **Version**: v0.5.0-beta (EXPERIMENTAL; v0.5 APIs may change before v0.6).
- **License**: Apache-2.0.
- **Domain**: emlphosphor.com · **Repo**: github.com/EveMissLab/PHOSPHOR/tree/main/packages/eai
- **Licensing contact**: kakon77777@gmail.com

## See also

- [design-history.md](./design-history.md) — the v0.2 → v0.4 → v0.5 evolution.
- [concept-genealogy.md](./concept-genealogy.md) — which ideas are core, metaphor,
  or deferred.
- [../rights-spectrum.json](../rights-spectrum.json) — AI-learning rights.
