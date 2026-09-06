/**
 * Drop create/edit operations (Sitting 2, M3+M4) — the hands-on half of the vault.
 *
 * Invariants carried over from Sitting 1:
 * - Every index change goes through VaultManager.mutate() (the persist chain) — never around it.
 * - New blobs are fully written + SHA-256'd BEFORE the journal op that references them; old
 *   replaced blobs are deleted only AFTER the mutation commits. A kill between those steps leaves
 *   an unreferenced .vblob, which sweepOrphanBlobs() removes on next unlock.
 * - Big payloads stream disk→encrypt→vblob entirely in main; bytes cross IPC only for sources
 *   with no disk path (drawing PNGs exported in-page, clipboard pastes).
 */

import fsp from 'node:fs/promises';
import * as pathMod from 'node:path';
import * as netMod from 'node:net';
import { tmpdir } from 'node:os';
// Round 107 (repair-order-107 §4 FIX C) — copy duplicates blobs by pumping manager.streamBlob
// (a WEB ReadableStream, vault.ts:713-719) into readableToWritable (below), which pumps a NODE
// Readable — Readable.fromWeb is the adapter (same conversion as the drop:saveAs handler).
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';

// 28: same one-liner helper the importer uses (importer.ts sha256Hex, not exported) — the
// content fingerprint stamped at write time must be byte-identical to the import-time one.
const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

import type { VaultManager } from './vault.ts';
import {
  INLINE_TEXT_LIMIT,
  type VaultBlobRef,
  type VaultDropRecord,
} from './vaultTypes.ts';
import { extractYouTubeVideoIds, isPasswordCategoryList } from './youtubeIds.ts';

// Web parity: drops.ts MAX_FILE_SIZE + formatFileSize.
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB limit

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/** Expiry menu is exactly these five (LOCKED decision — never offer 4h; it stays importable). */
export const CREATE_EXPIRY_OPTIONS = ['1h', '2h', '6h', '24h', 'forever'] as const;
export type CreateExpirationOption = (typeof CREATE_EXPIRY_OPTIONS)[number];

export function getExpirationDateFromNow(option: CreateExpirationOption): string | null {
  if (option === 'forever') return null;
  const hours = parseInt(option.replace('h', ''), 10);
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

/** Max-3 + case-insensitive-trim dedupe (first casing wins), matching the modal's rules. */
function normalizeCategories(categories: unknown): string[] {
  if (!Array.isArray(categories)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of categories) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= 3) break;
  }
  return out;
}

export interface ProgressEmit {
  (progress: { phase: string; processedBytes: number; totalBytes: number; currentName?: string; message?: string }): void;
}

export interface CreateMetaBase {
  spaceId: string;
  name?: string;
  expirationOption?: CreateExpirationOption;
  locked?: boolean;
  reminderAt?: string | null;
}

// ------------------------------------------------------------------ create

export interface CreateTextArgs extends CreateMetaBase {
  content: string;
  categories?: string[];
  /** Absolute path of an attached image (dialog pick / drag-drop) — streamed into a vblob by main. */
  imagePath?: string | null;
  /**
   * Raw image bytes for clipboard-paste origins with no disk path — they cross IPC exactly ONCE
   * (same rule as drop:createFileFromBytes) and are encrypted straight into a vblob.
   */
  imageBytes?: Uint8Array | null;
  /** PNG bytes of a drawing exported in-page (exportToBlob + exportEmbedScene). */
  pngBytes?: Uint8Array | null;
}

export async function createTextDrop(
  manager: VaultManager,
  args: CreateTextArgs,
  onProgress?: ProgressEmit
): Promise<VaultDropRecord> {
  manager.assertUnlockedPublic();
  const content = typeof args.content === 'string' ? args.content : '';
  const name = (args.name || '').trim() || (args.pngBytes ? 'Drawing' : 'Text snippet');
  const expirationOption: CreateExpirationOption = CREATE_EXPIRY_OPTIONS.includes(args.expirationOption as CreateExpirationOption)
    ? (args.expirationOption as CreateExpirationOption)
    : '2h';
  const nowIso = new Date().toISOString();

  let imageRef: VaultBlobRef | null = null;
  if (args.imagePath) {
    imageRef = await streamPathIntoVault(manager, args.imagePath, undefined, undefined, onProgress);
  } else if (args.imageBytes && args.imageBytes.byteLength > 0) {
    imageRef = await writeBytesIntoVault(manager, args.imageBytes);
  }
  let pngRef: VaultBlobRef | null = null;
  if (args.pngBytes && args.pngBytes.byteLength > 0) {
    const writer = manager.createVaultBlobWriter();
    const w = writer.writable.getWriter();
    await w.write(args.pngBytes);
    await w.close();
    pngRef = await writer.ref();
  }

  // Oversized bodies move out of the index into their own encrypted blob.
  let bodyRef: VaultBlobRef | null = null;
  let inlineContent: string | undefined = content;
  if (new TextEncoder().encode(content).byteLength > INLINE_TEXT_LIMIT) {
    const writer = manager.createVaultBlobWriter();
    const w = writer.writable.getWriter();
    await w.write(new TextEncoder().encode(content));
    await w.close();
    bodyRef = await writer.ref();
    inlineContent = undefined;
  }

  try {
    const record: VaultDropRecord = {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      type: 'text',
      name,
      content: inlineContent,
      categories: normalizeCategories(args.categories ?? []),
      pinned: false,
      locked: !!args.locked,
      isDrawing: !!args.pngBytes,
      createdAt: nowIso,
      expiresAt: getExpirationDateFromNow(expirationOption),
      expirationOption,
      reminderAt: args.reminderAt ?? null,
      reminderSetByUid: args.reminderAt ? 'local' : null,
      reminderDismissedBy: null,
      imageSize: imageRef?.bytes,
      imageMimeType: imageRef ? await sniffImageMime(manager, imageRef) : undefined,
      creatorName: 'local',
      blobRefs: {
        file: pngRef ?? undefined,
        image: imageRef ?? undefined,
        body: bodyRef ?? undefined,
      },
      contentSha256s: {},
    };
    // NOTE: drawings store the PNG under blobRefs.file so preview/media treat it like the
    // web's file payload (image rendering path keys off isDrawing + mimeType).
    record.mimeType = pngRef ? 'image/png' : undefined;
    await manager.putDrop(record);
    return record;
  } catch (error) {
    // Create failed before commit → zero orphan vblobs.
    for (const ref of [imageRef, pngRef, bodyRef]) {
      if (ref) await manager.unlinkBlobQuiet(ref.path);
    }
    throw error;
  }
}

