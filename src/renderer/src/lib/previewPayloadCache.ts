/**
 * FIX 8 — renderer-side LRU cache for hydrated preview payloads (port of web PR #212's
 * "instant Back" mechanism). Going back through a mention trail re-points the preview modal at
 * the previous drop; without this, its mount effect wiped state and refetched over IPC,
 * flashing a loading frame. Cached entries restore with ZERO fetches.
 *
 * Deliberately memory-only (module-level Map — nothing persists to disk, nothing survives an
 * app restart). Capped at 30 entries (round 112 — web #235's shelf size: the CARD now banks
 * every in-view load, so the shelf holds a whole screen of prepared drops; entries carry text
 * bodies + media:// token URLs, never media bytes, so count-only capping stays sound — the
 * web needed a 30 MB budget only because it banks full base64 payloads). Invalidation
 * contract: edit-success and
 * deletion paths call invalidate/clear (wired in App.tsx) so stale content can never be served;
 * media:// URLs stored here are session-scoped tokens that stay valid for the app's lifetime.
 */

export interface PreviewPayload {
  /** Decrypted text body ('' when absent). */
  text: string;
  /** Resolved media:// URLs (null when the drop has no such payload). */
  fileUrl: string | null;
  imageUrl: string | null;
}

const CAPACITY = 30;

const cache = new Map<string, PreviewPayload>();

/** LRU get: refresh recency on every hit. */
export function getCachedPreviewPayload(dropId: string): PreviewPayload | undefined {
  const hit = cache.get(dropId);
  if (hit) {
    cache.delete(dropId);
    cache.set(dropId, hit);
  }
  return hit;
}

/** LRU put: insert as most-recent; evict the oldest entry past capacity. */
export function putCachedPreviewPayload(dropId: string, payload: PreviewPayload): void {
  cache.delete(dropId);
  cache.set(dropId, payload);
  while (cache.size > CAPACITY) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Drop one entry — called on edit-success for the edited drop id. */
export function invalidatePreviewPayload(dropId: string): void {
  cache.delete(dropId);
}

/** Drop everything — structural moments ONLY (import, vault move). Deletes invalidate per-id. */
export function clearPreviewPayloadCache(): void {
  cache.clear();
}

/** Current entry count (dev battery probe — FIX 14 LRU-cap verification). */
export function previewPayloadCacheSize(): number {
  return cache.size;
}

// ---- FIX 14 — hover-prefetch ("first click feels like web") -------------------------------
// A fine-pointer hover over a card fire-and-forgets the TEXT payload into the cache, so the
// subsequent preview click is a warm hit with zero loading frame. Deliberately text-only:
// images/videos stream through media:// on demand and must stay lazy (banking a text-only
// entry for an image drop would poison the modal's cache hit with imageUrl:null).
// Dedupe: an in-flight set prevents rapid hover-sweeps from queueing unbounded work; errors
// swallow silently (a failed prefetch just means a normal cold load later); put() is
// idempotent per id, so StrictMode double-effects can never bank corrupt entries.

const inFlightPrefetches = new Set<string>();

export function prefetchPreviewPayload(
  dropId: string,
  fetchText: () => Promise<string>
): void {
  if (cache.has(dropId) || inFlightPrefetches.has(dropId)) return;
  inFlightPrefetches.add(dropId);
  void fetchText()
    .then((text) => {
      putCachedPreviewPayload(dropId, { text, fileUrl: null, imageUrl: null });
    })
    .catch(() => {
      /* a failed prefetch = normal cold load later */
    })
    .finally(() => {
      inFlightPrefetches.delete(dropId);
    });
}

/**
 * FIX 16 — IMAGE hover-prefetch. With stable media tokens, a hover can warm the exact URL the
 * preview will use and run an offscreen decode against it, so the click renders from Chromium's
 * image cache with zero flinch. Keyed by URL in the same in-flight set (URLs and drop ids can
 * never collide); errors swallow silently; fire-and-forget — never blocks interaction.
 */
export function prefetchImageMedia(resolveUrl: () => Promise<string | null>): void {
  void resolveUrl()
    .then((url) => {
      if (!url || inFlightPrefetches.has(url)) return;
      inFlightPrefetches.add(url);
      imageWarmCount++;
      const img = new Image();
      img.decoding = 'async';
      const done = () => {
        inFlightPrefetches.delete(url);
      };
      img.onload = done;
      img.onerror = done; // a failed decode just means a normal load later
      img.src = url;
    })
    .catch(() => {
      /* resolve failure = normal cold load later */
    });
}

// ---- Round 112 — video hover prebuffer (web #235's prebuiltVideoUrl, desktop shape) --------
// All desktop videos stream through media:// (range-served, decrypted on demand by main), so
// unlike the web's data-URL videos there is nothing to pre-convert: the faithful port is a
// BEST-EFFORT head start. A settled hover starts an offscreen <video preload="auto"> so main
// has already served + decrypted the head ranges by click time; the GUARANTEED instant-open
// gain for videos lives in the card's shelf banking, not here. Fire-and-forget; the element
// releases its decoder + in-flight range requests on canplay/error/timeout. Done-markers are
// plain URL strings (no retained media), so the set needs no byte budget; a failed prebuffer
// just means a normal cold start later.

const prebufferDoneUrls = new Set<string>();
let prebufferCount = 0;
let imageWarmCount = 0;

/** Dev battery probe — round-112 legs (started prebuffers; image warm decodes). */
export function previewPrebufferCount(): number {
  return prebufferCount;
}

/** Dev battery probe — round-112 legs. */
export function previewImageWarmCount(): number {
  return imageWarmCount;
}

export function prebufferVideoMedia(resolveUrl: () => Promise<string | null>): void {
  void resolveUrl()
    .then((url) => {
      if (!url || prebufferDoneUrls.has(url) || inFlightPrefetches.has(`prebuffer:${url}`)) return;
      inFlightPrefetches.add(`prebuffer:${url}`);
      prebufferCount++;
      const video = document.createElement('video');
      video.preload = 'auto';
      video.muted = true;
      let timer = 0;
      const release = () => {
        video.removeEventListener('canplay', release);
        video.removeEventListener('error', release);
        window.clearTimeout(timer);
        video.removeAttribute('src'); // releases the decoder + in-flight range requests
        video.load();
        inFlightPrefetches.delete(`prebuffer:${url}`);
        prebufferDoneUrls.add(url);
      };
      timer = window.setTimeout(release, 10_000);
      video.addEventListener('canplay', release);
      video.addEventListener('error', release);
      video.src = url;
    })
    .catch(() => {
      /* resolve failure = normal cold start later */
    });
}
