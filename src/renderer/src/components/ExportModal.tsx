/**
 * ExportModal — the return trip home (M5). The ImportModal's editorial twin, pointed outward:
 * explains what a backup contains → fresh archive password + confirm (typed every time by
 * design — never stored) → native Save As with a suggested name → streaming progress →
 * summary toast line (expired drops counted, never exported).
 */

import { useEffect, useRef, useState } from 'react';
import type { ExportSummaryDTO, ImportProgressDTO } from '../../../preload/apiTypes';
import { useEscapeClose } from '../hooks/useEscapeClose';
import { getEditorialThemeColors } from '../lib/editorialTheme';

interface ExportModalProps {
  theme?: 'light' | 'dark' | 'minimal';
  /** 'personal' exports the Personal space as a personal-flavor archive; a workspace id
   * exports that workspace as a workspace-flavor archive (web re-importable, both). */
  scope: 'personal' | { workspaceId: string };
  spaceName: string;
  onClose: () => void;
}

function suggestedFileName(spaceName: string): string {
  const safe = (spaceName || 'personal').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'personal';
  return `DropSync backup ${spaceName} ${new Date().toISOString().slice(0, 10)}.dropsync`.trim();
}

export function ExportModal({ theme = 'light', scope, spaceName, onClose }: ExportModalProps) {
  const tc = getEditorialThemeColors(theme);
  const isDark = theme === 'dark';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [outPath, setOutPath] = useState<string | null>(null);
  const [progress, setProgress] = useState<ImportProgressDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ExportSummaryDTO | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    const off = window.dropsync.onImportProgress((p) => setProgress(p));
    return () => { off(); };
  }, []);

  const close = () => {
    if (busy && !summary) return;
    onClose();
  };
  // Esc uses the same guarded path (polish sweep #3).
  useEscapeClose(!(busy && !summary), close);

  const pickDestination = async () => {
    setError(null);
    const picked = await window.dropsync.dialog.pickSave({ suggestedName: suggestedFileName(spaceName) });
    if (picked) setOutPath(picked);
  };

  const handleExport = async () => {
    if (busyRef.current) return;
    if (password.length < 8) {
      setError('Use an archive password with at least 8 characters.');
      return;
    }
    if (password.length > 512) {
      setError('The archive password is too long.');
      return;
    }
    if (password !== confirm) {
      setError('The passwords do not match.');
      return;
    }
    if (!outPath) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      const result = await window.dropsync.vault.export(scope, password, outPath);
      setSummary(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The export failed.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const handleCancelExport = async () => {
    await window.dropsync.vault.exportCancel().catch(() => {});
  };

  // __PROGRESS_BAR__

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 overscroll-contain">
      <div className="fixed inset-0 bg-black/55" onClick={close} />
      <div className={`relative z-10 w-full max-w-lg border ${tc.cardBg} ${tc.border} ${tc.roundedClass} shadow-2xl overflow-hidden`}>
        {/* Header */}
        <div className={`px-5 py-4 border-b ${tc.border} flex items-center justify-between`}>
          <div>
            <h2 className={`text-sm font-medium tracking-wide ${tc.fontClass} ${tc.text}`}>
              Export backup
            </h2>
            <p className={`mt-1 text-[11px] ${tc.muted}`}>
              {scope === 'personal' ? 'Personal space' : spaceName} → an encrypted .dropsync file any DropSync app can restore.
            </p>
          </div>
          <button type="button" onClick={close} disabled={busy} className={`${tc.muted} hover:opacity-70 transition-opacity`} aria-label="Close">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-4">
          <p className={`text-xs leading-relaxed ${tc.fontClass} ${tc.muted}`}>
            Every active drop comes along — text, files, drawings, categories, reminders and locks.
            Expired drops are skipped and counted. Nothing in this vault changes.
          </p>

          {/* __PASSWORD_FIELDS__ */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={`text-[10px] tracking-wide ${tc.fontClass} ${tc.muted}`}>Archive password</label>
              <input
                type="password"
                value={password}
                onChange={(event) => { setPassword(event.target.value); setSummary(null); }}
                disabled={busy}
                className={`mt-1 w-full border px-3 py-2 text-sm outline-none ${tc.border} ${tc.bg} ${tc.text} ${tc.fontClass} ${tc.roundedClass}`}
                autoComplete="new-password"
              />
            </div>
            <div>
              <label className={`text-[10px] tracking-wide ${tc.fontClass} ${tc.muted}`}>Confirm password</label>
              <input
                type="password"
                value={confirm}
                onChange={(event) => { setConfirm(event.target.value); setSummary(null); }}
                disabled={busy}
                onKeyDown={(event) => event.key === 'Enter' && outPath && void handleExport()}
                className={`mt-1 w-full border px-3 py-2 text-sm outline-none ${tc.border} ${tc.bg} ${tc.text} ${tc.fontClass} ${tc.roundedClass}`}
                autoComplete="new-password"
              />
            </div>
          </div>
          <p className={`text-[11px] ${tc.fontClass} ${tc.muted}`}>DropSync cannot recover a forgotten archive password. Type a fresh one each time — it is never stored.</p>

          {/* __SAVE_PICKER__ */}
          <div>
            <label className={`text-[10px] tracking-wide ${tc.fontClass} ${tc.muted}`}>Save to</label>
            <button
              type="button"
              onClick={() => void pickDestination()}
              disabled={busy}
              className={`mt-1 w-full border px-3 py-2 text-left text-sm outline-none ${tc.border} ${tc.bg} ${tc.text} ${tc.fontClass} ${tc.roundedClass} hover:border-[#1a1a1a] transition-colors truncate ${!outPath ? tc.muted : ''}`}
            >
              {outPath || 'Choose a location…'}
            </button>
          </div>

          {progress && !summary && (
            <div className={`border ${tc.border} ${tc.roundedClass} p-3 ${tc.fontClass}`}>
              {(() => {
                const percent = progress!.totalBytes > 0
                  ? Math.min(100, Math.round((progress!.processedBytes / progress!.totalBytes) * 100))
                  : null;
                return (
                  <>
                    <div className={`flex justify-between text-[11px] ${tc.muted}`}>
                      <span>{progress!.message || 'Working…'}</span>
                      <span>{percent === null ? '…' : `${percent}%`}</span>
                    </div>
                    <div className={`mt-2 h-1 ${isDark ? 'bg-white/10' : 'bg-[#1A1A1A]/10'} ${tc.roundedClass}`}>
                      <div className={`h-1 ${tc.activePillBg} ${tc.roundedClass} transition-all`} style={{ width: `${percent ?? 5}%` }} />
                    </div>
                  </>
                );
              })()}
            </div>
          )}

          {error && (
            <p className={`border p-3 text-xs ${tc.fontClass} ${tc.roundedClass} ${isDark ? 'border-red-300/30 bg-red-300/10 text-red-200' : 'border-red-500/30 bg-red-500/10 text-red-600'}`}>{error}</p>
          )}
          {summary && (
            <p className={`border p-3 text-xs leading-relaxed ${tc.fontClass} ${tc.roundedClass} ${isDark ? 'border-green-300/30 bg-green-300/10 text-green-200' : 'border-green-500/30 bg-green-500/10 text-green-700'}`}>
              {summaryText(summary)}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className={`px-5 py-4 border-t ${tc.border} flex justify-end gap-2 ${tc.fontClass}`}>
          {busy ? (
            <button type="button" onClick={() => void handleCancelExport()} className={`${buttonClass()} border ${secondaryClasses()}`}>
              Cancel export
            </button>
          ) : (
            <button type="button" onClick={close} className={`${buttonClass()} border ${secondaryClasses()}`}>
              {summary ? 'Close' : 'Cancel'}
            </button>
          )}
          {!summary && outPath && !busy && (
            <button type="button" onClick={() => void handleExport()} className={`${buttonClass()} ${primaryClasses()}`}>
              Start export
            </button>
          )}
        </div>
      </div>
    </div>
  );

  function summaryText(s: ExportSummaryDTO): string {
    const parts = [
      `Backup saved — ${s.included} drop${s.included === 1 ? '' : 's'} exported.`,
    ];
    if (s.skippedExpired > 0) parts.push(`${s.skippedExpired} expired drop${s.skippedExpired === 1 ? '' : 's'} skipped.`);
    if (s.skippedOther.length > 0) parts.push(`${s.skippedOther.length} drop${s.skippedOther.length === 1 ? '' : 's'} skipped: ${s.skippedOther.map((d) => `${d.name} (${d.reason})`).join('; ')}`);
    return parts.join(' ');
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
