import { createContext, useContext, useState, type ReactNode } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
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
import { Button as KitButton, Glyph, Notice, NoticeText, Pill, inputStyle, radius, row, space, tint, type, type Tone } from "./kit";

type Colors = PluginHostProps["theme"]["colors"];
const Theme = createContext<Colors | null>(null);
const useColors = () => useContext(Theme)!;

const stack = { gap: space.sm, minWidth: 0, flexShrink: 1 } as const;

function Copy({ children, muted, bold, small, lines, selectable }: {
  children: ReactNode; muted?: boolean; bold?: boolean; small?: boolean; lines?: number; selectable?: boolean;
}) {
  const colors = useColors();
  return <Text selectable={selectable} numberOfLines={lines} style={[small ? type.meta : type.body,
    bold && { fontWeight: "600" }, { color: muted ? colors.foregroundMuted : colors.foreground }]}>{children}</Text>;
}

function Button(props: Omit<Parameters<typeof KitButton>[0], "colors">) {
  return <KitButton colors={useColors()} {...props} />;
}

function Field({ label, value, onChange, disabled, multiline, limit, placeholder, showLabel = true }: {
  label: string; value?: string; onChange: (value: string) => void; disabled: boolean;
  multiline?: boolean; limit: number; placeholder?: string; showLabel?: boolean;
}) {
  const colors = useColors();
  const [focused, setFocused] = useState(false);
  return <View style={{ gap: space.xs, minWidth: 0 }}>
    {showLabel && <Copy small muted>{label}</Copy>}
    <TextInput accessibilityLabel={label} value={value ?? ""} editable={!disabled} onChangeText={onChange}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      multiline={multiline} maxLength={limit} placeholder={placeholder} placeholderTextColor={colors.foregroundMuted}
      style={[inputStyle(colors, focused), multiline && { minHeight: 72, textAlignVertical: "top" }, disabled && { opacity: 0.6 }]} />
  </View>;
}

/** A field that stays a single quiet button until it has content or the user opens it. */
function OptionalField({ addLabel, value, disabled, ...field }: Omit<Parameters<typeof Field>[0], "showLabel"> & { addLabel: string }) {
  const [open, setOpen] = useState(false);
  if (!open && !value) {
    return <View style={row}>
      <Button variant="ghost" compact icon="Plus" label={addLabel} disabled={disabled} onPress={() => setOpen(true)} />
    </View>;
  }
  return <Field {...field} value={value} disabled={disabled} multiline />;
}

/** A radio or checkbox row: the indicator, the option text and its recommendation. */
function Option({ label, detail, recommended, selected, multi, disabled, onPress }: {
  label: string; detail?: string; recommended: boolean; selected: boolean; multi?: boolean; disabled: boolean; onPress(): void;
}) {
  const colors = useColors();
  return <Pressable accessibilityRole={multi ? "checkbox" : "radio"}
    accessibilityLabel={`${label}${recommended ? ", recommended" : ""}`}
    accessibilityState={{ checked: selected, disabled }} disabled={disabled} onPress={onPress}
    style={(state) => {
      const { hovered, focused } = state as { hovered?: boolean; focused?: boolean };
      return {
        flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 44,
        paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.sm, borderWidth: 1,
        borderColor: selected || focused ? colors.accent : colors.border,
        backgroundColor: selected ? tint(colors.accent, 0.1) ?? colors.surface2 : hovered ? colors.surface2 : colors.surface0,
        opacity: disabled ? 0.5 : 1,
        outlineStyle: focused ? "solid" : undefined, outlineWidth: focused ? 2 : undefined,
        outlineColor: focused ? tint(colors.accent, 0.45) : undefined,
      };
    }}>
    <View style={{ width: 18, height: 18, borderRadius: multi ? 4 : 9, borderWidth: 2, alignItems: "center", justifyContent: "center",
      borderColor: selected ? colors.accent : colors.foregroundMuted, backgroundColor: selected && multi ? colors.accent : "transparent" }}>
      {selected && (multi ? <Glyph name="Check" color={colors.accentForeground} size={12} />
        : <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent }} />)}
    </View>
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
      <Text style={{ ...type.body, fontWeight: selected ? "600" : "500", color: colors.foreground }}>{label}</Text>
      {!!detail && <Text style={{ ...type.meta, color: colors.foregroundMuted }}>{detail}</Text>}
    </View>
    {recommended && <Pill colors={colors} tone="accent" icon="Sparkles" label="Recommended" />}
  </Pressable>;
}

