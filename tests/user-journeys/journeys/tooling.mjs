import { expect } from "vitest";
import { processExec } from "../../support/pi-host.mjs";

const SLOP_SOURCE = "// NOTE: keep this marker\n\nexport const a = 1;\n";
const SLOP_MARKER = "// NOTE: keep this marker";
const SLOP_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -0,0 +1,2 @@",
  "+// NOTE: keep this marker",
  "+export const a = 1;",
  "",
].join("\n");

const DECISION_HEADER = "ts\tphase\tdecision\twhy\tevidence\tresult";
const CLEAN_DESLOP =
  "pstack_deslop: no common slop patterns in added lines (still run /skill:unslop on prose surfaces).";
const GATE_VIEW_JSON = "number,title,state,mergedAt,mergeStateStatus,statusCheckRollup,reviewDecision,url";
const STACK_VIEW_JSON = "number,state,mergedAt,mergeStateStatus,title,statusCheckRollup,reviewDecision";
const SHIP_VIEW_JSON = "number,title,state,mergedAt,mergeStateStatus,url,statusCheckRollup";
const EMPTY_EXEC = () => ({ code: 0, stdout: "", stderr: "", killed: false });

function textOf(result) {
  return result.content[0].text;
}

async function rejectionText(promise) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error.message;
    return String(error);
  }
  throw new Error("expected the call to be refused");
}

function fixtureGithub(views, extra = {}) {
  const fixtures = { ...extra };
  for (const [pr, view] of Object.entries(views)) {
    const body = JSON.stringify(view);
    fixtures[`pr view ${pr} --json ${GATE_VIEW_JSON}`] = { code: 0, stdout: body };
    fixtures[`pr view ${pr} --json ${STACK_VIEW_JSON}`] = { code: 0, stdout: body };
    fixtures[`pr view ${pr} --json ${SHIP_VIEW_JSON}`] = { code: 0, stdout: body };
    fixtures[`pr view ${pr} --json state,mergedAt,mergeStateStatus,statusCheckRollup,reviewDecision,url,title`] = {
      code: 0,
      stdout: body,
    };
  }
  return fixtures;
}

function cleanPr() {
  return {
    number: 42,
    title: "Clean title",
    state: "OPEN",
    mergedAt: null,
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    statusCheckRollup: [],
    url: "https://example.invalid/pr/42",
  };
}

function dirtyPr() {
  return {
    number: 42,
    state: "CLOSED",
    mergedAt: null,
    mergeStateStatus: "BLOCKED",
    reviewDecision: null,
    statusCheckRollup: [],
  };
}

function merges(user) {
  return user
    .execCalls()
    .filter((call) => call.command === "gh" && call.args[0] === "pr" && call.args[1] === "merge");
}

function assertGateCheckPass(result) {
  const lines = textOf(result).split("\n");
  expect(lines[0]).toBe("gate-check PASS");
  expect(JSON.parse(lines.slice(1).join("\n")).mergeStateStatus).toBe("CLEAN");
}

async function runGreenShip(user) {
  const view = textOf(await user.tool("pstack_ship", { action: "view", pr: "42" }));
  expect(view).toBe(JSON.stringify(cleanPr()));
  assertGateCheckPass(await user.tool("pstack_ship", { action: "gate-check", pr: "42" }));

  const stack = textOf(
    await user.tool("pstack_ship", {
      action: "stack-status",
      stackPrs: ["43", "44"],
    }),
  );
  const stackLines = stack.split("\n");
  expect(stackLines[0]).toBe("stack COMPLETE");
  expect(stackLines.slice(1)).toEqual(["43 state=MERGED mergeStateStatus=CLEAN", "44 state=MERGED mergeStateStatus=CLEAN"]);

  const merged = textOf(await user.tool("pstack_ship", { action: "merge", pr: "42", mergeMethod: "squash" }));
  expect(merged).toBe("Merged PR 42 after gate check (mergeStateStatus=CLEAN).\n");
  expect(merges(user).length).toBe(1);
  expect(merges(user)[0].args).toEqual(["pr", "merge", "42", "--squash"]);
}

async function runBlockedShip(user) {
  const mergesBefore = merges(user).length;
  const expected = "merge gate check failed (fail closed): state=CLOSED; mergeStateStatus=BLOCKED";
  expect(await rejectionText(user.tool("pstack_ship", { action: "gate-check", pr: "42" }))).toBe(expected);
  expect(await rejectionText(user.tool("pstack_ship", { action: "merge", pr: "42" }))).toBe(expected);
  expect(merges(user).length, "a failed gate must never run `gh pr merge`").toBe(mergesBefore);

  expect(await rejectionText(user.tool("pstack_ship", { action: "view", pr: "" }))).toBe("pr required");
  expect(await rejectionText(user.tool("pstack_ship", { action: "gate-check", pr: "" }))).toBe("pr required for gate-check");
  expect(await rejectionText(user.tool("pstack_ship", { action: "merge", pr: "" }))).toBe("pr required for merge");
}

