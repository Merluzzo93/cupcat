// Minimal Chrome DevTools Protocol client over Edge headless — CupCat's motion-graphics renderer.
// Every Windows box with WebView2 (i.e. every box that runs CupCat) has msedge.exe, so we can
// rasterize Claude-generated HTML/CSS animations to TRANSPARENT PNG frames without bundling a
// browser: launch headless Edge, seek all document animations to an exact time per frame
// (deterministic — no realtime capture jitter), screenshot with an alpha background.

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { exportsDir } from "./config";

const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

async function findEdge(): Promise<string | null> {
  for (const p of [process.env.CUPCAT_EDGE_BIN ?? "", ...EDGE_PATHS]) {
    if (p && (await Bun.file(p).exists())) return p;
  }
  return null;
}

/** One CDP command/response socket with sequential ids. */
class Cdp {
  private ws: WebSocket;
  private seq = 0;
  private pending = new Map<number, (v: Record<string, unknown>) => void>();
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      try {
        const m = JSON.parse(String(ev.data)) as { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
        if (m.id && this.pending.has(m.id)) {
          const r = this.pending.get(m.id)!;
          this.pending.delete(m.id);
          r(m.error ? { __error: m.error.message ?? "CDP error" } : (m.result ?? {}));
        }
      } catch {
        /* ignore non-JSON */
      }
    });
  }
  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new Cdp(ws)));
      ws.addEventListener("error", () => reject(new Error("CDP websocket failed")));
    });
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (v) => ("__error" in v ? reject(new Error(`${method}: ${v.__error}`)) : resolve(v)));
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method}: CDP timeout`));
        }
      }, 30_000);
    });
  }
  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/** Render a self-contained HTML animation to transparent PNG frames (frame-exact via animation
 * seeking, not realtime). Returns the frame file paths, or null with the reason logged. */
export async function renderHtmlFrames(
  htmlPath: string,
  opts: { width: number; height: number; fps: number; durationSeconds: number; outDir: string },
): Promise<string[] | null> {
  const edge = await findEdge();
  if (!edge) {
    console.error("[cdp] msedge.exe not found — motion graphics need Microsoft Edge (present on all supported Windows)");
    return null;
  }
  const port = 19200 + Math.floor(Math.random() * 500);
  const profile = join(exportsDir, `_mgprofile_${port}`);
  await mkdir(opts.outDir, { recursive: true });
  const proc = Bun.spawn(
    [
      edge,
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--disable-extensions",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${opts.width},${opts.height}`,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  try {
    // The debugger endpoint takes a moment to come up; poll /json/list for the page target.
    let wsUrl = "";
    for (let i = 0; i < 60 && !wsUrl; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl?: string }[];
        wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? "";
      } catch {
        /* not up yet */
      }
    }
    if (!wsUrl) {
      console.error("[cdp] Edge debugger endpoint never came up");
      return null;
    }
    const cdp = await Cdp.connect(wsUrl);
    try {
      await cdp.send("Page.enable");
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: opts.width, height: opts.height, deviceScaleFactor: 1, mobile: false });
      // Alpha screenshots: the page background becomes transparent wherever the HTML doesn't paint.
      await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
      const fileUrl = `file:///${htmlPath.replace(/\\/g, "/")}`;
      await cdp.send("Page.navigate", { url: fileUrl });
      // Settle: fonts loaded + two rAFs so first paint is complete before seeking.
      await cdp.send("Runtime.evaluate", {
        expression: "document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))",
        awaitPromise: true,
        timeout: 10_000,
      });
      const total = Math.max(1, Math.round(opts.durationSeconds * opts.fps));
      const frames: string[] = [];
      for (let i = 0; i < total; i++) {
        const ms = (i / opts.fps) * 1000;
        // Deterministic seek: pause every CSS/WAAPI animation and set its clock to this frame.
        await cdp.send("Runtime.evaluate", {
          expression: `document.getAnimations({subtree:true}).forEach(a=>{a.pause();a.currentTime=${ms}}); new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`,
          awaitPromise: true,
          timeout: 10_000,
        });
        const shot = (await cdp.send("Page.captureScreenshot", { format: "png" })) as { data?: string };
        if (!shot.data) {
          console.error(`[cdp] empty screenshot at frame ${i}`);
          return null;
        }
        const f = join(opts.outDir, `f${String(i).padStart(5, "0")}.png`);
        await Bun.write(f, Buffer.from(shot.data, "base64"));
        frames.push(f);
      }
      return frames;
    } finally {
      cdp.close();
    }
  } finally {
    proc.kill();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}
