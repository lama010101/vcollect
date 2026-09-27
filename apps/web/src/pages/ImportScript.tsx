import { useState, useEffect, useRef, useCallback } from "react";
import { api, type ScriptPreviewResult, type ScriptImportResult, type LlmStatus } from "../api.js";
import { Button, Badge, EmptyState, Spinner } from "../components/ui.js";

/**
 * Import Script page — paste or upload a music-video script.
 * Two parser modes:
 *   - Conventional: regex/line-based, deterministic, no AI. Requires the
 *     strict format ([MM:SS SECTION], ♪ lyrics, N. desc — Xs).
 *   - LLM: uses a free LLM (Ollama local or Groq online) to parse freeform
 *     scripts in any format — treatments, screenplays, prose, etc.
 * Live preview shows parsed shots before committing. Creates shots +
 * optionally a timeline with computed time ranges.
 */
export function ImportScript({
  projectId,
  onToast,
  onDone,
}: {
  projectId: string;
  onToast: (text: string, tone?: "info" | "success" | "error") => void;
  onDone: (result: ScriptImportResult) => void;
}) {
  const [text, setText] = useState("");
  const [parserMode, setParserMode] = useState<"conventional" | "llm">("conventional");
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  const [timelineName, setTimelineName] = useState("Main");
  const [replace, setReplace] = useState(false);
  const [preview, setPreview] = useState<ScriptPreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedFormat, setCopiedFormat] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load LLM status on mount.
  useEffect(() => {
    api.llmStatus().then(setLlmStatus).catch(() => {});
  }, []);

  const llmAvailable = llmStatus?.configured && llmStatus?.reachable;

  // Live preview — debounced parse on text change.
  // LLM mode uses a longer debounce (2s) since each call hits an API.
  const runPreview = useCallback(async (script: string, useLlm: boolean) => {
    if (script.trim().length === 0) {
      setPreview(null);
      return;
    }
    setPreviewing(true);
    setError(null);
    try {
      const r = await api.previewScript(projectId, script, useLlm);
      setPreview(r);
    } catch (e) {
      setError(`Preview failed: ${(e as Error).message}`);
      setPreview(null);
    } finally {
      setPreviewing(false);
    }
  }, [projectId]);

  // Debounce preview on text change. LLM mode gets a longer debounce.
  const debounceMs = parserMode === "llm" ? 2000 : 400;
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // Don't auto-preview in LLM mode for very short texts (avoid wasting API calls).
    if (parserMode === "llm" && text.trim().length < 20) {
      setPreview(null);
      return;
    }
    debounceRef.current = setTimeout(() => runPreview(text, parserMode === "llm"), debounceMs);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [text, parserMode, runPreview, debounceMs]);

  // Re-preview when parser mode changes.
  useEffect(() => {
    if (text.trim().length > 0) {
      runPreview(text, parserMode === "llm");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parserMode]);

  function loadSample() {
    setText(SAMPLE_SCRIPT);
  }

  async function copyFormatSample() {
    try {
      await navigator.clipboard.writeText(FORMAT_SAMPLE);
      setCopiedFormat(true);
      setTimeout(() => setCopiedFormat(false), 2000);
    } catch {
      onToast("Copy failed — clipboard unavailable.", "error");
    }
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setText(String(reader.result ?? ""));
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function doImport() {
    if (preview && preview.errors.length > 0) {
      onToast(`Cannot import: ${preview.errors.length} parse error(s).`, "error");
      return;
    }
    if (!text.trim()) {
      onToast("Script is empty.", "error");
      return;
    }
    setImporting(true);
    setError(null);
    try {
      const r = await api.importScript(projectId, text, {
        timelineName: timelineName.trim() || undefined,
        replace,
        useLlm: parserMode === "llm",
      });
      onToast(`Imported ${r.shotsCreated} shots${r.timelineId ? ` + timeline "${timelineName}"` : ""}.`, "success");
      onDone(r);
    } catch (e) {
      const msg = (e as Error).message;
      setError(`Import failed: ${msg}`);
      onToast(`Import failed: ${msg}`, "error");
    } finally {
      setImporting(false);
    }
  }

  const shotCount = preview?.shots.length ?? 0;
  const sectionCount = preview?.sections.length ?? 0;
  const hasErrors = (preview?.errors.length ?? 0) > 0;

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-200">Import Script</h2>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={loadSample}>Load sample</Button>
          <label className="cursor-pointer">
            <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>Upload file</Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.md,.script"
              onChange={handleFileUpload}
              className="hidden"
            />
          </label>
        </div>
      </div>

      {/* --- Parser mode toggle --- */}
      <div className="ui-card p-4">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setParserMode("conventional")}
              className={`px-3 py-1.5 rounded-lg text-sm transition-all ${
                parserMode === "conventional"
                  ? "bg-sky-600 text-white"
                  : "bg-slate-800 text-slate-400 hover:bg-slate-700"
              }`}
            >
              ⚙ Conventional
            </button>
            <button
              onClick={() => setParserMode("llm")}
              disabled={!llmStatus?.configured}
              className={`px-3 py-1.5 rounded-lg text-sm transition-all ${
                parserMode === "llm"
                  ? "bg-violet-600 text-white"
                  : "bg-slate-800 text-slate-400 hover:bg-slate-700"
              } ${!llmStatus?.configured ? "opacity-40 cursor-not-allowed" : ""}`}
              title={!llmStatus?.configured ? "Set LLM_PROVIDER in .env.local to enable" : ""}
            >
              ✦ LLM
            </button>
          </div>
          <div className="text-xs text-slate-500 flex-1">
            {parserMode === "conventional" ? (
              <span>Regex/line-based parser. Requires the structured format shown below. Deterministic, no AI.</span>
            ) : (
              <span>Free LLM parses any script format — treatments, screenplays, prose. {llmStatus?.provider === "ollama" ? "Runs locally via Ollama." : "Online via Groq."}</span>
            )}
          </div>
          {/* LLM status indicator */}
          {llmStatus && (
            <div className="flex items-center gap-1.5 text-xs">
              {llmStatus.configured ? (
                <>
                  <span className={`inline-block w-2 h-2 rounded-full ${llmStatus.reachable ? "bg-emerald-400" : "bg-rose-400"}`} />
                  <span className={llmStatus.reachable ? "text-emerald-400" : "text-rose-400"}>
                    {llmStatus.provider} · {llmStatus.model}
                  </span>
                  {!llmStatus.reachable && (
                    <span className="text-slate-500" title={llmStatus.error ?? ""}>unreachable</span>
                  )}
                </>
              ) : (
                <span className="text-slate-500">LLM not configured</span>
              )}
            </div>
          )}
        </div>
        {/* LLM setup hint */}
        {parserMode === "llm" && llmStatus && !llmStatus.configured && (
          <div className="mt-3 text-xs text-amber-300 bg-amber-950/30 rounded-lg p-3 border border-amber-800/30">
            <strong>To enable LLM parsing:</strong> Add to <code className="text-amber-200">.env.local</code>:
            <div className="mt-1 font-mono text-amber-200/80">
              <div>LLM_PROVIDER=ollama <span className="text-slate-500"># local, free, no key. Install ollama.com, run: ollama pull llama3.2</span></div>
              <div className="text-slate-500">— or —</div>
              <div>LLM_PROVIDER=groq <span className="text-slate-500"># online, free key from console.groq.com</span></div>
              <div>LLM_API_KEY=gsk_your_free_key_here</div>
            </div>
          </div>
        )}
        {parserMode === "llm" && llmStatus?.configured && !llmStatus.reachable && (
          <div className="mt-3 text-xs text-rose-300 bg-rose-950/30 rounded-lg p-3 border border-rose-800/30">
            <strong>LLM unreachable:</strong> {llmStatus.error}
            {llmStatus.provider === "ollama" && (
              <div className="mt-1">Make sure Ollama is running: <code className="text-rose-200">ollama serve</code> and the model is pulled: <code className="text-rose-200">ollama pull {llmStatus.model}</code></div>
            )}
            {llmStatus.provider === "groq" && (
              <div className="mt-1">Check your GROQ_API_KEY and network connection.</div>
            )}
          </div>
        )}

        {/* Import options — right under the parser buttons */}
        <div className="mt-4 pt-4 border-t border-slate-700/60 flex items-end gap-4 flex-wrap">
          <label className="min-w-40">
            <span className="text-xs text-slate-400">Timeline name</span>
            <input
              type="text"
              value={timelineName}
              onChange={(e) => setTimelineName(e.target.value)}
              placeholder="Main"
              className="ui-input w-full mt-1 text-sm"
            />
            <span className="text-[10px] text-slate-500 mt-1 block">
              Leave empty to skip timeline creation (shots only).
            </span>
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer pb-5">
            <input
              type="checkbox"
              checked={replace}
              onChange={(e) => setReplace(e.target.checked)}
              className="accent-rose-600"
            />
            Replace existing shots
            <span className="text-slate-500">(deletes all current shots in this project)</span>
          </label>
          <div className="pb-5 ml-auto">
            <Button
              variant="primary"
              onClick={doImport}
              disabled={importing || hasErrors || shotCount === 0 || (parserMode === "llm" && !llmAvailable)}
            >
              {importing ? <Spinner className="w-4 h-4" /> : "↓"} Import {shotCount > 0 ? `${shotCount} shots` : ""}
            </Button>
          </div>
        </div>
      </div>

      {error && (
        <div className="text-xs text-rose-400 bg-rose-950/40 rounded-lg p-3 border border-rose-800/40">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-4">
        {/* --- Left: script editor --- */}
        <div className="ui-card p-4">
          {parserMode === "conventional" ? (
            <>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-slate-400">Paste your script below. Format:</span>
                <button
                  onClick={copyFormatSample}
                  className={`text-[11px] transition-colors ${copiedFormat ? "text-emerald-400" : "text-slate-500 hover:text-slate-300"}`}
                  title="Copy format sample to clipboard"
                >
                  {copiedFormat ? "✓ copied" : "⧉ copy format"}
                </button>
              </div>
              <div className="text-[11px] text-slate-500 font-mono bg-slate-900/60 rounded p-2 mb-3 space-y-0.5">
                <div>[0:00 INTRO]              <span className="text-slate-600">← section header (MM:SS + name)</span></div>
                <div>[0:15-0:48 VERSE_1]       <span className="text-slate-600">← section with end time</span></div>
                <div>♪ We light the world        <span className="text-slate-600">← lyrics</span></div>
                <div>1. Description — 2s        <span className="text-slate-600">← shot (number. desc — duration)</span></div>
                <div>   search: query           <span className="text-slate-600">← optional search override</span></div>
                <div>   ref: https://...        <span className="text-slate-600">← optional reference image URL</span></div>
                <div>   priority: 5             <span className="text-slate-600">← optional priority (1-10)</span></div>
              </div>
            </>
          ) : (
            <div className="text-xs text-slate-400 mb-2">
              Paste your script in <strong>any format</strong> — treatment, screenplay, prose, bullet list. The LLM will extract shots, sections, lyrics, and durations automatically.
            </div>
          )}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={parserMode === "conventional"
              ? "[0:00 INTRO]\n♪ instrumental\n\n1. Sunlight through trees — 2s\n   search: sunlight through trees cinematic\n"
              : "Paste your music video script here in any format...\n\nExample:\n\nINTRO (0:00-0:15)\nThe video opens with warm sunlight filtering through trees.\nA wide shot of a sunny landscape.\n\nVERSE 1 (0:15-0:48)\n\"We light the world with every smile\"\nChildren playing football outdoors\nKids laughing on a playground\n"
            }
            className="w-full h-96 bg-input border border-slate-700 rounded-lg p-3 text-sm font-mono text-slate-200 resize-y focus:outline-none focus:border-sky-600"
            spellCheck={false}
          />
          <div className="flex items-center justify-between mt-2 text-xs text-slate-500">
            <span>{text.length.toLocaleString()} chars</span>
            {previewing && (
              <span className="flex items-center gap-1">
                <Spinner className="w-3 h-3" />
                {parserMode === "llm" ? "LLM parsing…" : "parsing…"}
              </span>
            )}
            {!previewing && preview && (
              <span className={hasErrors ? "text-rose-400" : "text-emerald-400"}>
                {hasErrors
                  ? `${preview.errors.length} parse error(s)`
                  : `${shotCount} shots · ${sectionCount} sections · ${fmtDuration(preview.totalDurationSeconds)}`}
              </span>
            )}
          </div>
        </div>

        {/* --- Right: preview --- */}
        <div className="space-y-3">
          {/* Parse errors */}
          {preview && preview.errors.length > 0 && (
            <div className="ui-card p-4 border-rose-800/40">
              <h3 className="text-sm font-semibold text-rose-400 mb-2">Parse errors</h3>
              <ul className="space-y-1 max-h-40 overflow-y-auto">
                {preview.errors.map((err, i) => (
                  <li key={i} className="text-xs text-rose-300 bg-rose-950/30 rounded p-2">
                    {err.line > 0 && <span className="font-mono text-rose-400">L{err.line}:</span>} {err.message}
                    {err.text && <div className="text-slate-500 font-mono mt-0.5 truncate">{err.text}</div>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Preview table */}
          {preview && !hasErrors && shotCount > 0 && (
            <div className="ui-card p-4">
              <h3 className="text-sm font-semibold text-slate-300 mb-3">Preview</h3>
              {/* Section summary */}
              <div className="flex flex-wrap gap-1.5 mb-3">
                {preview.sections.map((s) => (
                  <Badge key={s.name} tone="info">
                    {s.name} ({s.shotCount})
                  </Badge>
                ))}
              </div>
              {/* Shot table */}
              <div className="overflow-x-auto max-h-64 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="text-slate-500 sticky top-0 bg-slate-900">
                    <tr>
                      <th className="text-left px-2 py-1">#</th>
                      <th className="text-left px-2 py-1">Section</th>
                      <th className="text-left px-2 py-1">Description</th>
                      <th className="text-right px-2 py-1">Dur</th>
                      <th className="text-right px-2 py-1">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.shots.map((s) => (
                      <tr key={s.shotNumber} className="border-t border-slate-800">
                        <td className="px-2 py-1 text-slate-500 font-mono">{s.shotNumber}</td>
                        <td className="px-2 py-1 text-sky-400 font-mono whitespace-nowrap">{s.section}</td>
                        <td className="px-2 py-1 text-slate-300 truncate max-w-[180px]" title={s.visualDescription}>
                          {s.visualDescription}
                        </td>
                        <td className="px-2 py-1 text-slate-400 text-right font-mono whitespace-nowrap">
                          {s.targetDurationSeconds}s
                        </td>
                        <td className="px-2 py-1 text-slate-400 text-right font-mono whitespace-nowrap">
                          {fmtDuration(s.timeStartSeconds)}–{fmtDuration(s.timeEndSeconds)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.totalDurationSeconds > 0 && (
                <div className="text-xs text-slate-400 mt-3 pt-3 border-t border-slate-800">
                  Total duration: <span className="text-emerald-400 font-mono">{fmtDuration(preview.totalDurationSeconds)}</span>
                </div>
              )}
            </div>
          )}

          {!preview && !previewing && (
            <EmptyState
              icon="♪"
              title="No preview yet"
              description={parserMode === "llm"
                ? "Paste or upload a script in any format to see a live LLM-parsed preview."
                : "Paste or upload a script to see a live preview of parsed shots."}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  // Round to tenths — sub-second shots (0.9s) show as "0:00.9".
  const tenths = Math.round(seconds * 10);
  const frac = tenths % 10;
  const total = Math.floor(tenths / 10);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}${frac ? `.${frac}` : ""}`;
}

const FORMAT_SAMPLE = `[0:00 INTRO]              ← section header (MM:SS + name)
[0:15-0:48 VERSE_1]       ← section with end time
♪ We light the world        ← lyrics
1. Description — 2s        ← shot (number. desc — duration)
   search: query           ← optional search override
   ref: https://...        ← optional reference image URL
   priority: 5             ← optional priority (1-10)
`;

const SAMPLE_SCRIPT = `[0:00 INTRO]
♪ instrumental

1. Sunlight filtering through trees — 2s
   search: sunlight through trees cinematic

2. Wide sunny landscape — 2s
   search: sunny landscape people outdoors

3. Child looking toward sunlight — 2s
   search: child looking sunlight outdoors

[0:15 VERSE_1]
♪ We light the world with every smile
♪ Every step we take is worthwhile

4. Children playing football — 3s
   search: children playing football outdoors

5. Children on playground — 3s
   search: children playground laughing
   ref: https://images.pexels.com/photos/1234/preview.jpg

6. Two children running together — 3s
   search: kids friendship running

[0:48 CHORUS_1]
♪ We are the light, we are the world

7. Children playing wide shot — 3s
   search: children playing wide shot

8. Happy children outdoors — 2s
   search: happy children outdoors

9. Family laughing together — 3s
   search: family laughing outdoors
`;
