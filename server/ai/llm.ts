// One structured-output call, two providers.
//
// Every AI step in Covenant is a single forced "tool call": the model must fill in a JSON form
// (the tool's input schema) rather than write prose. Claude does this with tool_choice;
// Gemini with function calling in mode ANY. Callers don't need to know which is in use.
import { config, markAiDegraded, aiName } from "../config.ts";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string }; title?: string };

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export class AiError extends Error {
  constructor(message: string, public retryable = false, public fatal = false) {
    super(message);
  }
}

type CallOpts = { system: string; content: ContentBlock[]; tool: ToolSpec; maxTokens?: number; temperature?: number };
type Result<T> = { input: T; model: string };

export async function callTool<T>(opts: CallOpts): Promise<Result<T>> {
  const run = config.ai.provider === "gemini" ? gemini<T> : claude<T>;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await run(opts);
    } catch (e) {
      lastErr = e;
      if (e instanceof AiError && e.fatal) {
        // Key, billing or quota problems won't fix themselves: use the rules engine for a while.
        markAiDegraded(e.message);
        throw e;
      }
      if (e instanceof AiError && !e.retryable) throw e;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1) ** 2));
    }
  }
  markAiDegraded(lastErr instanceof Error ? lastErr.message : "unreachable", 2 * 60 * 1000);
  throw lastErr instanceof Error ? lastErr : new AiError(`${aiName()} request failed`);
}

// ---------------------------------------------------------------- Claude (Anthropic Messages API)
async function claude<T>(opts: CallOpts): Promise<Result<T>> {
  const res = await fetch(`${config.ai.base}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": config.ai.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: config.ai.model,
      max_tokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature ?? 0,
      system: opts.system,
      messages: [{ role: "user", content: opts.content }],
      tools: [opts.tool],
      tool_choice: { type: "tool", name: opts.tool.name },
    }),
  });
  if (res.status === 429 || res.status >= 500) throw new AiError(`Claude API ${res.status}`, true);
  const json = (await res.json()) as { model: string; content: { type: string; name?: string; input?: unknown }[]; error?: { message: string } };
  if (!res.ok) {
    const msg = json.error?.message ?? `Claude API error ${res.status}`;
    throw new AiError(msg, false, res.status === 401 || res.status === 403 || /credit|billing|quota|permission/i.test(msg));
  }
  const block = json.content.find((b) => b.type === "tool_use" && b.name === opts.tool.name);
  if (!block) throw new AiError("Claude did not return structured output", true);
  return { input: block.input as T, model: json.model };
}

// ---------------------------------------------------------------- Gemini (Google Generative Language API)

/** Gemini accepts an OpenAPI-style subset of JSON Schema: no type unions, "nullable" instead. */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const s = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "type") {
      if (Array.isArray(v)) {
        const types = v.filter((t) => t !== "null");
        out.type = types.length === 1 ? types[0] : "string"; // e.g. ["string","number"] → string
        if (v.includes("null")) out.nullable = true;
      } else out.type = v;
    } else if (k === "properties") {
      out.properties = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    } else if (k === "items") {
      out.items = toGeminiSchema(v);
    } else if (["description", "enum", "required", "nullable", "format", "minItems", "maxItems", "minimum", "maximum"].includes(k)) {
      out[k] = v;
    }
  }
  return out;
}

function toGeminiParts(content: ContentBlock[]) {
  return content.map((b) =>
    b.type === "text"
      ? { text: b.text }
      : b.type === "image"
        ? { inlineData: { mimeType: b.source.media_type, data: b.source.data } }
        : { inlineData: { mimeType: "application/pdf", data: b.source.data } },
  );
}

// Structured extraction doesn't need deep reasoning; low thinking keeps compile/verify to a few seconds.
// Set GEMINI_THINKING= (empty) to use the model default. Dropped automatically if a model rejects it.
let thinkingLevel: string | null = process.env.GEMINI_THINKING ?? "low";

async function gemini<T>(opts: CallOpts): Promise<Result<T>> {
  const model = config.ai.model;
  const res = await geminiRequest(model, opts);
  return parseGemini<T>(res, model, opts);
}

async function geminiRequest(model: string, opts: CallOpts): Promise<Response> {
  const send = () => fetch(`${config.ai.base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": config.ai.apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: opts.system }] },
      contents: [{ role: "user", parts: toGeminiParts(opts.content) }],
      tools: [{ functionDeclarations: [{ name: opts.tool.name, description: opts.tool.description, parameters: toGeminiSchema(opts.tool.input_schema) }] }],
      toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [opts.tool.name] } },
      // Room for the model's internal reasoning as well as the answer.
      generationConfig: {
        // Gemini 3 models are tuned for the default temperature; forcing 0 can make them loop and slow down.
        ...(/gemini-[3-9]/.test(model) ? {} : { temperature: opts.temperature ?? 0 }),
        maxOutputTokens: Math.max(8192, (opts.maxTokens ?? 4096) * 2),
        ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
      },
    }),
  });
  let res = await send();
  if (res.status === 400 && thinkingLevel) {
    const body = await res.clone().text();
    if (/thinking/i.test(body)) {
      thinkingLevel = null;
      res = await send();
    }
  }
  return res;
}

async function parseGemini<T>(res: Response, model: string, opts: CallOpts): Promise<Result<T>> {
  const json = (await res.json().catch(() => ({}))) as {
    candidates?: { content?: { parts?: { functionCall?: { name: string; args: unknown } }[] }; finishReason?: string }[];
    modelVersion?: string;
    error?: { code: number; message: string; status: string; details?: { reason?: string }[] };
    promptFeedback?: { blockReason?: string };
  };
  if (!res.ok) {
    const msg = json.error?.message ?? `Gemini API error ${res.status}`;
    const status = `${json.error?.status ?? ""} ${(json.error?.details ?? []).map((d) => d.reason ?? "").join(" ")}`;
    // 429 is usually the free tier's per-minute limit: worth retrying. A daily quota is not.
    if (res.status === 429 && !/per day|daily/i.test(msg)) throw new AiError(`Gemini rate limit: ${msg}`, true);
    if (res.status >= 500) throw new AiError(`Gemini API ${res.status}`, true);
    throw new AiError(msg, false, res.status === 401 || res.status === 403 || res.status === 429 || /API_KEY_INVALID|API key not valid|PERMISSION_DENIED|UNAUTHENTICATED|billing|quota/i.test(`${status} ${msg}`));
  }
  if (json.promptFeedback?.blockReason) throw new AiError(`Gemini declined the request (${json.promptFeedback.blockReason})`);
  const call = json.candidates?.[0]?.content?.parts?.find((p) => p.functionCall?.name === opts.tool.name)?.functionCall;
  if (!call) throw new AiError(`Gemini did not return structured output (${json.candidates?.[0]?.finishReason ?? "no candidate"})`, true);
  return { input: call.args as T, model: json.modelVersion ?? model };
}
