"use client";
// The dashboard. A client component that reads state from Redux and dispatches the
// async thunks (which call the GraphQL API). The enrolled-customer board is the
// source of truth for the results table, and it persists across reloads (localStorage).
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useChat } from "@ai-sdk/react";
import { useAppDispatch, useAppSelector, loadPersistedAssignments } from "@/store";
import { useStatsStream } from "@/hooks/useStatsStream";
import {
  httpBase,
  wsBase,
  TOKEN,
  agentChatUrl,
  createSession,
  isQueued,
  waitUntilReady,
  heartbeat as sessionHeartbeat,
  releaseSession,
  setSessionId,
} from "@/lib/session";
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
  Significance,
  Variant,
} from "@/store/experimentsSlice";

export default function Dashboard() {
  const dispatch = useAppDispatch();
  const { items, selectedKey, assignments, error, restarting } = useAppSelector(
    (s) => s.experiments,
  );
  const [tab, setTab] = useState<"frontend" | "backend">("frontend");
  // The "About" overlay (project + phase descriptions), opened from the title-bar pill.
  const [about, setAbout] = useState(false);
  // Claude pane: collapsed by default; opened from the tab-bar Claude button to `claudeWidth`% of
  // the width (drag-adjustable via the divider), closed again from the chevron in the panel.
  const [claudeOpen, setClaudeOpen] = useState(false);
  const [claudeWidth, setClaudeWidth] = useState(20);
  const splitRef = useRef<HTMLDivElement>(null);
  // First-load entry modal (Phase 2). Starts "provisioning" (logo + title + spinner while this
  // visitor's own isolated stack spins up), then resolves to "welcome" (ready — offer the tour),
  // "busy" (every session slot is taken — the provisioner's 429), or "error" (spin-up failed).
  // "done" once dismissed.
  const [entryState, setEntryState] = useState<
    "provisioning" | "welcome" | "busy" | "error" | "done"
  >("provisioning");
  // Guided tour progress. 0 = not running; each step drives a toast tip (+ any navigation).
  const [tourStep, setTourStep] = useState(0);
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

  // Drag the divider to re-split the experiment pane vs. the Claude pane (clamped 45–88%).
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

  // Tour finale: after Launch, once the experiment reads RUNNING, pause the configured delay,
  // then jump back to the Backend log stream and show the completion modal.
  useEffect(() => {
    if (tourStep === 11 && selected?.status === "RUNNING") {
      const t = setTimeout(() => {
        setTab("backend");
        setTourStep(12);
      }, TOUR_FINALE_DELAY_MS);
      return () => clearTimeout(t);
    }
  }, [tourStep, selected?.status]);

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
            setTab("backend"); // step 1: over to the Backend (log stream) tab
            setTourStep(1);
          }}
        />
      )}
      {tourStep === 12 && <TourDoneModal onEnd={() => setTourStep(0)} />}
      {about && <AboutModal onDismiss={() => setAbout(false)} />}
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
        <div className="tab-gap tab-gap-l" aria-hidden="true" />
        <div className="tab-picker">
          <label htmlFor="exp-select">Experiment</label>
          <select
            id="exp-select"
            value={selectedKey ?? ""}
            onChange={(e) => dispatch(selectExperiment(e.target.value))}
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
        <button
          className={`claude-tab${claudeOpen ? " active" : ""}`}
          onClick={() => {
            setTab("frontend");
            setClaudeOpen((o) => !o);
          }}
          title="Ask Claude about the current experiment"
          aria-pressed={claudeOpen}
        >
          <span className="claude-glyph" aria-hidden="true">✳</span> Claude
        </button>
      </div>

      {/* Both tabs stay mounted; we only hide the inactive one. That keeps the log
          WebSocket alive while you work in the Frontend tab, so the Backend tab
          captures the very logs your frontend actions produce. */}
      <div
        className="split"
        ref={splitRef}
        style={{ display: tab === "frontend" ? "flex" : "none" }}
      >
        <section className="exp-pane">
          <div className="exp-cards">
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
          <AdvisorPanel selectedKey={selectedKey} onClose={() => setClaudeOpen(false)} />
        </aside>
      </div>
      <BackendLogs active={tab === "backend"} tourStep={tourStep} setTourStep={setTourStep} setTab={setTab} />
    </>
  );
}

