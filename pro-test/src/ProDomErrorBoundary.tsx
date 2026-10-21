import { Component, type ErrorInfo, type ReactNode } from 'react';
import * as Sentry from '@sentry/react';

import { isRemoveChildError } from './services/clerk-dom-safety';

interface ProDomErrorBoundaryProps {
  children: ReactNode;
}

interface ProDomErrorBoundaryState {
  failed: boolean;
}

/**
 * React can encounter a stale text node when a browser translator replaces a
 * direct child just before an auth step is deleted. A normal render error is
 * allowed to reach the default handler; only this DOM teardown failure gets a
 * recovery affordance so a completed sign-up does not leave a blank /pro page.
 */
export class ProDomErrorBoundary extends Component<
  ProDomErrorBoundaryProps,
  ProDomErrorBoundaryState
> {
  state: ProDomErrorBoundaryState = { failed: false };
  declare props: ProDomErrorBoundaryProps;

  static getDerivedStateFromError(error: Error): ProDomErrorBoundaryState {
    if (!isRemoveChildError(error)) throw error;
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (!isRemoveChildError(error)) throw error;
    Sentry.captureException(error, {
      tags: { surface: 'pro-marketing', component: 'pro-dom-error-boundary' },
      extra: { componentStack: info.componentStack },
    });
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;

    return (
      <div
        role="alert"
        translate="no"
        data-testid="pro-dom-error-boundary"
        className="flex min-h-screen flex-col items-center justify-center gap-4 bg-wm-bg px-6 text-center"
      >
        <h1 className="font-mono text-lg font-bold uppercase tracking-wider text-wm-text">
          Page content changed
        </h1>
        <p className="max-w-md text-sm text-wm-muted">
          The browser translated or replaced content while /pro was updating. Reload to continue
          with your saved progress.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="bg-wm-green px-5 py-2.5 font-mono text-sm font-bold uppercase tracking-wider text-wm-bg transition-colors hover:bg-green-400"
        >
          Reload /pro
        </button>
      </div>
    );
  }
}
