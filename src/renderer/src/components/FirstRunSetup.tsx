import { useState } from 'react';
import { getEditorialThemeColors } from '../lib/editorialTheme';

interface FirstRunSetupProps {
  theme: 'light' | 'dark' | 'minimal';
  folder: string | null;
  onPickFolder: () => Promise<void>;
  onCreate: (password: string) => Promise<string | null>; // resolves error string or null
  onOpenExisting: () => void;
}

/**
 * First-run flow: folder picker → vault password create. The unrecoverable-data warning is the
 * LITERAL spec string — do not reword it.
 */
export function FirstRunSetup({ theme, folder, onPickFolder, onCreate, onOpenExisting }: FirstRunSetupProps) {
  const tc = getEditorialThemeColors(theme);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (password.length < 8) {
      setError('Use a vault password with at least 8 characters.');
      return;
    }
    if (password.length > 512) {
      setError('The vault password is too long.');
      return;
    }
    if (password !== confirm) {
      setError('The passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    const createError = await onCreate(password);
    setBusy(false);
    if (createError) setError(createError);
  };

  return (
    <div className={`min-h-screen ${tc.bg} flex flex-col transition-colors duration-500`}>
      <main className="flex-1 flex flex-col items-center justify-center px-8 relative">
        <div className="max-w-md text-center w-full">
          <div className={`text-2xl font-medium tracking-tight ${tc.fontClass} ${tc.text} mb-8`}>
            <span className="inline-block mr-2 text-lg">&#9670;</span>
            DropSync
          </div>

          <p className={`text-base md:text-lg leading-relaxed tracking-wide mb-2 ${tc.fontClass} ${tc.text}`}>
            Create your local vault
          </p>
          <p className={`text-sm ${tc.fontClass} ${tc.muted} mb-8`}>
            Choose a folder on this computer. Everything stays offline.
          </p>

          <div className="space-y-3 text-left">
            <button
              type="button"
              onClick={() => void onPickFolder()}
              className={`w-full px-4 py-3 border ${tc.border} ${tc.roundedClass} text-sm ${tc.fontClass} ${tc.text} hover:border-[#1a1a1a] transition-colors text-left`}
            >
              <span className={`block text-[10px] uppercase tracking-wider ${tc.muted} mb-1`}>Vault folder</span>
              {folder || 'Choose a folder…'}
            </button>

            <div>
              <label className={`block text-xs ${tc.muted} ${tc.fontClass} mb-1`}>Vault password (min 8 characters)</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={`w-full px-4 py-2.5 text-sm border ${tc.border} ${tc.bg} ${tc.text} ${tc.roundedClass} focus:outline-none focus:border-[#1a1a1a] ${tc.fontClass}`}
                autoComplete="new-password"
              />
            </div>
            <div>
              <label className={`block text-xs ${tc.muted} ${tc.fontClass} mb-1`}>Confirm password</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void submit()}
                className={`w-full px-4 py-2.5 text-sm border ${tc.border} ${tc.bg} ${tc.text} ${tc.roundedClass} focus:outline-none focus:border-[#1a1a1a] ${tc.fontClass}`}
                autoComplete="new-password"
              />
            </div>

            <div className={`border ${tc.border} ${tc.roundedClass} px-4 py-3`}>
              <p className={`text-xs leading-relaxed ${tc.fontClass} ${tc.text}`}>
                If you ever forget this password, your data cannot be recovered.
              </p>
            </div>

            {error && (
              <p className="text-xs text-red-600 border border-red-200 bg-red-50 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || !folder}
              className={`w-full py-3 text-sm ${tc.activePillBg} ${tc.activePillText} ${tc.roundedClass} hover:opacity-90 transition-opacity ${tc.fontClass} disabled:opacity-50`}
            >
              {busy ? 'Creating vault…' : 'Create vault'}
            </button>

            <button
              type="button"
              onClick={onOpenExisting}
              className={`w-full py-2 text-xs ${tc.fontClass} ${tc.muted} hover:underline`}
            >
              I already have a vault in another folder
            </button>
          </div>
        </div>

        <div className={`absolute bottom-8 left-8 text-xs ${tc.fontClass} ${tc.muted}`}>
          {new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
        </div>
        <div className={`absolute bottom-8 right-8 text-xs ${tc.fontClass} ${tc.muted}`}>
          EDITION 2.0
        </div>
      </main>
    </div>
  );
}
