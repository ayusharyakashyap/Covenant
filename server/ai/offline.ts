// Offline fallback engine, used when no AI key is set (or the key stops working).
// It is intentionally simple and transparent (rules, not AI) and the UI labels it as such,
// so anyone can explore the full PayPal flow without an API key.
import type { CompiledContract, CompiledMilestone } from "./compiler.ts";
import type { ConditionFinding, ConditionKind, Milestone, Submission } from "../../shared/types.ts";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function parseDate(fragment: string, now: Date): string | null {
  const m = fragment.match(/\b(?:by|before|due|on)\s+(?:the\s+)?(?:(\d{1,2})(?:st|nd|rd|th)?\s+)?([A-Za-z]{3,9})\.?\s*(\d{1,2})?(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/i);
  if (!m) {
    const rel = fragment.match(/\bwithin\s+(\d+)\s+(day|week)s?/i);
    if (rel) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() + Number(rel[1]) * (rel[2].toLowerCase() === "week" ? 7 : 1));
      d.setUTCHours(23, 59, 59, 0);
      return d.toISOString();
    }
    return null;
  }
  const monthIdx = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
  if (monthIdx < 0) return null;
  const day = Number(m[1] ?? m[3]);
  if (!day) return null;
  let year = m[4] ? Number(m[4]) : now.getUTCFullYear();
  const d = new Date(Date.UTC(year, monthIdx, day, 23, 59, 59));
  if (!m[4] && d.getTime() < now.getTime() - 864e5 * 30) d.setUTCFullYear(++year);
  return d.toISOString();
}

export function inferKind(text: string): ConditionKind {
  const t = text.toLowerCase();
  if (/pull request|\bpr\b|merged|github/.test(t)) return "github_pr";
  if (/approv|sign[- ]?off|happy with|satisf/.test(t)) return "approval";
  if (/\b(svg|png|pdf|zip|csv|xlsx|figma|psd|ai|docx|source files?|files?|mp4|mov|wav|mp3)\b/.test(t)) return "file";
  if (/concept|design|mockup|photo|picture|screenshot|illustration|sketch|draft|render|logo/.test(t)) return "image";
  if (/link|url|deployed|live|website|published|online/.test(t)) return "link";
  return "text";
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Shortens at a word boundary so titles never end mid-word. */
const short = (s: string, n = 48) => (s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, "").replace(/[,;:]$/, "") + "…");

// What the deal is about, for the contract title.
const TOPICS: [RegExp, string][] = [
  [/logo/i, "logo design"],
  [/translat/i, "translation"],
  [/blog|article|copywrit|posts?\b/i, "writing"],
  [/photo|picture/i, "photography"],
  [/csv|data[- ]clean|dataset|spreadsheet/i, "data cleaning"],
  [/video|edit(?:ing)? footage/i, "video"],
  [/\bapp\b|mobile/i, "app"],
  [/site|website|landing page/i, "website"],
];
const topic = (t: string) => TOPICS.find(([re]) => re.test(t))?.[1];

