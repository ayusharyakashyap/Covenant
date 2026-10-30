// PayPal REST client (sandbox). Uses fetch only — no SDK dependency.
// When no credentials are configured, a faithful simulator with the same interface is used
// so the app is fully explorable without keys. Every simulated ledger entry is labelled.
import { randomUUID } from "node:crypto";
import { config, paypalLive } from "./config.ts";
import { fromCents } from "./money.ts";

export class PayPalError extends Error {
  constructor(message: string, public status: number, public debugId?: string, public details?: unknown) {
    super(message);
  }
}

interface Token { value: string; expiresAt: number }
let token: Token | null = null;

async function accessToken(): Promise<string> {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  const auth = Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString("base64");
  const res = await fetch(`${config.paypal.base}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new PayPalError(`PayPal auth failed (${res.status}). Check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET.`, res.status);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return token.value;
}

async function call<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await accessToken()}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
  if (idempotencyKey) headers["PayPal-Request-Id"] = idempotencyKey;
  const res = await fetch(`${config.paypal.base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return {} as T;
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const detail = json?.details?.[0];
    const msg = detail?.description || json?.message || `PayPal ${method} ${path} failed`;
    throw new PayPalError(`${msg}${detail?.issue ? ` (${detail.issue})` : ""}`, res.status, json?.debug_id, json?.details);
  }
  return json as T;
}

const money = (cents: number) => ({ currency_code: config.paypal.currency, value: fromCents(cents) });

export interface OrderLine { name: string; cents: number }
export interface AuthorizationResult {
  authorizationId: string;
  status: string;
  amountCents: number;
  expiresAt?: string;
  payerEmail?: string;
}
export interface CaptureResult { captureId: string; status: string }
export interface PayoutResult { batchId: string; status: string }

export interface PayPalClient {
  live: boolean;
  createOrder(contractId: string, description: string, totalCents: number, lines: OrderLine[]): Promise<{ orderId: string; approveUrl?: string }>;
  authorizeOrder(orderId: string): Promise<AuthorizationResult>;
  capture(authorizationId: string, cents: number, finalCapture: boolean, invoiceId: string, note: string): Promise<CaptureResult>;
  voidAuthorization(authorizationId: string): Promise<void>;
  reauthorize(authorizationId: string, cents: number): Promise<{ authorizationId: string; status: string }>;
  refund(captureId: string, cents: number, note: string): Promise<{ refundId: string; status: string }>;
  payout(receiverEmail: string, cents: number, note: string, senderItemId: string): Promise<PayoutResult>;
  payoutStatus(batchId: string): Promise<string>;
  verifyWebhook(headers: Record<string, string | undefined>, event: unknown): Promise<boolean>;
}

const live: PayPalClient = {
  live: true,
  async createOrder(contractId, description, totalCents, lines) {
    const order = await call<{ id: string; links: { rel: string; href: string }[] }>(
      "POST",
      "/v2/checkout/orders",
      {
        intent: "AUTHORIZE",
        purchase_units: [
          {
            reference_id: contractId,
            custom_id: contractId,
            description: description.slice(0, 127),
            amount: { ...money(totalCents), breakdown: { item_total: money(totalCents) } },
            items: lines.map((l) => ({
              name: l.name.slice(0, 127),
              quantity: "1",
              unit_amount: money(l.cents),
              category: "DIGITAL_GOODS",
            })),
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: "Covenant",
              shipping_preference: "NO_SHIPPING",
              user_action: "CONTINUE",
            },
          },
        },
      },
      `order-${contractId}-${randomUUID()}`,
    );
    return { orderId: order.id, approveUrl: order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href };
  },

  async authorizeOrder(orderId) {
    type R = {
      payer?: { email_address?: string };
      purchase_units: { payments: { authorizations: { id: string; status: string; amount: { value: string }; expiration_time?: string }[] } }[];
    };
    const r = await call<R>("POST", `/v2/checkout/orders/${orderId}/authorize`, {}, `auth-${orderId}`);
    const a = r.purchase_units[0].payments.authorizations[0];
    return {
      authorizationId: a.id,
      status: a.status,
      amountCents: Math.round(Number(a.amount.value) * 100),
      expiresAt: a.expiration_time,
      payerEmail: r.payer?.email_address,
    };
  },

  async capture(authorizationId, cents, finalCapture, invoiceId, note) {
    const r = await call<{ id: string; status: string }>(
      "POST",
      `/v2/payments/authorizations/${authorizationId}/capture`,
      { amount: money(cents), final_capture: finalCapture, invoice_id: invoiceId, note_to_payer: note.slice(0, 255) },
      `cap-${invoiceId}`,
    );
    return { captureId: r.id, status: r.status };
  },

  async voidAuthorization(authorizationId) {
    await call("POST", `/v2/payments/authorizations/${authorizationId}/void`, undefined, `void-${authorizationId}`);
  },

  async reauthorize(authorizationId, cents) {
    const r = await call<{ id: string; status: string }>(
      "POST",
      `/v2/payments/authorizations/${authorizationId}/reauthorize`,
      { amount: money(cents) },
      `reauth-${authorizationId}-${Date.now()}`,
    );
    return { authorizationId: r.id, status: r.status };
  },

  async refund(captureId, cents, note) {
    const r = await call<{ id: string; status: string }>(
      "POST",
      `/v2/payments/captures/${captureId}/refund`,
      { amount: money(cents), note_to_payer: note.slice(0, 255) },
      `refund-${captureId}-${cents}`,
    );
    return { refundId: r.id, status: r.status };
  },

  async payout(receiverEmail, cents, note, senderItemId) {
    const r = await call<{ batch_header: { payout_batch_id: string; batch_status: string } }>("POST", "/v1/payments/payouts", {
      sender_batch_header: {
        sender_batch_id: `cov-${senderItemId}`,
        email_subject: "You've been paid through Covenant",
        email_message: note.slice(0, 1000),
      },
      items: [
        {
          recipient_type: "EMAIL",
          receiver: receiverEmail,
          amount: { value: fromCents(cents), currency: config.paypal.currency },
          note: note.slice(0, 4000),
          sender_item_id: senderItemId,
        },
      ],
    });
    return { batchId: r.batch_header.payout_batch_id, status: r.batch_header.batch_status };
  },

  async payoutStatus(batchId) {
    const r = await call<{ batch_header: { batch_status: string } }>("GET", `/v1/payments/payouts/${batchId}`);
    return r.batch_header.batch_status;
  },

  async verifyWebhook(h, event) {
    if (!config.paypal.webhookId) return false;
    const r = await call<{ verification_status: string }>("POST", "/v1/notifications/verify-webhook-signature", {
      auth_algo: h["paypal-auth-algo"],
      cert_url: h["paypal-cert-url"],
      transmission_id: h["paypal-transmission-id"],
      transmission_sig: h["paypal-transmission-sig"],
      transmission_time: h["paypal-transmission-time"],
      webhook_id: config.paypal.webhookId,
      webhook_event: event,
    });
    return r.verification_status === "SUCCESS";
  },
};

