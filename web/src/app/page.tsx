"use client";
// The dashboard. A client component that reads state from Redux and dispatches the
// async thunks (which call the GraphQL API). The enrolled-customer board is the
// source of truth for the results table, and it persists across reloads (localStorage).
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useAppDispatch, useAppSelector, loadPersistedAssignments } from "@/store";
import { useStatsStream } from "@/hooks/useStatsStream";
import {
  assignUser,
  backendRestartStarted,
  clearBucket,
  fetchExperiments,
  hydrateAssignments,
  logConversion,
  resetState,
  selectExperiment,
  setStatus,
  AssignedUser,
  Experiment,
  Variant,
} from "@/store/experimentsSlice";

export default function Dashboard() {
  const dispatch = useAppDispatch();
  const { items, selectedKey, assignments, loading, error, restarting } = useAppSelector(
    (s) => s.experiments,
  );
  const [tab, setTab] = useState<"frontend" | "backend">("frontend");
  // First-load welcome / tour prompt. Shows on every load for now (good for demos); can be
  // gated to once-per-visitor via localStorage later if we want.
  const [showWelcome, setShowWelcome] = useState(true);
  // Guided tour progress. 0 = not running; each step drives a toast tip (+ any navigation).
  const [tourStep, setTourStep] = useState(0);

  // Load experiments + restore the persisted buckets on mount.
  useEffect(() => {
    dispatch(fetchExperiments());
    dispatch(hydrateAssignments(loadPersistedAssignments()));
  }, [dispatch]);

  const selected = items.find((e) => e.key === selectedKey) ?? null;

  // Hold an SSE connection open for whichever experiment is selected; the Python service's
  // numbers land in Redux as they change. Re-subscribes on selection change.
  useStatsStream(selectedKey);

  // Tour finale: after Launch, once the experiment reads RUNNING, pause the configured delay,
  // then jump back to the Backend log stream and show the completion modal.
  useEffect(() => {
    if (tourStep === 11 && selected?.status === "RUNNING") {
      const t = setTimeout(() => {
        setTab("backend");
        setTourStep(12);
      }, TOUR_STEP_DELAY_MS);
      return () => clearTimeout(t);
    }
  }, [tourStep, selected?.status]);

  return (
    <>
      {showWelcome && (
        <WelcomeModal
          onSkip={() => setShowWelcome(false)}
          onStartTour={() => {
            setShowWelcome(false);
            setTab("backend"); // step 1: over to the Backend (log stream) tab
            setTourStep(1);
          }}
        />
      )}
      {tourStep === 12 && <TourDoneModal onEnd={() => setTourStep(0)} />}
      <div className="header">
        <h1>Experimentation Platform</h1>
        <span className="tag">Next.js · Redux · GraphQL · Prisma · Postgres · Mongo · Redis</span>
      </div>

      <div className="tabbar">
        <button
          className={`tab ${tab === "frontend" ? "active" : ""}`}
          onClick={() => setTab("frontend")}
        >
          Frontend
        </button>
        <button
          className={`tab ${tab === "backend" ? "active" : ""}`}
          onClick={() => setTab("backend")}
        >
          Backend
        </button>
      </div>

      {/* Both tabs stay mounted; we only hide the inactive one. That keeps the log
          WebSocket alive while you work in the Frontend tab, so the Backend tab
          captures the very logs your frontend actions produce. */}
      <div className="layout" style={{ display: tab === "frontend" ? "grid" : "none" }}>
        <aside className="sidebar">
          <h2>Experiments</h2>
          {restarting && (
            <p className="muted">
              <span className="spinner" aria-hidden="true" /> Restarting…
            </p>
          )}
          {loading && !restarting && <p className="muted">Loading…</p>}
          {error && <p className="error">{error}</p>}
          {items.map((e) => (
            <button
              key={e.id}
              className={`exp-item ${e.key === selectedKey ? "active" : ""}`}
              onClick={() => dispatch(selectExperiment(e.key))}
            >
              <div className="k">{e.key}</div>
              <div className="n">{e.name}</div>
              <span className={`badge ${e.status}`}>{e.status}</span>
            </button>
          ))}
        </aside>

        <main className="main">
          {selected ? (
            <>
              <ResultsCard
                experiment={selected}
                users={assignments.filter((a) => a.experimentKey === selected.key)}
                tourStep={tourStep}
                setTourStep={setTourStep}
              />
              {/* key forces a fresh AssignCard (input, variant select, pill) per experiment */}
              <AssignCard
                key={selected.key}
                experimentKey={selected.key}
                variants={selected.variants}
                tourStep={tourStep}
                setTourStep={setTourStep}
              />
              <UserBoard
                experimentKey={selected.key}
                variants={selected.variants}
                tourStep={tourStep}
                setTourStep={setTourStep}
              />
            </>
          ) : restarting ? (
            // The backend is genuinely gone for ~20s after Restart — say that, rather than
            // showing an empty-state prompt that looks like the user forgot to click something.
            <div className="restart-panel" role="status" aria-live="polite">
              <span className="spinner spinner-lg" aria-hidden="true" />
              <p>Restarting the backend…</p>
              <p className="muted small">
                api and stats are being recreated. Experiments reload automatically once the API
                reports ready — usually about 20 seconds.
              </p>
            </div>
          ) : (
            <p className="muted">Select an experiment.</p>
          )}
        </main>
      </div>
      <BackendLogs active={tab === "backend"} tourStep={tourStep} setTourStep={setTourStep} setTab={setTab} />
    </>
  );
}

