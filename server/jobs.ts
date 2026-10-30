// Durable background jobs (AI verification, payout status checks).
//
// Requests enqueue work and return immediately; workers claim jobs atomically, retry with
// exponential backoff, and recover jobs left "running" by a crashed process. Any number of
// worker processes can share the queue because claiming is a single atomic UPDATE … RETURNING.
import { db } from "./store.ts";
import { simulation } from "./config.ts";
import { log } from "./log.ts";

export type JobKind = "verify" | "payout_status";
type Handler = (payload: any, job: { id: number; attempts: number; maxAttempts: number }) => Promise<void>;

const handlers = new Map<JobKind, Handler>();
export const registerJob = (kind: JobKind, fn: Handler) => handlers.set(kind, fn);

const insert = db.prepare(`INSERT INTO jobs (kind, contract_id, payload, run_after, max_attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
const claim = db.prepare(`UPDATE jobs SET status = 'running', locked_at = ?, attempts = attempts + 1, updated_at = ?
  WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_after <= ? ORDER BY run_after, id LIMIT 1)
  RETURNING id, kind, payload, attempts, max_attempts AS maxAttempts`);
const done = db.prepare(`UPDATE jobs SET status = 'done', updated_at = ?, last_error = NULL WHERE id = ?`);
const retry = db.prepare(`UPDATE jobs SET status = ?, run_after = ?, last_error = ?, updated_at = ? WHERE id = ?`);
const recover = db.prepare(`UPDATE jobs SET status = 'queued', run_after = ? WHERE status = 'running' AND locked_at < ?`);
const pending = db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'running')`);
const prune = db.prepare(`DELETE FROM jobs WHERE status = 'done' AND updated_at < ?`);

export function enqueue(kind: JobKind, contractId: string, payload: unknown, { delayMs = 0, maxAttempts = 3 } = {}) {
  const now = Date.now();
  // Jobs enqueued while generating sample data stay simulated whichever worker runs them.
  const body = { ...(payload as object), __sim: simulation.getStore() === true };
  insert.run(kind, contractId, JSON.stringify(body), now + delayMs, maxAttempts, now, now);
  kick();
}

let running = 0;
let stopped = false;
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 4);
const idle: (() => void)[] = [];

async function runOne(): Promise<boolean> {
  const now = Date.now();
  const job = claim.get(now, now, now) as { id: number; kind: JobKind; payload: string; attempts: number; maxAttempts: number } | undefined;
  if (!job) return false;
  const fn = handlers.get(job.kind);
  const started = Date.now();
  try {
    if (!fn) throw new Error(`No handler for job kind ${job.kind}`);
    const payload = JSON.parse(job.payload);
    await simulation.run(payload.__sim === true, () => fn(payload, job));
    done.run(Date.now(), job.id);
    log.info("job.done", { job: job.id, kind: job.kind, ms: Date.now() - started });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const final = job.attempts >= job.maxAttempts;
    retry.run(final ? "failed" : "queued", Date.now() + 2 ** job.attempts * 1000, msg.slice(0, 500), Date.now(), job.id);
    log.warn("job.error", { job: job.id, kind: job.kind, attempt: job.attempts, final, error: msg });
  }
  return true;
}

function kick() {
  if (stopped) return;
  // Start up to CONCURRENCY workers; each keeps claiming jobs until the queue has nothing due.
  while (running < CONCURRENCY) {
    running++;
    runOne().then(
      (more) => {
        running--;
        if (more) kick();
        else if (running === 0) idle.splice(0).forEach((r) => r());
      },
      () => {
        running--;
      },
    );
  }
}

let timer: NodeJS.Timeout | undefined;
export function startWorkers() {
  stopped = false;
  recover.run(Date.now(), Date.now() - 5 * 60_000); // jobs orphaned by a crash
  timer = setInterval(() => {
    kick();
    prune.run(Date.now() - 7 * 864e5);
  }, 1000);
  timer.unref();
  kick();
}

export async function stopWorkers() {
  stopped = true;
  if (timer) clearInterval(timer);
  if (running > 0) await new Promise<void>((r) => idle.push(r));
}

/** Process everything currently due (used by tests and scripts). */
export async function drain() {
  for (let i = 0; i < 1000; i++) {
    if ((pending.get() as { n: number }).n === 0 && running === 0) return;
    if (running === 0) {
      if (!(await runOne())) return; // only future (backed-off) jobs remain
    } else {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

export const queueDepth = () => (pending.get() as { n: number }).n;
