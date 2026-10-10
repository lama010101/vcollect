// =============================================================================
// @twio/shared — multi-stem audio visualizer: types, schemas & frame math
//
// Everything in this module is PURE and DETERMINISTIC: the visual state at
// frame k is a function of t_k = k / fps only. The browser Canvas preview and
// the server-side SVG→sharp rasterizer both consume computeFrame(), so an
// exported MP4 matches what the preview showed — frame-accurate by
// construction (no clocks, no drift).
// =============================================================================

import { z } from "zod";

// --- Stems -------------------------------------------------------------------

export const STEM_KINDS = ["vocal", "drums", "bass", "keys", "guitar", "fx", "other"] as const;
export type StemKind = (typeof STEM_KINDS)[number];

export interface StemKindDefaults {
  amplitudeScale: number;
  glowRadius: number;
  lineThickness: number;
  color: string;
}

/** Per-kind visual defaults (PRD-style spec: drums peak-exaggerated + flash,
 *  bass soft/wide, vocals smoothed, keys harmonic lines, guitar/fx shimmer). */
export const STEM_KIND_DEFAULTS: Record<StemKind, StemKindDefaults> = {
  vocal: { amplitudeScale: 1.0, glowRadius: 10, lineThickness: 3, color: "#FF3366" },
  drums: { amplitudeScale: 1.8, glowRadius: 15, lineThickness: 4, color: "#33CCFF" },
  bass: { amplitudeScale: 1.4, glowRadius: 25, lineThickness: 5, color: "#33FF66" },
  keys: { amplitudeScale: 1.1, glowRadius: 12, lineThickness: 3, color: "#FFCC00" },
  guitar: { amplitudeScale: 1.0, glowRadius: 14, lineThickness: 3, color: "#FF8844" },
  fx: { amplitudeScale: 1.0, glowRadius: 14, lineThickness: 3, color: "#B366FF" },
  other: { amplitudeScale: 1.0, glowRadius: 12, lineThickness: 3, color: "#66CCDD" },
};

/** Fallback palette for stems that don't match a keyword. */
export const STEM_PALETTE = ["#FF3366", "#33CCFF", "#33FF66", "#FFCC00", "#FF8844", "#B366FF", "#66CCDD", "#FF66AA"];

const KIND_KEYWORDS: Array<[StemKind, RegExp]> = [
  ["vocal", /vocal|vox|lead[\s_-]?vox|voice|sing/i],
  ["drums", /drum|perc|kick|snare|hat|tom|beat/i],
  ["bass", /bass|sub|808/i],
  ["keys", /key|synth|piano|organ|rhodes/i],
  ["guitar", /gtr|guitar|acoustic|electric/i],
  ["fx", /fx|amb|pad|atmo|riser|sweep|noise|sfx/i],
];

/** Guess a stem kind from its filename. */
export function detectStemKind(filename: string): StemKind {
  const base = filename.replace(/\.[^.]+$/, "");
  for (const [kind, re] of KIND_KEYWORDS) if (re.test(base)) return kind;
  return "other";
}

// --- API schemas --------------------------------------------------------------

export const stemKindSchema = z.enum(STEM_KINDS);
export const vizLayoutSchema = z.enum(["radial", "speakers", "fan", "vertical"]);
export type VizLayout = z.infer<typeof vizLayoutSchema>;

/** Render mode for the stem visuals. `ribbons` is the original converging-
 *  waveform look; `spectrum` needs engine features (band envelopes);
 *  `mirror`/`blocks`/`eqbars` are the horizontal mirrored-axis styles;
 *  `eqradial` is the same LED-column look bent around the center point;
 *  `silk` is the stacked mirrored waveform strands with a spectral hue
 *  sweep (the dual glowing waveform reference). */
export const vizModeSchema = z.enum(["ribbons", "circular", "spectrum", "particles", "mirror", "blocks", "eqbars", "eqradial", "stereo", "silk"]);
export type VizMode = z.infer<typeof vizModeSchema>;

export const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected #RRGGBB");

/** Procedural dancer overlay — a deterministic FK skeleton whose motion is a
 *  pure function of t and the stem signals/features. */
export const dancerConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** neon = glowing strokes; silhouette = flat filled limbs. */
  style: z.enum(["neon", "silhouette"]).default("neon"),
  scale: z.number().min(0.3).max(2).default(1),
  /** Global motion amplitude multiplier. */
  intensity: z.number().min(0).max(2).default(1),
  /** fixed = dancer.color; stems = limbs tinted by their driving stem. */
  colorMode: z.enum(["fixed", "stems"]).default("stems"),
  color: hexColorSchema.default("#FFFFFF"),
});
export type DancerConfig = z.infer<typeof dancerConfigSchema>;

/** Placement of the optional video layer relative to the mode visuals. */
export const vizVideoLayerSchema = z.enum(["under", "over"]);
export type VizVideoLayer = z.infer<typeof vizVideoLayerSchema>;

/** Chroma-key: make a flat monochrome background in the video transparent so
 *  whatever sits behind the layer shows through. Semantics mirror ffmpeg's
 *  `colorkey` filter — a pixel goes transparent when its normalized RGB
 *  distance to `color` is under `similarity`, with a linear feather ramp of
 *  half-width `blend` around the threshold (same ramp `chromaKeyFrame`
 *  applies in the browser preview).
 *  @deprecated legacy wire format — folded into `vizVideoKeySchema` on parse. */
export const vizChromaKeySchema = z.object({
  enabled: z.boolean().default(false),
  /** #RRGGBB flat background color to remove. */
  color: hexColorSchema.default("#00FF00"),
  /** Normalized RGB distance threshold, 0..1. */
  similarity: z.number().min(0).max(1).default(0.12),
  /** Edge feather half-width, 0..0.5. */
  blend: z.number().min(0).max(0.5).default(0.02),
});
export type VizChromaKeyConfig = z.infer<typeof vizChromaKeySchema>;

/** Background-removal methods for the video layer:
 *  - `none`      — video drawn as-is;
 *  - `colorkey`  — RGB-distance key, byte-compatible with ffmpeg `colorkey`
 *    (the original implementation);
 *  - `chromakey` — YUV chroma key, a port of ffmpeg `vf_chromakey` (3×3
 *    half-res chroma neighbourhood + similarity/blend alpha ramp) plus a
 *    `vf_despill`-style spill suppression generalized to the key's dominant
 *    channel;
 *  - `hsv`       — custom keyer: circular hue distance weighted by the
 *    pixel's own saturation (greys/whites never key), choke erodes/dilates
 *    the alpha edge, despill clamps the dominant channel;
 *  - `cutout`    — AI person matting; the Python engine bakes a matte into a
 *    cached VP9-alpha WebM (`visualizer/keys/*.webm`) that both renderers
 *    consume directly — the alpha rides the pixels, so no in-frame keying
 *    pass runs for this method.
 *  All color methods run the shared per-pixel functions on the decoded RGBA
 *  frame in BOTH renderers → preview and MP4 are pixel-identical by
 *  construction. */
export const VIZ_KEY_METHODS = ["none", "colorkey", "chromakey", "hsv", "cutout"] as const;
export const vizKeyMethodSchema = z.enum(VIZ_KEY_METHODS);
export type VizKeyMethod = z.infer<typeof vizKeyMethodSchema>;

/** Engine matting models for `cutout` — Apache-2.0 only (no GPL RVM). */
export const VIZ_CUTOUT_MODELS = ["mediapipe", "modnet"] as const;
export const vizCutoutModelSchema = z.enum(VIZ_CUTOUT_MODELS);
export type VizCutoutModel = z.infer<typeof vizCutoutModelSchema>;

/** Methods that key the live frame pixels in-process (no engine artifact). */
export const VIZ_JS_KEY_METHODS: ReadonlySet<VizKeyMethod> = new Set(["colorkey", "chromakey", "hsv"]);

export const vizVideoKeySchema = z.object({
  method: vizKeyMethodSchema.default("none"),
  /** #RRGGBB key color (color methods only). */
  color: hexColorSchema.default("#00FF00"),
  /** Normalized distance threshold, 0..1 (scale depends on method). */
  similarity: z.number().min(0).max(1).default(0.12),
  /** Edge feather width for the color keyers, 0..0.5. */
  blend: z.number().min(0).max(0.5).default(0.02),
  /** Suppress key-color spill on the surviving foreground. */
  despill: z.boolean().default(true),
  /** `hsv` only: shrink (negative) / grow (positive) the matte edge, px. */
  choke: z.number().min(-8).max(8).default(0),
  /** `cutout` only: which engine model produces the matte. */
  model: vizCutoutModelSchema.default("mediapipe"),
  /** `cutout` only: gaussian blur radius applied to the matte edge, px. */
  feather: z.number().min(0).max(10).default(1),
});
export type VizVideoKeyConfig = z.infer<typeof vizVideoKeySchema>;

/** Fold a deprecated `chromaKey` field into `key` (old configs had no despill
 *  in the colorkey path, so legacy folds with `despill:false` to keep renders
 *  identical). Shared by the single-video legacy shape and each layer row. */
function foldChromaKey<T extends { chromaKey?: VizChromaKeyConfig; key: VizVideoKeyConfig }>(v: T): Omit<T, "chromaKey"> {
  const { chromaKey, ...rest } = v;
  let { key } = rest;
  if (key.method === "none" && chromaKey) {
    key = {
      ...key,
      method: chromaKey.enabled ? "colorkey" : "none",
      color: chromaKey.color,
      similarity: chromaKey.similarity,
      blend: chromaKey.blend,
      // The legacy colorkey path had no despill — keep old configs identical.
      despill: false,
    };
  }
  return { ...rest, key };
}

/** The per-visual parameter set — mode + its knobs. `VisualizerGlobals`
 *  embeds these fields as the base look; a `kind:"visuals"` layer row may
 *  also carry its own complete copy (`visuals`), so several waveform layers
 *  can stack with different modes and settings. */
export const vizWaveParamsSchema = z.object({
  mode: vizModeSchema.default("ribbons"),
  waveformLengthSec: z.number().min(0.1).max(2).default(0.5),
  globalAmplitude: z.number().min(0.1).max(3).default(1),
  glowIntensity: z.number().min(0).max(40).default(14),
  /** Beat-randomized glow: when enabled, `glowIntensity` is overridden per
   *  beat cell by a deterministic hash → random value in [min,max]. */
  autoGlow: z
    .object({
      enabled: z.boolean().default(false),
      min: z.number().min(0).max(40).default(4),
      max: z.number().min(0).max(40).default(24),
    })
    .default({}),
  /** Beat-synced wandering center: when enabled, `centerConvergence.x/y`
   *  are overridden by a deterministic per-beat position that eases toward
   *  a new spot at every beat. */
  autoCenter: z
    .object({
      enabled: z.boolean().default(false),
      /** Max deviation from the frame midpoint, fraction of the axis (0..0.35). */
      range: z.number().min(0).max(0.35).default(0.18),
    })
    .default({}),
  /** `eqradial` hub radius as a fraction of min(w,h); 0 = bars start at
   *  the exact center point. */
  innerRadius: z.number().min(0).max(0.5).default(0.12),
  layout: vizLayoutSchema.default("radial"),
  centerConvergence: z
    .object({
      x: z.number().min(0).max(1).default(0.5),
      y: z.number().min(0).max(1).default(0.5),
      pulseSensitivity: z.number().min(0).max(2).default(0.8),
    })
    .default({}),
});
export type VizWaveParams = z.infer<typeof vizWaveParamsSchema>;

/** A wave-params object's own standalone copy — used to stamp a waveform
 *  layer with the current settings so it can be tweaked independently.
 *  `VisualizerGlobals` is a superset and drops in directly. */
export function waveParamsFromGlobals(g: VizWaveParams): VizWaveParams {
  return {
    mode: g.mode,
    waveformLengthSec: g.waveformLengthSec,
    globalAmplitude: g.globalAmplitude,
    glowIntensity: g.glowIntensity,
    autoGlow: { ...g.autoGlow },
    autoCenter: { ...g.autoCenter },
    innerRadius: g.innerRadius,
    layout: g.layout,
    centerConvergence: { ...g.centerConvergence },
  };
}

/** A [start,end) window in seconds over the mix timeline — several per layer. */
export const vizTimeWindowSchema = z
  .object({
    /** Seconds from mix start (≥0). */
    start: z.number().min(0),
    /** Seconds — must be > start. */
    end: z.number().min(0),
  })
  .refine((w) => w.end > w.start, { message: "end must be > start" });
export type VizTimeWindow = z.infer<typeof vizTimeWindowSchema>;

/** When a row draws: `show` non-empty restricts it to those windows; `hide`
 *  windows always subtract time. Both empty = always visible (default). */
export const vizVisibilitySchema = z.object({
  show: z.array(vizTimeWindowSchema).max(32).default([]),
  hide: z.array(vizTimeWindowSchema).max(32).default([]),
});
export type VizVisibilityConfig = z.infer<typeof vizVisibilitySchema>;

/** Whether a row draws at time t — inside a `show` window when the list is
 *  non-empty, and never inside a `hide` window. */
export function visibleAt(v: VizVisibilityConfig | undefined, t: number): boolean {
  if (!v) return true;
  if (v.hide.some((w) => t >= w.start && t < w.end)) return false;
  return v.show.length === 0 || v.show.some((w) => t >= w.start && t < w.end);
}

/** Per-layer zoom/pan — WHICH PART of the source media fills the layer's
 *  frame-rect (independent of the row's `scale`/`x`/`y`, which move the whole
 *  tile). The crop window is the cover-fit window shrunk by `zoom` (≥1) and
 *  slid to the `pan` focus point inside the media: pan only travels where
 *  there is hidden source (aspect slack at zoom 1, everywhere when zoomed). */
