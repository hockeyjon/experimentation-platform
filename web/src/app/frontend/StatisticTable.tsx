"use client";
// The results table: per-variant exposures / successes / rate / lift / p-value, driven by the
// Python stats service over SSE (falling back to local board counts until the first frame lands).
// Also carries the Launch / Roll-back actions and the tour's final Launch tip.
import { useState } from "react";
import { useAppDispatch, useAppSelector } from "@/store";
import { setTourStep } from "@/store/uiSlice";
import { setStatus, AssignedUser, Experiment } from "@/store/experimentsSlice";
import { CardToggle, InfoButton, VariantTag } from "../ui";
import { CoachTip } from "../tour";

export default function StatisticTable(props: { experiment: Experiment; users: AssignedUser[] }) {
  const dispatch = useAppDispatch();
  const tourStep = useAppSelector((s) => s.ui.tourStep);
  const { experiment, users } = props;
  const running = experiment.status === "RUNNING";
  const [collapsed, setCollapsed] = useState(false);

  // The control variant is the one flagged in the experiment definition (not inferred).
  const controlVariant = experiment.variants.find((v) => v.isControl) ?? experiment.variants[0];

  // Backend numbers, pushed from the Python stats service over SSE (see useStatsStream).
  const pushed = useAppSelector((s) => s.experiments.significanceByKey[experiment.key]);
  const byKey = new Map((pushed?.variants ?? []).map((v) => [v.variantKey, v]));

  // Rows are always driven by the experiment's own variant order, never the payload's, so
  // a push can't reorder the table under the reader. Until the first frame arrives we fall
  // back to counting the local board, so the table is never blank.
  const rows = experiment.variants.map((v) => {
    const stat = byKey.get(v.key);
    if (stat) {
      return {
        v,
        exposures: stat.exposures,
        conversions: stat.conversions,
        rate: stat.conversionRate,
        lift: stat.liftPct / 100,
        pValue: stat.pValue,
        significant: stat.significant,
      };
    }
    const inVariant = users.filter((u) => u.variantKey === v.key);
    const exposures = inVariant.length;
    const conversions = inVariant.filter((u) => u.converted).length;
    return {
      v,
      exposures,
      conversions,
      rate: exposures > 0 ? conversions / exposures : 0,
      lift: null,
      pValue: null,
      significant: false,
    };
  });

  // Only needed for the local fallback — when the backend is driving, it sends lift itself.
  const controlRow = rows.find((r) => r.v.key === controlVariant?.key);
  const controlRate = controlRow && controlRow.exposures > 0 ? controlRow.rate : 0;

  return (
    <div className="card">
      <CardToggle collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} label="results" />
      <h3 className="card-title">
        {experiment.name}
        <span className={`badge ${experiment.status}`}>{experiment.status}</span>
        <InfoButton text={experiment.description ?? "No description."} />
      </h3>

      {!collapsed && (
      <>
      {/* The table always renders. With nobody enrolled every row is simply zeroed — the
          shape of the results stays on screen instead of appearing once traffic arrives. */}
      <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Variant</th>
            <th>Exposures</th>
            <th>Successes</th>
            <th>Success rate</th>
            <th>Lift vs control</th>
            <th>p-value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const { v, exposures, conversions, rate } = row;
            const isControl = v.key === controlVariant?.key;
            // Backend lift when the stream is driving; otherwise derive it locally.
            const lift =
              row.lift ?? (controlRate > 0 && !isControl ? (rate - controlRate) / controlRate : 0);
            return (
              <tr key={v.key}>
                <td>
                  {v.name} <VariantTag isControl={isControl} />
                </td>
                <td className="num">{exposures}</td>
                <td className="num">{conversions}</td>
                <td className="num">{(rate * 100).toFixed(1)}%</td>
                <td className={`num lift ${lift > 0 ? "up" : lift < 0 ? "down" : ""}`}>
                  {isControl ? "—" : `${lift > 0 ? "+" : ""}${(lift * 100).toFixed(1)}%`}
                </td>
                <td className="num">
                  {isControl || row.pValue === null ? (
                    "—"
                  ) : (
                    <span className={row.significant ? "sig" : ""}>
                      {row.pValue.toFixed(4)}
                      {row.significant ? " ✓" : ""}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      {users.length === 0 && (
        <p className="muted small">No customers enrolled yet — use the enrollment tools below.</p>
      )}

      <div className="card-actions">
        <span className="tour-anchor">
          <button
            className="primary"
            // No exposures in either variant → nothing to launch. Guard against shipping an
            // experiment with no enrolled users.
            disabled={running || users.length === 0}
            title={users.length === 0 ? "Enroll at least one user before launching" : undefined}
            onClick={() => {
              dispatch(setStatus({ key: experiment.key, status: "RUNNING" }));
              if (tourStep === 13) dispatch(setTourStep(14)); // tour: on to the finale
            }}
          >
            🚀 Launch to production
          </button>
          {tourStep === 13 && (
            <CoachTip n={12} onClose={() => dispatch(setTourStep(0))}>
              After you and Claude decide the experiment&apos;s ready, ship it —{" "}
              <strong>Launch to production</strong> and watch it go (mock) live.
            </CoachTip>
          )}
        </span>
        <button
          className="warn"
          disabled={!running}
          onClick={() => dispatch(setStatus({ key: experiment.key, status: "DRAFT" }))}
        >
          Roll back from production
        </button>
      </div>
      </>
      )}
    </div>
  );
}
