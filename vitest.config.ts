// Vitest config (root) — runs tests for @twio/shared only.
// Server tests use `tsx --test` (Node's built-in test runner) because the
// repo path "D:\VIDEO COLLECT" contains a space, which breaks Vite's
// URL-based module loader for sibling source files.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts"],
    environment: "node",
    globals: false,
  },
});
