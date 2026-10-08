// =============================================================================
// World Cam — camera-path video re-rendering via InSpatio-World on a remote GPU
// worker (Kaggle + cloudflared; see docs/inspatio-kaggle-setup.md).
//
// Flow: pick a project video → optional trim → prompt → camera-move preset →
// submit. The server generates the per-frame camera trajectory (shared math —
// the same computeCameraTrajectory that draws the SVG preview below), uploads
// it with the video to the worker, polls, and lands pred.mp4 in the project's
// assets/world folder where it registers like any other asset.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  computeCameraTrajectory,
  trajectoryPositions,
  WORLD_CAM_PRESETS,
  type WorldCamPresetId,
} from "@twio/shared";
import { api, ASSETS_CHANGED_EVENT, type WorldJob, type WorldStatusInfo, type WorldVideo } from "../api.js";
import { Badge, Button, Card, EmptyState, ProgressBar, SectionTitle, Spinner } from "../components/ui.js";

const ACTIVE: ReadonlySet<WorldJob["status"]> = new Set(["preparing", "uploading", "running", "downloading"]);

const JOB_LABEL: Record<WorldJob["status"], string> = {
  preparing: "Preparing clip",
  uploading: "Uploading to GPU worker",
  running: "Generating",
  downloading: "Downloading result",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

function jobBadgeTone(s: WorldJob["status"]): "info" | "good" | "bad" | "warn" | "default" {
  if (s === "done") return "good";
  if (s === "failed") return "bad";
  if (s === "cancelled") return "warn";
  if (ACTIVE.has(s)) return "info";
  return "default";
}

/** Top-down (X→right, Z→up) SVG sketch of the selected camera path. */
function TrajectoryPreview({ preset, strength }: { preset: WorldCamPresetId; strength: number }) {
  const pts = useMemo(() => {
    const mats = computeCameraTrajectory(preset, { frames: 90, strength });
    return trajectoryPositions(mats);
  }, [preset, strength]);

  const { d, start, end } = useMemo(() => {
    const W = 320, H = 150, PAD = 18;
    const xs = pts.map((p) => p[0]);
    const zs = pts.map((p) => p[2]);
    const x0 = Math.min(...xs, 0), x1 = Math.max(...xs, 0);
    const z0 = Math.min(...zs, 0), z1 = Math.max(...zs, 0);
    const spanX = Math.max(1e-6, x1 - x0), spanZ = Math.max(1e-6, z1 - z0);
    const scale = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanZ);
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const map = (p: [number, number, number]): [number, number] => [
      W / 2 + (p[0] - cx) * scale,
      H / 2 - (p[2] - cz) * scale, // +Z (into the scene) is up
    ];
    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${map(p)[0].toFixed(1)},${map(p)[1].toFixed(1)}`).join(" ");
    return { d, start: map(pts[0]!), end: map(pts[pts.length - 1]!) };
  }, [pts]);

  return (
    <svg viewBox="0 0 320 150" className="w-full h-36 bg-slate-950/60 rounded-lg border border-slate-800">
      <line x1="0" y1="75" x2="320" y2="75" stroke="currentColor" className="text-slate-800" strokeDasharray="3 4" />
      <path d={d} fill="none" stroke="currentColor" strokeWidth="2" className="text-sky-400" />
      <circle cx={start[0]} cy={start[1]} r="4" className="fill-emerald-400" />
      <circle cx={end[0]} cy={end[1]} r="4" className="fill-rose-400" />
      <text x={start[0] + 7} y={start[1] - 5} className="fill-emerald-400" fontSize="9">start</text>
      <text x={end[0] + 7} y={end[1] - 5} className="fill-rose-400" fontSize="9">end</text>
    </svg>
  );
}

/** Numbered walkthrough for getting a worker online — shown whenever the
 *  endpoint isn't reachable (never configured, or the tunnel died). */
function WorkerSetupGuide({
  current,
  endpointInput,
  setEndpointInput,
  onSave,
  saving,
}: {
  current: string;
  endpointInput: string;
  setEndpointInput: (v: string) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const steps: Array<{ title: string; detail: ReactNode }> = [
    {
      title: "Open a Kaggle GPU notebook",
      detail: (
        <>
          New notebook at <code>kaggle.com</code> → Settings → Accelerator → <b>GPU T4</b> (P100/L4×2 are better if offered).
        </>
      ),
    },
    {
      title: "Run the setup cells",
      detail: (
        <>
          Follow <code>docs/inspatio-kaggle-setup.md</code>: clone <code>inspatio-world-v1.5</code>, create the
          conda env, and download the checkpoints (~15 GB — Cells 1–3).
        </>
      ),
    },
    {
      title: "Start the worker on :8199",
      detail: (
        <>
          Copy <code>scripts/inspatio_worker.py</code> into the checkout and launch it (Cells 4–5) —
          <code>http://127.0.0.1:8199/health</code> should answer <code>ok:true</code>.
        </>
      ),
    },
    {
      title: "Open the cloudflared tunnel",
      detail: (
        <>
          Run the tunnel cell (Cell 6) and copy the <code>https://….trycloudflare.com</code> URL it prints.
        </>
      ),
    },
  ];
  return (
    <ol className="space-y-2.5 text-xs text-slate-400">
      {current && (
        <li className="flex items-center gap-2">
          <span className="text-slate-500">Current:</span>
          <code className="bg-slate-900/70 rounded px-2 py-0.5 text-amber-300">{current}</code>
          <Badge tone="bad">offline</Badge>
        </li>
      )}
      {steps.map((s, i) => (
        <li key={i} className="flex gap-2.5">
          <span className="shrink-0 w-4 h-4 rounded-full bg-sky-900/60 border border-sky-700/40 text-sky-300 text-[10px] font-bold flex items-center justify-center">
            {i + 1}
          </span>
          <div>
            <span className="text-slate-300">{s.title}.</span>{" "}
            <span className="text-slate-500">{s.detail}</span>
          </div>
        </li>
      ))}
      <li className="flex gap-2.5">
        <span className="shrink-0 w-4 h-4 rounded-full bg-sky-900/60 border border-sky-700/40 text-sky-300 text-[10px] font-bold flex items-center justify-center">
          5
        </span>
        <div className="flex-1 space-y-1.5">
          <div>
            <span className="text-slate-300">Paste the tunnel URL here.</span>{" "}
            <span className="text-slate-500">Saved for this session — <code>INSPATIO_ENDPOINT</code> in <code>.env.local</code> persists it.</span>
          </div>
          <div className="flex gap-2">
            <input
              className="ui-input flex-1"
              placeholder="https://xxxx.trycloudflare.com"
              value={endpointInput}
              onChange={(e) => setEndpointInput(e.target.value)}
            />
            <Button variant="primary" onClick={onSave} disabled={saving || !endpointInput.trim()}>
              {saving ? <Spinner /> : null}Save &amp; check
            </Button>
          </div>
          <p className="text-[10px] text-slate-600">
            Optional: set the same <code>INSPATIO_TOKEN</code> on the worker and in <code>.env.local</code> — the tunnel URL is public.
          </p>
        </div>
      </li>
    </ol>
  );
}

export function WorldCam({ projectId, onToast }: { projectId: string; onToast: (m: string, kind?: "success" | "error" | "info") => void }) {
  const [status, setStatus] = useState<WorldStatusInfo | null>(null);
  const [endpointInput, setEndpointInput] = useState("");
  const [editingEndpoint, setEditingEndpoint] = useState(false);
  const [videos, setVideos] = useState<WorldVideo[]>([]);
  const [videosLoading, setVideosLoading] = useState(false);
  const [assetId, setAssetId] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  const [preset, setPreset] = useState<WorldCamPresetId>("orbit_left");
  const [strength, setStrength] = useState(1);
  const [trajScale, setTrajScale] = useState(1);
  const [seed, setSeed] = useState(0);
  const [startSec, setStartSec] = useState("");
  const [durationSec, setDurationSec] = useState("");
  const [job, setJob] = useState<WorldJob | null>(null);
  const [jobs, setJobs] = useState<WorldJob[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [savingEndpoint, setSavingEndpoint] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  const loadStatus = useCallback(async () => {
    try {
      const r = await api.worldStatus();
      setStatus(r.status);
      if (!editingEndpoint) setEndpointInput(r.status.endpoint);
    } catch {
      setStatus(null);
    }
  }, [editingEndpoint]);

  const loadVideos = useCallback(async () => {
    setVideosLoading(true);
    try {
      const r = await api.worldVideos(projectId);
      setVideos(r.videos);
      setAssetId((cur) => (r.videos.some((v) => v.assetId === cur) ? cur : r.videos[0]?.assetId ?? ""));
    } catch (e) {
      onToast((e as Error).message, "error");
    } finally {
      setVideosLoading(false);
    }
  }, [projectId, onToast]);

  const loadJobs = useCallback(async () => {
    try {
      const r = await api.worldJobs(projectId);
      setJobs(r.jobs);
      const running = r.jobs.find((j) => ACTIVE.has(j.status));
      if (running) setJob(running);
    } catch {
      /* jobs list is best-effort */
    }
  }, [projectId]);

  useEffect(() => { void loadStatus(); void loadVideos(); void loadJobs(); }, [loadStatus, loadVideos, loadJobs]);

  // Refresh the source list when uploads/sync land new assets.
  useEffect(() => {
    const onChanged = () => void loadVideos();
    window.addEventListener(ASSETS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(ASSETS_CHANGED_EVENT, onChanged);
  }, [loadVideos]);

  // Poll the active job.
  useEffect(() => {
    if (!job || !ACTIVE.has(job.status)) return;
    const t = setInterval(() => {
      api.worldJob(job.id)
        .then((r) => {
          setJob(r.job);
          if (r.job.status === "done") {
            onToast("World Cam render finished — added to the project library.", "success");
            window.dispatchEvent(new Event(ASSETS_CHANGED_EVENT));
            void loadJobs();
          } else if (r.job.status === "failed") {
            onToast(`World Cam failed: ${r.job.error?.message ?? "unknown error"}`, "error");
            void loadJobs();
          }
        })
        .catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [job, onToast, loadJobs]);

  // Keep the remote log tail scrolled to the bottom.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job?.logTail]);

  const busy = !!job && ACTIVE.has(job.status);
  const workerBusy = !!status?.worker?.busy;
  const canSubmit = !!assetId && prompt.trim().length > 0 && !busy && !submitting && !!status?.reachable && !workerBusy;

  async function saveEndpoint() {
    setSavingEndpoint(true);
    try {
      const r = await api.worldSetEndpoint(endpointInput.trim());
      setStatus(r.status);
      setEndpointInput(r.status.endpoint);
      setEditingEndpoint(false);
      onToast(r.status.reachable ? "Worker reachable." : "Endpoint saved — worker did not respond yet.", r.status.reachable ? "success" : "info");
    } catch (e) {
      onToast((e as Error).message, "error");
    } finally {
      setSavingEndpoint(false);
    }
  }

  async function submit() {
    setSubmitting(true);
    try {
      const r = await api.worldStartJob(projectId, {
        assetId,
        prompt: prompt.trim(),
        preset,
        strength,
        seed: Math.floor(seed) || 0,
        trajScale,
        startSec: startSec.trim() === "" ? undefined : Number(startSec),
        durationSec: durationSec.trim() === "" ? undefined : Number(durationSec),
      });
      setJob(r.job);
    } catch (e) {
      onToast((e as Error).message, "error");
    } finally {
      setSubmitting(false);
    }
  }

  const selected = videos.find((v) => v.assetId === assetId);

  return (
    <div className="space-y-6">
      {/* ---- Worker endpoint -------------------------------------------------- */}
      <Card className="p-5 space-y-3">
        <SectionTitle
          icon="◎"
          action={
            status === null ? (
              <Badge tone="default">checking…</Badge>
            ) : status.reachable ? (
              <Badge tone="good">
                connected{status.worker?.gpu ? ` · ${status.worker.gpu}` : ""}
              </Badge>
            ) : status.configured ? (
              <Badge tone="bad">unreachable</Badge>
            ) : (
              <Badge tone="warn">not configured</Badge>
            )
          }
        >
          GPU Worker
        </SectionTitle>
        {status?.reachable && !editingEndpoint ? (
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
            <code className="bg-slate-900/70 rounded px-2 py-1 text-sky-300">{status.endpoint}</code>
            <span>({status.endpointSource === "env" ? ".env.local" : "session override"})</span>
            {status.worker?.busy && <Badge tone="warn">worker busy</Badge>}
            {status.worker?.checkpoints && (
              <span>
                checkpoints: {Object.entries(status.worker.checkpoints).map(([k, v]) => `${k} ${v ? "✓" : "✗"}`).join(" · ")}
              </span>
            )}
            <Button size="sm" variant="ghost" onClick={() => setEditingEndpoint(true)}>Change</Button>
            <Button size="sm" variant="ghost" onClick={() => void loadStatus()}>Re-check</Button>
          </div>
        ) : status?.reachable && editingEndpoint ? (
          <div className="flex gap-2">
            <input
              className="ui-input flex-1"
              placeholder="https://xxxx.trycloudflare.com"
              value={endpointInput}
              onChange={(e) => setEndpointInput(e.target.value)}
            />
            <Button variant="primary" onClick={() => void saveEndpoint()} disabled={savingEndpoint}>Save</Button>
            <Button variant="ghost" onClick={() => setEditingEndpoint(false)}>Cancel</Button>
          </div>
        ) : (
          <WorkerSetupGuide
            current={status?.configured ? status.endpoint : ""}
            endpointInput={endpointInput}
            setEndpointInput={setEndpointInput}
            onSave={() => void saveEndpoint()}
            saving={savingEndpoint}
          />
        )}
      </Card>

      {/* ---- Source video ------------------------------------------------------ */}
      <Card className="p-5 space-y-4">
        <SectionTitle icon="▤">1 · Source video</SectionTitle>
        {videosLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500"><Spinner /> Loading videos…</div>
        ) : videos.length === 0 ? (
          <EmptyState
            icon="▤"
            title="No videos in this project"
            description="Drop video files anywhere in the app or sync the project's assets folder first."
          />
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 max-h-72 overflow-y-auto pr-1">
            {videos.map((v) => (
              <button
                key={v.assetId}
                onClick={() => setAssetId(v.assetId)}
                className={`text-left rounded-lg border overflow-hidden transition-all ${
                  assetId === v.assetId
                    ? "border-sky-500 ring-2 ring-sky-500/30"
                    : "border-slate-700/60 hover:border-slate-500"
                }`}
              >
                <img src={v.thumbUrl} alt="" className="w-full h-20 object-cover bg-slate-800" loading="lazy" />
                <div className="px-2 py-1.5 bg-slate-800/50">
                  <div className="text-xs text-slate-200 truncate" title={v.title}>{v.title}</div>
                  <div className="text-[10px] text-slate-500">
                    {v.durationSeconds ? `${v.durationSeconds.toFixed(1)}s` : "?"} · {v.width ?? "?"}×{v.height ?? "?"}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
        {selected && (
          <div className="flex flex-wrap items-end gap-3 text-xs text-slate-400">
            <div>
              <label className="block mb-1">Start (s)</label>
              <input className="ui-input w-24" placeholder="0" value={startSec} onChange={(e) => setStartSec(e.target.value)} />
            </div>
            <div>
              <label className="block mb-1">Duration (s)</label>
              <input className="ui-input w-24" placeholder={selected.durationSeconds?.toFixed(1) ?? "all"} value={durationSec} onChange={(e) => setDurationSec(e.target.value)} />
            </div>
            <span className="pb-2">optional trim — short clips render much faster on the GPU worker.</span>
          </div>
        )}
      </Card>

      {/* ---- Prompt ------------------------------------------------------------ */}
      <Card className="p-5 space-y-3">
        <SectionTitle icon="♪">2 · Prompt</SectionTitle>
        <textarea
          className="ui-input w-full h-20 resize-y"
          placeholder="Describe the scene for the re-render (e.g. &quot;a neon-lit city street at night, rain, cinematic&quot;)"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </Card>

      {/* ---- Camera move ------------------------------------------------------- */}
      <Card className="p-5 space-y-4">
        <SectionTitle icon="◎">3 · Camera move</SectionTitle>
        <div className="grid md:grid-cols-[1fr_320px] gap-4">
          <div className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {WORLD_CAM_PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setPreset(p.id)}
                  title={p.description}
                  className={`rounded-lg border px-3 py-2 text-left transition-all ${
                    preset === p.id
                      ? "border-sky-500 bg-sky-600/15 ring-1 ring-sky-500/30"
                      : "border-slate-700/60 hover:border-slate-500"
                  }`}
                >
                  <div className="text-sm text-slate-200"><span className="mr-1.5 text-slate-400">{p.icon}</span>{p.label}</div>
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs text-slate-400">
              <div>
                <label className="block mb-1">Strength — {strength.toFixed(2)}</label>
                <input
                  type="range" min="0.05" max="3" step="0.05" value={strength}
                  onChange={(e) => setStrength(Number(e.target.value))}
                  className="w-full accent-sky-500"
                />
              </div>
              <div>
                <label className="block mb-1">Traj scale</label>
                <input
                  className="ui-input w-24" type="number" min="0.01" max="100" step="0.1" value={trajScale}
                  onChange={(e) => setTrajScale(Number(e.target.value) || 1)}
                  title="Extra translation multiplier applied on the worker (tunes the move to the depth model's scale)"
                />
              </div>
              <div>
                <label className="block mb-1">Seed</label>
                <input
                  className="ui-input w-24" type="number" min="0" step="1" value={seed}
                  onChange={(e) => setSeed(Number(e.target.value) || 0)}
                />
              </div>
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Path preview (top-down)</div>
            <TrajectoryPreview preset={preset} strength={strength} />
            <p className="text-[10px] text-slate-500 mt-1">
              {WORLD_CAM_PRESETS.find((p) => p.id === preset)?.description}
            </p>
          </div>
        </div>
      </Card>

      {/* ---- Submit ------------------------------------------------------------ */}
      <div className="flex items-center gap-3">
        <Button variant="primary" disabled={!canSubmit} onClick={() => void submit()}>
          {submitting || busy ? <Spinner /> : "◎"} Re-render video
        </Button>
        {!status?.reachable && <span className="text-xs text-amber-400">Worker offline — complete the GPU Worker setup above.</span>}
        {workerBusy && <span className="text-xs text-amber-400">The worker is busy with another job.</span>}
        {busy && job && (
          <Button variant="danger" size="sm" onClick={() => void api.worldCancelJob(job.id).then((r) => setJob(r.job)).catch(() => {})}>
            Cancel
          </Button>
        )}
      </div>

      {/* ---- Active job -------------------------------------------------------- */}
      {job && (
        <Card className="p-5 space-y-3">
          <SectionTitle
            icon="◈"
            action={<Badge tone={jobBadgeTone(job.status)}>{JOB_LABEL[job.status]}{job.remotePhase ? ` · ${job.remotePhase}` : ""}</Badge>}
          >
            Job {job.id.slice(0, 8)}
          </SectionTitle>
          {ACTIVE.has(job.status) && <ProgressBar value={job.status === "running" ? 60 : job.status === "downloading" ? 90 : 20} />}
          {job.error && <p className="text-sm text-rose-300">{job.error.code}: {job.error.message}</p>}
          {job.logTail && (
            <pre ref={logRef} className="max-h-48 overflow-y-auto text-[11px] leading-4 text-slate-400 bg-slate-950/70 rounded-lg p-3 font-mono whitespace-pre-wrap">
              {job.logTail}
            </pre>
          )}
          {job.status === "done" && (
            <div className="space-y-3">
              {job.resultUrl && <video controls className="w-full max-w-2xl rounded-lg bg-black" src={job.resultUrl} />}
              <div className="flex gap-2 items-center text-xs text-slate-400">
                {job.resultAssetId && (
                  <>
                    <Badge tone="good">in project library</Badge>
                    <Button size="sm" variant="secondary" onClick={() => void api.revealAsset(job.resultAssetId!)}>
                      Show in folder
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}
        </Card>
      )}

      {/* ---- History ------------------------------------------------------------ */}
      {jobs.filter((j) => j.id !== job?.id).length > 0 && (
        <Card className="p-5 space-y-2">
          <SectionTitle icon="≡">Previous runs</SectionTitle>
          <div className="space-y-1">
            {jobs.filter((j) => j.id !== job?.id).slice(0, 10).map((j) => (
              <div key={j.id} className="flex items-center gap-3 text-sm rounded px-2 py-1.5 hover:bg-slate-700/30">
                <Badge tone={jobBadgeTone(j.status)}>{JOB_LABEL[j.status]}</Badge>
                <span className="text-slate-400 text-xs">{WORLD_CAM_PRESETS.find((p) => p.id === j.request.preset)?.label ?? j.request.preset}</span>
                <span className="flex-1 truncate text-slate-500 text-xs" title={j.request.prompt}>{j.request.prompt}</span>
                <span className="text-[10px] text-slate-600">{new Date(j.startedAt).toLocaleString()}</span>
                {j.status === "done" && j.resultUrl && (
                  <a className="text-sky-400 text-xs hover:underline" href={j.resultUrl} target="_blank" rel="noreferrer">view</a>
                )}
                {j.status === "done" && j.resultAssetId && (
                  <button className="text-slate-400 text-xs hover:text-slate-200" onClick={() => void api.revealAsset(j.resultAssetId!)}>folder</button>
                )}
                {j.status === "failed" && <span className="text-rose-400/80 text-xs truncate max-w-64" title={j.error?.message}>{j.error?.message}</span>}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
