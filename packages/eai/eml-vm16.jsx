import { useState, useEffect } from "react";

// ══════════════════════════════════════════════════════════════════════════════
// EML-VM-16  ·  8-bit data · 8-bit address · 8 registers · 2-byte instructions
// Instruction format: [opcode:8][arg:8]   arg = [dst:4 | src/imm:4]
// Jump/CALL instructions use full arg byte as 8-bit target address
// ══════════════════════════════════════════════════════════════════════════════

const REG = ['R0','R1','R2','R3','R4','R5','R6','R7'];
const h = n => n.toString(16).toUpperCase().padStart(2,'0');
const bin8 = n => n.toString(2).padStart(8,'0');

function decode(op, arg) {
  const d=(arg>>4)&0xF, s=arg&0xF, A=`0x${h(arg)}`;
  switch(op){
    case 0x00: return 'NOP';
    case 0x01: return 'HALT';
    case 0x10: return `MOV ${REG[d]}, ${REG[s]}`;
    case 0x11: return `MOVI ${REG[d]}, #${s}`;
    case 0x20: return `ADD ${REG[d]}, ${REG[s]}`;
    case 0x21: return `ADDI ${REG[d]}, #${s}`;
    case 0x22: return `SUB ${REG[d]}, ${REG[s]}`;
    case 0x23: return `SUBI ${REG[d]}, #${s}`;
    case 0x30: return `AND ${REG[d]}, ${REG[s]}`;
    case 0x31: return `OR ${REG[d]}, ${REG[s]}`;
    case 0x32: return `XOR ${REG[d]}, ${REG[s]}`;
    case 0x33: return `NOT ${REG[d]}`;
    case 0x40: return `CMP ${REG[d]}, ${REG[s]}`;
    case 0x41: return `INC ${REG[d]}`;
    case 0x42: return `DEC ${REG[d]}`;
    case 0x50: return `JMP ${A}`;
    case 0x51: return `JZ  ${A}`;
    case 0x52: return `JNZ ${A}`;
    case 0x53: return `JG  ${A}`;
    case 0x54: return `JL  ${A}`;
    case 0x55: return `JGE ${A}`;
    case 0x56: return `JLE ${A}`;
    case 0x60: return `PUSH ${REG[d]}`;
    case 0x61: return `POP  ${REG[d]}`;
    case 0x70: return `CALL ${A}`;
    case 0x71: return `RET`;
    case 0x80: return `LD ${REG[d]}, [${REG[s]}]`;
    case 0x81: return `ST [${REG[d]}], ${REG[s]}`;
    default:   return `??? ${h(op)}:${h(arg)}`;
  }
}

// ─── Pre-assembled Programs ───────────────────────────────────────────────────

