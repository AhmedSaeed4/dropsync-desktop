/**
 * DropSync envelope primitives — Node port of drag-drop-app/src/lib/archiveFormat.ts.
 *
 * BYTE-COMPATIBILITY CONTRACT (do not drift):
 *   - Magic "DROPSYNC" (8 ASCII bytes), then u32 LE header length, then header JSON.
 *   - Key: PBKDF2-SHA256 (600k–2M iterations accepted on read), salt 16 B, SHA-256.
 *   - Chunk cipher: AES-256-GCM. IV (12 B) = noncePrefix (8 B) ‖ u32le(chunkIndex).
 *     AAD = headerBytes ‖ u32le(chunkIndex) ‖ u32le(plainLength).
 *   - Wire frames: [u32le cipherLength][ciphertext]; cipherLength ∈ [16, chunkSize + 16].
 *   - Reader slices the ORIGINAL header bytes for AAD (never re-serializes).
 *
 * All error strings below MUST stay identical to the web app's — they are user-facing contract.
 * This module is deliberately erasure-only TypeScript (no enums/namespaces/decorators) and imports
 * nothing, so `node scripts/*.ts` can run it natively via Node's built-in type stripping.
 */

export const ARCHIVE_ENVELOPE_VERSION = 1;
export const ARCHIVE_EXTENSION = '.dropsync';
export const ARCHIVE_MIME = 'application/vnd.dropsync';
export const ARCHIVE_MAX_MANIFEST_BYTES = 10 * 1024 * 1024;
export const ARCHIVE_MAX_ENTRIES = 100_000;
export const ARCHIVE_MAX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024 * 1024;
export const ARCHIVE_CHUNK_SIZE = 4 * 1024 * 1024;
export const ARCHIVE_KDF_ITERATIONS = 600_000;
export const ARCHIVE_MAX_DROP_FILE_BYTES = 500 * 1024 * 1024;

const MAGIC = 'DROPSYNC';
const MAGIC_BYTES = new TextEncoder().encode(MAGIC);
const ENVELOPE_PREFIX_BYTES = MAGIC_BYTES.length + 4;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_PASSWORD_LENGTH = 512;

export type ArchiveProgressPhase = 'preflight' | 'export' | 'inspect' | 'import';

export interface ArchiveProgress {
  phase: ArchiveProgressPhase;
  processedBytes: number;
  totalBytes: number;
  currentName?: string;
  message?: string;
}

/** The subset of header fields the chunk transforms actually use. Lets the vault reuse the exact
 * same math for its own artifacts (snapshot / journal / blobs) with different header magics. */
export interface EnvelopeHeaderShape {
  magic: string;
  version: number;
  cipher: string;
  chunkSize: number;
  kdf: { name: string; version: number; iterations: number; salt: string };
  noncePrefix: string;
}

interface EnvelopeHeader extends EnvelopeHeaderShape {
  magic: string;
  version: number;
  cipher: 'AES-256-GCM-CHUNKED';
  chunkSize: number;
  kdf: {
    name: 'PBKDF2-SHA256';
    version: 1;
    iterations: number;
    salt: string;
  };
  noncePrefix: string;
}

export interface ParsedEnvelopeHeader {
  header: EnvelopeHeader;
  headerBytes: Uint8Array;
  payloadOffset: number;
}

/** Disk-backed view of an archive file — the Node stand-in for the browser's `File`. */
export interface ArchiveSource {
  readonly size: number;
  /** Bytes [start, end) of the file as a web ReadableStream (never loads the whole file). */
  sliceStream(start: number, end?: number): ReadableStream<Uint8Array>;
}

export class ArchiveCancelledError extends Error {
  constructor() {
    super('Archive operation cancelled.');
    this.name = 'ArchiveCancelledError';
  }
}

export class ArchiveValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveValidationError';
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ArchiveCancelledError();
}

export function assertPassword(password: string): void {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Use an archive password with at least 8 characters.');
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Error('The archive password is too long.');
  }
}

function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function uint32Bytes(value: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(4));
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

function readUint32(bytes: Uint8Array, offset = 0): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    for (let i = 0; i < chunk.length; i++) binary += String.fromCharCode(chunk[i]);
  }
  // btoa is global in Node >= 16 as well as every browser.
  return btoa(binary);
}

function base64Decode(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return copyBytes(bytes).buffer;
}

