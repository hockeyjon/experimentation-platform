"use client";
// Shared helpers for the Backend tab: the log-stream reset + container-list fetches, and the ANSI
// colorizer that turns the api's [scope] tags into colored spans. Addresses come from lib/session
// at call time (httpBase()/TOKEN), so they resolve to this visitor's session in Phase 2.
import type { ReactNode } from "react";
import { httpBase, TOKEN } from "@/lib/session";

// A restart isn't done when the container starts — node still runs `prisma db push` and boots. This
// is the line the api logs when it is actually serving; it must stay in sync with the
// log.info("startup", …) call in api/src/index.ts.
export const API_READY = /GraphQL API ready/;
// Safety net only — the "GraphQL API ready" log line above is the real signal. Generous, because
// under load (other stacks booting, the pool warming a reserve) a restart's api recreation can take
// well over a minute; firing this early would fetch into a still-down api ("failed to fetch").
export const READY_TIMEOUT_S = 180;

// Ask the log-stream service to recreate api + stats before we attach — the `make logs-reset`
// equivalent. Always resolves to a line for the log view: a failed or throttled reset is worth
// showing, but it never blocks the stream (seeing the logs is the point).
export async function resetBackend(): Promise<string> {
  try {
    const res = await fetch(`${httpBase()}/logstream/reset?token=${encodeURIComponent(TOKEN)}`, {
      method: "POST",
    });
    if (res.ok) {
      const { recreated } = await res.json();
      return `[logstream] recreated ${recreated.join(", ")} — streaming from a fresh boot`;
    }
    if (res.status === 429) {
      const { retryInSeconds } = await res.json();
      return `[logstream] reset skipped — on cooldown for another ${retryInSeconds}s`;
    }
    return `[logstream] reset failed (${res.status}) — streaming anyway`;
  } catch {
    return "[logstream] reset request failed — streaming anyway";
  }
}

type ContainerRow = {
  name: string;
  image: string;
  state: string;
  status: string;
  service: string | null;
  ports: string;
};

// Ask the log-stream service what is running on the host — the browser-side equivalent of
// `make list-backend`. Returns lines for the panel, laid out like `docker ps` output.
export async function fetchContainers(): Promise<string[]> {
  const stamp = new Date().toTimeString().slice(0, 8);
  try {
    const res = await fetch(
      `${httpBase()}/logstream/containers?token=${encodeURIComponent(TOKEN)}`,
    );
    if (!res.ok) return [`${stamp} [health] request failed (${res.status})`];
    const { containers } = (await res.json()) as { containers: ContainerRow[] };
    if (!containers.length) return [`${stamp} [health] no running containers`];

    // Pad the first three columns so the output lines up the way `docker ps` does.
    const grid = [
      ["NAMES", "IMAGE", "STATUS", "PORTS"],
      ...containers.map((c) => [c.name, c.image, c.status, c.ports]),
    ];
    const widths = [0, 1, 2].map((i) => Math.max(...grid.map((row) => row[i].length)));
    const table = grid.map((row) =>
      row.map((cell, i) => (i < 3 ? cell.padEnd(widths[i]) : cell)).join("   ").trimEnd(),
    );
    return [`${stamp} [health] ${containers.length} running container(s)`, "", ...table];
  } catch {
    return [`${stamp} [health] request failed — is the backend reachable?`];
  }
}

// The api container colors its [api:<scope>] tags with ANSI escapes so `make logs` is
// scannable by subsystem. A <pre> renders those escapes as literal junk, so translate the
// codes the logger emits into spans. Codes we don't map are dropped rather than shown.
const ANSI_COLOR: Record<string, string> = {
  "32": "#4ade80", // green   — assignUser
  "34": "#60a5fa", // blue    — graphql
  "36": "#22d3ee", // cyan    — lifecycle (launch / rollback)
  "33": "#facc15", // yellow  — postgres
  "38;5;208": "#fb923c", // orange  — mongo
  "38;5;141": "#a78bfa", // violet  — redis
  "35": "#e879f9", // magenta — [stats] + [api:stats]
  "38;5;37": "#2dd4bf", // teal    — [api:logEvent]
  "38;5;245": "#94a3b8", // slate   — [logstream]
  "38;5;149": "#a3e635", // lime    — [api:startup]
  "38;5;170": "#f472b6", // pink    — [api:experiments]
};

// A few tags come from sources that don't emit ANSI themselves — the Python stats service,
// the logstream service, and the api's uncolored logEvent scope. Wrap those tags in the ANSI
// codes above so the same AnsiLine renderer colors them. Run on each line before rendering.
const TAG_ANSI: Array<[RegExp, string]> = [
  [/\[stats\]/g, "\x1b[35m$&\x1b[0m"],
  [/\[api:stats\]/g, "\x1b[35m$&\x1b[0m"],
  [/\[api:startup\]/g, "\x1b[38;5;149m$&\x1b[0m"],
  [/\[api:experiments\]/g, "\x1b[38;5;170m$&\x1b[0m"],
  [/\[api:logEvent\]/g, "\x1b[38;5;37m$&\x1b[0m"],
  [/\[logstream\]/g, "\x1b[38;5;245m$&\x1b[0m"],
];
export function colorizeTags(line: string): string {
  return TAG_ANSI.reduce((s, [re, rep]) => s.replace(re, rep), line);
}

export function AnsiLine({ text }: { text: string }) {
  // Capturing split → [text, code, text, code, …]: odd entries are the SGR codes.
  const parts = text.split(/\x1b\[([0-9;]*)m/);
  const out: ReactNode[] = [];
  let color: string | undefined;
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      color = ANSI_COLOR[part]; // "0" (reset) and anything unmapped → back to default
      return;
    }
    if (!part) return;
    out.push(
      color ? (
        <span key={i} style={{ color }}>
          {part}
        </span>
      ) : (
        part
      ),
    );
  });
  return (
    <>
      {out}
      {"\n"}
    </>
  );
}
