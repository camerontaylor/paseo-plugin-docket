import { describe, expect, it } from "vitest";
import { LIMITS, TOOL_SCHEMA_MAX_BYTES } from "./limits";
import { utf8Bytes } from "./ids";
import { SHOW_INPUT_SCHEMA, showSchemaBytes } from "./tool-schema";

describe("docket_show input schema (D7)", () => {
  it("serialises to at most 4,000 bytes", () => {
    const bytes = utf8Bytes(JSON.stringify(SHOW_INPUT_SCHEMA));
    expect(bytes).toBeLessThanOrEqual(TOOL_SCHEMA_MAX_BYTES);
    expect(showSchemaBytes()).toBe(bytes);
    expect(TOOL_SCHEMA_MAX_BYTES).toBe(4000);
  });

  it("has no root oneOf, anyOf or allOf", () => {
    const root = SHOW_INPUT_SCHEMA as Record<string, unknown>;
    for (const key of ["oneOf", "anyOf", "allOf"]) expect(root[key]).toBeUndefined();
    expect(root.type).toBe("object");
  });

  it("takes only `surface`, as an object or a string", () => {
    const root = SHOW_INPUT_SCHEMA as any;
    expect(root.required).toEqual(["surface"]);
    expect(Object.keys(root.properties)).toEqual(["surface"]);
    expect(root.properties.surface.type).toEqual(["object", "string"]);
  });

  it("states the limits it mentions", () => {
    expect(LIMITS.questions).toBe(12);
  });
});
