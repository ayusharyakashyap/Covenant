// Checks your keys before you record the demo: PayPal sandbox OAuth + order creation, Payouts access, and a structured AI call (Gemini or Claude).
// Run: npm run smoke
import { config, paypalLive, aiLive, aiName } from "../server/config.ts";
import { callTool } from "../server/ai/llm.ts";

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
    // Payouts are paid from the business account's balance in the contract currency.
    const b = await fetch(`${config.paypal.base}/v1/reporting/balances?currency_code=ALL`, { headers: { Authorization: `Bearer ${access_token}` } });
    if (b.ok) {
      const bj = (await b.json()) as { balances?: { currency: string; total_balance?: { value: string }; available_balance?: { value: string } }[] };
      const rows = (bj.balances ?? []).map((x) => `${x.currency} ${x.available_balance?.value ?? x.total_balance?.value ?? "?"}`);
      const cur = (bj.balances ?? []).find((x) => x.currency === config.paypal.currency);
      const avail = Number(cur?.available_balance?.value ?? cur?.total_balance?.value ?? 0);
      avail > 0
        ? ok(`Business account balance: ${rows.join(", ")} (payouts draw from ${config.paypal.currency})`)
        : bad(`Business account has no available ${config.paypal.currency} to pay out (balances: ${rows.join(", ") || "none"}). Add ${config.paypal.currency} funds to the sandbox Business account, or set CURRENCY to a currency it holds`);
    } else {
      console.log(`  · Couldn't read the business balance (HTTP ${b.status}); payouts need ${config.paypal.currency} funds in the sandbox Business account`);
    }
    config.paypal.webhookId ? ok("PAYPAL_WEBHOOK_ID set") : console.log("  · PAYPAL_WEBHOOK_ID not set (optional; payouts are also polled)");
  } catch (e) {
    bad(`PayPal: ${e instanceof Error ? e.message : e}`);
    failed++;
  }
}

console.log(`\nAI (${aiName()})`);
if (!aiLive()) {
  bad("No AI key set. Add GEMINI_API_KEY (free at aistudio.google.com) or ANTHROPIC_API_KEY; until then the rules engine is used");
} else {
  // The same kind of structured call the verifier makes: forced tool call, read back the JSON.
  try {
    const { input, model } = await callTool<{ status: string; total: number }>({
      system: "You check arithmetic.",
      content: [{ type: "text", text: "Add 200 and 400. Set status to ready." }],
      tool: {
        name: "report",
        description: "Report the result.",
        input_schema: { type: "object", required: ["status", "total"], properties: { status: { type: "string" }, total: { type: "number" } } },
      },
      maxTokens: 200,
    });
    Number(input.total) === 600 ? ok(`${model} returned structured output (total ${input.total})`) : (bad(`${model} answered, but got total ${input.total}`), failed++);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    bad(`${aiName()}: ${msg}`);
    failed++;
    if (config.ai.provider === "gemini" && /not found|not supported|404/i.test(msg)) {
      try {
        const r = await fetch(`${config.ai.base}/v1beta/models?pageSize=200`, { headers: { "x-goog-api-key": config.ai.apiKey } });
        const j = (await r.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
        const names = (j.models ?? []).filter((m) => m.supportedGenerationMethods?.includes("generateContent") && /flash/.test(m.name)).map((m) => m.name.replace("models/", ""));
        if (names.length) console.log(`    Models your key can use: ${names.join(", ")}\n    Set GEMINI_MODEL in .env to one of these.`);
      } catch {
        /* ignore */
      }
    }
  }
}
console.log("");
process.exit(failed ? 1 : 0);
