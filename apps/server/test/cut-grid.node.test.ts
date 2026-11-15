import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cutGridSchema, musicEditPlanSchema, musicEditSettingsSchema, type BeatPoint, type MusicEditSettings } from "@twio/shared";
import { cutBoundaries, planEdit, type PlanSource } from "../src/musicEdit/edl.ts";
import { bandOnsetEnvelope } from "../src/musicEdit/beatAnalyzer.ts";
import {
  barsMarks,
  buildCutGrid,
  everyNBeatsMarks,
  pickBarPhase,
  pickOnsetPeaks,
  sectionMarks,
  segmentByEnergy,
  SECTION_AUTO_DENSITY,
  type CutGridContext,
  type EnergySection,
} from "../src/musicEdit/cutGrid.ts";
import { MusicEditError } from "../src/musicEdit/errors.ts";

const settings = (s: Partial<MusicEditSettings> = {}): MusicEditSettings => musicEditSettingsSchema.parse(s);
const src = (id: string, duration: number): PlanSource => ({ id, label: `${id}.mp4`, duration, width: 1920, height: 1080 });

const BEATS = [0.21, 0.668, 1.131, 1.599, 2.056, 2.522, 2.975, 3.447, 3.901, 4.372, 4.829, 5.301, 5.752, 6.224, 6.683, 7.149, 7.605];
const DURATION = 8.0;

const beatPoints = (times: number[], strength: number | null = 0.5): BeatPoint[] => times.map((time) => ({ time, strength }));

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof MusicEditError, `expected MusicEditError, got ${e}`);
    return e.code;
  }
  assert.fail("expected an error");
};

describe("cut grid — every N beats", () => {
  it("cuts on beat indices offset, offset+n, offset+2n…", () => {
    const marks = everyNBeatsMarks(BEATS, 2, 0);
    assert.deepEqual(marks.map((m) => m.beat), [0, 2, 4, 6, 8, 10, 12, 14, 16]);
    assert.ok(marks.every((m) => m.kind === "beat"));
    assert.equal(marks[0]!.time, BEATS[0]);
  });

  it("offset shifts the phase like the legacy beatOffset", () => {
    const marks = everyNBeatsMarks(BEATS, 4, 1);
    assert.deepEqual(marks.map((m) => m.beat), [1, 5, 9, 13]);
  });

  it("rejects invalid n / offset", () => {
    assert.equal(code(() => everyNBeatsMarks(BEATS, 0)), "INVALID_GRID");
    assert.equal(code(() => everyNBeatsMarks(BEATS, 1.5)), "INVALID_GRID");
    assert.equal(code(() => everyNBeatsMarks(BEATS, 2, -1)), "INVALID_GRID");
  });
});

describe("cut grid — bars", () => {
  // 20 beats at 0.5 s spacing; onset strength peaks on indices ≡ 2 (mod 4)
  // so the auto phase must resolve to 2.
  const barBeats = beatPoints(
    Array.from({ length: 20 }, (_, i) => 0.5 + i * 0.5),
    0,
  ).map((b, i) => ({ ...b, strength: i % 4 === 2 ? 0.9 : 0.1 }));

  it("picks the phase with the highest summed onset strength", () => {
    assert.equal(pickBarPhase(barBeats, 4), 2);
    assert.equal(pickBarPhase(beatPoints([0.5, 1, 1.5, 2, 2.5, 3]), 3), 0); // uniform → phase 0
  });

  it("cuts on bar starts for 4/4 and honours an explicit phase", () => {
    const r = barsMarks(barBeats, 4);
    assert.equal(r.phase, 2);
    assert.deepEqual(r.marks.map((m) => m.beat), [2, 6, 10, 14, 18]);
    assert.ok(r.marks.every((m) => m.kind === "bar"));
    const forced = barsMarks(barBeats, 4, 1);
    assert.equal(forced.phase, 1);
    assert.deepEqual(forced.marks.map((m) => m.beat), [1, 5, 9, 13, 17]);
  });

  it("supports 3/4", () => {
    const beats = beatPoints(Array.from({ length: 12 }, (_, i) => 0.4 * (i + 1)), 0).map((b, i) => ({
      ...b,
      strength: i % 3 === 0 ? 1 : 0.2,
    }));
    const r = barsMarks(beats, 3);
    assert.equal(r.phase, 0);
    assert.deepEqual(r.marks.map((m) => m.beat), [0, 3, 6, 9]);
  });
});

