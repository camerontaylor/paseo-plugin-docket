// Validation of a stage-1 surface document (spec sections 14, 27). It returns
// every problem, each with a JSON pointer into the document, plus the
// non-blocking warnings. Pointers are relative to the document itself, not to
// the tool input that wrapped it.

import type { SurfaceDocument } from "./document";
import { charCount, isItemId, isOptionId, isSurfaceId, utf8Bytes } from "./ids";
import { LIMITS } from "./limits";

export interface Problem {
  /** RFC 6901 JSON pointer; "" is the document itself. */
  pointer: string;
  message: string;
  /** Set when the thing is real but planned for a later stage. */
  stage?: 2 | 3;
}

export interface Warning {
  pointer: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  /** Present only when `ok`. */
  document?: SurfaceDocument;
  problems: Problem[];
  warnings: Warning[];
}

export interface ValidateOptions {
  /** Looks up `revises`; without it only the id's format is checked. */
  resolveRevises?: (id: string) => "ok" | "missing" | "foreign";
  /** Size of the text the document came from, when it was a string. */
  sourceBytes?: number;
}

type Obj = Record<string, unknown>;

const QUESTION_KINDS_STAGE_1 = ["choice", "text", "review"];
const QUESTION_KINDS_STAGE_2 = ["number", "boolean", "date", "rank", "edit"];
const BLOCKS_STAGE_1 = ["plan", "code", "changes"];
const BLOCKS_STAGE_2 = ["map", "findings", "table", "compare", "chart", "columns", "details", "card", "ask"];
const BLOCKS_STAGE_3 = ["canvas"];
const STEP_STATUSES = ["todo", "doing", "done", "blocked"];

const DOC_FIELDS = ["v", "summary", "context", "meanwhile", "revises", "questions", "view", "submit"];
const DOC_LATER: Record<string, 2 | 3> = { until: 2, use: 3 };
const QUESTION_FIELDS = ["id", "kind", "prompt", "label", "recommend", "note"];
const CHOICE_FIELDS = ["options", "multi", "other", "min", "max"];
const TEXT_FIELDS = ["multiline", "placeholder"];
const REVIEW_FIELDS = ["of", "items", "verdicts", "comment"];
const OPTION_FIELDS = ["id", "label", "detail"];
const OPTION_LATER: Record<string, 2 | 3> = { preview: 2 };
const REVIEW_ITEM_FIELDS = ["id", "title", "detail", "ref"];
const STEP_FIELDS = ["id", "title", "detail", "status", "ref", "files", "after", "children"];
const ITEM_LATER: Record<string, 2 | 3> = { links: 2 };
const BLOCK_LATER: Record<string, 2 | 3> = { q: 2 };

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;
const tick = (s: string): string => "`" + s + "`";
const quoted = (list: string[]): string => list.map(tick).join(", ");

