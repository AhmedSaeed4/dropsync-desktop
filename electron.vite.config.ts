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
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          pillPreload: resolve(__dirname, 'src/renderer/pill/pillPreload.ts'),
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
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          pill: resolve(__dirname, 'src/renderer/pill/pill.html'),
        },
      },
    },
  },
});
