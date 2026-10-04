import { useState, useEffect, useRef, useMemo } from 'react';
// The pet isn't decoration bolted onto PHOSPHOR — it drives a real headless WASM
// run (the same fixture verify:wasm cross-checks against Node's native engine)
// and reports on its ACTUAL state. Φ has a human view, an agent view, a
// spreadsheet view; this is a fourth, playful one — same M, same discipline
// (no invented state, no LLM required for the base loop).
import { parseWasmModule } from '../../wasm/wasm-binary';
import { makeWasmState, stepOnce } from '../../wasm/wasm-interp';
import { buildWasmSnapshot } from '../../wasm/wasm-snapshot';
import { buildFibonacciWasmModule } from '../../wasm/wasm-fixtures';
import { C, Screen, TabTitle, panelHead, alpha } from './theme.jsx';
import SPEECH from './pet-lines.json';

const VOICE_KEY = 'phosphor-pet-voice';
const LANG_KEY = 'phosphor-pet-lang';
const STEP_MS = 220;
const CAPTION_MS = 1900;

// Voice/caption language — English or Japanese only. Not Chinese: it's the
// pet's actual voice, and plain Mandarin synthesis doesn't read as "cute" for
// a mascot the way an EN or JA voice does.
//
// The voice is a set of pre-baked .wav clips (ui/scripts/generate-pet-voices.ps1
// → ui/public/pet-voices/<lang>/<mood>-<index>.wav), not live SpeechSynthesis.
// A live voice depends on whichever OS/browser TTS voices happen to be
// installed on whoever's machine runs this — that's exactly what made picking
// "日本語" speak in a Chinese system voice earlier. A static recording sounds
// the same for everyone, with zero runtime dependency (no new package, no
// network call) — just an <audio> tag.
//
// Text shown on screen and audio played are read from the SAME pet-lines.json
// pool, so they can never drift out of sync with each other.
//
// Deliberately NOT reciting raw hex addresses, arrows, or Φ/M/CTS symbols in
// any line — the "WHAT IT'S ACTUALLY WATCHING" panel already carries that
// detail as text, and mixed symbol/Latin-letter tokens are exactly what made
// the original TTS attempt mispronounce sentences. The speech bubble is mood
// only — four moods, a few natural lines each, no code-shaped strings ever spoken.

function moodOf(snap) {
  if (!snap.halted && snap.tick === 0) return 'idle';
  if (snap.halted) return 'halted';
  if (snap.changed_this_tick.length) return 'write';
  return 'active';
}

/** Resolve the (mood, index) pair once so the on-screen caption and the audio file it plays can never disagree. */
function resolveLine(snap, lang) {
  const mood = moodOf(snap);
  const pool = SPEECH[lang][mood];
  const index = snap.tick % pool.length;
  return { mood, index, text: pool[index] };
}

// A small blocky (方塊) creature — deliberately simple, themed off the shared
// accent tokens so it stays in-palette across all six themes rather than
// reading as a mismatched sprite dropped on top.
function Creature({ mood }) {
  const bounce = mood === 'active' || mood === 'write';
  const eyesClosed = mood === 'halted';
  const flash = mood === 'write';
  return (
    <svg viewBox="0 0 120 120" width="120" height="120" style={{
      animation: bounce ? 'pet-bounce 0.9s ease-in-out infinite' : 'pet-sway 3.2s ease-in-out infinite',
      filter: `drop-shadow(0 0 10px ${alpha(C.bright, 45)})`,
    }}>
      <rect x="14" y="14" width="92" height="92" rx="18"
        fill={flash ? '#ffffff' : C.dim} stroke={C.bright} strokeWidth="3" />
      {/* ears */}
      <rect x="26" y="2" width="14" height="16" rx="4" fill={C.bright} />
      <rect x="80" y="2" width="14" height="16" rx="4" fill={C.bright} />
      {/* eyes */}
      {eyesClosed ? (
        <>
          <path d="M38 62 q8 8 16 0" stroke={C.bright} strokeWidth="4" fill="none" strokeLinecap="round" />
          <path d="M66 62 q8 8 16 0" stroke={C.bright} strokeWidth="4" fill="none" strokeLinecap="round" />
        </>
      ) : (
        <>
          <rect x="38" y="52" width="14" height="14" rx="4" fill={C.bright} style={{ animation: 'pet-blink 4.6s infinite' }} />
          <rect x="68" y="52" width="14" height="14" rx="4" fill={C.bright} style={{ animation: 'pet-blink 4.6s infinite' }} />
        </>
      )}
      {/* mouth */}
      {mood === 'write'
        ? <circle cx="60" cy="86" r="6" fill={C.amber} />
        : <path d={mood === 'halted' ? 'M48 86 q12 4 24 0' : 'M46 84 q14 10 28 0'} stroke={C.amber} strokeWidth="3" fill="none" strokeLinecap="round" />}
    </svg>
  );
}

