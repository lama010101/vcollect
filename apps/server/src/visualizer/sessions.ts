// =============================================================================
// Visualizer sessions — named, restorable snapshots of the whole page state:
// the stem selection (with per-stem tweaks), every look/layers/dancer setting
// and the render settings — PLUS the media itself, so loading a session always
// brings back the exact files it was saved with.
//
// Layout: OUTPUT_ROOT/<slug>/visualizer/sessions/<id>/
//   session.json          { version, id, name, createdAt, updatedAt, payload, stems, media }
//   stems/<file>          copies of the referenced stem audio
//   media/<sha12><ext>    snapshots of referenced layer media files
//
// Stems are COPIED (re-uploads overwrite stem files in place, so a hardlink
// would share the mutation). Asset files are immutable once downloaded, so
// media snapshots hardlink first and fall back to a real copy.
//
// Loading restores stem bytes into the shared stems dir (the session's version
// wins when content differs) and re-registers deleted layer files as 'local'
// assets via syncProjectAssets — content-addressed LOCAL_<project>_<sha16>
// ids mean a restored file deterministically gets the same id back.
// =============================================================================

import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import {
  visualizerSessionPayloadSchema,
  type VizSession,
  type VizSessionMeta,
  type VisualizerSessionPayload,
  type VizMediaLayerConfig,
} from "@twio/shared";
import { projectAssetDir } from "../config.js";
import { sha256File, syncProjectAssets } from "../db/assetSync.js";
import { db } from "../db/client.js";
import { getProject } from "../db/projectRepository.js";
import {
  addAssetToShot,
  createShot,
  createTimeline,
  getAsset,
  markSelected,
  nextShotNumber,
  setShotAssetOnRail,
  setShotTimeRange,
  setShotTimeline,
} from "../db/repository.js";
import { assetAbsolutePath } from "../routes/folders.js";
import { probeAudio } from "../video/ffprobe.js";
import { VisualizerError } from "./errors.js";
import { stemPath, visualizerDir } from "./service.js";

/** Stem files snapshotted with the session (`stems/<name>`). */
interface StoredStem {
  name: string;
  sha256: string;
}

/** One media-layer row's snapshot record. `file`/`sha256`/`origName` are null
 *  when nothing could be snapshotted at save time (asset missing or not
 *  downloaded) — the layer then warns at load instead of restoring. */
interface StoredMedia {
  assetId: string;
  file: string | null;
  sha256: string | null;
  origName: string | null;
  title: string | null;
}

interface StoredSession {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  payload: VisualizerSessionPayload;
  stems: StoredStem[];
  media: StoredMedia[];
}

export interface SessionLoadResult {
  session: VizSessionMeta;
  payload: VisualizerSessionPayload;
  /** Human-readable notes for media/stems that could not be restored. */
  warnings: string[];
  /** Media-layer rows whose file was restored + re-registered as an asset. */
  restoredMedia: number;
}

const SESSION_ID_RE = /^[\w-]{1,64}$/;

function sessionsRoot(projectId: string): string {
  return visualizerDir(projectId, "sessions");
}

function sessionDir(projectId: string, id: string): string {
  if (!SESSION_ID_RE.test(id)) {
    throw new VisualizerError(400, "INVALID_SESSION_ID", `Invalid session id: ${id}`);
  }
  return join(sessionsRoot(projectId), id);
}

function sessionJsonPath(projectId: string, id: string): string {
  return join(sessionDir(projectId, id), "session.json");
}