// The log-stream service sits behind the same host as the GraphQL API, under /logstream*.
const API_BASE = (process.env.NEXT_PUBLIC_GRAPHQL_URL ?? "https://api.gunbarrelstudio.com/").replace(
  /\/+$/,
  "",
);
const LOGSTREAM_TOKEN = process.env.NEXT_PUBLIC_LOGSTREAM_TOKEN ?? "let-me-see-the-logs";

// A restart isn't done when the container starts — node still runs `prisma db push` and
// boots. This is the line the api logs when it is actually serving; it must stay in sync
// with the log.info("startup", …) call in api/src/index.ts.
const API_READY = /GraphQL API ready/;
const READY_TIMEOUT_S = 60;

// How long the guided tour pauses before each auto-advance to the next step. Tune here.
const TOUR_STEP_DELAY_MS = 750;

// Ask the log-stream service to recreate api + stats before we attach — the `make
// logs-reset` equivalent. Always resolves to a line for the log view: a failed or throttled
// reset is worth showing, but it never blocks the stream (seeing the logs is the point).
async function resetBackend(): Promise<string> {
  try {
    const res = await fetch(`${API_BASE}/logstream/reset?token=${encodeURIComponent(LOGSTREAM_TOKEN)}`, {
      method: "POST",
    });
    if (res.ok) {
      const { recreated } = await res.json();
      return `[logstream] recreated ${recreated.join(", ")} — streaming from a fresh boot`;
    }
    if (res.status === 429) {
      const { retryInSeconds } = await res.json();
      return `[logstream] reset skipped — on cooldown for another ${retryInSeconds}s`;
    }
    return `[logstream] reset failed (${res.status}) — streaming anyway`;
  } catch {
    return "[logstream] reset request failed — streaming anyway";
  }
}

type ContainerRow = {
  name: string;
  image: string;
  state: string;
  status: string;
  service: string | null;
  ports: string;
};

