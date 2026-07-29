// Tiny INFO logger. Everything goes to stdout, which Docker captures — view the flow
// with `make logs` or `docker compose -f deploy/docker-compose.prod.yml logs -f api`.
// Human-readable on purpose so you can follow a request through the resolvers + datastores.
function ts(): string {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

// ANSI colors for the [api:<scope>] tag so a busy log is scannable by subsystem.
// Docker preserves the escape codes, so `make logs` renders them in your terminal.
// Scopes not listed here print uncolored; set NO_COLOR=1 to turn colors off entirely.
const RESET = "\x1b[0m";
const SCOPE_COLORS: Record<string, string> = {
  assignUser: "\x1b[32m", // green
  graphql: "\x1b[34m", // blue
  lifecycle: "\x1b[36m", // cyan — launch / rollback, the headline events
  mongo: "\x1b[38;5;208m", // orange (256-color — there is no basic ANSI orange)
  postgres: "\x1b[33m", // yellow
  redis: "\x1b[38;5;141m", // violet (256-color, like orange)
};

const colorEnabled = !process.env.NO_COLOR;

// Render the "[api:<scope>]" tag, colored when the scope has a color assigned.
function tag(scope: string): string {
  const color = SCOPE_COLORS[scope];
  return color && colorEnabled ? `${color}[api:${scope}]${RESET}` : `[api:${scope}]`;
}

export const log = {
  info(scope: string, msg: string, extra?: unknown): void {
    if (extra !== undefined) console.log(`${ts()} ${tag(scope)} ${msg}`, extra);
    else console.log(`${ts()} ${tag(scope)} ${msg}`);
  },
  // Write-path logging: the exact payload we hand to Postgres/Mongo, serialized on
  // one line so a write is easy to spot (and grep) in the interleaved container logs.
  write(store: "postgres" | "mongo" | "redis", op: string, payload: unknown): void {
    console.log(`${ts()} ${tag(store)} WRITE ${op} ${JSON.stringify(payload)}`);
  },
  error(scope: string, msg: string, extra?: unknown): void {
    if (extra !== undefined) console.error(`${ts()} ${tag(scope)} ✗ ${msg}`, extra);
    else console.error(`${ts()} ${tag(scope)} ✗ ${msg}`);
  },
};
