import { useEffect } from 'react';

/**
 * Locks body scroll while a modal is open — desktop port of the web hook, minus the Lenis
 * freeze (the desktop app has no smooth-scroll library to freeze).
 */
export function useBodyScrollLock() {
  useEffect(() => {
    const originalOverflow = document.body.style.overflow;
    const originalPaddingRight = document.body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }
    return () => {
      document.body.style.overflow = originalOverflow;
      document.body.style.paddingRight = originalPaddingRight;
    };
  }, []);
}