function BoundedText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return <View style={stack}>
    <Copy muted lines={expanded ? undefined : 2}>{text}</Copy>
    <View style={row}>
      <Button variant="ghost" compact label={expanded ? "Show less" : "Show full reason"} onPress={() => setExpanded(!expanded)} />
    </View>
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

const deliveryTones: Record<Delivery["state"], Tone> = {
  queued: "accent", held: "warning", uncertain: "warning", delivered: "success", failed: "danger", removed: "danger",
};

const deliveryIcons: Record<Delivery["state"], string> = {
  queued: "Send", held: "PauseCircle", uncertain: "Loader", delivered: "CheckCheck", failed: "AlertTriangle", removed: "AlertTriangle",
};

type AgentWait = "permission" | "turn" | null;

function deliveryLabel(delivery: Delivery, wait: AgentWait) {
  const label = deliveryLabels[delivery.state];
  if (delivery.state !== "queued" || delivery.sent) return label;
  if (wait === "permission") return `${label} · Waiting for permission`;
  if (wait === "turn") return `${label} · Waiting for the turn to end`;
  return delivery.enqueued ? `${label} · In the agent's queue` : label;
}

function DeliveryPill({ delivery, wait }: { delivery: Delivery; wait: AgentWait }) {
  return <Pill colors={useColors()} tone={deliveryTones[delivery.state]} icon={deliveryIcons[delivery.state]}
    label={deliveryLabel(delivery, wait)} />;
}

function DraftPreview({ draft }: { draft?: DraftContent | { text: string } | null }) {
  return <Copy selectable>{draftPreview(draft)}</Copy>;
}

/** Read-only feedback carried over from the surface this one replaces. */
function ItemHistory({ item }: { item?: RevisionItem }) {
  const colors = useColors();
  if (!item) return null;
  const prior = item.earlier;
  const hasPrior = !!prior && (prior.feedback.length > 0 || !!prior.comment || !!prior.draftComment
    || (item.mark !== "Removed" && prior.title !== item.title));
  if (!item.mark && !hasPrior) return null;
  const markTone: Tone = item.mark === "New" ? "accent" : item.mark === "Changed" ? "warning" : item.mark === "Removed" ? "danger" : "neutral";
  return <View style={stack}>
    {item.mark && <Pill colors={colors} tone={markTone} label={item.mark} />}
    {hasPrior && <View style={{ ...stack, borderLeftWidth: 2, borderColor: colors.border, paddingLeft: space.md }}>
      {prior && item.mark !== "Removed" && prior.title !== item.title &&
        <Copy selectable muted small>{`Earlier title · ${prior.title}`}</Copy>}
      {prior?.feedback.map(({ prompt, answer, draft }, index) => <View key={index} style={{ gap: 2 }}>
        <Copy selectable muted small>{prompt}</Copy>
        {answer && <><Copy muted small>Earlier review</Copy><Copy selectable>{submittedPreview(answer)}</Copy></>}
        {draft && <><Copy muted small>Earlier unsent review draft</Copy><DraftPreview draft={draft} /></>}
      </View>)}
      {prior?.comment && <><Copy muted small>Earlier sent item comment</Copy><Copy selectable>{prior.comment}</Copy></>}
      {prior?.draftComment && <><Copy muted small>Earlier unsent item comment</Copy><Copy selectable>{prior.draftComment}</Copy></>}
    </View>}
  </View>;
}

type Actions = ReturnType<typeof useQuestionActions>;

function hasContent(draft?: DraftContent | null) {
  return !!draft && Object.entries(draft).some(([key, value]) => key !== "version" && value !== undefined);
}

