// The file store (plan S2, spec 26, D8): one JSON record per surface under
// `<root>/surfaces/<id>/record.json`, written through a temp file and a rename.
// Records are held in memory after the start scan; every change goes through a
// pure transition in `shared/` and the store only persists the result. Node
// only; may use `class`.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  type Command,
  type CreateInput,
  type Decision,
  type DecisionQuery,
  type ItemInfo,
  type Refusal,
  type Snapshot,
  type Summary,
  type SurfaceDocument,
  type SurfaceRecord,
  DEFAULT_RETENTION_DAYS,
  allDecisionsDeleted,
  applyCommand,
  compactableAt,
  createRecord,
  decisionsOf,
  hasOpenQuestion,
  isRecordV1,
  newSurfaceId,
  searchDecisions,
  summaryOf,
  surfaceStatus,
} from "../shared";

/** `$PASEO_HOME/plugin-data/docket`, with `~/.paseo` when `PASEO_HOME` is unset (plan D8). */
export function defaultStoreRoot(env: Record<string, string | undefined> = process.env): string {
  const home = env.PASEO_HOME && env.PASEO_HOME !== "" ? env.PASEO_HOME : path.join(homedir(), ".paseo");
  return path.join(home, "plugin-data", "docket");
}

/** Named points where a test can stop the store between two writes. */
export type CrashPoint = "create:evidence-written" | "write:tmp-written" | "replace:new-written";

export class InjectedCrash extends Error {
  constructor(public readonly point: CrashPoint) {
    super(`injected crash at ${point}`);
  }
}

export interface StoreOptions {
  root?: string;
  now?: () => Date;
  /** A number in [0, 1) for new surface ids; defaults to a crypto-backed source. */
  random?: () => number;
  retentionDays?: number;
  /** The `recordEvents` setting: when false, `events.jsonl` is not written. Default true. */
  recordEvents?: boolean;
  /** Test hook: throws `InjectedCrash` when the store reaches this point. */
  crashAt?: (point: CrashPoint, surfaceId: string) => void;
}

export interface CreateRequest {
  agentId: string;
  workspaceId?: string | null;
  document: SurfaceDocument;
  /** Files the evidence slice loaded, by name; written under `evidence/<id>/` before the record. */
  evidence?: Record<string, string>;
  snapshots?: Record<string, Snapshot>;
  changeItems?: Record<string, ItemInfo[]>;
}

export type StoreResult =
  | { ok: true; record: SurfaceRecord; delivery?: SurfaceRecord["deliveries"][number] }
  | { ok: false; refusal: Refusal };

export interface ChangeEvent {
  surfaceId: string;
  rev: number;
  /** "removed" when the record's file was deleted. */
  removed?: boolean;
}

export interface Unreadable {
  surfaceId: string;
  file: string;
  reason: string;
}

export interface Store {
  readonly root: string;
  /** Records the start scan could not read (unknown schema, bad JSON); never touched. */
  readonly unreadable: Unreadable[];
  create(request: CreateRequest): Promise<StoreResult>;
  get(id: string): SurfaceRecord | undefined;
  list(filter?: { agentId?: string; workspaceId?: string }): SurfaceRecord[];
  apply(id: string, command: Command): Promise<StoreResult>;
  /** Open surfaces and those resolved in the last seven days. */
  summary(id: string): Summary | undefined;
  summaries(filter?: { agentId?: string; workspaceId?: string }): Summary[];
  decisions(query?: DecisionQuery): Decision[];
  deleteDecision(surfaceId: string, questionId: string): Promise<StoreResult>;
  deleteAgentDecisions(agentId: string): Promise<number>;
  /** Compacts every record whose retention period has passed; returns the ids. */
  compactDue(): Promise<string[]>;
  /** Closes the surface a new one revises (repair is also done at start). */
  onChange(listener: (event: ChangeEvent) => void): () => void;
  recordEvent(event: string, fields?: Record<string, string | number | boolean | null>): Promise<void>;
}

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const DAY_MS = 24 * 60 * 60 * 1000;

function defaultRandom(): number {
  const out = new Uint32Array(1);
  globalThis.crypto.getRandomValues(out);
  return out[0] / 2 ** 32;
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  await fs.chmod(dir, DIR_MODE);
}

