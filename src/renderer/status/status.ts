/**
 * C3 — the status page logic (vanilla TS; the ONLY script in the status layer, mirroring
 * card.ts's role). A dumb presentation surface: main owns ALL choreography and collapse
 * timing (status:show / status:progress / status:hide); the page paints, measures, and
 * forwards button clicks (status:action) — nothing else.
 *
 * Shows: `void offsetWidth` reflow, THEN reportMeasure — main sizes the native room to the
 * natural content width clamped to ≤60% of the window (zero-miss click rule: bounds ==
 * visible footprint at all times). Veil shows dress the root data-status-theme attribute
 * BEFORE the reveal (C2k pattern; theme normalized against the whitelist page-side).
 *
 * prefers-reduced-motion: transitions are killed in CSS (status.html) — unlike the fader,
 * nothing here depends on transitionend, so a CSS clamp is safe.
 */

import '@fontsource-variable/raleway';

/** C3 D1 — flash dwell (~1.4 s) mirrors main's STATUS_FLASH_MS collapse hold. */
const FLASH_MS = 1400;

const STATUS_THEMES = ['light', 'dark', 'minimal'] as const;
type StatusTheme = (typeof STATUS_THEMES)[number];
const normTheme = (v: unknown): StatusTheme =>
  (STATUS_THEMES as readonly unknown[]).includes(v) ? (v as StatusTheme) : 'light';

interface StatusBridge {
  onShow(cb: (p: {
    kind: 'download' | 'offline';
    label: string;
    pulse?: boolean;
    progress?: boolean;
    action?: 'cancel' | 'switch-local' | null;
    veil?: boolean;
    title?: string;
    body?: string;
    theme?: unknown;
  }) => void): () => void;
  onProgress(cb: (p: { fraction: number | null; label?: string }) => void): () => void;
  onHide(cb: (p: { flash?: string }) => void): () => void;
  reportAction(id: 'cancel' | 'switch-local' | 'retry'): void;
  reportMeasure(width: number): void;
}

declare global {
  interface Window {
    dropsyncStatus: StatusBridge;
  }
}

const chip = document.getElementById('chip')!;
const dot = document.getElementById('dot')!;
const msg = document.getElementById('msg')!;
const track = document.getElementById('track')!;
const fill = document.getElementById('fill')!;
const pct = document.getElementById('pct')!;
const act = document.getElementById('act') as HTMLButtonElement;
const flash = document.getElementById('flash')!;
const veil = document.getElementById('veil')!;
const offTitle = document.getElementById('offTitle')!;
const offBody = document.getElementById('offBody')!;

let actId: 'cancel' | 'switch-local' | null = null;
let flashTimer: ReturnType<typeof setTimeout> | null = null;

/** Natural content width → main (the native room must EQUAL the visible chip, zero-miss). */
const measure = (el: HTMLElement): void => {
  void el.offsetWidth; // commit the new content BEFORE measuring
  window.dropsyncStatus.reportMeasure(el.offsetWidth);
};

const hideAll = (): void => {
  chip.classList.remove('showC');
  veil.classList.remove('showV');
  if (flashTimer !== null) {
    clearTimeout(flashTimer);
    flashTimer = null;
  }
  flash.classList.remove('showF');
};

window.dropsyncStatus.onShow((p) => {
  hideAll();
  if (p.veil) {
    // The veil wears the app's CURRENT theme — dressed BEFORE the reveal (C2k discipline).
    document.documentElement.dataset.statusTheme = normTheme(p.theme);
    offTitle.textContent = p.title ?? '';
    offBody.textContent = p.body ?? '';
    veil.classList.add('showV');
    return; // the veil's room is the full window — no measure needed
  }
  msg.textContent = p.label;
  dot.classList.toggle('pulse', !!p.pulse);
  track.style.display = p.progress ? '' : 'none';
  pct.style.display = p.progress ? '' : 'none';
  pct.textContent = '';
  fill.style.width = '0%';
  actId = p.action ?? null;
  act.style.display = actId ? '' : 'none';
  if (actId) act.textContent = actId === 'cancel' ? 'Cancel' : 'Switch to Local';
  chip.classList.add('showC');
  measure(chip);
});

window.dropsyncStatus.onProgress(({ fraction, label }) => {
  if (label !== undefined) msg.textContent = label;
  if (fraction === null) {
    fill.style.width = '0%';
    pct.textContent = '';
    return;
  }
  fill.style.width = `${Math.round(fraction * 100)}%`;
  pct.textContent = `${Math.round(fraction * 100)}%`;
});

window.dropsyncStatus.onHide(({ flash: flashText }) => {
  chip.classList.remove('showC');
  veil.classList.remove('showV');
  if (!flashText) return; // plain hide — main collapses the native room on its own schedule
  flash.textContent = flashText;
  flash.classList.add('showF');
  measure(flash);
  if (flashTimer !== null) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flashTimer = null;
    flash.classList.remove('showF');
  }, FLASH_MS);
});

act.addEventListener('click', () => {
  if (actId) window.dropsyncStatus.reportAction(actId);
});
document.getElementById('offLocal')!.addEventListener('click', () => {
  window.dropsyncStatus.reportAction('switch-local');
});
document.getElementById('offRetry')!.addEventListener('click', () => {
  window.dropsyncStatus.reportAction('retry');
});