/** Escapes one token of a JSON pointer (RFC 6901). */
export function pointerToken(token: string | number): string {
  return "/" + String(token).replace(/~/g, "~0").replace(/\//g, "~1");
}

function stageMessage(name: string, stage: 2 | 3, hint?: string): string {
  return `${tick(name)} is not available yet (planned for stage ${stage})${hint ? "; " + hint : ""}`;
}

interface BlockInfo {
  pointer: string;
  type: string;
  /** Item ids when known now; undefined for `changes`, whose items are loaded later. */
  itemIds?: string[];
}

interface Collector {
  problems: Problem[];
  warnings: Warning[];
  problem: (pointer: string, message: string, stage?: 2 | 3) => void;
  warn: (pointer: string, message: string) => void;
}

function newCollector(): Collector {
  const problems: Problem[] = [];
  const warnings: Warning[] = [];
  return {
    problems,
    warnings,
    problem(pointer, message, stage) {
      problems.push(stage ? { pointer, message, stage } : { pointer, message });
    },
    warn(pointer, message) {
      warnings.push({ pointer, message });
    },
  };
}

/** Reports unknown fields and fields that belong to a later stage. */
function checkFields(c: Collector, obj: Obj, at: string, known: string[], later: Record<string, 2 | 3>): void {
  for (const key of Object.keys(obj)) {
    if (known.includes(key)) continue;
    const stage = later[key];
    if (stage) c.problem(at + pointerToken(key), stageMessage(key, stage), stage);
    else c.problem(at + pointerToken(key), `unknown field ${tick(key)}; known fields: ${quoted(known)}`);
  }
}

function checkText(
  c: Collector,
  at: string,
  value: unknown,
  name: string,
  max?: number,
  required = true,
): value is string {
  if (typeof value !== "string") {
    c.problem(at, `${tick(name)} must be a string`);
    return false;
  }
  if (required && value.trim() === "") {
    c.problem(at, `${tick(name)} must not be empty`);
    return false;
  }
  if (max !== undefined && charCount(value) > max) {
    c.problem(at, `${tick(name)} is over ${max} characters`);
    return false;
  }
  return true;
}

function checkBool(c: Collector, at: string, value: unknown, name: string): void {
  if (typeof value !== "boolean") c.problem(at, `${tick(name)} must be true or false`);
}

function checkId(c: Collector, at: string, value: unknown, what: string): value is string {
  if (typeof value !== "string" || value === "") {
    c.problem(at, `${what} id is required and must be a string`);
    return false;
  }
  if (!isItemId(value)) {
    c.problem(
      at,
      `${what} id ${JSON.stringify(value)} is invalid: use lowercase letters, digits and underscores, starting with a letter, at most ${LIMITS.idLength} characters, no dots`,
    );
    return false;
  }
  return true;
}

/** `path:line` or `path:from-to` (spec 7.4). Whether the file exists is S3's job. */
function checkRef(c: Collector, at: string, value: unknown): void {
  if (typeof value !== "string") {
    c.problem(at, "`ref` must be a string like \"src/a.ts:40\" or \"src/a.ts:40-88\"");
    return;
  }
  const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(value);
  const bad = !m || value.length > LIMITS.refLength || /[\r\n\0]/.test(value);
  const from = m ? Number(m[2]) : 0;
  const to = m && m[3] !== undefined ? Number(m[3]) : from;
  if (bad || from < 1 || to < from) {
    c.problem(at, `\`ref\` ${JSON.stringify(value)} must be \`path:line\` or \`path:from-to\` with lines counted from 1`);
  }
}

function checkPathList(c: Collector, at: string, value: unknown, name: string): void {
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list)) {
    c.problem(at, `${tick(name)} must be a path or a list of paths`);
    return;
  }
  list.forEach((p, i) => {
    if (!isNonEmptyString(p) || /[\r\n\0]/.test(p) || p.length > LIMITS.refLength) {
      c.problem(at + (Array.isArray(value) ? pointerToken(i) : ""), `${tick(name)} entries must be non-empty one-line paths`);
    }
  });
  if (list.length > LIMITS.changesFiles) c.problem(at, `${tick(name)} lists more than ${LIMITS.changesFiles} paths`);
}

// --- view -------------------------------------------------------------------

function validatePlanSteps(c: Collector, at: string, steps: unknown, ids: string[], afterRefs: [string, string][]): void {
  if (!Array.isArray(steps)) {
    c.problem(at, "`steps` must be a list of steps");
    return;
  }
  steps.forEach((step, i) => {
    const p = at + pointerToken(i);
    if (!isObj(step)) {
      c.problem(p, "a step must be an object with `id` and `title`");
      return;
    }
    checkFields(c, step, p, STEP_FIELDS, ITEM_LATER);
    if (checkId(c, p + "/id", step.id, "step")) {
      if (ids.includes(step.id)) c.problem(p + "/id", `step id ${tick(step.id)} repeats within the block`);
      ids.push(step.id);
    } else ids.push("");
    if (step.title === undefined) c.problem(p + "/title", "`title` is required");
    else checkText(c, p + "/title", step.title, "title");
    if (step.detail !== undefined) checkText(c, p + "/detail", step.detail, "detail", undefined, false);
    if (step.status !== undefined && !STEP_STATUSES.includes(step.status as string)) {
      c.problem(p + "/status", `\`status\` must be one of ${quoted(STEP_STATUSES)}`);
    }
    if (step.ref !== undefined) checkRef(c, p + "/ref", step.ref);
    if (step.files !== undefined) checkPathList(c, p + "/files", step.files, "files");
    if (step.after !== undefined) {
      if (!Array.isArray(step.after) || step.after.some((a) => typeof a !== "string")) {
        c.problem(p + "/after", "`after` must be a list of step ids");
      } else {
        step.after.forEach((a, j) => afterRefs.push([p + "/after" + pointerToken(j), a as string]));
        if (typeof step.id === "string" && step.after.includes(step.id)) c.problem(p + "/after", "a step cannot come after itself");
      }
    }
    if (step.children !== undefined) validatePlanSteps(c, p + "/children", step.children, ids, afterRefs);
  });
}