describe("cut grid — onset peak picking", () => {
  const SR = 22050;
  const HOP = 256;

  it("picks local maxima above the threshold", () => {
    // env peaks at frames 100, 500, 900 (→ t = f*hop/sr)
    const env = new Float32Array(1200);
    env[100] = 0.8;
    env[500] = 0.5;
    env[900] = 0.3;
    env[300] = 0.05; // below threshold (0.12 * 0.8 = 0.096)
    const peaks = pickOnsetPeaks(env, SR, HOP, { minGapSec: 0.05, threshold: 0.12 });
    const times = peaks.map((p) => p.time);
    const expected = [100, 500, 900].map((f) => Math.round(((f * HOP) / SR) * 1e6) / 1e6);
    assert.deepEqual(times, expected);
    assert.equal(peaks[0]!.strength, 1);
    assert.ok(Math.abs(peaks[1]!.strength - 0.625) < 1e-4);
  });

  it("enforces the minimum gap between picks", () => {
    const env = new Float32Array(2000);
    env[100] = 0.9;
    env[110] = 1.0; // stronger but inside the refractory window of frame 100
    env[600] = 0.8;
    // minGap 0.25 s ≈ 21.5 frames → after picking 100, frames < ~122 are skipped
    const peaks = pickOnsetPeaks(env, SR, HOP, { minGapSec: 0.25, threshold: 0.1 });
    assert.deepEqual(
      peaks.map((p) => p.time),
      [Math.round(((100 * HOP) / SR) * 1e6) / 1e6, Math.round(((600 * HOP) / SR) * 1e6) / 1e6],
    );
  });

  it("returns nothing for silent / degenerate envelopes", () => {
    assert.deepEqual(pickOnsetPeaks(new Float32Array(100), SR, HOP), []);
    assert.deepEqual(pickOnsetPeaks(new Float32Array(100).fill(0.5), SR, HOP), []);
  });
});

