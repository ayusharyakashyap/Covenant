// Compiles a plain-English deal into a structured, executable contract.
import { claudeLive, config } from "../config.ts";
import { callTool } from "./claude.ts";
import { offlineCompile } from "./offline.ts";
import type { ConditionKind } from "../../shared/types.ts";

export interface CompiledMilestone {
  title: string;
  amount: number;
  deadline: string | null;
  conditions: { text: string; kind: ConditionKind }[];
  late_penalty: { percent_per_day: number; max_percent: number } | null;
}

export interface CompiledContract {
  is_valid_agreement: boolean;
  rejection_reason?: string;
  title: string;
  summary: string;
  currency: string;
  total: number;
  payer: { name: string; email: string };
  payee: { name: string; email: string };
  milestones: CompiledMilestone[];
  ambiguities: string[];
  risks: string[];
}

const KINDS: ConditionKind[] = ["image", "file", "link", "github_pr", "text", "approval"];

const tool = {
  name: "emit_contract",
  description: "Emit the executable contract compiled from the user's plain-English deal.",
  input_schema: {
    type: "object",
    required: ["is_valid_agreement", "title", "summary", "currency", "total", "payer", "payee", "milestones", "ambiguities", "risks"],
    properties: {
      is_valid_agreement: {
        type: "boolean",
        description: "False if the text is not a payment agreement between two parties, or describes something illegal or harmful.",
      },
      rejection_reason: { type: "string" },
      title: { type: "string", description: "Short title, max 60 chars, e.g. 'Logo design for Brightside Bakery'" },
      summary: {
        type: "string",
        description: "The agreement restated in clear, neutral plain English that both parties will sign. 2-5 sentences. Mention amounts, conditions, deadlines and penalties exactly.",
      },
      currency: { type: "string", description: "ISO 4217 code. Default USD." },
      total: { type: "number", description: "Total amount in major units. Must equal the sum of milestone amounts." },
      payer: {
        type: "object",
        required: ["name", "email"],
        properties: { name: { type: "string" }, email: { type: "string", description: "Empty string if not stated." } },
      },
      payee: {
        type: "object",
        required: ["name", "email"],
        properties: { name: { type: "string" }, email: { type: "string", description: "Empty string if not stated." } },
      },
      milestones: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: {
          type: "object",
          required: ["title", "amount", "deadline", "conditions", "late_penalty"],
          properties: {
            title: { type: "string", description: "Short milestone name, e.g. 'Three concepts'" },
            amount: { type: "number" },
            deadline: {
              type: ["string", "null"],
              description: "ISO 8601 date-time at 23:59:59 in the stated or UTC timezone, resolved relative to today's date. null if none.",
            },
            conditions: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                required: ["text", "kind"],
                properties: {
                  text: {
                    type: "string",
                    description: "One objectively checkable condition. Make vague terms concrete but never invent requirements the parties didn't imply.",
                  },
                  kind: {
                    type: "string",
                    enum: KINDS,
                    description:
                      "Evidence that satisfies it: image (visual work), file (deliverable files/formats), link (live URL), github_pr (a pull request), text (written report), approval (subjective, needs the payer's sign-off).",
                  },
                },
              },
            },
            late_penalty: {
              type: ["object", "null"],
              required: ["percent_per_day", "max_percent"],
              properties: { percent_per_day: { type: "number" }, max_percent: { type: "number" } },
            },
          },
        },
      },
      ambiguities: {
        type: "array",
        items: { type: "string" },
        description: "Questions the parties should settle before signing, phrased as questions. Empty if none.",
      },
      risks: {
        type: "array",
        items: { type: "string" },
        description: "Short notes on terms that could cause a dispute, for either party. Max 3.",
      },
    },
  },
};

const system = `You are Covenant's contract compiler. You turn a plain-English deal between a payer and a payee into an executable escrow contract whose money is held on PayPal and released milestone by milestone.

Rules:
- Preserve the parties' intent exactly. Never add obligations, money or deadlines that are not stated or clearly implied.
- Each condition must be objectively checkable from evidence the payee can upload (images, files, links, GitHub PRs, written notes). If a condition is inherently subjective ("payer is happy with it"), use kind "approval".
- If the deal names a late penalty, attach it to the milestones it applies to. If a cap isn't stated, use 100 and mention it as an ambiguity.
- If no milestones are described, create a single milestone for the whole amount.
- Amounts must sum to the total. If the text is inconsistent, choose the most literal reading and list the inconsistency as an ambiguity.
- If no penalty is mentioned, late_penalty is null.
- Default currency USD. Default payer name "Client" and payee name "Freelancer" if not named.
- If the text is not a payment agreement, or the work is illegal or harmful, set is_valid_agreement false with a short rejection_reason and fill other fields minimally.`;

export async function compileDeal(text: string, now = new Date()): Promise<{ result: CompiledContract; engine: "claude" | "offline"; model?: string }> {
  if (!claudeLive()) return { result: offlineCompile(text, now), engine: "offline" };
  const { input, model } = await callTool<CompiledContract>({
    system,
    tool,
    maxTokens: 4000,
    content: [
      {
        type: "text",
        text: `Today's date is ${now.toISOString().slice(0, 10)} (${now.toLocaleDateString("en-US", { weekday: "long" })}).\n\n<deal>\n${text}\n</deal>`,
      },
    ],
  });
  for (const m of input.milestones) m.conditions = m.conditions.filter((c) => KINDS.includes(c.kind));
  return { result: input, engine: "claude", model: model ?? config.ai.model };
}
