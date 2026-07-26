// Minimal GraphQL client. GraphQL is "just" HTTP POST with a { query, variables }
// body to a single endpoint — no need for a heavy client library to see how it works.
const ENDPOINT = process.env.NEXT_PUBLIC_GRAPHQL_URL ?? "http://localhost:4000/";

export async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0]?.message ?? "GraphQL error");
  return json.data as T;
}
