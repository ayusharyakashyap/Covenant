import { test } from "node:test";
import assert from "node:assert/strict";
import { toGeminiSchema } from "./ai/llm.ts";

test("JSON Schema is converted to Gemini's accepted subset", () => {
  const out = toGeminiSchema({
    type: "object",
    additionalProperties: false,
    required: ["deadline"],
    properties: {
      deadline: { type: ["string", "null"], description: "ISO date" },
      value: { type: ["string", "number"] },
      penalty: { type: ["object", "null"], properties: { pct: { type: "number", minimum: 0 } } },
      tags: { type: "array", items: { type: "string", enum: ["a", "b"] } },
    },
  }) as any;
  assert.equal(out.additionalProperties, undefined);
  assert.deepEqual(out.properties.deadline, { type: "string", description: "ISO date", nullable: true });
  assert.equal(out.properties.value.type, "string");
  assert.equal(out.properties.penalty.nullable, true);
  assert.equal(out.properties.penalty.properties.pct.minimum, 0);
  assert.deepEqual(out.properties.tags.items.enum, ["a", "b"]);
  const walk = (s: any): void => {
    if (!s || typeof s !== "object") return;
    if ("type" in s) assert.equal(typeof s.type, "string");
    Object.values(s.properties ?? {}).forEach(walk);
    walk(s.items);
  };
  walk(out);
});
