import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Keeps one broken page from blanking the whole console: the sidebar stays usable and the page shows what
 * went wrong. Layout keys it by path, so moving to another page starts fresh.
 */
export class PageErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[witden] page crashed", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="page">
        <div className="callout callout-bad">
          <strong>这个页面出错了。</strong>
          <p className="small">{error.message}</p>
          <div className="btn-row">
            <button type="button" className="btn btn-sm" onClick={() => this.setState({ error: null })}>
              重试
            </button>
            <button type="button" className="btn btn-sm" onClick={() => window.location.reload()}>
              重新加载页面
            </button>
          </div>
        </div>
      </div>
    );
  }
}
