/**
 * Cloud mode core (PART C2f — "THE GREAT SIMPLIFICATION") — the REAL deployed site embedded as a
 * WebContentsView at TRUE FULL-WINDOW size, plus the floating pill overlay in its own tiny
 * transparent native layer stacked ABOVE the site view.
 *
 * Security invariants binding this file (CLOUD-MODE-PLAN I1–I3, I6):
 * - I1: the site view runs in session 'persist:cloud' with NO preload key AT ALL — zero
 *   window.dropsync access from site/popup contents, proven by f_c1_isolationGuard. The pill
 *   layer is covered by the same probe (its bridge is `dropsyncPill`, never `dropsync`).
 * - I2: top-level navigation stays on the site origin; child windows ONLY for auth providers
 *   (Google/Apple/Microsoft accounts); other http(s) popups go to https-only shell.openExternal;
 *   everything else is denied.
 * - I3: popups inherit 'persist:cloud' explicitly — Google sign-in cookies must match or
 *   sign-in silently fails.
 * - I6: probes are env-gated (DROPSYNC_CLOUD_DEV=1); nothing here ships user-facing behavior
 *   beyond what C2f specifies.
 *
 * C2f rulings baked in here:
 * - The site is NEVER modified by us: no style injection, no injected probes, no costumes. Signed in ⇒
 *   their app; signed out ⇒ THEIR OWN login page, byte-for-byte. Logout lands where the site
 *   puts it — desktop reacts ZERO.
 * - The site view is {0,0,w,h} — no notch band, no strip (the old bottom-band concept is gone).
 * - Z-ORDER: contentView children paint in add-order. The pill is added AFTER the site view and
 *   re-added LAST whenever the site view is (re-)added — see show()/ensurePill().
 * - The pill NEVER hides and NEVER fades: it survives mode switches, Local mode, everything.
 * - C2d's self-heal pattern is KEPT and generalized: ONE watchdog re-asserts BOTH the site view
 *   bounds (full window, when shown) AND the pill overlay bounds (C2g: top-center, style/bloom-
 *   aware width, always), with the 0/100/400 ms deferred re-apply on geometry events.
 */

import { BrowserWindow, app, session, shell, WebContentsView } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CLOUD_URL = 'https://drag-drop-app.vercel.app';
const CLOUD_ORIGIN = 'https://drag-drop-app.vercel.app';
const PARTITION = 'persist:cloud';
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

/** C2g FIX 1 — floating pill geometry (owner-locked, ported VERBATIM from
 * pill-variants-explainer.html §1: "Variant A — punch-hole", 112 × 28 at TOP-CENTER,
 * 10px from the top). `PILL_B_REST_W` is Style B's at-rest footprint (the 28 × 28 dot-pair);
 * when Style B is hovered/bloomed the VISIBLE pill is the full 112 × 28 (§1 ZERO-MISS CLICK
 * RULE: view bounds always EQUAL the visible pill) — while BLOOMED the native ROOM adds
 * symmetric breathing room around it (`PILL_BLOOM_PAD_*`, hotfix-4 FIX 2), which changes no
 * rest-state footprint. The old C2f values (176/40/14 top-left) are gone. */
export const PILL_W = 112;
export const PILL_H = 28;
export const PILL_TOP = 10;
export const PILL_B_REST_W = 28;

/** C2j — the reminder CARD layer (LEG 2): a THIRD trusted local view, sibling of the pill.
 * A due reminder must be IMPOSSIBLE to miss, so it floats over WHICHEVER world is on screen
 * (native z-order: site < card < pill). Footprint discipline mirrors the pill's zero-miss rule:
 * with NO card active the layer is COLLAPSED (0×0 at its anchor corner — paints nothing, eats
 * no clicks); while a card shows, bounds are exactly CARD_W × CARD_H at the top-right anchor.
 * The site view is never navigated/injected/CSSed (invariants I1/I6 untouched). */
export const CARD_W = 348;
export const CARD_H = 92;
export const CARD_TOP = PILL_TOP + 42; // 52 — one comfortable row below the pill band
export const CARD_RIGHT = 14;
/** Product dwell constants — NOT animation timings: how long a card stays up, the polite gap
 * between consecutive cards, and how many missed reminders may queue before overflow drops
 * the OLDEST (whose count rides the next flushed card as a single "+N older" body prefix). */
export const AUTO_DISMISS_MS = 5500;
export const NEXT_GAP_MS = 400;
export const MAX_MISSED = 20;

/** C2g-hotfix-4 FIX 2 — Style-B BLOOM-TIME breathing room ONLY (explicit owner-approved
 * trade-off). While bloomed, the native room grows to 132 × 44 so TWO things never clip inside
 * the page: the contracted elastic overshoot (bezier peaks ≈ +8 px past 112 mid-bounce) and the
 * ~7 px drop-shadow halo (which used to render as a hard-edged "box" against the room wall).
 * AT REST the room stays EXACTLY the 28 × 28 footprint — the zero-miss rule at rest is sacred;
 * Style A stays exactly 112 × 28 at all times. The skirt exists only WHILE BLOOMED, when the
 * cursor is by definition on the pill, so it eats no site clicks in practice; hover-out now
 * means clearing the 132 px room, so an open pill "holds" ~10 px longer around its edges
 * (documented behavior, not a bug). */
export const PILL_BLOOM_PAD_X = 10;
export const PILL_BLOOM_PAD_Y = 8;

/** C2g-hotfix-6 FIX 2 — Style A FLIP-TIME breathing room ONLY. The knob's contracted elastic
 * transform (0.6s cubic-bezier(0.34,1.56,0.64,1), ~54 px travel) overshoots ≈+6 px past its
 * target on BOTH flip directions; at a rest room of exactly 112 × 28 that overshoot (+ shadow)
 * was hard-clipped by the room wall ("a box with a boundary attached to it"). While a Style A
 * flip is animating or holding, `pillBounds()` returns a 124 × 28 centered room
 * (112 + 2 × PILL_A_FLIP_PAD_X); pad_Y = 0 because the knob never moves vertically. AT REST the
 * room is STILL exactly 112 × 28 — the zero-miss footprint is sacred and untouched. These two
 * constants are NOT animation timings and are NOT part of the ANIMATION CONTRACT: */
