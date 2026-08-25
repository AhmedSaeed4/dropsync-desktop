/**
 * Vault data model — the CONTENT-class drop record from the desktop spec, plus the sealed-index
 * document shape. Dates are stored as ISO strings (JSON index); the renderer adapter converts
 * them back to Date objects so the ported Editorial components keep their web signatures.
 */

export interface YouTubeVideoLabel {
  videoId: string;
  title: string;
  channel: string | null;
}

export interface VaultBlobRef {
  /** Path relative to the vault folder, e.g. 'blobs/<uuid>.vblob'. Random UUIDs — never content hashes. */
  path: string;
  sha256: string;
  bytes: number;
}

export interface VaultDropRecord {
  id: string;
  spaceId: string; // 'personal' | workspace id
  type: 'text' | 'file';
  name: string;
  /** Inline text body — only when ≤ INLINE_TEXT_LIMIT bytes; larger bodies live in blobRefs.body. */
  content?: string;
  categories: string[];
  pinned: boolean;
  locked: boolean;
  isDrawing: boolean;
  createdAt: string;
  expiresAt: string | null;
  expirationOption?: '1h' | '2h' | '4h' | '6h' | '24h' | 'forever';
  reminderAt: string | null;
  reminderSetByUid?: string | null;
  reminderDismissedBy?: string | null;
  /** Set (through the journal) the moment a reminder fires or is silently marked seen at unlock —
   * survives restarts so a reminder never notifies twice. Null/absent = not yet fired. */
  reminderFiredAt?: string | null;
  fileSize?: number;
  mimeType?: string;
  imageSize?: number;
  imageMimeType?: string;
  creatorName?: string;
  youtubeVideoLabels?: YouTubeVideoLabel[];
  importedFromArchiveId?: string;
  drawingScene?: unknown;
  blobRefs: {
    file?: VaultBlobRef;
    image?: VaultBlobRef;
    body?: VaultBlobRef; // text body over the 64 KB inline threshold
  };
  contentSha256s: {
    content?: string;
    file?: string;
    image?: string;
  };
}

export interface VaultSpace {
  id: string;
  name: string;
  createdAt: string;
}

export interface VaultCategory {
  id: string;
  spaceId: string;
  name: string;
  createdAt: string;
}

export interface VaultSettings {
  autoLockMinutes: number | null; // 1–480 (minutes; the picker also offers 2/4/8 h presets), or null = off. Default 10.
  theme: 'light' | 'dark' | 'minimal';
  /** Per-space drop-list preferences (sort mode + manual order), mirroring the web's user-doc maps. */
  listPrefs: Record<string, { mode: Record<string, string>; order: Record<string, string[]> }>;
  /** Per-space collapsed-category-pill state. */
  collapsed: Record<string, boolean>;
}

export interface VaultIndex {
  version: 1;
  spaces: VaultSpace[];
  categories: VaultCategory[];
  drops: VaultDropRecord[];
  settings: VaultSettings;
}

export function defaultSettings(): VaultSettings {
  return {
    autoLockMinutes: 10,
    theme: 'light',
    listPrefs: {},
    collapsed: {},
  };
}

export function emptyIndex(): VaultIndex {
  return {
    version: 1,
    spaces: [{ id: 'personal', name: 'Personal', createdAt: new Date().toISOString() }],
    categories: [],
    drops: [],
    settings: defaultSettings(),
  };
}

/** Text bodies above this many bytes move out of the index into their own encrypted blob. */
export const INLINE_TEXT_LIMIT = 64 * 1024;

/** Journal mutation ops — each independently authenticated record in the append-only log.
 * drop.content = full-record replacement for payload edits (re-encrypted blobs already on disk
 * before this op commits); drop.meta = light metadata patch (no payload rewrite). */
export type JournalOp =
  | { op: 'drop.put'; drop: VaultDropRecord }
  | { op: 'drop.content'; drop: VaultDropRecord }
  | { op: 'drop.meta'; id: string; patch: Partial<VaultDropRecord> }
  | { op: 'drop.delete'; id: string }
  | { op: 'category.put'; category: VaultCategory }
  | { op: 'category.delete'; id: string }
  | { op: 'space.put'; space: VaultSpace }
  | { op: 'space.delete'; id: string }
  | { op: 'settings.set'; settings: VaultSettings };

export function applyJournalOp(index: VaultIndex, journal: JournalOp): void {
  switch (journal.op) {
    case 'drop.put':
    case 'drop.content': {
      const drop = journal.drop;
      const i = index.drops.findIndex((d) => d.id === drop.id);
      if (i >= 0) index.drops[i] = drop;
      else index.drops.push(drop);
      break;
    }
    case 'drop.meta': {
      const i = index.drops.findIndex((d) => d.id === journal.id);
      if (i >= 0) index.drops[i] = { ...index.drops[i], ...journal.patch };
      break;
    }
    case 'drop.delete':
      index.drops = index.drops.filter((d) => d.id !== journal.id);
      break;
    case 'category.put': {
      const i = index.categories.findIndex((c) => c.id === journal.category.id);
      if (i >= 0) index.categories[i] = journal.category;
      else index.categories.push(journal.category);
      break;
    }
    case 'category.delete':
      index.categories = index.categories.filter((c) => c.id !== journal.id);
      break;
    case 'space.put': {
      const i = index.spaces.findIndex((s) => s.id === journal.space.id);
      if (i >= 0) index.spaces[i] = journal.space;
      else index.spaces.push(journal.space);
      break;
    }
    case 'space.delete': {
      const id = journal.id;
      index.spaces = index.spaces.filter((s) => s.id !== id);
      index.drops = index.drops.filter((d) => d.spaceId !== id);
      index.categories = index.categories.filter((c) => c.spaceId !== id);
      break;
    }
    case 'settings.set':
      index.settings = journal.settings;
      break;
  }
}
