// Text forms: the document as text (spec 27.5, used for `rendered`, the
// timeline item and clients without the plugin) and the delivery message the
// agent receives (spec 8.4).

import {
  type Block,
  type ChoiceQuestion,
  type PlanStep,
  type Question,
  type ReviewQuestion,
  type SurfaceDocument,
  blockId,
  optionParts,
  reviewItems,
  reviewVerdicts,
  viewBlocks,
} from "./document";
import { deliveryHeader, utf8Bytes } from "./ids";
import { LIMITS } from "./limits";

export interface ChangeFile {
  id: string;
  path: string;
  status: "added" | "changed" | "removed" | "renamed";
  oldPath?: string;
  added: number;
  removed: number;
  hunks?: { id: string; header: string }[];
}

/** Evidence the server loaded, keyed by block id. Without it a block shows what the agent wrote. */
export interface RenderContext {
  changes?: Record<string, ChangeFile[]>;
  code?: Record<string, string>;
}

const MINUS = "−";

/** Evidence is keyed by block id; an id like `constructor` must not find an inherited property. */
function own<T>(dict: Record<string, T> | undefined, key: string): T | undefined {
  return dict && Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : undefined;
}

function planLines(steps: PlanStep[], indent: string, out: string[]): void {
  for (const step of steps) {
    const parts = [step.id, step.title, `[${step.status ?? "todo"}]`];
    if (step.ref) parts.push(step.ref);
    if (step.files !== undefined) parts.push("files " + (Array.isArray(step.files) ? step.files : [step.files]).join(", "));
    if (step.after && step.after.length) parts.push("after " + step.after.join(", "));
    out.push(indent + parts.join("  "));
    if (step.detail) out.push(indent + "  " + step.detail.split("\n").join("\n" + indent + "  "));
    if (step.children) planLines(step.children, indent + "  ", out);
  }
}

function codeRange(file: string, from?: number, to?: number): string {
  if (from === undefined && to === undefined) return file;
  return `${file}:${from ?? 1}${to !== undefined ? "-" + to : "-"}`;
}

function blockText(block: Block, ctx: RenderContext): string {
  if (typeof block === "string") return block;
  const id = blockId(block) as string;
  const head = block.title ? `${id}: ${block.title}` : id;
  const out: string[] = [head];
  if (block.t === "plan") {
    planLines(block.steps, "  ", out);
  } else if (block.t === "code") {
    if (block.file) out.push("  " + codeRange(block.file, block.from, block.to));
    const body = block.s ?? own(ctx.code, id);
    if (body !== undefined) out.push("```" + (block.lang ?? (block.diff ? "diff" : "")), body.replace(/\n$/, ""), "```");
  } else {
    out.push("  " + (block.of ?? "worktree") + (block.paths?.length ? "  " + block.paths.join(", ") : ""));
    const files = own(ctx.changes, id);
    if (!files) out.push("  (files are read when the surface is shown)");
    for (const file of files ?? []) {
      const name = file.status === "renamed" && file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path;
      const tag = file.status === "changed" ? "" : `  [${file.status}]`;
      out.push(`  ${file.id}  ${name}  +${file.added} ${MINUS}${file.removed}${tag}`);
      for (const hunk of file.hunks ?? []) out.push(`    ${hunk.id}  ${hunk.header}`);
    }
  }
  return out.join("\n");
}

function recommendedIds(q: ChoiceQuestion): string[] {
  if (q.recommend === undefined) return [];
  return Array.isArray(q.recommend) ? q.recommend : [q.recommend];
}

function questionText(q: Question, number: number, showTarget: boolean): string {
  const out: string[] = [];
  if (q.kind === "choice") {
    let pick = "";
    if (q.multi) {
      const lo = q.min ?? 0;
      pick = q.max === undefined ? (lo ? `, pick at least ${lo}` : ", pick several") : lo === q.max ? `, pick ${lo}` : `, pick ${lo} to ${q.max}`;
    }
    out.push(`${number}. ${q.id}: ${q.prompt}${pick}${q.other === false ? ", no custom answer" : ""}`);
    const parts = q.options.map(optionParts);
    const width = Math.max(...parts.map((p) => p.id.length));
    const rec = recommendedIds(q);
    parts.forEach((p, i) => {
      const name = p.detail ? `${p.label}: ${p.detail}` : p.label;
      const same = p.label === p.id && !p.detail;
      const idCol = same ? "" : p.id.padEnd(width) + "  ";
      const line = `   ${String.fromCharCode(97 + i)}. ${idCol}${same ? p.label : name}`;
      out.push(rec.includes(p.id) ? `${line}  (recommended)` : line);
    });
  } else if (q.kind === "text") {
    const rec = q.recommend === undefined ? "" : `  (recommended: ${JSON.stringify(q.recommend)})`;
    out.push(`${number}. ${q.id}: ${q.prompt}, text${q.multiline ? " (long)" : ""}${rec}`);
  } else {
    const verdicts = reviewVerdicts(q).join(" | ");
    let rec = "";
    if (typeof q.recommend === "string") rec = `  (recommended: ${q.recommend})`;
    else if (q.recommend) {
      rec = `  (recommended: ${Object.keys(q.recommend).map((k) => `${k} ${(q.recommend as Record<string, string>)[k]}`).join(", ")})`;
    }
    const target = showTarget && q.of ? `, of ${q.of}` : "";
    out.push(`${number}. ${q.id}: ${q.prompt}${target}, per item: ${verdicts}${rec}`);
    if (q.items) {
      for (const item of reviewItems(q as ReviewQuestion)) {
        out.push(`   ${item.id}  ${item.title}${item.ref ? "  " + item.ref : ""}`);
        if (item.detail) out.push("      " + item.detail.split("\n").join("\n      "));
      }
    }
  }
  return out.join("\n");
}