describe("cut grid — band-limited onset envelope (synthetic PCM)", () => {
  const SR = 22050;
  const HOP = 256;

  const mulberry = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /** Decaying sine bursts at the given times/frequencies. */
  const toneHits = (freqs: number[], seconds: number) => {
    const y = new Float32Array(Math.floor(SR * seconds));
    const rnd = mulberry(11);
    for (const f of freqs) {
      for (let t = 0.5; t < seconds - 0.4; t += 0.7) {
        const start = Math.round((t + (rnd() - 0.5) * 0.02) * SR);
        for (let i = 0; i < 0.03 * SR && start + i < y.length; i++) {
          y[start + i]! += Math.exp(-i / (0.006 * SR)) * Math.sin((2 * Math.PI * f * i) / SR);
        }
      }
    }
    return y;
  };

  const envMax = (env: Float32Array) => env.reduce((m, v) => Math.max(m, v), 0);

  it("kick band responds to low-frequency hits, snare/hat band does not", () => {
    const y = toneHits([90], 6);
    const kick = bandOnsetEnvelope(y, SR, HOP, "kick");
    const snare = bandOnsetEnvelope(y, SR, HOP, "snare_hat");
    const full = bandOnsetEnvelope(y, SR, HOP, "full");
    assert.ok(envMax(kick) > 0, "kick band must see the 90 Hz hits");
    // Onset attacks are inherently broadband, so the high band still sees a
    // fraction of the flux — assert relative weighting, not isolation.
    assert.ok(envMax(snare) < envMax(kick) * 0.5, `snare band should be much weaker on a 90 Hz tone (max ${envMax(snare)} vs kick ${envMax(kick)})`);
    assert.ok(envMax(full) > 0);
    // Kick peaks land within ~80 ms of the generated hits.
    const hits: number[] = [];
    for (let t = 0.5; t < 6 - 0.4; t += 0.7) hits.push(t);
    const peaks = pickOnsetPeaks(kick, SR, HOP, { minGapSec: 0.25, threshold: 0.1 });
    assert.ok(peaks.length >= 5, `${peaks.length} kick peaks`);
    for (const p of peaks) {
      assert.ok(hits.some((h) => Math.abs(p.time - h) < 0.09), `peak at ${p.time} matches a hit`);
    }
  });

  it("full band on a click track yields beat-rate peaks", () => {
    // 120 BPM clicks via the same recipe as the beat-tracker test.
    const y = new Float32Array(SR * 8);
    const rnd = mulberry(7);
    for (let i = 0; i < y.length; i++) y[i] = 0.004 * Math.sin((2 * Math.PI * 220 * i) / SR);
    for (let t = 0.4; t < 7.6; t += 0.5) {
      const start = Math.round(t * SR);
      for (let i = 0; i < 0.025 * SR && start + i < y.length; i++) {
        y[start + i]! += Math.exp(-i / (0.005 * SR)) * 0.9 * (rnd() * 2 - 1);
      }
    }
    const env = bandOnsetEnvelope(y, SR, HOP, "full");
    const peaks = pickOnsetPeaks(env, SR, HOP, { minGapSec: 0.25, threshold: 0.15 });
    assert.ok(peaks.length >= 10, `${peaks.length} peaks on a 120 BPM click track`);
    const ibi = peaks.slice(1).map((p, i) => p.time - peaks[i]!.time);
    assert.ok(ibi.every((d) => d > 0.2 && d < 0.8), `peak spacing looks beat-like: ${ibi.slice(0, 6)}`);
  });
});

describe("cut grid — energy sections", () => {
  const SR = 22050;

  const mulberry = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /** 12 s: quiet noise → loud noise → quiet noise. */
  const energyTrack = () => {
    const y = new Float32Array(SR * 12);
    const rnd = mulberry(3);
    for (let i = 0; i < y.length; i++) {
      const t = i / SR;
      const amp = t < 4 ? 0.02 : t < 8 ? 0.4 : 0.02;
      y[i] = (rnd() * 2 - 1) * amp;
    }
    return y;
  };

  it("segments quiet / loud / quiet with boundaries near 4 s and 8 s", () => {
    const secs = segmentByEnergy(energyTrack(), SR);
    assert.equal(secs.length, 3, JSON.stringify(secs));
    assert.deepEqual(secs.map((s) => s.cls), ["quiet", "loud", "quiet"]);
    assert.ok(Math.abs(secs[1]!.start - 4) < 0.8, `loud section starts at ${secs[1]!.start}`);
    assert.ok(Math.abs(secs[1]!.end - 8) < 0.8, `loud section ends at ${secs[1]!.end}`);
    assert.equal(secs[0]!.start, 0);
    assert.equal(secs.at(-1)!.end, 12);
  });

  it("uniform energy yields a single loud section", () => {
    const y = new Float32Array(SR * 6);
    const rnd = mulberry(5);
    for (let i = 0; i < y.length; i++) y[i] = (rnd() * 2 - 1) * 0.2;
    const secs = segmentByEnergy(y, SR);
    assert.equal(secs.length, 1);
    assert.equal(secs[0]!.cls, "loud");
  });
});

