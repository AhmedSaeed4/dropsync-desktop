import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { VaultStoreProvider, useVaultStore } from './store/vault';
import type { Drop } from './lib/types';
import { FirstRunSetup } from './components/FirstRunSetup';
import { UnlockScreen } from './components/UnlockScreen';
import { SettingsModal } from './components/SettingsModal';
import { ImportModal } from './components/ImportModal';
import { ExportModal } from './components/ExportModal';
import { EditorialHeader } from './components/editorial/EditorialHeader';
import { EditorialStatusPanel } from './components/editorial/EditorialStatusPanel';
import { EditorialThemeSelector } from './components/editorial/EditorialThemeSelector';
import { EditorialDropList } from './components/editorial/EditorialDropList';
import { EditorialPreviewModal } from './components/editorial/EditorialPreviewModal';
import { EditorialDropZone } from './components/editorial/EditorialDropZone';
import { EditorialTextModal, type TextModalCreatePayload, type TextModalEditUpdates } from './components/editorial/EditorialTextModal';
import { getEditorialThemeColors } from './lib/editorialTheme';
import { dropDtoToDrop } from './lib/types';
import { isTextFileDrop, drawingMediaKind } from './lib/dropsHelpers';
import { invalidatePreviewPayload, clearPreviewPayloadCache, putCachedPreviewPayload } from './lib/previewPayloadCache';
import { Toast } from './components/shared/Toast';
import { ModeBadge, type DesktopMode } from './components/ModeBadge';
import { Porch } from './components/Porch';
import { requestModeSwitch } from './lib/modeSwitchGuard';
import type { CreateExpirationOptionDTO, DropDTO, UpdateMetaPatchDTO } from '../../preload/apiTypes';

export default function App() {
  return (
    <VaultStoreProvider>
      <CloudModeShell />
    </VaultStoreProvider>
  );
}

/**
 * C2 — launch is PORCH-FIRST: the porch shows before ANY mode entry (pill memory via
 * localStorage `dropsync.mode.last`, first-ever ⇒ Local). Choosing a mode glides to it:
 * Local re-parents the EXISTING entry branches (FirstRunSetup / UnlockScreen, M7 offer
 * included — internals unchanged, AppBody untouched); Cloud runs the C1 path (mode:set seals
 * the vault when unlocked, then the embedded view). Mid-session switching stays with the
 * badge + the new SettingsModal line and now routes through the unsaved-work guard
 * (lib/modeSwitchGuard) so editors confirm "Discard changes?" before any switch proceeds.
 * Auto-lock still lands on UnlockScreen — never back on the porch. Badge visible in ALL
 * states incl. the porch; cloud view shows through the reserved bottom band as in C1.
 */
function CloudModeShell() {
  const { status, refreshAll } = useVaultStore();
  const [screen, setScreen] = useState<'porch' | 'local' | 'cloud'>('porch');
  const pendingSettingsRef = useRef(false);

  // "Desktop settings" from Cloud: auto-open the existing SettingsModal once Local is back
  // AND the vault is unlocked again (returning always requires the password first).
  useEffect(() => {
    if (screen === 'local' && status === 'unlocked' && pendingSettingsRef.current) {
      pendingSettingsRef.current = false;
      window.dispatchEvent(new CustomEvent('dropsync:open-settings'));
    }
  }, [screen, status]);

  /** Actual transition: main seals/raises/hides; renderer flips + resyncs on Local return. */
  const applyMode = useCallback(
    async (next: DesktopMode): Promise<void> => {
      if (next === screen) return;
      await window.dropsync.mode.set(next);
      setScreen(next);
      if (next === 'local') await refreshAll(); // instant entry-branch resync (status may have flipped)
    },
    [screen, refreshAll]
  );

  /** Guarded switch — if an editor has unsaved changes its OWN discard-confirm runs first
   * and fires the continuation after "Discard"; otherwise we proceed immediately. */
  const switchMode = useCallback(
    (next: DesktopMode): void => {
      requestModeSwitch(() => void applyMode(next));
    },
    [applyMode]
  );

  // SettingsModal "Switch to Cloud" line rides the event bus (same style as open-settings).
  useEffect(() => {
    const h = (): void => switchMode('cloud');
    window.addEventListener('dropsync:request-mode-cloud', h);
    return () => window.removeEventListener('dropsync:request-mode-cloud', h);
  }, [switchMode]);

  // Single root element (display:contents) keeps the boot probe's `rootChildren: 1` contract
  // intact while hosting porch/local/cloud screens plus the fixed-position badge.
  const badge = (
    <ModeBadge
      mode={screen === 'cloud' ? 'cloud' : 'local'}
      onSwitch={() => switchMode(screen === 'cloud' ? 'local' : 'cloud')}
      onOpenSettings={() => {
        pendingSettingsRef.current = screen === 'cloud';
        if (screen === 'cloud') switchMode('local'); // planner ruling: Local first; modal opens after unlock
        else window.dispatchEvent(new CustomEvent('dropsync:open-settings'));
      }}
    />
  );

  if (screen === 'porch') {
    return (
      <div className="contents" data-shell="porch">
        <Porch onEnter={(m) => void applyMode(m)} />
        {badge}
      </div>
    );
  }

  if (screen === 'cloud') {
    return (
      <div className="contents" data-shell="cloud">
        {/* Cloud view covers everything above the notch band; render a quiet filler beneath. */}
        <div className="fixed inset-0 bg-[#FAF7F2]" />
        {badge}
      </div>
    );
  }

  return (
    <div className="contents" data-shell="local">
      <AppBody />
      {badge}
    </div>
  );
}

