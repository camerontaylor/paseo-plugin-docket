// The record's state transitions (plan S2): pure functions from a record and a
// command to a new record or a refusal. Nothing here reads a clock, a file or a
// random source; the caller passes `now` and the ids, and the file store only
// persists the result. Every accepted command that changes the record raises
// `rev` by one (plan D4); a command that changes nothing returns the same
// record object, so the store can skip the write.

import {
  type Block,
  type ChoiceQuestion,
  type Question,
  type ReviewQuestion,
  type SurfaceDocument,
  type TextQuestion,
  blockId,
  optionParts,
  planStepIds,
  questionLabel,
  reviewItems,
  reviewVerdicts,
  viewBlocks,
} from "./document";
import { charCount, deliveryMessageId, isItemId } from "./ids";
import { LIMITS } from "./limits";
import {
  type AnswerRecord,
  type CommentRecord,
  type Delivery,
  type DeliveryState,
  type Draft,
  type DraftContent,
  type ItemInfo,
  type ItemRecord,
  type QuestionRecord,
  type Snapshot,
  type SurfaceRecord,
  DEFAULT_RETENTION_DAYS,
  RECORD_SCHEMA,
  canComment,
  draftIsEmpty,
  hasOpenQuestion,
  hasOwn,
  own,
  queueMayHoldDelivery,
  reviewState,
  surfaceStatus,
} from "./record";
import {
  type DeliveredAnswer,
  type DeliveredComment,
  type DeliveredItem,
  type StillOpen,
  deliveryMessage,
  itemNoun,
} from "./text";

// --- results and refusals ----------------------------------------------------

export type RefusalCode =
  | "closed" // the surface is not open
  | "unknown-target" // a question, item or comment address that does not exist
  | "target-not-open" // the question or item already has its final state
  | "invalid-draft" // the draft does not fit the question
  | "stale-draft" // a write based on an older draft version
  | "stale-send" // a send naming draft or comment versions that are no longer current
  | "incomplete" // a draft that cannot be sent yet
  | "duplicate-target"
  | "nothing-to-send"
  | "too-many-open" // twenty open surfaces for one agent
  | "revises-missing"
  | "revises-foreign"
  | "missing-items" // a review of a block whose items were not loaded
  | "unknown-delivery"
  | "bad-delivery-transition"
  | "agent-archived" // Retry while the agent is archived
  | "queue-unavailable" // Retry needs the durable queue API
  | "delivery-pending" // a decision whose delivery is still in the queue
  | "comment-history-unavailable" // Redaction would discard the only copy of a sent comment
  | "delivery-redacted" // Retry of a delivery whose text the user deleted
  | "not-resolved" // compaction or deletion of something still open
  | "invalid"; // a malformed command

/** One target a send or close could not accept. */
export interface TargetProblem {
  target: string;
  code: "unknown-target" | "target-not-open" | "invalid-draft" | "incomplete" | "duplicate-target" | "no-draft" | "no-comment";
  message: string;
  /** For `target-not-open`: the state it is in. */
  state?: string;
}

/** A send that named a version that is no longer the stored one. */
export interface Conflict {
  kind?: "comment";
  target: string;
  /** The version the client was looking at. */
  sentVersion: number;
  /** The stored draft (or comment) now; null when it was cleared or never existed. */
  current: Draft | CommentRecord | null;
}

export interface Refusal {
  code: RefusalCode;
  message: string;
  problems?: TargetProblem[];
  conflicts?: Conflict[];
  /** For `stale-draft`: the stored draft or comment, so the client can show it. */
  current?: Draft | CommentRecord | null;
  /** For `too-many-open`: the agent's open surfaces. */
  open?: string[];
}

export type Result =
  | { ok: true; record: SurfaceRecord; delivery?: Delivery }
  | { ok: false; refusal: Refusal };

const refuse = (code: RefusalCode, message: string, extra: Partial<Refusal> = {}): Result => ({
  ok: false,
  refusal: { code, message, ...extra },
});

const done = (record: SurfaceRecord, delivery?: Delivery): Result => ({ ok: true, record, delivery });

/** The same record with `rev` raised; every changing transition ends here. */
function bump(record: SurfaceRecord, changes: Partial<SurfaceRecord>): SurfaceRecord {
  return { ...record, ...changes, rev: record.rev + 1 };
}

// --- create ------------------------------------------------------------------

export interface CreateInput {
  id: string;
  agentId: string;
  workspaceId?: string | null;
  now: string;
  document: SurfaceDocument;
  /** Items of `changes` blocks by block id, from the evidence the server loaded. Plan steps are read from the document. */
  changeItems?: Record<string, ItemInfo[]>;
  snapshots?: Record<string, Snapshot>;
  /** The surface `document.revises` names, when it exists on this host. */
  revised?: SurfaceRecord | null;
  /** The agent's open surfaces, not counting the one being replaced. */
  agentOpenSurfaces?: string[];
}

/** Items a block offers: plan steps (nested ones too) from the document, changed files from the loaded evidence. */
export function blockItemsOf(doc: SurfaceDocument, changeItems: Record<string, ItemInfo[]> = {}): Record<string, ItemInfo[]> {
  const out: Record<string, ItemInfo[]> = {};
  for (const block of viewBlocks(doc)) {
    if (typeof block === "string") continue;
    const id = blockId(block) as string;
    if (block.t === "plan") {
      const infos: ItemInfo[] = [];
      const walk = (steps: typeof block.steps): void => {
        for (const step of steps) {
          infos.push(step.detail ? { id: step.id, title: step.title, detail: step.detail } : { id: step.id, title: step.title });
          if (step.children) walk(step.children);
        }
      };
      walk(block.steps);
      out[id] = infos;
    } else if (block.t === "changes") {
      const found = own(changeItems, id);
      if (found) out[id] = found.map((item) => ({ ...item }));
    }
  }
  return out;
}

function newQuestionRecord(q: Question, items: Record<string, ItemInfo[]>): QuestionRecord | { missing: string } | { empty: string } {
  const base = { kind: q.kind, label: questionLabel(q), prompt: q.prompt, state: "open" as const };
  if (q.kind !== "review") return base;
  const list: ItemInfo[] | undefined = q.of !== undefined ? own(items, q.of) : reviewItems(q);
  if (!list) return { missing: q.of ?? q.id };
  if (!list.length) return { empty: q.of ?? q.id };
  const rec: Record<string, ItemRecord> = {};
  for (const item of list) {
    rec[item.id] = item.detail ? { state: "open", title: item.title, detail: item.detail } : { state: "open", title: item.title };
  }
  return { ...base, items: rec };
}

