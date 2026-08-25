import { useState } from 'react';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';
import { useEscapeClose } from '../hooks/useEscapeClose';
import { getEditorialThemeColors } from '../lib/editorialTheme';
import { useVaultStore } from '../store/vault';
import { EditorialSelect } from './editorial/EditorialSelect';

interface SettingsModalProps {
  onClose: () => void;
  /** Exit door (M7): seal the vault and land on the UnlockScreen. */
  onLockNow?: () => void;
  /** FIX 3: fired ONLY after a successful move-vault flow so App can refetch (new folder).
   * Every other close path is silent — the modal writes changes through the store live. */
  onVaultMoved?: () => void;
}

/** FIX 7: minutes-based option set — 1–60 min plus 2/4/8 hours, or Off. Values are minutes. */
const AUTO_LOCK_OPTIONS = [
  { value: '1', label: '1 minute' },
  { value: '5', label: '5 minutes' },
  { value: '10', label: '10 minutes' },
  { value: '15', label: '15 minutes' },
  { value: '30', label: '30 minutes' },
  { value: '60', label: '60 minutes' },
  { value: '120', label: '2 hours' },
  { value: '240', label: '4 hours' },
  { value: '480', label: '8 hours' },
  { value: 'off', label: 'Off' },
];

/**
 * Desktop settings — the EditorialSettingsModal skeleton with the vault capabilities:
 * change password, move vault folder, idle auto-lock (1–60 min / 2–8 h / off), Lock now.
 */
