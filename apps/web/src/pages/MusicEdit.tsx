import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CutGridSpec, EditPlan, EdlBoundaryKind, MusicEditSettings, VizSessionMeta } from "@twio/shared";
import {
  api,
  ASSETS_CHANGED_EVENT,
  assetFolderPath,
  isAudioFileName,
  isImageFileName,
  type Asset,
  type AssetFolderEntry,
  type MusicAnalysis,
  type MusicEditRequest,
  type MusicEditStatus,
  type MusicRenderJob,
  type MusicRenderedFile,
  type MusicSong,
  type VizStem,
} from "../api.js";
import { Badge, Button, Card, ProgressBar, SectionTitle, Spinner, StatCard } from "../components/ui.js";

/**
 * Music Edit — beat-aligned music-video editor.
 * Song → waveform beat detection (server, built-in tracker) → edit decision list cut
 * on the detected beats → FFmpeg render with the original song untouched.
 * Source videos are the project's downloaded assets, used round-robin in the
 * order listed here.
 */

/** Cut-grid source selector values (mapped to CutGridSpec.source in the
 *  request builder — "every_n"/"stem" are the UI's shorter names). */
type CutSource = "beats" | "every_n" | "bars" | "stem" | "sections";

type Settings = Pick<
  MusicEditSettings,
  | "autoBeats"
  | "beatsPerCut"
  | "beatOffset"
  | "manualOffsetSeconds"
  | "maxSpeedUp"
  | "maxSlowDown"
  | "allowExtremeRetime"
  | "loopSource"
  | "fps"
  | "maxOutputHeight"
  | "aspect"
> & {
  manualBpm: number | undefined;
  // --- Cut grid (only used while autoBeats is on) -------------------------
  cutSource: CutSource;
  cutEvery: number; // every_n: beats between cuts (1, 2, 4, 8, 16)
  barsMeter: 3 | 4; // bars: beats per bar
  stemName: string; // stem: file name in the visualizer stem pool
  stemBand: "full" | "kick" | "snare_hat";
  stemMinGap: number; // seconds between stem-hit cuts
  stemThreshold: number; // 0..1 relative onset threshold
  sectionAuto: boolean; // sections: auto density vs per-class overrides
  sectionQuiet: number; // beats per cut in quiet sections (1,2,4,8)
  sectionMedium: number;
  sectionLoud: number;
  // --- Intercut (parallel storylines) --------------------------------------
  mode: "flat" | "intercut";
  slotsPerSlice: number; // consecutive cut slots one storyline holds
  endOfMaterial: "loop" | "retire";
  storylineCount: number; // storyline slots offered in the per-source picker
  storylineOf: Record<string, number>; // assetId → 1-based storyline number
  // --- Motion alignment -----------------------------------------------------
  alignMotion: boolean; // shift in-points so a motion peak lands on the cut
  motionWindow: number; // ±seconds search around the cursor
};

const DEFAULT_SETTINGS: Settings = {
  autoBeats: true,
  beatsPerCut: 2,
  beatOffset: 0,
  manualBpm: undefined,
  manualOffsetSeconds: 0,
  maxSpeedUp: 1.25,
  maxSlowDown: 0.8,
  allowExtremeRetime: false,
  loopSource: false,
  fps: 30,
  maxOutputHeight: 1080,
  aspect: "16:9",
  cutSource: "every_n",
  cutEvery: 2,
  barsMeter: 4,
  stemName: "",
  stemBand: "full",
  stemMinGap: 0.25,
  stemThreshold: 0.12,
  sectionAuto: true,
  sectionQuiet: 4,
  sectionMedium: 2,
  sectionLoud: 1,
  mode: "flat",
  slotsPerSlice: 1,
  endOfMaterial: "loop",
  storylineCount: 4,
  storylineOf: {},
  alignMotion: false,
  motionWindow: 0.5,
};

const CUT_EVERY_OPTIONS = [1, 2, 4, 8, 16];
const SECTION_DENSITY_OPTIONS = [1, 2, 4, 8];

const CUT_MODES: Array<{ value: Settings["beatsPerCut"]; label: string }> = [
  { value: 1, label: "Every beat" },
  { value: 2, label: "Every 2 beats" },
  { value: 4, label: "Every 4 beats" },
  { value: 8, label: "Every 8 beats" },
];

const EDL_PREVIEW_ROWS = 300;

/** Short label for an EDL boundary that isn't a detected-beat index. */
const boundaryLabel = (kind: EdlBoundaryKind): string =>
  kind === "audio_start" ? "start" : kind === "audio_end" ? "end" : kind === "manual_grid" ? "grid" : kind;

// --- Per-project session persistence ------------------------------------------
// All Music Edit work (song choice, clip order, settings, analysis, built EDL,
// active render job) is stored in localStorage so a refresh loses nothing.

const storageKey = (projectId: string) => `twio.musicEdit.${projectId}`;

interface PersistedMusicEdit {
  song: string;
  orderAssets: Asset[];
  settings: Settings;
  analysis: MusicAnalysis | null;
  plan: EditPlan | null;
  /** JSON.stringify(request) that produced `plan` — plan stays valid only
   *  while the current inputs still match this key. */
  planKey: string | null;
  /** id of the last render job — re-fetched on load to resume polling. */
  jobId: string | null;
}

function loadPersisted(projectId: string): PersistedMusicEdit | null {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PersistedMusicEdit>;
    return {
      song: typeof p.song === "string" ? p.song : "",
      orderAssets: Array.isArray(p.orderAssets) ? (p.orderAssets as Asset[]) : [],
      settings: { ...DEFAULT_SETTINGS, ...(typeof p.settings === "object" && p.settings ? p.settings : {}) },
      analysis: p.analysis ?? null,
      plan: p.plan ?? null,
      planKey: typeof p.planKey === "string" ? p.planKey : null,
      jobId: typeof p.jobId === "string" ? p.jobId : null,
    };
  } catch {
    return null;
  }
}

function mmss(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Number input that commits in-range values as typed and clamps the draft on blur / Enter. */
function NumberInput({
  value,
  min,
  max,
  step,
  onCommit,
}: {
  value: number;
  min: number;
  max?: number;
  step?: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(n)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max ?? Infinity, Math.max(min, n));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      className="ui-input w-full"
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== "" && n >= min && n <= (max ?? Infinity) && n !== value) onCommit(n);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}

