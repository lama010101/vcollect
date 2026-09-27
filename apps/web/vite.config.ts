import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react() as PluginOption],
  server: {
    port: 5174,
    strictPort: false,
    // The repo path contains a space ("D:\VIDEO COLLECT"), which makes Vite's
    // default file watcher unreliable on this box — edits to index.css /
    // tailwind.config.js can go undetected, leaving stale CSS in the browser.
    watch: { usePolling: true, interval: 300 },
    proxy: {
      "/api": "http://127.0.0.1:3001",
      "/files": "http://127.0.0.1:3001",
    },
  },
});
