import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { Drop } from '../../lib/types';
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock';
import { useEscapeClose } from '../../hooks/useEscapeClose';
import { useNow } from '../../hooks/useNow';
import { formatFileSize, getYouTubeVideoId, formatReminderFire, isReminderGlowingForViewer, isTextFileDrop as isTextFile, drawingMediaKind } from '../../lib/dropsHelpers';
import { LOCAL_USER_ID } from '../../lib/types';
import { contentToPlainText } from '../../lib/dropTagUtils';
import { getEditorialThemeColors } from '../../lib/editorialTheme';
import { DropMentionContent } from '../shared/DropMentionContent';
import { useVaultStore } from '../../store/vault';
import { getCachedPreviewPayload, putCachedPreviewPayload } from '../../lib/previewPayloadCache';
import type { PreviewPayload } from '../../lib/previewPayloadCache';
import type { DropDTO } from '../../../../preload/apiTypes';

interface EditorialPreviewModalProps {
  drop: Drop;
  onClose: () => void;
  onBack: () => void;
  canBack: boolean;
  theme?: 'light' | 'dark' | 'minimal';
  isLoading?: boolean;
  allDrops?: Drop[];
  onPreview?: (drop: Drop) => void;
  /** Visible Edit affordance (M8) — routes into the same editor as right-click. */
  onEdit?: (drop: Drop) => void;
  /** Round 107 (order §4 FIX F) — Move affordance, opens the move/copy modal (web placement:
   * immediately before Edit; Copy is reachable via the in-modal toggle). */
  onMove?: (drop: Drop) => void;
  /** FIX 10: fired after a reminder dismiss with the PATCHED record the engine returned, so
   * the parent patches the list in place (animated demotion, no reload). Called with no
   * argument only if the patched record was unavailable (parent falls back to a refresh). */
  onChanged?: (updated?: DropDTO) => void;
  /** Round 112b (defect #31): the payload the MOUNT paints from — the open path consults
   * the shelf synchronously (web parity, page.tsx:584-600) so frame 1 carries content
   * instead of one empty body frame. Read ONLY by the useState initializers below; trail
   * swaps keep the modal mounted and ride the effect as before (investigation 31: swaps
   * never painted an empty frame). */
  seed?: PreviewPayload | null;
}

const SUPPORTED_VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/ogg']);

/**
 * Desktop port of the web's EditorialPreviewModal. Render matrix: text / attached image /
 * image file / range-streamed video via media:// / generic file fallback. Share and the
 * YouTube iframe are stripped — links render as text (offline-first); Download uses the
 * native Save As dialog every time.
 */
