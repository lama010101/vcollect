import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import {
  DEFAULT_PROJECT_ID,
  visualizerSessionPayloadSchema,
  vizVisualsLayer,
  type VisualizerSessionPayload,
} from "@twio/shared";

// Point OUTPUT_ROOT at a throwaway dir BEFORE importing server modules —
// config resolves OUTPUT_ROOT + the DB path from env at import time.
const OUT = mkdtempSync(join(tmpdir(), "twio-vizsess-"));
process.env.OUTPUT_DIR = OUT;

const { migrate } = await import("../src/db/migrate.ts");
const { db } = await import("../src/db/client.ts");
const { getAsset, getTimeline, insertLocalAsset, listShotsByTimeline, listTimelineCandidates } = await import("../src/db/repository.ts");
const { visualizerDir } = await import("../src/visualizer/service.ts");
const {
  deleteSession,
  getSession,
  listSessions,
  loadSession,
  saveSession,
  sessionToTimeline,
  updateSession,
} = await import("../src/visualizer/sessions.ts");
const { ffmpegService } = await import("../src/video/ffmpeg.ts");
const { assetAbsolutePath } = await import("../src/routes/folders.ts");

migrate();

const PID = DEFAULT_PROJECT_ID;
const stemsDir = () => visualizerDir(PID, "stems");

const payloadFor = (stems: string[], layers: Array<Record<string, unknown>> = []): VisualizerSessionPayload =>
  visualizerSessionPayloadSchema.parse({
    renderSettings: { width: 320, height: 240, fps: 30 },
    globalVisuals: { video: { layers: [vizVisualsLayer(), ...layers] } },
    stems: stems.map((name) => ({ name, muted: false, solo: false })),
  });

const writeStem = (name: string, bytes: string) => writeFileSync(join(stemsDir(), name), bytes);

/** Insert a 'local' asset row for an existing file (local_path is relative
 *  to OUTPUT_ROOT with forward slashes — same convention as assetSync). */
const insertLocalMedia = (id: string, filename: string, abs: string) => {
  insertLocalAsset({
    id,
    projectId: PID,
    providerAssetId: id,
    title: filename,
    providerUrl: "local://file",
    width: null,
    height: null,
    durationSeconds: null,
    fps: null,
    orientation: null,
    localPath: relative(OUT, abs).split(sep).join("/"),
    sha256: "0".repeat(64), // unused by session paths
    downloadedAt: new Date().toISOString(),
  });
};

/** Encode a real (tiny) playable mp4 via the resolved ffmpeg binary. */
const makeMp4 = async (abs: string): Promise<void> => {
  mkdirSync(dirname(abs), { recursive: true });
  const r = await ffmpegService.ffmpegExec(
    ["-y", "-f", "lavfi", "-i", "testsrc=duration=0.5:size=160x120:rate=10", "-pix_fmt", "yuv420p", abs],
    "vizsess-test",
  );
  assert.equal(r.exitCode, 0, r.stderr.slice(-400));
};

describe("visualizer sessions — save / list / get", () => {
  it("snapshots stems + payload and lists them as metadata", async () => {
    writeStem("bass.wav", "fake-audio-A");
    writeStem("drums.wav", "fake-audio-B");
    const s = await saveSession(PID, "Verse A", payloadFor(["bass.wav", "drums.wav"]));
    assert.equal(s.name, "Verse A");
    assert.deepEqual(s.stems.sort(), ["bass.wav", "drums.wav"]);
    assert.equal(s.mediaLayers, 0);
    // Stem bytes were copied into the session dir.
    assert.equal(readFileSync(join(visualizerDir(PID, "sessions"), s.id, "stems", "bass.wav"), "utf8"), "fake-audio-A");

    const list = listSessions(PID);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, s.id);

    const got = getSession(PID, s.id);
    assert.equal(got.payload.renderSettings.width, 320);
    assert.equal(got.payload.stems.length, 2);
    assert.equal(got.payload.globalVisuals.mode, "ribbons");
  });

  it("rejects a save whose stem file is not uploaded", async () => {
    await assert.rejects(
      () => saveSession(PID, "Bad", payloadFor(["nope.wav"])),
      (e: unknown) => (e as { code?: string }).code === "STEM_NOT_FOUND",
    );
  });
});