function TargetControls({ question, target, item, actions, disabled }: {
  question: Question; target: string; item?: string; actions: Actions; disabled: boolean;
}) {
  const colors = useColors();
  const draft = actions.draft(target) ?? {};
  const rec = recommendation(question, item);
  const manual = (patch: DraftContent, defer?: boolean) => actions.save(target, { ...draft, skipped: undefined, by: undefined, ...patch }, defer);
  const fieldDisabled = disabled || !!draft.skipped;
  const selected = Array.isArray(draft.value) ? draft.value : draft.value === undefined ? [] : [draft.value];
  const recommended = Array.isArray(rec) ? rec : [rec];

  return <View style={stack}>
    {draft.skipped ? <View style={row}><Pill colors={colors} icon="SkipForward" label="Will be skipped" /></View> : <>
      {question.kind === "choice" && <>
        {question.multi && <Copy small muted>{`Choose at least ${question.min ?? 1}${question.max === undefined ? "" : ` and at most ${question.max}`}`}</Copy>}
        <View style={{ gap: 6 }}>
          {question.options.map(optionParts).map(({ id, label, detail }) => {
            const checked = selected.includes(id);
            return <Option key={id} label={label} detail={detail} recommended={recommended.includes(id)}
              multi={question.multi} selected={checked} disabled={fieldDisabled}
              onPress={() => {
                const value = question.multi ? checked ? selected.filter((choice) => choice !== id) : [...selected, id] : id;
                manual({ value: Array.isArray(value) && !value.length ? undefined : value, other: question.multi ? draft.other : undefined });
              }} />;
          })}
        </View>
        {question.other !== false && <Field label="Other" showLabel={false} placeholder="Other answer…" value={draft.other}
          disabled={fieldDisabled} limit={LIMITS.answer}
          onChange={(other) => manual({ other: other.trim() ? other : undefined, value: !question.multi && other.trim() ? undefined : draft.value }, true)} />}
      </>}
      {question.kind === "text" && <>
        {typeof rec === "string" && <View style={row}>
          <Pill colors={colors} tone="accent" icon="Sparkles" label="Recommended" />
          <Copy selectable>{rec}</Copy>
          {draft.value !== rec && <Button variant="ghost" compact label="Use this" disabled={fieldDisabled}
            onPress={() => manual({ value: rec })} />}
        </View>}
        <Field label="Answer" showLabel={false} value={typeof draft.value === "string" ? draft.value : undefined} disabled={fieldDisabled}
          multiline={question.multiline} limit={LIMITS.answer} placeholder={question.placeholder ?? "Type your answer…"}
          onChange={(value) => manual({ value: value || undefined }, true)} />
      </>}
      {question.kind === "review" && <>
        <View accessibilityRole="radiogroup" style={row}>
          {reviewVerdicts(question).map((verdict) => {
            const on = verdict === draft.verdict;
            return <Pressable key={verdict} accessibilityRole="radio"
              accessibilityLabel={verdict === rec ? `${verdict}, recommended` : verdict}
              accessibilityState={{ checked: on, disabled: fieldDisabled }} disabled={fieldDisabled}
              onPress={() => manual({ verdict })}
              style={(state) => {
                const { focused } = state as { focused?: boolean };
                return { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 34, paddingHorizontal: space.md,
                  borderRadius: radius.pill, borderWidth: 1, borderColor: on || focused ? colors.accent : colors.border,
                  backgroundColor: on ? colors.accent : colors.surface0, opacity: fieldDisabled ? 0.5 : 1,
                  outlineStyle: focused ? "solid" : undefined, outlineWidth: focused ? 2 : undefined,
                  outlineColor: focused ? tint(colors.accent, 0.45) : undefined };
              }}>
              {on && <Glyph name="Check" color={colors.accentForeground} size={13} />}
              <Text style={{ ...type.body, fontWeight: "600", color: on ? colors.accentForeground : colors.foreground }}>{verdict}</Text>
              {verdict === rec && <Glyph name="Sparkles" color={on ? colors.accentForeground : colors.accent} size={12} />}
            </Pressable>;
          })}
        </View>
        {question.comment !== false && <OptionalField addLabel="Add a reason" label="Comment" value={draft.comment} disabled={fieldDisabled}
          limit={LIMITS.answer} onChange={(comment) => actions.save(target, { ...draft, comment: comment || undefined }, true)} />}
      </>}
      {question.kind !== "review" && question.note !== false && <OptionalField addLabel="Add note" label="Note" value={draft.note}
        disabled={fieldDisabled} limit={LIMITS.note}
        onChange={(note) => actions.save(target, { ...draft, note: note || undefined }, true)} />}
    </>}
    <View style={[row, { justifyContent: "flex-end" }]}>
      {!draft.skipped && <Button variant="quiet" compact label="Skip" disabled={disabled} onPress={() => actions.save(target, { skipped: true })} />}
      {Object.keys(draft).some((key) => key !== "version") && <Button variant="quiet" compact
        label={draft.skipped ? "Undo skip" : "Clear answer"} disabled={disabled} onPress={() => actions.save(target, null)} />}
    </View>
  </View>;
}

