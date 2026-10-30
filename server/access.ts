// Access control for two-party contracts, without accounts.
//
// - The client receives a secret key when they create a contract.
// - The freelancer receives a one-time invite. Claiming it issues the freelancer's own key and
//   burns the invite, so the client can never act as the freelancer (and vice versa).
// - Only SHA-256 hashes of keys and invites are stored; a database leak exposes no usable secret.
// - Comparisons are constant-time.
// - Live-update streams use short-lived signed tickets, so keys never appear in URLs or logs.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import type { Contract, Role } from "../shared/types.ts";

export const newSecret = (bytes = 24) => randomBytes(bytes).toString("base64url");
export const hashSecret = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function sameHash(a: string | undefined, b: string) {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** Which side of the contract a presented key belongs to, if any. */
export function roleForKey(c: Contract | undefined, key: string | undefined | null): Role | null {
  if (!c || !key || key.length < 16 || key.length > 128) return null;
  const h = hashSecret(key);
  if (sameHash(c.access.payerHash, h)) return "payer";
  if (sameHash(c.access.payeeHash, h)) return "payee";
  return null;
}

export function inviteMatches(c: Contract, code: string) {
  return Boolean(code) && sameHash(c.access.inviteHash, hashSecret(code));
}

// ---- server secret for signing stream tickets
function serverSecret(): string {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = join(config.dataDir, ".session-secret");
  if (existsSync(f)) return readFileSync(f, "utf8").trim();
  const s = newSecret(32);
  writeFileSync(f, s, { mode: 0o600 });
  return s;
}
let secret: string | undefined;
const sign = (payload: string) => createHmac("sha256", (secret ??= serverSecret())).update(payload).digest("base64url");

/** A ticket lets one browser open the live-update stream for one contract for 2 minutes. */
export function issueStreamTicket(contractId: string, role: Role) {
  const payload = `${contractId}.${role}.${Date.now() + 120_000}`;
  return `${Buffer.from(payload).toString("base64url")}.${sign(payload)}`;
}

export function verifyStreamTicket(ticket: string, contractId: string): Role | null {
  const [p, sig] = ticket.split(".");
  if (!p || !sig) return null;
  const payload = Buffer.from(p, "base64url").toString("utf8");
  const expected = sign(payload);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const [id, role, exp] = payload.split(".");
  if (id !== contractId || Number(exp) < Date.now() || (role !== "payer" && role !== "payee")) return null;
  return role;
}
