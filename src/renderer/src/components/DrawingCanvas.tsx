/**
 * Desktop port of the web's DrawingCanvas.tsx — the whole mount/save/load recipe is preserved:
 * excalidrawAPI handle, initialData from scene, editor theme HARDCODED light (web parity),
 * canvasActions disabled except tools.image, renderTopRightUI=null.
 *
 * Desktop deltas: no next/dynamic (Vite has no SSR), and onSave hands the raw PNG bytes to the
 * caller (they cross IPC once into the vault) instead of wrapping them in a File. Save uses
 * dynamic-import exportToBlob with exportEmbedScene: true — this flag IS the round-trip
 * mechanism (the scene rides inside the PNG); never omit it.
 */

import { lazy, Suspense, useRef, useState, useEffect, useCallback } from 'react';
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import '@excalidraw/excalidraw/index.css';
import { ErrorBoundary } from './shared/ErrorBoundary';

/**
 * Lazy module load (web parity with next/dynamic): the @excalidraw/excalidraw MODULE must not
 * evaluate until window.EXCALIDRAW_ASSET_PATH is set — static imports hoist above main.tsx's
 * excalidrawAssets side-effect, which sent font requests to the CDN (blocked by CSP). Types stay
 * compile-time only; exportToBlob/loadFromBlob callers already dynamic-import.
 */
const Excalidraw = lazy(
  () => import('@excalidraw/excalidraw').then((m) => ({ default: m.Excalidraw }))
);

interface DrawingCanvasProps {
  onSave: (pngBytes: Uint8Array) => void;
  onCancel: () => void;
  onDraw?: () => void;
  /** Live non-deleted element count — lets the parent block saving an EMPTY drawing. */
  onElementsCountChange?: (count: number) => void;
  theme: 'light' | 'dark' | 'minimal';
  bgColor: string;
  initialScene?: { elements: ExcalidrawElement[]; appState: Partial<AppState>; files?: BinaryFiles };
}

/**
 * FIX 22b PHASE-2 instrumentation — diagnosis ONLY, zero behavior change, and active solely in
 * dev boots carrying the e2eHooks query flag. Counts <Excalidraw> subtree mount/unmount cycles,
 * excalidrawAPI hand-outs, onChange bursts, boundary catches, and keeps a small timestamped
 * sequence ring so the DOM battery can correlate a toolbar font click with any remount.
 */
interface DCSeqEntry { t: number; ev: string }
interface DCMetrics {
  mounts: number; unmounts: number; apiCalls: number; changes: number; didCatch: number;
  seq: DCSeqEntry[];
}
const dcEnabled = import.meta.env.DEV
  && typeof window !== 'undefined'
  && window.location.search.includes('e2eHooks');
if (dcEnabled) {
  const w = window as unknown as { __DC_METRICS?: DCMetrics; __DC_RESET?: () => void };
  if (!w.__DC_METRICS) {
    const fresh = (): DCMetrics => ({ mounts: 0, unmounts: 0, apiCalls: 0, changes: 0, didCatch: 0, seq: [] });
    w.__DC_METRICS = fresh();
    w.__DC_RESET = () => { w.__DC_METRICS = fresh(); };
  }
}
const dcMetrics = (): DCMetrics | null => (dcEnabled ? (window as unknown as { __DC_METRICS?: DCMetrics }).__DC_METRICS ?? null : null);
const dcEvent = (ev: 'mount' | 'unmount' | 'api' | 'didCatch'): void => {
  const m = dcMetrics();
  if (!m) return;
  if (ev === 'mount') m.mounts += 1;
  if (ev === 'unmount') m.unmounts += 1;
  if (ev === 'api') m.apiCalls += 1;
  if (ev === 'didCatch') m.didCatch += 1;
  m.seq.push({ t: Date.now(), ev });
  if (m.seq.length > 240) m.seq.shift();
};

const BG_COLORS = [
  { value: '#ffffff', label: 'White' },
  { value: '#f5f5f5', label: 'Light gray' },
  { value: '#fffef5', label: 'Cream' },
  { value: '#333333', label: 'Dark gray' },
  { value: '#000000', label: 'Black' },
];

