import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { DEFAULT_PROJECT_ID } from "@twio/shared";

// Point OUTPUT_ROOT at a throwaway dir BEFORE importing server modules —
// config resolves OUTPUT_ROOT + the DB path from env at import time, so these
// tests never touch the real dev DB (output/database/footage.db).
const OUT = mkdtempSync(join(tmpdir(), "twio-libfolders-"));
process.env.OUTPUT_DIR = OUT;

const { migrate } = await import("../src/db/migrate.ts");
const { getAsset, insertLocalAsset, searchAssetsAdvanced } = await import("../src/db/repository.ts");
const { listAssetFolders, moveAssetToFolder, sanitizeAssetFolder } = await import("../src/db/assetSync.ts");
const { saveUploadedFile } = await import("../src/routes/uploads.ts");
const { projectPaths } = await import("../src/config.ts");

migrate();

const SLUG = DEFAULT_PROJECT_ID; // seeded project's slug equals its id
const ASSETS = projectPaths(SLUG).assets;
const PID = DEFAULT_PROJECT_ID;

// On-disk layout the tests share: uploads/ (flat + nested), my_clips/ vs
// myxclips/ (LIKE-escape regression), empty_dir/ (user-made, no media yet).
for (const [rel, files] of Object.entries({
  "uploads": ["a.mp4"],
  "uploads/nature": ["b.mp4", "c.jpg"],
  "uploads/nature/birds": ["d.mp4"],
  "uploads/other": ["e.mp4"],
  "my_clips": ["f.mp4"],
  "myxclips": ["g.mp4"],
  "empty_dir": [],
  "empty_dir/nested_empty": [],
})) {
  const dir = join(ASSETS, rel);
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(join(dir, f), "x");
}

// DB rows mirroring the disk files (insertLocalAsset only writes the row —
// no disk check — so the tests can insert under arbitrary subfolders).
function insertAsset(id: string, relSubdir: string) {
  insertLocalAsset({
    id,
    projectId: PID,
    providerAssetId: id,
    title: `${id}.mp4`,
    providerUrl: "local://test",
    width: null,
    height: null,
    durationSeconds: null,
    fps: null,
    orientation: null,
    localPath: `${SLUG}/assets/${relSubdir}/${id}.mp4`,
    sha256: `sha_${id}`,
    downloadedAt: "2026-01-01T00:00:00.000Z",
  });
}
for (const [id, dir] of Object.entries({
  T_A: "uploads",
  T_B: "uploads/nature",
  T_C: "uploads/nature/birds",
  T_D: "uploads/other",
  T_E: "my_clips",
  T_F: "myxclips",
})) insertAsset(id, dir);
// A row with no local file — must never match a folder filter.
insertLocalAsset({
  id: "T_MISSING",
  projectId: PID,
  providerAssetId: "T_MISSING",
  title: "gone.mp4",
  providerUrl: "local://test",
  width: null,
  height: null,
  durationSeconds: null,
  fps: null,
  orientation: null,
  localPath: `${SLUG}/assets/uploads/gone.mp4`,
  sha256: "sha_missing",
  downloadedAt: "2026-01-01T00:00:00.000Z",
});
const { db } = await import("../src/db/client.ts");
db.prepare(`UPDATE assets SET local_path = NULL WHERE id = 'T_MISSING'`).run();
// An image row (local_path .png) and a file-less row whose TITLE is the only
// type signal (mediaType falls back to title, like the client does).
insertLocalAsset({
  id: "T_IMG", projectId: PID, providerAssetId: "T_IMG", title: "photo.png",
  providerUrl: "local://test", width: null, height: null, durationSeconds: null,
  fps: null, orientation: null, localPath: `${SLUG}/assets/uploads/photo.png`,
  sha256: "sha_img", downloadedAt: "2026-01-01T00:00:00.000Z",
});
insertLocalAsset({
  id: "T_TIT", projectId: PID, providerAssetId: "T_TIT", title: "still.png",
  providerUrl: "local://test", width: null, height: null, durationSeconds: null,
  fps: null, orientation: null, localPath: `${SLUG}/assets/uploads/tit.mp4`,
  sha256: "sha_tit", downloadedAt: "2026-01-01T00:00:00.000Z",
});
db.prepare(`UPDATE assets SET local_path = NULL WHERE id = 'T_TIT'`).run();

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();

