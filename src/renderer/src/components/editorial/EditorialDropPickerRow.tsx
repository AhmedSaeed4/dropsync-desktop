/**
 * Desktop port of EditorialDropPickerRow — the #-mention autocomplete row. Firebase decryption
 * becomes a lazy IPC text-payload fetch; YouTube thumbnails stay a neutral icon (offline audit:
 * no img.youtube.com, ever). Structure/classes mirror the web row.
 */

import { useEffect, useState } from 'react';
import type { Drop } from '../../lib/types';
import { formatFileSize, getTimeRemaining } from '../../lib/dropsHelpers';
import { getEditorialThemeColors } from '../../lib/editorialTheme';
import { useVaultStore } from '../../store/vault';

interface EditorialDropPickerRowProps {
  drop: Drop;
  selected: boolean;
  attached: boolean;
  onSelect: (drop: Drop) => void;
  theme: 'light' | 'dark' | 'minimal';
}

export function EditorialDropPickerRow({ drop, selected, attached, onSelect, theme }: EditorialDropPickerRowProps) {
  const tc = getEditorialThemeColors(theme);
  const { fetchTextPayload } = useVaultStore();
  const [textContent, setTextContent] = useState<string>(drop.content ?? '');

  const isVideo = drop.mimeType?.startsWith('video/');

  // Lazy content fetch for the preview line (desktop's decrypt-deferral analogue).
  useEffect(() => {
    let cancelled = false;
    if (drop.type === 'text' && !drop.content) {
      void fetchTextPayload(drop.id).then((text) => {
        if (!cancelled) setTextContent(text);
      }).catch(() => {});
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drop.id]);

  const displayContent = drop.type === 'text' ? textContent : '';

  return (
    <button
      onPointerDown={(e) => e.preventDefault()}
      type="button"
      disabled={attached}
      onClick={() => !attached && onSelect(drop)}
      data-drop-highlighted={selected}
      className={`w-full text-left px-4 py-2.5 flex items-center gap-3 ${tc.fontClass} ${
        attached
          ? 'opacity-50 cursor-not-allowed'
          : selected
            ? `${tc.activePillBg} ${tc.activePillText}`
            : `${tc.text} hover:bg-black/5`
      }`}
    >
      {/* Thumbnail box ~48x48 — image-first hierarchy (Editorial). Offline placeholders only. */}
      <div className={`w-12 h-12 flex-shrink-0 flex items-center justify-center overflow-hidden rounded ${tc.inactivePillBg}`}>
        {isVideo ? (
          <svg className={`w-4 h-4 ${tc.muted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
          </svg>
        ) : drop.type === 'text' ? (
          <svg className={`w-4 h-4 ${tc.muted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
            <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        ) : (
          <svg className={`w-4 h-4 ${tc.muted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
            <path d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
          </svg>
        )}
      </div>

      {/* Name + metadata column */}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium tracking-tight truncate">
          {drop.name}
        </div>
        <div className={`flex items-center gap-2 mt-0.5 min-w-0 text-xs ${tc.fontClass} ${selected ? tc.activePillText : tc.muted}`}>
          {drop.type === 'file' && !!drop.fileSize && (
            <span>{formatFileSize(drop.fileSize).toLowerCase()}</span>
          )}
          {drop.type === 'text' && (
            <span>{`${displayContent.length} chars`}</span>
          )}
          {drop.locked && (
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          )}
          <span>{getTimeRemaining(drop.expiresAt)}</span>
        </div>
        {/* Text preview — 1 line */}
        {drop.type === 'text' && displayContent && (
          <div className={`mt-0.5 text-xs ${tc.fontClass} ${selected ? tc.activePillText : tc.muted} line-clamp-1`}>
            {displayContent}
          </div>
        )}
      </div>

      {/* Attached checkmark */}
      {attached && (
        <svg className="w-4 h-4 flex-shrink-0 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      )}
    </button>
  );
}
