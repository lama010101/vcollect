// =============================================================================
// @twio/shared — Zod schemas for runtime validation (config, API I/O)
// =============================================================================

import { z } from "zod";

// --- Enums mirrored from types.ts (validated at the API boundary) ------------
export const assetStateSchema = z.enum([
  "DISCOVERED",
  "TECHNICALLY_VALID",
  "LICENSE_SOURCE_CONFIRMED",
  "AI_REVIEWED",
  "HUMAN_REVIEW_REQUIRED",
  "APPROVED_FOR_EDIT",
  "RIGHTS_RISK",
  "REJECTED",
]);

export const licenseStatusSchema = z.enum([
  "LICENSE_SOURCE_CONFIRMED",
  "RIGHTS_REVIEW_REQUIRED",
  "NOT_APPROVED",
  "UNKNOWN",
]);

export const rightsReviewStatusSchema = z.enum(["OK", "REVIEW", "REQUIRED", "REJECTED"]);
export const riskLevelSchema = z.enum(["LOW", "REVIEW", "HIGH"]);
export const providerNameSchema = z.enum(["pexels", "pixabay", "mixkit"]);
export const orientationSchema = z.enum(["landscape", "portrait", "square"]);
export const reviewActionSchema = z.enum([
  "KEEP",
  "REJECT",
  "REVIEW_RIGHTS",
  "REASSIGN",
  "DOWNLOAD",
  "OPEN_SOURCE",
]);
export const duplicateFlagSchema = z.enum(["NONE", "EXACT", "SAME_SOURCE", "NEAR_DUPLICATE"]);
export const aspectFlagSchema = z.enum(["STANDARD", "NON_STANDARD_ASPECT"]);

// --- App configuration (loaded from env / .env) ------------------------------
export const appConfigSchema = z.object({
  pexelsApiKey: z.string().default(""),
  pixabayApiKey: z.string().default(""),
  visionApiKey: z.string().default(""),
  visionApiProvider: z.string().default("openai"),
  // LLM for script parsing (optional). Supports "ollama" (local, free, no key)
  // and "groq" (online, free key from console.groq.com). Empty = LLM disabled.
  llmProvider: z.string().default(""),
  llmApiKey: z.string().default(""),
  llmBaseUrl: z.string().default(""),
  llmModel: z.string().default(""),
  // World Cam remote worker (scripts/inspatio_worker.py on a GPU host, fronted
  // by a cloudflared tunnel — see docs/inspatio-kaggle-setup.md). Empty =
  // World Cam disabled. The token is an optional shared bearer secret.
  inspatioEndpoint: z.string().default(""),
  inspatioToken: z.string().default(""),
  port: z.number().int().positive().default(3001),
  host: z.string().default("127.0.0.1"),
  ffmpegBinPath: z.string().default(""),
  ffprobeBinPath: z.string().default(""),
  // Python engine (apps/server/python/twio_engine): leave empty to use the
  // managed .venv, which is auto-created + pip-installed on first use. Set to
  // bypass the venv (interpreter must already have requirements installed).
  pythonBinPath: z.string().default(""),
  // TWIO_ENGINE_DISABLED=1 → every engine feature reports ENGINE_DISABLED.
  engineDisabled: z.boolean().default(false),
  outputDir: z.string().default("THE_WORLD_IS_OURS"),
  maxDownloadMb: z.number().int().positive().default(600),
  candidatesPerProvider: z.number().int().positive().max(80).default(30),
  topNPerShot: z.number().int().positive().max(20).default(5),
  phashHammingThreshold: z.number().int().nonnegative().default(8),
  searchCacheTtlMin: z.number().int().positive().default(60),
});
export type AppConfig = z.infer<typeof appConfigSchema>;

// --- Provider search options (API request body) ------------------------------
export const searchOptionsSchema = z.object({
  orientation: orientationSchema.optional(),
  minWidth: z.number().int().positive().optional(),
  minHeight: z.number().int().positive().optional(),
  perPage: z.number().int().positive().max(80).optional(),
  page: z.number().int().positive().optional(),
});