const PROGRAMS = {
  FIBONACCI: {
    label: 'FIBONACCI',
    desc: 'fib(0–10) written to RAM[0x2E..0x38]  →  0,1,1,2,3,5,8,13,21,34,55',
    // R0=fib[n-2], R1=fib[n-1], R2=fib[n], R3=counter, R4=max(10), R5=write ptr
    // Build R5=0x2E(46): MOVI 15 → INC(16) → ADDI 15(31) → ADDI 15(46)
    // (0x20 would overlap the 46-byte code → self-modifying corruption)
    code: [
      0x11,0x00, 0x11,0x11, 0x11,0x30, 0x11,0x4A,  // 0x00: MOVI R0,0; R1,1; R3,0; R4,10
      0x11,0x5F, 0x41,0x50, 0x21,0x5F, 0x21,0x5F,  // 0x08: R5=15→16→31→46(0x2E)
      0x81,0x50, 0x41,0x50, 0x81,0x51, 0x41,0x50,  // 0x10: ST[R5],R0; R5++; ST[R5],R1; R5++
      0x11,0x32,                                    // 0x18: MOVI R3,2
      // LOOP @ 0x1A
      0x10,0x20, 0x20,0x21, 0x10,0x01, 0x10,0x12,  // 0x1A: R2=R0; R2+=R1; R0=R1; R1=R2
      0x81,0x52, 0x41,0x50, 0x41,0x30,             // 0x22: ST[R5],R2; R5++; R3++
      0x40,0x34, 0x56,0x1A, 0x50,0x00,             // 0x28: CMP R3,R4; JLE→LOOP; JMP→restart
    ],
    initMem: {},
    dataRegion: [0x2E, 0x39],
  },

  COUNTER: {
    label: 'COUNTER',
    desc: '0→15 cycle  written sequentially to RAM[0x14..0x23]',
    // R0=counter, R1=ptr(0x14, past code), R2=max(15)
    code: [
      0x11,0x00, 0x11,0x1F, 0x21,0x15, 0x11,0x2F,  // 0x00: R0=0; R1=15+5=20(0x14); R2=15
      // LOOP @ 0x08
      0x81,0x10, 0x41,0x00, 0x41,0x10,             // 0x08: ST[R1],R0; R0++; R1++
      0x40,0x02, 0x53,0x00, 0x50,0x08,             // 0x0E: CMP R0,R2; JG→restart; JMP→loop
    ],
    initMem: {},
    dataRegion: [0x14, 0x24],
  },

  XOR_CIPHER: {
    label: 'XOR CIPHER',
    desc: 'Encrypt↔decrypt RAM[0x40..0x4F] with key=0x0A  (loops: enc→dec→enc→…)',
    // R0=key(10), R1=ptr(builds up to 64=0x40), R2=temp, R3=ctr, R4=max(15)
    code: [
      0x11,0x0A,                                    // 0x00: MOVI R0,10
      0x11,0x1F, 0x41,0x10,                         // 0x02: R1=15→16
      0x21,0x1F, 0x41,0x10,                         // 0x06: R1→31→32
      0x21,0x1F, 0x41,0x10,                         // 0x0A: R1→47→48
      0x21,0x1F, 0x41,0x10,                         // 0x0E: R1→63→64 = 0x40
      0x11,0x30, 0x11,0x4F,                         // 0x12: R3=0; R4=15
      // LOOP @ 0x16
      0x80,0x21, 0x32,0x20, 0x81,0x12,             // 0x16: R2=MEM[R1]; R2^=R0; MEM[R1]=R2
      0x41,0x10, 0x41,0x30,                         // 0x1C: R1++; R3++
      0x40,0x34, 0x56,0x16, 0x50,0x00,             // 0x20: CMP R3,R4; JLE→loop; JMP→restart
    ],
    initMem: {
      0x40:0xDE, 0x41:0xAD, 0x42:0xBE, 0x43:0xEF,
      0x44:0xCA, 0x45:0xFE, 0x46:0xBA, 0x47:0xBE,
      0x48:0x13, 0x49:0x37, 0x4A:0xAA, 0x4B:0x55,
      0x4C:0x0F, 0x4D:0xF0, 0x4E:0x69, 0x4F:0x42,
    },
    dataRegion: [0x40, 0x50],
  },
};

// ─── VM Engine ────────────────────────────────────────────────────────────────

function makeVM(progName) {
  const prog = PROGRAMS[progName];
  const memory = new Uint8Array(256);
  prog.code.forEach((b,i) => { memory[i] = b; });
  Object.entries(prog.initMem).forEach(([k,v]) => { memory[parseInt(k)] = v; });
  return {
    memory, regs: new Uint8Array(8),
    pc: 0, sp: 0xFF,
    flags: { z:false, neg:false, gt:false },
    halted: false, ticks: 0, log: [], changed: new Set(),
  };
}