describe("searchAssetsAdvanced — folder filter", () => {
  it("matches the whole subtree, not just direct children", () => {
    const rows = searchAssetsAdvanced({ folder: "uploads" }, PID);
    assert.deepEqual(ids(rows), ["T_A", "T_B", "T_C", "T_D", "T_IMG"]);
  });

  it("narrows to a nested folder", () => {
    assert.deepEqual(ids(searchAssetsAdvanced({ folder: "uploads/nature" }, PID)), ["T_B", "T_C"]);
    assert.deepEqual(ids(searchAssetsAdvanced({ folder: "uploads/nature/birds" }, PID)), ["T_C"]);
    assert.deepEqual(ids(searchAssetsAdvanced({ folder: "uploads/other" }, PID)), ["T_D"]);
  });

  it("does not let LIKE metacharacters in folder names over-match", () => {
    // "my_clips" must not match "myxclips" (the '_' wildcard bug).
    assert.deepEqual(ids(searchAssetsAdvanced({ folder: "my_clips" }, PID)), ["T_E"]);
  });

  it("normalizes backslashes and stray slashes in the folder param", () => {
    assert.deepEqual(ids(searchAssetsAdvanced({ folder: "uploads\\nature" }, PID)), ["T_B", "T_C"]);
    assert.deepEqual(ids(searchAssetsAdvanced({ folder: "/uploads/nature/" }, PID)), ["T_B", "T_C"]);
  });

  it("returns nothing for a folder that does not exist, and never matches undownloaded rows", () => {
    assert.deepEqual(ids(searchAssetsAdvanced({ folder: "nope" }, PID)), []);
    // T_MISSING has local_path NULL — even a folder it "should" be in must not match.
    const all = searchAssetsAdvanced({ folder: "uploads" }, PID);
    assert.ok(!all.some((r) => r.id === "T_MISSING"));
  });

  it("empty folder param = no folder filter", () => {
    const rows = searchAssetsAdvanced({ folder: "", downloadedOnly: true }, PID);
    assert.deepEqual(ids(rows), ["T_A", "T_B", "T_C", "T_D", "T_E", "T_F", "T_IMG"]);
  });
});

describe("searchAssetsAdvanced — mediaType filter", () => {
  it("image matches by local_path extension", () => {
    const imgs = ids(searchAssetsAdvanced({ mediaType: "image", downloadedOnly: true }, PID));
    assert.deepEqual(imgs, ["T_IMG"]);
    const vids = ids(searchAssetsAdvanced({ mediaType: "video", downloadedOnly: true }, PID));
    assert.deepEqual(vids, ["T_A", "T_B", "T_C", "T_D", "T_E", "T_F"]);
  });

  it("falls back to title when there's no local file", () => {
    const imgs = ids(searchAssetsAdvanced({ mediaType: "image" }, PID));
    assert.ok(imgs.includes("T_TIT")); // local_path NULL, title still.png
    const vids = ids(searchAssetsAdvanced({ mediaType: "video" }, PID));
    assert.ok(!vids.includes("T_IMG"));
    assert.ok(!vids.includes("T_TIT"));
  });

  it("combines with the folder filter", () => {
    // T_TIT's local_path is NULL → LIKE matches nothing → only T_IMG remains.
    const imgs = ids(searchAssetsAdvanced({ mediaType: "image", folder: "uploads" }, PID));
    assert.deepEqual(imgs, ["T_IMG"]);
  });
});

describe("listAssetFolders", () => {
  it("returns every directory DFS-flattened, parents before children", () => {
    const { folders } = listAssetFolders(PID);
    const paths = folders.map((f) => f.path);
    assert.equal(paths[0], "");
    // Every parent appears before its children.
    const pos = new Map(folders.map((f, i) => [f.path, i] as const));
    for (const f of folders) {
      if (!f.path) continue;
      const parent = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
      const parentIdx = pos.get(parent);
      assert.ok(parentIdx != null && parentIdx < pos.get(f.path)!, `${f.path} after parent`);
    }
    // Expected folders exist with the right names/depths.
    const byPath = new Map(folders.map((f) => [f.path, f] as const));
    assert.equal(byPath.get("uploads")?.depth, 1);
    assert.equal(byPath.get("uploads/nature")?.name, "nature");
    assert.equal(byPath.get("uploads/nature/birds")?.depth, 3);
    assert.ok(byPath.has("empty_dir"), "user-made empty folder listed");
    assert.ok(byPath.has("empty_dir/nested_empty"), "nested empty folder listed");
  });

  it("counts direct vs subtree media files", () => {
    const { folders } = listAssetFolders(PID);
    const byPath = new Map(folders.map((f) => [f.path, f] as const));
    assert.equal(byPath.get("")?.fileCount, 0);
    assert.equal(byPath.get("uploads")?.fileCount, 1); // a.mp4 only
    assert.equal(byPath.get("uploads")?.subtreeCount, 5); // a..e
    assert.equal(byPath.get("uploads/nature")?.fileCount, 2); // b.mp4 + c.jpg
    assert.equal(byPath.get("uploads/nature")?.subtreeCount, 3); // + d.mp4
    assert.equal(byPath.get("empty_dir")?.subtreeCount, 0);
    assert.equal(byPath.get("")?.subtreeCount, 7); // everything
  });
});

