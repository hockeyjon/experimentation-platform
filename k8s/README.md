# k3s deployment (Phase 1)

This directory runs the **same backend stack** as `deploy/docker-compose.prod.yml`, but on
**k3s** (lightweight Kubernetes) instead of Docker Compose — the self-hosted stand-in for the
team's EKS. Phase 1 is a straight lift onto Kubernetes in **one namespace** (`experimentation`);
per-visitor namespace isolation is a later phase.

Nothing here runs as part of `make deploy`. The compose stack stays the live system until you
deliberately cut over, and `make backend` is always the instant rollback.

## What's here

| File | Contents |
|---|---|
| `00-namespace-config.yaml` | Namespace, ConfigMap (non-secret env), Secret (DB creds) |
| `10-databases.yaml` | Postgres, Mongo, Redis — Deployment + Service + PVC each (local-path, persistent) |
| `20-api-stats.yaml` | GraphQL API + Python stats — Deployment + Service, with initContainers that wait for the datastores |
| `30-logstream.yaml` | logstream Deployment + a least-privilege ServiceAccount/Role/RoleBinding |
| `40-caddy.yaml` | Caddy edge (TLS, hostPort 80/443) + Caddyfile ConfigMap + certs PVC |

## Key differences from compose

- **Images**: compose builds; k8s can't. The Makefile builds the `api`/`stats`/`logstream`
  images on the box and imports them into k3s's containerd, so `imagePullPolicy: IfNotPresent`
  (there is no registry).
- **logstream**: reads **pod logs via the Kubernetes API** (there is no Docker socket under
  k3s). It authenticates as its own ServiceAccount, whose Role can only get/list/watch/delete
  pods and read `pods/log` in this namespace. `/logstream/reset` deletes the api+stats pods and
  their Deployments recreate them — same "fresh boot" behavior as before. The Kubernetes edition
  lives in `logstream/server.k8s.js`, selected by the manifest's `command`; the compose stack
  keeps running the Docker `server.js` (via the image's default CMD), so `make backend` rollback
  is unaffected.
- **Caddy stays the edge**: k3s is installed with `--disable traefik` so Caddy owns 80/443 via
  hostPort. It still auto-obtains the Let's Encrypt cert (persisted on a PVC) and proxies to the
  `api` / `logstream` Services by name.
- **`depends_on`** → initContainers that block on `nc -z` until Postgres/Mongo/Redis are up.
- **DB volumes** → PVCs on the built-in local-path provisioner; DB Deployments use
  `strategy: Recreate` (ReadWriteOnce volumes can't be mounted by two pods during a rollout).

## First cutover

```bash
make k3s-install        # one time — installs k3s, Traefik disabled
make k8s-deploy         # sync code -> build+import images -> apply manifests
make k8s-status         # watch pods come up
```

The frontend (S3/CloudFront) is unchanged — it still calls `api.gunbarrelstudio.com`, which now
resolves to the k3s Caddy instead of the compose Caddy.

## Rollback

```bash
make backend            # brings the compose stack back up; it reclaims 80/443
```

(If both are ever up at once they'll fight over 80/443 — run one edge at a time.)

## Seed after a fresh cutover

```bash
make ssh
sudo k3s kubectl -n experimentation exec deploy/api -- npm run seed
```
