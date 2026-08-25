/**
 * C1 — mode badge (planner §4 ruling): a WebContentsView always paints ABOVE our renderer
 * HTML, so instead of an overlay the cloud view reserves a bottom band (main/cloud.ts
 * NOTCH_H); this badge lives in that band of OUR DOM — dot + word, quiet Editorial styling.
 *
 * Visible in ALL local states AND while the cloud view is up. Click opens a tiny popover
 * (plain React state; closes on outside click / Esc):
 *   Local: ["Switch to Cloud", "Desktop settings"]   Cloud: ["Switch to Local", "Desktop settings"]
 * Menu renders inside our DOM under the band — it can never fight the view for z-order.
 */

import { useEffect, useRef, useState } from 'react';

export type DesktopMode = 'cloud' | 'local';

interface ModeBadgeProps {
  mode: DesktopMode;
  onSwitch: () => void;
  onOpenSettings: () => void;
}

const HEIGHT = 34; // keep in sync with main/cloud.ts NOTCH_H

export function ModeBadge({ mode, onSwitch, onOpenSettings }: ModeBadgeProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const dotColor = mode === 'cloud' ? '#3B82F6' : '#16A34A'; // blue = site session, green = sealed vault
  const items: Array<{ label: string; run: () => void }> = [
    { label: mode === 'cloud' ? 'Switch to Local' : 'Switch to Cloud', run: onSwitch },
    { label: 'Desktop settings', run: onOpenSettings },
  ];

  return (
    <div ref={rootRef} className="fixed bottom-0 right-0 z-[9999]" style={{ height: HEIGHT }}>
      {open && (
        <div
          className="absolute bottom-full right-0 mb-1 w-44 rounded-lg border border-[#1a1a1a]/10 bg-[#FAF7F2] shadow-lg py-1"
          role="menu"
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                it.run();
              }}
              className="block w-full text-left px-3 py-2 text-sm text-[#1a1a1a] hover:bg-[#1a1a1a]/5 transition-colors font-medium tracking-tight"
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        aria-label={`Mode: ${mode === 'cloud' ? 'Cloud' : 'Local'} — open mode menu`}
        onClick={() => setOpen((v) => !v)}
        className="flex h-full w-auto min-w-[112px] items-center justify-end gap-2 border-l border-t border-[#1a1a1a]/10 bg-[#FAF7F2] px-3 text-[13px] font-medium tracking-tight text-[#1a1a1a] hover:bg-[#f3ede3] transition-colors"
        style={{ height: HEIGHT }}
      >
        <span
          aria-hidden
          className="inline-block rounded-full"
          style={{ width: 8, height: 8, backgroundColor: dotColor }}
        />
        <span>{mode === 'cloud' ? 'Cloud' : 'Local'}</span>
      </button>
    </div>
  );
}
