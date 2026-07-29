// API entry point — boots Apollo Server and connects the datastores.
//
// Express rather than startStandaloneServer because this process serves more than GraphQL:
// /stats/stream/:key is a Server-Sent Events endpoint that relays the Python stats service
// to the browser. Keeping it on this port means the API stays the single public entry
// point — the stats service needs no route of its own and stays off the internet.
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@apollo/server/express4";
import express from "express";
import cors from "cors";
import { typeDefs } from "./schema.js";
import { resolvers } from "./resolvers/index.js";
import { connectMongo } from "./db/mongo.js";
import { statsStreamHandler } from "./stats/stream.js";
import { log } from "./logger.js";

// Best-effort operation label: the first top-level field (assignUser, experiments, …),
// since the frontend sends anonymous operations.
function opName(rc: any): string {
  const sel = rc?.operation?.selectionSet?.selections?.[0];
  const field = sel && sel.kind === "Field" ? sel.name?.value : undefined;
  return field ?? rc?.operationName ?? rc?.operation?.operation ?? "operation";
}

// Logs every GraphQL operation + how long it took, so the container output shows the
// request flow. Resolvers add their own [api:<name>] lines for the internal details.
const loggingPlugin = {
  async requestDidStart() {
    const started = Date.now();
    return {
      async didResolveOperation(rc: any) {
        log.info("graphql", `▶ ${rc.operation?.operation ?? "op"} ${opName(rc)}`);
      },
      async willSendResponse(rc: any) {
        log.info("graphql", `■ ${opName(rc)} done in ${Date.now() - started}ms`);
      },
      async didEncounterErrors(rc: any) {
        log.error("graphql", `${opName(rc)} failed`, rc.errors?.map((e: any) => e.message));
      },
    };
  },
};

async function main() {
  log.info("startup", "connecting to MongoDB…");
  await connectMongo();

  const server = new ApolloServer({ typeDefs, resolvers, plugins: [loggingPlugin] });
  await server.start();

  const app = express();
  // CORS stays permissive so the static frontend can call us cross-origin, matching what
  // startStandaloneServer did before.
  app.use(cors());

  // SSE first, and deliberately without express.json() — the stream must not wait on a
  // body parser, and it never receives one.
  app.get("/stats/stream/:experimentKey", statsStreamHandler);

  app.use("/", express.json(), expressMiddleware(server));

  const port = Number(process.env.PORT ?? 4000);
  await new Promise<void>((resolve) => app.listen({ port }, resolve));

  log.info("startup", `GraphQL API ready at http://localhost:${port}/`);
}

main().catch((err) => {
  log.error("startup", "failed to start API", err);
  process.exit(1);
});
