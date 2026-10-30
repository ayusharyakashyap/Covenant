import { randomBytes } from "node:crypto";

/** URL-safe random id using Node's built-in crypto (no dependency). */
export function nanoid(size = 21): string {
  return randomBytes(Math.ceil((size * 3) / 4) + 1).toString("base64url").slice(0, size);
}
