// =============================================================================
// Shared UI primitives — the design system for the whole app.
// Import { Card, StatCard, Button, Badge, ProgressBar, SectionTitle,
// EmptyState, Spinner, Toast } from this module.
// =============================================================================

import { useEffect, type ReactNode } from "react";

// --- Card -------------------------------------------------------------------

export function Card({
  children,
  className = "",
  hover = false,
  onClick,
}: {
  children: ReactNode;
  className?: string;
  hover?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={`ui-card ${hover ? "ui-card-hover cursor-pointer" : ""} ${className}`}
    >
      {children}
    </div>
  );
}

// --- StatCard ----------------------------------------------------------------

const STAT_TONES = {
  default: { ring: "border-slate-700/60", text: "text-slate-100", accent: "text-slate-400", bar: "bg-slate-500" },
  good: { ring: "border-emerald-700/40", text: "text-emerald-300", accent: "text-emerald-400/70", bar: "bg-emerald-500" },
  warn: { ring: "border-amber-700/40", text: "text-amber-300", accent: "text-amber-400/70", bar: "bg-amber-500" },
  bad: { ring: "border-rose-700/40", text: "text-rose-300", accent: "text-rose-400/70", bar: "bg-rose-500" },
  info: { ring: "border-sky-700/40", text: "text-sky-300", accent: "text-sky-400/70", bar: "bg-sky-500" },
} as const;

export function StatCard({
  label,
  value,
  sublabel,
  icon,
  tone = "default",
  progress,
  onClick,
}: {
  label: string;
  value: ReactNode;
  sublabel?: string;
  icon?: ReactNode;
  tone?: keyof typeof STAT_TONES;
  progress?: number; // 0-100
  onClick?: () => void;
}) {
  const t = STAT_TONES[tone];
  return (
    <Card onClick={onClick} className={`p-4 ${onClick ? "ui-card-hover cursor-pointer" : ""} border ${t.ring}`}>
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <div className={`text-2xl font-bold ${t.text}`}>{value}</div>
          <div className="text-xs text-slate-400 mt-0.5 truncate">{label}</div>
        </div>
        {icon && <div className={`text-lg ${t.accent} shrink-0 ml-2`}>{icon}</div>}
      </div>
      {sublabel && <div className="text-[11px] text-slate-500 mt-1">{sublabel}</div>}
      {progress != null && (
        <div className="mt-2 w-full bg-slate-700/50 rounded-full h-1 overflow-hidden">
          <div className={`${t.bar} h-full transition-all duration-500`} style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
        </div>
      )}
    </Card>
  );
}

// --- Button ------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "danger" | "success" | "ghost";
type ButtonSize = "default" | "sm";

