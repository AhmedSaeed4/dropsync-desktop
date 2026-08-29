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

import { BrowserWindow, app, dialog, net, session, shell, WebContentsView } from 'electron';
import { join } from 'node:path';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/** C2m — THE FLIP DISSOLVE: the outgoing world melts away over the live new world. 250 ms was
 * picked by the owner from a live demo they could feel (desktop-docs/mode-flip-fade-preview.html).
 * The grace is the main-side settle deadline: `fader:done` from the page OR this timer,
 * whichever first — both paths idempotent (the fader can never stay inflated).
 * C2m-hotfix-1 (THE COVERED SWAP): beginMelt waits for the page's `fader:ready` (curtain
 * painted) at most THIS long; on deadline it resolves false ⇒ the flip proceeds instantly
 * (fail-open — a curtain that never paints never blocks a flip). */
export const FLIP_FADE_MS = 250;
export const FADER_DONE_GRACE_MS = 500;
export const MELT_READY_TIMEOUT_MS = 400;
/** C2m-hotfix-2 (PRESENTATION HEADROOM) — `fader:ready` fires on LAYOUT commit (the reflow),
 * not on PRESENTED pixels. Owner 2026-08-28: still flickered 7-8/10 — the curtain's first
 * painted frame raced the old world's removal across two independent rendering pipelines and
 * the removal usually won by 1-3 frames. This pad lets the curtain's first frames REACH THE
 * SCREEN before the world beneath changes: beginMelt resolves true only after the pad — 2-3
 * presented frames of headroom. Invisible by construction (the screen shows the outgoing
 * world under the identical curtain pixels); the melt starts ~50 ms later, still well inside
 * the pill knob's 600 ms swing. */
export const MELT_SWAP_PAD_MS = 50;

/** C3 STEP 5 (D7) — the snapshot deadline. Owner evidence 2026-08-29: flipping away from a
 * DEAD cloud page (never-loaded view) blocked the first few flips — capturePage() on the
 * never-painted view HANGS (try/catch catches rejections, not hangs), and the serialized
 * modeApplyChain queued every later flip behind the stalled capture. BOTH captures in
 * applyModeNow (site captureViewPng AND mainWindow capturePage) get THIS long to resolve;
 * a timeout ⇒ null ⇒ the existing instant-flip fail-open. A slow snapshot may NEVER hold
 * the flip chain hostage. beginMelt's own ready deadline (MELT_READY_TIMEOUT_MS) unchanged. */
export const CAPTURE_DEADLINE_MS = 350;

/** C3-hotfix-1 FIX B — the CONNECTING backstop. The veil keyed to did-fail-load alone leaves
 * a 5–6 s white window on WSL — Chromium takes that long to admit failure, and net.isOnline()
 * always reads true here (the net-flag backstop can't fire either). 3 s of silence on a FRESH
 * load ⇒ tell the owner something, honestly (a Connecting card — the net has NOT failed, the
 * page is just slow). Healthy entries (~1.5 s loads) never see it. */
export const ENTRY_CONNECT_TIMEOUT_MS = 3000;

/** C3 STEP 1 (D1) — the STATUS layer: compact chip anchored one comfortable row under the
 * pill band (pill rest bottom edge = PILL_TOP + PILL_H = 38, +12 gap ⇒ 50), height 36.
 * Owner picked the look live from c3-status-strip-preview.html (2026-08-29): ink-bar chip
 * (#1A1A1A, white text, gold accent, radius 999), centered horizontally; the offline veil
 * is a themed full-window page with a centered card. Width is MEASURED by the page
 * (status:measure) and clamped to ≤60% of the window — the zero-miss click rule: the
 * native room always EQUALS the visible footprint (idle = collapsed 0×0 + hidden). */
export const STATUS_TOP = PILL_TOP + PILL_H + 12; // 50
export const STATUS_H = 36;
/** D1/D2 — dwell constants: the ✓ flash chip lives ~1.4 s (main collapses the native room
 * just after the page's flash fades); a plain hide holds the room through the 280 ms
 * slide-up before collapsing (card dismiss-hold precedent). */
