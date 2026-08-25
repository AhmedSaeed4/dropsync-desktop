/**
 * .vblob storage — one file per attachment / drawing PNG / oversized text body.
 *
 * Same 4 MiB chunk + AAD scheme as the envelope (ported, not reinvented): each blob carries its
 * own fresh noncePrefix in a small JSON header; IV = prefix ‖ u32le(chunkIndex); AAD =
 * blobHeaderBytes ‖ u32le(chunkIndex) ‖ u32le(plainLength); frames are [u32le ctLen][ct].
 * Writes stream (plaintext never buffers whole-file); a running SHA-256 of the PLAINTEXT is
 * recorded in the index for integrity. Reads support byte ranges so 500 MB videos can seek.
 */

import { createHash } from 'node:crypto';
import { createEnvelopeDecryptTransform, createEnvelopeEncryptTransform, type EnvelopeHeaderShape } from './envelope.ts';

const BLOB_MAGIC = 'DRPBLOB1';
const BLOB_CHUNK_SIZE = 4 * 1024 * 1024;

interface BlobHeader {
  magic: string;
  version: number;
  cipher: 'AES-256-GCM-CHUNKED';
  chunkSize: number;
  noncePrefix: string;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function uint32Bytes(value: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(4));
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

function readUint32Le(bytes: Uint8Array, offset = 0): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function b64encode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export interface BlobFs {
  open(path: string, flags: string): Promise<FileHandleLike>;
  rename(src: string, dest: string): Promise<void>;
  unlink(path: string): Promise<void>;
  statSize(path: string): Promise<number>;
}

export interface FileHandleLike {
  createWriteStream(): NodeJS.WritableStream;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  stat(): Promise<{ size: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export function makeNodeBlobFs(fs: typeof import('node:fs').promises): BlobFs {
  return {
    open: (path, flags) => fs.open(path, flags) as unknown as Promise<FileHandleLike>,
    rename: (src, dest) => fs.rename(src, dest),
    unlink: (path) => fs.unlink(path).catch(() => {}),
    statSize: async (path) => (await fs.stat(path)).size,
  };
}

function blobHeaderFor(headerBytes: Uint8Array): BlobHeader {
  return JSON.parse(new TextDecoder().decode(headerBytes.slice(BLOB_MAGIC.length + 4))) as BlobHeader;
}

export interface OpenBlobWriter {
  writable: WritableStream<Uint8Array>;
  finish(): Promise<{ sha256: string; bytes: number }>;
  abort(): Promise<void>;
}

/** Stream-encrypt plaintext into `<finalPath>` (via `<finalPath>.tmp` → fsync → rename). */
export function createBlobWriter(fsmod: BlobFs, finalPath: string, dek: CryptoKey): OpenBlobWriter {
  const noncePrefixBytes = crypto.getRandomValues(new Uint8Array(8));
  const header: BlobHeader = {
    magic: BLOB_MAGIC,
    version: 1,
    cipher: 'AES-256-GCM-CHUNKED',
    chunkSize: BLOB_CHUNK_SIZE,
    noncePrefix: b64encode(noncePrefixBytes),
  };
  const headerJson = new TextEncoder().encode(JSON.stringify(header));
  const headerBytes = concatBytes(new TextEncoder().encode(BLOB_MAGIC), uint32Bytes(headerJson.byteLength), headerJson);

  const encHeader: EnvelopeHeaderShape = {
    magic: BLOB_MAGIC,
    version: 1,
    cipher: 'AES-256-GCM-CHUNKED',
    chunkSize: BLOB_CHUNK_SIZE,
    kdf: { name: 'PBKDF2-SHA256', version: 1, iterations: 600_000, salt: '' },
    noncePrefix: header.noncePrefix,
  };
  const enc = createEnvelopeEncryptTransform(dek, encHeader, headerBytes as Uint8Array);

  const hash = createHash('sha256');
  let bytesWritten = 0;

  const tmpPath = `${finalPath}.tmp`;
  let handle: FileHandleLike | null = null;
  let pumpPromise: Promise<void> | null = null;
  let encWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let started = false;

  async function start(): Promise<void> {
    if (started) return;
    started = true;
    handle = await fsmod.open(tmpPath, 'w');
    // Header bytes go on disk first (the reader parses them; they are also the AAD source).
    await (handle as unknown as { write(b: Buffer): Promise<unknown> }).write(
      Buffer.from(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength)
    );
    const reader = enc.readable.getReader();
    // Sequential awaited writes: encrypted frames arrive in order, so plain handle.write
    // gives natural backpressure without any stream plumbing.
    pumpPromise = (async () => {
      const writableHandle = handle as unknown as { write(b: Buffer): Promise<unknown> };
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          const value = next.value as Uint8Array;
          await writableHandle.write(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        }
      } catch (error) {
        reader.releaseLock();
        throw error;
      }
    })();
    encWriter = enc.writable.getWriter();
  }

  const exposed: WritableStream<Uint8Array> = new WritableStream<Uint8Array>(
    {
      async write(chunk) {
        await start();
        // Hash sees the plaintext BEFORE encryption.
        hash.update(chunk);
        bytesWritten += chunk.byteLength;
        await encWriter!.write(chunk);
      },
      async close() {
        await start();
        await encWriter!.close();
        await pumpPromise;
        if (!handle) return;
        await handle.sync();
        await handle.close();
        handle = null;
        await fsmod.rename(tmpPath, finalPath);
      },
      async abort(reason) {
        try {
          if (started && encWriter) await encWriter.abort(reason);
        } catch {
          /* already errored */
        }
        if (handle) {
          await handle.close().catch(() => {});
          handle = null;
        }
        await fsmod.unlink(tmpPath);
      },
    },
    { highWaterMark: 1 }
  );

  return {
    writable: exposed,
    finish: async () => ({ sha256: hash.digest('hex'), bytes: bytesWritten }),
    abort: async () => {
      await exposed.abort(new Error('blob write aborted')).catch(() => {});
    },
  };
}

interface FrameResult {
  bytes: Uint8Array<ArrayBuffer>;
  plainStart: number;
}

/** Parse just the blob header from an open file. Returns the raw header bytes (AAD source). */
async function readBlobHeader(handle: FileHandleLike): Promise<{ header: BlobHeader; headerBytes: Uint8Array<ArrayBuffer>; dataStart: number }> {
  const prefix = Buffer.alloc(BLOB_MAGIC.length + 4);
  await readFull(handle, prefix, 0, prefix.length, 0);
  if (prefix.subarray(0, BLOB_MAGIC.length).toString('latin1') !== BLOB_MAGIC) {
    throw new Error('Vault blob header is invalid.');
  }
  const jsonLen = prefix.readUInt32LE(BLOB_MAGIC.length);
  if (jsonLen <= 0 || jsonLen > 64 * 1024) throw new Error('Vault blob header is invalid.');
  const total = BLOB_MAGIC.length + 4 + jsonLen;
  const full = Buffer.alloc(total);
  await readFull(handle, full, 0, total, 0);
  const headerBytes = new Uint8Array(full);
  return { header: blobHeaderFor(headerBytes), headerBytes, dataStart: total };
}

async function readFull(handle: FileHandleLike, buffer: Buffer, offset: number, length: number, position: number): Promise<void> {
  let read = 0;
  while (read < length) {
    const result = await handle.read(buffer, offset + read, length - read, position + read);
    if (result.bytesRead <= 0) throw new Error('Vault blob is truncated.');
    read += result.bytesRead;
  }
}

/** Like decryptFrames but also reports each frame's plaintext start offset (needed for Range). */
async function* decryptFramesWithOffsets(
  fsmod: BlobFs,
  filePath: string,
  dek: CryptoKey
): AsyncGenerator<FrameResult> {
  const handle = await fsmod.open(filePath, 'r');
  try {
    const { header, headerBytes, dataStart } = await readBlobHeader(handle);
    const size = (await handle.stat()).size;
    const prefix = Buffer.from(atob(header.noncePrefix), 'latin1');
    let frameOffset = dataStart;
    let chunkIndex = 0;
    let plainStart = 0;
    while (frameOffset < size) {
      const lenBuf = Buffer.alloc(4);
      await readFull(handle, lenBuf, 0, 4, frameOffset);
      const ctLen = lenBuf.readUInt32LE(0);
      if (ctLen < 16 || ctLen > header.chunkSize + 16) throw new Error('Vault blob contains an invalid encrypted chunk.');
      const ct = Buffer.alloc(ctLen);
      await readFull(handle, ct, 0, ctLen, frameOffset + 4);
      const plainLen = ctLen - 16;
      const iv = concatBytes(prefix, uint32Bytes(chunkIndex));
      const aad = concatBytes(headerBytes, uint32Bytes(chunkIndex), uint32Bytes(plainLen));
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer, additionalData: aad.buffer as ArrayBuffer },
        dek,
        ct
      );
      yield { bytes: new Uint8Array(plain), plainStart };
      plainStart += plainLen;
      frameOffset += 4 + ctLen;
      chunkIndex += 1;
    }
  } finally {
    await handle.close();
  }
}