async function runGateCommand(user) {
  await user.command("pstack-gates", "42");
  const messages = user.messages().filter((row) => row.text.startsWith("pstack-gates "));
  expect(messages.length).toBe(1);
  expect(messages[0].text).toBe('pstack-gates PASS for PR 42 (Clean title) https://example.invalid/pr/42. Still run unslop → no-comments → prove-it-works on the real artifact before merge.');
  expect(user.notifications().at(-1)).toEqual(["info", "Gate check PASS for PR 42 (CLEAN)"]);
  expect(user.messages().at(-1).text).toBe(messages[0].text);
}

async function runGateCommandFailed(user) {
  user.installFakeGh(fixtureGithub({ "42": dirtyPr() }));
  await user.command("pstack-gates", "42");
  expect(user.notifications().at(-1)).toEqual([
    "error",
    "Gate check FAILED (fail closed): state=CLOSED; mergeStateStatus=BLOCKED",
  ]);
  expect(user.messages().at(-1).text.startsWith("pstack-gates PASS")).toBe(false);
}

const J10 = {
  id: "ship-guarded-stack",
  title: "a user ships a green stack and a dirty gate refuses to merge",
  critical: true,
  surfaces: ["ship", "gates", "commands"],
  async run(user) {
    const merged = {
      43: { number: 43, state: "MERGED", mergedAt: "2026-01-01T00:00:00Z", mergeStateStatus: "CLEAN" },
      44: { number: 44, state: "MERGED", mergedAt: "2026-01-02T00:00:00Z", mergeStateStatus: "CLEAN" },
    };
    user.installFakeGh(fixtureGithub({ ...merged, "42": cleanPr() }, { "pr merge 42 --squash": { code: 0 } }));
    user.setExec(processExec);
    await runGreenShip(user);
    await runGateCommand(user);
    user.installFakeGh(fixtureGithub({ "42": dirtyPr() }));
    await runBlockedShip(user);
    await runGateCommandFailed(user);
  },
};

function execWithDiff(user) {
  user.setExec((command, args) => {
    if (command === "git" && args[0] === "diff" && args[2] === "main...HEAD") {
      return { code: 0, stdout: SLOP_DIFF, stderr: "", killed: false };
    }
    return EMPTY_EXEC();
  });
}

async function assertDeslopFindings(user) {
  user.write("src/a.ts", SLOP_SOURCE);
  const before = user.read("src/a.ts");
  execWithDiff(user);
  const report = textOf(await user.tool("pstack_deslop", { dryRun: true }));
  expect(report.startsWith("pstack_deslop findings:\n- [high] narration / alibi comment: 1 hit(s) → delete-line (safeDelete)")).toBe(true);
  expect(report.endsWith("dryRun: would remove 1 safeDelete line(s) across 1 file(s) (no writes)")).toBe(true);
  expect(user.read("src/a.ts"), "dryRun must not write").toBe(before);
}

async function assertDeslopApply(user) {
  user.write("src/a.ts", SLOP_SOURCE);
  execWithDiff(user);
  const applied = textOf(await user.tool("pstack_deslop", { applySafe: true }));
  expect(applied.includes("applySafe: removed 1 line(s) in 1 file(s): src/a.ts")).toBe(true);
  expect(user.read("src/a.ts")).toBe("\nexport const a = 1;\n");
  expect(user.read("src/a.ts").includes(SLOP_MARKER)).toBe(false);
}

async function assertDeslopClean(user) {
  user.setExec(EMPTY_EXEC);
  expect(textOf(await user.tool("pstack_deslop", {}))).toBe(CLEAN_DESLOP);
  expect(await rejectionText(user.tool("pstack_deslop", { base: "origin..main" }))).toBe("invalid git diff base");
}

async function assertDeslopCommand(user) {
  await user.command("deslop", "");
  expect(user.message()).toBe("Run pstack_deslop on the current diff against main (consider applySafe:true for safe comment deletes), then apply /skill:unslop to any prose surfaces and fix remaining findings with edit.");
  expect(user.notifications().at(-1)).toEqual(["info", "Queued deslop twin"]);
}

const J11 = {
  id: "pre-commit-hygiene",
  title: "a user scans the diff for slop before committing",
  critical: true,
  surfaces: ["deslop", "commands"],
  async run(user) {
    await assertDeslopFindings(user);
    await assertDeslopApply(user);
    await assertDeslopClean(user);
    await assertDeslopCommand(user);
  },
};

function execStub(state) {
  return (command, args, opts) => {
    state.calls = [...state.calls, { command, args: [...args], opts }];
    return { code: 3, stdout: "line one\n", stderr: "line two\n", killed: false };
  };
}

async function assertControlCli(user) {
  const refused = await rejectionText(user.tool("pstack_control_cli", { argv: ["rm", "-rf", "/tmp/x"] }));
  expect(refused).toBe("command 'rm' not in control_cli allowlist (npm, pnpm, yarn, bun, node, python, python3, go, cargo, make, pytest, git, gh, pi, tsx, npx)");

  const noCommand = await rejectionText(user.tool("pstack_control_cli", { argv: ["-x"] }));
  expect(noCommand).toBe("argv[0] must be a command name/path");

  const cli = { calls: [] };
  user.setExec(execStub(cli));
  const result = textOf(
    await user.tool("pstack_control_cli", { argv: ["git", "probe"], cwd: "/tmp/probe" }),
  );
  expect(result).toBe("exit 3\n\nline one\n\nline two\n");
  expect(cli.calls.length).toBe(1);
  expect(cli.calls[0].command).toBe("git");
  expect(cli.calls[0].args).toEqual(["probe"]);
  expect(cli.calls[0].opts.cwd).toBe("/tmp/probe");
  expect(cli.calls[0].opts.timeout).toBe(120000);
}

