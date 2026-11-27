import { type Arrow, append, holds, type Labels, nth, type Region, tupleKey, unkey, type Walk } from "../ir.ts";

type Move = { from: string[]; text: string; to: string[] };
type Enabled = { i: number; a: Arrow };

export function regionsLie(
	regions: Region[],
	{ names, keys, sorted, drawnLabels, together }: Labels,
	{ from, to, starts, states }: Walk,
	order: Int32Array,
) {
	if (names.length < 2) return undefined;
	const combinations = states.map((_, i) => {
		const parts = keys.map((k) => nth(k, i));
		return { parts, key: tupleKey(parts) };
	});
	const words = (c: string[]) => {
		const parts: string[] = [];
		for (const [i, name] of names.entries()) parts.push(`${name} ${unkey(nth(c, i)).join(" / ")}`);
		return parts.join(", ");
	};
	const addMove = (moves: Map<string, Move>, m: Move) => moves.set(tupleKey([m.from, m.text, m.to]), m);
	let product: string[][] = [[]];
	for (const r of regions) {
		const next: string[][] = [];
		for (const c of product) for (const s of r.states) if (s.start) next.push([...c, tupleKey(s.path)]);
		product = next;
	}
	const realStarts = new Set<string>();
	for (const i of starts) realStarts.add(nth(combinations, i).key);
	for (const c of product)
		if (!realStarts.has(tupleKey(c))) return `The regions chart starts at ${words(c)}, where the model never starts.`;
	for (const [i, r] of regions.entries())
		for (const a of r.arrows)
			if (a.condition.kind === "tuples")
				return `In ${names[i]}, ${a.label} from ${unkey(a.from).join(" / ")} depends on the other regions in a way that one "and" or "or" condition cannot say.`;
	const real = new Map<string, Move>();
	for (const j of sorted) {
		const before = nth(combinations, nth(from, j));
		const after = nth(combinations, nth(to, j));
		if (before.key !== after.key) addMove(real, { from: before.parts, text: nth(drawnLabels, j), to: after.parts });
	}
	const combos = new Map<string, string[]>();
	for (const i of order) {
		const { parts, key } = nth(combinations, i);
		combos.set(key, parts);
	}
	const drawn = new Map<string, Move>();
	for (const c of combos.values()) {
		const enabled = new Map<string, Enabled[]>();
		for (const [i, r] of regions.entries()) {
			const rest: string[] = [];
			for (const [k, key] of c.entries()) if (k !== i) rest.push(key);
			for (const a of r.arrows) if (a.from === c[i] && holds(a.condition, rest)) append(enabled, a.label, { i, a });
		}
		for (const [text, list] of enabled) {
			let groups: Enabled[][] = [];
			if (together.has(text)) {
				const byRegion = new Map<number, Enabled[]>();
				for (const m of list) append(byRegion, m.i, m);
				groups = [[]];
				for (const opts of byRegion.values()) {
					const next: Enabled[][] = [];
					for (const g of groups) for (const m of opts) next.push([...g, m]);
					groups = next;
				}
			} else for (const m of list) groups.push([m]);
			for (const group of groups) {
				const to = [...c];
				for (const { i, a } of group) to[i] = a.to;
				addMove(drawn, { from: c, text, to });
			}
		}
	}
	for (const [k, extra] of drawn)
		if (!real.has(k))
			return `The regions chart lets ${words(extra.from)} go to ${words(extra.to)} by ${extra.text}, which the model never does.`;
	for (const [k, missing] of real)
		if (!drawn.has(k))
			return `The model goes from ${words(missing.from)} to ${words(missing.to)} by ${missing.text}, which the regions chart cannot show.`;
	return undefined;
}
