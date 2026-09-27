/**
 * 0-10 rating slider. Shows the current value (or "—" when unrated) and a
 * small "clear" button to reset to unrated.
 *
 * The slider is uncontrolled during a drag: it keeps a local value while the
 * pointer is down and only commits to the parent on pointer-up / key-up /
 * blur. This is critical because parents may re-sort assets by rating, so
 * committing on every `onChange` (which fires continuously during a drag)
 * would move the slider out from under the cursor mid-drag — causing the user
 * to start rating a *different* asset or having the drag interrupted.
 */
import { useEffect, useRef, useState } from "react";

export function RatingSlider({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (next: number | null) => void;
}) {
  // Local drag value. While dragging, the parent `value` is ignored so the
  // parent doesn't re-render/re-sort until the drag ends.
  const [local, setLocal] = useState<number>(value ?? 0);
  const [dragging, setDragging] = useState(false);
  const lastCommittedRef = useRef<number | null>(value);

  // Sync local from prop when not actively dragging.
  useEffect(() => {
    if (!dragging) {
      setLocal(value ?? 0);
      lastCommittedRef.current = value;
    }
  }, [value, dragging]);

  function commit(v: number) {
    const clamped = Math.max(0, Math.min(10, Math.round(v)));
    if (clamped !== lastCommittedRef.current) {
      lastCommittedRef.current = clamped;
      onChange(clamped);
    }
  }

  // Display value: local while dragging, prop otherwise.
  const display = dragging ? local : value;
  const sliderVal = dragging ? local : (value ?? 0);

  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={0}
        max={10}
        step={1}
        value={sliderVal}
        aria-valuenow={sliderVal}
        aria-valuemin={0}
        aria-valuemax={10}
        aria-label={`Rating ${display == null ? "unrated" : display} out of 10`}
        onChange={(e) => {
          const v = Number(e.target.value);
          setLocal(v);
          // Keyboard adjustments (no pointer down) commit immediately.
          if (!dragging) commit(v);
        }}
        onPointerDown={() => setDragging(true)}
        onPointerUp={() => {
          setDragging(false);
          commit(local);
        }}
        onPointerCancel={() => {
          setDragging(false);
          // Revert to last committed value on cancel.
          setLocal(lastCommittedRef.current ?? 0);
        }}
        onKeyUp={(e) => {
          // Arrow-key changes: commit. local is already updated by onChange.
          if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End" || e.key === "PageUp" || e.key === "PageDown") {
            commit(local);
          }
        }}
        onBlur={() => commit(local)}
        className="rating-slider flex-1 accent-sky-500 cursor-pointer"
        title="Rating 0-10"
      />
      <span
        className={`text-lg font-mono font-bold w-10 text-right ${
          display == null ? "text-slate-500" : display >= 7 ? "text-emerald-400" : display >= 4 ? "text-amber-400" : "text-rose-400"
        }`}
      >
        {display == null ? "—" : display}
      </span>
      {value != null && (
        <button
          onClick={() => {
            lastCommittedRef.current = null;
            onChange(null);
          }}
          className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-sm text-slate-300"
          title="Clear rating"
        >
          ✕
        </button>
      )}
    </div>
  );
}