export const vizZoomPanSchema = z.object({
  /** Magnification into the source — 1 = cover-fit (default), 2 = half the
   *  window (8× zoom range for extreme crops). */
  zoom: z.number().min(1).max(16).default(1),
  /** Focus point the crop window tracks — 0 = far edge, 0.5 = centered
   *  (default), 1 = near edge; clamped so the window stays inside the media. */
  panX: z.number().min(0).max(1).default(0.5),
  panY: z.number().min(0).max(1).default(0.5),
});
export type VizZoomPanConfig = z.infer<typeof vizZoomPanSchema>;

/** Source subrect for a media layer's zoom/pan — the cover-fit window shrunk
 *  by `zoom` around its center, then slid so its center sits at `pan` of the
 *  FREE slack (0 = left/top edge, 0.5 = centered → identical to coverCrop,
 *  1 = right/bottom edge). Windows with no slack in a dimension clamp to the
 *  media edge — pan is a no-op exactly where there's nothing hidden. */
export function zoomPanRect(
  mediaW: number,
  mediaH: number,
  frameW: number,
  frameH: number,
  zp: Pick<VizZoomPanConfig, "zoom" | "panX" | "panY">,
): { sx: number; sy: number; sw: number; sh: number } {
  const [, , cw0, ch0] = coverCrop(mediaW, mediaH, frameW, frameH);
  const z = Math.max(1, zp.zoom);
  const sw = Math.min(mediaW, cw0 / z);
  const sh = Math.min(mediaH, ch0 / z);
  return {
    sx: zp.panX * Math.max(0, mediaW - sw),
    sy: zp.panY * Math.max(0, mediaH - sh),
    sw,
    sh,
  };
}

/** One media layer: a downloaded project asset (video or image) composited
 *  into every frame at its row position — row N-1 renders under row N (row
 *  order is the only z-order). Video sources loop when shorter than the mix
 *  and every layer is cover-cropped to the frame. `layer` is a deprecated
 *  band hint kept so the `vizVideoSchema` transform can restore the visuals
 *  row at the old under/over boundary; renderers ignore it. */
const vizMediaAssetLayerSchema = z
  .object({
    kind: z.literal("media").default("media"),
    /** Id of a project asset with a downloaded local file. */
    assetId: z.string().min(1).max(64),
    /** @deprecated under/over band hint — see vizVideoSchema. */
    layer: vizVideoLayerSchema.optional(),
    /** Hidden rows keep their config + stack position but draw nothing —
     *  renderers skip them and the export doesn't even decode the media. */
    hidden: z.boolean().default(false),
    /** Normalized position of the layer's center in the frame — 0.5 =
     *  centered (default); the edge values put the layer's center on the
     *  frame edge (half the layer clipped). `scale` resizes about this point. */
    x: z.number().min(0).max(1).default(0.5),
    y: z.number().min(0).max(1).default(0.5),
    /** 0..1 opacity multiplier applied to the layer image. */
    opacity: z.number().min(0).max(1).default(1),
    /** Size multiplier on the cover-cropped layer, drawn about the layer's
     *  center: 1 fills the frame (default), <1 shrinks to an inset, >1 zooms
     *  (clipped at the frame edge). */
    scale: z.number().min(0.1).max(2).default(1),
    /** @deprecated use `key` — accepted for backwards compatibility with old
     *  render configs; folded into `key` during parse. */
    chromaKey: vizChromaKeySchema.optional(),
    key: vizVideoKeySchema.default({}),
    /** Source-crop zoom/pan — which part of the media fills the tile. */
    zoomPan: vizZoomPanSchema.default({}),
    /** Time windows when the row draws — empty show+hide = always visible. */
    visibility: vizVisibilitySchema.default({}),
  })
  .transform(foldChromaKey);

/** The mode visuals ("2. Look") as a stack row — the waveforms draw at this
 *  row's position; a stack without a visuals row renders no mode visuals at
 *  all. Carries opacity/scale like media rows (no asset, no keying). Several
 *  visuals rows may coexist: `visuals` holds the row's own complete look
 *  (mode + params); absent it draws with the global "2. Look" values —
 *  which is also what old configs (and the default row) do. */
const vizVisualsLayerSchema = z.object({
  kind: z.literal("visuals"),
  hidden: z.boolean().default(false),
  x: z.number().min(0).max(1).default(0.5),
  y: z.number().min(0).max(1).default(0.5),
  opacity: z.number().min(0).max(1).default(1),
  scale: z.number().min(0.1).max(2).default(1),
  /** Own waveform look for this row — when set it renders with these params
   *  instead of `globalVisuals`' wave fields. */
  visuals: vizWaveParamsSchema.optional(),
  /** Time windows when the row draws — empty show+hide = always visible. */
  visibility: vizVisibilitySchema.default({}),
});

export const vizMediaLayerSchema = z.union([vizMediaAssetLayerSchema, vizVisualsLayerSchema]);
export type VizMediaLayerConfig = z.infer<typeof vizMediaLayerSchema>;

export const VIZ_MAX_VIDEO_LAYERS = 10;

/** The visuals stack row added by default and inserted when migrating
 *  band-model configs. `visuals` gives the row its own look (leave unset to
 *  inherit the global "2. Look"). */
export const vizVisualsLayer = (visuals?: VizWaveParams): VizMediaLayerConfig => ({
  kind: "visuals",
  hidden: false,
  x: 0.5,
  y: 0.5,
  opacity: 1,
  scale: 1,
  visibility: { show: [], hide: [] },
  ...(visuals ? { visuals } : {}),
});

/** Stacked layers composited into every frame. `layers` is the ordered row
 *  list (index 0 = bottom); a `kind:"visuals"` row marks where the mode
 *  visuals draw — without one they don't render. The legacy single-video
 *  fields (and band-model `layer` hints on rows) are kept on the wire for
 *  backwards compatibility and folded into `layers` on parse; a `layers` key
 *  that is present but empty is respected literally (nothing draws). */
export const vizVideoSchema = z
  .object({
    layers: z.array(vizMediaLayerSchema).max(VIZ_MAX_VIDEO_LAYERS).optional(),
    /** @deprecated legacy single-video config — folded into `layers`. */
    assetId: z.string().min(1).max(64).nullable().default(null),
    layer: vizVideoLayerSchema.default("under"),
    opacity: z.number().min(0).max(1).default(1),
    scale: z.number().min(0.1).max(2).default(1),
    chromaKey: vizChromaKeySchema.optional(),
    key: vizVideoKeySchema.default({}),
  })
  .transform((v) => {
    const { layers, ...legacy } = v;
    // No `layers` key at all → the pre-stack shapes. Empty/omitted video {}
    // rendered visuals-only back then, so the baseline is a lone visuals row;
    // a flat single-video config folds to [media, visuals] (under) or
    // [visuals, media] (over) — reproducing its old band render.
    if (layers === undefined) {
      if (!legacy.assetId) return { layers: [vizVisualsLayer()] };
      const media = foldChromaKey({
        kind: "media" as const,
        assetId: legacy.assetId,
        layer: legacy.layer,
        hidden: false,
        x: 0.5,
        y: 0.5,
        opacity: legacy.opacity,
        scale: legacy.scale,
        chromaKey: legacy.chromaKey,
        key: legacy.key,
        zoomPan: { zoom: 1, panX: 0.5, panY: 0.5 },
        visibility: { show: [], hide: [] },
      });
      return { layers: legacy.layer === "over" ? [vizVisualsLayer(), media] : [media, vizVisualsLayer()] };
    }
    const out: VizMediaLayerConfig[] = [...layers];
    // A stray legacy flat assetId on top of a layers list — insert next to
    // the visuals row when there is one, else append on top.
    if (legacy.assetId && !out.some((l) => l.kind === "media" && l.assetId === legacy.assetId) && out.length < VIZ_MAX_VIDEO_LAYERS) {
      const media = foldChromaKey({
        kind: "media" as const,
        assetId: legacy.assetId,
        layer: legacy.layer,
        hidden: false,
        x: 0.5,
        y: 0.5,
        opacity: legacy.opacity,
        scale: legacy.scale,
        chromaKey: legacy.chromaKey,
        key: legacy.key,
        zoomPan: { zoom: 1, panX: 0.5, panY: 0.5 },
        visibility: { show: [], hide: [] },
      });
      const vi = out.findIndex((l) => l.kind === "visuals");
      if (vi >= 0) out.splice(legacy.layer === "under" ? vi : vi + 1, 0, media);
      else out.push(media);
    }
    // Band-model rows (each carrying the deprecated `layer` hint) without a
    // visuals row: the mode visuals drew between the under and over bands —
    // restore that row at the boundary so old configs still show waveforms.
    if (!out.some((l) => l.kind === "visuals") && out.length < VIZ_MAX_VIDEO_LAYERS && out.some((l) => l.kind === "media" && l.layer !== undefined)) {
      const firstOver = out.findIndex((l) => l.kind === "media" && l.layer === "over");
      out.splice(firstOver >= 0 ? firstOver : out.length, 0, vizVisualsLayer());
    }
    return { layers: out.slice(0, VIZ_MAX_VIDEO_LAYERS) };
  });
export type VizVideoConfig = z.infer<typeof vizVideoSchema>;

export const visualizerStemSchema = z.object({
  /** Stored stem filename (see GET/POST /api/visualizer/stems). */
  name: z.string().min(1).max(255),
  kind: stemKindSchema.optional(),
  color: hexColorSchema.optional(),
  /** Degrees; overrides the layout-computed angle. */
  angleDeg: z.number().min(0).max(360).optional(),
  amplitudeScale: z.number().min(0.05).max(4).optional(),
  glowRadius: z.number().min(0).max(60).optional(),
  lineThickness: z.number().min(0.5).max(20).optional(),
  muted: z.boolean().default(false),
  solo: z.boolean().default(false),
});
export type VisualizerStemInput = z.infer<typeof visualizerStemSchema>;

export const visualizerRenderSchema = z.object({
  renderSettings: z.object({
    width: z.number().int().min(240).max(3840),
    // 3840 on both axes so portrait 4K (2160×3840) is valid too.
    height: z.number().int().min(240).max(3840),
    fps: z.number().int().min(12).max(60),
    /** Draft pass — ultrafast encode preset + high CRF for a fast, low-quality
     *  first look (the output file name carries a `draft` marker). */
    draft: z.boolean().optional(),
  }),
  globalVisuals: vizWaveParamsSchema.extend({
    backgroundColor: hexColorSchema.default("#050508"),
    video: vizVideoSchema.default({}),
    dancer: dancerConfigSchema.default({}),
  }),
  stems: z.array(visualizerStemSchema).min(1).max(20),
});
export type VisualizerRenderInput = z.infer<typeof visualizerRenderSchema>;
/** Pre-defaults request shape (what the client actually sends). */
export type VisualizerRenderRequest = z.input<typeof visualizerRenderSchema>;
export type VisualizerGlobals = VisualizerRenderInput["globalVisuals"];

// --- Sessions (named, restorable visualizer setups) ----------------------------

/** A saved visualizer setup — everything needed to bring the page back to the
 *  exact working state: the stem selection (with per-stem tweaks), every
 *  "Look"/layers/dancer setting and the render settings. Unlike a render,
 *  a session may be saved with zero stems selected. */
export const visualizerSessionPayloadSchema = visualizerRenderSchema.extend({
  stems: z.array(visualizerStemSchema).max(20),
});
export type VisualizerSessionPayload = z.infer<typeof visualizerSessionPayloadSchema>;

export const vizSessionNameSchema = z.string().trim().min(1).max(80);

/** POST /api/visualizer/sessions body. */
export const vizSessionSaveSchema = z.object({
  name: vizSessionNameSchema,
  payload: visualizerSessionPayloadSchema,
});

/** PUT /api/visualizer/sessions/:id body — rename and/or overwrite the setup. */
export const vizSessionUpdateSchema = z
  .object({
    name: vizSessionNameSchema.optional(),
    payload: visualizerSessionPayloadSchema.optional(),
  })
  .refine((d) => d.name !== undefined || d.payload !== undefined, { message: "name or payload is required" });

/** Metadata-only view of a session (for lists — payload omitted). */
export interface VizSessionMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Stem filenames the session references. */
  stems: string[];
  /** Number of media (video/image) rows in the layer stack. */
  mediaLayers: number;
}

export interface VizSession extends VizSessionMeta {
  payload: VisualizerSessionPayload;
}

/** Resolution presets offered by the UI — aspect × quality (explicit w/h are
 *  also accepted). */
export const VIZ_RESOLUTIONS = {
  "16:9": { "1080p": { width: 1920, height: 1080 }, "4k": { width: 3840, height: 2160 } },
  "9:16": { "1080p": { width: 1080, height: 1920 }, "4k": { width: 2160, height: 3840 } },
  "1:1": { "1080p": { width: 1080, height: 1080 }, "4k": { width: 2160, height: 2160 } },
} as const;

// --- Resolved stem config (all defaults applied) ------------------------------

export interface ResolvedStem {
  name: string;
  kind: StemKind;
  color: string;
  angleDeg: number | null; // null → computed from layout + index
  amplitudeScale: number;
  glowRadius: number;
  lineThickness: number;
  muted: boolean;
  solo: boolean;
}

