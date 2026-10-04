import { useState } from 'react';
import PhosphorVM from './PhosphorVM.jsx';
import VM64View from './VM64View.jsx';
import WasmView from './WasmView.jsx';
import FlagshipView from './FlagshipView.jsx';
import PetZone from './PetZone.jsx';
import EquivLab from './EquivLab.jsx';
import CtsInspector from './CtsInspector.jsx';
import EmlInterop from './EmlInterop.jsx';
import AgentStream from './AgentStream.jsx';
import SheetWorkbench from './SheetWorkbench.jsx';
// binary-matrix lives in the parent folder; imported directly (no copy).
import BinaryMatrix from '../../binary-matrix.jsx';
import { C, VERSION, BrandFooter, ThemeStyles, ThemeSwitcher, alpha, mono } from './theme.jsx';

const TABS = [
  { id: 'vm',     label: '▸ EML-VM-16', el: <PhosphorVM /> },
  { id: 'vm64',   label: '▸ EML-VM-64', el: <VM64View /> },
  { id: 'wasm',   label: '▸ WASM',      el: <WasmView /> },
  { id: 'flagship', label: '▸ FLAGSHIP', el: <FlagshipView /> },
  { id: 'equiv',  label: '▸ SEMANTIC ≡', el: <EquivLab /> },
  { id: 'cts',    label: '▸ CTS',       el: <CtsInspector /> },
  { id: 'eml',    label: '▸ EML',       el: <EmlInterop /> },
  { id: 'agent',  label: '▸ AGENT',     el: <AgentStream /> },
  { id: 'sheet',  label: '▸ SHEET',     el: <SheetWorkbench /> },
  { id: 'matrix', label: '▸ MATRIX',    el: <BinaryMatrix /> },
  { id: 'pet',    label: '▸ PET',       el: <PetZone /> },
];

export default function App() {
  const [view, setView] = useState('vm');
  const active = TABS.find(t => t.id === view) ?? TABS[0];
  return (
    <>
      <ThemeStyles />
      <div style={{ minHeight: '100vh', background: C.bg, fontFamily: mono, display: 'flex', flexDirection: 'column' }}>
        <div style={{
          display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap',
          padding: '6px 14px', borderBottom: `1px solid ${C.dim}`,
          position: 'sticky', top: 0, zIndex: 30, background: C.bg,
        }}>
          <span style={{ color: C.bright, fontSize: '11px', letterSpacing: '2px', marginRight: '4px', textShadow: `0 0 8px ${alpha(C.bright, 50)}` }}>
            PHOSPHOR
          </span>
          <span style={{ color: C.dim, fontSize: '8px', letterSpacing: '0.5px', marginRight: '8px' }}>
            v{VERSION} · <span style={{ color: C.amber }}>EXPERIMENTAL</span>
          </span>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setView(t.id)} style={{
              background: 'none', cursor: 'pointer',
              border: `1px solid ${view === t.id ? C.bright : C.dim}`,
              color: view === t.id ? C.bright : C.dim,
              fontSize: '10px', fontFamily: 'inherit', padding: '3px 9px', letterSpacing: '1px', borderRadius: '2px',
              textShadow: view === t.id ? `0 0 5px ${alpha(C.bright, 40)}` : 'none',
            }}>{t.label}</button>
          ))}
          <span style={{ marginLeft: 'auto', color: C.muted, fontSize: '8px', letterSpacing: '1px' }}>
            Φ : M × CTS → V · 可見即可視
          </span>
          <ThemeSwitcher />
        </div>

        <div style={{ flex: 1 }}>{active.el}</div>
        <BrandFooter />
      </div>
    </>
  );
}
