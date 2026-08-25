import { useState } from 'react';
import { getEditorialThemeColors } from '../lib/editorialTheme';

interface UnlockScreenProps {
  theme: 'light' | 'dark' | 'minimal';
  folder: string | null;
  /** Optional neutral hint (e.g. the Create flow finding an existing vault here). Not an error. */
  notice?: string | null;
  /** Exit door (M7): true when the picked folder has NO vault — show the "create one here?" offer. */
  createHereOffer?: boolean;
  onCreateHere?: () => void;
  onCancelCreateHere?: () => void;
  onPickFolder: () => Promise<void>;
  onUnlock: (password: string) => Promise<string | null>; // resolves error string or null
}

/** Unlock screen — modeled on EditorialLogin.tsx (centered ◆ logo, Raleway, footer decorations). */
export function UnlockScreen({ theme, folder, notice, createHereOffer, onCreateHere, onCancelCreateHere, onPickFolder, onUnlock }: UnlockScreenProps) {
  const tc = getEditorialThemeColors(theme);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!password) return;
    setBusy(true);
    setError(null);
    const unlockError = await onUnlock(password);
    setBusy(false);
    if (unlockError) setError(unlockError);
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
            Unlock your vault
          </p>
          <button
            type="button"
            onClick={() => void onPickFolder()}
            title="Choose a different folder"
            className={`text-sm ${tc.fontClass} ${tc.muted} hover:underline mb-8 block mx-auto max-w-full truncate`}
          >
            {folder || 'Choose a folder…'}
          </button>

          {notice && (
            <p className={`-mt-4 mb-6 text-xs leading-relaxed ${tc.fontClass} ${tc.muted}`}>
              {notice}
            </p>
          )}

          {/* Exit door (M7): a vault-less folder offers to flow straight into setup, prefilled. */}
          {createHereOffer && (
            <div className={`mb-6 border ${tc.border} rounded-lg px-4 py-3`}>
              <p className={`text-xs leading-relaxed ${tc.fontClass} ${tc.text}`}>
                No DropSync vault found in this folder — create one here?
              </p>
              <div className="mt-3 flex justify-center gap-2">
                <button
                  type="button"
                  onClick={onCancelCreateHere}
                  className={`px-4 py-1.5 text-xs border ${tc.border} ${tc.text} rounded-full hover:border-[#1a1a1a] transition-colors ${tc.fontClass}`}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => onCreateHere?.()}
                  className={`px-4 py-1.5 text-xs rounded-full ${tc.activePillBg} ${tc.activePillText} hover:opacity-90 transition-opacity ${tc.fontClass}`}
                >
                  Create one here
                </button>
              </div>
            </div>
          )}

          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
            placeholder="Vault password"
            autoFocus
            className={`w-full px-4 py-3 text-sm border ${tc.border} ${tc.bg} ${tc.text} rounded-full focus:outline-none focus:border-[#1a1a1a] ${tc.fontClass} mb-4 text-center`}
            autoComplete="current-password"
          />

          {error && (
            <p className={`mb-4 text-xs border px-3 py-2 rounded-lg ${tc.fontClass} border-red-300/40 bg-red-500/10 text-red-600`}>
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !password || !folder}
            className={`inline-flex items-center gap-3 px-8 py-3 bg-[#1a1a1a] rounded-full text-sm ${tc.fontClass} text-white hover:bg-[#333] transition-all duration-300 disabled:opacity-50`}
          >
            {busy ? 'Unlocking…' : 'Unlock'}
          </button>
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
