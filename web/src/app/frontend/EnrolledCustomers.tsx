"use client";
// The per-variant board: one column per variant. Enrolled customers land here; record a success
// per customer, and seed/clear the whole board. Carries the tour's Seed + record-success tips.
import { useEffect, useRef, useState } from "react";
import { useAppDispatch, useAppSelector } from "@/store";
import { setTourStep } from "@/store/uiSlice";
import { assignUser, clearBucket, logConversion, Variant } from "@/store/experimentsSlice";
import { CardToggle, InfoButton, VariantTag } from "../ui";
import { CoachTip } from "../tour";

export default function EnrolledCustomers(props: { experimentKey: string; variants: Variant[] }) {
  const dispatch = useAppDispatch();
  const tourStep = useAppSelector((s) => s.ui.tourStep);
  const users = useAppSelector((s) =>
    s.experiments.assignments.filter((a) => a.experimentKey === props.experimentKey),
  );
  const hasUsers = users.length > 0;
  const boardRef = useRef<HTMLDivElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  // Tour: bring the whole Enrolled Customers panel into view for the Seed step.
  useEffect(() => {
    if (tourStep === 7) {
      boardRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [tourStep]);

  async function seed() {
    const mkId = () => `cust_${Math.random().toString(36).slice(2, 8)}`;
    // Seed 5 customers into EVERY variant — handles 2-arm and multi-arm experiments.
    const pending = [];
    for (const v of props.variants) {
      for (let i = 0; i < 5; i++) {
        pending.push(
          dispatch(assignUser({ key: props.experimentKey, userId: mkId(), variantKey: v.key })).unwrap(),
        );
      }
    }
    // Once the seeded customers have landed in the board, scroll to the newest at the bottom.
    await Promise.allSettled(pending);
    setTimeout(() => boardRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }), 100);
  }

  return (
    <div className="card" ref={boardRef}>
      <CardToggle collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} label="Enrolled Customers" />
      <h3 className="card-title">
        Enrolled Customers
        <InfoButton text="Each enrolled customer lands in one variant column. Record a success (conversion) per customer — the blue button disables once recorded. Seed adds 5 customers to each variant; Clear empties the board." />
      </h3>

      {!collapsed && (
      <>
      <div className="board-toolbar">
        <span className="tour-anchor">
          <button
            className="primary"
            onClick={() => {
              seed();
              if (tourStep === 7) dispatch(setTourStep(8)); // tour: on to the first success
            }}
          >
            Seed 5 per variant
          </button>
          {tourStep === 7 && (
            <CoachTip n={6} placement="corner-up-right" onClose={() => dispatch(setTourStep(0))}>
              Add more seeds to feed the experiment more users. Click the <strong>Seed 5 per variant</strong> button.
            </CoachTip>
          )}
        </span>
        <button
          className="warn"
          disabled={!hasUsers}
          onClick={() => dispatch(clearBucket(props.experimentKey))}
        >
          Clear buckets
        </button>
      </div>

      <div className="variant-columns">
        {props.variants.map((v, colIndex) => {
          const colUsers = users.filter((u) => u.variantKey === v.key);
          return (
            <div key={v.key} className="variant-col">
              <div className="variant-col-head">
                {v.name} <VariantTag isControl={v.isControl} />{" "}
                <span className="muted">({colUsers.length})</span>
              </div>
              {colUsers.length === 0 && <div className="muted small">No customers yet</div>}
              {colUsers.map((u, rowIndex) => {
                // The tour spotlights three successes in order: one in bucket 1 (step 8), then two
                // in bucket 2 (steps 9 and 10). The spotlighted button advances the tour on click.
                let tipStep = 0;
                let tipText = "";
                // Bucket-1 (left column) tips point up-right so they clear the Experiments
                // sidebar; the bucket-2 (right column) tips point left into the open gap.
                let tipPlacement: "left" | "corner-up-right" = "left";
                if (colIndex === 0 && rowIndex === 0) {
                  tipStep = 8;
                  tipText = "Mimic a success event from this customer.";
                  tipPlacement = "corner-up-right";
                } else if (colIndex === 1 && rowIndex === 0) {
                  tipStep = 9;
                  tipText = "Mimic a success in the other variant so both have wins.";
                } else if (colIndex === 1 && rowIndex === 1) {
                  tipStep = 10;
                  tipText = "Add one more success in this bucket to build enough signal to compare the variants in the statistics table.";
                }
                const showTip = tipStep !== 0 && tourStep === tipStep;
                return (
                  <div key={u.userId} className="user-row">
                    <span className="user-name" title={u.userId}>
                      {u.userId}
                    </span>
                    <span className="tour-anchor">
                      <button
                        className="primary small-btn"
                        disabled={u.converted}
                        onClick={() => {
                          // Record the success on the backend; the board's converted flag
                          // drives the results table (no separate results fetch needed).
                          dispatch(logConversion({ key: props.experimentKey, userId: u.userId }));
                          // Tour: clicking the spotlighted button advances to the next step.
                          if (showTip) dispatch(setTourStep(tipStep + 1));
                        }}
                      >
                        {u.converted ? "✓ Recorded" : "Record success"}
                      </button>
                      {showTip && (
                        <CoachTip n={tipStep - 1} placement={tipPlacement} onClose={() => dispatch(setTourStep(0))}>
                          {tipText}
                        </CoachTip>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      </>
      )}
    </div>
  );
}
