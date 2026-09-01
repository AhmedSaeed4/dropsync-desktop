/**
 * C2g — the floating pill page logic (vanilla TS; the ONLY script in the pill layer).
 *
 * Mode reflection ONLY (C2f contract kept): a word click sends ONE `pill:flip` ipc; main
 * forwards it to the MAIN window renderer (guarded switchMode); only when the mode ACTUALLY
 * applies does main send `pill:setMode` back — then both knobs slide + the gold dot moves.
 * Login state is deliberately unknown here.
 *
 * C2g additions:
 * - TWO styles in one page: A "punch-hole" (always shown fully) and B "micro bloom" (28 × 28
 *   dots at rest; blooms to the full 112 × 28 pill while hovered). The boot style comes from
 *   the `?style=` query param that MAIN bakes into the layer URL from its persisted store —
 *   correct from the first frame, no style flash.
 * - Style B hover ⇒ JS-driven bloom (NOT :hover): the CSS class lands and we tell main via
 *   `pill:bloom` in the same tick. PAC-5: main's setPillBloom is an honest no-op stub — the
 *   native room is a PERMANENT 132 × 44 stage (never resized), so the report exists purely
 *   to keep the bridge contract alive. A 90 ms collapse hysteresis (documented
 *   deviation-free: §1 allows small hysteresis) swallows accidental edge-grazes without
 *   changing any timing.
 * - Right-click ANYWHERE on the layer toggles A ⇄ B, suppresses the native context menu on
 *   THIS LAYER ONLY, and persists through main (`pill:setStyle`).
 *
 * PAC-5 — THE PERMANENT STAGE (both styles). The native room is sized once per style and
 * NEVER changes at runtime: A = 140 × 28, B = 132 × 44 (cloud.ts). The §1 ZERO-MISS rule
 * now reads: clicks INSIDE the painted footprint work exactly as before (the hover target
 * moved onto the painted element — same geometry as the old at-rest footprint); the
 * room's transparent margin is dead space over the empty header strip both apps keep there
 * (owner-approved §3.2). All animation is pure in-page CSS — there is no room swap, so the
 * old entry choreography (blanking, reveal polls, rest-paint gating) is deleted entirely.
 */

interface PillBridge {
  flip(next: 'cloud' | 'local'): void;
  onSetMode(cb: (mode: 'cloud' | 'local') => void): void;
  bloom(on: boolean): void;
  setStyle(style: 'A' | 'B'): void;
  ready(): void;
  onStyle(cb: (style: 'A' | 'B') => void): (() => void);
}

/**
 * C2g-hotfix-1 FIX 3 — the bridge is resolved LAZILY on every use and ADOPTED the moment it
 * appears (the preload can land after first paint in slow boots); it is never cached as
 * "missing". A missing bridge is a LOUD, rate-limited error on every attempted action —
 * clicks must never die in silence again.
 */
let bridge: PillBridge | null = null;
let bridgeWarnedAt = 0;
function adoptBridge(b: PillBridge): void {
  bridge = b;
  b.onSetMode(render);
  b.onStyle(applyStyle);
  b.ready(); // FIX 3 handshake — main replies with the true mode (+ true style if it differs)
}
function getBridge(): PillBridge | null {
  if (!bridge) {
    const found = (window as unknown as { dropsyncPill?: PillBridge }).dropsyncPill;
    if (found) adoptBridge(found);
  }
  return bridge;
}
function requireBridge(action: string): PillBridge | null {
  const b = getBridge();
  if (!b && Date.now() - bridgeWarnedAt > 3000) {
    bridgeWarnedAt = Date.now();
    console.error(`[pill] ${action} dropped — dropsyncPill bridge missing (preload failed?)`);
  }
  return b;
}

const root = document.getElementById('root');
const knobs = Array.from(document.querySelectorAll<HTMLSpanElement>('.knob'));
const dotsCloud = document.getElementById('dot-cloud');
const dotsLocal = document.getElementById('dot-local');

let current: 'cloud' | 'local' = 'local';
let style: 'A' | 'B' = new URLSearchParams(window.location.search).get('style') === 'B' ? 'B' : 'A';
let bloomed = false;
let collapseTimer: number | null = null;
const COLLAPSE_HYSTERESIS_MS = 90; // §1-permitted hysteresis — see module doc

function applyStyle(s: 'A' | 'B'): void {
  style = s;
  document.body.classList.toggle('style-a', s === 'A');
  document.body.classList.toggle('style-b', s === 'B');
  // Switching away from B cancels any pending/live bloom so no stale timer survives a toggle.
  if (s === 'A' && (bloomed || collapseTimer !== null)) forceCollapse();
}

/** Mode reflection across BOTH styles at once (only one is visible; keeping both in sync means
 * a right-click mid-session can never show a stale knob/dot). */
