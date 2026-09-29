import { useEffect, useState, useCallback } from "react";
import { api, type Project, type Task } from "./api.js";
import { Dashboard } from "./pages/Dashboard.js";
import { TimelinePage } from "./pages/Timeline.js";
import { ShotReview } from "./pages/ShotReview.js";
import { Help } from "./pages/Help.js";
import { Folders } from "./pages/Folders.js";
import { SearchPage } from "./pages/Search.js";
import { Projects } from "./pages/Projects.js";
import { ImportScript } from "./pages/ImportScript.js";
import { MusicEdit } from "./pages/MusicEdit.js";
import { TasksPanel } from "./components/TasksPanel.js";
import { useToast } from "./components/useToast.js";

import { DEFAULT_PROJECT_ID, PROJECT_ID_ALL } from "@twio/shared";

type View =
  | { name: "dashboard" }
  | { name: "timeline" }
  | { name: "review"; shotId: string }
  | { name: "folders" }
  | { name: "search" }
  | { name: "projects" }
  | { name: "import" }
  | { name: "music" }
  | { name: "help" };

const PROJECT_STORAGE_KEY = "twio.activeProjectId";
const SIDEBAR_STORAGE_KEY = "twio.ui.sidebarCollapsed";
const THEME_STORAGE_KEY = "twio.theme";

const NAV_ITEMS: Array<{ key: View["name"]; label: string; icon: string; desc: string }> = [
  { key: "dashboard", label: "Dashboard", icon: "▣", desc: "Overview & actions" },
  { key: "import", label: "Import Script", icon: "♪", desc: "Paste script to create shots + timeline" },
  { key: "timeline", label: "Timeline", icon: "▬", desc: "Shot schedule" },
  { key: "music", label: "Music Edit", icon: "♫", desc: "Beat-synced music video from a song" },
  { key: "search", label: "Search", icon: "⌕", desc: "Find assets" },
  { key: "folders", label: "Folders", icon: "▤", desc: "Browse files" },
  { key: "projects", label: "Projects", icon: "◇", desc: "Manage projects" },
  { key: "help", label: "Help", icon: "?", desc: "How it works" },
];

const VIEW_SLUGS = NAV_ITEMS.map((n) => n.key) as string[];

/** URL ↔ view mapping. Every page lives at #/<slug>; shot review at
 *  #/shot/<id>. Unknown / empty hashes fall back to dashboard. */
