/**
 * C2f FIX 2 — preload for the floating pill layer. Deliberately MINIMAL: the ONLY capabilities
 * are (a) sending the one `pill:flip` ipc and (b) receiving `pill:setMode`. No vault, no dialog,
 * no shell, no invoke at all — the pill layer must stay the least-privileged surface in the app.
 *
 * C2g adds exactly two more ONE-WAY senders, both strictly validated, for the punch-hole/bloom
 * contract: `pill:bloom` (Style B hover-enter/leave → main resizes the overlay footprint) and
 * `pill:setStyle` (right-click style toggle → main persists + re-asserts bounds). Still no
 * invoke.
 *
 * C2g-hotfix-1 FIX 3 adds the boot handshake: the layer sends `pill:ready` on load; main replies
 * IMMEDIATELY with the true mode (`pill:setMode`, existing channel) and the true style if it
 * differs (`pill:styleChanged`). Still the least-privileged surface in the app.
 */

import { contextBridge, ipcRenderer } from 'electron';

const api = {
  flip: (next: 'cloud' | 'local'): void => {
    if (next !== 'cloud' && next !== 'local') return;
    ipcRenderer.send('pill:flip', next);
  },
  onSetMode: (cb: (mode: 'cloud' | 'local') => void): (() => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, mode: 'cloud' | 'local'): void => {
      if (mode === 'cloud' || mode === 'local') cb(mode);
    };
    ipcRenderer.on('pill:setMode', wrapped);
    return () => {
      ipcRenderer.removeListener('pill:setMode', wrapped);
    };
  },
  /** C2g FIX 3 — Style B hover state. Boolean-validated; main ignores it outside Style B. */
  bloom: (on: boolean): void => {
    if (typeof on !== 'boolean') return;
    ipcRenderer.send('pill:bloom', on);
  },
  /** C2g FIX 4 — right-click style toggle. Enum-validated; main persists + resizes. */
  setStyle: (style: 'A' | 'B'): void => {
    if (style !== 'A' && style !== 'B') return;
    ipcRenderer.send('pill:setStyle', style);
  },
  /** C2g-hotfix-1 FIX 3 — the layer ASKS on load: main replies with the true mode (and true
   * style if it differs). Kills the queued-mode race; the boot queue stays as belt-and-braces. */
  ready: (): void => {
    ipcRenderer.send('pill:ready');
  },
  /** C2g-hotfix-1 FIX 3 — main's authoritative style push (the `pill:ready` reply). */
  onStyle: (cb: (style: 'A' | 'B') => void): (() => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, style: 'A' | 'B'): void => {
      if (style === 'A' || style === 'B') cb(style);
    };
    ipcRenderer.on('pill:styleChanged', wrapped);
    return () => {
      ipcRenderer.removeListener('pill:styleChanged', wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('dropsyncPill', api);
