/**
 * Archive WRITER — mirrors the web export pipeline byte-for-byte so generated test archives are
 * indistinguishable from real .dropsync exports (and Sitting 3's export-back reuses this).
 *
 *   headerBytes ‖ envelopeEncrypt(ZipWriterStream(level 0, zip64)( manifest.json, files/* ))
 */

import { createWriteStream } from 'node:fs';
import { Writable } from 'node:stream';

import { ZipWriterStream } from '@zip.js/zip.js';

import {
  createEnvelopeEncryptTransform,
  deriveArchiveKey,
  makeHeader,
  prependStream,
  throwIfAborted,
} from './envelope.ts';

export interface ArchiveEntryInput {
  /** ZIP path, e.g. 'files/<uuid>.bin' */
  name: string;
  bytes?: Uint8Array;
  stream?: ReadableStream<Uint8Array>;
}

/** Write a complete .dropsync archive to disk. Returns the header JSON (for assertions). */
export async function writeArchiveFile(
  outPath: string,
  password: string,
  manifestJsonBytes: Uint8Array,
  entries: ArchiveEntryInput[],
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  const { header, headerBytes } = makeHeader();
  const key = await deriveArchiveKey(password, header);
  const zipStream = new ZipWriterStream({ level: 0, zip64: true });
  const encryptedZipStream = zipStream.readable.pipeThrough(
    createEnvelopeEncryptTransform(key, header, headerBytes, signal)
  );
  const outputStream = prependStream(headerBytes, encryptedZipStream);
  const nodeDest = createWriteStream(outPath, { flags: 'w' });
  const pipePromise = outputStream.pipeTo(Writable.toWeb(nodeDest) as WritableStream<Uint8Array>);

  try {
    await new Blob([manifestJsonBytes as BlobPart]).stream().pipeTo(zipStream.writable('manifest.json'), { signal });
    for (const entry of entries) {
      throwIfAborted(signal);
      const source = entry.stream ?? new Blob([entry.bytes as BlobPart]).stream();
      await source.pipeTo(zipStream.writable(entry.name), { signal });
    }
    await zipStream.close(undefined, { zip64: true });
    await pipePromise;
  } catch (error) {
    nodeDest.destroy();
    throw error;
  }
}
