/**
 * C2j — preload for the reminder card layer. Deliberately MINIMAL — a clone of the pill
 * preload's security shape (contextBridge only, least surface, no invoke at all). The ONLY
 * outbound capability is `card:click` (reportClick, string-validated). Two validated ONE-WAY
 * receivers (`card:show`, `card:hide`) carry the show/hide choreography from main — they expose
 * no capabilities of their own; without them the layer cannot function. No vault, no dialog,
 * no shell — the card layer stays a least-privileged surface like the pill.
 */

import { contextBridge, ipcRenderer } from 'electron';

const api = {
  /** The card was clicked → main dismisses it and focuses/restores the window. */
  reportClick: (id: string): void => {
    if (typeof id !== 'string' || id.length === 0 || id.length > 64) return;
    ipcRenderer.send('card:click', id);
  },
  /** Main pushes a card to display (id/title/body validated; the page is a dumb surface). */
  onShow: (cb: (p: { id: string; title: string; body: string }) => void): (() => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, p: { id: string; title: string; body: string }): void => {
      if (!p || typeof p.id !== 'string' || typeof p.title !== 'string' || typeof p.body !== 'string') return;
      cb(p);
    };
    ipcRenderer.on('card:show', wrapped);
    return () => {
      ipcRenderer.removeListener('card:show', wrapped);
    };
  },
  /** Main hides the current card (auto-dismiss or click-dismiss — same choreography). */
  onHide: (cb: () => void): (() => void) => {
    const wrapped = (): void => cb();
    ipcRenderer.on('card:hide', wrapped);
    return () => {
      ipcRenderer.removeListener('card:hide', wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('dropsyncCard', api);
