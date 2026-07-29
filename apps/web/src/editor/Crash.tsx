// A component throwing must not take the window with it.
//
// React unmounts the entire tree when a render throws and nothing catches it, and an unmounted tree
// is an empty page: CupCat opened to a completely black window, which looks exactly like a broken
// install and tells the user nothing. It has now happened twice for unrelated reasons, so the class
// of failure is worth closing rather than each instance of it.
//
// This catches the throw, keeps the window, and says what happened — with the message and stack in
// reach, because the whole difficulty the first time was having no idea what had failed.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "./i18n";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
  info: string;
}

export class Crash extends Component<Props, State> {
  state: State = { error: null, info: "" };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Straight to the console so it lands in the engine log the feedback bundle collects.
    console.error("[cupcat] the interface stopped:", error, info.componentStack);
    this.setState({ info: info.componentStack ?? "" });
  }

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-neutral-950 p-8 text-neutral-200">
        <div className="max-w-xl">
          <h1 className="text-lg font-semibold">{t("crash.title")}</h1>
          <p className="mt-2 text-sm text-neutral-400">{t("crash.body")}</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 rounded bg-teal-500 px-3 py-1.5 text-sm font-medium text-teal-950 hover:bg-teal-400"
          >
            {t("crash.reload")}
          </button>
          <pre className="mt-4 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-3 text-[11px] leading-relaxed text-neutral-400">
            {error.message}
            {info}
          </pre>
        </div>
      </div>
    );
  }
}
