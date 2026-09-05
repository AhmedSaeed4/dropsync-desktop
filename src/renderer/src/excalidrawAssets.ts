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
  // 108b: root-absolute '/' only resolves on the DEV server; on the packaged file:// page the
  // library's normalizeBaseUrl degenerates it to 'file:/' (planner-proven 2026-09-04) and every
  // vendored font 404s — all families rendered one fallback since 1.0.0. Compute the REAL
  // renderer directory instead: identical value in dev, correct absolute file URL in production.
  window.EXCALIDRAW_ASSET_PATH = new URL('./', document.baseURI).href;
}

export {};
