/**
 * Cloud mode core (PART C1) — the REAL deployed site embedded as a WebContentsView.
 *
 * Security invariants binding this file (CLOUD-MODE-PLAN I1–I3, I6):
 * - I1: the cloud view runs in session 'persist:cloud' with NO preload key AT ALL — zero
 *   window.dropsync access from site/popup contents, proven by f_c1_isolationGuard.
 * - I2: top-level navigation stays on the site origin; child windows ONLY for auth providers
 *   (Google/Apple/Microsoft accounts); other http(s) popups go to https-only shell.openExternal;
 *   everything else is denied.
 * - I3: popups inherit 'persist:cloud' explicitly — Google sign-in cookies must match or
 *   sign-in silently fails.
 * - I6: probes are env-gated (DROPSYNC_CLOUD_DEV=1); nothing here ships user-facing behavior
 *   beyond what C1 specifies.
 *
 * Badge notch ruling (planner §4): a WebContentsView always paints above our renderer HTML,
 * so instead of an overlay we RESERVE space — the view's bounds are the window content bounds
 * minus one notch band at the bottom edge of height NOTCH_H; our renderer stays visible there
 * and ModeBadge draws the dot+word strip bottom-right. A true L-shaped corner is impossible
 * with one rectangular WebContentsView; the freed BOTTOM BAND is the rectangular decomposition
 * (flagged in the report). One view max, created lazily on first show, reused forever after.
 */

import { BrowserWindow, session, shell, WebContentsView } from 'electron';

export const CLOUD_URL = 'https://drag-drop-app.vercel.app';
const CLOUD_ORIGIN = 'https://drag-drop-app.vercel.app';
const PARTITION = 'persist:cloud';
/** Bottom band reserved for the local badge strip (ModeBadge lives in our renderer DOM). */
export const NOTCH_H = 34;
/** §3-I2 auth-provider popup allowlist (hostnames). `dropsync-1773445054.firebaseapp.com` is
 * the web app's Firebase authDomain (drag-drop-app/.env.local:5 NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
 * consumed at src/lib/firebase.ts:15) — Firebase signInWithPopup (drag-drop-app/src/lib/auth.ts:26)
 * opens the handler THERE first, then routes to accounts.google.com and back. No *.web.app or
 * other auth domains are referenced anywhere in the web app. */
const AUTH_POPUP_ALLOWLIST = new Set([
  'dropsync-1773445054.firebaseapp.com',
  'accounts.google.com',
  'accounts.video.google.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
]);

export interface CloudController {
  show(): void;
  hide(): void;
  isVisible(): boolean;
  /** Probe data for DROPSYNC_CLOUD_DEV: did-finish-load latency for the site origin, if loaded. */
  probeState(): { readyMs: number | null; url: string | null };
  /** f_c1_isolationGuard — evaluate INSIDE the cloud contents (I1: no bridge may exist). */
  probeIsolation(): Promise<{ dropsyncType: string; hasPreloadKey: true }>;
  /**
   * f_c1_authSeen — READ-ONLY signed-in marker inside the persist:cloud session. Marker chain
   * per spec §5.5: Firebase auth localStorage keys first, then an account/avatar DOM chip.
   * Evidence returned raw so the battery can judge; no guessing beyond these two signals.
   */
  probeAuthSeen(): Promise<{ firebaseAuthKeys: number; accountChip: boolean }>;
  /** Persistence proof WITHOUT credentials: a seed-once localStorage marker in the
   * persist:cloud partition; surviving app restarts proves the partition hits disk. */
  probePersistProof(): Promise<{ present: boolean; seeded: boolean; value: string | null }>;
  /** C1b FIX D — read-only probe of OUR guard behavior: open the Firebase auth-handler URL
   * via window.open inside the cloud view; it must pass the allowlist end-to-end and yield a
   * real child window that reaches did-finish-load. The popup is closed again afterwards so
   * the no-leak invariant holds. NOTE: OAuth popups are top-level BrowserWindows, NOT
   * contentView children — window count is the correct leak signal here. */
  probeSyntheticAuthPopup(): Promise<{
    f_c1b_popupAllowed: boolean;
    popupLoadMs: number | null;
    windowsBefore: number;
    windowsMax: number;
    windowsAfter: number;
  }>;
}

