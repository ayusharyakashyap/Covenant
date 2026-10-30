// Thin Claude Messages API client using forced tool calls for structured output.
import { config } from "../config.ts";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string }; title?: string };

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export class ClaudeError extends Error {}

export async function callTool<T>(opts: {
  system: string;
  content: ContentBlock[];
  tool: ToolSpec;
  maxTokens?: number;
  temperature?: number;
}): Promise<{ input: T; model: string }> {
  const body = {
    model: config.ai.model,
    max_tokens: opts.maxTokens ?? 4096,
    temperature: opts.temperature ?? 0,
    system: opts.system,
    messages: [{ role: "user", content: opts.content }],
    tools: [opts.tool],
    tool_choice: { type: "tool", name: opts.tool.name },
  };

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${config.ai.base}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": config.ai.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new ClaudeError(`Claude API ${res.status}`);
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1) ** 2));
        continue;
      }
      const json = (await res.json()) as {
        model: string;
        content: { type: string; name?: string; input?: unknown }[];
        error?: { message: string };
      };
      if (!res.ok) throw new ClaudeError(json.error?.message ?? `Claude API error ${res.status}`);
      const block = json.content.find((b) => b.type === "tool_use" && b.name === opts.tool.name);
      if (!block) throw new ClaudeError("Claude did not return structured output");
      return { input: block.input as T, model: json.model };
    } catch (e) {
      lastErr = e;
      if (e instanceof ClaudeError && !String(e.message).startsWith("Claude API 5")) throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new ClaudeError("Claude request failed");
}
