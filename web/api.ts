import type { Contract, PublicConfig, Role } from "../shared/types.ts";

export type ContractView = Omit<Contract, "access"> & { access: { joined: boolean; inviteOutstanding: boolean } };
type Keys = Partial<Record<Role | "invite", string>>;

const STORE = "covenant.keys.v1";

export const keyring = {
  all(): Record<string, Keys> {
    try {
      return JSON.parse(localStorage.getItem(STORE) || "{}");
    } catch {
      return {};
    }
  },
  get(id: string): Keys {
    return this.all()[id] ?? {};
  },
  set(id: string, role: Role | "invite", key: string) {
    const all = this.all();
    all[id] = { ...(all[id] ?? {}), [role]: key };
    try {
      localStorage.setItem(STORE, JSON.stringify(all));
    } catch {
      /* private mode: keys live for this tab only */
    }
  },
  ids(): string[] {
    return Object.keys(this.all());
  },
};

export class ApiError extends Error {}

async function req<T>(method: string, path: string, key?: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "x-covenant-key": key } : {}),
      ...(method === "POST" ? { "Idempotency-Key": idempotencyKey ?? crypto.randomUUID() } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.error || `Request failed (${res.status})`);
  return json as T;
}

export const api = {
  config: () => req<PublicConfig>("GET", "/api/config"),
  compile: (text: string) => req<{ contract: ContractView; payerKey: string; inviteCode: string }>("POST", "/api/compile", undefined, { text }),
  join: (id: string, code: string) => req<{ contract: ContractView; payeeKey: string }>("POST", `/api/contracts/${id}/join`, undefined, { code }),
  invite: (id: string, key: string) => req<{ contract: ContractView; inviteCode: string }>("POST", `/api/contracts/${id}/invite`, key, {}),
  ticket: (id: string, key: string) => req<{ ticket: string }>("POST", `/api/contracts/${id}/stream-ticket`, key, {}),
  status: () => req<Record<string, any>>("GET", "/api/status"),
  get: (id: string, key: string) => req<{ contract: ContractView; role: Role }>("GET", `/api/contracts/${id}`, key),
  /** Money-moving actions pass a stable idempotency key so a retry can never act twice. */
  act: (id: string, key: string, path: string, body: unknown = {}, idempotencyKey?: string) =>
    req<{ contract: ContractView }>("POST", `/api/contracts/${id}${path}`, key, body, idempotencyKey).then((r) => r.contract),
  order: (id: string, key: string) => req<{ orderId: string }>("POST", `/api/contracts/${id}/paypal/order`, key, {}),
};

export const inviteLink = (id: string, code: string) => `${location.origin}/join/${id}#${code}`;

export const money = (cents: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);

export const when = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

export const day = (iso: string, utc = false) =>
  new Date(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric", ...(utc ? { timeZone: "UTC" } : {}) });

export function readFile(f: File): Promise<{ name: string; mime: string; dataBase64: string }> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: f.name, mime: f.type, dataBase64: String(r.result) });
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

export function loadScript(src: string, attrs: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`) as HTMLScriptElement | null;
    if (existing) {
      if (existing.dataset.loaded) return resolve();
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error(`Couldn't load ${src}`)));
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    Object.entries(attrs).forEach(([k, v]) => s.setAttribute(k, v));
    s.onload = () => {
      s.dataset.loaded = "1";
      resolve();
    };
    s.onerror = () => reject(new Error(`Couldn't load ${src}`));
    document.head.appendChild(s);
  });
}
