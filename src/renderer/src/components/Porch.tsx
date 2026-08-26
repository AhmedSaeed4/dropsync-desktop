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
  /** C2b — callback-ref for the Local-panel slot: AppBody portals the REAL entry component
   * (FirstRunSetup / UnlockScreen) here; the porch is just the frame around it. */
  localSlotRef: (el: HTMLDivElement | null) => void;
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
    <div data-testid="porch-pill" className="inline-flex relative rounded-full bg-[#1a1a1a] p-1">
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





const HEADING = 'text-lg font-light tracking-tight text-[#1a1a1a] mb-1';
const NOTE = 'text-xs text-[#1a1a1a]/45 mt-4 leading-relaxed';
const PRIMARY_BTN =
  'inline-flex items-center justify-center px-8 py-3 bg-[#1a1a1a] rounded-full text-sm font-medium text-white hover:bg-[#333] transition-all duration-300 mt-5';
const MUTED_LINK =
  'bg-none border-none p-0 text-xs text-[#1a1a1a]/50 underline underline-offset-[3px] cursor-pointer hover:text-[#1a1a1a] transition-colors';

/** C2b FIX 3 — borderless: centered text + button + link directly on the background (prototype:
 * "No cards"). Remembered session ⇒ "Continue as <email>" + muted switch link; otherwise the
 * neutral card. BOTH one-tap into the C1 cloud view — the SITE's own UI handles credentials/
 * account switching there (planner ruling; prototype State B is indicative only). */
