// =============================================================================
// @twio/shared — core domain types & enums (PRD §2, §7, §8, §11)
//
// These are the single source of truth for state / license / risk enums used
// across the server and the web UI. They intentionally use string-literal
// unions (not TS `enum`) so they serialize cleanly to JSON and SQLite TEXT.
// =============================================================================

// --- Asset lifecycle state machine (PRD §8) -----------------------------------
export type AssetState =
  | "DISCOVERED" // just retrieved from a provider search
  | "TECHNICALLY_VALID" // passed the technical filter (§11)
  | "LICENSE_SOURCE_CONFIRMED" // source license confirmed suitable (§2)
  | "AI_REVIEWED" // P2 only — left in the type for forward-compat
  | "HUMAN_REVIEW_REQUIRED" // awaiting a human rights decision
  | "APPROVED_FOR_EDIT" // human KEEP'd it — ready for the edit
  | "RIGHTS_RISK" // a rights risk was identified (§14/§15)
  | "REJECTED"; // hard-rejected at any stage

// --- License status (PRD §2) --------------------------------------------------
export type LicenseStatus =
  | "LICENSE_SOURCE_CONFIRMED"
  | "RIGHTS_REVIEW_REQUIRED"
  | "NOT_APPROVED"
  | "UNKNOWN";

// --- Rights review status (drives the review queue) --------------------------
export type RightsReviewStatus = "OK" | "REVIEW" | "REQUIRED" | "REJECTED";

// --- Risk levels -------------------------------------------------------------
export type RiskLevel = "LOW" | "REVIEW" | "HIGH";

// --- Providers ----------------------------------------------------------------
export type ProviderName = "pexels" | "pixabay" | "mixkit";

// --- Shot lifecycle ----------------------------------------------------------
export type ShotStatus =
  | "SEARCH_PENDING"
  | "SEARCHING"
  | "SEARCHED"
  | "ACQUIRING"
  | "ACQUIRED"
  | "REVIEW"
  | "DONE"
  | "FAILED";

// --- Review actions (PRD §23) ------------------------------------------------
export type ReviewAction =
  | "KEEP" // approve for edit
  | "REJECT" // reject this candidate for this shot
  | "REVIEW_RIGHTS" // flag for rights review
  | "REASSIGN" // move to a different shot
  | "DOWNLOAD" // (re)download the asset
  | "OPEN_SOURCE"; // no state change — UI opens provider URL

// --- Orientation -------------------------------------------------------------
export type Orientation = "landscape" | "portrait" | "square";

// --- Duplicate flags (PRD §16) -----------------------------------------------
export type DuplicateFlag = "NONE" | "EXACT" | "SAME_SOURCE" | "NEAR_DUPLICATE";

// --- Aspect flag -------------------------------------------------------------
export type AspectFlag = "STANDARD" | "NON_STANDARD_ASPECT";

// =============================================================================
// Normalized candidate produced by a provider search. Provider-specific
// responses are mapped into this shape so the rest of the pipeline is
// provider-agnostic.
// =============================================================================
export interface AssetCandidate {
  provider: ProviderName;
  providerAssetId: string;
  providerUrl: string; // human-facing page on the source site
  downloadUrl: string; // direct media URL we will fetch
  title: string | null;
  creatorName: string | null;
  creatorUrl: string | null;
  width: number;
  height: number;
  durationSeconds: number;
  fps: number | null;
  thumbnailUrl: string | null;
  sourceLicense: string | null;
  licenseUrl: string | null;
  tags: string[];
}

// =============================================================================
// Provider search options (PRD §3.1 / §3.2)
// =============================================================================
export interface SearchOptions {
  orientation?: Orientation;
  minWidth?: number;
  minHeight?: number;
  perPage?: number; // default 30 (PRD §10)
  page?: number;
}

// =============================================================================
// Scoring breakdown (PRD §12, §13, §17, §19)
// =============================================================================
export interface ScoreBreakdown {
  technicalScore: number;
  relevanceScore: number; // P1 heuristic; P2 will populate semanticScore
  diversityScore: number;
  actionMatchScore: number; // P1 verb/tag heuristic; P2 placeholder
  visualQualityScore: number;
  licensingConfidence: number;
  finalScore: number;
}

// P2-ready sub-scores (kept null in P0+P1 — PRD §13 shape)
export interface SemanticScores {
  subjectMatch: number | null;
  actionMatch: number | null;
  environmentMatch: number | null;
  emotionMatch: number | null;
  semanticScore: number | null;
  visionStatus: "NOT_RUN" | "RUNNING" | "DONE" | "FAILED";
}