describe("visualizer sessions — load restores media", () => {
  it("restores a deleted stem and the session's bytes when content differs", async () => {
    writeStem("keep.wav", "original-bytes");
    const s = await saveSession(PID, "Round trip", payloadFor(["keep.wav"]));

    // Pool file deleted → restored on load.
    rmSync(join(stemsDir(), "keep.wav"));
    let r = await loadSession(PID, s.id);
    assert.equal(readFileSync(join(stemsDir(), "keep.wav"), "utf8"), "original-bytes");
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.payload.stems.map((x) => x.name), ["keep.wav"]);

    // Pool file overwritten → the session's version wins.
    writeFileSync(join(stemsDir(), "keep.wav"), "changed-bytes");
    r = await loadSession(PID, s.id);
    assert.equal(readFileSync(join(stemsDir(), "keep.wav"), "utf8"), "original-bytes");
  });

  it("keeps live layer assets untouched and re-registers deleted ones", async () => {
    // A real playable mp4 so syncProjectAssets accepts the restored file.
    const mp4 = join(OUT, DEFAULT_PROJECT_ID, "assets", "uploads", "clip.mp4");
    await makeMp4(mp4);
    await insertLocalMedia("MEDIA_A", "clip.mp4", mp4);
    writeStem("vox.wav", "voice");

    const payload = payloadFor(["vox.wav"], [{ kind: "media", assetId: "MEDIA_A" }]);
    const s = await saveSession(PID, "With media", payload);
    assert.equal(s.mediaLayers, 1);

    // Asset row + file still live → nothing to do.
    let r = await loadSession(PID, s.id);
    assert.equal(r.restoredMedia, 0);
    const liveLayer = r.payload.globalVisuals.video.layers.find((l) => l.kind === "media");
    assert.equal(liveLayer && liveLayer.kind === "media" ? liveLayer.assetId : null, "MEDIA_A");

    // Delete the row AND the file → load must restore + re-register it.
    db.prepare("DELETE FROM assets WHERE id = ?").run("MEDIA_A");
    rmSync(mp4);
    assert.equal(getAsset("MEDIA_A"), undefined);
    r = await loadSession(PID, s.id);
    const layer = r.payload.globalVisuals.video.layers.find((l) => l.kind === "media");
    assert.ok(layer && layer.kind === "media");
    assert.equal(r.restoredMedia, 1);
    const newId = layer.assetId;
    assert.ok(newId.startsWith(`LOCAL_${PID}_`), `expected content-addressed id, got ${newId}`);
    const restored = getAsset(newId);
    assert.ok(restored?.local_path, "re-registered asset has a local_path");
    assert.ok(existsSync(assetAbsolutePath(restored.local_path!, "")), "restored file exists on disk");

    // Second load is stable — the re-registered asset now resolves directly.
    r = await loadSession(PID, s.id);
    const layer2 = r.payload.globalVisuals.video.layers.find((l) => l.kind === "media");
    assert.ok(layer2 && layer2.kind === "media");
    assert.equal(layer2.assetId, newId);
    db.prepare("DELETE FROM assets WHERE id = ?").run(newId);
  });

  it("warns when a layer asset is gone and the session has no copy", async () => {
    const payload = payloadFor([], [{ kind: "media", assetId: "GHOST_ASSET" }]);
    const s = await saveSession(PID, "Ghost", payload);
    const r = await loadSession(PID, s.id);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0]!, /no longer available/);
    // The layer row itself is kept so the user can replace it.
    assert.equal(r.payload.globalVisuals.video.layers.filter((l) => l.kind === "media").length, 1);
  });
});

