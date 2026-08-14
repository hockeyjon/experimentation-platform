# Phase 3 — LLM advisor over the experiment data (AWS-native, Bedrock)

Goal: give the visitor an assistant, in the empty space beneath the experiments in the left pane,
that answers questions about **the selected experiment's variants, buckets, and stats table**, and
gives a grounded recommendation on **whether it's a good idea to Launch to production** — reasoning
only over the numbers the app already computes, never inventing significance.

New to the stack: **LangChain · LangGraph · Amazon Bedrock · Vercel AI SDK**.

**Not started.** This doc is the working spec; build from it. Phase 2 (per-session Kubernetes
isolation) is live in prod and untouched by this.

---

## Decisions taken (defaults — confirm/adjust before building)

| Decision | Default | Why |
|---|---|---|
| Where the model runs | **Amazon Bedrock** (Claude, us-east-2) | In-AWS, **IAM auth (no external key)**, data stays in region, one AWS bill. Strong AWS-shop story. |
| Auth | **EC2 instance role via IMDS** | boto3 default cred chain picks it up in-pod; nothing to store/rotate/leak. |
| Agent placement | **Shared, stateless pod** in the control-plane (`experimentation`) ns | The frontend already holds the data; it sends it in the request body. No per-session pod, no cross-namespace access, ~250 MB total. |
| Agent language | **Python** — FastAPI + LangGraph + `langchain-aws` | Matches the LangChain/LangGraph showcase and the exposure-triage-assistant reference. |
| Model | **Claude Haiku** | Cheap + fast; plenty for Q&A over a small stats table. Bump to Sonnet if the "launch" reasoning needs more depth. |
| Frontend transport | **Vercel AI SDK `useChat`, text-stream protocol** | Static export has no Node route; the client hook points at our backend and consumes a plain text token stream. |
| Cost backstop | **Global `DAILY_LLM_CALL_LIMIT`, in-memory** in the single shared pod (reset by wall-clock day) | No new persistence. Per-session Postgres is ephemeral/wrong-scope; the shared Postgres is scaled to 0. The agent pod is stable on k3s, so a rare-restart reset is fine for a *backstop*. Add a SQLite file later only if restart-durability is ever needed. |
| Launch-verdict mode | **Phase 3.1 (ship streamed Q&A first)** | The draft→critique verdict graph is a great showcase but adds scope; land the chat first. |

---

## Architecture

```
Static frontend (left-pane chat, Vercel AI SDK useChat)
      │  POST /agent/chat   { question, context: { variants, buckets, stats, status } }
      ▼
Caddy edge (api.gunbarrelstudio.com)
      │  /agent*  ── strip_prefix ──►  agent.experimentation.svc:8000   (SHARED, control-plane ns)
      ▼
Agent pod: FastAPI + LangGraph
      │  ChatBedrockConverse (langchain-aws) — creds via the EC2 instance role (IMDS)
      ▼
Amazon Bedrock (us-east-2) ──►  Claude          [stays in AWS · IAM auth · no key]
```

**Why shared + stateless:** the left-pane table already has everything the LLM needs — variants,
per-bucket exposures/conversions, rates/lift/p-value/significance, current status. The frontend
sends that as `context` in the body, so the agent never reaches into a session's namespace. One
pod for the whole box, and the model reasons over *exactly what's on screen* — which is also the
honesty guarantee.

---

## Components to build

| Path | What it is |
|---|---|
| `agent/` | FastAPI app: `POST /agent/chat` (streamed Q&A), `POST /agent/launch-verdict` (3.1), `GET /agent/healthz`. LangGraph graph + `ChatBedrockConverse`. Dockerfile (python:3.12-slim). Global daily-limit counter in SQLite. |
| `k8s/phase2/agent.yaml` | Deployment + Service (:8000). Control-plane ns. Modest resource limits (~384 Mi). No PVC — the limit counter is in-memory. |
| `deploy/Caddyfile.phase2` | Add a `/agent*` route (strip prefix, `flush_interval -1` for streaming). |
| `web/` | Left-pane chat panel using `@ai-sdk/react` `useChat`; builds `context` from Redux; a "Should I launch?" button (3.1). |
| AWS (out of Terraform — hand-managed box) | IAM role + instance profile with `bedrock:InvokeModel*`; attach to the instance; IMDS hop-limit 2; enable model access in the Bedrock console. |

---

## LangGraph flow

Two modes off one graph:

- **Chat (streamed)** — `assemble_context → answer(LLM, streaming)`.
  System prompt enforces honesty: *significance is computed server-side by the Python stats
  service; never claim a result is significant when the p-value / sample size doesn't support it;
  explicitly call out small samples.* The node streams tokens straight to the client.

- **Launch-readiness verdict (Phase 3.1, button)** — `assemble_context → draft → critique → final`.
  Mirrors the exposure-triage draft→critique split: draft a verdict, critique it against the actual
  numbers, strip anything unsupported, return a whole answer with a confidence label. Not streamed
  (the critique needs the full draft).

`assemble_context` compiles the request payload into a compact, unambiguous summary (per-variant:
exposures, conversions, rate, lift vs control, p-value, significant?; plus sample sizes and current
DRAFT/RUNNING status) — the LLM never sees raw rows, only the same figures the table shows.

---

## Amazon Bedrock + IAM (the "no key" part)

```python
from langchain_aws import ChatBedrockConverse
llm = ChatBedrockConverse(
    model="<claude-haiku inference-profile id for us-east-2>",  # confirm in the Bedrock console
    region_name="us-east-2", temperature=0.2,
)  # boto3 default cred chain → the instance role via IMDS. No key anywhere.
```

