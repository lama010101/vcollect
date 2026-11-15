import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cutGridSchema, musicEditPlanSchema, musicEditSettingsSchema, type MusicEditSettings } from "@twio/shared";
import { planEdit, type PlanSource, type PlanStoryline } from "../src/musicEdit/edl.ts";
import { MusicEditError } from "../src/musicEdit/errors.ts";

const settings = (s: Partial<MusicEditSettings> = {}): MusicEditSettings => musicEditSettingsSchema.parse(s);
const src = (id: string, duration: number): PlanSource => ({ id, label: `${id}.mp4`, duration, width: 1920, height: 1080 });

// 8 s song, cuts every 1 s → 8 slots of ~1 s each (manual-ish via cutMarks).
const CUTS = [1, 2, 3, 4, 5, 6, 7].map((t) => ({ time: t, beat: null, kind: "beat" as const }));
const DURATION = 8;

const sl = (id: string, name: string, clips: PlanSource[]): PlanStoryline => ({ id, name, clips });
const ic = (storylines: PlanStoryline[], over: Partial<{ slotsPerSlice: number; endOfMaterial: "loop" | "retire" }> = {}) => ({
  slotsPerSlice: over.slotsPerSlice ?? 1,
  endOfMaterial: over.endOfMaterial ?? ("loop" as const),
  storylines,
});

const plan = (storylines: PlanStoryline[], sources: PlanSource[], s: Partial<MusicEditSettings> = {}, icfg = ic(storylines)) =>
  planEdit({
    beatTimes: [],
    bpm: 120,
    audioDuration: DURATION,
    sources,
    settings: settings(s),
    cutMarks: CUTS,
    intercut: icfg,
  });

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof MusicEditError, `expected MusicEditError, got ${e}`);
    return e.code;
  }
  assert.fail("expected an error");
};

describe("intercut — ordering & cursor continuity", () => {
  it("rotates storylines A B C D per slot with slotsPerSlice=1", () => {
    const p = plan(
      [sl("a", "A", [src("va", 30)]), sl("b", "B", [src("vb", 30)]), sl("c", "C", [src("vc", 30)]), sl("d", "D", [src("vd", 30)])],
      [src("va", 30), src("vb", 30), src("vc", 30), src("vd", 30)],
    );
    assert.deepEqual(p.entries.map((e) => e.storylineId), ["a", "b", "c", "d", "a", "b", "c", "d"]);
    assert.equal(p.intercut?.storylines.length, 4);
    assert.equal(p.intercut?.slotsPerSlice, 1);
  });

  it("A2 starts exactly where A1 ended in source time (cursor advances)", () => {
    const p = plan([sl("a", "A", [src("va", 30)]), sl("b", "B", [src("vb", 30)])], [src("va", 30), src("vb", 30)]);
    const aSegs = p.entries.filter((e) => e.storylineId === "a");
    for (let i = 1; i < aSegs.length; i++) {
      assert.ok(Math.abs(aSegs[i]!.sourceStart - aSegs[i - 1]!.sourceEnd) < 1e-6, `gap between A segments ${i - 1}→${i}`);
    }
    // and strictly increasing source position
    for (let i = 1; i < aSegs.length; i++) assert.ok(aSegs[i]!.sourceStart > aSegs[i - 1]!.sourceStart);
  });

  it("slotsPerSlice=2 makes each storyline hold two consecutive slots", () => {
    const p = plan(
      [sl("a", "A", [src("va", 30)]), sl("b", "B", [src("vb", 30)])],
      [src("va", 30), src("vb", 30)],
      {},
      ic([sl("a", "A", [src("va", 30)]), sl("b", "B", [src("vb", 30)])], { slotsPerSlice: 2 }),
    );
    assert.deepEqual(p.entries.map((e) => e.storylineId), ["a", "a", "b", "b", "a", "a", "b", "b"]);
    assert.equal(p.intercut?.slotsPerSlice, 2);
  });

  it("a multi-clip storyline plays clips in order, continuously", () => {
    // Storyline A = [c1(3s), c2(30s)] — after ~3 slots it must move to c2 at 0.
    const p = plan(
      [sl("a", "A", [src("c1", 3), src("c2", 30)]), sl("b", "B", [src("vb", 30)])],
      [src("c1", 3), src("c2", 30), src("vb", 30)],
    );
    const aSegs = p.entries.filter((e) => e.storylineId === "a");
    const c1Segs = aSegs.filter((e) => e.sourceId === "c1");
    const c2Segs = aSegs.filter((e) => e.sourceId === "c2");
    assert.ok(c1Segs.length >= 1 && c2Segs.length >= 1, "both clips used");
    assert.equal(c1Segs[0]!.sourceStart, 0);
    assert.equal(c2Segs[0]!.sourceStart, 0, "c2 starts at its own beginning");
    // every c2 segment after the first continues the cursor
    for (let i = 1; i < c2Segs.length; i++) {
      assert.ok(Math.abs(c2Segs[i]!.sourceStart - c2Segs[i - 1]!.sourceEnd) < 1e-6);
    }
  });
});

