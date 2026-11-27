import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { lookup, view } from "../src/lib/catalog.ts";

const WARMUP = 200;
const SAMPLES = 25;
const ITERATIONS = 200;
const workloads = [
	{
		name: "Catalog search",
		run: () => lookup("refactoring").some((node) => node.id === "pb-refactoring"),
	},
	{
		name: "Full dependency view",
		run: () => view("all-dependencies").nodes.length >= 100,
	},
];

for (const { name, run } of workloads) {
	for (let i = 0; i < WARMUP; i++) assert(run(), name);
	const samples = Array.from({ length: SAMPLES }, () => {
		let successes = 0;
		const start = performance.now();
		for (let i = 0; i < ITERATIONS; i++) successes += Number(run());
		const elapsed = performance.now() - start;
		assert.equal(successes, ITERATIONS, name);
		return elapsed / ITERATIONS;
	}).sort((a, b) => a - b);
	const median = samples.at(Math.ceil(SAMPLES * 0.5) - 1);
	const p95 = samples.at(Math.ceil(SAMPLES * 0.95) - 1);
	assert(median !== undefined && p95 !== undefined);
	process.stdout.write(
		`${name}: median ${median.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms (${SAMPLES} × ${ITERATIONS})\n`,
	);
}
