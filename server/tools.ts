import { mkdir } from "node:fs/promises";
import path from "node:path";
import { defineSettings } from "@getpaseo/plugin";
import { defineAgentTool, type PluginServerContext, type PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { z } from "zod";
import { acceptToolInput, formatProblems } from "../shared/accept";
import { isSurfaceId } from "../shared/ids";
import { DEFAULT_RETENTION_DAYS, hasOpenQuestion, surfaceStatus, type SurfaceRecord } from "../shared/record";
import { renderText, truncateRendered } from "../shared/text";
import { SHOW_INPUT_SCHEMA } from "../shared/tool-schema";
import { pointerToken, type Problem } from "../shared/validate";
import { loadEvidence } from "./evidence/load";
import { defaultStoreRoot, type Store } from "./store";
import { TOOL_INSTRUCTIONS } from "./tool-instructions";

const settingsSchema = z.object({
  agentTools: z.boolean().default(true),
  allowToolPermissions: z.boolean().default(true),
  sound: z.boolean().default(false),
  extraFolders: z.array(z.string().refine(path.isAbsolute, "Use an absolute path")).default([]),
  retentionDays: z.number().int().nonnegative().default(DEFAULT_RETENTION_DAYS),
  recordEvents: z.boolean().default(true),
});

export function registerToolSettings(server: PluginServerContext) {
  const settings = server.registerSettings(defineSettings({
    id: "docket",
    scope: "host",
    version: 1,
    schema: settingsSchema,
  }));
  return async () => {
    const state = await settings.read();
    return state.status === "ready" ? state.values : settingsSchema.parse({});
  };
}

type ReadSettings = ReturnType<typeof registerToolSettings>;
const names = ["docket_show", "docket_close", "docket_get"] as const;
const permissionNames = new Set(names.flatMap((name) => [`mcp__paseo__${name}`, `paseo.${name}`]));
const surfaceId = z.string().refine(isSurfaceId, "Use a Docket surface id");

export function isDocketPermission(name: string): boolean {
  return permissionNames.has(name);
}

export async function attachDocketTools(
  request: PluginSessionOpenRequest,
  readSettings: ReadSettings,
  getStore: () => Promise<Store>,
): Promise<PluginSessionOpenRequest> {
  if (!(await readSettings()).agentTools || request.purpose === "history") return request;
  const storage = agentStorage(request.agentId);
  await mkdir(storage, { recursive: true, mode: 0o700 });
  return {
    ...request,
    env: { ...request.env, DOCKET_STORAGE: storage },
    tools: [...request.tools, ...createDocketTools(getStore, readSettings)],
  };
}

function agentStorage(agentId: string): string {
  // The daemon supplies the id. Keep even imported ids in a single directory component.
  return path.join(defaultStoreRoot(), "agents", encodeURIComponent(agentId).replaceAll(".", "%2E"));
}

function openSurfaces(store: Store, agentId: string) {
  return store.list({ agentId }).filter(hasOpenQuestion);
}

function responseOf(record: SurfaceRecord) {
  const answers: Record<string, unknown> = Object.create(null);
  const open: string[] = [];
  for (const [id, question] of Object.entries(record.questions)) {
    if (question.items) {
      const value: Record<string, unknown> = Object.create(null);
      for (const [itemId, item] of Object.entries(question.items)) {
        if (item.state === "open") open.push(`${id}.${itemId}`);
        if (item.answer) {
          const { at, ...answer } = item.answer;
          value[itemId] = answer;
        }
      }
      if (Object.keys(value).length) answers[id] = { value };
    } else {
      if (question.state === "open") open.push(id);
      if (question.answer) {
        const { at, text, ...answer } = question.answer;
        answers[id] = answer;
      }
    }
  }
  const draftComments = Object.fromEntries(Object.entries(record.comments).filter(([, comment]) => comment.delivery === null));
  const sentComments = record.deliveries.flatMap((delivery) =>
    delivery.comments.flatMap((on) => {
      const current = Object.hasOwn(record.comments, on) ? record.comments[on] : undefined;
      const sent = delivery.sentComments && Object.hasOwn(delivery.sentComments, on)
        ? delivery.sentComments[on]
        : current?.delivery === delivery.n ? current : undefined;
      return sent?.text ? [{ on, text: sent.text }] : [];
    }),
  );
  return {
    surface: record.id,
    status: surfaceStatus(record),
    delivery: record.deliveries.at(-1)?.n ?? 0,
    answers,
    comments: sentComments,
    open,
    drafts: record.drafts,
    draftComments,
  };
}

function failure(text: string) {
  return { isError: true, text };
}

function logShow(store: Store, agentId: string, valid: boolean) {
  // Sampling is best effort and never changes whether the tool may show.
  return store.recordEvent("tool.show", { agentId, valid }).catch(() => undefined);
}

function jsonResult(data: object) {
  return { text: JSON.stringify(data), structuredContent: data };
}

export function createDocketTools(getStore: () => Promise<Store>, readSettings: ReadSettings) {
  const show = defineAgentTool({
    name: names[0],
    title: "Show a Docket surface",
    description: TOOL_INSTRUCTIONS,
    // The advertised schema guides the caller. Preserve the original input for
    // the validator, which reports all problems with document-relative pointers.
    input: z.looseObject({ surface: z.unknown().meta(SHOW_INPUT_SCHEMA.properties.surface) }),
    async execute(input, { agent, signal }) {
      const checked = acceptToolInput(input);
      if (!checked.ok || !checked.document) {
        await getStore().then((store) => logShow(store, agent.id, false)).catch(() => undefined);
        return failure(formatProblems(checked));
      }
      const document = checked.document;
      const store = await getStore();
      await logShow(store, agent.id, true);
      if (document.revises !== undefined && store.get(document.revises)?.agentId !== agent.id) {
        return failure(formatProblems({ problems: [{ pointer: "/revises", message: "no such surface for this agent" }], warnings: checked.warnings }));
      }
      const settings = await readSettings();
      const loaded = await loadEvidence(document, {
        cwd: agent.cwd,
        extraRoots: [agentStorage(agent.id), "/tmp", ...settings.extraFolders],
      });
      if (!loaded.ok) return failure(formatProblems({ problems: loaded.problems, warnings: checked.warnings }));
      const evidence = loaded.evidence;
      const changeItems = Object.fromEntries(Object.entries(evidence.render.changes ?? {}).map(([id, files]) => [
        id, files.flatMap((file) => [
          { id: file.id, title: file.path },
          ...(file.hunks ?? []).map((hunk) => ({ id: hunk.id, title: `${file.path} ${hunk.header}` })),
        ]),
      ]));
      const problems: Problem[] = [];
      document.questions?.forEach((question, index) => {
        if (question.kind !== "review" || !question.of || !Object.hasOwn(changeItems, question.of)) return;
        const items = changeItems[question.of];
        if (items.length === 0) {
          problems.push({ pointer: `/questions/${index}/of`, message: "the changes block has no items to review" });
        }
        if (typeof question.recommend !== "object") return;
        for (const id of Object.keys(question.recommend)) {
          if (!items.some((item) => item.id === id)) {
            problems.push({
              pointer: `/questions/${index}/recommend${pointerToken(id)}`,
              message: `recommend names ${id}, which is not an item of this review`,
            });
          }
        }
      });
      if (problems.length) return failure(formatProblems({ problems, warnings: checked.warnings }));
      const rendered = truncateRendered(renderText(document, evidence.render));
      if (signal.aborted) return failure("Docket tool call canceled.");
      const created = await store.create({
        agentId: agent.id,
        workspaceId: agent.workspaceId,
        document,
        evidence: evidence.contents,
        snapshots: Object.fromEntries(Object.entries(evidence.snapshots).map(([id, snapshot]) => [id, { ...snapshot }])),
        changeItems,
      });
      if (!created.ok) return failure(`Nothing was shown. ${created.refusal.message}`);
      const surface = created.record.id;
      const open = openSurfaces(store, agent.id).filter((record) => record.id !== surface).map((record) => record.id);
      const result = { surface, status: surfaceStatus(created.record), rendered, open };
      const warnings = [formatProblems({ problems: [], warnings: checked.warnings }), ...evidence.warnings].filter(Boolean);
      return {
        text: [`[docket ${surface}]`, rendered, `Other open surfaces: ${open.join(", ") || "none"}`, ...warnings].join("\n\n"),
        structuredContent: result,
      };
    },
  });

  const close = defineAgentTool({
    name: names[1],
    title: "Close Docket questions",
    description: "Close questions you no longer need answered. Omit questions to close all open questions on the surface.",
    input: z.strictObject({ surface: surfaceId, questions: z.array(z.string()).min(1).optional(), reason: z.string().optional() }),
    async execute(input, { agent, signal }) {
      const store = await getStore();
      if (store.get(input.surface)?.agentId !== agent.id) return failure("No such surface for this agent.");
      if (signal.aborted) return failure("Docket tool call canceled.");
      const closed = await store.apply(input.surface, {
        kind: "close",
        agentId: agent.id,
        questions: input.questions,
        reason: input.reason,
        now: new Date().toISOString(),
      });
      return closed.ok ? jsonResult(responseOf(closed.record)) : failure(closed.refusal.message);
    },
  });

  const get = defineAgentTool({
    name: names[2],
    title: "Read Docket responses",
    description: "Read responses and drafts for one of your surfaces, or omit surface to read all your open surfaces.",
    input: z.strictObject({ surface: surfaceId.optional() }),
    async execute({ surface }, { agent }) {
      const store = await getStore();
      if (surface === undefined) return jsonResult({ surfaces: openSurfaces(store, agent.id).map(responseOf) });
      const record = store.get(surface);
      if (record?.agentId !== agent.id) return failure("No such surface for this agent.");
      return jsonResult(responseOf(record));
    },
  });
  return [show, close, get];
}