const stateLabels: Record<QuestionRecord["state"], [string, Tone, string]> = {
  open: ["Open", "accent", "Circle"],
  answered: ["Answered", "success", "CheckCircle2"],
  skipped: ["Skipped", "neutral", "SkipForward"],
  closed: ["Closed", "neutral", "XCircle"],
};

function State({ entry, record, target, wait }: { entry: QuestionRecord | ItemRecord; record: SurfaceRecord; target: string; wait: AgentWait }) {
  const colors = useColors();
  const answer = entry.answer;
  const delivery = record.deliveries.find((item) => item.n === entry.delivery);
  const draft = own(record.drafts, target);
  const [label, tone, icon] = stateLabels[entry.state];
  return <View style={{ ...stack, padding: space.md, borderRadius: radius.sm, backgroundColor: colors.surface2 }}>
    <View style={row}>
      <Pill colors={colors} tone={tone} icon={icon} label={label} />
      {delivery && <DeliveryPill delivery={delivery} wait={wait} />}
      {answer?.by === "recommended" && <Copy small muted>Accepted recommendation</Copy>}
    </View>
    {answer && !answer.skipped && <Copy selectable>{submittedPreview(answer)}</Copy>}
    {entry.state === "closed" && draft && Object.keys(draft).length > 1 && <>
      <Copy small muted>Unsent draft</Copy><DraftPreview draft={draft} />
    </>}
  </View>;
}

