import { describe, expect, it } from "vitest";
import { failedCheck, fakeReader, passingCheck } from "../src/skills/poteto-mode/scripts/watch-pr/fakes.test-helper.ts";
import { WatcherQueryError } from "../src/skills/poteto-mode/scripts/watch-pr/github.ts";
import {
	applyQueueSnapshot,
	classifyPr,
	createQueueState,
	evaluateQueue,
	planQueue,
	type QueueState,
	readSnapshot,
	runQueued,
	runSimple,
	selectTierMajorStackDecision,
} from "../src/skills/poteto-mode/scripts/watch-pr/policy.ts";
import type {
	CiClean,
	CiFailing,
	CiGithubRejected,
	CiPending,
	FailedCheck,
	GitHubReader,
	NonEmpty,
	PendingCheck,
	PollingOptions,
	PrContext,
	ProgressVerdict,
	PrSnapshot,
	PullRequestFacts,
	ReviewThread,
} from "../src/skills/poteto-mode/scripts/watch-pr/types.ts";
import { parsePrNumber } from "../src/skills/poteto-mode/scripts/watch-pr/types.ts";

function one<T>(value: T): NonEmpty<T> {
	return [value];
}

const context = (number: number): PrContext => ({
	owner: "owner",
	repo: "repo",
	number: parsePrNumber(number),
});

const facts = (number: number, over: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
	context: context(number),
	mergeable: "MERGEABLE",
	mergeStateStatus: "CLEAN",
	reviewDecision: "APPROVED",
	headRefOid: "head",
	headRefName: "feature",
	baseRefName: "main",
	state: "OPEN",
	mergedAt: null,
	isDraft: false,
	...over,
});

const cleanCi = (): CiClean => ({
	kind: "ci-clean",
	source: "gh-pr-checks",
	all: one(passingCheck()),
	hadPreviousPassingCi: false,
	failed: [],
	pending: [],
	github: { kind: "allowed", basis: "merge-state", mergeStateStatus: "CLEAN", headRollupState: "SUCCESS" },
});

const makePending = (name = "ci"): PendingCheck => ({
	kind: "pending",
	name,
	reportedState: "PENDING",
	description: "",
	link: "",
	workflow: "",
});

const makeFailed = (name = "ci"): FailedCheck => ({
	kind: "failed",
	name,
	reportedState: "FAILURE",
	description: "",
	link: "",
	workflow: "",
});

const pendingCi = (name = "ci"): CiPending => ({
	kind: "ci-pending",
	source: "gh-pr-checks",
	all: one(makePending(name)),
	hadPreviousPassingCi: false,
	failed: [],
	pending: one(makePending(name)),
});

const failingCi = (): CiFailing => ({
	kind: "ci-failing",
	source: "gh-pr-checks",
	all: one(makeFailed()),
	hadPreviousPassingCi: false,
	failed: one(makeFailed()),
	pending: [],
	github: { kind: "refused", mergeStateStatus: "BLOCKED", headRollupState: "FAILURE" },
});

const rejectedCi = (): CiGithubRejected => ({
	kind: "ci-github-rejected",
	source: "graphql-rollup",
	all: one(passingCheck()),
	hadPreviousPassingCi: false,
	failed: [],
	pending: [],
	github: { kind: "refused", mergeStateStatus: "BLOCKED", headRollupState: "ERROR" },
});

type OpenRow = Extract<PrSnapshot, { readonly kind: "open" }>;
const openRow = (
	number: number,
	over: {
		readonly ci?: OpenRow["ci"];
		readonly threads?: readonly ReviewThread[];
		readonly facts?: Partial<PullRequestFacts>;
	} = {},
): OpenRow => {
	const rowFacts = facts(number, over.facts);
	return {
		kind: "open",
		context: rowFacts.context,
		facts: rowFacts,
		threads: over.threads ?? [],
		ci: over.ci ?? cleanCi(),
		reviewAutomationRunning: false,
	};
};

const mergedRow = (number: number): PrSnapshot => ({
	kind: "merged",
	context: context(number),
	facts: facts(number, { state: "MERGED", mergedAt: "2026-01-01T00:00:00Z" }),
});