/** Decrypt plaintext bytes [start, end) of a vblob as a web ReadableStream. */
export function readBlobRange(
  fsmod: BlobFs,
  filePath: string,
  dek: CryptoKey,
  start: number,
  end: number // exclusive; Number.POSITIVE_INFINITY = to end
): ReadableStream<Uint8Array<ArrayBuffer>> {
  let iterator: AsyncGenerator<FrameResult> | null = null;
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      try {
        if (!iterator) iterator = decryptFramesWithOffsets(fsmod, filePath, dek);
        while (true) {
          const next = await iterator.next();
          if (next.done) {
            controller.close();
            return;
          }
          const { bytes, plainStart } = next.value;
          const frameEnd = plainStart + bytes.byteLength;
          if (frameEnd <= start) continue; // entirely before the window
          const from = Math.max(0, start - plainStart);
          const to = Math.min(bytes.byteLength, Math.max(0, end - plainStart));
          if (to <= from) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.slice(from, to));
          if (frameEnd >= end) {
            await iterator.return?.(undefined as never);
            controller.close();
            return;
          }
          return; // backpressure: wait for next pull
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator?.return?.(undefined as never);
    },
  });
}

/** Whole-blob plaintext (bounded by caller to sensible sizes). */
export function readBlobAll(fsmod: BlobFs, filePath: string, dek: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const parts: Uint8Array[] = [];
    let total = 0;
    const stream = readBlobRange(fsmod, filePath, dek, 0, Number.POSITIVE_INFINITY);
    const reader = stream.getReader();
    const pump = async () => {
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          parts.push(next.value);
          total += next.value.byteLength;
        }
        const out = new Uint8Array(new ArrayBuffer(total));
        let offset = 0;
        for (const part of parts) {
          out.set(part, offset);
          offset += part.byteLength;
        }
        resolve(out);
      } catch (error) {
        reject(error);
      }
    };
    void pump();
  });
}
