// Bun.serve host: MCP over HTTP (loopback only), the editor WebSocket, and a media file
// server — one server on the Palmier-style port 19789.

import { join } from "node:path";
import { availableChatModels, type ChatRequest, getClaudeStatus, requestChatStop, runChat, setApiKey } from "./agent-chat";
import { deleteChat, getChats, newChat, saveActiveChat, saveChat, selectChat } from "./chats";
import { BRIDGE_PORT, exportsDir, webDir } from "./config";
import { ensureCompoundBake } from "./export";
import { type BridgeContext, executeTool, importFolderMedia } from "./executor";
import { createFeedbackBundle } from "./feedback";
import { handleRpc, type RpcMessage } from "./mcp-http";
import { audioPeaks, ensureAudioProxy, ensureScrubProxy, ensureThumbnail } from "./ffmpeg";
import { mediaPathFor, saveProject } from "./media";
import { killTagged, openInBrowser } from "./proc";
import { claudeInstalled, installClaudeCode, startClaudeLogin, submitClaudeCode } from "./claude-code";
import { checkForUpdate } from "./update";
import { createProject, deleteProject, listProjects, switchProject } from "./projects";

interface Sendable {
  send: (data: string) => void;
}

/** Reject browser DNS-rebinding: a present Origin must be loopback or the Tauri webview. Non-browser
 * clients (Claude Code over MCP) send none. The packaged desktop app serves its SPA from
 * `http://tauri.localhost` (Tauri v2) and calls the bridge cross-origin, so that must be allowed. */

function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  if (origin.startsWith("tauri://")) return true; // Tauri custom-scheme webview (macOS / older)
  try {
    const h = new URL(origin).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "tauri.localhost" || h.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** CORS headers for a loopback browser origin (handles localhost vs 127.0.0.1 and dev servers). */
function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origin || !originAllowed(req)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,mcp-protocol-version",
    "access-control-max-age": "86400",
  };
}

/** Serve a media file honouring HTTP Range: a FRESH <video> element (a just-mounted lookahead
 * clip) seeks to a far position by fetching only that byte range — without 206 it would download
 * the whole file from the start, leaving a black frame at cuts that jump near the end. Shared by
 * the asset route and the compound-bake route. */
async function serveFileWithRange(req: Request, serve: string): Promise<Response> {
  const file = Bun.file(serve);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  const size = file.size;
  const ctype = serve.endsWith(".webm")
    ? "audio/webm"
    : serve.endsWith(".m4a")
      ? "audio/mp4"
      : file.type || "video/mp4";
  const range = req.headers.get("range");
  const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
  if (m) {
    let start = m[1] ? Number.parseInt(m[1], 10) : 0;
    let end = m[2] ? Number.parseInt(m[2], 10) : size - 1;
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end) || end >= size) end = size - 1;
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" } });
    }
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
        "Content-Type": ctype,
      },
    });
  }
  return new Response(file, {
    headers: { "Accept-Ranges": "bytes", "Content-Length": String(size), "Content-Type": ctype },
  });
}

