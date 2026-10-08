import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStemSignal,
  chromaKeyFrame,
  chromaKeyYUVFrame,
  computeDancer,
  computeFrame,
  coverCrop,
  detectStemKind,
  frameCenter,
  hash01,
  hsvKeyFrame,
  keyVideoFrame,
  peaksForWindow,
  resolveStem,
  ribbonOutline,
  stemAngles,
  visualizerRenderSchema,
  vizVideoKeySchema,
  windowSlice,
  PEAK_RATE,
  VIZ_POINTS,
  type FrameStem,
  type StemKind,
  type StemSignal,
  type VizMode,
  type VizVideoKeyConfig,
} from "@twio/shared";
import { decodeStem } from "../src/visualizer/decode.ts";
import { renderVisualizer, muxArgs, videoDecoderArgs } from "../src/visualizer/render.ts";
import { frameSvg } from "../src/visualizer/svg.ts";
import { stemSignalPayload } from "../src/visualizer/signals.ts";
import { engineClient } from "../src/python/engineClient.ts";
import { probe, probeAudio } from "../src/video/ffprobe.ts";

// --- helpers ------------------------------------------------------------------

/** Minimal mono 16-bit WAV writer (synthetic stems — no fixture files). */
function wavBuffer(samples: Float32Array, sr: number): Buffer {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32767))), 44 + i * 2);
  }
  return buf;
}

function sine(sec: number, sr: number, hz = 440, amp = 0.6): Float32Array {
  const out = new Float32Array(Math.round(sec * sr));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / sr);
  return out;
}

// --- unit: spec frame-mapping math --------------------------------------------

describe("visualizer — frame mapping (spec §2)", () => {
  it("window slice = [⌊(t−w)·r⌋, ⌊t·r⌋] clamped to [0, len]", () => {
    assert.deepEqual(windowSlice(100000, 48000, 1.0, 0.5), [24000, 48000]);
    assert.deepEqual(windowSlice(100000, 48000, 0.1, 0.5), [0, 4800]); // clamps at 0
    assert.deepEqual(windowSlice(1000, 48000, 1.0, 0.5), [1000, 1000]); // window starts past end → empty
    assert.deepEqual(windowSlice(100000, 48000, 0, 0.5), [0, 0]); // t=0 → empty
  });
});

describe("visualizer — geometry", () => {
  it("radial layout spaces stems evenly, starting at top (−90°)", () => {
    assert.deepEqual(stemAngles(4, "radial"), [-90, 0, 90, 180]);
    assert.deepEqual(stemAngles(1, "radial"), [-90]);
  });
  it("fan layout spreads over ±60° around straight-down", () => {
    assert.deepEqual(stemAngles(1, "fan"), [90]);
    const a = stemAngles(3, "fan");
    assert.equal(a[0], 30);
    assert.equal(a[1], 90);
    assert.equal(a[2], 150);
  });
  it("speakers layout alternates right fan / left fan", () => {
    const a = stemAngles(4, "speakers");
    assert.equal(a.length, 4);
    // Even indices right side (−55..55), odd on left (125..235).
    assert.ok(Math.abs(a[0]!) <= 55 && Math.abs(a[2]!) <= 55);
    assert.ok(a[1]! >= 125 && a[1]! <= 235 && a[3]! >= 125 && a[3]! <= 235);
  });
  it("vertical layout alternates up fan / down fan", () => {
    const a = stemAngles(4, "vertical");
    assert.equal(a.length, 4);
    // Even indices point up (−145..−35), odd point down (35..145).
    assert.ok(a[0]! >= -145 && a[0]! <= -35 && a[2]! >= -145 && a[2]! <= -35);
    assert.ok(a[1]! >= 35 && a[1]! <= 145 && a[3]! >= 35 && a[3]! <= 145);
    assert.deepEqual(stemAngles(1, "vertical"), [-90]);
  });
  it("ribbonOutline produces a closed polygon of 4n coords", () => {
    const v = new Float32Array([0, 0, 10, 0, 20, 0]); // 3 points
    const hw = new Float32Array([2, 2, 2]);
    const out = ribbonOutline(v, { x: 0, y: 1 }, hw);
    assert.equal(out.length, 12);
    assert.deepEqual([out[0], out[1]], [0, 2]); // first +normal
    assert.deepEqual([out[6], out[7]], [20, -2]); // return side starts at last vertex
  });
});

describe("visualizer — stem detection + resolution", () => {
  it("detects kind from filename keywords", () => {
    assert.equal(detectStemKind("vocals_final.wav"), "vocal");
    assert.equal(detectStemKind("DRUMS take2.flac"), "drums");
    assert.equal(detectStemKind("sub bass.mp3"), "bass");
    assert.equal(detectStemKind("synth_keys.wav"), "keys");
    assert.equal(detectStemKind("gtr_lead.wav"), "guitar");
    assert.equal(detectStemKind("pad_ambience.wav"), "fx");
    assert.equal(detectStemKind("miscellaneous.wav"), "other");
  });
  it("resolveStem applies kind defaults and palette fallback", () => {
    const s = resolveStem({ name: "kick.wav", muted: false, solo: false }, 0);
    assert.equal(s.kind, "drums");
    assert.equal(s.amplitudeScale, 1.8);
    const u = resolveStem({ name: "kick.wav", kind: "vocal", muted: false, solo: false }, 0);
    assert.equal(u.amplitudeScale, 1.0); // explicit kind → kind defaults
  });
});

