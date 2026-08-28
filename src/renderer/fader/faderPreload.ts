/**
 * C2m — preload for the flip-dissolve fader layer. Deliberately MINIMAL — a clone of the card
 * preload's security shape (contextBridge only, least surface, no invoke at all). C2m-hotfix-1
 * (THE COVERED SWAP): the channel set is FOUR, still the least-privilege family. Down: ONE
 * validated receiver (`fader:show` — snapshot + duration) and `fader:run` (payload-less — the
 * fade trigger). Up: TWO payload-less senders, `fader:ready` (the snapshot is painted — main
 * may swap the world beneath it) and `fader:done` (the melt settled — collapse). No click, no
 * hide — the fader is the only layer with no user affordance at all. No vault, no dialog, no
 * shell — a least-privileged surface like the pill and card.
 */

import { contextBridge, ipcRenderer } from 'electron';

/** The ONLY legal image ingest: a PNG snapshot from main's capturePage, as a data URL. */
const isPngDataUrl = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 8_000_000 && v.startsWith('data:image/png;base64,');

const api = {
  /** Main pushes a melt: the outgoing world's still frame + the fade duration. Payload
   * validated here (image must be a data:image/png URL, ms a finite 0–1000 number); the page
   * is a dumb surface. */
  onShow: (cb: (p: { image: string; ms: number }) => void): (() => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, p: { image: string; ms: number }): void => {
      if (!p || !isPngDataUrl(p.image)) return;
      if (typeof p.ms !== 'number' || !Number.isFinite(p.ms) || p.ms < 0 || p.ms > 1000) return;
      cb(p);
    };
    ipcRenderer.on('fader:show', wrapped);
    return () => {
      ipcRenderer.removeListener('fader:show', wrapped);
    };
  },
  /** C2m-hotfix-1 — main fires the fade (the world swap is COMPLETE beneath the painted
   * curtain). Payload-less. */
  onRun: (cb: () => void): (() => void) => {
    const wrapped = (): void => cb();
    ipcRenderer.on('fader:run', wrapped);
    return () => {
      ipcRenderer.removeListener('fader:run', wrapped);
    };
  },
  /** The snapshot is fully PAINTED (woken opaque + decoded + committed) — main may now swap
   * the world beneath the curtain. Payload-less. */
  reportReady: (): void => {
    ipcRenderer.send('fader:ready');
  },
  /** The melt settled (transitionend or the page's safety net) → main collapses the layer. */
  reportDone: (): void => {
    ipcRenderer.send('fader:done');
  },
};

contextBridge.exposeInMainWorld('dropsyncFader', api);
