// Round 111 (#29) — the app-wide right-click menu. A normal browser ships a context menu;
// Electron ships none, so the app never had Copy on right-click (owner report 2026-09-14).
// ONE 'context-menu' listener per target pops OUR native menu. Everything the menu decides
// on arrives in the event payload computed by Chromium (isEditable / selectionText /
// editFlags) — we never read or execute anything inside the page, so Cloud site-view
// sanctity holds (same outside-sensing posture as cloud.ts's input-event idle-clock feed).
// Empty non-editable right-clicks stay silent so pages keep their own menus (YouTube's
// player menu included).
import { Menu, MenuItemConstructorOptions, WebContents } from 'electron';

/** Menu items for a right-click, or null when our menu must stay silent. */
export function buildContextMenuItems(props: {
  isEditable: boolean;
  selectionText: string;
  editFlags: { canCopy: boolean; canCut: boolean; canPaste: boolean };
}): MenuItemConstructorOptions[] | null {
  if (props.isEditable) {
    return [
      { label: 'Cut', role: 'cut', enabled: props.editFlags.canCut },
      { label: 'Copy', role: 'copy', enabled: props.editFlags.canCopy },
      { label: 'Paste', role: 'paste', enabled: props.editFlags.canPaste },
      { type: 'separator' },
      { label: 'Select All', role: 'selectAll' },
    ];
  }
  if (props.selectionText.trim().length > 0) {
    return [{ label: 'Copy', role: 'copy', enabled: props.editFlags.canCopy }];
  }
  return null;
}

const attached = new Map<string, WebContents>();

/** True while the labeled target's webContents is alive and carries our listener. */
export function isContextMenuAttached(label: string): boolean {
  const wc = attached.get(label);
  return wc !== undefined && !wc.isDestroyed();
}

/**
 * Attach once per label; the label doubles as the battery's assertion key (f_29_attached*
 * legs) — the menu is OUR native UI, so no page-side probe can exist. A destroyed target
 * frees its label so a recreated view (cloud ensureView retries) re-attaches cleanly.
 */
export function attachContextMenu(wc: WebContents, label: string): void {
  const existing = attached.get(label);
  if (existing !== undefined && !existing.isDestroyed()) return;
  attached.set(label, wc);
  wc.once('destroyed', () => {
    if (attached.get(label) === wc) attached.delete(label);
  });
  wc.on('context-menu', (_event, props) => {
    const items = buildContextMenuItems(props);
    if (items === null) return;
    // No x/y: popup() opens at the mouse cursor on Windows — exactly where the right-click
    // landed — and skips all view↔window coordinate math (the site view is a
    // WebContentsView layered inside the main window).
    Menu.buildFromTemplate(items).popup();
  });
}