// Ask the log-stream service what is running on the host — the browser-side equivalent of
// `make list-backend`. Returns lines for the panel, laid out like `docker ps` output.
async function fetchContainers(): Promise<string[]> {
  const stamp = new Date().toTimeString().slice(0, 8);
  try {
    const res = await fetch(
      `${API_BASE}/logstream/containers?token=${encodeURIComponent(LOGSTREAM_TOKEN)}`,
    );
    if (!res.ok) return [`${stamp} [health] request failed (${res.status})`];
    const { containers } = (await res.json()) as { containers: ContainerRow[] };
    if (!containers.length) return [`${stamp} [health] no running containers`];

    // Pad the first three columns so the output lines up the way `docker ps` does.
    const grid = [
      ["NAMES", "IMAGE", "STATUS", "PORTS"],
      ...containers.map((c) => [c.name, c.image, c.status, c.ports]),
    ];
    const widths = [0, 1, 2].map((i) => Math.max(...grid.map((row) => row[i].length)));
    const table = grid.map((row) =>
      row.map((cell, i) => (i < 3 ? cell.padEnd(widths[i]) : cell)).join("   ").trimEnd(),
    );
    return [`${stamp} [health] ${containers.length} running container(s)`, "", ...table];
  } catch {
    return [`${stamp} [health] request failed — is the backend reachable?`];
  }
}

// The api container colors its [api:<scope>] tags with ANSI escapes so `make logs` is
// scannable by subsystem. A <pre> renders those escapes as literal junk, so translate the
// codes the logger emits into spans. Codes we don't map are dropped rather than shown.
const ANSI_COLOR: Record<string, string> = {
  "32": "#4ade80", // green  — assignUser
  "34": "#60a5fa", // blue   — graphql
  "36": "#22d3ee", // cyan   — lifecycle (launch / rollback)
  "33": "#facc15", // yellow — postgres
  "38;5;208": "#fb923c", // orange — mongo
  "38;5;141": "#a78bfa", // violet — redis
};

function AnsiLine({ text }: { text: string }) {
  // Capturing split → [text, code, text, code, …]: odd entries are the SGR codes.
  const parts = text.split(/\x1b\[([0-9;]*)m/);
  const out: ReactNode[] = [];
  let color: string | undefined;
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      color = ANSI_COLOR[part]; // "0" (reset) and anything unmapped → back to default
      return;
    }
    if (!part) return;
    out.push(
      color ? (
        <span key={i} style={{ color }}>
          {part}
        </span>
      ) : (
        part
      ),
    );
  });
  return (
    <>
      {out}
      {"\n"}
    </>
  );
}

