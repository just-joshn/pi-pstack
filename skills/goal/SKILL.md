---
name: goal
description: Set a goal that Pi will pursue to completion. Use when the user runs /skill:goal or asks to pursue a durable objective.
disable-model-invocation: true
---
# Goal

Use the same durable, tool-driven flow in local and cloud-style environments; cloud Tasks run in a local Git worktree. In a headless run (`pi --print`, `--mode json`, or a child `Task` run), do not create a goal because nothing is alive to receive goal-continuation wakes. Do the work in this turn and tell the user to invoke `/skill:goal` from an interactive Pi session if continued goal tracking is needed.

## Parse

Accept `/skill:goal <objective>`.

- If the objective is empty, show `Usage: /skill:goal <objective>`.
- There is no deadline, token budget, or turn budget. A goal continues until it is complete.
- If the request leads with a time limit such as `30m` or `2h`, say plainly that time-limited goals are not supported yet, then create the goal without one rather than folding the limit into the objective.
- "Every" describes recurring work and belongs to `/skill:loop`, not `/skill:goal`.

## Start

1. Restate the objective clearly, including every explicit deliverable or required evidence you will verify against the repo.
2. Call `CreateGoal` exactly once with the objective. Do not create goal files manually or retry creation.
3. If creation fails, report that no goal was armed. Goal state lives in the Pi session branch; ordinary file tools may keep optional scratchpads, but continuation does not require them.
4. Perform the first concrete unit of work immediately in this turn; do not stop after planning or creating the goal.

## Guidelines

### Continuation behavior

- This goal persists across turns. Ending this turn does not require shrinking the objective to what fits now.
- Keep the full objective intact. If it cannot be finished now, make concrete progress toward the real requested end state, leave the goal active, and do not redefine success around a smaller or easier task. Temporary rough edges are acceptable while the work is moving in the right direction. Completion still requires the requested end state to be true and verified.
- An active goal continues after idle turns, but pauses after three consecutive continuations without a tool call. If it pauses while work remains, resume it with `UpdateGoal({ status: "ACTIVE" })` and make progress. Use `UpdateGoal({ status: "PAUSED" })` to pause or `UpdateGoal({ status: "CLEARED" })` to abandon a goal when the user asks.

### Work from evidence

Use the current working tree and external state as authoritative. Previous conversation context can help locate relevant work, but inspect the current state before relying on it. Improve, replace, or remove existing work as needed to satisfy the actual objective.

### Progress visibility

If `todo` is available and the next work is meaningfully multi-step, use it to show a concise plan tied to the real objective. Keep the plan current as steps complete or the next best action changes. Skip planning overhead for trivial one-step progress, and do not treat a plan update as a substitute for doing the work.

### Fidelity

Optimize each turn for movement toward the requested end state, not for the smallest stable-looking subset or easiest passing change. Do not substitute a narrower, safer, smaller, merely compatible, or easier-to-test solution because it is more likely to pass current tests. Treat alignment as movement toward the requested end state. An edit is aligned only if it makes the requested final state more true; useful-looking behavior that preserves a different end state is misaligned.

### Completion audit

Before deciding that the goal is achieved, treat completion as unproven and verify it against the actual current state:

- Derive concrete requirements from the objective and any referenced files, plans, specifications, issues, or user instructions.
- Preserve the original scope; do not redefine success around the work that already exists.
- For every explicit requirement, numbered item, named artifact, command, test, gate, invariant, and deliverable, identify the authoritative evidence that would prove it, then inspect the relevant current-state sources: files, command output, tests, PR state, rendered artifacts, runtime behavior, or other authoritative evidence.
- For each item, determine whether the evidence proves completion, contradicts completion, shows incomplete work, is too weak or indirect to verify completion, or is missing.
- Match the verification scope to the requirement's scope; do not use a narrow check to support a broad claim.
- Treat tests, manifests, verifiers, green checks, and search results as evidence only after confirming they cover the relevant requirement.
- Treat uncertain or indirect evidence as not achieved; gather stronger evidence or continue the work.
- The audit must prove completion, not merely fail to find obvious remaining work.

Do not rely on intent, partial progress, memory of earlier work, or a plausible final answer as proof. Do not mark a goal complete merely because you are stopping work. Only call `UpdateGoal({ status: "COMPLETE" })` when current evidence proves every requirement is satisfied and no required work remains. If the evidence is incomplete, weak, indirect, merely consistent with completion, or leaves any required work missing, incomplete, or unverified, keep the goal active instead of marking it complete. Do not call `UpdateGoal` unless the goal is complete, the user paused it and wants to resume, or the user asks to pause or clear it.
