import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { musicEditSettingsSchema, type MusicEditSettings } from "@twio/shared";
import { cutBoundaries, outputSize, planEdit, type PlanSource } from "../src/musicEdit/edl.ts";
import { parseAnalyzerOutput } from "../src/musicEdit/beatAnalysis.ts";
import { analyzePcm } from "../src/musicEdit/beatAnalyzer.ts";
import { segmentArgs } from "../src/musicEdit/render.ts";
import { MusicEditError } from "../src/musicEdit/errors.ts";

const settings = (s: Partial<MusicEditSettings> = {}): MusicEditSettings => musicEditSettingsSchema.parse(s);

// Irregular (human-played) beat timestamps: intervals wander around 0.46 s.
const BEATS = [0.21, 0.668, 1.131, 1.599, 2.056, 2.522, 2.975, 3.447, 3.901, 4.372, 4.829, 5.301, 5.752, 6.224, 6.683, 7.149, 7.605];
const DURATION = 8.0;
const src = (id: string, duration: number, width = 1920, height = 1080): PlanSource => ({ id, label: `${id}.mp4`, duration, width, height });
const FOUR = [src("v1", 30), src("v2", 25), src("v3", 20), src("v4", 40)];

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof MusicEditError, `expected MusicEditError, got ${e}`);
    return e.code;
  }
  assert.fail("expected an error");
};

describe("music edit — cut boundaries", () => {
  for (const n of [1, 2, 4, 8] as const) {
    it(`every ${n} beat(s): start = beat[i], end = beat[i + ${n}] (detected, not a BPM grid)`, () => {
      const b = cutBoundaries({ beatTimes: BEATS, audioDuration: DURATION, settings: settings({ beatsPerCut: n }) });
      assert.equal(b[0]!.time, 0);
      assert.equal(b.at(-1)!.time, DURATION);
      const inner = b.slice(1, -1);
      assert.deepEqual(inner.map((x) => x.time), BEATS.filter((_, i) => i % n === 0));
      assert.deepEqual(inner.map((x) => x.beat), BEATS.map((_, i) => i).filter((i) => i % n === 0));
      assert.ok(inner.every((x) => x.kind === "beat"));
    });
  }

  it("beat offset shifts the musical phase", () => {
    const b = cutBoundaries({ beatTimes: BEATS, audioDuration: DURATION, settings: settings({ beatsPerCut: 4, beatOffset: 1 }) });
    assert.deepEqual(b.slice(1, -1).map((x) => x.beat), [1, 5, 9, 13]);
  });

  it("manual BPM grid is only used when automatic beats are off", () => {
    const b = cutBoundaries({ beatTimes: BEATS, audioDuration: DURATION, settings: settings({ autoBeats: false, manualBpm: 120, beatsPerCut: 2 }) });
    assert.deepEqual(b.slice(1, -1).map((x) => x.time), [1, 2, 3, 4, 5, 6, 7]);
    assert.ok(b.slice(1, -1).every((x) => x.kind === "manual_grid"));
    assert.equal(code(() => cutBoundaries({ beatTimes: [], audioDuration: DURATION, settings: settings({ autoBeats: false }) })), "MANUAL_BPM_REQUIRED");
  });

  it("rejects missing / invalid beat timestamps", () => {
    assert.equal(code(() => cutBoundaries({ beatTimes: [], audioDuration: DURATION, settings: settings() })), "NO_BEATS_DETECTED");
    assert.equal(code(() => cutBoundaries({ beatTimes: [1, 0.5], audioDuration: DURATION, settings: settings() })), "INVALID_BEAT_TIMESTAMPS");
    assert.equal(code(() => cutBoundaries({ beatTimes: [1, Number.NaN], audioDuration: DURATION, settings: settings() })), "INVALID_BEAT_TIMESTAMPS");
    assert.equal(code(() => cutBoundaries({ beatTimes: [1, 20], audioDuration: DURATION, settings: settings() })), "INVALID_BEAT_TIMESTAMPS");
    assert.equal(code(() => cutBoundaries({ beatTimes: [1], audioDuration: 0, settings: settings() })), "CORRUPT_AUDIO");
  });
});

