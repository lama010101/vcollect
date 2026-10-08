import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  chromaKeyFrame,
  computeDancer,
  computeFrame,
  coverCrop,
  frameCenter,
  detectStemKind,
  isStemAudible,
  resolveStem,
  STEM_KINDS,
  type DancerConfig,
  type FrameStem,
  type StemKind,
  type StemSignal,
  type VisualizerRenderInput,
  type VizChromaKeyConfig,
  type VizFrameState,
  type VizLayout,
  type VizMode,
  type VizVideoLayer,
  type VisualizerStemInput,
} from "@twio/shared";
import {
  api,
  ASSETS_CHANGED_EVENT,
  type Asset,
  type EngineStatus,
  type VizRenderJob,
  type VizRenderedFile,
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
}

type VisualizerGlobals = VisualizerRenderInput["globalVisuals"];

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
  video: { assetId: null, layer: "under", opacity: 1, chromaKey: { enabled: false, color: "#00FF00", similarity: 0.12, blend: 0.02 } },
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

function loadPersisted(projectId: string): PersistedViz | null {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PersistedViz>;
    return {
      stems: Array.isArray(p.stems) ? p.stems : [],
      globals: { ...DEFAULT_GLOBALS, ...(p.globals ?? {}), dancer: { ...DEFAULT_GLOBALS.dancer, ...(p.globals?.dancer ?? {}) }, autoGlow: { ...DEFAULT_GLOBALS.autoGlow, ...(p.globals?.autoGlow ?? {}) }, video: { ...DEFAULT_GLOBALS.video, ...(p.globals?.video ?? {}), chromaKey: { ...DEFAULT_GLOBALS.video.chromaKey, ...(p.globals?.video?.chromaKey ?? {}) } }, autoCenter: { ...DEFAULT_GLOBALS.autoCenter, ...(p.globals?.autoCenter ?? {}) }, centerConvergence: { ...DEFAULT_GLOBALS.centerConvergence, ...(p.globals?.centerConvergence ?? {}) } },
      render: { ...DEFAULT_RENDER, ...(p.render ?? {}) },
      jobId: typeof p.jobId === "string" ? p.jobId : null,
    };
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

/** Draw the cover-cropped video frame into the key canvas, apply the shared
 *  chroma-key pixel pass (same threshold+feather ramp as the export's ffmpeg
 *  `colorkey`), and return it as a draw source. */
function keyedVideoSource(
  video: HTMLVideoElement,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  w: number,
  h: number,
  key: VizChromaKeyConfig,
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
  keyCtx.drawImage(video, sx, sy, sw, sh, 0, 0, kw, kh);
  const img = keyCtx.getImageData(0, 0, kw, kh);
  chromaKeyFrame(img.data, key.color, key.similarity, key.blend);
  keyCtx.putImageData(img, 0, 0);
  return keyCanvas;
}

function drawState(
  ctx: CanvasRenderingContext2D,
  state: VizFrameState,
  w: number,
  h: number,
  bg: string,
  video?: HTMLVideoElement | null,
): void {
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // Video layer — same placement as the <image> in frameSvg: `under` right
  // after the background, `over` after the mode visuals (below dancer + star).
  // Cover-cropped with the shared coverCrop math — identical to the export's
  // ffmpeg scale/crop.
  const drawVideo = () => {
    const v = state.video;
    if (!v || !video || video.readyState < 2 || video.videoWidth === 0) return;
    const [sx, sy, sw, sh] = coverCrop(video.videoWidth, video.videoHeight, w, h);
    ctx.globalAlpha = v.opacity;
    if (v.chromaKey) {
      const src = keyedVideoSource(video, sx, sy, sw, sh, w, h, v.chromaKey);
      if (src) ctx.drawImage(src, 0, 0, w, h);
    } else {
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
    }
    ctx.globalAlpha = 1;
  };
  if (state.video?.layer === "under") drawVideo();

  for (const s of state.stems) {
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

  for (const r of state.rings) {
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

  for (const g of state.bars) {
    ctx.globalAlpha = g.alpha;
    ctx.fillStyle = g.color;
    for (let i = 0; i + 3 < g.bars.length; i += 4) {
      ctx.fillRect(g.bars[i]!, g.bars[i + 1]!, g.bars[i + 2]!, g.bars[i + 3]!);
    }
  }

  for (const g of state.particles) {
    ctx.globalAlpha = g.alpha;
    ctx.fillStyle = g.color;
    for (let i = 0; i + 2 < g.points.length; i += 3) {
      ctx.beginPath();
      ctx.arc(g.points[i]!, g.points[i + 1]!, g.points[i + 2]!, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  for (const m of state.mirrors) {
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

  for (const g of state.blocks) {
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
  for (const g of state.eqbars) {
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
  for (const g of state.eqradial) {
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

  for (const s of state.stereos) {
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
  for (const s of state.silks) {
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

  if (state.video?.layer === "over") drawVideo();

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
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Preview state
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
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

  // Downloaded project assets eligible as the optional video layer.
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

  // Restore session for this project + load stems/renders.
  useEffect(() => {
    const saved = loadPersisted(projectId);
    setStemInputs(saved?.stems ?? []);
    setGlobals(saved?.globals ?? DEFAULT_GLOBALS);
    setRenderSettings(saved?.render ?? DEFAULT_RENDER);
    setJob(null);
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
  }, [projectId, loadStems, loadRenders]);

  // Persist session.
  useEffect(() => {
    try {
      localStorage.setItem(storageKey(projectId), JSON.stringify({ stems: stemInputs, globals, render: renderSettings, jobId: job?.id ?? null } satisfies PersistedViz));
    } catch { /* best-effort */ }
  }, [projectId, stemInputs, globals, renderSettings, job?.id]);

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

  // Poll active render.
  useEffect(() => {
    if (!job || job.status !== "running") return;
    const t = setInterval(() => {
      api
        .vizRenderJob(job.id)
        .then((r) => {
          setJob(r.job);
          if (r.job.status === "done") {
            onToast("Visualizer rendered", "success");
            loadRenders().catch(() => {});
          } else if (r.job.status === "failed") {
            onToast(`Render failed: ${r.job.error?.message ?? "unknown error"}`, "error");
          }
        })
        .catch(() => {});
    }, 1000);
    return () => clearInterval(t);
  }, [job, onToast, loadRenders]);

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
      // Video layer sync — the element free-runs while playing (drift-
      // corrected each frame), and follows the scrub position when paused.
      // `t % duration` mirrors the export's -stream_loop wrap.
      const vid = videoRef.current;
      if (vid && state.video) {
        const vd = vid.duration;
        if (Number.isFinite(vd) && vd > 0) {
          const target = t % vd;
          if (playingRef.current) {
            if (vid.paused) void vid.play().catch(() => {});
            if (Math.abs(vid.currentTime - target) > 0.25) vid.currentTime = target;
          } else {
            if (!vid.paused) vid.pause();
            if (Math.abs(vid.currentTime - target) > 0.03) vid.currentTime = target;
          }
        }
      }
      drawState(ctx, state, w, h, globals.backgroundColor, videoRef.current);
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

  const render = async () => {
    setError(null);
    try {
      const req: VisualizerRenderInput = {
        renderSettings: { width: renderSettings.width, height: renderSettings.height, fps: renderSettings.fps },
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
  const setKey = (patch: Partial<VizChromaKeyConfig>) =>
    setGlobals((g) => ({ ...g, video: { ...g.video, chromaKey: { ...g.video.chromaKey, ...patch } } }));

  // Sample the top-left 12×12 source pixels of the current video frame —
  // that's where a flat monochrome background sits — and use the average as
  // the key color. Needs a decoded frame (readyState ≥ 2).
  const sampleVideoBg = () => {
    const v = videoRef.current;
    if (!v || v.readyState < 2 || v.videoWidth === 0) return;
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    const x = c.getContext("2d");
    if (!x) return;
    x.drawImage(v, 0, 0, 12, 12, 0, 0, 1, 1);
    const d = x.getImageData(0, 0, 1, 1).data;
    setKey({ color: `#${((1 << 24) | (d[0]! << 16) | (d[1]! << 8) | d[2]!).toString(16).slice(1).toUpperCase()}` });
  };

  const spectrumNeedsEngine = globals.mode === "spectrum";
  const rendering = job?.status === "running";
  const canvasH = Math.round((640 * renderSettings.height) / renderSettings.width);
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
  // fullscreen preview overlay, so edits apply live in both places.
  const lookContent = (
    <>
      <div className="grid md:grid-cols-3 gap-4 text-sm">
        <div className="space-y-2">
          <label className="block text-xs text-slate-400">Mode</label>
          <select className="ui-input w-full" value={globals.mode} onChange={(e) => setG("mode", e.target.value as VizMode)}>
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>{m.label}{m.needsEngine ? " (engine)" : ""}</option>
            ))}
          </select>
          {spectrumNeedsEngine && !engine?.ok && (
            <p className="text-[11px] text-amber-400">Spectrum needs engine features — set up the Python engine above first.</p>
          )}
          {globals.mode === "ribbons" && (
            <>
              <label className="block text-xs text-slate-400 pt-2">Layout</label>
              <select className="ui-input w-full" value={globals.layout} onChange={(e) => setG("layout", e.target.value as VizLayout)}>
                {LAYOUTS.map((l) => (
                  <option key={l.value} value={l.value}>{l.label}</option>
                ))}
              </select>
            </>
          )}
          {globals.mode === "eqradial" && (
            <>
              <label className="block text-xs text-slate-400 pt-2">Inner radius: {Math.round(globals.innerRadius * 100)}%</label>
              <input type="range" min={0} max={0.5} step={0.01} value={globals.innerRadius} className="w-full" onChange={(e) => setG("innerRadius", Number(e.target.value))} />
            </>
          )}
        </div>
        <div className="space-y-2">
          <label className="block text-xs text-slate-400">Waveform window: {globals.waveformLengthSec.toFixed(2)} s</label>
          <input type="range" min={0.1} max={2} step={0.05} value={globals.waveformLengthSec} className="w-full" onChange={(e) => setG("waveformLengthSec", Number(e.target.value))} />
          <label className="block text-xs text-slate-400">Global amplitude: {globals.globalAmplitude.toFixed(2)}×</label>
          <input type="range" min={0.1} max={3} step={0.05} value={globals.globalAmplitude} className="w-full" onChange={(e) => setG("globalAmplitude", Number(e.target.value))} />
          <label className={`block text-xs ${globals.autoGlow.enabled ? "text-slate-600" : "text-slate-400"}`}>Glow: {globals.glowIntensity.toFixed(0)}</label>
          <input type="range" min={0} max={40} step={1} value={globals.glowIntensity} disabled={globals.autoGlow.enabled} className="w-full disabled:opacity-40" onChange={(e) => setG("glowIntensity", Number(e.target.value))} />
          <div className="pt-1 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs text-slate-400">Glow range: {globals.autoGlow.min.toFixed(0)}–{globals.autoGlow.max.toFixed(0)}</label>
              <Button
                size="sm"
                variant={globals.autoGlow.enabled ? "primary" : "ghost"}
                onClick={() => setG("autoGlow", { ...globals.autoGlow, enabled: !globals.autoGlow.enabled })}
                title="Pick a random glow inside the range on every beat"
              >
                Auto
              </Button>
            </div>
            <DualRange
              min={0}
              max={40}
              step={1}
              lo={globals.autoGlow.min}
              hi={globals.autoGlow.max}
              onChange={(lo, hi) => setG("autoGlow", { ...globals.autoGlow, min: lo, max: hi })}
            />
            {globals.autoGlow.enabled && (
              <p className="text-[10px] text-slate-500">Auto is on — glow jumps to a random value in this range on every beat (overrides the slider above).</p>
            )}
          </div>
        </div>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-xs text-slate-400">
            Background
            <input type="color" value={globals.backgroundColor} onChange={(e) => setG("backgroundColor", e.target.value)} className="w-8 h-6 rounded border border-slate-600" />
          </label>
          <div className="rounded-lg border border-slate-700/60 bg-slate-800/40 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">Center</span>
              <Button
                size="sm"
                variant={globals.autoCenter.enabled ? "primary" : "ghost"}
                onClick={() => setG("autoCenter", { ...globals.autoCenter, enabled: !globals.autoCenter.enabled })}
                title="Move the center to a new spot on every beat"
              >
                Auto
              </Button>
            </div>
            <label className={`block text-xs ${globals.autoCenter.enabled ? "text-slate-600" : "text-slate-400"}`}>Center X: {globals.centerConvergence.x.toFixed(2)}</label>
            <input type="range" min={0} max={1} step={0.01} value={globals.centerConvergence.x} disabled={globals.autoCenter.enabled} className="w-full disabled:opacity-40" onChange={(e) => setG("centerConvergence", { ...globals.centerConvergence, x: Number(e.target.value) })} />
            <label className={`block text-xs ${globals.autoCenter.enabled ? "text-slate-600" : "text-slate-400"}`}>Center Y: {globals.centerConvergence.y.toFixed(2)}</label>
            <input type="range" min={0} max={1} step={0.01} value={globals.centerConvergence.y} disabled={globals.autoCenter.enabled} className="w-full disabled:opacity-40" onChange={(e) => setG("centerConvergence", { ...globals.centerConvergence, y: Number(e.target.value) })} />
            {globals.autoCenter.enabled && (
              <>
                <label className="block text-xs text-slate-400 pt-1">Motion range: {Math.round(globals.autoCenter.range * 100)}%</label>
                <input type="range" min={0} max={0.35} step={0.01} value={globals.autoCenter.range} className="w-full" onChange={(e) => setG("autoCenter", { ...globals.autoCenter, range: Number(e.target.value) })} />
                <p className="text-[10px] text-slate-500">Auto is on — the center glides to a new spot on every beat (overrides the X/Y sliders).</p>
              </>
            )}
          </div>
        </div>
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
          </>
        }
      >
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

      {/* 3. Video */}
      <Section icon="▣" title="3. Video" action={<span className="text-xs text-slate-500">optional project clip layered with the visuals</span>}>
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3 text-sm">
          <div className="space-y-1 min-w-0">
            <label className="block text-xs text-slate-400">Project asset video</label>
            <select
              className="ui-input w-80 max-w-full"
              value={globals.video.assetId ?? ""}
              onChange={(e) => setG("video", { ...globals.video, assetId: e.target.value || null })}
            >
              <option value="">None — visuals only</option>
              {videoAssets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title ?? a.id}
                  {a.duration_seconds ? ` · ${a.duration_seconds.toFixed(0)}s` : ""}
                  {a.width && a.height ? ` · ${a.width}×${a.height}` : ""}
                </option>
              ))}
            </select>
            {videoAssets.length === 0 && (
              <p className="text-[11px] text-slate-500">
                No downloaded videos in this project — KEEP assets on Search/Folders or drop files onto the app first.
              </p>
            )}
            {globals.video.assetId && videoAssets.length > 0 && !videoAssets.some((a) => a.id === globals.video.assetId) && (
              <p className="text-[11px] text-amber-400">The saved video is no longer in this project — pick another one.</p>
            )}
          </div>
          {globals.video.assetId && (
            <>
              <div className="space-y-1">
                <label className="block text-xs text-slate-400">Layer</label>
                <div className="flex gap-1">
                  {(["under", "over"] as VizVideoLayer[]).map((l) => (
                    <Button
                      key={l}
                      size="sm"
                      variant={globals.video.layer === l ? "primary" : "ghost"}
                      onClick={() => setG("video", { ...globals.video, layer: l })}
                    >
                      {l === "under" ? "Under" : "Above"}
                    </Button>
                  ))}
                </div>
                <p className="text-[10px] text-slate-500">
                  {globals.video.layer === "under" ? "behind the equalizer, over the background" : "over the equalizer, under dancer/star"}
                </p>
              </div>
              <div className="space-y-1 w-44">
                <label className="block text-xs text-slate-400">Opacity: {Math.round(globals.video.opacity * 100)}%</label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={globals.video.opacity}
                  className="w-full"
                  onChange={(e) => setG("video", { ...globals.video, opacity: Number(e.target.value) })}
                />
              </div>
              <img
                key={globals.video.assetId}
                src={api.assetThumbUrl(globals.video.assetId)}
                alt=""
                className="h-14 rounded border border-slate-700/60 object-cover"
                onError={(e) => (e.currentTarget.style.display = "none")}
              />
              <div className="space-y-1">
                <label className="block text-xs text-slate-400">Remove flat background</label>
                <Button
                  size="sm"
                  variant={globals.video.chromaKey.enabled ? "primary" : "ghost"}
                  onClick={() => setKey({ enabled: !globals.video.chromaKey.enabled })}
                  title="Chroma-key: make one flat color in the video transparent"
                >
                  Color key
                </Button>
                {globals.video.chromaKey.enabled && (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
                    <span className="flex items-center gap-2">
                      <input
                        type="color"
                        value={globals.video.chromaKey.color}
                        onChange={(e) => setKey({ color: e.target.value.toUpperCase() })}
                        className="w-8 h-6 rounded border border-slate-600"
                        title="The flat background color to remove"
                      />
                      <Button size="sm" variant="ghost" onClick={sampleVideoBg} title="Sample the top-left pixel of the current video frame">
                        ⤡ sample corner
                      </Button>
                    </span>
                    <span className="flex items-center gap-2 text-xs text-slate-400">
                      Tolerance {Math.round(globals.video.chromaKey.similarity * 100)}%
                      <input
                        type="range"
                        min={0}
                        max={0.5}
                        step={0.01}
                        value={globals.video.chromaKey.similarity}
                        className="w-24"
                        onChange={(e) => setKey({ similarity: Number(e.target.value) })}
                      />
                    </span>
                    <span className="flex items-center gap-2 text-xs text-slate-400">
                      Feather {Math.round(globals.video.chromaKey.blend * 100)}%
                      <input
                        type="range"
                        min={0}
                        max={0.2}
                        step={0.005}
                        value={globals.video.chromaKey.blend}
                        className="w-20"
                        onChange={(e) => setKey({ blend: Number(e.target.value) })}
                      />
                    </span>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
        {globals.video.assetId && (
          <p className="text-[11px] text-slate-500">
            Loops if shorter than the mix · cover-cropped to the frame · the video's own audio is not used.
          </p>
        )}
      </Section>

      {/* 4. Preview */}
      <Section icon="▶" title="4. Live preview" action={<span className="text-xs text-slate-500">same math as the MP4 export — pixel-identical geometry</span>}>
        <video
          key={globals.video.assetId ?? "none"}
          ref={videoRef}
          src={globals.video.assetId ? api.assetFileUrl(globals.video.assetId) : undefined}
          className="hidden"
          muted
          loop
          playsInline
          preload="auto"
        />
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
            className={fullscreen ? "max-w-full max-h-full" : "mx-auto block rounded-lg border border-slate-700/60 bg-black"}
            style={fullscreen ? undefined : { aspectRatio: `${renderSettings.width}/${renderSettings.height}`, width: "auto", maxWidth: "100%", maxHeight: "50vh" }}
          />
          {fullscreen && (
            <>
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
          <select
            className="ui-input"
            value={`${renderSettings.width}x${renderSettings.height}`}
            onChange={(e) => {
              const [w, h] = e.target.value.split("x").map(Number);
              setRenderSettings((s) => ({ ...s, width: w!, height: h! }));
            }}
          >
            <option value="1920x1080">1080p (1920×1080)</option>
            <option value="3840x2160">4K (3840×2160)</option>
            <option value="1080x1080">Square (1080×1080)</option>
            <option value="1080x1920">Vertical 9:16 (1080×1920)</option>
          </select>
          <select className="ui-input" value={renderSettings.fps} onChange={(e) => setRenderSettings((s) => ({ ...s, fps: Number(e.target.value) }))}>
            <option value={24}>24 fps</option>
            <option value={30}>30 fps</option>
            <option value={60}>60 fps</option>
          </select>
          <Button variant="primary" onClick={render} disabled={stemInputs.length === 0 || rendering}>
            {rendering ? "Rendering…" : "Render MP4"}
          </Button>
          {rendering && <Spinner />}
        </div>
        {job && (
          <div className="space-y-2">
            <div className="flex items-center gap-3 text-sm">
              <Badge tone={job.status === "done" ? "good" : job.status === "failed" ? "bad" : "info"}>{job.status}</Badge>
              <span className="text-slate-400 text-xs">
                {job.progress.phase} · {job.progress.done}/{job.progress.total}
              </span>
              {job.status === "running" && (
                <Button size="sm" variant="ghost" onClick={() => void api.vizCancelRender(job.id).then((r) => setJob(r.job)).catch(() => {})}>
                  Cancel
                </Button>
              )}
            </div>
            <ProgressBar value={job.progress.done} max={Math.max(1, job.progress.total)} />
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