describe("visualizer — signal + frame state", () => {
  const sr = 48000;
  const pcm = sine(1.0, sr);
  const signal = buildStemSignal(pcm, sr);

  it("peak series rate ~ PEAK_RATE buckets/sec", () => {
    assert.equal(signal.peaks.length, PEAK_RATE);
    assert.equal(signal.durationSec, 1);
    // 440Hz sine → every bucket sees ~±0.6.
    assert.ok(signal.peaks.every((p) => Math.abs(p) > 0.3));
  });

  it("peaksForWindow returns signed per-bucket maxima", () => {
    const p = peaksForWindow(signal, 0.5, 0.1, 100);
    assert.equal(p.length, 100);
    assert.ok([...p].every((v) => Math.abs(v) <= 0.65 && Math.abs(v) > 0.3));
    // t=0 → no history → all zeros.
    assert.ok([...peaksForWindow(signal, 0, 0.5, 50)].every((v) => v === 0));
  });

  it("computeFrame: muted stem dims; solo silences others", () => {
    const cfg = (over: Record<string, unknown>) => resolveStem({ name: "a.wav", muted: false, solo: false, ...over }, 0);
    const globals = visualizerRenderSchema.parse({
      renderSettings: { width: 320, height: 240, fps: 30 },
      globalVisuals: {},
      stems: [{ name: "a.wav" }],
    }).globalVisuals;
    const f1 = computeFrame([{ cfg: cfg({}), signal }], globals, 320, 240, 0.5);
    assert.equal(f1.stems[0]!.alpha, 1);
    const f2 = computeFrame(
      [
        { cfg: cfg({ solo: true }), signal },
        { cfg: cfg({ color: "#33CCFF" }), signal },
      ],
      globals,
      320,
      240,
      0.5,
    );
    assert.equal(f2.stems[0]!.audible, true);
    assert.equal(f2.stems[1]!.audible, false);
    assert.ok(f2.stems[1]!.alpha < 0.3);
    assert.ok(f2.stems[0]!.ribbon.length === VIZ_POINTS * 4);
    assert.ok(f1.star.r > 0);
  });

  it("frameSvg emits a renderable document", () => {
    const globals = visualizerRenderSchema.parse({
      renderSettings: { width: 320, height: 240, fps: 30 },
      globalVisuals: {},
      stems: [{ name: "a.wav" }],
    }).globalVisuals;
    const state = computeFrame([{ cfg: resolveStem({ name: "a.wav", muted: false, solo: false }, 0), signal }], globals, 320, 240, 0.5);
    const svg = frameSvg(state, 320, 240, "#050508");
    assert.ok(svg.startsWith("<svg"));
    assert.ok(svg.includes("<path"));
    assert.ok(svg.includes("<circle"));
  });

  it("render settings accept portrait aspect ratios up to 4K", () => {
    for (const [width, height] of [[1920, 1080], [1080, 1920], [2160, 3840], [1080, 1080]] as const) {
      assert.ok(
        visualizerRenderSchema.safeParse({
          renderSettings: { width, height, fps: 30 },
          globalVisuals: {},
          stems: [{ name: "a.wav" }],
        }).success,
        `${width}×${height} must parse`,
      );
    }
    for (const [width, height] of [[3841, 2160], [2160, 3841], [239, 240]] as const) {
      assert.equal(
        visualizerRenderSchema.safeParse({
          renderSettings: { width, height, fps: 30 },
          globalVisuals: {},
          stems: [{ name: "a.wav" }],
        }).success,
        false,
        `${width}×${height} must be rejected`,
      );
    }
  });
});