/** https-only external handoff (I2). Returns true when handed off. */
function openExternalHttps(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    void shell.openExternal(url);
    return true;
  } catch {
    return false;
  }
}

/** Popup decision (I2): 'allow' = auth allowlist popup joins the partition; 'external' =
 * non-auth https handed to the browser; 'deny' = everything else. */
function decidePopup(url: string): 'allow' | 'external' | 'deny' {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && AUTH_POPUP_ALLOWLIST.has(u.hostname)) return 'allow';
    if (u.protocol === 'https:') return 'external';
  } catch { /* unparseable → deny */ }
  return 'deny';
}

/**
 * Attach I2/I3 guards to a webContents.
 * - `strictNav: true`  → MAIN cloud view only: same-origin will-navigate wall stays exactly as
 *   shipped in C1 (the vault-side wall).
 * - `strictNav: false` → AUTH POPUPS (and their chains): keep the window-open gate + did-fail-
 *   load logging, but NO will-navigate preventDefault — the popup's whole job is cross-host
 *   bouncing (firebaseapp.com ⇄ accounts.google.com); that IS the OAuth protocol, it runs in
 *   the same sandboxed persist:cloud session, and its terminal state is self-close.
 */
function attachGuards(
  wc: Electron.WebContents,
  opts: { strictNav: boolean },
  onFirstLoad: () => void,
): void {
  let firstLoadSeen = false;
  wc.once('did-finish-load', () => {
    if (!firstLoadSeen) {
      firstLoadSeen = true;
      onFirstLoad();
    }
  });
  wc.on('did-fail-load', (_e, code, desc, url) => {
    // C1: log only — Chromium's default error page is accepted (friendly card is C3).
    console.log('[cloud] did-fail-load:', code, desc, url.slice(0, 120));
  });
  wc.setWindowOpenHandler(({ url }) => {
    // FIX C — every decision path is loud; this class of bug must never be invisible again.
    const decision = decidePopup(url);
    console.log('[cloud] popup', decision, url.slice(0, 120));
    if (decision === 'allow') {
      // I3: popup explicitly joins the cloud partition or Google sign-in silently fails.
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { webPreferences: { partition: PARTITION, sandbox: true } },
      };
    }
    if (decision === 'external') openExternalHttps(url);
    return { action: 'deny' };
  });
  wc.on('did-create-window', (child) => attachGuards(child.webContents, { strictNav: false }, onFirstLoad));
  if (opts.strictNav) {
    wc.on('will-navigate', (e, url) => {
      try {
        const u = new URL(url);
        if (u.origin === CLOUD_ORIGIN) return; // same-origin top-nav is the site's business
        e.preventDefault();
        console.log('[cloud] nav-denied', url.slice(0, 120));
        if (!openExternalHttps(url)) console.log('[cloud] nav-denied non-https, dropped');
      } catch {
        e.preventDefault();
        console.log('[cloud] nav-denied unparseable');
      }
    });
  }
}

