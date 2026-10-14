import { describe, expect, it } from "vitest";
import { responseSchemaForProvider } from "../src/advanced/response-schema.js";

describe("Qwen 3.8 structured output grammar", () => {
  it("removes only uniqueItems at schema positions, retaining names and literal data", () => {
    const literal = { uniqueItems: true, properties: { value: { uniqueItems: true } } };
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema", $comment: "keep metadata", type: "object",
      properties: {
        uniqueItems: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
        confidence: { type: "number", minimum: 0, maximum: 100 },
        data: { const: literal, enum: [literal], examples: [literal] },
      },
      $defs: { uniqueItems: { type: "array", uniqueItems: false, items: { $ref: "#/$defs/nested" } }, nested: { type: "string" } },
      required: ["uniqueItems"], additionalProperties: false,
      allOf: [{ properties: { extra: { type: "array", uniqueItems: true } } }],
      dependentSchemas: { uniqueItems: { properties: { extra: { uniqueItems: true } } } },
      dependencies: { literal: ["uniqueItems"], schema: { uniqueItems: true } },
      items: [{ uniqueItems: true }], contains: { uniqueItems: true },
    };
    const before = structuredClone(schema);
    const result = responseSchemaForProvider(schema, { reasoningProfile: "qwen-3.8" });
    expect(result).toEqual({
      ...schema,
      properties: { ...schema.properties, uniqueItems: { type: "array", items: { type: "string", minLength: 1 } } },
      $defs: { ...schema.$defs, uniqueItems: { type: "array", items: { $ref: "#/$defs/nested" } } },
      allOf: [{ properties: { extra: { type: "array" } } }],
      dependentSchemas: { uniqueItems: { properties: { extra: {} } } },
      dependencies: { literal: ["uniqueItems"], schema: {} }, items: [{}], contains: {},
    });
    expect(schema).toEqual(before);
  });

  it.each([undefined, "claude", "codex", "glm-5.2", "qwen-3.6"] as const)("keeps schemas unchanged for profile %s", (reasoningProfile) => {
    const schema = { type: "array", uniqueItems: true };
    expect(responseSchemaForProvider(schema, reasoningProfile === undefined ? {} : { reasoningProfile })).toBe(schema);
  });
});
