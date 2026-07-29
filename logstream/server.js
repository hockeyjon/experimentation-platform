// Log-stream service — streams the api + stats container logs over a WebSocket.
//
// SAFETY POSTURE (there is deliberately NO user-facing auth step):
//   1. REDACTION is the real protection. Every line is scrubbed of database IDs, event
//      metadata, and emails BEFORE it leaves this process (user IDs are generic demo
//      handles, left visible on purpose) — so the browser only ever receives sanitized
//      logs. The raw logs never cross the network.
//   2. GATING is automatic (no user step): the request Origin must match the app, and a
//      token baked into the app build must be present. Neither is a hard secret (the
//      token ships in the public bundle), so they only deter casual access — the
//      redaction + limits below are what actually keep this safe.
//   3. LIMITS: one concurrent stream, a hard time cap, tail=0 (no history), and the
//      Docker log streams are destroyed the moment the socket closes.
//   4. The one mutating endpoint is POST /logstream/reset, which recreates api + stats so
//      a stream can begin from a fresh boot with an empty log (the `make logs-reset`
//      equivalent). Same gating as the stream, plus a cooldown — recreating those two
//      containers is the only Docker write this service ever performs.
import http from "node:http";
import { PassThrough } from "node:stream";
import { WebSocketServer } from "ws";
import Docker from "dockerode";

const PORT = Number(process.env.PORT ?? 8080);
const TOKEN = process.env.LOGSTREAM_TOKEN ?? "let-me-see-the-logs";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "https://experimentation.gunbarrelstudio.com";
const SERVICES = (process.env.LOG_SERVICES ?? "api,stats").split(",");
const PROJECT = process.env.COMPOSE_PROJECT ?? "deploy";
const MAX_SECONDS = Number(process.env.MAX_STREAM_SECONDS ?? 1200); // 20 minutes
const RESET_COOLDOWN = Number(process.env.RESET_COOLDOWN_SECONDS ?? 30);

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

// --- Redaction: scrub DB IDs, event metadata, and emails before anything leaves the
// server. User IDs are intentionally NOT redacted — in this demo they're generic, non-PII
// handles (e.g. "alice", "user-42"), and keeping them visible is what makes the
// assign → cache → event flow legible. Experiment/variant names stay for the same reason. ---
function redact(line) {
  return line
    .replace(/"(?:id|_id|variantId|experimentId|assignmentId|insertedId)"\s*:\s*"[^"]*"/g,
      (m) => m.replace(/"[^"]*"$/, '"‹id›"'))
    .replace(/"metadata"\s*:\s*\{[^}]*\}/g, '"metadata":‹redacted›')
    .replace(/_id=\S+/g, "_id=‹id›")
    .replace(/\b[a-f0-9]{24}\b/g, "‹id›") // Mongo ObjectId
    .replace(/\bc[a-z0-9]{24}\b/g, "‹id›") // Prisma cuid
    .replace(/[\w.+-]+@[\w.-]+\.\w+/g, "‹email›");
}

async function findContainers() {
  const list = await docker.listContainers({
    filters: { label: [`com.docker.compose.project=${PROJECT}`] },
  });
  const wanted = new Set(SERVICES);
  return list
    .filter((c) => wanted.has(c.Labels["com.docker.compose.service"]))
    .map((c) => ({ id: c.Id, service: c.Labels["com.docker.compose.service"] }));
}

// Render a container's port bindings the way `docker ps` does: published ports as
// "0.0.0.0:443->443/tcp", unpublished ones as bare "8000/tcp". Deduped and sorted, since
// the Docker API lists an entry per address family.
function formatPorts(ports = []) {
  const seen = [
    ...new Set(
      ports.map((p) =>
        p.PublicPort ? `${p.IP}:${p.PublicPort}->${p.PrivatePort}/${p.Type}` : `${p.PrivatePort}/${p.Type}`,
      ),
    ),
  ];
  return seen.sort().join(", ");
}