/**
 * A new record: every question open, no drafts, no deliveries, `rev` 1. A
 * surface with no questions is resolved at once. Refuses when the agent has
 * twenty open surfaces, when `revises` names nothing here or another agent's
 * surface, and when a review's items were not loaded.
 */
export function createRecord(input: CreateInput): Result {
  const { document: doc } = input;
  const open = input.agentOpenSurfaces ?? [];
  if (open.length >= LIMITS.openSurfacesPerAgent) {
    return refuse(
      "too-many-open",
      `this agent already has ${open.length} open surfaces (the limit is ${LIMITS.openSurfacesPerAgent}); close some first: ${open.join(", ")}`,
      { open: [...open] },
    );
  }
  if (doc.revises !== undefined) {
    if (!input.revised) return refuse("revises-missing", `\`revises\` names ${doc.revises}, which is not a surface on this host`);
    if (input.revised.agentId !== input.agentId) {
      return refuse("revises-foreign", `\`revises\` names ${doc.revises}, which belongs to another agent`);
    }
  }
  const items = blockItemsOf(doc, input.changeItems);
  const questions: Record<string, QuestionRecord> = {};
  for (const q of doc.questions ?? []) {
    const made = newQuestionRecord(q, items);
    if ("empty" in made) {
      return refuse("missing-items", `question ${q.id} reviews block ${made.empty}, which has no items to review`);
    }
    if ("missing" in made) {
      return refuse("missing-items", `question ${q.id} reviews block ${made.missing}, whose items were not loaded`);
    }
    questions[q.id] = made;
  }
  const record: SurfaceRecord = {
    schema: RECORD_SCHEMA,
    id: input.id,
    rev: 1,
    agentId: input.agentId,
    workspaceId: input.workspaceId ?? null,
    createdAt: input.now,
    summary: doc.summary,
    context: doc.context ?? null,
    meanwhile: doc.meanwhile ?? "stop",
    document: doc,
    revises: doc.revises ?? null,
    replacedBy: null,
    blockItems: items,
    snapshots: input.snapshots ?? {},
    questions,
    drafts: {},
    comments: {},
    deliveries: [],
    snooze: null,
    closed: null,
    resolvedAt: null,
    orphanedAt: null,
    compactedAt: null,
  };
  if (!hasOpenQuestion(record)) record.resolvedAt = input.now;
  return done(record);
}

// --- targets -----------------------------------------------------------------

export interface ParsedTarget {
  question: string;
  item?: string;
}

/** `question` or `question.item`; null when it is neither. */
export function parseTarget(target: unknown): ParsedTarget | null {
  if (typeof target !== "string") return null;
  const dot = target.indexOf(".");
  if (dot < 0) return isItemId(target) ? { question: target } : null;
  const question = target.slice(0, dot);
  const item = target.slice(dot + 1);
  return isItemId(question) && isItemId(item) ? { question, item } : null;
}

function docQuestion(record: SurfaceRecord, id: string): Question | undefined {
  return record.document?.questions?.find((q) => q.id === id);
}

/** What a target names in the record: the question's or the item's own state. */
function stateOf(record: SurfaceRecord, t: ParsedTarget): { state: string } | null {
  const q = own(record.questions, t.question);
  if (!q) return null;
  if (t.item === undefined) return q.state === "open" || !q.items ? q : q;
  const item = own(q.items, t.item);
  return item ?? null;
}

const closedRefusal = (record: SurfaceRecord): Result =>
  refuse(
    "closed",
    record.closed
      ? `this surface was closed${record.closed.reason ? `: ${record.closed.reason}` : ""}; nothing more can be answered`
      : "every question on this surface already has its final state; nothing more can be answered",
  );

// --- drafts ------------------------------------------------------------------

const DRAFT_KEYS = ["value", "other", "note", "verdict", "comment", "skipped", "by"];
const isText = (v: unknown): v is string => typeof v === "string";

/** Problems with a draft's shape and fit to its question. Half-filled drafts are fine; `draftIncomplete` checks what a send needs. */
function draftProblems(q: Question, item: string | undefined, d: DraftContent): string[] {
  const out: string[] = [];
  const bag = d as Record<string, unknown>;
  for (const key of Object.keys(bag)) if (!DRAFT_KEYS.includes(key)) out.push(`unknown field ${JSON.stringify(key)}`);
  const present = (key: string): boolean => bag[key] !== undefined;
  if (present("skipped")) {
    if (bag.skipped !== true) out.push("`skipped` is true or absent");
    const others = DRAFT_KEYS.filter((k) => k !== "skipped" && present(k));
    if (others.length) out.push(`a skipped answer carries nothing else (found ${others.join(", ")})`);
    return out;
  }
  if (present("note")) {
    if (q.kind === "review") out.push("a review takes comments on its items, not a note");
    else if (q.note === false) out.push("this question takes no note");
    else if (!isText(bag.note)) out.push("`note` must be text");
    else if (charCount(bag.note) > LIMITS.note) out.push(`a note is at most ${LIMITS.note} characters`);
  }
  if (q.kind === "review") {
    if (item === undefined) out.push("a review is answered per item: use `question.item`");
    for (const key of ["value", "other"]) if (present(key)) out.push(`\`${key}\` does not apply to a review item`);
    if (present("verdict")) {
      const verdicts = reviewVerdicts(q);
      if (!isText(bag.verdict) || !verdicts.includes(bag.verdict)) {
        out.push(`\`verdict\` must be one of ${verdicts.map((v) => JSON.stringify(v)).join(", ")}`);
      }
    }
    if (present("comment")) {
      if (q.comment === false) out.push("this review takes no comments");
      else if (!isText(bag.comment)) out.push("`comment` must be text");
      else if (charCount(bag.comment) > LIMITS.answer) out.push(`a comment is at most ${LIMITS.answer} characters`);
    }
  } else {
    if (item !== undefined) out.push("only a review has items");
    for (const key of ["verdict", "comment"]) if (present(key)) out.push(`\`${key}\` applies to a review item only`);
    if (q.kind === "choice") out.push(...choiceDraftProblems(q, d));
    else out.push(...textDraftProblems(d));
  }
  if (present("by") && bag.by !== "recommended") out.push('`by` is "recommended" or absent');
  if (bag.by === "recommended" && !matchesRecommendation(q, item, d)) {
    out.push("`by: recommended` is only for an answer that equals the question's recommendation");
  }
  return out;
}

