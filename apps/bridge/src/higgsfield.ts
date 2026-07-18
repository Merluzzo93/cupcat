// Wrapper over the authenticated Higgsfield CLI — CupCat's generation engine.
//
// Real interface (higgsfield 0.1.x):
//   higgsfield model list --image|--video --json   -> [{ job_set_type, display_name, type }]
//   higgsfield upload create <file> --json          -> { id, ... }
//   higgsfield generate create <job_set_type> --prompt "..." [--image|--start-image|
//       --end-image|--video|--audio <uuid|path>] [--param value]... --wait --json
//   higgsfield generate cost <job_set_type> --prompt "..." --json
// Media flags accept an upload/job UUID or a local path (auto-uploaded). --wait blocks
// until the job finishes and prints the result URL(s).

import { HIGGSFIELD_BIN } from "./config";
import { run } from "./proc";

export type HfMediaKind = "image" | "video" | "audio";

export interface HfModel {
  jobSetType: string;
  displayName: string;
  type: string;
}

export async function listModels(kind?: "image" | "video"): Promise<HfModel[]> {
  const flags = kind ? [`--${kind}`] : [];
  const { stdout, code } = await run(HIGGSFIELD_BIN, ["model", "list", ...flags, "--json"]);
  if (code !== 0) return [];
  try {
    const arr = JSON.parse(stdout || "[]") as { job_set_type: string; display_name: string; type: string }[];
    return arr.map((m) => ({ jobSetType: m.job_set_type, displayName: m.display_name, type: m.type }));
  } catch {
    return [];
  }
}

/** Per-model parameter spec (defaults, enums) — `higgsfield model get <job_set_type> --json`. */
export async function getModel(jobSetType: string): Promise<unknown> {
  const { stdout, code } = await run(HIGGSFIELD_BIN, ["model", "get", jobSetType, "--json"]);
  if (code !== 0) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

export async function uploadFile(path: string): Promise<string | null> {
  const { stdout, code } = await run(HIGGSFIELD_BIN, ["upload", "create", path, "--json"]);
  if (code !== 0) return null;
  try {
    const j = JSON.parse(stdout) as Record<string, unknown>;
    return (j.id ?? j.upload_id ?? j.uploadId ?? null) as string | null;
  } catch {
    return null;
  }
}

export interface GenerateInputRefs {
  image?: string;
  startImage?: string;
  endImage?: string;
  video?: string;
  audio?: string;
}

export interface GenerateOptions extends GenerateInputRefs {
  model: string;
  prompt?: string;
  /** Extra `--key value` flags (aspectRatio, resolution, duration, quality, voice, …). */
  params?: Record<string, string | number>;
  /** Multiple reference images: an array-typed model param (e.g. `input_images`, `medias`)… */
  referenceParam?: string;
  /** …filled with these uploaded media UUIDs as `{type:"media_input", id}` objects. */
  referenceIds?: string[];
}

export interface GenerateResult {
  ok: boolean;
  urls: string[];
  raw: string;
  error?: string;
}

function collectUrls(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    if (/^https?:\/\//.test(value)) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectUrls(v, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectUrls(v, out);
  }
}

export async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  const args = ["generate", "create", opts.model];
  if (opts.prompt) args.push("--prompt", opts.prompt);
  if (opts.image) args.push("--image", opts.image);
  if (opts.startImage) args.push("--start-image", opts.startImage);
  if (opts.endImage) args.push("--end-image", opts.endImage);
  if (opts.video) args.push("--video", opts.video);
  if (opts.audio) args.push("--audio", opts.audio);
  for (const [k, v] of Object.entries(opts.params ?? {})) args.push(`--${k}`, String(v));
  if (opts.referenceParam && opts.referenceIds?.length) {
    const arr = opts.referenceIds.map((id) => ({ type: "media_input", id }));
    args.push(`--${opts.referenceParam}`, JSON.stringify(arr));
  }
  args.push("--wait", "--json");

  const { stdout, stderr, code } = await run(HIGGSFIELD_BIN, args);
  if (code !== 0) {
    return { ok: false, urls: [], raw: `${stdout}\n${stderr}`, error: stderr.trim() || `higgsfield exited ${code}` };
  }
  const urls = new Set<string>();
  try {
    collectUrls(JSON.parse(stdout), urls);
  } catch {
    /* fall through to text scan */
  }
  for (const m of stdout.matchAll(/https?:\/\/[^\s",)]+/g)) urls.add(m[0]);
  return { ok: true, urls: [...urls], raw: stdout };
}

export async function estimateCost(model: string, prompt?: string): Promise<string> {
  const args = ["generate", "cost", model];
  if (prompt) args.push("--prompt", prompt);
  args.push("--json");
  const { stdout } = await run(HIGGSFIELD_BIN, args);
  return stdout.trim();
}

/** Run `higgsfield auth login` (opens a browser for OAuth). Returns true on success. */
export async function login(): Promise<boolean> {
  const { code } = await run(HIGGSFIELD_BIN, ["auth", "login"]);
  return code === 0;
}

/**
 * Device-login that surfaces the URL. The CLI prints the device-login URL then blocks on
 * "Waiting for approval..." — but a buffered `run()` never yields that line until the process
 * exits (deadlock: the user never sees the URL). Here we STREAM stdout, extract the
 * `https://higgsfield.ai/device?code=…` URL and hand it to `onUrl` immediately so the caller can
 * open it and show it. Resolves true when login completes (exit 0).
 */
export async function loginWithUrl(onUrl: (url: string) => void): Promise<boolean> {
  const proc = Bun.spawn([HIGGSFIELD_BIN, "auth", "login"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  let sent = false;
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        if (!sent) {
          const m = buf.match(/https?:\/\/\S*device\S*/);
          if (m) {
            sent = true;
            onUrl(m[0]);
          }
        }
      }
    } catch {
      /* stream ended */
    }
  })();
  const code = await proc.exited;
  return code === 0;
}
