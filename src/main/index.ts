/**
 * Electron main process — window, privileged IPC, media:// streaming protocol.
 *
 * Security posture (locked by spec): contextIsolation true, nodeIntegration false, sandbox true;
 * every capability sits behind contextBridge 'dropsync' in the preload. Crypto and vault state
 * live ONLY here. Big bytes stream disk↔main; the renderer receives DTOs, text payloads it asks
 * for, and opaque media:// tokens.
 */

import { app, BrowserWindow, ipcMain, dialog, Notification, protocol, shell, net } from 'electron';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';import { createWriteStream, readFileSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import { VaultManager } from './vault/vault.ts';
import { initCloud, attachCloudResizeTracking, PILL_TOP, PILL_W, PILL_H, PILL_B_REST_W, PILL_BLOOM_PAD_X, PILL_BLOOM_PAD_Y, PILL_A_FLIP_PAD_X, type CloudController } from './cloud';
import { inspectArchive, importArchive, recoverInterruptedImport, desktopTypeMismatchMessage, type ImportDestination } from './vault/importer.ts';
import { exportSpaceArchive } from './vault/exporter.ts';
import {
  createTextDrop,
  createFileDropFromPath,
  createFileDropFromBytes,
  updateTextDropContent,
  updateTextDropMeta,
  refreshYouTubeTitles,
  type CreateTextArgs,
  type CreateMetaBase,
  type UpdateContentArgs,
  type UpdateMetaPatch,
} from './vault/dropOps.ts';

// Media scheme must be registered as privileged BEFORE app ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, stream: true, supportFetchAPI: true, secure: true } },
]);

// The UI is text/lists/images — GPU compositing buys nothing here, and hardware acceleration
// hard-crashes under WSL2's virtual GPU ("GPU process isn't usable"). Software rendering keeps
// dev-under-WSL and production-Windows behavior identical.
app.disableHardwareAcceleration();

// DEV WORKAROUND (WSL only): the new WSL2 kernel intermittently kills Chromium's sandboxed
// children (network service → zygote → GPU), FATALing the app minutes into use. Running the
// desktop dev app unsandboxed avoids it entirely. Production Windows builds are unaffected.
if (process.env.DROPSYNC_NOSANDBOX === '1') {
  app.commandLine.appendSwitch('no-sandbox');
}