function checkChangesOf(c: Collector, at: string, value: unknown): void {
  if (value === "worktree") return;
  if (typeof value !== "string" || value === "") {
    c.problem(at, "`of` must be \"worktree\", a commit, or \"base..head\"");
    return;
  }
  const sides = value.split(/\.{2,3}/);
  const okSide = (s: string): boolean => /^[A-Za-z0-9_][A-Za-z0-9._/~^@{}+-]*$/.test(s);
  const parts = value.includes("..") ? sides : [value];
  if (value.length > 200 || parts.length > 2 || !parts.every(okSide)) {
    c.problem(
      at,
      `\`of\` ${JSON.stringify(value)} is not a commit or range: use a commit, a branch, or "base..head"; it must not start with "-" or contain spaces`,
    );
  }
}

function validateBlock(c: Collector, at: string, block: unknown): BlockInfo | undefined {
  if (typeof block === "string") {
    if (block.trim() === "") c.problem(at, "a Markdown block must not be empty");
    return { pointer: at, type: "markdown", itemIds: [] };
  }
  if (!isObj(block)) {
    c.problem(at, "a block is a Markdown string or an object with `t`");
    return undefined;
  }
  const t = block.t;
  if (typeof t !== "string") {
    c.problem(at + "/t", "a block object needs `t`, one of " + quoted(BLOCKS_STAGE_1));
    return undefined;
  }
  if (BLOCKS_STAGE_2.includes(t)) {
    c.problem(at + "/t", stageMessage(t, 2, "use a Markdown string, `plan`, `code` or `changes`"), 2);
    return undefined;
  }
  if (BLOCKS_STAGE_3.includes(t)) {
    c.problem(at + "/t", stageMessage(t, 3, "use a Markdown string, `plan`, `code` or `changes`"), 3);
    return undefined;
  }
  if (!BLOCKS_STAGE_1.includes(t)) {
    c.problem(at + "/t", `unknown block type ${tick(t)}; use a Markdown string or one of ${quoted(BLOCKS_STAGE_1)}`);
    return undefined;
  }
  const info: BlockInfo = { pointer: at, type: t };
  if (block.id !== undefined) checkId(c, at + "/id", block.id, "block");
  if (block.title !== undefined) checkText(c, at + "/title", block.title, "title");

  if (t === "plan") {
    checkFields(c, block, at, ["t", "id", "title", "steps"], BLOCK_LATER);
    const ids: string[] = [];
    const afterRefs: [string, string][] = [];
    if (block.steps === undefined) c.problem(at + "/steps", "`steps` is required");
    else validatePlanSteps(c, at + "/steps", block.steps, ids, afterRefs);
    if (ids.length > LIMITS.itemsPerBlock) c.problem(at + "/steps", `a block holds at most ${LIMITS.itemsPerBlock} items`);
    if (Array.isArray(block.steps) && block.steps.length === 0) c.problem(at + "/steps", "`steps` must not be empty");
    for (const [p, ref] of afterRefs) {
      if (!ids.includes(ref)) c.problem(p, `\`after\` names ${tick(ref)}, which is not a step of this plan`);
    }
    info.itemIds = ids.filter((id) => id !== "");
  } else if (t === "code") {
    checkFields(c, block, at, ["t", "id", "title", "file", "from", "to", "s", "lang", "diff"], BLOCK_LATER);
    const hasFile = block.file !== undefined;
    const hasS = block.s !== undefined;
    if (hasFile === hasS) c.problem(at, "a `code` block takes exactly one of `file` and `s`");
    if (hasFile && checkText(c, at + "/file", block.file, "file", LIMITS.refLength) && /[\r\n\0]/.test(block.file as string)) {
      c.problem(at + "/file", "`file` must be a one-line path");
    }
    if (hasS) checkText(c, at + "/s", block.s, "s", undefined, false);
    if (block.from !== undefined && !isPosInt(block.from)) c.problem(at + "/from", "`from` must be a whole number from 1");
    if (block.to !== undefined && !isPosInt(block.to)) c.problem(at + "/to", "`to` must be a whole number from 1");
    if (isPosInt(block.from) && isPosInt(block.to) && block.to < block.from) c.problem(at + "/to", "`to` is before `from`");
    if ((block.from !== undefined || block.to !== undefined) && !hasFile) c.problem(at, "`from` and `to` apply only to `file`");
    if (block.lang !== undefined) checkText(c, at + "/lang", block.lang, "lang", 40);
    if (block.diff !== undefined) checkBool(c, at + "/diff", block.diff, "diff");
    info.itemIds = [];
  } else {
    checkFields(c, block, at, ["t", "id", "title", "of", "paths"], BLOCK_LATER);
    if (block.of !== undefined) checkChangesOf(c, at + "/of", block.of);
    if (block.paths !== undefined) checkPathList(c, at + "/paths", block.paths, "paths");
    info.itemIds = undefined;
  }
  return info;
}

