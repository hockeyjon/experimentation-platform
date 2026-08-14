"use client";
// The Backend tab's "Logging" panel: opens a WebSocket to the log-stream service and shows
// redacted, time-limited backend logs. No history is fetched (tail=0), and the stream auto-closes
// after 20 minutes. Optionally recreates api + stats first (the Restart flow). Owns the tour's
// Stream / Restart tips and the step-3→4 hand-off to the Micro-services panel.
import { useEffect, useRef, useState } from "react";
import { useAppDispatch, useAppSelector } from "@/store";
import { setTourStep } from "@/store/uiSlice";
import { wsBase, TOKEN } from "@/lib/session";
import {
  backendRestartStarted,
  clearBucket,
  fetchExperiments,
  resetState,
  setStatus,
} from "@/store/experimentsSlice";
import { Modal } from "../ui";
import { CoachTip, TOUR_STEP_DELAY_MS } from "../tour";
import { AnsiLine, API_READY, READY_TIMEOUT_S, colorizeTags, resetBackend } from "./backendUtils";

type SubTab = "logging" | "services";

// Start clean, or attach to whatever is already running.
function RestartDialog(props: {
  onDismiss: () => void;
  onRestart: () => void;
  onContinue: () => void;
  tourActive: boolean;
  onDismissTour: () => void;
}) {
  return (
    <Modal
      title="Logging Options"
      onDismiss={props.onDismiss}
      actions={
        <>
          <span className="tour-anchor">
            <button className="warn" onClick={props.onRestart}>
              Restart
            </button>
            {props.tourActive && (
              <CoachTip n={2} placement="left" onClose={props.onDismissTour}>
                Recreate the api + stats containers from scratch for a clean slate. Click{" "}
                <strong>Restart</strong>.
              </CoachTip>
            )}
          </span>
          <button className="primary" autoFocus onClick={props.onContinue}>
            Continue
          </button>
        </>
      }
    >
      <p>Would you like to restart, or continue logging from its current state?</p>
      <p>
        <strong>Restart</strong> clears the enrolled customers from every experiment, then recreates
        the api + stats containers — the stream begins on an empty log. Takes about 20 seconds, and
        the API is unavailable while it happens.
      </p>
      <p>
        <strong>Continue</strong> attaches to the services as they are and streams from now,
        changing nothing.
      </p>
    </Modal>
  );
}

