import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/** Last line of defence: a crash in one view must not blank the whole app —
 * and must not read like a debugger. Details stay one click away. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[tandem] view crashed:", error, info.componentStack);
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="error-panel">
          <h2>Something went wrong</h2>
          <p className="error-detail">
            This view ran into a problem. Your documents are safe — try again,
            or reload the page if it keeps happening.
          </p>
          <div className="error-actions">
            <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
            <button type="button" className="btn" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
          <details className="error-tech">
            <summary>Technical details</summary>
            <pre>{this.state.error.message}</pre>
          </details>
        </div>
      );
    }
    return this.props.children;
  }
}
