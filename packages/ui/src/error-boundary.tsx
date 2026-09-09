"use client";

import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

export interface ErrorBoundaryProps {
  readonly children: ReactNode;
  readonly fallback?: ReactNode;
  readonly onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public override state: ErrorBoundaryState = { error: null };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  public override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  public override render(): ReactNode {
    if (this.state.error === null) {
      return this.props.children;
    }

    return (
      this.props.fallback ?? (
        <section aria-live="assertive" className="fd-error-boundary" role="alert">
          <p className="fd-eyebrow">Application error</p>
          <h1>Compasso could not render this view.</h1>
          <p>{this.state.error.message}</p>
        </section>
      )
    );
  }
}
