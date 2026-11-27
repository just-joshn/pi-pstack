import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeReader } from "../src/skills/poteto-mode/scripts/watch-pr/fakes.test-helper.ts";
import {
	buildReviewThreads,
	ChecksUnavailable,
	discoverStack,
	GhGitHubReader,
	mapRollupNode,
	orderStack,
	parseFastCheck,
	parsePullRequest,
	parseReviewThreadPage,
	resolveChecks,
	resolveContext,
	resolveReviewThreads,
	WatcherQueryError,
} from "../src/skills/poteto-mode/scripts/watch-pr/github.ts";
import type {
	PrContext,
	ReviewComment,
	ReviewThread,
	ReviewThreadPage,
	RollupPage,
} from "../src/skills/poteto-mode/scripts/watch-pr/types.ts";
import { parsePrNumber } from "../src/skills/poteto-mode/scripts/watch-pr/types.ts";

const context: PrContext = { owner: "owner", repo: "repo", number: parsePrNumber(42) };

interface FixtureResponse {
	readonly code?: number;
	readonly stdout?: string;
	readonly stderr?: string;
	readonly hang?: boolean;
}
interface FixtureEntry {
	readonly match: string;
	readonly responses: readonly FixtureResponse[];
}
interface FixtureCall {
	readonly match: string | null;
	readonly argv: string;
}
interface Fixture {
	readonly calls: () => readonly FixtureCall[];
}

function callArgv(fixture: Fixture, index: number): string {
	const call = fixture.calls()[index];
	if (call === undefined) throw new Error(`fixture has no gh call at index ${index}`);
	return call.argv;
}

// Node runs this file when `gh`/`git` is the symlinked runtime and the first
// argument names a sibling script, so `gh pr view` lands here as `view`.
const HANDLER = `const fs = require("node:fs");
const path = require("node:path");
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures.json"), "utf8"));
const argv = process.argv.slice(2).join(" ");
const entry = config.entries.find((candidate) => argv.includes(candidate.match));
const logPath = path.join(__dirname, "calls.log");
const log = fs.existsSync(logPath)
	? fs.readFileSync(logPath, "utf8").split("\\n").filter(Boolean).map((line) => JSON.parse(line))
	: [];
if (entry === undefined) {
	fs.appendFileSync(logPath, JSON.stringify({ match: null, argv }) + "\\n");
	process.stderr.write("watch-pr fixture has no match for: " + argv.slice(0, 120) + "\\n");
	process.exitCode = 99;
} else {
	fs.appendFileSync(logPath, JSON.stringify({ match: entry.match, argv }) + "\\n");
	const seen = log.filter((call) => call.match === entry.match).length;
	const responses = entry.responses.length > 0 ? entry.responses : [{ code: 0, stdout: "" }];
	const response = responses[Math.min(seen, responses.length - 1)];
	if (response.hang === true) setTimeout(() => {}, 30_000);
	else {
		process.stdout.write(response.stdout ?? "");
		process.stderr.write(response.stderr ?? "");
		process.exitCode = response.code ?? 0;
	}
}
`;

const installed: (() => void)[] = [];
afterEach(() => {
	for (const restore of installed.splice(0)) restore();
});

function installFixture(entries: readonly FixtureEntry[]): Fixture {
	const directory = mkdtempSync(join(tmpdir(), "watch-pr-reader-"));
	writeFileSync(join(directory, "fixtures.json"), JSON.stringify({ entries }));
	for (const script of ["pr", "api", "remote"]) writeFileSync(join(directory, script), HANDLER);
	for (const command of ["gh", "git"]) {
		const target = join(directory, process.platform === "win32" ? `${command}.exe` : command);
		if (process.platform === "win32") copyFileSync(process.execPath, target);
		else symlinkSync(process.execPath, target);
	}
	const previousPath = process.env.PATH;
	const previousCwd = process.cwd();
	process.env.PATH = `${directory}${delimiter}${previousPath ?? ""}`;
	process.chdir(directory);
	installed.push(() => {
		process.chdir(previousCwd);
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		rmSync(directory, { recursive: true, force: true });
	});
	return {
		calls() {
			const logPath = join(directory, "calls.log");
			if (!existsSync(logPath)) return [];
			return readFileSync(logPath, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as FixtureCall);
		},
	};
}