// =============================================================================
// Projects — a user-created project that scopes a set of shots, timelines,
// assets, and an on-disk output subfolder. The virtual id PROJECT_ID_ALL
// aggregates every project's data (never stored as a row).
// =============================================================================
export interface Project {
  id: string; // slug-style id; "__ALL__" for the virtual aggregate
  name: string;
  slug: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  isVirtual?: boolean; // true only for the "__ALL__" aggregate
  // Per-project acquisition settings (null = not set; enforce* = true means
  // the project value overrides any per-shot override for that setting).
  acquireCount?: number | null; // Y — max candidates to download per shot
  enforceAcquireCount?: boolean;
  minCandidates?: number | null; // X — minimum candidate pool size
  enforceMinCandidates?: boolean;
  minAcquireRating?: number | null; // Z — finalScore threshold (0..1)
  enforceMinAcquireRating?: boolean;
  candidatesPerProvider?: number | null; // perPage per provider per query
}

// =============================================================================
// Music edit — beat analysis + edit decision list (EDL)
// =============================================================================
export interface BeatPoint {
  time: number; // seconds from the start of the song, as detected
  strength: number | null; // normalised onset strength at the beat (0..1)
}

export interface BeatAnalysis {
  bpm: number; // tempo estimate from the analyzer
  duration: number; // decoded song duration (seconds)
  beats: BeatPoint[];
  downbeats: number[] | null; // null = analyzer does not detect bars
  analyzer: { name: string; version: string; sampleRate: number; hopLength: number };
  /** Inter-beat-interval stats — shows how far the song deviates from a grid. */
  interval: { min: number; max: number; mean: number; stdDev: number };
}

export type EdlBoundaryKind = "audio_start" | "beat" | "bar" | "stem_onset" | "section" | "adaptive" | "manual_grid" | "audio_end";

/** Where an EDL's inner cut marks came from (cut-grid feature). */
export type CutGridSource = "beats" | "every_n_beats" | "bars" | "stem_onsets" | "sections" | "adaptive";

/** One precomputed inner cut mark handed to the EDL planner. */
export interface CutMark {
  time: number; // seconds on the song timeline
  beat: number | null; // index into BeatAnalysis.beats, when beat-aligned
  kind: EdlBoundaryKind;
}

/** Grid provenance stamped onto a plan built with a cut-grid spec. */
export interface EditPlanGrid {
  source: CutGridSource;
  label: string; // human-readable, e.g. "Bar starts (4/4)"
  detail?: string; // params summary, e.g. "phase: beat 1 of each bar (auto)"
  cutCount: number; // inner cut marks that survived merging
}

/** Intercut (storylines) provenance stamped onto a plan. */
export interface EditPlanIntercut {
  slotsPerSlice: number; // consecutive cut slots one storyline holds
  endOfMaterial: "loop" | "retire";
  rotation: "roundRobin";
  storylines: Array<{ id: string; name: string; clips: number; segments: number }>;
  /** Slots shorter than 100 ms — likely too dense a cut grid for intercut. */
  shortSlots: number;
}

export interface EdlEntry {
  index: number;
  sourceId: string;
  source: string; // display label / file name
  sourceStart: number; // seconds in the source
  sourceEnd: number; // seconds in the source (< sourceStart when looped)
  sourceConsumed: number; // seconds of source footage used
  sourceLoops: number; // times the source wrapped to 0 inside this clip
  /** Contiguous source ranges read for this clip, in order (>1 only when looped). */
  pieces: Array<{ start: number; end: number }>;
  speed: number; // sourceConsumed / outputDuration (>1 = faster)
  outputStart: number; // seconds in the song — a detected beat (or 0)
  outputEnd: number;
  outputDuration: number;
  frameStart: number;
  frameEnd: number;
  startBeat: number | null; // index into analysis.beats
  endBeat: number | null;
  startKind: EdlBoundaryKind;
  endKind: EdlBoundaryKind;
  restartedSource: boolean; // cursor wrapped back to 0 before this clip
  /** Intercut mode only — which storyline this segment belongs to. */
  storylineId?: string;
  storylineName?: string;
  /** How many times the storyline has restarted before this segment (0 = first pass). */
  storylineLoop?: number;
  /** alignMotion only — seconds the in-point was shifted to land a motion
   *  peak on the cut (positive = later, negative = earlier). */
  motionShift?: number;
}

export interface EditPlanStats {
  segmentCount: number;
  averageClipDuration: number;
  minClipDuration: number;
  maxClipDuration: number;
  retimedCount: number;
  loopedCount: number;
  minSpeed: number;
  maxSpeed: number;
  sourceUsage: Record<string, number>;
}

export interface EditPlan {
  version: 1;
  timing: "detected_beats" | "manual_grid" | "cut_grid";
  /** Present only when the request carried a cut-grid spec. */
  grid?: EditPlanGrid;
  /** Present only in intercut (storylines) mode. */
  intercut?: EditPlanIntercut;
  beatsPerCut: number;
  bpm: number;
  beatCount: number;
  audioDuration: number;
  /** Seconds of rendered video. Equal to audioDuration unless the plan ended
   *  early because non-looped source material ran out (loopSource off, or
   *  intercut endOfMaterial "retire" with all storylines exhausted). */
  videoDuration?: number;
  fps: number;
  width: number;
  height: number;
  totalFrames: number;
  entries: EdlEntry[];
  stats: EditPlanStats;
}
