import { useEffect, useRef } from 'react';

// open = true while the modal is open. onClose = the same handler the X/backdrop use.
//
// Desktop port of the web hook: an Electron renderer has session history, so opening a modal
// pushes a sentinel history entry; the browser/app Back (Alt+Left, mouse button 4) pops it and
// closes the topmost modal instead of leaving the page.
//
// Token-based hardening: every open stamps a UNIQUE token into both the history entry and an
// active-stack, and every decision (close-on-pop, consume-entry-on-unmount) verifies tokens
// against CURRENT history state. This makes the hook immune to React.StrictMode's dev-only
// mount→cleanup→remount replay, where the ghost first mount's cleanup used to fire an async
// history.back() that swallowed the REAL mount's entry and instantly closed the modal
// ("modal flashes for one frame" bug).
const SENTINEL = 'dropsync-modal';

let seq = 0;
const stack: number[] = []; // active tokens, LIFO

export function useModalBackClose(open: boolean, onClose: () => void, enabled = true) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open || !enabled) return;
    const token = ++seq;
    stack.push(token);
    history.pushState({ [SENTINEL]: token }, '');

    const onPop = (event: PopStateEvent) => {
      // After a back-navigation, e.state is the entry NOW current. Every active token ABOVE it
      // belonged to entries that were popped → close those instances. If the current entry
      // carries no known token, everything was unwound → close all.
      const cur = (event.state as Record<string, unknown> | null)?.[SENTINEL];
      const idx = typeof cur === 'number' ? stack.indexOf(cur) : -1;
      const toClose = idx >= 0 ? stack.slice(idx + 1) : [...stack];
      for (const t of toClose) {
        const i = stack.indexOf(t);
        if (i >= 0) stack.splice(i, 1);
      }
      if (toClose.includes(token)) onCloseRef.current();
    };
    window.addEventListener('popstate', onPop);

    return () => {
      window.removeEventListener('popstate', onPop);
      const i = stack.indexOf(token);
      if (i >= 0) stack.splice(i, 1);
      // Consume OUR history entry only if it is still the current one when this deferred check
      // runs. The zero-delay defer lets StrictMode's ghost cleanup lose the race against the
      // real mount's pushState (its token no longer matches → no back() → no flash-close).
      setTimeout(() => {
        try {
          if ((history.state as Record<string, unknown> | null)?.[SENTINEL] === token) {
            history.back();
          }
        } catch {
          /* navigation unavailable — nothing to unwind */
        }
      }, 0);
    };
  }, [open, enabled]);
}