describe("visualizer — modes + dancer", () => {
  const sr = 48000;
  const signal = buildStemSignal(sine(1.0, sr), sr);
  const stems = (kind: StemKind): FrameStem[] => [
    { cfg: resolveStem({ name: `x_${kind}.wav`, kind, muted: false, solo: false }, 0), signal },
  ];
  const globalsFor = (mode: VizMode, dancer = false, extra: Record<string, unknown> = {}) =>
    visualizerRenderSchema.parse({
      renderSettings: { width: 320, height: 240, fps: 30 },
      globalVisuals: { mode, dancer: { enabled: dancer }, ...extra },
      stems: [{ name: "x.wav" }],
    }).globalVisuals;

  it("mode dispatch fills exactly one visual channel", () => {
    const f = stems("drums");
    const t = 0.5;
    const rb = computeFrame(f, globalsFor("ribbons"), 320, 240, t);
    assert.equal(rb.stems.length, 1);
    assert.equal(
      rb.rings.length + rb.bars.length + rb.particles.length + rb.mirrors.length + rb.blocks.length + rb.eqbars.length + rb.eqradial.length + rb.stereos.length + rb.silks.length,
      0,
    );
    const circ = computeFrame(f, globalsFor("circular"), 320, 240, t);
    assert.equal(circ.rings.length, 1);
    assert.equal(circ.rings[0]!.points.length, 240 * 2);
    // Mirror: filled symmetric polygon + echo traces + crest dots per stem.
    const mr = computeFrame(f, globalsFor("mirror"), 320, 240, t);
    assert.equal(mr.mirrors.length, 1);
    assert.equal(mr.mirrors[0]!.fill.length, 360 * 4);
    assert.equal(mr.mirrors[0]!.echoes.length, 4);
    // Blocks: segment rects + tip dots, x-sliced per stem.
    const bk = computeFrame(f, globalsFor("blocks"), 320, 240, t);
    assert.equal(bk.blocks.length, 1);
    assert.equal(bk.blocks[0]!.rects.length % 4, 0);
    assert.ok(bk.blocks[0]!.rects.length > 0);
    // EQ bars: stride-5 bright segments mirrored about the axis, tip caps at
    // both column ends, rising sparks, and a single luminous axis strip.
    const eq = computeFrame(f, globalsFor("eqbars"), 320, 240, t);
    assert.equal(eq.eqbars.length, 1);
    const g0 = eq.eqbars[0]!;
    assert.equal(g0.segs.length % 5, 0);
    assert.ok(g0.segs.length > 0);
    assert.equal(g0.tips.length % 4, 0);
    assert.ok(g0.tips.length > 0);
    assert.equal(g0.axis.length, 4);
    const axisY = 120; // center.y at default convergence (240 * 0.5)
    let above = 0;
    let below = 0;
    for (let i = 0; i + 4 < g0.segs.length; i += 5) {
      if (g0.segs[i + 1]! + g0.segs[i + 3]! <= axisY + 0.5) above++;
      else if (g0.segs[i + 1]! >= axisY - 0.5) below++;
    }
    assert.equal(above, below); // every column mirrors across the axis
    assert.ok(g0.sparks.length % 3 === 0);
    assert.ok(g0.sparks.length > 0); // sine level → sparks are active
    // EQ bars radial: stride-9 bright quads radiating from the hub radius
    // R0 = 12% of minDim, extending at most 36% of minDim outward; tip caps
    // are stride-8 quads, sparks drift outward, one luminous hub ring.
    const er = computeFrame(f, globalsFor("eqradial"), 320, 240, t);
    assert.equal(er.eqradial.length, 1);
    const rg = er.eqradial[0]!;
    assert.equal(rg.segs.length % 9, 0);
    assert.ok(rg.segs.length > 0);
    assert.equal(rg.tips.length % 8, 0);
    assert.ok(rg.tips.length > 0);
    assert.equal(rg.sparks.length % 3, 0);
    assert.equal(rg.ring.length, 4);
    const rcx = 160; // center at default convergence (320*0.5, 240*0.5)
    const rcy = 120;
    assert.ok(Math.abs(rg.ring[0]! - rcx) < 1e-3);
    assert.ok(Math.abs(rg.ring[1]! - rcy) < 1e-3);
    const R0 = Math.min(320, 240) * 0.12;
    const maxLen = Math.min(320, 240) * 0.36;
    assert.ok(Math.abs(rg.ring[2]! - R0) < 1e-3);
    // Every segment vertex sits inside the [R0, R0+maxLen] annulus.
    for (let i = 0; i + 7 < rg.segs.length; i += 9) {
      for (let k = 0; k < 8; k += 2) {
        const d = Math.hypot(rg.segs[i + k]! - rcx, rg.segs[i + k + 1]! - rcy);
        assert.ok(d >= R0 - 1e-3 && d <= R0 + maxLen + 1e-3, `radius ${d}`);
      }
    }
    // First bar starts at the top (−90°): its first quad centers on cx, above cy.
    const qx = (rg.segs[0]! + rg.segs[2]! + rg.segs[4]! + rg.segs[6]!) / 4;
    const qy = (rg.segs[1]! + rg.segs[3]! + rg.segs[5]! + rg.segs[7]!) / 4;
    assert.ok(Math.abs(qx - rcx) < R0 * 0.1 && qy < rcy - R0 * 0.5);
    // The hub radius is user-controlled: 0 → bars start at the exact center.
    const er0 = computeFrame(f, globalsFor("eqradial", false, { innerRadius: 0 }), 320, 240, t);
    assert.ok(Math.abs(er0.eqradial[0]!.ring[2]!) < 1e-3);
    assert.ok(er0.eqradial[0]!.segs.length > 0); // still emits geometry
    const er3 = computeFrame(f, globalsFor("eqradial", false, { innerRadius: 0.3 }), 320, 240, t);
    assert.ok(Math.abs(er3.eqradial[0]!.ring[2]! - 240 * 0.3) < 1e-2);
    // Stereo: fills hug the vertical center line; mono → mirrored right side.
    const st = computeFrame(f, globalsFor("stereo"), 320, 240, t);
    assert.equal(st.stereos.length, 1);
    assert.equal(st.stereos[0]!.stereo, false);
    assert.equal(st.stereos[0]!.leftFill.length, st.stereos[0]!.rightFill.length);
    // Mirror line (not a point): left/right x coords mirror about cx=160.
    const cx = 160;
    assert.ok(Math.abs(st.stereos[0]!.leftFill[0]! + st.stereos[0]!.rightFill[0]! - 2 * cx) < 1e-3);
    // Silk: strandCount packed strand polylines above + below the axis, a
    // luminous axis strip, ambient dust, and a 3-stop spectral gradient.
    const sk = computeFrame(f, globalsFor("silk"), 320, 240, t);
    assert.equal(sk.silks.length, 1);
    const sg = sk.silks[0]!;
    assert.equal(sg.up.length, sg.strandCount * sg.strandN * 2);
    assert.equal(sg.down.length, sg.up.length);
    assert.equal(sg.axis.length, 4);
    assert.ok(sg.dust.length % 3 === 0);
    assert.ok(sg.dust.length > 0);
    // Strands mirror about the horizontal axis (240 * 0.5 = 120): the first
    // strand's first vertex pairs above/below → y coords sum to 2·axisY.
    assert.ok(Math.abs(sg.up[1]! + sg.down[1]! - 240) < 1e-3);
    // Slice spans nearly the whole width for one stem; the gradient mid stop
    // lands on the convergence point (straddling slice).
    assert.ok(sg.gradX0 < cx && sg.gradX1 > cx);
    assert.ok(Math.abs(sg.gradX0 + sg.gradMid * (sg.gradX1 - sg.gradX0) - cx) < 1e-3);
    // Spectrum emits flat 1px bars when the engine produced no features —
    // the service layer rejects spectrum renders in that case, so this only
    // asserts graceful no-crash behavior at the frame-math level.
    const sp = computeFrame(f, globalsFor("spectrum"), 320, 240, t);
    assert.equal(sp.bars.length, 1);
    assert.equal(sp.bars[0]!.bars.length, 6 * 4);
    const pt = computeFrame(f, globalsFor("particles"), 320, 240, t);
    assert.equal(pt.particles.length, 1);
    assert.equal(pt.particles[0]!.points.length, 48 * 3);
    assert.equal(pt.star.r > 0, true); // convergence star in every mode
  });

  it("silent window hides the stem — no flat baseline", () => {
    const f = stems("bass");
    // t=0 → the displayed window contains no samples → fully transparent.
    assert.equal(computeFrame(f, globalsFor("ribbons"), 320, 240, 0).stems[0]!.alpha, 0);
    assert.equal(computeFrame(f, globalsFor("circular"), 320, 240, 0).rings[0]!.alpha, 0);
    assert.equal(computeFrame(f, globalsFor("spectrum"), 320, 240, 0).bars[0]!.alpha, 0);
    assert.equal(computeFrame(f, globalsFor("particles"), 320, 240, 0).particles[0]!.alpha, 0);
    assert.equal(computeFrame(f, globalsFor("mirror"), 320, 240, 0).mirrors[0]!.alpha, 0);
    assert.equal(computeFrame(f, globalsFor("blocks"), 320, 240, 0).blocks[0]!.alpha, 0);
    assert.equal(computeFrame(f, globalsFor("eqbars"), 320, 240, 0).eqbars[0]!.alpha, 0);
    assert.equal(computeFrame(f, globalsFor("eqradial"), 320, 240, 0).eqradial[0]!.alpha, 0);
    assert.equal(computeFrame(f, globalsFor("stereo"), 320, 240, 0).stereos[0]!.alpha, 0);
    assert.equal(computeFrame(f, globalsFor("silk"), 320, 240, 0).silks[0]!.alpha, 0);
    assert.equal(computeFrame(f, globalsFor("ribbons"), 320, 240, 0).star.alpha, 0);
    // Mid-signal the same stem is fully visible again.
    assert.ok(computeFrame(f, globalsFor("ribbons"), 320, 240, 0.5).stems[0]!.alpha > 0.5);
  });

  it("computeFrame is deterministic — same t, same geometry", () => {
    const f = stems("vocal");
    const a = computeFrame(f, globalsFor("particles"), 320, 240, 0.37);
    const b = computeFrame(f, globalsFor("particles"), 320, 240, 0.37);
    assert.deepEqual([...a.particles[0]!.points], [...b.particles[0]!.points]);
    const c = computeFrame(f, globalsFor("particles"), 320, 240, 0.5);
    assert.notDeepEqual([...a.particles[0]!.points], [...c.particles[0]!.points]);
  });

  it("autoGlow picks a deterministic random intensity per beat cell", () => {
    const beatSig: StemSignal = {
      ...signal,
      features: {
        version: 1,
        durationSec: 1,
        tempo: 120,
        featureRate: 10,
        frames: 0,
        bandNames: [],
        bands: new Float32Array(0),
        env: new Float32Array(0),
        onsetEnv: new Float32Array(0),
        onsets: [],
        beats: [{ time: 0, strength: 1 }, { time: 0.5, strength: 1 }, { time: 1.0, strength: 1 }],
      },
    };
    const st: FrameStem[] = [{ cfg: resolveStem({ name: "x.wav", kind: "vocal", muted: false, solo: false }, 0), signal: beatSig }];
    const ag = globalsFor("ribbons", false, { autoGlow: { enabled: true, min: 0, max: 40 } });
    // Vocal ribbons: glowWidth = glowRadius(10) · (intensity/14) · 2.
    const intensity = (t: number) => (computeFrame(st, ag, 320, 240, t).stems[0]!.glowWidth * 14) / 20;
    // Beat cells: t∈[0,0.5) → index 1, [0.5,1) → 2, ≥1 → 3.
    assert.ok(Math.abs(intensity(0.2) - 40 * hash01(1, 77)) < 1e-4);
    assert.ok(Math.abs(intensity(0.3) - 40 * hash01(1, 77)) < 1e-4); // same cell → same roll
    assert.ok(Math.abs(intensity(0.7) - 40 * hash01(2, 77)) < 1e-4);
    assert.ok(Math.abs(intensity(1.1) - 40 * hash01(3, 77)) < 1e-4);
    assert.notEqual(intensity(0.2), intensity(0.7)); // new roll at the next beat
    // Disabled → static glowIntensity (schema default 14) → glowWidth 20.
    const off = computeFrame(st, globalsFor("ribbons"), 320, 240, 0.7).stems[0]!.glowWidth;
    assert.equal(off, 20);
    // No features at all → 0.5 s grid fallback still animates.
    const noFeat: FrameStem[] = [{ cfg: st[0]!.cfg, signal }];
    const i1 = (computeFrame(noFeat, ag, 320, 240, 0.2).stems[0]!.glowWidth * 14) / 20;
    const i2 = (computeFrame(noFeat, ag, 320, 240, 0.7).stems[0]!.glowWidth * 14) / 20;
    assert.ok(Math.abs(i1 - 40 * hash01(0, 77)) < 1e-4); // floor(0.2/0.5) = 0
    assert.ok(Math.abs(i2 - 40 * hash01(1, 77)) < 1e-4); // floor(0.7/0.5) = 1
  });

  it("autoCenter glides the convergence point to a new hashed spot per beat", () => {
    const beatSig: StemSignal = {
      ...signal,
      features: {
        version: 1,
        durationSec: 1,
        tempo: 120,
        featureRate: 10,
        frames: 0,
        bandNames: [],
        bands: new Float32Array(0),
        env: new Float32Array(0),
        onsetEnv: new Float32Array(0),
        onsets: [],
        beats: [{ time: 0, strength: 1 }, { time: 0.5, strength: 1 }, { time: 1.0, strength: 1 }],
      },
    };
    const st: FrameStem[] = [{ cfg: resolveStem({ name: "x.wav", kind: "vocal", muted: false, solo: false }, 0), signal: beatSig }];
    const g = globalsFor("ribbons", false, { autoCenter: { enabled: true, range: 0.2 } });
    const tx = (i: number) => 320 * (0.5 + (hash01(i, 31) - 0.5) * 0.4);
    const ty = (i: number) => 240 * (0.5 + (hash01(i, 57) - 0.5) * 0.4);
    // Cell containing t=0.95 is index 2 (started at 0.5) — the glide finished
    // (0.45 > 0.5·0.6), so the center sits exactly on the cell's target.
    const c1 = frameCenter(st, g, 320, 240, 0.95);
    assert.ok(Math.abs(c1.x - tx(2)) < 1e-6);
    assert.ok(Math.abs(c1.y - ty(2)) < 1e-6);
    // Mid-glide: t=0.65 → k = 0.15/0.3 = 0.5 → smoothstep(0.5) = 0.5 → midpoint.
    const cMid = frameCenter(st, g, 320, 240, 0.65);
    assert.ok(Math.abs(cMid.x - (tx(1) + tx(2)) / 2) < 1e-6);
    // Next beat cell → next hashed target.
    const c3 = frameCenter(st, g, 320, 240, 1.45);
    assert.ok(Math.abs(c3.x - tx(3)) < 1e-6);
    assert.notEqual(tx(2), tx(3));
    // computeFrame anchors the star at the same wandering center.
    const f = computeFrame(st, g, 320, 240, 0.95);
    assert.ok(Math.abs(f.star.x - c1.x) < 1e-6 && Math.abs(f.star.y - c1.y) < 1e-6);
    // Disabled → the configured centerConvergence point.
    assert.deepEqual(frameCenter(st, globalsFor("ribbons"), 320, 240, 0.95), { x: 160, y: 120 });
  });

  it("dancer resolves a 15-joint skeleton rooted at the convergence point", () => {
    const d = computeDancer(
      stems("drums"),
      { enabled: true, style: "neon", scale: 1, intensity: 1, colorMode: "stems", color: "#FFFFFF" },
      320, 240, 0.5, { x: 160, y: 120 },
    );
    assert.ok(d);
    assert.equal(d.joints.length, 15 * 2);
    assert.equal(d.limbs.length, 9);
    assert.ok(d.strokes.length > 0); // neon → centerline strokes
    // Pelvis (joint 0) sits at/near the convergence point.
    assert.ok(Math.abs(d.joints[0]! - 160) < 40 && Math.abs(d.joints[1]! - 120) < 60);
    assert.ok(d.head.y < d.joints[1]!); // head above pelvis (screen y is down)
    assert.ok(d.glowWidth > 0);
  });

  it("dancer is deterministic and honors style/disable", () => {
    const f = stems("bass");
    const cfg = { enabled: true, style: "neon" as const, scale: 1, intensity: 1, colorMode: "fixed" as const, color: "#FF3366" };
    const a = computeDancer(f, cfg, 320, 240, 0.77, { x: 160, y: 120 });
    const b = computeDancer(f, cfg, 320, 240, 0.77, { x: 160, y: 120 });
    assert.deepEqual([...a!.joints], [...b!.joints]);
    assert.equal(computeDancer(f, { ...cfg, enabled: false }, 320, 240, 0.77, { x: 160, y: 120 }), null);
    const sil = computeDancer(f, { ...cfg, style: "silhouette" as const }, 320, 240, 0.77, { x: 160, y: 120 });
    assert.equal(sil!.strokes.length, 0); // silhouette → fills only, no strokes/glow
    assert.equal(sil!.glowWidth, 0);
    assert.equal(a!.limbs[0]!.color, "#FF3366"); // fixed colorMode
    // Different t → different pose (motion exists).
    const c = computeDancer(f, cfg, 320, 240, 1.1, { x: 160, y: 120 });
    assert.notDeepEqual([...a!.joints], [...c!.joints]);
  });

  it("frameSvg emits dancer primitives when state.dancer is set", () => {
    const f = stems("vocal");
    const g = globalsFor("ribbons", true);
    const state = computeFrame(f, g, 320, 240, 0.5);
    state.dancer = computeDancer(f, g.dancer, 320, 240, 0.5, { x: 160, y: 120 });
    const svg = frameSvg(state, 320, 240, "#050508");
    assert.ok(svg.includes("<circle"));
    assert.ok((svg.match(/<path/g) ?? []).length >= 10);
  });
});