describe("music edit — EDL planner", () => {
  const plan = (s: Partial<MusicEditSettings>, sources = FOUR, beats = BEATS, duration = DURATION) =>
    planEdit({ beatTimes: beats, bpm: 129.6, audioDuration: duration, sources, settings: settings(s) });

  it("is deterministic", () => {
    assert.deepEqual(plan({ beatsPerCut: 1 }), plan({ beatsPerCut: 1 }));
  });

  it("covers the whole song with contiguous frames and exact beat cut points", () => {
    for (const n of [1, 2, 4, 8] as const) {
      const p = plan({ beatsPerCut: n });
      assert.equal(p.timing, "detected_beats");
      assert.equal(p.totalFrames, DURATION * 30);
      assert.equal(p.entries[0]!.frameStart, 0);
      assert.equal(p.entries.at(-1)!.frameEnd, p.totalFrames);
      assert.equal(p.entries.at(-1)!.outputEnd, DURATION);
      for (let i = 1; i < p.entries.length; i++) {
        const e = p.entries[i]!;
        assert.equal(e.frameStart, p.entries[i - 1]!.frameEnd);
        assert.equal(e.outputStart, BEATS[e.startBeat!]);
        assert.equal(e.frameStart, Math.round(BEATS[e.startBeat!]! * 30));
      }
    }
  });

  it("uses sources round-robin V1 → V2 → V3 → V4 → V1 with progressing cursors", () => {
    const p = plan({ beatsPerCut: 1 });
    assert.deepEqual(p.entries.slice(0, 8).map((e) => e.sourceId), ["v1", "v2", "v3", "v4", "v1", "v2", "v3", "v4"]);
    const v1 = p.entries.filter((e) => e.sourceId === "v1");
    for (let i = 1; i < v1.length; i++) assert.equal(v1[i]!.sourceStart, v1[i - 1]!.sourceEnd);
    assert.ok(v1.at(-1)!.sourceStart > 0);
  });

  it("stays within the retime limits and fills each interval exactly", () => {
    const p = plan({ beatsPerCut: 1 }, [src("a", 0.5), src("b", 0.42), src("c", 30)]);
    for (const e of p.entries) {
      assert.ok(e.speed <= 1.25 + 1e-6 && e.speed >= 0.8 - 1e-6, `speed ${e.speed}`);
      const frames = e.frameEnd - e.frameStart;
      assert.ok(Math.abs(e.sourceConsumed / e.speed - frames / 30) < 1e-4);
    }
    assert.ok(p.stats.retimedCount > 0, "short sources must be retimed");
  });

  it("never reads beyond a short source and skips it when it cannot fit", () => {
    const p = plan({ beatsPerCut: 4 }, [src("short", 0.6), src("long", 60)]);
    for (const e of p.entries) {
      if (e.sourceId !== "short") continue;
      assert.ok(e.sourceEnd <= 0.6);
      assert.ok(e.sourceConsumed >= ((e.frameEnd - e.frameStart) / 30) * 0.8 - 1e-6, "short source only used where it fits");
    }
    const beatToBeat = p.entries.filter((e) => e.startKind === "beat" && e.endKind === "beat");
    assert.ok(beatToBeat.length > 0 && beatToBeat.every((e) => e.sourceId === "long"), "0.6 s cannot fill ~1.85 s within 0.8× slow-down");
  });

  it("loops a short source when looping is enabled", () => {
    const p = plan({ beatsPerCut: 8, loopSource: true }, [src("short", 1.0)]);
    assert.ok(p.stats.loopedCount > 0);
    for (const e of p.entries) {
      for (const piece of e.pieces) assert.ok(piece.start >= 0 && piece.end <= 1.0 && piece.end > piece.start);
      assert.equal(e.speed, 1);
    }
  });

  it("reports insufficient material instead of producing a bad edit", () => {
    assert.equal(code(() => plan({ beatsPerCut: 8 }, [src("short", 0.6)])), "INSUFFICIENT_VIDEO_MATERIAL");
    assert.equal(code(() => plan({}, [])), "NO_SOURCE_VIDEOS");
  });

  it("allowExtremeRetime permits speeds outside the limits only when enabled", () => {
    const p = plan({ beatsPerCut: 8, allowExtremeRetime: true }, [src("short", 0.6)]);
    assert.ok(p.stats.minSpeed < 0.8);
  });

  it("never upscales beyond the largest source", () => {
    assert.deepEqual(outputSize([src("a", 1, 1280, 720)], settings()), { width: 1280, height: 720 });
    assert.deepEqual(outputSize([src("a", 1, 3840, 2160)], settings()), { width: 1920, height: 1080 });
    assert.deepEqual(outputSize([src("a", 1, 1920, 1080)], settings({ aspect: "9:16" })), { width: 608, height: 1080 });
  });
});

