import { useEffect, useRef, useState } from "react";
import { api, type Project, type ProjectSettingsUpdate } from "../api.js";
import { Button, Badge, EmptyState } from "../components/ui.js";

/**
 * Projects management page — list, create, rename, delete projects, and
 * configure per-project acquisition settings (X/Y/Z + candidates per provider)
 * with per-setting "enforce globally" toggles.
 *
 * The virtual "All Projects" entry is shown but non-editable.
 */
export function Projects({
  onChanged,
  onSwitch,
  onImport,
  activeProjectId,
}: {
  onChanged: () => void;
  onSwitch: (id: string) => void;
  onImport: (projectId: string) => void;
  activeProjectId: string;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [expandedSettings, setExpandedSettings] = useState<string | null>(null);

  async function load() {
    try {
      const r = await api.projects();
      setProjects(r.projects);
    } catch (e) {
      setError(`Failed to load: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function create() {
    const name = newName.trim();
    if (!name) return;
    try {
      await api.createProject(name, newDesc.trim() || undefined);
      setNewName("");
      setNewDesc("");
      await load();
      onChanged();
    } catch (e) {
      setError(`Create failed: ${(e as Error).message}`);
    }
  }

  async function rename(p: Project) {
    const name = prompt("Rename project", p.name);
    if (name == null || name.trim() === p.name) return;
    try {
      await api.renameProject(p.id, name.trim());
      await load();
      onChanged();
    } catch (e) {
      setError(`Rename failed: ${(e as Error).message}`);
    }
  }

  async function remove(p: Project) {
    if (!confirm(`Delete project "${p.name}"?\n\nThis permanently deletes all its shots, timelines, assets, rights reviews, and the on-disk footage folder. This cannot be undone.`)) return;
    try {
      await api.deleteProject(p.id);
      await load();
      onChanged();
    } catch (e) {
      setError(`Delete failed: ${(e as Error).message}`);
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-slate-200">Projects</h2>
      {error && <div className="text-xs text-rose-400 bg-rose-950/40 rounded-lg p-2 border border-rose-800/40">{error}</div>}

      {/* Create form */}
      <div className="ui-card p-4">
        <h3 className="text-sm font-semibold text-slate-300 mb-3">New project</h3>
        <div className="flex gap-2 flex-wrap">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Project name"
            className="ui-input flex-1 min-w-[200px]"
          />
          <input
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="Description (optional)"
            className="ui-input flex-1 min-w-[200px]"
          />
          <Button variant="primary" onClick={create} disabled={!newName.trim()}>Create</Button>
        </div>
      </div>

      {/* Project list */}
      <div className="grid grid-cols-1 gap-3">
        {loading && <p className="text-sm text-slate-400">Loading projects…</p>}
        {!loading && projects.length === 0 && (
          <EmptyState icon="◇" title="No projects yet" description="Create your first project above to get started." />
        )}
        {projects.map((p) => (
          <div
            key={p.id}
            className={`ui-card border-2 ${activeProjectId === p.id ? "border-sky-600/60 bg-sky-950/20" : "border-slate-700/60"}`}
          >
            <div className="p-4">
              <div className="flex justify-between items-start">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="font-semibold text-slate-100 truncate">{p.name}</div>
                    {p.isVirtual && <Badge tone="default">virtual</Badge>}
                    {activeProjectId === p.id && <Badge tone="info">active</Badge>}
                  </div>
                  {p.description && <div className="text-xs text-slate-400 truncate mt-0.5">{p.description}</div>}
                </div>
                {!p.isVirtual && (
                  <div className="flex gap-1 ml-2 shrink-0">
                    <button onClick={() => rename(p)} className="text-xs px-2 py-1 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300" title="Rename" aria-label={`Rename ${p.name}`}>✎</button>
                    <button onClick={() => remove(p)} className="text-xs px-2 py-1 rounded-lg bg-rose-800 hover:bg-rose-700 text-white" title="Delete" aria-label={`Delete ${p.name}`}>✕</button>
                  </div>
                )}
              </div>
              <div className="text-xs text-slate-400 mt-3 flex gap-3">
                <Badge tone="info">{p.counts?.shotCount ?? 0} shots</Badge>
                <Badge tone="default">{p.counts?.assetCount ?? 0} assets</Badge>
                <Badge tone="good">{p.counts?.downloadedCount ?? 0} downloaded</Badge>
              </div>
              <div className="flex gap-2 mt-3">
                <Button
                  variant={activeProjectId === p.id ? "primary" : "secondary"}
                  size="sm"
                  onClick={() => onSwitch(p.id)}
                >
                  {activeProjectId === p.id ? "✓ Active" : "Switch to"}
                </Button>
                {!p.isVirtual && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onImport(p.id)}
                  >
                    ♪ Import Script
                  </Button>
                )}
                {!p.isVirtual && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setExpandedSettings(expandedSettings === p.id ? null : p.id)}
                  >
                    {expandedSettings === p.id ? "− Hide settings" : "⚙ Acquisition settings"}
                  </Button>
                )}
              </div>
            </div>
            {!p.isVirtual && expandedSettings === p.id && (
              <ProjectSettingsPanel project={p} onSaved={load} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Per-project acquisition settings panel ----------------------------------

function ProjectSettingsPanel({ project, onSaved }: { project: Project; onSaved: () => void }) {
  // Local state mirrors the project's settings; null = not set (use shared default).
  const [acquireCount, setAcquireCount] = useState<string>(project.acquireCount == null ? "" : String(project.acquireCount));
  const [enforceAcquireCount, setEnforceAcquireCount] = useState<boolean>(project.enforceAcquireCount ?? false);
  const [minCandidates, setMinCandidates] = useState<string>(project.minCandidates == null ? "" : String(project.minCandidates));
  const [enforceMinCandidates, setEnforceMinCandidates] = useState<boolean>(project.enforceMinCandidates ?? false);
  const [minAcquireRating, setMinAcquireRating] = useState<string>(project.minAcquireRating == null ? "" : String(project.minAcquireRating));
  const [enforceMinAcquireRating, setEnforceMinAcquireRating] = useState<boolean>(project.enforceMinAcquireRating ?? false);
  const [candidatesPerProvider, setCandidatesPerProvider] = useState<string>(project.candidatesPerProvider == null ? "" : String(project.candidatesPerProvider));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const msgTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => { if (msgTimeoutRef.current) clearTimeout(msgTimeoutRef.current); };
  }, []);

  // Resync local state when the project prop changes (e.g. after save reload
  // or when a different project's panel is expanded).
  useEffect(() => {
    setAcquireCount(project.acquireCount == null ? "" : String(project.acquireCount));
    setEnforceAcquireCount(project.enforceAcquireCount ?? false);
    setMinCandidates(project.minCandidates == null ? "" : String(project.minCandidates));
    setEnforceMinCandidates(project.enforceMinCandidates ?? false);
    setMinAcquireRating(project.minAcquireRating == null ? "" : String(project.minAcquireRating));
    setEnforceMinAcquireRating(project.enforceMinAcquireRating ?? false);
    setCandidatesPerProvider(project.candidatesPerProvider == null ? "" : String(project.candidatesPerProvider));
  }, [project.id, project.updatedAt]);

  async function save() {
    setSaving(true);
    setMsg(null);
    const settings: ProjectSettingsUpdate = {};
    // Parse each field: empty string → null (clear), else the number.
    settings.acquireCount = acquireCount.trim() === "" ? null : Number(acquireCount);
    settings.enforceAcquireCount = enforceAcquireCount;
    settings.minCandidates = minCandidates.trim() === "" ? null : Number(minCandidates);
    settings.enforceMinCandidates = enforceMinCandidates;
    settings.minAcquireRating = minAcquireRating.trim() === "" ? null : Number(minAcquireRating);
    settings.enforceMinAcquireRating = enforceMinAcquireRating;
    settings.candidatesPerProvider = candidatesPerProvider.trim() === "" ? null : Number(candidatesPerProvider);
    try {
      await api.updateProjectSettings(project.id, settings);
      setMsg({ ok: true, text: "Saved." });
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setSaving(false);
      if (msgTimeoutRef.current) clearTimeout(msgTimeoutRef.current);
      msgTimeoutRef.current = setTimeout(() => setMsg(null), 3000);
    }
  }

  return (
    <div className="border-t border-slate-700/40 p-4 bg-slate-900/40">
      <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wide mb-3">Acquisition settings</h4>
      <p className="text-xs text-slate-500 mb-3">
        Set project-wide defaults for acquisition. When <strong>Enforce</strong> is checked, the project value overrides any per-shot override. When unchecked, per-shot values take precedence (falling back to the project value, then the shared default).
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <SettingRow
          label="Acquire count (Y)"
          description="Max candidates to download per shot"
          value={acquireCount}
          onChange={setAcquireCount}
          enforce={enforceAcquireCount}
          onEnforceChange={setEnforceAcquireCount}
          placeholder="e.g. 3"
          min={1} max={20}
        />
        <SettingRow
          label="Min candidates (X)"
          description="Minimum candidate pool to gather"
          value={minCandidates}
          onChange={setMinCandidates}
          enforce={enforceMinCandidates}
          onEnforceChange={setEnforceMinCandidates}
          placeholder="e.g. 10"
          min={1} max={100}
        />
        <SettingRow
          label="Min acquire rating (Z)"
          description="Final-score threshold (0.0–1.0)"
          value={minAcquireRating}
          onChange={setMinAcquireRating}
          enforce={enforceMinAcquireRating}
          onEnforceChange={setEnforceMinAcquireRating}
          placeholder="e.g. 0.5"
          min={0} max={1} step={0.05}
        />
        <SettingRow
          label="Candidates per provider"
          description="Results per provider per query (no per-shot override)"
          value={candidatesPerProvider}
          onChange={setCandidatesPerProvider}
          enforce={true}
          onEnforceChange={() => {}}
          enforceDisabled
          placeholder="e.g. 15"
          min={1} max={50}
        />
      </div>
      <div className="flex items-center gap-3 mt-3">
        <Button variant="primary" size="sm" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save settings"}
        </Button>
        {msg && <span className={`text-xs ${msg.ok ? "text-emerald-400" : "text-rose-400"}`}>{msg.text}</span>}
      </div>
    </div>
  );
}

function SettingRow({
  label,
  description,
  value,
  onChange,
  enforce,
  onEnforceChange,
  placeholder,
  min,
  max,
  step,
  enforceDisabled,
}: {
  label: string;
  description: string;
  value: string;
  onChange: (v: string) => void;
  enforce: boolean;
  onEnforceChange: (v: boolean) => void;
  placeholder: string;
  min: number;
  max: number;
  step?: number;
  enforceDisabled?: boolean;
}) {
  return (
    <div className="rounded-lg bg-slate-800/60 border border-slate-700/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <label className="text-xs font-semibold text-slate-300">{label}</label>
        <label className={`flex items-center gap-1 text-xs ${enforceDisabled ? "text-slate-600" : "text-violet-400"}`} title={enforceDisabled ? "No per-shot override exists for this setting" : "When checked, this project value overrides per-shot settings"}>
          <input
            type="checkbox"
            checked={enforce}
            onChange={(e) => onEnforceChange(e.target.checked)}
            disabled={enforceDisabled}
            className="accent-violet-600"
          />
          Enforce
        </label>
      </div>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
        className="ui-input w-full mt-1.5"
      />
      <p className="text-xs text-slate-500 mt-1.5">{description}</p>
    </div>
  );
}
