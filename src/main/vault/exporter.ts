/**
 * .dropsync EXPORTER — the return trip home (Sitting 3, M5).
 *
 * Wraps archiveWriter.writeArchiveFile (byte-compatible with the web exporter) with the vault's
 * manifest assembly. Field-by-field shape mirrors the strict importer (importer.ts) and the
 * reference web exporters (personalArchive.ts / workspaceArchive.ts):
 *
 *   - Personal space  → schema 'dropsync.personal'   (sourceSpace:'personal')
 *   - Local workspace → schema 'dropsync.workspace'  (sourceWorkspace + members + creatorName)
 *   - Expired drops are SKIPPED and counted; text rides in the manifest plaintext; drawings
 *     export exactly like the web (PNG payload under payloads.image — its embedded Excalidraw
 *     scene reopens on both platforms; a stored drawingScene is carried through when present);
 *   - Timers serialize as remainingSeconds = clamp(expiresAt − exportNow, 0..86400), forever=null;
 *   - youtubeVideoLabels only for eligible non-drawing text (import-normalization eligibility).
 *
 * Caps are enforced BEFORE any bytes are written: >20 GB total payload ⇒ refuse (anything in the
 * vault must fit back through the web door). The archive is written to <outPath>.part and renamed
 * atomically; cancellation/failure deletes the .part — zero partial files, vault untouched.
 */

import fsp from 'node:fs/promises';

import {
  ARCHIVE_MAX_UNCOMPRESSED_BYTES,
  assertPassword,
  countedStream,
  emitProgress,
  isExpired,
  throwIfAborted,
  type ArchiveProgress,
} from './envelope.ts';
import { writeArchiveFile, type ArchiveEntryInput } from './archiveWriter.ts';
import { isPasswordCategories, normalizeYoutubeLabels } from './youtubeLabels.ts';
import type { VaultManager } from './vault.ts';
import type { VaultDropRecord } from './vaultTypes.ts';

export const PERSONAL_ARCHIVE_SCHEMA = 'dropsync.personal' as const;
export const WORKSPACE_ARCHIVE_SCHEMA = 'dropsync.workspace' as const;

/** Spec Decision 4: per-archive total cap — identical bound to the reader's 20 GB guard. */
export const ARCHIVE_TOTAL_CAP_BYTES = ARCHIVE_MAX_UNCOMPRESSED_BYTES;

const MAX_REMAINING_SECONDS = 24 * 60 * 60;

export interface ExportSkippedDrop {
  name: string;
  reason: string;
}

export interface ExportSummary {
  included: number;
  skippedExpired: number;
  skippedOther: ExportSkippedDrop[];
  totalPayloadBytes: number;
}

/** The manifest drop record — the exact ArchiveDropManifest contract importer.ts validates. */
interface ExportDrop {
  sourceId: string;
  type: 'text' | 'file';
  name: string;
  content?: string;
  categories: string[];
  youtubeVideoLabels?: Array<{ videoId: string; title: string; channel: string | null }>;
  pinned: boolean;
  locked: boolean;
  isDrawing: boolean;
  creatorName?: string;
  createdAt: string;
  expiresAt: string | null;
  remainingSeconds?: number | null;
  expirationOption?: VaultDropRecord['expirationOption'];
  reminderAt: string | null;
  reminderSetByUid?: string | null;
  reminderDismissedBy?: string | null;
  fileSize?: number;
  mimeType?: string;
  imageSize?: number;
  imageMimeType?: string;
  drawingScene?: unknown;
  payloads?: { file?: string; image?: string };
}

interface PreparedEntry {
  /** ZIP path, e.g. 'files/<uuid>.bin' */
  entryName: string;
  dropId: string;
  /** Which VAULT slot the bytes stream from (drawings export an image slot fed from blobRefs.file). */
  sourceKind: 'file' | 'image';
  expectedBytes: number;
  displayName: string;
}

function remainingSecondsFor(expiresAtIso: string | null, exportNow: Date): number | null {
  if (expiresAtIso == null) return null;
  const ms = new Date(expiresAtIso).getTime() - exportNow.getTime();
  return Math.min(MAX_REMAINING_SECONDS, Math.max(0, Math.round(ms / 1000)));
}

