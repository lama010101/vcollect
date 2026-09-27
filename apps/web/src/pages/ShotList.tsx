import type { Shot } from "../api.js";
import { sectionFolder } from "@twio/shared";
import { Badge } from "../components/ui.js";

export function ShotList({ shots, onOpen }: { shots: Shot[]; onOpen: (id: string) => void }) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wide mb-3">100-shot creative plan</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {shots.map((s) => (
          <button
            key={s.id}
            onClick={() => onOpen(s.id)}
            className="text-left ui-card ui-card-hover p-3"
          >
            <div className="flex justify-between items-start">
              <span className="font-mono text-xs text-sky-400">{s.id}</span>
              <StatusBadge status={s.status} />
            </div>
            <div className="text-sm text-slate-200 mt-1.5">{s.visual_description}</div>
            <div className="text-xs text-slate-400 mt-1">
              {s.section} · {s.search_query}
            </div>
            <div className="text-xs text-slate-500 mt-1 font-mono">
              Collector/{sectionFolder(s.section)}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  const s = status ?? "SEARCH_PENDING";
  const tone =
    s === "DONE" ? "good" :
    s === "REVIEW" ? "warn" :
    s === "ACQUIRED" || s === "SEARCHED" ? "info" :
    s === "FAILED" ? "bad" :
    "default";
  return <Badge tone={tone}>{s}</Badge>;
}