function render(mode: 'cloud' | 'local'): void {
  current = mode;
  const local = mode === 'local';
  for (const k of knobs) k.classList.toggle('on-local', local);
  for (const id of ['btn-cloud-a', 'btn-cloud-b']) {
    document.getElementById(id)?.classList.toggle('active', !local);
  }
  for (const id of ['btn-local-a', 'btn-local-b']) {
    document.getElementById(id)?.classList.toggle('active', local);
  }
  dotsCloud?.classList.toggle('active', !local); /* gold dot = active side */
  dotsLocal?.classList.toggle('active', local);
}
function forceCollapse(): void {
  if (collapseTimer !== null) {
    clearTimeout(collapseTimer);
    collapseTimer = null;
  }
  if (!bloomed) return;
  bloomed = false;
  document.getElementById('pillB')?.classList.remove('bloomed'); /* CSS starts… */
  requireBridge('bloom')?.bloom(false); /* …bridge contract kept — main's stub is a no-op */
}

/* Bloom in/out — driven by the PAINTED element's own mouseenter/mouseleave (PAC-5: #pillB;
 * at rest that is the 28 × 28 circle, bloomed the 112 × 28 pill), so "leave" fires only when
 * the cursor truly exits the painted footprint — the permanent room's transparent margin
 * stays dead (§3.2).
 * C2g-hotfix-4 FIX 3 — the 90 ms collapse LAG must never close the pill UNDER the cursor: a
 * fast graze (out ~1 px, back within 90 ms) used to leave `forceCollapse` armed behind the
 * `bloomed` short-circuit, so it fired with the pointer inside and hover went stale until a
 * full exit/re-enter. The timer clear runs BEFORE any early-return; only the style gate
 * precedes it. No timing values change.
 *
 * PAC-5 — THE ENTRY CHOREOGRAPHY COLLAPSES TO ONE PATH (hotfix-6's fast path IS the only
 * path): the native room is PERMANENT (window.innerWidth is ALWAYS 132 in style B), so the
 * old from-rest branch — hotfix-5's blank-then-reveal, PAC-3's rest-paint + reveal poll,
 * PILL_REVEAL_TIMEOUT_MS — was room-swap machinery for a swap that no longer exists.
 * Deleting it deletes the PAC-3-era blink mechanism's last habitat: no frame of the entry
 * can be blank or mispositioned because NOTHING swaps — the bloom is one CSS transition
 * inside a never-moving room. */

/* The painted element that owns hover. Resolved once; the module only runs on the pill page. */
const pillEl = document.getElementById('pillB');

pillEl?.addEventListener('mouseenter', () => {
  if (style !== 'B') return;
  if (collapseTimer !== null) { clearTimeout(collapseTimer); collapseTimer = null; } // hysteresis (re-entry always cancels)
  if (bloomed) return;
  bloomed = true; // logical state FIRST — collapse/circle-click logic must stay correct
  pillEl.classList.add('bloomed'); /* CSS bloom starts: width 28→112, left 52→10, middle-out */
  requireBridge('bloom')?.bloom(true); /* bridge contract kept — main's stub is a no-op */
});
pillEl?.addEventListener('mouseleave', () => {
  if (style !== 'B' || !bloomed || collapseTimer !== null) return;
  collapseTimer = window.setTimeout(forceCollapse, COLLAPSE_HYSTERESIS_MS);
});

/* Word clicks flip modes — ALWAYS (C2g-hotfix-1 FIX 2): the pill must never veto from its own
 * possibly-stale `current`; main-side applyMode no-ops same-mode switches, so a redundant send
 * is safe. `current` is kept for rendering only. */
for (const [id, side] of [['btn-cloud-a', 'cloud'], ['btn-local-a', 'local'], ['btn-cloud-b', 'cloud'], ['btn-local-b', 'local']] as const) {
  document.getElementById(id)?.addEventListener('click', () => {
    requireBridge('flip')?.flip(side);
  });
}

/* C2g-hotfix-1 FIX 1 — the at-rest circle IS the button: clicking ANYWHERE on the 28 × 28
 * Style B circle flips to the OTHER mode (owner: "if someone clicks it, it switches to the
 * other way around"). Bloomed clicks no-op here — the words handle their own sides (and the
 * .inner pointer-events rule makes rest-state clicks unreachable by the hidden buttons). */
document.getElementById('pillB')?.addEventListener('click', () => {
  if (bloomed) return;
  requireBridge('flip')?.flip(current === 'cloud' ? 'local' : 'cloud');
});

/* Right-click: toggle style, suppress THIS layer's context menu only. */
root?.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  applyStyle(style === 'A' ? 'B' : 'A');
  requireBridge('setStyle')?.setStyle(style); // main persists + re-asserts bounds
});

if (!getBridge()) {
  // Loud at load, but NOT fatal: getBridge() keeps retrying on every click (FIX 3).
  console.error('[pill] dropsyncPill bridge missing at load — will retry on every click');
}

applyStyle(style); // boot class lands before first paint of the pill itself

// C2g FIX 5 — dev fixture (?e2e=1, which MAIN appends only under DROPSYNC_CLOUD_DEV): lets the
// battery read the layer's live truth. Read-only; actions still ride the real event paths.
// C2g-hotfix-1: `mode` exposes the rendered side so the real-click robot can assert the knob/dot
// truth, not just main's appMode.
if (new URLSearchParams(window.location.search).get('e2e') === '1') {
  (window as unknown as Record<string, unknown>).__c2gPill = {
    get style(): string { return style; },
    get bloomed(): boolean { return bloomed; },
    get mode(): string { return current; },
  };
}

