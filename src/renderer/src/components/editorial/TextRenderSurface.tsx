import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import html from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import bash from 'highlight.js/lib/languages/bash';

// Round 120 — desktop port of the web's TextRenderSurface (web Round 24). Everything
// detection/rendering is web-verbatim. The ONE replaced piece is the menu: the web's
// renderer-portal ViewAsMenu became a submenu of the app's native right-click menu
// (owner decision 2026-10-08). A right-click on the content div calls preventDefault —
// probe-proven to suppress Electron's webContents 'context-menu' event, so the
// round-111 menu stays silent for this click — then asks the main process (viewAs:menu)
// to build the combined menu: the round-111 items recomputed from renderer-side facts
// plus the "View as" submenu. A pick returns as viewAs:lensSelected. The lens is NEVER
// auto-applied; nothing is persisted. The web's touch long-press block is dropped
// (desktop vault surfaces are mouse/keyboard); its only job was opening the portal menu.

// Core only: HTML uses the XML grammar, registered under the one visible HTML lens.
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('json', json);
hljs.registerLanguage('html', html);
hljs.registerLanguage('css', css);
hljs.registerLanguage('bash', bash);

type Theme = 'light' | 'dark' | 'minimal';
export type TextLens = 'plain' | 'markdown' | 'typescript' | 'javascript' | 'python' | 'json' | 'html' | 'css' | 'bash';
export interface TextRecommendation { lens: TextLens; score: number }

const LENSES: { lens: TextLens; label: string }[] = [
  { lens: 'markdown', label: 'Markdown' },
  { lens: 'plain', label: 'Plain text' },
  { lens: 'typescript', label: 'TypeScript' },
  { lens: 'javascript', label: 'JavaScript' },
  { lens: 'python', label: 'Python' },
  { lens: 'json', label: 'JSON' },
  { lens: 'html', label: 'HTML' },
  { lens: 'css', label: 'CSS' },
  { lens: 'bash', label: 'Bash' },
];
const TIE_ORDER: TextLens[] = ['json', 'html', 'css', 'bash', 'python', 'javascript', 'typescript', 'markdown'];
const EXTENSIONS: Record<string, TextLens> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
  py: 'python', json: 'json', html: 'html', css: 'css', sh: 'bash', bash: 'bash', md: 'markdown', markdown: 'markdown',
};
const MIME_LENSES: Record<string, TextLens> = {
  'text/typescript': 'typescript', 'text/x-typescript': 'typescript',
  'text/javascript': 'javascript', 'application/javascript': 'javascript',
  'text/x-python': 'python', 'text/python': 'python',
  'application/json': 'json', 'text/json': 'json', 'text/html': 'html', 'text/css': 'css',
  'text/x-shellscript': 'bash', 'text/x-sh': 'bash', 'text/markdown': 'markdown', 'text/x-markdown': 'markdown',
};
const DETECTION_LIMIT = 32_768;
const HIGHLIGHT_LIMIT = 100_000;
const LINE_LIMIT = 20_000;
const labelFor = (lens: TextLens) => LENSES.find(item => item.lens === lens)!.label;

