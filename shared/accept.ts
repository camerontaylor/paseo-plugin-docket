// What `docket_show` accepts (plan D6): the document as an object or as a JSON
// string, from the first build, so the shape experiment measures and does not gate.

import { utf8Bytes } from "./ids";
import { type ValidateOptions, type ValidationResult, validateDocument } from "./validate";

function fail(pointer: string, message: string): ValidationResult {
  return { ok: false, problems: [{ pointer, message }], warnings: [] };
}

/** Accepts a document given as an object or as the JSON text of one. */
export function acceptDocument(input: unknown, options: ValidateOptions = {}): ValidationResult {
  if (typeof input !== "string") return validateDocument(input, options);
  const text = input.replace(/^﻿/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const fenced = text.startsWith("```") ? " Send the JSON only, without a code fence." : "";
    return fail("", `the document string is not valid JSON (${reason}).${fenced}`);
  }
  if (typeof parsed === "string") {
    return fail("", "the document string holds a JSON string, not an object; encode the object once");
  }
  return validateDocument(parsed, { ...options, sourceBytes: utf8Bytes(text) });
}

/**
 * Accepts the `docket_show` tool input, `{"surface": document}`. Pointers in
 * the result are relative to the document, not to this wrapper.
 */
export function acceptToolInput(input: unknown, options: ValidateOptions = {}): ValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail("", 'the input must be an object: {"surface": <document>}');
  }
  const record = input as Record<string, unknown>;
  if (record.surface === undefined) {
    return fail("", '`surface` is required: {"surface": <document as an object or a JSON string>}');
  }
  const result = acceptDocument(record.surface, options);
  const extra = Object.keys(record).filter((key) => key !== "surface");
  if (extra.length === 0) return result;
  return {
    ...result,
    ok: false,
    document: undefined,
    problems: [
      ...result.problems,
      ...extra.map((key) => ({
        pointer: "",
        message: `the input has an unknown field \`${key}\`; the only field is \`surface\``,
      })),
    ],
  };
}

/** The tool result's problem list, one line per problem (spec 10.1: every problem, with its pointer). */
export function formatProblems(result: Pick<ValidationResult, "problems" | "warnings">): string {
  const lines: string[] = [];
  if (result.problems.length) {
    lines.push(`Nothing was shown: ${result.problems.length} problem${result.problems.length === 1 ? "" : "s"}.`);
    for (const p of result.problems) lines.push(`- ${p.pointer === "" ? "(document)" : p.pointer}: ${p.message}`);
  }
  if (result.warnings.length) {
    lines.push("Warnings:");
    for (const w of result.warnings) lines.push(`- ${w.pointer === "" ? "(document)" : w.pointer}: ${w.message}`);
  }
  return lines.join("\n");
}
