// Runs synchronously from <head> BEFORE any ES module evaluates — Excalidraw resolves its font
// URL candidates against window.EXCALIDRAW_ASSET_PATH, and vite's dep graph can evaluate the
// package before main.tsx's own side-effect import lands. Same-origin, CSP-compliant.
// Vendored fonts live at public/fonts/<Family>/… (matching Excalidraw's ./fonts/<Family>/… paths).
window.EXCALIDRAW_ASSET_PATH = '/';
