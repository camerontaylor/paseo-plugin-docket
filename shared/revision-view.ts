import { parseChanges, splitHunks } from "./block-view";
import { blockId, reviewItems, viewBlocks, type PlanStep } from "./document";
import { parseRef, refsInMarkdown } from "./evidence";
import { itemAddress } from "./ids";
import { own, type DraftContent, type ItemAnswerRecord, type SurfaceRecord } from "./record";

type Feedback = { prompt: string; answer?: ItemAnswerRecord; draft?: DraftContent };
type ChangeIdentity = { path: string; oldPath?: string; hunk?: string };
type Item = {
  change?: ChangeIdentity;
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
  const changeBlocks = new Set<string>();
  const loadedBlocks = new Set<string>();
  function withReferences(fields: unknown[], text?: string, references: string[] = []) {
    const hashes = [...new Set([...references.filter(parseRef), ...refsInMarkdown(text ?? "")])]
      .sort().map((ref) => [ref, refs.get(ref)]);
    return hashes.every(([, hash]) => hash) ? JSON.stringify([...fields, hashes]) : undefined;
  }
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
            add(itemAddress(id, step.id), step.title, withReferences([
              "plan", parent, step.title, step.detail, step.status ?? "todo", step.ref, files,
              step.after ?? [],
            ], step.detail, [...(step.ref ? [step.ref] : []), ...files]));
            if (step.children) walk(step.children, step.id);
          }
        }
        walk(block.steps);
      }
      if (block.t === "changes") {
        changeBlocks.add(id);
        const text = changes.get(id);
        if (text === undefined) continue;
        try {
          const { files } = parseChanges(text);
          loadedBlocks.add(id);
          for (const file of files) {
            const { id: fileId, path, oldPath, status, added, removed, patch, hunks } = file;
            const item = add(itemAddress(id, fileId), oldPath ? `${oldPath} → ${path}` : path,
              patch ? JSON.stringify(["file", path, oldPath, status, added, removed, patch]) : undefined);
            item.change = { path, oldPath };
            const sections = splitHunks(patch);
            const occurrences = new Map<string, number>();
            hunks?.forEach(({ id: hunkId, header }, index) => {
              const occurrence = (occurrences.get(header) ?? 0) + 1;
              occurrences.set(header, occurrence);
              const hunk = add(itemAddress(id, hunkId), `${path} ${header}`,
                sections[index] === undefined ? undefined : JSON.stringify(["hunk", path, oldPath, sections[index]]));
              hunk.change = { path, oldPath, hunk: JSON.stringify([header, occurrence]) };
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
      const item = items.get(key) ?? add(key, state.title, definition && withReferences([
        "review", definition.title, definition.detail, definition.ref,
      ], definition.detail, definition.ref ? [definition.ref] : []));
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
  return { items, changeBlocks, loadedBlocks };
}

function changeKey(block: string, path: string, hunk?: string) {
  return JSON.stringify([block, path, hunk]);
}

export function revisionView(record: SurfaceRecord, earlier: SurfaceRecord, currentChanges: ChangesText, earlierChanges: ChangesText) {
  if (record.revises !== earlier.id || record.agentId !== earlier.agentId) return null;
  const prior = inventory(earlier, earlierChanges);
  const next = inventory(record, currentChanges);
  const owner = (key: string) => key.startsWith("review:") ? "" : key.split(".", 1)[0];
  const before = prior.items;
  const changeBlocks = new Set([...prior.changeBlocks, ...next.changeBlocks]);
  const missing = new Set([...changeBlocks].filter((block) =>
    (prior.changeBlocks.has(block) && !prior.loadedBlocks.has(block)) ||
    (next.changeBlocks.has(block) && !next.loadedBlocks.has(block))));
  // Snapshot addresses are local to a surface. Use paths to find the old address.
  const oldAddresses = new Map<string, string>();
  const newPaths = new Set<string>();
  const renameClaims = new Map<string, number>();
  for (const [key, { change }] of before) {
    if (change) oldAddresses.set(changeKey(owner(key), change.path, change.hunk), key);
  }
  for (const [key, { change }] of next.items) {
    if (!change || change.hunk) continue;
    const block = owner(key);
    newPaths.add(changeKey(block, change.path));
    if (change.oldPath) {
      const old = changeKey(block, change.oldPath);
      renameClaims.set(old, (renameClaims.get(old) ?? 0) + 1);
    }
  }

  const current = new Map<string, RevisionItem>();
  for (const [key, item] of record.document ? next.items : []) {
    const block = owner(key);
    let priorKey: string | undefined = key;
    if (changeBlocks.has(block)) {
      priorKey = undefined;
      const change = item.change;
      if (change && !missing.has(block)) {
        const path = oldAddresses.has(changeKey(block, change.path)) ? change.path : undefined;
        const old = change.oldPath && changeKey(block, change.oldPath);
        const renamed = old && oldAddresses.has(old) && !newPaths.has(old) && renameClaims.get(old) === 1
          ? change.oldPath : undefined;
        const matched = renamed ?? path;
        if (matched) priorKey = oldAddresses.get(changeKey(block, matched, change.hunk));
      }
    }
    const previous = priorKey === undefined ? undefined : before.get(priorKey);
    const mark = previous
      ? previous.signature !== undefined && item.signature !== undefined
        ? previous.signature === item.signature ? "Unchanged" : "Changed"
        : undefined
      : earlier.document && !missing.has(block) ? "New" : undefined;
    current.set(key, { title: item.title, mark, earlier: previous });
    if (priorKey !== undefined) before.delete(priorKey);
  }
  const removed = [...before].map(([key, item]) => ({
    key, title: item.title,
    mark: record.document && earlier.document && !missing.has(owner(key)) && !key.startsWith("retained:")
      ? "Removed" as const : undefined,
    earlier: item,
  }));
  const incomplete = !earlier.document || missing.size > 0 || [...current.values()].some(({ mark }) => !mark);
  return { current, removed, incomplete };
}
