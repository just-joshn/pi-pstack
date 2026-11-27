import { describe, expect, it } from "vitest";
import { renderJson, renderPretty } from "../src/skills/poteto-mode/scripts/watch-pr/render.ts";
import {
	type Check,
	type CiClean,
	type PullRequestFacts,
	parsePrNumber,
	type WatcherVerdict,
} from "../src/skills/poteto-mode/scripts/watch-pr/types.ts";

const pr = { owner: "acme", repo: "widgets", number: parsePrNumber(42) };
const next = { ...pr, number: parsePrNumber(43) };
const facts: PullRequestFacts = {
	context: pr,
	mergeable: "MERGEABLE",
	mergeStateStatus: "CLEAN",
	reviewDecision: "APPROVED",
	headRefOid: "abc",
	headRefName: "feature",
	baseRefName: "main",
	state: "OPEN",
	mergedAt: null,
	isDraft: false,
};
const passed: Extract<Check, { kind: "passed" }> = {
	kind: "passed",
	name: "build",
	reportedState: "SUCCESS",
	description: "ok",
	link: "https://ci/build",
	workflow: "CI",
};
const pending: Extract<Check, { kind: "pending" }> = {
	...passed,
	kind: "pending",
	name: "test",
	reportedState: "PENDING",
};
const failed: Extract<Check, { kind: "failed" }> = {
	...passed,
	kind: "failed",
	name: "test",
	reportedState: "FAILURE",
	description: "tests failed",
	link: "https://ci/test",
};
const github = {
	kind: "allowed",
	basis: "merge-state",
	mergeStateStatus: "CLEAN",
	headRollupState: "SUCCESS",
} as const;
const clean: CiClean = {
	kind: "ci-clean",
	source: "gh-pr-checks",
	all: [passed],
	failed: [],
	pending: [],
	hadPreviousPassingCi: false,
	github,
};
const failure = { kind: "checks-unavailable", retryable: true, detail: "API unavailable" } as const;
const thread = {
	id: "thread-1",
	isBugbot: true,
	bugbotReviewPasses: 2,
	firstComment: {
		authorLogin: "reviewer",
		body: "Fix the race\nmore detail",
		path: "src/a.ts",
		line: 17,
		createdAt: "2025-01-01T00:00:00Z",
	},
} as const;
const base = { schemaVersion: 1, sequence: 3, observedAt: "2025-01-01T00:00:00Z" } as const;