export interface CreateFileFromPathResult {
  record: VaultDropRecord;
}

/**
 * Stream a disk file → encrypt → vblob without buffering (memory stays flat for 300 MB+
 * files). The absolutePath comes from a dialog pick or a drag-drop path; clipboard sources
 * are staged to a temp file first so this ONE function owns all binary ingestion.
 */
export async function createFileDropFromPath(
  manager: VaultManager,
  absolutePath: string,
  meta: CreateMetaBase & { displayName?: string; mimeType?: string },
  onProgress?: ProgressEmit
): Promise<CreateFileFromPathResult> {
  manager.assertUnlockedPublic();
  let stat;
  try {
    stat = await fsp.stat(absolutePath);
  } catch {
    throw new Error('That file could not be found.');
  }
  if (!stat.isFile()) throw new Error('That path is not a file.');
  // Exact web wording, byte-for-byte:
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(`File too large. Maximum size is ${formatFileSize(MAX_FILE_SIZE)}. Your file is ${formatFileSize(stat.size)}.`);
  }

  const displayName = meta.displayName || pathMod.basename(absolutePath);
  const expirationOption: CreateExpirationOption = CREATE_EXPIRY_OPTIONS.includes(meta.expirationOption as CreateExpirationOption)
    ? (meta.expirationOption as CreateExpirationOption)
    : '2h';
  const nowIso = new Date().toISOString();
  const totalBytes = stat.size;

  const writer = manager.createVaultBlobWriter();
  const fh = await fsp.open(absolutePath, 'r');
  let ref: VaultBlobRef;
  try {
    // Stream disk → encrypt → vblob in fixed chunks; memory stays flat regardless of size.
    await readableToWritable(fh.createReadStream(), writer.writable, (bytes) => {
      onProgress?.({
        phase: 'fileCreate',
        processedBytes: bytes,
        totalBytes,
        currentName: displayName,
        message: `Saving ${displayName}`,
      });
    });
    ref = await writer.ref();
  } catch (error) {
    // Cancelled/failed mid-stream → remove any partial output (writer.abort cleans its .tmp).
    await writer.abort().catch(() => {});
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    await fh.close().catch(() => {});
  }

  try {
    const record: VaultDropRecord = {
      id: crypto.randomUUID(),
      spaceId: meta.spaceId,
      type: 'file',
      name: displayName,
      categories: [],
      pinned: false,
      locked: !!meta.locked,
      isDrawing: false,
      createdAt: nowIso,
      expiresAt: getExpirationDateFromNow(expirationOption),
      expirationOption,
      reminderAt: null,
      reminderSetByUid: null,
      reminderDismissedBy: null,
      fileSize: ref.bytes,
      mimeType: meta.mimeType || mimeFromExtension(pathMod.extname(displayName).toLowerCase()),
      creatorName: 'local',
      blobRefs: { file: ref },
      contentSha256s: { file: ref.sha256 },
    };
    await manager.putDrop(record);
    return { record };
  } catch (error) {
    await manager.unlinkBlobQuiet(ref.path);
    throw error;
  }
}

/**
 * Clipboard/drag sources with no disk path: stage the bytes to a temp file, then run the ONE
 * path-based pipeline. Bytes cross IPC exactly once here (their origin is the clipboard).
 */
