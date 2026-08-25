/**
 * The ONE .dropsync importer engine (personal + workspace flavors).
 *
 * Byte-level envelope reading is shared with the web (archiveReader/envelope). Validation uses
 * the STRICT personal ruleset for BOTH flavors — deliberately harder than the web's workspace
 * side. Merge semantics are a faithful port of the web importers: fresh UUIDs, #[name](id)
 * mention remap, case-insensitive-trimmed category merge, two-pin cap, remainingSeconds timer
 * resume with the 24 h cap and legacy restart, YouTube-label normalization, duplicate-archiveId
 * warning, and an on-disk crash journal with reverse teardown on failure or next unlock.
 */

import type { FileEntry } from '@zip.js/zip.js';
import { createHash } from 'node:crypto';

import fsp from 'node:fs/promises';
import * as pathMod from 'node:path';

import {
  ARCHIVE_MAX_DROP_FILE_BYTES,
  ARCHIVE_MAX_ENTRIES,
  ArchiveValidationError,
  emitProgress,
  getFileEntryError,
  isExpired,
  parseDate,
  remapDropReferences,
  throwIfAborted,
  type ArchiveProgress,
} from './envelope.ts';
import { loadArchiveFromSource, fsArchiveSource, readEntryBytes, statArchiveSize } from './archiveReader.ts';
import { isPasswordCategories, normalizeYoutubeLabels } from './youtubeLabels.ts';
import { IMPORT_JOURNAL_FILE_NAME, VaultManager } from './vault.ts';
import { INLINE_TEXT_LIMIT, type VaultBlobRef, type VaultDropRecord, type YouTubeVideoLabel } from './vaultTypes.ts';

const MAX_REMAINING_SECONDS = 24 * 60 * 60;
const MAX_NAME_LENGTH = 120;

export const PERSONAL_ARCHIVE_SCHEMA = 'dropsync.personal' as const;
export const WORKSPACE_ARCHIVE_SCHEMA = 'dropsync.workspace' as const;
export type ImportFlavor = typeof PERSONAL_ARCHIVE_SCHEMA | typeof WORKSPACE_ARCHIVE_SCHEMA;

/** Desktop-adapted wrong-flavor wording (spec M1: web's wording adapted to desktop). */
export function desktopTypeMismatchMessage(actualSchema: unknown, expectedScope: 'personal' | 'workspace'): string | null {
  if (expectedScope === 'personal' && actualSchema === WORKSPACE_ARCHIVE_SCHEMA) {
    return 'This is a workspace backup — choose a workspace to restore it into.';
  }
  if (expectedScope === 'workspace' && actualSchema === PERSONAL_ARCHIVE_SCHEMA) {
    return 'This is a personal backup — it restores into your Personal space.';
  }
  return null;
}

export interface ArchiveDropManifest {
  sourceId: string;
  type: 'text' | 'file';
  name: string;
  content?: string;
  categories: string[];
  youtubeVideoLabels?: YouTubeVideoLabel[];
  pinned: boolean;
  locked: boolean;
  isDrawing: boolean;
  creatorName?: string;
  createdAt: string;
  expiresAt: string | null;
  remainingSeconds?: number | null;
  expirationOption?: '1h' | '2h' | '4h' | '6h' | '24h' | 'forever';
  reminderAt: string | null;
  reminderSetByUid?: string | null;
  reminderDismissedBy?: string | null;
  fileSize?: number;
  mimeType?: string;
  imageSize?: number;
  imageMimeType?: string;
  sourceFileFormat?: 'binary';
  drawingScene?: unknown;
  payloads?: {
    file?: string;
    image?: string;
  };
}

export interface ImportManifest {
  schema: ImportFlavor;
  schemaVersion: number;
  archiveId: string;
  exportedAt: string;
  sourceSpace?: 'personal';
  sourceUser?: { displayName?: string };
  sourceWorkspace?: { id: string; name: string; createdAt: string };
  members?: Array<{ displayName: string; isOwner: boolean }>;
  categories: Array<{ name: string; createdAt: string; createdByDisplayName?: string }>;
  drops: ArchiveDropManifest[];
}

