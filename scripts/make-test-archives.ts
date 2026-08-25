/**
 * Section-8.4 test fixture generator — builds personal + workspace .dropsync archives using the
 * SAME envelope writer the app ships, covering: timers (remainingSeconds variants + legacy),
 * pins (incl. overflow), mention chains, categories (incl. password/link), drawings with
 * drawingScene, YouTube labels, a ≥10 MB dummy binary file, and an empty vault archive.
 *
 * Run: npm run make-test-archives [-- outDir]
 * Node ≥23.6 runs this natively via type stripping — no build step.
 */

import { mkdir } from 'node:fs/promises';
import * as pathMod from 'node:path';

import { writeArchiveFile } from '../src/main/vault/archiveWriter.ts';

const PASSWORD = 'test-archive-pw';

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// FIX 20 fixture honesty — a REAL, valid PNG so thumbnails/previews actually
// render, plus an Excalidraw-style EMBEDDED-scene builder (tEXt chunk keyword
// `application/vnd.excalidraw+json`, zlib-deflated JSON — byte-compatible with
// exportEmbedScene output that loadFromBlob parses back into elements).
// ---------------------------------------------------------------------------

/** 1×1 transparent PNG (well-known bytes) — renders in <img>, contains NO scene. */
const TINY_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0)
);

let crcTable: number[] | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Inject an Excalidraw embedded-scene tEXt chunk before IEND. Excalidraw 0.18 uses
 * png-chunk-text: keyword `application/vnd.excalidraw+json` + NUL + PLAINTEXT JSON
 * (no zlib) — byte-compatible with its own exportEmbedScene output. */
function pngWithEmbeddedScene(png: Uint8Array, sceneJson: string): Uint8Array {
  const keyword = 'application/vnd.excalidraw+json';
  const value = new TextEncoder().encode(sceneJson);
  const data = new Uint8Array(keyword.length + 1 + value.length);
  data.set(new TextEncoder().encode(keyword), 0);
  data[keyword.length] = 0;
  data.set(value, keyword.length + 1);
  const text = pngChunk('tEXt', data);
  // PNG structure guarantees IEND is the FINAL 12 bytes (len=0 + 'IEND' + CRC) — splice the
  // scene chunk right before it.
  const splitAt = png.length - 12;
  const out = new Uint8Array(png.length + text.length);
  out.set(png.subarray(0, splitAt), 0);
  out.set(text, splitAt);
  out.set(png.subarray(splitAt), splitAt + text.length);
  return out;
}

/** Minimal but fully-populated rectangle element Excalidraw's restore accepts. */
function sceneRectangle(id: string): Record<string, unknown> {
  return {
    id, type: 'rectangle', x: 10, y: 10, width: 120, height: 80, angle: 0,
    strokeColor: '#1a1a1a', backgroundColor: '#a5b8fc', fillStyle: 'solid', strokeWidth: 2,
    strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null,
    roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false,
    boundElements: null, updated: 1, link: null, locked: false,
  };
}

