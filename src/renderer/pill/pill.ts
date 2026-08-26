/**
 * C2f FIX 2 — the floating pill page logic (vanilla TS; the ONLY script in the pill layer).
 *
 * The pill NEVER switches modes by itself: a click sends ONE `pill:flip` ipc (via the minimal
 * pillPreload bridge) and main forwards it to the MAIN window renderer, which runs the EXISTING
 * guarded switchMode (unsaved-work discard-confirm included). Only when the mode ACTUALLY applies
 * does main send `pill:setMode` back — only then does the knob slide. Mode reflection ONLY:
 * login state is deliberately unknown here (C2f design contract).
 */

interface PillBridge {
  flip(next: 'cloud' | 'local'): void;
  onSetMode(cb: (mode: 'cloud' | 'local') => void): void;
}

const bridge = (window as unknown as { dropsyncPill?: PillBridge }).dropsyncPill;

const knob = document.getElementById('knob') as HTMLSpanElement | null;
const btnCloud = document.getElementById('btn-cloud') as HTMLButtonElement | null;
const btnLocal = document.getElementById('btn-local') as HTMLButtonElement | null;

let current: 'cloud' | 'local' = 'local';

function render(mode: 'cloud' | 'local'): void {
  current = mode;
  if (knob) knob.style.transform = mode === 'cloud' ? 'translateX(0)' : 'translateX(100%)';
  btnCloud?.classList.toggle('active', mode === 'cloud');
  btnLocal?.classList.toggle('active', mode === 'local');
}

btnCloud?.addEventListener('click', () => {
  if (current !== 'cloud') bridge?.flip('cloud');
});
btnLocal?.addEventListener('click', () => {
  if (current !== 'local') bridge?.flip('local');
});

if (bridge) {
  bridge.onSetMode(render);
} else {
  // Bridge missing = preload failed: the pill would be a dead ornament. Make it loud in dev.
  console.error('[pill] dropsyncPill bridge missing — preload did not load');
}
