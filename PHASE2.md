# Phase 2 — per-session isolation (work in progress)

Goal: each visitor gets their **own isolated stack** in its own Kubernetes namespace — the
textbook multi-tenant pattern EKS is built for, running here on k3s. This doc tracks what's
built, the decisions taken, how to deploy it when ready, and **what's left**.

**Not live in production.** None of this is applied to the prod cluster or served to production —
Phase 1 is untouched. (`kubectl apply -f k8s/` is non-recursive, so `k8s/phase2/` never hits prod.)

## Status — deployed + proven on the DEV box (2026-07-30)

The provisioner + per-session model is **deployed and working on the dev environment**
(`api-dev.gunbarrelstudio.com`, EC2 `i-06428a5ce78518cea`, EIP `3.132.245.212`). Verified live:

- ✅ Provisioner deployed (image built + imported, `session-stack` ConfigMap, `tier=control-plane`
  label, RBAC applied). RBAC is sufficient (creates namespaces + full stacks + `exec` seed).
- ✅ `POST /sessions` → a fresh `session-<id>` namespace spins up its **own** postgres/mongo/redis/
  api/stats/logstream, gets seeded, reports `ready`, and its GraphQL returns its **own** data.
- ✅ Capacity cap enforced: 2 sessions succeed, the **3rd → HTTP 429 "at capacity"**.
- ✅ Reaper cleans up (failed provisions + idle).
- ✅ **RAM fits**: 1 session + shared stack + control plane = 1.4 GiB used / 2.0 GiB free on the
  t3.medium, so 2 concurrent sessions fit (each ~300 MB actual, well under the quota ceiling).

**Three real bugs found + fixed on dev** (in `k8s/phase2/session-stack.yaml` and `provisioner/`):
1. **ResourceQuota too tight** — 6×256Mi limits (1536Mi) exceeded the 1400Mi ceiling, so the api
   couldn't schedule. Raised to `limits.memory: 2560Mi`.
2. **Mongo never Ready** — the `mongosh` exec readiness probe can't start within the 1s timeout
   under the memory limit (mongosh is a heavy Node app), so the api init hung forever. Switched to
   a **TCP readiness probe** + explicit mongo/api memory limits.
3. **Failed provisions weren't reaped** — they held a capacity slot forever. The reaper now also
   reaps `failed` sessions.

**Caddy routing proven on dev (2026-07-30).** `deploy/Caddyfile.phase2` was deployed to the dev
edge and validated end to end against a live session:
- ✅ `/provision*` → provisioner (capacity check returns `{active,max,available}`).
- ✅ `/s/<id>/` → that session's api — GraphQL at `/` returns the session's **own** seeded data.
- ✅ `/s/<id>/logstream` → that session's logstream — real **WebSocket upgrade survives** the
  prefix rewrite (`101 Switching Protocols` + valid `Sec-WebSocket-Accept`).
- ✅ Bare `/logstream` + `/` → the shared Phase-1 stack (fallback intact; matcher ordering correct).
- **Bug found + fixed:** reverse_proxy placeholders aren't allowed on an upstream with a scheme —
  dropped the `http://` so the dynamic upstreams are bare `host:port`.

**Still ahead:** the frontend session-start flow is the one big remaining piece before a cutover.

## Decisions taken (my recommended defaults, since the forks were left open)

- **Routing: path-based** — `api.gunbarrelstudio.com/s/<id>/…`. No GoDaddy DNS or wildcard-cert
  work; reuses the existing cert. The shared Caddy strips the `/s/<id>` prefix.
- **Isolation: full stack per session** — each session gets its own Postgres, Mongo, Redis, api,
  stats, logstream in `session-<id>`. True physical isolation. **Ephemeral** storage (emptyDir):
  a session dies, its data goes with it — no PVCs to provision or clean up.
- **Session start: explicit + async** — a visitor's browser asks the provisioner to create a
  session, polls until ready (~30–60s spin-up), then points the app at `/s/<id>`.
- **Capacity: 2 concurrent sessions** (t3.medium), 15-min idle TTL, 1-h hard lifetime cap.

## What's built (review-ready, not deployed)

| Path | What it is |
|---|---|
| `k8s/phase2/session-stack.yaml` | The per-session stack: DBs (emptyDir) + api + stats + logstream, **plus** a ResourceQuota, LimitRange, and a default-deny NetworkPolicy. No `namespace:` fields — the provisioner applies it with `-n session-<id>`. No Caddy (the shared edge routes in). |
| `provisioner/` | Node service that creates/reaps sessions via `kubectl`. Namespaces are the source of truth (labelled + annotated), so it's restart-safe. HTTP API: `POST /sessions`, `GET /sessions/:id`, `GET /sessions/capacity`, `POST /sessions/:id/heartbeat`, `DELETE /sessions/:id`. Background reaper enforces idle TTL + lifetime cap + the concurrency cap (429 at capacity). |
| `k8s/phase2/provisioner.yaml` | Provisioner Deployment + Service + a cluster-scoped ServiceAccount/ClusterRole/ClusterRoleBinding (create/tear-down namespaces and everything in them; exec to seed). |
| `deploy/Caddyfile.phase2` | Path-based routing (**proven on dev**): `/s/<id>/…` → the session's api/logstream by in-cluster DNS, `/provision*` → the provisioner, bare `/` → shared fallback. Dynamic-upstream + prefix-strip + WS upgrade all validated against a live session. |

