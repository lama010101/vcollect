import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditPlan, MusicEditSettings } from "@twio/shared";
import {
  api,
  type Asset,
  type MusicAnalysis,
  type MusicEditRequest,
  type MusicEditStatus,
  type MusicRenderJob,
  type MusicRenderedFile,
  type MusicSong,
} from "../api.js";
import { Badge, Button, Card, EmptyState, ProgressBar, SectionTitle, Spinner, StatCard } from "../components/ui.js";

/**
 * Music Edit — beat-aligned music-video editor.
 * Song → waveform beat detection (server, librosa) → edit decision list cut
 * on the detected beats → FFmpeg render with the original song untouched.
 * Source videos are the project's downloaded assets, used round-robin in the
 * order listed here.
 */

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
> & { manualBpm: number | undefined };

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
};

const CUT_MODES: Array<{ value: Settings["beatsPerCut"]; label: string }> = [
  { value: 1, label: "Every beat" },
  { value: 2, label: "Every 2 beats" },
  { value: 4, label: "Every 4 beats" },
  { value: 8, label: "Every 8 beats" },
];

const EDL_PREVIEW_ROWS = 300;

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
  const [status, setStatus] = useState<MusicEditStatus | null>(null);
  const [songs, setSongs] = useState<MusicSong[]>([]);
  const [song, setSong] = useState<string>("");
  const [uploading, setUploading] = useState(false);
  const [analysis, setAnalysis] = useState<MusicAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [library, setLibrary] = useState<Asset[]>([]);
  const [libraryQuery, setLibraryQuery] = useState("");
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [order, setOrder] = useState<Asset[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [plan, setPlan] = useState<EditPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [job, setJob] = useState<MusicRenderJob | null>(null);
  const [renders, setRenders] = useState<MusicRenderedFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    setSong("");
    setAnalysis(null);
    setOrder([]);
    setPlan(null);
    loadSongs().catch((e) => setError((e as Error).message));
    loadRenders().catch(() => {});
  }, [projectId, loadSongs, loadRenders]);

  // Downloaded project assets (debounced search).
  useEffect(() => {
    setLibraryLoading(true);
    const t = setTimeout(() => {
      api
        .searchAssetsAdvanced({ q: libraryQuery.trim() || undefined, downloadedOnly: true, sort: "newest_downloaded", limit: 200 }, projectId)
        .then((r) => setLibrary(r.assets.filter((a) => a.local_path)))
        .catch((e) => setError((e as Error).message))
        .finally(() => setLibraryLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [libraryQuery, projectId]);

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

  // Any change to inputs invalidates the previewed plan.
  useEffect(() => setPlan(null), [song, order, settings]);

  const request = useMemo<MusicEditRequest>(
    () => ({
      song,
      assetIds: order.map((a) => a.id),
      settings: { ...settings, manualBpm: settings.autoBeats ? undefined : settings.manualBpm },
    }),
    [song, order, settings],
  );

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings((s) => ({ ...s, [key]: value }));

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

  const move = (idx: number, delta: number) =>
    setOrder((o) => {
      const j = idx + delta;
      if (j < 0 || j >= o.length) return o;
      const next = [...o];
      [next[idx], next[j]] = [next[j]!, next[idx]!];
      return next;
    });

  const inOrder = new Set(order.map((a) => a.id));
  const manualInvalid = !settings.autoBeats && !(settings.manualBpm && settings.manualBpm > 0);
  const canPlan = !!song && order.length > 0 && !manualInvalid && !planning;
  const rendering = job?.status === "running";
  const cutLabel = CUT_MODES.find((m) => m.value === settings.beatsPerCut)?.label ?? "";

  return (
    <div className="space-y-6">
      {status && !status.ok && (
        <Card className="p-4 border border-amber-700/40">
          <p className="text-sm text-amber-300">
            Beat analyzer unavailable ({status.python}): {status.detail}. Install with{" "}
            <code className="text-xs">pip install -r apps/server/python/requirements.txt</code> or set PYTHON_BIN_PATH.
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
              setSong(e.target.value);
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
      <Card className="p-5 space-y-4">
        <SectionTitle icon="▤">2. Source videos (used in this order: V1 → V2 → … → V1)</SectionTitle>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <input
              className="ui-input w-full"
              placeholder="Filter downloaded videos…"
              value={libraryQuery}
              onChange={(e) => setLibraryQuery(e.target.value)}
            />
            <div className="max-h-80 overflow-y-auto space-y-1 pr-1">
              {libraryLoading && <Spinner />}
              {!libraryLoading && library.length === 0 && (
                <EmptyState icon="▤" title="No downloaded videos" description="Download footage from the Timeline or Search pages first." />
              )}
              {library.map((a) => (
                <div key={a.id} className="flex items-center gap-2 text-sm rounded px-2 py-1 hover:bg-slate-700/30">
                  <img src={api.assetThumbUrl(a.id)} alt="" className="w-16 h-9 object-cover rounded bg-slate-800" loading="lazy" />
                  <span className="flex-1 truncate" title={a.local_path ?? ""}>
                    {a.title || a.local_path}
                  </span>
                  <span className="text-slate-500 text-xs">{a.duration_seconds ? `${a.duration_seconds.toFixed(1)}s` : ""}</span>
                  <Button size="sm" disabled={inOrder.has(a.id)} onClick={() => setOrder((o) => [...o, a])}>
                    Add
                  </Button>
                </div>
              ))}
            </div>
          </div>
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
        </div>
      </Card>

      {/* 3. Cuts & output */}
      <Card className="p-5 space-y-4">
        <SectionTitle icon="✂">3. Cuts, retiming & output</SectionTitle>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={settings.autoBeats} onChange={(e) => set("autoBeats", e.target.checked)} />
          Automatic beat detection (cut on beats detected in the waveform)
        </label>
        <div className="flex flex-wrap gap-4 text-sm" role="radiogroup" aria-label="Cut mode">
          {CUT_MODES.map((m) => (
            <label key={m.value} className="flex items-center gap-2">
              <input type="radio" name="cut-mode" checked={settings.beatsPerCut === m.value} onChange={() => set("beatsPerCut", m.value)} />
              {m.label}
            </label>
          ))}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          {settings.autoBeats ? (
            <label className="space-y-1">
              <span className="text-slate-400">Start offset (beats)</span>
              <NumberInput min={0} max={7} step={1} value={settings.beatOffset} onCommit={(v) => set("beatOffset", Math.round(v))} />
            </label>
          ) : (
            <>
              <label className="space-y-1">
                <span className="text-slate-400">Manual BPM</span>
                <input type="number" min={20} max={300} className="ui-input w-full" value={settings.manualBpm ?? ""} onChange={(e) => set("manualBpm", e.target.value === "" ? undefined : Number(e.target.value))} />
              </label>
              <label className="space-y-1">
                <span className="text-slate-400">First cut at (s)</span>
                <NumberInput min={0} max={600} step={0.001} value={settings.manualOffsetSeconds} onCommit={(v) => set("manualOffsetSeconds", v)} />
              </label>
            </>
          )}
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
            Loop source videos (short clips may wrap around)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={settings.allowExtremeRetime} onChange={(e) => set("allowExtremeRetime", e.target.checked)} />
            Allow retiming beyond the limits when nothing fits
          </label>
        </div>
        <p className="text-xs text-slate-500">Output: MP4 · H.264 · original song audio (AAC, never retimed) · never upscaled beyond the largest source.</p>
        <div className="flex flex-wrap gap-3">
          <Button variant="primary" onClick={buildPlan} disabled={!canPlan}>
            {planning ? "Building edit list…" : "Build edit list"}
          </Button>
          <Button onClick={render} disabled={!plan || rendering}>
            {rendering ? "Rendering…" : "Render MP4"}
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
            <StatCard label="Cut mode" value={plan.timing === "detected_beats" ? cutLabel : `${cutLabel} (manual grid)`} sublabel={plan.timing === "detected_beats" ? "detected beats" : `${plan.bpm} BPM grid`} />
            <StatCard label="Clips" value={plan.stats.segmentCount} sublabel={`${plan.width}×${plan.height} @ ${plan.fps} fps`} />
            <StatCard label="Average clip" value={`${plan.stats.averageClipDuration.toFixed(3)} s`} sublabel={`${plan.stats.minClipDuration.toFixed(3)}–${plan.stats.maxClipDuration.toFixed(3)} s`} />
            <StatCard label="Retimed clips" value={plan.stats.retimedCount} sublabel={`speed ${plan.stats.minSpeed.toFixed(3)}×–${plan.stats.maxSpeed.toFixed(3)}×`} tone={plan.stats.retimedCount ? "warn" : "default"} />
            <StatCard label="Looped clips" value={plan.stats.loopedCount} sublabel={`song ${mmss(plan.audioDuration)}`} />
          </div>
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
                      {e.startBeat ?? (e.startKind === "audio_start" ? "start" : "grid")} → {e.endBeat ?? (e.endKind === "audio_end" ? "end" : "grid")}
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
                  </tr>
                ))}
              </tbody>
            </table>
            {plan.entries.length > EDL_PREVIEW_ROWS && (
              <p className="text-xs text-slate-500 p-2">Showing the first {EDL_PREVIEW_ROWS} of {plan.entries.length} clips — download the EDL for all.</p>
            )}
          </div>
        </Card>
      )}

      {/* 5. Render */}
      {(job || renders.length > 0) && (
        <Card className="p-5 space-y-4">
          <SectionTitle icon="▶">5. Render</SectionTitle>
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
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
