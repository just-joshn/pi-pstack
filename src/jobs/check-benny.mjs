/// <reference types="node" />
import { stat } from "node:fs/promises";

import { checkJob, projectSkills } from "./job-check.ts";

const [target] = process.argv.slice(2);
if (!target) throw Error("Usage: node src/jobs/check-benny.mjs <target repository> | <Benny job.json>");
const report = (await stat(target)).isFile()
	? await checkJob(target)
	: await projectSkills(target).then(({ unresolved }) => ({ ok: !unresolved.length, unresolved }));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.ok ? 0 : 1;
