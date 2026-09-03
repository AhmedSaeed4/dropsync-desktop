/**
 * VaultManager — the single owner of vault state in the main process.
 *
 * Lifecycle: none → (create|unlock) → unlocked ⇄ locked. The DEK and every decrypted byte stay
 * here; the renderer only ever receives DTOs (dates as ISO strings), text payloads it explicitly
 * asks for, and opaque media:// tokens. Big bytes stream disk↔main only.
 */

import * as nodeFs from 'node:fs';
import fsp from 'node:fs/promises';
import * as pathMod from 'node:path';

import { makeNodeBlobFs, createBlobWriter, readBlobAll, readBlobRange, type OpenBlobWriter, type BlobFs, type FileHandleLike } from './blobStore.ts';
import {
  appendJournalRecordToFile,
  compactVaultFile,
  newIndex,
  openIndexRegion,
  openJournalRecords,
  sealJournalRecord,
  sealIndexRegion,
  truncateFileTo,
  writeWholeVaultFile,
} from './indexStore.ts';
import {
  decodeVaultHeaderPrefix,
  createVaultKeys,
  rewrapVaultKeys,
  unlockVaultKeys,
  type UnlockedKeys,
  type VaultHeader,
} from './vaultCrypto.ts';
import {
  INLINE_TEXT_LIMIT,
  defaultSettings,
  applyJournalOp,
  type JournalOp,
  type VaultBlobRef,
  type VaultCategory,
  type VaultDropRecord,
  type VaultIndex,
  type VaultSettings,
  type VaultSpace,
} from './vaultTypes.ts';
import { sweepOrphanBlobs } from './dropOps.ts';

const VAULT_DIR_NAME = 'DropSync.vault';
const VAULT_FILE_NAME = 'vault.vmeta';
const BLOBS_DIR_NAME = 'blobs';
export const IMPORT_JOURNAL_FILE_NAME = 'import-journal.json';

/** The one generic wrong-password message shown on the unlock screen. Wrong password and a
 * damaged verifier are deliberately indistinguishable. */
export const WRONG_VAULT_PASSWORD_MESSAGE = 'The vault password is wrong, or the vault is damaged.';

export function assertVaultPassword(password: string): void {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Use a vault password with at least 8 characters.');
  }
  if (password.length > 512) {
    throw new Error('The vault password is too long.');
  }
}

export interface DropDTO {
  id: string;
  spaceId: string;
  workspaceId: string | null; // mirror of the web Drop field: null for personal
  type: 'text' | 'file';
  name: string;
  categories: string[];
  pinned: boolean;
  locked: boolean;
  isDrawing: boolean;
  createdAt: string;
  expiresAt: string | null;
  expirationOption?: VaultDropRecord['expirationOption'];
  reminderAt: string | null;
  reminderSetByUid?: string | null;
  reminderDismissedBy?: string | null;
  reminderFiredAt?: string | null;
  fileSize?: number;
  mimeType?: string;
  imageSize?: number;
  imageMimeType?: string;
  creatorName?: string;
  youtubeVideoLabels?: VaultDropRecord['youtubeVideoLabels'];
  importedFromArchiveId?: string;
  /** FIX 20 slot truth — which binary payload slots the drop ACTUALLY has (from blobRefs).
   * Web-imported drawings carry their PNG in the IMAGE slot; locally drawn ones in FILE.
   * Optional so older in-flight DTOs stay type-compatible; renderer falls back file-first. */
  hasFilePayload?: boolean;
  hasImagePayload?: boolean;
  /** FIX 20 — the manifest's Excalidraw scene blueprint for imported drawings. Present ⇒ the
   * editor builds the initial scene from THIS JSON with zero byte fetches. */
  drawingScene?: unknown;
}

function toDTO(record: VaultDropRecord): DropDTO {
  return {
    id: record.id,
    spaceId: record.spaceId,
    workspaceId: record.spaceId === 'personal' ? null : record.spaceId,
    type: record.type,
    name: record.name,
    categories: record.categories,
    pinned: record.pinned,
    locked: record.locked,
    isDrawing: record.isDrawing,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    expirationOption: record.expirationOption,
    reminderAt: record.reminderAt,
    reminderSetByUid: record.reminderSetByUid ?? null,
    reminderDismissedBy: record.reminderDismissedBy ?? null,
    reminderFiredAt: record.reminderFiredAt ?? null,
    fileSize: record.fileSize,
    mimeType: record.mimeType,
    imageSize: record.imageSize,
    imageMimeType: record.imageMimeType,
    creatorName: record.creatorName,
    youtubeVideoLabels: record.youtubeVideoLabels,
    importedFromArchiveId: record.importedFromArchiveId,
    hasFilePayload: !!record.blobRefs.file,
    hasImagePayload: !!record.blobRefs.image,
    drawingScene: record.drawingScene ?? undefined,
  };
}

interface MediaTokenEntry {
  dropId: string;
  kind: 'file' | 'image';
  blobPath: string;
  mimeType: string;
  totalBytes: number;
}

