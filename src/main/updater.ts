// Round 118 — in-app updates, manual mode (owner lock 2026-10-04: user clicks every step;
// nothing downloads or installs on its own). All updater network lives HERE in the main
// process — the renderer stays zero-network (the youtube titles/thumbnails family).
// Feed: packaged builds read resources/app-update.yml (electron-builder publish block);
// DROPSYNC_UPDATE_FEED overrides it (battery + hands-on kit, generic provider); dev boots
// without either are DISABLED — check() reports disabled and the UI stays silent.
import { app, net } from 'electron';
import { createRequire } from 'node:module';
// electron-updater is CommonJS-only ("main": "out/main.js", no "type") and out/main is
// ESM — Node rejects named ESM imports of it at runtime, so require it through
// createRequire; the cast keeps full typing via the package's own d.ts.
const { autoUpdater, CancellationToken } =
  createRequire(import.meta.url)('electron-updater') as typeof import('electron-updater');

export interface UpdateCheckResultDTO {
  currentVersion: string;
  available: boolean;
  version: string | null;
  disabled: boolean;
}
export interface UpdateNotesDTO {
  notes: string | null;
  url: string;
}
export interface UpdateProgressDTO {
  state: 'downloading' | 'done' | 'cancelled' | 'error';
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

const GITHUB_LATEST_API = 'https://api.github.com/repos/AhmedSaeed4/dropsync-desktop/releases/latest';
const RELEASES_PAGE = 'https://github.com/AhmedSaeed4/dropsync-desktop/releases/latest';

let progressSink: ((p: UpdateProgressDTO) => void) | null = null;
let cancelToken: InstanceType<typeof CancellationToken> | null = null; // value import (stop-5)
let notesCache: UpdateNotesDTO | null = null;

function feedEnabled(): boolean {
  const override = process.env.DROPSYNC_UPDATE_FEED;
  if (override) {
    // Dev gate (AppUpdater.js:278 — isUpdaterActive = isPackaged || forceDevUpdateConfig):
    // without this flag a dev check silently resolves null. setFeedURL builds the provider
    // directly (AppUpdater.js:234) — no dev-app-update.yml is read on this path.
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.setFeedURL({ provider: 'generic', url: override });
    return true;
  }
  return app.isPackaged;
}

/** a.b.c compare — our versions are plain triads; returns true only when `next` > `cur`. */
function versionGreater(next: string, cur: string): boolean {
  const p = (v: string): number[] => v.trim().replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const [a1, b1, c1] = p(next);
  const [a2, b2, c2] = p(cur);
  if (a1 !== a2) return a1 > a2;
  if (b1 !== b2) return b1 > b2;
  return c1 > c2;
}

export function wireUpdater(onProgress: (p: UpdateProgressDTO) => void): void {
  progressSink = onProgress;
  autoUpdater.autoDownload = false;      // manual mode — download only when the user clicks
  autoUpdater.autoInstallOnAppQuit = false; // install only on the explicit Update-&-restart click
  autoUpdater.allowPrerelease = false;
  autoUpdater.on('download-progress', (i) => {
    progressSink?.({
      state: 'downloading',
      percent: i.percent,
      transferred: i.transferred,
      total: i.total,
      bytesPerSecond: i.bytesPerSecond,
    });
  });
  autoUpdater.on('update-downloaded', () => {
    progressSink?.({ state: 'done', percent: 100, transferred: 0, total: 0, bytesPerSecond: 0 });
  });
}

export async function checkForUpdate(): Promise<UpdateCheckResultDTO> {
  const currentVersion = app.getVersion();
  if (!feedEnabled()) {
    return { currentVersion, available: false, version: null, disabled: true };
  }
  try {
    const r = await autoUpdater.checkForUpdates();
    const version = r?.updateInfo?.version ?? null;
    const available = version !== null && versionGreater(version, currentVersion);
    console.log(`[update] check ${available ? 'available' : 'current'} ${version ?? '-'} (running ${currentVersion})`);
    return { currentVersion, available, version, disabled: false };
  } catch {
    // Offline, unreachable, or no feed published yet — silent by design (owner decision 2).
    return { currentVersion, available: false, version: null, disabled: false };
  }
}

export async function downloadUpdate(): Promise<boolean> {
  if (!feedEnabled()) return false;
  cancelToken = new CancellationToken();
  try {
    await autoUpdater.downloadUpdate(cancelToken);
    return true;
  } catch (err) {
    if (cancelToken.cancelled) { // property getter (cancellationToken.js:6)
      progressSink?.({ state: 'cancelled', percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 });
    } else {
      console.log('[update] download failed:', err instanceof Error ? err.message : String(err));
      progressSink?.({ state: 'error', percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 });
    }
    return false;
  }
}

export function cancelUpdate(): boolean {
  cancelToken?.cancel();
  return true;
}

export function installUpdate(): boolean {
  // Battery guard: quitAndInstall would really quit + run the stub installer — the
  // DROPSYNC_F118 leg proves the gate fires without killing the app (DROPSYNC_F116 pattern).
  if (process.env.DROPSYNC_F118 === '1') {
    console.log('[update] install requested (battery mock: quitAndInstall skipped)');
    return true;
  }
  console.log('[update] install requested — quitting to install');
  autoUpdater.quitAndInstall(true, true);
  return true;
}

export async function fetchUpdateNotes(): Promise<UpdateNotesDTO> {
  if (notesCache) return notesCache;
  const envNotes = process.env.DROPSYNC_UPDATE_NOTES;
  if (envNotes !== undefined) {
    notesCache = { notes: envNotes, url: process.env.DROPSYNC_UPDATE_PAGE ?? RELEASES_PAGE };
    return notesCache;
  }
  try {
    // The GitHub API REQUIRES a User-Agent header; no session option (net.fetch lesson §6.4).
    const res = await net.fetch(GITHUB_LATEST_API, {
      headers: { 'User-Agent': 'DropSync-Desktop', Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(String(res.status));
    const j = (await res.json()) as { body?: unknown; html_url?: unknown };
    notesCache = {
      notes: typeof j.body === 'string' ? j.body : null,
      url: typeof j.html_url === 'string' ? j.html_url : RELEASES_PAGE,
    };
  } catch {
    notesCache = { notes: null, url: RELEASES_PAGE }; // modal still works; link always shown
  }
  return notesCache;
}
