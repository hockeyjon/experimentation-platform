"use client";
// The Backend tab's "Micro-services" panel: a Health check that lists the containers running on the
// box (the browser-side `make list-backend`). Owns the tour's Health-check tip and the step-4→5
// hand-off back to the Frontend tab.
import { useEffect, useState } from "react";
import { useAppDispatch, useAppSelector } from "@/store";
import { setTab, setTourStep } from "@/store/uiSlice";
import { CoachTip, TOUR_STEP_DELAY_MS } from "../tour";
import { fetchContainers } from "./backendUtils";

type SubTab = "logging" | "services";

export default function Microservices({ subTab }: { subTab: SubTab }) {
  const dispatch = useAppDispatch();
  const tourStep = useAppSelector((s) => s.ui.tourStep);
  const [checking, setChecking] = useState(false);
  const [serviceLines, setServiceLines] = useState<string[]>([]);

  // Tour: start this panel empty as the tour heads toward the Health-check step (step 3, just
  // before StreamLogs switches us here), so the step-4→5 hand-off below waits for a real click
  // rather than firing on leftover output from an earlier check.
  useEffect(() => {
    if (tourStep === 3) setServiceLines([]);
  }, [tourStep]);

  // Tour: after Health check is clicked and the `docker ps` output lands (serviceLines populated,
  // no longer checking), pause, then head to the Frontend tab.
  useEffect(() => {
    if (tourStep === 4 && !checking && serviceLines.length > 0) {
      const t = setTimeout(() => {
        dispatch(setTab("frontend"));
        dispatch(setTourStep(5));
      }, TOUR_STEP_DELAY_MS);
      return () => clearTimeout(t);
    }
  }, [tourStep, checking, serviceLines, dispatch]);

  async function healthCheck() {
    setChecking(true);
    setServiceLines(await fetchContainers());
    setChecking(false);
  }

  return (
    <div className="backend-panel" style={{ display: subTab === "services" ? "flex" : "none" }}>
      <div className="backend-toolbar">
        <span className="tour-anchor">
          <button className="primary" disabled={checking} onClick={healthCheck}>
            {checking ? "Checking…" : "Health check"}
          </button>
          {tourStep === 4 && !checking && serviceLines.length === 0 && (
            <CoachTip n={3} placement="corner" onClose={() => dispatch(setTourStep(0))}>
              See every microservice running on the box. Click <strong>Health check</strong>.
            </CoachTip>
          )}
        </span>
        {checking && (
          <span className="muted">
            <span className="spinner" aria-hidden="true" /> querying the Docker host…
          </span>
        )}
        <span className="muted small">
          Containers running on the EC2 instance — the same view as `make list-backend`.
        </span>
      </div>
      <pre className="log-view" aria-busy={checking}>
        {serviceLines.length
          ? serviceLines.join("\n")
          : // Hide the "Click Health check…" hint while the tour is running — the coach tip
            // already directs the user to the button.
            tourStep === 0
            ? 'Click "Health check" to list the running services.'
            : ""}
      </pre>
    </div>
  );
}
