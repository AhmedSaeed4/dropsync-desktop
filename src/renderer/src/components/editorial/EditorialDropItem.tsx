import { memo, useEffect, useRef, useState } from 'react';
import type { Drop } from '../../lib/types';
import { formatFileSize, getTimeRemaining, drawingMediaKind } from '../../lib/dropsHelpers';
import { getYouTubeVideoId } from '../../lib/dropsHelpers';
import { contentToPlainText } from '../../lib/dropTagUtils';
import { DropMentionContent } from '../shared/DropMentionContent';
import { getEditorialThemeColors } from '../../lib/editorialTheme';
import { DropContextMenu, useContextMenu } from '../shared/DropContextMenu';
import { useVaultStore } from '../../store/vault';
import { prefetchImageMedia, prefetchPreviewPayload, prebufferVideoMedia, putCachedPreviewPayload } from '../../lib/previewPayloadCache';
import { useVideoThumbnail } from '../../hooks/useVideoThumbnail';

interface EditorialDropItemProps {
  drop: Drop;
  onDelete: (drop: Drop) => void;
  onPreview: (drop: Drop) => void;
  selected: boolean;
  onSelect: (id: string) => void;
  selectionMode: boolean;
  theme?: 'light' | 'dark' | 'minimal';
  currentUserId?: string;
  onPin?: (drop: Drop) => void;
  onUnpin?: (drop: Drop) => void;
  /** Right-click → Edit (opens the EditorialTextModal for text drops; file drops edit meta). */
  onEdit?: (drop: Drop) => void;
  showMoveControls?: boolean;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onMoveUp?: (dropId: string) => void;
  onMoveDown?: (dropId: string) => void;
  showDragHandle?: boolean;
  dragHandleProps?: Record<string, unknown>;
  allDrops?: Drop[];
  // Reminder glow (viewer-dependent) — rainbow title + clock badge, computed by the parent list.
  reminderGlow?: boolean;
}

function isTextFile(drop: Drop): boolean {
  if (drop.type === 'text') return true;
  const textMimeTypes = ['text/', 'application/json', 'application/xml'];
  const textExtensions = ['.txt', '.md', '.json', '.csv', '.xml', '.html', '.css', '.js', '.ts', '.jsx', '.tsx'];
  return textMimeTypes.some(t => drop.mimeType?.startsWith(t)) ||
         textExtensions.some(ext => drop.name.toLowerCase().endsWith(ext));
}

function getScrollParent(el: Element | null): Element | null {
  let node = el?.parentElement;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') {
      if (node.scrollHeight > node.clientHeight) return node;
    }
    node = node.parentElement;
  }
  return null;
}

/** Lazy payload fetch once the card nears the viewport (web's decrypt-deferral pattern). */
function useInView<T extends Element>(rootMargin = '1000px 0px') {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const root = getScrollParent(el);
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            observer.disconnect();
          }
        }
      },
      { root, rootMargin }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [rootMargin]);

  return { ref, inView };
}

