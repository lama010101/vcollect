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
| Beat analysis | built-in TS tracker (`musicEdit/beatAnalyzer.ts`: spectral-flux + DP) — primary, no Python needed |
| Python engine (optional) | `apps/server/python/twio_engine` NDJSON worker; managed `.venv` auto-install of pinned numpy/scipy/librosa/soundfile/opencv-headless — enriches stems, app runs without it |
| Tests | Vitest (shared) + `tsx --test` (server — Vite breaks on space in repo path) |

## Architecture map

```
apps/server/src/
  acquisition/   pipeline.ts, runner.ts, tasks.ts, queryExpansion.ts
                 — acquire = discover+rank+persist only; KEEP triggers download
  providers/     pexels.ts, pixabay.ts, factory.ts, rateLimiter.ts, searchCache.ts
  import/        scriptParser.ts (regex, no AI) · llmParser.ts (Ollama/Groq, optional)
  musicEdit/     beatAnalysis.ts · beatAnalyzer.ts · edl.ts · render.ts ·
                 service.ts · errors.ts
  visualizer/    decode.ts · svg.ts · render.ts · service.ts · errors.ts ·
                 features.ts (sha256-cached librosa stem features via engine)
  python/        pythonService.ts (interpreter resolution + managed venv
                 auto-install) · engineClient.ts (worker lifecycle/RPC)
  routes/        dashboard.ts · folders.ts · review.ts · musicEdit.ts ·
                 uploads.ts (drag & drop video upload → project assets/) ·
                 visualizer.ts · engine.ts
apps/server/python/
  twio_engine/   worker.py (NDJSON RPC) · features.py (librosa analysis)
  .venv/         managed venv (gitignored, auto-created on first engine use)
  state/         machine.ts (PRD §8; UNKNOWN→APPROVED_FOR_EDIT impossible)
  db/            client.ts (Sql wrapper, lazy stmts)
  video/         ffmpeg.ts (resolution: env → PATH → bundled npm binary)
apps/web/src/
  pages/         Dashboard, Projects, Search, ShotList, ShotReview, Timeline,
                 Folders, ImportScript, MusicEdit, Visualizer, Help
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
| Multi-stem visualizer | ✅ Done | Waveform-convergence video renderer; shared frame math in `@twio/shared` |
| Visualizer modes | ✅ Done | ribbons / circular / particles / mirror / blocks / eqbars / eqradial / stereo / silk (engine-free) + spectrum (engine band features) |
| Procedural dancer | ✅ Done | 15-joint FK skeleton, deterministic f(t) from stem envelopes/onsets; neon/silhouette |
| Visualizer video layer | ✅ Done | Downloaded project asset composited under/over the visuals; looped + cover-cropped, deterministic t=k/fps timing; chroma-key bg removal |
| Beat-synced Look auto modes | ✅ Done | autoGlow (per-beat random glow in range) + autoCenter (center glides to a hashed spot per beat) |
| Python engine | ✅ Done (optional) | Managed venv + librosa worker; stem features enrich visualizer — app runs without it |
| Per-project asset folders | ✅ Done | `OUTPUT_ROOT/<slug>/assets/`; existing files migrated |
| Drag & drop upload | ✅ Done | Drop videos anywhere → `<slug>/assets/uploads/` + asset row |
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

Last verified: `npm run typecheck` + server tests (97 incl. chroma-key) ✅ (2026-10-06).

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

### 2026-10-07 — Visualizer: new `silk` mode (spectral stacked waveform)
- **New `silk` mode** (`packages/shared/src/visualizer.ts`): reproduces the
  reference "dual glowing waveform" render — each stem owns a horizontal
  slice of the width, inside which 22 nested scaled copies (0.06→1.0) of the
  |peak| window are stroked above and below the axis; a per-strand
  deterministic temporal offset (±14 ms) makes the strands fan apart at
  crests. A sin^0.75 taper silences slice ends → the center gap and frame
  edges go quiet like the reference. Strands stroke through a per-stem
  `userSpaceOnUse` 3-stop linear gradient: violet→blue→cyan left of the
  convergence point, amber→orange→magenta right, quadratically whitened
  toward the point and tinted 18% by the stem color (sweep stays dominant);
  the mid-stop offset lands exactly on the point for straddling slices.
  Plus: luminous axis strip (gradient fill + white core), 46 twinkling dust
  particles clustered around the local wave height, and the last (scale-1)
  strand re-stroked brighter as the edge trace.
- Files: `packages/shared/src/visualizer.ts` (VizSilkStem, silkSpectral,
  computeSilk, dispatch), `apps/server/src/visualizer/svg.ts` (strandsPath +
  gradient defs + silk block), `apps/web/src/pages/Visualizer.tsx` (MODES
  entry + Canvas draw block — same emit order), test assertions in
  `apps/server/test/visualizer.node.test.ts` (dispatch sum, pack/axis/dust/
  gradient/mirror invariants, silent-window fade).
- Verified: `npm run typecheck` ✅; `tsx --test` visualizer suite ✅.

### 2026-10-07 — Visualizer: per-stem waveforms + analysis progress bars
- **Stem strips in "1. Stems"**: every analyzed stem (library list *and*
  the "In this visual" list) renders a `StemWave` — a 140-column SVG
  silhouette built from the cached `StemSignal.peaks`, mirrored
  top/bottom, tinted by the stem's resolved color (neutral sky-400 for
  library rows not yet in the render set).
- **Per-stem analysis progress**: while a stem's signal is being built,
  its row shows an `AnalysisBar` — fill advances with the real server
  build phase (decoding audio 25% → analyzing features 65% → assembling
  90%, queued = 4%) plus a phase label. The phase comes from a new
  `GET /api/visualizer/stems/:name/signal/status` endpoint backed by a
  `phases` map in `signals.ts` (set inside `buildPayload`, cleared on
  completion — covers upload-warmed builds too via the in-flight dedupe).
  The client tracks `decodingName` in the sequential fetch loop and polls
  the status endpoint every 500 ms while a fetch is in flight.
- Files: `apps/server/src/visualizer/signals.ts`,
  `apps/server/src/routes/visualizer.ts`, `apps/web/src/api.ts`,
  `apps/web/src/pages/Visualizer.tsx` (StemWave, AnalysisBar,
  decodingName/sigPhase wiring, library + render-set row strips).
- Verified: `npm run typecheck` ✅ all workspaces; signal-cache test ✅
  (phases don't perturb the build).

### 2026-10-07 — Visualizer: stem signal payloads cached on disk (analyze once)
- **New `visualizer/signals.ts`**: `stemSignalPayload()` builds the binary
  `[meta][peaks][env][stereo][features]` blob once per stem **content** —
  sha256 of the file → `output/cache/viz-signal/<sha>-v1-{f|nf}.bin`, same
  convention as `cache/engine` + `cache/beats`. App restarts / page reloads
  now re-send cached bytes instead of re-running the ffmpeg decode +
  full-PCM peak/env scans. Two variants: `-f` (engine features baked in)
  is always preferred; `-nf` is only served while the engine is down, and
  a provisioned engine auto-upgrades the blob on the next fetch. Writes
  are atomic (tmp + rename); cache-write failures never break the route.
- **Upload warmup**: `saveStem` kicks `stemSignalPayload()` in the
  background after the audio probe, so the analysis runs the moment a
  stem lands; an in-flight dedupe map shares that build with the first
  preview fetch. Re-uploads produce a new hash → auto-invalidation.
- Route `GET /api/visualizer/stems/:name/signal` slimmed to stemPath +
  `stemSignalPayload` + send — all the decode/meta/f32 assembly moved
  into the cached builder.
- Files: `apps/server/src/visualizer/signals.ts` (new),
  `apps/server/src/routes/visualizer.ts`,
  `apps/server/src/visualizer/service.ts`,
  `apps/server/test/visualizer.node.test.ts` (+signal-cache test: cold
  build → cached:true byte-identical second call → renamed-copy hit;
  `engineClient.kill()` teardown so the persistent worker doesn't pin
  the test process).
- Verified: `npm run typecheck` ✅ all workspaces; visualizer suite 28/28 ✅
  (cache test pays one real cold build ≈70s incl. engine features, then
  serves instantly).

### 2026-10-07 — Visualizer: cap live-preview height at 50vh
- The "4. Live preview" canvas no longer exceeds half the screen height:
  the non-fullscreen canvas switched from `w-full` to `width:auto` +
  `max-height:50vh` + `max-width:100%` + `mx-auto`, so `aspect-ratio`
  transfers the height cap back through to width and tall/portrait renders
  get a narrow centered canvas instead of a page-tall one. Fullscreen is
  unchanged (`max-w/full max-h/full` already fits); the 640px backing
  store and draw math are untouched.
- Verified: `npm run typecheck` ✅ (web).

### 2026-10-06 — Visualizer: VIDEO layer (project clip under/over the visuals) + CENTER Auto
- **New "3. Video" section** on the Visualizer page (between Look and Live
  preview — preview/render renumbered to 4./5.): pick any downloaded
  project asset (`searchAssetsAdvanced` with `downloadedOnly`, refreshed
  on `ASSETS_CHANGED_EVENT`), choose layer **Under** (default — behind the
  equalizer/visuals, above the background) or **Above** (over the mode
  visuals, still under dancer + star), plus an opacity slider and asset
  thumbnail. The selection persists per project (localStorage) and rides
  along in `globalVisuals.video` `{assetId, layer, opacity}`.
- **Preview**: a hidden `<video>` (`api.assetFileUrl`) is cover-cropped via
  the shared `coverCrop()` helper inside `drawState()` — `under` draws
  right after the bg fill, `over` after the mode groups. The element
  free-runs while playing (0.25 s drift correction against the
  AudioContext clock) and seeks to `t % duration` while paused/scrubbing,
  mirroring the export's `-stream_loop -1`.
- **Export** (`render.ts`): a second ffmpeg child decodes the source into
  exactly one cover-cropped rgb24 frame per output frame
  (`fps=<fps>,scale=increase,crop` + `-stream_loop -1`); each frame is
  JPEG-encoded and embedded as a data-URI `<image>` in the frame SVG —
  `frameSvg(state,w,h,bg,videoImageHref)` emits it after the bg rect for
  `under` and before the dancer for `over`, so a single rasterize pass
  composites everything. `FrameReader` queues chunks without copying and
  pauses the pipe for backpressure (the looping decoder would otherwise
  flood memory). `VizFrameState.video` carries `{layer,opacity}` from
  `computeFrame` so both renderers place the layer identically.
- **Chroma-key ("Remove flat background")**: `video.chromaKey{enabled,
  color, similarity, blend}` drops a flat monochrome background so the
  layer behind shows through. Export runs the key in the decoder ffmpeg
  (`format=rgba,colorkey=0xC:sim:blend` → rgba pipe → PNG embed so the
  alpha survives into the SVG); preview runs the same threshold+feather
  ramp per-pixel via the shared `chromaKeyFrame()` on an offscreen canvas
  (capped ~1 MP so the loop stays cheap). `VizFrameState.video` carries
  the key config only while enabled. UI: "Color key" toggle + color
  picker + ⤡ corner-sample button (averages the top-left 12×12 pixels of
  the current frame) + Tolerance/Feather sliders.
- **Validation** (`service.ts`): the asset must belong to the project and
  have a local file (404 `VIDEO_ASSET_NOT_FOUND` / 422
  `VIDEO_NOT_DOWNLOADED` / 404 `VIDEO_FILE_MISSING`); `probe()` in the job
  rejects unplayable files (422 `VIDEO_NOT_PLAYABLE`); decode EOF mid-
  render → 500 `VIDEO_DECODE_FAILED`. Video audio is never used.
- **CENTER mini-card** ("2. Look"): Center X/Y sliders grouped into a
  bordered card with an **Auto** toggle → `autoCenter{enabled,range}`
  (range 0–35% of the frame axis, default 18%). When on, the new shared
  `frameCenter()` computes a deterministic hashed target per beat cell
  (`hash01(cellIndex, seed)` → ±range around the midpoint) and smoothstep-
  eases into it over the first ~60% of the beat — pure f(t), so export
  lands on the same pixels. Dancer + star anchor to the same point (render
  + preview call `frameCenter` instead of raw `centerConvergence`).
  `beatCellIndex` grew a `beatCell()` parent returning the cell's
  [start,end) range for the glide math. X/Y sliders dim while Auto is on.
- Files: `packages/shared/src/visualizer.ts` (vizVideoSchema, autoCenter,
  beatCell/frameCenter/coverCrop, VizFrameState.video),
  `apps/server/src/visualizer/{svg,render,service}.ts`,
  `apps/web/src/pages/Visualizer.tsx`,
  `apps/server/test/visualizer.node.test.ts` (+video-layer describe:
  schema defaults, coverCrop math, frameSvg ordering, chromaKeyFrame ramp,
  videoDecoderArgs; +autoCenter glide).
- Verified: `npm run typecheck` ✅ all workspaces; server suite 97/97 ✅;
  live render sanity — red test clip under blocks visuals + over at 50%
  opacity produced correct composited frames past the clip's end (looped);
  green-screen clip keyed `over` rendered with the bg showing through the
  removed background and opaque content preserved.

### 2026-10-06 — Visualizer: inner-radius control, fullscreen Look panel, auto-glow
- **`innerRadius` global** (`visualizerRenderSchema.globalVisuals`, 0–0.5 of
  min(w,h), default 0.12): the `eqradial` hub radius is user-controlled —
  0 means bars radiate from the exact center point. `computeEqRadial` reads
  it, so preview and MP4 export share the value; the mode picker shows an
  "Inner radius" slider (0–50%) whenever `eqradial` is selected.
- **Auto glow**: `autoGlow{enabled,min,max}` in `globalVisuals` — when on,
  `computeFrame` overrides `glowIntensity` with a deterministic hash of the
  current beat cell (`beatCellIndex` counts distinct beats ≤ t merged across
  stems, 40 ms dedupe; falls back to stem onsets, else a 0.5 s grid when
  there are no engine features). Identical math in preview + export since
  it's a pure function of t. UI: dual-thumb `DualRange` slider (new
  `.dual-range` styles in `index.css`) + "Auto" toggle; the static Glow
  slider dims while Auto is active.
- **Fullscreen Look panel**: the "2. Look" controls were extracted to a
  shared `lookContent` block — rendered in the settings section as before
  and inside a floating overlay in the fullscreen preview (a `◈ Look`
  button top-right opens/closes it; double-click fullscreen toggle is
  suppressed inside the panel).
- Files touched: `packages/shared/src/visualizer.ts` (schema, beatCellIndex,
  computeFrame effGlobals, computeEqRadial R0),
  `apps/web/src/pages/Visualizer.tsx`, `apps/web/src/index.css`,
  `apps/server/test/visualizer.node.test.ts` (+innerRadius ring assertions,
  autoGlow per-beat hash test incl. no-features grid fallback).
- Verified: `npm run typecheck` ✅ all workspaces; visualizer suite 21/21 ✅;
  sanity renders at innerRadius 0 (center-fanning wedges) and 0.3 (large
  hub ring) checked visually.

### 2026-10-06 — EQ Bars Radial visualizer mode
- **New `eqradial` mode** (`packages/shared/src/visualizer.ts`): the `eqbars`
  LED-column look bent around the convergence point. Every stem owns an equal
  wedge of the full circle — global bar index `g = i·cols + c` → angle
  `g/N·2π` starting at the top (−90°) — so bars stay evenly spaced around
  the midpoint with contiguous per-stem color wedges. Bars are
  constant-angular-width quads (stride-9 `[x,y]×4 + bright`) growing
  outward from hub radius `R0 = 0.12·minDim` by `level × maxLen`
  (`0.36·minDim`), brightening toward the outer tip with hot tip caps
  (stride-8 quads), tip glow flares, and the same hash01-seeded spark
  embers drifting outward along the ray. A luminous ring marks R0.
- **Shared sampling:** the eqbars column-level block (engine band-envelope
  interpolation → smoothed |peaks| + taper + two jitter octaves) was
  extracted to `eqColumnLevels()` so both EQ modes sample identically;
  colors, `mixHex` tip color, glow/alpha/activity fades unchanged.
- Emitters: `svg.ts` gained `quadsPath()` (stride-8 batched quad path) +
  the eqradial block (5 brightness buckets, hub `<circle>` ring,
  tipGlow/sparks via `circlesPath`); `Visualizer.tsx` Canvas preview draws
  the same quantized alpha + ring stroke via a `quadAt()` Path2D helper —
  export matches preview. Mode picker gained "EQ Bars Radial — segmented
  columns radiating from the center". No engine required.
- Files touched: `packages/shared/src/visualizer.ts` (schema, VizEqRadialGroup,
  eqColumnLevels, computeEqRadial, dispatch),
  `apps/server/src/visualizer/svg.ts`, `apps/web/src/pages/Visualizer.tsx`,
  `apps/server/test/visualizer.node.test.ts` (+eqradial dispatch/annulus/
  top-start/ring assertions, silent-window line, channel-exclusivity sum).
- Verified: `npm run typecheck` ✅ all workspaces; visualizer suite 20/20 ✅;
  single-frame SVG→PNG sanity render shows three stem-colored wedges of
  segmented radial bars around the glowing hub ring with tips + sparks.

### 2026-10-01 — EQ Bars visualizer mode (Specterr-style LED columns)
- **New `eqbars` mode** (`packages/shared/src/visualizer.ts`): the width is
  partitioned into a per-stem x-slice; each slice draws dense segmented LED
  columns mirrored about the horizontal axis — segments brighten toward the
  tip (stride-5 `[x,y,w,h,bright]` geometry), both column ends get hot
  whitened tip caps (`mixHex` toward #FFFFFF), upper tips carry glow flares
  and shed deterministic spark embers (hash01-seeded rise phase, count and
  reach scale with level + onset pulse), and a luminous strip marks the
  mirror axis. Column levels interpolate the engine's low→high band
  envelopes when features exist (true spectrum); otherwise they come from
  the smoothed windowed |peaks| with a gentle edge taper + two jitter
  octaves for the jagged skyline look. Honors mute/solo + the silent-window
  activity fade; no engine required.
- Emitters: `svg.ts` buckets segments into 5 brightness levels (one path per
  level) + batched tip/axis/spark paths; `Visualizer.tsx` Canvas preview
  draws the same quantized alpha so export matches preview. Mode picker
  gained "EQ Bars — segmented mirrored columns, glowing tips + sparks".
- Files touched: `packages/shared/src/visualizer.ts` (schema, VizEqGroup,
  computeEqBars, mixHex, dispatch), `apps/server/src/visualizer/svg.ts`,
  `apps/web/src/pages/Visualizer.tsx`,
  `apps/server/test/visualizer.node.test.ts` (+eqbars dispatch/mirror/
  axis/spark assertions, silent-window line).
- Verified: typecheck ✅ all workspaces; visualizer suite 20/20 ✅ (incl.
  new eqbars assertions + e2e render); single-frame SVG→PNG sanity render
  checked visually against the reference image (segmented mirrored columns,
  two stem-colored groups, glowing tips, spark fountains, axis glow).

### 2026-09-30 — Python engine + visualizer modes + procedural dancer
- **Python engine foundation** (`apps/server/python/`): pinned
  `requirements.txt` (numpy, scipy, librosa, soundfile,
  opencv-python-headless — no MoviePy) + `twio_engine/` package —
  `worker.py` is a persistent NDJSON-RPC stdin/stdout process with lazy
  imports (ping needs zero deps); `features.py` runs librosa analysis.
  TS side: `src/python/pythonService.ts` resolves interpreters as
  `PYTHON_BIN_PATH` → managed `.venv` → `py` launcher / PATH with real
  `--version` probing (the WindowsApps Store stub is detected and
  rejected), auto-creates the venv, `pip install`s, and stamps
  `.deps-stamp` by requirements hash. `src/python/engineClient.ts` owns
  the long-lived worker (spawn, NDJSON request/response map, respawn on
  death, timeouts). Routes: `routes/engine.ts` —
  `GET /api/engine/status`, `POST /api/engine/setup` (background
  provisioning), `POST /api/engine/call` (diagnostics).
  `TWIO_ENGINE_DISABLED=1` or a missing interpreter never blocks server
  boot — engine features just report `ENGINE_UNAVAILABLE`/`ENGINE_DISABLED`.
- **Stem feature extraction** (`visualizer/features.ts`): sha256-keyed
  cache under `output/cache/engine/`; on a miss ffmpeg decodes the stem
  to mono 22.05 kHz f32le and the worker writes manifest.json + bands.f32
  + env.f32 + onset_env.f32. `StemSignal.features` stays **optional** in
  shared — everything degrades to envelope-driven visuals without Python.
  `GET /api/visualizer/stems/:name/signal` returns a binary
  `[u32 metaLen][meta JSON][f32 arrays]` payload (peaks, env, bands,
  feature env, onset env) decoded by `api.vizStemSignal` in the web client.
- **New visual modes** (`computeFrame` dispatch in shared
  `visualizer.ts`): `circular` (concentric ring waveforms), `particles`
  (deterministic hashed orbit field, onset kicks push radii outward),
  `spectrum` (6-band bar lanes per stem — engine features required; the
  service fails fast with `ENGINE_REQUIRED` when no stem has features).
  `svg.ts` gained ring/bar/particle emitters sharing the same packed
  Float32Array geometry the Canvas preview draws.
- **Procedural dancer** (`packages/shared/src/dancer.ts`): deterministic
  forward-kinematic 15-joint skeleton as tapered-ribbon limbs, motion a
  pure function of t + stem envelopes/onsets — bass→legs/hips, drums→
  kick-dip bounce + alternating step lifts, vocals→head nod/lean,
  keys/guitar→arm swing. `dancerConfigSchema` (enabled/style/scale/
  intensity/colorMode) under `globalVisuals.dancer`; styles `neon`
  (additive glow strokes + limb fills) and `silhouette` (fills only).
  Stands at the convergence point; identical skeleton in preview + export.
- **Visualizer page** (`apps/web/src/pages/Visualizer.tsx`): stem library
  + in-render panel (kind select, color, amp/glow sliders, mute/solo,
  reorder, delete), look settings (mode/layout/waveform window/global
  amplitude/glow/bg/convergence point), dancer controls, live Canvas
  preview driven by an `AudioContext` clock with per-stem gain nodes
  honoring mute/solo + scrub + loop, render presets (1080p/4K/square/9:16,
  24/30/60 fps), job polling + cancel + renders list, per-project
  localStorage persistence (`twio.visualizer.<projectId>`), and an engine
  status banner with one-click setup.
- Files touched: shared (`visualizer.ts`, `dancer.ts` new, `index.ts`,
  `schemas.ts`), server (`python/` new, `python/pythonService.ts`,
  `python/engineClient.ts`, `routes/engine.ts`, `routes/visualizer.ts`,
  `visualizer/features.ts`, `visualizer/service.ts`, `visualizer/render.ts`,
  `visualizer/svg.ts`, `config.ts`, `index.ts`), web (`api.ts`,
  `Visualizer.tsx`, `App.tsx`), `requirements.txt`, `.env.example`,
  `.gitignore`, `test/engine.node.test.ts` (new),
  `test/visualizer.node.test.ts` (+modes/dancer block, e2e now renders
  with dancer enabled).
- Verified: typecheck ✅ all workspaces; server tests 88/88 ✅ (+5
  modes/dancer, +5 engine: stub rejection, NDJSON ping, UNKNOWN_METHOD,
  respawn, real librosa analyze_stem on a synthetic click track incl.
  cache-hit second call); shared 4/4 ✅; visualizer e2e render with dancer
  enabled ✅. Managed `.venv` provisioned on this box (Python 3.13.5,
  deps installed).
- Follow-up fixes after first live run: stem auto-add now uses the
  **server-sanitized** name from the upload response (browser filenames
  with unsafe chars silently mismatched → Render MP4 stayed disabled);
  signal-fetch failures surface as errors instead of silently dropping
  stems from the preview; `stemFeaturesOrNull` checks `engineStatus().ok`
  first so signal fetches/renders never block on a multi-minute pip
  install (provisioning is opt-in via POST /api/engine/setup); re-uploads
  invalidate the cached signal. Stem library UX: "Add all →" bulk button +
  per-stem ▶/■ audition (shared Audio element, independent of the
  WebAudio preview mix) + per-stem ✕ remove-from-visual. Preview WebAudio
  rework: sources tracked per stem in a live graph — stems added
  mid-playback decode + join the mix at the current position, removed
  stems drop out, mute/solo move gain nodes live (previously the mix was
  frozen at Play time so late-added stems were silent). Stems with no
  sound in the displayed window now fade to fully transparent via
  `windowActivity`/`envActivity` in shared/visualizer.ts — silent or
  finished stems no longer draw a flat baseline (star also darkens);
  applies to all 4 modes identically in preview and export. Per-stem
  signal-decode errors are now tracked in a Map and surfaced in the UI:
  ⚠ badge with the error on the library row + an amber "No preview" line
  with a retry button in the render-set row (transient backend-restart
  500s no longer permanently break a stem's preview). api.ts errors now
  explain themselves — non-JSON 5xx bodies report "backend may be down
  or restarting", and unreachable-server failures say to check
  npm run dev, instead of bare "500 /url". Visualizer page UX pass:
  every module is now a collapsible Section (▸/▾ header, actions stay
  reachable while folded); live preview has a fullscreen toggle
  (button + double-click, canvas backing store resizes to screen so it
  stays sharp); signal decode shows a real progress bar with done/total
  + current stem name and per-row spinners; Uploaded panel has a Clear
  button (confirmed, deletes all stem files); finished renders show the
  absolute Windows path as a clickable link that opens the folder via a
  new POST /api/visualizer/reveal route (reuses revealInExplorer; each
  renders-list row also has a "folder" button). Raised the render
  schema's stem cap from 8 to 20 (visualizerRenderSchema). New ribbons
  layout "vertical" — even stems fan upward, odd stems fan downward
  (±55° around ±90°), same alternating pattern as "speakers" rotated 90°.
  Two new modes from reference art: "mirror" — every stem's |peak|
  waveform mirrored about the horizontal center axis, overlaid as
  translucent fills + nested echo traces (×0.72/×0.45) + crest sparkle
  dots at local maxima; "blocks" — the width is partitioned per stem,
  each slice drawing segmented columns mirrored above/below the axis
  (stacked blocks + tip glow dots, LED-equalizer look). Both honor the
  silent-window activity fade; canvas + SVG emitters added. New "stereo"
  mode — decode.ts now decodes stereo sources with -ac 2 and
  de-interleaves L/R (+ mono mid mix); StemSignal carries optional
  peaksL/peaksR through the signal wire format and the render pipeline.
  computeStereo draws channel waveforms as fills hugging the vertical
  center line (left [cx−v,cx], right [cx,cx+v]) so they meet along a
  real mirror line — mono stems reuse the mono peaks on both sides →
  exact symmetry, never a single point.

### 2026-09-30 — Multi-stem synchronized audio visualizer

### 2026-09-30 — Multi-stem synchronized audio visualizer
- New **Visualizer** feature: upload audio stems per project, watch a live
  Canvas preview of each stem's waveform traveling from the canvas edge to a
  central convergence star, then export a frame-accurate MP4 with the stems
  mixed in. Muted stems are excluded from the mix + dimmed (~15% alpha);
  solo isolates.
- **Shared math** (`packages/shared/src/visualizer.ts`): all frame geometry
  is pure — `computeFrame(stems, globals, w, h, t)` maps the spec's window
  `[⌊(t−w)·r⌋, ⌊t·r⌋]` onto edge→center paths ± normal offset, peak-reduces
  PCM to a 2400 Hz signed series, and emits variable-width ribbon polygons +
  per-kind modifiers (drums transient flash, bass width oscillation, vocal
  smoothing, keys harmonic lines, guitar/fx shimmer). Both engines consume
  it → preview = export, zero drift. Layouts: `radial` / `speakers` / `fan`.
- **Server** (`apps/server/src/visualizer/`): `decode.ts` (ffmpeg → mono
  f32le @48k), `svg.ts` (frame→SVG), `render.ts` (sharp rasterizes each
  frame → raw rgb24 → **ffmpeg stdin pipe** → libx264; `amix normalize=0 +
  alimiter` → AAC 320k mux, `-c:v copy`, duration verify), `service.ts`
  (per-project `visualizer/{stems,renders}` dirs, in-memory jobs).
  `ffmpegService.ffmpegSpawn()` added — same single binary path, caller owns
  stdin. Deliberately **no Python** (user decision): zero new deps.
- **Routes** `routes/visualizer.ts` (`/api/visualizer/*`): stems
  GET/POST(raw)/DELETE, render POST→job/GET/cancel, renders GET + `.viz.json`
  config sidecars.
- **Web**: `pages/Visualizer.tsx` — stem manager (kind auto-detect, color,
  mute/solo), global sliders (waveform length, amplitude, glow, layout, bg,
  pulse), resolution presets (1080p/4K/square) + 30/60fps, Canvas preview
  driven by `AudioContext` clock with mute/solo gain nodes + scrub,
  localStorage persistence (`twio.visualizer.<projectId>`), job polling +
  renders list. Nav item "Visualizer" (∿) in `App.tsx`.
- Files touched: shared (`visualizer.ts`, `index.ts`), server (`ffmpeg.ts`,
  `visualizer/*`, `routes/visualizer.ts`, `index.ts`), web (`api.ts`,
  `Visualizer.tsx`, `App.tsx`), `test/visualizer.node.test.ts` (new).
- Verified: typecheck ✅ all workspaces; `npm test` 78/78 ✅ (+13 new:
  frame-mapping math, layouts, ribbon/peak/solo units, e2e render of two
  synthesized WAVs → probed MP4 30fps AAC); HTTP smoke ✅ — stem upload →
  render → job done → MP4 frame extracted (waveforms + glow + center star
  visible). Perf: ~1× realtime at 1080p60 expected; 4K60 slower (~0.25–0.4×).

### 2026-09-29 — Music Edit sources = everything in the project folder
- The Music Edit "Source videos" library (and the Folders page) now reflect
  **all video files physically inside the project's assets folder**, no
  matter how they got there — downloads, drag & drop, or files copied in via
  Explorer / another tool.
- New `src/db/assetSync.ts` + `POST /api/assets/sync?project=<id>`: recursive
  scan of `OUTPUT_ROOT/<slug>/assets/`, and for every video file with no DB
  row it hashes (sha256), verifies the container with ffprobe, probes
  metadata, creates a `provider_id='local'` asset row
  (`LOCAL_<project>_<sha16>` — same content dedupes with uploads) and a
  thumbnail. Idempotent — existing `local_path`s are skipped before hashing.
  `?project=__ALL__` syncs all projects.
- `MusicEdit.tsx` runs sync before each library load and now also has a
  "↻ Refresh from folder" button in the "2. Source videos" header (toasts how
  many new videos were registered, works under `__ALL__` too); `Folders.tsx`
  `load()` syncs too — so manually added files appear without restarting
  anything.
- Folders grouping: `local` assets now group by their real physical
  subfolder under `<slug>/assets/` (uploads, query names, custom subdirs)
  instead of a single "uploads" bucket.
- `VIDEO_FILE_EXTENSIONS` moved to `config.ts` (shared by upload + sync).
- Verified: typecheck ✅ all workspaces; E2E on temp OUTPUT_DIR ✅ — an
  mp4 copied into `assets/manual drop/` via the filesystem was registered
  (row + probe metadata + thumbnail), appeared in the `downloadedOnly`
  library query and in Folders under "manual drop", re-sync idempotent,
  non-video file ignored.

### 2026-09-29 — Music Edit session persistence
- The Music Edit page now persists the whole working session per project in
  `localStorage` (`twio.musicEdit.<projectId>`): selected song, ordered clip
  list (full asset objects so display survives library filters), all
  cut/retime/output settings, library filter text, beat analysis, the built
  EDL preview, and the active render job id.
- Hydration happens synchronously at first render (lazy ref + useState
  initializers) — a useEffect restore would lose the blob under React
  StrictMode (double-run effects could persist defaults over the saved data
  before the restore re-read). The mount/switch effect also re-fetches a
  running render job (`GET /api/music-edit/render/:id`) so polling resumes,
  and drops a saved song that was deleted server-side.
- Plan invalidation changed from "any input change clears the plan" to
  request-key comparison (`JSON.stringify(request)` stored alongside the
  plan): the restored plan survives refresh, and inputs that return to the
  exact planned state keep it valid.
- Files touched: `apps/web/src/pages/MusicEdit.tsx`.
- Verified: `@twio/web` typecheck ✅.

### 2026-09-29 — Project asset folders + drag & drop upload
- **Per-project asset folders:** real files now live in
  `OUTPUT_ROOT/<slug>/assets/<query>/` (was global `OUTPUT_ROOT/<query>/`).
  `projectPaths()` gained `assets`; new `projectAssetDir(slug, subdir)` in
  config.ts. `downloadAsset` takes a `DownloadDest {projectSlug, searchQuery}`;
  both call sites in `pipeline.ts` pass the project's slug.
- **Migration:** `migrateAssetsToProjectFolders()` in migrate.ts moves every
  downloaded file into its project's folder and rewrites `local_path`
  (`<query>/x.mp4` → `<slug>/assets/<query>/x.mp4`). Files shared between
  projects (cross-project copies) are duplicated so each project physically
  owns its files; now-empty top-level query dirs are pruned.
- **Copy-to-project** (`assetCopy.ts`) now physically copies the video into
  the target project's assets dir (was: shared path) — deleting a project
  can't break copies living elsewhere.
- **Drag & drop upload:** drop video files anywhere on the webapp → overlay →
  `POST /api/assets/upload?project=<id>&name=<file>` (raw body, capped at
  MAX_DOWNLOAD_MB). Server sanitizes the filename, verifies the container via
  ffprobe, sha256s it, and writes `…/<slug>/assets/uploads/<name>` + a
  `provider_id='local'` asset row (id `LOCAL_<project>_<sha16>` — re-uploads
  dedupe by content). Uploads get a thumbnail + appear in Folders under
  "uploads" and in the Music Edit library. Non-video extensions rejected 415,
  unplayable files 422, `__ALL__` rejected 400.
- **Dashboard:** the "Downloaded" stat card is clickable → Folders page (all
  downloaded assets); "Active Downloads" header gained an "All downloaded →"
  link. FolderNode.absolutePath now points at the real `…/<slug>/assets` dir.
- **Files touched:** config.ts, download.ts, pipeline.ts, migrate.ts
  (+ 'local' provider row), folders.ts, assetCopy.ts, repository.ts
  (`insertLocalAsset`), routes/uploads.ts (new), index.ts, api.ts
  (`uploadProjectAsset` + `ASSETS_CHANGED_EVENT`), App.tsx (drop zone),
  Dashboard.tsx, Folders.tsx + MusicEdit.tsx (refresh on upload),
  test/uploads.node.test.ts (new).
- **Verified:** typecheck ✅ all workspaces; server tests 65/65 ✅ (+7 upload
  helper tests); shared 4/4 ✅; E2E on temp OUTPUT_DIR ✅ — legacy file
  migrated into project folder, real mp4 upload probed + row created,
  re-upload deduped, uploads folder + footageRoot correct, .exe rejected.

### 2026-09-29 — Beat analysis without Python (zero-install)
- Replaced the Python/librosa subprocess with a built-in TypeScript beat
  tracker: new `apps/server/src/musicEdit/beatAnalyzer.ts` (STFT → Slaney-mel
  spectral-flux onset envelope → autocorrelation tempo w/ 120 BPM prior →
  Ellis-style dynamic-programming beat sequence → local-max snap + edge trim).
  Same algorithm family as librosa `onset_strength`/`beat_track`; output JSON
  contract unchanged (`bpm`, `beats[{time,strength}]`, `analyzer`).
- `beatAnalysis.ts` now decodes to raw f32le PCM via `ffmpegService` and calls
  the tracker in-process; cache version bumped to v2. `analyzerStatus()`
  reports `{ok, engine, detail}` (was `{ok, python, detail}`) — ok as long as
  ffmpeg resolves, no interpreter needed.
- Removed `apps/server/python/` (beat_analysis.py, requirements.txt),
  `PYTHON_BIN_PATH`/`pythonBinPath` config (.env.example, schemas.ts,
  config.ts). UI banner no longer prints pip instructions.
- Tests: +3 synthetic-signal cases (120 BPM jittered click track → 120.185 BPM
  detected & beats within 60 ms; 140 BPM off-prior; silence → NO_BEATS_
  DETECTED). Acceptance check updated (`twio.` analyzer name).
- Verified: typecheck ✅ all workspaces; `npm test` 62/62 ✅; E2E `analyzeSong`
  on a generated WAV click track ✅ (~7× realtime, cached afterwards).

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