export function resolveStem(input: VisualizerStemInput, index: number): ResolvedStem {
  const kind = input.kind ?? detectStemKind(input.name);
  const d = STEM_KIND_DEFAULTS[kind];
  return {
    name: input.name,
    kind,
    color: input.color ?? (input.kind ? d.color : STEM_PALETTE[index % STEM_PALETTE.length]!),
    angleDeg: input.angleDeg ?? null,
    amplitudeScale: input.amplitudeScale ?? d.amplitudeScale,
    glowRadius: input.glowRadius ?? d.glowRadius,
    lineThickness: input.lineThickness ?? d.lineThickness,
    muted: input.muted ?? false,
    solo: input.solo ?? false,
  };
}

/** A stem is silenced when muted, or when another stem is soloed. */
export function isStemAudible(stem: { muted: boolean; solo: boolean }, anySolo: boolean): boolean {
  return !stem.muted && (!anySolo || stem.solo);
}

export function anySolo(stems: Array<{ solo: boolean }>): boolean {
  return stems.some((s) => s.solo);
}

// --- Signal extraction (once per stem) ----------------------------------------

/** Peak series rate (Hz). 0.42 ms granularity ≪ the ±0.5-frame (8.3 ms@60fps)
 *  sync budget — waveform phase is preserved without resampling math. */
export const PEAK_RATE = 2400;
/** Envelope series rate (Hz) — RMS over ~28 ms windows. */
export const ENV_RATE = 500;
/** Long-window RMS look-back for transient detection (~200 ms). */
const ENV_LONG_SEC = 0.2;

/** Engine-extracted per-stem features (librosa via the Python worker).
 *  Optional — every consumer must degrade gracefully when absent so the
 *  visualizer still works with zero Python installed. */
export interface StemFeatures {
  version: number;
  durationSec: number;
  tempo: number;
  /** Feature frame rate (Hz) — sampleRate / hopLength of the analysis STFT. */
  featureRate: number;
  /** Frames in the bands/env/onsetEnv series (all share the same rate). */
  frames: number;
  bandNames: string[];
  /** Band energy envelopes, row-major (bandNames.length × frames), 0..1. */
  bands: Float32Array;
  /** RMS energy envelope (frames), 0..1. */
  env: Float32Array;
  /** Spectral-flux onset strength (frames), 0..1. */
  onsetEnv: Float32Array;
  onsets: Array<{ time: number; strength: number }>;
  beats: Array<{ time: number; strength: number }>;
}

export interface StemSignal {
  /** Signed max-abs peak per 1/PEAK_RATE bucket (monotonic with pcm time). */
  peaks: Float32Array;
  /** RMS envelope per 1/ENV_RATE bucket. */
  env: Float32Array;
  durationSec: number;
  /** Per-channel peaks when the source had ≥2 channels (stereo mode);
   *  absent on mono sources — consumers mirror `peaks` instead. */
  peaksL?: Float32Array;
  peaksR?: Float32Array;
  /** Present only when the Python engine produced features for this stem. */
  features?: StemFeatures;
}

/** Band index by name, or -1 when unknown. */
export function bandIndex(f: StemFeatures, name: string): number {
  return f.bandNames.indexOf(name);
}

/** Band energy at time t (linear lookup into the feature-rate series). */
export function bandAt(f: StemFeatures, band: number, t: number): number {
  if (band < 0 || band >= f.bandNames.length || f.frames === 0) return 0;
  const i = Math.max(0, Math.min(f.frames - 1, Math.floor(t * f.featureRate)));
  return f.bands[band * f.frames + i]!;
}

/** Onset events inside [t0, t1) — for hit-triggered motion. */
export function onsetsBetween(f: StemFeatures, t0: number, t1: number): Array<{ time: number; strength: number }> {
  return f.onsets.filter((o) => o.time >= t0 && o.time < t1);
}

// --- Signal wire format -------------------------------------------------------
// GET /api/visualizer/stems/:name/signal returns one binary payload:
//   [u32 LE metaLen][meta JSON][peaks][env][peaksL][peaksR][bands][featEnv][onsetEnv]
// All arrays are little-endian f32, concatenated in that exact order; `counts`
// gives each length (0 when the engine produced no features for the stem, or
// the source is mono → no channel arrays).
export interface StemSignalMeta {
  version: 1;
  durationSec: number;
  peaksRate: number;
  envRate: number;
  counts: { peaks: number; env: number; peaksL: number; peaksR: number; bands: number; featEnv: number; onsetEnv: number };
  /** Present only when engine features exist for this stem. */
  features: {
    tempo: number;
    featureRate: number;
    frames: number;
    bandNames: string[];
    onsets: Array<{ time: number; strength: number }>;
    beats: Array<{ time: number; strength: number }>;
    durationSec: number;
    version: number;
  } | null;
}

/** Signed max-abs peak per 1/PEAK_RATE bucket — also used per channel for
 *  the stereo mode (same bucketing as the mono series). */
export function buildPeakSeries(pcm: Float32Array, sr: number): Float32Array {
  const n = pcm.length;
  const peakWin = Math.max(1, Math.round(sr / PEAK_RATE));
  const peaks = new Float32Array(Math.ceil(n / peakWin));
  for (let i = 0; i < peaks.length; i++) {
    let best = 0;
    const end = Math.min(n, (i + 1) * peakWin);
    for (let j = i * peakWin; j < end; j++) {
      const s = pcm[j]!;
      if (Math.abs(s) > Math.abs(best)) best = s;
    }
    peaks[i] = best;
  }
  return peaks;
}

/** Reduce raw mono PCM to a peak series + RMS envelope. Runs once per stem —
 *  per-frame cost is then O(points) instead of O(sr·window). */
export function buildStemSignal(pcm: Float32Array, sr: number): StemSignal {
  const n = pcm.length;
  const peaks = buildPeakSeries(pcm, sr);
  const envWin = Math.max(1, Math.round(sr / ENV_RATE));
  const env = new Float32Array(Math.ceil(n / envWin));
  for (let i = 0; i < env.length; i++) {
    let sum = 0;
    const end = Math.min(n, (i + 1) * envWin);
    for (let j = i * envWin; j < end; j++) sum += pcm[j]! * pcm[j]!;
    env[i] = Math.sqrt(sum / Math.max(1, end - i * envWin));
  }
  return { peaks, env, durationSec: n / sr };
}

// --- Frame geometry -----------------------------------------------------------

/** Display vertices per stem path. */
export const VIZ_POINTS = 480;
/** Amplitude scale: a full-scale sample deflects this fraction of min(w,h). */
const AMP_FRACTION = 0.11;
/** Path inset from the canvas edge (fraction of min(w,h)). */
const EDGE_MARGIN = 0.06;

/** Per-stem angles (degrees, screen coords: 0°=+x, 90°=+y i.e. downward). */
export function stemAngles(count: number, layout: VizLayout): number[] {
  if (count <= 0) return [];
  if (layout === "radial") {
    return Array.from({ length: count }, (_, i) => -90 + (i * 360) / count);
  }
  if (layout === "fan") {
    const spread = 60;
    if (count === 1) return [90];
    return Array.from({ length: count }, (_, i) => 90 - spread + (2 * spread * i) / (count - 1));
  }
  if (layout === "vertical") {
    // vertical — even indices fan upward (−90°±55°), odd downward (+90°±55°)
    const up = Math.ceil(count / 2);
    const down = count - up;
    const fan = (n: number, center: number) =>
      n <= 0 ? [] : n === 1 ? [center] : Array.from({ length: n }, (_, i) => center - 55 + (110 * i) / (n - 1));
    const uAngles = fan(up, -90);
    const dAngles = fan(down, 90);
    const out: number[] = [];
    let ui = 0, di = 0;
    for (let i = 0; i < count; i++) out.push(i % 2 === 0 ? uAngles[ui++]! : dAngles[di++]!);
    return out;
  }
  // speakers — even indices fan on the right (0°±55°), odd on the left (180°±55°)
  const right = Math.ceil(count / 2);
  const left = count - right;
  const fan = (n: number, center: number) =>
    n <= 0 ? [] : n === 1 ? [center] : Array.from({ length: n }, (_, i) => center - 55 + (110 * i) / (n - 1));
  const rAngles = fan(right, 0);
  const lAngles = fan(left, 180);
  const out: number[] = [];
  let ri = 0, li = 0;
  for (let i = 0; i < count; i++) out.push(i % 2 === 0 ? rAngles[ri++]! : lAngles[li++]!);
  return out;
}

export interface Vec2 {
  x: number;
  y: number;
}

/** Outer anchor for a stem ray from the convergence center at angleDeg. */
export function pathStart(width: number, height: number, center: Vec2, angleDeg: number): Vec2 {
  const margin = EDGE_MARGIN * Math.min(width, height);
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  // Distance from center to the (margin-inset) rectangle edge along (dx,dy).
  const rx = dx !== 0 ? (width / 2 - margin) / Math.abs(dx) : Infinity;
  const ry = dy !== 0 ? (height / 2 - margin) / Math.abs(dy) : Infinity;
  const r = Math.min(rx, ry);
  return { x: center.x + dx * r, y: center.y + dy * r };
}

/** Unit normal (perpendicular) for a path direction. */
function normalOf(start: Vec2, end: Vec2): Vec2 {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: -dy / len, y: dx / len };
}

/** Spec frame mapping: samples in [max(0,⌊(t−w)·r⌋) : ⌊t·r⌋] of a rate-r series. */
export function windowSlice(seriesLen: number, rate: number, t: number, wSec: number): [number, number] {
  const end = Math.max(0, Math.min(seriesLen, Math.floor(t * rate)));
  const start = Math.max(0, Math.min(end, Math.floor((t - wSec) * rate)));
  return [start, end];
}

function rmsAt(env: Float32Array, t: number, lookbackSec: number): number {
  const end = Math.max(0, Math.min(env.length, Math.floor(t * ENV_RATE)));
  const start = Math.max(0, end - Math.round(lookbackSec * ENV_RATE));
  if (end <= start) return 0;
  let sum = 0;
  for (let i = start; i < end; i++) sum += env[i]! * env[i]!;
  return Math.sqrt(sum / (end - start));
}

/** Windowed signed peaks from a raw peak array (channel-aware variant). */
function peaksForWindowFrom(peaks: Float32Array, t: number, wSec: number, points: number): Float32Array {
  const out = new Float32Array(points);
  const [start, end] = windowSlice(peaks.length, PEAK_RATE, t, wSec);
  const span = Math.max(1, end - start);
  for (let i = 0; i < points; i++) {
    const b0 = start + Math.floor((i * span) / points);
    const b1 = i === points - 1 ? end : start + Math.floor(((i + 1) * span) / points);
    let best = 0;
    for (let j = b0; j < b1; j++) {
      const s = peaks[j]!;
      if (Math.abs(s) > Math.abs(best)) best = s;
    }
    out[i] = best;
  }
  return out;
}

/** Reduce the trailing wSec of the peak series to `points` signed peaks. */
export function peaksForWindow(signal: StemSignal, t: number, wSec: number, points: number): Float32Array {
  return peaksForWindowFrom(signal.peaks, t, wSec, points);
}

/** Per-kind deterministic modifiers for frame t — pure functions of the
 *  stem's envelope, so preview and export agree exactly. */
export interface StemModifiers {
  widthMul: number; // multiplies half-width everywhere
  glowBoost: number; // 0..1 extra glow alpha (drums flash)
  alphaMul: number; // multiplies stem alpha (fx shimmer)
  harmonicOffset: number; // px offset for secondary parallel lines (keys)
  smoothPeaks: boolean; // vocals: moving-average smoothing along the path
}

export function stemModifiers(kind: StemKind, signal: StemSignal, t: number): StemModifiers {
  const envS = rmsAt(signal.env, t, 0.025);
  const envL = rmsAt(signal.env, t, ENV_LONG_SEC);
  const m: StemModifiers = { widthMul: 1, glowBoost: 0, alphaMul: 1, harmonicOffset: 0, smoothPeaks: false };
  switch (kind) {
    case "drums": {
      // Transient flash: short/long envelope ratio, decaying with the ratio.
      const ratio = envL > 1e-4 ? envS / envL : 0;
      m.glowBoost = Math.min(1, Math.max(0, (ratio - 1.25) * 0.9));
      m.widthMul = 1 + m.glowBoost * 0.6;
      break;
    }
    case "bass":
      // Low-frequency width oscillation scaled by current level.
      m.widthMul = 1 + 0.3 * Math.sin(2 * Math.PI * 2.2 * t) * Math.min(1, envS * 3);
      break;
    case "vocal":
      m.smoothPeaks = true;
      m.widthMul = 0.7 + Math.min(1.3, envS * 4);
      break;
    case "keys":
      m.harmonicOffset = 7 + 26 * Math.min(1, envS * 3);
      break;
    case "guitar":
    case "fx":
    case "other":
      m.alphaMul = 0.55 + 0.45 * Math.min(1, envS * 4);
      break;
  }
  return m;
}

function smoothPeaks(peaks: Float32Array): Float32Array {
  const out = new Float32Array(peaks.length);
  for (let i = 0; i < peaks.length; i++) {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(peaks.length - 1, i + 2); j++) {
      sum += peaks[j]!;
      n++;
    }
    out[i] = sum / n;
  }
  return out;
}

/** Variable-width ribbon outline around a centerline: left edge forward then
 *  right edge back — a closed polygon usable as Canvas Path2D fill or an SVG
 *  <path fill>, so both engines draw identical geometry. Returns interleaved
 *  [x,y] pairs of length 2*2*n. */
export function ribbonOutline(vertices: Float32Array, normals: { x: number; y: number }, halfWidths: Float32Array): Float32Array {
  const n = vertices.length / 2;
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const vx = vertices[i * 2]!;
    const vy = vertices[i * 2 + 1]!;
    const hw = halfWidths[i]!;
    out[i * 2] = vx + normals.x * hw;
    out[i * 2 + 1] = vy + normals.y * hw;
  }
  for (let i = 0; i < n; i++) {
    const j = n - 1 - i;
    const vx = vertices[j * 2]!;
    const vy = vertices[j * 2 + 1]!;
    const hw = halfWidths[j]!;
    out[(n + i) * 2] = vx - normals.x * hw;
    out[(n + i) * 2 + 1] = vy - normals.y * hw;
  }
  return out;
}

