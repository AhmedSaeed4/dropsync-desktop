import { useEffect, useRef, useState } from 'react';
import { getEditorialThemeColors } from '../../lib/editorialTheme';

type Theme = 'light' | 'dark' | 'minimal';

export interface EditorialSelectOption {
  value: string;
  label: string;
}

interface EditorialSelectProps {
  /** Same controlled contract as a native <select>. */
  value: string;
  onChange: (value: string) => void;
  options: EditorialSelectOption[];
  theme?: Theme;
  ariaLabel?: string;
  disabled?: boolean;
  /** Extra layout classes for the host form row (width etc.). */
  className?: string;
}

/**
 * Shared Editorial custom dropdown (FIX 2) — replaces every remaining native <select> in the
 * renderer. Trigger button (current label + chevron, tc tokens) opening a popup list panel
 * styled identically to the workspace-switcher dropdown: invisible fixed backdrop click
 * closes, Escape closes, active option carries the active-pill treatment.
 */
export function EditorialSelect({
  value,
  onChange,
  options,
  theme = 'light',
  ariaLabel,
  disabled = false,
  className = '',
}: EditorialSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const tc = getEditorialThemeColors(theme);

  // Escape closes (mirrors the workspace switcher / sort menu keyboard behavior). While our
  // menu is open we swallow the keypress so a HOST modal (Settings/Import) doesn't double-close.
  // Registered on WINDOW in the capture phase — that runs before ANY document-level listener
  // (useEscapeClose is document-capture), so the swallow actually sticks regardless of which
  // host mounted first.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div ref={rootRef} className={`relative ${className}`} data-editorial-select="true">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        className={`w-full flex items-center justify-between gap-2 border px-3 py-2.5 text-sm outline-none rounded-lg focus:border-[#1a1a1a] transition-colors ${tc.border} ${tc.bg} ${tc.fontClass} ${
          current ? tc.text : tc.muted
        } ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:border-[#1a1a1a]'}`}
      >
        <span className="truncate text-left">{current?.label ?? '—'}</span>
        <svg
          className={`w-3.5 h-3.5 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''} ${tc.muted}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <>
          {/* Invisible backdrop — any outside click closes (same pattern as the switcher). */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            data-editorial-select-menu="true"
            role="listbox"
            aria-label={ariaLabel}
            className={`absolute top-full left-0 mt-1 w-full z-50 border rounded-lg shadow-lg overflow-hidden max-h-60 overflow-y-auto thin-scrollbar ${tc.border} ${tc.bg}`}
          >
            {options.map((option) => {
              const active = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={active}
                  data-value={option.value}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={`w-full px-3 py-2 text-left text-sm flex items-center justify-between gap-2 transition-colors ${tc.fontClass} ${
                    active
                      ? `${tc.activePillBg} ${tc.activePillText}`
                      : `${tc.text} hover:bg-[#1a1a1a]/5`
                  }`}
                >
                  <span className="truncate">{option.label}</span>
                  {active && (
                    <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
