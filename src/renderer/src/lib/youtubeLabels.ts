/**
 * Pure YouTube-label helpers — renderer port of the web's youtubeLabels.ts pure halves.
 * The backfill/agent machinery is intentionally absent: on desktop, titles arrive via imports
 * (or later, explicit online fetches); detection itself is fully offline.
 */

import type { Drop, YouTubeVideoLabel } from './types';

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function isPasswordCategories(categories: string[]): boolean {
  return categories.some((category) => category.trim().toLowerCase() === 'password');
}

// ---- link detection (web parity — same host set + VIDEO_ID_RE as the main-process copy) ----

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);
const YOUTUBE_TOKEN_RE = /(?<![\w.\-/])(?:https?:\/\/)?(?:[\w-]+\.)*(?:youtube\.com|youtu\.be)\/[^\s,;<>"']+/gi;

export function getYouTubeVideoId(value: string): string | null {
  const text = (value || '').trim();
  if (VIDEO_ID_RE.test(text)) return text;
  if (!text) return null;

  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (host === 'youtu.be') {
    const match = parsed.pathname.match(/^\/([A-Za-z0-9_-]{11})(?:\/|$)/);
    return match?.[1] || null;
  }
  if (!YOUTUBE_HOSTS.has(host)) return null;

  const queryId = parsed.searchParams.get('v');
  if (queryId && VIDEO_ID_RE.test(queryId)) return queryId;
  const pathMatch = parsed.pathname.match(/^\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{11})(?:\/|$)/);
  return pathMatch?.[1] || null;
}

export function extractYouTubeVideoIds(text: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const token of (text || '').match(YOUTUBE_TOKEN_RE) || []) {
    const videoId = getYouTubeVideoId(token);
    if (videoId && !seen.has(videoId)) {
      seen.add(videoId);
      ids.push(videoId);
    }
  }
  return ids;
}

function normalizeLabel(value: unknown): YouTubeVideoLabel | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const videoId = typeof candidate.videoId === 'string' ? candidate.videoId.trim() : '';
  const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
  const channelValue = candidate.channel;
  const channel = typeof channelValue === 'string' && channelValue.trim()
    ? channelValue.trim().slice(0, 200)
    : null;
  if (!VIDEO_ID_RE.test(videoId) || !title) return null;
  return { videoId, title: title.slice(0, 500), channel };
}

export function normalizeYoutubeLabels(value: unknown): YouTubeVideoLabel[] {
  if (!Array.isArray(value)) return [];
  const result: YouTubeVideoLabel[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const label = normalizeLabel(item);
    if (!label || seen.has(label.videoId)) continue;
    seen.add(label.videoId);
    result.push(label);
  }
  return result;
}

/**
 * Search-box matcher — the web's dropMatchesSearchQuery, extended for the desktop's
 * name + content + categories index (spec M2). Two modes:
 * - plain query → case-insensitive substring over name, first-64KB content and category names
 *   (the web matches name only; desktop searches the full offline index per LOCKED decision 10);
 * - '#'-prefixed → searches saved YouTube label titles + channels instead (name ignored).
 *   A bare '#' falls through to plain matching for the literal '#'.
 */
export function dropMatchesSearchQuery(
  drop: Pick<Drop, 'name' | 'content' | 'categories' | 'youtubeVideoLabels'>,
  rawQuery: string
): boolean {
  const query = rawQuery.toLowerCase();
  if (!query) return true;
  if (query.startsWith('#') && query.length > 1) {
    const term = query.slice(1);
    return (drop.youtubeVideoLabels ?? []).some(label =>
      label.title.toLowerCase().includes(term) ||
      (!!label.channel && label.channel.toLowerCase().includes(term))
    );
  }
  if (drop.name.toLowerCase().includes(query)) return true;
  if ((drop.content ?? '').toLowerCase().includes(query)) return true;
  return (drop.categories ?? []).some((c) => c.toLowerCase().includes(query));
}
