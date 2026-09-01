/**
 * PAC-2 FIX B — preload for OUR share picker (the sixth trusted local page). Card-recipe
 * security shape: contextBridge only, least surface, no invoke at all. Up (validated
 * senders): picker:ready (handshake — main answers with the source list),
 * picker:pick (ONE validated sender: {id, audio}), picker:cancel. Down (validated receiver):
 * picker:sources. No vault, no dialog, no shell — the picker stays a least-privileged
 * surface exactly like the pill/card/fader/status layers.
 */

import { contextBridge, ipcRenderer } from 'electron';

const api = {
  /** The picker page's DOM is up — main answers with picker:sources and shows the window. */
  ready: (): void => {
    ipcRenderer.send('picker:ready');
  },
  /** The owner picked a source. ONE validated sender: id is a short string, audio a boolean. */
  pick: (id: unknown, audio: unknown): void => {
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) return;
    if (typeof audio !== 'boolean') return;
    ipcRenderer.send('picker:pick', id, audio);
  },
  /** Esc / ✕ / nothing-to-share cancel. */
  cancel: (): void => {
    ipcRenderer.send('picker:cancel');
  },
  /** Main pushes the validated payload: { theme, canLoopback, sources: [{id, name, isScreen,
   * thumbnail, appIcon}] }. The payload is main-built and main-validated; the PAGE
   * normalizes the theme against its whitelist (card:show precedent). */
  onSources: (cb: (p: unknown) => void): (() => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, p: unknown): void => {
      cb(p);
    };
    ipcRenderer.on('picker:sources', wrapped);
    return () => {
      ipcRenderer.removeListener('picker:sources', wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('dropsyncPicker', api);
