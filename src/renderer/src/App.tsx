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
import { EditorialMoveDropModal } from './components/editorial/EditorialMoveDropModal';
import { EditorialDropZone } from './components/editorial/EditorialDropZone';
import { EditorialTextModal, type TextModalCreatePayload, type TextModalEditUpdates } from './components/editorial/EditorialTextModal';
import { getEditorialThemeColors } from './lib/editorialTheme';
import { dropDtoToDrop } from './lib/types';
import { isTextFileDrop, drawingMediaKind } from './lib/dropsHelpers';
import { invalidatePreviewPayload, clearPreviewPayloadCache, putCachedPreviewPayload, getCachedPreviewPayload } from './lib/previewPayloadCache';
import type { PreviewPayload } from './lib/previewPayloadCache';
import { Toast } from './components/shared/Toast';
import { requestModeSwitch } from './lib/modeSwitchGuard';

/** C2f — desktop mode. (The old bottom-strip badge is gone with the porch.) */
type DesktopMode = 'cloud' | 'local';

/** Memory rule (§2, KEPT EXACTLY from C2): localStorage `dropsync.mode.last`; first-ever launch
 * (absent/corrupt) ⇒ LOCAL. Read BEFORE first paint so boot goes straight into the last mode. */
const MEMORY_KEY = 'dropsync.mode.last';
function readLastMode(): DesktopMode {
  try {
    const v = localStorage.getItem(MEMORY_KEY);
    return v === 'cloud' ? 'cloud' : 'local'; // corrupt/absent ⇒ Local default (§5)
  } catch {
    return 'local';
  }
}
function writeLastMode(mode: DesktopMode): void {
  try {
    localStorage.setItem(MEMORY_KEY, mode);
  } catch { /* storage unavailable — memory simply won't persist */ }
}
import type { CreateExpirationOptionDTO, DropDTO, UpdateMetaPatchDTO } from '../../preload/apiTypes';

export default function App() {
  return (
    <VaultStoreProvider>
      <CloudModeShell />
    </VaultStoreProvider>
  );
}

/**
 * C2f — launch goes STRAIGHT into the last used mode (memory rule above; no porch, no cards,
 * no strip). The mode switcher is the floating pill — its OWN tiny native layer above the site
 * view (src/renderer/pill/), never DOM here. A pill click arrives as `pill:flipRequested` and
 * rides the EXISTING guarded switchMode (unsaved-work discard-confirm included). Cloud = the
 * REAL website full-window, raw; Local = this app exactly as committed. There is NO desktop
 * settings door while IN cloud (accepted trade-off: flip to Local for that).
 */
