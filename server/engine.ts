// The contract state machine. Every money movement goes through here, in deterministic code.
import { nanoid } from "./id.ts";
import { config, aiName, simulation } from "./config.ts";
import { store, withLock as storeLock } from "./store.ts";
import { paypal, PayPalError } from "./paypal.ts";
import { compileDeal } from "./ai/compiler.ts";
import { verifyMilestone } from "./ai/verifier.ts";
import { arbitrate } from "./ai/arbiter.ts";
import { settle, feeSplit, reconcile, toCents, fmt } from "./money.ts";
import { notify } from "./notify.ts";
import { newSecret, hashSecret, inviteMatches } from "./access.ts";
import { enqueue, registerJob } from "./jobs.ts";
import { storeUpload, linkEvidence, textEvidence, type UploadInput } from "./evidence.ts";
import type { Actor, Contract, LedgerEntry, Milestone, Role, Party } from "../shared/types.ts";

// Sample contracts were funded by the PayPal simulator, so every later step on them (captures,
// payouts, verification) stays in test mode, whatever keys this server has.
function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  return storeLock(id, () => simulation.run(simulation.getStore() === true || store.get(id)?.funding?.simulated === true, fn));
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const now = () => new Date().toISOString();
const DAY = 864e5;

function event(c: Contract, actor: Actor, type: string, message: string, milestoneId?: string) {
  c.events.push({ id: `evt_${nanoid(8)}`, at: now(), actor, type, message, milestoneId });
  notify(c, type, message, milestoneId);
}

function ledger(c: Contract, e: Omit<LedgerEntry, "id" | "at" | "currency" | "simulated">) {
  c.ledger.push({ id: `led_${nanoid(8)}`, at: now(), currency: c.currency, simulated: !paypal().live, ...e });
}

function mustGet(id: string) {
  const c = store.get(id);
  if (!c) throw new HttpError(404, "No contract with that id.");
  return c;
}

function milestone(c: Contract, mid: string) {
  const m = c.milestones.find((x) => x.id === mid);
  if (!m) throw new HttpError(404, "No milestone with that id.");
  return m;
}

function requireRole(role: Role | null, ...allowed: Role[]): asserts role is Role {
  if (!role || !allowed.includes(role)) throw new HttpError(403, `Only the ${allowed.join(" or ")} can do that.`);
}

const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// ---------------------------------------------------------------- create & sign

export async function createContract(text: string, opts: { payer?: Partial<Party>; payee?: Partial<Party>; origin?: "web" | "mcp" } = {}) {
  if (!text || text.trim().length < 12) throw new HttpError(400, "Describe the deal in a sentence or two, including the amount.");
  if (text.length > 4000) throw new HttpError(400, "Keep the deal under 4,000 characters.");
  const { result: r, engine, model } = await compileDeal(text);
  if (!r.is_valid_agreement) throw new HttpError(422, r.rejection_reason || "That doesn't read like a payment agreement.");

  const amounts = reconcile(toCents(r.total), r.milestones.map((m) => toCents(m.amount)));
  const c: Contract = {
    id: `cov_${nanoid(10)}`,
    createdAt: now(),
    updatedAt: now(),
    title: r.title,
    sourceText: text.trim(),
    summary: r.summary,
    currency: (r.currency || "USD").toUpperCase() === config.paypal.currency ? config.paypal.currency : config.paypal.currency,
    totalCents: toCents(r.total),
    payer: { name: opts.payer?.name || r.payer.name || "Client", email: opts.payer?.email || r.payer.email || "" },
    payee: { name: opts.payee?.name || r.payee.name || "Freelancer", email: opts.payee?.email || r.payee.email || "" },
    milestones: r.milestones.map((m, i) => ({
      id: `ms_${nanoid(6)}`,
      index: i,
      title: m.title,
      amountCents: amounts[i],
      deadline: m.deadline ?? undefined,
      conditions: m.conditions.map((x) => ({ id: `cd_${nanoid(5)}`, text: x.text, kind: x.kind })),
      latePenalty: m.late_penalty ? { percentPerDay: m.late_penalty.percent_per_day, maxPercent: m.late_penalty.max_percent } : undefined,
      status: "open",
      submissions: [],
    })),
    ambiguities: r.ambiguities ?? [],
    risks: r.risks ?? [],
    status: "draft",
    signatures: {},
    events: [],
    ledger: [],
    compiledBy: { engine, model },
    autoReleaseThreshold: config.autoReleaseThreshold,
    access: { payerHash: "", inviteHash: "" },
    origin: opts.origin ?? "web",
  };
  if (validEmail(c.payee.email)) c.ambiguities = c.ambiguities.filter((a) => !/paypal email|email address|be paid at/i.test(a));
  if (r.currency && r.currency.toUpperCase() !== config.paypal.currency) {
    c.ambiguities.push(`The deal mentions ${r.currency}; this deployment settles in ${config.paypal.currency}.`);
  }
  const payerKey = newSecret();
  const inviteCode = newSecret();
  c.access = { payerHash: hashSecret(payerKey), inviteHash: hashSecret(inviteCode), inviteCreatedAt: now() };
  event(c, "ai", "compiled", `Compiled into ${c.milestones.length} milestone${c.milestones.length > 1 ? "s" : ""} worth ${fmt(c.totalCents, c.currency)}${engine !== "offline" ? ` by ${model}` : " by the offline rules engine"}.`);
  store.save(c);
  // Raw secrets are returned once, to the creator, and never stored.
  return { contract: c, payerKey, inviteCode };
}

