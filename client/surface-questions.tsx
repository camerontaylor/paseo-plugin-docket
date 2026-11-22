import { createContext, useContext, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useAgent, useAgents, type PluginHostProps } from "@getpaseo/plugin/client";
import { optionParts, reviewItems, reviewVerdicts, type Question } from "../shared/document";
import { itemAddress } from "../shared/ids";
import { LIMITS } from "../shared/limits";
import { canComment, own, type Delivery, type DraftContent, type ItemRecord, type QuestionRecord, type SurfaceRecord } from "../shared/record";
import { draftPreview, openTargets, recommendation, recommendations, sendableTargets, submittedPreview } from "./question-drafts";
import { boundReviews, retainedItemComments, sendableComments } from "../shared/block-view";
import { ItemReference, SurfaceBlocks, SurfaceMarkdown } from "./surface-blocks";
import { reviewAddress, type RevisionItem } from "../shared/revision-view";
import { useRevisionView } from "./use-revision-view";
import { useQuestionActions } from "./use-question-actions";

const Theme = createContext<PluginHostProps["theme"]["colors"] | null>(null);
const useColors = () => useContext(Theme)!;

const styles = StyleSheet.create({
  stack: { gap: 8, minWidth: 0, flexShrink: 1 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  section: { borderTopWidth: 1, paddingTop: 8, gap: 8 },
  control: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6, minHeight: 36, justifyContent: "center" },
  input: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6, minHeight: 36 },
  title: { fontWeight: "600" },
  multiline: { minHeight: 64, textAlignVertical: "top" },
});

function Copy({ children, muted, bold, lines, selectable }: { children: ReactNode; muted?: boolean; bold?: boolean; lines?: number; selectable?: boolean }) {
  const colors = useColors();
  return <Text selectable={selectable} numberOfLines={lines} style={[bold && styles.title, { color: muted ? colors.foregroundMuted : colors.foreground }]}>{children}</Text>;
}

function Button({ label, onPress, disabled, selected, detail, role = "button" }: {
  label: string; onPress: () => void; disabled?: boolean; selected?: boolean; detail?: string;
  role?: "button" | "checkbox" | "radio";
}) {
  const colors = useColors();
  return <Pressable accessibilityRole={role} accessibilityState={{
    disabled, ...(role === "button" ? { selected } : { checked: selected }),
  }} disabled={disabled} onPress={onPress} style={[
    styles.control,
    { borderColor: selected ? colors.accent : colors.border, backgroundColor: selected ? colors.surface2 : colors.surface1, opacity: disabled ? 0.5 : 1 },
  ]}>
    <Copy bold={selected}>{label}</Copy>
    {!!detail && <Copy muted>{detail}</Copy>}
  </Pressable>;
}

function Field({ label, value, onChange, disabled, multiline, limit, placeholder }: {
  label: string; value?: string; onChange: (value: string) => void; disabled: boolean;
  multiline?: boolean; limit: number; placeholder?: string;
}) {
  const colors = useColors();
  return <View style={styles.stack}>
    <Copy muted>{label}</Copy>
    <TextInput accessibilityLabel={label} value={value ?? ""} editable={!disabled} onChangeText={onChange}
      multiline={multiline} maxLength={limit} placeholder={placeholder} placeholderTextColor={colors.foregroundMuted}
      style={[styles.input, multiline && styles.multiline, { color: colors.foreground, borderColor: colors.border }]} />
  </View>;
}

function ItemComment({ value, disabled, onChange }: { value?: string; disabled: boolean; onChange: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!open && !value) return <Button label="Comment" disabled={disabled} onPress={() => setOpen(true)} />;
  return <Field label="Item comment" value={value} disabled={disabled} onChange={onChange} multiline limit={LIMITS.answer} />;
}

function BoundedText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return <View style={styles.stack}>
    <Copy muted lines={expanded ? undefined : 2}>{text}</Copy>
    <Button label={expanded ? "Collapse reason" : "Show full reason"} onPress={() => setExpanded(!expanded)} />
  </View>;
}

const deliveryLabels: Record<Delivery["state"], string> = {
  queued: "Sending",
  held: "Not delivered · Held for Retry",
  uncertain: "Checking",
  delivered: "Delivered",
  failed: "Not delivered",
  removed: "Removed from the agent's queue",
};

type AgentWait = "permission" | "turn" | null;

function deliveryLabel(delivery: Delivery, wait: AgentWait) {
  const label = deliveryLabels[delivery.state];
  if (delivery.state !== "queued" || delivery.sent) return label;
  if (wait === "permission") return `${label} · Waiting for permission`;
  if (wait === "turn") return `${label} · Waiting for the turn to end`;
  return delivery.enqueued ? `${label} · In the agent's queue` : label;
}