describe("intercut — end of material", () => {
  it("loop restarts the storyline and keeps the song covered", () => {
    // Storyline A has only 2 s of footage vs 8 s of slots → must loop.
    const p = plan(
      [sl("a", "A", [src("tiny", 2)]), sl("b", "B", [src("vb", 30)])],
      [src("tiny", 2), src("vb", 30)],
      {},
      ic([sl("a", "A", [src("tiny", 2)]), sl("b", "B", [src("vb", 30)])], { endOfMaterial: "loop" }),
    );
    const aSegs = p.entries.filter((e) => e.storylineId === "a");
    assert.ok(aSegs.length >= 3, `${aSegs.length} A segments`);
    assert.ok(aSegs.some((e) => (e.storylineLoop ?? 0) > 0), "storylineLoop recorded");
    // after a loop the source position returns to 0
    const looped = aSegs.find((e) => (e.storylineLoop ?? 0) > 0);
    assert.equal(looped!.sourceStart, 0);
    assert.equal(p.entries.at(-1)!.outputEnd, DURATION);
  });

  it("retire drops the exhausted storyline; others fill in", () => {
    const p = plan(
      [sl("a", "A", [src("tiny", 2)]), sl("b", "B", [src("vb", 30)]), sl("c", "C", [src("vc", 30)])],
      [src("tiny", 2), src("vb", 30), src("vc", 30)],
      {},
      ic([sl("a", "A", [src("tiny", 2)]), sl("b", "B", [src("vb", 30)]), sl("c", "C", [src("vc", 30)])], { endOfMaterial: "retire" }),
    );
    const ids = p.entries.map((e) => e.storylineId);
    const lastA = ids.lastIndexOf("a");
    assert.ok(lastA >= 0 && !ids.slice(lastA + 1).includes("a"), "A never returns after retiring");
    assert.ok(ids.includes("b") && ids.includes("c"), "B and C continue");
    assert.equal(p.entries.at(-1)!.outputEnd, DURATION);
  });

  it("all storylines retired → INSUFFICIENT_VIDEO_MATERIAL", () => {
    const p = () =>
      plan(
        [sl("a", "A", [src("tiny", 1)])],
        [src("tiny", 1)],
        {},
        ic([sl("a", "A", [src("tiny", 1)])], { endOfMaterial: "retire" }),
      );
    assert.equal(code(p), "INSUFFICIENT_VIDEO_MATERIAL");
  });
});

