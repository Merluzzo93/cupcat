// CapCut-style one-tap looks ("filters"). ONE recipe table drives BOTH renderers: the export maps
// each field to exact ffmpeg filters and the live preview maps the same fields to CSS filters —
// keeping the preview honest. Recipes are therefore limited to ops both sides can express:
// contrast/saturation/brightness, warm-sepia, hue rotation, grayscale, and a faded-blacks lift.
// `amount` (0..1, default 1) scales every component toward neutral.

export interface LookRecipe {
  /** Multipliers at amount=1 (1 = neutral). */
  contrast: number;
  saturation: number;
  brightness: number;
  /** 0..1 warm sepia mix (0 = none). */
  sepia: number;
  /** Global hue rotation in degrees (0 = none) — small values only, it shifts skin too. */
  hueDeg: number;
  /** true = full black & white (overrides saturation). */
  grayscale?: boolean;
  /** 0..1 faded-film black lift (raises the black point). */
  fade: number;
  label: string;
}

export const LOOKS: Record<string, LookRecipe> = {
  cinematic: { label: "Cinematic — warm contrast", contrast: 1.14, saturation: 1.16, brightness: 1.0, sepia: 0.12, hueDeg: 0, fade: 0 },
  vibrant: { label: "Vibrant — social pop", contrast: 1.1, saturation: 1.32, brightness: 1.02, sepia: 0, hueDeg: 0, fade: 0 },
  vintage: { label: "Vintage — faded warm film", contrast: 0.96, saturation: 0.85, brightness: 1.04, sepia: 0.32, hueDeg: 0, fade: 0.12 },
  bw: { label: "B&W — punchy mono", contrast: 1.22, saturation: 1, brightness: 1.02, sepia: 0, hueDeg: 0, grayscale: true, fade: 0 },
  cool: { label: "Cool — clean blue cast", contrast: 1.05, saturation: 0.95, brightness: 1.02, sepia: 0, hueDeg: -10, fade: 0 },
  warm: { label: "Warm — golden hour", contrast: 1.04, saturation: 1.08, brightness: 1.03, sepia: 0.22, hueDeg: 4, fade: 0 },
  matte: { label: "Matte — soft lifted blacks", contrast: 0.94, saturation: 0.92, brightness: 1.03, sepia: 0.06, hueDeg: 0, fade: 0.16 },
};

export const LOOK_NAMES = Object.keys(LOOKS);

/** Interpolate a recipe toward neutral by amount (0 → no-op, 1 → full look). */
export function scaledLook(name: string, amount: number): LookRecipe | null {
  const base = LOOKS[name];
  if (!base) return null;
  const a = Math.max(0, Math.min(1, amount));
  const lerp = (v: number, neutral = 1) => neutral + (v - neutral) * a;
  return {
    label: base.label,
    contrast: lerp(base.contrast),
    saturation: lerp(base.saturation),
    brightness: lerp(base.brightness),
    sepia: base.sepia * a,
    hueDeg: base.hueDeg * a,
    grayscale: base.grayscale && a >= 0.5,
    fade: base.fade * a,
  };
}
