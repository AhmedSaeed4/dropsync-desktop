/**
 * Desktop port of the web's EditorialDropZone — the drag/drop/paste/browse create pipeline.
 *
 * Stripped per spec (Sitting 2): the mobile Chat button, ALL call routes/machinery, and every
 * tier gate (∞ is freely choosable). The cross-fade progress region is preserved VERBATIM,
 * including its deliberate anti-jiggle design: the IDLE layer stays in normal flow so it
 * permanently reserves the box's full height (the box can NEVER shrink during upload); the
 * PROGRESS layer is an absolute overlay that cross-fades in over it. Pure opacity, no
 * transform — repo rule.
 *
 * Desktop deltas: files with a real disk path stream disk→encrypt→vblob entirely in main via
 * drop:createFileFromPath (bytes never cross IPC); clipboard/drag sources without a path fall
 * back to drop:createFileFromBytes (bytes cross exactly once). Byte-progress rides the existing
 * vault:importProgress channel (phase 'fileCreate').
 */

import { useState, useRef, useCallback, useEffect, Fragment } from 'react';
import type { Drop, ExpirationOption } from '../../lib/types';
import { Tooltip } from '../shared/Tooltip';
import { getEditorialThemeColors } from '../../lib/editorialTheme';
import { EditorialTextModal, type TextModalCreatePayload } from './EditorialTextModal';
import { useVaultStore } from '../../store/vault';
import type { CreateExpirationOptionDTO, DropDTO } from '../../../../preload/apiTypes';

interface EditorialDropZoneProps {
  theme?: 'light' | 'dark' | 'minimal';
  /** Current space id ('personal' or a workspace id) — new drops land here. */
  spaceId: string;
  /** Inside a shared space → shows the lock pill (cosmetic badge, always permitted). */
  isWorkspace?: boolean;
  customCategories?: string[];
  onCreateCategory?: (name: string) => Promise<string | null>;
  /** Paste guard while ANY edit modal is open elsewhere on the page. */
  editModalOpen?: boolean;
  mentionableDrops?: Drop[];
}

// Richer upload state (web parity): idle, live-uploading with real byte progress, done, or an
// accumulated error naming the failed file(s).
type UploadState =
  | { status: 'idle' }
  | { status: 'uploading'; completed: number; total: number; currentRatio: number; currentName?: string }
  | { status: 'done' }
  | { status: 'error'; message: string };

const EXPIRATION_OPTIONS: { value: ExpirationOption; label: string }[] = [
  { value: '1h', label: '1h' },
  { value: '2h', label: '2h' },
  { value: '6h', label: '6h' },
  { value: '24h', label: '24h' },
  { value: 'forever', label: '∞' },
];

