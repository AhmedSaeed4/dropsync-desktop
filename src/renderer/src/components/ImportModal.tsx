import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ArchiveInspectionDTO,
  ImportDestinationDTO,
  ImportProgressDTO,
  ImportResultDTO,
} from '../../../preload/apiTypes';
import { useEscapeClose } from '../hooks/useEscapeClose';
import { getEditorialThemeColors } from '../lib/editorialTheme';
import { useVaultStore } from '../store/vault';
import { EditorialSelect } from './editorial/EditorialSelect';

interface ImportModalProps {
  theme?: 'light' | 'dark' | 'minimal';
  /** Which entry point opened the modal — drives the wrong-flavor wording. */
  expectedScope: 'personal' | 'workspace';
  spaces: Array<{ id: string; name: string }>;
  currentSpaceName: string;
  onClose: () => void;
  onImported: (result: ImportResultDTO) => void;
}

const ARCHIVE_EXTENSION = 'dropsync';

/**
 * The import flow — the web's WorkspaceArchiveModal (editorial skin) rewired onto IPC.
 * One engine handles both flavors: inspect detects the manifest schema, then either restores
 * into Personal or asks for a destination workspace (new ≤120 chars / merge). Duplicate-
 * archive warning included.
 */
export function ImportModal({
  theme = 'light',
  expectedScope,
  spaces,
  onClose,
  onImported,
}: ImportModalProps) {
  const tc = getEditorialThemeColors(theme);
  const isDark = theme === 'dark';
  const [password, setPassword] = useState('');
  const [filePath, setFilePath] = useState<string | null>(null);
  const [inspection, setInspection] = useState<ArchiveInspectionDTO | null>(null);
  const [destinationMode, setDestinationMode] = useState<'new' | 'merge'>('new');
  const [workspaceName, setWorkspaceName] = useState('');
  const [targetSpaceId, setTargetSpaceId] = useState(spaces[0]?.id ?? '');
  const [progress, setProgress] = useState<ImportProgressDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completeMessage, setCompleteMessage] = useState<string | null>(null);
  const [checkingOverlap, setCheckingOverlap] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState(false);
  const busyRef = useRef(false);

  useEffect(() => {
    const off = window.dropsync.onImportProgress((p) => setProgress(p));
    return () => { off(); };
  }, []);

  // Wrong-flavor wording (desktop-adapted per spec M1).
  const mismatchNote = useMemo(() => {
    if (!inspection) return null;
    if (expectedScope === 'personal' && inspection.flavor === 'dropsync.workspace') {
      return 'This is a workspace backup — choose a workspace to restore it into.';
    }
    if (expectedScope === 'workspace' && inspection.flavor === 'dropsync.personal') {
      return 'This is a personal backup — it restores into your Personal space.';
    }
    return null;
  }, [inspection, expectedScope]);

  const isPersonalFlavor = inspection?.flavor === 'dropsync.personal';

  const pickFile = async () => {
    const picked = await window.dropsync.dialog.pickOpen({
      title: 'Choose a .dropsync backup',
      extensions: [ARCHIVE_EXTENSION],
    });
    if (picked) {
      setFilePath(picked);
      setInspection(null);
      setDuplicateWarning(false);
      setError(null);
      setCompleteMessage(null);
      const base = picked.split(/[\\/]/).pop()?.replace(/\.dropsync$/i, '') ?? '';
      setWorkspaceName(`${base || 'Restored'} Restored`.slice(0, 120));
    }
  };

  const handleInspect = async () => {
    if (!filePath) {
      setError('Choose a .dropsync file first.');
      return;
    }
    if (password.length < 8) {
      setError('Use the password that protects this archive.');
      return;
    }
    setBusy(true);
    setError(null);
    setCompleteMessage(null);
    try {
      const result = await window.dropsync.vault.importInspect(filePath, password);
      setInspection(result);
      if (result.flavor === 'dropsync.workspace') {
        setWorkspaceName(`${result.sourceName || 'Restored'} Restored`.slice(0, 120));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The archive operation failed.');
    } finally {
      setBusy(false);
    }
  };

  const destinationFor = (): ImportDestinationDTO | null => {
    if (!inspection) return null;
    if (isPersonalFlavor) return { mode: 'personal' };
    if (destinationMode === 'new') return { mode: 'new', name: workspaceName.trim() };
    return { mode: 'merge', spaceId: targetSpaceId };
  };

  const runImport = async () => {
    if (!filePath || !inspection) return;
    const destination = destinationFor();
    if (!destination) return;
    const result = await window.dropsync.vault.importRun({ filePath, password, destination });
    const details = [
      `Imported ${result.importedCount} drop${result.importedCount === 1 ? '' : 's'}.`,
      result.legacyExpiryFallbackCount
        ? 'This older backup had no saved remaining-time data, so finite drops restarted from their saved duration.'
        : 'Finite drop timers resumed from their saved remaining time.',
      result.zeroRemainingCount
        ? `${result.zeroRemainingCount} drop${result.zeroRemainingCount === 1 ? '' : 's'} may expire immediately after import.`
        : '',
      result.unpinnedCount ? `${result.unpinnedCount} pin${result.unpinnedCount === 1 ? '' : 's'} adjusted for the two-pin limit.` : '',
      ...result.warnings,
    ].filter(Boolean);
    setCompleteMessage(details.join(' '));
    setDuplicateWarning(false);
    setInspection(null);
    onImported(result);
  };

  const handleImport = async () => {
    if (!filePath || !inspection) return;
    const destination = destinationFor();
    if (!isPersonalFlavor && destinationMode === 'new' && !workspaceName.trim()) {
      setError('Enter a name for the restored workspace.');
      return;
    }
    if (!isPersonalFlavor && destinationMode === 'merge' && !targetSpaceId) {
      setError('Choose a destination workspace.');
      return;
    }
    const overlapCheck =
      !isPersonalFlavor && destinationMode === 'merge'
        ? window.dropsync.vault.hasArchiveOverlap(targetSpaceId, inspection.archiveId)
        : isPersonalFlavor
          ? window.dropsync.vault.hasArchiveOverlap('personal', inspection.archiveId)
          : Promise.resolve(false);

    setBusy(true);
    setCheckingOverlap(true);
    try {
      const hasOverlap = await overlapCheck;
      if (hasOverlap) {
        setDuplicateWarning(true);
        return;
      }
      await runImport();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The archive operation failed.');
    } finally {
      setCheckingOverlap(false);
      busyRef.current = false;
      setBusy(false);
    }
  };

  const handleImportAnyway = async () => {
    if (!filePath || !inspection || !duplicateWarning) return;
    setDuplicateWarning(false);
    setBusy(true);
    try {
      await runImport();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The archive operation failed.');
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (busy) return;
    onClose();
  };
  // Esc uses the same guarded path (polish sweep #3).
  useEscapeClose(!busy, close);

  const progressPercent = completeMessage
    ? 100
    : progress && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.processedBytes / progress.totalBytes) * 100))
      : null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 overscroll-contain">
      <div className="fixed inset-0 bg-black/55" onClick={close} />
      <div className={`relative z-10 w-full max-w-lg border ${tc.cardBg} ${tc.border} ${tc.roundedClass} shadow-2xl overflow-hidden`}>
        <div className={`px-5 py-4 border-b ${tc.border} flex items-center justify-between`}>
          <div>
            <h2 className={`text-sm font-medium tracking-wide ${tc.fontClass} ${tc.text}`}>
              Import backup
            </h2>
            <p className={`mt-1 text-[11px] ${tc.muted}`}>
              Unlock a .dropsync backup and restore its contents into this vault.
            </p>
          </div>
          <button type="button" onClick={close} disabled={busy} className={`${tc.muted} hover:opacity-70 transition-opacity`} aria-label="Close">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className={`text-[10px] tracking-wide ${tc.fontClass} ${tc.muted}`}>Backup file</label>
            <button
              type="button"
              onClick={() => void pickFile()}
              disabled={busy}
              className={`mt-1 w-full border px-3 py-2 text-left text-sm outline-none ${tc.border} ${tc.bg} ${tc.text} ${tc.fontClass} ${tc.roundedClass} hover:border-[#1a1a1a] transition-colors truncate ${!filePath ? tc.muted : ''}`}
            >
              {filePath || 'Choose a .dropsync file…'}
            </button>
          </div>

          <div>
            <label className={`text-[10px] tracking-wide ${tc.fontClass} ${tc.muted}`}>Archive password</label>
            <input
              type="password"
              value={password}
              onChange={(event) => { setPassword(event.target.value); setInspection(null); setDuplicateWarning(false); }}
              className={`mt-1 w-full border px-3 py-2 text-sm outline-none ${tc.border} ${tc.bg} ${tc.text} ${tc.fontClass} ${tc.roundedClass}`}
              autoComplete="current-password"
            />
          </div>

          {!inspection && (
            <button type="button" onClick={() => void handleInspect()} disabled={busy || !fileValid()} className={`${buttonClass()} ${primaryClasses()}`}>
              {busy ? 'Checking…' : 'Check backup'}
            </button>
          )}

          {inspection && (
            <>
              <div className={`border ${tc.border} ${tc.roundedClass} p-3 space-y-1 text-xs ${tc.fontClass} ${tc.text}`}>
                <p><strong>{inspection.sourceName}</strong></p>
                <p className={tc.muted}>{inspection.dropCount} drops · {inspection.fileCount} files · {inspection.totalPayloadBytes.toLocaleString()} payload bytes</p>
                {mismatchNote && <p className="text-amber-600">{mismatchNote}</p>}
                {!mismatchNote && expectedScope === 'workspace' && (
                  <p className={tc.muted}>Restores into “{spaces.find(s => s.id === targetSpaceId)?.name || '…'}” or a new workspace.</p>
                )}
                {inspection.passwordDropCount > 0 && <p className="text-amber-600">Includes {inspection.passwordDropCount} password-category drop{inspection.passwordDropCount === 1 ? '' : 's'}.</p>}
                {inspection.lockedDropCount > 0 && <p className={tc.muted}>Includes {inspection.lockedDropCount} locked drop{inspection.lockedDropCount === 1 ? '' : 's'}. Locks are cosmetic in this vault.</p>}
                <p className={tc.muted}>
                  {inspection.legacyTimers
                    ? 'This older backup has no saved remaining-time data; finite drops will restart from their saved duration.'
                    : 'Finite drop timers resume with the time remaining when this backup was created.'}
                </p>
                {inspection.zeroRemainingDropCount > 0 && <p className={tc.muted}>{inspection.zeroRemainingDropCount} drop{inspection.zeroRemainingDropCount === 1 ? '' : 's'} may expire immediately after import.</p>}
              </div>

              {!isPersonalFlavor && (
                <>
                  <div>
                    <label className={`text-[10px] tracking-wide ${tc.fontClass} ${tc.muted}`}>Destination</label>
                    <div className="mt-1 flex gap-2">
                      <button type="button" onClick={() => { setDestinationMode('new'); setDuplicateWarning(false); }} className={`${buttonClass()} flex-1 border ${destinationMode === 'new' ? primaryClasses() : secondaryClasses()}`}>New workspace</button>
                      <button type="button" onClick={() => { setDestinationMode('merge'); setDuplicateWarning(false); }} className={`${buttonClass()} flex-1 border ${destinationMode === 'merge' ? primaryClasses() : secondaryClasses()}`}>Merge</button>
                    </div>
                  </div>
                  {destinationMode === 'new' ? (
                    <div>
                      <label className={`text-[10px] tracking-wide ${tc.fontClass} ${tc.muted}`}>New workspace name</label>
                      <input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} maxLength={120}
                        className={`mt-1 w-full border px-3 py-2 text-sm outline-none ${tc.border} ${tc.bg} ${tc.text} ${tc.fontClass} ${tc.roundedClass}`} />
                      <p className={`mt-1 text-[11px] ${tc.fontClass} ${tc.muted}`}>Up to 120 characters — longer names are trimmed.</p>
                    </div>
                  ) : (
                    <div>
                      <label className={`text-[10px] tracking-wide ${tc.fontClass} ${tc.muted}`}>Merge into</label>
                      <EditorialSelect
                        className="mt-1"
                        theme={theme}
                        ariaLabel="Merge into workspace"
                        value={targetSpaceId}
                        onChange={(v) => { setTargetSpaceId(v); setDuplicateWarning(false); }}
                        options={spaces.map((space) => ({ value: space.id, label: space.name }))}
                      />
                      <p className={`mt-1 text-[11px] ${tc.fontClass} ${tc.muted}`}>Existing drops are unchanged. Imported drops receive fresh IDs.</p>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {progress && (
            <div className={`border ${tc.border} ${tc.roundedClass} p-3 ${tc.fontClass}`}>
              <div className={`flex justify-between text-[11px] ${tc.muted}`}>
                <span>{progress.message || 'Working…'}</span>
                <span>{progressPercent === null ? '…' : `${progressPercent}%`}</span>
              </div>
              <div className={`mt-2 h-1 ${isDark ? 'bg-white/10' : 'bg-[#1A1A1A]/10'} ${tc.roundedClass}`}>
                <div className={`h-1 ${tc.activePillBg} ${tc.roundedClass}`} style={{ width: `${progressPercent ?? 5}%` }} />
              </div>
              {progress.currentName && <p className={`mt-2 text-[10px] truncate ${tc.muted}`}>{progress.currentName}</p>}
            </div>
          )}

          {duplicateWarning && (
            <div role="alertdialog" aria-live="assertive" className={`border p-3 ${tc.border} ${tc.roundedClass} ${tc.fontClass}`}>
              <p className={`text-xs ${tc.text}`}>Some of these drops are already here. Importing again will create duplicates. Continue?</p>
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" onClick={() => setDuplicateWarning(false)} className={`${buttonClass()} border ${secondaryClasses()}`}>Cancel</button>
                <button type="button" onClick={() => void handleImportAnyway()} disabled={busy} className={`${buttonClass()} ${primaryClasses()}`}>Import anyway</button>
              </div>
            </div>
          )}

          {error && <p className={`border p-3 text-xs ${tc.fontClass} ${tc.roundedClass} ${isDark ? 'border-red-300/30 bg-red-300/10 text-red-200' : 'border-red-500/30 bg-red-500/10 text-red-600'}`}>{error}</p>}
          {completeMessage && <p className={`border p-3 text-xs ${tc.fontClass} ${tc.roundedClass} ${isDark ? 'border-green-300/30 bg-green-300/10 text-green-200' : 'border-green-500/30 bg-green-500/10 text-green-700'}`}>{completeMessage}</p>}
        </div>

        <div className={`px-5 py-4 border-t ${tc.border} flex justify-end gap-2 ${tc.fontClass}`}>
          <button type="button" onClick={close} className={`${buttonClass()} border ${secondaryClasses()}`}>
            {busy ? 'Cancel' : completeMessage ? 'Close' : 'Cancel'}
          </button>
          {inspection && (
            <button type="button" onClick={() => void handleImport()} disabled={busy || !!completeMessage || duplicateWarning} className={`${buttonClass()} ${primaryClasses()}`}>
              {busy ? (checkingOverlap ? 'Checking…' : 'Importing…') : isPersonalFlavor ? 'Import personal drops' : 'Import backup'}
            </button>
          )}
        </div>
      </div>
    </div>
  );

  function fileValid(): boolean {
    return !!filePath && password.length >= 8;
  }

  function buttonClass(): string {
    return `px-4 py-2.5 text-sm tracking-wide rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed`;
  }
  function primaryClasses(): string {
    return isDark ? 'bg-[#1a1a1a] hover:bg-[#333] text-white border border-transparent' : `${tc.activePillBg} ${tc.activePillText} hover:opacity-90 border border-transparent`;
  }
  function secondaryClasses(): string {
    return `${tc.btnBg} ${tc.btnText} ${tc.btnBorder} ${tc.inactivePillHoverBg}`;
  }
}
