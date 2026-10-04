import { useRef, useState, lazy, Suspense } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(useGSAP, ScrollTrigger);

type Lang = 'en' | 'zh';
const GITHUB = 'https://github.com/EveMissLab/PHOSPHOR';
const SRC_ZIP = '/download/phosphor-preview-source.zip';

// Live playground: the actual 11-tab PHOSPHOR app, aliased from the repo root.
const Playground = lazy(() => import('@phosphor/ui/src/App.jsx'));

const t = {
  en: {
    nav: { thesis: 'Thesis', vms: 'VM Family', semantic: 'Semantic', play: 'Playground', open: 'Open Source', mccp: 'MCCP' },
    mccpWip: 'WIP',
    tag: 'Execution-as-Interface',
    h1a: 'Visible', h1b: 'Visualizable',
    lead: "A VM's execution, paired with a complete Correspondence Table System, is at once a human-readable visualization and an AI-parseable event stream — not two representations of one object, but the same object viewed two ways.",
    play: 'Open Playground', github: 'GitHub', zip: 'Download source .zip',
    badge: 'v0.8.0-beta · EXPERIMENTAL',
    proof: '272 EAI checks · three independent packages · Apache-2.0',
    aiLayer: '/ai/ — for agents & models',
    agentFirst: 'Built for agents — the source and the phosphor-jsonl-v1 stream are the product. The CRT UI and the .exe just let a human see the principle.',
    forAgents: 'for agents', forHumans: 'for humans', seeItRun: 'See it run',
    s1: { n: '01', k: 'Thesis', h: 'Two users. One state machine.',
      p: 'Traditional debuggers read a program’s shadow. PHOSPHOR shares one state machine M with the visualization — no observer, only execution.',
      human: 'HUMAN MODE', humanD: 'A phosphor-green CRT you watch run — the observation window.',
      ai: 'AI MODE', aiD: 'A headless phosphor-jsonl-v1 event stream an agent subscribes to and reasons over.' },
    s2: { n: '02', k: 'VM Family', h: 'One CTS. A family of machines.',
      p: 'Every profile shares the 6-layer Correspondence Table System and the functional, immutable step engine.' },
    s3: { n: '03', k: 'Semantic Layer', h: 'Does code MEAN the same thing?',
      p: 'v0.5 maps each instruction to its state-transition meaning, and judges whether two byte sequences are semantically equivalent — by running both and comparing observable output.',
      d1: 'describeEffect', d1d: 'machine code → state transition (reads / writes / flags / control)',
      d2: 'semanticEquiv', d2d: 'three-valued verdict + adversarial inputs; single-input is an exhaustive proof',
      eq: 'A ≡ B', eqd: 'different bytes — same meaning' },
    s4: { n: '04', k: 'Playground', h: 'The whole thing, live.',
      p: 'Eleven tabs of the real engine in your browser: VM, WASM, the optimization flagship, CTS, JSONL, spreadsheet, and more.' },
    s5: { n: '05', k: 'EML Interop', h: 'The EML → PHOSPHOR loop, wired.',
      p: 'The sibling project EML emits the same phosphor-jsonl-v1 envelope. PHOSPHOR consumes its execution traces and bridges its source-level CTS into machine-CTS views.' },
    s6: { n: '06', k: 'Open Source', h: 'Read it. Run it. Fork it.',
      p: 'Dependency-light TypeScript, Apache-2.0. A double-click EXE, a headless CLI, and a portable event-stream standard.',
      st1: 'EAI checks', st2: 'packages', st3: 'EAI harnesses' },
  },
  zh: {
    nav: { thesis: '命題', vms: 'VM 家族', semantic: '語意層', play: '互動場', open: '開源', mccp: 'MCCP' },
    mccpWip: '開發中',
    tag: '執行即介面',
    h1a: '可見', h1b: '可視',
    lead: '一個 VM 的實際執行，配上完整的對應表系統（CTS），同時就是人類可讀的視覺化、與 AI 可解析的事件流——不是同一物件的兩種表示，而是同一物件的兩種觀看方式。',
    play: '開啟互動場', github: 'GitHub', zip: '下載原始碼 .zip',
    badge: 'v0.8.0-beta · 實驗版',
    proof: '272 項 EAI 檢查 · 三個獨立套件 · Apache-2.0',
    aiLayer: '/ai/ — 給 agent 與模型',
    agentFirst: '為 agent 而生——原始碼與 phosphor-jsonl-v1 事件流才是本體；CRT 介面與 .exe 只是讓人類看見原理。',
    forAgents: '給 agent', forHumans: '給人類', seeItRun: '看它跑',
    s1: { n: '01', k: '命題', h: '兩個使用者，一台狀態機。',
      p: '傳統除錯器讀的是程式的「影子」；PHOSPHOR 與視覺化共用同一台狀態機 M——沒有觀察者，只有執行。',
      human: '人類模式', humanD: '一台磷光綠 CRT，你看著它跑——觀察視窗。',
      ai: 'AI 模式', aiD: '一條無頭 phosphor-jsonl-v1 事件流，agent 訂閱並據以推理。' },
    s2: { n: '02', k: 'VM 家族', h: '一套 CTS，一整族機器。',
      p: '每個 profile 共用 6 層對應表系統，與純函數、不可變的步進引擎。' },
    s3: { n: '03', k: '語意層', h: '程式碼「意思」一樣嗎？',
      p: 'v0.5 把每條指令映射為其狀態轉移意義，並判斷兩段位元組是否語意等價——做法是跑兩邊、比可觀察輸出。',
      d1: 'describeEffect', d1d: '機器碼 → 狀態轉移（讀／寫／旗標／控制流）',
      d2: 'semanticEquiv', d2d: '三值判決 + 對抗式輸入；單一輸入即為窮舉證明',
      eq: 'A ≡ B', eqd: '不同位元組——相同意義' },
    s4: { n: '04', k: '互動場', h: '整套，活的。',
      p: '十一個分頁的真實引擎，直接在瀏覽器裡跑：VM、WASM、最佳化旗艦案例、CTS、JSONL、試算表等。' },
    s5: { n: '05', k: 'EML 互通', h: '接好的 EML → PHOSPHOR 迴圈。',
      p: '姊妹專案 EML 發出相同的 phosphor-jsonl-v1 envelope。PHOSPHOR 消費它的執行軌跡，並把它的原始碼層 CTS 橋接成機器層 CTS 視角。' },
    s6: { n: '06', k: '開源', h: '讀它、跑它、fork 它。',
      p: '依賴極輕的 TypeScript，Apache-2.0。一個雙擊 EXE、一個無頭 CLI、一套可攜事件流標準。',
      st1: '項 EAI 檢查', st2: '個套件', st3: '套 EAI 驗證' },
  },
} as const;