function validateView(c: Collector, view: unknown): Map<string, BlockInfo> {
  const byId = new Map<string, BlockInfo>();
  const list = Array.isArray(view) ? view : [view];
  if (list.length > LIMITS.blocks) c.problem("/view", `a surface holds at most ${LIMITS.blocks} blocks`);
  const counts = new Map<string, number>();
  list.forEach((b) => {
    if (isObj(b) && typeof b.t === "string") counts.set(b.t, (counts.get(b.t) ?? 0) + 1);
  });
  list.forEach((b, i) => {
    const at = Array.isArray(view) ? "/view" + pointerToken(i) : "/view";
    const info = validateBlock(c, at, b);
    if (!info || !isObj(b)) return;
    const id = typeof b.id === "string" ? b.id : b.t;
    if (typeof id !== "string") return;
    if (b.id === undefined && (counts.get(info.type) ?? 0) > 1) {
      c.problem(at, `${tick(info.type)} appears more than once, so each needs an \`id\``);
      return;
    }
    if (byId.has(id)) c.problem(at + "/id", `block id ${tick(id)} repeats`);
    else byId.set(id, info);
  });
  return byId;
}

// --- questions --------------------------------------------------------------

function validateOptions(c: Collector, at: string, q: Obj): string[] {
  const ids: string[] = [];
  const raw = q.options;
  if (!Array.isArray(raw)) {
    c.problem(at + "/options", "`options` must be a list of strings or {id, label, detail?} objects");
    return ids;
  }
  const other = q.other !== false;
  const min = other ? 1 : 2;
  if (raw.length < min) {
    c.problem(
      at + "/options",
      other
        ? "a `choice` needs at least one option"
        : "a `choice` with `other` false needs at least two options",
    );
  }
  if (raw.length > LIMITS.options) c.problem(at + "/options", `a choice has at most ${LIMITS.options} options`);
  raw.forEach((option, i) => {
    const p = at + "/options" + pointerToken(i);
    let id: unknown;
    let label: unknown;
    if (typeof option === "string") {
      id = option;
      label = option;
    } else if (isObj(option)) {
      checkFields(c, option, p, OPTION_FIELDS, OPTION_LATER);
      id = option.id;
      label = option.label ?? option.id;
      if (option.label !== undefined) checkText(c, p + "/label", option.label, "label");
      if (option.detail !== undefined) checkText(c, p + "/detail", option.detail, "detail", undefined, false);
    } else {
      c.problem(p, "an option is a string or an object with `id`");
      return;
    }
    if (!isOptionId(id)) {
      c.problem(
        typeof option === "string" ? p : p + "/id",
        `option id must be text of 1 to ${LIMITS.optionIdLength} characters without a line break`,
      );
      return;
    }
    if (ids.includes(id)) c.problem(typeof option === "string" ? p : p + "/id", `option id ${JSON.stringify(id)} repeats within the question`);
    ids.push(id);
    if (typeof label === "string" && /\(recommended\)/i.test(label)) {
      c.warn(p, "an option label contains \"(Recommended)\"; use `recommend` on the question instead");
    }
  });
  if (raw.length > LIMITS.optionsWarnAbove) c.warn(at + "/options", `more than ${LIMITS.optionsWarnAbove} options; few options are easier to decide`);
  return ids;
}

