// Covenant HTTP server. Node's built-in http module, no framework.
//
// Request pipeline: request id → security headers → rate limit → CSRF guard → body limit →
// idempotency replay → route handler → structured access log.
// Stateless apart from the database and blob directory, so it scales horizontally behind a
// load balancer once storage points at Postgres + object storage (see docs/ARCHITECTURE.md).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname, resolve } from "node:path";
import { config, paypalLive, claudeLive, aiHealth } from "./config.ts";
import { store, db } from "./store.ts";
import { paypal, PayPalError } from "./paypal.ts";
import * as engine from "./engine.ts";
import { portfolio, ask } from "./portfolio.ts";
import { kernelLive } from "./kernel.ts";
import { seedDemo } from "./seed.ts";
import { roleForKey, hashSecret, issueStreamTicket, verifyStreamTicket } from "./access.ts";
import { startWorkers, stopWorkers, queueDepth } from "./jobs.ts";
import { HttpError, securityHeaders, clientIp, rateLimit, readJson, sendJson, LIMITS } from "./http.ts";
import { log } from "./log.ts";
import type { Contract, PublicConfig, Role } from "../shared/types.ts";

const PUBLIC_DIR = resolve(process.cwd(), "public");
const demoTools = () => process.env.DEMO_TOOLS === "1";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".pdf": "application/pdf", ".json": "application/json", ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2", ".ico": "image/x-icon", ".md": "text/plain; charset=utf-8", ".map": "application/json", ".csv": "text/csv; charset=utf-8",
};

/** What a client may see: no key hashes, no server file paths. */
export function publicView(c: Contract) {
  const { access, ...rest } = c;
  return {
    ...rest,
    access: { joined: Boolean(access.payeeHash), inviteOutstanding: Boolean(access.inviteHash) },
    milestones: c.milestones.map((m) => ({
      ...m,
      submissions: m.submissions.map((s) => ({ ...s, items: s.items.map(({ storedPath, ...i }) => (void storedPath, i)) })),
    })),
  };
}
const view = publicView;

const publicConfig = (): PublicConfig => ({
  paypal: { mode: paypalLive() ? "sandbox" : "simulated", clientId: paypalLive() ? config.paypal.clientId : undefined, currency: config.paypal.currency },
  ai: { engine: claudeLive() ? "claude" : "offline", model: claudeLive() ? config.ai.model : undefined },
  kernel: kernelLive(),
  agStudioLicense: config.agStudioLicense || undefined,
  demoTools: demoTools(),
  webhooks: Boolean(process.env.NOTIFY_WEBHOOK_URL),
});

// ---------------------------------------------------------------- routing
type Ctx = { req: IncomingMessage; res: ServerResponse; params: Record<string, string>; body: any; role: Role | null; contract?: Contract; key: string };
type Route = { method: string; pattern: RegExp; keys: string[]; handler: (ctx: Ctx) => Promise<unknown>; limit: keyof typeof LIMITS; maxBody: number; idempotent: boolean };
const routes: Route[] = [];
const KB = 1024;
function route(method: string, path: string, handler: Route["handler"], opts: Partial<Pick<Route, "limit" | "maxBody" | "idempotent">> = {}) {
  const keys: string[] = [];
  const pattern = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
  routes.push({ method, pattern, keys, handler, limit: opts.limit ?? (method === "GET" ? "read" : "write"), maxBody: opts.maxBody ?? 256 * KB, idempotent: opts.idempotent ?? method === "POST" });
}
const needContract = (ctx: Ctx) => {
  if (!ctx.contract) throw new HttpError(404, "No contract with that id.");
  return ctx.contract;
};

route("GET", "/api/health", async () => ({ ok: true }));
route("GET", "/api/config", async () => publicConfig());
route("GET", "/api/status", async () => ({
  paypal: paypalLive() ? { mode: "sandbox", base: config.paypal.base, webhooks: Boolean(config.paypal.webhookId) } : { mode: "simulated" },
  ai: claudeLive() ? { engine: "claude", model: config.ai.model } : { engine: "offline", reason: config.ai.apiKey ? `Claude unavailable: ${aiHealth.reason}` : "No API key configured" },
  kernel: kernelLive(),
  agStudioLicensed: Boolean(config.agStudioLicense),
  notifications: Boolean(process.env.NOTIFY_WEBHOOK_URL),
  queueDepth: queueDepth(),
  contracts: store.count(),
}));

