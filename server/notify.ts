// Outbound webhooks for Zapier, Make, Slack workflows, or your own backend.
// Set NOTIFY_WEBHOOK_URL to a Zapier "Catch Hook" URL to get an email, Slack message or
// spreadsheet row whenever money moves or a human decision is needed.
import { simulation } from "./config.ts";
import type { Contract } from "../shared/types.ts";

const NOTIFY = new Set(["ready_to_fund", "authorized", "verified", "needs_review", "rejected", "injection_blocked", "paid", "penalty", "dispute_opened", "ruling", "reclaimed", "completed", "cancelled", "payout_failed"]);

export function notify(c: Contract, type: string, message: string, milestoneId?: string) {
  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (!url || !NOTIFY.has(type) || simulation.getStore()) return;
  const m = c.milestones.find((x) => x.id === milestoneId);
  const body = {
    event: type,
    message,
    at: new Date().toISOString(),
    contract: { id: c.id, title: c.title, status: c.status, total: c.totalCents / 100, currency: c.currency, payer: c.payer.name, payee: c.payee.name },
    milestone: m ? { id: m.id, title: m.title, amount: m.amountCents / 100, status: m.status, paid: (m.settlement?.netCents ?? 0) / 100 } : null,
    link: process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL.replace(/\/$/, "")}/c/${c.id}` : undefined,
  };
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch((e) =>
    console.warn(`[notify] webhook failed: ${e instanceof Error ? e.message : e}`),
  );
}
