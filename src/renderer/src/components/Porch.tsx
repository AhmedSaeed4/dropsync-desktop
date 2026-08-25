/**
 * C2 — THE PORCH: launch screen where the user picks Cloud or Local before any mode entry.
 *
 * Design contract (owner-locked, from desktop-porch-prototype.html):
 * - The pill: dark trough #1a1a1a, radius 100px, padding 4px; white indicator knob width
 *   calc(50% - 4px), shadow 0 1px 3px rgba(0,0,0,.08), ELASTIC easing
 *   cubic-bezier(0.34,1.56,0.64,1) over 0.6s; buttons 10px 24px Inter 14px/500; inactive
 *   rgba(255,255,255,.55) → active #1a1a1a, color .3s. Wording EXACTLY "Cloud"/"Local".
 * - Panel slide: direction-aware ±56px horizontal glide 0.45s cubic-bezier(0.22,0.61,0.36,1),
 *   opacity 0.28s ease, start position pinned via double-rAF (the prototype forces reflow;
 *   same technique adapted to React commits).
 * Everything else is our Editorial language (#FAF7F2, centered column, rounded-full controls,
 * corner clock bottom-left + "EDITION 2.0" bottom-right like UnlockScreen's footer).
 *
 * Memory rule (§2): localStorage `dropsync.mode.last`; first-ever launch (absent/corrupt) ⇒
 * LOCAL preselected. Choice is written on pick. Mid-session switching stays with the badge.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopMode } from './ModeBadge';

const MEMORY_KEY = 'dropsync.mode.last';
/** DEV battery hook (DROPSYNC_CLOUD_DEV=1): drives the REAL pick() path headlessly. */
export const C2_DEV_ENTER = 'dropsync:c2-dev-enter';

export function readLastMode(): DesktopMode {
  try {
    const v = localStorage.getItem(MEMORY_KEY);
    return v === 'cloud' ? 'cloud' : 'local'; // corrupt/absent ⇒ Local default (§5)
  } catch {
    return 'local';
  }
}

function writeLastMode(mode: DesktopMode): void {
  try {
    localStorage.setItem(MEMORY_KEY, mode);
  } catch { /* storage unavailable — memory simply won't persist */ }
}

interface PorchProps {
  /** Enters the chosen mode (App-level: porch → local branch or C1 cloud view). */
  onEnter: (mode: DesktopMode) => void;
}



/** Panel parking states, mirroring the prototype's class model exactly:
 * 'active' = visible at rest · 'off-left'/'off-right' = glided out ±56px · '' = parked at rest
 * (opacity 0, no offset — initial state of the non-selected panel). */
type PanelPos = 'active' | 'off-left' | 'off-right' | '';
const IDX: Record<DesktopMode, number> = { cloud: 0, local: 1 };
const TX: Record<PanelPos, number> = { active: 0, 'off-left': -56, 'off-right': 56, '': 0 };

const PILL_BTN =
  'relative z-[1] px-6 py-2.5 border-none bg-transparent rounded-full text-sm font-medium select-none cursor-pointer transition-colors duration-300';

function Pill({ sel, onPick }: { sel: DesktopMode; onPick: (m: DesktopMode) => void }) {
  return (
    <div className="inline-flex relative rounded-full bg-[#1a1a1a] p-1">
      <span
        data-testid="porch-knob"
        aria-hidden
        className="absolute top-1 left-1 h-[calc(100%-8px)] w-[calc(50%-4px)] bg-white rounded-full shadow-[0_1px_3px_rgba(0,0,0,0.08)] will-change-transform"
        style={{
          transform: sel === 'cloud' ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)',
        }}
      />
      {(['cloud', 'local'] as const).map((m) => (
        <button key={m} type="button" onClick={() => onPick(m)} className={PILL_BTN}
          style={{ color: sel === m ? '#1a1a1a' : 'rgba(255,255,255,0.55)' }}>
          {m === 'cloud' ? 'Cloud' : 'Local'}
        </button>
      ))}
    </div>
  );
}





const CARD =
  'w-[340px] max-w-full rounded-2xl border border-[#1a1a1a]/10 bg-white/70 p-7 text-center';
const HEADING = 'text-lg font-light tracking-tight text-[#1a1a1a] mb-1';
const NOTE = 'text-xs text-[#1a1a1a]/45 mt-4 leading-relaxed';
const PRIMARY_BTN =
  'inline-flex items-center justify-center px-8 py-3 bg-[#1a1a1a] rounded-full text-sm font-medium text-white hover:bg-[#333] transition-all duration-300 mt-5';
const MUTED_LINK =
  'bg-none border-none p-0 text-xs text-[#1a1a1a]/50 underline underline-offset-[3px] cursor-pointer hover:text-[#1a1a1a] transition-colors';

/** Cloud panel content (§2). Remembered session ⇒ "Continue as <email>" + muted switch link;
 * otherwise the neutral card. BOTH one-tap into the C1 cloud view — the SITE's own UI handles
 * credentials/account switching there (planner ruling; prototype State B is indicative only). */