function stepOnce(s) {
  if (s.halted) return s;
  const mem = new Uint8Array(s.memory);
  const regs = new Uint8Array(s.regs);
  const fl = { ...s.flags };
  const changed = new Set();
  let { pc, sp } = s;
  let halted = false;

  const op = mem[pc], arg = mem[(pc+1)&0xFF];
  const d=(arg>>4)&0xF, sv=arg&0xF;
  const decoded = decode(op, arg);
  const lastPc = pc;
  pc = (pc+2)&0xFF;

  switch(op){
    case 0x00: break;
    case 0x01: halted=true; break;
    case 0x10: regs[d]=regs[sv]; break;
    case 0x11: regs[d]=sv; break;
    case 0x20: regs[d]=(regs[d]+regs[sv])&0xFF; break;
    case 0x21: regs[d]=(regs[d]+sv)&0xFF; break;
    case 0x22: regs[d]=(regs[d]-regs[sv]+256)&0xFF; break;
    case 0x23: regs[d]=(regs[d]-sv+256)&0xFF; break;
    case 0x30: regs[d]=(regs[d]&regs[sv])&0xFF; break;
    case 0x31: regs[d]=(regs[d]|regs[sv])&0xFF; break;
    case 0x32: regs[d]=(regs[d]^regs[sv])&0xFF; break;
    case 0x33: regs[d]=(~regs[d])&0xFF; break;
    case 0x40: { const a=regs[d],b=regs[sv]; fl.z=a===b; fl.neg=a<b; fl.gt=a>b; break; }
    case 0x41: regs[d]=(regs[d]+1)&0xFF; break;
    case 0x42: regs[d]=(regs[d]-1+256)&0xFF; break;
    case 0x50: pc=arg; break;
    case 0x51: if(fl.z) pc=arg; break;
    case 0x52: if(!fl.z) pc=arg; break;
    case 0x53: if(fl.gt) pc=arg; break;
    case 0x54: if(fl.neg) pc=arg; break;
    case 0x55: if(!fl.neg) pc=arg; break;
    case 0x56: if(!fl.gt) pc=arg; break;
    case 0x60: mem[sp]=regs[d]; changed.add(sp); sp=(sp-1+256)&0xFF; break;
    case 0x61: sp=(sp+1)&0xFF; regs[d]=mem[sp]; break;
    case 0x70: mem[sp]=pc&0xFF; changed.add(sp); sp=(sp-1+256)&0xFF; pc=arg; break;
    case 0x71: sp=(sp+1)&0xFF; pc=mem[sp]; break;
    case 0x80: regs[d]=mem[regs[sv]]; break;
    case 0x81: { const a=regs[d]; mem[a]=regs[sv]; changed.add(a); break; }
    default: break;
  }

  const log = [{pc:lastPc, decoded}, ...(s.log.slice(0,11))];
  return { memory:mem, regs, pc, sp, flags:fl, halted, ticks:s.ticks+1, log, changed };
}

function stepN(s, n) {
  let cur = s;
  const allChanged = new Set();
  for (let i=0; i<n; i++) {
    if (cur.halted) break;
    cur = stepOnce(cur);
    cur.changed.forEach(a => allChanged.add(a));
  }
  return { ...cur, changed: allChanged };
}

// ─── UI ───────────────────────────────────────────────────────────────────────

const SPEEDS = {
  SLOW:  { ms:480, n:1  },
  NORM:  { ms:110, n:1  },
  FAST:  { ms:35,  n:1  },
  TURBO: { ms:40,  n:6  },
};

const C = {
  bg: '#040c04', fg: '#1aee44', bright: '#00ff41', dim: '#0a1c0a',
  pc: '#00ff41', pcBg: 'rgba(0,255,65,0.15)', pcGlow: '0 0 8px rgba(0,255,65,0.7)',
  pcArg: '#00bb2e', pcArgBg: 'rgba(0,187,46,0.07)',
  sp: '#ff6600', spBg: 'rgba(255,102,0,0.12)', spGlow: '0 0 5px rgba(255,102,0,0.5)',
  flash: '#ffffff', flashBg: 'rgba(255,255,255,0.13)', flashGlow: '0 0 8px rgba(255,255,255,0.6)',
  amber: '#ffaa00', border: '#0a1c0a', muted: '#0a2a0a',
};

function cellColor(val, isPC, isPCa, isSP, isFl) {
  if (isFl)  return { color:C.flash, bg:C.flashBg, shadow:C.flashGlow };
  if (isPC)  return { color:C.pc,    bg:C.pcBg,    shadow:C.pcGlow    };
  if (isPCa) return { color:C.pcArg, bg:C.pcArgBg, shadow:'none'      };
  if (isSP)  return { color:C.sp,    bg:C.spBg,    shadow:C.spGlow    };
  if (val===0) return { color:C.dim,  bg:'transparent', shadow:'none' };
  const opacity = Math.min(1, val/255*0.82+0.18);
  return { color:`rgba(20,${Math.min(255,val+35)},20,${opacity.toFixed(2)})`, bg:'transparent', shadow:'none' };
}

