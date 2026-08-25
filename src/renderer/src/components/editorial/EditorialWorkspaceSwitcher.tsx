import { useEffect, useRef, useState } from 'react';
import type { Workspace } from '../../lib/types';
import { getEditorialThemeColors } from '../../lib/editorialTheme';

interface EditorialWorkspaceSwitcherProps {
  workspaces: Workspace[];
  currentWorkspace: Workspace | null;
  currentUserId: string | null;
  onSwitch: (workspaceId: string | null) => void;
  onPersonalOptions?: () => void;
  /** Export-back entry points (M5): personal gear menu + per-workspace ⚙. */
  onExportPersonal?: () => void;
  onExportWorkspace?: (workspaceId: string, name: string) => void;
  /** Create workspace (FIX 3). Resolves false on failure so the inline row stays open. */
  onCreateSpace?: (name: string) => Promise<boolean>;
  /** FIX 19 — inline rename (id stable). Resolves false on failure so the row stays open. */
  onRenameSpace?: (id: string, name: string) => Promise<boolean>;
  /** FIX 19 — delete a workspace after the web-parity confirm guard. */
  onDeleteSpace?: (id: string) => Promise<boolean>;
  theme?: 'light' | 'dark' | 'minimal';
  showChat?: boolean;
}

/**
 * Desktop port of the web's EditorialWorkspaceSwitcher. Stripped per spec: no member rosters,
 * no invite-code copy, no join — local workspaces only, plus a "New workspace" action and the
 * Personal gear whose menu carries Import + Export backup (M5).
 */