describe("intercut — clamps, edges & regression", () => {
  it("speeds stay within the retime clamp", () => {
    const p = plan(
      [sl("a", "A", [src("va", 30)]), sl("b", "B", [src("vb", 30)])],
      [src("va", 30), src("vb", 30)],
      { maxSpeedUp: 1.25, maxSlowDown: 0.8 },
    );
    for (const e of p.entries) {
      assert.ok(e.speed >= 0.8 - 1e-6 && e.speed <= 1.25 + 1e-6, `speed ${e.speed} out of clamp`);
    }
  });

  it("total duration equals the song and frames are contiguous", () => {
    const p = plan([sl("a", "A", [src("va", 30)]), sl("b", "B", [src("vb", 30)])], [src("va", 30), src("vb", 30)]);
    assert.equal(p.entries[0]!.frameStart, 0);
    assert.equal(p.entries.at(-1)!.frameEnd, p.totalFrames);
    for (let i = 1; i < p.entries.length; i++) assert.equal(p.entries[i]!.frameStart, p.entries[i - 1]!.frameEnd);
    assert.equal(p.entries.at(-1)!.outputEnd, DURATION);
    assert.equal(p.timing, "cut_grid"); // cutMarks path still reports grid timing
  });

  it("a storyline whose clips are all too short never fills — others cover", () => {
    const p = plan(
      [sl("starved", "S", [src("s1", 0.5), src("s2", 0.4)]), sl("b", "B", [src("vb", 30)])],
      [src("s1", 0.5), src("s2", 0.4), src("vb", 30)],
    );
    assert.ok(p.entries.every((e) => e.storylineId === "b"), "only B emitted");
    assert.equal(p.intercut?.storylines.find((s) => s.id === "starved")?.segments, 0);
  });

  it("a clip shorter than one slot is skipped to the next clip", () => {
    // c1 is 0.5 s < D*maxSlowDown (~0.8 s) → skipped entirely.
    const p = plan(
      [sl("a", "A", [src("c1", 0.5), src("c2", 30)])],
      [src("c1", 0.5), src("c2", 30)],
    );
    assert.ok(p.entries.every((e) => e.sourceId === "c2"), "c1 never used");
    assert.equal(p.entries[0]!.sourceStart, 0);
  });

  it("flat mode is untouched when intercut is absent", () => {
    const p = planEdit({
      beatTimes: [],
      bpm: 120,
      audioDuration: DURATION,
      sources: [src("a", 30), src("b", 30)],
      settings: settings({ beatsPerCut: 1 }),
      cutMarks: CUTS,
    });
    assert.equal(p.intercut, undefined);
    assert.ok(p.entries.every((e) => e.storylineId === undefined));
    assert.equal(p.entries.length, 8);
  });

  it("works with the detected-beats path too (no cutMarks)", () => {
    const beats = Array.from({ length: 16 }, (_, i) => 0.5 + i * 0.5);
    const p = planEdit({
      beatTimes: beats,
      bpm: 120,
      audioDuration: DURATION,
      sources: [src("va", 30), src("vb", 30)],
      settings: settings({ beatsPerCut: 1 }),
      intercut: ic([sl("a", "A", [src("va", 30)]), sl("b", "B", [src("vb", 30)])]),
    });
    assert.ok(p.entries.length > 4);
    assert.equal(p.timing, "detected_beats");
    assert.deepEqual(p.entries.slice(0, 4).map((e) => e.storylineId), ["a", "b", "a", "b"]);
  });
});

describe("intercut — request schema", () => {
  it("accepts intercut without top-level assetIds", () => {
    const parsed = musicEditPlanSchema.parse({
      song: "a.mp3",
      intercut: { storylines: [{ assetIds: ["v1"] }, { name: "B", assetIds: ["v2", "v3"] }] },
    });
    assert.equal(parsed.intercut?.storylines.length, 2);
    assert.equal(parsed.intercut?.slotsPerSlice, 1);
    assert.equal(parsed.intercut?.endOfMaterial, "loop");
    assert.equal(parsed.assetIds.length, 0);
  });

  it("still accepts the legacy flat request", () => {
    const parsed = musicEditPlanSchema.parse({ song: "a.mp3", assetIds: ["v1"] });
    assert.equal(parsed.intercut, undefined);
    assert.deepEqual(parsed.assetIds, ["v1"]);
  });

  it("rejects a request with neither sources nor storylines", () => {
    assert.throws(() => musicEditPlanSchema.parse({ song: "a.mp3" }));
    assert.throws(() => musicEditPlanSchema.parse({ song: "a.mp3", intercut: { storylines: [] } }));
  });
});
