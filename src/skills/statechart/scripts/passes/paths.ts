import {
	type Bug,
	type Graph,
	hasRule,
	type Lasso,
	must,
	type PathStep,
	type Rule,
	type Step,
	stateKey,
	type Trace,
	type TraceState,
	type Vars,
	valuesOf,
} from "../ir.ts";

export function pathGraph(names: string[]) {
	const graph: Graph = { states: new Map(), steps: [] };
	const ids = new Map<string, string>();
	const taken = new Map<string, Step>();
	const idOf = (vars: Vars | undefined, start: boolean) => {
		if (!vars) throw new Error("TLC's trace has a state with no values.");
		const k = stateKey(valuesOf(vars, names));
		let id = ids.get(k);
		if (id === undefined) {
			id = String(ids.size);
			ids.set(k, id);
			graph.states.set(id, { vars, start, breaks: [] });
		} else if (start) must(graph.states, id).start = true;
		return id;
	};
	const route = (first: Vars | undefined, rest: Trace["seq"]) => {
		const start = idOf(first, true);
		const path: PathStep[] = [];
		let from = start;
		for (const { action, vars } of rest) {
			const to = idOf(vars, false);
			const k = `${from} ${to} ${action}`;
			let step = taken.get(k);
			if (!step) {
				step = { from, to, action };
				taken.set(k, step);
				graph.steps.push(step);
			}
			path.push({ action, state: to, step });
			from = to;
		}
		return { start, path };
	};
	return {
		graph,
		bug: (rule: Rule, trace: TraceState[]): Bug => {
			const [first, ...rest] = trace;
			if (!first) throw new Error(`TLC's trace for ${rule.name} has no states.`);
			const bug = { rule, ...route(first.vars, rest) };
			const end = must(graph.states, bug.path.at(-1)?.state ?? bug.start);
			if (!hasRule(end.breaks, rule)) end.breaks.push(rule);
			return bug;
		},
		lasso: ({ seq, loop }: Trace): Lasso | undefined => {
			const [first, ...rest] = seq;
			return first && { ...route(first.vars, rest), loop, stutters: loop === seq.length - 1 };
		},
	};
}