const closedRow = (number: number): PrSnapshot => ({
	kind: "closed",
	context: context(number),
	facts: facts(number, { state: "CLOSED" }),
});

const thread = (id: string): ReviewThread => ({
	id,
	firstComment: {
		authorLogin: "bugbot",
		body: `RUN_ID: ${id}`,
		path: "src/a.ts",
		line: 1,
		createdAt: "2026-01-01T00:00:00Z",
	},
	isBugbot: true,
	bugbotReviewPasses: 1,
});

const options = (over: Partial<PollingOptions> = {}): PollingOptions => ({
	interval: 60,
	sweepInterval: 300,
	timeout: 0,
	maxQueryErrors: 5,
	allowDraft: false,
	...over,
});

function fakeClock(sleep?: (seconds: number) => void) {
	let now = 0;
	const sleeps: number[] = [];
	return {
		sleeps,
		advance(seconds: number) {
			now += seconds;
		},
		watch: {
			now: () => now,
			observedAt: () => "2026-01-01T00:00:00.000Z",
			sleep: async (seconds: number) => {
				sleeps.push(seconds);
				now += seconds;
				sleep?.(seconds);
			},
		},
	};
}

describe("snapshot edges", () => {
	it("treats a closed PR as a merge gate rather than a contribution", async () => {
		expect(classifyPr(closedRow(1))).toEqual({
			kind: "blocker",
			blocker: { kind: "merge-gate", pr: context(1), reason: "closed-without-merge" },
		});
		const verdict = await runSimple({
			dependencies: { reader: fakeReader({ facts: { state: "CLOSED" } }), clock: fakeClock().watch, emit() {} },
			contexts: one(context(1)),
			mode: "single",
			statusOnly: false,
			options: options(),
		});
		expect(verdict).toMatchObject({
			kind: "BLOCKER",
			exitCode: 6,
			blocker: { kind: "merge-gate", reason: "closed-without-merge" },
		});
	});

	it("treats a merged timestamp without a merged state as merged and short-circuits queries", async () => {
		const reader = fakeReader({ facts: { mergedAt: "2026-01-01T00:00:00Z" } });
		const snapshot = await readSnapshot({
			reader,
			context: context(5),
			pendingHistory: "include",
			allowDraft: false,
		});
		expect(snapshot.kind).toBe("merged");
		expect(reader.calls).toEqual(["pullRequest"]);
		const verdict = await runSimple({
			dependencies: { reader, clock: fakeClock().watch, emit() {} },
			contexts: one(context(5)),
			mode: "single",
			statusOnly: false,
			options: options(),
		});
		expect(verdict).toMatchObject({
			kind: "READY",
			exitCode: 0,
			scope: { kind: "single", pr: { kind: "merged-pr", mergedAt: "2026-01-01T00:00:00Z" } },
		});
	});

	it("falls back to GitHub's own rollup when the head oid is unknown", async () => {
		const snapshot = await readSnapshot({
			reader: fakeReader({
				facts: { mergeStateStatus: "BLOCKED", headRefOid: null },
				commitRollups: [
					{ oid: "older", state: "SUCCESS" },
					{ oid: "newer", state: "FAILURE" },
				],
			}),
			context: context(6),
			pendingHistory: "omit",
			allowDraft: false,
		});
		expect(snapshot.kind).toBe("open");
		if (snapshot.kind !== "open") throw new Error("expected open snapshot");
		expect(snapshot.ci).toMatchObject({
			kind: "ci-clean",
			hadPreviousPassingCi: true,
			github: { kind: "allowed", basis: "rollup", headRollupState: null },
		});
	});

	it("queries rollups for an included pending history", async () => {
		const reader = fakeReader({
			fastPath: { kind: "checks", checks: [makePending("build")] },
			commitRollups: [{ oid: "head", state: "PENDING" }],
		});
		const snapshot = await readSnapshot({
			reader,
			context: context(7),
			pendingHistory: "include",
			allowDraft: false,
		});
		expect(snapshot.kind).toBe("open");
		if (snapshot.kind !== "open") throw new Error("expected open snapshot");
		expect(snapshot.ci).toMatchObject({
			kind: "ci-pending",
			pending: [{ name: "build" }],
			hadPreviousPassingCi: false,
		});
		expect(reader.calls).toContain("commitRollups");
	});

	it("marks review automation only for pending automation checks", async () => {
		const running = await readSnapshot({
			reader: fakeReader({ fastPath: { kind: "checks", checks: [makePending("Cursor Bugbot Review")] } }),
			context: context(8),
			pendingHistory: "omit",
			allowDraft: false,
		});
		expect(running.kind === "open" && running.reviewAutomationRunning).toBe(true);
		const idle = await readSnapshot({
			reader: fakeReader({ fastPath: { kind: "checks", checks: [makePending("build")] } }),
			context: context(8),
			pendingHistory: "omit",
			allowDraft: false,
		});
		expect(idle.kind === "open" && idle.reviewAutomationRunning).toBe(false);
	});
});

