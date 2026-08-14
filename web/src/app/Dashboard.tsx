"use client";
// The app shell. Owns the per-visitor Kubernetes session lifecycle (provision → heartbeat →
// idle-revoke), the title bar, and the Frontend / Backend tab bar. The tab CONTENT lives in
// <Frontend> and <Backend>; cross-cutting UI state (tab, tourStep, claudeOpen) lives in the ui
// slice so those components can self-serve it.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import AboutStack from "./about/AboutStack";
import AboutClaude from "./about/AboutClaude";
import Frontend from "./frontend/Frontend";
import Backend from "./backend/Backend";
import { Modal } from "./ui";
import { CoachTip, TOUR_FINALE_DELAY_MS } from "./tour";
import { useAppDispatch, useAppSelector, loadPersistedAssignments } from "@/store";
import { setClaudeOpen, setTab, setTourStep, toggleClaudeOpen } from "@/store/uiSlice";
import { useStatsStream } from "@/hooks/useStatsStream";
import {
  createSession,
  isQueued,
  waitUntilReady,
  heartbeat as sessionHeartbeat,
  releaseSession,
  setSessionId,
} from "@/lib/session";
import {
  fetchExperiments,
  hydrateAssignments,
  selectExperiment,
} from "@/store/experimentsSlice";

// Local / no-Kubernetes mode. Set NEXT_PUBLIC_SESSION_MODE=shared (see `make local-web`) to run the
// app against a single SHARED backend — the docker-compose local stack — instead of provisioning a
// per-visitor Kubernetes session. The session id stays null, so every backend call targets the
// origin directly (no /s/<id> prefix), exactly the Phase-1 shared-backend model.
const SHARED_MODE = process.env.NEXT_PUBLIC_SESSION_MODE === "shared";

// How often we refresh the session's idle-TTL lease. Well under the provisioner's 15-min TTL.
const SESSION_HEARTBEAT_MS = 60_000;
// Client-side idle-revoke: release this visitor's session after IDLE_TIMEOUT_SECONDS of no
// activity, warning with a live countdown for the final IDLE_WARNING_SECONDS.
const IDLE_TIMEOUT_SECONDS = 300; // 5 min of inactivity → release the session
const IDLE_WARNING_SECONDS = 60; // show the warning + countdown for the final minute
// While at capacity, how often to re-attempt a claim so the visitor auto-enters when a slot frees.
const BUSY_POLL_MS = 4_000;
// If a stack's boot fails (contention when several come up at once), wait this long, then retry.
const PROVISION_RETRY_MS = 4_000;
// Give up and show the error (with a manual retry) only after this many failed boot attempts.
const MAX_PROVISION_ATTEMPTS = 6;

