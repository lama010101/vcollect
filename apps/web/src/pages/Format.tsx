import { useCallback, useEffect, useRef, useState } from "react";
import type { FormatAspect } from "@twio/shared";
import { api, isImageFileName, type Asset, type FormatRenderedFile, type FormatResult } from "../api.js";
import { Badge, Button, Card, SectionTitle, Spinner } from "../components/ui.js";

/**
 * Format — reframe a video to a fixed aspect (16:9 / 9:16 / 1:1).
 * Upload a new file or pick any downloaded project asset; the server
 * center-crops to the target aspect (cover-fit — no letterbox) and never
 * upscales past the source.
 */

const ASPECTS: Array<{ value: FormatAspect; label: string; hint: string; w: number; h: number }> = [
  { value: "16:9", label: "16:9", hint: "Landscape · 1920×1080", w: 1920, h: 1080 },
  { value: "9:16", label: "9:16", hint: "Portrait · 1080×1920", w: 1080, h: 1920 },
  { value: "1:1", label: "1:1", hint: "Square · 1080×1080", w: 1080, h: 1080 },
];

const ASPECT_CSS: Record<FormatAspect, string> = { "16:9": "16 / 9", "9:16": "9 / 16", "1:1": "1 / 1" };

const ASPECT_KEY = "twio.format.aspect";

function mmss(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2);

/** Mirrors format/service.ts — biggest target-aspect rect inside the source,
 *  capped at the preset frame (never upscales). */
function outDims(sw: number, sh: number, aspect: FormatAspect): { w: number; h: number } {
  const { w: pw, h: ph } = ASPECTS.find((a) => a.value === aspect)!;
  const ar = pw / ph;
  let ow = Math.min(pw, sw);
  let oh = Math.min(ph, sh);
  if (ow / oh > ar) ow = oh * ar;
  else oh = ow / ar;
  return { w: even(ow), h: even(oh) };
}

