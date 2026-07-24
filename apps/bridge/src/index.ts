// CupCat bridge entry point: load the project, start the MCP + WebSocket + media server.
// With a subcommand (render/batch/list) it runs headless and exits — the user's own CLI, so
// exports here are user-initiated (the agent MCP export gate is unaffected).

import { EditorDocument } from "@cupcat/editor-core";
import { BRIDGE_PORT, projectRoot } from "./config";
import { type BridgeContext, importFolderMedia } from "./executor";
import { installLogCapture } from "./feedback";
import { listModels, loginWithUrl } from "./higgsfield";
import { ensureDirs, loadProject } from "./media";
import { runCli } from "./cli";
import { startServer } from "./server";

// The engine must outlive any single bad operation. One tool throwing — a malformed file, an
// ffmpeg that dies oddly, a rejected promise nobody awaited — used to be able to take down the whole
// process, and with it every other project and the connection to the UI. Log it and keep serving;
// the desktop shell now also restarts the engine if it ever does die, but not dying is better.
process.on("uncaughtException", (err) => {
  console.error("[bridge] uncaught exception (kept alive):", err instanceof Error ? err.stack : err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[bridge] unhandled rejection (kept alive):", reason instanceof Error ? reason.stack : reason);
});

// Headless subcommands short-circuit the server. `--` guards against a stray flag being read as a
// verb; anything else falls through to the normal server boot below.
const verb = process.argv[2];
if (verb && !verb.startsWith("-")) {
  await runCli(process.argv.slice(2));
  process.exit(0);
}

installLogCapture(); // ring-buffer console output so feedback bundles can include logs.txt
await ensureDirs();
const project = await loadProject();
const doc = new EditorDocument(project);

let canGen = false;
const refreshHiggsfield = async (): Promise<boolean> => {
  try {
    canGen = (await listModels("image")).length > 0;
  } catch {
    canGen = false;
  }
  return canGen;
};
await refreshHiggsfield();

const ctx: BridgeContext = {
  doc,
  canGenerate: () => canGen,
  refreshHiggsfield,
  loginHiggsfield: async (onUrl) => {
    // Stream the device-login URL so the server can open it + show it to the user (the plain
    // buffered login never surfaced the URL, so on a fresh PC "nothing happened").
    await loginWithUrl((url) => onUrl?.(url));
    return refreshHiggsfield();
  },
};
startServer(ctx);
// Pull any loose media (including subfolders -> library folders) the moment the app opens on the
// last project — not only when switching projects.
void importFolderMedia(ctx);

console.log(`CupCat bridge — listening on http://127.0.0.1:${BRIDGE_PORT}`);
console.log(`  MCP:    POST /mcp        WS: /ws        media: /media/<assetId>`);
console.log(`  project: ${projectRoot}  (canGenerate=${canGen})`);
console.log(`Connect Claude:  claude mcp add --transport http cupcat http://127.0.0.1:${BRIDGE_PORT}/mcp`);
