// Read-only views of records (spec 11, 26): the summary a list shows and the
// decisions the user can search and delete. Pure; the store feeds them records.

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
  /** Deliveries not yet delivered (queued, held, uncertain, failed, removed). */
  pendingDeliveries: number;
  replacedBy: string | null;
  revises: string | null;
  compacted: boolean;
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
    pendingDeliveries: record.deliveries.filter((d) => d.state !== "delivered").length,
    replacedBy: record.replacedBy,
    revises: record.revises,
    compacted: record.compactedAt !== null,
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
    const delivery = q.delivery ?? null;
    const d = delivery === null ? undefined : record.deliveries.find((x) => x.n === delivery);
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
  const out = all.filter((d) => {
    if (query.agentId !== undefined && d.agentId !== query.agentId) return false;
    if (query.workspaceId !== undefined && d.workspaceId !== query.workspaceId) return false;
    if (query.since !== undefined && d.at < query.since) return false;
    if (query.until !== undefined && d.at >= query.until) return false;
    if (!words.length) return true;
    const text = decisionText(d);
    return words.every((w) => text.includes(w));
  });
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return query.limit !== undefined ? out.slice(0, query.limit) : out;
}

/** True when nothing of the record is worth keeping once its decisions are deleted. */
export function allDecisionsDeleted(record: SurfaceRecord): boolean {
  return decisionsOf(record).length === 0 && Object.keys(record.questions).every((id) => {
    const q = record.questions[id];
    return q.deleted || q.state === "skipped" || q.state === "closed" || q.state === "open";
  }) && Object.keys(record.questions).some((id) => record.questions[id].deleted);
}