// --- Provider candidate (mirrors the AssetCandidate interface in types.ts) ---
// Validates candidates posted back by the client (e.g. POST /api/providers/acquire).
export const assetCandidateSchema = z.object({
  provider: providerNameSchema,
  providerAssetId: z.string(),
  providerUrl: z.string(),
  downloadUrl: z.string(),
  title: z.string().nullable(),
  creatorName: z.string().nullable(),
  creatorUrl: z.string().nullable(),
  width: z.number(),
  height: z.number(),
  durationSeconds: z.number(),
  fps: z.number().nullable(),
  thumbnailUrl: z.string().nullable(),
  sourceLicense: z.string().nullable(),
  licenseUrl: z.string().nullable(),
  tags: z.array(z.string()),
});
export type AssetCandidateInput = z.infer<typeof assetCandidateSchema>;

// --- Review request body (PRD §23) -------------------------------------------
export const reviewRequestSchema = z.object({
  action: reviewActionSchema,
  notes: z.string().max(2000).optional(),
  reassignToShotId: z.string().optional(), // required when action === REASSIGN
  licenseVerified: z.boolean().optional(),
  commercialUseConfirmed: z.boolean().optional(),
  peopleReviewed: z.boolean().optional(),
  trademarkReviewed: z.boolean().optional(),
  logoReviewed: z.boolean().optional(),
});
export type ReviewRequest = z.infer<typeof reviewRequestSchema>;

// --- Projects (multi-project support) ----------------------------------------
export const createProjectSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  // Per-project acquisition settings. All optional; null clears the value.
  acquireCount: z.number().int().min(1).max(20).nullable().optional(),
  enforceAcquireCount: z.boolean().optional(),
  minCandidates: z.number().int().min(1).max(100).nullable().optional(),
  enforceMinCandidates: z.boolean().optional(),
  minAcquireRating: z.number().min(0).max(1).nullable().optional(),
  enforceMinAcquireRating: z.boolean().optional(),
  candidatesPerProvider: z.number().int().min(1).max(50).nullable().optional(),
});
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

// --- Shot creation (manual add-shot form) ------------------------------------
export const createShotSchema = z.object({
  projectId: z.string().min(1),
  section: z.string().min(1).max(120),
  searchQuery: z.string().min(1).max(500),
  visualDescription: z.string().min(1).max(500),
  targetDurationSeconds: z.number().positive().max(600).optional(),
  priority: z.number().int().min(1).max(10).optional(),
  lyrics: z.string().max(2000).optional(),
  referenceImageUrl: z.string().url().max(2000).optional(),
});
export type CreateShotInput = z.infer<typeof createShotSchema>;

// --- Script import (bulk shot + timeline creation from text) -----------------
export const importScriptSchema = z.object({
  script: z.string().min(1).max(200000),
  timelineName: z.string().min(1).max(120).optional(),
  replace: z.boolean().default(false),
  useLlm: z.boolean().default(false),
});
export type ImportScriptInput = z.infer<typeof importScriptSchema>;

// --- Music edit (beat-aligned music-video editor) ----------------------------
export const beatsPerCutSchema = z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]);

// Where the EDL's inner cut marks come from. Absent = legacy behaviour
// (settings.autoBeats / beatsPerCut / beatOffset, or the manual BPM grid).
export const cutGridSchema = z.discriminatedUnion("source", [
  // Every detected beat.
  z.object({ source: z.literal("beats") }),
  // Every N detected beats starting from beat `offset` (0 = first beat).
  z.object({
    source: z.literal("every_n_beats"),
    n: z.number().int().min(1).max(16).default(1),
    offset: z.number().int().min(0).max(31).default(0),
  }),
  // Bar starts. beatsPerBar 4 = 4/4 (default), 3 = 3/4. `phase` is the
  // 0-based beat index inside each bar that starts it — omitted = picked
  // automatically as the phase with the highest summed onset strength.
  z.object({
    source: z.literal("bars"),
    beatsPerBar: z.union([z.literal(3), z.literal(4)]).default(4),
    phase: z.number().int().min(0).max(31).optional(),
  }),
  // Onsets of a stem from the project's visualizer stem pool. `band` picks
  // the analysed frequency range (kick = low band ≈ <150 Hz, snare_hat =
  // higher band — meant for the drums stem but valid for any stem).
  z.object({
    source: z.literal("stem_onsets"),
    stem: z.string().min(1).max(255),
    band: z.enum(["full", "kick", "snare_hat"]).default("full"),
    minGap: z.number().min(0.05).max(2).default(0.25),
    threshold: z.number().min(0).max(1).default(0.12),
  }),
  // Energy-section-aware density: the song is segmented by RMS energy and
  // each section class gets its own beats-per-cut. Omitted densities fall
  // back to the auto mapping quiet→4, medium→2, loud→1.
  z.object({
    source: z.literal("sections"),
    quietEvery: beatsPerCutSchema.optional(),
    mediumEvery: beatsPerCutSchema.optional(),
    loudEvery: beatsPerCutSchema.optional(),
  }),
]);
export type CutGridSpec = z.infer<typeof cutGridSchema>;

