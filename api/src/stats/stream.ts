// Server-Sent Events relay for the Python stats service.
//
// The browser can't open a listening port, so it holds one long-lived GET here and we
// write to it. The stats service stays private: it has no Caddy route and no published
// port, and only this process ever calls it.
//
// Why poll it rather than react to writes: Mongo runs standalone (no replica set), so
// change streams aren't available. Polling happens here, one hop from the data, and the
// browser is only woken when the numbers actually change.
import type { Request, Response } from "express";
import { prisma } from "../db/prisma.js";
import { log } from "../logger.js";

const STATS_URL = process.env.STATS_URL ?? "http://stats:8000";
const POLL_MS = Number(process.env.STATS_POLL_MS ?? 3000);
const HEARTBEAT_MS = 20000;

export async function statsStreamHandler(req: Request, res: Response) {
  const experimentKey = req.params.experimentKey;

  // The stats service only sees the Mongo event log, so it cannot know which variant is
  // the control — that flag lives in Postgres. Pass it in explicitly, otherwise the
  // service falls back to "whichever variant has the most exposures" and reports lift
  // against a baseline the dashboard doesn't agree with.
  const experiment = await prisma.experiment.findUnique({
    where: { key: experimentKey },
    include: { variants: true },
  });
  if (!experiment) {
    res.status(404).json({ error: `Unknown experiment: ${experimentKey}` });
    return;
  }
  const control = experiment.variants.find((v) => v.isControl)?.key;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  log.info("stats", `▶ SSE open for ${experimentKey} (control=${control ?? "auto"})`);

  let lastPayload = "";
  let lastError = "";
  let closed = false;

  async function poll() {
    if (closed) return;
    const query = control ? `?control=${encodeURIComponent(control)}` : "";
    try {
      const r = await fetch(`${STATS_URL}/significance/${encodeURIComponent(experimentKey)}${query}`);
      if (!r.ok) throw new Error(`stats service returned ${r.status}`);
      const body = await r.json();

      const payload = JSON.stringify(body);
      if (payload === lastPayload) return; // unchanged — don't wake the browser
      lastPayload = payload;
      lastError = "";
      res.write(`data: ${payload}\n\n`);
      log.info("stats", `pushed ${experimentKey} → ${body.variants?.length ?? 0} variant(s)`);
    } catch (e) {
      // Report a given failure once, then stay quiet until it changes or recovers, so a
      // stats outage can't flood the log or the client.
      const message = (e as Error).message;
      if (message === lastError) return;
      lastError = message;
      log.error("stats", `poll failed for ${experimentKey}: ${message}`);
      res.write(`event: stats-error\ndata: ${JSON.stringify({ error: message })}\n\n`);
    }
  }

  const pollTimer = setInterval(poll, POLL_MS);
  // Comment frames keep the connection from being reaped while the numbers are static.
  const beatTimer = setInterval(() => !closed && res.write(": ping\n\n"), HEARTBEAT_MS);

  req.on("close", () => {
    closed = true;
    clearInterval(pollTimer);
    clearInterval(beatTimer);
    log.info("stats", `■ SSE closed for ${experimentKey}`);
  });

  await poll(); // first frame immediately, don't make the client wait a full interval
}