export function DrawingCanvas({ onSave, onCancel, onDraw, onElementsCountChange, theme, bgColor, initialScene }: DrawingCanvasProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apiRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const elementsRef = useRef<any[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filesRef = useRef<any>(null);
  const drawnRef = useRef(false);

  // FIX 22b Phase-2 hooks (dev/e2eHooks only — dcEvent no-ops otherwise).
  useEffect(() => {
    dcEvent('mount');
    return () => dcEvent('unmount');
  }, []);

  const isDark = theme === 'dark';
  const roundedClass = 'rounded-lg';

  // Update background color in real-time when bgColor changes (skip for initial scene).
  useEffect(() => {
    if (apiRef.current) {
      apiRef.current.updateScene({
        appState: { viewBackgroundColor: bgColor },
      });
    }
  }, [bgColor, initialScene]);

  const handleAPI = useCallback((api: unknown) => {
    apiRef.current = api;
    dcEvent('api');
    // DEV-ONLY (FIX 22b battery): expose the live editor API to the page context so the scripted
    // font-family sweep can exercise the same update surface as the toolbar. Never ships — the
    // query flag is absent outside the e2e boots and import.meta.env.DEV is false in production.
    if (import.meta.env.DEV && window.location.search.includes('e2eHooks')) {
      (window as unknown as Record<string, unknown>).__DRAWING_API = api;
    }
  }, []);

  const handleChange = useCallback(
    (elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      elementsRef.current = [...elements];
      filesRef.current = files;
      const m = dcMetrics();
      if (m) m.changes += 1;
      if (!drawnRef.current && elements.length > 0) {
        drawnRef.current = true;
        onDraw?.();
      }
      onElementsCountChange?.(elements.filter((el) => !el.isDeleted).length);
    },
    [onDraw, onElementsCountChange],
  );

  const handleSave = useCallback(async () => {
    const { exportToBlob } = await import('@excalidraw/excalidraw');
    const activeElements = elementsRef.current.filter((el: ExcalidrawElement) => !el.isDeleted);
    const blob = await exportToBlob({
      elements: activeElements,
      appState: {
        viewBackgroundColor: bgColor,
        exportBackground: true,
        exportEmbedScene: true,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      files: filesRef.current as any,
      exportPadding: 10,
    });
    if (blob) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      onSave(bytes);
    }
  }, [onSave, bgColor]);

  // FIX 22c — rung 3C intercept (last resort; 3A disproven by phase-2 metrics, 3B unavailable
  // since 0.18.1 is the newest 0.18.x). The #22b crash: in an EDIT-modal session a font-family
  // click routed through Excalidraw's action pipeline ends with its deferred submit machinery
  // (bindBlurEvent → rAF(handleSubmit)) tearing down against an already-dead wysiwyg/scene; the
  // orphan unsubscribe throws at the Scene emitter (chunk :29589) and React recreates the whole
  // tree — the editor "closes". Create-mode sessions never arm that race.
  // Fix at OUR layer, scoped to EDIT sessions (initialScene provided): a font-family CLICK is
  // applied through the exposed editor API on the selected/editing element instead of the
  // action pipeline. Visually identical end state (element fontFamily + version bump), single
  // teardown-free path; the picker popover behaves as before. CREATE mode keeps the stock
  // pipeline byte-for-byte.
  // Family values are the stable public FONT_FAMILY enum (constants.d.ts:101-110):
  // Excalifont=4 ("hand-drawn" trigger), Nunito=5 ("normal"), Comic Shanns=7 ("code").
  useEffect(() => {
    if (!initialScene) return; // create mode — stock pipeline
    const onWinPointerDown = (ev: PointerEvent) => {
      const target = ev.target as HTMLElement | null;
      if (!target || !target.closest) return;
      if (!target.closest('[data-testid^="font-family-"], .FontPicker__dropdown, .dropdown-menu-item')) return;
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement && active.closest('.excalidraw')) active.blur();
    };
    const onWinClick = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null;
      if (!target || !target.closest) return;
      const item = target.closest('.dropdown-menu-item[value]');
      const quick = target.closest('[data-testid="font-family-hand-drawn"], [data-testid="font-family-normal"], [data-testid="font-family-code"]');
      if (!item && !quick) return;
      const api = apiRef.current;
      if (!api || !api.updateScene || !api.getSceneElementsIncludingDeleted) return;
      let fam = 0;
      if (item) fam = Number(item.getAttribute('value')) || 0;
      else if (quick) {
        const tid = quick.getAttribute('data-testid');
        fam = tid === 'font-family-hand-drawn' ? 4 : tid === 'font-family-normal' ? 5 : 7;
      }
      if (!fam) return;
      ev.preventDefault();
      ev.stopPropagation();
      // Commit an open text editor ONCE; the family lands on the (still selected) element.
      const ta = document.querySelector('.excalidraw textarea');
      if (ta instanceof HTMLTextAreaElement) ta.blur();
      window.setTimeout(() => {
        try {
          const st = typeof api.getAppState === 'function' ? api.getAppState() : null;
          const sel = st ? st.selectedElementIds : {};
          const editId = st && st.editingTextElement ? st.editingTextElement.id : null;
          const els = api.getSceneElementsIncludingDeleted() || [];
          const next = els.map((e: ExcalidrawElement) => (!e.isDeleted && (sel[e.id] || e.id === editId)
            ? { ...e, fontFamily: fam, version: e.version + 1 }
            : e));
          api.updateScene({ elements: next });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[dropsync] font reroute failed:', err);
        }
      }, 0);
    };
    window.addEventListener('pointerdown', onWinPointerDown, true);
    window.addEventListener('click', onWinClick, true);
    return () => {
      window.removeEventListener('pointerdown', onWinPointerDown, true);
      window.removeEventListener('click', onWinClick, true);
    };
  }, [initialScene]);

  const excalidrawTheme = 'light' as const;

  return (
    <div className={isFullscreen ? 'fixed inset-0 z-[999] bg-black/40 flex items-center justify-center p-4' : ''}>
      <div className={`flex flex-col ${isFullscreen ? `w-full h-full max-w-[1200px] ${isDark ? 'bg-[#0D0D0D]' : 'bg-[#FAF7F2]'} ${roundedClass} overflow-hidden shadow-2xl` : 'gap-3'}`}>
        <div className={isFullscreen ? 'flex-1 min-h-0 p-3' : ''}>
          <div
            className={`relative border ${isDark ? 'border-white/10' : 'border-[#1a1a1a]/20'} ${roundedClass} overflow-hidden`}
            style={{ height: isFullscreen ? 'calc(100vh - 120px)' : 350 }}
          >
            {/* FIX 21b canvas-local boundary: an in-editor failure degrades to a quiet
                empty-canvas placeholder (web parity — never a dead modal, never a white
                window). The user can Cancel or redraw; unsaved strokes are lost either way. */}
            <ErrorBoundary
              fallbackRender={() => (
                <div className={`absolute inset-0 ${isDark ? 'border-white/10' : 'border-[#1a1a1a]/20'} border rounded-lg`} />
              )}
              onCatch={(_error, _info) => {
                dcEvent('didCatch');
                // eslint-disable-next-line no-console
                console.warn('[dropsync] drawing canvas crash:', _error, _info?.componentStack);
              }}
            >
              <Suspense
                fallback={
                  <div className={`absolute inset-0 flex items-center justify-center ${isDark ? 'text-white/60' : 'text-[#1a1a1a]/50'}`}>
                    <div className="w-5 h-5 border-2 border-current/30 border-t-current animate-spin rounded-full" />
                  </div>
                }
              >
                <Excalidraw
                  excalidrawAPI={handleAPI}
                  initialData={{
                    elements: initialScene?.elements || [],
                    appState: {
                      viewBackgroundColor: bgColor,
                      ...initialScene?.appState,
                    },
                    files: initialScene?.files,
                  }}
                  onChange={handleChange}
                  theme={excalidrawTheme}
                  UIOptions={{
                    canvasActions: {
                      loadScene: false,
                      export: false,
                      saveToActiveFile: false,
                      changeViewBackgroundColor: false,
                    },
                    tools: { image: true },
                  }}
                  renderTopRightUI={() => null}
                  isCollaborating={false}
                />
              </Suspense>
            </ErrorBoundary>
            {/* Fullscreen toggle */}
            <button
              type="button"
              onClick={() => setIsFullscreen(!isFullscreen)}
              className={`absolute top-2 right-2 z-10 w-8 h-8 flex items-center justify-center bg-[#1a1a1a]/10 hover:bg-[#1a1a1a]/20 text-[#1a1a1a] ${roundedClass} transition-colors`}
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            >
              {isFullscreen ? (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                </svg>
              )}
            </button>
          </div>
        </div>
        <div className={isFullscreen ? `shrink-0 px-4 py-3 border-t ${isDark ? 'border-white/10' : 'border-[#1a1a1a]/10'}` : ''}>
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={onCancel}
              className={`px-4 py-2 text-xs border ${isDark ? 'border-white/10 text-white/70 hover:text-white' : 'border-[#1a1a1a]/20 text-[#1a1a1a]/70 hover:text-[#1a1a1a]'} ${roundedClass} transition-colors`}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              className={`px-4 py-2 text-xs ${isDark ? 'bg-white text-[#0D0D0D] hover:bg-white/90' : 'bg-[#1a1a1a] text-white hover:bg-[#2a2a2a]'} ${roundedClass} transition-colors`}
            >
              Save drawing
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export { BG_COLORS };
