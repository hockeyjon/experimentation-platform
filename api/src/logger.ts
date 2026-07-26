// Tiny INFO logger. Everything goes to stdout, which Docker captures — view the flow
// with `make logs` or `docker compose -f deploy/docker-compose.prod.yml logs -f api`.
// Human-readable on purpose so you can follow a request through the resolvers + datastores.
function ts(): string {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

export const log = {
  info(scope: string, msg: string, extra?: unknown): void {
    if (extra !== undefined) console.log(`${ts()} [api:${scope}] ${msg}`, extra);
    else console.log(`${ts()} [api:${scope}] ${msg}`);
  },
  error(scope: string, msg: string, extra?: unknown): void {
    if (extra !== undefined) console.error(`${ts()} [api:${scope}] ✗ ${msg}`, extra);
    else console.error(`${ts()} [api:${scope}] ✗ ${msg}`);
  },
};