export function dataUriToBytes(dataUri: string): Uint8Array<ArrayBuffer> {
  const comma = dataUri.indexOf(',');
  if (comma < 0 || !/^data:[^;]+;base64,/i.test(dataUri.slice(0, comma + 1))) {
    throw new Error('The stored file is not a valid base64 data URI.');
  }
  return base64Decode(dataUri.slice(comma + 1));
}

export function bytesToDataUri(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType || 'application/octet-stream'};base64,${base64Encode(bytes)}`;
}

export function isoDate(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

export function parseDate(value: string | null | undefined, field: string): Date | null {
  if (value == null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ${field} in the archive.`);
  return date;
}

export function isExpired(
  drop: { expiresAt?: Date | string | null },
  now = new Date()
): boolean {
  const expiresAt = drop.expiresAt instanceof Date
    ? drop.expiresAt
    : typeof drop.expiresAt === 'string'
      ? parseDate(drop.expiresAt, 'expiresAt')
      : null;
  return !!expiresAt && expiresAt.getTime() <= now.getTime();
}

export function isSafeZipPath(path: string): boolean {
  return path === 'manifest.json'
    || (
      path.startsWith('files/')
      && !path.startsWith('files//')
      && !path.includes('..')
      && !path.includes('\\')
      && !path.includes('\0')
      && !path.endsWith('/')
    );
}

export interface EntryLike {
  filename: string;
  directory: boolean;
  uncompressedSize: number;
}

export function getFileEntryError(path: string, found: boolean): string | null {
  if (!isSafeZipPath(path) || path === 'manifest.json') {
    return 'The archive contains an invalid payload path.';
  }
  if (!found) return `The archive payload is missing: ${path}`;
  return null;
}

export function emitProgress(
  onProgress: ((progress: ArchiveProgress) => void) | undefined,
  progress: ArchiveProgress
): void {
  onProgress?.(progress);
}

export async function deriveArchiveKey(password: string, header: EnvelopeHeader): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: bytesToArrayBuffer(base64Decode(header.kdf.salt)),
      iterations: header.kdf.iterations,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function nonceForChunk(header: EnvelopeHeaderShape, index: number): Uint8Array<ArrayBuffer> {
  const prefix = base64Decode(header.noncePrefix);
  if (prefix.length !== 8 || index > 0xffffffff) throw new Error('Archive chunk index overflow.');
  return concatBytes(prefix, uint32Bytes(index));
}

function chunkAad(headerBytes: Uint8Array, index: number, plainLength: number): Uint8Array<ArrayBuffer> {
  return concatBytes(headerBytes, uint32Bytes(index), uint32Bytes(plainLength));
}

export function createEnvelopeEncryptTransform(
  key: CryptoKey,
  header: EnvelopeHeaderShape,
  headerBytes: Uint8Array,
  signal?: AbortSignal
): TransformStream<Uint8Array, Uint8Array> {
  let pending = new Uint8Array(0);
  let chunkIndex = 0;

  const encryptChunk = async (plain: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) => {
    throwIfAborted(signal);
    const cipher = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: bytesToArrayBuffer(nonceForChunk(header, chunkIndex)),
        additionalData: bytesToArrayBuffer(chunkAad(headerBytes, chunkIndex, plain.byteLength)),
      },
      key,
      bytesToArrayBuffer(plain)
    );
    controller.enqueue(concatBytes(uint32Bytes(cipher.byteLength), new Uint8Array(cipher)));
    chunkIndex += 1;
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      throwIfAborted(signal);
      pending = concatBytes(pending, copyBytes(chunk));
      while (pending.byteLength >= header.chunkSize) {
        const part = pending.slice(0, header.chunkSize);
        pending = pending.slice(header.chunkSize);
        await encryptChunk(part, controller);
      }
    },
    async flush(controller) {
      if (pending.byteLength > 0) await encryptChunk(pending, controller);
    },
  });
}

export function createEnvelopeDecryptTransform(
  key: CryptoKey,
  header: EnvelopeHeaderShape,
  headerBytes: Uint8Array,
  signal?: AbortSignal
): TransformStream<Uint8Array, Uint8Array> {
  let pending = new Uint8Array(0);
  let chunkIndex = 0;

  return new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      throwIfAborted(signal);
      pending = concatBytes(pending, copyBytes(chunk));
      while (pending.byteLength >= 4) {
        const cipherLength = readUint32(pending);
        if (cipherLength < 16 || cipherLength > header.chunkSize + 16) {
          throw new Error('The archive contains an invalid encrypted chunk.');
        }
        if (pending.byteLength < cipherLength + 4) return;
        const cipher = pending.slice(4, 4 + cipherLength);
        pending = pending.slice(4 + cipherLength);
        const plainLength = cipherLength - 16;
        const plain = await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: bytesToArrayBuffer(nonceForChunk(header, chunkIndex)),
            additionalData: bytesToArrayBuffer(chunkAad(headerBytes, chunkIndex, plainLength)),
          },
          key,
          bytesToArrayBuffer(cipher)
        );
        controller.enqueue(copyBytes(new Uint8Array(plain)));
        chunkIndex += 1;
      }
    },
    flush() {
      if (pending.byteLength !== 0) throw new Error('The archive ended with a truncated encrypted chunk.');
    },
  });
}

