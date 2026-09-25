#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { acceptedRewrite, COVERAGE_FLOOR, jaccard, mappedPairs, sentences, similarity, tokens, walk } from "./sync-check.mjs";
import { packagePaths } from "./package-paths.mjs";

const PI = packagePaths.packageRoot;
const UP = packagePaths.upstreamCurrentRoot;
const INVENTORY_PATH = packagePaths.additionsFile;
const DECISIONS_PATH = join(packagePaths.parityRoot, "decisions-package.tsv");
const MATCH_MIN = 0.5;
const DEFAULT_FLOOR = COVERAGE_FLOOR;
const showFiles = process.argv.includes("--files");
const showGaps = process.argv.includes("--gaps");
const floorArg = process.argv.find((arg) => arg.startsWith("--floor="));
const floor = floorArg ? Number(floorArg.split("=")[1]) : DEFAULT_FLOOR;

function parseInventory() {
	if (!existsSync(INVENTORY_PATH)) return { rows: [], issues: [`missing inventory: ${relative(PI, INVENTORY_PATH)}`] };
	const lines = readFileSync(INVENTORY_PATH, "utf8").replace(/\r/g, "").split("\n").filter((line) => line.length);
	const expected = ["file", "sentence-prefix", "reason", "decision-ref"];
	if (lines[0]?.split("\t").join("|") !== expected.join("|")) return { rows: [], issues: ["pi-additions.tsv header must be: file<TAB>sentence-prefix<TAB>reason<TAB>decision-ref"] };
	const rows = [];
	const issues = [];
	const decisions = existsSync(DECISIONS_PATH) ? readFileSync(DECISIONS_PATH, "utf8").replace(/\r/g, "").split("\n") : [];
	for (const [index, line] of lines.slice(1).entries()) {
		const columns = line.split("\t");
		if (columns.length !== 4 || columns.some((column) => !column.trim())) {
			issues.push(`invalid inventory row ${index + 2}: expected four non-empty TSV fields`);
			continue;
		}
		const [file, prefix, reason, decisionRef] = columns.map((column) => column.trim());
		if (file.startsWith("/") || file.split("/").includes("..")) issues.push(`invalid inventory path at row ${index + 2}: ${file}`);
		if (reason === "UNJUSTIFIED" && decisionRef !== "UNJUSTIFIED") issues.push(`UNJUSTIFIED ${file}: ${prefix}`);
		else if (reason === "UNJUSTIFIED") issues.push(`UNJUSTIFIED ${file}: ${prefix}`);
		else if (!/^(?:pi-runtime\.md:\d+(?:-\d+)?|decisions-package\.tsv:\d+|(?:decisions|fixes-round2|round3-decisions)\.tsv#[A-Za-z0-9_-]+)(?:;\s*(?:pi-runtime\.md:\d+(?:-\d+)?|decisions-package\.tsv:\d+|(?:decisions|fixes-round2|round3-decisions)\.tsv#[A-Za-z0-9_-]+))*$/.test(decisionRef)) {
			issues.push(`invalid decision-ref at row ${index + 2}: ${decisionRef}`);
		}
		for (const match of decisionRef.matchAll(/decisions-package\.tsv:(\d+)/g)) {
			const decisionLine = Number(match[1]);
			const fields = decisions[decisionLine - 1]?.split("\t");
			if (decisionLine < 2 || fields?.length !== 6 || !/^\d{4}-\d\d-\d\dT/.test(fields[0] ?? "")) {
				issues.push(`decision-ref at row ${index + 2} points to no decision row: decisions-package.tsv:${decisionLine}`);
			}
		}
		rows.push({ file, prefix, reason, decisionRef, line: index + 2 });
	}
	if (!rows.length) issues.push("inventory is empty: pi-additions.tsv has no data rows");
	return { rows, issues };
}

function findInventoryRow(rows, rel, sentence, used) {
	return rows.find((row) => row.file === rel && sentence.startsWith(row.prefix) && !used.has(row));
}

function pairSentences(pair) {
	const upstream = existsSync(pair.upstream) ? sentences(readFileSync(pair.upstream, "utf8")) : [];
	const port = existsSync(pair.port) ? sentences(readFileSync(pair.port, "utf8")) : [];
	return {
		upstream: upstream.filter((sentence) => tokens(sentence).size >= 3).map((sentence) => ({ sentence, words: tokens(sentence) })),
		port: port.filter((sentence) => tokens(sentence).size >= 3).map((sentence) => ({ sentence, words: tokens(sentence) })),
	};
}

function bestScore(source, targets, score = similarity) {
	return targets.reduce((best, target) => Math.max(best, score(source, target.words)), 0);
}

function main() {
	if (!Number.isFinite(floor) || floor < COVERAGE_FLOOR || floor > 100) {
		console.error(`invalid coverage floor ${floorArg?.split("=")[1] ?? floor}: minimum is ${COVERAGE_FLOOR}% and maximum is 100%`);
		process.exitCode = 2;
		return;
	}
	for (const [root, label] of [
		[packagePaths.skillsRoot, "skills"],
		[packagePaths.agentsRoot, "agents"],
		[join(UP, "pstack/skills"), "upstream pstack skills"],
		[join(UP, "pstack/agents"), "upstream pstack agents"],
		[join(UP, "cursor-team-kit/skills"), "upstream cursor-team-kit skills"],
	]) {
		if (!walk(root).some((file) => file.endsWith(".md"))) throw new Error(`empty required input: ${label}`);
	}
	const inventory = parseInventory();
	const inventoryUse = new Set();
	const issues = [...inventory.issues];
	const rows = [];
	const pairData = mappedPairs(PI, UP).filter((pair) => pair.port.endsWith(".md"));
	let total = 0;
	let covered = 0;
	let additions = 0;
	let inventoried = 0;
	let unmatched = 0;

	for (const pair of pairData) {
		if (!existsSync(pair.port)) issues.push(`missing port file: ${pair.rel}`);
		const { upstream, port } = pairSentences(pair);
		let fileCovered = 0;
		let fileMapped = 0;
		let fileGaps = 0;
		const portInventory = new Map();
		for (const candidate of port) {
			if (bestScore(candidate.words, upstream) >= MATCH_MIN) continue;
			additions++;
			const row = findInventoryRow(inventory.rows, pair.rel, candidate.sentence, inventoryUse);
			if (row) {
				inventoryUse.add(row);
				inventoried++;
				portInventory.set(candidate, row);
				if (row.reason !== "UNJUSTIFIED") {
					const loose = bestScore(candidate.words, upstream, jaccard);
					if (loose >= MATCH_MIN) fileMapped++;
				}
			} else {
				issues.push(`MISSING PI ADDITION ${pair.rel}: ${candidate.sentence.slice(0, 120)}`);
			}
		}

		for (const source of upstream) {
			total++;
			const score = bestScore(source.words, port);
			if (score >= MATCH_MIN) {
				covered++;
				fileCovered++;
				continue;
			}
			if (acceptedRewrite(pair.rel, source.sentence)) {
				covered++;
				fileCovered++;
				fileMapped++;
				continue;
			}
			const listedRewrite = port.some((candidate) => {
				const row = portInventory.get(candidate);
				return row && row.reason !== "UNJUSTIFIED" && jaccard(source.words, candidate.words) >= MATCH_MIN;
			});
			if (listedRewrite) {
				covered++;
				fileCovered++;
				fileMapped++;
				continue;
			}
			fileGaps++;
			unmatched++;
			if (showGaps) rows.push(`MISSING ${pair.rel} (${score.toFixed(2)}): ${source.sentence}`);
		}
		if (showFiles) rows.push(`${pair.rel}\t${fileCovered}/${upstream.length}\t${fileGaps} missing\t${fileMapped} mapped`);
	}

	for (const row of inventory.rows) {
		if (!inventoryUse.has(row)) issues.push(`STALE PI ADDITION row ${row.line}: ${row.file}: ${row.prefix}`);
	}
	if (covered / Math.max(1, total) * 100 + 1e-9 < floor) issues.push(`coverage ${((covered / Math.max(1, total)) * 100).toFixed(2)}% is below floor ${floor.toFixed(2)}%`);
	if (showGaps) {
		for (const row of inventory.rows) rows.push(`${row.reason === "UNJUSTIFIED" ? "UNJUSTIFIED" : "PI ADDITION"} ${row.file}: ${row.prefix}`);
	}
	console.log(rows.join("\n"));
	console.log(`\nfull-audit: ${covered}/${total} upstream sentences carried (${((covered / Math.max(1, total)) * 100).toFixed(2)}%; floor ${floor.toFixed(2)}%)`);
	console.log(`reverse audit: ${additions} Pi-only sentences, ${inventoried} inventoried, ${issues.filter((issue) => issue.startsWith("UNJUSTIFIED ")).length} unjustified, ${unmatched} upstream gaps`);
	if (issues.length) {
		console.log(issues.join("\n"));
		process.exitCode = 1;
	}
}

main();
