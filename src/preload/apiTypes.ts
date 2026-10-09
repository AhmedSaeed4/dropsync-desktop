/**
 * Pure type definitions for the contextBridge surface — no Electron imports, so this file is
 * safe for BOTH tsconfig programs (node: preload/main, web: renderer).
 */

export interface VaultSpaceDTO {
  id: string;
  name: string;
  createdAt: string;
}

export interface VaultCategoryDTO {
  id: string;
  spaceId: string;
  name: string;
  createdAt: string;
}

export interface DropDTO {
  id: string;
  spaceId: string;
  workspaceId: string | null;
  type: 'text' | 'file';
  name: string;
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
  reminderFiredAt?: string | null;
  fileSize?: number;
  mimeType?: string;
  imageSize?: number;
  imageMimeType?: string;
  creatorName?: string;
  youtubeVideoLabels?: Array<{ videoId: string; title: string; channel: string | null }>;
  importedFromArchiveId?: string;
  /** FIX 20 slot truth (see vault.ts DropDTO) — which payload slots actually exist. */
  hasFilePayload?: boolean;
  hasImagePayload?: boolean;
  /** FIX 20 — manifest Excalidraw scene for imported drawings (editor zero-fetch path). */
  drawingScene?: unknown;
  /** #28 — content fingerprint (stamped at write time; lets a list card notice its
   *  content changed and re-read just itself). Mirrors the record's map. */
  contentSha256s?: { content?: string; file?: string; image?: string };
}

export interface ArchiveInspectionDTO {
  flavor: 'dropsync.personal' | 'dropsync.workspace';
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
  legacyTimers: boolean;
  warnings: string[];
}

export interface ImportResultDTO {
  spaceId: string;
  importedCount: number;
  legacyExpiryFallbackCount: number;
  zeroRemainingCount: number;
  downgradedForeverCount: number;
  unpinnedCount: number;
  warnings: string[];
}

export type ImportDestinationDTO =
  | { mode: 'personal' }
  | { mode: 'new'; name: string }
  | { mode: 'merge'; spaceId: string };

export interface VaultSettingsDTO {
  autoLockMinutes: number | null;
  theme: 'light' | 'dark' | 'minimal';
  listPrefs: Record<string, { mode: Record<string, string>; order: Record<string, string[]> }>;
  collapsed: Record<string, boolean>;
}

export interface ImportProgressDTO {
  phase: string;
  processedBytes: number;
  totalBytes: number;
  currentName?: string;
  message?: string;
}