function choiceDraftProblems(q: ChoiceQuestion, d: DraftContent): string[] {
  const out: string[] = [];
  const ids = q.options.map((o) => optionParts(o).id);
  const bad = (v: unknown): boolean => !isText(v) || !ids.includes(v);
  if (d.value !== undefined) {
    if (q.multi) {
      if (!Array.isArray(d.value)) out.push("`value` is a list of option ids on a multi choice");
      else {
        if (d.value.some(bad)) out.push(`\`value\` must name option ids: ${ids.map((i) => JSON.stringify(i)).join(", ")}`);
        else if (new Set(d.value).size !== d.value.length) out.push("`value` lists an option twice");
      }
    } else if (bad(d.value)) {
      out.push(`\`value\` must be one option id: ${ids.map((i) => JSON.stringify(i)).join(", ")}`);
    }
  }
  if (d.other !== undefined) {
    if (q.other === false) out.push("this question takes no custom answer");
    else if (!isText(d.other)) out.push("`other` must be text");
    else if (d.other.trim() === "") out.push("`other` must not be empty");
    else if (charCount(d.other) > LIMITS.answer) out.push(`a custom answer is at most ${LIMITS.answer} characters`);
  }
  return out;
}

function textDraftProblems(d: DraftContent): string[] {
  const out: string[] = [];
  if (d.other !== undefined) out.push("`other` applies to a choice only");
  if (d.value !== undefined) {
    if (!isText(d.value)) out.push("`value` must be text");
    else if (charCount(d.value) > LIMITS.answer) out.push(`a text answer is at most ${LIMITS.answer} characters`);
  }
  return out;
}

/** True when the draft's answer is exactly the question's recommendation. */
function matchesRecommendation(q: Question, item: string | undefined, d: DraftContent): boolean {
  if (q.recommend === undefined) return false;
  if (q.kind === "review") {
    if (item === undefined || d.verdict === undefined) return false;
    const rec = typeof q.recommend === "string" ? q.recommend : own(q.recommend as Record<string, string>, item);
    return rec === d.verdict;
  }
  if (d.other !== undefined) return false;
  if (q.kind === "choice" && q.multi) {
    const want = (q.recommend as string[]).slice().sort();
    const got = Array.isArray(d.value) ? d.value.slice().sort() : [];
    return want.length === got.length && want.every((v, i) => v === got[i]);
  }
  return d.value === q.recommend;
}

/** What a send still needs from a draft, or an empty list when it can go. */
export function draftIncomplete(q: Question, item: string | undefined, d: DraftContent): string[] {
  if (d.skipped) return [];
  if (q.kind === "review") return d.verdict === undefined ? ["a verdict is needed; a comment alone does not answer an item"] : [];
  if (q.kind === "text") {
    return typeof d.value === "string" && d.value.trim() !== "" ? [] : ["a text answer must not be empty"];
  }
  const chosen = d.value === undefined ? 0 : Array.isArray(d.value) ? d.value.length : 1;
  const count = chosen + (d.other !== undefined ? 1 : 0);
  if (count === 0) return ["choose an option, give a custom answer or skip"];
  if (!q.multi) return count > 1 ? ["choose one option or give a custom answer, not both"] : [];
  const out: string[] = [];
  if (q.min !== undefined && count < q.min) out.push(`choose at least ${q.min}`);
  if (q.max !== undefined && count > q.max) out.push(`choose at most ${q.max}`);
  return out;
}

function contentOf(d: DraftContent): DraftContent {
  const out: Record<string, unknown> = {};
  for (const key of DRAFT_KEYS) if ((d as Record<string, unknown>)[key] !== undefined) out[key] = (d as Record<string, unknown>)[key];
  return out as DraftContent;
}

export interface SetDraft {
  kind: "setDraft";
  target: string;
  /** The draft, or null to clear it. */
  draft: DraftContent | null;
  /** The draft version the writer was looking at; 0 for none. */
  baseVersion: number;
  now: string;
}

function setDraft(record: SurfaceRecord, cmd: SetDraft): Result {
  if (!hasOpenQuestion(record)) return closedRefusal(record);
  const t = parseTarget(cmd.target);
  const q = t && docQuestion(record, t.question);
  const item = t && t.item !== undefined && q && q.kind === "review" ? own(own(record.questions, t.question)?.items, t.item) : undefined;
  if (!t || !q || (t.item !== undefined && !item && q.kind === "review")) {
    return refuse("unknown-target", `${JSON.stringify(cmd.target)} is not a question or review item of this surface`);
  }
  const target = cmd.target;
  const state = t.item === undefined ? own(record.questions, t.question)?.state : item?.state ?? "open";
  if (state !== "open") {
    return refuse("target-not-open", `${target} is already ${state}; it can no longer be answered`, {
      problems: [{ target, code: "target-not-open", message: `already ${state}`, state }],
    });
  }
  const stored = own(record.drafts, target);
  const storedVersion = stored ? stored.version : 0;
  if (cmd.baseVersion !== storedVersion) {
    return refuse("stale-draft", `the draft for ${target} is at version ${storedVersion}, not ${cmd.baseVersion}`, {
      current: stored && !draftIsEmpty(stored) ? stored : null,
    });
  }
  const content = cmd.draft === null ? {} : contentOf(cmd.draft);
  const problems = cmd.draft === null ? [] : draftProblems(q, t.item, cmd.draft);
  if (problems.length) {
    return refuse("invalid-draft", `the draft for ${target} does not fit the question: ${problems.join("; ")}`, {
      problems: problems.map((message) => ({ target, code: "invalid-draft" as const, message })),
    });
  }
  const draft: Draft = { version: storedVersion + 1, ...content };
  return done(bump(record, { drafts: { ...record.drafts, [target]: draft } }));
}

// --- comments ----------------------------------------------------------------

export interface SetComment {
  kind: "setComment";
  /** `block.item`. */
  on: string;
  /** The comment, or null (or empty) to clear it. */
  text: string | null;
  baseVersion: number;
  now: string;
}

function itemOfBlock(record: SurfaceRecord, on: string): ItemInfo | undefined {
  const t = parseTarget(on);
  if (!t || t.item === undefined) return undefined;
  return own(record.blockItems, t.question)?.find((i) => i.id === t.item);
}