export function prependStream(prefix: Uint8Array, source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(prefix);
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          controller.enqueue(copyBytes(next.value));
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export function makeHeader(): { header: EnvelopeHeader; headerBytes: Uint8Array } {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const noncePrefix = crypto.getRandomValues(new Uint8Array(8));
  const header: EnvelopeHeader = {
    magic: MAGIC,
    version: ARCHIVE_ENVELOPE_VERSION,
    cipher: 'AES-256-GCM-CHUNKED',
    chunkSize: ARCHIVE_CHUNK_SIZE,
    kdf: {
      name: 'PBKDF2-SHA256',
      version: 1,
      iterations: ARCHIVE_KDF_ITERATIONS,
      salt: base64Encode(salt),
    },
    noncePrefix: base64Encode(noncePrefix),
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(header));
  const headerBytes = concatBytes(MAGIC_BYTES, uint32Bytes(jsonBytes.byteLength), jsonBytes);
  return { header, headerBytes };
}

export async function readEnvelopeHeaderFromSource(source: ArchiveSource): Promise<ParsedEnvelopeHeader> {
  if (source.size < ENVELOPE_PREFIX_BYTES) throw new Error('This is not a valid .dropsync file.');
  const prefix = await readExactly(source, 0, ENVELOPE_PREFIX_BYTES);
  const magic = new TextDecoder().decode(prefix.slice(0, MAGIC_BYTES.length));
  if (magic !== MAGIC) throw new Error('This is not a valid .dropsync file.');
  const headerLength = readUint32(prefix, MAGIC_BYTES.length);
  if (headerLength <= 0 || headerLength > MAX_HEADER_BYTES || source.size < ENVELOPE_PREFIX_BYTES + headerLength) {
    throw new Error('The archive header is invalid.');
  }
  const headerBytes = await readExactly(source, 0, ENVELOPE_PREFIX_BYTES + headerLength);
  let header: EnvelopeHeader;
  try {
    header = JSON.parse(new TextDecoder().decode(headerBytes.slice(ENVELOPE_PREFIX_BYTES))) as EnvelopeHeader;
  } catch {
    throw new Error('The archive header is not valid JSON.');
  }
  if (
    header.magic !== MAGIC
    || header.version !== ARCHIVE_ENVELOPE_VERSION
    || header.cipher !== 'AES-256-GCM-CHUNKED'
    || header.kdf?.name !== 'PBKDF2-SHA256'
    || header.kdf?.version !== 1
    || header.kdf.iterations < 600_000
    || header.kdf.iterations > 2_000_000
    || header.chunkSize < 64 * 1024
    || header.chunkSize > 16 * 1024 * 1024
    || base64Decode(header.kdf.salt).length !== 16
    || base64Decode(header.noncePrefix).length !== 8
  ) {
    throw new Error('The archive header parameters are invalid.');
  }
  return {
    header,
    headerBytes,
    payloadOffset: ENVELOPE_PREFIX_BYTES + headerLength,
  };
}

async function readExactly(source: ArchiveSource, start: number, end: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = source.sliceStream(start, end).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
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
  return out;
}

export function countedStream(
  source: ReadableStream<Uint8Array>,
  onChunk: (count: number) => void
): { stream: ReadableStream<Uint8Array>; getCount: () => number } {
  let count = 0;
  const stream = source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      count += chunk.byteLength;
      onChunk(count);
      controller.enqueue(chunk);
    },
  }));
  return { stream, getCount: () => count };
}

export function remapDropReferences(
  content: string,
  idMap: Map<string, string>,
  missingIds: Set<string>
): string {
  return content.replace(/#\[([^\]]+)\]\(([^)]+)\)/g, (full, name: string, sourceId: string) => {
    const targetId = idMap.get(sourceId);
    if (!targetId) missingIds.add(sourceId);
    return targetId ? `#[${name}](${targetId})` : full;
  });
}