function responseStub(state) {
  return async (url, opts) => {
    state.calls = [...state.calls, [url, opts.method]];
    return {
      status: 200,
      ok: true,
      text: async () => "control-ui body",
    };
  };
}

async function assertControlUi(user) {
  const fetchState = { calls: [] };
  user.setFetch(responseStub(fetchState));
  const ok = await user.tool("pstack_control_ui", { url: "http://127.0.0.1:8080/", allowHosts: ["127.0.0.1"] });
  expect(textOf(ok)).toBe("HTTP 200 ok=true\n\ncontrol-ui body");
  expect(ok.details).toEqual({ status: 200, ok: true });
  expect(fetchState.calls).toEqual([["http://127.0.0.1:8080/", "GET"]]);

  const mismatch = await user.tool("pstack_control_ui", { url: "http://127.0.0.1:8080/", expectStatus: 204, allowHosts: ["127.0.0.1"] });
  expect(textOf(mismatch).startsWith("HTTP 200 ok=false")).toBe(true);
  expect(mismatch.details).toEqual({ status: 200, ok: false });
}

async function assertControlUiFailure(user) {
  user.setFetch(async () => {
    throw new Error("boom");
  });
  await expect(() => user.tool("pstack_control_ui", { url: "http://127.0.0.1:9/", allowHosts: ["127.0.0.1"] })).rejects.toThrow(/pstack_control_ui failed: boom\. HTTP-only twin\./);
}

const J12 = {
  id: "prove-on-the-real-surface",
  title: "a user proves the change on the CLI and the real UI surface",
  critical: true,
  surfaces: ["control"],
  async run(user) {
    await assertControlCli(user);
    await assertControlUi(user);
    await assertControlUiFailure(user);
  },
};

function decisionRows(user) {
  const lines = user.read(".pi/decisions.tsv").split("\n").filter((line) => line.length > 0);
  return lines.slice(1).map((line) => line.split("\t"));
}

function decisionHeader(user) {
  return user.read(".pi/decisions.tsv").split("\n")[0];
}

async function assertDecisionEscaping(user) {
  const text = textOf(
    await user.tool("pstack_decision_log", {
      phase: "release",
      decision: "keep tabs\tand newlines\nflat",
      why: "=formula risk",
    }),
  );
  expect(text).toBe(`Logged decision to ${user.path(".pi/decisions.tsv")}`);
  const rows = decisionRows(user);
  expect(rows.length, "second call appends without duplicating the header").toBe(2);
  expect(decisionHeader(user)).toBe(DECISION_HEADER);
  const fields = rows.at(-1);
  expect(fields.length).toBe(6);
  expect(fields[2]).toBe("keep tabs and newlines flat");
  expect(fields[3]).toBe("'=formula risk");
}

async function assertDecisionRefusal(user) {
  const refused = await rejectionText(
    user.tool("pstack_decision_log", { phase: "p", decision: "d", why: "w", path: "../escape.tsv" }),
  );
  expect(refused).toBe(`pstack_decision_log path must stay under ${user.path(".pi")} (got ${user.path("../escape.tsv")}). Use .pi/decisions.tsv or .pi/audit/<slug>.tsv`);
}

async function assertDecisionAppend(user) {
  const text = textOf(
    await user.tool("pstack_decision_log", {
      phase: "acceptance",
      decision: "ship it",
      why: "one runnable check",
      evidence: "tests/user-journeys/journeys/tooling.mjs",
      result: "row appended",
    }),
  );
  expect(text).toBe(`Logged decision to ${user.path(".pi/decisions.tsv")}`);
  const rows = decisionRows(user);
  expect(rows.length).toBe(1);
  expect(decisionHeader(user)).toBe(DECISION_HEADER);
  const fields = rows[0];
  expect(fields.length).toBe(6);
  expect(fields.slice(1)).toEqual([
    "acceptance",
    "ship it",
    "one runnable check",
    "tests/user-journeys/journeys/tooling.mjs",
    "row appended",
  ]);
  const ts = fields[0];
  expect(new Date(ts).toISOString()).toBe(ts);
  expect(user.entry("pstack-decision").data).toEqual({
    path: user.path(".pi/decisions.tsv"),
    decision: "ship it",
    phase: "acceptance",
  });
}

const J13 = {
  id: "record-decisions",
  title: "a user records a decision trail that audits cleanly",
  critical: true,
  surfaces: ["decision"],
  async run(user) {
    await assertDecisionAppend(user);
    await assertDecisionEscaping(user);
    await assertDecisionRefusal(user);
  },
};

export const JOURNEYS = [J10, J11, J12, J13];
