// Persistence: SQLite (Node's built-in driver) in WAL mode.
//
// Contracts are stored as one JSON document per row with indexed columns for the lookups the
// app needs (status, PayPal order/authorization, every PayPal reference in the ledger).
// The same schema maps directly onto Postgres (doc → JSONB) for multi-instance deployments;
// see docs/ARCHITECTURE.md. Uploaded files live in a blob directory addressed by contract id.
import { mkdirSync, existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import type { Contract } from "../shared/types.ts";

// node:sqlite prints an "experimental" warning on load; keep logs clean.
const emit = process.emitWarning.bind(process);
process.emitWarning = ((w: string | Error, ...rest: any[]) => {
  if (String(typeof w === "string" ? w : w.message).includes("SQLite")) return;
  return (emit as any)(w, ...rest);
}) as typeof process.emitWarning;
const { DatabaseSync } = await import("node:sqlite");

mkdirSync(config.dataDir, { recursive: true });
mkdirSync(join(config.dataDir, "uploads"), { recursive: true });

export const db = new DatabaseSync(join(config.dataDir, "covenant.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);

// ---- migrations (append-only)
const MIGRATIONS: string[] = [
  `CREATE TABLE contracts (
     id TEXT PRIMARY KEY,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     status TEXT NOT NULL,
     order_id TEXT,
     authorization_id TEXT,
     doc TEXT NOT NULL
   );
   CREATE INDEX contracts_status ON contracts(status);
   CREATE INDEX contracts_order ON contracts(order_id);
   CREATE INDEX contracts_auth ON contracts(authorization_id);
   CREATE TABLE paypal_refs (
     ref TEXT PRIMARY KEY,
     contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE
   );
   CREATE TABLE jobs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL,
     contract_id TEXT NOT NULL,
     payload TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'queued',
     attempts INTEGER NOT NULL DEFAULT 0,
     max_attempts INTEGER NOT NULL DEFAULT 3,
     run_after INTEGER NOT NULL,
     locked_at INTEGER,
     last_error TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX jobs_ready ON jobs(status, run_after);
   CREATE TABLE idempotency (
     scope TEXT NOT NULL,
     key TEXT NOT NULL,
     status INTEGER NOT NULL,
     response TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (scope, key)
   );`,
];

db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
const current = (db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations`).get() as { v: number }).v;
for (let v = current; v < MIGRATIONS.length; v++) {
  db.exec("BEGIN");
  try {
    db.exec(MIGRATIONS[v]);
    db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(v + 1, new Date().toISOString());
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

const q = {
  get: db.prepare(`SELECT doc FROM contracts WHERE id = ?`),
  upsert: db.prepare(`INSERT INTO contracts (id, created_at, updated_at, status, order_id, authorization_id, doc)
                      VALUES (?, ?, ?, ?, ?, ?, ?)
                      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, status = excluded.status,
                        order_id = excluded.order_id, authorization_id = excluded.authorization_id, doc = excluded.doc`),
  ref: db.prepare(`INSERT OR IGNORE INTO paypal_refs (ref, contract_id) VALUES (?, ?)`),
  byRef: db.prepare(`SELECT contract_id AS id FROM paypal_refs WHERE ref = ?`),
  byOrder: db.prepare(`SELECT doc FROM contracts WHERE order_id = ?`),
  byAuth: db.prepare(`SELECT doc FROM contracts WHERE authorization_id = ?`),
  count: db.prepare(`SELECT COUNT(*) AS n FROM contracts`),
};

const parse = (row: unknown) => (row ? (JSON.parse((row as { doc: string }).doc) as Contract) : undefined);
const listeners = new Map<string, Set<(c: Contract) => void>>();

export const store = {
  get(id: string): Contract | undefined {
    return parse(q.get.get(id));
  },
  save(c: Contract) {
    c.updatedAt = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      q.upsert.run(c.id, c.createdAt, c.updatedAt, c.status, c.funding?.orderId ?? null, c.funding?.authorizationId ?? null, JSON.stringify(c));
      for (const l of c.ledger) if (l.reference && !l.reference.startsWith("late-")) q.ref.run(l.reference, c.id);
      for (const m of c.milestones) {
        if (m.settlement?.captureId) q.ref.run(m.settlement.captureId, c.id);
        if (m.settlement?.payoutBatchId) q.ref.run(m.settlement.payoutBatchId, c.id);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    for (const fn of listeners.get(c.id) ?? []) fn(c);
    return c;
  },
  /** Find the contract a PayPal object (order, authorization, capture, payout batch) belongs to. */
  byPayPalRef(ref: string): Contract | undefined {
    const r = q.byRef.get(ref) as { id: string } | undefined;
    return r ? store.get(r.id) : parse(q.byOrder.get(ref)) ?? parse(q.byAuth.get(ref));
  },
  subscribe(id: string, fn: (c: Contract) => void) {
    if (!listeners.has(id)) listeners.set(id, new Set());
    listeners.get(id)!.add(fn);
    return () => listeners.get(id)?.delete(fn);
  },
  count(): number {
    return (q.count.get() as { n: number }).n;
  },
  ping() {
    db.prepare("SELECT 1").get();
  },
  close() {
    db.close();
  },
  uploadsDir: join(config.dataDir, "uploads"),
};

// One-time import from the earlier JSON-file store.
const legacy = join(config.dataDir, "contracts.json");
if (existsSync(legacy) && store.count() === 0) {
  try {
    const old = JSON.parse(readFileSync(legacy, "utf8")) as Record<string, any>;
    for (const c of Object.values(old)) {
      if (c.tokens && !c.access) {
        const { hashSecret } = await import("./access.ts");
        c.access = { payerHash: hashSecret(c.tokens.payer), payeeHash: hashSecret(c.tokens.payee), joinedAt: c.createdAt };
        delete c.tokens;
      }
      store.save(c as Contract);
    }
    renameSync(legacy, legacy + ".imported");
    console.log(`[store] imported ${Object.keys(old).length} contracts from contracts.json`);
  } catch (e) {
    console.warn(`[store] could not import contracts.json: ${e}`);
  }
}

// Serialize mutations per contract within this process. Across instances, writes are
// serialized by the database (BEGIN IMMEDIATE here; row locks / SELECT … FOR UPDATE on Postgres).
const locks = new Map<string, Promise<unknown>>();
export function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  locks.set(id, tail);
  tail.then(() => locks.get(id) === tail && locks.delete(id));
  return next;
}