function CloudCard({
  probe,
  onEnter,
}: {
  probe: { state: 'probing' | 'signedIn' | 'none'; email: string | null };
  onEnter: () => void;
}) {
  return (
    <div className={CARD} data-testid="porch-cloud-card">
      {probe.state === 'signedIn' && probe.email ? (
        <>
          <p className={HEADING}>Welcome back</p>
          <p className="text-sm font-medium text-[#1a1a1a] mt-3 truncate" data-testid="porch-email">
            {probe.email}
          </p>
          <button type="button" onClick={onEnter} className={PRIMARY_BTN}>
            Continue as {probe.email}
          </button>
          <div className="mt-4">
            <button
              type="button"
              onClick={onEnter}
              className={MUTED_LINK}
              title="The site's own account screen handles switching — we never handle credentials."
            >
              Log into a different account
            </button>
          </div>
        </>
      ) : (
        <>
          <p className={HEADING}>{probe.state === 'probing' ? 'Checking your cloud…' : 'Sign in to your cloud'}</p>
          <p className="text-sm text-[#1a1a1a]/60 mt-2">
            The real sign-in opens inside your DropSync window.
          </p>
          <button type="button" onClick={onEnter} disabled={probe.state === 'probing'} className={`${PRIMARY_BTN} disabled:opacity-40`}>
            Continue
          </button>
        </>
      )}
      <p className={NOTE}>Cloud stays signed in until you log out on the site.</p>
    </div>
  );
}

/** Local panel card — indicative only; the REAL entry flows (FirstRunSetup / UnlockScreen,
 * M7 offer included) render unchanged right after choosing Local. */
function LocalCard({ onEnter }: { onEnter: () => void }) {
  return (
    <div className={CARD} data-testid="porch-local-card">
      <p className={HEADING}>Your encrypted vault</p>
      <p className="text-sm text-[#1a1a1a]/60 mt-2">
        Everything local, sealed with your password.
      </p>
      <button type="button" onClick={onEnter} className={PRIMARY_BTN}>
        Open Local
      </button>
      <p className={NOTE}>Local locks whenever you leave it or step away.</p>
    </div>
  );
}





/** DEV battery evidence (DROPSYNC_CLOUD_DEV=1 → ?c2dev query tag). Collected after porch paint;
 * emitted again when the email probe resolves. Never runs without the env-gated tag. */
function buildEvidence(args: {
  pillInitial: DesktopMode;
  sel: DesktopMode;
  probe: { state: string; email: string | null };
  knobEl: HTMLElement | null;
  panelEl: HTMLElement | null;
}): Record<string, unknown> {
  let storedValue: string | null = null;
  try {
    storedValue = localStorage.getItem(MEMORY_KEY);
  } catch { /* ignore */ }
  const knobTransition = args.knobEl ? getComputedStyle(args.knobEl).transition : null;
  const panelTransition = args.panelEl ? getComputedStyle(args.panelEl).transition : null;
  const storedAbsent = storedValue === null;
  const storedValid = storedValue === 'cloud' || storedValue === 'local';
  return {
    f_c2_porchRenders: !!document.querySelector('[data-testid="porch"]'),
    storedValue,
    pillInitial: args.pillInitial,
    pillNow: args.sel,
    f_c2_memoryLocalFirst: storedAbsent && args.pillInitial === 'local',
    f_c2_memoryRemember: storedValid && args.pillInitial === storedValue,
    emailProbeRaw: { state: args.probe.state, email: args.probe.email },
    cardKind:
      args.probe.state === 'signedIn' && args.probe.email
        ? 'account'
        : args.probe.state === 'probing'
          ? 'probing'
          : 'neutral',
    slideStyles: { knobTransition, panelTransition },
    f_c2_slideTransition:
      !!knobTransition?.includes('cubic-bezier(0.34, 1.56, 0.64, 1)') &&
      !!panelTransition?.includes('cubic-bezier(0.22, 0.61, 0.36, 1)'),
  };
}



