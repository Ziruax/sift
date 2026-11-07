// Prisma client with lazy, failure-tolerant initialization.
//
// On the sandbox dev server the SQLite client is always generated and the
// database always exists — `db` behaves exactly like a normal PrismaClient.
// On serverless hosts (e.g. the static-first Netlify deployment) the query
// engine may not be bundled for that platform; a static import would then
// crash every route that touches this module at cold start. Instead the
// client is created lazily and every method call resolves through it —
// routes catch the rejection and degrade to empty responses, while the
// client-side signal log covers the gap.

import type { PrismaClient } from "@prisma/client";

type PrismaModule = typeof import("@prisma/client");

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  prismaFailed?: boolean;
  prismaPromise?: Promise<PrismaClient | null>;
};

// ── Serverless bootstrap ────────────────────────────────────────────────────
//
// On Netlify the SQLite file lives in the function instance's ephemeral /tmp —
// brand new (and empty) on every cold start. This DDL mirrors schema.prisma's
// Signal table exactly; `IF NOT EXISTS` makes it a no-op on hosts where the
// schema was already pushed (the sandbox dev server).

const SIGNAL_DDL = `
CREATE TABLE IF NOT EXISTS "Signal" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "pair" TEXT NOT NULL,
  "base" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "score" INTEGER NOT NULL,
  "price" REAL NOT NULL,
  "change24h" REAL NOT NULL,
  "rvol" REAL NOT NULL,
  "buyPct" REAL NOT NULL,
  "volume24h" REAL NOT NULL,
  "note" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sl" REAL,
  "tp1" REAL,
  "tp2" REAL,
  "atrPct" REAL,
  "price5m" REAL,
  "change5m" REAL,
  "price15m" REAL,
  "change15m" REAL,
  "price60m" REAL,
  "change60m" REAL,
  "mfe" REAL,
  "mae" REAL,
  "status" TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS "Signal_createdAt_idx" ON "Signal"("createdAt");
CREATE INDEX IF NOT EXISTS "Signal_type_idx" ON "Signal"("type");
CREATE INDEX IF NOT EXISTS "Signal_pair_idx" ON "Signal"("pair");
`;

/** Resolve the PrismaClient, or null when it cannot run on this host. */
export function getDb(): Promise<PrismaClient | null> {
  if (globalForPrisma.prisma) return Promise.resolve(globalForPrisma.prisma);
  if (globalForPrisma.prismaFailed) return Promise.resolve(null);
  if (!globalForPrisma.prismaPromise) {
    globalForPrisma.prismaPromise = import("@prisma/client")
      .then((mod: PrismaModule) => {
        const client = new mod.PrismaClient({ log: ["error", "warn"] });
        return client
          .$executeRawUnsafe(SIGNAL_DDL)
          .catch(() => {
            /* schema already exists or the host cannot run DDL — queries will tell */
          })
          .then(() => {
            globalForPrisma.prisma = client;
            return client as PrismaClient;
          });
      })
      .catch((error) => {
        console.warn("[db] Prisma unavailable on this host — DB-backed routes degrade gracefully.", error);
        globalForPrisma.prismaFailed = true;
        return null;
      });
  }
  return globalForPrisma.prismaPromise;
}

// Deferred property chains: db.signal.upsert({...}) resolves the client on
// first call, walks to the real function, and applies it. If Prisma cannot
// load, every call rejects with a clear error the routes already catch.
function makeDeferred(clientPromise: Promise<PrismaClient | null>, path: PropertyKey[]): unknown {
  const callable = (...args: unknown[]) =>
    clientPromise.then((client) => {
      if (!client) throw new Error("SQLite storage is unavailable on this host.");
      let cursor: unknown = client;
      for (const key of path) {
        if (cursor === null || cursor === undefined) break;
        cursor = Reflect.get(cursor as object, key);
      }
      const fn = cursor as (...a: unknown[]) => unknown;
      if (typeof fn !== "function") {
        throw new Error(`Prisma client has no .${path.map(String).join(".")}()`);
      }
      return fn.apply(cursor, args);
    });
  return new Proxy(callable, {
    get: (_target, prop) => {
      if (prop === "then") return undefined; // not a thenable
      return makeDeferred(clientPromise, [...path, prop]);
    },
  });
}

export const db = makeDeferred(getDb(), []) as PrismaClient;