/** The freelancer opens their invite: issue their own key and burn the invite. */
export function claimInvite(id: string, code: string) {
  return withLock(id, async () => {
    const c = mustGet(id);
    if (c.access.payeeHash && !c.access.inviteHash) throw new HttpError(410, `This invite has already been used. Ask ${c.payer.name} to send a new one if you need access.`);
    if (!inviteMatches(c, code)) throw new HttpError(403, "This invite link isn't valid. Ask for a new one.");
    const payeeKey = newSecret();
    c.access = { ...c.access, payeeHash: hashSecret(payeeKey), inviteHash: undefined, joinedAt: now() };
    event(c, "payee", "joined", `${c.payee.name} opened the invite and joined the contract.`);
    store.save(c);
    return { contract: c, payeeKey };
  });
}

/** The client issues a fresh invite (e.g. sent to the wrong person). Revokes any earlier invite and any freelancer access not yet used to sign. */
export function reissueInvite(id: string, role: Role | null) {
  return withLock(id, async () => {
    const c = mustGet(id);
    requireRole(role, "payer");
    if (c.signatures.payee) throw new HttpError(409, `${c.payee.name} has already signed; their access can't be replaced.`);
    const inviteCode = newSecret();
    c.access = { payerHash: c.access.payerHash, inviteHash: hashSecret(inviteCode), inviteCreatedAt: now() };
    event(c, "payer", "invite_reissued", `${c.payer.name} issued a new invite link. Earlier links no longer work.`);
    store.save(c);
    return { contract: c, inviteCode };
  });
}

export function updateDraft(id: string, role: Role | null, patch: { payer?: Partial<Party>; payee?: Partial<Party>; autoReleaseThreshold?: number }) {
  return withLock(id, async () => {
    const c = mustGet(id);
    requireRole(role, "payer", "payee");
    if (c.status !== "draft") throw new HttpError(409, "The contract is signed and can no longer be edited.");
    const own = () => JSON.stringify(role === "payer" ? c.payer : c.payee);
    const rest = () => JSON.stringify([role === "payer" ? c.payee : c.payer, c.autoReleaseThreshold]);
    const [ownBefore, restBefore] = [own(), rest()];
    if (patch.payer && role === "payer") c.payer = { ...c.payer, ...clean(patch.payer) };
    if (patch.payee && role === "payee") c.payee = { ...c.payee, ...clean(patch.payee) };
    if (patch.payee && role === "payer" && !c.signatures.payee) c.payee = { ...c.payee, ...clean(patch.payee) };
    if (typeof patch.autoReleaseThreshold === "number" && role === "payer") {
      c.autoReleaseThreshold = Math.min(0.99, Math.max(0.5, patch.autoReleaseThreshold));
    }
    if (own() === ownBefore && rest() === restBefore) return c;
    // Your own name or payout email is yours to change: it only asks you to sign again.
    // Anything that touches the other party or the release policy needs both signatures again.
    const onlyOwn = rest() === restBefore;
    if (onlyOwn && c.signatures[role!]) {
      delete c.signatures[role!];
      event(c, role!, "signature_withdrawn", "Updated their details, so they need to sign again.");
    } else if (!onlyOwn && (c.signatures.payer || c.signatures.payee)) {
      c.signatures = {};
      event(c, "system", "signatures_reset", "Terms changed, so both parties need to sign again.");
    }
    return store.save(c);
  });
}

