// Minimal GraphQL client. GraphQL is "just" HTTP POST with a { query, variables }
// body to a single endpoint — no need for a heavy client library to see how it works.
//
// It also logs every operation to the browser console so you can watch the frontend
// flow: `[gql] → op` (request) and `[gql] ← op` (response) with timing, or `✗` on error.
const ENDPOINT = process.env.NEXT_PUBLIC_GRAPHQL_URL ?? "http://localhost:4000/";

// Pull the first top-level field name out of the query for a readable label,
// e.g. "assignUser" or "experiments". Falls back to a generic label.
function opLabel(query: string): string {
  const m = query.match(/\b(?:query|mutation)\b[^{]*\{\s*([A-Za-z_][A-Za-z0-9_]*)/);
  return m?.[1] ?? "graphql";
}

export async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const op = opLabel(query);
  const t0 = performance.now();
  console.log(`%c[gql] → ${op}`, "color:#4f8cff;font-weight:bold", variables ?? {});

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    console.error(`%c[gql] ✗ ${op} — network error`, "color:#ff6b6b;font-weight:bold", err);
    throw err;
  }

  const json = await res.json();
  const ms = Math.round(performance.now() - t0);

  if (json.errors) {
    console.error(`%c[gql] ✗ ${op} (${ms}ms)`, "color:#ff6b6b;font-weight:bold", json.errors);
    throw new Error(json.errors[0]?.message ?? "GraphQL error");
  }

  console.log(`%c[gql] ← ${op} (${ms}ms)`, "color:#35c98b;font-weight:bold", json.data);
  return json.data as T;
}