export function Format({
  projectId,
  onToast,
}: {
  projectId: string;
  onToast: (text: string, tone?: "info" | "success" | "error") => void;
}) {
  const [library, setLibrary] = useState<Asset[]>([]);
  const [asset, setAsset] = useState<Asset | null>(null);
  // Trim window in seconds — [start, end). `duration` comes from the decoded
  // preview (loadedmetadata) with the asset row's duration as a fallback.
  const [duration, setDuration] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [aspect, setAspect] = useState<FormatAspect>(() => {
    const v = localStorage.getItem(ASPECT_KEY);
    return v === "9:16" || v === "1:1" ? v : "16:9";
  });
  const [uploading, setUploading] = useState(false);
  const [converting, setConverting] = useState(false);
  const [result, setResult] = useState<FormatResult | null>(null);
  const [renders, setRenders] = useState<FormatRenderedFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    localStorage.setItem(ASPECT_KEY, aspect);
  }, [aspect]);

  const loadLibrary = useCallback(async () => {
    const r = await api.searchAssetsAdvanced({ downloadedOnly: true, mediaType: "video", sort: "newest_downloaded", limit: 500 }, projectId);
    return r.assets.filter((a) => a.local_path && !isImageFileName(a.local_path));
  }, [projectId]);

  const loadRenders = useCallback(async () => {
    const r = await api.formatRenders(projectId);
    setRenders(r.renders);
  }, [projectId]);

  // Reset project-scoped state on switch, then reload library + renders.
  useEffect(() => {
    setAsset(null);
    setDuration(0);
    setStart(0);
    setEnd(0);
    setResult(null);
    setError(null);
    loadLibrary()
      .then(setLibrary)
      .catch((e) => setError((e as Error).message));
    loadRenders().catch(() => {});
  }, [projectId, loadLibrary, loadRenders]);

  // Selecting a source resets the trim window to the video's full length.
  const selectAsset = (a: Asset | null) => {
    setAsset(a);
    const d = a?.duration_seconds ?? 0;
    setDuration(d);
    setStart(0);
    setEnd(d);
  };

  const upload = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const r = await api.uploadProjectAsset(projectId, file);
      const list = await loadLibrary();
      setLibrary(list);
      selectAsset(list.find((a) => a.id === r.assetId) ?? r.asset ?? null);
      onToast(`Uploaded ${r.filename}`, "success");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const convert = async () => {
    if (!asset) return;
    setConverting(true);
    setError(null);
    setResult(null);
    try {
      // Only send a trim when the window is narrower than the whole video.
      const trimmed = duration > 0 && (start > 0.001 || end < duration - 0.001);
      const r = await api.formatConvert(projectId, {
        assetId: asset.id,
        aspect,
        ...(trimmed ? { start: +start.toFixed(3), end: +end.toFixed(3) } : {}),
      });
      setResult(r.file);
      setRenders((rs) => [{ name: r.file.name, url: r.file.url, sizeBytes: r.file.sizeBytes, createdAt: new Date().toISOString() }, ...rs]);
      onToast(`Reframed to ${aspect} (${r.file.width}×${r.file.height})`, "success");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setConverting(false);
    }
  };

  const reveal = (name?: string) =>
    api
      .formatReveal(projectId, name)
      .then((r) => {
        if (!r.ok) setError(r.error ?? "Could not open the folder");
      })
      .catch((e) => setError((e as Error).message));

  // Output dims the conversion will produce — shown next to the source dims.
  const out = asset?.width && asset?.height ? outDims(asset.width, asset.height, aspect) : null;

  return (
    <div className="space-y-6">
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

      {/* 1. Video */}
      <Card className="p-5 space-y-4">
        <SectionTitle icon="▣">1. Video</SectionTitle>
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="ui-select min-w-[16rem] max-w-md"
            value={asset?.id ?? ""}
            onChange={(e) => selectAsset(library.find((a) => a.id === e.target.value) ?? null)}
            aria-label="Source video"
          >
            <option value="">{library.length ? "Select a downloaded video…" : "No downloaded videos yet — upload one"}</option>
            {library.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title ?? a.local_path ?? a.id}
                {a.duration_seconds ? ` (${a.duration_seconds.toFixed(0)}s)` : ""}
              </option>
            ))}
          </select>
          <input
            ref={fileRef}
            type="file"
            accept="video/*,.mp4,.mov,.webm,.mkv,.avi,.m4v,.mpg,.mpeg"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
          <Button onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? "Uploading…" : "Upload video"}
          </Button>
          {uploading && <Spinner />}
        </div>
        {asset && (
          <div className="space-y-2">
            {/* object-cover inside a fixed-aspect box = exactly the center crop
                the server runs — what you see is the output frame. */}
            <div
              className="rounded bg-black overflow-hidden"
              style={{ aspectRatio: ASPECT_CSS[aspect], height: "40vh", maxWidth: "100%" }}
            >
              <video
                ref={videoRef}
                controls
                className="w-full h-full object-cover"
                src={api.assetFileUrl(asset.id)}
                onLoadedMetadata={(e) => {
                  // Decoded duration is authoritative — the DB row may be null.
                  const d = e.currentTarget.duration;
                  if (Number.isFinite(d) && d > 0) {
                    setDuration(d);
                    setEnd((cur) => (cur <= 0 || cur > d ? d : cur));
                  }
                }}
              />
            </div>
            <p className="text-xs text-slate-500">
              {asset.title ?? asset.local_path ?? asset.id}
              {asset.width && asset.height && out ? ` · ${asset.width}×${asset.height} → ${out.w}×${out.h}` : ""}
              {duration ? ` · ${mmss(duration)}` : ""}
            </p>

            {/* Trim — export only [start, end). Sliders clamp to a 0.05s gap;
                ⌖ buttons snap the bound to the preview's playhead. */}
            {duration > 0 && (
              <div className="space-y-1.5 max-w-xl">
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <span className="w-10">Start</span>
                  <input
                    type="range"
                    min={0}
                    max={duration}
                    step={0.05}
                    value={start}
                    onChange={(e) => setStart(Math.min(+e.target.value, end - 0.05))}
                    className="flex-1 accent-sky-500"
                  />
                  <code className="w-14 text-right text-slate-300">{start.toFixed(1)}s</code>
                  <button
                    type="button"
                    className="text-slate-500 hover:text-sky-400"
                    title="Set start to the preview's current position"
                    onClick={() => { const t = videoRef.current?.currentTime; if (t != null) setStart(Math.min(t, end - 0.05)); }}
                  >
                    ⌖
                  </button>
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <span className="w-10">End</span>
                  <input
                    type="range"
                    min={0}
                    max={duration}
                    step={0.05}
                    value={end}
                    onChange={(e) => setEnd(Math.max(+e.target.value, start + 0.05))}
                    className="flex-1 accent-sky-500"
                  />
                  <code className="w-14 text-right text-slate-300">{end.toFixed(1)}s</code>
                  <button
                    type="button"
                    className="text-slate-500 hover:text-sky-400"
                    title="Set end to the preview's current position"
                    onClick={() => { const t = videoRef.current?.currentTime; if (t != null) setEnd(Math.max(t, start + 0.05)); }}
                  >
                    ⌖
                  </button>
                </div>
                <p className="text-xs text-slate-500">
                  Export length <span className="text-slate-300 font-medium">{(end - start).toFixed(1)}s</span> of {mmss(duration)}
                  {(start > 0.001 || end < duration - 0.001) && (
                    <button
                      type="button"
                      className="ml-2 text-sky-400 hover:underline"
                      onClick={() => { setStart(0); setEnd(duration); }}
                    >
                      Reset
                    </button>
                  )}
                </p>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* 2. Format */}
      <Card className="p-5 space-y-4">
        <SectionTitle icon="◫">2. Format</SectionTitle>
        <div className="flex flex-wrap gap-3" role="radiogroup" aria-label="Output format">
          {ASPECTS.map((a) => (
            <button
              key={a.value}
              type="button"
              onClick={() => setAspect(a.value)}
              className={`rounded-lg border px-4 py-3 text-left min-w-32 transition-colors ${
                aspect === a.value
                  ? "border-sky-500 bg-sky-950/40 text-sky-200"
                  : "border-slate-700 bg-slate-900/40 text-slate-400 hover:border-slate-500 hover:text-slate-200"
              }`}
            >
              <span className="block text-sm font-semibold">{a.label}</span>
              <span className="block text-[11px] opacity-70">{a.hint}</span>
            </button>
          ))}
        </div>
        <p className="text-xs text-slate-500">
          The video is center-cropped to fill the frame — edges are cut, never letterboxed. Output is MP4 · H.264 · original audio, never upscaled past the source.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={convert} disabled={!asset || converting}>
            {converting ? "Converting…" : `▶ Convert to ${aspect}`}
          </Button>
          {converting && <Spinner />}
        </div>
      </Card>

      {/* 3. Result + previous conversions */}
      {(result || renders.length > 0) && (
        <Card className="p-5 space-y-4">
          <SectionTitle
            icon="⇩"
            action={
              <Button size="sm" variant="ghost" onClick={() => reveal()} title="Open the format folder in the file explorer">
                📁 Open folder
              </Button>
            }
          >
            3. Converted
          </SectionTitle>
          {result && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Badge tone="good">{result.width}×{result.height}</Badge>
                <span className="text-sm text-slate-300 truncate">{result.name}</span>
                {result.durationSeconds != null && (
                  <span className="text-xs text-slate-500">{result.durationSeconds.toFixed(1)}s</span>
                )}
              </div>
              <video controls className="max-h-[50vh] rounded bg-black" src={result.url} />
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
                  <button
                    className="text-slate-500 hover:text-sky-400 text-xs shrink-0"
                    title={`Show in folder — ${r.name}`}
                    onClick={() => reveal(r.name)}
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
