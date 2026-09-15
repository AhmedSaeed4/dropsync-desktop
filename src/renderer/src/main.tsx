import './excalidrawAssets'; // FIRST — sets window.EXCALIDRAW_ASSET_PATH before Excalidraw loads
import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/raleway';
import '@fontsource-variable/inter';
import './styles/globals.css';
import App from './App';
import { ErrorBoundary } from './components/shared/ErrorBoundary';

// Dev-only E2E hook (?e2eHooks): exposes the Excalidraw module object to the page context so the
// scripted battery can drive a REAL exportToBlob/loadFromBlob drawing round-trip. Never ships:
// import.meta.env.DEV is false in production builds and the query flag is absent anyway.
if (import.meta.env.DEV && window.location.search.includes('e2eHooks')) {
  void import('@excalidraw/excalidraw').then((m) => {
    (window as unknown as Record<string, unknown>).__EXCAL = m;
  });
  // FIX 14 battery: live size of the preview payload cache (LRU-cap verification) plus a
  // per-id membership probe (cold-path verification).
  void import('./lib/previewPayloadCache').then((c) => {
    const W = window as unknown as Record<string, unknown>;
    W.__previewCacheSize = c.previewPayloadCacheSize;
    W.__previewCacheHas = (id: string) => !!c.getCachedPreviewPayload(id);
    // C2f-hotfix-2: let the cloud battery read the PRIMED PAYLOAD itself (dev/e2eHooks only) —
    // the meta-save key asserts the cache holds the FULL text, not merely that an entry exists.
    W.__previewCacheGet = (id: string) => c.getCachedPreviewPayload(id) ?? null;
    // Round 112 probes: hover prebuffer / image-warm start counts (dev/e2eHooks only).
    W.__previewPrebufferCount = c.previewPrebufferCount;
    W.__previewImageWarmCount = c.previewImageWarmCount;
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* FIX 21b: a render crash must never blank the whole window again. */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
