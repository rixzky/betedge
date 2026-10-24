import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Repo root, so the UI can import contract/api_types.ts and the golden mocks in contract/golden/api.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const api = process.env.VITE_API_TARGET || "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    fs: { allow: [repoRoot] },
    proxy: { "/api": api },
  },
  preview: { proxy: { "/api": api } },
  build: { chunkSizeWarningLimit: 900 },
});
