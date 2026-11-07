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

/** Resolve the PrismaClient, or null when it cannot run on this host. */
export function getDb(): Promise<PrismaClient | null> {
  if (globalForPrisma.prisma) return Promise.resolve(globalForPrisma.prisma);
  if (globalForPrisma.prismaFailed) return Promise.resolve(null);
  if (!globalForPrisma.prismaPromise) {
    globalForPrisma.prismaPromise = import("@prisma/client")
      .then((mod: PrismaModule) => {
        const client = new mod.PrismaClient({ log: ["error", "warn"] });
        globalForPrisma.prisma = client;
        return client as PrismaClient;
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
