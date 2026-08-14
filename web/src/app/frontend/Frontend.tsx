"use client";
// The Frontend tab: the experiment cards on the left, an optional "Ask Claude" pane on the right,
// and a draggable divider between them. Which experiment is shown comes from the store (the picker
// lives in the Dashboard's tab bar).
import { useCallback, useRef, useState } from "react";
import { useAppSelector } from "@/store";
import StatisticTable from "./StatisticTable";
import EnrollCustomers from "./EnrollCustomers";
import EnrolledCustomers from "./EnrolledCustomers";
import Claude from "./Claude";

export default function Frontend() {
  const active = useAppSelector((s) => s.ui.tab === "frontend");
  const claudeOpen = useAppSelector((s) => s.ui.claudeOpen);
  const restarting = useAppSelector((s) => s.experiments.restarting);
  const selectedKey = useAppSelector((s) => s.experiments.selectedKey);
  const selected = useAppSelector(
    (s) => s.experiments.items.find((e) => e.key === s.experiments.selectedKey) ?? null,
  );
  const assignments = useAppSelector((s) => s.experiments.assignments);

  const [claudeWidth, setClaudeWidth] = useState(20);
  const splitRef = useRef<HTMLDivElement>(null);

  // Drag the divider to re-split the experiment pane vs. the Claude pane (clamped 22–55%).
  const startDrag = useCallback((e: { preventDefault: () => void }) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      const el = splitRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setClaudeWidth(Math.min(55, Math.max(22, ((rect.right - ev.clientX) / rect.width) * 100)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  }, []);

  return (
    <div className="split" ref={splitRef} style={{ display: active ? "flex" : "none" }}>
      <section className="exp-pane">
        {/* The statistics card is a fixed header — it doesn't scroll, so nothing bleeds underneath
            it. Only the enroll + board cards live in the scroll region below. */}
        {selected && (
          <div className="exp-header">
            <StatisticTable
              experiment={selected}
              users={assignments.filter((a) => a.experimentKey === selected.key)}
            />
          </div>
        )}
        <div className="exp-cards">
          {selected ? (
            <>
              {/* key forces a fresh EnrollCustomers (input, variant select, pill) per experiment */}
              <EnrollCustomers
                key={selected.key}
                experimentKey={selected.key}
                variants={selected.variants}
              />
              <EnrolledCustomers experimentKey={selected.key} variants={selected.variants} />
            </>
          ) : restarting ? (
            <div className="restart-panel" role="status" aria-live="polite">
              <span className="spinner spinner-lg" aria-hidden="true" />
              <p>Loading…</p>
              <p className="muted small">
                api and stats are being recreated. Experiments reload automatically once the API
                reports ready — usually about 20 seconds.
              </p>
            </div>
          ) : (
            <p className="muted">Loading…</p>
          )}
        </div>
      </section>

      {claudeOpen && (
        <div
          className="split-divider"
          onMouseDown={startDrag}
          role="separator"
          aria-orientation="vertical"
          aria-label="Drag to resize the experiment and Claude panes"
        />
      )}

      <aside
        className={`claude-pane${claudeOpen ? " open" : ""}`}
        style={{ width: claudeOpen ? `${claudeWidth}%` : 0 }}
      >
        <Claude selectedKey={selectedKey} />
      </aside>
    </div>
  );
}