export interface ArchiveInspection {
  flavor: ImportFlavor;
  archiveId: string;
  exportedAt: string;
  sourceName: string;
  dropCount: number;
  fileCount: number;
  passwordDropCount: number;
  lockedDropCount: number;
  foreverDropCount: number;
  zeroRemainingDropCount: number;
  totalPayloadBytes: number;
  /** True when ANY drop lacks remainingSeconds (older backup → legacy restart on import). */
  legacyTimers: boolean;
  warnings: string[];
}

export type ImportDestination =
  | { mode: 'personal' }
  | { mode: 'new'; name: string }
  | { mode: 'merge'; spaceId: string };

export interface ImportResult {
  spaceId: string;
  importedCount: number;
  legacyExpiryFallbackCount: number;
  zeroRemainingCount: number;
  downgradedForeverCount: number; // always 0 on desktop — no Firestore rules to trip
  unpinnedCount: number;
  warnings: string[];
}

interface DesktopImportJournal {
  archiveId: string;
  createdSpace: boolean;
  spaceId?: string;
  createdDropIds: string[];
  createdBlobPaths: string[];
  createdCategoryIds: string[];
}

// ------------------------------------------------------------------ validation

function validateImportManifest(raw: unknown): asserts raw is ImportManifest {
  try {
    validateBody(raw);
  } catch (error) {
    if (error instanceof ArchiveValidationError) throw error;
    throw new ArchiveValidationError(error instanceof Error ? error.message : 'The archive manifest is invalid or unsupported.');
  }
}

function validateBody(raw: unknown): void {
  const manifest = raw as Partial<ImportManifest> | null;
  if (
    !manifest
    || (manifest.schema !== PERSONAL_ARCHIVE_SCHEMA && manifest.schema !== WORKSPACE_ARCHIVE_SCHEMA)
    || manifest.schemaVersion !== 1
    || typeof manifest.archiveId !== 'string'
    || !manifest.archiveId
    || typeof manifest.exportedAt !== 'string'
    || !Array.isArray(manifest.categories)
    || !Array.isArray(manifest.drops)
  ) {
    throw new Error('The archive manifest is invalid or unsupported.');
  }
  if (manifest.schema === PERSONAL_ARCHIVE_SCHEMA && manifest.sourceSpace !== 'personal') {
    throw new Error('The archive manifest is invalid or unsupported.');
  }
  if (manifest.schema === WORKSPACE_ARCHIVE_SCHEMA && (!manifest.sourceWorkspace || typeof manifest.sourceWorkspace !== 'object')) {
    throw new Error('The archive manifest is invalid or unsupported.');
  }
  parseDate(manifest.exportedAt, 'exportedAt');
  if (manifest.drops.length > ARCHIVE_MAX_ENTRIES) throw new Error('The archive contains too many drops.');

  for (const category of manifest.categories) {
    if (!category || typeof category.name !== 'string' || !category.name.trim()) {
      throw new Error('The personal archive contains an invalid category.');
    }
    parseDate(category.createdAt, 'category.createdAt');
  }

  const sourceIds = new Set<string>();
  for (const drop of manifest.drops) {
    if (
      !drop
      || typeof drop.sourceId !== 'string'
      || !drop.sourceId
      || sourceIds.has(drop.sourceId)
      || (drop.type !== 'text' && drop.type !== 'file')
      || typeof drop.name !== 'string'
      || !drop.name
      || !Array.isArray(drop.categories)
    ) {
      throw new Error('The personal archive contains an invalid or duplicate drop record.');
    }
    sourceIds.add(drop.sourceId);
    if (
      drop.remainingSeconds !== undefined
      && drop.remainingSeconds !== null
      && (!Number.isSafeInteger(drop.remainingSeconds) || drop.remainingSeconds < 0 || drop.remainingSeconds > MAX_REMAINING_SECONDS)
    ) {
      throw new ArchiveValidationError(`The remaining expiry time is invalid for "${drop.name}".`);
    }
    if (drop.categories.some((category) => typeof category !== 'string')) {
      throw new Error(`The categories are invalid for "${drop.name}".`);
    }
    if (drop.youtubeVideoLabels !== undefined) {
      // STRICT ruleset for both flavors: text only, never drawings, never password categories.
      if (drop.type !== 'text' || drop.isDrawing || isPasswordCategories(drop.categories) || !Array.isArray(drop.youtubeVideoLabels)) {
        throw new Error(`The YouTube labels are invalid for "${drop.name}".`);
      }
      const labels = normalizeYoutubeLabels(drop.youtubeVideoLabels);
      if (labels.length !== drop.youtubeVideoLabels.length || labels.length > 50) {
        throw new Error(`The YouTube labels are invalid for "${drop.name}".`);
      }
    }
    if (drop.content != null && typeof drop.content !== 'string') {
      throw new Error(`The text content is invalid for "${drop.name}".`);
    }
    if (drop.type === 'file' && (!drop.payloads?.file || !drop.payloads.file.startsWith('files/'))) {
      throw new Error(`The file payload is missing or unsafe for "${drop.name}".`);
    }
    if (drop.payloads?.image && !drop.payloads.image.startsWith('files/')) {
      throw new Error(`The image payload is unsafe for "${drop.name}".`);
    }
    if (drop.isDrawing && !drop.payloads?.image) {
      throw new Error(`The drawing payload is missing for "${drop.name}".`);
    }
    if (drop.sourceFileFormat !== undefined && drop.sourceFileFormat !== 'binary') {
      throw new Error(`The file format is invalid for "${drop.name}".`);
    }
    parseDate(drop.createdAt, 'createdAt');
    parseDate(drop.expiresAt, 'expiresAt');
    parseDate(drop.reminderAt, 'reminderAt');
    if (drop.fileSize != null && (!Number.isSafeInteger(drop.fileSize) || drop.fileSize < 0 || drop.fileSize > ARCHIVE_MAX_DROP_FILE_BYTES)) {
      throw new Error(`The file size is invalid or exceeds the 500 MB limit for "${drop.name}".`);
    }
    if (drop.imageSize != null && (!Number.isSafeInteger(drop.imageSize) || drop.imageSize < 0 || drop.imageSize > ARCHIVE_MAX_DROP_FILE_BYTES)) {
      throw new Error(`The attached image size is invalid or exceeds the 500 MB limit for "${drop.name}".`);
    }
  }
}

