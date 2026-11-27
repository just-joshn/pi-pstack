import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtures = path.dirname(fileURLToPath(import.meta.url));
const scenario = path.resolve(process.env.STATECHART_FIXTURE ?? fixtures);
const args = process.argv.slice(2);

const kind = args.includes("tla2sany.xml.XMLExporter")
	? "sany"
	: args.includes("tla2sany.SANY")
		? "sany-errors"
		: args.includes("ChartRun")
			? "chart"
			: args.includes("tlc2.TLC")
				? "tlc"
				: undefined;
if (!kind) throw new Error(`Unexpected command: ${args.join(" ")}`);

// check() creates a fresh working directory per run, so the call counters there
// let a scenario replay a different transcript for each TLC invocation.
const counter = path.join(process.cwd(), `.fake-java-${kind}`);
const calls = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
fs.writeFileSync(counter, String(calls + 1));

const plan = JSON.parse(fs.readFileSync(path.join(scenario, "plan.json"), "utf8"));
const steps = plan[kind];
const step = steps?.[Math.min(calls, steps.length - 1)];
if (!step) throw new Error(`The fixture plan for ${scenario} has no ${kind} step ${calls + 1}`);

if (kind === "chart") {
	const run = fs.readFileSync("ChartRun.tla", "utf8");
	const tag = run.match(/chart-[0-9a-f]+/)?.[0];
	if (!tag) throw new Error("ChartRun tag missing");
	if (step.dot) fs.copyFileSync(path.join(scenario, step.dot), "graph.dot");
	process.stdout.write(fs.readFileSync(path.join(scenario, step.out), "utf8").replaceAll(/chart-[0-9a-f]{32}/g, tag));
} else {
	if (step.out) process.stdout.write(fs.readFileSync(path.join(scenario, step.out)));
}
process.exitCode = step.exit ?? 0;