// The log-stream service sits behind the same host as the GraphQL API, under /logstream* —
// per session in Phase 2, so its address (and the GraphQL/SSE address) comes from lib/session.ts
// at call time: httpBase() for REST/SSE, wsBase() for the socket, TOKEN for the bundle guard.

// How often we refresh the session's idle-TTL lease. Well under the provisioner's 15-min TTL.
const SESSION_HEARTBEAT_MS = 60_000;
// Client-side idle-revoke: release this visitor's session after IDLE_TIMEOUT_SECONDS of no
// activity, warning with a live countdown for the final IDLE_WARNING_SECONDS. Keeps the box's few
// slots free for real users. Set both small (e.g. 30 / 15) to test the flow quickly.
const IDLE_TIMEOUT_SECONDS = 300; // 5 min of inactivity → release the session
const IDLE_WARNING_SECONDS = 60; // show the warning + countdown for the final minute
// While at capacity, how often to re-attempt a claim so the visitor auto-enters when a slot frees.
const BUSY_POLL_MS = 4_000;
// If a stack's boot fails (contention when several come up at once), wait this long, then retry.
const PROVISION_RETRY_MS = 4_000;
// Give up and show the error (with a manual retry) only after this many failed boot attempts.
const MAX_PROVISION_ATTEMPTS = 6;

// A restart isn't done when the container starts — node still runs `prisma db push` and
// boots. This is the line the api logs when it is actually serving; it must stay in sync
// with the log.info("startup", …) call in api/src/index.ts.
const API_READY = /GraphQL API ready/;
// Safety net only — the "GraphQL API ready" log line above is the real signal. Generous, because
// under load (other stacks booting, the pool warming a reserve) a restart's api recreation can
// take well over a minute; firing this early would fetch into a still-down api ("failed to fetch").
const READY_TIMEOUT_S = 180;

// How long the guided tour pauses before an auto-advance — long enough to read what just
// happened, short enough not to drag. The finale gets a longer beat so the "RUNNING" badge
// lands before the completion modal takes over.
const TOUR_STEP_DELAY_MS = 1200;
const TOUR_FINALE_DELAY_MS = 1800;
// How many interactive tips the visitor clicks through (drives the "N/9" progress counter).
const TOUR_TIPS = 9;