export function initCloud(mainWindow: BrowserWindow): CloudController {
  let view: WebContentsView | null = null;
  let shown = false;
  let readyMs: number | null = null;
  let loadStartedAt = 0;

  /** Bounds = content bounds minus the bottom badge band (planner §4, rectangular form). */
  const applyBounds = (): void => {
    if (!view) return;
    const b = mainWindow.getContentBounds();
    view.setBounds({ x: 0, y: 0, width: b.width, height: Math.max(0, b.height - NOTCH_H) });
  };

  const ensureView = (): WebContentsView => {
    if (view) return view;
    view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        // I1: deliberately NO `preload` key AT ALL — zero window.dropsync in cloud contents.
      },
    });
    loadStartedAt = Date.now();
    attachGuards(view.webContents, { strictNav: true }, () => {
      readyMs = Date.now() - loadStartedAt;
      console.log('[cloud] did-finish-load in', readyMs, 'ms');
    });
    void view.webContents.loadURL(CLOUD_URL); // stock UA — never spoofed
    // Keep session cookies on disk (persist:) so sign-in survives app + dev-server restarts.
    void session.fromPartition(PARTITION);
    return view;
  };

  const show = (): void => {
    const v = ensureView();
    if (!shown) {
      mainWindow.contentView.addChildView(v);
      shown = true;
    }
    applyBounds();
    v.setVisible(true);
    v.webContents.focus();
  };

  const hide = (): void => {
    if (view && shown) {
      mainWindow.contentView.removeChildView(view);
      shown = false;
    }
    if (mainWindow.isFocused()) mainWindow.webContents.focus();
  };

  return {
    show,
    hide,
    isVisible: () => shown,
    probeState: () => ({ readyMs, url: view ? CLOUD_URL : null }),
    probeIsolation: async () => {
      if (!view) return { dropsyncType: 'no-view', hasPreloadKey: true as const };
      const dropsyncType = await view.webContents.executeJavaScript('typeof window.dropsync');
      return { dropsyncType, hasPreloadKey: true as const };
    },
    probeAuthSeen: async () => {
      if (!view) return { firebaseAuthKeys: -1, accountChip: false };
      return (await view.webContents.executeJavaScript(
        `(async () => ({
          firebaseAuthKeys: Object.keys(localStorage).filter((k) => k.startsWith('firebase:authUser')).length,
          accountChip: !!document.querySelector('[data-testid*="account" i], [aria-label*="account" i], [aria-label*="avatar" i], img[alt*="avatar" i]'),
        }))()`
      )) as { firebaseAuthKeys: number; accountChip: boolean };
    },
    probePersistProof: async () => {
      if (!view) return { present: false, seeded: false, value: null };
      return (await view.webContents.executeJavaScript(
        `(async () => {
          const k = 'dropsync.c1.persistProof';
          let v = localStorage.getItem(k);
          const seeded = !v;
          if (!v) { v = 'seed-' + Date.now(); localStorage.setItem(k, v); }
          return { present: !!v, seeded, value: v };
        })()`
      )) as { present: boolean; seeded: boolean; value: string | null };
    },
    probeSyntheticAuthPopup: async () => {
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
      if (!view) {
        return { f_c1b_popupAllowed: false, popupLoadMs: null, windowsBefore: 0, windowsMax: 0, windowsAfter: 0 };
      }
      const wc = view.webContents;
      const windowsBefore = BrowserWindow.getAllWindows().length;
      let loaded = false;
      const loadT0 = Date.now();
      const created: Electron.BrowserWindow[] = [];
      const onCreated = (child: Electron.BrowserWindow): void => {
        created.push(child);
        child.webContents.once('did-finish-load', () => { loaded = true; });
      };
      wc.on('did-create-window', onCreated);
      await wc.executeJavaScript(
        "void window.open('https://dropsync-1773445054.firebaseapp.com/__/auth/handler')"
      );
      let windowsMax = BrowserWindow.getAllWindows().length;
      for (let i = 0; i < 20 && !loaded; i++) {
        await sleep(500);
        windowsMax = Math.max(windowsMax, BrowserWindow.getAllWindows().length);
      }
      const popupLoadMs = loaded ? Date.now() - loadT0 : null;
      for (const w of created) if (!w.isDestroyed()) w.close();
      for (let i = 0; i < 10 && BrowserWindow.getAllWindows().length > windowsBefore; i++) await sleep(200);
      wc.removeListener('did-create-window', onCreated);
      return {
        f_c1b_popupAllowed: loaded,
        popupLoadMs,
        windowsBefore,
        windowsMax,
        windowsAfter: BrowserWindow.getAllWindows().length,
      };
    },
  };
}

// Registered by index.ts once per window: keeps the notch glued across geometry changes.
export function attachCloudResizeTracking(
  mainWindow: BrowserWindow,
  controller: CloudController,
): void {
  const handler = (): void => {
    if (controller.isVisible()) controller.show(); // re-apply bounds via the same path
  };
  mainWindow.on('resize', handler);
  mainWindow.on('maximize', handler);
  mainWindow.on('unmaximize', handler);
  mainWindow.on('enter-full-screen', handler);
  mainWindow.on('leave-full-screen', handler);
}