export async function openStore(options: StoreOptions = {}): Promise<Store> {
  const root = options.root ?? defaultStoreRoot();
  const now = options.now ?? (() => new Date());
  const random = options.random ?? defaultRandom;
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const recordEvents = options.recordEvents ?? true;
  const crashAt = options.crashAt ?? (() => undefined);
  const surfacesDir = path.join(root, "surfaces");
  const evidenceDir = path.join(root, "evidence");
  const eventsFile = path.join(root, "events.jsonl");
  const iso = (): string => now().toISOString();

  const records = new Map<string, SurfaceRecord>();
  const unreadable: Unreadable[] = [];
  const listeners = new Set<(event: ChangeEvent) => void>();

  // One write at a time per surface: a promise chain per id, and one for creates.
  const chains = new Map<string, Promise<unknown>>();
  function locked<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = chains.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    const tail = run.catch(() => undefined);
    chains.set(key, tail);
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return run;
  }
  const CREATE_LOCK = "\u0000create";

  const recordPath = (id: string): string => path.join(surfacesDir, id, "record.json");

  function emit(event: ChangeEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // a listener's failure is not the store's
      }
    }
  }

  async function writeFileAtomic(file: string, data: string, surfaceId: string): Promise<void> {
    await ensureDir(path.dirname(file));
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    const handle = await fs.open(tmp, "wx", FILE_MODE);
    try {
      try {
        await handle.writeFile(data, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.chmod(tmp, FILE_MODE);
      crashAt("write:tmp-written", surfaceId);
      await fs.rename(tmp, file);
    } catch (error) {
      if (!(error instanceof InjectedCrash)) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  async function persist(record: SurfaceRecord): Promise<void> {
    await writeFileAtomic(recordPath(record.id), JSON.stringify(record, null, 2) + "\n", record.id);
    records.set(record.id, record);
    emit({ surfaceId: record.id, rev: record.rev });
  }

  async function removeRecord(record: SurfaceRecord): Promise<void> {
    await fs.rm(path.join(surfacesDir, record.id), { recursive: true, force: true });
    await fs.rm(path.join(evidenceDir, record.id), { recursive: true, force: true });
    records.delete(record.id);
    emit({ surfaceId: record.id, rev: record.rev, removed: true });
  }

  // --- start scan ------------------------------------------------------------

  async function sweepTemp(dir: string): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) if (name.endsWith(".tmp")) await fs.rm(path.join(dir, name), { force: true });
  }

  async function scan(): Promise<void> {
    await ensureDir(root);
    await ensureDir(surfacesDir);
    await ensureDir(evidenceDir);
    const ids = await fs.readdir(surfacesDir);
    for (const id of ids) {
      const dir = path.join(surfacesDir, id);
      await sweepTemp(dir);
      const file = recordPath(id);
      let raw: string;
      try {
        raw = await fs.readFile(file, "utf8");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") unreadable.push({ surfaceId: id, file, reason: code ? `read failed (${code})` : "read failed" });
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        unreadable.push({ surfaceId: id, file, reason: "not valid JSON" });
        continue;
      }
      if (!isRecordV1(parsed) || parsed.id !== id) {
        const schema = typeof parsed === "object" && parsed !== null ? (parsed as { schema?: unknown }).schema : undefined;
        unreadable.push({ surfaceId: id, file, reason: schema === 1 ? "not a valid record" : `unknown schema ${JSON.stringify(schema)}` });
        continue;
      }
      records.set(id, parsed);
    }

    // Repair a half-finished replacement: the new record was written, the old one never closed.
    const revisers = [...records.values()]
      .filter((r) => r.revises !== null)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
    for (const reviser of revisers) {
      const old = records.get(reviser.revises as string);
      if (!old || old.agentId !== reviser.agentId) continue;
      const result = applyCommand(old, { kind: "closeReplaced", by: reviser.id, now: iso() });
      if (result.ok && result.record !== old) await persist(result.record);
    }

    // Evidence with no record, or whose record was compacted, is leftover.
    let evidenceIds: string[] = [];
    try {
      evidenceIds = await fs.readdir(evidenceDir);
    } catch {
      evidenceIds = [];
    }
    for (const id of evidenceIds) {
      const record = records.get(id);
      const kept = record ? record.compactedAt === null : unreadable.some((u) => u.surfaceId === id);
      if (!kept) await fs.rm(path.join(evidenceDir, id), { recursive: true, force: true });
    }
  }

  await scan();

  // --- api -------------------------------------------------------------------

  function openSurfacesOf(agentId: string, except?: string | null): string[] {
    return [...records.values()]
      .filter((r) => r.agentId === agentId && r.id !== except && hasOpenQuestion(r) && r.replacedBy === null)
      .map((r) => r.id)
      .sort();
  }

  async function create(request: CreateRequest): Promise<StoreResult> {
    // A replacement holds the revised surface's lock throughout, so a deletion cannot remove it halfway.
    const revisesKey = request.document.revises;
    return locked(CREATE_LOCK, () => (revisesKey === undefined ? createLocked(request) : locked(revisesKey, () => createLocked(request))));
  }

  async function createLocked(request: CreateRequest): Promise<StoreResult> {
    {
      const revisesId = request.document.revises;
      const revised = revisesId !== undefined ? (records.get(revisesId) ?? null) : null;
      const id = newSurfaceId(random, (candidate) => records.has(candidate) || unreadable.some((u) => u.surfaceId === candidate));
      const input: CreateInput = {
        id,
        agentId: request.agentId,
        workspaceId: request.workspaceId ?? null,
        now: iso(),
        document: request.document,
        changeItems: request.changeItems,
        snapshots: request.snapshots,
        revised,
        agentOpenSurfaces: openSurfacesOf(request.agentId, revised ? revised.id : null),
      };
      const made = createRecord(input);
      if (!made.ok) return made;

      // Evidence first: a record never points at evidence that is not on disk.
      const files = Object.keys(request.evidence ?? {});
      if (files.length) {
        const dir = path.join(evidenceDir, id);
        await ensureDir(dir);
        for (const name of files) {
          const safe = path.basename(name);
          await writeFileAtomic(path.join(dir, safe), (request.evidence as Record<string, string>)[name], id);
        }
      }
      crashAt("create:evidence-written", id);
      await persist(made.record);

      // A replacement starts open; only then does the old surface close.
      if (revised) {
        crashAt("replace:new-written", id);
        const current = records.get(revised.id) as SurfaceRecord;
        const closed = applyCommand(current, { kind: "closeReplaced", by: id, now: iso() });
        if (closed.ok && closed.record !== current) await persist(closed.record);
      }
      return made;
    }
  }

  /** Remove only surfaces with deleted decisions and no open questions, comments, or pending deliveries. */
  function removable(record: SurfaceRecord): boolean {
    return allDecisionsDeleted(record)
      && !hasOpenQuestion(record)
      && !Object.values(record.comments).some((c) => c.text !== "" || c.delivery !== null)
      && !record.deliveries.some((d) => d.comments.length > 0)
      && record.deliveries.every((d) => d.state === "delivered" || d.text === "");
  }

  // Callers hold the surface lock across the transition and any related reads.
  async function applyLocked(id: string, command: Command): Promise<StoreResult> {
    const record = records.get(id);
    if (!record) {
      return { ok: false, refusal: { code: "unknown-target", message: `there is no surface ${id}` } };
    }
    const result = applyCommand(record, command);
    if (!result.ok) return result;
    if ((command.kind === "deleteDecisions" || command.kind === "updateDelivery") && removable(result.record)) {
      await removeRecord(record);
      return result;
    }
    if (result.record !== record) await persist(result.record);
    return result;
  }

  function apply(id: string, command: Command): Promise<StoreResult> {
    return locked(id, () => applyLocked(id, command));
  }

  function listRecords(filter: { agentId?: string; workspaceId?: string } = {}): SurfaceRecord[] {
    return [...records.values()]
      .filter((r) => (filter.agentId === undefined || r.agentId === filter.agentId) && (filter.workspaceId === undefined || r.workspaceId === filter.workspaceId))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
  }

  function isListed(record: SurfaceRecord, cutoff: number): boolean {
    return surfaceStatus(record) !== "resolved" ||
      (record.resolvedAt !== null && Date.parse(record.resolvedAt) >= cutoff);
  }

  function summaries(filter: { agentId?: string; workspaceId?: string } = {}): Summary[] {
    const cutoff = now().getTime() - 7 * DAY_MS;
    return listRecords(filter)
      .filter((record) => isListed(record, cutoff))
      .map(summaryOf);
  }

  function decisions(query: DecisionQuery = {}): Decision[] {
    const all: Decision[] = [];
    for (const record of records.values()) all.push(...decisionsOf(record));
    return searchDecisions(all, query);
  }

  async function deleteDecision(surfaceId: string, questionId: string): Promise<StoreResult> {
    return apply(surfaceId, { kind: "deleteDecisions", questions: [questionId], now: iso() });
  }

  async function deleteAgentDecisions(agentId: string): Promise<number> {
    let count = 0;
    for (const { id } of listRecords({ agentId })) {
      count += await locked(id, async () => {
        const record = records.get(id);
        if (!record) return 0;
        const before = decisionsOf(record).length;
        const result = await applyLocked(id, { kind: "deleteDecisions", now: iso() });
        const after = records.get(id);
        return result.ok ? before - (after ? decisionsOf(after).length : 0) : 0;
      });
    }
    return count;
  }

  async function compactDue(): Promise<string[]> {
    const done: string[] = [];
    for (const record of listRecords()) {
      const at = compactableAt(record, retentionDays);
      if (at === null || now().getTime() < at) continue;
      const result = await apply(record.id, { kind: "compact", now: iso(), retentionDays });
      if (!result.ok) continue;
      // The record is written before the evidence goes: a crash leaves evidence the next start sweeps.
      await fs.rm(path.join(evidenceDir, record.id), { recursive: true, force: true });
      done.push(record.id);
    }
    return done;
  }

  async function recordEvent(event: string, fields: Record<string, string | number | boolean | null> = {}): Promise<void> {
    if (!recordEvents) return;
    const line = JSON.stringify({ at: iso(), event, ...fields }) + "\n";
    await ensureDir(root);
    await fs.appendFile(eventsFile, line, { mode: FILE_MODE });
    await fs.chmod(eventsFile, FILE_MODE);
  }

  return {
    root,
    unreadable,
    create,
    get: (id) => records.get(id),
    list: listRecords,
    apply,
    summary(id) {
      const record = records.get(id);
      if (record && isListed(record, now().getTime() - 7 * DAY_MS)) return summaryOf(record);
    },
    summaries,
    decisions,
    deleteDecision,
    deleteAgentDecisions,
    compactDue,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    recordEvent,
  };
}
