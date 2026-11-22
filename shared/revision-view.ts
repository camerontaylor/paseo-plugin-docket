import { parseChanges, splitHunks } from "./block-view";
import { blockId, reviewItems, viewBlocks, type PlanStep } from "./document";
import { refsInMarkdown } from "./evidence";
import { itemAddress } from "./ids";
import { own, type DraftContent, type ItemAnswerRecord, type SurfaceRecord } from "./record";

type Feedback = { prompt: string; answer?: ItemAnswerRecord; draft?: DraftContent };
type Item = {
  title: string;
  signature?: string;
  feedback: Feedback[];
  comment?: string;
  draftComment?: string;
};
type Mark = "New" | "Changed" | "Unchanged" | "Removed";
export type RevisionItem = { title: string; mark?: Mark; earlier?: Item };
export type ChangesText = ReadonlyMap<string, string>;

export function reviewAddress(question: string, item: string) {
  return `review:${itemAddress(question, item)}`;
}

function inventory(record: SurfaceRecord, changes: ChangesText) {
  const items = new Map<string, Item>();
  const refs = new Map(Object.values(record.snapshots).map(({ ref, hash }) => [ref, hash]));
  const fingerprint = (text?: string, references: string[] = []) =>
    [...new Set([...references, ...refsInMarkdown(text ?? "")])]
      .sort().map((ref) => [ref, refs.get(ref)]);
  function add(key: string, title: string, signature?: string) {
    const item = { title, signature, feedback: [] } satisfies Item;
    items.set(key, item);
    return items.get(key)!;
  }

  if (record.document) {
    for (const block of viewBlocks(record.document)) {
      if (typeof block === "string") continue;
      const id = blockId(block)!;
      if (block.t === "plan") {
        function walk(steps: PlanStep[], parent?: string) {
          for (const step of steps) {
            const files = typeof step.files === "string" ? [step.files] : step.files ?? [];
            add(itemAddress(id, step.id), step.title, JSON.stringify([
              "plan", parent, step.title, step.detail, step.status ?? "todo", step.ref, files,
              step.after ?? [], fingerprint(step.detail, [...(step.ref ? [step.ref] : []), ...files]),
            ]));
            if (step.children) walk(step.children, step.id);
          }
        }
        walk(block.steps);
      }
      if (block.t === "changes") {
        const text = changes.get(id);
        if (text === undefined) continue;
        try {
          for (const file of parseChanges(text).files) {
            const { id: fileId, path, oldPath, status, added, removed, patch, hunks } = file;
            add(itemAddress(id, fileId), oldPath ? `${oldPath} → ${path}` : path,
              patch ? JSON.stringify(["file", path, oldPath, status, added, removed, patch]) : undefined);
            const sections = splitHunks(patch);
            hunks?.forEach(({ id: hunkId, header }, index) => {
              add(itemAddress(id, hunkId), `${path} ${header}`,
                sections[index] === undefined ? undefined : JSON.stringify(["hunk", path, oldPath, sections[index]]));
            });
          }
        } catch {
          // Stored item titles and feedback remain available if evidence cannot be read.
        }
      }
    }
    for (const [block, entries] of Object.entries(record.blockItems)) {
      for (const { id, title } of entries) {
        const key = itemAddress(block, id);
        if (!items.has(key)) add(key, title);
      }
    }
  }

  const reviews = new Map(record.document?.questions?.flatMap((q) => q.kind === "review" ? [[q.id, q] as const] : []));
  for (const [id, question] of Object.entries(record.questions)) {
    if (question.kind !== "review") continue;
    const review = reviews.get(id);
    const definitions = new Map(review && !review.of ? reviewItems(review).map((item) => [item.id, item]) : []);
    for (const [itemId, state] of Object.entries(question.items ?? {})) {
      const draft = own(record.drafts, itemAddress(id, itemId));
      const answer = state.answer;
      // Older compacted surfaces no longer identify the block behind a review.
      if (!review && !draft && !answer) continue;
      const key = review?.of ? itemAddress(review.of, itemId)
        : review ? reviewAddress(id, itemId) : `retained:${itemAddress(id, itemId)}`;
      const definition = definitions.get(itemId);
      const item = items.get(key) ?? add(key, state.title, definition && JSON.stringify([
        "review", definition.title, definition.detail, definition.ref,
        fingerprint(definition.detail, definition.ref ? [definition.ref] : []),
      ]));
      const unsent = draft && Object.keys(draft).length > 1 ? draft : undefined;
      if (answer || unsent) {
        item.feedback.push({ prompt: question.prompt, answer, draft: unsent });
      }
    }
  }

  // A newer unsent edit can coexist with the previous sent version.
  const sent = new Map<string, string>();
  for (const delivery of record.deliveries) {
    for (const [key, comment] of Object.entries(delivery.sentComments ?? {})) {
      if (comment.text) {
        sent.set(key, comment.text);
        if (!items.has(key)) add(key, comment.title ?? key);
      }
    }
  }
  for (const [key, comment] of Object.entries(record.comments)) {
    if (!comment.text) continue;
    const item = items.get(key) ?? add(key, comment.title ?? key);
    if (comment.delivery === null) item.draftComment = comment.text;
    else sent.set(key, comment.text);
  }
  for (const [key, comment] of sent) items.get(key)!.comment = comment;
  return items;
}

export function revisionView(record: SurfaceRecord, earlier: SurfaceRecord, currentChanges: ChangesText, earlierChanges: ChangesText) {
  if (record.revises !== earlier.id || record.agentId !== earlier.agentId) return null;
  const before = inventory(earlier, earlierChanges);
  const current = new Map<string, RevisionItem>();
  for (const [key, item] of record.document ? inventory(record, currentChanges) : []) {
    const prior = before.get(key);
    const mark = prior
      ? prior.signature !== undefined && item.signature !== undefined
        ? prior.signature === item.signature ? "Unchanged" : "Changed"
        : prior.title !== item.title ? "Changed" : undefined
      : earlier.document ? "New" : undefined;
    current.set(key, { title: item.title, mark, earlier: prior });
    before.delete(key);
  }
  const removed = [...before].map(([key, item]) => ({
    key, title: item.title, mark: record.document && !key.startsWith("retained:") ? "Removed" as const : undefined, earlier: item,
  }));
  const incomplete = !earlier.document || (record.document && [...current.values()].some(({ mark }) => !mark));
  return { current, removed, incomplete };
}