export const STATUS_FLASH_MS = 1400;
const STATUS_HIDE_HOLD_MS = 280;

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
   * ALSO covering the pill layer (its bridge must be `dropsyncPill`, never `dropsync`), and,
   * C2j, the card layer (`dropsyncCard` exists ONLY on the card page — never site, never pill)
   * and, C2m, the fader layer (`dropsyncFader` exists ONLY on the fader page — same pin). */
  probeIsolation(): Promise<{
    dropsyncType: string;
    hasPreloadKey: true;
    pillDropsyncType: string;
    pillBridgeType: string;
    pillCardBridgeType: string;
    cardDropsyncType: string;
    cardBridgeType: string;
    faderDropsyncType: string;
    faderBridgeType: string;
    faderCardBridgeType: string;
    pillFaderBridgeType: string;
    cardFaderBridgeType: string;
    statusDropsyncType: string;
    statusBridgeType: string;
    statusCardBridgeType: string;
    statusFaderBridgeType: string;
    pillStatusBridgeType: string;
    cardStatusBridgeType: string;
    faderStatusBridgeType: string;
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
  /** C2m-hotfix-1 (THE COVERED SWAP) — PHASE 1: inflate the fader over the OUTGOING world and
   * hand it the still frame (`png`, a PNG data URL captured by index.ts BEFORE the swap),
   * then await the page's `fader:ready` (curtain painted). true ⇒ the caller swaps the world
   * beneath the curtain; false ⇒ fail-open instant flip (MELT_READY_TIMEOUT_MS deadline, page
   * not loaded, or a cancel). Serial: a new flip while a melt is in flight collapses
   * instantly and proceeds. STEP 0.5 outcome B: no click pass-through exists on this Electron
   * build — the melt is owner-accepted click-waited, which is exactly why settle collapses to
   * 0×0 promptly (zero-miss rule). */
  beginMelt(pngBase64: string): Promise<boolean>;
  /** C2m-hotfix-1 — PHASE 2: the swap is complete — fire the fade + arm the settle deadline
   * (`fader:done` OR FADER_DONE_GRACE_MS). No-op without an in-flight melt. */
  runMelt(): void;
  /** C2m-hotfix-1 — fail-open: collapse + clear in-flight (no curtain in time ⇒ instant flip). */
  cancelMelt(): void;
  /** C2m-hotfix-1 — the layer's `fader:ready` landed (ipcMain in index.ts forwards here):
   * resolve the pending beginMelt with true; strays are no-ops. */
  faderReady(): void;
  /** C2m — the layer's `fader:done` landed (ipcMain in index.ts forwards here): collapse now.
   * Idempotent — the grace timer and repeated dones are all no-ops once settled. */
  faderDone(): void;
  /** C2m — capture the CURRENT site view as a PNG data URL for the melt (main-process
   * compositor READ — same class as the C2h sendInputEvent sensing; nothing is injected or
   * navigated, I1/I6 intact). null on ANY failure/empty frame (fail-open — owner decision 5). */
  captureViewPng(): Promise<string | null>;
  /** C2m — fader-layer evidence for f_c2m_flipDissolve: attach/z-membership, melt-in-flight
   * (spans begin→settle — same meaning for the battery), live bounds, and the
   * collapsed-at-rest fact (no lingering click-catcher). */
  faderProbe(): Promise<{
    attached: boolean;
    inFlight: boolean;
    bounds: Electron.Rectangle | null;
    collapsed: boolean;
  }>;
  /** C3 STEP 1 — the status layer's `status:measure` landed (ipcMain in index.ts forwards
   * here): remember the natural content width and re-assert the exact chip room. */
  statusMeasured(width: number): void;
  /** C3 STEP 1 — status-layer evidence for f_c3_* (DEV-gated): attach/showing, live bounds,
   * veil state, the measured width, the last show/progress/hide payloads forwarded, the
   * offline state machine's state and the auto-recovery reload counter. */
  statusProbe(): Promise<{
    attached: boolean;
    showing: boolean;
    bounds: Electron.Rectangle;
    collapsed: boolean;
    veilUp: boolean;
    lastMeasure: number;
    lastShow: Record<string, unknown> | null;
    lastProgress: { fraction: number | null; label?: string } | null;
    lastHideFlash: string | null;
    offlineState: 'ok' | 'entry-failed' | 'degraded';
    /** C3-hotfix-1 FIX B — the Connecting veil is up (offlineState stays 'ok' beneath it). */
    connectingUp: boolean;
    /** C3-hotfix-2 FIX B — site-view load attempts (battery proof that a re-entry reloaded). */
    siteLoadCount: number;
    /** C3-hotfix-3 — the load truth itself (the battery's white-forever detector: NO card
     * while `!siteLoadOk` is exactly the state this hotfix makes impossible). */
    siteLoadOk: boolean;
    /** C3-hotfix-4 — the success-veto stamp: TRUE from a main-frame failure until the next
     * fresh attempt or a FIX B navigation re-arm. */
    attemptFailed: boolean;
    /** C3-hotfix-4 — phantom finishes vetoed (a finish after a stamp = the ERROR document). */
    phantomFinishes: number;
    reloadCount: number;
    lastSavePath: string | null;
  }>;
  /** C3 — battery-only (env-gated): click the REAL buttons in the REAL layer (chip [Cancel]/
   * [Switch to Local], veil [Switch to Local]/[Try again]) so status:action rides the real
   * ipc path. Throws when DROPSYNC_CLOUD_DEV ≠ 1. */
  statusDrive(event: 'cancel' | 'switch-local' | 'retry'): Promise<void>;
  /** C3 — battery-only (env-gated): evaluate JS inside the STATUS page (our own page — the
   * pillEval precedent) for DOM-truth asserts (theme attr, painted classes). */
  statusEval<T = unknown>(expr: string): Promise<T>;
  /** C3 STEP 2 (D2) — the chip's [Cancel]: item.cancel() on the download the chip currently
   * shows; the done handler cleans up the partial + the chip. No-op without an active item. */
  statusCancelDownload(): void;
  /** C3 STEP 4 (D5) — the veil's [Try again]: reload the site view; the veil STAYS up while
   * trying (failure ⇒ did-fail-load ⇒ veil remains — honest). No-op outside entry-failed. */
  offlineRetry(): void;
  /** C3 STEP 4 — clear any active offline state + veil/chip. Called on every mode change to
   * local (the veil is cloud-only) — idempotent. */
  clearOfflineState(): void;
  /** C3 STEP 4 — test seam for netStatus(): boolean override (null = real net.isOnline()).
   * DEV-gated; the battery drives the offline transitions deterministically. */
  setNetOverride(v: boolean | null): void;
  /** C3 STEP 4 — the shared site load-failure path (the factored did-fail-load log + the
   * offline verdict). The real event handler and the battery both land here. */
  onSiteLoadFailed(code: number, isMainFrame: boolean, url: string, desc?: string): void;
  /** C3-hotfix-4 — battery-only (env-gated): invoke the REAL success handler directly (the
   * onSiteLoadFailed seam's mirror) so the veto leg exercises the exact real path. */
  onSiteLoadSucceeded(): void;
  /** C3-hotfix-4 — battery-only (env-gated): fire the FIX B re-arm through the SAME
   * navReArm the did-start-navigation listener calls (main-frame + same-origin shape). */
  siteNavReArm(url: string, isMainFrame: boolean): void;
  /** C3-hotfix-1 FIX C — mic diagnostic (DEV-gated, READ-ONLY evaluation on the SITE view,
   * the probeAuthSeen precedent): what the page's own permission queries + getUserMedia
   * actually return. The decision tree runs on this evidence. 5 s timeout ⇒ 'timeout'. */
  mediaDiag(): Promise<{ micQuery: string; camQuery: string; gum: string }>;
  /** C3 STEP 2 — battery-only (env-gated): arm a hold so the NEXT download pauses right
   * after its save path is set — makes "cancel mid-flight" deterministic headlessly (a tiny
   * data: URL download would otherwise complete before the cancel could land). */
  downloadTestArm(hold: boolean): void;
  /** C3 STEP 6 — battery-only (env-gated): point the site view at an arbitrary URL (the
   * dead-cloud leg's TEST-NET-1 target) and restore it. Battery-only I1 exception, ordered. */
  siteDriveNavigate(url: string): Promise<void>;
  /** C3 STEP 3 — DEV-gated doorman truth table: invokes the registered site-session handlers
   * DIRECTLY (the only deterministic allow-path proof — the real site can't be scripted). */
  doormanProbe(): Promise<{
    mediaSite: boolean;
    mediaEvil: boolean;
    geoSite: boolean;
    checkMediaSite: boolean;
    checkMediaEvil: boolean;
    checkNotifications: boolean;
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
  /** C3 STEP 4 — the shared load-failure path (factored did-fail-load log + offline
   * verdict). Both the real event and the battery's forced invocations land on it. */
  onLoadFailed?: (code: number, isMainFrame: boolean, url: string, desc?: string) => void,
  /** C3-hotfix-1 FIX A — the veil's SUCCESS exit. Fires on EVERY main-frame did-finish-load
   * (that event IS main-frame-only; deliberately NOT also fired from did-frame-finish-load).
   * The SITE view's attachGuards call passes the real handler; the POPUP propagation passes
   * undefined — a popup finishing load must NEVER clear the offline state. */
  onLoadSucceeded?: () => void,
): void {
  let firstLoadSeen = false;
  wc.on('did-finish-load', () => {
    if (!firstLoadSeen) {
      firstLoadSeen = true;
      onFirstLoad();
    }
    onLoadSucceeded?.();
  });
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    // C1 logged this; C3 routes it through the SHARED path — the log AND the offline
    // verdict (veil on entry failure) live in onSiteLoadFailed, so the battery can drive
    // the exact real path.
    onLoadFailed?.(code, isMainFrame, url, desc);
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
  wc.on('did-create-window', (child) => attachGuards(child.webContents, { strictNav: false }, onFirstLoad, onLoadFailed, undefined));
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

/** C2m — where the FADER page lives (cloned from cardPageUrl): dev server in dev, built
 * multi-page output in production. No query params — the fader carries no persisted state. */
function faderPageUrl(): string {
  const devRoot = process.env.ELECTRON_RENDERER_URL;
  if (devRoot) return `${devRoot}/fader/fader.html`;
  return 'file://' + join(fileURLToPath(new URL('.', import.meta.url)), '../renderer/fader/fader.html');
}

/** C3 — where the STATUS page lives (cloned from faderPageUrl): dev server in dev, built
 * multi-page output in production. No query params — the status layer carries no persisted
 * state (the veil theme rides each status:show payload). */
function statusPageUrl(): string {
  const devRoot = process.env.ELECTRON_RENDERER_URL;
  if (devRoot) return `${devRoot}/status/status.html`;
  return 'file://' + join(fileURLToPath(new URL('.', import.meta.url)), '../renderer/status/status.html');
}

export function initCloud(mainWindow: BrowserWindow, opts?: {
  onUserActivity?: () => void;
  /** C3 — the app's CURRENT theme reader (index.ts owns the vault settings); the offline
   * veil dresses in it at display time (C2k display-time theme rule). */
  currentTheme?: () => unknown;
}): CloudController {
  // C2h FIX 2/3 — main-provided activity feed: gestures sensed on the cloud view call this
  // (wired in index.ts to manager.touch()), so Cloud input feeds the SAME idle clock as Local.
  const { onUserActivity, currentTheme } = opts ?? {};
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
  // C2m — the fader layer is created EAGERLY at boot (card recipe) and NEVER removed; it is
  // collapsed 0×0 + hidden at rest, so it paints nothing and catches nothing until a melt.
  let faderView: WebContentsView | null = null;
  let faderLoaded = false;
  let faderInFlight = false; // a melt is playing RIGHT NOW — begin→settle (bounds = full window)
  let faderDoneTimer: ReturnType<typeof setTimeout> | null = null; // grace settle deadline
  // C2m-hotfix-1 — the pending `fader:ready` handshake: beginMelt's promise resolves true when
  // the page reports the curtain painted, false on the deadline (or any collapse — a cancel
  // must NEVER leave a beginMelt awaiter hanging).
  let faderReadyResolve: ((ok: boolean) => void) | null = null;
  let faderReadyTimer: ReturnType<typeof setTimeout> | null = null;
  // C2m-hotfix-2 — the swap pad: `fader:ready` does NOT resolve the awaiter directly; the pad
  // timer does (presented-pixels headroom). Cleared by collapseFader with the same discipline
  // as the ready deadline — no pad may fire after a cancel, no awaiter may hang.
  let faderSwapPadTimer: ReturnType<typeof setTimeout> | null = null;
  // C3 — the STATUS layer is created EAGERLY at boot (fader recipe) and NEVER removed;
  // collapsed 0×0 + hidden at rest. The chip is the download/degraded presentation, the veil
  // the cloud-only offline page. One presentation at a time (statusActive).
  let statusView: WebContentsView | null = null;
  let statusLoaded = false;
  let statusActive = false;
  let statusVeilUp = false;
  let statusLastMeasure = 0; // last natural content width reported by the page
  let statusPendingShow: Record<string, unknown> | null = null; // show before the page finished loading
  let statusCollapseTimer: ReturnType<typeof setTimeout> | null = null; // main-owned collapse timing
  let statusLastShow: Record<string, unknown> | null = null; // probe evidence
  let statusLastProgress: { fraction: number | null; label?: string } | null = null;
  let statusLastHideFlash: string | null = null;
  // C3 STEP 4 — the offline state machine. netStatus() is the SEAM (battery override);
  // ENTRY_FAILED = the site's main frame failed offline-ish while cloud is shown (veil);
  // DEGRADED = net observed true→false WHILE cloud is shown (chip, NO reload — D6).
  type OfflineState = 'ok' | 'entry-failed' | 'degraded';
  let offlineState: OfflineState = 'ok';
  let netOverride: boolean | null = null;
  let sawOfflineSinceEntry = false; // entry-failed auto-recovers ONLY on a false→true transition
  let offlinePollInterval: ReturnType<typeof setInterval> | null = null; // armed ONLY when needed
  let offlineReloadCount = 0; // auto-recovery reload spy (battery evidence)
  // C3-hotfix-1 FIX B — the connecting watchdog. Armed ONLY on fresh loads/reloads of the
  // site view (creation, [Try again], the auto-recovery reload, and the battery-only
  // siteDriveNavigate seam); NEVER on show() of an already-loaded view. `connectingUp` =
  // the honest "still connecting" veil is up while offlineState stays 'ok' (the net has NOT
  // failed — the page is just slow). Cleared by did-finish-load (site view), did-fail-load,
  // clearOfflineState, and any newer arm (idempotent re-arm).
  let connectingUp = false;
  let connectWatchdog: ReturnType<typeof setTimeout> | null = null;
  // C3-hotfix-2 FIX B — the site view's load TRUTH. `siteLoadOk` is set TRUE by the success
  // path and FALSE at the start of EVERY fresh load attempt (creation, [Try again], the
  // auto-recovery reload, the battery seam, and the re-entry reload below). show() reads it:
  // re-entry into a view whose load never succeeded is treated as a fresh attempt (the
  // owner's brick — Local → Cloud after a failed load used to sit white forever). Healthy
  // pages are NEVER reloaded — C2i's warm re-entry stays byte-identical. `siteLoadCount`
  // counts load attempts (battery evidence: a re-entry must increment it).
  let siteLoadOk = false;
  let siteLoadCount = 0;
  // C3-hotfix-4 FIX A — THE SUCCESS VETO (repair-order-c3-hotfix-4). Chromium LIES: after a
  // failed main-frame load the view holds the internal ERROR document
  // (chrome-error://chromewebdata/, EMPTY body, transparent background — the c3autopsy
  // probe), and a did-finish-load fires FOR THAT DOCUMENT ~5 ms after the did-fail-load
  // (the navtruth.js probe). A finish is only a success if NOTHING failed on the way:
  // every main-frame failure stamps `attemptFailed`, and a stamped attempt's finish is a
  // PHANTOM — vetoed, counted in `phantomFinishes` (battery evidence). The stamp is the
  // only honest signal: on the error page getURL() still returns the ATTEMPTED https url
  // and isLoading() is unreliable — both fix directions are dead per the probes.
  let attemptFailed = false;
  let phantomFinishes = 0;
  // C3 STEP 2 — downloads. One chip, latest-active-wins (D2); a download outlives a flip.
  interface DownloadRec { path: string; name: string }
  const activeDownloads = new Map<Electron.DownloadItem, DownloadRec>();
  let currentChipItem: Electron.DownloadItem | null = null;
  let downloadHoldArmed = false; // battery hold: pause the next item right after its save path
  let downloadLastSavePath: string | null = null; // probe evidence (battery disk asserts)
  const e2eSeamArmed = process.env.DROPSYNC_E2E === '1' || process.env.DROPSYNC_CLOUD_DEV === '1';

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
    // C2m — the fader joins the self-heal: full-window rect while a melt is in flight,
    // collapsed 0×0 at rest (zero-footprint discipline — the 1 s watchdog re-asserts BOTH,
    // so even a missed collapse is corrected within a second). Idempotent.
    if (faderView) {
      const expected = faderInFlight ? faderBounds() : faderCollapsedBounds();
      const cur = faderView.getBounds();
      if (cur.x !== expected.x || cur.y !== expected.y || cur.width !== expected.width || cur.height !== expected.height) {
        faderView.setBounds(expected);
        console.log('[fader] bounds set', JSON.stringify({ from: cur, to: expected }));
      }
    }
    // C3 — the status layer joins the self-heal: chip room (measured width) or full veil
    // rect while a presentation is active, collapsed 0×0 at rest. Idempotent.
    if (statusView) {
      const expected = !statusActive ? statusCollapsedBounds() : (statusVeilUp ? statusVeilBounds() : statusChipBounds());
      const cur = statusView.getBounds();
      if (cur.x !== expected.x || cur.y !== expected.y || cur.width !== expected.width || cur.height !== expected.height) {
        statusView.setBounds(expected);
        console.log('[status] bounds set', JSON.stringify({ from: cur, to: expected }));
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

  // ==== C2m — THE FADER LAYER (the flip dissolve) — card recipe verbatim ====

  /** The melt room: the window's content area (the world's exact footprint). Same math as
   * siteBounds — a pure function of the window, so the watchdog re-asserts it for free. */
  const faderBounds = (): Electron.Rectangle => siteBounds();
  /** At rest the fader is NOTHING: 0×0 at the origin, hidden (zero-miss rule — STEP 0.5 proved
   * a full-window overlay intercepts every click, so rest MUST be collapsed + invisible). */
  const faderCollapsedBounds = (): Electron.Rectangle => ({ x: 0, y: 0, width: 0, height: 0 });

  /** Z-ORDER LAW (C2m, extends C2j): site view < faderView < cardView < pillView ALWAYS — the
   * melt covers ONLY the world; card and pill stay crisp above it. After ANY attach of the
   * site view or the fader, re-stack in order fader → card → pill (children paint in
   * add-order — the existing raise* idiom: remove+add). */
  const raiseFader = (): void => {
    if (!faderView || mainWindow.isDestroyed()) return;
    mainWindow.contentView.removeChildView(faderView);
    mainWindow.contentView.addChildView(faderView);
  };

  const ensureFader = (): WebContentsView => {
    if (faderView) return faderView;
    faderView = new WebContentsView({
      webPreferences: {
        preload: join(fileURLToPath(new URL('.', import.meta.url)), '../preload/faderPreload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    faderView.setBackgroundColor('#00000000'); // WSLg-transparency-safe (pill precedent)
    attachPillLockdown(faderView.webContents); // same trusted-layer lockdown: no nav, no popups
    faderView.webContents.once('did-finish-load', () => {
      faderLoaded = true;
      console.log('[fader] layer loaded');
    });
    void faderView.webContents.loadURL(faderPageUrl());
    faderView.setBounds(faderCollapsedBounds()); // COLLAPSED + hidden until a melt plays
    faderView.setVisible(false);
    // Added FIRST at boot (before card and pill) ⇒ the z-order law (site < fader < card < pill)
    // holds from the very first frame.
    mainWindow.contentView.addChildView(faderView);
    return faderView;
  };

  /** The ONE settle path — `fader:done` from the page, the FADER_DONE_GRACE_MS deadline, or a
   * cancel-by-new-flip: all three land here. Idempotent; collapse = 0×0 + hidden + clear
   * in-flight (prompt, because with no pass-through API the inflated fader IS a click
   * catcher — zero-miss rule). C2m-hotfix-1: a pending `fader:ready` handshake is resolved
   * FALSE here too — a cancel/early-done must never leave beginMelt's awaiter hanging.
   * C2m-hotfix-2: a pending swap pad is cleared with the same discipline (no pad fires after
   * a cancel). */
  const collapseFader = (): void => {
    if (faderDoneTimer !== null) {
      clearTimeout(faderDoneTimer);
      faderDoneTimer = null;
    }
    if (faderReadyTimer !== null) {
      clearTimeout(faderReadyTimer);
      faderReadyTimer = null;
    }
    if (faderSwapPadTimer !== null) {
      clearTimeout(faderSwapPadTimer);
      faderSwapPadTimer = null;
    }
    if (faderReadyResolve !== null) {
      const resolve = faderReadyResolve;
      faderReadyResolve = null;
      resolve(false);
    }
    faderInFlight = false;
    if (faderView && !mainWindow.isDestroyed()) {
      faderView.setBounds(faderCollapsedBounds());
      faderView.setVisible(false);
    }
  };

  /** C2m-hotfix-1 — PHASE 1 of the covered swap: inflate the fader and hand it the outgoing
   * world's still frame (`png`, captured BEFORE the swap by index.ts), then WAIT for the
   * page's `fader:ready` (curtain painted) PLUS the hotfix-2 swap pad (presented pixels).
   * Resolves true ⇒ the caller may swap the world beneath the curtain; false ⇒ fail-open
   * instant flip (deadline, page not loaded, or a cancel). A new flip while a melt is in
   * flight collapses instantly (cancel — owner decision 4) and proceeds. The settle grace is
   * NOT armed here — runMelt owns it. */
  const beginMelt = (png: string): Promise<boolean> => {
    const v = ensureFader();
    if (!faderLoaded) return Promise.resolve(false); // page not ready (sub-second boot) — instant flip
    collapseFader(); // cancel any in-flight melt NOW (idempotent; resolves any stale pending)
    faderInFlight = true;
    v.setBounds(faderBounds()); // the window's content area
    v.setVisible(true);
    restackAll(); // fader ABOVE the OUTGOING world (the swap has not happened yet), but
    // below card, status and pill — the FULL z-law re-asserted in order (C3 single entry)
    const promise = new Promise<boolean>((resolve) => {
      faderReadyResolve = resolve;
      faderReadyTimer = setTimeout(() => {
        if (faderReadyResolve === null) return;
        const resolve = faderReadyResolve;
        faderReadyResolve = null;
        faderReadyTimer = null;
        resolve(false);
      }, MELT_READY_TIMEOUT_MS);
    });
    v.webContents.send('fader:show', { image: png, ms: FLIP_FADE_MS });
    // STEP 0.5 outcome B (2026-08-28 spike): no pass-through API exists on Electron 43 — the
    // inflated curtain is a click catcher until settle; owner-accepted click-wait stands.
    return promise;
  };

  /** C2m-hotfix-1 — the page's `fader:ready` landed (ipcMain in index.ts forwards here):
   * C2m-hotfix-2 — do NOT resolve the awaiter directly: arm the MELT_SWAP_PAD_MS pad so the
   * curtain's first frames reach the SCREEN before the caller swaps the world (ready = layout
   * commit, not presented pixels). A stray ready with none pending = no-op. */
  const faderReady = (): void => {
    if (faderReadyTimer !== null) {
      clearTimeout(faderReadyTimer);
      faderReadyTimer = null;
    }
    if (faderReadyResolve !== null && faderSwapPadTimer === null) {
      faderSwapPadTimer = setTimeout(() => {
        faderSwapPadTimer = null;
        if (faderReadyResolve !== null) {
          const resolve = faderReadyResolve;
          faderReadyResolve = null;
          resolve(true);
        }
      }, MELT_SWAP_PAD_MS);
    }
  };

  /** C2m-hotfix-1 — PHASE 2: the swap is complete beneath the painted curtain — fire the fade
   * and arm the settle deadline (`fader:done` OR the grace timer, whichever first). Idempotent:
   * without in-flight it is a no-op; a double call re-arms nothing twice. */
  const runMelt = (): void => {
    if (!faderInFlight || !faderView || mainWindow.isDestroyed()) return;
    faderView.webContents.send('fader:run');
    if (faderDoneTimer === null) {
      faderDoneTimer = setTimeout(collapseFader, FADER_DONE_GRACE_MS);
    }
  };

  /** C2m-hotfix-1 — the fail-open path: the curtain never painted in time (or the flip ran
   * snapshot-less) ⇒ collapse + clear in-flight — today's instant flip, nothing left behind. */
  const cancelMelt = (): void => {
    collapseFader();
  };

  /** Compositor READ of the current site view (Cloud→Local's outgoing world). No injection,
   * no navigation — I1/I6 intact. Fail-open: any error or empty frame ⇒ null (instant flip). */
  const captureViewPng = async (): Promise<string | null> => {
    if (!view || !shown || view.webContents.isDestroyed()) return null;
    try {
      const image = await view.webContents.capturePage();
      if (image.isEmpty()) return null;
      return `data:image/png;base64,${image.toPNG().toString('base64')}`;
    } catch {
      return null;
    }
  };

  // ==== END C2m fader layer ====

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

  // ==== C3 — THE STATUS LAYER + OFFLINE + DOWNLOADS + DOORMAN ================================

  /** Chip room: horizontally centered, y = STATUS_TOP, MEASURED width clamped to ≤60% of
   * the window, height exactly STATUS_H (D1). Zero-miss: the room equals the visible chip. */
  const statusChipBounds = (): Electron.Rectangle => {
    const b = mainWindow.getContentBounds();
    const maxW = Math.max(1, Math.round(b.width * 0.6));
    const natural = statusLastMeasure > 0 ? statusLastMeasure : 240; // provisional until the first measure lands
    const w = Math.min(natural, maxW);
    return { x: Math.round((b.width - w) / 2), y: STATUS_TOP, width: w, height: STATUS_H };
  };
  /** The veil room: the FULL content area (it covers the dead site — intended, §5). */
  const statusVeilBounds = (): Electron.Rectangle => siteBounds();
  /** At rest the status layer is NOTHING: 0×0 at the origin, hidden (fader rest discipline). */
  const statusCollapsedBounds = (): Electron.Rectangle => ({ x: 0, y: 0, width: 0, height: 0 });

  const onStatusLoadFinished = (): void => {
    statusLoaded = true;
    console.log('[status] layer loaded');
    if (statusPendingShow) {
      const p = statusPendingShow;
      statusPendingShow = null;
      statusShow(p as never); // a show that arrived before the page was ready displays now
    }
  };

  const ensureStatus = (): WebContentsView => {
    if (statusView) return statusView;
    statusView = new WebContentsView({
      webPreferences: {
        preload: join(fileURLToPath(new URL('.', import.meta.url)), '../preload/statusPreload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    statusView.setBackgroundColor('#00000000'); // WSLg-transparency-safe (pill precedent)
    attachPillLockdown(statusView.webContents); // same trusted-layer lockdown: no nav, no popups
    statusView.webContents.once('did-finish-load', () => onStatusLoadFinished());
    void statusView.webContents.loadURL(statusPageUrl());
    statusView.setBounds(statusCollapsedBounds()); // COLLAPSED + hidden until a presentation
    statusView.setVisible(false);
    // Added BETWEEN the card and the pill at boot ⇒ the z-order law holds from frame one.
    mainWindow.contentView.addChildView(statusView);
    return statusView;
  };

  /** Z-ORDER LAW (C3, extends C2m): site view < faderView < cardView < statusView < pillView
   * ALWAYS — the chip/veil float over both worlds but UNDER the pill (flipping always works,
   * even through the veil). The ONE re-stack entry point: no call site can forget the layer. */
  const raiseStatus = (): void => {
    if (!statusView || mainWindow.isDestroyed()) return;
    mainWindow.contentView.removeChildView(statusView);
    mainWindow.contentView.addChildView(statusView);
  };

  /** C3 — the FULL z-law re-assertion (site < fader < card < status < pill), used at boot,
   * in show(), and in beginMelt's raise chain (replaces the individual raise* calls). */
  const restackAll = (): void => {
    raiseFader();
    raiseCard();
    raiseStatus();
    raisePill();
  };

  /** The ONE settle path for the status layer: timers cleared, presentation state cleared,
   * 0×0 + hidden. Idempotent — every hide path lands here (main owns collapse timing). */
  const collapseStatus = (): void => {
    if (statusCollapseTimer !== null) {
      clearTimeout(statusCollapseTimer);
      statusCollapseTimer = null;
    }
    statusActive = false;
    statusVeilUp = false;
    if (statusView && !mainWindow.isDestroyed()) {
      statusView.setBounds(statusCollapsedBounds());
      statusView.setVisible(false);
    }
  };

  interface StatusShowPayload {
    kind: 'download' | 'offline';
    label: string;
    pulse?: boolean;
    progress?: boolean;
    action?: 'cancel' | 'switch-local' | null;
    veil?: boolean;
    title?: string;
    body?: string;
    theme?: unknown;
  }

  /** Push a presentation to the layer (chip or veil). Inflate → send → re-stack. One
   * presentation at a time; a show before the page finished loading is queued (card pump). */
  const statusShow = (p: StatusShowPayload): void => {
    const v = ensureStatus();
    statusLastShow = { ...p } as Record<string, unknown>;
    if (!statusLoaded) {
      statusPendingShow = { ...p } as Record<string, unknown>;
      return;
    }
    statusActive = true;
    statusVeilUp = !!p.veil;
    v.setBounds(statusVeilUp ? statusVeilBounds() : statusChipBounds());
    v.setVisible(true);
    v.webContents.send('status:show', p);
    restackAll(); // the status layer must never cover the pill
  };

  /** The page measured its content — remember it and snap the chip room to EXACTLY the
   * natural width (clamped); the battery asserts bounds == measured footprint. */
  const statusMeasured = (width: number): void => {
    statusLastMeasure = width;
    if (statusActive && !statusVeilUp) syncBounds();
  };

  /** Hide the current presentation; `flash` swaps in the paper ✓-chip for STATUS_FLASH_MS
   * (main owns the native collapse: flash ⇒ collapse after the flash + buffer, plain hide ⇒
   * after the 280 ms slide-up hold). */
  const statusHide = (flash?: string): void => {
    if (!statusActive) return;
    statusLastHideFlash = flash ?? null;
    statusView?.webContents.send('status:hide', { flash });
    if (statusCollapseTimer !== null) clearTimeout(statusCollapseTimer);
    statusCollapseTimer = setTimeout(
      collapseStatus,
      flash ? STATUS_FLASH_MS + 400 : STATUS_HIDE_HOLD_MS,
    );
  };

  // ---- C3 STEP 4 — the offline state machine ------------------------------------------------

  /** net.isOnline() through the TEST SEAM: the battery overrides it to drive the offline
   * transitions deterministically (production override is always null). */
  const netStatus = (): boolean => (netOverride !== null ? netOverride : net.isOnline());

  /** Chromium network error codes that mean "the internet is gone" (STEP 4a). */
  const OFFLINE_LOAD_CODES = new Set([-105, -106, -109, -118]);

  // ---- C3-hotfix-1 FIX B — the connecting watchdog + FIX A — the success lift --------------

  /** FIX B — arm the fresh-load watchdog (idempotent: a newer arm replaces an older timer). */
  const armConnectWatchdog = (): void => {
    if (connectWatchdog !== null) clearTimeout(connectWatchdog);
    connectWatchdog = setTimeout(onConnectTimeout, ENTRY_CONNECT_TIMEOUT_MS);
  };
  const clearConnectWatchdog = (): void => {
    if (connectWatchdog !== null) {
      clearTimeout(connectWatchdog);
      connectWatchdog = null;
    }
  };

  /** FIX B — 3 s of silence on a fresh load: the net has NOT failed (offlineState stays
   * 'ok'), the page is just slow ⇒ show the honest CONNECTING veil. A subsequent
   * did-fail-load swaps the text to the standard offline card (statusShow replaces the
   * content); FIX A's success path lifts it; the watchdog does not re-fire (one shot). */
  const onConnectTimeout = (): void => {
    connectWatchdog = null;
    if (mainWindow.isDestroyed()) return;
    if (offlineState !== 'ok' || !shown) return;
    connectingUp = true;
    console.log('[cloud] fresh load still silent after', ENTRY_CONNECT_TIMEOUT_MS, 'ms — showing Connecting veil');
    statusShow({
      kind: 'offline',
      label: '',
      veil: true,
      title: 'Connecting to Cloud…',
      body: 'Cloud is taking a while to reach the internet.',
      theme: currentTheme?.(),
    });
  };

  /** FIX A — the veil's SUCCESS exit (the stuck [Try again] card). When the site view's load
   * settles successfully while an offline veil OR the connecting veil is up ⇒ clear
   * EVERYTHING and re-arm the poll. One exit, always true — it lifts the veil for the
   * [Try again] reload AND the auto-recovery reload alike — for every finish that is
   * failure-free AND never vetoed. */
  const onSiteLoadSucceeded = (): void => {
    // C3-hotfix-4 FIX A — THE VETO: a finish after a main-frame failure is the ERROR
    // document finishing (chrome-error://chromewebdata/), NOT the site — treating it as
    // success lifted the veil onto empty white and faked siteLoadOk (the owner's
    // white-forever + the disabled re-entry retry). No siteLoadOk write, no veil touch,
    // no watchdog clear.
    if (attemptFailed) {
      phantomFinishes += 1;
      console.log('[cloud] PHANTOM finish VETOED — a main-frame failure already stamped this attempt');
      return;
    }
    siteLoadOk = true; // FIX B — the load truth, regardless of any veil bookkeeping below
    clearConnectWatchdog();
    if (offlineState === 'ok' && !connectingUp) return;
    console.log('[cloud] site load OK — lifting offline/connecting veil');
    offlineState = 'ok';
    connectingUp = false;
    collapseStatus();
    armOfflinePoll();
  };

  /** The poll: ONLY while cloud is shown or a non-OK state is active (zero cost otherwise).
   * ENTRY_FAILED recovers on a false→true transition (reload — a never-loaded page has
   * nothing to lose, D6); DEGRADED recovers with a flash and NO reload (protects unsaved
   * compose state); a fresh outage while cloud is shown ENTERS degraded. */
  const offlineTick = (): void => {
    if (mainWindow.isDestroyed()) return;
    const online = netStatus();
    if (offlineState === 'entry-failed') {
      if (online && sawOfflineSinceEntry) {
        offlineReloadCount += 1; // the recovery spy the battery asserts on
        siteLoadOk = false; // FIX B(h2) — fresh attempt
        attemptFailed = false; // hf4 FIX A — a new attempt is unjudged
        siteLoadCount += 1;
        // C3-hotfix-3 FIX A — the veil NEVER collapses on recovery: it SWAPS to the
        // Connecting presentation and stays up until the exits own the outcome —
        // did-finish-load ⇒ FIX A(h1) lifts it; a main-frame did-fail-load ⇒ FIX C brings
        // the offline card back. Collapsing here used to open a white window: a reload
        // failing with a non-offline code while the net flag already reads true produced
        // NO verdict ⇒ no card ⇒ white forever.
        statusShow({
          kind: 'offline',
          label: '',
          veil: true,
          title: 'Connecting to Cloud…',
          body: 'Cloud is taking a while to reach the internet.',
          theme: currentTheme?.(),
        });
        offlineState = 'ok';
        connectingUp = true;
        void view?.webContents.loadURL(CLOUD_URL);
        armConnectWatchdog(); // FIX B(h2) — a fresh recovery reload is watchdog-covered too
        armOfflinePoll();
      }
      return;
    }
    if (offlineState === 'degraded') {
      if (online) {
        offlineState = 'ok';
        statusHide('✓ Back online'); // flash; NO reload mid-cloud (D6)
        armOfflinePoll();
      }
      return;
    }
    // C3-hotfix-3 FIX B — a Wi-Fi toggle bounce during recovery must NEVER downgrade a live
    // veil: no degraded chip, no "✓ Back online" flash while the page is still dead (the
    // degraded path never reloads, by design — downgrading here strands the dead page). A
    // true mid-cloud degraded — a HEALTHY page whose net dropped, no veil up — is unchanged.
    if (connectingUp || statusVeilUp) return;
    if (shown && !online) setOfflineState('degraded');
  };

  /** Arm/disarm the 2 s poll — exactly when (cloud shown OR a non-OK state is active). */
  const armOfflinePoll = (): void => {
    const needed = shown || offlineState !== 'ok';
    if (needed && offlinePollInterval === null) {
      offlinePollInterval = setInterval(offlineTick, 2000);
    } else if (!needed && offlinePollInterval !== null) {
      clearInterval(offlinePollInterval);
      offlinePollInterval = null;
    }
  };

  const setOfflineState = (next: OfflineState): void => {
    if (offlineState === next) return;
    offlineState = next;
    connectingUp = false; // a real verdict replaces the connecting card (statusShow swaps content)
    if (next === 'entry-failed') {
      sawOfflineSinceEntry = !netStatus();
      // D1 — the themed veil + centered card. Theme = the app's CURRENT theme at display time.
      statusShow({
        kind: 'offline',
        label: '',
        veil: true,
        title: 'No internet — Cloud mode needs it',
        body: "The website can't load until you're back online.",
        theme: currentTheme?.(),
      });
    } else if (next === 'degraded') {
      statusShow({ kind: 'offline', label: 'Waiting for internet…', pulse: true, action: 'switch-local' });
    }
    armOfflinePoll();
  };

  /** Mode change to local: the veil is cloud-only — clear EVERYTHING offline (edge case).
   * FIX B: the connecting veil and the watchdog die here too (offlineState may still read
   * 'ok' while the connecting card is up — never early-return past it). */
  const clearOfflineState = (): void => {
    clearConnectWatchdog();
    if (offlineState === 'ok' && !connectingUp) return;
    offlineState = 'ok';
    connectingUp = false;
    collapseStatus();
    armOfflinePoll();
  };

  /** C3 STEP 4 — the SHARED load-failure path: the C1 did-fail-load log + the offline
   * verdict. attachGuards routes the real event here; the battery invokes it directly with
   * the same signature (forced leg). C3-hotfix-5 FIX A — the STAMP is main-frame ALWAYS
   * (hidden included — truth-bookkeeping never depends on visibility); only the VERDICT
   * (the veil/card) is main-frame + cloud-shown, and an already-up veil stays (no flicker,
   * honest). */
  const onSiteLoadFailed = (code: number, isMainFrame: boolean, url: string, desc?: string): void => {
    // C3-hotfix-2 FIX A — the log distinguishes main/sub-frame so forensics never needs a
    // second discovery round. Stays FIRST — hidden failures must keep landing in the log
    // (this very line is how hotfix-5's hole was proven).
    console.log('[cloud] did-fail-load:', isMainFrame ? 'main-frame' : 'sub-frame', code, desc ?? '', url.slice(0, 120));
    // C3-hotfix-2 FIX A (comment rewritten by hotfix-5 to match the split guard) — ONLY a
    // MAIN-frame failure gets past the first gate: helper frames of the real site (Firebase
    // auth iframes, analytics) fail fast offline — they are noise, never a verdict, and
    // they must never stamp the attempt (hf5) nor silence the connecting backstop
    // (hf1/hf2 — the owner once waited the full 5–6 s for the main frame while subframes
    // had already killed the watchdog).
    if (!isMainFrame) return;
    // C3-hotfix-5 FIX A — THE STAMP IS TRUTH, NOT UI: a main-frame failure stamps the
    // attempt EVEN WHILE HIDDEN. The owner flipped to Local mid-load ⇒ the -105 fired after
    // the flip ⇒ hf4's stamp sat behind the !shown clause and was suppressed ⇒ the phantom
    // finish arrived unstamped and was BELIEVED ⇒ siteLoadOk lied ⇒ white forever. Truth
    // (this stamp) never depends on visibility; only the verdict below does. Sub-frame
    // noise STILL never stamps — that guard stays in front, unchanged (hf4 owns it).
    attemptFailed = true;
    // C3-hotfix-5 FIX A — the VERDICT is UI: the veil/card are cloud-only (never a card
    // over Local). Everything below this line is presentation; everything above is truth.
    if (!shown) return;
    clearConnectWatchdog();
    if (offlineState === 'entry-failed') return;
    // C3-hotfix-3 FIX C — a main frame that FAILED and has NEVER succeeded is a dead page:
    // it always gets the card, whatever the error code or what the net flag claims. (The old
    // condition needed an offline-ish code or a false net flag — a reload failing with an
    // unlisted code while the net flag reads true produced NO verdict ⇒ white forever.)
    // Healthy-page main-frame failures — the SPA never top-navigates — remain untouched:
    // siteLoadOk is true for them, so only the code/net legs of this condition can fire.
    if (!siteLoadOk || OFFLINE_LOAD_CODES.has(code) || !netStatus()) setOfflineState('entry-failed');
  };

  /** The veil's [Try again]: reload the site view; the veil STAYS up while trying (D5).
   * FIX A does the lifting on did-finish-load; FIX B: the CONNECTING card's [Try again] is
   * the same reload path, and the retry counts as a recovery reload (battery spy). */
  const offlineRetry = (): void => {
    if (offlineState !== 'entry-failed' && !connectingUp) return;
    offlineReloadCount += 1;
    siteLoadOk = false; // FIX B — fresh attempt
    attemptFailed = false; // hf4 FIX A — a new attempt is unjudged
    siteLoadCount += 1;
    void view?.webContents.loadURL(CLOUD_URL);
    armConnectWatchdog(); // FIX B — a retry is a fresh load; the watchdog covers it
  };

  // ---- C3 STEP 2 — downloads (session-level: auth-popup downloads are covered too) ----------

  /** The chip shows the LATEST active item (insertion order). Promotion only ever SHOWS —
   * hides are owned by the done paths, so the ✓ flash can never be double-hidden. */
  const promoteLatestDownload = (): void => {
    let latest: Electron.DownloadItem | null = null;
    for (const key of activeDownloads.keys()) latest = key;
    if (!latest) return;
    const rec = activeDownloads.get(latest)!;
    currentChipItem = latest;
    statusShow({ kind: 'download', label: `Saving ${rec.name}…`, action: 'cancel', progress: true });
  };

  // STEP 3 (D3) — the DOORMAN handlers, hoisted to controller scope so doormanProbe can
  // invoke them DIRECTLY (the only deterministic allow-path proof). Registered on the site
  // partition session ONLY — our tiny layers keep their deny-all handlers on the default
  // session. Allow ONLY 'media' (mic + camera) AND only from the site origin; everything
  // else denies with a one-line log. The CHECK handler is what makes the site's own
  // Permissions-API gate report "granted" (un-deads the voice buttons).
  // electron.d.ts verified: details.requestingUrl exists (PermissionRequest, REQUIRED);
  // wc.mainFrameUrl does NOT exist on this build — the verified fallback is wc.mainFrame.url
  // (flagged in the report; see the correction comment in sitePermissionRequest).
  const originOf = (url: string): string => {
    try {
      return new URL(url).origin;
    } catch {
      return '';
    }
  };
  const sitePermissionRequest = (
    wc: Electron.WebContents,
    permission: string,
    callback: (granted: boolean) => void,
    details: { requestingUrl?: string },
  ): void => {
    // ORDER FIELD CORRECTION (flagged in the report): the order said "fall back to
    // wc.mainFrameUrl" — that method does NOT exist on Electron 43 (electron.d.ts verified).
    // The verified equivalent is `wc.mainFrame.url` (WebFrameMain.url: string, d.ts:19189).
    const source = details.requestingUrl ?? (wc.isDestroyed() ? '' : wc.mainFrame.url);
    const ok = permission === 'media' && originOf(source) === CLOUD_ORIGIN;
    // FIX C — EVERY verdict is loud, grants included (the mic bug taught us: an invisible
    // refusal path is undebuggable; the request log shows the EXACT permission string the
    // site sent, which is the evidence the allowlist must match).
    console.log('[cloud] permission-' + (ok ? 'granted' : 'denied'), permission, source.slice(0, 120));
    callback(ok);
  };
  const sitePermissionCheck = (
    _wc: Electron.WebContents | null,
    permission: string,
    requestingOrigin: string,
  ): boolean => {
    const ok = permission === 'media' && originOf(requestingOrigin) === CLOUD_ORIGIN;
    // FIX C — log EVERY invocation: what the site's Permissions-API query asked us, and what
    // we answered. If the query never consults this handler, the silence is itself evidence.
    console.log('[cloud] permission-check', permission, requestingOrigin, ok ? '→ granted' : '→ denied');
    return ok;
  };

  /** Shared chip wiring once a save path is settled: the chip rides the copy phase, progress
   * streams into it, and the done handler owns the flash / partial-file cleanup (D2). */
  const wireDownloadChip = (item: Electron.DownloadItem, savePath: string, name: string): void => {
    if (downloadHoldArmed) item.pause(); // battery hold: makes "cancel mid-flight" deterministic
    activeDownloads.set(item, { path: savePath, name });
    currentChipItem = item;
    downloadLastSavePath = savePath;
    statusShow({ kind: 'download', label: `Saving ${name}…`, action: 'cancel', progress: true });
    item.on('updated', (_e2, state) => {
      if (state !== 'progressing' || item !== currentChipItem) return;
      const total = item.getTotalBytes();
      const received = item.getReceivedBytes();
      statusProgress(total > 0 ? received / total : null); // unknown total ⇒ pulsing dot, no %
    });
    item.on('done', (_e2, state) => {
      const rec = activeDownloads.get(item);
      activeDownloads.delete(item);
      const wasCurrent = currentChipItem === item;
      if (wasCurrent) {
        currentChipItem = null;
        if (state === 'completed') {
          statusHide('✓ Saved'); // D2 flash
        } else {
          statusHide(); // cancelled | interrupted — same cleanup, NO flash
        }
      }
      // cancelled | interrupted — no partial file may survive, current or not.
      if (state !== 'completed' && rec) {
        try {
          rmSync(rec.path, { force: true });
        } catch { /* must-not-throw cleanup */ }
      }
      if (wasCurrent) promoteLatestDownload(); // a still-active download takes the chip
    });
  };

  const attachC3SessionHandlers = (): void => {
    const partitionSession = session.fromPartition(PARTITION);

    // STEP 2 (D2) — native Save As EVERY time; chip rides the copy phase; Cancel/interrupt
    // leaves NO partial file. BUILD-SPECIFIC FINDING (standalone probe, 2026-08-29): on this
    // Electron, `event.preventDefault()` makes ANY downloadURL-initiated item fire
    // done('cancelled') @ 0 bytes — even with a later setSavePath — so the e2e seam uses the
    // documented no-dialog pattern (sync setSavePath, NO preventDefault) instead, and the
    // real user path keeps the order's letter (preventDefault → OUR dialog → setSavePath).
    partitionSession.on('will-download', (event, item) => {
      const name = item.getFilename();
      if (e2eSeamArmed) {
        // E2E SEAM — a native save dialog cannot be answered headlessly; DROPSYNC_E2E/
        // DROPSYNC_CLOUD_DEV are dev-only env vars, so this silent auto-answer is prod-
        // impossible. (The order's DROPSYNC_E2E gate ALSO arms the legacy boot e2e harness,
        // which collides with the battery — the seam arms under EITHER dev gate.)
        const savePath = join(tmpdir(), `dropsync-c3-dl-${Date.now()}-${name.replace(/[^\w.-]+/g, '_')}`);
        console.log('[status] e2e auto-answer save path:', savePath);
        if (item.getState() !== 'progressing') return;
        item.setSavePath(savePath);
        wireDownloadChip(item, savePath, name);
        return;
      }
      event.preventDefault(); // we own the save path (never Electron's implicit dialog)
      void dialog.showSaveDialog(mainWindow, { defaultPath: name }).then((r) => {
        if (r.canceled || !r.filePath) {
          item.cancel(); // the user said no — nothing was written yet
          return;
        }
        if (item.getState() !== 'progressing') return; // interrupted while the dialog was open
        item.setSavePath(r.filePath);
        wireDownloadChip(item, r.filePath, name);
      });
    });

    partitionSession.setPermissionRequestHandler((wc, permission, callback, details) => {
      sitePermissionRequest(wc, permission, callback, details as { requestingUrl?: string });
    });
    partitionSession.setPermissionCheckHandler((wc, permission, requestingOrigin) =>
      sitePermissionCheck(wc, permission, requestingOrigin));

    // STEP 3 (D4) — screen share: Windows' own picker where it exists (useSystemPicker);
    // this body runs ONLY where no system picker exists (this WSL dev box) — deny loudly.
    // electron.d.ts verified: Streams' fields are all optional ⇒ callback({}) denies.
    partitionSession.setDisplayMediaRequestHandler((_request, callback) => {
      console.error('[cloud] screen-share DENIED (no system picker on this platform — dev/WSL; the real Windows build gets the native "choose what to share" picker)');
      callback({});
    }, { useSystemPicker: true });
  };
  attachC3SessionHandlers();

  /** The chip's [Cancel] ⇒ cancel the item the chip currently shows; its done handler does
   * the cleanup (partial deleted + chip hidden). */
  const statusCancelDownload = (): void => {
    currentChipItem?.cancel();
  };

  /** Progress for the CURRENT download chip (probe-visible evidence). */
  const statusProgress = (fraction: number | null, label?: string): void => {
    statusLastProgress = { fraction, label };
    if (statusActive && !statusVeilUp) statusView?.webContents.send('status:progress', { fraction, label });
  };

  // ==== END C3 ================================================================================

  // C3-hotfix-4 FIX B — a NEW main-frame same-origin navigation RE-ARMS success. The error
  // page emits NO navigation events of its own (navtruth.js), so only a REAL load attempt —
  // ours, or a genuine connectivity-restore auto-reload — can clear the stamp; the phantom
  // finish can never fake one. If connectivity returns and Chromium truly reloads the site,
  // the fresh attempt succeeds and FIX A lifts the veil by itself; if Electron never
  // auto-reloads, the card simply stays with [Try again] — also correct. Factored so the
  // battery seam exercises the SAME function the listener calls.
  const navReArm = (url: string, isMainFrame: boolean): void => {
    if (!isMainFrame) return;
    try { if (new URL(url).origin !== CLOUD_ORIGIN) return; } catch { return; }
    attemptFailed = false;
  };

  // C3-hotfix-4 FIX C — the void color for the CURRENT theme, via the same currentTheme
  // opt the status veil dresses from and normTheme's tolerant normalization (unknown or
  // missing ⇒ light): light #FAF7F2, dark #161616, minimal #C5C9B8.
  const voidColor = (): string => {
    const t = normTheme(currentTheme?.());
    return t === 'dark' ? '#161616' : t === 'minimal' ? '#C5C9B8' : '#FAF7F2';
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
    // C3-hotfix-4 FIX C — the themed void (folds in hotfix-2b verbatim): an OPAQUE canvas
    // in the CURRENT theme's page color. The site paints its own background — only the
    // pre-paint/dead void ever shows this, and it must read as OUR color, never the alien
    // white behind the offline card. Pill/fader/card/status keep their #00000000.
    view.setBackgroundColor(voidColor());
    loadStartedAt = Date.now();
    attachGuards(view.webContents, { strictNav: true }, () => {
      readyMs = Date.now() - loadStartedAt;
      console.log('[cloud] did-finish-load in', readyMs, 'ms');
    }, (code, isMainFrame, url, desc) => onSiteLoadFailed(code, isMainFrame, url, desc), onSiteLoadSucceeded);
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
    // C3-hotfix-4 FIX B — the re-arm listener (navtruth.js: the error document fires no
    // navigation events, so anything landing here is a REAL navigation).
    view.webContents.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
      navReArm(url, isMainFrame);
    });
    siteLoadOk = false; // FIX B — creation IS a fresh attempt (truth arrives with did-finish-load)
    attemptFailed = false; // hf4 FIX A — a new attempt is unjudged
    siteLoadCount += 1;
    void view.webContents.loadURL(CLOUD_URL); // stock UA — never spoofed
    armConnectWatchdog(); // FIX B — fresh creation load ⇒ the 3 s connecting backstop runs
    // Keep session cookies on disk (persist:) so sign-in survives app + dev-server restarts.
    void session.fromPartition(PARTITION);
    return view;
  };

  const show = (): void => {
    const existed = view !== null; // FIX B — a freshly created view loads in ensureView itself
    const v = ensureView();
    // C3-hotfix-4 FIX C — refresh the void: cheap + idempotent, so a theme changed while
    // in Local is honored on the next Cloud entry.
    v.setBackgroundColor(voidColor());
    // C3-hotfix-2 FIX B — RE-ENTRY into a dead Cloud RETRIES. show() of an existing view used
    // to reload nothing, arm nothing, fire nothing: Local → Cloud after a failed load sat
    // white forever, no card, no retry (the owner's brick). If the view exists but its load
    // never succeeded, this re-entry IS a fresh attempt. Healthy pages are NEVER reloaded —
    // C2i's warm re-entry stays byte-identical when the site is fine (this fires only for a
    // dead/never-finished page, where there is nothing warm to lose).
    if (existed && !siteLoadOk) {
      siteLoadOk = false;
      attemptFailed = false; // hf4 FIX A — a new attempt is unjudged
      siteLoadCount += 1;
      void v.webContents.loadURL(CLOUD_URL);
      armConnectWatchdog();
    }
    if (!shown) {
      mainWindow.contentView.addChildView(v);
      shown = true;
      // The site view was just stacked ON TOP of everything — undo, in z-law order (C3:
      // ONE restack covers fader → card → status → pill; no call site can forget a layer).
      restackAll();
    }
    syncBounds();
    v.setVisible(true);
    v.webContents.focus();
    armOfflinePoll(); // cloud shown ⇒ the degraded-outage poll may be needed
  };

  const hide = (): void => {
    if (view && shown) {
      mainWindow.contentView.removeChildView(view);
      shown = false;
    }
    // The pill is NEVER removed (C2f contract) — it keeps floating over Local too.
    if (mainWindow.isFocused()) mainWindow.webContents.focus();
    armOfflinePoll(); // cloud hidden ⇒ the poll is only needed while a non-OK state lingers
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
      if (!view || !pillView || !cardView || !faderView || !statusView) {
        return {
          dropsyncType: 'no-view', hasPreloadKey: true as const, pillDropsyncType: 'no-view', pillBridgeType: 'no-view', pillCardBridgeType: 'no-view', cardDropsyncType: 'no-view', cardBridgeType: 'no-view',
          faderDropsyncType: 'no-view', faderBridgeType: 'no-view', faderCardBridgeType: 'no-view', pillFaderBridgeType: 'no-view', cardFaderBridgeType: 'no-view',
          statusDropsyncType: 'no-view', statusBridgeType: 'no-view', statusCardBridgeType: 'no-view', statusFaderBridgeType: 'no-view', pillStatusBridgeType: 'no-view', cardStatusBridgeType: 'no-view', faderStatusBridgeType: 'no-view',
        };
      }
      const dropsyncType = await view.webContents.executeJavaScript('typeof window.dropsync');
      // The pill layer must have ITS bridge and NEVER the main app's.
      const pillDropsyncType = await pillView.webContents.executeJavaScript('typeof window.dropsync');
      const pillBridgeType = await pillView.webContents.executeJavaScript('typeof window.dropsyncPill');
      // C2j — the card bridge exists ONLY on the card page (never site, never pill).
      const pillCardBridgeType = await pillView.webContents.executeJavaScript('typeof window.dropsyncCard');
      const cardDropsyncType = await cardView.webContents.executeJavaScript('typeof window.dropsync');
      const cardBridgeType = await cardView.webContents.executeJavaScript('typeof window.dropsyncCard');
      // C2m — the fader bridge exists ONLY on the fader page (never site, pill, or card).
      const faderDropsyncType = await faderView.webContents.executeJavaScript('typeof window.dropsync');
      const faderBridgeType = await faderView.webContents.executeJavaScript('typeof window.dropsyncFader');
      const faderCardBridgeType = await faderView.webContents.executeJavaScript('typeof window.dropsyncCard');
      const pillFaderBridgeType = await pillView.webContents.executeJavaScript('typeof window.dropsyncFader');
      const cardFaderBridgeType = await cardView.webContents.executeJavaScript('typeof window.dropsyncFader');
      // C3 — the status bridge exists ONLY on the status page (never site/pill/card/fader).
      const statusDropsyncType = await statusView.webContents.executeJavaScript('typeof window.dropsync');
      const statusBridgeType = await statusView.webContents.executeJavaScript('typeof window.dropsyncStatus');
      const statusCardBridgeType = await statusView.webContents.executeJavaScript('typeof window.dropsyncCard');
      const statusFaderBridgeType = await statusView.webContents.executeJavaScript('typeof window.dropsyncFader');
      const pillStatusBridgeType = await pillView.webContents.executeJavaScript('typeof window.dropsyncStatus');
      const cardStatusBridgeType = await cardView.webContents.executeJavaScript('typeof window.dropsyncStatus');
      const faderStatusBridgeType = await faderView.webContents.executeJavaScript('typeof window.dropsyncStatus');
      return { dropsyncType, hasPreloadKey: true as const, pillDropsyncType, pillBridgeType, pillCardBridgeType, cardDropsyncType, cardBridgeType, faderDropsyncType, faderBridgeType, faderCardBridgeType, pillFaderBridgeType, cardFaderBridgeType, statusDropsyncType, statusBridgeType, statusCardBridgeType, statusFaderBridgeType, pillStatusBridgeType, cardStatusBridgeType, faderStatusBridgeType };
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
    beginMelt,
    runMelt,
    cancelMelt,
    faderReady,
    faderDone: collapseFader, // `fader:done` and the grace deadline land on the ONE settle path
    captureViewPng,
    faderProbe: async () => {
      if (!faderView || mainWindow.isDestroyed()) {
        return { attached: false, inFlight: false, bounds: null, collapsed: true };
      }
      const b = faderView.getBounds();
      return {
        attached: mainWindow.contentView.children.includes(faderView),
        inFlight: faderInFlight,
        bounds: b,
        collapsed: b.x === 0 && b.y === 0 && b.width === 0 && b.height === 0,
      };
    },
    statusMeasured,
    statusCancelDownload,
    offlineRetry,
    clearOfflineState,
    onSiteLoadFailed,
    onSiteLoadSucceeded: (): void => {
      if (process.env.DROPSYNC_CLOUD_DEV !== '1') throw new Error('onSiteLoadSucceeded is DROPSYNC_CLOUD_DEV-only');
      onSiteLoadSucceeded();
    },
    siteNavReArm: (url: string, isMainFrame: boolean): void => {
      if (process.env.DROPSYNC_CLOUD_DEV !== '1') throw new Error('siteNavReArm is DROPSYNC_CLOUD_DEV-only');
      navReArm(url, isMainFrame);
    },
    setNetOverride: (v: boolean | null): void => {
      if (process.env.DROPSYNC_CLOUD_DEV !== '1') throw new Error('setNetOverride is DROPSYNC_CLOUD_DEV-only');
      netOverride = v;
    },
    downloadTestArm: (hold: boolean): void => {
      if (process.env.DROPSYNC_CLOUD_DEV !== '1') throw new Error('downloadTestArm is DROPSYNC_CLOUD_DEV-only');
      downloadHoldArmed = hold;
    },
    siteDriveNavigate: async (url: string): Promise<void> => {
      if (process.env.DROPSYNC_CLOUD_DEV !== '1') throw new Error('siteDriveNavigate is DROPSYNC_CLOUD_DEV-only');
      if (!view) throw new Error('site view missing');
      // C3 battery-only navigation of the site view (the dead-cloud leg's TEST-NET-1 target
      // + its CLOUD_URL restore) — ordered by repair-order-cloud-c3 §4 STEP 6; never used
      // outside the DEV battery (invariant I1 otherwise absolute).
      // C3-hotfix-1: a seam navigation IS a fresh load ⇒ the connecting watchdog covers it
      // (the hotfix battery's connecting leg observes the veil through exactly this path).
      // Armed BEFORE the await — a hanging load (192.0.2.1) never resolves the promise.
      // C3-hotfix-2 FIX B — the seam tracks load truth like every other fresh attempt
      // (without this, a dead seam load would leave a stale siteLoadOk=true and the
      // re-entry reload would never fire).
      siteLoadOk = false;
      attemptFailed = false; // hf4 FIX A — a new attempt is unjudged (the battery seam
      // tracks load truth exactly like every product fresh attempt)
      siteLoadCount += 1;
      armConnectWatchdog();
      await view.webContents.loadURL(url);
    },
    statusProbe: async () => {
      if (process.env.DROPSYNC_CLOUD_DEV !== '1') throw new Error('statusProbe is DROPSYNC_CLOUD_DEV-only');
      const b = statusView ? statusView.getBounds() : { x: 0, y: 0, width: 0, height: 0 };
      return {
        attached: statusView ? mainWindow.contentView.children.includes(statusView) : false,
        showing: statusActive,
        bounds: b,
        collapsed: b.x === 0 && b.y === 0 && b.width === 0 && b.height === 0,
        veilUp: statusVeilUp,
        lastMeasure: statusLastMeasure,
        lastShow: statusLastShow,
        lastProgress: statusLastProgress,
        lastHideFlash: statusLastHideFlash,
        offlineState,
        connectingUp,
        siteLoadCount,
        siteLoadOk,
        attemptFailed,
        phantomFinishes,
        reloadCount: offlineReloadCount,
        lastSavePath: downloadLastSavePath,
      };
    },
    statusDrive: async (event) => {
      if (process.env.DROPSYNC_CLOUD_DEV !== '1') throw new Error('statusDrive is DROPSYNC_CLOUD_DEV-only');
      if (!statusView) throw new Error('status layer missing');
      // Click the REAL buttons in the REAL layer (pillDrive precedent) — status:action then
      // rides the genuine ipc path into index.ts's router.
      const id = event === 'cancel' ? 'act' : event === 'switch-local' ? 'offLocal' : 'offRetry';
      await statusView.webContents.executeJavaScript(
        `(function(){ var b = document.getElementById(${JSON.stringify(id)}); if (!b) return false; b.click(); return true; })()`
      );
    },
    statusEval: async <T>(expr: string): Promise<T> => {
      if (process.env.DROPSYNC_CLOUD_DEV !== '1') throw new Error('statusEval is DROPSYNC_CLOUD_DEV-only');
      if (!statusView) throw new Error('status layer missing');
      return (await statusView.webContents.executeJavaScript(expr)) as T;
    },
    mediaDiag: async (): Promise<{ micQuery: string; camQuery: string; gum: string }> => {
      if (process.env.DROPSYNC_CLOUD_DEV !== '1') throw new Error('mediaDiag is DROPSYNC_CLOUD_DEV-only');
      if (!view) throw new Error('site view missing');
      // READ-ONLY evaluation on the SITE view (the probeAuthSeen precedent — we observe the
      // page's own permission reality; we change nothing). micQuery/camQuery: what the
      // Permissions API reports; gum: getUserMedia({audio:true}) — 'ok' or the error NAME
      // (tracks stopped immediately). Whole probe wrapped at 5 s ⇒ 'timeout'.
      const expr = `(async () => {
        const q = (n) => navigator.permissions.query({ name: n }).then(function (s) { return s.state; }).catch(function (e) { return 'query-error:' + e.name; });
        const gum = await navigator.mediaDevices.getUserMedia({ audio: true }).then(function (st) { st.getTracks().forEach(function (t) { t.stop(); }); return 'ok'; }).catch(function (e) { return e.name; });
        return { micQuery: await q('microphone'), camQuery: await q('camera'), gum: gum };
      })()`;
      const TIMEOUT: { micQuery: string; camQuery: string; gum: string } = { micQuery: 'timeout', camQuery: 'timeout', gum: 'timeout' };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const race = new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), 5000);
      });
      try {
        return await Promise.race([
          view.webContents.executeJavaScript(expr) as Promise<{ micQuery: string; camQuery: string; gum: string }>,
          race,
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    doormanProbe: async () => {
      if (process.env.DROPSYNC_CLOUD_DEV !== '1') throw new Error('doormanProbe is DROPSYNC_CLOUD_DEV-only');
      // Direct invocation of the REGISTERED handlers — the only deterministic allow-path
      // proof (the real site can't be scripted, I1/I6). The wc argument only feeds the
      // mainFrameUrl() fallback; the probe always passes an explicit requestingUrl.
      const probeWc = pillView?.webContents ?? null;
      const ask = (permission: string, url: string): Promise<boolean> =>
        new Promise((resolve) => {
          sitePermissionRequest(
            probeWc as Electron.WebContents,
            permission,
            (granted) => resolve(granted),
            { requestingUrl: url },
          );
        });
      return {
        mediaSite: await ask('media', CLOUD_URL),
        mediaEvil: await ask('media', 'https://evil.example/'),
        geoSite: await ask('geolocation', CLOUD_URL),
        checkMediaSite: sitePermissionCheck(null, 'media', CLOUD_ORIGIN),
        checkMediaEvil: sitePermissionCheck(null, 'media', 'https://evil.example'),
        checkNotifications: sitePermissionCheck(null, 'notifications', CLOUD_ORIGIN),
      };
    },
  };

  // Boot: the pill layer exists from the first frame; create it eagerly.
  // C2j — the card layer too (EAGER, never removed), created BEFORE the pill so the z-order
  // law (site < card < pill) holds from the very first frame.
  // C2m — the fader layer joins (EAGER, never removed), created BEFORE the card so the
  // extended z-order law (site < fader < card < pill) holds from the very first frame.
  // C3 — the status layer joins (EAGER, never removed), BETWEEN card and pill so the full
  // z-order law (site < fader < card < status < pill) holds from the very first frame.
  ensureFader();
  ensureCard();
  ensureStatus();
  ensurePill();
  restackAll(); // belt-and-braces: the law is asserted, not assumed, at boot
  console.log('[fader] layer booted (eager, collapsed 0×0, hidden)'); // C2m boot evidence
  console.log('[status] layer booted (eager, collapsed 0×0, hidden)'); // C3 boot evidence

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
