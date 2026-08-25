/**
 * Desktop port of the web's EditorialTextModal — create + edit share the component.
 *
 * Stripped per spec (Sitting 2): the entire call mode (no CallStartScreen/MediaStream props),
 * voice-to-text (no MediaRecorder/transcription), and every tier gate (∞ is freely choosable,
 * no ForeverLockedModal). Firebase decryption becomes media:// URLs fetched through the bridge.
 *
 * Desktop deltas:
 * - Attached images travel as imagePath (dialog/drag sources with a real disk path) or
 *   imageBytes (clipboard pastes — cross IPC exactly once); drawings as pngBytes
 *   (exportEmbedScene PNG from DrawingCanvas).
 * - Edit mode expects editDrop.content ALREADY hydrated by the caller (the payload fetch
 *   happens before mount) so the mention editor seeds with the full text.
 * - Empty drawing (zero non-deleted elements) blocks save with an inline hint (spec edge case).
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import type { Drop, ExpirationOption } from '../../lib/types';
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock';
import { useModalBackClose } from '../../hooks/useModalBackClose';
import { MODE_SWITCH_EVENT, type ModeSwitchDetail } from '../../lib/modeSwitchGuard';
import { useEscapeClose } from '../../hooks/useEscapeClose';
import { getEditorialThemeColors } from '../../lib/editorialTheme';
import { dedupeCategoryNames } from '../../lib/categories';
import { DrawingCanvas, BG_COLORS } from '../DrawingCanvas';
import { EditorialDropPickerRow } from './EditorialDropPickerRow';
import { useMentionEditor } from '../../hooks/useMentionEditor';
import { useReminder, REMINDER_PRESETS } from '../../hooks/useReminder';
import { useNow } from '../../hooks/useNow';
import { getExpirationDate, formatReminderFire, drawingMediaKind } from '../../lib/dropsHelpers';
import type { ReminderUnit } from '../../lib/dropsHelpers';
import { useVaultStore } from '../../store/vault';
import { EditorialSelect } from './EditorialSelect';
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';

/** Everything drop:createText needs — built by the parent from this modal's payload. */
export interface TextModalCreatePayload {
  name: string;
  content: string;
  expirationOption: ExpirationOption;
  categories: string[];
  imagePath?: string | null;
  imageBytes?: Uint8Array | null;
  pngBytes?: Uint8Array | null;
  locked: boolean;
  reminderAt: Date | null;
}

/**
 * Edit updates — routed by the parent: payload keys (content/image/pngBytes, plus name/
 * categories when a payload change carries them) go through drop:updateContent; everything
 * else goes through drop:updateMeta (expiry recomputes from NOW there).
 */
export interface TextModalEditUpdates {
  name?: string;
  content?: string;
  categories?: string[];
  expirationOption?: ExpirationOption;
  imagePath?: string | null;
  imageBytes?: Uint8Array | null;
  imageRemoved?: boolean;
  pngBytes?: Uint8Array | null;
  locked?: boolean;
  reminderAt?: Date | null;
}

interface EditorialTextModalProps {
  onSubmit: (payload: TextModalCreatePayload) => Promise<void>;
  onClose: () => void;
  theme?: 'light' | 'dark' | 'minimal';
  customCategories?: string[];
  onCreateCategory?: (name: string) => Promise<string | null>;
  editDrop?: Drop | null;
  onEdit?: (drop: Drop, updates: TextModalEditUpdates) => Promise<boolean>;
  /** Drops in the current space for the #-mention autocomplete. */
  mentionableDrops?: Drop[];
  /** Create flow inside a shared space — shows the Open/Locked toggle (web parity rule). */
  isWorkspace?: boolean;
}

const EXPIRATION_OPTIONS: { value: ExpirationOption; label: string }[] = [
  { value: '1h', label: '1 hour' },
  { value: '2h', label: '2 hours' },
  { value: '6h', label: '6 hours' },
  { value: '24h', label: '24 hours' },
  { value: 'forever', label: 'Forever' },
];

const BUILT_IN_CATEGORIES = [
  { value: 'password', label: 'Password' },
  { value: 'link', label: 'Link' },
];

