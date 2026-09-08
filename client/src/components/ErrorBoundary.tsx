import { Component, ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, info: unknown) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Reusable Error Boundary for catching render errors in subtrees.
 * Shows a graceful fallback instead of crashing the entire app.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error("[ErrorBoundary] Unhandled UI error", error, info);
    this.props.onError?.(error, info);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div className="flex items-center justify-center min-h-[200px] p-8 bg-[#050505]">
          <div className="flex flex-col items-center w-full max-w-md p-6 text-center">
            <AlertTriangle size={48} className="text-red-500 mb-4 flex-shrink-0" />
            <h2 className="text-lg font-semibold text-white mb-2">Something went wrong</h2>
            <p className="text-sm text-zinc-400 mb-6">
              We couldn't load this section. Please try again.
            </p>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white text-black font-semibold hover:bg-white/90 transition-colors"
            >
              <RotateCcw size={16} />
              Retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Inline error fallback for list items - shows a placeholder card
 */
export function ErrorFallback({ retry }: { retry: () => void }) {
  return (
    <div className="group relative bg-zinc-900 rounded-xl overflow-hidden shadow-lg border border-white/5 aspect-[2/3] w-full">
      <div className="absolute inset-0 flex items-center justify-center bg-zinc-800">
        <div className="text-center p-4">
          <AlertTriangle size={32} className="text-red-500 mx-auto mb-2" />
          <p className="text-sm text-zinc-400">Failed to load</p>
          <button
            onClick={retry}
            className="mt-2 text-xs text-red-400 hover:text-red-300 underline"
          >
            Retry
          </button>
        </div>
      </div>
    </div>
  );
}

export default ErrorBoundary;