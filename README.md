# The World Is Ours — Stock-Footage Acquisition System

Automated commercial stock-footage acquisition & rights-management system for
the "The World Is Ours" YouTube music video. Searches Pexels + Pixabay (official
APIs), filters/scores/deduplicates candidates, downloads the top candidates per
shot, generates thumbnails + contact sheets, drives a human review UI, and emits
provenance/license manifests targeting ~100 commercially suitable candidates
mapped to a 100-shot creative plan.

## Scope

P0 + P1 only (no P2 AI vision analysis). The system is fully usable **without a
vision API key**. The DB schema keeps P2 fields (`semantic_score`, `logo_risk`,
`person_risk`, `diversity_score`, `vision_status`, etc.) nullable so P2 is
additive-only. No video editor (PRD §40); Mixkit + rough-cut export deferred
(P3).

## Stack

- **Backend:** Node.js + TypeScript + Fastify + Zod
- **Frontend:** React + Vite + Tailwind
- **DB:** SQLite via Node's built-in `node:sqlite` (no native build deps)
- **Video:** ffmpeg/ffprobe via a single FFmpeg service abstraction
- **Images:** sharp
- **Testing:** Vitest (shared) + `tsx --test` (server, because Vite breaks on
  the space in the repo path `D:\VIDEO COLLECT`)

## Quick start

```bash
# 1. Install deps (no native build required)
npm install

# 2. Install system ffmpeg (recommended; the app also bundles fallbacks)
#    Windows: scoop install ffmpeg
#    macOS:   brew install ffmpeg

# 3. Configure API keys (REQUIRED — no mock fallback)
cp .env.example .env.local
#   fill in PEXELS_API_KEY and PIXABAY_API_KEY
#   if either key is missing, acquisition errors immediately

# 4. Create the DB + seed the 100-shot dataset
npm run migrate && npm run seed
#   (or: npx tsx apps/server/src/cli.ts seed  — runs migrate too)

# 5. Run acquisition (needs real keys in .env.local)
npm run acquire

# 6. Generate manifests + contact sheets
npm run manifests

# 7. Start the review UI
npm run dev
#   server: http://127.0.0.1:3001  ·  web: http://localhost:5174
```

## Commands

| Command | What it does |
|---|---|
| `npm run migrate` | Create/upgrade the SQLite schema |
| `npm run seed` | Seed providers + the 100-shot dataset (PRD §27) |
| `npm run acquire` | Run the acquisition pipeline for all 100 shots (requires API keys) |
| `npm run manifests` | Generate CSV/JSON/HTML manifests + contact sheets |
| `npm run dashboard` | Print the commercial-rights dashboard (PRD §24) |
| `npm run dev` | Start backend + frontend dev servers |
| `npm run build` | Typecheck + build all workspaces |
| `npm test` | Run all tests (Vitest shared + tsx server) |
| `npm run typecheck` | Typecheck all workspaces |

## FFmpeg resolution (locked decision)

The single FFmpeg service (`apps/server/src/video/ffmpeg.ts`) resolves the
executable once, in this priority:

1. Explicit configured path (`FFMPEG_BIN_PATH` / `FFPROBE_BIN_PATH` env)
2. System binary in PATH
3. Bundled npm binary (`ffmpeg-static` / `ffprobe-static`)
4. Actionable error naming all three sources

The app never depends exclusively on PATH. All video modules call this one
service — there is exactly one code path that spawns ffmpeg/ffprobe.

## No mock / dry-run mode

- There is **no mock fallback**. If a provider API key is missing or any
  provider call fails, the system signals an error immediately — it never
  fabricates or synthesizes data.
- `.env.example` documents all keys; `.env.local` is gitignored.

## Project layout

```
D:\VIDEO COLLECT\
├── packages/shared/      # types, Zod schemas, constants, 100-shot dataset
├── apps/server/          # Fastify backend + workers + CLI
├── apps/web/             # React + Vite + Tailwind review UI
└── THE_WORLD_IS_OURS/    # GENERATED output (gitignored) — PRD §6/§41
    ├── footage/<section>/SHOT_###_<PROVIDER>_<id>.mp4
    ├── thumbnails/<asset_id>.jpg
    ├── contact_sheets/{contact_sheet.html, contact_sheet.jpg}
    ├── manifests/{footage_manifest.csv,footage_manifest.json,
    │              license_manifest.csv,commercial_rights_report.html}
    └── database/footage.db
```

## Legal principle (PRD §2)

The app distinguishes `LICENSE_SOURCE_CONFIRMED`, `RIGHTS_REVIEW_REQUIRED`,
`NOT_APPROVED`, and `UNKNOWN`. Only `LICENSE_SOURCE_CONFIRMED` and
human-approved `RIGHTS_REVIEW_REQUIRED` assets may reach `APPROVED_FOR_EDIT`.
**Never infer legal clearance from search-result availability.** The dashboard
shows "Source license verified: N/100" — never "100% legally safe". This is a
rights-management aid, not a legal opinion.