export class VaultManager {
  private fsmod: BlobFs = makeNodeBlobFs(fsp);
  private folder: string | null = null;
  private header: VaultHeader | null = null;
  private headerBytes: Uint8Array<ArrayBuffer> | null = null;
  private verifier: Uint8Array<ArrayBuffer> | null = null;
  private keys: UnlockedKeys | null = null;
  private index: VaultIndex | null = null;

  private snapshotRegionLength = 0;
  private journalBytesCount = 0;
  private compactTimer: NodeJS.Timeout | null = null;
  private persistChain: Promise<void> = Promise.resolve();

  private mediaTokens = new Map<string, MediaTokenEntry>();
  /** FIX 16: composite (dropId|kind|blobPath|bytes) → live token, so repeat URL requests for
   * the same unedited payload reuse one token. Edits land at a NEW vblob path ⇒ new composite
   * ⇒ fresh token automatically; cleared everywhere mediaTokens is cleared (lock/unlock). */
  private mediaTokenKeys = new Map<string, string>();
  private lastActivity = Date.now();
  private idleTimer: NodeJS.Timeout | null = null;
  private firedReminderIds = new Set<string>();
  private reminderTimer: NodeJS.Timeout | null = null;

  get vaultFilePath(): string {
    return pathMod.join(this.folder ?? '', VAULT_DIR_NAME, VAULT_FILE_NAME);
  }

  get blobsDir(): string {
    return pathMod.join(this.folder ?? '', VAULT_DIR_NAME, BLOBS_DIR_NAME);
  }

  touch(): void {
    this.lastActivity = Date.now();
  }

  /** True when a vault folder has been chosen (even while locked). */
  hasFolder(): boolean {
    return this.folder !== null;
  }

  /** Locate an existing vault at <folder>/DropSync.vault/vault.vmeta without unlocking. */
  async probeFolder(folder: string): Promise<boolean> {
    try {
      await fsp.access(pathMod.join(folder, VAULT_DIR_NAME, VAULT_FILE_NAME));
      return true;
    } catch {
      return false;
    }
  }