function validateChoice(c: Collector, at: string, q: Obj): void {
  checkFields(c, q, at, [...QUESTION_FIELDS, ...CHOICE_FIELDS], {});
  const ids = validateOptions(c, at, q);
  if (q.multi !== undefined) checkBool(c, at + "/multi", q.multi, "multi");
  if (q.other !== undefined) checkBool(c, at + "/other", q.other, "other");
  const multi = q.multi === true;
  for (const key of ["min", "max"]) {
    const v = q[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) c.problem(at + "/" + key, `\`${key}\` must be a whole number, 0 or more`);
    else if (!multi) c.problem(at + "/" + key, `\`${key}\` applies only with \`multi\``);
  }
  if (typeof q.min === "number" && typeof q.max === "number" && q.min > q.max) c.problem(at + "/max", "`max` is below `min`");
  if (q.recommend === undefined) return;
  const rec = q.recommend;
  const check = (value: unknown, p: string): void => {
    if (typeof value !== "string" || !ids.includes(value)) {
      c.problem(p, `\`recommend\` ${JSON.stringify(value)} is not one of this question's option ids: ${ids.map((i) => JSON.stringify(i)).join(", ")}`);
    }
  };
  if (multi) {
    if (!Array.isArray(rec)) c.problem(at + "/recommend", "with `multi`, `recommend` is a list of option ids");
    else rec.forEach((r, i) => check(r, at + "/recommend" + pointerToken(i)));
  } else if (Array.isArray(rec)) c.problem(at + "/recommend", "`recommend` is a single option id unless `multi` is true");
  else check(rec, at + "/recommend");
}

function validateText(c: Collector, at: string, q: Obj): void {
  checkFields(c, q, at, [...QUESTION_FIELDS, ...TEXT_FIELDS], {});
  if (q.multiline !== undefined) checkBool(c, at + "/multiline", q.multiline, "multiline");
  if (q.placeholder !== undefined) checkText(c, at + "/placeholder", q.placeholder, "placeholder", LIMITS.answer, false);
  if (q.recommend !== undefined) checkText(c, at + "/recommend", q.recommend, "recommend", LIMITS.answer);
}

