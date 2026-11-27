# Docket UI polish: before/after evidence

Runtime screenshots from the normal Paseo web client (0.17.4-fork e046b9e491ec) connected to a
disposable local daemon (separate PASEO_HOME, 127.0.0.1 only) with the Docket plugin loaded from
the PR worktree. "before" = origin/main 4471d85; "after" = PR head. Desktop images are cropped to
exclude the Paseo sidebar.

Data: surfaces were created by real Claude (haiku) agents calling docket_show with the stage-1
fixtures, then answered through the inbox UI (draft, partial send, full send, archive). One
surface ("Which log level…") was seeded through the plugin's own store API with a failed delivery,
because a real failure could not be provoked on demand. It is labelled seeded, not runtime.