/** Round 118 — in-app updates (manual mode; see src/main/updater.ts). */
export interface UpdateCheckResultDTO {
  currentVersion: string;
  available: boolean;
  version: string | null;
  disabled: boolean;
}
export interface UpdateNotesDTO {
  notes: string | null;
  url: string;
}
export interface UpdateProgressDTO {
  state: 'downloading' | 'done' | 'cancelled' | 'error';
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

/** Expiry menu is exactly these five on desktop (LOCKED decision — 4h stays import-only). */
export type CreateExpirationOptionDTO = '1h' | '2h' | '6h' | '24h' | 'forever';

export interface CreateTextArgsDTO {
  spaceId: string;
  name?: string;
  content: string;
  categories?: string[];
  expirationOption?: CreateExpirationOptionDTO;
  locked?: boolean;
  reminderAt?: string | null;
  imagePath?: string | null;
  imageBytes?: Uint8Array | null;
  pngBytes?: Uint8Array | null;
}

export interface CreateFileMetaDTO {
  spaceId: string;
  name?: string;
  expirationOption?: CreateExpirationOptionDTO;
  locked?: boolean;
  mimeType?: string;
}

export interface UpdateContentArgsDTO {
  name?: string;
  content?: string;
  categories?: string[];
  imagePath?: string | null;
  imageBytes?: Uint8Array | null;
  imageRemoved?: boolean;
  pngBytes?: Uint8Array | null;
}

export interface UpdateMetaPatchDTO {
  name?: string;
  categories?: string[];
  locked?: boolean;
  expirationOption?: CreateExpirationOptionDTO;
  reminderAt?: string | null;
}

export interface RefreshTitlesResultDTO {
  scanned: number;
  needed: number;
  refreshed: number;
  offline: boolean;
  /** FIX 9: full DTOs whose youtubeVideoLabels actually changed — lets the renderer patch the
   * list in place instead of flipping it to skeleton for a batch title update. */
  updatedDrops?: DropDTO[];
}

/** Round 120 (View-as lenses) — the nine text lenses (web Round 24 parity) + the native
 * menu bridge payloads. The lens list WITH labels rides the menu request so the main
 * process never duplicates the renderer's LENSES constant (single source of truth). */
export type TextLensDTO = 'plain' | 'markdown' | 'typescript' | 'javascript' | 'python' | 'json' | 'html' | 'css' | 'bash';
export interface TextLensOptionDTO { lens: TextLensDTO; label: string }
export interface TextRecommendationDTO { lens: TextLensDTO; score: number }
export interface ViewAsStateDTO { available: boolean; surfaceId: 'text-body' | 'text-file' }
export interface ViewAsSelectionFactsDTO {
  text: string;
  isEditable: boolean;
  editFlags: { canCopy: boolean; canCut: boolean; canPaste: boolean };
}
export interface ViewAsMenuRequestDTO {
  surfaceId: 'text-body' | 'text-file';
  lens: TextLensDTO;
  lenses: TextLensOptionDTO[];
  recommendations: TextRecommendationDTO[];
  selection: ViewAsSelectionFactsDTO;
}
export interface ViewAsLensSelectionDTO { surfaceId: 'text-body' | 'text-file'; lens: TextLensDTO }

/** Round 107 — move/copy drops between spaces (repair-order-107 §4 FIX A). One call per
 * batch; the target is 'personal' or a workspace id. */
export interface DropTransferArgs {
  mode: 'move' | 'copy';
  dropIds: string[];
  targetSpaceId: string; // 'personal' | workspace id
}

/** One entry per requested id, same order as DropTransferArgs.dropIds. */
export interface DropTransferResultItem {
  id: string;        // source drop id
  newId?: string;    // set on success in copy mode
  success: boolean;
  error?: string;
}

/** ok:false = pre-flight failure (target missing, category prep failed) — no results. */
export interface DropTransferResult {
  ok: boolean;                // false = pre-flight failure (target missing, category prep failed)
  error?: string;             // set when ok === false
  results?: DropTransferResultItem[]; // set when ok === true (one per requested id, same order)
}

/** Export-back summary (M5) — mirrors main's ExportSummary. */
export interface ExportSummaryDTO {
  included: number;
  skippedExpired: number;
  skippedOther: Array<{ name: string; reason: string }>;
  totalPayloadBytes: number;
}

/** The full contract the preload exposes on window.dropsync. */
export interface DropsyncBridge {
  vault: {
    create(folder: string, password: string): Promise<void>;
    unlock(folder: string, password: string): Promise<{ state: string; folder: string | null }>;
    lock(): Promise<void>;
    changePassword(oldPassword: string, newPassword: string): Promise<void>;
    status(): Promise<{ state: 'none' | 'locked' | 'unlocked'; folder: string | null }>;
    probeFolder(folder: string): Promise<boolean>;
    prepareFolder(folder: string): Promise<{ hasVault: boolean }>;
    move(newParentFolder: string): Promise<void>;
    listSpaces(): Promise<VaultSpaceDTO[]>;
    createSpace(name: string): Promise<VaultSpaceDTO>;
    /** FIX 19 — rename a workspace in place (id stable; Personal rejected). */
    renameSpace(id: string, name: string): Promise<VaultSpaceDTO>;
    /** FIX 19 — delete a workspace (cascades its drops + categories; Personal rejected). */
    deleteSpace(id: string): Promise<boolean>;
    listCategories(spaceId: string): Promise<VaultCategoryDTO[]>;
    createCategory(spaceId: string, name: string): Promise<VaultCategoryDTO>;
    deleteCategory(id: string): Promise<void>;
    importInspect(filePath: string, password: string): Promise<ArchiveInspectionDTO>;
    importRun(options: { filePath: string; password: string; destination: ImportDestinationDTO }): Promise<ImportResultDTO>;
    hasArchiveOverlap(spaceId: string, archiveId: string): Promise<boolean>;
    settingsGet(): Promise<VaultSettingsDTO>;
    settingsSet(patch: Partial<VaultSettingsDTO>): Promise<VaultSettingsDTO>;
    saveAs(dropId: string, kind: 'file' | 'image'): Promise<{ path: string | null }>;
    /** Export-back: write a .dropsync archive for 'personal' or a workspace. Fresh password every time. */
    export(scope: 'personal' | { workspaceId: string }, password: string, outPath: string): Promise<ExportSummaryDTO>;
    exportCancel(): Promise<boolean>;
  };
  drop: {
    list(spaceId: string): Promise<DropDTO[]>;
    getMeta(dropId: string): Promise<DropDTO | null>;
    getPayload(dropId: string): Promise<{ text?: string } | null>;
    patch(dropId: string, patch: Record<string, unknown>): Promise<DropDTO | null>;
    delete(dropId: string): Promise<boolean>;
    createText(args: CreateTextArgsDTO): Promise<DropDTO | null>;
    createFileFromPath(absolutePath: string, meta: CreateFileMetaDTO): Promise<DropDTO | null>;
    createFileFromBytes(bytes: Uint8Array, displayName: string, mimeType: string | undefined, meta: CreateFileMetaDTO): Promise<DropDTO | null>;
    updateContent(dropId: string, updates: UpdateContentArgsDTO): Promise<DropDTO | null>;
    updateMeta(dropId: string, patch: UpdateMetaPatchDTO): Promise<DropDTO | null>;
    /** Round 107 — move/copy a batch of drops to another space (repair-order-107 §4 FIX A). */
    transfer: (args: DropTransferArgs) => Promise<DropTransferResult>;
  };
  youtube: {
    refreshTitles(spaceId: string): Promise<RefreshTitlesResultDTO>;
    /** Round 114 — fetch-once-then-cache thumbnail; null offline/dead/unknown. */
    getThumbnail(videoId: string): Promise<string | null>;
  };
  /** Round 120 — the native View-as menu bridge (right-click on a preview text surface). */
  viewAs: {
    state(state: ViewAsStateDTO): Promise<void>;
    menu(request: ViewAsMenuRequestDTO): Promise<void>;
    onViewAsLensSelected(listener: (selection: ViewAsLensSelectionDTO) => void): () => void;
  };
  /** C1 — desktop mode. Cloud = embedded real site; Local = the encrypted vault UI.
   * (C2f: the porch-era probeEmail/devC2 members are gone with the porch.) */
  mode: {
    get(): Promise<'cloud' | 'local'>;
    /** 'cloud' seals the vault via the existing lock path; 'local' reveals the entry branch. */
    set(next: 'cloud' | 'local'): Promise<'cloud' | 'local'>;
    /** DEV-ONLY (DROPSYNC_CLOUD_DEV=1) — f_c1_* evidence; unregistered otherwise. */
    devProbe?(): Promise<unknown>;
  };
  /** C2f FIX 2/3 — the floating pill's flip relay. Main forwards the pill's ONE flip request
   * here; the renderer runs the EXISTING guarded switchMode. Returns the unsubscribe. */
  onPillFlipRequested(listener: (next: 'cloud' | 'local') => void): () => void;
  shell: {
    openExternal(url: string): Promise<boolean>;
  };
  /** Round 118 — user-clicks-every-step in-app updates. */
  update: {
    check(): Promise<UpdateCheckResultDTO>;
    notes(): Promise<UpdateNotesDTO>;
    download(): Promise<boolean>;
    cancel(): Promise<boolean>;
    install(): Promise<boolean>;
  };
  dialog: {
    pickOpen(options?: { title?: string; extensions?: string[] }): Promise<string | null>;
    pickOpenMultiple(options?: { title?: string; extensions?: string[] }): Promise<string[]>;
    pickSave(options?: { suggestedName?: string }): Promise<string | null>;
    pickFolder(options?: { title?: string }): Promise<string | null>;
  };
  settings: {
    get(): Promise<VaultSettingsDTO>;
    set(patch: Partial<VaultSettingsDTO>): Promise<VaultSettingsDTO>;
  };
  notify(title: string, body: string): Promise<boolean>;
  media: {
    getUrl(dropId: string, kind: 'file' | 'image'): Promise<string | null>;
    /** Fully-read payload bytes for in-page use (drawing scene extraction) — size-capped. */
    getBytes(dropId: string, kind: 'file' | 'image'): Promise<Uint8Array | null>;
  };
  /** Absolute disk path for a renderer-side File (drag-drop). '' when unavailable (clipboard). */
  pathForFile(file: File): string;
  onImportProgress(listener: (progress: ImportProgressDTO) => void): () => void;
  /** Round 118 — download progress push from main (subscribe/unsubscribe). */
  onUpdateProgress(listener: (progress: UpdateProgressDTO) => void): () => void;
  /** In-app fallback event when the OS can't show a reminder notification (spec M6). */
  onNotifyFallback(listener: (payload: { title: string; body: string }) => void): () => void;
  /** DEV-ONLY harness seam — the main process registers this channel ONLY under DROPSYNC_E2E_SIT3. */
  dev?: {
    testOnly(action: string, dropId: string, value?: number): Promise<unknown>;
  };
}
