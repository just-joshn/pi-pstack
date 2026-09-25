import { expect, test } from "bun:test";
import {
	default as pstackGuards,
	isBackgroundPoll,
} from "../../extensions/pstack-guards.ts";

function captureHandlers() {
	const handlers: Record<string, (event: any, ctx: any) => any> = {};
	pstackGuards({ on: (name: string, handler: (event: any, ctx: any) => any) => (handlers[name] = handler) } as any);
	return handlers;
}

const BLOCKED_POLLS = [
	`nohup bash -c 'while ! gh pr checks 28; do sleep 60; done' > /tmp/w.log 2>&1 &`,
	`(until curl -s localhost:4173; do sleep 1; done; echo up) &`,
	`nohup ~/.pi/agent/skills/poteto-mode/scripts/watch-pr/watch-pr --pr 28 &`,
	`gh pr checks 28 --watch & disown`,
	`(sleep 600; echo WAKE) &`,
	`setsid bash -c 'for i in $(seq 100); do gh pr view 9; sleep 60; done' &`,
	`for i in $(seq 60); do gh pr view 9 --json state; sleep 60; done &`,
	`tail -f /tmp/ci.log | grep -m1 DONE &`,
	`fswatch -1 /tmp/flag &`,
	`inotifywait -m /tmp/flag &`,
	`tmux new-session -d -s w 'while ! gh pr checks 9; do sleep 60; done'`,
	`screen -dmS w bash -c 'while true; do sleep 60; done'`,
	`gh run watch 123 &`,
	`gh pr checks 9 --watch &> /tmp/w.log &`,
	`nohup bash -c 'while true; do sleep 60; done'`,
	`setsid bash -c 'for i in 1 2 3; do sleep 60; done'`,
];

const ALLOWED_POLLS = [
	`python3 -m http.server 4173 > /tmp/s.log 2>&1 & sleep 1; curl -s localhost:4173`,
	`while ! test -f /tmp/x; do sleep 1; done`,
	`until gh pr checks 9; do sleep 30; done`,
	`nohup bun run dev > /tmp/dev.log 2>&1 & until curl -sf localhost:3000; do sleep 1; done`,
	`until curl -sf "http://localhost:3000/health?a=1&b=2"; do sleep 1; done`,
	`sleep 5 && echo done &`,
	`bun test 2>&1 | tail -3 && echo ok`,
	`tmux new-session -d -s w 'bun test --watch'; sleep 2; tmux capture-pane -p -t w`,
	`for i in 1 2 3; do echo $i; sleep 1; done &> /tmp/o`,
	`git commit -m "retry while CI flakes & sleep less"`,
	`echo "nohup while sleep loops &"`,
	`cat >> notes.md <<'EOF'\nnohup bash -c 'while true; do sleep 1; done' &\nEOF`,
	"cat > t.ts <<'X'\nconst a = `nohup x &`; const b = `while true; do sleep 1; done`;\nX",
];

test("blocks only backgrounded loops and watchers", () => {
	for (const command of BLOCKED_POLLS) expect(isBackgroundPoll(command)).toBe(true);
});

test("allows foreground polls, background servers, and non-loop jobs", () => {
	for (const command of ALLOWED_POLLS) expect(isBackgroundPoll(command)).toBe(false);
});

test("blocks background polling through bash with Shell guidance", async () => {
	const handlers = captureHandlers();
	const context = { mode: "print", hasUI: false, cwd: "/tmp", sessionManager: { getBranch: () => [] } };
	const result = await handlers.tool_call(
		{ toolName: "bash", input: { command: "while true; do sleep 60; done &" } },
		context,
	);
	expect(result.block).toBe(true);
	expect(result.reason).toContain("background Shell task");
	expect(result.reason).toContain("output_notification");
});

test("guards skill writes with explicit latest-message intent and preserves negation", async () => {
	const handlers = captureHandlers();
	const target = "/Users/josh-desktop/.pi/agent/skills/test-guard-probe/probe.txt";
	const targetInMessage = "~/.pi/agent/skills/test-guard-probe/probe.txt";
	const contextFor = (...messages: string[]) => ({
		mode: "print",
		hasUI: false,
		cwd: "/tmp",
		sessionManager: {
			getBranch: () => messages.map((content) => ({ type: "message", message: { role: "user", content } })),
		},
	});
	const write = (context: ReturnType<typeof contextFor>, toolName = "write") =>
		handlers.tool_call({ toolName, input: { path: target, content: "probe" } }, context);

	const blocked = await write(contextFor("Please write this file without changing any skills."));
	expect(blocked.block).toBe(true);
	expect(blocked.reason).toBe(
		"Installed skills change only when the user asks. If a skill looks broken, check that its own text references the missing thing; if it does not, the claim is false.",
	);

	const explicitPath = await write(contextFor(`Task: update ${targetInMessage}`));
	expect(explicitPath).toBeUndefined();

	const negatedPath = await write(contextFor(`Do not edit ${targetInMessage}`));
	expect(negatedPath.block).toBe(true);

	const negatedInvocation = await write(contextFor("Do not run /skill:create-skill; write the requested path only."));
	expect(negatedInvocation.block).toBe(true);

	for (const intent of [
		"Please edit my skill.",
		"Please update this skill.",
		"I updated my skill yesterday.",
		"/skill:create-skill",
		"/skill:reflect",
		"/skill:setup-pstack",
		"/skill:automate-me",
		"poteto-mode authoring",
	]) {
		expect(await write(contextFor(intent), "edit")).toBeUndefined();
	}

	const olderIntent = await write(contextFor("Fix my skill", "Just inspect the path, do not edit anything."));
	expect(olderIntent.block).toBe(true);

	const outside = await handlers.tool_call(
		{ toolName: "write", input: { path: "/Users/josh-desktop/.pi/agent/skills/../probe.txt", content: "probe" } },
		contextFor("No skill changes requested."),
	);
	expect(outside).toBeUndefined();
});