function setComment(record: SurfaceRecord, cmd: SetComment): Result {
  if (!canComment(record)) return closedRefusal(record);
  const info = itemOfBlock(record, cmd.on);
  if (!info) return refuse("unknown-target", `${JSON.stringify(cmd.on)} is not an item of a block on this surface`);
  const stored = own(record.comments, cmd.on);
  const storedVersion = stored ? stored.version : 0;
  if (cmd.baseVersion !== storedVersion) {
    return refuse("stale-draft", `the comment on ${cmd.on} is at version ${storedVersion}, not ${cmd.baseVersion}`, {
      current: stored && stored.text !== "" && stored.delivery === null ? stored : null,
    });
  }
  const text = cmd.text ?? "";
  if (typeof text !== "string") return refuse("invalid", "a comment must be text");
  if (charCount(text) > LIMITS.answer) {
    return refuse("invalid-draft", `a comment is at most ${LIMITS.answer} characters`, {
      problems: [{ target: cmd.on, code: "invalid-draft", message: `a comment is at most ${LIMITS.answer} characters` }],
    });
  }
  const comment: CommentRecord = { version: storedVersion + 1, text, title: info.title, delivery: null };
  // Older deliveries stored the sent version only in the current comment and frozen message.
  const deliveries = stored && stored.delivery !== null
    ? record.deliveries.map((d) => d.n === stored.delivery && !own(d.sentComments ?? {}, cmd.on)
      ? { ...d, sentComments: { ...d.sentComments, [cmd.on]: stored } }
      : d)
    : record.deliveries;
  return done(bump(record, { comments: { ...record.comments, [cmd.on]: comment }, deliveries }));
}

// --- send --------------------------------------------------------------------

export interface Send {
  kind: "send";
  /** Questions or review items, each with the draft version the user was looking at. */
  targets: { target: string; version: number }[];
  /** Comments to send, each with the version the user was looking at. */
  comments?: { on: string; version: number }[];
  /** Open targets the user declines (Skip the rest); a review question stands for its open items. */
  skip?: string[];
  now: string;
}

function noun(doc: SurfaceDocument, q: ReviewQuestion): string {
  if (q.of === undefined) return "item";
  const block = viewBlocks(doc).find((b: Block) => typeof b !== "string" && blockId(b) === q.of);
  return typeof block === "string" || !block ? "item" : itemNoun(block.t);
}

