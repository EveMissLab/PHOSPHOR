import { useState, useEffect } from "react";

const ROWS = 24;
const COLS = 64; // 擴充為 64 位元 (8 bytes) 一行
const TOTAL = ROWS * COLS;
const SPEEDS = { SLOW: 320, NORM: 120, FAST: 45 };

const X86 = {
  '90': 'NOP',       'C3': 'RET',      'CC': 'INT3',     'CD': 'INT n',
  'EB': 'JMP short', 'E9': 'JMP near', 'E8': 'CALL rel',
  'B8': 'MOV EAX,',  'B9': 'MOV ECX,', 'BA': 'MOV EDX,', 'BB': 'MOV EBX,',
  '50': 'PUSH EAX',  '51': 'PUSH ECX', '58': 'POP EAX',  '59': 'POP ECX',
  '89': 'MOV r/m,r', '8B': 'MOV r,r/m','31': 'XOR',      '33': 'XOR r',
  '01': 'ADD',       '03': 'ADD r',    '29': 'SUB',      '2B': 'SUB r',
  '39': 'CMP',       '3B': 'CMP r',   '85': 'TEST',     '84': 'TEST b',
  'FF': 'INC/JMP*',  'F7': 'MUL/DIV', '74': 'JE',       '75': 'JNE',
  '7C': 'JL',        '7D': 'JGE',     '7E': 'JLE',      '7F': 'JG',
  '0F': '[ESC 2B]',  'F3': 'REP',     '6A': 'PUSH imm8','68': 'PUSH imm32',
  'CF': 'IRET',      'C9': 'LEAVE',   'A1': 'MOV EAX,m','FE': 'INC/DEC b',
  '87': 'XCHG r,r/m','86': 'XCHG b',  'C6': 'MOV r/m8,','C7': 'MOV r/m,',
};

function bitsToHex(vals, base) {
  const bytes = COLS / 8;
  const hexes = [];
  for (let i = 0; i < bytes; i++) {
    const val = vals.slice(base + i * 8, base + i * 8 + 8).reduce((a, b) => (a << 1) | b, 0);
    hexes.push(val.toString(16).padStart(2, '0').toUpperCase());
  }
  return hexes;
}

