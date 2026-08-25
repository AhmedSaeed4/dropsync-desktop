/**
 * Excalidraw asset path — MUST be imported before anything that pulls in Excalidraw (it is the
 * first import in main.tsx; ES module evaluation order guarantees its body runs first).
 * Points Excalidraw at the vendored font sets in the renderer public dir (same-origin, CSP-safe)
 * instead of any CDN. window.EXCALIDRAW_ASSET_PATH is read lazily when fonts load.
 */

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string;
  }
}

if (typeof window !== 'undefined') {
  window.EXCALIDRAW_ASSET_PATH = '/';
}

export {};