describe("classification edges", () => {
	it("blocks on unresolved review threads with exit code 3", async () => {
		expect(classifyPr(openRow(1, { threads: [thread("run-1")] }))).toMatchObject({
			kind: "blocker",
			blocker: { kind: "review-threads" },
		});
		const verdict = await runSimple({
			dependencies: {
				reader: fakeReader({
					threadPages: [
						{
							threads: [
								{
									id: "run-1",
									resolved: false,
									firstComment: {
										authorLogin: "bugbot",
										body: "RUN_ID: run-1",
										path: null,
										line: null,
										createdAt: "2026-01-01T00:00:00Z",
									},
								},
							],
							endCursor: null,
						},
					],
				}),
				clock: fakeClock().watch,
				emit() {},
			},
			contexts: one(context(1)),
			mode: "single",
			statusOnly: false,
			options: options(),
		});
		expect(verdict).toMatchObject({ kind: "BLOCKER", exitCode: 3 });
	});

	it("blocks on every conflict signal with exit code 2", async () => {
		for (const over of [
			{ mergeable: "CONFLICTING" as const },
			{ mergeStateStatus: "DIRTY" as const },
			{ mergeStateStatus: "CONFLICTING" as const },
		])
			expect(classifyPr(openRow(1, { facts: over }))).toMatchObject({
				kind: "blocker",
				blocker: { kind: "merge-conflicts" },
			});
		const verdict = await runSimple({
			dependencies: {
				reader: fakeReader({ facts: { mergeable: "CONFLICTING" } }),
				clock: fakeClock().watch,
				emit() {},
			},
			contexts: one(context(1)),
			mode: "single",
			statusOnly: false,
			options: options(),
		});
		expect(verdict).toMatchObject({ kind: "BLOCKER", exitCode: 2 });
	});

	it("blocks on failing and GitHub-rejected checks with exit code 4", async () => {
		expect(classifyPr(openRow(1, { ci: failingCi() }))).toMatchObject({
			kind: "blocker",
			blocker: { kind: "failing-checks" },
		});
		for (const ci of [failingCi(), rejectedCi()]) {
			const verdict = await runSimple({
				dependencies: {
					reader: fakeReader({
						fastPath: { kind: "checks", checks: [failedCheck()] },
						commitRollups: [{ oid: "head", state: ci.kind === "ci-failing" ? "FAILURE" : "ERROR" }],
						facts: { mergeStateStatus: "BLOCKED" },
					}),
					clock: fakeClock().watch,
					emit() {},
				},
				contexts: one(context(1)),
				mode: "single",
				statusOnly: false,
				options: options(),
			});
			expect(verdict).toMatchObject({ kind: "BLOCKER", exitCode: 4 });
		}
	});

	it("lets an allowed draft contribute and keeps a pending draft waiting", () => {
		const draft = openRow(1, { facts: { isDraft: true } });
		expect(classifyPr(draft)).toMatchObject({
			kind: "blocker",
			blocker: { kind: "merge-gate", reason: "draft-pr" },
		});
		expect(classifyPr(draft, true)).toMatchObject({
			kind: "ready",
			pr: { proof: { gate: { draft: "draft-allowed" } } },
		});
		expect(classifyPr(openRow(1, { facts: { isDraft: true }, ci: pendingCi() })).kind).toBe("waiting");
	});

	it("blocks a changes-requested review that otherwise looks clean", () => {
		expect(classifyPr(openRow(1, { facts: { reviewDecision: "CHANGES_REQUESTED" } }))).toMatchObject({
			kind: "blocker",
			blocker: { kind: "merge-gate", reason: "changes-requested" },
		});
	});

	it("returns merged directives and a clear stack in order", () => {
		expect(classifyPr(mergedRow(1))).toMatchObject({ kind: "merged", pr: { kind: "merged-pr" } });
		expect(selectTierMajorStackDecision(one(closedRow(2)))).toMatchObject({
			kind: "blocker",
			blocker: { kind: "merge-gate", reason: "closed-without-merge" },
		});
		expect(selectTierMajorStackDecision([openRow(10), mergedRow(11)])).toMatchObject({
			kind: "clear",
			prs: [
				{ kind: "ready-pr", context: { number: 10 } },
				{ kind: "merged-pr", context: { number: 11 } },
			],
		});
	});
});