function DraftPreview({ draft }: { draft?: DraftContent | { text: string } | null }) {
  return <Copy selectable>{draftPreview(draft)}</Copy>;
}

function ItemHistory({ item }: { item?: RevisionItem }) {
  if (!item) return null;
  const prior = item.earlier;
  return <View style={styles.stack}>
    {item.mark && <Copy muted>{item.mark}</Copy>}
    {prior && item.mark !== "Removed" && prior.title !== item.title &&
      <Copy selectable muted>{`Earlier title · ${prior.title}`}</Copy>}
    {prior?.feedback.map(({ prompt, answer, draft }, index) => <View key={index} style={styles.stack}>
      <Copy selectable muted>{prompt}</Copy>
      {answer && <><Copy muted>Earlier review</Copy><Copy selectable>{submittedPreview(answer)}</Copy></>}
      {draft && <><Copy muted>Earlier unsent review draft</Copy><DraftPreview draft={draft} /></>}
    </View>)}
    {prior?.comment && <><Copy muted>Earlier sent item comment</Copy><Copy selectable>{prior.comment}</Copy></>}
    {prior?.draftComment && <><Copy muted>Earlier unsent item comment</Copy><Copy selectable>{prior.draftComment}</Copy></>}
  </View>;
}

type Actions = ReturnType<typeof useQuestionActions>;

function TargetControls({ question, target, item, actions, disabled }: {
  question: Question; target: string; item?: string; actions: Actions; disabled: boolean;
}) {
  const draft = actions.draft(target) ?? {};
  const rec = recommendation(question, item);
  const manual = (patch: DraftContent, defer?: boolean) => actions.save(target, { ...draft, skipped: undefined, by: undefined, ...patch }, defer);
  const fieldDisabled = disabled || !!draft.skipped;
  const selected = Array.isArray(draft.value) ? draft.value : draft.value === undefined ? [] : [draft.value];
  const recommended = Array.isArray(rec) ? rec : [rec];

  return <View style={styles.stack}>
    {draft.skipped ? <Copy muted>Skip drafted</Copy> : <>
      {question.kind === "choice" && <>
        {question.multi && <Copy muted>{`Choose at least ${question.min ?? 1}${question.max === undefined ? "" : ` and at most ${question.max}`}`}</Copy>}
        {question.options.map(optionParts).map(({ id, label, detail }) => {
          const checked = selected.includes(id);
          return <Button key={id} label={recommended.includes(id) ? `${label} · Recommended` : label}
            detail={detail} role={question.multi ? "checkbox" : "radio"} selected={checked} disabled={fieldDisabled}
            onPress={() => {
              const value = question.multi ? checked ? selected.filter((choice) => choice !== id) : [...selected, id] : id;
              manual({ value: Array.isArray(value) && !value.length ? undefined : value, other: question.multi ? draft.other : undefined });
            }} />;
        })}
        {question.other !== false && <Field label="Other" value={draft.other} disabled={fieldDisabled} limit={LIMITS.answer}
          onChange={(other) => manual({ other: other.trim() ? other : undefined, value: !question.multi && other.trim() ? undefined : draft.value }, true)} />}
      </>}
      {question.kind === "text" && <>
        {typeof rec === "string" && <Copy muted>{`Recommended: ${rec}`}</Copy>}
        <Field label="Answer" value={typeof draft.value === "string" ? draft.value : undefined} disabled={fieldDisabled}
          multiline={question.multiline} limit={LIMITS.answer} placeholder={question.placeholder}
          onChange={(value) => manual({ value: value || undefined }, true)} />
      </>}
      {question.kind === "review" && <>
        <View style={styles.row}>
          {reviewVerdicts(question).map((verdict) => <Button key={verdict} selected={verdict === draft.verdict}
            role="radio" label={verdict === rec ? `${verdict} · Recommended` : verdict} disabled={fieldDisabled}
            onPress={() => manual({ verdict })} />)}
        </View>
        {question.comment !== false && <Field label="Comment" value={draft.comment} disabled={fieldDisabled}
          multiline limit={LIMITS.answer} onChange={(comment) => actions.save(target, { ...draft, comment: comment || undefined }, true)} />}
      </>}
      {question.kind !== "review" && question.note !== false && <Field label="Note" value={draft.note} disabled={fieldDisabled}
        multiline limit={LIMITS.note} onChange={(note) => actions.save(target, { ...draft, note: note || undefined }, true)} />}
    </>}
    <View style={styles.row}>
      {!draft.skipped && <Button label="Skip" disabled={disabled} onPress={() => actions.save(target, { skipped: true })} />}
      {Object.keys(draft).some((key) => key !== "version") && <Button label="Clear answer" disabled={disabled} onPress={() => actions.save(target, null)} />}
    </View>
  </View>;
}

