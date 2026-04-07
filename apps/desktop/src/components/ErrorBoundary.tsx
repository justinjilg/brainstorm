import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props {
  children: ReactNode;
  fallbackLabel?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

/**
 * Error Boundary — catches render errors in any view and shows
 * a recoverable fallback instead of a white screen.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
    console.error(
      `[ErrorBoundary] ${this.props.fallbackLabel ?? "Component"} crashed:`,
      error,
      errorInfo,
    );
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-md text-center">
            <div className="text-2xl mb-3 text-[var(--ctp-red)]">⚠</div>
            <div className="text-sm font-medium text-[var(--ctp-text)] mb-1">
              {this.props.fallbackLabel ?? "View"} crashed
            </div>
            <div className="text-xs text-[var(--ctp-overlay1)] mb-4">
              {this.state.error?.message ?? "Unknown error"}
            </div>
            <button
              onClick={() =>
                this.setState({
                  hasError: false,
                  error: null,
                  errorInfo: null,
                })
              }
              className="px-4 py-1.5 rounded-lg text-xs font-medium bg-[var(--ctp-surface0)] text-[var(--ctp-text)] hover:bg-[var(--ctp-surface1)] transition-colors"
            >
              Try Again
            </button>
            {this.state.errorInfo && (
              <details className="mt-4 text-left">
                <summary className="text-[10px] text-[var(--ctp-overlay0)] cursor-pointer">
                  Stack trace
                </summary>
                <pre className="mt-2 text-[10px] text-[var(--ctp-overlay0)] font-mono whitespace-pre-wrap overflow-auto max-h-40 bg-[var(--ctp-surface0)] rounded p-2">
                  {this.state.errorInfo.componentStack}
                </pre>
              </details>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