function CloudModeShell() {
  const { status, handleUnlocked, handleLocked, reconcileStatus } = useVaultStore();
  // Boot: read the memory rule BEFORE first paint and render that mode directly.
  const [screen, setScreen] = useState<DesktopMode>(() => readLastMode());

  // Boot-into-last-mode: when the remembered mode is Cloud, main must raise the site view.
  // (Local needs nothing — the local flow below is exactly as committed.) The pill's knob is
  // set main-side (setPillMode on boot + after every applied mode change).
  useEffect(() => {
    if (screen === 'cloud') void window.dropsync.mode.set('cloud');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boot-only: run once on mount
  }, []);

  /** Actual transition: main raises/hides the site view (and sets the pill knob); NOTHING
   * seals — switching never locks (C2h). The renderer flips its world and the homecoming
   * WHISPER-CHECK below reconciles status ONLY when reality differs from belief. Writes the
   * memory rule (C2 §2 — choice is written on switch). */
  const applyMode = useCallback(
    async (next: DesktopMode): Promise<void> => {
      if (next === screen) return;
      await window.dropsync.mode.set(next);
      setScreen(next);
      writeLastMode(next);
      // C2i FIX B — homecoming WHISPER-CHECK replaces the C1-era forced refreshAll (obsolete
      // once C2h stopped sealing the vault on every flip). One cheap status() round-trip;
      // touch NOTHING unless reality differs from what we believe (vault.status() is
      // ACTIVITY_EXEMPT, so asking cannot feed the idle clock either):
      if (next === 'local') {
        const s = await window.dropsync.vault.status();
        if (s.state !== status) {
          if (s.state === 'unlocked') await handleUnlocked(); // unlocked-but-stale ⇒ hydrate like any unlock path does
          else if (s.state === 'locked') handleLocked(); // idle-lock fired behind Cloud ⇒ instant password screen, ZERO fetches
          else reconcileStatus('none'); // mirror of the 8 s watcher's bare setStatus for non-unlocked worlds
        }
        // Equal state ⇒ strictly NO-OP: no setLoading, no setDropsRaw, no list/category/
        // settings/spaces refetch of any kind — the warm world simply stays as it is.
      }
    },
    [screen, status, handleUnlocked, handleLocked, reconcileStatus]
  );

  /** Guarded switch — if an editor has unsaved changes its OWN discard-confirm runs first
   * and fires the continuation after "Discard"; otherwise we proceed immediately. */
  const switchMode = useCallback(
    (next: DesktopMode): void => {
      requestModeSwitch(() => void applyMode(next));
    },
    [applyMode]
  );

  // C2f FIX 2/3 — the floating pill's flip requests land here and ride the SAME guarded
  // switchMode a keyboard/user path would. (The pill itself never switches anything.)
  useEffect(() => {
    const off = window.dropsync.onPillFlipRequested((next) => switchMode(next));
    return () => { off(); };
  }, [switchMode]);

  // SettingsModal "Switch to Cloud" line rides the event bus (same style as open-settings).
  useEffect(() => {
    const h = (): void => switchMode('cloud');
    window.addEventListener('dropsync:request-mode-cloud', h);
    return () => window.removeEventListener('dropsync:request-mode-cloud', h);
  }, [switchMode]);

  // C2i-hotfix-1 — the inner container is PERMANENT and ALWAYS VISIBLE. The C2i original
  // (cream class only while Cloud + visibility:hidden while Cloud) caused two owner-visible
  // regressions, both measured live (probe: /tmp/c2iflash): (a) main removes the site view
  // SYNCHRONOUSLY during mode.set, but React only flips this container's visibility one
  // renderer round-trip + commit later (+126 ms caught on tape) — the reveal gap painted the
  // page's invisible root over Chromium's default WHITE canvas = the full-screen white flash;
  // (b) a whole-subtree visibility:hidden wake-up repaint + the class-list swing
  // ('' ⇄ 'fixed inset-0…') = the post-arrival "flinch". The site view ALREADY covers Local
  // completely while Cloud is up (native z-order — the same guarantee the pill relies on), so
  // CSS hiding buys nothing and costs both symptoms. World separation stays attr-level only:
  // the outer wrapper's data-shell keeps flipping for probes/state, nothing visual toggles.
  //
  // Hidden-liveness audit (C2i FIX C, still true): an always-mounted AppBody keeps its global
  // listeners (useEscapeClose/EditorialSelect keydown captures, EditorialDropZone paste,
  // EditorialDropList pointerdown, useModalBackClose popstate), yet NONE can misfire while
  // Cloud is up: keyboard focus belongs to the site view after every flip (cloud.ts show()
  // ends with site webContents.focus(); hide() hands it back to the window) and site-input
  // events live in a DIFFERENT webContents that never reaches this DOM. The boot probe's
  // `rootChildren: 1` contract still holds in every mode (one element-child under this
  // contents wrapper, as always).
  return (
    <div className="contents" data-shell={screen}>
      <div className="fixed inset-0 bg-[#FAF7F2]">
        <AppBody />
      </div>
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
  // Round 112b (defect #31): the seed the next preview MOUNT paints from. Web parity — the
  // web's handlePreview hands the primed payload into setPreviewDrop synchronously on a
  // shelf hit (page.tsx:584-600), so the modal's FIRST render already carries content. The
  // desktop modal filled state inside its mount effect, which runs after first paint — the
  // measured one-frame empty pop (investigation 31: 25/25 hit runs, 1-2 empty frames,
  // ~32-48 ms, panel 142->236). Fresh mounts happen at exactly three sites (openPreview,
  // handleEditClose, reopenSavedPreview); each seeds from the CURRENT cache synchronously
  // in the same batch as the mount, so a stale seed can never paint: the id-guard at the
  // render site plus overwrite-before-mount keep any lingering value inert. Seeds ride
  // useState INITIAL values in the modal (EditorialPreviewModal) — trail swaps stay mounted
  // and keep riding the effect exactly as before (measured: no empty frame on swaps).
  const [previewSeed, setPreviewSeed] = useState<{ dropId: string; payload: PreviewPayload } | null>(null);
  const seedPreviewFor = useCallback((drop: Drop) => {
    const payload = getCachedPreviewPayload(drop.id);
    setPreviewSeed(payload ? { dropId: drop.id, payload } : null);
  }, []);
  // FIX 18: ref mirror of previewDrop — openEditModal must capture the return context
  // SYNCHRONOUSLY (before its await), exactly like the web's previewDropRef pattern.
  const previewDropRef = useRef<Drop | null>(null);
  previewDropRef.current = previewDrop;
  // FIX 8: the parent no longer fakes preview loading (the hardcoded 400 ms timer is gone).
  // The modal owns REAL loading while a cache-miss payload fetch is in flight.
  const [previewTrail, setPreviewTrail] = useState<Drop[]>([]);
  // Round 107 (order §4 FIX H.1) — the single-drop move/copy flow: the modal's drops, the
  // preview-return context (a CANCEL re-opens the preview; a move success does NOT — web W3),
  // the in-modal error banner text (web's alert wording, D16) and the busy flag that vetoes
  // every close path.
  const [moveDrops, setMoveDrops] = useState<Drop[] | null>(null);
  const [moveReturnDrop, setMoveReturnDrop] = useState<Drop | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [moveBusy, setMoveBusy] = useState(false);
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
    seedPreviewFor(drop);
    setPreviewTrail((trail) => [...trail, drop]);
    setPreviewDrop(drop);
  }, [seedPreviewFor]);

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

  // Round 107 (order §4 FIX H.4) — the single-drop transfer; mirrors the web's W3 post-op
  // contract EXACTLY (EditorialLayout.tsx handleMoveDrop :288-296 / handleCopyDrop :322-328):
  // pre-flight or per-drop failures keep the modal open with web's alert wording (banner, D16);
  // MOVE success closes the modal and clears the return drop (the drop left this space — the
  // preview does NOT return) and removes the card silently (removeDropInPlace, D9's
  // zero-visual-event contract; NO refreshDrops needed); COPY success closes the modal and
  // re-opens the ORIGINAL's preview (the original still exists here, web :322-328) — the
  // current list gains NOTHING (the copy landed elsewhere): no append, no refresh. The copy's
  // created categories live in the TARGET space; current-space categories are untouched by
  // both verbs (belt: main already refuses same-space transfers).
  const runSingleTransfer = useCallback(async (mode: 'move' | 'copy', targetSpaceId: string) => {
    if (!moveDrops?.length) return;
    setMoveBusy(true);
    try {
      const out = await window.dropsync.drop.transfer({ mode, targetSpaceId, dropIds: moveDrops.map((d) => d.id) });
      if (!out.ok || !out.results) {
        setMoveError(out.error ?? 'Failed to prepare categories. Please try again.');
        return; // modal stays open (web parity, W3)
      }
      const failures = out.results.filter((r) => !r.success);
      if (failures.length > 0) {
        setMoveError(`${failures.length}/${out.results.length} drops failed to ${mode}: ${failures[0].error}`);
        return;
      }
      if (mode === 'move') {
        setMoveDrops(null);
        setMoveError(null);
        setMoveReturnDrop(null); // the drop left this space — no preview return (web :291)
        removeDropInPlace(out.results.map((r) => r.id));
      } else {
        const returnDrop = moveReturnDrop;
        setMoveDrops(null);
        setMoveError(null);
        setMoveReturnDrop(null);
        if (returnDrop) openPreview(returnDrop);
      }
    } catch (error) {
      setMoveError(error instanceof Error ? error.message : String(error));
    } finally {
      setMoveBusy(false);
    }
  }, [moveDrops, moveReturnDrop, openPreview, removeDropInPlace]);

  // Round 107 (order §4 FIX H.5) — close = web's handleCloseMoveModal (:260-266): vetoed while
  // busy; otherwise clear the modal + error, and a preview-originated open RETURNS to the
  // preview (a CANCEL means the drop is still here). Bulk/list flow has no return memory.
  const handleCloseMoveModal = useCallback(() => {
    if (moveBusy) return;
    const returnDrop = moveReturnDrop;
    setMoveDrops(null);
    setMoveError(null);
    setMoveReturnDrop(null);
    if (returnDrop) openPreview(returnDrop);
  }, [moveBusy, moveReturnDrop, openPreview]);

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
    seedPreviewFor(origin);
    setPreviewDrop(origin);
  }, [seedPreviewFor]);

  /** FIX 18 — save-path reopen: REPLACE the trail tail instead of pushing (web's reopenPreview
   * never touches dropTrail either), so A→B→edit-B→save lands on B′ with Back still going to A,
   * never to a stale duplicate of B. */
  const reopenSavedPreview = useCallback((d: Drop) => {
    // Seed AFTER primeSavedPreviewPayload has re-banked the SAVED version (the caller
    // awaits it) — frame 1 must paint the NEW content, never the pre-edit seed (#31).
    seedPreviewFor(d);
    setPreviewTrail((trail) => (trail.length > 0 ? [...trail.slice(0, -1), d] : [d]));
    setPreviewDrop(d);
  }, [seedPreviewFor]);

  /**
   * FIX 18 — prime the payload cache with the SAVED version before reopening the preview
   * (web primes decryptedPreviewCache with savedPreview after loadLatestDrop). Mirrors the
   * preview modal's own fetch matrix exactly, so the reopened modal cache-hits with ZERO
   * loading frame and zero IPC fetches. Per-slot failures resolve null — the modal then pays
   * its normal cold fetch for just that slot (graceful, never blocking).
   *
   * C2f-hotfix-2 — METADATA-ONLY save of a plain text drop: handleEditDrop just ran
   * invalidatePreviewPayload() (the cached copy is stale by definition), and the updateMeta
   * DTO carries no encrypted payload — so `editedContent` is undefined here. Priming an empty
   * string in that case made the reopened preview render a BLANK body on an unconditional
   * cache hit (EditorialPreviewModal :81-87 never falls back on a hit). Instead, fetch the
   * stored text (mirroring openEditModal's guard) so the cache is primed complete. The caller
   * AWAITS this before reopenSavedPreview, so the fetch fires-before-reopen — the instant-
   * render bar (FIX 18) holds with zero loading frame and zero skeleton flash. Drawings are
   * excluded (no text payload; their body rides imageUrl below); FILE drops keep their own
   * existing branch and never take this one.
   */
  const primeSavedPreviewPayload = useCallback(async (saved: Drop, editedContent: string | undefined) => {
    let text = '';
    let fileUrl: string | null = null;
    let imageUrl: string | null = null;
    try {
      if (saved.type === 'text') {
        if (editedContent !== undefined) {
          // Content save: prime with EXACTLY what was saved (regression bar — must stay byte-equal).
          text = editedContent;
        } else if (!saved.isDrawing) {
          text = await fetchTextPayload(saved.id).catch((err) => {
            console.error('[preview-prime] meta-only save could not re-fetch text — reopened preview will be blank:', err);
            return ''; // old behavior as fallback — degraded render, never a hang
          });
        }
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

  // C2f-hotfix-1 DEV fixture (?e2eHooks only): lets the cloud battery open the REAL edit modal
  // for a seeded drop — the exact setEditDrop call the row's Edit action makes (App.tsx onEdit)
  // — and read guard-relevant truth back from the DOM. Dirtying itself is NOT done here: the
  // battery types through the real editor surface (execCommand → native input event), so no
  // React state is ever poked for the action under test.
  //
  // C2f-hotfix-2 additions: openPreview() re-points the REAL preview modal at a seeded drop
  // (same setPreviewDrop the card click makes) and previewState() reads the rendered body back
  // from the DOM (<pre> textContent — absent entirely when the body is blank, which is exactly
  // the meta-only-save symptom). The battery still clicks the REAL 'Edit' button itself so the
  // save→prime→reopen path runs through openEditModal's preview-originated branch.
  useEffect(() => {
    if (!(import.meta.env.DEV && window.location.search.includes('e2eHooks'))) return;
    const w = window as unknown as {
      __c2fEditTest?: {
        open(dropId: string): boolean;
        openPreview(dropId: string): boolean;
        state(): { open: boolean; saveDisabled: boolean | null; typedChars: number; discardConfirmVisible: boolean };
        previewState(): { preText: string | null; editBtnVisible: boolean };
      };
    };
    w.__c2fEditTest = {
      open(dropId: string): boolean {
        const source = drops.find((d) => d.id === dropId);
        if (!source) return false;
        setEditDrop(source);
        return true;
      },
      openPreview(dropId: string): boolean {
        const source = drops.find((d) => d.id === dropId);
        if (!source) return false;
        setPreviewDrop(source);
        return true;
      },
      state() {
        const editor = document.querySelector<HTMLDivElement>('div[contenteditable][role="textbox"]');
        // The edit-mode submit button is disabled ⇔ `isEditMode && !hasChanges` (modal :1180),
        // so its disabled flag IS the hasChanges truth, read from the DOM like a user sees it.
        const saveBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
          .find((b) => b.textContent?.trim() === 'Save changes');
        const discardConfirmVisible = Array.from(document.querySelectorAll('p'))
          .some((el) => el.textContent?.trim() === 'Discard changes?');
        return {
          open: !!editor,
          saveDisabled: saveBtn ? saveBtn.disabled : null,
          typedChars: editor ? (editor.textContent || '').replace(/\u200B/g, '').length : -1,
          discardConfirmVisible,
        };
      },
      previewState() {
        const pre = document.querySelector('pre');
        const editBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
          .find((b) => b.textContent?.trim() === 'Edit');
        return { preText: pre ? pre.textContent : null, editBtnVisible: !!editBtn };
      },
    };
  }, [drops, editDrop]);

  if (checking) {
    return (
      <div className={`min-h-screen ${tc.bg} flex items-center justify-center`}>
        <div className="w-8 h-8 border-2 border-[#1a1a1a]/30 border-t-[#1a1a1a] animate-spin rounded-full" />
      </div>
    );
  }

  if (status !== 'unlocked') {
    // C2f: Local renders DIRECT full-window exactly as these components always have (the C2b
    // porch portal slot is gone; no component needed any porch-only props).
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

      {/* #34 layout parity: on the web the always-rendered zero-width chat panel adds a
          second wide:gap-[60px] on the right (EditorialLayout.tsx:614 + :520), so the web's
          drops column and header buttons both end 140px from the window edge. The desktop has
          no chat panel, so the right column carries wide:mr-[60px] — 80px page padding + 60px
          = the web's 140. 115-HOTFIX-1: a wide:pr-[140px] token on this main CANNOT do the
          job — TW4 emits padding-right:140px BEFORE padding-inline:80px, and the later
          padding-inline wins the cascade (proven by CDP stylesheet scan, %TEMP%\f115\,
          2026-09-17); margin-* never interacts with padding-*. */}
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
        <div className="shrink-0 wide:overflow-y-auto editorial-scroll-hide wide:min-h-0 w-full wide:w-[520px] wide:min-w-[520px] wide:mr-[60px]">
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
          seed={previewSeed && previewSeed.dropId === previewDrop.id ? previewSeed.payload : null}
          onClose={closePreview}
          onBack={previewBack}
          canBack={previewTrail.length > 1}
          theme={theme}
          allDrops={drops}
          onPreview={(drop) => openPreview(drop)}
          onEdit={(drop) => void openEditModal(drop)}
          // Round 107 (order §4 FIX H.2) — store the return context, open the move modal with
          // this drop, and close the preview with the SAME primitive the FIX 18 edit flow uses
          // to close/reopen safely (D10). The freshest viewed version rides along (web :521).
          onMove={(drop) => {
            setMoveReturnDrop(drop);
            setMoveDrops([drop]);
            closePreview();
          }}
          onChanged={handlePreviewDismissed}
        />
      )}

      {/* Move/Copy Modal (round 107, order §4 FIX H.3) — hosted next to the preview host. */}
      {moveDrops && moveDrops.length > 0 && (
        <EditorialMoveDropModal
          drops={moveDrops}
          onMove={(t) => runSingleTransfer('move', t)}
          onCopy={(t) => runSingleTransfer('copy', t)}
          onClose={handleCloseMoveModal}
          error={moveError}
          theme={theme}
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