describe("gh reader queries", () => {
	it("normalizes GitHub remotes and rejects ones it cannot attribute", async () => {
		const fixture = installFixture([
			{
				match: "get-url origin",
				responses: [
					{ stdout: "git@github.com:owner/repo.git\n" },
					{ stdout: "ssh://git@github.com/owner/repo\n" },
					{ stdout: "  https://github.com/owner/repo.git  \n" },
					{ stdout: "https://github.com/owner/repo/tree/main\n" },
					{ stdout: "https://gitlab.com/owner/repo.git\n" },
					{ stdout: "https://github.com:8443/owner/repo.git\n" },
					{ stdout: "https://token@github.com/owner/repo.git\n" },
					{ stdout: "https://github.com/owner/repo.git?ref=main\n" },
					{ stdout: "https://github.com/owner/repo.git#readme\n" },
					{ stdout: "not a url\n" },
					{ code: 1, stderr: "fatal: no such remote 'origin'\n" },
				],
			},
		]);
		const reader = new GhGitHubReader();
		expect(await reader.originRepo()).toEqual({ owner: "owner", repo: "repo" });
		expect(await reader.originRepo()).toEqual({ owner: "owner", repo: "repo" });
		expect(await reader.originRepo()).toEqual({ owner: "owner", repo: "repo" });
		for (let attempt = 0; attempt < 7; attempt += 1) expect(await reader.originRepo()).toBeNull();
		expect(fixture.calls()).toHaveLength(10);
		expect(fixture.calls().every((call) => call.argv === "get-url origin")).toBe(true);
	});

	it("reads the PR number from the argument and the repository from the PR URL", async () => {
		const fixture = installFixture([
			{
				match: "view 42 --json",
				responses: [{ stdout: JSON.stringify({ number: 7, url: "https://github.com/owner/repo/pull/42" }) }],
			},
			{
				match: "view --json",
				responses: [{ stdout: JSON.stringify({ number: 7, url: "https://github.com/owner/repo/pull/7" }) }],
			},
			{
				match: "view 43",
				responses: [{ stdout: JSON.stringify({ number: 43, url: "https://github.com/owner/repo/issues/43" }) }],
			},
		]);
		const reader = new GhGitHubReader();
		expect(await reader.currentPr(parsePrNumber(42))).toEqual({ owner: "owner", repo: "repo", number: 42 });
		expect(await reader.currentPr(null)).toEqual({ owner: "owner", repo: "repo", number: 7 });
		const failure = await reader.currentPr(parsePrNumber(43)).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(WatcherQueryError);
		expect((failure as WatcherQueryError).failure).toMatchObject({
			kind: "invalid-context-url",
			retryable: false,
			rawValue: "https://github.com/owner/repo/issues/43",
		});
		expect(callArgv(fixture, 0)).toBe("view 42 --json number,url");
		expect(callArgv(fixture, 1)).toBe("view --json number,url");
	});

	it("requests every merge field explicitly and reports the first stderr line on failure", async () => {
		const payload = {
			mergeable: "MERGEABLE",
			mergeStateStatus: "CLEAN",
			reviewDecision: "APPROVED",
			headRefOid: "head",
			headRefName: "feature",
			baseRefName: "main",
			state: "OPEN",
			mergedAt: null,
			isDraft: false,
		};
		const fixture = installFixture([
			{
				match: "view 42 --repo",
				responses: [
					{ stdout: JSON.stringify(payload) },
					{ code: 1, stderr: "gh: Not Found (HTTP 404)\nsecond line that must not leak\n" },
					{ code: 128, stderr: `${"x".repeat(400)}\n` },
					{ code: 3, stderr: "" },
				],
			},
		]);
		const reader = new GhGitHubReader();
		expect(await reader.pullRequest(context)).toEqual({ context, ...payload });
		expect(callArgv(fixture, 0)).toContain(
			"--json mergeable,mergeStateStatus,reviewDecision,headRefOid,headRefName,baseRefName,state,mergedAt,isDraft",
		);
		expect(callArgv(fixture, 0)).toContain("--repo owner/repo");
		const notFound = await reader.pullRequest(context).catch((error: unknown) => error);
		expect((notFound as WatcherQueryError).failure).toMatchObject({
			kind: "command-exit",
			retryable: true,
			code: 1,
			detail: "gh: Not Found (HTTP 404)",
		});
		const long = await reader.pullRequest(context).catch((error: unknown) => error);
		expect((long as WatcherQueryError).failure).toMatchObject({ detail: "x".repeat(240) });
		const bare = await reader.pullRequest(context).catch((error: unknown) => error);
		expect((bare as WatcherQueryError).failure).toMatchObject({
			detail:
				"gh pr view 42 --repo owner/repo --json mergeable,mergeStateStatus,reviewDecision,headRefOid,headRefName,baseRefName,state,mergedAt,isDraft exited 3",
		});
	});

	it("parses open PRs and fails closed on incomplete fork identity", async () => {
		installFixture([
			{
				match: "list --repo",
				responses: [
					{
						stdout: JSON.stringify([
							{ number: 41, headRefName: "base", baseRefName: "main", isCrossRepository: false },
						]),
					},
					{ stdout: JSON.stringify([{ number: 41, headRefName: "base", baseRefName: "main" }]) },
					{ stdout: "{}" },
				],
			},
		]);
		const reader = new GhGitHubReader();
		expect(await reader.openPullRequests({ owner: "owner", repo: "repo" })).toEqual([
			{ number: 41, headRefName: "base", baseRefName: "main", isCrossRepository: false },
		]);
		await expect(reader.openPullRequests({ owner: "owner", repo: "repo" })).rejects.toMatchObject({
			failure: { kind: "missing-key", detail: "missing open PRs[0].isCrossRepository" },
		});
		await expect(reader.openPullRequests({ owner: "owner", repo: "repo" })).rejects.toMatchObject({
			failure: { kind: "missing-key", rawValue: "{}" },
		});
	});

	it("treats partial, empty, malformed and unexpected check output as unusable", async () => {
		const fast = (name: string, state: string, bucket: string) => ({ name, state, bucket });
		const fixture = installFixture([
			{
				match: "checks 42 --repo",
				responses: [
					{
						stdout: JSON.stringify([
							{ ...fast("fast", "SUCCESS", "pass"), description: "ok", link: "https://ci/1", workflow: "CI" },
							{ ...fast("Code Review Gate", "ACTION_REQUIRED", "fail"), description: "1 of 2 policies" },
						]),
					},
					{ code: 8, stdout: JSON.stringify([fast("partial", "PENDING", "pending")]) },
					{ code: 1, stdout: JSON.stringify([fast("red", "FAILURE", "fail")]) },
					{ code: 0, stdout: "", stderr: "no checks reported on the 'feature' branch" },
					{ code: 0, stdout: "{}" },
					{ code: 0, stdout: "this is not json" },
					{ code: 2, stderr: "boom" },
				],
			},
		]);
		const reader = new GhGitHubReader();
		const settled = await reader.checksFastPath(context);
		expect(settled).toEqual({
			kind: "checks",
			checks: [
				{
					kind: "passed",
					name: "fast",
					reportedState: "SUCCESS",
					description: "ok",
					link: "https://ci/1",
					workflow: "CI",
				},
				{
					kind: "code-review-gate",
					name: "Code Review Gate",
					reportedState: "ACTION_REQUIRED",
					description: "1 of 2 policies",
					link: "",
					workflow: "",
				},
			],
		});
		expect(await reader.checksFastPath(context)).toMatchObject({ kind: "checks", checks: [{ kind: "pending" }] });
		expect(await reader.checksFastPath(context)).toMatchObject({ kind: "checks", checks: [{ kind: "failed" }] });
		expect(await reader.checksFastPath(context)).toEqual({
			kind: "unusable",
			exitCode: 0,
			stderr: "no checks reported on the 'feature' branch",
		});
		expect(await reader.checksFastPath(context)).toMatchObject({ kind: "unusable", exitCode: 0 });
		expect(await reader.checksFastPath(context)).toMatchObject({ kind: "unusable", exitCode: 0 });
		expect(await reader.checksFastPath(context)).toMatchObject({ kind: "unusable", exitCode: 2, stderr: "boom" });
		expect(callArgv(fixture, 0)).toBe(
			"checks 42 --repo owner/repo --json name,state,description,link,workflow,bucket",
		);
	});

	it("walks the check rollup pages and refuses to loop without a cursor", async () => {
		const rollup = (nodes: readonly unknown[], pageInfo: unknown) =>
			JSON.stringify({
				data: {
					repository: {
						pullRequest: {
							commits: {
								nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo, nodes } } } }],
							},
						},
					},
				},
			});
		const fixture = installFixture([
			{
				match: "PrCheckRollup",
				responses: [
					{
						stdout: rollup(
							[
								{
									__typename: "CheckRun",
									name: "build",
									status: "COMPLETED",
									conclusion: "SUCCESS",
									detailsUrl: "https://ci/build",
									targetUrl: "https://ci/build?attempt=2",
								},
								{ __typename: "StatusContext", context: "lint", state: "FAILURE" },
								{ __typename: "Deployment" },
							],
							{ hasNextPage: true, endCursor: "cursor-1" },
						),
					},
					{
						stdout: rollup([{ __typename: "CheckRun", name: "docs", status: "IN_PROGRESS", conclusion: null }], {
							hasNextPage: false,
							endCursor: "ignored",
						}),
					},
					{ stdout: JSON.stringify({ data: { repository: { pullRequest: { commits: { nodes: [] } } } } }) },
					{
						stdout: JSON.stringify({
							data: {
								repository: {
									pullRequest: { commits: { nodes: [{ commit: { statusCheckRollup: null } }] } },
								},
							},
						}),
					},
					{
						stdout: rollup([{ __typename: "CheckRun", name: "x", status: "QUEUED" }], {
							hasNextPage: true,
							endCursor: null,
						}),
					},
					{ stdout: rollup([], { hasNextPage: "yes", endCursor: null }) },
				],
			},
		]);
		const reader = new GhGitHubReader();
		const first: RollupPage = await reader.checkRollupPage(context, null);
		expect(first.checks.map((check) => [check.name, check.kind])).toEqual([
			["build", "passed"],
			["lint", "failed"],
		]);
		expect(first.checks[0]?.link).toBe("https://ci/build?attempt=2");
		expect(first.endCursor).toBe("cursor-1");
		expect(callArgv(fixture, 0)).not.toContain("after=");
		const second = await reader.checkRollupPage(context, first.endCursor);
		expect(second).toMatchObject({ checks: [{ kind: "pending" }], endCursor: null });
		expect(callArgv(fixture, 1)).toContain("after=cursor-1");
		expect(await reader.checkRollupPage(context, null)).toEqual({ checks: [], endCursor: null });
		expect(await reader.checkRollupPage(context, null)).toEqual({ checks: [], endCursor: null });
		expect(await reader.checkRollupPage(context, null)).toMatchObject({ checks: [{ kind: "pending" }] });
		await expect(reader.checkRollupPage(context, null)).rejects.toMatchObject({
			failure: { kind: "missing-key", detail: 'invalid contexts.pageInfo.hasNextPage: "yes"' },
		});
	});

	it("pages review threads and carries the cursor into the next query", async () => {
		const page = (nodes: readonly unknown[], pageInfo: unknown) =>
			JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo, nodes } } } } });
		const thread = (id: string, body: string) => ({
			id,
			isResolved: false,
			comments: {
				nodes: [
					{ body, createdAt: "2026-01-01T00:00:00Z", path: "src/a.ts", line: 12, author: { login: "bugbot" } },
				],
			},
		});
		const fixture = installFixture([
			{
				match: "ReviewThreads",
				responses: [
					{ stdout: page([thread("one", "RUN_ID: run-1 finding")], { hasNextPage: true, endCursor: "t1" }) },
					{ stdout: page([thread("two", "RUN_ID: run-2 finding")], { hasNextPage: false, endCursor: null }) },
				],
			},
		]);
		const threads = await resolveReviewThreads(new GhGitHubReader(), context);
		expect(threads.map((item) => item.id)).toEqual(["one", "two"]);
		expect(threads.map((item) => item.bugbotReviewPasses)).toEqual([2, 2]);
		expect(callArgv(fixture, 0)).not.toContain("after=");
		expect(callArgv(fixture, 1)).toContain("after=t1");
	});

	it("reads commit rollup states and rejects an unknown state", async () => {
		const rollups = (nodes: readonly unknown[]) =>
			JSON.stringify({ data: { repository: { pullRequest: { commits: { nodes } } } } });
		installFixture([
			{
				match: "PrCommitStatuses",
				responses: [
					{
						stdout: rollups([
							{ commit: { oid: "old", statusCheckRollup: { state: "SUCCESS" } } },
							{ commit: { oid: "head", statusCheckRollup: null } },
						]),
					},
					{ stdout: rollups([{ commit: { oid: "head", statusCheckRollup: { state: "FUTURE" } } }]) },
				],
			},
		]);
		const reader = new GhGitHubReader();
		expect(await reader.commitRollups(context)).toEqual([
			{ oid: "old", state: "SUCCESS" },
			{ oid: "head", state: null },
		]);
		await expect(reader.commitRollups(context)).rejects.toMatchObject({
			failure: { kind: "missing-key", rawValue: '"FUTURE"' },
		});
	});

	it("does not spawn a query once the deadline has already passed", async () => {
		const controller = new AbortController();
		controller.abort(new Error("watch deadline expired"));
		const reader = new GhGitHubReader(controller.signal);
		// No fixture is installed, so a spawn attempt would surface as ENOENT.
		await expect(reader.originRepo()).rejects.toThrow("watch deadline expired");
	});

	it("kills an in-flight query when the deadline aborts it", async () => {
		installFixture([{ match: "get-url origin", responses: [{ hang: true }] }]);
		const controller = new AbortController();
		const reader = new GhGitHubReader(controller.signal);
		const pending = reader.originRepo();
		await new Promise((resolve) => setTimeout(resolve, 200));
		controller.abort(new Error("watch deadline expired"));
		await expect(pending).rejects.toThrow("watch deadline expired");
	});
});