describe("visualizer — layer stack (media + visuals rows)", () => {
  const sr = 48000;
  const signal = buildStemSignal(sine(1.0, sr), sr);
  const stems: FrameStem[] = [{ cfg: resolveStem({ name: "x.wav", muted: false, solo: false }, 0), signal }];
  const globalsWith = (video: Record<string, unknown>) =>
    visualizerRenderSchema.parse({
      renderSettings: { width: 320, height: 240, fps: 30 },
      globalVisuals: { mode: "eqbars", video },
      stems: [{ name: "x.wav" }],
    }).globalVisuals;
  /** Narrow a stack row to its media shape — the tests' compile-time guard. */
  const mediaAt = (g: ReturnType<typeof globalsWith>, i: number) => {
    const l = g.video.layers[i]!;
    if (l.kind !== "media") throw new Error(`layer ${i} is ${l.kind}, expected media`);
    return l;
  };

  it("an absent video block defaults to a lone visuals row — old configs keep their waveforms", () => {
    const g = visualizerRenderSchema.parse({
      renderSettings: { width: 320, height: 240, fps: 30 },
      globalVisuals: {},
      stems: [{ name: "x.wav" }],
    }).globalVisuals;
    assert.deepEqual(g.video, { layers: [{ kind: "visuals", hidden: false, x: 0.5, y: 0.5, opacity: 1, scale: 1 }] });
    assert.deepEqual(computeFrame(stems, g, 320, 240, 0.5).videoLayers, [{ kind: "visuals", hidden: false, x: 0.5, y: 0.5, opacity: 1, scale: 1, key: null }]);
    // An explicit empty list is respected literally — nothing is drawn.
    const empty = globalsWith({ layers: [] });
    assert.deepEqual(empty.video.layers, []);
    assert.deepEqual(computeFrame(stems, empty, 320, 240, 0.5).videoLayers, []);
  });

  it("legacy flat single-video configs fold to media + visuals at the band boundary", () => {
    // {assetId} with the default "under" band → media under the visuals row.
    const gv = globalsWith({ assetId: "asset-1" });
    assert.equal(gv.video.layers.length, 2);
    const m0 = mediaAt(gv, 0);
    assert.equal(m0.assetId, "asset-1");
    assert.equal(m0.layer, "under"); // deprecated hint kept through the fold
    assert.equal(m0.opacity, 1);
    assert.equal(gv.video.layers[1]!.kind, "visuals");
    assert.deepEqual(computeFrame(stems, gv, 320, 240, 0.5).videoLayers, [
      { kind: "media", hidden: false, x: 0.5, y: 0.5, opacity: 1, scale: 1, key: null },
      { kind: "visuals", hidden: false, x: 0.5, y: 0.5, opacity: 1, scale: 1, key: null },
    ]);
    // Old "over" band → the visuals row sits under the media row.
    const gvo = globalsWith({ assetId: "asset-1", layer: "over", opacity: 0.7 });
    assert.deepEqual(gvo.video.layers.map((l) => l.kind), ["visuals", "media"]);
    assert.equal(mediaAt(gvo, 1).opacity, 0.7);
  });

  it("band-model rows restore the visuals row at the under/over boundary; new rows stay verbatim", () => {
    const g = globalsWith({
      layers: [
        { assetId: "a1", layer: "under" },
        { assetId: "a2", layer: "under" },
        { assetId: "a3", layer: "over" },
      ],
    });
    assert.deepEqual(g.video.layers.map((l) => l.kind), ["media", "media", "visuals", "media"]);
    // Rows without the deprecated hint are trusted as-is — a media-only stack
    // renders no waveforms, and an explicit visuals row keeps its position.
    const mediaOnly = globalsWith({ layers: [{ assetId: "a1" }, { assetId: "a2" }] });
    assert.deepEqual(mediaOnly.video.layers.map((l) => l.kind), ["media", "media"]);
    const fresh = globalsWith({ layers: [{ assetId: "a1" }, { kind: "visuals" }, { assetId: "a2" }] });
    assert.deepEqual(fresh.video.layers.map((l) => l.kind), ["media", "visuals", "media"]);
  });

  it("schema bounds: invalid kind/band/scale and the 10-row cap", () => {
    for (const video of [
      { layers: [{ kind: "bogus" }] },
      { layers: [{ kind: "media" }] }, // media rows need an assetId
      { layers: [{ assetId: "a", layer: "sideways" }] },
    ]) {
      assert.equal(
        visualizerRenderSchema.safeParse({
          renderSettings: { width: 320, height: 240, fps: 30 },
          globalVisuals: { video },
          stems: [{ name: "x.wav" }],
        }).success,
        false,
        JSON.stringify(video),
      );
    }
    for (const scale of [0, 0.05, 2.5]) {
      assert.equal(
        visualizerRenderSchema.safeParse({
          renderSettings: { width: 320, height: 240, fps: 30 },
          globalVisuals: { video: { layers: [{ assetId: "a", scale }] } },
          stems: [{ name: "x.wav" }],
        }).success,
        false,
        `scale ${scale} must be rejected`,
      );
      // The bound applies to visuals rows too.
      assert.equal(
        visualizerRenderSchema.safeParse({
          renderSettings: { width: 320, height: 240, fps: 30 },
          globalVisuals: { video: { layers: [{ kind: "visuals", scale }] } },
          stems: [{ name: "x.wav" }],
        }).success,
        false,
        `visuals scale ${scale} must be rejected`,
      );
    }
    // The cap counts every row — a visuals row doesn't squeeze in an 11th.
    const tooMany = visualizerRenderSchema.safeParse({
      renderSettings: { width: 320, height: 240, fps: 30 },
      globalVisuals: { video: { layers: [...Array.from({ length: 9 }, (_, i) => ({ assetId: `a${i}` })), { kind: "visuals" }, { assetId: "a9" }] } },
      stems: [{ name: "x.wav" }],
    });
    assert.equal(tooMany.success, false);
    // Scale rides through the frame state on both row kinds.
    const scaled = globalsWith({ layers: [{ assetId: "a", scale: 0.5 }, { kind: "visuals", scale: 1.5 }] });
    assert.deepEqual(
      computeFrame(stems, scaled, 320, 240, 0.5).videoLayers.map((v) => v.scale),
      [0.5, 1.5],
    );
  });

  it("coverCrop computes the centered cover-fit source rect", () => {
    // Landscape source into a square frame → crop left/right.
    assert.deepEqual(coverCrop(1920, 1080, 240, 240), [420, 0, 1080, 1080]);
    // Portrait source into landscape → crop top/bottom.
    assert.deepEqual(coverCrop(1080, 1920, 320, 240), [0, 555, 1080, 810]);
    // Same aspect → full frame, no crop.
    assert.deepEqual(coverCrop(640, 480, 320, 240), [0, 0, 640, 480]);
  });

  it("frameSvg draws media and visuals rows in stack order", () => {
    const g = globalsWith({
      layers: [
        { assetId: "a1" },            // bottom
        { kind: "visuals" },          // waveforms in the middle
        { assetId: "a2", opacity: 0.7 }, // top
      ],
    });
    const state = computeFrame(stems, g, 320, 240, 0.5);
    assert.equal(state.videoLayers.length, 3);
    // Hrefs stay index-aligned — the visuals row takes a null slot.
    const svg = frameSvg(state, 320, 240, "#050508", ["data:AAAA", null, "data:CCCC"]);
    const ia = svg.indexOf("data:AAAA");
    const ic = svg.indexOf("data:CCCC");
    const gStart = svg.indexOf("<g opacity");
    const gEnd = svg.indexOf("</g>");
    const firstPath = svg.indexOf("<path");
    assert.ok(ia > svg.indexOf("<rect"));              // a1 over the background
    assert.ok(ia < gStart && gStart < firstPath);      // then the visuals group
    assert.ok(firstPath > 0 && firstPath < gEnd);      // mode visuals inside it
    assert.ok(ic > gEnd);                              // a2 on top of everything
    assert.ok(svg.includes('opacity="0.7"'));
    // A missing href leaves a gap, not an <image>.
    const svgNone = frameSvg(state, 320, 240, "#050508");
    assert.equal(svgNone.indexOf("<image"), -1);
    assert.ok(svgNone.indexOf("<path") > 0); // visuals row still draws
  });

  it("frameSvg draws no mode visuals without a visuals row", () => {
    // Media-only stack: no mode-visual <path>s anywhere (dancer off; the star
    // is a <circle> — only the layer <image> + background remain).
    const mediaOnly = computeFrame(stems, globalsWith({ layers: [{ assetId: "a" }] }), 320, 240, 0.5);
    const svgM = frameSvg(mediaOnly, 320, 240, "#050508", ["data:X"]);
    assert.ok(svgM.indexOf("<image") > 0);
    assert.equal(svgM.indexOf("<path"), -1);
    // Visuals-only stack: waveforms with no media <image>.
    const visualsOnly = computeFrame(stems, globalsWith({ layers: [{ kind: "visuals" }] }), 320, 240, 0.5);
    const svgV = frameSvg(visualsOnly, 320, 240, "#050508");
    assert.equal(svgV.indexOf("<image"), -1);
    assert.ok(svgV.indexOf("<path") > 0);
    // Empty stack: literally just the background + convergence star.
    const bare = computeFrame(stems, globalsWith({ layers: [] }), 320, 240, 0.5);
    const svgB = frameSvg(bare, 320, 240, "#050508");
    assert.equal(svgB.indexOf("<image"), -1);
    assert.equal(svgB.indexOf("<path"), -1);
  });

  it("frameSvg wraps a visuals row in its own opacity/scale group", () => {
    const g = globalsWith({ layers: [{ kind: "visuals", opacity: 0.5, scale: 1.5 }] });
    const svg = frameSvg(computeFrame(stems, g, 320, 240, 0.5), 320, 240, "#050508");
    assert.ok(svg.includes('<g opacity="0.5" transform="translate(160 120) scale(1.5) translate(-160 -120)">'));
    // Scale 1 → no transform attribute at all.
    const svg1 = frameSvg(computeFrame(stems, globalsWith({ layers: [{ kind: "visuals" }] }), 320, 240, 0.5), 320, 240, "#050508");
    assert.ok(svg1.includes('<g opacity="1">'));
    assert.ok(!svg1.includes("transform="));
  });

  it("frameSvg centers a scaled layer — <1 shrinks, >1 overflows (zoom)", () => {
    const small = computeFrame(stems, globalsWith({ layers: [{ assetId: "a", scale: 0.5 }] }), 320, 240, 0.5);
    const svgS = frameSvg(small, 320, 240, "#050508", ["data:X"]);
    assert.ok(svgS.includes('x="80" y="60" width="160" height="120"'));

    const big = computeFrame(stems, globalsWith({ layers: [{ assetId: "a", scale: 1.5 }] }), 320, 240, 0.5);
    const svgB = frameSvg(big, 320, 240, "#050508", ["data:X"]);
    assert.ok(svgB.includes('x="-80" y="-60" width="480" height="360"'));
  });

  it("hidden rows keep their stack slot but draw nothing", () => {
    const g = globalsWith({
      layers: [
        { assetId: "a1" },                  // bottom — visible
        { kind: "visuals", hidden: true },  // waveforms off
        { assetId: "a2", hidden: true },    // media off
      ],
    });
    assert.deepEqual(g.video.layers.map((l) => l.hidden), [false, true, true]);
    const state = computeFrame(stems, g, 320, 240, 0.5);
    assert.deepEqual(state.videoLayers.map((v) => v.hidden), [false, true, true]);
    const svg = frameSvg(state, 320, 240, "#050508", ["data:AAAA", null, "data:CCCC"]);
    assert.ok(svg.includes("data:AAAA"));        // the visible media row still draws
    assert.equal(svg.indexOf("data:CCCC"), -1);  // hidden media row — no <image>
    assert.equal(svg.indexOf("<path"), -1);      // hidden visuals row — no waveforms
    // Every row hidden → background + convergence star only.
    const allHidden = computeFrame(stems, globalsWith({ layers: [{ assetId: "a", hidden: true }] }), 320, 240, 0.5);
    assert.equal(frameSvg(allHidden, 320, 240, "#050508", ["data:X"]).indexOf("<image"), -1);
  });

  it("layer center x/y moves the drawn position — media rect + visuals group", () => {
    const g = globalsWith({
      layers: [
        { assetId: "a", x: 0.25, y: 0.75 },
        { kind: "visuals", x: 0.25, y: 0.75 },
      ],
    });
    assert.deepEqual(g.video.layers.map((l) => [l.x, l.y]), [[0.25, 0.75], [0.25, 0.75]]);
    const state = computeFrame(stems, g, 320, 240, 0.5);
    assert.deepEqual(state.videoLayers.map((v) => [v.x, v.y]), [[0.25, 0.75], [0.25, 0.75]]);
    const svg = frameSvg(state, 320, 240, "#050508", ["data:X", null]);
    // Media row: the layer's center lands at (0.25·320, 0.75·240) = (80, 180).
    assert.ok(svg.includes('x="-80" y="60"'));
    // Visuals row: the group scales about that same center point.
    assert.ok(svg.includes('<g opacity="1" transform="translate(80 180) scale(1) translate(-160 -120)">'));
    // Centered rows (the default) emit no transform at all.
    const centered = frameSvg(computeFrame(stems, globalsWith({ layers: [{ kind: "visuals" }] }), 320, 240, 0.5), 320, 240, "#050508");
    assert.ok(!centered.includes("transform="));
  });

  it("chromaKeyFrame drops pixels within similarity and feathers the edge", () => {
    const px = new Uint8ClampedArray([
      0, 255, 0, 255,     // exact key color → fully transparent
      30, 30, 200, 255,   // far from green → stays opaque
      30, 230, 30, 255,   // d≈0.111 → inside the [0.07,0.17] blend band
    ]);
    chromaKeyFrame(px, "#00FF00", 0.12, 0.05);
    assert.equal(px[3], 0);          // keyed out
    assert.equal(px[7], 255);        // untouched
    assert.ok(px[11]! > 0 && px[11]! < 255); // partial alpha inside the blend band
    // Existing alpha multiplies — a half-alpha keyed pixel stays gone.
    const px2 = new Uint8ClampedArray([0, 255, 0, 128]);
    chromaKeyFrame(px2, "#00FF00", 0.12, 0.02);
    assert.equal(px2[3], 0);
    // state.videoLayers carries the key config only on media rows with one set.
    const gk = globalsWith({ assetId: "asset-1", chromaKey: { enabled: true, color: "#FF00FF", similarity: 0.2, blend: 0.05 } });
    assert.deepEqual(computeFrame(stems, gk, 320, 240, 0.5).videoLayers, [
      {
        kind: "media",
        hidden: false,
        x: 0.5,
        y: 0.5,
        opacity: 1,
        scale: 1,
        // Legacy chromaKey folds into key (colorkey method, despill kept off
        // so old configs render identically).
        key: { method: "colorkey", color: "#FF00FF", similarity: 0.2, blend: 0.05, despill: false, choke: 0, model: "mediapipe", feather: 1 },
      },
      { kind: "visuals", hidden: false, x: 0.5, y: 0.5, opacity: 1, scale: 1, key: null },
    ]);
  });

  it("video key schema migrates legacy chromaKey and validates methods", () => {
    // Old wire shape: chromaKey.enabled → key.method "colorkey".
    const migrated = visualizerRenderSchema.parse({
      renderSettings: { width: 320, height: 240, fps: 30 },
      globalVisuals: { video: { assetId: "a", chromaKey: { enabled: true, color: "#112233", similarity: 0.3, blend: 0.04 } } },
      stems: [{ name: "x.wav" }],
    }).globalVisuals;
    assert.equal(mediaAt(migrated, 0).key.method, "colorkey");
    assert.equal(mediaAt(migrated, 0).key.color, "#112233");
    assert.equal(mediaAt(migrated, 0).key.similarity, 0.3);
    assert.equal(mediaAt(migrated, 0).key.despill, false); // legacy parity
    // Explicit new-style key wins over a stray legacy field.
    const both = visualizerRenderSchema.parse({
      renderSettings: { width: 320, height: 240, fps: 30 },
      globalVisuals: { video: { assetId: "a", chromaKey: { enabled: true }, key: { method: "hsv", color: "#00FF00" } } },
      stems: [{ name: "x.wav" }],
    }).globalVisuals;
    assert.equal(mediaAt(both, 0).key.method, "hsv");
    // Per-layer key config: a chromaKey field on a layers[] row folds too.
    const perLayer = visualizerRenderSchema.parse({
      renderSettings: { width: 320, height: 240, fps: 30 },
      globalVisuals: { video: { layers: [{ assetId: "a", chromaKey: { enabled: true, color: "#112233" } }] } },
      stems: [{ name: "x.wav" }],
    }).globalVisuals;
    assert.equal(mediaAt(perLayer, 0).key.method, "colorkey");
    assert.equal(mediaAt(perLayer, 0).key.color, "#112233");
    // cutout carries model + feather defaults.
    const cut = visualizerRenderSchema.parse({
      renderSettings: { width: 320, height: 240, fps: 30 },
      globalVisuals: { video: { assetId: "a", key: { method: "cutout" } } },
      stems: [{ name: "x.wav" }],
    }).globalVisuals;
    assert.equal(mediaAt(cut, 0).key.method, "cutout");
    assert.equal(mediaAt(cut, 0).key.model, "mediapipe");
    // Unknown method / model rejected.
    assert.equal(vizVideoKeySchema.safeParse({ method: "magic" }).success, false);
    assert.equal(vizVideoKeySchema.safeParse({ method: "cutout", model: "rvm" }).success, false);
  });
});

