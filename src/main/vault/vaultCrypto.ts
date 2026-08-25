/**
 * Vault key hierarchy (main process only — never crosses IPC).
 *
 *   password --PBKDF2-SHA256(600k)--> KEK (non-extractable AES-GCM key)
 *   random DEK (32 B) --sealed by KEK--> verifier block in vault.vmeta
 *   DEK encrypts everything: snapshot, journal records, every .vblob
 *
 * The sealed block is simultaneously the password VERIFIER (wrong password ⇒ GCM auth failure ⇒
 * clean unlock error) and the wrapped data key, so changePassword re-wraps one 32-byte value
 * instead of re-encrypting the whole vault.
 */

const VAULT_MAGIC = 'DRPVAULT';
export const VAULT_KDF_ITERATIONS = 600_000;
export const VAULT_CHUNK_SIZE = 4 * 1024 * 1024;
const VERIFIER_PLAINTEXT = 'dropsync-vault-verifier-v1';

export interface VaultHeader {
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

export function readUint32Le(bytes: Uint8Array, offset = 0): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    for (let i = 0; i < chunk.length; i++) binary += String.fromCharCode(chunk[i]);
  }
  return btoa(binary);
}

function base64Decode(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toArray(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy.buffer;
}

/** Fresh per-write header. noncePrefix is NEVER reused under the same DEK across artifacts:
 * each snapshot rewrite, each journal record and each blob carries its own prefix/IV. */
export function makeVaultHeader(): VaultHeader {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const noncePrefix = crypto.getRandomValues(new Uint8Array(8));
  return {
    magic: VAULT_MAGIC,
    version: 1,
    cipher: 'AES-256-GCM-CHUNKED',
    chunkSize: VAULT_CHUNK_SIZE,
    kdf: {
      name: 'PBKDF2-SHA256',
      version: 1,
      iterations: VAULT_KDF_ITERATIONS,
      salt: base64Encode(salt),
    },
    noncePrefix: base64Encode(noncePrefix),
  };
}

export function encodeVaultHeader(header: VaultHeader): Uint8Array<ArrayBuffer> {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(header));
  return concatBytes(
    new TextEncoder().encode(VAULT_MAGIC),
    uint32Bytes(jsonBytes.byteLength),
    jsonBytes
  );
}

export function decodeVaultHeaderPrefix(
  file: Uint8Array
): { header: VaultHeader; headerBytesLength: number } | null {
  const magicBytes = new TextEncoder().encode(VAULT_MAGIC);
  if (file.length < magicBytes.length + 4) return null;
  if (new TextDecoder().decode(file.slice(0, magicBytes.length)) !== VAULT_MAGIC) return null;
  const jsonLen = readUint32Le(file, magicBytes.length);
  const total = magicBytes.length + 4 + jsonLen;
  if (jsonLen <= 0 || jsonLen > 64 * 1024 || file.length < total) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(file.slice(magicBytes.length + 4, total))) as VaultHeader;
    if (
      header.magic !== VAULT_MAGIC
      || header.version !== 1
      || header.cipher !== 'AES-256-GCM-CHUNKED'
      || header.kdf?.name !== 'PBKDF2-SHA256'
      || header.kdf?.version !== 1
      || base64Decode(header.kdf.salt).length !== 16
      || base64Decode(header.noncePrefix).length !== 8
    ) {
      return null;
    }
    return { header, headerBytesLength: total };
  } catch {
    return null;
  }
}

async function deriveKEK(password: string, header: VaultHeader): Promise<CryptoKey> {
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
      salt: toArray(base64Decode(header.kdf.salt)),
      iterations: header.kdf.iterations,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Verifier block layout: [iv 12 B][u32le ctLen][GCM ct]. Seals a known plaintext AND the raw DEK
 * under the KEK. AAD binds it to the exact header bytes so nothing can be transplanted. */
export async function sealVerifierBlock(
  dekRaw: Uint8Array,
  kek: CryptoKey,
  headerBytes: Uint8Array
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = concatBytes(new TextEncoder().encode(VERIFIER_PLAINTEXT), dekRaw);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArray(iv), additionalData: toArray(headerBytes) }, kek, toArray(plain));
  return concatBytes(iv, uint32Bytes(ct.byteLength), new Uint8Array(ct));
}

