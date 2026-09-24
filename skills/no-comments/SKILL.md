---
name: no-comments
description: "Spawn Comment Sicko, fix accepted findings, and offer encodings for claimed constraints."
disable-model-invocation: true
---

# No comments

Spawn Comment Sicko. Act on accepted findings.

Defer to Comment Sicko's fresh perspective.

## Scope

Use the caller's files or diff. Otherwise use the current diff against the base branch, default `main`, including the working tree.

## Steps

1. Snapshot the scope first, so step 2 can see what Comment Sicko changed even in uncommitted files: `mkdir -p /tmp/no-comments-<slug>/before && git ls-files -m -o --exclude-standard <scope paths> | xargs -I{} cp --parents {} /tmp/no-comments-<slug>/before/` (or copy the scoped files by hand). Then launch one Task with `subagent_type: "Comment Sicko"`. Pass the scope. Do not restate its rules. Loading this skill authorizes that Task call.
2. Inspect its report and diff. Its diff is the scoped files against the step 1 snapshot (`git diff --no-index /tmp/no-comments-<slug>/before/<path> <path>` per file), not `git diff` against HEAD, which hides deletions of comments that were never committed. Count deletions from that diff and report the count it shows, even when it disagrees with Comment Sicko's report. Reject application-code edits, scope escapes, exception-protected deletions, misstated `MUST KILL` reasons, and flags that treat kept intentional code as guilty. Reshape flags on our-code surprises stay actionable. Do not restore those comments. A keep survives only with proof it is about something we cannot change. Audit missed scoped lint and TypeScript suppressions. Correctness or safety suppressions stay actionable `MUST KILL`s. Restore deletions only with exact exceptions and scoped proof. Before accepting thin `IMPORTANT` or `do not remove` kills or keeps, apply the **how** or **why** skill (`../how/SKILL.md`, `../why/SKILL.md`) on their symbol. If a kill is ambiguous, do not restore. If a keep is refuted or still ambiguous, delete it. Revert and rerun one rejected report with the failure named. Reject a second, report it open, and fail `/skill:no-comments`.
3. Fix trivial accepted flags directly by deleting a dead path, dropping a parameter, or using the real API. If any fix needs a shape, apply the **architect** skill (`../architect/SKILL.md`) once for the accepted set and surrounding code. Stop at the sketch. Architect shapes. Step 4 implements.
4. Implement the smallest root-cause fix in scope. Remove every named workaround. If the root cause is out of scope, land the smallest in-scope fix and report the rest open. The **principle-fix-root-causes** and **principle-redesign-from-first-principles** skills guide intent only. Neither authorizes widening the fence nor fixing instances outside it. Never bolt on symptom guards.
5. Constraint comments say `do not remove`, `do not change wording`, or `talk to X before changing`. Leave keeps about things we cannot change. Offer the cheapest in-scope type, runtime, test, or CI lint. Wait for interactive approval. Unattended and eval require caller pre-approval. If approved, encode then delete. Otherwise delete, report the constraint open, and sketch out-of-scope work.
6. Report the deletion count, restored comments, reruns, architect sketch, fixes, encoding offers, encodings, unenforced constraints, and other open work.
