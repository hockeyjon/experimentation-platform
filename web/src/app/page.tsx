"use client";
// The dashboard. A client component that reads state from Redux and dispatches the
// async thunks (which call the GraphQL API). The enrolled-customer board is the
// source of truth for the results table, and it persists across reloads (localStorage).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAppDispatch, useAppSelector, loadPersistedAssignments } from "@/store";
import {
  assignUser,
  clearBucket,
  fetchExperiments,
  hydrateAssignments,
  logConversion,
  selectExperiment,
  setStatus,
  AssignedUser,
  Experiment,
  Variant,
} from "@/store/experimentsSlice";

export default function Dashboard() {
  const dispatch = useAppDispatch();
  const { items, selectedKey, assignments, loading, error } = useAppSelector((s) => s.experiments);
  const [tab, setTab] = useState<"frontend" | "backend">("frontend");

  // Load experiments + restore the persisted buckets on mount.
  useEffect(() => {
    dispatch(fetchExperiments());
    dispatch(hydrateAssignments(loadPersistedAssignments()));
  }, [dispatch]);

  const selected = items.find((e) => e.key === selectedKey) ?? null;

  return (
    <>
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
          {loading && <p className="muted">Loading…</p>}
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
              />
              {/* key forces a fresh AssignCard (input, variant select, pill) per experiment */}
              <AssignCard key={selected.key} experimentKey={selected.key} variants={selected.variants} />
              <UserBoard experimentKey={selected.key} variants={selected.variants} />
            </>
          ) : (
            <p className="muted">Select an experiment.</p>
          )}
        </main>
      </div>
      <BackendLogs active={tab === "backend"} />
    </>
  );
}