export async function openVerifierBlock(
  block: Uint8Array,
  kek: CryptoKey,
  headerBytes: Uint8Array
): Promise<{ ok: true; dekRaw: Uint8Array<ArrayBuffer> } | { ok: false }> {
  try {
    if (block.length < 12 + 4 + 16) return { ok: false };
    const iv = block.slice(0, 12);
    const ctLen = readUint32Le(block, 12);
    if (ctLen < 16 + VERIFIER_PLAINTEXT.length || block.length < 16 + ctLen) return { ok: false };
    const ct = block.slice(16, 16 + ctLen);
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toArray(iv), additionalData: toArray(headerBytes) }, kek, toArray(ct));
    const plain = new Uint8Array(plainBuf);
    const marker = new TextEncoder().encode(VERIFIER_PLAINTEXT);
    for (let i = 0; i < marker.length; i++) {
      if (plain[i] !== marker[i]) return { ok: false };
    }
    const dekRaw = plain.slice(marker.length, marker.length + 32) as Uint8Array<ArrayBuffer>;
    if (dekRaw.length !== 32) return { ok: false };
    return { ok: true, dekRaw };
  } catch {
    // Wrong password / damaged verifier — indistinguishable by design.
    return { ok: false };
  }
}

export interface UnlockedKeys {
  kek: CryptoKey;
  dek: CryptoKey;
  dekRaw: Uint8Array<ArrayBuffer>;
}

async function importDek(dekRaw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', toArray(dekRaw), { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** GCM-encrypt a small buffer under the DEK with a fresh random IV. Layout: [iv 12][u32 ctLen][ct]. */
export async function sealSmall(key: CryptoKey, aad: Uint8Array, plain: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArray(iv), additionalData: toArray(aad) }, key, toArray(plain));
  return concatBytes(iv, uint32Bytes(ct.byteLength), new Uint8Array(ct));
}

/** Open a sealSmall block. Returns null on auth failure. */
export async function openSmall<T>(key: CryptoKey, aad: Uint8Array, block: Uint8Array): Promise<T | null> {
  try {
    if (block.length < 12 + 4 + 16) return null;
    const iv = block.slice(0, 12);
    const ctLen = readUint32Le(block, 12);
    if (block.length < 16 + ctLen) return null;
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toArray(iv), additionalData: toArray(aad) }, key, toArray(block.slice(16, 16 + ctLen)));
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    return null;
  }
}


export async function createVaultKeys(password: string): Promise<{ header: VaultHeader; headerBytes: Uint8Array<ArrayBuffer>; verifier: Uint8Array<ArrayBuffer>; keys: UnlockedKeys }> {
  const header = makeVaultHeader();
  const headerBytes = encodeVaultHeader(header);
  const kek = await deriveKEK(password, header);
  const dekRaw = crypto.getRandomValues(new Uint8Array(32));
  const verifier = await sealVerifierBlock(dekRaw, kek, headerBytes as Uint8Array);
  const dek = await importDek(dekRaw);
  return { header, headerBytes, verifier, keys: { kek, dek, dekRaw } };
}

/** Unlock an existing vault header + verifier block with a password. Returns null when the
 * password is wrong (GCM auth failure) or the verifier is damaged — callers surface ONE generic
 * message either way, never leaking which. */
export async function unlockVaultKeys(
  password: string,
  header: VaultHeader,
  headerBytes: Uint8Array,
  verifierBlock: Uint8Array
): Promise<UnlockedKeys | null> {
  const kek = await deriveKEK(password, header);
  const opened = await openVerifierBlock(verifierBlock, kek, headerBytes as Uint8Array);
  if (!opened.ok) return null;
  const dek = await importDek(opened.dekRaw);
  return { kek, dek, dekRaw: opened.dekRaw };
}

/** Re-seal the SAME data key under a NEW password (fresh salt + noncePrefix). Nothing else in
 * the vault is encrypted under the KEK, so this is the whole password change. */
export async function rewrapVaultKeys(
  newPassword: string,
  dekRaw: Uint8Array<ArrayBuffer>
): Promise<{ header: VaultHeader; headerBytes: Uint8Array<ArrayBuffer>; verifier: Uint8Array<ArrayBuffer>; keys: UnlockedKeys }> {
  const header = makeVaultHeader();
  const headerBytes = encodeVaultHeader(header);
  const kek = await deriveKEK(newPassword, header);
  const verifier = await sealVerifierBlock(dekRaw, kek, headerBytes as Uint8Array);
  const dek = await importDek(dekRaw);
  return { header, headerBytes, verifier, keys: { kek, dek, dekRaw } };
}
