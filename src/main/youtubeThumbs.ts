/**
 * Round 114 (#32) — YouTube thumbnails for the Local drop list (fetch-once-then-cache).
 *
 * LOCKED owner decision (repair-order-114 §3.4): the MAIN process fetches; the renderer stays
 * zero-network; the CSP (src/renderer/index.html img-src) is untouched — the card receives a
 * `data:` URL, which the existing allowlist already permits (screen-share-picker precedent,
 * cloud.ts main-built PNG data URLs). Family precedent: "titles online, thumbnails online" —
 * this module mirrors the proven keyless-CDN pattern of refreshYouTubeTitles
 * (dropOps.ts:832–885): Electron's net online gate via the `opts.online` seam, a 5 s
 * AbortController timeout in the fetchJsonWithTimeout shape (dropOps.ts:810–822), silent
 * null on offline/dead/error — never a throw into the IPC bridge.
 *
 * Cache tiers, in serve order (114-HOTFIX-1): memory → negative → disk → online-gated network
 * fetch. In-memory Map of data URLs (LRU ≤600, Map insertion order = age) → negative cache for
 * 404-only (10-minute session TTL; a dead video stays dead, a transient outage never poisons)
 * → disk cache <userData>/yt-thumbs/<videoId>.jpg (public CDN bytes — what any browser caches;
 * never vault content), which serves EVEN OFFLINE — a fetched-once thumbnail survives an app
 * restart and an offline machine (owner-locked parent §3.2) → the online gate guards only the
 * NETWORK fetch on a disk miss. DROPSYNC_YT_THUMB_BASE overrides the CDN host — a
 * DEV battery seam ONLY; absent in normal/packaged runs → the real i.ytimg.com.
 */

import { app, net } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_THUMB_BASE = 'https://i.ytimg.com';
const FETCH_TIMEOUT_MS = 5_000;
const NEGATIVE_TTL_MS = 10 * 60 * 1_000;
const MEMORY_CACHE_MAX = 600;

const memoryCache = new Map<string, string>();
const negativeCache = new Map<string, number>();
const inFlight = new Map<string, Promise<string | null>>();
let diskDirReady = false;

const toJpegDataUrl = (bytes: Buffer): string => `data:image/jpeg;base64,${bytes.toString('base64')}`;

const trimMemoryCache = (): void => {
  while (memoryCache.size > MEMORY_CACHE_MAX) {
    const oldest = memoryCache.keys().next().value;
    if (oldest === undefined) break;
    memoryCache.delete(oldest);
  }
};

async function fetchAndCache(videoId: string, opts: { online?: boolean }): Promise<string | null> {
  try {
    // Disk cache tier: any fs error = miss. 114-HOTFIX-1: this read runs BEFORE the online
    // gate, so a fetched-once thumbnail serves EVEN OFFLINE after an app restart (owner-locked
    // parent §3.2: "internet needed once per video, then it's permanent on your machine") and
    // the disk tier also survives an unreachable CDN while isOnline() is true.
    const diskPath = join(app.getPath('userData'), 'yt-thumbs', `${videoId}.jpg`);
    try {
      const bytes = await readFile(diskPath);
      const dataUrl = toJpegDataUrl(bytes);
      memoryCache.set(videoId, dataUrl);
      trimMemoryCache();
      return dataUrl;
    } catch {
      /* miss — fall through to the online gate + network fetch */
    }

    // Online gate — reached ONLY on a disk miss, so it guards the NETWORK fetch and never the
    // disk tier: offline returns null with NO negative entry and NO fetch, keeping a
    // first-seen-offline card re-fetchable on its next mount.
    if ((opts.online ?? net.isOnline()) === false) return null;

    const base = process.env.DROPSYNC_YT_THUMB_BASE || DEFAULT_THUMB_BASE;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${base}/vi/${videoId}/mqdefault.jpg`, { signal: controller.signal });
      if (res.status === 404) {
        // ONLY 404 may enter the negative cache — a dead video stays dead within the TTL.
        negativeCache.set(videoId, Date.now());
        return null;
      }
      if (!res.ok) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      const dataUrl = toJpegDataUrl(bytes);
      try {
        if (!diskDirReady) {
          await mkdir(join(app.getPath('userData'), 'yt-thumbs'), { recursive: true });
          diskDirReady = true;
        }
        await writeFile(diskPath, bytes);
      } catch {
        /* thumbnails are re-fetchable — every disk error is swallowed */
      }
      memoryCache.set(videoId, dataUrl); // Map insertion order = age; trim keeps ≤600
      trimMemoryCache();
      return dataUrl;
    } catch {
      // Timeout (abort) or network error — null, NO negative entry (a transient outage must
      // never poison the session).
      return null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/**
 * Fetch-once-then-cache thumbnail for a YouTube video id. NEVER throws — resolves null for
 * invalid ids, offline, dead (404, negative-cached 10 min), and every transient error.
 * Concurrent asks for one id share a single in-flight fetch.
 */
export async function getYouTubeThumbnail(videoId: string, opts: { online?: boolean } = {}): Promise<string | null> {
  try {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
    const mem = memoryCache.get(videoId);
    if (mem) return mem;
    const neg = negativeCache.get(videoId);
    if (neg !== undefined) {
      if (Date.now() - neg < NEGATIVE_TTL_MS) return null;
      negativeCache.delete(videoId); // TTL expired — try again
    }
    const pending = inFlight.get(videoId);
    if (pending) return pending;
    const task = fetchAndCache(videoId, opts);
    inFlight.set(videoId, task);
    try {
      return await task;
    } finally {
      inFlight.delete(videoId);
    }
  } catch {
    return null;
  }
}

/** Battery-only (DROPSYNC_F114): clear the in-memory, negative, and in-flight maps — honestly named; disk cache untouched. */
export function testResetYouTubeThumbMemoryCaches(): void {
  memoryCache.clear();
  negativeCache.clear();
  inFlight.clear();
}