describe("check mapping", () => {
	it("lets a failing state outrank a passing bucket", () => {
		expect(parseFastCheck({ name: "ci", state: "FAILURE", bucket: "pass" })).toMatchObject({ kind: "failed" });
		expect(parseFastCheck({ name: "ci", state: "ERROR", bucket: "skipping" })).toMatchObject({ kind: "failed" });
		expect(parseFastCheck({ name: "ci", state: "SUCCESS", bucket: "skipping" })).toMatchObject({
			kind: "skipped",
			reportedState: "SUCCESS",
		});
		expect(parseFastCheck({ name: "ci", state: "PENDING", bucket: "pending" })).toMatchObject({ kind: "pending" });
		expect(parseFastCheck({ name: "ci", state: "SUCCESS", bucket: "unknown-bucket" })).toMatchObject({
			kind: "failed",
			reportedState: "SUCCESS",
		});
	});

	it("fails closed on a check without a name", () => {
		expect(() => parseFastCheck({ state: "SUCCESS", bucket: "pass" })).toThrow(WatcherQueryError);
		expect(() => parseFastCheck("not an object")).toThrow(WatcherQueryError);
	});

	it("prefers the rollup target URL and falls back to the details URL", () => {
		expect(
			mapRollupNode({ __typename: "StatusContext", context: "ci", state: "SUCCESS", targetUrl: "https://ci/run" }),
		).toMatchObject({ kind: "passed", link: "https://ci/run" });
		expect(
			mapRollupNode({
				__typename: "CheckRun",
				name: "ci",
				status: "COMPLETED",
				conclusion: "SUCCESS",
				detailsUrl: "https://ci/a",
			}),
		).toMatchObject({ kind: "passed", link: "https://ci/a" });
	});

	it("treats a missing status or conclusion as unfinished work", () => {
		expect(mapRollupNode({ __typename: "CheckRun", name: "ci" })).toMatchObject({
			kind: "pending",
			reportedState: "PENDING",
		});
		expect(mapRollupNode({ __typename: "CheckRun", name: "ci", status: "COMPLETED" })).toMatchObject({
			kind: "failed",
			reportedState: "FAILURE",
		});
		expect(mapRollupNode({ __typename: "StatusContext", context: "ci" })).toMatchObject({
			kind: "failed",
			reportedState: "FAILURE",
		});
		expect(mapRollupNode({ __typename: "StatusContext", context: "ci", state: "FAILURE" })).toMatchObject({
			kind: "failed",
			reportedState: "FAILURE",
		});
	});

	it("rejects a rollup node that is not an object", () => {
		expect(() => mapRollupNode(null)).toThrow(WatcherQueryError);
	});
});