export function SettingsModal({ onClose, onLockNow, onVaultMoved }: SettingsModalProps) {
  const { theme, folder, updateSettings, settings } = useVaultStore();
  const tc = getEditorialThemeColors(theme);
  useBodyScrollLock();
  useEscapeClose(true, onClose);

  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState<string | null>(null);

  const [moveBusy, setMoveBusy] = useState(false);
  const [moveMessage, setMoveMessage] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

  const autoLock = settings?.autoLockMinutes ?? 10;

  const handleChangePassword = async () => {
    if (newPassword.length < 8) {
      setPwError('Use a vault password with at least 8 characters.');
      return;
    }
    if (newPassword.length > 512) {
      setPwError('The vault password is too long.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwError('The passwords do not match.');
      return;
    }
    setPwBusy(true);
    setPwError(null);
    setPwSuccess(null);
    try {
      await window.dropsync.vault.changePassword(oldPassword, newPassword);
      setPwSuccess('Vault password changed.');
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (caught) {
      setPwError(caught instanceof Error ? caught.message : 'The password change failed.');
    } finally {
      setPwBusy(false);
    }
  };

  const handleMoveVault = async () => {
    setMoveBusy(true);
    setMoveError(null);
    setMoveMessage(null);
    try {
      const newFolder = await window.dropsync.dialog.pickFolder({ title: 'Choose a new parent folder for DropSync.vault' });
      if (!newFolder) {
        setMoveBusy(false);
        return;
      }
      await window.dropsync.vault.move(newFolder);
      setMoveMessage(`Vault moved to ${newFolder}`);
      // FIX 3: the ONLY close-path-adjacent refresh — a moved vault means a new folder and the
      // App shell must re-probe. Fired on success only; plain closes never touch it.
      onVaultMoved?.();
    } catch (caught) {
      setMoveError(caught instanceof Error ? caught.message : 'The vault move failed.');
    } finally {
      setMoveBusy(false);
    }
  };

  const handleAutoLock = async (value: string) => {
    const parsed = value === 'off' ? null : parseInt(value, 10);
    await updateSettings({ autoLockMinutes: parsed });
  };

  const inputClass = `w-full px-3 py-2.5 text-sm border ${tc.border} ${tc.bg} ${tc.text} rounded-lg focus:outline-none focus:border-[#1a1a1a] ${tc.fontClass}`;

  return (
    <div
      className="fixed inset-0 bg-[#1a1a1a]/60 flex items-center justify-center z-50 p-4 modal-fade-in"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`${tc.bg} border ${tc.border} rounded-xl w-full max-w-md overflow-hidden shadow-xl max-h-[80vh] flex flex-col modal-card-in`}>
        {/* Header */}
        <div className={`border-b ${tc.border} px-5 py-4 flex items-center justify-between`}>
          <h2 className={`${tc.fontClass} ${tc.text} font-medium text-[15px]`}>Settings</h2>
          <button onClick={onClose} className={`${tc.muted} hover:${tc.text} transition-colors p-1`}>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Vault */}
          <div>
            <h3 className={`${tc.fontClass} ${tc.text} font-medium text-sm mb-3`}>Vault</h3>
            <div className={`p-3 rounded-lg border ${tc.border} ${tc.bg}`}>
              <label className={`block text-xs ${tc.muted} ${tc.fontClass} mb-1`}>Location</label>
              <p className={`${tc.text} text-sm ${tc.fontClass} break-all`}>
                {folder ? `${folder}/DropSync.vault` : '—'}
              </p>
            </div>
            <button
              onClick={() => void handleMoveVault()}
              disabled={moveBusy}
              className={`mt-2 w-full border ${tc.border} ${tc.text} py-2.5 text-sm rounded-lg hover:border-[#1a1a1a] transition-colors ${tc.fontClass} disabled:opacity-50`}
            >
              {moveBusy ? 'Moving…' : 'Move vault to another folder'}
            </button>
            {moveMessage && <p className={`text-xs text-green-600 mt-2 ${tc.fontClass}`}>{moveMessage}</p>}
            {moveError && <p className={`text-xs text-red-600 mt-2 ${tc.fontClass}`}>{moveError}</p>}
            {/* Exit door (M7): same seal path the idle auto-lock uses. */}
            {onLockNow && (
              <button
                onClick={onLockNow}
                className={`mt-2 w-full border ${tc.border} ${tc.text} py-2.5 text-sm rounded-lg hover:border-[#1a1a1a] transition-colors ${tc.fontClass} flex items-center justify-center gap-2`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
                Lock now
              </button>
            )}
          </div>

          {/* Auto-lock */}
          <div>
            <h3 className={`${tc.fontClass} ${tc.text} font-medium text-sm mb-3`}>Auto-lock</h3>
            <p className={`text-xs ${tc.muted} ${tc.fontClass} mb-2`}>
              Lock the vault automatically after a period of inactivity.
            </p>
            <EditorialSelect
              theme={theme}
              ariaLabel="Auto-lock after inactivity"
              value={autoLock === null ? 'off' : String(autoLock)}
              onChange={(v) => void handleAutoLock(v)}
              options={AUTO_LOCK_OPTIONS}
            />
          </div>

          {/* Theme */}
          <div>
            <h3 className={`${tc.fontClass} ${tc.text} font-medium text-sm mb-3`}>Theme</h3>
            <p className={`text-xs ${tc.muted} ${tc.fontClass} mb-2`}>
              Also changeable from the left panel.
            </p>
            <div className="grid grid-cols-3 gap-2">
              {(['light', 'dark', 'minimal'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => void updateSettings({ theme: t })}
                  className={`py-2 text-sm rounded-lg border transition-colors capitalize ${tc.fontClass} ${
                    theme === t
                      ? `${tc.activePillBg} ${tc.activePillText} border-transparent`
                      : `${tc.border} ${tc.text} hover:border-[#1a1a1a]`
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Security */}
          <div>
            <h3 className={`${tc.fontClass} ${tc.text} font-medium text-sm mb-3`}>Change vault password</h3>
            <div className="space-y-2">
              <input
                type="password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                placeholder="Current password"
                className={inputClass}
                autoComplete="current-password"
              />
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="New password (min 8 characters)"
                className={inputClass}
                autoComplete="new-password"
              />
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm new password"
                className={inputClass}
                autoComplete="new-password"
              />
              {pwError && (
                <p className="text-xs text-red-600 border border-red-200 bg-red-50 rounded-lg px-3 py-2">{pwError}</p>
              )}
              {pwSuccess && (
                <p className="text-xs text-green-600 border border-green-200 bg-green-50 rounded-lg px-3 py-2">{pwSuccess}</p>
              )}
              <button
                onClick={() => void handleChangePassword()}
                disabled={pwBusy || !oldPassword || !newPassword}
                className={`w-full ${tc.activePillBg} ${tc.activePillText} py-2.5 text-sm rounded-lg hover:opacity-90 transition-opacity ${tc.fontClass} disabled:opacity-50`}
              >
                {pwBusy ? 'Changing…' : 'Change password'}
              </button>
              <p className={`text-xs ${tc.muted} ${tc.fontClass}`}>
                If you ever forget this password, your data cannot be recovered.
              </p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className={`border-t ${tc.border} px-5 py-4`}>
          <button
            onClick={onClose}
            className={`w-full ${tc.activePillBg} ${tc.activePillText} py-2.5 text-sm rounded-lg hover:opacity-90 transition-opacity ${tc.fontClass}`}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
