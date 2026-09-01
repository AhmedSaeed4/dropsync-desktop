/**
 * C2m — the flip-dissolve fader page logic (vanilla TS; the ONLY script in the fader layer,
 * mirroring card.ts's role), ported from the OWNER-APPROVED demo's settle/wake pattern
 * (desktop-docs/mode-flip-fade-preview.html, the FIXED version — the one where the faded world
 * is PARKED where it cannot paint and only wakes beneath a still-opaque cover, so the
 * old-world flash the owner caught is impossible by construction).
 *
 * C2m-hotfix-1 — THE COVERED SWAP: the show/fade phases are SPLIT. `onShow` wakes the still
 * frame fully opaque and DECODES it — and STOPS (reportReady): during the whole decode the
 * curtain already covers the outgoing world with identical pixels, so main may swap the world
 * beneath it with nothing peeking through. Only after main's `onRun` (the swap is complete)
 * does the fade start. One continuous dissolve: curtain → swap hidden beneath → fade.
 *
 * The page is a dumb single <img>. `fader:done` rides back to main on transitionend — with a
 * safety net at ms+250 — and main collapses the native layer. NO timers own the choreography
 * here beyond that safety net; cancel/replace authority stays in MAIN (serial dissolve
 * controller), same split as the card pump.
 *
 * prefers-reduced-motion (owner decision 3): main ALWAYS passes 250; the PAGE clamps the
 * duration to ≤16 ms via matchMedia — done in JS rather than CSS `transition: none` so
 * transitionend still fires and the settle report stays prompt.
 *
 * One show at a time; the showId guard governs BOTH phases — a second show REPLACES the first
 * (stale decodes/runs of a replaced show are discarded). Fail-open: a decode failure reports
 * done immediately — a cosmetic layer must never hold the window hostage (owner decision 5).
 *
 * PAC-3 FIX A — THE PRESENTATION-CONFIRMED CURTAIN: the page reports ready only after TWO
 * consecutive requestAnimationFrame callbacks past the decode + layout commit (both timestamps
 * recorded) — a SUBMISSION-level ack (per-compositor-frame), not just a layout commit. See the
 * ack block in onShow for the full rationale and the honest platform limit.
 */

interface FaderBridge {
  onShow(cb: (p: { image: string; ms: number }) => void): () => void;
  onRun(cb: () => void): () => void;
  reportReady(): void;
  reportDone(): void;
}

declare global {
  interface Window {
    dropsyncFader: FaderBridge;
  }
}

const img = document.getElementById('faderImg') as HTMLImageElement;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/** C2m-hotfix-2 (PRESENTATION HEADROOM, END edge) — transitionend fires on the ANIMATION
 * TIMELINE, not on the last PRESENTED frame, so the curtain could collapse while its last
 * SHOWN frame was still partially opaque (an end-of-melt pop). The delay lets the fully
 * faded (opacity 0) frame definitely present before the native collapse. Main-side grace
 * (FADER_DONE_GRACE_MS = 500) still bounds everything: 250 fade + 80 delay fits. */
const FADER_DONE_DELAY_MS = 80;

let showId = 0; // a second show replaces the first — stale decodes/runs are discarded
let showMs = 0; // the fade duration the CURRENT show was handed (main always passes 250)
let safetyTimer: ReturnType<typeof setTimeout> | null = null;
let doneDelayTimer: ReturnType<typeof setTimeout> | null = null; // hotfix-2 delayed done

// PAC-3 FIX A — the submission-ack record for the CURRENT show, read by the battery probe
// (faderProbe → the __c2mFader fixture): how many compositor frames the page waited through
// before reporting ready (2 = the full two-rAF ack; 0 = an immediate reportReady — the
// pre-PAC-3 shape the RED pair restores) plus both rAF timestamps (performance.now()).
let readyRafTicks = 0;
let readyRafAt: [number, number] = [0, 0];

/** PAC-3 FIX A — ONE compositor frame, resolved with its rAF timestamp. */
const nextFrame = (): Promise<number> =>
  new Promise((resolve) => {
    requestAnimationFrame((t) => resolve(t));
  });

const finish = (myShow: number): void => {
  if (myShow !== showId) return; // replaced mid-flight — only the CURRENT show may settle
  if (safetyTimer !== null) {
    clearTimeout(safetyTimer);
    safetyTimer = null;
  }
  if (doneDelayTimer !== null) return; // delayed done already pending for this show
  doneDelayTimer = setTimeout(() => {
    doneDelayTimer = null;
    if (myShow !== showId) return; // a replaced show's delayed done is discarded
    window.dropsyncFader.reportDone();
  }, FADER_DONE_DELAY_MS);
};