const clean = (p: Partial<Party>) => ({
  ...(p.name !== undefined ? { name: String(p.name).slice(0, 80) } : {}),
  ...(p.email !== undefined ? { email: String(p.email).trim().slice(0, 120) } : {}),
});

export function sign(id: string, role: Role | null) {
  return withLock(id, async () => {
    const c = mustGet(id);
    requireRole(role, "payer", "payee");
    if (c.status !== "draft") throw new HttpError(409, "This contract is already signed.");
    if (c.signatures[role]) throw new HttpError(409, "You've already signed this contract.");
    if (role === "payee" && !c.access.payeeHash) throw new HttpError(409, "Join through your invite link before signing.");
    if (role === "payee" && !validEmail(c.payee.email)) throw new HttpError(400, "Add the PayPal email you'll be paid at before signing.");
    c.signatures[role] = now();
    event(c, role, "signed", `${role === "payer" ? c.payer.name : c.payee.name} signed the agreement.`);
    if (c.signatures.payer && c.signatures.payee) {
      c.status = "awaiting_funding";
      event(c, "system", "ready_to_fund", `Both parties signed. ${c.payer.name} can now fund ${fmt(c.totalCents, c.currency)} with PayPal.`);
    }
    return store.save(c);
  });
}

// ---------------------------------------------------------------- funding

export function createOrder(id: string, role: Role | null) {
  return withLock(id, async () => {
    const c = mustGet(id);
    requireRole(role, "payer");
    if (c.status !== "awaiting_funding") throw new HttpError(409, "This contract isn't waiting for funding.");
    const { orderId, approveUrl } = await paypal().createOrder(
      c.id,
      `Covenant: ${c.title}`,
      c.totalCents,
      c.milestones.map((m) => ({ name: `Milestone ${m.index + 1}: ${m.title}`, cents: m.amountCents })),
    );
    c.funding = { orderId, authorizedCents: 0, capturedCents: 0, status: "created", simulated: !paypal().live };
    event(c, "paypal", "order_created", `PayPal order ${orderId} created for ${fmt(c.totalCents, c.currency)} (intent: AUTHORIZE).`);
    store.save(c);
    return { orderId, approveUrl };
  });
}

export function authorizeOrder(id: string, role: Role | null, orderId: string) {
  return withLock(id, async () => {
    const c = mustGet(id);
    requireRole(role, "payer");
    if (!c.funding || c.funding.orderId !== orderId) throw new HttpError(400, "That PayPal order doesn't belong to this contract.");
    if (c.funding.status !== "created") return c; // idempotent
    const a = await paypal().authorizeOrder(orderId);
    const t = Date.now();
    c.funding = {
      ...c.funding,
      authorizationId: a.authorizationId,
      authorizedCents: a.amountCents,
      status: "authorized",
      authorizedAt: new Date(t).toISOString(),
      honorUntil: new Date(t + 3 * DAY).toISOString(),
      expiresAt: a.expiresAt ?? new Date(t + 29 * DAY).toISOString(),
      payerPaypalEmail: a.payerEmail,
    };
    c.status = "active";
    ledger(c, { type: "authorization", amountCents: a.amountCents, status: a.status, reference: a.authorizationId, note: `Funds held on ${c.payer.name}'s PayPal account` });
    event(c, "paypal", "authorized", `${fmt(a.amountCents, c.currency)} is now held by PayPal. Nothing has been paid out yet.`);
    return store.save(c);
  });
}

// ---------------------------------------------------------------- evidence & verification

