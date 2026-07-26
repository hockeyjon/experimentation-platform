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
import math
import os

from fastapi import FastAPI
from pymongo import MongoClient

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://127.0.0.1:27017")
MONGO_DB = os.environ.get("MONGO_DB", "experiments_events")

app = FastAPI(title="Experiment Stats Service")
events = MongoClient(MONGO_URL)[MONGO_DB]["events"]


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


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/significance/{experiment_key}")
def significance(experiment_key: str):
    """
    Compare each variant against the control (the variant with the most exposures) and
    report lift + statistical significance at alpha = 0.05.
    """
    counts = variant_counts(experiment_key)
    if not counts:
        return {"experimentKey": experiment_key, "variants": [], "note": "no events"}

    # Treat the highest-exposure variant as the control baseline.
    control_key = max(counts, key=lambda k: counts[k]["exposures"])
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
        results.append({
            "variantKey": key, "isControl": False,
            "exposures": v["exposures"], "conversions": v["conversions"],
            "conversionRate": round(rate, 4),
            "liftPct": round(lift * 100, 2),
            "zScore": round(z, 3),
            "pValue": round(p, 4),
            "significant": p < 0.05,
        })

    return {"experimentKey": experiment_key, "controlVariant": control_key, "variants": results}
