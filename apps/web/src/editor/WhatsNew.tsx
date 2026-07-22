// "What's new", shown once after an update and never on an ordinary launch.
//
// The version last run is remembered locally. A fresh install records the version and shows nothing:
// somebody who has just downloaded CupCat has not updated from anywhere, and greeting them with a
// list of changes to a thing they have never used is noise. Skipping releases shows all of them.

import { useEffect, useState } from "react";
import { t } from "./i18n";
import { BRIDGE_HTTP } from "./store";

const SEEN_KEY = "cupcat.seenVersion";

interface Entry {
  version: string;
  title: string;
  points: string[];
}

/** Bold the **emphasised** part of a point. Deliberately the only markup understood: the copy is
 * ours, so a full markdown renderer would be a dependency bought for one asterisk pair. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") ? (
          <strong key={i} className="font-semibold text-neutral-100">
            {p.slice(2, -2)}
          </strong>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

export function WhatsNew() {
  const [entries, setEntries] = useState<Entry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const health = await fetch(`${BRIDGE_HTTP}/health`).then((r) => r.json());
        const current: string = health?.version ?? "";
        if (!current) return;
        const seen = localStorage.getItem(SEEN_KEY);
        if (!seen) {
          localStorage.setItem(SEEN_KEY, current); // fresh install: nothing to catch up on
          return;
        }
        if (seen === current) return;
        const res = await fetch(`${BRIDGE_HTTP}/changelog?seen=${encodeURIComponent(seen)}`).then((r) => r.json());
        // Record it now, not on dismiss: a card the user closes by quitting must not come back
        // every launch until they click the button.
        localStorage.setItem(SEEN_KEY, current);
        if (!cancelled && Array.isArray(res?.entries) && res.entries.length) setEntries(res.entries as Entry[]);
      } catch {
        /* offline or bridge not up yet — the card is not worth an error */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!entries || entries.length === 0) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-6" role="dialog" aria-modal="true">
      <div className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-lg border border-neutral-700 bg-neutral-900 shadow-2xl">
        <div className="border-b border-neutral-800 px-5 py-4">
          <div className="text-[11px] uppercase tracking-wide text-neutral-500">{t("whatsNew.eyebrow")}</div>
          <h2 className="mt-0.5 text-base font-semibold text-neutral-100">
            {t("whatsNew.title", { version: entries[0]!.version })}
          </h2>
        </div>
        <div className="space-y-5 px-5 py-4 text-xs leading-relaxed text-neutral-300">
          {entries.map((e) => (
            <section key={e.version}>
              {entries.length > 1 && (
                <div className="mb-1.5 text-[11px] font-medium text-neutral-400">
                  {e.version} — {e.title}
                </div>
              )}
              <ul className="space-y-1.5">
                {e.points.map((p, i) => (
                  <li key={i} className="flex gap-2">
                    <span aria-hidden className="mt-[3px] h-1 w-1 flex-shrink-0 rounded-full bg-neutral-600" />
                    <span>
                      <Rich text={p} />
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <div className="flex justify-end border-t border-neutral-800 px-5 py-3">
          <button
            onClick={() => setEntries(null)}
            className="rounded bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-900 hover:bg-white"
          >
            {t("whatsNew.dismiss")}
          </button>
        </div>
      </div>
    </div>
  );
}
