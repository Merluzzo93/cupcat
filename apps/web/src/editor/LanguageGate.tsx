// First-run language picker + the Settings entry that changes it later.
// The picker is shown once (before anything else), because an editor whose entire interface is in a
// language you don't read is unusable — and it's the cheapest possible question to ask.

import { chooseLang, useEditor } from "./store";
import { LANGUAGES, t } from "./i18n";

/** Full-screen, one-time language choice. Renders nothing once a language has been chosen. */
export function LanguageGate() {
  const { langChosen } = useEditor();
  if (langChosen) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-neutral-950">
      <div className="flex w-[380px] max-w-[90vw] flex-col items-center gap-5 rounded-2xl border border-neutral-800 bg-neutral-900 p-8 shadow-2xl">
        <img src="/logo.png" alt="" className="h-14 w-14" onError={(e) => (e.currentTarget.style.display = "none")} />
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-base font-semibold text-neutral-100">{t("lang.title")}</h1>
          <p className="text-xs text-neutral-500">{t("lang.subtitle")}</p>
        </div>
        <div className="flex w-full flex-col gap-2">
          {LANGUAGES.map((l) => (
            <button
              key={l.id}
              onClick={() => chooseLang(l.id)}
              className="flex items-center gap-3 rounded-lg border border-neutral-700 px-4 py-3 text-left text-sm text-neutral-200 transition hover:border-violet-500 hover:bg-neutral-800"
            >
              <span
                aria-hidden
                className="shrink-0 rounded border border-neutral-700 bg-neutral-950 px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-neutral-400"
              >
                {l.code}
              </span>
              {l.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Language row for the Settings dialog. */
export function LanguageSetting() {
  const { lang } = useEditor();
  return (
    <label className="flex flex-col gap-1">
      <span className="text-neutral-400">{t("lang.setting")}</span>
      <select
        value={lang}
        onChange={(e) => chooseLang(e.target.value as (typeof LANGUAGES)[number]["id"])}
        className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-100 outline-none focus:border-neutral-500"
      >
        {LANGUAGES.map((l) => (
          <option key={l.id} value={l.id}>
            {l.label}
          </option>
        ))}
      </select>
      <span className="text-[10px] text-neutral-500">{t("lang.settingHint")}</span>
    </label>
  );
}
