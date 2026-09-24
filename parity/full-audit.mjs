#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import { acceptedRewrite, COVERAGE_FLOOR, jaccard, mappedPairs, sentences, similarity, tokens } from "./sync-check.mjs";

const PI = join(homedir(), ".pi/agent");
const UP = join(PI, "pstack/parity/upstream/current");
const INVENTORY_PATH = join(PI, "pstack/parity/pi-additions.tsv");
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
		else if (!/^(?:pi-runtime\.md:\d+(?:-\d+)?|(?:decisions|fixes-round2|round3-decisions)\.tsv#[A-Za-z0-9_-]+)(?:;\s*(?:pi-runtime\.md:\d+(?:-\d+)?|(?:decisions|fixes-round2|round3-decisions)\.tsv#[A-Za-z0-9_-]+))*$/.test(decisionRef)) {
			issues.push(`invalid decision-ref at row ${index + 2}: ${decisionRef}`);
		}
		rows.push({ file, prefix, reason, decisionRef, line: index + 2 });
	}
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
	if (!Number.isFinite(floor) || floor < 0 || floor > 100) {
		console.error(`invalid coverage floor: ${floorArg}`);
		process.exitCode = 2;
		return;
	}
	const inventory = parseInventory();
	const inventoryUse = new Set();
	const issues = [...inventory.issues];
	const rows = [];
	const pairData = mappedPairs(PI, UP).filter((pair) => pair.port.endsWith(".md") && existsSync(pair.port));
	let total = 0;
	let covered = 0;
	let additions = 0;
	let inventoried = 0;
	let unmatched = 0;

	for (const pair of pairData) {
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
