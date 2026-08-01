// Session provisioner (Phase 2) — hands each visitor their own isolated stack.
//
// On demand it creates a `session-<id>` namespace, applies the per-session stack
// (k8s/phase2/session-stack.yaml), waits for the api to come up, seeds it, and reports the
// session as ready. A visitor's browser heartbeats to keep the session alive; a background
// reaper deletes namespaces that stop heartbeating or exceed the hard cap on lifetime.
//
// Kubernetes namespaces ARE the source of truth (labelled + annotated), so the provisioner is
// effectively stateless — it can restart and rediscover every live session. It shells out to
// kubectl, which picks up the in-cluster ServiceAccount automatically (see k8s/phase2/provisioner.yaml).
//
// NOT part of the live deploy — this whole directory is Phase 2 scaffolding.
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT ?? 8090);
const TOKEN = process.env.PROVISIONER_TOKEN ?? "let-me-see-the-logs";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "https://experimentation.gunbarrelstudio.com";
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS ?? 3); // hard cap on TOTAL live stacks (active + warm)
// Cap on CLAIMED (active) sessions — the number of real visitors driving a tour at once. Kept
// BELOW MAX_SESSIONS on purpose: the spare slot holds a warm reserve, not another active user.
// This bounds concurrent load — N active users can each fire a disruptive backend "restart", and
// more than 2 of those at once on the box's 2 vCPUs overwhelms it ("failed to fetch" mid-tour).
const MAX_ACTIVE = Number(process.env.MAX_ACTIVE ?? 2);
// Ready-but-unclaimed stacks kept on standby so a visitor lands instantly instead of waiting
// out a 30–60s cold boot. Bounded by MAX_SESSIONS − claimed. A full stack takes ~30s to boot,
// so the pool is refilled ONE AT A TIME in the background — two cold boots at once starve the
// box's 2 vCPUs and the second misses its rollout deadline (the bug that made concurrent
// on-demand provisioning flaky).
const WARM_POOL = Number(process.env.WARM_POOL ?? 2);
const IDLE_TTL_S = Number(process.env.IDLE_TTL_SECONDS ?? 900); // 15 min since last heartbeat
const MAX_LIFETIME_S = Number(process.env.MAX_LIFETIME_SECONDS ?? 3600); // 1 h hard cap
const REAP_INTERVAL_MS = Number(process.env.REAP_INTERVAL_MS ?? 60000);
const POOL_INTERVAL_MS = Number(process.env.POOL_INTERVAL_MS ?? 10000); // pool top-up cadence
const STACK = process.env.STACK_PATH ?? "/app/session-stack.yaml";

const LABEL = "app=session-stack";
const now = () => Date.now();