route("POST", "/api/compile", async ({ body }) => {
  const r = await engine.createContract(String(body.text ?? ""), { payer: body.payer, payee: body.payee, origin: body.origin === "mcp" ? "mcp" : "web" });
  return { contract: view(r.contract), payerKey: r.payerKey, inviteCode: r.inviteCode };
}, { limit: "ai", maxBody: 16 * KB });

route("POST", "/api/contracts/:id/join", async ({ params, body }) => {
  const r = await engine.claimInvite(params.id, String(body.code ?? ""));
  return { contract: view(r.contract), payeeKey: r.payeeKey };
}, { limit: "join", maxBody: 4 * KB });

route("POST", "/api/contracts/:id/invite", async ({ params, role }) => {
  const r = await engine.reissueInvite(params.id, role);
  return { contract: view(r.contract), inviteCode: r.inviteCode };
});

route("GET", "/api/contracts/:id", async (ctx) => {
  const c = needContract(ctx);
  if (!ctx.role) throw new HttpError(403, "You don't have access to this contract.");
  return { contract: view(c), role: ctx.role };
});

route("POST", "/api/contracts/:id/stream-ticket", async (ctx) => {
  needContract(ctx);
  if (!ctx.role) throw new HttpError(403, "You don't have access to this contract.");
  return { ticket: issueStreamTicket(ctx.params.id, ctx.role) };
}, { idempotent: false });

route("POST", "/api/contracts/:id/draft", async ({ params, role, body }) => ({ contract: view(await engine.updateDraft(params.id, role, body)) }));
route("POST", "/api/contracts/:id/sign", async ({ params, role }) => ({ contract: view(await engine.sign(params.id, role)) }));
route("POST", "/api/contracts/:id/paypal/order", async ({ params, role }) => engine.createOrder(params.id, role));
route("POST", "/api/contracts/:id/paypal/authorize", async ({ params, role, body }) => ({ contract: view(await engine.authorizeOrder(params.id, role, String(body.orderId))) }));
route("POST", "/api/contracts/:id/milestones/:mid/evidence", async ({ params, role, body }) => ({ contract: view(await engine.submitEvidence(params.id, role, params.mid, body)) }), { limit: "evidence", maxBody: 80 * 1024 * KB });
route("POST", "/api/contracts/:id/milestones/:mid/review", async ({ params, role, body }) => ({ contract: view(await engine.review(params.id, role, params.mid, body.decision === "approve" ? "approve" : "reject", body.note)) }));
route("POST", "/api/contracts/:id/milestones/:mid/dispute", async ({ params, role, body }) => ({ contract: view(await engine.openDispute(params.id, role, params.mid, String(body.reason ?? ""))) }));
route("POST", "/api/contracts/:id/milestones/:mid/statement", async ({ params, role, body }) => ({ contract: view(await engine.addStatement(params.id, role, params.mid, String(body.text ?? ""))) }));
route("POST", "/api/contracts/:id/milestones/:mid/resolve", async ({ params, role }) => ({ contract: view(await engine.resolveDispute(params.id, role, params.mid)) }), { limit: "ai" });
route("POST", "/api/contracts/:id/milestones/:mid/reclaim", async ({ params, role }) => ({ contract: view(await engine.reclaim(params.id, role, params.mid)) }));
route("POST", "/api/contracts/:id/milestones/:mid/retry-payout", async ({ params, role }) => ({ contract: view(await engine.retryPayout(params.id, role, params.mid)) }));
route("POST", "/api/contracts/:id/cancel", async ({ params, role }) => ({ contract: view(await engine.cancel(params.id, role)) }));

route("POST", "/api/portfolio", async ({ body }) => portfolio(Array.isArray(body.pairs) ? body.pairs.slice(0, 200) : []), { maxBody: 64 * KB, idempotent: false });
route("POST", "/api/portfolio/ask", async ({ body }) => {
  const p = portfolio(Array.isArray(body.pairs) ? body.pairs.slice(0, 200) : []);
  return ask(String(body.question ?? ""), p.milestones);
}, { limit: "ai", maxBody: 64 * KB, idempotent: false });

