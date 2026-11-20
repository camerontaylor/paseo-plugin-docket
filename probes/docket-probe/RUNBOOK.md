# docket-probe runbook (P1 two-host hub, P2 tool-call anchor)

Throwaway plugin; delete it when the results are in the spec. It writes one JSON line per event to
`$PASEO_HOME/plugin-data/docket-probe/report.jsonl` on each daemon host (`~/.paseo` by default).
Read results with the summary script, never from the screen:

    node probes/docket-probe/scripts/summarize.mjs [path-to-report.jsonl] [--json]

Built against 0.16.0-beta.2: it uses only SDK methods that build has, and records a missing one
(`missing:<method>`) instead of failing. There is no workspace-row-badge method in that build; the
probe reports this under `workspaceRowBadge`. The composer pill registers against a placeholder
workspace and agent, so it proves the call works but is not visible.

## Install (atlas and triton)

    # on the host, from a checkout of branch docket/probe-hosts
    paseo plugin install /abs/path/to/probes/docket-probe      # id docket-probe
    paseo plugin ls                                            # docket-probe running
    paseo plugin logs docket-probe                             # "Plugin ready"
    wc -l ~/.paseo/plugin-data/docket-probe/report.jsonl       # server.start row appears at once

`paseo plugin reload docket-probe` after editing; bump `BUNDLE_VERSION` in `shared/contracts.ts`
first so old and new copies are distinguishable. Install on atlas and triton only. Each host needs
`pluginsEnabled: true` in `config.json`.

## P1: two hosts, phone and two desktop windows (about ten minutes)

Each app window loads one client copy per connected host, in one JS realm per window. Hub id = realm.

1. Clear the reports on both hosts (`: > ~/.paseo/plugin-data/docket-probe/report.jsonl`), note the time.
2. Open the app in desktop window A and desktop window B, both connected to atlas and triton.
3. Open the app on the phone, connected to atlas and triton. Open the sidebar once (the sidebar item mounts a copy's host id).
4. In window A open a chat on **atlas only**. Leave triton with no chat open. Wait two minutes.
5. In window A, disconnect triton (host settings), wait one minute, reconnect. Wait one minute.
6. Open the "Docket probe" sidebar item or screen in each window and on the phone once; it lists the hub's copies.
7. Summarise on both hosts.

What to read (per `p1` row in the summary):

| Question | Where |
|---|---|
| A copy per connected host without its chat open | triton report has a copy row per window and the phone, with counters while no chat is open there |
| One hub per window per platform | `hubs` differs per window/phone; a window's `hubCopiesSeen` lists one copy per connected host (shared hub) or only itself (no sharing) |
| Counter values from the host whose chat is closed | triton copies show `counterCount` rising |
| Same copy resumes after reconnect | the same `copyId` has `subscription.closed` then counters continue (gaps counted by `seqGapsOrResets`); a new `copyId` means a new copy |
| Contribution points of this build | `contributions` per copy; `threw:` and `missing:` entries |
| Platform | `platforms` (web = desktop/Electron, ios/android = phone) |

## P2: tool-call anchor

The tool `docket_probe_echo({note?, delayMs?})` is added to every new agent session by a
`agent.session_open` hook and returns `DOCKET_PROBE_MARKER ok 7f3a9c1e` then `echo: <note>`. A
client transformer on `tool_call` items reports `name`, `status`, `phase`, `detailType` and
`hasMarker` (the marker found in `detail.output`), plus a per-callId `observation` counter and `observedAt`, for echo-tool calls. Every transformer invocation is reported (first 50 per callId, then every 50th), so a replay after reopen, restart or reload shows as a higher `observation` for the same `callId` (or a new `copyId`). Open an app window for the
duration (the transformer runs in the client).

Prompt for each agent: *"Call the tool docket_probe_echo with note `<label>` and delayMs 20000, then tell me what it returned."*
Use a fresh agent per provider so the tool is registered at session open. Providers: **Claude, Codex, jcode**.

For each provider run these states (label = provider + state), reading `p2` rows (name | status |
detailType | marker) and `serverToolRuns`:

| State | Do | Expect to read |
|---|---|---|
| during | while the 20 s call runs, look at the row | `running` tool_call row, name as the provider reports it |
| after | when it completes | `completed` row, `marker=true`, `detailType` |
| after daemon restart | `paseo daemon restart` (host), reopen the chat | transformer sees the item again, `marker` still true |
| reopen | archive and reopen, or open the chat in a second window | same |
| plugin reload | `paseo plugin reload docket-probe` with the agent open; ask the agent to call the tool again | `server tool runs` +1 if the open session kept the tool; none if reload drops it |

A `marker=false` completed row on a provider means the result text does not reach the transformer
there; record the `detailType` and `sample` output. Record results in spec sections 9.1, 11 and
31.1 item 5 with the date.
