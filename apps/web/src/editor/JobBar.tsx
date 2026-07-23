// A visible "something is working" bar, with a way to stop it.
//
// Long operations used to be invisible: no name, no progress, no stop. A half-hour job and a frozen
// app looked identical, and the only thing to do was wait. This is the difference between the two.

import { useEffect, useState } from "react";
import { t } from "./i18n";
import { BRIDGE_HTTP, useEditor } from "./store";

interface Job {
  id: string;
  tool: string;
  label: string;
  startedAt: number;
}

/** The operation's name in the user's language. The engine sends an English label as a fallback so
 * a tool added later still shows something sensible rather than a blank bar. */
function jobLabel(job: Job): string {
  const key = `job.t.${job.tool}` as never;
  const translated = t(key);
  return translated === key ? job.label : translated;
}

function elapsed(sinceMs: number): string {
  const s = Math.max(0, Math.round((Date.now() - sinceMs) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export function JobBar() {
  const { toolProgress } = useEditor(); // { tool, text } | null
  const [job, setJob] = useState<Job | null>(null);
  const [stopping, setStopping] = useState(false);
  const [tick, setTick] = useState(0);

  // Polled over HTTP rather than pushed over the WebSocket on purpose: if the socket is the thing
  // in trouble, this is exactly when the user most needs to see what is running and stop it.
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`${BRIDGE_HTTP}/jobs`).then((x) => x.json());
        if (!alive) return;
        setJob(r?.job ?? null);
        if (!r?.job) setStopping(false);
      } catch {
        /* engine unreachable — the reconnect banner covers that case */
      }
    };
    void poll();
    const id = setInterval(poll, 1000);
    const clock = setInterval(() => setTick((n) => n + 1), 1000);
    return () => {
      alive = false;
      clearInterval(id);
      clearInterval(clock);
    };
  }, []);

  if (!job) return null;
  void tick; // re-render once a second so the elapsed time counts up

  const stop = async () => {
    setStopping(true);
    try {
      await fetch(`${BRIDGE_HTTP}/jobs`, { method: "POST" });
    } catch {
      setStopping(false);
    }
  };

  return (
    <div className="fixed bottom-4 left-1/2 z-[90] w-[min(28rem,92vw)] -translate-x-1/2 rounded-lg border border-neutral-700 bg-neutral-900/95 px-4 py-3 shadow-2xl backdrop-blur">
      <div className="flex items-center gap-3">
        <span aria-hidden className="h-3 w-3 flex-shrink-0 animate-spin rounded-full border-2 border-neutral-600 border-t-neutral-200" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-xs font-medium text-neutral-100">{jobLabel(job)}</span>
            <span className="flex-shrink-0 font-mono text-[10px] text-neutral-500">{elapsed(job.startedAt)}</span>
          </div>
          {/* The phase text the tool itself reports — "Listening to camera 2…" beats a bare spinner */}
          <div className="truncate text-[11px] text-neutral-400">{toolProgress?.text || t("job.working")}</div>
        </div>
        <button
          onClick={() => void stop()}
          disabled={stopping}
          className="flex-shrink-0 rounded border border-neutral-600 px-2.5 py-1 text-[11px] text-neutral-300 hover:border-red-500 hover:text-red-300 disabled:opacity-50"
        >
          {stopping ? t("job.stopping") : t("job.stop")}
        </button>
      </div>
      <div className="mt-2 h-0.5 overflow-hidden rounded bg-neutral-800">
        {/* Indeterminate: these tools genuinely cannot say how far along they are, and a fake
            percentage that stalls at 90% is worse than an honest "still going". */}
        <div className="h-full w-1/3 animate-[jobslide_1.6s_ease-in-out_infinite] rounded bg-neutral-500" />
      </div>
      <style>{`@keyframes jobslide{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}`}</style>
    </div>
  );
}