/** Read + validate a stored session. 404 when absent, 422 when corrupt. */
function readStored(projectId: string, id: string): StoredSession {
  const p = sessionJsonPath(projectId, id);
  if (!existsSync(p)) {
    throw new VisualizerError(404, "SESSION_NOT_FOUND", `Session not found: ${id}`);
  }
  let raw: StoredSession;
  try {
    raw = JSON.parse(readFileSync(p, "utf8")) as StoredSession;
  } catch (e) {
    throw new VisualizerError(422, "SESSION_CORRUPT", `Session ${id} is unreadable: ${(e as Error).message}`);
  }
  const parsed = visualizerSessionPayloadSchema.safeParse(raw.payload);
  if (!parsed.success) {
    throw new VisualizerError(422, "SESSION_CORRUPT", `Session ${id} has an invalid payload: ${parsed.error.message}`);
  }
  raw.payload = parsed.data;
  raw.stems = Array.isArray(raw.stems) ? raw.stems : [];
  raw.media = Array.isArray(raw.media) ? raw.media : [];
  return raw;
}

/** Tolerant read used by overwrite — a corrupt previous save doesn't block
 *  re-saving (it just loses createdAt). */
function tryReadStored(projectId: string, id: string): StoredSession | null {
  try {
    return readStored(projectId, id);
  } catch {
    return null;
  }
}

function toMeta(s: StoredSession): VizSessionMeta {
  return {
    id: s.id,
    name: s.name,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    stems: s.payload.stems.map((x) => x.name),
    mediaLayers: s.payload.globalVisuals.video.layers.filter((l) => l.kind === "media").length,
  };
}

