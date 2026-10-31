// Starts the real server and checks the HTTP-level guarantees: headers, CSRF guard,
// access control, idempotency, stream tickets, rate limits, health checks.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 18000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
let proc: ChildProcess;

before(async () => {
  proc = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: mkdtempSync(join(tmpdir(), "covenant-http-")), PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", ANTHROPIC_API_KEY: "", KERNEL_API_KEY: "", LOG_LEVEL: "silent", DEMO_TOOLS: "" },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
});
after(() => proc?.kill("SIGTERM"));

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

test("health and readiness", async () => {
  assert.equal((await fetch(`${BASE}/healthz`)).status, 200);
  const r = await (await fetch(`${BASE}/readyz`)).json();
  assert.equal(r.ready, true);
});

test("security headers on pages and API", async () => {
  const page = await fetch(`${BASE}/`);
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  const api = await fetch(`${BASE}/api/config`);
  assert.equal(api.headers.get("x-content-type-options"), "nosniff");
  assert.ok(api.headers.get("x-request-id"));
});

test("state-changing requests must be JSON (CSRF guard)", async () => {
  const r = await fetch(`${BASE}/api/compile`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "text=Pay+Bo+%2450" });
  assert.equal(r.status, 415);
});

let contractId = "";
let payerKey = "";
let inviteCode = "";

test("access control: client key, one-time invite, no key leaks", async () => {
  const r = await (await post("/api/compile", { text: "Pay Maya $600 for a logo: $200 when she shows 3 concepts, $400 when final SVG and PNG files arrive." })).json();
  ({ payerKey, inviteCode } = r);
  contractId = r.contract.id;
  assert.ok(payerKey && inviteCode);
  assert.equal(JSON.stringify(r.contract).includes("Hash"), false, "no key hashes in responses");

  assert.equal((await fetch(`${BASE}/api/contracts/${contractId}`)).status, 403);
  assert.equal((await fetch(`${BASE}/api/contracts/${contractId}`, { headers: { "x-covenant-key": "x".repeat(32) } })).status, 403);
  const mine = await (await fetch(`${BASE}/api/contracts/${contractId}`, { headers: { "x-covenant-key": payerKey } })).json();
  assert.equal(mine.role, "payer");

  const j = await (await post(`/api/contracts/${contractId}/join`, { code: inviteCode })).json();
  assert.ok(j.payeeKey);
  assert.equal((await post(`/api/contracts/${contractId}/join`, { code: inviteCode })).status, 410);
  const theirs = await (await fetch(`${BASE}/api/contracts/${contractId}`, { headers: { "x-covenant-key": j.payeeKey } })).json();
  assert.equal(theirs.role, "payee");
});

test("idempotency keys replay instead of acting twice", async () => {
  const h = { "x-covenant-key": payerKey, "Idempotency-Key": "sign-once-123" };
  const a = await post(`/api/contracts/${contractId}/sign`, {}, h);
  assert.equal(a.status, 200);
  const b = await post(`/api/contracts/${contractId}/sign`, {}, h);
  assert.equal(b.status, 200, "a replay returns the stored result, not 'already signed'");
  assert.equal(b.headers.get("idempotent-replay"), "true");
  const c = await post(`/api/contracts/${contractId}/sign`, {}, { "x-covenant-key": payerKey, "Idempotency-Key": "a-different-key" });
  assert.equal(c.status, 409, "a genuinely new request is still validated");
});

test("live updates need a signed ticket, not a key in the URL", async () => {
  assert.equal((await fetch(`${BASE}/api/contracts/${contractId}/stream?ticket=forged.ticket`)).status, 403);
  const { ticket } = await (await post(`/api/contracts/${contractId}/stream-ticket`, {}, { "x-covenant-key": payerKey })).json();
  const ctrl = new AbortController();
  const s = await fetch(`${BASE}/api/contracts/${contractId}/stream?ticket=${encodeURIComponent(ticket)}`, { signal: ctrl.signal });
  assert.equal(s.status, 200);
  assert.match(s.headers.get("content-type") ?? "", /event-stream/);
  ctrl.abort();
  const other = await (await post("/api/compile", { text: "Pay Lee $50 when the essay is proofread." })).json();
  assert.equal((await fetch(`${BASE}/api/contracts/${other.contract.id}/stream?ticket=${encodeURIComponent(ticket)}`)).status, 403, "tickets are bound to one contract");
});

test("demo tools are off unless enabled", async () => {
  assert.equal((await post("/api/demo/seed", {})).status, 404);
});

test("uploads directory can't be escaped", async () => {
  const r = await fetch(`${BASE}/uploads/..%2f..%2fcovenant.db`);
  assert.ok([400, 404].includes(r.status));
});

test("AI endpoints are rate limited", async () => {
  let limited = false;
  for (let i = 0; i < 20 && !limited; i++) {
    const r = await post("/api/portfolio/ask", { question: "what is held?", pairs: [] });
    if (r.status === 429) {
      limited = true;
      assert.ok(r.headers.get("retry-after"));
    }
  }
  assert.ok(limited, "expected a 429 after a burst");
});

test("vendor route only serves browser assets of allowed packages", async () => {
  assert.equal((await fetch(`${BASE}/vendor/ag-studio/package.json`)).status, 404);
  assert.equal((await fetch(`${BASE}/vendor/ag-studio/..%2f..%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${BASE}/vendor/react/index.js`)).status, 404);
  assert.equal((await fetch(`${BASE}/vendor/tsx/dist/cli.mjs`)).status, 404);
});