## How the pieces fit

```
Browser ──> Caddy (shared edge, experimentation ns)
              ├── /provision*        ─> provisioner  ─(kubectl)─> creates session-<id> ns + stack
              ├── /s/<id>/logstream* ─> logstream.session-<id>.svc
              └── /s/<id>/…          ─> api.session-<id>.svc  ─> its own postgres/mongo/redis/stats
```

## Deploy sequence (for when Phase 2 is ready — do NOT run yet)

```bash
# 1. Build + import the provisioner image (add a Makefile target — see checklist)
#    docker build -t experimentation-provisioner:latest provisioner/ && docker save … | k3s ctr images import -
# 2. Make the session stack available to the provisioner as a ConfigMap:
#    kubectl -n experimentation create configmap session-stack --from-file=session-stack.yaml=k8s/phase2/session-stack.yaml
# 3. Label the control-plane namespace so session NetworkPolicies allow the Caddy edge in:
#    kubectl label ns experimentation tier=control-plane
# 4. Apply the provisioner + RBAC:
#    kubectl apply -f k8s/phase2/provisioner.yaml
# 5. Swap in the Phase 2 Caddyfile (deploy/Caddyfile.phase2) and reload Caddy.
# 6. Ship the Phase 2 frontend (session-start flow).
```

---

# ✅ Checklist — what's left

### Frontend (the biggest remaining piece — deliberately untouched to protect production)
- [ ] **Session-start flow**: a "Create my environment" action → `POST /provision/sessions` →
      show a "provisioning your isolated stack…" screen → poll `GET /provision/sessions/:id`
      until `ready`.
- [ ] **Address the backend per-session**: today `API_BASE` is hardcoded to `api.gunbarrelstudio.com`.
      Make it `…/s/<id>` for the active session (GraphQL + logstream WS both).
- [ ] **Heartbeat** the session (`POST /provision/sessions/:id/heartbeat`) while the tab is open;
      **release/DELETE** on unload. (Reuse the pattern already written for the single-session claim.)
- [ ] **At-capacity UX**: handle the provisioner's `429` → show the "at capacity / Phase 2" modal
      (the `EntryModal` busy state already exists — point it at the capacity check).
- [ ] Decide the fate of the current single-session **claim** logic — the provisioner's capacity
      model supersedes it; likely remove the `/logstream/claim` path once sessions land.

### Routing (Caddy) — ✅ proven on dev (2026-07-30)
- [x] Test `deploy/Caddyfile.phase2` on the cluster: dynamic placeholder upstreams resolve DNS
      per-request; `/s/<id>` prefix strip leaves api at `/` and logstream at `/logstream`; the
      WebSocket upgrade survives the rewrite; matcher ordering (logstream before the catch-all).
      All verified against a live session. Fixed the scheme-on-placeholder-upstream error.
- [ ] Decide whether to keep the shared Phase-1 stack as a fallback or make a session mandatory.
      (Leaning: keep it during transition, then make a session mandatory once the frontend flow ships.)

### Build / deploy wiring
- [ ] Makefile targets: `provisioner-image` (build + import), `phase2-configmap` (session-stack
      ConfigMap from the file), `phase2-apply`, and a Caddyfile swap.
- [ ] The session stack references `experimentation-api/stats/logstream:latest` — already imported
      by Phase 1's `k8s-images`, so no new image work for those.

### Cluster correctness
- [ ] Confirm k3s **enforces NetworkPolicy** (it ships a policy controller) and that the
      `tier=control-plane` label lets Caddy reach sessions while sessions can't reach each other.
- [ ] **Capacity math on t3.medium**: 2 sessions (~550MB each) + k3s + control plane vs 4GB. Tune
      the ResourceQuota/LimitRange. If too tight, fall back to the **hybrid** model (shared DBs,
      per-session app tier) — more sessions per box, logical (not physical) data isolation.
- [ ] Verify the provisioner's RBAC is sufficient (namespace + workload create, `pods/exec` for
      seed, `roles`/`rolebindings` create with `bind`/`escalate` for the session logstream Role).

### Provisioner hardening / edge cases
- [ ] Guard against `newId()` namespace collisions (retry on create conflict).
- [ ] Clean up **failed** provisions (namespace left in `failed` — reap them too).
- [ ] Confirm restart-safety end to end (provisioner restarts → rediscovers sessions from
      namespace labels; heartbeats keep flowing).
- [ ] Provisioning latency UX: the 30–60s spin-up. Optional: a small **pre-warmed pool** of ready
      sessions so a visitor lands instantly.

### End-to-end test (only possible once applied)
- [ ] One session: create → provision → seed → drive the app → tear down.
- [ ] Two sessions isolated (data doesn't bleed); third request → 429 at capacity.
- [ ] Idle a session past the TTL → reaper deletes it → a slot frees.
