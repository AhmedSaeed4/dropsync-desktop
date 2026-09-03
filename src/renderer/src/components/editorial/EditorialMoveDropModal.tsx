import { useState } from 'react';
import type { Drop } from '../../lib/types';
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock';
import { useModalBackClose } from '../../hooks/useModalBackClose';
import { getEditorialThemeColors } from '../../lib/editorialTheme';
import { useVaultStore } from '../../store/vault';

/**
 * Desktop port of the web's EditorialMoveDropModal
 * (drag-drop-app/src/components/editorial/EditorialMoveDropModal.tsx, 273 lines — order 107 §4
 * FIX E / W2). Same shape: Move|Copy toggle · fixed "From" box · "To" list (Personal first,
 * then workspaces, current location disabled + greyed) · warnings block · Cancel + submit with
 * an inline spinner; submit disabled when the target IS the current location; hardware-back and
 * backdrop close only when NOT busy (web :36-37/:78).
 *
 * Desktop deltas (order §4 FIX E, ALL required):
 * - `spaces`/`currentSpaceId`/`currentSpaceName` come from useVaultStore() directly (the list
 *   already imports the store — order D9); the store's spaces memo INCLUDES Personal, so the
 *   "To" list derives with spaces.filter(s => s.id !== 'personal').
 * - The handlers take ONLY the target (the ids are already known to the caller); the Personal
 *   option targets null internally and passes 'personal' (the main-side space id).
 * - NO LockedActionButton, NO ForeverLockedModal, NO tier logic, NO `locked` gating — the
 *   desktop has one local user, no accounts, no tiers (order §3).
 * - NEW: a themed in-modal error banner populated via the `error` prop — web's failure
 *   `alert(...)` has no desktop counterpart (order D16); the wording comes from the caller
 *   (exact web text).
 */

interface EditorialMoveDropModalProps {
  drops: Drop[];
  onMove: (targetSpaceId: string) => Promise<void>;
  onCopy: (targetSpaceId: string) => Promise<void>;
  onClose: () => void;
  theme?: 'light' | 'dark' | 'minimal';
  /** In-modal failure banner text (web's alert() wording, set by the caller). */
  error?: string | null;
}

