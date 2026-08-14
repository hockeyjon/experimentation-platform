// Phase 2 — the active session's backend address, resolved at RUNTIME.
//
// In Phase 1 the whole app talked to one shared backend, baked in at build time as
// NEXT_PUBLIC_GRAPHQL_URL. Phase 2 gives each visitor their OWN isolated stack at
// `<origin>/s/<id>`, but the id only comes into existence after the provisioner spins that
// stack up — which happens in the browser, long after this static export was built. So the id
// lives here, in a tiny mutable module, and every backend caller (GraphQL, the SSE stats
// stream, the log-stream socket, the log-stream REST) reads its address THROUGH these helpers
// rather than a constant.
//
// The provisioner control API (/provision/*) is the one thing that is NOT session-scoped — it's
// how a session gets created in the first place — so it always targets the shared origin.

// Build-time origin of the shared edge, e.g. https://api.gunbarrelstudio.com (trailing slash off).
const ORIGIN = (process.env.NEXT_PUBLIC_GRAPHQL_URL ?? "http://localhost:4000/").replace(/\/+$/, "");

// One bundle token guards both the provisioner and the log stream (same value in both Deployments).
export const TOKEN = process.env.NEXT_PUBLIC_LOGSTREAM_TOKEN ?? "let-me-see-the-logs";

let currentId: string | null = null;
export const setSessionId = (id: string | null) => {
  currentId = id;
};
export const getSessionId = () => currentId;

// The path prefix Caddy routes on: "/s/<id>" once we hold a session, "" before that. Caddy
// strips it, so each backend still sees its normal paths ("/", "/logstream", "/stats/stream/…").
const prefix = () => (currentId ? `/s/${currentId}` : "");

// http(s) base for GraphQL, the SSE stats stream, and the log-stream REST endpoints — no slash.
export const httpBase = () => `${ORIGIN}${prefix()}`;
// ws(s) base for the log-stream socket: http→ws, https→wss.
export const wsBase = () => httpBase().replace(/^http/, "ws");

// The Phase 3 advisor endpoint — shared origin, NOT session-scoped (like /provision/*). The
// browser sends the on-screen experiment data in the body; CORS is gated on Origin, no token.
export const agentChatUrl = () => `${ORIGIN}/agent/chat`;

// A provisioner URL with the bundle token appended. Always the shared origin (not session-scoped).
const provisionUrl = (path: string) => {
  const sep = path.includes("?") ? "&" : "?";
  return `${ORIGIN}/provision${path}${sep}token=${encodeURIComponent(TOKEN)}`;
};

// --- session lifecycle ------------------------------------------------------------------
export type SessionStatus = "provisioning" | "ready" | "failed";
export type Session = { id: string; status: SessionStatus; path: string };

// A place in the FIFO waiting line: hold the ticket and keep calling createSession(ticket) until
// it's your turn (the response becomes a Session). `position` is 0-based (0 = next up).
export type QueueStatus = { queued: true; ticket: string; position: number; waiting: number };
export const isQueued = (r: Session | QueueStatus): r is QueueStatus => "queued" in r;

// POST /provision/sessions → a session (202) when it's our turn, or a queue place (200) when the
// active slots are full. Pass the ticket from a prior queued response to hold your place in line.
// The browser sends its Origin automatically; the provisioner checks it.
export async function createSession(ticket?: string): Promise<Session | QueueStatus> {
  const path = ticket ? `/sessions?ticket=${encodeURIComponent(ticket)}` : "/sessions";
  const res = await fetch(provisionUrl(path), { method: "POST" });
  // A rare race (a slot vanished between the capacity check and the claim) → stay in line and
  // retry on the next poll rather than erroring.
  if (res.status === 429) return { queued: true, ticket: ticket ?? "", position: 0, waiting: 1 };
  if (!res.ok) throw new Error(`provision request failed (${res.status})`);
  return (await res.json()) as Session | QueueStatus;
}

// GET /provision/sessions/:id → its current status.
async function getSession(id: string): Promise<Session> {
  const res = await fetch(provisionUrl(`/sessions/${id}`));
  if (!res.ok) throw new Error(`status request failed (${res.status})`);
  return (await res.json()) as Session;
}

// Poll until the stack reports ready (or fails / times out). Spin-up is ~30–60s: a fresh
// namespace, six containers, a schema push and a seed. A transient status hiccup is swallowed
// and retried rather than treated as failure.
export async function waitUntilReady(
  id: string,
  opts: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<Session> {
  const { timeoutMs = 220_000, intervalMs = 2500, signal } = opts;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const s = await getSession(id).catch(() => null);
    if (s?.status === "ready") return s;
    if (s?.status === "failed") throw new Error("the stack failed to come up");
    if (Date.now() > deadline) throw new Error("the stack timed out coming up");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// POST /provision/sessions/:id/heartbeat — refresh the idle-TTL lease while the tab is open.
// keepalive so a heartbeat fired right as the tab hides still lands. Best-effort.
export function heartbeat(id: string): void {
  fetch(provisionUrl(`/sessions/${id}/heartbeat`), { method: "POST", keepalive: true }).catch(() => {});
}

// DELETE /provision/sessions/:id — free the slot on unload so the next visitor doesn't wait out
// the idle TTL. keepalive lets the request outlive the page (sendBeacon can't set DELETE). The
// reaper's idle-TTL is the backstop if this ever misses.
export function releaseSession(id: string): void {
  try {
    void fetch(provisionUrl(`/sessions/${id}`), { method: "DELETE", keepalive: true });
  } catch {
    /* ignore — the reaper will collect it */
  }
}
