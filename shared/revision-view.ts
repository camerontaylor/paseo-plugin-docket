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
  const renameClaims = new Map<string, number>();
  const fileMatches = new Map<string, string>();
  const claimed = new Set<string>();
  const uncertainCurrent = new Set<string>();
  const uncertainEarlier = new Set<string>();
  for (const [key, { change }] of before) {
    if (change) oldAddresses.set(changeKey(owner(key), change.path, change.hunk), key);
  }
  const nextFiles = [...next.items].flatMap(([key, { change }]) =>
    change && change.hunk === undefined && !missing.has(owner(key)) ? [{ block: owner(key), ...change }] : []);
  function match(block: string, path: string, previousPath: string) {
    fileMatches.set(changeKey(block, path), previousPath);
    claimed.add(changeKey(block, previousPath));
  }

  // Reserve corroborated rename destinations before matching new rename origins.
  for (const { block, path, oldPath } of nextFiles) {
    const destination = changeKey(block, path);
    const atDestination = oldAddresses.get(destination);
    if (oldPath && atDestination && before.get(atDestination)?.change?.oldPath === oldPath) {
      match(block, path, path);
    } else if (oldPath) {
      const origin = changeKey(block, oldPath);
      renameClaims.set(origin, (renameClaims.get(origin) ?? 0) + 1);
    }
  }
  for (const { block, path, oldPath } of nextFiles) {
    if (!oldPath) continue;
    const destination = changeKey(block, path);
    const origin = changeKey(block, oldPath);
    if (!fileMatches.has(destination) && oldAddresses.has(origin) && !claimed.has(origin) && renameClaims.get(origin) === 1) {
      match(block, path, oldPath);
    }
  }
  for (const { block, path, oldPath } of nextFiles) {
    const destination = changeKey(block, path);
    if (fileMatches.has(destination)) continue;
    const atDestination = oldAddresses.get(destination);
    const priorFile = atDestination && before.get(atDestination)?.change;
    if (!oldPath && priorFile && !priorFile.oldPath && !claimed.has(destination)) {
      match(block, path, path);
      continue;
    }
    for (const [key, { change }] of before) {
      if (!change || change.hunk !== undefined || owner(key) !== block) continue;
      const priorPath = changeKey(block, change.path);
      if (claimed.has(priorPath)) continue;
      if (change.path === path || change.oldPath === path || (oldPath && [change.path, change.oldPath].includes(oldPath))) {
        uncertainCurrent.add(destination);
        uncertainEarlier.add(priorPath);
      }
    }
    if (oldPath) uncertainCurrent.add(destination);
  }

  const current = new Map<string, RevisionItem>();
  for (const [key, item] of record.document ? next.items : []) {
    const block = owner(key);
    let priorKey: string | undefined = key;
    if (changeBlocks.has(block)) {
      priorKey = undefined;
      const change = item.change;
      if (change && !missing.has(block)) {
        const matched = fileMatches.get(changeKey(block, change.path));
        if (matched) priorKey = oldAddresses.get(changeKey(block, matched, change.hunk));
      }
    }
    const uncertain = item.change && uncertainCurrent.has(changeKey(block, item.change.path));
    const previous = priorKey === undefined ? undefined : before.get(priorKey);
    const mark = previous
      ? previous.signature !== undefined && item.signature !== undefined
        ? previous.signature === item.signature ? "Unchanged" : "Changed"
        : undefined
      : earlier.document && !missing.has(block) && !uncertain ? "New" : undefined;
    current.set(key, { title: item.title, mark, earlier: previous });
    if (priorKey !== undefined) before.delete(priorKey);
  }
  const removed = [...before].map(([key, item]) => ({
    key, title: item.title,
    mark: record.document && earlier.document && !missing.has(owner(key)) && !key.startsWith("retained:") &&
      !(item.change && uncertainEarlier.has(changeKey(owner(key), item.change.path)))
      ? "Removed" as const : undefined,
    earlier: item,
  }));
  const incomplete = !earlier.document || missing.size > 0 || [...current.values()].some(({ mark }) => !mark);
  return { current, removed, incomplete };
}