export function offlineCompile(text: string, now: Date): CompiledContract {
  const clean = text.replace(/\s+/g, " ").trim();
  const amounts = [...clean.matchAll(/\$\s?([\d,]+(?:\.\d{1,2})?)/g)].map((m) => Number(m[1].replace(/,/g, "")));
  const payeeMatch =
    clean.match(/\b(?:[Pp]ay|[Hh]ire|[Pp]aying)\s+(\p{Lu}\p{Ll}+(?:\s\p{Lu}\p{Ll}+)?)/u) ??
    clean.match(/\bpays?\s+(?:the\s+|our\s+)?([\w-]+(?:\s[\w-]+)?\s(?:agent|bot|team|studio|agency))\b/i);
  const payerMatch = clean.match(/\b(\p{Lu}\p{Ll}+)\s+(?:will\s+)?pays?\b/u) ?? clean.match(/^(?:our|the)\s+([\w-]+(?:\s[\w-]+)?\s(?:agent|bot|team))\s+(?:will\s+)?pays?\b/i);
  const penalty = clean.match(/(\d+(?:\.\d+)?)\s*%[^.;]*?\b(?:per|a|each)\s+day/i);
  const penaltyCap = clean.match(/(?:max(?:imum)?|capped at|up to)\s*(\d+)\s*%/i);
  const deadlineAll = parseDate(clean, now);

  // Milestone clauses look like "$200 when she shows 3 concepts".
  const clauseRe = /\$\s?([\d,]+(?:\.\d{1,2})?)\s+(?:when|once|after|upon|on)\s+(.+?)(?=(?:[,;.]\s*(?:and\s+)?(?:the\s+)?(?:rest|remaining|balance|\$)|;|\.\s|\.$|$))/gi;
  const clauses = [...clean.matchAll(clauseRe)];
  const milestones: CompiledMilestone[] = [];
  const pen = penalty ? { percent_per_day: Number(penalty[1]), max_percent: penaltyCap ? Number(penaltyCap[1]) : 100 } : null;

  for (const c of clauses) {
    const amount = Number(c[1].replace(/,/g, ""));
    let body = c[2].replace(/^(?:she|he|they|you|i|we|it)\s+(?=\w)/i, "").trim();
    body = body.replace(/\s+by\s+[A-Za-z]{3,9}\.?\s*\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?/i, "").trim();
    const deadline = parseDate(c[2], now) ?? deadlineAll;
    const parts = body.split(/\s*(?:\band\b|,)\s*/).filter((p) => p.length > 2);
    const conditions = (parts.length ? parts : [body]).map((p) => ({ text: cap(p.replace(/^(?:shows?|delivers?|sends?|submits?|ships?)\s+/i, "Delivers ")), kind: inferKind(p) }));
    milestones.push({ title: short(cap((body.length > 48 && parts.length > 1 ? parts[0] : body).replace(/\s+by$/i, ""))), amount, deadline, conditions, late_penalty: pen });
  }

  const total = amounts.length ? (clauses.length && amounts[0] === milestones.reduce((a, m) => a + m.amount, 0) ? amounts[0] : Math.max(...amounts)) : 0;
  // "4 blog posts ... $80 per post": one milestone per unit when the numbers add up.
  const units = clean.match(/\b(\d{1,2})\s+([a-z-]+\s)?([a-z]+?)s\b/i);
  const per = clean.match(/\$\s?([\d,]+(?:\.\d{1,2})?)\s+(?:per|a|each|for each)\s+([a-z]+)/i);
  if (milestones.length === 0 && units && per && units[3].toLowerCase() === per[2].toLowerCase()) {
    const n = Number(units[1]);
    const each = Number(per[1].replace(/,/g, ""));
    if (n >= 2 && n <= 8 && Math.abs(n * each - total) < 0.01) {
      const noun = units[3].toLowerCase();
      const spec = clean.match(new RegExp(`${noun}s\\s+(of\\s+[^,.;]+|about\\s+[^,.;]+)`, "i"))?.[1];
      const as = clean.match(/delivered\s+as\s+([^,.;]+)/i)?.[1];
      for (let i = 1; i <= n; i++)
        milestones.push({
          title: `${cap(noun)} ${i} of ${n}`,
          amount: each,
          deadline: deadlineAll,
          conditions: [
            { text: `${cap(noun)} ${i} delivered${spec ? ` (${spec.replace(/\s+about\s+.*$/i, "")})` : ""}`, kind: inferKind(as ?? noun) },
            ...(spec && /\d+\s*words/i.test(spec) ? [{ text: `At least ${spec.match(/(\d+)\s*words/i)![1]} words`, kind: "text" as ConditionKind }] : []),
          ],
          late_penalty: pen,
        });
    }
  }
  if (milestones.length === 0) {
    const what = (clean.match(/\bto\s+((?:translate|write|design|build|edit|deliver|create|make|clean|produce|record|shoot|develop)\b.+?)(?=[.;]|\bby\b|$)/i)?.[1] ??
      clean.match(/\b(?:when|once|after|for)\s+(.+?)(?=[.;]|\bby\b|$)/i)?.[1])
      ?.replace(/^(?:the|a|an)\s+/i, "")
      .replace(/^(?:it|she|he|they)\s+(?:delivers|sends|submits|ships)\s+/i, "Delivers ")
      .trim();
    const parts = what ? what.split(/\s*(?:\band\b|,)\s*/).filter((p) => p.length > 2) : [];
    milestones.push({
      title: what ? short(cap(parts[0] ?? what)) : "Full delivery",
      amount: total,
      deadline: deadlineAll,
      conditions: parts.length ? parts.map((p) => ({ text: cap(p), kind: inferKind(p) })) : [{ text: "Work delivered as described in the agreement", kind: "approval" }],
      late_penalty: pen,
    });
  }

  // "the rest" clause: "$200 when X, rest when Y"
  const rest = clean.match(/\b(?:the\s+)?(?:rest|remaining|balance)\s+(?:when|once|after|upon|on)\s+(.+?)(?=[.;]|$)/i);
  const sum = milestones.reduce((a, m) => a + m.amount, 0);
  if (rest && total > sum) {
    const body = rest[1].replace(/^(?:she|he|they|you|i|we)\s+/i, "").trim();
    milestones.push({
      title: short(cap(body.replace(/\s+by$/i, ""))),
      amount: +(total - sum).toFixed(2),
      deadline: parseDate(rest[1], now) ?? deadlineAll,
      conditions: body.split(/\s*(?:\band\b|,)\s*/).filter((p) => p.length > 2).map((p) => ({ text: cap(p), kind: inferKind(p) })),
      late_penalty: pen,
    });
  }

  const finalTotal = Math.max(total, milestones.reduce((a, m) => a + m.amount, 0));
  const ambiguities: string[] = [];
  if (!/@/.test(clean)) ambiguities.push("What PayPal email should the payee be paid at?");
  if (pen && !penaltyCap) ambiguities.push("Is there a maximum on the late penalty? It currently has no cap.");
  if (milestones.some((m) => m.deadline)) ambiguities.push("Which timezone do the deadlines use? Defaulting to UTC end of day.");
  const emails = [...clean.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/g)].map((m) => m[0]);

  const payee = payeeMatch?.[1] ? cap(payeeMatch[1]) : "Freelancer";
  const about = topic(clean);
  return {
    is_valid_agreement: finalTotal > 0,
    rejection_reason: finalTotal > 0 ? undefined : "I couldn't find an amount to pay. Try including a dollar figure, e.g. \"$500\".",
    title: `${payee}${about && !payee.toLowerCase().includes(about.split(" ")[0]) ? ` — ${about}` : ""}`.slice(0, 60),
    summary: `${payerMatch?.[1] ? cap(payerMatch[1]) : "The client"} pays ${payee} $${finalTotal.toFixed(2)} in ${milestones.length} milestone${milestones.length > 1 ? "s" : ""}: ${milestones
      .map((m) => `$${m.amount.toFixed(2)} for "${m.title}"${m.deadline ? ` due ${m.deadline.slice(0, 10)}` : ""}`)
      .join("; ")}.${pen ? ` Late delivery reduces a milestone by ${pen.percent_per_day}% per day${penaltyCap ? `, up to ${pen.max_percent}%` : ""}.` : ""}`,
    currency: "USD",
    total: finalTotal,
    payer: { name: payerMatch?.[1] ? cap(payerMatch[1]) : "Client", email: emails[1] ?? "" },
    payee: { name: payee, email: emails[0] ?? "" },
    milestones,
    ambiguities,
    risks: milestones.some((m) => m.conditions.some((c) => c.kind === "approval")) ? ["Some conditions depend on the payer's approval, which can delay payment."] : [],
  };
}

