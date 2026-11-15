import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { musicEditSettingsSchema, type MusicEditSettings } from "@twio/shared";
import { planEdit, type PlanSource } from "../src/musicEdit/edl.ts";
import { analyzeMotionFile } from "../src/musicEdit/motionProfile.ts";
import { ffmpegService } from "../src/video/ffmpeg.ts";

const settings = (s: Partial<MusicEditSettings> = {}): MusicEditSettings => musicEditSettingsSchema.parse(s);
const src = (id: string, duration: number, peaks?: Array<{ time: number; strength: number }>): PlanSource => ({
  id,
  label: `${id}.mp4`,
  duration,
  width: 1920,
  height: 1080,
  motionPeaks: peaks,
});
const CUTS = [1, 2, 3].map((t) => ({ time: t, beat: null, kind: "beat" as const }));

const base = (over: Partial<Parameters<typeof planEdit>[0]> = {}) => ({
  beatTimes: [],
  bpm: 120,
  audioDuration: 4,
  sources: [src("a", 30)],
  settings: settings(),
  cutMarks: CUTS,
  ...over,
});

describe("motion alignment — in-point shifting", () => {
  it("off by default: no motionShift fields, identical picks", () => {
    const peaks = [{ time: 1.4, strength: 1 }];
    const p = planEdit(base({ sources: [src("a", 30, peaks)], settings: settings() }));
    assert.ok(p.entries.every((e) => e.motionShift === undefined));
    assert.equal(p.entries[0]!.sourceStart, 0);
  });

  it("shifts the in-point so the strongest nearby peak lands on the cut", () => {
    // Cursor at 0 for slot 1; peak at 0.3 → in-point moves to 0.3.
    const p = planEdit(
      base({
        sources: [src("a", 30, [{ time: 0.3, strength: 1 }, { time: 2.0, strength: 0.5 }])],
        settings: settings({ alignMotion: true, motionWindow: 0.5, motionLead: 0 }),
      }),
    );
    const e0 = p.entries[0]!;
    assert.equal(e0.motionShift, 0.3);
    assert.ok(Math.abs(e0.sourceStart - 0.3) < 1e-6);
  });

  it("picks the STRONGEST peak inside the window, not the nearest", () => {
    const p = planEdit(
      base({
        sources: [src("a", 30, [{ time: 0.1, strength: 0.4 }, { time: 0.45, strength: 0.9 }])],
        settings: settings({ alignMotion: true, motionWindow: 0.5, motionLead: 0 }),
      }),
    );
    assert.equal(p.entries[0]!.motionShift, 0.45);
  });

  it("honours motionLead (peak lands `lead` seconds after the in-point)", () => {
    const p = planEdit(
      base({
        sources: [src("a", 30, [{ time: 0.5, strength: 1 }])],
        settings: settings({ alignMotion: true, motionWindow: 0.6, motionLead: 0.2 }),
      }),
    );
    // in-point = peak − lead = 0.3
    assert.equal(p.entries[0]!.motionShift, 0.3);
    assert.ok(Math.abs(p.entries[0]!.sourceStart - 0.3) < 1e-6);
  });

  it("ignores peaks outside ±window and falls back to the cursor", () => {
    const p = planEdit(
      base({
        sources: [src("a", 30, [{ time: 5.0, strength: 1 }])],
        settings: settings({ alignMotion: true, motionWindow: 0.5, motionLead: 0 }),
      }),
    );
    assert.equal(p.entries[0]!.sourceStart, 0);
    assert.equal(p.entries[0]!.motionShift, undefined);
  });

  it("clamps shifts that would read before 0 or past the usable tail", () => {
    const p = planEdit(
      base({
        sources: [src("a", 4.2, [{ time: 0.05, strength: 1 }, { time: 3.9, strength: 0.9 }])], // usable ≈ 4.1
        settings: settings({ alignMotion: true, motionWindow: 1, motionLead: 0 }),
      }),
    );
    for (const e of p.entries) {
      assert.ok(e.sourceStart >= 0 && e.sourceEnd <= 4.2 + 1e-6, `entry ${e.index} out of bounds`);
    }
  });

  it("a clip with no peaks keeps the unshifted cursor", () => {
    const p = planEdit(base({ sources: [src("a", 30, [])], settings: settings({ alignMotion: true }) }));
    assert.ok(p.entries.every((e) => e.motionShift === undefined && e.sourceStart >= 0));
  });

  it("intercut entries also shift and report motionShift", () => {
    const p = planEdit(
      base({
        sources: [src("a", 30, [{ time: 0.3, strength: 1 }]), src("b", 30)],
        settings: settings({ alignMotion: true, motionWindow: 0.5 }),
        intercut: {
          slotsPerSlice: 1,
          endOfMaterial: "loop",
          storylines: [
            { id: "a", name: "A", clips: [src("a", 30, [{ time: 0.3, strength: 1 }])] },
            { id: "b", name: "B", clips: [src("b", 30)] },
          ],
        },
      }),
    );
    const a0 = p.entries.find((e) => e.storylineId === "a")!;
    assert.equal(a0.motionShift, 0.3);
  });
});

describe("motion profile — real decode (ffmpeg)", () => {
  it("detects a white-flash peak near its known time on a generated clip", async (t) => {
    if (!ffmpegService) return t.skip("no ffmpeg");
    const dir = mkdtempSync(join(tmpdir(), "twio-motion-"));
    const clip = join(dir, "flash.mp4");
    // testsrc2 moving pattern + an ~80 ms white flash at t≈1.0 s.
    const r = await ffmpegService.ffmpegExec(
      [
        "-v", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=12:duration=3",
        "-vf", "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(t,1.0,1.08)'",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", clip,
      ],
      "motion-testsrc",
    );
    assert.equal(r.exitCode, 0, r.stderr.slice(-300));
    const prof = await analyzeMotionFile(clip, { cacheDir: join(dir, "cache") });
    assert.ok(prof.energies.length > 10, `${prof.energies.length} frames`);
    assert.ok(prof.peaks.length >= 1, "at least one motion peak");
    const near = prof.peaks.find((p) => Math.abs(p.time - 1.04) < 0.25);
    assert.ok(near, `peak near t≈1.04, got ${prof.peaks.map((p) => p.time.toFixed(2)).join(",")}`);
  });
});