export default function Dashboard() {
  const dispatch = useAppDispatch();
  const { items, selectedKey, error, restarting } = useAppSelector((s) => s.experiments);
  const tab = useAppSelector((s) => s.ui.tab);
  const tourStep = useAppSelector((s) => s.ui.tourStep);
  const claudeOpen = useAppSelector((s) => s.ui.claudeOpen);
  // The "About" overlay (the stack diagram), opened from the title-bar pill.
  const [about, setAbout] = useState(false);
  // The parked "About → Claude" overlay (the collaboration story), opened only via ⌘A.
  const [aboutClaude, setAboutClaude] = useState(false);
  // ⌘A (Cmd/Ctrl + A) reveals the parked AboutClaude modal. This overrides browser "Select All",
  // so we bow out when focus is in a text field — Cmd/Ctrl+A still selects text there. Opening it
  // closes the stack overlay so the two never stack.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.code === "KeyA") {
        const el = e.target as HTMLElement | null;
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable))
          return; // let select-all work while typing
        e.preventDefault();
        setAbout(false);
        setAboutClaude(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // First-load entry modal (Phase 2). "provisioning" while this visitor's own isolated stack spins
  // up, then "welcome" (ready — offer the tour), "busy" (every slot taken), or "error", then "done".
  const [entryState, setEntryState] = useState<
    "provisioning" | "welcome" | "busy" | "error" | "done"
  >(SHARED_MODE ? "welcome" : "provisioning"); // shared mode has no provisioning step
  // Bumped to re-run the provisioning effect when the visitor retries after busy/error.
  const [attempt, setAttempt] = useState(0);
  // 0-based place in the FIFO waiting line while at capacity (0 = next up), or null when not queued.
  const [queuePos, setQueuePos] = useState<number | null>(null);
  // Idle-revoke: a live session is released after IDLE_TIMEOUT_SECONDS of inactivity.
  const [sessionLive, setSessionLive] = useState(false); // a claimed stack is in use
  const [idleRemaining, setIdleRemaining] = useState<number | null>(null); // countdown secs, or null
  const [sessionEnded, setSessionEnded] = useState(false); // released for going idle
  const activeIdRef = useRef<string | null>(null); // the live session id, for revoke
  const hbRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined); // heartbeat handle
  const lastActivityRef = useRef(0); // epoch ms of the last user activity

  // On load (and on each retry): ask the provisioner for our OWN isolated stack, wait for it to
  // come up (~30–60s), then point the app at /s/<id>, load that stack's experiments, and
  // heartbeat to hold the slot until the tab closes. A DELETE on unload frees the slot right
  // away so the next visitor doesn't wait out the idle TTL (the reaper is the backstop).
  useEffect(() => {
    let cancelled = false;
    let hb: ReturnType<typeof setInterval> | undefined;
    let id: string | null = null;

    // Local / no-Kubernetes mode: no provisioner, so skip session provisioning entirely and talk
    // straight to the shared backend at the origin (id stays null → no /s/<id> prefix). No
    // heartbeat and no idle-revoke — those exist only to manage a per-visitor Kubernetes session.
    if (SHARED_MODE) {
      setSessionId(null);
      dispatch(fetchExperiments());
      dispatch(hydrateAssignments(loadPersistedAssignments()));
      setEntryState("welcome");
      return () => setSessionId(null);
    }

    setEntryState("provisioning");
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      // Keep trying until we hold a ready stack. Two things can go wrong transiently under load,
      // and both self-heal here so the visitor never dead-ends on an error:
      //   • at capacity → poll until a slot frees (a claim only succeeds when one genuinely is).
      //   • a boot times out (contention when several stacks come up at once) → release it and
      //     retry after a beat, exactly what clicking "Try again" did.
      for (let attemptN = 1; !cancelled; attemptN++) {
        try {
          let created = await createSession();
          while (isQueued(created)) {
            if (cancelled) return;
            setQueuePos(created.position); // show place in line
            setEntryState("busy");
            await sleep(BUSY_POLL_MS);
            if (cancelled) return;
            created = await createSession(created.ticket || undefined); // poll, holding our place
          }
          if (cancelled) return;
          setQueuePos(null);
          setEntryState("provisioning"); // instant if it's the warm reserve
          id = created.id;
          await waitUntilReady(id);
          if (cancelled) return;
          // From here on, every backend caller resolves to THIS session's stack.
          setSessionId(id);
          dispatch(fetchExperiments());
          dispatch(hydrateAssignments(loadPersistedAssignments()));
          hb = setInterval(() => id && sessionHeartbeat(id), SESSION_HEARTBEAT_MS);
          hbRef.current = hb;
          activeIdRef.current = id;
          lastActivityRef.current = Date.now();
          setSessionLive(true); // arm the idle watcher
          setEntryState("welcome");
          return;
        } catch (e) {
          console.error(`[session] provisioning attempt ${attemptN} failed`, e);
          if (cancelled) return;
          // Free the stack that didn't come up so its slot reopens, then retry (or give up).
          if (id) releaseSession(id);
          id = null;
          setSessionId(null);
          if (attemptN >= MAX_PROVISION_ATTEMPTS) return void setEntryState("error");
          setEntryState("provisioning");
          await sleep(PROVISION_RETRY_MS);
        }
      }
    })();

    const onHide = () => id && releaseSession(id);
    window.addEventListener("pagehide", onHide);
    return () => {
      cancelled = true;
      if (hb) clearInterval(hb);
      hbRef.current = undefined;
      activeIdRef.current = null;
      window.removeEventListener("pagehide", onHide);
      if (id) releaseSession(id);
      setSessionId(null);
      setSessionLive(false);
    };
  }, [attempt, dispatch]);

  // Release the session (server + local), stop the heartbeat, and show the "ended" screen.
  const revokeSession = useCallback(() => {
    if (hbRef.current) clearInterval(hbRef.current);
    hbRef.current = undefined;
    const id = activeIdRef.current;
    activeIdRef.current = null;
    if (id) releaseSession(id);
    setSessionId(null);
    setSessionLive(false);
    setIdleRemaining(null);
    setSessionEnded(true);
  }, []);

  // "I'm still here" / any activity → clear the warning and restart the idle clock.
  const resetIdle = useCallback(() => {
    lastActivityRef.current = Date.now();
    setIdleRemaining(null);
  }, []);

  // Idle-revoke watcher: while a session is live, track user activity. Warn with a countdown for
  // the final IDLE_WARNING_SECONDS, then release the session so the slot frees for the next visitor.
  useEffect(() => {
    if (!sessionLive) return;
    lastActivityRef.current = Date.now();
    const bump = () => (lastActivityRef.current = Date.now());
    const events = ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "wheel"];
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const iv = setInterval(() => {
      const idle = (Date.now() - lastActivityRef.current) / 1000;
      if (idle >= IDLE_TIMEOUT_SECONDS) revokeSession();
      else if (idle >= IDLE_TIMEOUT_SECONDS - IDLE_WARNING_SECONDS)
        setIdleRemaining(Math.ceil(IDLE_TIMEOUT_SECONDS - idle));
      else setIdleRemaining(null);
    }, 1000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, bump));
      clearInterval(iv);
    };
  }, [sessionLive, revokeSession]);

  const selected = items.find((e) => e.key === selectedKey) ?? null;

  // Hold an SSE connection open for whichever experiment is selected; the Python service's
  // numbers land in Redux as they change. Re-subscribes on selection change.
  useStatsStream(selectedKey);

  // Auto-select the first experiment so the dropdown + panes are never empty on load.
  useEffect(() => {
    if (!selectedKey && items.length > 0) dispatch(selectExperiment(items[0].key));
  }, [selectedKey, items, dispatch]);

  // Tour finale: after Launch, once the experiment reads RUNNING, pause the configured delay,
  // then jump back to the Backend log stream and show the completion modal.
  useEffect(() => {
    if (tourStep === 14 && selected?.status === "RUNNING") {
      const t = setTimeout(() => {
        dispatch(setTab("backend"));
        dispatch(setTourStep(15));
      }, TOUR_FINALE_DELAY_MS);
      return () => clearTimeout(t);
    }
  }, [tourStep, selected?.status, dispatch]);

  return (
    <>
      {entryState !== "done" && (
        <EntryModal
          state={entryState}
          position={queuePos}
          onSkip={() => setEntryState("done")}
          onRetry={() => setAttempt((a) => a + 1)}
          onStartTour={() => {
            setEntryState("done");
            dispatch(setTab("backend")); // step 1: over to the Backend (log stream) tab
            dispatch(setTourStep(1));
          }}
        />
      )}
      {tourStep === 15 && <TourDoneModal onEnd={() => dispatch(setTourStep(0))} />}
      {about && <AboutStack onDismiss={() => setAbout(false)} />}
      {aboutClaude && <AboutClaude onDismiss={() => setAboutClaude(false)} />}
      {idleRemaining !== null && !sessionEnded && (
        <Modal
          title="Are you still there?"
          onDismiss={resetIdle}
          actions={
            <button className="primary" autoFocus onClick={resetIdle}>
              I&apos;m still here
            </button>
          }
        >
          <p>
            This is a small demo box, so idle sessions are released for the next visitor. Yours will
            end in <strong>{idleRemaining}s</strong> unless you continue.
          </p>
        </Modal>
      )}
      {sessionEnded && (
        <div className="modal-backdrop">
          <div className="modal welcome-modal" role="dialog" aria-modal="true">
            <img className="welcome-logo" src="/logo.png" alt="Experimentation Platform logo" />
            <h3>Session ended</h3>
            <p>
              Your isolated session was released after going idle, freeing the slot for the next
              visitor. Start a fresh one anytime.
            </p>
            <div className="modal-actions welcome-actions">
              <button className="primary" autoFocus onClick={() => window.location.reload()}>
                Start a new session
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="header">
        <h1>Experimentation Platform</h1>
        <span className="tag">Next.js · Redux · GraphQL · Prisma · Postgres · Mongo · Redis</span>
        <button className="about-pill" onClick={() => setAbout(true)}>
          About
        </button>
      </div>

      <div className="tabbar">
        <button
          className={`tab ${tab === "frontend" ? "active" : ""}`}
          onClick={() => dispatch(setTab("frontend"))}
        >
          Frontend
        </button>
        <button
          className={`tab ${tab === "backend" ? "active" : ""}`}
          onClick={() => dispatch(setTab("backend"))}
        >
          Backend
        </button>
        <div className="tab-gap tab-gap-l" aria-hidden="true" />
        <div className="tab-picker">
          <label htmlFor="exp-select">Experiment</label>
          <select
            id="exp-select"
            value={selectedKey ?? ""}
            onChange={(e) => {
              dispatch(selectExperiment(e.target.value));
              dispatch(setTab("frontend")); // picking an experiment jumps to where you can work with it
            }}
          >
            {items.length === 0 && <option value="">Loading…</option>}
            {items.map((e) => (
              <option key={e.id} value={e.key}>
                {e.name} — {e.status}
              </option>
            ))}
          </select>
          {restarting && (
            <span className="muted small">
              <span className="spinner" aria-hidden="true" /> restarting…
            </span>
          )}
          {error && <span className="error small">{error}</span>}
        </div>
        <div className="tab-gap tab-gap-r" aria-hidden="true" />
        <span className="tour-anchor claude-tab-anchor">
          <button
            className={`claude-tab${claudeOpen ? " active" : ""}`}
            onClick={() => {
              dispatch(setTab("frontend"));
              if (tourStep === 11) {
                dispatch(setClaudeOpen(true)); // tour: open the pane and move to the ask-input tip
                dispatch(setTourStep(12));
              } else {
                dispatch(toggleClaudeOpen());
              }
            }}
            title="Ask Claude about the current experiment"
            aria-pressed={claudeOpen}
          >
            <span className="claude-glyph" aria-hidden="true">✳</span> Claude
          </button>
          {tourStep === 11 && (
            <CoachTip n={10} placement="left" onClose={() => dispatch(setTourStep(0))}>
              Let&apos;s have Claude analyze the current state of the experiment. Click the{" "}
              <strong>Claude</strong> button.
            </CoachTip>
          )}
        </span>
      </div>

      {/* Both tabs stay mounted; each hides itself when inactive. That keeps the log WebSocket
          alive while you work in the Frontend tab, so the Backend tab captures the very logs your
          frontend actions produce. */}
      <Frontend />
      <Backend />
    </>
  );
}

// First-load entry modal (Phase 2). The logo + title show immediately; the body is a spinner
// while this visitor's OWN isolated stack spins up, then swaps to the welcome/tour when it's
// ready — or, if every session slot is taken, the "at capacity" message, or an error with a
// retry if the spin-up failed. Always a hard block: until a session is ready there's nothing
// behind it to use.
function EntryModal({
  state,
  position,
  onSkip,
  onStartTour,
  onRetry,
}: {
  state: "provisioning" | "welcome" | "busy" | "error";
  position?: number | null; // 0-based place in the FIFO line while "busy" (0 = next up)
  onSkip?: () => void;
  onStartTour?: () => void;
  onRetry?: () => void;
}) {
  const titleId = useId();

  return (
    <div className="modal-backdrop">
      <div
        className="modal welcome-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <img className="welcome-logo" src="/logo.png" alt="Experimentation Platform logo" />
        <h3 id={titleId}>Welcome to the Experimentation Platform</h3>

        {state === "provisioning" && (
          <div className="entry-loading" role="status" aria-live="polite">
            <span className="spinner spinner-lg" aria-hidden="true" />
            <p className="muted">
              Spinning up your own isolated stack — usually 30–60 seconds. Each visitor gets a
              private, namespace-isolated backend on Kubernetes.
            </p>
          </div>
        )}

        {state === "welcome" && (
          <>
            <p>A working, full-stack A/B experimentation demo. Would you like a quick guided tour?</p>
            <div className="modal-actions welcome-actions">
              <button className="ghost" onClick={onSkip}>
                Skip
              </button>
              <button className="primary" autoFocus onClick={onStartTour}>
                Take the tour
              </button>
            </div>
          </>
        )}

        {state === "busy" && (
          <>
            <p>
              Every isolated session is currently in use — each visitor gets their own private,
              namespace-isolated stack. Hang tight:{" "}
              <strong>you&apos;ll drop straight into the tour when it&apos;s your turn.</strong>
            </p>
            <div className="entry-loading" role="status" aria-live="polite">
              <span className="spinner spinner-lg" aria-hidden="true" />
              <p className="muted">
                {position == null
                  ? "Waiting for an open session…"
                  : position === 0
                    ? "You're next in line…"
                    : `You're #${position + 1} in line…`}
              </p>
            </div>
          </>
        )}

        {state === "error" && (
          <>
            <p>
              Something went wrong spinning up your isolated stack. This is a demo running on a
              single small box, so a slot may have just been reclaimed — give it another try.
            </p>
            <div className="modal-actions welcome-actions">
              <button className="primary" autoFocus onClick={onRetry}>
                Try again
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Tour completion dialog — same welcome-modal chrome (logo on top, button-only), shown
// when the tour ends back on the Backend log stream.
function TourDoneModal({ onEnd }: { onEnd: () => void }) {
  const titleId = useId();
  return (
    <div className="modal-backdrop tour-done-backdrop">
      <div className="modal welcome-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <img className="welcome-logo" src="/logo.png" alt="Experimentation Platform logo" />
        <h3 id={titleId}>You&apos;re all set</h3>
        <p>Now you can view the full data flow in the backend log stream.</p>
        <p>Click the <strong>Frontend</strong> tab in the upper left corner to return to the experiment dashboard.</p>
        <div className="modal-actions welcome-actions">
          <button className="primary" autoFocus onClick={onEnd}>
            End tour
          </button>
        </div>
      </div>
    </div>
  );
}
