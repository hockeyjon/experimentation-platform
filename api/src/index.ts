// API entry point — boots Apollo Server and connects the datastores.
import { ApolloServer } from "@apollo/server";
import { startStandaloneServer } from "@apollo/server/standalone";
import { typeDefs } from "./schema.js";
import { resolvers } from "./resolvers/index.js";
import { connectMongo } from "./db/mongo.js";

async function main() {
  // Mongo needs an explicit connect (Prisma and Redis connect lazily on first use).
  await connectMongo();

  const server = new ApolloServer({ typeDefs, resolvers });

  const port = Number(process.env.PORT ?? 4000);
  const { url } = await startStandaloneServer(server, {
    listen: { port },
    // CORS is permissive here so the Next.js dev server (port 3000) can call us.
  });

  console.log(`🚀 GraphQL API ready at ${url}`);
  console.log(`   Open it in a browser to explore the schema with Apollo Sandbox.`);
}

main().catch((err) => {
  console.error("Failed to start API:", err);
  process.exit(1);
});