export function submitEvidence(id: string, role: Role | null, mid: string, input: { note?: string; files?: UploadInput[]; links?: string[] }) {
  return withLock(id, async () => {
    const c = mustGet(id);
    requireRole(role, "payee");
    if (c.status !== "active") throw new HttpError(409, "Evidence can be submitted once the contract is funded.");
    const m = milestone(c, mid);
    if (!["open", "rejected"].includes(m.status)) throw new HttpError(409, `This milestone is ${m.status.replace("_", " ")}.`);
    const files = (input.files ?? []).slice(0, 12);
    const links = (input.links ?? []).map((l) => String(l).trim()).filter(Boolean).slice(0, 6);
    if (!files.length && !links.length && !(input.note ?? "").trim()) throw new HttpError(400, "Attach files, links or a note as evidence.");

    const items = [...files.map((f) => storeUpload(c.id, f)), ...((input.note ?? "").trim().length > 0 ? [textEvidence(input.note!.trim())] : [])];
    const sub = { id: `sub_${nanoid(6)}`, at: now(), note: (input.note ?? "").trim().slice(0, 4000), items, pendingLinks: links.length ? links : undefined };
    m.submissions.push(sub);
    m.status = "verifying";
    const count = files.length + links.length + (sub.note ? 1 : 0);
    event(c, "payee", "submitted", `${c.payee.name} submitted ${count} piece${count === 1 ? "" : "s"} of evidence for "${m.title}".`, m.id);
    store.save(c);
    // Verification runs in the background; both parties' screens update when it finishes.
    enqueue("verify", c.id, { contractId: c.id, milestoneId: m.id, submissionId: sub.id });
    return c;
  });
}

/** Background job: gather link evidence, run the verifier, then apply the verdict. */
registerJob("verify", async ({ contractId, milestoneId, submissionId }, job) => {
  const current = () => {
    const c = store.get(contractId);
    const m = c?.milestones.find((x) => x.id === milestoneId);
    const sub = m?.submissions.at(-1);
    return c && m && sub && sub.id === submissionId && m.status === "verifying" ? { c, m, sub } : null;
  };
  if (!current()) return; // superseded or already decided

  try {
    // 1. Links (GitHub API, Kernel cloud browser) can take a while: fetch outside the lock.
    const pending = current()!.sub.pendingLinks ?? [];
    if (pending.length) {
      const fetched = (await Promise.all(pending.map((l) => linkEvidence(l, contractId)))).flat();
      await withLock(contractId, async () => {
        const s = current();
        if (!s) return;
        s.sub.items.push(...fetched);
        delete s.sub.pendingLinks;
        store.save(s.c);
      });
    }

    // 2. Verify against a snapshot, outside the lock.
    const snap = current();
    if (!snap) return;
    const verdict = await verifyMilestone(snap.c, snap.m, snap.sub);

    // 3. Apply under the lock, only if nothing changed meanwhile.
    await withLock(contractId, async () => {
      const s = current();
      if (!s) return;
      const { c, m } = s;
      const { injection, injectionNote, ...v } = verdict;
      m.verdict = v;
      const who = aiName(v.engine);
      if (injection) event(c, "ai", "injection_blocked", `${who} found instructions aimed at the verifier inside the evidence and ignored them. ${injectionNote ?? ""}`.trim(), m.id);
      if (v.outcome === "pass") {
        event(c, "ai", "verified", `${who} verified every condition (lowest confidence ${(v.confidence * 100).toFixed(0)}%). Releasing funds.`, m.id);
        await release(c, m, 100, "verifier");
      } else if (v.outcome === "fail") {
        m.status = "rejected";
        event(c, "ai", "rejected", `${who} found unmet conditions: ${v.summary}`, m.id);
      } else {
        m.status = "needs_review";
        event(c, "ai", "needs_review", `${who} isn't confident enough to release on its own. ${c.payer.name} decides. ${v.summary}`, m.id);
      }
      store.save(c);
    });
  } catch (e) {
    if (job.attempts < job.maxAttempts) throw e; // retried with backoff
    await withLock(contractId, async () => {
      const s = current();
      if (!s) return;
      s.m.status = "needs_review";
      event(s.c, "system", "verifier_error", `The verifier couldn't finish (${e instanceof Error ? e.message : "unknown error"}). ${s.c.payer.name} can review manually.`, s.m.id);
      store.save(s.c);
    });
  }
});

export function review(id: string, role: Role | null, mid: string, decision: "approve" | "reject", note?: string) {
  return withLock(id, async () => {
    const c = mustGet(id);
    requireRole(role, "payer");
    const m = milestone(c, mid);
    if (!["needs_review", "rejected"].includes(m.status) && !(decision === "approve" && m.status === "open" && m.submissions.length)) {
      throw new HttpError(409, "This milestone isn't waiting for your review.");
    }
    if (decision === "approve") {
      event(c, "payer", "approved", `${c.payer.name} approved "${m.title}"${note ? `: ${note}` : "."}`, m.id);
      await release(c, m, 100, "payer");
    } else {
      m.status = "rejected";
      event(c, "payer", "rejected", `${c.payer.name} sent "${m.title}" back${note ? `: ${note}` : "."}`, m.id);
    }
    return store.save(c);
  });
}