// Ask the log-stream service to recreate api + stats before we attach — the `make
// logs-reset` equivalent. Always resolves to a line for the log view: a failed or throttled
// reset is worth showing, but it never blocks the stream (seeing the logs is the point).
async function resetBackend(): Promise<string> {
  try {
    const res = await fetch(`${httpBase()}/logstream/reset?token=${encodeURIComponent(TOKEN)}`, {
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
      `${httpBase()}/logstream/containers?token=${encodeURIComponent(TOKEN)}`,
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
  "32": "#4ade80", // green   — assignUser
  "34": "#60a5fa", // blue    — graphql
  "36": "#22d3ee", // cyan    — lifecycle (launch / rollback)
  "33": "#facc15", // yellow  — postgres
  "38;5;208": "#fb923c", // orange  — mongo
  "38;5;141": "#a78bfa", // violet  — redis
  "35": "#e879f9", // magenta — [stats]
  "38;5;37": "#2dd4bf", // teal    — [api:logEvent]
  "38;5;245": "#94a3b8", // slate   — [logstream]
};

// A few tags come from sources that don't emit ANSI themselves — the Python stats service,
// the logstream service, and the api's uncolored logEvent scope. Wrap those tags in the ANSI
// codes above so the same AnsiLine renderer colors them. Run on each line before rendering.
const TAG_ANSI: Array<[RegExp, string]> = [
  [/\[stats\]/g, "\x1b[35m$&\x1b[0m"],
  [/\[api:logEvent\]/g, "\x1b[38;5;37m$&\x1b[0m"],
  [/\[logstream\]/g, "\x1b[38;5;245m$&\x1b[0m"],
];
function colorizeTags(line: string): string {
  return TAG_ANSI.reduce((s, [re, rep]) => s.replace(re, rep), line);
}

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

// A guided-tour coach-mark: a progress badge ("Tour · N/9"), the tip copy, and a dismiss ×.
// Drop it inside a `.tour-anchor` next to the button it points at; `placement` picks the side
// it sits on (default: right of the anchor). One component for every step so the counter,
// arrow, flash, and spotlight all stay consistent. Its mere presence makes the target button
// pulse (see `.tour-anchor:has(.coach-tip)` in globals.css) — no per-step wiring needed.
function CoachTip({
  n,
  placement,
  onClose,
  children,
}: {
  n: number;
  placement?: "left" | "above" | "corner" | "corner-left" | "corner-up-right";
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className={placement ? `coach-tip coach-tip-${placement}` : "coach-tip"} role="status">
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

// About overlay — opened from the title-bar pill. The project blurb + the Phase 1 / Phase 2
// panels that used to live in the welcome modal.
function AboutModal({ onDismiss }: { onDismiss: () => void }) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    <div className="modal-backdrop" onClick={onDismiss}>
      <div
        className="modal about-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={titleId}>About this project</h3>
        <p>
          A working, full-stack A/B experimentation platform, built to mirror a production stack:
          Next.js + Redux on the frontend, a GraphQL/Prisma API over Postgres, MongoDB, and Redis, a
          Python significance service, all on Kubernetes (k3s) behind Caddy on AWS. It came together
          as a pair-programming exercise with Claude — the three phases below trace how it was built,
          and how my role evolved from observer to collaborator.
        </p>
        <PhasePanels />
        <div className="modal-actions">
          <button className="primary" autoFocus onClick={onDismiss}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// The Phase 0 → 2 story cards, shown in the About overlay — the human/AI collaboration arc, in
// the builder's own voice.
function PhasePanels() {
  return (
    <div className="phase-cards">
      <section className="phase-card done">
        <h4>Phase 0 — The Big Bang</h4>
        <div className="phase-status">✓ Complete</div>
        <p>
          The initial big bang: I handed Claude the spec and it stood up the entire stack and a
          minimalist frontend in one shot. That first UI was sparse and unintuitive — just the
          Simulate / Create&nbsp;Users card with no error checking, a slimmer variant-stats table,
          and only one button in the whole app: <strong>Create User</strong>.
        </p>
      </section>

      <section className="phase-card done">
        <h4>Phase 1 — The Micro-Manager</h4>
        <div className="phase-status">✓ Complete</div>
        <p>
          I shifted from learner and observer to micro-manager of our pair-programming exercise —
          owning the code and the UX, iterating in small steps, asking questions and making updates
          until I understood the whole stack, and steadily guiding Claude toward a far more intuitive
          user experience.
        </p>
        <div className="phase-stack">
          <code>Next.js · Redux</code>
          <code>GraphQL · Prisma</code>
          <code>Postgres</code>
          <code>MongoDB</code>
          <code>Redis</code>
          <code>Python/FastAPI</code>
          <code>k3s</code>
          <code>AWS</code>
          <code>EC2</code>
          <code>S3</code>
          <code>CloudFront</code>
        </div>
      </section>

      <section className="phase-card done">
        <h4>Phase 2 — Full Collaboration</h4>
        <div className="phase-status">✓ Live — you&apos;re using it now</div>
        <p>
          A true collaboration between Claude and me: we worked together to get Kubernetes running
          quickly and smoothly, with a <strong>FIFO queue</strong> that lines up waiting visitors and
          hands each one an isolated namespace session the moment a slot frees. We developed the new
          Phase 2 stack on a parallel AWS dev environment, then cut production over by swapping the
          Elastic IP onto the Kubernetes box (same IP, zero DNS wait).
        </p>
        <div className="phase-stack">
          <code>Namespace per session</code>
          <code>FIFO queue + warm pool</code>
          <code>ResourceQuota</code>
          <code>NetworkPolicy</code>
          <code>Provisioner API</code>
          <code>k3s</code>
        </div>
      </section>
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
        <p>Now you can watch the full data flow in the backend log stream. Happy experimenting!</p>
        <p className="tour-done-emoji">🎉</p>
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
  const [stopped, setStopped] = useState(false); // true after Stop: log cleared, showing the prompt
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
  const prevTourStep = useRef(tourStep); // to detect the finale modal closing (12 → 0)

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

  // Tour finale: when "End tour" closes the modal (12 → 0), wait for the revealed log to
  // render, then a beat (500ms), then scroll to the newest lines.
  useEffect(() => {
    const wasFinale = prevTourStep.current === 12;
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
                // This visitor owns their isolated session, so there's no "in use by another"
                // race here — go straight to the restart choice.
                setChoosing(true);
                if (tourStep === 1) setTourStep(2); // advance the tour to the Restart tip
              }}
            >
              Stream backend logs
            </button>
            {tourStep === 1 && (
              <CoachTip n={1} onClose={() => setTourStep(0)}>
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

      <div className="backend-panel" style={{ display: subTab === "services" ? "flex" : "none" }}>
        <div className="backend-toolbar">
          <span className="tour-anchor">
            <button className="primary" disabled={checking} onClick={healthCheck}>
              {checking ? "Checking…" : "Health check"}
            </button>
            {tourStep === 4 && !checking && serviceLines.length === 0 && (
              <CoachTip n={3} placement="corner" onClose={() => setTourStep(0)}>
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

// Compact context sent to the advisor: exactly the numbers shown in the results table (live stats
// when the Python service has pushed them, else the local enrolled-board counts). The LLM reasons
// over this and nothing else.
type AdvisorContext = {
  key: string;
  name: string;
  status: string;
  variants: {
    name: string;
    isControl: boolean;
    exposures: number;
    conversions: number;
    rate: number;
    lift: number | null;
    pValue: number | null;
    significant: boolean;
  }[];
};

function buildAdvisorContext(
  experiment: Experiment,
  users: AssignedUser[],
  pushed: Significance | undefined,
): AdvisorContext {
  const control = experiment.variants.find((v) => v.isControl) ?? experiment.variants[0];
  const byKey = new Map((pushed?.variants ?? []).map((v) => [v.variantKey, v]));
  return {
    key: experiment.key,
    name: experiment.name,
    status: experiment.status,
    variants: experiment.variants.map((v) => {
      const stat = byKey.get(v.key);
      const inV = users.filter((u) => u.variantKey === v.key);
      const exposures = stat ? stat.exposures : inV.length;
      const conversions = stat ? stat.conversions : inV.filter((u) => u.converted).length;
      return {
        name: v.name,
        isControl: v.key === control?.key,
        exposures,
        conversions,
        rate: exposures ? Number((conversions / exposures).toFixed(3)) : 0,
        lift: stat ? Number((stat.liftPct / 100).toFixed(3)) : null,
        pValue: stat ? stat.pValue : null,
        significant: stat ? stat.significant : false,
      };
    }),
  };
}

// Minimal markdown: render **bold** spans. Newlines are preserved via white-space: pre-wrap.
function renderMd(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

// Left-pane advisor: streams a Claude answer (Bedrock) about the SELECTED experiment. The shared,
// stateless agent gets everything it needs from `context` — no per-session backend access.
function AdvisorPanel({
  selectedKey,
  onClose,
}: {
  selectedKey: string | null;
  onClose: () => void;
}) {
  const experiment = useAppSelector(
    (s) => s.experiments.items.find((e) => e.key === selectedKey) ?? null,
  );
  const users = useAppSelector((s) =>
    s.experiments.assignments.filter((a) => a.experimentKey === selectedKey),
  );
  const pushed = useAppSelector((s) =>
    selectedKey ? s.experiments.significanceByKey[selectedKey] : undefined,
  );

  const { messages, input, handleInputChange, handleSubmit, status } = useChat({
    api: agentChatUrl(),
    streamProtocol: "text",
  });
  const logRef = useRef<HTMLDivElement>(null);
  // Keep the newest exchange in view: the log is bottom-anchored, so the input sits right under
  // the last answer and older messages spill off the top. Always jump to the bottom on a freshly
  // asked question; while an answer streams, only follow if the reader is already near the bottom
  // (so scrolling up to read history isn't yanked back down).
  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    const last = messages[messages.length - 1];
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    if (last?.role === "user" || nearBottom) log.scrollTop = log.scrollHeight;
  }, [messages]);

  // Auto-grow the textarea to its content so the whole question is always visible.
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const ta = taRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = `${ta.scrollHeight}px`;
    }
  }, [input]);

  if (!experiment) return null;
  const busy = status === "submitted" || status === "streaming";
  const context = buildAdvisorContext(experiment, users, pushed);
  const last = messages[messages.length - 1];

  return (
    <div className="advisor">
      <div className="advisor-head">
        <h2>Ask Claude…</h2>
        <button
          type="button"
          className="advisor-collapse"
          onClick={onClose}
          title="Collapse"
          aria-label="Collapse Claude"
        >
          ›
        </button>
      </div>
      <div className="advisor-log" ref={logRef} aria-live="polite">
        {messages.length === 0 ? (
          <p className="muted small">
            Ask about the variants, buckets, or stats — or whether it&apos;s safe to launch.
          </p>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`advisor-msg ${m.role}`}>
              {m.role === "assistant" ? renderMd(m.content) : m.content}
            </div>
          ))
        )}
        {busy && last?.role !== "assistant" && (
          <div className="advisor-msg assistant">
            <span className="spinner" aria-hidden="true" /> thinking…
          </div>
        )}
      </div>
      <form className="advisor-form" onSubmit={(e) => handleSubmit(e, { body: { context } })}>
        <textarea
          value={input}
          onChange={handleInputChange}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter inserts a newline.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (input.trim() && !busy) handleSubmit(e, { body: { context } });
            }
          }}
          ref={taRef}
          placeholder="Should I launch to production?"
          rows={1}
          disabled={busy}
        />
        <button type="submit" className="primary" disabled={busy || !input.trim()}>
          Ask
        </button>
      </form>
    </div>
  );
}

// A chevron in a card's top-right corner that collapses / expands the card body. Chevron points
// up (⌃) when open — click to collapse; down (⌄) when collapsed — click to expand.
function CardToggle({
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

function ResultsCard(props: {
  experiment: Experiment;
  users: AssignedUser[];
  tourStep: number;
  setTourStep: (n: number) => void;
}) {
  const dispatch = useAppDispatch();
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
    <div className="card stats-sticky">
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
              if (props.tourStep === 10) props.setTourStep(11); // tour: on to the finale
            }}
          >
            🚀 Launch to production
          </button>
          {props.tourStep === 10 && (
            <CoachTip n={9} onClose={() => props.setTourStep(0)}>
              Ship it — <strong>Launch to production</strong> and watch the experiment go live.
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

function AssignCard(props: {
  experimentKey: string;
  variants: Variant[];
  tourStep: number;
  setTourStep: (n: number) => void;
}) {
  const dispatch = useAppDispatch();
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
            <CoachTip n={4} placement="corner-left" onClose={() => props.setTourStep(0)}>
              <strong>Create a user</strong> — they&apos;re hashed into a variant bucket and stick
              there on every future visit.
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
  const [collapsed, setCollapsed] = useState(false);

  // Tour step 6: bring the whole Enrolled Customers panel into view.
  useEffect(() => {
    if (props.tourStep === 6) {
      boardRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [props.tourStep]);

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
              if (props.tourStep === 6) props.setTourStep(7); // tour: on to the first success
            }}
          >
            Seed 5 per variant
          </button>
          {props.tourStep === 6 && (
            <CoachTip n={5} placement="corner-up-right" onClose={() => props.setTourStep(0)}>
              Fill both buckets fast — <strong>Seed 5 per variant</strong>.
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
                // The tour spotlights three successes in order: one in bucket 1 (step 7), then two
                // in bucket 2 (steps 8 and 9). The spotlighted button advances the tour on click.
                let tipStep = 0;
                let tipText = "";
                // Bucket-1 (left column) tips point up-right so they clear the Experiments
                // sidebar; the bucket-2 (right column) tips point left into the open gap.
                let tipPlacement: "left" | "corner-up-right" = "left";
                if (colIndex === 0 && rowIndex === 0) {
                  tipStep = 7;
                  tipText = "Log a conversion — a real success event from this customer.";
                  tipPlacement = "corner-up-right";
                } else if (colIndex === 1 && rowIndex === 0) {
                  tipStep = 8;
                  tipText = "Log one in the other variant so both have wins.";
                } else if (colIndex === 1 && rowIndex === 1) {
                  tipStep = 9;
                  tipText = "One more — enough signal to compare the variants.";
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
                        <CoachTip n={tipStep - 1} placement={tipPlacement} onClose={() => props.setTourStep(0)}>
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