export function Button({
  children,
  variant = "secondary",
  size = "default",
  className = "",
  ...props
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const variantCls =
    variant === "primary" ? "ui-btn-primary" :
    variant === "danger" ? "ui-btn-danger" :
    variant === "success" ? "ui-btn-success" :
    variant === "ghost" ? "ui-btn-ghost" :
    "ui-btn-secondary";
  const sizeCls = size === "sm" ? "ui-btn-sm" : "";
  return (
    <button className={`ui-btn ${variantCls} ${sizeCls} ${className}`} {...props}>
      {children}
    </button>
  );
}

// --- Badge -------------------------------------------------------------------

const BADGE_TONES = {
  default: "bg-slate-700/60 text-slate-300",
  good: "bg-emerald-900/50 text-emerald-400 border border-emerald-700/40",
  warn: "bg-amber-900/50 text-amber-400 border border-amber-700/40",
  bad: "bg-rose-900/50 text-rose-400 border border-rose-700/40",
  info: "bg-sky-900/50 text-sky-400 border border-sky-700/40",
  violet: "bg-violet-900/50 text-violet-400 border border-violet-700/40",
} as const;

export function Badge({
  children,
  tone = "default",
  className = "",
}: {
  children: ReactNode;
  tone?: keyof typeof BADGE_TONES;
  className?: string;
}) {
  return <span className={`ui-badge ${BADGE_TONES[tone]} ${className}`}>{children}</span>;
}

// --- ProgressBar -------------------------------------------------------------

export function ProgressBar({
  value,
  max = 100,
  className = "",
  color = "bg-sky-500",
  height = "h-2",
}: {
  value: number;
  max?: number;
  className?: string;
  color?: string;
  height?: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className={`w-full bg-slate-700/50 rounded-full ${height} overflow-hidden ${className}`}>
      <div className={`${color} h-full transition-all duration-500`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// --- SectionTitle ------------------------------------------------------------

export function SectionTitle({
  children,
  icon,
  action,
  className = "",
}: {
  children: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-center justify-between ${className}`}>
      <div className="flex items-center gap-2">
        {icon && <span className="text-slate-500">{icon}</span>}
        <h3 className="text-sm font-semibold text-slate-300 uppercase tracking-wide">{children}</h3>
      </div>
      {action}
    </div>
  );
}

// --- Tray (collapsed vertical panel strip) -----------------------------------

/** A collapsed panel rendered as a slim vertical tray: rotated label + a
 *  chevron that expands it back. `side` is the screen edge the panel sits on
 *  (determines chevron direction). On small screens it renders as a
 *  horizontal bar instead. */
export function Tray({
  label,
  onExpand,
  side = "left",
  className = "",
}: {
  label: string;
  onExpand: () => void;
  side?: "left" | "right";
  className?: string;
}) {
  return (
    <button
      onClick={onExpand}
      title={`Expand ${label}`}
      className={`ui-card ui-card-hover shrink-0 cursor-pointer flex items-center gap-2 px-3 py-2 lg:w-9 lg:flex-col lg:self-stretch lg:min-h-40 lg:px-0 lg:py-3 ${className}`}
    >
      <span className="text-slate-500 text-xs">{side === "left" ? "»" : "«"}</span>
      <span className="text-[10px] uppercase tracking-widest text-slate-500 select-none whitespace-nowrap lg:[writing-mode:vertical-rl]">
        {label}
      </span>
    </button>
  );
}

// --- Modal -------------------------------------------------------------------

/** Centered modal dialog — dimmed backdrop + a ui-card panel. Closes on
 *  backdrop click or Escape. */
export function Modal({
  title,
  onClose,
  children,
  className = "",
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className={`ui-card relative w-full max-w-2xl max-h-[80vh] flex flex-col animate-fade-in ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700/60 shrink-0">
          <h3 className="text-sm font-semibold text-slate-200 truncate">{title}</h3>
          <button
            onClick={onClose}
            title="Close"
            className="text-slate-500 hover:text-slate-200 transition-colors px-1"
          >✕</button>
        </div>
        <div className="overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

// --- EmptyState --------------------------------------------------------------

export function EmptyState({
  icon = "📭",
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center animate-fade-in">
      <div className="text-4xl mb-3 opacity-40">{icon}</div>
      <div className="text-sm font-medium text-slate-400">{title}</div>
      {description && <div className="text-xs text-slate-500 mt-1 max-w-sm">{description}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// --- Spinner -----------------------------------------------------------------

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v2a6 6 0 00-6 6H4z" />
    </svg>
  );
}

// --- Toast -------------------------------------------------------------------

export type ToastTone = "info" | "success" | "error";
export interface ToastMsg {
  id: string;
  tone: ToastTone;
  text: string;
}

const TOAST_STYLES: Record<ToastTone, string> = {
  info: "bg-sky-950/90 border-sky-700 text-sky-200",
  success: "bg-emerald-950/90 border-emerald-700 text-emerald-200",
  error: "bg-rose-950/90 border-rose-700 text-rose-200",
};

const TOAST_ICONS: Record<ToastTone, string> = {
  info: "ℹ",
  success: "✓",
  error: "✕",
};

export function ToastStack({ toasts, onDismiss }: { toasts: ToastMsg[]; onDismiss: (id: string) => void }) {
  return (
    <div className="fixed top-4 right-4 z-[60] space-y-2 max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`animate-slide-in flex items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg backdrop-blur ${TOAST_STYLES[t.tone]}`}
        >
          <span className="shrink-0 mt-0.5">{TOAST_ICONS[t.tone]}</span>
          <span className="flex-1">{t.text}</span>
          <button onClick={() => onDismiss(t.id)} className="shrink-0 opacity-60 hover:opacity-100">✕</button>
        </div>
      ))}
    </div>
  );
}