// Ask the log-stream service to recreate api + stats before we attach — the `make
// logs-reset` equivalent. Always resolves to a line for the log view: a failed or throttled
// reset is worth showing, but it never blocks the stream (seeing the logs is the point).
async function resetBackend(base: string, token: string): Promise<string> {
  try {
    const res = await fetch(`${base}/logstream/reset?token=${encodeURIComponent(token)}`, {
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

// The api container colors its [api:<scope>] tags with ANSI escapes so `make logs` is
// scannable by subsystem. A <pre> renders those escapes as literal junk, so translate the
// codes the logger emits into spans. Codes we don't map are dropped rather than shown.
const ANSI_COLOR: Record<string, string> = {
  "32": "#4ade80", // green  — assignUser
  "34": "#60a5fa", // blue   — graphql
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

// The "Backend" tab: opens a WebSocket to the log-stream service and shows redacted,
// time-limited backend logs. No history is fetched (tail=0), and the stream auto-closes
// after 5 minutes so it can never sit open burning server I/O.
function BackendLogs({ active }: { active: boolean }) {
  const [streaming, setStreaming] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [remaining, setRemaining] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const viewRef = useRef<HTMLPreElement | null>(null);

  const stop = () => {
    wsRef.current?.close();
    wsRef.current = null;
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
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

  async function start() {
    const ok = window.confirm(
      "Backend logs will stream for 5 minutes, then automatically disconnect (this keeps " +
        "server load bounded).  Logs are " +
        "redacted server-side — database IDs and emails stripped (user handles are generic " +
        "demo values). Continue?",
    );
    if (!ok) return;

    // Derive the endpoints from the GraphQL URL: https://api…/ → wss://api…/logstream
    const api = process.env.NEXT_PUBLIC_GRAPHQL_URL ?? "https://api.gunbarrelstudio.com/";
    const base = api.replace(/\/+$/, "");
    const wsUrl = base.replace(/^http/, "ws") + "/logstream";
    const token = process.env.NEXT_PUBLIC_LOGSTREAM_TOKEN ?? "let-me-see-the-logs";

    // Recreate api + stats first (the `make logs-reset` equivalent) so the stream starts on
    // an empty log. The spinner covers this; streaming proceeds either way.
    setLines([]);
    setResetting(true);
    const note = await resetBackend(base, token);
    setResetting(false);

    const ws = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token)}`);
    wsRef.current = ws;
    setLines([note]);
    setStreaming(true);
    setRemaining(300);
    tickRef.current = setInterval(() => setRemaining((r) => Math.max(0, r - 1)), 1000);

    // Cap the buffer at 800 lines so a long stream can't grow memory without bound.
    ws.onmessage = (e) => setLines((prev) => [...prev, String(e.data)].slice(-800));
    ws.onerror = () => setLines((prev) => [...prev, "[logstream] connection error"]);
    ws.onclose = stop;
  }

  const mmss = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;

  return (
    <div className="backend-logs" style={{ display: active ? "flex" : "none" }}>
      <div className="backend-toolbar">
        {resetting ? (
          <>
            <button className="primary" disabled>
              Stream backend logs
            </button>
            <span className="muted">
              <span className="spinner" aria-hidden="true" /> recreating api + stats…
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
          <button className="primary" onClick={start}>
            Stream backend logs
          </button>
        )}
        <span className="muted small">
          Live api + stats logs, redacted server-side (DB IDs + emails stripped). Recreates api +
          stats on start; auto-disconnects after 5 minutes.
        </span>
      </div>
      <pre className="log-view" ref={viewRef} aria-busy={resetting}>
        {lines.length
          ? lines.map((line, i) => <AnsiLine key={i} text={line} />)
          : resetting
            ? "Recreating api + stats…"
            : 'Click "Stream backend logs" to begin.'}
      </pre>
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

function ResultsCard(props: { experiment: Experiment; users: AssignedUser[] }) {
  const dispatch = useAppDispatch();
  const { experiment, users } = props;
  const running = experiment.status === "RUNNING";

  // The control variant is the one flagged in the experiment definition (not inferred).
  const controlVariant = experiment.variants.find((v) => v.isControl) ?? experiment.variants[0];

  // Per-variant stats computed from the enrolled board.
  const rows = experiment.variants.map((v) => {
    const inVariant = users.filter((u) => u.variantKey === v.key);
    const exposures = inVariant.length;
    const conversions = inVariant.filter((u) => u.converted).length;
    return { v, exposures, conversions, rate: exposures > 0 ? conversions / exposures : 0 };
  });
  const controlRow = rows.find((r) => r.v.key === controlVariant?.key);
  const controlRate = controlRow && controlRow.exposures > 0 ? controlRow.rate : 0;

  return (
    <div className="card stats-sticky">
      <h3 className="card-title">
        {experiment.name}
        <span className={`badge ${experiment.status}`}>{experiment.status}</span>
        <InfoButton text={experiment.description ?? "No description."} />
      </h3>

      {users.length === 0 ? (
        <p className="muted">No customers enrolled yet — use the enrollment tools below.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Variant</th>
              <th>Enrolled</th>
              <th>Successes</th>
              <th>Success rate</th>
              <th>Lift vs control</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ v, exposures, conversions, rate }) => {
              const isControl = v.key === controlVariant?.key;
              const lift = controlRate > 0 && !isControl ? (rate - controlRate) / controlRate : 0;
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
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="card-actions">
        <button
          className="primary"
          disabled={running}
          onClick={() => dispatch(setStatus({ key: experiment.key, status: "RUNNING" }))}
        >
          🚀 Launch to production
        </button>
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

function AssignCard(props: { experimentKey: string; variants: Variant[] }) {
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
        <button className="primary" onClick={handleCreate}>
          Create User
        </button>
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
function UserBoard(props: { experimentKey: string; variants: Variant[] }) {
  const dispatch = useAppDispatch();
  const users = useAppSelector((s) =>
    s.experiments.assignments.filter((a) => a.experimentKey === props.experimentKey),
  );
  const hasUsers = users.length > 0;

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
    <div className="card">
      <h3 className="card-title">
        Enrolled Customers
        <InfoButton text="Each enrolled customer lands in one variant column. Record a success (conversion) per customer — the blue button disables once recorded. Seed adds 5 customers to each variant; Clear empties the board." />
      </h3>

      <div className="board-toolbar">
        <button className="primary" onClick={seed}>
          Seed 5 per variant
        </button>
        <button
          className="warn"
          disabled={!hasUsers}
          onClick={() => dispatch(clearBucket(props.experimentKey))}
        >
          Clear buckets
        </button>
      </div>

      <div className="variant-columns">
        {props.variants.map((v) => {
          const colUsers = users.filter((u) => u.variantKey === v.key);
          return (
            <div key={v.key} className="variant-col">
              <div className="variant-col-head">
                {v.name} <VariantTag isControl={v.isControl} />{" "}
                <span className="muted">({colUsers.length})</span>
              </div>
              {colUsers.length === 0 && <div className="muted small">No customers yet</div>}
              {colUsers.map((u) => (
                <div key={u.userId} className="user-row">
                  <span className="user-name" title={u.userId}>
                    {u.userId}
                  </span>
                  <button
                    className="primary small-btn"
                    disabled={u.converted}
                    onClick={() => {
                      // Record the success on the backend; the board's converted flag
                      // drives the results table (no separate results fetch needed).
                      dispatch(logConversion({ key: props.experimentKey, userId: u.userId }));
                    }}
                  >
                    {u.converted ? "✓ Recorded" : "Record success"}
                  </button>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
