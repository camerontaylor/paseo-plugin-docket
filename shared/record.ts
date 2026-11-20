// The stored record of one surface (spec section 26, with `rev` from plan D4 and
// the delivery states of plan D3). Plain data: every change to it is a pure
// function in `transitions.ts`, and the file store only reads and writes it.

import type { DeliveryTransport } from "./delivery";
import type { Meanwhile, SurfaceDocument } from "./document";

export const RECORD_SCHEMA = 1;

/** Days a resolved or orphaned surface keeps its view and evidence (spec 11, 28.1). */
export const DEFAULT_RETENTION_DAYS = 30;

/** An item a block offers for review or comment: a plan step, or a changed file or hunk. */
export interface ItemInfo {
  id: string;
  title: string;
  detail?: string;
}

/** What `docket_show` loaded for a `code`, `ref` or `changes` block (owned by the evidence slice). */
export interface Snapshot {
  path?: string;
  from?: number;
  to?: number;
  commit?: string;
  hash: string;
  readAt: string;
  bytes: number;
  [extra: string]: unknown;
}

/** What the user may have typed for a question or review item; a draft adds a version. */
export interface DraftContent {
  /** An option id, a list of ids (`multi`), or the text of a `text` answer. */
  value?: string | string[];
  /** A custom "Other" answer on a `choice`. */
  other?: string;
  note?: string;
  /** A review item's verdict. */
  verdict?: string;
  /** A review item's comment. */
  comment?: string;
  skipped?: boolean;
  /** Set when the user took the agent's recommendation. */
  by?: "recommended";
}

export type Draft = DraftContent & { version: number };

export type QuestionState = "open" | "answered" | "skipped" | "closed";

/** A sent answer, with the labels it was sent under so a decision reads without the document. */
export interface AnswerRecord {
  value?: string | string[];
  /** Labels of the chosen options, or the text answer. */
  text?: string[];
  other?: string;
  note?: string;
  skipped?: true;
  by?: "recommended";
  /** When it was sent. */
  at: string;
}

export interface ItemAnswerRecord {
  verdict?: string;
  comment?: string;
  skipped?: true;
  by?: "recommended";
  at: string;
}

export interface ItemRecord {
  state: QuestionState;
  title: string;
  detail?: string;
  answer?: ItemAnswerRecord;
  delivery?: number;
  /** Set when the user deleted this item's decision; its verdict and comment are gone. */
  deleted?: true;
}

export interface QuestionRecord {
  kind: "choice" | "text" | "review";
  label: string;
  prompt: string;
  state: QuestionState;
  answer?: AnswerRecord;
  delivery?: number;
  /** A review's items, by item id, in document order. */
  items?: Record<string, ItemRecord>;
  /** Set when the user deleted this decision; its content is gone. */
  deleted?: true;
}

export interface CommentRecord {
  version: number;
  /** Empty when the user cleared it. */
  text: string;
  title?: string;
  /** The delivery that carried this text; null until it is sent. */
  delivery: number | null;
}

export type DeliveryState = "queued" | "held" | "uncertain" | "delivered" | "failed" | "removed";

export interface Delivery {
  n: number;
  messageId: string;
  state: DeliveryState;
  attempts: number;
  createdAt: string;
  /** The frozen message text; never edited after the send. */
  text: string;
  /** The question or review-item targets and comment addresses this delivery carried. */
  targets: string[];
  comments: string[];
  /** Frozen comments by address, independent of later comment edits. */
  sentComments?: Record<string, CommentRecord>;
  /** True after queue acceptance, false after cleanup, absent while acceptance is unknown. */
  enqueued?: boolean;
  /** The transport used for this attempt, so a settings change cannot resend it. */
  transport?: DeliveryTransport;
  /** A direct send returned successfully and is waiting for timeline confirmation. */
  sent?: boolean;
  /** The queue revision authorized by an explicit Retry of an existing item. */
  queueRetryRevision?: number;
  deliveredAt?: string;
  updatedAt?: string;
  /** The text that arrived, when the user rewrote the queued item and it differs from `text`. */
  receivedText?: string;
  lastError?: string;
}

export interface Closed {
  at: string;
  by: "agent" | "replaced" | "expired";
  reason?: string;
}