export function startServer(ctx: BridgeContext) {
  const clients = new Set<Sendable>();

  // State frames carry the ACTIVE view: with a compound open, `timeline` is swapped for the
  // compound's sub-timeline (doc.timeline — the same switch every command reads through), so the
  // whole UI edits inside the compound with zero component changes. activeCompound tells the UI
  // to show the breadcrumb. The real project on disk is untouched — this is a per-frame view.
  const stateMsg = () => {
    const active = ctx.doc.activeCompound;
    const project = active ? { ...ctx.doc.project, timeline: ctx.doc.timeline } : ctx.doc.project;
    return JSON.stringify({ type: "state", project, activeCompound: active });
  };

  const broadcast = () => {
    const msg = stateMsg();
    for (const ws of clients) {
      try {
        ws.send(msg);
      } catch {
        /* dropped client */
      }
    }
  };

  /** Send an arbitrary JSON message to every connected client. */
  const broadcastRaw = (obj: unknown) => {
    const msg = JSON.stringify(obj);
    for (const ws of clients) {
      try {
        ws.send(msg);
      } catch {
        /* dropped client */
      }
    }
  };

  const broadcastStatus = async () => {
    const claude = await getClaudeStatus();
    const msg = JSON.stringify({
      type: "status",
      canGenerate: ctx.canGenerate(),
      claudeConnected: claude.connected,
      claudeExpiresAt: claude.expiresAt,
    });
    for (const ws of clients) {
      try {
        ws.send(msg);
      } catch {
        /* dropped client */
      }
    }
  };

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  ctx.doc.subscribe(() => {
    broadcast();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void saveProject(ctx.doc.project), 400);
  });

  return Bun.serve({
    hostname: "127.0.0.1",
    port: BRIDGE_PORT,
    async fetch(req, server): Promise<Response | undefined> {
      const url = new URL(req.url);
      const path = url.pathname;
      const cors = corsHeaders(req);

      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

      if (path === "/ws") {
        return server.upgrade(req) ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
      }

      if (path === "/health") return Response.json({ ok: true, port: BRIDGE_PORT });

      // In-app update check: compares the running build with the latest GitHub release. Returns
      // "no update" while the repo is private; starts working once releases are public.
      if (path === "/update/check") return Response.json(await checkForUpdate(), { headers: cors });

      // Project picker: list projects, or create/switch (reloads the document → broadcasts new state).
      if (path === "/projects") {
        if (req.method === "GET") return Response.json({ projects: await listProjects() }, { headers: cors });
        if (req.method === "POST") {
          if (!originAllowed(req)) return new Response("Forbidden origin", { status: 403 });
          let body: { action?: string; name?: string };
          try {
            body = (await req.json()) as { action?: string; name?: string };
          } catch {
            return new Response("Bad request", { status: 400 });
          }
          const name = typeof body.name === "string" ? body.name.trim() : "";
          if (!name) return new Response("name required", { status: 400 });
          const projects =
            body.action === "create"
              ? await createProject(ctx.doc, name)
              : body.action === "delete"
                ? await deleteProject(ctx.doc, name)
                : await switchProject(ctx.doc, name);
          if (body.action !== "delete") void importFolderMedia(ctx); // pull any loose media into the library
          return Response.json({ projects }, { headers: cors });
        }
        return new Response("Method Not Allowed", { status: 405 });
      }

      // Native folder picker: spawn a Windows FolderBrowserDialog and return the chosen path.
      if (path === "/pick-folder" && req.method === "POST") {
        if (!originAllowed(req)) return new Response("Forbidden origin", { status: 403 });
        // COM Shell.Application BrowseForFolder is reliable from a child process (no owner-window
        // handle needed, unlike WinForms FolderBrowserDialog). Returns the chosen path on stdout.
        const ps = [
          "$ErrorActionPreference='SilentlyContinue'",
          "$app = New-Object -ComObject Shell.Application",
          "$sel = $app.BrowseForFolder(0, 'Select the CupCat project folder', 0x51)",
          "if ($sel -ne $null) { [Console]::Out.Write($sel.Self.Path) }",
        ].join("; ");
        try {
          const b64 = Buffer.from(ps, "utf16le").toString("base64");
          const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-STA", "-EncodedCommand", b64], { stdout: "pipe", stderr: "ignore" });
          const chosen = (await new Response(proc.stdout).text()).trim();
          return Response.json({ path: chosen || null }, { headers: cors });
        } catch {
          return Response.json({ path: null }, { headers: cors });
        }
      }

      // Copy a finished export to a user-chosen destination (paired with the Tauri save dialog).
      if (path === "/save-export" && req.method === "POST") {
        if (!originAllowed(req)) return new Response("Forbidden origin", { status: 403 });
        let body: { name?: string; dest?: string };
        try {
          body = (await req.json()) as { name?: string; dest?: string };
        } catch {
          return new Response("Bad request", { status: 400 });
        }
        const { name, dest } = body;
        if (!name || name.includes("..") || name.includes("/") || name.includes("\\") || !dest)
          return Response.json({ ok: false, error: "bad args" }, { headers: cors });
        try {
          const src = Bun.file(join(exportsDir, name));
          if (!(await src.exists())) return Response.json({ ok: false, error: "export not found" }, { headers: cors });
          await Bun.write(dest, src);
          return Response.json({ ok: true, dest }, { headers: cors });
        } catch (e) {
          return Response.json({ ok: false, error: String(e) }, { headers: cors });
        }
      }

      // Feedback: build a diagnostic bundle (report + screenshot + project + logs + system info)
      // on disk and answer with the path the user should send to the developer.
      if (path === "/feedback" && req.method === "POST") {
        if (!originAllowed(req)) return new Response("Forbidden origin", { status: 403 });
        let body: { type?: string; description?: string };
        try {
          body = (await req.json()) as { type?: string; description?: string };
        } catch {
          return new Response("Bad request", { status: 400 });
        }
        const description = typeof body.description === "string" ? body.description.trim() : "";
        if (!description) return Response.json({ ok: false, error: "description required" }, { status: 400, headers: cors });
        try {
          const bundle = await createFeedbackBundle({
            type: typeof body.type === "string" && body.type.trim() ? body.type.trim() : "other",
            description,
            projectJson: JSON.stringify(ctx.doc.project, null, 2),
          });
          return Response.json({ ok: true, path: bundle }, { headers: cors });
        } catch (e) {
          return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500, headers: cors });
        }
      }

      // Upload picked files/folders into the current project's media folder.
      if (path === "/import" && req.method === "POST") {
        if (!originAllowed(req)) return new Response("Forbidden origin", { status: 403 });
        const form = await req.formData();
        const folderId = (form.get("folderId") as string) || undefined;
        let count = 0;
        for (const entry of form.getAll("files")) {
          if (typeof entry === "string") continue;
          const blob = entry as Blob & { name?: string };
          const fname = blob.name || "upload.bin";
          const ext = fname.match(/\.([^.]+)$/)?.[1] || "bin";
          const dest = mediaPathFor(ext);
          await Bun.write(dest, await blob.arrayBuffer());
          const out = await executeTool(ctx, "import_media", { source: { path: dest }, name: fname, ...(folderId ? { folderId } : {}) }, "user");
          if (!out.isError) count++;
        }
        return Response.json({ count }, { headers: cors });
      }

      // Per-project chat history, stored in the project folder so each project keeps its own
      // conversation (a new project starts empty; an existing one restores its history).
      if (path === "/chats") {
        if (req.method === "GET") return Response.json(await getChats(), { headers: cors });
        if (req.method === "POST") {
          if (!originAllowed(req)) return new Response("Forbidden origin", { status: 403 });
          let body: { action?: string; id?: string; messages?: unknown };
          try {
            body = (await req.json()) as { action?: string; id?: string; messages?: unknown };
          } catch {
            return new Response("Bad request", { status: 400 });
          }
          if (body.action === "save") {
            {
              const msgs = Array.isArray(body.messages) ? (body.messages as never[]) : [];
              const forId = typeof (body as { id?: unknown }).id === "string" ? String((body as { id?: unknown }).id) : "";
              await (forId ? saveChat(forId, msgs) : saveActiveChat(msgs));
            }
            return new Response(null, { status: 204, headers: cors });
          }
          const view =
            body.action === "new"
              ? await newChat()
              : body.action === "delete" && body.id
                ? await deleteChat(body.id)
                : body.action === "select" && body.id
                  ? await selectChat(body.id)
                  : await getChats();
          return Response.json(view, { headers: cors });
        }
        return new Response("Method Not Allowed", { status: 405 });
      }

      // In-app AI assistant status: is a Claude key set, and which models can the chat picker offer.
      if (path === "/agent/status") {
        const claude = await getClaudeStatus();
        return Response.json(
          {
            hasKey: claude.connected,
            authMode: claude.mode,
            claude, // { connected, mode, expiresAt, expired }
            higgsfield: { connected: ctx.canGenerate() },
            canGenerate: ctx.canGenerate(),
            models: await availableChatModels(),
          },
          { headers: cors },
        );
      }

      // USER-initiated export: the Export button renders through here (source "user"), keeping the
      // agent-side export_video refusal intact — the MCP path always classifies as "agent".
      if (path === "/export/run" && req.method === "POST") {
        if (!originAllowed(req)) return new Response("Forbidden origin", { status: 403 });
        let body: Record<string, unknown> = {};
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          /* defaults */
        }
        const out = await executeTool(ctx, "export_video", body, "user");
        const text = out.content.find((c) => c.type === "text")?.text ?? "";
        return Response.json({ ok: !out.isError, text }, { headers: cors });
      }

      // Stop the running assistant turn at the next safe boundary (edits already made are kept).
      if (path === "/agent/chat/stop" && req.method === "POST") {
        if (!originAllowed(req)) return new Response("Forbidden origin", { status: 403 });
        requestChatStop();
        return Response.json({ stopping: true }, { headers: cors });
      }


      // In-app AI assistant chat: runs the Anthropic tool-use loop, streaming events back as SSE.
      if (path === "/agent/chat" && req.method === "POST") {
        if (!originAllowed(req)) return new Response("Forbidden origin", { status: 403 });
        let body: ChatRequest;
        try {
          body = (await req.json()) as ChatRequest;
        } catch {
          return new Response("Bad request", { status: 400 });
        }
        const stream = new ReadableStream({
          async start(controller) {
            const enc = new TextEncoder();
            const send = (event: object) => {
              try {
                controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
              } catch {
                /* client gone */
              }
            };
            // Heartbeat: a long agent turn can sit idle while a slow tool runs (inspect_media renders
            // frames). Send an SSE comment every few seconds so the stream isn't dropped as idle.
            const heartbeat = setInterval(() => {
              try {
                controller.enqueue(enc.encode(`: ping\n\n`));
              } catch {
                /* client gone */
              }
            }, 5000);
            try {
              await runChat(ctx, body, send);
            } catch (e) {
              send({ type: "error", message: e instanceof Error ? e.message : String(e) });
              send({ type: "done" });
            } finally {
              clearInterval(heartbeat);
              try {
                controller.close();
              } catch {
                /* already closed */
              }
            }
          },
        });
        return new Response(stream, {
          headers: { ...cors, "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
        });
      }

      // Abort an in-flight export/merge: kill the tagged ffmpeg. The awaiting export call unwinds
      // on its own ("Export cancelled." + partial file deleted, see export.ts) — this only reports
      // whether there was anything to kill.
      if (path === "/export/cancel" && req.method === "POST") {
        if (!originAllowed(req)) return new Response("Forbidden origin", { status: 403 });
        return Response.json({ cancelled: killTagged("export") }, { headers: cors });
      }

      if (path.startsWith("/exports/")) {
        const file = decodeURIComponent(path.slice("/exports/".length));
        if (!file || file.includes("..") || file.includes("/") || file.includes("\\")) return new Response("Bad request", { status: 400 });
        const f = Bun.file(join(exportsDir, file));
        if (!(await f.exists())) return new Response("Not found", { status: 404 });
        // CORS so the packaged app (tauri.localhost origin) can fetch the bytes for a blob download.
        return new Response(f, { headers: { ...cors, "Content-Disposition": `attachment; filename="${file}"` } });
      }

      // A compound clip's preview media: the cached bake of its nested timeline. Blocks until the
      // bake is ready (like non-web-safe scrub proxies) — the <video> shows its loading veil
      // meanwhile. The URL's cache-buster (?h=) changes with the timeline hash, so a stale bake is
      // never re-served after an edit.
      if (path.startsWith("/media/compound/")) {
        const compoundId = decodeURIComponent(path.slice("/media/compound/".length));
        const baked = await ensureCompoundBake(ctx.doc, compoundId);
        if (!baked) return new Response("Not found", { status: 404 });
        return serveFileWithRange(req, baked.path);
      }

      if (path.startsWith("/media/")) {
        const id = decodeURIComponent(path.slice("/media/".length));
        const asset = ctx.doc.asset(id);
        if (!asset?.url) return new Response("Not found", { status: 404 });
        let serve = asset.url;
        // Static library/picker thumbnail: a single color-corrected frame, far cheaper than the full
        // scrub proxy video — a library of several heavy HDR sources shouldn't need N video transcodes
        // just to paint N thumbnails.
        if (asset.type === "video" && new URL(req.url).searchParams.get("thumb") === "1") {
          const thumb = await ensureThumbnail(asset.url);
          if (thumb) serve = thumb;
        }
        // Preview scrubbing: serve an all-intra proxy (instant per-frame seeking) when ready.
        else if (asset.type === "video" && new URL(req.url).searchParams.get("scrub") === "1") {
          // Web-safe containers can fall back to the original while the proxy builds; anything else
          // (.mov/.mkv/.avi, ProRes…) plays BLACK in the webview, so block until the proxy is ready.
          const ext = (asset.url.split(".").pop() ?? "").toLowerCase();
          const webSafe = ext === "mp4" || ext === "m4v" || ext === "webm";
          const proxy = await ensureScrubProxy(asset.url, { wait: !webSafe });
          if (proxy) serve = proxy;
        }
        // Preview audio: serve a standalone Opus/AAC audio proxy the WebView2 <audio> element can
        // always decode (the source video container's audio often won't play there).
        if ((asset.type === "video" || asset.type === "audio") && new URL(req.url).searchParams.get("audio") === "1") {
          const proxy = await ensureAudioProxy(asset.url);
          if (proxy) serve = proxy;
        }
        return serveFileWithRange(req, serve);
      }

      // Real sample-derived waveform peaks for an audio (or audio-bearing) asset.
      if (path.startsWith("/waveform/")) {
        const id = decodeURIComponent(path.slice("/waveform/".length));
        const asset = ctx.doc.asset(id);
        if (!asset?.url || (asset.type !== "audio" && !asset.hasAudio)) return Response.json({ peaks: [] }, { headers: cors });
        const n = Math.min(400, Math.max(20, Number(url.searchParams.get("n")) || 120));
        const peaks = await audioPeaks(asset.url, asset.durationSeconds, n);
        return Response.json({ peaks: peaks ?? [] }, { headers: cors });
      }

      if (path === "/mcp") {
        if (!originAllowed(req)) return new Response("Forbidden origin", { status: 403 });
        if (req.method === "GET") return new Response("Method Not Allowed", { status: 405 });
        if (req.method === "DELETE") return new Response(null, { status: 200 });
        if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
        }
        const batch = Array.isArray(body);
        const messages = (batch ? body : [body]) as RpcMessage[];
        const responses: object[] = [];
        for (const m of messages) {
          try {
            const r = await handleRpc(m, ctx);
            if (r) responses.push(r);
          } catch (e) {
            responses.push({ jsonrpc: "2.0", id: m?.id ?? null, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
          }
        }
        if (responses.length === 0) return new Response(null, { status: 202, headers: cors });
        return Response.json(batch ? responses : responses[0], { headers: { ...cors, "MCP-Protocol-Version": "2025-06-18" } });
      }

      // Static SPA (production / desktop): serve built web assets with index.html fallback.
      if (webDir) {
        const rel = path === "/" ? "index.html" : path.replace(/^\/+/, "");
        if (!rel.includes("..")) {
          const asset = Bun.file(join(webDir, rel));
          if (await asset.exists()) return new Response(asset);
          const index = Bun.file(join(webDir, "index.html"));
          if (await index.exists()) return new Response(index, { headers: { "Content-Type": "text/html" } });
        }
      }

      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        clients.add(ws);
        ws.send(stateMsg());
        void broadcastStatus(); // includes canGenerate + Claude connection
      },
      close(ws) {
        clients.delete(ws);
      },
      async message(ws, raw) {
        let msg: { type?: string; name?: string; args?: Record<string, unknown>; id?: unknown; action?: string };
        try {
          msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
        } catch {
          return;
        }
        if (msg.type === "command" && typeof msg.name === "string") {
          const out = await executeTool(ctx, msg.name, msg.args ?? {}, "user");
          ws.send(
            JSON.stringify({
              type: "ack",
              id: msg.id ?? null,
              text: out.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n"),
              isError: out.isError,
            }),
          );
        } else if (msg.type === "setup") {
          if (msg.action === "higgsfield-login") {
            // Open the device-login URL for the user AND push it to the UI (belt-and-suspenders:
            // the CLI's own browser-open can fail on a fresh PC / sidecar context).
            await ctx.loginHiggsfield((url) => {
              openInBrowser(url);
              broadcastRaw({ type: "higgsfield-login-url", url });
            });
          } else if (msg.action === "claude-login") {
            // Provision + sign in with the OFFICIAL Claude Code CLI: install it if missing, then run
            // its own `auth login`, which opens the browser and prints a sign-in URL (surfaced to the
            // UI like Higgsfield). The official client does all the OAuth and writes the credentials
            // CupCat reads — we don't implement Anthropic's OAuth ourselves. Long-running (waits for
            // the pasted code), so run detached and report progress via broadcasts.
            void (async () => {
              try {
                if (!(await claudeInstalled())) {
                  broadcastRaw({ type: "claude-login-progress", text: "Installing Claude Code…" });
                  const ok = await installClaudeCode((line) => broadcastRaw({ type: "claude-login-progress", text: line }));
                  if (!ok) {
                    broadcastRaw({ type: "claude-login-error", text: "Couldn't install Claude Code automatically. Check your connection, or use an API key." });
                    await broadcastStatus();
                    return;
                  }
                }
                broadcastRaw({ type: "claude-login-progress", text: "Opening the Claude sign-in…" });
                const ok = await startClaudeLogin(
                  (url) => {
                    openInBrowser(url);
                    broadcastRaw({ type: "claude-login-url", url });
                    broadcastRaw({ type: "claude-login-progress", text: "Approve in the browser, then paste the code it shows." });
                  },
                  (line) => broadcastRaw({ type: "claude-login-progress", text: line }),
                );
                broadcastRaw(
                  ok
                    ? { type: "claude-login-progress", text: "Connected." }
                    : { type: "claude-login-error", text: "Sign-in didn't complete. Try again, or use an API key." },
                );
              } catch (e) {
                broadcastRaw({ type: "claude-login-error", text: e instanceof Error ? e.message : String(e) });
              } finally {
                await broadcastStatus();
              }
            })();
          } else if (msg.action === "claude-login-code" && typeof (msg as { code?: string }).code === "string") {
            const ok = submitClaudeCode((msg as { code: string }).code);
            if (!ok) broadcastRaw({ type: "claude-login-error", text: "No sign-in is waiting for a code. Start the Claude sign-in first." });
          } else if (msg.action === "set-anthropic-key" && typeof (msg as { key?: string }).key === "string") {
            await setApiKey((msg as { key: string }).key);
          } else await ctx.refreshHiggsfield();
          await broadcastStatus();
        }
      },
    },
  });
}
