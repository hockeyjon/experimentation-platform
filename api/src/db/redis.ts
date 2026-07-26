// Redis — the assignment cache.
//
// Once a user is bucketed into a variant, that decision is "sticky": every later
// lookup should return the same variant, fast, without hitting Postgres. Redis is
// the standard place for that hot read path. We cache the variant key under a
// composite key and let Postgres remain the source of truth.
import Redis from "ioredis";

export const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

// Build the cache key for a (experiment, user) pair.
export const assignmentKey = (experimentKey: string, userId: string) =>
  `assign:${experimentKey}:${userId}`;

// Assignments rarely change, but we still set a TTL so a stale cache self-heals.
export const ASSIGNMENT_TTL_SECONDS = 60 * 60 * 24; // 24h