function Btn({ href, children, kind = 'ghost' }: { href: string; children: React.ReactNode; kind?: 'solid' | 'ghost' | 'ai' }) {
  const base = 'inline-flex items-center gap-2 px-5 py-2.5 text-sm font-mono tracking-wide border rounded-sm cursor-pointer transition-colors duration-200';
  const styles: Record<string, string> = {
    solid: 'border-[var(--color-phosphor)] text-[#021004] font-semibold bg-[var(--color-phosphor)] hover:bg-[#1aee44]',
    ghost: 'border-[var(--color-line)] text-[var(--color-fg)] hover:border-[var(--color-phosphor)] hover:text-[var(--color-phosphor)]',
    ai: 'border-[color-mix(in_srgb,var(--color-ai)_40%,transparent)] text-[var(--color-ai)] hover:border-[var(--color-ai)]',
  };
  return <a href={href} className={`${base} ${styles[kind]}`}>{children}</a>;
}

function SectionHead({ n, k, h }: { n: string; k: string; h: string }) {
  return (
    <>
      <p data-reveal className="font-mono text-xs tracking-[0.25em] text-[var(--color-muted)]">// {n} — {k}</p>
      <h2 data-reveal className="mt-3 font-mono font-bold text-[clamp(1.6rem,4.5vw,2.6rem)] leading-tight text-[var(--color-fg)]">{h}</h2>
    </>
  );
}

const VMS = [
  { name: 'EML-VM-16', spec: '8-bit · 256 B · u8 · 28-op ISA', use: 'prototype / teaching', c: 'var(--color-phosphor)' },
  { name: 'EML-VM-64', spec: '16-bit · 64 KB · AR0–AR3 · variable-length ISA', use: 'larger address space · V1-compatible', c: 'var(--color-ai)' },
  { name: 'EML-VM-BASIC', spec: 'bounded int [0,N] · constraint engine', use: 'wrap / clamp / throw · cleanest AI substrate', c: 'var(--color-amber)' },
];

