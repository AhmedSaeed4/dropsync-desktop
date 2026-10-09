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

// ==== Round 120 (View-as lenses) — the native "View as" submenu =========================
// The renderer's text surfaces own the truth (current lens, recommendations, and the
// lens label list — the web-verbatim LENSES ride the request payload, so this file never
// duplicates them). A right-click there suppresses the round-111 listener for that click
// (DOM preventDefault — suppression probe-proven 2026-10-08) and requests the COMBINED
// menu with renderer-side facts. The round-111 items are recomputed by the UNTOUCHED
// buildContextMenuItems from those facts (same rules, never re-implemented); the View-as
// submenu carries the web menu's content semantics: Recommended first, separator, all
// lenses, a check on the current one (checkbox renders a ✓ on Windows — the web's glyph).

/** Round 120 menu-request payload (mirrors ViewAsMenuRequestDTO in preload\apiTypes.ts —
 * main cannot import preload types across bundles; the DTO is the typed authority). */
export interface ViewAsMenuRequest {
  surfaceId: string;
  lens: string;
  lenses: { lens: string; label: string }[];
  recommendations: { lens: string; score: number }[];
  selection: { text: string; isEditable: boolean; editFlags: { canCopy: boolean; canCut: boolean; canPaste: boolean } };
}

/** Round 120: the combined View-as menu — round-111 items from the request's facts, then
 * the View-as submenu. Shown with popup() at the cursor (the round-111 no-x/y rule);
 * `send` delivers a pick back to the requesting renderer. */
export function buildViewAsMenuItems(request: ViewAsMenuRequest, send: (lens: string) => void): MenuItemConstructorOptions[] {
  const base = buildContextMenuItems({
    isEditable: request.selection.isEditable,
    selectionText: request.selection.text,
    editFlags: request.selection.editFlags,
  });
  const labelFor = (lens: string): string => request.lenses.find(item => item.lens === lens)?.label ?? lens;
  const lensItem = (lens: string): MenuItemConstructorOptions => ({
    label: labelFor(lens),
    type: 'checkbox',
    checked: lens === request.lens,
    click: () => send(lens),
  });
  const submenu: MenuItemConstructorOptions[] = [
    ...request.recommendations.map(item => lensItem(item.lens)),
    { type: 'separator' },
    ...request.lenses.map(item => lensItem(item.lens)),
  ];
  return [
    ...(base ?? []),
    ...(base ? [{ type: 'separator' } as MenuItemConstructorOptions] : []),
    { label: 'View as', submenu },
  ];
}

/** Round 120: transient per-webContents view-as availability (hygiene + battery legs
 * only — a menu request carries its own facts; this store never decides anything).
 * Cleared by the surface's available:false report (unmount) and by destruction. */
const viewAsLive = new Map<WebContents, boolean>();

export function setViewAsAvailability(wc: WebContents, available: boolean): void {
  if (!available) {
    viewAsLive.delete(wc);
    return;
  }
  if (!viewAsLive.has(wc)) wc.once('destroyed', () => viewAsLive.delete(wc));
  viewAsLive.set(wc, true);
}

export function isViewAsLive(wc: WebContents): boolean {
  return viewAsLive.get(wc) === true && !wc.isDestroyed();
}