// ---- Simulator ---------------------------------------------------------------
const simId = (prefix: string) => `SIM-${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;
const simAuths = new Map<string, { cents: number; captured: number; final: boolean; voided: boolean }>();
const simOrders = new Map<string, number>();

const simulated: PayPalClient = {
  live: false,
  async createOrder(_c, _d, totalCents) {
    const id = simId("ORDER");
    simOrders.set(id, totalCents);
    return { orderId: id };
  },
  async authorizeOrder(orderId) {
    const cents = simOrders.get(orderId) ?? 0;
    const id = simId("AUTH");
    simAuths.set(id, { cents, captured: 0, final: false, voided: false });
    return {
      authorizationId: id,
      status: "CREATED",
      amountCents: cents,
      expiresAt: new Date(Date.now() + 29 * 864e5).toISOString(),
      payerEmail: "sandbox-buyer@example.com",
    };
  },
  async capture(authorizationId, cents, finalCapture) {
    const a = simAuths.get(authorizationId);
    if (a) {
      if (a.voided || a.final) throw new PayPalError("Authorization is no longer capturable (AUTHORIZATION_VOIDED)", 422);
      if (a.captured + cents > a.cents) throw new PayPalError("Capture exceeds authorized amount (MAX_CAPTURE_AMOUNT_EXCEEDED)", 422);
      a.captured += cents;
      a.final = finalCapture;
    }
    return { captureId: simId("CAP"), status: "COMPLETED" };
  },
  async voidAuthorization(authorizationId) {
    const a = simAuths.get(authorizationId);
    if (a) a.voided = true;
  },
  async reauthorize(authorizationId) {
    return { authorizationId, status: "CREATED" };
  },
  async refund() {
    return { refundId: simId("REFUND"), status: "COMPLETED" };
  },
  async payout() {
    return { batchId: simId("PAYOUT"), status: "PENDING" };
  },
  async payoutStatus() {
    return "SUCCESS";
  },
  async verifyWebhook() {
    return false;
  },
};

export const paypal = (): PayPalClient => (paypalLive() ? live : simulated);