// Stands in for window.confirm: browsers prefix native dialogs with "<origin> says" and
// give no way to suppress it, so consent steps are rendered in-page instead. Keeps the two
// things the native dialog gave us for free — Escape to dismiss, and focus on the default
// action (whichever child button carries autoFocus).
function Modal(props: {
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

// First-load welcome dialog that offers the guided tour. Uses the same backdrop/panel
// chrome as Modal, but with a centered layout and the logo up top.
function WelcomeModal({ onSkip, onStartTour }: { onSkip: () => void; onStartTour: () => void }) {
  const titleId = useId();

  // Deliberately NOT dismissible by backdrop click or Escape — the only ways out are the
  // "Skip" and "Take the tour" buttons. (No onClick on the backdrop, no Escape listener.)
  return (
    <div className="modal-backdrop">
      <div
        className="modal welcome-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <img className="welcome-logo" src="/logo.png" alt="Experimentation Platform logo" />
        <h3 id={titleId}>Welcome to the Experimentation Platform</h3>
        <p>A working, full-stack A/B experimentation demo. Would you like a quick guided tour?</p>
        <div className="modal-actions welcome-actions">
          <button className="ghost" onClick={onSkip}>
            Skip
          </button>
          <button className="primary" autoFocus onClick={onStartTour}>
            Take the tour
          </button>
        </div>
      </div>
    </div>
  );
}

// Tour completion dialog — same chrome as WelcomeModal (logo on top, button-only), shown
// when the tour ends back on the Backend log stream.
function TourDoneModal({ onEnd }: { onEnd: () => void }) {
  const titleId = useId();
  return (
    <div className="modal-backdrop">
      <div className="modal welcome-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <img className="welcome-logo" src="/logo.png" alt="Experimentation Platform logo" />
        <h3 id={titleId}>You&apos;re all set</h3>
        <p>Now you can watch the full data flow in the backend log stream. Happy experimenting 🎉</p>
        <div className="modal-actions welcome-actions">
          <button className="primary" autoFocus onClick={onEnd}>
            End tour
          </button>
        </div>
      </div>
    </div>
  );
}

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
              <div className="coach-tip coach-tip-left" role="status">
                <span className="toast-badge">Tour</span>
                <div className="toast-body">
                  Click the <strong>Restart</strong> button.
                </div>
                <button
                  className="toast-close"
                  aria-label="Dismiss tour tip"
                  onClick={props.onDismissTour}
                >
                  ×
                </button>
              </div>
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

// The "Backend" tab: opens a WebSocket to the log-stream service and shows redacted,
// time-limited backend logs. No history is fetched (tail=0), and the stream auto-closes
// after 20 minutes so it can never sit open burning server I/O.
function BackendLogs({
  active,
  tourStep,
  setTourStep,
  setTab,
}: {
  active: boolean;
  tourStep: number;
  setTourStep: (n: number) => void;
  setTab: (t: "frontend" | "backend") => void;
}) {
  const dispatch = useAppDispatch();
  const experiments = useAppSelector((s) => s.experiments.items);
  const [streaming, setStreaming] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [subTab, setSubTab] = useState<"logging" | "services">("logging");
  const [checking, setChecking] = useState(false);
  const [serviceLines, setServiceLines] = useState<string[]>([]);
  const [busyLabel, setBusyLabel] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [remaining, setRemaining] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const readyRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewRef = useRef<HTMLPreElement | null>(null);

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
        setServiceLines([]); // start the panel empty so the next step waits for a real click
        setSubTab("services");
        setTourStep(4);
      }, TOUR_STEP_DELAY_MS);
      return () => clearTimeout(t);
    }
  }, [tourStep, streaming, resetting, setTourStep]);

  // Tour: after Health check is clicked and the `docker ps` output lands in the panel
  // (serviceLines populated, no longer checking), pause, then head to the Frontend tab.
  useEffect(() => {
    if (tourStep === 4 && !checking && serviceLines.length > 0) {
      const t = setTimeout(() => {
        setTab("frontend");
        setTourStep(5);
      }, TOUR_STEP_DELAY_MS);
      return () => clearTimeout(t);
    }
  }, [tourStep, checking, serviceLines, setTab, setTourStep]);

  // Tour finale: land on the Logging sub-tab so the completion modal reveals the live stream.
  useEffect(() => {
    if (tourStep === 12) setSubTab("logging");
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

  async function start(restart: boolean) {
    // https://api…/ → wss://api…/logstream
    const wsUrl = API_BASE.replace(/^http/, "ws") + "/logstream";

    const notes: string[] = [];
    if (restart) {
      // Buckets first, while the API is still up — recreating the containers afterwards
      // wipes the log lines the clearing itself produces. The spinner covers both steps,
      // and streaming proceeds even if either one fails.
      setLines([]);
      setResetting(true);
      setBusyLabel("Clearing enrolled customers…");
      notes.push(await clearAllBuckets());
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

    const ws = new WebSocket(`${wsUrl}?token=${encodeURIComponent(LOGSTREAM_TOKEN)}`);
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
        setLines((prev) => [...prev, `[logstream] api did not report ready within ${READY_TIMEOUT_S}s`]);
        // Best effort: try to refill the sidebar anyway rather than leave it empty.
        dispatch(fetchExperiments());
      }, READY_TIMEOUT_S * 1000);
    }

    // Cap the buffer at 800 lines so a long stream can't grow memory without bound.
    ws.onmessage = (e) => {
      const line = String(e.data);
      if (API_READY.test(line)) {
        clearBusy();
        // The api is serving again — refill the sidebar that resetState() emptied.
        if (restart) dispatch(fetchExperiments());
      }
      setLines((prev) => [...prev, line].slice(-800));
    };
    ws.onerror = () => setLines((prev) => [...prev, "[logstream] connection error"]);
    ws.onclose = stop;
  }

  const mmss = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;

  async function healthCheck() {
    setChecking(true);
    setServiceLines(await fetchContainers());
    setChecking(false);
  }

  return (
    <div className="backend-logs" style={{ display: active ? "flex" : "none" }}>
      <div className="subtabbar">
        <button
          className={`subtab ${subTab === "logging" ? "active" : ""}`}
          onClick={() => setSubTab("logging")}
        >
          Logging
        </button>
        <button
          className={`subtab ${subTab === "services" ? "active" : ""}`}
          onClick={() => setSubTab("services")}
        >
          Micro-services
        </button>
      </div>

      {/* Both panels stay mounted — hiding rather than unmounting keeps the log
          WebSocket alive while you look at the micro-services panel. */}
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
                setChoosing(true); // straight to the restart choice (no intermediate dialog)
                if (tourStep === 1) setTourStep(2); // advance the tour to the Restart tip
              }}
            >
              Stream backend logs
            </button>
            {tourStep === 1 && (
              <div className="coach-tip" role="status">
                <span className="toast-badge">Tour</span>
                <div className="toast-body">
                  First, let&apos;s start a fresh session on the backend. Click the{" "}
                  <strong>Stream backend logs</strong> button.
                </div>
                <button className="toast-close" aria-label="Dismiss tour tip" onClick={() => setTourStep(0)}>
                  ×
                </button>
              </div>
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
            ? lines.map((line, i) => <AnsiLine key={i} text={line} />)
            : resetting
              ? busyLabel
              : 'Click "Stream backend logs" to begin.'}
        </pre>
      </div>

      <div className="backend-panel" style={{ display: subTab === "services" ? "flex" : "none" }}>
        <div className="backend-toolbar">
          <span className="tour-anchor">
            <button className="primary" disabled={checking} onClick={healthCheck}>
              {checking ? "Checking…" : "Health check"}
            </button>
            {tourStep === 4 && (
              <div className="coach-tip" role="status">
                <span className="toast-badge">Tour</span>
                <div className="toast-body">Inspect the health of the backend microservices.</div>
                <button className="toast-close" aria-label="Dismiss tour tip" onClick={() => setTourStep(0)}>
                  ×
                </button>
              </div>
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
            : 'Click "Health check" to list the running services.'}
        </pre>
      </div>

      {/* One step: choose whether to start clean, then stream. */}
      {choosing && (
        <RestartDialog
          tourActive={tourStep === 2}
          onDismissTour={() => setTourStep(0)}
          onDismiss={() => setChoosing(false)}
          onRestart={() => {
            setChoosing(false);
            if (tourStep === 2) setTourStep(3); // tour: waiting for the fresh session to come up
            start(true);
          }}
          onContinue={() => {
            setChoosing(false);
            // Off the scripted path, but keep the tour moving to the Micro-services step.
            if (tourStep === 2) setTourStep(3);
            start(false);
          }}
        />
      )}
    </div>
  );
}