function sendRecord(record: SurfaceRecord, cmd: Send): Result {
  const doc = record.document;
  const targets = cmd.targets ?? [];
  const sentComments = cmd.comments ?? [];
  const skipList = cmd.skip ?? [];
  const commentsOnly = sentComments.length > 0 && targets.length === 0 && skipList.length === 0;
  if (!doc || (!hasOpenQuestion(record) && !(commentsOnly && canComment(record)))) return closedRefusal(record);
  if (targets.length + sentComments.length + skipList.length === 0) {
    return refuse("nothing-to-send", "nothing was named to send; choose answers or comments, or skip what is left");
  }

  // 1. Structure: every target exists, is open and appears once.
  const problems: TargetProblem[] = [];
  const seen = new Set<string>();
  interface Planned {
    target: string;
    t: ParsedTarget;
    version?: number;
    skip: boolean;
  }
  const planned: Planned[] = [];
  const plan = (target: string, version: number | undefined, skip: boolean): void => {
    const t = parseTarget(target);
    const q = t && own(record.questions, t.question);
    if (!t || !q || !docQuestion(record, t.question)) {
      problems.push({ target, code: "unknown-target", message: "not a question or review item of this surface" });
      return;
    }
    if (q.kind === "review" && t.item === undefined) {
      if (!skip) {
        problems.push({ target, code: "unknown-target", message: "a review is answered per item: name `question.item`" });
        return;
      }
      for (const id of Object.keys(q.items ?? {})) {
        // "Skip the rest" leaves out the items this same send answers.
        if (q.items?.[id].state === "open" && !seen.has(`${t.question}.${id}`)) plan(`${t.question}.${id}`, undefined, true);
      }
      if (!Object.keys(q.items ?? {}).some((id) => q.items?.[id].state === "open") && q.state !== "open") {
        problems.push({ target, code: "target-not-open", message: `already ${q.state}`, state: q.state });
      }
      return;
    }
    const node = t.item === undefined ? q : own(q.items, t.item);
    if (!node) {
      problems.push({ target, code: "unknown-target", message: "not a question or review item of this surface" });
      return;
    }
    if (node.state !== "open") {
      problems.push({ target, code: "target-not-open", message: `already ${node.state}`, state: node.state });
      return;
    }
    if (seen.has(target)) {
      problems.push({ target, code: "duplicate-target", message: "named more than once" });
      return;
    }
    seen.add(target);
    planned.push({ target, t, version, skip });
  };
  for (const entry of targets) {
    if (!entry || typeof entry.target !== "string" || typeof entry.version !== "number") {
      return refuse("invalid", "each target is {target, version}");
    }
    plan(entry.target, entry.version, false);
  }
  for (const target of skipList) plan(target, undefined, true);
  const commentSeen = new Set<string>();
  for (const entry of sentComments) {
    if (commentSeen.has(entry.on)) problems.push({ target: entry.on, code: "duplicate-target", message: "named more than once" });
    commentSeen.add(entry.on);
    const stored = own(record.comments, entry.on);
    if (!itemOfBlock(record, entry.on)) {
      problems.push({ target: entry.on, code: "unknown-target", message: "not an item of a block on this surface" });
    } else if (!stored || (stored.version === entry.version && (stored.text === "" || stored.delivery !== null))) {
      problems.push({ target: entry.on, code: "no-comment", message: "there is no unsent comment here" });
    }
  }
  if (problems.length) {
    const codes = new Set(problems.map((p) => p.code));
    const code: RefusalCode = codes.has("target-not-open") && codes.size === 1 ? "target-not-open" : codes.has("duplicate-target") && codes.size === 1 ? "duplicate-target" : "unknown-target";
    return refuse(code, `the send was refused: ${problems.map((p) => `${p.target} ${p.message}`).join("; ")}`, { problems });
  }

  // 2. Versions: a send names the drafts the user saw; a newer one refuses the whole send.
  const conflicts: Conflict[] = [];
  const empty: TargetProblem[] = [];
  for (const p of planned) {
    if (p.skip) continue;
    const stored = own(record.drafts, p.target);
    const current = stored && !draftIsEmpty(stored) ? stored : null;
    if (!stored || stored.version !== p.version) conflicts.push({ target: p.target, sentVersion: p.version as number, current });
    else if (!current) empty.push({ target: p.target, code: "no-draft", message: "there is no draft to send" });
  }
  for (const entry of sentComments) {
    const stored = own(record.comments, entry.on) as CommentRecord;
    if (stored.version !== entry.version) {
      conflicts.push({ kind: "comment", target: entry.on, sentVersion: entry.version, current: stored.text !== "" && stored.delivery === null ? stored : null });
    }
  }
  if (conflicts.length) {
    return refuse(
      "stale-send",
      `the send was refused: newer drafts exist for ${conflicts.map((c) => c.target).join(", ")}; look at them and send again`,
      { conflicts },
    );
  }
  if (empty.length) return refuse("incomplete", `the send was refused: ${empty.map((p) => p.target).join(", ")} has no draft`, { problems: empty });

  // 3. Completeness: what each draft still needs.
  const incomplete: TargetProblem[] = [];
  for (const p of planned) {
    if (p.skip) continue;
    const q = docQuestion(record, p.t.question) as Question;
    for (const message of draftIncomplete(q, p.t.item, own(record.drafts, p.target) as Draft)) {
      incomplete.push({ target: p.target, code: "incomplete", message });
    }
  }
  if (incomplete.length) {
    return refuse("incomplete", `the send was refused: ${incomplete.map((p) => `${p.target}: ${p.message}`).join("; ")}`, { problems: incomplete });
  }

  // 4. Apply: new states, the delivery text and the delivery, in one record.
  const n = record.deliveries.length + 1;
  const questions: Record<string, QuestionRecord> = {};
  for (const id of Object.keys(record.questions)) {
    const q = record.questions[id];
    questions[id] = q.items ? { ...q, items: { ...q.items } } : { ...q };
  }
  const drafts = { ...record.drafts };
  const byQuestion = new Map<string, Planned[]>();
  for (const p of planned) byQuestion.set(p.t.question, [...(byQuestion.get(p.t.question) ?? []), p]);

  const answers: DeliveredAnswer[] = [];
  for (const q of doc.questions ?? []) {
    const list = byQuestion.get(q.id);
    if (!list) continue;
    const rec = questions[q.id];
    if (q.kind === "review") {
      const delivered: DeliveredItem[] = [];
      let allRecommended = true;
      for (const p of list) {
        const draft = own(record.drafts, p.target);
        const itemId = p.t.item as string;
        const skipped = p.skip || draft?.skipped === true;
        const answer = skipped
          ? { skipped: true as const, at: cmd.now }
          : {
              verdict: draft?.verdict,
              ...(draft?.comment ? { comment: draft.comment } : {}),
              ...(draft?.by ? { by: draft.by } : {}),
              at: cmd.now,
            };
        (rec.items as Record<string, ItemRecord>)[itemId] = {
          ...(rec.items as Record<string, ItemRecord>)[itemId],
          state: skipped ? "skipped" : "answered",
          answer,
          delivery: n,
        };
        delivered.push(skipped ? { id: itemId, skipped: true } : { id: itemId, verdict: draft?.verdict, ...(draft?.comment ? { comment: draft.comment } : {}) });
        if (skipped || draft?.by !== "recommended") allRecommended = false;
        delete drafts[p.target];
      }
      rec.state = reviewState(rec.items as Record<string, ItemRecord>);
      rec.delivery = n;
      const a: DeliveredAnswer = { label: questionLabel(q), items: delivered };
      if (allRecommended) a.byRecommended = true;
      answers.push(a);
    } else {
      const p = list[0];
      const draft = own(record.drafts, p.target);
      const skipped = p.skip || draft?.skipped === true;
      let answer: AnswerRecord;
      let delivered: DeliveredAnswer;
      if (skipped) {
        answer = { skipped: true, at: cmd.now };
        delivered = { label: questionLabel(q), skipped: true };
      } else {
        const d = draft as Draft;
        const labels = q.kind === "text" ? [d.value as string] : valueLabels(q, d);
        answer = {
          ...(d.value !== undefined ? { value: d.value } : {}),
          ...(labels.length ? { text: labels } : {}),
          ...(d.other !== undefined ? { other: d.other } : {}),
          ...(d.note ? { note: d.note } : {}),
          ...(d.by ? { by: d.by } : {}),
          at: cmd.now,
        };
        delivered = { label: questionLabel(q), values: labels };
        if (d.other !== undefined) delivered.other = d.other;
        if (d.by) delivered.byRecommended = true;
        if (d.note) delivered.note = d.note;
      }
      rec.state = skipped ? "skipped" : "answered";
      rec.answer = answer;
      rec.delivery = n;
      answers.push(delivered);
      delete drafts[p.target];
    }
  }

  const comments = { ...record.comments };
  const deliveredComments: DeliveredComment[] = [];
  const sentCommentSnapshots: Record<string, CommentRecord> = {};
  for (const entry of sentComments) {
    const c = comments[entry.on];
    const info = itemOfBlock(record, entry.on) as ItemInfo;
    const parsed = parseTarget(entry.on) as ParsedTarget;
    const block = viewBlocks(doc).find((b: Block) => typeof b !== "string" && blockId(b) === parsed.question);
    deliveredComments.push({
      noun: typeof block === "string" || !block ? "item" : itemNoun(block.t),
      id: info.id,
      title: info.title,
      text: c.text,
    });
    comments[entry.on] = { ...c, delivery: n };
    sentCommentSnapshots[entry.on] = comments[entry.on];
  }

  const stillOpen: StillOpen[] = [];
  for (const q of doc.questions ?? []) {
    const rec = questions[q.id];
    if (rec.state !== "open") continue;
    if (q.kind === "review") {
      const ids = Object.keys(rec.items ?? {}).filter((id) => rec.items?.[id].state === "open");
      stillOpen.push({ noun: noun(doc, q), ids });
    } else stillOpen.push({ label: questionLabel(q) });
  }

  const text = deliveryMessage({ surfaceId: record.id, delivery: n, answers, comments: deliveredComments, stillOpen });
  const delivery: Delivery = {
    n,
    messageId: deliveryMessageId(record.id, n),
    state: record.orphanedAt ? "held" : "queued",
    attempts: 0,
    createdAt: cmd.now,
    text,
    targets: planned.map((p) => p.target),
    comments: sentComments.map((c) => c.on),
    ...(sentComments.length ? { sentComments: sentCommentSnapshots } : {}),
  };
  const next = bump(record, { questions, drafts, comments, deliveries: [...record.deliveries, delivery] });
  if (!hasOpenQuestion(next)) next.resolvedAt = cmd.now;
  return done(next, delivery);
}