function downloadJson(name: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function MusicEdit({
  projectId,
  onToast,
}: {
  projectId: string;
  onToast: (text: string, tone?: "info" | "success" | "error") => void;
}) {
  // Hydrate the persisted session synchronously on first render — doing it in
  // a useEffect would lose data under StrictMode (effects double-run and a
  // persist pass with defaults could overwrite the blob before restore).
  const initialRef = useRef<PersistedMusicEdit | null | undefined>(undefined);
  if (initialRef.current === undefined) initialRef.current = loadPersisted(projectId);
  const initial = initialRef.current;

  const [status, setStatus] = useState<MusicEditStatus | null>(null);
  const [songs, setSongs] = useState<MusicSong[]>([]);
  const [song, setSong] = useState<string>(initial?.song ?? "");
  const [uploading, setUploading] = useState(false);
  const [analysis, setAnalysis] = useState<MusicAnalysis | null>(initial?.analysis ?? null);
  const [analyzing, setAnalyzing] = useState(false);
  const [library, setLibrary] = useState<Asset[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  // Downloaded audio assets — the song picker's "import from library" group
  // (drag & drop / folder-sync files become songs without a second upload).
  const [audioAssets, setAudioAssets] = useState<Asset[]>([]);
  // "+ Add a video…" picker — the same dropdown UX as the 4D timeline's
  // add-a-layer: name filter + assets-folder sidebar, videos only (the EDL
  // can't cut to stills).
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQ, setPickerQ] = useState("");
  const [pickerFolder, setPickerFolder] = useState("");
  const [assetFolders, setAssetFolders] = useState<AssetFolderEntry[]>([]);
  // 4D timeline session reuse — loads the session's layer videos as the
  // source list and its stems into the song pool in one click.
  const [vizSessions, setVizSessions] = useState<VizSessionMeta[]>([]);
  const [vizSel, setVizSel] = useState("");
  const [vizBusy, setVizBusy] = useState(false);
  // Visualizer stem pool — the "Stem hits" cut-grid source picks one of these.
  const [vizStemList, setVizStemList] = useState<VizStem[]>([]);
  // UI-only filter for the stem picker — does not affect the plan request.
  const [stemExtFilter, setStemExtFilter] = useState<"all" | "wav" | "mp3">("all");
  const filteredStemList = vizStemList.filter(
    (s) => stemExtFilter === "all" || s.name.toLowerCase().endsWith(`.${stemExtFilter}`),
  );
  const onStemExtFilter = (f: "all" | "wav" | "mp3") => {
    setStemExtFilter(f);
    // A hidden stem must not silently stay selected (the plan would still use it).
    if (f !== "all" && settings.stemName && !settings.stemName.toLowerCase().endsWith(`.${f}`)) {
      set("stemName", "");
    }
  };
  const [order, setOrder] = useState<Asset[]>(initial?.orderAssets ?? []);
  const [settings, setSettings] = useState<Settings>(initial?.settings ?? DEFAULT_SETTINGS);
  const [plan, setPlan] = useState<EditPlan | null>(initial?.plan ?? null);
  const [planning, setPlanning] = useState(false);
  const [job, setJob] = useState<MusicRenderJob | null>(null);
  const [renders, setRenders] = useState<MusicRenderedFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /** JSON key of the request that produced `plan` — the plan stays valid only
   *  while current inputs still serialize to the same key. */
  const planKeyRef = useRef<string | null>(initial?.planKey ?? null);

  const loadSongs = useCallback(async () => {
    const r = await api.musicSongs(projectId);
    setSongs(r.songs);
    return r.songs;
  }, [projectId]);

  const loadRenders = useCallback(async () => {
    const r = await api.musicRenders(projectId);
    setRenders(r.renders);
  }, [projectId]);

  useEffect(() => {
    api.musicEditStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  // Restore the persisted session for this project (or start clean). Runs on
  // mount and whenever the active project changes.
  useEffect(() => {
    const saved = loadPersisted(projectId);
    setSong(saved?.song ?? "");
    setAnalysis(saved?.analysis ?? null);
    setOrder(saved?.orderAssets ?? []);
    setSettings(saved?.settings ?? DEFAULT_SETTINGS);
    setPlan(saved?.plan ?? null);
    planKeyRef.current = saved?.planKey ?? null;
    setJob(null);
    // A render started before the refresh keeps running server-side —
    // re-fetch it so progress polling resumes.
    if (saved?.jobId) {
      api
        .musicRenderJob(saved.jobId)
        .then((r) => setJob(r.job))
        .catch(() => {}); // job gone (server restart) → start fresh
    }
    loadSongs()
      .then((list) => {
        // The saved song may have been deleted server-side — drop the stale ref.
        if (saved?.song && !list.some((s) => s.name === saved.song)) setSong("");
      })
      .catch((e) => setError((e as Error).message));
    loadRenders().catch(() => {});
  }, [projectId, loadSongs, loadRenders]);

  // Persist the session on every meaningful change.
  useEffect(() => {
    const payload: PersistedMusicEdit = {
      song,
      orderAssets: order,
      settings,
      analysis,
      plan,
      planKey: planKeyRef.current,
      jobId: job?.id ?? null,
    };
    try {
      localStorage.setItem(storageKey(projectId), JSON.stringify(payload));
    } catch { /* quota/serialization — persistence is best-effort */ }
  }, [projectId, song, order, settings, analysis, plan, job?.id]);

  // Downloaded project assets (debounced search). `libraryRefresh` bumps when
  // files are dropped onto the app so new uploads appear without a reload.
  const [libraryRefresh, setLibraryRefresh] = useState(0);
  const [syncing, setSyncing] = useState(false);
  // Manual "refresh from folder" — scans the project's assets folder for
  // videos placed there outside the app and reloads the library.
  const refreshLibrary = async () => {
    setSyncing(true);
    setError(null);
    try {
      const r = await api.syncProjectAssets(projectId);
      if (r.added > 0) {
        onToast(`Registered ${r.added} video${r.added === 1 ? "" : "s"} from the project folder`, "success");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSyncing(false);
      setLibraryRefresh((n) => n + 1); // reload the library list
    }
  };
  useEffect(() => {
    const onChanged = () => setLibraryRefresh((n) => n + 1);
    window.addEventListener(ASSETS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(ASSETS_CHANGED_EVENT, onChanged);
  }, []);
  useEffect(() => {
    setLibraryLoading(true);
    // Sync the project's assets folder first — the source library is every
    // video on disk, no matter how it got there (downloads, drag & drop, or
    // files copied in manually outside the app).
    api
      .syncProjectAssets(projectId)
      .catch(() => {}) // sync failure must not hide existing assets
      .then(() => api.searchAssetsAdvanced({ downloadedOnly: true, mediaType: "video", sort: "newest_downloaded", limit: 500 }, projectId))
      // Images are project assets too (uploads/sync register them) but they
      // can't be edit sources — keep the library videos-only.
      .then((r) => setLibrary(r.assets.filter((a) => a.local_path && !isImageFileName(a.local_path))))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLibraryLoading(false));
    // Library audio for the song picker's import group — same refresh cadence
    // as the video library (drops onto the app bump libraryRefresh).
    api
      .searchAssetsAdvanced({ downloadedOnly: true, mediaType: "audio", sort: "newest_downloaded", limit: 200 }, projectId)
      .then((r) => setAudioAssets(r.assets.filter((a) => a.local_path && isAudioFileName(a.local_path))))
      .catch(() => {});
    // The picker's folder sidebar mirrors the real disk tree.
    api
      .folderTree(projectId)
      .then((r) => setAssetFolders(r.folders))
      .catch(() => {});
  }, [projectId, libraryRefresh]);

  // The 4D-timeline session picker — refetch on mount + project switch.
  useEffect(() => {
    let live = true;
    api
      .vizSessions(projectId)
      .then((r) => {
        if (!live) return;
        setVizSessions(r.sessions);
        setVizSel((cur) => (r.sessions.some((s) => s.id === cur) ? cur : (r.sessions[0]?.id ?? "")));
      })
      .catch(() => {}); // sessions are optional — keep the picker hidden
    // The stem pool feeds the "Stem hits" cut-grid picker.
    api
      .vizStems(projectId)
      .then((r) => setVizStemList(r.stems))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [projectId]);

  // Poll the active render.
  useEffect(() => {
    if (!job || job.status !== "running") return;
    const t = setInterval(() => {
      api
        .musicRenderJob(job.id)
        .then((r) => {
          setJob(r.job);
          if (r.job.status === "done") {
            onToast("Music video rendered", "success");
            loadRenders().catch(() => {});
          } else if (r.job.status === "failed") {
            onToast(`Render failed: ${r.job.error?.message ?? "unknown error"}`, "error");
          }
        })
        .catch(() => {});
    }, 1000);
    return () => clearInterval(t);
  }, [job, onToast, loadRenders]);

  const request = useMemo<MusicEditRequest>(() => {
    // Map the UI's cut-source selection onto the API's CutGridSpec. No grid
    // is sent while automatic beats are off (manual BPM grid stays legacy).
    let grid: CutGridSpec | undefined;
    if (settings.autoBeats) {
      switch (settings.cutSource) {
        case "beats":
          grid = { source: "beats" };
          break;
        case "every_n":
          grid = { source: "every_n_beats", n: settings.cutEvery, offset: settings.beatOffset };
          break;
        case "bars":
          grid = { source: "bars", beatsPerBar: settings.barsMeter };
          break;
        case "stem":
          if (settings.stemName) {
            grid = {
              source: "stem_onsets",
              stem: settings.stemName,
              band: settings.stemBand,
              minGap: settings.stemMinGap,
              threshold: settings.stemThreshold,
            };
          }
          break;
        case "sections":
          grid = settings.sectionAuto
            ? { source: "sections" }
            : {
                source: "sections",
                quietEvery: settings.sectionQuiet as 1 | 2 | 4 | 8,
                mediumEvery: settings.sectionMedium as 1 | 2 | 4 | 8,
                loudEvery: settings.sectionLoud as 1 | 2 | 4 | 8,
              };
          break;
      }
    }
    // Intercut: group the ordered sources into storylines by their assigned
    // storyline number (order-list order is preserved inside each storyline).
    let intercut: MusicEditRequest["intercut"];
    if (settings.mode === "intercut" && order.length > 0) {
      const groups = new Map<number, string[]>();
      for (const a of order) {
        const n = Math.min(settings.storylineCount, Math.max(1, settings.storylineOf[a.id] ?? 1));
        const g = groups.get(n);
        if (g) g.push(a.id);
        else groups.set(n, [a.id]);
      }
      intercut = {
        slotsPerSlice: settings.slotsPerSlice,
        endOfMaterial: settings.endOfMaterial,
        rotation: "roundRobin",
        storylines: [...groups.keys()]
          .sort((x, y) => x - y)
          .map((n) => ({ name: `Storyline ${n}`, assetIds: groups.get(n)! })),
      };
    }
    return {
      song,
      assetIds: order.map((a) => a.id),
      settings: { ...settings, manualBpm: settings.autoBeats ? undefined : settings.manualBpm },
      grid,
      intercut,
    };
  }, [song, order, settings]);
  const requestKey = useMemo(() => JSON.stringify(request), [request]);

  // The previewed plan stays valid only while inputs still match the request
  // it was built from — any change to song/order/settings invalidates it, but
  // restoring the exact same inputs (e.g. after a page refresh) keeps it.
  useEffect(() => {
    if (plan && planKeyRef.current !== requestKey) setPlan(null);
  }, [plan, requestKey]);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings((s) => ({ ...s, [key]: value }));

  /** Import a library audio asset into the song pool, then select it. */
  const importLibrarySong = async (assetId: string) => {
    setUploading(true);
    setError(null);
    try {
      const r = await api.importMusicSong(projectId, assetId);
      await loadSongs();
      setSong(r.song.name);
      setAnalysis(null);
      onToast(`Imported ${r.song.name} from the library`, "success");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const upload = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const r = await api.uploadMusicSong(projectId, file);
      await loadSongs();
      setSong(r.song.name);
      setAnalysis(null);
      onToast(`Uploaded ${r.song.name}`, "success");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const analyze = async () => {
    if (!song) return;
    setAnalyzing(true);
    setError(null);
    try {
      const r = await api.analyzeMusicSong(projectId, song);
      setAnalysis(r.analysis);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAnalyzing(false);
    }
  };

  const buildPlan = async () => {
    setPlanning(true);
    setError(null);
    try {
      const r = await api.planMusicEdit(projectId, request);
      setAnalysis(r.analysis);
      planKeyRef.current = requestKey;
      setPlan(r.plan);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPlanning(false);
    }
  };

  const render = async () => {
    setError(null);
    try {
      const r = await api.renderMusicEdit(projectId, request);
      setJob(r.job);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** Open the renders folder (or a file inside it) in the OS file explorer. */
  const revealRender = (name?: string) =>
    api
      .musicRevealRender(projectId, name)
      .then((r) => {
        if (!r.ok) setError(r.error ?? "Could not open the folder");
      })
      .catch((e) => setError((e as Error).message));

  const move = (idx: number, delta: number) =>
    setOrder((o) => {
      const j = idx + delta;
      if (j < 0 || j >= o.length) return o;
      const next = [...o];
      [next[idx], next[j]] = [next[j]!, next[idx]!];
      return next;
    });

  const inOrder = new Set(order.map((a) => a.id));
  const addToOrder = (a: Asset) => {
    setSettings((s) => ({
      ...s,
      // Default storyline assignment spreads clips round-robin so intercut
      // is meaningful immediately; explicit picks persist per asset id.
      storylineOf: { ...s.storylineOf, [a.id]: s.storylineOf[a.id] ?? ((order.length % s.storylineCount) + 1) },
    }));
    setOrder((o) => (o.some((x) => x.id === a.id) ? o : [...o, a]));
  };

  // The picker's rows: library filtered by name + the selected assets-folder
  // subtree ("" = all folders) — same filtering as the 4D timeline picker.
  const pickerResults = useMemo(() => {
    const q = pickerQ.trim().toLowerCase();
    return library.filter((a) => {
      if (pickerFolder !== "") {
        const af = assetFolderPath(a.local_path);
        if (af !== pickerFolder && !(af !== null && af.startsWith(pickerFolder + "/"))) return false;
      }
      if (!q) return true;
      return (a.title ?? "").toLowerCase().includes(q) || (a.local_path ?? "").toLowerCase().includes(q);
    });
  }, [library, pickerQ, pickerFolder]);

  /** Load a saved 4D timeline session: its layer videos become the source
   *  list and its stems are copied into the song pool (first stem selected). */
  const applyVizSession = async () => {
    if (!vizSel) return;
    setVizBusy(true);
    setError(null);
    try {
      const r = await api.musicEditImportSession(projectId, vizSel);
      if (r.assets.length > 0) setOrder(r.assets);
      await loadSongs();
      if (r.songs.length > 0) {
        setSong(r.songs[0]!);
        setAnalysis(null);
      }
      setLibraryRefresh((n) => n + 1); // restored media may have re-registered
      if (r.warnings.length > 0) onToast(r.warnings.join(" — "), "info");
      onToast(
        `Loaded "${r.session.name}": ${r.assets.length} video${r.assets.length === 1 ? "" : "s"}${r.songs.length > 0 ? ` · song set to ${r.songs[0]}` : ""}`,
        "success",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setVizBusy(false);
    }
  };
  const manualInvalid = !settings.autoBeats && !(settings.manualBpm && settings.manualBpm > 0);
  const stemMissing = settings.autoBeats && settings.cutSource === "stem" && !settings.stemName;
  const canPlan = !!song && order.length > 0 && !manualInvalid && !stemMissing && !planning;
  const rendering = job?.status === "running";
  const cutLabel = CUT_MODES.find((m) => m.value === settings.beatsPerCut)?.label ?? "";

  return (
    <div className="space-y-6">
      {status && !status.ok && (
        <Card className="p-4 border border-amber-700/40">
          <p className="text-sm text-amber-300">
            Beat analyzer unavailable: {status.detail}
          </p>
        </Card>
      )}
      {error && (
        <Card className="p-4 border border-rose-700/40">
          <div className="flex items-start justify-between gap-4">
            <p className="text-sm text-rose-300 break-words">{error}</p>
            <Button size="sm" variant="ghost" onClick={() => setError(null)}>
              Dismiss
            </Button>
          </div>
        </Card>
      )}

      {/* 1. Song */}
      <Card className="p-5 space-y-4">
        <SectionTitle
          icon="♫"
          action={status?.ok ? <Badge tone="good">Beat analyzer ready · {status.detail}</Badge> : undefined}
        >
          1. Song
        </SectionTitle>
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="ui-input min-w-[16rem]"
            value={song}
            onChange={(e) => {
              const v = e.target.value;
              // "lib:<assetId>" options import the library audio file into the
              // song pool first, then select the freshly added song.
              if (v.startsWith("lib:")) {
                void importLibrarySong(v.slice(4));
                return;
              }
              setSong(v);
              setAnalysis(null);
            }}
            aria-label="Song"
          >
            <option value="">{songs.length ? "Select a song…" : "No songs yet — upload one"}</option>
            {songs.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
            {audioAssets.length > 0 && (
              <optgroup label="Library audio — pick to import">
                {audioAssets.map((a) => (
                  <option key={a.id} value={`lib:${a.id}`}>
                    {(a.title ?? a.local_path ?? a.id)} ⤓
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <input
            ref={fileRef}
            type="file"
            accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.oga,.opus"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
          <Button onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? "Uploading…" : "Upload song"}
          </Button>
          <Button variant="primary" onClick={analyze} disabled={!song || analyzing}>
            {analyzing ? "Analyzing…" : "Analyze beats"}
          </Button>
          {analyzing && <Spinner />}
        </div>
        {song && <audio controls className="w-full" src={songs.find((s) => s.name === song)?.url} />}
        {analysis && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="Detected BPM" value={analysis.bpm.toFixed(1)} sublabel={analysis.analyzer.name} tone="info" />
            <StatCard label="Detected beats" value={analysis.beats.length} sublabel={analysis.cached ? "cached analysis" : "fresh analysis"} />
            <StatCard label="Song duration" value={mmss(analysis.audioDuration)} sublabel={`${analysis.audioDuration.toFixed(3)} s · ${analysis.audioCodec}`} />
            <StatCard
              label="Beat interval"
              value={`${analysis.interval.min.toFixed(3)}–${analysis.interval.max.toFixed(3)} s`}
              sublabel={`σ ${(analysis.interval.stdDev * 1000).toFixed(1)} ms (not a fixed grid)`}
            />
          </div>
        )}
      </Card>

      {/* 2. Videos */}
      {/* Raised above the following cards (.ui-card's backdrop-blur makes each
          card its own stacking context) so the "+ Add a video" picker — which
          overflows this card downward — paints over the sections below. */}
      <Card className="p-5 space-y-4 relative z-10">
        <SectionTitle
          icon="▤"
          action={
            <Button size="sm" variant="ghost" onClick={refreshLibrary} disabled={syncing || libraryLoading}>
              {syncing ? "Scanning folder…" : "↻ Refresh from folder"}
            </Button>
          }
        >
          2. Source videos{settings.mode === "intercut" ? " (intercut — parallel storylines)" : " (used in this order: V1 → V2 → … → V1)"}
        </SectionTitle>
        <div className="flex flex-wrap items-center gap-3">
          {/* + Add a video… — the same picker UX as the 4D timeline's
              "2. Layers → Add a layer": name filter + folder sidebar, stays
              open for multiple picks. */}
          <div className="relative w-80 max-w-full">
            <button
              type="button"
              className="ui-input w-full text-left text-slate-300 flex items-center justify-between gap-2"
              onClick={() => {
                if (!pickerOpen) setLibraryRefresh((n) => n + 1); // rescan the folder so the list is current
                setPickerQ("");
                setPickerOpen((o) => !o);
              }}
            >
              <span>+ Add a video…</span>
              <span className="text-slate-500">▾</span>
            </button>
            {pickerOpen && (
              <>
                {/* Click-away overlay + Esc close. */}
                <div className="fixed inset-0 z-40" onClick={() => setPickerOpen(false)} />
                <div
                  className="absolute z-50 mt-1 w-[30rem] max-w-[90vw] rounded-lg border border-slate-700 bg-slate-900 shadow-xl overflow-hidden"
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setPickerOpen(false);
                  }}
                >
                  <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-slate-800">
                    <input
                      autoFocus
                      value={pickerQ}
                      onChange={(e) => setPickerQ(e.target.value)}
                      placeholder="Filter by name…"
                      className="ui-input !py-1 flex-1 text-xs"
                    />
                  </div>
                  <div className="flex max-h-64">
                    {assetFolders.length > 0 && (
                      <div className="w-32 shrink-0 overflow-y-auto border-r border-slate-800 p-1 space-y-0.5">
                        {assetFolders.map((f) => {
                          const active = pickerFolder === f.path;
                          return (
                            <button
                              key={f.path || "__root__"}
                              type="button"
                              onClick={() => setPickerFolder(f.path)}
                              className={`w-full text-left py-1 pr-1 rounded text-[11px] flex items-center justify-between gap-1 ${active ? "bg-sky-600/30 text-sky-200" : "text-slate-300 hover:bg-slate-800"}`}
                              style={{ paddingLeft: `${4 + f.depth * 10}px` }}
                              title={f.path ? `${f.path} — ${f.fileCount} here, ${f.subtreeCount} incl. subfolders` : "All files"}
                            >
                              <span className="truncate">{f.path === "" ? "All files" : f.name}</span>
                              <span className={`shrink-0 ${active ? "text-sky-300" : "text-slate-500"}`}>{f.subtreeCount}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <div className="flex-1 min-w-0 overflow-y-auto">
                      {pickerResults.map((a) => {
                        const added = inOrder.has(a.id);
                        return (
                          <button
                            key={a.id}
                            type="button"
                            disabled={added}
                            onClick={() => addToOrder(a)}
                            className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs text-slate-200 hover:bg-slate-800/60 disabled:opacity-50"
                          >
                            <img
                              src={api.assetThumbUrl(a.id)}
                              alt=""
                              loading="lazy"
                              className="w-12 h-8 rounded object-cover border border-slate-700/60 bg-slate-800 shrink-0"
                              onError={(e) => (e.currentTarget.style.display = "none")}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate" title={a.title ?? a.local_path ?? a.id}>
                                {a.title ?? a.local_path ?? a.id}
                              </span>
                              <span className="flex items-center gap-1.5 text-[10px] text-slate-500">
                                {a.duration_seconds ? <span>{a.duration_seconds.toFixed(0)}s</span> : null}
                                {a.width && a.height ? (
                                  <span>
                                    {a.width}×{a.height}
                                  </span>
                                ) : null}
                              </span>
                            </span>
                            {added && <span className="text-[10px] text-sky-400 shrink-0">added ✓</span>}
                          </button>
                        );
                      })}
                      {pickerResults.length === 0 && (
                        <p className="px-3 py-3 text-xs text-slate-500">
                          {library.length === 0
                            ? "No downloaded videos in this project — KEEP assets on Library/Folders or drop files onto the app first."
                            : pickerFolder !== ""
                              ? `Nothing in "${pickerFolder}" — pick another folder or "All files".`
                              : "No matches — adjust the name filter."}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
          {libraryLoading && <Spinner />}
          {/* …or reuse a saved 4D timeline session — its layer videos become
              the source list and its stems join the song pool. */}
          {vizSessions.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">or</span>
              <select value={vizSel} onChange={(e) => setVizSel(e.target.value)} className="ui-input text-xs min-w-0 max-w-56" aria-label="4D timeline session">
                {vizSessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="ghost"
                disabled={!vizSel || vizBusy}
                onClick={() => void applyVizSession()}
                title="Load this 4D timeline session — its layer videos become the source list and its stems are added to the song list"
              >
                {vizBusy ? "…" : "Use session"}
              </Button>
            </div>
          )}
        </div>
        {!libraryLoading && library.length === 0 && (
          <p className="text-[11px] text-slate-500">
            No downloaded videos in this project — KEEP assets on Library/Folders or drop files onto the app first.
          </p>
        )}
        <div className="grid gap-4">
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>{order.length} selected</span>
              {order.length > 0 && (
                <Button size="sm" variant="ghost" onClick={() => setOrder([])}>
                  Clear
                </Button>
              )}
            </div>
            {order.length === 0 && <p className="text-sm text-slate-500">Add at least one video.</p>}
            <ol className="max-h-80 overflow-y-auto space-y-1 pr-1">
              {order.map((a, i) => (
                <li key={a.id} className="flex items-center gap-2 text-sm rounded px-2 py-1 bg-slate-800/40">
                  <Badge tone="info">V{i + 1}</Badge>
                  <span className="flex-1 truncate">{a.title || a.local_path}</span>
                  <span className="text-slate-500 text-xs">{a.duration_seconds ? `${a.duration_seconds.toFixed(1)}s` : ""}</span>
                  {settings.mode === "intercut" && (
                    <select
                      className="ui-input !w-auto !py-0.5 text-xs"
                      value={settings.storylineOf[a.id] ?? 1}
                      onChange={(e) => set("storylineOf", { ...settings.storylineOf, [a.id]: Number(e.target.value) })}
                      aria-label={`Storyline for ${a.title || a.local_path}`}
                      title="Storyline"
                    >
                      {Array.from({ length: settings.storylineCount }, (_, i) => i + 1).map((n) => (
                        <option key={n} value={n}>
                          SL{n}
                        </option>
                      ))}
                    </select>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">
                    ↑
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => move(i, 1)} disabled={i === order.length - 1} aria-label="Move down">
                    ↓
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setOrder((o) => o.filter((x) => x.id !== a.id))} aria-label="Remove">
                    ✕
                  </Button>
                </li>
              ))}
            </ol>
          </div>
          {/* Intercut mode — group the ordered clips into parallel
              storylines that rotate on the cut grid. */}
          <div className="flex flex-wrap items-end gap-4 text-sm border-t border-slate-800 pt-3">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={settings.mode === "intercut"} onChange={(e) => set("mode", e.target.checked ? "intercut" : "flat")} />
              <span className="text-slate-300">Intercut — several storylines unfold in parallel</span>
            </label>
            {settings.mode === "intercut" && (
              <>
                <label className="space-y-1">
                  <span className="text-slate-400 text-xs">Storylines</span>
                  <select className="ui-input" value={settings.storylineCount} onChange={(e) => set("storylineCount", Number(e.target.value))}>
                    {[2, 3, 4, 6, 8].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-slate-400 text-xs">Slots per storyline</span>
                  <select className="ui-input" value={settings.slotsPerSlice} onChange={(e) => set("slotsPerSlice", Number(e.target.value))}>
                    {[1, 2, 4].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-slate-400 text-xs">When a storyline runs out</span>
                  <select className="ui-input" value={settings.endOfMaterial} onChange={(e) => set("endOfMaterial", e.target.value as "loop" | "retire")}>
                    <option value="loop">Loop it</option>
                    <option value="retire">Retire it</option>
                  </select>
                </label>
                <p className="text-[11px] text-slate-500 pb-1">Assign each clip a storyline (SL#) above; clips inside a storyline play in order, continuously.</p>
              </>
            )}
          </div>
        </div>
      </Card>

      {/* 3. Cuts & output */}
      <Card className="p-5 space-y-4">
        <SectionTitle icon="✂">3. Cuts, retiming & output</SectionTitle>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={settings.autoBeats} onChange={(e) => set("autoBeats", e.target.checked)} />
          Automatic beat detection (cut on beats detected in the waveform)
        </label>
        {settings.autoBeats ? (
          <div className="space-y-3">
            <label className="flex items-center gap-3 text-sm">
              <span className="text-slate-400 w-20 shrink-0">Cut on</span>
              <select
                className="ui-input"
                value={settings.cutSource}
                onChange={(e) => set("cutSource", e.target.value as CutSource)}
                aria-label="Cut on"
              >
                <option value="beats">Beats — every detected beat</option>
                <option value="every_n">Every N beats</option>
                <option value="bars">Bars (downbeats)</option>
                <option value="stem">Stem hits</option>
                <option value="sections">Auto by section</option>
              </select>
            </label>

            {settings.cutSource === "every_n" && (
              <div className="flex flex-wrap gap-4 text-sm">
                <label className="space-y-1">
                  <span className="text-slate-400">Every N beats</span>
                  <select className="ui-input" value={settings.cutEvery} onChange={(e) => set("cutEvery", Number(e.target.value))}>
                    {CUT_EVERY_OPTIONS.map((n) => (
                      <option key={n} value={n}>
                        {n === 1 ? "Every beat" : `Every ${n} beats`}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-slate-400">Start offset (beats)</span>
                  <NumberInput min={0} max={7} step={1} value={settings.beatOffset} onCommit={(v) => set("beatOffset", Math.round(v))} />
                </label>
              </div>
            )}

            {settings.cutSource === "bars" && (
              <div className="flex flex-wrap items-end gap-4 text-sm">
                <label className="space-y-1">
                  <span className="text-slate-400">Meter</span>
                  <select className="ui-input" value={settings.barsMeter} onChange={(e) => set("barsMeter", Number(e.target.value) as 3 | 4)}>
                    <option value={4}>4/4</option>
                    <option value={3}>3/4</option>
                  </select>
                </label>
                <p className="text-xs text-slate-500 pb-1">
                  Bar phase is picked automatically — the beat position with the strongest summed onset strength starts each bar.
                </p>
              </div>
            )}

            {settings.cutSource === "stem" && (
              <div className="flex flex-wrap gap-4 text-sm">
                <label className="space-y-1">
                  <span className="text-slate-400">Type</span>
                  <select className="ui-input" value={stemExtFilter} onChange={(e) => onStemExtFilter(e.target.value as "all" | "wav" | "mp3")} aria-label="Stem type filter">
                    <option value="all">All</option>
                    <option value="wav">WAV</option>
                    <option value="mp3">MP3</option>
                  </select>
                </label>
                <label className="space-y-1 min-w-56">
                  <span className="text-slate-400">Stem</span>
                  <select className="ui-input w-full" value={settings.stemName} onChange={(e) => set("stemName", e.target.value)}>
                    <option value="">{filteredStemList.length ? "Select a stem…" : vizStemList.length ? "No matching stems" : "No stems in the pool"}</option>
                    {filteredStemList.map((s) => (
                      <option key={s.name} value={s.name}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-slate-400">Band</span>
                  <select className="ui-input" value={settings.stemBand} onChange={(e) => set("stemBand", e.target.value as Settings["stemBand"])}>
                    <option value="full">Full spectrum</option>
                    <option value="kick">Kick (&lt;150 Hz)</option>
                    <option value="snare_hat">Snare / hats</option>
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-slate-400">Min gap (s)</span>
                  <NumberInput min={0.05} max={2} step={0.05} value={settings.stemMinGap} onCommit={(v) => set("stemMinGap", v)} />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-400">Threshold (0–1)</span>
                  <NumberInput min={0} max={1} step={0.01} value={settings.stemThreshold} onCommit={(v) => set("stemThreshold", v)} />
                </label>
                {vizStemList.length === 0 && (
                  <p className="text-xs text-slate-500 self-end">No stems yet — upload or split one on the Visualizer page first.</p>
                )}
              </div>
            )}

            {settings.cutSource === "sections" && (
              <div className="space-y-2 text-sm">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={settings.sectionAuto} onChange={(e) => set("sectionAuto", e.target.checked)} />
                  Auto density — the song is split into energy sections; louder sections get more cuts (quiet → every 4 beats, medium → 2, loud → 1)
                </label>
                {!settings.sectionAuto && (
                  <div className="flex flex-wrap gap-4">
                    {(
                      [
                        ["Quiet sections", "sectionQuiet"],
                        ["Medium sections", "sectionMedium"],
                        ["Loud sections", "sectionLoud"],
                      ] as Array<[string, "sectionQuiet" | "sectionMedium" | "sectionLoud"]>
                    ).map(([label, key]) => (
                      <label key={key} className="space-y-1">
                        <span className="text-slate-400">{label} — cut every</span>
                        <select className="ui-input" value={settings[key]} onChange={(e) => set(key, Number(e.target.value))}>
                          {SECTION_DENSITY_OPTIONS.map((n) => (
                            <option key={n} value={n}>
                              {n} beat{n === 1 ? "" : "s"}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-4 text-sm" role="radiogroup" aria-label="Cut mode">
              {CUT_MODES.map((m) => (
                <label key={m.value} className="flex items-center gap-2">
                  <input type="radio" name="cut-mode" checked={settings.beatsPerCut === m.value} onChange={() => set("beatsPerCut", m.value)} />
                  {m.label}
                </label>
              ))}
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="space-y-1">
                <span className="text-slate-400">Manual BPM</span>
                <input type="number" min={20} max={300} className="ui-input w-full" value={settings.manualBpm ?? ""} onChange={(e) => set("manualBpm", e.target.value === "" ? undefined : Number(e.target.value))} />
              </label>
              <label className="space-y-1">
                <span className="text-slate-400">First cut at (s)</span>
                <NumberInput min={0} max={600} step={0.001} value={settings.manualOffsetSeconds} onCommit={(v) => set("manualOffsetSeconds", v)} />
              </label>
            </div>
          </>
        )}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <label className="space-y-1">
            <span className="text-slate-400">Max speed-up (×)</span>
            <NumberInput min={1} max={4} step={0.05} value={settings.maxSpeedUp} onCommit={(v) => set("maxSpeedUp", v)} />
          </label>
          <label className="space-y-1">
            <span className="text-slate-400">Max slow-down (×)</span>
            <NumberInput min={0.25} max={1} step={0.05} value={settings.maxSlowDown} onCommit={(v) => set("maxSlowDown", v)} />
          </label>
          <label className="space-y-1">
            <span className="text-slate-400">Aspect</span>
            <select className="ui-input w-full" value={settings.aspect} onChange={(e) => set("aspect", e.target.value as Settings["aspect"])}>
              <option value="16:9">16:9</option>
              <option value="9:16">9:16</option>
              <option value="1:1">1:1</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-slate-400">Max height (px)</span>
            <select className="ui-input w-full" value={settings.maxOutputHeight} onChange={(e) => set("maxOutputHeight", Number(e.target.value))}>
              {[720, 1080, 1440, 2160].map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-slate-400">FPS</span>
            <select className="ui-input w-full" value={settings.fps} onChange={(e) => set("fps", Number(e.target.value))}>
              {[24, 25, 30, 50, 60].map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap gap-6 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={settings.loopSource} onChange={(e) => set("loopSource", e.target.checked)} />
            Loop source videos (off = video ends when footage runs out)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={settings.allowExtremeRetime} onChange={(e) => set("allowExtremeRetime", e.target.checked)} />
            Allow retiming beyond the limits when nothing fits
          </label>
          <label className="flex items-center gap-2" title="Shift each clip's in-point so a detected motion peak lands on the cut">
            <input type="checkbox" checked={settings.alignMotion} onChange={(e) => set("alignMotion", e.target.checked)} />
            Align motion to cuts
            {settings.alignMotion && (
              <span className="flex items-center gap-1 text-slate-400">
                ±
                <NumberInput min={0.05} max={2} step={0.05} value={settings.motionWindow} onCommit={(v) => set("motionWindow", v)} />
                s
              </span>
            )}
          </label>
        </div>
        <p className="text-xs text-slate-500">Output: MP4 · H.264 · original song audio (AAC, never retimed) · never upscaled beyond the largest source.</p>
        <div className="flex flex-wrap gap-3">
          <Button variant="primary" onClick={buildPlan} disabled={!canPlan}>
            {planning ? "Building edit list…" : "Build edit list"}
          </Button>
          <Button
            variant={plan && !rendering ? "success" : "secondary"}
            className={plan && !rendering ? "px-6 py-2.5 text-base font-semibold shadow-lg shadow-emerald-950/50" : ""}
            onClick={render}
            disabled={!plan || rendering}
          >
            {rendering ? "Rendering…" : "▶ Render MP4"}
          </Button>
          {plan && (
            <Button variant="ghost" onClick={() => downloadJson(`${song.replace(/\.[^.]+$/, "")}-edl.json`, plan)}>
              Download EDL (JSON)
            </Button>
          )}
        </div>
      </Card>

      {/* 4. Plan */}
      {plan && (
        <Card className="p-5 space-y-4">
          <SectionTitle icon="▬">4. Edit decision list</SectionTitle>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <StatCard
              label="Cut mode"
              value={plan.grid?.label ?? (plan.timing === "detected_beats" ? cutLabel : `${cutLabel} (manual grid)`)}
              sublabel={
                plan.grid
                  ? `${plan.grid.cutCount} cuts · ${plan.grid.source.replace(/_/g, " ")}`
                  : plan.timing === "detected_beats"
                    ? "detected beats"
                    : `${plan.bpm} BPM grid`
              }
            />
            <StatCard
              label="Clips"
              value={plan.stats.segmentCount}
              sublabel={
                plan.intercut
                  ? `intercut · ${plan.intercut.storylines.length} storylines · ${plan.intercut.slotsPerSlice} slot${plan.intercut.slotsPerSlice === 1 ? "" : "s"}/slice · ${plan.intercut.endOfMaterial}`
                  : `${plan.width}×${plan.height} @ ${plan.fps} fps`
              }
            />
            <StatCard label="Average clip" value={`${plan.stats.averageClipDuration.toFixed(3)} s`} sublabel={`${plan.stats.minClipDuration.toFixed(3)}–${plan.stats.maxClipDuration.toFixed(3)} s`} />
            <StatCard label="Retimed clips" value={plan.stats.retimedCount} sublabel={`speed ${plan.stats.minSpeed.toFixed(3)}×–${plan.stats.maxSpeed.toFixed(3)}×`} tone={plan.stats.retimedCount ? "warn" : "default"} />
            <StatCard label="Looped clips" value={plan.stats.loopedCount} sublabel={`song ${mmss(plan.audioDuration)}`} />
            {plan.videoDuration != null && plan.videoDuration < plan.audioDuration - 0.01 && (
              <StatCard label="Video length" value={mmss(plan.videoDuration)} sublabel="ended early — footage ran out" tone="warn" />
            )}
          </div>
          {/* Cut-grid preview — a tick per clip start on the song timeline
              (there's no waveform on this page, so the strip is the preview). */}
          {plan.grid && (
            <div className="space-y-1">
              <div
                className="relative h-2.5 rounded bg-slate-800 overflow-hidden"
                title={`${plan.grid.label} — ${plan.grid.cutCount} cuts over ${plan.audioDuration.toFixed(1)}s`}
              >
                {plan.entries.map((e) => (
                  <div
                    key={e.index}
                    className="absolute top-0 bottom-0 w-px bg-sky-400/80"
                    style={{ left: `${Math.min(100, Math.max(0, (e.outputStart / plan.audioDuration) * 100))}%` }}
                  />
                ))}
              </div>
              <p className="text-[11px] text-slate-500">
                {plan.grid.label}
                {plan.grid.detail ? ` — ${plan.grid.detail}` : ""} · {plan.grid.cutCount} cuts
              </p>
            </div>
          )}
          <div className="overflow-x-auto max-h-96 overflow-y-auto">
            <table className="w-full text-xs tabular-nums">
              <thead className="text-slate-400 sticky top-0 bg-slate-900">
                <tr className="text-left">
                  <th className="p-1">#</th>
                  <th className="p-1">Output (s)</th>
                  <th className="p-1">Beats</th>
                  <th className="p-1">Source</th>
                  <th className="p-1">Source range (s)</th>
                  <th className="p-1">Speed</th>
                  {plan.intercut && <th className="p-1">Storyline</th>}
                </tr>
              </thead>
              <tbody>
                {plan.entries.slice(0, EDL_PREVIEW_ROWS).map((e) => (
                  <tr key={e.index} className="border-t border-slate-800">
                    <td className="p-1">{e.index + 1}</td>
                    <td className="p-1">
                      {e.outputStart.toFixed(3)} → {e.outputEnd.toFixed(3)}
                    </td>
                    <td className="p-1 text-slate-400">
                      {e.startBeat ?? boundaryLabel(e.startKind)} → {e.endBeat ?? boundaryLabel(e.endKind)}
                    </td>
                    <td className="p-1 truncate max-w-[16rem]" title={e.source}>
                      {e.source}
                    </td>
                    <td className="p-1">
                      {e.sourceStart.toFixed(3)} → {e.sourceEnd.toFixed(3)}
                      {e.sourceLoops > 0 && <Badge tone="violet" className="ml-1">loop ×{e.sourceLoops}</Badge>}
                      {e.restartedSource && <Badge className="ml-1">restart</Badge>}
                    </td>
                    <td className="p-1">{Math.abs(e.speed - 1) > 1e-4 ? <Badge tone="warn">{e.speed.toFixed(3)}×</Badge> : "1.000×"}</td>
                    {plan.intercut && (
                      <td className="p-1 text-slate-400 whitespace-nowrap">
                        {e.storylineName ?? "—"}
                        {(e.storylineLoop ?? 0) > 0 && <Badge tone="violet" className="ml-1">↻{e.storylineLoop}</Badge>}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {plan.intercut && plan.intercut.shortSlots > 0 && (
              <p className="text-xs text-amber-400/90 p-2">
                {plan.intercut.shortSlots} cut{plan.intercut.shortSlots === 1 ? "" : "s"} shorter than 100 ms — the cut grid is very dense for intercut; consider fewer beats per cut or wider slots.
              </p>
            )}
            {plan.entries.length > EDL_PREVIEW_ROWS && (
              <p className="text-xs text-slate-500 p-2">Showing the first {EDL_PREVIEW_ROWS} of {plan.entries.length} clips — download the EDL for all.</p>
            )}
          </div>
        </Card>
      )}

      {/* 5. Render */}
      {(job || renders.length > 0) && (
        <Card className="p-5 space-y-4">
          <SectionTitle
            icon="▶"
            action={
              <Button size="sm" variant="ghost" onClick={() => revealRender()} title="Open the renders folder in the file explorer (created on demand if empty)">
                📁 Open folder
              </Button>
            }
          >
            5. Render
          </SectionTitle>
          {job && (
            <div className="space-y-2">
              <div className="flex items-center gap-3 text-sm">
                <Badge tone={job.status === "done" ? "good" : job.status === "running" ? "info" : "bad"}>{job.status}</Badge>
                <span className="text-slate-400">
                  {job.progress.phase} {job.progress.done}/{job.progress.total}
                </span>
                {rendering && (
                  <Button size="sm" variant="danger" onClick={() => api.cancelMusicRender(job.id).then((r) => setJob(r.job))}>
                    Cancel
                  </Button>
                )}
              </div>
              {rendering && <ProgressBar value={job.progress.done} max={job.progress.total} />}
              {job.error && <p className="text-sm text-rose-300 break-words">{job.error.message}</p>}
              {job.outputUrl && (
                <video controls className="w-full max-h-[60vh] bg-black rounded" src={job.outputUrl} />
              )}
            </div>
          )}
          {renders.length > 0 && (
            <ul className="text-sm space-y-1">
              {renders.map((r) => (
                <li key={r.name} className="flex items-center gap-3">
                  <a className="text-sky-400 hover:underline truncate" href={r.url} target="_blank" rel="noreferrer">
                    {r.name}
                  </a>
                  <span className="text-slate-500 text-xs">{(r.sizeBytes / 1024 / 1024).toFixed(1)} MB</span>
                  {r.edlUrl && (
                    <a className="text-slate-400 hover:underline text-xs" href={r.edlUrl} target="_blank" rel="noreferrer">
                      EDL
                    </a>
                  )}
                  <button
                    className="text-slate-500 hover:text-sky-400 text-xs shrink-0"
                    title={`Show in folder — ${r.name}`}
                    onClick={() => revealRender(r.name)}
                  >
                    📁
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
