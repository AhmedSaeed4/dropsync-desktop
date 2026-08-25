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
  /** C2 dressed-login probe evidence: current dressing flag + apply/remove counters. */
  dressedProbe(): DressingState;
  /** C2 f_c2_dressedLogin — full dance WITHOUT credentials: on unauth home the dressing must
   * be applied; leaving the auth route removes it; returning reapplies it. Drives real
   * same-origin top-nav inside the cloud view and polls the dressing flag. */
  probeDressedSequence(): Promise<{
    f_c2_dressedLogin: boolean;
    applied: boolean;
    removedAfterLeave: boolean;
    reappliedOnReturn: boolean;
  }>;
}

/** C2 — read-only porch session discovery result (never fakes an email). */
export interface CloudSessionProbe {
  signedIn: boolean;
  email: string | null;
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

// ---- C2 Option A "dressed login" -------------------------------------------------------
// When the cloud view sits on an UNAUTHENTICATED login surface, apply display-only styling via
// webContents.insertCSS(): hide the site's header/footer/marketing chrome, cream backdrop,
// rounded-full inputs/buttons. The REAL form stays functional — credentials go keyboard→site
// directly; zero middleman handling. Defensive rule: a missed selector just renders normally.
// Dressing is removed once authenticated/off the route so the normal framed-site look returns.

/** Site paths that can host the login surface. The real site's sign-in lives on `/` when
 * signed out (drag-drop-app/src/app/page.tsx renders the Google button + auth modal there);
 * extra patterns are future-proofing only. */
const AUTH_PATHS = new Set(['/', '/login', '/signin', '/auth']);

const DRESS_CSS = `
  html, body { background: #FAF7F2 !important; color: #1a1a1a !important; }
  header, footer, nav { display: none !important; }
  body { display: flex !important; align-items: center; justify-content: center; min-height: 100vh !important; }
  input, textarea, select { border-radius: 100px !important; background: #FAF7F2 !important; color: #1a1a1a !important; border-color: rgba(26,26,26,.25) !important; }
  input:focus { outline: none !important; border-color: #1a1a1a !important; }
  button { border-radius: 100px !important; font-family: inherit !important; transition: all .25s ease !important; }
`;
/** Read-only check INSIDE the page: does an unauthenticated login surface exist here? Hook =
 * any button whose text matches the site's real sign-in buttons ("Sign in with Google").
 * Misses are harmless (page simply stays undressed). Never typed into, never clicked by us. */
const LOGIN_UI_CHECK =
  "[...document.querySelectorAll('button')].some((b) => /sign in with google/i.test(b.textContent || ''))";

interface DressingState {
  dressed: boolean;
  appliedCount: number;
  removedCount: number;
}

function attachAuthDressing(wc: Electron.WebContents, state: DressingState): void {
  let dressKey: string | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const stopPoll = (): void => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };
  const undress = async (): Promise<void> => {
    stopPoll();
    if (dressKey) {
      const key = dressKey;
      dressKey = null;
      state.dressed = false;
      state.removedCount += 1;
      console.log('[cloud] dressing removed');
      try {
        await wc.removeInsertedCSS(key);
      } catch { /* page may have navigated under us — harmless */ }
    }
  };
  const evaluate = async (): Promise<void> => {
    let onAuthPath = false;
    try {
      const u = new URL(wc.getURL());
      onAuthPath = u.origin === CLOUD_ORIGIN && AUTH_PATHS.has(u.pathname);
    } catch { onAuthPath = false; }
    if (!onAuthPath) return void undress();
    const hasLoginUI = await wc.executeJavaScript(`!!(${LOGIN_UI_CHECK})`).catch(() => false);
    if (!hasLoginUI) return void undress(); // authenticated or form gone → normal framed look
    if (!dressKey) {
      try {
        dressKey = await wc.insertCSS(DRESS_CSS);
        state.dressed = true;
        state.appliedCount += 1;
        console.log('[cloud] dressing applied');
      } catch (error) {
        console.log('[cloud] insertCSS failed:', error instanceof Error ? error.message : String(error));
      }
    }
    // Poll while dressed: popup-driven sign-in completes WITHOUT navigation, so removal must
    // be reactive to the form disappearing, not just to route changes.
    if (!pollTimer) pollTimer = setInterval(() => void evaluate(), 1500);
  };

  wc.on('did-navigate', () => void evaluate());
  wc.on('did-navigate-in-page', () => void evaluate());
  wc.on('did-finish-load', () => void evaluate());
}

/**
 * C2 email discovery (read-only): a HIDDEN temporary WebContentsView on persist:cloud loads
 * the site origin and reads the signed-in marker studied in C1 (firebase:authUser keys);
 * the email is extracted ONLY if trivially available in that storage JSON. NEVER writes site
 * storage; the view is destroyed after reading. Uncertain ⇒ {signedIn:false} — the porch then
 * renders the neutral card; we do NOT fake an email. Runs async, never blocks porch paint.
 */
export async function probeCloudSessionEmail(): Promise<{
  signedIn: boolean;
  email: string | null;
}> {
  const temp = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      sandbox: true,
      // I1: NO preload key at all.
    },
  });
  try {
    temp.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); // hidden view: no popups
    const loaded = await Promise.race([
      new Promise<boolean>((resolve) => {
        temp.webContents.once('did-finish-load', () => resolve(true));
        temp.webContents.once('did-fail-load', (_e, _c, desc) => {
          console.log('[cloud] email-probe did-fail-load:', desc);
          resolve(false);
        });
      }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20_000)),
    ]);
    if (!loaded) return { signedIn: false, email: null };
    // Settle briefly so Firebase can restore its authUser localStorage entry post-hydration.
    await new Promise((r) => setTimeout(r, 2500));
    return (await temp.webContents.executeJavaScript(
      `(async () => {
        const keys = Object.keys(localStorage).filter((k) => k.startsWith('firebase:authUser'));
        for (const k of keys) {
          try {
            const v = JSON.parse(localStorage.getItem(k) || '{}');
            if (typeof v.email === 'string' && v.email.includes('@')) {
              return { signedIn: true, email: v.email };
            }
          } catch {}
        }
        return { signedIn: false, email: null };
      })()`
    )) as { signedIn: boolean; email: string | null };
  } catch {
    return { signedIn: false, email: null };
  } finally {
    try {
      temp.webContents.close(); // destroy the hidden view after reading
    } catch { /* already gone */ }
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
  const dressing: DressingState = { dressed: false, appliedCount: 0, removedCount: 0 };

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
    attachAuthDressing(view.webContents, dressing);
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
    dressedProbe: () => ({ ...dressing }),
    probeDressedSequence: async () => {
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
      if (!view) {
        return { f_c2_dressedLogin: false, applied: false, removedAfterLeave: false, reappliedOnReturn: false };
      }
      const wc = view.webContents;
      // Initial evaluate runs on did-finish-load; give it (and its 1.5s poll) a beat.
      await sleep(2500);
      const applied = dressing.dressed;
      await wc.executeJavaScript("location.href = '/docs'").catch(() => {});
      for (let i = 0; i < 8 && dressing.dressed; i++) await sleep(500);
      const removedAfterLeave = !dressing.dressed;
      await wc.executeJavaScript("location.href = '/'").catch(() => {});
      for (let i = 0; i < 12 && !dressing.dressed; i++) await sleep(500);
      const reappliedOnReturn = dressing.dressed;
      return {
        f_c2_dressedLogin: applied && removedAfterLeave && reappliedOnReturn,
        applied,
        removedAfterLeave,
        reappliedOnReturn,
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