describe("pull request parsing", () => {
	const payload = {
		mergeable: "MERGEABLE",
		mergeStateStatus: "CLEAN",
		reviewDecision: "APPROVED",
		headRefOid: "head",
		headRefName: "feature",
		baseRefName: "main",
		state: "OPEN",
		mergedAt: null,
		isDraft: false,
	};

	it("keeps the mergeable and merge-state vocabularies closed but complete", () => {
		expect(parsePullRequest({ ...payload, mergeable: "CONFLICTING" }, context).mergeable).toBe("CONFLICTING");
		expect(parsePullRequest({ ...payload, mergeable: "UNKNOWN" }, context).mergeable).toBe("UNKNOWN");
		for (const mergeStateStatus of ["BEHIND", "DIRTY", "DRAFT", "HAS_HOOKS", "UNKNOWN", "UNSTABLE"]) {
			expect(parsePullRequest({ ...payload, mergeStateStatus }, context).mergeStateStatus).toBe(mergeStateStatus);
		}
	});

	it("keeps absent head and merge timestamps as null", () => {
		const facts = parsePullRequest(
			{ ...payload, mergeStateStatus: "DIRTY", headRefOid: null, mergedAt: "2026-01-01T00:00:00Z" },
			context,
		);
		expect(facts).toMatchObject({ headRefOid: null, mergedAt: "2026-01-01T00:00:00Z" });
	});

	it("requires a boolean draft flag", () => {
		const { isDraft: _isDraft, ...withoutDraft } = payload;
		expect(() => parsePullRequest(withoutDraft, context)).toThrow(WatcherQueryError);
	});
});

