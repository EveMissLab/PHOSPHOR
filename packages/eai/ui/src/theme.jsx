import { useState, useEffect, useRef } from 'react';

// Shared CRT theme + brand — one source of truth, now theme-switchable.
//
// `C.xxx` values are CSS custom-property references (`var(--p-xxx)`), NOT literal
// colors. Every existing component already reads colors through `C` (or through
// `theme.jsx` helpers), so repointing these tokens at CSS variables makes the
// whole app theme-reactive with zero changes to the ~200 call sites that use
// them — only the palette DEFINITIONS live here. `ThemeStyles` renders the
// `:root[data-phosphor-theme="…"]` variable blocks once; `ThemeSwitcher` flips
// the `data-phosphor-theme` attribute (and persists the choice).
//
// Known limit, stated rather than silently incomplete: components that hardcode
// a literal hex color inline (a per-widget accent tweak, not read through `C`)
// do NOT reskin — only the shared token surface does. Untangling every such
// literal is a separate follow-up, not implied by this pass.
export const VERSION = '0.8.0-beta.0';

const VAR = {
  bg: '--p-bg', fg: '--p-fg', bright: '--p-bright', dim: '--p-dim', muted: '--p-muted',
  amber: '--p-amber', sp: '--p-sp', border: '--p-border',
  ai: '--p-ai', aiDim: '--p-ai-dim', sem: '--p-sem', semDim: '--p-sem-dim',
  ok: '--p-ok', okBg: '--p-ok-bg', no: '--p-no', noBg: '--p-no-bg', inx: '--p-inx', inxBg: '--p-inx-bg',
  scanAlpha: '--p-scan-alpha', vignetteAlpha: '--p-vignette-alpha',
};

/** Every color/opacity token a palette must define. */
const TOKEN_KEYS = Object.keys(VAR);

// ═══════════════════════════════════════════════════════════════════════════════
// § Palettes — the original phosphor-green identity + 5 elegant alternates
// ═══════════════════════════════════════════════════════════════════════════════

export const PALETTES = {
  phosphor: {
    label: 'PHOSPHOR · original', isLight: false,
    tokens: {
      bg: '#040c04', fg: '#1aee44', bright: '#00ff41', dim: '#0a1c0a', muted: '#0a2a0a',
      amber: '#ffaa00', sp: '#ff6600', border: '#0a1c0a',
      ai: '#00d2ff', aiDim: '#0a2230', sem: '#5af0c8', semDim: '#13312a',
      ok: '#00ff41', okBg: 'rgba(0,255,65,0.10)', no: '#ff5a5a', noBg: 'rgba(255,90,90,0.09)',
      inx: '#ffaa00', inxBg: 'rgba(255,170,0,0.09)',
      scanAlpha: '0.1', vignetteAlpha: '0.45',
    },
  },
  abyss: {
    label: '深邃 · abyss', isLight: false,
    tokens: {
      bg: '#050810', fg: '#7fa8c9', bright: '#bfe3ff', dim: '#0a1220', muted: '#16233a',
      amber: '#c9a86a', sp: '#7a5cff', border: '#111c30',
      ai: '#5ad1ff', aiDim: '#0d2233', sem: '#8fe3c0', semDim: '#132a24',
      ok: '#5ad1ff', okBg: 'rgba(90,209,255,0.10)', no: '#ff6b81', noBg: 'rgba(255,107,129,0.09)',
      inx: '#c9a86a', inxBg: 'rgba(201,168,106,0.09)',
      scanAlpha: '0.12', vignetteAlpha: '0.55',
    },
  },
  inkGold: {
    label: '墨金 · ink-gold', isLight: false,
    tokens: {
      bg: '#0b0906', fg: '#c9a24a', bright: '#f0c869', dim: '#1a1610', muted: '#3a3020',
      amber: '#f0c869', sp: '#e0663a', border: '#1e1811',
      ai: '#7fd4c9', aiDim: '#12241f', sem: '#7fd4c9', semDim: '#12241f',
      ok: '#f0c869', okBg: 'rgba(240,200,105,0.10)', no: '#ff6b52', noBg: 'rgba(255,107,82,0.09)',
      inx: '#e0663a', inxBg: 'rgba(224,102,58,0.09)',
      scanAlpha: '0.08', vignetteAlpha: '0.4',
    },
  },
  cream: {
    label: '米白 · cream', isLight: true,
    tokens: {
      bg: '#f5f0e6', fg: '#3a3226', bright: '#8a5a2b', dim: '#e8e0d0', muted: '#a89878',
      amber: '#b5651d', sp: '#a83232', border: '#d8cdb8',
      ai: '#2a6f6b', aiDim: '#dce8e4', sem: '#3f7a45', semDim: '#e2ecdf',
      ok: '#3a7a3a', okBg: 'rgba(58,122,58,0.10)', no: '#b3392c', noBg: 'rgba(179,57,44,0.08)',
      inx: '#b5651d', inxBg: 'rgba(181,101,29,0.08)',
      scanAlpha: '0.035', vignetteAlpha: '0.12',
    },
  },
  crimson: {
    label: '赤紅 · crimson', isLight: false,
    tokens: {
      bg: '#0c0405', fg: '#e0435a', bright: '#ff3355', dim: '#1c0a0d', muted: '#3a1418',
      amber: '#ffb020', sp: '#ff8a00', border: '#241014',
      ai: '#4fd1e8', aiDim: '#0d2226', sem: '#e88fb0', semDim: '#2a1420',
      ok: '#ff3355', okBg: 'rgba(255,51,85,0.10)', no: '#ff5a5a', noBg: 'rgba(255,90,90,0.09)',
      inx: '#ffb020', inxBg: 'rgba(255,176,32,0.09)',
      scanAlpha: '0.1', vignetteAlpha: '0.48',
    },
  },
  oceanBlue: {
    label: '冷藍海洋 · cool ocean', isLight: false,
    tokens: {
      bg: '#020c14', fg: '#3fb8e0', bright: '#6fe0ff', dim: '#08202e', muted: '#123344',
      amber: '#ffb454', sp: '#ff7a45', border: '#0d2938',
      ai: '#6fe0ff', aiDim: '#0d2938', sem: '#5ff2c8', semDim: '#0f2e28',
      ok: '#3fe0a0', okBg: 'rgba(63,224,160,0.10)', no: '#ff6b6b', noBg: 'rgba(255,107,107,0.09)',
      inx: '#ffb454', inxBg: 'rgba(255,180,84,0.09)',
      scanAlpha: '0.1', vignetteAlpha: '0.42',
    },
  },
};