// A small "ⓘ" button that toggles a popover with explanatory text.
function InfoButton(props: { text: string }) {
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
function VariantTag(props: { isControl: boolean }) {
  return (
    <span className={`vtag ${props.isControl ? "vtag-control" : "vtag-variant"}`}>
      {props.isControl ? "control" : "variant"}
    </span>
  );
}

function ResultsCard(props: {
  experiment: Experiment;
  users: AssignedUser[];
  tourStep: number;
  setTourStep: (n: number) => void;
}) {
  const dispatch = useAppDispatch();
  const { experiment, users } = props;
  const running = experiment.status === "RUNNING";

  // The control variant is the one flagged in the experiment definition (not inferred).
  const controlVariant = experiment.variants.find((v) => v.isControl) ?? experiment.variants[0];

  // Backend numbers, pushed from the Python stats service over SSE (see useStatsStream).
  const pushed = useAppSelector((s) => s.experiments.significanceByKey[experiment.key]);
  const connected = useAppSelector((s) => s.experiments.statsConnected);
  const byKey = new Map((pushed?.variants ?? []).map((v) => [v.variantKey, v]));
  const live = byKey.size > 0;

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
    <div className="card stats-sticky">
      <h3 className="card-title">
        {experiment.name}
        <span className={`badge ${experiment.status}`}>{experiment.status}</span>
        <InfoButton text={experiment.description ?? "No description."} />
      </h3>

      {/* The table always renders. With nobody enrolled every row is simply zeroed — the
          shape of the results stays on screen instead of appearing once traffic arrives. */}
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
      <p className="muted small">
        {live && connected ? (
          <>
            <span className="live-dot" aria-hidden="true" /> Computed by the Python stats service
            (two-proportion z-test, α = 0.05) and pushed over SSE. ✓ marks significance.
          </>
        ) : live ? (
          // Numbers stay on screen while we reconnect, but say so — a frozen table that
          // looks live is worse than a stale one that admits it.
          <>
            <span className="spinner" aria-hidden="true" /> Reconnecting to the stats service —
            figures below are from the last update.
          </>
        ) : (
          "Waiting for the stats service — showing locally counted values."
        )}
      </p>
      {users.length === 0 && (
        <p className="muted small">No customers enrolled yet — use the enrollment tools below.</p>
      )}

      <div className="card-actions">
        <span className="tour-anchor">
          <button
            className="primary"
            disabled={running}
            onClick={() => {
              dispatch(setStatus({ key: experiment.key, status: "RUNNING" }));
              if (props.tourStep === 10) props.setTourStep(11); // tour: on to the finale
            }}
          >
            🚀 Launch to production
          </button>
          {props.tourStep === 10 && (
            <div className="coach-tip" role="status">
              <span className="toast-badge">Tour</span>
              <div className="toast-body">
                Finally, launch the experiment to production and watch it go live.
              </div>
              <button
                className="toast-close"
                aria-label="Dismiss tour tip"
                onClick={() => props.setTourStep(0)}
              >
                ×
              </button>
            </div>
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
    </div>
  );
}

function AssignCard(props: {
  experimentKey: string;
  variants: Variant[];
  tourStep: number;
  setTourStep: (n: number) => void;
}) {
  const dispatch = useAppDispatch();
  const error = useAppSelector((s) => s.experiments.error);
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
      if (props.tourStep === 5) props.setTourStep(6); // tour: on to the Seed step
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
      <h3 className="card-title">
        Enroll Customers
        <InfoButton text="Simulate customers getting enrolled as new clients who are going to be guinea pigs and get put into the corresponding variant buckets." />
      </h3>
      <div className="row">
        <div>
          <label>Customer ID</label>
          <input value={userId} onChange={(e) => setUserId(e.target.value)} />
        </div>
        <div>
          <label>Variant</label>
          <select value={variantKey} onChange={(e) => setVariantKey(e.target.value)}>
            <option value="">Auto (deterministic)</option>
            {props.variants.map((v) => (
              <option key={v.key} value={v.key}>
                {v.name} {v.isControl ? "· control" : "· variant"}
              </option>
            ))}
          </select>
        </div>
        <span className="tour-anchor">
          <button className="primary" onClick={handleCreate}>
            Create User
          </button>
          {props.tourStep === 5 && (
            <div className="coach-tip" role="status">
              <span className="toast-badge">Tour</span>
              <div className="toast-body">
                Now let&apos;s simulate real users enrolling — each one gets bucketed into a variant.
              </div>
              <button
                className="toast-close"
                aria-label="Dismiss tour tip"
                onClick={() => props.setTourStep(0)}
              >
                ×
              </button>
            </div>
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
              Customer <strong>{pill.userId}</strong> already exists — found in Redis cache (variant{" "}
              <strong>{variantLabel(pill.variantKey)}</strong>)
            </div>
          ) : (
            <div className="result-pill success">
              Enrolled <strong>{pill.userId}</strong> → variant <strong>{variantLabel(pill.variantKey)}</strong>
            </div>
          ))}
      </div>
    </div>
  );
}

