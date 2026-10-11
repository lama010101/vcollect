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

- **Per-project asset folders:** real asset files live in each project's
  dedicated folder — `OUTPUT_ROOT/<slug>/assets/<query>/` for provider
  downloads and `OUTPUT_ROOT/<slug>/assets/uploads/` for drag & drop files
  (videos AND images — `VIDEO_FILE_EXTENSIONS` + `IMAGE_FILE_EXTENSIONS` in
  config.ts). `local_path` stays relative to `OUTPUT_ROOT` (so
  `<slug>/assets/...`). Build dirs via `projectAssetDir(slug, subdir)`, never
  `OUTPUT_ROOT/<query>` directly (that global layout is legacy;
  `migrateAssetsToProjectFolders` moves old files). Uploads: `POST
  /api/assets/upload?project=<id>&name=` (raw body) → `routes/uploads.ts`
  `saveUploadedFile` → `provider_id='local'` asset row; videos validate via
  ffprobe `isPlayableVideo`, images via `sharp().metadata()` — never trust
  the extension. The frontend drop zone is global in `App.tsx` and fires
  `ASSETS_CHANGED_EVENT` so Folders/Music Edit refresh. **Folder = source of
  truth:** `db/assetSync.ts#syncProjectAssets` + `POST
  /api/assets/sync?project=<id>` register any video or image file found on
  disk inside `<slug>/assets/` that has no DB row — Music Edit's library and
  the Folders page call it before loading, so manually-copied files appear
  everywhere a downloaded asset would. Image assets are kept out of
  video-only surfaces via `isImageFileName(local_path)` (Music Edit source
  library filters them; Folders/Library render `<img>` instead of a player).
  `/api/assets/:id/file` sets Content-Type via `mediaMimeForFile`.

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
  `beatAnalysis.ts` decodes the song via `ffmpegService` to mono f32le PCM and
  runs the **built-in** beat tracker `beatAnalyzer.ts` (STFT → Slaney-mel
  spectral-flux onset envelope → autocorrelation tempo → dynamic-programming
  beat sequence; same algorithm family as librosa, but zero external runtime —
  no Python, nothing to install), caching results by content hash in
  `OUTPUT_ROOT/cache/beats/`. `edl.ts` is the pure, deterministic planner —
  cuts are the detected beat timestamps (`beat[i] → beat[i+N]`), never a BPM
  grid unless `autoBeats` is off. `render.ts` renders one raw H.264 part per
  EDL entry via `ffmpegService`, byte-joins them and muxes the untouched song.
  Routes: `routes/musicEdit.ts` (`/api/music-edit/*`); UI: `pages/MusicEdit.tsx`.
  Errors are `MusicEditError` (status + code). Unit tests:
  `apps/server/test/music-edit.node.test.ts`; real-media acceptance:
  `npm run test:music-edit -w apps/server` with `MUSIC_EDIT_SONG` and
  `MUSIC_EDIT_VIDEOS` (≥4 comma-separated paths).