function State({ entry, record, target, wait }: { entry: QuestionRecord | ItemRecord; record: SurfaceRecord; target: string; wait: AgentWait }) {
  const answer = entry.answer;
  const delivery = record.deliveries.find((item) => item.n === entry.delivery);
  const draft = own(record.drafts, target);
  return <View style={styles.stack}>
    <Copy muted>{entry.state === "skipped" ? "Skipped" : entry.state === "answered" ? "Answered" : "Closed"}</Copy>
    {answer && !answer.skipped && <>
      <Copy>{submittedPreview(answer)}</Copy>
      {answer.by === "recommended" && <Copy muted>Accepted recommendation</Copy>}
    </>}
    {entry.state === "closed" && draft && Object.keys(draft).length > 1 && <>
      <Copy muted>Unsent draft</Copy><DraftPreview draft={draft} />
    </>}
    {delivery && <Copy muted>{deliveryLabel(delivery, wait)}</Copy>}
  </View>;
}

/** Shared answer controls for a surface fetched from its owning host. */
export function SurfaceQuestions({ hostId, theme, record, refresh }: {
  hostId: string; theme: PluginHostProps["theme"]; record: SurfaceRecord;
  refresh: () => Promise<SurfaceRecord | null | undefined>;
}) {
  const { earlier, comparison, loading } = useRevisionView(hostId, record);
  const actions = useQuestionActions(hostId, record, refresh);
  const [ref] = useAgents({ hosts: [hostId], where: (agent) => agent.id === record.agentId });
  const wait = useAgent(ref ?? record.agentId, (agent): AgentWait => {
    if (agent.hostId !== hostId) return null;
    if (agent.attentionReason === "permission") return "permission";
    return agent.status === "running" ? "turn" : null;
  });
  const count = sendableTargets(record).length;
  const total = openTargets(record).length;
  const orphaned = !!record.orphanedAt;
  const disabled = actions.locked || orphaned;
  const sendDisabled = actions.pending || actions.unsaved || orphaned;
  const submitLabel = !total && !canComment(record) ? "Send item comments" : record.document?.submit?.label ?? "Send";

  const bindings = boundReviews(record);
  const bound = new Set([...bindings.values()].flat());
  const comments = sendableComments(record).length;
  const retainedComments = retainedItemComments(record);

  function reviewItem(id: string, item: string, state: ItemRecord) {
    const target = itemAddress(id, item);
    const question = record.document?.questions?.find((q) => q.id === id);
    return state.state === "open" && question ? <>
      <Copy muted>Open</Copy>
      <TargetControls question={question} item={item} target={target} actions={actions} disabled={disabled} />
    </> : <State entry={state} record={record} target={target} wait={wait} />;
  }

  function reviewPrompt(block: string) {
    return bindings.get(block)?.map((id) => {
      const entry = record.questions[id];
      return <View key={id} style={styles.stack}>
        <Copy bold>{entry.prompt}</Copy>
        {!!entry.closeReason && <BoundedText text={entry.closeReason} />}
      </View>;
    });
  }

  function feedback(block: string, item: string) {
    const on = itemAddress(block, item);
    const comment = own(record.comments, on);
    const delivery = record.deliveries.find((entry) => entry.n === comment?.delivery);
    const reviews = bindings.get(block) ?? [];
    return <>
      <ItemHistory item={comparison?.current.get(on)} />
      {reviews.map((id) => {
        const state = own(record.questions[id].items, item);
        return state && <View key={id} style={styles.stack}>
          {reviews.length > 1 && <Copy muted>{record.questions[id].prompt}</Copy>}
          {reviewItem(id, item, state)}
        </View>;
      })}
      {!!comment?.text && comment.delivery !== null && <>
        <Copy muted>Sent item comment</Copy>
        <Copy>{comment.text}</Copy>
        {delivery && <Copy muted>{deliveryLabel(delivery, wait)}</Copy>}
      </>}
      {canComment(record) && !orphaned && <ItemComment value={actions.comment(on)} disabled={disabled}
        onChange={(text) => actions.saveComment(on, text)} />}
    </>;
  }

  return <Theme.Provider value={theme.colors}>
    {record.revises && <View style={styles.stack}>
      <Copy muted>{earlier ? `Replaces · ${earlier.summary}`
        : loading ? "Loading earlier surface…" : "Earlier surface unavailable"}</Copy>
      {comparison?.incomplete && <Copy muted>Some earlier item details are unavailable for comparison.</Copy>}
    </View>}
    <SurfaceBlocks record={record} hostId={hostId} theme={theme} feedback={feedback} reviewPrompt={reviewPrompt}>
    <View style={styles.stack}>
      {Object.entries(record.questions).map(([id, entry]) => {
        if (bound.has(id)) return null;
        const question = record.document?.questions?.find((question) => question.id === id);
        return <View key={id} style={[styles.section, { borderColor: theme.colors.border }]}>
          <Copy bold>{entry.prompt}</Copy>
          {!!entry.closeReason && <BoundedText text={entry.closeReason} />}
          {entry.kind === "review" ? <>
            {entry.state === "open" && <Copy muted>Open</Copy>}
            {Object.entries(entry.items ?? {}).map(([item, state]) => {
              const source = question?.kind === "review" ? reviewItems(question).find((entry) => entry.id === item) : undefined;
              return <View key={item} style={styles.stack}>
                <Copy bold>{state.title}</Copy>
                {!!state.detail && <SurfaceMarkdown text={state.detail} />}
                {!!source?.ref && <ItemReference reference={source.ref} />}
                <ItemHistory item={comparison?.current.get(reviewAddress(id, item))} />
                {reviewItem(id, item, state)}
              </View>;
            })}
          </> : entry.state === "open" && question ? <>
            <Copy muted>Open</Copy>
            <TargetControls question={question} target={id} actions={actions} disabled={disabled} />
          </> : <State entry={entry} record={record} target={id} wait={wait} />}
        </View>;
      })}
      {!!comparison?.removed.length && <View style={[styles.section, { borderColor: theme.colors.border }]}>
        <Copy bold>Earlier items</Copy>
        {comparison.removed.map((item) => <View key={item.key} style={styles.stack}>
          <Copy bold selectable>{item.title}</Copy>
          <ItemHistory item={item} />
        </View>)}
      </View>}
      {orphaned && <Copy muted>Agent stopped</Copy>}
      {retainedComments.map(({ on, title, text }) => <View key={on} style={styles.stack}>
        <Copy bold>{title}</Copy>
        <Copy muted>Unsent item comment</Copy>
        <Copy selectable>{text}</Copy>
        <View style={styles.row}>
          <Button label="Clear item comment" disabled={actions.pending || actions.unsaved} onPress={() => actions.saveComment(on, "")} />
        </View>
      </View>)}
      {(total > 0 || comments > 0) && <View style={styles.row}>
        <Button label={`${submitLabel} (${total ? `${count} of ${total}${comments ? " · " : ""}` : ""}${comments ? `${comments} item comment${comments === 1 ? "" : "s"}` : ""})`} disabled={(!count && !comments) || sendDisabled} onPress={() => void actions.submit("send")} />
        {!!recommendations(record).length && <Button label="Accept recommended" disabled={sendDisabled} onPress={() => void actions.submit("recommended")} />}
        {total > count && <Button label="Skip the rest" disabled={sendDisabled} onPress={() => void actions.submit("skip")} />}
      </View>}
      {!!record.closed?.reason && !Object.values(record.questions).some((question) => question.closeReason === record.closed?.reason)
        && <BoundedText text={record.closed.reason} />}
      {record.deliveries.filter(({ state }) => state === "held" || state === "failed" || state === "removed" || state === "uncertain").map((delivery) =>
        <View key={delivery.n} style={styles.row}>
          <Copy muted>{`Delivery ${delivery.n} · ${deliveryLabels[delivery.state]}`}</Copy>
          <Button label="Retry" disabled={sendDisabled} onPress={() => void actions.retry(delivery.n)} />
        </View>)}
      {!!actions.discarded && <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.foregroundMuted }}>{actions.discarded}</Text>}
      {!!actions.error && <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.statusDanger }}>{actions.error}</Text>}
      {actions.unsaved && !actions.comparison.length && <Button label="Retry saving drafts"
        disabled={actions.pending || orphaned} onPress={() => void actions.retryDrafts()} />}
      {actions.comparison.map(({ target, viewed, current, cannotKeep }) => {
        const copyOnly = cannotKeep || (!record.document && !!viewed);
        return <View key={target} style={styles.stack}>
          <Copy bold>{target}</Copy>
          <Copy muted>{copyOnly ? "Your unsaved draft · Select text to copy" : "Your draft"}</Copy>
          <DraftPreview draft={viewed} />
          <Copy muted>Stored draft</Copy><DraftPreview draft={current} />
          {actions.unsaved && <View style={styles.row}>
            {!copyOnly && <Button label="Keep my draft" disabled={actions.pending || orphaned} onPress={() => actions.resolveDraft(target, true)} />}
            <Button label={copyOnly ? "Discard unsaved edit" : "Use stored draft"}
              disabled={actions.pending || (!copyOnly && orphaned)} onPress={() => actions.resolveDraft(target, false)} />
          </View>}
        </View>;
      })}
    </View>
    </SurfaceBlocks>
  </Theme.Provider>;
}
