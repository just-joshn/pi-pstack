import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { fileContext, packageFile, srcDir } from "./lib/catalog.ts";
import {
	activePlan,
	closedTasks,
	initialState,
	restore,
	type State,
	stateType,
	stopped,
	type Wake,
} from "./lib/state.ts";

function statusLine({ mode, plan, wake }: State) {
	if (!mode && !plan && !wake?.running) return undefined;
	const progress = plan ? ` | ${plan.route} ${closedTasks(plan)}/${plan.tasks.length}` : "";
	return `pstack ${mode ? "on" : "off"}${progress}${wake?.running ? " | loop" : ""}`;
}

const routerPath = "skills/poteto-mode/SKILL.md";

async function systemPromptAdditions(state: State, modeContext: () => Promise<string[]>) {
	const plan = activePlan(state);
	return [
		...(state.mode ? await modeContext() : []),
		...(state.goal ? [`Persistent operator goal: ${state.goal}`] : []),
		...(plan ? [`Branch-local task state (call pstack_plan to update): ${JSON.stringify(plan)}`] : []),
	];
}

function wakeMessage(count: number, wake: Wake) {
	return {
		customType: "pstack-wake",
		content: `Wake ${count}/${wake.max}. Check the actual predicate: ${wake.predicate}. Inspect new evidence, take one authorized step if needed, record it, and call pstack_wake action stop when verified or blocked. Do not assume completion.`,
		display: true,
	};
}

function frozenCopy(state: State): State {
	const copy = structuredClone(state);
	const freeze = (value: unknown) => {
		if (typeof value !== "object" || value === null) return;
		Object.values(value).forEach(freeze);
		Object.freeze(value);
	};
	freeze(copy);
	return copy;
}

function createStore(pi: ExtensionAPI) {
	let state = frozenCopy(initialState());
	function refresh(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("pstack", statusLine(state));
	}
	return {
		state: () => state,
		commit(ctx: ExtensionContext, change: Partial<State>) {
			state = frozenCopy({ ...state, ...change });
			pi.appendEntry(stateType, structuredClone(state));
			refresh(ctx);
		},
		restore(ctx: ExtensionContext) {
			state = frozenCopy(restore(ctx.sessionManager.getBranch()));
			refresh(ctx);
		},
		halt() {
			state = frozenCopy({ ...state, wake: stopped(state.wake) });
		},
	};
}

interface SessionEvents {
	state: () => State;
	restoreBranch: (ctx: ExtensionContext) => void;
	shutdown: () => void;
	stopWake: (ctx: ExtensionContext) => void;
	schedule: (ctx: ExtensionContext) => void;
	modeContext: () => Promise<string[]>;
}
function listen(pi: ExtensionAPI, session: SessionEvents) {
	pi.on("session_start", (_event, ctx) => session.restoreBranch(ctx));
	pi.on("session_tree", (_event, ctx) => session.restoreBranch(ctx));
	pi.on("session_shutdown", () => session.shutdown());
	pi.on("agent_settled", (event, ctx) => {
		const wake = session.state().wake;
		if (wake?.running && (event.aborted || wake.count >= wake.max)) session.stopWake(ctx);
		else session.schedule(ctx);
	});
	pi.on("before_agent_start", async (event) => {
		const additions = await systemPromptAdditions(session.state(), session.modeContext);
		if (!additions.length) return undefined;
		return { systemPrompt: [event.systemPrompt, ...additions].join("\n\n") };
	});
}

function createModeContext() {
	let context: Promise<string[]> | undefined;
	return () => {
		context ??= Promise.all([
			packageFile("reference/rules/no-inline-imports.md"),
			packageFile("reference/rules/typescript-exhaustive-switch.md"),
			packageFile(routerPath),
		])
			.then(([imports, switches, router]) => [
				["Team Kit rules:", imports, switches].join("\n\n"),
				`Persistent poteto-mode. ${fileContext(join(srcDir, routerPath))}\n\n${router}`,
			])
			.catch((error: unknown) => {
				context = undefined;
				throw error;
			});
		return context;
	};
}

export function createSession(pi: ExtensionAPI) {
	const store = createStore(pi);
	const modeContext = createModeContext();
	let timer: ReturnType<typeof setTimeout> | undefined;

	function clearTimer() {
		if (timer) clearTimeout(timer);
		timer = undefined;
	}
	function commit(ctx: ExtensionContext, change: Partial<State>) {
		store.commit(ctx, change);
		if (!store.state().wake?.running) clearTimer();
	}
	const stopWake = (ctx: ExtensionContext, evidence?: string) =>
		commit(ctx, { wake: stopped(store.state().wake, evidence) });

	function wakeUp(ctx: ExtensionContext) {
		timer = undefined;
		const wake = store.state().wake;
		if (!wake?.running) return;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return schedule(ctx);
		if (wake.count >= wake.max) return stopWake(ctx);
		const count = wake.count + 1;
		commit(ctx, { wake: { ...wake, count } });
		pi.sendMessage(wakeMessage(count, wake), { triggerTurn: true, deliverAs: "followUp" });
	}
	function schedule(ctx: ExtensionContext) {
		const wake = store.state().wake;
		if (timer || !wake?.running || ctx.mode !== "tui") return;
		timer = setTimeout(() => wakeUp(ctx), wake.seconds * 1000);
	}
	function startWake(ctx: ExtensionContext, wake: Wake) {
		clearTimer();
		commit(ctx, { wake });
		schedule(ctx);
	}
	function restoreBranch(ctx: ExtensionContext) {
		clearTimer();
		store.restore(ctx);
	}
	function shutdown() {
		clearTimer();
		store.halt();
	}
	listen(pi, { state: store.state, restoreBranch, shutdown, stopWake, schedule, modeContext });

	return { state: store.state, commit, stopWake, startWake };
}
export type Session = ReturnType<typeof createSession>;