- **Visualizer (multi-stem waveform renderer):** `apps/server/src/visualizer/`.
  All frame geometry is **pure math in `@twio/shared` (`visualizer.ts`)** —
  `computeFrame(stems, globals, w, h, t)` maps the audio window
  `[⌊(t−w)·r⌋, ⌊t·r⌋]` onto edge→center paths and emits ribbon polygons;
  the Canvas preview (`pages/Visualizer.tsx`) and the server rasterizer draw
  the same computed frame, so export = preview with zero drift (t = k/fps).
  Modes: `ribbons` / `circular` / `particles` (all engine-free) and
  `spectrum` (requires engine band features — the service rejects with
  `ENGINE_REQUIRED` when no stem has `signal.features`). Per-frame SVG →
  `sharp` → raw rgb24 → **ffmpeg stdin pipe** (`ffmpegService.ffmpegSpawn`,
  same single binary path) → libx264, then `amix normalize=0` + `alimiter` →
  AAC 320k. Stems are plain audio files under
  `OUTPUT_ROOT/<slug>/visualizer/stems/` (like Music Edit songs — NOT asset
  rows; audio fails `isPlayableVideo`). Muted stems leave the mix and draw
  at ~15% alpha. `GET /api/visualizer/stems/:name/signal` returns a binary
  `[u32 metaLen][meta JSON][peaks][env][bands][featEnv][onsetEnv]` payload
  the preview decodes into `StemSignal`. Errors are `VisualizerError`.
  Tests: `apps/server/test/visualizer.node.test.ts`.
  `renderSettings.draft` (optional) switches `encodeArgs` to
  `-preset ultrafast -crf 30` and tags the output `viz-draft-…` — the UI's
  "⚡ Draft" button pairs it with ~480px dims + 12 fps for a fast first
  look. `VizRenderProgress.detail` carries human-readable job info (stem
  name / layer N / encode fps) that the UI writes into a rolling log;
  phases weight one shared progress bar client-side
  (`RENDER_PHASE_SPAN`).

  **Layer stack (compositing):** `globalVisuals.video.layers` is a
  bottom→top stack of up to `VIZ_MAX_VIDEO_LAYERS` (10)
  `VizMediaLayerConfig`s — a discriminated union: media rows
  `{kind:"media", assetId, hidden, x, y, opacity, scale, key}` for downloaded videos AND
  images, plus visuals rows `{kind:"visuals", hidden, x, y, opacity, scale, visuals?}`.
  **Several visuals rows may coexist** — each draws its own mode geometry at
  its stack position: `row.visuals` is a complete `VizWaveParams`
  (`vizWaveParamsSchema`: mode + waveformLengthSec + globalAmplitude +
  glowIntensity/autoGlow + autoCenter + innerRadius + layout +
  centerConvergence — i.e. the whole per-row Look control set minus
  background/video/dancer); absent `visuals`, the row inherits the global
  look (what old configs and the default row do). In the UI every ◈ row
  always shows these controls (no separate Look section); the star + dancer
  anchor to `primaryWaveParams(globals)` — the FIRST visuals row's
  effective params — so the center stays editable per-row. **Row
  order is the only z-order** (row N-1 sits under row N) and **only listed
  rows draw** — no `kind:"visuals"` row means no waveforms at all. The UI
  lists the stack **top-first** (row 1 = top layer, like a Layers panel)
  and rows reorder via a **vertical-only drag** (horizontal gestures belong
  to the row's sliders — the li's `draggable` is armed only after the
  pointer moves mostly up/down; the ⠿ grip arms instantly). Any row's
  `hidden` flag (eye toggle in the UI) keeps its slot but draws nothing —
  hidden media rows aren't even validated/decoded on export. The
  dancer + convergence star always ride on top of the stack.
  `x`/`y` (0–1, default 0.5) place the row's center anywhere in the
  frame, and `scale` (0.1–2, default 1) resizes the row about that
  point — the raster is still cover-cropped to frame aspect, so <1 =
  inset, >1 = zoom clipped by the viewBox (visuals rows get a
  `translate(cx cy) scale(s) translate(-w/2 -h/2)` `<g transform>` /
  offscreen-canvas equivalent). Media rows also carry `zoomPan`
  (`vizZoomPanSchema`: zoom 1–16 + panX/panY 0–1 + `animate` flag) —
  WHICH PART of the source fills the tile: `zoomPanRect` shrinks the
  cover-fit window by zoom and slides it across the free slack, so
  defaults reproduce the old centered cover-fit and pan no-ops where
  nothing is hidden. With `animate` on, `zoomPanAt(zp, t, duration)`
  ramps the effect linearly from neutral (zoom 1, centered) at t=0 to
  the configured values at the end of the render — Ken Burns. The
  video decoder crops the rect in native space
  (`fps,crop=w:h:x:y,scale`) using probed ORIENTED dims
  (`probe().rotation` swaps w/h on 90|270); images use
  `sharp().rotate().extract().resize()`; keyed WebMs keep source dims.
  Without dims the decoder falls back to `scale=increase,crop`.
  Animated layers take a different path: the decoder emits NATIVE-res
  frames (`nativeOut` → vf is just `fps[,format=rgba]`) or the image is
  decoded once uncropped, and the frame loop does
  `zoomPanAt → zoomPanRect → sharp.extract().resize()` per frame — the
  same shared math the Canvas preview's drawImage source rect runs, so
  the ramp is pixel-identical between preview and export.
  Every row also carries `visibility` (`vizVisibilitySchema`:
  `{show: [{start,end}], hide: [{start,end}]}` seconds windows) —
  `visibleAt()` evaluates them per t into `state.videoLayers[].visible`;
  show restricts, hide subtracts, both empty = always visible. A row
  draws iff `!hidden && visible`; windowed media keeps decoding (its
  show windows need frames), only manual `hidden` skips the decoder.
  Backwards compatibility on schema parse: a missing `layers` key
  defaults to a lone visuals row (old configs kept waveforms); the legacy
  flat `{assetId, layer, opacity, key/chromaKey}` config folds to
  `[media, visuals]` / `[visuals, media]` per its old under/over band;
  band-model rows (a deprecated `layer` hint on a `layers[]` entry) get a
  visuals row re-inserted at the under/over boundary. New-format lists
  are trusted verbatim. The preview keeps one hidden `<video>`/`<img>`
  per media row index (visuals rows skip it) and the export runs one
  decoder pipe per video row (`sharp` one-shot decode for images; visuals
  rows are aligned no-op placeholders) — both draw the same
  `state.videoLayers` ordering via `modeVisualsSvg`/`drawVisuals`.
  **Per-row channels:** `computeFrame` emits `visualChannels` — one
  `VizModeVisuals` per visuals row (`rowIndex` into `videoLayers`), each
  computed with that row's `visuals ?? globals` params, its own beat center
  (autoCenter is per-row) and its own autoGlow roll (channel-index-salted
  hash, channel 0 = the historic value). The flat `state.stems/rings/…`
  arrays remain = the FIRST row's channel (single-row callers unchanged);
  renderers resolve each row via `visualsForRow(state, i)`. Silk gradient
  ids are namespaced per row (`l<i>_silk<n>`) so stacked silk layers don't
  collide. `VisualizerGlobals` = `vizWaveParamsSchema` + background/video/
  dancer — a superset that drops into any `VizWaveParams` slot
  (`waveParamsFromGlobals` clones it for stamping new rows). The
  ENGINE_REQUIRED gate counts any row whose effective mode is `spectrum`.

  **Layer background removal:** each layer's `key`
  (`VizVideoKeyConfig`) replaces the deprecated `chromaKey` field — old
  configs fold in on schema parse (`enabled → method:"colorkey"`,
  `despill:false`). Methods (`VIZ_KEY_METHODS`): `colorkey` (ffmpeg
  `colorkey` ramp), `chromakey` (`chromaKeyYUVFrame`, a `vf_chromakey`
  port), `hsv` (`hsvKeyFrame`, hue×saturation distance + `choke` matte
  erode/dilate), all dispatched by `keyVideoFrame()` on decoded RGBA —
  the decoder just emits `format=rgba` and the SAME shared function runs in
  the Canvas preview and the export, so pixels are identical by
  construction; keyed frames embed PNG (not JPEG). `cutout` is different:
  `visualizer/keying.ts` asks the engine's `key_video` RPC for a
  content-addressed VP9-alpha WebM under `OUTPUT_ROOT/cache/keys/`
  (`key-<sha1(path+size+mtime+params)>.webm`, in-flight dedupe, sidecar
  progress JSON, abort → worker kill → 499). The preview `<video>` plays
  that WebM directly and the export decodes it with `-c:v libvpx-vp9`
  (the native vp9 decoder drops alpha). Models (Apache-2.0 only, no GPL
  RVM): `mediapipe` (`selfie_segmenter_landscape.tflite` via `cv2.dnn` —
  input MUST be normalized to [-1,1]) and `modnet` (ONNX via
  `onnxruntime`; `cv2.dnn` can't parse its graph). Model files download
  on demand into `OUTPUT_ROOT/cache/models/` with sha256 pinning
  (`twio_engine/models.py`). Routes: `POST/GET /api/visualizer/video-key`,
  `POST .../cancel`. UI params snapshot gates the keyed preview (stale
  params → "regenerate").

- **Procedural dancer (`@twio/shared` `dancer.ts`):** a deterministic
  forward-kinematic 15-joint skeleton rendered as tapered ribbon limbs.
  `computeDancer(stems, cfg, w, h, t, center)` is a pure function of t and
  the stem envelopes/onsets — bass→legs/hips, drums→bounce+step, vocals→
  head/torso, keys/guitar→arms. Enabled per render via
  `globalVisuals.dancer`; styles `neon` (glow strokes) / `silhouette`
  (fills only). The dancer stands at the convergence point and is drawn by
  the same frame state in both Canvas preview and SVG export.

- **Sessions (`visualizer/sessions.ts`):** named, restorable snapshots of
  the whole page state — `visualizerSessionPayloadSchema` (render schema
  minus the ≥1-stem rule) stored as `session.json` under
  `OUTPUT_ROOT/<slug>/visualizer/sessions/<id>/` alongside `stems/` (real
  copies — stem uploads overwrite in place, links would share mutations)
  and `media/` (hardlink→copy snapshots; asset files are immutable).
  `POST /api/visualizer/sessions/:id/load` restores media BEFORE returning
  the payload: differing/missing stems are copied back into the shared
  pool, and deleted layer-asset files are restored under
  `assets/visualizer-sessions/` + re-registered via `syncProjectAssets`
  (layer `assetId`s remap to the content-addressed
  `LOCAL_<project>_<sha16>` id — a restored LOCAL_ asset gets its original
  id back). Unrestorable layers keep their row + return warnings. CRUD:
  `GET/POST sessions`, `GET/PUT/DELETE sessions/:id`. UI: the "Sessions"
  section at the top of `Visualizer.tsx`; load reuses `normalizePersisted`
  (same layer-migration path as the localStorage autosave). Tests:
  `apps/server/test/visualizer-sessions.node.test.ts`.
  `POST sessions/:id/timeline` (`sessionToTimeline`) materializes the
  session as a real timeline + shots (used by the Timeline page's
  "Visualizer session" picker): one shot per layer-stack row under
  `VIZ_STACK` (top layer first), one per stem under `STEMS`, all spanning
  t=0→duration (layers take the probed mix length, stems their own
  duration; fallback = longest media asset then 10 s). Media shots link
  their asset via `shot_assets` (selected + on_rail + `reference_image_url`
  thumb) so the rail/filmstrip shows the right clip; missing assets just
  skip the link — session load (not this route) is what restores media.

- **Python engine (optional, managed):** `apps/server/python/twio_engine/`
  is a persistent NDJSON-RPC worker (stdin/stdout) spawned by
  `src/python/engineClient.ts`. `src/python/pythonService.ts` resolves the
  interpreter as env `PYTHON_BIN_PATH` → managed `.venv` → `py` launcher /
  PATH (Windows Store stubs are rejected by actually running `--version`),
  auto-creates the venv and `pip install -r requirements.txt`s it, stamped
  by a requirements-hash at `apps/server/python/.venv/.deps-stamp`.
  **The server boots fine without Python** — engine features just report
  `ENGINE_UNAVAILABLE`/`ENGINE_DISABLED` (`TWIO_ENGINE_DISABLED=1`).
  Routes: `GET /api/engine/status`, `POST /api/engine/setup` (kicks
  background provisioning), `POST /api/engine/call` (raw RPC diagnostics).
  `visualizer/features.ts` is the consumer: sha256-cached per-stem librosa
  features (tempo, onsets, 6-band envelopes, beats) under
  `OUTPUT_ROOT/cache/engine/`. The built-in TS beat tracker remains the
  primary beat engine — librosa only enriches. Deps: numpy, scipy,
  librosa, soundfile, opencv-python-headless, onnxruntime (MODNet cutout;
  pinned in `requirements.txt`; MoviePy deliberately excluded).
  **Stem separation** (`twio_engine/separate.py`, `separate_stems` RPC):
  `fast` = librosa HPSS+low-band → drums/bass/other (no fake vocals);
  `hq` = demucs `htdemucs` (torch CPU) → +vocals. The demucs/torch extras
  install on demand via `ensureSeparation()` (torch from the pytorch.org
  **CPU** index — PyPI Windows wheels are the ~2.4 GB CUDA build), stamped
  `.venv/.sep-deps-sha256`; routes `POST /api/visualizer/split-stems`
  (raw-body upload → job → stems pool), `GET/POST .../split-jobs/:id`,
  `GET/POST .../sep-status|sep-setup`. Worker error codes are duck-typed
  via `.code` (the worker runs as `__main__` so method modules' EngineError
  is a separate class — never isinstance-check it); `engineClient` teardown
  ignores `close`/`error` from superseded processes.

- **World Cam (InSpatio-World camera-path re-render):** `apps/server/src/world/`
  + `routes/world.ts` (`/api/world/*`); UI: `pages/WorldCam.tsx`. The 1.3B
  video model CANNOT run on this box (GTX 1050 4 GB) — inference happens on a
  remote GPU worker: `scripts/inspatio_worker.py` (FastAPI wrapper around the
  upstream `run_scene_inference.py`, run inside the inspatio conda env) behind
  a cloudflared tunnel — see `docs/inspatio-kaggle-setup.md` (same Kaggle
  pattern as `Kaggle_ComfyUI_Wan21_Reproducible_Setup.md`). Endpoint =
  `INSPATIO_ENDPOINT` (+ optional `INSPATIO_TOKEN` bearer) in `.env.local`, or
  per-session via `PUT /api/world/endpoint` (override wins — tunnel URLs
  rotate). Camera trajectories are **pure math in `@twio/shared`
  (`worldCam.ts`)**: `computeCameraTrajectory(preset,{frames,strength})` emits
  first-frame-normalized OpenCV world→camera 4×4s (frame 0 = identity);
  `serializeTrajectoryTxt` writes the target_tcw.txt format; the UI preview
  and the uploaded file come from the same function. Result `pred.mp4` lands
  in `OUTPUT_ROOT/<slug>/assets/world/` and registers via `syncProjectAssets`
  (`provider_id='local'`). In-memory jobs + AbortController like the
  visualizer; `WorldError` (status + code). Tests:
  `apps/server/test/world-cam.node.test.ts` + `packages/shared/test/worldCam.test.ts`.

## Progress tracking (REQUIRED)

- `docs/progress.md` is the development log for the webapp. **Every change to
  the webapp** — any merged PR, commit, or work session touching `apps/`,
  `packages/`, the DB schema, config, or tooling — MUST add a dated entry to
  its Changelog section before the work is considered done.
- Format: `### YYYY-MM-DD — short title` followed by bullets covering what
  changed, files touched, and verification result.
- Also keep the Feature status and Milestones tables in that file current
  when a change lands a feature or merges a PR.

## Scope guardrails

- P0 + P1 only. No P2 AI vision. No general-purpose video editor (PRD §40) —
  the beat-aligned Music Edit is the only editing feature. No Mixkit scraper
  (PRD §3.3 — manual import only, P3). No rough-cut export (P3).
- P2 DB columns are kept nullable so P2 is additive-only.

## Environment

- Node v24.13.1, npm 11.8.0, Windows, ffmpeg 9.0.1 via scoop.
- System ffmpeg at `C:\Users\User\scoop\shims\ffmpeg.exe`.
- Python 3.13.5 + pip 25.1.1 (for the optional engine; a real interpreter —
  the PATH `python.exe` Store stub is detected and skipped).
