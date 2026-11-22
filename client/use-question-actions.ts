import { useRef, useState } from "react";
import { sendableComments } from "../shared/block-view";
import { commentSet, draftSet, send, deliveryRetry } from "../shared/rpc";
import { own, type DraftContent, type SurfaceRecord } from "../shared/record";
import type { Conflict } from "../shared/transitions";
import { drainDraftWrites, type DraftWriteResult, type Edit } from "./draft-write-queue";
import { callHost, getHub } from "./hub";
import { draftWriteInput, openTargets, recommendations, sendableTargets } from "./question-drafts";

const commentPrefix = "comment:";

interface DraftComparison {
  target: string;
  viewed: DraftContent | null;
  current: Conflict["current"];
}

const discardedMessage = {
  "target-not-open": "An unsaved edit was discarded because its question or review item is no longer open.",
  closed: "An unsaved edit was discarded because its target is closed.",
};

export function useQuestionActions(
  hostId: string,
  record: SurfaceRecord,
  refresh: () => Promise<SurfaceRecord | null | undefined>,
) {
  const surfaceId = record.id;
  const hub = getHub();
  const [error, setError] = useState<string>();
  const [discarded, setDiscarded] = useState<string>();
  const [comparison, setComparison] = useState<DraftComparison[]>([]);
  const [pending, setPending] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  const [overlay, setOverlay] = useState<ReadonlyMap<string, Edit>>(new Map());
  const edits = useRef(new Map<string, Edit>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const running = useRef(false);
  const submitting = useRef(false);
  const acknowledged = useRef(new Map<string, number>());

  function storedDraft(target: string) {
    if (!target.startsWith(commentPrefix)) return own(record.drafts, target);
    const comment = own(record.comments, target.slice(commentPrefix.length));
    return comment && { version: comment.version, comment: comment.delivery === null && comment.text ? comment.text : undefined };
  }

  async function write(target: string, edit: Edit): Promise<DraftWriteResult> {
    const reply = target.startsWith(commentPrefix)
      ? await callHost(hub, hostId, commentSet, { surfaceId, on: target.slice(commentPrefix.length), text: edit.content?.comment ?? null, baseVersion: edit.version })
      : await callHost(hub, hostId, draftSet, draftWriteInput(surfaceId, target, edit.version, edit.content));
    if ("version" in reply) return reply.version;
    if ("conflict" in reply) {
      setComparison([{ target, viewed: edits.current.has(target) ? edits.current.get(target)!.content : edit.content, current: reply.conflict }]);
      throw new Error("The draft changed on another client. Review both drafts before editing again.");
    }
    const { code, message } = reply.refusal;
    // Keep a buffered comment visible in the comparison/retry UI if the
    // surface is compacted before the write reaches the server.
    if (target.startsWith(commentPrefix) && code === "closed") {
      setComparison([{ target, viewed: (edits.current.get(target) ?? edit).content, current: null }]);
      throw new Error(message);
    }
    if (code === "target-not-open" || code === "closed") return code;
    throw new Error(message);
  }

  async function flush() {
    if (running.current || !edits.current.size) return;
    clearTimeout(timer.current);
    running.current = true;
    setPending(true);
    setError(undefined);
    setComparison([]);
    setDiscarded(undefined);
    try {
      do {
        await drainDraftWrites(edits.current, acknowledged.current, write, (reason) => {
          setDiscarded(discardedMessage[reason]);
        });
        await refresh();
      } while (edits.current.size);
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
      await refresh();
    } finally {
      running.current = false;
      acknowledged.current.clear();
      setOverlay(new Map(edits.current));
      setUnsaved(edits.current.size > 0);
      setPending(false);
    }
  }

  function save(target: string, content: DraftContent | null, defer = false, baseVersion?: number) {
    if (submitting.current) return;
    const version = baseVersion ?? edits.current.get(target)?.version ?? acknowledged.current.get(target) ?? storedDraft(target)?.version ?? 0;
    const edit = { content, version };
    edits.current.set(target, edit);
    setOverlay((prior) => new Map(prior).set(target, edit));
    setPending(true);
    clearTimeout(timer.current);
    if (defer) timer.current = setTimeout(() => void flush(), 350);
    else void flush();
  }

  async function perform(operation: () => Promise<void>) {
    if (pending || running.current || edits.current.size) return;
    running.current = true;
    submitting.current = true;
    setPending(true);
    setError(undefined);
    setComparison([]);
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      await refresh();
      running.current = false;
      submitting.current = false;
      setPending(false);
    }
  }

  function submit(mode: "send" | "recommended" | "skip") {
    return perform(async () => {
      const targets = sendableTargets(record);
      const viewed = new Map<string, DraftContent | null>(targets.map(({ target }) => [target, own(record.drafts, target) ?? null]));
      const additions = mode === "recommended" ? recommendations(record)
        : mode === "skip" ? openTargets(record).filter(({ target }) => !viewed.has(target)).map(({ target }) => ({
          target, content: { skipped: true } satisfies DraftContent,
        })) : [];
      for (const { target, content } of additions) {
        const version = await write(target, { content, version: own(record.drafts, target)?.version ?? 0 });
        if (typeof version !== "number") throw new Error("The question or surface is no longer open. Review its current state and try again.");
        viewed.set(target, content);
        targets.push({ target, version });
      }
      const comments = sendableComments(record);
      for (const { on } of comments) viewed.set(commentPrefix + on, storedDraft(commentPrefix + on) ?? null);
      const result = await callHost(hub, hostId, send, { surfaceId, targets, comments });
      if ("conflict" in result) {
        setComparison(result.conflict.map(({ target, current, kind }) => {
          const key = kind === "comment" ? commentPrefix + target : target;
          return { target: key, viewed: viewed.get(key) ?? null, current };
        }));
        throw new Error("Drafts changed on another client. Review both drafts before sending again.");
      }
      if ("refusal" in result) throw new Error(result.refusal.message);
      if ("closed" in result) throw new Error("This surface has closed.");
    });
  }

  function retry(n: number) {
    return perform(async () => {
      const result = await callHost(hub, hostId, deliveryRetry, { surfaceId, n });
      if ("refusal" in result) throw new Error(result.refusal.message);
    });
  }

  return {
    error, discarded, comparison, pending, unsaved, save, submit, retry,
    retryDrafts: flush,
    saveComment(on: string, text: string) {
      save(commentPrefix + on, text ? { comment: text } : null, true);
    },
    comment(on: string) {
      const edit = overlay.get(commentPrefix + on);
      return (edit ? edit.content : storedDraft(commentPrefix + on))?.comment;
    },
    resolveDraft(target: string, keepMine: boolean) {
      if (running.current) return;
      const edit = edits.current.get(target);
      if (!edit) return;
      if (keepMine) {
        const compared = comparison.find((entry) => entry.target === target)?.current;
        const stored = storedDraft(target);
        // A cleared draft is returned as null, so its version comes from the refreshed record.
        const version = compared?.version ?? stored?.version ?? 0;
        if (!compared && stored && (target.startsWith(commentPrefix) ? !!stored.comment : Object.keys(stored).length > 1)) {
          setComparison([{ target, viewed: edit.content, current: stored }]);
          return;
        }
        save(target, edit.content, false, version);
      } else {
        edits.current.delete(target);
        setOverlay(new Map(edits.current));
        setUnsaved(edits.current.size > 0);
        setComparison([]);
        setError(undefined);
      }
    },
    locked: pending && overlay.size === 0,
    draft(target: string) {
      const edit = overlay.get(target);
      return edit ? edit.content : own(record.drafts, target);
    },
  };
}
