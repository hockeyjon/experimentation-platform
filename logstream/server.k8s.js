// Log-stream service (Kubernetes edition) — streams the api + stats POD logs over a
// WebSocket by talking to the Kubernetes API with this pod's ServiceAccount.
//
// SAFETY POSTURE (unchanged from the Docker edition; there is deliberately NO user auth step):
//   1. REDACTION is the real protection — every line is scrubbed of DB IDs, event metadata
//      and emails before it leaves this process (generic demo user IDs stay visible on
//      purpose). The raw logs never cross the network.
//   2. GATING is automatic: the request Origin must match the app and a bundle token must be
//      present. Neither is a hard secret, so they only deter casual access.
//   3. LIMITS: one concurrent stream, a hard time cap, tailLines=0 (no history).
//   4. AUTHORITY is least-privilege: the pod's ServiceAccount is bound to a Role that can
//      only get/list/watch/delete pods and read pods/log in its OWN namespace (see
//      k8s/30-logstream.yaml). POST /logstream/reset deletes the api+stats pods — their
//      Deployments recreate them — so a stream can begin from a fresh boot with an empty log.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 8080);
const TOKEN = process.env.LOGSTREAM_TOKEN ?? "let-me-see-the-logs";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "https://experimentation.gunbarrelstudio.com";
const APPS = (process.env.LOG_SERVICES ?? "api,stats").split(",").map((s) => s.trim());
const MAX_SECONDS = Number(process.env.MAX_STREAM_SECONDS ?? 1200); // 20 minutes
const RESET_COOLDOWN = Number(process.env.RESET_COOLDOWN_SECONDS ?? 30);
const POLL_MS = Number(process.env.POD_POLL_MS ?? 1000); // how often to pick up new pods

// --- In-cluster Kubernetes API access (ServiceAccount token + cluster CA) ---
const SA = "/var/run/secrets/kubernetes.io/serviceaccount";
const CA = fs.readFileSync(`${SA}/ca.crt`);
const NAMESPACE = process.env.NAMESPACE ?? fs.readFileSync(`${SA}/namespace`, "utf8").trim();
const APISERVER = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT ?? 443}`;
const agent = new https.Agent({ ca: CA });
// Read the token fresh on each call — projected ServiceAccount tokens rotate.
const bearer = () => fs.readFileSync(`${SA}/token`, "utf8").trim();
const SELECTOR = `app in (${APPS.join(",")})`;

// One request to the API server. `stream:true` resolves the raw response (for log-follow);
// otherwise it buffers and JSON-parses the body.
function api(method, path, { stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${APISERVER}${path}`,
      { method, agent, headers: { Authorization: `Bearer ${bearer()}` } },
      (res) => {
        if (stream) return resolve(res);
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          if (res.statusCode >= 400) return reject(new Error(`${res.statusCode} ${body.slice(0, 300)}`));
          resolve(body ? JSON.parse(body) : {});
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const listPods = (selector) =>
  api(
    "GET",
    `/api/v1/namespaces/${NAMESPACE}/pods${selector ? `?labelSelector=${encodeURIComponent(selector)}` : ""}`,
  ).then((r) => r.items ?? []);

// --- Redaction: scrub DB IDs, event metadata, and emails before anything leaves the
// server. User IDs are intentionally NOT redacted — in this demo they're generic, non-PII
// handles (e.g. "alice", "user-42"), and keeping them visible is what makes the
// assign → cache → event flow legible. Experiment/variant names stay for the same reason. ---
function redact(line) {
  return line
    .replace(/"(?:id|_id|variantId|experimentId|assignmentId|insertedId)"\s*:\s*"[^"]*"/g, (m) =>
      m.replace(/"[^"]*"$/, '"‹id›"'),
    )
    .replace(/"metadata"\s*:\s*\{[^}]*\}/g, '"metadata":‹redacted›')
    .replace(/_id=\S+/g, "_id=‹id›")
    .replace(/\b[a-f0-9]{24}\b/g, "‹id›") // Mongo ObjectId
    .replace(/\bc[a-z0-9]{24}\b/g, "‹id›") // Prisma cuid
    .replace(/[\w.+-]+@[\w.-]+\.\w+/g, "‹email›");
}

// Follow one pod's logs. Unlike Docker's multiplexed stream, pod logs are plain text, so we
// just split on newlines. Returns the raw response so the caller can destroy it on cleanup.
function streamPodLog(pod, send) {
  const name = pod.metadata.name;
  const container = pod.spec.containers?.[0]?.name;
  const path =
    `/api/v1/namespaces/${NAMESPACE}/pods/${name}/log?follow=true&tailLines=0` +
    (container ? `&container=${container}` : "");
  return api("GET", path, { stream: true }).then((res) => {
    let buf = "";
    res.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) send(line);
      }
    });
    return res;
  });
}

