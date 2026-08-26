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
  /** FIX 2 — re-assert the view bounds (content bounds minus the badge band), idempotently.
   * Cheap to call often; only writes + logs when the bounds actually drift. No focus steal. */
  syncBounds(): void;
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
/** Hard timeout (ms) for ANY in-page probe, so a hung `executeJavaScript` can never wedge the
 * single-flight dressing ticker (or leave a hidden read hanging). */
const PROBE_TIMEOUT_MS = 2000;

/** Race a promise against a hard timeout. `timeoutValue` resolves if the promise is still pending
 * when the timer fires — so callers can treat it as "doubt, fail open". */
function withTimeout<T>(promise: Promise<T>, timeoutValue: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(timeoutValue), PROBE_TIMEOUT_MS)),
  ]);
}

/** Shape returned by CLOUD_PAGE_PROBE (evaluated inside the cloud contents). */
interface PageProbe {
  /** The site's signed-in shell (`#app-shell`) exists — STRONG signed-in marker. */
  appShell: boolean;
  /** Legacy `firebase:authUser*` localStorage keys present (cheap secondary signal). */
  keys: number;
  /** appShell OR keys. */
  signedIn: boolean;
  /** A VISIBLE "Sign in with Google" control is present AND the signed-in shell is absent. */
  surface: boolean;
  /** Best-effort email off the signed-in page's account chip / legacy storage; null if not
   * confidently readable (never faked). */
  email: string | null;
}

/**
 * DOM-truth page probe, evaluated INSIDE the cloud contents (read-only; we never write site
 * storage). Replaces the old localStorage-only `firebase:authUser*` unauth check, which the live
 * site defeats because Firebase now persists auth in IndexedDB (`firebaseLocalStorageDb`), NOT
 * localStorage — so the old signal ALWAYS answered "signed out" and glued the costume onto the
 * SIGNED-IN home page (the white page + side-squish). New signals (see PageProbe). Decision rule
 * (attachAuthDressing): dress ONLY on positive evidence (auth route + shell absent + login surface
 * present); ANY doubt fails OPEN to the site's normal look.
 */
const CLOUD_PAGE_PROBE = `
(async () => {
  let appShell = false, keys = 0, signedIn = false, surface = false, email = null;
  try { appShell = !!document.querySelector('#app-shell'); } catch {}
  try {
    const all = Object.keys(localStorage);
    keys = all.filter((k) => k.startsWith('firebase:authUser')).length;
  } catch {}
  signedIn = appShell || keys > 0;
  if (!appShell) {
    try {
      const els = Array.from(document.querySelectorAll('button, a'));
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        const t = (el.textContent || '').trim().toLowerCase();
        if (t.indexOf('sign in with google') !== -1 && (el.offsetParent !== null || el.getClientRects().length > 0)) {
          surface = true; break;
        }
      }
    } catch {}
  }
  if (signedIn) {
    try {
      const chip = document.querySelector('[data-testid*="account" i], [aria-label*="account" i], [aria-label*="avatar" i], img[alt*="avatar" i]');
      const label = chip ? (chip.getAttribute('aria-label') || chip.getAttribute('title') || (chip.textContent || '')) : '';
      const m = label.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/);
      if (m) email = m[0];
    } catch {}
    if (!email) {
      try {
        const all = Object.keys(localStorage);
        for (let i = 0; i < all.length; i++) {
          const k = all[i];
          if (k.startsWith('firebase:authUser')) {
            try {
              const v = JSON.parse(localStorage.getItem(k) || '{}');
              if (typeof v.email === 'string' && v.email.indexOf('@') !== -1) { email = v.email; break; }
            } catch {}
          }
        }
      } catch {}
    }
  }
  return { appShell: appShell, keys: keys, signedIn: signedIn, surface: surface, email: email };
})()
`;

interface DressingState {
  dressed: boolean;
  appliedCount: number;
  removedCount: number;
}

