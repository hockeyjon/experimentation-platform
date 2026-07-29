"""
Statistics microservice (Python + FastAPI).

Responsibility boundary: the Node.js GraphQL API owns experiments, assignments, and
event ingestion. This service owns *analysis* — it reads the same MongoDB event log and
answers "is this variant's lift statistically significant?" using a two-proportion z-test.

Why Python, why separate: statistics is Python's home turf, and giving analysis its own
service is a clean microservice boundary — it can scale and deploy independently and only
needs read access to the event log.

Run:
    python3 -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt
    uvicorn main:app --reload        # docs at http://localhost:8000/docs
"""
import json
import logging
import math
import os

from fastapi import FastAPI
from pymongo import MongoClient

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://127.0.0.1:27017")
MONGO_DB = os.environ.get("MONGO_DB", "experiments_events")

# INFO logging so the container output shows the flow (view with `make logs`).
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [stats] %(message)s")
log = logging.getLogger("stats")


class _HideSignificanceAccessLog(logging.Filter):
    """
    Drop uvicorn's per-request access line for /significance.

    The API holds an SSE stream open and re-polls this endpoint every few seconds for as
    long as a browser tab is watching, so the access line would otherwise dominate the log
    the Backend tab shows. Requests to any other path are still logged.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        return "/significance" not in record.getMessage()


logging.getLogger("uvicorn.access").addFilter(_HideSignificanceAccessLog())

app = FastAPI(title="Experiment Stats Service")
events = MongoClient(MONGO_URL)[MONGO_DB]["events"]
log.info("stats service ready — reading events from %s/%s", MONGO_URL, MONGO_DB)


def normal_cdf(x: float) -> float:
    """Standard normal CDF via the error function (no scipy dependency)."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def two_proportion_z_test(conv_a: int, n_a: int, conv_b: int, n_b: int):
    """Return (z, two-sided p-value) for H0: rate_a == rate_b."""
    if n_a == 0 or n_b == 0:
        return 0.0, 1.0
    p_a, p_b = conv_a / n_a, conv_b / n_b
    p_pool = (conv_a + conv_b) / (n_a + n_b)
    se = math.sqrt(p_pool * (1 - p_pool) * (1 / n_a + 1 / n_b))
    if se == 0:
        return 0.0, 1.0
    z = (p_b - p_a) / se
    p_value = 2 * (1 - normal_cdf(abs(z)))
    return z, p_value


def variant_counts(experiment_key: str):
    """Aggregate exposures + conversions per variant from the Mongo event log."""
    rows = events.aggregate([
        {"$match": {"experimentKey": experiment_key}},
        {"$group": {"_id": {"v": "$variantKey", "t": "$type"}, "n": {"$sum": 1}}},
    ])
    counts: dict[str, dict[str, int]] = {}
    for r in rows:
        v = r["_id"]["v"]
        counts.setdefault(v, {"exposures": 0, "conversions": 0})
        if r["_id"]["t"] == "exposure":
            counts[v]["exposures"] = r["n"]
        elif r["_id"]["t"] == "conversion":
            counts[v]["conversions"] = r["n"]
    return counts


# Last payload emitted per experiment, so the block below is logged only when the numbers
# actually move. The API polls on a timer for as long as a browser is watching; logging
# every pass would bury the request flow the Backend tab is meant to show.
_last_logged: dict[str, str] = {}


def log_if_changed(experiment_key: str, payload: dict, lines: list[str]) -> None:
    """Emit the buffered log lines only if this result differs from the last one."""
    signature = json.dumps(payload, sort_keys=True)
    if _last_logged.get(experiment_key) == signature:
        return
    _last_logged[experiment_key] = signature
    for line in lines:
        log.info(line)


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/significance/{experiment_key}")
def significance(experiment_key: str, control: str | None = None):
    """
    Compare each variant against the control and report lift + statistical significance
    at alpha = 0.05.

    The control is passed in by the caller, because this service only reads the Mongo
    event log — which variant is *flagged* as the control lives in Postgres, and is owned
    by the GraphQL API. Without it we fall back to the highest-exposure variant, which is
    a guess: fine for poking at the endpoint by hand, wrong for anything user-facing.
    """
    # Buffered, then emitted by log_if_changed() only when the result actually moved.
    lines = [f"computing significance for '{experiment_key}'"]

    counts = variant_counts(experiment_key)
    if not counts:
        payload = {"experimentKey": experiment_key, "variants": [], "note": "no events"}
        log_if_changed(experiment_key, payload, [f"no events for '{experiment_key}' — nothing to compute"])
        return payload
    lines.append(f"aggregated {len(counts)} variant(s) for '{experiment_key}'")

    if control and control in counts:
        control_key = control
        lines.append(f"baseline (control) = '{control_key}' (supplied by caller)")
    else:
        if control:
            lines.append(f"supplied control '{control}' has no events — falling back")
        control_key = max(counts, key=lambda k: counts[k]["exposures"])
        lines.append(f"baseline (control) = '{control_key}' (inferred: most exposures)")
    c = counts[control_key]
    control_rate = c["conversions"] / c["exposures"] if c["exposures"] else 0.0

    results = []
    for key, v in counts.items():
        rate = v["conversions"] / v["exposures"] if v["exposures"] else 0.0
        if key == control_key:
            results.append({
                "variantKey": key, "isControl": True,
                "exposures": v["exposures"], "conversions": v["conversions"],
                "conversionRate": round(rate, 4), "liftPct": 0.0,
                "pValue": None, "significant": False,
            })
            continue
        z, p = two_proportion_z_test(c["conversions"], c["exposures"], v["conversions"], v["exposures"])
        lift = (rate - control_rate) / control_rate if control_rate else 0.0
        lines.append(
            f"  {key} vs {control_key}: lift={lift * 100:.1f}% p={p:.4f} significant={p < 0.05}"
        )
        results.append({
            "variantKey": key, "isControl": False,
            "exposures": v["exposures"], "conversions": v["conversions"],
            "conversionRate": round(rate, 4),
            "liftPct": round(lift * 100, 2),
            "zScore": round(z, 3),
            "pValue": round(p, 4),
            "significant": p < 0.05,
        })

    # Deterministic order: control first, then alphabetical. Mongo's $group returns buckets
    # in whatever order it likes, and an unstable list makes two identical results serialize
    # differently — which would defeat both the log gate here and the API's "only push on
    # change" check, and would reorder the table rows under the reader.
    results.sort(key=lambda r: (not r["isControl"], r["variantKey"]))

    lines.append(f"significance done for '{experiment_key}' ({len(results)} variant(s))")

    payload = {"experimentKey": experiment_key, "controlVariant": control_key, "variants": results}
    log_if_changed(experiment_key, payload, lines)
    return payload
