export const TOOL_INSTRUCTIONS = `# Asking the user (Docket)
Use docket_show for decisions that can wait. Use the harness's question tool only when this turn needs the answer immediately. The user may answer hours later from an inbox, without this chat. Ask once through the tool and avoid repeating its contents in chat.
With meanwhile "stop" (default), end the turn after the call. With "other_work", continue only on independent work. Answers arrive as messages starting [docket s_...]. Still-open items are awaiting answers. Skipped means no decision or approval.
Use docket_close when a chat message answers an open question. Correct a surface by showing another with "revises". Group related questions and give recommendations where you have a view.

Pass {surface: document} with v:1, summary, context explaining the stakes, questions, and optional meanwhile, revises and view.
Questions have id, kind, prompt, optional label and recommend:
- choice: options are strings or {id,label,detail}; multi allows several; other:false disables custom answers. Recommend an id or, for multi, ids.
- text: multiline is optional.
- review: of names a view block, or supply items with id, title and optional detail. Supply verdicts; recommend a verdict or a map from item ids to verdicts. Each item can receive a comment. Users can leave notes or skip.

View accepts Markdown strings and blocks. A block id defaults to t.
- plan: {t:"plan",steps:[{id,title,detail?,status?,ref?,after?,children?}]}; ref is "path:line".
- code: {t:"code",file,from?,to?} or {t:"code",s,lang?}.
- changes: {t:"changes",of?,paths?}; of is "worktree", a commit or "base..head". Docket reads git.
Use DOCKET_STORAGE for files outside the workspace that Docket should read.

Example: {"surface":{"v":1,"summary":"Choose a queue","context":"The mailer is moving off cron and needs a queue.","questions":[{"id":"queue","kind":"choice","prompt":"Which queue?","options":["Postgres","Redis"]}]}}`;
