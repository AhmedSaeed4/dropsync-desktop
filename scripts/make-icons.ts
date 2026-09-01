/**
 * PACKAGING-1 STEP 2 — render the app icon. Source: build/icon.svg (the web app's own tab
 * icon — ink circle #1A1A1A + cream diamond #FFFEF5 — confirmed by the owner against
 * desktop-docs/icon-confirm-preview.html). sharp rasterizes the VECTOR at each target size
 * (density scaled from the 32-unit viewBox, so every PNG renders native-crisp, never
 * upscaled): build/icon.png at 512×512 — the electron-builder win icon, from which the
 * NSIS/ico layers are derived — plus the audit ladder 256/128/64/48/32/16 into build/icons/.
 *
 * Run: npm run icons
 */

import { mkdir } from 'node:fs/promises';
import pathMod from 'node:path';

import sharp from 'sharp';

const SRC = pathMod.resolve('build/icon.svg');
const OUT_MAIN = pathMod.resolve('build/icon.png');
const OUT_DIR = pathMod.resolve('build/icons');
const SIZES = [256, 128, 64, 48, 32, 16];
const VIEWBOX = 32; // build/icon.svg is viewBox="0 0 32 32"

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const render = async (size: number, dest: string) => {
    // density: 72 DPI == one viewBox unit, so scale DPI until the vector rasterizes at
    // exactly `size` px — each PNG is a native-resolution render of the vector, not a
    // resample of a bigger bitmap.
    const density = Math.ceil((72 * size) / VIEWBOX);
    const info = await sharp(SRC, { density }).resize(size, size).png().toFile(dest);
    console.log(`[icons] ${pathMod.basename(dest)} ${info.width}x${info.height} (${info.size} bytes)`);
  };
  await render(512, OUT_MAIN);
  for (const size of SIZES) {
    await render(size, pathMod.join(OUT_DIR, `icon-${size}.png`));
  }
  console.log('[icons] done — source:', SRC);
}

main().catch((err) => {
  console.error('[icons] FAILED:', err);
  process.exit(1);
});