export function EditorialWorkspaceSwitcher({
  workspaces,
  currentWorkspace,
  currentUserId,
  onSwitch,
  onPersonalOptions,
  onCreateSpace,
  onRenameSpace,
  onDeleteSpace,
  onExportPersonal,
  onExportWorkspace,
  theme = 'light',
  showChat = false,
}: EditorialWorkspaceSwitcherProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [personalMenuOpen, setPersonalMenuOpen] = useState(false);
  // Create-workspace inline row (FIX 3): expands inside the dropdown; Enter=create,
  // Esc=cancel; ref-guarded against double-submit; empty name ⇒ 'Workspace' (main-process
  // fallback). Duplicate names are fine — spaces are id-keyed.
  const [creatingSpace, setCreatingSpace] = useState(false);
  const [newSpaceName, setNewSpaceName] = useState('');
  const [spaceCreateBusy, setSpaceCreateBusy] = useState(false);
  const newSpaceInputRef = useRef<HTMLInputElement>(null);
  // FIX 19 — per-row ⚙ action menu (rename / export / delete) + its sub-states.
  const [rowMenuSpaceId, setRowMenuSpaceId] = useState<string | null>(null);
  const [renamingSpaceId, setRenamingSpaceId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  // Web-parity delete GUARD (WorkspaceOptionsModal study): the destructive click opens a
  // second confirm view with the web's exact wording — never deletes in one step.
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const tc = getEditorialThemeColors(theme);

  useEffect(() => {
    if (creatingSpace) newSpaceInputRef.current?.focus();
  }, [creatingSpace]);

  useEffect(() => {
    if (renamingSpaceId) renameInputRef.current?.focus();
  }, [renamingSpaceId]);

  // FIX 1: whenever the dropdown closes for ANY reason (backdrop click, picking a workspace,
  // Esc elsewhere), fold the create row and clear its input — an abandoned half-typed name
  // must never resurface on reopen. Safety rider: while a creation is in flight
  // (spaceCreateBusy) leave the state alone; when busy flips back to false this effect
  // re-runs and folds then, after submitNewSpace has resolved its own success/failure path.
  useEffect(() => {
    if (isOpen || spaceCreateBusy) return;
    setCreatingSpace(false);
    setNewSpaceName('');
  }, [isOpen, spaceCreateBusy]);

  // FIX 19 rider: closing the dropdown also folds every row menu, the rename row and the
  // delete confirmation — nothing half-armed survives a reopen.
  useEffect(() => {
    if (isOpen) return;
    setRowMenuSpaceId(null);
    setRenamingSpaceId(null);
    setRenameValue('');
    setDeleteTargetId(null);
  }, [isOpen]);

  const submitNewSpace = async () => {
    if (spaceCreateBusy) return;
    setSpaceCreateBusy(true);
    try {
      const ok = await onCreateSpace?.(newSpaceName.trim() || 'Workspace');
      if (ok === false) return; // keep the row open with input intact for retry/cancel
      setCreatingSpace(false);
      setNewSpaceName('');
      setIsOpen(false);
    } finally {
      setSpaceCreateBusy(false);
    }
  };

  /** FIX 19 — commit the inline rename (same contract as create: trim, ≤120 chars handled by
   * maxLength + engine slice; failure keeps the row open for retry). */
  const submitRename = async (id: string) => {
    if (renameBusy) return;
    if (!renameValue.trim()) { setRenamingSpaceId(null); setRenameValue(''); return; }
    setRenameBusy(true);
    try {
      const ok = await onRenameSpace?.(id, renameValue.trim());
      if (ok === false) return;
      setRenamingSpaceId(null);
      setRenameValue('');
      setRowMenuSpaceId(null);
    } finally {
      setRenameBusy(false);
    }
  };

  /** FIX 19 — CONFIRMED delete (the web's second step; this function only runs from there). */
  const submitDelete = async (id: string) => {
    if (deleteBusy) return;
    setDeleteBusy(true);
    try {
      const ok = await onDeleteSpace?.(id);
      if (ok === false) return; // keep the confirm up so the user can retry or back out
      setDeleteTargetId(null);
      setRowMenuSpaceId(null);
      setIsOpen(false);
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div className="relative">
      {/* Main button - editorial pill style */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center border ${tc.border} ${tc.bg} rounded-md hover:border-[#1a1a1a] transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${
          showChat ? 'gap-1.5 px-3 py-1.5' : 'gap-2 px-4 py-2'
        }`}
      >
        <svg
          className={`${tc.text} transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${showChat ? 'w-3.5 h-3.5' : 'w-4 h-4'}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
          />
        </svg>

        <span className={`${tc.fontClass} ${tc.text} transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${showChat ? 'text-sm' : 'text-[15px]'}`}>
          {currentWorkspace?.name || 'Personal'}
        </span>

        <svg
          className={`${tc.muted} transition-transform duration-200 ${isOpen ? 'rotate-180' : ''} ${showChat ? 'w-3.5 h-3.5' : 'w-4 h-4'}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className={`absolute top-full right-0 mt-1 w-48 sm:w-52 border ${tc.border} ${tc.bg} rounded-lg shadow-lg z-50 overflow-hidden`}>
            {/* Personal option + options gear (gear opens the Import/Export backup menu) */}
            <div className={`flex items-stretch ${!currentWorkspace ? (theme === 'dark' ? 'bg-white/10 text-white' : `${tc.activePillBg} ${tc.activePillText}`) : tc.bg}`}>
              <button
                onClick={() => {
                  onSwitch(null);
                  setPersonalMenuOpen(false);
                  setIsOpen(false);
                }}
                className={`flex-1 px-3 py-2 text-left flex items-center gap-2 transition-colors ${!currentWorkspace ? 'text-white' : 'hover:bg-[#1a1a1a]/5'}`}
              >
                <svg
                  className={`w-3.5 h-3.5 ${!currentWorkspace ? 'text-white' : tc.text}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                  />
                </svg>
                <span className={`${tc.fontClass} text-sm ${!currentWorkspace ? 'text-white' : tc.text}`}>
                  Personal
                </span>
              </button>
              <button
                type="button"
                onClick={() => setPersonalMenuOpen((open) => !open)}
                className={`shrink-0 px-2.5 ${!currentWorkspace ? 'text-white hover:bg-white/20' : `${tc.muted} hover:bg-[#1a1a1a]/5`} transition-colors`}
                title="Personal options (import / export backup)"
                aria-label="Personal options"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                </svg>
              </button>
            </div>

            {/* Personal gear submenu — Import + Export backup (M5 entry point) */}
            {personalMenuOpen && (
              <>
                <button
                  type="button"
                  onClick={() => { onPersonalOptions?.(); setIsOpen(false); }}
                  className="w-full px-3 py-2 text-left flex items-center gap-2 hover:bg-[#1a1a1a]/5 transition-colors border-t border-[#1a1a1a]/10"
                >
                  <span className={`${tc.fontClass} text-xs ${tc.text}`}>Import backup…</span>
                </button>
                {onExportPersonal && (
                  <button
                    type="button"
                    onClick={() => { onExportPersonal(); setIsOpen(false); }}
                    className="w-full px-3 py-2 text-left flex items-center gap-2 hover:bg-[#1a1a1a]/5 transition-colors"
                  >
                    <span className={`${tc.fontClass} text-xs ${tc.text}`}>Export backup…</span>
                  </button>
                )}
              </>
            )}

            {workspaces.length > 0 && <div className={`border-t ${tc.border}`} />}

            {workspaces.map((workspace) => {
              const isActive = currentWorkspace?.id === workspace.id;
              const menuOpenForRow = rowMenuSpaceId === workspace.id && !renamingSpaceId && deleteTargetId !== workspace.id;
              return (
                <div key={workspace.id}>
                  <div
                    onClick={() => {
                      onSwitch(workspace.id);
                      setIsOpen(false);
                    }}
                    className={`w-full px-3 py-2 flex items-center justify-between cursor-pointer transition-colors ${
                      isActive ? (theme === 'dark' ? 'bg-white/10' : tc.activePillBg + ' ' + tc.activePillText) : 'hover:bg-[#1a1a1a]/5'
                    }`}
                  >
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <svg
                      className={`w-3.5 h-3.5 shrink-0 ${isActive ? 'text-white' : tc.text}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      strokeWidth={1.5}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                      />
                    </svg>
                    <span className={`${tc.fontClass} text-sm ${isActive ? 'text-white' : tc.text} truncate`}>
                      {workspace.name}
                    </span>
                  </div>
                  {/* FIX 19: ⚙ opens this row's action menu (rename / export / delete).
                      Personal never gets these entries — it is structural (engine-enforced). */}
                  <button
                      type="button"
                      data-ws-gear="true"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRowMenuSpaceId(rowMenuSpaceId === workspace.id ? null : workspace.id);
                        setDeleteTargetId(null);
                      }}
                      className={`shrink-0 p-1 rounded ${isActive ? 'text-white hover:bg-white/20' : `${tc.muted} hover:bg-[#1a1a1a]/10`} transition-colors`}
                      title={`Workspace options for "${workspace.name}"`}
                      aria-label={`Workspace options for ${workspace.name}`}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 01-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                    </button>
                  </div>

                  {/* Row action menu — Rename / Export / Delete (FIX 19) */}
                  {menuOpenForRow && (
                    <div data-ws-menu={workspace.id} className="border-t border-[#1a1a1a]/10">
                      <button
                        type="button"
                        data-ws-rename-entry="true"
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenameValue(workspace.name);
                          setRenamingSpaceId(workspace.id);
                          setDeleteTargetId(null);
                        }}
                        className="w-full px-6 py-2 text-left flex items-center gap-2 hover:bg-[#1a1a1a]/5 transition-colors"
                      >
                        <span className={`${tc.fontClass} text-xs ${tc.text}`}>Rename workspace…</span>
                      </button>
                      {onExportWorkspace && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onExportWorkspace(workspace.id, workspace.name);
                            setIsOpen(false);
                          }}
                          className="w-full px-6 py-2 text-left flex items-center gap-2 hover:bg-[#1a1a1a]/5 transition-colors"
                        >
                          <span className={`${tc.fontClass} text-xs ${tc.text}`}>Export backup…</span>
                        </button>
                      )}
                      <button
                        type="button"
                        data-ws-delete-entry="true"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTargetId(workspace.id); // guard step 1 → confirm view below
                        }}
                        className="w-full px-6 py-2 text-left flex items-center gap-2 hover:bg-red-500/10 transition-colors"
                      >
                        <span className={`${tc.fontClass} text-xs text-red-500`}>Delete workspace…</span>
                      </button>
                    </div>
                  )}

                  {/* Inline RENAME row — same pattern/limits as create: ≤120 chars, Enter commits,
                      Esc cancels; prefilled; failure keeps it open (FIX 19). */}
                  {renamingSpaceId === workspace.id && (
                    <div className="px-3 py-2 border-t border-[#1a1a1a]/10" data-rename-space-row="true">
                      <input
                        ref={renameInputRef}
                        type="text"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); void submitRename(workspace.id); }
                          if (e.key === 'Escape') { e.preventDefault(); setRenamingSpaceId(null); setRenameValue(''); }
                        }}
                        placeholder="Workspace name…"
                        maxLength={120}
                        disabled={renameBusy}
                        onFocus={(e) => e.currentTarget.select()}
                        className={`w-full border ${tc.border} ${tc.bg} ${tc.text} px-3 py-1.5 text-sm rounded-md focus:outline-none focus:border-[#1a1a1a] transition-colors ${tc.fontClass}`}
                      />
                      <p className={`mt-1 text-[10px] ${tc.muted} ${tc.fontClass}`}>
                        Enter to rename · Esc to cancel{renameBusy ? ' · Renaming…' : ''}
                      </p>
                    </div>
                  )}

                  {/* DELETE confirmation — web-parity two-step guard (WorkspaceOptionsModal):
                      exact wording, Back returns, Confirm deletes. No undo exists in the web
                      flow, so none here either (study finding). */}
                  {deleteTargetId === workspace.id && (
                    <div data-ws-delete-confirm={workspace.id} className="px-3 py-2 border-t border-[#1a1a1a]/10">
                      <p className={`text-xs leading-relaxed mb-2 ${tc.muted} ${tc.fontClass}`}>
                        {`Delete "${workspace.name}"? This permanently deletes the workspace and ALL its drops for everyone. This cannot be undone.`}
                      </p>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setDeleteTargetId(null); }}
                          disabled={deleteBusy}
                          className={`flex-1 px-2 py-1.5 text-xs border ${tc.border} rounded-md ${tc.text} hover:bg-[#1a1a1a]/5 transition-colors disabled:opacity-50 ${tc.fontClass}`}
                        >
                          Back
                        </button>
                        <button
                          type="button"
                          data-ws-confirm-delete="true"
                          onClick={(e) => { e.stopPropagation(); void submitDelete(workspace.id); }}
                          disabled={deleteBusy}
                          className={`flex-1 px-2 py-1.5 text-xs bg-red-500 hover:bg-red-600 text-white rounded-md transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50 ${tc.fontClass}`}
                        >
                          {deleteBusy ? (
                            <>
                              <span className="w-3 h-3 border-2 border-white/40 border-t-white animate-spin rounded-full" />
                              Deleting...
                            </>
                          ) : (
                            'Confirm delete'
                          )}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            <div className={`border-t ${tc.border}`} />

            {/* New workspace — expands an inline create row (FIX 3) */}
            {!creatingSpace ? (
              <button
                onClick={() => setCreatingSpace(true)}
                className="w-full px-3 py-2 text-left flex items-center gap-2 hover:bg-[#1a1a1a]/5 transition-colors"
              >
                <svg
                  className={`w-3.5 h-3.5 ${tc.text}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                <span className={`${tc.fontClass} text-sm ${tc.text}`}>New workspace</span>
              </button>
            ) : (
              <div className="px-3 py-2 border-t border-[#1a1a1a]/10" data-create-space-row="true">
                <input
                  ref={newSpaceInputRef}
                  type="text"
                  value={newSpaceName}
                  onChange={(e) => setNewSpaceName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); void submitNewSpace(); }
                    if (e.key === 'Escape') { e.preventDefault(); setCreatingSpace(false); setNewSpaceName(''); }
                  }}
                  placeholder="Workspace name…"
                  maxLength={120}
                  disabled={spaceCreateBusy}
                  className={`w-full border ${tc.border} ${tc.bg} ${tc.text} px-3 py-1.5 text-sm rounded-md focus:outline-none focus:border-[#1a1a1a] transition-colors ${tc.fontClass}`}
                />
                <p className={`mt-1 text-[10px] ${tc.muted} ${tc.fontClass}`}>
                  Enter to create · Esc to cancel{spaceCreateBusy ? ' · Creating…' : ''}
                </p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