async function main(): Promise<void> {
  const outDir = process.argv[2] || 'test-archives';
  await mkdir(outDir, { recursive: true });
  const bigBytes = new Uint8Array(11 * 1024 * 1024);
  for (let i = 0; i < bigBytes.length; i += 4096) bigBytes[i] = 0xAB;
  const drawingPng = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4, 5]);
  const now = Date.now();

  // ---------- PERSONAL ----------
  // Mention chain: drop P3 references P2 which references P1 → all remap on import.
  const p1 = '11111111-1111-4111-8111-111111111111';
  const p2 = '22222222-2222-4222-8222-222222222222';
  const p3 = '33333333-3333-4333-8333-333333333333';
  const personalManifest = {
    schema: 'dropsync.personal',
    schemaVersion: 1,
    archiveId: 'aaaaaaaa-0000-4000-8000-00000000aa01',
    exportedAt: new Date(now - 3600_000).toISOString(),
    sourceSpace: 'personal',
    sourceUser: { displayName: 'Archive Owner' },
    categories: [
      { name: 'Work', createdAt: new Date(now - 7200_000).toISOString() },
      { name: 'Password', createdAt: new Date(now - 7200_000).toISOString() },
      { name: 'Link', createdAt: new Date(now - 7200_000).toISOString() },
    ],
    drops: [
      { // forever + pinned
        sourceId: p1, type: 'text', name: 'P1 Forever Pin',
        content: 'Forever content with link https://youtu.be/dQw4w9WgXcQ inside.',
        categories: ['Work'], youtubeVideoLabels: [{ videoId: 'dQw4w9WgXcQ', title: 'Test Video Title', channel: 'Test Channel' }],
        pinned: true, locked: false, isDrawing: false,
        createdAt: new Date(now - 100_000).toISOString(), expiresAt: null, remainingSeconds: null,
        expirationOption: 'forever', reminderAt: null, reminderSetByUid: null, reminderDismissedBy: null,
      },
      { // remainingSeconds 3600 ⇒ ≈now+60min; second pin
        sourceId: p2, type: 'text', name: 'P2 One Hour Left',
        content: `See #[P1 Forever Pin](${p1}) for context.`,
        categories: [], pinned: true, locked: true, isDrawing: false,
        createdAt: new Date(now - 200_000).toISOString(),
        expiresAt: new Date(now + 3600_000).toISOString(), remainingSeconds: 3600,
        expirationOption: '6h', reminderAt: new Date(now + 120_000).toISOString(), reminderSetByUid: 'u', reminderDismissedBy: null,
      },
      { // legacy expiry restart (remainingSeconds undefined) + mentions P2 + drawing image
        sourceId: p3, type: 'text', name: 'P3 Legacy Restart Drawing',
        content: `Drawing about #[P2 One Hour Left](${p2}).`,
        categories: ['Password'], pinned: false, locked: false, isDrawing: true,
        createdAt: new Date(now - 300_000).toISOString(),
        expiresAt: new Date(now + 7200_000).toISOString(),
        expirationOption: undefined as unknown as string,
        reminderAt: null, reminderSetByUid: null, reminderDismissedBy: null,
        imageSize: drawingPng.byteLength, imageMimeType: 'image/png',
        drawingScene: { elements: [{ id: 'el-1', type: 'rectangle' }], appState: { viewBackgroundColor: '#ffffff' } },
        payloads: { image: 'files/cccccccc-cccc-4ccc-8ccc-cccccccccc01.img' },
      },
      { // zero remainingSeconds ⇒ may expire immediately
        sourceId: '44444444-4444-4444-8444-444444444444', type: 'text', name: 'P4 Zero Remaining',
        content: 'Expires immediately.', categories: ['Link'], pinned: false, locked: false, isDrawing: false,
        createdAt: new Date(now - 400_000).toISOString(), expiresAt: new Date(now).toISOString(), remainingSeconds: 0,
        reminderAt: null, reminderSetByUid: null, reminderDismissedBy: null,
      },
      { // file drop ≥10 MB (raw in export per web behavior)
        sourceId: '55555555-5555-4555-8555-555555555555', type: 'file', name: 'P5 Big Dummy.bin',
        categories: [], pinned: false, locked: false, isDrawing: false,
        createdAt: new Date(now - 500_000).toISOString(),
        expiresAt: new Date(now + 86_000_000).toISOString(), remainingSeconds: 86_000,
        expirationOption: '24h', reminderAt: null, reminderSetByUid: null, reminderDismissedBy: null,
        fileSize: bigBytes.byteLength, mimeType: 'application/octet-stream',
        payloads: { file: 'files/dddddddd-dddd-4ddd-8ddd-dddddddddd01.bin' },
      },
    ],
  };

  await writeArchiveFile(
    pathMod.join(outDir, 'personal-test.dropsync'),
    PASSWORD,
    jsonBytes(personalManifest),
    [
      { name: 'files/cccccccc-cccc-4ccc-8ccc-cccccccccc01.img', bytes: drawingPng },
      { name: 'files/dddddddd-dddd-4ddd-8ddd-dddddddddd01.bin', bytes: bigBytes },
    ]
  );
  console.log('wrote personal-test.dropsync');

  // ---------- WORKSPACE ----------
  const wManifest = {
    schema: 'dropsync.workspace',
    schemaVersion: 1,
    archiveId: 'bbbbbbbb-0000-4000-8000-00000000bb02',
    exportedAt: new Date(now - 1800_000).toISOString(),
    sourceWorkspace: { id: 'ws-src-1', name: 'Source WS', createdAt: new Date(now - 90 * 86400_000).toISOString() },
    members: [{ displayName: 'Owner Person', isOwner: true }],
    categories: [
      { name: 'Docs', createdByDisplayName: 'Owner Person', createdAt: new Date(now - 8000_000).toISOString() },
    ],
    drops: [
      {
        sourceId: '66666666-6666-4666-8666-666666666666', type: 'text', name: 'W1 Workspace Text',
        content: `Cross-space mention #[P1 Forever Pin](${p1}) will not resolve here.`,
        categories: ['Docs'], creatorName: 'Owner Person',
        pinned: true, locked: false, isDrawing: false,
        createdAt: new Date(now - 600_000).toISOString(), expiresAt: null, remainingSeconds: null,
        expirationOption: 'forever', reminderAt: null, reminderSetByUid: null, reminderDismissedBy: null,
      },
      { // legacy option not whitelisted → falls back to 2h on import
        sourceId: '77777777-7777-4777-8777-777777777777', type: 'file', name: 'W2 Legacy Small File',
        categories: [], creatorName: 'Owner Person', pinned: false, locked: false, isDrawing: false,
        createdAt: new Date(now - 700_000).toISOString(),
        expiresAt: new Date(now + 900_000).toISOString(),
        reminderAt: null, reminderSetByUid: null, reminderDismissedBy: null,
        fileSize: 12, mimeType: 'text/plain',
        payloads: { file: 'files/eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01.bin' },
      },
    ],
  };
  await writeArchiveFile(
    pathMod.join(outDir, 'workspace-test.dropsync'),
    PASSWORD,
    jsonBytes(wManifest),
    [{ name: 'files/eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01.bin', bytes: new TextEncoder().encode('hello world!') }]
  );
  console.log('wrote workspace-test.dropsync');

  // ---------- EMPTY ----------
  const emptyManifest = {
    schema: 'dropsync.personal',
    schemaVersion: 1,
    archiveId: 'cccccccc-0000-4000-8000-00000000cc03',
    exportedAt: new Date(now).toISOString(),
    sourceSpace: 'personal',
    categories: [],
    drops: [],
  };
  await writeArchiveFile(pathMod.join(outDir, 'empty-test.dropsync'), PASSWORD, jsonBytes(emptyManifest), []);
  console.log('wrote empty-test.dropsync');

  // ---------- WEB-SHAPED (FIX 20) ----------
  // The web app's export shape for drawings: type 'text' + isDrawing, PNG under payloads.image
  // (the importer lands it in the IMAGE slot), manifest drawingScene carried when present.
  // WD1 carries a manifest drawingScene and a deliberately SCENE-LESS PNG — worst case for
  // extraction; the editor must build its scene from the JSON alone (zero byte fetches).
  // WD2 has NO manifest drawingScene but a PNG WITH an embedded Excalidraw scene — exercises
  // the byte-fetch fallback parse.
  const webSceneJson = JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'dropsync-test-fixture',
    elements: [sceneRectangle('web-el-1')],
    appState: { viewBackgroundColor: '#fffef5' },
  });
  const wd1Png = TINY_PNG; // valid pixels, zero scene data
  const wd2Png = pngWithEmbeddedScene(TINY_PNG, webSceneJson);
  const webDrawingManifest = {
    schema: 'dropsync.personal',
    schemaVersion: 1,
    archiveId: 'dddddddd-0000-4000-8000-00000000dd04',
    exportedAt: new Date(now - 900_000).toISOString(),
    sourceSpace: 'personal',
    sourceUser: { displayName: 'Web Owner' },
    categories: [],
    drops: [
      {
        sourceId: 'w1111111-1111-4111-8111-web000000001', type: 'text', name: 'WD1 Manifest Scene',
        content: '', categories: [], pinned: false, locked: false, isDrawing: true,
        createdAt: new Date(now - 1000_000).toISOString(), expiresAt: null, remainingSeconds: null,
        expirationOption: 'forever', reminderAt: null, reminderSetByUid: null, reminderDismissedBy: null,
        imageSize: wd1Png.byteLength, imageMimeType: 'image/png',
        drawingScene: { elements: [sceneRectangle('web-el-1')], appState: { viewBackgroundColor: '#fffef5' } },
        payloads: { image: 'files/wd111111-1111-4111-8111-111111111101.img' },
      },
      {
        sourceId: 'w2222222-2222-4222-8222-web000000002', type: 'text', name: 'WD2 Embedded Scene',
        content: '', categories: [], pinned: false, locked: false, isDrawing: true,
        createdAt: new Date(now - 1100_000).toISOString(), expiresAt: null, remainingSeconds: null,
        expirationOption: 'forever', reminderAt: null, reminderSetByUid: null, reminderDismissedBy: null,
        imageSize: wd2Png.byteLength, imageMimeType: 'image/png',
        payloads: { image: 'files/wd222222-2222-4222-8222-222222222202.img' },
      },
    ],
  };
  await writeArchiveFile(
    pathMod.join(outDir, 'web-drawing-test.dropsync'),
    PASSWORD,
    jsonBytes(webDrawingManifest),
    [
      { name: 'files/wd111111-1111-4111-8111-111111111101.img', bytes: wd1Png },
      { name: 'files/wd222222-2222-4222-8222-222222222202.img', bytes: wd2Png },
    ]
  );
  console.log('wrote web-drawing-test.dropsync');

  // ---------- POISONED SCENE (FIX 21) ----------
  // WD3 reproduces bug #21 deterministically: a manifest drawingScene whose appState carries
  // JSON-round-tripped RUNTIME fields — collaborators:{} (a live Map on the web, plain {} after
  // the importer's JSON.parse(JSON.stringify(...)) in archiveFormat.extractDrawingScene) plus
  // other junk runtime keys. Pre-fix, feeding this through restore() into the editor throws
  // "props.appState.collaborators.forEach is not a function" during InteractiveCanvas render
  // (white screen — no error boundary). Post-fix the FIX 21a whitelist + central Map guard open
  // a healthy editor with the cream background intact and ZERO payload byte fetches (the PNG is
  // deliberately scene-less so any byte-fetch fallback could never mask the manifest path).
  const wd3Png = TINY_PNG; // valid pixels, zero embedded scene
  const poisonedDrawingManifest = {
    schema: 'dropsync.personal',
    schemaVersion: 1,
    archiveId: 'dddddddd-0000-4000-8000-00000000dd05',
    exportedAt: new Date(now - 1200_000).toISOString(),
    sourceSpace: 'personal',
    sourceUser: { displayName: 'Web Owner' },
    categories: [],
    drops: [
      {
        sourceId: 'w3333333-3333-4333-8333-web000000003', type: 'text', name: 'WD3 Poisoned Scene',
        content: '', categories: [], pinned: false, locked: false, isDrawing: true,
        createdAt: new Date(now - 1300_000).toISOString(), expiresAt: null, remainingSeconds: null,
        expirationOption: 'forever', reminderAt: null, reminderSetByUid: null, reminderDismissedBy: null,
        imageSize: wd3Png.byteLength, imageMimeType: 'image/png',
        drawingScene: {
          elements: [sceneRectangle('poison-el-1')],
          appState: {
            viewBackgroundColor: '#fffef5',
            collaborators: {}, // the poison: Map serialized through JSON becomes {}
            selectedElementIds: {},
            selectedGroupIds: {},
            editingGroupId: null,
            snapLines: [],
            originSnapOffset: {},
            zenModeEnabled: false,
          },
        },
        payloads: { image: 'files/wd333333-3333-4333-8333-333333333303.img' },
      },
    ],
  };
  await writeArchiveFile(
    pathMod.join(outDir, 'poisoned-scene-test.dropsync'),
    PASSWORD,
    jsonBytes(poisonedDrawingManifest),
    [{ name: 'files/wd333333-3333-4333-8333-333333333303.img', bytes: wd3Png }]
  );
  console.log('wrote poisoned-scene-test.dropsync');

  console.log(`done → ${pathMod.resolve(outDir)} (password: ${PASSWORD})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
