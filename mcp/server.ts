#!/usr/bin/env -S npx tsx
// Covenant MCP server (stdio). Lets any MCP client — Claude Desktop, Claude Code, Cursor, an agent framework —
// create escrowed contracts, deliver work and get paid through Covenant's PayPal-backed API.
// Money only moves after a human approves the PayPal authorization in the browser.
//
// Config: COVENANT_URL (default http://localhost:8787)
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { createInterface } from "node:readline";

const BASE = (process.env.COVENANT_URL ?? "http://localhost:8787").replace(/\/$/, "");

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json",
};

async function http(method: string, path: string, key?: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(key ? { "x-covenant-key": key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(json.error ?? `Covenant returned ${res.status}`);
  return json;
}

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

function describe(c: any) {
  const lines = [
    `${c.title} — ${money(c.totalCents)} — status: ${c.status}`,
    `Agreement: ${c.summary}`,
    ...c.milestones.map(
      (m: any) =>
        `  [${m.id}] ${m.index + 1}. ${m.title} — ${money(m.amountCents)} — ${m.status}${m.deadline ? ` — due ${m.deadline.slice(0, 10)}` : ""}\n` +
        m.conditions.map((x: any) => `       - ${x.text} (${x.kind})`).join("\n") +
        (m.verdict ? `\n       verdict: ${m.verdict.outcome} — ${m.verdict.summary}` : "") +
        (m.settlement ? `\n       paid: ${money(m.settlement.netCents)}` : ""),
    ),
  ];
  if (c.ambiguities?.length) lines.push(`Open questions: ${c.ambiguities.join(" | ")}`);
  return lines.join("\n");
}

const tools = [
  {
    name: "create_covenant",
    description:
      "Compile a plain-English payment agreement into an escrowed Covenant contract settled on PayPal. Returns the contract, plus a payer link (for the human who funds it on PayPal) and a payee link/key (for whoever delivers the work). Use this when hiring someone or another agent for a task with clear deliverables.",
    inputSchema: {
      type: "object",
      required: ["deal"],
      properties: {
        deal: { type: "string", description: "The agreement in plain English, including amount, milestones, deadlines and penalties." },
        payee_email: { type: "string", description: "PayPal email the payee will be paid at." },
        payee_name: { type: "string" },
        payer_name: { type: "string" },
      },
    },
  },
  {
    name: "get_covenant",
    description: "Read a contract's current state: milestones, verification verdicts, payments.",
    inputSchema: { type: "object", required: ["contract_id", "key"], properties: { contract_id: { type: "string" }, key: { type: "string", description: "Payer or payee key." } } },
  },
  {
    name: "sign_covenant",
    description: "Sign the contract as the party the key belongs to. Both parties must sign before the payer can fund it.",
    inputSchema: { type: "object", required: ["contract_id", "key"], properties: { contract_id: { type: "string" }, key: { type: "string" } } },
  },
  {
    name: "submit_evidence",
    description:
      "As the payee, submit evidence for a milestone. Covenant's verifier checks it against the milestone's conditions and, if they're met, PayPal captures the funds and pays out immediately. Returns the verdict.",
    inputSchema: {
      type: "object",
      required: ["contract_id", "key", "milestone_id"],
      properties: {
        contract_id: { type: "string" },
        key: { type: "string", description: "Payee key." },
        milestone_id: { type: "string" },
        note: { type: "string", description: "What was delivered." },
        links: { type: "array", items: { type: "string" }, description: "URLs or GitHub pull request links." },
        file_paths: { type: "array", items: { type: "string" }, description: "Local files to upload (max 15 MB each)." },
      },
    },
  },
  {
    name: "open_dispute",
    description: "Open a dispute on a milestone that wasn't paid. An AI arbiter will weigh both sides and split the funds.",
    inputSchema: {
      type: "object",
      required: ["contract_id", "key", "milestone_id", "reason"],
      properties: { contract_id: { type: "string" }, key: { type: "string" }, milestone_id: { type: "string" }, reason: { type: "string" } },
    },
  },
];

async function callTool(name: string, a: any): Promise<string> {
  switch (name) {
    case "create_covenant": {
      const r = await http("POST", "/api/compile", undefined, {
        text: a.deal,
        origin: "mcp",
        payee: { name: a.payee_name, email: a.payee_email },
        payer: { name: a.payer_name },
      });
      const c = r.contract;
      return [
        describe(c),
        "",
        `contract_id: ${c.id}`,
        `payer_key: ${r.keys.payer}`,
        `payee_key: ${r.keys.payee}`,
        `Payer link (sign and fund with PayPal — a human must approve): ${BASE}/c/${c.id}?k=${r.keys.payer}`,
        `Payee link: ${BASE}/c/${c.id}?k=${r.keys.payee}`,
      ].join("\n");
    }
    case "get_covenant": {
      const r = await http("GET", `/api/contracts/${a.contract_id}`, a.key);
      return `You are the ${r.role}.\n${describe(r.contract)}`;
    }
    case "sign_covenant": {
      const r = await http("POST", `/api/contracts/${a.contract_id}/sign`, a.key, {});
      return `Signed.\n${describe(r.contract)}`;
    }
    case "submit_evidence": {
      const files = (a.file_paths ?? []).map((p: string) => {
        if (statSync(p).size > 15 * 1024 * 1024) throw new Error(`${p} is larger than 15 MB`);
        return { name: basename(p), mime: MIME[extname(p).toLowerCase()] ?? "application/octet-stream", dataBase64: readFileSync(p).toString("base64") };
      });
      const r = await http("POST", `/api/contracts/${a.contract_id}/milestones/${a.milestone_id}/evidence`, a.key, { note: a.note, links: a.links, files });
      const m = r.contract.milestones.find((x: any) => x.id === a.milestone_id);
      const findings = m.verdict?.findings
        .map((f: any) => `  ${f.met ? "✓" : "✗"} ${m.conditions.find((x: any) => x.id === f.conditionId)?.text} (${Math.round(f.confidence * 100)}%): ${f.reasoning}`)
        .join("\n");
      return `Milestone status: ${m.status}\n${m.verdict ? `Verdict: ${m.verdict.outcome} — ${m.verdict.summary}\n${findings}` : ""}${m.settlement ? `\nPaid out: ${money(m.settlement.netCents)} via PayPal` : ""}`;
    }
    case "open_dispute": {
      const r = await http("POST", `/api/contracts/${a.contract_id}/milestones/${a.milestone_id}/dispute`, a.key, { reason: a.reason });
      return `Dispute opened.\n${describe(r.contract)}`;
    }
  }
  throw new Error(`Unknown tool ${name}`);
}

// ---- minimal MCP JSON-RPC over stdio
const write = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  try {
    if (method === "initialize")
      return write({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "covenant", version: "1.0.0" },
          instructions: "Covenant creates escrowed agreements whose money is held on PayPal and released when evidence meets the agreed conditions.",
        },
      });
    if (method === "ping") return write({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return write({ jsonrpc: "2.0", id, result: { tools } });
    if (method === "tools/call") {
      try {
        const text = await callTool(params.name, params.arguments ?? {});
        return write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
      } catch (e) {
        return write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true } });
      }
    }
    write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    write({ jsonrpc: "2.0", id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
  }
});
