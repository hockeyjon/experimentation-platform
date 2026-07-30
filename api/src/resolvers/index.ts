// Resolvers — the functions that fulfill each GraphQL operation.
//
// This is the integration point for all three datastores:
//   Postgres (Prisma) -> experiments, variants, sticky assignments (source of truth)
//   Redis             -> fast repeat lookups of a user's assignment
//   MongoDB           -> the exposure/conversion event log
import { DateTimeResolver, JSONResolver } from "graphql-scalars";
import { prisma } from "../db/prisma.js";
import { events, audit, type AuditEntry } from "../db/mongo.js";
import { redis, assignmentKey, ASSIGNMENT_TTL_SECONDS } from "../db/redis.js";
import { pickVariant } from "../lib/assignment.js";
import { log } from "../logger.js";

// Append an event to the Mongo event log (fire-and-forget shape, but we await for safety).
async function logEvent(
  experimentKey: string,
  variantKey: string,
  userId: string,
  type: "exposure" | "conversion",
  metadata?: Record<string, unknown>,
) {
  const doc = {
    experimentKey,
    variantKey,
    userId,
    type,
    metadata,
    timestamp: new Date(),
  };
  log.write("mongo", "events.insertOne", doc);
  const res = await events().insertOne(doc);
  log.info("mongo", `logged ${type} → ${experimentKey}/${variantKey} (user ${userId}) _id=${res.insertedId}`);
}

// Cache a user's variant on the hot read path. Every SET in the app goes through
// here, so the cache write is logged exactly once and in one shape.
async function cacheAssignment(cacheKey: string, variantKey: string) {
  log.write("redis", "SET", { key: cacheKey, value: variantKey, ex: ASSIGNMENT_TTL_SECONDS });
  await redis.set(cacheKey, variantKey, "EX", ASSIGNMENT_TTL_SECONDS);
}