/** List sessions (newest first). Unreadable entries are skipped, never fatal. */
export function listSessions(projectId: string): VizSessionMeta[] {
  const root = sessionsRoot(projectId);
  const out: VizSessionMeta[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SESSION_ID_RE.test(entry.name)) continue;
    try {
      const s = readStored(projectId, entry.name);
      out.push(toMeta(s));
    } catch {
      /* corrupt session dirs don't block the list */
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getSession(projectId: string, id: string): VizSession {
  const s = readStored(projectId, id);
  return { ...toMeta(s), payload: s.payload };
}

/** Create a session (or overwrite it when `existingId` is given): snapshots
 *  every referenced stem + media-layer file into the session dir. A stem name
 *  that isn't uploaded 404s — same discipline as render validation. */
export async function saveSession(
  projectId: string,
  name: string,
  payload: VisualizerSessionPayload,
  existingId?: string,
): Promise<VizSession> {
  const id = existingId ?? randomUUID();
  const dir = existingId ? sessionDir(projectId, id) : join(sessionsRoot(projectId), id);
  const prev = existingId ? tryReadStored(projectId, id) : null;

  // Rebuild the snapshot dirs from scratch — stale copies never linger.
  const stemsDir = join(dir, "stems");
  const mediaDir = join(dir, "media");
  rmSync(stemsDir, { recursive: true, force: true });
  rmSync(mediaDir, { recursive: true, force: true });
  mkdirSync(stemsDir, { recursive: true });
  mkdirSync(mediaDir, { recursive: true });

  // Stems — real copies: stem uploads overwrite in place, so a link would
  // follow the new content instead of keeping the session's version.
  const stems: StoredStem[] = [];
  for (const s of payload.stems) {
    const src = stemPath(projectId, s.name); // 404 STEM_NOT_FOUND if missing
    const dst = join(stemsDir, basename(src));
    copyFileSync(src, dst);
    stems.push({ name: s.name, sha256: await sha256File(dst) });
  }

  // Media layers — hardlink snapshots (asset files are immutable). Deduped by
  // absolute path so two rows sharing one file hash/link it once.
  const media: StoredMedia[] = [];
  const byPath = new Map<string, { file: string; sha256: string }>();
  for (const l of payload.globalVisuals.video.layers) {
    if (l.kind !== "media") continue;
    const a = getAsset(l.assetId);
    const abs = a && a.project_id === projectId && a.local_path ? assetAbsolutePath(a.local_path, "") : null;
    if (abs && existsSync(abs)) {
      let snap = byPath.get(abs);
      if (!snap) {
        const sha256 = await sha256File(abs);
        const file = `${sha256.slice(0, 12)}${extname(abs).toLowerCase()}`;
        const dst = join(mediaDir, file);
        if (!existsSync(dst)) {
          try {
            linkSync(abs, dst);
          } catch {
            copyFileSync(abs, dst);
          }
        }
        snap = { file, sha256 };
        byPath.set(abs, snap);
      }
      media.push({ assetId: l.assetId, file: snap.file, sha256: snap.sha256, origName: basename(abs), title: a?.title ?? null });
    } else {
      media.push({ assetId: l.assetId, file: null, sha256: null, origName: null, title: a?.title ?? null });
    }
  }

  const now = new Date().toISOString();
  const stored: StoredSession = {
    version: 1,
    id,
    name,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    payload,
    stems,
    media,
  };
  writeFileSync(join(dir, "session.json"), JSON.stringify(stored, null, 2));
  return { ...toMeta(stored), payload };
}

/** Rename a session and/or overwrite its saved setup (payload ⇒ re-snapshot). */
export async function updateSession(
  projectId: string,
  id: string,
  patch: { name?: string; payload?: VisualizerSessionPayload },
): Promise<VizSession> {
  const cur = readStored(projectId, id);
  if (patch.payload) {
    return saveSession(projectId, patch.name ?? cur.name, patch.payload, id);
  }
  const stored: StoredSession = { ...cur, name: patch.name ?? cur.name, updatedAt: new Date().toISOString() };
  writeFileSync(sessionJsonPath(projectId, id), JSON.stringify(stored, null, 2));
  return { ...toMeta(stored), payload: stored.payload };
}

export function deleteSession(projectId: string, id: string): void {
  const p = sessionJsonPath(projectId, id);
  if (!existsSync(p)) {
    throw new VisualizerError(404, "SESSION_NOT_FOUND", `Session not found: ${id}`);
  }
  rmSync(sessionDir(projectId, id), { recursive: true, force: true });
}

/**
 * Restore a session's media, then return the payload for the client to apply.
 *  - Stems: copied back into the shared stems dir when missing or different
 *    (the session's bytes win). A stem whose snapshot vanished is dropped
 *    from the returned payload with a warning.
 *  - Media layers: live assets are kept as-is; an asset row pointing at a
 *    deleted file gets its file put back; a deleted/never-downloaded asset is
 *    re-registered from the session snapshot under assets/visualizer-sessions/
 *    via syncProjectAssets and the layer's assetId is remapped to the new
 *    (content-addressed) LOCAL_ id. Layers that can be restored in neither
 *    way produce warnings — the row itself is kept so the user can replace it.
 */
export async function loadSession(projectId: string, id: string): Promise<SessionLoadResult> {
  const stored = readStored(projectId, id);
  const dir = sessionDir(projectId, id);
  const payload = stored.payload;
  const warnings: string[] = [];
  let restoredMedia = 0;
  let changed = false;

  // --- Stems ------------------------------------------------------------------
  const sessionStemsDir = join(dir, "stems");
  const poolDir = visualizerDir(projectId, "stems");
  const restoredStems = new Set<string>();
  for (const s of stored.stems) {
    const snap = join(sessionStemsDir, basename(s.name));
    if (!existsSync(snap)) {
      warnings.push(`Stem "${s.name}" is missing from the session files — it was dropped.`);
      continue;
    }
    const dst = join(poolDir, basename(s.name));
    try {
      const same = existsSync(dst) && (await sha256File(dst)) === s.sha256;
      if (!same) copyFileSync(snap, dst);
      restoredStems.add(s.name);
    } catch (e) {
      warnings.push(`Stem "${s.name}" could not be restored: ${(e as Error).message}`);
    }
  }
  const kept = payload.stems.filter((s) => restoredStems.has(s.name));
  if (kept.length !== payload.stems.length) {
    payload.stems = kept;
    stored.stems = stored.stems.filter((s) => restoredStems.has(s.name));
    changed = true;
  }

  // --- Media layers -------------------------------------------------------------
  const project = getProject(projectId)!; // visualizerDir() already 404'd on bad projects
  type MediaLayer = Extract<VizMediaLayerConfig, { kind: "media" }>;
  const restores: Array<{ layer: MediaLayer; entry: StoredMedia; dest: string; label: string }> = [];

  const layers = payload.globalVisuals.video.layers;
  for (const [i, l] of layers.entries()) {
    if (l.kind !== "media") continue;
    const label = `Layer ${i + 1}`;
    const entry = stored.media.find((m) => m.assetId === l.assetId) ?? null;
    const a = getAsset(l.assetId);
    const abs = a && a.project_id === projectId && a.local_path ? assetAbsolutePath(a.local_path, "") : null;
    if (abs && existsSync(abs)) continue; // asset row + file both live
    if (!entry?.file || !existsSync(join(dir, "media", entry.file))) {
      warnings.push(
        `${label}: "${entry?.title ?? a?.title ?? l.assetId}" — the media is no longer available and the session has no copy of it; remove or replace the layer.`,
      );
      continue;
    }
    const snapPath = join(dir, "media", entry.file);
    if (abs) {
      // The asset row still points at its old path — put the file back.
      try {
        copyFileSync(snapPath, abs);
      } catch (e) {
        warnings.push(`${label}: could not restore "${basename(abs)}": ${(e as Error).message}`);
      }
      continue;
    }
    // Row deleted or never downloaded — stage a re-registration under the
    // project assets folder (sha-prefixed name dedupes identical restores).
    const origName = entry.origName ?? entry.file ?? "media.bin";
    const dest = join(projectAssetDir(project.slug, "visualizer-sessions"), `${(entry.sha256 ?? "x").slice(0, 8)}-${origName}`);
    restores.push({ layer: l, entry, dest, label });
  }

  let needSync = false;
  for (const r of restores) {
    if (existsSync(r.dest)) {
      needSync = true;
      continue;
    }
    try {
      copyFileSync(join(dir, "media", r.entry.file!), r.dest);
      needSync = true;
    } catch (e) {
      warnings.push(`${r.label}: could not restore "${r.entry.origName ?? r.entry.file}": ${(e as Error).message}`);
    }
  }
  if (needSync) await syncProjectAssets(projectId);
  for (const r of restores) {
    if (!existsSync(r.dest)) continue; // copy failed — already warned
    const newId = `LOCAL_${projectId}_${(r.entry.sha256 ?? "").slice(0, 16)}`;
    if (getAsset(newId)) {
      if (r.layer.assetId !== newId) {
        // Remap the layer (and the stored entry) to the re-registered asset.
        for (const m of stored.media) if (m.assetId === r.layer.assetId) m.assetId = newId;
        r.layer.assetId = newId;
        changed = true;
      }
      restoredMedia++;
    } else {
      warnings.push(`${r.label}: restored "${r.entry.origName ?? "media"}" but it could not be registered as an asset — remove or replace the layer.`);
    }
  }

  // Persist bookkeeping changes (dropped stems / remapped assetIds) without
  // touching updatedAt — a load is a restore, not an edit.
  if (changed) {
    try {
      writeFileSync(sessionJsonPath(projectId, id), JSON.stringify(stored, null, 2));
    } catch {
      /* bookkeeping write is best-effort — the returned payload is still right */
    }
  }

  return { session: toMeta(stored), payload, warnings, restoredMedia };
}

export interface SessionTimelineResult {
  timelineId: string;
  name: string;
  shotsCreated: number;
  durationSeconds: number;
}

/**
 * Turn a session into a TIMELINE — one shot per layer-stack row (top→bottom,
 * matching the visualizer's list order) plus one per stem, so the setup shows
 * on the Timeline page. Media shots get their layer's asset linked onto the
 * rail (linked + selected + on_rail) so the segment shows the right clip;
 * waveform/stem shots are label-only. All shots start at t=0 — stack layers
 * occupy the whole mix length (the visualizer loops media), stems span their
 * own duration. Does NOT restore session media — a missing asset just skips
 * the shot_assets link.
 */
export async function sessionToTimeline(projectId: string, id: string): Promise<SessionTimelineResult> {
  const stored = readStored(projectId, id);
  const dir = sessionDir(projectId, id);
  const layers = stored.payload.globalVisuals.video.layers;
  const round = (n: number) => Math.round(n * 1000) / 1000;

  // Mix length = longest probeable stem (the session's own snapshots — the
  // pool copy may have been deleted since). Fall back to the longest media
  // asset duration, then 10 s.
  const stemDur = new Map<string, number>();
  let mix = 0;
  for (const s of stored.stems) {
    try {
      const dur = (await probeAudio(join(dir, "stems", basename(s.name)))).durationSeconds;
      stemDur.set(s.name, dur);
      mix = Math.max(mix, dur);
    } catch {
      /* stem snapshot missing/undecodable → shot falls back to the mix length */
    }
  }
  if (!(mix > 0)) {
    for (const l of layers) {
      if (l.kind !== "media") continue;
      const a = getAsset(l.assetId);
      if (a?.project_id === projectId && a.duration_seconds) mix = Math.max(mix, a.duration_seconds);
    }
    if (!(mix > 0)) mix = 10;
  }

  const tlId = `TL_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const name = `Viz — ${stored.name}`;
  let shotsCreated = 0;
  db.transaction(() => {
    createTimeline(
      tlId,
      name,
      projectId,
      `Visualizer session "${stored.name}" — layer stack + stems loaded as shots (${new Date().toISOString()})`,
    );
    const mk = (section: string, desc: string, dur: number, referenceImageUrl: string | null = null) => {
      const num = nextShotNumber(projectId);
      const shotId = `${projectId}_SHOT_${String(num).padStart(3, "0")}`;
      createShot({
        id: shotId,
        projectId,
        shotNumber: num,
        section,
        visualDescription: desc,
        searchQuery: "",
        targetDurationSeconds: round(dur),
        priority: 5,
        referenceImageUrl,
      });
      setShotTimeline(shotId, tlId);
      setShotTimeRange(shotId, 0, round(dur));
      shotsCreated++;
      return shotId;
    };
    // Layer stack — top layer first (the visualizer's list order).
    for (const l of [...layers].reverse()) {
      if (l.kind === "visuals") {
        const mode = l.visuals?.mode ?? stored.payload.globalVisuals.mode;
        mk("VIZ_STACK", `◈ Waveform — ${mode}${l.visuals ? " (own settings)" : " (2. Look)"}`, mix);
        continue;
      }
      const a = getAsset(l.assetId);
      const live = a && a.project_id === projectId ? a : null;
      const title = live?.title ?? stored.media.find((m) => m.assetId === l.assetId)?.title ?? l.assetId;
      const shotId = mk(
        "VIZ_STACK",
        `▦ Media — ${title}${l.key.method !== "none" ? ` (${l.key.method} keyed)` : ""}`,
        mix,
        live ? `/api/assets/${live.id}/thumb` : null,
      );
      if (live) {
        addAssetToShot(shotId, live.id, 0);
        markSelected(shotId, live.id);
        setShotAssetOnRail(shotId, live.id, true);
      }
    }
    // Stems — the audio the visuals run on.
    const kindOf = new Map(stored.payload.stems.map((s) => [s.name, s.kind ?? null]));
    for (const s of stored.stems) {
      const kind = kindOf.get(s.name);
      mk("STEMS", `♫ Stem — ${s.name}${kind ? ` (${kind})` : ""}`, stemDur.get(s.name) ?? mix);
    }
  });
  return { timelineId: tlId, name, shotsCreated, durationSeconds: round(mix) };
}