describe("review thread parsing", () => {
	const response = (nodes: readonly unknown[], pageInfo: unknown = { hasNextPage: false, endCursor: null }) =>
		JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo, nodes } } } } });
	const comment = (over: Record<string, unknown> = {}) => ({
		body: "please fix",
		createdAt: "2026-01-01T00:00:00Z",
		path: "src/a.ts",
		line: 12,
		author: { login: "someone" },
		...over,
	});
	const threadNode = (id: string, comments: readonly unknown[], isResolved = false) => ({
		id,
		isResolved,
		comments: { nodes: comments },
	});

	it("keeps an unresolved thread without comments and counts no review pass", () => {
		const page: ReviewThreadPage = parseReviewThreadPage(JSON.parse(response([threadNode("empty", [])])));
		expect(page.threads).toEqual([{ id: "empty", firstComment: null, resolved: false }]);
		expect(buildReviewThreads(page.threads)).toEqual([
			{ id: "empty", firstComment: null, isBugbot: false, bugbotReviewPasses: 0 },
		]);
	});

	it("reads anonymous comments and nullable line, path and author fields", () => {
		const page = parseReviewThreadPage(
			JSON.parse(response([threadNode("anon", [comment({ author: null, path: null, line: null })])])),
		);
		expect(page.threads[0]?.firstComment).toMatchObject({
			authorLogin: null,
			path: null,
			line: null,
		});
		const loginless = parseReviewThreadPage(
			JSON.parse(response([threadNode("loginless", [comment({ author: { login: null } })])])),
		);
		expect(loginless.threads[0]?.firstComment?.authorLogin).toBeNull();
	});

	it("rejects a fractional line number and a missing resolved flag", () => {
		expect(() => parseReviewThreadPage(JSON.parse(response([threadNode("x", [comment({ line: 1.5 })])])))).toThrow(
			WatcherQueryError,
		);
		expect(() => parseReviewThreadPage(JSON.parse(response([{ id: "x", comments: { nodes: [] } }])))).toThrow(
			WatcherQueryError,
		);
	});

	it("stops paging when hasNextPage is false or the cursor is missing", () => {
		expect(
			parseReviewThreadPage(JSON.parse(response([], { hasNextPage: false, endCursor: "stale" }))).endCursor,
		).toBeNull();
		expect(
			parseReviewThreadPage(JSON.parse(response([], { hasNextPage: true, endCursor: null }))).endCursor,
		).toBeNull();
		expect(parseReviewThreadPage(JSON.parse(response([], { hasNextPage: true, endCursor: "next" }))).endCursor).toBe(
			"next",
		);
	});

	it("counts distinct review passes across bugbot authors and drops resolved threads", () => {
		const bugbot = (login: string, body: string): ReviewComment => ({
			authorLogin: login,
			body,
			path: null,
			line: null,
			createdAt: "2026-01-01T00:00:00Z",
		});
		const threads: readonly ReviewThread[] = buildReviewThreads([
			{ id: "run-1", firstComment: bugbot("Bugbot", "RUN_ID: run-1"), resolved: false },
			{ id: "run-1-duplicate", firstComment: bugbot("bugbot", "RUN_ID: run-1"), resolved: false },
			{ id: "run-2", firstComment: bugbot("cursor", "CURSOR_AUTOMATION_ID: run-2"), resolved: false },
			{
				id: "security",
				firstComment: bugbot("cursor", "Agentic security review: severity high"),
				resolved: false,
			},
			{ id: "resolved", firstComment: bugbot("bugbot", "RUN_ID: run-9"), resolved: true },
			{ id: "human", firstComment: bugbot("octocat", "please add a test"), resolved: false },
		]);
		expect(threads.map((item) => item.id)).toEqual(["run-1", "run-1-duplicate", "run-2", "security", "human"]);
		expect(threads.map((item) => item.isBugbot)).toEqual([true, true, true, true, false]);
		expect(threads.map((item) => item.bugbotReviewPasses)).toEqual([3, 3, 3, 3, 3]);
	});

	it("counts one pass for keyless bugbot threads and none without bugbot", () => {
		const keyless = buildReviewThreads([
			{
				id: "keyless",
				firstComment: {
					authorLogin: "bugbot",
					body: "no run identifier",
					path: null,
					line: null,
					createdAt: "2026-01-01T00:00:00Z",
				},
				resolved: false,
			},
		]);
		expect(keyless[0]?.bugbotReviewPasses).toBe(1);
		const nothing = buildReviewThreads([
			{
				id: "human",
				firstComment: {
					authorLogin: "octocat",
					body: "RUN_ID: run-1",
					path: null,
					line: null,
					createdAt: "2026-01-01T00:00:00Z",
				},
				resolved: false,
			},
		]);
		expect(nothing[0]).toMatchObject({ isBugbot: false, bugbotReviewPasses: 0 });
	});
});