const INJECTION = /(ignore (all |any |the )?(previous|prior|above) instructions|you are (an? )?(ai|assistant|verifier)|as the (ai|verifier|reviewer)|mark (this|the milestone) as (passed|met|approved|complete)|approve (this|the) (milestone|submission)|system prompt)/i;

export function offlineVerify(m: Milestone, sub: Submission) {
  const images = sub.items.filter((i) => i.kind === "image" || i.mime?.startsWith("image/"));
  const files = sub.items.filter((i) => i.kind === "file" || i.kind === "image");
  const links = sub.items.filter((i) => i.kind === "link");
  const texts = sub.items.filter((i) => i.kind === "text").map((i) => i.excerpt ?? "").join(" ") + " " + sub.note;
  const injectedItem = sub.items.find((i) => INJECTION.test(i.excerpt ?? "") || INJECTION.test(i.name));
  const injection = Boolean(injectedItem) || INJECTION.test(sub.note);

  const findings: ConditionFinding[] = m.conditions.map((c) => {
    const t = c.text.toLowerCase();
    const need = Number((t.match(/\b(\d+)\b/) ?? [])[1] ?? (/(three)/.test(t) ? 3 : /(two)/.test(t) ? 2 : 1));
    switch (c.kind) {
      case "image": {
        const ok = images.length >= need;
        return { conditionId: c.id, met: ok, confidence: ok ? 0.86 : 0.9, reasoning: ok ? `Found ${images.length} image${images.length === 1 ? "" : "s"}; ${need} required.` : `Only ${images.length} image${images.length === 1 ? "" : "s"} submitted; ${need} required.`, evidenceIds: images.map((i) => i.id) };
      }
      case "file": {
        type F = { detectedType?: string; extensionMatchesContent?: boolean; width?: number; pages?: number; uniqueRows?: number; duplicateRows?: number };
        const fx = (f: (typeof files)[number]) => (f.facts ?? {}) as F;
        const typeOf = (f: (typeof files)[number]) => (fx(f).detectedType === "jpeg" ? "jpg" : fx(f).detectedType) ?? f.name.split(".").pop()!.toLowerCase();
        const exts = [...t.matchAll(/\b(svg|png|pdf|zip|csv|xlsx|psd|ai|docx|mp4|mov|wav|mp3|fig)\b/g)].map((x) => x[1]);
        // A format only counts if the bytes really are that format.
        const missing = exts.filter((e) => !files.some((f) => f.name.toLowerCase().endsWith("." + e) && (fx(f).extensionMatchesContent ?? true) && (typeOf(f) === e || !fx(f).detectedType)));
        const problems: string[] = [];
        if (missing.length) problems.push(`Missing or mislabelled formats: ${missing.join(", ").toUpperCase()}`);
        const px = t.match(/(\d{3,5})\s*(?:px|pixels)/)?.[1];
        if (px) {
          const raster = files.filter((f) => fx(f).width && ["png", "jpeg", "webp", "gif"].includes(fx(f).detectedType ?? ""));
          if (!raster.some((f) => (fx(f).width ?? 0) >= Number(px))) problems.push(`No raster image is at least ${px}px wide`);
        }
        const pages = t.match(/(\d+)[- ]page/)?.[1];
        if (pages) {
          const pdf = files.find((f) => fx(f).pages);
          if (!pdf || (fx(pdf).pages ?? 0) < Number(pages)) problems.push(`Expected ${pages} pages, found ${pdf ? fx(pdf).pages : "no PDF"}`);
        }
        const rowsNeed = t.match(/(\d+)\s+(?:\w+\s+)?rows/)?.[1];
        if (rowsNeed) {
          const csv = files.find((f) => fx(f).uniqueRows !== undefined);
          if (!csv || (fx(csv).uniqueRows ?? 0) < Number(rowsNeed)) problems.push(`Needs ${rowsNeed} unique rows, found ${csv ? fx(csv).uniqueRows : "no CSV"}`);
          else if (/dedup|unique|duplicate/.test(t) && (fx(csv).duplicateRows ?? 0) > 0) problems.push(`CSV still has ${fx(csv).duplicateRows} duplicate rows`);
        }
        const ok = files.length > 0 && problems.length === 0;
        return { conditionId: c.id, met: ok, confidence: ok ? 0.85 : 0.9, reasoning: ok ? `Files checked${exts.length ? `: ${exts.join(", ").toUpperCase()} present and genuine` : ""}.` : files.length ? problems.join(". ") + "." : "No files were submitted.", evidenceIds: files.map((f) => f.id) };
      }
      case "link": {
        const live = links.filter((l) => (l.facts as { reachable?: boolean } | undefined)?.reachable !== false);
        const ok = live.length > 0;
        return { conditionId: c.id, met: ok, confidence: ok ? 0.82 : 0.88, reasoning: ok ? `Link ${live[0].url} responded.` : "No reachable link was submitted.", evidenceIds: live.map((l) => l.id) };
      }
      case "github_pr": {
        const pr = links.find((l) => (l.facts as { merged?: boolean } | undefined)?.merged !== undefined);
        const merged = Boolean((pr?.facts as { merged?: boolean } | undefined)?.merged);
        return { conditionId: c.id, met: merged, confidence: pr ? 0.97 : 0.85, reasoning: pr ? (merged ? "GitHub reports the pull request is merged." : "GitHub reports the pull request is not merged yet.") : "No GitHub pull request link was submitted.", evidenceIds: pr ? [pr.id] : [] };
      }
      case "approval":
        return { conditionId: c.id, met: false, confidence: 0.5, reasoning: "This condition is subjective, so the payer needs to approve it.", evidenceIds: [] };
      default: {
        const ok = texts.trim().length > 40 || sub.items.length > 0;
        return { conditionId: c.id, met: ok, confidence: ok ? 0.7 : 0.85, reasoning: ok ? "A written explanation was provided; the rules engine can't judge its quality." : "No written explanation was provided.", evidenceIds: [] };
      }
    }
  });

  const met = findings.filter((f) => f.met).length;
  return {
    findings,
    injection,
    injectionNote: injection ? `"${injectedItem?.name ?? "the note"}" contains text addressed to the verifier. It was ignored.` : undefined,
    summary: injection
      ? "Some evidence tried to instruct the verifier, so this milestone needs the payer's review."
      : `${met} of ${findings.length} conditions met by rule-based checks.`,
  };
}

export function offlineArbitrate(m: Milestone) {
  const f = m.verdict?.findings ?? [];
  const share = f.length ? f.filter((x) => x.met).length / f.length : 0.5;
  const pct = Math.round((share * 100) / 5) * 5;
  return {
    payeePercent: pct,
    reasoning: `Rule-based ruling: ${f.filter((x) => x.met).length} of ${f.length || "?"} conditions were verified, so ${pct}% of the milestone goes to the payee and the rest returns to the payer. With an AI key configured, the arbiter weighs both statements instead.`,
    citations: f.map((x) => `${m.conditions.find((c) => c.id === x.conditionId)?.text}: ${x.met ? "met" : "not met"}`),
  };
}