export const THEME_IDS = Object.keys(PALETTES);
export const DEFAULT_THEME = 'phosphor';
const STORAGE_KEY = 'phosphor-ui-theme';

/** The live token object every component reads — each value a `var(--p-…)` reference, not a literal. */
export const C = Object.fromEntries(TOKEN_KEYS.map(k => [k, `var(${VAR[k]})`]));

/** Wrap a `C` color reference for use at partial opacity — `var()` can't take a hex-alpha suffix, so build the color with `color-mix()` instead. */
export function alpha(colorVarRef, pct) {
  return `color-mix(in srgb, ${colorVarRef} ${pct}%, transparent)`;
}

/** A dimmer variant of a `C` color reference (mixed toward black) — for a secondary shade of an accent that has no token of its own. */
export function darken(colorVarRef, pct) {
  return `color-mix(in srgb, ${colorVarRef} ${pct}%, black)`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// § Theme persistence + application
// ═══════════════════════════════════════════════════════════════════════════════

export function getStoredTheme() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v && PALETTES[v] ? v : DEFAULT_THEME;
  } catch { return DEFAULT_THEME; }
}

export function applyTheme(id) {
  const theme = PALETTES[id] ? id : DEFAULT_THEME;
  document.documentElement.dataset.phosphorTheme = theme;
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* best-effort */ }
}

function paletteCssBlock(id, tokens) {
  const decls = TOKEN_KEYS.map(k => `${VAR[k]}: ${tokens[k]};`).join(' ');
  return `:root[data-phosphor-theme="${id}"] { ${decls} }`;
}

/** Renders the `:root[data-phosphor-theme]` variable blocks for every palette, once, at the app root. A bare `:root` fallback carries the default palette so colors are correct even before `applyTheme` runs. */
export function ThemeStyles() {
  const css = [
    `:root { ${TOKEN_KEYS.map(k => `${VAR[k]}: ${PALETTES[DEFAULT_THEME].tokens[k]};`).join(' ')} }`,
    ...Object.entries(PALETTES).map(([id, p]) => paletteCssBlock(id, p.tokens)),
  ].join('\n');
  // eslint-disable-next-line react/no-danger
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}

// ═══════════════════════════════════════════════════════════════════════════════
// § Theme switcher UI
// ═══════════════════════════════════════════════════════════════════════════════