/** Labels of the options a choice draft picked, in option order. */
function valueLabels(q: ChoiceQuestion, d: DraftContent): string[] {
  if (d.value === undefined) return [];
  const picked = Array.isArray(d.value) ? d.value : [d.value];
  const out: string[] = [];
  for (const option of q.options) {
    const parts = optionParts(option);
    if (picked.includes(parts.id)) out.push(parts.label);
  }
  return out;
}

// --- close, replace ----------------------------------------------------------

export interface Close {
  kind: "close";
  /** The actor for agent tool calls. Checked under the surface lock. */
  agentId?: string;
  /** The questions to close; every open one when absent. */
  questions?: string[];
  reason?: string;
  now: string;
}

function closeRecord(record: SurfaceRecord, cmd: Close): Result {
  if (cmd.agentId !== undefined && cmd.agentId !== record.agentId) {
    return refuse("unknown-target", "No such surface for this agent.");
  }
  if (!hasOpenQuestion(record)) return closedRefusal(record);
  const ids = cmd.questions ?? Object.keys(record.questions).filter((id) => record.questions[id].state === "open");
  const problems: TargetProblem[] = [];
  for (const id of ids) {
    const q = own(record.questions, id);
    if (!q) problems.push({ target: id, code: "unknown-target", message: "not a question of this surface" });
    else if (q.state !== "open") problems.push({ target: id, code: "target-not-open", message: `already ${q.state}`, state: q.state });
  }
  if (problems.length) {
    return refuse("unknown-target", `nothing was closed: ${problems.map((p) => `${p.target} ${p.message}`).join("; ")}`, { problems });
  }
  const questions = { ...record.questions };
  for (const id of ids) {
    questions[id] = closeQuestion(questions[id]);
    if (cmd.reason) questions[id].closeReason = cmd.reason;
  }
  const next = bump(record, { questions });
  if (!hasOpenQuestion(next)) {
    next.resolvedAt = cmd.now;
    next.closed = cmd.reason ? { at: cmd.now, by: "agent", reason: cmd.reason } : { at: cmd.now, by: "agent" };
  }
  return done(next);
}

/** A question the agent no longer needs answered: open items close with it; answers already sent stay. */
function closeQuestion(q: QuestionRecord): QuestionRecord {
  if (!q.items) return { ...q, state: "closed" };
  const items: Record<string, ItemRecord> = {};
  for (const id of Object.keys(q.items)) {
    items[id] = q.items[id].state === "open" ? { ...q.items[id], state: "closed" } : q.items[id];
  }
  return { ...q, items, state: reviewState(items) };
}

export interface CloseReplaced {
  kind: "closeReplaced";
  /** The surface that revises this one. */
  by: string;
  now: string;
}

/**
 * The old surface of a replacement: closed when open, and pointing at the new
 * one. Safe to repeat; a surface already replaced by another keeps that link.
 */
function closeReplaced(record: SurfaceRecord, cmd: CloseReplaced): Result {
  const link = record.replacedBy === null;
  const open = hasOpenQuestion(record);
  if (!link && !open) return done(record);
  const changes: Partial<SurfaceRecord> = {};
  if (link) changes.replacedBy = cmd.by;
  if (open) {
    const questions = { ...record.questions };
    for (const id of Object.keys(questions)) if (questions[id].state === "open") questions[id] = closeQuestion(questions[id]);
    changes.questions = questions;
    changes.closed = { at: cmd.now, by: "replaced" };
    changes.resolvedAt = cmd.now;
  }
  return done(bump(record, changes));
}

// --- archive -----------------------------------------------------------------

export interface HoldOnArchive {
  kind: "holdOnArchive";
  now: string;
}
export interface AgentRestored {
  kind: "agentRestored";
  now: string;
}

/** The agent was archived: queued and uncertain deliveries become held and are not attempted (spec 8.1). */
function holdOnArchive(record: SurfaceRecord, cmd: HoldOnArchive): Result {
  const hold = (d: Delivery): boolean => d.state === "queued" || d.state === "uncertain"
    || (d.state === "failed" && d.transport === "queue" && queueMayHoldDelivery(d));
  if (record.orphanedAt && !record.deliveries.some(hold)) return done(record);
  const deliveries = record.deliveries.map((d) => (hold(d) ? { ...d, state: "held" as const, updatedAt: cmd.now } : d));
  return done(bump(record, { deliveries, orphanedAt: record.orphanedAt ?? cmd.now }));
}

/** The agent was restored. Held deliveries stay held until Retry. */
function agentRestored(record: SurfaceRecord): Result {
  if (record.orphanedAt === null) return done(record);
  return done(bump(record, { orphanedAt: null }));
}

// --- delivery states ---------------------------------------------------------

/** Which state a delivery may move to from each state (plan D3, S5). */
export const DELIVERY_TRANSITIONS: Record<DeliveryState, DeliveryState[]> = {
  queued: ["held", "uncertain", "delivered", "failed", "removed"],
  held: ["queued", "delivered", "removed", "failed"], // Retry or terminal observation of an accepted enqueue
  uncertain: ["delivered", "failed", "removed", "held"],
  delivered: [],
  failed: ["queued"], // only by Retry
  removed: ["queued"], // only by Retry
};

export interface DeliveryPatch {
  attempts?: number;
  enqueued?: boolean | null;
  transport?: Delivery["transport"];
  sent?: boolean;
  queueRetryRevision?: number | null;
  receivedText?: string;
  lastError?: string | null;
}

export interface UpdateDelivery {
  kind: "updateDelivery";
  n: number;
  /** Set by observers that can identify the message, including after a retry changed its ID. */
  messageId?: string;
  /** A new state; absent to record a patch alone. */
  to?: DeliveryState;
  patch?: DeliveryPatch;
  now: string;
}

function findDelivery(record: SurfaceRecord, n: number): Delivery | undefined {
  return record.deliveries.find((d) => d.n === n);
}