export default function BinaryMatrix() {
  const [vals, setVals] = useState(() =>
    Array.from({ length: TOTAL }, () => (Math.random() > 0.5 ? 1 : 0))
  );
  const [flashes, setFlashes] = useState(() => new Uint8Array(TOTAL));
  const [speed, setSpeed] = useState('NORM');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      const n = Math.floor(Math.random() * 9) + 4;
      const idxSet = new Set();
      while (idxSet.size < n) idxSet.add(Math.floor(Math.random() * TOTAL));
      const indices = [...idxSet];

      setVals(prev => {
        const next = [...prev];
        indices.forEach(i => { next[i] ^= 1; });
        return next;
      });

      const f = new Uint8Array(TOTAL);
      indices.forEach(i => { f[i] = 1; });
      setFlashes(f);
      setTick(t => t + 1);
    }, SPEEDS[speed]);
    return () => clearInterval(id);
  }, [speed]);

  const ones = vals.reduce((a, b) => a + b, 0);
  const density = ((ones / TOTAL) * 100).toFixed(1);

  return (
    <div style={{
      background: '#010d01',
      minHeight: '100vh',
      padding: '14px',
      fontFamily: '"Courier New", Courier, monospace',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* CRT Scanline overlay — the signature element */}
      <div style={{
        position: 'fixed',
        inset: 0,
        background: 'repeating-linear-gradient(to bottom, transparent 0px, transparent 1px, rgba(0,0,0,0.12) 1px, rgba(0,0,0,0.12) 2px)',
        pointerEvents: 'none',
        zIndex: 10,
      }} />

      {/* Subtle vignette */}
      <div style={{
        position: 'fixed',
        inset: 0,
        background: 'radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.5) 100%)',
        pointerEvents: 'none',
        zIndex: 9,
      }} />

      {/* Header */}
      <div style={{ marginBottom: '10px', position: 'relative', zIndex: 1 }}>
        <div style={{
          color: '#22ff5a',
          fontSize: '11px',
          letterSpacing: '2px',
          textShadow: '0 0 8px rgba(34,255,90,0.4)',
        }}>
          ▸ BINARY MATRIX {ROWS}×{COLS} · x86 LIVE DECODE
        </div>

        {/* Controls */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          marginTop: '5px',
        }}>
          <span style={{ fontSize: '9px', color: '#1a4a1a', minWidth: '56px' }}>
            ρ = {density}%
          </span>
          <span style={{ color: '#0a1e0a', fontSize: '9px' }}>│</span>
          <span style={{ fontSize: '9px', color: '#1a4a1a' }}>T={tick}</span>
          <span style={{ color: '#0a1e0a', fontSize: '9px' }}>│</span>
          {Object.keys(SPEEDS).map(s => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: '9px',
                padding: '0 3px',
                fontFamily: 'inherit',
                color: speed === s ? '#22ff5a' : '#1a3a1a',
                textShadow: speed === s ? '0 0 6px rgba(34,255,90,0.6)' : 'none',
                letterSpacing: '1px',
              }}
            >
              {speed === s ? '◉' : '○'}{s}
            </button>
          ))}
        </div>
      </div>

      {/* Divider */}
      <div style={{ borderTop: '1px solid #0a1e0a', marginBottom: '8px' }} />

      {/* Matrix grid */}
      <div style={{ overflowX: 'auto', position: 'relative', zIndex: 1 }}>
        {Array.from({ length: ROWS }, (_, r) => {
          const base = r * COLS;
          const hexes = bitsToHex(vals, base);
          const ops = hexes.map(hx => X86[hx]).filter(Boolean);
          const opcode = ops[0] || '';
          const addr = (0x0400 + r * (COLS / 8)).toString(16).toUpperCase();

          return (
            <div key={r} style={{
              display: 'flex',
              alignItems: 'center',
              marginBottom: '2px',
              whiteSpace: 'nowrap',
            }}>
              {/* Memory address */}
              <span style={{
                fontSize: '9px',
                color: '#1a3a1a',
                width: '30px',
                flexShrink: 0,
                marginRight: '6px',
                letterSpacing: '0.5px',
              }}>
                {addr}h
              </span>

              {/* Bit cells */}
              {Array.from({ length: COLS }, (_, c) => {
                const idx = base + c;
                const v = vals[idx];
                const f = flashes[idx];
                return (
                  <span
                    key={c}
                    style={{
                      display: 'inline-block',
                      width: '11px',
                      textAlign: 'center',
                      fontSize: '12px',
                      lineHeight: '1.3',
                      color: f ? '#d0ffd8' : v ? '#22ff5a' : '#0a1c0a',
                      textShadow: f
                        ? '0 0 10px rgba(208,255,216,0.9), 0 0 20px rgba(34,255,90,0.4)'
                        : v
                        ? '0 0 4px rgba(34,255,90,0.3)'
                        : 'none',
                      marginRight: c === 7 ? '5px' : '0',
                    }}
                  >
                    {v}
                  </span>
                );
              })}

              {/* Hex bytes */}
              <span style={{ marginLeft: '8px', flexShrink: 0, display: 'inline-flex', gap: '3px' }}>
                {hexes.map((hx, i) => {
                  const isOp = !!X86[hx];
                  return (
                    <span key={i} style={{
                      fontSize: '10px',
                      color: isOp ? '#ffa500' : '#1c3c1c',
                      fontWeight: isOp ? '700' : '400',
                      textShadow: isOp ? '0 0 4px rgba(255,165,0,0.3)' : 'none',
                    }}>{hx}</span>
                  );
                })}
              </span>

              {/* Mnemonic */}
              {opcode && (
                <span style={{
                  fontSize: '9px',
                  color: '#cc5500',
                  marginLeft: '6px',
                  flexShrink: 0,
                  textShadow: '0 0 3px rgba(204,85,0,0.3)',
                }}>
                  ; {opcode}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div style={{
        marginTop: '10px',
        borderTop: '1px solid #0a1e0a',
        paddingTop: '5px',
        fontSize: '8px',
        color: '#0a1e0a',
        letterSpacing: '1.5px',
        position: 'relative',
        zIndex: 1,
      }}>
        ADDR · DATA [{ROWS}×{COLS}={TOTAL}b] · HEX · x86 MNEMONIC
      </div>
    </div>
  );
}