export const PILL_A_FLIP_PAD_X = 6;
/** …the hold is a CONTRACT COUPLING (= the knob's 0.6 s transform duration + one frame): if the
 * CONTRACT knob duration ever changes, this constant MUST change with it. Same nature as
 * hotfix-5's collapse hold. Accepted micro-residual (documented, do NOT blank for it): when a
 * knife-edge room swap overlaps a click, the rebloom can settle with ≤2 frames of ≤6 px twitch. */
const PILL_A_FLIP_ROOM_HOLD_MS = 620;

/** C2h — minimum gap between gesture→touch feeds so event bursts (key repeats, scroll storms)
 * collapse to one stamp per half-second on the shared idle-auto-lock clock. Policy constant,
 * not an animation timing. */
const ACTIVITY_FEED_MIN_GAP_MS = 500;

/** C2g-hotfix-5 FIX 2 — how long the BLOOMED native room (132 × 44) HOLDS after a collapse
 * request, so the CSS shrink (contract: width 0.55s elastic) can play OUTSIDE any clipping wall
 * and the final 28 px snap lands on an exactly-28-wide, centered, invisible-change pill. This is
 * a CONTRACT COUPLING, not an independent animation timing: it equals the contract's width
 * duration (550 ms) plus one frame (~16 ms) — if the CONTRACT width duration ever changes, this
 * constant MUST change with it. Known accepted micro-residual (documented, out of scope): at the
 * snap instant the compositor may present ≤1 stale frame cropped to the new room's top-left — an
 * ≤18×20 px sliver of the pill's left arc shifting ~10 px, at rest size, for ≤16 ms. */
const PILL_COLLAPSE_ROOM_HOLD_MS = 570;

/** C2g — the two owner-approved pill styles. A = "punch-hole" (default on first boot),
 * B = "micro bloom" (28 × 28 dots → blooms to the full pill on hover). Right-click toggles;
 * the choice persists across restarts (FIX 4). */
export type PillStyle = 'A' | 'B';

const PILL_STYLE_FILE = (): string => join(app.getPath('userData'), 'pill-style.json');

/** C2g FIX 4 — persisted pill style. Deliberately a main-side JSON file in userData, NOT
 * pill-layer localStorage: the layer runs sandboxed under attachPillLockdown and its file://
 * origin storage is not a contract we rely on; main-side disk state is readable synchronously
 * BEFORE the layer loads, so the boot renders the persisted style from the FIRST frame with no
 * style flash. Missing/corrupt file ⇒ default 'A' (first-boot contract). */
export function loadPillStyle(): PillStyle {
  try {
    const parsed = JSON.parse(readFileSync(PILL_STYLE_FILE(), 'utf8')) as { style?: string };
    return parsed.style === 'B' ? 'B' : 'A';
  } catch {
    return 'A';
  }
}

function savePillStyle(style: PillStyle): void {
  try {
    writeFileSync(PILL_STYLE_FILE(), JSON.stringify({ style }), 'utf8');
  } catch (err) {
    console.error('[pill] style persist failed:', err);
  }
}

export type PillMode = 'cloud' | 'local';

