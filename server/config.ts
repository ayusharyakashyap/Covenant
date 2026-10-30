import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

// Minimal .env loader so the project needs no dotenv dependency.
function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(resolve(process.cwd(), ".env"));

const env = (k: string, d = "") => (process.env[k] ?? d).trim();

export const config = {
  port: Number(env("PORT", "8787")),
  publicUrl: env("PUBLIC_URL", ""),
  dataDir: resolve(process.cwd(), env("DATA_DIR", "data")),
  paypal: {
    clientId: env("PAYPAL_CLIENT_ID"),
    clientSecret: env("PAYPAL_CLIENT_SECRET"),
    webhookId: env("PAYPAL_WEBHOOK_ID"),
    base: env("PAYPAL_API_BASE", "https://api-m.sandbox.paypal.com"),
    currency: env("CURRENCY", "USD"),
    platformFeePercent: Number(env("PLATFORM_FEE_PERCENT", "0")),
  },
  ai: {
    apiKey: env("ANTHROPIC_API_KEY"),
    model: env("ANTHROPIC_MODEL", "claude-sonnet-5-5"),
    base: env("ANTHROPIC_API_BASE", "https://api.anthropic.com"),
  },
  autoReleaseThreshold: Number(env("AUTO_RELEASE_THRESHOLD", "0.8")),
  agStudioLicense: env("AG_STUDIO_LICENSE"),
};

// Sample data is generated with the simulator and rules engine, never real sandbox money or API credits.
export const simulation = new AsyncLocalStorage<boolean>();
const simulated = () => simulation.getStore() === true;

export const paypalLive = () => !simulated() && Boolean(config.paypal.clientId && config.paypal.clientSecret);
// If the key stops working (expired, out of credit, outage), fall back to the offline engine
// for a while instead of failing requests. Cleared automatically after the cool-down.
export const aiHealth = { degradedUntil: 0, reason: "" };
export function markClaudeDegraded(reason: string, ms = 10 * 60 * 1000) {
  aiHealth.degradedUntil = Date.now() + ms;
  aiHealth.reason = reason;
  console.warn(`[ai] Claude unavailable (${reason}); using the offline engine for ${Math.round(ms / 60000)} min`);
}
export const claudeConfigured = () => Boolean(config.ai.apiKey);
export const claudeLive = () => !simulated() && claudeConfigured() && Date.now() > aiHealth.degradedUntil;
