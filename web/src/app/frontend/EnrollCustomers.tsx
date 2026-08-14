"use client";
// The enrollment card: pick a customer id + variant (or auto/deterministic bucketing) and enroll
// them. Carries the tour's "select the control variant" and "click Create User" tips.
import { useEffect, useRef, useState } from "react";
import { useAppDispatch, useAppSelector } from "@/store";
import { setTourStep } from "@/store/uiSlice";
import { assignUser, Variant } from "@/store/experimentsSlice";
import { CardToggle, InfoButton } from "../ui";
import { CoachTip } from "../tour";

export default function EnrollCustomers(props: { experimentKey: string; variants: Variant[] }) {
  const dispatch = useAppDispatch();
  const tourStep = useAppSelector((s) => s.ui.tourStep);
  const error = useAppSelector((s) => s.experiments.error);
  const [collapsed, setCollapsed] = useState(false);
  const userCount = useAppSelector(
    (s) => s.experiments.assignments.filter((a) => a.experimentKey === props.experimentKey).length,
  );
  // Resolve a variant key to its display name (falls back to the key).
  const variantLabel = (k: string) => props.variants.find((v) => v.key === k)?.name ?? k;
  const [userId, setUserId] = useState("user_demo_1");
  const [variantKey, setVariantKey] = useState(""); // "" = auto (deterministic bucketing)
  const [pill, setPill] = useState<{ userId: string; variantKey: string; cached: boolean } | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );

  // When this experiment's board is emptied (e.g. Clear buckets), drop the pill too.
  useEffect(() => {
    if (userCount === 0) {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      setPill(null);
    }
  }, [userCount]);

  async function handleCreate() {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    setPill(null);
    try {
      const res = await dispatch(
        assignUser({ key: props.experimentKey, userId, variantKey: variantKey || undefined }),
      ).unwrap();
      setPill({ userId: res.userId, variantKey: res.variantKey, cached: res.cached });
      if (tourStep === 6) dispatch(setTourStep(7)); // tour: on to the Seed step
      if (!res.cached) {
        hideTimer.current = setTimeout(() => {
          setPill(null);
          hideTimer.current = null;
        }, 3000);
      }
    } catch {
      /* error surfaced via the store error banner */
    }
  }

  return (
    <div className="card">
      <CardToggle collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} label="Enroll Customers" />
      <h3 className="card-title">
        Enroll Customers
        <InfoButton text="Simulate customers getting enrolled as new clients who are going to be guinea pigs and get put into the corresponding variant buckets." />
      </h3>
      {!collapsed && (
      <>
      <div className="row">
        <div>
          <label>Customer ID</label>
          <input value={userId} onChange={(e) => setUserId(e.target.value)} />
        </div>
        <div className="tour-anchor assign-variant-anchor">
          <label>Variant</label>
          <select
            value={variantKey}
            onChange={(e) => {
              setVariantKey(e.target.value);
              // tour: selecting the control variant advances to the Create User tip
              const controlKey = props.variants.find((v) => v.isControl)?.key;
              if (tourStep === 5 && e.target.value === controlKey) dispatch(setTourStep(6));
            }}
          >
            <option value="">Auto (deterministic)</option>
            {props.variants.map((v) => (
              <option key={v.key} value={v.key}>
                {v.name} {v.isControl ? "· control" : "· variant"}
              </option>
            ))}
          </select>
          {tourStep === 5 && (
            <CoachTip n={4} placement="above" onClose={() => dispatch(setTourStep(0))}>
              Now let&apos;s create a user — they&apos;re placed into variant buckets based on what
              variant option the user selects. Select the <strong>“control”</strong> variant in the
              variant dropdown list.
            </CoachTip>
          )}
        </div>
        <span className="tour-anchor">
          <button className="primary" onClick={handleCreate}>
            Create User
          </button>
          {tourStep === 6 && (
            <CoachTip n={5} placement="corner-left" onClose={() => dispatch(setTourStep(0))}>
              Now click <strong>Create User</strong> to enroll them.
            </CoachTip>
          )}
        </span>
      </div>
      <div className="pill-slot">
        {error && (
          <div className="result-pill error" role="alert">
            ⚠ {error}
          </div>
        )}
        {pill &&
          (pill.cached ? (
            <div className="result-pill danger">
              Rejected — <strong>{pill.userId}</strong> already exists, kept in variant{" "}
              <strong>{variantLabel(pill.variantKey)}</strong> (not reassigned)
            </div>
          ) : (
            <div className="result-pill success">
              Enrolled <strong>{pill.userId}</strong> → variant <strong>{variantLabel(pill.variantKey)}</strong>
            </div>
          ))}
      </div>
      </>
      )}
    </div>
  );
}
