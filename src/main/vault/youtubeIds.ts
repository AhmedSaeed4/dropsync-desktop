/**
 * Main-process YouTube link detection — verbatim port of the web's youtubeLabels.ts pure
 * detection halves (same host set, same VIDEO_ID_RE, same token scan). The renderer has its own
 * copy for display matching; this one backs youtube:refreshTitles so the network-touching code
 * never depends on renderer modules.
 */

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
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

export function isPasswordCategoryList(categories: string[]): boolean {
  return categories.some((category) => category.trim().toLowerCase() === 'password');
}