describe("polling failures", () => {
	it("propagates a failure that is not a query error", async () => {
		const reader = {
			...fakeReader(),
			async pullRequest(): Promise<PullRequestFacts> {
				throw new Error("boom");
			},
		} satisfies GitHubReader;
		await expect(
			runSimple({
				dependencies: { reader, clock: fakeClock().watch, emit() {} },
				contexts: one(context(1)),
				mode: "single",
				statusOnly: false,
				options: options(),
			}),
		).rejects.toThrow("boom");
	});

	it("stops at once on a non-retryable failure", async () => {
		const reader = {
			...fakeReader(),
			async pullRequest(): Promise<PullRequestFacts> {
				throw new WatcherQueryError({
					kind: "invalid-context-url",
					retryable: false,
					detail: "not a pull URL",
					rawValue: "https://example.test",
				});
			},
		} satisfies GitHubReader;
		const emitted: ProgressVerdict[] = [];
		const clock = fakeClock();
		const verdict = await runSimple({
			dependencies: { reader, clock: clock.watch, emit: (event) => emitted.push(event) },
			contexts: one(context(1)),
			mode: "single",
			statusOnly: false,
			options: options(),
		});
		expect(verdict).toMatchObject({
			kind: "BLOCKER",
			exitCode: 7,
			blocker: { kind: "status-query", failures: 1, failure: { kind: "invalid-context-url" } },
		});
		expect(emitted).toEqual([]);
		expect(clock.sleeps).toEqual([]);
	});

	it("gives up once the consecutive failure budget is spent", async () => {
		const reader = {
			...fakeReader(),
			async pullRequest(): Promise<PullRequestFacts> {
				throw new WatcherQueryError({
					kind: "command-exit",
					retryable: true,
					code: 1,
					detail: "rate limited",
				});
			},
		} satisfies GitHubReader;
		const emitted: ProgressVerdict[] = [];
		const verdict = await runSimple({
			dependencies: { reader, clock: fakeClock().watch, emit: (event) => emitted.push(event) },
			contexts: one(context(1)),
			mode: "single",
			statusOnly: false,
			options: options({ maxQueryErrors: 2 }),
		});
		expect(verdict).toMatchObject({
			kind: "BLOCKER",
			exitCode: 7,
			blocker: { kind: "status-query", failures: 2 },
		});
		expect(emitted.map((event) => event.kind)).toEqual(["RETRY"]);
	});

	it("measures the deadline from the supplied start time", async () => {
		const clock = fakeClock();
		const verdict = await runSimple({
			dependencies: {
				reader: fakeReader({ fastPath: { kind: "checks", checks: [makePending()] } }),
				clock: clock.watch,
				emit() {},
				startedAt: -100,
			},
			contexts: one(context(1)),
			mode: "single",
			statusOnly: false,
			options: options({ timeout: 10 }),
		});
		expect(verdict).toMatchObject({
			kind: "TIMEOUT",
			exitCode: 5,
			reason: { kind: "pending-checks" },
		});
		expect(clock.sleeps).toEqual([]);
	});
});

