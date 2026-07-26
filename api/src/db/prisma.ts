// Postgres access via Prisma (Aurora stand-in).
// A single shared PrismaClient is reused across the process — creating one per
// request would exhaust the connection pool.
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();