  /** Remember a picked folder (no unlock). Returns whether a vault already lives there. */
  async prepareFolder(folder: string): Promise<{ hasVault: boolean }> {
    const stat = await fsp.stat(folder).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      throw new Error('That folder does not exist.');
    }
    if (this.folder !== folder) {
      // Switching folders abandons any in-memory state for the previous one.
      this.folder = folder;
      this.keys = null;
      this.index = null;
      this.header = null;
      this.headerBytes = null;
      this.verifier = null;
      this.mediaTokens.clear();
      this.mediaTokenKeys.clear();
    }
    return { hasVault: await this.probeFolder(folder) };
  }

  status(): { state: 'none' | 'locked' | 'unlocked'; folder: string | null } {
    if (!this.folder) return { state: 'none', folder: null };
    return { state: this.keys ? 'unlocked' : 'locked', folder: this.folder };
  }

  // ------------------------------------------------------------------ create / unlock / lock

  async create(folder: string, password: string): Promise<void> {
    assertVaultPassword(password);
    const vaultDir = pathMod.join(folder, VAULT_DIR_NAME);
    const vaultFile = pathMod.join(vaultDir, VAULT_FILE_NAME);
    if (nodeFs.existsSync(vaultFile)) {
      throw new Error('A vault already exists in that folder.');
    }
    await fsp.mkdir(vaultDir, { recursive: true });
    await fsp.mkdir(pathMod.join(vaultDir, BLOBS_DIR_NAME), { recursive: true });

    const created = await createVaultKeys(password);
    this.folder = folder;
    this.header = created.header;
    this.headerBytes = created.headerBytes;
    this.verifier = created.verifier;
    this.keys = created.keys;
    this.index = newIndex();

    const snapshotRegion = await sealIndexRegion(created.keys.dek, this.index);
    this.snapshotRegionLength = snapshotRegion.byteLength;
    this.journalBytesCount = 0;
    await writeWholeVaultFile(this.fsmod, vaultFile, created.headerBytes as Uint8Array, created.verifier as Uint8Array, snapshotRegion);
    this.startTimers();
  }

  async unlock(folder: string, password: string): Promise<void> {
    if (this.keys) await this.lock();
    const vaultFile = pathMod.join(folder, VAULT_DIR_NAME, VAULT_FILE_NAME);
    let raw: Buffer;
    try {
      raw = await fsp.readFile(vaultFile);
    } catch {
      throw new Error('No DropSync vault was found in that folder.');
    }
    const buf = new Uint8Array(raw);
    const prefix = decodeVaultHeaderPrefix(buf);
    if (!prefix) throw new Error(WRONG_VAULT_PASSWORD_MESSAGE);
    const { header, headerBytesLength } = prefix;

    // Verifier block: [iv 12][u32 ctLen][ct]
    if (buf.length < headerBytesLength + 12 + 4) throw new Error(WRONG_VAULT_PASSWORD_MESSAGE);
    const ivCtLen = new DataView(buf.buffer, buf.byteOffset).getUint32(headerBytesLength + 12, true);
    const verifierEnd = headerBytesLength + 16 + ivCtLen;
    if (ivCtLen < 16 || buf.length < verifierEnd) throw new Error(WRONG_VAULT_PASSWORD_MESSAGE);
    const verifierBlock = buf.slice(headerBytesLength, verifierEnd);

    const keys = await unlockVaultKeys(password, header, buf.slice(0, headerBytesLength) as Uint8Array<ArrayBuffer>, verifierBlock);
    if (!keys) throw new Error(WRONG_VAULT_PASSWORD_MESSAGE);

    // Snapshot region: [u32le len][bytes…]
    const dv = new DataView(buf.buffer, buf.byteOffset);
    if (buf.length < verifierEnd + 4) throw new Error('The vault index is missing or damaged.');
    const snapLen = dv.getUint32(verifierEnd, true);
    const snapStart = verifierEnd + 4;
    if (snapLen > buf.length - snapStart) throw new Error('The vault index is missing or damaged.');
    const snapshotRegion = buf.slice(snapStart, snapStart + snapLen);

    const index = await openIndexRegion(keys.dek, snapshotRegion);
    if (!index) throw new Error('The vault index is missing or damaged.');

    // Journal replay + torn-tail repair.
    const journalStartOffset = snapStart + snapLen;
    const journalBytes = buf.slice(journalStartOffset);
    let tornTailPath: string | null = null;
    if (journalBytes.length > 0) {
      const read = await openJournalRecords(keys.dek, buf.slice(0, headerBytesLength) as Uint8Array<ArrayBuffer>, journalBytes, journalStartOffset);
      for (const op of read.ops) applyJournalOp(index, op);
      if (read.tornTail) {
        // Torn tail = truncate to last good record (kill -9 mid-append survives cleanly).
        tornTailPath = vaultFile;
        await truncateFileTo(this.fsmod, vaultFile, journalStartOffset + read.lastGoodOffset);
      }
      this.journalBytesCount = read.tornTail ? read.lastGoodOffset : journalBytes.length;
    } else {
      this.journalBytesCount = 0;
    }
    void tornTailPath;

    // Ensure settings defaults for older snapshots.
    index.settings = { ...defaultSettings(), ...index.settings };

    this.folder = folder;
    this.header = header;
    this.headerBytes = buf.slice(0, headerBytesLength) as Uint8Array<ArrayBuffer>;
    this.verifier = verifierBlock;
    this.keys = keys;
    this.index = index;
    this.snapshotRegionLength = snapLen;
    this.mediaTokens.clear();
    this.mediaTokenKeys.clear();
    this.firedReminderIds.clear();
    // Kill-mid-create guarantee: a blob fully written but whose journal op never committed is
    // unreferenced garbage — sweep it (plus stray .tmp leftovers) before the UI comes up.
    await sweepOrphanBlobs(this);
    // Missed-while-closed reminders are silently marked seen here — never a notification storm
    // on launch (spec M6). The loop only fires reminders that come due WHILE we run.
    await this.silentlyMarkPastDueReminders();
    this.startTimers();
  }

  async lock(): Promise<void> {
    this.flushNow().catch(() => {});
    if (this.compactTimer) {
      clearTimeout(this.compactTimer);
      this.compactTimer = null;
    }
    this.keys = null;
    this.index = null;
    this.header = null;
    this.headerBytes = null;
    this.verifier = null;
    this.mediaTokens.clear();
    this.mediaTokenKeys.clear();
    this.stopTimers();
  }

  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    if (!this.keys || !this.header || !this.index || !this.folder || !this.verifier || !this.headerBytes) {
      throw new Error('Unlock the vault first.');
    }
    assertVaultPassword(newPassword);
    // Verify the old password against the CURRENT verifier (never trust the unlocked state alone).
    const check = await unlockVaultKeys(
      oldPassword,
      this.header,
      this.headerBytes as Uint8Array<ArrayBuffer>,
      this.verifier as Uint8Array<ArrayBuffer>
    );
    if (!check) throw new Error('The current password is wrong.');
    const rewrapped = await rewrapVaultKeys(newPassword, this.keys.dekRaw);

    // FIX 24 — a header swap must never copy AAD-bound artifacts. Journal records seal with
    // the OUTER header bytes as their AAD (indexStore.sealJournalRecord → concatBytes(header-
    // Bytes, 'journal')), so carrying them past a fresh header (new salt ⇒ different bytes)
    // bricks the vault: next unlock replays them under the NEW headerBytes ⇒ GCM auth failure
    // ⇒ "the vault index is missing or damaged" under BOTH passwords. The snapshot region is
    // immune — it binds only its INLINE snapHdr bytes (sealIndexRegion). So the whole swap now
    // runs INSIDE persistChain (a reminder tick or any mutation can neither interleave nor
    // survive): force a full compaction, verify zero journal bytes on disk (retry once), then
    // tmp+fsync+rename exactly as before. O(1) rewrap preserved — only the bounded journal is
    // folded into the snapshot; no drop payload is ever re-encrypted.
    let failure: unknown = null;
    this.persistChain = this.persistChain.then(async () => {
      try {
        await this.compactForHeaderSwap();

        // Header swap over a journal-free file.
        const raw = await fsp.readFile(this.vaultFilePath);
        const buf = new Uint8Array(raw);
        const oldPrefix = decodeVaultHeaderPrefix(buf);
        if (!oldPrefix) throw new Error('The vault file is damaged.');
        const dv = new DataView(buf.buffer, buf.byteOffset);
        const vLen = 16 + dv.getUint32(oldPrefix.headerBytesLength + 12, true);
        const snapLenFieldOffset = oldPrefix.headerBytesLength + vLen; // outer [u32le snapLen]
        const snapLen = dv.getUint32(snapLenFieldOffset, true);
        const snapStart = snapLenFieldOffset + 4;
        if (snapStart + snapLen !== buf.length) {
          throw new Error('The vault file changed during the password change.');
        }
        // Second #24 root (found by the harness): the original swap sliced from snapStart —
        // WITHOUT the 4-byte snapshot length prefix — and never re-emitted it, so every
        // header-swapped file parsed as damaged at next unlock regardless of journal state.
        // Carry [u32 snapLen][snapshot region] verbatim; the region itself is self-describing.
        const rest = buf.slice(snapLenFieldOffset, buf.length);
        const tmpBody = new Uint8Array(rewrapped.headerBytes.byteLength + rewrapped.verifier.byteLength + rest.byteLength);
        tmpBody.set(rewrapped.headerBytes, 0);
        tmpBody.set(rewrapped.verifier, rewrapped.headerBytes.byteLength);
        tmpBody.set(rest, rewrapped.headerBytes.byteLength + rewrapped.verifier.byteLength);

        const tmp = `${this.vaultFilePath}.pwtmp`;
        const handle = await fsp.open(tmp, 'w');
        try {
          await handle.write(Buffer.from(tmpBody.buffer, tmpBody.byteOffset, tmpBody.byteLength));
          await handle.sync();
          await handle.close();
        } catch (error) {
          await handle.close().catch(() => {});
          await fsp.unlink(tmp).catch(() => {});
          throw error;
        }
        await fsp.rename(tmp, this.vaultFilePath);

        this.header = rewrapped.header;
        this.headerBytes = rewrapped.headerBytes;
        this.verifier = rewrapped.verifier;
        this.keys = rewrapped.keys;
      } catch (error) {
        failure = error;
      }
    });
    await this.persistChain;
    if (failure !== null) {
      // Reset the queue so one failed change doesn't poison every future operation.
      this.persistChain = Promise.resolve();
      throw failure;
    }
  }

  /** Settings → "Move vault": relocate DropSync.vault under a new parent folder. */
  async moveVault(newParentFolder: string): Promise<void> {
    if (!this.folder) throw new Error('No vault to move.');
    const currentVaultDir = pathMod.join(this.folder, VAULT_DIR_NAME);
    const newVaultDir = pathMod.join(newParentFolder, VAULT_DIR_NAME);
    if (nodeFs.existsSync(pathMod.join(newVaultDir, VAULT_FILE_NAME))) {
      throw new Error('There is already a vault in that folder.');
    }
    await this.flushNow();
    try {
      await fsp.rename(currentVaultDir, newVaultDir);
    } catch {
      // Cross-device move: copy + verify + delete original.
      await copyDirRecursive(currentVaultDir, newVaultDir);
      await fsp.rm(currentVaultDir, { recursive: true, force: true });
    }
    this.folder = newParentFolder;
  }

  // ------------------------------------------------------------------ persistence plumbing

  private scheduleCompact(): void {
    if (this.compactTimer || !this.keys) return;
    this.compactTimer = setTimeout(() => {
      this.compactTimer = null;
      void this.maybeCompact();
    }, 2000);
  }

  private async maybeCompact(): Promise<void> {
    if (!this.keys || !this.index) return;
    const threshold = Math.max(this.snapshotRegionLength * 0.25, 4096);
    if (this.journalBytesCount > threshold) {
      await this.flushNow();
    }
  }

  /** Force-compaction now: fresh sealed snapshot, journal emptied. Serialized via persistChain. */
  async flushNow(): Promise<void> {
    this.persistChain = this.persistChain.then(async () => {
      await this.compactLocked(false);
    }).catch((error) => {
      console.error('[vault] compaction failed:', error);
    });
    return this.persistChain;
  }

  /** Compaction core — MUST run inside persistChain. force=false keeps the old early-return
   * (nothing to fold); force=true compacts regardless of the journal threshold (FIX 24). */
  private async compactLocked(force: boolean): Promise<void> {
    if (!this.keys || !this.index || !this.headerBytes || !this.verifier) return;
    if (!force && this.journalBytesCount === 0 && this.snapshotRegionLength > 0) return;
    this.snapshotRegionLength = await compactVaultFile(
      this.fsmod,
      this.vaultFilePath,
      this.headerBytes as Uint8Array<ArrayBuffer>,
      this.verifier as Uint8Array<ArrayBuffer>,
      this.keys.dek,
      this.index
    );
    this.journalBytesCount = 0;
  }

  /** FIX 24 — fold EVERY pending journal record into a fresh snapshot right now (threshold
   * ignored), then prove from disk that nothing journal-bound remains. One retry absorbs a
   * mutation that raced ahead of us in the queue; a second dirty read is fatal — proceeding
   * would brick the vault at next unlock. Runs ONLY inside persistChain; THROWS on failure
   * (unlike flushNow, a header swap must never continue on a silently failed compaction). */
  private async compactForHeaderSwap(): Promise<void> {
    if (!this.keys || !this.index || !this.headerBytes || !this.verifier) {
      throw new Error('Vault is locked.');
    }
    await this.compactLocked(true);
    for (let attempt = 0; attempt < 2; attempt++) {
      const pending = await this.pendingJournalBytesOnDisk();
      if (pending === 0) return;
      if (attempt > 0) break;
      await this.compactLocked(true);
    }
    throw new Error('The vault could not be consolidated before the password change.');
  }

  /** Disk truth: how many journal bytes physically sit past the snapshot region. */
  private async pendingJournalBytesOnDisk(): Promise<number> {
    const raw = await fsp.readFile(this.vaultFilePath);
    const buf = new Uint8Array(raw);
    const prefix = decodeVaultHeaderPrefix(buf);
    if (!prefix) throw new Error('The vault file is damaged.');
    const dv = new DataView(buf.buffer, buf.byteOffset);
    const vLen = 16 + dv.getUint32(prefix.headerBytesLength + 12, true);
    const snapStart = prefix.headerBytesLength + vLen + 4;
    const snapLen = dv.getUint32(prefix.headerBytesLength + vLen, true);
    return Math.max(0, buf.length - (snapStart + snapLen));
  }

  private async mutate(op: JournalOp): Promise<void> {
    if (!this.keys || !this.index || !this.headerBytes) throw new Error('Vault is locked.');
    // Serialize EVERY mutation through the same queue as compaction — a journal append must
    // never race the rename that swaps in a fresh snapshot (on some filesystems, e.g. WSL's
    // /mnt/d 9P mount, rename is not atomic and a concurrent open('a') can hit ENOENT).
    let failure: unknown = null;
    this.persistChain = this.persistChain.then(async () => {
      try {
        applyJournalOp(this.index!, op);
        const record = await sealJournalRecord(this.keys!.dek, this.headerBytes as Uint8Array<ArrayBuffer>, op);
        await appendJournalRecordToFile(this.fsmod, this.vaultFilePath, record);
        this.journalBytesCount += record.byteLength;
      } catch (error) {
        failure = error;
        console.error('[vault] journal append failed:', error);
      }
    });
    await this.persistChain;
    // Reset the queue so one failed append doesn't poison every future operation.
    if (failure !== null) {
      this.persistChain = Promise.resolve();
      throw failure;
    }
    this.scheduleCompact();
  }

  // ------------------------------------------------------------------ spaces / categories / settings

  listSpaces(): VaultSpace[] {
    this.assertUnlocked();
    return [...this.index!.spaces];
  }

  async createSpace(name: string): Promise<VaultSpace> {
    this.assertUnlocked();
    const trimmed = name.trim().slice(0, 120) || 'Workspace';
    const space: VaultSpace = { id: crypto.randomUUID(), name: trimmed, createdAt: new Date().toISOString() };
    await this.mutate({ op: 'space.put', space });
    return space;
  }

  /** FIX 19 — rename a workspace IN PLACE: the id and createdAt are stable, so mentions
   * (drop-id keyed), categories (spaceId keyed), listPrefs and pins all follow untouched.
   * Personal is structural — it can never be renamed. Same input contract as createSpace:
   * trim + 120-char cap + 'Workspace' fallback for an empty result. */
  async renameSpace(id: string, name: string): Promise<VaultSpace> {
    this.assertUnlocked();
    if (id === 'personal') throw new Error('Personal cannot be renamed.');
    const space = this.index!.spaces.find((s) => s.id === id);
    if (!space) throw new Error('That workspace no longer exists.');
    const trimmed = name.trim().slice(0, 120) || 'Workspace';
    if (trimmed === space.name) return space;
    const next: VaultSpace = { ...space, name: trimmed };
    await this.mutate({ op: 'space.put', space: next });
    return next;
  }

  /**
   * FIX 19 — delete a workspace. ONE journal op ('space.delete'); applyJournalOp cascades the
   * index side exactly like the web's deleteWorkspace (drops of that space + that space's
   * categories go with it — never personal categories). Blob FILES of removed drops are left
   * behind deliberately: they become unreferenced .vblobs and sweepOrphanBlobs() removes them
   * at the next unlock (the established kill-mid-create guarantee path). Personal is
   * structural — it can never be deleted. No undo anywhere in the studied web flow, so none
   * here either (flagged in the study phase).
   */
  async deleteSpace(id: string): Promise<boolean> {
    this.assertUnlocked();
    if (id === 'personal') throw new Error('Personal cannot be deleted.');
    if (!this.index!.spaces.some((s) => s.id === id)) return false;
    await this.mutate({ op: 'space.delete', id });
    return true;
  }

  listCategories(spaceId: string): VaultCategory[] {
    this.assertUnlocked();
    return this.index!.categories.filter((c) => c.spaceId === spaceId);
  }

  async createCategory(spaceId: string, name: string): Promise<VaultCategory> {
    this.assertUnlocked();
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Enter a category name.');
    const existing = this.listCategories(spaceId).find((c) => c.name.toLowerCase().trim() === trimmed.toLowerCase());
    if (existing) return existing;
    const category: VaultCategory = { id: crypto.randomUUID(), spaceId, name: trimmed, createdAt: new Date().toISOString() };
    await this.mutate({ op: 'category.put', category });
    return category;
  }

  async deleteCategory(id: string): Promise<void> {
    this.assertUnlocked();
    await this.mutate({ op: 'category.delete', id });
  }

  getSettings(): VaultSettings {
    this.assertUnlocked();
    return structuredClone(this.index!.settings);
  }

  async setSettings(patch: Partial<VaultSettings>): Promise<VaultSettings> {
    this.assertUnlocked();
    // FIX 7 hygiene: settings were blindly merged, so any renderer bug could persist nonsense
    // (autoLockMinutes: -1 silently disabled the idle timer; a stray theme string broke theming).
    // Validate the incoming patch before merging; reject garbage with a clear error.
    if (patch.autoLockMinutes !== undefined) {
      const v = patch.autoLockMinutes;
      const valid = v === null || (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 480);
      if (!valid) {
        throw new Error('Invalid autoLockMinutes: use null (off) or a whole number of minutes between 1 and 480.');
      }
    }
    if (patch.theme !== undefined && !['light', 'dark', 'minimal'].includes(patch.theme)) {
      throw new Error('Invalid theme: expected light, dark, or minimal.');
    }
    const next: VaultSettings = { ...structuredClone(this.index!.settings), ...patch };
    await this.mutate({ op: 'settings.set', settings: next });
    return structuredClone(next);
  }

  // ------------------------------------------------------------------ drops

  /** Non-expired drops for a space, wall-clock evaluated (expired stays expired & hidden). */
  listDrops(spaceId: string): DropDTO[] {
    this.assertUnlocked();
    const now = Date.now();
    return this.index!.drops
      .filter((d) => d.spaceId === spaceId)
      .filter((d) => !d.expiresAt || new Date(d.expiresAt).getTime() > now)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .map(toDTO);
  }

  getDropMeta(dropId: string): DropDTO | null {
    this.assertUnlocked();
    const record = this.index!.drops.find((d) => d.id === dropId);
    return record ? toDTO(record) : null;
  }

  /** Decrypted text payload (inline ≤64 KB body, or the oversized body blob). */
  async getTextPayload(dropId: string): Promise<{ text: string } | null> {
    this.assertUnlocked();
    const record = this.findDrop(dropId);
    if (record.type !== 'text') return null;
    if (record.blobRefs.body) {
      const bytes = await readBlobAll(this.fsmod, pathMod.join(this.blobsDir, pathMod.basename(record.blobRefs.body.path)), this.keys!.dek);
      return { text: new TextDecoder().decode(bytes) };
    }
    return { text: record.content ?? '' };
  }

  /**
   * Fully-read bytes for a binary payload — the fetch()-free path for in-page scene extraction
   * (Chromium scheme-blocks fetch() on custom protocols, so media:// URLs only work for
   * <img>/<video> tags). Hard-capped: this channel exists for drawing PNGs / attached images,
   * not for multi-hundred-MB archives (those stream through media:// or Save-As).
   */
  async getBlobBytes(dropId: string, kind: 'file' | 'image', maxBytes = 64 * 1024 * 1024): Promise<Uint8Array | null> {
    this.assertUnlocked();
    const record = this.findDrop(dropId);
    const ref = kind === 'file' ? record.blobRefs.file : record.blobRefs.image;
    if (!ref) return null;
    if (ref.bytes > maxBytes) {
      throw new Error('That payload is too large to open inline.');
    }
    return readBlobAll(this.fsmod, pathMod.join(this.blobsDir, pathMod.basename(ref.path)), this.keys!.dek);
  }

  /** Register an opaque streaming URL for a binary payload (file attachment or attached image).
   * FIX 16: tokens are STABLE per composite identity — repeat calls for the same unedited
   * payload return the identical URL instead of minting a fresh random token every time
   * (which forced Chromium to re-fetch and main to re-decrypt identical pixels). */
  getMediaUrl(dropId: string, kind: 'file' | 'image'): string | null {
    this.assertUnlocked();
    const record = this.findDrop(dropId);
    const ref = kind === 'file' ? record.blobRefs.file : record.blobRefs.image;
    if (!ref) return null;
    const blobPath = pathMod.join(this.blobsDir, pathMod.basename(ref.path));
    const composite = `${dropId}|${kind}|${blobPath}|${ref.bytes}`;
    const existing = this.mediaTokenKeys.get(composite);
    if (existing && this.mediaTokens.has(existing)) return `media://r/${existing}`;
    const token = crypto.randomUUID().replace(/-/g, '');
    this.mediaTokens.set(token, {
      dropId,
      kind,
      blobPath,
      mimeType: (kind === 'file' ? record.mimeType : record.imageMimeType) || 'application/octet-stream',
      totalBytes: ref.bytes,
    });
    this.mediaTokenKeys.set(composite, token);
    return `media://r/${token}`;
  }

  /** FIX 16 battery probe: token-map sizes must stay equal and bounded by distinct payloads. */
  mediaTokenStats(): { tokens: number; keys: number } {
    return { tokens: this.mediaTokens.size, keys: this.mediaTokenKeys.size };
  }

  resolveMediaToken(token: string): MediaTokenEntry | null {
    return this.mediaTokens.get(token) ?? null;
  }

  /** Decrypted stream of a payload blob WITHOUT a media token — the exporter's ingest path
   * (zip entry streams must not depend on session token bookkeeping). */
  streamBlob(dropId: string, kind: 'file' | 'image'): ReadableStream<Uint8Array> | null {
    this.assertUnlocked();
    const record = this.findDrop(dropId);
    const ref = kind === 'file' ? record.blobRefs.file : record.blobRefs.image;
    if (!ref) return null;
    return readBlobRange(this.fsmod, pathMod.join(this.blobsDir, pathMod.basename(ref.path)), this.keys!.dek, 0, Number.POSITIVE_INFINITY);
  }

  /** Range-capable decrypted stream for the media:// protocol handler. */
  streamMedia(entry: MediaTokenEntry, start: number, endExclusive: number): ReadableStream<Uint8Array> {
    this.assertUnlocked();
    return readBlobRange(this.fsmod, entry.blobPath, this.keys!.dek, start, endExclusive);
  }

  /** Full decrypted bytes of a binary payload (Save As streams through here for small files too). */
  readMediaBytes(entry: MediaTokenEntry): Promise<Uint8Array<ArrayBuffer>> {
    this.assertUnlocked();
    return readBlobAll(this.fsmod, entry.blobPath, this.keys!.dek);
  }

  /** Create a streaming encrypted blob writer inside the vault (used by import + later create/edit). */
  createVaultBlobWriter(): OpenBlobWriter & { ref: () => Promise<VaultBlobRef> } {
    this.assertUnlocked();
    const fileName = `${crypto.randomUUID()}.vblob`;
    const writer = createBlobWriter(this.fsmod, pathMod.join(this.blobsDir, fileName), this.keys!.dek);
    return {
      writable: writer.writable,
      abort: writer.abort,
      finish: async () => {
        const result = await writer.finish();
        return { path: `${BLOBS_DIR_NAME}/${fileName}`, sha256: result.sha256, bytes: result.bytes };
      },
      ref: async () => {
        const result = await writer.finish();
        return { path: `${BLOBS_DIR_NAME}/${fileName}`, sha256: result.sha256, bytes: result.bytes };
      },
    };
  }

  /** Upsert a full drop record (import + future create/edit paths). */
  async putDrop(record: VaultDropRecord): Promise<void> {
    this.assertUnlocked();
    await this.mutate({ op: 'drop.put', drop: record });
  }

  async patchDropMeta(dropId: string, patch: Partial<Pick<VaultDropRecord, 'pinned' | 'locked' | 'name' | 'categories' | 'reminderAt' | 'reminderDismissedBy' | 'reminderSetByUid' | 'expirationOption'>>): Promise<DropDTO | null> {
    this.assertUnlocked();
    const record = this.findDrop(dropId);
    const next: VaultDropRecord = { ...record, ...patch };
    await this.mutate({ op: 'drop.put', drop: next });
    return toDTO(next);
  }

  async deleteDrop(dropId: string): Promise<boolean> {
    this.assertUnlocked();
    const record = this.findDrop(dropId);
    for (const ref of [record.blobRefs.file, record.blobRefs.image, record.blobRefs.body]) {
      if (ref) await this.fsmod.unlink(pathMod.join(this.blobsDir, pathMod.basename(ref.path)));
    }
    await this.mutate({ op: 'drop.delete', id: dropId });
    return true;
  }

  findDrop(dropId: string): VaultDropRecord {
    this.assertUnlocked();
    const record = this.index!.drops.find((d) => d.id === dropId);
    if (!record) throw new Error(`Drop not found: ${dropId}`);
    return record;
  }

  // ---- public surface for dropOps.ts (create/edit routines live there; state stays here) ----

  assertUnlockedPublic(): void {
    this.assertUnlocked();
  }

  mutatePublic(op: JournalOp): Promise<void> {
    return this.mutate(op);
  }

  /** Best-effort blob removal (missing files are fine). */
  async unlinkBlobQuiet(relPath: string): Promise<void> {
    await this.fsmod.unlink(pathMod.join(this.blobsDir, pathMod.basename(relPath)));
  }

  /** Every drop record in the vault (orphan sweep walks all spaces). */
  allRecords(): VaultDropRecord[] {
    return this.index?.drops ?? [];
  }

  /** First n decrypted bytes of a blob (image sniffing). */
  async readBlobHead(ref: VaultBlobRef, n: number): Promise<Uint8Array> {
    const stream = readBlobRange(this.fsmod, pathMod.join(this.blobsDir, pathMod.basename(ref.path)), this.keys!.dek, 0, n);
    const reader = stream.getReader();
    try {
      const next = await reader.read();
      return next.done ? new Uint8Array(0) : next.value;
    } finally {
      reader.releaseLock();
      void stream.cancel().catch(() => {});
    }
  }

  /** All records for a space INCLUDING expired — used by the import pin-seed + duplicate checks. */
  listDropsIncludingExpired(spaceId: string): VaultDropRecord[] {
    this.assertUnlocked();
    return this.index!.drops.filter((d) => d.spaceId === spaceId);
  }

  peekDropListHas(spaceId: string): boolean {
    return !!this.index?.spaces.some((s) => s.id === spaceId);
  }

  /** Rollback helpers for the import crash journal — never throw (best-effort teardown). */
  async deleteDropQuiet(dropId: string): Promise<void> {
    try {
      if (this.peekDrop(dropId)) await this.deleteDrop(dropId);
    } catch {
      /* best effort */
    }
  }

  async deleteCategoryQuiet(categoryId: string): Promise<void> {
    try {
      if (this.index?.categories.some((c) => c.id === categoryId)) await this.deleteCategory(categoryId);
    } catch {
      /* best effort */
    }
  }

  async deleteSpaceQuiet(spaceId: string): Promise<void> {
    try {
      if (this.index?.spaces.some((s) => s.id === spaceId)) await this.mutate({ op: 'space.delete', id: spaceId });
    } catch {
      /* best effort */
    }
  }

  peekDrop(dropId: string): VaultDropRecord | undefined {
    return this.index?.drops.find((d) => d.id === dropId);
  }

  // ------------------------------------------------------------------ reminders + idle auto-lock

  private startTimers(): void {
    this.startIdleWatch();
    this.startReminderLoop();
  }

  private stopTimers(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.reminderTimer) {
      clearInterval(this.reminderTimer);
      this.reminderTimer = null;
    }
  }

  private startIdleWatch(): void {
    this.stopIdleOnly();
    this.idleTimer = setInterval(() => {
      // C2l FIX 2 — `?? 10` collapsed the STORED "Off" (null) into 10 minutes, silently locking
      // despite Off and making the null guard below unreachable. Undefined (never set) still
      // falls back to the 10-minute default; an explicit Off now reaches the guard and stays off.
      const stored = this.index?.settings.autoLockMinutes;
      const minutes = stored === undefined ? 10 : stored;
      if (minutes === null || minutes <= 0) return;
      if (Date.now() - this.lastActivity > minutes * 60 * 1000 && this.keys) {
        void this.lock();
      }
    }, 30_000);
  }

  private stopIdleOnly(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private notifyFn: ((title: string, body: string) => void) | null = null;

  /** True when the drop still has live time — expired drops never fire reminders (spec M6).
   * A DISMISSED reminder is never eligible (107e): the dismissal is the user's "I'm done with
   * this reminder" decision and stops EVERY notification path (toast, themed card, missed
   * queue) plus the unlock-time marking. Before 107d's ride this was implicit — production
   * dismissal implies a prior fire, so reminderFiredAt was always set; 107d created the
   * dismissed-but-not-fired state on copies (dismissal rides, firedAt resets) and the sweeper
   * re-notified them (owner-found on candidate 4). */
  private reminderEligible(drop: VaultDropRecord, now: number): boolean {
    if (!drop.reminderAt || drop.reminderFiredAt) return false;
    if (drop.reminderDismissedBy) return false; // 107e — a dismissal silences the reminder
    if (new Date(drop.reminderAt).getTime() > now) return false;
    if (drop.expiresAt && new Date(drop.expiresAt).getTime() <= now) return false;
    return true;
  }

  /** Unlock-time scan: past-due reminders are marked fired WITHOUT notifying. */
  private async silentlyMarkPastDueReminders(): Promise<void> {
    if (!this.index || !this.keys) return;
    const now = Date.now();
    for (const drop of this.index.drops) {
      if (!this.reminderEligible(drop, now)) continue;
      this.firedReminderIds.add(drop.id);
      await this.mutate({ op: 'drop.meta', id: drop.id, patch: { reminderFiredAt: new Date().toISOString() } }).catch(() => {});
    }
  }

  /** Local Windows notifications for due reminders while the app runs and the vault is unlocked.
   * Each firing persists reminderFiredAt through the journal so a restart can never re-fire it. */
  setNotifier(notify: (title: string, body: string) => void): void {
    this.notifyFn = notify;
  }

  private startReminderLoop(): void {
    if (this.reminderTimer) clearInterval(this.reminderTimer);
    this.reminderTimer = setInterval(() => {
      if (!this.index || !this.keys) return;
      const now = Date.now();
      for (const drop of this.index.drops) {
        if (!this.reminderEligible(drop, now)) continue;
        this.firedReminderIds.add(drop.id);
        try {
          this.notifyFn?.(drop.name, 'Reminder');
        } catch {
          /* notifications unavailable */
        }
        void this.mutate({ op: 'drop.meta', id: drop.id, patch: { reminderFiredAt: new Date().toISOString() } }).catch(() => {});
      }
    }, 30_000);
  }

  private assertUnlocked(): void {
    if (!this.keys || !this.index) throw new Error('Vault is locked.');
  }
}

async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = pathMod.join(src, entry.name);
    const d = pathMod.join(dest, entry.name);
    if (entry.isDirectory()) await copyDirRecursive(s, d);
    else await fsp.copyFile(s, d);
  }
}