route("POST", "/api/demo/seed", async () => {
  if (!demoTools()) throw new HttpError(404, "No such endpoint.");
  return { contracts: await seedDemo() };
}, { limit: "ai" });

route("POST", "/api/paypal/webhook", async ({ req, body }) => {
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  const verified = paypalLive() && (await paypal().verifyWebhook(headers, body).catch(() => false));
  if (!verified) throw new HttpError(401, "Webhook signature could not be verified.");
  return { handled: await engine.handleWebhook(body) };
}, { maxBody: 512 * KB, idempotent: false });

// ---------------------------------------------------------------- idempotency
// Retried POSTs carrying the same Idempotency-Key get the original response instead of acting twice
// (e.g. a double-clicked "Approve and pay" or a network retry during PayPal authorization).
const idemGet = db.prepare(`SELECT status, response FROM idempotency WHERE scope = ? AND key = ?`);
const idemPut = db.prepare(`INSERT OR IGNORE INTO idempotency (scope, key, status, response, created_at) VALUES (?, ?, ?, ?, ?)`);
const idemPrune = db.prepare(`DELETE FROM idempotency WHERE created_at < ?`);
setInterval(() => idemPrune.run(Date.now() - 24 * 3600_000), 3600_000).unref();

// ---------------------------------------------------------------- live updates (SSE)
const streams = new Set<ServerResponse>();
function stream(req: IncomingMessage, res: ServerResponse, id: string) {
  const url = new URL(req.url ?? "/", "http://x");
  const role = verifyStreamTicket(url.searchParams.get("ticket") ?? "", id);
  if (!role || !store.get(id)) return sendJson(res, 403, { error: "Not allowed." });
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write(`retry: 3000\n\n`);
  streams.add(res);
  const unsub = store.subscribe(id, (fresh) => res.write(`data: ${JSON.stringify(view(fresh))}\n\n`));
  const ping = setInterval(() => res.write(`: ping\n\n`), 20000);
  req.on("close", () => {
    unsub();
    clearInterval(ping);
    streams.delete(res);
  });
}

// ---------------------------------------------------------------- static files
async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string, headers: Record<string, string>) {
  let base = PUBLIC_DIR;
  let rel = pathname;
  if (pathname.startsWith("/uploads/")) {
    base = store.uploadsDir;
    rel = pathname.slice("/uploads".length);
  }
  let file: string;
  try {
    file = normalize(join(base, decodeURIComponent(rel)));
  } catch {
    return sendJson(res, 400, { error: "Bad path" });
  }
  if (!file.startsWith(base)) return sendJson(res, 400, { error: "Bad path" });
  try {
    const s = await stat(file);
    if (s.isFile()) {
      const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
      const h: Record<string, string> = { ...headers, "Content-Type": type, "Content-Length": String(s.size), "Cache-Control": pathname.startsWith("/dist/") ? "public, max-age=300" : "no-cache" };
      if (base === store.uploadsDir) {
        // Uploaded files are untrusted: never let them run script or be framed as the app.
        h["Content-Security-Policy"] = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
        h["Cache-Control"] = "private, max-age=3600";
        if (!/^image\/|^application\/pdf|^text\/plain|^text\/csv/.test(type)) h["Content-Disposition"] = "attachment";
      }
      res.writeHead(200, h);
      return res.end(req.method === "HEAD" ? undefined : await readFile(file));
    }
  } catch {
    /* fall through */
  }
  if (pathname.startsWith("/uploads/") || pathname.startsWith("/dist/") || extname(pathname)) return sendJson(res, 404, { error: "Not found" }, headers);
  const html = securityHeaders(req, true);
  res.writeHead(200, { ...html, "Content-Type": MIME[".html"], "Cache-Control": "no-cache" });
  res.end(await readFile(join(PUBLIC_DIR, "index.html")));
}

