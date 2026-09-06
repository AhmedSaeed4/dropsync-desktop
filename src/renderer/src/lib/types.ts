/** Renderer-side Drop/Category/Workspace types — mirrors the web app's shapes (Date fields) so
 * the ported Editorial components keep their exact signatures. The store adapter converts the
 * IPC DTOs (ISO strings) into these. */

export type ExpirationOption = '1h' | '2h' | '4h' | '6h' | '24h' | 'forever';

export interface YouTubeVideoLabel {
  videoId: string;
  title: string;
  channel: string | null;
}

export interface Drop {
  id: string;
  userId: string;
  type: 'file' | 'text';
  name: string;
  content?: string; // filled lazily by the payload fetch
  fileSize?: number;
  mimeType?: string;
  createdAt: Date;
  expiresAt: Date | null;
  expirationOption?: ExpirationOption;
  workspaceId: string | null;
  encrypted?: boolean;
  imageUrl?: string; // media:// URL for the attached image, set by the adapter on demand
  imageSize?: number;
  imageMimeType?: string;
  imageData?: string; // unused on desktop (kept for component compatibility)
  imageIv?: string;
  fileData?: string; // unused on desktop — binary payloads stream via media:// URLs
  fileUrl?: string; // media:// URL for the file payload, set by the adapter on demand
  r2Key?: string;
  category?: string;
  categories?: string[];
  creatorName?: string;
  pinned?: boolean;
  isDrawing?: boolean;
  locked?: boolean;
  reminderAt?: Date | null;
  reminderSetByUid?: string | null;
  reminderDismissedBy?: string | null;
  fileFormat?: 'binary';
  importedFromArchiveId?: string;
  youtubeVideoLabels?: YouTubeVideoLabel[];
  /** FIX 20 slot truth — which payload slots the drop actually has (absent ⇒ assume legacy). */
  hasFilePayload?: boolean;
  hasImagePayload?: boolean;
  /** FIX 20 — manifest Excalidraw scene for imported drawings (zero-fetch editor path). */
  drawingScene?: unknown;
  /** #28 — content fingerprint (stamped at write time; lets a list card notice its
   *  content changed and re-read just itself). Mirrors the DTO's map. */
  contentSha256s?: { content?: string; file?: string; image?: string };
}

export interface Category {
  id: string;
  name: string;
  workspaceId: string | null;
  createdBy: string;
  createdAt: Date;
}

export interface Workspace {
  id: string;
  name: string;
  ownerId: string;
  members: string[];
  inviteCode: string;
  createdAt: Date;
}

export const LOCAL_USER_ID = 'local';

/** Convert an IPC DropDTO into the web-shaped Drop (Dates restored). */
import type { DropDTO } from '../../../preload/apiTypes';

export function dropDtoToDrop(dto: DropDTO): Drop {
  return {
    id: dto.id,
    userId: LOCAL_USER_ID,
    type: dto.type,
    name: dto.name,
    categories: dto.categories,
    category: dto.categories.length === 1 ? dto.categories[0] : undefined,
    pinned: dto.pinned,
    locked: dto.locked,
    isDrawing: dto.isDrawing,
    createdAt: new Date(dto.createdAt),
    expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
    expirationOption: dto.expirationOption,
    workspaceId: dto.workspaceId,
    reminderAt: dto.reminderAt ? new Date(dto.reminderAt) : null,
    reminderSetByUid: dto.reminderSetByUid ?? null,
    reminderDismissedBy: dto.reminderDismissedBy ?? null,
    fileSize: dto.fileSize,
    mimeType: dto.mimeType,
    imageSize: dto.imageSize,
    imageMimeType: dto.imageMimeType,
    creatorName: dto.creatorName,
    youtubeVideoLabels: dto.youtubeVideoLabels,
    importedFromArchiveId: dto.importedFromArchiveId,
    hasFilePayload: dto.hasFilePayload,
    hasImagePayload: dto.hasImagePayload,
    drawingScene: dto.drawingScene,
    contentSha256s: dto.contentSha256s,
    encrypted: false,
  };
}
