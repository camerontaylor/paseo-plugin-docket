Docket lets an agent show you a surface: a display wrapped around a typed set of questions that the plugin server keeps until you answer. You answer from the chat, a side panel or one inbox across every agent, and the answer reaches the agent as a structured response.

**Status: pre-alpha.** Only a placeholder tool, `docket_noop`, exists so far.

## Permissions

Today Docket answers no permission prompts at all: it has no permission handler and no setting for one. The placeholder `docket_noop` tool will prompt like any other tool in a mode that asks.

Policy, to be implemented in slice S4: Docket will answer the permission prompts of its own tools (`docket_show`, `docket_close`, `docket_get`, `docket_reference`) with allow, and no others. Every other permission request will be left pending for you or another plugin. A setting, "Answer the permission prompts for the plugin's own tools", will turn this off.

## What it writes and where

- `$PASEO_HOME/plugin-data/docket/` (`~/.paseo/plugin-data/docket/` when `PASEO_HOME` is unset): the plugin's own store. Currently only `s0-env.log`, one line per plugin start recording the `PASEO_HOME` the plugin process was given. Surfaces, answers and evidence will be stored here in later slices.
- Nothing else on disk, no network requests, and no changes to any agent's files.

## Setup

Requires Paseo 0.16.0-beta.2 or later on the daemon and the app. This minimum is provisional: the final value is set from the results of the two-host probe (P1).
