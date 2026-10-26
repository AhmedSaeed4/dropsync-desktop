/**
 * App-level center for BULK drop operations (move / copy / delete) — port of the web's
 * lib/operationCenter.ts (record §4 D28). Owns the card list the OperationsPanel renders and
 * runs each operation's items SEQUENTIALLY so the count is honest and Cancel can stop what has
 * not started yet. Per-item safety lives in MAIN (vault.ts deleteDrop / dropOps.ts
 * transferDrops) — this module adds no permission logic of its own. Single-drop
 * delete-with-undo deliberately does NOT go through here (pendingDeletions owns that flow).
 *
 * Desktop deltas (order 125 §4 S1):
 * - No Firestore freshness re-read: main reads the live vault per item. A missing id REJECTS
 *   from drop:delete ('Drop not found: …', vault.ts findDrop) and maps to the web's
 *   missing-item wording; transfer reports it as a per-item 'Drop not found.' failure.
 * - No category pre-resolution: transferDrops ensures target categories per call
 *   (dropOps.ts) — one ensure per single-id call is the accepted trade-off (order §6).
 * - The desktop store is NOT reactive to IPC mutations, so StartParams gains onItemDone
 *   (per-item in-place surgery) alongside the web's onSettled.
 *
 * Store pattern copied from pendingDeletions.ts: module-singleton state + ONE cached snapshot
 * rebuilt only inside notify() (useSyncExternalStore requires a stable reference between
 * notifies). Timers are owned here so they are never orphaned by layout switches.
 */

import { useSyncExternalStore } from 'react';
import type { Drop } from './types';

export type OperationKind = 'move' | 'copy' | 'delete';
export type OperationStatus = 'running' | 'succeeded' | 'failed';

export interface OperationFailure {
  drop: Drop;
  error: string;
}

export interface Operation {
  id: string;
  kind: OperationKind;
  targetName: string;
  total: number;
  done: number;
  failed: OperationFailure[];
  status: OperationStatus;
  cancelled: boolean;
  // Success cards only: epoch-ms when the module timer removes the card.
  expiresAt: number | null;
}

export interface StartParams {
  kind: OperationKind;
  drops: Drop[];
  /** 'personal' | workspace id for move/copy; null for delete. */
  targetSpaceId: string | null;
  targetName: string;
  /** Fires with the drop id after each successfully completed item: the caller performs its
   *  in-place surgery here (delete: removeDropInPlace + preview-cache invalidate; move:
   *  removeDropInPlace; copy: nothing). Idempotent — a retry of an already-removed id is a
   *  no-op (removeDropInPlace is a plain filter). */
  onItemDone?: (dropId: string) => void;
  // Called once when the operation settles (complete, failed, or cancelled). Captured at
  // start — pass a stable callback.
  onSettled?: () => void;
}

const SUCCESS_HOLD_MS = 5000;

const operations = new Map<string, Operation>();
const paramsById = new Map<string, StartParams>();
const activeDropIds = new Set<string>();
let nextId = 1;

interface Snapshot {
  operations: Operation[];
}
let snapshot: Snapshot = { operations: [] };

function notify() {
  snapshot = { operations: Array.from(operations.values()) };
  listeners.forEach((listener) => listener());
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return snapshot;
}

export function useOperations(): Snapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function removeOperation(id: string) {
  if (!operations.has(id)) return;
  operations.delete(id);
  paramsById.delete(id);
  notify();
}

function settleOperation(operation: Operation, params: StartParams) {
  operation.status = operation.failed.length > 0 ? 'failed' : 'succeeded';
  if (operation.status === 'succeeded') {
    operation.expiresAt = Date.now() + SUCCESS_HOLD_MS;
    const id = operation.id;
    setTimeout(() => removeOperation(id), SUCCESS_HOLD_MS);
  }
  notify();
  params.onSettled?.();
}

async function runOperation(operation: Operation, items: Drop[], params: StartParams) {
  try {
    for (const drop of items) {
      if (operation.cancelled) break;
      if (params.kind === 'delete') {
        let failure: string | null = null;
        let ok = false;
        try {
          ok = await window.dropsync.drop.delete(drop.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // vault.ts findDrop throws `Drop not found: <id>` — the desktop's missing-item
          // case; everything else is the web's generic delete-failure wording.
          failure = message.startsWith('Drop not found:')
            ? 'This item is no longer available.'
            : 'This item could not be deleted.';
        }
        if (ok) {
          operation.done++;
          params.onItemDone?.(drop.id);
        } else {
          operation.failed.push({ drop, error: failure ?? 'This item could not be deleted.' });
        }
      } else {
        const target = params.targetSpaceId ?? 'personal';
        try {
          const out = await window.dropsync.drop.transfer({ mode: params.kind, dropIds: [drop.id], targetSpaceId: target });
          const result = out.ok && out.results ? out.results[0] : undefined;
          if (result) {
            if (result.success) {
              operation.done++;
              params.onItemDone?.(drop.id);
            } else {
              operation.failed.push({ drop, error: result.error || 'The operation failed.' });
            }
          } else {
            // ok:false pre-flight (invalid request / category prep) rides back as a VALUE
            // (main's drop:transfer handler) — surfaced as this one item's failure.
            operation.failed.push({ drop, error: out.error || 'The operation failed.' });
          }
        } catch (error) {
          operation.failed.push({ drop, error: error instanceof Error ? error.message : 'The operation failed.' });
        }
      }
      notify();
    }
  } finally {
    for (const drop of items) activeDropIds.delete(drop.id);
    settleOperation(operation, params);
  }
}

/** Start a bulk operation. Drops already in another running operation are skipped (they
 * cannot be safely re-acted on mid-flight); if nothing remains, returns null and the
 * caller should treat the action as a no-op. */
export function startDropOperation(params: StartParams): { id: string; started: number } | null {
  const items = params.drops.filter(d => !activeDropIds.has(d.id));
  if (items.length === 0) return null;
  const operation: Operation = {
    id: 'op-' + nextId++,
    kind: params.kind,
    targetName: params.targetName,
    total: items.length,
    done: 0,
    failed: [],
    status: 'running',
    cancelled: false,
    expiresAt: null,
  };
  for (const drop of items) activeDropIds.add(drop.id);
  operations.set(operation.id, operation);
  paramsById.set(operation.id, params);
  notify();
  void runOperation(operation, items, params);
  return { id: operation.id, started: items.length };
}

/** Stop what has not started yet; the item in flight finishes. The card stays until the
 * operation settles (then dismisses normally). */
export function cancelOperation(id: string) {
  const operation = operations.get(id);
  if (operation && operation.status === 'running') {
    operation.cancelled = true;
    notify();
  }
}

/** Remove the card now; a running operation is cancelled and settles silently. */
export function dismissOperation(id: string) {
  const operation = operations.get(id);
  if (operation && operation.status === 'running') operation.cancelled = true;
  removeOperation(id);
}

/** Re-run ONLY the failed items of a settled operation as a fresh one. */
export function retryOperation(id: string) {
  const operation = operations.get(id);
  const params = paramsById.get(id);
  if (!operation || !params || operation.status !== 'failed' || operation.failed.length === 0) return;
  const retryParams: StartParams = { ...params, drops: operation.failed.map(f => f.drop) };
  removeOperation(id);
  startDropOperation(retryParams);
}