export function Porch({ onEnter }: PorchProps) {
  const pillInitial = useRef(readLastMode()).current;
  const [sel, setSel] = useState<DesktopMode>(pillInitial);
  const selRef = useRef(sel);
  const [pos, setPos] = useState<Record<DesktopMode, PanelPos>>(() => ({
    cloud: pillInitial === 'cloud' ? 'active' : '',
    local: pillInitial === 'local' ? 'active' : '',
  }));
  const busyRef = useRef(false);
  const panelRefs = useRef<Partial<Record<DesktopMode, HTMLDivElement | null>>>({});
  const [probe, setProbe] = useState<{ state: 'probing' | 'signedIn' | 'none'; email: string | null }>({
    state: 'probing',
    email: null,
  });
  const [clock, setClock] = useState(() =>
    new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  );

  /** Pill click = SELECT (glide); entering happens via the card buttons (§2 launch flow).
   * Rapid double-clicks are ignored until the glide settles — no stuck mid-animation states. */
  const pick = useCallback((next: DesktopMode) => {
    if (busyRef.current || next === selRef.current) return;
    busyRef.current = true;
    const prev = selRef.current;
    selRef.current = next;
    writeLastMode(next);
    setSel(next);
    const movingRight = IDX[next] > IDX[prev];
    // Phase 1 — park both panels at their start positions…
    setPos({
      [prev]: movingRight ? 'off-left' : 'off-right',
      [next]: movingRight ? 'off-right' : 'off-left',
    } as Record<DesktopMode, PanelPos>);
    // …phase 2 once painted (double rAF ≈ the prototype's forced-reflow trick).
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        setPos((p) => ({ ...p, [next]: 'active' }));
        window.setTimeout(() => {
          setPos((p) => ({ ...p, [prev]: '' }));
          busyRef.current = false;
        }, 470);
      })
    );
  }, []);

  // Read-only email discovery — async, AFTER porch paint; uncertain ⇒ neutral card (§2).
  useEffect(() => {
    let cancelled = false;
    window.dropsync.mode
      .probeEmail()
      .then((r) => {
        if (!cancelled) setProbe({ state: r.signedIn ? 'signedIn' : 'none', email: r.email });
      })
      .catch(() => {
        if (!cancelled) setProbe({ state: 'none', email: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const t = setInterval(
      () => setClock(new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })),
      15_000
    );
    return () => clearInterval(t);
  }, []);

  // DEV battery (?c2dev tag written by main under DROPSYNC_CLOUD_DEV=1): emit evidence on
  // mount AND again when the email probe resolves. StrictMode double-invokes effects, so
  // identical consecutive signatures are suppressed. Channel is env-gated main-side; rejects
  // elsewhere are swallowed.
  const lastEmitSig = useRef('');
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('c2dev')) return;
    const ev = buildEvidence({
      pillInitial,
      sel: selRef.current,
      probe,
      knobEl: document.querySelector('[data-testid="porch-knob"]'),
      panelEl:
        panelRefs.current[pillInitial] ??
        document.querySelector('[data-testid^="porch-panel-"]'),
    });
    const sig = JSON.stringify([ev.pillInitial, ev.pillNow, probe.state, probe.email]);
    if (sig === lastEmitSig.current) return;
    lastEmitSig.current = sig;
    window.dropsync.mode.devC2?.(ev).catch(() => {});
  }, [pillInitial, probe]);

  // Headless entry for the battery — ENTERS the mode directly (bypasses pick(): when the pill
  // already sits on the requested mode, pick() would correctly no-op, but the battery wants
  // the real onEnter path — identical to tapping the card's button).
  useEffect(() => {
    const h = (e: Event): void => {
      const m = (e as CustomEvent<{ mode?: string }>).detail?.mode;
      if (m === 'cloud' || m === 'local') {
        writeLastMode(m);
        onEnter(m);
      }
    };
    window.addEventListener(C2_DEV_ENTER, h);
    return () => window.removeEventListener(C2_DEV_ENTER, h);
  }, [onEnter]);

  return (
    <div
      data-testid="porch"
      className="fixed inset-0 bg-[#FAF7F2] flex flex-col items-center overflow-hidden"
      style={{ fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif" }}
    >
      <div className="flex-1 w-full flex flex-col items-center justify-center pt-6">
        <p className="text-xs tracking-[0.35em] text-[#1a1a1a]/50 mb-9" style={{ fontVariantCaps: 'small-caps' }}>
          DROPSYNC · DESKTOP
        </p>
        <Pill sel={sel} onPick={pick} />
        <div className="relative w-full flex-1 min-h-[320px]">
          {(['cloud', 'local'] as const).map((m) => (
            <div
              key={m}
              ref={(el) => {
                panelRefs.current[m] = el;
              }}
              data-testid={`porch-panel-${m}`}
              className="absolute left-0 top-1/2 w-full flex justify-center"
              style={{
                transform: `translate(${TX[pos[m]]}px, calc(-50% - 96px))`,
                opacity: pos[m] === 'active' ? 1 : 0,
                pointerEvents: pos[m] === 'active' ? 'auto' : 'none',
                transition: 'opacity 0.28s ease, transform 0.45s cubic-bezier(0.22, 0.61, 0.36, 1)',
                willChange: 'opacity, transform',
              }}
            >
              {m === 'cloud' ? (
                <CloudCard probe={probe} onEnter={() => onEnter('cloud')} />
              ) : (
                <LocalCard onEnter={() => onEnter('local')} />
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="absolute bottom-8 left-8 text-xs text-[#1a1a1a]/45">{clock}</div>
      <div className="absolute bottom-8 right-8 text-xs text-[#1a1a1a]/45">EDITION 2.0</div>
    </div>
  );
}