// Everything running on the host, i.e. what `make list-backend` shows. Read-only, so
// unlike /logstream/reset it needs no cooldown.
async function listAllContainers() {
  const list = await docker.listContainers();
  return list
    .map((c) => ({
      name: (c.Names?.[0] ?? "").replace(/^\//, ""),
      image: c.Image,
      state: c.State,
      status: c.Status,
      service: c.Labels?.["com.docker.compose.service"] ?? null,
      ports: formatPorts(c.Ports),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Recreate the app containers — the browser-side equivalent of `make logs-reset`
// (`docker compose up -d --force-recreate api stats`). A restart is not enough: Docker's
// log file lives as long as the container, so only a brand-new container starts empty.
//
// Each container is rebuilt from its own inspected config, so the compose labels, env,
// binds and network aliases carry over and `docker compose` still owns it afterwards.
// Runtime-only network values (IPs, endpoint IDs, generated DNS names) must NOT be
// replayed into create — only the aliases compose assigned.
function createSpecFrom(info) {
  const EndpointsConfig = {};
  for (const [network, net] of Object.entries(info.NetworkSettings.Networks)) {
    const aliases = (net.Aliases ?? []).filter((a) => !info.Id.startsWith(a));
    EndpointsConfig[network] = {
      Aliases: aliases,
      ...(net.IPAMConfig ? { IPAMConfig: net.IPAMConfig } : {}),
    };
  }
  return {
    ...info.Config,
    name: info.Name.replace(/^\//, ""),
    HostConfig: info.HostConfig,
    NetworkingConfig: { EndpointsConfig },
  };
}

async function recreateServices() {
  const containers = await findContainers();
  await Promise.all(
    containers.map(async ({ id }) => {
      const old = docker.getContainer(id);
      const info = await old.inspect();
      // t=3 caps the SIGTERM grace period: PID 1 in the api container is `sh -c …`, which
      // never forwards the signal to node, so every stop would otherwise wait the full 10s.
      await old.stop({ t: 3 }).catch(() => {}); // already stopped is fine
      await old.remove();
      const next = await docker.createContainer(createSpecFrom(info));
      await next.start();
    }),
  );
  return containers.map((c) => c.service);
}

let lastReset = 0;

// POST /logstream/reset — same gating as the stream (app origin + bundle token), plus a
// cooldown. The token is public (it ships in the browser bundle), so the cooldown is what
// stops this from being a lever to keep the API perpetually restarting.
// Shared gating for the HTTP endpoints: CORS preflight, method, app origin, bundle token.
// Returns the JSON response headers when the request may proceed, or null once it has
// already answered the request.
function gate(req, res, url, method) {
  const cors = {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": `${method}, OPTIONS`,
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

// GET /logstream/containers — what is running on the host, i.e. `make list-backend`.
async function handleContainers(req, res, url) {
  const json = gate(req, res, url, "GET");
  if (!json) return;
  try {
    const containers = await listAllContainers();
    return res.writeHead(200, json).end(JSON.stringify({ containers }));
  } catch (e) {
    console.error(`[logstream] container list failed: ${e.message}`);
    return res.writeHead(500, json).end(JSON.stringify({ error: e.message }));
  }
}

async function handleReset(req, res, url) {
  const json = gate(req, res, url, "POST");
  if (!json) return;

  const waitMs = lastReset + RESET_COOLDOWN * 1000 - Date.now();
  if (waitMs > 0) {
    const retryInSeconds = Math.ceil(waitMs / 1000);
    return res.writeHead(429, json).end(JSON.stringify({ error: "cooldown", retryInSeconds }));
  }
  lastReset = Date.now();

  try {
    const recreated = await recreateServices();
    console.log(`[logstream] recreated ${recreated.join(", ")}`);
    return res.writeHead(200, json).end(JSON.stringify({ recreated }));
  } catch (e) {
    lastReset = 0; // the recreate never happened — don't burn the cooldown on it
    console.error(`[logstream] recreate failed: ${e.message}`);
    return res.writeHead(500, json).end(JSON.stringify({ error: e.message }));
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/healthz") return res.writeHead(200).end("ok");
  if (url.pathname === "/logstream/reset") return handleReset(req, res, url);
  if (url.pathname === "/logstream/containers") return handleContainers(req, res, url);
  res.writeHead(426).end("Upgrade Required");
});
const wss = new WebSocketServer({ server, path: "/logstream" });

let active = null; // enforce a single concurrent stream

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url, "http://x");
  // --- automatic gating ---
  if (req.headers.origin && req.headers.origin !== ALLOWED_ORIGIN) return ws.close(1008, "origin");
  if (url.searchParams.get("token") !== TOKEN) return ws.close(1008, "unauthorized");
  if (active) {
    ws.send("[logstream] another stream is already active — try again in a moment");
    return ws.close(1013, "busy");
  }
  active = ws;

  const send = (line) => { if (ws.readyState === ws.OPEN) ws.send(redact(line)); };
  send(`[logstream] connected — streaming ${SERVICES.join(", ")} for ${MAX_SECONDS}s (redacted)`);

  const streams = [];
  const timer = setTimeout(() => {
    send("[logstream] time limit reached — disconnecting");
    ws.close(1000, "time-limit");
  }, MAX_SECONDS * 1000);

  const cleanup = () => {
    clearTimeout(timer);
    for (const s of streams) { try { s.destroy(); } catch { /* ignore */ } }
    if (active === ws) active = null;
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);

  try {
    const containers = await findContainers();
    if (containers.length === 0) { send("[logstream] no matching containers found"); return ws.close(); }

    for (const { id } of containers) {
      const stream = await docker.getContainer(id).logs({
        follow: true, stdout: true, stderr: true, tail: 0, timestamps: false,
      });
      streams.push(stream);

      // Docker multiplexes stdout/stderr; demux, then split into lines.
      let buf = "";
      const onData = (chunk) => {
        buf += chunk.toString("utf8");
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim()) send(line);
        }
      };
      const out = new PassThrough().on("data", onData);
      const err = new PassThrough().on("data", onData);
      docker.modem.demuxStream(stream, out, err);
    }
  } catch (e) {
    send(`[logstream] error: ${e.message}`);
    ws.close();
  }
});

server.listen(PORT, () => console.log(`[logstream] listening on :${PORT} (path /logstream)`));