// --- Whole-frame computation --------------------------------------------------

export interface VizFrameStem {
  /** Closed ribbon polygon for the core (interleaved x,y). */
  ribbon: Float32Array;
  /** Centerline points (for glow strokes), interleaved x,y. */
  centerline: Float32Array;
  /** Secondary harmonic ribbons (keys) — 0, 1 or 2 extra ribbons. */
  harmonics: Float32Array[];
  color: string;
  alpha: number;
  glowAlpha: number;
  glowWidth: number;
  audible: boolean;
}

/** Spectrum mode: per-stem group of bar quads (x,y,w,h × nBars). */
export interface VizBarGroup {
  color: string;
  alpha: number;
  glowAlpha: number;
  bars: Float32Array;
}

/** Particles mode: per-stem packed particles (x,y,r × n). */
export interface VizParticleGroup {
  color: string;
  alpha: number;
  points: Float32Array;
}

/** Mirror mode: one mirrored waveform per stem, all sharing the horizontal
 *  center axis — filled symmetric shape + nested echo traces + crest dots. */
export interface VizMirrorStem {
  /** Closed polygon: upper curve left→right then mirrored lower right→left. */
  fill: Float32Array;
  /** Inner echo polylines (scaled copies), drawn as thin strokes. */
  echoes: Float32Array[];
  /** Crest glow dots [x,y,r]×n — at local peaks, paired above/below the axis. */
  dots: Float32Array;
  color: string;
  alpha: number;
  glowAlpha: number;
  glowWidth: number;
  audible: boolean;
}

/** Blocks mode: per-stem x-slice of segmented columns mirrored about the
 *  horizontal axis (LED-equalizer look). */
export interface VizBlockGroup {
  /** All segment rects [x,y,w,h]×n for this stem's columns. */
  rects: Float32Array;
  /** Tip glow dots [x,y,r]×n at both column ends. */
  dots: Float32Array;
  color: string;
  alpha: number;
  glowAlpha: number;
}

/** EQ-bars mode: dense segmented LED columns per stem slice, mirrored about
 *  the horizontal axis — brightening segment ramp, hot tip caps, rising
 *  spark particles above the tips, luminous axis strip (Specterr-style). */
export interface VizEqGroup {
  /** Lit column segments [x,y,w,h,bright]×n — stride 5; bright 0..1 is the
   *  intended relative opacity (1 = tip end; mirrored half is pre-dimmed). */
  segs: Float32Array;
  /** Hot tip cap rects [x,y,w,h]×n at both column ends (drawn in tipColor). */
  tips: Float32Array;
  /** Tip glow circles [x,y,r]×n at the upper column ends. */
  tipGlow: Float32Array;
  /** Rising spark particles [x,y,r]×n above the upper tips. */
  sparks: Float32Array;
  /** Luminous mirror-axis strip — a single rect [x,y,w,h]. */
  axis: Float32Array;
  color: string;
  tipColor: string;
  alpha: number;
  glowAlpha: number;
  audible: boolean;
}

/** EQ-bars-radial mode: the same segmented LED columns as `eqbars`, bent
 *  around the convergence point — constant-angular-width quads radiating
 *  outward from the hub radius, brightening toward the outer tip, hot tip
 *  caps + glow flares, sparks drifting outward, luminous hub ring. */
export interface VizEqRadialGroup {
  /** Lit column segments — stride 9: quad [x,y]×4 + bright (0..1, 1 = tip
   *  end). Quads are polar cells [rA,rB]×[θ±ha], emitted inner-L, inner-R,
   *  outer-R, outer-L. */
  segs: Float32Array;
  /** Hot tip cap quads [x,y]×4 at each bar's outer end (drawn in tipColor). */
  tips: Float32Array;
  /** Tip glow circles [x,y,r]×n at the bar tips. */
  tipGlow: Float32Array;
  /** Sparks [x,y,r]×n drifting outward past the tips. */
  sparks: Float32Array;
  /** Luminous hub ring at radius R0 — [cx,cy,r,lineWidth]. */
  ring: Float32Array;
  color: string;
  tipColor: string;
  alpha: number;
  glowAlpha: number;
  audible: boolean;
}

/** Stereo mode: L/R channel waveforms flowing inward to meet along the
 *  vertical center line — fills hug the line ([cx−v, cx] / [cx, cx+v]).
 *  Mono stems show a mirrored copy so the center is a real mirror line. */
export interface VizStereoStem {
  /** Closed polygons hugging the center line (outer curve + back along it). */
  leftFill: Float32Array;
  rightFill: Float32Array;
  /** Inner echo traces (scaled copies) — open polylines. */
  leftEcho: Float32Array;
  rightEcho: Float32Array;
  /** false when the source had no second channel → right side is mirrored mono. */
  stereo: boolean;
  color: string;
  alpha: number;
  glowAlpha: number;
  glowWidth: number;
  audible: boolean;
}

/** Silk mode: K nested scaled copies of the |peak| waveform packed per stem
 *  slice, mirrored about the horizontal axis and stroked with a spectral
 *  x-gradient — violet→cyan sweep left of the center point, amber→magenta on
 *  the right, hot toward the point — plus a luminous axis strip and ambient
 *  dust. The LAST strand in each pack is the scale-1 edge trace (renderers
 *  re-stroke it brighter; extract via `(strandCount-1)*strandN*2`). */
export interface VizSilkStem {
  /** Packed strand polylines above the axis: strandCount × strandN (x,y). */
  up: Float32Array;
  /** The same strands mirrored below the axis. */
  down: Float32Array;
  strandCount: number;
  strandN: number;
  /** Luminous axis strip rect [x,y,w,h] — gradient-filled + white core. */
  axis: Float32Array;
  /** Ambient dust circles [x,y,r]×m scattered around the waveform. */
  dust: Float32Array;
  /** Spectral gradient in user space: stops at gradX0 / mid / gradX1 with
   *  colors grad0/grad1/grad2; `gradMid` is the 0..1 fraction where the
   *  middle stop sits (the convergence point when the slice straddles it). */
  gradX0: number;
  gradX1: number;
  gradMid: number;
  grad0: string;
  grad1: string;
  grad2: string;
  /** Dust/edge tint — the gradient mid color. */
  color: string;
  alpha: number;
  glowAlpha: number;
  glowWidth: number;
  audible: boolean;
}

/** Circular mode: one closed ring-waveform per stem. */
export interface VizRing {
  color: string;
  alpha: number;
  glowAlpha: number;
  glowWidth: number;
  lineWidth: number;
  fillAlpha: number;
  /** Closed polygon (interleaved x,y). */
  points: Float32Array;
}

/** Procedural dancer overlay — resolved skeleton for one frame. */
export interface VizDancer {
  /** Filled limb outlines (closed polygons), per-limb colored. */
  limbs: Array<{ path: Float32Array; color: string; alpha: number }>;
  /** Limb centerlines for the neon stroke+fill look. */
  strokes: Array<{ points: Float32Array; color: string; alpha: number }>;
  head: { x: number; y: number; r: number; color: string; alpha: number };
  /** Joint dots (interleaved x,y pairs). */
  joints: Float32Array;
  jointColor: string;
  alpha: number;
  glowWidth: number;
}

/** One visuals row's computed geometry — the mode dispatch fills exactly the
 *  array matching `mode`. A stack may carry several `kind:"visuals"` rows,
 *  each rendered with its own params (`VizFrameState.visualChannels`). */
export interface VizModeVisuals {
  mode: VizMode;
  stems: VizFrameStem[];
  rings: VizRing[];
  bars: VizBarGroup[];
  mirrors: VizMirrorStem[];
  blocks: VizBlockGroup[];
  eqbars: VizEqGroup[];
  eqradial: VizEqRadialGroup[];
  stereos: VizStereoStem[];
  silks: VizSilkStem[];
  particles: VizParticleGroup[];
}

export interface VizFrameState {
  /** Mode of the first visuals row (`globals.mode` when the stack has none). */
  mode: VizMode;
  /** The ordered layer stack — one entry per configured row, same order as
   *  `globals.video.layers` (empty when none). `kind:"media"` rows carry an
   *  injected image (Canvas element / embedded SVG <image>); `kind:"visuals"`
   *  rows draw their own mode visuals at that stack position — no visuals row
   *  means no waveforms at all. `hidden` rows keep their slot but draw nothing.
   *  Row order is the only z-order; the dancer + star
   *  still draw on top of the whole stack. */
  videoLayers: Array<{
    kind: "media" | "visuals";
    hidden: boolean;
    x: number;
    y: number;
    opacity: number;
    scale: number;
    key: VizVideoKeyConfig | null;
    /** Media rows only — source-crop zoom/pan (absent on visuals rows). */
    zoomPan?: VizZoomPanConfig;
    /** Time-window evaluation for this frame — a row draws iff
     *  `!hidden && visible` (hidden is the manual eye toggle). */
    visible: boolean;
  }>;
  /** One entry per `kind:"visuals"` row — `rowIndex` is its index into
   *  `videoLayers`. Each channel was computed with that row's own `visuals`
   *  params (or the globals when the row carries none), so stacked waveform
   *  layers can differ in mode and every setting. */
  visualChannels: Array<{ rowIndex: number; visuals: VizModeVisuals }>;
  /** Geometry of the FIRST visuals row — kept flat at the top level for
   *  single-visuals-row callers; renderers iterate `visualChannels` instead.
   *  Empty when the stack has no visuals row. */
  stems: VizFrameStem[];
  rings: VizRing[];
  bars: VizBarGroup[];
  mirrors: VizMirrorStem[];
  blocks: VizBlockGroup[];
  eqbars: VizEqGroup[];
  eqradial: VizEqRadialGroup[];
  stereos: VizStereoStem[];
  silks: VizSilkStem[];
  particles: VizParticleGroup[];
  dancer: VizDancer | null;
  star: { x: number; y: number; r: number; alpha: number };
  t: number;
}

/** The mode geometry a given visuals row draws — its channel from
 *  `visualChannels`, or the state's flat (first-row) arrays when channels
 *  were never populated (hand-built states). */
export function visualsForRow(state: VizFrameState, rowIndex: number): VizModeVisuals {
  const ch = state.visualChannels?.find((c) => c.rowIndex === rowIndex);
  if (ch) return ch.visuals;
  return {
    mode: state.mode,
    stems: state.stems,
    rings: state.rings,
    bars: state.bars,
    mirrors: state.mirrors,
    blocks: state.blocks,
    eqbars: state.eqbars,
    eqradial: state.eqradial,
    stereos: state.stereos,
    silks: state.silks,
    particles: state.particles,
  };
}

export interface FrameStem {
  cfg: ResolvedStem;
  signal: StemSignal;
}

// --- Motion helpers shared by modes + the dancer ------------------------------

/** RMS of the ENV_RATE envelope series ending at t over lookbackSec. */
export function signalEnv(signal: StemSignal, t: number, lookbackSec = 0.05): number {
  return rmsAt(signal.env, t, lookbackSec);
}

/** Most recent onset at or before t (binary search — onsets are sorted). */
export function lastOnsetBefore(f: StemFeatures, t: number): { time: number; strength: number } | null {
  const arr = f.onsets;
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m]!.time < t) lo = m + 1;
    else hi = m;
  }
  return lo > 0 ? arr[lo - 1]! : null;
}

/** Activity 0..1 of a displayed peak window — how much sound is actually in
 *  view right now. Stems with no audio in the window fade to invisible
 *  (multiplied into alpha) instead of drawing a flat baseline. */
export function windowActivity(peaks: Float32Array): number {
  let m = 0;
  for (let i = 0; i < peaks.length; i++) {
    const v = peaks[i]!;
    const a = v < 0 ? -v : v;
    if (a > m) m = a;
  }
  return Math.min(1, m / 0.02);
}

/** Same idea from the RMS envelope — for modes without a peak window. */
export function envActivity(env: number): number {
  return Math.min(1, env / 0.02);
}

/** Transient pulse 0..1 at time t: last onset's strength decayed ~200 ms;
 *  without features, an envelope-derivative estimate (real data, no fabric). */
export function onsetPulse(signal: StemSignal, t: number): number {
  const f = signal.features;
  if (f) {
    const o = lastOnsetBefore(f, t);
    if (o) return Math.max(0, Math.min(1, o.strength * Math.exp(-(t - o.time) * 5)));
    return 0;
  }
  const s = rmsAt(signal.env, t, 0.025);
  const l = rmsAt(signal.env, t, 0.2);
  return Math.max(0, Math.min(1, (s - l) * 3));
}

/** Deterministic hash → [0,1). Used for particle seeds — same inputs give the
 *  same value every frame (no RNG state). */
export function hash01(a: number, b: number, c = 0): number {
  const x = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
  return x - Math.floor(x);
}

/** The beat cell containing t: `index` is the count of distinct beat events
 *  at or before t, merged across all stems (40 ms dedupe — the same song's
 *  stems report near-identical beat times); [start,end) is the cell's time
 *  range so callers can compute progress inside the beat. Falls back to stem
 *  onsets when no stem produced beats, else a fixed 0.5 s grid when there are
 *  no engine features at all — so beat-synced features still animate without
 *  the engine. */
