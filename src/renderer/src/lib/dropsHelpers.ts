/**
 * Pure drop helpers — faithful ports of the web's lib/drops.ts pure halves (display contract:
 * 'Forever' | 'Expired' | 'Xh Ym' | 'Ym'), plus the reminder tier logic and the editorial list
 * sort used by EditorialDropList. No Firebase anywhere.
 */

import type { Drop, ExpirationOption } from './types';

export function getExpirationDate(option: ExpirationOption): Date | null {
  if (option === 'forever') return null;
  const now = new Date();
  const hours = parseInt(option.replace('h', ''), 10);
  return new Date(now.getTime() + hours * 60 * 60 * 1000);
}

// ---- reminders (pure halves of isReminderFiredShared / isReminderGlowingForViewer) ----

export type ReminderUnit = 'minutes' | 'hours' | 'days';
export type ReminderPreset = '15m' | '30m' | '1h' | '2h' | 'custom';

/** Millisecond offset for a reminder — preset OR custom decimal value + unit (web parity). */
export function reminderOffsetMs(preset: ReminderPreset, customValue: string, customUnit: ReminderUnit): number {
  if (preset !== 'custom') {
    switch (preset) {
      case '15m': return 15 * 60 * 1000;
      case '30m': return 30 * 60 * 1000;
      case '1h': return 60 * 60 * 1000;
      case '2h': return 2 * 60 * 60 * 1000;
    }
    return 0;
  }
  const n = parseFloat(customValue);
  if (!isFinite(n)) return 0;
  const perUnit: Record<ReminderUnit, number> = {
    minutes: 60 * 1000,
    hours: 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000,
  };
  return n * perUnit[customUnit];
}

export function isReminderFiredShared(drop: Drop, now: Date): boolean {
  return (
    !!drop.reminderAt &&
    drop.reminderAt.getTime() <= now.getTime() &&
    !drop.reminderDismissedBy
  );
}

export function isReminderGlowingForViewer(
  drop: Drop,
  viewerUid: string | null | undefined,
  now: Date
): boolean {
  const fired = !!drop.reminderAt && drop.reminderAt.getTime() <= now.getTime();
  if (!fired) return false;
  const isCreator = !!viewerUid && viewerUid === drop.reminderSetByUid;
  if (isCreator) {
    return drop.reminderDismissedBy !== drop.reminderSetByUid;
  }
  return drop.reminderDismissedBy == null;
}

export function formatReminderFire(
  reminderAt: Date,
  now: Date
): { absolute: string; remaining: string | null; fired: boolean } {
  const diffMs = reminderAt.getTime() - now.getTime();
  return {
    absolute: formatFireAbsolute(reminderAt, now),
    remaining: diffMs <= 0 ? null : formatFireRemaining(diffMs),
    fired: diffMs <= 0,
  };
}

function formatFireAbsolute(at: Date, now: Date): string {
  const atMidnight = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayMs = 24 * 60 * 60 * 1000;
  const dayDiff = Math.round((atMidnight.getTime() - nowMidnight.getTime()) / dayMs);
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (dayDiff === 0) return `Today, ${time}`;
  if (dayDiff === 1) return `Tomorrow, ${time}`;
  const sameYear = at.getFullYear() === now.getFullYear();
  const datePart = at.toLocaleDateString(
    [],
    sameYear
      ? { weekday: 'short', month: 'short', day: 'numeric' }
      : { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }
  );
  return `${datePart}, ${time}`;
}

function formatFireRemaining(ms: number): string {
  const totalMinutes = Math.floor(ms / (60 * 1000));
  if (totalMinutes < 1) return 'in <1m';
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 && days === 0) parts.push(`${minutes}m`);
  return `in ${parts.length > 0 ? parts.join(' ') : '<1m'}`;
}

// ---- display helpers ----

// Render-as-text matrix shared by the preview modal and the FIX 18 save-path cache prime:
// text drops always, plus file drops whose mime/extension is textual.
export function isTextFileDrop(drop: Pick<Drop, 'type' | 'mimeType' | 'name'>): boolean {
  if (drop.type === 'text') return true;
  const textMimeTypes = ['text/', 'application/json', 'application/xml'];
  const textExtensions = ['.txt', '.md', '.json', '.csv', '.xml', '.html', '.css', '.js', '.ts', '.jsx', '.tsx'];
  return textMimeTypes.some(t => drop.mimeType?.startsWith(t)) ||
         textExtensions.some(ext => drop.name.toLowerCase().endsWith(ext));
}

/**
 * FIX 20 — the ONE shared drawing-media resolver: which payload slot holds a drawing's PNG.
 * Slot truth first (DTO flags sourced from blobRefs): an empty FILE slot with a populated
 * IMAGE slot (the web-import shape) resolves to 'image'; everything else — locally drawn
 * drops, legacy DTOs without flags — keeps the historical file-slot behavior unchanged.
 */
export function drawingMediaKind(
  drop: Pick<Drop, 'isDrawing' | 'hasFilePayload' | 'hasImagePayload'>
): 'file' | 'image' {
  if (drop.hasFilePayload === false && drop.hasImagePayload === true) return 'image';
  return 'file';
}

export function getYouTubeVideoId(text: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function getTimeRemaining(expiresAt: Date | null): string {
  if (!expiresAt) return 'Forever';
  const now = new Date();
  const diff = expiresAt.getTime() - now.getTime();
  if (diff <= 0) return 'Expired';
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

// ---- editorial list sorting (port of the DropList helpers) ----

export type DropSortMode = 'newest' | 'manual' | 'name' | 'size' | 'expiry';

function dropSizeValue(d: Drop): number {
  if (d.type === 'file') return d.fileSize ?? -1;
  if (d.type === 'text') return d.content?.length ?? -1;
  return -1;
}

function dropExpiryRank(d: Drop): number {
  return d.expiresAt ? d.expiresAt.getTime() : Number.MAX_SAFE_INTEGER;
}

/** Sort the UNPINNED drops for a mode. Pinned drops are kept on top separately. */
export function sortUnpinned(drops: Drop[], mode: DropSortMode, manualOrder: string[]): Drop[] {
  if (mode === 'manual') {
    const orderSet = new Set(manualOrder);
    const known = manualOrder
      .map((id) => drops.find((d) => d.id === id))
      .filter((d): d is Drop => Boolean(d));
    const unknown = drops
      .filter((d) => !orderSet.has(d.id))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return [...unknown, ...known];
  }
  return [...drops].sort((a, b) => {
    switch (mode) {
      case 'newest':
        return b.createdAt.getTime() - a.createdAt.getTime();
      case 'name':
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      case 'size':
        return dropSizeValue(b) - dropSizeValue(a);
      case 'expiry':
        return dropExpiryRank(a) - dropExpiryRank(b);
      default:
        return 0;
    }
  });
}