function updateDelivery(record: SurfaceRecord, cmd: UpdateDelivery): Result {
  const d = findDelivery(record, cmd.n);
  if (!d) return refuse("unknown-delivery", `this surface has no delivery ${cmd.n}`);
  if (cmd.messageId !== undefined && cmd.messageId !== d.messageId) {
    return refuse("bad-delivery-transition", `delivery ${cmd.n} no longer has message id ${cmd.messageId}`);
  }
  // A failed item can be retried or removed in the host's composer.
  const composerOutcome = d.state === "failed" && d.transport === "queue" && queueMayHoldDelivery(d)
    && cmd.messageId === d.messageId && (cmd.to === "delivered" || cmd.to === "removed");
  const heldWithoutAttempt = d.state === "held" && !d.enqueued && !(cmd.to === "delivered" && d.transport);
  if (cmd.to !== undefined && cmd.to !== d.state && !composerOutcome
    && (!DELIVERY_TRANSITIONS[d.state].includes(cmd.to) || heldWithoutAttempt)) {
    return refuse("bad-delivery-transition", `delivery ${cmd.n} is ${d.state} and cannot become ${cmd.to}`);
  }
  if (cmd.to === "queued" && d.state !== "queued") {
    return refuse("bad-delivery-transition", `delivery ${cmd.n} goes back to queued only through Retry`);
  }
  // A delivery the user deleted keeps no text, so a late observation cannot bring it back.
  const patch = d.text === "" ? {} : (cmd.patch ?? {});
  const next: Delivery = { ...d };
  if (patch.attempts !== undefined) next.attempts = patch.attempts;
  if (patch.enqueued === null) delete next.enqueued;
  else if (patch.enqueued !== undefined) next.enqueued = patch.enqueued;
  if (patch.transport !== undefined) next.transport = patch.transport;
  if (patch.sent !== undefined) next.sent = patch.sent;
  if (patch.queueRetryRevision === null) delete next.queueRetryRevision;
  else if (patch.queueRetryRevision !== undefined) next.queueRetryRevision = patch.queueRetryRevision;
  if (patch.receivedText !== undefined && patch.receivedText !== d.text) next.receivedText = patch.receivedText;
  if (patch.lastError === null) delete next.lastError;
  else if (patch.lastError !== undefined) next.lastError = patch.lastError;
  if (cmd.to !== undefined && cmd.to !== d.state) {
    next.state = cmd.to;
    if (cmd.to === "delivered") next.deliveredAt = cmd.now;
  }
  if (JSON.stringify(next) === JSON.stringify(d)) return done(record);
  next.updatedAt = cmd.now;
  return done(bump(record, { deliveries: record.deliveries.map((x) => (x.n === d.n ? next : x)) }));
}

export interface RetryDelivery {
  kind: "retryDelivery";
  n: number;
  /** A new message id, for a retry that must not repeat the old one (plan S5, direct transport). */
  messageId?: string;
  queueRetryRevision?: number;
  now: string;
}

/** Retry: a held, failed, removed or uncertain delivery goes back to queued, with its frozen text. */
function retryDelivery(record: SurfaceRecord, cmd: RetryDelivery): Result {
  const d = findDelivery(record, cmd.n);
  if (!d) return refuse("unknown-delivery", `this surface has no delivery ${cmd.n}`);
  if (d.text === "") return refuse("delivery-redacted", `delivery ${cmd.n} was deleted by the user and cannot be sent again`);
  if (record.orphanedAt) return refuse("agent-archived", `the agent is archived; delivery ${cmd.n} stays held until it is restored`);
  if (d.state === "delivered" || d.state === "queued") {
    return refuse("bad-delivery-transition", `delivery ${cmd.n} is ${d.state}; only a held, failed, removed or uncertain one is retried`);
  }
  const next: Delivery = { ...d, state: "queued", attempts: 0, enqueued: false, updatedAt: cmd.now };
  delete next.lastError;
  delete next.receivedText;
  delete next.sent;
  if (cmd.queueRetryRevision === undefined) delete next.queueRetryRevision;
  else next.queueRetryRevision = cmd.queueRetryRevision;
  if (cmd.messageId !== undefined) next.messageId = cmd.messageId;
  return done(bump(record, { deliveries: record.deliveries.map((x) => (x.n === d.n ? next : x)) }));
}

// --- decisions: delete, compact ----------------------------------------------

export interface DeleteDecisions {
  kind: "deleteDecisions";
  /** Question ids; every answered question when absent. */
  questions?: string[];
  now: string;
}

/**
 * The user deletes decisions: the answer, the note and each item's verdict and
 * comment go from the record, as does frozen delivery text carrying the deleted content.
 */