function beatCell(stems: FrameStem[], t: number): { index: number; start: number; end: number } {
  const beats: number[] = [];
  const onsets: number[] = [];
  for (const { signal } of stems) {
    const f = signal.features;
    if (!f) continue;
    for (const b of f.beats) beats.push(b.time);
    for (const o of f.onsets) onsets.push(o.time);
  }
  const src = beats.length > 0 ? beats : onsets;
  if (src.length === 0) {
    const index = Math.floor(t / 0.5);
    return { index, start: index * 0.5, end: index * 0.5 + 0.5 };
  }
  src.sort((a, b) => a - b);
  let index = 0;
  let last = -Infinity;
  let next = Infinity;
  for (const x of src) {
    if (x > t) {
      next = x;
      break;
    }
    if (x - last > 0.04) {
      index++;
      last = x;
    }
  }
  const start = last === -Infinity ? 0 : last;
  return { index, start, end: Number.isFinite(next) ? next : start + 0.5 };
}

function beatCellIndex(stems: FrameStem[], t: number): number {
  return beatCell(stems, t).index;
}

/** Effective convergence point for frame t — the configured center, or a
 *  deterministic per-beat wandering point when `autoCenter` is on: every beat
 *  cell owns a hashed target position and the point eases into it over the
 *  first ~60% of the cell, then holds until the next beat. Pure function of t
 *  → preview and MP4 export land on the same pixels. The dancer and star
 *  anchor to this same point. */
export function frameCenter(stems: FrameStem[], globals: VizWaveParams, width: number, height: number, t: number): Vec2 {
  const base = globals.centerConvergence;
  const ac = globals.autoCenter;
  if (!ac.enabled) return { x: width * base.x, y: height * base.y };
  const cell = beatCell(stems, t);
  const k = Math.min(1, Math.max(0, (t - cell.start) / ((cell.end - cell.start) * 0.6)));
  const e = k * k * (3 - 2 * k); // smoothstep — glide in, then hold
  const tx = (i: number) => 0.5 + (hash01(i, 31) - 0.5) * 2 * ac.range;
  const ty = (i: number) => 0.5 + (hash01(i, 57) - 0.5) * 2 * ac.range;
  return {
    x: width * (tx(cell.index - 1) + (tx(cell.index) - tx(cell.index - 1)) * e),
    y: height * (ty(cell.index - 1) + (ty(cell.index) - ty(cell.index - 1)) * e),
  };
}

/** In-place chroma-key on an RGBA pixel buffer — the same threshold + feather
 *  ramp ffmpeg's `colorkey` applies on the export path, so a flat monochrome
 *  background drops out identically in the preview and the MP4. */
export function chromaKeyFrame(rgba: Uint8ClampedArray | Uint8Array, colorHex: string, similarity: number, blend: number): void {
  const c = parseInt(colorHex.slice(1), 16);
  const kr = (c >> 16) & 0xff;
  const kg = (c >> 8) & 0xff;
  const kb = c & 0xff;
  const MAXD = Math.sqrt(3) * 255;
  const half = Math.max(blend, 1e-4);
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const dr = rgba[i]! - kr;
    const dg = rgba[i + 1]! - kg;
    const db = rgba[i + 2]! - kb;
    const d = Math.sqrt(dr * dr + dg * dg + db * db) / MAXD;
    const a = Math.min(1, Math.max(0, (d - (similarity - half)) / (2 * half)));
    rgba[i + 3] = Math.round(rgba[i + 3]! * a);
  }
}

// --- Advanced keyers (shared preview/export pixel math) ------------------------
// The following helpers implement the richer keying methods. They run on the
// decoded RGBA frame inside BOTH renderers (browser offscreen canvas, server
// post-decode pass), so the MP4 matches the preview pixel-for-pixel.

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** ffmpeg vf_chromakey RGB→U/V fixed-point macros (FIXNUM = 10-bit lrint). */
function rgbToUV(r: number, g: number, b: number): [number, number] {
  const u = ((-173 * r - 339 * g + 512 * b + 511) >> 10) + 128;
  const v = ((512 * r - 429 * g - 83 * b + 511) >> 10) + 128;
  return [u, v];
}

/** vf_despill port generalized to the key's dominant channel: the spillmap is
 *  the excess of the key channel over `mix·other1 + factor·other2`, removed
 *  from that channel (defaults: mix 0.5, expand 0, key-channel scale −1). */
export function despillChannels(rgba: Uint8ClampedArray | Uint8Array, keyChannel: 0 | 1 | 2, mix = 0.5, expand = 0): void {
  const o1 = ((keyChannel + 1) % 3) as 0 | 1 | 2;
  const o2 = ((keyChannel + 2) % 3) as 0 | 1 | 2;
  const factor = (1 - mix) * (1 - expand);
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const k = rgba[i + keyChannel]! / 255;
    const a = rgba[i + o1]! / 255;
    const b = rgba[i + o2]! / 255;
    const spill = Math.max(k - (a * mix + b * factor), 0);
    if (spill <= 0) continue;
    // ffmpeg scales: key channel −1, others 0 → subtract the spill.
    rgba[i + keyChannel] = Math.max(0, Math.round((k - spill) * 255));
  }
}

/** Dominant channel index (0=r,1=g,2=b) of a #RRGGBB color — despill target. */
function dominantChannel(colorHex: string): 0 | 1 | 2 {
  const c = parseInt(colorHex.slice(1), 16);
  const r = (c >> 16) & 0xff;
  const g = (c >> 8) & 0xff;
  const b = c & 0xff;
  return r >= g && r >= b ? 0 : g >= b ? 1 : 2;
}

/** Port of ffmpeg `vf_chromakey` (8-bit path): the chroma key operates on the
 *  half-resolution U/V planes — for each pixel the mean chroma distance over
 *  its 3×3 neighbourhood (out-of-bounds taps read the key color) drives a
 *  linear alpha ramp clipped by similarity/blend. Identical result to running
 *  `chromakey=<color>:<similarity>:<blend>` on a yuv420p frame, modulo chroma
 *  downsampling being a box average here instead of swscale's filter. */
export function chromaKeyYUVFrame(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  colorHex: string,
  similarity: number,
  blend: number,
): void {
  const c = parseInt(colorHex.slice(1), 16);
  const [ku, kv] = rgbToUV((c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff);

  // Half-res chroma planes (2×2 box average → BT.601 U/V at chroma coords),
  // mirroring the subsampled planes vf_chromakey sees on yuv420p input.
  const cw = Math.ceil(width / 2);
  const ch = Math.ceil(height / 2);
  const U = new Float32Array(cw * ch);
  const V = new Float32Array(cw * ch);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const x = cx * 2 + dx;
          const y = cy * 2 + dy;
          if (x >= width || y >= height) continue;
          const i = (y * width + x) * 4;
          r += rgba[i]!;
          g += rgba[i + 1]!;
          b += rgba[i + 2]!;
          n++;
        }
      }
      const [u, v] = rgbToUV(r / n, g / n, b / n);
      U[cy * cw + cx] = u;
      V[cy * cw + cx] = v;
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let diff = 0;
      for (let yo = -1; yo <= 1; yo++) {
        for (let xo = -1; xo <= 1; xo++) {
          const px = x + xo;
          const py = y + yo;
          // OOB taps contribute the key color (ffmpeg leaves the memset'd key
          // value in the 3×3 window), i.e. zero distance.
          let u = ku;
          let v = kv;
          if (px >= 0 && px < width && py >= 0 && py < height) {
            const ci = (py >> 1) * cw + (px >> 1);
            u = U[ci]!;
            v = V[ci]!;
          }
          const du = u - ku;
          const dv = v - kv;
          diff += Math.sqrt((du * du + dv * dv) / (255 * 255 * 2));
        }
      }
      diff /= 9;
      const a = blend > 0.0001 ? clamp01((diff - similarity) / blend) : diff > similarity ? 1 : 0;
      const i = (y * width + x) * 4;
      rgba[i + 3] = Math.round(rgba[i + 3]! * a);
    }
  }
}

/** RGB (0..255) → [h 0..360, s 0..1, v 0..1]. */
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  const v = mx / 255;
  const s = mx === 0 ? 0 : d / mx;
  let h = 0;
  if (d !== 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, s, v];
}

/** Separable min/max on the alpha channel — `choke` px radius. Positive choke
 *  erodes the matte (removes fringing), negative dilates it. Two passes
 *  (rows then columns) so cost stays O(w·h) not O(w·h·r²). */
function chokeAlpha(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, choke: number): void {
  const r = Math.min(8, Math.round(Math.abs(choke)));
  if (r === 0) return;
  const erode = choke > 0;
  const src = new Uint8Array(width * height);
  const dst = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) src[i] = rgba[i * 4 + 3]!;
  const pick = (a: number, b: number) => (erode ? Math.min(a, b) : Math.max(a, b));
  // Horizontal pass.
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let v = src[row + x]!;
      for (let k = 1; k <= r; k++) {
        if (x - k >= 0) v = pick(v, src[row + x - k]!);
        if (x + k < width) v = pick(v, src[row + x + k]!);
      }
      dst[row + x] = v;
    }
  }
  // Vertical pass back into rgba.
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let v = dst[y * width + x]!;
      for (let k = 1; k <= r; k++) {
        if (y - k >= 0) v = pick(v, dst[(y - k) * width + x]!);
        if (y + k < height) v = pick(v, dst[(y + k) * width + x]!);
      }
      rgba[(y * width + x) * 4 + 3] = v;
    }
  }
}

/** Custom HSV keyer: circular hue distance weighted by the pixel's own
 *  saturation (desaturated pixels carry no hue, so greys/whites never key),
 *  plus a small value-difference term so dark-green keys don't eat black.
 *  similarity/blend drive the same alpha ramp as the other keyers; `choke`
 *  erodes (negative value dilates) the matte edge by up to 8 px. */
export function hsvKeyFrame(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  colorHex: string,
  similarity: number,
  blend: number,
  choke = 0,
): void {
  const c = parseInt(colorHex.slice(1), 16);
  const [hk, sk, vk] = rgbToHsv((c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff);
  const half = Math.max(blend, 1e-4);
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const [h, s, v] = rgbToHsv(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!);
    const hd = Math.min(Math.abs(h - hk), 360 - Math.abs(h - hk)) / 180;
    // d ∈ [0,1]: 0 = same hue, fully saturated; →1 = hue far or pixel grey.
    // When the key itself is grey (sk≈0) hue is meaningless — fall back to
    // pure value distance so a black/white screen still keys.
    const d = sk < 0.08
      ? Math.abs(v - vk)
      : clamp01(1 - (1 - hd) * Math.min(1, s / Math.max(sk, 0.15)) + Math.abs(v - vk) * 0.2);
    const a = clamp01((d - similarity) / (2 * half));
    rgba[i + 3] = Math.round(rgba[i + 3]! * a);
  }
  if (choke !== 0) chokeAlpha(rgba, width, height, choke);
}

/** Dispatch the active key method over a decoded RGBA frame. `cutout` never
 *  reaches here — its alpha is baked into the keyed WebM upstream. */
export function keyVideoFrame(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, key: VizVideoKeyConfig | null | undefined): void {
  if (!key || key.method === "none" || key.method === "cutout") return;
  if (key.method === "colorkey") {
    chromaKeyFrame(rgba, key.color, key.similarity, key.blend);
  } else if (key.method === "chromakey") {
    chromaKeyYUVFrame(rgba, width, height, key.color, key.similarity, key.blend);
  } else {
    hsvKeyFrame(rgba, width, height, key.color, key.similarity, key.blend, key.choke);
  }
  if (key.despill) despillChannels(rgba, dominantChannel(key.color));
}

/** Source rect [sx, sy, sw, sh] for cover-fit ("object-fit: cover") — the same
 *  center-crop the server applies to video frames with
 *  `scale=dstW:dstH:force_original_aspect_ratio=increase,crop=dstW:dstH`, so the
 *  preview's drawImage and the MP4 export show the identical crop. */
export function coverCrop(srcW: number, srcH: number, dstW: number, dstH: number): [number, number, number, number] {
  if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) return [0, 0, srcW, srcH];
  const scale = Math.max(dstW / srcW, dstH / srcH);
  const sw = Math.min(srcW, dstW / scale);
  const sh = Math.min(srcH, dstH / scale);
  return [(srcW - sw) / 2, (srcH - sh) / 2, sw, sh];
}

/** Mix two #RRGGBB colors — k=0 → a, k=1 → b. */
export function mixHex(a: string, b: string, k: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const r = Math.round(((pa >> 16) & 0xff) * (1 - k) + ((pb >> 16) & 0xff) * k);
  const g = Math.round(((pa >> 8) & 0xff) * (1 - k) + ((pb >> 8) & 0xff) * k);
  const bl = Math.round((pa & 0xff) * (1 - k) + (pb & 0xff) * k);
  return `#${(((r << 16) | (g << 8) | bl) & 0xffffff).toString(16).padStart(6, "0")}`;
}

// --- computeFrame -------------------------------------------------------------

