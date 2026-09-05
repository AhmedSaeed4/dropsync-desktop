/**
 * Electron main process — window, privileged IPC, media:// streaming protocol.
 *
 * Security posture (locked by spec): contextIsolation true, nodeIntegration false, sandbox true;
 * every capability sits behind contextBridge 'dropsync' in the preload. Crypto and vault state
 * live ONLY here. Big bytes stream disk↔main; the renderer receives DTOs, text payloads it asks
 * for, and opaque media:// tokens.
 */

import { app, BrowserWindow, ipcMain, dialog, Menu, nativeImage, nativeTheme, Notification, protocol, session, shell, net } from 'electron';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';import { createWriteStream, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import { VaultManager } from './vault/vault.ts';
// Round 107 battery (§8.3) — the f_t107_* legs read REAL records main-side; the ride-keys
// helper types its parameter with the record type itself.
import type { VaultDropRecord } from './vault/vaultTypes.ts';
import { initCloud, attachCloudResizeTracking, PILL_TOP, PILL_W, PILL_H, PILL_B_REST_W, PILL_BLOOM_PAD_X, PILL_BLOOM_PAD_Y, PILL_A_ROOM_PAD_X, CLOUD_ORIGIN, CAPTURE_DEADLINE_MS, ENTRY_CONNECT_TIMEOUT_MS, STATUS_TOP, STATUS_H, CLOUD_URL, type CloudController } from './cloud';
import { inspectArchive, importArchive, recoverInterruptedImport, desktopTypeMismatchMessage, type ImportDestination } from './vault/importer.ts';
import { exportSpaceArchive } from './vault/exporter.ts';
import {
  createTextDrop,
  createFileDropFromPath,
  createFileDropFromBytes,
  updateTextDropContent,
  updateTextDropMeta,
  refreshYouTubeTitles,
  transferDrops,
  type CreateTextArgs,
  type CreateMetaBase,
  type UpdateContentArgs,
  type UpdateMetaPatch,
} from './vault/dropOps.ts';

// Media scheme must be registered as privileged BEFORE app ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, stream: true, supportFetchAPI: true, secure: true } },
]);

// WSL-ONLY WORKAROUND (PACKAGING-1 FIX B): hardware acceleration hard-crashes under WSL2's
// virtual GPU ("GPU process isn't usable"), so dev-under-WSL runs software-rendered. The old
// UNCONDITIONAL call — "GPU compositing buys nothing here… keeps behavior identical" — was a
// dev-era rationalization: production Windows runs GPU-accelerated, and the animation-heavy UI
// plus video calls need it. Every WSL2 session has WSL_DISTRO_NAME; Windows never does.
if (process.env.WSL_DISTRO_NAME) {
  app.disableHardwareAcceleration();
}

// DEV WORKAROUND (WSL only): the new WSL2 kernel intermittently kills Chromium's sandboxed
// children (network service → zygote → GPU), FATALing the app minutes into use. Running the
// desktop dev app unsandboxed avoids it entirely. Production Windows builds are unaffected.
if (process.env.DROPSYNC_NOSANDBOX === '1') {
  app.commandLine.appendSwitch('no-sandbox');
}

// WSL-ONLY WORKAROUND (PACKAGING-1 FIX B): WSL2 kernel 6.18 intermittently fails Chromium's
// /dev/shm shared-memory operations with nonsensical ESRCH errors (taking sandboxed children
// down with them), FATALing the app minutes into use. disable-dev-shm-usage makes Chromium back
// shared memory with plain temp files instead of /dev/shm. The old call was UNCONDITIONAL — its
// "Production Windows builds are unaffected" comment described the HOP, not the code. Gated now;
// production Windows keeps real shared memory under the SAME WSL_DISTRO_NAME gate as FIX B's
// acceleration line (one condition for both, so they can never drift apart).
if (process.env.WSL_DISTRO_NAME) {
  app.commandLine.appendSwitch('disable-dev-shm-usage');
}

// Dev-only CDP endpoint so headless/WSL sessions can verify the renderer booted cleanly.
// Must be appended at module scope (before app ready) to take effect.
if (process.env.ELECTRON_RENDERER_URL) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
}

const manager = new VaultManager();

// Windows toasts must identify as DropSync (spec M6) — set once, before any Notification.
app.setAppUserModelId('com.dropsync.desktop');

let mainWindow: BrowserWindow | null = null;
/** C1 — cloud-mode controller (created with the window; mode:* handlers below drive it). */
let cloudCtl: CloudController | null = null;
// C2j — module-level handle on the EXACT notifier function the vault engine uses (assigned at
// the manager.setNotifier site) so the DEV battery can drive synthetic reminder fires through
// the SAME seam (no second engine invented).
let engineNotifier: ((title: string, body: string) => void) | null = null;
// C2k — the card dresses in the app's CURRENT theme at display time. Module level so BOTH
// consumers see it: the engine LEG 2 route (whenReady scope) and the createWindow focus hook.
// Reminders only fire while the vault is unlocked (getSettings is assertUnlocked-guarded), so
// the try/catch only covers the crack.
const currentTheme = (): 'light' | 'dark' | 'minimal' => {
  try { return manager.getSettings().theme; } catch { return 'light'; }
};
// PACKAGING-1 FIX A — the window shell follows the app's theme (owner decision §3.4): the
// frame stays NATIVE (never frame:false / titleBarStyle) but Windows tints it from
// nativeTheme. The app theme maps onto themeSource (dark → 'dark'; light/minimal → 'light') —
// minimal is a light-family theme — assigned ONLY when the value would change (idempotent;
// themeSource is app-global). Wired at every seam where the main process learns the theme:
// the vault:settingsSet write path, app boot, vault:unlock, and the pre-unlock localStorage
// fallback in createWindow.
const applyFrameTheme = (theme: 'light' | 'dark' | 'minimal'): void => {
  const source: 'dark' | 'light' = theme === 'dark' ? 'dark' : 'light';
  if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source;
};

// 1.0.5 FIX B — THE YOUTUBE REFERER STAMP. A file:// page (the packaged renderer's origin)
// has no web origin and cannot send a Referer header — and YouTube's embedded player REQUIRES
// one (their embed terms, documented Dec 2025): every Local Play mounted
// https://www.youtube-nocookie.com/embed/<id> and died inside the iframe with "Video player
// configuration error — Error 153". Probe-proven on the owner's real Windows with THIS app's
// exact Electron (43.4.1 win32-x64, planner probe 2026-09-01): the SAME embed plays from an
// http://127.0.0.1 page, errors 153 from file://, and errors 153 again from the http page with
// <meta name="referrer" content="no-referrer"> — the header is the whole mechanism. The stamp
// is the probe's cure: main-process onBeforeSendHeaders stamping Referer:
// https://drag-drop-app.vercel.app/ (the web app's own origin, where the same embed
// legitimately runs) on the two YouTube embed hosts. Evidence: desktop-docs/frames/yt153_probe_referer_stamp_fix.png
// (stamped ⇒ plays) vs desktop-docs/frames/yt153_probe_noreferrer_control.png (no Referer ⇒
// 153). DEFAULT session ONLY — Cloud embeds run on the site's own https origin and already
// work (owner-verified); the cloud PARTITION session must never get this.
const YT_EMBED_REFERER = 'https://drag-drop-app.vercel.app/';
const YT_EMBED_URL_FILTER = ['https://www.youtube-nocookie.com/*', 'https://www.youtube.com/*'];
// urlFilter/label are DEV-test seams ONLY (f_105_refererStampApplied drives this same function
// against a throwaway session + a dev-server-origin filter); the production boot call below
// passes neither — the defaults ARE the shipped behavior.
const attachYouTubeRefererStamp = (
  ses: Electron.Session,
  urlFilter: string[] = YT_EMBED_URL_FILTER,
  label = 'default session',
): void => {
  ses.webRequest.onBeforeSendHeaders({ urls: urlFilter }, (details, callback) => {
    details.requestHeaders['Referer'] = YT_EMBED_REFERER;
    callback({ requestHeaders: details.requestHeaders });
  });
  console.log('[referer-stamp] attached (' + label + ')');
};
// f_105_refererStampAttached — DEV-only stdout tap (DROPSYNC_CLOUD_DEV), installed at module
// scope so it is live BEFORE whenReady attaches the stamp: the battery leg asserts the LITERAL
// `[referer-stamp] attached` boot line was printed, so the lines are captured, never replayed.
// Production (env absent) never taps anything.
const f105BootLines: string[] = [];
if (process.env.DROPSYNC_CLOUD_DEV === '1') {
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    if (typeof chunk === 'string' && chunk.includes('[referer-stamp] attached')) f105BootLines.push(chunk);
    return (origStdoutWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
}

let appMode: 'cloud' | 'local' = 'local'; // relaunch always starts Local in C1 (remember-last-mode = C2)
/** Assigned by registerIpc — shared by mode:set and the DEV probe's switch storm. */
let applyCloudMode: (next: 'cloud' | 'local') => Promise<'cloud' | 'local'> = async () => appMode;
let pillFlipRelayCount = 0; // C2g-hotfix-1 §5 — receipts of REAL pill:flip ipc (incremented in the relay)
/** C2m — USER-FLIP ARM for the flip dissolve: the pill:flip ipc handler stamps this; applyMode
 * melts iff Date.now() - transitionArmedAt < 10 s (the flag self-expires, so a cancelled
 * unsaved-guard leaves nothing behind). Boot-into-last-mode, dev probes, battery storms and
 * every programmatic applyMode NEVER arm it — they stay instant. One-shot: applyMode clears
 * it on read. The DEV battery writes it directly to simulate the pill path's arm step. */
let transitionArmedAt = 0;
/** PAC-3 FIX A — the per-USER-flip melt diagnostic (ONE line, prod-safe). performance.now()
 * deltas of every phase the main process owns: capture (outgoing-world snapshot), ready (the
 * page's decode + two-rAF submission ack), pad (the MELT_SWAP_PAD_MS tail inside beginMelt),
 * swapToDone (swap ⇒ the melt settles). Stamps ride the EXISTING fader:ready/fader:done ipc
 * handlers — no new channels, no behavior change. The line prints when the melt settles
 * (fader:done), at once when no melt ran (fail-open instant flip), or when the NEXT melt
 * supersedes a still-unsettled one (swapToDoneMs=-1) — every USER flip gets exactly one line.
 * This is the owner's Windows tuning data (the investigation's §9 hands-on). */
let meltDiagReadyAt = -1; // fader:ready arrival for the CURRENT melt (performance.now())
let meltDiagPending: {
  armed: boolean;
  captureMs: number;
  readyMs: number;
  padMs: number;
  tSwap: number;
} | null = null;
const printMeltDiag = (
  d: { armed: boolean; captureMs: number; readyMs: number; padMs: number },
  swapToDoneMs: number,
): void => {
  console.log(`[melt] armed=${d.armed} captureMs=${d.captureMs.toFixed(1)} readyMs=${d.readyMs.toFixed(1)}`
    + ` padMs=${d.padMs.toFixed(1)} swapToDoneMs=${swapToDoneMs.toFixed(1)}`);
};
/** DEV-only: the C1/C2 battery reloads the renderer (memory test) — this guard keeps its
 * did-finish-load handler from re-triggering the whole sequence on every reload. */
let cloudDevBatteryStarted = false;

function createWindow(): void {
  mainWindow = new BrowserWindow({    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#FAF7F2',
    title: 'DropSync',
    webPreferences: {
      preload: join(fileURLToPath(new URL('.', import.meta.url)), '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  // C1: cloud view lifecycle + C2f generalized bounds tracking (resize/maximize/full-screen/move).
  // C2h FIX 3 — cloud-view gestures feed the SAME idle-auto-lock clock (owner decision D-B):
  // the controller senses raw inputs from OUTSIDE the page and calls manager.touch() here.
  // Safe by closure: manager is the module-level singleton (:63) outliving any view swap.
  cloudCtl = initCloud(mainWindow, { onUserActivity: () => manager.touch(), currentTheme });
  attachCloudResizeTracking(mainWindow, cloudCtl);
  // C2j LEG 3 — missed reminders greet the owner when the window becomes front-and-center
  // again: drain oldest-first, OVERLAY only (native already shown once at fire time); the
  // serial card pump provides the ≥NEXT_GAP_MS spacing between the greeting cards.
  // C2k — each drained card is dressed at flush time in the CURRENT theme.
  mainWindow.on('focus', () => { cloudCtl?.drainMissed(currentTheme()); });
  // C2f FIX 2 — the pill must show the app's ACTUAL boot mode (relaunch starts Local; the
  // renderer's boot-into-last-mode may immediately flip it via mode:set). Queued until the
  // pill layer finishes loading; delivered automatically.
  cloudCtl.setPillMode(appMode);
  // Polish sweep #1: the window title is ALWAYS "DropSync" — renderer document.title changes
  // (dev overlays, hash routes) are ignored.
  mainWindow.on('page-title-updated', (event) => event.preventDefault());
  // PACKAGING-1 FIX A — pre-unlock shell theme. getSettings is assertUnlocked-guarded, so a
  // locked boot starts themeSource 'light'. The renderer ALREADY mirrors the last user-chosen
  // theme into localStorage ('dropsync.theme' — its THEME_CACHE_KEY, written by setTheme,
  // vault.tsx) precisely so the unlock/first-run screens render in it before vault settings
  // exist; the shell reads the SAME source, ONLY while the vault is still locked (after
  // unlock the real settings own the shell via the vault:unlock and vault:settingsSet seams).
  // Normalization mirrors the renderer's cachedTheme(). Fires once per main-window load;
  // applyFrameTheme is idempotent, so reloads are free. (Found by the PACKAGING-1 order's
  // "if you find a pre-unlock theme source the renderer already uses, wire from THAT" clause.)
  mainWindow.webContents.on('did-finish-load', () => {
    if (manager.status().state === 'unlocked') return; // real settings own the shell now
    void mainWindow?.webContents
      .executeJavaScript(`(() => { try { return localStorage.getItem('dropsync.theme'); } catch { return null; } })()`)
      .then((cached) => {
        if (typeof cached === 'string') {
          applyFrameTheme(cached === 'dark' ? 'dark' : cached === 'minimal' ? 'minimal' : 'light');
        }
      })
      .catch(() => { /* pre-unlock best-effort only — the shell keeps its boot theme */ });
  });
  // Dev-only boot probe: proves the contextBridge landed and React mounted.
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.webContents.on('console-message', (_event, _level, message) => {
      if (process.env.DROPSYNC_E2E_S2 === '1' || process.env.DROPSYNC_SIT3_DOMCHECKS === '1'
        || process.env.DROPSYNC_CLOUD_DEV === '1') console.log('[renderer-console]', message);
    });
    mainWindow.webContents.on('did-finish-load', () => {
      void mainWindow?.webContents
        .executeJavaScript(
          'JSON.stringify({ hasBridge: !!window.dropsync, rootChildren: document.getElementById("root")?.children.length ?? 0 })'
        )
        .then((report) => console.log('[boot-probe]', report))
        .catch((error) => console.error('[boot-probe] failed:', error));

      // DROPSYNC_E2E=1 → scripted end-to-end pass over the REAL IPC bridge inside this running
      // window: prepare → create → wrong-password check → import → read back → Save-As path
      // resolution (without the native dialog). No native dialogs are touched.
      if (process.env.DROPSYNC_E2E === '1') {
        const e2e = `
(async () => {
  const results = {};
  const step = async (name, fn) => {
    try { results[name] = await fn(); }
    catch (e) { results[name] = 'ERROR: ' + (e && e.message ? e.message : String(e)); }
  };
  const folder = '/tmp/ds-e2e-vault-' + Math.floor(Math.random() * 1e9);
  // Round-5 harness fix: prepareFolder requires an EXISTING directory (stat guard), so probe
  // hasVault against a real folder that holds no vault instead of a never-created path.
  await step('prepare', async () => (await dropsync.vault.prepareFolder('/tmp/opencode/e2e')).hasVault === false);
  await step('create', async () => { await dropsync.vault.create(folder, 'e2e-vault-pw-1'); return true; });
  await step('wrongPwRejected', async () => {
    try { await dropsync.vault.unlock(folder, 'totally-wrong'); return false; }
    catch (e) { return e.message === 'The vault password is wrong, or the vault is damaged.'; }
  });
  await step('unlock', async () => { await dropsync.vault.unlock(folder, 'e2e-vault-pw-1'); return true; });
  let archiveId = '';
  await step('inspect', async () => {
    const insp = await dropsync.vault.importInspect('/tmp/ds-test-archives/personal-test.dropsync', 'test-archive-pw');
    archiveId = insp.archiveId;
    return insp.dropCount === 5 && insp.fileCount === 1;
  });
  await step('import', async () => {
    const r = await dropsync.vault.importRun({
      filePath: '/tmp/ds-test-archives/personal-test.dropsync',
      password: 'test-archive-pw',
      destination: { mode: 'personal' },
    });
    return r.importedCount === 5 && r.legacyExpiryFallbackCount === 1 && r.zeroRemainingCount === 1;
  });
  await step('duplicateOverlap', async () => await dropsync.vault.hasArchiveOverlap('personal', archiveId));
  let drops = [];
  await step('list', async () => { drops = await dropsync.drop.list('personal'); return drops.length; });
  let p2 = null;
  await step('payload', async () => {
    p2 = drops.find(d => d.name === 'P2 One Hour Left');
    const payload = await dropsync.drop.getPayload(p2.id);
    return typeof payload.text === 'string' && payload.text.includes('See #[');
  });
  await step('timerResume', async () => {
    const mins = Math.round((new Date(p2.expiresAt).getTime() - Date.now()) / 60000);
    return mins >= 58 && mins <= 61 ? mins : 'BAD:' + mins;
  });
  await step('mediaUrl', async () => {
    const p5 = drops.find(d => d.name === 'P5 Big Dummy.bin');
    const url = await dropsync.media.getUrl(p5.id, 'file');
    return url.startsWith('media://r/') ? url.slice(0, 16) + '…' : false;
  });
  await step('patchPin', async () => {
    await dropsync.drop.patch(p2.id, { pinned: false });
    const meta = await dropsync.drop.getMeta(p2.id);
    return meta.pinned === false;
  });
  await step('settingsRoundtrip', async () => {
    await dropsync.vault.settingsSet({ autoLockMinutes: 30 });
    const s = await dropsync.vault.settingsGet();
    return s.autoLockMinutes === 30 && s.theme;
  });
  await step('lockAfterIdleConfig', async () => { await dropsync.vault.lock(); return (await dropsync.vault.status()).state; });
  return JSON.stringify(results);
})()
`;
        void mainWindow?.webContents
          .executeJavaScript(e2e, true)
          .then(async (report) => {
            console.log('[e2e]', report);
            // FIX 24 permanent regression harness — every S1 round also drives the real vault
            // engine headlessly through a full password change (dirty + empty journal branches).
            try {
              const { promisify } = await import('node:util');
              const script = join(fileURLToPath(new URL('.', import.meta.url)), '../../scripts/vault-pw-harness.ts');
              const out = await promisify(execFile)(process.execPath, [script], {
                timeout: 180_000,
                env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
              });
              for (const line of out.stdout.split('\n')) {
                if (line.includes('[pw-harness]')) console.log(line.trim());
              }
            } catch (error) {
              console.error('[pw-harness] failed:', error instanceof Error ? error.message : error);
            }
          })
          .catch((error) => console.error('[e2e] failed:', error));
      }

      // DROPSYNC_E2E_S2=1 → Sitting-2 battery over the real bridge (create/edit/drawing
      // round-trip/big-file stream/oversize reject/title refresh/open-external guard).
      if (process.env.DROPSYNC_E2E_S2 === '1') {
        void mainWindow?.webContents
          .executeJavaScript('JSON.stringify({ href: location.href, excal: !!window.__EXCAL, ds: !!window.dropsync })', true)
          .then((r) => console.log('[s2-probe]', r))
          .catch((e) => console.error('[s2-probe] failed:', e && e.stack ? e.stack : String(e)));
        const s2 = `
(async () => {
  try {
  const results = {};
  const step = async (name, fn) => {
    try { results[name] = await fn(); }
    catch (e) { results[name] = 'ERROR: ' + (e && e.message ? e.message : String(e)); }
  };
  const folder = '/tmp/ds-e2e-s2-vault-' + Math.floor(Math.random() * 1e9);
  // prepareFolder intentionally rejects non-existent dirs (product behavior — the real UI only
  // ever passes dialog-picked folders). vault.create() makes the dir itself, so skip prepare here.
  await step('create', async () => { await dropsync.vault.create(folder, 's2-vault-pw'); return true; });

  // --- M4: createText — category dedupe (max 3, case-insensitive-trim) + expiry from NOW ---
  let textId = '';
  await step('createText', async () => {
    const rec = await dropsync.drop.createText({
      spaceId: 'personal',
      name: 'S2 Note',
      content: 'Hello world watch https://www.youtube.com/watch?v=dQw4w9WgXcQ and see #[Other](missing-id-123)',
      categories: ['work', 'Work ', 'link'],
      expirationOption: '6h',
      locked: false,
      reminderAt: null,
    });
    textId = rec.id;
    const got = await dropsync.drop.getMeta(textId);
    return JSON.stringify(got.categories) === JSON.stringify(['work', 'link']) &&
      got.expirationOption === '6h' && !!got.expiresAt;
  });

  // --- M3: updateContent — payload re-encrypted, cached labels wiped on source change ---
  await step('editContentClearsLabels', async () => {
    // Seed a fake cached label the way an import would, then prove a content edit clears it.
    await dropsync.drop.patch(textId, { youtubeVideoLabels: [{ videoId: 'dQw4w9WgXcQ', title: 'Seed Title', channel: null }] });
    const seeded = await dropsync.drop.getMeta(textId);
    if (!seeded.youtubeVideoLabels || seeded.youtubeVideoLabels.length !== 1) return false;
    await dropsync.drop.updateContent(textId, { content: 'Edited body without links' });
    const after = await dropsync.drop.getMeta(textId);
    const payload = await dropsync.drop.getPayload(textId);
    return (after.youtubeVideoLabels ?? []).length === 0 && payload.text === 'Edited body without links';
  });

  // --- M3: updateMeta light path — expiry recomputes from NOW; ∞ clears ---
  await step('expiryEditRecomputesFromNow', async () => {
    await new Promise((r) => setTimeout(r, 1100));
    await dropsync.drop.updateMeta(textId, { expirationOption: '6h' });
    const m6 = await dropsync.drop.getMeta(textId);
    const drift6 = Math.abs(new Date(m6.expiresAt).getTime() - (Date.now() + 21600 * 1000));
    await dropsync.drop.updateMeta(textId, { expirationOption: 'forever' });
    const mInf = await dropsync.drop.getMeta(textId);
    return drift6 < 30000 && mInf.expiresAt === null;
  });

  // --- M3: drawing round-trip — real exportToBlob(exportEmbedScene) → vault → loadFromBlob ---
  await step('drawingRoundtrip', async () => {
    const EX = window.__EXCAL;
    if (!EX) return 'no excalidraw hook';
    const rect = { id: 'r1', type: 'rectangle', x: 10, y: 10, width: 120, height: 80, angle: 0,
      strokeColor: '#1a1a1a', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2,
      strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null,
      seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1,
      link: null, locked: false };
    const arrow = { ...rect, id: 'a1', type: 'arrow', x: 200, y: 40, width: 50, height: 30,
      points: [[0, 0], [50, 30]], lastCommittedPoint: null, startBinding: null, endBinding: null,
      startArrowhead: null, endArrowhead: null, elbowed: false };
    const text = { id: 't1', type: 'text', x: 30, y: 120, width: 80, height: 25, angle: 0,
      strokeColor: '#1a1a1a', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2,
      strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null,
      seed: 3, version: 1, versionNonce: 3, isDeleted: false, boundElements: null, updated: 1,
      link: null, locked: false, text: '你好 CJK test', fontSize: 20, fontFamily: 1, textAlign: 'left',
      verticalAlign: 'top', containerId: null, originalText: '你好 CJK test', autoResize: true,
      lineHeight: 1.25, baseline: 18 };
    const blob = await EX.exportToBlob({
      elements: [rect, arrow, text],
      appState: { viewBackgroundColor: '#fffef5', exportBackground: true, exportEmbedScene: true },
      files: {},
      exportPadding: 10,
    });
    const pngBytes = new Uint8Array(await blob.arrayBuffer());
    const rec = await dropsync.drop.createText({
      spaceId: 'personal', name: '', content: '', expirationOption: '24h',
      categories: [], locked: false, reminderAt: null, pngBytes,
    });
    if (!rec.isDrawing || rec.mimeType !== 'image/png') return 'create flags wrong';
    const bytes = await dropsync.media.getBytes(rec.id, 'file');
    if (!bytes) return 'getBytes null';
    let sceneBlob;
    try {
      sceneBlob = new Blob([bytes], { type: 'image/png' });
    } catch (e) {
      return 'blob ctor threw: ' + e.message;
    }
    const scene = await EX.loadFromBlob(sceneBlob, null, null);
    const ids = scene.elements.filter((e) => !e.isDeleted).map((e) => e.id).sort();
    const fonts = performance.getEntriesByType('resource')
      .map((r) => r.name)
      .filter((n) => n.includes('.woff2'));
    results.__fontSample = {
      total: fonts.length,
      local: fonts.filter((n) => !n.includes('esm.sh')).length,
      cdn: fonts.filter((n) => n.includes('esm.sh')).length,
      sample: fonts.slice(0, 4),
      textRoundTripped: scene.elements.find((e) => e.id === 't1')?.text || 'MISSING',
      assetPathAtRuntime: String(window.EXCALIDRAW_ASSET_PATH),
      fontsHeadOk: await fetch('/fonts/Cascadia/CascadiaCode-Regular.woff2', { method: 'HEAD' }).then((r) => r.ok).catch(() => false),
    };
    return JSON.stringify(ids) === JSON.stringify(['a1', 'r1', 't1']) &&
      scene.appState.viewBackgroundColor === '#fffef5';
  });

  // --- M4: 300 MB disk file → streamed create → byte-perfect SHA-256 via media:// ---
  let bigId = '';
  window.__progressTicks = 0;
  const offProgress = dropsync.onImportProgress((p) => { if (p.phase === 'fileCreate') window.__progressTicks++; });
  await step('bigFileCreate', async () => {
    const rec = await dropsync.drop.createFileFromPath('/tmp/opencode/e2e/big300.bin',
      { spaceId: 'personal', expirationOption: '24h', locked: false });
    bigId = rec.id;
    return rec.fileSize === 314572800 && !!rec.name;
  });
  await step('progressEventsObserved', async () => {
    offProgress();
    return window.__progressTicks > 5;
  });
  results.__bigId = bigId;

  // --- M4: 501 MB rejected up front with the web's exact wording ---
  await step('oversizeRejectedExactMessage', async () => {
    try {
      await dropsync.drop.createFileFromPath('/tmp/opencode/e2e/big501.bin',
        { spaceId: 'personal', expirationOption: '24h', locked: false });
      return false;
    } catch (e) {
      return e.message === 'File too large. Maximum size is 500 MB. Your file is 501 MB.';
    }
  });

  // --- YouTube title refresh — full result incl. the offline branch actually taken ---
  await step('refreshTitlesResultShape', async () => {
    const r = await dropsync.youtube.refreshTitles('personal');
    results.__yt = r;
    return typeof r.scanned === 'number' && typeof r.needed === 'number' &&
      typeof r.refreshed === 'number' && typeof r.offline === 'boolean';
  });

  // --- shell:openExternal guard — https only, nothing else exposed ---
  await step('openExternalRejectsNonHttps', async () => {
    try { await dropsync.shell.openExternal('http://example.com'); return false; }
    catch (e) { return e.message === 'Only https links can be opened.'; }
  });

  await step('secondLinkDrop', async () => {
    const rec = await dropsync.drop.createText({ spaceId: 'personal', name: 'Link Only', content: 'see https://youtu.be/jNQXAC9IVRw', categories: [], expirationOption: '24h', locked: false, reminderAt: null });
    return !!rec.id;
  });

  await step('lockAtEnd', async () => { return 'deferred-to-main'; });
  results.__folder = folder;
  return JSON.stringify(results);
  } catch (err) {
    return 'FATAL: ' + (err && err.stack ? String(err.stack).slice(0, 500) : String(err));
  }
})();
`;
        void mainWindow?.webContents
          .executeJavaScript(s2, true)
          .then(async (report) => {
            console.log('[e2e-s2]', report);
            // Main-side SHA verification of the streamed big file (decrypt → hash → compare with
            // the on-disk source). Runs here, not in the renderer: getBytes is deliberately
            // size-capped, and this keeps the 300 MB out of renderer memory entirely.
            try {
              const parsed = JSON.parse(report) as Record<string, unknown>;
              const bigId = parsed.__bigId;
              if (typeof bigId === 'string' && bigId) {
                const { createHash } = await import('node:crypto');
                const { createReadStream } = await import('node:fs');
                const url = manager.getMediaUrl(bigId, 'file');
                if (!url) throw new Error('no media url');
                const entry = manager.resolveMediaToken(url.split('/').pop()!);
                if (!entry) throw new Error('no token entry');
                const storedHash = createHash('sha256');
                const nodeReadable = Readable.fromWeb(manager.streamMedia(entry, 0, Number.POSITIVE_INFINITY) as unknown as import('node:stream/web').ReadableStream);
                for await (const chunk of nodeReadable) storedHash.update(chunk as Buffer);
                const srcHash = createHash('sha256');
                for await (const chunk of createReadStream('/tmp/opencode/e2e/big300.bin')) srcHash.update(chunk as Buffer);
                const storedHex = storedHash.digest('hex');
                const sourceHex = srcHash.digest('hex');
                console.log('[s2-sha]', JSON.stringify({
                  match: storedHex === sourceHex,
                  stored: storedHex,
                  source: sourceHex,
                }));
              }
              // Forced-offline proof: the silent no-op branch (no fetches, no throw, refreshed 0).
              const offRes = await refreshYouTubeTitles(manager, 'personal', { forceOffline: true });
              console.log('[s2-offline]', JSON.stringify(offRes));
              await manager.lock();
              console.log('[s2-lock]', (await manager.status()).state);
            } catch (err) {
              console.error('[s2-sha] failed:', err instanceof Error ? err.message : String(err));
            }
          })
          .catch((error) => console.error('[e2e-s2] failed:', error instanceof Error && error.stack ? error.stack : String(error)));
      }

      // DROPSYNC_E2E_SIT3=1 → Sitting-3 acceptance battery (M5–M8), two phases across an app
      // restart. Phase A (fresh vault A): seed drops → export personal + workspace flavors →
      // cap refusal → reminder fires + persisted → lock before past-due. Phase B (after shell
      // kill -9 + relaunch, same env): unlock scan silently marks past-due → fresh vault B ←
      // import both archives → Section-5 invariant asserts → offline YouTube + edit reachability
      // DOM checks → cancel drill → exit-door lock. Disk-level assertions live main-side below.
      if (process.env.DROPSYNC_E2E_SIT3 === '1') {
        const sit3 = `
(async () => {
  try {
  const folderA = '/tmp/ds-e2e-sit3-vault-A';
  const hasVault = await dropsync.vault.probeFolder(folderA);
  if (!hasVault) {
    // ---------------- PHASE A ----------------
    const R = {};
    const step = async (name, fn) => {
      try { R[name] = await fn(); }
      catch (e) { R[name] = 'ERROR: ' + (e && e.message ? e.message : String(e)); }
    };
    await step('createA', async () => { await dropsync.vault.create(folderA, 'sit3-vault-pw-A'); return true; });
    let noteId = '';
    let drawId = '';
    let bigId = '';
    let srcSha = '';
    await step('seedTexts', async () => {
      const t = await dropsync.drop.createText({ spaceId: 'personal', name: 'RT Target', content: 'target body', categories: [], expirationOption: '24h', locked: false, reminderAt: null });
      const n = await dropsync.drop.createText({ spaceId: 'personal', name: 'RT Note', content: 'See #[RT Target](' + t.id + ') and https://www.youtube.com/watch?v=dQw4w9WgXcQ', categories: ['Work'], expirationOption: '6h', locked: false, reminderAt: null });
      noteId = n.id;
      await dropsync.drop.createText({ spaceId: 'personal', name: 'Forever Note', content: 'eternal', categories: [], expirationOption: 'forever', locked: false, reminderAt: null });
      return true;
    });
    await step('seedDrawing', async () => {
      let EX = window.__EXCAL;
      for (let i = 0; i < 20 && !EX; i++) { await new Promise((r) => setTimeout(r, 500)); EX = window.__EXCAL; }
      if (!EX) return 'no excalidraw hook';
      const mk = (id, type, extra) => Object.assign({ id: id, type: type, x: 10, y: 10, width: 120, height: 80, angle: 0,
        strokeColor: '#1a1a1a', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2,
        strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null,
        seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1,
        link: null, locked: false }, extra || {});
      const arrow = mk('a1', 'arrow', { points: [[0, 0], [50, 30]], lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: null, elbowed: false });
      const blob = await EX.exportToBlob({ elements: [mk('r1', 'rectangle'), arrow], appState: { viewBackgroundColor: '#fffef5', exportBackground: true, exportEmbedScene: true }, files: {}, exportPadding: 10 });
      const pngBytes = new Uint8Array(await blob.arrayBuffer());
      const rec = await dropsync.drop.createText({ spaceId: 'personal', name: '', content: '', expirationOption: '24h', categories: [], locked: false, reminderAt: null, pngBytes: pngBytes });
      drawId = rec.id;
      return rec.isDrawing === true;
    });
    await step('seedImage', async () => {
      const rec = await dropsync.drop.createText({ spaceId: 'personal', name: 'Image Note', content: 'pic', categories: [], expirationOption: '24h', locked: false, reminderAt: null, imagePath: '/tmp/opencode/e2e/small.png' });
      return !!rec.imageSize;
    });
    await step('seedBigFile', async () => {
      const b = await dropsync.drop.createFileFromPath('/tmp/opencode/e2e/big12.bin', { spaceId: 'personal', expirationOption: '24h', locked: false });
      bigId = b.id;
      const bytes = await dropsync.media.getBytes(b.id, 'file');
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      srcSha = Array.from(new Uint8Array(digest)).map(function (x) { return x.toString(16).padStart(2, '0'); }).join('');
      return b.fileSize === 12582912;
    });
    await step('pinThree', async () => {
      // >2 pins — import must cap at 2 live pins and report unpinnedCount >= 1.
      const list = await dropsync.drop.list('personal');
      const pick = [noteId, drawId, bigId];
      for (const id of pick) { if (!list.some(function (d) { return d.id === id; })) return 'missing seed drop'; }
      for (const id of pick) { await dropsync.drop.patch(id, { pinned: true }); }
      return true;
    });
    let expSummary = null;
    await step('exportPersonal', async () => {
      expSummary = await dropsync.vault.export('personal', 'sit3-export-pw', '/tmp/opencode/e2e/sit3-personal.dropsync');
      R.__expPersonal = expSummary;
      return expSummary.included === 6 && expSummary.skippedExpired === 0;
    });
    await step('exportWorkspace', async () => {
      const sp = await dropsync.vault.createSpace('WS One');
      await dropsync.drop.createText({ spaceId: sp.id, name: 'WS Note', content: 'ws body', categories: [], expirationOption: '24h', locked: false, reminderAt: null });
      const s = await dropsync.vault.export({ workspaceId: sp.id }, 'sit3-export-pw', '/tmp/opencode/e2e/sit3-workspace.dropsync');
      R.__expWorkspace = s;
      return s.included === 1;
    });
    await step('capRefusal', async () => {
      await dropsync.dev.testOnly('bloatFileSize', bigId);
      try {
        await dropsync.vault.export('personal', 'sit3-export-pw', '/tmp/opencode/e2e/sit3-capped.dropsync');
        return false;
      } catch (e) {
        return String(e.message).indexOf('20 GB') >= 0 ? 'refused' : 'wrong error: ' + e.message;
      } finally {
        await dropsync.dev.testOnly('setFileSize', bigId, 12582912);
      }
    });
    await step('reminderFires', async () => {
      let fallbackCount = 0;
      const off = dropsync.onNotifyFallback(function () { fallbackCount++; });
      try {
        await dropsync.drop.updateMeta(noteId, { reminderAt: new Date(Date.now() + 5000).toISOString() });
        let meta = null;
        for (let i = 0; i < 55; i++) {
          await new Promise(function (r) { setTimeout(r, 1000); });
          meta = await dropsync.drop.getMeta(noteId);
          if (meta.reminderFiredAt) break;
        }
        R.__fallbackCount = fallbackCount;
        return !!meta.reminderFiredAt;
      } finally { off(); }
    });
    await step('seedPastDueThenLock', async () => {
      const p = await dropsync.drop.createText({ spaceId: 'personal', name: 'PastDue Note', content: 'x', categories: [], expirationOption: '24h', locked: false, reminderAt: new Date(Date.now() + 2500).toISOString() });
      localStorage.setItem('dropsync.sit3.ctx', JSON.stringify({ noteId: noteId, pastDueId: p.id, srcSha: srcSha }));
      await dropsync.vault.lock();
      const st = await dropsync.vault.status();
      return st.state;
    });
    return JSON.stringify({ phase: 'A-done', R: R });
  } else {
    // ---------------- PHASE B (same folder, after restart) ----------------
    const ctx = JSON.parse(localStorage.getItem('dropsync.sit3.ctx') || '{}');
    const R = { phase: 'B-done' };
    const step = async (name, fn) => {
      try { R[name] = await fn(); }
      catch (e) { R[name] = 'ERROR: ' + (e && e.message ? e.message : String(e)); }
    };
    await step('unlockA', async () => { await dropsync.vault.unlock(folderA, 'sit3-vault-pw-A'); return true; });
    await step('pastDueSilentlyMarked', async () => {
      const m = await dropsync.drop.getMeta(ctx.pastDueId);
      return !!m.reminderFiredAt;
    });
    await step('noRefireAfterRestart', async () => {
      const m1 = await dropsync.drop.getMeta(ctx.noteId);
      await new Promise(function (r) { setTimeout(r, 2000); });
      const m2 = await dropsync.drop.getMeta(ctx.noteId);
      return !!m1.reminderFiredAt && m1.reminderFiredAt === m2.reminderFiredAt;
    });
    await step('createB', async () => { await dropsync.vault.create('/tmp/ds-e2e-sit3-vault-B', 'sit3-vault-pw-B'); return true; });
    let imp = null;
    await step('importPersonalRoundTrip', async () => {
      const insp = await dropsync.vault.importInspect('/tmp/opencode/e2e/sit3-personal.dropsync', 'sit3-export-pw');
      if (insp.flavor !== 'dropsync.personal') return 'flavor ' + insp.flavor;
      imp = await dropsync.vault.importRun({ filePath: '/tmp/opencode/e2e/sit3-personal.dropsync', password: 'sit3-export-pw', destination: { mode: 'personal' } });
      return imp.importedCount === 6 && imp.unpinnedCount >= 1 && imp.legacyExpiryFallbackCount === 0;
    });
    await step('invariantNamesAndTimers', async () => {
      const list = await dropsync.drop.list('personal');
      const names = list.map(function (d) { return d.name; }).sort();
      const want = ['Drawing', 'Forever Note', 'Image Note', 'RT Note', 'RT Target', 'big12.bin'].sort();
      const nameOk = JSON.stringify(names) === JSON.stringify(want);
      const forever = list.find(function (d) { return d.name === 'Forever Note'; });
      const note = list.find(function (d) { return d.name === 'RT Note'; });
      const remainingH = (new Date(note.expiresAt).getTime() - Date.now()) / 3600000;
      const livePins = list.filter(function (d) { return d.pinned; }).length;
      return nameOk && forever.expiresAt === null && remainingH > 0 && remainingH <= 6 && livePins === 2;
    });
    await step('invariantMentionRemap', async () => {
      const list = await dropsync.drop.list('personal');
      const note = list.find(function (d) { return d.name === 'RT Note'; });
      const target = list.find(function (d) { return d.name === 'RT Target'; });
      const payload = await dropsync.drop.getPayload(note.id);
      const ok = payload.text.indexOf('#[RT Target](' + target.id + ')') >= 0;
      return ok ? 'remapped' : 'UNMAPPED: ' + payload.text.slice(0, 60);
    });
    await step('invariantDrawingScene', async () => {
      const EX = window.__EXCAL;
      if (!EX) return 'no excalidraw hook';
      const list = await dropsync.drop.list('personal');
      const drawing = list.find(function (d) { return d.isDrawing; });
      if (!drawing) return 'no drawing drop';
      let bytes = await dropsync.media.getBytes(drawing.id, 'image');
      if (!bytes) bytes = await dropsync.media.getBytes(drawing.id, 'file');
      if (!bytes) return 'no drawing bytes';
      const scene = await EX.loadFromBlob(new Blob([bytes], { type: 'image/png' }), null, null);
      const ids = scene.elements.filter(function (e) { return !e.isDeleted; }).map(function (e) { return e.id; }).sort();
      return JSON.stringify(ids) === JSON.stringify(['a1', 'r1']);
    });
    await step('invariantBigFileSha256', async () => {
      const list = await dropsync.drop.list('personal');
      const big = list.find(function (d) { return d.name === 'big12.bin'; });
      const bytes = await dropsync.media.getBytes(big.id, 'file');
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hex = Array.from(new Uint8Array(digest)).map(function (x) { return x.toString(16).padStart(2, '0'); }).join('');
      return hex === ctx.srcSha;
    });
    await step('importWorkspaceFlavor', async () => {
      const r = await dropsync.vault.importRun({ filePath: '/tmp/opencode/e2e/sit3-workspace.dropsync', password: 'sit3-export-pw', destination: { mode: 'new', name: 'RT Restored' } });
      if (r.importedCount !== 1) return 'count ' + r.importedCount;
      const spaces = await dropsync.vault.listSpaces();
      const restored = spaces.find(function (s) { return s.name === 'RT Restored'; });
      const drops = await dropsync.drop.list(restored.id);
      return drops.length === 1 && drops[0].name === 'WS Note' && drops[0].creatorName === 'local';
    });
    // NOTE: DOM-level checks (edit buttons, offline YouTube, reminder visibility, dropdown)
    // run in the dedicated DROPSYNC_SIT3_DOMCHECKS boot against a pre-unlocked mounted UI —
    // this bridge-driven session never renders the list, by design.
    await step('cancelDrill', async () => {
      const pending = dropsync.vault.export('personal', 'sit3-cancel-pw', '/tmp/opencode/e2e/sit3-cancel.dropsync');
      await new Promise(function (r) { setTimeout(r, 400); });
      await dropsync.vault.exportCancel();
      try { await pending; return false; } catch (e) { return /cancel/i.test(String(e.message)) ? 'cancelled-cleanly' : e.message; }
    });
    await step('exitDoorLock', async () => { await dropsync.vault.lock(); return (await dropsync.vault.status()).state; });
    localStorage.removeItem('dropsync.sit3.ctx');
    return JSON.stringify(R);
  }
  } catch (err) {
    return 'FATAL: ' + (err && err.stack ? String(err.stack).slice(0, 400) : String(err));
  }
})()
`;
        void mainWindow?.webContents
          .executeJavaScript(sit3, true)
          .then(async (report) => {
            console.log('[sit3]', report);
            // Disk-level assertions (main-side — the renderer cannot see the filesystem):
            // produced archives exist, refused/cancelled exports left ZERO bytes behind.
            try {
              const fsMod = await import('node:fs/promises');
              const dir = '/tmp/opencode/e2e';
              const list = await fsMod.readdir(dir).catch(() => [] as string[]);
              const parts = list.filter((f) => f.endsWith('.part'));
              const parsed = JSON.parse(report) as { phase?: string };
              if (parsed.phase === 'A-done') {
                const personal = await fsMod.stat(`${dir}/sit3-personal.dropsync`);
                const workspace = await fsMod.stat(`${dir}/sit3-workspace.dropsync`);
                const cappedAbsent = !(list.includes('sit3-capped.dropsync'));
                console.log('[sit3-disk]', JSON.stringify({
                  personalBytes: personal.size,
                  workspaceBytes: workspace.size,
                  cappedRefusedClean: cappedAbsent && personal.size > 0 && workspace.size > 0,
                  partFiles: parts,
                }));
              } else if (parsed.phase === 'B-done') {
                const cancelledAbsent = !list.includes('sit3-cancel.dropsync');
                console.log('[sit3-disk-b]', JSON.stringify({ cancelledClean: cancelledAbsent, partFiles: parts }));
              }
            } catch (err) {
              console.error('[sit3-disk] failed:', err instanceof Error ? err.message : String(err));
            }
          })
          .catch((error) => console.error('[sit3] failed:', error instanceof Error && error.stack ? error.stack : String(error)));
      }


      if (process.env.DROPSYNC_E2E_S3 === '1') {
        const s3 = `
(async () => {
  const folder = '/tmp/ds-e2e-s3-orphan-vault';
  const st = await dropsync.vault.status();
  if (st.state === 'none') {
    // Fresh boot: adopt an existing vault on disk, or create one and kick the doomed stream.
    // (probeFolder, not prepareFolder — a non-existent folder must not dead-end here.)
    const hasVault = await dropsync.vault.probeFolder(folder);
    if (!hasVault) {
      await dropsync.vault.create(folder, 's3-orphan-pw');
      dropsync.drop.createFileFromPath('/tmp/opencode/e2e/big300.bin', { spaceId: 'personal', expirationOption: '24h', locked: false }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
      return JSON.stringify({ phase: 'kicked' });
    }
  }
  await dropsync.vault.unlock(folder, 's3-orphan-pw');
  const drops = await dropsync.drop.list('personal');
  return JSON.stringify({ phase: 'recovered', drops: drops.length });
})();
`;
        void mainWindow?.webContents
          .executeJavaScript(s3, true)
          .then((report) => console.log('[s3]', report))
          .catch((error) => console.error('[s3] failed:', error instanceof Error && error.stack ? error.stack : String(error)));
      }
      // DROPSYNC_SIT3_DOMCHECKS=1 → DOM-level checks against the REAL mounted UI (the renderer
      // booted pre-unlocked via DROPSYNC_SIT3_BOOT_UNLOCK). Covers the Sitting-3-fix battery:
      // dropdown (one Personal row + create-workspace flow), reminder visibility (promotion,
      // glow, preview chip, dismiss persistence), YouTube player (offline message, mount/unmount,
      // width parity), the original edit-button reachability check, silent deletes +
      // hover-prefetch (stage 3), batch choreography + media tokens + drag (stage 4), and the
      // FIX 17 deletion-pipeline unification + FIX 18 editor→preview round trip (stage 5).
      // Stages chain via localStorage 'dropsync.sit3.dom': 1 → 1b → 2 → 2r → 3 → 4 → 5 → 6 → 7.
      if (process.env.DROPSYNC_SIT3_DOMCHECKS === '1') {
        setTimeout(() => {
          void mainWindow?.webContents
            .executeJavaScript(`(async () => {
  const out = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const setNativeValue = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const switcherPill = () => document.querySelector('header .relative > button');
  const menuOpen = () => !!document.querySelector('header .absolute.top-full');
  const openMenu = async () => {
    if (!menuOpen()) { switcherPill().click(); await sleep(400); }
  };
  const cardH3s = () => Array.from(document.querySelectorAll('h3[title]')).filter((h) => h.closest('.cursor-pointer'));
  try {
    await sleep(1500);
    const stage = localStorage.getItem('dropsync.sit3.dom') || ${JSON.stringify(process.env.DROPSYNC_SIT3_DOM_STAGE || '1')};
    if (stage === '1') {
      // ---- STAGE 1: dropdown suite (FIX 2 + FIX 3), then reload for a truly-hydrated stage 2 ----
      const finishStage1 = (o) => {
        o.stage = '1';
        localStorage.setItem('dropsync.sit3.dom', '1b');
        setTimeout(() => location.reload(), 50);
        return JSON.stringify(o);
      };
      out.editButtons = document.querySelectorAll('button[aria-label="Edit"]').length;
      out.headerPadlocks = document.querySelectorAll('header [title="Lock now"]').length;
      await openMenu();
      const menu = document.querySelector('header .absolute.top-full');
      out.personalRows = menu ? Array.from(menu.querySelectorAll('span')).filter((s) => s.textContent === 'Personal').length : -1;
      const spacesBefore = (await dropsync.vault.listSpaces()).length;
      const newWsBtn = menu ? Array.from(menu.querySelectorAll('button')).find((b) => (b.textContent || '').includes('New workspace')) : null;
      if (!newWsBtn) { out.createRow = 'no New workspace button'; return finishStage1(out); }
      newWsBtn.click();
      await sleep(300);
      let row = document.querySelector('[data-create-space-row] input');
      if (!row) { out.createRow = 'row did not expand'; return finishStage1(out); }
      setNativeValue(row, 'junk-draft');
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(300);
      out.escCancelClosed = !document.querySelector('[data-create-space-row]');
      out.spacesAfterEsc = (await dropsync.vault.listSpaces()).length;
      // FIX 1: backdrop click must ALSO fold the create row — reopen shows no abandoned draft.
      await openMenu();
      const nbB = Array.from(document.querySelector('header .absolute.top-full').querySelectorAll('button')).find((b) => (b.textContent || '').includes('New workspace'));
      nbB.click();
      await sleep(300);
      const rowB = document.querySelector('[data-create-space-row] input');
      setNativeValue(rowB, 'backdrop-draft');
      document.querySelector('header .fixed.inset-0.z-40').click();
      await sleep(300);
      out.backdropClosedMenu = !menuOpen();
      await openMenu();
      out.reopenRowFoldedNoDraft = !document.querySelector('[data-create-space-row]');
      await openMenu();
      const newWsBtn2 = Array.from(document.querySelectorAll('header .absolute.top-full button')).find((b) => (b.textContent || '').includes('New workspace'));
      newWsBtn2.click();
      await sleep(300);
      row = document.querySelector('[data-create-space-row] input');
      if (!row) { out.createRow = 'row did not expand (2nd)'; return finishStage1(out); }
      setNativeValue(row, 'RT WS');
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await sleep(1200);
      const spacesAfter = await dropsync.vault.listSpaces();
      out.spaceCreated = spacesAfter.length === spacesBefore + 1 && spacesAfter.some((s) => s.name === 'RT WS');
      out.switchedToNew = !!Array.from(document.querySelectorAll('header button')).find((b) => (b.textContent || '').includes('RT WS'));
      out.dropdownClosedAfterCreate = !document.querySelector('[data-create-space-row]');
      // ---- FIX 7/12: Settings owns locking; EditorialSelect auto-lock; engine validation ----
      const settingsBtn = Array.from(document.querySelectorAll('header button')).find((b) => (b.textContent || '').includes('Settings'));
      settingsBtn.click();
      await sleep(600);
      out.nativeSelectsInSettings = document.querySelectorAll('select').length;
      const selRoot = document.querySelector('[data-editorial-select]');
      if (!selRoot) { out.autoLockSelect = 'no EditorialSelect'; return finishStage1(out); }
      selRoot.querySelector('button').click();
      await sleep(300);
      document.querySelector('[data-editorial-select-menu] [data-value="120"]').click();
      await sleep(700);
      out.autoLockAccepts120 = (await dropsync.vault.settingsGet()).autoLockMinutes === 120;
      selRoot.querySelector('button').click();
      await sleep(300);
      document.querySelector('[data-editorial-select-menu] [data-value="480"]').click();
      await sleep(700);
      out.autoLockAccepts480 = (await dropsync.vault.settingsGet()).autoLockMinutes === 480;
      // Esc closes the open select menu; backdrop click closes too.
      selRoot.querySelector('button').click();
      await sleep(250);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(300);
      out.selectEscCloses = !document.querySelector('[data-editorial-select-menu]');
      selRoot.querySelector('button').click();
      await sleep(250);
      selRoot.querySelector('.fixed.inset-0').click();
      await sleep(300);
      out.selectBackdropCloses = !document.querySelector('[data-editorial-select-menu]');
      // Engine validation (FIX 7): garbage rejected with a clear error, valid passes.
      const rejects = async (fn) => { try { await fn(); return false; } catch (e) { return true; } };
      out.rejectsNegativeMinutes = await rejects(() => dropsync.vault.settingsSet({ autoLockMinutes: -5 }));
      out.rejectsFractionalMinutes = await rejects(() => dropsync.vault.settingsSet({ autoLockMinutes: 12.5 }));
      out.rejectsOver480 = await rejects(() => dropsync.vault.settingsSet({ autoLockMinutes: 481 }));
      out.rejectsBadTheme = await rejects(() => dropsync.vault.settingsSet({ theme: 'blue' }));
      out.accepts240 = ((await dropsync.vault.settingsSet({ autoLockMinutes: 240 })).autoLockMinutes === 240);
      // ---- C2l (4a): picking Off must STORE null AND DISPLAY "Off". The owner symptom was the
      // display snapping back to "10 minutes" while the store kept null (the old '?? 10' reader).
      // autoLockOffDisplayed is THE red-proof-sensitive half: with the old reader the stored
      // check passes but the display lies, so autoLockOffReal (both conjuncts) goes false.
      selRoot.querySelector('button').click();
      await sleep(300);
      document.querySelector('[data-editorial-select-menu] [data-value="off"]').click();
      await sleep(700);
      out.autoLockOffStored = (await dropsync.vault.settingsGet()).autoLockMinutes === null;
      selRoot.querySelector('button').click();
      await sleep(300);
      const offLabel = ((selRoot.querySelector('button span') || selRoot.querySelector('button')).textContent || '').trim();
      out.autoLockOffTriggerLabel = offLabel;
      out.autoLockOffDisplayed = offLabel.toLowerCase() === 'off';
      out.autoLockOffReal = out.autoLockOffStored && out.autoLockOffDisplayed;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(300);
      out.offMenuEscCloses = !document.querySelector('[data-editorial-select-menu]');
      await dropsync.vault.settingsSet({ autoLockMinutes: 10 }); // restore default
      // FIX 3: closing Settings must be SILENT — zero drop:list refetches, modal just goes.
      // (Move-vault's refresh is logic-level: wired to onVaultMoved in App.tsx, fired only on
      // a successful vault.move — not drivable here without the native folder dialog.)
      await dropsync.dev.testOnly('resetListCallCount', '');
      const doneBtn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Done');
      doneBtn.click();
      await sleep(700);
      out.settingsCloseZeroRefetch = ((await dropsync.dev.testOnly('listCallStats', '')).count === 0);
      out.settingsClosedSilently = !Array.from(document.querySelectorAll('h2')).some((h) => (h.textContent || '').trim() === 'Settings');
      // Reopen for the Lock-now end-to-end test.
      settingsBtn.click();
      await sleep(600);
      // FIX 12: Lock now lives ONLY in Settings — prove it end-to-end.
      const lockNowBtn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Lock now');
      out.settingsHasLockNow = !!lockNowBtn;
      lockNowBtn.click();
      let lockedState = false;
      for (let i = 0; i < 20 && !lockedState; i++) { await sleep(300); lockedState = ((await dropsync.vault.status()).state === 'locked'); }
      out.settingsLockWorks = lockedState;
      await dropsync.vault.unlock('/tmp/ds-e2e-sit3-vault-B', 'sit3-vault-pw-B');
      out.reunlockedForNextStage = ((await dropsync.vault.status()).state === 'unlocked');
      return finishStage1(out);
    }
    if (stage === '1b') {
      // ---- STAGE 1b: bulk-delete two-tap guard (#225), pill count contrast (#225), light-theme
      // selection restyles ONLY the tick box (#226); flips theme dark for the stage-2 check. ----
      let cards = [];
      for (let i = 0; i < 24 && cards.length < 5; i++) { await sleep(500); cards = cardH3s(); }
      out.hydratedCards1b = cards.length;
      const gotoSpace = async (name) => {
        await openMenu();
        const menuEl = document.querySelector('header .absolute.top-full');
        const row = Array.from(menuEl.querySelectorAll('button')).find((el) => (el.textContent || '').trim() === name)
          || Array.from(menuEl.querySelectorAll('div')).find((el) => el.className.includes('cursor-pointer') && (el.textContent || '').trim() === name);
        if (!row) return false;
        row.click();
        await sleep(1000);
        return true;
      };
      // Stage 1 left us on RT WS — bridge-created drops only surface after a refetch, so
      // switch away and back (setCurrentSpace always refetches). Also mint one REAL custom
      // category so the custom-pill contrast check has something to click.
      await dropsync.vault.createCategory('personal', 'DrillCat');
      await gotoSpace('RT WS');
      await dropsync.drop.createText({ spaceId: 'personal', name: 'Bulk Drill A', content: 'x', categories: [], expirationOption: 'forever', locked: false, reminderAt: null });
      await dropsync.drop.createText({ spaceId: 'personal', name: 'Bulk Drill B', content: 'x', categories: [], expirationOption: 'forever', locked: false, reminderAt: null });
      out.backToPersonal = await gotoSpace('Personal');
      let drillCount = 0;
      for (let i = 0; i < 24 && drillCount < 8; i++) {
        await sleep(500);
        drillCount = cardH3s().filter((h) => h.getAttribute('title') || '').length;
      }
      out.drillSeeded = cardH3s().filter((h) => /Bulk Drill/.test(h.getAttribute('title') || '')).length === 2;
      const mainBtn = (pred) => Array.from(document.querySelectorAll('main button')).find(pred);
      const delBtn = () => mainBtn((b) => { const t = (b.textContent || '').trim(); return t.startsWith('Delete ') || t.startsWith('Confirm delete '); });
      const tickFor = (name) => {
        const h = cardH3s().find((x) => x.getAttribute('title') === name);
        return h ? h.closest('.cursor-pointer').querySelector('button.w-10.h-10') : null;
      };
      // Enter selection mode and select exactly the two throwaway drops.
      mainBtn((b) => (b.textContent || '').trim() === 'Select').click();
      await sleep(300);
      tickFor('Bulk Drill A').click();
      await sleep(200);
      tickFor('Bulk Drill B').click();
      await sleep(200);
      out.armedLabel = delBtn() ? delBtn().textContent.trim() : 'gone';
      // FIX 5: single tap ARMS only — nothing is deleted.
      delBtn().click();
      await sleep(400);
      out.confirmLabel = delBtn() ? delBtn().textContent.trim() : 'gone';
      out.singleTapDeletedNothing = cardH3s().filter((h) => /Bulk Drill/.test(h.getAttribute('title') || '')).length === 2;
      // Clicking outside the button disarms.
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      await sleep(300);
      out.outsideClickDisarmed = delBtn() ? delBtn().textContent.trim() : 'gone';
      // Auto-disarm ~3 s after arming.
      delBtn().click();
      await sleep(400);
      await sleep(3300);
      out.autoDisarmedAfter3s = delBtn() ? delBtn().textContent.trim() : 'gone';
      // Second tap inside the window deletes.
      delBtn().click();
      await sleep(150);
      delBtn().click();
      await sleep(1200);
      out.twoTapsDeleted = cardH3s().filter((h) => /Bulk Drill/.test(h.getAttribute('title') || '')).length === 0;
      out.selectionModeExited = !mainBtn((b) => ['Select all', 'Deselect'].includes((b.textContent || '').trim()));
      // __STAGE1B_PILLS__
      // FIX 6 (#225): active pill counts use the readable contrast token.
      const pillCountClass = (label) => {
        const p = mainBtn((b) => (b.textContent || '').trim().startsWith(label));
        if (!p) return null;
        const spans = p.querySelectorAll('span');
        return spans.length ? spans[spans.length - 1].className : null;
      };
      const hasContrastToken = (cls) => !!cls && (cls.indexOf('/70') >= 0 || cls.indexOf('/55') >= 0);
      out.activeAllCountClass = String(pillCountClass('All'));
      out.builtinCountContrastLight = hasContrastToken(out.activeAllCountClass);
      const customPill = mainBtn((b) => /^(DrillCat|Work)/.test((b.textContent || '').trim()));
      if (customPill) {
        customPill.click();
        await sleep(300);
        const customLabel = (customPill.textContent || '').trim().slice(0, 8);
        out.customCountContrastLight = hasContrastToken(String(pillCountClass(customLabel)));
        out.customCountContrastKind = 'custom';
        mainBtn((b) => (b.textContent || '').trim().startsWith('All')).click();
        await sleep(250);
      } else {
        out.customCountContrastLight = 'no custom pill';
      }
      // FIX 4 (#226, LIGHT): selection restyles ONLY the tick box — card carries zero recolor.
      mainBtn((b) => (b.textContent || '').trim() === 'Select').click();
      await sleep(300);
      const fnTick = tickFor('Forever Note');
      fnTick.click();
      await sleep(300);
      const fnCard = cardH3s().find((h) => h.getAttribute('title') === 'Forever Note').closest('.cursor-pointer');
      const fnCardCls = fnCard.className;
      const fnTickCls = fnTick.className;
      out.lightContainerUnstyled = !fnCardCls.includes('bg-[#1a1a1a]') && !fnCardCls.includes('text-white');
      out.lightTickStyled = fnTickCls.includes('bg-[#1a1a1a]') && fnTickCls.includes('text-white');
      const fnH3 = fnCard.querySelector('h3').className;
      out.lightTitleUnstyled = !fnH3.includes('text-white') && fnH3.includes('text-[#1a1a1a]');
      // Leave selection mode cleanly.
      const selAllB = mainBtn((b) => ['Select all', 'Deselect'].includes((b.textContent || '').trim()));
      if (selAllB) selAllB.click();
      await sleep(200);
      mainBtn((b) => (b.textContent || '').trim() === 'Cancel' && b.closest('main')).click();
      await sleep(300);
      // Flip to dark for the stage-2 dark-theme selection check; reload re-reads settings.
      await dropsync.vault.settingsSet({ theme: 'dark' });
      out.stage = '1b';
      localStorage.setItem('dropsync.sit3.dom', '2');
      setTimeout(() => location.reload(), 50);
      return JSON.stringify(out);
    }
    if (stage === '2') {
      // ---- STAGE 2: arm the reminder seed; the UI learns it only via a fresh fetch (reload) ----
      let cards = [];
      for (let i = 0; i < 24 && cards.length < 6; i++) { await sleep(500); cards = cardH3s(); }
      out.hydratedCards = cards.length;
      // FIX 4 (#226, DARK): same contract in the dark theme.
      const mainBtnD = (pred) => Array.from(document.querySelectorAll('main button')).find(pred);
      mainBtnD((b) => (b.textContent || '').trim() === 'Select').click();
      await sleep(300);
      const dTick = cardH3s()[0].closest('.cursor-pointer').querySelector('button.w-10.h-10');
      dTick.click();
      await sleep(300);
      const dCard = cardH3s()[0].closest('.cursor-pointer');
      out.darkContainerUnstyled = !dCard.className.includes('bg-white') && !dCard.className.includes('text-[#0D0D0D]');
      out.darkTickStyled = dTick.className.includes('bg-white') && dTick.className.includes('text-[#0D0D0D]');
      out.darkTitleUnstyled = !dCard.querySelector('h3').className.includes('text-[#0D0D0D]');
      mainBtnD((b) => ['Select all', 'Deselect'].includes((b.textContent || '').trim())).click();
      await sleep(200);
      mainBtnD((b) => (b.textContent || '').trim() === 'Cancel').click();
      await sleep(300);
      await dropsync.vault.settingsSet({ theme: 'light' }); // restore for later stages
      const target = (await dropsync.drop.list('personal')).find((d) => d.name === 'Forever Note');
      if (!target) { out.reminder = 'Forever Note not found'; return done(out, '2'); }
      await dropsync.drop.patch(target.id, { reminderDismissedBy: null });
      await dropsync.drop.updateMeta(target.id, { reminderAt: new Date(Date.now() + 2500).toISOString() });
      out.seedArmed = true;
      localStorage.setItem('dropsync.sit3.dom', '2r');
      setTimeout(() => location.reload(), 50);
      return done(out, '2-seeded');
    }
    localStorage.removeItem('dropsync.sit3.dom');
    if (stage === '2r') {
      // ---- STAGE 2r: the seeded reminder is now in freshly fetched list DTOs ----
      let promoted = false, glow = false;
      for (let i = 0; i < 45 && !promoted; i++) {
        await sleep(1000);
        const first = cardH3s()[0];
        if (!first) continue;
        promoted = first.getAttribute('title') === 'Forever Note';
        glow = !!first.className.includes('animate-text-rgb');
      }
      out.promotedToTop = promoted;
      out.glowEngaged = glow;
      const cardH3 = cardH3s().find((h) => h.getAttribute('title') === 'Forever Note');
      if (!cardH3) { out.preview = 'card vanished'; return done(out, '2'); }
      cardH3.closest('.cursor-pointer').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(700);
      const chip = document.querySelector('[data-reminder-chip]');
      out.chipShowsDue = !!chip && (chip.textContent || '').indexOf('Due ') === 0;
      const dismissBtn = document.querySelector('[aria-label="Dismiss reminder"]');
      out.dismissVisible = !!dismissBtn;
      const orderBefore = cardH3s().map((h) => h.getAttribute('title'));
      let skeletonSeen = false;
      let motionSeen = false;
      if (dismissBtn) {
        // FIX 10 sampling: during the in-place dismissal the list must NEVER flip to skeleton,
        // a layout transition MUST run (glide, not teleport), and the preview stays mounted.
        dismissBtn.click();
        const t0 = Date.now();
        while (Date.now() - t0 < 1400) {
          if (!skeletonSeen && document.querySelector('.skeleton-shimmer-light,.skeleton-shimmer-dark,.skeleton-shimmer-minimal')) skeletonSeen = true;
          if (!motionSeen) {
            const mw = Array.from(document.querySelectorAll('main div[style]')).find((el) => {
              const s = el.getAttribute('style') || '';
              return s.includes('transform') || s.includes('transition');
            });
            if (mw) motionSeen = true;
          }
          await sleep(60);
        }
        out.chipGoneAfterDismiss = !document.querySelector('[data-reminder-chip]');
        out.dismissGoneAfterDismiss = !document.querySelector('[aria-label="Dismiss reminder"]');
      }
      out.dismissNoSkeletonFlip = !skeletonSeen;
      out.dismissLayoutAnimated = motionSeen;
      out.previewStillMountedAfterDismiss = !!document.querySelector('h2[title="Forever Note"]');
      const orderAfter = cardH3s().map((h) => h.getAttribute('title'));
      out.dismissMutatedExactlyOneCard =
        orderBefore.length === orderAfter.length &&
        orderBefore.filter((t) => t !== 'Forever Note').join('|') === orderAfter.filter((t) => t !== 'Forever Note').join('|');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await sleep(500);
      let meta = await dropsync.drop.getMeta((await dropsync.drop.list('personal')).find((d) => d.name === 'Forever Note').id);
      out.dismissedPersistedLocal = meta.reminderDismissedBy === 'local';
      await dropsync.vault.lock();
      await dropsync.vault.unlock('/tmp/ds-e2e-sit3-vault-B', 'sit3-vault-pw-B');
      meta = await dropsync.drop.getMeta((await dropsync.drop.list('personal')).find((d) => d.name === 'Forever Note').id);
      out.dismissedSurvivesRelock = meta.reminderDismissedBy === 'local' && !!meta.reminderAt;
      let demoted = false;
      for (let i = 0; i < 8 && !demoted; i++) { await sleep(1000); const f = cardH3s()[0]; demoted = !!f && f.getAttribute('title') !== 'Forever Note'; }
      out.demotedAfterDismiss = demoted;

      // ---- FIX 11: zero card pencils; Edit reachable via the right-click context menu ----
      out.cardPencils = document.querySelectorAll('button[aria-label="Edit"]').length;
      const fnCtx = cardH3s().find((h) => h.getAttribute('title') === 'Forever Note');
      if (!fnCtx) { out.contextMenuEdit = 'Forever Note card not found'; return done(out, '2'); }
      fnCtx.closest('.cursor-pointer').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await sleep(400);
      const ctxEditBtn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Edit');
      out.contextMenuEditVisible = !!ctxEditBtn;
      if (ctxEditBtn) {
        ctxEditBtn.click();
        await sleep(800);
        const editorNameInput = Array.from(document.querySelectorAll('input')).find((i) => i.value === 'Forever Note');
        out.contextMenuOpenedEditor = !!editorNameInput;
        const cancelEditorBtn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Cancel');
        if (cancelEditorBtn) cancelEditorBtn.click();
        await sleep(400);
        out.editorClosedClean = !Array.from(document.querySelectorAll('input')).some((i) => i.value === 'Forever Note');
      }

      // ---- FIX 4: YouTube player — offline message, width parity, mount/unmount on toggle ----
      // Lazy lookups: the preview body (and its <pre>) only EXISTS once the target preview is
      // open, so every parity check must query the DOM at its own point in time.
      const textBoxEl = () => { const p = document.querySelector('pre'); return p ? p.parentElement : null; };
      Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => false });
      // NOTE: deliberately NO Navigator.prototype override — stage 2's later ONLINE-path drill
      // restores connectivity by deleting the instance property, which would expose a
      // prototype getter and break it (round-5 regression caught + reverted same round).
      // Bounded retry (round-9 hardening): this was the ONLY single-shot card lookup left in
      // the chain — with vault B grown to 65 records the first paint raced hydration on slow
      // WSL disks and the guard early-returned 'RT Note card not found', silently ending the
      // whole stage chain (no localStorage advance, no reload). Same pattern as the Forever
      // Note loop above.
      let noteH3 = null;
      for (let i = 0; i < 20 && !noteH3; i++) { await sleep(1000); noteH3 = cardH3s().find((h) => h.getAttribute('title') === 'RT Note'); }
      if (!noteH3) { out.youtube = 'RT Note card not found'; return done(out, '2'); }
      noteH3.closest('.cursor-pointer').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(700);
      const watch = document.querySelector('[title="Watch video"]');
      if (!watch) { out.youtube = 'no watch button'; return done(out, '2'); }
      watch.click();
      // Bounded poll (round-5 hardening): a single-shot read at +500 ms raced the render under
      // battery load; the offline GATE is proven by no iframe mounting, the MESSAGE just needs
      // up to 1.5 s to appear.
      let blockedEl = null;
      const wmT0 = Date.now();
      while (Date.now() - wmT0 < 1500) {
        blockedEl = document.querySelector('[data-yt-blocked]');
        if (blockedEl) break;
        await sleep(50);
      }
      // Scoped lookup: an unrelated empty [role=status] elsewhere in the DOM can shadow the
      // modal's message for a document-wide querySelector (round-5 diagnostic finding).
      const statusEl = blockedEl ? blockedEl.querySelector('[role="status"]') : null;
      out.forcedOnlineAtClick = navigator.onLine; // sanity — must read false while overridden
      out.offlineMsg = !!blockedEl && !!statusEl && (statusEl.textContent || '').indexOf("You're offline") >= 0;
      out.offlineMountsNoIframe = !document.querySelector('[data-yt-player]') && document.querySelectorAll('iframe').length === 0;
      // Blocked-message box must span the same width as the text content box above it.
      const blockedBox = blockedEl ? blockedEl.firstElementChild : null;
      const tbNow = textBoxEl();
      out.blockedWidthParity = !!tbNow && !!blockedBox && Math.abs(tbNow.getBoundingClientRect().width - blockedBox.getBoundingClientRect().width) <= 1;
      delete window.navigator.onLine; // back online
      watch.click(); // opens — mounts the embed inside a p-5 bordered rounded wrapper
      await sleep(700);
      const frame = document.querySelector('[data-yt-player]');
      out.playerMounted = !!frame && !!frame.querySelector('iframe');
      out.playerWidthParity = !!frame && frame.className.includes('p-5') && !!(frame.querySelector('.rounded-lg') || frame.querySelector('[class*="rounded"]'));
      // Pixel-truth geometry: are the three panels (text box / YouTube title card / player box)
      // actually the SAME rendered width, and how do their vertical gaps compare?
      const geo = {};
      const oibBtn = document.querySelector('[title="Open in your default browser"]');
      const titleCard = oibBtn ? oibBtn.closest('.p-3') : null;
      const playerBox = frame ? frame.firstElementChild : null;
      const textBox = textBoxEl();
      if (textBox) geo.textBoxW = Math.round(textBox.getBoundingClientRect().width);
      if (titleCard) geo.titleCardW = Math.round(titleCard.getBoundingClientRect().width);
      if (playerBox) geo.playerBoxW = Math.round(playerBox.getBoundingClientRect().width);
      if (textBox && titleCard) geo.gapTextToTitle = Math.round(titleCard.getBoundingClientRect().top - textBox.getBoundingClientRect().bottom);
      if (playerBox && titleCard) geo.gapTitleToPlayer = Math.round(playerBox.getBoundingClientRect().top - titleCard.getBoundingClientRect().bottom);
      out.geometry = geo;
      // HARD parity: the player box must render the SAME width as the content box above it
      // (regression guard for the double-padding bug — class checks are not enough).
      out.playerWidthParity = !!textBox && !!playerBox && Math.abs(geo.textBoxW - geo.playerBoxW) <= 1;
      // Creator labels ('local') must not appear on any drop card (owner request).
      out.creatorLocalBadges = Array.from(document.querySelectorAll('.cursor-pointer h3[title]')).filter((h) => {
        const row = h.parentElement;
        return !!row && Array.from(row.children).some((c) => c !== h && c.textContent.trim() === 'local');
      }).length;
      watch.click(); // closes — unmounts cleanly (no orphan playback)
      await sleep(700);
      out.playerUnmountsClean = !document.querySelector('[data-yt-player] iframe');
      out.iframesAfterClose = document.querySelectorAll('iframe').length;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await sleep(500);
      out.escClosedPreview = !document.querySelector('[title="Watch video"]');

      // ---- FIX 8: instant Back via the payload cache; edit invalidation; FIX 9 in-place save ----
      await dropsync.dev.testOnly('resetPayloadFetchCount', '');
      const rnH3 = cardH3s().find((h) => h.getAttribute('title') === 'RT Note');
      if (!rnH3) { out.cacheDrill = 'RT Note card not found'; return done(out, '2'); }
      rnH3.closest('.cursor-pointer').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(700);
      const fetchCount = async () => (await dropsync.dev.testOnly('payloadFetchStats', '')).count;
      const afterOpen = await fetchCount(); // expect 1 — real open pays one fetch
      const findMention = () => Array.from(document.querySelectorAll('pre *')).filter((e) => e.children.length === 0 && /^RT Target( X)?$/.test((e.textContent || '').trim()))[0];
      const mentionEl = findMention();
      if (!mentionEl) { out.cacheDrill = 'mention chip not found'; return done(out, '2'); }
      mentionEl.click();
      await sleep(700);
      const afterMention = await fetchCount(); // expect 2 — B is a different drop
      const backBtn = document.querySelector('[title="Back"], [aria-label="Back"]');
      backBtn.click();
      await sleep(250); // short window — a refetch could never land this fast
      const afterBack = await fetchCount();
      out.backZeroFetch = afterBack === afterMention;
      const backPre = document.querySelector('pre');
      out.backRestoredContent = !!backPre && (backPre.textContent || '').indexOf('RT Target') >= 0;
      out.backNoLoadingFrame = !!backPre; // the skeleton replaces the body while loading
      // __STAGE2R_SAVE__
      // Forward to B again (cached — zero fetch), then drive the REAL edit path: preview Edit →
      // change the payload TEXT → Save. Behavioral invalidation proof: the auto-reopened
      // preview must show the NEW body (a stale cache hit would serve the OLD one), and a
      // Back→Forward round-trip must serve the refreshed cache. (Fetch-count arithmetic is
      // deliberately NOT used here — dev StrictMode double-fires effect fetches.)
      const mentionEl2 = findMention(); // fresh query — Back re-rendered the body
      if (!mentionEl2) { out.saveDrill = 'mention chip not found (2)'; return done(out, '2'); }
      mentionEl2.click();
      await sleep(700);
      const previewEditBtn = document.querySelector('[title="Edit"]');
      out.previewEditReachable = !!previewEditBtn;
      const cardSnap = () => cardH3s().map((h) => h.closest('.cursor-pointer').outerHTML);
      const htmlBefore = cardSnap();
      previewEditBtn.click();
      await sleep(900);
      const bodyEditable = document.querySelector('[role="textbox"][aria-multiline="true"]');
      if (!bodyEditable) { out.saveDrill = 'editor not found'; return done(out, '2'); }
      const oldBody = (bodyEditable.textContent || '').trim();
      const newBody = oldBody.indexOf('v2') >= 0 ? oldBody.replace(' v2', '') : oldBody + ' v2';
      bodyEditable.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, newBody);
      await sleep(300);
      document.querySelector('form button[type="submit"]').click();
      let saveSkel = false;
      const st0 = Date.now();
      while (Date.now() - st0 < 1600) {
        if (!saveSkel && document.querySelector('.skeleton-shimmer-light,.skeleton-shimmer-dark,.skeleton-shimmer-minimal')) saveSkel = true;
        await sleep(50);
      }
      await sleep(700); // preview reopens with the patched record
      out.saveNoSkeletonFlip = !saveSkel;
      const htmlAfter = cardSnap();
      out.saveMutatedExactlyOneCard =
        htmlBefore.length === htmlAfter.length &&
        htmlBefore.filter((h, i) => h !== htmlAfter[i]).length === 1;
      const reopenedPre = document.querySelector('pre');
      out.editServesFreshContent = !!reopenedPre && (reopenedPre.textContent || '').indexOf(newBody) >= 0;
      // Cache still FUNCTIONS after invalidation: close, then re-open the SAME drop from its
      // card — the refreshed entry (new body) must be served. (FIX 18 note: since the round-5
      // editor→preview round trip, a save REOPENS the preview keeping the trail tail-replaced
      // instead of emptied — web parity — so this drill may see a live Back button here; it
      // asserts nothing about it.)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await sleep(400);
      const reCard = cardH3s().find((h) => /^RT Target( X)?$/.test(h.getAttribute('title') || ''));
      if (!reCard) { out.cacheRefresh = 'card not found'; return done(out, '2'); }
      reCard.closest('.cursor-pointer').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(500);
      const forwardPre = document.querySelector('pre');
      out.forwardServesRefreshedCache = !!forwardPre && (forwardPre.textContent || '').indexOf(newBody) >= 0;
      // ---- Edge clause: ZERO native <select> elements anywhere in the renderer ----
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await sleep(400);
      out.nativeSelectsAnywhere = document.querySelectorAll('select').length;
      await openMenu();
      const gearBtn = document.querySelector('header .absolute.top-full button[title*="Personal options"]');
      gearBtn.click();
      await sleep(250);
      const impItem = Array.from(document.querySelectorAll('header .absolute.top-full button')).find((b) => (b.textContent || '').includes('Import backup'));
      impItem.click();
      await sleep(800);
      out.importModalOpened = !!Array.from(document.querySelectorAll('h2')).find((h) => (h.textContent || '').includes('Import backup'));
      out.nativeSelectsInImportModal = document.querySelectorAll('select').length;
      const impClose = document.querySelector('button[aria-label="Close"]');
      if (impClose) impClose.click();
      await sleep(400);
      out.importModalClosed = !Array.from(document.querySelectorAll('h2')).find((h) => (h.textContent || '').includes('Import backup'));
      localStorage.setItem('dropsync.sit3.dom', '3');
      setTimeout(() => location.reload(), 50);
      return done(out, '2');
    }
    if (stage === '3') {
      // ---- STAGE 3: FIX 13 (silent deletes) + FIX 14 (hover-prefetch first click) ----
      let cards3 = [];
      for (let i = 0; i < 24 && cards3.length < 5; i++) { await sleep(500); cards3 = cardH3s(); }
      out.hydratedCards3 = cards3.length;
      const mk = async (name, body) => { const r = await dropsync.drop.createText({ spaceId: 'personal', name: name, content: body, categories: [], expirationOption: 'forever', locked: false, reminderAt: null }); return r.id; };
      await mk('Prefetch Drill', 'prefetch body text');
      const cdId = await mk('Cold Drill', 'cold body text');
      await mk('Silent Drill', 'silent body text');
      const killId = await mk('Kill Drill', 'kill body text');
      await openMenu();
      const wsRow3 = Array.from(document.querySelectorAll('header .absolute.top-full div')).find((el) => el.className.indexOf('cursor-pointer') >= 0 && (el.textContent || '').trim() === 'RT WS');
      if (wsRow3) { wsRow3.click(); await sleep(900); }
      await openMenu();
      const persBtn3 = Array.from(document.querySelectorAll('header .absolute.top-full button')).find((el) => (el.textContent || '').trim() === 'Personal');
      persBtn3.click();
      await sleep(1000);
      let seeded3 = 0;
      for (let i = 0; i < 24 && seeded3 < 4; i++) { await sleep(500); seeded3 = cardH3s().filter((h) => / Drill$/.test(h.getAttribute('title') || '')).length; }
      // Count can race the refetch; the authoritative proof is that each named drill is
      // individually found and driven below (hoverWarm/cold/preview/silent all resolve).
      out.drillsSeeded = seeded3 >= 4;
      // ---- STAGE 3 helpers ----
      const cardByName = (name) => {
        const h = cardH3s().find((x) => (x.getAttribute('title') || '') === name);
        return h ? h.closest('.cursor-pointer') : null;
      };
      const modalSkeletonSeen = () => !!document.querySelector('.fixed.inset-0 [class*="animate-pulse"]');
      const listSkeletonSeen = () => !!document.querySelector('.skeleton-shimmer-light,.skeleton-shimmer-dark,.skeleton-shimmer-minimal');
      window.__hoverErrCount = 0;
      window.addEventListener('error', () => { window.__hoverErrCount += 1; });

      // ---- FIX 14a: hover ≥300 ms → click ⇒ warm cache hit, ZERO loading frame ----
      const pdCard = cardByName('Prefetch Drill');
      if (!pdCard) { out.fix14 = 'Prefetch Drill missing'; return done(out, '3'); }
      pdCard.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      pdCard.dispatchEvent(new MouseEvent('mouseenter'));
      await sleep(450);
      let warmSkel = false;
      let warmContent = false;
      const w0 = Date.now();
      pdCard.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      while (Date.now() - w0 < 900) {
        if (modalSkeletonSeen()) warmSkel = true;
        if (!warmContent) {
          const wp = document.querySelector('.fixed.inset-0 pre');
          if (wp && (wp.textContent || '').indexOf('prefetch body') >= 0) warmContent = true;
        }
        await sleep(30);
      }
      out.hoverWarmClickNoSkeleton = !warmSkel;
      out.hoverWarmContentLoadedFast = warmContent;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await sleep(400);

      // ---- FIX 14b: cold click (no hover) ⇒ at most one brief skeleton, then content ----
      const cdCard = cardByName('Cold Drill');
      if (!cdCard) { out.fix14b = 'Cold Drill missing'; return done(out, '3'); }
      out.coldCacheColdBefore = window.__previewCacheHas ? !window.__previewCacheHas(cdId) : 'no probe';
      let coldSkel = false;
      let coldContent = false;
      const c0 = Date.now();
      cdCard.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      while (Date.now() - c0 < 1500) {
        if (modalSkeletonSeen()) coldSkel = true;
        if (!coldContent) {
          const cp = document.querySelector('.fixed.inset-0 pre');
          if (cp && (cp.textContent || '').indexOf('cold body') >= 0) coldContent = true;
        }
        await sleep(25);
      }
      out.coldClickShowsBriefSkeleton = coldSkel;
      out.coldContentLoaded = coldContent;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await sleep(400);

      // ---- FIX 14c: rapid sweep-hover across the visible cards ⇒ no error spam; LRU ≤ 10 ----
      for (const h of cardH3s().slice(0, 12)) {
        const hc = h.closest('.cursor-pointer');
        hc.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        hc.dispatchEvent(new MouseEvent('mouseenter'));
        await sleep(20);
      }
      await sleep(800);
      out.sweepNoErrors = window.__hoverErrCount === 0;
      const sizeNow = window.__previewCacheSize ? window.__previewCacheSize() : -1;
      out.cacheSizeObserved = sizeNow;
      out.lruCapHolds = sizeNow === -1 ? 'no probe' : sizeNow <= 10;
      // ---- FIX 13a+c: single delete WITH the preview OPEN (real UI path, JS-driven since the
      // modal overlays the cards): tombstone animation + zero skeleton; undo restores animated;
      // letting the window expire commits silently AND closes the previewed drop gracefully. ----
      const pkCard = cardByName('Kill Drill');
      if (!pkCard) { out.fix13 = 'Kill Drill missing'; return done(out, '3'); }
      const listBefore = (await dropsync.drop.list('personal')).length;
      pkCard.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(800);
      const previewH2 = () => Array.from(document.querySelectorAll('.fixed.inset-0 h2')).find((h) => (h.getAttribute('title') || '') === 'Kill Drill');
      out.previewOpenedForKill = !!previewH2();
      const anyMotionStyle = () => !!Array.from(document.querySelectorAll('main div[style]')).find((el) => {
        const s = el.getAttribute('style') || '';
        return s.indexOf('transform') >= 0 || s.indexOf('transition') >= 0;
      });
      const delViaCardButtons = async () => {
        const cardEl = cardByName('Kill Drill');
        cardEl.querySelector('button[title="Delete"]').click();
        await sleep(250);
        Array.from(cardEl.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Delete').click();
      };
      const undoBtn = () => Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Undo');
      // First delete: watch the undo window behave, then UNDO.
      let dSkel = false;
      let dMotion = false;
      const d0 = Date.now();
      await delViaCardButtons();
      while (Date.now() - d0 < 1500) {
        if (listSkeletonSeen()) dSkel = true;
        if (!dMotion && anyMotionStyle()) dMotion = true;
        await sleep(50);
      }
      out.deleteNoSkeletonFlip = !dSkel;
      out.tombstoneAnimatedOut = dMotion;
      out.undoToastVisible = !!undoBtn();
      out.previewSurvivesUndoWindow = !!previewH2();
      let uMotion = false;
      const u0 = Date.now();
      undoBtn().click();
      while (Date.now() - u0 < 1200) {
        if (!uMotion && anyMotionStyle()) uMotion = true;
        if (cardByName('Kill Drill')) break;
        await sleep(50);
      }
      out.undoRestoredCardAnimated = uMotion && !!cardByName('Kill Drill');
      // Second delete: let the 30 s window expire — the commit must be SILENT (zero visual
      // event behind the tombstone) and the previewed deleted drop must close gracefully.
      await delViaCardButtons();
      await sleep(600);
      out.reclosedHiddenDuringWindow = !cardByName('Kill Drill');
      let cSkel = false;
      const x0 = Date.now();
      while (Date.now() - x0 < 31500) {
        if (listSkeletonSeen()) cSkel = true;
        await sleep(200);
      }
      out.commitSilentNoSkeleton = !cSkel;
      out.commitRemovedExactlyOneId = (await dropsync.drop.list('personal')).length === listBefore - 1;
      out.commitStaysHidden = !cardByName('Kill Drill');
      out.toastGoneAfterCommit = !undoBtn();
      out.previewClosedByDeleteGracefully = !previewH2();

      // ---- FIX 13b: bulk two-tap → one batched removal, zero skeleton ----
      const selB = Array.from(document.querySelectorAll('main button')).find((b) => (b.textContent || '').trim() === 'Select');
      selB.click();
      await sleep(300);
      const tickB = (name) => cardByName(name).querySelector('button.w-10.h-10');
      tickB('Prefetch Drill').click();
      await sleep(150);
      tickB('Cold Drill').click();
      await sleep(150);
      const bulkDelBtn = () => Array.from(document.querySelectorAll('main button')).find((b) => ['Delete 2', 'Confirm delete 2'].includes((b.textContent || '').trim()));
      bulkDelBtn().click(); // arm
      await sleep(250);
      let bSkel = false;
      const b0 = Date.now();
      bulkDelBtn().click(); // commit
      while (Date.now() - b0 < 1300) {
        if (listSkeletonSeen()) bSkel = true;
        await sleep(40);
      }
      out.bulkBatchNoSkeleton = !bSkel;
      out.bulkBothRemoved = !cardByName('Prefetch Drill') && !cardByName('Cold Drill');
      out.bulkCountExactMinusTwo = (await dropsync.drop.list('personal')).length === listBefore - 3;
      localStorage.setItem('dropsync.sit3.dom', '4');
      setTimeout(() => location.reload(), 50);
      out.stage = '3';
      return JSON.stringify(out);
    }
    if (stage === '4') {
      // ---- STAGE 4: FIX 15 (batch removal choreography) + FIX 16 (stable media URLs) ----
      let cards4 = [];
      for (let i = 0; i < 24 && cards4.length < 5; i++) { await sleep(500); cards4 = cardH3s(); }
      out.hydratedCards4 = cards4.length;
      const mk4 = async (name, body, imagePath) => {
        const args = { spaceId: 'personal', name: name, content: body, categories: [], expirationOption: 'forever', locked: false, reminderAt: null };
        if (imagePath) args.imagePath = imagePath;
        const r = await dropsync.drop.createText(args);
        return r.id;
      };
      await mk4('Batch A Drill', 'batch a body');
      await mk4('Batch B Drill', 'batch b body');
      await mk4('Batch C Drill', 'batch c body');
      const imgId = await mk4('Img Drill', 'img drill body', '/tmp/opencode/e2e/small.png');
      await openMenu();
      const wsRow4 = Array.from(document.querySelectorAll('header .absolute.top-full div')).find((el) => el.className.indexOf('cursor-pointer') >= 0 && (el.textContent || '').trim() === 'RT WS');
      if (wsRow4) { wsRow4.click(); await sleep(900); }
      await openMenu();
      const persBtn4 = Array.from(document.querySelectorAll('header .absolute.top-full button')).find((el) => (el.textContent || '').trim() === 'Personal');
      persBtn4.click();
      await sleep(1000);
      let drills4 = 0;
      for (let i = 0; i < 24 && drills4 < 4; i++) {
        await sleep(500);
        drills4 = cardH3s().filter((h) => ['Batch A Drill', 'Batch B Drill', 'Batch C Drill', 'Img Drill'].includes(h.getAttribute('title') || '')).length;
      }
      out.drillsSeeded4 = drills4 === 4;
      // ---- helpers ----
      const cardByName = (name) => {
        const h = cardH3s().find((x) => (x.getAttribute('title') || '') === name);
        return h ? h.closest('.cursor-pointer') : null;
      };
      const listSkeletonSeen = () => !!document.querySelector('.skeleton-shimmer-light,.skeleton-shimmer-dark,.skeleton-shimmer-minimal');
      window.__hoverErrCount4 = 0;
      window.addEventListener('error', () => { window.__hoverErrCount4 += 1; });

      // ---- FIX 16: stable media URLs (bridge-level, BEFORE any edits/deletions) ----
      // NOTE: createText(imagePath=…) stores the payload in the IMAGE slot for text drops.
      const uA = await dropsync.media.getUrl(imgId, 'image');
      const uB = await dropsync.media.getUrl(imgId, 'image');
      out.repeatCallIdenticalUrl = typeof uA === 'string' && uA === uB;
      // Preview <img> src must equal the card thumbnail src — shared token proven in DOM.
      const cardImgEl = () => {
        const ic = cardByName('Img Drill');
        const im = ic ? ic.querySelector('img') : null;
        return im && (im.getAttribute('src') || '').indexOf('media://r/') === 0 ? im : null;
      };
      let g16 = 0;
      while (!cardImgEl() && g16++ < 20) await sleep(200);
      const cardSrc = cardImgEl() ? cardImgEl().getAttribute('src') : null;
      cardByName('Img Drill').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(800);
      const modalImgSrc = () => {
        const m = Array.from(document.querySelectorAll('.fixed.inset-0 img')).find((i) => (i.getAttribute('src') || '').indexOf('media://r/') === 0);
        return m ? m.getAttribute('src') : null;
      };
      out.previewSrcEqualsCardSrc = !!cardSrc && cardSrc === modalImgSrc();
      out.cardSrcWasPresent = !!cardSrc;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await sleep(400);
      // Edit replaces the vblob ⇒ new composite ⇒ different URL (stale pixels impossible).
      await dropsync.drop.updateContent(imgId, { imagePath: '/tmp/opencode/e2e/small.png' });
      const uC = await dropsync.media.getUrl(imgId, 'image');
      out.urlChangesAfterEdit = typeof uC === 'string' && uC !== uA;
      // Session scoping: lock wipes tokens; locked getUrl rejects; unlock mints a NEW one.
      await dropsync.dev.testOnly('vaultLock', '');
      let lockedRejected = false;
      try { await dropsync.media.getUrl(imgId, 'image'); } catch (e) { lockedRejected = true; }
      await dropsync.dev.testOnly('vaultUnlock', '');
      const postUnlock = await dropsync.media.getUrl(imgId, 'image');
      out.sessionScopedTokens = lockedRejected && typeof postUnlock === 'string' && postUnlock !== uC;
      // Unknown/expired token still rejected.
      let bogusOk = true;
      try { bogusOk = (await fetch('media://r/ffffffffffffffffffffffffffffffff')).ok; } catch (e) { bogusOk = false; }
      out.unknownTokenRejected = !bogusOk;
      // Non-image binary path intact + equally stable.
      const fileDrop = (await dropsync.drop.list('personal')).find((d) => d.type === 'file');
      if (fileDrop) {
        const f1 = await dropsync.media.getUrl(fileDrop.id, 'file');
        const f2 = await dropsync.media.getUrl(fileDrop.id, 'file');
        out.fileDropStableUrl = f1 !== null && f1 === f2;
      }
      // __STAGE4_FIX15__
      // ---- FIX 15: batch removal choreography (web-parity sequence + exits) ----
      const selectBtn4 = () => Array.from(document.querySelectorAll('main button')).find((b) => (b.textContent || '').trim() === 'Select');
      const tick4 = (name) => cardByName(name).querySelector('button.w-10.h-10');
      const runBatch = async (names, labels) => {
        selectBtn4().click();
        await sleep(300);
        for (const n of names) { tick4(n).click(); await sleep(150); }
        const bulkBtn = () => Array.from(document.querySelectorAll('main button')).find((b) => labels.indexOf((b.textContent || '').trim()) >= 0);
        bulkBtn().click(); // arm
        await sleep(220);
        const armedLabel = bulkBtn() ? (bulkBtn().textContent || '').trim() : '';
        let sawDeleting = false;
        const labelsSeen = [];
        const fx = { exitOpacity: false, exitScale: false, layoutShift: false, popLayout: false };
        let skel = false;
        const nodeA = cardByName(names[0]);
        const wrapA = nodeA ? nodeA.parentElement : null;
        window.__wrapperProbe = nodeA && nodeA.parentElement ? String(nodeA.parentElement.className) : 'NO_PARENT';
        window.__animContainerProbe = !!document.querySelector('main div.relative.p-3');
        window.__motionProbe = document.querySelectorAll('main [data-projection-id]').length;
        const survivorEl = cardByName('Forever Note');
        const survTop0 = survivorEl ? survivorEl.getBoundingClientRect().top : -1;
        const t0 = Date.now();
        if (bulkBtn()) bulkBtn().click(); // confirm
        // Busy-spin the first 45 ms: blocks the renderer thread so queued work cannot land
        // mid-probe; captures exactly which button labels are observable in this window.
        const spinEnd = Date.now() + 45;
        const spinSeen = [];
        while (Date.now() < spinEnd) {
          const sb = bulkBtn();
          if (sb) {
            const sl = (sb.textContent || '').trim();
            if (labels.indexOf(sl) >= 0 && spinSeen.indexOf(sl) < 0) spinSeen.push(sl);
            if (sl === 'Deleting...') sawDeleting = true;
          }
        }
        let detachMs = -1;
        let exitStartMs = -1;
        let sawScaledMatrix = false;
        while (Date.now() - t0 < 1600) {
          if (detachMs < 0 && nodeA && !nodeA.isConnected) detachMs = Date.now() - t0;
          // Mechanism-agnostic exit probe on the WRAPPER (the motion.div animates, not the card).
          if (wrapA && wrapA.isConnected) {
            const cs = window.getComputedStyle(wrapA);
            const co = parseFloat(cs.opacity);
            if (!isNaN(co) && co < 0.995) {
              fx.exitOpacity = true;
              if (exitStartMs < 0) exitStartMs = Date.now() - t0;
            }
            const tv = cs.transform;
            if (tv && tv !== 'none') {
              if (tv.indexOf('matrix(') === 0) {
                const m0 = parseFloat(tv.slice(7));
                if (!isNaN(m0) && m0 < 0.995) { sawScaledMatrix = true; }
              } else if (tv.indexOf('scale') >= 0) {
                sawScaledMatrix = true;
              }
            }
            if (sawScaledMatrix) fx.exitScale = true;
          }
          if (wrapA && !wrapA.isConnected && detachMs < 0) detachMs = Date.now() - t0;
          const bb = bulkBtn();
          if (bb) {
            const lab = (bb.textContent || '').trim();
            if (labels.indexOf(lab) >= 0 && labelsSeen.indexOf(lab) < 0) labelsSeen.push(lab);
            if (lab === 'Deleting...') sawDeleting = true;
          }
          if (listSkeletonSeen()) skel = true;
          // Exits run through WAAPI in motion v11+ (no inline styles) — read the animation
          // registry, not style attributes. Survivor glide via live rect delta.
          if (!fx.exitOpacity || !fx.exitScale) {
            const anims = document.getAnimations ? document.getAnimations() : [];
            for (const a of anims) {
              try {
                const eff = a.effect;
                const tgt = eff && eff.target;
                if (!tgt || !tgt.closest || !tgt.closest('main')) continue;
                const kfs = eff.getKeyframes ? eff.getKeyframes() : [];
                let hasOp = false;
                let hasSc = false;
                for (const k of kfs) {
                  const ov = k.opacity;
                  if (ov !== undefined && ov !== null && ov !== 1 && ov !== '1') hasOp = true;
                  const tv = k.transform;
                  if (typeof tv === 'string' && tv.indexOf('scale(0.9') >= 0) hasSc = true;
                }
                if (hasOp) fx.exitOpacity = true;
                if (hasSc) fx.exitScale = true;
              } catch (e) { /* cross-origin or finished */ }
            }
          }
          if (!fx.popLayout && document.querySelector('main div[aria-hidden="true"]')) fx.popLayout = true;
          if (survivorEl && survTop0 >= 0 && Math.abs(survivorEl.getBoundingClientRect().top - survTop0) > 4) fx.layoutShift = true;
          await sleep(Date.now() - t0 < 600 ? 6 : 40);
        }
        return { armedLabel: armedLabel, sawDeleting: sawDeleting, fx: fx, skel: skel, labels: labelsSeen, detachMs: detachMs, spin: spinSeen, exitStartMs: exitStartMs };
      };
      const twoRes = await runBatch(['Batch A Drill', 'Batch B Drill'], ['Delete 2', 'Confirm delete 2', 'Deleting...']);
      out.motionNodesInList = window.__motionProbe;
      out.wrapperProbe = String(window.__wrapperProbe);
      out.animContainerProbe = !!window.__animContainerProbe;
      out.sysReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      // One-shot dump of the live animation registry right after confirm (diagnostic).
      if (!window.__animDump) {
        const anims = document.getAnimations ? document.getAnimations() : [];
        if (anims.length > 0) {
          const parts = [];
          for (let ai = 0; ai < anims.length && ai < 3; ai++) {
            try {
              const tgt = anims[ai].effect && anims[ai].effect.target;
              const kf = anims[ai].effect && anims[ai].effect.getKeyframes ? anims[ai].effect.getKeyframes() : null;
              parts.push(JSON.stringify({ c: tgt ? String(tgt.className).slice(0, 30) : null, k: kf }));
            } catch (e) { parts.push('ERR'); }
          }
          window.__animDump = anims.length + ' | ' + parts.join(' ;; ');
        } else {
          window.__animDump = '0 | none-yet';
        }
      }
      out.animDump = String(window.__animDump).slice(0, 600);
      out.armToConfirmSequence = twoRes.armedLabel === 'Confirm delete 2';
      out.deletingLabelsBatch = twoRes.labels.join(',');
      out.spinLabelsBatch = twoRes.spin.join(',');
      out.buttonDeletingStateObserved = twoRes.sawDeleting;
      out.batchExitShrinkFade = twoRes.fx.exitOpacity && twoRes.fx.exitScale;
      out.batchPopLayoutEngaged = twoRes.fx.popLayout;
      out.neighborsGlidedClosed = twoRes.fx.layoutShift;
      out.batchNoSkeletonFlip = !twoRes.skel;
      out.batchDetachMs = twoRes.detachMs;
      out.batchExitStartMs = twoRes.exitStartMs;
      out.batchBothGone = !cardByName('Batch A Drill') && !cardByName('Batch B Drill');
      out.selectionExitedAfterBatch = !!selectBtn4();
      // ONE selected item must be visually indistinguishable from many.
      const oneRes = await runBatch(['Batch C Drill'], ['Delete 1', 'Confirm delete 1', 'Deleting...']);
      out.singleArmToConfirm = oneRes.armedLabel === 'Confirm delete 1';
      out.singleDeletingStateObserved = oneRes.sawDeleting;
      out.singleSignatureMatchesMany = oneRes.fx.exitOpacity && oneRes.fx.exitScale && oneRes.fx.layoutShift;
      out.singleNoSkeletonFlip = !oneRes.skel;
      out.singleDetachMs = oneRes.detachMs;
      out.singleCardGone = !cardByName('Batch C Drill');
      // Reduced-motion path: forced flag ⇒ plain branch ⇒ opacity-only quick fade, no scale.
      window.__dropsyncForceReducedMotion = true;
      const rmRes = await runBatch(['Img Drill'], ['Delete 1', 'Confirm delete 1', 'Deleting...']);
      window.__dropsyncForceReducedMotion = false;
      out.reducedMotionNoScaleExit = rmRes.fx.exitOpacity && !rmRes.fx.exitScale;
      out.reducedMotionCardGone = !cardByName('Img Drill');
      out.reducedMotionNoSkeleton = !rmRes.skel;

      // ---- FIX 15: drag-reorder still native after wrapping ----
      const sortTrigger = () => document.querySelector('button[aria-haspopup="menu"]');
      sortTrigger().click();
      await sleep(250);
      const manualItem = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Manual');
      manualItem.click();
      await sleep(400);
      const titlesBefore = cardH3s().map((h) => h.getAttribute('title') || '');
      const wrapWithGrip = cardH3s().map((h) => h.closest('.cursor-pointer')).find((c) => c && c.querySelector('button[title="Drag to reorder"]'));
      const grip = wrapWithGrip.querySelector('button[title="Drag to reorder"]');
      const gr = grip.getBoundingClientRect();
      const pe = (x, y, type) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1 });
      grip.dispatchEvent(pe(gr.x + 3, gr.y + 8, 'pointerdown'));
      await sleep(90);
      let sortableEngaged = false;
      for (let step = 1; step <= 9; step++) {
        document.dispatchEvent(pe(gr.x + 3, gr.y + 8 + step * 13, 'pointermove'));
        await sleep(55);
        if (!sortableEngaged) {
          const draggingEl = document.querySelector('div[style*="z-index: 50"], div[style*="z-index:50"]');
          if (draggingEl && (draggingEl.getAttribute('style') || '').indexOf('translate3d') >= 0) sortableEngaged = true;
        }
      }
      out.dragSortableEngagedAfterWrap = sortableEngaged;
      document.dispatchEvent(pe(gr.x + 3, gr.y + 125, 'pointerup'));
      await sleep(700);
      const titlesAfter = cardH3s().map((h) => h.getAttribute('title') || '');
      out.dragReorderedList = titlesBefore.join('|') !== titlesAfter.join('|');

      // ---- FIX 16: mixed sweep-hover ⇒ no errors; token maps sane ----
      for (const h of cardH3s().slice(0, 12)) {
        const hc = h.closest('.cursor-pointer');
        hc.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        hc.dispatchEvent(new MouseEvent('mouseenter'));
        await sleep(20);
      }
      await sleep(800);
      out.sweepNoErrors16 = window.__hoverErrCount4 === 0;
      const stats16 = await dropsync.dev.testOnly('mediaStats', '');
      out.tokenMapSane = stats16.tokens === stats16.keys && stats16.tokens <= 64;
      localStorage.setItem('dropsync.sit3.dom', '5');
      setTimeout(() => location.reload(), 50);
      out.stage = '4';
      return JSON.stringify(out);
    }
    if (stage === '5') {
      // ---- STAGE 5: FIX 17 (batch ≡ single deletion pipeline) + FIX 18 (leaving the editor ALWAYS returns to the drop's view) ----
      let cards5 = [];
      for (let i = 0; i < 24 && cards5.length < 3; i++) { await sleep(500); cards5 = cardH3s(); }
      out.hydratedCards5 = cards5.length;
      const mk5 = async (name, content) => { const r = await dropsync.drop.createText({ spaceId: 'personal', name: name, content: content, categories: [], expirationOption: 'forever', locked: false, reminderAt: null }); return r.id; };
      // Tail Drill seeds FIRST so it displays at the BOTTOM of the newest-first list — giving
      // Solo Drill (displayed lowest of the FIX-17 targets) a real sliding neighbor below it.
      await mk5('F17 Tail Drill', 'tail body');
      await mk5('Solo Drill', 'solo body text');
      await mk5('Eq One Drill', 'eq one body');
      await mk5('Eq Two A Drill', 'eq two a body');
      await mk5('Eq Two B Drill', 'eq two b body');
      const rtId5 = await mk5('Round Trip Drill', 'round trip original body');
      void rtId5;
      await mk5('Trail Anchor Drill', 'anchor leading see #[Round Trip Drill](' + rtId5 + ') end');
      await openMenu();
      const wsRow5 = Array.from(document.querySelectorAll('header .absolute.top-full div')).find((el) => el.className.indexOf('cursor-pointer') >= 0 && (el.textContent || '').trim() === 'RT WS');
      if (wsRow5) { wsRow5.click(); await sleep(900); }
      await openMenu();
      const persBtn5 = Array.from(document.querySelectorAll('header .absolute.top-full button')).find((el) => (el.textContent || '').trim() === 'Personal');
      persBtn5.click();
      await sleep(1000);
      const drillsWanted5 = ['Solo Drill', 'Eq One Drill', 'Eq Two A Drill', 'Eq Two B Drill', 'Round Trip Drill', 'Trail Anchor Drill'];
      let drills5 = 0;
      for (let i = 0; i < 24 && drills5 < 6; i++) {
        await sleep(500);
        drills5 = cardH3s().filter((h) => drillsWanted5.includes(h.getAttribute('title') || '')).length;
      }
      out.drillsSeeded5 = drills5 === 6;
      const cardByName5 = (name) => {
        const h = cardH3s().find((x) => (x.getAttribute('title') || '') === name);
        return h ? h.closest('.cursor-pointer') : null;
      };
      const listSkeletonSeen5 = () => !!document.querySelector('.skeleton-shimmer-light,.skeleton-shimmer-dark,.skeleton-shimmer-minimal');
      const undoBtn5 = () => Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Undo');
      window.__hoverErrCount5 = 0;
      window.addEventListener('error', () => { window.__hoverErrCount5 += 1; });

      // ---- FIX 17: identical removal choreography — single vs batch-of-1 vs batch-of-N ----
      // Probe ONE removal from its confirm-click t0. The motion wrapper is the DIRECT child of
      // the relative p-3 list container in the unified tree (FIX 15 + round-5 relative rider),
      // valid in every mode. Motion v12 may run exits through WAAPI without inline styles, so —
      // round-4 battery lesson — read BOTH getComputedStyle on the WRAPPER and the WAAPI
      // registry's keyframes; never style attributes.
      const probeRemoval5 = async (probeName, fireConfirm) => {
        const node = cardByName5(probeName);
        if (!node) return { missing: true };
        const container = document.querySelector('main div.relative.p-3');
        const wrap = container ? Array.from(container.children).find((c) => c.contains(node)) : null;
        // Survivor = the card DIRECTLY BELOW the target in display order — it slides up when
        // the target leaves, so the glide probe has a deterministic signal for every path.
        const titlesNow = cardH3s().map((h) => h.getAttribute('title') || '');
        const targetIdx = titlesNow.indexOf(probeName);
        const belowTitle = targetIdx >= 0 && targetIdx + 1 < titlesNow.length ? titlesNow[targetIdx + 1] : null;
        const survivorEl = belowTitle ? cardByName5(belowTitle) : null;
        const survTop0 = survivorEl ? survivorEl.getBoundingClientRect().top : -1;
        let exitStartMs = -1; let detachMs = -1; let sawScale = false; let sawOpacity = false;
        let skel = false; let toast = false; let glide = false; let animStartMs = -1;
        const t0 = Date.now();
        fireConfirm(); // SYNCHRONOUS dispatch of the commit click — the probe starts at t≈0
        const scanAnims = () => {
          const anims = document.getAnimations ? document.getAnimations() : [];
          for (const a of anims) {
            try {
              const eff = a.effect;
              const tgt = eff && eff.target;
              if (!tgt || tgt !== wrap) continue;
              const kfs = eff.getKeyframes ? eff.getKeyframes() : [];
              let hasOp = false; let hasSc = false;
              for (const k of kfs) {
                const ov = k.opacity;
                if (ov !== undefined && ov !== null && ov !== 1 && ov !== '1') hasOp = true;
                const tv = k.transform;
                if (typeof tv === 'string' && tv.indexOf('scale(0.9') >= 0) hasSc = true;
              }
              if ((hasOp || hasSc) && animStartMs < 0) animStartMs = Math.round(a.currentTime || 0);
              if (hasOp) { sawOpacity = true; if (exitStartMs < 0) exitStartMs = Date.now() - t0; }
              if (hasSc) sawScale = true;
            } catch (e) { /* finished or inaccessible */ }
          }
        };
        while (Date.now() - t0 < 1600) {
          if (detachMs < 0 && !node.isConnected) detachMs = Date.now() - t0;
          if (wrap && wrap.isConnected) {
            const cs = window.getComputedStyle(wrap);
            const co = parseFloat(cs.opacity);
            if (!isNaN(co) && co < 0.995) { sawOpacity = true; if (exitStartMs < 0) exitStartMs = Date.now() - t0; }
            const tv = cs.transform;
            if (tv && tv.indexOf('matrix(') === 0) { const m0 = parseFloat(tv.slice(7)); if (!isNaN(m0) && m0 < 0.995) sawScale = true; }
            else if (tv && tv.indexOf('scale') >= 0) sawScale = true;
          }
          if (!sawOpacity || !sawScale) scanAnims();
          if (!toast && undoBtn5()) toast = true;
          if (listSkeletonSeen5()) skel = true;
          if (survivorEl && survTop0 >= 0 && Math.abs(survivorEl.getBoundingClientRect().top - survTop0) > 4) glide = true;
          if (detachMs >= 0 && Date.now() - t0 > 700) break;
          await sleep(Date.now() - t0 < 600 ? 6 : 30);
        }
        return { exitStartMs: exitStartMs, detachMs: detachMs, scale: sawScale, opacity: sawOpacity, skel: skel, toast: toast, glide: glide, animStartCurrentTimeMs: animStartMs };
      };
      // BATCH-OF-1 first (no undo toast can exist yet — keeps its toast=false meaningful).
      const selectBtn5 = () => Array.from(document.querySelectorAll('main button')).find((b) => (b.textContent || '').trim() === 'Select');
      const tick5 = (name) => cardByName5(name).querySelector('button.w-10.h-10');
      selectBtn5().click();
      await sleep(300);
      tick5('Eq One Drill').click();
      await sleep(150);
      const bulkBtn1 = () => Array.from(document.querySelectorAll('main button')).find((b) => ['Delete 1', 'Confirm delete 1', 'Deleting...'].indexOf((b.textContent || '').trim()) >= 0);
      bulkBtn1().click(); // arm
      await sleep(220);
      const oneRes = await probeRemoval5('Eq One Drill', () => { bulkBtn1().click(); });
      await sleep(400);
      // BATCH-OF-2.
      selectBtn5().click();
      await sleep(300);
      tick5('Eq Two A Drill').click();
      await sleep(150);
      tick5('Eq Two B Drill').click();
      await sleep(150);
      const bulkBtn2 = () => Array.from(document.querySelectorAll('main button')).find((b) => ['Delete 2', 'Confirm delete 2', 'Deleting...'].indexOf((b.textContent || '').trim()) >= 0);
      bulkBtn2().click(); // arm
      await sleep(220);
      const twoRes = await probeRemoval5('Eq Two A Drill', () => { bulkBtn2().click(); });
      await sleep(400);
      // SINGLE (per-card trash → inline confirm), then UNDO — proves the shared pipeline AND
      // that the undo flow is untouched by the batch unification.
      const soloCard = cardByName5('Solo Drill');
      soloCard.querySelector('button[title="Delete"]').click();
      await sleep(250);
      const singleRes = await probeRemoval5('Solo Drill', () => {
        const c = cardByName5('Solo Drill');
        Array.from(c.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Delete').click();
      });
      let undone5 = false;
      const uT05 = Date.now();
      if (undoBtn5()) undoBtn5().click();
      while (Date.now() - uT05 < 1500) {
        if (!undone5 && cardByName5('Solo Drill')) undone5 = true;
        await sleep(40);
      }
      out.f17_singleProbe = singleRes;
      out.f17_batchOfOneProbe = oneRes;
      out.f17_batchOfTwoProbe = twoRes;
      const sigOk = (r) => !r.missing && r.opacity && r.scale && r.glide && !r.skel;
      out.f17_allThreeShrinkFadeGlide = sigOk(singleRes) && sigOk(oneRes) && sigOk(twoRes);
      const starts5 = [singleRes.exitStartMs, oneRes.exitStartMs, twoRes.exitStartMs];
      const animStarts5 = [singleRes.animStartCurrentTimeMs, oneRes.animStartCurrentTimeMs, twoRes.animStartCurrentTimeMs];
      out.f17_exitStartMaxMs = Math.max.apply(null, starts5);
      out.f17_animStartAbsMaxMs = Math.max.apply(null, animStarts5.map(Math.abs));
      // Immediate-start proof: motion's own clock shows each exit animation created within
      // milliseconds of its confirm click (negative currentTime = scheduled pre-play).
      out.f17_identicalImmediateStart = out.f17_animStartAbsMaxMs <= 80;
      const detaches5 = [singleRes.detachMs, oneRes.detachMs, twoRes.detachMs];
      out.f17_detachSpreadMs = Math.max.apply(null, detaches5) - Math.min.apply(null, detaches5);
      out.f17_detachWithinTolerance = out.f17_detachSpreadMs <= 150;
      // With a fixed 200 ms exit tween, equal detach times ⇒ equal start times. Record the
      // derived spans so the report can show the full equivalence triple.
      out.f17_derivedExitStartsMs = detaches5.map(function (d) { return d - 200; }).join(',');
      out.f17_toastOnlyOnSingle = singleRes.toast === true && oneRes.toast === false && twoRes.toast === false;
      out.f17_noSkeletonAnyPath = !singleRes.skel && !oneRes.skel && !twoRes.skel;
      out.f17_undoStillRestoresAfterUnifiedBatch = undone5 && !!cardByName5('Solo Drill');
      out.f17_batchGone = !cardByName5('Eq One Drill') && !cardByName5('Eq Two A Drill') && !cardByName5('Eq Two B Drill');

      // ---- FIX 18a: preview→edit→close WITHOUT save ⇒ pre-edit preview restored instantly ----
      const modalH25 = (t) => Array.from(document.querySelectorAll('.fixed.inset-0 h2')).find((h) => (h.getAttribute('title') || '') === t);
      const modalPre5 = () => document.querySelector('.fixed.inset-0 pre');
      const editorH2Open = () => Array.from(document.querySelectorAll('h2')).some((h) => ['Edit drop', 'Edit file'].indexOf((h.textContent || '').trim()) >= 0);
      const escKey = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      cardByName5('Round Trip Drill').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(700);
      out.f18_previewOpened = !!modalH25('Round Trip Drill');
      out.f18_originalBodyShown = ((modalPre5() || {}).textContent || '').indexOf('round trip original body') >= 0;
      document.querySelector('.fixed.inset-0 button[title="Edit"]').click();
      await sleep(600);
      out.f18_editorMounted = editorH2Open();
      out.f18_previewHiddenBehindEditor = !modalH25('Round Trip Drill');
      const edBox5 = document.querySelector('[contenteditable][role="textbox"]');
      edBox5.focus();
      document.execCommand('insertText', false, ' UNSAVED-MARK');
      await sleep(250);
      escKey(); // unsaved change ⇒ discard guard must intercept
      await sleep(350);
      // Counter reset sits HERE: the edit-open hydration fetch is already done, so any
      // getPayload from this point on would be a REAL refetch during the restore.
      await dropsync.dev.testOnly('resetPayloadFetchCount', '');
      out.f18_discardGuardFired = Array.from(document.querySelectorAll('button')).some((b) => (b.textContent || '').trim() === 'Discard');
      const discardBtn5 = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Discard');
      let restoreSkel5 = false;
      const rT05 = Date.now();
      discardBtn5.click();
      while (Date.now() - rT05 < 1200) {
        if (document.querySelector('.fixed.inset-0 [class*="animate-pulse"]')) restoreSkel5 = true;
        await sleep(20);
      }
      out.f18_restoreNoLoadingFrame = !restoreSkel5;
      out.f18_previewRestoredAfterDiscard = !!modalH25('Round Trip Drill');
      const restoredTxt5 = (modalPre5() || {}).textContent || '';
      out.f18_restoredIsPreEditVersion = restoredTxt5.indexOf('UNSAVED-MARK') < 0 && restoredTxt5.indexOf('round trip original body') >= 0;
      const fstatsA = await dropsync.dev.testOnly('payloadFetchStats', '');
      out.f18_restoreZeroFetches = fstatsA.count === 0;

      // ---- FIX 18b: trail/back stack survives the round trip (mention chip → RT → edit → back) ----
      escKey();
      await sleep(400);
      cardByName5('Trail Anchor Drill').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(700);
      out.f18_anchorPreviewOpened = !!modalH25('Trail Anchor Drill');
      const chipBtn5 = document.querySelector('.fixed.inset-0 pre button');
      if (!chipBtn5) { out.f18_mentionChipFound = false; return done(out, '5'); }
      chipBtn5.click();
      await sleep(700);
      out.f18_chipOpenedRtPreview = !!modalH25('Round Trip Drill');
      const backBtn5 = () => document.querySelector('.fixed.inset-0 button[aria-label="Back"]');
      out.f18_backAvailableOnChipJump = !!backBtn5();
      document.querySelector('.fixed.inset-0 button[title="Edit"]').click();
      await sleep(500);
      escKey(); // NO changes this time — must close straight through, guard silent
      await sleep(350);
      out.f18_noGuardWithoutChanges = !Array.from(document.querySelectorAll('button')).some((b) => (b.textContent || '').trim() === 'Discard');
      out.f18_restoredAgainInstantly = !!modalH25('Round Trip Drill');
      out.f18_backSurvivesEditRoundTrip = !!backBtn5();
      if (backBtn5()) backBtn5().click();
      await sleep(600);
      out.f18_backLandsOnAnchor = !!modalH25('Trail Anchor Drill');
      escKey();
      await sleep(400);

      // ---- FIX 18c: save path ⇒ NEW content shown instantly, cache-prime proven ----
      cardByName5('Round Trip Drill').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(700);
      document.querySelector('.fixed.inset-0 button[title="Edit"]').click();
      await sleep(500);
      const edBox6 = document.querySelector('[contenteditable][role="textbox"]');
      edBox6.focus();
      document.execCommand('insertText', false, 'SAVED-MARK ');
      await sleep(200);
      // Counter reset AFTER the editor hydration: the save path itself (updateContent/getMeta/
      // media tokens) never calls getPayload, so count===0 after reopen proves the preview was
      // served purely by the cache prime.
      await dropsync.dev.testOnly('resetPayloadFetchCount', '');
      Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Save changes').click();
      let saveSkel5 = false;
      let savedShownAt5 = -1;
      const sT05 = Date.now();
      while (Date.now() - sT05 < 3000) {
        if (document.querySelector('.fixed.inset-0 [class*="animate-pulse"]')) saveSkel5 = true;
        if (savedShownAt5 < 0) {
          const p5 = modalPre5();
          if (p5 && (p5.textContent || '').indexOf('SAVED-MARK') >= 0) savedShownAt5 = Date.now() - sT05;
        }
        await sleep(20);
      }
      out.f18_savedShownWithinMs = savedShownAt5;
      out.f18_saveShowsNewContentInstantly = savedShownAt5 >= 0 && !saveSkel5;
      out.f18_saveContentIsNewVersion = ((modalPre5() || {}).textContent || '').indexOf('SAVED-MARK') >= 0;
      out.f18_saveClosedTheEditor = !editorH2Open();
      const fstatsC = await dropsync.dev.testOnly('payloadFetchStats', '');
      out.f18_saveZeroFetchesPrimeProven = fstatsC.count === 0;
      // trail had exactly [RT] here — a PUSH would enable Back; replace-tail keeps it absent.
      out.f18_saveReplacesTailNotPush = !backBtn5();

      // ---- FIX 18d: right-click-originated edit stays scoped OUT (web has NO such entry point) ----
      escKey();
      await sleep(400);
      cardByName5('Trail Anchor Drill').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await sleep(350);
      const ctxEditBtn5 = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Edit' && !b.closest('.fixed.inset-0'));
      out.f18_ctxMenuHadEdit = !!ctxEditBtn5;
      if (ctxEditBtn5) ctxEditBtn5.click();
      await sleep(500);
      out.f18_ctxEditorMounted = editorH2Open();
      escKey(); // no changes → straight close
      await sleep(350);
      out.f18_ctxCloseReturnsToListNoPreview = !editorH2Open() && !modalH25('Trail Anchor Drill') && !modalH25('Round Trip Drill');

      // ---- FIX 18e: rapid cycles leave no stale cache — reopen hits prime, re-edit cancel keeps truth ----
      await dropsync.dev.testOnly('resetPayloadFetchCount', '');
      cardByName5('Round Trip Drill').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(500);
      const fstatsE = await dropsync.dev.testOnly('payloadFetchStats', '');
      out.f18_reopenCacheHitZeroFetches = fstatsE.count === 0;
      out.f18_reopenShowsSavedVersion = ((modalPre5() || {}).textContent || '').indexOf('SAVED-MARK') >= 0;
      document.querySelector('.fixed.inset-0 button[title="Edit"]').click();
      await sleep(500);
      escKey();
      await sleep(350);
      out.f18_rapidCycleStillSaved = ((modalPre5() || {}).textContent || '').indexOf('SAVED-MARK') >= 0;
      escKey();
      await sleep(400);
      out.sweepNoErrors5 = window.__hoverErrCount5 === 0;
      localStorage.setItem('dropsync.sit3.dom', '6');
      setTimeout(() => location.reload(), 50);
      out.stage = '5';
      return JSON.stringify(out);
    }
    if (stage === '6') {
      // __STAGE6_FIX20__
      // ---- STAGE 6: FIX 20 — web-imported drawings work everywhere (slot truth + scene
      // preference). Imports the WEB-SHAPED archive (PNG under payloads.image; WD1 with a
      // manifest drawingScene + scene-less PNG, WD2 without a manifest scene but an
      // embedded-scene PNG), asserts card thumbnail + preview + editor for each shape, the
      // zero-byte-fetch proof on WD1's editor, save-after-tweak, export-back, plus the legacy
      // local-shape + locally-drawn regression sweep and the empty-canvas guard.
      let cards6 = [];
      for (let i = 0; i < 24 && cards6.length < 3; i++) { await sleep(500); cards6 = cardH3s(); }
      out.hydratedCards6 = cards6.length;
      // Rerun hygiene: drop leftovers from earlier partial passes so name-based lookups below
      // always resolve to THIS pass's freshly imported copies.
      try {
        for (const s of await dropsync.vault.listSpaces()) {
          if (['Web Drawings', 'Web Drawings RT', 'Legacy Shape', 'Concurrent WS', 'Export Doom', 'Poison Scene'].indexOf(s.name) >= 0) {
            await dropsync.vault.deleteSpace(s.id);
          }
        }
      } catch (e) { /* best-effort */ }
      const EX6 = window.__EXCAL;
      if (!EX6) { out.f20 = 'no excalidraw hook'; return done(out, '6'); }
      const byteStats = async () => (await dropsync.dev.testOnly('mediaByteFetchStats', '')).count;
      const resetByteStats = async () => { await dropsync.dev.testOnly('resetMediaByteFetchCount', ''); };
      const gotoSpace6 = async (name) => {
        await openMenu();
        const menuEl = document.querySelector('header .absolute.top-full');
        const row = Array.from(menuEl.querySelectorAll('div')).find((el) => el.className.indexOf('cursor-pointer') >= 0 && (el.textContent || '').trim() === name)
          || Array.from(menuEl.querySelectorAll('button')).find((el) => (el.textContent || '').trim() === name);
        if (!row) return false;
        row.click();
        await sleep(1000);
        return true;
      };
      const modalImg6 = () => {
        const im = Array.from(document.querySelectorAll('.fixed.inset-0 img')).find((i) => (i.getAttribute('src') || '').indexOf('media://r/') === 0);
        return im || null;
      };
      const cardByName6 = (name) => {
        const h = cardH3s().find((x) => (x.getAttribute('title') || '') === name);
        return h ? h.closest('.cursor-pointer') : null;
      };
      // Import the WEB-SHAPED archive into its own space.
      let imp6 = null;
      try {
        imp6 = await dropsync.vault.importRun({ filePath: '/tmp/ds-test-archives/web-drawing-test.dropsync', password: 'test-archive-pw', destination: { mode: 'new', name: 'Web Drawings' } });
      } catch (e) { out.f20_import = e.message; return done(out, '6'); }
      out.f20_importedBothShapes = imp6.importedCount === 2;
      const spaces6 = await dropsync.vault.listSpaces();
      const ws6 = spaces6.find((s) => s.name === 'Web Drawings');
      out.f20_spaceCreated = !!ws6;
      const dtos6 = await dropsync.drop.list(ws6.id);
      const wd1 = dtos6.find((d) => d.name === 'WD1 Manifest Scene');
      const wd2 = dtos6.find((d) => d.name === 'WD2 Embedded Scene');
      out.f20_wd1ImageSlotTruth = !!wd1 && wd1.hasImagePayload === true && wd1.hasFilePayload === false;
      out.f20_wd1SceneCarried = !!wd1 && !!wd1.drawingScene && Array.isArray(wd1.drawingScene.elements) && wd1.drawingScene.elements.length === 1;
      out.f20_wd2ImageSlotTruth = !!wd2 && wd2.hasImagePayload === true && wd2.hasFilePayload === false;
      out.f20_wd2NoManifestScene = !!wd2 && (wd2.drawingScene === undefined || wd2.drawingScene === null);
      // Card/thumbnail/preview/editor drills run in '6r'+ — a bridge-side import only reaches
      // the renderer's spaces list after the reload this stage chains into.
      localStorage.setItem('dropsync.sit3.dom', '6r');
      setTimeout(() => location.reload(), 50);
      out.stage = '6';
      return JSON.stringify(out);
    }
    if (stage === '6r') {
      // ---- STAGE 6r: FIX 20 continued — preview render matrix, editor scene preference
      // (zero-fetch manifest path vs byte-fetch embedded-scene path), save-after-tweak with
      // engine-side scene verification, export-back round trip, legacy local-shape fixture,
      // locally-drawn regression sweep, and the empty-canvas save guard.
      const EX6R = window.__EXCAL;
      if (!EX6R) { out.f20r = 'no excalidraw hook'; return done(out, '6'); }
      const byteStats6 = async () => (await dropsync.dev.testOnly('mediaByteFetchStats', '')).count;
      const resetByteStats6 = async () => { await dropsync.dev.testOnly('resetMediaByteFetchCount', ''); };
      const gotoSpace6R = async (name) => {
        await openMenu();
        const menuEl = document.querySelector('header .absolute.top-full');
        const row = Array.from(menuEl.querySelectorAll('div')).find((el) => el.className.indexOf('cursor-pointer') >= 0 && (el.textContent || '').trim() === name)
          || Array.from(menuEl.querySelectorAll('button')).find((el) => (el.textContent || '').trim() === name);
        if (!row) return false;
        row.click();
        await sleep(1000);
        return true;
      };
      const cardByName6R = (name) => {
        const h = cardH3s().find((x) => (x.getAttribute('title') || '') === name);
        return h ? h.closest('.cursor-pointer') : null;
      };
      const modalImg6R = () => Array.from(document.querySelectorAll('.fixed.inset-0 img')).find((i) => (i.getAttribute('src') || '').indexOf('media://r/') === 0) || null;
      // Click "Save drawing" only AFTER Excalidraw has mounted AND its initial onChange has
      // registered the restored scene — otherwise the empty-canvas guard eats the click.
      const saveDrawingAndSettle = async () => {
        let ex = false;
        for (let i = 0; i < 30 && !ex; i++) { await sleep(300); ex = !!document.querySelector('.excalidraw'); }
        await sleep(900); // initial onChange → elementsRef + elementCountRef populated
        const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Save drawing');
        if (!btn) return { clicked: false, attached: false };
        btn.click();
        const t0 = Date.now();
        while (Date.now() - t0 < 3500) {
          if (Array.from(document.querySelectorAll('span')).find((s) => (s.textContent || '') === 'Drawing attached')) return { clicked: true, attached: true };
          await sleep(100);
        }
        return { clicked: true, attached: false, hint: document.body.textContent.includes("an empty drawing can't be saved") };
      };
      const editorMounted6R = async () => {
        for (let i = 0; i < 30; i++) {
          await sleep(300);
          if (!Array.from(document.querySelectorAll('.fixed.inset-0 *')).some((el) => el.textContent === 'Loading drawing...')) return true;
        }
        return false;
      };
      await gotoSpace6R('Web Drawings');
      let ready6 = 0;
      for (let i = 0; i < 24 && ready6 < 2; i++) { await sleep(500); ready6 = ['WD1 Manifest Scene', 'WD2 Embedded Scene'].filter((n) => cardByName6R(n)).length; }
      out.f20r_cardsHydrated = ready6 === 2;
      // Card thumbnails render from whichever slot the resolver picked (FIX 20 read-side).
      const cardThumbSrcR = (name) => {
        const c = cardByName6R(name);
        const im = c ? c.querySelector('img') : null;
        return im && (im.getAttribute('src') || '').indexOf('media://r/') === 0 ? im.getAttribute('src') : null;
      };
      out.f20_wd1CardThumb = !!cardThumbSrcR('WD1 Manifest Scene');
      out.f20_wd2CardThumb = !!cardThumbSrcR('WD2 Embedded Scene');
      // WD1: manifest drawingScene drives the editor with ZERO payload byte fetches.
      cardByName6R('WD1 Manifest Scene').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(800);
      const img1 = modalImg6R();
      out.f20_wd1PreviewPng = !!img1 && img1.naturalWidth > 0;
      document.querySelector('.fixed.inset-0 button[title="Edit"]').click();
      out.f20_wd1EditorSpinnerGated = await editorMounted6R();
      out.f20_wd1ZeroByteFetches = (await byteStats6()) === 0;
      // Element-presence proof WITHOUT pixel parsing: an empty canvas would trip the
      // empty-drawing hint; a loaded scene lets "Save drawing" attach (indicator appears).
      const saveRes1 = await saveDrawingAndSettle();
      out.f20_wd1SaveClicked = saveRes1.clicked;
      out.f20_wd1SceneElementsLive = !!saveRes1.attached;
      // Save-after-tweak: submit the editor WITH the manifest-scene drawing re-attached.
      await resetByteStats6();
      const submitBtn6 = document.querySelector('form button[type="submit"]');
      if (!submitBtn6) { out.f20_wd1Save = 'no submit button'; return done(out, '6'); }
      submitBtn6.click();
      let wd1SavedShown = false;
      const s60 = Date.now();
      while (Date.now() - s60 < 3000 && !wd1SavedShown) {
        const im = modalImg6R();
        if (im && im.naturalWidth > 0) wd1SavedShown = true;
        await sleep(40);
      }
      out.f20_wd1SaveReopensPreviewPng = wd1SavedShown;
      out.f20_wd1EditorClosedAfterSave = !Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Save drawing');
      localStorage.setItem('dropsync.sit3.dom', '6s');
      setTimeout(() => location.reload(), 50);
      out.stage = '6r';
      return JSON.stringify(out);
    }
    if (stage === '6s') {
      // ---- STAGE 6s: engine-side proof of the saved WD1 scene + export-back round trip +
      // WD2 embedded-scene fallback + the legacy local-shape fixture regression.
      const EX6S = window.__EXCAL;
      if (!EX6S) { out.f20s = 'no excalidraw hook'; return done(out, '6'); }
      const byteStats6S = async () => (await dropsync.dev.testOnly('mediaByteFetchStats', '')).count;
      const gotoSpace6S = async (name) => {
        await openMenu();
        const menuEl = document.querySelector('header .absolute.top-full');
        const row = Array.from(menuEl.querySelectorAll('div')).find((el) => el.className.indexOf('cursor-pointer') >= 0 && (el.textContent || '').trim() === name)
          || Array.from(menuEl.querySelectorAll('button')).find((el) => (el.textContent || '').trim() === name);
        if (!row) return false;
        row.click();
        await sleep(1000);
        return true;
      };
      const cardByName6S = (name) => {
        const h = cardH3s().find((x) => (x.getAttribute('title') || '') === name);
        return h ? h.closest('.cursor-pointer') : null;
      };
      const modalImg6S = () => Array.from(document.querySelectorAll('.fixed.inset-0 img')).find((i) => (i.getAttribute('src') || '').indexOf('media://r/') === 0) || null;
      const spaces6S = await dropsync.vault.listSpaces();
      const ws6S = spaces6S.find((s) => s.name === 'Web Drawings');
      if (!ws6S) { out.f20s = 'space lost'; return done(out, '6'); }
      // Engine-side: the save landed a NEW PNG in the FILE slot carrying the manifest scene.
      const dtoW1 = (await dropsync.drop.list(ws6S.id)).find((d) => d.name === 'WD1 Manifest Scene');
      out.f20_wd1FileSlotAfterSave = !!dtoW1 && dtoW1.hasFilePayload === true;
      const bytesW1 = await dropsync.media.getBytes(dtoW1.id, 'file');
      if (!bytesW1) { out.f20_wd1SavedSceneParse = 'no file bytes'; return done(out, '6'); }
      const sceneW1 = await EX6S.loadFromBlob(new Blob([bytesW1], { type: 'image/png' }), null, null);
      const idsW1 = sceneW1.elements.filter(function (e) { return !e.isDeleted; }).map(function (e) { return e.id; });
      out.f20_wd1SavedSceneRoundTrips = JSON.stringify(idsW1) === JSON.stringify(['web-el-1'])
        && sceneW1.appState.viewBackgroundColor === '#fffef5';
      // Export-back follows actual blob refs (both drawings ride payloads.image again).
      let exp6 = null;
      try {
        exp6 = await dropsync.vault.export({ workspaceId: ws6S.id }, 'webdraw-export-pw', '/tmp/opencode/e2e/web-draw-roundtrip.dropsync');
      } catch (e) { out.f20_exportBack = e.message; return done(out, '6'); }
      out.f20_exportBackIncludesDrawings = exp6.included === 2;
      let impBack = null;
      try {
        impBack = await dropsync.vault.importRun({ filePath: '/tmp/opencode/e2e/web-draw-roundtrip.dropsync', password: 'webdraw-export-pw', destination: { mode: 'new', name: 'Web Drawings RT' } });
      } catch (e) { out.f20_roundTripImport = e.message; return done(out, '6'); }
      out.f20_roundTripImportedBoth = impBack.importedCount === 2;
      const rtSpace = (await dropsync.vault.listSpaces()).find((s) => s.name === 'Web Drawings RT');
      const rtDtos = await dropsync.drop.list(rtSpace.id);
      const rtW1 = rtDtos.find((d) => d.name === 'WD1 Manifest Scene');
      const rtW2 = rtDtos.find((d) => d.name === 'WD2 Embedded Scene');
      out.f20_roundTripSlotTruth = !!rtW1 && rtW1.hasImagePayload === true && rtW1.hasFilePayload === false
        && !!rtW2 && rtW2.hasImagePayload === true && rtW2.hasFilePayload === false;
      out.f20_roundTripSceneCarried = !!rtW1 && !!rtW1.drawingScene && Array.isArray(rtW1.drawingScene.elements);
      // WD2 fallback: editor parses the EMBEDDED scene from fetched PNG bytes.
      await gotoSpace6S('Web Drawings');
      let ready6S = 0;
      for (let i = 0; i < 24 && ready6S < 2; i++) { await sleep(500); ready6S = ['WD1 Manifest Scene', 'WD2 Embedded Scene'].filter((n) => cardByName6S(n)).length; }
      out.f20s_cardsHydrated = ready6S === 2;
      cardByName6S('WD2 Embedded Scene').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(800);
      const img2 = modalImg6S();
      out.f20_wd2PreviewPng = !!img2 && img2.naturalWidth > 0;
      document.querySelector('.fixed.inset-0 button[title="Edit"]').click();
      let mounted2 = false;
      for (let i = 0; i < 30 && !mounted2; i++) { await sleep(300); mounted2 = !Array.from(document.querySelectorAll('.fixed.inset-0 *')).some((el) => el.textContent === 'Loading drawing...'); }
      out.f20_wd2EditorMounted = mounted2;
      out.f20_wd2ByteFetchFallback = (await byteStats6S()) >= 1;
      const settle6S = async () => {
        let ex = false;
        for (let i = 0; i < 30 && !ex; i++) { await sleep(300); ex = !!document.querySelector('.excalidraw'); }
        await sleep(900);
        const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Save drawing');
        if (!btn) return false;
        btn.click();
        const t0 = Date.now();
        while (Date.now() - t0 < 3500) {
          if (Array.from(document.querySelectorAll('span')).find((s) => (s.textContent || '') === 'Drawing attached')) return true;
          await sleep(100);
        }
        return false;
      };
      out.f20_wd2EmbeddedElementsLive = await settle6S();
      localStorage.setItem('dropsync.sit3.dom', '6t');
      setTimeout(() => location.reload(), 50);
      out.stage = '6s';
      return JSON.stringify(out);
    }
    if (stage === '6t') {
      // ---- STAGE 6t: FIX 20 regression sweeps — LOCALLY-DRAWN drops behave exactly as before
      // (file-slot fallback parse, save round trip), the empty-canvas save guard still blocks,
      // and the LEGACY local-shape fixture's drawing starts working read-side with zero migration.
      const EX6T = window.__EXCAL;
      if (!EX6T) { out.f20t = 'no excalidraw hook'; return done(out, '6'); }
      const byteStats6T = async () => (await dropsync.dev.testOnly('mediaByteFetchStats', '')).count;
      const resetByteStats6T = async () => { await dropsync.dev.testOnly('resetMediaByteFetchCount', ''); };
      const gotoSpace6T = async (name) => {
        await openMenu();
        const menuEl = document.querySelector('header .absolute.top-full');
        const row = Array.from(menuEl.querySelectorAll('div')).find((el) => el.className.indexOf('cursor-pointer') >= 0 && (el.textContent || '').trim() === name)
          || Array.from(menuEl.querySelectorAll('button')).find((el) => (el.textContent || '').trim() === name);
        if (!row) return false;
        row.click();
        await sleep(1000);
        return true;
      };
      const cardByName6T = (name) => {
        const h = cardH3s().find((x) => (x.getAttribute('title') || '') === name);
        return h ? h.closest('.cursor-pointer') : null;
      };
      const modalImg6T = () => Array.from(document.querySelectorAll('.fixed.inset-0 img')).find((i) => (i.getAttribute('src') || '').indexOf('media://r/') === 0) || null;
      // --- locally-drawn drop: identical visual + timing behavior ---
      let localId = '';
      try {
        const mkR = { id: 'lr1', type: 'rectangle', x: 10, y: 10, width: 100, height: 60, angle: 0,
          strokeColor: '#1a1a1a', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2,
          strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null,
          seed: 2, version: 1, versionNonce: 2, isDeleted: false, boundElements: null, updated: 1,
          link: null, locked: false };
        const blobL = await EX6T.exportToBlob({ elements: [mkR], appState: { viewBackgroundColor: '#ffffff', exportBackground: true, exportEmbedScene: true }, files: {}, exportPadding: 10 });
        const recL = await dropsync.drop.createText({ spaceId: 'personal', name: '', content: '', expirationOption: 'forever', categories: [], locked: false, reminderAt: null, pngBytes: new Uint8Array(await blobL.arrayBuffer()) });
        localId = recL.id;
      } catch (e) { out.f20_localSeed = e.message; return done(out, '6'); }
      out.f20_localIsDrawing = !!localId;
      await gotoSpace6T('Personal');
      let localCard = null;
      for (let i = 0; i < 24 && !localCard; i++) { await sleep(500); localCard = cardByName6T('Drawing'); }
      out.f20_localCardFound = !!localCard;
      const localThumb = localCard ? localCard.querySelector('img[src^="media://r/"]') : null;
      out.f20_localCardThumbUnchanged = !!localThumb;
      if (localCard) localCard.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(800);
      const localImg = modalImg6T();
      out.f20_localPreviewPng = !!localImg && localImg.naturalWidth > 0;
      await resetByteStats6T();
      document.querySelector('.fixed.inset-0 button[title="Edit"]').click();
      let lMounted = false;
      for (let i = 0; i < 30 && !lMounted; i++) { await sleep(300); lMounted = !Array.from(document.querySelectorAll('.fixed.inset-0 *')).some((el) => el.textContent === 'Loading drawing...'); }
      out.f20_localEditorMounted = lMounted;
      out.f20_localFallbackByteFetch = (await byteStats6T()) >= 1;
      const settle6T = async () => {
        let ex = false;
        for (let i = 0; i < 30 && !ex; i++) { await sleep(300); ex = !!document.querySelector('.excalidraw'); }
        await sleep(900);
        const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Save drawing');
        if (!btn) return false;
        btn.click();
        const t0 = Date.now();
        while (Date.now() - t0 < 3500) {
          if (Array.from(document.querySelectorAll('span')).find((s) => (s.textContent || '') === 'Drawing attached')) return true;
          await sleep(100);
        }
        return false;
      };
      out.f20_localElementsLive = await settle6T();
      localStorage.setItem('dropsync.sit3.dom', '6u');
      setTimeout(() => location.reload(), 50);
      out.stage = '6t';
      return JSON.stringify(out);
    }
    if (stage === '6u') {
      // ---- STAGE 6u: FIX 20 tail — empty-canvas save guard still blocks zero-element saves;
      // locally-drawn PNG still round-trips through the engine; the LEGACY local-shape fixture
      // (personal-test.dropsync P3) starts working read-side with ZERO migration.
      const EX6U = window.__EXCAL;
      if (!EX6U) { out.f20u = 'no excalidraw hook'; return done(out, '6'); }
      const gotoSpace6U = async (name) => {
        await openMenu();
        const menuEl = document.querySelector('header .absolute.top-full');
        const row = Array.from(menuEl.querySelectorAll('div')).find((el) => el.className.indexOf('cursor-pointer') >= 0 && (el.textContent || '').trim() === name)
          || Array.from(menuEl.querySelectorAll('button')).find((el) => (el.textContent || '').trim() === name);
        if (!row) return false;
        row.click();
        await sleep(1000);
        return true;
      };
      // Locally-drawn PNG round-trips through the engine exactly as before.
      await gotoSpace6U('Personal');
      let lReady = false;
      for (let i = 0; i < 24 && !lReady; i++) { await sleep(500); lReady = !!Array.from(document.querySelectorAll('h3[title]')).find((h) => h.getAttribute('title') === 'Drawing'); }
      out.f20u_localCardBack = lReady;
      const localDto = (await dropsync.drop.list('personal')).find((d) => d.isDrawing && d.name === 'Drawing');
      const localBytes = localDto ? await dropsync.media.getBytes(localDto.id, 'file') : null;
      if (!localBytes) { out.f20u_localRoundTrip = 'no bytes'; return done(out, '6'); }
      const localScene = await EX6U.loadFromBlob(new Blob([localBytes], { type: 'image/png' }), null, null);
      out.f20u_localRoundTrip = localScene.elements.filter(function (e) { return !e.isDeleted; }).map(function (e) { return e.id; }).join(',') === 'lr1';
      // EMPTY-CANVAS SAVE GUARD: create flow → Draw tab → immediate Save ⇒ inline hint, nothing attached.
      const addTextBtn = Array.from(document.querySelectorAll('main button')).find((b) => (b.textContent || '').trim() === 'Add Text');
      if (!addTextBtn) { out.f20_guard = 'no Add Text'; return done(out, '6'); }
      addTextBtn.click();
      await sleep(600);
      const drawTab = Array.from(document.querySelectorAll('.fixed.inset-0 button')).find((b) => (b.textContent || '').trim() === 'Draw');
      if (!drawTab) { out.f20_guard = 'no Draw tab'; return done(out, '6'); }
      drawTab.click();
      let canvasUp = false;
      for (let i = 0; i < 30 && !canvasUp; i++) { await sleep(300); canvasUp = !!Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Save drawing'); }
      if (!canvasUp) { out.f20_guard = 'canvas did not mount'; return done(out, '6'); }
      Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Save drawing').click();
      await sleep(500);
      out.f20_emptyGuardBlocks = document.body.textContent.includes("an empty drawing can't be saved")
        && !Array.from(document.querySelectorAll('span')).find((s) => (s.textContent || '') === 'Drawing attached');
      const cancelCreate = Array.from(document.querySelectorAll('.fixed.inset-0 button')).find((b) => (b.textContent || '').trim() === 'Cancel');
      if (cancelCreate) cancelCreate.click();
      await sleep(400);
      out.f20_createModalClosedCleanly = !Array.from(document.querySelectorAll('.fixed.inset-0 button')).find((b) => (b.textContent || '').trim() === 'Save drawing');
      // LEGACY local-shape fixture: previously-imported drawings start working immediately.
      try {
        await dropsync.vault.importRun({ filePath: '/tmp/ds-test-archives/personal-test.dropsync', password: 'test-archive-pw', destination: { mode: 'new', name: 'Legacy Shape' } });
      } catch (e) { out.f20_legacyImport = e.message; return done(out, '6'); }
      const legacySpace = (await dropsync.vault.listSpaces()).find((s) => s.name === 'Legacy Shape');
      const legacyDtos = await dropsync.drop.list(legacySpace.id);
      const p3 = legacyDtos.find((d) => d.name === 'P3 Legacy Restart Drawing');
      out.f20_legacyFlags = !!p3 && p3.isDrawing === true && p3.hasImagePayload === true && p3.hasFilePayload === false;
      out.f20_legacyManifestSceneReadable = !!p3 && !!p3.drawingScene && p3.drawingScene.elements.length === 1 && p3.drawingScene.elements[0].id === 'el-1';
      // Thumbnail check runs in '6v' — this boot imported the space via the BRIDGE, so the
      // renderer store only learns about it after the reload chained here.
      localStorage.setItem('dropsync.sit3.dom', '6v');
      setTimeout(() => location.reload(), 50);
      out.stage = '6u';
      return JSON.stringify(out);
    }
    if (stage === '6v') {
      // ---- STAGE 6v: the legacy fixture's drawing card, verified AFTER a reload so the
      // bridge-created space is visible to the renderer store.
      let p3Card = null;
      for (let i = 0; i < 24 && !p3Card; i++) { await sleep(500); const h = Array.from(document.querySelectorAll('h3[title]')).find((x) => x.getAttribute('title') === 'P3 Legacy Restart Drawing'); if (h) { p3Card = h.closest('.cursor-pointer'); break; } }
      if (!p3Card) {
        await openMenu();
        const menuEl = document.querySelector('header .absolute.top-full');
        const row = menuEl && Array.from(menuEl.querySelectorAll('div')).find((el) => el.className.indexOf('cursor-pointer') >= 0 && (el.textContent || '').trim() === 'Legacy Shape');
        if (!row) { out.f20_legacyThumbRendersNow = 'space row missing'; localStorage.setItem('dropsync.sit3.dom', '7'); setTimeout(() => location.reload(), 50); return done(out, '6v'); }
        row.click();
        await sleep(1200);
        for (let i = 0; i < 24 && !p3Card; i++) { await sleep(500); const h = Array.from(document.querySelectorAll('h3[title]')).find((x) => x.getAttribute('title') === 'P3 Legacy Restart Drawing'); if (h) { p3Card = h.closest('.cursor-pointer'); break; } }
      } else {
        // already on the right space (reload preserved it)
      }
      out.f20_legacyThumbRendersNow = !!p3Card && !!p3Card.querySelector('img[src^="media://r/"]');
      localStorage.setItem('dropsync.sit3.dom', '7');
      setTimeout(() => location.reload(), 50);
      out.stage = '6v';
      return JSON.stringify(out);
    }
    if (stage === '7') {
      // __STAGE7_FIX19__
      // ---- STAGE 7: FIX 19 — workspaces can be renamed and deleted. Inline rename follows
      // the create-row pattern (≤120 chars, Enter commits, Esc cancels, id stable); delete
      // uses the web-parity two-step confirmation guard; deleting the CURRENT workspace lands
      // on Personal; engine guards protect Personal; serialization drills cover a concurrent
      // import and a mid-flight export abort of the deleted space.
      const gotoSpace7 = async (name) => {
        await openMenu();
        const menuEl = document.querySelector('header .absolute.top-full');
        const row = Array.from(menuEl.querySelectorAll('div')).find((el) => el.className.indexOf('cursor-pointer') >= 0 && (el.textContent || '').trim() === name)
          || Array.from(menuEl.querySelectorAll('button')).find((el) => (el.textContent || '').trim() === name);
        if (!row) return false;
        row.click();
        await sleep(1000);
        return true;
      };
      const openRowMenu7 = async (name) => {
        for (let attempt = 0; attempt < 4; attempt++) {
          await openMenu();
          await sleep(200);
          const menuEl = document.querySelector('header .absolute.top-full');
          const row = menuEl && Array.from(menuEl.querySelectorAll('div')).find((el) => el.className.indexOf('cursor-pointer') >= 0 && (el.textContent || '').trim() === name);
          const gear = row ? row.querySelector('button[data-ws-gear]') : null;
          if (gear) {
            gear.click();
            await sleep(350);
            const m2 = document.querySelector('header .absolute.top-full');
            if (m2 && m2.querySelector('button[data-ws-rename-entry]')) return m2;
          }
          const bd = document.querySelector('header .fixed.inset-0.z-40');
          if (bd) bd.click();
          await sleep(350);
        }
        return null;
      };
      // Engine guards FIRST (Personal is structural; ids are checked, not guessed).
      const rejects7 = async (fn) => { try { await fn(); return false; } catch (e) { return true; } };
      out.f19_rejectsRenamePersonal = await rejects7(() => dropsync.vault.renameSpace('personal', 'Nope'));
      out.f19_rejectsDeletePersonal = await rejects7(() => dropsync.vault.deleteSpace('personal'));
      out.f19_rejectsRenameMissing = await rejects7(() => dropsync.vault.renameSpace('no-such-space-id', 'X'));
      // RENAME: inline row pattern — prefilled, Esc cancels cleanly, Enter commits, id STABLE.
      const spacesA = await dropsync.vault.listSpaces();
      const rtId = (spacesA.find((s) => s.name === 'RT WS') || {}).id;
      if (!rtId) { out.f19 = 'RT WS missing'; return done(out, '7'); }
      let menu7 = await openRowMenu7('RT WS');
      const renameEntry = menu7 ? menu7.querySelector('button[data-ws-rename-entry]') : null;
      out.f19_renameEntryVisible = !!renameEntry;
      if (!renameEntry) { out.f19 = 'no rename entry'; return done(out, '7'); }
      renameEntry.click();
      await sleep(300);
      let renRow = document.querySelector('[data-rename-space-row] input');
      out.f19_renamePrefilled = !!renRow && renRow.value === 'RT WS';
      out.f19_renameMaxLength120 = !!renRow && renRow.getAttribute('maxlength') === '120';
      if (renRow) {
        renRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(250);
      }
      out.f19_escCancelsRename = !document.querySelector('[data-rename-space-row]')
        && (await dropsync.vault.listSpaces()).find((s) => s.id === rtId).name === 'RT WS';
      menu7 = await openRowMenu7('RT WS');
      menu7.querySelector('button[data-ws-rename-entry]').click();
      await sleep(300);
      renRow = document.querySelector('[data-rename-space-row] input');
      setNativeValue(renRow, 'RT WS Renamed');
      renRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await sleep(1000);
      const spacesB = await dropsync.vault.listSpaces();
      const renamed = spacesB.find((s) => s.id === rtId);
      out.f19_renameCommitsOnEnter = !!renamed && renamed.name === 'RT WS Renamed';
      out.f19_idStableAfterRename = !!renamed;
      out.f19_spaceCountUnchanged = spacesB.length === spacesA.length;
      // Seed the FIX-19 delete-drill target through the BRIDGE; the dropdown only learns about
      // it after this stage's chained reload (bridge-side creates never touch the live store).
      try { for (const s of await dropsync.vault.listSpaces()) { if (s.name === 'Doomed WS') await dropsync.vault.deleteSpace(s.id); } } catch (e) {}
      const doomed = await dropsync.vault.createSpace('Doomed WS');
      await dropsync.drop.createFileFromPath('/tmp/opencode/e2e/big12.bin', { spaceId: doomed.id, expirationOption: 'forever', locked: false });
      await dropsync.vault.createCategory(doomed.id, 'DoomCat');
      localStorage.setItem('dropsync.sit3.f19ctx', JSON.stringify({ doomedId: doomed.id }));
      localStorage.setItem('dropsync.sit3.dom', '7b');
      setTimeout(() => location.reload(), 50);
      out.stage = '7';
      return JSON.stringify(out);
    }
    if (stage === '7b') {
      // ---- STAGE 7b: Personal shows NO rename/delete; delete NON-current with the web-parity
      // two-step guard; blob sweep at next unlock; serialization drills.
      const rejects7b = async (fn) => { try { await fn(); return false; } catch (e) { return true; } };
      const f19ctx = JSON.parse(localStorage.getItem('dropsync.sit3.f19ctx') || '{}');
      const doomedId = f19ctx.doomedId;
      if (!doomedId || !(await dropsync.vault.listSpaces()).some((s) => s.id === doomedId)) { out.f19 = 'doomed ctx missing'; localStorage.removeItem('dropsync.sit3.f19ctx'); return done(out, '7'); }
      // PERSONAL: its gear opens ONLY Import/Export backup options — never rename/delete.
      await openMenu();
      const pGear = document.querySelector('header .absolute.top-full button[title*="Personal options"]');
      out.f19_personalHasOwnGearOnly = !!pGear;
      if (pGear) {
        pGear.click();
        await sleep(300);
        const menuTexts = Array.from(document.querySelectorAll('header .absolute.top-full button')).map((b) => (b.textContent || '').trim());
        out.f19_personalNoRenameDelete = !menuTexts.some((t) => t.indexOf('Rename workspace') === 0 || t.indexOf('Delete workspace') === 0);
        out.f19_personalMenuHasBackup = menuTexts.some((t) => t.indexOf('Import backup') === 0);
        document.querySelector('header .fixed.inset-0.z-40').click();
        await sleep(250);
      }
      // DELETE non-current: the ctx-carried Doomed WS holds one file drop + one category.
      const openRowMenu7b = async (name) => {
        for (let attempt = 0; attempt < 4; attempt++) {
          await openMenu();
          await sleep(200);
          const menuEl = document.querySelector('header .absolute.top-full');
          const row = menuEl && Array.from(menuEl.querySelectorAll('div')).find((el) => el.className.indexOf('cursor-pointer') >= 0 && (el.textContent || '').trim() === name);
          const gear = row ? row.querySelector('button[data-ws-gear]') : null;
          if (gear) {
            gear.click();
            await sleep(350);
            const m2 = document.querySelector('header .absolute.top-full');
            if (m2 && m2.querySelector('button[data-ws-delete-entry]')) return m2;
          }
          const bd = document.querySelector('header .fixed.inset-0.z-40');
          if (bd) bd.click();
          await sleep(350);
        }
        return null;
      };
      const blobBefore = (await dropsync.dev.testOnly('blobFileCount', '')).count;
      let menu7b = await openRowMenu7b('Doomed WS');
      const delEntry = menu7b ? menu7b.querySelector('button[data-ws-delete-entry]') : null;
      out.f19_deleteEntryVisible = !!delEntry;
      if (!delEntry) { out.f19 = 'no delete entry'; return done(out, '7'); }
      delEntry.click();
      await sleep(300);
      const confirmBlock = document.querySelector('[data-ws-delete-confirm]');
      out.f19_guardStepShowsWebWording = !!confirmBlock && (confirmBlock.textContent || '').includes('permanently deletes the workspace and ALL its drops')
        && (confirmBlock.textContent || '').includes('cannot be undone');
      const backBtn7 = confirmBlock ? Array.from(confirmBlock.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Back') : null;
      if (backBtn7) backBtn7.click();
      await sleep(250);
      out.f19_backReturnsFromGuard = !document.querySelector('[data-ws-delete-confirm]')
        && !!(await dropsync.vault.listSpaces()).find((s) => s.id === doomedId);
      // Second approach → CONFIRM deletes.
      menu7b = await openRowMenu7b('Doomed WS');
      menu7b.querySelector('button[data-ws-delete-entry]').click();
      await sleep(300);
      const confirmBtn7 = document.querySelector('button[data-ws-confirm-delete]');
      if (!confirmBtn7) { out.f19 = 'no confirm button'; return done(out, '7'); }
      confirmBtn7.click();
      await sleep(1000);
      const spacesC = await dropsync.vault.listSpaces();
      out.f19_deleteRemovesSpace = !spacesC.some((s) => s.id === doomedId);
      out.f19_cascadeDropsGone = (await dropsync.drop.list(doomedId)).length === 0;
      out.f19_cascadeCategoriesGone = (await dropsync.vault.listCategories(doomedId)).length === 0;
      // Blob files are left for the unlock orphan sweep — relock/unlock proves the sweep.
      await dropsync.dev.testOnly('vaultLock', '');
      await dropsync.dev.testOnly('vaultUnlock', '');
      const blobAfter = (await dropsync.dev.testOnly('blobFileCount', '')).count;
      out.f19_blobsSweptAtUnlock = typeof blobBefore === 'number' && typeof blobAfter === 'number' && blobAfter < blobBefore;
      localStorage.setItem('dropsync.sit3.dom', '7c');
      setTimeout(() => location.reload(), 50);
      out.stage = '7b';
      return JSON.stringify(out);
    }
    if (stage === '7c') {
      // ---- STAGE 7c: delete CURRENT lands on Personal; serialization drills (concurrent
      // import vs rename; mid-export deletion aborts the export cleanly).
      const spacesD = await dropsync.vault.listSpaces();
      const renamedId = (spacesD.find((s) => s.name === 'RT WS Renamed') || {}).id;
      if (!renamedId) { out.f19 = 'RT WS Renamed missing'; return done(out, '7'); }
      // Switch to it so the header pill reflects the current workspace...
      await openMenu();
      let menuEl = document.querySelector('header .absolute.top-full');
      const rowD = Array.from(menuEl.querySelectorAll('div')).find((el) => el.className.indexOf('cursor-pointer') >= 0 && (el.textContent || '').trim() === 'RT WS Renamed');
      rowD.click();
      await sleep(1000);
      out.f19_headerPillShowsRenamed = (switcherPill().textContent || '').indexOf('RT WS Renamed') >= 0;
      // ...then delete the CURRENT workspace from its own row's ⚙.
      await openMenu();
      menuEl = document.querySelector('header .absolute.top-full');
      const rowDel = Array.from(menuEl.querySelectorAll('div')).find((el) => el.className.indexOf('cursor-pointer') >= 0 && (el.textContent || '').trim() === 'RT WS Renamed');
      rowDel.querySelector('button[data-ws-gear]').click();
      await sleep(300);
      document.querySelector('header .absolute.top-full button[data-ws-delete-entry]').click();
      await sleep(300);
      document.querySelector('button[data-ws-confirm-delete]').click();
      await sleep(1200);
      out.f19_deleteCurrentLandsOnPersonal = (switcherPill().textContent || '').indexOf('Personal') >= 0;
      out.f19_deletedCurrentGone = !(await dropsync.vault.listSpaces()).some((s) => s.id === renamedId);
      // SERIALIZATION DRILL A — concurrent import while renaming another space: both land.
      try {
        const serialSp = await dropsync.vault.createSpace('Serial Target');
        const impP = dropsync.vault.importRun({ filePath: '/tmp/ds-test-archives/web-drawing-test.dropsync', password: 'test-archive-pw', destination: { mode: 'new', name: 'Concurrent WS' } });
        await dropsync.vault.renameSpace(serialSp.id, 'Serial Renamed');
        const impRes = await impP;
        out.f19_concurrentImportOk = impRes.importedCount === 2;
        const spacesE = await dropsync.vault.listSpaces();
        out.f19_concurrentRenameOk = spacesE.some((s) => s.id === serialSp.id && s.name === 'Serial Renamed')
          && spacesE.some((s) => s.name === 'Concurrent WS');
      } catch (e) {
        out.f19_serializationA = e.message;
      }
      // SERIALIZATION DRILL B — deletion vs export. STRUCTURAL FINDING (flagged): the write
      // phase opens every payload stream via preparedEntries.map(...) BEFORE the first byte
      // flows, so once exporting has begun a concurrent delete can neither abort nor corrupt
      // it — the tick-synchronized race proved unhittable across 12 MB×6 and 300 MB×2 shapes.
      // Asserted instead: (a) whichever way it lands, NO .part files and a consistent vault;
      // (b) the deterministic clean-abort path — deleting BEFORE export start refuses with
      // 'That workspace no longer exists.' and leaves zero bytes behind.
      const doom2 = await dropsync.vault.createSpace('Export Doom');
      for (let i = 0; i < 2; i++) {
        await dropsync.drop.createFileFromPath('/tmp/opencode/e2e/big300.bin', { spaceId: doom2.id, expirationOption: 'forever', locked: false });
      }
      let exportRejected = false;
      let exportErr = '';
      let exportCompleted = false;
      try {
        let sawTick = false;
        const offTick = dropsync.onImportProgress((p) => { if (p.phase === 'export') sawTick = true; });
        const expP = dropsync.vault.export({ workspaceId: doom2.id }, 'stage7-doom-pw', '/tmp/opencode/e2e/stage7-doom.dropsync');
        const tickT0 = Date.now();
        while (!sawTick && Date.now() - tickT0 < 8000) { await new Promise((r) => setTimeout(r, 15)); }
        offTick();
        out.f19_midExportSawWritePhase = sawTick;
        const delOk = await dropsync.vault.deleteSpace(doom2.id);
        out.f19_midExportDeleteCommitted = delOk === true;
        await expP;
        exportCompleted = true;
      } catch (e) {
        exportRejected = true;
        exportErr = String(e.message || e);
      }
      out.f19_midExportOutcome = exportCompleted ? 'completed' : 'aborted';
      out.f19_midExportAbortError = exportErr.slice(0, 60);
      // Deterministic clean-abort: delete FIRST, then start the same export ⇒ refused.
      const doom3 = await dropsync.vault.createSpace('Export Doom Live');
      await dropsync.drop.createFileFromPath('/tmp/opencode/e2e/big12.bin', { spaceId: doom3.id, expirationOption: 'forever', locked: false });
      const delBefore = await dropsync.vault.deleteSpace(doom3.id);
      let refuseErr = '';
      try {
        await dropsync.vault.export({ workspaceId: doom3.id }, 'stage7-doom-pw', '/tmp/opencode/e2e/stage7-refused.dropsync');
      } catch (e) {
        refuseErr = String(e.message || e);
      }
      out.f19_deletedThenExportRefuses = delBefore === true && refuseErr.indexOf('no longer exists') >= 0;
      out.f19_refusalError = refuseErr.slice(0, 60);
      localStorage.removeItem('dropsync.sit3.f19ctx');
      localStorage.setItem('dropsync.sit3.dom', '8');
      setTimeout(() => location.reload(), 50);
      out.stage = '7';
      return JSON.stringify(out);
    }
    if (stage === '8') {
      // __STAGE8_FIX21__
      // ---- STAGE 8 (FIX 21 bridge half): import the WD3 "poisoned scene" fixture — manifest
      // drawingScene.appState carries collaborators:{} + junk runtime keys (bug #21's exact
      // shape: a web-side Map serialized through archiveFormat.extractDrawingScene's
      // JSON.parse(JSON.stringify(...))). Engine asserts land here; the editor drills chain
      // into '8b' (bridge-created spaces reach the renderer store only after a reload).
      try {
        for (const s of await dropsync.vault.listSpaces()) {
          if (['Poison Scene'].indexOf(s.name) >= 0) await dropsync.vault.deleteSpace(s.id);
        }
      } catch (e) { /* best-effort */ }
      let imp8 = null;
      try {
        imp8 = await dropsync.vault.importRun({ filePath: '/tmp/ds-test-archives/poisoned-scene-test.dropsync', password: 'test-archive-pw', destination: { mode: 'new', name: 'Poison Scene' } });
      } catch (e) { out.f21_import = e.message; return done(out, '8'); }
      out.f21_importOk = imp8.importedCount === 1;
      const sp8 = (await dropsync.vault.listSpaces()).find((s) => s.name === 'Poison Scene');
      const dto8 = sp8 ? (await dropsync.drop.list(sp8.id)).find((d) => d.name === 'WD3 Poisoned Scene') : null;
      const as8 = dto8 && dto8.drawingScene ? dto8.drawingScene.appState : null;
      out.f21_manifestCarriesPoison = !!as8 && typeof as8 === 'object'
        && as8.collaborators !== undefined && !(as8.collaborators instanceof Map)
        && Array.isArray(as8.snapLines);
      localStorage.setItem('dropsync.sit3.f21ctx', JSON.stringify({ spaceName: 'Poison Scene' }));
      localStorage.setItem('dropsync.sit3.dom', '8b');
      setTimeout(() => location.reload(), 50);
      out.stage = '8';
      return JSON.stringify(out);
    }
    if (stage === '8b') {
      // ---- STAGE 8b (FIX 21/22 DOM half): WD3 opens in EDIT with ZERO byte fetches, the cream
      // background surviving the FIX 21a whitelist, and live elements; the font sweep drives
      // through ALL Excalidraw families without unmounting the editor (22b, incl. save +
      // engine-side reopen proof); locally-drawn + WD1/WD2 round-6 signatures unchanged.
      // CSP font-src refusals are counted in-page via 'securitypolicyviolation' (runs only in
      // the dev-gated DOM-check boot).
      const EX8B = window.__EXCAL;
      if (!EX8B) { out.f21 = 'no excalidraw hook'; return done(out, '8'); }
      let fontViolations = 0;
      const violSamples = [];
      const violSchemes = {};
      const violListener = (ev) => {
        if (ev.effectiveDirective !== 'font-src') return;
        fontViolations++;
        const u = String(ev.blockedURL || '');
        const sch = u.split(':')[0] || 'unknown';
        violSchemes[sch] = (violSchemes[sch] || 0) + 1;
        if (violSamples.length < 3) {
          violSamples.push(JSON.stringify({ u: u.slice(0, 40), sf: String(ev.sourceFile || '').slice(-70), ln: ev.lineNumber }));
        }
      };
      document.addEventListener('securitypolicyviolation', violListener);
      // Prove which policy THIS boot actually serves (stop-and-flag input for 22a).
      const polMeta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      const polFont = polMeta ? (polMeta.getAttribute('content') || '').match(/font-src[^;]*/) : null;
      out.f22_livePolicyFontSrc = polFont ? polFont[0] : 'meta-missing';
      const byteStats8B = async () => (await dropsync.dev.testOnly('mediaByteFetchStats', '')).count;
      const resetByteStats8B = async () => { await dropsync.dev.testOnly('resetMediaByteFetchCount', ''); };
      const gotoSpace8B = async (name) => {
        await openMenu();
        const menuEl = document.querySelector('header .absolute.top-full');
        const row = Array.from(menuEl.querySelectorAll('div')).find((el) => el.className.indexOf('cursor-pointer') >= 0 && (el.textContent || '').trim() === name)
          || Array.from(menuEl.querySelectorAll('button')).find((el) => (el.textContent || '').trim() === name);
        if (!row) return false;
        row.click();
        await sleep(1000);
        return true;
      };
      const cardByName8B = (name) => {
        const h = cardH3s().find((x) => (x.getAttribute('title') || '') === name);
        return h ? h.closest('.cursor-pointer') : null;
      };
      const waitCard8B = async (name) => { let c = null; for (let i = 0; i < 24 && !c; i++) { await sleep(500); c = cardByName8B(name); } return c; };
      // Open a drawing card's preview, hit Edit, wait out extraction + Excalidraw mount.
      const openEditor8B = async (card) => {
        card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await sleep(800);
        const btn = document.querySelector('.fixed.inset-0 button[title="Edit"]');
        if (!btn) return false;
        await resetByteStats8B();
        btn.click();
        let ready = false;
        for (let i = 0; i < 30 && !ready; i++) { await sleep(300); ready = !Array.from(document.querySelectorAll('.fixed.inset-0 *')).some((el) => el.textContent === 'Loading drawing...'); }
        if (!ready) return false;
        let exUp = false;
        for (let i = 0; i < 30 && !exUp; i++) { await sleep(300); exUp = !!document.querySelector('.excalidraw'); }
        if (!exUp) return false;
        await sleep(900);
        return true;
      };
      const saveAttach8B = async () => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Save drawing');
        if (!btn) return false;
        btn.click();
        const t0 = Date.now();
        while (Date.now() - t0 < 3500) {
          if (Array.from(document.querySelectorAll('span')).find((s) => (s.textContent || '') === 'Drawing attached')) return true;
          await sleep(100);
        }
        return false;
      };
      const closeOverlays8B = async () => {
        for (let i = 0; i < 6; i++) {
          if (!document.querySelector('.fixed.inset-0')) return;
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await sleep(500);
          const disc = Array.from(document.querySelectorAll('.fixed.inset-0 button')).find((b) => (b.textContent || '').trim() === 'Discard');
          if (disc) { disc.click(); await sleep(400); }
        }
      };
      // ===== WD3 poisoned scene =====
      try {
        await gotoSpace8B('Poison Scene');
        const wd3Card = await waitCard8B('WD3 Poisoned Scene');
        out.f21_wd3CardFound = !!wd3Card;
        const mountedWd3 = wd3Card ? await openEditor8B(wd3Card) : false;
        out.f21_editorMounted = mountedWd3;
        out.f21_zeroByteFetches = mountedWd3 ? ((await byteStats8B()) === 0) : false;
        const swatch8 = Array.from(document.querySelectorAll('.fixed.inset-0 button[style]')).filter((b) => {
          const st = b.getAttribute('style') || '';
          // Chrome serializes inline styles as rgb(); accept both spellings of cream.
          return st.indexOf('fffef5') >= 0 || st.indexOf('255, 254, 245') >= 0;
        });
        out.f21_backgroundSurvives = mountedWd3 && swatch8.length === 1 && swatch8[0].className.indexOf('scale-110') >= 0;
        // ===== f22 font sweep (inside THIS editor session) =====
        const api8 = window.__DRAWING_API || null;
        out.f22_apiHookPresent = !!api8;
        let textId8 = null;
        if (api8 && EX8B.convertToExcalidrawElements) {
          try {
            const conv = EX8B.convertToExcalidrawElements([{ type: 'text', x: 80, y: 80, text: 'font probe' }]);
            const curr = api8.getSceneElementsIncludingDeleted() || [];
            api8.updateScene({ elements: curr.concat(conv) });
            const t8 = (api8.getSceneElementsIncludingDeleted() || []).find((e) => e.type === 'text' && !e.isDeleted);
            textId8 = t8 ? t8.id : null;
          } catch (e) { out.f22_seedError = String(e.message || e).slice(0, 60); }
        }
        out.f22_textSeeded = !!textId8;
        // Enter TEXT EDIT via a real dblclick at the element's screen position — #22's teardown
        // path only arms while the text editor is active. Recorded honestly if it misses.
        let editing8 = false;
        try {
          if (api8 && textId8) {
            const cv8 = document.querySelector('.excalidraw .excalidraw__canvas.interactive') || document.querySelector('.excalidraw canvas');
            const el8 = (api8.getSceneElementsIncludingDeleted() || []).find((e) => e.id === textId8);
            if (cv8 && el8) {
              const r8 = cv8.getBoundingClientRect();
              const cx8 = r8.left + el8.x + (el8.width || 40) / 2;
              const cy8 = r8.top + el8.y + (el8.height || 24) / 2;
              cv8.dispatchEvent(new MouseEvent('mousedown', { clientX: cx8, clientY: cy8, bubbles: true }));
              cv8.dispatchEvent(new MouseEvent('mouseup', { clientX: cx8, clientY: cy8, bubbles: true }));
              cv8.dispatchEvent(new MouseEvent('dblclick', { clientX: cx8, clientY: cy8, bubbles: true }));
              await sleep(700);
              editing8 = !!document.querySelector('.excalidraw textarea');
            }
          }
        } catch (e) { out.f22_editEnterError = String(e.message || e).slice(0, 60); }
        out.f22_editModeEntered = editing8;
        let tried8 = 0; let ok8 = 0;
        if (api8 && textId8) {
          for (const fam of [1, 2, 3, 4, 5, 6, 7, 8]) {
            tried8++;
            try {
              const els8 = api8.getSceneElementsIncludingDeleted() || [];
              api8.updateScene({ elements: els8.map((e) => (e.id === textId8 ? Object.assign({}, e, { fontFamily: fam, version: e.version + 1 }) : e)) });
            } catch (e) { out.f22_switchError = fam + ':' + String(e.message || e).slice(0, 50); }
            await sleep(650);
            const alive8 = !!document.querySelector('.excalidraw')
              && !!Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Save drawing');
            if (alive8) ok8++;
          }
        }
        out.f22_familiesTried = tried8;
        out.f22_allFamiliesSurvived = tried8 > 0 && ok8 === tried8;
        // Exit TEXT EDIT the way a real pointer does: commit with a click on empty canvas
        // (a document-level Escape reaches the modal's own escape hook and closes the editor).
        try {
          const cvC8 = document.querySelector('.excalidraw .excalidraw__canvas.interactive') || document.querySelector('.excalidraw canvas');
          if (cvC8) {
            const rr8 = cvC8.getBoundingClientRect();
            const px8 = rr8.left + 30; const py8 = rr8.top + 30;
            cvC8.dispatchEvent(new MouseEvent('mousedown', { clientX: px8, clientY: py8, bubbles: true }));
            cvC8.dispatchEvent(new MouseEvent('mouseup', { clientX: px8, clientY: py8, bubbles: true }));
          }
        } catch (e) { /* commit attempt best-effort */ }
        await sleep(600);
        out.f22_editCommitted = !document.querySelector('.excalidraw textarea');
        out.f21_elementsLive = await saveAttach8B();
        const submit8 = Array.from(document.querySelectorAll('.fixed.inset-0 button')).find((b) => (b.textContent || '').trim() === 'Save changes');
        out.f22_saveChangesClicked = !!submit8;
        if (submit8) { submit8.click(); await sleep(1800); }
        const prevImg8 = Array.from(document.querySelectorAll('.fixed.inset-0 img')).find((i) => (i.getAttribute('src') || '').indexOf('media://r/') === 0);
        out.f22_previewReopened = !!prevImg8 && prevImg8.naturalWidth > 0;
        await closeOverlays8B();
        // Engine side: the saved FILE slot parses back to a scene containing our text.
        const sp8b = (await dropsync.vault.listSpaces()).find((s) => s.name === 'Poison Scene');
        const dto8b = sp8b ? (await dropsync.drop.list(sp8b.id)).find((d) => d.name === 'WD3 Poisoned Scene') : null;
        out.f22_savedFileSlot = !!dto8b && dto8b.hasFilePayload === true;
        let reopenedText = false;
        try {
          const b8 = dto8b && dto8b.hasFilePayload ? await dropsync.media.getBytes(dto8b.id, 'file') : null;
          if (b8) {
            const sc8 = await EX8B.loadFromBlob(new Blob([b8], { type: 'image/png' }), null, null);
            const txt8 = sc8.elements.find((e) => e.type === 'text' && !e.isDeleted);
            reopenedText = !!txt8 && String(txt8.text || '').indexOf('font probe') >= 0;
          }
        } catch (e) { out.f22_reopenParseError = String(e.message || e).slice(0, 60); }
        out.f22_reopenShowsText = reopenedText;
        out.f22_fontSwitchSurvives = out.f22_allFamiliesSurvived === true && out.f22_reopenShowsText === true;
      } catch (e) { out.f21_wd3Err = String(e.message || e).slice(0, 80); }
      out.f21_poisonedSceneOpensEditor = out.f21_wd3CardFound === true && out.f21_editorMounted === true
        && out.f21_zeroByteFetches === true && out.f21_backgroundSurvives === true && out.f21_elementsLive === true;
      // ===== locally-drawn regression (fallback PNG path untouched) =====
      let localOk8 = false;
      try {
        const mkR8 = { id: 'loc7-el', type: 'rectangle', x: 10, y: 10, width: 100, height: 60, angle: 0, strokeColor: '#1a1a1a', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 7, version: 1, versionNonce: 7, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false };
        const blobL8 = await EX8B.exportToBlob({ elements: [mkR8], appState: { viewBackgroundColor: '#ffffff', exportBackground: true, exportEmbedScene: true }, files: {}, exportPadding: 10 });
        await dropsync.drop.createText({ spaceId: 'personal', name: 'Loc7', content: '', expirationOption: 'forever', categories: [], locked: false, reminderAt: null, pngBytes: new Uint8Array(await blobL8.arrayBuffer()) });
        await gotoSpace8B('Personal');
        const locCard = await waitCard8B('Loc7');
        const locMounted = locCard ? await openEditor8B(locCard) : false;
        const locFetch = locMounted ? ((await byteStats8B()) >= 1) : false;
        const locLive = locMounted ? await saveAttach8B() : false;
        localOk8 = !!locCard && locMounted && locFetch && locLive;
        await closeOverlays8B();
      } catch (e) { out.f21_localErr = String(e.message || e).slice(0, 80); }
      out.f21_localDrawingRegression = localOk8;
      // ===== WD1/WD2 round-6 signatures =====
      let wdOk8 = false;
      try {
        await gotoSpace8B('Web Drawings');
        const c1 = await waitCard8B('WD1 Manifest Scene');
        const c2 = await waitCard8B('WD2 Embedded Scene');
        let wd1ok = false; let wd2ok = false;
        if (c1) {
          const m1 = await openEditor8B(c1);
          wd1ok = m1 && ((await byteStats8B()) === 0) && (await saveAttach8B());
          await closeOverlays8B();
        }
        if (c2) {
          const m2 = await openEditor8B(c2);
          wd2ok = m2 && ((await byteStats8B()) >= 1) && (await saveAttach8B());
          await closeOverlays8B();
        }
        wdOk8 = !!c1 && !!c2 && wd1ok && wd2ok;
      } catch (e) { out.f21_wdErr = String(e.message || e).slice(0, 80); }
      out.f21_wd1_wd2_regressions = wdOk8;
      out.f22_fontSrcViolations = fontViolations;
      out.f22_violationSchemes = violSchemes;
      out.f22_violationSamples = violSamples;
      // Font census — the 22a ground truth: faces must actually LOAD under the widened policy.
      try {
        const faces8 = Array.from(document.fonts);
        const loaded8 = faces8.filter((f) => f.status === 'loaded');
        out.f22_fontsLoadedCount = loaded8.length;
        out.f22_fontFamiliesLoaded = JSON.stringify(Array.from(new Set(loaded8.map((f) => String(f.family)))).slice(0, 12));
      } catch (e) { out.f22_fontsCensusErr = String(e.message || e).slice(0, 40); }
      document.removeEventListener('securitypolicyviolation', violListener);
      localStorage.removeItem('dropsync.sit3.f21ctx');
      localStorage.setItem('dropsync.sit3.dom', '9');
      setTimeout(() => location.reload(), 50);
      out.stage = '8';
      return JSON.stringify(out);
    }
    if (stage === '9') {
      // __STAGE9_FIX22B__
      // ---- STAGE 9 (Round 8, PHASE 1 + 2): reproduce #22b on the TRUE surface — REAL toolbar
      // font clicks via Excalidraw's own DOM ([data-testid=font-family-*] trigger/buttons +
      // .dropdown-menu-item popover entries), never __DRAWING_API. Matrix: mode(create|edit) ×
      // (nothing-selected | text-selected | textarea-open-typed). Phase-2 keys come from the
      // dev-gated window.__DC_METRICS ring (mounts/unmounts/api/changes/didCatch + seq) plus
      // post-mortem scene inspection, answering: (a) does OUR subtree remount on click,
      // (b) did the text commit before the throw, (c) our-layer sequence around the crash.
      const EX9 = window.__EXCAL;
      if (!EX9) { out.f22b = 'no excalidraw hook'; return done(out, '9'); }
      const M9 = () => (window.__DC_METRICS || null);
      const snapM9 = () => { const m = M9(); return m ? m.mounts + '/' + m.unmounts + '/' + m.apiCalls : '-'; };
      const alive9 = () => !!document.querySelector('.excalidraw')
        && !!Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Save drawing')
        && !Array.from(document.querySelectorAll('h1')).find((h) => (h.textContent || '') === 'Something went wrong');
      const gotoSpace9 = async (name) => {
        await openMenu();
        const menuEl = document.querySelector('header .absolute.top-full');
        const row = Array.from(menuEl.querySelectorAll('div')).find((el) => el.className.indexOf('cursor-pointer') >= 0 && (el.textContent || '').trim() === name)
          || Array.from(menuEl.querySelectorAll('button')).find((el) => (el.textContent || '').trim() === name);
        if (!row) return false;
        row.click();
        await sleep(1000);
        return true;
      };
      const cardByName9 = (name) => {
        const h = cardH3s().find((x) => (x.getAttribute('title') || '') === name);
        return h ? h.closest('.cursor-pointer') : null;
      };
      const closeOverlays9 = async () => {
        for (let i = 0; i < 6; i++) {
          if (!document.querySelector('.fixed.inset-0')) return;
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await sleep(450);
          const disc = Array.from(document.querySelectorAll('.fixed.inset-0 button')).find((b) => (b.textContent || '').trim() === 'Discard');
          if (disc) { disc.click(); await sleep(350); }
        }
      };
      const canvasCenter9 = () => {
        const cv = document.querySelector('.excalidraw .excalidraw__canvas.interactive') || document.querySelector('.excalidraw canvas');
        if (!cv) return null;
        const r = cv.getBoundingClientRect();
        return { r, cx: r.left + Math.min(170, r.width * 0.45), cy: r.top + 120, ex: r.left + 30, ey: r.top + 30 };
      };
      const pointerTap9 = (x, y) => {
        const cv = document.querySelector('.excalidraw .excalidraw__canvas.interactive') || document.querySelector('.excalidraw canvas');
        if (!cv) return false;
        const opts = { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1, isPrimary: true };
        // Excalidraw binds NATIVE pointerdown/pointerup — PointerEvents are mandatory; MouseEvents
        // alone never select (round-8 phase-1 finding).
        try {
          cv.dispatchEvent(new PointerEvent('pointerdown', opts));
          cv.dispatchEvent(new PointerEvent('pointerup', opts));
        } catch (e) { /* older engines */ }
        cv.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true }));
        cv.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, bubbles: true }));
        return true;
      };
      // Create a text element by double-clicking empty canvas (Excalidraw's own path), then
      // type into the wysiwyg textarea. Returns { ta } with the textarea still OPEN.
      const seedTextViaDblclick9 = async () => {
        const p = canvasCenter9();
        if (!p) return { ok: false, note: 'no-canvas' };
        const cv = document.querySelector('.excalidraw .excalidraw__canvas.interactive') || document.querySelector('.excalidraw canvas');
        cv.dispatchEvent(new MouseEvent('mousedown', { clientX: p.cx, clientY: p.cy, bubbles: true }));
        cv.dispatchEvent(new MouseEvent('mouseup', { clientX: p.cx, clientY: p.cy, bubbles: true }));
        cv.dispatchEvent(new MouseEvent('dblclick', { clientX: p.cx, clientY: p.cy, bubbles: true }));
        let ta = null;
        for (let i = 0; i < 16 && !ta; i++) { await sleep(250); ta = document.querySelector('.excalidraw textarea'); }
        if (!ta) return { ok: false, note: 'no-textarea' };
        try {
          const setV = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          setV.call(ta, 'hi');
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        } catch (e) { return { ok: false, note: 'type-failed' }; }
        await sleep(300);
        return { ok: true, note: '' };
      };
      // Mobile layout: the properties panel lives behind the bottom-bar "Edit menu" toggle
      // (actionToggleEditMenu). Open it, then use the same desktop selectors inside.
      const openShapeMenu9 = async () => {
        const cands = Array.from(document.querySelectorAll('.excalidraw button'));
        let toggle = cands.find((b) => {
          const al = (b.getAttribute('aria-label') || '') + '|' + (b.getAttribute('title') || '') + '|' + (b.textContent || '');
          return al.indexOf('Edit') >= 0 || al.indexOf('edit menu') >= 0;
        });
        if (!toggle) return { ok: false, note: 'no-toggle', census: cands.map((b) => (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').slice(0, 16)).slice(0, 14).join('|') };
        toggle.click();
        await sleep(500);
        const ok = !!document.querySelector('[data-testid="font-family-show-fonts"]');
        if (!ok) return { ok: false, note: 'menu-open-no-trigger', census: '' };
        return { ok: true, note: '' };
      };
      const commitTextAndSelect9 = async () => {
        const p = canvasCenter9();
        if (!p) return { ok: false, note: 'no-canvas' };
        pointerTap9(p.ex, p.ey); // click-away commits the wysiwyg (blur → handleSubmit)
        await sleep(700);
        // Selection: prefer real pointer taps; fall back to appState selection through the
        // exposed editor API (documented setup shortcut — the CRASH surface stays the real
        // toolbar click either way).
        const apiSel9 = async () => {
          try {
            const api = window.__DRAWING_API;
            if (!api || !api.getSceneElementsIncludingDeleted) return false;
            const els = api.getSceneElementsIncludingDeleted() || [];
            let t = null;
            for (let k = els.length - 1; k >= 0; k--) { if (els[k].type === 'text' && !els[k].isDeleted) { t = els[k]; break; } }
            if (!t) return false;
            api.updateScene({ appState: { selectedElementIds: { [t.id]: true }, selectedGroupIds: {}, editingGroupId: null } });
            await sleep(450);
            return !!document.querySelector('[data-testid="font-family-show-fonts"]');
          } catch (e) { return false; }
        };
        for (let attempt = 0; attempt < 2; attempt++) {
          pointerTap9(p.cx, p.cy);
          await sleep(550);
          if (document.querySelector('[data-testid="font-family-show-fonts"]')) break;
        }
        let trig = document.querySelector('[data-testid="font-family-show-fonts"]');
        let how = trig ? 'pointer' : '';
        if (!trig) {
          const okApi = await apiSel9();
          trig = document.querySelector('[data-testid="font-family-show-fonts"]');
          how = okApi ? 'api-fallback' : '';
        }
        if (!trig) {
          const menuTry = await openShapeMenu9();
          if (menuTry.ok) { trig = document.querySelector('[data-testid="font-family-show-fonts"]'); how = (how ? how + '+' : '') + 'shape-menu'; }
        }
        if (!trig) {
          try {
            const api2 = window.__DRAWING_API;
            const st = api2 && api2.getAppState ? api2.getAppState() : null;
            out.f22b_selDebug = JSON.stringify({
              sel: st ? Object.keys(st.selectedElementIds || {}).length : -1,
              els: (() => { try { return (api2.getSceneElementsIncludingDeleted() || []).filter((e) => !e.isDeleted).map((e) => e.type).join(','); } catch (er) { return 'err'; } })(),
              menuNote: menuTry.note,
              btnCensus: menuTry.census || '',
            });
          } catch (e) { out.f22b_selDebug = 'err'; }
          return { ok: false, note: 'no-font-trigger' };
        }
        out.f22b_lastSelectHow = how;
        return { ok: true, note: '' };
      };
      const deselectOnly9 = async () => {
        const p = canvasCenter9();
        if (!p) return { ok: false, note: 'no-canvas' };
        pointerTap9(p.ex, p.ey);
        await sleep(600);
        const trig = document.querySelector('[data-testid="font-family-show-fonts"]');
        out['f22b_noControlWhenDeselected'] = !trig;
        return { ok: true, note: trig ? 'trigger-still-visible' : '' };
      };
      // THE TRUE SURFACE: real toolbar clicks. Direct default buttons first (hand-drawn /
      // normal / code), then the popover route through every registered family value.
      const clickFamilies9 = async () => {
        // Mobile layout: surface the properties panel first (Edit-menu toggle) if not open.
        if (!document.querySelector('[data-testid="font-family-show-fonts"]')
          && !document.querySelector('[data-testid="font-family-hand-drawn"]')) {
          const sm = await openShapeMenu9();
          if (!sm.ok) return { dead: false, via: 'shape-menu:' + sm.note + ':' + (sm.census || ''), clicked: '' };
        }
        const direct = ['font-family-hand-drawn', 'font-family-normal', 'font-family-code'];
        const clickedDirect = [];
        for (let i = 0; i < direct.length; i++) {
          const b = document.querySelector('[data-testid="' + direct[i] + '"]');
          if (!b) continue;
          b.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
          b.click();
          clickedDirect.push(direct[i]);
          await sleep(500);
          if (!alive9()) return { dead: true, via: direct[i], clicked: clickedDirect.join(',') };
        }
        const vals = ['1', '2', '3', '4', '5', '6', '7', '8'];
        const clickedPop = [];
        for (let j = 0; j < vals.length; j++) {
          if (!alive9()) return { dead: true, via: 'pre-popover-' + vals[j], clicked: clickedPop.join(',') };
          const trig = document.querySelector('[data-testid="font-family-show-fonts"]');
          if (!trig) break;
          trig.click();
          await sleep(400);
          const item = document.querySelector('.dropdown-menu-item[value="' + vals[j] + '"]');
          if (!item) continue;
          // Click-time editor context — what state is the wysiwyg machinery in?
          try {
            const apiC = window.__DRAWING_API;
            const stC = apiC && apiC.getAppState ? apiC.getAppState() : null;
            out.f22b_clickCtx = JSON.stringify({
              fam: vals[j],
              taInDom: !!document.querySelector('.excalidraw textarea'),
              active: document.activeElement ? document.activeElement.tagName + '.' + String(document.activeElement.className || '').slice(0, 24) : 'none',
              editing: stC ? !!stC.editingTextElement : 'na',
              openMenu: stC ? stC.openMenu : 'na',
            });
          } catch (e) { out.f22b_clickCtx = 'err'; }
          item.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
          item.click();
          clickedPop.push(vals[j]);
          await sleep(500);
          if (!alive9()) return { dead: true, via: 'popover-' + vals[j], clicked: clickedPop.join(',') };
        }
        return { dead: false, via: '', clicked: clickedDirect.concat(clickedPop).join(',') };
      };
      // EDIT-mode source drawing: reuse or seed a local one named Loc9 (rerun-safe).
      const ensureLoc9 = async () => {
        const dtos = await dropsync.drop.list('personal');
        let loc9 = dtos.find((d) => d.name === 'Loc9' && d.isDrawing);
        if (loc9) return true;
        try {
          const mkR = { id: 'loc9-el', type: 'rectangle', x: 10, y: 10, width: 100, height: 60, angle: 0, strokeColor: '#1a1a1a', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 9, version: 1, versionNonce: 9, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false };
          const blobL = await EX9.exportToBlob({ elements: [mkR], appState: { viewBackgroundColor: '#ffffff', exportBackground: true, exportEmbedScene: true }, files: {}, exportPadding: 10 });
          await dropsync.drop.createText({ spaceId: 'personal', name: 'Loc9', content: '', expirationOption: 'forever', categories: [], locked: false, reminderAt: null, pngBytes: new Uint8Array(await blobL.arrayBuffer()) });
          return true;
        } catch (e) { out.f22b_loc9Seed = String(e.message || e).slice(0, 60); return false; }
      };
      const openCreateEditor9 = async () => {
        const addBtn = Array.from(document.querySelectorAll('main button')).find((b) => (b.textContent || '').trim() === 'Add Text');
        if (!addBtn) return { ok: false, note: 'no-add-text' };
        addBtn.click();
        await sleep(600);
        const drawTab = Array.from(document.querySelectorAll('.fixed.inset-0 button')).find((b) => (b.textContent || '').trim() === 'Draw');
        if (!drawTab) return { ok: false, note: 'no-draw-tab' };
        drawTab.click();
        for (let i = 0; i < 30; i++) { await sleep(300); if (alive9()) break; }
        if (!alive9()) return { ok: false, note: 'create-canvas-not-up' };
        await sleep(600);
        return { ok: true, note: '' };
      };
      const openEditEditor9 = async () => {
        if (!(await gotoSpace9('Personal'))) return { ok: false, note: 'no-personal' };
        let card = null;
        for (let i = 0; i < 24 && !card; i++) { await sleep(500); card = cardByName9('Loc9'); }
        if (!card) return { ok: false, note: 'no-loc9-card' };
        card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await sleep(800);
        const btn = document.querySelector('.fixed.inset-0 button[title="Edit"]');
        if (!btn) return { ok: false, note: 'no-edit-btn' };
        btn.click();
        let ready = false;
        for (let i = 0; i < 30 && !ready; i++) { await sleep(300); ready = !Array.from(document.querySelectorAll('.fixed.inset-0 *')).some((el) => el.textContent === 'Loading drawing...'); }
        if (!ready) return { ok: false, note: 'extract-not-done' };
        let up = false;
        for (let i = 0; i < 30 && !up; i++) { await sleep(300); up = !!document.querySelector('.excalidraw'); }
        if (!up) return { ok: false, note: 'editor-not-mounted' };
        await sleep(900);
        let txt = null;
        for (let i = 0; i < 24 && !txt; i++) {
          await sleep(500);
          const api = window.__DRAWING_API;
          const els = api ? (api.getSceneElementsIncludingDeleted() || []) : [];
          for (let k = els.length - 1; k >= 0; k--) { if (els[k].type === 'text' && !els[k].isDeleted) { txt = els[k].id; break; } }
        }
        if (!txt) return { ok: false, note: 'scene-text-missing' };
        return { ok: true, note: '' };
      };
      const textAfterCell9 = () => {
        try {
          const api = window.__DRAWING_API;
          const els = api ? (api.getSceneElementsIncludingDeleted() || []) : [];
          let t = null;
          for (let k = els.length - 1; k >= 0; k--) { if (els[k].type === 'text' && !els[k].isDeleted) { t = els[k]; break; } }
          return t ? ('text:' + String(t.text).slice(0, 12) + '|fam:' + t.fontFamily) : 'none';
        } catch (e) { return 'err'; }
      };
      const runCell9 = async (cellId, prepare) => {
        if (window.__DC_RESET) window.__DC_RESET();
        window.__R8CELL = cellId;
        if (!window.__R8ERR) {
          window.__R8ERR = [];
          window.addEventListener('error', (ev) => {
            const st = ev.error && ev.error.stack ? String(ev.error.stack) : '';
            const frames = st.split('\\n').slice(0, 10).join(' << ').replace(/\\s+/g, ' ').slice(0, 900);
            window.__R8ERR.push('[' + (window.__R8CELL || '?') + '] ' + String(ev.message || ev.error).slice(0, 60) + ' FRAMES ' + frames);
          });
          window.addEventListener('unhandledrejection', (ev) => {
            window.__R8ERR.push('rej:' + String(ev.reason && ev.reason.message ? ev.reason.message : ev.reason).slice(0, 120));
          });
        }
        const pre = snapM9();
        const prep = await prepare();
        let res = { dead: false, via: '', clicked: '' };
        if (prep.ok) res = await clickFamilies9();
        else res = { dead: false, via: 'prep-fail:' + prep.note, clicked: '' };
        const post = snapM9();
        out['f22b_' + cellId] = prep.ok ? !res.dead : false;
        out['f22b_' + cellId + '_via'] = res.via || '';
        out['f22b_' + cellId + '_clicked'] = res.clicked || '';
        out['f22b_' + cellId + '_m'] = pre + '→' + post;
        const mm = M9();
        out['f22b_' + cellId + '_changes'] = mm ? mm.changes : -1;
        out['f22b_' + cellId + '_didCatch'] = mm ? mm.didCatch : -1;
        out['f22b_' + cellId + '_seq'] = mm ? JSON.stringify(mm.seq.slice(-8)) : '';
        out['f22b_' + cellId + '_sceneAfter'] = textAfterCell9();
        const werr = window.__R8ERR || [];
        if (werr.length) out['f22b_winErr'] = JSON.stringify(werr.slice(-3));
        await closeOverlays9();
        await sleep(300);
      };
      // ===== FIX 23 probe (Round 9): import as a NEW WORKSPACE through the REAL ImportModal
      // UI (dialog:pickOpen stubbed, env-gated main-side), then assert — with NO manual
      // refresh — that (a) the engine list grew by one under the modal's auto name,
      // (b) the header pill already shows the new workspace (onImported wiring), and
      // (c) no loading skeleton flickered (refreshSpaces no-blink contract).
      try {
        const spacesBefore9 = (await dropsync.vault.listSpaces()).length;
        const flicker9 = { seen: false };
        const mo9 = new MutationObserver((muts) => {
          for (const m of muts) for (const n of m.addedNodes) {
            if (n.nodeType === 1 && /animate-pulse/.test((n.className || '') + '')) flicker9.seen = true;
          }
        });
        mo9.observe(document.body, { childList: true, subtree: true });
        const impTrig = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Import workspace');
        if (!impTrig) { out.f22b_fix23_open = 'no-trigger'; }
        else {
          impTrig.click();
          await sleep(400);
          const q = (txt) => Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === txt);
          const chooseBtn = q('Choose a .dropsync file…');
          chooseBtn.click(); // stub resolves the fixture path instantly
          await sleep(500);
          const pwInput = document.querySelector('input[autocomplete="current-password"]');
          const setVal = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setVal.call(pwInput, 'test-archive-pw');
          pwInput.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(200);
          q('Check backup').click();
          // Wait until the import button exists AND is enabled (inspection round-trip settles).
          let importBtn = null;
          let w2 = 0;
          while (w2 < 15000) {
            await sleep(500); w2 += 500;
            const b = q('Import backup');
            if (b && !b.disabled) { importBtn = b; break; }
          }
          out.f22b_fix23_uiReady = !!chooseBtn && !!pwInput && !!importBtn;
          // Rerun-safe unique workspace name (modal prefills '<base> Restored'; override it).
          const wsName9 = 'R9 Fix23 ' + Date.now();
          const nameInput = Array.from(document.querySelectorAll('input'))
            .find((i) => i.type !== 'password' && i.getAttribute('maxlength') === '120');
          if (nameInput) {
            setVal.call(nameInput, wsName9);
            nameInput.dispatchEvent(new Event('input', { bubbles: true }));
            await sleep(200);
          }
          importBtn.click();
          let waited = 0;
          while (waited < 30_000) {
            await sleep(1000); waited += 1000;
            if ((await dropsync.vault.listSpaces()).length > spacesBefore9) break;
          }
          await sleep(800); // let onImported → setCurrentSpace + refreshSpaces settle
          const spacesAfter = await dropsync.vault.listSpaces();
          out.f22b_fix23_spaceListedImmediately = spacesAfter.length === spacesBefore9 + 1
            && spacesAfter.some((s) => s.name === wsName9);
          const headerTexts = Array.from(document.querySelectorAll('header span')).map((s) => (s.textContent || '').trim()).join('|');
          out.f22b_fix23_headerPill = headerTexts.includes(wsName9);
          if (!out.f22b_fix23_spaceListedImmediately) {
            const modal = document.querySelector('.fixed.inset-0');
            out.f22b_fix23_modalTail = modal ? (modal.textContent || '').replace(/\s+/g, ' ').slice(-140) : 'modal-gone';
          }
          mo9.disconnect();
          out.f22b_fix23_noLoadingFlicker = !flicker9.seen;
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await sleep(400);
          await gotoSpace9('Personal'); // restore the space the drawing cells expect
        }
      } catch (e) { out.f22b_fix23_err = String(e.message || e).slice(0, 80); }

      // ===== CREATE-mode cells =====
      const seedCommitSelect9 = async () => {
        const s = await seedTextViaDblclick9();
        if (!s.ok) return s;
        // DISCRIMINATOR (round-8 phase-2): add a non-text sibling so the create-mode scene
        // matches the edit-mode composition (rectangle + text). If THIS now crashes, the
        // trigger is scene composition, not modal mode.
        try {
          const apiD = window.__DRAWING_API;
          if (apiD && EX9.convertToExcalidrawElements) {
            const rectEls = EX9.convertToExcalidrawElements([{ type: 'rectangle', x: 260, y: 60, width: 100, height: 60 }]);
            const curr = apiD.getSceneElementsIncludingDeleted() || [];
            apiD.updateScene({ elements: curr.concat(rectEls) });
          }
        } catch (e) { out.f22b_rectInject = String(e.message || e).slice(0, 40); }
        return await commitTextAndSelect9();
      };
      if (!(await openCreateEditor9())) { out.f22b_createOpen = 'failed'; }
      else {
        await runCell9('create_textarea_typed', seedTextViaDblclick9);
        if (!(await openCreateEditor9())) { out.f22b_createReopenA = 'failed'; }
        else await runCell9('create_text_selected', seedCommitSelect9);
        if (!(await openCreateEditor9())) { out.f22b_createReopenB = 'failed'; }
        else {
          await seedTextViaDblclick9();
          await runCell9('create_nothing_selected', deselectOnly9);
        }
      }
      // ===== EDIT-mode cells =====
      if (!(await ensureLoc9())) { out.f22b_editSetup = 'seed-failed'; }
      else {
        let op = await openEditEditor9();
        if (!op.ok) { out.f22b_edit_textarea_typed = false; out.f22b_edit_textarea_typed_via = 'open:' + op.note; }
        else await runCell9('edit_textarea_typed', seedTextViaDblclick9);
        op = await openEditEditor9();
        if (!op.ok) { out.f22b_edit_text_selected = false; out.f22b_edit_text_selected_via = 'open:' + op.note; }
        else await runCell9('edit_text_selected', seedCommitSelect9);
        op = await openEditEditor9();
        if (!op.ok) { out.f22b_edit_nothing_selected = false; out.f22b_edit_nothing_selected_via = 'open:' + op.note; }
        else {
          await seedTextViaDblclick9();
          await runCell9('edit_nothing_selected', deselectOnly9);
        }
        // PROBE (phase-2): does wiping initialData via resetScene disarm the trap?
        op = await openEditEditor9();
        if (!op.ok) { out.f22b_edit_reset_probe = false; out.f22b_edit_reset_probe_via = 'open:' + op.note; }
        else {
          try {
            const apiR = window.__DRAWING_API;
            if (apiR && apiR.resetScene) apiR.resetScene();
            await sleep(400);
          } catch (e) { out.f22b_resetErr = String(e.message || e).slice(0, 40); }
          const s2 = await seedCommitSelect9();
          out['f22b_edit_reset_probe_prep'] = s2.ok ? 'ok' : s2.note;
          const r2 = s2.ok ? await clickFamilies9() : { dead: false, via: 'prep-fail' };
          out.f22b_edit_reset_probe = s2.ok ? !r2.dead : false;
          out['f22b_edit_reset_probe_via'] = r2.via || '';
          await closeOverlays9();
        }
      }
      // Composites per §Phase-1 matrix semantics (true = survived every family click).
      out.f22b_matrix = JSON.stringify({
        create_ta: out.f22b_create_textarea_typed === true,
        create_sel: out.f22b_create_text_selected === true,
        create_desel: out.f22b_create_nothing_selected === true,
        edit_ta: out.f22b_edit_textarea_typed === true,
        edit_sel: out.f22b_edit_text_selected === true,
        edit_desel: out.f22b_edit_nothing_selected === true,
      });
      // PHASE-2 ground truth: what does the page see?
      out.f22b_assetPath = typeof window.EXCALIDRAW_ASSET_PATH === 'undefined' ? 'undefined' : String(window.EXCALIDRAW_ASSET_PATH);
      try {
        const famProbe = ['Excalifont', 'Nunito', 'Virgil', 'Cascadia', 'Comic Shanns', 'Lilita One', 'Helvetica', 'Liberation Sans'];
        const facesAll = Array.from(document.fonts);
        const tally = { loaded: 0, error: 0, unloaded: 0, loading: 0 };
        facesAll.forEach((f) => { tally[f.status] = (tally[f.status] || 0) + 1; });
        const perFam = {};
        famProbe.forEach((fam) => {
          const ff = facesAll.filter((f) => f.family === fam || f.family === '"' + fam + '"');
          const bad = ff.filter((f) => f.status === 'error').length;
          perFam[fam] = ff.length === 0 ? 'no-faces' : (bad > 0 ? bad + 'err/' + ff.length : ff.filter((f) => f.status === 'loaded').length + 'ok/' + ff.length);
        });
        out.f22b_fontStatus = JSON.stringify({ tally, perFam });
      } catch (e) { out.f22b_fontStatus = 'err'; }
      // FIX 25 battery probe — poller-vs-idle-lock. The renderer status-watchdog has been
      // running the whole stage (vault unlocked via UI). Configure the MINIMUM idle lock (1 min),
      // then go quiet: only the watchdog's vault:status polls fire — the EXEMPT channel must not
      // reset lastActivity, so main locks within ~60-70 s and the watchdog flips to UnlockScreen.
      try {
        await dropsync.vault.settingsSet({ autoLockMinutes: 1 }); // t0 (this call touches, as a real action would)
        const t0 = Date.now();
        let lockedSeen = false;
        while (Date.now() - t0 < 95_000) {
          await sleep(5000);
          const st = await dropsync.vault.status(); // exempt channel
          if (st.state !== 'unlocked') { lockedSeen = true; break; }
        }
        out.f22b_idle_autolock_locked = lockedSeen;
        out.f22b_idle_autolock_waitMs = Date.now() - t0;
        // The watchdog polls every 8 s — give it a tick to flip the renderer before checking DOM.
        await sleep(10000);
        out.f22b_idle_autolock_unlockScreen = !!document.querySelector('input[placeholder="Vault password"]');
      } catch (e) { out.f22b_idle_autolock_err = String(e.message || e).slice(0, 60); }
      localStorage.removeItem('dropsync.sit3.dom');
      out.stage = '9';
      return JSON.stringify(out);
    }
    if (stage === '10') {
      // __STAGE10_FIX26__
      // ---- STAGE 10 (Round 108, FIX 26): the EDIT-mode font-restyle legs. The font clicks
      // are the REAL toolbar surface — elementFromPoint-gated full pointer+mouse sequences
      // dispatched on the hit-test element (the harness cannot reach CDP from in-page; the
      // gate keeps hit-testing honest, the sequence keeps our pointerdown + Radix/library
      // listeners in play — round-8's "PointerEvents mandatory" finding). Every leg asserts
      // the SCENE value; f_26_fontSurvivesReopen also asserts the engine-side reopen value
      // (the 8b payload-parse pattern). This whole chain is dev-gated — zero behavior change
      // when the env gates are unset.
      const EX10 = window.__EXCAL;
      if (!EX10) { out.f_26 = 'no excalidraw hook'; return done(out, '10'); }
      out.f_26_env = 'stage10';
      const M10 = () => (window.__DC_METRICS || null);
      const api10 = () => (window.__DRAWING_API || null);
      const alive10 = () => !!document.querySelector('.excalidraw')
        && !!Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Save drawing');
      const gotoSpace10 = async (name) => {
        await openMenu();
        const menuEl = document.querySelector('header .absolute.top-full');
        const row = Array.from(menuEl.querySelectorAll('div')).find((el) => el.className.indexOf('cursor-pointer') >= 0 && (el.textContent || '').trim() === name)
          || Array.from(menuEl.querySelectorAll('button')).find((el) => (el.textContent || '').trim() === name);
        if (!row) return false;
        row.click();
        await sleep(1000);
        return true;
      };
      const cardByName10 = (name) => {
        const h = cardH3s().find((x) => (x.getAttribute('title') || '') === name);
        return h ? h.closest('.cursor-pointer') : null;
      };
      const closeOverlays10 = async () => {
        for (let i = 0; i < 6; i++) {
          if (!document.querySelector('.fixed.inset-0')) return;
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await sleep(450);
          const disc = Array.from(document.querySelectorAll('.fixed.inset-0 button')).find((b) => (b.textContent || '').trim() === 'Discard');
          if (disc) { disc.click(); await sleep(350); }
        }
      };
      const openEditor10 = async () => {
        if (!(await gotoSpace10('Personal'))) return { ok: false, note: 'no-personal' };
        let card = null;
        for (let i = 0; i < 24 && !card; i++) { await sleep(500); card = cardByName10('R108 Fixture'); }
        if (!card) return { ok: false, note: 'no-fixture-card' };
        card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await sleep(800);
        const btn = document.querySelector('.fixed.inset-0 button[title="Edit"]');
        if (!btn) return { ok: false, note: 'no-edit-btn' };
        btn.click();
        let ready = false;
        for (let i = 0; i < 30 && !ready; i++) { await sleep(300); ready = !Array.from(document.querySelectorAll('.fixed.inset-0 *')).some((el) => el.textContent === 'Loading drawing...'); }
        if (!ready) return { ok: false, note: 'extract-not-done' };
        let up = false;
        for (let i = 0; i < 30 && !up; i++) { await sleep(300); up = !!document.querySelector('.excalidraw'); }
        if (!up) return { ok: false, note: 'editor-not-mounted' };
        await sleep(900);
        let txt = null;
        for (let i = 0; i < 24 && !txt; i++) {
          await sleep(500);
          const api = window.__DRAWING_API;
          const els = api ? (api.getSceneElementsIncludingDeleted() || []) : [];
          for (let k = els.length - 1; k >= 0; k--) { if (els[k].type === 'text' && !els[k].isDeleted) { txt = els[k].id; break; } }
        }
        if (!txt) return { ok: false, note: 'scene-text-missing' };
        return { ok: true, note: '' };
      };
      const canvasEl10 = () => (document.querySelector('.excalidraw .excalidraw__canvas.interactive') || document.querySelector('.excalidraw canvas'));
      // Full trusted-shape sequence on the hit-test element, AFTER an elementFromPoint gate.
      // Async with inter-event yields: a real browser delivers these events as SEPARATE
      // tasks, so React can flush a teardown (the OLD blur bug) between pointerdown and
      // click — a synchronous loop would hide exactly the mechanism the RED pairs target.
      const dispatchReal10 = async (x, y, dbl) => {
        const at = document.elementFromPoint(x, y);
        if (!at) return { ok: false, gate: 'NONE' };
        const gate = at.tagName + '|tid=' + ((at.getAttribute && at.getAttribute('data-testid')) || '') + '|cls=' + String(at.className && at.className.baseVal !== undefined ? at.className.baseVal : at.className).slice(0, 40);
        const seq = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
        for (const t of seq) {
          const opts = { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0 };
          if (t.indexOf('pointer') === 0) { opts.pointerId = 1; opts.isPrimary = true; opts.buttons = (t === 'pointerdown') ? 1 : 0; }
          at.dispatchEvent(t.indexOf('pointer') === 0 ? new PointerEvent(t, opts) : new MouseEvent(t, opts));
          await sleep(40);
        }
        if (dbl) {
          at.dispatchEvent(new MouseEvent('dblclick', { clientX: x, clientY: y, bubbles: true, cancelable: true }));
          await sleep(40);
        }
        return { ok: true, gate };
      };
      const canvasTap10 = async (x, y, dbl) => {
        const cv = canvasEl10();
        if (!cv) return { ok: false, gate: 'no-canvas' };
        const at = document.elementFromPoint(x, y);
        if (!at || !(at === cv || cv.contains(at))) return { ok: false, gate: at ? at.tagName : 'NONE' };
        return await dispatchReal10(x, y, dbl);
      };
      const buttonClick10 = async (el, label) => {
        if (!el) return { ok: false, gate: 'no-' + label };
        const r = el.getBoundingClientRect();
        return await dispatchReal10(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2), false);
      };
      // Dropdown ITEM gesture: synchronous sequence ON the captured item element. With our
      // pointerdown preventDefault active, Radix's teardown detaches the popup item
      // +20…75 ms INTO the press (investigation 26-3: E3/E4/E5; causal replica C3pd/C5pd),
      // so with inter-event yields a synthetic click dispatches on a detached node and
      // never bubbles. Trusted real-timing input does NOT survive this teardown (26-3:
      // detach +20…75 ms into the press; pass ≤62 ms, fail ≥127 ms; causal replica
      // C3pd/C5pd) — the sync gesture here is a battery-only convenience. Real-timing
      // proof lives in the external trusted probes (%TEMP%\f26p3\ driver), not in this
      // harness. The sync gesture keeps the item attached through the click; the resetAll
      // race that follows is exactly what the watcher complement exists for.
      const itemClick10 = (el, label) => {
        if (!el) return { ok: false, gate: 'no-' + label };
        const r = el.getBoundingClientRect();
        const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
        const at = document.elementFromPoint(x, y);
        if (!at) return { ok: false, gate: 'NONE' };
        const gate = at.tagName + '|tid=' + ((at.getAttribute && at.getAttribute('data-testid')) || '') + '|cls=' + String(at.className && at.className.baseVal !== undefined ? at.className.baseVal : at.className).slice(0, 40);
        const seq = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
        for (const t of seq) {
          const opts = { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0 };
          if (t.indexOf('pointer') === 0) { opts.pointerId = 1; opts.isPrimary = true; opts.buttons = (t === 'pointerdown') ? 1 : 0; }
          el.dispatchEvent(t.indexOf('pointer') === 0 ? new PointerEvent(t, opts) : new MouseEvent(t, opts));
        }
        return { ok: true, gate };
      };
      const lastTextId10 = () => {
        const api = api10();
        if (!api) return null;
        const els = api.getSceneElementsIncludingDeleted() || [];
        let t = null;
        for (let k = els.length - 1; k >= 0; k--) { if (els[k].type === 'text' && !els[k].isDeleted) { t = els[k]; break; } }
        return t ? t.id : null;
      };
      const sceneEl10 = (id) => {
        const api = api10();
        return id ? (api.getSceneElementsIncludingDeleted() || []).find((e) => e.id === id && !e.isDeleted) || null : null;
      };
      const elemCenter10 = (id) => {
        const api = api10();
        const e = sceneEl10(id);
        if (!e) return null;
        const v = EX10.sceneCoordsToViewportCoords({ sceneX: e.x + e.width / 2, sceneY: e.y + e.height / 2 }, api.getAppState());
        return { x: Math.round(v.x), y: Math.round(v.y) };
      };
      const emptyPoint10 = () => {
        const cv = canvasEl10();
        if (!cv) return null;
        const r = cv.getBoundingClientRect();
        return { x: Math.round(r.left + r.width * 0.82), y: Math.round(r.top + r.height * 0.75) };
      };
      // Desktop layout: the docked modal editor is under Excalidraw's mobile MQ breakpoint,
      // where the properties panel hides behind the bottom-bar toggle. Go fullscreen first
      // (our own header toggle), then fall back to the toggle if controls are still missing.
      // exit=true clicks the 'Exit fullscreen' title (the toggle flips its title, DrawingCanvas).
      const goFullscreen10 = async (exit) => {
        const fs = document.querySelector(exit ? 'button[title="Exit fullscreen"]' : 'button[title="Fullscreen"]');
        if (!fs) return exit ? 'no-exit-toggle' : 'no-toggle';
        const r = fs.getBoundingClientRect();
        await dispatchReal10(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2), false);
        await sleep(900);
        return exit ? 'docked' : 'fullscreen';
      };
      const fontControlsUp10 = () => !!document.querySelector('[data-testid="font-family-code"], [data-testid="font-family-hand-drawn"]');
      const ensureFontControls10 = async () => {
        if (fontControlsUp10()) return 'already';
        const cands = Array.from(document.querySelectorAll('.excalidraw button'));
        const toggle = cands.find((b) => {
          const al = (b.getAttribute('aria-label') || '') + '|' + (b.getAttribute('title') || '') + '|' + (b.textContent || '');
          return al.indexOf('Edit') >= 0;
        });
        if (!toggle) return 'no-toggle';
        toggle.click();
        await sleep(600);
        return fontControlsUp10() ? 'shape-menu' : 'failed';
      };
      // Pan the viewport so the text element sits at the CANVAS CENTER — the shape panel
      // then never covers its screen point (panel-over-element flake class, bootGF3).
      const panToCenter10 = async () => {
        const api = api10();
        const tid = lastTextId10();
        if (!api || !tid) return 'no-text';
        for (let i = 0; i < 4; i++) {
          const e = (api.getSceneElementsIncludingDeleted() || []).find((x) => x.id === tid);
          const st = api.getAppState();
          const c = canvasEl10();
          if (!c || !e) return 'no-canvas';
          const r = c.getBoundingClientRect();
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          const cur = EX10.sceneCoordsToViewportCoords({ sceneX: e.x + e.width / 2, sceneY: e.y + e.height / 2 }, st);
          const dx = (cx - cur.x) / st.zoom.value, dy = (cy - cur.y) / st.zoom.value;
          if (Math.abs(dx) <= 10 && Math.abs(dy) <= 10) return 'centered';
          api.updateScene({ appState: { scrollX: st.scrollX + dx, scrollY: st.scrollY + dy } });
          await sleep(350);
        }
        return 'centered';
      };
      const selectText10 = async () => {
        const api = api10();
        const tid = lastTextId10();
        if (!api || !tid) return { ok: false, how: 'no-text' };
        const gates = [];
        for (let attempt = 0; attempt < 3; attempt++) {
          const p = elemCenter10(tid);
          if (p) {
            const tap = await canvasTap10(p.x, p.y, false);
            gates.push(tap.gate);
            await sleep(600);
          }
          if ((api.getAppState().selectedElementIds || {})[tid]) return { ok: true, how: 'pointer', gates: gates.join('|') };
          try { api.updateScene({ appState: { selectedElementIds: { [tid]: true }, selectedGroupIds: {}, editingGroupId: null } }); } catch (e) { /* setup shortcut */ }
          await sleep(500);
          if ((api.getAppState().selectedElementIds || {})[tid]) return { ok: true, how: 'api-fallback', gates: gates.join('|') };
        }
        return { ok: false, how: 'exhausted', gates: gates.join('|') };
      };
      // Enter the wysiwyg on the text element: select → Enter key (deterministic); dblclick
      // fallback. NEVER dblclick empty canvas here — that would CREATE a second text element.
      const enterWysiwyg10 = async () => {
        const api = api10();
        const tid = lastTextId10();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
        await sleep(600);
        let editing = !!(api.getAppState().editingTextElement) && !!document.querySelector('.excalidraw textarea');
        let how = editing ? 'enter' : '';
        let dblGate = '';
        if (!editing) {
          const p = elemCenter10(tid);
          if (p) { const d1 = await canvasTap10(p.x, p.y, false); await sleep(250); const d2 = await canvasTap10(p.x, p.y, true); dblGate = d2.gate; }
          await sleep(700);
          editing = !!(api.getAppState().editingTextElement) && !!document.querySelector('.excalidraw textarea');
          how = editing ? 'dblclick' : '';
        }
        const diag = { textCount: (api.getSceneElementsIncludingDeleted() || []).filter((e) => e.type === 'text' && !e.isDeleted).length, sel: Object.keys(api.getAppState().selectedElementIds || {}).length };
        return { ok: editing, how, dblGate, diag };
      };
      const commitWysiwyg10 = async () => {
        const cv = canvasEl10();
        if (!cv) return false;
        const r = cv.getBoundingClientRect();
        const tries = [[0.82, 0.75], [0.5, 0.85], [0.15, 0.6], [0.5, 0.9]];
        for (const [fx, fy] of tries) {
          const x = Math.round(r.left + r.width * fx), y = Math.round(r.top + r.height * fy);
          await canvasTap10(x, y, false);
          await sleep(550);
          if (!document.querySelector('.excalidraw textarea') && !(api10().getAppState().editingTextElement)) {
            await canvasTap10(x, y, false);
            await sleep(350);
            return true;
          }
        }
        return !document.querySelector('.excalidraw textarea') && !(api10().getAppState().editingTextElement);
      };
      // ===== engine-side fixture (rerun-safe): one text + one rectangle, PNG-embedded scene
      let fixOk10 = false;
      try {
        const dtos0 = await dropsync.drop.list('personal');
        for (const d of dtos0) { if (d.name === 'R108 Fixture') { try { await dropsync.drop.delete(d.id); } catch (e) { /* best-effort */ } } }
        const seedEls10 = EX10.convertToExcalidrawElements([{ type: 'text', x: 60, y: 60, text: 'hist abc' }])
          .concat(EX10.convertToExcalidrawElements([{ type: 'rectangle', x: 300, y: 60, width: 100, height: 60 }]));
        const blob10 = await EX10.exportToBlob({ elements: seedEls10, appState: { viewBackgroundColor: '#ffffff', exportBackground: true, exportEmbedScene: true }, files: {}, exportPadding: 10 });
        await dropsync.drop.createText({ spaceId: 'personal', name: 'R108 Fixture', content: '', expirationOption: 'forever', categories: [], locked: false, reminderAt: null, pngBytes: new Uint8Array(await blob10.arrayBuffer()) });
        fixOk10 = !!(await dropsync.drop.list('personal')).find((d) => d.name === 'R108 Fixture' && d.isDrawing);
      } catch (e) { out.f_26_seedErr = String(e.message || e).slice(0, 80); }
      out.f_26_fixtureSeeded = fixOk10;
      // ===== LEG 1 + 2: f_26_fontSticksEditOpen / f_26_fontSurvivesReopen =====
      try {
        const op1 = fixOk10 ? await openEditor10() : { ok: false, note: 'seed-failed' };
        out.f_26_editorOpened = op1.ok;
        if (!op1.ok) { out.f_26_editorOpenNote = op1.note; throw new Error('skip: ' + op1.note); }
        out.f_26_fullscreen1 = await goFullscreen10();
        out.f_26_pan1 = await panToCenter10();
        const sel1 = await selectText10();
        out.f_26_selectHow = sel1.how;
        const ed1 = sel1.ok ? await enterWysiwyg10() : { ok: false };
        out.f_26_wysiwygHow = ed1.how;
        out.f_26_controlsHow1 = await ensureFontControls10();
        const tid1 = lastTextId10();
        const before1 = sceneEl10(tid1) ? { f: sceneEl10(tid1).fontFamily, v: sceneEl10(tid1).version } : null;
        const mPre1 = M10() ? M10().mounts : -1;
        let landed1 = '';
        const spy1 = (ev) => {
          const t = ev.target;
          if (t && t.closest && t.closest('[data-testid="font-family-code"]')) landed1 = 'font-family-code';
        };
        window.addEventListener('click', spy1, true);
        const clk1 = await buttonClick10(document.querySelector('[data-testid="font-family-code"]'), 'quick-code');
        await sleep(700);
        window.removeEventListener('click', spy1, true);
        const mPost1 = M10() ? M10().mounts : -1;
        const afterEl1 = sceneEl10(tid1);
        const after1 = afterEl1 ? { f: afterEl1.fontFamily, v: afterEl1.version } : null;
        out.f_26_clickLandedOn = landed1 || ('gate:' + clk1.gate);
        out.f_26_mounts = mPre1 + '→' + mPost1;
        out.f_26_editCell = JSON.stringify({ before: before1, after: after1, taOpen: !!document.querySelector('.excalidraw textarea'), gateOk: clk1.ok, selectGates: sel1.gates || '', wysiwygDiag: ed1.diag || null, dblGate: ed1.dblGate || '' });
        out.f_26_fontSticksEditOpen = !!(ed1.ok && clk1.ok && landed1 === 'font-family-code' && mPre1 === mPost1 && alive10()
          && before1 && after1 && after1.f === 8 && after1.v > before1.v);
        out.f_26_panelStayedOpen = alive10() && !!document.querySelector('[data-testid="font-family-code"]');
        // ===== LEG 2: real Save drawing → Save changes → close → engine-side reopen parse
        const committed2 = await commitWysiwyg10();
        out.f_26_fullscreenExit2 = await goFullscreen10(true); // back to the docked modal for its footer
        const saveBtn2 = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Save drawing');
        const saved2 = saveBtn2 ? await buttonClick10(saveBtn2, 'save-drawing') : { ok: false, gate: 'no-save-drawing' };
        let attached2 = false;
        for (let i = 0; i < 35 && !attached2; i++) { await sleep(100); attached2 = !!Array.from(document.querySelectorAll('span')).find((s) => (s.textContent || '') === 'Drawing attached'); }
        const submit2 = Array.from(document.querySelectorAll('.fixed.inset-0 button')).find((b) => (b.textContent || '').trim() === 'Save changes');
        if (submit2) { await buttonClick10(submit2, 'save-changes'); await sleep(1800); }
        await closeOverlays10();
        await sleep(600);
        let reopen2 = false;
        try {
          const sp2 = (await dropsync.vault.listSpaces()).find((s) => s.name === 'Personal');
          const dto2 = sp2 ? (await dropsync.drop.list(sp2.id)).find((d) => d.name === 'R108 Fixture') : null;
          const b2 = dto2 && dto2.hasFilePayload ? await dropsync.media.getBytes(dto2.id, 'file') : null;
          if (b2) {
            const sc2 = await EX10.loadFromBlob(new Blob([b2], { type: 'image/png' }), null, null);
            const t2 = sc2.elements.find((e) => e.type === 'text' && !e.isDeleted);
            reopen2 = !!t2 && String(t2.text || '').indexOf('hist abc') >= 0 && t2.fontFamily === 8;
          }
        } catch (e) { out.f_26_reopenErr = String(e.message || e).slice(0, 60); }
        out.f_26_reopenShowsFam8 = reopen2;
        out.f_26_fontSurvivesReopen = !!(committed2 && saved2.ok && attached2 && submit2 && reopen2);
      } catch (e) { out.f_26_leg12Err = String(e.message || e).slice(0, 80); }
      // ===== LEG 3: f_26_dropdownApplySurvives (fresh editor session, chosen value 1) =====
      try {
        const op3 = await openEditor10();
        if (!op3.ok) { out.f_26_dropdownApplySurvives = false; out.f_26_dropdownNote = 'open:' + op3.note; }
        else {
          await goFullscreen10();
          await panToCenter10();
          const sel3 = await selectText10();
          const api3 = api10();
          const tid3 = lastTextId10();
          if (!sel3.ok || !tid3) { out.f_26_dropdownApplySurvives = false; out.f_26_dropdownNote = 'select:' + sel3.how; }
          else {
            await ensureFontControls10();
            const trig3 = document.querySelector('[data-testid="font-family-show-fonts"]');
            const clkTrig3 = await buttonClick10(trig3, 'show-fonts');
            await sleep(500);
            const popupUp3 = !!document.querySelector('.FontPicker__dropdown') || api3.getAppState().openPopup === 'fontFamily';
            out.f_26_dropdownPopupOpened = popupUp3;
            // "a different family": this build's FontPicker dropdown ships exactly the four
            // bundled families (census-proven: values 8,7,5,6) — pick 7 (Lilita One), which
            // differs from the scene's current 8. (Value 1 does not exist as an item.)
            let item3 = null;
            let itemCensus3 = '';
            for (let i = 0; i < 12 && !item3; i++) {
              await sleep(250);
              item3 = document.querySelector('.dropdown-menu-item[value="7"]');
              if (!item3 && i === 5) {
                itemCensus3 = JSON.stringify(Array.from(document.querySelectorAll('.dropdown-menu-item')).map((x) => x.getAttribute('value')).slice(0, 12));
              }
            }
            const clkItem3 = itemClick10(item3, 'item-7');
            await sleep(400);
            const pEmpty3 = emptyPoint10();
            if (pEmpty3) await canvasTap10(pEmpty3.x, pEmpty3.y, false); // close any still-open popup
            await sleep(1700); // outlive the 1500 ms complement window — final settled value
            const fin3 = sceneEl10(tid3);
            out.f_26_dropdownCell = JSON.stringify({ trig: clkTrig3.ok, item: clkItem3.ok, gateItem: clkItem3.gate, popup: popupUp3, finalFam: fin3 ? fin3.fontFamily : null, census: itemCensus3 });
            out.f_26_dropdownApplySurvives = !!(clkTrig3.ok && clkItem3.ok && popupUp3 && fin3 && fin3.fontFamily === 7);
          }
          await closeOverlays10();
        }
      } catch (e) { out.f_26_leg3Err = String(e.message || e).slice(0, 80); }
      // ===== LEG 4 + 5: f_26_handDrawnIsExcalifont / f_26_noShapePollution =====
      try {
        const op4 = await openEditor10();
        if (!op4.ok) { out.f_26_handDrawnIsExcalifont = false; out.f_26_noShapePollution = false; out.f_26_leg45Note = 'open:' + op4.note; }
        else {
          await goFullscreen10();
          await panToCenter10();
          const api4 = api10();
          const sel4 = await selectText10();
          await ensureFontControls10();
          const tid4 = lastTextId10();
          const mPre4 = M10() ? M10().mounts : -1;
          const clk4 = sel4.ok ? await buttonClick10(document.querySelector('[data-testid="font-family-hand-drawn"]'), 'quick-hand-drawn') : { ok: false, gate: 'no-select' };
          await sleep(700);
          const el4 = sceneEl10(tid4);
          const mPost4 = M10() ? M10().mounts : -1;
          out.f_26_handDrawnIsExcalifont = !!(clk4.ok && el4 && el4.fontFamily === 5 && mPre4 === mPost4 && alive10());
          // both selected (api setup shortcut — the CRASH surface, the toolbar click, stays real)
          const rect4 = (api4.getSceneElementsIncludingDeleted() || []).find((e) => e.type === 'rectangle' && !e.isDeleted);
          if (rect4 && tid4) {
            const rectFamBefore4 = rect4.fontFamily === undefined ? 'unset' : rect4.fontFamily;
            api4.updateScene({ appState: { selectedElementIds: { [tid4]: true, [rect4.id]: true }, selectedGroupIds: {}, editingGroupId: null } });
            await sleep(500);
            const clk5 = await buttonClick10(document.querySelector('[data-testid="font-family-code"]'), 'quick-code-mixed');
            await sleep(700);
            const elTxt5 = sceneEl10(tid4);
            const rect5 = (api4.getSceneElementsIncludingDeleted() || []).find((e) => e.id === rect4.id);
            const rectFamAfter5 = rect5.fontFamily === undefined ? 'unset' : rect5.fontFamily;
            out.f_26_rectFam = rectFamBefore4 + '→' + rectFamAfter5;
            out.f_26_noShapePollution = !!(clk5.ok && elTxt5 && elTxt5.fontFamily === 8 && rectFamAfter5 === rectFamBefore4);
          } else {
            out.f_26_noShapePollution = false;
            out.f_26_leg45Note = 'no-rect';
          }
          await closeOverlays10();
        }
      } catch (e) { out.f_26_leg45Err = String(e.message || e).slice(0, 80); }
      // ===== LEG 6: f_26_createStockUnchanged (CREATE mode — stock pipeline, no intercept) =====
      try {
        const addBtn6 = Array.from(document.querySelectorAll('main button')).find((b) => (b.textContent || '').trim() === 'Add Text');
        if (!addBtn6) throw new Error('no-add-text');
        addBtn6.click();
        await sleep(700);
        const drawTab6 = Array.from(document.querySelectorAll('.fixed.inset-0 button')).find((b) => (b.textContent || '').trim() === 'Draw');
        if (!drawTab6) throw new Error('no-draw-tab');
        drawTab6.click();
        let up6 = false;
        for (let i = 0; i < 30 && !up6; i++) { await sleep(300); up6 = alive10(); }
        if (!up6) throw new Error('create-canvas-not-up');
        await sleep(700);
        out.f_26_fullscreen6 = await goFullscreen10();
        await ensureFontControls10();
        // create a text via Excalidraw's own path: dblclick empty canvas + type
        const cv6 = canvasEl10();
        const r6 = cv6.getBoundingClientRect();
        const cx6 = Math.round(r6.left + Math.min(170, r6.width * 0.45)), cy6 = Math.round(r6.top + 120);
        const gate6 = await canvasTap10(cx6, cy6, true);
        let ta6 = null;
        for (let i = 0; i < 16 && !ta6; i++) { await sleep(250); ta6 = document.querySelector('.excalidraw textarea'); }
        if (!ta6) throw new Error('create-no-textarea: ' + gate6.gate);
        try {
          const setV = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          setV.call(ta6, 'hi');
          ta6.dispatchEvent(new Event('input', { bubbles: true }));
        } catch (e) { throw new Error('create-type-failed'); }
        await sleep(300);
        const mPre6 = M10() ? M10().mounts : -1;
        const clk6 = await buttonClick10(document.querySelector('[data-testid="font-family-hand-drawn"]'), 'create-quick-hand-drawn');
        await sleep(800);
        const mPost6 = M10() ? M10().mounts : -1;
        const t6 = (api10().getSceneElementsIncludingDeleted() || []).filter((e) => e.type === 'text' && !e.isDeleted).pop();
        out.f_26_createCell = JSON.stringify({ gate: gate6.gate, clk: clk6.ok, gateClk: clk6.gate, fam: t6 ? t6.fontFamily : null, mounts: mPre6 + '→' + mPost6 });
        out.f_26_createStockUnchanged = !!(clk6.ok && mPre6 === mPost6 && alive10() && t6 && t6.fontFamily === 5);
        await closeOverlays10();
      } catch (e) { out.f_26_leg6Err = String(e.message || e).slice(0, 80); out.f_26_createStockUnchanged = false; }
      // ===== 108b layer-2 legs: the vendored font files must LOAD on any origin =====
      // f_26b_assetPathAbsolute (dev regression gate — passes before AND after; must NEVER
      // regress to a relative/root value) + f_26b_fontFacesLoad (≥1 of the 8 families has a
      // 'loaded' face, zero 'error' — the f22b_fontStatus tally shape, reused).
      try {
        const ap26b = String(window.EXCALIDRAW_ASSET_PATH || '');
        const expected26b = new URL('./', document.baseURI).href;
        out.f_26b_assetPathValue = ap26b;
        out.f_26b_assetPathAbsolute = /^(https?:|file:)/.test(ap26b)
          && ap26b.charAt(ap26b.length - 1) === '/'
          && ap26b === expected26b;
      } catch (e) { out.f_26b_assetPathAbsolute = false; out.f_26b_assetPathErr = String(e.message || e).slice(0, 60); }
      try {
        const fams26b = ['Excalifont', 'Nunito', 'Virgil', 'Cascadia', 'Comic Shanns', 'Lilita One', 'Helvetica', 'Liberation Sans'];
        const faces26b = Array.from(document.fonts);
        let loaded26b = 0; let err26b = 0; let totalErr26b = 0;
        const perFam26b = {};
        for (const fam of fams26b) {
          const ff = faces26b.filter((f) => f.family === fam || f.family === '"' + fam + '"');
          const bad = ff.filter((f) => f.status === 'error').length;
          const ok = ff.filter((f) => f.status === 'loaded').length;
          loaded26b += ok; err26b += bad;
          perFam26b[fam] = ff.length === 0 ? 'no-faces' : ok + 'ok/' + ff.length;
        }
        for (const f of faces26b) { if (f.status === 'error') totalErr26b++; }
        out.f_26b_fontCensus = JSON.stringify({ famLoaded: loaded26b, famErr: err26b, allFaces: faces26b.length, allErr: totalErr26b, perFam: perFam26b });
        out.f_26b_fontFacesLoad = loaded26b >= 1 && err26b === 0;
      } catch (e) { out.f_26b_fontFacesLoad = false; out.f_26b_fontErr = String(e.message || e).slice(0, 60); }
      out.f_26_allGreen = out.f_26_fixtureSeeded === true && out.f_26_fontSticksEditOpen === true
        && out.f_26_fontSurvivesReopen === true && out.f_26_dropdownApplySurvives === true
        && out.f_26_handDrawnIsExcalifont === true && out.f_26_noShapePollution === true
        && out.f_26_createStockUnchanged === true;
      localStorage.removeItem('dropsync.sit3.dom');
      out.stage = '10';
      return JSON.stringify(out);
    }
    return JSON.stringify({ stage: 'unknown' });
  } catch (e) {
    out.error = e && e.message ? e.message : String(e);
    try { localStorage.removeItem('dropsync.sit3.dom'); } catch (_) {}
    return JSON.stringify(out);
  }

  function done(o, stage) {
    o.stage = stage;
    return JSON.stringify(o);
  }
})()
`, true)
            .then(async (report) => {
              console.log('[sit3-dom]', report);
              // Stage-7 disk proof: a workspace deleted MID-EXPORT leaves ZERO output bytes.
              try {
                const parsed7 = JSON.parse(report) as { stage?: string };
                if (parsed7.stage === '7') {
                  const fs7 = await import('node:fs/promises');
                  const dir7 = await fs7.readdir('/tmp/opencode/e2e').catch(() => [] as string[]);
                  console.log('[sit3-dom-disk]', JSON.stringify({
                    doomArchiveAbsent: !dir7.includes('stage7-doom.dropsync'),
                    noPartFiles: !dir7.some((f) => f.endsWith('.part')),
                    roundtripPresent: dir7.includes('web-draw-roundtrip.dropsync'),
                    refusedAbsent: !dir7.includes('stage7-refused.dropsync'),
                  }));
                }
              } catch (err) {
                console.error('[sit3-dom-disk] failed:', err instanceof Error ? err.message : String(err));
              }
            })
            .catch((error) => console.error('[sit3-dom] failed:', error instanceof Error ? error.message : String(error)));
        }, 4000);
      }
      // DROPSYNC_E2E_S4=1 → native-dialog diagnostic: open the real folder picker without any
      // human input. If WSLg/GTK takes Electron down, this reproduces the crash deterministically.
      if (process.env.DROPSYNC_E2E_S4 === '1') {
        setTimeout(() => {
          void mainWindow?.webContents
            .executeJavaScript('dropsync.dialog.pickFolder({ title: "S4 dialog diagnostic" }).then((r) => JSON.stringify({ picked: r }))', true)
            .then((report) => console.log('[s4]', report))
            .catch((error) => console.error('[s4] failed:', error instanceof Error ? error.message : String(error)));
        }, 4000);
      }
      // DROPSYNC_CLOUD_DEV=1 → C1/C1b/C2f cloud battery. C2f: launch goes STRAIGHT into the last
      // used mode (no porch), so the battery (1) captures the boot state + pill layer evidence,
      // (2) proves full-window bounds + corner-glued pill across resize/fullscreen, (3) drives
      // the pill flip relay through the guarded switch path, then (4) re-runs the kept [c1]/
      // [c1b] evidence. The porch-era [c2]/[c2b]/[c2c] assertions (memory-remember via porch
      // remount, dressed-login dance, pill-float DOM probe) are OBSOLETE — removed with this
      // rewrite (C2f FIX 5: never silently keep a green that tests nothing).
      if (process.env.DROPSYNC_CLOUD_DEV === '1' && !cloudDevBatteryStarted) {
        cloudDevBatteryStarted = true;
        setTimeout(() => {
          void (async () => {
            try {
              const win = mainWindow;
              if (!win || !cloudCtl) throw new Error('window/controller gone');
              const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
              // Page-side readers shared by every leg below (defined FIRST — no TDZ traps).
              const readState = (): Promise<{ open: boolean; saveDisabled: boolean | null; typedChars: number; discardConfirmVisible: boolean }> =>
                win.webContents.executeJavaScript('JSON.stringify(window.__c2fEditTest ? window.__c2fEditTest.state() : null)').then((s) => {
                  const parsed = JSON.parse(s as string) as { open: boolean; saveDisabled: boolean | null; typedChars: number; discardConfirmVisible: boolean } | null;
                  if (!parsed) throw new Error('guard fixture: __c2fEditTest not registered (AppBody not mounted?)');
                  return parsed;
                });
              const readMode = (): Promise<string> =>
                win.webContents.executeJavaScript('window.dropsync.mode.get()').then((m) => String(m));
              const readModeSafe = (): Promise<string> =>
                win.webContents.executeJavaScript('window.dropsync ? window.dropsync.mode.get() : "no-bridge"').then((m) => String(m));
              const seqLen = (): Promise<number> =>
                win.webContents.executeJavaScript('window.__DC_METRICS ? window.__DC_METRICS.seq.length : 0').then((n) => Number(n));
              const seqHasConfirmOpenSince = (mark: number): Promise<boolean> =>
                win.webContents.executeJavaScript(
                  `(window.__DC_METRICS ? window.__DC_METRICS.seq.slice(${mark}).some((e) => e.ev === 'mode-guard-confirm-open') : false)`
                ).then((v) => v === true);
              // C2h FIX 4 — "REAL list rendered" counter: counts drop CARDS by their stable
              // rendered root signature in EditorialDropItem.tsx:246-248
              // (`relative select-none … cursor-pointer group overflow-hidden` on every card,
              // no data-testid exists). The locked early-return screen renders ZERO such cards,
              // so >0 is genuine unlocked-UI evidence.
              const countDropCards = (): Promise<number> =>
                win.webContents.executeJavaScript(
                  `document.querySelectorAll('div.select-none.cursor-pointer.group.overflow-hidden').length`
                ).then((n) => Number(n));
              // (1) Boot evidence: straight-into-last-mode + the pill layer present/transparent.
              await sleep(2500); // pill layer load + boot-into-last-mode settle
              const bootPill = await cloudCtl.pillProbe();
              console.log('[c2f-boot]', JSON.stringify({
                mode: appMode,
                f_c2f_pillPersistent_boot: bootPill.loaded && bootPill.visible
                  && bootPill.bounds.x === bootPill.expected.x && bootPill.bounds.y === bootPill.expected.y,
                pillRaw: bootPill,
              }));

              // ==== 1.0.5 — DOWNLOADS LIVE AGAIN + THE YOUTUBE REFERER STAMP ================
              // (repair-order-105-downloads-and-youtube.md §8) Both new legs live HERE —
              // before the heavy stages — on their own evidence (no vault/site/pill state).

              // f_105_refererStampAttached — FIX B leg 1: the literal `[referer-stamp]
              // attached` boot line, captured by the module-scope DEV stdout tap (f105BootLines)
              // installed before whenReady runs. RED (comment the boot call): nothing logs the
              // line ⇒ the array stays empty ⇒ false.
              {
                const f_105_refererStampAttached = f105BootLines.some((l) => l.includes('[referer-stamp] attached'));
                console.log('[f105-stamp-attached]', JSON.stringify({
                  f_105_refererStampAttached,
                  raw: { captured: f105BootLines.length },
                }));
              }

              // f_105_refererStampApplied — FIX B leg 2: the SAME factored stamp function, on a
              // THROWAWAY in-memory session (no persist: prefix ⇒ never the default, never the
              // persist:cloud PARTITION), a filter covering the dev server origin, one fetch
              // through that session, and a read-only onSendHeaders listener proving the
              // outgoing headers carry YT_EMBED_REFERER.
              // RED (skip the registration): the outgoing headers carry no Referer ⇒ false.
              // ORDER FIELD CORRECTION (flagged in the report; the wc.mainFrameUrl precedent):
              // the order said `net.fetch` with `{ session }` — Electron 43.4.1 IGNORES that
              // option at runtime (standalone probe, 2026-09-01: the request rode the DEFAULT
              // session — the default-session onSendHeaders fired, the throwaway's never did;
              // d.ts 10227/13088 types net.fetch's init without session and its comment says
              // "to make a request from another session, use ses.fetch()"). The leg therefore
              // fetches via the session's own `throwaway.fetch()` — the documented equivalent,
              // probe-proven to ride the throwaway session (its onBeforeSendHeaders stamped and
              // its onSendHeaders fired). Tear-down: both webRequest handlers nulled after.
              {
                const devBase = process.env.ELECTRON_RENDERER_URL ?? '';
                const appliedRaw: { saw: boolean; referer: string | null; url: string | null } = { saw: false, referer: null, url: null };
                if (devBase) {
                  const throwaway = session.fromPartition('f105-throwaway');
                  throwaway.webRequest.onSendHeaders({ urls: [devBase + '/*'] }, (details) => {
                    appliedRaw.saw = true;
                    appliedRaw.referer = details.requestHeaders['Referer'] ?? null;
                    appliedRaw.url = details.url;
                  });
                  attachYouTubeRefererStamp(throwaway, [devBase + '/*'], 'f105-throwaway');
                  try {
                    await throwaway.fetch(devBase + '/');
                  } catch { /* the evidence is onSendHeaders, not the response */ }
                  throwaway.webRequest.onBeforeSendHeaders(null);
                  throwaway.webRequest.onSendHeaders(null);
                }
                const f_105_refererStampApplied = !!devBase && appliedRaw.saw
                  && appliedRaw.referer === YT_EMBED_REFERER;
                console.log('[f105-stamp-applied]', JSON.stringify({
                  f_105_refererStampApplied,
                  matrix: { devServer: !!devBase, saw: appliedRaw.saw, refererMatch: appliedRaw.referer === YT_EMBED_REFERER },
                  raw: appliedRaw,
                }));
              }
              // (1b) f_c2f_flipGuardFull — THE robot test for the unsaved-work guard
              // (C2f-hotfix-1). The old relay leg could only prove the CLEAN path; this one
              // drives a REAL dirty editor through the REAL relay path:
              //   pill:flip ipc ≡ win.webContents.send('pill:flipRequested', next)
              // Editors exist only inside an unlocked vault, so: ensure vault → unlock → seed a
              // text drop through the REAL bridge → reload (renderer mounts Local/unlocked with
              // the seeded drop) → open the edit modal via the __c2fEditTest dev fixture → type
              // THROUGH THE DOM (execCommand insertText → native input event → mention editor
              // onChange). React state is never poked for any action under test.
              // Return to Local through the REAL path (renderer screen must follow — the reload
              // below boots into dropsync.mode.last, and ONLY a renderer-driven switch writes it).
              if (appMode !== 'local') {
                win.webContents.send('pill:flipRequested', 'local');
                await sleep(1800);
              }
              if ((await readModeSafe()) !== 'local') { // desync insurance: force both sides local
                await applyCloudMode('local');
                win.webContents.send('pill:flipRequested', 'local');
                await sleep(1200);
              }
              const META_TEXT = 'META-SAVE-FULL-TEXT-LINE-1\nMETA-SAVE-FULL-TEXT-LINE-2'; // hotfix-2 fixture body
              const seedId = await win.webContents.executeJavaScript(
                `(async () => {
                   try {
                     const d = window.dropsync;
                     await d.vault.prepareFolder('/tmp/ds-c2f-vault').catch(() => {});
                     try { await d.vault.create('/tmp/ds-c2f-vault', 'c2f-vault-pw'); } catch {}
                     await d.vault.unlock('/tmp/ds-c2f-vault', 'c2f-vault-pw');
                     // Two fixtures, ONE reload: GuardFixture (hotfix-1 guard matrix) +
                     // MetaSaveFixture (hotfix-2 meta-save preview key) with KNOWN body text.
                     const g = await d.drop.createText({ spaceId: 'personal', name: 'GuardFixture', content: 'original text', categories: [], expirationOption: '24h', locked: false, reminderAt: null });
                     const m = await d.drop.createText({ spaceId: 'personal', name: 'MetaSaveFixture', content: ${JSON.stringify(META_TEXT)}, categories: [], expirationOption: '24h', locked: false, reminderAt: null });
                     return JSON.stringify({ g: String(g.id), m: String(m.id) });
                   } catch (e) { return 'FATAL:' + String(e); }
                 })()`
              ) as string;
              if (seedId.startsWith('FATAL')) throw new Error('guard fixture seeding failed: ' + seedId);
              const seeds = JSON.parse(seedId) as { g: string; m: string };
              win.webContents.reload();
              await sleep(4500); // renderer remount: boot-into-last-mode (local) + store fetch
              let opened = false;
              for (let i = 0; i < 10 && !opened; i++) {
                opened = await win.webContents.executeJavaScript(
                  `window.__c2fEditTest ? window.__c2fEditTest.open(${JSON.stringify(seeds.g)}) : false`
                ) as boolean;
                if (!opened) await sleep(500);
              }
              await sleep(800); // modal mount + edit-payload hydration
              if (!opened) throw new Error('guard fixture: edit modal never opened (seeds.g=' + seeds.g + ') — AppBody mounted? e2eHooks tag present?');
              const baseState = await readState(); // PRE-typing baseline (fixture opens the list
              // item directly, so the editor may seed empty — assertions are relative to THIS).
              const typedOk = await win.webContents.executeJavaScript(
                `(() => { const ed = document.querySelector('div[contenteditable][role="textbox"]');
                  if (!ed) return false; ed.focus();
                  document.execCommand('insertText', false, 'HOTFIX-DIRTY-TEXT'); return true; })()`
              ) as boolean;
              await sleep(400); // React flush after the native input event
              const clickButton = (label: string): Promise<boolean> =>
                win.webContents.executeJavaScript(
                  `[...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === ${JSON.stringify(label)}) ? ( [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === ${JSON.stringify(label)}).click(), true ) : false`
                ).then((v) => v === true);

              const dirtyState = await readState();
              const typedAdded = dirtyState.typedChars - baseState.typedChars; // == 17 when the
              // native input event really drove the editor (the React-observable delta)
              const mark1 = await seqLen();
              win.webContents.send('pill:flipRequested', 'cloud'); // dirty flip
              await sleep(900);
              const duringDirty = { mode: await readMode(), dom: await readState(), sawConfirmEvent: await seqHasConfirmOpenSince(mark1) };
              const dirtyIntercept = typedOk && typedAdded === 17 /* len('HOTFIX-DIRTY-TEXT') */
                && appMode === 'local' && duringDirty.mode === 'local'
                && duringDirty.dom.discardConfirmVisible && duringDirty.sawConfirmEvent;

              await clickButton('Keep editing'); // Cancel leg
              await sleep(400);
              const cancelState = { mode: await readMode(), dom: await readState() };
              const cancelKeeps = cancelState.mode === 'local' && cancelState.dom.open
                && cancelState.dom.typedChars === dirtyState.typedChars; // typed text intact

              win.webContents.send('pill:flipRequested', 'cloud'); // re-flip while still dirty
              await sleep(700);
              const confirmAgain = await readState();
              await clickButton('Discard'); // Discard leg — fires the stashed continuation
              await sleep(2000);
              const discardMode = await readMode();
              const discardFlips = discardMode === 'cloud' && appMode === 'cloud';

              // Come back — editor must be GONE *and* the world must be INTACT (C2h: switching
              // never seals). Assert LIVE evidence: vault still unlocked AND the real drop list
              // rendered (no password screen) — guards against any vacuous pass like before.
              win.webContents.send('pill:flipRequested', 'local');
              await sleep(1500);
              const backStatus = String(await win.webContents.executeJavaScript(
                `(window.dropsync ? window.dropsync.vault.status().then((s) => s.state) : Promise.resolve('noBridge'))`
              ));
              const backDom = await readState();
              const cardCount = await countDropCards();
              const editorClosedOnReturn = backDom.open === false && backStatus === 'unlocked'
                && cardCount > 0;

              // Clean leg: reopen (discard threw the typing away), do NOT type, flip ⇒ instant,
              // NO confirm — the guard must not nag the clean case.
              const reopened = await win.webContents.executeJavaScript(
                `window.__c2fEditTest ? window.__c2fEditTest.open(${JSON.stringify(seeds.g)}) : false`
              ) as boolean;
              await sleep(700);
              const markClean = await seqLen();
              win.webContents.send('pill:flipRequested', 'cloud');
              await sleep(1400);
              const cleanState = { mode: await readMode(), dom: await readState(), sawConfirmEvent: await seqHasConfirmOpenSince(markClean) };
              const cleanInstant = reopened && cleanState.mode === 'cloud' && !cleanState.dom.discardConfirmVisible
                && !cleanState.sawConfirmEvent;

              console.log('[c2f-flipguard]', JSON.stringify({
                f_c2f_flipGuardFull: dirtyIntercept && cancelKeeps && discardFlips && editorClosedOnReturn && cleanInstant,
                f_c2f_flipGuard: cleanInstant, // folded: the old relay key IS the clean-path assertion
                matrix: { dirtyIntercept, cancelKeeps, discardFlips, editorClosedOnReturn, cleanInstant },
                raw: { seedId: seeds.g, opened, typedOk, baseState, dirtyState, typedAdded, duringDirty, cancelState, confirmAgain, discardMode, backDom, backStatus, cardCount, cleanState },
              }));

              // (1c) f_c2f_metaSavePreviewKeepsText — THE robot test for hotfix-2. A metadata-only
              // save of a text drop used to leave the preview cache primed with an EMPTY body
              // (App.tsx primeSavedPreviewPayload primed '' when the meta DTO carried no payload)
              // ⇒ the reopened preview rendered blank on an unconditional cache hit. Drives the
              // REAL preview→Edit→save→reopen path and asserts the FULL original text is on screen
              // (DOM) AND in the re-primed cache (dev hook). Regression leg (a): content-edit save
              // still renders the new text.
              // The clean leg above ended in Cloud ⇒ vault sealed ⇒ restore a REAL Local UI
              // through the bridge before driving any preview (locked early-return renders none).
              win.webContents.send('pill:flipRequested', 'local');
              await sleep(1500);
              await win.webContents.executeJavaScript(
                `(async () => { const d = window.dropsync; await d.vault.prepareFolder('/tmp/ds-c2f-vault').catch(() => {}); await d.vault.unlock('/tmp/ds-c2f-vault', 'c2f-vault-pw').catch(() => {}); return true; })()`
              );
              win.webContents.reload();
              await sleep(4500); // boot-into-last-mode ('local') + store fetch with BOTH fixtures
              const openPreview = await win.webContents.executeJavaScript(
                `window.__c2fEditTest ? window.__c2fEditTest.openPreview(${JSON.stringify(seeds.m)}) : false`
              ) as boolean;
              await sleep(1200); // preview mount + cold payload fetch banks into the cache
              const preSave = await win.webContents.executeJavaScript(
                'JSON.stringify(window.__c2fEditTest ? window.__c2fEditTest.previewState() : null)'
              ).then((s) => JSON.parse(s as string) as { preText: string | null; editBtnVisible: boolean });
              // Click the REAL Edit button in the preview → openEditModal's preview-originated
              // branch (editOriginRef set) → this is the ONLY path that rebuilds the preview.
              let clickedEdit = false;
              for (let i = 0; i < 8 && !clickedEdit; i++) {
                clickedEdit = await clickButton('Edit');
                if (!clickedEdit) await sleep(400);
              }
              await sleep(900); // openEditModal hydrates the payload BEFORE mounting the editor
              let openedMeta = false;
              for (let i = 0; i < 8 && !openedMeta; i++) {
                openedMeta = await win.webContents.executeJavaScript(
                  'window.__c2fEditTest ? window.__c2fEditTest.state().open : false'
                ) as boolean;
                if (!openedMeta) await sleep(400);
              }
              // Rename via a NATIVE input event (React onChange) — no state poking.
              const NEW_NAME = 'MetaSaveFixture RENAMED';
              const renamed = await win.webContents.executeJavaScript(
                `(() => { const inp = document.querySelector('input[placeholder="Text snippet"]');
                  if (!inp) return false;
                  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                  set.call(inp, ${JSON.stringify(NEW_NAME)});
                  inp.dispatchEvent(new Event('input', { bubbles: true }));
                  return true; })()`
              ) as boolean;
              await sleep(300); // React flush
              await clickButton('Save changes');
              // Save → invalidate → PRIME(fixed fetch) → reopen; poll for the reopened preview body.
              let postMeta: { preText: string | null } = { preText: null };
              for (let i = 0; i < 12; i++) {
                await sleep(500);
                const st = await win.webContents.executeJavaScript(
                  'window.__c2fEditTest ? JSON.stringify({ ed: document.querySelector("div[contenteditable][role=\\"textbox\\"]") ? true : false, pv: window.__c2fEditTest.previewState() }) : "null"'
                ).then((s) => JSON.parse(s as string) as { ed: boolean; pv: { preText: string | null } } | null);
                if (!st) continue;
                if (!st.ed && st.pv.preText !== null) { postMeta = st.pv; break; }
              }
              const cachedAfterMeta = await win.webContents.executeJavaScript(
                `JSON.stringify(window.__previewCacheGet ? window.__previewCacheGet(${JSON.stringify(seeds.m)}) : null)`
              ).then((s) => JSON.parse(s as string) as { text: string } | null);
              const metaSaveKeepsFullText = preSave.preText === META_TEXT && postMeta.preText === META_TEXT;
              const cachePrimedWithFullText = !!cachedAfterMeta && cachedAfterMeta.text === META_TEXT;

              // Regression leg (a): CONTENT-edit save still renders the new text.
              await clickButton('Edit');
              await sleep(900);
              let reopenedForContent = false;
              for (let i = 0; i < 8 && !reopenedForContent; i++) {
                reopenedForContent = await win.webContents.executeJavaScript(
                  'window.__c2fEditTest ? window.__c2fEditTest.state().open : false'
                ) as boolean;
                if (!reopenedForContent) await sleep(400);
              }
              const contentTyped = await win.webContents.executeJavaScript(
                `(() => { const ed = document.querySelector('div[contenteditable][role="textbox"]');
                  if (!ed) return false; ed.focus();
                  document.execCommand('selectAll', false, null);
                  document.execCommand('insertText', false, 'CONTENT-EDITED-BODY'); return true; })()`
              ) as boolean;
              await sleep(400);
              await clickButton('Save changes');
              let postContent: { preText: string | null } = { preText: null };
              for (let i = 0; i < 12; i++) {
                await sleep(500);
                const st = await win.webContents.executeJavaScript(
                  'window.__c2fEditTest ? JSON.stringify({ ed: document.querySelector("div[contenteditable][role=\\"textbox\\"]") ? true : false, pv: window.__c2fEditTest.previewState() }) : "null"'
                ).then((s) => JSON.parse(s as string) as { ed: boolean; pv: { preText: string | null } } | null);
                if (!st) continue;
                if (!st.ed && st.pv.preText !== null) { postContent = st.pv; break; }
              }
              const cachedAfterContent = await win.webContents.executeJavaScript(
                `JSON.stringify(window.__previewCacheGet ? window.__previewCacheGet(${JSON.stringify(seeds.m)}) : null)`
              ).then((s) => JSON.parse(s as string) as { text: string } | null);
              const contentEditStillRenders = contentTyped && postContent.preText === 'CONTENT-EDITED-BODY'
                && !!cachedAfterContent && cachedAfterContent.text === 'CONTENT-EDITED-BODY';

              console.log('[c2f-metasave]', JSON.stringify({
                f_c2f_metaSavePreviewKeepsText: openPreview && renamed && metaSaveKeepsFullText && cachePrimedWithFullText && contentEditStillRenders,
                matrix: { metaSaveKeepsFullText, cachePrimedWithFullText, contentEditStillRenders },
                raw: { seedsM: seeds.m, openPreview, preSave, clickedEdit, openedMeta, renamed, postMeta, cachedAfterMeta, reopenedForContent, contentTyped, postContent, cachedAfterContent },
              }));
              // (2) Enter Cloud through the REAL user path — the pill flip relay. The site view
              // is created lazily on first Cloud entry, so bounds legs must run with it alive.
              // (Driving the raw mode:set bridge would leave the renderer's screen state out of
              // sync — the relay IS the real path: pill → main → guarded switchMode → mode:set.)
              win.webContents.send('pill:flipRequested', 'cloud');
              let readyMs: number | null = null;
              for (let i = 0; i < 30 && readyMs === null; i++) {
                await sleep(1000);
                readyMs = cloudCtl.probeState().readyMs ?? null;
              }
              // (2b) f_c2g_* — THE PUNCH-HOLE PILL battery (C2g FIX 5). Runs BEFORE the c2f
              // bounds/storm legs and restores Style A at the end, so those carried keys keep
              // asserting against the known full-width footprint. All layer actions ride the
              // REAL DOM listeners via pillDrive/pillEval (env-gated); bounds truth is main-side.
              {
                const g = cloudCtl; // narrowed alias — TS can't keep null-checks inside closures
                const pillState = (): Promise<{ style: string; bloomed: boolean }> =>
                  g.pillEval('JSON.stringify(window.__c2gPill || null)').then((s) => JSON.parse(s as string) as { style: string; bloomed: boolean } | null)
                    .then((p) => p ?? { style: 'missing', bloomed: false });
                const pollStyle = async (want: string): Promise<boolean> => {
                  for (let i = 0; i < 8; i++) {
                    if ((await pillState()).style === want) return true;
                    await sleep(400);
                  }
                  return false;
                };

                // First-boot default proof + normalize: cleared store ⇒ relaunch boots A.
                const styleFile = join(app.getPath('userData'), 'pill-style.json');
                const fileStyle = (): string | null => {
                  try {
                    return (JSON.parse(readFileSync(styleFile, 'utf8')) as { style?: string }).style ?? null;
                  } catch { return null; }
                };
                rmSync(styleFile, { force: true });
                await g.reloadPillLayer();
                await sleep(900);
                const bootedA = await pollStyle('A');

                // f_c2g_geometry — PERMANENT STAGE truth (PAC-5): the room is a constant per
                // style — A = 140 × 28 @y10 (center−70..+70); B = 132 × 44 @y2 (center±66) in
                // EVERY B state. Plus the PAINTED-FOOTPRINT asserts (the page anchors inside
                // the permanent room): #pillA rect [14,0,112,28] (window center−56..+56,
                // pixel-identical rest position) and B's rest circle #pillB [52,8,28,28]
                // (window center−14..+14 × PILL_TOP..+28, byte-identical to every older
                // layout). Plus hotfix-3's A-side LAYOUT asserts (row display — computed
                // value blockifies to `flex` on the abspos element — and Local's rect top 2±0.5)
                // whenever style A is up.
                const geoLegs: Array<{ tag: string; ok: boolean; disp?: string; localTop?: number; room?: [number, number, number] }> = [];
                const readALayout = async (): Promise<{ d: string; t: number; a: [number, number, number, number]; b: [number, number, number, number] | null }> =>
                  g.pillEval(`(function(){ var a = document.getElementById('pillA');
                      var bb = document.getElementById('pillB');
                      var ra = a.getBoundingClientRect();
                      var rb = bb ? bb.getBoundingClientRect() : null;
                      var r = document.getElementById('btn-local-a').getBoundingClientRect();
                      return JSON.stringify({ d: getComputedStyle(a).display, t: +r.top.toFixed(1),
                        a: [+ra.left.toFixed(1), +ra.top.toFixed(1), +ra.width.toFixed(1), +ra.height.toFixed(1)],
                        b: rb ? [+rb.left.toFixed(1), +rb.top.toFixed(1), +rb.width.toFixed(1), +rb.height.toFixed(1)] : null }); })()`)
                    .then((s) => JSON.parse(s as string) as { d: string; t: number; a: [number, number, number, number]; b: [number, number, number, number] | null });
                const geoLeg = async (tag: string, w: number, h: number, fullscreen: boolean): Promise<void> => {
                  if (fullscreen) win.setFullScreen(true);
                  else win.setSize(w, h);
                  await sleep(1600); // watchdog + deferred re-apply budget
                  const b = win.getContentBounds();
                  const site = await g.siteProbe();
                  const pill = await g.pillProbe();
                  // PAC-5 — the two PERMANENT rooms (constants per style; the y-offset is BACK
                  // for B, permanently, and that is correct now — the bloom never moves).
                  const isA = pill.style === 'A';
                  const wantW = isA ? PILL_W + PILL_A_ROOM_PAD_X * 2 : PILL_W + PILL_BLOOM_PAD_X * 2;
                  const wantH = isA ? PILL_H : PILL_H + PILL_BLOOM_PAD_Y * 2;
                  const wantY = isA ? PILL_TOP : PILL_TOP - PILL_BLOOM_PAD_Y;
                  let disp: string | undefined;
                  let localTop: number | undefined;
                  let paintOk = true; // painted-footprint truth inside the permanent room
                  if (isA) {
                    const al = await readALayout();
                    disp = al.d;
                    localTop = al.t;
                    // NOTE (hotfix-3): #pillA is position:absolute, so its COMPUTED display is
                    // BLOCKIFIED — specified `inline-flex` resolves to `flex` ('block' leaked
                    // through when the broken cascade won). Accept the pair as row-proof.
                    paintOk = (al.d === 'inline-flex' || al.d === 'flex') && Math.abs(al.t - 2) <= 0.5
                      && Math.abs(al.a[0] - PILL_A_ROOM_PAD_X) <= 1 && Math.abs(al.a[1]) <= 1
                      && Math.abs(al.a[2] - PILL_W) <= 0.5 && Math.abs(al.a[3] - PILL_H) <= 0.5;
                  } else {
                    // B at rest: the painted circle at [52,8,28,28] in the permanent room.
                    const bl = await readALayout();
                    paintOk = !!bl.b && Math.abs(bl.b[0] - 52) <= 1
                      && Math.abs(bl.b[1] - 8) <= 1
                      && Math.abs(bl.b[2] - PILL_B_REST_W) <= 0.5 && Math.abs(bl.b[3] - PILL_H) <= 0.5;
                  }
                  geoLegs.push({
                    tag,
                    ok: site.visible
                      && site.bounds.x === 0 && site.bounds.y === 0
                      && site.bounds.width === b.width && site.bounds.height === b.height
                      && Math.abs(pill.bounds.x - Math.round((b.width - wantW) / 2)) <= 1
                      && pill.bounds.y === wantY
                      && pill.bounds.width === wantW && pill.bounds.height === wantH
                      && paintOk,
                    disp,
                    localTop,
                    room: [wantW, wantH, wantY],
                  });
                };
                await geoLeg('geo-1600x1000', 1600, 1000, false);
                await geoLeg('geo-1150x760', 1150, 760, false);
                await geoLeg('geo-fullscreen', 0, 0, true);
                win.setFullScreen(false);

                // f_c2g_stylesToggle — REAL right-click toggles A⇄B; disk store updates; choice
                // survives a pill-layer relaunch (disk → query param → first frame).
                await g.pillDrive('contextmenu'); // A → B
                await sleep(400);
                const stB = await pillState();
                const fileAfterB = fileStyle() === 'B';
                const probeStyleB = (await g.pillProbe()).style === 'B';
                const restB = await g.pillProbe(); // B at rest = tight 28 × 28, centered
                await g.reloadPillLayer(); // "relaunch": persisted B must survive
                await sleep(900);
                const survivedB = await pollStyle('B');
                await g.pillDrive('contextmenu'); // B → A
                await sleep(400);
                const stA = await pillState();
                const fileAfterA = fileStyle() === 'A';
                await g.reloadPillLayer();
                await sleep(900);
                const survivedA = await pollStyle('A');

                // f_c2g_bloomBounds — Style B PERMANENT STAGE truth (PAC-5): the room is the
                // SAME constant 132 × 44 @y2 in rest AND bloom (it never changes), the painted
                // circle rests at [52,8,28,28], the bloomed pill lands DEAD CENTERED at
                // [10,8,112,28] — window center±56, the SAME height band as the circle (no
                // down-settle); rapid hover storms settle with no stuck size.
                await g.pillDrive('contextmenu'); // → B again for the bloom legs
                await sleep(400);
                // The two PERMANENT stage rects (PAC-5) — A 140 × 28 @y10, B 132 × 44 @y2.
                const A_ROOM_W = PILL_W + PILL_A_ROOM_PAD_X * 2; // 140
                const B_ROOM_W = PILL_W + PILL_BLOOM_PAD_X * 2; // 132
                const B_ROOM_H = PILL_H + PILL_BLOOM_PAD_Y * 2; // 44
                const B_ROOM_Y = PILL_TOP - PILL_BLOOM_PAD_Y; // 2
                const B_CIRCLE_LEFT = (B_ROOM_W - PILL_B_REST_W) / 2; // 52
                const B_BLOOM_LEFT = (B_ROOM_W - PILL_W) / 2; // 10 — dead-centered pill
                const bStageOk = (r: Electron.Rectangle, cw: number): boolean =>
                  Math.abs(r.x - Math.round((cw - B_ROOM_W) / 2)) <= 1 && r.y === B_ROOM_Y
                  && r.width === B_ROOM_W && r.height === B_ROOM_H;
                const restOk = bStageOk(restB.bounds, win.getContentBounds().width);
                // ZERO-MISS at rest, page-level too: the painted circle IS the whole 28 × 28
                // hover/click target at [52,8,28,28] — the permanent room's transparent margin
                // is dead space by the owner-approved §3.2 decision (the page anchors prove
                // the painted footprint sits exactly where every older layout put it).
                const restPage = await g.pillEval(`(function(){
                    var r = document.getElementById('root').getBoundingClientRect();
                    var p = document.getElementById('pillB').getBoundingClientRect();
                    return JSON.stringify({ rw: [+r.width.toFixed(1), +r.height.toFixed(1)],
                      pl: [+p.left.toFixed(1), +p.top.toFixed(1), +p.width.toFixed(1), +p.height.toFixed(1)] }); })()`)
                  .then((s) => JSON.parse(s as string) as { rw: [number, number]; pl: [number, number, number, number] });
                const restFlush = Math.abs(restPage.rw[0] - B_ROOM_W) <= 0.5
                  && Math.abs(restPage.rw[1] - B_ROOM_H) <= 0.5
                  && Math.abs(restPage.pl[0] - B_CIRCLE_LEFT) <= 0.5 && Math.abs(restPage.pl[1] - PILL_BLOOM_PAD_Y) <= 0.5
                  && restPage.pl[2] === PILL_B_REST_W && restPage.pl[3] === PILL_H;
                // PAC-5 — the room NEVER changes, so the old waitBloomRoom (a main-side room
                // poll) is replaced by the PAINTED bloom truth: #pillB settled at the centered
                // [10,8,112,28] with the class on.
                const readBRect = async (): Promise<[number, number, number, number, boolean]> =>
                  g.pillEval(`(function(){ var p = document.getElementById('pillB');
                      var r = p.getBoundingClientRect();
                      return JSON.stringify([+r.left.toFixed(1), +r.top.toFixed(1),
                        +r.width.toFixed(1), +r.height.toFixed(1), p.classList.contains('bloomed')]); })()`)
                    .then((x) => JSON.parse(x as string) as [number, number, number, number, boolean]);
                const waitBloomPainted = async (): Promise<boolean> => {
                  for (let i = 0; i < 12; i++) { // ≤6s: elastic settle budget
                    await sleep(500);
                    const s = await readBRect();
                    if (s[4] && Math.abs(s[0] - B_BLOOM_LEFT) <= 1 && Math.abs(s[1] - PILL_BLOOM_PAD_Y) <= 1
                      && Math.abs(s[2] - PILL_W) <= 0.5 && Math.abs(s[3] - PILL_H) <= 0.5) return true;
                  }
                  return false;
                };
                const waitRestPainted = async (): Promise<boolean> => {
                  for (let i = 0; i < 12; i++) { // ≤6s: hysteresis 90 + elastic 550 settle
                    await sleep(500);
                    const s = await readBRect();
                    if (!s[4] && Math.abs(s[0] - B_CIRCLE_LEFT) <= 1 && Math.abs(s[1] - PILL_BLOOM_PAD_Y) <= 1
                      && Math.abs(s[2] - PILL_B_REST_W) <= 0.5 && Math.abs(s[3] - PILL_H) <= 0.5) return true;
                  }
                  return false;
                };
                await g.pillDrive('mouseenter');
                // ENTRY truth (PAC-5): no reveal poll exists anymore — the class lands on the
                // same tick as the hover and the room is already the final 132 viewport. The
                // pill must be VISIBLE, bloomed-classed, in the PERMANENT viewport; the settled
                // left position is bloomOk's job (left ANIMATES now — middle-out).
                const entryReveal = await (async (): Promise<boolean> => {
                  for (let i = 0; i < 10; i++) {
                    await sleep(100);
                    const s = await g.pillEval(`(function(){
                        var p = document.getElementById('pillB');
                        if (!p) return JSON.stringify({ v:'none', w:-1, c:false });
                        var cs = getComputedStyle(p);
                        return JSON.stringify({ v: cs.visibility, w: window.innerWidth,
                          c: p.classList.contains('bloomed') }); })()`)
                      .then((x) => JSON.parse(x as string) as { v: string; w: number; c: boolean });
                    if (s.v === 'visible' && s.c && s.w === B_ROOM_W) return true;
                  }
                  return false;
                })();
                const bloomOk = await waitBloomPainted();
                const bloomFlag = (await pillState()).bloomed;
                // C2g-hotfix-3 §5 B-side asserts, read with the bloom settled: inner knob must be
                // ≈54 × 24 (measured 0×0 before the shared .mode-pill sizing), words 10.5px.
                // C2l FIX 3 — the button padding pin followed the ordered CSS change: the demo's
                // content-sizing `14px 7.5px` became `7.5px 0` + flex halves (word centering is
                // now proven geometrically by f_c2l_pillWordsCentered, not by side padding).
                await sleep(400);
                const bStyle = await g.pillEval(`(function(){
                    var ks = getComputedStyle(document.querySelector('#pillB .inner .knob'));
                    var bs = getComputedStyle(document.querySelector('#pillB .inner button'));
                    return JSON.stringify({ kw: parseFloat(ks.width), kh: parseFloat(ks.height),
                      fs: bs.fontSize, pad: bs.paddingLeft + ' ' + bs.paddingTop }); })()`)
                  .then((s) => JSON.parse(s as string) as { kw: number; kh: number; fs: string; pad: string });
                const bStyled = Math.abs(bStyle.kw - 54) <= 1 && Math.abs(bStyle.kh - 24) <= 1
                  && bStyle.fs === '10.5px' && bStyle.pad === '0px 7.5px';
                // HOTFIX-4 painted-pill truth, PAC-5 — the bloomed pill DEAD CENTERED in the
                // permanent room: rect ≈ [10, 8, 112, 28] (window center±56), the SAME height
                // band as the rest circle (the 8 px down-settle is deleted — the bloom grows
                // symmetrically around its own center, ending exactly on the window midline).
                const paint = await g.pillEval(`(function(){
                    var p = document.getElementById('pillB').getBoundingClientRect();
                    return JSON.stringify([+p.left.toFixed(1), +p.top.toFixed(1),
                      +p.width.toFixed(1), +p.height.toFixed(1)]); })()`)
                  .then((s) => JSON.parse(s as string) as [number, number, number, number]);
                const paintCentered = Math.abs(paint[0] - B_BLOOM_LEFT) <= 1
                  && Math.abs(paint[1] - PILL_BLOOM_PAD_Y) <= 1
                  && Math.abs(paint[2] - PILL_W) <= 0.5 && Math.abs(paint[3] - PILL_H) <= 0.5;
                for (const ev of ['mouseleave', 'mouseenter', 'mouseleave', 'mouseenter'] as const) {
                  await g.pillDrive(ev);
                  await sleep(120); // storm — faster than the .55s transition on purpose
                }
                const stormOk = await waitBloomPainted() && (await pillState()).bloomed;
                await g.pillDrive('mouseleave');
                // PAC-5 — the COLLAPSE HOLD is gone (no room machinery exists); what must hold
                // at ~+250 ms is the PERMANENT room itself: exactly the 132 × 44 stage at
                // B_ROOM_Y through the collapse path (proves collapse does NO bounds work).
                await sleep(250);
                const pbHold = (await g.pillProbe()).bounds;
                const cwHold = win.getContentBounds().width;
                const holdKept = bStageOk(pbHold, cwHold);
                // Collapse page truth: the painted circle back at [52,8,28,28], class gone.
                const collapseOk = await waitRestPainted() && !(await pillState()).bloomed;

                // f_c2g_colors — COLOR RULE in BOTH styles × BOTH modes: word under the knob is
                // ALWAYS ink #1a1a1a; the other ALWAYS rgba(255,255,255,.55). Knob side rides the
                // REAL channel (setPillMode — what actual mode flips use).
                const INK = 'rgb(26, 26, 26)';
                const FAINT = 'rgba(255, 255, 255, 0.55)';
                const readColors = async (sel: string): Promise<{ act: string; inact: string }> =>
                  g.pillEval(`(function(){ var bs = document.querySelector('${sel}').querySelectorAll('button');
                      return JSON.stringify({ act: getComputedStyle(bs[0]).color, inact: getComputedStyle(bs[1]).color }); })()`)
                    .then((s) => JSON.parse(s as string) as { act: string; inact: string });
                const pairOk = (c: { act: string; inact: string }, mode: 'cloud' | 'local'): boolean =>
                  mode === 'cloud' ? c.act === INK && c.inact === FAINT : c.inact === INK && c.act === FAINT;
                const colorsOk: Record<string, boolean> = {};
                for (const mode of ['cloud', 'local'] as const) {
                  g.setPillMode(mode);
                  await sleep(800); // knob transition + color .3s ease settled
                  colorsOk[`a${mode}`] = pairOk(await readColors('#pillA'), mode);
                  colorsOk[`b${mode}`] = pairOk(await readColors('#pillB .inner'), mode);
                }

                console.log('[c2g]', JSON.stringify({
                  f_c2g_geometry: bootedA && geoLegs.every((l) => l.ok),
                  f_c2g_stylesToggle: bootedA && stB.style === 'B' && fileAfterB && probeStyleB
                    && bStageOk(restB.bounds, win.getContentBounds().width) && survivedB
                    && stA.style === 'A' && fileAfterA && survivedA,
                  f_c2g_bloomBounds: restOk && restFlush && entryReveal && bloomOk && bloomFlag
                    && paintCentered && holdKept && stormOk && collapseOk && bStyled,
                  f_c2g_colors: colorsOk.acloud && colorsOk.alocal && colorsOk.bcloud && colorsOk.blocal,
                  raw: { geoLegs, boot: { bootedA }, toggle: { stB, fileAfterB, probeStyleB, survivedB, stA, fileAfterA, survivedA },
                    bloom: { restOk, restW: restB.bounds.width, restPage, restFlush, entryReveal, bloomOk, bloomFlag, paint, paintCentered, holdKept, stormOk, collapseOk, bStyle }, colorsOk },
                }));
                await g.pillDrive('contextmenu'); // bloom legs left us in B — restore A for c2f legs
                await sleep(300);
              }

              // (2b2) f_c2g_realClickFlips — THE PRIME DIRECTIVE robot (C2g-hotfix-1 FIX 4):
              // REAL element.click() on the pill layer's actual elements → true listener → true
              // `pill:flip` ipc → true relay → guarded switchMode → applyMode. NO
              // `pill:flipRequested` shortcuts anywhere. Asserts MAIN-side appMode flipped AND
              // the layer's rendered side (knob/dot truth via __c2gPill.mode) matches.
              {
                const g = cloudCtl;
                const flipReceiptsBefore = pillFlipRelayCount;
                const waitMode = async (want: string): Promise<boolean> => {
                  for (let i = 0; i < 12; i++) { // ≤6s: ipc → relay → guarded switch → echo
                    if (appMode === want) return true;
                    await sleep(500);
                  }
                  return appMode === want;
                };
                const layerTruth = async (): Promise<{ style: string; bloomed: boolean; mode: string }> =>
                  g.pillEval('JSON.stringify(window.__c2gPill || null)').then((s) => JSON.parse(s as string) as { style: string; bloomed: boolean; mode: string } | null)
                    .then((p) => p ?? { style: 'missing', bloomed: false, mode: 'missing' });
                // C2g-hotfix-3 §4 — MANDATORY hit-test gate. Before EVERY synthetic click, prove a
                // REAL pointer at the target's center would land on it (or a descendant). A blind
                // el.click() skips hit-testing entirely — exactly how Local shipped invisible
                // AND unclickable while this robot passed 15/15. Any mismatch fails the key.
                const hitTest = async (sel: string): Promise<{ ok: boolean; cx: number; cy: number; hit: string }> =>
                  g.pillEval(`(function(){ var el = document.querySelector('${sel}');
                      if (!el) return JSON.stringify({ ok:false, cx:-1, cy:-1, hit:'MISSING-TARGET' });
                      var r = el.getBoundingClientRect();
                      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
                      var h = document.elementFromPoint(cx, cy);
                      return JSON.stringify({ ok: !!h && (h === el || el.contains(h)),
                        cx:+cx.toFixed(1), cy:+cy.toFixed(1),
                        hit: h ? (h.id || String(h.className).slice(0,32) || h.tagName) : 'OUTSIDE-VIEWPORT' }); })()`)
                    .then((s) => JSON.parse(s as string) as { ok: boolean; cx: number; cy: number; hit: string });
                const hitLog: Array<{ sel: string; cx: number; cy: number; hit: string; ok: boolean }> = [];
                const realClick = async (sel: string): Promise<boolean> => {
                  const ht = await hitTest(sel);
                  hitLog.push({ sel, cx: ht.cx, cy: ht.cy, hit: ht.hit, ok: ht.ok });
                  if (!ht.ok) return false; // gated — never fire a click a human could not make
                  return g.pillEval(`(function(){ var el = document.querySelector('${sel}'); if (!el) return false; el.click(); return true; })()`) as Promise<boolean>;
                };
                const drive = (ev: 'mouseenter' | 'mouseleave' | 'contextmenu'): Promise<void> => g.pillDrive(ev);

                // Leg 1 — Style A word click flips. Battery left us in Cloud + Style A.
                let startA = (await layerTruth()).style === 'A';
                if (!startA) {
                  await drive('contextmenu');
                  await sleep(300);
                  startA = (await layerTruth()).style === 'A';
                }
                // §4's own coordinates, captured FIRST (Style A is up): GREEN must show
                // elementFromPoint(80,14) = btn-local-a and Local's center hitting itself inside
                // the viewport. RED (toggler reverted to block): point lands on the bare #pillA
                // trough and Local's wrapped center falls OUTSIDE-VIEWPORT.
                const redProof = await g.pillEval(`(function(){
                    function tg(el){ if(!el) return 'OUTSIDE-VIEWPORT'; return el.id || String(el.className).slice(0,40) || el.tagName; }
                    var la = document.getElementById('btn-local-a');
                    if (!la) return JSON.stringify({ point80_14:'MISSING', center:[-1,-1], centerHits:'MISSING' });
                    var r = la.getBoundingClientRect();
                    return JSON.stringify({ point80_14: tg(document.elementFromPoint(80, 14)),
                      center:[+(r.left+r.width/2).toFixed(1), +(r.top+r.height/2).toFixed(1)],
                      centerHits: tg(document.elementFromPoint(r.left+r.width/2, r.top+r.height/2)) }); })()`)
                  .then((s) => JSON.parse(s as string) as { point80_14: string; center: [number, number]; centerHits: string });
                const greenProofOk = redProof.point80_14 === 'btn-local-a' && redProof.centerHits === 'btn-local-a'
                  && redProof.center[1] >= 0 && redProof.center[1] < 28;
                await realClick('#btn-local-a'); // Leg 1 — arms main's Style A flip room AT THE RELAY
                // f_c2g_knobRoom (C2g-hotfix-6 FIX 3, PAC-5) — Style A PERMANENT STAGE truth on
                // the REAL path. The click arms nothing anymore: the native room IS the constant
                // 140 × 28 stage (center−70..+70) before, during, and after the flip — so it
                // must read exactly that within ~250 ms of the click (and never change), and the
                // PAINTED #pillA must sit at [14, 0, 112, 28] ±1 (window center−56..+56,
                // pixel-identical rest position) with BOTH end pads free for the overshoot.
                const knobT0 = Date.now();
                let knobRoomWideAt = -1;
                for (let i = 0; i < 12; i++) {
                  await sleep(50);
                  const pb = (await g.pillProbe()).bounds;
                  const cw = win.getContentBounds().width;
                  if (Math.abs(pb.x - Math.round((cw - (PILL_W + PILL_A_ROOM_PAD_X * 2)) / 2)) <= 1
                    && pb.y === PILL_TOP && pb.width === PILL_W + PILL_A_ROOM_PAD_X * 2
                    && pb.height === PILL_H) {
                    knobRoomWideAt = Date.now() - knobT0;
                    break;
                  }
                }
                const paintA = await g.pillEval(`(function(){ var r = document.getElementById('pillA').getBoundingClientRect();
                    return JSON.stringify([+r.left.toFixed(1), +r.top.toFixed(1),
                      +r.width.toFixed(1), +r.height.toFixed(1)]); })()`)
                  .then((s) => JSON.parse(s as string) as [number, number, number, number]);
                const paintStable = Math.abs(paintA[0] - PILL_A_ROOM_PAD_X) <= 1 && Math.abs(paintA[1]) <= 1
                  && Math.abs(paintA[2] - PILL_W) <= 1 && Math.abs(paintA[3] - PILL_H) <= 1;
                // PAC-5 — the old "settles back to 112 × 28" snap is GONE with the hold timers.
                // "Settled" now means the room HOLDS the exact permanent stage across the whole
                // post-flip window (every sample, no drift).
                let knobRoomSettled = true;
                for (let i = 0; i < 6; i++) { // ~1.5 s ≫ the knob's 0.6 s contract
                  await sleep(250);
                  const pb = (await g.pillProbe()).bounds;
                  const cw = win.getContentBounds().width;
                  if (!(Math.abs(pb.x - Math.round((cw - (PILL_W + PILL_A_ROOM_PAD_X * 2)) / 2)) <= 1
                    && pb.y === PILL_TOP && pb.width === PILL_W + PILL_A_ROOM_PAD_X * 2
                    && pb.height === PILL_H)) {
                    knobRoomSettled = false;
                    break;
                  }
                }
                const aWordFlip = await waitMode('local') && (await layerTruth()).mode === 'local';

                // Leg 2 — Style B AT-REST circle click flips (FIX 1: the whole circle is the button).
                await drive('contextmenu'); // → B
                await sleep(400);
                await realClick('#pillB'); // at rest, mode 'local' → flips to the OTHER side
                const circleFlip = await waitMode('cloud') && (await layerTruth()).mode === 'cloud';

                // Leg 3 — Style B BLOOMED word click flips, clicked MID-TRANSITION (edge case:
                // honored, no double-flip). Hover then click within the .55s bloom window.
                await drive('mouseenter');
                await sleep(150);
                await realClick('#btn-local-b');
                const bloomedWordFlip = await waitMode('local') && (await layerTruth()).mode === 'local';

                // Leg 4 — same-mode click is a SAFE no-op (FIX 2: always-send; main dedupes).
                await realClick('#btn-local-b');
                await sleep(1200);
                const sameModeNoop = appMode === 'local' && (await layerTruth()).mode === 'local';
                await drive('mouseleave');
                await sleep(800);

                // Leg 5 — rapid ×10 storm: EVERY click honored or safely deduped; final mode =
                // last click's word; no stuck knob. Back to Style A first (real right-click).
                await drive('contextmenu'); // → A
                await sleep(400);
                for (let i = 0; i < 10; i++) {
                  await realClick(i % 2 === 0 ? '#btn-cloud-a' : '#btn-local-a');
                  await sleep(350);
                }
                const stormFinal = 'local'; // i=0..9 → last click (i=9) is Local
                const stormOk = await waitMode(stormFinal) && (await layerTruth()).mode === stormFinal;
                // End where the c2f legs need us: one more REAL click → Cloud.
                await realClick('#btn-cloud-a');
                const backToCloud = await waitMode('cloud');

                // §5 suspects — bridge presence, layer console cleanliness, relay receipts.
                const bridgeType = await g.pillEval('typeof window.dropsyncPill');
                const consoleTail = g.pillConsoleTail();
                const consoleErrors = consoleTail.filter((l) => l.includes('ERROR') || l.includes('Uncaught') || l.includes('bridge missing'));
                const styleStillToggles = (await (async () => { await drive('contextmenu'); await sleep(300); const b = (await layerTruth()).style === 'B'; await drive('contextmenu'); await sleep(300); return b && (await layerTruth()).style === 'A'; })());

                const everyHitOk = hitLog.length > 0 && hitLog.every((h) => h.ok);
                const knobRoomOk = knobRoomWideAt >= 0 && knobRoomWideAt <= 500 && paintStable && knobRoomSettled;
                console.log('[c2g2]', JSON.stringify({
                  f_c2g_realClickFlips: startA && greenProofOk && everyHitOk && knobRoomOk && aWordFlip
                    && circleFlip && bloomedWordFlip && sameModeNoop && stormOk && backToCloud
                    && styleStillToggles && bridgeType === 'object' && consoleErrors.length === 0
                    && pillFlipRelayCount - flipReceiptsBefore >= 15, // 15 real clicks, 15 receipts
                  matrix: { aWordFlip, circleFlip, bloomedWordFlip, sameModeNoop, stormOk, backToCloud, styleStillToggles, greenProofOk, everyHitOk, knobRoomOk },
                  redProof,
                  suspects: { bridgeType, consoleErrors, flipReceipts: pillFlipRelayCount - flipReceiptsBefore },
                  raw: { hitLog, knobRoom: { knobRoomWideAt, paintA, paintStable, knobRoomSettled } },
                }));
              }
              // (2b3) C2l FIX 3 — f_c2l_pillWordsCentered: each word must center DEAD under its
              // knob half. The old content-sized buttons (padding 7.5px 14px) overflowed the
              // 108px content box and drifted the word pair ~4px right ("Local" text center
              // ≈ 87.6 vs knob-half center 83; 20px whitespace left vs 8px right). Reuses the
              // robot's seams ONLY (pillEval / pillDrive / hit-test-gated click / appMode poll)
              // — no new channels. All geometry derives from LIVE rects (trough content box,
              // buttons, text ranges, knob); thresholds are the order's: boundary ≤1px off the
              // midline, widths ≤0.5px apart, word-vs-button and word-vs-knob-half ≤1.5px.
              {
                const g = cloudCtl;
                const waitMode = async (want: string): Promise<boolean> => {
                  for (let i = 0; i < 12; i++) { if (appMode === want) return true; await sleep(500); }
                  return appMode === want;
                };
                const drive = (ev: 'mouseenter' | 'mouseleave' | 'contextmenu'): Promise<void> => g.pillDrive(ev);
                const realClick = async (sel: string): Promise<boolean> => {
                  // same MANDATORY hit-test gate as the (2b2) robot — never a blind click
                  const ht = await g.pillEval(`(function(){ var el = document.querySelector('${sel}');
                      if (!el) return JSON.stringify({ ok:false });
                      var r = el.getBoundingClientRect();
                      var h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                      return JSON.stringify({ ok: !!h && (h === el || el.contains(h)) }); })()`)
                    .then((s) => JSON.parse(s as string) as { ok: boolean });
                  if (!ht.ok) return false;
                  return g.pillEval(`(function(){ var el = document.querySelector('${sel}'); if (!el) return false; el.click(); return true; })()`) as Promise<boolean>;
                };
                const restRoom = async (): Promise<boolean> => {
                  for (let i = 0; i < 22; i++) { // ≤5.5 s ≫ the 620 ms contract-coupled skirt hold
                    const pb = (await g.pillProbe()).bounds;
                    if (pb.width === PILL_W && pb.height === PILL_H) return true;
                    await sleep(250);
                  }
                  return false;
                };
                const knobSettled = async (knobSel: string): Promise<void> => {
                  let last = -1; // the .6s elastic knob may still be overshooting after a flip
                  for (let i = 0; i < 12; i++) {
                    const c = await g.pillEval(`(function(){ var k = document.querySelector('${knobSel}'); if (!k) return -1; var r = k.getBoundingClientRect(); return +(r.left + r.width / 2).toFixed(2); })()`).then(Number);
                    if (last >= 0 && Math.abs(c - last) <= 0.3) return;
                    last = c;
                    await sleep(250);
                  }
                };
                interface C2lGeom {
                  missing?: boolean; boundary: number; mid: number; boundaryOff: number;
                  midAtRoomCenter: number | null; widthDelta: number; cloudWordOff: number; localWordOff: number;
                  cloudHalfOff: number; localHalfOff: number; tCloudCx: number; tLocalCx: number;
                  cloudHalf: number; localHalf: number; knobCx: number;
                }
                const measure = async (style: 'A' | 'B'): Promise<C2lGeom> => JSON.parse(await g.pillEval(`(function(){
                    function box(el){ if (!el) return null; var r = el.getBoundingClientRect();
                      return { r:+r.right.toFixed(2), w:+r.width.toFixed(2), cx:+(r.left + r.width/2).toFixed(2) }; }
                    function txt(el){ if (!el) return null; var t = document.createRange(); t.selectNodeContents(el);
                      var r = t.getBoundingClientRect(); return { cx:+(r.left + r.width/2).toFixed(2) }; }
                    var isA = ${style === 'A'};
                    var trough = document.querySelector(isA ? '#pillA' : '#pillB .inner .pill');
                    var bc = document.getElementById(isA ? 'btn-cloud-a' : 'btn-cloud-b');
                    var bl = document.getElementById(isA ? 'btn-local-a' : 'btn-local-b');
                    if (!trough || !bc || !bl) return JSON.stringify({ missing: true });
                    var tr = trough.getBoundingClientRect();
                    var cL = tr.left + 2, cR = tr.right - 2, mid = (cL + cR) / 2;
                    var kC = box(bc), kL = box(bl), tC = txt(bc), tL = txt(bl);
                    var knob = box(document.querySelector(isA ? '#pillA .knob' : '#pillB .inner .knob'));
                    return JSON.stringify({
                      boundary: +kC.r.toFixed(2), mid: +mid.toFixed(2),
                      boundaryOff: +Math.abs(kC.r - mid).toFixed(2),
                      midAtRoomCenter: isA ? +Math.abs(mid - window.innerWidth / 2).toFixed(2) : null,
                      widthDelta: +Math.abs(kC.w - kL.w).toFixed(2),
                      cloudWordOff: +Math.abs(tC.cx - kC.cx).toFixed(2),
                      localWordOff: +Math.abs(tL.cx - kL.cx).toFixed(2),
                      cloudHalfOff: +Math.abs(tC.cx - (cL + mid) / 2).toFixed(2),
                      localHalfOff: +Math.abs(tL.cx - (mid + cR) / 2).toFixed(2),
                      tCloudCx: tC.cx, tLocalCx: tL.cx,
                      cloudHalf: +((cL + mid) / 2).toFixed(2), localHalf: +((mid + cR) / 2).toFixed(2),
                      knobCx: knob ? knob.cx : -1
                    });
                  })()`));
                const sideOk = (m: C2lGeom, pinMid: boolean): boolean => !m.missing
                  && m.boundaryOff <= 1 && (!pinMid || (m.midAtRoomCenter !== null && m.midAtRoomCenter <= 1))
                  && m.widthDelta <= 0.5
                  && m.cloudWordOff <= 1.5 && m.localWordOff <= 1.5
                  && m.cloudHalfOff <= 1.5 && m.localHalfOff <= 1.5;
                const originalMode = appMode; // the (2b2) robot handed us Cloud + Style A
                const c2lLegs: Array<{ tag: string; ok: boolean; geom: C2lGeom }> = [];
                // Leg 1 — Style A, Local active (real click through the hit-test gate).
                await realClick('#btn-local-a');
                const localFlipped = await waitMode('local');
                await restRoom(); await knobSettled('#pillA .knob');
                const mLocal = await measure('A');
                c2lLegs.push({ tag: 'A-local', ok: localFlipped && sideOk(mLocal, true), geom: mLocal });
                // Leg 2 — flip to Cloud: words must stay centered regardless of knob side.
                await realClick('#btn-cloud-a');
                const cloudFlipped = await waitMode('cloud');
                await restRoom(); await knobSettled('#pillA .knob');
                const mCloud = await measure('A');
                c2lLegs.push({ tag: 'A-cloud', ok: cloudFlipped && sideOk(mCloud, true), geom: mCloud });
                // Leg 3 — Style B BLOOMED: the inner pill shares .mode-pill, so its words must
                // center automatically — asserted, not assumed.
                await drive('contextmenu'); // → B
                await sleep(400);
                await drive('mouseenter'); // bloom (room widens to 132 × 44; client coords live)
                await sleep(900); // .55s elastic + .25s reveal (.12s delay)
                await knobSettled('#pillB .inner .knob');
                const mB = await measure('B');
                c2lLegs.push({ tag: 'B-bloom', ok: sideOk(mB, false), geom: mB });
                // Collapse, back to Style A + the original mode.
                await drive('mouseleave');
                await sleep(800);
                await drive('contextmenu'); // → A
                await sleep(400);
                if (originalMode === 'local') { await realClick('#btn-local-a'); await waitMode('local'); }
                const restoredStyleA = (await g.pillEval('JSON.stringify(window.__c2gPill || null)')
                  .then((s) => (JSON.parse(s as string) as { style: string } | null)?.style)) === 'A';
                const f_c2l_pillWordsCentered = c2lLegs.every((l) => l.ok) && restoredStyleA && appMode === originalMode;
                console.log('[c2l-pill]', JSON.stringify({
                  f_c2l_pillWordsCentered,
                  matrix: { originalMode, restoredStyleA, legs: c2lLegs.map((l) => ({ tag: l.tag, ok: l.ok })) },
                  raw: { legs: c2lLegs },
                }));
              }
              // (3) f_c2f_boundsFull — resize to two sizes + fullscreen; the site view must equal
              // {0,0,w,h} within ~2s AND the pill must stay glued top-center. This leg ABSORBS
              // the owed f_c2d_boundsFollow debt at the NEW geometry (full window, no notch).
              const origBounds = win.getBounds();
              const ctl = cloudCtl; // narrowed alias — TS can't keep the null-check inside nested arrows
              const boundsLegs: Array<{ tag: string; siteOk: boolean; pillOk: boolean; site: Electron.Rectangle; pill: Electron.Rectangle }> = [];
              const assertLeg = async (tag: string, w: number, h: number, fullscreen: boolean): Promise<void> => {
                if (fullscreen) win.setFullScreen(true);
                else win.setSize(w, h);
                await sleep(1600); // well within the ~1s watchdog + deferred re-apply budget
                const b = win.getContentBounds();
                const site = await ctl.siteProbe();
                const pill = await ctl.pillProbe();
                const siteOk = site.visible
                  && site.bounds.x === 0 && site.bounds.y === 0
                  && site.bounds.width === b.width && site.bounds.height === b.height;
                // C2g contract, PAC-5: the pill's PERMANENT stage is 140 × 28 @y10 (the
                // 112 × 28 painted pill centered inside it), top-CENTER, ±1px on the centered x.
                const pillOk = Math.abs(pill.bounds.x - Math.round((b.width - (PILL_W + PILL_A_ROOM_PAD_X * 2)) / 2)) <= 1
                  && pill.bounds.y === PILL_TOP
                  && pill.bounds.width === PILL_W + PILL_A_ROOM_PAD_X * 2 && pill.bounds.height === PILL_H;
                boundsLegs.push({ tag, siteOk, pillOk, site: site.bounds, pill: pill.bounds });
              };
              await assertLeg('size-1600x1000', 1600, 1000, false);
              await assertLeg('size-1150x760', 1150, 760, false);
              await assertLeg('fullscreen', 0, 0, true);
              win.setFullScreen(false);
              win.setSize(origBounds.width, origBounds.height);
              await sleep(600);
              console.log('[c2f-bounds]', JSON.stringify({
                f_c2f_boundsFull: boundsLegs.every((l) => l.siteOk && l.pillOk),
                f_c2d_boundsFollow_absorbed: boundsLegs.every((l) => l.siteOk && l.pillOk),
                legs: boundsLegs,
              }));

              // (4) f_c2f_pillPersistent — rapid flip storm (×10) with NO settling: exactly one
              // site view + one pill view reused, pill z-order ALWAYS on top (last child),
              // corner bounds intact. The storm drives MAIN-side applyCloudMode directly (view
              // reuse under churn); the renderer is re-synced through mode:set right after,
              // because ALL real user paths flow through the renderer (the desync the storm
              // leaves behind is a battery-only artifact and must not leak into the flip leg).
              const modes: string[] = [];
              for (let i = 0; i < 10; i++) {
                modes.push(await applyCloudMode(i % 2 === 0 ? 'local' : 'cloud'));
              }
              const childViews = win.contentView.children.length;
              const stormPill = await cloudCtl.pillProbe();
              // C2m — childViews became 4: site + fader + card + pill. C3 — childViews is now
              // 5: the STATUS layer joins (site + fader + card + status + pill), a PERMANENT
              // fifth native view added between the card and the pill per the C3 z-law,
              // collapsed 0×0 + hidden at rest. The intent of this assert is unchanged — the
              // flip storm must not leak/duplicate views (a leaked site would read 6+); the
              // +1 is the status layer's accounted-for membership (same accounting-for bump
              // the C2j card and C2m fader additions used).
              const expectedChildViews = 5;
              // PAC-5 — the room-hold awareness is GONE (no holds exist): the stage is the
              // PERMANENT A room (140 × 28 @y10) at EVERY instant, so geometry is asserted
              // directly on the instant storm probe — no settle loop, no snap-back to wait for.
              const settlePill = stormPill;
              const cw2 = win.getContentBounds().width;
              const stormSite = await cloudCtl.siteProbe();
              console.log('[c2f-pill]', JSON.stringify({
                f_c2f_pillPersistent: childViews === expectedChildViews && stormPill.visible && stormPill.loaded
                  && cloudCtl.pillIsTopChild()
                  && Math.abs(settlePill.bounds.x - Math.round((cw2 - (PILL_W + PILL_A_ROOM_PAD_X * 2)) / 2)) <= 1
                  && settlePill.bounds.y === PILL_TOP
                  && settlePill.bounds.width === PILL_W + PILL_A_ROOM_PAD_X * 2
                  && settlePill.bounds.height === PILL_H
                  && stormPill.bodyBackgroundColor === 'rgba(0, 0, 0, 0)',
                toggles: modes.length,
                finalMode: appMode,
                childViews,
                pillIsTopChild: cloudCtl.pillIsTopChild(),
                pillRaw: stormPill,
                siteVisible: stormSite.visible,
              }));
              // Re-sync renderer ⇄ main through the REAL path after the storm (the storm above
              // is main-side by design; this relay flip restores the renderer's screen state).
              win.webContents.send('pill:flipRequested', 'cloud');
              await sleep(1500);
              // (The old f_c2f_flipGuard relay leg was folded into f_c2f_flipGuardFull — its
              // clean-path assertion is emitted from the guard matrix as f_c2f_flipGuard.)
              // Kept [c1]/[c1b] evidence, re-run after all the churn (adapted honestly: badgeDom
              // is GONE — the bottom strip no longer exists; the pill probe replaces it).
              await sleep(1500);
              const iso = await cloudCtl.probeIsolation();
              const auth = await cloudCtl.probeAuthSeen();
              const proof = await cloudCtl.probePersistProof();
              console.log('[c1]', JSON.stringify({
                f_c1_cloudReady: cloudCtl.probeState().readyMs !== null,
                readyMs: cloudCtl.probeState().readyMs,
                f_c1_isolationGuard: iso.dropsyncType === 'undefined'
                  && iso.pillDropsyncType === 'undefined' && iso.pillBridgeType === 'object'
                  // C2j — the card bridge exists ONLY on the card page (never site, never pill).
                  && iso.pillCardBridgeType === 'undefined'
                  && iso.cardDropsyncType === 'undefined' && iso.cardBridgeType === 'object'
                  // C2m — the fader bridge exists ONLY on the fader page (never site/pill/card).
                  && iso.faderDropsyncType === 'undefined' && iso.faderBridgeType === 'object'
                  && iso.faderCardBridgeType === 'undefined'
                  && iso.pillFaderBridgeType === 'undefined' && iso.cardFaderBridgeType === 'undefined'
                  // C3 — the status bridge exists ONLY on the status page (never site/pill/card/fader).
                  && iso.statusDropsyncType === 'undefined' && iso.statusBridgeType === 'object'
                  && iso.statusCardBridgeType === 'undefined' && iso.statusFaderBridgeType === 'undefined'
                  && iso.pillStatusBridgeType === 'undefined' && iso.cardStatusBridgeType === 'undefined'
                  && iso.faderStatusBridgeType === 'undefined',
                isolationRaw: iso,
                f_c1_authSeen: auth.firebaseAuthKeys > 0 || auth.accountChip,
                authSeenRaw: auth,
                persistProof: proof,
                f_c1_switchStorm: { toggles: modes.length, finalMode: appMode, childViews },
              }));
              // C1b FIX D — synthetic auth-handler popup through OUR allowlist, end-to-end.
              const c1b = await cloudCtl!.probeSyntheticAuthPopup();
              console.log('[c1b]', JSON.stringify(c1b));

              // (5) C2h FIX 5 — f_c2h_switchKeepsVaultOpen: switching flips the VIEW only, so a
              // full human-style round trip must keep the vault OPEN and end on the LIVE list.
              // Runs LAST among this stage's cloud-related keys (FIX 6 below runs dead-last).
              {
                win.webContents.send('pill:flipRequested', 'local');
                await sleep(1500);
                if ((await readModeSafe()) !== 'local') { // desync insurance: force both sides local
                  await applyCloudMode('local');
                  win.webContents.send('pill:flipRequested', 'local');
                  await sleep(1200);
                }
                // Preconditions: the battery's own fixtures (GuardFixture etc.) live in
                // /tmp/ds-c2f-vault and are unlocked since (1c)'s restore — main-side guard only,
                // NEVER an unconditional unlock (on an open vault that would lock-then-reopen).
                if (manager.status().state !== 'unlocked') {
                  await manager.unlock('/tmp/ds-c2f-vault', 'c2f-vault-pw');
                }
                const preStatus = manager.status();
                const localCards = await countDropCards(); // reuses the FIX-4 counter
                win.webContents.send('pill:flipRequested', 'cloud'); // real relay path out…
                await sleep(1500);
                const cloudMode = appMode;
                const cloudStatusMain = manager.status().state;
                const cloudStatusRenderer = String(await win.webContents.executeJavaScript(
                  `(window.dropsync ? window.dropsync.vault.status().then((s) => s.state) : Promise.resolve('noBridge'))`
                ));
                win.webContents.send('pill:flipRequested', 'local'); // …and home again
                await sleep(1500);
                const backMode = appMode;
                const backStatusMain = manager.status().state;
                const backPasswordScreen = await win.webContents.executeJavaScript(
                  `!!document.querySelector('input[placeholder="Vault password"]')`
                ) as boolean;
                const backCards = await countDropCards();
                const f_c2h_switchKeepsVaultOpen = preStatus.state === 'unlocked' && localCards > 0
                  && cloudMode === 'cloud' && cloudStatusMain === 'unlocked' && cloudStatusRenderer === 'unlocked'
                  && backMode === 'local' && backStatusMain === 'unlocked'
                  && backPasswordScreen === false && backCards > 0;
                console.log('[c2h-switch]', JSON.stringify({
                  f_c2h_switchKeepsVaultOpen,
                  matrix: { unlockedBefore: preStatus.state === 'unlocked', localCards: localCards > 0, cloudTripUnlocked: cloudStatusMain === 'unlocked' && cloudStatusRenderer === 'unlocked', homeUnlocked: backStatusMain === 'unlocked', noPasswordScreen: backPasswordScreen === false, homeListRendered: backCards > 0 },
                  raw: { preStatus, localCards, cloudMode, cloudStatusMain, cloudStatusRenderer, backMode, backStatusMain, backPasswordScreen, backCards },
                }));
              }

              // (5b) C2i FIX D — f_c2i_warmHomecomingNoRefetch — placed between the non-destructive
              // C2h switch-trip above and the destructive idle-lock stage below. ALL trips run
              // through the REAL relay path (pill:flipRequested ≡ pill click). Warm trip proves
              // REMOUNT-lessness (dataset sentinel survives React reconciliation only while the
              // underlying DOM node survives) and ZERO refetch (the drop-list call counter the
              // S2 close-Settings zero-refetch leg consumes — index.ts dev:testOnly actions
              // 'resetListCallCount'/'listCallStats', rendered-counter increment at
              // handle('drop:list')'s dropListCallCount += 1). Lock-behind trip proves the
              // whisper-check catches the idle-lock AT ARRIVAL with zero list traffic.
              {
                win.webContents.send('pill:flipRequested', 'local');
                await sleep(1500);
                if ((await readModeSafe()) !== 'local') {
                  await applyCloudMode('local');
                  await sleep(1200);
                }
                if (manager.status().state !== 'unlocked') { // defensive only (neighbors leave it open)
                  await manager.unlock('/tmp/ds-c2f-vault', 'c2f-vault-pw');
                  await sleep(400);
                }
                const cardsWarmBefore = await countDropCards();
                const tokenSent = `c2i-warm-${Date.now()}`;
                // Stamp the token AND capture node-object references: a React remount produces
                // NEW DOM nodes by definition, so same-reference-after-the-trip is the strongest
                // possible no-remount evidence (belt-and-braces beside the ordered token check).
                const stampRes = JSON.parse(await win.webContents.executeJavaScript(
                  `(function(){ var sh = document.querySelector('[data-shell]');
                     var c = document.querySelector('div.select-none.cursor-pointer.group.overflow-hidden');
                     if (!c || !sh) return JSON.stringify({ ok: false });
                     c.dataset.c2iWarm = ${JSON.stringify(tokenSent)};
                     window.__c2iCardRef = c; window.__c2iShellRef = sh;
                     return JSON.stringify({ ok: true }); })()`
                )) as { ok: boolean };
                await win.webContents.executeJavaScript(
                  `window.dropsync.dev.testOnly('resetListCallCount', '')`
                );
                let sawCloudLeg = false;
                win.webContents.send('pill:flipRequested', 'cloud'); // out…
                await sleep(1500);
                sawCloudLeg = appMode === 'cloud';
                // C2i-hotfix-1 FIX 2 — REGRESSION-KILLER sample taken WHILE Cloud is up: the
                // inner container must ALREADY be fixed/visible/cream here (under the buggy C2i
                // shape this reported static/hidden/rgba(0,0,0,0), and the reveal gap painted
                // the white flash on the way home). data-shell still flips attr-level only.
                const cloudSample = JSON.parse(await win.webContents.executeJavaScript(
                  `(function(){ var el = document.querySelector('[data-shell] > div');
                     var cs = getComputedStyle(el);
                     return JSON.stringify({ pos: cs.position, vis: cs.visibility,
                       bg: cs.backgroundColor, shell: document.querySelector('[data-shell]').getAttribute('data-shell') }); })()`
                )) as { pos: string; vis: string; bg: string; shell: string };
                const styleInvariantCloud = cloudSample.pos === 'fixed' && cloudSample.vis === 'visible'
                  && cloudSample.bg === 'rgb(250, 247, 242)';
                win.webContents.send('pill:flipRequested', 'local'); // …and home (WARM)
                await sleep(1500);
                const sentinelState = JSON.parse(await win.webContents.executeJavaScript(
                  `(function(){ var c = document.querySelector('div.select-none.cursor-pointer.group.overflow-hidden');
                     var sh = document.querySelector('[data-shell]');
                     var el = document.querySelector('[data-shell] > div'); var cs = getComputedStyle(el);
                     return JSON.stringify({ tokenNow: c ? (c.getAttribute('data-c2iWarm') || '') : '',
                       sameCardRef: !!window.__c2iCardRef && c === window.__c2iCardRef,
                       sameShellRef: !!window.__c2iShellRef && sh === window.__c2iShellRef,
                       shell: sh ? sh.getAttribute('data-shell') : null,
                       anyVisiblePwd: !!document.querySelector('input[placeholder="Vault password"]'),
                       localStyle: { pos: cs.position, vis: cs.visibility, bg: cs.backgroundColor } }); })()`
                )) as { tokenNow: string; sameCardRef: boolean; sameShellRef: boolean; shell: string | null; anyVisiblePwd: boolean; localStyle: { pos: string; vis: string; bg: string } };
                const styleInvariantLocal = sentinelState.localStyle.pos === 'fixed'
                  && sentinelState.localStyle.vis === 'visible'
                  && sentinelState.localStyle.bg === 'rgb(250, 247, 242)';
                const shellFlippedBothWays = cloudSample.shell === 'cloud' && sentinelState.shell === 'local';
                const cardsWarmAfter = await countDropCards();
                const listCallsWarm = Number((await win.webContents.executeJavaScript(
                  `window.dropsync.dev.testOnly('listCallStats', '').then((r) => r.count)`
                )) as number);
                const warmTripOk = stampRes.ok && (sentinelState.tokenNow === tokenSent || sentinelState.sameCardRef)
                  && sentinelState.sameCardRef && sentinelState.sameShellRef
                  && cardsWarmAfter === cardsWarmBefore && cardsWarmAfter > 0
                  && listCallsWarm === 0 && !sentinelState.anyVisiblePwd && sawCloudLeg
                  // C2i-hotfix-1 — the pinned invariant: permanent+visible container in BOTH worlds.
                  && styleInvariantCloud && styleInvariantLocal && shellFlippedBothWays;

                // LOCK-BEHIND leg: seal MAIN-SIDE while home (renderer still believes unlocked),
                // then a Cloud round trip must land INSTANTLY on the password screen with ZERO
                // drop-list traffic — the whisper reconciling, exactly its reason to exist.
                await manager.lock();
                win.webContents.send('pill:flipRequested', 'cloud');
                await sleep(1200);
                await win.webContents.executeJavaScript(
                  `window.dropsync.dev.testOnly('resetListCallCount', '')` // isolate the RETURN leg's delta
                );
                win.webContents.send('pill:flipRequested', 'local');
                await sleep(1500);
                const pwdDetectedOnArrival = await win.webContents.executeJavaScript(
                  `!!document.querySelector('input[placeholder="Vault password"]')`
                ) as boolean;
                const listCallsReturn = Number((await win.webContents.executeJavaScript(
                  `window.dropsync.dev.testOnly('listCallStats', '').then((r) => r.count)`
                )) as number);
                const lockBehindOk = pwdDetectedOnArrival && listCallsReturn === 0;

                const f_c2i_warmHomecomingNoRefetch = warmTripOk && lockBehindOk;
                console.log('[c2i]', JSON.stringify({
                  f_c2i_warmHomecomingNoRefetch,
                  matrix: { stamped: stampRes.ok, tokenSurvived: sentinelState.tokenNow === tokenSent, sameCardRef: sentinelState.sameCardRef, sameShellRef: sentinelState.sameShellRef, cardsUnchanged: cardsWarmAfter === cardsWarmBefore && cardsWarmAfter > 0, zeroRefetchTrip: listCallsWarm === 0, noPasswordAfterTrip: !sentinelState.anyVisiblePwd, sawCloudLeg, instantPasswordOnLockBehind: pwdDetectedOnArrival, zeroRefetchReturn: listCallsReturn === 0, styleInvariantCloud, styleInvariantLocal, shellFlippedBothWays },
                  raw: { sentinelBefore: stampRes.ok ? tokenSent : null, sentinelAfter: sentinelState, cloudStyleSample: cloudSample, cardsWarmBefore, cardsWarmAfter, listCallsWarm, listCallsReturn, pwdDetectedOnArrival },
                }));
                // CLEANUP: the lock-behind leg genuinely sealed the vault — restore the same sane
                // unlocked Local stage later work expects (same dance as the C2h cleanup below).
                try { await manager.unlock('/tmp/ds-c2f-vault', 'c2f-vault-pw'); } catch { /* already */ }
                win.webContents.reload();
                await sleep(4000);
              }

              // (5c) C2j — f_c2j_cardOverBothWorlds — placed per order: immediately AFTER the C2i
              // key (its lock-behind leg + cleanup reload re-establish the sane unlocked Local
              // stage — build on that clean point) and BEFORE the dead-last C2h idle stage. The
              // card is a THIRD NATIVE VIEW: no C2i renderer/DOM assertions are touched. All
              // synthetic fires go through the EXACT engine notifier seam (`engineNotifier`,
              // assigned at the manager.setNotifier site — no second engine invented).
              {
                if (manager.status().state !== 'unlocked') { // defensive only (cleanup leaves it open)
                  await manager.unlock('/tmp/ds-c2f-vault', 'c2f-vault-pw');
                  await sleep(400);
                }
                await cloudCtl!.cardTestReset(); // hermetic start: no stale queues/timers
                const delivered0 = (await cloudCtl!.cardProbe()).delivered;
                const winFocused = win.isFocused(); // diagnostic: LEG 3 only fires when UNfocused

                // LEG A — single fire while LOCAL is shown.
                engineNotifier?.('C2j reminder', 'warm local fire');
                await sleep(600);
                const probeLocal = await cloudCtl!.cardProbe();
                // LEG B — the SAME card must stay glued over the CLOUD world (watchdog ≤1 s
                // re-asserts bounds after the flip's resize/move churn; sleep 1500 covers it).
                win.webContents.send('pill:flipRequested', 'cloud');
                await sleep(1500);
                const probeCloud = await cloudCtl!.cardProbe();
                // LEG C — home again; then auto-dismiss must collapse the footprint to 0×0.
                win.webContents.send('pill:flipRequested', 'local');
                await sleep(1500);
                const probeHome = await cloudCtl!.cardProbe();
                await sleep(7500); // AUTO_DISMISS 5500 + hide-hold 200 + watchdog 1000 + slop
                const probeDismissed = await cloudCtl!.cardProbe();

                // LEG D — rapid fire ≤200 ms apart: serial display (ONE visible at a time), all
                // three delivered across ~3×(AUTO_DISMISS)+gaps, no stuck layer afterwards.
                await cloudCtl!.cardTestReset(); // isolate the storm from any stray queue state
                const deliveredBeforeStorm = (await cloudCtl!.cardProbe()).delivered;
                engineNotifier?.('C2j storm 1', 'rapid 1');
                await sleep(120);
                engineNotifier?.('C2j storm 2', 'rapid 2');
                await sleep(120);
                engineNotifier?.('C2j storm 3', 'rapid 3');
                await sleep(600);
                const stormMid = await cloudCtl!.cardProbe(); // 1 visible, 2 still queued
                await sleep(18500); // 2 remaining × (5500 dismiss + 200 hold + 400 gap) + slop
                const stormEnd = await cloudCtl!.cardProbe();

                // LEG E (logic-level ONLY, per order — no UI assertions) — missed-queue data
                // structure: cap 20, overflow drops the OLDEST (2 dropped), drain order
                // oldest-first (the first display-queue title must be item 3). Reset purges.
                await cloudCtl!.cardTestReset();
                for (let i = 1; i <= 22; i++) cloudCtl!.enqueueMissed(`C2j missed ${i}`, `unit ${i}`);
                const missedCapped = await cloudCtl!.cardProbe();
                cloudCtl!.drainMissed();
                const drainedProbe = await cloudCtl!.cardProbe();
                await cloudCtl!.cardTestReset();
                const purged = await cloudCtl!.cardProbe();

                // LEG F — C2j-hotfix-1 — f_c2j_rearmFiresAgain: a RE-ARMED reminder must erase
                // the stale fired stamp (dropOps.ts re-arm branch) so the engine announces it
                // AGAIN. Temp drop via the REAL renderer bridge (seed idiom index.ts:529/:976);
                // engine ticks every 30 s ⇒ a due-at-+1.5 s reminder lands on the next tick
                // within ≤31.5 s, so 18 × 2 s polls cover each leg. RED-PROOF: comment the
                // journalPatch.reminderFiredAt = null line in dropOps.ts ⇒ leg 2 stays flat.
                await cloudCtl!.cardTestReset();
                const rearm0 = (await cloudCtl!.cardProbe()).delivered;
                const tempDrop = await win.webContents.executeJavaScript(
                  `window.dropsync.drop.createText({ spaceId: 'personal', name: 'C2j Rearm', content: 'rearm proof', categories: [], expirationOption: '24h', locked: false, reminderAt: new Date(Date.now() + 1500).toISOString() })`
                ) as { id: string } | null;
                let fire1 = false;
                for (let i = 0; i < 18 && !fire1; i++) {
                  await sleep(2000);
                  fire1 = (await cloudCtl!.cardProbe()).delivered > rearm0;
                }
                const afterFirst = (await cloudCtl!.cardProbe()).delivered;
                await win.webContents.executeJavaScript(
                  `window.dropsync.drop.updateMeta(${JSON.stringify(tempDrop?.id)}, { reminderAt: new Date(Date.now() + 1500).toISOString() })`
                );
                let fire2 = false;
                for (let i = 0; i < 18 && !fire2; i++) {
                  await sleep(2000);
                  fire2 = (await cloudCtl!.cardProbe()).delivered > afterFirst;
                }
                const afterSecond = (await cloudCtl!.cardProbe()).delivered;
                // Cleanup: temp drop gone + layer inert so later stages stay sane.
                if (tempDrop?.id) {
                  await win.webContents.executeJavaScript(
                    `window.dropsync.drop.deleteDrop(${JSON.stringify(tempDrop.id)})`
                  ).catch(() => {});
                }
                await cloudCtl!.cardTestReset();
                const rearmPurged = await cloudCtl!.cardProbe();
                const f_c2j_rearmFiresAgain = !!tempDrop && fire1 && fire2
                  && afterSecond - rearm0 === 2
                  && !rearmPurged.showing && rearmPurged.queueLen === 0;

                // LEG G — C2k — f_c2j_cardFollowsTheme: the card wears the app's CURRENT theme
                // at DISPLAY time (owner pick Row B ink bar). Fired through the EXACT engine
                // seam (engineNotifier → engineNotify → reminderShow(title, body, currentTheme())
                // → card:show → page vars) so the whole route is proven, asserted on the probe's
                // live pageTheme attr AND the painted computed truth (bar bg, 8px radius, 1px
                // hairline). Hermetic between legs via cardTestReset (skips the 5.5 s dismiss).
                type C2kProbe = Awaited<ReturnType<CloudController['cardProbe']>>;
                await cloudCtl!.cardTestReset();
                const prevTheme = manager.getSettings().theme;
                await manager.setSettings({ theme: 'dark' });
                engineNotifier?.('C2j theme dark', 'row b ink');
                let themeDark: C2kProbe | null = null;
                for (let i = 0; i < 20 && !themeDark; i++) {
                  await sleep(250);
                  const p = await cloudCtl!.cardProbe();
                  if (p.pageTheme === 'dark' && p.painted && p.painted.barBg === 'rgb(255, 255, 255)'
                    && p.painted.cardRadius === '8px' && p.painted.cardBorderWidth === '1px') themeDark = p;
                }
                await cloudCtl!.cardTestReset();
                await manager.setSettings({ theme: 'light' });
                engineNotifier?.('C2j theme light', 'row b ink');
                let themeLight: C2kProbe | null = null;
                for (let i = 0; i < 20 && !themeLight; i++) {
                  await sleep(250);
                  const p = await cloudCtl!.cardProbe();
                  if (p.pageTheme === 'light' && p.painted && p.painted.barBg === 'rgb(26, 26, 26)'
                    && p.painted.cardRadius === '8px' && p.painted.cardBorderWidth === '1px') themeLight = p;
                }
                await manager.setSettings({ theme: prevTheme }); // restore the battery vault's theme
                await cloudCtl!.cardTestReset();
                const themePurged = await cloudCtl!.cardProbe();
                const f_c2j_cardFollowsTheme = !!themeDark && !!themeLight
                  && themeDark.pageTheme === 'dark' && themeLight.pageTheme === 'light'
                  && !themePurged.showing && themePurged.queueLen === 0;

                const rectEq = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean =>
                  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
                const f_c2j_cardOverBothWorlds = probeLocal.showing && probeLocal.visible && probeLocal.loaded
                  && probeLocal.pageCardVisible === true && probeLocal.pillIsTop
                  && rectEq(probeLocal.bounds, probeLocal.expected)
                  && probeCloud.showing && probeCloud.pillIsTop && rectEq(probeCloud.bounds, probeCloud.expected)
                  && probeHome.showing
                  && !probeDismissed.showing && probeDismissed.bounds.width === 0 && probeDismissed.bounds.height === 0
                  && stormMid.showing && stormMid.queueLen === 2
                  && !stormEnd.showing && stormEnd.queueLen === 0 && stormEnd.bounds.width === 0 && stormEnd.bounds.height === 0
                  && stormEnd.delivered - deliveredBeforeStorm === 3
                  && missedCapped.missedLen === 20 && missedCapped.missedDropped === 2
                  && drainedProbe.missedLen === 0 && drainedProbe.currentTitle === 'C2j missed 3'
                  && drainedProbe.queueLen === 19
                  && !purged.showing && purged.queueLen === 0 && purged.missedLen === 0;
                console.log('[c2j]', JSON.stringify({
                  f_c2j_cardOverBothWorlds,
                  f_c2j_rearmFiresAgain,
                  f_c2j_cardFollowsTheme,
                  rearmMatrix: {
                    tempDropCreated: !!tempDrop, firstFire: fire1, rearmSecondFire: fire2,
                    firstDelta: afterFirst - rearm0, secondDelta: afterSecond - afterFirst,
                    purgedClean: !rearmPurged.showing && rearmPurged.queueLen === 0,
                  },
                  themeMatrix: {
                    prevTheme, restored: manager.getSettings().theme === prevTheme,
                    darkLeg: themeDark ? { pageTheme: themeDark.pageTheme, barBg: themeDark.painted?.barBg, radius: themeDark.painted?.cardRadius, edge: themeDark.painted?.cardBorderWidth } : null,
                    lightLeg: themeLight ? { pageTheme: themeLight.pageTheme, barBg: themeLight.painted?.barBg, radius: themeLight.painted?.cardRadius, edge: themeLight.painted?.cardBorderWidth } : null,
                    purgedClean: !themePurged.showing && themePurged.queueLen === 0,
                  },
                  matrix: {
                    localShown: probeLocal.showing && probeLocal.pageCardVisible === true,
                    localBoundsExact: rectEq(probeLocal.bounds, probeLocal.expected),
                    cloudStillShown: probeCloud.showing && probeCloud.pageCardVisible === true,
                    cloudBoundsExact: rectEq(probeCloud.bounds, probeCloud.expected),
                    pillTopLocal: probeLocal.pillIsTop, pillTopCloud: probeCloud.pillIsTop,
                    autoDismissCollapsed: !probeDismissed.showing && probeDismissed.bounds.width === 0,
                    stormSerialized: stormMid.showing && stormMid.queueLen === 2,
                    stormAllDelivered: stormEnd.delivered - deliveredBeforeStorm === 3,
                    stormCleanEnd: !stormEnd.showing && stormEnd.queueLen === 0 && stormEnd.bounds.width === 0,
                    missedCap: missedCapped.missedLen === 20 && missedCapped.missedDropped === 2,
                    missedDrainOrderOldestFirst: drainedProbe.currentTitle === 'C2j missed 3' && drainedProbe.queueLen === 19,
                    purgedClean: !purged.showing && purged.queueLen === 0 && purged.missedLen === 0,
                  },
                  raw: {
                    winFocused, delivered0, deliveredBeforeStorm,
                    probeLocal, probeCloud, probeHome, probeDismissed, stormMid, stormEnd, missedCapped, drainedProbe, purged,
                    themeDark, themeLight, themePurged,
                  },
                }));
                // No cleanup needed: LEG E + LEG F + LEG G ended with cardTestReset (collapsed +
                // empty queues, temp drop deleted, theme restored) — the card layer is inert and
                // the vault theme is back for the dead-last C2h idle stage that follows.
              }

              // (5d) C2m — f_c2m_flipDissolve — THE FLIP DISSOLVE battery. Placed per order:
              // immediately AFTER the C2j stage (Local + unlocked + card inert) and BEFORE the
              // dead-last C2h idle stage. User flips are driven through the REAL relay
              // (`pill:flipRequested`, as the existing robot legs do) with the ARM step a real
              // click performs: the `pill:flip` ipc handler stamps transitionArmedAt, so each
              // armed leg stamps it here directly (the identical write, same module variable)
              // before the relay — FIX 3's gate in applyMode reads exactly this. STEP 0.5
              // outcome B: no click pass-through API exists on this Electron build (spike,
              // 2026-08-28), so leg 2's PROMPT 0×0 collapse IS the zero-miss-click guarantee.
              // C2m-hotfix-1 (THE COVERED SWAP): meltLeg now also asserts the curtain comes up
              // BEFORE the world swap (in-flight + full-ish bounds while appMode is STILL the
              // outgoing mode — sampled at 25 ms; decode ≈ tens of ms) — one continuous
              // dissolve, no new-world peek-through.
              {
                const faderSnap = (): Promise<{ attached: boolean; inFlight: boolean; bounds: Electron.Rectangle | null; collapsed: boolean }> =>
                  cloudCtl!.faderProbe();
                type FaderSnap = Awaited<ReturnType<typeof faderSnap>>;
                const fullish = (b: FaderSnap['bounds']): boolean => {
                  const cb = win.getContentBounds();
                  return !!b && b.x === 0 && b.y === 0
                    && Math.abs(b.width - cb.width) <= 2 && Math.abs(b.height - cb.height) <= 2;
                };
                const flat = (b: FaderSnap['bounds']): boolean => !!b && b.width === 0 && b.height === 0;
                /** One melt round-trip: ARM + relay, poll for the in-flight window (bounds ≈
                 * content) at 25 ms cadence — the FIRST observable fact must be the curtain up
                 * while appMode is STILL the outgoing mode (covered swap) — then poll settle
                 * to collapsed 0×0. */
                const meltLeg = async (next: 'cloud' | 'local') => {
                  const outgoing = appMode; // the world on screen BEFORE the relay lands
                  transitionArmedAt = Date.now(); // the pill:flip handler's exact arm write
                  win.webContents.send('pill:flipRequested', next);
                  let inFlightSnap: FaderSnap | null = null;
                  let coveredSwap = false;
                  let curtainUpAt = -1; // first in-flight (full-ish bounds) observation, ms clock
                  const t0 = Date.now();
                  while (Date.now() - t0 < 1000) { // melt window ≈ decode + pad + fade + delay
                    const p = await faderSnap();
                    if (p.inFlight && p.attached && fullish(p.bounds)) {
                      inFlightSnap = p;
                      curtainUpAt = Date.now();
                      coveredSwap = appMode === outgoing; // curtain BEFORE the swap ⇒ no peek
                      break;
                    }
                    if (!p.inFlight && flat(p.bounds) && Date.now() - t0 > 700) break; // already over
                    await sleep(25);
                  }
                  // C2m-hotfix-1 — the mode applies only AFTER the ready handshake (the swap
                  // waits for the painted curtain), so "later" is sampled explicitly: poll
                  // until the flip lands, THEN read modeAfterArm (in C2m the swap preceded the
                  // observable in-flight, so the old single-sample read the applied mode).
                  const tMode = Date.now();
                  while (Date.now() - tMode < 800 && appMode !== next) await sleep(20);
                  const modeAfterArm = appMode;
                  // C2m-hotfix-2 — observed span from curtain-up to the flip landing: the
                  // MELT_SWAP_PAD_MS headroom + decode tail + poll resolution. The battery
                  // cannot observe `fader:ready` directly (main-internal), so this is the
                  // honest observable proxy — printed raw per leg.
                  const swapPadMs = curtainUpAt >= 0 ? Date.now() - curtainUpAt : -1;
                  let settledSnap: FaderSnap | null = null;
                  const t1 = Date.now();
                  while (Date.now() - t1 < 1200) { // settle: inFlight clears, footprint 0×0
                    const p = await faderSnap();
                    if (!p.inFlight && flat(p.bounds) && p.attached) { settledSnap = p; break; }
                    await sleep(25);
                  }
                  return { inFlightSnap, settledSnap, modeAfterArm, coveredSwap, swapPadMs, next };
                };

                // Start Local through the REAL relay (renderer re-synced, c2f-storm discipline).
                win.webContents.send('pill:flipRequested', 'local');
                await sleep(1500);

                // LEG 1+2 — Local→Cloud: melt observed in-flight (≈ full-window fader), then a
                // prompt settle to 0×0; the mode applied REGARDLESS of the effect.
                const legOut = await meltLeg('cloud');
                // LEG 3+4 — Cloud→Local: same two legs, both directions dissolve.
                await sleep(400);
                const legHome = await meltLeg('local');

                // LEG 5 — RAPID STORM: three armed flips ~150 ms apart — melts cancel serially
                // (owner decision 4), nothing stacks, no leaked/duplicated views (children 4).
                transitionArmedAt = Date.now();
                win.webContents.send('pill:flipRequested', 'cloud');
                await sleep(150);
                transitionArmedAt = Date.now();
                win.webContents.send('pill:flipRequested', 'local');
                await sleep(150);
                transitionArmedAt = Date.now();
                win.webContents.send('pill:flipRequested', 'cloud');
                await sleep(1500);
                const stormProbe = await faderSnap();
                const stormChildViews = win.contentView.children.length;
                const stormFinalMode = appMode;

                // LEG 6 — SYSTEM flips don't dissolve: drive applyCloudMode DIRECTLY (the storm
                // path). No arm ⇒ NO in-flight window observable (sampled immediately + a few
                // beats); the mode still flips.
                // C2m-hotfix-2 — clear any STALE USER ARM first: a storm flip the RENDERER
                // dropped (its in-flight switch guard eats a relay that lands mid-switch —
                // more likely since the hotfix pads widened the apply window) leaves a warm
                // transitionArmedAt that would LEGITIMATELY melt this programmatic flip inside
                // FIX 3's 10 s expiry. Leg 6's premise is "a system flip carries no user arm"
                // — make the premise literal instead of timing-dependent.
                transitionArmedAt = 0;
                const sysSamples: FaderSnap[] = [];
                await applyCloudMode('local');
                sysSamples.push(await faderSnap());
                await sleep(80);
                sysSamples.push(await faderSnap());
                await sleep(200);
                sysSamples.push(await faderSnap());
                const sysMode = appMode;

                const meltOk = (leg: Awaited<ReturnType<typeof meltLeg>>): boolean =>
                  !!leg.inFlightSnap && leg.inFlightSnap.inFlight && leg.inFlightSnap.attached
                  && fullish(leg.inFlightSnap.bounds)
                  && leg.coveredSwap // C2m-hotfix-1 — curtain BEFORE the swap, both directions
                  && !!leg.settledSnap && !leg.settledSnap.inFlight && flat(leg.settledSnap.bounds)
                  && leg.modeAfterArm === leg.next;
                // C3 — the storm's child count is now 5 (status layer membership, accounted
                // for above); the zero-leak intent is unchanged.
                const stormExpectedChildViews = 5;
                const f_c2m_flipDissolve = meltOk(legOut) && meltOk(legHome)
                  && !stormProbe.inFlight && flat(stormProbe.bounds) && stormProbe.attached
                  && stormChildViews === stormExpectedChildViews && stormFinalMode === 'cloud'
                  && sysSamples.every((p) => !p.inFlight) && sysMode === 'local';

                console.log('[c2m]', JSON.stringify({
                  f_c2m_flipDissolve,
                  matrix: {
                    outInFlight: !!legOut.inFlightSnap && legOut.inFlightSnap.inFlight && fullish(legOut.inFlightSnap.bounds),
                    outCoveredSwap: legOut.coveredSwap,
                    outSwapPadMs: legOut.swapPadMs,
                    outSettledFlat: !!legOut.settledSnap && flat(legOut.settledSnap.bounds),
                    homeInFlight: !!legHome.inFlightSnap && legHome.inFlightSnap.inFlight && fullish(legHome.inFlightSnap.bounds),
                    homeCoveredSwap: legHome.coveredSwap,
                    homeSwapPadMs: legHome.swapPadMs,
                    homeSettledFlat: !!legHome.settledSnap && flat(legHome.settledSnap.bounds),
                    stormCleanEnd: !stormProbe.inFlight && flat(stormProbe.bounds) && stormProbe.attached && stormChildViews === stormExpectedChildViews,
                    systemFlipNeverMelts: sysSamples.every((p) => !p.inFlight && flat(p.bounds)) && sysMode === 'local',
                  },
                  raw: { legOut, legHome, stormProbe, stormChildViews, stormFinalMode, sysSamples, sysMode },
                }));
                // Re-sync renderer ⇄ main through the REAL relay after leg 6's main-side flip
                // (the c2f-storm discipline): leg 6 leaves main LOCAL but the renderer still on
                // 'cloud' — a battery-only desync that MUST NOT leak into the dead-last C2h
                // idle stage (its own relay flip to 'cloud' would no-op against a cloud
                // renderer). A relay flip to main's current mode re-aligns both sides.
                win.webContents.send('pill:flipRequested', 'local');
                await sleep(1500);
                // Leave Local — the dead-last C2h idle stage takes it from here.
              }

              // (5e) C3 — PLUMBING & OFFLINE battery. Placed per order: immediately AFTER the
              // C2m stage and BEFORE the dead-last C2h idle stage. All controller probes here
              // are DEV-gated (DROPSYNC_CLOUD_DEV=1 — this battery's own boot gate). The
              // download seam arms under the same dev gate (see cloud.ts e2eSeamArmed).
              {
                type StatusSnap = Awaited<ReturnType<typeof cloudCtl.statusProbe>>;
                const statusSnap = (): Promise<StatusSnap> => cloudCtl!.statusProbe();
                /** Poll until cond() holds (or timeout) — the standard leg cadence. */
                const waitFor = async (cond: () => Promise<boolean>, timeoutMs: number, step = 50): Promise<boolean> => {
                  const t0 = Date.now();
                  for (;;) {
                    if (await cond()) return true;
                    if (Date.now() - t0 > timeoutMs) return false;
                    await sleep(step);
                  }
                };
                const cbW = (): number => win.getContentBounds().width;

                // ---- f_c3_doorman (STEP 3) — direct invocation of the registered handlers ----
                // PAC-2 FIX C — checkNotifications flipped to TRUE by the order (the
                // notifications gate opens, origin-gated like media); the media/geo truth is
                // byte-identical and still asserted. The full four-direction notifications
                // truth lives in f_pac2_notificationsAllowed.
                const door = await cloudCtl!.doormanProbe();
                const f_c3_doorman = door.mediaSite === true && door.mediaEvil === false
                  && door.geoSite === false
                  && door.checkMediaSite === true && door.checkMediaEvil === false
                  && door.checkNotifications === true;
                console.log('[c3-doorman]', JSON.stringify({
                  f_c3_doorman,
                  table: { request: { mediaSite: door.mediaSite, mediaEvil: door.mediaEvil, geoSite: door.geoSite }, check: { mediaSite: door.checkMediaSite, mediaEvil: door.checkMediaEvil, notifications: door.checkNotifications } },
                }));

                // ---- f_c3_chipBoundsZeroMiss (idle half) + f_c3_chipDownloadFlow (STEP 2) ----
                const idleSnap = await statusSnap();
                const chipIdleZeroMiss = idleSnap.attached && !idleSnap.showing && idleSnap.collapsed;

                const dlSession = session.fromPartition('persist:cloud'); // the site partition (cloud.ts PARTITION)
                // Run 1 lesson (2026-08-29): session.downloadURL on a data: URL creates the
                // DownloadItem but it NEVER progresses (no 'updated', no 'done', no bytes) —
                // the battery needs a REAL http URL. The dev server serves any project file
                // via /@fs; typescript.js (9.1 MB) gives real multi-tick progress + a real
                // completion, without a native dialog (the e2e seam auto-answers).
                // Main is ESM ("type": "module") — __dirname does not exist at runtime here;
                // the file's own idiom is fileURLToPath(new URL('.', import.meta.url)).
                const dlFile = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'node_modules', 'typescript', 'lib', 'typescript.js');
                const dlUrl = `${String(process.env.ELECTRON_RENDERER_URL ?? '')}/@fs${encodeURI(dlFile)}`;
                const chipUpExact = async (): Promise<{ up: boolean; snap: StatusSnap | null }> => {
                  let snap: StatusSnap | null = null;
                  const appeared = await waitFor(async () => {
                    const p = await statusSnap();
                    if (p.showing && !p.veilUp && p.bounds.width > 0 && p.bounds.y === STATUS_TOP) { snap = p; return true; }
                    return false;
                  }, 4000);
                  if (!appeared) return { up: false, snap: null };
                  // The measured-width room: main snaps to the page's measure within a beat.
                  let exact: StatusSnap | null = null;
                  const exactHit = await waitFor(async () => {
                    const p = await statusSnap();
                    if (p.lastMeasure > 0 && p.bounds.width === p.lastMeasure
                      && p.bounds.height === STATUS_H
                      && Math.abs(p.bounds.x - Math.round((cbW() - p.bounds.width) / 2)) <= 1) { exact = p; return true; }
                    return false;
                  }, 2000);
                  return { up: exactHit, snap: exact ?? snap };
                };

                // LEG 1 — the flow: chip up (measured footprint) → progress lands → done
                // flash → collapse to 0×0 → the saved file exists on disk.
                cloudCtl!.downloadTestArm(false);
                dlSession.downloadURL(dlUrl);
                const flow = await chipUpExact();
                let flowProgressLanded = false;
                if (flow.up) {
                  flowProgressLanded = await waitFor(async () => (await statusSnap()).lastProgress !== null, 3000);
                }
                const flowSettled = flow.up
                  ? await waitFor(async () => {
                    const p = await statusSnap();
                    return !p.showing && p.collapsed;
                  }, 12000)
                  : false;
                const flowSnap = await statusSnap();
                const flowFlash = flowSnap.lastHideFlash === '✓ Saved';
                const flowFileExists = flowSnap.lastSavePath !== null && existsSync(flowSnap.lastSavePath);
                if (flowSnap.lastSavePath !== null) {
                  try {
                    rmSync(flowSnap.lastSavePath, { force: true }); // keep /tmp clean (9 MB/run)
                  } catch { /* best-effort cleanup */ }
                }

                // LEG 2 — cancel mid-flight (held download): item cancelled AND the partial
                // file is ABSENT on disk AND the chip is gone.
                cloudCtl!.downloadTestArm(true); // hold: the next item pauses right after its save path
                dlSession.downloadURL(dlUrl);
                const cancelUp = await chipUpExact();
                const cancelPath = (await statusSnap()).lastSavePath;
                let cancelGone = false;
                if (cancelUp.up) {
                  await cloudCtl!.statusDrive('cancel'); // the REAL button → status:action ipc
                  cancelGone = await waitFor(async () => {
                    const p = await statusSnap();
                    return !p.showing && p.collapsed;
                  }, 6000);
                }
                cloudCtl!.downloadTestArm(false);
                const cancelFileAbsent = cancelPath !== null && !existsSync(cancelPath);

                // LEG 3 — a download outlives a mode flip (D2): hold a download, flip the
                // world BOTH ways (programmatic main-side — melts never fire), chip persists.
                cloudCtl!.downloadTestArm(true);
                dlSession.downloadURL(dlUrl);
                const persistUp = await chipUpExact();
                let chipPersists = false;
                if (persistUp.up) {
                  await applyCloudMode('cloud');
                  await sleep(200);
                  const overCloud = await statusSnap();
                  await applyCloudMode('local');
                  await sleep(200);
                  const overLocal = await statusSnap();
                  chipPersists = overCloud.showing && !overCloud.collapsed && overLocal.showing && !overLocal.collapsed;
                  await cloudCtl!.statusDrive('cancel'); // clean up the held download
                  await waitFor(async () => {
                    const p = await statusSnap();
                    return !p.showing && p.collapsed;
                  }, 6000);
                }
                cloudCtl!.downloadTestArm(false);

                const f_c3_chipDownloadFlow = flow.up && flowProgressLanded && flowSettled && flowFlash
                  && cancelUp.up && cancelGone && cancelFileAbsent;
                const f_c3_chipBoundsZeroMiss = chipIdleZeroMiss && flow.up && chipPersists;
                console.log('[c3-chip]', JSON.stringify({
                  f_c3_chipDownloadFlow,
                  f_c3_chipBoundsZeroMiss,
                  matrix: {
                    chipIdleZeroMiss, flowUpMeasured: flow.up, flowProgressLanded, flowSettled,
                    flowFlash, flowFileExists, cancelUp: cancelUp.up, cancelGone, cancelFileAbsent,
                    chipPersists,
                  },
                  raw: {
                    flowBounds: flow.snap?.bounds ?? null, flowMeasure: flow.snap?.lastMeasure ?? 0,
                    flowFractions: flowSnap.lastProgress, flowSavePath: flowSnap.lastSavePath,
                    cancelPath, idleRaw: idleSnap,
                  },
                }));

                // ---- f_c3_offlineStates (STEP 4) — entry / recovery / degraded / mode-clear ----
                // Align BOTH sides on cloud through the REAL relay (un-armed ⇒ instant).
                win.webContents.send('pill:flipRequested', 'cloud');
                await sleep(1500);

                // ENTRY leg — forced main-frame failure while offline ⇒ veil (theme attr set,
                // full-window room); reconnect ⇒ auto-reload (spy) + veil down.
                cloudCtl!.setNetOverride(false);
                cloudCtl!.onSiteLoadFailed(-106, true, CLOUD_URL);
                const veilUp = await waitFor(async () => {
                  const p = await statusSnap();
                  return p.veilUp && p.showing
                    && p.bounds.x === 0 && p.bounds.y === 0
                    && Math.abs(p.bounds.width - win.getContentBounds().width) <= 2
                    && Math.abs(p.bounds.height - win.getContentBounds().height) <= 2;
                }, 3000);
                const veilTheme = await cloudCtl!.statusEval<string>('document.documentElement.dataset.statusTheme || ""');
                const themeOk = ['light', 'dark', 'minimal'].includes(veilTheme);
                cloudCtl!.setNetOverride(true);
                const reloadsBefore = (await statusSnap()).reloadCount;
                const veilCleared = await waitFor(async () => {
                  const p = await statusSnap();
                  return p.reloadCount > reloadsBefore && !p.veilUp && !p.showing && p.collapsed;
                }, 8000);

                // DEGRADED leg — net drops WHILE cloud is shown ⇒ pulse chip (no reload, D6);
                // reconnect ⇒ "✓ Back online" flash, then the chip collapses.
                cloudCtl!.setNetOverride(false);
                const degradedUp = await waitFor(async () => {
                  const p = await statusSnap();
                  return p.showing && !p.veilUp && p.bounds.width > 0
                    && (p.lastShow as { label?: string } | null)?.label === 'Waiting for internet…'
                    && (p.lastShow as { pulse?: boolean } | null)?.pulse === true
                    && (p.lastShow as { action?: string } | null)?.action === 'switch-local';
                }, 6000);
                const degradedReloaded = (await statusSnap()).reloadCount; // must NOT change mid-degraded
                cloudCtl!.setNetOverride(true);
                const backOnline = await waitFor(async () => {
                  const p = await statusSnap();
                  return p.lastHideFlash === '✓ Back online' && !p.showing && p.collapsed;
                }, 9000);
                const degradedNoReload = (await statusSnap()).reloadCount === degradedReloaded;

                // C3-hotfix-1 — f_c3_veilRetrySuccess (THE leg the C3 order lacked): entry-
                // failed ⇒ the REAL [Try again] button ⇒ reload fires AND the veil LIFTS
                // (offlineState 'ok'). Driven while the net override is still FALSE so the
                // 2 s auto-recovery poll (requires `online`) can never race the manual
                // button — the reload itself succeeds on the real net; FIX A does the lift.
                cloudCtl!.setNetOverride(false);
                cloudCtl!.onSiteLoadFailed(-106, true, CLOUD_URL);
                const rv2Up = await waitFor(async () => {
                  const p = await statusSnap();
                  return p.veilUp && p.offlineState === 'entry-failed';
                }, 3000);
                const retryReloadsBefore = (await statusSnap()).reloadCount;
                await cloudCtl!.statusDrive('retry'); // the REAL button → status:action ipc
                const retryReloaded = await waitFor(async () =>
                  (await statusSnap()).reloadCount > retryReloadsBefore, 3000);
                const retryDelta = (await statusSnap()).reloadCount - retryReloadsBefore;
                // The lift detector is TWO-BRANCH by design: with the net override held
                // FALSE (blocking the auto-recovery from racing the manual button), the poll
                // can legitimately fire a degraded chip right after the lift (state ok +
                // veil gone + shown + flag claims offline). That chip PROVES the lift: with
                // the override false, the only ok-transition is the retry's own success lift
                // (entry-failed ⇒ ok is otherwise unreachable). Branch 1 catches the brief
                // ok+collapsed window; branch 2 catches the chip that follows it.
                const retryLifted = await waitFor(async () => {
                  const p = await statusSnap();
                  if (!p.showing && p.collapsed && p.siteLoadOk) return true;
                  if (p.showing && !p.veilUp && p.siteLoadOk
                    && (p.lastShow as { label?: string } | null)?.label === 'Waiting for internet…') return true;
                  return false;
                }, 8000);
                cloudCtl!.setNetOverride(null); // real net is up ⇒ identical to override true
                const f_c3_veilRetrySuccess = rv2Up && retryReloaded && retryDelta === 1 && retryLifted;
                console.log('[c3-veilretry]', JSON.stringify({
                  f_c3_veilRetrySuccess,
                  matrix: { rv2Up, retryReloaded, retryDelta, retryLifted },
                  raw: { retryReloadsBefore },
                }));

                // C3-hotfix-3 — f_c3_recoveryKeepsCardUntilSuccess (THE OWNER'S MOVE):
                // entry-failed ⇒ Wi-Fi back on ⇒ the poll tick fires auto-recovery ⇒ the veil
                // must SWAP to the Connecting presentation (never collapse) and stay up
                // through the whole reload window; success is the only exit. White-forever
                // detector: NO card showing while the page has still never succeeded.
                cloudCtl!.setNetOverride(false);
                cloudCtl!.onSiteLoadFailed(-106, true, CLOUD_URL);
                const rkUp = await waitFor(async () => {
                  const p = await statusSnap();
                  return p.veilUp && p.offlineState === 'entry-failed';
                }, 3000);
                const rkBefore = (await statusSnap()).reloadCount;
                cloudCtl!.setNetOverride(true); // the poll tick fires the recovery
                let rkSwapSeen = false;
                let rkWhiteForever = false;
                let rkLifted = false;
                const rkT0 = Date.now();
                while (Date.now() - rkT0 < 9000 && !rkLifted) {
                  const p = await statusSnap();
                  const rkTitle = (p.lastShow as { title?: string } | null)?.title ?? '';
                  if (p.reloadCount > rkBefore && p.veilUp && rkTitle === 'Connecting to Cloud…') rkSwapSeen = true;
                  if (p.reloadCount > rkBefore && !p.showing && p.collapsed && !p.siteLoadOk) rkWhiteForever = true;
                  if (!p.showing && p.collapsed && p.siteLoadOk && rkSwapSeen) rkLifted = true;
                  await sleep(100);
                }
                cloudCtl!.setNetOverride(null);
                const f_c3_recoveryKeepsCardUntilSuccess = rkUp && rkSwapSeen && !rkWhiteForever && rkLifted;
                console.log('[c3-recovery]', JSON.stringify({
                  f_c3_recoveryKeepsCardUntilSuccess,
                  matrix: { rkUp, rkSwapSeen, rkWhiteForever, rkLifted },
                  raw: { rkBefore },
                }));

                // C3-hotfix-3 — f_c3_flapNeverDowngradesVeil: with the entry-failed veil up, a
                // net-flag bounce (true→false→true) must never downgrade it — no degraded
                // chip, no "✓ Back online" flash while the veil lineage is live. (A chip
                // AFTER a legitimate lift would be a true mid-cloud degraded and is NOT
                // counted — the assertion is scoped to the veil lineage.)
                cloudCtl!.setNetOverride(false);
                cloudCtl!.onSiteLoadFailed(-106, true, CLOUD_URL);
                const flUp = await waitFor(async () => {
                  const p = await statusSnap();
                  return p.veilUp && p.offlineState === 'entry-failed';
                }, 3000);
                const flBefore = (await statusSnap()).reloadCount;
                cloudCtl!.setNetOverride(true); // recovery fires at the next tick
                const flSwap = await waitFor(async () => {
                  const p = await statusSnap();
                  return p.reloadCount > flBefore && p.veilUp
                    && ((p.lastShow as { title?: string } | null)?.title === 'Connecting to Cloud…');
                }, 4000);
                cloudCtl!.setNetOverride(false); // FLAP down mid-recovery — must not downgrade
                let flDegradedSeen = false;
                const flT0 = Date.now();
                while (Date.now() - flT0 < 2500) { // ≥1 poll tick guaranteed inside the window
                  const p = await statusSnap();
                  const flLabel = (p.lastShow as { label?: string } | null)?.label ?? '';
                  const veilLineage = p.veilUp || p.connectingUp || p.offlineState === 'entry-failed';
                  if (veilLineage && flLabel === 'Waiting for internet…') flDegradedSeen = true;
                  await sleep(100);
                }
                cloudCtl!.setNetOverride(true); // flap back up — the reload (real net) completes ⇒ success lift
                const flLifted = await waitFor(async () => {
                  const p = await statusSnap();
                  return !p.showing && p.collapsed && p.siteLoadOk;
                }, 9000);
                cloudCtl!.setNetOverride(null);
                const f_c3_flapNeverDowngradesVeil = flUp && flSwap && !flDegradedSeen && flLifted;
                console.log('[c3-flap]', JSON.stringify({
                  f_c3_flapNeverDowngradesVeil,
                  matrix: { flUp, flSwap, flDegradedSeen, flLifted },
                  raw: { flBefore },
                }));

                // MODE-CLEAR leg — veil up ⇒ [Switch to Local] rides the REAL user-flip path
                // (arm + melt attempt; the D7 deadline keeps a live capture fast) ⇒ mode local
                // AND every offline state cleared.
                cloudCtl!.setNetOverride(false);
                cloudCtl!.onSiteLoadFailed(-106, true, CLOUD_URL);
                const veil2Up = await waitFor(async () => (await statusSnap()).veilUp, 3000);
                await cloudCtl!.statusDrive('switch-local');
                const modeCleared = await waitFor(async () => appMode === 'local', 3500, 25);
                const veilGoneAfterFlip = await waitFor(async () => {
                  const p = await statusSnap();
                  return !p.veilUp && !p.showing && p.collapsed;
                }, 3000);
                cloudCtl!.setNetOverride(null);

                const f_c3_offlineStates = veilUp && themeOk && veilCleared
                  && degradedUp && degradedNoReload && backOnline
                  && veil2Up && modeCleared && veilGoneAfterFlip;
                console.log('[c3-offline]', JSON.stringify({
                  f_c3_offlineStates,
                  matrix: {
                    veilUp, themeOk, veilTheme, veilCleared,
                    degradedUp, degradedNoReload, backOnline,
                    veil2Up, modeCleared, veilGoneAfterFlip,
                  },
                  raw: { reloadsBefore },
                }));
                transitionArmedAt = 0; // hygiene: the switch-local flip legitimately armed; clear it

                // ---- f_c3_flipFromDeadCloud (STEP 5 / §2.4) — THE OWNER'S BUG, PINNED ----
                // Back to cloud through the REAL relay — with the (5)-stage DESYNC INSURANCE:
                // a relay landing while the renderer's previous guarded switch is still
                // settling can be DROPPED (documented C2m-hotfix-2 artifact — run 3 hit it:
                // the switch-local flip's melt widened the window), so poll BOTH sides and
                // re-send. Battery-only harness discipline; the product path is untouched.
                let cloudReady = false;
                for (let attempt = 0; attempt < 3 && !cloudReady; attempt++) {
                  win.webContents.send('pill:flipRequested', 'cloud');
                  cloudReady = await waitFor(async () =>
                    (await readModeSafe()) === 'cloud' && appMode === 'cloud', 2500, 50);
                }

                // C3-hotfix-2 — f_c3_connectingSurvivesSubframeNoise: during a hanging fresh
                // load, a SUBFRAME failure (the real site's helper-frame noise — Firebase
                // auth iframes, analytics) must NOT silence the connecting backstop. The
                // real shared failure path is invoked with isMainFrame=false ~1 s in; the
                // Connecting veil MUST still appear at ~3 s (offlineState still 'ok').
                void cloudCtl!.siteDriveNavigate('https://192.0.2.1/').catch(() => undefined);
                await sleep(1000);
                cloudCtl!.onSiteLoadFailed(-3, false, CLOUD_URL); // sub-frame noise mid-hang
                const subNoiseVeil = await waitFor(async () => {
                  const p = await statusSnap();
                  return p.connectingUp && p.veilUp && p.showing && p.offlineState === 'ok'
                    && p.bounds.x === 0 && p.bounds.y === 0
                    && Math.abs(p.bounds.width - win.getContentBounds().width) <= 2
                    && Math.abs(p.bounds.height - win.getContentBounds().height) <= 2;
                }, 3500);
                void cloudCtl!.siteDriveNavigate(CLOUD_URL).catch(() => undefined);
                const subNoiseLifted = await waitFor(async () => {
                  const p = await statusSnap();
                  return !p.connectingUp && !p.veilUp && !p.showing && p.collapsed && p.offlineState === 'ok';
                }, 8000);
                const f_c3_connectingSurvivesSubframeNoise = subNoiseVeil && subNoiseLifted;
                console.log('[c3-subframe]', JSON.stringify({
                  f_c3_connectingSurvivesSubframeNoise,
                  matrix: { subNoiseVeil, subNoiseLifted },
                  raw: { noiseAtMs: 1000, noiseCode: -3, noiseIsMainFrame: false, timeoutMs: ENTRY_CONNECT_TIMEOUT_MS },
                }));

                // C3-hotfix-1 — connecting leg (FIX B): a fresh load that hangs (TEST-NET-1,
                // no fast did-fail-load and the WSL net-flag backstop can't fire) must show
                // the CONNECTING veil within ~3 s (≤3.5 s assert) instead of 5–6 s of white.
                // offlineState stays 'ok' beneath it (the net has NOT failed — honest card).
                // Restore ⇒ did-finish-load ⇒ FIX A lifts. Runs BEFORE the dead-flip leg
                // (which re-navigates to the same dead URL and is otherwise untouched).
                void cloudCtl!.siteDriveNavigate('https://192.0.2.1/').catch(() => undefined);
                const connUp = await waitFor(async () => {
                  const p = await statusSnap();
                  return p.connectingUp && p.veilUp && p.showing && p.offlineState === 'ok'
                    && p.bounds.x === 0 && p.bounds.y === 0
                    && Math.abs(p.bounds.width - win.getContentBounds().width) <= 2
                    && Math.abs(p.bounds.height - win.getContentBounds().height) <= 2;
                }, 3500);
                const connTheme = await cloudCtl!.statusEval<string>('document.documentElement.dataset.statusTheme || ""');
                const connThemeOk = ['light', 'dark', 'minimal'].includes(connTheme);
                void cloudCtl!.siteDriveNavigate(CLOUD_URL).catch(() => undefined);
                const connLifted = await waitFor(async () => {
                  const p = await statusSnap();
                  return !p.connectingUp && !p.veilUp && !p.showing && p.collapsed && p.offlineState === 'ok';
                }, 8000);
                const f_c3_connectingVeil = connUp && connThemeOk && connLifted;
                console.log('[c3-connecting]', JSON.stringify({
                  f_c3_connectingVeil,
                  matrix: { connUp, connTheme, connThemeOk, connLifted },
                  raw: { timeoutMs: ENTRY_CONNECT_TIMEOUT_MS },
                }));

                // Point the site view at TEST-NET-1 (hangs forever). Battery-only navigation
                // of the site view — ordered by the C3 order §4 STEP 6 (I1 stays absolute
                // outside this DEV leg).
                void cloudCtl!.siteDriveNavigate('https://192.0.2.1/').catch(() => undefined);
                await sleep(600); // the view is now a dead page (white void — owner's screenshot)
                const deadOutgoing = appMode; // 'cloud'
                transitionArmedAt = Date.now(); // the pill:flip handler's exact arm write
                const deadT0 = Date.now();
                win.webContents.send('pill:flipRequested', 'local');
                const deadApplied = await waitFor(async () => appMode === 'local', 4000, 25);
                const deadFlipMs = Date.now() - deadT0;
                void cloudCtl!.siteDriveNavigate(CLOUD_URL).catch(() => undefined); // restore
                const f_c3_flipFromDeadCloud = deadOutgoing === 'cloud' && deadApplied && deadFlipMs < 1500;
                console.log('[c3-deadflip]', JSON.stringify({
                  f_c3_flipFromDeadCloud,
                  matrix: { firstClickThrough: deadApplied, underDeadline: deadFlipMs < 1500 },
                  raw: { deadOutgoing, deadFlipMs, captureDeadlineMs: CAPTURE_DEADLINE_MS },
                }));

                // C3-hotfix-2 — f_c3_deadReentryRetries: THE OWNER'S BRICK. State after the
                // dead-flip leg: appMode local, the site view a dead TEST-NET-1 page (its
                // load never succeeded). Flip back to Cloud must RETRY (show() reloads +
                // re-arms ⇒ Connecting card), not sit white forever. The re-entry reload
                // targets CLOUD_URL, which the real net would load fine — this leg cannot
                // turn Wi-Fi off, so a battery-only webRequest redirect (site origin →
                // TEST-NET-1, registered here and REMOVED before the restore) makes the
                // re-entry load hang exactly the way a real offline CLOUD_URL load hangs.
                // Never registered outside this DEV leg.
                void cloudCtl!.siteDriveNavigate('https://192.0.2.1/').catch(() => undefined); // re-dead the view (siteLoadOk=false)
                await sleep(400);
                const deBefore = (await statusSnap()).siteLoadCount;
                let deLocal = false; // the Local hop (both sides are already local here — the relay no-ops; kept for flow fidelity)
                for (let attempt = 0; attempt < 3 && !deLocal; attempt++) {
                  win.webContents.send('pill:flipRequested', 'local');
                  deLocal = await waitFor(async () =>
                    (await readModeSafe()) === 'local' && appMode === 'local', 2500, 50);
                }
                const cloudSes = session.fromPartition('persist:cloud');
                const deadFilter = { urls: [CLOUD_URL + '/*'] };
                cloudSes.webRequest.onBeforeRequest(deadFilter, (_details, cb) => { cb({ redirectURL: 'https://192.0.2.1/' }); });
                let deCloud = false;
                for (let attempt = 0; attempt < 3 && !deCloud; attempt++) {
                  win.webContents.send('pill:flipRequested', 'cloud');
                  deCloud = await waitFor(async () =>
                    (await readModeSafe()) === 'cloud' && appMode === 'cloud', 2500, 50);
                }
                const deRetried = (await statusSnap()).siteLoadCount > deBefore; // show() reloaded
                const deVeil = await waitFor(async () => {
                  const p = await statusSnap();
                  return p.connectingUp && p.veilUp && p.showing && p.offlineState === 'ok'
                    && p.bounds.x === 0 && p.bounds.y === 0
                    && Math.abs(p.bounds.width - win.getContentBounds().width) <= 2
                    && Math.abs(p.bounds.height - win.getContentBounds().height) <= 2;
                }, 3500);
                cloudSes.webRequest.onBeforeRequest(deadFilter, null); // unpoison
                void cloudCtl!.siteDriveNavigate(CLOUD_URL).catch(() => undefined);
                const deLifted = await waitFor(async () => {
                  const p = await statusSnap();
                  return !p.connectingUp && !p.veilUp && !p.showing && p.collapsed && p.offlineState === 'ok';
                }, 8000);
                const f_c3_deadReentryRetries = deLocal && deCloud && deRetried && deVeil && deLifted;
                console.log('[c3-deadreentry]', JSON.stringify({
                  f_c3_deadReentryRetries,
                  matrix: { deLocal, deCloud, deRetried, deVeil, deLifted },
                  raw: { deBefore },
                }));

                // C3-hotfix-2 — warm-entry guard: with a HEALTHY site (the restore above just
                // loaded it — siteLoadOk true), local → cloud must NOT reload (C2i warmth,
                // preserved by FIX B's !siteLoadOk gate).
                const warmBefore = (await statusSnap()).siteLoadCount;
                let warmLocal = false;
                for (let attempt = 0; attempt < 3 && !warmLocal; attempt++) {
                  win.webContents.send('pill:flipRequested', 'local');
                  warmLocal = await waitFor(async () =>
                    (await readModeSafe()) === 'local' && appMode === 'local', 2500, 50);
                }
                let warmCloud = false;
                for (let attempt = 0; attempt < 3 && !warmCloud; attempt++) {
                  win.webContents.send('pill:flipRequested', 'cloud');
                  warmCloud = await waitFor(async () =>
                    (await readModeSafe()) === 'cloud' && appMode === 'cloud', 2500, 50);
                }
                await sleep(300); // a (wrong) reload would land within this window
                const warmSnap = await statusSnap();
                const f_c3_warmEntryNoReload = warmLocal && warmCloud
                  && warmSnap.siteLoadCount === warmBefore && !warmSnap.connectingUp;
                console.log('[c3-warmentry]', JSON.stringify({
                  f_c3_warmEntryNoReload,
                  matrix: { warmLocal, warmCloud, warmBefore, warmAfter: warmSnap.siteLoadCount, connectingUp: warmSnap.connectingUp },
                }));

                // C3-hotfix-3 — f_c3_deadPageAlwaysCards: a main-frame failure of a
                // NEVER-succeeded page gets the card whatever the code or net flag. Fresh
                // hang ⇒ force an UNLISTED code (-2) with the net flag reading TRUE (the old
                // condition: silence ⇒ white forever) ⇒ the offline card MUST appear;
                // restore ⇒ success lifts it.
                void cloudCtl!.siteDriveNavigate('https://192.0.2.1/').catch(() => undefined);
                await sleep(300);
                cloudCtl!.onSiteLoadFailed(-2, true, CLOUD_URL); // unlisted code + net flag true
                const dpCard = await waitFor(async () => {
                  const p = await statusSnap();
                  return p.veilUp && p.offlineState === 'entry-failed'
                    && (p.lastShow as { title?: string } | null)?.title === 'No internet — Cloud mode needs it';
                }, 3000);
                void cloudCtl!.siteDriveNavigate(CLOUD_URL).catch(() => undefined);
                const dpLifted = await waitFor(async () => {
                  const p = await statusSnap();
                  return !p.showing && p.collapsed && p.siteLoadOk;
                }, 8000);
                const f_c3_deadPageAlwaysCards = dpCard && dpLifted;
                console.log('[c3-deadpage]', JSON.stringify({
                  f_c3_deadPageAlwaysCards,
                  matrix: { dpCard, dpLifted },
                  raw: { forcedCode: -2, forcedIsMainFrame: true },
                }));

                // C3-hotfix-4 — f_c3_phantomFinishVetoed (THE KILLER). Chromium LIES: after a
                // failed main-frame load the view holds the internal ERROR document
                // (chrome-error://chromewebdata/, empty body — the c3autopsy probe) and a
                // did-finish-load fires FOR IT ~5 ms after the failure (navtruth.js). The
                // veto: a finish is only a success if NOTHING failed on the way. Fresh dead
                // attempt ⇒ forced main-frame -105 ⇒ offline card + stamp ⇒ forced success
                // (the phantom, via the REAL handler seam) ⇒ MUST be vetoed: no siteLoadOk,
                // state stays entry-failed, veil stays up.
                void cloudCtl!.siteDriveNavigate('https://192.0.2.1/').catch(() => undefined); // fresh attempt (resets the stamp)
                await sleep(300);
                cloudCtl!.onSiteLoadFailed(-105, true, CLOUD_URL); // main-frame verdict stamps the attempt
                const phCard = await waitFor(async () => {
                  const p = await statusSnap();
                  return p.veilUp && p.offlineState === 'entry-failed' && p.attemptFailed === true;
                }, 3000);
                cloudCtl!.onSiteLoadSucceeded(); // the ERROR document's phantom finish
                await sleep(120); // any (wrong) lift/settle would land within this window
                const phSnap = await statusSnap();
                const f_c3_phantomFinishVetoed = phCard
                  && phSnap.siteLoadOk === false
                  && phSnap.offlineState === 'entry-failed'
                  && phSnap.phantomFinishes === 1
                  && phSnap.veilUp === true;
                console.log('[c3-phantom]', JSON.stringify({
                  f_c3_phantomFinishVetoed,
                  matrix: { phCard },
                  raw: {
                    siteLoadOk: phSnap.siteLoadOk, offlineState: phSnap.offlineState,
                    phantomFinishes: phSnap.phantomFinishes, veilUp: phSnap.veilUp,
                    attemptFailed: phSnap.attemptFailed,
                  },
                }));

                // C3-hotfix-4 — f_c3_realRecoveryAfterVeto: the veto must never become a NEW
                // brick. Continue the EXACT phantom state: the real [Try again] button
                // (statusDrive rides the real ipc path) starts a fresh attempt (resetting the
                // stamp) and loads the true CLOUD_URL ⇒ a GENUINE finish is BELIEVED ⇒
                // siteLoadOk true, state 'ok', veil lifted.
                await cloudCtl!.statusDrive('retry');
                const rvOk = await waitFor(async () => {
                  const p = await statusSnap();
                  return !p.showing && p.collapsed && p.siteLoadOk && !p.attemptFailed
                    && p.offlineState === 'ok' && p.phantomFinishes === 1;
                }, 12000);
                const f_c3_realRecoveryAfterVeto = rvOk;
                console.log('[c3-vetorecovery]', JSON.stringify({
                  f_c3_realRecoveryAfterVeto,
                  matrix: { rvOk },
                }));

                // C3-hotfix-4 — f_c3_subframeNeverStamps: sub-frame noise NEVER stamps the
                // attempt (the same !isMainFrame guard that protects the watchdog) and never
                // poisons a HEALTHY page — the site's next finish is still believed (not
                // counted as a phantom).
                cloudCtl!.onSiteLoadFailed(-3, false, CLOUD_URL); // sub-frame noise, healthy site
                const sfNoiseSnap = await statusSnap();
                cloudCtl!.onSiteLoadSucceeded(); // the site's genuine finish, after the noise
                await sleep(120);
                const sfSnap = await statusSnap();
                const f_c3_subframeNeverStamps = sfNoiseSnap.attemptFailed === false
                  && sfSnap.siteLoadOk === true && sfSnap.attemptFailed === false
                  && sfSnap.phantomFinishes === 1;
                console.log('[c3-subframe-stamp]', JSON.stringify({
                  f_c3_subframeNeverStamps,
                  matrix: { noiseStamped: sfNoiseSnap.attemptFailed },
                  raw: {
                    siteLoadOk: sfSnap.siteLoadOk, attemptFailed: sfSnap.attemptFailed,
                    phantomFinishes: sfSnap.phantomFinishes,
                  },
                }));

                // C3-hotfix-4 — f_c3_navResetReArmsSuccess (FIX B): a NEW main-frame
                // same-origin navigation re-arms success — the error document emits NO
                // navigation events (navtruth.js), so only a real load attempt (ours, or
                // Chromium's own connectivity-restore auto-reload) can clear the stamp.
                // Fired via the DEV seam, which calls the SAME navReArm the listener calls.
                cloudCtl!.onSiteLoadFailed(-105, true, CLOUD_URL); // stamp a fresh failure
                const nrStamped = (await statusSnap()).attemptFailed === true;
                cloudCtl!.siteNavReArm(CLOUD_URL, true); // the FIX B reset (listener logic)
                const nrReset = (await statusSnap()).attemptFailed === false;
                cloudCtl!.onSiteLoadSucceeded(); // a following success is BELIEVED again
                await sleep(120);
                const nrSnap = await statusSnap();
                const f_c3_navResetReArmsSuccess = nrStamped && nrReset
                  && nrSnap.siteLoadOk === true && nrSnap.phantomFinishes === 1
                  && nrSnap.offlineState === 'ok';
                console.log('[c3-navreset]', JSON.stringify({
                  f_c3_navResetReArmsSuccess,
                  matrix: { nrStamped, nrReset },
                  raw: {
                    siteLoadOk: nrSnap.siteLoadOk, offlineState: nrSnap.offlineState,
                    phantomFinishes: nrSnap.phantomFinishes,
                  },
                }));

                // C3-hotfix-5 — THE HIDDEN LEGS (the owner's repro: flip to Local WHILE the
                // load still hangs ⇒ the -105 fires AFTER the flip, while the site view is
                // HIDDEN). hf5 FIX A — the STAMP is truth (main-frame ALWAYS, hidden
                // included); only the VERDICT is UI (cloud-shown). phantomFinishes is a
                // RUNNING counter across the stage — these legs assert DELTAS. Relay flips
                // are programmatic (no transitionArmedAt stamp ⇒ instant, no melt —
                // consistent with systemFlipNeverMelts / f_c2m_flipDissolve).
                // f_c3_hiddenFailStillStamps (THE NEW KILLER): fresh hanging attempt → flip
                // to Local → the hidden main-frame -105 → the stamp MUST still land, with
                // NO verdict and NO card over Local (never veilUp/showing while hidden).
                void cloudCtl!.siteDriveNavigate('https://192.0.2.1/').catch(() => undefined); // fresh attempt (resets stamp/truth)
                await sleep(300); // the load hangs silently — flip out mid-flight (the owner's move)
                let hidLocal = false;
                for (let attempt = 0; attempt < 3 && !hidLocal; attempt++) {
                  win.webContents.send('pill:flipRequested', 'local');
                  hidLocal = await waitFor(async () =>
                    (await readModeSafe()) === 'local' && appMode === 'local', 2500, 50);
                }
                cloudCtl!.onSiteLoadFailed(-105, true, CLOUD_URL); // the HIDDEN -105 (fires after the flip)
                await sleep(120);
                const hidSnap = await statusSnap();
                const f_c3_hiddenFailStillStamps = hidLocal
                  && hidSnap.attemptFailed === true
                  && hidSnap.siteLoadOk === false
                  && hidSnap.offlineState === 'ok'
                  && hidSnap.veilUp === false && hidSnap.showing === false;
                console.log('[c3-hiddenfail]', JSON.stringify({
                  f_c3_hiddenFailStillStamps,
                  matrix: { hidLocal },
                  raw: {
                    attemptFailed: hidSnap.attemptFailed, siteLoadOk: hidSnap.siteLoadOk,
                    offlineState: hidSnap.offlineState, veilUp: hidSnap.veilUp,
                    showing: hidSnap.showing,
                  },
                }));

                // C3-hotfix-5 — f_c3_hiddenPhantomVetoed (continue the EXACT state): the
                // error document's phantom finish arrives while STILL hidden ⇒ the veto must
                // kill it here too (the lie must not be believed any more than while shown).
                const hpPfBefore = (await statusSnap()).phantomFinishes;
                cloudCtl!.onSiteLoadSucceeded(); // the phantom finish (hidden)
                await sleep(120);
                const hpSnap = await statusSnap();
                const f_c3_hiddenPhantomVetoed = hpSnap.siteLoadOk === false
                  && hpSnap.attemptFailed === true
                  && hpSnap.phantomFinishes === hpPfBefore + 1
                  && hpSnap.offlineState === 'ok'
                  && hpSnap.veilUp === false;
                console.log('[c3-hiddenphantom]', JSON.stringify({
                  f_c3_hiddenPhantomVetoed,
                  matrix: { hpPfBefore },
                  raw: {
                    siteLoadOk: hpSnap.siteLoadOk, attemptFailed: hpSnap.attemptFailed,
                    phantomFinishes: hpSnap.phantomFinishes, offlineState: hpSnap.offlineState,
                    veilUp: hpSnap.veilUp,
                  },
                }));

                // C3-hotfix-5 — f_c3_hiddenFailReentryRetries (the full heal, one leg): flip
                // back to Cloud ⇒ show() sees the HONEST !siteLoadOk and RETRIES (hf2's FIX B
                // finally firing on truthful bookkeeping — the owner's white-forever brick,
                // healed) ⇒ the fresh attempt resets the stamp ⇒ the real CLOUD_URL loads ⇒
                // lifted. Wi-Fi is ON in the dev env, so the retry load succeeds.
                const hrScBefore = (await statusSnap()).siteLoadCount;
                let hidCloud = false;
                for (let attempt = 0; attempt < 3 && !hidCloud; attempt++) {
                  win.webContents.send('pill:flipRequested', 'cloud');
                  hidCloud = await waitFor(async () =>
                    (await readModeSafe()) === 'cloud' && appMode === 'cloud', 2500, 50);
                }
                const hrRetried = await waitFor(async () => {
                  const p = await statusSnap();
                  return p.siteLoadCount > hrScBefore && p.attemptFailed === false;
                }, 3000);
                const hrLifted = await waitFor(async () => {
                  const p = await statusSnap();
                  return p.siteLoadOk === true && !p.showing && p.collapsed
                    && p.offlineState === 'ok';
                }, 8000);
                const f_c3_hiddenFailReentryRetries = hidCloud && hrRetried && hrLifted;
                console.log('[c3-hiddenreentry]', JSON.stringify({
                  f_c3_hiddenFailReentryRetries,
                  matrix: { hidCloud, hrRetried, hrLifted },
                  raw: { hrScBefore },
                }));

                // PACKAGING-1 — f_pac_frameFollowsTheme: the native shell follows the app
                // theme. Driven through the REAL settings IPC (renderer bridge →
                // vault:settingsSet → the FIX A seam), never manager.setSettings, so the exact
                // production route is proven. nativeTheme.shouldUseDarkColors is the
                // main-process truth Windows tints the frame from. No WSLg visual assert is
                // possible — the real title-bar color check is on the owner's Windows list.
                const pacPrevTheme = manager.getSettings().theme;
                await win.webContents.executeJavaScript('dropsync.vault.settingsSet({ theme: "dark" })');
                const pacDark = nativeTheme.shouldUseDarkColors === true && nativeTheme.themeSource === 'dark';
                await win.webContents.executeJavaScript('dropsync.vault.settingsSet({ theme: "light" })');
                const pacLight = nativeTheme.shouldUseDarkColors === false && nativeTheme.themeSource === 'light';
                // Restore through the SAME real IPC (the f_c2j leg's manager-level restore
                // cannot re-sync the shell) so settings AND themeSource both end at prevTheme.
                await win.webContents.executeJavaScript(
                  `dropsync.vault.settingsSet({ theme: ${JSON.stringify(pacPrevTheme)} })`
                );
                const f_pac_frameFollowsTheme = pacDark && pacLight;
                console.log('[pac-frame]', JSON.stringify({
                  f_pac_frameFollowsTheme,
                  matrix: { pacPrevTheme, pacDark, pacLight, restoredSource: nativeTheme.themeSource },
                }));

                // ==== PAC-2 — the four defect-fix leg families ==================================

                // f_pac2_menuRemoved — the default Electron menu is GONE (FIX A). menuNull
                // rides the battery's DEV probe print (the battery is IN main, so
                // Menu.getApplicationMenu() IS the probe surface).
                const menuNull = Menu.getApplicationMenu() === null;
                const f_pac2_menuRemoved = menuNull;
                console.log('[pac2-menu]', JSON.stringify({ f_pac2_menuRemoved, menuNull }));

                // f_pac2_notificationsAllowed — the doorman's notifications gate opens, all
                // four directions (FIX C); the media/geo keys stay asserted (carried doorman
                // truth must not drift while the allowlist grows).
                const door2 = await cloudCtl!.doormanProbe();
                const f_pac2_notificationsAllowed = door2.checkNotifications === true
                  && door2.notificationsSite === true && door2.notificationsEvil === false
                  && door2.notificationsEvilReq === false
                  && door2.mediaSite === true && door2.mediaEvil === false
                  && door2.geoSite === false && door2.checkMediaSite === true
                  && door2.checkMediaEvil === false;
                console.log('[pac2-notif]', JSON.stringify({ f_pac2_notificationsAllowed, door: door2 }));

                // f_106_clipboardAllowed — the clipboard gate opens (1.0.6 FIX A): a FRESH
                // probe; the four new clipboard keys must pass AND every carried doorman key
                // must read EXACTLY as before (the allowlist grew by ONE permission; no other
                // verdict may drift). (The probe const is `door106` — the f_c3_doorman leg
                // at :5076 already owns `door` in this scope.)
                const door106 = await cloudCtl!.doormanProbe();
                const f_106_clipboardAllowed = door106.clipboardSite === true
                  && door106.clipboardEvilReq === false
                  && door106.checkClipboardSite === true && door106.checkClipboardEvil === false
                  && door106.mediaSite === true && door106.mediaEvil === false && door106.geoSite === false
                  && door106.checkMediaSite === true && door106.checkMediaEvil === false
                  && door106.checkNotifications === true && door106.notificationsSite === true
                  && door106.notificationsEvil === false && door106.notificationsEvilReq === false;
                console.log('[f106-door]', JSON.stringify({ f_106_clipboardAllowed, door: door106 }));

                // f_106_localSaveChip — the Local ✓-Saved chip (1.0.6 FIX B/C): the controller
                // method is driven DIRECTLY and the layer is asserted through the REAL page
                // (statusEval DOM truth — element ids/classes per status.ts/status.html) plus
                // the main-side probe (statusSnap). Phases: saving (pulse dot, NO progress
                // track, NO button) → done (✓ Saved flash inside the 1.4 s window, collapse
                // after main's 1.8 s hold) → fail after a fresh saving (plain hide — NO flash
                // — then collapse). The layer is left collapsed at leg end. The REAL native
                // Save dialog cannot be driven headlessly (§6): this leg proves the chip
                // surface mapping; FIX C's call-site wiring is audit + owner hands-on.
                await waitFor(async () => {
                  const p = await statusSnap();
                  return !p.showing && p.collapsed;
                }, 4000);
                cloudCtl!.localSaveChip({ phase: 'saving', name: 'battery.txt' });
                const saveUp = await waitFor(async () => {
                  const p = await statusSnap();
                  return p.showing && !p.veilUp && p.bounds.width > 0 && p.bounds.y === STATUS_TOP;
                }, 4000);
                // The payload lands page-side a beat after the main-side show (ipc) — poll
                // the DOM itself so a stale read from a previous presentation can't pass.
                const saveDomT0 = Date.now();
                let saveDom: { msg: string; pulse: boolean; trackHidden: boolean; actHidden: boolean; chipShown: boolean } | null = null;
                for (;;) {
                  saveDom = await cloudCtl!.statusEval<{ msg: string; pulse: boolean; trackHidden: boolean; actHidden: boolean; chipShown: boolean }>(`({
                    msg: document.getElementById('msg').textContent,
                    pulse: document.getElementById('dot').classList.contains('pulse'),
                    trackHidden: document.getElementById('track').style.display === 'none',
                    actHidden: document.getElementById('act').style.display === 'none',
                    chipShown: document.getElementById('chip').classList.contains('showC'),
                  })`);
                  if (saveDom.msg === 'Saving battery.txt…' && saveDom.pulse
                    && saveDom.trackHidden && saveDom.actHidden && saveDom.chipShown) break;
                  if (Date.now() - saveDomT0 > 3000) break;
                  await sleep(50);
                }
                const savingDomOk = saveDom !== null && saveDom.msg === 'Saving battery.txt…'
                  && saveDom.pulse === true && saveDom.trackHidden === true
                  && saveDom.actHidden === true && saveDom.chipShown === true;
                const saveSnap = await statusSnap();
                const savingPayloadOk = saveSnap.lastShow !== null
                  && (saveSnap.lastShow as { label?: unknown }).label === 'Saving battery.txt…'
                  && (saveSnap.lastShow as { pulse?: unknown }).pulse === true
                  && (saveSnap.lastShow as { progress?: unknown }).progress === undefined
                  && (saveSnap.lastShow as { action?: unknown }).action === null;

                cloudCtl!.localSaveChip({ phase: 'done' });
                const doneT0 = Date.now();
                let flashDom: { text: string; shown: boolean } | null = null;
                for (;;) {
                  flashDom = await cloudCtl!.statusEval<{ text: string; shown: boolean }>(`({
                    text: document.getElementById('flash').textContent,
                    shown: document.getElementById('flash').classList.contains('showF'),
                  })`);
                  if (flashDom.shown && flashDom.text === '✓ Saved') break;
                  if (Date.now() - doneT0 > 1100) break; // stay INSIDE the ~1.4 s flash window
                  await sleep(50);
                }
                const doneSnap = await statusSnap();
                const flashPhaseOk = flashDom !== null && flashDom.shown === true
                  && flashDom.text === '✓ Saved' && doneSnap.lastHideFlash === '✓ Saved';
                await sleep(Math.max(0, 1900 - (Date.now() - doneT0))); // ≥ 1.9 s after the hide
                const doneSnap2 = await statusSnap();
                const doneCollapsed = !doneSnap2.showing && doneSnap2.collapsed;

                cloudCtl!.localSaveChip({ phase: 'saving', name: 'battery.txt' });
                await waitFor(async () => {
                  const p = await statusSnap();
                  return p.showing && !p.veilUp && p.bounds.width > 0;
                }, 4000);
                cloudCtl!.localSaveChip({ phase: 'fail' });
                const failT0 = Date.now();
                const failFlashDom = await cloudCtl!.statusEval<{ shown: boolean }>(
                  `({ shown: document.getElementById('flash').classList.contains('showF') })`);
                const failSnap = await statusSnap();
                await sleep(Math.max(0, 500 - (Date.now() - failT0))); // past the 280 ms hold
                const failSnap2 = await statusSnap();
                const failPhaseOk = failFlashDom.shown === false && failSnap.lastHideFlash === null
                  && !failSnap2.showing && failSnap2.collapsed;

                const f_106_localSaveChip = saveUp && savingDomOk && savingPayloadOk
                  && flashPhaseOk && doneCollapsed && failPhaseOk;
                console.log('[f106-chip]', JSON.stringify({
                  f_106_localSaveChip,
                  matrix: { saveUp, savingDomOk, savingPayloadOk, flashPhaseOk, doneCollapsed, failPhaseOk },
                  raw: { saveDom, doneHideFlash: doneSnap.lastHideFlash, flashDom, failHideFlash: failSnap.lastHideFlash, failFlashShown: failFlashDom.shown },
                }));

                // f_pac2_probeKnock — THE KNOCK (FIX D). All four legs drive the state machine
                // through SEAMS ONLY (netOverride / probe-override / the real forced-fail
                // handler) so the real WSL network's flaps (-106/-118 seen in run 1) cannot
                // race the asserts.
                cloudCtl!.setNetOverride(true);
                cloudCtl!.setReachProbeOverride(async () => 'dead');
                const knockScBefore = (await statusSnap()).reloadCount;
                const knockT0 = Date.now();
                // (A) THE KILLER: the flag claims online, the knock says dead twice ⇒ the
                //     EXACT degraded chip, no veil, NO reload — the flag lie is caught.
                let degradeAt = -1;
                const knockDegraded = await waitFor(async () => {
                  const p = await statusSnap();
                  if (p.offlineState === 'degraded' && degradeAt < 0) degradeAt = Date.now() - knockT0;
                  return p.offlineState === 'degraded';
                }, 16000, 100);
                const knockSnap = await statusSnap();
                const chipExact = JSON.stringify(knockSnap.lastShow) === JSON.stringify({
                  kind: 'offline', label: 'Waiting for internet…', pulse: true, action: 'switch-local',
                });
                const f_pac2_probeKnockA = knockDegraded && chipExact && knockSnap.veilUp === false
                  && knockSnap.reloadCount === knockScBefore && knockSnap.probeHealthy === false;
                // (B) recovery: the knock says alive ⇒ probeHealthy true ⇒ the degraded branch
                //     recovers ('✓ Back online', chip collapsed, still no reload). Sampled so
                //     a failure names the stuck link (probe verdict vs offlineTick recovery).
                cloudCtl!.setReachProbeOverride(async () => 'alive');
                const bTrace: Array<{ t: number; s: string; ph: boolean | null; pm: number; v: boolean }> = [];
                const knockRecovered = await waitFor(async () => {
                  const p = await statusSnap();
                  bTrace.push({ t: Date.now() - knockT0, s: p.offlineState, ph: p.probeHealthy, pm: p.probeMisses, v: p.veilUp });
                  return p.offlineState === 'ok';
                }, 20000, 500);
                const recSnap = await statusSnap();
                // The flash is a PRESENTATION: the ✓-chip stays up STATUS_FLASH_MS, THEN the
                // native footprint collapses — so the collapse is waited for, not snapshotted
                // (run-1/run-2 lesson: at recSnap time the chip is still flashing, not 0×0).
                const flashOk = recSnap.lastHideFlash === '✓ Back online';
                const collapsedAfterFlash = await waitFor(async () =>
                  (await statusSnap()).collapsed, 6000, 100);
                const f_pac2_probeKnockB = knockRecovered && flashOk && collapsedAfterFlash
                  && recSnap.reloadCount === knockScBefore;
                // (C) the flag-truth path unchanged: flag false ⇒ degraded via the EXISTING
                //     net-flag path (the knock says alive — the chip is the flag's verdict);
                //     flag back ⇒ the probe's alive re-opens recovery.
                cloudCtl!.setNetOverride(false);
                const flagDegraded = await waitFor(async () =>
                  (await statusSnap()).offlineState === 'degraded', 6000, 100);
                cloudCtl!.setNetOverride(null);
                const flagRecovered = await waitFor(async () =>
                  (await statusSnap()).offlineState === 'ok', 16000, 100);
                const f_pac2_probeKnockC = flagDegraded && flagRecovered;
                // (D) veil protection — deterministic: force the entry-failed veil (flag dead +
                //     the REAL forced -105 handler), hold it under the dead knock, then flip the
                //     flag ⇒ the C3 recovery reload owns the room (connectingUp true + veil up)
                //     and STILL nothing changes until the load itself lands.
                cloudCtl!.setReachProbeOverride(async () => 'dead');
                cloudCtl!.setNetOverride(false);
                cloudCtl!.onSiteLoadFailed(-105, true, CLOUD_URL); // the REAL handler ⇒ the veil
                await sleep(800);
                const dVeil = await statusSnap(); // entry-failed HELD under a dead knock
                cloudCtl!.setNetOverride(true); // flag up ⇒ the C3 auto-recovery (within 2 s)
                const dConnecting = await waitFor(async () =>
                  (await statusSnap()).connectingUp === true, 8000, 50);
                let dClean = true; // sample the connecting window: the probe must move NOTHING
                const dT0 = Date.now();
                while (Date.now() - dT0 < 2000) {
                  const p = await statusSnap();
                  if (p.offlineState === 'degraded' || p.probeHealthy === false) { dClean = false; break; }
                  if (p.offlineState === 'ok' && !p.connectingUp) break; // fast load lifted it — fine
                  await sleep(100);
                }
                const dConnSnap = await statusSnap();
                const f_pac2_probeKnockD = dVeil.offlineState === 'entry-failed'
                  && dVeil.probeHealthy !== false && dConnecting && dClean
                  && dConnSnap.offlineState !== 'degraded' && dConnSnap.probeHealthy !== false;
                // restore: the recovery reload was the REAL CLOUD_URL ⇒ the site heals itself;
                // the overrides die here so the picker legs run on truth.
                cloudCtl!.setReachProbeOverride(null);
                cloudCtl!.setNetOverride(null);
                const knockHealed = await waitFor(async () => {
                  const p = await statusSnap();
                  return p.siteLoadOk === true && p.offlineState === 'ok' && !p.showing;
                }, 20000, 100);
                const f_pac2_probeKnock = f_pac2_probeKnockA && f_pac2_probeKnockB
                  && f_pac2_probeKnockC && f_pac2_probeKnockD && knockHealed;
                console.log('[pac2-knock]', JSON.stringify({
                  f_pac2_probeKnock,
                  matrix: {
                    A: f_pac2_probeKnockA, B: f_pac2_probeKnockB, C: f_pac2_probeKnockC,
                    D: f_pac2_probeKnockD, knockHealed, chipExact,
                    degradeMs: degradeAt, dConnecting, dClean,
                    dVeilRaw: { s: dVeil.offlineState, ph: dVeil.probeHealthy },
                    dConnRaw: { s: dConnSnap.offlineState, c: dConnSnap.connectingUp, ph: dConnSnap.probeHealthy },
                    bTraceTail: bTrace.slice(-8),
                  },
                }));

                // f_pac2_sharePicker — OUR picker (FIX B).
                const spBase = cloudCtl!.shareProbe().settleCount;
                // (i) evil origin: no window ever, settled EXACTLY once, empty.
                await cloudCtl!.sharePickerTest({ securityOrigin: 'https://evil.example' });
                const spEvil = cloudCtl!.shareProbe();
                const f_pac2_shareEvil = spEvil.open === false && spEvil.settleCount === spBase + 1
                  && spEvil.lastVideoId === null && spEvil.lastVerdictAudio === undefined;
                // (ii) open: window visible + the page rendered EXACTLY sourcesSent cards.
                await cloudCtl!.sharePickerTest();
                const spOpened = await waitFor(async () => {
                  const p = cloudCtl!.shareProbe();
                  return p.open && p.sourcesSent > 0;
                }, 10000, 100);
                type PickerRenderProbe = { cards: number; screens: number; windows: number; empty: boolean; theme: string; audioRowOn: boolean };
                let pageRender: PickerRenderProbe | null = null;
                for (let i = 0; i < 24 && !pageRender; i++) {
                  await sleep(250);
                  // pickerEval returns the expression's value — a STRING (JSON.stringify);
                  // parse it before reading fields (the run-1 lesson: strings have no .cards).
                  const raw = await cloudCtl!.pickerEval<string>(
                    'JSON.stringify({ cards: document.querySelectorAll(".src").length,'
                    + ' screens: document.querySelectorAll("#screens .src").length,'
                    + ' windows: document.querySelectorAll("#windows .src").length,'
                    + ' empty: document.getElementById("empty").style.display !== "none",'
                    + ' theme: document.documentElement.getAttribute("data-picker-theme"),'
                    + ' audioRowOn: document.getElementById("audioRow").classList.contains("on") })'
                  );
                  const p = JSON.parse(raw) as PickerRenderProbe;
                  if (p.cards > 0) pageRender = p;
                }
                const spOpen = cloudCtl!.shareProbe();
                const renderExact = !!pageRender && pageRender.cards === spOpen.sourcesSent
                  && pageRender.screens + pageRender.windows === pageRender.cards
                  && pageRender.theme !== null && pageRender.audioRowOn === spOpen.canLoopback;
                // checkbox persistence (page contract): toggle ⇒ localStorage remembers.
                const persistRaw = await cloudCtl!.pickerEval<string>(
                  'JSON.stringify((function(){ var c = document.getElementById("audioChk");'
                  + ' c.checked = true; c.dispatchEvent(new Event("change"));'
                  + ' var v1 = localStorage.getItem("dropsync.picker.audio");'
                  + ' c.checked = false; c.dispatchEvent(new Event("change"));'
                  + ' var v2 = localStorage.getItem("dropsync.picker.audio");'
                  + ' return { v1: v1, v2: v2 }; })())'
                );
                const persist = JSON.parse(persistRaw) as { v1: string | null; v2: string | null };
                const audioPersist = persist.v1 === 'true' && persist.v2 === 'false';
                const f_pac2_shareOpen = spOpened && renderExact && spOpen.open && audioPersist;
                // (iii) pick: settled once, video id matches, verdict audio per the loopback
                // gate — first with the checkbox OFF, then with the relay carrying true.
                const firstId = await cloudCtl!.pickerEval<string | null>(
                  'var c = document.querySelector(".src"); c ? c.dataset.id : null'
                );
                cloudCtl!.sharePickerPick(String(firstId), false);
                const spPick = cloudCtl!.shareProbe();
                const f_pac2_sharePick = spPick.settleCount === spBase + 2
                  && spPick.lastVideoId === firstId && spPick.lastAudio === false
                  && spPick.lastVerdictAudio === undefined && spPick.open === false;
                await cloudCtl!.sharePickerTest(); // fresh request for the audio leg
                const spOpened2 = await waitFor(async () => cloudCtl!.shareProbe().open, 10000, 100);
                const firstId2 = await cloudCtl!.pickerEval<string | null>(
                  'var c = document.querySelector(".src"); c ? c.dataset.id : null'
                );
                cloudCtl!.sharePickerPick(String(firstId2), true);
                const spPick2 = cloudCtl!.shareProbe();
                // The verdict formula, evaluated with THIS platform's canLoopback: win32 ⇒
                // 'loopback'; elsewhere (this WSL battery) ⇒ undefined. The formula itself is
                // what the battery proves — the win32 sound outcome is the owner's hands-on.
                const loopbackExpected = spPick2.canLoopback ? 'loopback' as const : undefined;
                const f_pac2_shareAudio = spOpened2 && spPick2.settleCount === spBase + 3
                  && spPick2.lastAudio === true && spPick2.lastVerdictAudio === loopbackExpected;
                // (iv) cancel: settled EXACTLY once, empty, window gone.
                await cloudCtl!.sharePickerTest();
                const spOpened3 = await waitFor(async () => cloudCtl!.shareProbe().open, 10000, 100);
                cloudCtl!.sharePickerCancel();
                const spCancel = cloudCtl!.shareProbe();
                // (iv-b) settle-once insurance — a LATE duplicate cancel (double-Esc / cancel
                // racing the window's own close) must NOT settle again: the count holds at
                // base+4. This is the exact path the RED pair drives (the guard removed
                // ⇒ +5 ⇒ key false); with the guard the duplicate is a loud no-op.
                cloudCtl!.sharePickerCancel();
                const spCancel2 = cloudCtl!.shareProbe();
                const f_pac2_shareCancel = spOpened3 && spCancel.settleCount === spBase + 4
                  && spCancel.lastVideoId === null && spCancel.open === false
                  && spCancel2.settleCount === spBase + 4;
                const f_pac2_sharePicker = f_pac2_shareEvil && f_pac2_shareOpen
                  && f_pac2_sharePick && f_pac2_shareAudio && f_pac2_shareCancel;
                console.log('[pac2-picker]', JSON.stringify({
                  f_pac2_sharePicker,
                  matrix: {
                    evil: f_pac2_shareEvil, open: f_pac2_shareOpen, pick: f_pac2_sharePick,
                    audio: f_pac2_shareAudio, cancel: f_pac2_shareCancel, audioPersist,
                  },
                  raw: {
                    spBase, pageRender, persist,
                    evil: spEvil, openProbe: { sourcesSent: spOpen.sourcesSent, canLoopback: spOpen.canLoopback },
                    pick: { video: spPick.lastVideoId, verdict: spPick.lastVerdictAudio ?? null },
                    pick2: { audio: spPick2.lastAudio, verdict: spPick2.lastVerdictAudio ?? null, canLoopback: spPick2.canLoopback },
                    cancel: { video: spCancel.lastVideoId },
                    cancel2: { count: spCancel2.settleCount },
                  },
                }));

                // ==== PAC-4 — THE CORNERSTONE (repair-order-pac4-cornerstone.md) ==============

                // f_pac4_trailingSlashOrigin — FIX A's leg: THE leg that would have caught the
                // owner-diary bug. Real Chromium's securityOrigin carries a TRAILING SLASH
                // ('https://drag-drop-app.vercel.app/') while CLOUD_ORIGIN has none — the old
                // raw-string guard refused OUR OWN SITE on every real share click (the dev
                // battery always passed the exact constant, so only this synthetic trailing
                // slash can exercise the real shape). The trailing-slash origin must OPEN the
                // picker (window visible, sources sent) and a pick must settle with the chosen
                // source; the evil origin must STILL deny exactly once, empty.
                {
                  const pac4Base = cloudCtl!.shareProbe().settleCount;
                  await cloudCtl!.sharePickerTest({ securityOrigin: CLOUD_ORIGIN + '/' });
                  const pac4Opened = await waitFor(async () => {
                    const p = cloudCtl!.shareProbe();
                    return p.open && p.sourcesSent > 0;
                  }, 10000, 100);
                  // RED-shape safety: with the guard reverted the window never opens, so
                  // pickerEval would THROW and kill the stage — the leg must REPORT false, not
                  // crash. A missing window just means no pick; opened=false already fails the leg.
                  let pac4Id: string | null = null;
                  try {
                    pac4Id = await cloudCtl!.pickerEval<string | null>(
                      'var c = document.querySelector(".src"); c ? c.dataset.id : null'
                    );
                  } catch {
                    pac4Id = null;
                  }
                  if (pac4Id !== null) cloudCtl!.sharePickerPick(String(pac4Id), false);
                  const pac4Pick = cloudCtl!.shareProbe();
                  const slashOpensAndPicks = pac4Opened && pac4Pick.settleCount === pac4Base + 1
                    && pac4Pick.lastVideoId === pac4Id && pac4Pick.open === false;
                  await cloudCtl!.sharePickerTest({ securityOrigin: 'https://evil.example' });
                  const pac4Evil = cloudCtl!.shareProbe();
                  const evilStillDenied = pac4Evil.open === false
                    && pac4Evil.settleCount === pac4Base + 2 && pac4Evil.lastVideoId === null;
                  const f_pac4_trailingSlashOrigin = slashOpensAndPicks && evilStillDenied;
                  console.log('[pac4-slash]', JSON.stringify({
                    f_pac4_trailingSlashOrigin,
                    matrix: { slashOpensAndPicks, evilStillDenied },
                    raw: { opened: pac4Opened, pick: { id: pac4Pick.lastVideoId, count: pac4Pick.settleCount },
                      evil: { count: pac4Evil.settleCount, video: pac4Evil.lastVideoId, open: pac4Evil.open } },
                  }));
                }

                // ==== PAC-5 — THE HONEST HANDOFF (repair-order-pac5-permanent-stage.md) =====

                // f_pac5_shareVerdictOmitsAudioKey — FIX D leg 4: the verdict's OWN-PROPERTY
                // keys, captured by the DEV mock callback (shareProbe.lastVerdictKeys). An
                // unticked pick must hand the site a verdict whose keys are EXACTLY ['video'] —
                // the old { video, audio: undefined } verdict (keys ['video','audio'] with an
                // undefined value) is the proven root cause of the unticked-share failure.
                // The DEV-only assumeWin32 opt forces the loopback branch so the ticked shape
                // (keys ['video','audio'], value 'loopback') is provable on Linux too; the NEXT
                // request recomputes canLoopback from the platform (the production truth).
                // RED: the 1.0.3 verdict shape ⇒ unticked keys ['video','audio'] (audio
                // undefined) ⇒ the EXACT-equality assert fails.
                {
                  const pac5Base = cloudCtl!.shareProbe().settleCount;
                  await cloudCtl!.sharePickerTest();
                  const p5Opened = await waitFor(async () => {
                    const p = cloudCtl!.shareProbe();
                    return p.open && p.sourcesSent > 0;
                  }, 10000, 100);
                  let p5Id: string | null = null;
                  try {
                    p5Id = await cloudCtl!.pickerEval<string | null>(
                      'var c = document.querySelector(".src"); c ? c.dataset.id : null'
                    );
                  } catch { p5Id = null; }
                  if (p5Id !== null) cloudCtl!.sharePickerPick(String(p5Id), false);
                  const p5Unticked = cloudCtl!.shareProbe();
                  const untickedVideoOnly = p5Opened && p5Unticked.settleCount === pac5Base + 1
                    && !!p5Unticked.lastVerdictKeys
                    && p5Unticked.lastVerdictKeys!.length === 1 && p5Unticked.lastVerdictKeys![0] === 'video';
                  await cloudCtl!.sharePickerTest({ assumeWin32: true });
                  const p5Opened2 = await waitFor(async () => cloudCtl!.shareProbe().open, 10000, 100);
                  let p5Id2: string | null = null;
                  try {
                    p5Id2 = await cloudCtl!.pickerEval<string | null>(
                      'var c = document.querySelector(".src"); c ? c.dataset.id : null'
                    );
                  } catch { p5Id2 = null; }
                  if (p5Id2 !== null) cloudCtl!.sharePickerPick(String(p5Id2), true);
                  const p5Ticked = cloudCtl!.shareProbe();
                  const tickedLoopback = p5Opened2 && p5Ticked.settleCount === pac5Base + 2
                    && !!p5Ticked.lastVerdictKeys
                    && p5Ticked.lastVerdictKeys!.length === 2 && p5Ticked.lastVerdictKeys![0] === 'video'
                    && p5Ticked.lastVerdictKeys![1] === 'audio'
                    && p5Ticked.lastVerdictAudio === 'loopback';
                  // Recompute-truth insurance: a fresh request resets canLoopback to the
                  // platform's answer (false on this Linux battery) — assumeWin32 never sticks.
                  await cloudCtl!.sharePickerTest();
                  const p5Opened3 = await waitFor(async () => cloudCtl!.shareProbe().open, 10000, 100);
                  cloudCtl!.sharePickerCancel();
                  const p5Reset = cloudCtl!.shareProbe();
                  const recomputeHeld = p5Opened3 && p5Reset.canLoopback === false
                    && p5Reset.settleCount === pac5Base + 3;
                  const f_pac5_shareVerdictOmitsAudioKey = untickedVideoOnly && tickedLoopback && recomputeHeld;
                  console.log('[pac5-verdict]', JSON.stringify({
                    f_pac5_shareVerdictOmitsAudioKey,
                    matrix: { untickedVideoOnly, tickedLoopback, recomputeHeld },
                    raw: { unticked: { keys: p5Unticked.lastVerdictKeys }, ticked: { keys: p5Ticked.lastVerdictKeys, audio: p5Ticked.lastVerdictAudio }, reset: { canLoopback: p5Reset.canLoopback } },
                  }));
                }

                // f_pac5_shareEndToEndVideoOnly — FIX D leg 5, THE KILLER: the only leg that
                // resolves a REAL display-media promise through Chromium's own reply validator
                // (every prior battery answered the picker with a mock callback, which accepts
                // anything — exactly why the undefined-audio-key bug slipped every round). A
                // hidden battery window on the cloud PARTITION loads a small local fixture page
                // (file:// is a secure context — probe-proven, /tmp/opencode/shareprobe) whose
                // getDisplayMedia({video, audio:{...}}) request is handled by the REAL
                // openSharePicker; sharePickerPick answers; the page promise must RESOLVE with
                // 1 video track / 0 audio tracks. RED: the { audio: undefined } verdict ⇒ the
                // page rejects AbortError (probe-reproduced on Linux 2026-08-31, mode D).
                {
                  const e2eWinBefore = BrowserWindow.getAllWindows().length;
                  const fixturePath = join(tmpdir(), 'pac5-e2e-fixture.html');
                  writeFileSync(fixturePath, '<!doctype html><meta charset="utf-8"><title>pac5 e2e fixture</title><body>fixture</body>', 'utf8');
                  const e2eWin = new BrowserWindow({
                    show: false,
                    webPreferences: {
                      partition: 'persist:cloud', // the session the display-media handler lives on
                      sandbox: true,
                      contextIsolation: true,
                      nodeIntegration: false,
                    },
                  });
                  e2eWin.setMenu(null);
                  await e2eWin.loadURL('file://' + fixturePath);
                  // The REAL request (userGesture: true — the same gate the guard demands):
                  // store the outcome on the window, then poll it (executeJavaScript's own
                  // promise resolution would wedge the battery on a hung share).
                  void e2eWin.webContents.executeJavaScript(
                    `window.__pac5e2e = 'pending';
                     navigator.mediaDevices.getDisplayMedia({ video: true,
                       audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
                       .then(function (s) {
                         window.__pac5e2e = JSON.stringify({ ok: true,
                           video: s.getVideoTracks().length, audio: s.getAudioTracks().length });
                         s.getTracks().forEach(function (t) { t.stop(); });
                       })
                       .catch(function (e) {
                         window.__pac5e2e = JSON.stringify({ ok: false, name: e && e.name,
                           msg: String(e && e.message).slice(0, 200) });
                       });`, true /* userGesture */).catch(() => undefined);
                  // The REAL openSharePicker handles the page's request: the picker must open.
                  const e2eOpened = await waitFor(async () => {
                    const p = cloudCtl!.shareProbe();
                    return p.open && p.sourcesSent > 0;
                  }, 15000, 100);
                  // Pick the first SCREEN source (a real capturable stream on WSLg); fall back
                  // to the literal first source when no screen exists.
                  let e2ePickId: string | null = null;
                  try {
                    e2ePickId = await cloudCtl!.pickerEval<string | null>(
                      'var c = document.querySelector("#screens .src") || document.querySelector(".src"); c ? c.dataset.id : null'
                    );
                  } catch { e2ePickId = null; }
                  if (e2ePickId !== null) cloudCtl!.sharePickerPick(String(e2ePickId), false);
                  // The page promise must RESOLVE with 1 video / 0 audio (a clean VIDEO-ONLY
                  // share — §3.5: no dummy audio track).
                  let e2eResult: { ok: boolean; video?: number; audio?: number; name?: string; msg?: string } | null = null;
                  const e2eT0 = Date.now();
                  while (Date.now() - e2eT0 < 20000) {
                    const raw = await e2eWin.webContents.executeJavaScript('window.__pac5e2e === "pending" ? "pending" : window.__pac5e2e')
                      .then((s) => String(s));
                    if (raw !== 'pending') { e2eResult = JSON.parse(raw); break; }
                    await sleep(100);
                  }
                  const e2eResolved = !!e2eResult && e2eResult.ok === true
                    && e2eResult.video === 1 && e2eResult.audio === 0;
                  const e2eClosed = await (async (): Promise<boolean> => {
                    if (!e2eWin.isDestroyed()) e2eWin.destroy();
                    for (let i = 0; i < 10 && BrowserWindow.getAllWindows().length > e2eWinBefore; i++) await sleep(100);
                    return BrowserWindow.getAllWindows().length === e2eWinBefore;
                  })();
                  const f_pac5_shareEndToEndVideoOnly = e2eOpened && e2eResolved && e2eClosed;
                  console.log('[pac5-e2e]', JSON.stringify({
                    f_pac5_shareEndToEndVideoOnly,
                    matrix: { e2eOpened, e2eResolved, e2eClosed },
                    raw: { picked: e2ePickId, result: e2eResult, settle: cloudCtl!.shareProbe().settleCount },
                  }));
                }

                // ==== PAC-3 — THE STEADY CURTAIN (repair-order-pac3-steady-curtain.md) ========

                // f_pac3_curtainPresentAck — FIX A's leg: the curtain reports ready only after
                // the page's TWO-rAF SUBMISSION ack (rafTicksAtReady ≥ 2, read from the
                // __c2mFader fixture via faderProbe.page), on a REAL user-armed Cloud→Local
                // melt — the C2m meltLeg pattern (the pill:flip handler's exact arm write +
                // the real relay; production CLICK arming is covered by f_c2g_realClickFlips).
                // Cloud→Local is THE direction the fix targets (the investigation's cause 1:
                // the curtain-vs-removal race). Covered-swap truth re-asserted here AND carried
                // by f_c2m_flipDissolve (the regression gate, which MUST stay green).
                {
                  // premise enforcement: the melt legs above left us in Cloud (knockHealed);
                  // a relay flip re-syncs both sides if anything drifted.
                  if (appMode !== 'cloud') {
                    win.webContents.send('pill:flipRequested', 'cloud');
                    await sleep(1800);
                  }
                  const pac3WasCloud = appMode === 'cloud';
                  transitionArmedAt = Date.now(); // the pill:flip handler's exact arm write
                  win.webContents.send('pill:flipRequested', 'local');
                  let coveredSwap = false;
                  const ackT0 = Date.now();
                  while (Date.now() - ackT0 < 1000) { // curtain-up window (decode+ack+pad+fade)
                    const p = await cloudCtl!.faderProbe();
                    if (p.inFlight && p.attached
                      && p.bounds !== null && Math.abs(p.bounds.width - win.getContentBounds().width) <= 2) {
                      coveredSwap = appMode === 'cloud'; // curtain BEFORE the swap ⇒ no peek
                      break;
                    }
                    await sleep(25);
                  }
                  let ackSettled = false;
                  const ackT1 = Date.now();
                  while (Date.now() - ackT1 < 2500) { // settle: fade + done-delay + collapse
                    const p = await cloudCtl!.faderProbe();
                    if (!p.inFlight && p.collapsed && p.attached) { ackSettled = true; break; }
                    await sleep(25);
                  }
                  const ackPage = (await cloudCtl!.faderProbe()).page;
                  const f_pac3_curtainPresentAck = pac3WasCloud && coveredSwap && ackSettled
                    && ackPage !== null && ackPage.rafTicksAtReady >= 2
                    && Array.isArray(ackPage.readyRafAt) && ackPage.readyRafAt.length === 2
                    && ackPage.readyRafAt.every((t) => t > 0)
                    && ackPage.readyRafAt[1] >= ackPage.readyRafAt[0];
                  console.log('[pac3-curtain]', JSON.stringify({
                    f_pac3_curtainPresentAck,
                    matrix: {
                      pac3WasCloud, coveredSwap, ackSettled,
                      rafTicksAtReady: ackPage?.rafTicksAtReady ?? -1,
                      readyRafAt: ackPage?.readyRafAt ?? null,
                    },
                  }));
                }

                // f_pac3_noBlankOnEntry — FIX B's leg: from-rest Style-B entries paint the REST
                // circle, NEVER the hotfix-5 blank gate — ZERO hidden ticks at PAGE frame rate
                // (the investigation's pillscan/rAF-sampler method, adapted into the battery):
                // a rAF sampler inside the pill page watches #pillB's computed visibility
                // across each entry. ≥10 fresh entries, each from TRUE rest — PAC-5: the page's
                // own rest truth (bloomed class gone; the old `innerWidth === 28` room gate no
                // longer exists — the stage is permanent), cursor away well past the 90 ms
                // hysteresis. (The choreography this leg guarded is DELETED in PAC-5 — the leg
                // now proves the replacement one-path entry is just as blank-free.)
                {
                  const g3 = cloudCtl!;
                  const styleBefore3 = (await g3.pillProbe()).style;
                  const truth3 = (): Promise<{ style: string; bloomed: boolean } | null> =>
                    g3.pillEval('JSON.stringify(window.__c2gPill || null)').then((s) => JSON.parse(s as string) as { style: string; bloomed: boolean } | null);
                  if ((await truth3())?.style !== 'B') {
                    await g3.pillDrive('contextmenu'); // → B (the REAL toggle path)
                    await sleep(400);
                  }
                  const entries3: Array<{ i: number; ticks: number; hidden: number; bloomed: boolean; fromRest: boolean }> = [];
                  for (let i = 0; i < 12; i++) {
                    await g3.pillDrive('mouseleave'); // collapse (no-op if already at rest)
                    let fromRest = false;
                    const tr0 = Date.now();
                    // PAC-5 — the room is PERMANENT (innerWidth is ALWAYS 132), so the old
                    // "room back to 28" true-rest gate is replaced by the page's own rest
                    // truth: the bloomed class gone (the collapse ran its full hysteresis).
                    while (Date.now() - tr0 < 4000) { // wait for TRUE rest (page at rest)
                      const t3 = await truth3();
                      if (t3 && t3.bloomed === false) { fromRest = true; break; }
                      await sleep(60);
                    }
                    await sleep(350); // cursor-away margin (hysteresis 90 ms long since passed)
                    // Install the sampler (read-only, OUR page; a generation token retires any
                    // previous loop so ticks can never double-count).
                    await g3.pillEval(`(function(){
                      var gen = (window.__pac3gen = (window.__pac3gen || 0) + 1);
                      window.__pac3scan = { ticks: [], on: true, gen: gen };
                      (function scan(){
                        if (!window.__pac3scan || window.__pac3scan.gen !== gen || !window.__pac3scan.on) return;
                        var p = document.getElementById('pillB');
                        var hidden = !p || getComputedStyle(p).visibility === 'hidden';
                        window.__pac3scan.ticks.push(hidden ? 1 : 0);
                        requestAnimationFrame(scan);
                      })();
                      return true; })()`);
                    await g3.pillDrive('mouseenter'); // THE fresh from-rest entry
                    await sleep(400); // bloom (0.55 s) underway — no reveal gate exists anymore
                    const scan3 = JSON.parse(await g3.pillEval(`(function(){
                      window.__pac3scan.on = false;
                      return JSON.stringify({ ticks: window.__pac3scan.ticks.length,
                        hidden: window.__pac3scan.ticks.filter(function (t) { return t === 1; }).length,
                        bloomed: !!(window.__c2gPill && window.__c2gPill.bloomed) }); })()`)) as { ticks: number; hidden: number; bloomed: boolean };
                    entries3.push({ i, ticks: scan3.ticks, hidden: scan3.hidden, bloomed: scan3.bloomed, fromRest });
                    await sleep(500); // bloom settles before the next collapse
                  }
                  if (styleBefore3 === 'A' && (await truth3())?.style === 'B') {
                    await g3.pillDrive('contextmenu'); // restore the pre-leg style
                    await sleep(400);
                  }
                  const f_pac3_noBlankOnEntry = entries3.length >= 10
                    && entries3.every((e) => e.fromRest && e.bloomed && e.hidden === 0);
                  console.log('[pac3-blink]', JSON.stringify({
                    f_pac3_noBlankOnEntry,
                    matrix: {
                      entries: entries3.length,
                      allFromRest: entries3.every((e) => e.fromRest),
                      allBloomed: entries3.every((e) => e.bloomed),
                      styleBefore: styleBefore3,
                    },
                    raw: entries3,
                  }));
                }

                // f_pac5_stageNeverMoves — FIX D leg 1 (replaces f_pac4_roomOriginFixed's
                // transient-room assertions): THE PERMANENT STAGE law. The room is sized once
                // per style and NEVER changes at runtime — no width/height swaps, no origin
                // moves (zero moves is a STRONGER twitch guarantee than PAC-4's origin-fixed
                // growth). Sampled on the REAL paths: 20 real-click flips (Style A) and 10
                // hover bloom/collapse cycles (Style B), bounds read on every available tick,
                // EVERY sample equal to the style's constant stage EXACTLY —
                // A (center−70, 10, 140, 28); B (center−66, 2, 132, 44).
                // RED: reintroduce any transient branch or width-only growth ⇒ a change is detected.
                {
                  const g4 = cloudCtl!;
                  const cw0 = win.getContentBounds().width;
                  const stageA: [number, number, number, number] =
                    [Math.round((cw0 - (PILL_W + PILL_A_ROOM_PAD_X * 2)) / 2), PILL_TOP,
                      PILL_W + PILL_A_ROOM_PAD_X * 2, PILL_H];
                  const stageB: [number, number, number, number] =
                    [Math.round((cw0 - (PILL_W + PILL_BLOOM_PAD_X * 2)) / 2), PILL_TOP - PILL_BLOOM_PAD_Y,
                      PILL_W + PILL_BLOOM_PAD_X * 2, PILL_H + PILL_BLOOM_PAD_Y * 2];
                  const sameRect = (p: [number, number, number, number], s: [number, number, number, number]): boolean =>
                    p[0] === s[0] && p[1] === s[1] && p[2] === s[2] && p[3] === s[3];
                  const style0 = (await g4.pillProbe()).style;
                  if (style0 !== 'A') { await g4.pillDrive('contextmenu'); await sleep(400); }
                  // Hit-test-gated REAL click (the C2g robot's mandatory gate, local to this leg).
                  const hitAndClick = async (sel: string): Promise<boolean> => {
                    const ht = JSON.parse(await g4.pillEval(`(function(){ var el = document.querySelector('${sel}');
                        if (!el) return JSON.stringify({ ok:false });
                        var r = el.getBoundingClientRect();
                        var h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                        return JSON.stringify({ ok: !!h && (h === el || el.contains(h)) }); })()`)) as { ok: boolean };
                    if (!ht.ok) return false;
                    return (await g4.pillEval(`(function(){ var el = document.querySelector('${sel}'); if (!el) return false; el.click(); return true; })()`)) === true;
                  };
                  // Main-side bounds sampler at the tightest practical cadence; runs until the
                  // requested mode has landed AND ≥1.2 s have passed (arm → melt → apply →
                  // settle), capped at capMs. Every sample must match the constant stage.
                  const sampleUntil = async (want: string, capMs: number): Promise<Array<[number, number, number, number]>> => {
                    const out: Array<[number, number, number, number]> = [];
                    const t0 = Date.now();
                    while (Date.now() - t0 < capMs) {
                      const b = (await g4.pillProbe()).bounds;
                      out.push([b.x, b.y, b.width, b.height]);
                      if (appMode === want && Date.now() - t0 >= 1200) break;
                      await sleep(2);
                    }
                    return out;
                  };
                  const sampleFor = async (ms: number): Promise<Array<[number, number, number, number]>> => {
                    const out: Array<[number, number, number, number]> = [];
                    const t0 = Date.now();
                    while (Date.now() - t0 < ms) {
                      const b = (await g4.pillProbe()).bounds;
                      out.push([b.x, b.y, b.width, b.height]);
                      await sleep(2);
                    }
                    return out;
                  };

                  // Part A — 20 REAL-click flips (both directions), stage constant throughout.
                  let aClicked = 0;
                  const samplesA: Array<[number, number, number, number]> = [];
                  for (let i = 0; i < 20; i++) {
                    const want = appMode === 'cloud' ? 'local' : 'cloud';
                    if (await hitAndClick(want === 'cloud' ? '#btn-cloud-a' : '#btn-local-a')) aClicked += 1;
                    samplesA.push(...await sampleUntil(want, 4000));
                  }
                  const aHeld = samplesA.length >= 20 && samplesA.every((p) => sameRect(p, stageA));

                  // Part B — 10 hover bloom/collapse cycles (Style B), stage constant throughout.
                  await g4.pillDrive('contextmenu'); // → B
                  await sleep(400);
                  let bCycles = 0;
                  const samplesB: Array<[number, number, number, number]> = [];
                  for (let i = 0; i < 10; i++) {
                    await g4.pillDrive('mouseenter');
                    samplesB.push(...await sampleFor(1100)); // bloom + elastic settle while hovered
                    const bOn = JSON.parse(await g4.pillEval('JSON.stringify(!!(window.__c2gPill && window.__c2gPill.bloomed))')) as boolean;
                    await g4.pillDrive('mouseleave');
                    samplesB.push(...await sampleFor(1200)); // hysteresis 90 + CSS shrink
                    const bOff = JSON.parse(await g4.pillEval('JSON.stringify(!!(window.__c2gPill && window.__c2gPill.bloomed))')) as boolean;
                    if (bOn && !bOff) bCycles += 1;
                  }
                  const bHeld = samplesB.length >= 20 && samplesB.every((p) => sameRect(p, stageB));

                  // f_pac5_bloomCentered — FIX D leg 2 (the owner's defect 1): style B, REAL
                  // hover robot. The bloomed pill must land DEAD CENTERED (window-space pill
                  // center within 1 px of the window's horizontal midline), in the SAME height
                  // band as the circle (window-space top == PILL_TOP ±0.5 — the 8 px down-settle
                  // is deleted), and the rest circle's rect must be byte-identical before and
                  // after. RED: PAC-4's [0,8] anchoring ⇒ center off (the rightward unfurl) and
                  // top off by +8.
                  const truth5 = (): Promise<{ style: string; bloomed: boolean } | null> =>
                    g4.pillEval('JSON.stringify(window.__c2gPill || null)').then((s) => JSON.parse(s as string) as { style: string; bloomed: boolean } | null);
                  const readBRect5 = async (): Promise<[number, number, number, number, boolean]> =>
                    g4.pillEval(`(function(){ var p = document.getElementById('pillB');
                        var r = p.getBoundingClientRect();
                        return JSON.stringify([+r.left.toFixed(1), +r.top.toFixed(1),
                          +r.width.toFixed(1), +r.height.toFixed(1), p.classList.contains('bloomed')]); })()`)
                      .then((x) => JSON.parse(x as string) as [number, number, number, number, boolean]);
                  let bRest0: [number, number, number, number, boolean] | null = null;
                  let pbRest: Electron.Rectangle | null = null;
                  const bT0 = Date.now();
                  while (Date.now() - bT0 < 4000) { // from TRUE page rest
                    const t = await truth5();
                    const r = await readBRect5();
                    if (t && t.bloomed === false && !r[4]) { bRest0 = r; pbRest = (await g4.pillProbe()).bounds; break; }
                    await sleep(60);
                  }
                  // Hover reachability: the painted circle must be the hit target at its center.
                  const hoverHit = JSON.parse(await g4.pillEval(`(function(){ var el = document.getElementById('pillB');
                      if (!el) return JSON.stringify({ ok:false });
                      var r = el.getBoundingClientRect();
                      var h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                      return JSON.stringify({ ok: !!h && (h === el || el.contains(h)) }); })()`)) as { ok: boolean };
                  await g4.pillDrive('mouseenter');
                  let bloomRect: [number, number, number, number, boolean] | null = null;
                  const bloomT0 = Date.now();
                  while (Date.now() - bloomT0 < 6000) { // elastic settle (contract .55 s)
                    const r = await readBRect5();
                    if (r[4] && Math.abs(r[0] - 10) <= 1 && Math.abs(r[2] - PILL_W) <= 0.5) { bloomRect = r; break; }
                    await sleep(100);
                  }
                  await sleep(300); // elastic fully home before the window-space math
                  const settled = await readBRect5();
                  const pbB = (await g4.pillProbe()).bounds;
                  const cwB = win.getContentBounds().width;
                  const pillCenterWin = pbB.x + settled[0] + settled[2] / 2;
                  const pillTopWin = pbB.y + settled[1];
                  await g4.pillDrive('mouseleave');
                  let bRest1: [number, number, number, number, boolean] | null = null;
                  const cT0 = Date.now();
                  while (Date.now() - cT0 < 6000) { // collapse: hysteresis + elastic shrink
                    const r = await readBRect5();
                    if (!r[4] && r[2] === PILL_B_REST_W) { bRest1 = r; break; }
                    await sleep(60);
                  }
                  const bloomCenteredOk = !!bRest0 && !!pbRest && hoverHit.ok && !!bloomRect && !!bRest1
                    && Math.abs(pillCenterWin - cwB / 2) <= 1
                    && Math.abs(pillTopWin - PILL_TOP) <= 0.5
                    // the rest circle sits at window center−14..+14 × PILL_TOP..+28 (eternal)
                    && Math.abs(pbRest.x + bRest0[0] + bRest0[2] / 2 - cwB / 2) <= 1
                    && Math.abs(pbRest.y + bRest0[1] - PILL_TOP) <= 0.5
                    && bRest1[0] === bRest0[0] && bRest1[1] === bRest0[1]
                    && bRest1[2] === bRest0[2] && bRest1[3] === bRest0[3];
                  if (style0 === 'A') { await g4.pillDrive('contextmenu'); await sleep(400); } // restore A

                  const f_pac5_stageNeverMoves = aClicked === 20 && bCycles === 10 && aHeld && bHeld;
                  const stageChanges = samplesA.filter((p) => !sameRect(p, stageA)).length
                    + samplesB.filter((p) => !sameRect(p, stageB)).length;
                  console.log('[pac5-stage]', JSON.stringify({
                    f_pac5_stageNeverMoves,
                    matrix: {
                      aClicked, bCycles, aHeld, bHeld, stageChanges,
                      aSamples: samplesA.length, bSamples: samplesB.length,
                    },
                    raw: { style0, stageA, stageB, aTail: samplesA.slice(-2), bTail: samplesB.slice(-2) },
                  }));
                  console.log('[pac5-bloom]', JSON.stringify({
                    f_pac5_bloomCentered: bloomCenteredOk,
                    matrix: { hoverHit, bloomCenteredOk },
                    raw: { bRest0, bloomRect, settled, roomAtBloom: pbB, roomAtRest: pbRest, pillCenterWin, cwB, pillTopWin, bRest1 },
                  }));

                  // f_pac5_knobOvershootFree — FIX D leg 3 (the owner's defect 2): Style A
                  // real-click flip in BOTH directions. Two truths: (a) the page-measured knob
                  // extent past the painted pill's end at the elastic PEAK must be ≤ the 14 px
                  // stage pad; (b) a compositor READBACK of the pill view (capturePage on OUR
                  // layer — the PAC-4 B2 clip-observation tooling precedent) must show the
                  // knob's WHITE pixels PRESENT past the painted end (the overshoot actually
                  // paints — not clipped by an invisible wall). RED: pad 0 (the 1.0.3 left
                  // wall) ⇒ the overshoot pixels are cropped ⇒ (b) fails.
                  {
                    const g5 = cloudCtl!;
                    if ((await g5.pillProbe()).style !== 'A') { await g5.pillDrive('contextmenu'); await sleep(400); }
                    // rAF watcher on OUR page: track the knob rect's extents past #pillA's ends.
                    const armKnobWatch = (): Promise<void> =>
                      g5.pillEval(`(function(){
                        var gen = (window.__pac5knobGen = (window.__pac5knobGen || 0) + 1);
                        window.__pac5knob = { gen: gen, on: true, maxR: -999, maxL: -999 };
                        (function scan(){
                          if (!window.__pac5knob || window.__pac5knob.gen !== gen || !window.__pac5knob.on) return;
                          var k = document.querySelector('#pillA .knob'), p = document.getElementById('pillA');
                          if (k && p) {
                            var kr = k.getBoundingClientRect(), pr = p.getBoundingClientRect();
                            var extR = kr.right - pr.right, extL = pr.left - kr.left;
                            if (extR > window.__pac5knob.maxR) window.__pac5knob.maxR = extR;
                            if (extL > window.__pac5knob.maxL) window.__pac5knob.maxL = extL;
                          }
                          requestAnimationFrame(scan);
                        })();
                        return true; })()`).then(() => undefined);
                    const readKnobWatch = async (): Promise<{ maxR: number; maxL: number }> =>
                      g5.pillEval(`(function(){ return JSON.stringify({ maxR: +window.__pac5knob.maxR.toFixed(2), maxL: +window.__pac5knob.maxL.toFixed(2) }); })()`)
                        .then((s) => JSON.parse(s as string) as { maxR: number; maxL: number });
                    // Readback truth: white-ish (knob) pixels past the painted pill's ACTUAL end
                    // in the capture. The scan zone is anchored on the page's own #pillA rect
                    // (paintedLeft/paintedWidth CSS px, scaled by the capture's real device
                    // scale) — NOT on the assumed 140-room formula, so a pad-0 geometry (the
                    // RED) yields an EMPTY overshoot zone and can never "find" white inside the
                    // pill body. White-ish = ALL four bitmap bytes ≥ 200 (order-agnostic BGRA/
                    // RGBA; only near-white opaque pixels qualify — ink/shadow/void have a
                    // dark channel).
                    const whitePastEnd = (dataUrl: string, side: 'left' | 'right',
                      paintedLeftCss: number, paintedWidthCss: number, viewportCss: number): boolean => {
                      const img = nativeImage.createFromDataURL(dataUrl);
                      const size = img.getSize();
                      const scale = size.width / viewportCss;
                      const l = Math.round(paintedLeftCss * scale);
                      const r = Math.round((paintedLeftCss + paintedWidthCss) * scale);
                      const buf = img.toBitmap();
                      const from = side === 'right' ? r + 1 : 0;
                      const to = side === 'right' ? size.width - 1 : l - 1;
                      for (let y = 0; y < size.height; y++) {
                        for (let x = from; x <= to; x++) {
                          const o = (y * size.width + x) * 4;
                          if (buf[o] >= 200 && buf[o + 1] >= 200 && buf[o + 2] >= 200 && buf[o + 3] >= 200) return true;
                        }
                      }
                      return false;
                    };
                    const overshootDir = async (want: string, side: 'left' | 'right'): Promise<{ seen: number; pixels: boolean }> => {
                      const startMode = want === 'cloud' ? 'local' : 'cloud';
                      for (let attempt = 0; attempt < 3; attempt++) {
                        // Pre-position: the flip needs a REAL mode change, so we must START on
                        // the opposite side (a same-mode click is a safe no-op, no knob slide).
                        if (appMode !== startMode) {
                          await hitAndClick(startMode === 'cloud' ? '#btn-cloud-a' : '#btn-local-a');
                          await sleep(1300);
                        }
                        await armKnobWatch();
                        const clicked = await hitAndClick(want === 'cloud' ? '#btn-cloud-a' : '#btn-local-a');
                        if (!clicked) continue;
                        // The watcher records the whole transition; the moment the overshoot
                        // passes the painted end (extent > 1 px) grab the readback — the peak
                        // window is brief (~120 ms of the 0.6 s elastic).
                        const t0 = Date.now();
                        let peak: { maxR: number; maxL: number } = { maxR: -999, maxL: -999 };
                        while (Date.now() - t0 < 4000) {
                          peak = await readKnobWatch();
                          if ((side === 'right' ? peak.maxR : peak.maxL) > 1) break;
                          await sleep(15);
                        }
                        await sleep(30); // let the presenting frame be the peak frame
                        const shot = await g5.pillCapture();
                        const geo = JSON.parse(await g5.pillEval(`(function(){
                            var r = document.getElementById('pillA').getBoundingClientRect();
                            return JSON.stringify({ l: r.left, w: r.width, vw: window.innerWidth }); })()`)) as { l: number; w: number; vw: number };
                        if (whitePastEnd(shot, side, geo.l, geo.w, geo.vw)) {
                          return { seen: side === 'right' ? peak.maxR : peak.maxL, pixels: true };
                        }
                        // Missed the peak (capture landed outside the overshoot window) — flip
                        // back and retry from the other side.
                        await sleep(300);
                      }
                      const peak = await readKnobWatch();
                      return { seen: side === 'right' ? peak.maxR : peak.maxL, pixels: false };
                    };
                    const overshootR = await overshootDir('local', 'right');
                    await sleep(600);
                    const overshootL = await overshootDir('cloud', 'left');
                    const f_pac5_knobOvershootFree = overshootR.pixels && overshootL.pixels
                      && overshootR.seen <= PILL_A_ROOM_PAD_X && overshootL.seen <= PILL_A_ROOM_PAD_X;
                    console.log('[pac5-knob]', JSON.stringify({
                      f_pac5_knobOvershootFree,
                      matrix: { overshootR, overshootL, pad: PILL_A_ROOM_PAD_X },
                      raw: { modeEnd: appMode },
                    }));
                  }
                }

                // Cleanup for the dead-last C2h idle stage: local, synced, chip idle, veil
                // down, no net override, real site restored, no warm arm. Same desync
                // insurance on the way home.
                let localReady = false;
                for (let attempt = 0; attempt < 3 && !localReady; attempt++) {
                  win.webContents.send('pill:flipRequested', 'local');
                  localReady = await waitFor(async () =>
                    (await readModeSafe()) === 'local' && appMode === 'local', 2500, 50);
                }
                transitionArmedAt = 0;
                const endSnap = await statusSnap();
                console.log('[c3-clean]', JSON.stringify({
                  chipIdleAtEnd: !endSnap.showing && endSnap.collapsed,
                  finalMode: appMode,
                }));
              }

              // (6) C2h FIX 6 — f_c2h_cloudActivityFeedsIdleLock — DEAD-LAST in this stage; its
              // cleanup leaves a sane unlocked Local stage for anything that might follow.
              //
              // SOUNDNESS (why this isolation proves the wiring): during FEED we synthesize
              // wheel gestures into the SITE view via sendInputEvent — Electron's native input
              // pipeline generates ZERO ipcMain traffic and the site has NO bridge (invariant
              // I1), so the handle()-choke-point toucher can never fire for them. The ONLY code
              // that can advance lastActivity during FEED is the new C2h `input-event` listener
              // → onUserActivity → manager.touch(). Sampling uses DIRECT manager.status() calls
              // (no renderer IPC, no bridge round-trip), so sampling itself cannot feed the
              // clock either. With autoLockMinutes=1 the existing watchdog WOULD seal by ~60 s
              // of silence — staying unlocked through ≥65 s of feeding proves gestures reach
              // the shared clock; locking shortly AFTER feeding stops proves nothing else did.
              {
                await manager.setSettings({ autoLockMinutes: 1 }); // minimum legal; this very call touches ⇒ t₀
                // C3-hotfix-3 run-2 lesson: this was the LAST single-fire relay in the harness
                // and it got DROPPED (enteredCloud:false — the documented C2m-hotfix-2
                // dropped-relay artifact; the renderer was still settling from the (5e)
                // cleanup's guarded switch). Same desync insurance as every (5e) relay.
                // Harness-only; the product path is untouched. (waitFor is (5e)-scoped —
                // this sibling block polls with sleep + readModeSafe directly.)
                let c2hCloudReady = false;
                for (let attempt = 0; attempt < 3 && !c2hCloudReady; attempt++) {
                  win.webContents.send('pill:flipRequested', 'cloud');
                  const c2hT0 = Date.now();
                  while (Date.now() - c2hT0 < 2500 && !c2hCloudReady) {
                    c2hCloudReady = (await readModeSafe()) === 'cloud' && appMode === 'cloud';
                    if (!c2hCloudReady) await sleep(50);
                  }
                }
                const enteredCloud = c2hCloudReady && appMode === 'cloud';
                const t0 = Date.now();
                let lastFeedAt = Date.now();
                const samples: Array<{ tMs: number; state: string }> = [{ tMs: 0, state: manager.status().state }];
                let fedOk = true;
                while (Date.now() - t0 < 70000) { // FEED phase ≥70 s
                  await sleep(15000);
                  try {
                    fedOk = fedOk && (await cloudCtl.siteDriveWheel(300, 300, -120)) === true;
                    lastFeedAt = Date.now();
                  } catch { fedOk = false; }
                  samples.push({ tMs: Date.now() - t0, state: manager.status().state });
                }
                const feedElapsedMs = Date.now() - t0;
                const stayedUnlockedWhileFed = enteredCloud && fedOk
                  && feedElapsedMs >= 65000 && samples.length >= 4
                  && samples.every((s) => s.state === 'unlocked');
                // STARVE phase: stop feeding entirely; watch the SHARED clock do its job alone.
                let lockedAfterStarve = false;
                let lockAfterLastFeedMs = -1;
                while (Date.now() - lastFeedAt < 120000) { // cap 120 s starvation (watchdog granularity 30 s ⇒ expect ~60–90 s)
                  await sleep(10000);
                  const st = manager.status().state;
                  samples.push({ tMs: Date.now() - t0, state: st });
                  if (st === 'locked') { lockedAfterStarve = true; lockAfterLastFeedMs = Date.now() - lastFeedAt; break; }
                }
                const f_c2h_cloudActivityFeedsIdleLock = stayedUnlockedWhileFed && lockedAfterStarve;
                console.log('[c2h-idle]', JSON.stringify({
                  f_c2h_cloudActivityFeedsIdleLock,
                  raw: { enteredCloud, fedOk, feedElapsedMs, stayedUnlockedWhileFed, lockedAfterStarve, lockAfterLastFeedMs, lastFeedIso: new Date(lastFeedAt).toISOString(), sampleCount: samples.length, samples },
                }));
                // CLEANUP: Local re-entered (lands on the password screen — fine, the starve
                // legitimately locked it), re-unlocked through the SAME path other dev paths use
                // (dev:testOnly `vaultUnlock` → manager.unlock), then the C2l Off leg, then a
                // fresh mount so any later stages boots sane.
                // C2l 4b NOTE: the restore used to be this block's FIRST line — but setSettings
                // asserts unlocked, so while the starve-lock was still sealed it THREW
                // ('[c1] failed: Vault is locked.' sits in every prior green log) and the
                // flip/unlock/reload never ran. The restore now happens after the unlock.
                win.webContents.send('pill:flipRequested', 'local');
                await sleep(1500);
                try { await manager.unlock('/tmp/ds-c2f-vault', 'c2f-vault-pw'); } catch { /* already open or gone */ }

                // ================== f_t107_* — MOVE & COPY DROPS (round 107) ==================
                // repair-order-107 §8.3. Placed after the C2h cleanup (Local + unlocked) and
                // before the 92 s C2l Off watch. The DATA legs drive the exported product code
                // paths main-side (createTextDrop/createFileDropFromBytes — the exact functions
                // the drop:create* handlers call — then transferDrops itself) so the asserts can
                // read the REAL VaultDropRecord (blob paths/sha256s never cross the bridge). The
                // UI leg (f_t107_uiWiring) drives the REAL renderer path: reload → real clicks
                // (elementFromPoint-gated) → preview Move button / bulk Move pill / the move
                // modal → the bridge (FIX B) → the drop:transfer handler (FIX D) → the FIX H
                // post-op flows. Fixtures are namespaced t107-* and cleaned up at BOTH ends (the
                // battery vault persists across runs). waitFor is (5e)-scoped (see the C2h note)
                // — this sibling block polls with waitFor107, same precedent.
                {
                  const waitFor107 = async (cond: () => Promise<boolean> | boolean, timeoutMs: number, step = 50): Promise<boolean> => {
                    const t0 = Date.now();
                    for (;;) {
                      if (await cond()) return true;
                      if (Date.now() - t0 > timeoutMs) return false;
                      await sleep(step);
                    }
                  };
                  if (manager.status().state !== 'unlocked') {
                    await manager.unlock('/tmp/ds-c2f-vault', 'c2f-vault-pw');
                  }

                  // ---------- hygiene: a previous run's fixtures must never leak into this one ----------
                  for (const rec of manager.allRecords()) {
                    if (rec.name.startsWith('t107-')) await manager.deleteDropQuiet(rec.id);
                  }
                  for (const cat of manager.listCategories('personal')) {
                    if (cat.name.startsWith('t107 ')) await manager.deleteCategoryQuiet(cat.id);
                  }
                  for (const space of manager.listSpaces()) {
                    if (space.name === 't107 Target' || space.name === 't107 Empty') await manager.deleteSpaceQuiet(space.id);
                  }
                  // run-8 probe: VERIFY the hygiene emptied the namespace — a leftover t107-*
                  // record would keep a same-named card alive after the UI move (cardByName
                  // matches by NAME), faking a cardRemoved failure; listCardTotal grew 43→50
                  // across green5→7, so residue (or non-t107 fixture growth) must be visible.
                  console.log('[f107-hygiene]', JSON.stringify({
                    residue: manager.allRecords().filter((r) => r.name.startsWith('t107-')).map((r) => r.name),
                    personalRecords: manager.listDrops('personal').length,
                    spaces: manager.listSpaces().map((s) => s.name),
                  }));

                  // ---------- fixtures (the product create paths) ----------
                  const labelSeed = [{ videoId: 'jNQXAC9IVRw', title: 't107 Seed Title', channel: 't107 Channel' }];
                  const seedLabels = (id: string) => manager.mutatePublic({ op: 'drop.meta', id, patch: { youtubeVideoLabels: labelSeed } });

                  const moveMe = await createTextDrop(manager, {
                    spaceId: 'personal', name: 't107-MoveMe', content: 'move body https://youtu.be/jNQXAC9IVRw',
                    categories: ['t107 Shared', 't107 Alpha'], expirationOption: '6h', locked: true,
                    reminderAt: new Date(Date.now() + 3600_000).toISOString(),
                  });
                  await seedLabels(moveMe.id);

                  const fileBytes = new Uint8Array(64 * 1024);
                  for (let i = 0; i < fileBytes.length; i++) fileBytes[i] = (i * 31 + 7) & 0xff;
                  const fileSeed = await createFileDropFromBytes(manager, fileBytes, 't107-file.bin', 'application/octet-stream', { spaceId: 'personal', expirationOption: '24h', locked: false });

                  const foreverText = await createTextDrop(manager, {
                    spaceId: 'personal', name: 't107-ForeverText', content: 'eternal body',
                    categories: ['t107 Shared'], expirationOption: 'forever', locked: true,
                    reminderAt: new Date(Date.now() + 3600_000).toISOString(),
                  });
                  await seedLabels(foreverText.id);

                  const sixHText = await createTextDrop(manager, {
                    spaceId: 'personal', name: 't107-SixH', content: 'six hour body',
                    categories: [], expirationOption: '6h', locked: false, reminderAt: null,
                  });
                  await seedLabels(sixHText.id);

                  const pwText = await createTextDrop(manager, {
                    spaceId: 'personal', name: 't107-PwText', content: 'secret body',
                    categories: ['password'], expirationOption: '24h', locked: false, reminderAt: null,
                  });
                  await seedLabels(pwText.id);

                  const bulk2 = await createTextDrop(manager, {
                    spaceId: 'personal', name: 't107-Bulk2', content: 'bulk body',
                    categories: ['t107 Shared'], expirationOption: '24h', locked: false, reminderAt: null,
                  });

                  const drawPng = new Uint8Array(137);
                  for (let i = 0; i < drawPng.length; i++) drawPng[i] = (i * 13 + 5) & 0xff;
                  const drawing = await createTextDrop(manager, {
                    spaceId: 'personal', name: 't107-Draw', content: '', expirationOption: '24h',
                    categories: [], locked: false, reminderAt: null, pngBytes: drawPng,
                  });

                  // UI-flow seeds (the uiWiring leg reloads the renderer so its store hydrates these)
                  const uiMove = await createTextDrop(manager, {
                    spaceId: 'personal', name: 't107-UI-Move', content: 'ui move body',
                    categories: [], expirationOption: '24h', locked: false, reminderAt: null,
                  });
                  const uiCopy = await createTextDrop(manager, {
                    spaceId: 'personal', name: 't107-UI-Copy', content: 'copy preview body',
                    categories: [], expirationOption: '24h', locked: false, reminderAt: null,
                  });
                  const uiFail = await createTextDrop(manager, {
                    spaceId: 'personal', name: 't107-UI-Fail', content: 'ui fail body',
                    categories: [], expirationOption: '24h', locked: false, reminderAt: null,
                  });

                  const target = await manager.createSpace('t107 Target');
                  const empty = await manager.createSpace('t107 Empty');

                  // ---------- f_t107_moveFields ----------
                  const rideKeys = (r: VaultDropRecord) => ({
                    reminderAt: r.reminderAt,
                    reminderSetByUid: r.reminderSetByUid ?? null,
                    reminderDismissedBy: r.reminderDismissedBy ?? null,
                    reminderFiredAt: r.reminderFiredAt ?? null,
                    expiresAt: r.expiresAt,
                    expirationOption: r.expirationOption ?? null,
                    labels: JSON.stringify(r.youtubeVideoLabels ?? []),
                    locked: r.locked,
                  });
                  const moveBefore = rideKeys(manager.findDrop(moveMe.id)); // FRESH read — seedLabels patched the index after createTextDrop returned
                  const moveOut = await transferDrops(manager, { mode: 'move', dropIds: [moveMe.id], targetSpaceId: target.id });
                  const movedRec = manager.findDrop(moveMe.id);
                  const moveAfter = rideKeys(movedRec);
                  const moveRideOk = JSON.stringify(moveBefore) === JSON.stringify(moveAfter);
                  const targetCats = manager.listCategories(target.id);
                  const f_t107_moveFields = moveOut.ok === true && moveOut.results?.[0]?.success === true
                    && movedRec.spaceId === target.id && movedRec.pinned === false
                    && JSON.stringify(movedRec.categories) === JSON.stringify(['t107 Shared', 't107 Alpha'])
                    && targetCats.some((c) => c.name.toLowerCase() === 't107 shared')
                    && targetCats.some((c) => c.name.toLowerCase() === 't107 alpha')
                    && moveRideOk;
                  console.log('[f107-moveFields]', JSON.stringify({
                    f_t107_moveFields,
                    matrix: { ok: moveOut.ok, perDrop: moveOut.results?.[0] ?? null, spaceIdOk: movedRec.spaceId === target.id, unpinned: movedRec.pinned === false, catsOk: JSON.stringify(movedRec.categories), targetRows: targetCats.map((c) => c.name), rideOk: moveRideOk },
                    raw: { before: moveBefore, after: moveAfter },
                  }));

                  // ---------- f_t107_moveListRemoval ----------
                  const f_t107_moveListRemoval = !manager.listDrops('personal').some((d) => d.id === moveMe.id)
                    && manager.listDrops(target.id).some((d) => d.id === moveMe.id);
                  console.log('[f107-moveListRemoval]', JSON.stringify({
                    f_t107_moveListRemoval,
                    raw: { inPersonal: manager.listDrops('personal').some((d) => d.id === moveMe.id), inTarget: manager.listDrops(target.id).some((d) => d.id === moveMe.id) },
                  }));

                  // ---------- f_t107_copyIndependence ----------
                  const { createHash } = await import('node:crypto');
                  const sha107 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
                  const srcFileRec = manager.findDrop(fileSeed.record.id);
                  const srcFileJson = JSON.stringify(srcFileRec);
                  const copyOut = await transferDrops(manager, { mode: 'copy', dropIds: [fileSeed.record.id], targetSpaceId: target.id });
                  const copyItem = copyOut.results?.[0] ?? null;
                  const copyRec = copyItem?.newId ? manager.peekDrop(copyItem.newId) ?? null : null;
                  const pathIndependent = !!copyRec && !!copyRec.blobRefs.file && !!srcFileRec.blobRefs.file
                    && copyRec.id !== srcFileRec.id
                    && copyRec.blobRefs.file.path !== srcFileRec.blobRefs.file.path
                    && copyRec.blobRefs.file.sha256 === srcFileRec.blobRefs.file.sha256
                    && copyRec.blobRefs.file.bytes === srcFileRec.blobRefs.file.bytes;
                  const sourceUnchanged = JSON.stringify(manager.findDrop(fileSeed.record.id)) === srcFileJson;
                  let sourceSurvivesCopyDelete = false;
                  if (copyRec) {
                    await manager.deleteDrop(copyRec.id); // delete the COPY …
                    const bytes = await manager.getBlobBytes(fileSeed.record.id, 'file');
                    sourceSurvivesCopyDelete = !!bytes && sha107(bytes) === srcFileRec.contentSha256s.file; // … the source still previews
                  }
                  let reMadeCopySurvivesSourceDelete = false;
                  const copy2Out = await transferDrops(manager, { mode: 'copy', dropIds: [fileSeed.record.id], targetSpaceId: target.id });
                  const copy2Id = copy2Out.results?.[0]?.newId ?? null;
                  if (copy2Id) {
                    await manager.deleteDrop(fileSeed.record.id); // delete the SOURCE …
                    const bytes = await manager.getBlobBytes(copy2Id, 'file');
                    reMadeCopySurvivesSourceDelete = !!bytes && sha107(bytes) === srcFileRec.contentSha256s.file; // … the re-made copy still previews
                  }
                  const f_t107_copyIndependence = copyOut.ok === true && pathIndependent && sourceUnchanged
                    && sourceSurvivesCopyDelete && reMadeCopySurvivesSourceDelete;
                  console.log('[f107-copyIndependence]', JSON.stringify({
                    f_t107_copyIndependence,
                    matrix: { ok: copyOut.ok, pathIndependent, sourceUnchanged, sourceSurvivesCopyDelete, reMadeCopySurvivesSourceDelete },
                    raw: { srcPath: srcFileRec.blobRefs.file?.path ?? null, copyPath: copyRec?.blobRefs.file?.path ?? null, srcSha: srcFileRec.contentSha256s.file ?? null, copySha: copyRec?.blobRefs.file?.sha256 ?? null, srcBytes: srcFileRec.blobRefs.file?.bytes ?? null, copyBytes: copyRec?.blobRefs.file?.bytes ?? null },
                  }));

                  // ---------- f_t107_copySemantics ----------
                  const copyOne = async (id: string) => {
                    const out = await transferDrops(manager, { mode: 'copy', dropIds: [id], targetSpaceId: target.id });
                    return out.results?.[0]?.newId ? manager.peekDrop(out.results[0].newId!) ?? null : null;
                  };
                  const foreverCopy = await copyOne(foreverText.id);
                  const sixHCopy = await copyOne(sixHText.id);
                  const pwCopy = await copyOne(pwText.id);
                  const drawCopy = await copyOne(drawing.id);
                  const foreverOk = !!foreverCopy && foreverCopy.expiresAt === null && foreverCopy.expirationOption === 'forever'
                    && foreverCopy.reminderAt === foreverText.reminderAt && foreverCopy.reminderSetByUid === foreverText.reminderSetByUid
                    && foreverCopy.reminderDismissedBy === foreverText.reminderDismissedBy && foreverCopy.reminderFiredAt === null
                    && foreverCopy.locked === false && foreverCopy.pinned === false
                    && (foreverCopy.youtubeVideoLabels?.length ?? 0) === 1
                    && foreverCopy.createdAt !== foreverText.createdAt;
                  const sixHOk = !!sixHCopy && !!sixHCopy.expiresAt
                    && Math.abs(new Date(sixHCopy.expiresAt).getTime() - (Date.now() + 6 * 3600_000)) < 60_000;
                  const pwOk = !!pwCopy && (pwCopy.youtubeVideoLabels?.length ?? 0) === 0;
                  const drawOk = !!drawCopy && drawCopy.isDrawing === true
                    && !!drawCopy.blobRefs.file && !!drawing.blobRefs.file
                    && drawCopy.blobRefs.file.path !== drawing.blobRefs.file.path
                    && drawCopy.blobRefs.file.sha256 === drawing.blobRefs.file.sha256;
                  const f_t107_copySemantics = foreverOk && sixHOk && pwOk && drawOk;
                  console.log('[f107-copySemantics]', JSON.stringify({
                    f_t107_copySemantics,
                    matrix: { foreverOk, sixHOk, pwOk, drawOk },
                    raw: {
                      forever: foreverCopy ? { expiresAt: foreverCopy.expiresAt, option: foreverCopy.expirationOption ?? null, reminderAt: foreverCopy.reminderAt, locked: foreverCopy.locked, pinned: foreverCopy.pinned, labels: foreverCopy.youtubeVideoLabels?.length ?? 0, createdAtFresh: foreverCopy.createdAt !== foreverText.createdAt } : null,
                      sixHExpiresAt: sixHCopy?.expiresAt ?? null, pwLabels: pwCopy ? (pwCopy.youtubeVideoLabels?.length ?? 0) : null,
                      drawCopyPath: drawCopy?.blobRefs.file?.path ?? null, drawSrcPath: drawing.blobRefs.file?.path ?? null,
                    },
                  }));

                  // ---------- f_t107_bulkCategoryEnsure ----------
                  const bulkOut = await transferDrops(manager, { mode: 'move', dropIds: [foreverText.id, bulk2.id], targetSpaceId: empty.id });
                  const emptyCats = manager.listCategories(empty.id);
                  const foreverInEmpty = manager.findDrop(foreverText.id);
                  const bulk2InEmpty = manager.findDrop(bulk2.id);
                  const f_t107_bulkCategoryEnsure = bulkOut.ok === true && (bulkOut.results?.every((r) => r.success) ?? false)
                    && emptyCats.length === 1 && emptyCats[0]?.name === 't107 Shared'
                    && foreverInEmpty.categories.includes('t107 Shared') && bulk2InEmpty.categories.includes('t107 Shared')
                    && foreverInEmpty.spaceId === empty.id && bulk2InEmpty.spaceId === empty.id;
                  console.log('[f107-bulkCategoryEnsure]', JSON.stringify({
                    f_t107_bulkCategoryEnsure,
                    raw: { results: bulkOut.results ?? [], emptyCategories: emptyCats.map((c) => c.name), foreverCats: foreverInEmpty.categories, bulk2Cats: bulk2InEmpty.categories },
                  }));

                  // ---------- f_t107_partialFailure ----------
                  const partGood = await createTextDrop(manager, {
                    spaceId: 'personal', name: 't107-PartGood', content: 'good body', categories: [],
                    expirationOption: '24h', locked: false, reminderAt: null,
                  });
                  const partialOut = await transferDrops(manager, { mode: 'move', dropIds: [partGood.id, 't107-bogus-nonexistent'], targetSpaceId: target.id });
                  const goodAfter = manager.findDrop(partGood.id);
                  const f_t107_partialFailure = partialOut.ok === true && (partialOut.results?.length ?? 0) === 2
                    && partialOut.results?.[0]?.success === true
                    && partialOut.results?.[1]?.success === false && partialOut.results?.[1]?.error === 'Drop not found.'
                    && goodAfter.spaceId === target.id;
                  console.log('[f107-partialFailure]', JSON.stringify({ f_t107_partialFailure, out: partialOut }));

                  // ---------- f_t107b_copyBatchOrderPreserved (repair-order-107b §4.4) ----------
                  // Bulk COPY must land in the caller's display order, not reversed. Fresh
                  // spaces (sA source / sB target — sB EMPTY so the target list is EXACTLY the
                  // batch); three sequential creates in sA; copy the observed newest-first
                  // `order` 1:1; the target list must deep-equal it and all three copies must
                  // carry ONE shared createdAt (vault.ts:638 sorts newest-first with NO
                  // tie-breaker; JS sorts are stable — equal stamps keep loop order).
                  const sA = await manager.createSpace('t107b BatchSrc');
                  const sB = await manager.createSpace('t107b BatchTgt');
                  const batch1 = await createTextDrop(manager, {
                    spaceId: sA.id, name: 't107-Batch1', content: 'batch body 1',
                    categories: [], expirationOption: '24h', locked: false, reminderAt: null,
                  });
                  const batch2 = await createTextDrop(manager, {
                    spaceId: sA.id, name: 't107-Batch2', content: 'batch body 2',
                    categories: [], expirationOption: '24h', locked: false, reminderAt: null,
                  });
                  const batch3 = await createTextDrop(manager, {
                    spaceId: sA.id, name: 't107-Batch3', content: 'batch body 3',
                    categories: [], expirationOption: '24h', locked: false, reminderAt: null,
                  });
                  const order = manager.listDrops(sA.id).map((d) => d.id); // newest-first display order
                  const batchOut = await transferDrops(manager, { mode: 'copy', dropIds: order, targetSpaceId: sB.id });
                  const targetOrder = manager.listDrops(sB.id).map((d) => d.id);
                  const newRecs: VaultDropRecord[] = [];
                  for (const r of batchOut.results ?? []) {
                    const rec = r.newId ? manager.peekDrop(r.newId) : undefined;
                    if (rec) newRecs.push(rec);
                  }
                  // §4.4 says the target id list "deep-equals `order`" — but `order` holds SOURCE
                  // ids while sB holds COPIES (fresh UUIDs, dropOps.ts:670), so the literal
                  // comparison is unsatisfiable by construction (green-run-1 evidence: names and
                  // stamps aligned, orderPreserved false). The batch's order is carried by the
                  // results array — one entry per dropId in loop order — so the target list must
                  // equal the newId SEQUENCE (position i ↔ order[i]). Same mechanism §8.3's RED
                  // pair flips: per-copy fresh stamps push the last-copied drop to the top.
                  const newIdsInLoopOrder = (batchOut.results ?? []).map((r) => r.newId ?? null);
                  const orderPreserved = JSON.stringify(targetOrder) === JSON.stringify(newIdsInLoopOrder);
                  const sameStamp = newRecs.length === 3 && new Set(newRecs.map((r) => r.createdAt)).size === 1;
                  const sourceListUnchanged = JSON.stringify(manager.listDrops(sA.id).map((d) => d.id)) === JSON.stringify(order);
                  const f_t107b_copyBatchOrderPreserved = order.length === 3 && batchOut.ok === true
                    && orderPreserved && sameStamp && sourceListUnchanged;
                  console.log('[f107b-copyBatchOrder]', JSON.stringify({
                    f_t107b_copyBatchOrderPreserved,
                    matrix: {
                      guardOrderLen3: order.length === 3, ok: batchOut.ok, orderPreserved, sameStamp, sourceListUnchanged,
                      tgtIds: targetOrder,
                      newIdsInLoopOrder,
                      srcCreatedAts: order.map((id) => manager.peekDrop(id)?.createdAt ?? null),
                      tgtCreatedAts: targetOrder.map((id) => manager.peekDrop(id)?.createdAt ?? null),
                      srcNames: order.map((id) => manager.peekDrop(id)?.name ?? null),
                      tgtNames: targetOrder.map((id) => manager.peekDrop(id)?.name ?? null),
                    },
                  }));
                  // leg-end cleanup — the fixed-name hygiene loops above/below can't match these
                  // two spaces (the vault persists across runs); the t107-Batch* drop names ARE
                  // covered by both hygiene loops, this is just belt-and-suspenders.
                  for (const r of newRecs) await manager.deleteDropQuiet(r.id);
                  for (const id of [batch1.id, batch2.id, batch3.id]) await manager.deleteDropQuiet(id);
                  await manager.deleteSpaceQuiet(sB.id);
                  await manager.deleteSpaceQuiet(sA.id);

                  // ---------- f_t107c_reminderRides (repair-order-107c §4.5; upgraded 107d §4.3) ----------
                  // Reminders RIDE on copy (owner 2026-09-03 — carry EVERYTHING, like move):
                  // reminderAt + reminderSetByUid verbatim, and (107d) reminderDismissedBy verbatim
                  // too — a dismissal is the user's "done with this reminder" decision and must
                  // travel with the copy, else a copied drop re-notifies about something already
                  // closed; reminderFiredAt is the ONLY reset (an UNdismissed past reminderAt
                  // surfaces once via the missed queue — C2j keys on reminderAt ≤ now && !dismissed
                  // && !fired). 107d §8.3's RED pair restores ONLY the dismissal line
                  // (`reminderDismissedBy: null,` — the 107c behavior): then dismissedRides goes
                  // FALSE (copy reads null vs 'local') while futureRides/pastRides/controlStaysNull/
                  // sourcesUnchanged/moveStillRides stay TRUE — the precise signature.
                  const remSrc = await manager.createSpace('t107c RemSrc');
                  const remTgt = await manager.createSpace('t107c RemTgt'); // EMPTY — the batch IS the whole target
                  const remFuture = await createTextDrop(manager, {
                    spaceId: remSrc.id, name: 't107-RemFuture', content: 'future reminder body',
                    categories: [], expirationOption: '24h', locked: false,
                    reminderAt: new Date(Date.now() + 3600_000).toISOString(),
                  });
                  const remPast = await createTextDrop(manager, {
                    spaceId: remSrc.id, name: 't107-RemPast', content: 'past reminder body',
                    categories: [], expirationOption: '24h', locked: false,
                    reminderAt: new Date(Date.now() - 3600_000).toISOString(),
                  });
                  const remCtrl = await createTextDrop(manager, {
                    spaceId: remSrc.id, name: 't107-RemCtrl', content: 'no reminder body',
                    categories: [], expirationOption: '24h', locked: false, reminderAt: null,
                  });
                  // 107d: the fourth seed — an already-DISMISSED past reminder; the dismissal is
                  // seeded via patchDropMeta (vault.ts Pick list carries reminderDismissedBy and
                  // sets ONLY the patched fields) exactly like a user's dismiss action.
                  const remDismissed = await createTextDrop(manager, {
                    spaceId: remSrc.id, name: 't107-RemDismissed', content: 'dismissed reminder body',
                    categories: [], expirationOption: '24h', locked: false,
                    reminderAt: new Date(Date.now() - 3600_000).toISOString(),
                  });
                  await manager.patchDropMeta(remDismissed.id, { reminderDismissedBy: 'local' });
                  // snap AFTER the patch — the dismissed seed's snapshot must carry 'local'; peeked
                  // fresh (the createTextDrop return predates the patch).
                  const remDismissedPatched = manager.peekDrop(remDismissed.id) ?? remDismissed;
                  const remSnap = [remFuture, remPast, remDismissedPatched, remCtrl].map((d) => ({
                    reminderAt: d.reminderAt, reminderSetByUid: d.reminderSetByUid,
                    reminderDismissedBy: d.reminderDismissedBy, reminderFiredAt: d.reminderFiredAt ?? null,
                  }));
                  const remCopyOut = await transferDrops(manager, {
                    mode: 'copy', dropIds: [remFuture.id, remPast.id, remDismissed.id, remCtrl.id], targetSpaceId: remTgt.id,
                  });
                  const remResults = remCopyOut.results ?? [];
                  const remCopies = remResults.map((r) => (r.newId ? manager.peekDrop(r.newId) ?? null : null));
                  const [futCopy, pastCopy, dismissedCopy, ctrlCopy] = remCopies; // results are in loop order — position i ↔ i-th requested drop
                  const futureRides = !!futCopy
                    && futCopy.reminderAt === remSnap[0].reminderAt          // string equality — VERBATIM ride
                    && futCopy.reminderSetByUid === remSnap[0].reminderSetByUid
                    && futCopy.reminderDismissedBy === remSnap[0].reminderDismissedBy // dismissal rides verbatim (107d)
                    && futCopy.reminderFiredAt === null;
                  const pastRides = !!pastCopy
                    && pastCopy.reminderAt === remSnap[1].reminderAt
                    && pastCopy.reminderSetByUid === remSnap[1].reminderSetByUid
                    && pastCopy.reminderDismissedBy === remSnap[1].reminderDismissedBy // verbatim (107d)
                    && pastCopy.reminderFiredAt === null;
                  const controlStaysNull = !!ctrlCopy && ctrlCopy.reminderAt === null && ctrlCopy.reminderSetByUid === null;
                  // 107d's new assert — the DISMISSED copy: the dismissal RIDES ('local'), the
                  // reminderAt rides verbatim, and reminderFiredAt is STILL the only reset — a
                  // dismissed reminder never fires on the copy (the owner's re-notification bug,
                  // asserted at field level).
                  const dismissedRides = !!dismissedCopy
                    && dismissedCopy.reminderDismissedBy === remSnap[2].reminderDismissedBy // 'local' — RIDES
                    && dismissedCopy.reminderAt === remSnap[2].reminderAt   // verbatim
                    && dismissedCopy.reminderFiredAt === null;
                  const sourcesUnchanged = [remFuture, remPast, remDismissed, remCtrl].every((d, i) => {
                    const after = manager.peekDrop(d.id);
                    const b = remSnap[i];
                    return !!after && after.reminderAt === b.reminderAt
                      && after.reminderSetByUid === b.reminderSetByUid
                      && (after.reminderDismissedBy ?? null) === b.reminderDismissedBy
                      && (after.reminderFiredAt ?? null) === b.reminderFiredAt;
                  });
                  // THEN move the past-reminder drop to the target — move's ONE meta patch carries
                  // the reminder by construction (dropOps.ts:587-591); the asymmetry story is fixed
                  // on BOTH verbs.
                  const remMoveOut = await transferDrops(manager, { mode: 'move', dropIds: [remPast.id], targetSpaceId: remTgt.id });
                  const pastAfterMove = manager.peekDrop(remPast.id);
                  const moveStillRides = remMoveOut.ok === true && remMoveOut.results?.[0]?.success === true
                    && !!pastAfterMove && pastAfterMove.reminderAt === remSnap[1].reminderAt
                    && pastAfterMove.spaceId === remTgt.id;
                  const f_t107c_reminderRides = remCopyOut.ok === true && remResults.length === 4
                    && remResults.every((r) => r.success)
                    && futureRides && pastRides && dismissedRides && controlStaysNull && sourcesUnchanged && moveStillRides;
                  console.log('[f107c-reminderRides]', JSON.stringify({
                    f_t107c_reminderRides,
                    matrix: {
                      ok: remCopyOut.ok, allSuccess: remResults.every((r) => r.success),
                      futureRides, pastRides, dismissedRides, controlStaysNull, sourcesUnchanged, moveStillRides,
                      futureSrcReminderAt: remSnap[0].reminderAt, futureCopyReminderAt: futCopy?.reminderAt ?? null,
                      pastSrcReminderAt: remSnap[1].reminderAt, pastCopyReminderAt: pastCopy?.reminderAt ?? null,
                      dismissedSrcReminderAt: remSnap[2].reminderAt, dismissedCopyReminderAt: dismissedCopy?.reminderAt ?? null,
                      dismissedSrcDismissedBy: remSnap[2].reminderDismissedBy,
                      dismissedCopyDismissedBy: dismissedCopy?.reminderDismissedBy ?? null,
                      futureSrcSetBy: remSnap[0].reminderSetByUid, futureCopySetBy: futCopy?.reminderSetByUid ?? null,
                      pastSrcSetBy: remSnap[1].reminderSetByUid, pastCopySetBy: pastCopy?.reminderSetByUid ?? null,
                      copyDismissedFired: [futCopy, pastCopy, dismissedCopy, ctrlCopy].map((c) => (c ? [c.reminderDismissedBy, c.reminderFiredAt] : null)),
                      moveReminderAt: pastAfterMove?.reminderAt ?? null,
                    },
                  }));
                  // leg-end cleanup — the spaces' names are NOT in the hygiene loops' exact-name
                  // list ('t107 Target'/'t107 Empty'); the t107-Rem* drop names ARE covered by the
                  // t107- loops, this is belt-and-suspenders like the f_t107b leg's.
                  for (const c of remCopies) if (c) await manager.deleteDropQuiet(c.id);
                  for (const d of [remFuture, remPast, remDismissed, remCtrl]) await manager.deleteDropQuiet(d.id);
                  await manager.deleteSpaceQuiet(remTgt.id);
                  await manager.deleteSpaceQuiet(remSrc.id);

                  // ---------- f_t107e_dismissalSilencesSweeper (repair-order-107e §4.2) ----------
                  // The REAL engine is exercised — no synthetic fires. The sweeper's
                  // reminderEligible never checked reminderDismissedBy, so 107d's
                  // dismissed-but-not-fired COPIES re-notified (owner-found on candidate 4: toast +
                  // themed card on a copied drop whose reminder was dismissed pre-copy); 107e adds
                  // the dismissal check to the shared predicate, so ALL notification paths (toast,
                  // themed card, missed queue) AND the unlock-time marking honor it. The spy rides
                  // setNotifier — the engine's own seam (index.ts:8219) — and is installed BEFORE
                  // any past-due seed exists, so no real toast escapes into the run and every fire
                  // lands in the spy. The spy is NOT restored afterward (107e §6): later legs don't
                  // depend on toasts, and stray captures are harmless.
                  const spyFires: string[] = [];
                  manager.setNotifier((title: string) => { spyFires.push(title); });
                  const sweepSrc = await manager.createSpace('t107e Sweep');
                  const sweepUndismissed = await createTextDrop(manager, {
                    spaceId: sweepSrc.id, name: 't107e-Undismissed', content: 'past-due, never dismissed',
                    categories: [], expirationOption: '24h', locked: false,
                    reminderAt: new Date(Date.now() - 60_000).toISOString(),
                  });
                  const sweepDismissed = await createTextDrop(manager, {
                    spaceId: sweepSrc.id, name: 't107e-Dismissed', content: 'past-due, dismissed before the tick',
                    categories: [], expirationOption: '24h', locked: false,
                    reminderAt: new Date(Date.now() - 60_000).toISOString(),
                  });
                  await manager.patchDropMeta(sweepDismissed.id, { reminderDismissedBy: 'local' });
                  // ≥35s guarantees a 30s sweeper tick lands regardless of loop phase (107e §5).
                  await new Promise((r) => setTimeout(r, 35_000));
                  const sweepUndismissedAfter = manager.peekDrop(sweepUndismissed.id) ?? sweepUndismissed;
                  const sweepDismissedAfter = manager.peekDrop(sweepDismissed.id) ?? sweepDismissed;
                  // Name-scoped asserts (107e §4.2 note): UNRELATED past-due undismissed drops
                  // lingering in the battery vault may also fire through the spy — harmless.
                  // reminderFiredAt is read through the record's own "null/absent = not yet fired"
                  // rule (vaultTypes.ts) — a fresh unstamped record holds ABSENT, not null.
                  const undismissedFired = spyFires.includes('t107e-Undismissed')
                    && (sweepUndismissedAfter.reminderFiredAt ?? null) !== null; // the engine fired it AND stamped it
                  const dismissedSilent = !spyFires.includes('t107e-Dismissed')
                    && (sweepDismissedAfter.reminderFiredAt ?? null) === null;   // skipped ENTIRELY — no notify, no stamp
                  const dismissedStillRides = (sweepDismissedAfter.reminderDismissedBy ?? null) === 'local'; // the loop never mutated it
                  const f_t107e_dismissalSilencesSweeper = undismissedFired && dismissedSilent && dismissedStillRides;
                  console.log('[f107e-dismissalSilence]', JSON.stringify({
                    f_t107e_dismissalSilencesSweeper,
                    matrix: {
                      undismissedFired, dismissedSilent, dismissedStillRides,
                      spyFires,
                      undismissedFiredAt: sweepUndismissedAfter.reminderFiredAt ?? null,
                      dismissedFiredAt: sweepDismissedAfter.reminderFiredAt ?? null,
                      dismissedBy: sweepDismissedAfter.reminderDismissedBy ?? null,
                    },
                  }));
                  // leg-end cleanup — both seeds + the space are deleted HERE explicitly. FLAGGED
                  // to the owner (107e order said the t107e- names "join the hygiene families"):
                  // 't107e-' does NOT startsWith('t107-'), so the fixed-name hygiene loops and the
                  // [f107-hygiene] residue probe never see these names — this explicit deletion is
                  // the actual cleanup; a mid-leg crash would leave t107e-* residue invisible to
                  // the probe (the order's name-scoping note covers such strays as harmless).
                  await manager.deleteDropQuiet(sweepUndismissed.id);
                  await manager.deleteDropQuiet(sweepDismissed.id);
                  await manager.deleteSpaceQuiet(sweepSrc.id);

                  // ---------- f_t107_sameSpaceGuard ----------
                  const sameMoveOut = await transferDrops(manager, { mode: 'move', dropIds: [partGood.id], targetSpaceId: target.id });
                  const sameCopyOut = await transferDrops(manager, { mode: 'copy', dropIds: [partGood.id], targetSpaceId: target.id });
                  const invalidOut = await transferDrops(manager, { mode: 'nope' as 'move' | 'copy', dropIds: [partGood.id], targetSpaceId: target.id });
                  const f_t107_sameSpaceGuard = sameMoveOut.ok === true && sameMoveOut.results?.[0]?.success === false
                    && sameMoveOut.results?.[0]?.error === 'Already in that space.'
                    && sameCopyOut.ok === true && sameCopyOut.results?.[0]?.success === false
                    && sameCopyOut.results?.[0]?.error === 'Already in that space.'
                    && invalidOut.ok === false && invalidOut.error === 'Invalid move/copy request.';
                  console.log('[f107-sameSpaceGuard]', JSON.stringify({ f_t107_sameSpaceGuard, move: sameMoveOut, copy: sameCopyOut, invalid: invalidOut }));

                  // ---------- f_t107_uiWiring (REAL renderer path; elementFromPoint-gated clicks) ----------
                  win.webContents.reload(); // the store boot-hydrates the t107 seeds; memory rule = local (last relay flip)
                  await sleep(3500);
                  for (let i = 0; i < 30 && (await countDropCards()) === 0; i++) await sleep(500);
                  const uiScript = `
(async () => {
  const out = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clickGate = (node) => {
    if (!node) return 'MISSING';
    // human-click rule part 1: a human SCROLLS the card into view (the list is a 500px
    // scrollable box) — run-1 lesson: without this the off-viewport cards read NO-HIT.
    node.scrollIntoView({ block: 'center', inline: 'center' });
    const r = node.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return 'ZERO-RECT';
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit) return 'NO-HIT';
    if (!(node === hit || node.contains(hit) || hit.contains(node))) {
      // name the culprit — run-5/6 lesson: bulk-step OCCLUDED by a modal overlay/footer that
      // should not exist; name the hit AND whatever modal headers are in the DOM.
      const cls = (hit.className && String(hit.className).slice(0, 90)) || '';
      const moveHdr = document.querySelector('div.max-w-md h2');
      const prevHdr = document.querySelector('div.max-w-3xl h2');
      return 'OCCLUDED<' + hit.tagName + (cls ? ' ' + cls : '') + '> M['
        + (moveHdr ? moveHdr.textContent : '-') + '] P[' + (prevHdr ? prevHdr.textContent : '-') + ']';
    }
    node.click();
    return 'CLICKED';
  };
  const cardByName = (name) => Array.from(document.querySelectorAll('div.select-none.cursor-pointer.group.overflow-hidden')).find((c) => (c.textContent || '').includes(name)) || null;
  const cardCount = (name) => Array.from(document.querySelectorAll('div.select-none.cursor-pointer.group.overflow-hidden')).filter((c) => (c.textContent || '').includes(name)).length;
  const modalRoot = () => document.querySelector('div.max-w-md');
  const modalBtn = (text) => Array.from(document.querySelectorAll('div.max-w-md button')).find((b) => (b.textContent || '').trim() === text) || null;
  // run-1 lesson: the mode TOGGLE owns the first 'Move'/'Copy' text in DOM order — the SUBMIT
  // lives in the footer (the panel's only div.border-t row). Scope submit/cancel finds to it.
  const footerBtn = (text) => Array.from(document.querySelectorAll('div.max-w-md div.border-t button')).find((b) => (b.textContent || '').trim() === text) || null;
  const previewMoveBtn = () => document.querySelector('button[title="Move or copy to another space"]');
  const wait = async (cond, ms, step = 100) => { const t0 = Date.now(); for (;;) { if (cond()) return true; if (Date.now() - t0 > ms) return false; await sleep(step); } };
  const clicks = {};
  try {
    // preview Move button → move modal → current row disabled → target row → submit → modal
    // closes + card removed with NO skeleton flash (FIX H move-success path)
    clicks.card1 = clickGate(cardByName('t107-UI-Move'));
    out.previewOpens = await wait(() => !!previewMoveBtn(), 5000);
    clicks.moveBtn = clickGate(previewMoveBtn());
    out.moveModalOpens = await wait(() => !!modalRoot(), 5000);
    out.header = modalRoot() && modalRoot().querySelector('h2') ? modalRoot().querySelector('h2').textContent : null;
    const personalOpt = Array.from(document.querySelectorAll('div.max-w-md button')).find((b) => (b.textContent || '').trim() === 'Personal');
    // web-exact (:148): the current-location row is DISABLED — and while it is also the
    // selected row it wears the ACTIVE pill, not the greyed style (greyed is the non-selected
    // branch). Assert the disabled truth; carry the raw class for evidence.
    out.currentRowDisabled = !!personalOpt && personalOpt.disabled === true;
    out.personalOptRaw = personalOpt ? { disabled: personalOpt.disabled, className: personalOpt.className } : null;
    clicks.targetRow = clickGate(modalBtn('t107 Target'));
    // run-3 lesson: the row click and the submit click are in the SAME task — React defers the
    // re-render that ENABLES the submit until the task ends, so without a yield the submit
    // click lands on the still-disabled button (run-3 moveProbe: submitDisabled true, footer
    // stayed 'Move', no banner). Yield to let React flush before measuring/clicking.
    await sleep(250);
    const moveSubmit = footerBtn('Move');
    out.moveSubmitDisabled = moveSubmit ? moveSubmit.disabled : null;
    clicks.moveSubmit = clickGate(moveSubmit);
    out.moveModalClosed = await wait(() => !modalRoot(), 12000);
    // run-2 diagnostics: if the modal stayed, the footer text tells WHY — 'Moving…' = the
    // transfer promise is still pending; a banner = the transfer returned an error; 'Move' =
    // handleSubmit never ran (disabled/guard).
    out.moveFooterAfter = footerBtn('Move') ? footerBtn('Move').textContent : footerBtn('Moving...') ? 'Moving...' : null;
    const moveBanner = document.querySelector('div.max-w-md p.text-red-500');
    out.moveBanner = moveBanner ? moveBanner.textContent : null;
    // run-8 diagnostics: cardRemoved flaked (green5 true / green7 false while the move
    // committed main-side both times) — TIMELINE the card count/modal/skeleton at 150ms for
    // 6s instead of an end-state poll, so a leave-and-reappear (an in-flight list response
    // racing removeDropInPlace) is distinguishable from a never-left card.
    out.moveTimeline = [];
    let sawSkeleton = false;
    const mT0 = Date.now();
    while (Date.now() - mT0 < 6000) {
      const skel = !!document.querySelector('[class*="skeleton-shimmer"]');
      if (skel) sawSkeleton = true;
      // run-9 additions: a count=1 that never drops (green9: count 1 through 6s while the
      // record provably left personal main-side) needs the ghost's IDENTITY — computed
      // position (framer-motion popLayout exits are position:absolute), opacity and text —
      // to separate a stuck EXIT ghost from a genuinely live card.
      const ghost = cardByName('t107-UI-Move');
      out.moveTimeline.push([Date.now() - mT0, modalRoot() ? 1 : 0, cardCount('t107-UI-Move'), skel ? 1 : 0,
        ghost ? getComputedStyle(ghost).position : null,
        ghost ? (ghost.textContent || '').slice(0, 40) : null]);
      await sleep(150);
    }
    out.cardRemoved = out.moveTimeline.length > 0 && out.moveTimeline[out.moveTimeline.length - 1][2] === 0;
    out.moveCardCount = cardCount('t107-UI-Move');
    out.listCardTotal = document.querySelectorAll('div.select-none.cursor-pointer.group.overflow-hidden').length;
    out.noSkeleton = !sawSkeleton;
    // copy flow: preview → Move → toggle Copy → submit → the ORIGINAL's preview re-opens,
    // and the current list gains NOTHING (exactly one t107-UI-Copy card, the copy is in the target)
    clicks.card2 = clickGate(cardByName('t107-UI-Copy'));
    out.copyPreviewOpens = await wait(() => !!previewMoveBtn(), 5000);
    clicks.moveBtn2 = clickGate(previewMoveBtn());
    out.copyModalOpens = await wait(() => !!modalRoot(), 5000);
    clicks.copyToggle = clickGate(modalBtn('Copy'));
    // run-4 lesson: the fresh modal instance starts with the CURRENT location selected, so the
    // copy submit is DISABLED until a target row is picked — same React-flush yield as the move.
    clicks.copyTargetRow = clickGate(modalBtn('t107 Target'));
    await sleep(250);
    const copySubmit = footerBtn('Copy');
    out.copySubmitDisabled = copySubmit ? copySubmit.disabled : null;
    clicks.copySubmit = clickGate(copySubmit);
    out.copyModalClosed = await wait(() => !modalRoot(), 12000);
    const copyBanner = document.querySelector('div.max-w-md p.text-red-500');
    out.copyBanner = copyBanner ? copyBanner.textContent : null;
    out.copyReturnsToPreview = await wait(() => !!previewMoveBtn(), 5000);
    out.copyPreviewBody = document.querySelector('pre') ? document.querySelector('pre').textContent : null;
    out.copyCardCount = Array.from(document.querySelectorAll('div.select-none.cursor-pointer.group.overflow-hidden')).filter((c) => (c.textContent || '').includes('t107-UI-Copy')).length;
    // run-8 trail probe: the ← Back button renders ONLY when previewTrail.length > 1
    // (App.tsx:875 canBack; modal renders it at :211-221) — a live trail-length read without
    // touching React state. TRUE here = the copy flow pushed TWO entries (the reopen suspect).
    out.copyPreviewBackBtn = !!document.querySelector('div.max-w-3xl button[aria-label="Back"]');
    // close the preview via its backdrop (target === currentTarget → onBack = previewBack,
    // App.tsx:298-305 — pops ONE trail entry; the X button would be closePreview, clearing all).
    // run-8 lesson: the editorial PAGE ROOT is itself div.fixed.inset-0 (bg-[#FAF7F2]) and it
    // CONTAINS a div.max-w-3xl (the whole page, modals included), so the old first-match find()
    // clicked THE PAGE ROOT — a node with no close handler — and the preview never closed
    // (previewClosed false, deterministic across green5-8). Target the REAL preview backdrop:
    // the DARK overlay (bg-[#1a1a1a]/60 — the move modal's backdrop is the same color but wraps
    // max-w-md, not max-w-3xl).
    const previewRoot = Array.from(document.querySelectorAll('div.fixed.inset-0')).find((d) => String(d.className).includes('bg-[#1a1a1a]/60') && !!d.querySelector('div.max-w-3xl'));
    clicks.previewBackdrop = clickGate(previewRoot);
    out.previewClosed = await wait(() => !previewMoveBtn(), 5000);
    // run-6/7 mystery: the preview was OPEN again at bulk time (P[t107-UI-Copy]) although the
    // backdrop reported CLICKED — TIMELINE the panel/panel-count/h2/overlays at 120ms for
    // 3.2s to catch a close→reopen red-handed (or a never-closed), then re-read the trail
    // probe on whatever is open.
    out.previewTimeline = [];
    const pT0 = Date.now();
    while (Date.now() - pT0 < 3200) {
      const panels = document.querySelectorAll('div.max-w-3xl');
      out.previewTimeline.push([Date.now() - pT0, panels.length, panels[0] && panels[0].querySelector('h2') ? panels[0].querySelector('h2').textContent : null,
        Array.from(document.querySelectorAll('div.fixed.inset-0')).map((d) => String(d.className).slice(0, 30)).join('|')]);
      await sleep(120);
    }
    out.reopenBackBtn = !!document.querySelector('div.max-w-3xl button[aria-label="Back"]');
    out.overlaySnapshot = JSON.stringify(Array.from(document.querySelectorAll('div.fixed.inset-0')).map((d) => ({ cls: String(d.className).slice(0, 44), h2: d.querySelector('h2') ? d.querySelector('h2').textContent : null })));
    // bulk: Select → two cards → Move 2 pill → bulk modal → Cancel closes
    clicks.selectBtn = clickGate(Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Select'));
    // run-9 lesson (run-3 again): the selection-mode toggle and the first card click run in ONE
    // task — React defers the mode re-render, so the card clicks landed as PREVIEW opens
    // (P[t107-UI-Fail] occluded everything; clicks.cardCopy/cardFail "CLICKED" but opened
    // previews). Yield, then VERIFY the mode flipped before touching the cards.
    await sleep(250);
    out.selectionModeOn = !!Array.from(document.querySelectorAll('button')).find((b) => ['Deselect', 'Select all'].includes((b.textContent || '').trim()));
    clicks.cardCopy = clickGate(cardByName('t107-UI-Copy'));
    await sleep(250); // each selection toggle re-renders the pill counts — keep every click in its own task
    clicks.cardFail = clickGate(cardByName('t107-UI-Fail'));
    await sleep(250);
    out.bulkPillAppears = await wait(() => !!Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Move 2'), 5000);
    clicks.bulkPill = clickGate(Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Move 2'));
    out.bulkModalOpens = await wait(() => { const h = modalRoot() && modalRoot().querySelector('h2'); return !!h && h.textContent === 'Move 2 drops'; }, 5000);
    clicks.bulkCancel = clickGate(footerBtn('Cancel'));
    out.bulkModalCloses = await wait(() => !modalRoot(), 5000);
    clicks.cancelSelection = clickGate(Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Cancel'));
    // run-9: does the move-step ghost persist to script end? Live-vs-exit identity (computed
    // position + opacity) for every card root still matching the moved drop's name.
    out.ghostAtEnd = Array.from(document.querySelectorAll('div.select-none.cursor-pointer.group.overflow-hidden')).filter((c) => (c.textContent || '').includes('t107-UI-Move')).map((c) => ({ pos: getComputedStyle(c).position, op: getComputedStyle(c).opacity, txt: (c.textContent || '').slice(0, 30) }));
  } catch (e) {
    out.error = String(e && e.message ? e.message : e);
  }
  out.clicks = clicks;
  return JSON.stringify(out);
})()`;
                  const uiRes = JSON.parse(await win.webContents.executeJavaScript(uiScript, true)) as Record<string, unknown>;
                  // main-side ground truth: did the UI move actually commit (spaceId = target)?
                  const uiMoveMetaAfter = manager.getDropMeta(uiMove.id);
                  // forced failure: open the REAL preview via the c2f fixture, click Move, pick the
                  // target, DELETE the drop main-side, then submit — the transfer must come back
                  // with web's exact per-drop failure wording and the modal must STAY open.
                  await win.webContents.executeJavaScript(`window.__c2fEditTest.openPreview(${JSON.stringify(uiFail.id)})`, true);
                  await sleep(600);
                  const clickJs = (finder: string): string => `(function(){ var b = ${finder}; if (!b) return 'MISSING'; b.scrollIntoView({ block: 'center' }); var r = b.getBoundingClientRect(); var hit = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2); if (!hit || !(b === hit || b.contains(hit) || hit.contains(b))) return 'OCCLUDED'; b.click(); return 'CLICKED'; })()`;
                  const failClick1 = await win.webContents.executeJavaScript(clickJs(`document.querySelector('button[title="Move or copy to another space"]')`), true);
                  await sleep(700);
                  const failClick2 = await win.webContents.executeJavaScript(clickJs(`Array.from(document.querySelectorAll('div.max-w-md button')).find(function(x){ return (x.textContent||'').trim() === 't107 Target'; })`), true);
                  await sleep(250);
                  await manager.deleteDropQuiet(uiFail.id);
                  const failRes = JSON.parse(await win.webContents.executeJavaScript(`
(async () => {
  const out = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const submit = Array.from(document.querySelectorAll('div.max-w-md div.border-t button')).find((b) => (b.textContent || '').trim() === 'Move');
  out.submitFound = !!submit;
  out.submitDisabled = submit ? submit.disabled : null;
  if (submit && !submit.disabled) submit.click();
  const t0 = Date.now();
  out.bannerShown = false;
  out.bannerText = null;
  while (Date.now() - t0 < 8000) {
    const p = document.querySelector('div.max-w-md p.text-red-500');
    if (p && p.textContent) { out.bannerShown = true; out.bannerText = p.textContent; break; }
    await sleep(100);
  }
  out.modalStillOpen = !!document.querySelector('div.max-w-md');
  return JSON.stringify(out);
})()`, true)) as { bannerShown: boolean; bannerText: string | null; modalStillOpen: boolean; submitFound: boolean; submitDisabled: boolean | null };
                  const f_t107_uiWiring = uiRes.previewOpens === true && uiRes.moveModalOpens === true
                    && uiRes.header === 'Move drop' && uiRes.currentRowDisabled === true
                    && uiRes.moveModalClosed === true && uiRes.cardRemoved === true && uiRes.noSkeleton === true
                    && uiRes.copyModalOpens === true && uiRes.copyModalClosed === true
                    && uiRes.copyReturnsToPreview === true && uiRes.copyPreviewBody === 'copy preview body'
                    && uiRes.copyCardCount === 1
                    && uiRes.bulkPillAppears === true && uiRes.bulkModalOpens === true && uiRes.bulkModalCloses === true
                    && failRes.bannerShown === true && failRes.bannerText === '1/1 drops failed to move: Drop not found.'
                    && failRes.modalStillOpen === true;
                  console.log('[f107-ui]', JSON.stringify({
                    f_t107_uiWiring,
                    matrix: {
                      previewOpens: uiRes.previewOpens, moveModalOpens: uiRes.moveModalOpens, header: uiRes.header,
                      currentRowDisabled: uiRes.currentRowDisabled, moveModalClosed: uiRes.moveModalClosed,
                      cardRemoved: uiRes.cardRemoved, noSkeleton: uiRes.noSkeleton,
                      copyModalOpens: uiRes.copyModalOpens, copyModalClosed: uiRes.copyModalClosed,
                      copyReturnsToPreview: uiRes.copyReturnsToPreview, copyCardCount: uiRes.copyCardCount,
                      bulkPillAppears: uiRes.bulkPillAppears, bulkModalOpens: uiRes.bulkModalOpens, bulkModalCloses: uiRes.bulkModalCloses,
                      bannerShown: failRes.bannerShown, bannerText: failRes.bannerText, modalStillOpen: failRes.modalStillOpen,
                    },
                    raw: { clicks: uiRes.clicks, copyPreviewBody: uiRes.copyPreviewBody, failClicks: { move: failClick1, row: failClick2 }, submitDisabled: failRes.submitDisabled,
                      moveProbe: { moveSubmitDisabled: uiRes.moveSubmitDisabled, moveFooterAfter: uiRes.moveFooterAfter, moveBanner: uiRes.moveBanner, personalOptRaw: uiRes.personalOptRaw, moveCardCount: uiRes.moveCardCount, listCardTotal: uiRes.listCardTotal, uiMoveSpaceIdAfter: uiMoveMetaAfter ? uiMoveMetaAfter.spaceId : null },
                      copyProbe: { copySubmitDisabled: uiRes.copySubmitDisabled, copyBanner: uiRes.copyBanner, copyTargetRow: (uiRes.clicks as Record<string, unknown>).copyTargetRow } },
                  }));
                  // run-8: the FULL in-page out (incl. moveTimeline/previewTimeline, the
                  // previewClosed verdict, both trail probes and overlaySnapshot) plus main-side
                  // name-count probes — the shaped line above stays for cross-run comparability.
                  console.log('[f107-ui-full]', JSON.stringify({
                    uiRes,
                    mainProbe: {
                      uiMoveSpaceIdAfter: uiMoveMetaAfter ? uiMoveMetaAfter.spaceId : null,
                      uiMoveNamedInPersonal: manager.listDrops('personal').filter((d) => d.name === 't107-UI-Move').length,
                      uiCopyNamedInPersonal: manager.listDrops('personal').filter((d) => d.name === 't107-UI-Copy').length,
                    },
                  }));

                  // ---------- cleanup: leave NO t107 fixtures behind (the vault persists across runs) ----------
                  for (const rec of manager.allRecords()) {
                    if (rec.name.startsWith('t107-')) await manager.deleteDropQuiet(rec.id);
                  }
                  for (const cat of manager.listCategories('personal')) {
                    if (cat.name.startsWith('t107 ')) await manager.deleteCategoryQuiet(cat.id);
                  }
                  for (const space of manager.listSpaces()) {
                    if (space.name === 't107 Target' || space.name === 't107 Empty') await manager.deleteSpaceQuiet(space.id);
                  }
                  await manager.flushNow();
                  win.webContents.reload(); // fresh mount so the C2l Off leg boots sane
                  await sleep(4000);
                }

                // C2l (4b) — watchdog Off leg: with autoLockMinutes = null (explicit Off — legal
                // per the engine validator) the starved watchdog must NEVER lock. Same no-feed
                // discipline as the starve control above: sampling is DIRECT manager.status()
                // (no IPC, no renderer bridge round-trip), the renderer sits idle, zero gestures.
                // Honest scope: 90 s proves "no lock in a window where minutes=1 provably locks"
                // (the control above locked after ~83 s of starvation); the full 10-minute
                // equivalence rests on code review + the owner's hands-on, not a 10-minute leg.
                const offLegT0 = Date.now();
                const offSamples: Array<{ tMs: number; state: string }> = [];
                let autoLockOffStaysUnlocked90s = false;
                const offLegUnlocked = manager.status().state === 'unlocked';
                if (offLegUnlocked) {
                  await manager.setSettings({ autoLockMinutes: null });
                  while (Date.now() - offLegT0 < 92000) {
                    await sleep(10000);
                    offSamples.push({ tMs: Date.now() - offLegT0, state: manager.status().state });
                  }
                  autoLockOffStaysUnlocked90s = offSamples.length > 0
                    && offSamples.every((s) => s.state === 'unlocked');
                }
                console.log('[c2l-off]', JSON.stringify({
                  autoLockOffStaysUnlocked90s,
                  raw: { offLegUnlocked, elapsedMs: Date.now() - offLegT0, sampleCount: offSamples.length, offSamples },
                }));
                await manager.setSettings({ autoLockMinutes: 10 }); // C2l 4b — restore at stage end
                win.webContents.reload();
                await sleep(4000);
              }

              // Real-restart proof helper: leave a specific memory value behind for the NEXT
              // boot to read (DROPSYNC_CLOUD_DEV_MEM=local ⇒ next launch must open on Local).
              if (process.env.DROPSYNC_CLOUD_DEV_MEM === 'local') {
                await win.webContents.executeJavaScript(
                  "localStorage.setItem('dropsync.mode.last','local')"
                );
              }
            } catch (error) {
              console.error('[c1] failed:', error instanceof Error ? error.message : String(error));
            }
          })();
        }, 3000);
      }
    });
  }
  // Renderer dev server URL is injected by electron-vite via ELECTRON_RENDERER_URL.
  if (process.env.ELECTRON_RENDERER_URL) {
    // Sitting-2 battery AND the Sitting-3 round-trip need the dev-only __EXCAL hook — tag the
    // URL so main.tsx enables it. FIX 14's cache-size probe rides the same flag for DOM checks.
    // C2f-hotfix-1: the cloud battery needs the same tag for its guard fixture (__c2fEditTest
    // + __DC_METRICS), and its renderer-console lines are forwarded for failure visibility.
    const wantsHooks = process.env.DROPSYNC_E2E_S2 === '1' || process.env.DROPSYNC_E2E_SIT3 === '1'
      || process.env.DROPSYNC_SIT3_DOMCHECKS === '1' || process.env.DROPSYNC_CLOUD_DEV === '1';
    const devUrl = `${process.env.ELECTRON_RENDERER_URL}${wantsHooks ? '?e2eHooks' : ''}`;
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(fileURLToPath(new URL('.', import.meta.url)), '../renderer/index.html'));
  }
}

// DEV-ONLY (DROPSYNC_SIT3_BOOT_UNLOCK=1): pre-unlock the round-trip vault BEFORE the window
// exists, so the renderer's initial status probe mounts straight into the full editorial UI —
// lets the DOM-level checks (edit buttons, offline YouTube) run against real cards.
async function sit3BootUnlock(): Promise<void> {
  if (process.env.DROPSYNC_SIT3_BOOT_UNLOCK !== '1') return;
  try {
    await manager.unlock('/tmp/ds-e2e-sit3-vault-B', 'sit3-vault-pw-B');
    // Fixture hygiene (round 9): timer drills of past rounds left AGING expirations on reused
    // fixture cards. When one crosses its line mid-round the card vanishes from the personal
    // list and the DOM chain early-returns ('RT Note card not found'), silently stalling every
    // later stage — exactly what happened on 2026-08-25 (RT Note) with RT Target due next.
    // Drill-critical cards must never age out; imported-archive fixtures keep their timers.
    const NEVER_EXPIRE = new Set(['RT Note', 'RT Target', 'Loc7', 'Loc9']);
    for (const rec of manager.allRecords()) {
      if (rec.expiresAt && NEVER_EXPIRE.has(rec.name)) {
        await manager.mutatePublic({ op: 'drop.put', drop: { ...rec, expiresAt: null } });
        console.log('[sit3-boot] cleared fixture expiry on:', rec.name);
      }
    }
    console.log('[sit3-boot] vault B pre-unlocked');
  } catch (error) {
    console.error('[sit3-boot] pre-unlock failed:', error instanceof Error ? error.message : String(error));
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // PAC-2 FIX A — the menu that never was: the owner's real-Windows round 2 found the
    // DEFAULT Electron menu bar (File/Edit/View/Window) shipping on the installed v1.0.0 —
    // zero Menu usage exists in src/main (verified sweep, 2026-08-30), so the default menu
    // was never ours to show. Removing it also kills its reload/devtools accelerators, which
    // a shipped vault app should not carry anyway. BEFORE createWindow, once.
    Menu.setApplicationMenu(null);
    // 1.0.5 FIX B — the YouTube Referer stamp on the DEFAULT session, once at boot (the
    // Error 153 cure; see the attachYouTubeRefererStamp block above for the probe evidence).
    attachYouTubeRefererStamp(session.defaultSession);
    // PACKAGING-1 FIX A — boot best-effort, mirroring the currentTheme() pattern: an unlocked
    // (dev-harness) boot gets the true theme immediately; a locked boot starts 'light' and
    // corrects — the renderer's pre-unlock localStorage cache fixes the shell at first
    // main-window load, and the vault:unlock seam fixes it for real at unlock.
    applyFrameTheme(currentTheme());
    registerMediaProtocol();
    registerIpc();
    void sit3BootUnlock().then(() => {
      createWindow();
    });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  void manager.flushNow();
});

// ------------------------------------------------------------------ media:// protocol

function registerMediaProtocol(): void {
  protocol.handle('media', async (request) => {
    try {
      const url = new URL(request.url);
      const token = url.hostname === 'r' ? url.pathname.replace(/^\//, '') : url.hostname;
      const entry = manager.resolveMediaToken(token);
      if (!entry) return new Response('Not found', { status: 404 });

      const total = entry.totalBytes;
      const rangeHeader = request.headers.get('range');
      if (rangeHeader) {
        const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
        if (match) {
          let start = match[1] ? parseInt(match[1], 10) : 0;
          let end = match[2] ? parseInt(match[2], 10) : total - 1;
          if (Number.isNaN(start)) start = 0;
          if (Number.isNaN(end) || end >= total) end = total - 1;
          if (start > end || start >= total) {
            return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
          }
          const stream = manager.streamMedia(entry, start, end + 1);
          return new Response(stream as unknown as ReadableStream, {
            status: 206,
            headers: {
              'Content-Type': entry.mimeType,
              'Accept-Ranges': 'bytes',
              'Content-Length': String(end - start + 1),
              'Content-Range': `bytes ${start}-${end}/${total}`,
              // Lets <video> frames be drawn to canvas for offline thumbnails (media URLs are
              // unguessable session tokens; only our own renderer ever resolves media://).
              'Access-Control-Allow-Origin': '*',
            },
          });
        }
      }
      const stream = manager.streamMedia(entry, 0, Number.POSITIVE_INFINITY);
      return new Response(stream as unknown as ReadableStream, {
        status: 200,
        headers: {
          'Content-Type': entry.mimeType,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(total),
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (error) {
      console.error('[media] error:', error);
      return new Response('Media error', { status: 500 });
    }
  });
}

// ------------------------------------------------------------------ IPC

/** FIX 25 — channels exempt from activity tracking. The renderer's status-watch poll
 * (store/vault.tsx, every 8 s while unlocked) exists to DETECT main-side locks; counting it as
 * user activity perpetually reset lastActivity, so the idle auto-lock could never fire. Audit:
 * the only other always-on renderer timer (30 s heartbeat) touches local state only — no IPC;
 * UndoToast/useNow are local too; media streams ride the protocol handler, not ipcMain.handle.
 * Real user actions keep touching as before (exports also touch explicitly in exporter.ts). */
const ACTIVITY_EXEMPT_CHANNELS = new Set<string>(['vault:status']);

function handle(channel: string, listener: (event: Electron.IpcMainInvokeEvent, ...args: never[]) => unknown): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!ACTIVITY_EXEMPT_CHANNELS.has(channel)) manager.touch(); // renderer call = activity for idle auto-lock
    try {
      return await Promise.resolve(listener(event, ...(args as never[])));
    } catch (error) {
      return { __dropsyncError: error instanceof Error ? error.message : String(error) };
    }
  });
}

/** Unwrap the __dropsyncError envelope into a thrown Error on the renderer side. */
export function isDropsyncError(value: unknown): value is { __dropsyncError: string } {
  return !!value && typeof value === 'object' && '__dropsyncError' in value;
}

function requireWindow(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('No window.');
  return mainWindow;
}

function extensionForName(name: string, mimeType: string | undefined): string {
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1 && name.length - dot <= 8) return name.slice(dot);
  const map: Record<string, string> = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/ogg': '.ogv',
    'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.oga',
    'application/pdf': '.pdf', 'application/json': '.json', 'text/plain': '.txt',
  };
  return map[mimeType || ''] || '.bin';
}

function registerIpc(): void {
  // FIX 8 battery counter — counts REAL drop:getPayload calls. Always-on (a cheap increment);
  // readable/resettable ONLY through the dev-gated dev:testOnly channel below.
  let payloadFetchCount = 0;
  // FIX 3 battery counter — counts drop:list calls so the DOM battery can prove that closing
  // Settings triggers ZERO refetches.
  let dropListCallCount = 0;

  // ---- vault lifecycle
  handle('vault:create', (_e, folder: string, password: string) => manager.create(folder, password));
  handle('vault:unlock', async (_e, folder: string, password: string) => {
    await manager.unlock(folder, password);
    // PACKAGING-1 FIX A — main can only read settings AFTER unlock (assertUnlocked-guarded):
    // this is the moment a locked boot's 'light' fallback gets corrected for real.
    applyFrameTheme(manager.getSettings().theme);
    await recoverInterruptedImport(manager); // kill-during-import rollback on next unlock
    return manager.status();
  });
  handle('vault:lock', () => manager.lock());

  // ---- C2h cloud mode --------------------------------------------------------------------
  // Mode switches flip the VIEW ONLY (C2h owner decision): entering Cloud NEVER seals the vault
  // and leaving it NEVER required a lock — the EXISTING idle auto-lock (vault/vault.ts
  // startIdleWatch) remains the ONLY thing that locks, driven by lastActivity from REAL activity
  // in EITHER world. Activity feeding for the cloud view is wired where the view exists — see
  // initCloud's `onUserActivity` dep in cloud.ts (gestures there → manager.touch()). Entering
  // Cloud still never requires a vault: touch() on a locked/none state is harmless. The old
  // "leaving Local locks it" rule (CLOUD-MODE-PLAN §5) was REOPENED by the owner 2026-08-27.
  // C2m-hotfix-1 — overlapping flips SERIALIZE through a promise chain ("serial, like the
  // card pump"): beginMelt's ready handshake widened applyMode's async window to ~100-200 ms,
  // so a rapid flip arriving mid-melt used to early-return as a same-mode no-op (appMode not
  // yet swapped ⇒ the guard misread it) — a DROPPED flip. The chain makes every queued flip
  // apply, in arrival order. Rejections (invalid mode) still propagate to their caller
  // without poisoning the chain (the next link runs on either outcome).
  let modeApplyChain: Promise<'cloud' | 'local'> = Promise.resolve(appMode);
  /** C3 STEP 5 (D7) — race a promise against CAPTURE_DEADLINE_MS; the loser's result is
   * discarded. A capturePage() on a never-painted (dead cloud) view HANGS — try/catch
   * catches rejections, not hangs — and the serialized modeApplyChain queued every later
   * flip behind the stall (owner evidence §2.4: blocked a few tries). Timeout ⇒ null ⇒
   * the existing instant-flip fail-open. */
  const withTimeout = async <T>(p: Promise<T>, ms: number): Promise<T | null> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        p,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), ms);
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  };
  const applyModeNow = async (next: 'cloud' | 'local'): Promise<'cloud' | 'local'> => {
    if (next !== 'cloud' && next !== 'local') throw new Error('Invalid mode.');
    if (next === appMode) return appMode;
    // C2m — the dissolve plays ONLY for USER-armed flips (pill:flip stamps transitionArmedAt;
    // here the flag must still be warm). Boot-into-last-mode, dev probes, battery storms and
    // every programmatic applyMode stay INSTANT. The Settings-modal switch line stays instant
    // too (it never routes through pill:flip) — extendable later if the owner asks.
    const armed = Date.now() - transitionArmedAt < 10_000;
    transitionArmedAt = 0; // one-shot — an unapplied arm never outlives the next real flip
    // C2m FIX 3 step 1 — capture the OUTGOING world BEFORE the swap (fail-open: any error or
    // empty frame ⇒ null ⇒ today's instant flip; the effect can never break a flip).
    // Cloud→Local captures the SITE view; Local→Cloud captures the MAIN window's page (the
    // local page only — native overlays are separate views and never in the shot).
    // C3 STEP 5 (D7) — BOTH captures race the CAPTURE_DEADLINE_MS deadline; a hang or slow
    // frame ⇒ null ⇒ instant flip. A snapshot may never hold the flip chain hostage.
    let png: string | null = null;
    // PAC-3 FIX A — the flip's diagnostic clock (performance.now() deltas, one line per flip).
    const diagT0 = performance.now();
    let diagCaptureMs = -1;
    if (armed) {
      try {
        if (next === 'local') {
          png = cloudCtl ? await withTimeout(cloudCtl.captureViewPng(), CAPTURE_DEADLINE_MS) : null;
        } else if (mainWindow && !mainWindow.isDestroyed()) {
          const image = await withTimeout(mainWindow.webContents.capturePage(), CAPTURE_DEADLINE_MS);
          png = !image || image.isEmpty() ? null : `data:image/png;base64,${image.toPNG().toString('base64')}`;
        }
      } catch {
        png = null;
      }
      diagCaptureMs = performance.now() - diagT0;
    }
    // C2m-hotfix-1 (THE COVERED SWAP) step 2 — raise the curtain FIRST: beginMelt inflates
    // the fader over the OUTGOING world (identical pixels ⇒ seamless) and returns only when
    // the snapshot is fully painted (or false on deadline ⇒ instant flip below). The world
    // swap happens ONLY under a painted curtain — no new-world peek-through, no two-step melt.
    let ready = false;
    let diagReadyMs = -1;
    let diagPadMs = -1;
    if (png && cloudCtl) {
      // PAC-3 FIX A — a melt superseding an UNSETTLED predecessor (rapid flip mid-fade):
      // its done can never arrive (the page's show guard discards it) — flush its line now
      // so every USER flip gets exactly one [melt] line.
      if (meltDiagPending !== null) {
        const superseded = meltDiagPending;
        meltDiagPending = null;
        printMeltDiag(superseded, -1);
      }
      meltDiagReadyAt = -1; // only THIS melt's ready may feed the diagnostic
      const tMelt = performance.now();
      ready = await cloudCtl.beginMelt(png);
      const tSwap = performance.now();
      if (ready && meltDiagReadyAt >= 0) {
        diagReadyMs = meltDiagReadyAt - tMelt; // decode + two-rAF submission ack (PAC-3)
        diagPadMs = tSwap - meltDiagReadyAt; // the MELT_SWAP_PAD_MS tail inside beginMelt
      }
    }
    if (next === 'cloud') {
      appMode = 'cloud';
      if (!cloudCtl) throw new Error('Cloud controller unavailable.');
      cloudCtl.show();
    } else {
      appMode = 'local';
      cloudCtl?.hide();
      // C3 STEP 4 — the veil is cloud-only: reaching Local clears ANY active offline state
      // (entry-failed veil or degraded chip) — the edge case the order names. Idempotent.
      cloudCtl?.clearOfflineState();
    }
    // C2f FIX 2 — the knob slides ONLY when the mode ACTUALLY applied (never on request).
    cloudCtl?.setPillMode(appMode);
    // C2m-hotfix-1 step 3 — the swap is hidden; start the fade over the live new world. No
    // curtain in time ⇒ cancel (collapse) — the fail-open path, nothing left behind.
    if (png && cloudCtl) {
      if (ready) {
        cloudCtl.runMelt();
        // PAC-3 FIX A — the line completes when the melt settles (fader:done handler).
        meltDiagPending = {
          armed, captureMs: diagCaptureMs, readyMs: diagReadyMs, padMs: diagPadMs,
          tSwap: performance.now(),
        };
      } else {
        cloudCtl.cancelMelt();
        printMeltDiag({ armed, captureMs: diagCaptureMs, readyMs: diagReadyMs, padMs: diagPadMs }, -1);
      }
    } else if (armed) {
      // PAC-3 FIX A — no snapshot ⇒ no melt (instant flip): still ONE line for this USER flip
      // (negative fields = the phase never happened).
      printMeltDiag({ armed, captureMs: diagCaptureMs, readyMs: diagReadyMs, padMs: diagPadMs }, -1);
    }
    return appMode;
  };
  const applyMode = (next: 'cloud' | 'local'): Promise<'cloud' | 'local'> => {
    const run = (): Promise<'cloud' | 'local'> => applyModeNow(next);
    modeApplyChain = modeApplyChain.then(run, run);
    return modeApplyChain;
  };
  applyCloudMode = applyMode;
  handle('mode:get', () => appMode);
  handle('mode:set', (_e, next: 'cloud' | 'local') => applyCloudMode(next));
  // C2f FIX 2 — the pill's ONE outbound channel: forward the flip request to the MAIN window
  // renderer, which runs the EXISTING guarded switchMode (unsaved-work discard-confirm
  // included). The pill never switches anything by itself. Then give keyboard focus back.
  // C3 STEP 4 — the body is FACTORED into requestUserFlip so the status veil's
  // [Switch to Local] button rides THE SAME user-flip path (arm stamp + pill room + relay +
  // focus return): one user-flip path, no duplicates (D5/D8 — the card-button flip melts
  // exactly like a pill click, and from a dead page the D7 deadline keeps it instant).
  const requestUserFlip = (next: 'cloud' | 'local'): void => {
    if (next !== 'cloud' && next !== 'local') return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // C2m — arm the flip dissolve: THIS path is the user path. applyMode melts only while
    // the stamp is warm (< 10 s); everything programmatic stays instant.
    transitionArmedAt = Date.now();
    // C2g-hotfix-6 FIX 2 — arm the Style A flip room BEFORE relaying: the 124 × 28 skirt must
    // be in place before the renderer's guarded switch lands the knob's class and the elastic
    // transform starts (its overshoot paints past the trough's ends instead of clipping).
    cloudCtl?.beginPillFlip();
    console.log('[pill] flip requested →', next);
    mainWindow.webContents.send('pill:flipRequested', next);
    cloudCtl?.blurPill();
  };
  ipcMain.on('pill:flip', (_e, next: 'cloud' | 'local') => {
    if (next !== 'cloud' && next !== 'local') return;
    pillFlipRelayCount += 1; // C2g-hotfix-1 §5 — receipts of REAL pill:flip ipc (status-driven
    // flips deliberately do NOT increment: this counter means pill clicks, robot-leg evidence)
    requestUserFlip(next);
  });
  // C3 STEP 1 — the status layer's action buttons land here (preload enum-checked, main
  // re-checks): cancel the shown download / take the guarded user-flip home / retry the
  // dead page (veil stays up while trying).
  ipcMain.on('status:action', (_e, a: unknown) => {
    if (!a || typeof a !== 'object') return;
    const id = (a as { id?: unknown }).id;
    if (id === 'cancel') {
      cloudCtl?.statusCancelDownload();
    } else if (id === 'switch-local') {
      requestUserFlip('local');
    } else if (id === 'retry') {
      cloudCtl?.offlineRetry();
    }
  });
  // C3 STEP 1 — the page measured its chip content: main snaps the native room to the
  // measured width (zero-miss click rule). Double-validated (preload already did). Payload
  // is {width:number} per the C3 channel inventory.
  ipcMain.on('status:measure', (_e, p: unknown) => {
    if (!p || typeof p !== 'object') return;
    const w = (p as { width?: unknown }).width;
    if (typeof w !== 'number' || !Number.isFinite(w) || w < 0 || w > 2000) return;
    cloudCtl?.statusMeasured(Math.round(w));
  });
  // C2g FIX 3 — Style B hover coupling: the layer reports enter/leave, main resizes the native
  // view (re-centered) in the same tick its CSS bloom starts. Strictly validated.
  ipcMain.on('pill:bloom', (_e, on: unknown) => {
    if (typeof on !== 'boolean') return;
    cloudCtl?.setPillBloom(on);
  });
  // C2g FIX 4 — right-click style toggle: main persists to disk + re-asserts bounds.
  ipcMain.on('pill:setStyle', (_e, style: unknown) => {
    if (style !== 'A' && style !== 'B') return;
    cloudCtl?.setPillStyle(style);
  });
  // C2g-hotfix-1 FIX 3 — the layer asks on load; reply IMMEDIATELY with the true mode and the
  // true style. Kills the queued-mode race permanently (queue stays as belt-and-braces).
  ipcMain.on('pill:ready', () => {
    if (!cloudCtl) return;
    cloudCtl.resyncPill(appMode);
  });
  // C2j — the reminder card was clicked: dismiss it (advances the queue) + focus/restore the
  // window, mirroring the native toast's click block (LEG 1).
  ipcMain.on('card:click', (_e, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) return;
    cloudCtl?.reminderClick(id);
  });
  // C2m — the fader page reports its melt settled (transitionend or the page's safety net):
  // collapse to 0×0 + hidden NOW. Idempotent — the grace deadline and repeats are no-ops.
  ipcMain.on('fader:done', () => {
    // PAC-3 FIX A — complete THIS melt's diagnostic line before the collapse bookkeeping
    // (a pending record here is always the melt that just settled).
    if (meltDiagPending !== null) {
      const settled = meltDiagPending;
      meltDiagPending = null;
      printMeltDiag(settled, performance.now() - settled.tSwap);
    }
    cloudCtl?.faderDone();
  });
  // C2m-hotfix-1 — the fader page reports its curtain painted (snapshot decoded + committed):
  // resolve the pending beginMelt ⇒ main may swap the world beneath it. Strays are no-ops.
  ipcMain.on('fader:ready', () => {
    meltDiagReadyAt = performance.now(); // PAC-3 FIX A — the submission ack landed (diagnostic)
    cloudCtl?.faderReady();
  });
  // PAC-2 FIX B — the PICKER page's relay (our OWN sixth trusted page — the card:click house
  // pattern: registered ONCE here, delegated into cloud.ts's picker state). The pick/cancel
  // validation and the session whitelist live in cloud.ts; these handlers only forward.
  ipcMain.on('picker:ready', () => {
    cloudCtl?.pickerReady();
  });
  ipcMain.on('picker:pick', (_e, id: unknown, audio: unknown) => {
    cloudCtl?.pickerPick(id, audio);
  });
  ipcMain.on('picker:cancel', () => {
    cloudCtl?.pickerCancel();
  });
  // DEV-ONLY probes (I6): never registered without DROPSYNC_CLOUD_DEV=1.
  if (process.env.DROPSYNC_CLOUD_DEV === '1') {
    handle('mode:devProbe', async () => {
      if (!cloudCtl) throw new Error('Cloud controller unavailable.');
      const st = cloudCtl.probeState();
      const isolation = await cloudCtl.probeIsolation();
      const authSeen = await cloudCtl.probeAuthSeen();
      return { mode: appMode, ...st, isolation, authSeen };
    });
    handle('mode:c2Evidence', (_e, evidence: unknown) => {
      const tagged = evidence as { c2cTag?: string };
      const line = tagged && tagged.c2cTag === 'pillfloat' ? '[c2c]' : '[c2]';
      console.log(line, JSON.stringify(evidence));
    });
  }
  handle('vault:changePassword', (_e, oldPassword: string, newPassword: string) => manager.changePassword(oldPassword, newPassword));
  handle('vault:status', () => manager.status());
  handle('vault:probeFolder', (_e, folder: string) => manager.probeFolder(folder));
  handle('vault:prepareFolder', (_e, folder: string) => manager.prepareFolder(folder));
  handle('vault:move', (_e, newParentFolder: string) => manager.moveVault(newParentFolder));

  // ---- spaces + categories
  handle('vault:listSpaces', () => manager.listSpaces());
  handle('vault:createSpace', (_e, name: string) => manager.createSpace(name));
  // FIX 19 — workspace rename + delete through the normal mutation queue/journal.
  handle('vault:renameSpace', (_e, id: string, name: string) => manager.renameSpace(id, name));
  handle('vault:deleteSpace', (_e, id: string) => manager.deleteSpace(id));
  handle('vault:listCategories', (_e, spaceId: string) => manager.listCategories(spaceId));
  handle('vault:createCategory', (_e, spaceId: string, name: string) => manager.createCategory(spaceId, name));
  handle('vault:deleteCategory', (_e, id: string) => manager.deleteCategory(id));

  // ---- drops
  handle('drop:list', (_e, spaceId: string) => {
    dropListCallCount += 1; // battery counter (FIX 3 verification)
    return manager.listDrops(spaceId);
  });
  handle('drop:getMeta', (_e, dropId: string) => manager.getDropMeta(dropId));
  handle('drop:getPayload', async (_e, dropId: string) => {
    payloadFetchCount += 1; // battery counter (FIX 8 verification) — exposed ONLY via dev:testOnly
    const meta = manager.getDropMeta(dropId);
    if (!meta) return null;
    if (meta.type !== 'text') return { text: undefined };
    return manager.getTextPayload(dropId);
  });
  handle('drop:patch', (_e, dropId: string, patch: Parameters<VaultManager['patchDropMeta']>[1]) => manager.patchDropMeta(dropId, patch));
  handle('drop:delete', (_e, dropId: string) => manager.deleteDrop(dropId));

  // ---- media
  let mediaByteFetchCount = 0; // FIX 20 battery counter (gated exposure only)
  handle('media:getUrl', (_e, dropId: string, kind: 'file' | 'image') => manager.getMediaUrl(dropId, kind));
  handle('media:getBytes', async (_e, dropId: string, kind: 'file' | 'image') => {
    mediaByteFetchCount += 1; // cheap always-on increment; readable ONLY via dev:testOnly
    return manager.getBlobBytes(dropId, kind);
  });

  // ---- create / edit (Sitting 2). Progress rides the existing import-progress channel with a
  // distinct phase ('fileCreate' / 'youtubeTitle').
  const progressEmit = (phase: string) => (p: { phase: string; processedBytes: number; totalBytes: number; currentName?: string; message?: string }) => {
    void phase;
    mainWindow?.webContents.send('vault:importProgress', p);
  };
  handle('drop:createText', async (_e, args: CreateTextArgs) => {
    const record = await createTextDrop(manager, args, progressEmit('fileCreate'));
    await manager.flushNow();
    return manager.getDropMeta(record.id);
  });
  handle('drop:createFileFromPath', async (_e, absolutePath: string, meta: CreateMetaBase & { displayName?: string; mimeType?: string }) => {
    const { record } = await createFileDropFromPath(manager, absolutePath, meta, progressEmit('fileCreate'));
    await manager.flushNow();
    return manager.getDropMeta(record.id);
  });
  handle('drop:createFileFromBytes', async (_e, bytes: Uint8Array, displayName: string, mimeType: string | undefined, meta: CreateMetaBase) => {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const { record } = await createFileDropFromBytes(manager, data, displayName, mimeType, meta, progressEmit('fileCreate'));
    await manager.flushNow();
    return manager.getDropMeta(record.id);
  });
  handle('drop:updateContent', async (_e, dropId: string, updates: UpdateContentArgs) => {
    const record = await updateTextDropContent(manager, dropId, updates, progressEmit('fileCreate'));
    await manager.flushNow();
    return manager.getDropMeta(record.id);
  });
  handle('drop:updateMeta', async (_e, dropId: string, patch: UpdateMetaPatch) => {
    const record = await updateTextDropMeta(manager, dropId, patch);
    await manager.flushNow();
    return manager.getDropMeta(record.id);
  });
  // Round 107 (repair-order-107 §4 FIX D) — the ONE transfer handler, mirroring the
  // drop:updateMeta shape exactly: await the op → flushNow → return the result. Category
  // pre-flight + per-drop isolation live in transferDrops (dropOps.ts); ok:false rides back
  // as a VALUE (not a throw) so the modal can show web's exact pre-flight wording.
  handle('drop:transfer', async (_e, args: { mode: 'move' | 'copy'; dropIds: string[]; targetSpaceId: string }) => {
    const out = await transferDrops(manager, args);
    await manager.flushNow();
    return out;
  });

  // ---- YouTube title refresh (the app's ONLY online call — main process, on demand)
  handle('youtube:refreshTitles', async (_e, spaceId: string) => {
    // FIX 9: return the records whose labels actually changed so the renderer can patch them
    // in place instead of refetching the whole space (no skeleton blink).
    const labelsBefore = new Map(manager.listDropsIncludingExpired(spaceId).map((d) => [d.id, JSON.stringify(d.youtubeVideoLabels ?? [])]));
    const result = await refreshYouTubeTitles(manager, spaceId, { online: net.isOnline(), emit: progressEmit('youtubeTitle') });
    await manager.flushNow();
    const updatedDrops = manager
      .listDropsIncludingExpired(spaceId)
      .filter((d) => labelsBefore.get(d.id) !== undefined && labelsBefore.get(d.id) !== JSON.stringify(d.youtubeVideoLabels ?? []))
      .map((d) => d.id);
    return { ...result, updatedDrops: updatedDrops.map((id) => manager.getDropMeta(id)).filter((d): d is NonNullable<typeof d> => !!d) };
  });

  // ---- Open in browser (https-only — the one shell surface the renderer gets)
  handle('shell:openExternal', async (_e, url: string) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('That link could not be opened.');
    }
    if (parsed.protocol !== 'https:') throw new Error('Only https links can be opened.');
    await shell.openExternal(parsed.toString());
    return true;
  });

  // ---- settings
  handle('vault:settingsGet', () => manager.getSettings());
  handle('vault:settingsSet', async (_e, patch: Record<string, unknown>) => {
    const next = await manager.setSettings(patch);
    // PACKAGING-1 FIX A — the settings-write path is where main learns every theme change
    // (the renderer's setTheme and updateSettings both funnel through this one channel); the
    // shell follows the VALIDATED result (the patch may not even carry a theme).
    applyFrameTheme(next.theme);
    return next;
  });

  // ---- import (.dropsync → vault)
  handle('vault:importInspect', (_e, filePath: string, password: string) => inspectArchive(filePath, password, undefined, (progress) => {
    mainWindow?.webContents.send('vault:importProgress', progress);
  }));
  handle('vault:importRun', async (_e, options: { filePath: string; password: string; destination: ImportDestination }) => {
    const result = await importArchive({
      manager,
      filePath: options.filePath,
      password: options.password,
      destination: options.destination,
      signal: undefined,
      onProgress: (progress) => mainWindow?.webContents.send('vault:importProgress', progress),
    });
    await manager.flushNow();
    return result;
  });
  handle('vault:typeMismatch', (_e, flavor: string, expectedScope: 'personal' | 'workspace') =>
    desktopTypeMismatchMessage(flavor, expectedScope));
  handle('vault:hasArchiveOverlap', (_e, spaceId: string, archiveId: string) =>
    manager.listDropsIncludingExpired(spaceId).some((d) => d.importedFromArchiveId === archiveId && !(d.expiresAt && new Date(d.expiresAt).getTime() <= Date.now())));

  // ---- export-back (.dropsync writer, M5). One export at a time; cancellable mid-stream.
  let exportAbort: AbortController | null = null;
  handle('vault:export', async (_e, scope: 'personal' | { workspaceId: string }, password: string, outPath: string) => {
    if (exportAbort) throw new Error('An export is already running.');
    exportAbort = new AbortController();
    try {
      const summary = await exportSpaceArchive({
        manager,
        scope,
        password,
        outPath,
        signal: exportAbort.signal,
        onProgress: (progress) => mainWindow?.webContents.send('vault:importProgress', progress),
      });
      await manager.flushNow();
      return summary;
    } finally {
      exportAbort = null;
    }
  });
  handle('vault:exportCancel', () => {
    exportAbort?.abort();
    return true;
  });

  // ---- Save As (native dialog every time — LOCKED decision 11)
  handle('drop:saveAs', async (_e, dropId: string, kind: 'file' | 'image') => {
    const meta = manager.getDropMeta(dropId);
    if (!meta) return { path: null };
    const url = manager.getMediaUrl(dropId, kind);
    if (!url) return { path: null };
    const entry = manager.resolveMediaToken(url.split('/').pop()!);
    if (!entry) return { path: null };
    const suggestedBase = kind === 'image'
      ? `${meta.name || 'image'}${(meta.imageMimeType || 'image/png') === 'image/png' ? '' : ''}`
      : meta.name || 'download';
    const suggested = kind === 'image'
      ? `${suggestedBase}${extensionForName(suggestedBase, meta.imageMimeType)}`
      : `${suggestedBase}`;
    const result = await dialog.showSaveDialog(requireWindow(), {
      defaultPath: suggested,
    });
    if (result.canceled || !result.filePath) return { path: null };
    // 1.0.6 FIX B/C — the Local ✓-Saved chip (owner wish, parked since 1.0.5): the chip layer
    // floats over BOTH worlds (mainWindow-content chip room), so Local Save-As now speaks to
    // it. Saving shows only AFTER the dialog — a cancel stays silent (Cloud parity, 1.0.5
    // FIX A); success flashes ✓ Saved; failure hides quietly — the IPC rejection below stays
    // the one error signal.
    cloudCtl?.localSaveChip({ phase: 'saving', name: suggested });
    try {
      // Stream decrypt → chosen path (never buffers the whole file for big blobs).
      const decrypted = manager.streamMedia(entry, 0, Number.POSITIVE_INFINITY);
      const nodeReadable = Readable.fromWeb(decrypted as unknown as import('node:stream/web').ReadableStream);
      await pipeline(nodeReadable, createWriteStream(result.filePath));
      cloudCtl?.localSaveChip({ phase: 'done' });
      return { path: result.filePath };
    } catch (err) {
      cloudCtl?.localSaveChip({ phase: 'fail' });
      throw err;
    }
  });

  // ---- dialogs
  handle('dialog:pickOpen', (_e, options: { title?: string; extensions?: string[] }) => {
    // DOM-harness stub (env-gated twice): let the battery drive the REAL ImportModal without a
    // native dialog. Only active with DROPSYNC_SIT3_DOMCHECKS + an explicit fixture path.
    if (process.env.DROPSYNC_SIT3_DOMCHECKS === '1' && process.env.DROPSYNC_FAKE_PICK_OPEN) {
      return Promise.resolve(process.env.DROPSYNC_FAKE_PICK_OPEN);
    }
    return dialog.showOpenDialog(requireWindow(), {
      title: options.title || 'Choose a file',
      properties: ['openFile'],
      filters: options.extensions ? [{ name: 'Files', extensions: options.extensions }] : undefined,
    }).then((r) => (r.canceled ? null : r.filePaths[0] ?? null));
  });
  handle('dialog:pickOpenMultiple', (_e, options: { title?: string; extensions?: string[] }) =>
    dialog.showOpenDialog(requireWindow(), {
      title: options.title || 'Choose files',
      properties: ['openFile', 'multiSelections'],
      filters: options.extensions ? [{ name: 'Files', extensions: options.extensions }] : undefined,
    }).then((r) => (r.canceled ? [] : r.filePaths)));
  handle('dialog:pickSave', (_e, options: { suggestedName?: string }) =>
    dialog.showSaveDialog(requireWindow(), { defaultPath: options.suggestedName }).then((r) => (r.canceled ? null : r.filePath ?? null)));
  handle('dialog:pickFolder', (_e, options: { title?: string }) =>
    dialog.showOpenDialog(requireWindow(), {
      title: options.title || 'Choose a folder',
      properties: ['openDirectory', 'createDirectory'],
    }).then((r) => (r.canceled ? null : r.filePaths[0] ?? null)));

  // ---- notifications (local Windows notifications while running)
  handle('notify', (_e, title: string, body: string) => {
    if (Notification.isSupported()) new Notification({ title, body }).show();
    return true;
  });

  // Reminder loop → native notification. Clicking the toast focuses the window; when the
  // platform can't show notifications (some dev environments), fall back to an in-app toast
  // event — never a crash (spec M6).
  const notifyFallback = (title: string, body: string): void => {
    mainWindow?.webContents.send('vault:notifyFallback', { title, body });
  };
  // Reminder loop → THREE delivery legs (C2j — owner LOCKED: never rely on one channel again).
  // LEG 1 native: the legacy Windows toast path kept byte-identical (click focuses the window;
  //   an unsupported platform falls back to the legacy in-app event; a throw warns + falls back).
  // LEG 2 overlay: OUR reminder card over whichever world is on screen — ALWAYS (cloud.ts's
  //   trusted third layer; WSLg can swallow toasts, it cannot swallow a native view we own).
  // LEG 3 missed: when the app wasn't front-and-center at fire time, the reminder re-surfaces
  //   oldest-first on the next window focus (overlay only).
  // DORMANCY RULING (C2j §1): the legacy `vault:notifyFallback` renderer wiring stays UNWIRED
  // by design from now on — it has had zero subscribers since baseline 90edc85 and the overlay
  // replaces it. The emission here stays byte-identical; nothing renderer-side listens. DO-NOT-FIX.
  const engineNotify = (title: string, body: string): void => {
    if (!Notification.isSupported()) {
      notifyFallback(title, body);
    } else {
      try {
        const toast = new Notification({ title, body });
        toast.on('click', () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
          }
        });
        toast.show();
      } catch (error) {
        console.warn('[notify] failed, using in-app fallback:', error);
        notifyFallback(title, body);
      }
    }
    cloudCtl?.reminderShow(title, body, currentTheme()); // LEG 2 — ALWAYS (C2j red-proof: comment me out); C2k — CURRENT theme
    if (!mainWindow || mainWindow.isMinimized() || !mainWindow.isFocused()) {
      cloudCtl?.enqueueMissed(title, body); // LEG 3 — cannot be seen anywhere right now
    }
  };
  manager.setNotifier(engineNotify);
  engineNotifier = engineNotify; // DEV battery tap-point: the exact function the engine calls

  // ---- DEV-ONLY test seeds (DROPSYNC_E2E_SIT3=1 or the DOM-checks harness). Registered
  // exclusively under harness env flags so production IPC surface stays untouched.
  // C2i FIX D — DROPSYNC_CLOUD_DEV joins the gate: its battery consumes the SAME
  // listCallStats/resetListCallCount counter exposure the S2 zero-refetch leg uses.
  if (process.env.DROPSYNC_E2E_SIT3 === '1' || process.env.DROPSYNC_SIT3_DOMCHECKS === '1'
    || process.env.DROPSYNC_CLOUD_DEV === '1') {
    handle('dev:testOnly', async (_e, action: string, dropId: string, value?: number) => {
      if (action === 'expireDrop') {
        // Backdate expiresAt to 1 minute ago through the normal journal chain.
        const record = manager.findDrop(dropId);
        void record;
        return manager.mutatePublic({ op: 'drop.meta', id: dropId, patch: { expiresAt: new Date(Date.now() - 60_000).toISOString() } });
      }
      if (action === 'bloatFileSize') {
        // Simulate a >20 GB payload for the export cap refusal test (recorded size only — no bytes).
        return manager.mutatePublic({ op: 'drop.meta', id: dropId, patch: { fileSize: 21 * 1024 * 1024 * 1024 } });
      }
      if (action === 'setFileSize' && typeof value === 'number') {
        // Restore a truthful recorded size after the bloat test.
        return manager.mutatePublic({ op: 'drop.meta', id: dropId, patch: { fileSize: value } });
      }
      if (action === 'payloadFetchStats') {
        return { count: payloadFetchCount };
      }
      if (action === 'resetPayloadFetchCount') {
        payloadFetchCount = 0;
        return { count: payloadFetchCount };
      }
      if (action === 'listCallStats') {
        return { count: dropListCallCount };
      }
      if (action === 'resetListCallCount') {
        dropListCallCount = 0;
        return { count: dropListCallCount };
      }
      // FIX 16 battery: token-map sanity (tokens and composite keys must stay 1:1).
      if (action === 'mediaStats') {
        return manager.mediaTokenStats();
      }
      // FIX 20 battery: count REAL media:getBytes calls (the drawing PNG byte-fetch channel) so
      // the manifest-scene editor path can prove ZERO byte fetches. The increment itself lives
      // in the always-on media:getBytes handler below; exposure is gated like every dev action.
      if (action === 'mediaByteFetchStats') {
        return { count: mediaByteFetchCount };
      }
      if (action === 'resetMediaByteFetchCount') {
        mediaByteFetchCount = 0;
        return { count: mediaByteFetchCount };
      }
      // FIX 19 battery: how many .vblob files exist right now — proves a deleted space's blobs
      // are swept by the unlock orphan sweep.
      if (action === 'blobFileCount') {
        const { readdir } = await import('node:fs/promises');
        try {
          return { count: (await readdir(manager.blobsDir)).filter((f) => f.endsWith('.vblob')).length };
        } catch {
          return { count: -1 };
        }
      }
      // FIX 16 battery: prove session scoping — tokens die on lock and are NOT resurrected.
      if (action === 'vaultLock') {
        await manager.lock();
        return { locked: true };
      }
      if (action === 'vaultUnlock') {
        await manager.unlock('/tmp/ds-e2e-sit3-vault-B', 'sit3-vault-pw-B');
        return { locked: false };
      }
      throw new Error(`Unknown dev:testOnly action: ${action}`);
    });
  }
}