// The per-variant board: one column per variant. Enroll customers land here; record a
// success per customer, and seed/clear the whole board.
function UserBoard(props: {
  experimentKey: string;
  variants: Variant[];
  tourStep: number;
  setTourStep: (n: number) => void;
}) {
  const dispatch = useAppDispatch();
  const users = useAppSelector((s) =>
    s.experiments.assignments.filter((a) => a.experimentKey === props.experimentKey),
  );
  const hasUsers = users.length > 0;
  const boardRef = useRef<HTMLDivElement | null>(null);

  // Tour step 6: bring the whole Enrolled Customers panel into view.
  useEffect(() => {
    if (props.tourStep === 6) {
      boardRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [props.tourStep]);

  function seed() {
    const mkId = () => `cust_${Math.random().toString(36).slice(2, 8)}`;
    // Seed 5 customers into EVERY variant — handles 2-arm and multi-arm experiments.
    for (const v of props.variants) {
      for (let i = 0; i < 5; i++) {
        dispatch(assignUser({ key: props.experimentKey, userId: mkId(), variantKey: v.key }));
      }
    }
  }

  return (
    <div className="card" ref={boardRef}>
      <h3 className="card-title">
        Enrolled Customers
        <InfoButton text="Each enrolled customer lands in one variant column. Record a success (conversion) per customer — the blue button disables once recorded. Seed adds 5 customers to each variant; Clear empties the board." />
      </h3>

      <div className="board-toolbar">
        <span className="tour-anchor">
          <button
            className="primary"
            onClick={() => {
              seed();
              if (props.tourStep === 6) props.setTourStep(7); // tour: on to the first success
            }}
          >
            Seed 5 per variant
          </button>
          {props.tourStep === 6 && (
            <div className="coach-tip" role="status">
              <span className="toast-badge">Tour</span>
              <div className="toast-body">Seed 5 more users into each bucket.</div>
              <button
                className="toast-close"
                aria-label="Dismiss tour tip"
                onClick={() => props.setTourStep(0)}
              >
                ×
              </button>
            </div>
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
                // The tour spotlights three successes in order: one in bucket 1 (step 7), then two
                // in bucket 2 (steps 8 and 9). The spotlighted button advances the tour on click.
                let tipStep = 0;
                let tipText = "";
                if (colIndex === 0 && rowIndex === 0) {
                  tipStep = 7;
                  tipText = "Now let's simulate some successful events detected on customer surfaces.";
                } else if (colIndex === 1 && rowIndex === 0) {
                  tipStep = 8;
                  tipText = "Simulate another success.";
                } else if (colIndex === 1 && rowIndex === 1) {
                  tipStep = 9;
                  tipText = "One more time.";
                }
                const showTip = tipStep !== 0 && props.tourStep === tipStep;
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
                          if (showTip) props.setTourStep(tipStep + 1);
                        }}
                      >
                        {u.converted ? "✓ Recorded" : "Record success"}
                      </button>
                      {showTip && (
                        <div className="coach-tip coach-tip-left" role="status">
                          <span className="toast-badge">Tour</span>
                          <div className="toast-body">{tipText}</div>
                          <button
                            className="toast-close"
                            aria-label="Dismiss tour tip"
                            onClick={() => props.setTourStep(0)}
                          >
                            ×
                          </button>
                        </div>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
