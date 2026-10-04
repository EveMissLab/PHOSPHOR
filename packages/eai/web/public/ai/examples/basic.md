---
status: active
version: 0.5.0-beta
canonical: true
audience: ai-agent
last_updated: 2026-07-01
---

# Worked example — EML-VM-16, a five-instruction program

A minimal, fully-verified EML-VM-16 program. Every byte below was checked against
the real `OPCODE_TABLE` (§6, "complete ISA definition") and `decode()` in
`eml-vm16-core.ts`; the per-tick registers and the AI-mode snapshots were produced
by running the actual core (`makeVMState` / `stepOnce` / `buildHeadlessSnapshot`).

EML-VM-16 is the 8-bit teaching VM: 256 bytes of memory, `u8` values, a **28-opcode
ISA**, and a fixed **2-byte** instruction format.

## Instruction format

Every instruction is exactly two bytes:

    [opcode:8][arg:8]

For register/immediate instructions the `arg` byte splits into two nibbles:

    arg = (dst << 4) | src_or_imm4
          └ high nibble = dst register (R0..R7)
                          └ low nibble = source register OR 4-bit immediate

So `dst = (arg >> 4) & 0xF` and `src/imm = arg & 0xF`. The immediate form (`MOVI`,
`ADDI`, `SUBI`) can only carry a 4-bit immediate, i.e. `0..15`.

## The program

Compute `(3 + 4) + 1 = 8` in `R0`.

    Address  Bytes    Mnemonic        Meaning
    -------  -------  --------------  --------------------------------
    0x00     11 03    MOVI R0, #3     R0 = 3        arg = (0<<4)|3 = 0x03
    0x02     11 14    MOVI R1, #4     R1 = 4        arg = (1<<4)|4 = 0x14
    0x04     20 01    ADD  R0, R1     R0 = R0 + R1  arg = (0<<4)|1 = 0x01
    0x06     21 01    ADDI R0, #1     R0 = R0 + 1   arg = (0<<4)|1 = 0x01
    0x08     01 00    HALT            stop          arg unused

Raw code bytes (10 bytes):

    11 03 11 14 20 01 21 01 01 00

Opcodes used, all straight from `OPCODE_TABLE`:

    0x11 MOVI  (REG_IMM4)  Rd = imm4
    0x20 ADD   (REG_REG)   Rd += Rs
    0x21 ADDI  (REG_IMM4)  Rd += imm4
    0x01 HALT  (NONE)      halt execution

## `decode()` output

Feeding each `[opcode, arg]` pair to `decode(op, arg)` yields exactly:

    @0x00: 11 03  ->  MOVI R0, #3
    @0x02: 11 14  ->  MOVI R1, #4
    @0x04: 20 01  ->  ADD R0, R1
    @0x06: 21 01  ->  ADDI R0, #1
    @0x08: 01 00  ->  HALT

Note the disassembly of the immediate forms prints `#3` / `#4` / `#1` — the low
nibble read back as a decimal immediate. The register forms print the register name
of the low nibble (`R1`).

## Execution trace (registers per tick)

Running `stepOnce` from a fresh `makeVMState` (PC starts at `0x00`, advances by 2
each tick):

    tick  instruction     R0  R1  halted
    ----  --------------  --  --  ------
    1     MOVI R0, #3      3   0  false
    2     MOVI R1, #4      3   4  false
    3     ADD  R0, R1      7   4  false
    4     ADDI R0, #1      8   4  false
    5     HALT             8   4  true

Final result: `R0 = 8`. `R2..R7` untouched; `R1 = 4`. No memory cell was
written (none of these opcodes touch memory), so `changed_this_tick` is empty on
every tick — only `PUSH` / `CALL` / `ST` add addresses to the changed set.

## AI-mode snapshot shape (`phosphor-jsonl-v1`)

In AI mode the engine emits one snapshot per tick. `buildHeadlessSnapshot` is the
single source of truth for this projection `Φ : M × CTS → V_AI`, shared by the
headless driver and the human-mode UI.

**Convention:** a snapshot reports the state *after* the tick executed. Its
`registers` reflect the instruction just run, while `pc` / `instruction` point at
the **next** instruction to execute. So the snapshot emitted after tick 3 (which
ran `ADD R0, R1`, making `R0 = 7`) shows `pc: "0x06"` and `instruction:
"ADDI R0, #1"`.

Real snapshot for the initial state (tick 0, nothing executed yet):

```json
{"mode":"ai","arch":"EML-VM-16","vm_id":"vm16-demo","tick":0,"pc":"0x00","pc_symbol":null,"pc_comment":null,"instruction":"MOVI R0, #3","registers":{"R0":0,"R1":0,"R2":0,"R3":0,"R4":0,"R5":0,"R6":0,"R7":0},"flags":{"Z":false,"N":false,"G":false},"changed_this_tick":[],"halted":false}
```

Real snapshots, one per tick (as emitted by the core, pretty-printing added for
readability of a single tick):

