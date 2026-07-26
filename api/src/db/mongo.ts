// MongoDB access (DocumentDB stand-in).
//
// Events (a user was *exposed* to a variant, a user *converted*) are high-volume,
// append-heavy, and schema-flexible — the classic reason to reach for a document
// store instead of a relational table. Experimentation uses AWS DocumentDB for this; we use
// plain MongoDB locally (DocumentDB is API-compatible with MongoDB).
import { MongoClient, Db, Collection } from "mongodb";
import { log } from "../logger.js";

const url = process.env.MONGO_URL ?? "mongodb://localhost:27017";
const dbName = process.env.MONGO_DB ?? "experiments_events";

// heartbeatFrequencyMS slows the driver's topology-monitoring pings (default 10s → 60s),
// which cuts the "unauthenticated connection" lines Mongo logs for each probe.
const client = new MongoClient(url, { heartbeatFrequencyMS: 60000 });
let db: Db | null = null;

// A single event document. Note there's no rigid schema — that's the point of Mongo.
export interface ExperimentEvent {
  experimentKey: string;
  variantKey: string;
  userId: string;
  type: "exposure" | "conversion";
  // free-form metadata: revenue, page, device, anything the client wants to attach
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

export async function connectMongo(): Promise<void> {
  await client.connect();
  db = client.db(dbName);
  // Indexes that make the aggregation queries in the stats layer fast.
  await events().createIndex({ experimentKey: 1, variantKey: 1, type: 1 });
  await events().createIndex({ timestamp: -1 });
  log.info("mongo", `connected to ${dbName}`);
}

export function events(): Collection<ExperimentEvent> {
  if (!db) throw new Error("Mongo not connected — call connectMongo() first");
  return db.collection<ExperimentEvent>("events");
}
