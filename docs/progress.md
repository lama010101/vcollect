# Progress — The World Is Ours (video-collect)

Development log and status tracker for the webapp. **Every change to the
webapp must be recorded here** — see the Changelog section at the bottom.

## What this is

A stock-footage acquisition & rights-management webapp for the "The World Is
Ours" YouTube music video. It searches Pexels + Pixabay via official APIs,
scores/dedupes candidates, lets a human KEEP/REJECT clips in a review UI,
emits provenance/license manifests, and can cut a beat-aligned music video
edit from kept footage.

- **Scope:** P0 + P1 only. No P2 AI vision (nullable columns reserved). No
  general-purpose editor — the beat-aligned Music Edit is the only editing
  feature. Mixkit + rough-cut export deferred to P3.
- **Monorepo:** `apps/server` (Fastify API, :3001) · `apps/web` (React+Vite,
  :5174) · `packages/shared`.

## Stack

| Layer | Tech |
|---|---|
| Backend | Node.js 24 + TypeScript + Fastify + Zod |
| Frontend | React + Vite + Tailwind |
| DB | `node:sqlite` (`DatabaseSync`) via `Sql` wrapper — lazy prepared statements, no better-sqlite3/Drizzle |
| Video | ffmpeg/ffprobe via `ffmpegService` abstraction (never spawn directly) |
| Images | sharp |
| Beat analysis | librosa via `python/beat_analysis.py` (`PYTHON_BIN_PATH` or `python3`) |
| Tests | Vitest (shared) + `tsx --test` (server — Vite breaks on space in repo path) |

## Architecture map

```
apps/server/src/
  acquisition/   pipeline.ts, runner.ts, tasks.ts, queryExpansion.ts
                 — acquire = discover+rank+persist only; KEEP triggers download
  providers/     pexels.ts, pixabay.ts, factory.ts, rateLimiter.ts, searchCache.ts
  import/        scriptParser.ts (regex, no AI) · llmParser.ts (Ollama/Groq, optional)
  musicEdit/     beatAnalysis.ts · edl.ts · render.ts · service.ts · errors.ts
  routes/        dashboard.ts · folders.ts · review.ts · musicEdit.ts
  state/         machine.ts (PRD §8; UNKNOWN→APPROVED_FOR_EDIT impossible)
  db/            client.ts (Sql wrapper, lazy stmts)
  video/         ffmpeg.ts (resolution: env → PATH → bundled npm binary)
apps/web/src/
  pages/         Dashboard, Projects, Search, ShotList, ShotReview, Timeline,
                 Folders, ImportScript, MusicEdit, Help
  components/    RatingSlider, TasksPanel, ui, useToast
```

## Feature status

| Feature | Status | Notes |
|---|---|---|
| Acquisition pipeline (Pexels + Pixabay) | ✅ Done | Discover → rank → persist candidates; no auto-download |
| Review UI + KEEP→download tasks | ✅ Done | Pause/resume/cancel-able tracked tasks |
| State machine (PRD §8) | ✅ Done | Tested incl. UNKNOWN→APPROVED_FOR_EDIT rejection |
| Scoring / dedup / ranking | ✅ Done | |
| Manifests + contact sheets | ✅ Done | `npm run manifests` |
| Script import — conventional parser | ✅ Done | Regex/line-based, no AI; preview + commit endpoints |
| Script import — LLM parser | ✅ Done (optional) | Ollama or Groq; `/api/llm-status`; UI toggle |
| Person-risk heuristic (P1) | ✅ Done | Screening flag only, not legal determination |
| Music Edit (beat-aligned) | ✅ Done | PR #1 — see milestone below |
| P2 AI vision analysis | ⬜ Not started | Out of scope; schema nullable-ready |
| Mixkit import / rough-cut export | ⬜ Deferred | P3 |

## Milestones / merged PRs