// --- kubectl helpers --------------------------------------------------------------------
async function kubectl(args) {
  const { stdout } = await execFileAsync("kubectl", args, { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

const nsName = (id) => `session-${id}`;
const idOf = (ns) => ns.replace(/^session-/, "");

async function listSessions() {
  const out = await kubectl(["get", "ns", "-l", LABEL, "-o", "json"]).catch(() => '{"items":[]}');
  const items = JSON.parse(out).items ?? [];
  return items.map((ns) => {
    const a = ns.metadata.annotations ?? {};
    return {
      id: idOf(ns.metadata.name),
      status: a["provisioner/status"] ?? "unknown",
      created: Number(a["provisioner/created"] ?? 0),
      lastSeen: Number(a["provisioner/last-seen"] ?? 0),
      // Epoch ms a visitor claimed this stack, or 0 while it's a warm pool member.
      claimed: Number(a["provisioner/claimed"] ?? 0),
      phase: ns.status?.phase, // "Active" | "Terminating"
    };
  });
}

// Only sessions that still count against the cap (not mid-teardown).
const liveSessions = (all) => all.filter((s) => s.phase !== "Terminating");
const isClaimed = (s) => s.claimed > 0;
const isWarm = (s) => !isClaimed(s) && s.status === "ready"; // ready + waiting for a visitor

async function annotate(id, kv) {
  const pairs = Object.entries(kv).map(([k, v]) => `${k}=${v}`);
  await kubectl(["annotate", "ns", nsName(id), ...pairs, "--overwrite"]).catch(() => {});
}

// --- provisioning -----------------------------------------------------------------------
function newId() {
  return Math.random().toString(36).slice(2, 8);
}

// Spin up a fresh namespace + stack in the background. `claimed` marks it as a visitor's from
// the start (on-demand) vs a warm pool member (claimed later, when handed out).
async function createStack({ claimed }) {
  const id = newId();
  const ns = nsName(id);
  await kubectl(["create", "namespace", ns]);
  await kubectl(["label", "ns", ns, LABEL]);
  await annotate(id, {
    "provisioner/status": "provisioning",
    "provisioner/created": now(),
    "provisioner/last-seen": now(),
    ...(claimed ? { "provisioner/claimed": now() } : {}),
  });
  // The slow part (apply → wait → seed) runs in the background; the caller polls GET /sessions/:id.
  provision(id, ns).catch(async (e) => {
    console.error(`[provisioner] ${ns} failed: ${e.message}`);
    await annotate(id, { "provisioner/status": "failed" });
  });
  return id;
}

// POST /sessions — hand a visitor a stack. Prefer a warm one (instant); else a still-provisioning
// pool member (they poll it to ready); else, if a slot is free, provision one on demand; else 429.
async function claimSession() {
  const all = liveSessions(await listSessions());
  // Cap ACTIVE users at MAX_ACTIVE (below MAX_SESSIONS — the spare slot is the warm reserve).
  if (all.filter(isClaimed).length >= MAX_ACTIVE) {
    const err = new Error("at capacity");
    err.code = "CAPACITY";
    throw err;
  }
  // A warm stack is best (ready now); a provisioning-but-unclaimed pool member is next best.
  const target =
    all.find(isWarm) ?? all.find((s) => !isClaimed(s) && s.status === "provisioning");
  if (target) {
    // Claiming resets the lifetime clock so a stack that sat warm isn't reaped early once used.
    await annotate(target.id, {
      "provisioner/claimed": now(),
      "provisioner/created": now(),
      "provisioner/last-seen": now(),
    });
    console.log(`[provisioner] claimed ${nsName(target.id)} (was ${target.status})`);
    return { id: target.id, path: `/s/${target.id}`, status: target.status };
  }
  // Nothing pooled but a slot is free (cold start / pool not filled yet): provision on demand.
  const id = await createStack({ claimed: true });
  console.log(`[provisioner] provisioning ${nsName(id)} on demand (pool empty)`);
  return { id, path: `/s/${id}`, status: "provisioning" };
}

// Background: keep WARM_POOL ready stacks on standby, capped so warm + claimed ≤ MAX_SESSIONS.
// Refills ONE AT A TIME (skips if anything is already provisioning) so we never cold-boot two
// stacks at once — concurrent boots starve the box and time out.
async function maintainPool() {
  const all = liveSessions(await listSessions());
  const claimed = all.filter(isClaimed).length;
  const warm = all.filter(isWarm).length;
  const provisioning = all.filter((s) => s.status === "provisioning").length;
  const desiredWarm = Math.min(WARM_POOL, MAX_SESSIONS - claimed);
  if (provisioning === 0 && warm < desiredWarm && all.length < MAX_SESSIONS) {
    console.log(`[provisioner] pool: warm ${warm}/${desiredWarm} (claimed ${claimed}) — warming one`);
    await createStack({ claimed: false }).catch((e) =>
      console.error(`[provisioner] warm-up failed: ${e.message}`),
    );
  }
}

// --- FIFO waiting queue -----------------------------------------------------------------
// When every ACTIVE slot is taken, waiting visitors hold a ticket and poll. Only the ticket at
// the FRONT of the line may claim a freed slot, so service is first-come-first-served. A ticket
// that stops polling (closed tab) ages out, advancing the line. In-memory: a provisioner restart
// drops the queue and waiters simply re-enqueue on their next poll — fine for a demo.
const QUEUE_TTL_MS = Number(process.env.QUEUE_TTL_MS ?? 15000);
let queue = []; // [{ ticket, lastSeen }], oldest first

const newTicket = () => Math.random().toString(36).slice(2, 10);

function pruneQueue() {
  const cutoff = now() - QUEUE_TTL_MS;
  queue = queue.filter((q) => q.lastSeen >= cutoff);
}

// Refresh a ticket's lease (enrolling it if new/expired) and return its 0-based position in line.
function touchTicket(ticket) {
  pruneQueue();
  let q = queue.find((x) => x.ticket === ticket);
  if (!q) {
    q = { ticket, lastSeen: now() };
    queue.push(q);
  } else {
    q.lastSeen = now();
  }
  return queue.indexOf(q);
}

// Serialize the read-active → decide → claim critical section. Two polls arriving together must
// not both see the same free slot and both grant (overshooting MAX_ACTIVE) — the check and the
// claim aren't atomic across their awaits. The provisioner is single-replica, so an in-process
// promise-chain lock is enough: each claim decision runs only after the previous one has committed.
let claimLock = Promise.resolve();
function withClaimLock(fn) {
  const run = claimLock.then(fn, fn);
  claimLock = run.then(
    () => {},
    () => {},
  );
  return run;
}

async function provision(id, ns) {
  console.log(`[provisioner] provisioning ${ns}`);
  await kubectl(["apply", "-n", ns, "-f", STACK]);
  // Generous timeout: when several stacks boot at once (pool warm-up + active users' tour
  // "restart" recreating their api), a boot can be CPU-starved on the 2-vCPU box and take a
  // while. Better to let a contended boot finish than fail it (the frontend also retries).
  await kubectl(["-n", ns, "rollout", "status", "deploy/api", "--timeout=200s"]);
  // Seed sample experiments so the session opens on a populated demo.
  await kubectl(["-n", ns, "exec", "deploy/api", "--", "npm", "run", "seed"]).catch((e) =>
    console.error(`[provisioner] seed failed for ${ns}: ${e.message}`),
  );
  await annotate(id, { "provisioner/status": "ready" });
  console.log(`[provisioner] ${ns} ready`);
}

async function deleteSession(id) {
  await kubectl(["delete", "namespace", nsName(id), "--wait=false"]).catch(() => {});
}

// --- reaper -----------------------------------------------------------------------------
async function reap() {
  const all = await listSessions().catch(() => []);
  for (const s of liveSessions(all)) {
    // Failed provisions never come up but hold a slot — always reap them.
    if (s.status === "failed") {
      console.log(`[provisioner] reaping ${nsName(s.id)} (failed)`);
      await deleteSession(s.id);
      continue;
    }
    // Warm pool members have no heartbeat and are meant to sit until claimed — never idle them out.
    if (!isClaimed(s)) continue;
    const idleFor = (now() - s.lastSeen) / 1000;
    const ageFor = (now() - s.created) / 1000; // reset to claim time in claimSession
    if (idleFor > IDLE_TTL_S || ageFor > MAX_LIFETIME_S) {
      console.log(
        `[provisioner] reaping ${nsName(s.id)} (claimed, idle ${idleFor | 0}s, age ${ageFor | 0}s)`,
      );
      await deleteSession(s.id);
    }
  }
}

// --- HTTP -------------------------------------------------------------------------------
function gate(req, res, url, method) {
  const cors = {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    Vary: "Origin",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors).end();
    return null;
  }
  if (req.method !== method) {
    res.writeHead(405, cors).end("method");
    return null;
  }
  if (req.headers.origin && req.headers.origin !== ALLOWED_ORIGIN) {
    res.writeHead(403, cors).end("origin");
    return null;
  }
  if (url.searchParams.get("token") !== TOKEN) {
    res.writeHead(401, cors).end("unauthorized");
    return null;
  }
  return { ...cors, "Content-Type": "application/json" };
}

const send = (res, headers, code, body) => res.writeHead(code, headers).end(JSON.stringify(body));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  try {
    if (p === "/healthz") return void res.writeHead(200).end("ok");

    // GET /sessions/capacity → { active, max, available, warm } (active = claimed by a visitor)
    if (p === "/sessions/capacity") {
      const json = gate(req, res, url, "GET");
      if (!json) return;
      const all = liveSessions(await listSessions());
      const active = all.filter(isClaimed).length;
      const warm = all.filter(isWarm).length;
      // max/available are the ACTIVE-user cap (what a visitor can claim); warm is the reserve.
      pruneQueue();
      return send(res, json, 200, {
        active,
        max: MAX_ACTIVE,
        available: Math.max(0, MAX_ACTIVE - active),
        warm,
        waiting: queue.length,
      });
    }

    // POST /sessions → claim a stack, or take a place in the FIFO line.
    // First call (no ticket): served instantly if a slot is free AND nobody's waiting; otherwise
    // returns a ticket + position. Subsequent calls pass ?ticket=<t> to hold their place; only the
    // FRONT ticket claims a freed slot. Response is either a session (202) or {queued,...} (200).
    if (p === "/sessions" && req.method === "POST") {
      const json = gate(req, res, url, "POST");
      if (!json) return;
      try {
        const ticket = url.searchParams.get("ticket") || null;
        // Decide + claim ATOMICALLY w.r.t. other POST /sessions (see withClaimLock) so two polls
        // can't both see the same free slot and both grant. Send the response outside the lock.
        const result = await withClaimLock(async () => {
          const active = liveSessions(await listSessions()).filter(isClaimed).length;
          const slotFree = active < MAX_ACTIVE;
          if (ticket) {
            const pos = touchTicket(ticket); // refresh lease + get position
            if (slotFree && pos === 0) {
              queue = queue.filter((q) => q.ticket !== ticket); // dequeue the front, then serve it
              return { code: 202, body: await claimSession(), grant: true };
            }
            return { code: 200, body: { queued: true, ticket, position: pos, waiting: queue.length } };
          }
          pruneQueue();
          if (slotFree && queue.length === 0) {
            return { code: 202, body: await claimSession(), grant: true }; // room now, nobody ahead
          }
          const t = newTicket();
          return { code: 200, body: { queued: true, ticket: t, position: touchTicket(t), waiting: queue.length } };
        });
        if (result.grant) maintainPool().catch(() => {}); // top the pool back up (outside the lock)
        return send(res, json, result.code, result.body);
      } catch (e) {
        if (e.code === "CAPACITY") return send(res, json, 429, { error: "at capacity", retryAfter: 5 });
        throw e;
      }
    }

    // /sessions/:id  (GET status, POST heartbeat via /heartbeat, DELETE teardown)
    const m = p.match(/^\/sessions\/([a-z0-9]+)(\/heartbeat)?$/);
    if (m) {
      const id = m[1];
      const heartbeat = Boolean(m[2]);
      if (heartbeat) {
        const json = gate(req, res, url, "POST");
        if (!json) return;
        await annotate(id, { "provisioner/last-seen": now() });
        return send(res, json, 200, { ok: true });
      }
      if (req.method === "DELETE") {
        const json = gate(req, res, url, "DELETE");
        if (!json) return;
        await deleteSession(id);
        return send(res, json, 200, { deleted: true });
      }
      const json = gate(req, res, url, "GET");
      if (!json) return;
      const s = (await listSessions()).find((x) => x.id === id);
      if (!s) return send(res, json, 404, { error: "no such session" });
      return send(res, json, 200, { id, status: s.status, path: `/s/${id}` });
    }

    res.writeHead(404).end("not found");
  } catch (e) {
    console.error(`[provisioner] ${req.method} ${p} → ${e.message}`);
    res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: e.message }));
  }
});

setInterval(() => reap().catch((e) => console.error(`[provisioner] reap: ${e.message}`)), REAP_INTERVAL_MS);
setInterval(() => maintainPool().catch((e) => console.error(`[provisioner] pool: ${e.message}`)), POOL_INTERVAL_MS);
server.listen(PORT, () =>
  console.log(
    `[provisioner] listening on :${PORT} — ${MAX_ACTIVE} active max, ${MAX_SESSIONS} total, warm pool ${WARM_POOL}, idle TTL ${IDLE_TTL_S}s`,
  ),
);
