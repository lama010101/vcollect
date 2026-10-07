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
additive-only. Mixkit + rough-cut export deferred (P3). The one editing
feature is the beat-aligned **Music Edit** (see below).

## Stack

- **Backend:** Node.js + TypeScript + Fastify + Zod
- **Frontend:** React + Vite + Tailwind
- **DB:** SQLite via Node's built-in `node:sqlite` (no native build deps)
- **Video:** ffmpeg/ffprobe via a single FFmpeg service abstraction
- **Images:** sharp
- **Python engine (optional):** managed `.venv` auto-provisioned — librosa +
  numpy/scipy + soundfile + opencv-headless via a persistent NDJSON worker;
  the app runs fine without it
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
| `npx tsx apps/server/src/cli.ts music-edit -s song.m4a -v a.mp4 b.mp4 … -b 2 -o out.mp4 --edl edl.json` | Beat-aligned music video from the CLI |
| `npm run test:music-edit -w apps/server` | Real-song acceptance test (needs `MUSIC_EDIT_SONG`, `MUSIC_EDIT_VIDEOS`) |

## FFmpeg resolution (locked decision)

The single FFmpeg service (`apps/server/src/video/ffmpeg.ts`) resolves the
executable once, in this priority:

1. Explicit configured path (`FFMPEG_BIN_PATH` / `FFPROBE_BIN_PATH` env)
2. System binary in PATH
3. Bundled npm binary (`ffmpeg-static` / `ffprobe-static`)
4. Actionable error naming all three sources

The app never depends exclusively on PATH. All video modules call this one
service — there is exactly one code path that spawns ffmpeg/ffprobe.

## Music Edit (beat-aligned music video)

The **Music Edit** page (and `music-edit` CLI command) cuts a project's
downloaded videos to a song, using beats detected in the song's waveform as
the edit timeline:

```
song → ffmpeg decode (mono 22.05 kHz) → built-in spectral-flux onset
     detection + dynamic-programming beat tracking (no Python)
     → explicit beat timestamps → cut boundaries (every 1/2/4/8 beats)
     → edit decision list (round-robin sources, per-source cursors, trim/retime)
     → ffmpeg: one H.264 part per clip → joined → original song muxed as-is
```

- **Timing source of truth:** the detected beat timestamps (floats, cached per
  song hash under `output/cache/beats/`). Cuts are `beat[i] → beat[i+N]`, the
  song start/end close the first/last clip. A fixed BPM grid is used only when
  automatic detection is switched off (manual BPM).
- **Sources:** used in the listed order V1 → V2 → … → V1; each source keeps a
  cursor so long clips are consumed progressively. Clips are trimmed and, within
  `maxSlowDown`–`maxSpeedUp` (default 0.80–1.25), retimed to fill their
  interval exactly; otherwise the next source is tried (or the source loops when
  "Loop source videos" is on). Nothing fits → `INSUFFICIENT_VIDEO_MATERIAL`.
- **Audio is never retimed:** AAC songs are stream-copied, others encoded to
  AAC; the output is MP4 / H.264 / AAC at 30 fps (configurable) and never
  upscaled beyond the largest source.
- **EDL:** `POST /api/music-edit/plan` returns the full plan (source ranges,
  output ranges, frame ranges, beat indices, speed, loops) before rendering;
  each render also writes `<name>.edl.json` next to the MP4 in
  `<project output>/music_edit/renders/`.
- **API:** `GET /api/music-edit/status|songs|renders`, `POST /api/music-edit/songs`
  (raw body, `?name=`), `POST /api/music-edit/analyze|plan|render`,
  `GET /api/music-edit/render/:id`, `POST /api/music-edit/render/:id/cancel`.

The beat tracker is built in (`apps/server/src/musicEdit/beatAnalyzer.ts`) —
spectral-flux onset envelope + dynamic-programming beat sequence, the same
algorithm family as librosa. **Nothing to install**: ffmpeg (already required
for video) is the only external binary.

The page persists your work per project (`localStorage` key
`twio.musicEdit.<projectId>`): song choice, clip order, settings, analysis,
the built EDL and the running render job all survive a refresh.

## Visualizer (multi-stem audio-reactive video)

The **Visualizer** page turns uploaded audio stems into a synchronized,
frame-accurate MP4: each stem gets its own waveform visual and the audible
stems are mixed into the soundtrack.