describe("visualizer — advanced keying", () => {
  const keyOf = (patch: Partial<VizVideoKeyConfig>): VizVideoKeyConfig =>
    vizVideoKeySchema.parse(patch);

  /** Fill an RGBA buffer with a flat color (alpha 255). */
  const flat = (w: number, h: number, r: number, g: number, b: number): Uint8ClampedArray => {
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      px[i * 4] = r;
      px[i * 4 + 1] = g;
      px[i * 4 + 2] = b;
      px[i * 4 + 3] = 255;
    }
    return px;
  };

  it("chromaKeyYUVFrame keys a uniform key-color frame, keeps a far color", () => {
    const green = flat(16, 8, 0, 255, 0);
    chromaKeyYUVFrame(green, 16, 8, "#00FF00", 0.1, 0.02);
    assert.ok(green.every((v, i) => i % 4 !== 3 || v === 0)); // all alpha 0

    const magenta = flat(16, 8, 255, 0, 255);
    chromaKeyYUVFrame(magenta, 16, 8, "#00FF00", 0.1, 0.02);
    // Interior pixels (full 3×3 chroma neighbourhood) stay opaque.
    const mid = (4 * 16 + 8) * 4 + 3;
    assert.equal(magenta[mid], 255);
  });

  it("hsvKeyFrame keys by hue — greys survive, same-hue fades", () => {
    const px = new Uint8ClampedArray([
      0, 255, 0, 255,     // pure key green → gone
      128, 128, 128, 255, // grey: no hue → survives
      10, 250, 10, 255,   // near-key green → gone
      255, 0, 0, 255,     // red → survives
    ]);
    hsvKeyFrame(px, 4, 1, "#00FF00", 0.12, 0.02);
    assert.equal(px[3], 0);
    assert.equal(px[7], 255);
    assert.equal(px[11], 0);
    assert.equal(px[15], 255);
    // Black survives a green key (value term protects it).
    const dark = new Uint8ClampedArray([10, 10, 10, 255]);
    hsvKeyFrame(dark, 1, 1, "#00FF00", 0.12, 0.02);
    assert.equal(dark[3], 255);
  });

  it("hsvKeyFrame choke erodes the opaque matte edge", () => {
    // 7×1: skin-ish pixels at both ends, green middle.
    const row = () => {
      const buf = new Uint8ClampedArray(7 * 4);
      const put = (x: number, r: number, g: number, b: number) => buf.set([r, g, b, 255], x * 4);
      put(0, 200, 150, 120); put(1, 200, 150, 120);
      put(2, 0, 255, 0); put(3, 0, 255, 0); put(4, 0, 255, 0);
      put(5, 200, 150, 120); put(6, 200, 150, 120);
      return buf;
    };
    const alphas = (b: Uint8ClampedArray) => [0, 1, 2, 3, 4, 5, 6].map((x) => b[x * 4 + 3]);
    const unchoked = row();
    hsvKeyFrame(unchoked, 7, 1, "#00FF00", 0.12, 0.02);
    assert.deepEqual(alphas(unchoked), [255, 255, 0, 0, 0, 255, 255]);
    // choke=1: opaque pixels adjacent to transparent ones erode away.
    const choked = row();
    hsvKeyFrame(choked, 7, 1, "#00FF00", 0.12, 0.02, 1);
    assert.deepEqual(alphas(choked), [255, 0, 0, 0, 0, 0, 255]);
  });

  it("keyVideoFrame dispatches methods, applies despill, ignores cutout", () => {
    // none → untouched.
    const a = new Uint8ClampedArray([0, 255, 0, 255]);
    keyVideoFrame(a, 1, 1, keyOf({ method: "none" }));
    assert.equal(a[3], 255);
    // cutout → no-op here (alpha rides the keyed WebM upstream).
    const c = new Uint8ClampedArray([0, 255, 0, 255]);
    keyVideoFrame(c, 1, 1, keyOf({ method: "cutout", model: "modnet" }));
    assert.equal(c[3], 255);
    // colorkey → green gone.
    const k = new Uint8ClampedArray([0, 255, 0, 255]);
    keyVideoFrame(k, 1, 1, keyOf({ method: "colorkey" }));
    assert.equal(k[3], 0);
    // despill clamps the dominant (green) channel toward the others on
    // surviving edge pixels.
    const d = new Uint8ClampedArray([60, 230, 60, 255]); // greenish, partial key
    keyVideoFrame(d, 1, 1, keyOf({ method: "colorkey", similarity: 0.01, blend: 0.001, despill: true }));
    assert.equal(d[3], 255); // far enough → opaque
    assert.ok(d[1]! < 230);  // green excess removed
    // Same pixel without despill keeps its green.
    const d2 = new Uint8ClampedArray([60, 230, 60, 255]);
    keyVideoFrame(d2, 1, 1, keyOf({ method: "colorkey", similarity: 0.01, blend: 0.001, despill: false }));
    assert.equal(d2[1], 230);
  });

  it("videoDecoderArgs switches channels + input for keying and keyed WebM", () => {
    const keyOff = keyOf({ method: "none" });
    const off = videoDecoderArgs("/tmp/clip.mp4", 320, 240, 30, keyOff);
    assert.equal(off.channels, 3);
    assert.equal(off.keyed, false);
    assert.ok(off.args.join(" ").includes("-pix_fmt rgb24"));
    assert.ok(!off.args.join(" ").includes("format=rgba"));

    // Color keyers decode to rgba; the JS key pass runs post-decode (no
    // colorkey/chromakey filter in the pipe — parity with the Canvas preview).
    const on = videoDecoderArgs("/tmp/clip.mp4", 320, 240, 30, keyOf({ method: "chromakey", color: "#FF00FF", similarity: 0.25, blend: 0.05 }));
    assert.equal(on.channels, 4);
    assert.equal(on.keyed, true);
    const vf = on.args[on.args.indexOf("-vf") + 1]!;
    assert.equal(vf, "fps=30,scale=320:240:force_original_aspect_ratio=increase,crop=320:240,format=rgba");
    assert.ok(on.args.join(" ").includes("-pix_fmt rgba"));
    assert.ok(!on.args.join(" ").includes("colorkey="));

    // Cutout → decode the baked WebM with libvpx (alpha survives), ignore src.
    const cut = videoDecoderArgs("/tmp/clip.mp4", 320, 240, 30, keyOf({ method: "cutout" }), "/tmp/keyed.webm");
    assert.equal(cut.channels, 4);
    assert.ok(cut.args.join(" ").includes("-c:v libvpx-vp9"));
    // resolve()d inside — assert on the basename, not the literal posix path.
    assert.ok(cut.args.some((a) => a.includes("keyed.webm")));
    assert.ok(!cut.args.some((a) => a.includes("clip.mp4")));
  });
});

