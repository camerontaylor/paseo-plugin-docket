// Read-only views of records (spec 11, 26): the summary a list shows and the
// decisions the user can search and delete. Pure; the store feeds them records.

import type { Meanwhile, Question } from "./document";
import {
  type AnswerRecord,
  type DeliveryState,
  type ItemAnswerRecord,
  type QuestionRecord,
  type SurfaceRecord,
  type SurfaceStatus,
  surfaceStatus,
} from "./record";

export interface Summary {
  id: string;
  rev: number;
  agentId: string;
  workspaceId: string | null;
  summary: string;
  status: SurfaceStatus;
  createdAt: string;
  resolvedAt: string | null;
  openQuestions: number;
  /** Non-redacted deliveries still awaiting delivery or eligible for retry. */
  pendingDeliveries: number;
  replacedBy: string | null;
  revises: string | null;
  compacted: boolean;
  context?: string | null;
  meanwhile?: Meanwhile;
  snooze?: string | null;
  questions?: (Pick<QuestionRecord, "kind" | "label" | "state"> & {
    id: string;
    recommend?: Question["recommend"];
  })[];
  deliveries?: { n: number; state: DeliveryState }[];
}

export function summaryOf(record: SurfaceRecord): Summary {
  const ids = Object.keys(record.questions);
  return {
    id: record.id,
    rev: record.rev,
    agentId: record.agentId,
    workspaceId: record.workspaceId,
    summary: record.summary,
    status: surfaceStatus(record),
    createdAt: record.createdAt,
    resolvedAt: record.resolvedAt,
    openQuestions: ids.filter((id) => record.questions[id].state === "open").length,
    pendingDeliveries: record.deliveries.filter((d) => d.state !== "delivered" && d.text !== "").length,
    replacedBy: record.replacedBy,
    revises: record.revises,
    compacted: record.compactedAt !== null,
    context: record.context,
    meanwhile: record.meanwhile,
    snooze: record.snooze,
    questions: ids.map((id) => {
      const { kind, label, state } = record.questions[id];
      const recommend = record.document?.questions?.find((q) => q.id === id)?.recommend;
      return { id, kind, label, state, ...(recommend === undefined ? {} : { recommend }) };
    }),
    deliveries: record.deliveries.map(({ n, state }) => ({ n, state })),
  };
}

export interface DecisionItem {
  id: string;
  title: string;
  detail?: string;
  answer: ItemAnswerRecord;
}

/** One answered question of one surface; skipped questions are not decisions. */
export interface Decision {
  surfaceId: string;
  questionId: string;
  agentId: string;
  workspaceId: string | null;
  summary: string;
  context: string | null;
  label: string;
  prompt: string;
  kind: QuestionRecord["kind"];
  answer?: AnswerRecord;
  items?: DecisionItem[];
  /** When the answer was sent. */
  at: string;
  delivery: number | null;
  deliveryState: DeliveryState | null;
}

export function decisionsOf(record: SurfaceRecord): Decision[] {
  const out: Decision[] = [];
  for (const id of Object.keys(record.questions)) {
    const q = record.questions[id];
    if (q.deleted) continue;
    let items: DecisionItem[] | undefined;
    let at: string | null = null;
    if (q.items) {
      items = [];
      for (const itemId of Object.keys(q.items)) {
        const item = q.items[itemId];
        if (item.answer && !item.answer.skipped) {
          items.push({ id: itemId, title: item.title, ...(item.detail ? { detail: item.detail } : {}), answer: item.answer });
          if (at === null || item.answer.at > at) at = item.answer.at;
        }
      }
      if (!items.length) continue;
    } else if (q.answer && !q.answer.skipped) {
      at = q.answer.at;
    } else continue;
    // Every delivery that carried an answer; the decision shows the first one still outstanding.
    const ns: number[] = [];
    if (q.items) {
      for (const itemId of Object.keys(q.items)) {
        const it = q.items[itemId];
        if (it.answer && !it.answer.skipped && it.delivery !== undefined && ns.indexOf(it.delivery) < 0) ns.push(it.delivery);
      }
    } else if (q.delivery !== undefined) ns.push(q.delivery);
    const carriers = ns.map((n) => record.deliveries.find((x) => x.n === n)).filter((x): x is NonNullable<typeof x> => x !== undefined);
    const d = carriers.find((x) => x.state !== "delivered") ?? carriers[0];
    const delivery = d ? d.n : (q.delivery ?? null);
    out.push({
      surfaceId: record.id,
      questionId: id,
      agentId: record.agentId,
      workspaceId: record.workspaceId,
      summary: record.summary,
      context: record.context,
      label: q.label,
      prompt: q.prompt,
      kind: q.kind,
      ...(q.answer ? { answer: q.answer } : {}),
      ...(items ? { items } : {}),
      at: at as string,
      delivery,
      deliveryState: d ? d.state : null,
    });
  }
  return out;
}

export interface DecisionQuery {
  /** Every word must appear, in any case. */
  text?: string;
  agentId?: string;
  workspaceId?: string;
  /** ISO times; `since` inclusive, `until` exclusive. */
  since?: string;
  until?: string;
  limit?: number;
}

/** All the text of a decision a search looks through. */
export function decisionText(d: Decision): string {
  const parts: string[] = [d.label, d.prompt, d.summary];
  if (d.context) parts.push(d.context);
  if (d.answer) {
    for (const t of d.answer.text ?? []) parts.push(t);
    if (typeof d.answer.value === "string") parts.push(d.answer.value);
    if (d.answer.other) parts.push(d.answer.other);
    if (d.answer.note) parts.push(d.answer.note);
  }
  for (const item of d.items ?? []) {
    parts.push(item.id, item.title);
    if (item.detail) parts.push(item.detail);
    if (item.answer.verdict) parts.push(item.answer.verdict);
    if (item.answer.comment) parts.push(item.answer.comment);
  }
  return parts.join("\n").toLowerCase();
}

/** Newest first. */
export function searchDecisions(all: Decision[], query: DecisionQuery = {}): Decision[] {
  const words = (query.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const since = query.since === undefined ? -Infinity : Date.parse(query.since);
  const until = query.until === undefined ? Infinity : Date.parse(query.until);
  const out = all.filter((d) => {
    if (query.agentId !== undefined && d.agentId !== query.agentId) return false;
    if (query.workspaceId !== undefined && d.workspaceId !== query.workspaceId) return false;
    const at = Date.parse(d.at);
    if (at < since || at >= until) return false;
    if (!words.length) return true;
    const text = decisionText(d);
    return words.every((w) => text.includes(w));
  });
  out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return query.limit !== undefined ? out.slice(0, query.limit) : out;
}

/** True when nothing of the record is worth keeping once its decisions are deleted. */
export function allDecisionsDeleted(record: SurfaceRecord): boolean {
  const ids = Object.keys(record.questions);
  const deletedSome = ids.some((id) => {
    const q = record.questions[id];
    return q.deleted || (q.items !== undefined && Object.keys(q.items).some((i) => q.items?.[i].deleted));
  });
  return deletedSome && decisionsOf(record).length === 0;
}
