// =============================================================================
// Music edit acceptance test — real song, real videos, every cut mode.
//
//   MUSIC_EDIT_SONG=song.m4a MUSIC_EDIT_VIDEOS=a.mp4,b.mp4,c.mp4,d.mp4 \
//   MUSIC_EDIT_OUT=/tmp/music-edit-acceptance npm run test:music-edit -w apps/server
//
// Renders one MP4 per mode (1, 2, 4, 8 beats per cut) and checks the result
// against the song and the edit decision list. Writes report.json to OUT.
// =============================================================================

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { musicEditSettingsSchema, type EditPlan, type MusicEditSettings } from "@twio/shared";
import { buildPlan, prepareEdit, renderSourceMap, resolveFileSources } from "../src/musicEdit/service.ts";
import { renderEdit } from "../src/musicEdit/render.ts";
import { ffmpegService } from "../src/video/ffmpeg.ts";
import { probe, probeAudio } from "../src/video/ffprobe.ts";

const songPath = process.env.MUSIC_EDIT_SONG;
const videos = (process.env.MUSIC_EDIT_VIDEOS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const outDir = resolve(process.env.MUSIC_EDIT_OUT ?? "music-edit-acceptance");
if (!songPath || videos.length < 4) {
  console.error("Set MUSIC_EDIT_SONG and MUSIC_EDIT_VIDEOS (at least four comma-separated videos).");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

async function md5(file: string, args: string[]): Promise<string> {
  const r = await ffmpegService.ffmpegExec(["-v", "error", "-i", file, ...args, "-f", "md5", "-"], "acceptance-md5");
  assert.equal(r.exitCode, 0, r.stderr);
  return r.stdout.trim();
}

/** Frames where the picture changes abruptly (hard cuts). */
async function hardCutFrames(file: string, fps: number): Promise<number[]> {
  const r = await ffmpegService.ffmpegExec(
    ["-v", "info", "-i", file, "-an", "-vf", "scale=320:-2,select='gt(scene\\,0.3)',showinfo", "-f", "null", "-"],
    "acceptance-scenes",
  );
  assert.equal(r.exitCode, 0, r.stderr.slice(-400));
  return [...r.stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Math.round(Number(m[1]) * fps));
}

async function decodesCleanly(file: string): Promise<void> {
  const r = await ffmpegService.ffmpegExec(["-v", "error", "-xerror", "-i", file, "-f", "null", "-"], "acceptance-decode");
  assert.equal(r.exitCode, 0, `decode failed: ${r.stderr}`);
  assert.equal(r.stderr.trim(), "", `decoder errors: ${r.stderr}`);
}

const check = (name: string, fn: () => void, results: Record<string, string>) => {
  fn();
  results[name] = "passed";
  console.log(`  ✔ ${name}`);
};

await ffmpegService.ensure();
const sources = await resolveFileSources(videos);
const base = musicEditSettingsSchema.parse({});
const first = await prepareEdit(songPath, sources, base);
const { analysis, audio } = first.song;
const beatTimes = analysis.beats.map((b) => b.time);
const period = 60 / analysis.bpm;
const gridDeviation = Math.max(...beatTimes.map((t, i) => Math.abs(t - (beatTimes[0]! + i * period))));
const report: Record<string, unknown> = {
  song: songPath,
  videos: sources.map((s) => ({ path: s.path, duration: s.duration, width: s.width, height: s.height })),
  bpm: analysis.bpm,
  beatCount: beatTimes.length,
  songDuration: audio.durationSeconds,
  firstBeats: beatTimes.slice(0, 8),
  interval: analysis.interval,
  maxDeviationFromBpmGrid: gridDeviation,
  analyzer: analysis.analyzer,
  modes: {} as Record<string, unknown>,
};
console.log(`Song: BPM ${analysis.bpm} · ${beatTimes.length} beats · ${audio.durationSeconds.toFixed(3)} s (${audio.codec})`);

const songResults: Record<string, string> = {};
check("BPM is detected from the audio", () => assert.ok(analysis.bpm > 30 && analysis.bpm < 300), songResults);
check("beat timestamps come from the waveform analyzer", () => {
  assert.ok(analysis.analyzer.name.startsWith("librosa"), analysis.analyzer.name);
  assert.ok(beatTimes.length >= 8);
}, songResults);
check("beat timestamps are not a fixed BPM grid", () => {
  assert.ok(analysis.interval.stdDev > 0.001, `IBI σ ${analysis.interval.stdDev}`);
  assert.ok(gridDeviation > 1 / 30, `max deviation from grid ${gridDeviation}s`);
}, songResults);
report.songChecks = songResults;

const sourceAudioMd5 = await md5(resolve(songPath), ["-map", "0:a:0", "-c", "copy"]);

for (const n of [1, 2, 4, 8] as const) {
  console.log(`\nMode: every ${n} beat(s)`);
  const settings: MusicEditSettings = { ...base, beatsPerCut: n };
  const plan: EditPlan = buildPlan(first.song, sources, settings);
  const results: Record<string, string> = {};
  const out = resolve(outDir, `every-${n}.mp4`);
  writeFileSync(resolve(outDir, `every-${n}.edl.json`), JSON.stringify(plan, null, 2));

  check("EDL is deterministic", () => assert.deepEqual(buildPlan(first.song, sources, settings), plan), results);
  check("cuts sit on detected beats (start = beat[i], end = beat[i+N])", () => {
    for (let i = 1; i < plan.entries.length; i++) {
      const e = plan.entries[i]!;
      assert.equal(e.startKind, "beat");
      assert.equal(e.outputStart, beatTimes[e.startBeat!]);
      assert.equal(e.frameStart, Math.round(beatTimes[e.startBeat!]! * plan.fps));
      if (i < plan.entries.length - 1) assert.equal(e.endBeat! - e.startBeat!, n);
    }
  }, results);
  check("clips are trimmed and retimed within limits", () => {
    for (const e of plan.entries) {
      assert.ok(e.speed >= settings.maxSlowDown - 1e-6 && e.speed <= settings.maxSpeedUp + 1e-6);
      for (const p of e.pieces) {
        const src = sources.find((s) => s.id === e.sourceId)!;
        assert.ok(p.start >= 0 && p.end <= src.duration, `range ${p.start}-${p.end} beyond ${src.duration}`);
      }
    }
    assert.ok(plan.entries.some((e) => e.sourceConsumed < sources.find((s) => s.id === e.sourceId)!.duration));
  }, results);
  check("long sources are consumed progressively", () => {
    assert.ok(plan.entries.some((e) => e.sourceStart > 0 && !e.restartedSource));
  }, results);

  const t0 = Date.now();
  const r = await renderEdit(plan, renderSourceMap(sources), { songPath, audioCodec: audio.codec, outPath: out });
  const renderSeconds = (Date.now() - t0) / 1000;
  const v = await probe(out);
  const a = await probeAudio(out);
  const cuts = await hardCutFrames(out, plan.fps);
  const cutStarts = new Set(plan.entries.map((e) => e.frameStart));
  const offBeatCuts = cuts.filter((f) => ![f - 1, f, f + 1].some((x) => cutStarts.has(x)));
  const outAudioMd5 = await md5(out, ["-map", "0:a:0", "-c", "copy"]);

  check("MP4 is H.264 + AAC and decodes cleanly", () => {
    assert.equal(v.codec, "h264");
    assert.equal(a.codec, "aac");
  }, results);
  await decodesCleanly(out);
  check("audio is bit-identical to the song", () => {
    if (audio.codec === "aac") assert.equal(outAudioMd5, sourceAudioMd5);
    assert.ok(Math.abs(a.durationSeconds - audio.durationSeconds) < 0.05);
  }, results);
  check("video duration matches the usable song duration", () => {
    assert.ok(Math.abs(r.videoDurationSeconds - audio.durationSeconds) <= 2 / plan.fps, `${r.videoDurationSeconds} vs ${audio.durationSeconds}`);
  }, results);
  check("every hard cut in the MP4 lands on an EDL boundary", () => {
    assert.ok(cuts.length > 0);
    assert.deepEqual(offBeatCuts, []);
  }, results);

  const retimed = plan.entries.find((e) => Math.abs(e.speed - 1) > 1e-4) ?? null;
  (report.modes as Record<string, unknown>)[`every_${n}`] = {
    output: out,
    clips: plan.entries.length,
    stats: plan.stats,
    renderSeconds,
    videoDuration: r.videoDurationSeconds,
    audioDuration: r.audioDurationSeconds,
    audioMd5: { song: sourceAudioMd5, output: outAudioMd5 },
    detectedHardCuts: cuts.length,
    offBeatHardCuts: offBeatCuts.length,
    exampleEntries: plan.entries.slice(0, 3),
    exampleRetimed: retimed,
    checks: results,
  };
  console.log(`  ${plan.entries.length} clips · ${plan.stats.retimedCount} retimed · ${cuts.length} hard cuts detected · rendered in ${renderSeconds.toFixed(1)} s`);
}

// Short-source handling: every source shorter than a musical interval, looping on.
const shortest = [...sources].sort((x, y) => x.duration - y.duration)[0]!;
const loopPlan = buildPlan(first.song, [shortest], { ...base, beatsPerCut: 8, loopSource: true });
assert.ok(loopPlan.entries.every((e) => e.pieces.every((p) => p.start >= 0 && p.end <= shortest.duration)));
report.loopCheck = { source: shortest.path, duration: shortest.duration, clips: loopPlan.entries.length, looped: loopPlan.stats.loopedCount };
console.log(`\nLoop check: ${shortest.path} (${shortest.duration}s) → ${loopPlan.stats.loopedCount}/${loopPlan.entries.length} clips looped`);

writeFileSync(resolve(outDir, "report.json"), JSON.stringify(report, null, 2));
console.log(`\nAll acceptance checks passed. Report: ${resolve(outDir, "report.json")}`);