// ---------------------------------------------------------------- money movement

async function release(c: Contract, m: Milestone, payeePercent: number, by: "verifier" | "payer" | "arbiter" | "reclaim") {
  if (!c.funding?.authorizationId) throw new HttpError(409, "This contract isn't funded.");
  const deliveredAt = m.submissions.at(-1)?.at ?? now();
  const s = settle(m, deliveredAt, by === "reclaim" ? 0 : payeePercent);
  const pp = paypal();

  const unsettledAfter = c.milestones.filter((x) => x.id !== m.id && !["released", "refunded"].includes(x.status)).length;
  const isLast = unsettledAfter === 0;

  let capture: { captureId: string; status: string } | undefined;
  if (s.netCents > 0) {
    try {
      capture = await pp.capture(c.funding.authorizationId, s.netCents, isLast, `${c.id}-${m.id}`, `Covenant milestone: ${m.title}`);
    } catch (e) {
      m.status = "needs_review";
      const msg = e instanceof PayPalError ? `${e.message}${e.debugId ? ` (debug id ${e.debugId})` : ""}` : String(e);
      event(c, "paypal", "capture_failed", `PayPal couldn't capture ${fmt(s.netCents, c.currency)}: ${msg}`, m.id);
      return;
    }
  }

  if (s.penaltyCents > 0) {
    ledger(c, { type: "penalty", amountCents: s.penaltyCents, status: "WITHHELD", reference: "late-penalty", milestoneId: m.id, note: `${s.daysLate} day${s.daysLate === 1 ? "" : "s"} late; stays with ${c.payer.name}` });
    event(c, "system", "penalty", `Delivered ${s.daysLate} day${s.daysLate === 1 ? "" : "s"} late, so ${fmt(s.penaltyCents, c.currency)} stays with ${c.payer.name} per the agreement.`, m.id);
  }

  m.settlement = { ...s };

  if (capture) {
    c.funding.capturedCents += s.netCents;
    c.funding.status = isLast ? "captured" : "partially_captured";
    m.settlement.captureId = capture.captureId;
    ledger(c, { type: "capture", amountCents: s.netCents, status: capture.status, reference: capture.captureId, milestoneId: m.id, note: `Captured for "${m.title}"${isLast ? " (final capture)" : ""}` });

    const { feeCents, payoutCents } = feeSplit(s.netCents, config.paypal.platformFeePercent);
    try {
      const p = await pp.payout(c.payee.email, payoutCents, `Payment for "${m.title}" — ${c.title}`, `${m.id}`);
      m.settlement.payoutBatchId = p.batchId;
      m.settlement.payoutStatus = p.status;
      ledger(c, { type: "payout", amountCents: payoutCents, status: p.status, reference: p.batchId, milestoneId: m.id, note: `Paid to ${c.payee.email}${feeCents ? ` (fee ${fmt(feeCents, c.currency)})` : ""}` });
      event(c, "paypal", "paid", `${fmt(payoutCents, c.currency)} sent to ${c.payee.name}'s PayPal (${c.payee.email}).`, m.id);
      schedulePayoutCheck(c.id, m.id, p.batchId);
    } catch (e) {
      const msg = e instanceof PayPalError ? `${e.message}${e.debugId ? ` (debug id ${e.debugId})` : ""}` : String(e);
      m.settlement.payoutStatus = "FAILED";
      event(c, "paypal", "payout_failed", `Captured, but the payout to ${c.payee.email} failed: ${msg}. Retry from the milestone.`, m.id);
    }
  }

  const returned = s.grossCents - s.netCents;
  m.status = s.netCents > 0 ? "released" : "refunded";
  if (returned > 0) {
    event(c, "system", "returned", `${fmt(returned, c.currency)} of "${m.title}" returns to ${c.payer.name}${s.netCents > 0 ? "" : " in full"}.`, m.id);
  }

  if (isLast) await closeOut(c);
}