function validateReview(c: Collector, at: string, q: Obj, blocks: Map<string, BlockInfo>): void {
  checkFields(c, q, at, [...QUESTION_FIELDS, ...REVIEW_FIELDS], {});
  if (q.comment !== undefined) checkBool(c, at + "/comment", q.comment, "comment");

  let verdicts = ["approve", "change"];
  if (q.verdicts !== undefined) {
    const v = q.verdicts;
    if (!Array.isArray(v)) c.problem(at + "/verdicts", "`verdicts` must be a list of short words");
    else {
      const good: string[] = [];
      v.forEach((w, i) => {
        const p = at + "/verdicts" + pointerToken(i);
        if (!isNonEmptyString(w) || /[\r\n]/.test(w) || charCount(w) > LIMITS.verdictLength) {
          c.problem(p, `a verdict is a short one-line word, at most ${LIMITS.verdictLength} characters`);
        } else if (good.includes(w)) c.problem(p, `verdict ${JSON.stringify(w)} repeats`);
        else good.push(w);
      });
      if (v.length < LIMITS.verdictsMin || v.length > LIMITS.verdictsMax) {
        c.problem(at + "/verdicts", `\`verdicts\` takes ${LIMITS.verdictsMin} to ${LIMITS.verdictsMax} words`);
      }
      verdicts = good;
    }
  }

  // Which items are reviewed: undefined when they are only known after loading.
  let itemIds: string[] | undefined = [];
  const hasOf = q.of !== undefined;
  const hasItems = q.items !== undefined;
  if (hasOf === hasItems) c.problem(at, "a `review` takes exactly one of `of` (a view block's id) and `items`");
  if (hasOf) {
    if (typeof q.of !== "string") c.problem(at + "/of", "`of` must be the id of a view block");
    else {
      const block = blocks.get(q.of);
      if (!block) {
        const known = [...blocks.keys()];
        c.problem(at + "/of", `\`of\` names ${tick(q.of)}, which is not a block of the view${known.length ? "; blocks: " + quoted(known) : ""}`);
      } else if (block.type !== "plan" && block.type !== "changes") {
        c.problem(at + "/of", `\`of\` names the ${block.type} block ${tick(q.of)}, which has no items to review; use a \`plan\` or \`changes\` block`);
      } else itemIds = block.itemIds;
    }
  }
  if (hasItems) {
    const items = q.items;
    const ids: string[] = [];
    if (!Array.isArray(items)) c.problem(at + "/items", "`items` must be a list of titles or {id, title, detail?, ref?}");
    else {
      if (items.length < 1) c.problem(at + "/items", "`items` must not be empty");
      if (items.length > LIMITS.reviewItems) c.problem(at + "/items", `a review has at most ${LIMITS.reviewItems} items`);
      items.forEach((item, i) => {
        const p = at + "/items" + pointerToken(i);
        if (typeof item === "string") {
          checkText(c, p, item, "title");
          const id = `i${i + 1}`;
          if (ids.includes(id)) c.problem(p, `the title's derived id ${tick(id)} collides with an item id`);
          ids.push(id);
        } else if (isObj(item)) {
          checkFields(c, item, p, REVIEW_ITEM_FIELDS, ITEM_LATER);
          if (checkId(c, p + "/id", item.id, "item")) {
            if (ids.includes(item.id)) c.problem(p + "/id", `item id ${tick(item.id)} repeats within the review`);
            ids.push(item.id);
          }
          if (item.title === undefined) c.problem(p + "/title", "`title` is required");
          else checkText(c, p + "/title", item.title, "title");
          if (item.detail !== undefined) checkText(c, p + "/detail", item.detail, "detail", undefined, false);
          if (item.ref !== undefined) checkRef(c, p + "/ref", item.ref);
        } else c.problem(p, "an item is a title or an object with `id` and `title`");
      });
      itemIds = ids;
    }
  }

  if (q.recommend === undefined) return;
  const rec = q.recommend;
  const checkVerdict = (value: unknown, p: string): void => {
    if (typeof value !== "string" || !verdicts.includes(value)) {
      c.problem(p, `verdict ${JSON.stringify(value)} is not one of this question's verdicts: ${verdicts.map((v) => JSON.stringify(v)).join(", ")}`);
    }
  };
  if (typeof rec === "string") checkVerdict(rec, at + "/recommend");
  else if (isObj(rec)) {
    for (const key of Object.keys(rec)) {
      const p = at + "/recommend" + pointerToken(key);
      if (itemIds && !itemIds.includes(key)) c.problem(p, `\`recommend\` names ${tick(key)}, which is not an item of this review`);
      checkVerdict(rec[key], p);
    }
  } else c.problem(at + "/recommend", "`recommend` is one verdict for every item, or an object of item id to verdict");
}

function validateQuestions(c: Collector, questions: unknown, blocks: Map<string, BlockInfo>): void {
  if (!Array.isArray(questions)) {
    c.problem("/questions", "`questions` must be a list");
    return;
  }
  if (questions.length > LIMITS.questions) c.problem("/questions", `a surface holds at most ${LIMITS.questions} questions`);
  if (questions.length > LIMITS.questionsWarnAbove) c.warn("/questions", `more than ${LIMITS.questionsWarnAbove} questions; people stop answering long lists`);
  const seen: string[] = [];
  questions.forEach((q, i) => {
    const at = "/questions" + pointerToken(i);
    if (!isObj(q)) {
      c.problem(at, "a question is an object with `id`, `kind` and `prompt`");
      return;
    }
    if (checkId(c, at + "/id", q.id, "question")) {
      if (seen.includes(q.id)) c.problem(at + "/id", `question id ${tick(q.id)} repeats`);
      seen.push(q.id);
    }
    if (q.prompt === undefined) c.problem(at + "/prompt", "`prompt` is required");
    else checkText(c, at + "/prompt", q.prompt, "prompt");
    if (q.label !== undefined) checkText(c, at + "/label", q.label, "label");
    if (typeof q.label === "string" && /\(recommended\)/i.test(q.label)) c.warn(at + "/label", "a label contains \"(Recommended)\"; use `recommend` instead");
    if (q.note !== undefined) checkBool(c, at + "/note", q.note, "note");
    const kind = q.kind;
    if (typeof kind !== "string") {
      c.problem(at + "/kind", "`kind` is required: one of " + quoted(QUESTION_KINDS_STAGE_1));
    } else if (QUESTION_KINDS_STAGE_2.includes(kind)) {
      c.problem(at + "/kind", stageMessage(kind, 2, "use `choice`, `text` or `review`"), 2);
    } else if (kind === "choice") validateChoice(c, at, q);
    else if (kind === "text") validateText(c, at, q);
    else if (kind === "review") validateReview(c, at, q, blocks);
    else c.problem(at + "/kind", `unknown question kind ${tick(kind)}; use one of ${quoted(QUESTION_KINDS_STAGE_1)}`);
  });
}

