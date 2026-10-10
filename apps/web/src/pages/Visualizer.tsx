import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import {
  computeDancer,
  computeFrame,
  frameCenter,
  detectStemKind,
  isStemAudible,
  keyVideoFrame,
  resolveStem,
  STEM_KINDS,
  VIZ_CUTOUT_MODELS,
  VIZ_MAX_VIDEO_LAYERS,
  visualsForRow,
  vizVisualsLayer,
  vizVisibilitySchema,
  vizWaveParamsSchema,
  vizZoomPanSchema,
  waveParamsFromGlobals,
  zoomPanRect,
  type DancerConfig,
  type FrameStem,
  type StemKind,
  type StemSignal,
  type VisualizerRenderInput,
  type VisualizerSessionPayload,
  type VizChromaKeyConfig,
  type VizCutoutModel,
  type VizFrameState,
  type VizKeyMethod,
  type VizLayout,
  type VizMediaLayerConfig,
  type VizMode,
  type VizModeVisuals,
  type VizSessionMeta,
  type VizTimeWindow,
  type VizVideoKeyConfig,
  type VizVisibilityConfig,
  type VizWaveParams,
  type VizZoomPanConfig,
  type VisualizerStemInput,
} from "@twio/shared";
import {
  api,
  ASSETS_CHANGED_EVENT,
  isImageFileName,
  type Asset,
  type EngineStatus,
  type VizKeyJob,
  type VizRenderJob,
  type VizRenderedFile,
  type VizSepStatus,
  type VizSplitJob,
  type VizStem,
} from "../api.js";
import { Badge, Button, Card, EmptyState, ProgressBar, Spinner } from "../components/ui.js";

/**
 * Visualizer — audio-reactive stem visuals + procedural dancer.
 * The preview canvas calls the same shared computeFrame()/computeDancer() as
 * the server-side SVG renderer, so what you see is what the MP4 gets —
 * frame-accurate by construction.
 */

const storageKey = (projectId: string) => `twio.visualizer.${projectId}`;

interface PersistedViz {
  stems: VisualizerStemInput[];
  globals: VisualizerGlobals;
  render: { width: number; height: number; fps: number };
  jobId: string | null;
  /** Last saved/loaded server-side session, when any. */
  sessionId?: string | null;
}

type VisualizerGlobals = VisualizerRenderInput["globalVisuals"];

const DEFAULT_VIDEO_KEY: VizVideoKeyConfig = { method: "none", color: "#00FF00", similarity: 0.12, blend: 0.02, despill: true, choke: 0, model: "mediapipe", feather: 1 };

const DEFAULT_GLOBALS: VisualizerGlobals = {
  mode: "ribbons",
  waveformLengthSec: 0.5,
  globalAmplitude: 1,
  glowIntensity: 14,
  autoGlow: { enabled: false, min: 4, max: 24 },
  autoCenter: { enabled: false, range: 0.18 },
  backgroundColor: "#050508",
  innerRadius: 0.12,
  layout: "radial",
  video: { layers: [vizVisualsLayer()] },
  dancer: { enabled: false, style: "neon", scale: 1, intensity: 1, colorMode: "stems", color: "#FFFFFF" },
  centerConvergence: { x: 0.5, y: 0.5, pulseSensitivity: 0.8 },
};

const DEFAULT_RENDER = { width: 1920, height: 1080, fps: 30 };

const MODES: Array<{ value: VizMode; label: string; needsEngine?: boolean }> = [
  { value: "ribbons", label: "Ribbons — waveforms converging to the center" },
  { value: "circular", label: "Circular — concentric waveform rings" },
  { value: "spectrum", label: "Spectrum — per-stem band bars", needsEngine: true },
  { value: "particles", label: "Particles — beat-driven particle field" },
  { value: "mirror", label: "Mirror — mirrored waveforms on one axis" },
  { value: "blocks", label: "Blocks — segmented mirrored columns per stem" },
  { value: "eqbars", label: "EQ Bars — segmented mirrored columns, glowing tips + sparks" },
  { value: "eqradial", label: "EQ Bars Radial — segmented columns radiating from the center" },
  { value: "stereo", label: "Stereo — L/R waveforms meet at the center line" },
  { value: "silk", label: "Silk — stacked mirrored waveform strands, spectral hue sweep" },
];

const LAYOUTS: Array<{ value: VizLayout; label: string }> = [
  { value: "radial", label: "Radial (all directions)" },
  { value: "speakers", label: "Speakers (left/right fans)" },
  { value: "vertical", label: "Vertical (up/down fans)" },
  { value: "fan", label: "Fan (downward spread)" },
];

/** Video background-removal methods (see VIZ_KEY_METHODS in @twio/shared). */
const KEY_METHODS: Array<{ value: VizKeyMethod; label: string }> = [
  { value: "none", label: "Off" },
  { value: "colorkey", label: "Color key — flat color (legacy)" },
  { value: "chromakey", label: "Chroma key — YUV, smoother edges" },
  { value: "hsv", label: "HSV key — hue-aware + edge choke" },
  { value: "cutout", label: "AI cutout — auto person matte (engine)" },
];
const COLOR_KEY_METHODS: ReadonlySet<VizKeyMethod> = new Set(["colorkey", "chromakey", "hsv"]);
const CUTOUT_MODEL_LABELS: Record<VizCutoutModel, string> = {
  mediapipe: "MediaPipe Selfie Segmentation — fast, light edges",
  modnet: "MODNet — slower, cleaner hair edges",
};

/** Layer-row settings are grouped into mini-cards — a titled box per group. */
const LAYER_CARD = "rounded-md border border-slate-700/50 bg-slate-900/50 px-2.5 py-1.5 space-y-1 text-[11px] text-slate-400";
const LAYER_CARD_LABEL = "block text-[9px] font-semibold uppercase tracking-wider text-slate-500";

/** Merge a partial persisted/session shape into a complete PersistedViz,
 *  migrating any legacy video-layer formats along the way. Used for both the
 *  localStorage autosave and server-side session payloads. */
function normalizePersisted(p: Partial<PersistedViz>): PersistedViz {
    // Migrate persisted video configs to the layers stack: rows are either
    // media assets or the `kind:"visuals"` row marking where the mode visuals
    // draw. Old saves (band-model `layer` hints, the flat single-video shape,
    // or a bare video block) always drew the waveforms — restore the visuals
    // row at the under/over boundary so they keep rendering. New-format lists
    // are trusted verbatim: no visuals row → the user removed the waveforms.
    type RawLayer = {
      kind?: unknown;
      assetId?: unknown;
      layer?: unknown;
      hidden?: unknown;
      opacity?: unknown;
      scale?: unknown;
      x?: unknown;
      y?: unknown;
      key?: Partial<VizVideoKeyConfig>;
      chromaKey?: VizChromaKeyConfig;
      visuals?: unknown;
      zoomPan?: unknown;
      visibility?: unknown;
    };
    const num = (x: unknown, d: number) => (typeof x === "number" && Number.isFinite(x) ? x : d);
    const foldKey = (raw: RawLayer): VizVideoKeyConfig => {
      const key: VizVideoKeyConfig = { ...DEFAULT_VIDEO_KEY, ...(raw.key ?? {}) };
      const legacyCk = raw.chromaKey;
      if (key.method === "none" && legacyCk?.enabled) {
        key.method = "colorkey";
        key.color = legacyCk.color ?? key.color;
        key.similarity = legacyCk.similarity ?? key.similarity;
        key.blend = legacyCk.blend ?? key.blend;
        key.despill = false; // the legacy path had no despill
      }
      return key;
    };
    const toLayer = (raw: RawLayer | null | undefined): VizMediaLayerConfig | null => {
      if (!raw || typeof raw !== "object") return null;
      if (raw.kind === "visuals") {
        // Per-row look — validated; invalid/missing → inherits 2. Look.
        const pv2 = vizWaveParamsSchema.safeParse(raw.visuals);
        const pvis = vizVisibilitySchema.safeParse(raw.visibility);
        return {
          kind: "visuals",
          hidden: raw.hidden === true,
          x: num(raw.x, 0.5),
          y: num(raw.y, 0.5),
          opacity: num(raw.opacity, 1),
          scale: num(raw.scale, 1),
          visibility: pvis.success ? pvis.data : { show: [], hide: [] },
          ...(pv2.success ? { visuals: pv2.data } : {}),
        };
      }
      // NB: the deprecated `layer` hint is deliberately NOT carried over — it
      // only steers the visuals-row insertion below (from `raws`). Persisting
      // it would let the server-side fold resurrect a visuals row the user
      // explicitly removed.
      const pzp = vizZoomPanSchema.safeParse(raw.zoomPan);
      const pvis = vizVisibilitySchema.safeParse(raw.visibility);
      return typeof raw.assetId === "string" && raw.assetId
        ? {
            kind: "media",
            assetId: raw.assetId,
            hidden: raw.hidden === true,
            x: num(raw.x, 0.5),
            y: num(raw.y, 0.5),
            opacity: num(raw.opacity, 1),
            scale: num(raw.scale, 1),
            key: foldKey(raw),
            zoomPan: pzp.success ? pzp.data : { zoom: 1, panX: 0.5, panY: 0.5 },
            visibility: pvis.success ? pvis.data : { show: [], hide: [] },
          }
        : null;
    };
    const pv = (p.globals?.video ?? null) as (RawLayer & { layers?: RawLayer[] }) | null;
    let layers: VizMediaLayerConfig[];
    if (!pv) {
      layers = [vizVisualsLayer()];
    } else {
      const raws = Array.isArray(pv.layers) ? pv.layers : [];
      layers = raws.map(toLayer).filter((l): l is VizMediaLayerConfig => l !== null);
      const newFormat = raws.some((r) => !!r && typeof r === "object" && r.kind != null);
      if (!newFormat) {
        let vi = raws.findIndex((r) => !!r && r.layer === "over"); // visuals sat between the bands
        if (vi < 0) vi = layers.length;
        if (typeof pv.assetId === "string" && pv.assetId && !layers.some((l) => l.kind === "media" && l.assetId === pv.assetId)) {
          const media = toLayer({ ...pv, kind: "media" });
          if (media) {
            if (pv.layer === "over") layers.push(media);
            else {
              layers.splice(vi, 0, media);
              vi += 1;
            }
          }
        }
        if (!layers.some((l) => l.kind === "visuals")) layers.splice(vi, 0, vizVisualsLayer());
      } else if (typeof pv.assetId === "string" && pv.assetId && !layers.some((l) => l.kind === "media" && l.assetId === pv.assetId)) {
        const media = toLayer({ ...pv, kind: "media" });
        if (media) layers.push(media);
      }
    }
    return {
      stems: Array.isArray(p.stems) ? p.stems : [],
      globals: { ...DEFAULT_GLOBALS, ...(p.globals ?? {}), dancer: { ...DEFAULT_GLOBALS.dancer, ...(p.globals?.dancer ?? {}) }, autoGlow: { ...DEFAULT_GLOBALS.autoGlow, ...(p.globals?.autoGlow ?? {}) }, video: { layers: layers.slice(0, VIZ_MAX_VIDEO_LAYERS) }, autoCenter: { ...DEFAULT_GLOBALS.autoCenter, ...(p.globals?.autoCenter ?? {}) }, centerConvergence: { ...DEFAULT_GLOBALS.centerConvergence, ...(p.globals?.centerConvergence ?? {}) } },
      render: { ...DEFAULT_RENDER, ...(p.render ?? {}) },
      jobId: typeof p.jobId === "string" ? p.jobId : null,
      sessionId: typeof p.sessionId === "string" ? p.sessionId : null,
    };
}

function loadPersisted(projectId: string): PersistedViz | null {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return null;
    return normalizePersisted(JSON.parse(raw) as Partial<PersistedViz>);
  } catch {
    return null;
  }
}