/** Build the manifest record + payload entry plan for one drop, mirroring the web preflight. */
async function buildExportDrop(
  manager: VaultManager,
  record: VaultDropRecord,
  exportNow: Date,
  entries: PreparedEntry[],
  estimated: { bytes: number }
): Promise<ExportDrop> {
  // Payload slots FIRST — every included binary must have a plan before the manifest is built.
  const payloads: { file?: string; image?: string } = {};
  if (record.type === 'file') {
    if (!record.blobRefs.file) throw new Error('The file payload is missing.');
    payloads.file = `files/${crypto.randomUUID()}.bin`;
    entries.push({
      entryName: payloads.file,
      dropId: record.id,
      sourceKind: 'file',
      expectedBytes: record.fileSize ?? record.blobRefs.file.bytes,
      displayName: record.name,
    });
    estimated.bytes += record.fileSize ?? record.blobRefs.file.bytes;
  }
  // Attached images (blobRefs.image) AND drawings (PNG in blobRefs.file, or blobRefs.image for
  // imported ones) both ride the IMAGE payload slot — importer validation requires a drawing to
  // carry payloads.image. The stream source follows wherever the bytes actually live.
  const imageRef = record.blobRefs.image ?? (record.isDrawing ? record.blobRefs.file : undefined);
  if (record.type === 'text' && imageRef) {
    payloads.image = `files/${crypto.randomUUID()}.img`;
    entries.push({
      entryName: payloads.image,
      dropId: record.id,
      sourceKind: record.blobRefs.image ? 'image' : 'file',
      expectedBytes: record.imageSize ?? imageRef.bytes,
      displayName: record.name,
    });
    estimated.bytes += record.imageSize ?? imageRef.bytes;
  }

  let content: string | undefined;
  if (record.type === 'text') {
    const payload = await manager.getTextPayload(record.id);
    content = payload?.text ?? '';
    estimated.bytes += new TextEncoder().encode(content).byteLength;
  }

  const eligibleForLabels = record.type === 'text' && !record.isDrawing && !isPasswordCategories(record.categories);

  return {
    sourceId: record.id,
    type: record.type,
    name: record.name,
    content,
    categories: [...record.categories],
    youtubeVideoLabels: eligibleForLabels ? normalizeYoutubeLabels(record.youtubeVideoLabels) : undefined,
    pinned: !!record.pinned,
    locked: !!record.locked,
    isDrawing: !!record.isDrawing,
    ...(manager.listSpaces().some((s) => s.id !== 'personal' && s.id === record.spaceId) ? { creatorName: record.creatorName } : {}),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    remainingSeconds: remainingSecondsFor(record.expiresAt, exportNow),
    expirationOption: record.expirationOption,
    reminderAt: record.reminderAt,
    reminderSetByUid: record.reminderSetByUid ?? null,
    reminderDismissedBy: record.reminderDismissedBy ?? null,
    fileSize: record.type === 'file' ? record.fileSize : undefined,
    mimeType: record.type === 'file' ? record.mimeType : undefined,
    imageSize: record.type === 'text' && imageRef ? record.imageSize ?? imageRef.bytes : undefined,
    imageMimeType:
      record.type === 'text' && imageRef
        ? record.isDrawing
          ? record.mimeType || 'image/png'
          : record.imageMimeType || 'image/png'
        : undefined,
    drawingScene: record.drawingScene ?? undefined,
    payloads,
  };
}