export interface CloudController {
  show(): void;
  hide(): void;
  isVisible(): boolean;
  /** C2d self-heal, generalized (FIX 1): re-assert the site view bounds (true full window
   * {0,0,w,h}) AND the pill overlay bounds (C2g: top-center) — idempotent, no focus steal. */
  syncBounds(): void;
  /** C2f FIX 2 — tell the pill layer which mode the app is actually in (knob slides only on
   * this). Queued until the pill layer finishes loading; safe to call at any time. */
  setPillMode(mode: PillMode): void;
  /** C2g FIX 3 — Style B bloom coupling (ZERO-MISS CLICK RULE): the pill layer reports
   * hover-enter/leave; main resizes the overlay view to the bloomed (112 × 28) or rest
   * (28 × 28) footprint RE-CENTERED, in the same tick the CSS transition starts. Idempotent;
   * bloom requests while Style A is active are ignored. */
  setPillBloom(bloomed: boolean): void;
  /** C2g-hotfix-6 FIX 2 — Style A flip room: grow to 124 × 28 BEFORE the knob's flip transform
   * starts (the `pill:flip` relay calls this first). Contract-coupled hold then snaps back. */
  beginPillFlip(): void;
  /** C2g FIX 4 — right-click style toggle lands here: flip state, PERSIST to disk, re-assert
   * bounds for the new style's current footprint. */
  setPillStyle(style: PillStyle): void;
  /** C2g-hotfix-1 FIX 3 — reply to the layer's `pill:ready`: push the TRUE mode (same
   * `pill:setMode` channel; the boot queue stays as belt-and-braces) AND the true style. */
  resyncPill(mode: PillMode): void;
  /** C2g-hotfix-1 §5 — tail of the pill layer's own console (ring buffer, last 50 lines) so the
   * battery can prove no runtime errors during load/clicks. */
  pillConsoleTail(): string[];
  /** C2f FIX 1 — focus hygiene: give keyboard focus back after a pill click handled a flip. */
  blurPill(): void;
  /** Probe data for DROPSYNC_CLOUD_DEV: did-finish-load latency for the site origin, if loaded. */
  probeState(): { readyMs: number | null; url: string | null };
  /** f_c1_isolationGuard — evaluate INSIDE the cloud contents (I1: no bridge may exist), now
   * ALSO covering the pill layer (its bridge must be `dropsyncPill`, never `dropsync`) and,
   * C2j, the card layer (`dropsyncCard` exists ONLY on the card page — never site, never pill). */
  probeIsolation(): Promise<{
    dropsyncType: string;
    hasPreloadKey: true;
    pillDropsyncType: string;
    pillBridgeType: string;
    pillCardBridgeType: string;
    cardDropsyncType: string;
    cardBridgeType: string;
  }>;
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
  /** C2f FIX 5 — pill-layer evidence for f_c2f_pillPersistent: corner bounds, visibility,
   * load state, and the pill page's own computed transparency (background-color alpha).
   * C2g: `expected` is now style/bloom-aware (centered), and `style`/`blooming` report the
   * main-side truth for the f_c2g_* keys. */
  pillProbe(): Promise<{
    bounds: Electron.Rectangle;
    expected: Electron.Rectangle;
    visible: boolean;
    loaded: boolean;
    bodyBackgroundColor: string;
    style: PillStyle;
    blooming: boolean;
  }>;
  /** C2g FIX 5 — drive the REAL pill layer's DOM listeners headlessly (battery only, env-gated):
   * dispatches synthetic mouseenter/mouseleave/contextmenu through the layer so the bloom and
   * style-toggle paths run exactly as a user's would. Throws when DROPSYNC_CLOUD_DEV ≠ 1. */
  pillDrive(event: 'mouseenter' | 'mouseleave' | 'contextmenu'): Promise<void>;
  /** C2g FIX 4/5 — evaluate JS inside the PILL layer (battery-only, env-gated): read computed
   * colors / the __c2gPill fixture. Throws when DROPSYNC_CLOUD_DEV ≠ 1. */
  pillEval<T = unknown>(expr: string): Promise<T>;
  /** C2g FIX 4 — relaunch JUST the pill layer from disk state (persistence proof without an
   * app restart): re-navigates to pillPageUrl(loadPillStyle()) so the boot path — file → query
   * param → first frame — runs end-to-end. Battery-only, env-gated. */
  reloadPillLayer(): Promise<void>;
  /** C2f FIX 5 — site-view evidence for f_c2f_boundsFull: current bounds + visibility. */
  siteProbe(): Promise<{ bounds: Electron.Rectangle; visible: boolean }>;
  /** C2h FIX 6 — battery-only (env-gated): deliver an INERT wheel gesture through the REAL
   * input pipeline of the site view — the exact channel the C2h `input-event` activity
   * listener senses. Wheel ONLY: a synthetic click could navigate the real deployed page.
   * Throws when DROPSYNC_CLOUD_DEV ≠ 1. */
  siteDriveWheel(x: number, y: number, deltaY: number): Promise<boolean>;
  /** C2f FIX 5 — z-order truth: the pill must be the LAST contentView child (paints on top). */
  pillIsTopChild(): boolean;
  /** C2j — reminder overlay LEG 2: show a card over whichever world is on screen. ALWAYS-on
   * delivery beside the native toast; the card queue displays ONE card at a time, serially.
   * C2k — theme?: unknown is normalized against the whitelist ('light'|'dark'|'minimal',
   * fallback 'light') and stamped on the item at push time. */
  reminderShow(title: string, body: string, theme?: unknown): void;
  /** C2j LEG 3 — missed queue: a reminder that fired while the app wasn't front-and-center.
   * Caps at MAX_MISSED; overflow drops the OLDEST and its count rides the next drained card. */
  enqueueMissed(title: string, body: string): void;
  /** C2j LEG 3 — drain the missed queue OLDEST-FIRST into the overlay (OVERLAY ONLY — these
   * were already natively shown once at fire time). Spacing comes from the serial card pump.
   * C2k — theme?: unknown dresses each drained card at FLUSH time (flush-moment theme). */
  drainMissed(theme?: unknown): void;
  /** C2j — a card click landed: dismiss the clicked card and focus/restore the window
   * (mirrors the native toast's click behavior). */
  reminderClick(id: string): void;
  /** C2j — card-layer evidence for f_c2j_cardOverBothWorlds: load/visibility, live bounds vs
   * expected (showing ⇒ card rect, idle ⇒ collapsed 0×0), queue state, delivered counter,
   * missed-queue state, the painted page's own card-node truth, and z-order (pillIsTopChild). */
  cardProbe(): Promise<{
    loaded: boolean;
    visible: boolean;
    showing: boolean;
    bounds: Electron.Rectangle;
    expected: Electron.Rectangle;
    queueLen: number;
    nextQueueTitle: string | null;
    currentTitle: string | null;
    delivered: number;
    missedLen: number;
    missedDropped: number;
    pageCardVisible: boolean | 'no-view';
    /** C2k — the live data-card-theme attribute on the card page ('no-view' when no view). */
    pageTheme: string;
    /** C2k — painted computed truth off the live nodes: bar background, card radius/edge. */
    painted: { barBg: string; cardRadius: string; cardBorderWidth: string } | null;
    pillIsTop: boolean;
  }>;
  /** C2j — battery-only hermetic purge of ALL card/missed state (env-gated like pillDrive):
   * queues, timers, the live card. The missed-queue unit leg uses it to stay deterministic. */
  cardTestReset(): Promise<void>;
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

/** C2f FIX 1 — security lockdown for the PILL layer (a second, tiny webContents): local file
 * only, no navigation ever, no window.open, no permission requests granted. Any violation is
 * logged loudly — this layer must stay a dumb button. */
function attachPillLockdown(wc: Electron.WebContents): void {
  wc.on('will-navigate', (e) => {
    e.preventDefault();
    console.log('[pill] nav-denied (pill layer never navigates)');
  });
  wc.setWindowOpenHandler(({ url }) => {
    console.log('[pill] window-open-denied', url.slice(0, 120));
    return { action: 'deny' };
  });
  wc.session.setPermissionRequestHandler((_wc, permission, callback) => {
    console.log('[pill] permission-denied', permission);
    callback(false);
  });
}

/** C2f — where the pill page lives: the dev server in dev (electron-vite serves the renderer
 * over http; there is no out/ tree), the built multi-page output in production.
 * C2g FIX 4 — the PERSISTED style rides the query string so the page renders it from the very
 * first frame (no style flash). `&e2e=1` arms the __c2gPill fixture, only under DROPSYNC_CLOUD_DEV. */
function pillPageUrl(style: PillStyle): string {
  const devRoot = process.env.ELECTRON_RENDERER_URL;
  const suffix = `?style=${style}${process.env.DROPSYNC_CLOUD_DEV === '1' ? '&e2e=1' : ''}`;
  if (devRoot) return `${devRoot}/pill/pill.html${suffix}`;
  return 'file://' + join(fileURLToPath(new URL('.', import.meta.url)), '../renderer/pill/pill.html') + suffix;
}

/** C2j — where the CARD page lives (cloned from pillPageUrl): dev server in dev, built
 * multi-page output in production. No query params — the card carries no persisted state. */
function cardPageUrl(): string {
  const devRoot = process.env.ELECTRON_RENDERER_URL;
  if (devRoot) return `${devRoot}/card/card.html`;
  return 'file://' + join(fileURLToPath(new URL('.', import.meta.url)), '../renderer/card/card.html');
}

export function initCloud(mainWindow: BrowserWindow, opts?: { onUserActivity?: () => void }): CloudController {
  // C2h FIX 2/3 — main-provided activity feed: gestures sensed on the cloud view call this
  // (wired in index.ts to manager.touch()), so Cloud input feeds the SAME idle clock as Local.
  const { onUserActivity } = opts ?? {};
  let view: WebContentsView | null = null;
  let shown = false;
  let readyMs: number | null = null;
  let loadStartedAt = 0;
  // The pill layer is created EAGERLY at boot (owner: "visible from the first frame") and is
  // NEVER removed in normal operation — it survives mode switches, Local mode, everything.
  let pillView: WebContentsView | null = null;
  let pillLoaded = false;
  let pillModeQueued: PillMode | null = null; // setPillMode before the pill page finished loading
  // C2g — style + bloom state live in MAIN (single source of truth): bounds math, persistence
  // and the battery probes all read these; the pill layer mirrors them via IPC.
  let pillStyle: PillStyle = loadPillStyle();
  let pillBlooming = false;
  // C2g-hotfix-5 FIX 2 — armed while the collapse room must WAIT for the CSS shrink to finish.
  let pillCollapseHold: ReturnType<typeof setTimeout> | null = null;
  // C2g-hotfix-6 FIX 2 — mirror pair for Style A's flip room (knob overshoot breathing space).
  let pillFlipPending = false;
  let pillFlipHold: ReturnType<typeof setTimeout> | null = null;
  const pillConsole: string[] = []; // C2g-hotfix-1 §5 — layer console ring buffer

  /** Shared load-finished path for boot AND battery-driven layer relaunches (C2g FIX 4). */
  const onPillLoadFinished = (): void => {
    pillLoaded = true;
    console.log('[pill] layer loaded');
    // Boot: main sent the initial mode before the page was ready — deliver it now.
    if (pillModeQueued) {
      const m = pillModeQueued;
      pillModeQueued = null;
      pillView?.webContents.send('pill:setMode', m);
    }
  };

  /** C2d self-heal, generalized (FIX 1): the site view is TRUE FULL WINDOW {0,0,w,h}; the pill
   * is glued TOP-CENTER (C2g), style/bloom-aware in width. Pure functions of the window. */
  const siteBounds = (): Electron.Rectangle => {
    const b = mainWindow.getContentBounds();
    return { x: 0, y: 0, width: b.width, height: b.height };
  };
  const pillWidth = (): number => (pillStyle === 'A' || pillBlooming ? PILL_W : PILL_B_REST_W);
  /** C2g-hotfix-4 FIX 2 — the native ROOM for the current style/bloom state. Style A: exactly
   * the 112 × 28 pill. B at rest: exactly the 28 × 28 footprint (zero-miss rule untouched).
   * B bloomed: pill + symmetric skirt (`PILL_BLOOM_PAD_*`) so the elastic overshoot and the
   * shadow halo paint INSIDE the page instead of against a clipping wall. Room-center arithmetic
   * that makes this safe for the center-anchored page (#pillB uses left/top 50% + translate):
   * rest center y = 10+14 = 24; bloomed room center y = (10−8)+22 = 24 ✓; x is centered in both
   * ✓ ⇒ the painted circle NEVER moves when the room swaps. syncBounds, the watchdog and every
   * resize/fullscreen handler read bounds through here, so they all inherit the room. */
  const pillBounds = (): Electron.Rectangle => {
    const b = mainWindow.getContentBounds();
    // C2g-hotfix-6 FIX 2 — Style A FLIP room: only while the knob's elastic transform is
    // animating or on hold. Rest stays exactly 112 × 28 centered (zero-miss sacred).
    if (pillStyle === 'A' && (pillFlipPending || pillFlipHold !== null)) {
      const w = PILL_W + PILL_A_FLIP_PAD_X * 2; // 124
      return { x: Math.round((b.width - w) / 2), y: PILL_TOP, width: w, height: PILL_H };
    }
    if (pillStyle === 'B' && (pillBlooming || pillCollapseHold !== null)) {
      const w = PILL_W + PILL_BLOOM_PAD_X * 2; // 132
      const h = PILL_H + PILL_BLOOM_PAD_Y * 2; // 44
      return { x: Math.round((b.width - w) / 2), y: PILL_TOP - PILL_BLOOM_PAD_Y, width: w, height: h };
    }
    const w = pillWidth();
    return { x: Math.round((b.width - w) / 2), y: PILL_TOP, width: w, height: PILL_H };
  };

  /** Idempotent bounds assertion: writes (and logs) ONLY on real drift, so the resize handlers,
   * the deferred re-apply and the 1 s watchdog can all call it freely — no spam, no focus steal. */
  const syncBounds = (): void => {
    if (mainWindow.isDestroyed()) return;
    if (view && shown) {
      const expected = siteBounds();
      const cur = view.getBounds();
      if (cur.x !== expected.x || cur.y !== expected.y || cur.width !== expected.width || cur.height !== expected.height) {
        view.setBounds(expected);
        console.log('[cloud] bounds set', JSON.stringify({ from: cur, to: expected }));
      }
    }
    if (pillView) {
      const expected = pillBounds();
      const cur = pillView.getBounds();
      if (cur.x !== expected.x || cur.y !== expected.y || cur.width !== expected.width || cur.height !== expected.height) {
        pillView.setBounds(expected);
        console.log('[pill] bounds set', JSON.stringify({ from: cur, to: expected }));
      }
    }
    // C2j — the card layer joins the self-heal: card rect while a card shows, collapsed 0×0
    // while idle (zero-footprint discipline). Idempotent; logs only on real drift.
    if (cardView) {
      const expected = cardShowing ? cardBounds() : cardCollapsedBounds();
      const cur = cardView.getBounds();
      if (cur.x !== expected.x || cur.y !== expected.y || cur.width !== expected.width || cur.height !== expected.height) {
        cardView.setBounds(expected);
        console.log('[card] bounds set', JSON.stringify({ from: cur, to: expected }));
      }
    }
  };

  /** Z-ORDER DISCIPLINE (the floating trick): contentView children paint in add-order, so the
   * pill must be the LAST child whenever the site view is (re-)added. Re-adding = remove+add. */
  const raisePill = (): void => {
    if (!pillView || mainWindow.isDestroyed()) return;
    mainWindow.contentView.removeChildView(pillView);
    mainWindow.contentView.addChildView(pillView);
  };

  const ensurePill = (): WebContentsView => {
    if (pillView) return pillView;
    pillView = new WebContentsView({
      webPreferences: {
        preload: join(fileURLToPath(new URL('.', import.meta.url)), '../preload/pillPreload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // Transparency is the whole trick — spike-proven under WSLg (STEP 0.5, 2026-08-26).
    pillView.setBackgroundColor('#00000000');
    attachPillLockdown(pillView.webContents);
    // C2g-hotfix-1 §5 — capture the layer's own console (ring buffer) so the battery can prove
    // a clean load/click session instead of asserting silence by assumption.
    pillView.webContents.on('console-message', (_e, _level, message) => {
      pillConsole.push(`${new Date().toISOString()} ${message}`);
      if (pillConsole.length > 50) pillConsole.shift();
    });
    pillView.webContents.once('did-finish-load', () => {
      onPillLoadFinished();
    });
    void pillView.webContents.loadURL(pillPageUrl(pillStyle));
    pillView.setBounds(pillBounds());
    mainWindow.contentView.addChildView(pillView); // first (and only) child at boot
    return pillView;
  };

  const setPillMode = (mode: PillMode): void => {
    if (!pillView) ensurePill();
    if (!pillLoaded) {
      pillModeQueued = mode; // delivered on did-finish-load
      return;
    }
    pillView?.webContents.send('pill:setMode', mode);
    // C2g-hotfix-6 — every DELIVERED mode can start the knob's elastic slide (boot-time slide
    // included), so arm the flip room here too. A same-mode push runs no transition and a
    // re-arm is harmless (620 ms later, syncBounds finds no drift). Early-returns inside
    // beginPillFlip for non-A styles.
    beginPillFlip();
  };

  // C2g-hotfix-6 FIX 2 — Style A flip room: called from the `pill:flip` relay BEFORE the
  // renderer even starts its guarded switch (room big before the knob's class lands) and from
  // setPillMode's delivery path. Re-flips re-arm idempotently (a rapid storm holds the room;
  // ONE snap PILL_A_FLIP_ROOM_HOLD_MS after the last flip, onto the settled pixel-identical
  // pill). Style B is unaffected: its bloom/collapse room logic owns bounds while style B.
  const beginPillFlip = (): void => {
    if (!pillView || pillStyle !== 'A') return;
    pillFlipPending = true;
    if (pillFlipHold !== null) clearTimeout(pillFlipHold);
    pillFlipHold = setTimeout(() => {
      pillFlipHold = null;
      pillFlipPending = false; // room returns to the exact rest footprint
      syncBounds();
    }, PILL_A_FLIP_ROOM_HOLD_MS);
    syncBounds(); // grow NOW (before the knob's class lands)
  };

  // C2g FIX 3 — bloom coupling. Idempotent + validated: Style A never blooms, and a request for
  // the state we're already in is a no-op (rapid hover storms collapse to nothing). The bounds
  // re-assert runs in the SAME tick the layer starts its CSS transition (the layer adds its
  // class before sending this IPC), so bloom/collapse looks seamless.
  const setPillBloom = (bloomed: boolean): void => {
    if (!pillView || pillStyle !== 'B') return; // A has no bloom; nothing to resize
    if (bloomed) {
      // C2g-hotfix-5 — re-hover DURING a collapse hold: the room must never shrink under a
      // returning cursor. Cancel the hold, then grow exactly like a fresh bloom.
      if (pillCollapseHold !== null) { clearTimeout(pillCollapseHold); pillCollapseHold = null; }
      if (!pillBlooming) {
        pillBlooming = true;
        syncBounds();
      }
      return;
    }
    // C2g-hotfix-5 FIX 2 — collapse request: the pill's LOGICAL state collapses immediately
    // (dots return, knob state correct), but the ROOM HOLDS at 132 × 44 for
    // PILL_COLLAPSE_ROOM_HOLD_MS while the CSS shrink plays outside every clipping wall; the
    // delayed syncBounds() then snaps to the tight 28 × 28 rest room onto an already-28-wide,
    // centered pill — an invisible change. Idempotence: a second bloom(false) while already
    // collapsing on hold does not push the deadline out.
    if (!pillBlooming && pillCollapseHold === null) return;
    pillBlooming = false;
    if (pillCollapseHold !== null) clearTimeout(pillCollapseHold);
    pillCollapseHold = setTimeout(() => {
      pillCollapseHold = null;
      syncBounds();
    }, PILL_COLLAPSE_ROOM_HOLD_MS);
  };

  // C2g FIX 4 — right-click toggle: flip, PERSIST, re-assert bounds for the new footprint.
  const setPillStyle = (style: PillStyle): void => {
    if (style !== 'A' && style !== 'B') return;
    if (pillStyle === style) return;
    pillStyle = style;
    if (style === 'A') pillBlooming = false; // A's footprint is always the full pill
    // C2g-hotfix-5/6 — a right-click mid-collapse or mid-flip must leave NO stale room-hold
    // timer behind (the new style's footprint is asserted right below).
    if (pillCollapseHold !== null) { clearTimeout(pillCollapseHold); pillCollapseHold = null; }
    if (pillFlipHold !== null) { clearTimeout(pillFlipHold); pillFlipHold = null; }
    pillFlipPending = false;
    savePillStyle(style);
    console.log('[pill] style persisted:', style);
    syncBounds();
  };

  // C2g-hotfix-1 FIX 3 — the `pill:ready` reply: TRUE mode now (the queue below already covers
  // the not-yet-loaded case — belt-and-braces kept), TRUE style unconditionally (the layer's
  // applyStyle is idempotent; a same-style push is a no-op there).
  const resyncPill = (mode: PillMode): void => {
    setPillMode(mode);
    if (pillView && pillLoaded) pillView.webContents.send('pill:styleChanged', pillStyle);
  };

  const blurPill = (): void => {
    // WebContents has no blur(); handing focus back to the window's own contents is the
    // equivalent move — keyboard returns to wherever the user was (site view or Local DOM).
    try {
      if (!mainWindow.isDestroyed()) mainWindow.webContents.focus();
    } catch { /* window gone — nothing to hand focus back to */ }
  };

  // ==== C2j — the reminder CARD layer (LEG 2) ===============================================
  // Third trusted local view — the pill's boot recipe mirrored exactly: EAGER creation at init
  // (never removed in normal operation), transparent background, sandboxed local page with the
  // same lockdown, DIP bounds math from getContentBounds, idempotent watchdog discipline.
  let cardView: WebContentsView | null = null;
  let cardLoaded = false;
  /** C2k — the card wears the app's CURRENT theme at DISPLAY time (owner pick Row B ink bar:
   * dark⇒white bar, light/minimal⇒ink bar). Whitelist mirrors the vault settings validation
   * (vaultTypes.ts VaultSettings.theme / setSettings) — unknown/missing ⇒ 'light'. */
  type CardTheme = 'light' | 'dark' | 'minimal';
  const normTheme = (v: unknown): CardTheme =>
    v === 'dark' || v === 'light' || v === 'minimal' ? v : 'light';
  // theme rides on every DISPLAYED card — stamped by reminderShow at push time; missed items
  // stay theme-less BY DESIGN (they were natively shown once already) and are dressed when
  // FLUSHED by drainMissed, hence optional here.
  interface CardItem { id: string; title: string; body: string; theme?: CardTheme }
  const cardQueue: CardItem[] = []; // display queue — ONE card visible at a time (serial pump)
  let cardShowing = false;
  let cardCurrentId: string | null = null;
  let cardCurrentTitle: string | null = null; // probe evidence: which card is on screen now
  let cardSeq = 0;
  let cardDelivered = 0; // cards that BEGAN displaying (battery proof of full delivery)
  let cardDismissTimer: ReturnType<typeof setTimeout> | null = null;
  // The hide-transition hold: the page plays its ~180 ms fade/scale while the native footprint
  // still holds, THEN collapses to 0×0 and waits NEXT_GAP_MS before the next card.
  let cardCollapseTimer: ReturnType<typeof setTimeout> | null = null;
  // LEG 3 — missed-reminder queue (oldest-first = enqueue order). Overflow drops the OLDEST;
  // its running count rides the NEXT drained card as a single "+N older" body prefix.
  const missedQueue: CardItem[] = [];
  let missedDropped = 0;

  /** Top-right anchor, DIP math like pillBounds(): x = contentW − CARD_W − CARD_RIGHT. */
  const cardBounds = (): Electron.Rectangle => {
    const b = mainWindow.getContentBounds();
    return { x: Math.round(b.width - CARD_W - CARD_RIGHT), y: CARD_TOP, width: CARD_W, height: CARD_H };
  };
  /** Zero-footprint rest state: 0×0 at the same anchor corner (pill zero-miss discipline). */
  const cardCollapsedBounds = (): Electron.Rectangle => {
    const b = mainWindow.getContentBounds();
    return { x: Math.round(b.width - CARD_W - CARD_RIGHT), y: CARD_TOP, width: 0, height: 0 };
  };

  const onCardLoadFinished = (): void => {
    cardLoaded = true;
    console.log('[card] layer loaded');
    pumpCard(); // a fire that arrived before the page was ready displays now
  };

  const ensureCard = (): WebContentsView => {
    if (cardView) return cardView;
    cardView = new WebContentsView({
      webPreferences: {
        preload: join(fileURLToPath(new URL('.', import.meta.url)), '../preload/cardPreload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    cardView.setBackgroundColor('#00000000'); // WSLg-transparency-safe (pill precedent, STEP 0.5)
    attachPillLockdown(cardView.webContents); // same trusted-layer lockdown: no nav, no popups
    cardView.webContents.once('did-finish-load', () => onCardLoadFinished());
    void cardView.webContents.loadURL(cardPageUrl());
    cardView.setBounds(cardCollapsedBounds()); // COLLAPSED until a card actually shows
    // Added BEFORE the pill at boot ⇒ the z-order law (site < card < pill) holds from frame one.
    mainWindow.contentView.addChildView(cardView);
    return cardView;
  };

  /** Z-ORDER LAW (C2j): site view < cardView < pillView ALWAYS. Callers re-stack the card above
   * the site BEFORE the pill is re-raised (children paint in add-order — pill precedent). */
  const raiseCard = (): void => {
    if (!cardView || mainWindow.isDestroyed()) return;
    mainWindow.contentView.removeChildView(cardView);
    mainWindow.contentView.addChildView(cardView);
  };

  /** Z-order truth shared by the controller accessor and cardProbe: the pill must be the LAST
   * contentView child (paints on top) — even mid-card-display. */
  const isPillTopChild = (): boolean => {
    if (!pillView) return false;
    const kids = mainWindow.contentView.children;
    return kids.length > 0 && kids[kids.length - 1] === pillView;
  };

  /** Dismissal — race-safe under rapid fire: only the CURRENT card's auto-timer or its own
   * click may dismiss (stale calls no-op). Click = dismiss = advance, so a click storm can
   * never block the queue. The page's hide transition plays inside a 200 ms hold, then the
   * footprint collapses to 0×0 (idempotent syncBounds) and the pump waits NEXT_GAP_MS. */
  const dismissCard = (id: string): void => {
    if (!cardShowing || cardCurrentId !== id) return;
    if (cardDismissTimer !== null) { clearTimeout(cardDismissTimer); cardDismissTimer = null; }
    cardShowing = false;
    cardCurrentId = null;
    cardCurrentTitle = null;
    cardView?.webContents.send('card:hide');
    if (cardCollapseTimer !== null) clearTimeout(cardCollapseTimer);
    cardCollapseTimer = setTimeout(() => {
      syncBounds(); // snap to the collapsed 0×0 footprint
      cardCollapseTimer = setTimeout(pumpCard, NEXT_GAP_MS); // polite gap to the next card
    }, 200);
  };

  /** Serial display pump: ONE card at a time. If the page hasn't finished loading, the item
   * stays queued and the pump retries from onCardLoadFinished. */
  const pumpCard = (): void => {
    if (cardShowing || cardQueue.length === 0) return;
    if (!cardView) ensureCard();
    if (!cardLoaded) return;
    const item = cardQueue.shift()!;
    cardCurrentId = item.id;
    cardCurrentTitle = item.title;
    cardShowing = true;
    cardDelivered += 1;
    cardView!.setBounds(cardBounds()); // footprint EXACTLY the card while it shows (zero-miss)
    cardView!.webContents.send('card:show', { id: item.id, title: item.title, body: item.body, theme: item.theme });
    cardDismissTimer = setTimeout(() => dismissCard(item.id), AUTO_DISMISS_MS);
  };

  /** LEG 2 — overlay delivery. Works over whichever world is on screen (the view floats above
   * both); multi-card storms serialize through the pump with NEXT_GAP_MS between cards.
   * C2k — the item is stamped with the theme at PUSH time (display-time theme: the caller
   * reads the app's current theme the moment the reminder fires). */
  const reminderShow = (title: string, body: string, theme?: unknown): void => {
    cardQueue.push({ id: `card-${Date.now()}-${cardSeq++}`, title, body, theme: normTheme(theme) });
    pumpCard();
  };

  // LEG 3 — cap/overflow: at MAX_MISSED the OLDEST is dropped and counted. Pure data structure;
  // display happens only via drainMissed (overlay only, no native re-show).
  const enqueueMissed = (title: string, body: string): void => {
    if (missedQueue.length >= MAX_MISSED) { missedQueue.shift(); missedDropped += 1; }
    missedQueue.push({ id: `missed-${Date.now()}-${cardSeq++}`, title, body });
  };
  /** LEG 3 — drain on window focus: oldest-first, OVERLAY ONLY (these were natively shown once
   * at fire time), ≥NEXT_GAP_MS spacing guaranteed by the serial pump. The first flushed card
   * carries the "+N older" prefix if overflow ever dropped anything. C2k — every drained item
   * is dressed at FLUSH time (flush-moment theme — the overlay outfit is chosen when the card
   * is actually displayed, not when it was queued). */
  const drainMissed = (theme?: unknown): void => {
    const flushTheme = normTheme(theme);
    let first = true;
    while (missedQueue.length > 0) {
      const m = missedQueue.shift()!;
      if (first && missedDropped > 0) {
        reminderShow(m.title, `+${missedDropped} older — ${m.body}`, flushTheme);
        missedDropped = 0;
      } else {
        reminderShow(m.title, m.body, flushTheme);
      }
      first = false;
    }
  };

  /** Card click: dismiss the clicked card (= advance) and focus/restore the window, mirroring
   * LEG 1's native-toast click block. */
  const reminderClick = (id: string): void => {
    if (cardShowing && cardCurrentId === id) dismissCard(id);
    try {
      if (mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } catch { /* window gone */ }
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
    // C2h FIX 2 — cloud gestures feed the SAME idle-auto-lock clock as Local actions (owner
    // decision D-B). We sense INPUTS from OUTSIDE the page (main-process listener; this is NOT
    // site injection — we never execute/read anything in the site, invariant I6/I1). Buttons,
    // keys and wheel count; mouseMove/mouseEnter/mouseLeave do NOT — mirroring Local, where
    // pure hovering fires no IPC and never refreshed the idle clock either. Auth POPUP
    // windows deliberately do NOT feed the clock (separate webContents; brief sign-in moments).
    let lastFeed = 0;
    view.webContents.on('input-event', (_event, input) => {
      if (input.type === 'mouseMove' || input.type === 'mouseEnter' || input.type === 'mouseLeave') return;
      const now = Date.now();
      if (now - lastFeed < ACTIVITY_FEED_MIN_GAP_MS) return;
      lastFeed = now;
      onUserActivity?.();
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
      raiseCard(); // the site view was just stacked ON TOP of the card too — undo (C2j z-law)
      raisePill(); // the site view was just stacked ON TOP of the pill — undo that, always
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
    // The pill is NEVER removed (C2f contract) — it keeps floating over Local too.
    if (mainWindow.isFocused()) mainWindow.webContents.focus();
  };

  // Bounds watchdog (C2d pattern, generalized): ONE 1 s tick re-asserts BOTH targets — the site
  // view while shown AND the pill ALWAYS — so even if WSLg swallows every geometry event, both
  // are correct within a second. Idempotent + guarded; logs only on real drift.
  const boundsWatchdog = setInterval(() => {
    if (mainWindow.isDestroyed()) return;
    syncBounds();
  }, 1000);
  mainWindow.once('closed', () => clearInterval(boundsWatchdog));

  const controller: CloudController = {
    show,
    hide,
    isVisible: () => shown,
    syncBounds,
    setPillMode,
    setPillBloom,
    beginPillFlip,
    setPillStyle,
    resyncPill,
    pillConsoleTail: () => [...pillConsole],
    blurPill,
    probeState: () => ({ readyMs, url: view ? CLOUD_URL : null }),
    probeIsolation: async () => {
      if (!view || !pillView || !cardView) {
        return { dropsyncType: 'no-view', hasPreloadKey: true as const, pillDropsyncType: 'no-view', pillBridgeType: 'no-view', pillCardBridgeType: 'no-view', cardDropsyncType: 'no-view', cardBridgeType: 'no-view' };
      }
      const dropsyncType = await view.webContents.executeJavaScript('typeof window.dropsync');
      // The pill layer must have ITS bridge and NEVER the main app's.
      const pillDropsyncType = await pillView.webContents.executeJavaScript('typeof window.dropsync');
      const pillBridgeType = await pillView.webContents.executeJavaScript('typeof window.dropsyncPill');
      // C2j — the card bridge exists ONLY on the card page (never site, never pill).
      const pillCardBridgeType = await pillView.webContents.executeJavaScript('typeof window.dropsyncCard');
      const cardDropsyncType = await cardView.webContents.executeJavaScript('typeof window.dropsync');
      const cardBridgeType = await cardView.webContents.executeJavaScript('typeof window.dropsyncCard');
      return { dropsyncType, hasPreloadKey: true as const, pillDropsyncType, pillBridgeType, pillCardBridgeType, cardDropsyncType, cardBridgeType };
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
    pillProbe: async () => {
      const expected = pillBounds();
      if (!pillView) return { bounds: { x: 0, y: 0, width: 0, height: 0 }, expected, visible: false, loaded: false, bodyBackgroundColor: 'no-view', style: pillStyle, blooming: pillBlooming };
      const bodyBackgroundColor = (await pillView.webContents.executeJavaScript(
        'getComputedStyle(document.body).backgroundColor'
      )) as string;
      return {
        bounds: pillView.getBounds(),
        expected,
        visible: mainWindow.contentView.children.includes(pillView),
        loaded: pillLoaded,
        bodyBackgroundColor,
        style: pillStyle,
        blooming: pillBlooming,
      };
    },
    // C2g FIX 5 — battery-only layer access (I6: env-gated like every other probe).
    pillDrive: async (event) => {
      if (process.env.DROPSYNC_CLOUD_DEV !== '1') throw new Error('pillDrive is DROPSYNC_CLOUD_DEV-only');
      if (!pillView) throw new Error('pill layer missing');
      // Dispatch through the REAL DOM listeners in the REAL layer (no state is poked).
      await pillView.webContents.executeJavaScript(
        `(function(){ var r = document.getElementById('root'); if (!r) return false;
           r.dispatchEvent(new Event(${JSON.stringify(event)})); return true; })()`
      );
    },
    pillEval: async <T>(expr: string): Promise<T> => {
      if (process.env.DROPSYNC_CLOUD_DEV !== '1') throw new Error('pillEval is DROPSYNC_CLOUD_DEV-only');
      if (!pillView) throw new Error('pill layer missing');
      return (await pillView.webContents.executeJavaScript(expr)) as T;
    },
    // C2h FIX 6 — battery-only site gesture driver (I6: no script enters the page; this only
    // synthesizes a raw input event through Electron's own pipeline, which the C2h activity
    // listener then observes from OUTSIDE the page).
    siteDriveWheel: async (x, y, deltaY) => {
      if (process.env.DROPSYNC_CLOUD_DEV !== '1') throw new Error('siteDriveWheel is DROPSYNC_CLOUD_DEV-only');
      if (!view) throw new Error('site view missing');
      view.webContents.sendInputEvent({ type: 'mouseWheel', x, y, deltaY });
      return true;
    },
    reloadPillLayer: async () => {
      if (process.env.DROPSYNC_CLOUD_DEV !== '1') throw new Error('reloadPillLayer is DROPSYNC_CLOUD_DEV-only');
      if (!pillView) throw new Error('pill layer missing');
      // Full re-navigation (NOT .reload()): the query string must be rebuilt from DISK so this
      // proves the real boot path — file → loadPillStyle → URL param → first frame.
      // C2g-hotfix-1: MAIN's memory re-syncs from disk too — otherwise the pill:ready handshake
      // would push a stale in-memory style over the layer's disk-derived boot (the exact
      // divergence the cleared-store leg exercises).
      pillStyle = loadPillStyle();
      pillBlooming = false; // a fresh layer always boots at rest
      // C2g-hotfix-5/6 — battery relaunch must boot with no stale room-hold timers.
      if (pillCollapseHold !== null) { clearTimeout(pillCollapseHold); pillCollapseHold = null; }
      if (pillFlipHold !== null) { clearTimeout(pillFlipHold); pillFlipHold = null; }
      pillFlipPending = false;
      syncBounds();
      pillLoaded = false;
      await pillView.webContents.loadURL(pillPageUrl(loadPillStyle()));
      onPillLoadFinished();
    },
    siteProbe: async () => {
      if (!view) return { bounds: { x: 0, y: 0, width: 0, height: 0 }, visible: false };
      return { bounds: view.getBounds(), visible: shown };
    },
    pillIsTopChild: isPillTopChild,
    reminderShow,
    enqueueMissed,
    drainMissed,
    reminderClick,
    cardProbe: async () => {
      const expected = cardShowing ? cardBounds() : cardCollapsedBounds();
      if (!cardView) {
        return { loaded: false, visible: false, showing: cardShowing, bounds: { x: 0, y: 0, width: 0, height: 0 }, expected, queueLen: cardQueue.length, nextQueueTitle: cardQueue[0]?.title ?? null, currentTitle: cardCurrentTitle, delivered: cardDelivered, missedLen: missedQueue.length, missedDropped, pageCardVisible: 'no-view' as const, pageTheme: 'no-view' as const, painted: null, pillIsTop: isPillTopChild() };
      }
      // C2k — ONE round-trip: the old pageCardVisible truth PLUS the theme attr and the
      // painted computed values the f_c2j_cardFollowsTheme leg asserts on.
      const pageState = (await cardView.webContents.executeJavaScript(
        `(function(){
           var c = document.getElementById('card');
           var b = document.getElementById('bar');
           var cs = c ? getComputedStyle(c) : null;
           return {
             visible: !!c && c.classList.contains('show'),
             theme: document.documentElement.dataset.cardTheme || '',
             barBg: b ? getComputedStyle(b).backgroundColor : '',
             cardRadius: cs ? cs.borderRadius : '',
             cardBorderWidth: cs ? cs.borderTopWidth : ''
           };
         })()`
      )) as { visible: boolean; theme: string; barBg: string; cardRadius: string; cardBorderWidth: string };
      return {
        loaded: cardLoaded,
        visible: mainWindow.contentView.children.includes(cardView),
        showing: cardShowing,
        bounds: cardView.getBounds(),
        expected,
        queueLen: cardQueue.length,
        nextQueueTitle: cardQueue[0]?.title ?? null,
        currentTitle: cardCurrentTitle,
        delivered: cardDelivered,
        missedLen: missedQueue.length,
        missedDropped,
        pageCardVisible: pageState.visible,
        pageTheme: pageState.theme,
        painted: { barBg: pageState.barBg, cardRadius: pageState.cardRadius, cardBorderWidth: pageState.cardBorderWidth },
        pillIsTop: isPillTopChild(),
      };
    },
    cardTestReset: async () => {
      if (process.env.DROPSYNC_CLOUD_DEV !== '1') throw new Error('cardTestReset is DROPSYNC_CLOUD_DEV-only');
      if (cardDismissTimer !== null) { clearTimeout(cardDismissTimer); cardDismissTimer = null; }
      if (cardCollapseTimer !== null) { clearTimeout(cardCollapseTimer); cardCollapseTimer = null; }
      cardQueue.length = 0;
      missedQueue.length = 0;
      missedDropped = 0;
      if (cardShowing) {
        cardShowing = false;
        cardCurrentId = null;
        cardCurrentTitle = null;
        cardView?.webContents.send('card:hide');
      }
      syncBounds(); // collapse the footprint immediately (no hide-hold in the hermetic reset)
    },
  };

  // Boot: the pill layer exists from the first frame; create it eagerly.
  // C2j — the card layer too (EAGER, never removed), created BEFORE the pill so the z-order
  // law (site < card < pill) holds from the very first frame.
  ensureCard();
  ensurePill();

  return controller;
}

// Registered by index.ts once per window: keeps BOTH layers glued across geometry changes —
// the site view at true full window AND the pill top-center (C2d pattern kept, generalized per
// C2f FIX 1 + C2g FIX 1; WSLg may deliver the final size late, hence the deferred re-apply).
export function attachCloudResizeTracking(
  mainWindow: BrowserWindow,
  controller: CloudController,
): void {
  const handler = (): void => {
    controller.syncBounds();
    setTimeout(() => controller.syncBounds(), 100);
    setTimeout(() => controller.syncBounds(), 400);
  };
  mainWindow.on('resize', handler);
  mainWindow.on('maximize', handler);
  mainWindow.on('unmaximize', handler);
  mainWindow.on('enter-full-screen', handler);
  mainWindow.on('leave-full-screen', handler);
  mainWindow.on('move', handler); // the pill is center-anchored in WINDOW coords — moves are
  // free, but the deferred re-assert costs nothing and proves the glue under any WM weirdness.
}
