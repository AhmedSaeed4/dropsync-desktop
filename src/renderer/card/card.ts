/**
 * C2j — the reminder card page logic (vanilla TS; the ONLY script in the card layer, mirroring
 * pill.ts's role). Main pushes `card:show`/`card:hide` through the preload bridge; the page is
 * a dumb surface: populate title/body ("Reminder" rides as the secondary line in main's body
 * string), toggle the .show class (180 ms ease-out scale/fade; instant under
 * prefers-reduced-motion via CSS), and forward clicks (`card:click` ⇒ main dismisses + focuses).
 *
 * NO timers live here — AUTO_DISMISS_MS / NEXT_GAP_MS are MAIN-side so dismissal stays
 * race-safe under rapid fire (serial pump, per-card timer, cancel-on-click).
 */

interface CardBridge {
  reportClick(id: string): void;
  onShow(cb: (p: { id: string; title: string; body: string }) => void): () => void;
  onHide(cb: () => void): () => void;
}

declare global {
  interface Window {
    dropsyncCard: CardBridge;
  }
}

const card = document.getElementById('card')!;
const titleEl = document.getElementById('title')!;
const bodyEl = document.getElementById('body')!;
let currentId: string | null = null;

window.dropsyncCard.onShow((p) => {
  if (!p || typeof p.id !== 'string' || typeof p.title !== 'string' || typeof p.body !== 'string') return;
  currentId = p.id;
  titleEl.textContent = p.title;
  bodyEl.textContent = p.body;
  card.classList.add('show');
});

window.dropsyncCard.onHide(() => {
  currentId = null;
  card.classList.remove('show');
});

card.addEventListener('click', () => {
  if (currentId) window.dropsyncCard.reportClick(currentId);
});