async function closeOut(c: Contract) {
  const f = c.funding!;
  const remaining = f.authorizedCents - f.capturedCents;
  if (remaining > 0 && f.status !== "captured") {
    // Nothing captured with final_capture, so release the hold explicitly.
    try {
      await paypal().voidAuthorization(f.authorizationId!);
      f.status = "voided";
      ledger(c, { type: "void", amountCents: remaining, status: "VOIDED", reference: f.authorizationId!, note: `Remaining hold released to ${c.payer.name}` });
    } catch (e) {
      event(c, "paypal", "void_failed", `The remaining ${fmt(remaining, c.currency)} hold will lapse automatically when the authorization expires.`);
    }
  } else if (remaining > 0) {
    ledger(c, { type: "void", amountCents: remaining, status: "RELEASED", reference: f.authorizationId!, note: `Final capture released the remaining hold to ${c.payer.name}` });
  }
  c.status = "completed";
  event(c, "system", "completed", `Contract complete. ${c.payee.name} received ${fmt(f.capturedCents, c.currency)}; ${fmt(remaining, c.currency)} stayed with ${c.payer.name}.`);
}

function schedulePayoutCheck(cid: string, mid: string, batchId: string) {
  enqueue("payout_status", cid, { contractId: cid, milestoneId: mid, batchId }, { delayMs: paypal().live ? 8000 : 0, maxAttempts: 6 });
}

registerJob("payout_status", async ({ contractId, milestoneId, batchId }, job) => {
  const status = paypal().live ? await paypal().payoutStatus(batchId) : "SUCCESS";
  await updatePayoutStatus(contractId, milestoneId, batchId, status);
  // PENDING/PROCESSING: check again later (exponential backoff); webhooks may also update it first.
  if (["PENDING", "PROCESSING", "NEW"].includes(status) && job.attempts < job.maxAttempts) throw new Error(`payout ${status}`);
});

export function updatePayoutStatus(cid: string, mid: string | undefined, batchId: string, status: string) {
  return withLock(cid, async () => {
    const c = store.get(cid);
    if (!c) return;
    const entry = c.ledger.find((l) => l.type === "payout" && l.reference === batchId);
    if (!entry || entry.status === status) return;
    entry.status = status;
    const m = c.milestones.find((x) => x.id === (mid ?? entry.milestoneId));
    if (m?.settlement) m.settlement.payoutStatus = status;
    if (status === "SUCCESS") event(c, "paypal", "payout_settled", `PayPal confirmed the payout for "${m?.title ?? "milestone"}".`, m?.id);
    store.save(c);
  });
}

export function retryPayout(id: string, role: Role | null, mid: string) {
  return withLock(id, async () => {
    const c = mustGet(id);
    requireRole(role, "payer", "payee");
    const m = milestone(c, mid);
    if (m.status !== "released" || m.settlement?.payoutStatus !== "FAILED") throw new HttpError(409, "There's no failed payout to retry.");
    const { payoutCents } = feeSplit(m.settlement.netCents, config.paypal.platformFeePercent);
    const p = await paypal().payout(c.payee.email, payoutCents, `Payment for "${m.title}" — ${c.title}`, `${m.id}-r${Date.now()}`);
    m.settlement.payoutBatchId = p.batchId;
    m.settlement.payoutStatus = p.status;
    ledger(c, { type: "payout", amountCents: payoutCents, status: p.status, reference: p.batchId, milestoneId: m.id, note: `Retried payout to ${c.payee.email}` });
    event(c, "paypal", "paid", `${fmt(payoutCents, c.currency)} sent to ${c.payee.name}'s PayPal on retry.`, m.id);
    schedulePayoutCheck(c.id, m.id, p.batchId);
    return store.save(c);
  });
}

// ---------------------------------------------------------------- disputes

export function openDispute(id: string, role: Role | null, mid: string, reason: string) {
  return withLock(id, async () => {
    const c = mustGet(id);
    requireRole(role, "payer", "payee");
    const m = milestone(c, mid);
    if (!["needs_review", "rejected", "open"].includes(m.status) || (m.status === "open" && !m.submissions.length)) {
      throw new HttpError(409, "Disputes can be opened on a milestone with evidence that hasn't been paid out.");
    }
    if (!reason?.trim()) throw new HttpError(400, "Explain what you disagree with.");
    m.status = "disputed";
    m.dispute = { openedBy: role, openedAt: now(), reason: reason.trim().slice(0, 2000), statements: [{ role, text: reason.trim().slice(0, 4000), at: now() }] };
    event(c, role, "dispute_opened", `${role === "payer" ? c.payer.name : c.payee.name} opened a dispute on "${m.title}".`, m.id);
    return store.save(c);
  });
}

