import type { PluginTheme } from "@getpaseo/plugin";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { parseChanges, splitHunks } from "../shared/block-view";
import { blockId, viewBlocks, type PlanStep } from "../shared/document";
import { parseRef } from "../shared/evidence";
import { own, type Snapshot, type SurfaceRecord } from "../shared/record";
import { evidenceCheck, evidenceGet } from "../shared/rpc";
import { BlockCode } from "./block-code";
import { BlockMarkdown } from "./block-markdown";
import { callHost, getHub } from "./hub";
import { Glyph, Pill, radius, row, space, type, type Tone } from "./kit";

interface BlockContext {
  hostId: string;
  record: SurfaceRecord;
  theme: PluginTheme;
  feedback: (block: string, item: string) => ReactNode;
  reviewPrompt: (block: string) => ReactNode;
}

const Context = createContext<BlockContext | null>(null);
const useBlocks = () => useContext(Context)!;
const stack = { gap: 8, minWidth: 0 };

function Label({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  const c = useBlocks().theme.colors;
  return <Text selectable style={muted ? { ...type.meta, color: c.foregroundMuted } : { ...type.body, color: c.foreground }}>{children}</Text>;
}

function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { theme } = useBlocks();
  return <View style={stack}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)}
      style={{ flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", minHeight: 28 }}>
      <Glyph name={open ? "ChevronDown" : "ChevronRight"} color={theme.colors.accent} size={14} />
      <Text style={{ ...type.meta, fontWeight: "600", color: theme.colors.accent }}>{label}</Text>
    </Pressable>
    {open && children}
  </View>;
}

type Check = Awaited<ReturnType<typeof checkSnapshot>>;

function checkSnapshot(hostId: string, surfaceId: string, snapshotId: string) {
  return callHost(getHub(), hostId, evidenceCheck, { surfaceId, snapshotId });
}

function Evidence({ snapshotId, meta, children, unavailable }: {
  unavailable?: ReactNode; snapshotId: string; meta: Snapshot; children: (text: string, check?: Check) => ReactNode;
}) {
  const { hostId, record, theme } = useBlocks();
  const [text, setText] = useState<string | null>();
  const [check, setCheck] = useState<Check>();
  const [checking, setChecking] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const surfaceId = record.id;
  useEffect(() => {
    let active = true;
    const input = { surfaceId, snapshotId };
    void callHost(getHub(), hostId, evidenceGet, input).then(
      (result) => { if (active) setText(result); },
      () => { if (active) setText(null); },
    );
    // The frozen excerpt remains readable even when the workspace cannot be reached.
    void checkSnapshot(hostId, surfaceId, snapshotId).then(
      (result) => { if (active) { setCheck(result); setChecking(false); } },
      () => { if (active) { setCheck({ status: "unavailable" }); setChecking(false); } },
    );
    return () => { active = false; };
  }, [hostId, surfaceId, snapshotId, attempt]);
  const source = meta.path ?? (typeof meta.of === "string" ? meta.of : "worktree");
  const range = meta.from && meta.to && meta.to >= meta.from ? `:${meta.from}–${meta.to}` : "";
  return <View style={stack}>
    <Label muted>{`Loaded from ${source}${range}${meta.commit ? ` · ${meta.commit.slice(0, 12)}` : ""} · ${meta.readAt}`}</Label>
    {check?.status === "changed" && <Label muted>Changed since this snapshot</Label>}
    {check?.status === "gone" && <Label muted>Source is no longer readable</Label>}
    {check?.status === "unavailable" && <Label muted>Current source could not be checked</Label>}
    {text === undefined ? <Label muted>Loading snapshot…</Label>
      : text === null ? <><Label muted>Snapshot unavailable</Label>{unavailable}</> : children(text, check)}
    {!checking && <Pressable accessibilityRole="button" style={{ alignSelf: "flex-start", minHeight: 28, justifyContent: "center" }} onPress={() => {
      setChecking(true);
      setAttempt(attempt + 1);
    }}><Text style={{ ...type.meta, fontWeight: "600", color: theme.colors.accent }}>{text === null ? "Retry snapshot" : "Check current source"}</Text></Pressable>}
  </View>;
}

function RefExcerpt({ reference }: { reference: string }) {
  const { record, theme } = useBlocks();
  const entry = Object.entries(record.snapshots).find(([, meta]) => meta.ref === reference);
  if (!entry) return <Label muted>Excerpt unavailable</Label>;
  const [snapshotId, meta] = entry;
  return <Evidence key={snapshotId} snapshotId={snapshotId} meta={meta}>
    {(text, check) => <View style={stack}>
      <BlockCode text={text} from={meta.to === 0 ? undefined : meta.from} theme={theme} />
      {check?.current !== undefined && <>
        <Label muted>Current excerpt</Label>
        <BlockCode text={check.current} theme={theme} />
      </>}
    </View>}
  </Evidence>;
}

export function ItemReference({ reference }: { reference: string }) {
  if (!parseRef(reference)) return <Label muted>{reference}</Label>;
  return <Disclosure label={reference}><RefExcerpt reference={reference} /></Disclosure>;
}

export function SurfaceMarkdown({ text }: { text: string }) {
  const { theme } = useBlocks();
  return <BlockMarkdown text={text} theme={theme} excerpt={(ref) => <RefExcerpt key={ref} reference={ref} />} />;
}

function Item({ block, id, title, subline, status, children }: {
  block: string; id: string; title: string; subline?: string; status?: [string, Tone]; children?: ReactNode;
}) {
  const { theme, feedback } = useBlocks();
  return <View style={[stack, { borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, borderRadius: radius.sm, padding: space.md }]}>
    <View style={[row, { justifyContent: "space-between", flexWrap: "nowrap", alignItems: "flex-start" }]}>
      <Text selectable style={{ ...type.body, flex: 1, minWidth: 0, color: theme.colors.foreground, fontWeight: "600" }}>{title}</Text>
      {status && <Pill colors={theme.colors} tone={status[1]} label={status[0]} />}
    </View>
    {!!subline && <Label muted>{subline}</Label>}
    {children}
    {feedback(block, id)}
  </View>;
}

function PlanItem({ block, step }: { block: string; step: PlanStep }) {
  const files = typeof step.files === "string" ? [step.files] : step.files ?? [];
  const status = ({ todo: ["To do", "neutral"], doing: ["In progress", "accent"], done: ["Done", "success"], blocked: ["Blocked", "danger"] } as const)[step.status ?? "todo"];
  return <Item block={block} id={step.id} title={step.title} status={[...status]}>
    {!!step.after?.length && <Label muted>{`Depends on ${step.after.join(", ")}`}</Label>}
    {!!step.detail && <Disclosure label="Details"><SurfaceMarkdown text={step.detail} /></Disclosure>}
    {[...new Set([...(step.ref ? [step.ref] : []), ...files])].map((reference) =>
      <ItemReference key={reference} reference={reference} />)}
    {!!step.children?.length && <Disclosure label="Substeps">
      {step.children.map((child) => <PlanItem key={child.id} block={block} step={child} />)}
    </Disclosure>}
  </Item>;
}

function ChangesItems({ block, text }: { block: string; text: string }) {
  const { theme, record } = useBlocks();
  let snapshot: ReturnType<typeof parseChanges>;
  try {
    snapshot = parseChanges(text);
  } catch {
    return <View style={stack}><Label muted>Changed files snapshot is unreadable</Label><StoredItems block={block} /></View>;
  }
  return <View style={stack}>
    {!snapshot.files.length && <Label muted>No changed files</Label>}
    {snapshot.notes.map((note, index) => <Label key={index} muted>{note}</Label>)}
    {snapshot.files.map((file) => {
      const hunks = splitHunks(file.patch);
      const title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
      return <Item key={file.id} block={block} id={file.id} title={title}
        subline={`${file.status} · +${file.added} −${file.removed}`}>
        {file.patch && <Disclosure label="Changes">
          {file.hunks?.length ? <>
            <BlockCode text={file.patch.slice(0, file.patch.indexOf(hunks[0] ?? file.patch))} diff theme={theme} />
            {file.hunks.map((hunk, index) => <Item key={hunk.id} block={block} id={hunk.id}
              title={own(record.blockItems, block)?.find((item) => item.id === hunk.id)?.title ?? hunk.header}>
              {hunks[index] !== undefined && <BlockCode text={hunks[index]} diff theme={theme} />}
            </Item>)}
          </> : <BlockCode text={file.patch} diff theme={theme} />}
        </Disclosure>}
      </Item>;
    })}
  </View>;
}

function StoredItems({ block }: { block: string }) {
  const { record } = useBlocks();
  return <>{own(record.blockItems, block)?.map((item) =>
    <Item key={item.id} block={block} id={item.id} title={item.title} />)}</>;
}

function Blocks() {
  const { record, theme, reviewPrompt } = useBlocks();
  if (!record.document) return null;
  return <View style={stack}>
    {record.document.context && <SurfaceMarkdown text={record.document.context} />}
    {viewBlocks(record.document).map((block, index) => {
      if (typeof block === "string") return <SurfaceMarkdown key={index} text={block} />;
      const id = blockId(block)!;
      const entry = Object.entries(record.snapshots).find(([, meta]) => meta.block === id);
      return <View key={id} style={stack}>
        {!!block.title && <Text accessibilityRole="header" style={{ ...type.title, color: theme.colors.foreground }}>{block.title}</Text>}
        {reviewPrompt(id)}
        {block.t === "plan" ? block.steps.map((step) => <PlanItem key={step.id} block={id} step={step} />)
          : block.t === "code" && block.s !== undefined ? <BlockCode text={block.s} lang={block.lang} diff={block.diff} theme={theme} />
          : entry ? <Evidence key={entry[0]} snapshotId={entry[0]} meta={entry[1]} unavailable={<StoredItems block={id} />}>
            {(text) => block.t === "changes" ? <ChangesItems block={id} text={text} />
              : <BlockCode text={text} lang={block.lang ?? block.file?.match(/\.([^./]+)$/)?.[1]} diff={block.diff}
                from={entry[1].to === 0 ? undefined : entry[1].from} theme={theme} />}
          </Evidence> : <><Label muted>Snapshot unavailable</Label><StoredItems block={id} /></>}
      </View>;
    })}
  </View>;
}

export function SurfaceBlocks({ children, ...context }: BlockContext & { children: ReactNode }) {
  return <Context.Provider value={context}><Blocks />{children}</Context.Provider>;
}
