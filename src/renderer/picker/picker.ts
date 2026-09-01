/**
 * PAC-2 FIX B — the picker PAGE. A dumb, trusting-nothing surface: main pushes one validated
 * payload (dropsyncPicker.onSources), the page renders screens/windows as cards (thumbnail +
 * textContent-only label + app-icon badge) and reports exactly three things back — ready on
 * boot, pick {id, audio} on a card click, cancel on ✕/Esc. The "Include system audio"
 * checkbox exists only when main said canLoopback; it persists to the page's localStorage
 * ('dropsync.picker.audio') the way Chrome remembers it. An empty source list renders the
 * honest "Nothing to share found" and cancels — never a blank window.
 */

interface PickerSource {
  id: unknown;
  name: unknown;
  isScreen: unknown;
  thumbnail: unknown;
  appIcon: unknown;
}

interface PickerPayload {
  theme?: unknown;
  canLoopback?: unknown;
  sources?: unknown;
}

const bridge = (window as unknown as { dropsyncPicker?: {
  ready: () => void;
  pick: (id: string, audio: boolean) => void;
  cancel: () => void;
  onSources: (cb: (p: unknown) => void) => () => void;
} }).dropsyncPicker;

const AUDIO_KEY = 'dropsync.picker.audio';

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Same tolerant normalization family the card/status pages use (unknown ⇒ light). */
function normTheme(v: unknown): 'light' | 'dark' | 'minimal' {
  return v === 'dark' || v === 'minimal' ? v : 'light';
}

function storedAudioPref(): boolean {
  try { return localStorage.getItem(AUDIO_KEY) === 'true'; } catch { return false; }
}

function rememberAudioPref(on: boolean): void {
  try { localStorage.setItem(AUDIO_KEY, on ? 'true' : 'false'); } catch { /* private mode */ }
}

function makeSourceCard(src: PickerSource): HTMLButtonElement | null {
  // The payload is main-built, but the page still validates every field it touches.
  if (typeof src.id !== 'string' || src.id.length === 0) return null;
  if (typeof src.name !== 'string' || typeof src.thumbnail !== 'string') return null;
  const isScreen = src.isScreen === true;

  const card = document.createElement('button');
  card.className = 'src';
  card.type = 'button';
  card.dataset.id = src.id;

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  const img = document.createElement('img');
  img.src = src.thumbnail; // main-built PNG dataURL; CSP img-src data: is the whole allowlist
  img.alt = '';
  img.draggable = false;
  thumb.appendChild(img);
  if (typeof src.appIcon === 'string') {
    thumb.classList.add('has-badge');
    const badge = document.createElement('div');
    badge.className = 'badge';
    const badgeImg = document.createElement('img');
    badgeImg.src = src.appIcon;
    badgeImg.alt = '';
    badgeImg.draggable = false;
    badge.appendChild(badgeImg);
    thumb.appendChild(badge);
  }

  const label = document.createElement('div');
  label.className = 'lbl';
  // Window title, or "Entire Screen"/"Screen N" for displays (textContent ONLY — never HTML).
  if (isScreen) {
    const m = /^screen:(\d+):.*$/.exec(src.id);
    label.textContent = m && m[1] !== '0' ? `Screen ${m[1]}` : 'Entire Screen';
  } else {
    label.textContent = src.name;
  }

  card.appendChild(thumb);
  card.appendChild(label);
  card.addEventListener('click', () => {
    const audio = el<HTMLInputElement>('audioChk').checked;
    bridge?.pick(src.id as string, audio);
  });
  return card;
}

function render(p: unknown): void {
  const payload = (p ?? {}) as PickerPayload;
  document.documentElement.setAttribute('data-picker-theme', normTheme(payload.theme));

  const canLoopback = payload.canLoopback === true;
  el<HTMLDivElement>('audioRow').classList.toggle('on', canLoopback);
  const chk = el<HTMLInputElement>('audioChk');
  chk.checked = storedAudioPref(); // remembered like Chrome does (default OFF until chosen)

  const rawSources = Array.isArray(payload.sources) ? (payload.sources as PickerSource[]) : [];
  const screens = el<HTMLDivElement>('screens');
  const windows = el<HTMLDivElement>('windows');
  screens.textContent = '';
  windows.textContent = '';
  let screenCount = 0;
  let windowCount = 0;
  for (const src of rawSources) {
    const card = makeSourceCard(src);
    if (!card) continue;
    if (src.isScreen === true) { screens.appendChild(card); screenCount += 1; }
    else { windows.appendChild(card); windowCount += 1; }
  }
  el<HTMLDivElement>('screensGrp').style.display = screenCount > 0 ? 'block' : 'none';
  el<HTMLDivElement>('windowsGrp').style.display = windowCount > 0 ? 'block' : 'none';

  const empty = rawSources.length === 0;
  el<HTMLDivElement>('empty').style.display = empty ? 'block' : 'none';
  if (empty) {
    // Honest empty state — never a blank window: report nothing shareable and cancel.
    bridge?.cancel();
  }
}

el<HTMLButtonElement>('close').addEventListener('click', () => bridge?.cancel());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') bridge?.cancel();
});
el<HTMLInputElement>('audioChk').addEventListener('change', () => {
  rememberAudioPref(el<HTMLInputElement>('audioChk').checked);
});

bridge?.onSources(render);
bridge?.ready();
