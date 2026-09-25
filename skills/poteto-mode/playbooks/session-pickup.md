### Session pickup

**You own the resume point. Read the prior trail, don't redo it.**

1. Locate the prior trail. Read a local transcript under Cursor's `agent-transcripts/` directory; on Pi, use the active workspace's session directory, the directory holding `$PI_SESSION_FILE` per `references/pi-runtime.md`. Do not glob across Cursor project directories, which cross workspace boundaries and expose private chats from unrelated projects; for the trail, a cloud-agent URL or pushed branch is another option. On Pi, keep the active workspace boundary at `$PI_CODING_AGENT_DIR/sessions/*/` in Pi's agent directory (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`). For a Task, use its `agent_id` with `SubagentAwait({agent_id, timeout_ms: 0})`, then read its transcript and artifact paths. Read the metadata overview and last messages first, then scan back for the decision points. Parse a long transcript in a Task and keep the reduced timeline in the main thread (the **principle-guard-the-context-window** skill).
2. Reconstruct operational state. The branch and worktree, what already landed (`git log`, `git diff` against the base), the open todos, the decisions made. The prior trail is authoritative input. Resist the bias to re-derive it.
3. Diff done vs pending. Compare what shipped against what was planned, name the resume point, do not re-run the prior repro or redo completed work. A "let me verify from scratch" pass means you're treating the trail as untrustworthy when it's authoritative.
4. Route the remaining work to the matching playbook and pick the verdict: continue the execution, ship a finished recommendation, ratify or override a prior conclusion, or postmortem a failed run. The pickup playbook ends here. The routed playbook owns the rest.
5. Verify the inherited claims against the original goal on the real artifact (the **principle-prove-it-works** skill). A passing prior self-report is not the proof.

**Reply:** where the prior agent stopped, what you inherited vs redid (ideally nothing redone), the resume point, and the outcome.
