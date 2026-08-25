/**
 * FIX 21b — render-crash containment. Bug #21 (a persisted drawing appState throwing inside
 * Excalidraw's InteractiveCanvas render) blanked the WHOLE window because nothing caught
 * render-phase throws. This class boundary is mandatory insurance: a crash degrades to a
 * self-contained fallback card instead of a white screen.
 *
 * The fallback uses inline styles and plain DOM only — no hooks, no theme context, nothing
 * that can itself throw. Boundaries catch render/lifecycle-phase errors; event-handler and
 * async rejections remain governed by the existing try/catch guards.
 */

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Optional quieter fallback for embedded surfaces (e.g. the drawing canvas renders a quiet
   * empty-canvas placeholder instead of the global card — web parity: extraction failure ⇒
   * empty editor, never a dead modal).
   */
  fallbackRender?: () => ReactNode;
  /**
   * Overrides the default console.error reporting (the canvas-local instance warns instead of
   * erroring so an in-editor failure stays proportionate).
   */
  onCatch?: (error: unknown, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  caught: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { caught: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { caught: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    if (this.props.onCatch) {
      this.props.onCatch(error, info);
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[dropsync] render crash:', error, info?.componentStack);
  }

  render(): ReactNode {
    if (this.state.caught) {
      if (this.props.fallbackRender) return this.props.fallbackRender();
      return (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#FAF7F2',
            color: '#1A1A1A',
            fontFamily: 'Raleway, Inter, system-ui, sans-serif',
            zIndex: 9999,
          }}
        >
          <div
            style={{
              textAlign: 'center',
              padding: '32px',
              maxWidth: '420px',
            }}
          >
            <h1 style={{ fontSize: '18px', fontWeight: 600, margin: '0 0 8px' }}>
              Something went wrong
            </h1>
            <p style={{ fontSize: '14px', opacity: 0.7, margin: '0 0 20px' }}>
              The app hit an unexpected error. Your vault is safe.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                background: '#1A1A1A',
                color: '#FFFFFF',
                border: 'none',
                borderRadius: '8px',
                padding: '10px 28px',
                fontSize: '14px',
                cursor: 'pointer',
              }}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
