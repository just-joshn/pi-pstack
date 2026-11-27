import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtures = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.includes("tla2sany.xml.XMLExporter")) {
	process.stdout.write(fs.readFileSync(path.join(fixtures, "sany.out")));
} else if (args.includes("ChartRun")) {
	const run = fs.readFileSync("ChartRun.tla", "utf8");
	const tag = run.match(/chart-[0-9a-f]+/)?.[0];
	if (!tag) throw new Error("ChartRun tag missing");
	fs.copyFileSync(path.join(fixtures, "graph.dot"), "graph.dot");
	process.stdout.write(
		fs.readFileSync(path.join(fixtures, "chart.out"), "utf8").replaceAll(/chart-[0-9a-f]{32}/g, tag),
	);
} else if (args.includes("tlc2.TLC")) {
	process.stdout.write(fs.readFileSync(path.join(fixtures, "verdict-1.out")));
	process.exitCode = 12;
} else {
	throw new Error(`Unexpected command: ${args.join(" ")}`);
}
