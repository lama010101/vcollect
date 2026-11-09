import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeFilename, uniqueDest, VIDEO_EXTENSIONS, IMAGE_EXTENSIONS, AUDIO_EXTENSIONS, mediaKindForExt } from "../src/routes/uploads.ts";

describe("uploads — sanitizeFilename", () => {
  it("keeps a normal filename unchanged", () => {
    assert.equal(sanitizeFilename("clip one.mp4"), "clip one.mp4");
  });

  it("strips directory traversal", () => {
    assert.equal(sanitizeFilename("../../etc/evil.mp4"), "evil.mp4");
    assert.equal(sanitizeFilename("..\\..\\evil.mp4"), "evil.mp4");
    assert.equal(sanitizeFilename("a/b/c.mp4"), "c.mp4");
  });

  it("replaces filesystem-unsafe characters", () => {
    assert.equal(sanitizeFilename('a<b>:"|?*.mp4'), "a_b______.mp4");
  });

  it("strips control characters but keeps unicode", () => {
    assert.equal(sanitizeFilename("видео файл.mp4"), "видео файл.mp4");
    assert.equal(sanitizeFilename(`a${String.fromCharCode(1)}b.mp4`), "a_b.mp4");
  });

  it("strips leading dots (no dotfiles)", () => {
    assert.equal(sanitizeFilename("...hidden.mp4"), "hidden.mp4");
  });
});

describe("uploads — uniqueDest", () => {
  it("appends _1, _2, … until the name is free", () => {
    const dir = mkdtempSync(join(tmpdir(), "twio-uploads-"));
    try {
      writeFileSync(join(dir, "a.mp4"), "x");
      writeFileSync(join(dir, "a_1.mp4"), "x");
      assert.equal(uniqueDest(dir, "a.mp4"), join(dir, "a_2.mp4"));
      assert.equal(uniqueDest(dir, "b.mp4"), join(dir, "b_1.mp4"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("uploads — VIDEO_EXTENSIONS", () => {
  it("covers common containers", () => {
    for (const ext of [".mp4", ".mov", ".webm", ".mkv"]) {
      assert.ok(VIDEO_EXTENSIONS.has(ext), ext);
    }
    assert.ok(!VIDEO_EXTENSIONS.has(".exe"));
    assert.ok(!VIDEO_EXTENSIONS.has(".txt"));
  });
});

describe("uploads — IMAGE_EXTENSIONS", () => {
  it("covers common image formats", () => {
    for (const ext of [".jpg", ".jpeg", ".png", ".webp", ".gif"]) {
      assert.ok(IMAGE_EXTENSIONS.has(ext), ext);
    }
    assert.ok(!IMAGE_EXTENSIONS.has(".mp4"));
    assert.ok(!IMAGE_EXTENSIONS.has(".txt"));
  });
});

describe("uploads — AUDIO_EXTENSIONS", () => {
  it("covers the song/stem pool formats", () => {
    for (const ext of [".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".oga", ".opus"]) {
      assert.ok(AUDIO_EXTENSIONS.has(ext), ext);
    }
    assert.ok(!AUDIO_EXTENSIONS.has(".mp4"));
    assert.ok(!AUDIO_EXTENSIONS.has(".txt"));
  });
});

describe("uploads — mediaKindForExt", () => {
  it("classifies videos, images and audio, case-insensitive", () => {
    assert.equal(mediaKindForExt(".mp4"), "video");
    assert.equal(mediaKindForExt(".PNG"), "image");
    assert.equal(mediaKindForExt(".jpeg"), "image");
    assert.equal(mediaKindForExt(".mp3"), "audio");
    assert.equal(mediaKindForExt(".WAV"), "audio");
    assert.equal(mediaKindForExt(".flac"), "audio");
    assert.equal(mediaKindForExt(".exe"), null);
    assert.equal(mediaKindForExt(""), null);
  });
});