describe("visualizer sessions — manage", () => {
  it("renames a session and overwrites its payload", async () => {
    writeStem("a.wav", "a1");
    const s = await saveSession(PID, "Old name", payloadFor(["a.wav"]));
    const renamed = await updateSession(PID, s.id, { name: "New name" });
    assert.equal(renamed.name, "New name");
    assert.equal(getSession(PID, s.id).name, "New name");
    // createdAt survives a rename + overwrite.
    assert.equal(renamed.createdAt, s.createdAt);

    writeStem("b.wav", "b1");
    const overwritten = await updateSession(PID, s.id, { payload: payloadFor(["a.wav", "b.wav"]) });
    assert.deepEqual(overwritten.stems.sort(), ["a.wav", "b.wav"]);
    assert.equal(overwritten.createdAt, s.createdAt);
    // Re-snapshot replaced the stems dir: "b.wav" is now stored too.
    assert.ok(existsSync(join(visualizerDir(PID, "sessions"), s.id, "stems", "b.wav")));
  });

  it("deletes a session dir and 404s afterwards", async () => {
    const s = await saveSession(PID, "Doomed", payloadFor([]));
    const dir = join(visualizerDir(PID, "sessions"), s.id);
    assert.ok(existsSync(dir));
    deleteSession(PID, s.id);
    assert.ok(!existsSync(dir));
    assert.throws(() => getSession(PID, s.id), (e: unknown) => (e as { code?: string }).code === "SESSION_NOT_FOUND");
  });

  it("rejects path-y session ids", async () => {
    assert.throws(() => getSession(PID, "../escape"), (e: unknown) => (e as { code?: string }).code === "INVALID_SESSION_ID");
  });
});

describe("visualizer sessions — session → timeline", () => {
  it("builds a timeline with one shot per layer (top first) + one per stem", async () => {
    // A REAL wav so probeAudio can measure the stem/mix length.
    const wav = join(stemsDir(), "song.wav");
    const r0 = await ffmpegService.ffmpegExec(
      ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.2", "-ac", "1", "-ar", "48000", wav],
      "vizsess-tl-test",
    );
    assert.equal(r0.exitCode, 0, r0.stderr.slice(-400));

    const mp4 = join(OUT, DEFAULT_PROJECT_ID, "assets", "uploads", "bg.mp4");
    await makeMp4(mp4);
    await insertLocalMedia("TL_MEDIA", "bg.mp4", mp4);

    const payload = visualizerSessionPayloadSchema.parse({
      renderSettings: { width: 320, height: 240, fps: 30 },
      globalVisuals: {
        mode: "ribbons",
        video: {
          layers: [
            { kind: "visuals" },                              // bottom — inherits 2. Look
            { kind: "media", assetId: "TL_MEDIA" },
            { kind: "visuals", visuals: { mode: "eqradial" } }, // top — own settings
          ],
        },
      },
      stems: [{ name: "song.wav", kind: "drums", muted: false, solo: false }],
    });
    const s = await saveSession(PID, "Timeline test", payload);

    const r = await sessionToTimeline(PID, s.id);
    assert.equal(r.name, "Viz — Timeline test");
    assert.equal(r.shotsCreated, 4);
    assert.ok(getTimeline(r.timelineId), "timeline row created");
    assert.ok(Math.abs(r.durationSeconds - 1.2) < 0.1, `mix duration ≈ 1.2 s, got ${r.durationSeconds}`);

    const shots = listShotsByTimeline(r.timelineId, PID);
    assert.equal(shots.length, 4);
    // Top layer first: eqradial visuals → media → inherited visuals → stem.
    assert.match(shots[0]!.visual_description, /eqradial/);
    assert.match(shots[0]!.visual_description, /own settings/);
    assert.match(shots[1]!.visual_description, /Media — bg\.mp4/);
    assert.match(shots[2]!.visual_description, /ribbons/);
    assert.match(shots[2]!.visual_description, /2\. Look/);
    assert.equal(shots[3]!.section, "STEMS");
    assert.match(shots[3]!.visual_description, /Stem — song\.wav \(drums\)/);
    for (const sh of shots) {
      assert.equal(sh.time_start_seconds, 0);
      assert.ok(Math.abs((sh.time_end_seconds ?? 0) - 1.2) < 0.1, `shot spans the mix, got ${sh.time_end_seconds}`);
    }

    // The media shot's rail holds its own layer asset — selected + on_rail.
    const linked = listTimelineCandidates(r.timelineId);
    assert.equal(linked.length, 1);
    assert.equal(linked[0]!.link_shot_id, shots[1]!.id);
    assert.equal(linked[0]!.id, "TL_MEDIA");
    assert.equal(linked[0]!.link_selected, 1);
    assert.equal(linked[0]!.link_on_rail, 1);
    // So the shot's segment shows the clip's frame.
    assert.match(shots[1]!.reference_image_url ?? "", /\/api\/assets\/TL_MEDIA\/thumb/);
  });
});