// --- Intercut (parallel storylines) ------------------------------------------
// A storyline is an ordered list of source clips played as one continuous
// thread; the EDL rotates between storylines every `slotsPerSlice` cut slots.
export const musicEditIntercutSchema = z.object({
  slotsPerSlice: z.number().int().min(1).max(16).default(1),
  endOfMaterial: z.enum(["loop", "retire"]).default("loop"),
  rotation: z.enum(["roundRobin"]).default("roundRobin"),
  storylines: z
    .array(
      z.object({
        name: z.string().max(120).optional(),
        assetIds: z.array(z.string().min(1)).min(1).max(500),
      }),
    )
    .min(1)
    .max(32),
});
export type MusicEditIntercut = z.infer<typeof musicEditIntercutSchema>;

export const musicEditSettingsSchema = z.object({
  // true = cut on beats detected in the waveform; false = manual BPM grid.
  autoBeats: z.boolean().default(true),
  beatsPerCut: beatsPerCutSchema.default(2),
  // Skip this many detected beats before the first beat-grouped cut
  // (shifts the phase of 2/4/8-beat groups).
  beatOffset: z.number().int().min(0).max(7).default(0),
  // Manual grid — only used when autoBeats is false.
  manualBpm: z.number().min(20).max(300).optional(),
  manualOffsetSeconds: z.number().min(0).max(600).default(0),
  maxSpeedUp: z.number().min(1).max(4).default(1.25),
  maxSlowDown: z.number().min(0.25).max(1).default(0.8),
  // Permit retiming beyond the limits when no source fits (off by default).
  allowExtremeRetime: z.boolean().default(false),
  // Motion-peak alignment (VIDEO-BEAT-03): shift each segment's in-point so a
  // detected motion peak lands on the cut. Off = byte-identical behaviour.
  alignMotion: z.boolean().default(false),
  motionWindow: z.number().min(0.05).max(2).default(0.5), // ±s search around cursor
  motionLead: z.number().min(-0.5).max(0.5).default(0), // peak lands this many s after in-point
  loopSource: z.boolean().default(false),
  fps: z.number().int().min(12).max(60).default(30),
  // Output height cap; never exceeds the tallest source (no upscaling).
  maxOutputHeight: z.number().int().min(240).max(2160).default(1080),
  aspect: z.enum(["16:9", "9:16", "1:1"]).default("16:9"),
});
export type MusicEditSettings = z.infer<typeof musicEditSettingsSchema>;

export const musicEditAnalyzeSchema = z.object({
  song: z.string().min(1).max(255),
});

export const musicEditPlanSchema = z
  .object({
    song: z.string().min(1).max(255),
    assetIds: z.array(z.string().min(1)).max(500).default([]),
    settings: musicEditSettingsSchema.default({}),
    grid: cutGridSchema.optional(),
    intercut: musicEditIntercutSchema.optional(),
  })
  // Sources come from either the flat assetIds list or the intercut
  // storylines (the UI still sends the union in assetIds for readability).
  .refine((v) => v.assetIds.length > 0 || (v.intercut?.storylines.length ?? 0) > 0, {
    message: "Provide assetIds or intercut.storylines.",
  });
export type MusicEditPlanInput = z.infer<typeof musicEditPlanSchema>;

/** POST /api/music-edit/import-session — reuse a saved 4D-timeline session:
 *  its media-layer videos become the ordered source list and its stems are
 *  copied into the project's songs pool. */
export const musicEditImportSessionSchema = z.object({
  sessionId: z.string().min(1).max(64),
});

// --- Format (aspect-ratio reframe) --------------------------------------------
export const formatAspectSchema = z.enum(["16:9", "9:16", "1:1"]);
export type FormatAspect = z.infer<typeof formatAspectSchema>;

export const formatConvertSchema = z.object({
  assetId: z.string().min(1).max(64),
  aspect: formatAspectSchema,
  /** Optional trim window in seconds — export only [start, end). */
  start: z.number().min(0).optional(),
  end: z.number().gt(0).optional(),
});
