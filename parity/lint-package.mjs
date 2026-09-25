#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packagePathsAt } from "./package-paths.mjs";

const AGENT_DIRECTORY_PHRASE = "Pi's agent directory (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`)";
const HOME_AGENT_PATH = /(?:~\/\.pi\/agent|\$HOME\/\.pi\/agent|\/(?:Users|home)\/[^/\s`'\"]+\/\.pi\/agent)/;
const HOMEDIR_AGENT_JOIN = /\bhomedir\s*\(\s*\)[^;\n]{0,120}(?:\.pi\s*[\\/]\s*agent\b|\.pi["'`]\s*,\s*["'`]agent\b)/i;

function filesUnder(root) {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(root, entry.name);
		if (entry.name === ".DS_Store" || entry.name === "node_modules") return [];
		return entry.isDirectory() ? filesUnder(path) : [path];
	});
}

function addLineFindings(findings, root, file, text, predicate, message) {
	text.split("\n").forEach((line, index) => {
		if (predicate(line)) findings.push(`${relative(root, file)}:${index + 1}: ${message}`);
	});
}

export function lintPackage(absoluteRoot) {
	const paths = packagePathsAt(absoluteRoot);
	const findings = [];
	const roots = [
		[paths.skillsRoot, "skills"],
		[paths.agentsRoot, "agents"],
		[paths.extensionsRoot, "extensions"],
	];

	for (const [root, label] of roots) {
		if (!existsSync(root)) {
			findings.push(`${label}: missing required directory`);
			continue;
		}
		const files = filesUnder(root);
		if (!files.length) findings.push(`${label}: empty required directory`);
		for (const file of files) {
			const text = readFileSync(file, "utf8");
			addLineFindings(findings, paths.packageRoot, file, text, (line) => line.includes("<pstack>"), "unresolved <pstack> token");

			if (label === "skills") {
				const phraseCount = text.split(AGENT_DIRECTORY_PHRASE).length - 1;
				if ((text.includes("$PI_CODING_AGENT_DIR") || text.includes("~/.pi/agent")) && phraseCount !== 1) {
					findings.push(`${relative(paths.packageRoot, file)}: expected the Pi agent-directory default phrase once, found ${phraseCount}`);
				}
				const prose = text.replaceAll(AGENT_DIRECTORY_PHRASE, "");
				addLineFindings(findings, paths.packageRoot, file, prose, (line) => line.includes("~/.pi/agent"), "agent-directory path appears outside the documented default phrase");
			}

			if (label !== "skills") {
				addLineFindings(findings, paths.packageRoot, file, text, (line) => HOME_AGENT_PATH.test(line), "hard-coded Pi agent-directory path");
			}
			if (label === "extensions") {
				addLineFindings(findings, paths.packageRoot, file, text, (line) => HOMEDIR_AGENT_JOIN.test(line), "homedir() joined with .pi/agent");
			}
		}
	}

	return findings.sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	const findings = lintPackage(packagePathsAt(fileURLToPath(new URL("..", import.meta.url))).packageRoot);
	if (findings.length) {
		console.error(findings.join("\n"));
		console.error(`\npackage lint: ${findings.length} finding(s)`);
		process.exitCode = 1;
	} else {
		console.log("package lint: 0 findings");
	}
}