// ------------------------------------------------------------------ inspection

function summarize(flavor: ImportFlavor, manifest: ImportManifest, totalPayloadBytes: number): ArchiveInspection {
  const hasPasswordDrops = manifest.drops.some((drop) => drop.categories.some((category) => category.toLowerCase() === 'password'));
  return {
    flavor,
    archiveId: manifest.archiveId,
    exportedAt: manifest.exportedAt,
    sourceName:
      manifest.schema === WORKSPACE_ARCHIVE_SCHEMA
        ? manifest.sourceWorkspace?.name || 'Workspace backup'
        : manifest.sourceUser?.displayName
          ? `Personal drops from ${manifest.sourceUser.displayName}`
          : 'Personal drops',
    dropCount: manifest.drops.length,
    fileCount: manifest.drops.filter((drop) => drop.type === 'file').length,
    passwordDropCount: manifest.drops.filter((drop) => drop.categories.some((category) => category.toLowerCase() === 'password')).length,
    lockedDropCount: manifest.drops.filter((drop) => drop.locked).length,
    foreverDropCount: manifest.drops.filter((drop) => (
      drop.remainingSeconds !== undefined ? drop.remainingSeconds === null : drop.expiresAt === null
    )).length,
    zeroRemainingDropCount: manifest.drops.filter((drop) => drop.remainingSeconds === 0).length,
    totalPayloadBytes,
    legacyTimers: manifest.drops.some((drop) => drop.remainingSeconds === undefined),
    warnings: hasPasswordDrops ? ['This archive includes password-category drops.'] : [],
  };
}