// --- HTTP endpoints (health view + reset), same JSON contract the browser expects ---

// Map a pod to the same row shape the old `docker ps` view returned.
function podToRow(pod) {
  const cs = pod.status?.containerStatuses ?? [];
  const ready = cs.filter((c) => c.ready).length;
  const total = pod.spec.containers?.length ?? cs.length;
  const restarts = cs.reduce((n, c) => n + (c.restartCount ?? 0), 0);
  const ports = (pod.spec.containers ?? [])
    .flatMap((c) => c.ports ?? [])
    .map((p) => `${p.containerPort}/${(p.protocol ?? "TCP").toLowerCase()}`);
  return {
    name: pod.metadata.name,
    image: pod.spec.containers?.[0]?.image ?? "",
    state: pod.status?.phase ?? "Unknown",
    status:
      `${pod.status?.phase ?? "Unknown"} · ${ready}/${total} ready` + (restarts ? ` · ${restarts} restarts` : ""),
    service: pod.metadata.labels?.app ?? null,
    ports: [...new Set(ports)].sort().join(", "),
  };
}

// GET /logstream/containers — everything running in the namespace, i.e. `make list-backend`.
async function listAllContainers() {
  const pods = await listPods(); // no selector → the whole namespace
  return pods.map(podToRow).sort((a, b) => a.name.localeCompare(b.name));
}

// Recreate the app pods — the browser-side equivalent of `make logs-reset`. Deleting a pod
// leaves its Deployment to spin up a fresh one (new name, empty log). Returns the distinct
// app labels that were restarted.
async function recreateServices() {
  const pods = await listPods(SELECTOR);
  await Promise.all(
    pods.map((p) => api("DELETE", `/api/v1/namespaces/${NAMESPACE}/pods/${p.metadata.name}`)),
  );
  return [...new Set(pods.map((p) => p.metadata.labels?.app).filter(Boolean))];
}

let lastReset = 0;

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

async function handleContainers(req, res, url) {
  const json = gate(req, res, url, "GET");
  if (!json) return;
  try {
    const containers = await listAllContainers();
    return res.writeHead(200, json).end(JSON.stringify({ containers }));
  } catch (e) {
    console.error(`[logstream] pod list failed: ${e.message}`);
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

  const send = (line) => {
    if (ws.readyState === ws.OPEN) ws.send(redact(line));
  };
  send(`[logstream] connected — streaming ${APPS.join(", ")} for ${MAX_SECONDS}s (redacted)`);

  const attached = new Map(); // podName → response stream (null while attaching)
  const timer = setTimeout(() => {
    send("[logstream] time limit reached — disconnecting");
    ws.close(1000, "time-limit");
  }, MAX_SECONDS * 1000);

  // Attach to any Running app pod we're not already following. Polling (rather than a Watch)
  // keeps this simple and picks up pods that appear after a /reset — the Deployments recreate
  // them under new names, so the next tick attaches the fresh pod.
  async function sync() {
    let pods;
    try {
      pods = await listPods(SELECTOR);
    } catch (e) {
      send(`[logstream] pod list failed: ${e.message}`);
      return;
    }
    for (const pod of pods) {
      const name = pod.metadata.name;
      if (attached.has(name)) continue;
      if (pod.status?.phase !== "Running" || pod.metadata.deletionTimestamp) continue;
      attached.set(name, null); // reserve the slot so we don't double-attach mid-await
      try {
        const res = await streamPodLog(pod, send);
        attached.set(name, res);
        res.on("end", () => attached.delete(name));
        res.on("error", () => attached.delete(name));
      } catch (e) {
        attached.delete(name);
        send(`[logstream] could not attach to ${name}: ${e.message}`);
      }
    }
  }

  const poll = setInterval(sync, POLL_MS);
  const cleanup = () => {
    clearTimeout(timer);
    clearInterval(poll);
    for (const res of attached.values()) {
      try {
        res?.destroy();
      } catch {
        /* ignore */
      }
    }
    attached.clear();
    if (active === ws) active = null;
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);

  await sync();
  if (attached.size === 0) send("[logstream] no api/stats pods are running yet — waiting…");
});

server.listen(PORT, () =>
  console.log(`[logstream] listening on :${PORT} (path /logstream) — namespace ${NAMESPACE}`),
);
