// Small formatting helpers for the editor UI.

export function frameToTimecode(frame: number, fps: number): string {
  const f = Math.max(0, Math.round(frame));
  const totalSeconds = Math.floor(f / fps);
  const ff = Math.floor(f % fps); // floor: NTSC rates make f % fps fractional
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

// Palmier-style clip identities: video = dark base (the filmstrip thumbnails carry the look),
// images/generated = lavender, audio = teal with the waveform, text = purple.
export const TRACK_COLORS: Record<string, string> = {
  video: "bg-neutral-800/95 border-neutral-600/70",
  image: "bg-violet-400/75 border-violet-300/60",
  audio: "bg-teal-700/85 border-teal-400/60",
  text: "bg-purple-500/80 border-purple-300/60",
  lottie: "bg-violet-600/80 border-violet-400/60",
  // Violet like CapCut/AE adjustment layers, darker than lottie so the two stay distinguishable.
  adjustment: "bg-violet-800/80 border-violet-400/70",
};
