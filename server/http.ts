// HTTP plumbing: security headers, rate limiting, client IPs, request bodies.
import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  constructor(public status: number, message: string, public headers: Record<string, string> = {}) {
    super(message);
  }
}

// ---- security headers
const CSP = [
  "default-src 'self'",
  // PayPal JS SDK + the CDNs serving AG Grid, AG Studio and Bryntum
  "script-src 'self' https://www.paypal.com https://www.sandbox.paypal.com https://*.paypal.com https://*.paypalobjects.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
  "font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net",
  "img-src 'self' data: blob: https://*.paypal.com https://*.paypalobjects.com",
  "connect-src 'self' https://*.paypal.com https://cdn.jsdelivr.net",
  "frame-src https://*.paypal.com",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

export function securityHeaders(req: IncomingMessage, isHtml: boolean): Record<string, string> {
  const h: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer", // invite codes live in URL fragments; never leak paths either
    "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups", // PayPal approval opens a popup
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(self \"https://www.paypal.com\" \"https://www.sandbox.paypal.com\")",
  };
  if (isHtml) h["Content-Security-Policy"] = CSP;
  if (isHttps(req)) h["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  return h;
}

const trustProxy = () => process.env.TRUST_PROXY === "1" || Boolean(process.env.RENDER);
const isHttps = (req: IncomingMessage) => (trustProxy() ? String(req.headers["x-forwarded-proto"] ?? "").startsWith("https") : false);

/** Client IP; only trusts X-Forwarded-For behind a known proxy/load balancer. */
export function clientIp(req: IncomingMessage) {
  if (trustProxy()) {
    const xff = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress ?? "unknown";
}

// ---- rate limiting (token bucket per client + route class)
// In-process; for several instances behind a load balancer, back this with Redis (see ARCHITECTURE.md).
type Bucket = { tokens: number; at: number };
const buckets = new Map<string, Bucket>();
export const LIMITS = {
  ai: { capacity: 12, perMinute: 6 }, // compile + ask: each call costs money
  evidence: { capacity: 20, perMinute: 6 },
  join: { capacity: 10, perMinute: 2 }, // slows invite guessing
  write: { capacity: 120, perMinute: 60 },
  read: { capacity: 600, perMinute: 300 },
} as const;

export function rateLimit(ip: string, cls: keyof typeof LIMITS) {
  if (process.env.RATE_LIMIT === "off") return;
  const { capacity, perMinute } = LIMITS[cls];
  const key = `${cls}:${ip}`;
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: capacity, at: now };
  b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 60_000) * perMinute);
  b.at = now;
  if (b.tokens < 1) {
    const wait = Math.ceil(((1 - b.tokens) / perMinute) * 60);
    buckets.set(key, b);
    throw new HttpError(429, `Too many requests. Try again in ${wait} seconds.`, { "Retry-After": String(wait) });
  }
  b.tokens -= 1;
  buckets.set(key, b);
}
setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, b] of buckets) if (b.at < cutoff) buckets.delete(k);
}, 60_000).unref();

// ---- bodies
export async function readJson(req: IncomingMessage, limit: number): Promise<any> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > limit) throw new HttpError(413, `Request is too large (max ${Math.round(limit / 1024 / 1024) || 1} MB).`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, `Request is too large (max ${Math.round(limit / 1024 / 1024) || 1} MB).`);
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}
