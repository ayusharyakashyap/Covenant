// Deterministic money math. The AI interprets; this code enforces.
import type { LatePenalty, Milestone } from "../shared/types.ts";

const DAY = 24 * 60 * 60 * 1000;

export const toCents = (dollars: number) => Math.round(dollars * 100);
export const fromCents = (cents: number) => (cents / 100).toFixed(2);
export const fmt = (cents: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);

/** Whole days late, rounding any partial day up. 0 if on time or no deadline. */
export function daysLate(deadline: string | undefined, deliveredAt: string): number {
  if (!deadline) return 0;
  const diff = new Date(deliveredAt).getTime() - new Date(deadline).getTime();
  return diff <= 0 ? 0 : Math.ceil(diff / DAY);
}

export function penaltyPercent(p: LatePenalty | undefined, late: number): number {
  if (!p || late <= 0) return 0;
  return Math.min(p.maxPercent, p.percentPerDay * late);
}

export interface SettlementMath {
  grossCents: number;
  daysLate: number;
  penaltyCents: number;
  arbiterAdjustCents: number;
  netCents: number;
}

/**
 * Compute what the payee receives for a milestone.
 * @param payeePercent share awarded by the arbiter (100 when no dispute)
 */
export function settle(m: Milestone, deliveredAt: string, payeePercent = 100): SettlementMath {
  const grossCents = m.amountCents;
  const late = daysLate(m.deadline, deliveredAt);
  const penaltyCents = Math.round((grossCents * penaltyPercent(m.latePenalty, late)) / 100);
  const afterPenalty = grossCents - penaltyCents;
  const awarded = Math.round((afterPenalty * Math.max(0, Math.min(100, payeePercent))) / 100);
  return {
    grossCents,
    daysLate: late,
    penaltyCents,
    arbiterAdjustCents: afterPenalty - awarded,
    netCents: awarded,
  };
}

/** Split an amount into a platform fee and the payee's payout. */
export function feeSplit(netCents: number, feePercent: number) {
  const fee = Math.round((netCents * Math.max(0, feePercent)) / 100);
  return { feeCents: fee, payoutCents: netCents - fee };
}

/** Repair rounding so milestone amounts sum exactly to the total. */
export function reconcile(totalCents: number, amounts: number[]): number[] {
  const sum = amounts.reduce((a, b) => a + b, 0);
  if (sum === totalCents || amounts.length === 0) return amounts;
  const out = [...amounts];
  out[out.length - 1] += totalCents - sum;
  return out;
}
