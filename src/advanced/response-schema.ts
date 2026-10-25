import type { ModelProviderConfig } from "../shared/types.js";

const schemaMaps = new Set(["$defs", "definitions", "properties", "patternProperties", "dependentSchemas", "dependencies"]);
const schemaArrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const schemaValues = new Set(["additionalProperties", "additionalItems", "contains", "contentSchema", "else", "if", "items", "not", "propertyNames", "then", "unevaluatedItems", "unevaluatedProperties"]);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Structured-output dialect limits per reasoning profile, advertised in
 * GET /v2/capabilities. The listed keywords are removed from the schema sent to
 * the provider; the full schema is still validated locally.
 */
export const STRUCTURED_OUTPUT_DIALECTS: ReadonlyArray<{
  reasoningProfile: NonNullable<ModelProviderConfig["reasoningProfile"]>;
  unsupportedKeywords: readonly string[];
}> = [{ reasoningProfile: "qwen-3.8", unsupportedKeywords: ["uniqueItems"] }];

/** Qwen's grammar compiler rejects uniqueItems; the full schema stays local. */
export function responseSchemaForProvider(schema: Record<string, unknown>, provider: Pick<ModelProviderConfig, "reasoningProfile">): Record<string, unknown> {
  const unsupported = STRUCTURED_OUTPUT_DIALECTS.find((dialect) => dialect.reasoningProfile === provider.reasoningProfile)?.unsupportedKeywords;
  if (unsupported == null || unsupported.length === 0) return schema;
  const visit = (value: unknown): unknown => {
    if (!object(value)) return value;
    return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
      if (unsupported.includes(key)) return [];
      if (schemaMaps.has(key) && object(child)) {
        // Map keys are literal property/definition names, not schema keywords.
        return [[key, Object.fromEntries(Object.entries(child).map(([name, definition]) => [name, visit(definition)]))]];
      }
      if (schemaArrays.has(key) && Array.isArray(child)) return [[key, child.map(visit)]];
      if (schemaValues.has(key)) return [[key, Array.isArray(child) ? child.map(visit) : visit(child)]];
      // const, enum, examples and other annotations contain data, not schemas.
      return [[key, child]];
    }));
  };
  return visit(schema) as Record<string, unknown>;
}