export async function exportSpaceArchive(options: {
  manager: VaultManager;
  scope: 'personal' | { workspaceId: string };
  password: string;
  outPath: string;
  signal?: AbortSignal;
  onProgress?: (progress: ArchiveProgress) => void;
}): Promise<ExportSummary> {
  const { manager, password, outPath, signal, onProgress } = options;
  assertPassword(password);
  manager.assertUnlockedPublic();
  throwIfAborted(signal);

  // ---- scope resolution ---------------------------------------------------------------
  const isPersonal = options.scope === 'personal';
  const spaceId = isPersonal ? 'personal' : (options.scope as { workspaceId: string }).workspaceId;
  if (!manager.peekDropListHas(spaceId)) throw new Error('That workspace no longer exists.');
  const workspace = isPersonal ? null : manager.listSpaces().find((s) => s.id === spaceId) ?? null;
  if (!isPersonal && !workspace) throw new Error('That workspace no longer exists.');
  const exportNow = new Date();

  emitProgress(onProgress, { phase: 'preflight', processedBytes: 0, totalBytes: 1, message: 'Preparing backup…' });

  // ---- preflight: manifest records + payload plan (expired skipped + counted) ----------
  const manifestDrops: ExportDrop[] = [];
  const preparedEntries: PreparedEntry[] = [];
  const skippedOther: ExportSkippedDrop[] = [];
  let skippedExpired = 0;
  const estimated = { bytes: 0 };
  const records = manager.listDropsIncludingExpired(spaceId);

  for (let index = 0; index < records.length; index++) {
    throwIfAborted(signal);
    manager.touch(); // export counts as activity — the idle auto-lock must not fire mid-export
    const record = records[index];
    emitProgress(onProgress, {
      phase: 'preflight',
      processedBytes: index + 1,
      totalBytes: Math.max(records.length, 1),
      currentName: record.name,
      message: `Preparing ${record.name}`,
    });
    if (isExpired({ expiresAt: record.expiresAt }, exportNow)) {
      skippedExpired += 1;
      continue;
    }
    try {
      manifestDrops.push(await buildExportDrop(manager, record, exportNow, preparedEntries, estimated));
    } catch (error) {
      skippedOther.push({ name: record.name, reason: error instanceof Error && error.message ? error.message : 'The drop could not be read.' });
    }
  }

  // ---- caps BEFORE any bytes are written (Decision 4) ----------------------------------
  if (estimated.bytes > ARCHIVE_TOTAL_CAP_BYTES) {
    throw new Error('This space exceeds the 20 GB backup limit and cannot be exported.');
  }

  const categories = manager.listCategories(spaceId).map((c) =>
    isPersonal
      ? { name: c.name, createdAt: c.createdAt }
      : { name: c.name, createdByDisplayName: 'local', createdAt: c.createdAt }
  );

  // ---- manifest assembly (flavor-exact shapes from the reference web exporters) ---------
  const manifest = isPersonal
    ? {
        schema: PERSONAL_ARCHIVE_SCHEMA,
        schemaVersion: 1,
        archiveId: crypto.randomUUID(),
        exportedAt: new Date().toISOString(),
        sourceSpace: 'personal' as const,
        categories,
        drops: manifestDrops,
      }
    : {
        schema: WORKSPACE_ARCHIVE_SCHEMA,
        schemaVersion: 1,
        archiveId: crypto.randomUUID(),
        exportedAt: new Date().toISOString(),
        sourceWorkspace: {
          id: workspace!.id,
          name: workspace!.name,
          createdAt: workspace!.createdAt,
        },
        members: [{ displayName: 'local', isOwner: true }],
        categories,
        drops: manifestDrops,
      };

  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const estimatedArchiveBytes = estimated.bytes + manifestBytes.byteLength + 4096;

  // ---- write phase: <outPath>.part → atomic rename; cancel/failure deletes the .part -----
  const partPath = `${outPath}.part`;
  let processedBytes = 0;
  try {
    const entries: ArchiveEntryInput[] = preparedEntries.map((prepared) => ({
      name: prepared.entryName,
      stream: (() => {
        const raw = manager.streamBlob(prepared.dropId, prepared.sourceKind);
        if (!raw) throw new Error(`The payload is missing for "${prepared.displayName}".`);
        const counted = countedStream(raw, (count) => {
          manager.touch();
          emitProgress(onProgress, {
            phase: 'export',
            processedBytes: processedBytes + count,
            totalBytes: Math.max(estimatedArchiveBytes, 1),
            currentName: prepared.displayName,
            message: `Exporting ${prepared.displayName}`,
          });
        });
        return counted.stream;
      })(),
    }));
    await writeArchiveFile(partPath, password, manifestBytes, entries, signal);
    await fsp.rename(partPath, outPath);
  } catch (error) {
    await fsp.unlink(partPath).catch(() => {});
    throw error;
  }

  return { included: manifestDrops.length, skippedExpired, skippedOther, totalPayloadBytes: estimated.bytes };
}
