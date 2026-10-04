import { useEffect, useState } from 'react';
import { useEscapeClose } from '../hooks/useEscapeClose';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';
import { getEditorialThemeColors } from '../lib/editorialTheme';
import { LinkedText } from './shared/DropMentionContent';

type Theme = 'light' | 'dark' | 'minimal';
type Phase = 'confirm' | 'downloading' | 'ready' | 'error';

interface UpdateModalProps {
  theme: Theme;
  currentVersion: string;
  newVersion: string;
  onClose: () => void;
}

function fmtMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Round 118 — the in-app update modal (owner lock: user clicks every step). Confirm →
 * Download (progress + cancel) → Update & restart. The "what's new" text comes from the
 * release notes via the bridge; each line renders through LinkedText so https/www URLs in
 * the notes are clickable (round 117 machinery). The release-page link opens the default
 * browser through the https-only shell:openExternal bridge.
 */
export function UpdateModal({ theme, currentVersion, newVersion, onClose }: UpdateModalProps) {
  const tc = getEditorialThemeColors(theme);
  useBodyScrollLock();
  const [phase, setPhase] = useState<Phase>('confirm');
  const [notes, setNotes] = useState<string | null>(null);
  const [notesUrl, setNotesUrl] = useState<string>('https://github.com/AhmedSaeed4/dropsync-desktop/releases/latest');
  const [progress, setProgress] = useState({ percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 });
  // Esc only closes in the calm phases — during downloading the explicit Cancel button is
  // the exit (no accidental close mid-download), and in `ready` the choice must be explicit.
  useEscapeClose(phase === 'confirm' || phase === 'error', onClose);

  useEffect(() => {
    let alive = true;
    window.dropsync.update.notes().then((n) => {
      if (!alive) return;
      setNotes(n.notes);
      if (n.url) setNotesUrl(n.url);
    }).catch(() => { /* notes stay null — the link below is the fallback */ });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const off = window.dropsync.onUpdateProgress((p) => {
      if (p.state === 'downloading') setProgress({ percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond });
      else if (p.state === 'done') setPhase('ready');
      else if (p.state === 'error') setPhase('error');
      else if (p.state === 'cancelled') { setPhase('confirm'); setProgress({ percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 }); }
    });
    return () => { off(); };
  }, []);

  const startDownload = (): void => {
    setPhase('downloading');
    setProgress({ percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 });
    void window.dropsync.update.download();
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4">
      <div className={`w-full max-w-md rounded-xl ${tc.bg} border ${tc.border} shadow-xl max-h-[85vh] overflow-y-auto`}>
        <div className="p-6">
          <h2 className={`${tc.fontClass} ${tc.text} text-lg font-medium`}>
            DropSync {newVersion} is available
          </h2>
          <p className={`mt-1 text-sm ${tc.muted ?? tc.text} opacity-70`}>
            You have {currentVersion}. The update downloads and installs with your confirmation —
            your vault, workspaces and settings are never touched.
          </p>

          {notes !== null && notes.trim().length > 0 && (
            <div className={`mt-4 rounded-lg border ${tc.border} p-3 text-sm ${tc.text} max-h-52 overflow-y-auto whitespace-pre-line break-words`}>
              {(notes ?? '').split('\n').map((line, i) => (
                <div key={i} className={line.trim().length === 0 ? 'h-2' : ''}>
                  <LinkedText text={line} />
                </div>
              ))}
            </div>
          )}

          {phase === 'downloading' && (
            <div className="mt-4">
              <div className={`h-2 w-full rounded-full overflow-hidden ${tc.border} bg-black/10`}>
                <div className="h-full rounded-full transition-[width] duration-200" style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%`, background: 'var(--link-hover, #C81E3C)' }} />
              </div>
              <div className="mt-1.5 flex justify-between text-xs opacity-70">
                <span>{Math.max(0, Math.min(100, Math.round(progress.percent)))}%{progress.bytesPerSecond > 0 ? ` · ${fmtMB(progress.bytesPerSecond)}/s` : ''}</span>
                <span>{progress.total > 0 ? `${fmtMB(progress.transferred)} / ${fmtMB(progress.total)}` : ''}</span>
              </div>
            </div>
          )}

          {phase === 'error' && (
            <p className="mt-4 text-sm text-[#C81E3C]">The download didn't finish. Check your connection and try again.</p>
          )}
          {phase === 'ready' && (
            <p className={`mt-4 text-sm ${tc.text}`}>Downloaded and verified. Restart now to install {newVersion}?</p>
          )}

          <div className="mt-5 flex items-center justify-between gap-3">
            <button
              onClick={() => { void window.dropsync.shell.openExternal(notesUrl); }}
              className={`text-sm underline underline-offset-4 ${tc.text} opacity-80 hover:opacity-100`}
            >
              View release page ↗
            </button>
            <div className="flex items-center gap-2">
              {(phase === 'downloading') && (
                <button onClick={() => { void window.dropsync.update.cancel(); }} className={`text-sm rounded-md border ${tc.border} ${tc.btnBg} ${tc.text} px-4 py-2`}>
                  Cancel
                </button>
              )}
              {(phase === 'confirm' || phase === 'error') && (
                <>
                  <button onClick={onClose} className={`text-sm rounded-md border ${tc.border} ${tc.btnBg} ${tc.text} px-4 py-2`}>Later</button>
                  <button onClick={startDownload} className="text-sm rounded-md bg-[#1a1a1a] text-white px-4 py-2 hover:opacity-90">
                    {phase === 'error' ? 'Retry download' : 'Download update'}
                  </button>
                </>
              )}
              {phase === 'ready' && (
                <>
                  <button onClick={onClose} className={`text-sm rounded-md border ${tc.border} ${tc.btnBg} ${tc.text} px-4 py-2`}>Later</button>
                  <button onClick={() => { void window.dropsync.update.install(); }} className="text-sm rounded-md bg-[#1a1a1a] text-white px-4 py-2 hover:opacity-90">
                    Update &amp; restart
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
