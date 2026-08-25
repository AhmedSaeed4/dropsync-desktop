import type { Workspace } from '../../lib/types';
import { getEditorialThemeColors } from '../../lib/editorialTheme';
import { EditorialWorkspaceSwitcher } from './EditorialWorkspaceSwitcher';

type Theme = 'light' | 'dark' | 'minimal';

interface EditorialHeaderProps {
  theme: Theme;
  onOpenSettings?: () => void;
  workspaces: Workspace[];
  currentWorkspace: Workspace | null;
  currentUserId: string | null;
  onSwitch: (workspaceId: string | null) => void;
  onPersonalOptions?: () => void;
  /** Export-back entry points (M5). */
  onExportPersonal?: () => void;
  onExportWorkspace?: (workspaceId: string, name: string) => void;
  /** Create workspace (FIX 3) — resolves false/throws on failure so the row can stay open. */
  onCreateSpace?: (name: string) => Promise<boolean>;
  /** FIX 19 — inline rename (id stable; resolves false on failure so the row stays open). */
  onRenameSpace?: (id: string, name: string) => Promise<boolean>;
  /** FIX 19 — delete a workspace (cascades drops+categories; current lands on Personal). */
  onDeleteSpace?: (id: string) => Promise<boolean>;
}

/**
 * Desktop port of EditorialHeader with the Chat pill REMOVED (spec stripping table) — logo,
 * workspace switcher, and Settings. FIX 12: the header padlock is gone; the Settings modal's
 * "Lock now" button is the single manual lock entry (same vault.lock() path).
 */
export function EditorialHeader({
  theme,
  onOpenSettings,
  workspaces,
  currentWorkspace,
  currentUserId,
  onSwitch,
  onPersonalOptions,
  onExportPersonal,
  onExportWorkspace,
  onCreateSpace,
  onRenameSpace,
  onDeleteSpace,
}: EditorialHeaderProps) {
  const tc = getEditorialThemeColors(theme);

  return (
    <header className={`${tc.bg} border-b ${tc.border} relative z-40 shrink-0 transition-colors duration-500`}>
      <div className="flex items-center justify-between transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] px-4 sm:px-6 py-4 lg:py-6 lg:pl-[var(--nav-pl)] lg:pr-[var(--nav-pr)] [--nav-pl:80px] [--nav-pr:80px] wide:[--nav-pl:120px] wide:[--nav-pr:140px]">
        {/* Left: Logo */}
        <div className="flex items-center gap-2.5 transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)]">
          <span className={`${tc.fontClass} ${tc.text} font-medium tracking-[-0.3px] text-[22px] transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)]`}>
            <span className="inline-block mr-2 text-lg">&#9670;</span>
            DropSync
          </span>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-2 sm:gap-3 lg:gap-6 transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)]">
          {/* Workspace Selector - Editorial style */}
          <EditorialWorkspaceSwitcher
            workspaces={workspaces}
            currentWorkspace={currentWorkspace}
            currentUserId={currentUserId}
            onSwitch={onSwitch}
            onPersonalOptions={onPersonalOptions}
            onExportPersonal={onExportPersonal}
            onExportWorkspace={onExportWorkspace}
            onCreateSpace={onCreateSpace}
            onRenameSpace={onRenameSpace}
            onDeleteSpace={onDeleteSpace}
            theme={theme}
          />

          {/* FIX 12: header padlock removed — Settings modal owns manual locking now. */}

          {/* Settings - Outline pill */}
          {onOpenSettings && (
            <button
              onClick={onOpenSettings}
              className={`text-sm ${tc.fontClass} rounded-md border ${tc.border} ${tc.btnBg} ${tc.text} hover:border-[#1a1a1a] transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] px-3 sm:px-4 lg:px-6 lg:py-2.5 py-2`}
            >
              <span className="hidden sm:inline">Settings</span>
              <svg className="w-4 h-4 sm:hidden" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