async function loadArchiveFile<T>(
  filePath: string,
  password: string,
  signal: AbortSignal | undefined
): Promise<{ manifest: T; entries: Map<string, FileEntry>; totalPayloadBytes: number; reader: { close(): Promise<void> } }> {
  assertArchivePassword(password);
  const size = await statArchiveSize(filePath);
  const loaded = await loadArchiveFromSource<T>(
    fsArchiveSource(filePath, size),
    password,
    signal,
    validateImportManifest as (manifest: unknown) => void
  );
  return {
    manifest: loaded.manifest,
    entries: loaded.entries as Map<string, FileEntry>,
    totalPayloadBytes: loaded.totalPayloadBytes,
    reader: loaded.reader,
  };
}

function assertArchivePassword(password: string): void {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Use an archive password with at least 8 characters.');
  }
  if (password.length > 512) {
    throw new Error('The archive password is too long.');
  }
}

export async function inspectArchive(
  filePath: string,
  password: string,
  signal?: AbortSignal,
  onProgress?: (progress: ArchiveProgress) => void
): Promise<ArchiveInspection> {
  emitProgress(onProgress, { phase: 'inspect', processedBytes: 0, totalBytes: await statArchiveSize(filePath), message: 'Checking backup…' });
  const loaded = await loadArchiveFile<ImportManifest>(filePath, password, signal);
  try {
    return summarize(loaded.manifest.schema, loaded.manifest, loaded.totalPayloadBytes);
  } finally {
    await loaded.reader.close();
  }
}

// ------------------------------------------------------------------ crash journal

async function journalPath(manager: VaultManager): Promise<string> {
  return pathMod.join(pathMod.dirname(manager.vaultFilePath), IMPORT_JOURNAL_FILE_NAME);
}

async function saveJournal(journal: DesktopImportJournal): Promise<void> {
  // Best effort: losing this file only loses CRASH recovery; synchronous rollback stays active.
  try {
    await fsp.writeFile(await journalPath(journalRef.manager!), JSON.stringify(journal), 'utf8');
  } catch {
    /* ignore */
  }
}
let journalRef: { manager: VaultManager | null } = { manager: null };

async function clearJournal(): Promise<void> {
  try {
    await fsp.unlink(await journalPath(journalRef.manager!));
  } catch {
    /* best effort */
  }
}

/** Next-unlock recovery: roll back whatever an interrupted import left behind. */
export async function recoverInterruptedImport(manager: VaultManager): Promise<void> {
  journalRef.manager = manager;
  const path = await journalPath(manager);
  let journal: DesktopImportJournal | null = null;
  try {
    const raw = await fsp.readFile(path, 'utf8');
    journal = JSON.parse(raw) as DesktopImportJournal;
  } catch {
    return;
  }
  await teardown(manager, journal);
}

async function teardown(manager: VaultManager, journal: DesktopImportJournal): Promise<void> {
  for (const blobPath of journal.createdBlobPaths || []) {
    try {
      await fsp.unlink(pathMod.join(pathMod.dirname(manager.vaultFilePath), blobPath));
    } catch {
      /* already gone */
    }
  }
  for (const dropId of journal.createdDropIds || []) {
    await manager.deleteDropQuiet(dropId);
  }
  for (const categoryId of journal.createdCategoryIds || []) {
    await manager.deleteCategoryQuiet(categoryId);
  }
  if (journal.createdSpace && journal.spaceId) {
    await manager.deleteSpaceQuiet(journal.spaceId);
  }
  await clearJournal();
}

