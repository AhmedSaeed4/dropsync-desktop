/**
 * Node-side archive loader — port of archiveFormat.ts loadArchive() with the browser `File`
 * replaced by a disk ArchiveSource. Every bound check, ZIP safety rule and error string is
 * preserved byte-for-byte. The reader slices ORIGINAL header bytes for AAD (never re-serializes).
 */

import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

import { configure, ZipReader, TextWriter, BlobWriter, type Entry, type FileEntry } from '@zip.js/zip.js';

import {
  ARCHIVE_MAX_ENTRIES,
  ARCHIVE_MAX_MANIFEST_BYTES,
  ARCHIVE_MAX_UNCOMPRESSED_BYTES,
  ArchiveValidationError,
  createEnvelopeDecryptTransform,
  deriveArchiveKey,
  isSafeZipPath,
  readEnvelopeHeaderFromSource,
  throwIfAborted,
  type ArchiveSource,
} from './envelope.ts';

// zip.js spawns web workers by default; in the Electron main process (and plain Node) we run inline.
configure({ useWebWorkers: false });

export interface LoadedArchive<T = unknown> {
  manifest: T;
  entries: Map<string, Entry>;
  reader: ZipReader<Uint8Array>;
  totalPayloadBytes: number;
}

/** Disk-backed ArchiveSource over a file path. */
export function fsArchiveSource(filePath: string, size: number): ArchiveSource {
  return {
    size,
    sliceStream(start: number, end?: number): ReadableStream<Uint8Array> {
      const node = createReadStream(filePath, { start, end: end === undefined ? undefined : end - 1 });
      return Readable.toWeb(node) as ReadableStream<Uint8Array>;
    },
  };
}

export async function statArchiveSize(filePath: string): Promise<number> {
  const { stat } = await import('node:fs/promises');
  return (await stat(filePath)).size;
}

export async function loadArchiveFromSource<T>(
  source: ArchiveSource,
  password: string,
  signal: AbortSignal | undefined,
  validateManifest: (manifest: unknown) => void
): Promise<LoadedArchive<T>> {
  throwIfAborted(signal);
  const parsed = await readEnvelopeHeaderFromSource(source);
  const key = await deriveArchiveKey(password, parsed.header);
  const encryptedStream = source.sliceStream(parsed.payloadOffset);
  const zipStream = encryptedStream.pipeThrough(
    createEnvelopeDecryptTransform(key, parsed.header, parsed.headerBytes, signal)
  );
  let reader: ZipReader<Uint8Array> | undefined;
  try {
    reader = new ZipReader<Uint8Array>(zipStream, {
      checkAmbiguity: true,
      strictness: 'strict',
    });
    const entries = await reader.getEntries();
    if (entries.length > ARCHIVE_MAX_ENTRIES + 1) throw new ArchiveValidationError('The archive contains too many entries.');
    const entryMap = new Map<string, Entry>();
    let totalPayloadBytes = 0;
    for (const entry of entries) {
      if (entryMap.has(entry.filename) || !isSafeZipPath(entry.filename)) {
        throw new ArchiveValidationError('The archive contains an unsafe or duplicate ZIP path.');
      }
      entryMap.set(entry.filename, entry);
      if (!entry.directory) {
        if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
          throw new ArchiveValidationError('The archive contains an invalid ZIP entry size.');
        }
        totalPayloadBytes += entry.uncompressedSize;
        if (totalPayloadBytes > ARCHIVE_MAX_UNCOMPRESSED_BYTES) {
          throw new ArchiveValidationError('The archive is too large to safely process in this browser.');
        }
      }
    }
    const manifestEntry = entryMap.get('manifest.json');
    if (!manifestEntry || manifestEntry.directory || manifestEntry.uncompressedSize > ARCHIVE_MAX_MANIFEST_BYTES) {
      throw new ArchiveValidationError('The archive manifest is missing or too large.');
    }
    const manifestText = await (manifestEntry as FileEntry).getData(new TextWriter(), { signal });
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestText) as unknown;
    } catch {
      throw new ArchiveValidationError('The archive manifest is invalid or unsupported.');
    }
    validateManifest(manifest);
    const referencedPaths = new Set<string>(['manifest.json']);
    const manifestDrops = (manifest as { drops?: Array<{ payloads?: { file?: string; image?: string } }> }).drops || [];
    for (const drop of manifestDrops) {
      for (const path of [drop.payloads?.file, drop.payloads?.image]) {
        if (path) {
          if (!entryMap.has(path)) throw new ArchiveValidationError(`The archive payload is missing: ${path}`);
          referencedPaths.add(path);
        }
      }
    }
    for (const entry of entries) {
      if (!entry.directory && !referencedPaths.has(entry.filename)) {
        throw new ArchiveValidationError(`The archive contains an unreferenced payload: ${entry.filename}`);
      }
    }
    if (!reader) throw new ArchiveValidationError('The archive reader did not initialize.');
    return { manifest: manifest as T, entries: entryMap, reader, totalPayloadBytes };
  } catch (error) {
    await reader?.close().catch(() => {});
    if (error instanceof ArchiveValidationError) throw error;
    // Wrong password surfaces here as a GCM auth failure — ONE generic message, no specifics.
    throw new Error('The archive password is wrong, or the archive is damaged.');
  }
}

/** Read one ZIP entry fully into memory (small payloads only). */
export async function readEntryBytes(entry: FileEntry, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  throwIfAborted(signal);
  const blob = await entry.getData(new BlobWriter(), { signal });
  return new Uint8Array(await blob.arrayBuffer());
}

export { ArchiveValidationError };