IAM policy (scope `Resource` to the model / inference-profile ARNs for least privilege):
```json
{ "Effect": "Allow",
  "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
  "Resource": "*" }
```

Attach it **live, no restart** — and the gotcha that breaks pod→IMDS creds:
```bash
aws ec2 associate-iam-instance-profile --instance-id i-06428a5ce78518cea \
  --iam-instance-profile Name=experimentation-bedrock
# containers are ONE network hop from IMDS — without this, boto3 in the pod can't get creds:
aws ec2 modify-instance-metadata-options --instance-id i-06428a5ce78518cea \
  --http-put-response-hop-limit 2 --http-endpoint enabled
```

One-time: **enable Claude model access** in the Bedrock console, and **verify the model id /
inference profile** available in us-east-2 (newest Claude often needs a cross-region inference
profile; availability lags us-east-1/us-west-2).

---

## Caddy route (streaming)

```
handle /agent* {
    uri strip_prefix /agent
    reverse_proxy agent.experimentation.svc.cluster.local:8000 {
        flush_interval -1   # push tokens through immediately — no buffering
    }
}
```

---

## Frontend panel

```tsx
// left pane, beneath the experiments list
const { messages, input, handleInputChange, handleSubmit, status } = useChat({
  api: `${ORIGIN}/agent/chat`,
  streamProtocol: "text",                    // static export → plain text token stream
  body: { context: currentExperimentContext } // built from Redux: variants, buckets, stats, status
});
```
Backend streams LangGraph's tokens into a FastAPI `StreamingResponse`; `useChat` renders them live.
A separate **"Should I launch?"** button calls `/agent/launch-verdict` (3.1).

⚠️ Vercel AI SDK **v4 vs v5** differ on the streaming-config API (`streamProtocol` vs. a transport
like `DefaultChatTransport`). The concept holds; wire it per the installed version's docs.

---

## Cost backstop

Global `DAILY_LLM_CALL_LIMIT` (default e.g. 50), an **in-memory counter** in the single shared
agent pod, reset by wall-clock day. On exceed: graceful-degrade with a clear message rather than a
hard failure. No new persistence — the pod is stable on k3s, and this is a safety net, not a strict
quota; a rare-restart reset is acceptable. (If restart-durability is ever wanted, swap in a single
SQLite file — but not a Postgres: the per-session DBs are ephemeral and the shared one is off.)
Optional later: a "request a higher limit" path (the reference app emails via SES) — skip for now.

---

## Deploy sequence (when built)

```bash
# 1. IAM (one-time): create role+instance-profile w/ Bedrock invoke, attach, set IMDS hop-limit 2,
#    enable Claude model access in the Bedrock console.
# 2. Build + import the agent image:  docker build -t experimentation-agent:latest agent/ ; k3s ctr images import
# 3. kubectl apply -f k8s/phase2/agent.yaml     (control-plane ns)
# 4. Add the /agent* route to the Caddyfile and reload Caddy.
# 5. Ship the frontend chat panel (make frontend).
```

---

## ✅ Checklist

### Agent service
- [ ] `agent/` FastAPI: `/agent/chat` (streamed), `/agent/healthz`, `/agent/launch-verdict` (3.1)
- [ ] LangGraph: `assemble_context → answer` (+ `draft → critique → final` in 3.1)
- [ ] `ChatBedrockConverse` wired to the instance-role creds; streams tokens
- [ ] Global in-memory daily-limit counter (wall-clock reset); graceful degrade on exceed
- [ ] Dockerfile + Makefile targets (`agent-image`, apply)

### AWS / IAM
- [ ] IAM role + instance profile (`bedrock:InvokeModel*`), attached to `i-06428a5ce78518cea`
- [ ] IMDS hop-limit = 2
- [ ] Claude model access enabled; model/inference-profile id confirmed for us-east-2

### Routing + frontend
- [ ] `/agent*` Caddy route with `flush_interval -1`
- [ ] Left-pane chat panel (`useChat`, text protocol); `context` built from Redux
- [ ] "Should I launch?" button → verdict mode (3.1)
- [ ] Add deps: `ai`, `@ai-sdk/react`

### Polish / docs
- [ ] Stack pills + About page: add LangChain · LangGraph · Amazon Bedrock · Vercel AI SDK
- [ ] Phase 3 panel in the About overlay (the collaboration-story card)

---

## Gotchas (learned + anticipated)

- **IMDS hop limit** — the #1 reason "pod uses the instance role" fails silently. Set it to 2.
- **Region / inference profile** — us-east-2 may need a cross-region inference profile for the
  newest Claude. Confirm before wiring the model id.
- **Streaming through Caddy** — `flush_interval -1`, or tokens buffer and the UI feels non-live.
- **Static export ⇒ text protocol** — no Node route in the frontend, so the SDK's *server* helpers
  are out; use the client hook + a plain text token stream from FastAPI.
- **RAM on the t3.medium** — the shared agent adds ~250 MB; with the shared Phase-1 stack already
  scaled to 0 there's headroom (was ~1.7 GB free with 2 warm sessions), but watch `free -m`.
- **Honesty guardrail** — the stats service computes significance; the LLM must explain, never
  assert significance the numbers don't support. Bake it into the system prompt (and the 3.1
  critique node).

---

## Decisions locked (2026-08-01)
1. **Model** — **Claude Haiku** on Bedrock.
2. **Scope** — **streamed Q&A first**; draft→critique launch-verdict is Phase 3.1.
3. **Limit store** — **in-memory** global counter (no SQLite/PVC/Postgres); SQLite file only if
   restart-durability is later needed.