// ------------------------------------------------------------------ streaming payload ingestion

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function ingestEntry(
  entry: FileEntry,
  writer: ReturnType<VaultManager['createVaultBlobWriter']>,
  expectedBytes: number | undefined,
  dropName: string,
  kind: 'file' | 'image',
  signal: AbortSignal | undefined,
  onProgress: (count: number) => void
): Promise<VaultBlobRef> {
  const declaredBytes = entry.uncompressedSize;
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
    throw new Error('The archive contains an invalid raw file size.');
  }
  if (declaredBytes > ARCHIVE_MAX_DROP_FILE_BYTES) {
    throw new Error('The raw file exceeds the 500 MB limit.');
  }
  if (expectedBytes != null && declaredBytes !== expectedBytes) {
    throw new Error('Imported file bytes do not match the manifest size.');
  }

  throwIfAborted(signal);
  let actual = 0;
  const counting = new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
    transform(chunk, controller) {
      actual += chunk.byteLength;
      onProgress(actual);
      controller.enqueue(chunk);
    },
  });
  // zip entry → counting → vault blob writer. The pipe MUST be drained before finish()
  // so the recorded sha256/bytes cover every byte.
  // zip.js v2.8 duck-types a writer as {writable} and closes it when done. The pipe MUST be
  // drained before finish() so the recorded sha256/bytes cover every byte.
  const pipeDone = counting.readable.pipeTo(writer.writable);
  try {
    await entry.getData({ writable: counting.writable } as never, { signal });
    await pipeDone;
  } catch (error) {
    pipeDone.catch(() => {});
    await writer.abort();
    throw error;
  }
  throwIfAborted(signal);

  if (expectedBytes != null && actual !== expectedBytes) {
    await writer.abort();
    throw new Error(kind === 'image'
      ? `The drawing/image bytes for "${dropName}" do not match the manifest size.`
      : `The imported bytes for "${dropName}" do not match the manifest size.`);
  }
  return writer.ref();
}

// ------------------------------------------------------------------ the importer

