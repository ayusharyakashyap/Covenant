// Checks your keys before you record the demo: PayPal sandbox OAuth + order creation, Payouts access, and a Claude call.
// Run: npm run smoke
import { config, paypalLive, claudeLive } from "../server/config.ts";

const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s: string) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);
let failed = 0;

console.log("\nPayPal sandbox");
if (!paypalLive()) {
  bad("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set — the app will use the simulator");
} else {
  try {
    const auth = Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString("base64");
    const t = await fetch(`${config.paypal.base}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!t.ok) throw new Error(`OAuth ${t.status}`);
    const { access_token, scope } = (await t.json()) as { access_token: string; scope: string };
    ok("OAuth token issued");
    scope.includes("payouts") || scope.includes("/v1/payments/.*") ? ok("Payouts scope present") : bad("Payouts scope not found on this app — enable Payouts in the sandbox app settings");
    const o = await fetch(`${config.paypal.base}/v2/checkout/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "AUTHORIZE", purchase_units: [{ amount: { currency_code: config.paypal.currency, value: "1.00" } }] }),
    });
    const oj = (await o.json()) as { id?: string; message?: string };
    o.ok ? ok(`Orders v2 (AUTHORIZE) works — test order ${oj.id}`) : (bad(`Orders v2 failed: ${oj.message}`), failed++);
    config.paypal.webhookId ? ok("PAYPAL_WEBHOOK_ID set") : console.log("  · PAYPAL_WEBHOOK_ID not set (optional; payouts are also polled)");
  } catch (e) {
    bad(`PayPal: ${e instanceof Error ? e.message : e}`);
    failed++;
  }
}

console.log("\nClaude");
if (!claudeLive()) {
  bad("ANTHROPIC_API_KEY not set — the app will use the offline rules engine");
} else {
  try {
    const r = await fetch(`${config.ai.base}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": config.ai.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: config.ai.model, max_tokens: 16, messages: [{ role: "user", content: "Reply with the word ready." }] }),
    });
    const j = (await r.json()) as { model?: string; error?: { message: string } };
    r.ok ? ok(`${j.model} responded`) : (bad(`Claude: ${j.error?.message} (check ANTHROPIC_MODEL=${config.ai.model})`), failed++);
  } catch (e) {
    bad(`Claude: ${e instanceof Error ? e.message : e}`);
    failed++;
  }
}
console.log("");
process.exit(failed ? 1 : 0);