function computeRibbons(
  stems: FrameStem[],
  globals: VizWaveParams,
  width: number,
  height: number,
  t: number,
  center: Vec2,
  solo: boolean,
): VizFrameStem[] {
  const angles = stemAngles(stems.length, globals.layout);
  const ampBase = AMP_FRACTION * Math.min(width, height);
  const glowScale = globals.glowIntensity / 14;
  const out: VizFrameStem[] = [];
  for (let i = 0; i < stems.length; i++) {
    const { cfg, signal } = stems[i]!;
    const audible = isStemAudible(cfg, solo);
    const angle = cfg.angleDeg ?? angles[i]!;
    const start = pathStart(width, height, center, angle);
    const nrm = normalOf(start, center);
    const mods = stemModifiers(cfg.kind, signal, t);

    let peaks = peaksForWindow(signal, t, globals.waveformLengthSec, VIZ_POINTS);
    if (mods.smoothPeaks) peaks = smoothPeaks(peaks);
    const act = windowActivity(peaks);

    const amp = ampBase * cfg.amplitudeScale * globals.globalAmplitude;
    const n = VIZ_POINTS;
    const centerline = new Float32Array(n * 2);
    const halfWidths = new Float32Array(n);
    for (let m = 0; m < n; m++) {
      const s = m / (n - 1);
      const v = peaks[m]!;
      centerline[m * 2] = start.x + (center.x - start.x) * s + nrm.x * v * amp;
      centerline[m * 2 + 1] = start.y + (center.y - start.y) * s + nrm.y * v * amp;
      // Dynamic width: 2–8px proportional to amplitude before modifiers.
      halfWidths[m] = Math.max(0.4, (cfg.lineThickness / 2) * (0.7 + 1.4 * Math.abs(v)) * mods.widthMul);
    }

    const harmonics: Float32Array[] = [];
    if (mods.harmonicOffset > 0) {
      for (const dir of [1, -1]) {
        const hv = new Float32Array(n * 2);
        for (let m = 0; m < n; m++) {
          hv[m * 2] = centerline[m * 2]! + nrm.x * mods.harmonicOffset * dir;
          hv[m * 2 + 1] = centerline[m * 2 + 1]! + nrm.y * mods.harmonicOffset * dir;
        }
        const hw = new Float32Array(n).fill(Math.max(0.35, cfg.lineThickness * 0.3));
        harmonics.push(ribbonOutline(hv, nrm, hw));
      }
    }

    out.push({
      ribbon: ribbonOutline(centerline, nrm, halfWidths),
      centerline,
      harmonics,
      color: cfg.color,
      alpha: (audible ? 1 : 0.15) * mods.alphaMul * act,
      glowAlpha: Math.min(1, 0.35 * glowScale + mods.glowBoost * 0.6) * (audible ? 1 : 0.15) * act,
      glowWidth: Math.max(0, cfg.glowRadius * glowScale * 2 + mods.glowBoost * 24),
      audible,
    });
  }
  return out;
}

const RING_POINTS = 240;

/** Circular mode — concentric ring waveforms, inner→outer per stem. */
function computeRings(
  stems: FrameStem[],
  globals: VizWaveParams,
  width: number,
  height: number,
  t: number,
  center: Vec2,
  solo: boolean,
): VizRing[] {
  const minDim = Math.min(width, height);
  const glowScale = globals.glowIntensity / 14;
  const out: VizRing[] = [];
  const n = stems.length;
  for (let i = 0; i < n; i++) {
    const { cfg, signal } = stems[i]!;
    const audible = isStemAudible(cfg, solo);
    const baseR = minDim * (0.13 + (0.30 * i) / Math.max(1, n - 1)) * 0.9;
    const peaks = peaksForWindow(signal, t, globals.waveformLengthSec, RING_POINTS);
    const act = windowActivity(peaks);
    const amp = minDim * 0.055 * cfg.amplitudeScale * globals.globalAmplitude;
    const pts = new Float32Array(RING_POINTS * 2);
    for (let j = 0; j < RING_POINTS; j++) {
      const th = -Math.PI / 2 + (j / RING_POINTS) * Math.PI * 2;
      const r = baseR + peaks[j]! * amp;
      pts[j * 2] = center.x + Math.cos(th) * r;
      pts[j * 2 + 1] = center.y + Math.sin(th) * r;
    }
    const env = signalEnv(signal, t, 0.05);
    out.push({
      color: cfg.color,
      alpha: (audible ? 1 : 0.15) * (0.75 + 0.25 * Math.min(1, env * 3)) * act,
      glowAlpha: Math.min(1, 0.3 * glowScale + env * 0.5) * (audible ? 1 : 0.15) * act,
      glowWidth: Math.max(0, cfg.glowRadius * glowScale),
      lineWidth: Math.max(0.8, cfg.lineThickness * 0.9),
      fillAlpha: 0.05 * act,
      points: pts,
    });
  }
  return out;
}

const SPECTRUM_BARS = 6;

/** Spectrum mode — per-stem band bars laid out in lanes left→right. */
function computeBars(
  stems: FrameStem[],
  globals: VizWaveParams,
  width: number,
  height: number,
  t: number,
  solo: boolean,
): VizBarGroup[] {
  const glowScale = globals.glowIntensity / 14;
  const out: VizBarGroup[] = [];
  const n = stems.length;
  const laneW = width / n;
  const baseline = height * 0.9;
  const maxH = height * 0.6;
  const barW = (laneW * 0.7) / SPECTRUM_BARS - laneW * 0.03;
  for (let i = 0; i < n; i++) {
    const { cfg, signal } = stems[i]!;
    const audible = isStemAudible(cfg, solo);
    const f = signal.features;
    const bars = new Float32Array(SPECTRUM_BARS * 4);
    const laneX = i * laneW + laneW * 0.15;
    for (let b = 0; b < SPECTRUM_BARS; b++) {
      const v = f ? bandAt(f, b, t) : 0;
      const h = Math.max(1, v * maxH * globals.globalAmplitude);
      bars[b * 4] = laneX + b * (barW + laneW * 0.03);
      bars[b * 4 + 1] = baseline - h;
      bars[b * 4 + 2] = barW;
      bars[b * 4 + 3] = h;
    }
    const env = signalEnv(signal, t, 0.05);
    const act = envActivity(env);
    out.push({
      color: cfg.color,
      alpha: (audible ? 0.9 : 0.15) * act,
      glowAlpha: Math.min(1, 0.25 * glowScale + env * 0.4) * (audible ? 1 : 0.15) * act,
      bars,
    });
  }
  return out;
}

const PARTICLES_PER_STEM = 48;

/** Particles mode — deterministic orbiting field, onset kicks push outward. */
function computeParticles(
  stems: FrameStem[],
  globals: VizWaveParams,
  width: number,
  height: number,
  t: number,
  center: Vec2,
  solo: boolean,
): VizParticleGroup[] {
  const minDim = Math.min(width, height);
  const R = minDim * 0.42;
  const out: VizParticleGroup[] = [];
  for (let i = 0; i < stems.length; i++) {
    const { cfg, signal } = stems[i]!;
    const audible = isStemAudible(cfg, solo);
    const env = signalEnv(signal, t, 0.05);
    const kick = onsetPulse(signal, t);
    const pts = new Float32Array(PARTICLES_PER_STEM * 3);
    for (let j = 0; j < PARTICLES_PER_STEM; j++) {
      const u = hash01(i * 131 + j, 0);
      const v = hash01(i * 131 + j, 1);
      const w = hash01(i * 131 + j, 2);
      const ph = hash01(i * 131 + j, 3);
      const baseR = (0.15 + 0.75 * v) * R;
      const ang = u * Math.PI * 2 + t * (0.15 + 0.5 * w) * (ph < 0.5 ? -1 : 1);
      const wobble = 0.05 * Math.sin(2 * Math.PI * (0.3 + 0.4 * w) * t + ph * Math.PI * 2);
      const r = baseR * (1 + wobble) + kick * R * 0.16 * (0.5 + 0.5 * u);
      pts[j * 3] = center.x + Math.cos(ang) * r;
      pts[j * 3 + 1] = center.y + Math.sin(ang) * r;
      pts[j * 3 + 2] = Math.max(0.6, (0.0018 + 0.0038 * ph) * minDim * (0.55 + env * 1.6));
    }
    out.push({ color: cfg.color, alpha: (audible ? 1 : 0.15) * (0.35 + 0.65 * Math.min(1, env * 2.5 + kick)) * envActivity(env), points: pts });
  }
  return out;
}

const MIRROR_POINTS = 360;
/** Echo scales for the nested translucent traces inside the mirrored shape. */
const MIRROR_ECHO_SCALES = [0.72, 0.45];

/** Mirror mode — every stem's |peak| waveform mirrored about the horizontal
 *  center axis; all stems overlaid with translucency like stacked traces. */
function computeMirrors(
  stems: FrameStem[],
  globals: VizWaveParams,
  width: number,
  height: number,
  t: number,
  center: Vec2,
  solo: boolean,
): VizMirrorStem[] {
  const glowScale = globals.glowIntensity / 14;
  const x0 = width * 0.03;
  const x1 = width * 0.97;
  const axisY = center.y;
  const n = MIRROR_POINTS;
  const out: VizMirrorStem[] = [];
  for (let i = 0; i < stems.length; i++) {
    const { cfg, signal } = stems[i]!;
    const audible = isStemAudible(cfg, solo);
    const peaks = peaksForWindow(signal, t, globals.waveformLengthSec, n);
    const act = windowActivity(peaks);
    const amp = height * 0.36 * cfg.amplitudeScale * globals.globalAmplitude;

    const x = (j: number) => x0 + ((x1 - x0) * j) / (n - 1);
    const up = (j: number, scale = 1) => axisY - Math.abs(peaks[j]!) * amp * scale;
    const down = (j: number, scale = 1) => axisY + Math.abs(peaks[j]!) * amp * scale;

    // Filled symmetric polygon: upper curve L→R, then lower R→L.
    const fill = new Float32Array(n * 4);
    for (let j = 0; j < n; j++) {
      fill[j * 2] = x(j);
      fill[j * 2 + 1] = up(j);
      const k = n - 1 - j;
      fill[(n + j) * 2] = x(k);
      fill[(n + j) * 2 + 1] = down(k);
    }

    // Echo traces: scaled copies of both halves (open polylines).
    const echoes: Float32Array[] = [];
    for (const s of MIRROR_ECHO_SCALES) {
      for (const dir of [up, down]) {
        const e = new Float32Array(n * 2);
        for (let j = 0; j < n; j++) {
          e[j * 2] = x(j);
          e[j * 2 + 1] = dir(j, s);
        }
        echoes.push(e);
      }
    }

    // Crest dots at local maxima — paired above/below the axis.
    const dotsList: number[] = [];
    for (let j = 1; j < n - 1; j++) {
      const v = Math.abs(peaks[j]!);
      if (v > 0.5 && v >= Math.abs(peaks[j - 1]!) && v > Math.abs(peaks[j + 1]!)) {
        const r = 1.2 + v * 1.8;
        dotsList.push(x(j), up(j) - 3, r, x(j), down(j) + 3, r);
      }
    }

    out.push({
      fill,
      echoes,
      dots: Float32Array.from(dotsList),
      color: cfg.color,
      // Translucent fill so overlaid stems blend like stacked traces.
      alpha: (audible ? 0.6 : 0.12) * act,
      glowAlpha: Math.min(1, 0.3 * glowScale + act * 0.4) * (audible ? 1 : 0.15) * act,
      glowWidth: Math.max(0, cfg.glowRadius * glowScale * 0.6),
      audible,
    });
  }
  return out;
}

/** Blocks mode — the width is partitioned per stem; each slice draws its
 *  windowed peaks as segmented columns mirrored about the center axis
 *  (stacked glowing blocks, LED-equalizer style). */
function computeBlocks(
  stems: FrameStem[],
  globals: VizWaveParams,
  width: number,
  height: number,
  t: number,
  center: Vec2,
  solo: boolean,
): VizBlockGroup[] {
  const glowScale = globals.glowIntensity / 14;
  const x0 = width * 0.02;
  const sliceW = (width * 0.96) / Math.max(1, stems.length);
  const axisY = center.y;
  const bh = Math.max(3, height * 0.009); // block height
  const bgap = Math.max(1.5, bh * 0.35); // gap between blocks
  const maxH = height * 0.34;
  const out: VizBlockGroup[] = [];
  for (let i = 0; i < stems.length; i++) {
    const { cfg, signal } = stems[i]!;
    const audible = isStemAudible(cfg, solo);
    const env = signalEnv(signal, t, 0.05);
    const sx0 = x0 + i * sliceW;
    const inner = sliceW * 0.84;
    const cols = Math.max(3, Math.min(12, Math.round(sliceW / 26)));
    const pitch = inner / cols;
    const colW = pitch * 0.72;
    const cx0 = sx0 + (sliceW - inner) / 2;
    const peaks = peaksForWindow(signal, t, globals.waveformLengthSec, cols);
    const act = windowActivity(peaks);
    const amp = maxH * cfg.amplitudeScale * globals.globalAmplitude;

    const rects: number[] = [];
    const dots: number[] = [];
    for (let c = 0; c < cols; c++) {
      const h = Math.abs(peaks[c]!) * amp;
      if (h < bh * 0.5) continue;
      const x = cx0 + c * pitch + (pitch - colW) / 2;
      const cx = x + colW / 2;
      const nBlocks = Math.max(1, Math.floor(h / (bh + bgap)));
      for (let k = 0; k < nBlocks; k++) {
        rects.push(x, axisY - k * (bh + bgap) - bh, colW, bh); // above axis
        rects.push(x, axisY + k * (bh + bgap), colW, bh); // mirrored below
      }
      const tipR = Math.max(1.2, colW * 0.3);
      dots.push(cx, axisY - nBlocks * (bh + bgap) - 2, tipR, cx, axisY + nBlocks * (bh + bgap) + 2, tipR);
    }

    out.push({
      rects: Float32Array.from(rects),
      dots: Float32Array.from(dots),
      color: cfg.color,
      alpha: (audible ? 0.9 : 0.15) * act,
      glowAlpha: Math.min(1, 0.3 * glowScale + env * 0.5) * (audible ? 1 : 0.15) * act,
    });
  }
  return out;
}

const EQ_SPARKS_MAX = 18;

