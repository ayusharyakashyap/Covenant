// Covenant HTTP server. Node's built-in http module, no framework.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname, resolve } from "node:path";
import { config, paypalLive, claudeLive } from "./config.ts";
import { store } from "./store.ts";
import { paypal, PayPalError } from "./paypal.ts";
import * as engine from "./engine.ts";
import { portfolio, ask } from "./portfolio.ts";
import { kernelLive } from "./kernel.ts";
import { seedDemo } from "./seed.ts";
import { HttpError } from "./engine.ts";
import type { Contract, PublicConfig, Role } from "../shared/types.ts";

const PUBLIC_DIR = resolve(process.cwd(), "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".pdf": "application/pdf", ".json": "application/json", ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2", ".ico": "image/x-icon", ".md": "text/plain; charset=utf-8", ".map": "application/json",
};

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(json);
}

async function readBody(req: IncomingMessage, limit = 80 * 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "Upload is too large (80 MB max per submission).");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Request body must be JSON.");
  }
}

function roleFor(c: Contract | undefined, req: IncomingMessage): Role | null {
  const key = String(req.headers["x-covenant-key"] ?? "");
  if (!c || !key) return null;
  if (key === c.tokens.payer) return "payer";
  if (key === c.tokens.payee) return "payee";
  return null;
}

/** What a client may see: no access tokens, no server file paths. */
export function publicView(c: Contract) {
  const { tokens, ...rest } = c;
  void tokens;
  return {
    ...rest,
    milestones: c.milestones.map((m) => ({
      ...m,
      submissions: m.submissions.map((s) => ({ ...s, items: s.items.map(({ storedPath, ...i }) => (void storedPath, i)) })),
    })),
  };
}

const publicConfig = (): PublicConfig => ({
  paypal: { mode: paypalLive() ? "sandbox" : "simulated", clientId: paypalLive() ? config.paypal.clientId : undefined, currency: config.paypal.currency },
  ai: { engine: claudeLive() ? "claude" : "offline", model: claudeLive() ? config.ai.model : undefined },
  kernel: kernelLive(),
  agStudioLicense: config.agStudioLicense || undefined,
});

type Handler = (ctx: { req: IncomingMessage; res: ServerResponse; params: Record<string, string>; body: any; role: Role | null; contract?: Contract }) => Promise<unknown>;
const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
  routes.push({ method, pattern, keys, handler });
}

const view = (c: Contract) => publicView(c);

route("GET", "/api/health", async () => ({ ok: true, paypal: paypalLive() ? "sandbox" : "simulated", ai: claudeLive() ? "claude" : "offline" }));
route("GET", "/api/config", async () => publicConfig());

route("POST", "/api/compile", async ({ body }) => {
  const c = await engine.createContract(String(body.text ?? ""), { payer: body.payer, payee: body.payee, origin: body.origin === "mcp" ? "mcp" : "web" });
  return { contract: view(c), keys: c.tokens };
});

route("POST", "/api/demo/seed", async () => ({ contracts: await seedDemo() }));
route("POST", "/api/portfolio", async ({ body }) => portfolio(Array.isArray(body.pairs) ? body.pairs : []));
route("POST", "/api/portfolio/ask", async ({ body }) => {
  const p = portfolio(Array.isArray(body.pairs) ? body.pairs : []);
  return ask(String(body.question ?? ""), p.milestones);
});

route("GET", "/api/contracts/:id", async ({ contract, role }) => {
  if (!contract) throw new HttpError(404, "No contract with that id.");
  if (!role) throw new HttpError(403, "This link is missing its access key.");
  return { contract: view(contract), role };
});