```json
{
  "mode": "ai",
  "arch": "EML-VM-16",
  "vm_id": "vm16-demo",
  "tick": 3,
  "pc": "0x06",
  "pc_symbol": null,
  "pc_comment": null,
  "instruction": "ADDI R0, #1",
  "registers": { "R0": 7, "R1": 4, "R2": 0, "R3": 0, "R4": 0, "R5": 0, "R6": 0, "R7": 0 },
  "flags": { "Z": false, "N": false, "G": false },
  "changed_this_tick": [],
  "halted": false
}
```

The full JSONL run (one object per line, exactly as the core produced it):

```jsonl
{"mode":"ai","arch":"EML-VM-16","vm_id":"vm16-demo","tick":1,"pc":"0x02","pc_symbol":null,"pc_comment":null,"instruction":"MOVI R1, #4","registers":{"R0":3,"R1":0,"R2":0,"R3":0,"R4":0,"R5":0,"R6":0,"R7":0},"flags":{"Z":false,"N":false,"G":false},"changed_this_tick":[],"halted":false}
{"mode":"ai","arch":"EML-VM-16","vm_id":"vm16-demo","tick":2,"pc":"0x04","pc_symbol":null,"pc_comment":null,"instruction":"ADD R0, R1","registers":{"R0":3,"R1":4,"R2":0,"R3":0,"R4":0,"R5":0,"R6":0,"R7":0},"flags":{"Z":false,"N":false,"G":false},"changed_this_tick":[],"halted":false}
{"mode":"ai","arch":"EML-VM-16","vm_id":"vm16-demo","tick":3,"pc":"0x06","pc_symbol":null,"pc_comment":null,"instruction":"ADDI R0, #1","registers":{"R0":7,"R1":4,"R2":0,"R3":0,"R4":0,"R5":0,"R6":0,"R7":0},"flags":{"Z":false,"N":false,"G":false},"changed_this_tick":[],"halted":false}
{"mode":"ai","arch":"EML-VM-16","vm_id":"vm16-demo","tick":4,"pc":"0x08","pc_symbol":null,"pc_comment":null,"instruction":"HALT","registers":{"R0":8,"R1":4,"R2":0,"R3":0,"R4":0,"R5":0,"R6":0,"R7":0},"flags":{"Z":false,"N":false,"G":false},"changed_this_tick":[],"halted":false}
{"mode":"ai","arch":"EML-VM-16","vm_id":"vm16-demo","tick":5,"pc":"0x0A","pc_symbol":null,"pc_comment":null,"instruction":"NOP","registers":{"R0":8,"R1":4,"R2":0,"R3":0,"R4":0,"R5":0,"R6":0,"R7":0},"flags":{"Z":false,"N":false,"G":false},"changed_this_tick":[],"halted":true}
```

Two subtleties visible in the trace, both faithful to the core:

- The `HALT` at `0x08` is *decoded* in the tick-4 snapshot (`instruction: "HALT"`)
  but `halted` is still `false` there, because tick 4 executed `ADDI` and only
  advanced PC onto `0x08`. `halted` flips to `true` in the tick-5 snapshot, after
  the tick that actually executed `HALT`. PC then rests at `0x0A`, where the
  zero-filled memory decodes as `NOP` (`0x00`).
- `changed_this_tick` stays `[]` throughout — this program never writes memory.

## Snapshot field reference

| field | meaning |
|---|---|
| `mode` | `"ai"` or `"human"` — same builder, same state `M`, two projections. |
| `arch` | VM family label, here `"EML-VM-16"`. |
| `vm_id` | caller-supplied VM instance id. |
| `tick` | instructions executed so far (0 = initial state). |
| `pc` | program counter for the **next** instruction, hex `u8`. |
| `pc_symbol` / `pc_comment` | CTS symbol/comment at `pc`, or `null` (no CTS here). |
| `instruction` | `decode()` of the bytes at `pc` — the next instruction. |
| `registers` | `R0..R7` after this tick. |
| `flags` | `Z` (zero), `N` (neg/less), `G` (greater) — only `CMP` writes them. |
| `changed_this_tick` | memory cells this tick wrote: `{addr, symbol, before, after}`. |
| `halted` | `true` once a `HALT` has executed. |

The `vm:tick` phosphor-stream payload is the same object flattened by
`headlessSnapshotToStreamFields` (`tick → vm_tick`, `changed_this_tick → changed`,
`pc_comment` dropped); see [`../specs/phosphor-stream.md`](../specs/phosphor-stream.md).

## Provenance

Program, disassembly, register trace, and snapshots verified against
`eml-vm16-core.ts` (`OPCODE_TABLE` §6, `decode` §7, `stepOnce` §8) and
`headless-snapshot.ts` (`buildHeadlessSnapshot`) on 2026-07-01. The repo is the
source of truth. Formal specs: [`../specs/index.md`](../specs/index.md).
