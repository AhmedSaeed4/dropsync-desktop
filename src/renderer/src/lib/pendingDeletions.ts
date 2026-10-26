/**
 * Module-level singleton store for single-drop delete-with-undo — port of the web's
 * lib/pendingDeletions.ts (PR #168 architecture). Process-global on desktop too, which is a
 * PERFECT fit: the renderer process lives for the whole app session, so the 30s window even
 * survives layout remounts. The only change from the web: the real delete goes through IPC
 * (window.dropsync.drop.delete) instead of Firestore. FIX 13: on success the parent now
 * receives the drop ID and removes it IN PLACE (no refetch) — the tombstone already hid the
 * card, so the behind-the-curtain commit is a zero-visual-event sync.
 */

import { useSyncExternalStore } from 'react';
import type { Drop } from './types';

const DELETE_DELAY_MS = 30000;

interface PendingDeletion {
  drop: Drop;
  timeoutId: ReturnType<typeof setTimeout>;
  expiresAt: number;
}

interface PendingDeletionsSnapshot {
  pending: Map<string, PendingDeletion>;
  tombstone: Set<string>;
}

/** FIX 13: the commit callback now carries the committed drop id (in-place removal). */
type OnDeleted = (dropId: string) => void;

const pending = new Map<string, PendingDeletion>();
const tombstone = new Set<string>();
const listeners = new Set<() => void>();

let snapshot: PendingDeletionsSnapshot = {
  pending: new Map(),
  tombstone: new Set(),
};

/** Rebuild the cached snapshot with NEW Map/Set references (never mutate in place). */
function notify() {
  snapshot = {
    pending: new Map(pending),
    tombstone: new Set(tombstone),
  };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return snapshot;
}

function removePending(dropId: string) {
  pending.delete(dropId);
  notify();
}

/**
 * The real delete via IPC. Tombstone set SYNCHRONOUSLY before the await (double-fire guard).
 * FIX 13: on success the tombstone STAYS (the id is now gone from dropsRaw entirely, so it
 * could never match again) and the parent removes the id in place — no refetch, no skeleton.
 * On failure the tombstone is released so the drop re-appears (retry isn't blocked).
 */
async function performDelete(drop: Drop, onDeleted: OnDeleted) {
  if (tombstone.has(drop.id)) return;
  tombstone.add(drop.id);
  notify();
  try {
    const ok = await window.dropsync.drop.delete(drop.id);
    if (ok) {
      onDeleted(drop.id);
    } else {
      tombstone.delete(drop.id);
    }
  } catch {
    tombstone.delete(drop.id);
  }
  notify();
}

/** Begin a single-drop delete with a 30s undo window. */
export function requestDelete(drop: Drop, onDeleted: OnDeleted) {
  const expiresAt = Date.now() + DELETE_DELAY_MS;
  const timeoutId = setTimeout(() => {
    performDelete(drop, onDeleted);
    removePending(drop.id);
  }, DELETE_DELAY_MS);

  pending.set(drop.id, { drop, timeoutId, expiresAt });
  notify();
}

/** Undo within the 30s window. NEVER touches the tombstone (undo re-shows the drop). */
export function undo(dropId: string) {
  const entry = pending.get(dropId);
  if (entry) {
    clearTimeout(entry.timeoutId);
  }
  pending.delete(dropId);
  notify();
}

/** Toast dismiss (or undo-window expiry): cancel the timer, fire the real delete now. */
export function dismiss(dropId: string, onDeleted: OnDeleted) {
  const entry = pending.get(dropId);
  if (entry) {
    clearTimeout(entry.timeoutId);
    performDelete(entry.drop, onDeleted);
  }
  pending.delete(dropId);
  notify();
}

/** React binding — stable snapshot reference between notifies. */
export function usePendingDeletions(): PendingDeletionsSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
