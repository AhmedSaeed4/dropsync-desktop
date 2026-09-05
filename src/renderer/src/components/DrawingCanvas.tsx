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
  // 108: font-reroute state — the pointerdown popup snapshot (Radix closes the popup at item
  // pointerdown, so an apply-time check provably misses; investigation 26-2 §4) and the
  // one-shot re-apply arm consumed by the watcher below.
  const popupAtPointerDownRef = useRef(false);
  const reapplyRef = useRef<{ ids: string[]; fam: number; at: number } | null>(null);
  // 108c: pointerdown-apply marker consumed by the click-path double-apply guard (§4.2) —
  // records the last popup-item family applied directly at pointerdown.
  const pdAppliedRef = useRef<{ fam: number; at: number } | null>(null);

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
  // Family values are the MEASURED 0.18.1 enum (prod chunk + dev prebundle; the d.ts declares
  // KEYS only): Virgil=1, Helvetica=2, Cascadia=3, 4=UNUSED, Excalifont=5, Nunito=6,
  // "Lilita One"=7, "Comic Shanns"=8, "Liberation Sans"=9. The old 4/5/7 here was an ordinal
  // guess — wrong on all three triggers (investigations 26-1/26-2; stock DEFAULT_FONTS
  // carries 5/6/8): hand-drawn=5 (Excalifont), normal=6 (Nunito), code=8 (Comic Shanns).
  useEffect(() => {
    if (!initialScene) return; // create mode — stock pipeline
    const onWinPointerDown = (ev: PointerEvent) => {
      const target = ev.target as HTMLElement | null;
      if (!target || !target.closest) return;
      if (!target.closest('[data-testid^="font-family-"], .FontPicker__dropdown, .dropdown-menu-item')) return;
      // 108: snapshot the popup state for the re-apply guard (see the watcher below).
      try {
        const st = typeof apiRef.current?.getAppState === 'function' ? apiRef.current.getAppState() : null;
        popupAtPointerDownRef.current = !!st && st.openPopup === 'fontFamily';
      } catch {
        popupAtPointerDownRef.current = false;
      }
      // 108 FIX (was: active.blur() — investigation 26-1 Q1: our blur ran the library's
      // handleSubmit SYNCHRONOUSLY, tearing down the editor AND unmounting the font panel
      // before the click ever fired; the stock suppressor registers LATER than us and could
      // never fire). preventDefault cancels the compatibility mousedown, so focus never
      // leaves the textarea: no submit, no teardown, the click survives — the same shape the
      // library itself uses for properties-panel clicks (temporarilyDisableSubmit:
      // "editable.onblur = null" + isPropertiesTrigger).
      ev.preventDefault();
      // 108c (repair order 108c §4.1; direction (a) of investigation 26-3 §5): apply the
      // family at POINTERDOWN, popup items ONLY. With preventDefault active (which MUST
      // stay — round-8 constraint) the popup item detaches +20…75 ms into a human-length
      // press (26-3 E3/E4/E5; causal replica C3pd/C5pd), so the release lands on the
      // canvas, NO click event is ever created, and the click path below never runs. At
      // pointerdown the item is provably alive and the editing clone still exists (the
      // 26-3 H4 window) — resolve and apply here, SYNCHRONOUSLY (not setTimeout), with the
      // same text-scoped shape as the click path. Quick buttons + trigger: NO apply here
      // (their clicks provably land — 26-3 E6/E6-ta2); snapshot + preventDefault unchanged.
      // Accepted corner (order §6): an ABORTED press (press an item, release off it) now
      // applies that font — unavoidable when applying at pd; one Ctrl+Z away; stock
      // select-at-press widgets behave similarly.
      if (popupAtPointerDownRef.current) {
        try {
          const item = target.closest('.dropdown-menu-item[value]');
          const fam = item ? Number(item.getAttribute('value')) || 0 : 0;
          if (fam) {
            // §4.2 guard marker — record whenever the pd path ran with a resolved fam.
            pdAppliedRef.current = { fam, at: Date.now() };
            const api = apiRef.current;
            if (api && typeof api.getAppState === 'function' && typeof api.getSceneElementsIncludingDeleted === 'function' && typeof api.updateScene === 'function') {
              const st = api.getAppState();
              const sel = st ? st.selectedElementIds : {};
              const editId = st && st.editingTextElement ? st.editingTextElement.id : null;
              const els = api.getSceneElementsIncludingDeleted() || [];
              const targetIds: string[] = [];
              const hitIds: string[] = [];
              const next = els.map((e: ExcalidrawElement) => {
                if (e.isDeleted || e.type !== 'text' || !(sel[e.id] || e.id === editId)) return e;
                targetIds.push(e.id);
                if (e.fontFamily === fam) return e;
                hitIds.push(e.id);
                return { ...e, fontFamily: fam, version: e.version + 1 };
              });
              if (hitIds.length) {
                api.updateScene({ elements: next, captureUpdate: 'IMMEDIATELY' });
              }
              if (targetIds.length) {
                // 108c DEVIATION FROM THE ORDER'S §4.1 no-arm clause (flagged in the report):
                // the order says "if NO element matched … do NOT write and do NOT arm
                // (nothing can be lost)". Measured false (GREEN-1/2 first attempt): the
                // stock HOVER PREVIEW already wrote fam into the scene by the time the
                // human press lands (pointerdown reads fam=7 over a true-scene 8), so
                // "no element matched" is the NORMAL owner case — and the popup-close
                // resetAll reverts that hover write (the 26-3 snap-back). The arm must
                // cover ALL text-scoped targets, write or no write; when the font was
                // already true-scene the watcher finds nothing lost and expires idle
                // (no fire, no history entry). Arming without writing costs nothing.
                reapplyRef.current = { ids: targetIds, fam, at: Date.now() };
              }
            }
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[dropsync] font pd-apply failed:', err);
        }
      }
    };
    const onWinClick = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null;
      if (!target || !target.closest) return;
      const item = target.closest('.dropdown-menu-item[value]');
      const quick = target.closest('[data-testid="font-family-hand-drawn"], [data-testid="font-family-normal"], [data-testid="font-family-code"]');
      if (!item && !quick) return;
      // 108c §4.2 double-apply guard: a popup-item click that DID land (robot timing,
      // keyboard activation) after a pd apply of the SAME family within 1000 ms is already
      // owned by the pd apply — swallow it (no second version bump, no second history
      // entry). Keyboard Enter activation fires a click with NO preceding pd apply, so the
      // guard's window can never swallow it. Quick-button branch: untouched.
      if (item) {
        const marker = pdAppliedRef.current;
        const itemFam = Number(item.getAttribute('value')) || 0;
        if (marker && itemFam && marker.fam === itemFam && Date.now() - marker.at < 1000) {
          pdAppliedRef.current = null;
          ev.preventDefault();
          ev.stopPropagation();
          return;
        }
      }
      const api = apiRef.current;
      if (!api || !api.updateScene || !api.getSceneElementsIncludingDeleted) return;
      let fam = 0;
      if (item) fam = Number(item.getAttribute('value')) || 0;
      else if (quick) {
        const tid = quick.getAttribute('data-testid');
        fam = tid === 'font-family-hand-drawn' ? 5 : tid === 'font-family-normal' ? 6 : 8;
      }
      if (!fam) return;
      ev.preventDefault();
      ev.stopPropagation();
      // 108: NO blur (the old lines committed the text edit via the same panel-destroying
      // submit — investigations 26-1 Q1/Q2). The family lands on the LIVE editing element /
      // selection, the wysiwyg live-restyles, and the user's later commit preserves it.
      window.setTimeout(() => {
        try {
          const st = typeof api.getAppState === 'function' ? api.getAppState() : null;
          const sel = st ? st.selectedElementIds : {};
          const editId = st && st.editingTextElement ? st.editingTextElement.id : null;
          const els = api.getSceneElementsIncludingDeleted() || [];
          const hitIds: string[] = [];
          const next = els.map((e: ExcalidrawElement) => {
            // 108: TEXT elements only — the old shape painted fontFamily onto selected
            // shapes (26-2 V2b); stock scopes the same way (isTextElement).
            if (e.isDeleted || e.type !== 'text' || !(sel[e.id] || e.id === editId)) return e;
            hitIds.push(e.id);
            return { ...e, fontFamily: fam, version: e.version + 1 };
          });
          // 108 (§4.0 verdict: PATH FOUND, owner pre-authorized variant): the apply passes
          // captureUpdate:'IMMEDIATELY' — the public updateScene's own history-capture flag
          // (enum value measured live off the library's CaptureUpdateAction, which the stock
          // font action itself uses). The apply JOINS the stock undo/redo stack: Ctrl+Z
          // reverts family+version coherently, Ctrl+Shift+Z restores (probed: undo f8→5,
          // redo 5→8 vs. plain updateScene which history never touches). A static enum
          // import here would break this file's lazy-load invariant, so the literal rides
          // on the contextually-typed union instead.
          api.updateScene({ elements: next, captureUpdate: 'IMMEDIATELY' });
          // 108 complement arm — dropdown clicks only (a font popup was open at pointerdown):
          // the stock popup-close resetAll restores its stale snapshot and can overwrite this
          // apply (race proven both ways). The watcher below re-applies ONCE.
          if (popupAtPointerDownRef.current && hitIds.length) {
            reapplyRef.current = { ids: hitIds, fam, at: Date.now() };
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[dropsync] font reroute failed:', err);
        }
      }, 0);
    };
    // 108 one-shot re-apply watcher (investigation 26-2 §4, guards probe-proven): the
    // dropdown's stock popup-close resetAll can overwrite our apply. Poll; when the popup is
    // gone AND our family no longer sits on every target AND < 1500 ms since the arm,
    // re-apply ONCE and consume the arm. Consume-before-apply keeps it one-shot (no loops);
    // a won race consumes with no fire; later deliberate changes re-arm through the click
    // handler or land outside the window and stick; hover-only sessions never arm.
    const watcher = window.setInterval(() => {
      const arm = reapplyRef.current;
      if (!arm) return;
      const api = apiRef.current;
      if (!api || typeof api.getAppState !== 'function' || !api.getSceneElementsIncludingDeleted || !api.updateScene) {
        reapplyRef.current = null;
        return;
      }
      if (Date.now() - arm.at >= 1500) {
        reapplyRef.current = null;
        return;
      }
      try {
        const st = api.getAppState();
        if (st && st.openPopup === 'fontFamily') return; // popup still up — not the revert yet
        const els = api.getSceneElementsIncludingDeleted() || [];
        const lost = els.some((e: ExcalidrawElement) => arm.ids.includes(e.id) && !e.isDeleted && e.type === 'text' && e.fontFamily !== arm.fam);
        // 108 DEVIATION FROM THE ORDER'S §4.5 TEXT (flagged in the round report): the arm is
        // HELD on a momentarily-correct scene instead of being consumed. Radix's popup-close
        // resetAll can be deferred (~100 ms, past our apply AND past the first poll) — the
        // order's consume-on-no-op let that late revert win (battery bootGF: final family 8
        // after a 7 click). One-shot is preserved: the only consumes are the fire below
        // (consume BEFORE the re-apply, so no loops) and the 1500 ms expiry above.
        if (!lost) return;
        const next = els.map((e: ExcalidrawElement) => (arm.ids.includes(e.id) && !e.isDeleted && e.type === 'text' && e.fontFamily !== arm.fam)
          ? { ...e, fontFamily: arm.fam, version: e.version + 1 }
          : e);
        reapplyRef.current = null; // consume FIRST — one-shot by construction
        // 108: same §4.0 PATH as the click apply — the re-apply joins history too.
        api.updateScene({ elements: next, captureUpdate: 'IMMEDIATELY' });
      } catch {
        reapplyRef.current = null;
      }
    }, 25);
    window.addEventListener('pointerdown', onWinPointerDown, true);
    window.addEventListener('click', onWinClick, true);
    return () => {
      window.clearInterval(watcher);
      reapplyRef.current = null;
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
