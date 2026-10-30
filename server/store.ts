import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import type { Contract } from "../shared/types.ts";

// A deliberately small JSON-file store: one file, atomic writes, in-memory cache.
// Good enough for a single-instance prototype; swap for Postgres in production.

mkdirSync(config.dataDir, { recursive: true });
mkdirSync(join(config.dataDir, "uploads"), { recursive: true });
const file = join(config.dataDir, "contracts.json");

const listeners = new Map<string, Set<(c: Contract) => void>>();
let cache: Record<string, Contract> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};

function persist() {
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(cache, null, 2));
  renameSync(tmp, file);
}

export const store = {
  list(): Contract[] {
    return Object.values(cache).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  get(id: string): Contract | undefined {
    return cache[id];
  },
  save(c: Contract) {
    c.updatedAt = new Date().toISOString();
    cache[c.id] = c;
    persist();
    for (const fn of listeners.get(c.id) ?? []) fn(c);
    return c;
  },
  subscribe(id: string, fn: (c: Contract) => void) {
    if (!listeners.has(id)) listeners.set(id, new Set());
    listeners.get(id)!.add(fn);
    return () => listeners.get(id)?.delete(fn);
  },
  findByOrder(orderId: string) {
    return Object.values(cache).find((c) => c.funding?.orderId === orderId);
  },
  findByAuthorization(authId: string) {
    return Object.values(cache).find((c) => c.funding?.authorizationId === authId);
  },
  uploadsDir: join(config.dataDir, "uploads"),
};

// Serialize mutations per contract so concurrent requests (webhooks + UI) can't interleave.
const locks = new Map<string, Promise<unknown>>();
export function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(id, next.catch(() => undefined));
  return next;
}