| PR | Date | Description |
|---|---|---|
| #1 | 2026-09-29 | VIDEO-BEAT-002: beat-aligned music edit — librosa beat detection → deterministic EDL → FFmpeg retime render → API (`/api/music-edit/*`) + CLI (`music-edit`) + UI (MusicEdit page). 2 commits, +2450/−11, 25 files. |

Key commits pre-PR history: initial monorepo commit, Vercel deploy fixes
(web-only build, deps moved to `dependencies`), Pixabay thumbnail precedence
fix.

## Verify commands

```bash
npm run typecheck    # tsc --noEmit in all workspaces
npm test             # vitest (shared) + tsx --test (server)
npm run seed         # migrate + seed 100-shot dataset
npm run dev          # server :3001 + web :5174
# Real-media music-edit acceptance:
#   npm run test:music-edit -w apps/server
#   (needs MUSIC_EDIT_SONG + MUSIC_EDIT_VIDEOS=≥4 paths)
```

Last verified: `npm run typecheck` ✅ on `main` @ `1fab408` (2026-09-29).

## Gotchas (short list — see AGENTS.md for full detail)

- Repo path contains a space → server tests must use `tsx --test`, not Vitest.
- `OUTPUT_ROOT`/`.env` resolve from `PROJECT_ROOT` (file location), NOT cwd.
- All `db.prepare()` calls must be lazy (modules load before `migrate()`).
- Deletes go through `deleteShot`/`deleteShotsForProject`/`deleteProject` —
  old DBs have NO ACTION FKs.
- No mock/dry-run: missing provider keys throw immediately. Never fabricate data.
- API keys server-side only; never expose to frontend.

---

## Changelog

> **Tracking rule:** every change to the webapp (any merged PR, commit, or
> notable work session touching `apps/`, `packages/`, DB schema, config, or
> tooling) MUST add a dated entry here before the work is considered done.
> Format: `### YYYY-MM-DD — short title` + bullets: what changed, files
> touched, verification result.

### 2026-09-29 — Beat-aligned Music Edit (PR #1, merged)
- Added `apps/server/src/musicEdit/` (beatAnalysis, edl, render, service,
  errors), `apps/server/python/beat_analysis.py`, `routes/musicEdit.ts`,
  `pages/MusicEdit.tsx`, `test/music-edit.node.test.ts`.
- EDL cuts on detected librosa beats (never a BPM grid unless `autoBeats`
  off); retime clamps [0.80, 1.25]; deterministic round-robin planner.
- CLI `music-edit` command; `acquire` cmds moved to dynamic import so
  `PEXELS_API_KEY` isn't required for unrelated commands.
- Verified: typecheck ✅, 4 vitest + 55 node tests ✅, real-song acceptance
  (205 s track, 320 beats) ✅, API smoke ✅.
- Repo housekeeping: merged PR branch `devin/1790655465-beat-music-edit`
  deleted; local `main` synced at `1fab408`.

### 2026-09-29 — Fix Vercel production build
- Vercel deploy failed with `TS2688: Cannot find type definition file for
  'vite/client'` during `tsc -b --noEmit` (install step only added 129
  packages — a web-scoped subset vs ~312 for a full workspace install).
- `apps/web` build script changed from `tsc -b --noEmit && vite build` to
  `vite build` — production bundles don't need typechecking (Vite transpiles
  via esbuild); type safety stays covered by `npm run typecheck`.
- Verified locally in a clean clone with a web-scoped install:
  `vite build` → `dist/` (391 kB JS / 44 kB CSS gz 106/8 kB). ✅
- NOTE: the deployed SPA still needs a reachable backend — set `VITE_API_URL`
  on Vercel to point `/api` at a hosted Fastify instance (server can't run
  serverless: sqlite file + ffmpeg + python). Without it the UI loads but
  API calls fail.

### 2026-09-29 — docs/progress.md created
- Established this file as the required development log for the webapp.
