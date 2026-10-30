// Verifier evaluation: labelled cases → accuracy, unsafe payouts, injection detection.
// Run: npm run eval            (uses Claude if ANTHROPIC_API_KEY is set, else the rules engine)
//      npm run eval -- --offline   (force the rules engine for a baseline)
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const forceOffline = process.argv.includes("--offline");
if (forceOffline) process.env.ANTHROPIC_API_KEY = "";
process.env.DATA_DIR = process.env.DATA_DIR ?? join(dirname(fileURLToPath(import.meta.url)), ".data");

const { verifyMilestone } = await import("../server/ai/verifier.ts");
const { fileFacts } = await import("../server/facts.ts");
const { claudeLive, config } = await import("../server/config.ts");
const { CASES } = await import("./cases.ts");
import type { Contract, EvidenceItem, Milestone, Submission } from "../shared/types.ts";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const MIME: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf", svg: "image/svg+xml", csv: "text/csv", text: "text/plain" };

function fileItem(name: string, i: number): EvidenceItem {
  const path = join(FIX, name);
  const buf = readFileSync(path);
  const facts = fileFacts(buf, name);
  const mime = MIME[facts.detectedType] ?? "application/octet-stream";
  const texty = /^text\/|svg/.test(mime);
  return {
    id: `ev_${i}`,
    kind: /^image\/(png|jpeg|gif|webp)$/.test(mime) ? "image" : "file",
    name,
    mime,
    size: statSync(path).size,
    storedPath: path,
    excerpt: texty ? buf.toString("utf8").slice(0, 6000) : undefined,
    facts: { source: "file inspection", ...facts },
  };
}

type Row = { id: string; group: string; expected: "pay" | "no-pay"; got: string; condCorrect: number; condTotal: number; unsafe: boolean; missed: boolean; injExpected: boolean; injCaught: boolean; ms: number; summary: string };
const rows: Row[] = [];
const engine = claudeLive() ? `Claude (${config.ai.model})` : "rules engine (offline)";
console.log(`\nCovenant verifier eval — ${CASES.length} cases — ${engine}\n`);

for (const tc of CASES) {
  const m: Milestone = {
    id: "ms_eval", index: 0, title: tc.milestone, amountCents: 20000, status: "open", submissions: [],
    conditions: tc.conditions.map((c, i) => ({ id: `cd_${i}`, text: c.text, kind: c.kind })),
  };
  const c = {
    id: "cov_eval", title: tc.contract, summary: tc.contract, autoReleaseThreshold: 0.8, currency: "USD",
  } as unknown as Contract;
  const items: EvidenceItem[] = [
    ...(tc.files ?? []).map(fileItem),
    ...(tc.links ?? []).map((l, i) => ({ id: `ev_l${i}`, kind: "link" as const, name: l.name, url: l.url, excerpt: l.excerpt, facts: l.facts })),
    ...(tc.text ? [{ id: "ev_t", kind: "text" as const, name: "Written note", excerpt: tc.text }] : []),
  ];
  const sub: Submission = { id: "sub_eval", at: new Date().toISOString(), note: tc.note ?? "", items };
  const t0 = Date.now();
  const v = await verifyMilestone(c, m, sub);
  const ms = Date.now() - t0;
  const paid = v.outcome === "pass";
  let condCorrect = 0;
  let condTotal = 0;
  tc.conditions.forEach((cond, i) => {
    if (cond.kind === "approval") return;
    condTotal++;
    if (v.findings[i]?.met === cond.met) condCorrect++;
  });
  const r: Row = {
    id: tc.id, group: tc.group, expected: tc.expect, got: v.outcome, condCorrect, condTotal,
    unsafe: paid && tc.expect === "no-pay", missed: !paid && tc.expect === "pay",
    injExpected: Boolean(tc.injection), injCaught: Boolean(tc.injection) && v.injection, ms, summary: v.summary,
  };
  rows.push(r);
  const mark = r.unsafe ? "UNSAFE" : r.missed ? "missed" : "ok";
  console.log(`${mark.padEnd(7)} ${tc.id.padEnd(30)} expected ${tc.expect.padEnd(6)} got ${v.outcome.padEnd(9)} conditions ${condCorrect}/${condTotal}${tc.injection ? ` injection ${v.injection ? "caught" : "MISSED"}` : ""}  ${ms}ms`);
}

const sum = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0);
const decisions = rows.filter((r) => (r.got === "pass") === (r.expected === "pay")).length;
const condC = sum((r) => r.condCorrect);
const condT = sum((r) => r.condTotal);
const unsafe = rows.filter((r) => r.unsafe).length;
const missed = rows.filter((r) => r.missed).length;
const inj = rows.filter((r) => r.injExpected);
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "n/a");

const summary = [
  `| Metric | Result |`,
  `| --- | --- |`,
  `| Engine | ${engine} |`,
  `| Cases | ${rows.length} |`,
  `| Pay / don't-pay decisions correct | ${decisions}/${rows.length} (${pct(decisions, rows.length)}) |`,
  `| Individual conditions judged correctly | ${condC}/${condT} (${pct(condC, condT)}) |`,
  `| **Unsafe payouts** (paid when it shouldn't) | **${unsafe}** |`,
  `| Missed payouts (held good work for review) | ${missed} |`,
  `| Prompt injections caught | ${inj.filter((r) => r.injCaught).length}/${inj.length} |`,
  `| Median time per verification | ${rows.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)]} ms |`,
].join("\n");

console.log(`\n${summary}\n`);

const out = join(dirname(fileURLToPath(import.meta.url)), forceOffline || !claudeLive() ? "RESULTS-offline.md" : "RESULTS-claude.md");
writeFileSync(
  out,
  `# Verifier evaluation — ${engine}\n\nRun on ${new Date().toISOString().slice(0, 10)} with \`npm run eval${forceOffline ? " -- --offline" : ""}\`. Cases are defined in [cases.ts](cases.ts); evidence files are in [fixtures/](fixtures).\n\n${summary}\n\n## Per case\n\n| Case | Group | Expected | Verdict | Conditions | Notes |\n| --- | --- | --- | --- | --- | --- |\n${rows
    .map((r) => `| ${r.id} | ${r.group} | ${r.expected} | ${r.got}${r.unsafe ? " ⚠️ unsafe" : r.missed ? " (missed)" : ""} | ${r.condCorrect}/${r.condTotal} | ${r.summary.replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 160)} |`)
    .join("\n")}\n`,
);
console.log(`Wrote ${out}`);