// ---------------------------------------------------------------- server
let shuttingDown = false;
const server = createServer(async (req, res) => {
  const started = Date.now();
  const requestId = String(req.headers["x-request-id"] ?? "").slice(0, 64) || randomUUID();
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";
  const ip = clientIp(req);
  const base = { ...securityHeaders(req, false), "X-Request-Id": requestId };
  res.on("finish", () => {
    if (url.pathname.startsWith("/api/") || res.statusCode >= 400) {
      log.info("http", { id: requestId, method, path: url.pathname.replace(/\/(cov|ms)_[\w-]+/g, "/$1_:id"), status: res.statusCode, ms: Date.now() - started });
    }
  });

  try {
    if (url.pathname === "/healthz") return sendJson(res, 200, { ok: true }, base);
    if (url.pathname === "/readyz") {
      if (shuttingDown) return sendJson(res, 503, { ready: false, reason: "shutting down" }, base);
      store.ping();
      return sendJson(res, 200, { ready: true, queueDepth: queueDepth() }, base);
    }

    const sse = url.pathname.match(/^\/api\/contracts\/([^/]+)\/stream$/);
    if (sse && method === "GET") {
      rateLimit(ip, "read");
      return stream(req, res, sse[1]);
    }

    if (url.pathname.startsWith("/api/")) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = url.pathname.match(r.pattern);
        if (!m) continue;
        rateLimit(ip, r.limit);
        // CSRF: state-changing calls must be JSON, which a cross-site form can't send without CORS.
        if (method === "POST" && !String(req.headers["content-type"] ?? "").includes("application/json")) {
          throw new HttpError(415, "Send JSON with Content-Type: application/json.");
        }
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const key = String(req.headers["x-covenant-key"] ?? "");
        const contract = params.id ? store.get(params.id) : undefined;

        const idemKey = String(req.headers["idempotency-key"] ?? "");
        const scope = r.idempotent && idemKey ? `${method} ${url.pathname} ${key ? hashSecret(key).slice(0, 16) : "-"}` : "";
        if (scope && idemKey.length <= 128) {
          const prior = idemGet.get(scope, idemKey) as { status: number; response: string } | undefined;
          if (prior) {
            res.writeHead(prior.status, { ...base, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Idempotent-Replay": "true" });
            return res.end(prior.response);
          }
        }

        const body = method === "POST" ? await readJson(req, r.maxBody) : {};
        const out = await r.handler({ req, res, params, body, role: roleForKey(contract, key), contract, key });
        if (scope && idemKey.length <= 128) idemPut.run(scope, idemKey, 200, JSON.stringify(out), Date.now());
        return sendJson(res, 200, out, base);
      }
      return sendJson(res, 404, { error: "No such endpoint." }, base);
    }
    if (method !== "GET" && method !== "HEAD") return sendJson(res, 405, { error: "Method not allowed" }, base);
    return await serveStatic(req, res, url.pathname, base);
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, requestId }, { ...base, ...e.headers });
    if (e instanceof engine.HttpError) return sendJson(res, e.status, { error: e.message, requestId }, base);
    if (e instanceof PayPalError) return sendJson(res, 502, { error: `PayPal: ${e.message}`, debugId: e.debugId, requestId }, base);
    const status = (e as { status?: number })?.status;
    if (status && status >= 400 && status < 500) return sendJson(res, status, { error: (e as Error).message, requestId }, base);
    log.error("unhandled", { id: requestId, error: e instanceof Error ? e.stack : String(e) });
    return sendJson(res, 500, { error: "Something went wrong on our side. Try again.", requestId }, base);
  }
});

server.keepAliveTimeout = 65_000; // longer than typical load balancer idle timeouts
server.headersTimeout = 66_000;
server.requestTimeout = 120_000;

server.listen(config.port, () => {
  startWorkers();
  console.log(`\n  Covenant running at http://localhost:${config.port}`);
  console.log(`  PayPal: ${paypalLive() ? `sandbox (${config.paypal.base})` : "test mode (simulated). Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET for the PayPal sandbox"}`);
  console.log(`  AI:     ${claudeLive() ? `Claude (${config.ai.model})` : "rules engine. Set ANTHROPIC_API_KEY to use Claude"}`);
  console.log(`  Kernel: ${kernelLive() ? "on" : "off"}   Demo tools: ${demoTools() ? "on" : "off"}\n`);
});

// Graceful shutdown: stop taking traffic, let in-flight requests and jobs finish, close the DB.
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutdown", { signal });
  server.close();
  for (const s of streams) s.end();
  const force = setTimeout(() => process.exit(1), 25_000);
  force.unref();
  await stopWorkers();
  store.close();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