function attachAuthDressing(wc: Electron.WebContents, state: DressingState): void {
  let dressKey: string | null = null;

  const logDecision = (change: 'APPLIED' | 'REMOVED', reason: string, extra: Record<string, unknown>): void => {
    console.log('[cloud] dressing', change, '-', reason, JSON.stringify(extra));
  };
  const undress = async (reason: string): Promise<void> => {
    if (dressKey) {
      const key = dressKey;
      dressKey = null;
      state.dressed = false;
      state.removedCount += 1;
      logDecision('REMOVED', reason, { url: wc.getURL() });
      try {
        await wc.removeInsertedCSS(key);
      } catch { /* page may have navigated under us — harmless */ }
    }
  };
  /** One reconciliation step: dress ONLY on positive evidence that this is the UNAUTHENTICATED
   * login surface. Runs on navigation events AND a steady 1.5 s tick (covers React hydration
   * racing did-finish-load AND popup-completed auth, where the shell appears without navigation).
   * Single-flight: overlapping ticks could otherwise double-insert CSS. Every in-page probe is
   * wrapped in a 2 s hard timeout so the flag can never wedge on a hung promise. */
  let ticking = false;
  const tick = async (): Promise<void> => {
    if (ticking) return;
    ticking = true;
    try {
      await tickInner();
    } finally {
      ticking = false;
    }
  };
  const tickInner = async (): Promise<void> => {
    let onAuthPath = false;
    try {
      const u = new URL(wc.getURL());
      onAuthPath = u.origin === CLOUD_ORIGIN && AUTH_PATHS.has(u.pathname);
    } catch { onAuthPath = false; }
    if (!onAuthPath) return void undress('off-route');
    // DOM-truth probe with a hard timeout. `null` = the probe did NOT resolve in time → doubt →
    // fail OPEN (remove the costume; never wedge the flag).
    let probe: PageProbe | null = null;
    try {
      probe = await withTimeout<PageProbe | null>(
        wc.executeJavaScript(CLOUD_PAGE_PROBE) as Promise<PageProbe>,
        null,
      );
    } catch (error) {
      console.log('[cloud] tick: execJS threw:', error instanceof Error ? error.message : String(error));
      return void undress('exec-error');
    }
    if (!probe) return void undress('probe-timeout');
    // Dress ONLY on positive evidence: on an auth route AND NOT signed-in AND a visible "Sign in
    // with Google" control is present. The signed-in marker = `#appShell` OR any legacy
    // `firebase:authUser*` localStorage key (so injecting such a key — the f_c2d_dressFailSafe probe
    // — correctly REMOVES the costume). Everything else (signed-in, probe timeout, exec error,
    // off-route) removes the costume. This is the fail-open guarantee: the signed-in app never wears
    // the disguise.
    const shouldDress = onAuthPath && !probe.signedIn && probe.surface;
    if (shouldDress && !dressKey) {
      try {
        dressKey = await wc.insertCSS(DRESS_CSS);
        state.dressed = true;
        state.appliedCount += 1;
        logDecision('APPLIED', 'login-surface-detected', {
          route: wc.getURL(),
          appShell: probe.appShell,
          keys: probe.keys,
          surface: probe.surface,
        });
      } catch (error) {
        console.log('[cloud] insertCSS failed:', error instanceof Error ? error.message : String(error));
      }
    } else if (!shouldDress && dressKey) {
      undress('authenticated-or-no-surface');
    }
  };
  const timer = setInterval(() => void tick(), 1500);
  wc.once('destroyed', () => clearInterval(timer));
  wc.on('did-navigate', () => void tick());
  wc.on('did-navigate-in-page', () => void tick());
  wc.on('did-finish-load', () => void tick());
}

/**
 * C2 email discovery (read-only): a HIDDEN temporary WebContentsView on persist:cloud loads the
 * site origin and reads the SAME corrected DOM-truth probe used by the dressing detector
 * (`#app-shell` presence OR a legacy `firebase:authUser` localStorage key ⇒ signed in). The email
 * is extracted from the signed-in page's account chip (best effort; never faked). If not
 * confidently readable ⇒ {signedIn:true, email:null} → honest neutral porch card. NEVER writes
 * site storage; the view is destroyed after reading. Runs async, never blocks porch paint.
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
    // Settle briefly so React can mount the signed-in shell + restore auth post-hydration.
    await new Promise((r) => setTimeout(r, 2500));
    // Read signed-in state via the SAME corrected DOM-truth probe (IndexedDB-backed Firebase auth
    // no longer hides behind a missing localStorage key). Email comes from the signed-in page's
    // account chip, never faked; if not confidently readable we report signed-in + null email →
    // honest neutral card. NEVER fabricate an address.
    const probe = await withTimeout<PageProbe | null>(
      temp.webContents.executeJavaScript(CLOUD_PAGE_PROBE) as Promise<PageProbe>,
      null,
    );
    if (probe && probe.signedIn) return { signedIn: true, email: probe.email };
    return { signedIn: false, email: null };
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

  /** Bounds = content bounds minus the bottom badge band (planner §4, rectangular form). Idempotent:
   * compares against the view's current bounds and only writes (logging) when they actually differ,
   * so the resize handlers, the deferred re-apply, and the watchdog can all call it freely with no
   * focus steal and no log spam. */
  const syncBounds = (): void => {
    if (!view) return;
    if (mainWindow.isDestroyed()) return;
    const b = mainWindow.getContentBounds();
    const expected = { x: 0, y: 0, width: b.width, height: Math.max(0, b.height - NOTCH_H) };
    const cur = view.getBounds();
    if (cur.x !== expected.x || cur.y !== expected.y || cur.width !== expected.width || cur.height !== expected.height) {
      view.setBounds(expected);
      console.log('[cloud] bounds set', JSON.stringify({ from: cur, to: expected }));
    }
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
    syncBounds();
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

  // Bounds watchdog (FIX 2c): even if WSLg swallows EVERY resize/maximize/full-screen event, a 1 s
  // tick re-asserts the correct bounds while the view is visible. syncBounds is idempotent + guarded
  // so it never touches a destroyed window and only logs on a real drift.
  const boundsWatchdog = setInterval(() => {
    if (mainWindow.isDestroyed()) return;
    if (view && shown) syncBounds();
  }, 1000);
  mainWindow.once('closed', () => clearInterval(boundsWatchdog));

  return {
    show,
    hide,
    isVisible: () => shown,
    syncBounds,
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
      // Initial tick runs on did-finish-load; give React hydration + the 1.5 s dressing tick
      // a comfortable beat before judging `applied`.
      await sleep(4500);
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
  // FIX 2a/b: re-apply bounds via syncBounds() (NO focus steal) and re-apply at 0/100/400 ms —
  // WSLg may deliver the final size late, so the deferred re-apply guarantees the view follows.
  const handler = (): void => {
    if (!controller.isVisible()) return;
    controller.syncBounds();
    setTimeout(() => controller.syncBounds(), 100);
    setTimeout(() => controller.syncBounds(), 400);
  };
  mainWindow.on('resize', handler);
  mainWindow.on('maximize', handler);
  mainWindow.on('unmaximize', handler);
  mainWindow.on('enter-full-screen', handler);
  mainWindow.on('leave-full-screen', handler);
}
