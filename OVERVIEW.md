Docket lets an agent show a surface, a display with typed questions the plugin server keeps until the user answers. The server provides three Stage 1 tools: `docket_show`, `docket_close` and `docket_get`. The inline card, panel and inbox are built in later Stage 1 slices.

## Settings and permissions

Host settings control tool attachment and instructions (on), permission auto-allow (on), sound for a stopping surface (off), extra absolute evidence folders (none), evidence retention (30 days), and experiment events (on). The client consumes the sound preference when card and inbox support is available. The server reads retention and event settings when it opens the store.

Permission auto-allow matches only tool requests named `mcp__paseo__docket_show`, `mcp__paseo__docket_close`, `mcp__paseo__docket_get` or the same tool names prefixed with `paseo.`. Read, close and replacement operations use the caller's agent id.

## Storage

The host stores records, evidence, and experiment events in `$PASEO_HOME/plugin-data/docket/` (defaults to `~/.paseo/plugin-data/docket/`). The session-open hook sets `DOCKET_STORAGE` to the caller's private directory under `agents/`. Evidence reads are confined to the agent's working directory, its Docket storage, `/tmp`, and configured extra folders. Docket captures the evidence at show time.

## Live S4 acceptance

Use an approved host already running the S4 build and create fresh Claude and Codex sessions. The SDK baseline in this repository is Paseo 0.16.0-beta.2. Record the actual daemon and provider builds on the host. On atlas, triton, and future Docket hosts, keep genui running and disable its automatic instructions before testing. Use fresh sessions so earlier instructions do not carry over. A session opened before installation needs reopening to acquire the tools. A plugin reload can temporarily drop tools from an open session until its turn ends.

1. On each provider, call `docket_show` using [the questions-only fixture](shared/fixtures/spec-20-1-questions-only.json) as `surface`. Repeat using the same fixture encoded as JSON text. Record the first result line `[docket s_…]`, its rendered text and the matching persisted record under `surfaces/<id>/record.json`.
2. Call `docket_show` with `{"surface":{"v":2,"meanwhile":"go_ahead"}}`. Confirm the result reports every validation problem with its pointer and creates no surface. Call `docket_get` from the original agent and confirm it lists its open surfaces.
3. From a second agent on the same host, try `docket_get` and `docket_close` with the first agent's surface id. Confirm both are refused, then close it from the original agent with the reason “Answered in chat” and confirm the record reflects the close.
4. On a provider and mode that issue tool permission prompts, confirm an exact Paseo-prefixed Docket tool request is allowed with the setting on. Confirm an unrelated permission remains pending and turning the setting off stops Docket from allowing its own tool prompts.

The prior direct Codex transformer probe observed a completed call with detail type `unknown` and marker present. Running-call and same-call restart observations are pending, as are transformer observations on other providers on that build. S4 returns the marker as its first text line so the later card can use the call result. Live S4 acceptance requires running the steps above with the S4 build.