function deleteDecisions(record: SurfaceRecord, cmd: DeleteDecisions): Result {
  const all = cmd.questions === undefined;
  const ids = cmd.questions ?? Object.keys(record.questions);
  // Candidates: questions that hold a decision, and the answered items of each.
  const cand: Record<string, string[]> = {};
  for (const id of ids) {
    const q = own(record.questions, id);
    if (!q) return refuse("unknown-target", `${JSON.stringify(id)} is not a question of this surface`);
    if (q.deleted) continue;
    const answered = q.items ? Object.keys(q.items).filter((i) => q.items?.[i].answer && q.items[i].answer?.skipped !== true) : [];
    const has = q.items ? answered.length > 0 : q.answer !== undefined && q.answer.skipped !== true;
    if (has) cand[id] = answered;
  }
  const carries = (id: string): number[] => {
    const q = record.questions[id];
    const ns = q.items ? (cand[id] ?? []).map((i) => q.items?.[i].delivery) : [q.delivery];
    return ns.filter((n): n is number => n !== undefined);
  };
  // What this delete removes, by target: `question` or `question.item`.
  const doomed = (): Set<string> => {
    const out = new Set<string>();
    for (const id of Object.keys(cand)) {
      if (record.questions[id].items) for (const i of cand[id]) out.add(`${id}.${i}`);
      else out.add(id);
    }
    return out;
  };
  const sentComment = (d: Delivery, on: string): CommentRecord | undefined => {
    const current = own(record.comments, on);
    return own(d.sentComments ?? {}, on) ?? (current?.delivery === d.n ? current : undefined);
  };
  // Accepted enqueues can still settle after archive. Cancel other pending deliveries
  // only when their entire payload is being deleted, and keep legacy comment history.
  const blocked = (id: string): RefusalCode | undefined => {
    const dead = doomed();
    for (const n of carries(id)) {
      const d = findDelivery(record, n);
      if (!d || d.text === "") continue;
      if (d.state === "delivered") {
        if (d.comments.some((on) => !sentComment(d, on))) return "comment-history-unavailable";
        continue;
      }
      if (d.state === "queued" || d.state === "uncertain" || queueMayHoldDelivery(d)
        || d.comments.length > 0 || d.targets.some((t) => !dead.has(t))) return "delivery-pending";
    }
    return undefined;
  };
  for (let again = true; again; ) {
    again = false;
    for (const id of Object.keys(cand)) {
      const code = blocked(id);
      if (!code) continue;
      if (!all) {
        const reason = code === "comment-history-unavailable" ? "redaction would erase its delivery's only copy of a sent comment" : "its pending delivery cannot be cancelled";
        return refuse(code, `cannot delete ${JSON.stringify(id)}: ${reason}`);
      }
      delete cand[id];
      again = true;
    }
  }
  const gone = Object.keys(cand);
  if (!gone.length) return done(record);
  const questions = { ...record.questions };
  for (const id of gone) {
    const q = record.questions[id];
    const label = docQuestion(record, id)?.label ?? (q.label === q.prompt ? "" : q.label);
    if (q.items) {
      const items: Record<string, ItemRecord> = {};
      for (const itemId of Object.keys(q.items)) {
        const item = q.items[itemId];
        if (cand[id].indexOf(itemId) < 0) {
          items[itemId] = item;
          continue;
        }
        const { answer: _answer, ...rest } = item;
        items[itemId] = { ...rest, deleted: true };
      }
      const state = reviewState(items);
      // A review with items still open stays answerable; one that is settled is deleted whole.
      questions[id] = state === "open" ? { ...q, items } : { kind: q.kind, label, prompt: "", state, deleted: true, ...(q.delivery !== undefined ? { delivery: q.delivery } : {}) };
    } else {
      questions[id] = { kind: q.kind, label, prompt: "", state: q.state, deleted: true, ...(q.delivery !== undefined ? { delivery: q.delivery } : {}) };
    }
  }
  const document = record.document?.questions
    ? { ...record.document, questions: record.document.questions.map((q) =>
      gone.includes(q.id) && questions[q.id].deleted ? { ...q, prompt: "" } : q
    ) }
    : record.document;
  // A delivery's text is a copy of every answer it carried: it goes when any of them is deleted.
  // One that was never delivered is cancelled with it (state removed), so Retry cannot resend nothing.
  const dead = doomed();
  const deliveries = record.deliveries.map((d) => {
    if (d.text === "") return d;
    const touched = d.targets.some((t) => dead.has(t));
    if (!touched) return d;
    const next: Delivery = { ...d, text: "" };
    if (d.comments.length) {
      next.sentComments = { ...d.sentComments };
      for (const on of d.comments) {
        const comment = sentComment(d, on);
        if (comment) next.sentComments[on] = comment;
      }
    }
    delete next.receivedText;
    delete next.lastError;
    if (d.state !== "delivered") {
      next.state = "removed";
      next.updatedAt = cmd.now;
    }
    return next;
  });
  return done(bump(record, { document, questions, deliveries }));
}

export interface Compact {
  kind: "compact";
  now: string;
  retentionDays?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The time from which a record may be compacted: when it was resolved or orphaned, plus the retention period. */
export function compactableAt(record: SurfaceRecord, retentionDays: number = DEFAULT_RETENTION_DAYS): number | null {
  if (record.compactedAt) return null;
  const anchor = record.resolvedAt ?? record.orphanedAt;
  if (!anchor) return null;
  const t = Date.parse(anchor);
  return Number.isNaN(t) ? null : t + retentionDays * DAY_MS;
}

/**
 * Compaction (spec 26): the view, the snapshots and the evidence go; what spec
 * 11 lists as a decision stays. Questions still open (an orphaned surface)
 * expire. Unsent drafts go; sent comments, deliveries and answers stay.
 */
function compact(record: SurfaceRecord, cmd: Compact): Result {
  const at = compactableAt(record, cmd.retentionDays);
  if (at === null) return refuse("not-resolved", "this surface is still open, or was already compacted");
  if (Date.parse(cmd.now) < at) return refuse("not-resolved", "the retention period has not passed");
  const questions = { ...record.questions };
  for (const id of Object.keys(questions)) if (questions[id].state === "open") questions[id] = closeQuestion(questions[id]);
  const comments: Record<string, CommentRecord> = {};
  for (const on of Object.keys(record.comments)) if (record.comments[on].delivery !== null) comments[on] = record.comments[on];
  const next = bump(record, {
    document: null,
    snapshots: {},
    blockItems: {},
    questions,
    drafts: {},
    comments,
    compactedAt: cmd.now,
    resolvedAt: record.resolvedAt ?? cmd.now,
  });
  if (!next.closed && record.resolvedAt === null) next.closed = { at: cmd.now, by: "expired" };
  return done(next);
}

// --- the dispatcher ----------------------------------------------------------

export type Command =
  | SetDraft
  | SetComment
  | Send
  | Close
  | CloseReplaced
  | HoldOnArchive
  | AgentRestored
  | UpdateDelivery
  | RetryDelivery
  | DeleteDecisions
  | Compact;

/** Applies one command to a record. */
export function applyCommand(record: SurfaceRecord, cmd: Command): Result {
  switch (cmd.kind) {
    case "setDraft":
      return setDraft(record, cmd);
    case "setComment":
      return setComment(record, cmd);
    case "send":
      return sendRecord(record, cmd);
    case "close":
      return closeRecord(record, cmd);
    case "closeReplaced":
      return closeReplaced(record, cmd);
    case "holdOnArchive":
      return holdOnArchive(record, cmd);
    case "agentRestored":
      return agentRestored(record);
    case "updateDelivery":
      return updateDelivery(record, cmd);
    case "retryDelivery":
      return retryDelivery(record, cmd);
    case "deleteDecisions":
      return deleteDecisions(record, cmd);
    case "compact":
      return compact(record, cmd);
    default:
      return refuse("invalid", `unknown command ${JSON.stringify((cmd as { kind?: unknown }).kind)}`);
  }
}

export { surfaceStatus, hasOwn };
