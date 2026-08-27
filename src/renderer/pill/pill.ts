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
 * - Style B hover ⇒ JS-driven bloom (NOT :hover): the same tick the CSS class lands we tell
 *   main via `pill:bloom` so the native view footprint and the CSS width animate together
 *   (§1 ZERO-MISS CLICK RULE). A 90 ms collapse hysteresis (documented deviation-free: §1
 *   allows small hysteresis) swallows accidental edge-grazes without changing any timing.
 * - Right-click ANYWHERE on the layer toggles A ⇄ B, suppresses the native context menu on
 *   THIS LAYER ONLY, and persists through main (`pill:setStyle`).
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

/** C2g-hotfix-5 FIX 1 — SAFETY ceiling for the entry reveal poll. This is a safety timeout,
 * NOT an animation timing and NOT part of the ANIMATION CONTRACT: it only bounds how long the
 * blank-paint swap gate may hold the paint if the native room never lands (broken-install path —
 * bridge missing ⇒ no room swap; the loud bridge errors already fire). Normal reveals take
 * ≈2–4 frames, far below this. */
const PILL_REVEAL_TIMEOUT_MS = 250;

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
  requireBridge('bloom')?.bloom(false); /* …same tick main shrinks the view */
}

/* Bloom in/out — driven by the layer's own mouseenter/mouseleave (root == the native view
 * footprint), so "leave" fires only when the cursor truly exits the CURRENT footprint.
 * C2g-hotfix-4 FIX 3 — the 90 ms collapse LAG must never close the pill UNDER the cursor: a
 * fast graze (out ~1 px, back within 90 ms) used to leave `forceCollapse` armed behind the
 * `bloomed` short-circuit, so it fired with the pointer inside and hover went stale until a
 * full exit/re-enter. The timer clear now runs BEFORE any early-return; only the style gate
 * precedes it. No timing values change.
 *
 * C2g-hotfix-5 FIX 1 — ENTRY CHOREOGRAPHY (blank-paint swap gate). Main resizes the native room
 * 28 → 132 in one instant step the same tick we ask; Chromium can present 1–3 STALE frames of
 * the old bitmap anchored at the NEW room's top-left before the first re-laid-out frame arrives
 * — the owner saw "a few frames coming from the left." So: set logical state FIRST, blank the
 * paint INSTANTLY and transition-free (inline `visibility:hidden` — NOT opacity; the dots/inner
 * own their opacity transitions), THEN send `pill:bloom(true)` so the swap happens over a blank
 * page, then REVEAL only when the page can see that the room landed (`innerWidth > 28`) — the
 * CSS bloom then starts fresh from width 28 in its FINAL room. Reveal always re-checks
 * `bloomed`: a graze that collapsed during the hidden window restores clean rest paint instead
 * of resurrecting a dead bloom, and the safety timeout guarantees no stuck-hidden paint. */
root?.addEventListener('mouseenter', () => {
  if (style !== 'B') return;
  if (collapseTimer !== null) { clearTimeout(collapseTimer); collapseTimer = null; } // hysteresis (re-entry always cancels)
  if (bloomed) return;
  bloomed = true; // logical state FIRST — collapse/circle-click logic must stay correct while hidden
  const pillEl = document.getElementById('pillB');
  if (!pillEl) return;
  if (window.innerWidth > 28) {
    // C2g-hotfix-6 FIX 1 — RE-ENTRY while the room is ALREADY big (collapse hold pending or a
    // just-regrown bloom): NO gate, NO visibility churn, NO poll. Nothing here can flash, so
    // nothing may blink — the old unconditional hide could present one fully-blank frame when
    // this configuration raced real-machine scheduling (the owner's caught-on-frame blink).
    // bloom(true) lands on main's existing 132 × 44 hold and CANCELS it — the room never
    // shrinks under the returning cursor.
    // Accepted micro-residual (do NOT blank for it): if main's snap fired between the owner's
    // leave and re-entry (knife-edge), the room resizes 132→28→132 around the visible rebloom —
    // ≤2 frames of ≤6 px settle twitch on small mid-shrink paint.
    pillEl.classList.add('bloomed'); /* CSS rebloom starts from the CURRENT width */
    requireBridge('bloom')?.bloom(true);
    return;
  }
  /* FROM REST (room still exactly 28): the full hotfix-5 entry choreography — hide the paint
   * INSTANTLY and transition-free (inline `visibility:hidden`; NOT opacity — the dots/inner own
   * their opacity transitions), send `pill:bloom(true)` so the native swap happens over BLANK
   * paint, then reveal ONLY when the page can see that the room landed (`innerWidth > 28`) —
   * the CSS bloom starts fresh from width 28 in its FINAL room. The reveal re-checks `bloomed`
   * (a graze that collapsed during the hidden window restores clean rest paint instead of
   * resurrecting a dead bloom); the safety timeout guarantees no stuck-hidden paint. */
  pillEl.style.visibility = 'hidden'; /* instant, transition-free blank across the room swap */
  pillEl.classList.remove('bloomed');
  requireBridge('bloom')?.bloom(true); /* room swaps over blank paint */
  const startedAt = Date.now();
  const reveal = (): void => {
    if (!bloomed) { // collapsed while hidden (fast graze): restore clean REST paint, no bloom class
      pillEl.style.visibility = '';
      return;
    }
    if (window.innerWidth > 28 || Date.now() - startedAt >= PILL_REVEAL_TIMEOUT_MS) {
      // Room landed (or safety timeout fired) — start the CSS bloom fresh from width 28 in
      // the FINAL room, then unblank in the same tick.
      pillEl.classList.add('bloomed'); /* CSS starts… */
      pillEl.style.visibility = ''; /* …reveal exactly when the bloom starts */
      return;
    }
    requestAnimationFrame(reveal);
  };
  requestAnimationFrame(reveal);
});
root?.addEventListener('mouseleave', () => {
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