function viewFromHash(hash: string): View {
  const [head = "", arg] = hash.replace(/^#\/?/, "").split("/");
  if (head === "shot" && arg) return { name: "review", shotId: decodeURIComponent(arg) };
  if (head && VIEW_SLUGS.includes(head)) return { name: head as Exclude<View["name"], "review"> };
  return { name: "dashboard" };
}

function hashForView(v: View): string {
  return v.name === "review" ? `#/shot/${encodeURIComponent(v.shotId)}` : `#/${v.name}`;
}

/** Single source of truth for page titles — used by the header and
 *  document.title so every page is named identically everywhere. */
function titleForView(v: View): string {
  if (v.name === "review") return "Shot Review";
  return NAV_ITEMS.find((n) => n.key === v.name)?.label ?? "Dashboard";
}

export default function App() {
  const [view, setView] = useState<View>(() => viewFromHash(window.location.hash));
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string>(() => {
    return localStorage.getItem(PROJECT_STORAGE_KEY) ?? DEFAULT_PROJECT_ID;
  });
  const [activeTaskCount, setActiveTaskCount] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1",
  );
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark",
  );
  const { push, Toasts } = useToast();

  const loadProjects = useCallback(async () => {
    try {
      const r = await api.projects();
      setProjects(r.projects);
    } catch (e) {
      console.error("Failed to load projects:", e);
    }
  }, []);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  useEffect(() => {
    localStorage.setItem(PROJECT_STORAGE_KEY, activeProjectId);
  }, [activeProjectId]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);

  // Theme switch is pure CSS: this only flips the data-theme attribute —
  // [data-theme="light"] in index.css redefines the palette variables.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  // Sync view ← URL hash (back/forward buttons, deep links, refresh).
  useEffect(() => {
    const onHash = () => setView(viewFromHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    // Normalize a bare URL to the dashboard route without adding a history entry.
    if (!window.location.hash) window.history.replaceState(null, "", "#/dashboard");
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Browser tab title follows the same title shown in the header.
  useEffect(() => {
    document.title = `${titleForView(view)} · Video Collector`;
  }, [view]);

  // Poll active task count for the sidebar badge.
  useEffect(() => {
    let poll: ReturnType<typeof setInterval> | null = null;
    const check = async () => {
      try {
        const r = await api.tasks();
        const active = r.tasks.filter((t: Task) => t.status === "running" || t.status === "paused").length;
        setActiveTaskCount(active);
      } catch { /* ignore */ }
    };
    check();
    poll = setInterval(check, 2000);
    return () => { if (poll) clearInterval(poll); };
  }, []);

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? projects[0] ?? null;
  const isAllProjects = activeProjectId === PROJECT_ID_ALL;

  function switchProject(id: string) {
    setActiveProjectId(id);
    if (id === PROJECT_ID_ALL && view.name === "timeline") {
      navigate({ name: "dashboard" });
    }
  }

  function navigate(v: View) {
    const h = hashForView(v);
    // Setting location.hash pushes a history entry and fires hashchange →
    // setView. If the hash is already correct (e.g. re-entering the same
    // shot), update state directly since no event will fire.
    if (window.location.hash === h) setView(v);
    else window.location.hash = h;
  }

  const currentNav = view.name === "review" ? "timeline" : view.name;

  return (
    <div className="flex h-screen overflow-hidden bg-slate-950">
      {/* ===== Sidebar ===== */}
      {sidebarCollapsed ? (
        <aside className="w-10 shrink-0 bg-slate-900/80 border-r border-slate-800 flex flex-col items-center py-3">
          <button
            onClick={() => setSidebarCollapsed(false)}
            title="Expand sidebar"
            className="w-7 h-7 rounded-md text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition-colors text-sm"
          >»</button>
          <div className="flex-1 flex items-center py-3">
            <span className="[writing-mode:vertical-rl] text-[10px] uppercase tracking-widest text-slate-600 select-none">
              Project
            </span>
          </div>
          {activeTaskCount > 0 && (
            <span
              className="text-[10px] bg-sky-500 text-white rounded-full px-1.5 py-0.5 font-bold"
              title="Active downloads"
            >
              {activeTaskCount}
            </span>
          )}
        </aside>
      ) : (
      <aside className="w-56 shrink-0 bg-slate-900/80 border-r border-slate-800 flex flex-col">
        {/* Logo / app name */}
        <div className="px-4 py-4 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-sky-500 to-violet-600 flex items-center justify-center text-white font-bold text-sm">
              W
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold text-slate-100 truncate">Video Collector</div>
              <div className="text-[10px] text-slate-500">Footage Studio</div>
            </div>
            <button
              onClick={() => setSidebarCollapsed(true)}
              title="Collapse sidebar"
              className="shrink-0 text-slate-600 hover:text-slate-300 transition-colors text-sm px-1"
            >«</button>
          </div>
        </div>

        {/* Project switcher */}
        <div className="px-3 py-3 border-b border-slate-800">
          <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1.5 px-1">Project</div>
          <select
            value={activeProjectId}
            onChange={(e) => switchProject(e.target.value)}
            className="ui-select w-full text-xs"
            title="Switch active project"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const active = currentNav === item.key;
            const disabled = item.key === "timeline" && isAllProjects;
            return (
              <button
                key={item.key}
                onClick={() => navigate({ name: item.key } as View)}
                disabled={disabled}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all
                  ${active
                    ? "bg-sky-600/20 text-sky-300 border border-sky-700/30"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 border border-transparent"
                  }
                  ${disabled ? "opacity-40 cursor-not-allowed" : ""}
                `}
                title={disabled ? "Select a project first" : item.desc}
              >
                <span className={`text-base w-4 text-center ${active ? "text-sky-400" : "text-slate-500"}`}>{item.icon}</span>
                <span className="flex-1 text-left">{item.label}</span>
                {item.key === "dashboard" && activeTaskCount > 0 && (
                  <span className="text-[10px] bg-sky-500 text-white rounded-full px-1.5 py-0.5 font-bold">
                    {activeTaskCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Downloads indicator */}
        <div className="px-3 py-3 border-t border-slate-800">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-slate-500">Active downloads</span>
            <span className={`font-semibold ${activeTaskCount > 0 ? "text-sky-400" : "text-slate-600"}`}>
              {activeTaskCount}
            </span>
          </div>
        </div>
      </aside>
      )}

      {/* ===== Main area ===== */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="h-14 shrink-0 bg-slate-900/50 border-b border-slate-800 flex items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <h1 className="text-base font-semibold text-slate-200">
              {titleForView(view)}
            </h1>
            {activeProject && (
              <span className="text-xs text-slate-500">
                · {activeProject.name}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {activeProject && !activeProject.isVirtual && (
              <span className="text-xs text-slate-500">
                {activeProject.counts?.shotCount ?? 0} shots · {activeProject.counts?.downloadedCount ?? 0} downloaded
              </span>
            )}
            <button
              onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
              title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              className="w-8 h-8 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-700/50 transition-colors text-sm"
            >
              {theme === "dark" ? "☀" : "☾"}
            </button>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-6">
          <div className="max-w-7xl mx-auto animate-fade-in">
            {view.name === "dashboard" && <Dashboard projectId={activeProjectId} onToast={push} onNavigate={navigate} />}
            {view.name === "timeline" && !isAllProjects && <TimelinePage onOpenShot={(id) => navigate({ name: "review", shotId: id })} projectId={activeProjectId} />}
            {view.name === "timeline" && isAllProjects && (
              <div className="text-center py-20 text-slate-500">
                <div className="text-4xl mb-3 opacity-40">◇</div>
                <p>Select a specific project to use timelines.</p>
              </div>
            )}
            {view.name === "review" && <ShotReview shotId={view.shotId} onBack={() => navigate({ name: "timeline" })} />}
            {view.name === "folders" && <Folders projectId={activeProjectId} projects={projects} />}
            {view.name === "search" && <SearchPage projectId={activeProjectId} />}
            {view.name === "projects" && <Projects onChanged={loadProjects} onSwitch={switchProject} onImport={(pid) => { switchProject(pid); navigate({ name: "import" }); }} activeProjectId={activeProjectId} />}
            {view.name === "import" && !isAllProjects && (
              <ImportScript
                projectId={activeProjectId}
                onToast={push}
                onDone={(r) => {
                  // Jump straight to the timeline the import just created —
                  // otherwise the persisted selection shows an older timeline.
                  if (r.timelineId) localStorage.setItem(`twio.selectedTimeline.${activeProjectId}`, r.timelineId);
                  navigate({ name: "timeline" });
                }}
              />
            )}
            {view.name === "import" && isAllProjects && (
              <div className="text-center py-20 text-slate-500">
                <div className="text-4xl mb-3 opacity-40">◇</div>
                <p>Select a specific project to import a script.</p>
              </div>
            )}
            {view.name === "music" && !isAllProjects && <MusicEdit projectId={activeProjectId} onToast={push} />}
            {view.name === "music" && isAllProjects && (
              <div className="text-center py-20 text-slate-500">
                <div className="text-4xl mb-3 opacity-40">◇</div>
                <p>Select a specific project to edit a music video.</p>
              </div>
            )}
            {view.name === "help" && <Help />}
          </div>
        </main>
      </div>

      {/* Floating overlays */}
      <TasksPanel />
      {Toasts}
    </div>
  );
}
