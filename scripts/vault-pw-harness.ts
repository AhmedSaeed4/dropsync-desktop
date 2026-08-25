/**
 * FIX 24 permanent regression harness — headless drive of the REAL VaultManager (no GUI, no
 * Electron; the engine imports only node modules). Reproduces the #24 brick sequence exactly:
 *
 *   create → add a drop → lock → unlock(old) ✓ → mutate (journal record lands, bound to the
 *   CURRENT outer header bytes) → changePassword → lock → unlock(new) MUST succeed with the
 *   drop intact → old password rejected. Plus the empty-journal change regression.
 *
 * On pre-fix code the dirty-journal branch fails at unlock(new) ("the vault index is missing
 * or damaged") — exactly the owner-reported symptom.
 *
 * Run: node scripts/vault-pw-harness.ts   (Node ≥23.6 native type stripping)
 * Wired into the S1 battery (DROPSYNC_E2E=1 spawns this after the bridge pass).
 */

import { rmSync, statSync } from 'node:fs';
import * as pathMod from 'node:path';

import { VaultManager } from '../src/main/vault/vault.ts';
import type { VaultDropRecord } from '../src/main/vault/vaultTypes.ts';

const OLD_PW = 'old-password-1';
const NEW_PW = 'new-password-2!';
const DROP_TEXT = 'survive-me-FIX24';

function makeDrop(): VaultDropRecord {
  return {
    id: 'fix24-drop',
    spaceId: 'personal',
    type: 'text',
    name: 'FIX24 survival drop',
    content: DROP_TEXT,
    categories: [],
    pinned: false,
    locked: false,
    isDrawing: false,
    createdAt: new Date().toISOString(),
    expiresAt: null,
    reminderAt: null,
    contentSha256s: {},
    blobRefs: {},
  };
}

function vaultFileSize(folder: string): number {
  return statSync(pathMod.join(folder, 'DropSync.vault', 'vault.vmeta')).size;
}

async function dirtyJournalBranch(results: Record<string, unknown>, dir: string): Promise<void> {
  const mgr = new VaultManager();
  await mgr.create(dir, OLD_PW);
  await mgr.putDrop(makeDrop());
  await mgr.lock();

  await mgr.unlock(dir, OLD_PW); // pre-change sanity: old password works
  results.unlockOldBefore = true;

  // Mutate AFTER relock-free unlock so a journal record exists, sealed under the CURRENT
  // header bytes — the exact artifact that made header swaps brick the vault.
  const before = vaultFileSize(dir);
  await mgr.createSpace('ws-fix24');
  results.journalNonEmpty = vaultFileSize(dir) > before;

  await mgr.changePassword(OLD_PW, NEW_PW);
  results.changeOk = true;

  await mgr.lock();
  await mgr.unlock(dir, NEW_PW); // THE assertion: new password must open the vault
  results.unlockNewAfterChange = true;
  const drops = mgr.listDrops('personal');
  results.dropSurvives = drops.length === 1 && drops[0].id === 'fix24-drop';
  const payload = await mgr.getTextPayload('fix24-drop');
  results.dropTextIntact = payload?.text === DROP_TEXT;

  await mgr.lock();
  let oldRejected = false;
  try {
    await mgr.unlock(dir, OLD_PW);
  } catch {
    oldRejected = true;
  }
  results.oldPasswordRejected = oldRejected;
}

async function emptyJournalBranch(results: Record<string, unknown>, dir: string): Promise<void> {
  // Regression: changing the password on a freshly created vault (journal empty end-to-end).
  const mgr = new VaultManager();
  await mgr.create(dir, OLD_PW);
  await mgr.changePassword(OLD_PW, NEW_PW);
  await mgr.lock();
  await mgr.unlock(dir, NEW_PW);
  results.emptyJournalChangeOk = true;
}

async function main(): Promise<boolean> {
  const stamp = Date.now();
  const dir = pathMod.join('/tmp', `ds-pw-harness-${stamp}`);
  const dirEmpty = `${dir}-empty`;
  const results: Record<string, unknown> = {};
  try {
    await dirtyJournalBranch(results, dir);
    await emptyJournalBranch(results, dirEmpty);
    const ok = Object.values(results).every((v) => v === true || typeof v === 'number');
    console.log(`[pw-harness] ${JSON.stringify({ ok, ...results })}`);
    return ok;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[pw-harness] ${JSON.stringify({ ok: false, ...results, error: message })}`);
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dirEmpty, { recursive: true, force: true });
  }
}

void main().then((ok) => process.exit(ok ? 0 : 1));