describe("simple runner modes", () => {
	it("reports raw rows for status-only without classifying them", async () => {
		const emitted: ProgressVerdict[] = [];
		const verdict = await runSimple({
			dependencies: { reader: fakeReader(), clock: fakeClock().watch, emit: (event) => emitted.push(event) },
			contexts: [context(1), context(2)],
			mode: "single",
			statusOnly: true,
			options: options(),
		});
		expect(verdict).toMatchObject({ kind: "STATUS", exitCode: 0, reason: "status-only" });
		expect(verdict.kind === "STATUS" && verdict.rows).toHaveLength(2);
		expect(emitted).toEqual([]);
	});

	it("emits a poll event and returns the whole stack when every PR is clean", async () => {
		const emitted: ProgressVerdict[] = [];
		const verdict = await runSimple({
			dependencies: { reader: fakeReader(), clock: fakeClock().watch, emit: (event) => emitted.push(event) },
			contexts: [context(20), context(21)],
			mode: "stack",
			statusOnly: false,
			options: options(),
		});
		expect(emitted.map((event) => event.kind)).toEqual(["STATUS"]);
		expect(emitted[0]).toMatchObject({ mode: "stack", reason: "poll" });
		expect(verdict).toMatchObject({
			kind: "READY",
			exitCode: 0,
			scope: { kind: "stack", prs: [{ context: { number: 20 } }, { context: { number: 21 } }] },
		});
	});

	it("rejects queued mode in the simple runner", async () => {
		await expect(
			runSimple({
				dependencies: { reader: fakeReader(), clock: fakeClock().watch, emit() {} },
				contexts: one(context(1)),
				mode: "queued-stack",
				statusOnly: false,
				options: options(),
			}),
		).rejects.toThrow("queued-stack requires status-only in the simple runner");
	});

	it("rejects an empty context list", async () => {
		await expect(
			runSimple({
				dependencies: { reader: fakeReader(), clock: fakeClock().watch, emit() {} },
				contexts: [] as unknown as NonEmpty<PrContext>,
				mode: "single",
				statusOnly: false,
				options: options(),
			}),
		).rejects.toThrow("watch context cannot be empty");
	});
});

describe("queued-stack planning", () => {
	it("plans a whole-stack sweep first and then re-reads only the frontier", () => {
		const queue: NonEmpty<PrContext> = [context(30), context(31)];
		const fresh = createQueueState(queue, 0);
		expect(planQueue(fresh, 0).work).toEqual({ kind: "whole-stack-sweep", remaining: queue });
		const swept: QueueState = {
			...fresh,
			work: null,
			snapshots: new Map([
				[context(30).number, openRow(30)],
				[context(31).number, openRow(31)],
			]),
			nextSweepAt: 300,
		};
		expect(planQueue(swept, 10).work).toEqual({ kind: "frontier-poll", frontier: context(30) });
		expect(planQueue(swept, 300).work?.kind).toBe("whole-stack-sweep");
		const finished: QueueState = {
			...swept,
			snapshots: new Map([
				[context(30).number, mergedRow(30)],
				[context(31).number, mergedRow(31)],
			]),
		};
		expect(planQueue(finished, 10).work).toBeNull();
	});

	it("refuses a snapshot when no read is in flight", () => {
		const state: QueueState = { ...createQueueState(one(context(1)), 0), work: null };
		expect(() => applyQueueSnapshot(state, openRow(1), 0, options())).toThrow("queue has no read in flight");
	});

	it("refuses a snapshot that is not the sweep head", () => {
		const state: QueueState = {
			...createQueueState([context(1), context(2)], 0),
			work: { kind: "whole-stack-sweep", remaining: one(context(2)) },
		};
		expect(() => applyQueueSnapshot(state, openRow(1), 0, options())).toThrow("snapshot does not match sweep head");
	});

	it("refuses to finish a sweep that never read every PR", () => {
		const state: QueueState = {
			...createQueueState([context(1), context(2)], 0),
			work: { kind: "whole-stack-sweep", remaining: one(context(2)) },
		};
		expect(() => applyQueueSnapshot(state, openRow(2), 0, options())).toThrow(
			"sweep completed without every snapshot",
		);
	});

	it("returns the queue to idle after a frontier poll", () => {
		const state: QueueState = {
			...createQueueState(one(context(1)), 0),
			work: { kind: "frontier-poll", frontier: context(1) },
		};
		const applied = applyQueueSnapshot(state, openRow(1), 5, options());
		expect(applied.completedSweepRows).toBeNull();
		expect(applied.state.work).toBeNull();
		expect(applied.state.snapshots.size).toBe(1);
	});

	it("completes once every queued PR has merged", () => {
		const state: QueueState = {
			...createQueueState([context(1), context(2)], 0),
			work: null,
			snapshots: new Map([
				[context(1).number, mergedRow(1)],
				[context(2).number, mergedRow(2)],
			]),
		};
		expect(evaluateQueue(state, 0, options())).toMatchObject({
			kind: "complete",
			merged: [
				{ kind: "merged-pr", context: { number: 1 } },
				{ kind: "merged-pr", context: { number: 2 } },
			],
		});
	});

	it("refuses to complete a queue that never produced a snapshot", () => {
		expect(() => evaluateQueue(createQueueState(one(context(1)), 0), 0, options())).toThrow(
			"empty queue cannot complete",
		);
	});

	it("reports a blocker from the swept snapshots", () => {
		const state: QueueState = {
			...createQueueState(one(context(1)), 0),
			work: null,
			snapshots: new Map([[context(1).number, openRow(1, { ci: failingCi() })]]),
		};
		expect(evaluateQueue(state, 0, options())).toMatchObject({
			kind: "blocker",
			blocker: { kind: "failing-checks" },
		});
	});

	it("reports a merge-queue wait once for a clean frontier", () => {
		const state: QueueState = {
			...createQueueState([context(1), context(2)], 0),
			work: null,
			snapshots: new Map([
				[context(1).number, openRow(1)],
				[context(2).number, mergedRow(2)],
			]),
		};
		const first = evaluateQueue(state, 0, options());
		expect(first).toMatchObject({
			kind: "waiting",
			frontier: { number: 1 },
			reason: { kind: "merge-queue", unmergedCount: 1 },
			emit: true,
		});
		expect(evaluateQueue(first.state, 10, options())).toMatchObject({ kind: "waiting", emit: false });
	});
});