describe("cut grid — section-aware density", () => {
  const beatTimes = Array.from({ length: 50 }, (_, i) => 0.2 + i * 0.4); // 0.2 … 19.8 s
  const sections: EnergySection[] = [
    { start: 0, end: 10, energy: 0.3, cls: "quiet" },
    { start: 10, end: 20, energy: 0.9, cls: "loud" },
  ];

  it("cuts every Nth beat per section and always on each section's first beat", () => {
    const marks = sectionMarks(beatTimes, sections, { quiet: 4, medium: 2, loud: 1 });
    // quiet [0,10): beats idx 0..24 (t<10) → j=0,4,…,24 → 7 cuts
    // loud [10,20): beats idx 25..49 → every beat → 25 cuts
    assert.equal(marks.length, 32);
    assert.deepEqual(marks.slice(0, 7).map((m) => m.beat), [0, 4, 8, 12, 16, 20, 24]);
    assert.equal(marks[7]!.beat, 25); // first beat of the loud section
    assert.ok(marks.every((m) => m.kind === "section"));
    // strictly increasing
    for (let i = 1; i < marks.length; i++) assert.ok(marks[i]!.time > marks[i - 1]!.time);
  });

  it("auto density is denser for louder sections", () => {
    assert.ok(SECTION_AUTO_DENSITY.loud < SECTION_AUTO_DENSITY.medium);
    assert.ok(SECTION_AUTO_DENSITY.medium < SECTION_AUTO_DENSITY.quiet);
  });
});

describe("cut grid — dispatcher", () => {
  const ctx = (over: Partial<CutGridContext> = {}): CutGridContext => ({
    beats: beatPoints(BEATS, 0.5),
    audioDuration: DURATION,
    ...over,
  });

  it("builds marks + label for every source", () => {
    const spec = cutGridSchema.parse({ source: "every_n_beats", n: 4 });
    const g = buildCutGrid(spec, ctx());
    assert.equal(g.label, "Every 4 beats");
    assert.deepEqual(g.marks.map((m) => m.beat), [0, 4, 8, 12, 16]);

    const bars = buildCutGrid(cutGridSchema.parse({ source: "bars", beatsPerBar: 4 }), ctx());
    assert.match(bars.label, /Bar starts \(4\/4\)/);

    const stems = buildCutGrid(
      cutGridSchema.parse({ source: "stem_onsets", stem: "drums.wav", band: "kick" }),
      ctx({ onsetPeaks: [{ time: 1.0, strength: 1 }, { time: 2.0, strength: 0.8 }] }),
    );
    assert.equal(stems.marks.length, 2);
    assert.ok(stems.marks.every((m) => m.kind === "stem_onset" && m.beat === null));
    assert.match(stems.detail ?? "", /kick band/);

    const secs = buildCutGrid(
      cutGridSchema.parse({ source: "sections" }),
      ctx({ sections: [{ start: 0, end: DURATION, energy: 0.5, cls: "medium" }] }),
    );
    assert.equal(secs.label, "Auto by section");
    assert.match(secs.detail ?? "", /medium every 2/);
  });

  it("fails honestly when context is missing or the grid is empty", () => {
    assert.equal(
      code(() => buildCutGrid(cutGridSchema.parse({ source: "stem_onsets", stem: "x.wav" }), ctx())),
      "GRID_CONTEXT_MISSING",
    );
    assert.equal(
      code(() => buildCutGrid(cutGridSchema.parse({ source: "sections" }), ctx())),
      "GRID_CONTEXT_MISSING",
    );
    assert.equal(
      code(() => buildCutGrid(cutGridSchema.parse({ source: "every_n_beats", n: 4, offset: 20 }), ctx())),
      "GRID_NO_CUTS",
    );
    assert.equal(
      code(() =>
        buildCutGrid(
          cutGridSchema.parse({ source: "stem_onsets", stem: "x.wav", threshold: 0.9 }),
          ctx({ onsetPeaks: [] }),
        ),
      ),
      "GRID_NO_CUTS",
    );
  });
});

