import { test } from "node:test";
import assert from "node:assert/strict";
import { daysLate, penaltyPercent, settle, reconcile, feeSplit } from "./money.ts";
import type { Milestone } from "../shared/types.ts";

const ms = (over: Partial<Milestone> = {}): Milestone => ({
  id: "m", index: 0, title: "t", amountCents: 40000, conditions: [], status: "open", submissions: [], ...over,
});

test("on-time delivery pays in full", () => {
  const s = settle(ms({ deadline: "2026-11-20T23:59:59Z", latePenalty: { percentPerDay: 10, maxPercent: 50 } }), "2026-11-20T10:00:00Z");
  assert.deepEqual(s, { grossCents: 40000, daysLate: 0, penaltyCents: 0, arbiterAdjustCents: 0, netCents: 40000 });
});

test("partial days round up and penalties cap", () => {
  assert.equal(daysLate("2026-11-20T23:59:59Z", "2026-11-21T00:00:01Z"), 1);
  assert.equal(daysLate("2026-11-20T23:59:59Z", "2026-11-23T12:00:00Z"), 3);
  assert.equal(penaltyPercent({ percentPerDay: 10, maxPercent: 25 }, 3), 25);
  const s = settle(ms({ deadline: "2026-11-20T23:59:59Z", latePenalty: { percentPerDay: 10, maxPercent: 50 } }), "2026-11-22T09:00:00Z");
  assert.equal(s.penaltyCents, 8000);
  assert.equal(s.netCents, 32000);
});

test("arbiter split applies after penalty", () => {
  const s = settle(ms({ deadline: "2026-11-20T23:59:59Z", latePenalty: { percentPerDay: 10, maxPercent: 50 } }), "2026-11-21T09:00:00Z", 50);
  assert.equal(s.penaltyCents, 4000);
  assert.equal(s.netCents, 18000);
  assert.equal(s.arbiterAdjustCents, 18000);
  assert.equal(s.grossCents, s.netCents + s.penaltyCents + s.arbiterAdjustCents);
});

test("reconcile fixes rounding drift", () => {
  assert.deepEqual(reconcile(10000, [3333, 3333, 3333]), [3333, 3333, 3334]);
});

test("fee split never loses a cent", () => {
  const { feeCents, payoutCents } = feeSplit(12345, 2.5);
  assert.equal(feeCents + payoutCents, 12345);
});