describe("visualizer — stem signal cache", () => {
  it("builds the payload once per stem content, then serves the disk cache", async () => {
    const sr = 48000;
    const dir = mkdtempSync(join(tmpdir(), "viz-sig-"));
    try {
      const wav = join(dir, "a.wav");
      // Random frequency → unique content hash → guaranteed cold cache.
      writeFileSync(wav, wavBuffer(sine(0.3, sr, 200 + Math.random() * 600), sr));

      const first = await stemSignalPayload(wav);
      assert.equal(first.cached, false);
      assert.ok(first.payload.length > 8);
      // Well-formed payload: u32 metaLen followed by that much meta JSON.
      const metaLen = first.payload.readUInt32LE(0);
      const meta = JSON.parse(first.payload.subarray(4, 4 + metaLen).toString("utf8")) as { version: number; counts: { peaks: number } };
      assert.equal(meta.version, 1);
      assert.ok(meta.counts.peaks > 0);

      // Second call on the same file → cache hit, byte-identical blob.
      const second = await stemSignalPayload(wav);
      assert.equal(second.cached, true);
      assert.ok(second.payload.equals(first.payload));

      // The key is content, not filename — a renamed copy hits the same entry.
      const copy = join(dir, "b.wav");
      writeFileSync(copy, readFileSync(wav));
      const third = await stemSignalPayload(copy);
      assert.equal(third.cached, true);
      assert.ok(third.payload.equals(first.payload));
    } finally {
      // The shared engineClient worker would keep this test process alive.
      engineClient.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- e2e: decode → render → mux → probe ----------------------------------------

describe("visualizer — end-to-end render", () => {
  it("renders a short MP4 from two synthesized WAV stems", async () => {
    const sr = 44100;
    const dir = mkdtempSync(join(tmpdir(), "viz-e2e-"));
    try {
      const vocalPath = join(dir, "vocals.wav");
      const drumPath = join(dir, "drums.wav");
      const drums = new Float32Array(Math.round(1.2 * sr));
      for (let k = 0; k < 6; k++) drums[Math.round(k * 0.2 * sr)] = 0.9; // clicks
      writeFileSync(vocalPath, wavBuffer(sine(1.2, sr, 220), sr));
      writeFileSync(drumPath, wavBuffer(drums, sr));

      const d1 = await decodeStem(vocalPath);
      const d2 = await decodeStem(drumPath);
      assert.equal(d1.sr, 48000); // resampled to the fixed render rate
      assert.ok(Math.abs(d1.durationSec - 1.2) < 0.1);

      const input = visualizerRenderSchema.parse({
        renderSettings: { width: 320, height: 240, fps: 30 },
        globalVisuals: { waveformLengthSec: 0.25, dancer: { enabled: true, style: "neon" } },
        stems: [{ name: "vocals.wav" }, { name: "drums.wav", kind: "drums" }],
      });
      const stems: FrameStem[] = [
        { cfg: resolveStem(input.stems[0]!, 0), signal: buildStemSignal(d1.pcm, d1.sr) },
        { cfg: resolveStem(input.stems[1]!, 1), signal: buildStemSignal(d2.pcm, d2.sr) },
      ];
      const out = join(dir, "out.mp4");
      const phases: string[] = [];
      const r = await renderVisualizer(input, stems, {
        audiblePaths: [vocalPath, drumPath],
        outPath: out,
        onProgress: (p) => phases.push(p.phase),
      });

      assert.equal(r.frames, 36); // ceil(1.2 * 30)
      assert.ok(phases.includes("frames") && phases.includes("mux") && phases.includes("verify"));
      const v = await probe(out);
      const a = await probeAudio(out);
      assert.equal(v.width, 320);
      assert.equal(v.height, 240);
      assert.equal(v.fps, 30);
      assert.ok(Math.abs(r.durationSeconds - 1.2) < 0.15);
      assert.ok(Math.abs(a.durationSeconds - 1.2) < 0.15);
      assert.equal(a.codec, "aac");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("muxArgs falls back to a silent AAC track when no stem is audible", () => {
    const args = muxArgs("/v.mp4", [], 2, "/o.mp4");
    assert.ok(args.includes("anullsrc=channel_layout=stereo:sample_rate=48000"));
    const args2 = muxArgs("/v.mp4", ["/a.wav", "/b.wav"], 2, "/o.mp4");
    assert.ok(args2.join(" ").includes("amix=inputs=2:normalize=0"));
  });
});