describe("checks and context resolution", () => {
	it("names the fast-path exit code and the empty rollup in the failure detail", async () => {
		const reader = fakeReader({
			fastPath: { kind: "unusable", exitCode: 8, stderr: "gh: credential cannot read checks\nignored\n" },
		});
		const failure = await resolveChecks(reader, context).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(ChecksUnavailable);
		expect((failure as ChecksUnavailable).failure).toMatchObject({
			kind: "checks-unavailable",
			retryable: true,
			detail:
				"could not read PR checks: fast path exit=8; GraphQL rollup was empty; gh: credential cannot read checks",
		});
	});

	it("reports an empty fast path and empty rollup without an exit code", async () => {
		const reader = fakeReader({ fastPath: { kind: "checks", checks: [] } });
		const failure = await resolveChecks(reader, context).catch((error: unknown) => error);
		expect((failure as ChecksUnavailable).failure).toMatchObject({
			detail: "could not read PR checks: fast path and GraphQL rollup were empty",
		});
	});

	it("fills a missing repository from the PR URL", async () => {
		const reader = fakeReader({
			origin: null,
			current: { owner: "inferred", repo: "inferred-repo", number: parsePrNumber(7) },
		});
		expect(await resolveContext({ reader, owner: "explicit", repo: null, pr: parsePrNumber(42) })).toEqual({
			owner: "explicit",
			repo: "inferred-repo",
			number: 42,
		});
		expect(reader.calls).toEqual(["originRepo", "currentPr"]);
	});

	it("infers every part of the context when only the PR number is missing", async () => {
		const reader = fakeReader({
			current: { owner: "inferred", repo: "inferred-repo", number: parsePrNumber(7) },
		});
		expect(await resolveContext({ reader, owner: null, repo: null, pr: null })).toEqual({
			owner: "inferred",
			repo: "inferred-repo",
			number: 7,
		});
		expect(reader.calls).toEqual(["currentPr"]);
	});

	it("prefers an explicit repository over the origin remote", async () => {
		const reader = fakeReader({ origin: { owner: "local", repo: "checkout" } });
		expect(await resolveContext({ reader, owner: null, repo: "explicit", pr: context.number })).toEqual({
			owner: "local",
			repo: "explicit",
			number: 42,
		});
		expect(reader.calls).toEqual(["originRepo"]);
	});

	it("detaches an unconnected PR from the open stack", () => {
		expect(
			orderStack(context, [
				{ number: parsePrNumber(41), headRefName: "base", baseRefName: "main", isCrossRepository: false },
			]),
		).toEqual([context]);
	});

	it("orders several upstack children by number", () => {
		const ordered = orderStack(context, [
			{ number: context.number, headRefName: "feature", baseRefName: "main", isCrossRepository: false },
			{ number: parsePrNumber(45), headRefName: "third", baseRefName: "feature", isCrossRepository: false },
			{ number: parsePrNumber(44), headRefName: "second", baseRefName: "feature", isCrossRepository: false },
		]);
		expect(ordered.map((item) => Number(item.number))).toEqual([42, 44, 45]);
	});

	it("asks the reader for open PRs before ordering the stack", async () => {
		const reader = fakeReader({
			openPullRequests: [
				{ number: context.number, headRefName: "feature", baseRefName: "main", isCrossRepository: false },
				{ number: parsePrNumber(43), headRefName: "upstack", baseRefName: "feature", isCrossRepository: false },
			],
		});
		expect((await discoverStack(reader, context)).map((item) => Number(item.number))).toEqual([42, 43]);
		expect(reader.calls).toEqual(["openPullRequests"]);
	});
});
