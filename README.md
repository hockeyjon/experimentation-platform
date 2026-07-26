# Experimentation Platform

A working, full-stack A/B experimentation platform, a compact "mini LaunchDarkly/Optimizely"
that runs locally and deploys to AWS. It's small on purpose (one clean vertical slice), but
every technology has a real reason to be here.

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
