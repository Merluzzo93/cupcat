// First-run tour: four cards naming the parts of the window and what to do first.
//
// Shown once, after the language picker, and never again — including for anyone who has already
// been using CupCat, because it records itself as seen when a project already has media in it. A
// tour that greets a returning user as a beginner is worse than no tour.

import { useEffect, useState } from "react";
import { t } from "./i18n";
import { useEditor } from "./store";

const SEEN_KEY = "cupcat.tourSeen";

interface Step {
  title: string;
  body: string;
  /** Roughly where the card should sit, so it points at the thing it describes. */
  place: "center" | "left" | "right" | "bottom";
}

const STEPS: Step[] = [
  { title: "tour.s1Title", body: "tour.s1Body", place: "center" },
  { title: "tour.s2Title", body: "tour.s2Body", place: "left" },
  { title: "tour.s3Title", body: "tour.s3Body", place: "bottom" },
  { title: "tour.s4Title", body: "tour.s4Body", place: "left" },
];

const PLACEMENT: Record<Step["place"], string> = {
  center: "items-center justify-center",
  left: "items-center justify-start pl-8",
  right: "items-center justify-end pr-8",
  bottom: "items-end justify-center pb-24",
};

export function Onboarding() {
  const { project } = useEditor();
  const [step, setStep] = useState<number | null>(null);

  useEffect(() => {
    if (localStorage.getItem(SEEN_KEY)) return;
    // Someone who already has media in a project is not a first-time user — most likely they
    // updated into this build. Mark it seen and stay out of their way.
    if (project && project.media.length > 0) {
      localStorage.setItem(SEEN_KEY, "1");
      return;
    }
    if (project) setStep(0);
  }, [project]);

  if (step === null) return null;
  const s = STEPS[step]!;
  const finish = () => {
    localStorage.setItem(SEEN_KEY, "1");
    setStep(null);
  };

  return (
    <div className={`pointer-events-none fixed inset-0 z-[95] flex ${PLACEMENT[s.place]} p-6`}>
      <div className="pointer-events-auto w-full max-w-sm rounded-lg border border-neutral-700 bg-neutral-900/95 p-4 shadow-2xl backdrop-blur">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wide text-neutral-500">
            {t("tour.step", { n: step + 1, total: STEPS.length })}
          </span>
          <button onClick={finish} className="text-[11px] text-neutral-500 hover:text-neutral-300">
            {t("tour.skip")}
          </button>
        </div>
        <h3 className="text-sm font-semibold text-neutral-100">{t(s.title as never)}</h3>
        <p className="mt-1.5 text-xs leading-relaxed text-neutral-300">{t(s.body as never)}</p>
        <div className="mt-3 flex items-center justify-between">
          <div className="flex gap-1">
            {STEPS.map((_, i) => (
              <span key={i} className={`h-1 w-4 rounded-full ${i === step ? "bg-neutral-200" : "bg-neutral-700"}`} />
            ))}
          </div>
          <button
            onClick={() => (step + 1 < STEPS.length ? setStep(step + 1) : finish())}
            className="rounded bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-900 hover:bg-white"
          >
            {step + 1 < STEPS.length ? t("tour.next") : t("tour.done")}
          </button>
        </div>
      </div>
    </div>
  );
}
