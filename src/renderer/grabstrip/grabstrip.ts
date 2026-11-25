/**
 * FINAL - the page of the ONE full-width permanent top band (31 px, painted BAND_COLOR by
 * main). It paints nothing itself and knows nothing about the site; its only job is to relay
 * press/release over the least-privileged bridge into main manual drag loop (RULING B):
 * main tracks the cursor at <=16 ms with DIP deltas; pointerup, Escape and blur end it.
 * Focus is never taken and the band is visible in both Local and Cloud.
 */

interface GrabstripBridge {
  down(): void;
  up(): void;
  cancel(): void;
}

declare global {
  interface Window {
    dropsyncGrabstrip?: GrabstripBridge;
  }
}

const bridge = window.dropsyncGrabstrip;
if (bridge) {
  document.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0) return; // primary press only
    event.preventDefault();
    bridge.down();
  });
  window.addEventListener('pointerup', () => bridge.up());
  window.addEventListener('pointercancel', () => bridge.up());
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') bridge.cancel();
  });
  window.addEventListener('blur', () => bridge.up());
}