describe("music edit — built-in beat tracker (no python)", () => {
  const SR = 22050;
  const HOP = 256;

  const mulberry = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /** Quiet sine bed + decaying noise bursts at (jittered) beat positions. */
  const clickTrack = (bpm: number, seconds: number, jitterMs: number) => {
    const y = new Float32Array(Math.floor(SR * seconds));
    const rnd = mulberry(7);
    for (let i = 0; i < y.length; i++) y[i] = 0.005 * Math.sin((2 * Math.PI * 220 * i) / SR);
    const hits: number[] = [];
    for (let t = 0.4; t < seconds - 0.3; t += 60 / bpm) {
      const hit = t + (rnd() - 0.5) * (jitterMs / 1000);
      hits.push(hit);
      const start = Math.round(hit * SR);
      for (let i = 0; i < 0.025 * SR && start + i < y.length; i++) {
        y[start + i]! += Math.exp(-i / (0.005 * SR)) * 0.9 * (rnd() * 2 - 1);
      }
    }
    return { y, hits };
  };

  it("detects tempo and beat times on a jittered 120 BPM click track", () => {
    const { y, hits } = clickTrack(120, 12, 30);
    const a = analyzePcm(y, SR, HOP);
    assert.ok(Math.abs(a.bpm - 120) < 6, `bpm ${a.bpm}`);
    assert.ok(a.beats.length >= 15, `${a.beats.length} beats`);
    const times = a.beats.map((b) => b.time);
    for (let i = 1; i < times.length; i++) assert.ok(times[i]! > times[i - 1]!, "beats strictly increasing");
    const matched = hits.filter((h) => times.some((t) => Math.abs(t - h) < 0.06)).length;
    assert.ok(matched / hits.length > 0.8, `matched ${matched}/${hits.length} clicks`);
  });

  it("detects a tempo off the 120 BPM prior (140 BPM)", () => {
    const { y } = clickTrack(140, 12, 20);
    const a = analyzePcm(y, SR, HOP);
    assert.ok(Math.abs(a.bpm - 140) < 8, `bpm ${a.bpm}`);
  });

  it("silence yields no beats → NO_BEATS_DETECTED through the parser", () => {
    const a = analyzePcm(new Float32Array(SR * 2), SR, HOP);
    assert.equal(a.beats.length, 0);
    assert.equal(code(() => parseAnalyzerOutput(a)), "NO_BEATS_DETECTED");
  });
});

describe("music edit — analyzer output + ffmpeg args", () => {
  it("keeps explicit beat timestamps from the analyzer", () => {
    const a = parseAnalyzerOutput({
      bpm: 95.7,
      duration: 3,
      beats: [{ time: 0.5, strength: 1 }, { time: 1.12, strength: 0.4 }, { time: 1.61, strength: 0.7 }],
      analyzer: { name: "librosa", version: "0.11.0", sampleRate: 22050, hopLength: 512 },
    });
    assert.deepEqual(a.beats.map((b) => b.time), [0.5, 1.12, 1.61]);
    assert.equal(a.bpm, 95.7);
  });

  it("builds a trim + setpts retime command with an exact frame count", () => {
    const p = planEdit({ beatTimes: BEATS, bpm: 130, audioDuration: DURATION, sources: [src("a", 0.5), src("c", 30)], settings: settings({ beatsPerCut: 1 }) });
    const e = p.entries.find((x) => x.speed !== 1)!;
    const args = segmentArgs(e, { path: "/v/a.mp4", duration: 0.5 }, p, "/tmp/out.h264");
    const filter = args[args.indexOf("-filter_complex") + 1]!;
    assert.match(filter, new RegExp(`setpts=\\(PTS-STARTPTS\\)/${e.speed.toFixed(6)}`));
    assert.equal(args[args.indexOf("-frames:v") + 1], String(e.frameEnd - e.frameStart));
    assert.equal(args[args.indexOf("-ss") + 1], e.sourceStart.toFixed(6));
    assert.ok(Number(args[args.indexOf("-t") + 1]) + e.sourceStart <= 0.5);
  });
});
