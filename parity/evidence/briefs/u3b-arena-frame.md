# U3b runtime design arena frame

## Artifact
Produce one synthesized implementation sketch under `/tmp/arena-u3b-runtime-70fc1e6-01a0cbc6/`: caller usage, representative call sites, typed interfaces, module map, pseudocode/not-implemented bodies, behavior test map, and rationale. Do not edit the worktree; this is a design-only arena.

## Task
Design an implementation for all 12 items in `/tmp/pkg-briefs/u3b-runtime.md` for `/Users/josh-desktop/.pi/agent/pstack/pi-pstack-u3` at `70fc1e6`. Respect the U3b historical constraints in `/tmp/pkg-briefs/u3b-how-findings.md` and `/tmp/pkg-briefs/u3b-why-findings.md`. Required: documented Pi mechanisms, Cursor 0.15.5 behaviors; package agents at lowest precedence; explicit Task background argument wins; resolve the named skills with documented Pi `--skill`; package-root guard and skill paths, getAgentDir-based user paths; extension-private modelScope only; throw real execution failures but preserve timeout/detach content; bounded output + artifact paths; aggregate nested Usage; todo sequential; retain/reject Cursor Task.machine clearly; fix typecheck with no any/ignore/casts hiding mismatches. Keep `runs.ts` and `runner.mjs` changes minimal because quit survival belongs to another worker. One commit per item, no pushes/PRs, no main-clone edits.

## Rubric (grade each candidate 1-5)
1. Complete and precise coverage of all 12 acceptance requirements, including precedence, error/result distinctions, and tests.
2. Correct boundary choice: package files via package-relative imports; user config/skills via `getAgentDir()`; documented Pi APIs only; no `<pstack>` or `settings.json` fallback.
3. Small, deep interfaces and short call chains; preserves branch-backed state and existing execution model without generic pass-through layers.
4. Narrow blast radius, especially minimal `runs.ts`/`runner.mjs` lifecycle changes, no new permissions/isolation claims, no unrelated scope.
5. Type-system discipline and behavior-level, literal-assertion tests mapped to every applicable item, plus the exact real Pi smoke.

## Candidate whole-shape directions
- Candidate 1: preserve module ownership; add narrow in-place path resolutions and helpers only in current owners.
- Candidate 2: add one shared package-resource resolver (`PackageResources`) for package root, agent, guard, and bundled-skill paths, passed only at the Task/load boundary.
- Candidate 3: define a typed Task runtime/context boundary that resolves agent/config/skill/guard resources together and typed completion output/usage at the tool boundary, deriving the smallest API that makes invariants explicit.

## Verified Phase A evidence
- Real isolated Pi baseline: Task with `subagent_type: pstack-general` returned `Task result: Unknown agent "pstack-general". Available agents: none.` despite package install and bundled agents present. Setup dir: `/tmp/u3b-runtime-baseline.D4gpev`.
- Direct Bun runtime probes at baseline: `is_background` absent and agent default false; extension config ignored; package guard exists but child path list empty; `poteto-agent.md` contains raw `<pstack>`; child usage survives in event but summary has no aggregate `usage`; todo `executionMode` absent; package skill write guard returns no block.
- Cursor bundle `index.js` at `2026.09.18-9a7762b` directly defines `TaskToolCallArgsProto` with optional field 12 `machine`; its `ShellArgs` schema has no machine field.
- Historical constraints and source limits are in the linked grounding notes. Target worktree remains clean at branch `u3-runtime`, commit `70fc1e6`.