export const resolvers = {
  DateTime: DateTimeResolver,
  JSON: JSONResolver,

  Query: {
    experiments: () => {
      log.info("experiments", "listing all experiments");
      return prisma.experiment.findMany({
        include: { variants: true },
        orderBy: { createdAt: "desc" },
      });
    },

    experiment: (_: unknown, args: { key: string }) =>
      prisma.experiment.findUnique({
        where: { key: args.key },
        include: { variants: true },
      }),

    // Read-only lookup: Redis first, then Postgres. Returns null if the user has
    // never been assigned (use the assignUser mutation to create one).
    assignment: async (_: unknown, args: { experimentKey: string; userId: string }) => {
      const cacheKey = assignmentKey(args.experimentKey, args.userId);
      const cached = await redis.get(cacheKey);
      if (cached) {
        log.info("assignment", `redis HIT ${args.experimentKey}/${args.userId} → ${cached}`);
        return { experimentKey: args.experimentKey, userId: args.userId, variantKey: cached, cached: true };
      }
      log.info("assignment", `redis MISS ${args.experimentKey}/${args.userId}, checking Postgres`);

      const experiment = await prisma.experiment.findUnique({ where: { key: args.experimentKey } });
      if (!experiment) return null;

      const existing = await prisma.assignment.findUnique({
        where: { experimentId_userId: { experimentId: experiment.id, userId: args.userId } },
        include: { variant: true },
      });
      if (!existing) return null;

      await cacheAssignment(cacheKey, existing.variant.key);
      return { experimentKey: args.experimentKey, userId: args.userId, variantKey: existing.variant.key, cached: false };
    },

    // Aggregate the Mongo event log into per-variant exposure/conversion counts.
    results: async (_: unknown, args: { experimentKey: string }) => {
      log.info("results", `aggregating Mongo events for ${args.experimentKey}`);
      const experiment = await prisma.experiment.findUnique({
        where: { key: args.experimentKey },
        include: { variants: true },
      });
      if (!experiment) return { experimentKey: args.experimentKey, variants: [] };

      // One grouped aggregation over the event log, then shape it per variant.
      const rows = await events()
        .aggregate<{ _id: { variantKey: string; type: string }; count: number }>([
          { $match: { experimentKey: args.experimentKey } },
          { $group: { _id: { variantKey: "$variantKey", type: "$type" }, count: { $sum: 1 } } },
        ])
        .toArray();

      const counts = new Map<string, { exposures: number; conversions: number }>();
      for (const v of experiment.variants) counts.set(v.key, { exposures: 0, conversions: 0 });
      for (const r of rows) {
        const entry = counts.get(r._id.variantKey) ?? { exposures: 0, conversions: 0 };
        if (r._id.type === "exposure") entry.exposures = r.count;
        if (r._id.type === "conversion") entry.conversions = r.count;
        counts.set(r._id.variantKey, entry);
      }

      const variants = [...counts.entries()].map(([variantKey, c]) => ({
        variantKey,
        exposures: c.exposures,
        conversions: c.conversions,
        conversionRate: c.exposures > 0 ? c.conversions / c.exposures : 0,
      }));

      return { experimentKey: args.experimentKey, variants };
    },
  },

  Mutation: {
    createExperiment: (
      _: unknown,
      args: {
        input: {
          key: string;
          name: string;
          description?: string;
          variants: { key: string; name: string; weight: number; isControl: boolean }[];
        };
      },
    ) => {
      const data = {
        key: args.input.key,
        name: args.input.name,
        description: args.input.description,
        variants: { create: args.input.variants },
      };
      log.write("postgres", "experiment.create", data);
      return prisma.experiment.create({ data, include: { variants: true } });
    },

    // Launch to production / roll back. Beyond flipping the Postgres status, this records
    // an immutable lifecycle entry in the Mongo audit trail — the who/what/when a real
    // experimentation platform keeps — and narrates it in the logs so the action is visible
    // end to end in the backend stream.
    setExperimentStatus: async (
      _: unknown,
      args: { key: string; status: "DRAFT" | "RUNNING" | "PAUSED" | "COMPLETED" },
    ) => {
      const experiment = await prisma.experiment.findUnique({ where: { key: args.key } });
      if (!experiment) throw new Error(`Unknown experiment: ${args.key}`);

      const from = experiment.status;
      const to = args.status;
      // Classify the transition: → RUNNING is a launch, RUNNING → anything else is a
      // rollback, everything else is a plain status change.
      const action: AuditEntry["action"] =
        to === "RUNNING" ? "launch" : from === "RUNNING" ? "rollback" : "status-change";

      // How many customers are live in the experiment right now — the number that makes a
      // launch or rollback consequential. Counted from the Postgres assignments.
      const enrolledCustomers = await prisma.assignment.count({
        where: { experimentId: experiment.id },
      });

      const label = action === "launch" ? "🚀 LAUNCH" : action === "rollback" ? "⏮ ROLLBACK" : "STATUS";
      log.info("lifecycle", `${label} ${args.key}: ${from} → ${to} (${enrolledCustomers} customers enrolled)`);

      // Postgres: flip the status (the source of truth the dashboard reads back).
      const where = { key: args.key };
      const data = { status: to };
      log.write("postgres", "experiment.update", { where, data });
      const updated = await prisma.experiment.update({ where, data, include: { variants: true } });

      // Mongo: append the audit entry. Append-only, no variant — hence its own collection.
      const entry: AuditEntry = { experimentKey: args.key, action, from, to, enrolledCustomers, timestamp: new Date() };
      log.write("mongo", "audit.insertOne", entry);
      const res = await audit().insertOne(entry);
      log.info("lifecycle", `${action} recorded in audit trail _id=${res.insertedId}`);

      return updated;
    },

    // The main event: bucket a user (deterministically), persist the sticky
    // assignment, cache it, and log an exposure.
    assignUser: async (
      _: unknown,
      args: { experimentKey: string; userId: string; variantKey?: string | null },
    ) => {
      const experiment = await prisma.experiment.findUnique({
        where: { key: args.experimentKey },
        include: { variants: true },
      });
      if (!experiment) throw new Error(`Unknown experiment: ${args.experimentKey}`);
      if (experiment.variants.length === 0) throw new Error("Experiment has no variants");
      log.info(
        "assignUser",
        `${args.userId} → ${args.experimentKey}${args.variantKey ? ` (forced=${args.variantKey})` : ""}`,
      );

      // Optional manual override: force a specific variant instead of bucketing.
      // (A demo affordance — a real platform would never move a user between variants.)
      const forced = args.variantKey
        ? experiment.variants.find((v) => v.key === args.variantKey)
        : undefined;
      if (args.variantKey && !forced) {
        throw new Error(`Unknown variant "${args.variantKey}" for ${args.experimentKey}`);
      }

      const cacheKey = assignmentKey(args.experimentKey, args.userId);

      const existing = await prisma.assignment.findUnique({
        where: { experimentId_userId: { experimentId: experiment.id, userId: args.userId } },
        include: { variant: true },
      });
      if (existing) {
        // Sticky and final: once a user is bucketed they stay in that variant. A repeat create
        // — even one that names a different variant — is REJECTED, not a reassignment (a real
        // platform never moves a bucketed user). Re-warm the cache so the sticky lookup is a
        // Redis hit, but log NO new exposure, so a duplicate create can't inflate the counts or
        // strand an exposure in another bucket.
        await cacheAssignment(cacheKey, existing.variant.key);
        log.info(
          "assignUser",
          `rejected → ${args.userId} already in ${existing.variant.key}; kept there (no reassignment)`,
        );
        return { experimentKey: args.experimentKey, userId: args.userId, variantKey: existing.variant.key, cached: true };
      }

      // New assignment: forced variant, or deterministic weighted bucketing.
      const chosenKey =
        forced?.key ??
        pickVariant(
          args.experimentKey,
          args.userId,
          experiment.variants.map((v) => ({ key: v.key, weight: v.weight })),
        )!;
      const chosen = experiment.variants.find((v) => v.key === chosenKey)!;

      const assignmentData = { experimentId: experiment.id, variantId: chosen.id, userId: args.userId };
      log.write("postgres", "assignment.create", {
        ...assignmentData,
        meaning: `${args.userId} → ${args.experimentKey}/${chosen.key}`,
      });
      await prisma.assignment.create({ data: assignmentData });
      await cacheAssignment(cacheKey, chosen.key);
      await logEvent(args.experimentKey, chosen.key, args.userId, "exposure");
      log.info(
        "assignUser",
        `new → bucketed ${args.userId} into ${chosen.key} (${forced ? "forced" : "deterministic"})`,
      );

      return { experimentKey: args.experimentKey, userId: args.userId, variantKey: chosen.key, cached: false };
    },

    // Record a conversion (or any custom event). We look up the user's variant so
    // the event is attributed correctly, preferring the Redis cache.
    logEvent: async (
      _: unknown,
      args: { experimentKey: string; userId: string; type: string; metadata?: Record<string, unknown> },
    ) => {
      let variantKey = await redis.get(assignmentKey(args.experimentKey, args.userId));
      if (!variantKey) {
        const experiment = await prisma.experiment.findUnique({ where: { key: args.experimentKey } });
        if (!experiment) throw new Error(`Unknown experiment: ${args.experimentKey}`);
        const existing = await prisma.assignment.findUnique({
          where: { experimentId_userId: { experimentId: experiment.id, userId: args.userId } },
          include: { variant: true },
        });
        if (!existing) throw new Error("User has no assignment; call assignUser first");
        variantKey = existing.variant.key;
      }

      const evType = args.type === "exposure" ? "exposure" : "conversion";
      log.info("logEvent", `${evType} for ${args.userId} in ${args.experimentKey} (variant ${variantKey})`);
      await logEvent(args.experimentKey, variantKey, args.userId, evType, args.metadata);
      return true;
    },

    // Remove ALL enrollments for an experiment across all three stores, so a
    // previously-enrolled user is treated as brand new on the next enroll.
    clearEnrollments: async (_: unknown, args: { experimentKey: string }) => {
      const experiment = await prisma.experiment.findUnique({ where: { key: args.experimentKey } });
      if (!experiment) throw new Error(`Unknown experiment: ${args.experimentKey}`);
      // Postgres: sticky assignments (the source of truth that repopulates Redis).
      const assignmentFilter = { experimentId: experiment.id };
      log.write("postgres", "assignment.deleteMany", {
        where: assignmentFilter,
        meaning: `all assignments for ${args.experimentKey}`,
      });
      const del = await prisma.assignment.deleteMany({ where: assignmentFilter });
      // Redis: cached assignments for this experiment (KEYS is fine at demo scale).
      const keys = await redis.keys(assignmentKey(args.experimentKey, "*"));
      if (keys.length) {
        log.write("redis", "DEL", { pattern: assignmentKey(args.experimentKey, "*"), keys });
        await redis.del(...keys);
      }
      // Mongo: exposure + conversion events.
      const eventFilter = { experimentKey: args.experimentKey };
      log.write("mongo", "events.deleteMany", eventFilter);
      const ev = await events().deleteMany(eventFilter);
      log.info(
        "clearEnrollments",
        `${args.experimentKey}: removed ${del.count} assignments, ${keys.length} cache keys, ${ev.deletedCount} events`,
      );
      return true;
    },
  },
};
