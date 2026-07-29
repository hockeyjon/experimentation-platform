"use client";
// Subscribe to backend-derived variant stats.
//
// A browser can't listen on a port — it holds an outbound connection open and the server
// writes to it. EventSource is the smallest thing that does that: plain HTTP (so Caddy
// proxies it untouched), and it reconnects on its own if the connection drops, which the
// log-stream WebSocket does not.
//
// The stream is served by the GraphQL API at /stats/stream/:key, which relays the Python
// significance service. That keeps the API as the single public entry point — the stats
// service has no route of its own.
import { useEffect } from "react";
import { useAppDispatch } from "@/store";
import { significancePushed, statsStreamClosed, Significance } from "@/store/experimentsSlice";

const API_BASE = (process.env.NEXT_PUBLIC_GRAPHQL_URL ?? "http://localhost:4000/").replace(
  /\/+$/,
  "",
);

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 10000;

export function useStatsStream(experimentKey: string | null) {
  const dispatch = useAppDispatch();

  useEffect(() => {
    if (!experimentKey) return;

    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      es = new EventSource(`${API_BASE}/stats/stream/${encodeURIComponent(experimentKey)}`);

      es.onopen = () => {
        attempt = 0; // healthy again — reset the backoff
      };
      es.onmessage = (e) => {
        try {
          dispatch(significancePushed(JSON.parse(e.data) as Significance));
        } catch {
          /* a malformed frame shouldn't tear down the stream */
        }
      };
      // Reconnection is driven here rather than left to EventSource. Its built-in retry
      // gives up permanently if an attempt gets a non-200, and that is exactly what the
      // proxy returns while the api container restarts — so the Restart button would
      // otherwise kill the stats stream until a page reload.
      es.onerror = () => {
        es?.close();
        es = null;
        dispatch(statsStreamClosed());
        if (cancelled) return;
        const delay = Math.min(RETRY_BASE_MS * 2 ** attempt++, RETRY_MAX_MS);
        retry = setTimeout(connect, delay);
      };
    };

    connect();

    // Runs on unmount AND whenever experimentKey changes, so switching experiments in the
    // sidebar tears down the old stream (and any pending retry) before opening the new one.
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      es?.close();
      dispatch(statsStreamClosed());
    };
  }, [experimentKey, dispatch]);
}
