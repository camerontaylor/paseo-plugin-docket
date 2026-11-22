import type { DraftContent } from "../shared/record";

export interface Edit {
  content: DraftContent | null;
  version: number;
}

export type DraftWriteResult = number | "target-not-open" | "closed";

/** Drain edits in order. Only acknowledgements and terminal refusals remove edits. */
export async function drainDraftWrites(
  edits: Map<string, Edit>,
  acknowledged: Map<string, number>,
  write: (target: string, edit: Edit) => Promise<DraftWriteResult>,
  onDiscard: (reason: "target-not-open" | "closed") => void,
) {
  while (edits.size) {
    const [target, edit] = edits.entries().next().value!;
    const result = await write(target, edit);
    if (result === "closed") {
      edits.clear();
      onDiscard(result);
      return;
    }
    if (result === "target-not-open") {
      // A newer edit for this same target would also be refused.
      edits.delete(target);
      onDiscard(result);
      continue;
    }
    acknowledged.set(target, result);
    const next = edits.get(target);
    if (next === edit) edits.delete(target);
    else if (next) next.version = result;
  }
}