// --- document ---------------------------------------------------------------

export function validateDocument(value: unknown, options: ValidateOptions = {}): ValidationResult {
  const c = newCollector();
  const finish = (): ValidationResult =>
    c.problems.length === 0
      ? { ok: true, document: value as SurfaceDocument, problems: [], warnings: c.warnings }
      : { ok: false, problems: c.problems, warnings: c.warnings };

  if (!isObj(value)) {
    c.problem("", "the document must be a JSON object");
    return finish();
  }
  const bytes = options.sourceBytes ?? utf8Bytes(JSON.stringify(value));
  if (bytes > LIMITS.documentBytes) {
    c.problem("", `the document is ${bytes} bytes; the limit is ${LIMITS.documentBytes} bytes (256 KiB)`);
    return finish();
  }
  checkFields(c, value, "", DOC_FIELDS, DOC_LATER);

  if (value.v !== 1) c.problem("/v", "`v` is required and must be the number 1");

  if (value.summary === undefined) c.problem("/summary", "`summary` is required: one plain sentence");
  else if (checkText(c, "/summary", value.summary, "summary", LIMITS.summary) && charCount(value.summary) > LIMITS.summaryWarnAbove) {
    c.warn("/summary", `\`summary\` is over ${LIMITS.summaryWarnAbove} characters; one short sentence reads best in the inbox`);
  }

  const questions = Array.isArray(value.questions) ? value.questions : [];
  const hasQuestions = value.questions !== undefined && !(Array.isArray(value.questions) && questions.length === 0);
  if (value.context !== undefined) checkText(c, "/context", value.context, "context", LIMITS.context, false);
  if (hasQuestions && !isNonEmptyString(value.context)) {
    c.problem("/context", "`context` is required when there are questions: say what you were doing and what the answers change, so it reads without the chat");
  }

  if (value.meanwhile !== undefined) {
    if (value.meanwhile === "go_ahead") {
      c.problem("/meanwhile", stageMessage("go_ahead", 2, 'use meanwhile "stop" or "other_work"'), 2);
    } else if (value.meanwhile !== "stop" && value.meanwhile !== "other_work") {
      c.problem("/meanwhile", '`meanwhile` must be "stop" or "other_work"');
    }
  }

  if (value.revises !== undefined) {
    if (!isSurfaceId(value.revises)) c.problem("/revises", "`revises` must be a surface id like \"s_8f2k3a\"");
    else if (options.resolveRevises) {
      const found = options.resolveRevises(value.revises);
      if (found === "missing") c.problem("/revises", `\`revises\` names ${tick(value.revises)}, which is not a surface`);
      else if (found === "foreign") c.problem("/revises", `\`revises\` names ${tick(value.revises)}, which belongs to another agent or host`);
    }
  }

  const blocks = value.view === undefined ? new Map<string, BlockInfo>() : validateView(c, value.view);
  if (value.questions !== undefined) validateQuestions(c, value.questions, blocks);

  if (value.submit !== undefined) {
    const p = "/submit";
    if (!isObj(value.submit)) c.problem(p, "`submit` is an object: {label?}");
    else {
      checkFields(c, value.submit, p, ["label", "mode"], {});
      if (value.submit.label !== undefined) checkText(c, p + "/label", value.submit.label, "label", LIMITS.submitLabel);
      const mode = value.submit.mode;
      if (mode === "auto") c.problem(p + "/mode", stageMessage("auto", 2, 'sending is always explicit; omit `mode` or use "explicit"'), 2);
      else if (mode !== undefined && mode !== "explicit") c.problem(p + "/mode", '`mode` must be "explicit"');
    }
  }

  const viewCount = value.view === undefined ? 0 : Array.isArray(value.view) ? value.view.length : 1;
  if (!hasQuestions && viewCount === 0) c.warn("", "the surface has neither content nor questions");

  return finish();
}
