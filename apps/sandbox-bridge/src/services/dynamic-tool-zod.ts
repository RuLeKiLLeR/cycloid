import { z } from "zod";

type JsonSchema = Record<string, unknown>;
export type ZodRawShape = Record<string, z.ZodType>;

export function zodForJsonSchema(schema: JsonSchema | undefined): z.ZodType {
  if (!schema) return z.unknown();
  const type = schema.type;
  if (Array.isArray(type)) {
    const variants = type.map((entry) => zodForJsonSchema({ ...schema, type: entry }));
    if (variants.length === 0) return z.unknown();
    if (variants.length === 1) return variants[0]!;
    return z.union(variants as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  }
  switch (type) {
    case "string":
      return z.string();
    case "integer":
      return z.number().int();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "null":
      return z.null();
    case "array": {
      const items =
        typeof schema.items === "object" && schema.items !== null ? (schema.items as JsonSchema) : undefined;
      return z.array(zodForJsonSchema(items));
    }
    case "object":
      return z.object(jsonSchemaPropertiesToZodShape(schema));
    default:
      return z.unknown();
  }
}

export function jsonSchemaPropertiesToZodShape(schema: JsonSchema): ZodRawShape {
  const properties =
    typeof schema.properties === "object" && schema.properties !== null && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, JsonSchema>)
      : {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((item) => typeof item === "string") : [],
  );
  const shape: ZodRawShape = {};
  for (const [name, propertySchema] of Object.entries(properties)) {
    const value = zodForJsonSchema(propertySchema);
    shape[name] = required.has(name) ? value : value.optional();
  }
  return shape;
}