/** EQ column levels 0..1 — shared by `eqbars` and `eqradial` so both modes
 *  sample identically: engine band envelopes interpolated low→high across
 *  the columns when features exist (a true spectrum), else the smoothed
 *  windowed |peak| shape with a gentle edge taper and two deterministic
 *  jitter octaves (the jagged skyline look). */
function eqColumnLevels(stemIndex: number, signal: StemSignal, cols: number, t: number, wSec: number): Float32Array {
  const levels = new Float32Array(cols);
  const f = signal.features;
  if (f && f.bandNames.length >= 2 && f.frames > 0) {
    // True spectrum: interpolate the low→high band envelopes across columns.
    const nb = f.bandNames.length;
    for (let c = 0; c < cols; c++) {
      const u = (c / Math.max(1, cols - 1)) * (nb - 1);
      const b0 = Math.min(nb - 1, Math.floor(u));
      const b1 = Math.min(nb - 1, b0 + 1);
      levels[c] = Math.pow(bandAt(f, b0, t) * (b1 - u) + bandAt(f, b1, t) * (u - b0), 0.8);
    }
    return levels;
  }
  const raw = peaksForWindow(signal, t, wSec, cols);
  for (let c = 0; c < cols; c++) {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, c - 1); j <= Math.min(cols - 1, c + 1); j++) {
      sum += Math.abs(raw[j]!);
      n++;
    }
    const u = c / Math.max(1, cols - 1);
    const taper = 0.62 + 0.38 * Math.sin(Math.PI * u);
    // Two jitter octaves → the jagged skyline look (deterministic).
    const jit = (0.9 + 0.2 * hash01(stemIndex * 733 + c, 5)) * (0.78 + 0.44 * hash01(stemIndex * 911 + c, 9));
    levels[c] = Math.pow((sum / n) * taper * jit, 0.8);
  }
  return levels;
}

/** EQ-bars mode — dense segmented columns across a per-stem x-slice, mirrored
 *  about the horizontal axis (LED-equalizer look): each column stacks lit
 *  segments that brighten toward the tip, ends in a hot cap with a glow
 *  flare, and sheds rising spark particles; a luminous strip marks the
 *  mirror axis. Column levels come from engine band envelopes when present
 *  (a true low→high spectrum), else the smoothed windowed peak shape with a
 *  deterministic per-column shimmer and a gentle edge taper. */
function computeEqBars(
  stems: FrameStem[],
  globals: VizWaveParams,
  width: number,
  height: number,
  t: number,
  center: Vec2,
  solo: boolean,
): VizEqGroup[] {
  const glowScale = globals.glowIntensity / 14;
  const minDim = Math.min(width, height);
  const x0 = width * 0.03;
  const sliceW = (width * 0.94) / Math.max(1, stems.length);
  const axisY = center.y;
  const segH = Math.max(3, height * 0.011);
  const segGap = Math.max(1.4, segH * 0.32);
  const pitch = Math.max(9, minDim * 0.03);
  const maxH = height * 0.33;
  const axisH = Math.max(1.5, segH * 0.22);
  const maxSegs = Math.max(1, Math.floor(maxH / (segH + segGap)));
  const out: VizEqGroup[] = [];
  for (let i = 0; i < stems.length; i++) {
    const { cfg, signal } = stems[i]!;
    const audible = isStemAudible(cfg, solo);
    const env = signalEnv(signal, t, 0.05);
    const kick = onsetPulse(signal, t);
    const sx0 = x0 + i * sliceW;
    const inner = sliceW * 0.92;
    const cols = Math.max(6, Math.floor(inner / pitch));
    const step = inner / cols;
    const colW = step * 0.72;
    const cx0 = sx0 + (sliceW - inner) / 2;

    // Column levels 0..1 — same sampling as the radial variant.
    const levels = eqColumnLevels(i, signal, cols, t, globals.waveformLengthSec);
    const act = envActivity(env);
    const amp = maxH * cfg.amplitudeScale * globals.globalAmplitude;

    const segs: number[] = [];
    const tips: number[] = [];
    const tipGlow: number[] = [];
    const sparks: number[] = [];
    for (let c = 0; c < cols; c++) {
      const lvl = levels[c]!;
      const h = lvl * amp;
      if (h < segH * 0.4) continue;
      const x = cx0 + c * step + (step - colW) / 2;
      const cx = x + colW / 2;
      const nSegs = Math.max(1, Math.min(maxSegs, Math.round(h / (segH + segGap))));
      for (let k = 0; k < nSegs; k++) {
        const bright = 0.35 + 0.65 * ((k + 1) / nSegs);
        segs.push(x, axisY - k * (segH + segGap) - segH, colW, segH, bright); // above axis
        segs.push(x, axisY + k * (segH + segGap), colW, segH, bright * 0.62); // mirrored below, dimmer
      }
      const tipY = axisY - (nSegs - 1) * (segH + segGap) - segH;
      const tipYb = axisY + (nSegs - 1) * (segH + segGap);
      tips.push(x, tipY, colW, segH * 0.8, x, tipYb, colW, segH * 0.8);
      tipGlow.push(cx, tipY + segH * 0.4, Math.max(1.5, colW * 0.85));
      // Embers rising off the hot tip — seeded per (stem, column, spark); the
      // rise phase wraps in [0,1) so motion is a pure function of t.
      const nSp = Math.min(EQ_SPARKS_MAX, Math.floor(lvl * lvl * 14 + kick * 4));
      for (let j = 0; j < nSp; j++) {
        const seed = i * 977 + c * 37 + j * 7;
        const s0 = hash01(seed, 0);
        const s1 = hash01(seed, 1);
        const s2 = hash01(seed, 2);
        const s3 = hash01(seed, 3);
        const ph = (t * (0.6 + 1.3 * s2) + s0) % 1;
        const rise = segH * (4 + 12 * s1) * (0.7 + 0.6 * kick + 0.4 * lvl);
        sparks.push(
          cx + (s3 - 0.5) * colW * 4 + Math.sin(6.3 * ph + s0 * 9) * minDim * 0.005,
          tipY - ph * rise,
          Math.max(0.4, (0.9 + 2.4 * s1) * (1 - ph * 0.7) * (0.7 + 0.6 * kick) * Math.max(0.6, minDim / 1080)),
        );
      }
    }

    out.push({
      segs: Float32Array.from(segs),
      tips: Float32Array.from(tips),
      tipGlow: Float32Array.from(tipGlow),
      sparks: Float32Array.from(sparks),
      axis: Float32Array.from([cx0 - step * 0.15, axisY - axisH / 2, inner + step * 0.3, axisH]),
      color: cfg.color,
      tipColor: mixHex(cfg.color, "#FFFFFF", 0.55),
      alpha: (audible ? 0.92 : 0.15) * act,
      glowAlpha: Math.min(1, 0.3 * glowScale + env * 0.5) * (audible ? 1 : 0.15) * act,
      audible,
    });
  }
  return out;
}

/** EQ-bars-radial mode — the `eqbars` LED-column look bent around the
 *  convergence point. Every stem owns an equal wedge of the full circle:
 *  global bar index g = i·cols + c → angle g/N·2π starting at the top
 *  (−90°), so bars are evenly spaced around the midpoint. Each bar is a
 *  constant-angular-width stack of segment quads from the hub radius R0
 *  outward (amplitude × maxLen), brightening toward the outer tip, ending
 *  in a hot cap with a glow flare and shedding sparks that drift outward.
 *  A luminous ring marks R0. Levels/colors/glow/activity are the exact
 *  `eqbars` math — only the placement changes. */
function computeEqRadial(
  stems: FrameStem[],
  globals: VizWaveParams,
  width: number,
  height: number,
  t: number,
  center: Vec2,
  solo: boolean,
): VizEqRadialGroup[] {
  const glowScale = globals.glowIntensity / 14;
  const minDim = Math.min(width, height);
  const R0 = Math.max(0, globals.innerRadius) * minDim; // hub radius — where bars begin (0 = exact center)
  const maxLen = minDim * 0.36; // max radial bar length
  const segH = Math.max(3, minDim * 0.011);
  const segGap = Math.max(1.4, segH * 0.32);
  const pitch = Math.max(9, minDim * 0.03); // tangential pitch (arc px at rMid)
  const ringW = Math.max(1.5, segH * 0.22); // hub ring stroke width
  const rMid = R0 + maxLen / 2; // arc-length reference radius
  const circ = Math.PI * 2 * rMid;
  const cols = Math.max(6, Math.floor(circ / Math.max(1, stems.length) / pitch));
  const total = cols * Math.max(1, stems.length);
  const step = circ / total; // arc px per bar at rMid
  const colW = step * 0.72;
  const ha = colW / 2 / rMid; // angular half-width of a bar (radians)
  const maxSegs = Math.max(1, Math.floor(maxLen / (segH + segGap)));
  const out: VizEqRadialGroup[] = [];
  for (let i = 0; i < stems.length; i++) {
    const { cfg, signal } = stems[i]!;
    const audible = isStemAudible(cfg, solo);
    const env = signalEnv(signal, t, 0.05);
    const kick = onsetPulse(signal, t);
    const levels = eqColumnLevels(i, signal, cols, t, globals.waveformLengthSec);
    const act = envActivity(env);
    const amp = maxLen * cfg.amplitudeScale * globals.globalAmplitude;

    const segs: number[] = [];
    const tips: number[] = [];
    const tipGlow: number[] = [];
    const sparks: number[] = [];
    for (let c = 0; c < cols; c++) {
      const lvl = levels[c]!;
      const h = lvl * amp;
      if (h < segH * 0.4) continue;
      const g = i * cols + c;
      const th = -Math.PI / 2 + (g / total) * Math.PI * 2;
      const dx = Math.cos(th);
      const dy = Math.sin(th);
      const aL = th - ha;
      const aR = th + ha;
      const cL = Math.cos(aL);
      const sL = Math.sin(aL);
      const cR = Math.cos(aR);
      const sR = Math.sin(aR);
      const nSegs = Math.max(1, Math.min(maxSegs, Math.round(h / (segH + segGap))));
      for (let k = 0; k < nSegs; k++) {
        const bright = 0.35 + 0.65 * ((k + 1) / nSegs);
        const rA = R0 + k * (segH + segGap);
        const rB = rA + segH;
        segs.push(
          center.x + cL * rA, center.y + sL * rA,
          center.x + cR * rA, center.y + sR * rA,
          center.x + cR * rB, center.y + sR * rB,
          center.x + cL * rB, center.y + sL * rB,
          bright,
        );
      }
      // Outer edge of the top segment — tip cap covers its outer 80%.
      const rEdge = R0 + (nSegs - 1) * (segH + segGap) + segH;
      const rCap = rEdge - segH * 0.8;
      tips.push(
        center.x + cL * rCap, center.y + sL * rCap,
        center.x + cR * rCap, center.y + sR * rCap,
        center.x + cR * rEdge, center.y + sR * rEdge,
        center.x + cL * rEdge, center.y + sL * rEdge,
      );
      // Chord width of the bar at radius r — scales glow/sparks like colW did.
      const wAt = (r: number) => 2 * r * Math.sin(ha);
      const rGlow = rEdge - segH * 0.4;
      const wTip = wAt(rEdge);
      tipGlow.push(center.x + dx * rGlow, center.y + dy * rGlow, Math.max(1.5, wTip * 0.85));
      // Embers drifting outward off the hot tip — same seeds/phases as
      // `eqbars`, with rise along the ray and jitter along the tangent.
      const nSp = Math.min(EQ_SPARKS_MAX, Math.floor(lvl * lvl * 14 + kick * 4));
      for (let j = 0; j < nSp; j++) {
        const seed = i * 977 + c * 37 + j * 7;
        const s0 = hash01(seed, 0);
        const s1 = hash01(seed, 1);
        const s2 = hash01(seed, 2);
        const s3 = hash01(seed, 3);
        const ph = (t * (0.6 + 1.3 * s2) + s0) % 1;
        const rise = segH * (4 + 12 * s1) * (0.7 + 0.6 * kick + 0.4 * lvl);
        const off = (s3 - 0.5) * wTip * 4 + Math.sin(6.3 * ph + s0 * 9) * minDim * 0.005;
        sparks.push(
          center.x + dx * (rEdge + ph * rise) - dy * off,
          center.y + dy * (rEdge + ph * rise) + dx * off,
          Math.max(0.4, (0.9 + 2.4 * s1) * (1 - ph * 0.7) * (0.7 + 0.6 * kick) * Math.max(0.6, minDim / 1080)),
        );
      }
    }

    out.push({
      segs: Float32Array.from(segs),
      tips: Float32Array.from(tips),
      tipGlow: Float32Array.from(tipGlow),
      sparks: Float32Array.from(sparks),
      ring: Float32Array.from([center.x, center.y, R0, ringW]),
      color: cfg.color,
      tipColor: mixHex(cfg.color, "#FFFFFF", 0.55),
      alpha: (audible ? 0.92 : 0.15) * act,
      glowAlpha: Math.min(1, 0.3 * glowScale + env * 0.5) * (audible ? 1 : 0.15) * act,
      audible,
    });
  }
  return out;
}

const STEREO_ROWS = 300;
const STEREO_ECHO = 0.55;

/** Stereo mode — L/R channel waveforms flow inward and meet along the
 *  vertical center line. y = position in the window (oldest at top), x =
 *  amplitude outward from the line: left channel fills [cx−v, cx], right
 *  [cx, cx+v]. Mono stems reuse the mono peaks on both sides → the center
 *  becomes an exact mirror line (never a single meeting point). */