describe("cut grid — EDL integration", () => {
  const marks = [
    { time: 1.0, beat: null, kind: "stem_onset" as const },
    { time: 3.0, beat: 5, kind: "beat" as const },
    { time: 5.5, beat: null, kind: "section" as const },
  ];

  it("planEdit honours precomputed cut marks end-to-end", () => {
    const p = planEdit({
      beatTimes: BEATS,
      bpm: 130,
      audioDuration: DURATION,
      sources: [src("a", 30), src("b", 30)],
      settings: settings(),
      cutMarks: marks,
      grid: { source: "stem_onsets", label: "Stem hits · drums.wav" },
    });
    assert.equal(p.timing, "cut_grid");
    assert.deepEqual(p.grid, { source: "stem_onsets", label: "Stem hits · drums.wav", cutCount: 3 });
    assert.equal(p.entries.length, 4);
    assert.deepEqual(p.entries.map((e) => e.outputStart), [0, 1.0, 3.0, 5.5]);
    assert.equal(p.entries[1]!.startKind, "stem_onset");
    assert.equal(p.entries[2]!.startBeat, 5);
    // contiguous frames, exact cut times
    for (let i = 1; i < p.entries.length; i++) {
      assert.equal(p.entries[i]!.frameStart, p.entries[i - 1]!.frameEnd);
      assert.equal(p.entries[i]!.outputStart, marks[i - 1]!.time);
    }
    assert.equal(p.entries.at(-1)!.outputEnd, DURATION);
  });

  it("cutBoundaries validates marks and rejects empty grids", () => {
    const base = { audioDuration: DURATION, settings: settings() };
    assert.equal(code(() => cutBoundaries({ ...base, beatTimes: BEATS, cutMarks: [] })), "GRID_NO_CUTS");
    assert.equal(
      code(() => cutBoundaries({ ...base, beatTimes: BEATS, cutMarks: [{ time: 2, beat: null, kind: "beat" }, { time: 1, beat: null, kind: "beat" }] })),
      "INVALID_CUT_TIMES",
    );
    assert.equal(
      code(() => cutBoundaries({ ...base, beatTimes: BEATS, cutMarks: [{ time: 99, beat: null, kind: "beat" }] })),
      "INVALID_CUT_TIMES",
    );
  });

  it("marks closer than a frame are merged by the existing min-gap logic", () => {
    const dense = [
      { time: 2.0, beat: null, kind: "beat" as const },
      { time: 2.01, beat: null, kind: "beat" as const }, // < MIN_SEGMENT_FRAMES/fps apart
      { time: 4.0, beat: null, kind: "beat" as const },
    ];
    const b = cutBoundaries({ beatTimes: BEATS, audioDuration: DURATION, settings: settings(), cutMarks: dense });
    assert.deepEqual(b.slice(1, -1).map((x) => x.time), [2.0, 4.0]);
  });

  it("legacy path is untouched when no grid is given", () => {
    const p = planEdit({ beatTimes: BEATS, bpm: 130, audioDuration: DURATION, sources: [src("a", 30)], settings: settings({ beatsPerCut: 2 }) });
    assert.equal(p.timing, "detected_beats");
    assert.equal(p.grid, undefined);
  });
});

describe("cut grid — request schema", () => {
  it("accepts every grid source and applies defaults", () => {
    const parsed = musicEditPlanSchema.parse({
      song: "a.mp3",
      assetIds: ["v1"],
      grid: { source: "stem_onsets", stem: "drums.wav" },
    });
    assert.equal(parsed.grid?.source, "stem_onsets");
    assert.equal(parsed.grid?.source === "stem_onsets" ? parsed.grid.band : null, "full");
    assert.equal(parsed.grid?.source === "stem_onsets" ? parsed.grid.minGap : null, 0.25);
  });

  it("omitted grid stays undefined (backwards compatible)", () => {
    const parsed = musicEditPlanSchema.parse({ song: "a.mp3", assetIds: ["v1"] });
    assert.equal(parsed.grid, undefined);
    assert.equal(parsed.settings.beatsPerCut, 2);
  });

  it("rejects unknown sources and out-of-range params", () => {
    assert.throws(() => musicEditPlanSchema.parse({ song: "a", assetIds: ["v"], grid: { source: "nope" } }));
    assert.throws(() => musicEditPlanSchema.parse({ song: "a", assetIds: ["v"], grid: { source: "stem_onsets", stem: "x", minGap: 99 } }));
    assert.throws(() => musicEditPlanSchema.parse({ song: "a", assetIds: ["v"], grid: { source: "bars", beatsPerBar: 5 as never } }));
  });
});
