// =============================================================================
// @twio/shared — procedural dancer overlay.
//
// A deterministic 2D forward-kinematics figure whose motion is a pure function
// of frame time t and the stem signals — preview and export agree exactly.
//
// Stem→body binding (per the spec):
//   drums  → pelvis bounce / foot taps
//   bass   → hip sway / squat depth
//   vocal  → head bob / torso lean
//   keys/guitar → arm swings / punches
//   fx/other   → whole-body shimmer
//
// Engine features sharpen the groove (onsets → hits, per-stem tempo → step
// rate); without them the dancer still moves on envelope-derived pulses.
// =============================================================================

import {
  isStemAudible,
  anySolo,
  onsetPulse,
  ribbonOutline,
  signalEnv,
  type DancerConfig,
  type FrameStem,
  type Vec2,
  type VizDancer,
} from "./visualizer.js";

// --- small vector helpers -----------------------------------------------------
const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
/** Unit vector: ang=0 points straight down (+y); positive angles tilt −x. */
const downAng = (ang: number): Vec2 => ({ x: -Math.sin(ang), y: Math.cos(ang) });
/** Unit vector: ang=0 points straight up (−y). */
const upAng = (ang: number): Vec2 => ({ x: Math.sin(ang), y: -Math.cos(ang) });
const rot90 = (v: Vec2): Vec2 => ({ x: -v.y, y: v.x });
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const TAU = Math.PI * 2;

/** Per-kind aggregated drive for this frame. */
interface Drive {
  env: number;
  pulse: number;
  tempo: number | null;
  color: string;
}

function drivesByKind(stems: FrameStem[], t: number): Map<string, Drive> {
  const solo = anySolo(stems.map((s) => s.cfg));
  const map = new Map<string, Drive>();
  for (const { cfg, signal } of stems) {
    if (!isStemAudible(cfg, solo)) continue;
    const env = signalEnv(signal, t, 0.06);
    const pulse = onsetPulse(signal, t);
    const tempo = signal.features?.tempo ?? null;
    const cur = map.get(cfg.kind) ?? { env: 0, pulse: 0, tempo: null, color: cfg.color };
    cur.env = Math.max(cur.env, env);
    cur.pulse = Math.max(cur.pulse, pulse);
    if (cur.tempo === null) cur.tempo = tempo;
    map.set(cfg.kind, cur);
  }
  return map;
}

const drive = (m: Map<string, Drive>, kind: string): Drive => m.get(kind) ?? { env: 0, pulse: 0, tempo: null, color: "#FFFFFF" };

/** Stepping foot phase: lifted feet alternate each groove cycle. */
function stepLifts(t: number, tempoHz: number): { liftL: number; liftR: number } {
  const phase = t * tempoHz; // one step per beat-ish
  return { liftL: Math.max(0, Math.sin(Math.PI * phase)), liftR: Math.max(0, -Math.sin(Math.PI * phase)) };
}

/**
 * Resolve the dancer skeleton + colors for frame time t.
 * `center` is the visualizer convergence point — the dancer's torso sits on
 * it so converging ribbons land on the figure.
 */