export interface SurfaceRecord {
  schema: 1;
  id: string;
  /** Rises by one on every write (plan D4). */
  rev: number;
  agentId: string;
  workspaceId: string | null;
  createdAt: string;
  /** Copied from the document so summaries and decisions survive compaction. */
  summary: string;
  context: string | null;
  meanwhile: Meanwhile;
  /** The view; null after compaction. */
  document: SurfaceDocument | null;
  revises: string | null;
  replacedBy: string | null;
  /** Reviewable and commentable items by block id: plan steps, changed files. */
  blockItems: Record<string, ItemInfo[]>;
  snapshots: Record<string, Snapshot>;
  questions: Record<string, QuestionRecord>;
  /** Keyed by target: a question id, or `question.item` for one review item. */
  drafts: Record<string, Draft>;
  /** Keyed by `block.item`. */
  comments: Record<string, CommentRecord>;
  deliveries: Delivery[];
  snooze: string | null;
  closed: Closed | null;
  /** When the last open question stopped being open. */
  resolvedAt: string | null;
  /** When the agent was archived; cleared when it is restored. */
  orphanedAt: string | null;
  compactedAt: string | null;
}

export type SurfaceStatus = "open" | "resolved" | "orphaned";

/** Own-property lookup. Ids such as `constructor` are valid and must not find inherited members. */
export function own<T>(dict: Record<string, T> | undefined | null, key: string): T | undefined {
  return dict && Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : undefined;
}

export function hasOwn(dict: object | undefined | null, key: string): boolean {
  return !!dict && Object.prototype.hasOwnProperty.call(dict, key);
}

export function questionIsOpen(q: QuestionRecord): boolean {
  return q.state === "open";
}

export function hasOpenQuestion(record: SurfaceRecord): boolean {
  return Object.keys(record.questions).some((id) => record.questions[id].state === "open");
}

/** `open` while any question is open, else `resolved`; `orphaned` when the agent was archived with questions still open. */
export function surfaceStatus(record: SurfaceRecord): SurfaceStatus {
  if (!hasOpenQuestion(record)) return "resolved";
  return record.orphanedAt ? "orphaned" : "open";
}

/** A review item's state, and so the question's, from its items. */
export function reviewState(items: Record<string, ItemRecord>): QuestionState {
  const states = Object.keys(items).map((id) => items[id].state);
  if (states.includes("open")) return "open";
  if (states.includes("answered")) return "answered";
  if (states.includes("skipped")) return "skipped";
  return "closed";
}

/** True for a stored draft or comment that holds nothing (a cleared one keeps its version). */
export function draftIsEmpty(draft: Draft): boolean {
  return Object.keys(draft).every((key) => key === "version");
}

/** A record read from disk that this build understands. Unknown schemas are never passed here. */
export function isRecordV1(value: unknown): value is SurfaceRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const state = (v: unknown): boolean => v === "open" || v === "answered" || v === "skipped" || v === "closed";
  const nullableString = (v: unknown): boolean => v === null || typeof v === "string";
  return (
    r.schema === 1 &&
    typeof r.id === "string" &&
    typeof r.rev === "number" &&
    typeof r.agentId === "string" &&
    typeof r.createdAt === "string" &&
    typeof r.summary === "string" &&
    nullableString(r.revises) &&
    nullableString(r.replacedBy) &&
    nullableString(r.orphanedAt) &&
    nullableString(r.resolvedAt) &&
    (r.compactedAt === null || (typeof r.compactedAt === "string" && Number.isFinite(Date.parse(r.compactedAt)) && r.document === null)) &&
    (r.document === null || obj(r.document)) &&
    obj(r.questions) &&
    Object.values(r.questions).every((q) =>
      obj(q) && (q.kind === "choice" || q.kind === "text" || q.kind === "review")
      && typeof q.label === "string" && typeof q.prompt === "string" && state(q.state)
      && (q.items === undefined || (obj(q.items) && Object.values(q.items).every((item) =>
        obj(item) && typeof item.title === "string" && state(item.state)
      )))
    ) &&
    obj(r.drafts) &&
    obj(r.comments) &&
    obj(r.blockItems) &&
    obj(r.snapshots) &&
    Array.isArray(r.deliveries)
  );
}
