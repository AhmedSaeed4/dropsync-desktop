/**
 * C2f FIX 2 — preload for the floating pill layer. Deliberately MINIMAL: the ONLY capabilities
 * are (a) sending the one `pill:flip` ipc and (b) receiving `pill:setMode`. No vault, no dialog,
 * no shell, no invoke at all — the pill layer must stay the least-privileged surface in the app.
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
};

contextBridge.exposeInMainWorld('dropsyncPill', api);