function computeStereo(
  stems: FrameStem[],
  globals: VizWaveParams,
  width: number,
  height: number,
  t: number,
  center: Vec2,
  solo: boolean,
): VizStereoStem[] {
  const glowScale = globals.glowIntensity / 14;
  const cx = center.x;
  const y0 = height * 0.04;
  const y1 = height * 0.96;
  const n = STEREO_ROWS;
  // Cap horizontal excursion so fills stay inside the frame margins.
  const maxX = Math.max(0, Math.min(cx - width * 0.02, width - cx - width * 0.02));
  const out: VizStereoStem[] = [];
  for (let i = 0; i < stems.length; i++) {
    const { cfg, signal } = stems[i]!;
    const audible = isStemAudible(cfg, solo);
    const stereo = !!(signal.peaksL && signal.peaksR);
    const pL = peaksForWindowFrom(signal.peaksL ?? signal.peaks, t, globals.waveformLengthSec, n);
    const pR = stereo ? peaksForWindowFrom(signal.peaksR!, t, globals.waveformLengthSec, n) : pL;
    const act = Math.max(windowActivity(pL), windowActivity(pR));
    const amp = maxX * cfg.amplitudeScale * globals.globalAmplitude;
    const y = (j: number) => y0 + ((y1 - y0) * j) / (n - 1);

    // Closed fill hugging the line: outer curve down, then back up along cx.
    const side = (peaks: Float32Array, dir: 1 | -1, scale = 1): Float32Array => {
      const pts = new Float32Array((n + 2) * 2);
      for (let j = 0; j < n; j++) {
        pts[j * 2] = cx + dir * Math.abs(peaks[j]!) * amp * scale;
        pts[j * 2 + 1] = y(j);
      }
      pts[n * 2] = cx;
      pts[n * 2 + 1] = y(n - 1);
      pts[(n + 1) * 2] = cx;
      pts[(n + 1) * 2 + 1] = y(0);
      return pts;
    };
    // Open polyline echo (inner scaled trace).
    const echo = (peaks: Float32Array, dir: 1 | -1): Float32Array => {
      const pts = new Float32Array(n * 2);
      for (let j = 0; j < n; j++) {
        pts[j * 2] = cx + dir * Math.abs(peaks[j]!) * amp * STEREO_ECHO;
        pts[j * 2 + 1] = y(j);
      }
      return pts;
    };

    out.push({
      leftFill: side(pL, -1),
      rightFill: side(pR, 1),
      leftEcho: echo(pL, -1),
      rightEcho: echo(pR, 1),
      stereo,
      color: cfg.color,
      alpha: (audible ? 0.55 : 0.12) * act,
      glowAlpha: Math.min(1, 0.3 * glowScale + act * 0.4) * (audible ? 1 : 0.15) * act,
      glowWidth: Math.max(0, cfg.glowRadius * glowScale * 0.5),
      audible,
    });
  }
  return out;
}

const SILK_POINTS = 220;
const SILK_STRANDS = 22;
const SILK_DUST = 46;

/** Spectral ramp for the silk strand gradient, as a function of x: violet at
 *  the far left easing through blue to cyan at the convergence point, and
 *  amber easing through orange-red to magenta at the far right — the dual
 *  glowing-waveform sweep from the reference render. The stem color is mixed
 *  in lightly so per-stem palettes still tint their slice without breaking
 *  the sweep; a quadratic whiten toward the point keeps the middle hot. */
function silkSpectral(x: number, centerX: number, halfSpan: number, tint: string): string {
  const d = Math.max(-1, Math.min(1, (x - centerX) / halfSpan));
  const base = d < 0 ? mixHex("#7B2FE8", "#4FD8FF", 1 + d) : mixHex("#FFC23D", "#FF2E6E", d);
  const hot = (1 - Math.abs(d)) ** 2;
  return mixHex(mixHex(base, tint, 0.18), "#FFFFFF", hot * 0.4);
}

/** Silk mode — every stem owns a horizontal slice of the width; inside it the
 *  |peak| window is drawn as SILK_STRANDS nested copies scaled 0.06→1.0 about
 *  the axis (mirrored above/below), each sampled with a tiny deterministic
 *  temporal offset so the strands fan apart at crests — the silky layered
 *  waveform of the reference. A sin^0.75 taper kills the slices at both ends
 *  → the center gap and outer frame margins go quiet like in the image. */
function computeSilk(
  stems: FrameStem[],
  globals: VizWaveParams,
  width: number,
  height: number,
  t: number,
  center: Vec2,
  solo: boolean,
): VizSilkStem[] {
  const glowScale = globals.glowIntensity / 14;
  const minDim = Math.min(width, height);
  const x0 = width * 0.04;
  const x1 = width * 0.96;
  const sliceW = (x1 - x0) / Math.max(1, stems.length);
  const axisY = center.y;
  const axisH = Math.max(1.2, height * 0.0035);
  const halfSpan = Math.max(1, (x1 - x0) / 2);
  const n = SILK_POINTS;
  const out: VizSilkStem[] = [];
  for (let i = 0; i < stems.length; i++) {
    const { cfg, signal } = stems[i]!;
    const audible = isStemAudible(cfg, solo);
    const env = signalEnv(signal, t, 0.05);
    const kick = onsetPulse(signal, t);
    const a = x0 + i * sliceW + sliceW * 0.015;
    const b = x0 + (i + 1) * sliceW - sliceW * 0.015;
    const span = Math.max(1, b - a);
    const amp = height * 0.37 * cfg.amplitudeScale * globals.globalAmplitude;
    const x = (j: number) => a + (span * j) / (n - 1);
    const taper = (px: number) => {
      const q = Math.min(1, Math.max(0, (px - a) / span));
      return Math.pow(Math.sin(Math.PI * q), 0.75);
    };

    const up = new Float32Array(SILK_STRANDS * n * 2);
    const down = new Float32Array(SILK_STRANDS * n * 2);
    // Un-offset window: activity + dust levels measure the signal at t (a
    // positive strand offset must not leak sound into a silent window).
    const edge = peaksForWindow(signal, t, globals.waveformLengthSec, n);
    for (let k = 0; k < SILK_STRANDS; k++) {
      const s = 0.06 + (0.94 * (k + 1)) / SILK_STRANDS;
      // Per-strand temporal offset — strands diverge at crests (fanned hair).
      const dt = (hash01(i * 131 + k, 3) - 0.5) * 0.028;
      const pk = peaksForWindow(signal, Math.max(0, t + dt), globals.waveformLengthSec, n);
      const off = k * n * 2;
      for (let j = 0; j < n; j++) {
        const v = Math.abs(pk[j]!) * amp * taper(x(j)) * s;
        up[off + j * 2] = x(j);
        up[off + j * 2 + 1] = axisY - v;
        down[off + j * 2] = x(j);
        down[off + j * 2 + 1] = axisY + v;
      }
    }
    const act = windowActivity(edge);

    // Ambient dust — deterministic scatter clustered around the local wave
    // height, twinkling with a per-particle phase.
    const dust = new Float32Array(SILK_DUST * 3);
    for (let j = 0; j < SILK_DUST; j++) {
      const s0 = hash01(i * 911 + j, 0);
      const s1 = hash01(i * 911 + j, 1);
      const s2 = hash01(i * 911 + j, 2);
      const s3 = hash01(i * 911 + j, 3);
      const px = a + s0 * span + (s1 - 0.5) * sliceW * 0.05;
      const lvl = Math.abs(edge[Math.min(n - 1, Math.floor(s0 * n))]!) * amp * taper(px);
      const py = axisY + (s1 < 0.5 ? -1 : 1) * (lvl * (0.3 + 0.8 * s2) + s3 * s3 * minDim * 0.045);
      const tw = 0.5 + 0.5 * Math.sin(t * (2 + 3 * s2) + s3 * 9);
      dust[j * 3] = px;
      dust[j * 3 + 1] = py;
      dust[j * 3 + 2] = Math.max(0.4, (0.5 + 1.7 * s3) * tw * (0.6 + 0.8 * kick) * Math.max(0.6, minDim / 1080));
    }

    // Spectral strand gradient — the middle stop lands exactly on the
    // convergence point when the slice straddles it, else at slice mid.
    const mid = Math.min(0.95, Math.max(0.05, (center.x - a) / span));
    out.push({
      up,
      down,
      strandCount: SILK_STRANDS,
      strandN: n,
      axis: Float32Array.from([a - span * 0.01, axisY - axisH / 2, span * 1.02, axisH]),
      dust,
      gradX0: a,
      gradX1: b,
      gradMid: mid,
      grad0: silkSpectral(a, center.x, halfSpan, cfg.color),
      grad1: silkSpectral(a + mid * span, center.x, halfSpan, cfg.color),
      grad2: silkSpectral(b, center.x, halfSpan, cfg.color),
      color: silkSpectral(a + mid * span, center.x, halfSpan, cfg.color),
      alpha: (audible ? 0.34 : 0.09) * act,
      glowAlpha: Math.min(1, 0.3 * glowScale + env * 0.5 + kick * 0.25) * (audible ? 1 : 0.15) * act,
      glowWidth: Math.max(0, cfg.glowRadius * glowScale * 0.5),
      audible,
    });
  }
  return out;
}

/** Mode dispatch for ONE waveform layer — fills exactly the array matching
 *  `params.mode`. Params are the row's own `visuals` or the globals. */
function computeModeVisuals(
  stems: FrameStem[],
  params: VizWaveParams,
  width: number,
  height: number,
  t: number,
  center: Vec2,
  solo: boolean,
): VizModeVisuals {
  const v: VizModeVisuals = {
    mode: params.mode,
    stems: [],
    rings: [],
    bars: [],
    mirrors: [],
    blocks: [],
    eqbars: [],
    eqradial: [],
    stereos: [],
    silks: [],
    particles: [],
  };
  if (params.mode === "ribbons") v.stems = computeRibbons(stems, params, width, height, t, center, solo);
  else if (params.mode === "circular") v.rings = computeRings(stems, params, width, height, t, center, solo);
  else if (params.mode === "spectrum") v.bars = computeBars(stems, params, width, height, t, solo);
  else if (params.mode === "particles") v.particles = computeParticles(stems, params, width, height, t, center, solo);
  else if (params.mode === "mirror") v.mirrors = computeMirrors(stems, params, width, height, t, center, solo);
  else if (params.mode === "blocks") v.blocks = computeBlocks(stems, params, width, height, t, center, solo);
  else if (params.mode === "eqbars") v.eqbars = computeEqBars(stems, params, width, height, t, center, solo);
  else if (params.mode === "eqradial") v.eqradial = computeEqRadial(stems, params, width, height, t, center, solo);
  else if (params.mode === "stereo") v.stereos = computeStereo(stems, params, width, height, t, center, solo);
  else if (params.mode === "silk") v.silks = computeSilk(stems, params, width, height, t, center, solo);
  return v;
}

export function computeFrame(
  stems: FrameStem[],
  globals: VisualizerGlobals,
  width: number,
  height: number,
  t: number,
): VizFrameState {
  const center: Vec2 = frameCenter(stems, globals, width, height, t);
  const solo = anySolo(stems.map((s) => s.cfg));
  const cell = beatCellIndex(stems, t);

  // Master envelope — drives the convergence star in every mode.
  let master = 0;
  let audibleCount = 0;
  for (const { cfg, signal } of stems) {
    if (isStemAudible(cfg, solo)) {
      const e = signalEnv(signal, t, 0.05);
      master += e * e;
      audibleCount++;
    }
  }
  const masterRms = audibleCount > 0 ? Math.sqrt(master / audibleCount) : 0;
  const minDim = Math.min(width, height);
  const starR = minDim * 0.022 + masterRms * globals.centerConvergence.pulseSensitivity * minDim * 0.09;

  // One channel per visuals row: each draws with its own `visuals` params
  // (falling back to the global look), its own beat center and its own
  // auto-glow roll — hashed with the channel index so stacked layers don't
  // jump identically (index 0 reproduces the historic single-row value).
  const visualChannels: VizFrameState["visualChannels"] = [];
  globals.video.layers.forEach((l, i) => {
    if (l.kind !== "visuals") return;
    const p = l.visuals ?? globals;
    const eff = p.autoGlow.enabled
      ? { ...p, glowIntensity: p.autoGlow.min + (p.autoGlow.max - p.autoGlow.min) * hash01(cell, 77, visualChannels.length) }
      : p;
    const c = frameCenter(stems, p, width, height, t);
    visualChannels.push({ rowIndex: i, visuals: computeModeVisuals(stems, eff, width, height, t, c, solo) });
  });
  const primary = visualChannels[0]?.visuals;

  const state: VizFrameState = {
    mode: primary?.mode ?? globals.mode,
    videoLayers: globals.video.layers.map((l) => ({
      kind: l.kind,
      hidden: l.hidden,
      x: l.x,
      y: l.y,
      opacity: l.opacity,
      scale: l.scale,
      key: l.kind === "media" && l.key.method !== "none" ? l.key : null,
      visible: visibleAt(l.visibility, t),
      ...(l.kind === "media" ? { zoomPan: l.zoomPan } : {}),
    })),
    visualChannels,
    stems: primary?.stems ?? [],
    rings: primary?.rings ?? [],
    bars: primary?.bars ?? [],
    mirrors: primary?.mirrors ?? [],
    blocks: primary?.blocks ?? [],
    eqbars: primary?.eqbars ?? [],
    eqradial: primary?.eqradial ?? [],
    stereos: primary?.stereos ?? [],
    silks: primary?.silks ?? [],
    particles: primary?.particles ?? [],
    dancer: null,
    star: { x: center.x, y: center.y, r: starR, alpha: Math.min(1, 0.55 + masterRms * 2.5) * envActivity(masterRms) },
    t,
  };

  return state;
}
