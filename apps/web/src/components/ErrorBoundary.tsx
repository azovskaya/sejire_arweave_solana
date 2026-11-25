import { Component, type ErrorInfo, type ReactNode } from "react";
import { loadDraftTree } from "../lib/draftStorage";
import { rememberScreen } from "../lib/lastScreen";
import { defaultGuide, loadGuide } from "../lib/guide";
import { downloadTreeJson } from "../lib/treeJson";
import { resolveUiLocale } from "../lib/i18n/locale";
import { uiT } from "../lib/i18n/messages";

type Props = { children: ReactNode };
type State = { error: Error | null; exportHint: string | null };

/**
 * Last line of defence: a thrown render must not become a blank white tab.
 * Drafts live in localStorage — reload usually brings the tree back.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null, exportHint: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, exportHint: null };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("SEJIRE crash", error, info.componentStack);
  }

  private exportDraft = () => {
    const t = uiT(resolveUiLocale());
    try {
      const store = loadDraftTree();
      if (!store) {
        this.setState({ exportHint: t.crash.noDraft });
        return;
      }
      downloadTreeJson(store, loadGuide() ?? defaultGuide());
      this.setState({ exportHint: t.crash.jsonDownloaded });
    } catch (e) {
      this.setState({
        exportHint: e instanceof Error ? e.message : t.crash.jsonFailed,
      });
    }
  };

  render() {
    if (!this.state.error) return this.props.children;
    const t = uiT(resolveUiLocale());
    return (
      <div className="crash-screen">
        <p className="crash-brand">SEJIRE</p>
        <h1>{t.crash.title}</h1>
        <p className="sub">{t.crash.body}</p>
        <pre className="crash-detail">{this.state.error.message}</pre>
        {this.state.exportHint ? <p className="sub">{this.state.exportHint}</p> : null}
        <button
          type="button"
          className="btn"
          onClick={() => {
            if (loadDraftTree()) {
              rememberScreen("work");
              // Deep links take precedence over the remembered editor screen.
              // Leave the failed route before reloading the saved draft.
              history.replaceState(null, "", location.pathname + location.search);
            }
            window.location.reload();
          }}
        >
          {loadDraftTree() ? t.crash.openDraft : t.crash.reload}
        </button>
        <button type="button" className="btn ghost" onClick={this.exportDraft}>
          {t.crash.exportJson}
        </button>
      </div>
    );
  }
}
