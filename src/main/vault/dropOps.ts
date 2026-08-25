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
    next.contentSha256s.content = undefined;
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
  }
  if (updates.imagePath) {
    newImageRef = await streamPathIntoVault(manager, updates.imagePath, undefined, undefined, onProgress);
    next.imageSize = newImageRef.bytes;
    next.imageMimeType = await sniffImageMime(manager, newImageRef);
  } else if (updates.imageBytes && updates.imageBytes.byteLength > 0) {
    newImageRef = await writeBytesIntoVault(manager, updates.imageBytes);
    next.imageSize = newImageRef.bytes;
    next.imageMimeType = await sniffImageMime(manager, newImageRef);
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
    journalPatch.reminderAt = patch.reminderAt;
    journalPatch.reminderSetByUid = patch.reminderAt ? 'local' : null;
    journalPatch.reminderDismissedBy = null;
  }

  const labelsChanged =
    journalPatch.name !== undefined || journalPatch.categories !== undefined;
  if (labelsChanged) journalPatch.youtubeVideoLabels = [];

  if (Object.keys(journalPatch).length === 0) return record;
  await manager.mutatePublic({ op: 'drop.meta', id: dropId, patch: journalPatch });
  return manager.findDrop(dropId);
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