export function EditorialPreviewModal({ drop, onClose, onBack, canBack, theme = 'light', isLoading = false, seed = null, allDrops = [], onPreview, onEdit, onMove, onChanged }: EditorialPreviewModalProps) {
  useBodyScrollLock();
  // Esc routes through the same close path as the X (polish sweep #3).
  useEscapeClose(true, onClose);
  const [copied, setCopied] = useState(false);
  // Reminder visibility (web parity): live fire-time chip in the header + Dismiss in the footer.
  // Local flag keeps the button honest between the patch landing and the parent refresh.
  const [reminderDismissed, setReminderDismissed] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Round 112b (#31): initial values come from the mount seed so the FIRST paint carries
  // the payload (web parity). The mount effect below still runs — its reset + cache-hit
  // re-set batch into one commit of identical content (invisible); on a miss it still
  // shows the honest skeleton. Never read after mount: trail swaps ride the effect.
  const [textContent, setTextContent] = useState<string>(seed?.text ?? '');
  const [fileUrl, setFileUrl] = useState<string | null>(seed?.fileUrl ?? null);
  const [imageUrl, setImageUrl] = useState<string | null>(seed?.imageUrl ?? null);
  // FIX 8: REAL loading only — true while a cache-miss payload fetch is in flight. A cache hit
  // restores synchronously and this never turns on (zero loading frame on Back).
  const [internalLoading, setInternalLoading] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  // In-app YouTube player (M8 — amends the old "no embedded player" rule): the iframe mounts
  // ONLY after a deliberate play click while online; offline/failure shows the friendly line.
  const [showPlayer, setShowPlayer] = useState(false);
  const [playerBlocked, setPlayerBlocked] = useState<null | 'offline' | 'failed'>(null);
  const reducedMotion = useReducedMotion() ?? false;
  const { fetchTextPayload, getMediaUrl } = useVaultStore();

  const isImage = drop.mimeType?.startsWith('image/');
  const isVideo = drop.mimeType?.startsWith('video/');
  const isSupportedVideo = isVideo && SUPPORTED_VIDEO_TYPES.has(drop.mimeType || '');
  const isText = isTextFile(drop);

  useEffect(() => {
    let cancelled = false;
    setFileUrl(null);
    setImageUrl(null);
    setTextContent('');
    setVideoReady(false);
    setShowPlayer(false);
    setPlayerBlocked(null);
    setReminderDismissed(false);
    // FIX 8 (web PR #212 mechanism): a cache hit restores the hydrated payload synchronously —
    // zero IPC, zero loading frame, so Back is instant. Only a cache miss pays the real fetch,
    // and it banks its result for the next visit.
    const cached = getCachedPreviewPayload(drop.id);
    if (cached) {
      setTextContent(cached.text);
      setFileUrl(cached.fileUrl);
      setImageUrl(cached.imageUrl);
      return () => { cancelled = true; };
    }
    setInternalLoading(true);
    void (async () => {
      let text = '';
      let nextFileUrl: string | null = null;
      let nextImageUrl: string | null = null;
      try {
        if (drop.type === 'text' || isText) {
          text = await fetchTextPayload(drop.id);
          if (!cancelled) setTextContent(text);
        }
        if (drop.type === 'file') {
          nextFileUrl = await getMediaUrl(drop.id, 'file');
          if (!cancelled) setFileUrl(nextFileUrl);
        }
        if (drop.type === 'text' && !!drop.imageSize) {
          nextImageUrl = await getMediaUrl(drop.id, 'image');
          if (!cancelled) setImageUrl(nextImageUrl);
        }
        if (drop.isDrawing) {
          // FIX 20: resolve through the shared slot resolver (web imports ride the image slot;
          // local drawings keep the file slot). mimeType is NOT a gate for drawings.
          nextImageUrl = await getMediaUrl(drop.id, drawingMediaKind(drop));
          if (!cancelled) setImageUrl(nextImageUrl);
        }
      } catch {
        /* placeholders stay */
      } finally {
        if (!cancelled) {
          putCachedPreviewPayload(drop.id, { text, fileUrl: nextFileUrl, imageUrl: nextImageUrl });
          setInternalLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drop.id]);

  const tc = getEditorialThemeColors(theme);
  // FIX 8: one honest busy signal — the parent's isLoading (back/close paths) plus this modal's
  // real payload fetch. The old hardcoded 400 ms fake in openPreview is gone.
  const busy = isLoading || internalLoading;
  const displayContent = textContent;
  const youtubeVideoId = displayContent && !drop.isDrawing ? getYouTubeVideoId(displayContent) : null;

  // Reminder visibility (web parity) — the same 30 s tick that drives the list tiers.
  const now = useNow(30_000);
  const reminderFire = drop.reminderAt && !reminderDismissed ? formatReminderFire(drop.reminderAt, now) : null;
  const reminderGlowing =
    !reminderDismissed &&
    !!drop.reminderAt &&
    isReminderGlowingForViewer(drop, LOCAL_USER_ID, now);

  // Light-path dismiss: writes reminderDismissedBy through the existing meta patch and hands the
  // PATCHED record to the parent (FIX 10) — in-place list patch, animated demotion, no reload.
  // Never deletes the reminder itself.
  const handleReminderDismiss = async () => {
    if (reminderDismissed) return;
    setReminderDismissed(true);
    try {
      const updated = await window.dropsync.drop.patch(drop.id, { reminderDismissedBy: LOCAL_USER_ID });
      onChanged?.(updated ?? undefined);
    } catch {
      setReminderDismissed(false); // let the user retry — nothing was persisted
    }
  };

  const handleCopy = async () => {
    const content = drop.type === 'text' ? displayContent : '';
    if (content) {
      await navigator.clipboard.writeText(contentToPlainText(content));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDownload = async () => {
    await window.dropsync.vault.saveAs(drop.id, 'file');
  };

  const handleDownloadImage = async () => {
    // FIX 20: download from wherever the drawing's PNG actually lives (slot resolver) — not
    // a hardcoded file slot, which is empty for web-imported drawings.
    await window.dropsync.vault.saveAs(drop.id, drop.isDrawing ? drawingMediaKind(drop) : 'image');
  };

  // M8: play click → online gate at THIS moment; only then does the embed mount. Offline or a
  // frame that never signals ready shows the friendly inline message — never a broken frame.
  const handleWatchToggle = () => {
    if (showPlayer) {
      setShowPlayer(false);
      setPlayerBlocked(null);
      return;
    }
    if (!navigator.onLine) {
      setPlayerBlocked('offline');
      return;
    }
    setPlayerBlocked(null);
    setShowPlayer(true);
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
      className={`fixed inset-0 bg-[#1a1a1a]/60 flex items-center justify-center z-50 p-4 transition-colors duration-300 overscroll-contain`}
      onClick={(e) => e.target === e.currentTarget && onBack()}
    >
      <div className={`${tc.bg} border ${tc.border} rounded-xl w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col transition-colors duration-300 shadow-xl`}>
        {/* Header */}
        <div className={`border-b ${tc.border} px-5 py-4 flex items-center justify-between`}>
          <div className="flex items-center gap-3">
            {canBack && (
              <button
                type="button"
                onClick={onBack}
                aria-label="Back"
                title="Back"
                className={`${tc.muted} hover:${tc.text} transition-colors text-2xl leading-none`}
              >
                <span aria-hidden>←</span>
              </button>
            )}
            <div className={`w-9 h-9 border ${tc.border} rounded-lg flex items-center justify-center`}>
              {drop.type === 'text' ? (
                <svg className={`w-4 h-4 ${tc.text}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              ) : isImage ? (
                <svg className={`w-4 h-4 ${tc.text}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              ) : isVideo ? (
                <svg className={`w-4 h-4 ${tc.text}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
                </svg>
              ) : (
                <svg className={`w-4 h-4 ${tc.text}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
              )}
            </div>
            <div>
              <h2 className={`${tc.fontClass} ${tc.text} font-medium text-[15px] line-clamp-2 max-w-[280px]`} title={drop.name}>
                {drop.name}
              </h2>
              {/* Live fire-time chip (web parity) — "Fires …" before, "Due …" once past. */}
              {reminderFire && (
                <p className={`text-xs ${tc.muted} ${tc.fontClass}`} data-reminder-chip="true">
                  {reminderFire.fired ? 'Due ' : 'Fires '}{reminderFire.absolute}{reminderFire.remaining ? ` · ${reminderFire.remaining}` : ''}
                </p>
              )}
              {drop.fileSize != null && (
                <p className={`text-xs ${tc.muted} ${tc.fontClass}`}>
                  {formatFileSize(drop.fileSize)}
                </p>
              )}
            </div>
          </div>
          <button onClick={onClose} className={`${tc.muted} hover:${tc.text} transition-colors p-1`}>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className={`flex-1 overflow-auto ${tc.bg} transition-colors duration-300`}>
          {busy && (
            <div className="p-6 space-y-4">
              <div className="animate-pulse bg-[#1a1a1a]/10 h-4 w-1/3 rounded" />
              <div className="animate-pulse bg-[#1a1a1a]/10 h-3 w-full rounded" />
              <div className="animate-pulse bg-[#1a1a1a]/10 h-3 w-5/6 rounded" />
              <p className={`${tc.fontClass} ${tc.muted} text-sm text-center pt-4`}>
                Decrypting...
              </p>
            </div>
          )}

          {/* Text body */}
          {!busy && drop.type === 'text' && (displayContent || imageUrl) && (
            <div className="p-5 space-y-4">
              {displayContent && (
                <div
                  className={isFullscreen ? 'fixed inset-0 z-[999] bg-black/40 flex items-center justify-center p-4' : 'relative'}
                  onClick={(e) => isFullscreen && e.target === e.currentTarget && setIsFullscreen(false)}
                >
                  <div className={`relative border ${tc.border} ${tc.bg} rounded-lg ${isFullscreen ? 'w-full h-[calc(100dvh-32px)] overflow-hidden p-4' : 'p-4'}`}>
                    <button
                      type="button"
                      onClick={() => setIsFullscreen(!isFullscreen)}
                      className={`absolute top-2 right-2 z-10 w-8 h-8 flex items-center justify-center ${tc.btnBg} ${tc.text} ${tc.btnHoverBg} ${tc.btnHoverText} ${tc.roundedClass} transition-colors`}
                      title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                    >
                      {fullscreenIcon}
                    </button>
                    <pre className={`text-sm ${tc.fontClass} ${tc.text} whitespace-pre-wrap break-all ${isFullscreen ? 'h-full overflow-y-auto' : ''}`}>
                      <DropMentionContent
                        content={displayContent}
                        allDrops={allDrops}
                        onPreview={onPreview}
                        foundClassName={`inline-flex items-center mx-0.5 px-1.5 py-0.5 align-middle rounded text-[13px] ${tc.fontClass} ${tc.activePillBg} ${tc.activePillText} hover:opacity-80`}
                        deletedClassName={`inline-flex items-center mx-0.5 px-1.5 py-0.5 align-middle rounded text-[13px] ${tc.fontClass} ${tc.inactivePillBg} ${tc.muted} line-through cursor-not-allowed`}
                      />
                    </pre>
                  </div>
                </div>
              )}
              {imageUrl && (
                <div className="flex items-center justify-center">
                  <img
                    src={imageUrl}
                    alt="Attached"
                    className={`rounded-lg object-contain ${
                      drop.isDrawing
                        ? 'max-w-[80%] max-h-[50vh] border'
                        : 'max-w-full h-auto'
                    }`}
                  />
                </div>
              )}
              {/* YouTube — cached/imported title card, in-app player on a deliberate play click
                  (M8; embed origin is the ONLY network escape hatch, CSP-gated), Open-in-browser
                  untouched (owner-declined WSL fallback). */}
              {youtubeVideoId && (
                <div className={`border ${tc.border} ${tc.roundedClass} p-3 flex items-center justify-between gap-3`}>
                  <div className="min-w-0">
                    {(() => {
                      const label = (drop.youtubeVideoLabels ?? []).find((l) => l.videoId === youtubeVideoId);
                      return label ? (
                        <>
                          <p className={`text-sm ${tc.fontClass} ${tc.text} truncate`} title={label.title}>{label.title}</p>
                          {label.channel && (
                            <p className={`text-xs ${tc.muted} ${tc.fontClass} truncate`}>{label.channel}</p>
                          )}
                        </>
                      ) : (
                        <p className={`text-xs ${tc.muted} ${tc.fontClass}`}>
                          YouTube link detected — no cached title yet.
                        </p>
                      );
                    })()}
                  </div>
                  <button
                    type="button"
                    onClick={() => void window.dropsync.shell.openExternal(`https://www.youtube.com/watch?v=${youtubeVideoId}`)}
                    className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border ${tc.border} ${tc.text} hover:border-[#1a1a1a] transition-colors ${tc.fontClass}`}
                    title="Open in your default browser"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
                    </svg>
                    Open in browser
                  </button>
                </div>
              )}
              {/* The player area itself — mounts only after Watch video (online), mirroring the
                  web's iframe exactly (origin + allow list + fullscreen). Reveal animates with
                  the app's easing family (height + opacity, ~350 ms, reduced-motion aware);
                  closing UNMOUNTS the iframe so nothing keeps playing (FIX 4). The wrapper uses
                  the same p-5 + bordered rounded box metrics as the text/image blocks above. */}
              <AnimatePresence initial={false}>
                {!busy && showPlayer && !playerBlocked && youtubeVideoId && (
                  <motion.div
                    key="yt-player"
                    data-yt-player="true"
                    initial={reducedMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
                    animate={reducedMotion ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
                    exit={reducedMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
                    transition={{ duration: 0.35, ease: [0.4, 0, 0.2, 1] }}
                    style={{ overflow: 'hidden' }}
                  >
                    <div className={`border ${tc.border} ${tc.roundedClass} overflow-hidden`}>
                      <div className="aspect-video bg-black">
                        <iframe
                          src={`https://www.youtube-nocookie.com/embed/${youtubeVideoId}`}
                          className="w-full h-full"
                          title="YouTube video player"
                          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                          allowFullScreen
                        />
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
              {!busy && playerBlocked && (
                <div data-yt-blocked="true">
                  <p className={`border ${tc.border} ${tc.roundedClass} p-3 text-xs ${tc.fontClass} ${tc.muted}`} role="status">
                    {playerBlocked === 'offline'
                      ? "You're offline — connect to the internet to watch."
                      : 'The video could not be loaded — check your connection and try again.'}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Text file rendered as text */}
          {!busy && isText && drop.type === 'file' && displayContent && (
            <div className="p-5">
              <div className={`border ${tc.border} ${tc.bg} rounded-lg p-4`}>
                <pre className={`text-sm ${tc.fontClass} ${tc.text} whitespace-pre-wrap break-all max-h-[50vh] overflow-auto`}>
                  {displayContent}
                </pre>
              </div>
            </div>
          )}

          {/* Image file */}
          {!busy && isImage && fileUrl && (
            <div className="p-5 flex items-center justify-center">
              <img
                src={fileUrl}
                alt={drop.name}
                className="max-w-full max-h-[50vh] object-contain rounded-lg border"
              />
            </div>
          )}

          {/* Video — streamed with Range support so big files seek */}
          {!busy && drop.type === 'file' && isVideo && (
            <div className="flex items-center justify-center p-5 min-h-[300px]">
              {isSupportedVideo && fileUrl ? (
                <div className={`relative aspect-video max-h-[50vh] w-full overflow-hidden rounded-lg border ${tc.border} bg-black`}>
                  <video
                    src={fileUrl}
                    controls
                    onCanPlay={() => setVideoReady(true)}
                    onError={() => setVideoReady(true)}
                    className={`h-full w-full object-contain ${videoReady ? '' : 'opacity-0'}`}
                  >
                    Your browser does not support video playback.
                  </video>
                  {!videoReady && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                      <div className={`animate-pulse ${tc.muted} ${tc.fontClass}`}>Loading video...</div>
                    </div>
                  )}
                </div>
              ) : !isSupportedVideo ? (
                <div className="flex flex-col items-center justify-center">
                  <div className={`w-16 h-16 border ${tc.border} rounded-lg flex items-center justify-center mb-4`}>
                    <svg className={`w-8 h-8 ${tc.muted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
                    </svg>
                  </div>
                  <p className={`${tc.fontClass} ${tc.muted} text-sm`}>
                    Video preview not available for this format
                  </p>
                  <p className={`${tc.fontClass} ${tc.muted} text-xs mt-1`}>
                    Download to watch
                  </p>
                </div>
              ) : (
                <div className={`animate-pulse ${tc.muted} ${tc.fontClass}`}>Loading video...</div>
              )}
            </div>
          )}

          {/* Other files */}
          {!busy && !isText && !isImage && !isVideo && drop.type === 'file' && (
            <div className="p-5 flex flex-col items-center justify-center min-h-[200px]">
              <div className={`w-16 h-16 border ${tc.border} rounded-lg flex items-center justify-center mb-4`}>
                <svg className={`w-8 h-8 ${tc.muted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
              </div>
              <p className={`${tc.fontClass} ${tc.muted} text-sm`}>
                Preview not available for this file type
              </p>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className={`border-t ${tc.border} px-5 py-4 flex items-center justify-between`}>
          <div className="flex items-center gap-2">
            {(drop.type === 'text' || isText) && (
              <button
                onClick={handleCopy}
                disabled={!displayContent}
                className={`flex items-center gap-2 px-4 py-2 rounded-md border ${tc.border} ${tc.text} hover:border-[#1a1a1a] transition-all text-sm ${tc.fontClass} disabled:opacity-50`}
              >
                {copied ? (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    Copied
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                    Copy
                  </>
                )}
              </button>
            )}

            {/* YouTube Watch toggle (M8) — same control as the web's player */}
            {youtubeVideoId && (
              <button
                onClick={handleWatchToggle}
                className={`flex items-center gap-2 px-2 sm:px-4 py-2 rounded-md border ${tc.border} ${tc.text} hover:bg-[#FF0000] hover:text-white hover:border-[#FF0000] transition-all text-sm ${tc.fontClass}`}
                title="Watch video"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
                <span className="hidden sm:inline">{showPlayer ? 'Close' : 'Watch video'}</span>
              </button>
            )}

            {/* Dismiss reminder (web parity) — only while glowing for this viewer; light-path
                meta write, never deletes the reminder. */}
            {reminderGlowing && (
              <button
                onClick={() => void handleReminderDismiss()}
                className={`flex items-center gap-2 px-2 sm:px-4 py-2 rounded-md border ${tc.border} ${tc.text} hover:border-[#1a1a1a] transition-all text-sm ${tc.fontClass}`}
                title="Dismiss reminder"
                aria-label="Dismiss reminder"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="hidden sm:inline">Dismiss</span>
              </button>
            )}

            {/* Move (round 107) — opens the move/copy modal (web PreviewModal.tsx:583-594 placement:
                immediately before Edit; Copy is reachable via the in-modal toggle) */}
            {onMove && (
              <button
                onClick={() => onMove(drop)}
                className={`flex items-center gap-2 px-2 sm:px-4 py-2 rounded-md border ${tc.border} ${tc.text} hover:border-[#1a1a1a] transition-all text-sm ${tc.fontClass}`}
                title="Move or copy to another space"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 7.5L7.5 3m0 0L12 7.5M7.5 3v13.5M12 16.5l4.5-4.5m0 0L21 16.5M16.5 12V3" />
                </svg>
                <span className="hidden sm:inline">Move</span>
              </button>
            )}

            {/* Edit (M8) — routes into the existing editor path */}
            {onEdit && (
              <button
                onClick={() => onEdit(drop)}
                className={`flex items-center gap-2 px-2 sm:px-4 py-2 rounded-md border ${tc.border} ${tc.text} hover:border-[#1a1a1a] transition-all text-sm ${tc.fontClass}`}
                title="Edit"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                </svg>
                <span className="hidden sm:inline">Edit</span>
              </button>
            )}

            {drop.type === 'file' && (
              <button
                onClick={handleDownload}
                className={`flex items-center gap-2 px-2 sm:px-4 py-2 rounded-md border ${tc.border} ${tc.text} hover:border-[#1a1a1a] transition-all text-sm ${tc.fontClass}`}
                title="Download (Save As)"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                <span className="hidden sm:inline">Download</span>
              </button>
            )}

            {drop.type === 'text' && imageUrl && (
              <button
                onClick={handleDownloadImage}
                className={`flex items-center gap-2 px-2 sm:px-4 py-2 rounded-md border ${tc.border} ${tc.text} hover:border-[#1a1a1a] transition-all text-sm ${tc.fontClass}`}
                title="Download Image (Save As)"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                <span className="hidden sm:inline">Download Image</span>
              </button>
            )}
          </div>

          <span className={`text-xs ${tc.muted} ${tc.fontClass}`}>Local vault</span>
        </div>
      </div>
    </div>
  );
}
