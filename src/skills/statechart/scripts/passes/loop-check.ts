import {
	type Arrow,
	append,
	type Bug,
	type Chart,
	holds,
	type Labels,
	loopOf,
	must,
	nth,
	tupleKey,
	unkey,
	type Walk,
} from "../ir.ts";

export function loopCheck(
	{ regions, loops }: Chart,
	{ names, keys, drawnLabels, sorted }: Labels,
	{ index, from, to }: Walk,
	found: Bug[],
) {
	const combo = (i: number) => tupleKey(keys.map((k) => nth(k, i)));
	const stepsFrom = new Map<number, number[]>();
	const arrowsFrom: Map<string, Arrow[]>[] = [];
	if (loops.length) {
		for (const j of sorted) append(stepsFrom, from[j], j);
		for (const { arrows } of regions) {
			const out = new Map<string, Arrow[]>();
			for (const a of arrows) append(out, a.from, a);
			arrowsFrom.push(out);
		}
	}
	for (const b of found) {
		if (b.loop === undefined) continue;
		const inLoop = new Set<string>();
		const twinsOf = new Map<string, number[]>();
		for (const i of loopOf(b, index)) {
			inLoop.add(combo(i));
			append(twinsOf, combo(i), i);
		}
		for (const i of loopOf(b, index)) {
			const twins = must(twinsOf, combo(i));
			for (const [r, name] of names.entries()) {
				const own = nth(keys, r);
				const takes = (a: Arrow) => {
					for (const s of twins)
						for (const j of stepsFrom.get(s) ?? [])
							if (drawnLabels[j] === a.label && own[nth(to, j)] === a.to) return true;
					return false;
				};
				const rest: string[] = [];
				for (const [o, k] of keys.entries()) if (o !== r) rest.push(nth(k, i));
				for (const a of nth(arrowsFrom, r).get(nth(own, i)) ?? []) {
					if (!holds(a.condition, rest)) continue;
					const next: string[] = [];
					for (const [o, k] of keys.entries()) next.push(o === r ? a.to : nth(k, i));
					if (!inLoop.has(tupleKey(next)) && !takes(a))
						throw new Error(
							`The chart draws the step ${a.label} out of ${name ? `${name} ` : ""}${unkey(a.from).join(" / ")}, but the ${b.rule.name} loop cannot take it there. Show in a label what stops it.`,
						);
				}
			}
		}
	}
}
