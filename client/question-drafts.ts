import type { Question } from "../shared/document";
import { itemAddress } from "../shared/ids";
import { own, type AnswerRecord, type ItemAnswerRecord, type Draft, type DraftContent, type SurfaceRecord } from "../shared/record";
import { draftIncomplete } from "../shared/transitions";

interface OpenTarget {
  question: Question;
  target: string;
  item?: string;
}

export function openTargets(record: SurfaceRecord) {
  return (record.document?.questions ?? []).flatMap<OpenTarget>((question) => {
    const stored = own(record.questions, question.id);
    if (stored?.state !== "open") return [];
    if (question.kind !== "review") return [{ question, target: question.id }];
    return Object.entries(stored.items ?? {}).flatMap(([item, entry]) =>
      entry.state === "open" ? [{ question, target: itemAddress(question.id, item), item }] : []);
  });
}

export function sendableTargets(record: SurfaceRecord) {
  return openTargets(record).flatMap(({ question, target, item }) => {
    const draft = own(record.drafts, target);
    return draft && draftIncomplete(question, item, draft).length === 0 ? [{ target, version: draft.version }] : [];
  });
}

export function recommendation(question: Question, item?: string) {
  if (question.kind !== "review") return question.recommend;
  return typeof question.recommend === "string" ? question.recommend : own(question.recommend, item ?? "");
}

export function recommendations(record: SurfaceRecord) {
  return openTargets(record).flatMap(({ question, target, item }) => {
    const draft = own(record.drafts, target);
    const value = recommendation(question, item);
    if (value === undefined || draft?.skipped || draft?.value !== undefined || draft?.other !== undefined || draft?.verdict !== undefined) return [];
    const content: DraftContent = question.kind === "review"
      ? { verdict: value as string, comment: draft?.comment, by: "recommended" }
      : { value, note: draft?.note, by: "recommended" };
    return [{ target, content }];
  });
}

/** Keep store metadata out of the strict draft.set payload. */
export function draftWriteInput(surfaceId: string, target: string, baseVersion: number, content: (DraftContent & Partial<Pick<Draft, "version">>) | null) {
  if (content === null) return { surfaceId, target, baseVersion, draft: null };
  const { version: _storedVersion, ...draft } = content;
  return { surfaceId, target, baseVersion, draft };
}

export function draftPreview(draft?: DraftContent | { text: string } | null): string {
  if (draft && "text" in draft) return draft.text;
  if (draft?.skipped) return "Skipped";
  return [
    Array.isArray(draft?.value) ? draft.value.join(", ") : draft?.value,
    draft?.verdict,
    draft?.other && `Other: ${draft.other}`,
    draft?.note && `Note: ${draft.note}`,
    draft?.comment && `Comment: ${draft.comment}`,
  ].filter(Boolean).join("\n") || "Empty";
}

export function submittedPreview(answer: AnswerRecord | ItemAnswerRecord): string {
  if ("text" in answer) {
    const { text, ...content } = answer;
    return draftPreview({ ...content, value: text ?? content.value });
  }
  return draftPreview(answer);
}