// DEV WORKAROUND (WSL only): WSL2 kernel 6.18 intermittently fails Chromium's /dev/shm
// shared-memory operations with nonsensical ESRCH errors (taking sandboxed children down with
// them), FATALing the app minutes into use. disable-dev-shm-usage makes Chromium back shared
// memory with plain temp files instead of /dev/shm. Production Windows builds are unaffected.
app.commandLine.appendSwitch('disable-dev-shm-usage');

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
let appMode: 'cloud' | 'local' = 'local'; // relaunch always starts Local in C1 (remember-last-mode = C2)
/** Assigned by registerIpc — shared by mode:set and the DEV probe's switch storm. */
let applyCloudMode: (next: 'cloud' | 'local') => Promise<'cloud' | 'local'> = async () => appMode;
let pillFlipRelayCount = 0; // C2g-hotfix-1 §5 — receipts of REAL pill:flip ipc (incremented in the relay)
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
  cloudCtl = initCloud(mainWindow, { onUserActivity: () => manager.touch() });
  attachCloudResizeTracking(mainWindow, cloudCtl);
  // C2f FIX 2 — the pill must show the app's ACTUAL boot mode (relaunch starts Local; the
  // renderer's boot-into-last-mode may immediately flip it via mode:set). Queued until the
  // pill layer finishes loading; delivered automatically.
  cloudCtl.setPillMode(appMode);
  // Polish sweep #1: the window title is ALWAYS "DropSync" — renderer document.title changes
  // (dev overlays, hash routes) are ignored.
  mainWindow.on('page-title-updated', (event) => event.preventDefault());
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
                const centeredOk = (r: Electron.Rectangle, w: number, cw: number): boolean =>
                  Math.abs(r.x - Math.round((cw - w) / 2)) <= 1 && r.y === PILL_TOP
                  && r.width === w && r.height === PILL_H;
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
                const waitBounded = async (w: number): Promise<boolean> => {
                  for (let i = 0; i < 12; i++) { // ≤6s: watchdog + deferred re-apply budget
                    await sleep(500);
                    const p = await g.pillProbe();
                    if (centeredOk(p.bounds, w, win.getContentBounds().width)) return true;
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

                // f_c2g_geometry — footprint truth PER STATE: A = 112 × 28 @y10; B rest = 28 × 28
                // @y10 (zero-miss footprint sacred); B BLOOMED = the 132 × 44 ROOM @y2
                // (hotfix-4 FIX 2). Plus hotfix-3's A-side LAYOUT asserts (row display — computed
                // value blockifies to `flex` on the abspos element — and Local's rect top 2±0.5)
                // whenever style A is up.
                const geoLegs: Array<{ tag: string; ok: boolean; disp?: string; localTop?: number; room?: [number, number, number] }> = [];
                const readALayout = async (): Promise<{ d: string; t: number }> =>
                  g.pillEval(`(function(){ var a = document.getElementById('pillA');
                      var r = document.getElementById('btn-local-a').getBoundingClientRect();
                      return JSON.stringify({ d: getComputedStyle(a).display, t: +r.top.toFixed(1) }); })()`)
                    .then((s) => JSON.parse(s as string) as { d: string; t: number });
                const geoLeg = async (tag: string, w: number, h: number, fullscreen: boolean): Promise<void> => {
                  if (fullscreen) win.setFullScreen(true);
                  else win.setSize(w, h);
                  await sleep(1600); // watchdog + deferred re-apply budget
                  const b = win.getContentBounds();
                  const site = await g.siteProbe();
                  const pill = await g.pillProbe();
                  const wantH = pill.style === 'A' || !pill.blooming ? PILL_H : PILL_H + PILL_BLOOM_PAD_Y * 2;
                  const wantY = pill.style === 'B' && pill.blooming ? PILL_TOP - PILL_BLOOM_PAD_Y : PILL_TOP;
                  let disp: string | undefined;
                  let localTop: number | undefined;
                  let layoutOk = true; // non-A boots skip the A-layout check (they have their own)
                  let wantW: number;
                  if (pill.style === 'A') {
                    wantW = PILL_W;
                    const al = await readALayout();
                    disp = al.d;
                    localTop = al.t;
                    // NOTE (hotfix-3): #pillA is position:absolute, so its COMPUTED display is
                    // BLOCKIFIED — specified `inline-flex` resolves to `flex` ('block' leaked
                    // through when the broken cascade won). Accept the pair as row-proof.
                    layoutOk = (al.d === 'inline-flex' || al.d === 'flex') && Math.abs(al.t - 2) <= 0.5;
                  } else if (pill.blooming) {
                    wantW = PILL_W + PILL_BLOOM_PAD_X * 2; // hotfix-4: bloom-time ROOM
                  } else {
                    wantW = PILL_B_REST_W;
                  }
                  geoLegs.push({
                    tag,
                    ok: site.visible
                      && site.bounds.x === 0 && site.bounds.y === 0
                      && site.bounds.width === b.width && site.bounds.height === b.height
                      && Math.abs(pill.bounds.x - Math.round((b.width - wantW) / 2)) <= 1
                      && pill.bounds.y === wantY
                      && pill.bounds.width === wantW && pill.bounds.height === wantH
                      && layoutOk,
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

                // f_c2g_bloomBounds — Style B: rest room EXACTLY 28 × 28 centered (zero-miss
                // rule sacred, hotfix-4 untouched) → bloomed ROOM 132 × 44 centered at
                // y = PILL_TOP − 8 (hotfix-4 FIX 2) with the PAINTED #pillB exactly 112 × 28
                // centered inside the padded page ⇒ collapse back to the tight rest footprint;
                // rapid hover storms settle with no stuck size.
                await g.pillDrive('contextmenu'); // → B again for the bloom legs
                await sleep(400);
                const restOk = centeredOk(restB.bounds, PILL_B_REST_W, win.getContentBounds().width);
                // ZERO-MISS at rest, page-level too: #root fills the viewport and the painted
                // circle IS the whole 28 × 28 page (flush 0..28) — nothing larger than the native
                // room exists to eat clicks just outside the footprint (the main-side rest bounds
                // asserted above are exact by construction; views receive no events outside their
                // bounds).
                const restPage = await g.pillEval(`(function(){
                    var r = document.getElementById('root').getBoundingClientRect();
                    var p = document.getElementById('pillB').getBoundingClientRect();
                    return JSON.stringify({ rw: [+r.width.toFixed(1), +r.height.toFixed(1)],
                      pl: [+p.left.toFixed(1), +p.top.toFixed(1), +p.width.toFixed(1), +p.height.toFixed(1)] }); })()`)
                  .then((s) => JSON.parse(s as string) as { rw: [number, number]; pl: [number, number, number, number] });
                const restFlush = Math.abs(restPage.rw[0] - PILL_B_REST_W) <= 0.5
                  && Math.abs(restPage.rw[1] - PILL_H) <= 0.5
                  && restPage.pl[0] === 0 && restPage.pl[1] === 0
                  && restPage.pl[2] === PILL_B_REST_W && restPage.pl[3] === PILL_H;
                const waitBloomRoom = async (): Promise<boolean> => {
                  for (let i = 0; i < 12; i++) { // ≤6s: watchdog + deferred re-apply budget
                    await sleep(500);
                    const pb = (await g.pillProbe()).bounds;
                    const cw = win.getContentBounds().width;
                    if (Math.abs(pb.x - Math.round((cw - (PILL_W + PILL_BLOOM_PAD_X * 2)) / 2)) <= 1
                      && pb.y === PILL_TOP - PILL_BLOOM_PAD_Y
                      && pb.width === PILL_W + PILL_BLOOM_PAD_X * 2
                      && pb.height === PILL_H + PILL_BLOOM_PAD_Y * 2) return true;
                  }
                  return false;
                };
                await g.pillDrive('mouseenter');
                // C2g-hotfix-5 FIX 3 — ENTRY CHOREOGRAPHY truth: by ≤500 ms the reveal must have
                // happened — bloomed class present AND viewport == the 132 room AND #pillB
                // VISIBLE again and centered-left ≈ 10 (the blank-paint gate released). The
                // subsequent settle probes below therefore run strictly AFTER the reveal window,
                // not during the hidden gap.
                const entryReveal = await (async (): Promise<boolean> => {
                  for (let i = 0; i < 10; i++) {
                    await sleep(100);
                    const s = await g.pillEval(`(function(){
                        var p = document.getElementById('pillB');
                        if (!p) return JSON.stringify({ v:'none', w:-1, c:false, l:-1 });
                        var cs = getComputedStyle(p);
                        return JSON.stringify({ v: cs.visibility, w: window.innerWidth,
                          c: p.classList.contains('bloomed'),
                          l: +p.getBoundingClientRect().left.toFixed(1) }); })()`)
                      .then((x) => JSON.parse(x as string) as { v: string; w: number; c: boolean; l: number });
                    if (s.v === 'visible' && s.c && s.w === PILL_W + PILL_BLOOM_PAD_X * 2
                      && Math.abs(s.l - PILL_BLOOM_PAD_X) <= 1) return true;
                  }
                  return false;
                })();
                const bloomOk = await waitBloomRoom();
                const bloomFlag = (await pillState()).bloomed;
                // C2g-hotfix-3 §5 B-side asserts, read with the bloom settled: inner knob must be
                // ≈54 × 24 (measured 0×0 before the shared .mode-pill sizing), words 10.5px with
                // 7.5px/14px padding (were UA 16px / 1px 6px).
                await sleep(400);
                const bStyle = await g.pillEval(`(function(){
                    var ks = getComputedStyle(document.querySelector('#pillB .inner .knob'));
                    var bs = getComputedStyle(document.querySelector('#pillB .inner button'));
                    return JSON.stringify({ kw: parseFloat(ks.width), kh: parseFloat(ks.height),
                      fs: bs.fontSize, pad: bs.paddingLeft + ' ' + bs.paddingTop }); })()`)
                  .then((s) => JSON.parse(s as string) as { kw: number; kh: number; fs: string; pad: string });
                const bStyled = Math.abs(bStyle.kw - 54) <= 1 && Math.abs(bStyle.kh - 24) <= 1
                  && bStyle.fs === '10.5px' && bStyle.pad === '14px 7.5px';
                // HOTFIX-4 painted-pill truth inside the bloomed room: #pillB centered in its
                // 132 × 44 page ⇒ x ≈ 10..122, y ≈ 8..36 — symmetric growth around the stable
                // center (the instant room swap moves only transparent skirt margins, not paint).
                const paint = await g.pillEval(`(function(){
                    var p = document.getElementById('pillB').getBoundingClientRect();
                    return JSON.stringify([+p.left.toFixed(1), +p.top.toFixed(1),
                      +p.width.toFixed(1), +p.height.toFixed(1)]); })()`)
                  .then((s) => JSON.parse(s as string) as [number, number, number, number]);
                const paintCentered = Math.abs(paint[0] - PILL_BLOOM_PAD_X) <= 1
                  && Math.abs(paint[1] - PILL_BLOOM_PAD_Y) <= 1
                  && Math.abs(paint[2] - PILL_W) <= 0.5 && Math.abs(paint[3] - PILL_H) <= 0.5;
                for (const ev of ['mouseleave', 'mouseenter', 'mouseleave', 'mouseenter'] as const) {
                  await g.pillDrive(ev);
                  await sleep(120); // storm — faster than the .55s transition on purpose
                }
                const stormOk = await waitBloomRoom() && (await pillState()).bloomed;
                await g.pillDrive('mouseleave');
                // C2g-hotfix-5 FIX 2 truth — the COLLAPSE HOLD: after the request the room must
                // STILL be the 132 × 44 bloom room at ~+250 ms (the 90 ms hysteresis has passed
                // by then; only the 570 ms hold keeps it up — asserts hold-until-shrink), and it
                // must be exactly the tight 28 × 28 rest footprint by ~+1.2 s. waitBounded polls
                // ≤6 s, comfortably covering the real ~660 ms path (90 hysteresis + 570 hold).
                await sleep(250);
                const pbHold = (await g.pillProbe()).bounds;
                const cwHold = win.getContentBounds().width;
                const holdKept = Math.abs(pbHold.x - Math.round((cwHold - (PILL_W + PILL_BLOOM_PAD_X * 2)) / 2)) <= 1
                  && pbHold.y === PILL_TOP - PILL_BLOOM_PAD_Y
                  && pbHold.width === PILL_W + PILL_BLOOM_PAD_X * 2
                  && pbHold.height === PILL_H + PILL_BLOOM_PAD_Y * 2;
                const collapseOk = await waitBounded(PILL_B_REST_W) && !(await pillState()).bloomed;

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
                    && restB.bounds.width === PILL_B_REST_W && survivedB
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
                // f_c2g_knobRoom (C2g-hotfix-6 FIX 3) — Style A FLIP ROOM truth on the REAL path.
                // The click above armed the skirt: the native room must be 124 × 28 centered
                // within ~250 ms of the click, the PAINTED #pillA must sit at [6, 0, 112, 28] ±1
                // while it's big (center-anchor ⇒ paint NEVER moves), and by ~1.2 s the room must
                // be back to the exact sacred 112 × 28 rest footprint.
                const knobT0 = Date.now();
                let knobRoomWideAt = -1;
                for (let i = 0; i < 12; i++) {
                  await sleep(50);
                  const pb = (await g.pillProbe()).bounds;
                  const cw = win.getContentBounds().width;
                  if (Math.abs(pb.x - Math.round((cw - (PILL_W + PILL_A_FLIP_PAD_X * 2)) / 2)) <= 1
                    && pb.y === PILL_TOP && pb.width === PILL_W + PILL_A_FLIP_PAD_X * 2
                    && pb.height === PILL_H) {
                    knobRoomWideAt = Date.now() - knobT0;
                    break;
                  }
                }
                const paintA = await g.pillEval(`(function(){ var r = document.getElementById('pillA').getBoundingClientRect();
                    return JSON.stringify([+r.left.toFixed(1), +r.top.toFixed(1),
                      +r.width.toFixed(1), +r.height.toFixed(1)]); })()`)
                  .then((s) => JSON.parse(s as string) as [number, number, number, number]);
                const paintStable = Math.abs(paintA[0] - PILL_A_FLIP_PAD_X) <= 1 && Math.abs(paintA[1]) <= 1
                  && Math.abs(paintA[2] - PILL_W) <= 1 && Math.abs(paintA[3] - PILL_H) <= 1;
                let knobRoomSettled = false;
                for (let i = 0; i < 14; i++) { // ≤3.5 s ≫ the 620 ms contract-coupled hold
                  await sleep(250);
                  const pb = (await g.pillProbe()).bounds;
                  const cw = win.getContentBounds().width;
                  if (pb.x === Math.round((cw - PILL_W) / 2) && pb.y === PILL_TOP
                    && pb.width === PILL_W && pb.height === PILL_H) {
                    knobRoomSettled = true;
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
                // C2g contract: pill top-CENTER, y=10, 112 × 28 (±1px on the centered x).
                const pillOk = Math.abs(pill.bounds.x - Math.round((b.width - PILL_W) / 2)) <= 1
                  && pill.bounds.y === PILL_TOP
                  && pill.bounds.width === PILL_W && pill.bounds.height === PILL_H;
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
              // C2g-hotfix-6 — each mode delivery now arms the Style A flip room (124 × 28,
              // contract-coupled hold), so the "rest footprint" part of this key must be read
              // AFTER the hold snaps back to exactly 112 × 28. Persistence facts (view reuse,
              // z-order, transparency, load state) are asserted on the INSTANT storm probe;
              // geometry is asserted once the room has settled (≤1.6 s ≫ the 620 ms hold).
              let settlePill = stormPill;
              for (let i = 0; i < 10; i++) {
                const cw2 = win.getContentBounds().width;
                if (settlePill.bounds.width === PILL_W && settlePill.bounds.height === PILL_H
                  && settlePill.bounds.y === PILL_TOP
                  && Math.abs(settlePill.bounds.x - Math.round((cw2 - PILL_W) / 2)) <= 1) break;
                await sleep(160);
                settlePill = await cloudCtl.pillProbe();
              }
              const stormSite = await cloudCtl.siteProbe();
              console.log('[c2f-pill]', JSON.stringify({
                f_c2f_pillPersistent: childViews === 2 && stormPill.visible && stormPill.loaded
                  && cloudCtl.pillIsTopChild()
                  && Math.abs(settlePill.bounds.x - Math.round((win.getContentBounds().width - PILL_W) / 2)) <= 1
                  && settlePill.bounds.y === PILL_TOP
                  && settlePill.bounds.width === PILL_W && settlePill.bounds.height === PILL_H
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
                  && iso.pillDropsyncType === 'undefined' && iso.pillBridgeType === 'object',
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
                win.webContents.send('pill:flipRequested', 'cloud');
                await sleep(1500);
                const enteredCloud = appMode === 'cloud';
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
                // CLEANUP: one shared clock restored, Local re-entered (lands on the password
                // screen — fine, the starve legitimately locked it), re-unlocked through the
                // SAME path other dev paths use (dev:testOnly `vaultUnlock` → manager.unlock),
                // then a fresh mount so any later stages boots sane.
                await manager.setSettings({ autoLockMinutes: 10 });
                win.webContents.send('pill:flipRequested', 'local');
                await sleep(1500);
                try { await manager.unlock('/tmp/ds-c2f-vault', 'c2f-vault-pw'); } catch { /* already open or gone */ }
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
  const applyMode = async (next: 'cloud' | 'local'): Promise<'cloud' | 'local'> => {
    if (next !== 'cloud' && next !== 'local') throw new Error('Invalid mode.');
    if (next === appMode) return appMode;
    if (next === 'cloud') {
      appMode = 'cloud';
      if (!cloudCtl) throw new Error('Cloud controller unavailable.');
      cloudCtl.show();
    } else {
      appMode = 'local';
      cloudCtl?.hide();
    }
    // C2f FIX 2 — the knob slides ONLY when the mode ACTUALLY applied (never on request).
    cloudCtl?.setPillMode(appMode);
    return appMode;
  };
  applyCloudMode = applyMode;
  handle('mode:get', () => appMode);
  handle('mode:set', (_e, next: 'cloud' | 'local') => applyCloudMode(next));
  // C2f FIX 2 — the pill's ONE outbound channel: forward the flip request to the MAIN window
  // renderer, which runs the EXISTING guarded switchMode (unsaved-work discard-confirm
  // included). The pill never switches anything by itself. Then give keyboard focus back.
  ipcMain.on('pill:flip', (_e, next: 'cloud' | 'local') => {
    if (next !== 'cloud' && next !== 'local') return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // C2g-hotfix-6 FIX 2 — arm the Style A flip room BEFORE relaying: the 124 × 28 skirt must
    // be in place before the renderer's guarded switch lands the knob's class and the elastic
    // transform starts (its overshoot paints past the trough's ends instead of clipping).
    cloudCtl?.beginPillFlip();
    pillFlipRelayCount += 1; // C2g-hotfix-1 §5 — relay-receipt evidence for the real-click robot
    console.log('[pill] flip requested →', next);
    mainWindow.webContents.send('pill:flipRequested', next);
    cloudCtl?.blurPill();
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
  handle('vault:settingsSet', (_e, patch: Record<string, unknown>) => manager.setSettings(patch));

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
    // Stream decrypt → chosen path (never buffers the whole file for big blobs).
    const decrypted = manager.streamMedia(entry, 0, Number.POSITIVE_INFINITY);
    const nodeReadable = Readable.fromWeb(decrypted as unknown as import('node:stream/web').ReadableStream);
    await pipeline(nodeReadable, createWriteStream(result.filePath));
    return { path: result.filePath };
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
  manager.setNotifier((title, body) => {
    if (!Notification.isSupported()) {
      notifyFallback(title, body);
      return;
    }
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
  });

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
