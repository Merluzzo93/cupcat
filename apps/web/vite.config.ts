import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// CupCat is a local-first desktop editor, so the web app is a plain static SPA (no SSR).
// In dev it runs on :5173 and talks to the bridge on :19789; in production the bridge
// serves the built `dist/` itself, and the Tauri shell loads that.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "#": fileURLToPath(new URL("./src", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: { port: 5173 },
  build: { outDir: "dist", emptyOutDir: true },
});
