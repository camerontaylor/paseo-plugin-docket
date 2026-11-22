import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentToolContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import fixture from "../shared/fixtures/spec-20-1-questions-only.json";
import { LIMITS, TOOL_SCHEMA_MAX_BYTES } from "../shared/limits";
import { SHOW_INPUT_SCHEMA } from "../shared/tool-schema";
import { openStore, type Store } from "./store";
import { attachDocketTools, createDocketTools, isDocketPermission } from "./tools";

const settings = {
  agentTools: true,
  allowToolPermissions: true,
  sound: false,
  extraFolders: [],
  retentionDays: 30,
  recordEvents: true,
};
const readSettings = async () => settings;
let dir: string;
let store: Store;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "docket-tools-"));
  vi.stubEnv("PASEO_HOME", dir);
  store = await openStore();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

function context(id: string): AgentToolContext {
  return {
    agent: { id, workspaceId: "workspace", cwd: dir, title: null, provider: "codex", parentAgentId: null, background: false, metadata: {} },
    paseo: {} as AgentToolContext["paseo"],
    signal: new AbortController().signal,
  };
}

async function call(name: string, input: object, agentId = "agent") {
  const tool = createDocketTools(async () => store, readSettings).find((tool) => tool.name === name);
  if (!tool) throw new Error(`No tool named ${name}`);
  const wire = z.toJSONSchema(tool.input, { io: "input" });
  const hostInput = await z.fromJSONSchema(wire).parseAsync(input);
  return tool.execute(await tool.input.parseAsync(hostInput), context(agentId));
}

async function show(input: object | string, agentId = "agent"): Promise<string> {
  const result = await call("docket_show", { surface: input }, agentId);
  expect(result.isError, result.text).toBeUndefined();
  const { surface } = result.structuredContent as { surface: string };
  expect(result.text?.split("\n")[0]).toBe(`[docket ${surface}]`);
  return surface;
}

describe("Docket tools", () => {
  it("advertises the loose D7 wire schema and attaches tools and private storage on session open", async () => {
    const request: PluginSessionOpenRequest = {
      agentId: "agent", workspaceId: null, provider: "codex", cwd: dir, title: null, background: false,
      reason: "create", purpose: "interactive", tools: [], labels: {}, metadata: {}, env: { EXISTING: "yes" }, mcpServers: {},
    };
    const attached = await attachDocketTools(request, readSettings, async () => store);
    expect(attached.tools.map((tool) => tool.name)).toEqual(["docket_show", "docket_close", "docket_get"]);
    expect(attached.tools[0].description).toContain("Use the harness's question tool");
    expect(attached.env).toEqual({ EXISTING: "yes", DOCKET_STORAGE: path.join(store.root, "agents", "agent") });
    expect((await stat(attached.env.DOCKET_STORAGE)).mode & 0o777).toBe(0o700);
    const schema = z.toJSONSchema(attached.tools[0].input, { io: "input" });
    expect(schema).toMatchObject({
      type: "object",
      properties: { surface: { anyOf: [{}, SHOW_INPUT_SCHEMA.properties.surface] } },
      required: ["surface"],
    });
    const advertised = z.toJSONSchema(z.fromJSONSchema(schema), { io: "input" });
    for (const wire of [schema, advertised]) {
      expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThanOrEqual(TOOL_SCHEMA_MAX_BYTES);
      for (const keyword of ["oneOf", "anyOf", "allOf"]) expect(wire).not.toHaveProperty(keyword);
    }
    expect(await attachDocketTools(request, async () => ({ ...settings, agentTools: false }), async () => store)).toBe(request);
  });

  it("stores both input forms with evidence and returns bounded text and only the caller's other open surfaces", async () => {
    const first = await show(JSON.stringify(fixture));
    await show(fixture, "other");
    await writeFile(path.join(dir, "hello.txt"), "loaded proof\n");
    const result = await call("docket_show", { surface: {
      ...fixture,
      view: [{ t: "code", file: "hello.txt" }, Array.from({ length: 200 }, () => "é".repeat(30)).join("\n")],
    } });
    expect(result.isError, result.text).toBeUndefined();
    const { surface, rendered, status, open } = result.structuredContent as { surface: string; rendered: string; status: string; open: string[] };
    expect(status).toBe("open");
    expect(rendered).toContain("loaded proof");
    expect(rendered).toContain("[cut:");
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(LIMITS.renderedBytes);
    expect(open).toEqual([first]);
    const persisted = (await openStore()).get(surface);
    expect(persisted).toMatchObject({ agentId: "agent", workspaceId: "workspace" });
    expect(await readFile(path.join(store.root, "evidence", surface, "1"), "utf8")).toContain("loaded proof");
  });

  it("returns all validation or load problems without storing anything", async () => {
    const invalid = await call("docket_show", { surface: { v: 2, meanwhile: "go_ahead" }, typo: true });
    expect(invalid).toMatchObject({ isError: true });
    for (const fragment of ["/v", "/summary", "/meanwhile", "stage 2", "typo"]) expect(invalid.text).toContain(fragment);
    const missing = await call("docket_show", { surface: {} });
    expect(missing.text).toContain("/v");
    const unloaded = await call("docket_show", { surface: {
      ...fixture, view: [{ id: "first", t: "code", file: "missing.txt" }, { id: "second", t: "code", file: "absent.txt" }],
    } });
    expect(unloaded.isError).toBe(true);
    expect(unloaded.text).toContain("/view/0/file");
    expect(unloaded.text).toContain("/view/1/file");
    expect(store.list()).toEqual([]);
  });

  it("scopes get, close and revises to the calling agent and retains drafts", async () => {
    const surface = await show(fixture);
    const question = fixture.questions[0].id;
    await show(fixture, "other");
    const write = await store.apply(surface, { kind: "setDraft", target: question, draft: { value: fixture.questions[0].options[0].id }, baseVersion: 0, now: new Date().toISOString() });
    expect(write.ok).toBe(true);
    expect((await call("docket_get", { surface }, "other")).isError).toBe(true);
    expect((await call("docket_close", { surface }, "other")).isError).toBe(true);
    expect((await call("docket_show", { surface: { ...fixture, revises: surface } }, "other")).isError).toBe(true);
    expect((await call("docket_get", {})).structuredContent).toEqual({
      surfaces: [expect.objectContaining({ surface, open: expect.arrayContaining([question]), drafts: { [question]: expect.objectContaining({ version: 1 }) } })],
    });
    expect((await call("docket_close", { surface, questions: [question], reason: "Answered separately" })).isError).toBeUndefined();
    expect((await openStore()).get(surface)?.questions[question]).toMatchObject({ state: "closed", closeReason: "Answered separately" });
    const replacement = await show({ ...fixture, revises: surface });
    expect(store.get(surface)?.replacedBy).toBe(replacement);
    expect((await call("docket_close", { surface: replacement, reason: "Answered in chat" })).isError).toBeUndefined();
    expect(store.get(replacement)?.closed?.reason).toBe("Answered in chat");
    expect((await call("docket_get", {})).structuredContent).toEqual({ surfaces: [] });
  });

  it("matches only the three exact permission names in each provider namespace", () => {
    for (const name of ["docket_show", "docket_close", "docket_get"]) {
      expect(isDocketPermission(`paseo.${name}`)).toBe(true);
      expect(isDocketPermission(`mcp__paseo__${name}`)).toBe(true);
    }
    for (const name of ["mcp__other__docket_show", "x.paseo.docket_show", "paseo.docket_show_extra", "paseo.docket_reference", "AskUserQuestion"]) {
      expect(isDocketPermission(name)).toBe(false);
    }
  });
});