/**
 * The document's text form (spec 27.5).
 *
 * Every field the validator accepts is rendered except these, which carry no
 * reading content: `v`; `submit` (button label and mode); a question's `label`
 * (the short name used in deliveries; the id and prompt are shown), `note` and
 * a review's `comment` (flags for what the form offers); a text question's
 * `placeholder`; `after` ids are shown but `children` nesting is by indent.
 */
export function renderText(doc: SurfaceDocument, ctx: RenderContext = {}): string {
  const head = [doc.summary];
  if (doc.context) head.push(doc.context);
  if (doc.meanwhile === "other_work") head.push("Meanwhile: carry on with work that does not depend on the answers.");
  if (doc.revises) head.push(`Revises ${doc.revises}.`);
  const blocks = viewBlocks(doc);
  const sections = [head.join("\n")];
  for (const block of blocks) sections.push(blockText(block, ctx));
  // A review's target is named only when more than one block has items to review;
  // with one, "of" can only mean that block (and spec 27.5's example omits it).
  const showTarget = blocks.filter((b) => typeof b !== "string" && (b.t === "plan" || b.t === "changes")).length > 1;
  if (doc.questions?.length) sections.push(doc.questions.map((q, i) => questionText(q, i + 1, showTarget)).join("\n"));
  return sections.join("\n\n");
}

/** Cuts the text to the `rendered` limit at a line boundary, with a note (spec 27.4). */
export function truncateRendered(text: string, maxBytes: number = LIMITS.renderedBytes): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  let used = 0;
  const reserve = 64;
  for (const line of lines) {
    const next = utf8Bytes(line) + 1;
    if (used + next > maxBytes - reserve) break;
    kept.push(line);
    used += next;
  }
  const dropped = lines.length - kept.length;
  return `${kept.join("\n")}\n[cut: ${dropped} more line${dropped === 1 ? "" : "s"} not shown]`;
}

// --- delivery message (spec 8.4) ---------------------------------------------

export interface DeliveredItem {
  id: string;
  /** Absent when the item was skipped. */
  verdict?: string;
  comment?: string;
  skipped?: boolean;
}

export interface DeliveredAnswer {
  /** The question's label (`label`, else `prompt`). */
  label: string;
  skipped?: boolean;
  /** Labels of the chosen options, or the text answer. */
  values?: string[];
  /** A custom "Other" answer. */
  other?: string;
  byRecommended?: boolean;
  note?: string;
  /** Per-item verdicts of a `review`. */
  items?: DeliveredItem[];
}

export interface DeliveredComment {
  /** "plan step", "changed file", "item" (see `itemNoun`). */
  noun: string;
  id: string;
  /** The item's title, so a comment is understood without the document. */
  title?: string;
  text: string;
}

export type StillOpen = { label: string } | { noun: string; ids: string[] };

export interface DeliveryInput {
  surfaceId: string;
  delivery: number;
  /** Only what is new since the previous delivery. */
  answers: DeliveredAnswer[];
  comments: DeliveredComment[];
  stillOpen: StillOpen[];
}

/** What a block's items are called in a delivery message. */
export function itemNoun(blockType: string): string {
  if (blockType === "plan") return "plan step";
  if (blockType === "changes") return "changed file";
  return "item";
}

function indentContinuation(text: string): string {
  return text.split("\n").join("\n  ");
}

function answerLines(a: DeliveredAnswer): string[] {
  if (a.skipped) return [`${a.label} → skipped (no decision; not approval)`];
  let value: string;
  if (a.items) {
    value = a.items
      .map((item) => {
        const base = item.skipped ? `${item.id} skipped` : `${item.id} ${item.verdict ?? ""}`.trimEnd();
        return item.comment ? `${base}: ${JSON.stringify(item.comment)}` : base;
      })
      .join("; ");
  } else {
    const parts = [...(a.values ?? [])];
    if (a.other !== undefined) parts.push(`Other: ${a.other}`);
    value = indentContinuation(parts.join(", "));
  }
  const suffix = a.byRecommended ? " (your recommendation)" : "";
  const lines = [`${a.label} → ${value}${suffix}`];
  if (a.note) lines.push(`  Note: ${indentContinuation(a.note)}`);
  return lines;
}

function openText(entry: StillOpen): string {
  if ("label" in entry) return entry.label;
  return `${entry.noun}${entry.ids.length === 1 ? "" : "s"} ${entry.ids.join(", ")}`;
}

/** The message the agent receives for one delivery (spec 8.4). */
export function deliveryMessage(input: DeliveryInput): string {
  const lines = [deliveryHeader(input.surfaceId, input.delivery)];
  for (const answer of input.answers) lines.push(...answerLines(answer));
  for (const comment of input.comments) {
    const title = comment.title ? ` (${comment.title})` : "";
    lines.push(`Comment on ${comment.noun} ${comment.id}${title}: ${indentContinuation(comment.text)}`);
  }
  if (input.stillOpen.length) lines.push(`Still open: ${input.stillOpen.map(openText).join("; ")}`);
  return lines.join("\n");
}