describe("watch-pr public output", () => {
	it("renders a status table with CI, review and merge state for each PR", () => {
		const verdict: WatcherVerdict = {
			...base,
			kind: "STATUS",
			mode: "stack",
			terminal: false,
			reason: "poll",
			rows: [
				{
					kind: "open",
					context: pr,
					facts,
					threads: [thread],
					reviewAutomationRunning: true,
					ci: {
						kind: "ci-failing",
						source: "gh-pr-checks",
						all: [failed, pending],
						failed: [failed],
						pending: [pending],
						hadPreviousPassingCi: true,
						github,
					},
				},
				{ kind: "merged", context: next, facts: { ...facts, context: next, state: "MERGED" } },
			],
		};
		expect(renderPretty(verdict)).toBe(
			"| PR | CI | Review | Merge |\n| --- | --- | --- | --- |\n| [#42](https://github.com/acme/widgets/pull/42) | ❌ 1 failed, 1 pending, was ✅ | 🤖 running, 1 open | ✅ |\n| [#43](https://github.com/acme/widgets/pull/43) | — | — | ✅ merged |\n",
		);
	});

	it("renders actionable blockers without losing their details", () => {
		const cases: Array<[WatcherVerdict, string]> = [
			[
				{
					...base,
					kind: "BLOCKER",
					mode: "single",
					terminal: true,
					exitCode: 2,
					blocker: {
						kind: "merge-conflicts",
						pr,
						facts: { ...facts, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" },
					},
				},
				"BLOCKER: merge-conflicts\npr=42\nmergeable=CONFLICTING\nmergeStateStatus=DIRTY\naction=resolve merge conflicts before waiting for CI\n",
			],
			[
				{
					...base,
					kind: "BLOCKER",
					mode: "stack",
					terminal: true,
					exitCode: 3,
					blocker: { kind: "review-threads", pr, threads: [thread] },
				},
				"BLOCKER: review-threads\npr=42\nunresolved=1\nthread-1 src/a.ts 17 reviewer isBugBot=true bugbotReviewPasses=2 Fix the race\n",
			],
			[
				{
					...base,
					kind: "BLOCKER",
					mode: "single",
					terminal: true,
					exitCode: 4,
					blocker: {
						kind: "failing-checks",
						pr,
						ci: {
							kind: "ci-failing",
							source: "gh-pr-checks",
							all: [failed],
							failed: [failed],
							pending: [],
							hadPreviousPassingCi: false,
							github,
						},
					},
				},
				"BLOCKER: failing-checks\npr=42\nfailed=1\ntest FAILURE tests failed https://ci/test\n",
			],
			[
				{
					...base,
					kind: "BLOCKER",
					mode: "queued-stack",
					terminal: true,
					exitCode: 6,
					blocker: { kind: "merge-gate", pr, reason: "draft-pr" },
				},
				"BLOCKER: draft-pr\npr=42\naction=mark the PR ready for review before waiting for the merge queue\n",
			],
			[
				{
					...base,
					kind: "BLOCKER",
					mode: "single",
					terminal: true,
					exitCode: 7,
					blocker: { kind: "status-query", failures: 3, failure },
				},
				"BLOCKER: status-query\nfailures=3\ndetail=API unavailable\naction=verify current PR context, GitHub authentication, and API availability, then rearm\n",
			],
		];
		for (const [verdict, expected] of cases) expect(renderPretty(verdict)).toBe(expected);
	});

	it("reports progress and terminal outcomes", () => {
		const cases: Array<[WatcherVerdict, string]> = [
			[
				{ ...base, kind: "QUEUE", mode: "queued-stack", terminal: false, queue: [pr, next] },
				"QUEUE: captured 2 PRs bottom-to-top: #42,#43\n",
			],
			[
				{
					...base,
					kind: "WAITING",
					mode: "single",
					terminal: false,
					frontier: pr,
					reason: { kind: "pending-checks", pending: [pending] },
				},
				"WAITING: frontier=#42; 1 check pending\n",
			],
			[
				{
					...base,
					kind: "WAITING",
					mode: "queued-stack",
					terminal: false,
					frontier: next,
					reason: { kind: "merge-queue", unmergedCount: 2 },
				},
				"WAITING: frontier=#43 is blocker-free; waiting for merge queue (2 PRs unmerged)\n",
			],
			[
				{
					...base,
					kind: "ADVANCE",
					mode: "queued-stack",
					terminal: false,
					merged: pr,
					frontier: next,
					remaining: 1,
				},
				"ADVANCE: merged #42; next=#43; remaining=1\n",
			],
			[
				{
					...base,
					kind: "RETRY",
					mode: "single",
					terminal: false,
					failure,
					consecutiveFailures: 1,
					retryInSeconds: 10,
				},
				"RETRY: GitHub status query failed; retrying in 10s\ndetail=API unavailable\n",
			],
			[
				{
					...base,
					kind: "READY",
					mode: "single",
					terminal: true,
					exitCode: 0,
					scope: {
						kind: "single",
						pr: {
							kind: "ready-pr",
							context: pr,
							proof: {
								mergeability: "clear",
								threads: [],
								ci: clean,
								gate: { state: "OPEN", reviewDecision: "APPROVED", draft: "draft-allowed" },
							},
						},
					},
				},
				"READY: no merge conflicts, no unresolved review threads, no failing or pending checks\nmergeStateStatus=CLEAN\nreviewDecision=APPROVED\nisDraft=true\nnote=draft allowed (--allow-draft); leave draft — do not mark ready\n",
			],
			[
				{
					...base,
					kind: "TIMEOUT",
					mode: "queued-stack",
					terminal: true,
					exitCode: 5,
					reason: { kind: "queued-stack", frontier: next, unmergedCount: 1 },
				},
				"TIMEOUT: queued stack still has 1 PR unmerged; frontier=#43\n",
			],
			[
				{
					...base,
					kind: "COMPLETE",
					mode: "queued-stack",
					terminal: true,
					exitCode: 0,
					queue: [pr],
					merged: [{ kind: "merged-pr", context: pr, mergedAt: null }],
				},
				"COMPLETE: queued stack merged (1 PR)\n",
			],
		];
		for (const [verdict, expected] of cases) expect(renderPretty(verdict)).toBe(expected);
	});

	it("emits one newline-delimited JSON object with the complete event", () => {
		const verdict: WatcherVerdict = {
			...base,
			kind: "BLOCKER",
			mode: "single",
			terminal: true,
			exitCode: 7,
			blocker: { kind: "status-query", failures: 3, failure },
		};
		const output = renderJson(verdict);
		expect(output.endsWith("\n")).toBe(true);
		expect(output.trim().split("\n")).toHaveLength(1);
		expect(JSON.parse(output)).toEqual({
			schemaVersion: 1,
			sequence: 3,
			observedAt: "2025-01-01T00:00:00Z",
			kind: "BLOCKER",
			mode: "single",
			terminal: true,
			exitCode: 7,
			blocker: {
				kind: "status-query",
				failures: 3,
				failure: { kind: "checks-unavailable", retryable: true, detail: "API unavailable" },
			},
		});
	});
});