window.dropsyncFader.onShow(({ image, ms }) => {
  showId += 1;
  const myShow = showId;
  showMs = ms;
  readyRafTicks = 0; // a fresh show restarts the ack record (the probe never reads a stale one)
  readyRafAt = [0, 0];
  if (safetyTimer !== null) {
    clearTimeout(safetyTimer);
    safetyTimer = null;
  }
  if (doneDelayTimer !== null) {
    clearTimeout(doneDelayTimer); // a new show replaces any pending delayed done
    doneDelayTimer = null;
  }

  const run = async (): Promise<void> => {
    // WAKE, park-safe: arm the still frame fully opaque with transitions OFF, never fading
    // over an undecoded image (the demo's wakeUnderCover + decode discipline).
    img.style.transition = 'none';
    img.style.opacity = '1';
    img.src = image;
    try {
      await img.decode(); // never fade over an undecoded image
    } catch {
      finish(myShow); // fail-open: bad/empty frame ⇒ instant settle, main flips instantly
      return;
    }
    if (myShow !== showId) return; // a newer show replaced this one mid-decode
    void img.offsetWidth; // commit the opaque frame (a LAYOUT commit — see the ack below)
    // PAC-3 FIX A — THE PRESENTATION-CONFIRMED CURTAIN. The twitch investigation proved the
    // gap this closes: decode() + offsetWidth is a LAYOUT commit, NOT presented pixels
    // (P1d's wrong frame; the fixed 50 ms swap pad was a guess riding on that layout
    // moment). requestAnimationFrame callbacks are produced per compositor frame, so
    // awaiting TWO consecutive ones means the painted curtain frame has been SUBMITTED to
    // the presentation pipeline — the tightest page-side signal that exists. Honest limit
    // (per the order): still not a DWM present receipt — nothing on this platform is — but
    // main's swap now waits for a submission ack, with MELT_SWAP_PAD_MS (50) riding on top.
    // No new timer: rAF always fires on a live compositor (a hidden/occluded window is not
    // a flip moment), and main's MELT_READY_TIMEOUT_MS deadline still bounds the whole
    // handshake fail-open.
    readyRafAt[0] = await nextFrame(); // tick 1 — the painted curtain frame is submitted
    if (myShow !== showId) return; // replaced between ticks — the stale ack is discarded
    readyRafTicks = 1;
    readyRafAt[1] = await nextFrame(); // tick 2 — one full compositor frame of headroom
    if (myShow !== showId) return;
    readyRafTicks = 2;
    // CURTAIN IS UP — stop here (hotfix-1). Main swaps the world beneath the identical
    // pixels, then fires `fader:run`; only THAT starts the fade.
    window.dropsyncFader.reportReady();
  };

  void run();
});

window.dropsyncFader.onRun(() => {
  if (showId === 0) return; // stray run with no show — nothing to fade
  const myShow = showId;
  if (safetyTimer !== null) {
    clearTimeout(safetyTimer);
    safetyTimer = null;
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (myShow !== showId) return; // a replaced show must not move
      // Duration: main always passes FLIP_FADE_MS (250); reduced-motion clamps to ≤16 ms
      // page-side (owner decision 3) — the ONLY visible change in the whole flip follows.
      const dur = reducedMotion.matches ? Math.min(showMs, 16) : showMs;
      const onEnd = (e: TransitionEvent): void => {
        if (e.propertyName !== 'opacity') return; // bubble-proof
        img.removeEventListener('transitionend', onEnd);
        finish(myShow);
      };
      img.addEventListener('transitionend', onEnd);
      img.style.transition = `opacity ${dur}ms ease`;
      img.style.opacity = '0'; // the ONLY visible change in the whole flip
      safetyTimer = setTimeout(() => finish(myShow), dur + 250); // safety net; finish is idempotent
    });
  });
});

// PAC-3 FIX A — dev probe fixture (?e2e=1, which MAIN appends only under DROPSYNC_CLOUD_DEV):
// the battery reads the submission-ack truth (the C2g FIX 5 __c2gPill pattern — read-only;
// every action still rides the real bridge paths).
if (new URLSearchParams(window.location.search).get('e2e') === '1') {
  (window as unknown as Record<string, unknown>).__c2mFader = {
    get rafTicksAtReady(): number { return readyRafTicks; },
    get readyRafAt(): number[] { return readyRafAt; },
  };
}