export function EditorialDropZone({
  theme = 'light',
  spaceId,
  isWorkspace = false,
  customCategories = [],
  onCreateCategory,
  editModalOpen = false,
  mentionableDrops = [],
}: EditorialDropZoneProps) {
  const { appendDropInPlace } = useVaultStore();
  const [isDragging, setIsDragging] = useState(false);
  const [uploadState, setUploadState] = useState<UploadState>({ status: 'idle' });
  // True only while a create is in flight — drives the cross-fade + the re-entrancy guards.
  const busy = uploadState.status === 'uploading';
  // Derived error surfaced in the error block below the drop box.
  const error = uploadState.status === 'error' ? uploadState.message : null;
  const [showTextModal, setShowTextModal] = useState(false);
  const [expiration, setExpiration] = useState<ExpirationOption>('2h');
  // Open/Locked pill inside shared spaces. Cosmetic badge on desktop — no rules engine exists,
  // so this is presentation-only (LOCKED decision).
  const [locked, setLocked] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const tc = getEditorialThemeColors(theme);

  // --- File upload helpers ---
  const uploadFiles = useCallback(
    async (files: File[]) => {
      // Block a 2nd concurrent upload (drop / file-select / paste while one is already running).
      if (busy) return;
      if (files.length === 0) return;
      const total = files.length;
      let completed = 0;
      // Accumulate per-file failures — every failed filename surfaces, not just the last.
      const failed: { name: string; message: string }[] = [];
      // FIX 9: creates RETURN the saved records — collect them and append in place afterwards
      // (loading never flips, so the list never blinks to skeleton mid-upload).
      const created: DropDTO[] = [];
      setUploadState({ status: 'uploading', completed: 0, total, currentRatio: 0, currentName: files[0]?.name });
      try {
        for (const file of files) {
          try {
            let path = '';
            try {
              path = window.dropsync.pathForFile(file);
            } catch {
              path = '';
            }
            if (path) {
              // Disk source → streamed entirely in main; bytes never cross IPC.
              const rec = await window.dropsync.drop.createFileFromPath(path, {
                spaceId,
                expirationOption: expiration as CreateExpirationOptionDTO,
                locked,
              });
              if (rec) created.push(rec);
            } else {
              // Clipboard-origin bytes cross IPC exactly once, staged to a temp file in main.
              const bytes = new Uint8Array(await file.arrayBuffer());
              const rec = await window.dropsync.drop.createFileFromBytes(bytes, file.name, file.type || undefined, {
                spaceId,
                expirationOption: expiration as CreateExpirationOptionDTO,
                locked,
              });
              if (rec) created.push(rec);
            }
          } catch (caught) {
            failed.push({
              name: file.name,
              message: caught instanceof Error ? caught.message : 'Failed to save file. Please try again.',
            });
          }
          completed += 1;
          setUploadState((prev) =>
            prev.status === 'uploading' ? { ...prev, completed } : prev
          );
        }
      } finally {
        // ALWAYS settle — the UI must never get stuck "uploading", even if something throws.
        if (failed.length > 0) {
          const detail = failed.map((f) => `${f.name}: ${f.message}`).join('; ');
          setUploadState({
            status: 'error',
            message:
              failed.length === total
                ? detail
                : `Saved ${completed - failed.length} of ${total}. Failed — ${detail}`,
          });
        } else {
          // busy flips false -> the progress overlay cross-fades back to the idle layer (~350ms).
          setUploadState({ status: 'done' });
          created.forEach(appendDropInPlace); // FIX 9: in-place append, no skeleton swap
        }
      }
    },
    [busy, spaceId, expiration, locked, appendDropInPlace]
  );

  // Live byte progress for the in-flight create. Main emits on the existing import-progress
  // channel with phase 'fileCreate'; a late tick after the window closed can't mutate a
  // non-uploading state (guarded set). youtubeTitle ticks are ignored here.
  useEffect(() => {
    if (!busy) return;
    return window.dropsync.onImportProgress((p) => {
      if (p.phase !== 'fileCreate' || p.totalBytes <= 0) return;
      setUploadState((prev) =>
        prev.status === 'uploading'
          ? { ...prev, currentRatio: Math.min(1, p.processedBytes / p.totalBytes) }
          : prev
      );
    });
  }, [busy]);

  // --- Text drop (create via the EditorialTextModal payload) ---
  const handleTextSubmit = async (payload: TextModalCreatePayload) => {
    // Defense-in-depth: the text modal can't be opened mid-upload (Add Text is disabled + the
    // heading click area is pointer-events-none while busy) — guard anyway so the busy-lock is
    // self-contained.
    if (busy) return;
    setUploadState({ status: 'uploading', completed: 0, total: 1, currentRatio: 0, currentName: payload.name || undefined });
    try {
      const rec = await window.dropsync.drop.createText({
        spaceId,
        name: payload.name,
        content: payload.content,
        categories: payload.categories,
        expirationOption: payload.expirationOption as CreateExpirationOptionDTO,
        locked: payload.locked,
        reminderAt: payload.reminderAt ? payload.reminderAt.toISOString() : null,
        ...(payload.imagePath !== undefined ? { imagePath: payload.imagePath } : {}),
        ...(payload.imageBytes !== undefined ? { imageBytes: payload.imageBytes } : {}),
        ...(payload.pngBytes !== undefined ? { pngBytes: payload.pngBytes } : {}),
      });
      setUploadState({ status: 'done' });
      if (rec) appendDropInPlace(rec); // FIX 9: in-place append, no skeleton swap
    } catch {
      setUploadState({ status: 'error', message: 'Failed to create text drop. Please try again.' });
    } finally {
      setShowTextModal(false);
    }
  };

  // --- Drag & Drop ---
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const files = Array.from(e.dataTransfer.files);
      await uploadFiles(files);
    },
    [uploadFiles]
  );

  // --- File input ---
  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!e.target.files) return;
      const files = Array.from(e.target.files);
      await uploadFiles(files);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    },
    [uploadFiles]
  );

  // --- Clipboard paste (images only; guarded while any modal is open or an input owns focus) ---
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      if (busy || showTextModal || editModalOpen) return;
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      )
        return;

      const items = e.clipboardData?.items;
      if (!items) return;

      const imageFiles: File[] = [];
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const blob = item.getAsFile();
          if (blob) {
            const ext = item.type.split('/')[1] || 'png';
            const file = new File([blob], `pasted-image-${Date.now()}.${ext}`, {
              type: item.type,
            });
            imageFiles.push(file);
          }
        }
      }

      if (imageFiles.length > 0) {
        e.preventDefault();
        await uploadFiles(imageFiles);
      }
    };

    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [busy, showTextModal, uploadFiles, editModalOpen]);

  // --- Border/shadow states ---
  const borderClass = isDragging
    ? `${tc.dragBorder} border-2`
    : `${tc.border} ${tc.hoverBorder} border`;

  const shadowClass = isDragging ? 'shadow-lg' : '';

  const bgClass = isDragging ? tc.dragBg : tc.bg;
  const textClass = isDragging ? tc.dragText : tc.text;
  const mutedClass = isDragging ? tc.dragMuted : tc.muted;

  // Upload-progress display values (only meaningful while busy). % is the in-flight stream's
  // plaintext byte ratio (0..100). index is clamped so it never reads "N+1 of N".
  const isUploadingState = uploadState.status === 'uploading';
  const pct = isUploadingState ? Math.round(uploadState.currentRatio * 100) : 0;
  const progressLabel = isUploadingState
    ? uploadState.total > 1
      ? `Saving ${Math.min(uploadState.completed + 1, uploadState.total)} of ${uploadState.total} · ${pct}%`
      : `Saving… ${pct}%`
    : '';

  return (
    <>
      {/* Section header */}
      <div className="flex items-center gap-3 mb-6">
        <span className={`rounded-full ${tc.activePillBg} w-1.5 h-1.5`}></span>
        <h2 className={`${tc.fontClass} ${tc.text} font-medium tracking-tight text-xl`}>Upload</h2>
      </div>

      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`${bgClass} ${borderClass} rounded-xl ${shadowClass} text-left transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] p-10`}
      >
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileSelect}
          className="hidden"
        />

        {/* Cross-fade region. The IDLE layer stays in normal flow so it permanently reserves the
            box's full height (the box can NEVER shrink during upload); the PROGRESS layer is an
            absolute overlay that cross-fades in over it. Pure opacity, no transform -> no jiggle
            (repo rule). Both layers are always mounted; only opacity + pointer-events toggle.
            Desktop: the mobile Chat button does not exist, so the fade scope covers everything. */}
        <div
          className={`pb-8 ${busy ? '' : 'cursor-pointer'}`}
          onClick={(e) => {
            // The ONE click-to-open-text-modal handler for this whole region — heading, subtitle,
            // button-row whitespace, AND the padding strip down to the divider line. Only when
            // idle; never mid-upload. The action buttons stopPropagation; closest('button') is
            // belt-and-suspenders (matches original).
            if (busy) return;
            const target = e.target as HTMLElement;
            if (target.tagName === 'BUTTON' || target.closest('button')) return;
            setShowTextModal(true);
          }}
        >
          <div className="relative">
            {/* IDLE content — purely the fading visual layer for heading+buttons: in normal flow
                (reserves height → box can't shrink), fades out while busy. No onClick here — clicks
                bubble up to the outer container's single modal-opening handler. */}
            <div
              className={`transition-opacity duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${busy ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
            >
              {/* Title */}
              <h2
                className={`${tc.fontClass} ${textClass} font-medium tracking-tight mb-2 transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] text-[28px]`}
                style={{ fontFamily: 'Raleway, sans-serif' }}
              >
                Drop files here
              </h2>

              {/* Subtitle */}
              <p className={`text-sm ${tc.fontClass} ${mutedClass} mb-6`}>
                Or choose an option below &mdash; Max 500MB
              </p>

              {/* Action buttons */}
              <div className="flex items-center gap-3 transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)]">
                {/* Browse Files - primary */}
                <button
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    fileInputRef.current?.click();
                  }}
                  className={`${tc.fontClass} rounded-lg ${tc.activePillBg} ${tc.activePillText} hover:opacity-90 transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] px-6 py-3 text-sm ${busy ? 'cursor-not-allowed' : ''}`}
                >
                  Browse Files
                </button>

                {/* Add Text - secondary */}
                <button
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowTextModal(true);
                  }}
                  className={`${tc.fontClass} rounded-lg border ${tc.border} bg-transparent ${tc.text} ${tc.hoverBorder} transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] px-6 py-3 text-sm ${busy ? 'cursor-not-allowed' : ''}`}
                >
                  Add Text
                </button>
              </div>
            </div>

            {/* PROGRESS overlay — absolute, cross-fades in while busy. The live % NUMBER shows. */}
            <div
              className={`absolute inset-0 flex flex-col items-start justify-center gap-4 transition-opacity duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${busy ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
              aria-live="polite"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 border-2 border-current/30 border-t-current animate-spin rounded-full" />
                <p className={`text-sm ${tc.fontClass} ${textClass}`}>{progressLabel}</p>
              </div>
              {/* Thin progress bar — width tracks the live % */}
              <div className="w-full h-1.5 bg-current/10 rounded-full overflow-hidden">
                <div
                  className={`h-full ${tc.activePillBg} rounded-full transition-[width] duration-150 ease-linear`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Expiry + lock — ALWAYS mounted (the row never vanishes during upload), but DISABLED +
            greyed while busy. The upload captured expiration/locked at drop time, so a mid-upload
            change wouldn't take effect anyway. Desktop: no tier gate on ∞; lock is a cosmetic
            badge shown only inside shared spaces. */}
        <div
          className={`border-t ${tc.border} transition-opacity duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] pt-6 ${busy ? 'opacity-50' : 'opacity-100'}`}
        >
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className={`text-xs ${tc.fontClass} ${tc.muted} mb-2 tracking-wider uppercase`}>Expires after</p>
                  <div className="flex gap-2 flex-wrap">
                    {EXPIRATION_OPTIONS.map((option) => {
                      const pill = (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpiration(option.value);
                          }}
                          className={`${tc.fontClass} rounded-full border transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${
                            expiration === option.value
                              ? `${tc.activePillBg} ${tc.activePillText} ${tc.border}`
                              : `bg-transparent ${tc.text} ${tc.border} ${tc.hoverBorder}`
                          } px-4 py-2 text-sm ${busy ? 'cursor-not-allowed' : ''}`}
                        >
                          {option.label}
                        </button>
                      );
                      // Busy-only hover explanation for the disabled pills (web parity): mounted
                      // ONLY when busy, since the Tooltip always renders its bubble on hover.
                      return busy ? (
                        <Tooltip key={option.value} content="Unavailable while saving">
                          {pill}
                        </Tooltip>
                      ) : (
                        <Fragment key={option.value}>{pill}</Fragment>
                      );
                    })}
                  </div>
                </div>
                {isWorkspace && (
                  <Tooltip content={busy ? 'Unavailable while saving' : (locked ? 'Locked — only you can edit' : 'Open — anyone in this space can edit')}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={(e) => { e.stopPropagation(); setLocked(!locked); }}
                      aria-label={locked ? 'Locked — only you can edit' : 'Open — anyone in this space can edit'}
                      className={`flex items-center justify-center ${tc.fontClass} rounded-full border transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${
                        locked
                          ? `${tc.activePillBg} ${tc.activePillText} ${tc.border}`
                          : `bg-transparent ${tc.text} ${tc.border} ${tc.hoverBorder}`
                      } px-4 py-2 text-sm ${busy ? 'cursor-not-allowed' : ''}`}
                    >
                      {locked ? (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                        </svg>
                      )}
                    </button>
                  </Tooltip>
                )}
              </div>
            </div>
      </div>

      {/* Error message */}
      {error && (
        <div
          className={`mt-4 border ${tc.border} ${tc.roundedClass} ${tc.bg} px-5 py-3 flex items-center justify-between`}
        >
          <span className={`text-sm ${tc.fontClass} ${tc.text}`}>
            {error}
          </span>
          <button
            onClick={() => setUploadState({ status: 'idle' })}
            className={`${tc.text} hover:opacity-60 transition-opacity`}
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      )}

      {/* Text Modal — create + edit share the component; the zone only ever mounts create mode. */}
      {showTextModal && (
        <EditorialTextModal
          onSubmit={handleTextSubmit}
          onClose={() => setShowTextModal(false)}
          theme={theme}
          customCategories={customCategories}
          onCreateCategory={onCreateCategory}
          mentionableDrops={mentionableDrops}
          isWorkspace={isWorkspace}
        />
      )}
    </>
  );
}
