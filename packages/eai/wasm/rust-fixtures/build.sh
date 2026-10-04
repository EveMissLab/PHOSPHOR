#!/usr/bin/env bash
# PHOSPHOR · Phase 2 flagship fixtures — real, independently-toolchain-compiled
# WASM (not hand-assembled, unlike wasm-fixtures.ts's Phase 1 proof point).
#
# Requires: rustc with the wasm32-unknown-unknown target
#   (rustup target add wasm32-unknown-unknown)
#
# baseline.rs            — fib(0..=n) → memory, add() kept as a real call
#                           (#[inline(never)]).
# optimized-correct.rs   — an AI-proposed micro-optimization: inline add()
#                           away. Behaviorally identical to baseline.
# optimized-buggy.rs     — the same inlining, but the loop bound was
#                           "simplified" from `i <= n` to `i < n` in the same
#                           pass — a classic off-by-one, silently dropping the
#                           final fib value. NOT equivalent to baseline.
#
# Both memory writes use core::ptr::write_volatile rather than a plain raw
# write: volatile semantics forbid LLVM from fusing the two adjacent i32
# stores that seed fib(0)/fib(1) into one i64 store — real WASM codegen does
# this by default, and it's outside the WASM-MVP profile's supported opcode
# set (i64 is explicitly not supported — see wasm/wasm-binary.ts). This
# keeps the fixture's real-toolchain codegen inside the profile rather than
# quietly extending the interpreter to accommodate one optimization artifact.
set -euo pipefail
cd "$(dirname "$0")"

for f in baseline optimized-correct optimized-buggy; do
  rustc --target wasm32-unknown-unknown -O --crate-type=cdylib \
    -C link-arg=--no-entry -C link-arg=--allow-undefined -C panic=abort \
    -o "$f.wasm" "$f.rs"
  echo "built $f.wasm"
done