describe("sanitizeAssetFolder", () => {
  it("accepts simple and nested relative paths", () => {
    assert.equal(sanitizeAssetFolder("uploads"), "uploads");
    assert.equal(sanitizeAssetFolder("uploads/nature/birds"), "uploads/nature/birds");
    assert.equal(sanitizeAssetFolder("uploads\\nature"), "uploads/nature");
    assert.equal(sanitizeAssetFolder("/uploads/"), "uploads");
    assert.equal(sanitizeAssetFolder(""), "");
  });

  it("rejects traversal and absolute paths", () => {
    assert.equal(sanitizeAssetFolder(".."), null);
    assert.equal(sanitizeAssetFolder("uploads/../secrets"), null);
    assert.equal(sanitizeAssetFolder("uploads//nature"), null);
    assert.equal(sanitizeAssetFolder("C:/Windows"), null);
    assert.equal(sanitizeAssetFolder(null), null);
    assert.equal(sanitizeAssetFolder(undefined), null);
  });
});

describe("moveAssetToFolder", () => {
  function makeMovable(id: string, subdir: string, filename: string) {
    const dir = join(ASSETS, subdir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), "payload");
    insertLocalAsset({
      id,
      projectId: PID,
      providerAssetId: id,
      title: filename,
      providerUrl: "local://test",
      width: null, height: null, durationSeconds: null, fps: null, orientation: null,
      localPath: `${SLUG}/assets/${subdir}/${filename}`,
      sha256: `sha_${id}`,
      downloadedAt: "2026-01-01T00:00:00.000Z",
    });
  }

  it("moves the file on disk and repoints local_path", () => {
    makeMovable("T_MV1", "uploads", "mv1.mp4");
    const r = moveAssetToFolder("T_MV1", "uploads/nature");
    assert.equal(r.localPath, `${SLUG}/assets/uploads/nature/mv1.mp4`);
    assert.equal(getAsset("T_MV1")?.local_path, r.localPath);
    assert.ok(existsSync(join(ASSETS, "uploads/nature/mv1.mp4")));
    assert.ok(!existsSync(join(ASSETS, "uploads/mv1.mp4")));
  });

  it("moves to the assets root on empty folder and no-ops inside the same folder", () => {
    makeMovable("T_MV2", "uploads/nature", "mv2.mp4");
    const root = moveAssetToFolder("T_MV2", "");
    assert.equal(root.localPath, `${SLUG}/assets/mv2.mp4`);
    assert.ok(existsSync(join(ASSETS, "mv2.mp4")));
    const again = moveAssetToFolder("T_MV2", "");
    assert.equal(again.localPath, `${SLUG}/assets/mv2.mp4`);
  });

  it("suffixes the filename on collision instead of overwriting", () => {
    makeMovable("T_MV3", "uploads", "dup.mp4");
    writeFileSync(join(ASSETS, "uploads/nature/dup.mp4"), "other");
    const r = moveAssetToFolder("T_MV3", "uploads/nature");
    assert.equal(r.localPath, `${SLUG}/assets/uploads/nature/dup_1.mp4`);
    assert.ok(existsSync(join(ASSETS, "uploads/nature/dup_1.mp4")));
  });

  it("rejects traversal, missing files and missing assets", () => {
    makeMovable("T_MV4", "uploads", "mv4.mp4");
    assert.throws(() => moveAssetToFolder("T_MV4", "../escape"), /invalid folder/);
    assert.throws(() => moveAssetToFolder("NOPE", "uploads"), /asset not found/);
    makeMovable("T_MV5", "uploads", "mv5.mp4");
    rmSync(join(ASSETS, "uploads/mv5.mp4"));
    assert.throws(() => moveAssetToFolder("T_MV5", "uploads/nature"), /missing on disk/);
  });
});

describe("saveUploadedFile — folder targeting", () => {
  // Each test needs distinct content — uploads are content-addressed, so a
  // byte-identical file dedupes into the already-uploaded asset row.
  const png = (r: number) =>
    sharp({ create: { width: 8, height: 8, channels: 3, background: { r, g: 10, b: 10 } } })
      .png()
      .toBuffer();

  it("lands in uploads/unknown by default", async () => {
    const r = await saveUploadedFile(PID, "def.png", await png(200));
    assert.equal(r.localPath, `${SLUG}/assets/uploads/unknown/def.png`);
    assert.ok(existsSync(join(ASSETS, "uploads/unknown/def.png")));
  });

  it("lands in a requested nested folder", async () => {
    const r = await saveUploadedFile(PID, "nest.png", await png(120), "uploads/nature");
    assert.equal(r.localPath, `${SLUG}/assets/uploads/nature/nest.png`);
    assert.ok(existsSync(join(ASSETS, "uploads/nature/nest.png")));
  });

  it("rejects an invalid folder param", async () => {
    const buf = await png(60);
    await assert.rejects(() => saveUploadedFile(PID, "bad.png", buf, "../x"), /invalid folder/);
  });
});
