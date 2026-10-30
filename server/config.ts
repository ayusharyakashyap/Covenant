import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

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
};

export const paypalLive = () => Boolean(config.paypal.clientId && config.paypal.clientSecret);
export const claudeLive = () => Boolean(config.ai.apiKey);
