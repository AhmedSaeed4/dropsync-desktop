/**
 * vault.vmeta — the sealed vault index.
 *
 * File layout (all integers little-endian):
 *   [magic 'DRPVAULT' 8B][u32le hdrLen][header JSON]   ← password KDF params (vaultCrypto)
 *   [verifier block: iv(12) + u32le ctLen + ct]        ← known-plaintext seal + wrapped DEK
 *   [u32le snapRegionLen][snap region]                 ← sealed index snapshot
 *   [journal record]*                                  ← append-only encrypted mutations
 *
 * snap region = [u32le snapHdrLen][snapHdr JSON {noncePrefix, chunkSize}][envelope frames…]
 *   — sealed under the DEK with a FRESH noncePrefix on every compaction (never reused).
 * journal record = [u32le recLen][sealSmall bytes] — each record independently authenticated
 *   with its own random IV; AAD binds it to the header bytes + the ASCII tag 'journal'.
 *
 * The snapshot is rewritten atomically (temp → fsync → rename), debounced; the journal covers
 * mutations between compactions. A torn tail (kill -9 mid-append) is truncated to the last good
 * record on load. Compaction triggers when journal bytes exceed 25% of the snapshot.
 */

import type { BlobFs } from './blobStore.ts';
import {
  createEnvelopeDecryptTransform,
  createEnvelopeEncryptTransform,
  type EnvelopeHeaderShape,
} from './envelope.ts';
import { openSmall, sealSmall } from './vaultCrypto.ts';
import {
  applyJournalOp,
  emptyIndex,
  type JournalOp,
  type VaultIndex,
} from './vaultTypes.ts';

const JOURNAL_AAD_TAG = new TextEncoder().encode('journal');

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

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
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

/** Seal the index JSON as a full snapshot region (fresh noncePrefix every call). */
export async function sealIndexRegion(dek: CryptoKey, index: VaultIndex): Promise<Uint8Array<ArrayBuffer>> {
  const noncePrefixBytes = crypto.getRandomValues(new Uint8Array(8));
  const snapHeader = {
    magic: 'DRPVIDX1',
    version: 1,
    cipher: 'AES-256-GCM-CHUNKED',
    chunkSize: 4 * 1024 * 1024,
    kdf: { name: 'PBKDF2-SHA256', version: 1, iterations: 600_000, salt: '' },
    noncePrefix: btoa(String.fromCharCode(...noncePrefixBytes)),
  };
  const snapHeaderBytes = new TextEncoder().encode(JSON.stringify(snapHeader));
  const shape: EnvelopeHeaderShape = snapHeader;
  const enc = createEnvelopeEncryptTransform(dek, shape, snapHeaderBytes);
  const plain = new TextEncoder().encode(JSON.stringify(index));
  const framesPromise = streamToBytes(enc.readable);
  const writer = enc.writable.getWriter();
  // Push in ≤1 MiB slices so huge indexes don't enqueue one giant chunk.
  for (let offset = 0; offset < plain.length; offset += 1024 * 1024) {
    await writer.write(plain.slice(offset, Math.min(offset + 1024 * 1024, plain.length)));
  }
  await writer.close();
  const frames = await framesPromise;
  return concatBytes(uint32Bytes(snapHeaderBytes.byteLength), snapHeaderBytes, frames);
}

/** Open a snapshot region produced by sealIndexRegion. Returns null on any auth/parse failure. */
export async function openIndexRegion(dek: CryptoKey, region: Uint8Array): Promise<VaultIndex | null> {
  try {
    if (region.length < 4) return null;
    const snapHdrLen = readUint32Le(region, 0);
    if (snapHdrLen <= 0 || snapHdrLen > 64 * 1024 || region.length < 4 + snapHdrLen) return null;
    const snapHeaderBytes = region.slice(4, 4 + snapHdrLen);
    const snapHeader = JSON.parse(new TextDecoder().decode(snapHeaderBytes)) as EnvelopeHeaderShape;
    if (!snapHeader || snapHeader.cipher !== 'AES-256-GCM-CHUNKED') return null;
    const dec = createEnvelopeDecryptTransform(dek, snapHeader, snapHeaderBytes);
    const plainPromise = streamToBytes(dec.readable);
    const writer = dec.writable.getWriter();
    await writer.write(region.slice(4 + snapHdrLen));
    await writer.close();
    const plain = await plainPromise;
    const index = JSON.parse(new TextDecoder().decode(plain)) as VaultIndex;
    if (!index || index.version !== 1 || !Array.isArray(index.drops)) return null;
    return index;
  } catch {
    return null;
  }
}

