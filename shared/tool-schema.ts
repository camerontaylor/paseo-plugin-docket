// The loose JSON schema of `docket_show`'s input (plan D7). It names the
// fields and their types and nothing more: the validator does the real
// checking and returns every problem. Kept under TOOL_SCHEMA_MAX_BYTES when
// serialised, with no root oneOf, anyOf or allOf (Codex compacts schemas over
// 5,000 bytes, removing descriptions first).

import { utf8Bytes } from "./ids";
import { TOOL_SCHEMA_MAX_BYTES } from "./limits";

const str = { type: "string" };
const bool = { type: "boolean" };
const strList = { type: "array", items: str };

export const SHOW_INPUT_SCHEMA = {
  type: "object",
  properties: {
    surface: {
      type: ["object", "string"],
      description: "The document: an object, or its JSON text.",
      properties: {
        v: { type: "integer", description: "Always 1" },
        summary: { ...str, description: "One sentence" },
        context: { ...str, description: "What you were doing and what the answers change; required with questions" },
        meanwhile: { type: "string", enum: ["stop", "other_work"] },
        revises: { ...str, description: "Id of a surface this one replaces" },
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: str,
              kind: { type: "string", enum: ["choice", "text", "review"] },
              prompt: str,
              label: str,
              recommend: { description: "Your choice, in the kind's answer format" },
              note: bool,
              options: { type: "array", description: "choice: strings or {id, label, detail}" },
              multi: bool,
              other: bool,
              min: { type: "integer" },
              max: { type: "integer" },
              multiline: bool,
              placeholder: str,
              of: { ...str, description: "review: id of a view block" },
              items: { type: "array", description: "review: titles or {id, title, detail}" },
              verdicts: strList,
              comment: bool,
            },
            required: ["id", "kind", "prompt"],
          },
        },
        view: {
          description: "Markdown strings and blocks: {t: plan|code|changes, ...}",
        },
        submit: { type: "object", properties: { label: str } },
      },
      required: ["v", "summary"],
    },
  },
  required: ["surface"],
} as const;

/** Serialised size of the schema, in UTF-8 bytes. */
export function showSchemaBytes(): number {
  return utf8Bytes(JSON.stringify(SHOW_INPUT_SCHEMA));
}

