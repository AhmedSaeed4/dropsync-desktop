/**
 * C3 — preload for the status layer. Deliberately MINIMAL — a clone of the card/fader preload
 * security shape (contextBridge only, least surface, no invoke at all). CHANNEL INVENTORY
 * (complete — nothing beyond this set may exist):
 *   DOWN `status:show`     — validated receiver: {kind:'download'|'offline', label, pulse?,
 *                            progress?, action?:'cancel'|'switch-local'|null, veil?, title?,
 *                            body?, theme? (raw; the PAGE normalizes it, C2k pattern)}
 *   DOWN `status:progress` — validated receiver: {fraction:number|null, label?:string}
 *   DOWN `status:hide`     — validated receiver: {flash?:string}
 *   UP   `status:action`   — enum-checked sender {id:'cancel'|'switch-local'|'retry'} (the chip
 *                            button + the veil's two buttons; the page sends NOTHING else)
 *   UP   `status:measure`  — validated sender {width:number} (natural chip/flash content width,
 *                            reported on every content change; main sizes the native room to it)
 * No vault, no dialog, no shell — a least-privileged surface like the pill/card/fader.
 */

import { contextBridge, ipcRenderer } from 'electron';

const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
/** The chip label may legitimately be EMPTY (the offline veil shows title/body, no chip
 * label) — only bound its length. */
const isLabel = (v: unknown): v is string => typeof v === 'string' && v.length <= 200;
const STATUS_ACTIONS = ['cancel', 'switch-local', 'retry'] as const;
type StatusAction = (typeof STATUS_ACTIONS)[number];

const api = {
  /** Main pushes a presentation: chip (download / waiting-for-internet) or veil (offline card).
   * Payload validated here; `theme` passes through RAW (string or absent) — the PAGE normalizes
   * it against the whitelist so the preload adds no opinion of its own (card:show precedent). */
  onShow: (cb: (p: {
    kind: 'download' | 'offline';
    label: string;
    pulse?: boolean;
    progress?: boolean;
    action?: 'cancel' | 'switch-local' | null;
    veil?: boolean;
    title?: string;
    body?: string;
    theme?: unknown;
  }) => void): (() => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, p: unknown): void => {
      if (!p || typeof p !== 'object') return;
      const q = p as Record<string, unknown>;
      if (q.kind !== 'download' && q.kind !== 'offline') return;
      if (!isLabel(q.label)) return;
      if (q.pulse !== undefined && typeof q.pulse !== 'boolean') return;
      if (q.progress !== undefined && typeof q.progress !== 'boolean') return;
      if (q.action !== undefined && q.action !== null && !(STATUS_ACTIONS as readonly unknown[]).includes(q.action as never)) return;
      if (q.veil !== undefined && typeof q.veil !== 'boolean') return;
      if (q.title !== undefined && !isStr(q.title, 300)) return;
      if (q.body !== undefined && !isStr(q.body, 300)) return;
      cb(q as never);
    };
    ipcRenderer.on('status:show', wrapped);
    return () => {
      ipcRenderer.removeListener('status:show', wrapped);
    };
  },
  /** Progress for the CURRENT chip: fraction 0..1, or null when the total size is unknown
   * (the page then shows the pulsing dot, no %). */
  onProgress: (cb: (p: { fraction: number | null; label?: string }) => void): (() => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, p: unknown): void => {
      if (!p || typeof p !== 'object') return;
      const q = p as Record<string, unknown>;
      if (q.fraction !== null && (typeof q.fraction !== 'number' || !Number.isFinite(q.fraction) || q.fraction < 0 || q.fraction > 1)) return;
      if (q.label !== undefined && !isStr(q.label, 200)) return;
      cb(q as { fraction: number | null; label?: string });
    };
    ipcRenderer.on('status:progress', wrapped);
    return () => {
      ipcRenderer.removeListener('status:progress', wrapped);
    };
  },
  /** Main hides the current presentation; `flash` shows the paper ✓-chip for ~1.4 s instead
   * (main owns the native collapse timing — the page only plays its own fade). */
  onHide: (cb: (p: { flash?: string }) => void): (() => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, p: unknown): void => {
      if (!p || typeof p !== 'object') return;
      const q = p as Record<string, unknown>;
      if (q.flash !== undefined && !isStr(q.flash, 64)) return;
      cb(q as { flash?: string });
    };
    ipcRenderer.on('status:hide', wrapped);
    return () => {
      ipcRenderer.removeListener('status:hide', wrapped);
    };
  },
  /** A user action landed (the ONLY user affordance on this layer): chip [Cancel] /
   * veil [Switch to Local] / veil [Try again]. Enum-checked — everything else is dropped. */
  reportAction: (id: StatusAction): void => {
    if (!(STATUS_ACTIONS as readonly unknown[]).includes(id)) return;
    ipcRenderer.send('status:action', { id });
  },
  /** The natural content width of the chip/flash — main clamps it to ≤60% of the window and
   * sizes the native room to EXACTLY the result (zero-miss click rule). */
  reportMeasure: (width: number): void => {
    if (typeof width !== 'number' || !Number.isFinite(width) || width < 0 || width > 2000) return;
    ipcRenderer.send('status:measure', { width: Math.ceil(width) });
  },
};

contextBridge.exposeInMainWorld('dropsyncStatus', api);
