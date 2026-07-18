// CupCat bridge entry point: load the project, start the MCP + WebSocket + media server.
// With a subcommand (render/batch/list) it runs headless and exits — the user's own CLI, so
// exports here are user-initiated (the agent MCP export gate is unaffected).

import { EditorDocument } from "@cupcat/editor-core";
import { BRIDGE_PORT, projectRoot } from "./config";
import { type BridgeContext, importFolderMedia } from "./executor";
import { installLogCapture } from "./feedback";
import { listModels, login } from "./higgsfield";
import { ensureDirs, loadProject } from "./media";
import { runCli } from "./cli";
import { startServer } from "./server";

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
  loginHiggsfield: async () => {
    await login();
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
