"use client";
// Small shared UI primitives used across the dashboard's components.
import { useEffect, useId, useState, type ReactNode } from "react";

// Stands in for window.confirm: browsers prefix native dialogs with "<origin> says" and
// give no way to suppress it, so consent steps are rendered in-page instead. Keeps the two
// things the native dialog gave us for free — Escape to dismiss, and focus on the default
// action (whichever child button carries autoFocus).
export function Modal(props: {
  title: string;
  onDismiss: () => void;
  children: ReactNode;
  actions: ReactNode;
}) {
  const titleId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  return (
    // Backdrop click dismisses; the stopPropagation keeps clicks inside the panel from doing so.
    <div className="modal-backdrop" onClick={props.onDismiss}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={titleId}>{props.title}</h3>
        {props.children}
        <div className="modal-actions">{props.actions}</div>
      </div>
    </div>
  );
}

// A small "ⓘ" button that toggles a popover with explanatory text.
export function InfoButton(props: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="info-wrap">
      <button
        type="button"
        className="info-btn"
        aria-label="More info"
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setOpen(false)}
      >
        i
      </button>
      {open && (
        <span className="info-pop" role="tooltip">
          {props.text}
        </span>
      )}
    </span>
  );
}

// The little control / variant pill used everywhere a variant is named.
export function VariantTag(props: { isControl: boolean }) {
  return (
    <span className={`vtag ${props.isControl ? "vtag-control" : "vtag-variant"}`}>
      {props.isControl ? "control" : "variant"}
    </span>
  );
}

// A chevron in a card's top-right corner that collapses / expands the card body. Chevron points
// up (⌃) when open — click to collapse; down (⌄) when collapsed — click to expand.
export function CardToggle({
  collapsed,
  onToggle,
  label,
}: {
  collapsed: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className="card-toggle"
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}`}
      title={collapsed ? "Expand" : "Collapse"}
    >
      {collapsed ? "⌄" : "⌃"}
    </button>
  );
}
