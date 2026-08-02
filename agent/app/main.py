# Phase 3 — the experiment advisor. A small FastAPI service that answers questions about ONE
# experiment (its variants, buckets, results table, launch status) by streaming a Claude answer
# from Amazon Bedrock. Shared + stateless: the browser sends the on-screen data as `context`, so
# this never reaches into a session's namespace.
#
# LangGraph pipeline: assemble_context -> answer(LLM). Bedrock via ChatBedrockConverse, auth by
# the EC2 instance role (IMDS) — no API key anywhere. Honesty is enforced in the system prompt:
# significance is computed server-side by the Python stats service; the model explains, it never
# invents a significant result.
import os
import datetime
from typing import TypedDict, Any

from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse, JSONResponse
from langchain_aws import ChatBedrockConverse
from langchain_core.messages import SystemMessage, HumanMessage, AIMessage
from langgraph.graph import StateGraph, START, END

REGION = os.environ.get("BEDROCK_REGION", "us-east-1")
MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "us.anthropic.claude-haiku-4-5-20251001-v1:0")
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "https://experimentation.gunbarrelstudio.com")
DAILY_LIMIT = int(os.environ.get("DAILY_LLM_CALL_LIMIT", "50"))
MAX_TOKENS = int(os.environ.get("MAX_OUTPUT_TOKENS", "600"))

llm = ChatBedrockConverse(
    model=MODEL_ID, region_name=REGION, temperature=0.2, max_tokens=MAX_TOKENS
)

SYSTEM = """You are a concise data analyst embedded in an A/B experimentation dashboard. You answer
questions about ONE experiment using ONLY the data provided below: its variants, the users bucketed
into each, the results, and its current status.

Ground rules — follow these strictly:
- Statistical significance is computed server-side by a Python stats service. NEVER claim a result
  is significant unless the data explicitly says so (significant=true, or a p-value < 0.05). On thin
  or non-significant data, say so plainly.
- When asked whether to launch to production, weigh: is there a clear, SIGNIFICANT winner, and are
  the sample sizes adequate? Recommend AGAINST launching on non-significant or small-sample data,
  and explain why in one or two sentences.
- Be brief and specific — use the actual numbers from the data. If the data can't answer the
  question, say that instead of guessing. Never invent variants, metrics, or numbers.
"""

# --- global in-memory daily cap (wall-clock UTC day; resets on pod restart — a backstop, not a gate)
_day: datetime.date | None = None
_count = 0


def _within_daily_limit() -> bool:
    global _day, _count
    today = datetime.datetime.utcnow().date()
    if today != _day:
        _day, _count = today, 0
    if _count >= DAILY_LIMIT:
        return False
    _count += 1
    return True


def _fmt_context(ctx: dict) -> str:
    lines = [
        f"Experiment: {ctx.get('name')} (key: {ctx.get('key')})",
        f"Status: {ctx.get('status')}",
        "Variants:",
    ]
    for v in ctx.get("variants", []):
        tag = "control" if v.get("isControl") else "treatment"
        lines.append(
            f"  - {v.get('name')} [{tag}]: exposures={v.get('exposures', 0)}, "
            f"conversions={v.get('conversions', 0)}, rate={v.get('rate')}, "
            f"lift_vs_control={v.get('lift')}, p_value={v.get('pValue')}, "
            f"significant={v.get('significant')}"
        )
    return "\n".join(lines)


def _text_of(content: Any) -> str:
    # ChatBedrockConverse chunks can be a str or a list of content blocks ({'type':'text',...}).
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(b.get("text", "") for b in content if isinstance(b, dict))
    return ""


class State(TypedDict):
    context: dict
    question: str
    history: list
    messages: list


def assemble(state: State) -> dict:
    msgs = [SystemMessage(content=SYSTEM + "\nEXPERIMENT DATA:\n" + _fmt_context(state["context"]))]
    for h in state.get("history", []):
        if h.get("role") == "user":
            msgs.append(HumanMessage(content=h.get("content", "")))
        elif h.get("role") == "assistant":
            msgs.append(AIMessage(content=h.get("content", "")))
    msgs.append(HumanMessage(content=state["question"]))
    return {"messages": msgs}


async def answer(state: State) -> dict:
    resp = await llm.ainvoke(state["messages"])
    return {"messages": state["messages"] + [resp]}


_builder = StateGraph(State)
_builder.add_node("assemble", assemble)
_builder.add_node("answer", answer)
_builder.add_edge(START, "assemble")
_builder.add_edge("assemble", "answer")
_builder.add_edge("answer", END)
graph = _builder.compile()

app = FastAPI()
CORS = {"Access-Control-Allow-Origin": ALLOWED_ORIGIN, "Vary": "Origin"}


@app.get("/agent/healthz")
def healthz():
    return {"ok": True, "model": MODEL_ID, "region": REGION, "callsToday": _count, "dailyLimit": DAILY_LIMIT}


@app.options("/agent/chat")
def chat_preflight():
    return Response(
        status_code=204,
        headers={**CORS, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type"},
    )


@app.post("/agent/chat")
async def chat(req: Request):
    origin = req.headers.get("origin")
    if origin and origin != ALLOWED_ORIGIN:
        return JSONResponse({"error": "origin"}, status_code=403, headers=CORS)

    body = await req.json()
    context = body.get("context") or {}
    # Vercel AI SDK useChat sends { messages: [{role, content|parts}, ...] }. Pull the latest user
    # turn as the question, everything before it as history.
    turns = []
    for m in body.get("messages", []):
        content = m.get("content")
        if content is None and isinstance(m.get("parts"), list):  # AI SDK v5 parts
            content = "".join(p.get("text", "") for p in m["parts"] if isinstance(p, dict))
        turns.append({"role": m.get("role"), "content": content or ""})
    question = turns[-1]["content"] if turns and turns[-1]["role"] == "user" else ""
    history = turns[:-1] if question else turns

    if not _within_daily_limit():
        async def limited():
            yield "The demo's daily AI-question limit has been reached — please try again tomorrow."
        return StreamingResponse(limited(), media_type="text/plain; charset=utf-8", headers=CORS)

    async def gen():
        state = {"context": context, "question": question, "history": history}
        try:
            async for chunk, meta in graph.astream(state, stream_mode="messages"):
                if meta.get("langgraph_node") == "answer":
                    text = _text_of(getattr(chunk, "content", ""))
                    if text:
                        yield text
        except Exception as e:  # never leave the stream hanging on a backend hiccup
            yield f"\n\n[the advisor hit an error: {type(e).__name__}]"

    return StreamingResponse(gen(), media_type="text/plain; charset=utf-8", headers=CORS)