export async function importArchive(options: {
  manager: VaultManager;
  filePath: string;
  password: string;
  destination: ImportDestination;
  signal?: AbortSignal;
  onProgress?: (progress: ArchiveProgress) => void;
}): Promise<ImportResult> {
  const { manager, filePath, password, destination, signal, onProgress } = options;
  journalRef.manager = manager;
  const loaded = await loadArchiveFile<ImportManifest>(filePath, password, signal);
  const manifest = loaded.manifest;

  const journal: DesktopImportJournal = {
    archiveId: manifest.archiveId,
    createdSpace: false,
    createdDropIds: [],
    createdBlobPaths: [],
    createdCategoryIds: [],
  };

  const warnings: string[] = [...summarize(manifest.schema, manifest, loaded.totalPayloadBytes).warnings];
  let importedCount = 0;
  let legacyExpiryFallbackCount = 0;
  let zeroRemainingCount = 0;
  const downgradedForeverCount = 0;
  let unpinnedCount = 0;

  try {
    // Destination resolution.
    let spaceId: string;
    if (destination.mode === 'personal') {
      spaceId = 'personal';
    } else if (destination.mode === 'new') {
      const name = (destination.name.trim().slice(0, MAX_NAME_LENGTH)) || 'Restored workspace';
      const space = await manager.createSpace(name);
      spaceId = space.id;
      journal.createdSpace = true;
      journal.spaceId = spaceId;
    } else {
      spaceId = destination.spaceId;
      if (!manager.peekDropListHas(spaceId)) throw new Error('The destination workspace no longer exists.');
    }

    await saveJournalWith(manager, journal);

    // Categories merge — case-insensitive-trimmed by name; skip empty/password/link.
    for (const category of manifest.categories) {
      throwIfAborted(signal);
      const normalized = category.name.toLowerCase().trim();
      if (!normalized || normalized === 'password' || normalized === 'link') continue;
      const existing = manager.listCategories(spaceId).find((c) => c.name.toLowerCase().trim() === normalized);
      if (existing) continue;
      const created = await manager.createCategory(spaceId, category.name.trim());
      journal.createdCategoryIds.push(created.id);
      await saveJournalWith(manager, journal);
    }

    // Pin cap seeds from the destination's LIVE pins.
    const existingDrops = manager.listDropsIncludingExpired(spaceId);
    let pinnedCount = existingDrops.filter((d) => d.pinned && !isExpired({ expiresAt: d.expiresAt })).length;

    const sourceToNewId = new Map<string, string>();
    for (const archiveDrop of manifest.drops) {
      sourceToNewId.set(archiveDrop.sourceId, crypto.randomUUID());
    }

    const importNow = new Date();
    const totalBytes = Math.max(loaded.totalPayloadBytes, 1);
    let processedBytes = 0;

    for (const archiveDrop of manifest.drops) {
      throwIfAborted(signal);
      const newDropId = sourceToNewId.get(archiveDrop.sourceId)!;

      // Categories remap (map hit, or pass through password/link verbatim).
      const categories = archiveDrop.categories
        .map((name) => {
          const normalized = name.toLowerCase().trim();
          const found = manager.listCategories(spaceId).find((c) => c.name.toLowerCase().trim() === normalized);
          if (found) return found.name;
          return normalized === 'password' || normalized === 'link' ? name.trim() : null;
        })
        .filter((name): name is string => !!name);

      // Mention remap + warning.
      const missingReferenceIds = new Set<string>();
      const content = archiveDrop.type === 'text'
        ? remapDropReferences(archiveDrop.content == null ? '' : archiveDrop.content, sourceToNewId, missingReferenceIds)
        : undefined;
      if (missingReferenceIds.size > 0) {
        warnings.push(`Drop "${archiveDrop.name}" references ${missingReferenceIds.size} excluded or missing drop${missingReferenceIds.size === 1 ? '' : 's'}.`);
      }

      // Timer math — port of the web importers, exactly.
      let expirationOption: VaultDropRecord['expirationOption'] = archiveDrop.expirationOption;
      let expiresAt: Date | null;
      if (archiveDrop.remainingSeconds !== undefined) {
        if (archiveDrop.remainingSeconds === null) {
          expirationOption = 'forever';
          expiresAt = null;
        } else {
          if (archiveDrop.remainingSeconds === 0) zeroRemainingCount += 1;
          expiresAt = new Date(importNow.getTime() + Math.min(archiveDrop.remainingSeconds, MAX_REMAINING_SECONDS) * 1000);
        }
      } else if (archiveDrop.expiresAt === null) {
        expirationOption = 'forever';
        expiresAt = null;
      } else {
        legacyExpiryFallbackCount += 1;
        const legacyOption: Exclude<VaultDropRecord['expirationOption'], 'forever' | undefined> =
          archiveDrop.expirationOption === '1h'
            || archiveDrop.expirationOption === '2h'
            || archiveDrop.expirationOption === '4h'
            || archiveDrop.expirationOption === '6h'
            || archiveDrop.expirationOption === '24h'
            ? archiveDrop.expirationOption
            : '2h';
        expirationOption = legacyOption;
        const hours = parseInt(legacyOption.replace('h', ''), 10);
        expiresAt = new Date(importNow.getTime() + hours * 60 * 60 * 1000);
      }

      // Two-pin cap against the destination's live pins; overflow silently unpins + counts.
      let pinned = archiveDrop.pinned;
      if (pinned && pinnedCount >= 2) {
        pinned = false;
        unpinnedCount += 1;
      } else if (pinned) {
        pinnedCount += 1;
      }

      const record: VaultDropRecord = {
        id: newDropId,
        spaceId,
        type: archiveDrop.type,
        name: archiveDrop.name,
        categories,
        pinned,
        locked: archiveDrop.locked,
        isDrawing: !!archiveDrop.isDrawing,
        createdAt: (parseDate(archiveDrop.createdAt, 'createdAt') || importNow).toISOString(),
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        expirationOption,
        reminderAt: parseDate(archiveDrop.reminderAt, 'reminderAt')?.toISOString() ?? null,
        reminderSetByUid: archiveDrop.reminderAt ? 'local' : null,
        reminderDismissedBy: null,
        creatorName: archiveDrop.creatorName,
        youtubeVideoLabels: undefined,
        importedFromArchiveId: manifest.archiveId,
        drawingScene: archiveDrop.drawingScene ?? undefined,
        blobRefs: {},
        contentSha256s: {},
      };

      const importedLabels = normalizeYoutubeLabels(archiveDrop.youtubeVideoLabels);
      if (archiveDrop.type === 'text' && !archiveDrop.isDrawing && !isPasswordCategories(categories) && importedLabels.length > 0) {
        record.youtubeVideoLabels = importedLabels;
      }

      if (archiveDrop.type === 'text') {
        const textBytes = new TextEncoder().encode(content ?? '');
        record.contentSha256s.content = sha256Hex(textBytes);
        if (textBytes.byteLength > INLINE_TEXT_LIMIT) {
          const writer = manager.createVaultBlobWriter();
          const w = writer.writable.getWriter();
          try {
            await w.write(textBytes);
            await w.close();
          } finally {
            w.releaseLock();
          }
          const ref = await writer.ref();
          journal.createdBlobPaths.push(ref.path);
          await saveJournalWith(manager, journal);
          record.blobRefs.body = ref;
        } else {
          record.content = content ?? '';
        }

        if (archiveDrop.payloads?.image) {
          const entryError = getFileEntryError(archiveDrop.payloads.image, loaded.entries.has(archiveDrop.payloads.image));
          if (entryError) throw new ArchiveValidationError(entryError);
          const entry = loaded.entries.get(archiveDrop.payloads.image)!;
          const writer = manager.createVaultBlobWriter();
          const ref = await ingestEntry(entry, writer, archiveDrop.imageSize, archiveDrop.name, 'image', signal, (count) =>
            emitProgress(onProgress, { phase: 'import', processedBytes, totalBytes, currentName: archiveDrop.name, message: `Importing ${archiveDrop.name}` })
          );
          journal.createdBlobPaths.push(ref.path);
          await saveJournalWith(manager, journal);
          record.blobRefs.image = ref;
          record.contentSha256s.image = ref.sha256;
          record.imageSize = archiveDrop.imageSize ?? ref.bytes;
          record.imageMimeType = archiveDrop.imageMimeType || 'image/png';
        }
      } else {
        if (archiveDrop.fileSize != null) record.fileSize = archiveDrop.fileSize;
        record.mimeType = archiveDrop.mimeType || 'application/octet-stream';
        const entryError = getFileEntryError(archiveDrop.payloads!.file!, loaded.entries.has(archiveDrop.payloads!.file!));
        if (entryError) throw new ArchiveValidationError(entryError);
        const entry = loaded.entries.get(archiveDrop.payloads!.file!)!;
        const writer = manager.createVaultBlobWriter();
        const ref = await ingestEntry(entry, writer, archiveDrop.fileSize, archiveDrop.name, 'file', signal, (count) =>
          emitProgress(onProgress, { phase: 'import', processedBytes, totalBytes, currentName: archiveDrop.name, message: `Importing ${archiveDrop.name}` })
        );
        journal.createdBlobPaths.push(ref.path);
        await saveJournalWith(manager, journal);
        record.blobRefs.file = ref;
        record.contentSha256s.file = ref.sha256;
        record.fileSize = archiveDrop.fileSize ?? ref.bytes;
      }

      await manager.putDrop(record);
      journal.createdDropIds.push(newDropId);
      await saveJournalWith(manager, journal);
      importedCount += 1;
      emitProgress(onProgress, {
        phase: 'import',
        processedBytes,
        totalBytes,
        currentName: archiveDrop.name,
        message: `Imported ${archiveDrop.name}`,
      });
    }

    // Success: clear the crash journal BEFORE reader cleanup so cleanup can never roll back a
    // completed restore on the next unlock.
    await clearJournal();
    try {
      await loaded.reader.close();
    } catch (error) {
      console.warn('Archive reader cleanup failed after a successful import:', error);
    }
    await manager.flushNow();
    return { spaceId, importedCount, legacyExpiryFallbackCount, zeroRemainingCount, downgradedForeverCount, unpinnedCount, warnings };
  } catch (error) {
    await loaded.reader.close().catch(() => {});
    await teardown(manager, journal);
    if ((error as { name?: string })?.name === 'AbortError' || (error instanceof Error && error.message === 'Archive operation cancelled.')) {
      throw error;
    }
    throw error;
  }
}

// Journal helpers bound to a specific manager instance (the module-level ref exists so the
// recover path can share the same persistence code without threading it through every call).
async function saveJournalWith(manager: VaultManager, journal: DesktopImportJournal): Promise<void> {
  journalRef.manager = manager;
  await saveJournal(journal);
}