export default function StreamLogs({
  active,
  subTab,
  setSubTab,
}: {
  active: boolean; // the whole Backend tab is visible (used to re-scroll on tab switch)
  subTab: SubTab;
  setSubTab: (t: SubTab) => void;
}) {
  const dispatch = useAppDispatch();
  const tourStep = useAppSelector((s) => s.ui.tourStep);
  const experiments = useAppSelector((s) => s.experiments.items);
  const [streaming, setStreaming] = useState(false);
  const [stopped, setStopped] = useState(false); // true after Stop: log cleared, showing the prompt
  const [resetting, setResetting] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [remaining, setRemaining] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const readyRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewRef = useRef<HTMLPreElement | null>(null);
  const prevTourStep = useRef(tourStep); // to detect the finale modal closing (15 → 0)

  // Drop the spinner: the api announced itself, or we gave up waiting.
  const clearBusy = () => {
    if (readyRef.current) clearTimeout(readyRef.current);
    readyRef.current = null;
    setResetting(false);
  };

  const stop = () => {
    wsRef.current?.close();
    wsRef.current = null;
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
    clearBusy(); // never leave a spinner behind if the stream dies mid-boot
    setStreaming(false);
    setLines([]); // erase the log; the view shows the restart/continue prompt instead
    setStopped(true);
  };

  // Only tear the stream down on real unmount (leaving the page) — NOT on tab switch,
  // so the stream keeps running in the background while you use the Frontend tab.
  useEffect(() => () => stop(), []);

  // Keep the newest line in view — also re-scroll when you switch back to this tab
  // (a hidden <pre> has no scroll height, so it needs a nudge once it's visible again).
  useEffect(() => {
    if (viewRef.current) viewRef.current.scrollTop = viewRef.current.scrollHeight;
  }, [lines, active]);

  // Tour: once the fresh session is live (the Stop button is showing — streaming, spinner
  // gone), pause, then move the tour to the Micro-services panel and its Health check tip.
  useEffect(() => {
    if (tourStep === 3 && streaming && !resetting) {
      const t = setTimeout(() => {
        setSubTab("services");
        dispatch(setTourStep(4));
      }, TOUR_STEP_DELAY_MS);
      return () => clearTimeout(t);
    }
  }, [tourStep, streaming, resetting, setSubTab, dispatch]);

  // Tour finale: when "End tour" closes the modal (15 → 0), wait for the revealed log to
  // render, then a beat (500ms), then scroll to the newest lines.
  useEffect(() => {
    const wasFinale = prevTourStep.current === 15;
    prevTourStep.current = tourStep;
    if (!wasFinale || tourStep !== 0) return;
    let timer: ReturnType<typeof setTimeout>;
    const raf = requestAnimationFrame(() => {
      timer = setTimeout(() => {
        if (viewRef.current) viewRef.current.scrollTop = viewRef.current.scrollHeight;
      }, 500);
    });
    return () => {
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
    };
  }, [tourStep]);

  // "Clear buckets" for every experiment — the same mutation the Frontend tab's button
  // fires, applied across the board so a restarted demo starts with nobody enrolled.
  async function clearAllBuckets(): Promise<string> {
    try {
      await Promise.all(experiments.map((e) => dispatch(clearBucket(e.key)).unwrap()));
      return `[logstream] cleared enrolled customers from ${experiments.length} experiment(s)`;
    } catch {
      return "[logstream] clear buckets failed — continuing";
    }
  }

  // Reset every experiment back to DRAFT. A launched experiment's status lives in Postgres
  // and survives the restart, which would otherwise leave the tour's Launch step with nothing
  // to launch. Runs while the API is still up (before the recreate wipes the logs).
  async function resetExperimentsToDraft(): Promise<string> {
    const launched = experiments.filter((e) => e.status !== "DRAFT");
    if (launched.length === 0) return "[logstream] all experiments already DRAFT";
    try {
      await Promise.all(launched.map((e) => dispatch(setStatus({ key: e.key, status: "DRAFT" })).unwrap()));
      return `[logstream] reset ${launched.length} experiment(s) to DRAFT`;
    } catch {
      return "[logstream] reset experiment status failed — continuing";
    }
  }

  // Refill the sidebar after a restart, retrying for a bit: the api may need a moment after it
  // announces itself (or, on the safety-net path, may still be finishing a contended boot), and a
  // single fetch into a not-quite-ready api surfaces as "failed to fetch". Idempotent read.
  async function refillExperiments(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      const last = i === 19;
      try {
        // Silent while retrying (keeps the spinner, no error flash); the final attempt is loud so
        // a genuine, lasting failure still surfaces the error instead of spinning forever.
        await dispatch(fetchExperiments(last ? undefined : { silent: true })).unwrap();
        return;
      } catch {
        if (last) return;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  async function start(restart: boolean) {
    // wss://api…[/s/<id>]/logstream — this session's own log stream (see lib/session.ts).
    const wsUrl = wsBase() + "/logstream";

    setStopped(false); // leaving the stopped state — a stream is (re)starting
    const notes: string[] = [];
    if (restart) {
      // Buckets first, while the API is still up — recreating the containers afterwards
      // wipes the log lines the clearing itself produces. The spinner covers both steps,
      // and streaming proceeds even if either one fails.
      setLines([]);
      setResetting(true);
      setBusyLabel("Clearing enrolled customers…");
      notes.push(await clearAllBuckets());
      notes.push(await resetExperimentsToDraft());
      setBusyLabel("Recreating api + stats…");
      notes.push(await resetBackend());
      // Backend enrollments are gone and the services are new, so drop the browser's copy
      // too: board, selection and cached stats all return to defaults. Done after the
      // clearing above, which needs the experiment list this wipes. fetchExperiments is
      // re-issued once the api reports ready, which repopulates the sidebar.
      dispatch(resetState());
      // After resetState, which would otherwise clear the flag. Cleared by the
      // fetchExperiments fired once the api reports ready.
      dispatch(backendRestartStarted());
      notes.push("[logstream] local dashboard state reset to defaults");
      // The container is started but node still has to run `prisma db push` and boot, so
      // the spinner stays up until the api announces itself in the stream below.
      setBusyLabel("Waiting for the api to report ready…");
    } else {
      notes.push("[logstream] continuing from the current state — nothing restarted");
    }

    const ws = new WebSocket(`${wsUrl}?token=${encodeURIComponent(TOKEN)}`);
    wsRef.current = ws;
    setLines(notes);
    setStreaming(true);
    setRemaining(1200);
    tickRef.current = setInterval(() => setRemaining((r) => Math.max(0, r - 1)), 1000);

    if (restart) {
      // Safety net: if that line never arrives (a boot failure, or the message changes),
      // stop spinning rather than hanging forever.
      readyRef.current = setTimeout(() => {
        readyRef.current = null;
        setResetting(false);
        setLines((prev) => [...prev, `[logstream] api slow to report ready — retrying in the background`]);
        // Keep trying rather than failing once: the api may still be finishing a contended boot.
        refillExperiments();
      }, READY_TIMEOUT_S * 1000);
    }

    // Cap the buffer at 800 lines so a long stream can't grow memory without bound.
    ws.onmessage = (e) => {
      const line = String(e.data);
      if (API_READY.test(line)) {
        clearBusy();
        // The api is serving again — refill the sidebar that resetState() emptied (retrying, in
        // case it needs a beat after announcing itself under load).
        if (restart) refillExperiments();
      }
      setLines((prev) => [...prev, line].slice(-800));
    };
    ws.onerror = () => setLines((prev) => [...prev, "[logstream] connection error"]);
    ws.onclose = stop;
  }

  const mmss = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;

  return (
    <>
      <div className="backend-panel" style={{ display: subTab === "logging" ? "flex" : "none" }}>
        <div className="backend-toolbar">
          {resetting ? (
            <>
              <button className="primary" disabled>
                Stream backend logs
              </button>
              <span className="muted">
                <span className="spinner" aria-hidden="true" /> {busyLabel}
              </span>
            </>
          ) : streaming ? (
            <>
              <button className="warn" onClick={stop}>
                Stop
              </button>
              <span className="muted">disconnecting in {mmss}</span>
            </>
          ) : (
            <span className="tour-anchor">
              <button
                className="primary"
                onClick={() => {
                  // This visitor owns their isolated session, so there's no "in use by another"
                  // race here — go straight to the restart choice.
                  setChoosing(true);
                  if (tourStep === 1) dispatch(setTourStep(2)); // advance the tour to the Restart tip
                }}
              >
                Stream backend logs
              </button>
              {tourStep === 1 && (
                <CoachTip n={1} placement="corner-up-right" onClose={() => dispatch(setTourStep(0))}>
                  Let&apos;s boot a fresh backend and watch it come up live. Click{" "}
                  <strong>Stream backend logs</strong>.
                </CoachTip>
              )}
            </span>
          )}
          <span className="muted small">
            Live api + stats logs, redacted server-side (DB IDs + emails stripped). Optionally
            restarts the backend on start; auto-disconnects after 20 minutes.
          </span>
        </div>
        <pre className="log-view" ref={viewRef} aria-busy={resetting}>
          {lines.length
            ? lines.map((line, i) => <AnsiLine key={i} text={colorizeTags(line)} />)
            : resetting
              ? busyLabel
              : stopped
                ? 'Click "Stream backend logs" to restart or continue logging.'
                : 'Click "Stream backend logs" to begin.'}
        </pre>
      </div>

      {/* One step: choose whether to start clean, then stream. */}
      {choosing && (
        <RestartDialog
          tourActive={tourStep === 2}
          onDismissTour={() => dispatch(setTourStep(0))}
          onDismiss={() => setChoosing(false)}
          onRestart={() => {
            setChoosing(false);
            if (tourStep === 2) dispatch(setTourStep(3)); // tour: waiting for the fresh session to come up
            start(true);
          }}
          onContinue={() => {
            setChoosing(false);
            // Off the scripted path, but keep the tour moving to the Micro-services step.
            if (tourStep === 2) dispatch(setTourStep(3));
            start(false);
          }}
        />
      )}
    </>
  );
}
