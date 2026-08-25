import { useEffect } from 'react';

/**
 * Polish sweep #3 (M8): Escape closes the topmost dialog through its OWN close path — the same
 * guarded handler the X button and backdrop use — so discard-confirmations, busy states and the
 * back-close token machinery all behave identically. `active=false` suspends the listener
 * (nested dialogs own the key while they are up).
 */
export function useEscapeClose(active: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [active, onClose]);
}