export default function PetZone() {
  const module = useMemo(() => parseWasmModule(buildFibonacciWasmModule()), []);
  const [state, setState] = useState(() => makeWasmState(module, 'main', [10]));
  const [lang, setLang] = useState(() => { try { return localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'ja'; } catch { return 'ja'; } });
  const [caption, setCaption] = useState(() => SPEECH[lang].idle[0]);
  const [voiceOn, setVoiceOn] = useState(() => { try { return localStorage.getItem(VOICE_KEY) === '1'; } catch { return false; } });
  const stateRef = useRef(state);
  stateRef.current = state;
  const audioRef = useRef(null);

  function stopVoice() {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
  }

  function playVoice(mood, index, lang_) {
    stopVoice();
    const a = new Audio(new URL(`../public/pet-voices/${lang_}/${mood}-${index}.wav`, import.meta.url).href);
    audioRef.current = a;
    a.play().catch(() => { /* best-effort — a silent pet is still a pet */ });
  }

  // The real loop: step the WASM VM, restart it a moment after it halts so the
  // pet always has an actual running M to react to.
  useEffect(() => {
    const id = setInterval(() => {
      setState(s => (s.halted ? makeWasmState(module, 'main', [10]) : stepOnce(s)));
    }, STEP_MS);
    return () => clearInterval(id);
  }, [module]);

  // Captions (and voice) update on a slower, pet-like cadence — not every tick.
  useEffect(() => {
    const tick = () => {
      const snap = buildWasmSnapshot({ id: 'pet', state: stateRef.current, mode: 'ai' });
      const { mood, index, text } = resolveLine(snap, lang);
      setCaption(text);
      if (voiceOn) playVoice(mood, index, lang);
    };
    tick();
    const id = setInterval(tick, CAPTION_MS);
    return () => clearInterval(id);
  }, [voiceOn, lang]);

  function toggleVoice() {
    setVoiceOn(v => {
      const next = !v;
      try { localStorage.setItem(VOICE_KEY, next ? '1' : '0'); } catch { /* best-effort */ }
      if (!next) stopVoice();
      return next;
    });
  }

  function pickLang(next) {
    setLang(next);
    try { localStorage.setItem(LANG_KEY, next); } catch { /* best-effort */ }
    stopVoice();
  }

  const snap = buildWasmSnapshot({ id: 'pet', state, mode: 'ai' });
  const mood = snap.halted ? 'halted' : snap.changed_this_tick.length ? 'write' : 'active';

  return (
    <Screen>
      <style>{`
        @keyframes pet-bounce { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
        @keyframes pet-sway   { 0%,100% { transform: rotate(-1.5deg); } 50% { transform: rotate(1.5deg); } }
        @keyframes pet-blink  { 0%,92%,100% { transform: scaleY(1); } 96% { transform: scaleY(0.12); } }
      `}</style>
      <TabTitle accent={C.fg} title="PET"
        sub="a small, honest Φ projection — reacts to a real running WASM VM, no LLM required" />

      <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: '0 0 auto', textAlign: 'center' }}>
          <Creature mood={mood} />
          <div style={{ marginTop: '10px', display: 'flex', gap: '6px', justifyContent: 'center', flexWrap: 'wrap' }}>
            <button onClick={toggleVoice} style={{
              background: 'none', cursor: 'pointer', border: `1px solid ${voiceOn ? C.bright : C.dim}`,
              color: voiceOn ? C.bright : C.dim, fontSize: '9.5px', fontFamily: 'inherit',
              padding: '3px 10px', letterSpacing: '1px', borderRadius: '2px',
            }}>{voiceOn ? '🔊 voice on' : '🔈 voice off'}</button>
            {['en', 'ja'].map(l => (
              <button key={l} onClick={() => pickLang(l)} style={{
                background: 'none', cursor: 'pointer', border: `1px solid ${lang === l ? C.bright : C.dim}`,
                color: lang === l ? C.bright : C.dim, fontSize: '9.5px', fontFamily: 'inherit',
                padding: '3px 10px', letterSpacing: '1px', borderRadius: '2px',
              }}>{l === 'en' ? 'EN' : '日本語'}</button>
            ))}
          </div>
        </div>

        <div style={{ flex: '1 1 260px', minWidth: '240px' }}>
          <div style={panelHead}>SPEECH</div>
          <div style={{
            border: `1px solid ${C.border}`, borderRadius: '8px', padding: '10px 14px',
            background: alpha(C.fg, 6), color: C.fg, fontSize: '12px', letterSpacing: '0.5px', marginBottom: '14px',
            minHeight: '20px',
          }}>{caption}</div>

          <div style={panelHead}>WHAT IT'S ACTUALLY WATCHING</div>
          <div style={{ fontSize: '9.5px', color: C.muted, lineHeight: '1.7' }}>
            engine <span style={{ color: C.fg }}>WASM-MVP</span> · same fixture as the WASM tab (fib(0..10) → memory)<br />
            tick <span style={{ color: C.fg }}>{snap.tick}</span> · {snap.halted ? 'halted, restarting shortly' : snap.instruction}<br />
            mood is derived from <code style={{ color: C.ai }}>changed_this_tick</code> / <code style={{ color: C.ai }}>halted</code> — not scripted
          </div>
        </div>
      </div>

      <div style={{ marginTop: '16px', fontSize: '8.5px', color: C.muted, maxWidth: '640px', lineHeight: '1.6' }}>
        Placeholder scope, by design: no pet customization, no image-to-pet generation, no LLM narration —
        those are a separate, larger project. This is the minimum honest version: a cute block creature,
        a rule-based caption, and an optional voice (pre-baked static clips, not live per-user TTS synthesis
        — see ui/scripts/generate-pet-voices.ps1), all reacting to a real VM.
      </div>
    </Screen>
  );
}