export default function App() {
  const root = useRef<HTMLDivElement>(null);
  const [lang, setLang] = useState<Lang>('en');
  const [showPlay, setShowPlay] = useState(false);
  const L = t[lang];

  useGSAP(() => {
    const mm = gsap.matchMedia();

    mm.add('(prefers-reduced-motion: no-preference)', () => {
      // Hero CRT boot sequence
      gsap.timeline({ defaults: { ease: 'power2.out' } })
        .from('[data-hero-power]', { opacity: 0, scale: 0.985, filter: 'brightness(0.25)', duration: 0.55 })
        .from('[data-hero-line]', { opacity: 0, y: 22, stagger: 0.08, duration: 0.5 }, '-=0.15')
        .from('[data-hero-cta]', { opacity: 0, y: 12, stagger: 0.06, duration: 0.4 }, '-=0.2');

      // Section reveals — fade + up, once, no scrub/pin (motion-safe)
      gsap.set('[data-reveal]', { opacity: 0, y: 26 });
      ScrollTrigger.batch('[data-reveal]', {
        start: 'top 86%', once: true,
        onEnter: (els) => gsap.to(els, { opacity: 1, y: 0, stagger: 0.08, duration: 0.6, ease: 'power2.out' }),
      });

      // Count-up stats
      root.current?.querySelectorAll<HTMLElement>('[data-count]').forEach((el) => {
        const end = Number(el.dataset.count) || 0;
        el.textContent = '0';
        const o = { v: 0 };
        ScrollTrigger.create({
          trigger: el, start: 'top 92%', once: true,
          onEnter: () => gsap.to(o, { v: end, duration: 1.1, ease: 'power1.out', onUpdate: () => { el.textContent = String(Math.round(o.v)); } }),
        });
      });
    });

    // Reduced motion: everything visible immediately, stats at final value
    mm.add('(prefers-reduced-motion: reduce)', () => {
      gsap.set('[data-reveal]', { opacity: 1, y: 0 });
      root.current?.querySelectorAll<HTMLElement>('[data-count]').forEach((el) => { el.textContent = el.dataset.count ?? ''; });
    });
  }, { scope: root });

  return (
    <div ref={root} className="crt-scanlines crt-vignette min-h-screen">
      {/* ── Nav ─────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 backdrop-blur-sm bg-[color-mix(in_srgb,var(--color-bg)_85%,transparent)] border-b border-[var(--color-line)]">
        <div className="mx-auto max-w-6xl px-5 h-14 flex items-center gap-6">
          <a href="#top" className="font-mono font-extrabold tracking-[0.25em] text-[var(--color-phosphor)] glow flicker">PHOSPHOR</a>
          <span className="font-mono text-[10px] text-[var(--color-amber)] hidden sm:inline">{L.badge}</span>
          <nav className="ml-auto hidden lg:flex items-center gap-6 font-mono text-xs text-[var(--color-muted)]">
            <a className="text-[var(--color-mint)] hover:text-[var(--color-phosphor)] transition-colors" href="/spacetime/">Spacetime</a>
            <a className="hover:text-[var(--color-phosphor)] transition-colors" href="#thesis">{L.nav.thesis}</a>
            <a className="hover:text-[var(--color-phosphor)] transition-colors" href="#vms">{L.nav.vms}</a>
            <a className="hover:text-[var(--color-phosphor)] transition-colors" href="#semantic">{L.nav.semantic}</a>
            <a className="hover:text-[var(--color-mint)] transition-colors" href="#playground">{L.nav.play}</a>
            <a className="hover:text-[var(--color-phosphor)] transition-colors" href="#open">{L.nav.open}</a>
            <a className="inline-flex items-center gap-1.5 text-[var(--color-amber)] hover:text-[var(--color-mint)] transition-colors" href="/mccp/">
              {L.nav.mccp}
              <span className="text-[9px] border border-[var(--color-amber)] rounded-sm px-1 py-0.5 leading-none">{L.mccpWip}</span>
            </a>
          </nav>
          <button onClick={() => setLang(l => (l === 'en' ? 'zh' : 'en'))}
            className="font-mono text-xs border border-[var(--color-line)] rounded-sm px-2 py-1 text-[var(--color-fg)] hover:border-[var(--color-phosphor)] cursor-pointer transition-colors md:ml-0 ml-auto"
            aria-label="toggle language">{lang === 'en' ? '中文' : 'EN'}</button>
        </div>
      </header>

      <main id="top">
        {/* ── Hero ──────────────────────────────────────────────────────── */}
        <section className="relative mx-auto max-w-6xl px-5 pt-24 pb-28 md:pt-32 md:pb-36" data-hero-power>
          <p data-hero-line className="font-mono text-xs tracking-[0.3em] text-[var(--color-muted)] mb-6">// {L.tag} · 執行即介面</p>
          <h1 data-hero-line className="font-mono font-extrabold leading-[0.95] text-[clamp(2.6rem,9vw,5.5rem)]">
            <span className="text-[var(--color-phosphor)] glow">{L.h1a}</span>
            <span className="text-[var(--color-muted)] mx-3">≡</span>
            <span className="text-[var(--color-mint)] glow-mint">{L.h1b}</span>
          </h1>
          <p data-hero-line className="mt-2 font-mono text-2xl md:text-3xl text-[color-mix(in_srgb,var(--color-fg)_80%,transparent)]">可見即可視</p>
          <p data-hero-line className="mt-8 max-w-2xl text-[15px] md:text-base text-[var(--color-fg-soft)] leading-relaxed">{L.lead}</p>
          <div data-hero-line className="mt-8 inline-block term-frame px-5 py-3 bg-[var(--color-bg-2)]">
            <code className="font-mono text-base md:text-lg text-[var(--color-fg)]">Φ : M × CTS → V</code>
            <span className="font-mono text-[11px] text-[var(--color-muted)] ml-3 hidden sm:inline">state × tables → one object, two views</span>
          </div>
          <div className="mt-10 flex flex-wrap gap-3">
            <span data-hero-cta><Btn href="/spacetime/" kind="solid">{lang === 'zh' ? '軟體時空控制' : 'Software spacetime control'}</Btn></span>
            <span data-hero-cta><Btn href="#playground" kind="ghost">▸ {L.play}</Btn></span>
            <span data-hero-cta><Btn href={GITHUB} kind="ghost">{L.github}</Btn></span>
            <span data-hero-cta><Btn href={SRC_ZIP} kind="ai">↓ {L.zip}</Btn></span>
          </div>
          <p data-hero-cta className="mt-8 font-mono text-[11px] text-[var(--color-muted)]">{L.proof}</p>
        </section>

        <section id="packages" className="mx-auto max-w-6xl px-5 py-20 border-t border-[var(--color-line)]">
          <h2 className="font-mono text-2xl text-[var(--color-mint)]">{lang === 'zh' ? '選擇你的使用入口' : 'Choose your starting point'}</h2>
          <p className="mt-4 text-[var(--color-fg-soft)]">{lang === 'zh' ? '一份原始碼，三個獨立套件。Spacetime 提供軟體域控制；EAI 提供逐步執行；MCCP 提供真實 Python 追蹤。' : 'One source tree, three independent packages: software-domain control, step-by-step execution, and real Python tracing.'}</p>
          <div className="mt-8 grid gap-5 md:grid-cols-3">
            {[
              { name: 'Spacetime', version: '0.1.0a9 · pre-alpha', href: '/spacetime/', description: lang === 'zh' ? '安裝本地 runtime，直接示範邏輯時間倍率、事件跳躍、控制權限與結果驗證。' : 'Install the local runtime. Demonstrate logical rate control, event jumps, authority checks, and verified results.' },
              { name: 'EAI', version: '0.8.0-beta · experimental', href: '#playground', description: lang === 'zh' ? '在瀏覽器步進 VM 或真實 WASM，檢視 CTS、AI 事件流與試算表。' : 'Step a VM or real WASM in your browser; inspect CTS, the AI stream, and spreadsheet projections.' },
              { name: 'MCCP', version: '0.0.1 · experimental', href: '/mccp/', description: lang === 'zh' ? '追蹤本地 Python 程式，檢視真實計算圖、成本與錯誤證據。' : 'Trace a local Python program and inspect its computational graph, costs, and error evidence.' },
            ].map(item => <a key={item.name} href={item.href} className="term-frame p-6 bg-[var(--color-bg-2)] hover:border-[var(--color-mint)] transition-colors">
              <h3 className="font-mono text-xl text-[var(--color-phosphor)]">{item.name}</h3>
              <p className="mt-2 text-xs font-mono text-[var(--color-muted)]">{item.version}</p>
              <p className="mt-4 text-sm text-[var(--color-fg-soft)]">{item.description}</p>
            </a>)}
          </div>
          <p className="mt-6 text-xs text-[var(--color-fg-soft)]">{lang === 'zh' ? '網站提供互動示範、安裝指南與下載；Spacetime 與 MCCP 在你的本地端執行。' : 'The site provides a playground, installation guides, and downloads. Spacetime and MCCP run locally.'}</p>
        </section>

        {/* ── 01 Thesis ─────────────────────────────────────────────────── */}
        <section id="thesis" className="mx-auto max-w-6xl px-5 py-24 border-t border-[var(--color-line)]">
          <SectionHead n={L.s1.n} k={L.s1.k} h={L.s1.h} />
          <p data-reveal className="mt-4 max-w-2xl text-[var(--color-fg-soft)]">{L.s1.p}</p>
          <div className="mt-10 grid md:grid-cols-2 gap-5">
            <div data-reveal className="term-frame p-6 bg-[var(--color-bg-2)]">
              <p className="font-mono text-xs tracking-[0.2em] text-[var(--color-phosphor)] glow">{L.s1.human}</p>
              <p className="mt-3 text-[var(--color-fg-soft)] text-sm">{L.s1.humanD}</p>
            </div>
            <div data-reveal className="term-frame p-6 bg-[var(--color-bg-2)]">
              <p className="font-mono text-xs tracking-[0.2em] text-[var(--color-ai)] glow-ai">{L.s1.ai}</p>
              <p className="mt-3 text-[var(--color-fg-soft)] text-sm">{L.s1.aiD}</p>
            </div>
          </div>
        </section>

        {/* ── 02 VM Family ──────────────────────────────────────────────── */}
        <section id="vms" className="mx-auto max-w-6xl px-5 py-24 border-t border-[var(--color-line)]">
          <SectionHead n={L.s2.n} k={L.s2.k} h={L.s2.h} />
          <p data-reveal className="mt-4 max-w-2xl text-[var(--color-fg-soft)]">{L.s2.p}</p>
          <div className="mt-10 grid md:grid-cols-3 gap-5">
            {VMS.map(v => (
              <div key={v.name} data-reveal className="term-frame p-6 bg-[var(--color-bg-2)] hover:border-[var(--color-phosphor)] transition-colors">
                <p className="font-mono font-bold text-lg" style={{ color: v.c }}>{v.name}</p>
                <p className="mt-3 font-mono text-xs text-[var(--color-fg-soft)] leading-relaxed">{v.spec}</p>
                <p className="mt-2 font-mono text-[11px] text-[var(--color-muted)]">{v.use}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── 03 Semantic Layer ─────────────────────────────────────────── */}
        <section id="semantic" className="mx-auto max-w-6xl px-5 py-24 border-t border-[var(--color-line)]">
          <SectionHead n={L.s3.n} k={L.s3.k} h={L.s3.h} />
          <p data-reveal className="mt-4 max-w-2xl text-[var(--color-fg-soft)]">{L.s3.p}</p>
          <div className="mt-10 grid md:grid-cols-3 gap-5 items-stretch">
            <div data-reveal className="term-frame p-6 bg-[var(--color-bg-2)]">
              <code className="font-mono text-[var(--color-mint)] glow-mint">{L.s3.d1}</code>
              <p className="mt-3 font-mono text-xs text-[var(--color-fg-soft)] leading-relaxed">{L.s3.d1d}</p>
            </div>
            <div data-reveal className="term-frame p-6 bg-[var(--color-bg-2)]">
              <code className="font-mono text-[var(--color-mint)] glow-mint">{L.s3.d2}</code>
              <p className="mt-3 font-mono text-xs text-[var(--color-fg-soft)] leading-relaxed">{L.s3.d2d}</p>
            </div>
            <div data-reveal className="term-frame p-6 bg-[var(--color-bg-2)] flex flex-col items-center justify-center text-center">
              <span className="font-mono text-3xl text-[var(--color-mint)] glow-mint">{L.s3.eq}</span>
              <span className="mt-2 font-mono text-[11px] text-[var(--color-muted)]">{L.s3.eqd}</span>
            </div>
          </div>
        </section>

        {/* ── 04 Playground (embedded) ──────────────────────────────────── */}
        <section id="playground" className="mx-auto max-w-6xl px-5 py-24 border-t border-[var(--color-line)]">
          <SectionHead n={L.s4.n} k={L.s4.k} h={L.s4.h} />
          <p data-reveal className="mt-4 max-w-2xl text-[var(--color-fg-soft)]">{L.s4.p}</p>
          <div data-reveal className="mt-10 term-frame bg-[var(--color-bg)] overflow-hidden" style={{ height: showPlay ? '78vh' : 'auto' }}>
            {showPlay ? (
              <div style={{ height: '78vh', overflow: 'auto' }}>
                <Suspense fallback={<div className="p-10 font-mono text-sm text-[var(--color-mint)]">booting engine…</div>}>
                  <Playground />
                </Suspense>
              </div>
            ) : (
              <button onClick={() => setShowPlay(true)}
                className="w-full py-16 flex flex-col items-center gap-3 cursor-pointer group">
                <span className="font-mono text-2xl text-[var(--color-mint)] glow-mint group-hover:scale-105 transition-transform">▸ {L.play}</span>
                <span className="font-mono text-[11px] text-[var(--color-muted)]">VM-16 · VM-64 · WASM · FLAGSHIP · SEMANTIC · CTS · EML · AGENT · SHEET · MATRIX · PET</span>
              </button>
            )}
          </div>
        </section>

        {/* ── 05 EML Interop ────────────────────────────────────────────── */}
        <section className="mx-auto max-w-6xl px-5 py-24 border-t border-[var(--color-line)]">
          <SectionHead n={L.s5.n} k={L.s5.k} h={L.s5.h} />
          <p data-reveal className="mt-4 max-w-3xl text-[var(--color-fg-soft)]">{L.s5.p}</p>
          <div data-reveal className="mt-8 inline-flex items-center gap-3 font-mono text-sm">
            <span className="px-3 py-1.5 term-frame text-[var(--color-mint)]">EML</span>
            <span className="text-[var(--color-muted)]">── phosphor-jsonl-v1 ──▸</span>
            <span className="px-3 py-1.5 term-frame text-[var(--color-phosphor)]">PHOSPHOR</span>
          </div>
        </section>

        {/* ── 06 Open Source ────────────────────────────────────────────── */}
        <section id="open" className="mx-auto max-w-6xl px-5 py-24 border-t border-[var(--color-line)]">
          <SectionHead n={L.s6.n} k={L.s6.k} h={L.s6.h} />
          <p data-reveal className="mt-4 max-w-2xl text-[var(--color-fg-soft)]">{L.s6.p}</p>
          <div className="mt-10 grid grid-cols-3 gap-5 max-w-xl">
            {[{ v: 272, l: L.s6.st1, c: 'var(--color-phosphor)' }, { v: 3, l: L.s6.st2, c: 'var(--color-ai)' }, { v: 11, l: L.s6.st3, c: 'var(--color-mint)' }].map(s => (
              <div key={s.l} data-reveal className="text-center">
                <div className="font-mono font-extrabold text-[clamp(2rem,6vw,3rem)]" style={{ color: s.c }}><span data-count={s.v}>{s.v}</span></div>
                <div className="font-mono text-[10px] text-[var(--color-muted)] mt-1">{s.l}</div>
              </div>
            ))}
          </div>
          <p data-reveal className="mt-8 max-w-2xl text-sm text-[var(--color-fg-soft)]">{L.agentFirst}</p>
          <div data-reveal className="mt-6 flex flex-wrap gap-3 items-center">
            <Btn href={GITHUB} kind="solid">{L.github} ↗</Btn>
            <Btn href={SRC_ZIP} kind="ai">↓ {L.zip} · {L.forAgents}</Btn>
            <Btn href="#playground" kind="ghost">▸ {L.seeItRun} · {L.forHumans}</Btn>
          </div>
        </section>
      </main>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <footer className="border-t border-[var(--color-line)] bg-[var(--color-bg-2)]">
        <div className="mx-auto max-w-6xl px-5 py-10 font-mono text-[11px] text-[var(--color-muted)] flex flex-wrap gap-x-6 gap-y-2 items-center">
          <span className="text-[var(--color-phosphor)] tracking-[0.2em]">PHOSPHOR</span>
          <span className="text-[var(--color-amber)]">{L.badge}</span>
          <span>© 2026 <span className="text-[var(--color-fg)]">EVEMISS TECHNOLOGY CO., LTD.</span>（一言諾科技有限公司）</span>
          <span>Author <span className="text-[var(--color-fg)]">許筌崴 Neo.K</span></span>
          <span>Apache-2.0</span>
          <a href="/ai/" title="AI Ingestion & Capability Layer — machine-readable corpus + rights"
            className="text-[var(--color-ai)] hover:text-[var(--color-mint)] underline decoration-dotted underline-offset-4 transition-colors">
            {L.aiLayer}
          </a>
        </div>
      </footer>
    </div>
  );
}