export const EditorialDropItem = memo(function EditorialDropItem({
  drop,
  onDelete,
  onPreview,
  selected,
  onSelect,
  selectionMode,
  theme = 'light',
  onPin,
  onUnpin,
  onEdit,
  showMoveControls,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  showDragHandle,
  dragHandleProps,
  allDrops = [],
  reminderGlow = false,
}: EditorialDropItemProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);
  const [textContent, setTextContent] = useState<string>('');
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const { fetchTextPayload, getMediaUrl } = useVaultStore();

  const { ref: cardRef, inView } = useInView<HTMLDivElement>('1000px 0px');
  const hasLoaded = useRef(false);
  // 28: the card re-reads ITSELF when its content fingerprint changes (no whole-list refresh —
  // the save already patches this one drop's DTO in place). Key = the stamped shas; null until
  // the first successful load (that first load keeps the old one-shot behavior).
  const contentKey = JSON.stringify([drop.contentSha256s?.content ?? null, drop.contentSha256s?.file ?? null, drop.contentSha256s?.image ?? null]);
  const loadedKeyRef = useRef<string | null>(null);

  const tc = getEditorialThemeColors(theme);
  const font = tc.fontClass;

  const chipBase = `inline-flex items-center mx-0.5 px-1.5 py-0.5 align-middle rounded text-[11px] ${font}`;
  const mentionFoundClass = `${chipBase} ${tc.activePillBg} ${tc.activePillText} hover:opacity-80`;
  const mentionDeletedClass = `${chipBase} ${tc.inactivePillBg} ${tc.muted} line-through cursor-not-allowed`;

  const { menuState, closeMenu, contextMenuProps } = useContextMenu();

  const isImage = drop.mimeType?.startsWith('image/');
  const isVideo = drop.mimeType?.startsWith('video/');
  // Offline video thumbnail — <video> → canvas, fully local (media:// src). Null for anything
  // that isn't a playable video file.
  const { thumbnailUrl: videoThumbUrl } = useVideoThumbnail(
    drop.type === 'file' && isVideo ? fileUrl : null,
    drop.mimeType
  );
  const hasAttachedImage = drop.type === 'text' && !!drop.imageSize;

  // Lazy payload load — the desktop analogue of the web's lazy decrypt: text bodies come over
  // IPC; binaries resolve to opaque media:// URLs streamed (and range-served) by main.
  // Round 112 (web #235 port): a COMPLETED load banks its payload into the shared preview
  // cache — the card's in-view load IS the web's card decrypt, so handing the finished result
  // to the shelf makes the click a warm hit with zero loading frame. Banked only when the
  // payload is COMPLETE for the modal's cache shape (EditorialPreviewModal mount effect): a
  // text-format FILE drop (isTextFile && type 'file') needs BOTH text and fileUrl but this
  // load fetches only fileUrl, so banking it would poison the modal's hit with an empty body
  // (the FIX 14 poisoning rule). Freshness rides the round-110 fingerprints: contentKey
  // changes re-run this load, which re-banks fresh — plus the App.tsx edit-success invalidate.
  useEffect(() => {
    async function load() {
      if (!inView) return;
      if (loadedKeyRef.current !== null && loadedKeyRef.current === contentKey) return;
      hasLoaded.current = true;
      try {
        let text = '';
        let bankFileUrl: string | null = null;
        let bankImageUrl: string | null = null;
        if (drop.type === 'text') {
          text = await fetchTextPayload(drop.id);
          setTextContent(text);
        }
        if (drop.type === 'file' || drop.isDrawing) {
          // FIX 20: drawings resolve through the ONE shared slot resolver — web-imported
          // drawings carry their PNG in the IMAGE slot; locally drawn ones stay FILE.
          const kind = drop.isDrawing ? drawingMediaKind(drop) : 'file';
          const url = await getMediaUrl(drop.id, kind);
          setFileUrl(url);
          // Round 112 bank mapping = the modal's own fetch branches: a type-'file' drop's URL
          // is the modal's fileUrl (its branch at EditorialPreviewModal.tsx:101); a drawing's
          // slot URL is additionally its imageUrl (its branch at :109) so the text-body image
          // render (:307) and the local-drawing render both hit warm.
          if (drop.type === 'file') bankFileUrl = url;
          if (drop.isDrawing) bankImageUrl = url;
        }
        if (hasAttachedImage) {
          const url = await getMediaUrl(drop.id, 'image');
          setImageUrl(url);
          bankImageUrl = url;
        }
        loadedKeyRef.current = contentKey;
        if (!(drop.type === 'file' && isTextFile(drop))) {
          putCachedPreviewPayload(drop.id, {
            text,
            fileUrl: bankFileUrl,
            imageUrl: bankImageUrl,
          });
        }
      } catch {
        /* card stays in its placeholder state — and nothing is banked */
      }
    }
    void load();
  }, [drop, inView, hasAttachedImage, fetchTextPayload, getMediaUrl]);

  const displayContent = drop.type === 'text'
    ? (textContent || (hasLoaded.current ? '' : ''))
    : '';

  // YouTube links are detected OFFLINE; thumbnails stay a local placeholder (zero-network audit).
  const youtubeVideoId = drop.type === 'text' && !drop.isDrawing
    ? getYouTubeVideoId(displayContent)
    : null;

  // FIX 20: a drawing's thumbnail comes from whichever slot the resolver picked — no mimeType
  // gating (imported drawings carry no record.mimeType at all).
  const drawingThumbUrl = drop.isDrawing ? fileUrl ?? imageUrl : null;
  const hasThumbnail =
    (isImage && !!fileUrl) ||
    (drop.type === 'text' && hasAttachedImage && !!imageUrl) ||
    !!drawingThumbUrl;

  const handleSaveAs = async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (drop.type !== 'file') return;
    setIsDownloading(true);
    try {
      await window.dropsync.vault.saveAs(drop.id, 'file');
    } finally {
      setIsDownloading(false);
    }
  };

  const handleSaveImageAs = async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setIsDownloading(true);
    try {
      await window.dropsync.vault.saveAs(drop.id, 'image');
    } finally {
      setIsDownloading(false);
    }
  };

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const content = drop.type === 'text' ? displayContent : '';
    if (content) {
      await navigator.clipboard.writeText(contentToPlainText(content));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const canCopyContent = isTextFile(drop);

  // FIX 14 + FIX 16: fine-pointer hover prefetch — fire-and-forget warming so a first-ever
  // click renders with zero loading frame. Text-only drops bank their payload into the preview
  // cache; image-bearing drops (file images + attached images) warm the NOW-STABLE media URL
  // and run an offscreen decode against it, so the preview's <img> hits Chromium's cache.
  // Videos stay too heavy to prefetch; drawings keep their eager in-view load; selection mode
  // never prefetches. Dedupe, error-swallowing and the LRU cap live in the cache module.
  const handleHoverPrefetch = () => {
    if (selectionMode) return;
    if (drop.type === 'text' && !hasAttachedImage && !drop.isDrawing) {
      prefetchPreviewPayload(drop.id, () => fetchTextPayload(drop.id));
    } else if (drop.type === 'file' && isImage) {
      prefetchImageMedia(() => getMediaUrl(drop.id, 'file'));
    } else if (hasAttachedImage) {
      prefetchImageMedia(() => getMediaUrl(drop.id, 'image'));
    } else if (drop.isDrawing) {
      prefetchImageMedia(() => getMediaUrl(drop.id, drawingMediaKind(drop)));
    }
  };

  // Round 112 — video hover pre-stage (web #235's desktop hover, ported): a settled fine
  // pointer on a video card starts the offscreen prebuffer so the click finds the head already
  // served. Sweeping past never triggers (100 ms settle, mouse only — a touch tap synthesizes
  // mouse/pointer enters). Selection mode never pre-stages (the FIX 14 rule).
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current);
  }, []);

  const handleVideoPointerEnter = (e: React.PointerEvent) => {
    if (selectionMode || e.pointerType !== 'mouse') return;
    if (drop.type !== 'file' || !isVideo) return;
    if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
      prebufferVideoMedia(async () => fileUrl ?? (await getMediaUrl(drop.id, 'file')));
    }, 100);
  };

  const handleVideoPointerLeave = () => {
    if (hoverTimerRef.current !== null) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };

  const thumbnailSrc = hasThumbnail
    ? (drop.isDrawing ? drawingThumbUrl : isImage ? fileUrl : imageUrl)
    : null;

  return (
    <div
      ref={cardRef}
      onMouseEnter={handleHoverPrefetch}
      onPointerEnter={handleVideoPointerEnter}
      onPointerLeave={handleVideoPointerLeave}
      onClick={() => selectionMode ? onSelect(drop.id) : onPreview(drop)}
      {...contextMenuProps}
      className={`relative select-none ${tc.cardBg} ${tc.roundedClass} border ${tc.border} transition-all cursor-pointer group overflow-hidden ${
        tc.hoverBorder
      }`}
    >
      {/* Pinned indicator */}
      {drop.pinned && (
        <div className={`absolute top-2 right-2 z-10 w-4 h-4 flex items-center justify-center ${tc.roundedClass} ${theme === 'dark' ? 'bg-white/10 text-white/70' : 'bg-[#1A1A1A]/10 text-[#1A1A1A]/60'}`}>
          <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24" strokeWidth="0">
            <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
          </svg>
        </div>
      )}
      {/* Lock badge — cosmetic on desktop (single user), per LOCKED decision */}
      {drop.locked && (
        <div className={`absolute top-2 left-2 z-10 w-4 h-4 flex items-center justify-center ${tc.roundedClass} ${theme === 'dark' ? 'bg-white/10 text-white/70' : 'bg-[#1A1A1A]/10 text-[#1A1A1A]/60'}`} title="Locked">
          <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
        </div>
      )}
      <div className="flex flex-col sm:flex-row items-stretch min-w-0 overflow-hidden p-3 gap-3">
        {/* Drag handle (desktop Manual mode) */}
        {showDragHandle && (
          <button
            type="button"
            {...(dragHandleProps as Record<string, never>)}
            onClick={(e) => e.stopPropagation()}
            title="Drag to reorder"
            className={`flex flex-col gap-0.5 flex-shrink-0 self-center cursor-grab active:cursor-grabbing px-1 ${tc.muted} ${tc.hoverBorder} rounded transition-colors`}
          >
            <svg className="w-3 h-4" fill="currentColor" viewBox="0 0 6 16" aria-hidden="true">
              <circle cx="1.5" cy="2" r="1.1" /><circle cx="4.5" cy="2" r="1.1" />
              <circle cx="1.5" cy="8" r="1.1" /><circle cx="4.5" cy="8" r="1.1" />
              <circle cx="1.5" cy="14" r="1.1" /><circle cx="4.5" cy="14" r="1.1" />
            </svg>
          </button>
        )}
        {/* Selection checkbox or visual block */}
        {selectionMode ? (
          <button
            onClick={(e) => { e.stopPropagation(); onSelect(drop.id); }}
            className={`w-10 h-10 flex-shrink-0 flex items-center justify-center ${tc.roundedClass} border ${
              selected
                ? `border-transparent ${tc.activePillBg} ${tc.activePillText}`
                : `${tc.border} ${tc.inactivePillHoverBg}`
            } transition-colors`}
          >
            {selected && (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="3">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            )}
          </button>
        ) : thumbnailSrc ? (
          <div className="w-full sm:w-20 h-40 sm:h-20 flex-shrink-0 overflow-hidden rounded-lg relative">
            <img
              src={thumbnailSrc}
              alt={drop.name}
              className="w-full h-full object-cover"
            />
            {drop.isDrawing && (
              <div className={`absolute bottom-1 right-1 px-1 rounded text-[9px] ${font} bg-black/50 text-white`}>drawing</div>
            )}
          </div>
        ) : isVideo && videoThumbUrl ? (
          <div className="w-full sm:w-20 h-40 sm:h-20 flex-shrink-0 overflow-hidden rounded-lg relative">
            <img
              src={videoThumbUrl}
              alt={drop.name}
              className="w-full h-full object-cover"
            />
            <div className={`absolute bottom-1 right-1 px-1 rounded text-[9px] ${font} bg-black/50 text-white`}>video</div>
          </div>
        ) : isVideo ? (
          <div className={`w-10 h-10 flex-shrink-0 flex items-center justify-center ${tc.roundedClass} border ${tc.border} ${tc.inactivePillBg}`}>
            <svg className={`w-4 h-4 ${tc.muted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
            </svg>
          </div>
        ) : (
          <div className={`w-10 h-10 flex-shrink-0 flex items-center justify-center ${tc.roundedClass} border ${tc.border} ${tc.inactivePillBg}`}>
            {drop.type === 'text' ? (
              <svg className={`w-4 h-4 ${tc.muted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            ) : (
              <svg className={`w-4 h-4 ${tc.muted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
            )}
          </div>
        )}

        {/* Info section */}
        <div className="flex-1 min-w-0 overflow-hidden flex flex-col justify-center">
          <div className="flex items-center gap-2">
            <h3
              className={`text-sm ${font} font-medium tracking-tight line-clamp-2 ${
                reminderGlow && !selected ? 'animate-text-rgb' : ''
              } ${tc.text}`}
              title={drop.name}
            >
              {drop.name}
            </h3>
            {/* Reminder-active clock badge — previously bundled with the creator-name pill.
                Creator names are always 'local' in this single-user vault; owner asked the
                word removed, so only the badge remains (glow state stays visible). */}
            {reminderGlow && (
              <span className={`shrink-0 flex items-center gap-1 px-1.5 h-5 ${tc.roundedClass} ${theme === 'dark' ? 'bg-white/10 text-white/70' : 'bg-[#1A1A1A]/10 text-[#1A1A1A]/60'}`} title="Reminder active">
                <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            )}
          </div>
          <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 text-xs ${font} ${tc.muted}`}>
            {drop.type === 'file' && drop.fileSize != null && (
              <span>{formatFileSize(drop.fileSize).toLowerCase()}</span>
            )}
            {drop.type === 'text' && (
              hasLoaded.current ? (
                <span>{`${displayContent.length} chars`}</span>
              ) : (
                <span className={tc.muted}>loading…</span>
              )
            )}
            {youtubeVideoId && (
              <span className="flex items-center gap-1" title="YouTube link">
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M23.5 6.19a3.02 3.02 0 00-2.12-2.14C19.5 3.55 12 3.55 12 3.55s-7.5 0-9.38.5A3.02 3.02 0 00.5 6.19C0 8.07 0 12 0 12s0 3.93.5 5.81a3.02 3.02 0 002.12 2.14c1.88.5 9.38.5 9.38.5s7.5 0 9.38-.5a3.02 3.02 0 002.12-2.14C24 15.93 24 12 24 12s0-3.93-.5-5.81zM9.55 15.57V8.43L15.82 12l-6.27 3.57z"/>
                </svg>
              </span>
            )}
            <span className={tc.muted}>
              {getTimeRemaining(drop.expiresAt)}
            </span>
          </div>
          {/* Text preview - single line truncated */}
          {!selectionMode && drop.type === 'text' && displayContent && !thumbnailSrc && !youtubeVideoId && (
            <p className={`text-xs mt-1 ${font} ${tc.muted} line-clamp-1`}>
              <DropMentionContent
                content={displayContent}
                allDrops={allDrops}
                onPreview={onPreview}
                foundClassName={mentionFoundClass}
                deletedClassName={mentionDeletedClass}
              />
            </p>
          )}
        </div>

        {/* Action buttons */}
        {!selectionMode && !confirmDelete && (
          <div className={`flex flex-wrap items-center justify-end sm:justify-start gap-2 sm:gap-1 flex-shrink-0 pt-2 sm:pt-0 border-t ${tc.border} sm:border-t-0 mt-2 sm:mt-0 w-full sm:w-auto`}>
            {showMoveControls && canMoveUp && (
              <button
                onClick={(e) => { e.stopPropagation(); onMoveUp?.(drop.id); }}
                title="Move up"
                className={`p-2 sm:p-1.5 border ${tc.border} ${tc.text} rounded ${tc.btnHoverBg} ${tc.btnHoverText} ${tc.hoverBorder} transition-colors`}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
                </svg>
              </button>
            )}
            {showMoveControls && canMoveDown && (
              <button
                onClick={(e) => { e.stopPropagation(); onMoveDown?.(drop.id); }}
                title="Move down"
                className={`p-2 sm:p-1.5 border ${tc.border} ${tc.text} rounded ${tc.btnHoverBg} ${tc.btnHoverText} ${tc.hoverBorder} transition-colors`}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            )}
            {canCopyContent && (
              <button
                onClick={handleCopy}
                className={`p-2 sm:px-4 sm:py-1.5 border ${tc.border} ${tc.text} rounded ${tc.btnHoverBg} ${tc.btnHoverText} ${tc.hoverBorder} transition-colors`}
                title={copied ? 'Copied!' : 'Copy content'}
              >
                {copied ? (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5" />
                  </svg>
                )}
              </button>
            )}
            {drop.type === 'file' && (
              <button
                onClick={handleSaveAs}
                disabled={isDownloading}
                className={`p-2 sm:px-4 sm:py-1.5 border ${tc.border} ${tc.text} rounded ${tc.btnHoverBg} ${tc.btnHoverText} ${tc.hoverBorder} transition-colors disabled:opacity-50`}
                title="Download (Save As)"
              >
                {isDownloading ? (
                  <div className="w-3.5 h-3.5 border border-current/30 border-t-current animate-spin rounded-full" />
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M12 12.75v-7.5m0 7.5l-3-3m3 3l3-3" />
                  </svg>
                )}
              </button>
            )}
            {hasAttachedImage && (
              <button
                onClick={handleSaveImageAs}
                disabled={isDownloading}
                className={`p-2 sm:p-1.5 border ${tc.border} ${tc.text} rounded ${tc.btnHoverBg} ${tc.btnHoverText} ${tc.hoverBorder} transition-colors disabled:opacity-50`}
                title="Download image (Save As)"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </button>
            )}
            {/* FIX 11: the visible card pencil is GONE. Editing stays reachable ONLY via the
                preview panel's Edit button and the right-click context menu (both untouched). */}
            <button
              onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
              className={`p-2 sm:p-1.5 border ${tc.border} ${tc.text} rounded hover:border-red-400 hover:text-red-500 transition-colors`}
              title="Delete"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
              </svg>
            </button>
          </div>
        )}

        {/* Inline delete confirmation */}
        {!selectionMode && confirmDelete && (
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }}
              className={`px-3 h-8 flex items-center justify-center ${tc.roundedClass} border ${tc.border} ${tc.inactivePillText} ${tc.inactivePillHoverBg} transition-colors text-xs ${font}`}
            >
              Cancel
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(drop); }}
              className={`px-3 h-8 flex items-center justify-center gap-1 ${tc.roundedClass} bg-red-500 text-white hover:bg-red-600 transition-colors text-xs ${font}`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              Delete
            </button>
          </div>
        )}
      </div>

      {/* Text preview with thumbnail below the row */}
      {!selectionMode && drop.type === 'text' && displayContent && thumbnailSrc && (
        <div className={`px-3 pb-3 pt-0`}>
          <p className={`text-xs ${font} ${tc.muted} line-clamp-2`}>
            <DropMentionContent
              content={displayContent}
              allDrops={allDrops}
              onPreview={onPreview}
              foundClassName={mentionFoundClass}
              deletedClassName={mentionDeletedClass}
            />
          </p>
        </div>
      )}

      {/* Context menu (edit / open-in-browser / pin) */}
      {menuState && (
        <DropContextMenu
          x={menuState.x}
          y={menuState.y}
          isPinned={!!drop.pinned}
          onPin={() => onPin?.(drop)}
          onUnpin={() => onUnpin?.(drop)}
          onClose={closeMenu}
          theme={theme}
          editorial
          {...(onEdit ? { onEdit: () => { closeMenu(); onEdit(drop); } } : {})}
          {...(drop.type === 'text' && !drop.isDrawing && youtubeVideoId && !drop.locked
            ? {
                onOpenInBrowser: () => {
                  closeMenu();
                  void window.dropsync.shell.openExternal(
                    `https://www.youtube.com/watch?v=${youtubeVideoId}`
                  );
                },
              }
            : {})}
        />
      )}
    </div>
  );
});