/** Full journal record bytes ([u32le recLen][payload]) for one mutation. */
export async function sealJournalRecord(
  dek: CryptoKey,
  headerBytes: Uint8Array,
  journalOp: JournalOp
): Promise<Uint8Array<ArrayBuffer>> {
  const aad = concatBytes(headerBytes, JOURNAL_AAD_TAG);
  const payload = await sealSmall(dek, aad, new TextEncoder().encode(JSON.stringify(journalOp)));
  const record = concatBytes(uint32Bytes(payload.byteLength), payload);
  return record;
}

export interface JournalReadResult {
  ops: JournalOp[];
  /** File offset just past the last intact record — the truncate target for a torn tail. */
  lastGoodOffset: number;
  tornTail: boolean;
}

/** Walk journal bytes sequentially; a bad length or failed auth stops the walk (torn tail). */
export async function openJournalRecords(
  dek: CryptoKey,
  headerBytes: Uint8Array,
  journalBytes: Uint8Array,
  journalStartOffset: number
): Promise<JournalReadResult> {
  const ops: JournalOp[] = [];
  let offset = 0;
  const aad = concatBytes(headerBytes, JOURNAL_AAD_TAG);
  while (offset + 4 <= journalBytes.length) {
    const recLen = readUint32Le(journalBytes, offset);
    if (recLen < 12 + 4 + 16 || offset + 4 + recLen > journalBytes.length) break;
    const payload = journalBytes.slice(offset + 4, offset + 4 + recLen);
    const journalOp = await openSmall<JournalOp>(dek, aad, payload);
    if (!journalOp || typeof journalOp.op !== 'string') break;
    ops.push(journalOp);
    offset += 4 + recLen;
  }
  void journalStartOffset;
  return {
    ops,
    lastGoodOffset: offset,
    tornTail: offset !== journalBytes.length,
  };
}

/** Atomically write the whole vault file (header + verifier + snapshot, no journal). */
export async function writeWholeVaultFile(
  fsmod: BlobFs,
  path: string,
  headerBytes: Uint8Array,
  verifier: Uint8Array,
  snapshotRegion: Uint8Array
): Promise<void> {
  const body = concatBytes(
    headerBytes,
    verifier,
    uint32Bytes(snapshotRegion.byteLength),
    snapshotRegion
  );
  const tmp = `${path}.tmp`;
  const handle = await fsmod.open(tmp, 'w');
  try {
    const writeHandle = handle as unknown as { write(b: Buffer): Promise<unknown> };
    const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    await writeHandle.write(buf);
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    await fsmod.unlink(tmp);
    throw error;
  }
  await fsmod.rename(tmp, path);
}

/** Append one sealed record to the journal region at the end of the file. */
export async function appendJournalRecordToFile(
  fsmod: BlobFs,
  path: string,
  record: Uint8Array
): Promise<void> {
  const handle = await fsmod.open(path, 'a');
  try {
    const nodeStream = handle.createWriteStream() as NodeJS.WriteStream;
    const buf = Buffer.from(record.buffer, record.byteOffset, record.byteLength);
    await (handle as unknown as { write(b: Buffer): Promise<unknown> }).write(buf);
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

export async function truncateFileTo(fsmod: BlobFs, path: string, offset: number): Promise<void> {
  const handle = await fsmod.open(path, 'r+');
  try {
    await (handle as unknown as { truncate(len: number): Promise<void> }).truncate(offset);
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/** Rewrite header + verifier + fresh snapshot (journal compacted away), atomically. */
export async function compactVaultFile(
  fsmod: BlobFs,
  path: string,
  headerBytes: Uint8Array,
  verifier: Uint8Array,
  dek: CryptoKey,
  index: VaultIndex
): Promise<number> {
  const snapshotRegion = await sealIndexRegion(dek, index);
  await writeWholeVaultFile(fsmod, path, headerBytes, verifier, snapshotRegion);
  return snapshotRegion.byteLength;
}

/** Fresh index used when creating a brand-new vault. */
export function newIndex(): VaultIndex {
  return emptyIndex();
}
