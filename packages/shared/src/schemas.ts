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

export const musicEditPlanSchema = z.object({
  song: z.string().min(1).max(255),
  assetIds: z.array(z.string().min(1)).min(1).max(500),
  settings: musicEditSettingsSchema.default({}),
});
export type MusicEditPlanInput = z.infer<typeof musicEditPlanSchema>;