export async function createFileDropFromBytes(
  manager: VaultManager,
  bytes: Uint8Array,
  displayName: string,
  mimeType: string | undefined,
  meta: CreateMetaBase,
  onProgress?: ProgressEmit
): Promise<CreateFileFromPathResult> {
  if (bytes.byteLength > MAX_FILE_SIZE) {
    throw new Error(`File too large. Maximum size is ${formatFileSize(MAX_FILE_SIZE)}. Your file is ${formatFileSize(bytes.byteLength)}.`);
  }
  const tmpDir = await fsp.mkdtemp(pathMod.join(tmpdir(), 'dropsync-paste-'));
  const tmp = pathMod.join(tmpDir, sanitizeFileName(displayName));
  try {
    await fsp.writeFile(tmp, bytes);
    return await createFileDropFromPath(manager, tmp, { ...meta, displayName, mimeType }, onProgress);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ------------------------------------------------------------------ update

export interface UpdateContentArgs {
  name?: string;
  content?: string;
  categories?: string[];
  /** Replace the attached image (text drops) with the file at this path. */
  imagePath?: string | null;
  /** Replace the attached image from clipboard-paste bytes (no disk path — crosses IPC once). */
  imageBytes?: Uint8Array | null;
  /** Remove the attached image (ignored when imagePath is present). */
  imageRemoved?: boolean;
  /** Replace/attach a drawing PNG (exportEmbedScene round-trip bytes). */
  pngBytes?: Uint8Array | null;
}

/**
 * Payload edit (M3): plaintext in → single re-encrypt → new/updated vblobs → one index
 * mutation. Old replaced blobs are deleted only after the mutation commits.
 * Any name/content/categories change clears youtubeVideoLabels (web parity — stale titles are
 * worse than none).
 */
export async function updateTextDropContent(
  manager: VaultManager,
  dropId: string,
  updates: UpdateContentArgs,
  onProgress?: ProgressEmit
): Promise<VaultDropRecord> {
  manager.assertUnlockedPublic();
  const record = manager.findDrop(dropId);
  if (record.type !== 'text') throw new Error('Only text drops can be edited here.');

  const next: VaultDropRecord = structuredClone(record);

  const nameChanged = updates.name !== undefined && updates.name.trim() !== '' && updates.name.trim() !== record.name;
  if (updates.name !== undefined && updates.name.trim() !== '') next.name = updates.name.trim();

  const categoriesChanged = updates.categories !== undefined &&
    JSON.stringify(normalizeCategories(updates.categories)) !== JSON.stringify(record.categories);
  if (updates.categories !== undefined) next.categories = normalizeCategories(updates.categories);

  // Precise content-change detection: compare against the CURRENT text (inline or body blob).
  let currentFullText = record.content ?? '';
  if (record.blobRefs.body) {
    const payload = await manager.getTextPayload(dropId).catch(() => null);
    currentFullText = payload?.text ?? '';
  }
  const contentChanged = updates.content !== undefined && updates.content !== currentFullText;
  let newBodyRef: VaultBlobRef | null = null;
  let newInlineContent: string | undefined = next.content;
  if (updates.content !== undefined) {
    const text = updates.content;
    if (new TextEncoder().encode(text).byteLength > INLINE_TEXT_LIMIT) {
      const writer = manager.createVaultBlobWriter();
      const w = writer.writable.getWriter();
      await w.write(new TextEncoder().encode(text));
      await w.close();
      newBodyRef = await writer.ref();
      newInlineContent = undefined;
    } else {
      newInlineContent = text;
    }
    next.content = newInlineContent;
    // 28: stamp the content fingerprint at write time (sha of the UTF-8 text bytes, inline or
    // >64KB body alike — the bytes are the same regardless of where they live). The list card
    // compares this key to notice its own content changed and re-read JUST itself.
    next.contentSha256s.content = sha256Hex(new TextEncoder().encode(text));
  }

  // Image / drawing payload replacement.
  let newFileRef: VaultBlobRef | null = null;   // drawing PNG slot (blobRefs.file)
  let newImageRef: VaultBlobRef | null = null;  // attached-image slot (blobRefs.image)
  if (updates.pngBytes && updates.pngBytes.byteLength > 0) {
    const writer = manager.createVaultBlobWriter();
    const w = writer.writable.getWriter();
    await w.write(updates.pngBytes);
    await w.close();
    newFileRef = await writer.ref();
    next.isDrawing = true;
    // 28: stamp the file-slot fingerprint — the card's thumbnail key.
    next.contentSha256s.file = newFileRef.sha256;
    // 27: the manifest drawingScene is now stale by definition — the PNG it mirrors was just
    // replaced by this save. Clearing it makes the editor fall back to the saved PNG's
    // embedded scene (the proven path every locally created drawing uses). Metadata-only
    // saves keep the scene — still accurate there, so the zero-fetch open is preserved.
    next.drawingScene = undefined;
  }
  if (updates.imagePath) {
    newImageRef = await streamPathIntoVault(manager, updates.imagePath, undefined, undefined, onProgress);
    next.imageSize = newImageRef.bytes;
    next.imageMimeType = await sniffImageMime(manager, newImageRef);
    // 28: stamp the attached-image fingerprint — the card's attached-image key.
    next.contentSha256s.image = newImageRef.sha256;
  } else if (updates.imageBytes && updates.imageBytes.byteLength > 0) {
    newImageRef = await writeBytesIntoVault(manager, updates.imageBytes);
    next.imageSize = newImageRef.bytes;
    next.imageMimeType = await sniffImageMime(manager, newImageRef);
    // 28: stamp the attached-image fingerprint — the card's attached-image key.
    next.contentSha256s.image = newImageRef.sha256;
  } else if (updates.imageRemoved) {
    next.imageSize = undefined;
    next.imageMimeType = undefined;
  }

  // Stale-title rule: ANY source edit (name/content/categories) drops cached labels.
  const sourceChanged = nameChanged || contentChanged || categoriesChanged ||
    (!!updates.pngBytes && updates.pngBytes.byteLength > 0);
  if (sourceChanged) next.youtubeVideoLabels = [];

  // Commit through the persist chain, then tear down replaced blobs.
  const oldRefs = [record.blobRefs.body, record.blobRefs.file, record.blobRefs.image];
  next.blobRefs = {
    ...next.blobRefs,
    ...(newBodyRef ? { body: newBodyRef } : {}),
    ...(newFileRef ? { file: newFileRef } : {}),
    ...(newImageRef ? { image: newImageRef } : {}),
  };
  if (updates.imageRemoved && !newImageRef) delete next.blobRefs.image;

  try {
    await manager.mutatePublic({ op: 'drop.content', drop: next });
  } catch (error) {
    for (const ref of [newBodyRef, newFileRef, newImageRef]) {
      if (ref) await manager.unlinkBlobQuiet(ref.path);
    }
    throw error;
  }
  // Committed — now delete every OLD blob this edit replaced (only when actually replaced).
  // FIX 20 rider: compare by PATH, never by object identity — `next` is a structuredClone,
  // so cloned refs are never === and an untouched sibling slot (e.g. a web-imported drawing's
  // image-slot PNG surviving a canvas re-save) must not be treated as "replaced" and unlinked.
  const sameRefPath = (a: VaultBlobRef | undefined, b: VaultBlobRef | undefined): boolean => a?.path === b?.path;
  const replacedPaths = new Set<string>();
  if (record.blobRefs.body && !sameRefPath(next.blobRefs.body, record.blobRefs.body)) replacedPaths.add(record.blobRefs.body.path);
  if (record.blobRefs.file && !sameRefPath(next.blobRefs.file, record.blobRefs.file)) replacedPaths.add(record.blobRefs.file.path);
  if (record.blobRefs.image && !sameRefPath(next.blobRefs.image, record.blobRefs.image)) replacedPaths.add(record.blobRefs.image.path);
  if (updates.imageRemoved && !newImageRef && record.blobRefs.image) replacedPaths.add(record.blobRefs.image.path);
  for (const ref of oldRefs) {
    if (ref && replacedPaths.has(ref.path)) await manager.unlinkBlobQuiet(ref.path);
  }
  return next;
}

export interface UpdateMetaPatch {
  name?: string;
  categories?: string[];
  locked?: boolean;
  expirationOption?: CreateExpirationOption;
  /** Date ISO string to set/re-arm, null to turn off. Absent = untouched. */
  reminderAt?: string | null;
}

/**
 * Light metadata patch (no payload rewrite). Expiry ALWAYS recomputes from NOW
 * ('forever' ⇒ expiresAt:null). Name/categories changes clear cached YouTube labels too
 * (spec binding: stale titles are worse than none).
 */
export async function updateTextDropMeta(
  manager: VaultManager,
  dropId: string,
  patch: UpdateMetaPatch
): Promise<VaultDropRecord> {
  manager.assertUnlockedPublic();
  const record = manager.findDrop(dropId);

  const journalPatch: Partial<VaultDropRecord> = {};

  if (patch.name !== undefined && patch.name.trim() !== '' && patch.name.trim() !== record.name) {
    journalPatch.name = patch.name.trim();
  }
  if (patch.categories !== undefined) {
    const normalized = normalizeCategories(patch.categories);
    if (JSON.stringify(normalized) !== JSON.stringify(record.categories)) {
      journalPatch.categories = normalized;
    }
  }
  if (patch.locked !== undefined) journalPatch.locked = !!patch.locked;
  if (patch.expirationOption !== undefined) {
    const option = CREATE_EXPIRY_OPTIONS.includes(patch.expirationOption) ? patch.expirationOption : null;
    if (option) {
      journalPatch.expirationOption = option;
      journalPatch.expiresAt = getExpirationDateFromNow(option);
    }
  }
  if (patch.reminderAt !== undefined) {
    const reminderChanged = patch.reminderAt !== record.reminderAt;
    journalPatch.reminderAt = patch.reminderAt;
    journalPatch.reminderSetByUid = patch.reminderAt ? 'local' : null;
    journalPatch.reminderDismissedBy = null;
    // C2j-hotfix-1 — a RE-ARMED reminder is a fresh lifecycle: clear the fired stamp so the
    // engine (vault.ts reminderEligible) will announce it when due. Guarded on an actual value
    // change so unrelated meta re-saves can't re-announce an old past-due reminder. Web parity:
    // drops.ts has no stamp — due = time + not-dismissed.
    if (reminderChanged) journalPatch.reminderFiredAt = null;
  }

  const labelsChanged =
    journalPatch.name !== undefined || journalPatch.categories !== undefined;
  if (labelsChanged) journalPatch.youtubeVideoLabels = [];

  if (Object.keys(journalPatch).length === 0) return record;
  await manager.mutatePublic({ op: 'drop.meta', id: dropId, patch: journalPatch });
  return manager.findDrop(dropId);
}

// ------------------------------------------------------------------ move & copy (round 107)

/**
 * repair-order-107 §4 FIX C — move/copy a batch of drops between spaces. Port of the web's
 * moveDrop/copyDrop (drag-drop-app/src/lib/drops.ts:1277-1586 / :1597-1932) driven exactly the
 * way EditorialLayout drives them (W3/W4): category pre-flight ONCE per batch, then the drops
 * sequentially with per-drop isolation — one bad id never aborts the batch.
 *
 * Categories (W7): vault.ts createCategory is the ensure primitive — it dedupes
 * case-insensitively per space and RETURNS the existing row (vault.ts:588-597). The map is
 * keyed lowercased+trimmed name → the target row's name, so resolution matches the web's
 * `.map(c => catMap.get(c.toLowerCase().trim())).filter(Boolean)` (drops.ts:1538-1540).
 *
 * Move writes EXACTLY three fields (W5, drops.ts:1462-1465 + :1530-1545): spaceId, pinned:false
 * ("Unpin on move"), and the remapped categories. NO re-encryption exists on desktop (one vault
 * DEK for all spaces — owner decision §3.3). Everything else RIDES UNTOUCHED: reminder fields
 * (a move patch that doesn't touch them can never re-announce a reminder — vault.ts:898-903
 * eligibility; the C2j fired-stamp-clearing rule lives in the EDIT path only, dropOps.ts:457-466),
 * expiresAt/expirationOption (the clock is NOT restarted), youtubeVideoLabels (the stale-title
 * clear lives in updateTextDropContent/updateTextDropMeta only — dropOps.ts:377-380/:469-471 —
 * the web's move does not clear them either), locked, name, type.
 *
 * Copy builds a FRESH record per W6 (drops.ts:1794-1898) and NEVER mutates the source
 * (drops.ts:1590). The copy ALWAYS owns its own storage: every blob slot is stream-decrypted →
 * re-encrypted into a fresh vblob whose header carries its OWN fresh noncePrefix
 * (blobStore.ts:4-8) — byte-copying a .vblob would clone the nonce under the same vault DEK =
 * AES-GCM nonce reuse, FORBIDDEN. This also satisfies the path-ownership rule: deleteDrop
 * unlinks blob files BY PATH (vault.ts:766-774), so two records sharing one path would corrupt
 * each other on delete. createdAt = the batch's ONE shared stamp (`batchCreatedAt` — a copy
 * action is one creation moment; equal stamps preserve the caller's display order under the
 * newest-first stable sort, vault.ts:638 — owner decision 2026-09-02, deliberately different
 * from the web's per-copy serverTimestamp); expiresAt recomputed from the source's
 * expirationOption ('forever' → null — forever stays forever; the web's tier downgrade is
 * account-tier logic and the desktop has no tiers, §3.5); unpinned; UNlocked ("a copy always
 * starts open — the lock never transfers", drops.ts:1813); the reminder RIDES (reminderAt +
 * reminderSetByUid verbatim — owner decision 2026-09-03, deliberately different from the web's
 * reminder-less copy: web workspaces are shared so its reminders are user-coupled,
 * drops.ts:311-313; the desktop is single-user; reminderDismissedBy RIDES too — a dismissal is
 * the user's "done with this reminder" decision and must travel with the copy, else a copied
 * drop re-notifies about something already closed (owner-found on candidate 3, ruling
 * 2026-09-03)) while only reminderFiredAt resets to null — the copy hasn't fired on its own id
 * yet; labels carried only for text drops whose resolved categories are NOT password categories
 * (W6, drops.ts:1895-1898). importedFromArchiveId does NOT transfer (import provenance — the
 * web copy has no such field). drawingScene rides by reference: same PNG bytes ⇒ the editor's
 * zero-fetch scene cache stays valid.
 */
export async function transferDrops(
  manager: VaultManager,
  args: { mode: 'move' | 'copy'; dropIds: string[]; targetSpaceId: string }
): Promise<{ ok: boolean; error?: string; results?: { id: string; newId?: string; success: boolean; error?: string }[] }> {
  manager.assertUnlockedPublic();
  if (
    (args.mode !== 'move' && args.mode !== 'copy') ||
    !Array.isArray(args.dropIds) || args.dropIds.length === 0 ||
    !args.dropIds.every((id) => typeof id === 'string' && id.length > 0) ||
    !(args.targetSpaceId === 'personal' || manager.listSpaces().some((s) => s.id === args.targetSpaceId))
  ) {
    return { ok: false, error: 'Invalid move/copy request.' };
  }

  // Category pre-flight — ONCE per batch (web W3 :271-284 pre-resolves the UNION of the batch's
  // category names; W7). A missing drop contributes nothing here (guarded per drop); the
  // per-drop loop below re-validates existence. createCategory ops are idempotent journal
  // writes — a later failure leaves only harmless category rows, never broken drops.
  const ensured = new Map<string, string>();
  try {
    const originals = new Map<string, string>(); // lower+trim key → first-seen original name
    for (const id of args.dropIds) {
      let categories: string[] = [];
      try {
        categories = manager.findDrop(id).categories ?? [];
      } catch {
        continue; // missing drop — contributes nothing to the union (per-drop failure below)
      }
      for (const c of categories) {
        if (typeof c !== 'string') continue;
        const key = c.toLowerCase().trim();
        if (key && !originals.has(key)) originals.set(key, c);
      }
    }
    for (const [key, original] of originals) {
      const cat = await manager.createCategory(args.targetSpaceId, original);
      ensured.set(key, cat.name);
    }
  } catch {
    return { ok: false, error: 'Failed to prepare categories. Please try again.' }; // web's exact wording (W3)
  }

  const results: { id: string; newId?: string; success: boolean; error?: string }[] = [];
  // ONE creation moment for the whole batch (owner decision 2026-09-02 — bulk-copy order fix):
  // every copy made by THIS transferDrops call shares one createdAt. The target list sorts
  // newest-first with NO tie-breaker (vault.ts:638) and JS sorts are stable, so equal stamps
  // keep the loop order — which is the display order the caller passed
  // (EditorialDropList.tsx:773) — and the batch lands in its source order instead of reversed.
  // Per-copy fresh stamps (the old behavior; web drops.ts:1807 parity) reversed every
  // multi-copy batch — owner-found defect on the installed 1.0.7, fixed deliberately better
  // than the web (web copyDrop fires concurrent Promise.all and scrambles; NEVER edit the web).
  const batchCreatedAt = new Date().toISOString();
  // SEQUENTIAL on purpose: the journal is a serialized chain anyway, and per-drop isolation
  // means one bad id never aborts the batch (web W3/W4; the web's Promise.all is concurrent,
  // outcomes are identical, ordering here is deterministic — order §6).
  for (const id of args.dropIds) {
    // ---- MOVE ----
    if (args.mode === 'move') {
      let rec: VaultDropRecord;
      try {
        rec = manager.findDrop(id);
      } catch {
        results.push({ id, success: false, error: 'Drop not found.' });
        continue;
      }
      if (rec.spaceId === args.targetSpaceId) {
        results.push({ id, success: false, error: 'Already in that space.' });
        continue;
      }
      // Resolve FIRST from the ensured map, THEN normalize (max-3 + dedupe — the same helper
      // the create path uses, dropOps.ts:48-63). A name missing from the map filters out —
      // the web's `.filter((n): n is string => !!n)` (drops.ts:1538-1540).
      const resolved = normalizeCategories(
        rec.categories.map((c) => ensured.get(c.toLowerCase().trim())).filter((n): n is string => !!n)
      );
      // That is the ENTIRE move (W5) — three fields, nothing else may enter the patch.
      try {
        await manager.mutatePublic({
          op: 'drop.meta',
          id,
          patch: { spaceId: args.targetSpaceId, pinned: false, categories: resolved },
        });
      } catch {
        results.push({ id, success: false, error: 'Failed to move drop. Please try again.' });
        continue;
      }
      results.push({ id, success: true });
      continue;
    }

    // ---- COPY ----
    let src: VaultDropRecord;
    try {
      src = manager.findDrop(id);
    } catch {
      results.push({ id, success: false, error: 'Drop not found.' });
      continue;
    }
    if (src.spaceId === args.targetSpaceId) {
      results.push({ id, success: false, error: 'Already in that space.' });
      continue;
    }
    const resolved = normalizeCategories(
      src.categories.map((c) => ensured.get(c.toLowerCase().trim())).filter((n): n is string => !!n)
    );

    // Duplicate blobs FIRST (create invariant, dropOps.ts:5-8 — blobs fully written + hashed
    // BEFORE the journal op that references them). Each slot: stream decrypt → re-encrypt into
    // a fresh vblob (fresh noncePrefix — the anti-nonce-reuse rule in the header comment).
    let newFileRef: VaultBlobRef | null = null;
    let newImageRef: VaultBlobRef | null = null;
    let newBodyRef: VaultBlobRef | null = null;
    const unlinkNewRefs = async (): Promise<void> => {
      for (const ref of [newFileRef, newImageRef, newBodyRef]) {
        if (ref) await manager.unlinkBlobQuiet(ref.path);
      }
    };
    const dupStream = async (kind: 'file' | 'image'): Promise<VaultBlobRef> => {
      const stream = manager.streamBlob(id, kind);
      if (!stream) throw new Error('Failed to read file content for copy');
      const writer = manager.createVaultBlobWriter();
      try {
        await readableToWritable(
          Readable.fromWeb(stream as unknown as import('node:stream/web').ReadableStream),
          writer.writable
        );
      } catch (error) {
        // Cancelled/failed mid-stream → remove the partial output (writer.abort cleans its .tmp).
        await writer.abort().catch(() => {});
        throw error instanceof Error ? error : new Error(String(error));
      }
      return writer.ref();
    };
    try {
      if (src.blobRefs.file) newFileRef = await dupStream('file'); // file slot; also the drawing-PNG slot
      if (src.blobRefs.image) newImageRef = await dupStream('image');
      if (src.blobRefs.body) {
        // Oversized text body: full plaintext → fresh encrypted body blob.
        const payload = await manager.getTextPayload(id);
        if (!payload) throw new Error('Failed to read text content for copy');
        newBodyRef = await writeBytesIntoVault(manager, new TextEncoder().encode(payload.text));
      }
    } catch (error) {
      await unlinkNewRefs(); // unlink already-completed refs of THIS copy — nothing half-owned leaks
      results.push({ id, success: false, error: error instanceof Error ? error.message : String(error) });
      continue;
    }

    const copyOption = src.expirationOption ?? '2h'; // web's default (W6, drops.ts:1792)
    // '4h' is import-only (CREATE_EXPIRY_OPTIONS excludes it, dropOps.ts:37-38) but an IMPORTED
    // record can legally carry it (importer.ts:543-548 keeps '4h'), so copyOption spans the
    // record's option union. The helper parses any 'Nh' option exactly (same parseInt idiom as
    // importer.ts:549), and 'forever' → null — forever stays forever (§3 decision 5).
    const copyExpiresAt = getExpirationDateFromNow(copyOption as CreateExpirationOption);
    // W6 :1895-1898 — labels ride ONLY for text drops whose resolved categories are NOT
    // password categories (isPasswordCategoryList is already imported above, dropOps.ts:24).
    const keepLabels = src.type === 'text'
      && !isPasswordCategoryList(resolved)
      && (src.youtubeVideoLabels?.length ?? 0) > 0;
    const next: VaultDropRecord = {
      id: crypto.randomUUID(),
      spaceId: args.targetSpaceId,
      type: src.type,
      name: src.name,
      content: src.content,            // inline body rides as-is (body blob duplicated separately)
      categories: resolved,            // same resolution as move
      pinned: false,                   // web: copy starts unpinned (drops.ts:1812)
      locked: false,                   // web: "a copy always starts open — the lock never transfers" (drops.ts:1813)
      isDrawing: src.isDrawing,
      createdAt: batchCreatedAt, // the batch's ONE shared stamp — see batchCreatedAt above
      expiresAt: copyExpiresAt,        // recomputed from the source's option — clock restarts (W6)
      expirationOption: copyOption,
      reminderAt: src.reminderAt,      // RIDES verbatim (owner decision 2026-09-03 — reminders ride on
      reminderSetByUid: src.reminderSetByUid, // copy like move). Deliberately different from the web,
      // whose SHARED workspaces make reminders user-coupled (web drops.ts:311-313) — the single-user
      // desktop has no one to impose a reminder on. Past reminderAt surfaces via the missed queue.
      reminderDismissedBy: src.reminderDismissedBy, // RIDES verbatim (owner ruling 2026-09-03): a
      // dismissal is the user's "I'm DONE with this reminder" decision and must travel with the
      // copy — else a copied drop re-notifies about something already closed (owner-found on
      // candidate 3: 10 drops copied, 5 dismissed, all 5 copies re-notified).
      reminderFiredAt: null,           // the ONLY reset — the copy hasn't fired on its own id yet:
      // an UNdismissed past reminder surfaces once via the missed queue; a dismissed one never fires.
      fileSize: src.fileSize,
      mimeType: src.mimeType,
      imageSize: newImageRef?.bytes ?? src.imageSize,
      imageMimeType: src.imageMimeType,
      creatorName: 'local',
      youtubeVideoLabels: keepLabels ? structuredClone(src.youtubeVideoLabels) : undefined,
      drawingScene: src.drawingScene,  // same bytes ⇒ same cached scene
      blobRefs: {
        file: newFileRef ?? undefined,
        image: newImageRef ?? undefined,
        body: newBodyRef ?? undefined,
      },
      contentSha256s: { ...src.contentSha256s, ...(newFileRef ? { file: newFileRef.sha256 } : {}) },
    };
    try {
      await manager.putDrop(next); // the ONE journal op for the copy
    } catch (error) {
      // Create failed before commit → zero orphan vblobs (pattern of createTextDrop's catch,
      // dropOps.ts:165-171). The source's blobs are never touched (W6 Step 6).
      await unlinkNewRefs();
      results.push({ id, success: false, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    results.push({ id, success: true, newId: next.id });
  }

  return { ok: true, results };
}

// ------------------------------------------------------------------ orphan sweep

/**
 * Delete unreferenced .vblob files (+ stray .tmp leftovers). Runs at UNLOCK only, when no
 * media tokens or in-flight writers can hold a legitimate unreferenced blob. This is the
 * kill-mid-create guarantee: a partial blob whose journal op never committed is garbage.
 */
export async function sweepOrphanBlobs(manager: VaultManager): Promise<number> {
  let removed = 0;
  let entries;
  try {
    entries = await fsp.readdir(manager.blobsDir);
  } catch {
    return 0;
  }
  const referenced = new Set<string>();
  for (const drop of manager.allRecords()) {
    for (const ref of [drop.blobRefs.file, drop.blobRefs.image, drop.blobRefs.body]) {
      if (ref) referenced.add(pathMod.basename(ref.path));
    }
  }
  for (const entry of entries) {
    if (entry.endsWith('.tmp')) {
      await fsp.rm(pathMod.join(manager.blobsDir, entry), { force: true }).catch(() => {});
      continue;
    }
    if (!entry.endsWith('.vblob')) continue;
    if (!referenced.has(entry)) {
      await fsp.rm(pathMod.join(manager.blobsDir, entry), { force: true }).catch(() => {});
      removed += 1;
    }
  }
  return removed;
}

// ------------------------------------------------------------------ YouTube title refresh

export interface RefreshTitlesResult {
  scanned: number;
  needed: number;
  refreshed: number;
  offline: boolean;
}

const OEMBED_TIMEOUT_MS = 5_000;
const OEMBED_GAP_MS = 1_000;

function nodeNetIsOnline(): boolean {
  const probe = netMod as unknown as { isOnline?: () => boolean };
  return typeof probe.isOnline === 'function' ? probe.isOnline() : true;
}

async function fetchJsonWithTimeout(url: string): Promise<{ title?: string; author_name?: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OEMBED_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as { title?: string; author_name?: string };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * On-demand title refresh: scans the unlocked index for text drops carrying YouTube links
 * without cached labels, resolves each via keyless oEmbed (sequential, ≥1s apart, ≤5s
 * timeout), and writes results through the normal mutation path. Failures/offline skip
 * silently. Never runs automatically — only from the header/status button.
 */
export async function refreshYouTubeTitles(
  manager: VaultManager,
  spaceId: string,
  opts: { online?: boolean; forceOffline?: boolean; emit?: ProgressEmit } = {}
): Promise<RefreshTitlesResult> {
  manager.assertUnlockedPublic();
  // Caller may pass Electron's net.isOnline(); fall back to Node's own probe. A test seam can
  // force offline to prove the silent no-op path.
  const offline = opts.forceOffline === true || (opts.online ?? nodeNetIsOnline()) === false;
  const result: RefreshTitlesResult = { scanned: 0, needed: 0, refreshed: 0, offline };

  if (offline) return result;

  for (const record of manager.listDropsIncludingExpired(spaceId)) {
    result.scanned += 1;
    if (record.type !== 'text' || record.isDrawing || isPasswordCategoryList(record.categories)) continue;

    const payload = await manager.getTextPayload(record.id).catch(() => null);
    const text = `${record.name}\n${payload?.text ?? ''}`;
    const ids = extractYouTubeVideoIds(text);
    if (ids.length === 0) continue;

    const existing = new Set((record.youtubeVideoLabels ?? []).map((l) => l.videoId));
    const missing = ids.filter((id) => !existing.has(id));
    if (missing.length === 0) continue;
    result.needed += missing.length;

    const freshLabels = [...(record.youtubeVideoLabels ?? [])];
    let first = true;
    for (const videoId of missing.slice(0, 50)) {
      if (!first) await sleep(OEMBED_GAP_MS);
      first = false;
      const data = await fetchJsonWithTimeout(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`
      );
      if (!data || !data.title) continue; // silent skip — offline, private, or dead video
      freshLabels.push({
        videoId,
        title: String(data.title).trim().slice(0, 500),
        channel: data.author_name ? String(data.author_name).trim().slice(0, 200) : null,
      });
      result.refreshed += 1;
      await manager.mutatePublic({ op: 'drop.meta', id: record.id, patch: { youtubeVideoLabels: freshLabels } }).catch(() => {});
      opts.emit?.({
        phase: 'youtubeTitle',
        processedBytes: result.refreshed,
        totalBytes: result.needed,
        currentName: record.id,
        message: `Resolved ${result.refreshed}/${result.needed} titles`,
      });
    }
  }
  return result;
}

// ------------------------------------------------------------------ plumbing

/** Encrypt raw bytes (clipboard-origin images) straight into a new vblob. */
async function writeBytesIntoVault(manager: VaultManager, bytes: Uint8Array): Promise<VaultBlobRef> {
  const writer = manager.createVaultBlobWriter();
  const w = writer.writable.getWriter();
  await w.write(bytes);
  await w.close();
  return writer.ref();
}

async function streamPathIntoVault(
  manager: VaultManager,
  absolutePath: string,
  _displayNameHint: string | undefined,
  _mimeHint: string | undefined,
  _onProgress?: ProgressEmit
): Promise<VaultBlobRef> {
  const stat = await fsp.stat(absolutePath).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error('The attached file could not be read.');
  const writer = manager.createVaultBlobWriter();
  const fh = await fsp.open(absolutePath, 'r');
  try {
    const stream = fh.createReadStream();
    const done = readableToWritable(stream, writer.writable);
    await done;
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    await fh.close().catch(() => {});
  }
  return writer.ref();
}

/** Pump a Node readable into a web WritableStream, counting plaintext bytes along the way. */
function readableToWritable(
  source: import('node:stream').Readable,
  dest: WritableStream<Uint8Array>,
  onBytes?: (total: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const writer = dest.getWriter();
    let total = 0;
    let writing = true;
    source.on('data', (chunk: Buffer | Uint8Array) => {
      if (!writing) return;
      writing = false;
      source.pause();
      const bytes = chunk instanceof Uint8Array ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) : new Uint8Array(Buffer.from(chunk));
      total += bytes.byteLength;
      writer.write(bytes)
        .then(() => {
          writing = true;
          source.resume();
          onBytes?.(total);
        })
        .catch((error) => {
          writer.abort(error).catch(() => {});
          source.destroy();
          reject(error);
        });
    });
    source.on('end', () => {
      writer.close().then(() => resolve()).catch(reject);
    });
    source.on('error', (error) => {
      writer.abort(error).catch(() => {});
      reject(error);
    });
  });
}

async function sniffImageMime(manager: VaultManager, ref: VaultBlobRef): Promise<string> {
  try {
    const head = await manager.readBlobHead(ref, 16);
    if (head[0] === 0x89 && head[1] === 0x50) return 'image/png';
    if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
    if (head[0] === 0x47 && head[1] === 0x49) return 'image/gif';
    if (head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return 'image/webp';
  } catch {
    /* fall through */
  }
  return 'application/octet-stream';
}

function mimeFromExtension(ext: string): string {
  const map: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.ogv': 'video/ogg',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
    '.pdf': 'application/pdf', '.json': 'application/json', '.xml': 'application/xml',
    '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.html': 'text/html',
    '.js': 'text/javascript', '.ts': 'text/plain',
    '.zip': 'application/zip', '.7z': 'application/x-7z-compressed',
  };
  return map[ext] ?? 'application/octet-stream';
}

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._ -]+/g, '_').slice(0, 120);
  return cleaned || 'pasted-file.bin';
}