export function computeDancer(
  stems: FrameStem[],
  cfg: DancerConfig,
  width: number,
  height: number,
  t: number,
  center: Vec2,
): VizDancer | null {
  if (!cfg.enabled || stems.length === 0) return null;
  const minDim = Math.min(width, height);
  const S = minDim * 0.42 * cfg.scale; // total figure height
  const I = cfg.intensity;

  const d = drivesByKind(stems, t);
  // Master envelope across audible stems — drives the neon glow width.
  let masterRms = 0;
  for (const dv of d.values()) masterRms += dv.env * dv.env;
  masterRms = d.size > 0 ? Math.sqrt(masterRms / d.size) : 0;
  const drums = drive(d, "drums");
  const bass = drive(d, "bass");
  const vocal = drive(d, "vocal");
  const keys = drive(d, "keys");
  const guitar = drive(d, "guitar");
  const fx = drive(d, "fx");
  const other = drive(d, "other");
  const armDrive = Math.max(keys.env, guitar.env, other.env * 0.6, 0.25 * masterRms * 3);
  const armPulse = Math.max(keys.pulse, guitar.pulse, other.pulse * 0.5);
  const tempoHz = Math.max(0.5, Math.min(4, (drums.tempo ?? bass.tempo ?? vocal.tempo ?? 120) / 60));

  // --- pose parameters ---------------------------------------------------------
  const bounce = -S * 0.05 * (drums.pulse * 0.9 + bass.pulse * 0.35) * I; // kick dip
  const sway = S * 0.055 * Math.sin(TAU * t * (tempoHz / 4)) * (0.35 + bass.env) * I;
  const squat = clamp01(bass.env * 0.9 + drums.env * 0.3) * I;
  const lean = (0.12 * Math.sin(TAU * t * 0.31) * (0.4 + 0.6 * Math.max(vocal.env, keys.env)) + 0.14 * vocal.pulse) * I;
  const headNod = 0.35 * vocal.pulse + 0.18 * vocal.env * Math.sin(TAU * t * tempoHz * 2);
  const shimmer = 0.012 * Math.sin(TAU * t * 9.1) * Math.max(fx.env, other.env) * I;

  const swingAmp = (0.4 + 1.5 * armDrive) * I;
  const armHz = tempoHz / 2; // arms cycle every other groove step
  const armBaseL = 0.35 + swingAmp * Math.sin(TAU * t * armHz) + armPulse * 0.9;
  const armBaseR = 0.35 + swingAmp * -Math.sin(TAU * t * armHz) + Math.max(drums.pulse, armPulse) * 0.7;
  const elbowBendL = 0.35 + 0.5 * swingAmp * Math.max(0, Math.sin(TAU * (t * armHz - 0.12)));
  const elbowBendR = 0.35 + 0.5 * swingAmp * Math.max(0, -Math.sin(TAU * (t * armHz - 0.12)));

  const { liftL, liftR } = stepLifts(t, tempoHz);
  const stepAmp = (0.25 + 0.75 * drums.env) * I;

  // --- skeleton dimensions -------------------------------------------------------
  const hipW = S * 0.105;
  const shoulderW = S * 0.155;
  const spineLen = S * 0.30;
  const neckLen = S * 0.05;
  const headR = S * 0.085;
  const upperArm = S * 0.17;
  const foreArm = S * 0.155;
  const thigh = S * 0.235;
  const shin = S * 0.235;

  // --- FK solve -------------------------------------------------------------------
  const pelvis: Vec2 = { x: center.x + sway + shimmer * S, y: center.y + S * 0.06 + bounce + squat * S * 0.05 };
  const torsoDir = upAng(lean + shimmer);
  const chest = add(pelvis, mul(torsoDir, spineLen));
  const neck = add(chest, mul(torsoDir, neckLen));
  const headC = add(neck, mul(upAng(lean + headNod), headR * 1.5));
  const shoulderL = add(chest, mul(rot90(torsoDir), -shoulderW));
  const shoulderR = add(chest, mul(rot90(torsoDir), shoulderW));

  const elbowL = add(shoulderL, mul(downAng(armBaseL), upperArm));
  const handL = add(elbowL, mul(downAng(armBaseL + elbowBendL), foreArm));
  const elbowR = add(shoulderR, mul(downAng(-armBaseR), upperArm));
  const handR = add(elbowR, mul(downAng(-armBaseR - elbowBendR), foreArm));

  const hipL = add(pelvis, { x: -hipW, y: 0 });
  const hipR = add(pelvis, { x: hipW, y: 0 });
  const spread = 0.16 + squat * 0.22;
  // 2-bone approximation: knees bulge outward as the foot lifts.
  const kneeL = add(hipL, mul(downAng(spread + liftL * stepAmp * 0.55), thigh));
  const footL = add(kneeL, mul(downAng(spread * 0.7 - liftL * stepAmp * 0.5), shin - liftL * stepAmp * shin * 0.35));
  const kneeR = add(hipR, mul(downAng(-spread - liftR * stepAmp * 0.55), thigh));
  const footR = add(kneeR, mul(downAng(-spread * 0.7 + liftR * stepAmp * 0.5), shin - liftR * stepAmp * shin * 0.35));

  // --- colors ----------------------------------------------------------------------
  const limbColor = (kind: string): string => (cfg.colorMode === "stems" ? (d.get(kind)?.color ?? cfg.color) : cfg.color);
  const torsoColor = cfg.colorMode === "stems" ? (vocal.env > 0 ? vocal.color : cfg.color) : cfg.color;
  const headColor = torsoColor;
  const armColor = keys.env >= guitar.env ? limbColor("keys") : limbColor("guitar");
  const legColor = limbColor("bass");
  const alpha = cfg.style === "silhouette" ? 0.95 : 0.9;
  const glowWidth = cfg.style === "neon" ? Math.max(4, S * 0.09 * (0.5 + masterRms * 2)) : 0;

  // --- ribbons (limbs as tapered capsules) -------------------------------------------
  const ribbon = (a: Vec2, b: Vec2, w0: number, w1: number): Float32Array => {
    const nrm = rot90({ x: b.x - a.x, y: b.y - a.y });
    const len = Math.hypot(nrm.x, nrm.y) || 1;
    const n = { x: nrm.x / len, y: nrm.y / len };
    return ribbonOutline(new Float32Array([a.x, a.y, b.x, b.y]), n, new Float32Array([w0, w1]));
  };

  const limbs: VizDancer["limbs"] = [
    // torso: pelvis → neck, wider at the chest
    { path: ribbonOutline(new Float32Array([pelvis.x, pelvis.y, chest.x, chest.y, neck.x, neck.y]), { x: torsoDir.y, y: -torsoDir.x }, new Float32Array([S * 0.085, S * 0.105, S * 0.05])), color: torsoColor, alpha },
    { path: ribbon(shoulderL, elbowL, S * 0.038, S * 0.03), color: armColor, alpha },
    { path: ribbon(elbowL, handL, S * 0.03, S * 0.02), color: armColor, alpha },
    { path: ribbon(shoulderR, elbowR, S * 0.038, S * 0.03), color: armColor, alpha },
    { path: ribbon(elbowR, handR, S * 0.03, S * 0.02), color: armColor, alpha },
    { path: ribbon(hipL, kneeL, S * 0.055, S * 0.042), color: legColor, alpha },
    { path: ribbon(kneeL, footL, S * 0.042, S * 0.026), color: legColor, alpha },
    { path: ribbon(hipR, kneeR, S * 0.055, S * 0.042), color: legColor, alpha },
    { path: ribbon(kneeR, footR, S * 0.042, S * 0.026), color: legColor, alpha },
  ];

  const strokes: VizDancer["strokes"] = [];
  if (cfg.style === "neon") {
    const stroke = (pts: Vec2[], color: string): void => {
      strokes.push({ points: new Float32Array(pts.flatMap((p) => [p.x, p.y])), color, alpha: 0.55 });
    };
    stroke([pelvis, chest, neck], torsoColor);
    stroke([shoulderL, elbowL, handL], armColor);
    stroke([shoulderR, elbowR, handR], armColor);
    stroke([hipL, kneeL, footL], legColor);
    stroke([hipR, kneeR, footR], legColor);
  }

  const joints = new Float32Array([
    pelvis.x, pelvis.y, chest.x, chest.y, neck.x, neck.y,
    shoulderL.x, shoulderL.y, elbowL.x, elbowL.y, handL.x, handL.y,
    shoulderR.x, shoulderR.y, elbowR.x, elbowR.y, handR.x, handR.y,
    hipL.x, hipL.y, kneeL.x, kneeL.y, footL.x, footL.y,
    hipR.x, hipR.y, kneeR.x, kneeR.y, footR.x, footR.y,
  ]);

  return {
    limbs,
    strokes,
    head: { x: headC.x, y: headC.y, r: headR, color: headColor, alpha },
    joints,
    jointColor: "#FFFFFF",
    alpha,
    glowWidth,
  };
}
