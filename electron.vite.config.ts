import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    // Sandboxed preloads must be CommonJS; with "type": "module" we emit .cjs explicitly.
    // C2f: TWO preloads — the main app bridge and the floating pill's minimal bridge.
    // C2j: THREE — the reminder card layer joins with the same least-privilege shape.
    // C2m: FOUR — the flip-dissolve fader layer joins with the same least-privilege shape.
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          pillPreload: resolve(__dirname, 'src/renderer/pill/pillPreload.ts'),
          cardPreload: resolve(__dirname, 'src/renderer/card/cardPreload.ts'),
          faderPreload: resolve(__dirname, 'src/renderer/fader/faderPreload.ts'),
        },
        output: {
          entryFileNames: '[name].cjs',
          format: 'cjs',
        },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
      },
    },
    // C2f: TWO renderer pages — the main app and the floating pill layer (FIX 2).
    // C2j: THREE — the reminder card layer page (zero remote assets; local css/ts only).
    // C2m: FOUR — the flip-dissolve fader layer page (zero remote assets; local css/ts only).
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          pill: resolve(__dirname, 'src/renderer/pill/pill.html'),
          card: resolve(__dirname, 'src/renderer/card/card.html'),
          fader: resolve(__dirname, 'src/renderer/fader/fader.html'),
        },
      },
    },
  },
});