export function EditorialMoveDropModal({ drops, onMove, onCopy, onClose, theme = 'light', error = null }: EditorialMoveDropModalProps) {
  useBodyScrollLock();
  const { spaces, currentSpaceId, currentSpaceName } = useVaultStore();
  const isBulk = drops.length > 1;
  const firstDrop = drops[0];

  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(currentSpaceId);
  const [mode, setMode] = useState<'move' | 'copy'>('move');
  const [loading, setLoading] = useState(false);
  // Back closes only when not mid move/copy (matches the disabled X/backdrop) — web :36-37.
  useModalBackClose(true, () => { if (!loading) onClose(); });

  const tc = getEditorialThemeColors(theme);

  const workspaceList = spaces.filter((s) => s.id !== 'personal');
  const targetName = selectedSpaceId === null
    ? 'Personal'
    : spaces.find((s) => s.id === selectedSpaceId)?.name || 'Unknown';

  const allSameLocation = drops.every((d) => d.workspaceId === firstDrop.workspaceId);
  const isSameLocation = selectedSpaceId === currentSpaceId;

  const handleSubmit = async () => {
    if (isSameLocation) return;
    setLoading(true);
    // Personal targets null internally (the web's workspaceId contract); main's space id is
    // the literal 'personal' (vaultTypes.ts:22).
    const target = selectedSpaceId === null ? 'personal' : selectedSpaceId;
    if (mode === 'copy') await onCopy(target);
    else await onMove(target);
    setLoading(false);
  };

  return (
    <div
      className="fixed inset-0 bg-[#1a1a1a]/60 flex items-center justify-center z-50 p-4"
      onClick={(e) => e.target === e.currentTarget && !loading && onClose()}
    >
      <div className={`${tc.bg} border ${tc.border} rounded-xl w-full max-w-md max-h-[90vh] flex flex-col overflow-hidden shadow-xl`}>
        {/* Header */}
        <div className={`border-b ${tc.border} px-5 py-4 flex items-center justify-between shrink-0`}>
          <div>
            <h2 className={`${tc.fontClass} ${tc.text} font-medium text-[15px]`}>
              {isBulk ? `${mode === 'copy' ? 'Copy' : 'Move'} ${drops.length} drops` : (mode === 'copy' ? 'Copy drop' : 'Move drop')}
            </h2>
            {!isBulk && (
              <p className={`text-[11px] ${tc.muted} mt-0.5 truncate max-w-[250px] ${tc.fontClass}`}>
                {firstDrop.name}
              </p>
            )}
          </div>
          <button onClick={() => !loading && onClose()} disabled={loading} className={`${tc.muted} hover:${tc.text} transition-colors p-1 disabled:opacity-50`}>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 flex-1 min-h-0 overflow-y-auto thin-scrollbar">
          {/* Mode toggle: Move / Copy (web :102-124) */}
          <div className={`flex p-0.5 border ${tc.border} ${tc.bg} rounded-lg`}>
            <button
              type="button"
              onClick={() => setMode('move')}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs ${tc.fontClass} rounded-md transition-colors ${mode === 'move' ? `${tc.activePillBg} ${tc.activePillText}` : `${tc.muted} hover:${tc.text}`}`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4M16 17H4m0 0l4-4m-4 4l4 4" />
              </svg>
              <span>Move</span>
            </button>
            <button
              type="button"
              onClick={() => setMode('copy')}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs ${tc.fontClass} rounded-md transition-colors ${mode === 'copy' ? `${tc.activePillBg} ${tc.activePillText}` : `${tc.muted} hover:${tc.text}`}`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              <span>Copy</span>
            </button>
          </div>

          {/* Current location (web :126-132) — the store's current space, fixed. */}
          <div>
            <label className={`text-xs ${tc.muted} ${tc.fontClass} mb-1.5 block`}>From</label>
            <div className={`border ${tc.border} ${tc.bg} rounded-lg px-3 py-2.5`}>
              <span className={`text-sm ${tc.text} ${tc.fontClass}`}>{currentSpaceName}{isBulk ? ` (${drops.length} drops)` : ''}</span>
            </div>
          </div>

          {/* Target selector (web :134-179) — Personal first, then the workspaces; the CURRENT
              location row is disabled + greyed (web :148, :166-170). */}
          <div>
            <label className={`text-xs ${tc.muted} ${tc.fontClass} mb-1.5 block`}>To</label>
            <div className="space-y-1.5">
              {/* Personal option */}
              <button
                onClick={() => setSelectedSpaceId(null)}
                className={`w-full text-left px-3 py-2.5 border ${tc.border} rounded-lg transition-colors flex items-center justify-between ${
                  selectedSpaceId === null
                    ? `${tc.activePillBg}`
                    : allSameLocation && currentSpaceId === null
                    ? `${tc.muted} opacity-40 cursor-not-allowed`
                    : `${tc.hoverBorder}`
                }`}
                disabled={allSameLocation && currentSpaceId === null}
              >
                <span className={`text-sm ${selectedSpaceId === null ? tc.activePillText : tc.text} ${tc.fontClass}`}>Personal</span>
                {selectedSpaceId === null && (
                  <svg className={`w-4 h-4 ${tc.activePillText}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>

              {/* Workspace options (the store's spaces memo INCLUDES Personal — filter it out) */}
              {workspaceList.map((ws) => (
                <button
                  key={ws.id}
                  onClick={() => setSelectedSpaceId(ws.id)}
                  className={`w-full text-left px-3 py-2.5 border ${tc.border} rounded-lg transition-colors flex items-center justify-between ${
                    selectedSpaceId === ws.id
                      ? `${tc.activePillBg}`
                      : allSameLocation && currentSpaceId === ws.id
                      ? `${tc.muted} opacity-40 cursor-not-allowed`
                      : `${tc.hoverBorder}`
                  }`}
                  disabled={allSameLocation && currentSpaceId === ws.id}
                >
                  <span className={`text-sm ${selectedSpaceId === ws.id ? tc.activePillText : tc.text} ${tc.fontClass}`}>{ws.name}</span>
                  {selectedSpaceId === ws.id && (
                    <svg className={`w-4 h-4 ${tc.activePillText}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Warnings (web :183-212) — the copy-created line and the moved/removed line are
              kept VERBATIM; the member-access sentences (:190, :200-208) are DROPPED — there is
              no sharing on desktop (order §4 FIX E). */}
          {!isSameLocation && (
            <div className={`border ${tc.border} ${tc.bg} rounded-lg px-3 py-2.5 ${tc.fontClass} space-y-1`}>
              {mode === 'copy' ? (
                <>
                  <p className={`text-xs ${tc.muted}`}>A copy will be created in {targetName}. The original stays in {currentSpaceName}.</p>
                  <p className={`text-xs ${tc.muted}`}>Reminders carry over to the copy.</p>
                </>
              ) : (
                <p className={`text-xs ${tc.muted}`}>
                  {isBulk
                    ? `These ${drops.length} drops will be moved to ${targetName} and removed from ${currentSpaceName}.`
                    : `This drop will be moved to ${targetName} and removed from ${currentSpaceName}.`}
                </p>
              )}
            </div>
          )}

          {/* In-modal failure banner (desktop-only — web's alert() has no desktop counterpart,
              order D16; the caller supplies web's exact wording). */}
          {error && (
            <div className={`border border-red-500/60 bg-red-500/10 rounded-lg px-3 py-2.5 ${tc.fontClass}`}>
              <p className="text-xs text-red-500">{error}</p>
            </div>
          )}
        </div>

        {/* Footer (web :215-265) — no LockedActionButton branch: no tiers on desktop (§3). */}
        <div className={`border-t ${tc.border} px-5 py-4 flex items-center justify-end gap-3 shrink-0`}>
          <button
            onClick={onClose}
            disabled={loading}
            className={`border ${tc.border} ${tc.text} px-4 py-2 text-sm rounded-lg ${tc.hoverBorder} transition-colors disabled:opacity-50 ${tc.fontClass}`}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSameLocation || loading}
            className={`px-4 py-2 text-sm rounded-lg disabled:opacity-50 flex items-center gap-2 ${tc.activePillBg} ${tc.activePillText} hover:opacity-90 transition-opacity ${tc.fontClass}`}
          >
            {loading ? (
              <>
                <div className={`w-4 h-4 border border-white/30 border-t-white animate-spin rounded-full`} />
                {mode === 'copy' ? 'Copying...' : 'Moving...'}
              </>
            ) : (
              <>
                {mode === 'copy' ? (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 7.5L7.5 3m0 0L12 7.5M7.5 3v13.5M12 16.5l4.5-4.5m0 0L21 16.5M16.5 12V3" />
                  </svg>
                )}
                {mode === 'copy' ? 'Copy' : 'Move'}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