function mmss(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}.${String(Math.floor((s % 1) * 10))}`;
}

/** Collapsible card section — each module on this page folds via ▸/▾.
 *  `action` stays visible even when collapsed (Upload button etc.). */
function Section({
  icon,
  title,
  action,
  defaultOpen = true,
  children,
}: {
  icon: ReactNode;
  title: ReactNode;
  action?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card className="p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 group min-w-0">
          <span className="text-slate-500">{icon}</span>
          <h3 className="text-sm font-semibold text-slate-300 uppercase tracking-wide group-hover:text-slate-100 truncate">{title}</h3>
          <span className={`text-slate-500 text-xs transition-transform ${open ? "" : "-rotate-90"}`}>▾</span>
        </button>
        {action}
      </div>
      {open && children}
    </Card>
  );
}

/** Dual-thumb range slider — two stacked transparent inputs, thumbs only.
 *  Values are clamped so lo ≤ hi. */
function DualRange({
  min,
  max,
  step,
  lo,
  hi,
  onChange,
  disabled,
}: {
  min: number;
  max: number;
  step: number;
  lo: number;
  hi: number;
  onChange: (lo: number, hi: number) => void;
  disabled?: boolean;
}) {
  const loPct = ((lo - min) / (max - min)) * 100;
  const hiPct = ((hi - min) / (max - min)) * 100;
  const stacked = lo >= hi - step; // thumbs on top of each other → raise lo so it can be pulled back down
  return (
    <div className="dual-range">
      <div className="dual-range-track" />
      <div className="dual-range-fill" style={{ left: `${loPct}%`, width: `${Math.max(0, hiPct - loPct)}%` }} />
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={lo}
        disabled={disabled}
        style={{ zIndex: stacked ? 4 : 3 }}
        onChange={(e) => onChange(Math.min(Number(e.target.value), hi), hi)}
      />
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={hi}
        disabled={disabled}
        style={{ zIndex: 2 }}
        onChange={(e) => onChange(lo, Math.max(Number(e.target.value), lo))}
      />
    </div>
  );
}

// --- Stem strips ---------------------------------------------------------------

const WAVE_COLS = 140;
const WAVE_H = 36;

/** Mini waveform silhouette built from the decoded peak series — the same
 *  data the preview draws, mirrored top/bottom like a classic waveform. */
function StemWave({ signal, color }: { signal: StemSignal; color: string }) {
  const d = useMemo(() => {
    const peaks = signal.peaks;
    if (peaks.length === 0) return null;
    const step = Math.max(1, Math.floor(peaks.length / WAVE_COLS));
    const cols = Math.min(WAVE_COLS, Math.ceil(peaks.length / step));
    const top: string[] = [];
    const bot: string[] = [];
    for (let i = 0; i < cols; i++) {
      let m = 0;
      const end = Math.min(peaks.length, (i + 1) * step);
      for (let j = i * step; j < end; j++) m = Math.max(m, Math.abs(peaks[j]!));
      const y = Math.min(1, m) * (WAVE_H / 2 - 1);
      const x = (((i + 0.5) / cols) * WAVE_COLS).toFixed(2);
      top.push(`${i === 0 ? "M" : "L"}${x},${(WAVE_H / 2 - y).toFixed(2)}`);
      bot.push(`L${x},${(WAVE_H / 2 + y).toFixed(2)}`);
    }
    return `${top.join(" ")} ${bot.reverse().join(" ")} Z`;
  }, [signal]);
  if (!d) return null;
  return (
    <svg viewBox={`0 0 ${WAVE_COLS} ${WAVE_H}`} preserveAspectRatio="none" className="block h-7 w-full" aria-hidden="true">
      <path d={d} fill={color} fillOpacity={0.55} />
      <line x1={0} y1={WAVE_H / 2} x2={WAVE_COLS} y2={WAVE_H / 2} stroke={color} strokeOpacity={0.4} strokeWidth={0.5} />
    </svg>
  );
}

const PHASE_PCT: Record<string, number> = { "decoding audio": 25, "analyzing features": 65, assembling: 90 };

/** Render phases → human labels for the status line + log. */
const RENDER_PHASE_LABELS: Record<string, string> = {
  decode: "Decoding stems",
  keying: "Background removal",
  frames: "Rendering frames",
  mux: "Muxing audio",
  verify: "Verifying output",
};
/** Render phases → share of the overall progress bar (frames dominates). */
const RENDER_PHASE_SPAN: Record<string, [number, number]> = {
  decode: [0, 6],
  keying: [6, 12],
  frames: [12, 97],
  mux: [97, 99.5],
  verify: [99.5, 100],
};
/** Overall render progress 0–100, weighting each phase by its share. */
function renderOverallPct(p: { phase: string; done: number; total: number }): number {
  const [a, b] = RENDER_PHASE_SPAN[p.phase] ?? [0, 100];
  return Math.min(100, a + (b - a) * (p.total > 0 ? Math.min(1, p.done / p.total) : 0));
}
/** "1m 23s" / "4s" — for the render elapsed/ETA readout. */
function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

/** Per-stem analysis bar — fill advances with the real server-side build
 *  phase (decoding → features → assembling); queued stems show a nub. */
function AnalysisBar({ phase, queued }: { phase: string | null; queued: boolean }) {
  const pct = queued ? 4 : (PHASE_PCT[phase ?? ""] ?? 12);
  return (
    <div className="space-y-0.5">
      <ProgressBar value={pct} height="h-1" />
      <p className="text-[10px] text-slate-500">{queued ? "queued" : `${phase ?? "fetching"}…`}</p>
    </div>
  );
}

// --- Canvas drawing -------------------------------------------------------------
// Draws a VizFrameState with Canvas2D — identical geometry to svg.ts.

function pathOf(pts: Float32Array, close = false): Path2D {
  const p = new Path2D();
  if (pts.length >= 4) {
    p.moveTo(pts[0]!, pts[1]!);
    for (let i = 2; i < pts.length; i += 2) p.lineTo(pts[i]!, pts[i + 1]!);
  }
  if (close) p.closePath();
  return p;
}

/** Closed 4-point polygon starting at offset i — the eqradial quad shape. */
function quadAt(pts: Float32Array, i: number): Path2D {
  const p = new Path2D();
  p.moveTo(pts[i]!, pts[i + 1]!);
  p.lineTo(pts[i + 2]!, pts[i + 3]!);
  p.lineTo(pts[i + 4]!, pts[i + 5]!);
  p.lineTo(pts[i + 6]!, pts[i + 7]!);
  p.closePath();
  return p;
}

// Lazily-created offscreen canvas for the chroma-key pass — capped so the
// per-pixel loop stays cheap even when the preview canvas is fullscreen.
let keyCanvas: HTMLCanvasElement | null = null;
let keyCtx: CanvasRenderingContext2D | null = null;

/** Draw the cover-cropped media frame into the key canvas, apply the shared
 *  keying pixel pass (the exact `keyVideoFrame` the MP4 export runs), and
 *  return it as a draw source. Only used for the in-frame color methods —
 *  `cutout` alpha already rides the keyed-WebM <video> element. */
function keyedVideoSource(
  media: HTMLVideoElement | HTMLImageElement,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  w: number,
  h: number,
  key: VizVideoKeyConfig,
): HTMLCanvasElement | null {
  if (!keyCanvas) {
    keyCanvas = document.createElement("canvas");
    keyCtx = keyCanvas.getContext("2d", { willReadFrequently: true });
  }
  if (!keyCtx) return null;
  const scale = Math.min(1, 960 / Math.max(w, h));
  const kw = Math.max(1, Math.round(w * scale));
  const kh = Math.max(1, Math.round(h * scale));
  if (keyCanvas.width !== kw) keyCanvas.width = kw;
  if (keyCanvas.height !== kh) keyCanvas.height = kh;
  keyCtx.drawImage(media, sx, sy, sw, sh, 0, 0, kw, kh);
  const img = keyCtx.getImageData(0, 0, kw, kh);
  keyVideoFrame(img.data, kw, kh, key);
  keyCtx.putImageData(img, 0, 0);
  return keyCanvas;
}

/** Eye / eye-off glyph for the layer show-hide toggle. */
function EyeIcon({ off, className = "" }: { off?: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
      {off && <line x1="3" y1="3" x2="21" y2="21" />}
    </svg>
  );
}

/** The waveform "Look" control set — bound to ANY `VizWaveParams` object: the
 *  global "2. Look" params (base look) or a waveform layer's own `visuals`.
 *  `onChange` gets a partial patch the caller merges into its state. */
function WaveLookControls({ p, onChange, engine }: { p: VizWaveParams; onChange: (patch: Partial<VizWaveParams>) => void; engine: EngineStatus | null }) {
  return (
    <div className="grid md:grid-cols-3 gap-4 text-sm">
      <div className="space-y-2">
        <label className="block text-xs text-slate-400">Mode</label>
        <select className="ui-input w-full" value={p.mode} onChange={(e) => onChange({ mode: e.target.value as VizMode })}>
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>{m.label}{m.needsEngine ? " (engine)" : ""}</option>
          ))}
        </select>
        {p.mode === "spectrum" && !engine?.ok && (
          <p className="text-[11px] text-amber-400">Spectrum needs engine features — set up the Python engine above first.</p>
        )}
        {p.mode === "ribbons" && (
          <>
            <label className="block text-xs text-slate-400 pt-2">Layout</label>
            <select className="ui-input w-full" value={p.layout} onChange={(e) => onChange({ layout: e.target.value as VizLayout })}>
              {LAYOUTS.map((l) => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
          </>
        )}
        {p.mode === "eqradial" && (
          <>
            <label className="block text-xs text-slate-400 pt-2">Inner radius: {Math.round(p.innerRadius * 100)}%</label>
            <input type="range" min={0} max={0.5} step={0.01} value={p.innerRadius} className="w-full" onChange={(e) => onChange({ innerRadius: Number(e.target.value) })} />
          </>
        )}
      </div>
      <div className="space-y-2">
        <label className="block text-xs text-slate-400">Waveform window: {p.waveformLengthSec.toFixed(2)} s</label>
        <input type="range" min={0.1} max={2} step={0.05} value={p.waveformLengthSec} className="w-full" onChange={(e) => onChange({ waveformLengthSec: Number(e.target.value) })} />
        <label className="block text-xs text-slate-400">Global amplitude: {p.globalAmplitude.toFixed(2)}×</label>
        <input type="range" min={0.1} max={3} step={0.05} value={p.globalAmplitude} className="w-full" onChange={(e) => onChange({ globalAmplitude: Number(e.target.value) })} />
        <label className={`block text-xs ${p.autoGlow.enabled ? "text-slate-600" : "text-slate-400"}`}>Glow: {p.glowIntensity.toFixed(0)}</label>
        <input type="range" min={0} max={40} step={1} value={p.glowIntensity} disabled={p.autoGlow.enabled} className="w-full disabled:opacity-40" onChange={(e) => onChange({ glowIntensity: Number(e.target.value) })} />
        <div className="pt-1 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <label className="text-xs text-slate-400">Glow range: {p.autoGlow.min.toFixed(0)}–{p.autoGlow.max.toFixed(0)}</label>
            <Button
              size="sm"
              variant={p.autoGlow.enabled ? "primary" : "ghost"}
              onClick={() => onChange({ autoGlow: { ...p.autoGlow, enabled: !p.autoGlow.enabled } })}
              title="Pick a random glow inside the range on every beat"
            >
              Auto
            </Button>
          </div>
          <DualRange
            min={0}
            max={40}
            step={1}
            lo={p.autoGlow.min}
            hi={p.autoGlow.max}
            onChange={(lo, hi) => onChange({ autoGlow: { ...p.autoGlow, min: lo, max: hi } })}
          />
          {p.autoGlow.enabled && (
            <p className="text-[10px] text-slate-500">Auto is on — glow jumps to a random value in this range on every beat (overrides the slider above).</p>
          )}
        </div>
      </div>
      <div className="space-y-2">
        <div className="rounded-lg border border-slate-700/60 bg-slate-800/40 p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">Center</span>
            <Button
              size="sm"
              variant={p.autoCenter.enabled ? "primary" : "ghost"}
              onClick={() => onChange({ autoCenter: { ...p.autoCenter, enabled: !p.autoCenter.enabled } })}
              title="Move the center to a new spot on every beat"
            >
              Auto
            </Button>
          </div>
          <label className={`block text-xs ${p.autoCenter.enabled ? "text-slate-600" : "text-slate-400"}`}>Center X: {p.centerConvergence.x.toFixed(2)}</label>
          <input type="range" min={0} max={1} step={0.01} value={p.centerConvergence.x} disabled={p.autoCenter.enabled} className="w-full disabled:opacity-40" onChange={(e) => onChange({ centerConvergence: { ...p.centerConvergence, x: Number(e.target.value) } })} />
          <label className={`block text-xs ${p.autoCenter.enabled ? "text-slate-600" : "text-slate-400"}`}>Center Y: {p.centerConvergence.y.toFixed(2)}</label>
          <input type="range" min={0} max={1} step={0.01} value={p.centerConvergence.y} disabled={p.autoCenter.enabled} className="w-full disabled:opacity-40" onChange={(e) => onChange({ centerConvergence: { ...p.centerConvergence, y: Number(e.target.value) } })} />
          {p.autoCenter.enabled && (
            <>
              <label className="block text-xs text-slate-400 pt-1">Motion range: {Math.round(p.autoCenter.range * 100)}%</label>
              <input type="range" min={0} max={0.35} step={0.01} value={p.autoCenter.range} className="w-full" onChange={(e) => onChange({ autoCenter: { ...p.autoCenter, range: Number(e.target.value) } })} />
              <p className="text-[10px] text-slate-500">Auto is on — the center glides to a new spot on every beat (overrides the X/Y sliders).</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** All "2. Look" mode visuals — mirrors svg.ts's modeVisualsSvg so the
 *  visuals layer emits identical shapes wherever it sits in the stack. */
function drawVisuals(ctx: CanvasRenderingContext2D, vis: VizModeVisuals): void {
  for (const s of vis.stems) {
    if (s.glowWidth > 0 && s.glowAlpha > 0.01) {
      const p = pathOf(s.centerline);
      ctx.globalAlpha = Math.min(1, s.glowAlpha * 0.55);
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.glowWidth;
      ctx.stroke(p);
      ctx.globalAlpha = s.glowAlpha;
      ctx.lineWidth = s.glowWidth * 0.45;
      ctx.stroke(p);
    }
    ctx.globalAlpha = s.alpha;
    ctx.fillStyle = s.color;
    ctx.fill(pathOf(s.ribbon, true));
    for (const hpath of s.harmonics) {
      ctx.globalAlpha = s.alpha * 0.45;
      ctx.fill(pathOf(hpath, true));
    }
  }

  for (const r of vis.rings) {
    const p = pathOf(r.points, true);
    if (r.glowWidth > 0 && r.glowAlpha > 0.01) {
      ctx.globalAlpha = r.glowAlpha * 0.5;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.glowWidth;
      ctx.stroke(p);
    }
    ctx.globalAlpha = r.alpha;
    ctx.strokeStyle = r.color;
    ctx.lineWidth = r.lineWidth;
    ctx.stroke(p);
    ctx.globalAlpha = r.alpha * r.fillAlpha;
    ctx.fillStyle = r.color;
    ctx.fill(p);
  }

  for (const g of vis.bars) {
    ctx.globalAlpha = g.alpha;
    ctx.fillStyle = g.color;
    for (let i = 0; i + 3 < g.bars.length; i += 4) {
      ctx.fillRect(g.bars[i]!, g.bars[i + 1]!, g.bars[i + 2]!, g.bars[i + 3]!);
    }
  }

  for (const g of vis.particles) {
    ctx.globalAlpha = g.alpha;
    ctx.fillStyle = g.color;
    for (let i = 0; i + 2 < g.points.length; i += 3) {
      ctx.beginPath();
      ctx.arc(g.points[i]!, g.points[i + 1]!, g.points[i + 2]!, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  for (const m of vis.mirrors) {
    const fp = pathOf(m.fill, true);
    if (m.glowWidth > 0 && m.glowAlpha > 0.01) {
      ctx.globalAlpha = m.glowAlpha * 0.5;
      ctx.strokeStyle = m.color;
      ctx.lineWidth = m.glowWidth;
      ctx.stroke(fp);
    }
    ctx.globalAlpha = m.alpha * 0.4;
    ctx.fillStyle = m.color;
    ctx.fill(fp);
    ctx.globalAlpha = m.alpha;
    ctx.strokeStyle = m.color;
    ctx.lineWidth = 1.4;
    ctx.stroke(fp);
    ctx.globalAlpha = m.alpha * 0.5;
    ctx.lineWidth = 1;
    for (const e of m.echoes) ctx.stroke(pathOf(e));
    ctx.globalAlpha = Math.min(1, m.alpha + 0.25);
    ctx.fillStyle = m.color;
    for (let i = 0; i + 2 < m.dots.length; i += 3) {
      ctx.beginPath();
      ctx.arc(m.dots[i]!, m.dots[i + 1]!, m.dots[i + 2]!, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  for (const g of vis.blocks) {
    if (g.glowAlpha > 0.01) {
      ctx.globalAlpha = g.glowAlpha * 0.35;
      ctx.fillStyle = g.color;
      for (let i = 0; i + 3 < g.rects.length; i += 4) {
        ctx.fillRect(g.rects[i]! - 1, g.rects[i + 1]! - 1, g.rects[i + 2]! + 2, g.rects[i + 3]! + 2);
      }
    }
    ctx.globalAlpha = g.alpha;
    ctx.fillStyle = g.color;
    for (let i = 0; i + 3 < g.rects.length; i += 4) {
      ctx.fillRect(g.rects[i]!, g.rects[i + 1]!, g.rects[i + 2]!, g.rects[i + 3]!);
    }
    ctx.globalAlpha = Math.min(1, g.alpha + 0.3);
    for (let i = 0; i + 2 < g.dots.length; i += 3) {
      ctx.beginPath();
      ctx.arc(g.dots[i]!, g.dots[i + 1]!, g.dots[i + 2]!, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // EQ buckets — same brightness→alpha quantization as the SVG emitter.
  const EQ_BUCKETS = 5;
  const eqAlpha = (bright: number) => {
    const b = Math.min(EQ_BUCKETS - 1, Math.floor(bright * EQ_BUCKETS));
    return (b + 0.5) / EQ_BUCKETS;
  };
  for (const g of vis.eqbars) {
    if (g.glowAlpha > 0.01) {
      ctx.globalAlpha = g.glowAlpha * 0.3;
      ctx.fillStyle = g.color;
      for (let i = 0; i + 4 < g.segs.length; i += 5) {
        ctx.fillRect(g.segs[i]!, g.segs[i + 1]!, g.segs[i + 2]!, g.segs[i + 3]!);
      }
    }
    ctx.fillStyle = g.color;
    for (let i = 0; i + 4 < g.segs.length; i += 5) {
      ctx.globalAlpha = Math.min(1, g.alpha * eqAlpha(g.segs[i + 4]!));
      ctx.fillRect(g.segs[i]!, g.segs[i + 1]!, g.segs[i + 2]!, g.segs[i + 3]!);
    }
    ctx.fillStyle = g.tipColor;
    ctx.globalAlpha = Math.min(1, g.glowAlpha + 0.3);
    for (let i = 0; i + 3 < g.axis.length; i += 4) {
      ctx.fillRect(g.axis[i]!, g.axis[i + 1]!, g.axis[i + 2]!, g.axis[i + 3]!);
    }
    ctx.globalAlpha = g.glowAlpha * 0.6;
    for (let i = 0; i + 2 < g.tipGlow.length; i += 3) {
      ctx.beginPath();
      ctx.arc(g.tipGlow[i]!, g.tipGlow[i + 1]!, g.tipGlow[i + 2]!, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = Math.min(1, g.alpha + 0.2);
    for (let i = 0; i + 3 < g.tips.length; i += 4) {
      ctx.fillRect(g.tips[i]!, g.tips[i + 1]!, g.tips[i + 2]!, g.tips[i + 3]!);
    }
    ctx.globalAlpha = Math.min(1, g.glowAlpha + 0.35);
    for (let i = 0; i + 2 < g.sparks.length; i += 3) {
      ctx.beginPath();
      ctx.arc(g.sparks[i]!, g.sparks[i + 1]!, g.sparks[i + 2]!, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // EQ radial — same brightness→alpha quantization as the SVG emitter.
  for (const g of vis.eqradial) {
    if (g.glowAlpha > 0.01) {
      ctx.globalAlpha = g.glowAlpha * 0.3;
      ctx.fillStyle = g.color;
      for (let i = 0; i + 8 < g.segs.length; i += 9) ctx.fill(quadAt(g.segs, i));
    }
    ctx.fillStyle = g.color;
    for (let i = 0; i + 8 < g.segs.length; i += 9) {
      ctx.globalAlpha = Math.min(1, g.alpha * eqAlpha(g.segs[i + 8]!));
      ctx.fill(quadAt(g.segs, i));
    }
    ctx.strokeStyle = g.tipColor;
    ctx.globalAlpha = Math.min(1, g.glowAlpha + 0.3);
    for (let i = 0; i + 3 < g.ring.length; i += 4) {
      ctx.lineWidth = g.ring[i + 3]!;
      ctx.beginPath();
      ctx.arc(g.ring[i]!, g.ring[i + 1]!, g.ring[i + 2]!, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = g.tipColor;
    ctx.globalAlpha = g.glowAlpha * 0.6;
    for (let i = 0; i + 2 < g.tipGlow.length; i += 3) {
      ctx.beginPath();
      ctx.arc(g.tipGlow[i]!, g.tipGlow[i + 1]!, g.tipGlow[i + 2]!, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = Math.min(1, g.alpha + 0.2);
    for (let i = 0; i + 7 < g.tips.length; i += 8) ctx.fill(quadAt(g.tips, i));
    ctx.globalAlpha = Math.min(1, g.glowAlpha + 0.35);
    for (let i = 0; i + 2 < g.sparks.length; i += 3) {
      ctx.beginPath();
      ctx.arc(g.sparks[i]!, g.sparks[i + 1]!, g.sparks[i + 2]!, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  for (const s of vis.stereos) {
    for (const fill of [s.leftFill, s.rightFill]) {
      const fp = pathOf(fill, true);
      if (s.glowWidth > 0 && s.glowAlpha > 0.01) {
        ctx.globalAlpha = s.glowAlpha * 0.5;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = s.glowWidth;
        ctx.stroke(fp);
      }
      ctx.globalAlpha = s.alpha * 0.45;
      ctx.fillStyle = s.color;
      ctx.fill(fp);
      ctx.globalAlpha = s.alpha;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.2;
      ctx.stroke(fp);
    }
    ctx.globalAlpha = s.alpha * 0.5;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1;
    ctx.stroke(pathOf(s.leftEcho));
    ctx.stroke(pathOf(s.rightEcho));
  }

  // Silk — the strand pack (up+down subpaths in one Path2D) stroked with the
  // spectral gradient, the scale-1 edge re-stroked brighter, gradient axis
  // strip + white core, then dust. Same emit order as svg.ts.
  for (const s of vis.silks) {
    const grad = ctx.createLinearGradient(s.gradX0, 0, s.gradX1, 0);
    grad.addColorStop(0, s.grad0);
    grad.addColorStop(Math.min(0.98, Math.max(0.02, s.gradMid)), s.grad1);
    grad.addColorStop(1, s.grad2);
    const pack = new Path2D();
    for (const packed of [s.up, s.down]) {
      for (let k = 0; k < s.strandCount; k++) {
        const off = k * s.strandN * 2;
        pack.moveTo(packed[off]!, packed[off + 1]!);
        for (let j = 1; j < s.strandN; j++) pack.lineTo(packed[off + j * 2]!, packed[off + j * 2 + 1]!);
      }
    }
    if (s.glowWidth > 0 && s.glowAlpha > 0.01) {
      ctx.globalAlpha = s.glowAlpha * 0.35;
      ctx.strokeStyle = grad;
      ctx.lineWidth = Math.max(2, s.glowWidth * 0.4);
      ctx.stroke(pack);
    }
    ctx.globalAlpha = s.alpha;
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1;
    ctx.stroke(pack);
    const eoff = (s.strandCount - 1) * s.strandN * 2;
    ctx.globalAlpha = Math.min(1, s.alpha + 0.45);
    ctx.lineWidth = 1.6;
    ctx.stroke(pathOf(s.up.subarray(eoff, eoff + s.strandN * 2)));
    ctx.stroke(pathOf(s.down.subarray(eoff, eoff + s.strandN * 2)));
    ctx.globalAlpha = Math.min(1, s.glowAlpha + 0.4);
    ctx.fillStyle = grad;
    ctx.fillRect(s.axis[0]!, s.axis[1]!, s.axis[2]!, s.axis[3]!);
    ctx.globalAlpha = Math.min(1, s.glowAlpha + 0.25);
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(s.axis[0]!, s.axis[1]! + s.axis[3]! * 0.3, s.axis[2]!, s.axis[3]! * 0.4);
    ctx.globalAlpha = Math.min(1, s.alpha + 0.3);
    ctx.fillStyle = s.color;
    for (let i = 0; i + 2 < s.dust.length; i += 3) {
      ctx.beginPath();
      ctx.arc(s.dust[i]!, s.dust[i + 1]!, s.dust[i + 2]!, 0, Math.PI * 2);
      ctx.fill();
    }
  }

}

/** Offscreen buffer for visuals layers drawn with opacity < 1 or scale ≠ 1:
 *  compositing the rendered visuals once keeps the row's opacity a multiplier
 *  over every sub-path — mirroring the export's <g opacity transform>. */
let visualsCanvas: HTMLCanvasElement | null = null;
let visualsCtx: CanvasRenderingContext2D | null = null;

function drawState(
  ctx: CanvasRenderingContext2D,
  state: VizFrameState,
  w: number,
  h: number,
  bg: string,
  media?: ReadonlyArray<HTMLVideoElement | HTMLImageElement | null>,
): void {
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // The layer stack — row order is the z-order, iterated exactly like
  // frameSvg. Media rows draw their element cover-cropped + scaled about the
  // frame center; a visuals row draws the whole mode-visual set at that
  // position (absent → no waveforms at all). Dancer + star stay on top.
  state.videoLayers.forEach((v, i) => {
    if (v.hidden || v.visible === false || v.opacity <= 0) return;
    const dw = w * v.scale;
    const dh = h * v.scale;
    const dx = v.x * w - dw / 2;
    const dy = v.y * h - dh / 2;
    if (v.kind === "visuals") {
      const vis = visualsForRow(state, i); // this row's own mode geometry
      if (v.opacity >= 0.999 && v.scale === 1 && v.x === 0.5 && v.y === 0.5) {
        drawVisuals(ctx, vis);
        return;
      }
      if (!visualsCanvas) {
        visualsCanvas = document.createElement("canvas");
        visualsCtx = visualsCanvas.getContext("2d");
      }
      if (!visualsCtx) return;
      if (visualsCanvas.width !== w) visualsCanvas.width = w;
      if (visualsCanvas.height !== h) visualsCanvas.height = h;
      visualsCtx.clearRect(0, 0, w, h);
      drawVisuals(visualsCtx, vis);
      ctx.globalAlpha = v.opacity;
      ctx.drawImage(visualsCanvas, dx, dy, dw, dh);
      ctx.globalAlpha = 1;
      return;
    }
    const el = media?.[i];
    if (!el) return;
    const isVid = el instanceof HTMLVideoElement;
    const srcW = isVid ? el.videoWidth : el.naturalWidth;
    const srcH = isVid ? el.videoHeight : el.naturalHeight;
    const ready = isVid ? el.readyState >= 2 : el.complete;
    if (!ready || srcW === 0 || srcH === 0) return;
    // Source-crop window — the layer's zoom/pan selects which part of the
    // media fills the tile (defaults reproduce the centered cover-fit).
    const r = zoomPanRect(srcW, srcH, w, h, v.zoomPan ?? { zoom: 1, panX: 0.5, panY: 0.5 });
    const { sx, sy, sw, sh } = r;
    ctx.globalAlpha = v.opacity;
    // Color methods key the drawn pixels via the shared pass; `cutout` draws
    // the keyed WebM directly (its alpha is baked into the frames).
    if (v.key && v.key.method !== "cutout") {
      const src = keyedVideoSource(el, sx, sy, sw, sh, w, h, v.key);
      if (src) ctx.drawImage(src, dx, dy, dw, dh);
    } else {
      ctx.drawImage(el, sx, sy, sw, sh, dx, dy, dw, dh);
    }
    ctx.globalAlpha = 1;
  });

  const dn = state.dancer;
  if (dn) {
    if (dn.glowWidth > 0) {
      ctx.shadowColor = dn.limbs[0]?.color ?? "#fff";
      ctx.shadowBlur = dn.glowWidth;
    }
    for (const limb of dn.limbs) {
      ctx.globalAlpha = limb.alpha;
      ctx.fillStyle = limb.color;
      ctx.fill(pathOf(limb.path, true));
    }
    for (const s of dn.strokes) {
      ctx.globalAlpha = s.alpha;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = Math.max(1.2, dn.glowWidth * 0.16);
      ctx.stroke(pathOf(s.points));
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = dn.head.alpha;
    ctx.fillStyle = dn.head.color;
    ctx.beginPath();
    ctx.arc(dn.head.x, dn.head.y, dn.head.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = dn.alpha * 0.8;
    ctx.fillStyle = dn.jointColor;
    const jr = Math.max(1.2, dn.head.r * 0.16);
    for (let i = 0; i + 1 < dn.joints.length; i += 2) {
      ctx.beginPath();
      ctx.arc(dn.joints[i]!, dn.joints[i + 1]!, jr, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (state.star.r > 0.5) {
    const grad = ctx.createRadialGradient(state.star.x, state.star.y, 0, state.star.x, state.star.y, state.star.r);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.35, "rgba(255,247,224,0.55)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.globalAlpha = state.star.alpha;
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(state.star.x, state.star.y, state.star.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// --- Component -------------------------------------------------------------------

export function Visualizer({
  projectId,
  onToast,
}: {
  projectId: string;
  onToast: (text: string, tone?: "info" | "success" | "error") => void;
}) {
  const initialRef = useRef<PersistedViz | null | undefined>(undefined);
  if (initialRef.current === undefined) initialRef.current = loadPersisted(projectId);
  const initial = initialRef.current;

  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [stems, setStems] = useState<VizStem[]>([]);
  const [stemInputs, setStemInputs] = useState<VisualizerStemInput[]>(initial?.stems ?? []);
  const [globals, setGlobals] = useState<VisualizerGlobals>(initial?.globals ?? DEFAULT_GLOBALS);
  const [renderSettings, setRenderSettings] = useState(initial?.render ?? DEFAULT_RENDER);
  const [job, setJob] = useState<VizRenderJob | null>(null);
  const [renders, setRenders] = useState<VizRenderedFile[]>([]);
  // Render log — appended per phase transition / ~10% checkpoint / detail
  // change while polling a running job; reset when a new render starts.
  const [renderLog, setRenderLog] = useState<string[]>([]);
  const lastLogMarkRef = useRef<{ phase: string; mark: number; detail: string }>({ phase: "", mark: -1, detail: "" });
  const renderLogRef = useRef<HTMLPreElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // Song → stems separation (engine-backed job; stems land in the pool).
  const splitFileRef = useRef<HTMLInputElement>(null);
  const [splitQuality, setSplitQuality] = useState<"fast" | "hq">("fast");
  const [splitJob, setSplitJob] = useState<VizSplitJob | null>(null);
  const [sep, setSep] = useState<VizSepStatus | null>(null);

  // Sessions — named server-side snapshots of the whole setup + media.
  const [sessions, setSessions] = useState<VizSessionMeta[]>([]);
  const [sessionName, setSessionName] = useState("");
  /** The session the current state was last loaded from / saved to. */
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initial?.sessionId ?? null);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");

  // Preview state
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Hidden media elements feeding the preview — one per layer row index
   *  (<video> for video/keyed sources, <img> for image layers). */
  const layerElsRef = useRef(new Map<number, HTMLVideoElement | HTMLImageElement>());
  const signalsRef = useRef(new Map<string, StemSignal>());
  const [signalsReady, setSignalsReady] = useState(0); // bump to re-render
  const [playing, setPlaying] = useState(false);
  const [scrubT, setScrubT] = useState(0);
  const audioRef = useRef<{
    ctx: AudioContext;
    buffers: Map<string, AudioBuffer>;
    gains: Map<string, GainNode>;
    master: GainNode;
    startedAt: number; // ctx.currentTime when playback began
    offset: number; // media offset at playback start
  } | null>(null);
  /** Live sources keyed by stem name — lets mid-playback additions join
   *  without restarting the stems already sounding. */
  const sourcesRef = useRef(new Map<string, AudioBufferSourceNode>());

  // Media-layer list drag & drop: index of the row being dragged + the row
  // currently hovered as a drop target (drives the highlight ring).
  const [dragLayer, setDragLayer] = useState<number | null>(null);
  const [dropLayer, setDropLayer] = useState<number | null>(null);
  // Row-drag gate: a row only becomes `draggable` once a press on it has
  // moved mostly VERTICALLY — horizontal gestures belong to the row's own
  // sliders/selects. The ⠿ grip arms instantly (it exists only to drag).
  const [armedRow, setArmedRow] = useState<number | null>(null);
  const dragGateRef = useRef<{ i: number; x: number; y: number } | null>(null);
  // Releasing the button anywhere disarms — a stale armed row would turn
  // the next slider drag into a row drag.
  useEffect(() => {
    const up = () => {
      dragGateRef.current = null;
      setArmedRow(null);
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  // Add-layer picker popover: open state, name filter, kind toggles.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQ, setPickerQ] = useState("");
  const [pickerVideo, setPickerVideo] = useState(true);
  const [pickerImage, setPickerImage] = useState(true);

  // Downloaded project assets eligible as media layers (videos and images).
  const [videoAssets, setVideoAssets] = useState<Asset[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .searchAssetsAdvanced({ downloadedOnly: true, sort: "newest_downloaded", limit: 200 }, projectId)
        .then((r) => {
          if (!cancelled) setVideoAssets(r.assets);
        })
        .catch(() => {});
    load();
    window.addEventListener(ASSETS_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(ASSETS_CHANGED_EVENT, load);
    };
  }, [projectId]);

  const loadStems = useCallback(async () => {
    const r = await api.vizStems(projectId);
    setStems(r.stems);
    return r.stems;
  }, [projectId]);

  const loadRenders = useCallback(async () => {
    const r = await api.vizRenders(projectId);
    setRenders(r.renders);
  }, [projectId]);

  const loadSessions = useCallback(async () => {
    const r = await api.vizSessions(projectId);
    setSessions(r.sessions);
  }, [projectId]);

  // Engine status: poll once on mount, then only while provisioning runs.
  const refreshEngine = useCallback(() => {
    api.engineStatus().then(setEngine).catch(() => setEngine(null));
  }, []);
  useEffect(() => {
    refreshEngine();
  }, [refreshEngine]);
  useEffect(() => {
    if (!engine || engine.ok || engine.disabled || engine.phase === "idle" || engine.phase === "error") return;
    const t = setInterval(refreshEngine, 2000);
    return () => clearInterval(t);
  }, [engine, refreshEngine]);

  // Separation extras status — once on mount, then only while installing.
  const refreshSep = useCallback(() => {
    api.vizSepStatus().then((r) => setSep(r.sep)).catch(() => {});
  }, []);
  useEffect(() => {
    refreshSep();
  }, [refreshSep]);
  useEffect(() => {
    if (!sep || sep.installed || sep.phase === "idle" || sep.phase === "error") return;
    const t = setInterval(refreshSep, 2500);
    return () => clearInterval(t);
  }, [sep, refreshSep]);

  // Restore session for this project + load stems/renders.
  useEffect(() => {
    const saved = loadPersisted(projectId);
    setStemInputs(saved?.stems ?? []);
    setGlobals(saved?.globals ?? DEFAULT_GLOBALS);
    setRenderSettings(saved?.render ?? DEFAULT_RENDER);
    setJob(null);
    setActiveSessionId(saved?.sessionId ?? null);
    setSessionName("");
    setSessions([]);
    setRenamingId(null);
    signalsRef.current.clear();
    if (saved?.jobId) {
      api.vizRenderJob(saved.jobId).then((r) => setJob(r.job)).catch(() => {});
    }
    loadStems()
      .then((list) => {
        const names = new Set(list.map((s) => s.name));
        // Drop persisted stem configs whose file no longer exists.
        setStemInputs((cur) => cur.filter((s) => names.has(s.name)));
      })
      .catch((e) => setError((e as Error).message));
    loadRenders().catch(() => {});
    loadSessions().catch(() => {});
  }, [projectId, loadStems, loadRenders, loadSessions]);

  // Persist session.
  useEffect(() => {
    try {
      localStorage.setItem(storageKey(projectId), JSON.stringify({ stems: stemInputs, globals, render: renderSettings, jobId: job?.id ?? null, sessionId: activeSessionId } satisfies PersistedViz));
    } catch { /* best-effort */ }
  }, [projectId, stemInputs, globals, renderSettings, job?.id, activeSessionId]);

  // Fetch signals for preview whenever the stem selection changes.
  const [decodingName, setDecodingName] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const s of stemInputs) {
        if (!signalsRef.current.has(s.name) && !failedSignals.current.has(s.name)) {
          try {
            if (!cancelled) setDecodingName(s.name);
            const sig = await api.vizStemSignal(projectId, s.name);
            if (!cancelled) {
              signalsRef.current.set(s.name, sig);
              failedSignals.current.delete(s.name);
              setSignalsReady((n) => n + 1);
            }
          } catch (e) {
            if (!cancelled) {
              failedSignals.current.set(s.name, (e as Error).message);
              setError(`Could not decode stem "${s.name}" for preview: ${(e as Error).message}`);
              setSignalsReady((n) => n + 1);
            }
          } finally {
            if (!cancelled) setDecodingName(null);
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, stemInputs, signalsReady]);

  // Poll the server's build phase while a signal fetch is in flight.
  const [sigPhase, setSigPhase] = useState<string | null>(null);
  useEffect(() => {
    if (!decodingName) {
      setSigPhase(null);
      return;
    }
    const t = setInterval(() => {
      api
        .vizStemSignalStatus(projectId, decodingName)
        .then((r) => setSigPhase(r.phase))
        .catch(() => {});
    }, 500);
    return () => clearInterval(t);
  }, [projectId, decodingName]);

  const pushRenderLog = (line: string) =>
    setRenderLog((ls) => [...ls.slice(-199), `${new Date().toLocaleTimeString()}  ${line}`]);

  // Poll active render — also append log lines on phase transitions,
  // ~10% checkpoints within a phase, and detail changes (non-frames phases).
  useEffect(() => {
    if (!job || job.status !== "running") return;
    const t = setInterval(() => {
      api
        .vizRenderJob(job.id)
        .then((r) => {
          setJob(r.job);
          const p = r.job.progress;
          const mark = lastLogMarkRef.current;
          const label = RENDER_PHASE_LABELS[p.phase] ?? p.phase;
          if (p.phase !== mark.phase) {
            pushRenderLog(`▸ ${label}`);
            mark.phase = p.phase;
            mark.mark = -1;
            mark.detail = "";
          }
          const pct10 = p.total > 0 ? Math.floor((p.done / p.total) * 10) : -1;
          if (p.detail && p.detail !== mark.detail && p.phase !== "frames") {
            mark.detail = p.detail;
            pushRenderLog(`${label} — ${p.detail}${p.total ? ` (${p.done}/${p.total})` : ""}`);
          } else if (pct10 > mark.mark) {
            mark.mark = pct10;
            pushRenderLog(`${label} — ${p.done}/${p.total}`);
          }
          if (r.job.status === "done") {
            pushRenderLog(`✔ done — ${r.job.frameCount} frames`);
            onToast("Visualizer rendered", "success");
            loadRenders().catch(() => {});
          } else if (r.job.status === "failed") {
            pushRenderLog(`✖ failed — ${r.job.error?.message ?? "unknown error"}`);
            onToast(`Render failed: ${r.job.error?.message ?? "unknown error"}`, "error");
          } else if (r.job.status === "cancelled") {
            pushRenderLog("■ cancelled");
          }
        })
        .catch(() => {});
    }, 1000);
    return () => clearInterval(t);
  }, [job, onToast, loadRenders]);

  // Keep the render log scrolled to its newest line.
  useEffect(() => {
    renderLogRef.current?.scrollTo(0, renderLogRef.current.scrollHeight);
  }, [renderLog]);

  // --- AI cutout (keyed WebM) ---------------------------------------------------
  // The engine bakes a transparent WebM of a layer's video; the preview's
  // <video> element then plays it directly (alpha rides the frames) and the
  // export decodes the same file — no duplicated keying code. Jobs are tracked
  // per (assetId, key params) — the composite key makes stale-params detection
  // automatic: tweak a param and the row simply has no job for its new key.
  const [keyJobs, setKeyJobs] = useState<Map<string, VizKeyJob>>(new Map());
  const cutoutKeyOf = (l: VizMediaLayerConfig & { kind: "media" }) => `${l.assetId}|${JSON.stringify(l.key)}`;
  const cutoutJobFor = (l: VizMediaLayerConfig): VizKeyJob | null =>
    l.kind === "media" && l.key.method === "cutout" ? keyJobs.get(cutoutKeyOf(l)) ?? null : null;
  /** The keyed WebM URL when this layer's cutout is live (done + params match). */
  const keyedUrlFor = (l: VizMediaLayerConfig): string | null => {
    const j = cutoutJobFor(l);
    return j?.status === "done" && j.url ? j.url : null;
  };
  /** A finished job exists for this asset under different params → regenerate hint. */
  const cutoutStaleFor = (l: VizMediaLayerConfig): boolean =>
    l.kind === "media" && l.key.method === "cutout" && !cutoutJobFor(l) &&
    [...keyJobs.keys()].some((k) => k.startsWith(`${l.assetId}|`));

  const startCutout = async (l: VizMediaLayerConfig) => {
    if (l.kind !== "media") return;
    setError(null);
    const mapKey = cutoutKeyOf(l);
    try {
      const r = await api.vizVideoKey(projectId, l.assetId, l.key);
      setKeyJobs((m) => new Map(m).set(mapKey, r.job));
      if (r.job.status === "done" && r.job.url) {
        onToast("Cutout ready — keyed video is live in the preview", "success");
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // Poll all active keying jobs (id "cached" jobs are already done — skip).
  useEffect(() => {
    const running = [...keyJobs.entries()].filter(([, j]) => j.status === "running" && j.id !== "cached");
    if (running.length === 0) return;
    const t = setInterval(() => {
      for (const [mapKey, j] of running) {
        api
          .vizVideoKeyJob(j.id)
          .then((r) => {
            setKeyJobs((m) => new Map(m).set(mapKey, r.job));
            if (r.job.status === "done") {
              onToast("Cutout ready — keyed video is live in the preview", "success");
            } else if (r.job.status === "failed") {
              onToast(`Cutout failed: ${r.job.error?.message ?? "unknown error"}`, "error");
            }
          })
          .catch(() => {});
      }
    }, 800);
    return () => clearInterval(t);
  }, [keyJobs, onToast]);

  /** Stems whose signal fetch failed → per-stem error text shown next to the
   *  stem (instead of silently vanishing from the preview). */
  const failedSignals = useRef(new Map<string, string>());

  /** Forget a failed decode and re-fetch the stem's signal. */
  const retrySignal = useCallback((name: string) => {
    failedSignals.current.delete(name);
    signalsRef.current.delete(name);
    setSignalsReady((n) => n + 1);
  }, []);

  // --- Fullscreen preview -----------------------------------------------------
  const previewBoxRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [lookOpen, setLookOpen] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === previewBoxRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void previewBoxRef.current?.requestFullscreen().catch(() => {});
  }, []);

  // Solo audition — one shared <audio> element plays the raw stem file,
  // independent of the preview's WebAudio mix.
  const auditionRef = useRef<HTMLAudioElement | null>(null);
  const [auditioning, setAuditioning] = useState<string | null>(null);

  const stopAudition = useCallback(() => {
    auditionRef.current?.pause();
    setAuditioning(null);
  }, []);

  const toggleAudition = useCallback(
    (stem: VizStem) => {
      if (auditioning === stem.name) {
        stopAudition();
        return;
      }
      const a = (auditionRef.current ??= new Audio());
      a.onended = () => setAuditioning(null);
      a.src = stem.url;
      a.play().catch((e) => {
        setError(`Cannot play "${stem.name}": ${(e as Error).message}`);
        setAuditioning(null);
      });
      setAuditioning(stem.name);
    },
    [auditioning, stopAudition],
  );

  // Stop any audition when the project changes / page unmounts.
  useEffect(() => {
    return () => {
      auditionRef.current?.pause();
      auditionRef.current = null;
    };
  }, [projectId]);

  const resolvedStems: FrameStem[] = useMemo(
    () =>
      stemInputs
        .map((s, i) => ({ cfg: resolveStem(s, i), signal: signalsRef.current.get(s.name) }))
        .filter((x): x is FrameStem & { signal: StemSignal } => !!x.signal)
        .map((x) => ({ cfg: x.cfg, signal: x.signal })),
    [stemInputs, signalsReady],
  );

  const duration = useMemo(() => Math.max(0, ...resolvedStems.map((s) => s.signal.durationSec)), [resolvedStems]);
  const anySoloOn = stemInputs.some((s) => s.solo);

  // --- WebAudio stem mix ----------------------------------------------------
  // The graph is persistent: one GainNode per stem → master → destination.
  // Sources are started/stopped per stem, so stems added while playing join
  // the mix at the current position (no restart of the ones already playing),
  // and mute/solo flips only move gain values — zero audio restarts.
  const ensureAudio = useCallback(async (): Promise<NonNullable<typeof audioRef.current>> => {
    if (!audioRef.current) {
      const ctx = new AudioContext();
      const master = ctx.createGain();
      master.connect(ctx.destination);
      audioRef.current = { ctx, buffers: new Map(), gains: new Map(), master, startedAt: 0, offset: 0 };
    }
    const a = audioRef.current;
    // Decode any stems we haven't buffered yet — also runs mid-playback when
    // a newly added stem's signal has just arrived.
    for (const s of resolvedStems) {
      if (a.buffers.has(s.cfg.name)) continue;
      const stemMeta = stems.find((m) => m.name === s.cfg.name);
      if (!stemMeta) continue;
      try {
        const buf = await a.ctx.decodeAudioData(await (await fetch(stemMeta.url)).arrayBuffer());
        a.buffers.set(s.cfg.name, buf);
      } catch { /* stem stays silent in preview */ }
    }
    return a;
  }, [resolvedStems, stems]);

  // Close the AudioContext on unmount / project switch.
  useEffect(() => {
    return () => {
      void audioRef.current?.ctx.close().catch(() => {});
      audioRef.current = null;
    };
  }, [projectId]);

  const stopSources = useCallback(() => {
    for (const src of sourcesRef.current.values()) {
      try {
        src.stop();
      } catch { /* already stopped */ }
    }
    sourcesRef.current.clear();
  }, []);

  /** Current playback position derived from the AudioContext clock. */
  const playbackT = useCallback((): number => {
    const a = audioRef.current;
    return a ? a.offset + (a.ctx.currentTime - a.startedAt) : 0;
  }, []);

  /** Live-update per-stem gains from mute/solo state (no source restarts). */
  const applyMix = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    const nAudible = Math.max(1, resolvedStems.filter((s) => isStemAudible(s.cfg, anySoloOn)).length);
    for (const { cfg } of resolvedStems) {
      const g = a.gains.get(cfg.name);
      if (g) g.gain.value = isStemAudible(cfg, anySoloOn) ? 1 / nAudible : 0;
    }
  }, [resolvedStems, anySoloOn]);

  /** Bring the running sources in line with `resolvedStems`: start sources
   *  for stems that lack one at the current playback position, stop sources
   *  whose stem was removed. `restart` stops everything first (Play/scrub). */
  const syncSources = useCallback(
    (restart: boolean) => {
      const a = audioRef.current;
      if (!a) return;
      const t = playbackT();
      if (restart) stopSources();
      const names = new Set(resolvedStems.map((s) => s.cfg.name));
      for (const [name, src] of sourcesRef.current) {
        if (!names.has(name)) {
          try {
            src.stop();
          } catch { /* already stopped */ }
          sourcesRef.current.delete(name);
        }
      }
      const nAudible = Math.max(1, resolvedStems.filter((s) => isStemAudible(s.cfg, anySoloOn)).length);
      for (const { cfg } of resolvedStems) {
        if (sourcesRef.current.has(cfg.name)) continue;
        const buf = a.buffers.get(cfg.name);
        // A stem shorter than the mix goes silent when it ends — same as the
        // rendered MP4 (no looping of short stems in the preview either).
        if (!buf || buf.duration <= 0 || t >= buf.duration) continue;
        let gain = a.gains.get(cfg.name);
        if (!gain) {
          gain = a.ctx.createGain();
          gain.connect(a.master);
          a.gains.set(cfg.name, gain);
        }
        gain.gain.value = isStemAudible(cfg, anySoloOn) ? 1 / nAudible : 0;
        const src = a.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(gain);
        src.onended = () => {
          if (sourcesRef.current.get(cfg.name) === src) sourcesRef.current.delete(cfg.name);
        };
        src.start(0, t);
        sourcesRef.current.set(cfg.name, src);
      }
    },
    [resolvedStems, anySoloOn, playbackT, stopSources],
  );

  // Stems added while playing join the mix; removed/muted ones drop out.
  useEffect(() => {
    if (!playing) return;
    void ensureAudio().then(() => {
      syncSources(false);
      applyMix();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedStems, anySoloOn]);

  const startPlayback = useCallback(
    async (offset: number) => {
      const a = await ensureAudio();
      await a.ctx.resume(); // autoplay policy / tab-hidden suspend
      stopSources();
      a.offset = offset;
      a.startedAt = a.ctx.currentTime;
      syncSources(false);
      setPlaying(true);
    },
    [ensureAudio, stopSources, syncSources],
  );

  const pausePlayback = useCallback(() => {
    if (!audioRef.current) return;
    setScrubT(Math.min(duration, playbackT()));
    stopSources();
    setPlaying(false);
  }, [duration, playbackT, stopSources]);

  const playingRef = useRef(playing);
  playingRef.current = playing;
  const scrubRef = useRef(scrubT);
  scrubRef.current = scrubT;

  // Fullscreen click-to-play/pause — e.detail disambiguates it from the
  // double-click-to-exit gesture on the container: the first click arms a
  // short timer, the second click of a double-click cancels it, so exiting
  // fullscreen never toggles playback. A brief ▶/⏸ glyph flashes as feedback.
  const clickTimerRef = useRef<number | null>(null);
  const fsFlashTimerRef = useRef<number | null>(null);
  const [fsFlash, setFsFlash] = useState<"play" | "pause" | null>(null);
  useEffect(
    () => () => {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
      if (fsFlashTimerRef.current) clearTimeout(fsFlashTimerRef.current);
    },
    [],
  );
  const onCanvasClick = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!fullscreen || resolvedStems.length === 0) return;
    if (e.detail >= 2) {
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
      return; // second click of the exit-fullscreen double-click
    }
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null;
      const wasPlaying = playingRef.current;
      if (wasPlaying) pausePlayback();
      else void startPlayback(scrubRef.current);
      setFsFlash(wasPlaying ? "pause" : "play");
      if (fsFlashTimerRef.current) clearTimeout(fsFlashTimerRef.current);
      fsFlashTimerRef.current = window.setTimeout(() => setFsFlash(null), 650);
    }, 280);
  };

  /** Stop = pause + rewind to 0 (the paused preview follows scrubT). */
  const stopPlayback = useCallback(() => {
    pausePlayback();
    setScrubT(0);
  }, [pausePlayback]);

  // --- Fullscreen transport bar ------------------------------------------------
  // Revealed by a click or mouse move inside the fullscreen preview; hides
  // after a few seconds while playing and stays up while paused.
  const [fsControls, setFsControls] = useState(false);
  const fsControlsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pokeFsControls = useCallback(() => {
    setFsControls(true);
    if (fsControlsTimer.current) clearTimeout(fsControlsTimer.current);
    fsControlsTimer.current = setTimeout(() => {
      // Keep the bar up while paused — only auto-hide during playback.
      if (playingRef.current) setFsControls(false);
    }, 3000);
  }, []);
  useEffect(() => {
    if (!fullscreen) {
      setFsControls(false);
      if (fsControlsTimer.current) clearTimeout(fsControlsTimer.current);
      return;
    }
    pokeFsControls(); // show on entry + re-arm whenever play/pause flips
  }, [fullscreen, playing, pokeFsControls]);
  useEffect(
    () => () => {
      if (fsControlsTimer.current) clearTimeout(fsControlsTimer.current);
    },
    [],
  );

  // --- Animation loop ---------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const frame = () => {
      const w = canvas.width;
      const h = canvas.height;
      let t: number;
      const a = audioRef.current;
      if (playingRef.current && a) {
        t = a.offset + (a.ctx.currentTime - a.startedAt);
        if (t > duration && duration > 0) {
          // Loop: restart sources at 0.
          void startPlayback(0);
          t = 0;
        }
        setScrubT(t);
      } else {
        t = scrubRef.current;
      }
      const state = computeFrame(resolvedStems, globals, w, h, t);
      if (globals.dancer.enabled) {
        state.dancer = computeDancer(resolvedStems, globals.dancer, w, h, t, frameCenter(resolvedStems, globals, w, h, t));
      }
      // Media-layer sync — each video element free-runs while playing (drift-
      // corrected per frame) and follows the scrub position when paused.
      // `t % duration` mirrors the export's -stream_loop wrap.
      const layerMedia = state.videoLayers.map((v, i) => {
        if (v.kind !== "media") return null;
        const el = layerElsRef.current.get(i);
        if (!el) return null;
        if (el instanceof HTMLVideoElement) {
          const vd = el.duration;
          if (Number.isFinite(vd) && vd > 0) {
            const target = t % vd;
            if (playingRef.current) {
              if (el.paused) void el.play().catch(() => {});
              if (Math.abs(el.currentTime - target) > 0.25) el.currentTime = target;
            } else {
              if (!el.paused) el.pause();
              if (Math.abs(el.currentTime - target) > 0.03) el.currentTime = target;
            }
          }
        }
        return el;
      });
      drawState(ctx, state, w, h, globals.backgroundColor, layerMedia);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedStems, globals, duration]);

  // --- actions ------------------------------------------------------------------
  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      // Use the server-sanitized name from each upload response — the stored
      // filename can differ from the browser's (sanitizeStemName), and the
      // mismatch would silently leave the stem out of the render set.
      const added: string[] = [];
      for (const f of Array.from(files)) {
        const r = await api.vizUploadStem(projectId, f);
        added.push(r.stem.name);
        // Re-uploading an existing name overwrites the file → drop the stale
        // decoded signal so the preview re-fetches the new content.
        signalsRef.current.delete(r.stem.name);
        failedSignals.current.delete(r.stem.name);
      }
      await loadStems();
      setStemInputs((cur) => [
        ...cur,
        ...added
          .filter((n) => !cur.some((s) => s.name === n))
          .map((n) => ({ name: n, muted: false, solo: false }) satisfies VisualizerStemInput),
      ]);
      onToast(`${files.length} stem${files.length === 1 ? "" : "s"} uploaded`, "success");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  /** Upload a full song → the engine splits it into stems (a split job). */
  const splitSong = async (f: File | null | undefined) => {
    if (!f) return;
    setError(null);
    try {
      const r = await api.vizSplitStems(projectId, f, splitQuality);
      setSplitJob(r.job);
    } catch (e) {
      setError((e as Error).message);
      refreshSep(); // SEP_SETUP_REQUIRED may surface here — re-check install state
    } finally {
      if (splitFileRef.current) splitFileRef.current.value = "";
    }
  };

  // Poll the running split job — on done the new stems land in the pool and
  // auto-join the render set (that's the whole point of splitting).
  useEffect(() => {
    if (!splitJob || splitJob.status !== "running") return;
    const t = setInterval(() => {
      api
        .vizSplitJob(splitJob.id)
        .then((r) => {
          setSplitJob(r.job);
          if (r.job.status === "done") {
            onToast(`Separated into ${r.job.stems.length} stem${r.job.stems.length === 1 ? "" : "s"}`, "success");
            void loadStems().then(() => {
              setStemInputs((cur) => [
                ...cur,
                ...r.job.stems.filter((n) => !cur.some((s) => s.name === n)).map((n) => ({ name: n, muted: false, solo: false }) satisfies VisualizerStemInput),
              ]);
              setSignalsReady((n) => n + 1);
            });
          } else if (r.job.status === "failed") {
            onToast(`Split failed: ${r.job.error?.message ?? "unknown error"}`, "error");
          }
        })
        .catch(() => {});
    }, 700);
    return () => clearInterval(t);
  }, [splitJob, loadStems, onToast, refreshSep]);

  const patchStem = (name: string, patch: Partial<VisualizerStemInput>) =>
    setStemInputs((cur) => cur.map((s) => (s.name === name ? { ...s, ...patch } : s)));

  const removeStem = async (name: string) => {
    try {
      await api.vizDeleteStem(projectId, name);
      signalsRef.current.delete(name);
      failedSignals.current.delete(name);
      if (auditioning === name) stopAudition();
      setStemInputs((cur) => cur.filter((s) => s.name !== name));
      await loadStems();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** Delete every uploaded stem (files included) — confirmed first. */
  const clearAllStems = async () => {
    if (stems.length === 0) return;
    if (!window.confirm(`Delete all ${stems.length} uploaded stems? The audio files are removed from this project.`)) return;
    setError(null);
    try {
      for (const s of stems) await api.vizDeleteStem(projectId, s.name);
      signalsRef.current.clear();
      failedSignals.current.clear();
      if (playing) pausePlayback();
      stopAudition();
      setStemInputs([]);
      await loadStems();
      onToast("All stems deleted", "success");
    } catch (e) {
      setError((e as Error).message);
      await loadStems().catch(() => {});
    }
  };

  // --- Sessions ---------------------------------------------------------------
  // A session captures EVERYTHING on this page: the stem selection + tweaks,
  // all look/layer/dancer settings, render settings — and the media itself
  // (the server snapshots the files). Loading restores both.

  const currentPayload = useCallback((): VisualizerSessionPayload => ({ renderSettings, globalVisuals: globals, stems: stemInputs }), [renderSettings, globals, stemInputs]);

  const saveNewSession = async () => {
    const name = sessionName.trim() || `Session ${new Date().toLocaleString()}`;
    setSessionBusy(true);
    setError(null);
    try {
      const r = await api.vizSaveSession(projectId, name, currentPayload());
      setActiveSessionId(r.session.id);
      setSessionName(r.session.name);
      await loadSessions();
      onToast(`Session "${r.session.name}" saved`, "success");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSessionBusy(false);
    }
  };

  /** Overwrite an existing session with the current setup. */
  const overwriteSession = async (id: string) => {
    setSessionBusy(true);
    setError(null);
    try {
      const r = await api.vizUpdateSession(projectId, id, { payload: currentPayload() });
      setActiveSessionId(id);
      await loadSessions();
      onToast(`Session "${r.session.name}" updated`, "success");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSessionBusy(false);
    }
  };

  const loadSessionById = async (id: string) => {
    setSessionBusy(true);
    setError(null);
    try {
      const r = await api.vizLoadSession(projectId, id);
      const norm = normalizePersisted({ stems: r.payload.stems, globals: r.payload.globalVisuals, render: r.payload.renderSettings });
      if (playing) pausePlayback();
      stopAudition();
      // Stem files may have been restored with different bytes — refetch
      // every decoded signal instead of drawing from a stale cache.
      signalsRef.current.clear();
      failedSignals.current.clear();
      setStemInputs(norm.stems);
      setGlobals(norm.globals);
      setRenderSettings(norm.render);
      setActiveSessionId(r.session.id);
      setSessionName(r.session.name);
      await loadStems();
      // A deleted layer asset may have been re-registered — refresh pickers.
      if (r.restoredMedia > 0) window.dispatchEvent(new Event(ASSETS_CHANGED_EVENT));
      onToast(`Session "${r.session.name}" loaded`, "success");
      for (const w of r.warnings) onToast(w, "error");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSessionBusy(false);
    }
  };

  const removeSession = async (s: VizSessionMeta) => {
    if (!window.confirm(`Delete session "${s.name}"? Its saved snapshot (settings + media copies) is removed.`)) return;
    setSessionBusy(true);
    setError(null);
    try {
      await api.vizDeleteSession(projectId, s.id);
      if (activeSessionId === s.id) setActiveSessionId(null);
      await loadSessions();
      onToast("Session deleted", "success");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSessionBusy(false);
    }
  };

  const commitRename = async (id: string) => {
    const name = renameText.trim();
    setRenamingId(null);
    setRenameText("");
    if (!name) return;
    try {
      const r = await api.vizUpdateSession(projectId, id, { name });
      if (activeSessionId === id) setSessionName(r.session.name);
      await loadSessions();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** Filename of a /files/… render URL (for the reveal endpoint). */
  const renderFileName = (url: string) => decodeURIComponent(url.split("/").pop() ?? "render.mp4");

  const revealRender = (name?: string) =>
    void api
      .vizRevealRender(projectId, name)
      .then((r) => {
        if (!r.ok) setError(r.error ?? "Could not open the folder");
      })
      .catch((e) => setError((e as Error).message));

  const addToRender = (name: string) =>
    setStemInputs((cur) => (cur.some((s) => s.name === name) ? cur : [...cur, { name, muted: false, solo: false }]));

  const addAllToRender = () =>
    setStemInputs((cur) => [
      ...cur,
      ...stems
        .filter((s) => !cur.some((c) => c.name === s.name))
        .map((s) => ({ name: s.name, muted: false, solo: false }) satisfies VisualizerStemInput),
    ]);

  const moveStem = (idx: number, delta: number) =>
    setStemInputs((cur) => {
      const j = idx + delta;
      if (j < 0 || j >= cur.length) return cur;
      const next = [...cur];
      [next[idx], next[j]] = [next[j]!, next[idx]!];
      return next;
    });

  // Remove from the visual only — the stem file stays in the library.
  const removeFromRender = (name: string) => setStemInputs((cur) => cur.filter((s) => s.name !== name));

  const render = async (draft: boolean) => {
    setError(null);
    lastLogMarkRef.current = { phase: "", mark: -1, detail: "" };
    setRenderLog([]);
    pushRenderLog(draft ? "▸ Draft render queued" : "▸ Render queued");
    try {
      // Draft pass: shrink to ~480px (aspect preserved), 12 fps + the
      // ultrafast encoder preset — a fast, low-quality first look.
      const scale = draft ? Math.min(1, 480 / Math.max(renderSettings.width, renderSettings.height)) : 1;
      const req: VisualizerRenderInput = {
        renderSettings: {
          width: Math.max(240, Math.round(renderSettings.width * scale)),
          height: Math.max(240, Math.round(renderSettings.height * scale)),
          fps: draft ? 12 : renderSettings.fps,
          draft,
        },
        globalVisuals: globals,
        stems: stemInputs,
      };
      const r = await api.vizRender(projectId, req);
      setJob(r.job);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const setG = <K extends keyof VisualizerGlobals>(k: K, v: VisualizerGlobals[K]) => setGlobals((g) => ({ ...g, [k]: v }));
  const setDancer = (patch: Partial<DancerConfig>) => setGlobals((g) => ({ ...g, dancer: { ...g.dancer, ...patch } }));

  // --- Media layers -------------------------------------------------------------
  const setLayers = (fn: (ls: VizMediaLayerConfig[]) => VizMediaLayerConfig[]) =>
    setGlobals((g) => ({ ...g, video: { layers: fn(g.video.layers) } }));
  const addLayer = (assetId: string) =>
    setLayers((ls) =>
      ls.length >= VIZ_MAX_VIDEO_LAYERS || !assetId
        ? ls
        : [
            ...ls,
            {
              kind: "media",
              assetId,
              hidden: false,
              x: 0.5,
              y: 0.5,
              opacity: 1,
              scale: 1,
              key: { ...DEFAULT_VIDEO_KEY },
              zoomPan: { zoom: 1, panX: 0.5, panY: 0.5 },
              visibility: { show: [], hide: [] },
            },
          ],
    );
  /** Add a waveform layer stamped with a copy of the current 2. Look — from
   *  then on its settings are its own, edited on the row (mode included). */
  const addVisualsLayer = () =>
    setLayers((ls) => (ls.length >= VIZ_MAX_VIDEO_LAYERS ? ls : [...ls, vizVisualsLayer(waveParamsFromGlobals(globals))]));
  const patchLayer = (i: number, patch: Partial<VizMediaLayerConfig>) =>
    setLayers((ls) => ls.map((l, j) => (j === i ? ({ ...l, ...patch } as VizMediaLayerConfig) : l)));
  const setLayerKey = (i: number, patch: Partial<VizVideoKeyConfig>) =>
    setLayers((ls) => ls.map((l, j) => (j === i && l.kind === "media" ? { ...l, key: { ...l.key, ...patch } } : l)));
  const setLayerZoomPan = (i: number, patch: Partial<VizZoomPanConfig>) =>
    setLayers((ls) => ls.map((l, j) => (j === i && l.kind === "media" ? { ...l, zoomPan: { ...l.zoomPan, ...patch } } : l)));
  const setLayerVis = (i: number, patch: Partial<VizVisibilityConfig>) =>
    setLayers((ls) => ls.map((l, j) => (j === i ? ({ ...l, visibility: { ...l.visibility, ...patch } } as VizMediaLayerConfig) : l)));
  /** Mix length in seconds — longest stem signal (1s floor so the windows
   *  timeline has a sane scale before signals arrive). */
  const mixDurSec = Math.max(1, duration);
  const removeLayer = (i: number) => {
    layerElsRef.current.delete(i);
    setLayers((ls) => ls.filter((_, j) => j !== i));
  };
  const moveLayer = (from: number, to: number) =>
    setLayers((ls) => {
      if (to < 0 || to >= ls.length || from === to) return ls;
      const c = [...ls];
      const [x] = c.splice(from, 1);
      c.splice(to, 0, x!);
      return c;
    });

  // Sample the top-left 12×12 source pixels of the layer's current frame —
  // that's where a flat monochrome background sits — and use it as the key
  // color. Needs a decoded frame (readyState ≥ 2 / complete image).
  const sampleLayerBg = (i: number) => {
    const el = layerElsRef.current.get(i);
    if (!el) return;
    const ready = el instanceof HTMLVideoElement ? el.readyState >= 2 && el.videoWidth > 0 : el.complete && el.naturalWidth > 0;
    if (!ready) return;
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    const x = c.getContext("2d");
    if (!x) return;
    x.drawImage(el, 0, 0, 12, 12, 0, 0, 1, 1);
    const d = x.getImageData(0, 0, 1, 1).data;
    const layer = globals.video.layers[i];
    if (layer?.kind !== "media") return;
    patchLayer(i, { key: { ...layer.key, color: `#${((1 << 24) | (d[0]! << 16) | (d[1]! << 8) | d[2]!).toString(16).slice(1).toUpperCase()}` } });
  };

  const hasVisualsLayer = globals.video.layers.some((l) => l.kind === "visuals");
  const pickerResults = useMemo(() => {
    const q = pickerQ.trim().toLowerCase();
    return videoAssets.filter((a) => {
      const isImg = isImageFileName(a.local_path ?? a.title ?? "");
      if (isImg ? !pickerImage : !pickerVideo) return false;
      if (!q) return true;
      return (a.title ?? "").toLowerCase().includes(q) || (a.local_path ?? "").toLowerCase().includes(q);
    });
  }, [videoAssets, pickerQ, pickerVideo, pickerImage]);
  const rendering = job?.status === "running";
  const canvasH = Math.round((640 * renderSettings.height) / renderSettings.width);

  // Output aspect/quality — the segmented control + resolution select write
  // concrete w/h back into renderSettings, and the preview resizes with them
  // (canvasH + the aspectRatio style below + the fullscreen sizer all derive
  // from renderSettings, so the canvas always matches the export shape).
  const aspectId: "16:9" | "9:16" | "1:1" =
    renderSettings.width === renderSettings.height ? "1:1" : renderSettings.width > renderSettings.height ? "16:9" : "9:16";
  const quality: "1080p" | "4k" = Math.max(renderSettings.width, renderSettings.height) > 2000 ? "4k" : "1080p";
  const applyOutput = (a: "16:9" | "9:16" | "1:1", q: "1080p" | "4k") => {
    const long = q === "4k" ? 3840 : 1920;
    const short = (long * 9) / 16; // 1080 | 2160 — square uses short×short
    const [w, h] = a === "16:9" ? [long, short] : a === "9:16" ? [short, long] : [short, short];
    setRenderSettings((s) => ({ ...s, width: w, height: h }));
  };
  const inRender = new Set(stemInputs.map((s) => s.name));
  const colorByStem = new Map(stemInputs.map((s, i) => [s.name, resolveStem(s, i).color]));

  // Signal-decode progress — stems in the render set that have neither a
  // decoded signal nor a recorded failure are still in flight (the fetch loop
  // processes them in order, so pending[0] is the one being decoded now).
  const pendingSignals = stemInputs.filter((s) => !signalsRef.current.has(s.name) && !failedSignals.current.has(s.name));
  const pendingNames = new Set(pendingSignals.map((s) => s.name));
  const decodeDone = stemInputs.length - pendingSignals.length;

  // Resize the canvas backing store in fullscreen so it stays sharp (the
  // canvas draws at its pixel size every frame — CSS scaling alone blurs).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!fullscreen) {
      canvas.width = 640;
      canvas.height = canvasH;
      return;
    }
    const aspect = renderSettings.width / renderSettings.height;
    const w = Math.min(window.innerWidth, window.innerHeight * aspect);
    canvas.width = Math.max(2, Math.round(w));
    canvas.height = Math.max(2, Math.round(w / aspect));
  }, [fullscreen, canvasH, renderSettings.width, renderSettings.height]);

  // The "2. Look" controls — shared between the settings section and the
  // fullscreen preview overlay, so edits apply live in both places. These are
  // the BASE look: waveform layer rows can carry their own copy and override
  // them entirely (same control set, bound to the row's `visuals`).
  const lookContent = (
    <>
      <WaveLookControls p={globals} onChange={(patch) => setGlobals((g) => ({ ...g, ...patch }))} engine={engine} />
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-1">
        <label className="flex items-center gap-2 text-xs text-slate-400">
          Background
          <input type="color" value={globals.backgroundColor} onChange={(e) => setG("backgroundColor", e.target.value)} className="w-8 h-6 rounded border border-slate-600" />
        </label>
        <span className="text-[11px] text-slate-500">
          Base look — ◈ waveform layers without their own settings draw with these. Add more waveform layers in "3. Media layers" to stack different looks.
        </span>
      </div>

      {/* Dancer */}
      <div className="border-t border-slate-700/50 pt-4 space-y-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={globals.dancer.enabled} onChange={(e) => setDancer({ enabled: e.target.checked })} />
          <span className="font-semibold text-slate-200">Procedural dancer</span>
          <span className="text-xs text-slate-500">— a computed skeleton dancing at the convergence point</span>
        </label>
        {globals.dancer.enabled && (
          <div className="grid md:grid-cols-4 gap-3 text-xs text-slate-400">
            <label className="space-y-1">Style
              <select className="ui-input w-full" value={globals.dancer.style} onChange={(e) => setDancer({ style: e.target.value as DancerConfig["style"] })}>
                <option value="neon">Neon outline</option>
                <option value="silhouette">Silhouette</option>
              </select>
            </label>
            <label className="space-y-1">Size {globals.dancer.scale.toFixed(2)}×
              <input type="range" min={0.3} max={2} step={0.05} value={globals.dancer.scale} className="w-full" onChange={(e) => setDancer({ scale: Number(e.target.value) })} />
            </label>
            <label className="space-y-1">Energy {globals.dancer.intensity.toFixed(2)}×
              <input type="range" min={0} max={2} step={0.05} value={globals.dancer.intensity} className="w-full" onChange={(e) => setDancer({ intensity: Number(e.target.value) })} />
            </label>
            <label className="space-y-1">Color
              <div className="flex items-center gap-2">
                <select className="ui-input flex-1" value={globals.dancer.colorMode} onChange={(e) => setDancer({ colorMode: e.target.value as DancerConfig["colorMode"] })}>
                  <option value="stems">By stem kind</option>
                  <option value="fixed">Fixed</option>
                </select>
                {globals.dancer.colorMode === "fixed" && (
                  <input type="color" value={globals.dancer.color} onChange={(e) => setDancer({ color: e.target.value })} className="w-8 h-6 rounded border border-slate-600" />
                )}
              </div>
            </label>
          </div>
        )}
      </div>
    </>
  );


  // The "3. Media layers" controls — shared between the settings section and the
  // fullscreen overlay (alongside "2. Look"), so edits apply live in both places.
  const layersContent = (
    <>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <div className="relative w-80 max-w-full">
            <button
              type="button"
              className="ui-input w-full text-left text-slate-300 flex items-center justify-between gap-2"
              disabled={globals.video.layers.length >= VIZ_MAX_VIDEO_LAYERS}
              onClick={() => {
                setPickerQ("");
                setPickerOpen((o) => !o);
              }}
            >
              <span>
                {globals.video.layers.length >= VIZ_MAX_VIDEO_LAYERS
                  ? `Layer limit reached (${VIZ_MAX_VIDEO_LAYERS})`
                  : "+ Add a layer…"}
              </span>
              <span className="text-slate-500">▾</span>
            </button>
            {pickerOpen && (
              <>
                {/* Click-away overlay + Esc close. */}
                <div className="fixed inset-0 z-40" onClick={() => setPickerOpen(false)} />
                <div
                  className="absolute z-50 mt-1 w-96 max-w-[90vw] rounded-lg border border-slate-700 bg-slate-900 shadow-xl overflow-hidden"
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setPickerOpen(false);
                  }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      addVisualsLayer();
                      setPickerOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-2 py-2 text-left text-xs text-slate-200 hover:bg-slate-800/60 disabled:opacity-40 border-b border-slate-800"
                    title="Add a waveform layer at the top of the stack — starts as a copy of the 2. Look settings, editable on the row"
                  >
                    <span className="w-12 h-8 rounded border border-violet-600/50 bg-violet-950/50 flex items-center justify-center text-violet-300 shrink-0">◈</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">Waveform layer</span>
                      <span className="text-[10px] text-slate-500">own settings · starts as a copy of 2. Look · stack as many as you like</span>
                    </span>
                  </button>
                  <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-slate-800">
                    <input
                      autoFocus
                      value={pickerQ}
                      onChange={(e) => setPickerQ(e.target.value)}
                      placeholder="Filter by name…"
                      className="ui-input !py-1 flex-1 text-xs"
                    />
                    {(
                      [
                        { id: "video" as const, on: pickerVideo, set: setPickerVideo, label: "▶ videos" },
                        { id: "image" as const, on: pickerImage, set: setPickerImage, label: "🖼 images" },
                      ]
                    ).map((k) => (
                      <button
                        key={k.id}
                        type="button"
                        onClick={() => k.set(!k.on)}
                        className={`px-2 py-0.5 rounded border text-[11px] ${k.on ? "border-sky-500 text-sky-300 bg-sky-950/40" : "border-slate-700 text-slate-500 hover:text-slate-300"}`}
                        title={`${k.on ? "Hide" : "Show"} ${k.id} results`}
                      >
                        {k.label}
                      </button>
                    ))}
                  </div>
                  <div className="max-h-64 overflow-y-auto">
                    {pickerResults.map((a) => {
                      const isImg = isImageFileName(a.local_path ?? a.title ?? "");
                      const inStack = globals.video.layers.filter((x) => x.kind === "media" && x.assetId === a.id).length;
                      return (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => addLayer(a.id)}
                          className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs text-slate-200 hover:bg-slate-800/60"
                        >
                          <img
                            src={api.assetThumbUrl(a.id)}
                            alt=""
                            loading="lazy"
                            className="w-12 h-8 rounded object-cover border border-slate-700/60 bg-slate-800 shrink-0"
                            onError={(e) => (e.currentTarget.style.display = "none")}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate" title={a.title ?? a.id}>
                              {a.title ?? a.id}
                            </span>
                            <span className="flex items-center gap-1.5 text-[10px] text-slate-500">
                              <Badge tone={isImg ? "violet" : "info"}>{isImg ? "image" : "video"}</Badge>
                              {a.duration_seconds ? <span>{a.duration_seconds.toFixed(0)}s</span> : null}
                              {a.width && a.height ? (
                                <span>
                                  {a.width}×{a.height}
                                </span>
                              ) : null}
                            </span>
                          </span>
                          {inStack > 0 && <span className="text-[10px] text-slate-500 shrink-0">in stack{inStack > 1 ? ` ×${inStack}` : ""}</span>}
                        </button>
                      );
                    })}
                    {pickerResults.length === 0 && (
                      <p className="px-3 py-3 text-xs text-slate-500">
                        {videoAssets.length === 0
                          ? "No downloaded media in this project — KEEP assets on Library/Folders or drop files onto the app first."
                          : "No matches — adjust the name filter or the media-kind toggles."}
                      </p>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
          {hasVisualsLayer && (
            <p className="text-[11px] text-slate-500">◈ rows = waveform layers — each can carry its own settings (or inherit 2. Look). No ◈ row → no waveforms.</p>
          )}
          {videoAssets.length === 0 && (
            <p className="text-[11px] text-slate-500">
              No downloaded media in this project — KEEP assets on Library/Folders or drop files onto the app first.
            </p>
          )}
        </div>

        {globals.video.layers.length === 0 ? (
          <p className="text-sm text-slate-500">
            Nothing is drawn — the frame is empty (even the 2. Look visuals need an explicit ◈ row). Add layers above: each row is a layer, drawn in row order.
          </p>
        ) : (
          <ol className="space-y-1.5">
            {/* Row 1 = top layer: the stack (layers[0] = bottom) is listed
                top-first like a Layers panel — `i` stays the config index. */}
            {globals.video.layers
              .map((l, i) => ({ l, i }))
              .reverse()
              .map(({ l, i }) => {
              const isVis = l.kind === "visuals";
              const asset = l.kind === "media" ? videoAssets.find((a) => a.id === l.assetId) : undefined;
              const isImg = l.kind === "media" && isImageFileName(asset?.local_path ?? asset?.title ?? "");
              const kj = cutoutJobFor(l);
              return (
                <li
                  key={`${i}:${isVis ? "visuals" : l.kind === "media" ? l.assetId : i}`}
                  draggable={armedRow === i}
                  onMouseDown={(e) => {
                    // Press on the row body starts a pending reorder drag —
                    // interactive children (sliders, buttons, selects) own
                    // their gestures, so they never arm the row.
                    if (e.button !== 0) return;
                    if ((e.target as HTMLElement).closest("input,select,button,a,label")) return;
                    dragGateRef.current = { i, x: e.clientX, y: e.clientY };
                  }}
                  onMouseMove={(e) => {
                    const g = dragGateRef.current;
                    if (!g || g.i !== i || armedRow === i) return;
                    const dx = Math.abs(e.clientX - g.x);
                    const dy = Math.abs(e.clientY - g.y);
                    if (Math.max(dx, dy) < 6) return;
                    if (dy > dx) setArmedRow(i); // vertical intent → the native drag may start
                    else dragGateRef.current = null; // horizontal → a slider gesture, not a row drag
                  }}
                  onMouseLeave={() => {
                    if (dragGateRef.current?.i === i) dragGateRef.current = null;
                  }}
                  onDragStart={(e) => {
                    setDragLayer(i);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (dragLayer !== null && dragLayer !== i) setDropLayer(i);
                  }}
                  onDragLeave={() => {
                    if (dropLayer === i) setDropLayer(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragLayer !== null) moveLayer(dragLayer, i);
                    setDragLayer(null);
                    setDropLayer(null);
                  }}
                  onDragEnd={() => {
                    setDragLayer(null);
                    setDropLayer(null);
                    setArmedRow(null);
                    dragGateRef.current = null;
                  }}
                  className={`rounded-lg border px-2 py-2 space-y-2 transition-colors ${
                    dragLayer === i
                      ? "opacity-40 border-slate-700"
                      : dropLayer === i
                        ? "border-sky-500 bg-sky-950/30"
                        : "border-slate-700/60 bg-slate-800/40"
                  }`}
                >
                  <div className="flex items-center gap-2 text-sm">
                    <span
                      className="cursor-grab text-slate-500 select-none shrink-0"
                      title="Drag to reorder — row position = layer position"
                      onMouseDown={(e) => {
                        // The grip exists only to drag — arm instantly, any direction.
                        if (e.button === 0) setArmedRow(i);
                      }}
                    >
                      ⠿
                    </span>
                    <span className="w-4 shrink-0 text-center text-[10px] text-slate-500" title={`Row ${globals.video.layers.length - i} of ${globals.video.layers.length} — row 1 is the top layer`}>
                      {globals.video.layers.length - i}
                    </span>
                    <button
                      type="button"
                      className={`shrink-0 ${l.hidden ? "text-slate-600 hover:text-slate-300" : "text-slate-300 hover:text-white"}`}
                      onClick={() => patchLayer(i, { hidden: !l.hidden })}
                      title={l.hidden ? "Layer hidden — click to show" : "Layer visible — click to hide (keeps its settings and stack position)"}
                    >
                      <EyeIcon off={l.hidden} className="w-4 h-4" />
                    </button>
                    {isVis ? (
                      <span
                        className={`w-12 h-8 rounded border border-violet-600/50 bg-violet-950/50 flex items-center justify-center text-violet-300 shrink-0 ${l.hidden ? "opacity-40 grayscale" : ""}`}
                        title="The visuals configured in section 2. Look"
                      >
                        ◈
                      </span>
                    ) : l.kind === "media" ? (
                      <img
                        src={api.assetThumbUrl(l.assetId)}
                        alt=""
                        draggable={false}
                        className={`w-12 h-8 rounded object-cover border border-slate-700/60 shrink-0 ${l.hidden ? "opacity-40 grayscale" : ""}`}
                        onError={(e) => (e.currentTarget.style.display = "none")}
                      />
                    ) : null}
                    <div className={`min-w-0 flex-1 ${l.hidden ? "opacity-40" : ""}`}>
                      <div className="truncate text-xs text-slate-200" title={isVis ? (l.visuals ? `Waveform layer — ${l.visuals.mode}` : "Waveform visuals — inherited from 2. Look") : asset?.title ?? (l.kind === "media" ? l.assetId : "")}>
                        {isVis ? (l.visuals ? `Waveform · ${l.visuals.mode}` : "Waveform visuals") : asset?.title ?? (l.kind === "media" ? l.assetId : "")}
                      </div>
                      <div className="flex items-center gap-1.5">
                        {isVis ? (
                          <>
                            <Badge tone="violet">visuals</Badge>
                            <span className="text-[10px] text-slate-500">
                              {l.visuals ? `${l.visuals.mode} · own settings` : `${globals.mode} · inherits 2. Look`}
                            </span>
                          </>
                        ) : (
                          <>
                            <Badge tone={isImg ? "violet" : "info"}>{isImg ? "image" : "video"}</Badge>
                            {asset == null && videoAssets.length > 0 && (
                              <span className="text-[10px] text-amber-400">not in this project anymore</span>
                            )}
                          </>
                        )}
                        {l.visibility.show.length + l.visibility.hide.length > 0 && (
                          <span className="text-[10px] text-slate-500" title="Scheduled — the layer shows/hides inside its windows">
                            ⏱
                          </span>
                        )}
                      </div>
                    </div>
                    <label className="flex items-center gap-1.5 text-[11px] text-slate-400 shrink-0" title="Layer opacity">
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={l.opacity}
                        className="w-20"
                        onChange={(e) => patchLayer(i, { opacity: Number(e.target.value) })}
                      />
                      <span className="w-8 text-right">{Math.round(l.opacity * 100)}%</span>
                    </label>
                    <button className="text-slate-500 hover:text-slate-200 disabled:opacity-30 shrink-0" disabled={i === globals.video.layers.length - 1} onClick={() => moveLayer(i, i + 1)} title="Move up (toward the top layer)">
                      ↑
                    </button>
                    <button className="text-slate-500 hover:text-slate-200 disabled:opacity-30 shrink-0" disabled={i === 0} onClick={() => moveLayer(i, i - 1)} title="Move down (toward the bottom layer)">
                      ↓
                    </button>
                    <button className="text-slate-500 hover:text-rose-400 shrink-0" onClick={() => removeLayer(i)} title="Remove this layer (file stays in the library)">
                      ✕
                    </button>
                  </div>
                  <div className="flex flex-wrap items-stretch gap-1.5 pl-7">
                    <div className={LAYER_CARD}>
                      <div className="flex items-center justify-between gap-3">
                        <span className={LAYER_CARD_LABEL}>Position</span>
                        <button
                          type="button"
                          className="text-slate-500 hover:text-slate-200 disabled:opacity-30"
                          disabled={l.x === 0.5 && l.y === 0.5}
                          onClick={() => patchLayer(i, { x: 0.5, y: 0.5 })}
                          title="Re-center (50% / 50%)"
                        >
                          ⌖
                        </button>
                      </div>
                      <label className="flex items-center gap-1" title="Layer center — horizontal position in the frame">
                        <span className="w-3 text-slate-500">X</span>
                        <input type="range" min={0} max={1} step={0.01} value={l.x} className="w-20" onChange={(e) => patchLayer(i, { x: Number(e.target.value) })} />
                        <span className="w-8 text-right">{Math.round(l.x * 100)}%</span>
                      </label>
                      <label className="flex items-center gap-1" title="Layer center — vertical position in the frame">
                        <span className="w-3 text-slate-500">Y</span>
                        <input type="range" min={0} max={1} step={0.01} value={l.y} className="w-20" onChange={(e) => patchLayer(i, { y: Number(e.target.value) })} />
                        <span className="w-8 text-right">{Math.round(l.y * 100)}%</span>
                      </label>
                    </div>
                    <div className={LAYER_CARD}>
                      <span className={LAYER_CARD_LABEL}>Size</span>
                      <label className="flex items-center gap-1" title="Layer size — 100% fills the frame, smaller shrinks to an inset, larger zooms in">
                        <input type="range" min={0.1} max={2} step={0.05} value={l.scale} className="w-20" onChange={(e) => patchLayer(i, { scale: Number(e.target.value) })} />
                        <span className="w-9 text-right">{Math.round(l.scale * 100)}%</span>
                      </label>
                    </div>
                    {l.kind === "media" && (
                    <div className={LAYER_CARD}>
                      <div className="flex items-center justify-between gap-3">
                        <span className={LAYER_CARD_LABEL}>Zoom / pan</span>
                        <button
                          type="button"
                          className="text-slate-500 hover:text-slate-200 disabled:opacity-30"
                          disabled={l.zoomPan.zoom === 1 && l.zoomPan.panX === 0.5 && l.zoomPan.panY === 0.5}
                          onClick={() => patchLayer(i, { zoomPan: { zoom: 1, panX: 0.5, panY: 0.5 } })}
                          title="Back to the cover-fit view"
                        >
                          ⌖
                        </button>
                      </div>
                      <label className="flex items-center gap-1" title="Zoom into the source — 100% is the normal cover-fit crop">
                        <span className="w-3 text-slate-500">Z</span>
                        <input type="range" min={1} max={8} step={0.05} value={l.zoomPan.zoom} className="w-20" onChange={(e) => setLayerZoomPan(i, { zoom: Number(e.target.value) })} />
                        <span className="w-8 text-right">{Math.round(l.zoomPan.zoom * 100)}%</span>
                      </label>
                      <label className="flex items-center gap-1" title="Pan inside the source — which part of the media the crop window looks at">
                        <span className="w-3 text-slate-500">X</span>
                        <input type="range" min={0} max={1} step={0.01} value={l.zoomPan.panX} className="w-20" onChange={(e) => setLayerZoomPan(i, { panX: Number(e.target.value) })} />
                        <span className="w-8 text-right">{Math.round(l.zoomPan.panX * 100)}%</span>
                      </label>
                      <label className="flex items-center gap-1" title="Pan inside the source — which part of the media the crop window looks at">
                        <span className="w-3 text-slate-500">Y</span>
                        <input type="range" min={0} max={1} step={0.01} value={l.zoomPan.panY} className="w-20" onChange={(e) => setLayerZoomPan(i, { panY: Number(e.target.value) })} />
                        <span className="w-8 text-right">{Math.round(l.zoomPan.panY * 100)}%</span>
                      </label>
                    </div>
                    )}
                    <div className={`${LAYER_CARD} min-w-[230px]`}>
                      <div className="flex items-center justify-between gap-3">
                        <span className={LAYER_CARD_LABEL}>Show / hide</span>
                        <span className="flex gap-2">
                          <button
                            type="button"
                            className="text-[10px] text-sky-400 hover:text-sky-300"
                            onClick={() => setLayerVis(i, { show: [...l.visibility.show, { start: 0, end: Math.min(5, mixDurSec) }] })}
                            title="Add a window when the layer is shown (otherwise it's always visible)"
                          >
                            + shown
                          </button>
                          <button
                            type="button"
                            className="text-[10px] text-rose-400 hover:text-rose-300"
                            onClick={() => setLayerVis(i, { hide: [...l.visibility.hide, { start: 0, end: Math.min(2, mixDurSec) }] })}
                            title="Add a window when the layer is hidden (subtracts from the shown time)"
                          >
                            + hidden
                          </button>
                        </span>
                      </div>
                      {/* Windows over the mix timeline — sky = shown, rose = hidden. */}
                      <div className="relative h-1.5 w-full rounded bg-slate-800/80 overflow-hidden" title={`${mixDurSec.toFixed(1)}s mix`}>
                        {l.visibility.show.map((w, k) => (
                          <div
                            key={`s${k}`}
                            className="absolute inset-y-0 bg-sky-500/80"
                            style={{ left: `${Math.min(100, (w.start / mixDurSec) * 100)}%`, width: `${Math.max(0.5, Math.min(100, ((w.end - w.start) / mixDurSec) * 100))}%` }}
                          />
                        ))}
                        {l.visibility.hide.map((w, k) => (
                          <div
                            key={`h${k}`}
                            className="absolute inset-y-0 bg-rose-500/80"
                            style={{ left: `${Math.min(100, (w.start / mixDurSec) * 100)}%`, width: `${Math.max(0.5, Math.min(100, ((w.end - w.start) / mixDurSec) * 100))}%` }}
                          />
                        ))}
                      </div>
                      {l.visibility.show.length + l.visibility.hide.length === 0 && <span className="text-[10px] text-slate-500">always visible</span>}
                      {(["show", "hide"] as const).flatMap((kind) =>
                        l.visibility[kind].map((w, k) => (
                          <span key={`${kind}${k}`} className="flex items-center gap-1">
                            <span className={`w-9 text-[9px] uppercase tracking-wide ${kind === "show" ? "text-sky-400" : "text-rose-400"}`}>{kind === "show" ? "shown" : "hidden"}</span>
                            <input
                              type="number"
                              min={0}
                              step={0.1}
                              value={w.start}
                              onChange={(e) => setLayerVis(i, { [kind]: l.visibility[kind].map((x, j) => (j === k ? { ...x, start: Math.max(0, Number(e.target.value)) } : x)) })}
                              className="ui-input w-14 !px-1 !py-0 text-[10px]"
                              title="Start (seconds)"
                            />
                            <span className="text-slate-600">–</span>
                            <input
                              type="number"
                              min={0}
                              step={0.1}
                              value={w.end}
                              onChange={(e) => setLayerVis(i, { [kind]: l.visibility[kind].map((x, j) => (j === k ? { ...x, end: Math.max(0, Number(e.target.value)) } : x)) })}
                              className="ui-input w-14 !px-1 !py-0 text-[10px]"
                              title="End (seconds)"
                            />
                            <span className="text-slate-600">s</span>
                            <button type="button" className="text-slate-500 hover:text-rose-400" onClick={() => setLayerVis(i, { [kind]: l.visibility[kind].filter((_, j) => j !== k) })} title="Remove window">
                              ×
                            </button>
                          </span>
                        )),
                      )}
                    </div>
                    {l.kind === "media" && (
                    <div className={`${LAYER_CARD} flex-1 min-w-[280px]`}>
                      <span className={LAYER_CARD_LABEL}>Background removal</span>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <select
                      className="ui-input !py-0.5 text-[11px]"
                      value={l.key.method}
                      onChange={(e) => setLayerKey(i, { method: e.target.value as VizKeyMethod })}
                      title={`How the ${isImg ? "image" : "video"}'s background is removed`}
                    >
                      {KEY_METHODS.filter((m) => !(isImg && m.value === "cutout")).map((m) => (
                        <option key={m.value} value={m.value}>{m.label}</option>
                      ))}
                    </select>
                    {isImg && l.key.method === "cutout" && (
                      <span className="text-amber-400">AI cutout needs a video layer.</span>
                    )}
                    {COLOR_KEY_METHODS.has(l.key.method) && (
                      <>
                        <input
                          type="color"
                          value={l.key.color}
                          onChange={(e) => setLayerKey(i, { color: e.target.value.toUpperCase() })}
                          className="w-7 h-5 rounded border border-slate-600"
                          title="The background color to remove"
                        />
                        <Button size="sm" variant="ghost" onClick={() => sampleLayerBg(i)} title="Sample the top-left pixel of this layer's current frame">
                          ⤡ sample
                        </Button>
                        <span className="flex items-center gap-1">
                          tol {Math.round(l.key.similarity * 100)}%
                          <input
                            type="range"
                            min={0}
                            max={0.5}
                            step={0.01}
                            value={l.key.similarity}
                            className="w-20"
                            onChange={(e) => setLayerKey(i, { similarity: Number(e.target.value) })}
                          />
                        </span>
                        <span className="flex items-center gap-1">
                          feather {Math.round(l.key.blend * 100)}%
                          <input
                            type="range"
                            min={0}
                            max={0.2}
                            step={0.005}
                            value={l.key.blend}
                            className="w-16"
                            onChange={(e) => setLayerKey(i, { blend: Number(e.target.value) })}
                          />
                        </span>
                        {l.key.method === "hsv" && (
                          <span className="flex items-center gap-1">
                            choke {l.key.choke}px
                            <input
                              type="range"
                              min={-8}
                              max={8}
                              step={1}
                              value={l.key.choke}
                              className="w-16"
                              title="Shrink (negative) / grow (positive) the matte edge"
                              onChange={(e) => setLayerKey(i, { choke: Number(e.target.value) })}
                            />
                          </span>
                        )}
                        <label className="flex items-center gap-1" title="Suppress key-color spill on surviving edge pixels">
                          <input
                            type="checkbox"
                            checked={l.key.despill}
                            onChange={(e) => setLayerKey(i, { despill: e.target.checked })}
                          />
                          despill
                        </label>
                      </>
                    )}
                    {l.key.method === "cutout" && !isImg && (
                      <>
                        <select
                          className="ui-input !py-0.5 text-[11px]"
                          value={l.key.model}
                          onChange={(e) => setLayerKey(i, { model: e.target.value as VizCutoutModel })}
                          title="Which engine model produces the matte"
                        >
                          {VIZ_CUTOUT_MODELS.map((m) => (
                            <option key={m} value={m}>{CUTOUT_MODEL_LABELS[m]}</option>
                          ))}
                        </select>
                        <span className="flex items-center gap-1">
                          feather {l.key.feather}px
                          <input
                            type="range"
                            min={0}
                            max={6}
                            step={0.5}
                            value={l.key.feather}
                            className="w-16"
                            onChange={(e) => setLayerKey(i, { feather: Number(e.target.value) })}
                          />
                        </span>
                        <label className="flex items-center gap-1" title="Clamp green spill on semi-transparent edges (baked into the keyed video)">
                          <input
                            type="checkbox"
                            checked={l.key.despill}
                            onChange={(e) => setLayerKey(i, { despill: e.target.checked })}
                          />
                          despill
                        </label>
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={!engine?.ok || kj?.status === "running"}
                          onClick={() => void startCutout(l)}
                          title={engine?.ok ? "Bake a transparent-background WebM of this layer" : "Needs the Python engine"}
                        >
                          {kj?.status === "running" ? "Cutting out…" : keyedUrlFor(l) ? "Regenerate cutout" : "Generate cutout"}
                        </Button>
                        {kj?.status === "running" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              void api
                                .vizCancelVideoKey(kj.id)
                                .then((r) => setKeyJobs((m) => new Map(m).set(cutoutKeyOf(l), r.job)))
                                .catch(() => {})
                            }
                          >
                            cancel
                          </Button>
                        )}
                      </>
                    )}
                      </div>
                      {l.key.method === "cutout" && !isImg && (
                        <div className="space-y-1 pt-0.5">
                      {kj?.status === "running" && (
                        <div className="w-64">
                          <ProgressBar value={kj.progress.done} max={Math.max(1, kj.progress.total)} height="h-1" />
                          <p className="text-[10px] text-slate-500 mt-0.5">
                            {kj.progress.total > 0 ? `${kj.progress.done}/${kj.progress.total} frames` : "decoding + matting…"}
                          </p>
                        </div>
                      )}
                      {kj?.status === "failed" && <p className="text-[11px] text-red-400">{kj.error?.message ?? "cutout failed"}</p>}
                      {keyedUrlFor(l) && (
                        <p className="text-[11px] text-emerald-400">Cutout live — the preview shows the keyed video (used by the export too).</p>
                      )}
                      {cutoutStaleFor(l) && kj?.status !== "running" && (
                        <p className="text-[11px] text-amber-400">Cutout params changed — regenerate to refresh the preview.</p>
                      )}
                      {!engine?.ok && (
                        <p className="text-[11px] text-amber-400">AI cutout needs the Python engine — set it up via the engine notice above.</p>
                      )}
                        </div>
                      )}
                    </div>
                    )}
                    {isVis && (
                      <div className={`${LAYER_CARD} flex-1 min-w-[320px]`}>
                        <div className="flex items-center justify-between gap-3">
                          <span className={LAYER_CARD_LABEL}>Waveform</span>
                          {l.visuals ? (
                            <button
                              type="button"
                              className="text-slate-500 hover:text-slate-200"
                              onClick={() => patchLayer(i, { visuals: undefined })}
                              title="Drop this row's own settings — draw with the shared 2. Look again"
                            >
                              ↺ use 2. Look
                            </button>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => patchLayer(i, { visuals: waveParamsFromGlobals(globals) })}
                              title="Give this waveform layer its own settings — copied from 2. Look"
                            >
                              Customize
                            </Button>
                          )}
                        </div>
                        {l.visuals ? (
                          <WaveLookControls p={l.visuals} engine={engine} onChange={(patch) => patchLayer(i, { visuals: { ...l.visuals!, ...patch } })} />
                        ) : (
                          <p className="text-[10px] text-slate-500">Draws with the shared 2. Look — hit Customize to tweak this layer alone (mode, amp, glow, center…).</p>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {globals.video.layers.length > 0 && (
          <p className="text-[11px] text-slate-500">
            Videos loop if shorter than the mix · every layer is cover-cropped to the frame · a layer's own audio is not used · row 1 draws on top · drag a row vertically to reorder · only rows in this list are drawn — no ◈ row, no 2. Look visuals · the eye hides a row without deleting it (hidden media isn't decoded on export).
          </p>
        )}
    </>
  );

  return (
    <div className="space-y-6">
      {/* Engine banner */}
      {engine && !engine.ok && !engine.disabled && (
        <Card className="p-4 border border-amber-700/40">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-amber-300">
              Python engine {engine.phase === "venv" ? "is creating its venv…" : engine.phase === "deps" ? "is installing packages (first run ~200 MB)…" : engine.phase === "error" ? `error: ${engine.detail}` : "not provisioned yet — needed for spectrum mode + sharpened dancer motion"}.
            </p>
            <Button
              size="sm"
              onClick={() =>
                void api
                  .engineSetup()
                  .then(setEngine)
                  .catch((e) => setError((e as Error).message))
              }
              disabled={engine.phase === "venv" || engine.phase === "deps"}
            >
              {engine.phase === "venv" || engine.phase === "deps" ? "Setting up…" : "Set up engine"}
            </Button>
            {(engine.phase === "venv" || engine.phase === "deps") && <Spinner className="w-4 h-4 text-amber-400" />}
          </div>
        </Card>
      )}
      {engine?.ok && (
        <div className="text-xs text-slate-500">
          Engine ready · Python {engine.python?.version} ({engine.python?.source === "venv" ? "managed venv" : engine.python?.path})
        </div>
      )}
      {error && (
        <Card className="p-4 border border-rose-700/40">
          <div className="flex items-start justify-between gap-4">
            <p className="text-sm text-rose-300 break-words">{error}</p>
            <Button size="sm" variant="ghost" onClick={() => setError(null)}>
              Dismiss
            </Button>
          </div>
        </Card>
      )}

      {/* Sessions — save/restore the whole setup (settings + media) */}
      <Section icon="▤" title="Sessions" action={<span className="text-xs text-slate-500">every setting + the media itself</span>}>
        <div className="flex items-center gap-2">
          <input
            value={sessionName}
            onChange={(e) => setSessionName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveNewSession();
            }}
            placeholder="Session name…"
            className="ui-input !py-1 flex-1 text-xs"
          />
          <Button size="sm" onClick={() => void saveNewSession()} disabled={sessionBusy} title="Snapshot the current setup — stems, look, layers and render settings + the media files">
            {sessionBusy ? "Working…" : "Save session"}
          </Button>
        </div>
        {sessions.length === 0 ? (
          <p className="text-sm text-slate-500">
            No saved sessions yet — name one above to snapshot the current setup. Loading a session restores every setting AND its media (stems and layer files come back even if deleted).
          </p>
        ) : (
          <div className="space-y-1">
            {sessions.map((s) => (
              <div key={s.id} className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm ${s.id === activeSessionId ? "bg-sky-950/40 border border-sky-800/50" : "bg-slate-800/40"}`}>
                {renamingId === s.id ? (
                  <input
                    autoFocus
                    value={renameText}
                    onChange={(e) => setRenameText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitRename(s.id);
                      else if (e.key === "Escape") setRenamingId(null);
                    }}
                    onBlur={() => void commitRename(s.id)}
                    className="ui-input !py-0.5 flex-1 text-xs"
                  />
                ) : (
                  <span className="flex-1 truncate" title={s.name}>{s.name}</span>
                )}
                <span className="text-[11px] text-slate-500 shrink-0" title={`${s.stems.length} stem(s) · ${s.mediaLayers} media layer(s) · saved ${new Date(s.updatedAt).toLocaleString()}`}>
                  {s.stems.length}♪ · {s.mediaLayers}▦ · {new Date(s.updatedAt).toLocaleDateString()}
                </span>
                {s.id === activeSessionId && <Badge tone="info">loaded</Badge>}
                <Button size="sm" variant="ghost" onClick={() => void loadSessionById(s.id)} disabled={sessionBusy} title="Restore this session — settings, stems and media">
                  Load
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void overwriteSession(s.id)} disabled={sessionBusy} title="Overwrite this session with the current setup">
                  Save
                </Button>
                <button className="text-slate-500 hover:text-slate-200 text-xs shrink-0" onClick={() => { setRenamingId(s.id); setRenameText(s.name); }} title="Rename session">
                  ✎
                </button>
                <button className="text-slate-500 hover:text-rose-400 text-xs shrink-0" onClick={() => void removeSession(s)} title="Delete session">
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* 1. Stems */}
      <Section
        icon="◉"
        title="1. Stems — each waveform is one stem"
        action={
          <>
            <input
              ref={fileRef}
              type="file"
              accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.oga,.opus"
              multiple
              className="hidden"
              onChange={(e) => void upload(e.target.files)}
            />
            <Button size="sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
              {uploading ? "Uploading…" : "Upload stems"}
            </Button>
            <input
              ref={splitFileRef}
              type="file"
              accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.oga,.opus"
              className="hidden"
              onChange={(e) => void splitSong(e.target.files?.[0])}
            />
            <span className="flex items-center gap-1">
              <select
                className="ui-input !w-auto !px-1.5 !py-1 text-xs"
                value={splitQuality}
                onChange={(e) => setSplitQuality(e.target.value as "fast" | "hq")}
                title="Separation quality — fast: instant spectral split (drums/bass/other); studio: demucs AI model (adds vocals — needs a one-time ~600 MB install)"
              >
                <option value="fast">fast</option>
                <option value="hq">studio</option>
              </select>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => splitFileRef.current?.click()}
                disabled={splitJob?.status === "running"}
                title="Upload a full song — the engine separates it into stems automatically"
              >
                Split song → stems
              </Button>
            </span>
          </>
        }
      >
        {splitJob && (
          <div className="mb-3 rounded-lg border border-slate-700/60 bg-slate-900/50 px-3 py-2 space-y-1.5">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-slate-300">Separating song</span>
              <Badge tone={splitJob.quality === "hq" ? "violet" : "info"}>{splitJob.backend ?? splitJob.quality}</Badge>
              {splitJob.status === "running" && <Spinner className="w-3 h-3" />}
              <span className="flex-1" />
              {splitJob.status === "running" ? (
                <button className="text-slate-400 hover:text-rose-400" onClick={() => void api.vizCancelSplit(splitJob.id).then((r) => setSplitJob(r.job)).catch(() => {})}>
                  cancel
                </button>
              ) : (
                <button className="text-slate-500 hover:text-slate-300" onClick={() => setSplitJob(null)} title="Dismiss">
                  ×
                </button>
              )}
            </div>
            {splitJob.status === "running" && (
              <>
                <ProgressBar value={splitJob.progress.done} max={Math.max(1, splitJob.progress.total)} height="h-1" />
                <div className="text-[11px] text-slate-500">
                  {splitJob.progress.phase}
                  {splitJob.progress.detail ? ` — ${splitJob.progress.detail}` : ""} ({splitJob.progress.done}/{splitJob.progress.total})
                </div>
              </>
            )}
            {splitJob.status === "done" && (
              <div className="text-[11px] text-emerald-400">
                ✔ {splitJob.stems.length} stems added ({splitJob.backend}) — they're in the render set
              </div>
            )}
            {splitJob.status === "failed" && (
              <div className="text-[11px] text-rose-400">
                ✖ {splitJob.error?.message}
                {splitJob.error?.code === "SEP_SETUP_REQUIRED" && !sep?.installed && (
                  <button className="ml-2 underline hover:text-rose-300" onClick={() => void api.vizSepSetup().then((r) => setSep(r.sep)).catch(() => {})}>
                    set it up now (~600 MB)
                  </button>
                )}
              </div>
            )}
            {splitJob.status === "cancelled" && <div className="text-[11px] text-slate-500">cancelled</div>}
          </div>
        )}
        {sep && !sep.installed && sep.phase !== "idle" && sep.phase !== "error" && (
          <div className="mb-3 rounded border border-sky-800/50 bg-sky-950/30 px-3 py-1.5 text-[11px] text-sky-300">
            Installing studio separation — {sep.detail}…
          </div>
        )}
        <div className="grid md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-slate-400 pb-1">
              <span>Uploaded ({stems.length})</span>
              {stems.length > 0 && (
                <span className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={addAllToRender}
                    disabled={stems.every((s) => inRender.has(s.name))}
                  >
                    Add all →
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void clearAllStems()} title="Delete all uploaded stems">
                    Clear
                  </Button>
                </span>
              )}
            </div>
            <div className="max-h-72 overflow-y-auto space-y-1 pr-1">
              {stems.length === 0 && <EmptyState icon="♪" title="No stems yet" description="Upload separated stems (vocals, drums, bass, keys…) — each gets its own visual." />}
              {stems.map((s) => {
                const sig = signalsRef.current.get(s.name);
                return (
                  <div key={s.name} className="rounded px-2 py-1 hover:bg-slate-700/30 space-y-1.5">
                    <div className="flex items-center gap-2 text-sm">
                      <Badge tone="info">{detectStemKind(s.name)}</Badge>
                      <span className="flex-1 truncate" title={s.name}>{s.name}</span>
                      {pendingNames.has(s.name) && <Spinner className="w-3 h-3 shrink-0" />}
                      {failedSignals.current.has(s.name) && (
                        <span
                          className="text-amber-400 cursor-help shrink-0"
                          title={`Preview decode failed: ${failedSignals.current.get(s.name)}`}
                        >
                          ⚠
                        </span>
                      )}
                      <span className="text-slate-500 text-xs">{s.durationSec ? `${s.durationSec.toFixed(1)}s` : ""}</span>
                      {sig?.features && <Badge tone="violet">fx</Badge>}
                      <button
                        className="w-6 h-6 rounded-full border border-slate-600 text-[10px] text-slate-300 hover:border-sky-500 hover:text-sky-300 shrink-0"
                        onClick={() => toggleAudition(s)}
                        title={auditioning === s.name ? "Stop" : "Play stem"}
                      >
                        {auditioning === s.name ? "■" : "▶"}
                      </button>
                      <Button size="sm" disabled={inRender.has(s.name)} onClick={() => addToRender(s.name)}>
                        Add →
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void removeStem(s.name)} title="Delete stem">
                        ✕
                      </Button>
                    </div>
                    {pendingNames.has(s.name) ? (
                      <AnalysisBar queued={s.name !== decodingName} phase={s.name === decodingName ? sigPhase : null} />
                    ) : sig ? (
                      <StemWave signal={sig} color={colorByStem.get(s.name) ?? "#38bdf8"} />
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>In this visual ({stemInputs.length})</span>
              {stemInputs.length > 0 && (
                <Button size="sm" variant="ghost" onClick={() => setStemInputs([])}>
                  Clear
                </Button>
              )}
            </div>
            <ol className="max-h-72 overflow-y-auto space-y-1 pr-1">
              {stemInputs.length === 0 && (
                <p className="text-sm text-slate-500 py-2">
                  {stems.length > 0
                    ? 'Click "Add →" on a stem to include it — or just upload files and they land here automatically.'
                    : "Upload stems on the left — each becomes a colored waveform."}
                </p>
              )}
              {stemInputs.map((s, i) => {
                const resolved = resolveStem(s, i);
                return (
                  <li key={s.name} className="rounded px-2 py-1.5 bg-slate-800/40 space-y-1.5">
                    <div className="flex items-center gap-2 text-sm">
                      <button
                        className={`w-5 h-5 rounded border border-slate-600 ${s.muted ? "opacity-40" : ""}`}
                        style={{ background: resolved.color }}
                        title="Click to change color"
                        onClick={() => {
                          const inp = document.createElement("input");
                          inp.type = "color";
                          inp.value = resolved.color;
                          inp.oninput = () => patchStem(s.name, { color: inp.value });
                          inp.click();
                        }}
                      />
                      <span className="flex-1 truncate" title={s.name}>{s.name}</span>
                      {pendingNames.has(s.name) && <Spinner className="w-3 h-3 shrink-0" />}
                      <button
                        className={`text-[10px] px-1.5 py-0.5 rounded border ${s.muted ? "border-rose-600 text-rose-400" : "border-slate-600 text-slate-400"}`}
                        onClick={() => patchStem(s.name, { muted: !s.muted })}
                        title="Mute"
                      >
                        M
                      </button>
                      <button
                        className={`text-[10px] px-1.5 py-0.5 rounded border ${s.solo ? "border-amber-500 text-amber-400" : "border-slate-600 text-slate-400"}`}
                        onClick={() => patchStem(s.name, { solo: !s.solo })}
                        title="Solo"
                      >
                        S
                      </button>
                    </div>
                    {pendingNames.has(s.name) ? (
                      <AnalysisBar queued={s.name !== decodingName} phase={s.name === decodingName ? sigPhase : null} />
                    ) : signalsRef.current.has(s.name) ? (
                      <StemWave signal={signalsRef.current.get(s.name)!} color={resolved.color} />
                    ) : null}
                    {failedSignals.current.has(s.name) && (
                      <div className="flex items-start gap-1.5 text-[11px] text-amber-300">
                        <span className="shrink-0" title="Preview decode failed">⚠</span>
                        <span className="flex-1 break-words">No preview: {failedSignals.current.get(s.name)}</span>
                        <button className="text-sky-400 hover:underline shrink-0" onClick={() => retrySignal(s.name)}>
                          retry
                        </button>
                      </div>
                    )}
                    <div className="flex items-center gap-2 text-[11px] text-slate-400">
                      <select
                        className="ui-input !py-0.5 text-[11px] w-20"
                        value={resolved.kind}
                        onChange={(e) => patchStem(s.name, { kind: e.target.value as StemKind })}
                        title="Stem kind"
                      >
                        {STEM_KINDS.map((k) => (
                          <option key={k} value={k}>{k}</option>
                        ))}
                      </select>
                      <label className="flex items-center gap-1">amp
                        <input type="range" min={0.05} max={4} step={0.05} value={resolved.amplitudeScale} className="w-16"
                          onChange={(e) => patchStem(s.name, { amplitudeScale: Number(e.target.value) })} />
                        <span className="w-8">{resolved.amplitudeScale.toFixed(2)}</span>
                      </label>
                      <label className="flex items-center gap-1">glow
                        <input type="range" min={0} max={60} step={1} value={resolved.glowRadius} className="w-16"
                          onChange={(e) => patchStem(s.name, { glowRadius: Number(e.target.value) })} />
                      </label>
                      <div className="flex-1" />
                      <button className="text-slate-500 hover:text-slate-200 disabled:opacity-30" disabled={i === 0} onClick={() => moveStem(i, -1)} title="Move up">↑</button>
                      <button className="text-slate-500 hover:text-slate-200 disabled:opacity-30" disabled={i === stemInputs.length - 1} onClick={() => moveStem(i, 1)} title="Move down">↓</button>
                      <button
                        className="text-slate-500 hover:text-rose-400"
                        onClick={() => removeFromRender(s.name)}
                        title="Remove from this visual (file stays in the library)"
                      >
                        ✕
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      </Section>

      {/* 2. Visual settings */}
      <Section icon="◈" title="2. Look">{lookContent}</Section>

      {/* 3. Media layers */}
      <Section
        icon="▣"
        title="3. Media layers"
        action={
          <span className="text-xs text-slate-500">
            {globals.video.layers.length}/{VIZ_MAX_VIDEO_LAYERS} — row 1 is the top layer; the 2. Look visuals need a ◈ row
          </span>
        }
      >
        {layersContent}
      </Section>

      {/* 4. Preview */}
      <Section icon="▶" title="4. Live preview" action={<span className="text-xs text-slate-500">same math as the MP4 export — pixel-identical geometry</span>}>
        {globals.video.layers.map((l, i) => {
          // Visuals rows draw procedurally; hidden rows keep their config but
          // don't draw — skipping the element also saves the video decode.
          if (l.kind !== "media" || l.hidden) return null;
          const asset = videoAssets.find((a) => a.id === l.assetId);
          const isImg = isImageFileName(asset?.local_path ?? asset?.title ?? "");
          const keyed = keyedUrlFor(l);
          const src = isImg ? api.assetFileUrl(l.assetId) : keyed ?? api.assetFileUrl(l.assetId);
          const setEl = (el: HTMLVideoElement | HTMLImageElement | null) => {
            if (el) layerElsRef.current.set(i, el);
            else layerElsRef.current.delete(i);
          };
          return isImg ? (
            <img key={`${i}:${l.assetId}`} ref={setEl} src={src} className="hidden" alt="" />
          ) : (
            <video key={`${i}:${l.assetId}:${keyed ?? "raw"}`} ref={setEl} src={src} className="hidden" muted loop playsInline preload="auto" />
          );
        })}
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="primary"
            disabled={resolvedStems.length === 0}
            onClick={() => (playing ? pausePlayback() : void startPlayback(scrubT))}
          >
            {playing ? "⏸ Pause" : "▶ Play"}
          </Button>
          <input
            type="range"
            min={0}
            max={Math.max(1, duration)}
            step={0.033}
            value={Math.min(scrubT, duration)}
            className="flex-1"
            onChange={(e) => {
              const t = Number(e.target.value);
              setScrubT(t);
              if (playing) void startPlayback(t);
            }}
          />
          <span className="text-xs text-slate-400 w-20 text-right">{mmss(scrubT)}</span>
          <Button size="sm" variant="ghost" onClick={toggleFullscreen} title={fullscreen ? "Exit fullscreen" : "Fullscreen preview (double-click the canvas too)"}>
            {fullscreen ? "✕" : "⛶"}
          </Button>
        </div>
        <div
          ref={previewBoxRef}
          onDoubleClick={toggleFullscreen}
          onClick={fullscreen ? pokeFsControls : undefined}
          onMouseMove={fullscreen ? pokeFsControls : undefined}
          className={fullscreen ? "relative w-full h-full bg-black flex items-center justify-center overflow-hidden" : ""}
        >
          <canvas
            ref={canvasRef}
            width={640}
            height={canvasH}
            onClick={onCanvasClick}
            title={fullscreen ? "Click to play/pause · double-click to exit fullscreen" : undefined}
            className={fullscreen ? "max-w-full max-h-full cursor-pointer" : "mx-auto block rounded-lg border border-slate-700/60 bg-black"}
            style={fullscreen ? undefined : { aspectRatio: `${renderSettings.width}/${renderSettings.height}`, width: "auto", maxWidth: "100%", maxHeight: "50vh" }}
          />
          {fullscreen && fsFlash && (
            <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
              <span className="text-6xl text-white/80 drop-shadow-[0_2px_8px_rgba(0,0,0,0.8)]">{fsFlash === "play" ? "▶" : "⏸"}</span>
            </div>
          )}
          {fullscreen && (
            <>
              <button
                type="button"
                onClick={() => setLayersOpen((o) => !o)}
                onDoubleClick={(e) => e.stopPropagation()}
                className="absolute top-3 left-3 z-10 rounded-md border border-slate-600 bg-slate-900/80 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-800"
                title="Show/hide the Media layers panel"
              >
                {layersOpen ? "✕ Layers" : "▣ Layers"}
              </button>
              <button
                type="button"
                onClick={() => setLookOpen((o) => !o)}
                onDoubleClick={(e) => e.stopPropagation()}
                className="absolute top-3 right-3 z-10 rounded-md border border-slate-600 bg-slate-900/80 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-800"
                title="Show/hide the Look settings"
              >
                {lookOpen ? "✕ Look" : "◈ Look"}
              </button>
              {lookOpen && (
                <div
                  className="absolute top-12 right-3 bottom-3 z-10 w-80 max-w-[85vw] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 p-4 space-y-4 shadow-xl"
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wide text-slate-300">◈ 2. Look</span>
                    <button type="button" className="text-slate-500 hover:text-slate-200" onClick={() => setLookOpen(false)}>✕</button>
                  </div>
                  {lookContent}
                </div>
              )}
              {layersOpen && (
                <div
                  className="absolute top-12 left-3 bottom-3 z-10 w-[26rem] max-w-[85vw] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 p-4 space-y-4 shadow-xl"
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wide text-slate-300">▣ 3. Media layers</span>
                    <button type="button" className="text-slate-500 hover:text-slate-200" onClick={() => setLayersOpen(false)}>✕</button>
                  </div>
                  {layersContent}
                </div>
              )}
              {fsControls && (
                <div
                  className="absolute inset-x-0 bottom-0 z-10 flex justify-center px-4 pb-5"
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  <div className="flex w-[min(46rem,100%)] items-center gap-3 rounded-xl border border-slate-700 bg-slate-900/85 px-4 py-2.5 shadow-xl backdrop-blur">
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={resolvedStems.length === 0}
                      onClick={() => (playing ? pausePlayback() : void startPlayback(scrubT))}
                      title={playing ? "Pause" : "Play"}
                    >
                      {playing ? "⏸" : "▶"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={stopPlayback} title="Stop — back to the start">
                      ⏹
                    </Button>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(1, duration)}
                      step={0.033}
                      value={Math.min(scrubT, duration)}
                      className="flex-1"
                      onChange={(e) => {
                        const t = Number(e.target.value);
                        setScrubT(t);
                        if (playing) void startPlayback(t);
                      }}
                    />
                    <span className="shrink-0 text-xs text-slate-300 tabular-nums">
                      {mmss(scrubT)} / {mmss(duration)}
                    </span>
                    <Button size="sm" variant="ghost" onClick={toggleFullscreen} title="Exit fullscreen">
                      ✕
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        {stemInputs.length === 0 && <p className="text-xs text-slate-500">Add stems (step 1) to see the preview.</p>}
        {pendingSignals.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs text-slate-500 flex items-center gap-2">
              <Spinner className="w-3 h-3" />
              Decoding stem signals — {decodeDone}/{stemInputs.length}
              <span className="text-slate-400 truncate">· {pendingSignals[0]!.name}</span>
            </p>
            <ProgressBar value={decodeDone} max={Math.max(1, stemInputs.length)} height="h-1" />
          </div>
        )}
      </Section>

      {/* 5. Render */}
      <Section icon="⇩" title="5. Render">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <div
            className="flex items-center rounded-md border border-slate-700 p-0.5"
            title="Aspect ratio — the live preview and the exported MP4 both reshape to it"
          >
            {([
              { id: "16:9", label: "▭ 16:9" },
              { id: "9:16", label: "▯ 9:16" },
              { id: "1:1", label: "◻ 1:1" },
            ] as const).map((a) => (
              <button
                key={a.id}
                type="button"
                className={`px-2.5 py-1 rounded text-xs ${aspectId === a.id ? "bg-sky-600 text-white" : "text-slate-400 hover:text-slate-200"}`}
                onClick={() => applyOutput(a.id, quality)}
              >
                {a.label}
              </button>
            ))}
          </div>
          <select
            className="ui-input"
            value={quality}
            onChange={(e) => applyOutput(aspectId, e.target.value as "1080p" | "4k")}
            title="Output resolution"
          >
            <option value="1080p">1080p</option>
            <option value="4k">4K</option>
          </select>
          <span className="text-xs text-slate-500 tabular-nums">{renderSettings.width}×{renderSettings.height}</span>
          <select className="ui-input" value={renderSettings.fps} onChange={(e) => setRenderSettings((s) => ({ ...s, fps: Number(e.target.value) }))}>
            <option value={24}>24 fps</option>
            <option value={30}>30 fps</option>
            <option value={60}>60 fps</option>
          </select>
          <Button variant="primary" onClick={() => void render(false)} disabled={stemInputs.length === 0 || rendering}>
            {rendering ? "Rendering…" : "Render MP4"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => void render(true)}
            disabled={stemInputs.length === 0 || rendering}
            title="Fast, low-quality first draft — ~480px, 12 fps, ultrafast encode"
          >
            ⚡ Draft
          </Button>
          <Button variant="ghost" onClick={() => revealRender()} title="Open the renders folder in the file explorer (created on demand if empty)">
            📁 Open folder
          </Button>
          {rendering && <Spinner />}
        </div>
        {job && (
          <div className="space-y-2">
            <div className="flex items-center gap-3 text-sm">
              <Badge tone={job.status === "done" ? "good" : job.status === "failed" ? "bad" : "info"}>{job.status}</Badge>
              <span className="text-slate-400 text-xs">
                {RENDER_PHASE_LABELS[job.progress.phase] ?? job.progress.phase} · {job.progress.done}/{job.progress.total}
                {job.progress.detail ? ` · ${job.progress.detail}` : ""}
              </span>
              {job.status === "running" && (
                <>
                  <span className="text-slate-500 text-xs tabular-nums">
                    {fmtDur((Date.now() - Date.parse(job.startedAt)) / 1000)} elapsed
                    {renderOverallPct(job.progress) > 3 &&
                      ` · ~${fmtDur(((Date.now() - Date.parse(job.startedAt)) / 1000) * (100 - renderOverallPct(job.progress)) / renderOverallPct(job.progress))} left`}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => void api.vizCancelRender(job.id).then((r) => setJob(r.job)).catch(() => {})}>
                    Cancel
                  </Button>
                </>
              )}
            </div>
            {/* Overall progress — each phase takes a share of the bar (frames
                dominates), so the fill doesn't jump between phases. */}
            <ProgressBar value={renderOverallPct(job.progress)} />
            {/* Rolling render log — phase transitions + ~10% checkpoints. */}
            {renderLog.length > 0 && (
              <pre
                ref={renderLogRef}
                className="max-h-24 overflow-y-auto rounded bg-slate-950/70 border border-slate-800/60 px-2.5 py-1.5 text-[10px] font-mono text-slate-400 whitespace-pre-wrap"
              >
                {renderLog.join("\n")}
              </pre>
            )}
            {job.error && <p className="text-xs text-rose-400">{job.error.message}</p>}
            {job.status === "done" && job.outputUrl && (
              <div className="space-y-1.5">
                <video controls className="w-full max-w-xl rounded-lg border border-slate-700/60" src={job.outputUrl} />
                <button
                  className="block text-xs text-sky-400 hover:underline break-all text-left"
                  title="Open in Windows Explorer"
                  onClick={() => revealRender(renderFileName(job.outputUrl!))}
                >
                  📁 {job.outputPath ?? renderFileName(job.outputUrl)}
                </button>
              </div>
            )}
          </div>
        )}
        {renders.length > 0 && (
          <div className="space-y-1 pt-2 border-t border-slate-700/50">
            <div className="text-xs text-slate-400">Renders ({renders.length})</div>
            {renders.map((r) => (
              <div key={r.name} className="flex items-center gap-2 text-sm">
                <a href={r.url} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline truncate flex-1" title={r.path}>{r.name}</a>
                <span className="text-slate-500 text-xs">{(r.sizeBytes / 1e6).toFixed(1)} MB</span>
                <button className="text-slate-500 hover:text-sky-400 text-xs shrink-0" title={`Show in folder — ${r.path}`} onClick={() => revealRender(r.name)}>
                  folder
                </button>
                {r.configUrl && (
                  <a href={r.configUrl} target="_blank" rel="noreferrer" className="text-slate-500 hover:text-slate-300 text-xs">config</a>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