export function ThemeSwitcher() {
  const [current, setCurrent] = useState(DEFAULT_THEME);
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    const stored = getStoredTheme();
    setCurrent(stored);
    applyTheme(stored);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  function pick(id) { setCurrent(id); applyTheme(id); setOpen(false); }

  return (
    <div ref={boxRef} style={{ position: 'relative', marginLeft: '6px' }}>
      <button onClick={() => setOpen(o => !o)} title="theme" style={{
        background: 'none', cursor: 'pointer', border: `1px solid ${C.dim}`, color: C.fg,
        fontSize: '9px', fontFamily: 'inherit', padding: '3px 8px', letterSpacing: '1px', borderRadius: '2px',
      }}>◧ {PALETTES[current].label.split(' · ')[0]}</button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, marginTop: '4px', zIndex: 50,
          background: C.bg, border: `1px solid ${C.border}`, borderRadius: '3px', padding: '5px',
          display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '150px',
          boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
        }}>
          {THEME_IDS.map(id => (
            <button key={id} onClick={() => pick(id)} style={{
              background: id === current ? alpha(C.fg, 12) : 'none',
              border: 'none', cursor: 'pointer', textAlign: 'left',
              color: id === current ? C.bright : C.fg,
              fontSize: '10px', fontFamily: 'inherit', padding: '4px 8px', borderRadius: '2px',
              display: 'flex', alignItems: 'center', gap: '6px', letterSpacing: '0.5px',
            }}>
              <span style={{
                width: '9px', height: '9px', borderRadius: '50%', flexShrink: 0,
                background: PALETTES[id].tokens.bright, border: `1px solid ${PALETTES[id].tokens.border}`,
              }} />
              {PALETTES[id].label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════

export const mono = '"Courier New",Courier,monospace';

export const panelHead = {
  color: C.muted, fontSize: '8.5px', letterSpacing: '1px',
  borderBottom: `1px solid ${C.border}`, paddingBottom: '2px', marginBottom: '6px',
};

// The two fixed full-viewport CRT overlays (scanline + vignette). Opacity comes
// from the active palette's --p-scan-alpha/--p-vignette-alpha (the cream theme
// dials both down — a light background doesn't want a black vignette at the same
// strength a dark one does).
export function CrtOverlays() {
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 20,
        background: `repeating-linear-gradient(to bottom,transparent 0,transparent 1px,rgba(0,0,0,var(${VAR.scanAlpha})) 1px,rgba(0,0,0,var(${VAR.scanAlpha})) 2px)` }} />
      <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 19,
        background: `radial-gradient(ellipse at 50% 40%, transparent 55%, rgba(0,0,0,var(${VAR.vignetteAlpha})) 100%)` }} />
    </>
  );
}

// Page wrapper used by the v2 tabs — CRT background + overlays + content layer.
export function Screen({ children }) {
  return (
    <div style={{
      background: C.bg, minHeight: 'calc(100vh - 34px)', color: C.fg,
      fontFamily: mono, padding: '12px 14px', position: 'relative', overflowX: 'auto',
    }}>
      <CrtOverlays />
      <div style={{ position: 'relative', zIndex: 1 }}>{children}</div>
    </div>
  );
}

export function TabTitle({ accent, title, sub }) {
  return (
    <div style={{ marginBottom: '10px' }}>
      <span style={{ color: accent, fontSize: '13px', letterSpacing: '2px', textShadow: `0 0 10px ${alpha(accent, 50)}` }}>
        ▸ {title}
      </span>
      {sub && <span style={{ color: C.muted, fontSize: '9px', marginLeft: '10px', letterSpacing: '0.5px' }}>{sub}</span>}
    </div>
  );
}

// Brand + version + formal attribution — shown under every tab.
export function BrandFooter() {
  return (
    <div style={{
      borderTop: `1px solid ${C.border}`, marginTop: '4px', padding: '7px 16px',
      display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'center',
      fontSize: '8.5px', color: C.muted, fontFamily: mono, position: 'relative', zIndex: 1, background: C.bg,
    }}>
      <span style={{ color: C.dim, letterSpacing: '1px' }}>
        PHOSPHOR <span style={{ color: C.fg }}>v{VERSION}</span> · <span style={{ color: C.amber }}>EXPERIMENTAL</span>
      </span>
      <span style={{ color: C.border }}>│</span>
      <span>© 2026 <span style={{ color: C.dim }}>EVEMISS TECHNOLOGY CO., LTD.</span>（一言諾科技有限公司）</span>
      <span style={{ color: C.border }}>│</span>
      <span>Author <span style={{ color: C.dim }}>許筌崴 Neo.K</span></span>
      <span style={{ color: C.border }}>│</span>
      <span>Apache-2.0</span>
    </div>
  );
}

// A bordered hex byte field with optional accent — reused across tabs.
export function parseBytes(text) {
  return text
    .split(/[\s,]+/).map(t => t.trim()).filter(Boolean)
    .map(t => parseInt(t.replace(/^0x/i, ''), 16))
    .filter(n => Number.isFinite(n))
    .map(n => n & 0xFF);
}