route("POST", "/api/contracts/:id/draft", async ({ params, role, body }) => ({ contract: view(await engine.updateDraft(params.id, role, body)) }));
route("POST", "/api/contracts/:id/sign", async ({ params, role }) => ({ contract: view(await engine.sign(params.id, role)) }));
route("POST", "/api/contracts/:id/paypal/order", async ({ params, role }) => engine.createOrder(params.id, role));
route("POST", "/api/contracts/:id/paypal/authorize", async ({ params, role, body }) => ({ contract: view(await engine.authorizeOrder(params.id, role, String(body.orderId))) }));
route("POST", "/api/contracts/:id/milestones/:mid/evidence", async ({ params, role, body }) => ({ contract: view(await engine.submitEvidence(params.id, role, params.mid, body)) }));
route("POST", "/api/contracts/:id/milestones/:mid/review", async ({ params, role, body }) => ({ contract: view(await engine.review(params.id, role, params.mid, body.decision === "approve" ? "approve" : "reject", body.note)) }));
route("POST", "/api/contracts/:id/milestones/:mid/dispute", async ({ params, role, body }) => ({ contract: view(await engine.openDispute(params.id, role, params.mid, String(body.reason ?? ""))) }));
route("POST", "/api/contracts/:id/milestones/:mid/statement", async ({ params, role, body }) => ({ contract: view(await engine.addStatement(params.id, role, params.mid, String(body.text ?? ""))) }));
route("POST", "/api/contracts/:id/milestones/:mid/resolve", async ({ params, role }) => ({ contract: view(await engine.resolveDispute(params.id, role, params.mid)) }));
route("POST", "/api/contracts/:id/milestones/:mid/reclaim", async ({ params, role }) => ({ contract: view(await engine.reclaim(params.id, role, params.mid)) }));
route("POST", "/api/contracts/:id/milestones/:mid/retry-payout", async ({ params, role }) => ({ contract: view(await engine.retryPayout(params.id, role, params.mid)) }));
route("POST", "/api/contracts/:id/cancel", async ({ params, role }) => ({ contract: view(await engine.cancel(params.id, role)) }));

route("POST", "/api/paypal/webhook", async ({ req, body }) => {
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  const verified = paypalLive() && (await paypal().verifyWebhook(headers, body).catch(() => false));
  if (!verified) throw new HttpError(401, "Webhook signature could not be verified.");
  return { handled: await engine.handleWebhook(body) };
});

// Server-sent events: both parties' screens update the moment money moves.
function stream(req: IncomingMessage, res: ServerResponse, id: string) {
  const c = store.get(id);
  const url = new URL(req.url ?? "/", "http://x");
  const key = url.searchParams.get("k") ?? "";
  if (!c || (key !== c.tokens.payer && key !== c.tokens.payee)) return send(res, 403, { error: "Not allowed." });
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write(`retry: 3000\n\n`);
  const unsub = store.subscribe(id, (fresh) => res.write(`data: ${JSON.stringify(view(fresh))}\n\n`));
  const ping = setInterval(() => res.write(`: ping\n\n`), 20000);
  req.on("close", () => {
    unsub();
    clearInterval(ping);
  });
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
  let base = PUBLIC_DIR;
  let rel = pathname;
  if (pathname.startsWith("/uploads/")) {
    base = store.uploadsDir;
    rel = pathname.slice("/uploads".length);
  }
  const file = normalize(join(base, decodeURIComponent(rel)));
  if (!file.startsWith(base)) return send(res, 400, { error: "Bad path" });
  try {
    const s = await stat(file);
    if (s.isFile()) {
      const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
      const headers: Record<string, string> = { "Content-Type": type, "Cache-Control": pathname.startsWith("/dist/") ? "public, max-age=300" : "no-cache" };
      if (base === store.uploadsDir) {
        headers["Content-Security-Policy"] = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
        headers["X-Content-Type-Options"] = "nosniff";
      }
      res.writeHead(200, headers);
      return res.end(await readFile(file));
    }
  } catch {
    /* fall through */
  }
  if (pathname.startsWith("/uploads/") || extname(pathname)) return send(res, 404, { error: "Not found" });
  // SPA fallback
  res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" });
  res.end(await readFile(join(PUBLIC_DIR, "index.html")));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";
  try {
    const sse = url.pathname.match(/^\/api\/contracts\/([^/]+)\/stream$/);
    if (sse && method === "GET") return stream(req, res, sse[1]);

    if (url.pathname.startsWith("/api/")) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = url.pathname.match(r.pattern);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const body = method === "POST" ? await readBody(req) : {};
        const contract = params.id ? store.get(params.id) : undefined;
        const out = await r.handler({ req, res, params, body, role: roleFor(contract, req), contract });
        return send(res, 200, out);
      }
      return send(res, 404, { error: "No such endpoint." });
    }
    if (method !== "GET" && method !== "HEAD") return send(res, 405, { error: "Method not allowed" });
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    if (e instanceof PayPalError) return send(res, 502, { error: `PayPal: ${e.message}`, debugId: e.debugId });
    console.error(e);
    return send(res, 500, { error: e instanceof Error ? e.message : "Something went wrong." });
  }
});

server.listen(config.port, () => {
  console.log(`\n  Covenant running at http://localhost:${config.port}`);
  console.log(`  PayPal: ${paypalLive() ? `sandbox (${config.paypal.base})` : "SIMULATED — set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET for the real sandbox"}`);
  console.log(`  AI:     ${claudeLive() ? `Claude (${config.ai.model})` : "offline rules — set ANTHROPIC_API_KEY to use Claude"}\n`);
});
