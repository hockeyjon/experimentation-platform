"use client";
// Guided-tour shared bits: the coach-mark component and the timing/count constants. The tour's
// current step lives in the ui slice (see store/uiSlice.ts); components read it and advance it.
import type { CSSProperties, ReactNode } from "react";

// How long the tour pauses before an auto-advance — long enough to read what just happened, short
// enough not to drag. The finale gets a longer beat so the "RUNNING" badge lands before the
// completion modal takes over.
export const TOUR_STEP_DELAY_MS = 1200;
export const TOUR_FINALE_DELAY_MS = 1800;
// How many interactive tips the visitor clicks through (drives the "N/12" progress counter).
export const TOUR_TIPS = 12;

// A guided-tour coach-mark: a progress badge ("Tour · N/12"), the tip copy, and a dismiss ×.
// Drop it inside a `.tour-anchor` next to the button it points at; `placement` picks the side
// it sits on (default: right of the anchor). One component for every step so the counter,
// arrow, flash, and spotlight all stay consistent. Its mere presence makes the target button
// pulse (see `.tour-anchor:has(.coach-tip)` in globals.css) — no per-step wiring needed.
export function CoachTip({
  n,
  placement,
  onClose,
  children,
  style,
}: {
  n: number;
  placement?: "left" | "above" | "corner" | "corner-left" | "corner-up-right" | "input-fixed";
  onClose: () => void;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      className={placement ? `coach-tip coach-tip-${placement}` : "coach-tip"}
      role="status"
      style={style}
    >
      <span className="toast-badge">
        Tour · {n}/{TOUR_TIPS}
      </span>
      <div className="toast-body">{children}</div>
      <button className="toast-close" aria-label="Dismiss tour tip" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