function Btn({ onClick, active, disabled, children }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background:'none',
      border:`1px solid ${disabled?'#0a1c0a':active?C.bright:'#1a4a1a'}`,
      cursor: disabled?'not-allowed':'pointer',
      fontSize:'10px', fontFamily:'inherit', padding:'2px 9px',
      color: disabled?'#0a1c0a':active?C.bright:'#1a4a1a',
      letterSpacing:'1px', transition:'all 0.1s',
    }}>{children}</button>
  );
}

export default function EMLVM16() {
  const [progName, setProgName] = useState('FIBONACCI');
  const [vm, setVM] = useState(() => makeVM('FIBONACCI'));
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState('NORM');
  const [flash, setFlash] = useState(new Set());

  // Auto-step
  useEffect(() => {
    if (!running) return;
    const { ms, n } = SPEEDS[speed];
    const id = setInterval(() => {
      setVM(prev => {
        if (prev.halted) { setRunning(false); return prev; }
        return stepN(prev, n);
      });
    }, ms);
    return () => clearInterval(id);
  }, [running, speed]);

  // Flash management
  useEffect(() => {
    if (!vm.changed.size) return;
    setFlash(vm.changed);
    const id = setTimeout(() => setFlash(new Set()), 260);
    return () => clearTimeout(id);
  }, [vm.ticks]);

  const pcAddr = vm.pc;
  const pcArgAddr = (vm.pc + 1) & 0xFF;
  const op = vm.memory[pcAddr];
  const arg = vm.memory[pcArgAddr];
  const prog = PROGRAMS[progName];

  function loadProg(name) {
    setProgName(name);
    setRunning(false);
    setFlash(new Set());
    setVM(makeVM(name));
  }

  return (
    <div style={{
      background:C.bg, minHeight:'100vh', color:C.fg,
      fontFamily:'"Courier New",Courier,monospace',
      padding:'12px 14px', boxSizing:'border-box', overflowX:'auto',
      position:'relative',
    }}>

      {/* CRT overlay */}
      <div style={{
        position:'fixed', inset:0, pointerEvents:'none', zIndex:20,
        background:'repeating-linear-gradient(to bottom,transparent 0,transparent 1px,rgba(0,0,0,0.1) 1px,rgba(0,0,0,0.1) 2px)',
      }}/>
      <div style={{
        position:'fixed', inset:0, pointerEvents:'none', zIndex:19,
        background:'radial-gradient(ellipse at 50% 40%, transparent 55%, rgba(0,0,0,0.45) 100%)',
      }}/>

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div style={{ display:'flex', flexWrap:'wrap', gap:'6px', alignItems:'center', marginBottom:'10px', position:'relative', zIndex:1 }}>
        <span style={{ color:C.bright, fontSize:'13px', letterSpacing:'2px', textShadow:'0 0 10px rgba(0,255,65,0.5)', marginRight:'4px' }}>
          ▸ EML-VM-16
        </span>
        <span style={{ color:C.border }}>│</span>

        {/* Program tabs */}
        {Object.keys(PROGRAMS).map(p => (
          <button key={p} onClick={()=>loadProg(p)} style={{
            background:'none', border:'none', cursor:'pointer',
            fontSize:'10px', fontFamily:'inherit', padding:'2px 6px',
            color: progName===p ? C.bright : '#1a3a1a',
            borderBottom: progName===p ? `1px solid ${C.bright}` : '1px solid transparent',
            textShadow: progName===p ? `0 0 5px rgba(0,255,65,0.4)` : 'none',
          }}>{PROGRAMS[p].label}</button>
        ))}

        <span style={{ color:C.border }}>│</span>
        <Btn onClick={()=>setVM(s=>stepOnce(s))} disabled={vm.halted||running}>STEP</Btn>
        <Btn onClick={()=>running?setRunning(false):setRunning(true)} disabled={vm.halted} active={running}>
          {running?'■ HALT':'▶ RUN'}
        </Btn>
        <Btn onClick={()=>loadProg(progName)}>↺ RST</Btn>

        <span style={{ color:C.border }}>│</span>
        {Object.keys(SPEEDS).map(s=>(
          <button key={s} onClick={()=>setSpeed(s)} style={{
            background:'none', border:'none', cursor:'pointer',
            fontSize:'9px', fontFamily:'inherit',
            color: speed===s ? C.bright : '#1a3a1a',
            textShadow: speed===s ? `0 0 5px rgba(0,255,65,0.4)` : 'none',
          }}>{speed===s?'◉':'○'} {s}</button>
        ))}
      </div>

      {/* ── Main layout ───────────────────────────────────────────────────── */}
      <div style={{ display:'flex', gap:'16px', alignItems:'flex-start', flexWrap:'wrap', position:'relative', zIndex:1 }}>

        {/* ── Memory Grid (16×16 = 256 bytes) ────────────────────────────── */}
        <div style={{ flexShrink:0 }}>
          <div style={{ color:C.muted, fontSize:'8.5px', letterSpacing:'1px', marginBottom:'3px' }}>
            MEMORY  0x00–0xFF  [256 BYTES]
          </div>

          {/* Column headers */}
          <div style={{ display:'flex', marginLeft:'28px', marginBottom:'1px' }}>
            {Array.from({length:16},(_,c)=>(
              <span key={c} style={{ width:'24px', textAlign:'center', fontSize:'7.5px', color:'#0a1e0a' }}>
                _{h(c)[1]}
              </span>
            ))}
          </div>

          {/* Rows */}
          {Array.from({length:16},(_,row)=>(
            <div key={row} style={{ display:'flex', alignItems:'center', marginBottom:'1px' }}>
              <span style={{ width:'26px', fontSize:'7.5px', color:'#0a1e0a', flexShrink:0 }}>
                {h(row)}x
              </span>
              {Array.from({length:16},(_,col)=>{
                const addr = row*16+col;
                const val = vm.memory[addr];
                const isPC  = addr===pcAddr;
                const isPCa = addr===pcArgAddr;
                const isSP  = addr===vm.sp;
                const isFl  = flash.has(addr);
                const { color, bg, shadow } = cellColor(val,isPC,isPCa,isSP,isFl);
                return (
                  <span key={col}
                    title={`[0x${h(addr)}]  hex:${h(val)}  dec:${val}  bin:${bin8(val)}`}
                    style={{
                      width:'24px', textAlign:'center', fontSize:'10px', lineHeight:'15px',
                      display:'inline-block', color, background:bg, textShadow:shadow,
                      borderRadius:'1px',
                    }}>
                    {h(val)}
                  </span>
                );
              })}
            </div>
          ))}

          {/* Grid legend */}
          <div style={{ marginTop:'6px', display:'flex', gap:'10px', fontSize:'8px' }}>
            <span style={{ color:C.pc }}>■ PC</span>
            <span style={{ color:C.pcArg }}>■ ARG</span>
            <span style={{ color:C.sp }}>■ SP</span>
            <span style={{ color:C.flash }}>■ WRITE</span>
            <span style={{ color:'#0a3a0a' }}>■ ZERO</span>
          </div>
        </div>

        {/* ── Right Panel ─────────────────────────────────────────────────── */}
        <div style={{ flex:'1 1 200px', maxWidth:'300px', minWidth:'180px' }}>

          {/* Registers */}
          <div style={{ marginBottom:'12px' }}>
            <div style={{ color:C.muted, fontSize:'8.5px', letterSpacing:'1px', borderBottom:`1px solid ${C.border}`, paddingBottom:'2px', marginBottom:'5px' }}>
              REGISTERS
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'2px 6px' }}>
              {[...Array(8)].map((_,i)=>(
                <div key={i} style={{ fontSize:'10.5px' }}>
                  <span style={{ color:'#1a4a1a' }}>{REG[i]}: </span>
                  <span style={{ color:C.fg }}>0x{h(vm.regs[i])}</span>
                  <span style={{ color:'#0a2a0a', fontSize:'8px', marginLeft:'3px' }}>({vm.regs[i]})</span>
                </div>
              ))}
            </div>
            <div style={{ marginTop:'5px', fontSize:'10px', display:'flex', gap:'8px', flexWrap:'wrap' }}>
              <span>
                <span style={{ color:'#1a4a1a' }}>PC </span>
                <span style={{ color:C.pc, textShadow:'0 0 4px rgba(0,255,65,0.5)' }}>0x{h(vm.pc)}</span>
              </span>
              <span>
                <span style={{ color:'#1a4a1a' }}>SP </span>
                <span style={{ color:C.sp }}>0x{h(vm.sp)}</span>
              </span>
              <span style={{ color:'#1a3a1a', fontSize:'9px' }}>
                Z={vm.flags.z?'1':'0'} N={vm.flags.neg?'1':'0'} G={vm.flags.gt?'1':'0'}
              </span>
            </div>
          </div>

          {/* Current Instruction */}
          <div style={{ marginBottom:'12px' }}>
            <div style={{ color:C.muted, fontSize:'8.5px', letterSpacing:'1px', borderBottom:`1px solid ${C.border}`, paddingBottom:'2px', marginBottom:'5px' }}>
              NEXT  @  0x{h(vm.pc)}
            </div>
            <div style={{ fontSize:'12.5px', color:C.bright, marginBottom:'6px', textShadow:'0 0 5px rgba(0,255,65,0.35)', letterSpacing:'0.5px' }}>
              {decode(op, arg)}
            </div>

            {/* Two instruction bytes as bit grids */}
            <div style={{ display:'flex', gap:'12px' }}>
              {[op, arg].map((byte, bi)=>(
                <div key={bi}>
                  <div style={{ fontSize:'9px', color:C.muted, textAlign:'center', marginBottom:'3px' }}>
                    {h(byte)}  <span style={{ color:'#0a1c0a' }}>({bi===0?'opcode':'arg'})</span>
                  </div>
                  <div style={{ display:'flex', gap:'1.5px' }}>
                    {[...Array(8)].map((_,b)=>{
                      const bit=(byte>>(7-b))&1;
                      return (
                        <span key={b} style={{
                          display:'inline-block', width:'11px', height:'11px',
                          background: bit ? C.bright : '#0a1c0a',
                          borderRadius:'1px',
                          boxShadow: bit ? '0 0 4px rgba(0,255,65,0.45)' : 'none',
                          marginRight: b===3?'3px':'0',
                        }}/>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Execution Log */}
          <div>
            <div style={{ color:C.muted, fontSize:'8.5px', letterSpacing:'1px', borderBottom:`1px solid ${C.border}`, paddingBottom:'2px', marginBottom:'4px' }}>
              EXECUTION LOG
            </div>
            {vm.log.length===0 ? (
              <div style={{ fontSize:'9px', color:C.dim }}>— awaiting execution —</div>
            ) : vm.log.map((e,i)=>{
              const alpha = Math.max(0.15, 1 - i*0.09);
              const grn   = Math.max(80, 238 - i*18);
              return (
                <div key={i} style={{
                  fontSize:'9.5px', marginBottom:'2px',
                  color: i===0 ? C.fg : `rgba(20,${grn},20,${alpha})`,
                  display:'flex', gap:'5px',
                }}>
                  <span style={{ color: i===0?'#00cc33':'#142514', flexShrink:0 }}>
                    {h(e.pc)}:
                  </span>
                  <span>{e.decoded}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Status Bar ────────────────────────────────────────────────────── */}
      <div style={{
        marginTop:'12px', borderTop:`1px solid ${C.border}`, paddingTop:'5px',
        display:'flex', gap:'14px', fontSize:'9px', color:C.muted,
        flexWrap:'wrap', position:'relative', zIndex:1,
      }}>
        <span>T: {vm.ticks.toLocaleString()}</span>
        <span style={{ color:'#0a1e0a' }}>│</span>
        <span>{prog.desc}</span>
        <span style={{ color:'#0a1e0a' }}>│</span>
        <span style={{ color: vm.halted?'#ff4444':running?C.bright:'#1a4a1a' }}>
          {vm.halted ? '■ HALTED' : running ? `● ${speed}` : '○ PAUSED'}
        </span>
        <span style={{ color:'#0a1e0a' }}>│</span>
        <span>ISA: EML-VM-16  ·  256B RAM  ·  {prog.code.length}B PROG</span>
      </div>
    </div>
  );
}
