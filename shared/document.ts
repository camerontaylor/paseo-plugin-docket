// The stage-1 surface document (spec sections 5, 6, 7, 27.2, 27.3).

export type Meanwhile = "stop" | "other_work";

export interface OptionObject {
  id: string;
  label?: string;
  detail?: string;
}
export type Option = string | OptionObject;

export interface ReviewItemObject {
  id: string;
  title: string;
  detail?: string;
  ref?: string;
}
/** A bare string is a title; its id is `i<position>` (see `reviewItems`). */
export type ReviewItem = string | ReviewItemObject;

interface QuestionBase {
  id: string;
  prompt: string;
  label?: string;
  note?: boolean;
}

export interface ChoiceQuestion extends QuestionBase {
  kind: "choice";
  options: Option[];
  multi?: boolean;
  other?: boolean;
  min?: number;
  max?: number;
  recommend?: string | string[];
}

export interface TextQuestion extends QuestionBase {
  kind: "text";
  multiline?: boolean;
  placeholder?: string;
  recommend?: string;
}

export interface ReviewQuestion extends QuestionBase {
  kind: "review";
  of?: string;
  items?: ReviewItem[];
  verdicts?: string[];
  comment?: boolean;
  recommend?: string | Record<string, string>;
}

export type Question = ChoiceQuestion | TextQuestion | ReviewQuestion;

export interface PlanStep {
  id: string;
  title: string;
  detail?: string;
  status?: "todo" | "doing" | "done" | "blocked";
  ref?: string;
  files?: string | string[];
  after?: string[];
  children?: PlanStep[];
}

interface BlockBase {
  id?: string;
  title?: string;
}
export interface PlanBlock extends BlockBase {
  t: "plan";
  steps: PlanStep[];
}
export interface CodeBlock extends BlockBase {
  t: "code";
  file?: string;
  from?: number;
  to?: number;
  s?: string;
  lang?: string;
  diff?: boolean;
}
export interface ChangesBlock extends BlockBase {
  t: "changes";
  of?: string;
  paths?: string[];
}
/** A string is a Markdown block. */
export type Block = string | PlanBlock | CodeBlock | ChangesBlock;

export interface SurfaceDocument {
  v: 1;
  summary: string;
  context?: string;
  meanwhile?: Meanwhile;
  revises?: string;
  questions?: Question[];
  view?: Block | Block[];
  submit?: { label?: string; mode?: "explicit" };
}

export function questionLabel(q: Question): string {
  return q.label ?? q.prompt;
}

export function optionParts(option: Option): { id: string; label: string; detail?: string } {
  if (typeof option === "string") return { id: option, label: option };
  return { id: option.id, label: option.label ?? option.id, detail: option.detail };
}

/** Inline review items with ids; a bare title gets the id `i<position>`. */
export function reviewItems(q: ReviewQuestion): ReviewItemObject[] {
  return (q.items ?? []).map((item, index) =>
    typeof item === "string" ? { id: `i${index + 1}`, title: item } : item,
  );
}

export function viewBlocks(doc: SurfaceDocument): Block[] {
  if (doc.view === undefined) return [];
  return Array.isArray(doc.view) ? doc.view : [doc.view];
}

/** A block's id: its own, else its type (spec 7.2). Markdown strings have none. */
export function blockId(block: Block): string | undefined {
  return typeof block === "string" ? undefined : (block.id ?? block.t);
}

/** Every step id of a plan, nested steps included, in reading order. */
export function planStepIds(steps: PlanStep[]): string[] {
  const out: string[] = [];
  const walk = (list: PlanStep[]): void => {
    for (const step of list) {
      out.push(step.id);
      if (step.children) walk(step.children);
    }
  };
  walk(steps);
  return out;
}

export function reviewVerdicts(q: ReviewQuestion): string[] {
  return q.verdicts ?? ["approve", "change"];
}