export function EditorialTextModal({
  onSubmit,
  onClose,
  theme = 'light',
  customCategories = [],
  onCreateCategory,
  editDrop,
  onEdit,
  mentionableDrops = [],
  isWorkspace = false,
}: EditorialTextModalProps) {
  useBodyScrollLock();
  const { getMediaUrl, getMediaBytes } = useVaultStore();
  const isEditMode = !!editDrop;
  const isFileDrop = isEditMode && editDrop?.type === 'file';

  const [name, setName] = useState(editDrop?.name || '');
  const [content, setContent] = useState(editDrop?.content || '');
  const [loading, setLoading] = useState(false);
  const [expiration, setExpiration] = useState<ExpirationOption>(editDrop?.expirationOption || '2h');
  // Open/Locked toggle — create mode inside a shared space, or any edit-mode drop in one
  // (the local user can always mutate their own vault's drops).
  const showLockToggle = (!isEditMode && isWorkspace) || (isEditMode && !!editDrop?.workspaceId);
  const [locked, setLocked] = useState(false);
  // Edit mode seeds the toggle from the drop being edited; create mode keeps the Open default.
  useEffect(() => {
    if (isEditMode && editDrop) {
      setLocked(editDrop.locked ?? false);
    }
  }, [isEditMode, editDrop]);

  const [selectedCategories, setSelectedCategories] = useState<string[]>(
    editDrop?.categories || (editDrop?.category ? [editDrop.category] : [])
  );
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [customCategoryName, setCustomCategoryName] = useState('');
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  const [attachedImage, setAttachedImage] = useState<File | null>(null);
  // Real disk path when the File has one (input pick / OS drag). Clipboard pastes have none —
  // those cross IPC as bytes instead.
  const [attachedImagePath, setAttachedImagePath] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [existingImageUrl, setExistingImageUrl] = useState<string | null>(null);
  const [imageRemoved, setImageRemoved] = useState(false);
  const [decryptingImage, setDecryptingImage] = useState(false);

  const imageInputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'text' | 'draw'>(
    isEditMode && editDrop?.isDrawing ? 'draw' : 'text'
  );

  const [bgColor, setBgColor] = useState('#ffffff');
  const [hasDrawn, setHasDrawn] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  // Unsaved-changes close guard: X/backdrop/Cancel/hardware-back route through handleClose, which
  // confirms ("Discard changes?") before actually closing when anything changed in edit mode.
  const [showCloseDiscardConfirm, setShowCloseDiscardConfirm] = useState(false);
  // C2 unsaved-work guard: a MODE SWITCH requested while dirty routes through THIS SAME
  // dialog; the switch continuation fires right after "Discard" closes the modal
  // (lib/modeSwitchGuard contract — no silent loss, no duplicate confirm UI).
  const pendingModeSwitchRef = useRef<(() => void) | null>(null);
  // Desktop: the exported drawing rides as raw PNG bytes (they cross IPC once into the vault).
  const [drawingBytes, setDrawingBytes] = useState<Uint8Array | null>(null);
  // Spec edge case: zero non-deleted elements ⇒ block save with an inline hint.
  const elementCountRef = useRef(0);
  const [emptyDrawingHint, setEmptyDrawingHint] = useState(false);
  const [initialScene, setInitialScene] = useState<{
    elements: ExcalidrawElement[];
    appState: Partial<AppState>;
    files?: BinaryFiles;
  } | null>(null);
  const [extractingScene, setExtractingScene] = useState(isEditMode && !!editDrop?.isDrawing);

  // FIX 22b PHASE-2 trace (dev/e2eHooks boots only, zero prod impact): which modal state
  // transition removes the drawing canvas on a toolbar font click?
  useEffect(() => {
    const wTrace = () => (import.meta.env.DEV && window.location.search.includes('e2eHooks')
      ? (window as unknown as { __DC_METRICS?: { seq: { t: number; ev: string }[] } }).__DC_METRICS
      : undefined);
    wTrace()?.seq.push({ t: Date.now(), ev: 'modal-mount' });
    return () => { wTrace()?.seq.push({ t: Date.now(), ev: 'modal-unmount' }); };
  }, []);
  useEffect(() => {
    if (!(import.meta.env.DEV && window.location.search.includes('e2eHooks'))) return;
    const w = (window as unknown as { __DC_METRICS?: { seq: { t: number; ev: string }[] } }).__DC_METRICS;
    if (!w) return;
    w.seq.push({ t: Date.now(), ev: 'modal-state:' + mode + '/' + String(extractingScene) + '/id:' + (editDrop?.id || '-') });
    if (w.seq.length > 240) w.seq.shift();
  }, [mode, extractingScene, editDrop]);

  // Load existing image for edit mode — media:// URL through the bridge (no Firebase decrypt).
  useEffect(() => {
    if (!isEditMode || !editDrop || !editDrop.imageSize) return;
    let cancelled = false;
    setDecryptingImage(true);
    getMediaUrl(editDrop.id, 'image')
      .then((url) => {
        if (!cancelled && url) setExistingImageUrl(url);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setDecryptingImage(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditMode, editDrop?.id]);

  // Build the editor's initial scene for a drawing drop (FIX 20):
  // 1. SCENE PREFERENCE — when the record carries a manifest `drawingScene` (web imports),
  //    build the initial scene from THAT JSON via loadFromBlob(application/json): the exact
  //    restore pipeline the PNG path uses, with ZERO payload byte fetches and no pixel parse.
  //    Covers web drops whose PNG may lack an embedded scene entirely.
  // 2. FALLBACK — otherwise fetch the PNG through the shared slot resolver (file-first,
  //    image-fallback — FIX 20 slot truth) and parse its embedded scene exactly as before.
  // Extraction failure ⇒ empty editor + console warn (web parity — never crashes).
  useEffect(() => {
    if (!isEditMode || !editDrop?.isDrawing) return;
    let cancelled = false;
    setExtractingScene(true);
    void (async () => {
      // Bytes come through the size-capped media:getBytes IPC (Chromium scheme-blocks fetch()
      // on custom protocols, so media:// URLs only feed <img>/<video> tags).
      const adoptScene = (
        scene: { elements: ExcalidrawElement[]; appState: Partial<AppState>; files?: BinaryFiles },
      ) => {
        if (cancelled) return;
        // FIX 21 central guard (both paths): Excalidraw's InteractiveCanvas calls
        // .forEach on appState.collaborators during render, but a scene that crossed JSON
        // (web importer's extractDrawingScene round-trip) carries it as a plain {}. Coerce to
        // a Map before anything consumes the scene — covers the fallback PNG/loadFromBlob
        // path too, against any future shape.
        if (!(scene.appState?.collaborators instanceof Map)) {
          scene.appState.collaborators = new Map();
        }
        setInitialScene({
          elements: [...scene.elements],
          appState: scene.appState as Partial<AppState>,
          files: scene.files || undefined,
        });
        if ((scene.appState as { viewBackgroundColor?: string })?.viewBackgroundColor) {
          setBgColor((scene.appState as { viewBackgroundColor: string }).viewBackgroundColor);
        }
      };
      try {
        const manifestScene = editDrop.drawingScene as
          | { elements?: unknown; appState?: Record<string, unknown> }
          | null
          | undefined;
        if (manifestScene && Array.isArray(manifestScene.elements)) {
          // FIX 21a whitelist: persisted appState is JSON-round-tripped runtime state (the web
          // importer stores scene.appState wholesale), and raw runtime fields crash Excalidraw
          // at render (#21: collaborators.forEach). Only viewBackgroundColor is ever consumed
          // downstream — copy it through ONLY when it is a sane color string; every other key
          // is dropped. Elements keep going through restore() normalization unchanged, still
          // with ZERO payload byte fetches.
          const rawAppState = (manifestScene.appState ?? {}) as Record<string, unknown>;
          const safeAppState: Record<string, unknown> = {};
          const bgRaw = rawAppState.viewBackgroundColor;
          if (
            typeof bgRaw === 'string' && bgRaw.length <= 32 &&
            (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(bgRaw) || bgRaw === 'transparent')
          ) {
            safeAppState.viewBackgroundColor = bgRaw;
          }
          // Excalidraw's restore path: accepts the manifest's bare { elements, appState }
          // blueprint directly (the exact shape web exports carry) and normalizes every
          // element to full runtime fidelity — still ZERO payload byte fetches.
          const { restore } = await import('@excalidraw/excalidraw');
          const restored = restore(
            {
              elements: manifestScene.elements as never,
              appState: safeAppState as never,
            },
            null,
            null,
          );
          adoptScene(restored as unknown as { elements: ExcalidrawElement[]; appState: Partial<AppState>; files?: BinaryFiles });
          return;
        }
        const bytes = await getMediaBytes(editDrop.id, drawingMediaKind(editDrop));
        if (!bytes) throw new Error('drawing payload unavailable');
        const { loadFromBlob } = await import('@excalidraw/excalidraw');
        const scene = await loadFromBlob(new Blob([bytes as BlobPart], { type: 'image/png' }), null, null);
        adoptScene(scene);
      } catch (err) {
        console.warn('No scene data in drawing:', err);
      } finally {
        if (!cancelled) setExtractingScene(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditMode, editDrop?.id]);

  const tc = getEditorialThemeColors(theme);

  // In-app reminder cap (web parity): EDIT mode caps at the drop's CONCRETE expiry — unless the
  // user just switched to a fresh option window. CREATE passes undefined (hook derives from the
  // option). 'forever' ⇒ no cap.
  const reminderCap: Date | null | undefined = !isEditMode
    ? undefined
    : expiration === 'forever'
      ? null
      : expiration === editDrop?.expirationOption
        ? (editDrop?.expiresAt ?? null)
        : getExpirationDate(expiration);
  const {
    reminderEnabled, reminderPreset, reminderCustomValue, reminderCustomUnit,
    reminderAt: reminderAtValue, reminderInvalid: reminderInvalidValue, warning: reminderWarningValue,
    setReminderEnabled, setReminderPreset, setReminderCustomValue, setReminderCustomUnit,
    pickerActive, reminderDirty,
  } = useReminder(expiration, reminderCap, editDrop?.reminderAt);
  const now = useNow();
  const reminderFire = reminderEnabled && !reminderInvalidValue && reminderAtValue
    ? formatReminderFire(reminderAtValue, now)
    : null;

  // contentEditable mention editor — renders #[Name](id) tokens as inline chips while typing,
  // but keeps `content` as the plain token string (encrypt/save round-trip unchanged).
  const mentionChipBase = `inline-flex items-center mx-0.5 my-0.5 px-1.5 py-0.5 align-middle rounded text-[13px] ${tc.fontClass}`;
  const mention = useMentionEditor({
    content,
    setContent,
    allDrops: mentionableDrops,
    excludeDropId: editDrop?.id,
    foundClassName: `${mentionChipBase} ${tc.activePillBg} ${tc.activePillText}`,
    deletedClassName: `${mentionChipBase} ${tc.inactivePillBg} ${tc.muted} line-through cursor-not-allowed`,
  });

  // Reproduce the old textarea's autoFocus on the contentEditable editor.
  useEffect(() => {
    mention.editorRef.current?.focus();
    // editorRef is a stable ref object; we only want this to run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleCategory = (cat: string) => {
    setSelectedCategories(prev => {
      if (prev.includes(cat)) return prev.filter(c => c !== cat);
      if (prev.length >= 3) return prev;
      return [...prev, cat];
    });
  };

  // Reads a picked File into bytes — only for clipboard-origin images with no disk path
  // (they cross IPC exactly once, same rule as drop:createFileFromBytes).
  const readFileBytes = (file: File): Promise<Uint8Array> =>
    file.arrayBuffer().then((b) => new Uint8Array(b));

  const trimmedCategoryLower = customCategoryName.trim().toLowerCase();
  const isDuplicateCategoryName =
    trimmedCategoryLower !== '' &&
    (customCategories.some((c) => c.trim().toLowerCase() === trimmedCategoryLower) ||
      BUILT_IN_CATEGORIES.some((b) => b.value === trimmedCategoryLower));

  const handleCreateCustomCategory = async () => {
    if (!customCategoryName.trim()) return;
    if (!onCreateCategory) return;

    setCreatingCategory(true);
    try {
      const newCategory = await onCreateCategory(customCategoryName.trim());
      if (newCategory) {
        if (selectedCategories.length < 3) {
          setSelectedCategories(prev => [...prev, newCategory]);
        }
        setShowCustomInput(false);
        setCustomCategoryName('');
      }
    } catch (error) {
      console.error('Error creating category:', error);
    }
    setCreatingCategory(false);
  };

  // Single shared ingest for input-pick / OS-drag / clipboard-paste images.
  const ingestImageFile = (file: File) => {
    if (!file.type.startsWith('image/')) return;
    let path: string | null = null;
    try {
      path = window.dropsync.pathForFile(file) || null;
    } catch {
      path = null;
    }
    setAttachedImage(file);
    setAttachedImagePath(path);
    setImageRemoved(false);
    setExistingImageUrl(null);
    const reader = new FileReader();
    reader.onload = (ev) => setImagePreview(ev.target?.result as string);
    reader.readAsDataURL(file);
  };

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    ingestImageFile(file);
    if (imageInputRef.current) imageInputRef.current.value = '';
  };

  const removeImage = () => {
    setAttachedImage(null);
    setAttachedImagePath(null);
    setImagePreview(null);
    // If there was an existing image and user selects then removes a new one, restore existing state
    if (existingImageUrl) {
      setImageRemoved(false);
    }
  };

  const removeExistingImage = () => {
    setExistingImageUrl(null);
    setImageRemoved(true);
  };

  const hasChanges = isEditMode && editDrop ? (
    name.trim() !== (editDrop.name || '') ||
    JSON.stringify([...selectedCategories].sort()) !== JSON.stringify((editDrop.categories || (editDrop.category ? [editDrop.category] : [])).slice().sort()) ||
    expiration !== editDrop.expirationOption ||
    (!isFileDrop && content !== (editDrop.content || '')) ||
    !!attachedImage ||
    imageRemoved ||
    !!drawingBytes ||
    locked !== (editDrop.locked ?? false) ||
    reminderDirty
  ) : true;

  // Single close entry point for X / backdrop / Cancel / hardware-back (and the drawing-cancel
  // path in edit mode). With unsaved edits, confirm with the theme-consistent discard dialog;
  // without changes, close straight back (the parent re-opens the preview either way).
  const handleClose = () => {
    {
      const w = (import.meta.env.DEV && window.location.search.includes('e2eHooks'))
        ? (window as unknown as { __DC_METRICS?: { seq: { t: number; ev: string }[] } }).__DC_METRICS : undefined;
      w?.seq.push({ t: Date.now(), ev: 'modal-handleClose' });
    }
    if (loading) return;
    if (isEditMode && hasChanges) {
      setShowCloseDiscardConfirm(true);
      return;
    }
    onClose();
  };
  // Keep the edit guard disabled while the nested discard dialog owns the back button. Toggling the
  // primary hook's open flag makes it re-register after a popstate already removed its entry.
  useModalBackClose(!showCloseDiscardConfirm, handleClose);
  useModalBackClose(showCloseDiscardConfirm, () => setShowCloseDiscardConfirm(false));
  // Esc mirrors the same routing (polish sweep #3): discard dialog first, else the guarded close.
  useEscapeClose(!showCloseDiscardConfirm, handleClose);
  useEscapeClose(showCloseDiscardConfirm, () => setShowCloseDiscardConfirm(false));
  // C2: intercept mode switches while dirty — preventDefault() tells the requester the guard
  // took over; the continuation is stashed and fired by the Discard button below.
  useEffect(() => {
    const onRequest = (e: Event): void => {
      const ce = e as CustomEvent<ModeSwitchDetail>;
      if (!(isEditMode && hasChanges)) return;
      ce.preventDefault();
      pendingModeSwitchRef.current = ce.detail.proceed;
      setShowCloseDiscardConfirm(true);
    };
    window.addEventListener(MODE_SWITCH_EVENT, onRequest);
    return () => window.removeEventListener(MODE_SWITCH_EVENT, onRequest);
  }, [isEditMode, hasChanges]);

  const handleModeSwitch = (newMode: 'text' | 'draw') => {
    if (newMode === mode) return;
    if (mode === 'draw' && hasDrawn) {
      setShowDiscardConfirm(true);
      return;
    }
    setMode(newMode);
    setDrawingBytes(null);
    setHasDrawn(false);
    setEmptyDrawingHint(false);
  };

  const confirmDiscard = () => {
    setShowDiscardConfirm(false);
    setMode('text');
    setDrawingBytes(null);
    setHasDrawn(false);
    setEmptyDrawingHint(false);
  };

  const handleDrawingSave = (bytes: Uint8Array) => {
    // Spec edge case: an empty drawing (zero non-deleted elements) never attaches — inline hint.
    if (elementCountRef.current === 0) {
      setEmptyDrawingHint(true);
      return;
    }
    setEmptyDrawingHint(false);
    setDrawingBytes(bytes);
    setHasDrawn(false);
    setMode('text');
  };

  const handleDrawingCancel = () => {
    if (isEditMode && editDrop?.isDrawing) {
      handleClose();
      return;
    }
    setMode('text');
    setHasDrawn(false);
    setEmptyDrawingHint(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    // Empty content is only allowed when a drawing rides along (create) or when editing an
    // existing drawing whose PNG is the payload (edit-drawing meta-only saves stay valid).
    if (!isFileDrop && !content.trim() && !drawingBytes && !(isEditMode && !!editDrop?.isDrawing)) return;
    // The submit button is disabled while the reminder is invalid; guard anyway so a keyboard
    // submit can't slip a bad reminder through.
    if (reminderEnabled && reminderInvalidValue) return;

    setLoading(true);
    // Payload resolution order mirrors the web: a fresh drawing wins over an attached image.
    // Images with a real disk path stream from disk in main; clipboard pastes cross as bytes.
    let imagePathArg: string | null | undefined;
    let imageBytesArg: Uint8Array | undefined;
    if (!isFileDrop && !drawingBytes && attachedImage) {
      if (attachedImagePath) {
        imagePathArg = attachedImagePath;
      } else {
        try {
          imageBytesArg = await readFileBytes(attachedImage);
        } catch {
          imageBytesArg = undefined;
        }
      }
    }
    try {
      if (isEditMode && editDrop && onEdit) {
        await onEdit(editDrop, {
          name: name.trim() || editDrop.name,
          ...(!isFileDrop && content !== (editDrop.content || '') ? { content } : {}),
          categories: selectedCategories,
          expirationOption: expiration,
          ...(!isFileDrop
            ? {
                ...(drawingBytes ? { pngBytes: drawingBytes } : {}),
                ...(imagePathArg ? { imagePath: imagePathArg } : {}),
                ...(imageBytesArg ? { imageBytes: imageBytesArg } : {}),
                imageRemoved,
              }
            : {}),
          locked,
          // Final reminder state, so the parent can persist it before reopening the preview.
          ...(reminderDirty && !reminderInvalidValue
            ? reminderEnabled
              ? { reminderAt: reminderAtValue }
              : { reminderAt: null }
            : {}),
        });
      } else {
        await onSubmit({
          name: name.trim(),
          content,
          expirationOption: expiration,
          categories: selectedCategories,
          ...(drawingBytes
            ? { pngBytes: drawingBytes }
            : imagePathArg
              ? { imagePath: imagePathArg }
              : imageBytesArg
                ? { imageBytes: imageBytesArg }
                : {}),
          locked,
          reminderAt: reminderEnabled && !reminderInvalidValue ? reminderAtValue : null,
        });
      }
    } finally {
      setLoading(false);
    }
  };

  const fullscreenIcon = isFullscreen ? (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
    </svg>
  ) : (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
    </svg>
  );

  return (
    <div
      className="fixed inset-0 bg-[#1a1a1a]/60 z-50 transition-colors duration-300 overscroll-contain overflow-y-auto flex items-start sm:items-center justify-center p-4 pt-[env(safe-area-inset-top,16px)] pb-[env(safe-area-inset-bottom,16px)] min-h-screen min-h-[100dvh]"
      onClick={(e) => e.target === e.currentTarget && handleClose()}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const file = e.dataTransfer.files[0];
        if (file) ingestImageFile(file);
      }}
      onPaste={(e) => {
        const items = e.clipboardData.items;
        for (let i = 0; i < items.length; i++) {
          if (items[i].type.startsWith('image/')) {
            e.stopPropagation();
            e.preventDefault();
            const file = items[i].getAsFile();
            if (file) ingestImageFile(file);
            break;
          }
        }
      }}
    >
      <div className={`${tc.bg} border ${tc.border} rounded-xl w-full max-w-lg my-4 sm:my-auto max-h-[80vh] sm:max-h-[90vh] flex flex-col overflow-hidden transition-colors duration-300 shadow-xl`}>
        {/* Header */}
        <div className={`border-b ${tc.border} px-5 py-4 flex items-center justify-between`}>
          <h2 className={`${tc.fontClass} ${tc.text} font-medium text-[15px]`}>
            {isFileDrop ? 'Edit file' : isEditMode ? 'Edit drop' : 'Add text snippet'}
          </h2>
          <button
            onClick={handleClose}
            disabled={loading}
            className={`${tc.muted} hover:${tc.text} transition-colors p-1 disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col min-h-0 flex-1">
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            {/* Category Selection */}
            <div>
              <label className={`block text-xs ${tc.muted} ${tc.fontClass} mb-2`}>
                Categories <span className="opacity-50">(max 3)</span>
              </label>
              {!showCustomInput ? (
                <div className="flex flex-wrap gap-2">
                  {BUILT_IN_CATEGORIES.map((cat) => (
                    <button
                      key={cat.value}
                      type="button"
                      onClick={() => toggleCategory(cat.value)}
                      disabled={!selectedCategories.includes(cat.value) && selectedCategories.length >= 3}
                      className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${tc.fontClass} disabled:opacity-30 ${
                        selectedCategories.includes(cat.value)
                          ? `${tc.activePillBg} ${tc.activePillText} border-[#1a1a1a]`
                          : `${tc.border} ${tc.text} hover:border-[#1a1a1a]`
                      }`}
                    >
                      {cat.label}
                    </button>
                  ))}
                  {dedupeCategoryNames(customCategories).map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => toggleCategory(cat)}
                      disabled={!selectedCategories.includes(cat) && selectedCategories.length >= 3}
                      className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${tc.fontClass} disabled:opacity-30 ${
                        selectedCategories.includes(cat)
                          ? `${tc.activePillBg} ${tc.activePillText} border-[#1a1a1a]`
                          : `${tc.border} ${tc.text} hover:border-[#1a1a1a]`
                      }`}
                    >
                      {cat}
                    </button>
                  ))}
                  {onCreateCategory && (
                    <button
                      type="button"
                      onClick={() => setShowCustomInput(true)}
                      className={`px-3 py-1.5 text-xs rounded-full border ${tc.border} ${tc.text} hover:border-[#1a1a1a] transition-colors flex items-center gap-1 ${tc.fontClass}`}
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                      </svg>
                      Custom
                    </button>
                  )}
                </div>
              ) : (
                <>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    value={customCategoryName}
                    onChange={(e) => setCustomCategoryName(e.target.value)}
                    placeholder="Category name..."
                    className={`flex-1 border ${tc.border} ${tc.bg} ${tc.text} px-3 py-2 text-sm rounded-lg focus:outline-none focus:border-[#1a1a1a] transition-colors ${tc.fontClass}`}
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={handleCreateCustomCategory}
                      disabled={!customCategoryName.trim() || creatingCategory || isDuplicateCategoryName}
                      className={`flex-1 sm:flex-none px-3 py-2 ${tc.activePillBg} ${tc.activePillText} text-xs rounded-full hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity ${tc.fontClass}`}
                    >
                      {creatingCategory ? '...' : 'Add'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowCustomInput(false);
                        setCustomCategoryName('');
                      }}
                      className={`flex-1 sm:flex-none px-3 py-2 border ${tc.border} ${tc.text} text-xs rounded-full hover:border-[#1a1a1a] transition-colors ${tc.fontClass}`}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
                {isDuplicateCategoryName && !creatingCategory && (
                  <p className={`text-xs text-red-500 mt-1 ${tc.fontClass}`}>
                    Category already exists
                  </p>
                )}
                </>
              )}
            </div>

            {/* Name */}
            <div>
              <label className={`block text-xs ${tc.muted} ${tc.fontClass} mb-2`}>
                Name (optional)
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Text snippet"
                className={`w-full border ${tc.border} ${tc.bg} ${tc.text} px-4 py-2.5 text-sm rounded-lg focus:outline-none focus:border-[#1a1a1a] transition-colors ${tc.fontClass}`}
              />
            </div>

            {!isFileDrop && (<>

          {/* Text / Draw toggle — only in create mode (call mode does not exist on desktop) */}
          {!isEditMode && (
            <div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => handleModeSwitch('text')}
                  className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${tc.fontClass} ${
                    mode === 'text'
                      ? `${tc.activePillBg} ${tc.activePillText} border-[#1a1a1a]`
                      : `${tc.border} ${tc.text} hover:border-[#1a1a1a]`
                  }`}
                >
                  <svg className="w-3.5 h-3.5 inline-block mr-1 -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                  </svg>
                  Text
                </button>
                <button
                  type="button"
                  onClick={() => handleModeSwitch('draw')}
                  className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${tc.fontClass} ${
                    mode === 'draw'
                      ? `${tc.activePillBg} ${tc.activePillText} border-[#1a1a1a]`
                      : `${tc.border} ${tc.text} hover:border-[#1a1a1a]`
                  }`}
                >
                  <svg className="w-3.5 h-3.5 inline-block mr-1 -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487z" />
                  </svg>
                  Draw
                </button>
              </div>
            </div>
          )}

          {/* Drawing canvas */}
          {mode === 'draw' && (!isEditMode || !!editDrop?.isDrawing) && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <label className={`block text-xs ${tc.muted} ${tc.fontClass}`}>
                  Background
                </label>
                <div className="flex gap-1.5">
                  {BG_COLORS.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      onClick={() => setBgColor(c.value)}
                      className={`w-6 h-6 rounded-full border-2 transition-transform hover:scale-110 ${
                        bgColor === c.value
                          ? `${theme === 'dark' ? 'border-white scale-110' : 'border-[#1A1A1A] scale-110'}`
                          : `${theme === 'dark' ? 'border-white/30' : 'border-[#1a1a1a]/20'}`
                      }`}
                      style={{ backgroundColor: c.value }}
                      title={c.label}
                    />
                  ))}
                </div>
              </div>
              {/* The editor mounts only after the scene is ready — extractingScene spinner gate. */}
              {extractingScene ? (
                <div className={`flex items-center justify-center h-[350px] border ${tc.border} rounded-lg`}>
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 border border-current/30 border-t-current animate-spin rounded-full" />
                    <span className={`text-xs ${tc.muted} ${tc.fontClass}`}>Loading drawing...</span>
                  </div>
                </div>
              ) : (
                <>
                  <DrawingCanvas
                    onSave={handleDrawingSave}
                    onCancel={handleDrawingCancel}
                    onDraw={() => setHasDrawn(true)}
                    onElementsCountChange={(count) => { elementCountRef.current = count; }}
                    theme={theme}
                    bgColor={bgColor}
                    initialScene={initialScene || undefined}
                  />
                  {emptyDrawingHint && (
                    <p className={`text-xs text-red-500 mt-1 ${tc.fontClass}`}>
                      Draw something first — an empty drawing can't be saved.
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {/* Discard drawing confirmation */}
          {showDiscardConfirm && (
            <div className={`border ${tc.border} ${tc.bg} p-4 rounded-lg`}>
              <p className={`text-sm ${tc.text} mb-3 ${tc.fontClass}`}>
                Discard drawing?
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={confirmDiscard}
                  className="px-3 py-1.5 bg-red-500 text-white text-xs rounded-full hover:bg-red-600 transition-colors"
                >
                  Discard
                </button>
                <button
                  type="button"
                  onClick={() => setShowDiscardConfirm(false)}
                  className={`px-3 py-1.5 border ${tc.border} ${tc.text} text-xs rounded-full hover:border-[#1a1a1a] transition-colors`}
                >
                  Keep drawing
                </button>
              </div>
            </div>
          )}

          {/* Drawing attached indicator */}
          {drawingBytes && mode === 'text' && (!isEditMode || !!editDrop?.isDrawing) && (
            <div className={`border ${tc.border} rounded-lg overflow-hidden`}>
              <div className={`flex items-center gap-2 px-3 py-2 ${tc.bg}`}>
                <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className={`text-xs ${tc.text} ${tc.fontClass}`}>Drawing attached</span>
                <button
                  type="button"
                  onClick={() => setDrawingBytes(null)}
                  className={`ml-auto ${tc.muted} hover:text-red-500 transition-colors`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          )}

            </>)}

          {/* Content editor — text mode or edit mode (not for drawing/file edits).
              Voice button stripped (no transcription on desktop). */}
          {(mode === 'text' || isEditMode) && !isFileDrop && (
            <div className="relative">
              <div className="flex items-center justify-between mb-2">
                <label className={`block text-xs ${tc.muted} ${tc.fontClass}`}>
                  Content
                </label>
                {!isFullscreen && (
                  <button
                    type="button"
                    onClick={() => setIsFullscreen(!isFullscreen)}
                    className={`flex items-center justify-center w-8 h-8 text-xs rounded-full border transition-colors ${tc.fontClass} ${tc.border} ${tc.text} ${tc.btnHoverBg} ${tc.btnHoverText}`}
                    title="Fullscreen"
                  >
                    {fullscreenIcon}
                  </button>
                )}
              </div>
              {/* contentEditable mention editor: chips render live while typing, but the saved
                  value stays the plain #[Name](id) token string (see useMentionEditor). */}
               <div
                 className={isFullscreen ? 'fixed inset-0 z-[999] bg-black/40 flex items-center justify-center p-4' : 'relative'}
                 onClick={(e) => isFullscreen && e.target === e.currentTarget && setIsFullscreen(false)}
               >
                 <div className={isFullscreen ? 'relative w-full h-[calc(100dvh-32px)]' : 'relative'}>
                   {/* #-mention dropdown — floats just above the editor */}
                   {mention.showMention && mention.filteredMentionDrops.length > 0 && (
                     <div
                       ref={mention.dropdownRef}
                       className={`absolute bottom-full left-0 right-0 z-50 mb-1 max-h-[240px] overflow-y-auto rounded-md border ${tc.border} ${tc.bg} shadow-lg`}
                     >
                       {mention.filteredMentionDrops.map((drop, idx) => (
                         <EditorialDropPickerRow
                           key={drop.id}
                           drop={drop}
                           selected={idx === mention.mentionIndex}
                           attached={false}
                           onSelect={mention.insertMention}
                           theme={theme}
                         />
                       ))}
                     </div>
                   )}
                   {content === '' && !mention.showMention && (
                     <span className={`pointer-events-none absolute left-4 top-3 text-sm ${tc.fontClass} ${theme === 'dark' ? 'text-white/30' : 'text-[#1A1A1A]/30'}`}>
                       Enter your text here...
                     </span>
                   )}
                    {isFullscreen && (
                      <button
                        type="button"
                        onClick={() => setIsFullscreen(!isFullscreen)}
                        className={`absolute top-2 right-2 z-10 w-8 h-8 flex items-center justify-center ${tc.btnBg} ${tc.text} ${tc.btnHoverBg} ${tc.btnHoverText} ${tc.roundedClass} transition-colors`}
                        title="Exit fullscreen"
                      >
                        {fullscreenIcon}
                      </button>
                    )}
                   <div
                     ref={mention.setEditorRef}
                     contentEditable
                     suppressContentEditableWarning
                     onInput={mention.handleInput}
                     onKeyDown={mention.handleKeyDown}
                     onBlur={mention.handleBlur}
                     role="textbox"
                     aria-multiline="true"
                     className={`w-full border ${tc.border} ${tc.bg} ${tc.text} px-4 py-3 text-sm rounded-lg focus:outline-none focus:border-[#1a1a1a] transition-colors ${tc.fontClass} ${isFullscreen ? 'h-full min-h-0' : 'min-h-[140px] max-h-[300px]'} overflow-y-auto whitespace-pre-wrap break-words leading-relaxed`}
                   />
                 </div>
               </div>
            </div>
          )}

            {/* Image attachment — text mode or non-drawing edit; hidden while a drawing rides */}
            {(mode === 'text' || (isEditMode && !editDrop?.isDrawing)) && !isFileDrop && !drawingBytes && (
              <div>
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleImageSelect}
                  className="hidden"
                />
                {/* New image preview (just selected) */}
                {imagePreview ? (
                  <div className={`relative border ${tc.border} rounded-lg overflow-hidden`}>
                    <img src={imagePreview} alt="Attached" className="w-full max-h-32 object-cover" />
                    <button
                      type="button"
                      onClick={removeImage}
                      className="absolute top-2 right-2 w-6 h-6 bg-[#1a1a1a]/80 text-white rounded-full flex items-center justify-center hover:bg-[#1a1a1a] transition-colors"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                    <div className={`absolute bottom-2 left-2 px-2 py-1 bg-[#1a1a1a]/80 text-white text-[10px] ${tc.fontClass} rounded`}>
                      New image
                    </div>
                  </div>
                ) : existingImageUrl && !imageRemoved ? (
                  /* Existing image from the drop (media:// URL — no Firebase decrypt on desktop) */
                  <div className={`relative border ${tc.border} rounded-lg overflow-hidden`}>
                    {decryptingImage ? (
                      <div className={`w-full h-32 flex items-center justify-center ${tc.bg}`}>
                        <div className={`w-5 h-5 border border-current/30 border-t-current animate-spin rounded-full ${tc.muted}`} />
                      </div>
                    ) : (
                      <img src={existingImageUrl} alt="Current image" className="w-full max-h-32 object-cover" />
                    )}
                    <button
                      type="button"
                      onClick={removeExistingImage}
                      className="absolute top-2 right-2 w-6 h-6 bg-[#1a1a1a]/80 text-white rounded-full flex items-center justify-center hover:bg-[#1a1a1a] transition-colors"
                      title="Remove image"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => imageInputRef.current?.click()}
                      className="absolute bottom-2 right-2 px-2 py-1 bg-[#1a1a1a]/80 text-white text-[10px] rounded hover:bg-[#1a1a1a] transition-colors flex items-center gap-1"
                      title="Replace image"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                      </svg>
                      Replace
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => imageInputRef.current?.click()}
                    className={`w-full border border-dashed ${tc.border} ${tc.text} ${tc.bg} px-4 py-3 text-xs rounded-lg hover:border-[#1a1a1a] transition-colors flex items-center justify-center gap-2 ${tc.fontClass}`}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M18 2.25H6A2.25 2.25 0 003.75 4.5v15A2.25 2.25 0 006 21.75h12A2.25 2.25 0 0020.25 19.5v-15A2.25 2.25 0 0018 2.25z" />
                    </svg>
                    Attach image (optional)
                  </button>
                )}
              </div>
            )}

            {/* Expiration selector — exactly 1h/2h/6h/24h/∞ on desktop; ∞ freely choosable */}
            <div>
              <label className={`block text-xs ${tc.muted} ${tc.fontClass} mb-2`}>
                Expires after
              </label>
              <div className="flex flex-wrap gap-2">
                {EXPIRATION_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setExpiration(option.value)}
                    className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${tc.fontClass} ${
                      expiration === option.value
                        ? `${tc.activePillBg} ${tc.activePillText} border-[#1a1a1a]`
                        : `${tc.border} ${tc.text} hover:border-[#1a1a1a]`
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Lock toggle — create mode (shared space) or edit mode (space drop). */}
            {showLockToggle && (
              <div>
                <label className={`block text-xs ${tc.muted} ${tc.fontClass} mb-2`}>
                  Access
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setLocked(false)}
                    className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${tc.fontClass} ${
                      !locked
                        ? `${tc.activePillBg} ${tc.activePillText} border-[#1a1a1a]`
                        : `${tc.border} ${tc.text} hover:border-[#1a1a1a]`
                    }`}
                  >
                    Open
                  </button>
                  <button
                    type="button"
                    onClick={() => setLocked(true)}
                    className={`flex items-center gap-1 px-3 py-1.5 text-xs rounded-full border transition-colors ${tc.fontClass} ${
                      locked
                        ? `${tc.activePillBg} ${tc.activePillText} border-[#1a1a1a]`
                        : `${tc.border} ${tc.text} hover:border-[#1a1a1a]`
                    }`}
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                    Locked
                  </button>
                </div>
              </div>
            )}

            {/* Reminder — preset/custom picker with live fire-time preview. Firing itself is
                Sitting 3; here we only store reminderAt. A past date is allowed and shows the
                fired state. Hidden for file drops — a file drop cannot carry a reminder. */}
            {(!isEditMode || !isFileDrop) && (
              <div>
                <label className={`block text-xs ${tc.muted} ${tc.fontClass} mb-2`}>Reminder</label>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setReminderEnabled(!reminderEnabled)}
                    className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${tc.fontClass} ${
                      reminderEnabled
                        ? `${tc.activePillBg} ${tc.activePillText} border-[#1a1a1a]`
                        : `${tc.border} ${tc.text} hover:border-[#1a1a1a]`
                    }`}
                  >
                    {reminderEnabled ? 'On' : 'Off'}
                  </button>
                  {reminderEnabled && (
                    <>
                      {REMINDER_PRESETS.map((p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => setReminderPreset(p)}
                          className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${tc.fontClass} ${
                            pickerActive && reminderPreset === p
                              ? `${tc.activePillBg} ${tc.activePillText} border-[#1a1a1a]`
                              : `${tc.border} ${tc.text} hover:border-[#1a1a1a]`
                          }`}
                        >
                          {p.toUpperCase()}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => setReminderPreset('custom')}
                        className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${tc.fontClass} ${
                          pickerActive && reminderPreset === 'custom'
                            ? `${tc.activePillBg} ${tc.activePillText} border-[#1a1a1a]`
                            : `${tc.border} ${tc.text} hover:border-[#1a1a1a]`
                        }`}
                      >
                        Custom
                      </button>
                      {reminderPreset === 'custom' && (
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            step="any"
                            min="0"
                            value={reminderCustomValue}
                            onChange={(e) => setReminderCustomValue(e.target.value)}
                            placeholder="0"
                            className={`w-16 px-3 py-2 text-sm rounded-lg border ${tc.border} ${tc.bg} ${tc.text} focus:outline-none ${tc.fontClass}`}
                          />
                          <EditorialSelect
                            className="w-24"
                            theme={theme}
                            ariaLabel="Custom reminder unit"
                            value={reminderCustomUnit}
                            onChange={(v) => setReminderCustomUnit(v as ReminderUnit)}
                            options={[
                              { value: 'minutes', label: 'min' },
                              { value: 'hours', label: 'hr' },
                              { value: 'days', label: 'day' },
                            ]}
                          />
                        </div>
                      )}
                    </>
                  )}
                </div>
                {reminderFire?.fired ? (
                  <p className={`text-xs text-red-500 mt-1 ${tc.fontClass}`}>This reminder has fired — pick a new time to re-arm, or turn it off.</p>
                ) : reminderWarningValue ? (
                  <p className={`text-xs text-red-500 mt-1 ${tc.fontClass}`}>{reminderWarningValue}</p>
                ) : reminderFire && !reminderFire.fired ? (
                  <p className={`text-xs mt-1 ${tc.muted} ${tc.fontClass}`}>
                    Fires {reminderFire.absolute}{reminderFire.remaining ? ` · ${reminderFire.remaining}` : ''}
                  </p>
                ) : null}
              </div>
            )}

            {/* Action buttons */}
            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={handleClose}
                disabled={loading}
                className={`flex-1 border ${tc.border} ${tc.text} py-2.5 text-sm rounded-lg hover:border-[#1a1a1a] transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${tc.fontClass}`}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || (isEditMode && !hasChanges) || (!isFileDrop && !content.trim() && !drawingBytes && !(isEditMode && !!editDrop?.isDrawing)) || (reminderEnabled && reminderInvalidValue)}
                className={`flex-1 ${tc.activePillBg} ${tc.activePillText} py-2.5 text-sm rounded-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity flex items-center justify-center gap-2 ${tc.fontClass}`}
              >
                {loading ? (
                  <>
                    <div className="w-4 h-4 border border-white/30 border-t-white animate-spin rounded-full" />
                    Saving...
                  </>
                ) : (
                  isEditMode ? 'Save changes' : 'Save'
                )}
              </button>
            </div>
          </div>
        </form>
      </div>

      {/* Unsaved-changes close guard (edit mode) */}
      {showCloseDiscardConfirm && (
        <div
          className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-4"
          onClick={(e) => e.target === e.currentTarget && setShowCloseDiscardConfirm(false)}
        >
          <div className={`${tc.bg} border ${tc.border} rounded-xl w-80 max-w-full p-5 shadow-xl`}>
            <p className={`text-sm ${tc.text} mb-4 ${tc.fontClass}`}>Discard changes?</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  if (loading) return;
                  setShowCloseDiscardConfirm(false);
                  onClose();
                  // C2: the guarded mode switch proceeds only AFTER the discard completed.
                  const proceed = pendingModeSwitchRef.current;
                  pendingModeSwitchRef.current = null;
                  proceed?.();
                }}
                className={`flex-1 px-4 py-2 ${tc.activePillBg} ${tc.activePillText} text-sm rounded-lg hover:opacity-90 transition-opacity ${tc.fontClass}`}
              >
                Discard
              </button>
              <button
                type="button"
                onClick={() => setShowCloseDiscardConfirm(false)}
                className={`flex-1 px-4 py-2 border ${tc.border} ${tc.text} text-sm rounded-lg hover:border-[#1a1a1a] transition-colors ${tc.fontClass}`}
              >
                Keep editing
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