export function addStatement(id: string, role: Role | null, mid: string, text: string) {
  return withLock(id, async () => {
    const c = mustGet(id);
    requireRole(role, "payer", "payee");
    const m = milestone(c, mid);
    if (m.status !== "disputed" || !m.dispute) throw new HttpError(409, "There's no open dispute on this milestone.");
    if (!text?.trim()) throw new HttpError(400, "Write your side of the story.");
    m.dispute.statements.push({ role, text: text.trim().slice(0, 4000), at: now() });
    event(c, role, "statement", `${role === "payer" ? c.payer.name : c.payee.name} added a statement to the dispute.`, m.id);
    return store.save(c);
  });
}

export function resolveDispute(id: string, role: Role | null, mid: string) {
  return withLock(id, async () => {
    const c = mustGet(id);
    requireRole(role, "payer", "payee");
    const m = milestone(c, mid);
    if (m.status !== "disputed" || !m.dispute) throw new HttpError(409, "There's no open dispute on this milestone.");
    const ruling = await arbitrate(c, m);
    m.dispute.ruling = ruling;
    event(c, "ai", "ruling", `${aiName(ruling.engine)} ruled ${ruling.payeePercent}% to ${c.payee.name}: ${ruling.reasoning}`, m.id);
    await release(c, m, ruling.payeePercent, "arbiter");
    return store.save(c);
  });
}

/** Payer takes back a milestone whose deadline passed with no evidence. */
export function reclaim(id: string, role: Role | null, mid: string) {
  return withLock(id, async () => {
    const c = mustGet(id);
    requireRole(role, "payer");
    const m = milestone(c, mid);
    if (m.status !== "open" || m.submissions.length) throw new HttpError(409, "Only milestones with no evidence can be reclaimed.");
    if (!m.deadline || new Date(m.deadline).getTime() > Date.now()) throw new HttpError(409, "You can reclaim a milestone once its deadline has passed.");
    event(c, "payer", "reclaimed", `${c.payer.name} reclaimed "${m.title}" after the deadline passed with no delivery.`, m.id);
    await release(c, m, 0, "reclaim");
    return store.save(c);
  });
}

export function cancel(id: string, role: Role | null) {
  return withLock(id, async () => {
    const c = mustGet(id);
    requireRole(role, "payer", "payee");
    if (c.milestones.some((m) => m.status === "released")) throw new HttpError(409, "Money has already been released; settle the remaining milestones instead.");
    if (c.status === "completed" || c.status === "cancelled") throw new HttpError(409, "This contract is already closed.");
    if (c.status === "active") {
      requireRole(role, "payee"); // once funded, only the payee can walk away unilaterally
      await paypal().voidAuthorization(c.funding!.authorizationId!);
      c.funding!.status = "voided";
      ledger(c, { type: "void", amountCents: c.funding!.authorizedCents, status: "VOIDED", reference: c.funding!.authorizationId!, note: "Contract cancelled; hold released" });
      c.milestones.forEach((m) => (m.status = "refunded"));
    }
    c.status = "cancelled";
    event(c, role, "cancelled", `${role === "payer" ? c.payer.name : c.payee.name} cancelled the contract.`);
    return store.save(c);
  });
}

// ---------------------------------------------------------------- webhooks

export async function handleWebhook(evt: { event_type: string; resource: Record<string, any> }) {
  const r = evt.resource ?? {};
  const type = String(evt.event_type ?? "");
  const refs = [r.id, r.payout_batch_id, r.supplementary_data?.related_ids?.order_id, r.supplementary_data?.related_ids?.authorization_id].filter(Boolean);
  const found = refs.map((x) => store.byPayPalRef(String(x))).find(Boolean);
  if (!found) return false;
  await withLock(found.id, async () => {
    const c = store.get(found.id)!;
    const entry = c.ledger.find((l) => l.reference === r.id || (r.payout_batch_id && l.reference === r.payout_batch_id));
    if (type.startsWith("PAYMENT.PAYOUTS-ITEM") && entry) entry.status = String(r.transaction_status ?? type.split(".").pop());
    else if (entry && r.status) entry.status = String(r.status);
    event(c, "paypal", "webhook", `PayPal webhook: ${type}`);
    store.save(c);
  });
  return true;
}