function CloudCard({
  probe,
  onEnter,
}: {
  probe: { state: 'probing' | 'signedIn' | 'none'; email: string | null };
  onEnter: () => void;
}) {
  return (
    <div className="w-[420px] max-w-full px-6 text-center" data-testid="porch-cloud-card">
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
  // C2b FIX 4 — is the REAL entry component embedded in the Local panel (no placeholder card)?
  const porchRoot = document.querySelector('[data-testid="porch"]');
  const porchText = porchRoot?.textContent ?? '';
  const unlockEmbedded = !!porchRoot?.querySelector('input[placeholder="Vault password"]');
  const firstrunEmbedded =
    !unlockEmbedded && (porchRoot?.querySelectorAll('input[type="password"]').length ?? 0) >= 2;
  const embeddedKind = unlockEmbedded ? 'unlock' : firstrunEmbedded ? 'firstrun' : 'none';
  return {
    f_c2_porchRenders: !!porchRoot,
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
    embeddedKind,
    placeholderCardGone: !porchText.includes('Open Local') && !porchText.includes('Your encrypted vault'),
    f_c2_localEmbedded:
      !!porchRoot &&
      args.sel === 'local' &&
      embeddedKind === 'unlock' &&
      !porchText.includes('Open Local'),
  };
}



export function Porch({ onEnter, localSlotRef }: PorchProps) {
  const pillInitial = useRef(readLastMode()).current;
  const [sel, setSel] = useState<DesktopMode>(pillInitial);
  const selRef = useRef(sel);
  const [pos, setPos] = useState<Record<DesktopMode, PanelPos>>(() => ({
    cloud: pillInitial === 'cloud' ? 'active' : '',
    local: pillInitial === 'local' ? 'active' : '',
  }));
  const busyRef = useRef(false);
  const panelRefs = useRef<Partial<Record<DesktopMode, HTMLDivElement | null>>>({});
  // C2c — floating chrome can be dropped/restored by the DEV geometry probe.
  const [chromeUp, setChromeUp] = useState(true);
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
  // mount AND whenever the Local-panel slot mutates (the portaled real form can land seconds
  // later — slow first status round-trip). StrictMode double-invokes are deduped by signature;
  // channel is env-gated main-side, rejects swallowed.

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

  // C2c FIX 3/4 — floating-pill geometry probe (dev-gated). Proves the embedded screen's
  // bounding boxes are IDENTICAL with the floating chrome mounted vs unmounted (the core
  // owner guarantee: zero geometry change), that the float wrapper has no background of its
  // own and hangs directly off the porch root (no band element), and that the pill zone does
  // not collide with any interactive element of the embedded form.
  const floatBusyRef = useRef(false);
  const runPillFloatProbe = useCallback(async (): Promise<Record<string, unknown>> => {
    if (floatBusyRef.current) return { f_c2_pillFloat: false, reason: 'busy' };
    floatBusyRef.current = true;
    try {
      const rectOf = (el: Element): Record<string, number> => {
        const r = el.getBoundingClientRect();
        const q = (n: number): number => Math.round(n * 10) / 10;
        return { x: q(r.x), y: q(r.y), w: q(r.width), h: q(r.height) };
      };
      const grab = (): { form: Record<string, number>; controls: Record<string, number>[] } | null => {
        const slotChild = document.querySelector('[data-testid="porch-local-slot"]')?.firstElementChild;
        if (!slotChild) return null;
        const controls = [...slotChild.querySelectorAll('input,button')].slice(0, 4).map(rectOf);
        return { form: rectOf(slotChild), controls };
      };
      const doubleRaf = (): Promise<void> =>
        new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      const porchRoot = document.querySelector('[data-testid="porch"]');
      const wrapper = document.querySelector('[data-testid="porch-pill-float"]');
      if (!wrapper) return { f_c2_pillFloat: false, reason: 'no-float-wrapper' };
      // Wait out web-font loading: late font swaps shift text metrics and would fake a
      // geometry change that the pill never caused.
      try {
        await document.fonts.ready;
      } catch { /* older engine — proceed */ }
      await doubleRaf();
      const before = grab();
      if (!before) return { f_c2_pillFloat: false, reason: 'no-embedded-form' };
      const pillEl = wrapper.querySelector('[data-testid="porch-pill"]') ?? wrapper;
      const pillRect = rectOf(pillEl);
      const interactive = [
        ...(document.querySelector('[data-testid="porch-local-slot"]')?.querySelectorAll('button,input,a') ?? []),
      ].map(rectOf);
      const overlaps = interactive.filter(
        (r) => r.x < pillRect.x + pillRect.w && r.x + r.w > pillRect.x && r.y < pillRect.y + pillRect.h && r.y + r.h > pillRect.y
      );
      setChromeUp(false);
      await doubleRaf();
      await new Promise((r) => setTimeout(r, 60));
      const during = grab();
      setChromeUp(true);
      await doubleRaf();
      await new Promise((r) => setTimeout(r, 60));
      const after = grab();
      // NOTE: hiding the chrome UNMOUNTS the original wrapper node — re-query the live one
      // for style/parent checks (a stale reference would read as detached: bg '' / no parent).
      const liveWrapper = document.querySelector('[data-testid="porch-pill-float"]');
      if (!liveWrapper) return { f_c2_pillFloat: false, reason: 'wrapper-gone-after-restore' };
      const bg = getComputedStyle(liveWrapper).backgroundColor;
      const parentIsPorch = liveWrapper.parentElement === porchRoot;
      const geometryEqual =
        JSON.stringify(before) === JSON.stringify(during) &&
        JSON.stringify(before) === JSON.stringify(after);
      return {
        f_c2_pillFloat: geometryEqual && (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') && parentIsPorch,
        geometryEqual,
        wrapperBgTransparent: bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent',
        wrapperBgRaw: bg,
        wrapperParentIsPorch: parentIsPorch,
        wrapperDebug: {
          tag: liveWrapper.tagName,
          parentTag: liveWrapper.parentElement?.tagName ?? null,
          parentTestId: liveWrapper.parentElement?.getAttribute('data-testid') ?? null,
        },
        pillZoneOverlapInteractive: overlaps.length > 0,
        overlapCount: overlaps.length,
        formRectWithPill: before.form,
        firstControlRectWithPill: before.controls[0] ?? null,
      };
    } finally {
      floatBusyRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('c2dev')) return;
    (window as unknown as { __c2cPillProbe?: () => Promise<Record<string, unknown>> }).__c2cPillProbe =
      runPillFloatProbe;
    return () => {
      delete (window as unknown as { __c2cPillProbe?: unknown }).__c2cPillProbe;
    };
  }, [runPillFloatProbe]);

  // DEV battery (?c2dev tag written by main under DROPSYNC_CLOUD_DEV=1): emit evidence on
  // mount AND whenever the Local-panel slot mutates (the portaled real form can land seconds
  // later — slow first status round-trip). StrictMode double-invokes are deduped by signature;
  // channel is env-gated main-side, rejects swallowed. Once the real form is embedded, the
  // C2c floating-pill geometry proof auto-runs at the current window size.
  const lastEmitSig = useRef('');
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('c2dev')) return;
    const collect = (): Record<string, unknown> =>
      buildEvidence({
        pillInitial,
        sel: selRef.current,
        probe,
        knobEl: document.querySelector('[data-testid="porch-knob"]'),
        panelEl:
          panelRefs.current[pillInitial] ??
          document.querySelector('[data-testid^="porch-panel-"]'),
      });
    const emit = (): void => {
      const ev = collect();
      const sig = JSON.stringify([ev.pillNow, ev.embeddedKind, ev.cardKind, probe.email]);
      if (sig === lastEmitSig.current) return;
      lastEmitSig.current = sig;
      window.dropsync.mode.devC2?.(ev).catch(() => {});
    };
    emit();
    const floatDoneRef = { done: false };
    const slotEl = document.querySelector('[data-testid="porch-local-slot"]');
    const mo = new MutationObserver(() => {
      emit();
      if (!floatDoneRef.done && selRef.current === 'local' && document.querySelector('[data-testid="porch-local-slot"] input')) {
        floatDoneRef.done = true;
        void runPillFloatProbe().then((res) => {
          window.dropsync.mode.devC2?.({ c2cTag: 'pillfloat', ...res }).catch(() => {});
        });
      }
    });
    if (slotEl) mo.observe(slotEl, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [pillInitial, probe, runPillFloatProbe]);

  return (
    <div
      data-testid="porch"
      className="fixed inset-0 bg-[#FAF7F2] overflow-hidden"
      style={{ fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif" }}
    >
      {/* C2c FIX 1/2 — the glide layer IS the full window: embedded FirstRunSetup/UnlockScreen
       * render at their natural, untouched size (identical pixels to standalone); the pill
       * FLOATS above them and panels slide BENEATH it. No bands, no spacers, no squeezing. */}
      <div className="absolute inset-0">
        {(['cloud', 'local'] as const).map((m) => {
          const isLocal = m === 'local';
          return (
            <div
              key={m}
              ref={(el) => {
                panelRefs.current[m] = el;
              }}
              data-testid={`porch-panel-${m}`}
              className={`absolute inset-0 ${isLocal ? '' : 'flex justify-center'}`}
              style={{
                transform: isLocal
                  ? `translate(${TX[pos[m]]}px, 0)`
                  : `translate(${TX[pos[m]]}px, calc(-50% - 110px))`,
                top: isLocal ? 0 : '50%',
                opacity: pos[m] === 'active' ? 1 : 0,
                pointerEvents: pos[m] === 'active' ? 'auto' : 'none',
                transition: 'opacity 0.28s ease, transform 0.45s cubic-bezier(0.22, 0.61, 0.36, 1)',
                willChange: 'opacity, transform',
              }}
            >
              {m === 'cloud' ? (
                <CloudCard probe={probe} onEnter={() => onEnter('cloud')} />
              ) : (
                /* FIX 1 (C2b): the REAL entry component portals in here at FULL window size. */
                <div ref={localSlotRef} data-testid="porch-local-slot" className="h-full w-full" />
              )}
            </div>
          );
        })}
      </div>

      {/* C2c FIX 2 — FLOATING chrome: transparent overlay (no band/strip), pointer-events only
       * on its own controls; FIX 2 (C2b) still applies — branding yields to the real Local
       * form, so the wordmark shows only with the Cloud panel. */}
      <div
        data-testid="porch-wordmark"
        className={`pointer-events-none absolute inset-x-0 top-[18px] z-[60] flex justify-center transition-opacity duration-200 ${
          sel === 'cloud' ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <p className="text-xs tracking-[0.35em] text-[#1a1a1a]/50" style={{ fontVariantCaps: 'small-caps' }}>
          DROPSYNC · DESKTOP
        </p>
      </div>
      {chromeUp && (
        <div
          data-testid="porch-pill-float"
          className="pointer-events-none absolute left-1/2 top-[52px] z-[60]"
          style={{ transform: 'translateX(-50%)' }}
        >
          <div className="pointer-events-auto">
            <Pill sel={sel} onPick={pick} />
          </div>
        </div>
      )}

      <div className={`absolute bottom-8 left-8 text-xs text-[#1a1a1a]/45 ${sel === 'cloud' ? '' : 'invisible'}`}>{clock}</div>
      <div className={`absolute bottom-8 right-8 text-xs text-[#1a1a1a]/45 ${sel === 'cloud' ? '' : 'invisible'}`}>
        EDITION 2.0
      </div>
    </div>
  );
}