function AppBody() {
  const store = useVaultStore();
  const {
    status, folder, checking, theme, spaces, currentSpaceId, currentSpaceName,
    categories, drops, loading, settings,
    refreshAll, refreshSpaces, refreshDrops, patchDropInPlace, patchDropsInPlace, appendDropInPlace, removeDropInPlace, upsertCategoryInPlace,
    setCurrentSpace, setTheme, handleUnlocked, handleLocked, startCreateFlow, pickCreateFolder,
    fetchTextPayload, getMediaUrl,
  } = store;
  const tc = getEditorialThemeColors(theme);

  const [showSettings, setShowSettings] = useState(false);
  // C1 — badge menu "Desktop settings" rides this event (see CloudModeShell planner ruling).
  useEffect(() => {
    const open = (): void => setShowSettings(true);
    window.addEventListener('dropsync:open-settings', open);
    return () => window.removeEventListener('dropsync:open-settings', open);
  }, []);
  const [importScope, setImportScope] = useState<'personal' | 'workspace' | null>(null);
  // Export-back target (M5): 'personal' or a workspace id, plus its display name.
  const [exportTarget, setExportTarget] = useState<{ scope: 'personal' | { workspaceId: string }; name: string } | null>(null);
  const [previewDrop, setPreviewDrop] = useState<Drop | null>(null);
  // FIX 18: ref mirror of previewDrop — openEditModal must capture the return context
  // SYNCHRONOUSLY (before its await), exactly like the web's previewDropRef pattern.
  const previewDropRef = useRef<Drop | null>(null);
  previewDropRef.current = previewDrop;
  // FIX 8: the parent no longer fakes preview loading (the hardcoded 400 ms timer is gone).
  // The modal owns REAL loading while a cache-miss payload fetch is in flight.
  const [previewTrail, setPreviewTrail] = useState<Drop[]>([]);
  // Edit modal — holds the drop being edited. Text drops are hydrated with their full payload
  // BEFORE mount (the mention editor seeds from editDrop.content).
  const [editDrop, setEditDrop] = useState<Drop | null>(null);
  // FIX 18: the held PRE-EDIT drop — the return context for the editor. Set only when the edit
  // was launched from the drop's OPEN PREVIEW (the web's ONLY live edit entry; verified in the
  // study phase — the web's card-level handleEdit is dead code, so restore/reopen is scoped to
  // preview-originated edits and right-click edits keep returning to the list).
  const editOriginRef = useRef<Drop | null>(null);
  // YouTube title refresh button state (the app's only online call runs in main, on demand).
  const [refreshingTitles, setRefreshingTitles] = useState(false);
  // Friendly line shown on UnlockScreen when the Create flow finds an existing vault (see
  // pickFolderForCreate below).
  const [unlockNotice, setUnlockNotice] = useState<string | null>(null);
  // Exit door (M7): UnlockScreen picking a folder WITHOUT a vault offers "create one here?".
  const [createHereOffer, setCreateHereOffer] = useState(false);
  // In-app toast fallback when the OS can't show a reminder notification (M6).
  const [notifyToast, setNotifyToast] = useState<{ title: string; body: string } | null>(null);
  const pickingForCreateRef = useRef(false);

  useEffect(() => {
    const off = window.dropsync.onNotifyFallback((payload) => {
      setNotifyToast(payload);
      window.setTimeout(() => setNotifyToast(null), 6000);
    });
    return () => { off(); };
  }, []);

  const currentWorkspace = useMemo(
    () => (currentSpaceId ? spaces.find((s) => s.id === currentSpaceId) ?? null : null),
    [currentSpaceId, spaces]
  );

  /** Pick a folder; the manager remembers it. Flips 'none' ⇄ 'locked' depending on vault presence.
   * Exit door (M7): a folder with NO vault raises the "create one here?" offer on UnlockScreen. */
  const pickFolder = useCallback(async (title: string) => {
    setUnlockNotice(null); // a fresh pick supersedes any stale "vault already lives here" notice
    const picked = await window.dropsync.dialog.pickFolder({ title });
    if (!picked) return;
    const prepared = await window.dropsync.vault.prepareFolder(picked);
    setCreateHereOffer(!prepared.hasVault);
    await refreshAll();
  }, [refreshAll]);

  /** Exit door (M7): same path the idle auto-lock takes — seal the vault and land on UnlockScreen. */
  const handleLockNow = useCallback(async () => {
    setShowSettings(false);
    closePreview();
    setEditDrop(null);
    editOriginRef.current = null;
    setExportTarget(null);
    setImportScope(null);
    await window.dropsync.vault.lock();
    handleLocked();
  }, [handleLocked]);

  /**
   * First-run Create screen: picking a folder only RECORDS it — the user stays on FirstRunSetup
   * with the path in the box, passwords intact, Create enabled (see pickCreateFolder in the
   * store for why this must not refreshAll). Exception: an existing vault in the picked folder
   * intentionally jumps to UnlockScreen with a friendly line.
   */
  const pickFolderForCreate = useCallback(async () => {
    if (pickingForCreateRef.current) return; // double-click safe while the dialog is out
    pickingForCreateRef.current = true;
    try {
      const { picked, hasVault } = await pickCreateFolder();
      if (picked && hasVault) setUnlockNotice('A vault already lives here — unlock it.');
    } finally {
      pickingForCreateRef.current = false;
    }
  }, [pickCreateFolder]);

  const handleCreate = useCallback(async (password: string): Promise<string | null> => {
    let target = folder;
    if (!target) {
      target = await window.dropsync.dialog.pickFolder({ title: 'Choose a folder for your DropSync vault' });
      if (!target) return 'Choose a folder first.';
      await window.dropsync.vault.prepareFolder(target);
    }
    try {
      await window.dropsync.vault.create(target, password);
      await refreshAll();
      await handleUnlocked();
      return null;
    } catch (caught) {
      return caught instanceof Error ? caught.message : 'Could not create the vault.';
    }
  }, [folder, handleUnlocked, refreshAll]);

  const handleUnlock = useCallback(async (password: string): Promise<string | null> => {
    if (!folder) return 'Choose a folder first.';
    try {
      await window.dropsync.vault.unlock(folder, password);
      await handleUnlocked();
      return null;
    } catch (caught) {
      return caught instanceof Error ? caught.message : 'Could not unlock the vault.';
    }
  }, [folder, handleUnlocked]);

  // Preview trail: mention chips push here so ← walks back through A→B→C. FIX 8: no fake
  // loading timer — a cache miss shows the modal's REAL loading; a hit is instant.
  const openPreview = useCallback((drop: Drop) => {
    setPreviewTrail((trail) => [...trail, drop]);
    setPreviewDrop(drop);
  }, []);

  const previewBack = useCallback(() => {
    setPreviewTrail((trail) => {
      const next = trail.slice(0, -1);
      const previous = next[next.length - 1] ?? null;
      setPreviewDrop(previous);
      return previous === null ? [] : next;
    });
  }, []);

  const closePreview = useCallback(() => {
    // FIX 18: a closed preview destroys the editor's return context — a stale origin must
    // never resurrect a preview the user explicitly closed.
    editOriginRef.current = null;
    setPreviewDrop(null);
    setPreviewTrail([]);
  }, []);

  // Edit entry point — two origins (FIX 18 study finding):
  // - Preview-originated (the preview's Edit button; the web's ONLY live edit entry): hold the
  //   pre-edit drop as the return context, keep the preview mounted during payload hydration,
  //   then swap the overlays in ONE state turn so there is no blank interval between modals
  //   (web parity — page.tsx openEditModal inner fn). Closing restores/reopens the preview.
  // - List-originated (desktop-only right-click → Edit, Sitting 2): no preview context exists,
  //   and the web has no such entry point at all — so no restore: closing returns to the list
  //   exactly as before (scope decision flagged in the round report).
  const openEditModal = useCallback(async (drop: Drop) => {
    const origin = previewDropRef.current;
    editOriginRef.current = origin && origin.id === drop.id ? origin : null;
    let source = drop;
    if (drop.type === 'text' && !drop.content) {
      const text = await fetchTextPayload(drop.id).catch(() => '');
      source = { ...drop, content: text };
    }
    if (editOriginRef.current) {
      setPreviewDrop(null);
      setEditDrop(source);
    } else {
      closePreview();
      setEditDrop(source);
    }
  }, [closePreview, fetchTextPayload]);

  /**
   * FIX 18 — web handleEditClose parity (page.tsx ~1297–1306): leaving the editor WITHOUT a
   * save (X/backdrop/Cancel/Esc, discard confirm included) re-opens the edited drop's preview
   * from the held pre-edit object. The payload cache still holds that version (nothing
   * invalidated it), so the restored preview renders INSTANTLY — no skeleton, no re-decrypt.
   * The trail is untouched, so Back history keeps making sense after the return. Net rule:
   * leaving the editor = viewing the drop again; NEVER dumping to the list.
   */
  const handleEditClose = useCallback(() => {
    {
      const w = (import.meta.env.DEV && window.location.search.includes('e2eHooks'))
        ? (window as unknown as { __DC_METRICS?: { seq: { t: number; ev: string }[] } }).__DC_METRICS : undefined;
      w?.seq.push({ t: Date.now(), ev: 'app-handleEditClose' });
    }
    const origin = editOriginRef.current;
    setEditDrop(null);
    editOriginRef.current = null;
    if (!origin) return;
    setPreviewDrop(origin);
  }, []);

  /** FIX 18 — save-path reopen: REPLACE the trail tail instead of pushing (web's reopenPreview
   * never touches dropTrail either), so A→B→edit-B→save lands on B′ with Back still going to A,
   * never to a stale duplicate of B. */
  const reopenSavedPreview = useCallback((d: Drop) => {
    setPreviewTrail((trail) => (trail.length > 0 ? [...trail.slice(0, -1), d] : [d]));
    setPreviewDrop(d);
  }, []);

  /**
   * FIX 18 — prime the payload cache with the SAVED version before reopening the preview
   * (web primes decryptedPreviewCache with savedPreview after loadLatestDrop). Mirrors the
   * preview modal's own fetch matrix exactly, so the reopened modal cache-hits with ZERO
   * loading frame and zero IPC fetches. Per-slot failures resolve null — the modal then pays
   * its normal cold fetch for just that slot (graceful, never blocking).
   */
  const primeSavedPreviewPayload = useCallback(async (saved: Drop, editedContent: string | undefined) => {
    let text = '';
    let fileUrl: string | null = null;
    let imageUrl: string | null = null;
    try {
      if (saved.type === 'text') {
        text = editedContent ?? '';
      } else if (isTextFileDrop(saved)) {
        text = await fetchTextPayload(saved.id).catch(() => '');
      }
      if (saved.type === 'file') fileUrl = await getMediaUrl(saved.id, 'file').catch(() => null);
      if (saved.type === 'text' && !!saved.imageSize && !saved.isDrawing) imageUrl = await getMediaUrl(saved.id, 'image').catch(() => null);
      if (saved.isDrawing) imageUrl = await getMediaUrl(saved.id, drawingMediaKind(saved)).catch(() => null);
      putCachedPreviewPayload(saved.id, { text, fileUrl, imageUrl });
    } catch {
      /* prime failed — the reopened preview falls back to its normal cold fetch */
    }
  }, [fetchTextPayload, getMediaUrl]);

  /**
   * Edit-save routing (mirrors the web's updateTextDrop/updateDropMetadata split):
   * - payload keys (content/image/drawing) + the name/categories riding along → drop:updateContent
   *   (re-encrypt path; expiry/lock/reminder do NOT belong there);
   * - everything else → drop:updateMeta light path (expiry ALWAYS recomputes from NOW,
   *   'forever' ⇒ expiresAt:null; reminder is a pure meta write);
   * - file drops have no payload editor → meta only.
   * Resolves false on failure so the modal stays open with input intact.
   */
  const handleEditDrop = useCallback(async (drop: Drop, updates: TextModalEditUpdates): Promise<boolean> => {
    const u = updates;
    const metaPatch: UpdateMetaPatchDTO = {};
    if (u.expirationOption !== undefined) metaPatch.expirationOption = u.expirationOption as CreateExpirationOptionDTO;
    if (u.locked !== undefined) metaPatch.locked = u.locked;
    if (u.reminderAt !== undefined) {
      metaPatch.reminderAt = u.reminderAt ? u.reminderAt.toISOString() : null;
    }
    try {
      // FIX 9: the mutations RETURN the saved record — consume it and patch the list in place
      // (loading never flips, exactly one card re-renders). refreshDrops stays reserved for
      // structural moments.
      let latest: DropDTO | null = null;
      if (drop.type === 'text') {
        const payloadTouched =
          u.content !== undefined ||
          !!u.pngBytes ||
          !!u.imagePath ||
          (!!u.imageBytes && u.imageBytes.byteLength > 0) ||
          u.imageRemoved === true;
        if (payloadTouched) {
          latest = await window.dropsync.drop.updateContent(drop.id, {
            name: u.name,
            ...(u.content !== undefined ? { content: u.content } : {}),
            categories: u.categories,
            imagePath: u.imagePath ?? null,
            imageBytes: u.imageBytes ?? null,
            imageRemoved: u.imageRemoved === true,
            pngBytes: u.pngBytes ?? null,
          });
        } else {
          if (u.name !== undefined) metaPatch.name = u.name;
          if (u.categories !== undefined) metaPatch.categories = u.categories;
        }
      } else {
        // File drop: name/categories/expiry/lock are all light-path meta.
        if (u.name !== undefined) metaPatch.name = u.name;
        if (u.categories !== undefined) metaPatch.categories = u.categories;
      }
      if (Object.keys(metaPatch).length > 0) {
        latest = await window.dropsync.drop.updateMeta(drop.id, metaPatch);
      }
      if (latest) patchDropInPlace(latest);
      // FIX 8: whatever was cached for this drop is stale by definition after a save.
      invalidatePreviewPayload(drop.id);
      const freshDto = latest ?? await window.dropsync.drop.getMeta(drop.id);
      if (!freshDto) {
        setEditDrop(null);
        return true;
      }
      const savedView = dropDtoToDrop(freshDto);
      if (editOriginRef.current) {
        // FIX 18 — web submit-success tail (page.tsx ~1425–1447): close AFTER save re-opens
        // the preview showing the NEW version instantly — merge into the view-model, PRIME the
        // payload cache with the saved version, then reopen. Zero loading frame, zero fetches.
        await primeSavedPreviewPayload(savedView, u.content);
        editOriginRef.current = null;
        setEditDrop(null);
        reopenSavedPreview(savedView);
      } else {
        // List-originated edit (desktop-only right-click): no preview context to restore.
        setEditDrop(null);
      }
      return true;
    } catch (caught) {
      console.error('Edit failed:', caught);
      return false;
    }
  }, [patchDropInPlace, primeSavedPreviewPayload, reopenSavedPreview]);

  /** FIX 9 rider on category create: upsert just the returned category — no full reload. */
  const handleCreateCategory = useCallback(async (name: string): Promise<string | null> => {
    try {
      const cat = await window.dropsync.vault.createCategory(currentSpaceId ?? 'personal', name);
      upsertCategoryInPlace(cat);
      return cat.name;
    } catch {
      return null;
    }
  }, [currentSpaceId, upsertCategoryInPlace]);

  /** Create workspace (FIX 3) — existing vault:createSpace channel; safe during import/export
   * (every mutation serializes through the main-process queue). Refreshes the spaces list,
   * then switches the current space to the new id. Resolves null on failure. */
  const handleCreateSpace = useCallback(async (name: string): Promise<boolean> => {
    try {
      const space = await window.dropsync.vault.createSpace(name);
      await refreshAll();
      setCurrentSpace(space.id);
      closePreview();
      return true;
    } catch {
      return false;
    }
  }, [refreshAll, setCurrentSpace]);

  /**
   * FIX 19 — rename a workspace inline. The id never changes, so the current selection,
   * mentions and per-space categories/list prefs all stay put; refreshAll() re-reads spaces so
   * every label (header pill, dropdown row) reflects the new name at once.
   * Resolves false on failure so the inline rename row stays open (create-row contract).
   */
  const handleRenameSpace = useCallback(async (id: string, name: string): Promise<boolean> => {
    try {
      await window.dropsync.vault.renameSpace(id, name);
      await refreshAll();
      return true;
    } catch {
      return false;
    }
  }, [refreshAll]);

  /**
   * FIX 19 — delete a workspace (web-parity guard happens in the switcher's confirm step).
   * Overlays are closed FIRST (web closes its modal and useWorkspaces flips current to
   * Personal via switchWorkspace(null)); deleting the CURRENT workspace lands the view on
   * Personal explicitly, exactly like the web. The engine cascades the space's drops +
   * categories through one journal op; blob files sweep at next unlock.
   */
  const handleDeleteSpace = useCallback(async (id: string): Promise<boolean> => {
    closePreview();
    setEditDrop(null);
    editOriginRef.current = null;
    try {
      const ok = await window.dropsync.vault.deleteSpace(id);
      if (!ok) return false;
      if ((currentSpaceId ?? null) === id) {
        setCurrentSpace(null); // web parity: switchWorkspace(null) on delete of current
      }
      await refreshAll();
      return true;
    } catch {
      return false;
    }
  }, [closePreview, currentSpaceId, refreshAll, setCurrentSpace]);

  /**
   * On-demand YouTube title refresh — the app's ONLY internet touchpoint, executed entirely in
   * main (keyless oEmbed, sequential, ≥1s apart, ≤5s timeout). Offline ⇒ silent no-op from main.
   * FIX 9: the handler returns the records whose labels actually changed — patch them in place
   * instead of flipping the whole list to skeleton.
   */
  const handleRefreshTitles = useCallback(async () => {
    if (refreshingTitles) return;
    setRefreshingTitles(true);
    try {
      const result = await window.dropsync.youtube.refreshTitles(currentSpaceId ?? 'personal');
      if (result.updatedDrops?.length) patchDropsInPlace(result.updatedDrops);
    } catch {
      /* silently skipped in main when offline — nothing to surface */
    } finally {
      setRefreshingTitles(false);
    }
  }, [currentSpaceId, patchDropsInPlace, refreshingTitles]);

  /**
   * Structural-change funnel (FIX 13 residual users only: pin, category delete, import
   * completion). DELETES no longer route here — they commit silently via removeDropInPlace.
   * The whole-cache clear moved to the import branch (the one path that can orphan entries);
   * pin/category ops never touch payloads, so clearing there was pure waste.
   */
  const handleDropsChanged = useCallback(() => {
    refreshDrops();
  }, [refreshDrops]);

  /**
   * FIX 10: reminder dismissal patches the list IN PLACE with the engine's returned record —
   * the drop glides out of the promoted tier through the list's layout animations. No reload,
   * no flicker, and the preview modal stays mounted throughout.
   */
  const handlePreviewDismissed = useCallback((updated?: DropDTO) => {
    if (updated) patchDropInPlace(updated);
    else refreshDrops(); // defensive fallback if the patched record was unavailable
  }, [patchDropInPlace, refreshDrops]);

  /**
   * FIX 13 guarantee: if the currently-previewed drop vanishes from the list (deleted, or
   * expired out of a structural refresh), close the preview gracefully instead of leaving a
   * stale modal floating over a ghost. Space switches already close explicitly upstream.
   */
  useEffect(() => {
    if (previewDrop && !drops.some((d) => d.id === previewDrop.id)) {
      closePreview();
    }
  }, [drops, previewDrop, closePreview]);

  // FIX 22b PHASE-2 trace: log editDrop identity flips (dev/e2eHooks boots only).
  // NOTE: must live ABOVE the checking/unlocked early-returns — hooks rules.
  useEffect(() => {
    if (!(import.meta.env.DEV && window.location.search.includes('e2eHooks'))) return;
    const w = (window as unknown as { __DC_METRICS?: { seq: { t: number; ev: string }[] } }).__DC_METRICS;
    if (!w) return;
    w.seq.push({ t: Date.now(), ev: 'app-editDrop:' + (editDrop ? editDrop.id.slice(0, 8) : 'null') });
    if (w.seq.length > 240) w.seq.shift();
  }, [editDrop]);

  if (checking) {
    return (
      <div className={`min-h-screen ${tc.bg} flex items-center justify-center`}>
        <div className="w-8 h-8 border-2 border-[#1a1a1a]/30 border-t-[#1a1a1a] animate-spin rounded-full" />
      </div>
    );
  }

  if (status !== 'unlocked') {
    return status === 'none' ? (
      <FirstRunSetup
        theme={theme}
        folder={folder}
        onPickFolder={() => pickFolderForCreate()}
        onCreate={handleCreate}
        onOpenExisting={() => pickFolder('Choose the folder that contains DropSync.vault')}
      />
    ) : (
      <UnlockScreen
        theme={theme}
        folder={folder}
        notice={unlockNotice}
        createHereOffer={createHereOffer}
        onCreateHere={() => {
          if (createHereOffer) {
            setCreateHereOffer(false);
            startCreateFlow(); // FirstRunSetup with the recorded folder prefilled, passwords empty
          }
        }}
        onCancelCreateHere={() => setCreateHereOffer(false)}
        onPickFolder={() => pickFolder('Choose the folder that contains DropSync.vault')}
        onUnlock={handleUnlock}
      />
    );
  }

  return (
    <div className={`relative flex h-[100dvh] flex-col overflow-x-hidden ${tc.bg} transition-colors duration-500`}>
      <EditorialHeader
        theme={theme}
        onOpenSettings={() => setShowSettings(true)}
        workspaces={spaces.filter((s) => s.id !== 'personal')}
        currentWorkspace={currentWorkspace}
        currentUserId="local"
        onSwitch={(id) => { setCurrentSpace(id); closePreview(); }}
        onPersonalOptions={() => setImportScope('personal')}
        onExportPersonal={() => setExportTarget({ scope: 'personal', name: 'Personal' })}
        onExportWorkspace={(id, name) => setExportTarget({ scope: { workspaceId: id }, name })}
        onCreateSpace={handleCreateSpace}
        onRenameSpace={handleRenameSpace}
        onDeleteSpace={handleDeleteSpace}
      />

      <main id="app-main" className="flex flex-col wide:flex-row flex-1 min-h-0 overflow-y-auto overscroll-contain editorial-scroll-hide wide:overflow-hidden py-6 wide:py-[45px] px-4 sm:px-6 lg:px-[80px] wide:gap-[60px] gap-6">
        {/* Left column: Import card + Status + Theme */}
        <div className={`wide:border-r ${tc.border} wide:overflow-y-auto editorial-scroll-hide wide:min-h-0 wide:pr-5 w-full min-w-0 wide:flex-1 wide:pl-11`}>
          <div className="space-y-6">
            {/* Create — primary action (web layout parity: zone lives in the left/main column) */}
            <EditorialDropZone
              theme={theme}
              spaceId={currentSpaceId ?? 'personal'}
              isWorkspace={!!currentSpaceId}
              customCategories={categories.map((c) => c.name)}
              onCreateCategory={handleCreateCategory}
              editModalOpen={!!editDrop}
              mentionableDrops={drops}
            />

            <section className={`border ${tc.border} ${tc.cardBg} rounded-lg p-5`}>
              <p className={`text-xs ${tc.fontClass} ${tc.muted}`}>Bring your backups in</p>
              <p className={`mt-2 text-sm leading-relaxed ${tc.fontClass} ${tc.muted}`}>
                Import a .dropsync backup from the web app. Timers resume, mentions re-link, and
                everything is encrypted into this vault — fully offline.
              </p>
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={() => setImportScope('personal')}
                  className={`flex-1 rounded-lg px-4 py-2.5 text-sm ${tc.fontClass} bg-[#1a1a1a] text-white transition-colors hover:bg-[#333]`}
                >
                  Import personal backup
                </button>
                <button
                  type="button"
                  onClick={() => setImportScope('workspace')}
                  className={`flex-1 rounded-lg px-4 py-2.5 text-sm ${tc.fontClass} border ${tc.border} ${tc.text} hover:border-[#1a1a1a] transition-colors`}
                >
                  Import workspace
                </button>
              </div>
            </section>

            <div className="flex items-center justify-between gap-2 flex-wrap">
              <EditorialStatusPanel dropsCount={drops.length} theme={theme} />
              {/* On-demand YouTube title fetch (main-process oEmbed; offline ⇒ silent no-op). */}
              <button
                type="button"
                onClick={() => void handleRefreshTitles()}
                disabled={refreshingTitles}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-full border ${tc.border} ${tc.text} hover:border-[#1a1a1a] transition-colors ${tc.fontClass} disabled:opacity-50 disabled:cursor-not-allowed`}
                title="Fetch titles for YouTube links that don't have one cached (online only)"
              >
                {refreshingTitles ? (
                  <span className="w-3 h-3 border border-current/30 border-t-current animate-spin rounded-full" />
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                  </svg>
                )}
                Refresh YouTube titles
              </button>
            </div>
            <EditorialThemeSelector theme={theme} onThemeChange={setTheme} />
          </div>
        </div>

        {/* Right column: Drops list */}
        <div className="shrink-0 wide:overflow-y-auto editorial-scroll-hide wide:min-h-0 w-full wide:w-[520px] wide:min-w-[520px]">
          <EditorialDropList
            drops={drops}
            loading={loading}
            onDelete={handleDropsChanged}
            onPreview={openPreview}
            onEdit={(drop) => void openEditModal(drop)}
            categories={categories}
            theme={theme}
            currentUserId="local"
            currentSpaceKey={currentSpaceId ?? 'personal'}
          />
        </div>
      </main>

      {/* Preview Modal */}
      {previewDrop && (
        <EditorialPreviewModal
          drop={previewDrop}
          onClose={closePreview}
          onBack={previewBack}
          canBack={previewTrail.length > 1}
          theme={theme}
          allDrops={drops}
          onPreview={(drop) => openPreview(drop)}
          onEdit={(drop) => void openEditModal(drop)}
          onChanged={handlePreviewDismissed}
        />
      )}

      {/* Edit Modal — create + edit share EditorialTextModal; edit mode mounts hydrated.
          FIX 18: close (X/backdrop/Cancel/Esc/discard-confirm) routes through handleEditClose —
          a preview-originated edit returns to the drop's PREVIEW instantly; unsaved changes
          restore the pre-edit version, and the discard guard fires before any of it. */}
      {editDrop && (
        <EditorialTextModal
          onClose={handleEditClose}
          onSubmit={async () => {
            /* unreachable in edit mode — the modal routes through onEdit here */
            throw new Error('Create is handled by the upload zone.');
          }}
          onEdit={handleEditDrop}
          theme={theme}
          customCategories={categories.map((c) => c.name)}
          onCreateCategory={handleCreateCategory}
          editDrop={editDrop}
          mentionableDrops={drops.filter((d) => d.id !== editDrop.id)}
          isWorkspace={!!editDrop.workspaceId || !!currentSpaceId}
        />
      )}

      {/* Import Modal */}
      {importScope && settings && (
        <ImportModal
          theme={theme}
          expectedScope={importScope}
          spaces={spaces.map((s) => ({ id: s.id, name: s.name }))}
          currentSpaceName={currentSpaceName}
          onClose={() => setImportScope(null)}
          onImported={(result) => {
            if (result.spaceId && result.spaceId !== 'personal') {
              clearPreviewPayloadCache(); // import = structural (FIX 13 residual contract)
              setCurrentSpace(result.spaceId);
              // FIX 23 — the import created a NEW workspace; refresh the spaces list so the
              // switcher (and the header pill) show it immediately instead of waiting for the
              // next unrelated refresh. Spaces-only: no drops reload, no loading flicker.
              void refreshSpaces();
            } else {
              // Imports are structural moments (many new drops/categories at once) — the full
              // refresh is intentional here, and the cache clear keeps the preview honest.
              clearPreviewPayloadCache();
              handleDropsChanged();
            }
          }}
        />
      )}

      {/* Export Modal (M5 — the return trip home) */}
      {exportTarget && (
        <ExportModal
          theme={theme}
          scope={exportTarget.scope}
          spaceName={exportTarget.name}
          onClose={() => setExportTarget(null)}
        />
      )}

      {/* Settings Modal */}
      {showSettings && settings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onLockNow={() => void handleLockNow()}
          // C2 §2: same guarded path as the badge menu (unsaved-editor confirm included).
          onSwitchToCloud={() => window.dispatchEvent(new CustomEvent('dropsync:request-mode-cloud'))}
          onVaultMoved={() => {
            // FIX 3: the ONLY refresh wired to Settings — a moved vault means a new folder and
            // the shell must re-probe. Every other close path is silent (zero refetch).
            clearPreviewPayloadCache();
            void refreshAll();
          }}
        />
      )}

      {/* In-app fallback when the OS can't show a reminder notification (M6) */}
      {notifyToast && (
        <Toast
          message={`Reminder: ${notifyToast.title}`}
          duration={6}
          theme={theme}
          editorial
          onDone={() => setNotifyToast(null)}
        />
      )}
    </div>
  );
}
