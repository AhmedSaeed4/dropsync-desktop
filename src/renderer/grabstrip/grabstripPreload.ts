/**
 * R127 B2(b) — preload for the top-band layer (the permanent dark strip at the top of the window, both modes). Deliberately MINIMAL: three
 * one-way senders (press / release / Escape-cancel) and nothing else. No vault, no dialog, no
 * shell, no invoke, no listeners — the least-privileged surface in the app, same posture as
 * pillPreload.ts. The page can never touch the site or ask main to execute anything there.
 */

import { contextBridge, ipcRenderer } from 'electron';

const api = {
  down: (): void => {
    ipcRenderer.send('grabstrip:down');
  },
  up: (): void => {
    ipcRenderer.send('grabstrip:up');
  },
  cancel: (): void => {
    ipcRenderer.send('grabstrip:cancel');
  },
};

contextBridge.exposeInMainWorld('dropsyncGrabstrip', api);
