// Live progress for long-running tools. auto_clips (and friends) already narrate their phases
// internally; without a channel out, that text was discarded and the UI sat frozen for minutes on a
// long video. The executor emits here, the server installs a sink that broadcasts to every client.

export interface ToolProgress {
  tool: string;
  text: string;
}

type Sink = (p: ToolProgress) => void;
let sink: Sink | null = null;

/** The server installs the broadcast sink once at startup. */
export function setProgressSink(fn: Sink | null): void {
  sink = fn;
}

/** Report a phase from inside a long-running tool. Never throws — progress is cosmetic. */
export function emitProgress(tool: string, text: string): void {
  try {
    sink?.({ tool, text });
  } catch {
    /* a broken client must never break the tool it's watching */
  }
}
