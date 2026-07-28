# Experimentation Platform

A working, full-stack A/B experimentation platform, a compact "mini LaunchDarkly/Optimizely"
that runs locally and deploys to AWS. 

## See the full stack live — two windows, side by side

The app has two tabs: **Frontend** (the dashboard) and **Backend**, which streams the API's real
logs over a WebSocket. The best way to see the whole stack work is to watch a single request travel
through every layer in real time — so set it up as two browser windows next to each other:

1. **Left window — Frontend.** Open the app: **https://experimentation.gunbarrelstudio.com**. It
   loads on the **Frontend** tab. Leave it here.
2. **Right window — Backend.** Open the same URL in a second window, drag it to the right half of
   your screen, click the **Backend** tab, then **Stream backend logs** and confirm. You'll see
   `connected — streaming api, stats …`.
3. **Drive on the left, watch on the right.** Drive on the left, watch on the right. In the left (Frontend) window, assign a user to an experiment — or seed / clear a bucket — and the matching request appears in the backend log stream on the right. Then scroll down to the Control and Variant buckets, click "Record Success" on a few users, and watch the experiment's stats update live in the Variant table at the top of the panel.

The (Backend) window prints the same request flowing through the stack: GraphQL resolver → Postgres (sticky assignment) → Redis (cache hit/miss) → MongoDB (event log).

It's one deployed EC2 box serving both windows, so the logs are real, not simulated. Any confidential data in the logs is redacted server-side.

The stream auto-disconnects after 5
minutes and runs one at a time (bounded server load, no auth step required).

## The stack

| Technology | Role | Production analog |
|---|---|---|
| Next.js + React + **Redux** | Dashboard UI + client state | — |
| **Node.js GraphQL** API | Single typed API endpoint (Apollo Server, TypeScript) | — |
| **Prisma ORM** | Typed DB access + schema/migrations | — |
| **Postgres** (Docker) | Relational: experiments, variants, assignments | AWS Aurora |
| **MongoDB** (Docker) | Document store: high-volume event log | AWS DocumentDB |
| **Redis** (Docker) | Sticky-assignment cache | — |
| **TypeScript / JavaScript** | Throughout | — |
| **Python** (FastAPI) | Significance testing (microservice) | — |
| **Docker** on EC2 | Container runtime for the deployed stack | EKS at larger scale |

## Architecture

```
  Browser
    │  (React + Redux Toolkit)
    ▼
  Next.js dashboard  :3000
    │  GraphQL over HTTP
    ▼
  Node.js GraphQL API  :4000  (Apollo Server + Prisma)
    ├──────────────► Postgres :5433   experiments, variants, sticky assignments (source of truth)
    ├──────────────► MongoDB  :27017  exposure + conversion events (append-heavy)
    └──────────────► Redis    :6379   cached "user → variant" lookups
                          ▲
  Python stats service :8000 ─┘  reads the Mongo event log, returns z-test significance
```

## Run it

Prereqs: Docker Desktop, Node 20+, (optional) Python 3.11+.

```bash
# 1. Start the datastores (Postgres on 5433, Mongo 27017, Redis 6379)
docker compose up -d

# 2. API
cd api
cp ../.env.example .env         # already points at the ports above
npm install
npm run prisma:push             # create tables in Postgres
npm run seed                    # create the sample experiments (all DRAFT, no traffic)
npm run dev                     # GraphQL API at http://localhost:4000

# 3. Web (in a second terminal)
cd web
npm install
npm run dev                     # dashboard at http://localhost:3000

# 4. (optional) Python significance service
cd stats
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload       # http://localhost:8000/docs
```

> **Port note:** Postgres is published on host port **5433**, not the usual 5432, because
> many machines already run a native Postgres on 5432. If you don't, you can switch it back
> in `docker-compose.yml` and `api/.env`.

## What the app does

- **Create experiments** with weighted variants (control vs. variant).
- **Assign users** to variants deterministically, the same user always gets the same
  variant, and repeat lookups are served from Redis.
- **Log events** (exposures automatically, conversions on demand) into MongoDB.
- **See results**, per-variant conversion rates and lift, aggregated from the event log.

## Project layout

```
docker-compose.yml     # Postgres + Mongo + Redis
api/                   # Node.js + TypeScript GraphQL API
  prisma/schema.prisma # relational model (Postgres)
  prisma/seed.ts       # sample experiments (DRAFT, no traffic)
  src/db/              # prisma.ts, mongo.ts, redis.ts — one file per datastore
  src/lib/assignment.ts# deterministic weighted bucketing
  src/schema.ts        # GraphQL SDL
  src/resolvers/       # where the three datastores come together
web/                   # Next.js + React + Redux dashboard
  src/store/           # Redux Toolkit slice + typed hooks
  src/app/             # App Router pages
stats/                 # Python FastAPI significance service
```

## How I'd productionize this

The intro promised the incremental version, so here it is concretely: same product, delivered as
independently releasable slices instead of one drop, plus the hardening this prototype deliberately
skips.

**Ship it as thin vertical slices, each releasable on its own:**

1. **Assignment first.** The API + Postgres path that turns `(experiment, user)` into a variant,
   exposed as a small SDK/endpoint. Nothing logs events yet. Releasable value: a caller can bucket a
   user deterministically. Dark-launch it, compare against the incumbent, ramp 1% → 100%.
2. **Event ingestion, asynchronously.** Exposures and conversions, but *off* the request path
   (publish to Kafka/Kinesis, consume into Mongo) so a slow write never adds user-facing latency.
   The prototype logs inline today; that's the first thing I'd change.
3. **Results + significance.** The aggregation read path and the stats service, once there's real
   event volume worth reading.
4. **Dashboard.** The UI last, on top of an API that already works and is already trusted.

Each slice sits behind a feature flag and ramps on its own, so I'm integrating and de-risking
continuously instead of at the end. (Pleasantly recursive: an experimentation platform *is* a
flagging system, so I'd dogfood it and gate its own rollout with it.)

**What I'd harden before real traffic** — the honest gaps in this slice:

- **Bucketing** → consistent hashing salted per experiment, mutual-exclusion / holdback groups,
  targeting rules, and ramp schedules — not just static weights.
- **Stats** → the two-proportion z-test is a teaching stub. Production needs sequential /
  always-valid testing to kill the peeking problem, sample-ratio-mismatch detection, and
  multiple-comparison correction.
- **Data layer** → Postgres read replicas; a TTL + archival/partitioning strategy for the unbounded
  Mongo event log; Redis with failover and cache-stampede protection.
- **API** → authN/Z, rate limiting, query depth/complexity limits, and DataLoader to kill N+1s.
- **Ops** → CI/CD, secrets out of plaintext compose env (SSM / Secrets Manager), metrics + tracing +
  alerting, and more than a single EC2 box. The `logstream` service mounts the Docker socket — fine
  for an isolated demo, swapped for a real log pipeline in production.