/** Pure, bounded presence scoring. MIME can corroborate, never nominate a language. */
export function detectTextLenses(content: string, name: string, mimeType?: string): TextRecommendation[] {
  const sample = content.slice(0, DETECTION_LIMIT);
  const scores = new Map<TextLens, number>();
  const add = (lens: TextLens, points: number) => scores.set(lens, Math.min(80, (scores.get(lens) ?? 0) + points));
  if (/^\s*(?:export\s+)?(?:interface|type|enum)\s+\w+/m.test(sample)) add('typescript', 45);
  if (/\b(?:const|let|var)\s+\w+\s*:\s*[\w[{]|\)\s*:\s*\w+|\w+\??\s*:\s*(?:string|number|boolean)\b/.test(sample)) add('typescript', 25);
  if (/\b(?:const|let|var|function)\s+\w+/.test(sample)) { add('javascript', 30); add('typescript', 30); }
  if (/=>/.test(sample)) { add('javascript', 15); add('typescript', 15); }
  if (/^\s*(?:import\s+.+\sfrom\s|export\s+(?:default|const|function)\b)/m.test(sample)) { add('javascript', 10); add('typescript', 10); }
  if (/^\s*(?:async\s+)?(?:def|class)\s+\w+[^\n]*:\s*$/m.test(sample)) add('python', 35);
  if (/:\s*\n[ \t]+\S/.test(sample)) add('python', 15);
  if (/^\s*(?:import\s+\w+|from\s+\S+\s+import\s+)/m.test(sample)) add('python', 20);
  if (content.length <= DETECTION_LIMIT) {
    try { JSON.parse(content); add('json', 60); } catch { /* Not complete JSON. */ }
  }
  if (/<[a-z][\w:-]*(?:\s[^<>]*?)?\s*\/?>/.test(sample)) add('html', 35);
  if (/<\/[a-z][\w:-]*\s*>/.test(sample)) add('html', 20);
  if (/<!doctype\s+html\b/i.test(sample)) add('html', 60);
  const cssBlock = sample.match(/^[ \t]*[.#@*a-z][^{}\n]{0,120}\{[^{}]{0,1600}\b[\w-]+\s*:\s*[^{};]+[;}]/m);
  if (cssBlock && !/^\s*(?:interface|type|enum|const|let|function|class)\b/.test(cssBlock[0])) add('css', 45);
  if (/^#![^\n]*(?:\/(?:ba)?sh\b|env\s+(?:ba)?sh\b)/.test(sample)) add('bash', 60);
  if (/^\s*(?:echo|printf|export|source|cd|set)\s+/m.test(sample)) add('bash', 30);
  if (/\$\{?[A-Za-z_]\w*\}?|\$\(/.test(sample)) add('bash', 15);
  if (/^\s*(?:if|for|while)\b[^\n]*\b(?:then|do)\b/m.test(sample)) add('bash', 25);
  const markdown = sample.replace(/#\[((?:\\.|[^\]\\])*)\]\(([^)]+)\)/g, '');
  if (/^\s{0,3}#{1,6}\s+\S/m.test(markdown)) add('markdown', 35);
  if (/^\s{0,3}(?:\x60{3,}|~{3,})/m.test(markdown)) add('markdown', 35);
  if (/\*\*[^*\n]+\*\*/.test(markdown)) add('markdown', 15);
  if (/^\s*[-*]\s+\S/m.test(markdown)) add('markdown', 20);
  if (/\[[^\]\n]+\]\([^)]+\)/.test(markdown)) add('markdown', 20);

  const extension = name.slice(-1024).match(/\.([^.]+)$/)?.[1].toLowerCase();
  const namedLens = extension && Object.hasOwn(EXTENSIONS, extension) ? EXTENSIONS[extension] : undefined;
  if (namedLens) scores.set(namedLens, (scores.get(namedLens) ?? 0) + 100);
  const mime = mimeType?.split(';')[0].trim().toLowerCase() ?? '';
  const mimeLens = Object.hasOwn(MIME_LENSES, mime) ? MIME_LENSES[mime] : undefined;
  if (mimeLens && scores.has(mimeLens)) scores.set(mimeLens, scores.get(mimeLens)! + 5);
  const recommendations = [...scores].filter(([, score]) => score >= 30)
    .sort(([a, aScore], [b, bScore]) => bScore - aScore || TIE_ORDER.indexOf(a) - TIE_ORDER.indexOf(b))
    .slice(0, 3).map(([lens, score]) => ({ lens, score }));
  return recommendations.length ? recommendations : [{ lens: 'plain', score: 0 }];
}

/** Null means React must render the full source as ordinary escaped monospace text. */
export function getHighlightedText(content: string, lens: TextLens): string | null {
  if (lens === 'plain' || lens === 'markdown' || content.length > HIGHLIGHT_LIMIT) return null;
  let lineLength = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n' || content[i] === '\r') lineLength = 0;
    else if (++lineLength > LINE_LIMIT) return null;
  }
  try { return hljs.highlight(content, { language: lens, ignoreIllegals: true }).value; }
  catch { return null; }
}

/** Keep the completed-chat plugin/link treatment, but render drop tokens as literal source. */
export function createTextMarkdownComponents(content: string): Components {
  return {
    a: ({ href, children, node }) => {
      const start = node?.position?.start.offset;
      const end = node?.position?.end.offset;
      if (start !== undefined && end !== undefined && content[start - 1] === '#') {
        const rawLink = content.slice(start, end);
        if (/^\[((?:\\.|[^\]\\])*)\]\(([^)]+)\)$/.test(rawLink)) return <span>{rawLink}</span>;
      }
      return <a href={href} target="_blank" rel="noopener noreferrer" className="ds-link">{children}</a>;
    },
  };
}

interface TextRenderSurfaceProps {
  content: string;
  name: string;
  mimeType?: string;
  theme?: Theme;
  editorial?: boolean;
  isFullscreen?: boolean;
  /** Desktop-only (round 120): which preview mount this is — routes the menu's pick back. */
  surfaceId: 'text-body' | 'text-file';
  children: ReactNode;
}

/** Mount/key defines a viewing session; fullscreen changes only the existing host's classes. */
export function TextRenderSurface({ content, name, mimeType, theme = 'light', editorial = false, isFullscreen = false, surfaceId, children }: TextRenderSurfaceProps) {
  const [lens, setLens] = useState<TextLens>('plain');
  const [dismissed, setDismissed] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const previousLens = useRef(lens);
  const recommendations = useMemo(() => detectTextLenses(content, name, mimeType), [content, name, mimeType]);
  const highlighted = useMemo(() => getHighlightedText(content, lens), [content, lens]);
  const markdownComponents = useMemo(() => createTextMarkdownComponents(content), [content]);
  const best = recommendations[0].lens;
  const isDark = theme === 'dark';

  const resetScroll = useCallback(() => {
    const surface = contentRef.current;
    if (!surface) return;
    surface.querySelectorAll<HTMLElement>('pre').forEach(node => node.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
    let node: HTMLElement | null = surface;
    while (node && node !== document.body && node !== document.documentElement) {
      node.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      if (getComputedStyle(node).position === 'fixed') break;
      node = node.parentElement;
    }
  }, []);
  useLayoutEffect(() => {
    if (previousLens.current === lens) return;
    previousLens.current = lens;
    resetScroll();
  }, [lens, resetScroll]);
  const selectLens = useCallback((choice: TextLens) => {
    resetScroll();
    setLens(choice);
    setDismissed(true);
  }, [resetScroll]);

  // Availability report (the round-119 blocker-callback shape): a live text surface tells
  // the main process it exists; the cleanup covers modal close, drop switch (the mount
  // key remounts), and busy unmounts — every path that ends a viewing session.
  useEffect(() => {
    void window.dropsync.viewAs.state({ available: true, surfaceId }).catch(() => undefined);
    return () => {
      void window.dropsync.viewAs.state({ available: false, surfaceId }).catch(() => undefined);
    };
  }, [surfaceId]);

  // Native-menu picks arrive here (viewAs:lensSelected; the pill receive pattern).
  useEffect(() => {
    const off = window.dropsync.viewAs.onViewAsLensSelected(selection => {
      if (selection.surfaceId === surfaceId) selectLens(selection.lens);
    });
    return off;
  }, [surfaceId, selectLens]);

  const colors = {
    '--tr-keyword': isDark ? '#fca5a5' : '#9f1239',
    '--tr-string': isDark ? '#86efac' : '#166534',
    '--tr-number': isDark ? '#fdba74' : '#9a3412',
    '--tr-type': isDark ? '#93c5fd' : '#1d4ed8',
    '--tr-title': isDark ? '#c4b5fd' : '#6d28d9',
    '--tr-comment': isDark ? '#a3a3a3' : '#626262',
    color: isDark ? '#ffffff' : 'var(--black)',
  } as CSSProperties;

  return (
    <div className={isFullscreen ? 'h-full min-h-0 flex flex-col' : 'min-w-0 max-w-full'}>
      {!dismissed && best !== 'plain' && (
        <div className={'mb-2 pr-9 flex items-start gap-2 text-xs shrink-0 ' + (isDark ? 'text-white/70' : 'text-[#1a1a1a]/70')}>
          <button type="button" className="text-left underline underline-offset-2" onClick={() => selectLens(best)}>
            Looks like {labelFor(best)} — view as {labelFor(best)}?
          </button>
          <button type="button" aria-label="Dismiss rendering suggestion" className="px-1" onClick={() => setDismissed(true)}>×</button>
        </div>
      )}
      <div
        ref={contentRef}
        className={isFullscreen ? 'min-w-0 min-h-0 flex-1' : 'min-w-0 max-w-full'}
        style={{ WebkitTouchCallout: 'none' }}
        onContextMenu={event => {
          event.preventDefault();
          event.stopPropagation();
          // preventDefault keeps the round-111 menu silent for THIS click (suppression
          // probe-proven 2026-10-08); the bridge request builds the combined menu in the
          // main process. Rejected invokes are swallowed: no menu, no crash.
          const text = window.getSelection()?.toString() ?? '';
          void window.dropsync.viewAs.menu({
            surfaceId,
            lens,
            lenses: LENSES,
            recommendations,
            selection: { text, isEditable: false, editFlags: { canCopy: text.trim().length > 0, canCut: false, canPaste: false } },
          }).catch(() => undefined);
        }}
      >
        {lens === 'plain' ? children : lens === 'markdown' ? (
          <div className={'text-sm leading-relaxed break-words [&_p]:mb-2 [&_p:last-child]:mb-0 [&_h1]:text-2xl [&_h2]:text-xl [&_h3]:text-lg [&_h1]:font-bold [&_h2]:font-bold [&_h3]:font-bold [&_h1]:mb-2 [&_h2]:mb-2 [&_h3]:mb-2 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_code]:break-all ' + (editorial ? 'font-[family-name:var(--font-raleway)] ' : '') + (isDark ? 'text-white ' : 'text-[#1a1a1a] ') + (isFullscreen ? 'h-full overflow-y-auto' : '')}>
            <ReactMarkdown remarkPlugins={[remarkBreaks]} components={markdownComponents}>{content}</ReactMarkdown>
          </div>
        ) : (
          <pre className={'ds-text-code text-sm font-mono leading-relaxed whitespace-pre break-normal min-w-0 max-w-full overflow-auto ' + (isFullscreen ? 'h-full' : 'max-h-[50vh]')} style={colors}>
            {highlighted === null ? <code>{content}</code> : <code dangerouslySetInnerHTML={{ __html: highlighted }} />}
          </pre>
        )}
      </div>
    </div>
  );
}