```
stems → ffmpeg decode (mono 48 kHz) → shared computeFrame() math
      → per-frame SVG → sharp → raw rgb24 → ffmpeg stdin → libx264
      → amix (unity sum) + limiter → AAC 320k mux → duration-verified MP4
```

- **One frame model, two renderers:** all geometry lives in
  `@twio/shared` (`computeFrame`), so the live Canvas preview draws exactly
  what the server exports — pixel-identical by construction.
- **Modes:** `ribbons` (waveforms converging to a central star), `circular`
  (concentric waveform rings), `particles` (onset-driven particle field),
  `spectrum` (per-stem frequency-band bars — needs the Python engine).
- **Procedural dancer:** an optional deterministic FK skeleton (15 joints)
  dances at the convergence point — bass drives legs/hips, drums drive
  bounce/step, vocals drive head/torso, keys/guitar drive arms. Styles:
  `neon` / `silhouette`.
- **Stems:** kind auto-detected from filename (vocal/drums/bass/keys/
  guitar/fx/other), per-stem color/amplitude/glow/mute/solo. Muted stems
  leave the mix and render dimmed; solo isolates.
- **API:** `GET/POST/DELETE /api/visualizer/stems`,
  `GET /api/visualizer/stems/:name/signal` (binary peaks/env + engine
  features), `POST /api/visualizer/render`, `GET /api/visualizer/render/:id`,
  `POST …/cancel`, `GET /api/visualizer/renders`.
- Outputs land in `<project output>/visualizer/renders/` with a `.viz.json`
  config sidecar next to each MP4.

## Python engine (optional, auto-provisioned)

A managed Python engine adds librosa-grade stem analysis (tempo, onsets,
per-band energy envelopes, beat grids) that sharpens the visualizer's
spectrum mode and the dancer's motion. It is **fully optional** — the app,
the TS beat tracker, and every non-spectrum visualizer mode work without
it; engine-dependent features report a clear `ENGINE_UNAVAILABLE` instead
of failing.

- On first use, `apps/server/python/` creates a `.venv` from a discovered
  interpreter (`PYTHON_BIN_PATH` env → `py` launcher / PATH) and installs
  `requirements.txt` (numpy, scipy, librosa, soundfile, opencv-headless —
  ~300 MB download). `POST /api/engine/setup` triggers it in the
  background; `GET /api/engine/status` reports progress.
- `TWIO_ENGINE_DISABLED=1` turns the engine off entirely.
- The worker is a persistent NDJSON-RPC process
  (`twio_engine/worker.py`); feature results are cached per stem sha256
  under `output/cache/engine/`.

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
└── output/               # GENERATED output root (gitignored), OUTPUT_DIR env
    ├── <project-slug>/   # one dedicated folder per project
    │   ├── assets/<query>/SHOT_###_<PROVIDER>_<id>.mp4   # downloads
    │   ├── assets/uploads/<filename>                    # drag & drop videos
    │   ├── contact_sheets/{contact_sheet.html, contact_sheet.jpg}
    │   ├── manifests/{footage_manifest.csv,footage_manifest.json,
    │   │              license_manifest.csv,commercial_rights_report.html}
    │   ├── music_edit/{songs,renders}/
    │   └── visualizer/{stems,renders}/   # uploaded stems + rendered MP4s
    ├── thumbnails/<asset_id>.jpg   # global, keyed by asset id
    ├── database/footage.db
    ├── cache/beats/                # beat-analysis cache
    └── cache/engine/               # sha256-keyed librosa feature cache
```

Every project owns its asset files under `output/<slug>/assets/` — downloads
are grouped by the search query that found them, and videos **dragged &
dropped anywhere onto the webapp** land in `assets/uploads/` (validated with
ffprobe, hashed, thumbnailed, and listed under "uploads" on the Folders page
and in the Music Edit library). `POST /api/assets/upload?project=<id>&name=`
is the API; the Dashboard "Downloaded" card links to the full asset list.

## Legal principle (PRD §2)

The app distinguishes `LICENSE_SOURCE_CONFIRMED`, `RIGHTS_REVIEW_REQUIRED`,
`NOT_APPROVED`, and `UNKNOWN`. Only `LICENSE_SOURCE_CONFIRMED` and
human-approved `RIGHTS_REVIEW_REQUIRED` assets may reach `APPROVED_FOR_EDIT`.
**Never infer legal clearance from search-result availability.** The dashboard
shows "Source license verified: N/100" — never "100% legally safe". This is a
rights-management aid, not a legal opinion.
