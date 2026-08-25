/**
 * Pure YouTube-label helpers — main-process port of the web's youtubeLabels.ts pure halves.
 * The Firestore/backfill machinery is intentionally absent (desktop has no accounts, no agent).
 */

import type { YouTubeVideoLabel } from './vaultTypes.ts';

export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

export function isPasswordCategories(categories: string[]): boolean {
  return categories.some((category) => category.trim().toLowerCase() === 'password');
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

/** The web UI's simple link detector (drops.ts version) — used for badge/link rendering. */
export function getYouTubeVideoIdSimple(text: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}
