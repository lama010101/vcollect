# AGENTS.md — project conventions for AI coding agents

## Build / test / verify commands

- **Install:** `npm install` (no native build deps; uses Node's built-in `node:sqlite`)
- **Typecheck:** `npm run typecheck` (runs `tsc --noEmit` in all workspaces)
- **Test:** `npm test` (Vitest for shared package + `tsx --test` for server)
  - Server tests: `npm run test:server` → `npx tsx --test apps/server/test/*.node.test.ts`
  - Shared tests: `npm run test:shared` → `vitest run`
- **Migrate + seed:** `npm run seed` (runs migrate too)
- **Manifests:** `npm run manifests`
- **Dev servers:** `npm run dev` (backend :3001, web :5174)

## Key conventions

- **DB:** Node built-in `node:sqlite` (`DatabaseSync`) via a thin `Sql` wrapper
  in `apps/server/src/db/client.ts`. **No better-sqlite3, no Drizzle** — native
  builds fail on this box (no VC++ toolset) and Node 24's built-in sqlite works
  with zero deps. All prepared statements must be **lazy** (created on first
  use via a `lazy()` helper) because modules are imported before `migrate()`
  runs — top-level `db.prepare()` crashes on a fresh DB.
  `shot_assets`/`edit_metadata` have `ON DELETE` actions only on DBs created
  after the CASCADE DDL change — existing DBs still have NO ACTION FKs, so
  deletes must go through `deleteShot`/`deleteShotsForProject`/`deleteProject`
  (they remove dependent rows first). Never `DELETE FROM shots`/`assets`
  directly or you'll hit FOREIGN KEY constraint failed.

- **Output paths / .env:** `OUTPUT_ROOT` and `.env` paths in
  `apps/server/src/config.ts` resolve relative to `PROJECT_ROOT` (computed from
  the file's own location via `import.meta.url`), **NOT** `process.cwd()`. This
  is critical because `npm run dev` runs `tsx watch` from `apps/server/` (the
  workspace cwd), while the CLI runs from the repo root. Without this, the dev
  server and CLI would use different DBs.

- **Imports:** Source files use `.js` extensions in relative imports (Node ESM
  convention). Tests use `.ts` extensions (tsx resolves those). The
  `@twio/shared` workspace package is imported by name.

- **Vite + spaces:** The repo path `D:\VIDEO COLLECT` contains a space, which
  breaks Vite's URL-based module loader for sibling source files. That's why
  server tests use `tsx --test` (Node's built-in test runner) instead of
  Vitest. Vitest is only used for the shared package (whose test file has no
  cross-file imports).

- **FFmpeg:** Single service abstraction at `apps/server/src/video/ffmpeg.ts`.
  Resolution priority: config env path → PATH → bundled npm binary → error.
  Never spawn ffmpeg/ffprobe directly elsewhere — always go through
  `ffmpegService`.

- **No mock/dry-run:** There is no MockProvider and no `DRY_RUN` mode. If a
  provider API key is missing or any provider call fails, the system throws
  immediately with a clear error. Never fabricate or synthesize data as a
  fallback. The `acquire:dry` npm script has been removed.

- **Acquire = discover only; KEEP = download.** `acquireShot()` searches,
  ranks and persists candidates but downloads nothing by default — a clip is
  downloaded only when a human KEEPs it (the review route enqueues a tracked
  task via `startAcquireAssetTask`; tasks are pause/resume/cancel-able).
  `acquireShot(…, { download: true })` restores the legacy "download top-Y"
  behavior for scripted bulk runs.

- **State machine:** `apps/server/src/state/machine.ts` enforces PRD §8.
  `UNKNOWN → APPROVED_FOR_EDIT` is impossible (tested).

- **Person-risk:** P1 heuristic only (PRD §14) — no vision. Flags assets whose
  query/tags imply people → `RIGHTS_REVIEW_REQUIRED`. This is screening, NOT a
  legal determination.

- **Secrets:** `.env` and `.env.local` are gitignored. API keys are
  server-side only; never expose to the frontend. Config is validated by Zod
  in `apps/server/src/config.ts`.

- **Script import:** `apps/server/src/import/scriptParser.ts` parses
  conventional music-video scripts (regex/line-based, **NO AI, NO LLM**).
  Format: `[MM:SS SECTION]` headers, `♪ lyrics` lines, `N. description — Xs`
  shots with optional `search:`/`ref:`/`priority:` modifiers. Time ranges are
  computed by sequential packing within each section. The `POST
  /api/projects/:id/import-script` endpoint creates shots + optionally a
  timeline with computed `time_start`/`time_end`. `POST
  /api/projects/:id/preview-script` parses without committing (used by the
  live preview UI). The `shots.reference_image_url` column stores directorial
  reference image URLs (inspiration, not stored assets).

- **LLM script parser (optional):** `apps/server/src/import/llmParser.ts`
  adds an alternative parser that uses a **free LLM** to parse freeform
  scripts in any format (treatments, screenplays, prose). Two providers:
  **Ollama** (local, free, no API key — install from ollama.com, run
  `ollama pull llama3.2`) and **Groq** (online, free API key from
  console.groq.com). Both use OpenAI-compatible chat completion APIs. Config:
  `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` in `.env.local`.
  `GET /api/llm-status` reports availability. `POST
  /api/projects/:id/preview-script-llm` previews without committing. The
  import endpoint accepts `useLlm: true` to use the LLM parser. The UI shows
  a toggle between Conventional and LLM modes with a live status indicator.
  When LLM is not configured, the toggle is disabled and only the
  conventional parser is available.

- **Music edit (beat-aligned music video):** `apps/server/src/musicEdit/`.
  `beatAnalysis.ts` decodes the song via `ffmpegService` and runs
  `apps/server/python/beat_analysis.py` (librosa; interpreter from
  `PYTHON_BIN_PATH` or `python3`), caching results by content hash in
  `OUTPUT_ROOT/cache/beats/`. `edl.ts` is the pure, deterministic planner —
  cuts are the detected beat timestamps (`beat[i] → beat[i+N]`), never a BPM
  grid unless `autoBeats` is off. `render.ts` renders one raw H.264 part per
  EDL entry via `ffmpegService`, byte-joins them and muxes the untouched song.
  Routes: `routes/musicEdit.ts` (`/api/music-edit/*`); UI: `pages/MusicEdit.tsx`.
  Errors are `MusicEditError` (status + code). Unit tests:
  `apps/server/test/music-edit.node.test.ts`; real-media acceptance:
  `npm run test:music-edit -w apps/server` with `MUSIC_EDIT_SONG` and
  `MUSIC_EDIT_VIDEOS` (≥4 comma-separated paths).

## Scope guardrails

- P0 + P1 only. No P2 AI vision. No general-purpose video editor (PRD §40) —
  the beat-aligned Music Edit is the only editing feature. No Mixkit scraper
  (PRD §3.3 — manual import only, P3). No rough-cut export (P3).
- P2 DB columns are kept nullable so P2 is additive-only.

## Environment

- Node v24.13.1, npm 11.8.0, Windows, ffmpeg 9.0.1 via scoop.
- System ffmpeg at `C:\Users\User\scoop\shims\ffmpeg.exe`.