describe("queued runner", () => {
	it("completes a queue whose PRs are already merged", async () => {
		const verdict = await runQueued({
			dependencies: {
				reader: fakeReader({ facts: { state: "MERGED", mergedAt: "2026-01-01T00:00:00Z" } }),
				clock: fakeClock().watch,
				emit() {},
			},
			contexts: one(context(1)),
			options: options(),
		});
		expect(verdict).toMatchObject({
			kind: "COMPLETE",
			exitCode: 0,
			merged: [{ kind: "merged-pr", context: { number: 1 } }],
		});
	});

	it("stops the queue on a review-thread blocker", async () => {
		const verdict = await runQueued({
			dependencies: {
				reader: fakeReader({
					threadPages: [
						{
							threads: [
								{
									id: "run-1",
									resolved: false,
									firstComment: {
										authorLogin: "bugbot",
										body: "RUN_ID: run-1",
										path: null,
										line: null,
										createdAt: "2026-01-01T00:00:00Z",
									},
								},
							],
							endCursor: null,
						},
					],
				}),
				clock: fakeClock().watch,
				emit() {},
			},
			contexts: one(context(1)),
			options: options(),
		});
		expect(verdict).toMatchObject({ kind: "BLOCKER", exitCode: 3 });
	});

	it("does not re-emit an unchanged queued wait", async () => {
		const emitted: ProgressVerdict[] = [];
		let sleeps = 0;
		const running = runQueued({
			dependencies: {
				reader: fakeReader({ fastPath: { kind: "checks", checks: [makePending()] } }),
				clock: {
					now: () => sleeps * 60,
					observedAt: () => "2026-01-01T00:00:00.000Z",
					async sleep() {
						sleeps += 1;
						if (sleeps === 2) throw new Error("stop after dedupe proof");
					},
				},
				emit: (event) => emitted.push(event),
			},
			contexts: one(context(1)),
			options: options(),
		});
		await expect(running).rejects.toThrow("stop after dedupe proof");
		expect(emitted.map((event) => event.kind)).toEqual(["QUEUE", "STATUS", "WAITING"]);
	});
});