/** Shared answer controls for a surface fetched from its owning host. */
export function SurfaceQuestions({ hostId, theme, record, refresh }: {
  hostId: string; theme: PluginHostProps["theme"]; record: SurfaceRecord;
  refresh: () => Promise<SurfaceRecord | null | undefined>;
}) {
  const colors = theme.colors;
  const { earlier, comparison, loading, evidencePending } = useRevisionView(hostId, record);
  const actions = useQuestionActions(hostId, record, refresh);
  const [ref] = useAgents({ hosts: [hostId], where: (agent) => agent.id === record.agentId });
  const wait = useAgent(ref ?? record.agentId, (agent): AgentWait => {
    if (agent.hostId !== hostId) return null;
    if (agent.attentionReason === "permission") return "permission";
    return agent.status === "running" ? "turn" : null;
  });
  const ready = sendableTargets(record);
  const count = ready.length;
  const total = openTargets(record).length;
  const orphaned = !!record.orphanedAt;
  const disabled = actions.locked || orphaned;
  const sendDisabled = actions.pending || actions.unsaved || orphaned;
  const submitLabel = !total && !canComment(record) ? "Send item comments" : record.document?.submit?.label ?? "Send";

  const bindings = boundReviews(record);
  const bound = new Set([...bindings.values()].flat());
  const comments = sendableComments(record).length;
  const retainedComments = retainedItemComments(record);
  const drafted = openTargets(record).some(({ target }) => hasContent(actions.draft(target)));
  const readyTargets = new Set(ready.map(({ target }) => target));

  function draftPill(target: string) {
    const draft = actions.draft(target);
    if (!hasContent(draft)) return null;
    if (draft?.skipped) return <Pill colors={colors} icon="SkipForward" label="Skip" />;
    return readyTargets.has(target) ? <Pill colors={colors} tone="accent" icon="CircleDot" label="Ready to send" />
      : <Pill colors={colors} icon="PencilLine" label="Draft" />;
  }

  function reviewItem(id: string, item: string, state: ItemRecord) {
    const target = itemAddress(id, item);
    const question = record.document?.questions?.find((q) => q.id === id);
    return state.state === "open" && question ? <>
      {draftPill(target) && <View style={row}>{draftPill(target)}</View>}
      <TargetControls question={question} item={item} target={target} actions={actions} disabled={disabled} />
    </> : <State entry={state} record={record} target={target} wait={wait} />;
  }

  function reviewPrompt(block: string) {
    return bindings.get(block)?.map((id) => {
      const entry = record.questions[id];
      return <View key={id} style={stack}>
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
        return state && <View key={id} style={stack}>
          {reviews.length > 1 && <Copy small muted>{record.questions[id].prompt}</Copy>}
          {reviewItem(id, item, state)}
        </View>;
      })}
      {!!comment?.text && comment.delivery !== null && <View style={stack}>
        <View style={row}>
          <Copy small muted>Sent item comment</Copy>
          {delivery && <DeliveryPill delivery={delivery} wait={wait} />}
        </View>
        <Copy selectable>{comment.text}</Copy>
      </View>}
      {canComment(record) && !orphaned && <OptionalField addLabel="Comment on this item" label="Item comment" value={actions.comment(on)}
        disabled={disabled} limit={LIMITS.answer} onChange={(text) => actions.saveComment(on, text)} />}
    </>;
  }

  const separator = { borderTopWidth: 1, borderColor: colors.border, paddingTop: space.lg, gap: space.md } as const;

  return <Theme.Provider value={colors}>
    {record.revises && <Notice colors={colors} icon="GitCompare">
      <NoticeText colors={colors}>{earlier ? `Replaces · ${earlier.summary}`
        : loading ? "Loading earlier surface…" : "Earlier surface unavailable"}</NoticeText>
      {evidencePending ? <Copy small muted>Comparing saved snapshots…</Copy>
        : comparison?.incomplete && <Copy small muted>Some item evidence is unavailable for comparison.</Copy>}
    </Notice>}
    <SurfaceBlocks record={record} hostId={hostId} theme={theme} feedback={feedback} reviewPrompt={reviewPrompt}>
    <View style={{ gap: space.lg, minWidth: 0 }}>
      {Object.entries(record.questions).map(([id, entry]) => {
        if (bound.has(id)) return null;
        const question = record.document?.questions?.find((question) => question.id === id);
        const openItems = Object.values(entry.items ?? {}).filter((item) => item.state === "open").length;
        return <View key={id} style={separator}>
          <View style={[row, { justifyContent: "space-between", flexWrap: "nowrap", alignItems: "flex-start" }]}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text accessibilityRole="header" style={{ ...type.title, color: colors.foreground }}>{entry.prompt}</Text>
            </View>
            {entry.kind === "review" ? entry.state === "open" && <Pill colors={colors} tone="accent" label={`${openItems} to review`} />
              : entry.state === "open" && draftPill(id)}
          </View>
          {!!entry.closeReason && <BoundedText text={entry.closeReason} />}
          {entry.kind === "review" ? <View style={{ gap: space.sm }}>
            {Object.entries(entry.items ?? {}).map(([item, state]) => {
              const source = question?.kind === "review" ? reviewItems(question).find((entry) => entry.id === item) : undefined;
              return <View key={item} style={{ ...stack, padding: space.md, borderRadius: radius.sm, borderWidth: 1,
                borderColor: colors.border, backgroundColor: colors.surface1 }}>
                <Copy bold>{state.title}</Copy>
                {!!state.detail && <SurfaceMarkdown text={state.detail} />}
                {!!source?.ref && <ItemReference reference={source.ref} />}
                <ItemHistory item={comparison?.current.get(reviewAddress(id, item))} />
                {reviewItem(id, item, state)}
              </View>;
            })}
          </View> : entry.state === "open" && question
            ? <TargetControls question={question} target={id} actions={actions} disabled={disabled} />
            : <State entry={entry} record={record} target={id} wait={wait} />}
        </View>;
      })}
      {!!comparison?.removed.length && <View style={separator}>
        <Text accessibilityRole="header" style={{ ...type.title, color: colors.foreground }}>Earlier items</Text>
        {comparison.removed.map((item) => <View key={item.key} style={stack}>
          <Copy bold selectable>{item.title}</Copy>
          <ItemHistory item={item} />
        </View>)}
      </View>}
      {orphaned && <Notice colors={colors} tone="warning" icon="CircleSlash">
        <NoticeText colors={colors} strong>Agent stopped</NoticeText>
        <Copy small muted>Answers can be sent again once the agent is restored.</Copy>
      </Notice>}
      {retainedComments.map(({ on, title, text }) => <Notice key={on} colors={colors} icon="MessageSquare"
        action={<Button compact label="Clear item comment" disabled={actions.pending || actions.unsaved} onPress={() => actions.saveComment(on, "")} />}>
        <NoticeText colors={colors} strong>{title}</NoticeText>
        <Copy small muted>Unsent item comment</Copy>
        <Copy selectable>{text}</Copy>
      </Notice>)}
      {!!record.closed?.reason && !Object.values(record.questions).some((question) => question.closeReason === record.closed?.reason)
        && <BoundedText text={record.closed.reason} />}
      {record.deliveries.filter(({ state }) => state === "held" || state === "failed" || state === "removed" || state === "uncertain").map((delivery) =>
        <Notice key={delivery.n} colors={colors} tone={deliveryTones[delivery.state]} icon={deliveryIcons[delivery.state]}
          action={<Button compact icon="RotateCw" label="Retry" disabled={sendDisabled} onPress={() => void actions.retry(delivery.n)} />}>
          <NoticeText colors={colors} strong>{`Delivery ${delivery.n} · ${deliveryLabels[delivery.state]}`}</NoticeText>
          <Copy small muted>Your answers are saved. Retry sends them to the agent again.</Copy>
        </Notice>)}
      {!!actions.discarded && <Notice colors={colors} icon="Info">
        <Text accessibilityLiveRegion="polite" style={{ ...type.body, color: colors.foreground }}>{actions.discarded}</Text>
      </Notice>}
      {!!actions.error && <Notice colors={colors} tone="danger" icon="AlertTriangle">
        <Text accessibilityLiveRegion="polite" style={{ ...type.body, color: colors.foreground }}>{actions.error}</Text>
      </Notice>}
      {actions.unsaved && !actions.comparison.length && <View style={row}>
        <Button icon="RotateCw" label="Retry saving drafts" disabled={actions.pending || orphaned} onPress={() => void actions.retryDrafts()} />
      </View>}
      {actions.comparison.map(({ target, viewed, current, cannotKeep }) => {
        const copyOnly = cannotKeep || (!record.document && !!viewed);
        return <Notice key={target} colors={colors} tone="warning" icon="GitMerge">
          <NoticeText colors={colors} strong>{target}</NoticeText>
          <Copy small muted>{copyOnly ? "Your unsaved draft · Select text to copy" : "Your draft"}</Copy>
          <DraftPreview draft={viewed} />
          <Copy small muted>Stored draft</Copy><DraftPreview draft={current} />
          {actions.unsaved && <View style={[row, { paddingTop: space.xs }]}>
            {!copyOnly && <Button variant="primary" compact label="Keep my draft" disabled={actions.pending || orphaned} onPress={() => actions.resolveDraft(target, true)} />}
            <Button compact label={copyOnly ? "Discard unsaved edit" : "Use stored draft"}
              disabled={actions.pending || (!copyOnly && orphaned)} onPress={() => actions.resolveDraft(target, false)} />
          </View>}
        </Notice>;
      })}
      {(total > 0 || comments > 0) && <View style={{ ...separator, flexDirection: "row", flexWrap: "wrap", alignItems: "center",
        justifyContent: "space-between", gap: space.md }}>
        <View style={{ gap: 2, flexShrink: 1, minWidth: 160 }}>
          <Text accessibilityLiveRegion="polite" style={{ ...type.body, fontWeight: "600", color: colors.foreground }}>
            {[total ? `${count} of ${total} ready` : "", comments ? `${comments} item comment${comments === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ")}
          </Text>
          <Text style={{ ...type.meta, color: actions.unsaved ? colors.statusWarning : colors.foregroundMuted }}>
            {actions.unsaved ? "Drafts not saved yet"
              : actions.pending ? "Saving…"
              : count && count < total ? "Unanswered questions stay open after sending"
              : drafted ? "Draft saved on the host" : "Pick answers, then send"}
          </Text>
        </View>
        <View style={[row, { flexShrink: 1, maxWidth: "100%", justifyContent: "flex-end" }]}>
          {total > count && <Button variant="quiet" label="Skip the rest" disabled={sendDisabled} onPress={() => void actions.submit("skip")} />}
          {!!recommendations(record).length && <Button icon="Sparkles" label="Accept recommended" disabled={sendDisabled}
            onPress={() => void actions.submit("recommended")} />}
          <Button variant="primary" icon="Send" label={submitLabel}
            accessibilityLabel={`${submitLabel}, ${[total ? `${count} of ${total}` : "", comments ? `${comments} item comment${comments === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ")}`}
            disabled={(!count && !comments) || sendDisabled} onPress={() => void actions.submit("send")} />
        </View>
      </View>}
    </View>
    </SurfaceBlocks>
  </Theme.Provider>;
}
